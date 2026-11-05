/**
 * `RemoteRunCallStore` in memory (WP-282) — the tables `run_messages`, `run_tool_calls`,
 * `run_tool_approvals`, `run_session_lines` and `run_offers.ssh_signatures` as maps.
 *
 * **Divergence register** (standing rule 5: stricter, never kinder):
 *
 * | what | PostgreSQL | here | direction |
 * |---|---|---|---|
 * | the signature count's fence | one `update run_offers … where state = 'claimed' and lease_epoch = $2 and worker_id = $3 and ssh_signatures < $4` | the run row's settlement (live, this epoch, this owner) through {@link MemoryRemoteRunCallStoreOptions.fenceHolds}, then the count | **same** predicate; the single-statement atomicity is PostgreSQL's and is asserted in `test/integration/pipeline/remote-run-calls.integration.test.ts` |
 * | a tool call's take-over | `claimed_at < $takeOverBefore` on the row | the same comparison on the stored instant | same |
 * | the transcript's `(run_id, seq)` | an advisory lock per run, then `insert … where not exists` | a set | same; no concurrency here |
 */
import type { Id, IsoDateTime, JsonValue, TranscriptEvent } from '@platform/contracts';
import type {
  DecidedApproval,
  RemoteRunCallStore,
  StoredToolCall,
} from '../pipeline/remote-run-calls.js';
import type { Transaction } from '../ports/transaction.js';

export interface MemoryRemoteRunCallStoreOptions {
  /** Whether `(runId, epoch, workerId)` holds a live run — the signature count's fence. */
  readonly fenceHolds: (
    tx: Transaction,
    input: { readonly runId: Id; readonly epoch: number; readonly workerId: Id },
  ) => Promise<boolean>;
}

interface ApprovalRow {
  readonly id: Id;
  readonly runId: Id;
  readonly toolUseDigest: string;
  decision: 'allow' | 'deny' | null;
  reason: string | null;
  questionId: Id | null;
  deliveredAt: IsoDateTime | null;
}

export interface MemoryRemoteRunCallStore extends RemoteRunCallStore {
  transcriptRows(runId: Id): readonly TranscriptEvent[];
  toolCallRows(runId: Id): readonly (StoredToolCall & { readonly toolUseDigest: string })[];
  sessionRows(
    runId: Id,
  ): readonly { readonly sessionId: string; readonly line: number; readonly text: string }[];
  signatures(runId: Id): number;
}

type ToolCallRow = { -readonly [K in keyof StoredToolCall]: StoredToolCall[K] } & {
  readonly toolUseDigest: string;
  readonly runId: Id;
};

export const createMemoryRemoteRunCallStore = (
  options: MemoryRemoteRunCallStoreOptions,
): MemoryRemoteRunCallStore => {
  const transcripts = new Map<Id, Map<number, TranscriptEvent>>();
  const toolCalls = new Map<string, ToolCallRow>();
  const approvals = new Map<Id, ApprovalRow>();
  const sessions = new Map<string, { runId: Id; sessionId: string; line: number; text: string }>();
  const signatures = new Map<Id, number>();
  const key = (runId: Id, digest: string): string => `${runId}\0${digest}`;

  return {
    // One thread: there is nothing to serialise (PostgreSQL takes an advisory lock).
    lockTranscript: async () => {},
    transcriptCount: async (_tx, runId) => transcripts.get(runId)?.size ?? 0,
    appendTranscript: async (_tx, runId, entries) => {
      const rows = transcripts.get(runId) ?? new Map<number, TranscriptEvent>();
      transcripts.set(runId, rows);
      let stored = 0;
      for (const entry of entries) {
        if (rows.has(entry.seq)) continue;
        rows.set(entry.seq, structuredClone(entry));
        stored += 1;
      }
      return stored;
    },
    findToolCall: async (_tx, runId, toolUseDigest) => {
      const row = toolCalls.get(key(runId, toolUseDigest));
      return row === undefined ? null : structuredClone(row);
    },
    claimToolCall: async (_tx, input) => {
      const existing = toolCalls.get(key(input.runId, input.toolUseDigest));
      if (existing !== undefined) {
        if (
          existing.answer !== null ||
          input.takeOverBefore === null ||
          !(Date.parse(existing.claimedAt) < Date.parse(input.takeOverBefore))
        ) {
          return false;
        }
      }
      toolCalls.set(key(input.runId, input.toolUseDigest), {
        runId: input.runId,
        toolUseDigest: input.toolUseDigest,
        toolName: input.toolName,
        inputDigest: input.inputDigest,
        claimedAt: input.at,
        answer: null,
      });
      return true;
    },
    completeToolCall: async (_tx, input) => {
      const row = toolCalls.get(key(input.runId, input.toolUseDigest));
      if (row === undefined || row.answer !== null) return;
      row.answer = { result: structuredClone(input.result) as JsonValue, isError: input.isError };
    },
    releaseToolCall: async (_tx, input) => {
      const row = toolCalls.get(key(input.runId, input.toolUseDigest));
      if (row !== undefined && row.answer === null) {
        toolCalls.delete(key(input.runId, input.toolUseDigest));
      }
    },
    openApproval: async (_tx, input) => {
      for (const row of approvals.values()) {
        if (row.runId === input.runId && row.toolUseDigest === input.toolUseDigest) {
          return { id: row.id, created: false };
        }
      }
      approvals.set(input.id, {
        id: input.id,
        runId: input.runId,
        toolUseDigest: input.toolUseDigest,
        decision: null,
        reason: null,
        questionId: null,
        deliveredAt: null,
      });
      return { id: input.id, created: true };
    },
    decideApproval: async (_tx, input) => {
      const row = approvals.get(input.id);
      if (row === undefined || row.decision !== null) return;
      row.decision = input.decision;
      row.reason = input.reason;
      row.questionId = input.questionId;
    },
    takeDecidedApprovals: async (_tx, input) => {
      const taken: DecidedApproval[] = [];
      for (const row of approvals.values()) {
        if (taken.length >= input.limit) break;
        if (row.runId !== input.runId || row.decision === null || row.deliveredAt !== null) {
          continue;
        }
        row.deliveredAt = input.at;
        taken.push({
          approvalId: row.id,
          decision: row.decision,
          reason: row.reason ?? '',
          questionId: row.questionId,
        });
      }
      return taken;
    },
    // One thread: there is nothing to serialise (PostgreSQL takes an advisory lock).
    lockSessionMirror: async () => {},
    sessionLineCount: async (_tx, runId) =>
      [...sessions.values()].filter((row) => row.runId === runId).length,
    appendSessionLines: async (_tx, input) => {
      let stored = 0;
      input.lines.forEach((line, index) => {
        const position = input.fromLine + index;
        const id = `${input.runId}\0${input.sessionId}\0${position}`;
        if (sessions.has(id)) return;
        sessions.set(id, {
          runId: input.runId,
          sessionId: input.sessionId,
          line: position,
          text: line.text,
        });
        stored += 1;
      });
      return stored;
    },
    countSignature: async (tx, input) => {
      if (!(await options.fenceHolds(tx, input))) {
        return { kind: 'lost' };
      }
      const count = signatures.get(input.runId) ?? 0;
      if (count >= input.max) {
        return { kind: 'cap' };
      }
      signatures.set(input.runId, count + 1);
      return { kind: 'counted', signatures: count + 1 };
    },
    transcriptRows: (runId) =>
      [...(transcripts.get(runId)?.values() ?? [])].sort((a, b) => a.seq - b.seq),
    toolCallRows: (runId) =>
      [...toolCalls.values()]
        .filter((row) => row.runId === runId)
        .map((row) => structuredClone(row)),
    sessionRows: (runId) =>
      [...sessions.values()]
        .filter((row) => row.runId === runId)
        .map(({ sessionId, line, text }) => ({ sessionId, line, text }))
        .sort((a, b) => a.line - b.line),
    signatures: (runId) => signatures.get(runId) ?? 0,
  };
};

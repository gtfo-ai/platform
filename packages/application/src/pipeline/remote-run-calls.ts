/**
 * **What a remote run needs from the core while it runs** — WP-282, TD-031 decisions 5, 10a and 10b,
 * §9's run-scoped verbs besides the claim, and the 2026-11-04 amendment's relayed signing (backlog
 * 693). Every command is authenticated by the run token at the route and fenced here on the claim's
 * `(run_id, epoch)` and the owner `worker:<id>` derived from the authenticated worker — never from a
 * body:
 *
 * | command | the run must be | what it writes |
 * |---|---|---|
 * | {@link RemoteRunCalls.transcript} | held (live or ended) | `run_messages`, **re-redacted** by the run's full TD-012 redactor, one row per `seq` — an undecodable entry as an `ingest_refused` row |
 * | {@link RemoteRunCalls.tool} | live | the production `PlatformToolPort` with a context rebuilt from the run's stored plan; a mutating tool's answer in `run_tool_calls`, keyed `(run_id, tool_use_id)` |
 * | {@link RemoteRunCalls.openApproval} | live | a `run_tool_approvals` row, and the `ToolApprovalPort` asked; the decision is written back and delivered on a heartbeat |
 * | {@link RemoteRunCalls.deliverApprovals} | (the heartbeat renewed) | the decided, undelivered approvals, stamped delivered |
 * | {@link RemoteRunCalls.session} | held (live or ended) | `run_session_lines`, each line redacted, idempotent by position |
 * | {@link RemoteRunCalls.sshSign} | live | `run_offers.ssh_signatures + 1` in the epoch-checked statement, then the signature |
 *
 * ## The run's redactor, rebuilt from stored state (TD-031 §10a, backlog 745)
 *
 * The worker redacts with what it knows before anything leaves its machine. The core then redacts
 * again with {@link RemoteRunRedactors.forRun}: the project's binding redactors (every sealed secret
 * of every binding — the API tokens, a static run token, a deploy key), the run's model-credential
 * names from its plan with this process's values, and the platform's pattern rules — which include
 * every minted credential's recorded **shape** (`minted_credential_shapes`, WP-80) and this
 * process's run-scoped registry. A minted token's exact value is known only to the process that
 * minted it; any other replica replaces it by its shape. Nothing here is stored before it has passed
 * that redactor, and `redaction_count` is the worker's count plus the core's.
 *
 * ## Why an undecodable transcript entry is a row, not a refusal
 *
 * A batch is one HTTP call and a worker retries it whole; refusing the batch for one bad entry would
 * either loop or drop the good ones. So an entry that fails `transcriptEventSchema`, names another
 * run or another `seq`, carries a `created_at` outside {@link TRANSCRIPT_CREATED_AT_WINDOW_MS}, or
 * fails the schema after redaction is stored as a `system` entry with subtype
 * {@link INGEST_REFUSED_SUBTYPE} at its `seq` — paths and messages only, redacted, never the entry
 * (TD-031 §10a). It is the runner's `transcript_normalisation_failed` shape, so the run page renders
 * it with no change; `transcript_kind` gains no value, so there is no migration for it.
 *
 * ## Deduplication of a mutating tool (TD-031 §9)
 *
 * A worker retries a tool call whose answer it did not receive, under the same `tool_use_id`. A
 * mutating tool ({@link MUTATING_PLATFORM_TOOLS}) **claims** `(run_id, sha256(tool_use_id))` before
 * it performs, in a transaction that re-checks the fence, and completes the row with the redacted
 * answer after: a repeat of a completed call answers the stored answer and performs nothing; a
 * repeat while the first is in flight is `in_flight` (the worker retries); the same id with another
 * tool or another input is `reused`. A claim older than {@link TOOL_CALL_CLAIM_STALE_MS} with no
 * answer — a process that died mid-call — is taken over: the provider effect under it is the
 * executor's own idempotency (`open_mr:<task>:<branch>`, WP-138), so a second attempt adopts what
 * the first made. The key is a **digest** of the SDK's id, so the stored key is secret-free whatever
 * a tampered worker sends. Reads are not deduplicated: repeating one is harmless.
 *
 * ## Approvals (TD-031 §9)
 *
 * The approval row is opened in a transaction, the port is asked **after** the commit, outside any
 * transaction, and its decision is written back with a wake-up on the lease holder's command topic
 * — the topic a held heartbeat already listens on — so the decision rides the next heartbeat. It is
 * delivered **once** (`delivered_at`); a response the worker never received leaves it to the
 * worker's own timeout, whose answer is the same `deny` (BD-025's unattended default). The
 * production port (`unattendedToolApprovals`) decides at once; a process that dies between the open
 * and the decision leaves the row undecided, and the worker's timeout denies.
 *
 * ## SSH signing (TD-031 decision 5, the 2026-11-04 amendment)
 *
 * The narrow check is WP-146's oracle, unchanged ({@link RemoteRunDeployKeys}: only the run's own
 * key, only an RFC 4252 §7 user-authentication request for user `git`, bounded data). A request it
 * refuses is answered `null` and counts nothing. One it admits is **counted before it is signed**,
 * in one statement fenced on the offer's state, epoch and worker ({@link RemoteRunCallStore.countSignature}),
 * so the cap is one per run whichever replica answers and whichever caller — the runlet relay or the
 * helpers' relayed socket — asked. A run that is terminal, or held under another epoch, is
 * `lease_lost`: every export a worker owes is performed before its `finish` (WP-283).
 */
import { createHash, randomUUID } from 'node:crypto';
import type {
  Id,
  IsoDateTime,
  JsonObject,
  JsonValue,
  PlatformToolName,
  TranscriptEvent,
} from '@platform/contracts';
import { MUTATING_PLATFORM_TOOLS, transcriptEventSchema } from '@platform/contracts';
import { isActiveRunStatus } from '@platform/domain';
import type * as z from 'zod';
import { RUN_TRANSCRIPT_TOPIC } from '../ports/broadcast.js';
import type { SecretRedactor } from '../ports/integrations/audit.js';
import { type Logger, silentLogger } from '../ports/logger.js';
import type { RunPlanSealer } from '../ports/run-plan-sealer.js';
import {
  addTicketCommentInputSchema,
  askHumanInputSchema,
  createFollowupInputSchema,
  getConversationInputSchema,
  getTaskContextInputSchema,
  kbSearchInputSchema,
  notifyHumanInputSchema,
  openMrInputSchema,
  type PlatformToolContext,
  type PlatformToolPort,
  reportProgressInputSchema,
  type ToolApprovalPort,
  updateMrDescriptionInputSchema,
} from '../ports/runner.js';
import type { Transaction } from '../ports/transaction.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { workerLeaseOwner } from './offers.js';
import { runCommandsTopic } from './run-commands.js';
import { openRunPlan } from './run-package.js';
import type { PipelineStore } from './store.js';

/** `system` subtype of a transcript entry the core could not store as sent (TD-031 §10a). */
export const INGEST_REFUSED_SUBTYPE = 'ingest_refused';

/**
 * How far an entry's `created_at` may be from the core's clock: seven days back (a run's wall clock
 * and a retried tail fit well inside it) and ten minutes ahead (clock skew). Outside it the entry is
 * `ingest_refused` and stored at the core's instant — `run_messages` is partitioned by
 * `created_at`, and an instant a worker chose could name a partition that does not exist.
 */
export const TRANSCRIPT_CREATED_AT_WINDOW_MS = { past: 7 * 24 * 3_600_000, future: 600_000 };

/** The largest `seq` a `run_messages` row can carry (`integer`). */
export const MAX_TRANSCRIPT_SEQ = 2_147_483_647;

/** A mutating tool call's claim older than this with no answer is taken over (module docblock). */
export const TOOL_CALL_CLAIM_STALE_MS = 5 * 60_000;

/** The session mirror's bound per run, in lines: past it a batch is refused `full`. */
export const MAX_SESSION_LINES_PER_RUN = 200_000;

/** What the port is told a remote approval may wait: the worker's own timeout decides first. */
export const REMOTE_APPROVAL_TIMEOUT_MS = 10 * 60_000;

/** Where a run stands for a caller holding `(epoch, owner)`. */
export type RemoteRunFence = 'live' | 'ended' | 'lost' | 'gone';

/** One stored tool call (`run_tool_calls`). */
export interface StoredToolCall {
  readonly toolName: string;
  readonly inputDigest: string;
  readonly claimedAt: IsoDateTime;
  /** `null` while the call is in flight. */
  readonly answer: { readonly result: JsonValue; readonly isError: boolean } | null;
}

/** One decided approval as a heartbeat delivers it. */
export interface DecidedApproval {
  readonly approvalId: Id;
  readonly decision: 'allow' | 'deny';
  readonly reason: string;
  readonly questionId: Id | null;
}

/** The tables this module writes — PostgreSQL in `@platform/infrastructure`, memory in tests. */
export interface RemoteRunCallStore {
  /**
   * Stores the entries, each at most once per `(run_id, seq)` — an entry whose `seq` is stored
   * already is skipped, whatever it holds — and answers how many were written.
   */
  appendTranscript(
    tx: Transaction,
    runId: Id,
    entries: readonly TranscriptEvent[],
  ): Promise<number>;
  /** The call under `(runId, toolUseDigest)`, or `null`. */
  findToolCall(tx: Transaction, runId: Id, toolUseDigest: string): Promise<StoredToolCall | null>;
  /**
   * Claims the key: inserts a claim, or — `takeOverBefore` set — replaces an unanswered claim made
   * before that instant. Answers whether this caller holds the claim now.
   */
  claimToolCall(
    tx: Transaction,
    input: {
      readonly runId: Id;
      readonly toolUseDigest: string;
      readonly toolName: string;
      readonly inputDigest: string;
      readonly epoch: number;
      readonly at: IsoDateTime;
      readonly takeOverBefore: IsoDateTime | null;
    },
  ): Promise<boolean>;
  completeToolCall(
    tx: Transaction,
    input: {
      readonly runId: Id;
      readonly toolUseDigest: string;
      readonly result: JsonValue;
      readonly isError: boolean;
      readonly redactionCount: number;
      readonly at: IsoDateTime;
    },
  ): Promise<void>;
  /** Opens an approval, or answers the one already open under `(runId, toolUseDigest)`. */
  openApproval(
    tx: Transaction,
    input: {
      readonly id: Id;
      readonly runId: Id;
      readonly toolUseDigest: string;
      readonly toolName: string;
      readonly epoch: number;
      readonly at: IsoDateTime;
    },
  ): Promise<{ readonly id: Id; readonly created: boolean }>;
  /** Writes a decision once; a decided approval keeps its first. */
  decideApproval(
    tx: Transaction,
    input: {
      readonly id: Id;
      readonly decision: 'allow' | 'deny';
      readonly reason: string;
      readonly questionId: Id | null;
      readonly at: IsoDateTime;
    },
  ): Promise<void>;
  /** The run's decided, undelivered approvals — stamped delivered in the same statement. */
  takeDecidedApprovals(
    tx: Transaction,
    input: { readonly runId: Id; readonly at: IsoDateTime; readonly limit: number },
  ): Promise<readonly DecidedApproval[]>;
  /** How many session lines the run has stored. */
  sessionLineCount(tx: Transaction, runId: Id): Promise<number>;
  /** Stores the lines at `fromLine…`, each position at most once; answers how many were written. */
  appendSessionLines(
    tx: Transaction,
    input: {
      readonly runId: Id;
      readonly sessionId: string;
      readonly fromLine: number;
      readonly lines: readonly { readonly text: string; readonly redactionCount: number }[];
    },
  ): Promise<number>;
  /**
   * TD-031's 2026-11-04 amendment: `ssh_signatures + 1` on the run's offer **in the statement that
   * checks the fence** — the offer claimed, at `epoch`, by `workerId` — and under `max`. `counted`
   * with the new count; `cap` when the fence holds and the cap is spent; `lost` otherwise.
   */
  countSignature(
    tx: Transaction,
    input: {
      readonly runId: Id;
      readonly epoch: number;
      readonly workerId: Id;
      readonly max: number;
    },
  ): Promise<
    | { readonly kind: 'counted'; readonly signatures: number }
    | { readonly kind: 'cap' }
    | { readonly kind: 'lost' }
  >;
}

/** The run's full TD-012 redactor, rebuilt from stored state (module docblock). */
export interface RemoteRunRedactors {
  /** Called outside any transaction: it resolves the project's bindings. */
  forRun(run: { readonly runId: Id; readonly projectId: Id }): Promise<SecretRedactor>;
}

/** One signing request, decoded. */
export interface SshSignRequest {
  readonly keyBlob: Buffer;
  readonly data: Buffer;
  readonly flags: number;
}

/** WP-146's oracle for one run's deploy key, split so the count lands between check and sign. */
export interface RunDeployKeySigner {
  /** The narrow check: the run's own key, an RFC 4252 §7 request for `git`, bounded data. */
  admits(request: SshSignRequest): boolean;
  sign(request: SshSignRequest): Buffer;
}

export interface RemoteRunDeployKeys {
  /**
   * The run's deploy-key signer, or `null` when the run was not given a deploy key
   * (`runs.credential_source`). Called outside any transaction.
   */
  forRun(run: { readonly runId: Id; readonly projectId: Id }): Promise<RunDeployKeySigner | null>;
}

export interface RemoteRunCallsOptions {
  readonly unitOfWork: UnitOfWork;
  readonly store: RemoteRunCallStore;
  /** The fence (`runs.lockSettlement`), the run row and its stored plan. */
  readonly pipeline: Pick<PipelineStore, 'runs' | 'runPlans'>;
  readonly runPlans: RunPlanSealer;
  readonly redactors: RemoteRunRedactors;
  /** The production `PlatformToolPort` (`apps/server/src/platform-tools.ts`). */
  readonly tools: PlatformToolPort;
  readonly approvals: ToolApprovalPort;
  readonly deployKeys: RemoteRunDeployKeys;
  /** `MAX_DEPLOY_KEY_SIGNATURES`: one cap per run, counted in the database. */
  readonly maxSignatures: number;
  readonly now?: () => Date;
  readonly newId?: () => Id;
  readonly logger?: Logger;
}

/** A command's refusal that is about the claim, not the call. */
export type RemoteRunCallRefusal = { readonly kind: 'lease_lost' } | { readonly kind: 'run_gone' };

export type RemoteTranscriptAnswer =
  | {
      readonly kind: 'stored';
      readonly stored: number;
      readonly refusedSeqs: readonly number[];
    }
  | RemoteRunCallRefusal;

export type RemoteToolAnswer =
  | { readonly kind: 'answered'; readonly result: JsonValue; readonly isError: boolean }
  /** The run's role was not given this tool (BD-021): it is absent, never performed. */
  | { readonly kind: 'not_granted' }
  /** A claim on this `tool_use_id` is in flight; the worker retries. */
  | { readonly kind: 'in_flight' }
  /** This `tool_use_id` was used for another tool or another input. */
  | { readonly kind: 'reused' }
  | RemoteRunCallRefusal;

export type RemoteApprovalAnswer =
  | { readonly kind: 'opened'; readonly approvalId: Id }
  | RemoteRunCallRefusal;

export type RemoteSessionAnswer =
  | { readonly kind: 'stored'; readonly stored: number }
  | { readonly kind: 'full'; readonly limit: number }
  | RemoteRunCallRefusal;

export type RemoteSshSignAnswer =
  | { readonly kind: 'signed'; readonly signature: Buffer }
  | { readonly kind: 'refused'; readonly reason: 'not_admitted' | 'no_deploy_key' | 'cap' }
  | RemoteRunCallRefusal;

export interface RemoteRunCalls {
  transcript(input: {
    readonly runId: Id;
    readonly workerId: Id;
    readonly epoch: number;
    readonly entries: readonly { readonly seq: number; readonly event: JsonObject }[];
  }): Promise<RemoteTranscriptAnswer>;
  tool(input: {
    readonly runId: Id;
    readonly workerId: Id;
    readonly epoch: number;
    readonly name: PlatformToolName;
    readonly toolUseId: string;
    readonly input: JsonObject;
    readonly signal: AbortSignal;
  }): Promise<RemoteToolAnswer>;
  openApproval(input: {
    readonly runId: Id;
    readonly workerId: Id;
    readonly epoch: number;
    readonly toolUseId: string;
    readonly toolName: string;
    readonly detail: string;
    readonly input: JsonObject;
    readonly reason: string;
  }): Promise<RemoteApprovalAnswer>;
  /** The decided approvals a heartbeat delivers, after its renewal. */
  deliverApprovals(input: { readonly runId: Id }): Promise<readonly DecidedApproval[]>;
  session(input: {
    readonly runId: Id;
    readonly workerId: Id;
    readonly epoch: number;
    readonly sessionId: string;
    readonly fromLine: number;
    readonly lines: readonly string[];
  }): Promise<RemoteSessionAnswer>;
  sshSign(input: {
    readonly runId: Id;
    readonly workerId: Id;
    readonly epoch: number;
    readonly request: SshSignRequest;
  }): Promise<RemoteSshSignAnswer>;
}

/** How many decided approvals one heartbeat answers (the wire schema's bound). */
export const APPROVALS_PER_HEARTBEAT = 256;

/** SHA-256 hex — the stored key of a `tool_use_id`, and an input's digest. */
export const digestOf = (text: string): string => createHash('sha256').update(text).digest('hex');

/** A JSON value's canonical text: keys sorted at every level, so one input has one digest. */
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
};

/** One tool's strict schema and the port method behind it — `platform-mcp.ts`'s table. */
interface ToolBinding {
  readonly schema: z.ZodObject;
  readonly call: (
    port: PlatformToolPort,
    input: never,
    context: PlatformToolContext,
  ) => Promise<unknown>;
}

const bind = <TSchema extends z.ZodObject>(
  schema: TSchema,
  call: (
    port: PlatformToolPort,
    input: z.infer<TSchema>,
    context: PlatformToolContext,
  ) => Promise<unknown>,
): ToolBinding => ({ schema, call: call as ToolBinding['call'] });

/** Every platform tool's route binding, by name — the same schemas `platform-mcp.ts` re-parses with. */
export const REMOTE_TOOL_BINDINGS: Readonly<Record<PlatformToolName, ToolBinding>> = {
  ask_human: bind(askHumanInputSchema, (port, input, context) => port.askHuman(input, context)),
  notify_human: bind(notifyHumanInputSchema, (port, input, context) =>
    port.notifyHuman(input, context).then(() => 'notified'),
  ),
  report_progress: bind(reportProgressInputSchema, (port, input, context) =>
    port.reportProgress(input, context),
  ),
  get_task_context: bind(getTaskContextInputSchema, (port, input, context) =>
    port.getTaskContext(input, context),
  ),
  get_conversation: bind(getConversationInputSchema, (port, input, context) =>
    port.getConversation(input, context),
  ),
  kb_search: bind(kbSearchInputSchema, (port, input, context) => port.kbSearch(input, context)),
  add_ticket_comment: bind(addTicketCommentInputSchema, (port, input, context) =>
    port.addTicketComment(input, context),
  ),
  open_mr: bind(openMrInputSchema, (port, input, context) => port.openMergeRequest(input, context)),
  update_mr_description: bind(updateMrDescriptionInputSchema, (port, input, context) =>
    port.updateMrDescription(input, context),
  ),
  create_followup_ticket: bind(createFollowupInputSchema, (port, input, context) =>
    port.createFollowupTicket(input, context),
  ),
};

const isMutating = (name: PlatformToolName): boolean =>
  (MUTATING_PLATFORM_TOOLS as readonly string[]).includes(name);

/** Redacts a JSON value of any shape with one redactor. */
const redactValue = (
  redactor: SecretRedactor,
  value: JsonValue,
): { readonly value: JsonValue; readonly count: number } => {
  if (typeof value === 'string') {
    return redactor.redactText(value);
  }
  const wrapped = redactor.redactJson({ value } as JsonObject);
  return { value: (wrapped.value as { value: JsonValue }).value ?? null, count: wrapped.count };
};

/** zod issues as text with paths and messages, never the input. */
const issuesOf = (error: z.ZodError): string =>
  error.issues
    .map(
      (issue) => `${issue.path.length === 0 ? '(root)' : issue.path.join('.')}: ${issue.message}`,
    )
    .join('; ');

export const createRemoteRunCalls = (options: RemoteRunCallsOptions): RemoteRunCalls => {
  const { unitOfWork, store } = options;
  const logger = options.logger ?? silentLogger;
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? ((): Id => randomUUID() as Id);
  const iso = (): IsoDateTime => now().toISOString() as IsoDateTime;

  const fenceIn = async (
    tx: Transaction,
    runId: Id,
    epoch: number,
    workerId: Id,
  ): Promise<{ readonly fence: RemoteRunFence; readonly projectId: Id | null }> => {
    const settlement = await options.pipeline.runs.lockSettlement(tx, runId);
    if (settlement === null) {
      return { fence: 'gone', projectId: null };
    }
    if (settlement.leaseEpoch !== epoch || settlement.leaseOwner !== workerLeaseOwner(workerId)) {
      return { fence: 'lost', projectId: null };
    }
    const row = await options.pipeline.runs.load(tx, runId);
    if (row === null) {
      return { fence: 'gone', projectId: null };
    }
    return {
      fence: isActiveRunStatus(settlement.status) ? 'live' : 'ended',
      projectId: row.projectId,
    };
  };

  const fence = async (runId: Id, epoch: number, workerId: Id) =>
    unitOfWork.transaction(async (scope) => fenceIn(scope.tx, runId, epoch, workerId));

  const refusalOf = (state: RemoteRunFence): RemoteRunCallRefusal =>
    state === 'gone' ? { kind: 'run_gone' } : { kind: 'lease_lost' };

  /** The rebuilt context of a live run (TD-031 §10b): project, task, mode, tools and holds. */
  const subjectOf = async (runId: Id) =>
    unitOfWork.transaction(async (scope) => {
      try {
        return (
          await openRunPlan(
            { runPlans: options.pipeline.runPlans, sealer: options.runPlans },
            scope.tx,
            runId,
          )
        ).stored;
      } catch (error) {
        logger.warn(
          { err: error, run_id: runId },
          'a remote run’s tool call found no readable stored plan; the tool is not granted',
        );
        return null;
      }
    });

  /** One transcript entry as it is stored — the entry, re-redacted, or its `ingest_refused` row. */
  const ingestEntry = (
    runId: Id,
    entry: { readonly seq: number; readonly event: JsonObject },
    redactor: SecretRedactor,
    at: Date,
  ): { readonly row: TranscriptEvent; readonly refused: boolean } => {
    const refuse = (issues: string): { row: TranscriptEvent; refused: true } => ({
      refused: true,
      row: {
        run_id: runId,
        seq: entry.seq,
        created_at: at.toISOString() as IsoDateTime,
        redaction_count: 0,
        kind: 'system',
        subtype: INGEST_REFUSED_SUBTYPE,
        session_id: null,
        model: null,
        // Paths and messages only, and redacted: a key name in a hostile entry is text it chose.
        data: { seq: entry.seq, issues: redactor.redactText(issues).value },
      },
    });
    const parsed = transcriptEventSchema.safeParse(entry.event);
    if (!parsed.success) {
      return refuse(issuesOf(parsed.error));
    }
    const event = parsed.data;
    if (event.run_id !== runId || event.seq !== entry.seq) {
      return refuse('run_id, seq: the entry names another run or another position than its batch');
    }
    const createdAt = Date.parse(event.created_at);
    if (
      !(createdAt >= at.getTime() - TRANSCRIPT_CREATED_AT_WINDOW_MS.past) ||
      !(createdAt <= at.getTime() + TRANSCRIPT_CREATED_AT_WINDOW_MS.future)
    ) {
      return refuse('created_at: outside the window the core stores an entry at');
    }
    const redacted = redactor.redactJson(event as unknown as JsonObject);
    // The envelope is re-applied over the redacted copy, as the runner's own door does: a rule that
    // ever matched a uuid or a timestamp would otherwise corrupt the row's identity.
    const candidate = transcriptEventSchema.safeParse({
      ...redacted.value,
      run_id: runId,
      seq: entry.seq,
      created_at: event.created_at,
      kind: event.kind,
      redaction_count: event.redaction_count + redacted.count,
    });
    if (!candidate.success) {
      return refuse(`after redaction: ${issuesOf(candidate.error)}`);
    }
    return { row: candidate.data, refused: false };
  };

  return {
    transcript: async (input) => {
      const before = await fence(input.runId, input.epoch, input.workerId);
      if (before.fence === 'lost' || before.fence === 'gone' || before.projectId === null) {
        return refusalOf(before.fence);
      }
      const redactor = await options.redactors.forRun({
        runId: input.runId,
        projectId: before.projectId,
      });
      const at = now();
      const seen = new Set<number>();
      const rows: TranscriptEvent[] = [];
      const refusedSeqs: number[] = [];
      for (const entry of input.entries) {
        // A repeated `seq` in one batch: the first is the entry, as the table keeps the first.
        if (seen.has(entry.seq)) continue;
        seen.add(entry.seq);
        const { row, refused } = ingestEntry(input.runId, entry, redactor, at);
        rows.push(row);
        if (refused) refusedSeqs.push(entry.seq);
      }
      return unitOfWork.transaction(async (scope): Promise<RemoteTranscriptAnswer> => {
        const held = await fenceIn(scope.tx, input.runId, input.epoch, input.workerId);
        if (held.fence === 'lost' || held.fence === 'gone') {
          return refusalOf(held.fence);
        }
        const stored = await store.appendTranscript(scope.tx, input.runId, rows);
        const last = Math.max(...rows.map((row) => row.seq));
        // The `run:<id>` stream's position, announced as the core's own sink does (WP-15h) — at the
        // commit, so a reader woken by it finds the rows.
        await scope.broadcast.publish({
          topic: RUN_TRANSCRIPT_TOPIC,
          payload: { run_id: input.runId, seq: last },
        });
        if (refusedSeqs.length > 0) {
          logger.warn(
            { run_id: input.runId, refused_seqs: refusedSeqs },
            'a remote run uploaded transcript entries the core could not store as sent; each is an ingest_refused row',
          );
        }
        return { kind: 'stored', stored, refusedSeqs };
      });
    },

    tool: async (input) => {
      const before = await fence(input.runId, input.epoch, input.workerId);
      if (before.fence !== 'live') {
        return refusalOf(before.fence === 'ended' ? 'lost' : before.fence);
      }
      const spec = await subjectOf(input.runId);
      if (spec === null || !spec.platformTools.includes(input.name)) {
        return { kind: 'not_granted' };
      }
      const binding = REMOTE_TOOL_BINDINGS[input.name];
      const parsed = binding.schema.safeParse(input.input);
      if (!parsed.success) {
        // What the in-process MCP server answers the model (`platform-mcp.ts`), word for word.
        return {
          kind: 'answered',
          result: `invalid input for ${input.name}: ${issuesOf(parsed.error)}`,
          isError: true,
        };
      }
      const redactor = await options.redactors.forRun({
        runId: input.runId,
        projectId: spec.projectId,
      });
      const mutating = isMutating(input.name);
      const toolUseDigest = digestOf(input.toolUseId);
      const inputDigest = digestOf(canonical(parsed.data));
      if (mutating) {
        const claim = await unitOfWork.transaction(
          async (scope): Promise<RemoteToolAnswer | null> => {
            const held = await fenceIn(scope.tx, input.runId, input.epoch, input.workerId);
            if (held.fence !== 'live') {
              return refusalOf(held.fence === 'ended' ? 'lost' : held.fence);
            }
            const existing = await store.findToolCall(scope.tx, input.runId, toolUseDigest);
            if (existing !== null) {
              if (existing.toolName !== input.name || existing.inputDigest !== inputDigest) {
                return { kind: 'reused' };
              }
              if (existing.answer !== null) {
                return {
                  kind: 'answered',
                  result: existing.answer.result,
                  isError: existing.answer.isError,
                };
              }
            }
            const staleBefore = new Date(now().getTime() - TOOL_CALL_CLAIM_STALE_MS).toISOString();
            const claimed = await store.claimToolCall(scope.tx, {
              runId: input.runId,
              toolUseDigest,
              toolName: input.name,
              inputDigest,
              epoch: input.epoch,
              at: iso(),
              takeOverBefore: existing === null ? null : (staleBefore as IsoDateTime),
            });
            return claimed ? null : { kind: 'in_flight' };
          },
        );
        if (claim !== null) {
          return claim;
        }
      }
      const context: PlatformToolContext = {
        runId: input.runId,
        taskId: spec.taskId,
        projectId: spec.projectId,
        mode: spec.mode,
        signal: input.signal,
        redactor,
        ...(spec.promptHolds === undefined ? {} : { promptHolds: spec.promptHolds }),
      };
      let answer: { readonly result: JsonValue; readonly isError: boolean; readonly count: number };
      try {
        const result = await binding.call(options.tools, parsed.data as never, context);
        const redacted = redactValue(redactor, (result ?? null) as JsonValue);
        answer = { result: redacted.value, isError: false, count: redacted.count };
      } catch (error) {
        // `platform-mcp.ts`'s failure branch: the message of an `Error`, redacted, and nothing of
        // anything else.
        const message = error instanceof Error ? error.message : 'unknown error';
        const redacted = redactor.redactText(`${input.name} failed: ${message}`);
        answer = { result: redacted.value, isError: true, count: redacted.count };
      }
      if (mutating) {
        await unitOfWork.transaction(async (scope) =>
          store.completeToolCall(scope.tx, {
            runId: input.runId,
            toolUseDigest,
            result: answer.result,
            isError: answer.isError,
            redactionCount: answer.count,
            at: iso(),
          }),
        );
      }
      return { kind: 'answered', result: answer.result, isError: answer.isError };
    },

    openApproval: async (input) => {
      const before = await fence(input.runId, input.epoch, input.workerId);
      if (before.fence !== 'live' || before.projectId === null) {
        return refusalOf(before.fence === 'ended' ? 'lost' : before.fence);
      }
      const run = await unitOfWork.transaction(async (scope) =>
        options.pipeline.runs.load(scope.tx, input.runId),
      );
      if (run === null) {
        return { kind: 'run_gone' };
      }
      const opened = await unitOfWork.transaction(
        async (scope): Promise<RemoteApprovalAnswer | { id: Id; created: boolean }> => {
          const held = await fenceIn(scope.tx, input.runId, input.epoch, input.workerId);
          if (held.fence !== 'live') {
            return refusalOf(held.fence === 'ended' ? 'lost' : held.fence);
          }
          return store.openApproval(scope.tx, {
            id: newId(),
            runId: input.runId,
            toolUseDigest: digestOf(input.toolUseId),
            toolName: input.toolName,
            epoch: input.epoch,
            at: iso(),
          });
        },
      );
      if ('kind' in opened) {
        return opened;
      }
      if (opened.created) {
        const redactor = await options.redactors.forRun({
          runId: input.runId,
          projectId: before.projectId,
        });
        // After the commit and outside any transaction; never awaited by the request, because a
        // port that asks a human waits for one (module docblock).
        void decide(
          opened.id,
          {
            runId: input.runId,
            taskId: run.taskId,
            toolName: input.toolName,
            detail: redactor.redactText(input.detail).value,
            input: redactor.redactJson(input.input).value,
            reason: redactor.redactText(input.reason).value,
          },
          input.workerId,
        );
      }
      return { kind: 'opened', approvalId: opened.id };
    },

    deliverApprovals: async (input) =>
      unitOfWork.transaction(async (scope) =>
        store.takeDecidedApprovals(scope.tx, {
          runId: input.runId,
          at: iso(),
          limit: APPROVALS_PER_HEARTBEAT,
        }),
      ),

    session: async (input) => {
      const before = await fence(input.runId, input.epoch, input.workerId);
      if (before.fence === 'lost' || before.fence === 'gone' || before.projectId === null) {
        return refusalOf(before.fence);
      }
      const redactor = await options.redactors.forRun({
        runId: input.runId,
        projectId: before.projectId,
      });
      // TD-031 §9: the mirror is redacted on ingest. Each line is redacted as text, because a line is
      // the session file's own JSONL and the core stores it as it would be replayed.
      const lines = input.lines.map((line) => {
        const redacted = redactor.redactText(line);
        return { text: redacted.value, redactionCount: redacted.count };
      });
      return unitOfWork.transaction(async (scope): Promise<RemoteSessionAnswer> => {
        const held = await fenceIn(scope.tx, input.runId, input.epoch, input.workerId);
        if (held.fence === 'lost' || held.fence === 'gone') {
          return refusalOf(held.fence);
        }
        if (input.fromLine + lines.length > MAX_SESSION_LINES_PER_RUN) {
          return { kind: 'full', limit: MAX_SESSION_LINES_PER_RUN };
        }
        const stored = await store.appendSessionLines(scope.tx, {
          runId: input.runId,
          sessionId: input.sessionId,
          fromLine: input.fromLine,
          lines,
        });
        return { kind: 'stored', stored };
      });
    },

    sshSign: async (input) => {
      const before = await fence(input.runId, input.epoch, input.workerId);
      if (before.fence !== 'live' || before.projectId === null) {
        return refusalOf(before.fence === 'ended' ? 'lost' : before.fence);
      }
      const signer = await options.deployKeys.forRun({
        runId: input.runId,
        projectId: before.projectId,
      });
      if (signer === null) {
        return { kind: 'refused', reason: 'no_deploy_key' };
      }
      // WP-146's narrow check first: a request it refuses is answered `null` and counts nothing.
      if (!signer.admits(input.request)) {
        return { kind: 'refused', reason: 'not_admitted' };
      }
      const counted = await unitOfWork.transaction(async (scope) =>
        store.countSignature(scope.tx, {
          runId: input.runId,
          epoch: input.epoch,
          workerId: input.workerId,
          max: options.maxSignatures,
        }),
      );
      if (counted.kind === 'lost') {
        return { kind: 'lease_lost' };
      }
      if (counted.kind === 'cap') {
        logger.warn(
          { run_id: input.runId, max: options.maxSignatures },
          'a remote run asked for more SSH signatures than one run may have; refused',
        );
        return { kind: 'refused', reason: 'cap' };
      }
      return { kind: 'signed', signature: signer.sign(input.request) };
    },
  };

  /** Asks the port and writes its decision back, waking the lease holder's held heartbeat. */
  async function decide(
    approvalId: Id,
    request: {
      readonly runId: Id;
      readonly taskId: Id;
      readonly toolName: string;
      readonly detail: string;
      readonly input: JsonObject;
      readonly reason: string;
    },
    workerId: Id,
  ): Promise<void> {
    let decision: { decision: 'allow' | 'deny'; reason: string; questionId: Id | null };
    try {
      decision = await options.approvals.requestApproval({
        ...request,
        timeoutMs: REMOTE_APPROVAL_TIMEOUT_MS,
        signal: AbortSignal.timeout(REMOTE_APPROVAL_TIMEOUT_MS),
      });
    } catch (error) {
      // The port's contract is that it never throws to mean "no"; one that does is denied here.
      logger.error(
        { err: error, run_id: request.runId, approval_id: approvalId },
        'a remote run’s approval request failed; it is denied',
      );
      decision = {
        decision: 'deny',
        reason: 'the approval could not be asked, so it was denied',
        questionId: null,
      };
    }
    try {
      await unitOfWork.transaction(async (scope) => {
        await store.decideApproval(scope.tx, {
          id: approvalId,
          decision: decision.decision,
          reason: decision.reason,
          questionId: decision.questionId,
          at: iso(),
        });
        const owner = workerLeaseOwner(workerId);
        await scope.broadcast.publish({
          topic: runCommandsTopic(owner),
          payload: { lease_owner: owner, run_id: request.runId },
        });
      });
    } catch (error) {
      logger.error(
        { err: error, run_id: request.runId, approval_id: approvalId },
        'a remote run’s approval decision could not be written; the worker’s own timeout denies it',
      );
    }
  }
};

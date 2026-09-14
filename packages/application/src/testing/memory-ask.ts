/**
 * The in-memory `AskStore` — the fake the ask's unit tier and the contract suite run against.
 *
 * ## Divergence register — a fake may be stricter than the real adapter, never kinder
 *
 * | # | Divergence | Direction | Justification |
 * |---|---|---|---|
 * | 1 | It ignores the `Transaction` handle entirely, so nothing rolls back. | **different** | Every in-memory store in this repository does; the e2e tier is where a rollback means anything. Stated here rather than inherited silently. |
 * | 2 | `runsForTask` and `auditForTask` read **arrays this store owns**, not the `runs` and `human_actions` tables the SQL adapter joins. | **different** | The two projections have no in-memory source of truth to read — `MemoryPipelineStore` holds runs in a shape of its own and nothing holds `human_actions` at all — so the fake is *given* the rows through {@link MemoryAskStore.seedRun} / {@link MemoryAskStore.seedAudit}. The shared contract suite runs the same cases against PostgreSQL, which is what keeps the two answering alike. |
 * | 3 | A `ui` ask never collides; a second `ticket` ask for the same `(project, comment)` answers `'duplicate'`. | **same** | This is the `task_asks_ticket_comment_unique` index, reproduced rather than approximated — it is the thing that makes a redelivered webhook cost nothing, and a fake that let the second one through would make that property untested. |
 * | 4 | The three status invariants of migration 0024 (`answered` ⇔ an answer and an instant; `refused`/`failed` ⇔ a reason) are **enforced here too**, by throwing. | **stricter** | They are `check` constraints in the database, so a caller that broke one would fail in production and pass here. Stricter is the direction a fake may take (standing rule 1). |
 */
import type { AskAnswerCitation, Id, IsoDateTime } from '@platform/contracts';
import type { AskAuditLine, AskRunLine, AskStore, NewAsk, StoredAsk } from '../ask/store.js';
import type { Transaction } from '../ports/transaction.js';

export class MemoryAskStoreError extends Error {
  override readonly name = 'MemoryAskStoreError';
}

export interface MemoryAskStore extends AskStore {
  /** See divergence 2: the run and audit projections are seeded rather than derived. */
  seedRun(run: AskRunLine & { readonly taskId: Id }): void;
  seedAudit(entry: AskAuditLine & { readonly taskId: Id }): void;
  /** Every ask this store holds, oldest first — for an assertion that wants the whole table. */
  all(): readonly StoredAsk[];
}

const clone = <T>(value: T): T => structuredClone(value) as T;

export const createMemoryAskStore = (): MemoryAskStore => {
  const asks = new Map<Id, StoredAsk>();
  const runs: (AskRunLine & { taskId: Id })[] = [];
  const audit: (AskAuditLine & { taskId: Id })[] = [];

  const require = (askId: Id): StoredAsk => {
    const current = asks.get(askId);
    if (current === undefined) {
      throw new MemoryAskStoreError(`ask ${askId} does not exist`);
    }
    return current;
  };

  return {
    insert: async (_tx: Transaction, ask: NewAsk) => {
      if (
        ask.ticketCommentId !== null &&
        [...asks.values()].some(
          (existing) =>
            existing.projectId === ask.projectId &&
            existing.ticketCommentId === ask.ticketCommentId,
        )
      ) {
        return 'duplicate';
      }
      asks.set(
        ask.id,
        clone({
          ...ask,
          runId: null,
          status: 'pending' as const,
          answer: null,
          citations: [] as readonly AskAnswerCitation[],
          droppedCitations: 0,
          answerArtifactId: null,
          refusalReason: null,
          mirroredAt: null,
          answeredAt: null,
        }),
      );
      return 'inserted';
    },
    load: async (_tx, askId) => {
      const found = asks.get(askId);
      return found === undefined ? null : clone(found);
    },
    attachRun: async (_tx, askId, runId) => {
      asks.set(askId, clone({ ...require(askId), runId }));
    },
    recordAnswer: async (_tx, input) => {
      const current = require(input.askId);
      asks.set(
        input.askId,
        clone({
          ...current,
          status: 'answered' as const,
          answer: input.answer,
          citations: input.citations,
          droppedCitations: input.droppedCitations,
          answerArtifactId: input.answerArtifactId,
          redactionCount: current.redactionCount + input.redactionCount,
          answeredAt: input.answeredAt,
          refusalReason: null,
        }),
      );
    },
    recordRefusal: async (_tx, input) => {
      if (input.reason.trim() === '') {
        // Divergence 4: `task_asks_refusal_pair` would refuse this row.
        throw new MemoryAskStoreError(`a ${input.status} ask carries a reason`);
      }
      const current = require(input.askId);
      asks.set(
        input.askId,
        clone({
          ...current,
          status: input.status,
          refusalReason: input.reason,
          answer: null,
          answeredAt: null,
        }),
      );
    },
    markMirrored: async (_tx, askId, at: IsoDateTime) => {
      asks.set(askId, clone({ ...require(askId), mirroredAt: at }));
    },
    listForTask: async (_tx, taskId, limit) =>
      [...asks.values()]
        .filter((ask) => ask.taskId === taskId)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, limit)
        .map(clone),
    runsForTask: async (_tx, taskId, limit) =>
      runs
        .filter((run) => run.taskId === taskId)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, limit)
        .map(clone),
    auditForTask: async (_tx, taskId, limit) =>
      audit
        .filter((entry) => entry.taskId === taskId)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, limit)
        .map(clone),
    seedRun: (run) => {
      runs.push(clone(run));
    },
    seedAudit: (entry) => {
      audit.push(clone(entry));
    },
    all: () => [...asks.values()].map(clone),
  };
};

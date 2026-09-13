/**
 * An in-memory {@link PipelineStore} — technical/10: fakes are first-class code.
 *
 * It is what the saga's unit tier runs against, and it is held to the same contract suite as the
 * PostgreSQL implementation (`test/contract/support/pipeline-store-suite.ts`), so "the saga works"
 * and "the saga works on a database" are one claim rather than two.
 *
 * ## Divergence register — a fake may be stricter than the real adapter, never kinder
 *
 * | # | Divergence | Direction | Justification |
 * |---|---|---|---|
 * | 1 | `insert` throws on a duplicate `(project, ticket_key, mode)`; PostgreSQL raises a unique-violation the caller sees as an error too. | **same** | The unique index is `tasks_project_id_ticket_key_mode`; both refuse. Asserted by the shared suite's `refuses a second task for the same ticket`. |
 * | 2 | `save` throws when the task was never inserted; the SQL `update` would affect zero rows and say nothing. | **stricter** | A save that writes nothing is how a state machine silently stops advancing. The SQL implementation therefore checks `rowCount` and throws the same error, which is the only reason the two agree. Asserted by `refuses to save a task it has never seen`. |
 * | 3 | Everything is returned by structural clone, so a caller mutating what it read cannot change the store. Postgres cannot be mutated that way either. | **stricter** | A shared object graph makes a test pass for the wrong reason: the aggregate is immutable by design, and a fake that hands out live references would hide a mutation. |
 * | 5 | ~~The whole-row `save` writes `ticketSnapshot`/`ticketSnapshotAt`; the SQL `save` does not name those two columns at all (WP-15f).~~ **Closed at WP-15e**: `save` now writes exactly the column set the SQL statement names, in both stores, and the divergence is gone rather than justified. | **same** | It was filed as *stricter* and it was, but a fake that can clobber a column the database cannot is a fake that answers a question production never asks — and the same shape one work package later (`save` clobbering `workpad_ref`, which PostgreSQL **could** do) was a live defect. The partition is now enforced off disk by `tasks-column-ownership.test.ts`. |
 * | 6 | `save` refuses a write over a row whose `version` has moved, exactly as the SQL `where … and version = $n` does (WP-15e). | **same** | The fake compares a number where PostgreSQL compares a predicate, and both throw `TaskConcurrentModificationError`. Asserted for both by `pipeline-store-concurrency-suite.ts`, which drives two transactions over one committed row. The fake's `version` is still only as good as divergence 4: with no isolation, the interleaving it reproduces is the *ordering*, not the locking. |
 * | 4 | No transaction isolation: a `Transaction` handle is accepted and ignored, so a rolled-back "transaction" leaves its writes. | **kinder** | This is the one that matters, and the reason the same suite runs against PostgreSQL: rollback semantics cannot be faked in a Map. **Positive assertion**: `memory-pipeline.test.ts` asserts the divergence explicitly (`keeps writes a rolled-back scope made, which PostgreSQL does not`), so a reader meets it as a test rather than as a warning, and the e2e tier runs the pipeline on the real thing. |
 */
import type { ArtifactType, Id, Slug } from '@platform/contracts';
import { workpadRefSchema } from '@platform/contracts';
import type { Approval, Question, QueuedTask } from '@platform/domain';
import { countsAsActive, countsInPipeline } from '@platform/domain';
import type {
  ApprovalRepository,
  ArtifactRepository,
  PipelineStore,
  QuestionRepository,
  RunRepository,
  StoredApproval,
  StoredArtifact,
  StoredRun,
  StoredTask,
  TaskRepository,
} from '../pipeline/store.js';
import { TaskConcurrentModificationError } from '../pipeline/store.js';

export class PipelineStoreError extends Error {
  override readonly name = 'PipelineStoreError';
}

interface StageRow {
  taskId: Id;
  stage: Slug;
  attempt: number;
  outcome: string | null;
  returnReason: string | null;
  signature: string | null;
  enteredAt: number;
  exitedAt: number | null;
}

const clone = <T>(value: T): T => structuredClone(value);

export interface MemoryPipelineStore extends PipelineStore {
  /** Every task, for a test that wants to look without a transaction. */
  snapshot(): readonly StoredTask[];
  readonly stageRows: readonly StageRow[];
}

export const createMemoryPipelineStore = (): MemoryPipelineStore => {
  const tasks = new Map<Id, StoredTask>();
  const stages: StageRow[] = [];
  const artifacts: StoredArtifact[] = [];
  const runs = new Map<Id, StoredRun>();
  const questions = new Map<Id, Question>();
  const approvals = new Map<Id, StoredApproval>();
  let sequence = 0;

  const taskRepository: TaskRepository = {
    load: async (_tx, taskId) => {
      const stored = tasks.get(taskId);
      return stored === undefined ? null : clone(stored);
    },
    findByTicket: async (_tx, query) => {
      const found = [...tasks.values()].find(
        (stored) =>
          stored.task.projectId === query.projectId &&
          stored.task.ticket.provider === query.provider &&
          stored.task.ticket.key === query.ticketKey &&
          stored.task.mode === query.mode,
      );
      return found === undefined ? null : clone(found);
    },
    findByMergeRequest: async (_tx, query) => {
      const found = [...tasks.values()].find(
        (stored) => stored.task.projectId === query.projectId && stored.mr?.iid === query.iid,
      );
      return found === undefined ? null : clone(found);
    },
    listAtStage: async (_tx, projectId, stage) =>
      [...tasks.values()]
        .filter(
          (stored) => stored.task.projectId === projectId && stored.task.currentStage === stage,
        )
        .map(clone),
    insert: async (_tx, stored) => {
      const duplicate = [...tasks.values()].some(
        (existing) =>
          existing.task.projectId === stored.task.projectId &&
          existing.task.ticket.key === stored.task.ticket.key &&
          existing.task.mode === stored.task.mode,
      );
      if (duplicate) {
        throw new PipelineStoreError(
          `a task already exists for ${stored.task.ticket.key} in mode ${stored.task.mode}`,
        );
      }
      tasks.set(stored.task.id, clone(stored));
    },
    /**
     * The same columns the SQL `update tasks set …` names, and the same optimistic check (WP-15e).
     *
     * Written as a projection of `current` rather than as `clone(stored)` on purpose: the fields it
     * does **not** list (`workpad`, `ticketSnapshot`, `ticketSnapshotAt`, `estimateUsd`,
     * `priorityRank`, `createdAt`, `template`) belong to the narrow writers, and a fake that let a
     * whole-row save carry them would answer a question the database cannot be asked — which is how
     * WP-15h found the memory store certifying behaviour PostgreSQL does not have.
     */
    save: async (_tx, stored) => {
      const current = tasks.get(stored.task.id);
      if (current === undefined) {
        throw new PipelineStoreError(`task ${stored.task.id} does not exist`);
      }
      if (current.version !== stored.version) {
        throw new TaskConcurrentModificationError(stored.task.id, stored.version, current.version);
      }
      const written: StoredTask = {
        ...current,
        task: stored.task,
        branch: stored.branch,
        mr: stored.mr,
        costActualUsd: stored.costActualUsd,
        version: current.version + 1,
      };
      tasks.set(stored.task.id, clone(written));
      // The caller's own snapshot at the new version, so a second save in the same unit is not a
      // conflict with the first: `{ ...stored }` rather than `{ ...current }`, because the columns
      // this write ignored are the store's and the ones it took are the caller's.
      return clone({ ...stored, version: written.version });
    },
    saveWorkpad: async (_tx, taskId, workpad) => {
      const current = tasks.get(taskId);
      if (current === undefined) {
        throw new PipelineStoreError(`task ${taskId} does not exist`);
      }
      // Only this field, like the SQL `update tasks set workpad_ref = …`: a whole-row write from
      // the outbound job would put back whatever the stage executor had just changed (WP-15d).
      //
      // Parsed for the same reason the SQL adapter parses (WP-15h): the column's published shape is
      // strict, a `CommentRef` passes the port's `WorkpadRef` parameter structurally, and a fake
      // that accepted what PostgreSQL's reader refuses would be kinder than production (rule 1).
      tasks.set(taskId, clone({ ...current, workpad: workpadRefSchema.parse(workpad) }));
    },
    saveTicketSnapshot: async (_tx, taskId, ticketSnapshot, readAt) => {
      const current = tasks.get(taskId);
      if (current === undefined) {
        throw new PipelineStoreError(`task ${taskId} does not exist`);
      }
      // Two columns, like the SQL: the backfill runs beside the stage executor (WP-15f).
      tasks.set(taskId, clone({ ...current, ticketSnapshot, ticketSnapshotAt: readAt }));
    },
    counts: async (_tx, projectId) => {
      const owned = [...tasks.values()].filter((stored) => stored.task.projectId === projectId);
      return {
        activeTasks: owned.filter((stored) => countsAsActive(stored.task.state)).length,
        tasksInPipeline: owned.filter((stored) => countsInPipeline(stored.task.state)).length,
      };
    },
    queued: async (_tx, projectId): Promise<readonly QueuedTask[]> =>
      [...tasks.values()]
        .filter((stored) => stored.task.projectId === projectId && stored.task.state === 'queued')
        .map((stored) => ({
          id: stored.task.id,
          priorityRank: stored.priorityRank,
          createdAt: stored.createdAt,
        })),
    recordStageEntered: async (_tx, entry) => {
      sequence += 1;
      stages.push({
        taskId: entry.taskId,
        stage: entry.stage,
        attempt: entry.attempt,
        outcome: null,
        returnReason: null,
        signature: null,
        enteredAt: sequence,
        exitedAt: null,
      });
    },
    recordStageExited: async (_tx, entry) => {
      sequence += 1;
      const row = [...stages]
        .reverse()
        .find(
          (candidate) =>
            candidate.taskId === entry.taskId &&
            candidate.stage === entry.stage &&
            candidate.attempt === entry.attempt,
        );
      if (row === undefined) {
        return;
      }
      row.outcome = entry.outcome;
      row.returnReason = entry.returnReason;
      row.exitedAt = sequence;
    },
    recordStageSignature: async (_tx, entry) => {
      sequence += 1;
      const row = [...stages]
        .reverse()
        .find(
          (candidate) =>
            candidate.taskId === entry.taskId &&
            candidate.stage === entry.stage &&
            candidate.attempt === entry.attempt,
        );
      if (row === undefined) {
        stages.push({
          taskId: entry.taskId,
          stage: entry.stage,
          attempt: entry.attempt,
          outcome: null,
          returnReason: null,
          signature: entry.signature,
          enteredAt: sequence,
          exitedAt: null,
        });
        return;
      }
      row.signature = entry.signature;
    },
    recentStageSignatures: async (_tx, taskId, stage, limit) =>
      stages
        .filter((row) => row.taskId === taskId && row.stage === stage && row.signature !== null)
        .sort((a, b) => a.attempt - b.attempt)
        .slice(-limit)
        .map((row) => row.signature as string),
    lastReturnReason: async (_tx, taskId, stage) =>
      stages
        .filter((row) => row.taskId === taskId && row.stage === stage && row.returnReason !== null)
        .sort((a, b) => a.attempt - b.attempt)
        .at(-1)?.returnReason ?? null,
  };

  const artifactRepository: ArtifactRepository = {
    nextVersion: async (_tx, taskId, type) =>
      artifacts.filter((artifact) => artifact.taskId === taskId && artifact.type === type).length +
      1,
    insert: async (_tx, artifact) => {
      artifacts.push(clone(artifact));
    },
    latest: async (_tx, taskId, type: ArtifactType) => {
      const owned = artifacts.filter(
        (artifact) => artifact.taskId === taskId && artifact.type === type,
      );
      const last = owned.at(-1);
      return last === undefined ? null : clone(last);
    },
    listFor: async (_tx, taskId) =>
      artifacts.filter((artifact) => artifact.taskId === taskId).map(clone),
  };

  const runRepository: RunRepository = {
    /**
     * Stores the stage as a **link**, exactly as the SQL adapter does, which makes this fake
     * stricter rather than kinder (standing rule 1).
     *
     * `runs` has no `stage` column: the SQL adapter resolves `task_stage_id` from
     * `(task_id, stage, attempt)` at insert time and `load` joins it back, so a run inserted for a
     * stage that was never entered loads with `stage: null` there. Keeping the caller's value here
     * would make the in-memory store answer a question the database cannot, which is the direction
     * that launders a bug into a pass.
     */
    insert: async (_tx, run) => {
      const linked = stages.some(
        (row) =>
          row.taskId === run.taskId && row.stage === run.stage && row.attempt === run.attempt,
      );
      runs.set(run.id, clone({ ...run, stage: linked ? run.stage : null }));
    },
    finish: async (_tx, outcome) => {
      const run = runs.get(outcome.runId);
      if (run === undefined) {
        throw new PipelineStoreError(`run ${outcome.runId} does not exist`);
      }
      runs.set(outcome.runId, {
        ...run,
        status: outcome.status,
        terminalReason: outcome.terminalReason,
        sessionId: outcome.sessionId,
        numTurns: outcome.numTurns,
        usage: outcome.usage,
        cost: outcome.cost,
        wallMs: outcome.wallMs,
      });
    },
    load: async (_tx, runId) => {
      const run = runs.get(runId);
      return run === undefined ? null : clone(run);
    },
    totalsFor: async (_tx, taskId) => {
      const owned = [...runs.values()].filter((run: StoredRun) => run.taskId === taskId);
      return {
        runs: owned.length,
        costUsd: owned.reduce((total, run) => total + (run.cost?.usd ?? 0), 0),
        isEstimate: owned.some((run) => run.cost?.is_estimate === true),
        wallMs: owned.reduce((total, run) => total + run.wallMs, 0),
      };
    },
  };

  const questionRepository: QuestionRepository = {
    insert: async (_tx, question) => {
      questions.set(question.id, clone(question));
    },
    load: async (_tx, questionId) => {
      const question = questions.get(questionId);
      return question === undefined ? null : clone(question);
    },
    save: async (_tx, question) => {
      if (!questions.has(question.id)) {
        throw new PipelineStoreError(`question ${question.id} does not exist`);
      }
      questions.set(question.id, clone(question));
    },
    open: async (_tx, taskId) =>
      [...questions.values()]
        .filter((question: Question) => question.taskId === taskId && question.status === 'open')
        .map(clone),
  };

  const approvalRepository: ApprovalRepository = {
    insert: async (_tx, stored) => {
      approvals.set(stored.approval.id, clone(stored));
    },
    load: async (_tx, approvalId) => {
      const stored = approvals.get(approvalId);
      return stored === undefined ? null : clone(stored);
    },
    save: async (_tx, stored) => {
      if (!approvals.has(stored.approval.id)) {
        throw new PipelineStoreError(`approval ${stored.approval.id} does not exist`);
      }
      approvals.set(stored.approval.id, clone(stored));
    },
    forStageAttempt: async (_tx, query) => {
      const found = [...approvals.values()].find(
        (stored: StoredApproval) =>
          stored.approval.taskId === query.taskId &&
          stored.approval.kind === query.kind &&
          stored.stage === query.stage &&
          stored.attempt === query.attempt,
      );
      return found === undefined ? null : clone(found);
    },
  };

  return {
    tasks: taskRepository,
    artifacts: artifactRepository,
    runs: runRepository,
    questions: questionRepository,
    approvals: approvalRepository,
    snapshot: () => [...tasks.values()].map(clone),
    get stageRows() {
      return stages.map((row) => ({ ...row }));
    },
  };
};

export type { Approval, Question };

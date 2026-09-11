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
 * | 4 | No transaction isolation: a `Transaction` handle is accepted and ignored, so a rolled-back "transaction" leaves its writes. | **kinder** | This is the one that matters, and the reason the same suite runs against PostgreSQL: rollback semantics cannot be faked in a Map. **Positive assertion**: `memory-pipeline.test.ts` asserts the divergence explicitly (`keeps writes a rolled-back scope made, which PostgreSQL does not`), so a reader meets it as a test rather than as a warning, and the e2e tier runs the pipeline on the real thing. |
 */
import type { ArtifactType, Id, Slug } from '@platform/contracts';
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
    save: async (_tx, stored) => {
      if (!tasks.has(stored.task.id)) {
        throw new PipelineStoreError(`task ${stored.task.id} does not exist`);
      }
      tasks.set(stored.task.id, clone(stored));
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
    insert: async (_tx, run) => {
      runs.set(run.id, clone(run));
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

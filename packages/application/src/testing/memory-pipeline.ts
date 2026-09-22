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
 * | 7 | `task.sequence` was the number the stored aggregate carried; PostgreSQL derives it from the **event log** (`max(stream_seq) + 1`, `TASK_COLUMNS`). **Closed at WP-26** by {@link MemoryPipelineStoreOptions.streamSequence}: a harness that wires the event log in gets the derived number. | **same, when wired** | It was *kinder* and it hid a whole class: an event appended to a task's stream by anything other than the aggregate — `task.review.observed` (WP-24), `task.lint.posted` (WP-25), `task.rebase.checked` and `task.conflict.warned` (WP-26) — left the fake's aggregate one behind the log, so the **next** aggregate write would clash in production and not here. It only stayed invisible because the first three land on a task that has stopped. Unwired, the old behaviour remains, which is why the accessor takes the **maximum** of the two rather than replacing one with the other: a transaction's own staged appends are not committed yet, and the aggregate's number is the right answer for them. |
 */
import type { ArtifactType, EstimateBasis, Id, IsoDateTime, Size, Slug } from '@platform/contracts';
import {
  taskCoverageSchema,
  taskDependenciesSchema,
  taskReviewersSchema,
  workpadRefSchema,
} from '@platform/contracts';
import type { Approval, Question, QueuedTask } from '@platform/domain';
import { countsAsActive, countsInPipeline, isActiveRunStatus } from '@platform/domain';
import type {
  ApprovalRepository,
  ArtifactRepository,
  BreakdownRepository,
  PipelineStore,
  QuestionRepository,
  RunRepository,
  StoredApproval,
  StoredArtifact,
  StoredBreakdownItem,
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
  /**
   * The in-memory twin of the one narrow write `CostStore.saveEstimate` makes on `tasks`.
   *
   * It lives here rather than on the cost store because the two stores are the same **row** in
   * PostgreSQL and two different objects in this ring, and the harness that composes them has to
   * join them somewhere. `createPipelineHarness` passes it as the memory cost store's `estimates`
   * seam, so a saga test's budget gate reads a number the **real** estimator computed from the
   * **real** `RefinedSpec` the scripted refinement produced, rather than one the test typed in
   * (standing rule 82).
   *
   * The four columns are exactly the SQL's, and it is not a `save`: it never touches the
   * aggregate's own columns and never bumps `version`, for the reason `save`'s docblock gives.
   */
  writeEstimate(
    taskId: Id,
    estimate: {
      readonly size: Size;
      readonly estimateUsd: number | null;
      readonly basis: EstimateBasis;
      readonly samples: number;
    },
  ): void;
  /**
   * Runs the cost ledger has charged — the seam `RunRepository.recordCost`'s third predicate needs.
   *
   * In PostgreSQL the predicate is `not exists (select 1 from cost_entries …)`, a table this store
   * does not have. A fake that simply dropped the check would be **kinder** than production
   * (standing rule 1): it would accept a second charge of the same run and let a test that ought to
   * fail pass. So the harness that owns the ledger adds the run id here when it charges it, and
   * this store refuses exactly what the database refuses.
   */
  readonly chargedRuns: Set<Id>;
  /** The lease a run currently holds, for a test that asserts the heartbeat wrote one (WP-47). */
  leaseOf(runId: Id): { readonly owner: string; readonly expiresAt: IsoDateTime } | null;
}

export interface MemoryPipelineStoreOptions {
  /**
   * The next `stream_seq` of a task's event stream, read from the harness's own event log — the
   * number PostgreSQL derives in `TASK_COLUMNS` (WP-26, divergence 7).
   *
   * Optional, so every existing construction site keeps working; a harness that composes this store
   * beside `MemoryEventing` should pass it, and `createPipelineHarness` does.
   */
  readonly streamSequence?: (taskId: Id) => number;
}

export const createMemoryPipelineStore = (
  options: MemoryPipelineStoreOptions = {},
): MemoryPipelineStore => {
  const tasks = new Map<Id, StoredTask>();
  const stages: StageRow[] = [];
  const artifacts: StoredArtifact[] = [];
  const runs = new Map<Id, StoredRun>();
  const questions = new Map<Id, Question>();
  const approvals = new Map<Id, StoredApproval>();
  const breakdown = new Map<Id, StoredBreakdownItem>();
  /** `runs.lease_owner` / `lease_expires_at`, which this store keeps beside the row (WP-47). */
  const leases = new Map<Id, { owner: string; expiresAt: IsoDateTime }>();
  const chargedRuns = new Set<Id>();
  let sequence = 0;

  /**
   * A read of a task row, with `task.sequence` reconciled against the event log (divergence 7).
   *
   * The **maximum** of the two, never a replacement: the log's answer is right after an out-of-band
   * append, and the aggregate's is right inside a transaction whose own appends are still staged.
   */
  const readTask = (stored: StoredTask): StoredTask => {
    const copy = clone(stored);
    const fromLog = options.streamSequence?.(stored.task.id);
    return fromLog === undefined || fromLog <= copy.task.sequence
      ? copy
      : { ...copy, task: { ...copy.task, sequence: fromLog } };
  };

  const taskRepository: TaskRepository = {
    load: async (_tx, taskId) => {
      const stored = tasks.get(taskId);
      return stored === undefined ? null : readTask(stored);
    },
    findByTicket: async (_tx, query) => {
      const found = [...tasks.values()].find(
        (stored) =>
          stored.task.projectId === query.projectId &&
          stored.task.ticket.provider === query.provider &&
          stored.task.ticket.key === query.ticketKey &&
          stored.task.mode === query.mode,
      );
      return found === undefined ? null : readTask(found);
    },
    findByMergeRequest: async (_tx, query) => {
      const found = [...tasks.values()].find(
        (stored) => stored.task.projectId === query.projectId && stored.mr?.iid === query.iid,
      );
      return found === undefined ? null : readTask(found);
    },
    listAtStage: async (_tx, projectId, stage) =>
      [...tasks.values()]
        .filter(
          (stored) => stored.task.projectId === projectId && stored.task.currentStage === stage,
        )
        .map(readTask),
    listWithMergeRequest: async (_tx, projectId, query) =>
      [...tasks.values()]
        .filter(
          (stored) =>
            stored.task.projectId === projectId &&
            stored.task.id !== query.excludeTaskId &&
            stored.mr !== null &&
            stored.task.state !== 'done' &&
            stored.task.state !== 'cancelled',
        )
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .slice(0, Math.max(query.limit, 0))
        .map(readTask),
    countCompleted: async (_tx, projectId) =>
      [...tasks.values()].filter(
        (stored) => stored.task.projectId === projectId && stored.task.state === 'done',
      ).length,
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
     * does **not** list (`workpad`, `ticketSnapshot`, `ticketSnapshotAt`, `reviewSubject`,
     * `riskClasses` (WP-37), `coverage` (WP-39), `dependencies` and `requiredReviewers` (WP-38),
     * `costActualUsd` (WP-31: `addSpend` owns it),
     * `estimateUsd`, `estimateBasis`, `estimateSamples`, `priorityRank`, `createdAt`, `template`)
     * belong to the narrow writers — or, for
     * `reviewSubject`, to the insert alone (WP-24) — and a fake that let a
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
        version: current.version + 1,
      };
      tasks.set(stored.task.id, clone(written));
      // The caller's own snapshot at the new version, so a second save in the same unit is not a
      // conflict with the first: `{ ...stored }` rather than `{ ...current }`, because the columns
      // this write ignored are the store's and the ones it took are the caller's. `costActualUsd`
      // is the store's since WP-31, so it comes back from `written` rather than from the caller.
      return clone({ ...stored, costActualUsd: written.costActualUsd, version: written.version });
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
    saveRiskClasses: async (_tx, taskId, classes) => {
      const current = tasks.get(taskId);
      if (current === undefined) {
        throw new PipelineStoreError(`task ${taskId} does not exist`);
      }
      // Only this field, and the whole list every time — the same statement the SQL adapter writes
      // (WP-37): the rebase gate is re-entered on every default-branch move, and a class the merge
      // request no longer touches has to leave the row.
      tasks.set(taskId, clone({ ...current, riskClasses: [...classes] }));
    },
    saveCoverage: async (_tx, taskId, coverage) => {
      const current = tasks.get(taskId);
      if (current === undefined) {
        throw new PipelineStoreError(`task ${taskId} does not exist`);
      }
      // Only this field, the whole record, and **parsed** — for the reason `saveWorkpad` is (WP-15h
      // and standing rule 1): `jsonb` accepts any document, the SQL adapter refuses one the
      // published shape cannot describe, and a fake that accepted it would launder the defect into
      // a pass in every tier that drives this store.
      tasks.set(taskId, clone({ ...current, coverage: taskCoverageSchema.parse(coverage) }));
    },
    saveDependencies: async (_tx, taskId, dependencies) => {
      const current = tasks.get(taskId);
      if (current === undefined) {
        throw new PipelineStoreError(`task ${taskId} does not exist`);
      }
      // Only this field, the whole record, and **parsed** — the reason `saveCoverage` is (WP-15h,
      // standing rule 1). The gate runs once per implementation completion and the packages, the
      // decision and the question it opened are one statement about one diff.
      tasks.set(
        taskId,
        clone({ ...current, dependencies: taskDependenciesSchema.parse(dependencies) }),
      );
    },
    saveRequiredReviewers: async (_tx, taskId, reviewers) => {
      const current = tasks.get(taskId);
      if (current === undefined) {
        throw new PipelineStoreError(`task ${taskId} does not exist`);
      }
      tasks.set(
        taskId,
        clone({ ...current, requiredReviewers: taskReviewersSchema.parse(reviewers) }),
      );
    },
    addSpend: async (_tx, taskId, usd) => {
      const current = tasks.get(taskId);
      if (current === undefined) {
        throw new PipelineStoreError(`task ${taskId} does not exist`);
      }
      if (!Number.isFinite(usd) || usd < 0) {
        // Stricter than production is the direction a fake may take (standing rule 1); the SQL
        // adapter refuses the same value with the same sentence.
        throw new RangeError(
          `cannot add ${String(usd)} USD to task ${taskId}: spend is finite and non-negative`,
        );
      }
      tasks.set(taskId, clone({ ...current, costActualUsd: current.costActualUsd + usd }));
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
      // The three write-only columns of `NewRun` are **dropped**, for the same rule-1 reason the
      // stage link is narrowed: the SQL adapter's `load` does not select `system_prompt`,
      // `user_prompt` or `redaction_count`, so keeping them here would let a test read back a
      // prompt no production caller of `load` can see. The reader that wants them is the API
      // projection, and it has its own integration coverage.
      const { systemPrompt: _s, userPrompt: _u, redactionCount: _r, ...stored } = run;
      runs.set(run.id, clone({ ...stored, stage: linked ? run.stage : null }));
    },
    /** Conditional on the run still being live, exactly as the SQL adapter's `where` clause is. */
    finish: async (_tx, outcome) => {
      const run = runs.get(outcome.runId);
      if (run === undefined) {
        throw new PipelineStoreError(`run ${outcome.runId} does not exist`);
      }
      if (!isActiveRunStatus(run.status)) {
        return false;
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
      return true;
    },
    /**
     * The late cost write (WP-47), with the SQL adapter's three predicates spelled out.
     *
     * The fake refuses everything the database refuses and nothing more (standing rule 1): a live
     * run, a row that already carries a figure, and — the one this store cannot see — a run the
     * ledger has already charged, which it asks the caller about through {@link chargedRuns}. A
     * fake that answered `true` where PostgreSQL answers `false` would launder a double charge into
     * a pass.
     */
    recordCost: async (_tx, late) => {
      const run = runs.get(late.runId);
      if (run === undefined) {
        throw new PipelineStoreError(`run ${late.runId} does not exist`);
      }
      if (isActiveRunStatus(run.status) || run.cost !== null || chargedRuns.has(late.runId)) {
        return false;
      }
      runs.set(late.runId, {
        ...run,
        sessionId: run.sessionId ?? late.sessionId,
        numTurns: Math.max(run.numTurns, late.numTurns),
        usage: late.usage,
        cost: late.cost,
        wallMs: Math.max(run.wallMs, late.wallMs),
      });
      return true;
    },
    /** Conditional on the run being live and on the lease being unheld or this owner's. */
    renewLease: async (_tx, lease) => {
      const run = runs.get(lease.runId);
      if (run === undefined || !isActiveRunStatus(run.status)) {
        return false;
      }
      const held = leases.get(lease.runId);
      if (held !== undefined && held.owner !== lease.owner) {
        return false;
      }
      leases.set(lease.runId, { owner: lease.owner, expiresAt: lease.expiresAt });
      return true;
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
    latestOfKind: async (_tx, query) => {
      // The SQL's `order by requested_at desc, id desc limit 1`, spelled out: a fake clock gives
      // every approval of one test the same `requestedAt`, so the tie-break is not decoration — it
      // is what keeps this answer and PostgreSQL's the same one (standing rule 1).
      const matching = [...approvals.values()]
        .filter(
          (stored: StoredApproval) =>
            stored.approval.taskId === query.taskId && stored.approval.kind === query.kind,
        )
        .sort((left, right) =>
          left.approval.requestedAt === right.approval.requestedAt
            ? right.approval.id.localeCompare(left.approval.id)
            : right.approval.requestedAt.localeCompare(left.approval.requestedAt),
        );
      const found = matching[0];
      return found === undefined ? null : clone(found);
    },
  };

  /**
   * WP-40's epic-split queue.
   *
   * `decide` filters on `status === 'queued'` here exactly as the SQL's `where status = 'queued'`
   * does, because that predicate is the race two maintainers deciding the same child lose to — a
   * fake that decided an already-decided row would be **kinder** than the adapter, which is the one
   * direction a fake may never take (standing rule 1).
   *
   * It answers the moved rows **as they now are** and adds the reason's redaction count to each,
   * which is what the adapter does and what the contract suite holds both of them to: the adapter's
   * first version answered them as they *were*, because a data-modifying CTE is invisible to the
   * rest of its own statement, and this fake was the kinder of the two (WP-40 round 2).
   */
  const breakdownRepository: BreakdownRepository = {
    insert: async (_tx, items) => {
      for (const item of items) {
        breakdown.set(item.id, clone(item));
      }
    },
    listForTask: async (_tx, taskId) =>
      [...breakdown.values()]
        .filter((item) => item.taskId === taskId)
        .sort((left, right) => left.position - right.position)
        .map(clone),
    decide: async (_tx, input) => {
      const moved: StoredBreakdownItem[] = [];
      for (const itemId of input.itemIds) {
        const current = breakdown.get(itemId);
        if (current === undefined || current.taskId !== input.taskId) {
          continue;
        }
        if (current.status !== 'queued') {
          continue;
        }
        const next: StoredBreakdownItem = {
          ...current,
          status: input.status,
          decidedByUserId: input.decidedByUserId,
          decidedAt: input.decidedAt,
          reason: input.reason,
          redactionCount: current.redactionCount + input.reasonRedactions,
        };
        breakdown.set(itemId, next);
        moved.push(clone(next));
      }
      return moved.sort((left, right) => left.position - right.position);
    },
    recordTicket: async (_tx, input) => {
      const current = breakdown.get(input.itemId);
      if (current === undefined) {
        throw new PipelineStoreError(`breakdown item ${input.itemId} does not exist`);
      }
      breakdown.set(input.itemId, {
        ...current,
        ticketKey: input.ticketKey,
        ticketUrl: input.ticketUrl,
      });
    },
  };

  return {
    tasks: taskRepository,
    artifacts: artifactRepository,
    runs: runRepository,
    questions: questionRepository,
    approvals: approvalRepository,
    breakdown: breakdownRepository,
    writeEstimate: (taskId, estimate) => {
      const current = tasks.get(taskId);
      if (current === undefined) {
        throw new PipelineStoreError(`task ${taskId} does not exist`);
      }
      tasks.set(
        taskId,
        clone({
          ...current,
          task: { ...current.task },
          estimateUsd: estimate.estimateUsd,
          estimateBasis: estimate.basis,
          estimateSamples: estimate.samples,
        }),
      );
    },
    chargedRuns,
    leaseOf: (runId) => {
      const held = leases.get(runId);
      return held === undefined ? null : { ...held };
    },
    snapshot: () => [...tasks.values()].map(clone),
    get stageRows() {
      return stages.map((row) => ({ ...row }));
    },
  };
};

export type { Approval, Question };

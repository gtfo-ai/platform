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
 * | 8 | `takenOver` reads the **committed** log through {@link MemoryPipelineStoreOptions.taskEvents}; PostgreSQL's query also sees the calling transaction's own staged appends (WP-56). Unwired, it answers `null`; its `lastActivityAt` reads {@link MemoryPipelineStoreOptions.humanActions} (WP-44), and unwired that is the take-over's own instant. | **same, when wired; kinder by one window** | Both readers of it — the workpad render and the take-over timer — run in a job's **own** transaction after the events they react to have committed, so the window this cannot see is one neither reader stands in. A caller that asked inside the transaction that appended the take-over would get `null` here and the record from PostgreSQL; nothing does, and the contract suite drives the committed case against both. |
 * | 9 | `runCommands` (WP-85): `lockRun`/`lockLiveRunOf`/`markApplied` take no lock, `admitSteer` (WP-101) takes no advisory lock and reads `created_at` off {@link MemoryPipelineStoreOptions.now} rather than the database's clock, and `LockedRun.sessionId` is the run row's `sessionId` where PostgreSQL reads the run's `system`/`init` transcript entry (this store keeps no transcript). | **kinder** on ordering, **same** on predicates | The `for share` ordering between a command and the run's ending is a property of two concurrent transactions, which a single-threaded store cannot interleave; it is asserted against PostgreSQL in `test/integration/pipeline/run-commands.integration.test.ts`, both orders — and the steer window's lock there by a second transaction that must wait (WP-101). Every predicate — live run, this owner's lease, still pending, closed `run_ended` by the winning `finish` — is the SQL's, and the contract suite drives each against both stores. |
 * | 10 | `bugTraces.latest` (WP-90) reads the **committed** project log through {@link MemoryPipelineStoreOptions.projectEvents}, in stream order; PostgreSQL orders by `occurred_at` then `position` and also sees the calling transaction's own staged appends. Unwired, it answers `null`. | **same, when wired** | Its one caller, the `ticket.updated` handler, asks in the dispatcher's transaction about traces an earlier job committed; a trace appended in the asking transaction does not exist, because no handler appends one. Stream order and `occurred_at` order agree for every trace the duty writes, which appends with the platform clock in sequence. The contract suite drives both. |
 */
import type {
  ArtifactType,
  DomainEvent,
  EstimateBasis,
  Id,
  IsoDateTime,
  Size,
  Slug,
  TaskStageState,
} from '@platform/contracts';
import {
  taskCoverageSchema,
  taskDependenciesSchema,
  taskReviewersSchema,
  taskReviewThreadsSchema,
  taskStageExitStateSchema,
  taskStageOutcomeSchema,
  taskStageStateSchema,
  workpadRefSchema,
} from '@platform/contracts';
import type { Approval, Question, QueuedTask } from '@platform/domain';
import {
  countsAsActive,
  countsInPipeline,
  isActiveRunStatus,
  isTerminalTaskState,
} from '@platform/domain';
import { holdOf } from '../cost/pending.js';
import type {
  ApprovalRepository,
  ArtifactRepository,
  BreakdownRepository,
  BugTraceRepository,
  PipelineStore,
  QuestionRepository,
  RunCommandInstruction,
  RunCommandRefusal,
  RunCommandRepository,
  RunRepository,
  StoredApproval,
  StoredArtifact,
  StoredBreakdownItem,
  StoredRun,
  StoredTask,
  SupersededMergeRequest,
  SupersededMergeRequestOutcome,
  TaskRepository,
} from '../pipeline/store.js';
import {
  STOPPING_RUN_COMMAND_KINDS,
  TAKE_OVER_BOUNDARY_EVENTS,
  TaskConcurrentModificationError,
} from '../pipeline/store.js';
import type {
  DeadlineRecoveryStore,
  HeldTask,
  UnremindedAggregate,
  WaitingAggregate,
} from '../recovery/deadline.js';
import type { SupersededMergeRequestRecoveryStore } from '../recovery/superseded-mr.js';

export class PipelineStoreError extends Error {
  override readonly name = 'PipelineStoreError';
}

interface StageRow {
  taskId: Id;
  stage: Slug;
  attempt: number;
  /** `taskStageStateSchema`'s vocabulary, parsed on the way in exactly as the SQL store does. */
  state: TaskStageState;
  outcome: string | null;
  /** The stage a return targeted (WP-55); null on every row that is not a return. */
  returnedTo: Slug | null;
  returnReason: string | null;
  /** The uncut length of `returnReason`, when its writer cut it (WP-81, migration 0058). */
  returnReasonOriginalChars: number | null;
  signature: string | null;
  enteredAt: number;
  exitedAt: number | null;
}

const clone = <T>(value: T): T => structuredClone(value);

/**
 * An ended run nobody measured — the SQL adapter's `unmeasuredEndedRunSql` over this store's rows:
 * terminal, and no figure (`cost` null is both columns null, `finish` writing one or the other).
 */
const endedUnmeasured = (run: StoredRun, floors: ReadonlySet<Id>): boolean =>
  !isActiveRunStatus(run.status) && (run.cost === null || floors.has(run.id));

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
  /** The deadline recovery's store over these rows (WP-56 round 2, `recovery/deadline.ts`). */
  readonly deadlineRecovery: DeadlineRecoveryStore;
  /**
   * The superseded-merge-request recovery's store over this store's rows (WP-59 review round 1,
   * `recovery/superseded-mr.ts`) — the twin of `postgres-superseded-mr-store.ts`'s query.
   */
  readonly supersededRecovery: SupersededMergeRequestRecoveryStore;
  /** Every `superseded_merge_requests` row, for a test that asserts what the duty settled. */
  supersededRows(): readonly MemorySupersededRow[];
  /** The lease a run currently holds, for a test that asserts the heartbeat wrote one (WP-47). */
  leaseOf(runId: Id): { readonly owner: string; readonly expiresAt: IsoDateTime } | null;
  /** Every `run_commands` row, for a test that asserts what the holder stamped (WP-85). */
  runCommandRows(): readonly MemoryRunCommandRow[];
}

/** One `run_commands` row as this store keeps it (migration 0060). */
export interface MemoryRunCommandRow {
  readonly id: Id;
  readonly runId: Id;
  readonly taskId: Id;
  readonly actorUserId: Id | null;
  readonly instruction: RunCommandInstruction;
  readonly sequence: number;
  readonly applied: boolean;
  readonly refusedReason: RunCommandRefusal | null;
  /** `created_at`, in milliseconds by {@link MemoryPipelineStoreOptions.now} — the steer window reads it. */
  readonly createdAtMs: number;
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
  /**
   * A task's committed events in stream order — what `TaskRepository.takenOver` reads (WP-56).
   *
   * Optional for {@link streamSequence}'s reason. **Unwired, `takenOver` answers `null`**, which is
   * the pre-WP-56 behaviour of every render that was not woken by `task.taken_over` itself and is
   * divergence 8 below: a store built without the log cannot say a human holds a task, and it says
   * *nobody does* rather than inventing one. `createPipelineHarness` wires it.
   */
  readonly taskEvents?: (taskId: Id) => readonly DomainEvent[];
  /**
   * The `human_actions` rows of a task, for `takenOver`'s activity rule (WP-44). PostgreSQL reads
   * the table; the harness has none, so a test that wants a holder's command to count wires this.
   */
  readonly humanActions?: (
    taskId: Id,
  ) => readonly { readonly userId: Id; readonly at: IsoDateTime }[];
  /**
   * A project's committed events in stream order — what `bugTraces.latest` reads (WP-90).
   *
   * Optional for {@link streamSequence}'s reason. **Unwired, `latest` answers `null`** — divergence
   * 10: a store built without the log has seen no trace, and says so rather than inventing one.
   * `createPipelineHarness` wires it.
   */
  readonly projectEvents?: (projectId: Id) => readonly DomainEvent[];
  /**
   * The clock `run_commands.created_at` is stamped by and the steer window reads (WP-101) — the
   * database's `now()` in PostgreSQL. Defaults to `Date.now`.
   */
  readonly now?: () => number;
}

/** One `superseded_merge_requests` row, as the memory store keeps it. */
export interface MemorySupersededRow extends SupersededMergeRequest {
  readonly settledAt: IsoDateTime | null;
  readonly outcome: SupersededMergeRequestOutcome | null;
  readonly detail: string | null;
  readonly recoveryAttemptedAt: IsoDateTime | null;
}

export const createMemoryPipelineStore = (
  options: MemoryPipelineStoreOptions = {},
): MemoryPipelineStore => {
  const tasks = new Map<Id, StoredTask>();
  /** `superseded_merge_requests`, keyed `(task_id, iid)` like its primary key (migration 0043). */
  const superseded = new Map<string, MemorySupersededRow>();
  const supersededKey = (taskId: Id, iid: number): string => `${taskId}#${iid}`;
  const stages: StageRow[] = [];
  const artifacts: StoredArtifact[] = [];
  const runs = new Map<Id, StoredRun>();
  /** `tasks.budget_cap_usd` (WP-131 review round 1): not on `StoredTask`, as `save` never names it. */
  const budgetCaps = new Map<Id, number>();
  /** `runs.reserve_usd` (WP-131): write-only on `NewRun`, so kept beside the row, as the SQL keeps it. */
  const reserves = new Map<Id, number | null>();
  /** `runs.figure_is_floor` (WP-131 pre-review round, backlog 407): the runs whose cost is a floor. */
  const floors = new Set<Id>();
  const questions = new Map<Id, Question>();
  const approvals = new Map<Id, StoredApproval>();
  const breakdown = new Map<Id, StoredBreakdownItem>();
  /** `runs.lease_owner` / `lease_expires_at`, which this store keeps beside the row (WP-47). */
  const leases = new Map<Id, { owner: string; expiresAt: IsoDateTime }>();
  /** `run_commands` (WP-85), insertion-ordered like the SQL's `created_at, id`. */
  const runCommandRows = new Map<Id, MemoryRunCommandRow>();
  let runCommandSequence = 0;
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

  /** `tasks.mr_head_at` (migration 0044) — the provider's instant of the recorded head. */
  const mrHeadAt = new Map<Id, string>();

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
      // `ticketSignalAt` is not the insert's (WP-60): the SQL insert does not name the column, so a
      // row is born with none whatever the caller's snapshot carried — and a fake that kept it would
      // answer a question PostgreSQL cannot be asked (standing rule 1). `reviewThreads` is the same
      // case (WP-46): only `saveReviewThreads` writes the column, and so is `readyHeadSha` (WP-79):
      // only `saveReadyHead` writes it, so a row is born with none.
      tasks.set(
        stored.task.id,
        clone({
          ...stored,
          ticketSignalAt: null,
          reviewThreads: null,
          readyHeadSha: null,
          ciHeadSha: null,
          ciExcusedPaths: [],
          // The SQL column is `not null default false` (migration 0066).
          settingsRefreezePending: stored.settingsRefreezePending === true,
          refreezeRouting: stored.refreezeRouting ?? null,
        }),
      );
    },
    /**
     * The same columns the SQL `update tasks set …` names, and the same optimistic check (WP-15e).
     *
     * Written as a projection of `current` rather than as `clone(stored)` on purpose: the fields it
     * does **not** list (`workpad`, `ticketSnapshot`, `ticketSnapshotAt`, `reviewSubject`,
     * `riskClasses` (WP-37), `coverage` (WP-39), `dependencies` and `requiredReviewers` (WP-38),
     * `reviewThreads` (WP-46), `readyHeadSha` and `ciHeadSha` (WP-79), `ciExcusedPaths` (WP-102),
     * `costActualUsd` (WP-31: `addSpend` owns it),
     * `estimateUsd`, `estimateBasis`, `estimateSamples`, `priorityRank`, `createdAt`, `template`,
     * `pipelineDial` (WP-62)) belong to the narrow writers — or, for `reviewSubject` and
     * `pipelineDial`, to the insert alone (WP-24, WP-62) — and a fake that let a
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
    recordSupersededMergeRequest: async (_tx, record) => {
      // The SQL's `on conflict (task_id, iid) do update`: the latest supersession, unsettled again.
      superseded.set(supersededKey(record.taskId, record.mr.iid), {
        ...clone(record),
        settledAt: null,
        outcome: null,
        detail: null,
        recoveryAttemptedAt: null,
      });
    },
    settleSupersededMergeRequest: async (_tx, input) => {
      const key = supersededKey(input.taskId, input.iid);
      const row = superseded.get(key);
      // `where settled_at is null`: the first ending is the one that happened.
      if (row === undefined || row.settledAt !== null) {
        return;
      }
      superseded.set(key, {
        ...row,
        settledAt: input.at,
        outcome: input.outcome,
        detail: input.detail ?? null,
      });
    },
    bumpVersion: async (_tx, taskId) => {
      const current = tasks.get(taskId);
      if (current === undefined) {
        throw new PipelineStoreError(`task ${taskId} does not exist`);
      }
      // Only the token, like the SQL `update tasks set version = version + 1` (WP-59 round 1).
      tasks.set(taskId, clone({ ...current, version: current.version + 1 }));
    },
    recordTicketSignal: async (_tx, signal) => {
      let moved = 0;
      for (const [id, current] of tasks) {
        if (
          current.task.projectId !== signal.projectId ||
          current.task.ticket.provider !== signal.provider ||
          current.task.ticket.key !== signal.ticketKey ||
          current.task.state === 'done' ||
          current.task.state === 'cancelled'
        ) {
          continue;
        }
        // `greatest(coalesce(ticket_signal_at, $at), $at)`: never backwards (WP-60).
        const at =
          current.ticketSignalAt !== null && current.ticketSignalAt >= signal.at
            ? current.ticketSignalAt
            : signal.at;
        tasks.set(id, clone({ ...current, ticketSignalAt: at }));
        moved += 1;
      }
      return moved;
    },
    saveMergeRequestHead: async (_tx, taskId, head) => {
      const current = tasks.get(taskId);
      if (current === undefined) {
        throw new PipelineStoreError(`task ${taskId} does not exist`);
      }
      const recordedAt = mrHeadAt.get(taskId);
      if (
        current.mr === null ||
        current.mr.iid !== head.iid ||
        current.task.state === 'done' ||
        current.task.state === 'cancelled' ||
        (recordedAt !== undefined && Date.parse(recordedAt) >= Date.parse(head.at))
      ) {
        return false;
      }
      // `tasks.mr_head_at`, which `StoredTask` does not carry: forward only, like the SQL.
      mrHeadAt.set(taskId, head.at);
      if (current.mr.head_sha === head.headSha) {
        return false;
      }
      // One key of `mr_ref` and the token, like the SQL's `jsonb_set(…)`, `version + 1` (WP-60).
      tasks.set(
        taskId,
        clone({
          ...current,
          mr: { ...current.mr, head_sha: head.headSha },
          version: current.version + 1,
        }),
      );
      return true;
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
    saveReadyHead: async (_tx, taskId, headSha) => {
      const current = tasks.get(taskId);
      if (current === undefined) {
        throw new PipelineStoreError(`task ${taskId} does not exist`);
      }
      // Only this field, and `null` as readily as a head — the SQL adapter's statement (WP-79).
      tasks.set(taskId, clone({ ...current, readyHeadSha: headSha }));
    },
    refreezeSettings: async (_tx, taskId, frozen) => {
      const current = tasks.get(taskId);
      if (current === undefined) {
        throw new PipelineStoreError(`task ${taskId} does not exist`);
      }
      // The three columns the SQL adapter's one statement writes (WP-106), and no version bump.
      tasks.set(
        taskId,
        clone({
          ...current,
          task: { ...current.task, limits: frozen.limits, template: frozen.templateId },
          template: frozen.template,
          pipelineDial: frozen.pipelineDial,
          settingsRefreezePending: false,
          refreezeRouting: null,
        }),
      );
    },
    saveCiSettlement: async (_tx, taskId, settlement) => {
      const current = tasks.get(taskId);
      if (current === undefined) {
        throw new PipelineStoreError(`task ${taskId} does not exist`);
      }
      // Both columns, as the SQL adapter's one statement writes them (WP-102).
      tasks.set(
        taskId,
        clone({
          ...current,
          ciHeadSha: settlement.headSha,
          ciExcusedPaths: [...settlement.excusedPaths],
        }),
      );
    },
    saveRequester: async (_tx, taskId, userId) => {
      const current = tasks.get(taskId);
      if (current === undefined) {
        throw new PipelineStoreError(`task ${taskId} does not exist`);
      }
      // Fill, never overwrite — the SQL's `where requested_by_user_id is null` (WP-79).
      if (current.requestedByUserId !== null) {
        return false;
      }
      tasks.set(taskId, clone({ ...current, requestedByUserId: userId }));
      return true;
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
    saveReviewThreads: async (_tx, taskId, threads) => {
      const current = tasks.get(taskId);
      if (current === undefined) {
        throw new PipelineStoreError(`task ${taskId} does not exist`);
      }
      tasks.set(
        taskId,
        clone({ ...current, reviewThreads: taskReviewThreadsSchema.parse(threads) }),
      );
    },
    /** The SQL store's read over the harness's log: the newest `task.paused` decides. */
    pausedBudgetScope: async (_tx, taskId) => {
      const newest = (options.taskEvents?.(taskId) ?? [])
        .filter((event) => event.type === 'task.paused')
        .at(-1);
      if (
        newest === undefined ||
        newest.type !== 'task.paused' ||
        newest.payload.reason !== 'budget'
      ) {
        return null;
      }
      return newest.payload.budget_scope ?? null;
    },
    budgetCap: async (_tx, taskId) => {
      if (!tasks.has(taskId)) {
        throw new PipelineStoreError(`task ${taskId} does not exist`);
      }
      return budgetCaps.get(taskId) ?? null;
    },
    raiseBudgetCap: async (_tx, input) => {
      if (!tasks.has(input.taskId)) {
        throw new PipelineStoreError(`task ${input.taskId} does not exist`);
      }
      const previousCapUsd = budgetCaps.get(input.taskId) ?? input.defaultCapUsd;
      if (!(input.capUsd > previousCapUsd)) {
        return { raised: false, previousCapUsd };
      }
      budgetCaps.set(input.taskId, input.capUsd);
      return { raised: true, previousCapUsd };
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
        state: taskStageStateSchema.parse('running'),
        outcome: null,
        returnedTo: null,
        returnReason: null,
        returnReasonOriginalChars: null,
        signature: null,
        enteredAt: sequence,
        exitedAt: null,
      });
    },
    recordStageExited: async (_tx, entry) => {
      const state = taskStageExitStateSchema.parse(entry.state);
      // Parsed before anything moves, as the SQL store parses before its statement (WP-73).
      const outcome = taskStageOutcomeSchema.parse(entry.outcome);
      if ((state === 'returned') !== (entry.returnedTo !== null)) {
        throw new PipelineStoreError(
          `task_stages ${entry.taskId}/${entry.stage}#${String(entry.attempt)}: state "${state}" with returned_to ${JSON.stringify(entry.returnedTo)} — a return names its target and nothing else does`,
        );
      }
      sequence += 1;
      const row = [...stages]
        .reverse()
        .find(
          (candidate) =>
            candidate.taskId === entry.taskId &&
            candidate.stage === entry.stage &&
            candidate.attempt === entry.attempt,
        );
      const originalChars = entry.returnReasonOriginalChars ?? null;
      // The SQL check `task_stages_return_reason_original_chars_positive`, and a cut only means
      // anything beside a reason (migration 0058).
      if (
        originalChars !== null &&
        (!Number.isInteger(originalChars) || originalChars <= 0 || entry.returnReason === null)
      ) {
        throw new PipelineStoreError(
          `task_stages ${entry.taskId}/${entry.stage}#${String(entry.attempt)}: return_reason_original_chars ${String(originalChars)} is not a positive length beside a reason`,
        );
      }
      if (row === undefined) {
        return;
      }
      row.state = state;
      row.outcome = outcome;
      row.returnReason = entry.returnReason;
      row.returnReasonOriginalChars = originalChars;
      row.returnedTo = entry.returnedTo;
      row.exitedAt = sequence;
    },
    /** The SQL's `where state = 'running'`, and nothing for a row that is closed (WP-46). */
    closeOpenStage: async (_tx, entry) => {
      const outcome = taskStageOutcomeSchema.parse(entry.outcome);
      const row = [...stages]
        .reverse()
        .find(
          (candidate) =>
            candidate.taskId === entry.taskId &&
            candidate.stage === entry.stage &&
            candidate.attempt === entry.attempt,
        );
      if (row === undefined || row.state !== 'running') {
        return;
      }
      sequence += 1;
      row.state = taskStageExitStateSchema.parse('failed');
      row.outcome = outcome;
      row.returnReason = entry.reason;
      row.returnReasonOriginalChars = null;
      row.returnedTo = null;
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
          state: taskStageStateSchema.parse('running'),
          outcome: null,
          returnedTo: null,
          returnReason: null,
          returnReasonOriginalChars: null,
          signature: entry.signature,
          enteredAt: sequence,
          exitedAt: null,
        });
        return;
      }
      row.signature = entry.signature;
    },
    stageAttemptState: async (_tx, taskId, stage, attempt) => {
      const row = stages.find(
        (candidate) =>
          candidate.taskId === taskId && candidate.stage === stage && candidate.attempt === attempt,
      );
      if (row === undefined) return 'absent';
      return row.state === 'running' && row.exitedAt === null ? 'open' : 'closed';
    },
    recentStageSignatures: async (_tx, taskId, stage, limit) =>
      stages
        .filter((row) => row.taskId === taskId && row.stage === stage && row.signature !== null)
        .sort((a, b) => a.attempt - b.attempt)
        .slice(-limit)
        .map((row) => row.signature as string),
    takenOver: async (_tx, taskId) => {
      // The SQL store's rule over the harness's log: the newest boundary event decides.
      const boundary: readonly string[] = TAKE_OVER_BOUNDARY_EVENTS;
      const newest = (options.taskEvents?.(taskId) ?? [])
        .filter((event) => boundary.includes(event.type))
        .at(-1);
      if (newest === undefined || newest.type !== 'task.taken_over') {
        return null;
      }
      const holder = newest.actor.kind === 'user' ? newest.actor.user_id : null;
      // The SQL store's activity rule (WP-44): the holder's own `human_actions` rows after the
      // take-over. Unwired, the take-over's own instant is the answer — divergence 8's shape.
      const lastAction = (options.humanActions?.(taskId) ?? [])
        .filter((row) => holder !== null && row.userId === holder && row.at > newest.occurred_at)
        .map((row) => row.at)
        .sort()
        .at(-1);
      return {
        eventId: newest.id,
        at: newest.occurred_at,
        branch: newest.payload.branch,
        sessionId: newest.payload.session_id ?? null,
        stage: newest.payload.stage,
        holderUserId: holder,
        lastActivityAt: lastAction ?? newest.occurred_at,
      };
    },
    lastReturnReason: async (_tx, taskId, stage, attempt) => {
      // The SQL store's rule, over the write sequence where the SQL uses `clock_timestamp()`.
      const previous = stages
        .filter((row) => row.taskId === taskId && row.stage === stage && row.attempt < attempt)
        // A return to this very stage counts by its entry: its exit is the return itself.
        .map((row) => (row.returnedTo === stage ? row.enteredAt : (row.exitedAt ?? row.enteredAt)))
        .reduce<number | null>((max, at) => (max === null || at > max ? at : max), null);
      const current = stages.find(
        (row) => row.taskId === taskId && row.stage === stage && row.attempt === attempt,
      )?.enteredAt;
      const found = stages
        .filter(
          (row) =>
            row.taskId === taskId &&
            row.returnedTo === stage &&
            row.returnReason !== null &&
            row.exitedAt !== null &&
            (previous === null || row.exitedAt > previous) &&
            (current === undefined || row.exitedAt <= current),
        )
        .sort((a, b) => (a.exitedAt ?? 0) - (b.exitedAt ?? 0))
        .at(-1);
      if (found === undefined || found.returnReason === null) {
        return null;
      }
      // WP-83: the artifact a run of the returning attempt produced, linked as the SQL store links
      // it (`runs.task_stage_id`, here the run's own stage and attempt).
      const producers = [...runs.values()]
        .filter(
          (run) =>
            run.taskId === taskId && run.stage === found.stage && run.attempt === found.attempt,
        )
        .map((run) => run.id);
      const cause = artifacts
        .filter(
          (artifact) =>
            artifact.taskId === taskId &&
            // The SQL store's filter: only a verdict returns a task.
            (artifact.type === 'ReviewVerdict' || artifact.type === 'AcceptanceVerdict') &&
            artifact.producedByRunId !== null &&
            producers.includes(artifact.producedByRunId),
        )
        .sort((a, b) => b.version - a.version)[0];
      return {
        reason: found.returnReason,
        originalChars: found.returnReasonOriginalChars,
        ...(cause === undefined ? {} : { cause: { type: cause.type, version: cause.version } }),
      };
    },
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
      // The write-only columns of `NewRun` are **dropped**, for the same rule-1 reason the
      // stage link is narrowed: the SQL adapter's `load` does not select `system_prompt`,
      // `user_prompt` or `redaction_count`, so keeping them here would let a test read back a
      // prompt no production caller of `load` can see. The reader that wants them is the API
      // projection, and it has its own integration coverage.
      // `contextPack` (WP-57) is dropped for the same reason: `load` answers no pack, and the
      // reader that wants one is the API projection over `run_context_pack`. `settings` (WP-91)
      // likewise: `load` does not select `settings_snapshot`/`settings_hash`.
      const {
        systemPrompt: _s,
        userPrompt: _u,
        redactionCount: _r,
        contextPack: _c,
        settings: _g,
        // WP-121: write-only too — the API projection reads `runs.prompts_withheld`, `load` does not.
        promptsWithheld: _w,
        reserveUsd,
        ...stored
      } = run;
      runs.set(run.id, clone({ ...stored, stage: linked ? run.stage : null }));
      // The SQL adapter's `nullif(…, 0)`: the column refuses a zero, so a stage admitted at no cap
      // records none, and is held at the admitting reserve (WP-131).
      reserves.set(run.id, reserveUsd === null || reserveUsd === 0 ? null : reserveUsd);
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
      if (outcome.costIsFloor === true) {
        floors.add(outcome.runId);
      }
      // The winner closes the run's pending commands, as the SQL adapter does in the same
      // transaction (WP-85).
      for (const row of runCommandRows.values()) {
        if (row.runId === outcome.runId && !row.applied && row.refusedReason === null) {
          runCommandRows.set(row.id, { ...row, refusedReason: 'run_ended' });
        }
      }
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
      if (late.costIsFloor === true) {
        floors.add(late.runId);
      }
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
        isEstimate: owned.some((run) => run.cost?.is_estimate === true && !floors.has(run.id)),
        unmeasuredRuns: owned.filter((run) => endedUnmeasured(run, floors)).length,
        wallMs: owned.reduce((total, run) => total + run.wallMs, 0),
      };
    },
    /** The task cap's hold (WP-131), over this store's rows with the SQL adapter's predicate. */
    heldFor: async (_tx, taskId, admittingReserveUsd) =>
      holdOf(
        [...runs.values()]
          .filter((run) => run.taskId === taskId && endedUnmeasured(run, floors))
          .map((run) => reserves.get(run.id) ?? null),
        admittingReserveUsd,
      ),
  };

  const lockedRunOf = (run: StoredRun) => ({
    runId: run.id,
    taskId: run.taskId,
    status: run.status,
    leaseOwner: leases.get(run.id)?.owner ?? null,
    leaseExpiresAt: leases.get(run.id)?.expiresAt ?? null,
    // This store has no transcript, so the row's own session stands in for the `init` entry the SQL
    // adapter reads (WP-85): a fixture that seeds a live run with a session is the same statement.
    sessionId: run.sessionId,
  });

  /**
   * `run_commands` over this store's rows (WP-85). There is no lock to take in a single-threaded
   * store: the SQL adapter's `for share` orders two transactions, and here nothing interleaves
   * inside one call, so the predicates alone are the whole contract.
   */
  const now = options.now ?? (() => Date.now());
  /** Whether a run has a `cancel` or `take_over` row that was not refused (WP-101). */
  const stopRecordedFor = (runId: Id): boolean =>
    [...runCommandRows.values()].some(
      (row) =>
        row.runId === runId &&
        STOPPING_RUN_COMMAND_KINDS.includes(row.instruction.kind) &&
        row.refusedReason === null,
    );
  const runCommandRepository: RunCommandRepository = {
    lockRun: async (_tx, runId) => {
      const run = runs.get(runId);
      return run === undefined ? null : lockedRunOf(run);
    },
    lockLiveRunOf: async (_tx, taskId) => {
      const live = [...runs.values()].filter(
        (run) => run.taskId === taskId && isActiveRunStatus(run.status),
      );
      const newest = live.at(-1);
      return newest === undefined ? null : lockedRunOf(newest);
    },
    insert: async (_tx, command) => {
      if (runCommandRows.has(command.id)) {
        throw new PipelineStoreError(`run command ${command.id} already exists`);
      }
      if (!runs.has(command.runId)) {
        throw new PipelineStoreError(`run ${command.runId} does not exist`);
      }
      runCommandSequence += 1;
      runCommandRows.set(command.id, {
        id: command.id,
        runId: command.runId,
        taskId: command.taskId,
        actorUserId: command.actorUserId,
        instruction: clone(command.instruction),
        sequence: runCommandSequence,
        applied: false,
        refusedReason: null,
        createdAtMs: now(),
      });
    },
    pending: async (_tx, query) =>
      [...runCommandRows.values()]
        .filter((row) => {
          const run = runs.get(row.runId);
          return (
            !row.applied &&
            row.refusedReason === null &&
            (query.runId === undefined || row.runId === query.runId) &&
            run !== undefined &&
            isActiveRunStatus(run.status) &&
            leases.get(row.runId)?.owner === query.owner &&
            // A steer behind a stop that was not refused waits for the ending (WP-101).
            !(row.instruction.kind === 'steer' && stopRecordedFor(row.runId))
          );
        })
        .sort((left, right) => left.sequence - right.sequence)
        .slice(0, query.limit)
        .map((row) => ({
          id: row.id,
          runId: row.runId,
          taskId: row.taskId,
          actorUserId: row.actorUserId,
          instruction: clone(row.instruction),
          kind: row.instruction.kind,
        })),
    markApplied: async (_tx, input) => {
      const row = runCommandRows.get(input.id);
      if (row === undefined || row.applied || row.refusedReason !== null) {
        return false;
      }
      const run = runs.get(row.runId);
      if (
        run === undefined ||
        !isActiveRunStatus(run.status) ||
        leases.get(row.runId)?.owner !== input.owner
      ) {
        return false;
      }
      runCommandRows.set(row.id, { ...row, applied: true });
      return true;
    },
    markDeliveryFailed: async (_tx, input) => {
      const row = runCommandRows.get(input.id);
      if (row === undefined || !row.applied) {
        return false;
      }
      runCommandRows.set(row.id, { ...row, applied: false, refusedReason: 'delivery_failed' });
      return true;
    },
    markRefused: async (_tx, input) => {
      const row = runCommandRows.get(input.id);
      if (row === undefined || row.applied || row.refusedReason !== null) {
        return false;
      }
      runCommandRows.set(row.id, { ...row, refusedReason: input.reason });
      return true;
    },
    admitSteer: async (_tx, input) => {
      const since = now() - input.windowMs;
      return ![...runCommandRows.values()].some(
        (row) =>
          row.instruction.kind === 'steer' &&
          row.actorUserId === input.userId &&
          row.createdAtMs > since,
      );
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
      const current = questions.get(question.id);
      if (current === undefined) {
        throw new PipelineStoreError(`question ${question.id} does not exist`);
      }
      // `reminders_sent` is not `save`'s column (WP-84): the adapter's statement does not name it.
      questions.set(question.id, clone({ ...question, remindersSent: current.remindersSent }));
    },
    recordReminder: async (_tx, input) => {
      const current = questions.get(input.id);
      if (
        current === undefined ||
        current.status !== 'open' ||
        current.remindersSent !== input.sent
      ) {
        return false;
      }
      questions.set(input.id, { ...current, remindersSent: current.remindersSent + 1 });
      return true;
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
      const current = approvals.get(stored.approval.id);
      if (current === undefined) {
        throw new PipelineStoreError(`approval ${stored.approval.id} does not exist`);
      }
      // `reminders_sent` is not `save`'s column (WP-84), as for a question.
      approvals.set(
        stored.approval.id,
        clone({
          ...stored,
          approval: { ...stored.approval, remindersSent: current.approval.remindersSent },
        }),
      );
    },
    recordReminder: async (_tx, input) => {
      const current = approvals.get(input.id);
      if (
        current === undefined ||
        current.approval.status !== 'pending' ||
        current.approval.remindersSent !== input.sent
      ) {
        return false;
      }
      approvals.set(input.id, {
        ...current,
        approval: { ...current.approval, remindersSent: current.approval.remindersSent + 1 },
      });
      return true;
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

  /** The deadline recovery's reads and its one write (WP-56 round 2), over this store's own rows. */
  const unfinished = (taskId: Id): boolean => {
    const stored = tasks.get(taskId);
    return stored !== undefined && !isTerminalTaskState(stored.task.state);
  };
  const waiting = (): (WaitingAggregate & { readonly deadlineAt: IsoDateTime | null })[] => [
    ...[...questions.values()]
      .filter((question) => question.status === 'open' && unfinished(question.taskId))
      .map((question) => ({
        aggregate: 'question' as const,
        id: question.id,
        projectId: question.projectId,
        taskId: question.taskId,
        deadlineAt: question.deadlineAt,
      })),
    ...[...approvals.values()]
      .filter(
        (stored) => stored.approval.status === 'pending' && unfinished(stored.approval.taskId),
      )
      .map((stored) => ({
        aggregate: 'approval' as const,
        id: stored.approval.id,
        projectId: stored.approval.projectId,
        taskId: stored.approval.taskId,
        deadlineAt: stored.approval.deadlineAt,
      })),
  ];
  const strip = ({
    deadlineAt: _deadlineAt,
    ...row
  }: WaitingAggregate & {
    readonly deadlineAt: IsoDateTime | null;
  }): WaitingAggregate => row;
  const deadlineRecovery: DeadlineRecoveryStore = {
    overdue: async (_tx, query) =>
      waiting()
        .filter((row) => row.deadlineAt !== null && row.deadlineAt < query.dueBefore)
        .slice(0, query.limit * 2)
        .map(strip),
    heldTasks: async (tx, query) => {
      const held: HeldTask[] = [];
      for (const stored of tasks.values()) {
        if (stored.task.state !== 'paused') {
          continue;
        }
        const takeOver = await taskRepository.takenOver(tx, stored.task.id);
        if (takeOver !== null) {
          held.push({
            taskId: stored.task.id,
            takenAt: takeOver.at,
            lastActivityAt: takeOver.lastActivityAt,
          });
        }
      }
      // Oldest take-over first, as the PostgreSQL store's `order by e.occurred_at` (a fake no kinder).
      return held.sort((a, b) => a.takenAt.localeCompare(b.takenAt)).slice(0, query.limit);
    },
    undated: async (_tx, query) =>
      waiting()
        .filter((row) => row.deadlineAt === null)
        .slice(0, query.limit * 2)
        .map(strip),
    unreminded: async (_tx, query) => {
      const rows: UnremindedAggregate[] = [];
      for (const question of questions.values()) {
        if (
          question.status === 'open' &&
          question.remindersSent === 0 &&
          unfinished(question.taskId) &&
          question.deadlineAt !== null &&
          question.deadlineAt > query.deadlineAfter &&
          question.askedAt < query.sinceBefore
        ) {
          rows.push({
            aggregate: 'question',
            id: question.id,
            projectId: question.projectId,
            taskId: question.taskId,
            since: question.askedAt,
            deadlineAt: question.deadlineAt,
          });
        }
      }
      for (const { approval } of approvals.values()) {
        if (
          approval.status === 'pending' &&
          approval.remindersSent === 0 &&
          unfinished(approval.taskId) &&
          approval.deadlineAt !== null &&
          approval.deadlineAt > query.deadlineAfter &&
          approval.requestedAt < query.sinceBefore
        ) {
          rows.push({
            aggregate: 'approval',
            id: approval.id,
            projectId: approval.projectId,
            taskId: approval.taskId,
            since: approval.requestedAt,
            deadlineAt: approval.deadlineAt,
          });
        }
      }
      // Nearest deadline first, `limit` of each kind — the PostgreSQL store's order, no kinder.
      const nearest = (kind: 'question' | 'approval') =>
        rows
          .filter((row) => row.aggregate === kind)
          .sort((a, b) => a.deadlineAt.localeCompare(b.deadlineAt) || a.id.localeCompare(b.id))
          .slice(0, query.limit);
      return [...nearest('question'), ...nearest('approval')];
    },
    backfillDeadline: async (_tx, input) => {
      if (input.aggregate === 'question') {
        const question = questions.get(input.id);
        if (question === undefined || question.status !== 'open' || question.deadlineAt !== null) {
          return false;
        }
        questions.set(input.id, { ...question, deadlineAt: input.deadlineAt });
        return true;
      }
      const stored = approvals.get(input.id);
      if (
        stored === undefined ||
        stored.approval.status !== 'pending' ||
        stored.approval.deadlineAt !== null
      ) {
        return false;
      }
      approvals.set(input.id, {
        ...stored,
        approval: { ...stored.approval, deadlineAt: input.deadlineAt },
      });
      return true;
    },
  };

  const supersededRecovery: SupersededMergeRequestRecoveryStore = {
    strandedSupersededMergeRequests: async (_tx, query) =>
      [...superseded.values()]
        .filter(
          (row) =>
            row.settledAt === null &&
            (row.recoveryAttemptedAt === null
              ? row.supersededAt < query.olderThan
              : row.recoveryAttemptedAt < query.endingBefore),
        )
        .sort((left, right) => left.supersededAt.localeCompare(right.supersededAt))
        .slice(0, query.limit)
        .map((row) => ({
          taskId: row.taskId,
          projectId: row.projectId,
          iid: row.mr.iid,
          mrUrl: row.mr.url,
          mrProjectPath: row.mr.project_path ?? null,
          newBranch: row.newBranch,
          causeEventId: row.causeEventId,
          recoveryAttemptedAt: row.recoveryAttemptedAt,
        })),
    markSupersededAttempt: async (_tx, input) => {
      const key = supersededKey(input.taskId, input.iid);
      const row = superseded.get(key);
      if (row !== undefined && row.settledAt === null) {
        superseded.set(key, { ...row, recoveryAttemptedAt: input.at });
      }
    },
    endSupersededMergeRequest: async (_tx, input) => {
      const key = supersededKey(input.taskId, input.iid);
      const row = superseded.get(key);
      if (row !== undefined && row.settledAt === null) {
        superseded.set(key, {
          ...row,
          settledAt: input.at,
          outcome: 'abandoned',
          detail: input.reason,
        });
      }
    },
  };

  /** WP-90: the SQL store's ordering — a `linked` trace first, then the newest. */
  const bugTraceRepository: BugTraceRepository = {
    latest: async (_tx, ticket) => {
      const traces = (options.projectEvents?.(ticket.projectId) ?? []).flatMap((event) =>
        event.type === 'ticket.bug.traced' &&
        event.payload.ticket.provider === ticket.provider &&
        event.payload.ticket.key === ticket.key
          ? [event]
          : [],
      );
      const pick =
        traces.findLast((event) => event.payload.outcome === 'linked') ?? traces.at(-1) ?? null;
      return pick === null
        ? null
        : { outcome: pick.payload.outcome, filedAt: pick.payload.filed_at as IsoDateTime };
    },
  };

  return {
    deadlineRecovery,
    supersededRecovery,
    supersededRows: () => [...superseded.values()].map((row) => clone(row)),
    tasks: taskRepository,
    artifacts: artifactRepository,
    runs: runRepository,
    questions: questionRepository,
    approvals: approvalRepository,
    breakdown: breakdownRepository,
    runCommands: runCommandRepository,
    bugTraces: bugTraceRepository,
    runCommandRows: () => [...runCommandRows.values()].map((row) => clone(row)),
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

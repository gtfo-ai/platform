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
 * | 1 | `insert` throws on a duplicate `(project, ticket_key, mode)` **and**, since WP-157 (e) (backlog 434), on an equal non-null ticket id per `(project, provider, mode)`; PostgreSQL raises a unique-violation the caller sees as an error too. | **same** | Two unique indexes: `tasks_project_id_ticket_key_mode` and migration 0077's `tasks_project_ticket_id_mode` (`where ticket_id is not null`); both stores refuse both. Before WP-157 the fake refused the key only and this row said *same* — a test written against the fake could pass where production refused. Asserted by the shared suite's `refuses a second task for the same ticket key (WP-157)` and `refuses a second task for the same ticket id under another key (WP-157)`, with `admits the same ticket id in another mode or of another provider, and two tasks with no id (WP-157)` as their positive. |
 * | 2 | `save` throws when the task was never inserted; the SQL `update` would affect zero rows and say nothing. | **stricter** | A save that writes nothing is how a state machine silently stops advancing. The SQL implementation therefore checks `rowCount` and throws the same error, which is the only reason the two agree. Asserted by `refuses to save a task it has never seen`. |
 * | 3 | Everything is returned by structural clone, so a caller mutating what it read cannot change the store. Postgres cannot be mutated that way either. | **stricter** | A shared object graph makes a test pass for the wrong reason: the aggregate is immutable by design, and a fake that hands out live references would hide a mutation. |
 * | 5 | ~~The whole-row `save` writes `ticketSnapshot`/`ticketSnapshotAt`; the SQL `save` does not name those two columns at all (WP-15f).~~ **Closed at WP-15e**: `save` now writes exactly the column set the SQL statement names, in both stores, and the divergence is gone rather than justified. | **same** | It was filed as *stricter* and it was, but a fake that can clobber a column the database cannot is a fake that answers a question production never asks — and the same shape one work package later (`save` clobbering `workpad_ref`, which PostgreSQL **could** do) was a live defect. The partition is now enforced off disk by `tasks-column-ownership.test.ts`. |
 * | 6 | `save` refuses a write over a row whose `version` has moved, exactly as the SQL `where … and version = $n` does (WP-15e). | **same** | The fake compares a number where PostgreSQL compares a predicate, and both throw `TaskConcurrentModificationError`. Asserted for both by `pipeline-store-concurrency-suite.ts`, which drives two transactions over one committed row. The fake's `version` is still only as good as divergence 4: with no isolation, the interleaving it reproduces is the *ordering*, not the locking. |
 * | 4 | No transaction isolation: a `Transaction` handle is accepted and ignored, so a rolled-back "transaction" leaves its writes — **including the writes made before a fenced write threw `LeaseLostError`** (WP-276, backlog 698): PostgreSQL rolls them back with the transaction, this store keeps them, so a test of a `lease_lost` reached through the claimant, the heartbeat or `settleRun` asserts through PostgreSQL (`test/integration/pipeline/settle-run.integration.test.ts`, `offer-lock-order.integration.test.ts`) or only on what the fenced call returned. | **kinder** | This is the one that matters, and the reason the same suite runs against PostgreSQL: rollback semantics cannot be faked in a Map. **Positive assertion**: `memory-pipeline.test.ts` asserts the divergence explicitly (`keeps writes a rolled-back scope made, which PostgreSQL does not`), so a reader meets it as a test rather than as a warning, and the e2e tier runs the pipeline on the real thing. |
 * | 7 | `task.sequence` was the number the stored aggregate carried; PostgreSQL derives it from the **event log** (`max(stream_seq) + 1`, `TASK_COLUMNS`). **Closed at WP-26** by {@link MemoryPipelineStoreOptions.streamSequence}: a harness that wires the event log in gets the derived number. | **same, when wired** | It was *kinder* and it hid a whole class: an event appended to a task's stream by anything other than the aggregate — `task.review.observed` (WP-24), `task.lint.posted` (WP-25), `task.rebase.checked` and `task.conflict.warned` (WP-26) — left the fake's aggregate one behind the log, so the **next** aggregate write would clash in production and not here. It only stayed invisible because the first three land on a task that has stopped. Unwired, the old behaviour remains, which is why the accessor takes the **maximum** of the two rather than replacing one with the other: a transaction's own staged appends are not committed yet, and the aggregate's number is the right answer for them. |
 * | 8 | `takenOver` reads the **committed** log through {@link MemoryPipelineStoreOptions.taskEvents}; PostgreSQL's query also sees the calling transaction's own staged appends (WP-56). Unwired, it answers `null`; its `lastActivityAt` reads {@link MemoryPipelineStoreOptions.humanActions} (WP-44), and unwired that is the take-over's own instant. | **same, when wired; kinder by one window** | Both readers of it — the workpad render and the take-over timer — run in a job's **own** transaction after the events they react to have committed, so the window this cannot see is one neither reader stands in. A caller that asked inside the transaction that appended the take-over would get `null` here and the record from PostgreSQL; nothing does, and the contract suite drives the committed case against both. |
 * | 9 | `runCommands` (WP-85): `lockRun`/`lockLiveRunOf`/`markApplied` take no lock (nor does `runs.lockSettlement`, WP-275, whose `for update` orders two settles of one run in PostgreSQL — `test/integration/pipeline/settle-run.integration.test.ts`), `admitSteer` (WP-101) takes no advisory lock and reads `created_at` off {@link MemoryPipelineStoreOptions.now} rather than the database's clock, and `LockedRun.sessionId` is the run row's `sessionId` where PostgreSQL reads the run's `system`/`init` transcript entry (this store keeps no transcript). | **kinder** on ordering, **same** on predicates | The `for share` ordering between a command and the run's ending is a property of two concurrent transactions, which a single-threaded store cannot interleave; it is asserted against PostgreSQL in `test/integration/pipeline/run-commands.integration.test.ts`, both orders — and the steer window's lock there by a second transaction that must wait (WP-101). Every predicate — live run, this owner's lease, still pending, closed `run_ended` by the winning `finish` — is the SQL's, and the contract suite drives each against both stores. |
 * | 10 | `bugTraces.latest` (WP-90) reads the **committed** project log through {@link MemoryPipelineStoreOptions.projectEvents}, in stream order; PostgreSQL orders by `occurred_at` then `position` and also sees the calling transaction's own staged appends. Unwired, it answers `null`. | **same, when wired** | Its one caller, the `ticket.updated` handler, asks in the dispatcher's transaction about traces an earlier job committed; a trace appended in the asking transaction does not exist, because no handler appends one. Stream order and `occurred_at` order agree for every trace the duty writes, which appends with the platform clock in sequence. The contract suite drives both. |
 * | 11 | `runs.markCliSpawnRequested` (WP-150) refuses a run that has ended and a run already marked, exactly as the SQL's `where cli_spawn_requested_at is null and status = any(active)`; `load` answers the marker and `insert` drops one a caller passed; the held set (`heldFor`, `totalsFor`'s `unmeasuredRuns`) excludes an unmarked run, as `unmeasuredEndedRunSql` does. What it cannot show is the marker **committed before** the `spawn` frame is sent — divergence 4's isolation. | **same** on predicates, **kinder** on commit order | The commit order is asserted against PostgreSQL from a second connection in `test/integration/pipeline/cli-spawn-marker.integration.test.ts`, and the predicates by the shared suite against both stores. |
 * | 12 | `tasks.ticketStatusChangesSinceEntry` (WP-178) reads the **committed** log through {@link MemoryPipelineStoreOptions.committedLog}, ordered by `position`; PostgreSQL's query also sees the calling transaction's own staged appends. Unwired, it answers `[]`. | **same, when wired** | Its one caller, the human-return window, asks in a job's own transaction about events earlier transactions committed (the task's entry into `qa`, a webhook's status change); the predicate — the newest entry, the project stream, the ticket by id or key — is the SQL's, and the contract suite drives it against both stores. |
 * | 14 | The **owner directory** (S-26.1, `owners`) answers from {@link MemoryPipelineStore.seedIdentity}, {@link MemoryPipelineStore.seedProjectMember} and {@link MemoryPipelineStore.seedBindingAccount} where PostgreSQL joins `user_identities`, `users`, `project_members` and `bindings.account_identity`. Unseeded, every assignee is a `person` and nobody may own a task. `personIdentity` (S-26.3) answers the first seeded link, where the SQL orders by `created_at`. | **same** on the predicate, **stricter** unseeded | The SQL's order — a linked member first, then a machine, then a binding's account — is the one {@link classify} applies; that the effective role is the higher of the organisation role and a membership, and that a disabled user (`users.status`) may own nothing, is the SQL's alone, asserted by `test/integration/pipeline/task-owner.integration.test.ts`. |
 * | 13 | A **remote worker's claim** (WP-281) asks {@link MemoryPipelineStoreOptions.remoteWorkers} and {@link MemoryPipelineStoreOptions.runCredentialSource} where the SQL claim joins `workers`, `users`, `project_members`, `bindings` and `integrations` in its one statement; the same callback fences `finish`, `renewLease` and the spawn marker of a run a worker holds (backlog 714's `runHolderUsableSql`). Unwired, no worker is eligible and a worker-held run's fence never holds. | **same** on the predicates, **stricter** unwired | That the predicates are asked **in the committing statement** — a revoke that commits between a request's authentication and its write is seen — is PostgreSQL's isolation, asserted by `test/integration/pipeline/remote-claim.integration.test.ts`; divergence 4 is why it cannot be shown here. |
 * | 15 | A worker's **claim policy** (S-26.4) is the domain's `claimPolicyTakes` over this store's ownership map and directory, as the SQL's `workerPolicyTakesSql`; an **ask's** "mine" is read off the offer's assignee — the asker, which the ask executor always writes there — where the SQL reads `task_asks.asked_by_user_id`, and the offers list and the pick refusal name an owner with an empty `name` (no `users` here). | **same** on the predicate, **kinder** on an ask whose offer named no assignee | The policy × task matrix, the ask's asker and the owner's name are asserted against PostgreSQL in `test/integration/pipeline/claim-policy.integration.test.ts`. |
 * | 16 | `tasks.ownerBackfillDue` (BACKLOG 1510) orders the most recently **created** first, then by id; the SQL orders by `updated_at` descending, which this store does not keep. The predicate (live, `normal`, no stored assignee, unsettled, under the attempt cap, no retry time after `now`, created before `olderThan`) and the `limit` are the SQL's, and `claimOwnerBackfillAttempt` and `settleOwnerBackfill` are the same conditional writes (BACKLOG 1511). | **different (order only)** | No column of `StoredTask` is an update time, and adding one to every writer for one query's order would be a second clock to keep honest. The shared suite asserts the predicate, the mark and the bound, and orders only tasks created and touched in the same order, so it holds both stores. |
 */
import type {
  AgentRole,
  ArtifactType,
  CiGateEnding,
  CiManualNotRun,
  CiManualStarted,
  ContextPackRecord,
  DomainEvent,
  EstimateBasis,
  Id,
  IsoDateTime,
  ProviderMode,
  ProviderSync,
  RunSavedWork,
  RunStartFailure,
  Size,
  Slug,
  StoredTicketClaim,
  TaskStageState,
  WorkerClaimPolicy,
} from '@platform/contracts';
import {
  ciGateEndingSchema,
  ciManualNotRunSchema,
  ciManualStartedSchema,
  mergeRequestRefSchema,
  storedTicketClaimSchema,
  taskCoverageSchema,
  taskDependenciesSchema,
  taskReviewersSchema,
  taskReviewThreadsSchema,
  taskStageExitStateSchema,
  taskStageOutcomeSchema,
  taskStageStateSchema,
  ticketAssigneeSchema,
  workpadRefSchema,
} from '@platform/contracts';
import type {
  Approval,
  AssigneeClass,
  ExecutionSettings,
  Question,
  QueuedTask,
  TaskOwnership,
} from '@platform/domain';
import {
  claimPolicyTakes,
  countsAsActive,
  countsInPipeline,
  countsTowardOwner,
  effectiveClaimPolicy,
  isActiveRunStatus,
  isTerminalTaskState,
  projectListTakes,
  taskHeldElsewhere,
  taskIsUnassigned,
  UNOWNED,
} from '@platform/domain';
import { holdOf } from '../cost/pending.js';
import { withCiManualStartedEntry } from '../pipeline/ci-manual-started.js';
import { type CiPendingRead, ciPendingReadSchema } from '../pipeline/ci-pending-read.js';
import { decideRelease } from '../pipeline/release.js';
import type {
  ApprovalRepository,
  ArtifactRepository,
  BreakdownRepository,
  BugTraceRepository,
  ExecutionRoutingRepository,
  PipelineStore,
  QuestionRepository,
  ReadyMergeCheck,
  RemoteListing,
  RunCommandInstruction,
  RunCommandRefusal,
  RunCommandRepository,
  RunOfferRepository,
  RunPlanRepository,
  RunRepository,
  StoredApproval,
  StoredArtifact,
  StoredBreakdownItem,
  StoredRun,
  StoredRunOffer,
  StoredRunPlan,
  StoredTask,
  SupersededMergeRequest,
  SupersededMergeRequestOutcome,
  TaskDutyLeaseRepository,
  TaskMergeRecord,
  TaskRepository,
} from '../pipeline/store.js';
import {
  CONVERSATION_HANDLED_ID,
  type ConversationHandledRow,
  DefaultBranchChangedError,
  LeaseLostError,
  MAX_CONVERSATION_HANDLED_AUTHOR_CHARS,
  MAX_CONVERSATION_HANDLED_ROWS,
  PAUSE_ENDING_EVENTS,
  STOPPING_RUN_COMMAND_KINDS,
  TAKE_OVER_BOUNDARY_EVENTS,
  TaskConcurrentModificationError,
  type TaskPause,
} from '../pipeline/store.js';
import type { StoredEvent } from '../ports/event-store.js';
import type {
  DeadlineRecoveryStore,
  HeldTask,
  RemindableApproval,
  UnremindedAggregate,
  WaitingQuestion,
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
  /** The gate's last failure a person attached to their return (WP-152, migration 0086). */
  attachedFeedback: string | null;
  /** The uncut length of `attachedFeedback`, when the gate cut it (migration 0086). */
  attachedFeedbackOriginalChars: number | null;
  /** Whether the next run is handed `attachedFeedback` (migration 0086). */
  attachedFeedbackSent: boolean;
  /** The ticket's status at this human stage's entry (WP-178 review, migration 0089). */
  entryTicketStatus?: string | null;
  /** Whether the window saw the ticket at the `qa` slot during this entry (migration 0089). */
  ticketSeenAtQa?: boolean;
  /** When the window first saw a forward move during this entry (migration 0111, M28 R1). */
  ticketForwardSeenAt?: string | null;
  signature: string | null;
  /** `task_stages.lost_runs` and `usage_limited_runs` (migration 0100, WP-285/WP-286). */
  lostRuns?: number;
  usageLimitedRuns?: number;
  /** `task_stages.ci_pending_read` (migration 0107, backlog 1078): the CI gate's last pending read. */
  ciPendingRead?: CiPendingRead | null;
  /** `task_stages.ci_ending` (migration 0107, backlog 1078): how the CI gate's wait ended it. */
  ciEnding?: CiGateEnding | null;
  /** `task_stages.ci_manual_not_run` (migration 0109, S-27.2): what a CI pass left unstarted. */
  ciManualNotRun?: CiManualNotRun | null;
  /** `task_stages.ci_manual_started` (migration 0112, S-28.7): the manual jobs the platform started. */
  ciManualStarted?: CiManualStarted | null;
  enteredAt: number;
  /**
   * The instant the row was entered, on {@link MemoryPipelineStoreOptions.now} — PostgreSQL's
   * `entered_at` (`clock_timestamp()`), which the CI gate's wait is timed from (WP-136).
   * `enteredAt` stays the write sequence the ordering reads use.
   */
  enteredAtMs: number;
  exitedAt: number | null;
}

const clone = <T>(value: T): T => structuredClone(value);

/**
 * Whether a `ticket.updated` reaches a task (WP-145): by the stable id when both carry one, by the
 * key when the task has none or the signal carries none — the SQL predicate of `recordTicketSignal`.
 */
const ticketSignalReaches = (
  stored: StoredTask,
  signal: { readonly ticketKey: string; readonly ticketId?: string | null },
): boolean => {
  const taskId = stored.task.ticket.id ?? null;
  const signalId = signal.ticketId ?? null;
  if (signalId !== null && taskId !== null) {
    return taskId === signalId;
  }
  return stored.task.ticket.key === signal.ticketKey;
};

/** The owner-backfill columns of one task (migration 0110, BACKLOG 1510/1511). */
export interface OwnerBackfillState {
  /** `owner_backfill_at`: the backfill ended (a definitive read, or the last attempt failed). */
  readonly settledAt: IsoDateTime | null;
  readonly attempts: number;
  readonly retryAt: IsoDateTime | null;
}

const NO_OWNER_BACKFILL: OwnerBackfillState = { settledAt: null, attempts: 0, retryAt: null };

/**
 * An ended run nobody measured — the SQL adapter's `unmeasuredEndedRunSql` over this store's rows:
 * terminal, and no figure (`cost` null is both columns null, `finish` writing one or the other).
 */
const endedUnmeasured = (
  run: StoredRun,
  floors: ReadonlySet<Id>,
  spawnMarkers: ReadonlyMap<Id, IsoDateTime>,
): boolean =>
  !isActiveRunStatus(run.status) &&
  (run.cost === null || floors.has(run.id)) &&
  // WP-150: a run that never asked for its CLI is a measured zero, held by no cap — the SQL's
  // `r.cli_spawn_requested_at is not null`.
  spawnMarkers.has(run.id);

export interface MemoryPipelineStore extends PipelineStore {
  /** Every task, for a test that wants to look without a transaction. */
  snapshot(): readonly StoredTask[];
  /**
   * `users.max_tasks_in_flight` (S-28.6, migration 0114) — a person's own limit, `null` for none.
   * The store has no users table; this is what `ownerAdmission` answers as `personalLimit`.
   */
  setPersonalTaskLimit(userId: Id, limit: number | null): void;
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
  /** `runs.provider_mode` as `insert` wrote it (backlog 454), or `null` for a run never inserted. */
  providerModeOf(runId: Id): ProviderMode | null;
  /** `runs.exit_detail` as `finish` wrote it — why a run never started (backlog 453). */
  startFailureOf(runId: Id): RunStartFailure | null;
  /** `runs.saved_work` as `finish` wrote it (backlog 467), or `null`. */
  savedWorkOf(runId: Id): RunSavedWork | null;
  /** The lease a run currently holds, for a test that asserts the heartbeat wrote one (WP-47). */
  leaseOf(runId: Id): { readonly owner: string; readonly expiresAt: IsoDateTime } | null;
  /** Every `run_commands` row, for a test that asserts what the holder stamped (WP-85). */
  runCommandRows(): readonly MemoryRunCommandRow[];
  /** Every `run_offers` row (WP-274), for a test that asserts the offer's lifecycle. */
  offerRows(): readonly StoredRunOffer[];
  /** `runs.lease_epoch` (WP-274), `0` for a run no claim took. */
  leaseEpochOf(runId: Id): number;
  /** Stores a project's execution settings, as `PUT …/execution` would (WP-278). */
  setExecutionSettings(projectId: Id, settings: ExecutionSettings | null): void;
  /** Marks a user as having a worker online for a project (WP-278); nothing else writes it here. */
  setAssigneeOnline(projectId: Id, userId: Id, online: boolean): void;
  /**
   * S-26.1's owner directory, seeded: a `user_identities` row — `userId` for a `person` linked to
   * that user, `null` for a `machine` (divergence 14).
   */
  seedIdentity(provider: string, externalId: string, userId: Id | null): void;
  /** The user's effective role in the project is `member` or above (divergence 14). */
  seedProjectMember(projectId: Id, userId: Id): void;
  /** The user's role in the project drops below `member`, or they leave it (divergence 14). */
  unseedProjectMember(projectId: Id, userId: Id): void;
  /** A binding of the project acts as this account (`bindings.account_identity`, divergence 14). */
  seedBindingAccount(projectId: Id, provider: string, externalId: string): void;
  /** The task's ownership columns as `saveOwner` left them, for a test without a transaction. */
  ownershipOf(taskId: Id): TaskOwnership;
  /** The three owner-backfill columns (migration 0110, BACKLOG 1510/1511), for a test without a transaction. */
  ownerBackfillOf(taskId: Id): OwnerBackfillState;
  /** The holders of a fresh `server_claimants` row, as the claimant renewed them (WP-278). */
  serverClaimantHolders(): readonly string[];
  /**
   * Clears an offer's `server_from`, `workers_from` and `expires_at` — the shape of an offer written
   * before WP-278 (backlog 887), which no writer of this build produces.
   */
  unrouteOffer(runId: Id): void;
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
   * `projects.default_branch` as the SQL insert re-reads it under the project lock (WP-149,
   * backlog 443) — `undefined` for a project this answers nothing about. Unwired, a guarded insert
   * compares nothing.
   */
  readonly defaultBranch?: (projectId: Id) => string | undefined;
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
   * The **committed** log across every stream, in `position` order — what
   * `TaskRepository.ticketStatusChangesSinceEntry` reads (WP-178), because it orders a project
   * stream's event against a task stream's, which only the log's position can. Optional for
   * {@link streamSequence}'s reason. **Unwired, it answers `[]`** — divergence 12: a store built
   * without the log has seen no status change, and says so. `createPipelineHarness` wires it.
   */
  readonly committedLog?: () => readonly StoredEvent[];
  /**
   * The clock `run_commands.created_at` is stamped by and the steer window reads (WP-101) — the
   * database's `now()` in PostgreSQL. Defaults to `Date.now`.
   */
  readonly now?: () => number;
  /**
   * The remote workers a worker claim may name (WP-281) — `workers`, `users` and `project_members`
   * in PostgreSQL, which this store does not have. **Divergence 13**: the SQL claim asks the worker's
   * revocation, its user's ban, its pause and its membership **in the statement**; this store asks
   * this callback at the same point, so a test that revokes between two calls sees what PostgreSQL
   * would — but the interleaving *inside* one statement is PostgreSQL's alone, asserted by
   * `test/integration/pipeline/remote-claim.integration.test.ts`. Unwired, no worker is eligible and
   * every run a worker holds reads as held by one that may not act (stricter, never kinder).
   */
  readonly remoteWorkers?: (workerId: Id) => MemoryRemoteWorker | undefined;
  /**
   * The project's git run credential source (`integrations.config.run_credential` of its git
   * binding), or `null` for a project with no git binding. Unwired is `minted` for every project.
   */
  readonly runCredentialSource?: (projectId: Id) => 'minted' | 'static' | 'deploy_key' | null;
  /**
   * The git integration's `remote_run_credential` (WP-282, TD-031 decision 5, Q124 (a)): `allow`
   * admits a `static` or `deploy_key` project to a remote claim. Unwired is `deny`, the default.
   */
  readonly remoteRunCredential?: (projectId: Id) => 'allow' | 'deny';
}

/** A remote worker as {@link MemoryPipelineStoreOptions.remoteWorkers} answers it (WP-281). */
export interface MemoryRemoteWorker {
  readonly userId: Id;
  /** Not revoked, and its user may act. */
  readonly usable: boolean;
  readonly pausedUntil: IsoDateTime | null;
  /** The owner's hold from the worker's local page (WP-292); absent reads as not held. */
  readonly manuallyPaused?: boolean;
  /** S-28.12: a workspace failure's cool-down (`workspace_unavailable_until`); absent is none. */
  readonly workspaceUnavailableUntil?: IsoDateTime | null;
  /**
   * The worker's claim scope (WP-293): `null`/absent every project, otherwise those projects — a
   * conjunct of an automatic claim, ignored by a pick. A legacy `[]` narrows nothing and makes an
   * absent policy read `pick_only` (S-26.4, `effectiveClaimPolicy`).
   */
  readonly claimProjectIds?: readonly Id[] | null;
  /**
   * The worker's claim policy (S-26.4, migration 0108): `null`/absent reads as the SQL's `null` —
   * `pick_only` over a `[]` scope, `everything` otherwise.
   */
  readonly claimPolicy?: WorkerClaimPolicy | null;
  /**
   * Whether the user's effective project role — the higher of the organisation role and a
   * membership (backlog 886) — is `member` or above.
   */
  readonly memberOf: (projectId: Id) => boolean;
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
  /** `task_conversation_handled` (migration 0111, M28 ruling R2), in insertion order. */
  const conversationHandled: ConversationHandledRow[] = [];
  const artifacts: StoredArtifact[] = [];
  const runs = new Map<Id, StoredRun>();
  /** `runs.ask_id` (migration 0082, WP-149): the ask a run answered, for the ask's bound. */
  const askOfRun = new Map<Id, Id>();
  /** Backlog 709: each run's stored context pack, as `run_context_pack` and its header hold it. */
  const contextPacks = new Map<Id, ContextPackRecord>();
  /** `tasks.budget_cap_usd` (WP-131 review round 1): not on `StoredTask`, as `save` never names it. */
  const budgetCaps = new Map<Id, number>();
  /** `task_provider_sync` (S-28.10, migration 0116), keyed `task_id#subject` like its primary key. */
  const providerSyncRows = new Map<string, { readonly taskId: Id; readonly row: ProviderSync }>();
  /** `tasks.ticket_claim` (migration 0088, WP-177): not on `StoredTask`, as `save` never names it. */
  const ticketClaims = new Map<Id, StoredTicketClaim>();
  // S-26.1: the four ownership columns, kept off `StoredTask` as the claim is, and the directory.
  const ownerships = new Map<Id, TaskOwnership>();
  /** `users.max_tasks_in_flight` (S-28.6): a person's own limit, set by a test. */
  const personalLimits = new Map<Id, number>();
  /** The owner-backfill columns (migration 0110, BACKLOG 1510/1511): kept off `StoredTask` like the owner. */
  const ownerBackfills = new Map<Id, OwnerBackfillState>();
  /** S-28.5: the one-off ticket-status sweep's records, task id → `swept_at`. */
  const ticketStatusSweeps = new Map<Id, string>();
  /** S-28.5 review: the status each task's last reverse-sync stop acted on. */
  const ticketStatusStops = new Map<Id, string>();
  /** S-28.13 (migration 0118): each task's merge check — its claim and what was read. */
  const mergeChecks = new Map<
    Id,
    {
      claimedAt: string;
      check: ReadyMergeCheck | null;
      /** S-28.15 (migration 0119): who merges, and what the platform last waited for. */
      mergeBy?: 'person' | 'platform' | null;
      mergeWait?: string | null;
    }
  >();
  /** S-28.15 (migration 0119): the platform's merge attempts, `task#head` → the record. */
  const taskMerges = new Map<string, TaskMergeRecord>();
  const mergeKind = (outcome: TaskMergeRecord['outcome']): string =>
    outcome.startsWith('rebase') ? 'rebase' : 'merge';
  const mergeRowDue = (stored: StoredTask, stale: number): boolean => {
    const row = mergeChecks.get(stored.task.id);
    if (row === undefined || !(Date.parse(row.claimedAt) < stale)) {
      return false;
    }
    const attempts = [...taskMerges.values()].filter((merge) => merge.taskId === stored.task.id);
    if (
      attempts.some((merge) => merge.outcome === 'merged' && Date.parse(merge.attemptedAt) < stale)
    ) {
      return true;
    }
    return (
      row.mergeBy === 'platform' &&
      stored.readyHeadSha !== null &&
      !attempts.some(
        (merge) => merge.headSha === stored.readyHeadSha && merge.outcome !== 'rebased',
      )
    );
  };
  const backfillOf = (taskId: Id): OwnerBackfillState =>
    ownerBackfills.get(taskId) ?? NO_OWNER_BACKFILL;
  const backfillClaimable = (
    state: OwnerBackfillState,
    query: { readonly now: IsoDateTime; readonly maxAttempts: number },
  ): boolean =>
    state.settledAt === null &&
    state.attempts < query.maxAttempts &&
    (state.retryAt === null || Date.parse(state.retryAt) <= Date.parse(query.now));
  const ownerIdentities = new Map<string, Id | null>();
  const projectMembers = new Set<string>();
  const bindingAccounts = new Set<string>();
  const identityKey = (provider: string, externalId: string): string =>
    `${provider}\0${externalId}`;
  const mayOwnIn = (projectId: Id, userId: Id): boolean =>
    projectMembers.has(`${projectId}\0${userId}`);
  /** The SQL's order: a linked member, then a machine, then a binding's own account (divergence 14). */
  const classify = (projectId: Id, provider: string, externalId: string): AssigneeClass => {
    const key = identityKey(provider, externalId);
    const linked = ownerIdentities.get(key);
    if (linked !== undefined && linked !== null && mayOwnIn(projectId, linked)) {
      return { kind: 'member', userId: linked };
    }
    if (linked === null) {
      return { kind: 'platform' };
    }
    if (bindingAccounts.has(`${projectId}\0${key}`)) {
      return { kind: 'platform' };
    }
    return { kind: 'person' };
  };
  /** `runs.reserve_usd` (WP-131): write-only on `NewRun`, so kept beside the row, as the SQL keeps it. */
  const reserves = new Map<Id, number | null>();
  /** `runs.provider_mode`, write-only on the port; read by {@link MemoryPipelineStore.providerModeOf}. */
  const providerModes = new Map<Id, ProviderMode>();
  /** `runs.exit_detail`, write-only on the port; read by {@link MemoryPipelineStore.startFailureOf}. */
  const startFailures = new Map<Id, RunStartFailure>();
  /** `runs.saved_work` (backlog 467); read by `lastSavedWork` and {@link MemoryPipelineStore.savedWorkOf}. */
  const savedWorks = new Map<Id, RunSavedWork>();
  /** `runs.figure_is_floor` (WP-131 pre-review round, backlog 407): the runs whose cost is a floor. */
  const floors = new Set<Id>();
  /** `runs.cli_spawn_requested_at` (migration 0085, WP-150), written only by its compare-and-set. */
  const spawnMarkers = new Map<Id, IsoDateTime>();
  const questions = new Map<Id, Question>();
  const approvals = new Map<Id, StoredApproval>();
  const breakdown = new Map<Id, StoredBreakdownItem>();
  /** `runs.lease_owner` / `lease_expires_at`, which this store keeps beside the row (WP-47). */
  const leases = new Map<Id, { owner: string; expiresAt: IsoDateTime }>();
  /** `runs.lease_epoch` (WP-274, migration 0094), copied from the offer by the claim. */
  const epochs = new Map<Id, number>();
  /** `run_offers` (WP-274), keyed by `run_id` (unique there), insertion-ordered. */
  const offers = new Map<Id, StoredRunOffer>();
  /**
   * WP-281: the offer's remote columns — `worker_id`, `run_token_hash`/`run_token_epoch`,
   * `image_digests`, `excluded_worker_ids`, `released_at` — keyed by `run_id`.
   */
  const offerRemote = new Map<
    Id,
    {
      workerId: Id | null;
      tokenHash: string | null;
      tokenEpoch: number | null;
      images: { run: string; egress: string } | null;
      excluded: Id[];
      releasedAt: IsoDateTime | null;
      releaseReason: string | null;
    }
  >();
  /** `runs.worker_id` (WP-280's column, WP-281's writer). */
  const runWorkers = new Map<Id, Id>();
  /** `runs.ended_at`, as `finish` writes it — what a run token's validity is counted from. */
  const endedAts = new Map<Id, IsoDateTime>();
  /** The remote columns of an offer, defaulted for one no worker ever touched. */
  const remoteOf = (runId: Id) =>
    offerRemote.get(runId) ?? {
      workerId: null,
      tokenHash: null,
      tokenEpoch: null,
      images: null,
      excluded: [],
      releasedAt: null,
      releaseReason: null,
    };
  /** The SQL's `runHolderUsableSql`: no remote holder, or one that may still act (backlog 714). */
  const holderUsable = (runId: Id): boolean => {
    const workerId = runWorkers.get(runId);
    return workerId === undefined || options.remoteWorkers?.(workerId)?.usable === true;
  };
  /** WP-278: `project_execution_settings`, the online assignees, and the claimant holders. */
  const executionSettings = new Map<Id, ExecutionSettings>();
  const onlineAssignees = new Set<string>();
  const serverClaimants = new Set<string>();
  /** `run_plans` (WP-275a, migration 0095), keyed by `run_id`. */
  const plans = new Map<Id, StoredRunPlan>();
  /** `run_commands` (WP-85), insertion-ordered like the SQL's `created_at, id`. */
  const runCommandRows = new Map<Id, MemoryRunCommandRow>();
  let runCommandSequence = 0;
  const chargedRuns = new Set<Id>();
  let sequence = 0;
  /** The database's clock for `task_stages.entered_at` (WP-136); `now` below is the same option. */
  const stageClock = options.now ?? (() => Date.now());

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
          (stored.task.ticket.key === query.ticketKey ||
            // The stable id answers under any key (WP-134, migration 0077's partial index).
            (typeof query.ticketId === 'string' && stored.task.ticket.id === query.ticketId)) &&
          stored.task.mode === query.mode,
      );
      return found === undefined ? null : readTask(found);
    },
    findByTicketSignal: async (_tx, query) => {
      const matching = [...tasks.values()].filter(
        (stored) =>
          stored.task.projectId === query.projectId &&
          stored.task.ticket.provider === query.provider &&
          stored.task.mode === query.mode &&
          ticketSignalReaches(stored, query),
      );
      // Insertion order is creation order here; a task matched by its id comes first.
      const found =
        matching.find((stored) => (stored.task.ticket.id ?? null) !== null) ?? matching[0];
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
    insert: async (_tx, stored, guard) => {
      // WP-149: the SQL adapter's re-read of `projects.default_branch` under its lock, against
      // {@link MemoryPipelineStoreOptions.defaultBranch}; unwired (or a project it does not know),
      // nothing is compared — this store keeps no projects.
      const current =
        guard === undefined ? undefined : options.defaultBranch?.(stored.task.projectId);
      if (guard !== undefined && current !== undefined && current !== guard.defaultBranch) {
        throw new DefaultBranchChangedError(stored.task.projectId, guard.defaultBranch, current);
      }
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
      // WP-157 (e), backlog 434: migration 0077's second unique index,
      // `tasks_project_ticket_id_mode` on `(project_id, ticket_provider, ticket_id, mode) where
      // ticket_id is not null` — an equal non-null id under another key is refused too.
      const ticketId = stored.task.ticket.id ?? null;
      const duplicateId =
        ticketId !== null &&
        [...tasks.values()].some(
          (existing) =>
            existing.task.projectId === stored.task.projectId &&
            existing.task.ticket.provider === stored.task.ticket.provider &&
            (existing.task.ticket.id ?? null) === ticketId &&
            existing.task.mode === stored.task.mode,
        );
      if (duplicateId) {
        throw new PipelineStoreError(
          `a task already exists for ticket id ${ticketId} of ${stored.task.ticket.provider} in mode ${stored.task.mode}`,
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
      // `mr` is not written (WP-138): the merge request belongs to `recordMergeRequest` and
      // `releaseMergeRequest`, like the SQL adapter's `save`, which no longer names `mr_ref`.
      const written: StoredTask = {
        ...current,
        task: stored.task,
        branch: stored.branch,
        version: current.version + 1,
      };
      tasks.set(stored.task.id, clone(written));
      // The caller's own snapshot at the new version, so a second save in the same unit is not a
      // conflict with the first: `{ ...stored }` rather than `{ ...current }`, because the columns
      // this write ignored are the store's and the ones it took are the caller's. `costActualUsd`
      // is the store's since WP-31 and `mr` since WP-138, so they come back from `written`.
      return clone({
        ...stored,
        costActualUsd: written.costActualUsd,
        mr: written.mr,
        version: written.version,
      });
    },
    recordMergeRequest: async (_tx, taskId, mr) => {
      const current = tasks.get(taskId);
      if (current === undefined) {
        throw new PipelineStoreError(`task ${taskId} does not exist`);
      }
      // The SQL's compare-and-set (WP-138): null or the same iid, on the task's own branch.
      const sameOrNone = current.mr === null || current.mr.iid === mr.iid;
      const onBranch = current.branch === null || current.branch === (mr.branch ?? null);
      if (!sameOrNone || !onBranch) {
        return { kind: 'refused', recorded: current.mr === null ? null : clone(current.mr) };
      }
      // The same iid again keeps the stored head, like the SQL (review round 1): the head moves
      // forward only through `saveMergeRequestHead`.
      const parsed = mergeRequestRefSchema.parse(mr);
      const head = current.mr?.head_sha ?? parsed.head_sha ?? null;
      tasks.set(taskId, clone({ ...current, mr: { ...parsed, head_sha: head } }));
      return { kind: 'recorded' };
    },
    releaseMergeRequest: async (_tx, taskId, iid) => {
      const current = tasks.get(taskId);
      if (current === undefined) {
        throw new PipelineStoreError(`task ${taskId} does not exist`);
      }
      if (current.mr === null || current.mr.iid !== iid) {
        return false;
      }
      tasks.set(taskId, clone({ ...current, mr: null }));
      return true;
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
          !ticketSignalReaches(current, signal) ||
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
    listLiveByTicketId: async (_tx, query) =>
      [...tasks.values()]
        .filter(
          (stored) =>
            stored.task.projectId === query.projectId &&
            stored.task.ticket.provider === query.provider &&
            stored.task.ticket.id === query.ticketId &&
            stored.task.state !== 'done' &&
            stored.task.state !== 'cancelled',
        )
        .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
        .map(readTask),
    rekeyTicket: async (_tx, taskId, change) => {
      const current = tasks.get(taskId);
      if (
        current === undefined ||
        current.task.ticket.key !== change.fromKey ||
        current.task.state === 'done' ||
        current.task.state === 'cancelled'
      ) {
        return false;
      }
      // The `(project_id, ticket_key, mode)` unique key, refused rather than raised (the port says why).
      const holder = [...tasks.values()].find(
        (other) =>
          other.task.id !== taskId &&
          other.task.projectId === current.task.projectId &&
          other.task.ticket.key === change.ticketKey &&
          other.task.mode === current.task.mode,
      );
      if (holder !== undefined) {
        return false;
      }
      tasks.set(
        taskId,
        clone({
          ...current,
          task: {
            ...current.task,
            ticket: { ...current.task.ticket, key: change.ticketKey, url: change.ticketUrl },
          },
          branch: current.branch ?? change.pinBranch,
          version: current.version + 1,
        }),
      );
      return true;
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
    pauses: async (_tx, taskId) => {
      const events = options.taskEvents?.(taskId) ?? [];
      const pauses: TaskPause[] = [];
      for (const [index, event] of events.entries()) {
        if (event.type !== 'task.paused') {
          continue;
        }
        const ending = events
          .slice(index + 1)
          .find((later) => (PAUSE_ENDING_EVENTS as readonly string[]).includes(later.type));
        pauses.push({ pausedAt: event.occurred_at, endedAt: ending?.occurred_at ?? null });
      }
      return pauses;
    },
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
    ticketClaim: async (_tx, taskId) => {
      if (!tasks.has(taskId)) {
        throw new PipelineStoreError(`task ${taskId} does not exist`);
      }
      const stored = ticketClaims.get(taskId);
      return stored === undefined ? null : structuredClone(stored);
    },
    saveTicketClaim: async (_tx, taskId, claim) => {
      if (!tasks.has(taskId)) {
        throw new PipelineStoreError(`task ${taskId} does not exist`);
      }
      // Parsed on the way in as the SQL adapter parses it on the way out: a record the published
      // shape refuses is refused at the write here rather than at the next read.
      ticketClaims.set(taskId, storedTicketClaimSchema.parse(claim));
    },
    ownership: async (_tx, taskId) => {
      if (!tasks.has(taskId)) {
        throw new PipelineStoreError(`task ${taskId} does not exist`);
      }
      return structuredClone(ownerships.get(taskId) ?? UNOWNED);
    },
    saveOwner: async (_tx, taskId, write) => {
      if (!tasks.has(taskId)) {
        throw new PipelineStoreError(`task ${taskId} does not exist`);
      }
      const current = ownerships.get(taskId) ?? UNOWNED;
      // The SQL's compare-and-set: `owner_user_id is not distinct from` and `ticket_assignee is not
      // distinct from` the values the decision was made over (jsonb equality is by value).
      if (
        current.ownerUserId !== write.expected.ownerUserId ||
        JSON.stringify(current.ticketAssignee) !==
          JSON.stringify(
            write.expected.ticketAssignee === null
              ? null
              : ticketAssigneeSchema.parse(write.expected.ticketAssignee),
          )
      ) {
        return false;
      }
      ownerships.set(taskId, {
        ownerUserId: write.next.ownerUserId,
        ownerSource: write.next.ownerSource,
        ownerChangedAt: write.next.ownerChangedAt,
        ticketAssignee:
          write.next.ticketAssignee === null
            ? null
            : ticketAssigneeSchema.parse(write.next.ticketAssignee),
      });
      return true;
    },
    unownedLiveByAssignee: async (_tx, identity) =>
      [...tasks.values()]
        .filter((stored) => {
          const ownership = ownerships.get(stored.task.id) ?? UNOWNED;
          return (
            !isTerminalTaskState(stored.task.state) &&
            ownership.ownerUserId === null &&
            ownership.ticketAssignee !== null &&
            ownership.ticketAssignee.provider === identity.provider &&
            ownership.ticketAssignee.external_id === identity.externalId
          );
        })
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((stored) => ({ taskId: stored.task.id, projectId: stored.task.projectId })),
    // BACKLOG 1510: the SQL's predicate and bound; the order is divergence 16's.
    ownerBackfillDue: async (_tx, query) =>
      [...tasks.values()]
        .filter(
          (stored) =>
            backfillClaimable(backfillOf(stored.task.id), query) &&
            (ownerships.get(stored.task.id) ?? UNOWNED).ticketAssignee === null &&
            stored.task.mode === 'normal' &&
            !isTerminalTaskState(stored.task.state) &&
            Date.parse(stored.createdAt) < Date.parse(query.olderThan),
        )
        .sort(
          (a, b) => b.createdAt.localeCompare(a.createdAt) || a.task.id.localeCompare(b.task.id),
        )
        .slice(0, query.limit)
        .map((stored) => ({
          taskId: stored.task.id,
          projectId: stored.task.projectId,
          attempts: backfillOf(stored.task.id).attempts,
        })),
    claimOwnerBackfillAttempt: async (_tx, taskId, claim) => {
      const state = backfillOf(taskId);
      if (
        !tasks.has(taskId) ||
        state.settledAt !== null ||
        state.attempts !== claim.expectedAttempts ||
        (state.retryAt !== null && Date.parse(state.retryAt) > Date.parse(claim.now))
      ) {
        return null;
      }
      const attempts = state.attempts + 1;
      ownerBackfills.set(taskId, { ...state, attempts, retryAt: claim.retryAt });
      return attempts;
    },
    // S-28.5: the sweep's predicate, cutoff and claim; the order is divergence 16's.
    ticketStatusSweepDue: async (_tx, query) => {
      const revision = Date.parse(query.revisionAt);
      return [...tasks.values()]
        .filter(
          (stored) =>
            !(Date.parse(ticketStatusSweeps.get(stored.task.id) ?? '') >= revision) &&
            stored.task.mode === 'normal' &&
            !isTerminalTaskState(stored.task.state) &&
            Date.parse(stored.createdAt) < Date.parse(query.olderThan) &&
            Date.parse(stored.createdAt) < revision,
        )
        .sort(
          (a, b) => b.createdAt.localeCompare(a.createdAt) || a.task.id.localeCompare(b.task.id),
        )
        .slice(0, query.limit)
        .map((stored) => ({ taskId: stored.task.id, projectId: stored.task.projectId }));
    },
    claimTicketStatusSweep: async (_tx, taskId, at, revisionAt) => {
      const recorded = ticketStatusSweeps.get(taskId);
      if (
        !tasks.has(taskId) ||
        (recorded !== undefined && Date.parse(recorded) >= Date.parse(revisionAt))
      ) {
        return false;
      }
      ticketStatusSweeps.set(taskId, Date.parse(at) > Date.parse(revisionAt) ? at : revisionAt);
      return true;
    },
    ticketStatusStopOf: async (_tx, taskId) => ticketStatusStops.get(taskId) ?? null,
    recordTicketStatusStop: async (_tx, taskId, status) => {
      ticketStatusStops.set(taskId, status);
    },
    settleOwnerBackfill: async (_tx, taskId, at) => {
      const state = backfillOf(taskId);
      if (!tasks.has(taskId) || state.settledAt !== null) {
        return false;
      }
      ownerBackfills.set(taskId, { ...state, settledAt: at });
      return true;
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
    ownerAdmission: async (_tx, ownerUserId) => ({
      inFlight: [...tasks.values()].filter(
        (stored) =>
          (ownerships.get(stored.task.id) ?? UNOWNED).ownerUserId === ownerUserId &&
          countsTowardOwner(stored.task.state),
      ).length,
      personalLimit: personalLimits.get(ownerUserId) ?? null,
    }),
    queuedProjectsOfOwners: async (_tx, ownerUserIds) =>
      [
        ...new Set(
          [...tasks.values()]
            .filter(
              (stored) =>
                stored.task.state === 'queued' &&
                ownerUserIds.includes(
                  (ownerships.get(stored.task.id) ?? UNOWNED).ownerUserId as Id,
                ),
            )
            .map((stored) => stored.task.projectId),
        ),
      ].sort(),
    queued: async (_tx, projectId): Promise<readonly QueuedTask[]> =>
      [...tasks.values()]
        .filter((stored) => stored.task.projectId === projectId && stored.task.state === 'queued')
        .map((stored) => ({
          id: stored.task.id,
          priorityRank: stored.priorityRank,
          createdAt: stored.createdAt,
          ownerUserId: (ownerships.get(stored.task.id) ?? UNOWNED).ownerUserId,
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
        attachedFeedback: null,
        attachedFeedbackOriginalChars: null,
        attachedFeedbackSent: false,
        signature: null,
        enteredAt: sequence,
        enteredAtMs: stageClock(),
        exitedAt: null,
      });
    },
    countStageRunEnding: async (_tx, entry) => {
      const row = [...stages]
        .reverse()
        .find(
          (candidate) =>
            candidate.taskId === entry.taskId &&
            candidate.stage === entry.stage &&
            candidate.attempt === entry.attempt,
        );
      if (row === undefined) return null;
      if (entry.kind === 'lost') {
        row.lostRuns = (row.lostRuns ?? 0) + 1;
        return row.lostRuns;
      }
      row.usageLimitedRuns = (row.usageLimitedRuns ?? 0) + 1;
      return row.usageLimitedRuns;
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
          attachedFeedback: null,
          attachedFeedbackOriginalChars: null,
          attachedFeedbackSent: false,
          signature: entry.signature,
          enteredAt: sequence,
          enteredAtMs: stageClock(),
          exitedAt: null,
        });
        return;
      }
      row.signature = entry.signature;
    },
    /**
     * The SQL store's `update … where state = 'returned' and return_reason <> ''` (WP-152): the
     * reason moves with its cut length and the person's choice, and a row that is open, closed
     * another way or holds no (or an empty) reason moves nothing.
     */
    attachReturnReason: async (_tx, entry) => {
      const row = [...stages]
        .reverse()
        .find(
          (candidate) =>
            candidate.taskId === entry.taskId &&
            candidate.stage === entry.stage &&
            candidate.attempt === entry.attempt,
        );
      if (
        row === undefined ||
        row.state !== 'returned' ||
        row.returnReason === null ||
        row.returnReason === ''
      ) {
        return false;
      }
      row.attachedFeedback = row.returnReason;
      row.attachedFeedbackOriginalChars = row.returnReasonOriginalChars;
      row.attachedFeedbackSent = entry.send;
      return true;
    },
    stageAttemptState: async (_tx, taskId, stage, attempt) => {
      const row = stages.find(
        (candidate) =>
          candidate.taskId === taskId && candidate.stage === stage && candidate.attempt === attempt,
      );
      if (row === undefined) return 'absent';
      return row.state === 'running' && row.exitedAt === null ? 'open' : 'closed';
    },
    // S-28.10: the SQL's upsert, delete and read over `task_provider_sync`, insertion order.
    providerSync: async (_tx, taskId) =>
      [...providerSyncRows.values()]
        .filter((entry) => entry.taskId === taskId)
        .map((entry) => clone(entry.row)),
    recordProviderSyncFailure: async (_tx, taskId, failure) => {
      const key = `${taskId}#${failure.subject}`;
      const previous = providerSyncRows.get(key);
      const row: ProviderSync = { ...clone(failure), attempts: (previous?.row.attempts ?? 0) + 1 };
      if (previous !== undefined) providerSyncRows.delete(key);
      providerSyncRows.set(key, { taskId, row });
    },
    clearProviderSync: async (_tx, taskId, subject) =>
      providerSyncRows.delete(`${taskId}#${subject}`),
    // S-28.13: the SQL's predicate, claim and upsert over `task_merge_checks`.
    readyMergeCheckDue: async (_tx, query) => {
      const stale = Date.parse(query.staleBefore);
      const due = (taskId: Id): boolean => {
        const row = mergeChecks.get(taskId);
        const stored = tasks.get(taskId);
        return (
          row === undefined ||
          (row.check?.mergeable !== true && Date.parse(row.claimedAt) < stale) ||
          (stored !== undefined && mergeRowDue(stored, stale))
        );
      };
      return [...tasks.values()]
        .filter(
          (stored) =>
            stored.task.state === 'ready_for_merge' &&
            stored.task.mode === 'normal' &&
            stored.mr !== null &&
            due(stored.task.id),
        )
        .sort(
          (a, b) => b.createdAt.localeCompare(a.createdAt) || a.task.id.localeCompare(b.task.id),
        )
        .slice(0, query.limit)
        .map((stored) => ({ taskId: stored.task.id, projectId: stored.task.projectId }));
    },
    claimReadyMergeCheck: async (_tx, taskId, at, staleBefore) => {
      if (!tasks.has(taskId)) return false;
      const row = mergeChecks.get(taskId);
      if (row === undefined) {
        mergeChecks.set(taskId, { claimedAt: at, check: null });
        return true;
      }
      const stored = tasks.get(taskId);
      const stale = Date.parse(staleBefore);
      const due =
        (row.check?.mergeable !== true && Date.parse(row.claimedAt) < stale) ||
        (stored !== undefined && mergeRowDue(stored, stale));
      if (!due) {
        return false;
      }
      mergeChecks.set(taskId, { ...row, claimedAt: at });
      return true;
    },
    recordReadyMergeCheck: async (_tx, taskId, check) => {
      const row = mergeChecks.get(taskId);
      mergeChecks.set(taskId, {
        ...row,
        claimedAt: row?.claimedAt ?? check.checkedAt,
        check: { ...check },
      });
    },
    // S-28.15: the SQL's upsert of the two decision columns, and `task_merges`.
    recordMergeDecision: async (_tx, taskId, decision) => {
      const row = mergeChecks.get(taskId);
      mergeChecks.set(taskId, {
        claimedAt: row?.claimedAt ?? new Date().toISOString(),
        check: row?.check ?? null,
        mergeBy: decision.mergeBy,
        mergeWait: decision.wait,
      });
    },
    mergeDecisionOf: async (_tx, taskId) => {
      const row = mergeChecks.get(taskId);
      return row === undefined
        ? null
        : { mergeBy: row.mergeBy ?? null, wait: row.mergeWait ?? null };
    },
    recordMerge: async (_tx, merge) => {
      const key = `${merge.taskId}#${merge.headSha}#${mergeKind(merge.outcome)}`;
      if (!tasks.has(merge.taskId) || taskMerges.has(key)) return false;
      taskMerges.set(key, { ...merge });
      return true;
    },
    mergeFor: async (_tx, taskId, headSha) => {
      const merge =
        taskMerges.get(`${taskId}#${headSha}#merge`) ??
        taskMerges.get(`${taskId}#${headSha}#rebase`);
      return merge === undefined ? null : { ...merge };
    },
    latestMerge: async (_tx, taskId) => {
      const latest = [...taskMerges.values()]
        .filter((merge) => merge.taskId === taskId)
        .sort(
          (a, b) =>
            b.attemptedAt.localeCompare(a.attemptedAt) ||
            b.headSha.localeCompare(a.headSha) ||
            Number(mergeKind(b.outcome) === 'merge') - Number(mergeKind(a.outcome) === 'merge'),
        )[0];
      return latest === undefined ? null : { ...latest };
    },
    mergesOf: async (_tx, taskId) =>
      [...taskMerges.values()]
        .filter((merge) => merge.taskId === taskId)
        .sort(
          (a, b) =>
            b.attemptedAt.localeCompare(a.attemptedAt) ||
            b.headSha.localeCompare(a.headSha) ||
            Number(mergeKind(b.outcome) === 'merge') - Number(mergeKind(a.outcome) === 'merge'),
        )
        .map((merge) => ({ ...merge })),
    settleRebase: async (_tx, taskId, headSha, settled) => {
      const key = `${taskId}#${headSha}#rebase`;
      const merge = taskMerges.get(key);
      if (merge === undefined || merge.outcome !== 'rebased' || merge.rebasedTo !== null) {
        return false;
      }
      taskMerges.set(key, {
        ...merge,
        outcome: settled.outcome,
        providerStatus: settled.providerStatus,
        rebasedTo: settled.rebasedTo,
      });
      return true;
    },
    countMergeSignalPass: async (_tx, taskId, headSha) => {
      const key = `${taskId}#${headSha}#merge`;
      const merge = taskMerges.get(key);
      if (merge === undefined || merge.outcome !== 'merged') return 0;
      const next = { ...merge, signalPasses: merge.signalPasses + 1 };
      taskMerges.set(key, next);
      return next.signalPasses;
    },
    readyMergeCheckOf: async (_tx, taskId) => {
      const check = mergeChecks.get(taskId)?.check ?? null;
      return check === null ? null : { ...check };
    },
    // S-28.1: the SQL's join through `runs.task_stage_id`, here the run's own stage and attempt.
    stageAttemptRuns: async (_tx, taskId, stage, attempt) =>
      [...runs.values()].filter(
        (run) => run.taskId === taskId && run.stage === stage && run.attempt === attempt,
      ).length,
    reenterOpenStage: async (_tx, entry) => {
      const row = stages.find(
        (candidate) =>
          candidate.taskId === entry.taskId &&
          candidate.stage === entry.stage &&
          candidate.attempt === entry.attempt,
      );
      if (row === undefined || row.state !== 'running' || row.exitedAt !== null) return false;
      sequence += 1;
      row.enteredAt = sequence;
      row.enteredAtMs = stageClock();
      return true;
    },
    stageAttemptEntry: async (_tx, taskId, stage, attempt) => {
      const row = stages.find(
        (candidate) =>
          candidate.taskId === taskId && candidate.stage === stage && candidate.attempt === attempt,
      );
      if (row === undefined) return null;
      return {
        open: row.state === 'running' && row.exitedAt === null,
        enteredAt: new Date(row.enteredAtMs).toISOString() as IsoDateTime,
      };
    },
    // Backlog 1078: the SQL store's two statements — open rows only, and parsed both ways.
    recordCiPendingRead: async (_tx, entry, read) => {
      const row = stages.find(
        (candidate) =>
          candidate.taskId === entry.taskId &&
          candidate.stage === entry.stage &&
          candidate.attempt === entry.attempt &&
          candidate.state === 'running' &&
          candidate.exitedAt === null,
      );
      if (row === undefined) return false;
      row.ciPendingRead = read === null ? null : clone(ciPendingReadSchema.parse(read));
      return true;
    },
    ciPendingReadOf: async (_tx, taskId, stage, attempt) => {
      const value =
        stages.find(
          (row) => row.taskId === taskId && row.stage === stage && row.attempt === attempt,
        )?.ciPendingRead ?? null;
      return value === null ? null : ciPendingReadSchema.parse(value);
    },
    recordCiEnding: async (_tx, entry, ending) => {
      const row = stages.find(
        (candidate) =>
          candidate.taskId === entry.taskId &&
          candidate.stage === entry.stage &&
          candidate.attempt === entry.attempt &&
          candidate.state === 'running' &&
          candidate.exitedAt === null,
      );
      if (row === undefined) return false;
      row.ciEnding = ciGateEndingSchema.parse(ending);
      return true;
    },
    // S-27.2: the SQL store's statement — the open row of the stage (of `attempt`, when named).
    recordCiManualNotRun: async (_tx, entry, value) => {
      const row = stages.find(
        (candidate) =>
          candidate.taskId === entry.taskId &&
          candidate.stage === entry.stage &&
          (entry.attempt === undefined || candidate.attempt === entry.attempt) &&
          candidate.state === 'running' &&
          candidate.exitedAt === null,
      );
      if (row === undefined) return false;
      row.ciManualNotRun = clone(ciManualNotRunSchema.parse(value));
      return true;
    },
    // S-28.7: the SQL store's statement — the open row of the attempt, one entry per job id.
    recordCiManualStarted: async (_tx, entry, job) => {
      const row = stages.find(
        (candidate) =>
          candidate.taskId === entry.taskId &&
          candidate.stage === entry.stage &&
          candidate.attempt === entry.attempt &&
          candidate.state === 'running' &&
          candidate.exitedAt === null,
      );
      if (row === undefined) return false;
      // S-28.7: the bound is one rule for both stores (`withCiManualStartedEntry`).
      const next = withCiManualStartedEntry(row.ciManualStarted ?? null, job);
      if (next === null) return false;
      row.ciManualStarted = clone(ciManualStartedSchema.parse(next));
      return true;
    },
    ciManualStartedOf: async (_tx, taskId, stage, attempt) => {
      const value =
        stages.find(
          (row) => row.taskId === taskId && row.stage === stage && row.attempt === attempt,
        )?.ciManualStarted ?? null;
      return value === null ? null : ciManualStartedSchema.parse(value);
    },
    latestCiManualNotRun: async (_tx, taskId, stage) => {
      const newest = stages
        .filter((row) => row.taskId === taskId && row.stage === stage)
        .sort((a, b) => b.attempt - a.attempt)[0];
      if (newest === undefined || newest.state !== 'completed' || newest.exitedAt === null) {
        return null;
      }
      const passedAt = newest.exitedAt;
      const sentBack = stages.some(
        (row) =>
          row.taskId === taskId &&
          row.state === 'returned' &&
          row.exitedAt !== null &&
          row.exitedAt > passedAt,
      );
      const value = sentBack ? null : (newest.ciManualNotRun ?? null);
      return value === null ? null : ciManualNotRunSchema.parse(value);
    },
    previousCiPendingRead: async (_tx, taskId, stage, attempt) => {
      const previous = stages
        .filter((row) => row.taskId === taskId && row.stage === stage && row.attempt < attempt)
        .sort((a, b) => b.attempt - a.attempt)[0];
      const value = previous?.ciPendingRead ?? null;
      return value === null ? null : ciPendingReadSchema.parse(value);
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
    observeHumanStageStatus: async (_tx, entry) => {
      // The SQL statement's `coalesce` and `or`, over the attempt's row.
      const row = [...stages]
        .reverse()
        .find(
          (candidate) =>
            candidate.taskId === entry.taskId &&
            candidate.stage === entry.stage &&
            candidate.attempt === entry.attempt,
        );
      if (row === undefined) {
        return null;
      }
      row.entryTicketStatus = row.entryTicketStatus ?? entry.entryStatus;
      row.ticketSeenAtQa = (row.ticketSeenAtQa ?? false) || entry.seenAtQa;
      return { entryStatus: row.entryTicketStatus, seenAtQa: row.ticketSeenAtQa };
    },
    observeTicketForward: async (_tx, entry) => {
      // The SQL statement's `coalesce`, over the attempt's row (migration 0111).
      const row = [...stages]
        .reverse()
        .find(
          (candidate) =>
            candidate.taskId === entry.taskId &&
            candidate.stage === entry.stage &&
            candidate.attempt === entry.attempt,
        );
      if (row === undefined) {
        return null;
      }
      row.ticketForwardSeenAt = row.ticketForwardSeenAt ?? entry.at;
      return row.ticketForwardSeenAt;
    },
    recordConversationHandled: async (_tx, rows) => {
      // The SQL's check and its `on conflict do nothing` over the unique key (migration 0111).
      let added = 0;
      for (const row of rows) {
        if (
          !CONVERSATION_HANDLED_ID.test(row.threadId) ||
          (row.lastNoteId !== null && !CONVERSATION_HANDLED_ID.test(row.lastNoteId)) ||
          (row.author !== null && row.author.length > MAX_CONVERSATION_HANDLED_AUTHOR_CHARS)
        ) {
          throw new Error('task_conversation_handled: a value outside the table’s checks');
        }
        if (!tasks.has(row.taskId)) {
          throw new Error('task_conversation_handled: no such task');
        }
        const exists = conversationHandled.some(
          (stored) =>
            stored.taskId === row.taskId &&
            stored.source === row.source &&
            stored.threadId === row.threadId &&
            stored.kind === row.kind &&
            stored.lastNoteId === row.lastNoteId,
        );
        if (!exists) {
          conversationHandled.push({ ...row });
          added += 1;
        }
      }
      return added;
    },
    conversationHandled: async (_tx, taskId) =>
      conversationHandled
        .filter((row) => row.taskId === taskId)
        .reverse()
        .slice(0, MAX_CONVERSATION_HANDLED_ROWS)
        .map((row) => ({ ...row })),
    ticketStatusChangesSinceEntry: async (_tx, query) => {
      // The SQL store's predicate over the committed log (divergence 12).
      const task = tasks.get(query.taskId);
      const log = options.committedLog?.() ?? [];
      if (task === undefined) {
        return [];
      }
      const entry = log
        .filter(
          ({ event }) =>
            event.stream_type === 'task' &&
            event.stream_id === query.taskId &&
            event.type === 'task.stage.entered' &&
            event.payload.stage === query.stage,
        )
        .at(-1)?.position;
      if (entry === undefined) {
        return [];
      }
      const ticket = task.task.ticket;
      const matched = log
        .flatMap(({ position, event }) =>
          event.type === 'ticket.status.changed' ? [{ position, event }] : [],
        )
        .filter(({ position, event }) => {
          if (
            position <= entry ||
            event.stream_type !== 'project' ||
            event.stream_id !== task.task.projectId ||
            event.payload.ticket.provider !== ticket.provider
          ) {
            return false;
          }
          const id = event.payload.ticket.id ?? null;
          return id !== null && (ticket.id ?? null) !== null
            ? id === ticket.id
            : event.payload.ticket.key === ticket.key;
        })
        .map(({ event }) => ({ from: event.payload.from, to: event.payload.to }));
      return (query.order === 'oldest_first' ? matched : [...matched].reverse()).slice(
        0,
        query.limit,
      );
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
        // WP-152: the gate's last failure a person sent on, beside their note — kept but not
        // handed on when they unticked it.
        ...(found.attachedFeedback === null || !found.attachedFeedbackSent
          ? {}
          : {
              attached: {
                reason: found.attachedFeedback,
                originalChars: found.attachedFeedbackOriginalChars,
              },
            }),
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
      // `contextPack` (WP-57) is kept beside the row, not on it: `load` answers no pack, and the
      // readers that want one are the API projection and, since WP-276 (backlog 709), the
      // claimant's `contextPack`, which reads it back as the SQL adapter does. `settings` (WP-91)
      // is dropped: `load` does not select `settings_snapshot`/`settings_hash`.
      const {
        systemPrompt: _s,
        userPrompt: _u,
        redactionCount: _r,
        contextPack,
        settings: _g,
        // WP-121: write-only too — the API projection reads `runs.prompts_withheld`, `load` does not.
        promptsWithheld: _w,
        reserveUsd,
        // WP-149: kept beside the row rather than on it — `load` does not select `ask_id` either.
        askId,
        // Backlog 454: write-only too; read back through `providerModeOf`.
        providerMode,
        // WP-150: never written by `insert`, in either store — only its compare-and-set writes it.
        cliSpawnRequestedAt: _m,
        ...stored
      } = run;
      providerModes.set(run.id, providerMode);
      if (contextPack !== null) {
        contextPacks.set(run.id, clone(contextPack));
      }
      runs.set(run.id, clone({ ...stored, stage: linked ? run.stage : null }));
      if (askId !== undefined) {
        askOfRun.set(run.id, askId);
      }
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
      // WP-274: a claimant's fence, the SQL adapter's `lease_epoch`/`lease_owner` predicate. A live
      // row under another claim is `lease_lost`, thrown so the caller's transaction rolls back.
      if (outcome.lease !== undefined && !fenceHolds(outcome.runId, outcome.lease)) {
        throw new LeaseLostError(outcome.runId, outcome.lease);
      }
      endedAts.set(outcome.runId, new Date(stageClock()).toISOString() as IsoDateTime);
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
      if (outcome.startFailure !== undefined) {
        startFailures.set(outcome.runId, clone(outcome.startFailure));
      }
      if (outcome.savedWork !== undefined) {
        savedWorks.set(outcome.runId, clone(outcome.savedWork));
      }
      // The winner closes the run's offer (WP-274, TD-031 §12), as the SQL adapter does.
      closeOffer(outcome.runId, outcome.terminalReason);
      // …and clears its sealed plan (WP-275a), in the same write.
      const plan = plans.get(outcome.runId);
      if (plan !== undefined) {
        plans.set(outcome.runId, { ...plan, sealedSpec: null });
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
    /**
     * Conditional on the run being live and on the claim's fence — `lease_epoch` and `lease_owner`
     * both the caller's (WP-274), the SQL adapter's predicate. It only renews: the claim writes the
     * owner.
     */
    renewLease: async (_tx, lease) => {
      const run = runs.get(lease.runId);
      if (run === undefined || !isActiveRunStatus(run.status)) {
        return false;
      }
      if (!fenceHolds(lease.runId, { epoch: lease.epoch, owner: lease.owner })) {
        return false;
      }
      leases.set(lease.runId, { owner: lease.owner, expiresAt: lease.expiresAt });
      return true;
    },
    /** No lock to take in a single-threaded store (divergence 9's reasoning); the row as it stands. */
    lockSettlement: async (_tx, runId) => {
      const run = runs.get(runId);
      return run === undefined
        ? null
        : {
            runId,
            status: run.status,
            terminalReason: run.terminalReason,
            leaseEpoch: epochs.get(runId) ?? 0,
            leaseOwner: leases.get(runId)?.owner ?? null,
          };
    },
    /** WP-150's compare-and-set, with the SQL adapter's two predicates: still live, still unmarked. */
    markCliSpawnRequested: async (_tx, marker) => {
      const run = runs.get(marker.runId);
      if (run === undefined) {
        throw new PipelineStoreError(`run ${marker.runId} does not exist`);
      }
      if (!isActiveRunStatus(run.status) || spawnMarkers.has(marker.runId)) {
        return false;
      }
      // WP-275b: fenced on the claim, as the SQL's predicate; a live row under another claim throws.
      if (marker.lease !== undefined && !fenceHolds(marker.runId, marker.lease)) {
        throw new LeaseLostError(marker.runId, marker.lease);
      }
      spawnMarkers.set(marker.runId, marker.at);
      // …and the run's `starting → running`, with `started_at`, in the same write (WP-275b).
      runs.set(marker.runId, { ...run, status: 'running', startedAt: marker.at });
      return true;
    },
    /**
     * WP-275a's counter, the SQL's walk: the entry's runs before `runId` in insertion (`created_at`)
     * order, counted back while each ended `error_during_execution` with a start failure recorded.
     */
    startFailures: async (_tx, entry) => {
      const entryRuns = [...runs.values()].filter(
        (run) =>
          run.taskId === entry.taskId && run.stage === entry.stage && run.attempt === entry.attempt,
      );
      const index = entryRuns.findIndex((run) => run.id === entry.runId);
      const before = index < 0 ? entryRuns : entryRuns.slice(0, index);
      let count = 0;
      for (const run of before.reverse()) {
        if (run.terminalReason !== 'error_during_execution' || !startFailures.has(run.id)) break;
        count += 1;
      }
      return count;
    },
    load: async (_tx, runId) => {
      const run = runs.get(runId);
      return run === undefined
        ? null
        : {
            ...clone(run),
            cliSpawnRequestedAt: spawnMarkers.get(runId) ?? null,
            // WP-276: the SQL adapter's `load` names `ask_id`.
            askId: askOfRun.get(runId) ?? null,
          };
    },
    /** Backlog 709: the pack transaction 1b stored, read back — the SQL adapter's rows and header. */
    contextPack: async (_tx, runId) => {
      const pack = contextPacks.get(runId);
      return pack === undefined ? null : clone(pack);
    },
    /** WP-149's ask bound, over this store's rows with the SQL adapter's predicate. */
    askShutdownEndings: async (_tx, askId) =>
      [...runs.values()].filter(
        (run) => askOfRun.get(run.id) === askId && run.terminalReason === 'shutdown',
      ).length,
    /**
     * Backlog 467: the latest ended run of the stage, in insertion order — the order `runs` rows
     * are created in here, which is the SQL adapter's `created_at, id` (uuidv7).
     */
    lastSavedWork: async (_tx, query) => {
      const ended = [...runs.values()].filter(
        (run) =>
          run.taskId === query.taskId &&
          run.stage === query.stage &&
          !isActiveRunStatus(run.status),
      );
      const latest = ended.at(-1);
      const saved = latest === undefined ? undefined : savedWorks.get(latest.id);
      if (latest === undefined || saved === undefined || latest.terminalReason === null) {
        return null;
      }
      return {
        runId: latest.id,
        terminalReason: latest.terminalReason,
        numTurns: latest.numTurns,
        savedWork: clone(saved),
      };
    },
    /** Backlog 476: {@link lastSavedWork}'s row, however it ended. */
    latestStartedAt: async (_tx, query) => {
      // Insertion order is `created_at` order here, as in `lastEnded`.
      const latest = [...runs.values()]
        .filter((run) => run.taskId === query.taskId && run.stage === query.stage)
        .at(-1);
      return latest === undefined ? null : (latest.startedAt ?? latest.createdAt);
    },
    lastEnded: async (_tx, query) => {
      const latest = [...runs.values()]
        .filter(
          (run) =>
            run.taskId === query.taskId &&
            run.stage === query.stage &&
            !isActiveRunStatus(run.status),
        )
        .at(-1);
      return latest === undefined
        ? null
        : {
            runId: latest.id,
            status: latest.status,
            terminalReason: latest.terminalReason,
            numTurns: latest.numTurns,
          };
    },
    /** WP-144's bound, over this store's rows with the SQL adapter's predicate. */
    shutdownEndings: async (_tx, entry) =>
      [...runs.values()].filter(
        (run) =>
          run.taskId === entry.taskId &&
          run.stage === entry.stage &&
          run.attempt === entry.attempt &&
          run.terminalReason === 'shutdown',
      ).length,
    totalsFor: async (_tx, taskId) => {
      const owned = [...runs.values()].filter((run: StoredRun) => run.taskId === taskId);
      return {
        runs: owned.length,
        costUsd: owned.reduce((total, run) => total + (run.cost?.usd ?? 0), 0),
        isEstimate: owned.some((run) => run.cost?.is_estimate === true && !floors.has(run.id)),
        unmeasuredRuns: owned.filter((run) => endedUnmeasured(run, floors, spawnMarkers)).length,
        wallMs: owned.reduce((total, run) => total + run.wallMs, 0),
      };
    },
    /** The task cap's hold (WP-131), over this store's rows with the SQL adapter's predicate. */
    heldFor: async (_tx, taskId, admittingReserveUsd) =>
      holdOf(
        [...runs.values()]
          .filter((run) => run.taskId === taskId && endedUnmeasured(run, floors, spawnMarkers))
          .map((run) => reserves.get(run.id) ?? null),
        admittingReserveUsd,
      ),
  };

  /** The SQL's `lease_epoch = $e and lease_owner is not distinct from $o` (WP-274). */
  function fenceHolds(runId: Id, fence: { readonly epoch: number; readonly owner: string | null }) {
    return (
      (epochs.get(runId) ?? 0) === fence.epoch &&
      (leases.get(runId)?.owner ?? null) === fence.owner &&
      // WP-281 (backlog 714): a run a remote worker holds is fenced on that worker still being able
      // to act, as the SQL's `runHolderUsableSql` is.
      holderUsable(runId)
    );
  }

  /** `RunRepository.finish`'s closing of the offer: `claimed → settled`, `open → withdrawn`. */
  function closeOffer(runId: Id, terminalReason: string) {
    const offer = offers.get(runId);
    if (offer === undefined) {
      return;
    }
    const at = new Date(stageClock()).toISOString() as IsoDateTime;
    if (offer.state === 'claimed') {
      offers.set(runId, { ...offer, state: 'settled', settledAt: at });
    } else if (offer.state === 'open') {
      offers.set(runId, {
        ...offer,
        state: 'withdrawn',
        withdrawnAt: at,
        withdrawnReason: terminalReason,
      });
    }
  }

  /**
   * `run_offers` (WP-274) with the database's two refusals spelled out — `run_id` unique, and the
   * per-task partial unique index over open or claimed **stage** offers — so a test that would
   * violate the index fails here as it would there (standing rule 1).
   */
  /** The SQL's `workerEligibleSql` over an open offer (WP-281; divergence 13). */
  function workerEligible(
    candidate: StoredRunOffer,
    claim: { readonly worker?: RemoteListing; readonly now: IsoDateTime },
  ): boolean {
    const worker = claim.worker;
    if (worker === undefined) return false;
    const known = options.remoteWorkers?.(worker.workerId);
    if (known === undefined || !known.usable) return false;
    if (known.pausedUntil !== null && Date.parse(known.pausedUntil) > Date.parse(claim.now)) {
      return false;
    }
    if (known.manuallyPaused === true) return false;
    const coolDown = known.workspaceUnavailableUntil ?? null;
    if (coolDown !== null && Date.parse(coolDown) > Date.parse(claim.now)) return false;
    if (!known.memberOf(candidate.projectId)) return false;
    const remote = remoteOf(candidate.runId);
    if (remote.excluded.includes(worker.workerId)) return false;
    const images = remote.images ?? worker.images;
    if (
      !worker.heldImageDigests.includes(images.run) ||
      !worker.heldImageDigests.includes(images.egress)
    ) {
      return false;
    }
    const source = options.runCredentialSource?.(candidate.projectId) ?? null;
    if (
      source !== null &&
      source !== 'minted' &&
      (options.remoteRunCredential?.(candidate.projectId) ?? 'deny') !== 'allow'
    ) {
      return false;
    }
    const { workersFrom, assigneeUserId, assigneeUntil } = candidate.routing;
    const now = Date.parse(claim.now);
    return (
      (workersFrom !== null && Date.parse(workersFrom) <= now) ||
      (assigneeUserId === known.userId && assigneeUntil !== null && now < Date.parse(assigneeUntil))
    );
  }

  /** The SQL's `workerScopeTakesSql` (WP-293; S-26.4: a legacy `[]` narrows nothing). */
  function scopeTakes(candidate: StoredRunOffer, workerId: Id): boolean {
    const scope = options.remoteWorkers?.(workerId)?.claimProjectIds ?? null;
    return projectListTakes(scope, candidate.projectId);
  }

  /**
   * The SQL's `offerIsMineSql` (S-26.4): a stage offer's task owned by `userId`, or an ask they
   * asked. **Divergence 15**: this store keeps no `task_asks`, so an ask's asker is read off the
   * offer's assignee — which the ask executor always sets to the asker (`assigneeUserId:
   * ask.askedByUserId`), the SQL reading `task_asks.asked_by_user_id` itself.
   */
  function offerIsMine(candidate: StoredRunOffer, userId: Id): boolean {
    return candidate.kind === 'ask'
      ? candidate.routing.assigneeUserId === userId
      : (ownerships.get(candidate.taskId) ?? UNOWNED).ownerUserId === userId;
  }

  /** The SQL's `taskHeldElsewhereSql` over the directory, live (S-26.1, divergence 14). */
  function heldElsewhereOf(taskId: Id, projectId: Id): boolean {
    const assignee = (ownerships.get(taskId) ?? UNOWNED).ticketAssignee;
    return taskHeldElsewhere({
      ticketAssignee: assignee,
      assigneeIsLinkedMember:
        assignee !== null &&
        classify(projectId, assignee.provider, assignee.external_id).kind === 'member',
    });
  }

  /** The SQL's `workerPolicyTakesSql` (S-26.4): the domain's `claimPolicyTakes`, read live. */
  function policyTakes(candidate: StoredRunOffer, workerId: Id): boolean {
    const known = options.remoteWorkers?.(workerId);
    if (known === undefined) return false;
    const policy = effectiveClaimPolicy(known.claimPolicy ?? null, known.claimProjectIds ?? null);
    const owner = (ownerships.get(candidate.taskId) ?? UNOWNED).ownerUserId;
    return claimPolicyTakes(policy, {
      mine: offerIsMine(candidate, known.userId),
      unassigned:
        candidate.kind === 'stage' &&
        taskIsUnassigned({
          ownerUserId: owner,
          heldElsewhere: heldElsewhereOf(candidate.taskId, candidate.projectId),
        }),
    });
  }

  /** The SQL's `pickOwnershipAdmitsSql` (S-26.4): an ask, or a stage task nobody's or the picker's. */
  function pickOwnershipAdmits(candidate: StoredRunOffer, workerId: Id): boolean {
    if (candidate.kind !== 'stage') return true;
    const owner = (ownerships.get(candidate.taskId) ?? UNOWNED).ownerUserId;
    return owner === null || owner === options.remoteWorkers?.(workerId)?.userId;
  }

  /** An open offer of a live run — the claim's and the list's first two conjuncts. */
  const openLive = (candidate: StoredRunOffer): boolean =>
    candidate.state === 'open' &&
    isActiveRunStatus(runs.get(candidate.runId)?.status ?? 'completed');

  const offerRepository: RunOfferRepository = {
    claimable: async (_tx, input) =>
      [...offers.values()]
        .filter(
          (candidate) =>
            openLive(candidate) &&
            workerEligible(candidate, { worker: input.worker, now: input.now }),
        )
        .sort((a, b) => Date.parse(a.offeredAt) - Date.parse(b.offeredAt))
        .filter((candidate) => scopeTakes(candidate, input.worker.workerId))
        .slice(0, input.limit)
        .map((candidate) => {
          const owner = (ownerships.get(candidate.taskId) ?? UNOWNED).ownerUserId;
          const userId = options.remoteWorkers?.(input.worker.workerId)?.userId;
          return {
            runId: candidate.runId,
            taskId: candidate.taskId,
            projectId: candidate.projectId,
            kind: candidate.kind,
            stage: candidate.stage,
            role: (runs.get(candidate.runId)?.role ?? 'developer') as AgentRole,
            offeredAt: candidate.offeredAt,
            automatic: policyTakes(candidate, input.worker.workerId),
            // Divergence 15: no `users` here, so the owner's name is not known.
            owner: owner === null ? null : { userId: owner, name: '' },
            mine: userId !== undefined && offerIsMine(candidate, userId),
            heldElsewhere: heldElsewhereOf(candidate.taskId, candidate.projectId),
          };
        }),
    pickOwnerRefusal: async (_tx, input) => {
      const candidate = offers.get(input.runId);
      if (
        candidate === undefined ||
        candidate.kind !== 'stage' ||
        !openLive(candidate) ||
        !workerEligible(candidate, { worker: input.worker, now: input.now })
      ) {
        return null;
      }
      const ownership = ownerships.get(candidate.taskId) ?? UNOWNED;
      const owner = ownership.ownerUserId;
      if (owner === null || owner === options.remoteWorkers?.(input.worker.workerId)?.userId) {
        return null;
      }
      return { owner: { userId: owner, name: '' }, ownerChangedAt: ownership.ownerChangedAt };
    },
    insert: async (_tx, offer) => {
      if (offers.has(offer.runId)) {
        throw new PipelineStoreError(
          `run ${offer.runId} already has an offer (run_offers.run_id is unique)`,
        );
      }
      if (
        offer.kind === 'stage' &&
        [...offers.values()].some(
          (other) =>
            other.taskId === offer.taskId &&
            other.kind === 'stage' &&
            (other.state === 'open' || other.state === 'claimed'),
        )
      ) {
        throw new PipelineStoreError(
          `task ${offer.taskId} already has an open or claimed stage offer (run_offers_one_live_stage_per_task)`,
        );
      }
      const { excludedWorkerIds, ...stored } = offer;
      if (excludedWorkerIds !== undefined && excludedWorkerIds.length > 0) {
        offerRemote.set(offer.runId, {
          ...remoteOf(offer.runId),
          excluded: [...new Set(excludedWorkerIds)],
        });
      }
      offers.set(offer.runId, {
        ...clone(stored),
        state: 'open',
        leaseEpoch: 0,
        claimantKind: null,
        claimedAt: null,
        settledAt: null,
        withdrawnAt: null,
        withdrawnReason: null,
      });
    },
    claim: async (_tx, claim) => {
      if (claim.worker?.pick === true && claim.eligibility.runId === undefined) {
        throw new PipelineStoreError('a pick names its run (RemoteClaimant.pick, WP-293)');
      }
      const offer = [...offers.values()]
        .filter(
          (candidate) =>
            openLive(candidate) &&
            (claim.eligibility.runId === undefined ||
              candidate.runId === claim.eligibility.runId) &&
            // WP-278: the server's eligibility, as the SQL claim spells it.
            (claim.claimantKind !== 'server' ||
              (candidate.routing.serverFrom !== null &&
                Date.parse(candidate.routing.serverFrom) <= Date.parse(claim.now)) ||
              (candidate.routing.serverFrom === null && candidate.routing.workersFrom === null)) &&
            // WP-281: a remote worker's, as the SQL's `WORKER_ELIGIBLE` spells it.
            (claim.claimantKind !== 'worker' || workerEligible(candidate, claim)) &&
            // WP-293, S-26.4: an automatic claim asks the scope and the policy; a pick ignores
            // both, and takes no stage task another person owns.
            (claim.claimantKind !== 'worker' ||
              claim.worker === undefined ||
              (claim.worker.pick === true
                ? pickOwnershipAdmits(candidate, claim.worker.workerId)
                : scopeTakes(candidate, claim.worker.workerId) &&
                  policyTakes(candidate, claim.worker.workerId))),
        )
        .sort((a, b) => Date.parse(a.offeredAt) - Date.parse(b.offeredAt))[0];
      if (offer === undefined) {
        return null;
      }
      if ((claim.claimantKind === 'worker') !== (claim.worker !== undefined)) {
        throw new PipelineStoreError(
          'a worker claim names its worker, and only a worker claim does (RunOfferClaim.worker, WP-281)',
        );
      }
      const epoch = offer.leaseEpoch + 1;
      offers.set(offer.runId, {
        ...offer,
        state: 'claimed',
        leaseEpoch: epoch,
        claimantKind: claim.claimantKind,
        claimedAt: claim.now,
      });
      epochs.set(offer.runId, epoch);
      const remote = remoteOf(offer.runId);
      const worker = claim.worker;
      const claimedImages = worker === undefined ? remote.images : (remote.images ?? worker.images);
      offerRemote.set(offer.runId, {
        ...remote,
        workerId: worker?.workerId ?? null,
        tokenHash: worker === undefined ? remote.tokenHash : worker.runTokenHash,
        tokenEpoch: worker === undefined ? remote.tokenEpoch : epoch,
        images: claimedImages === null ? null : { ...claimedImages },
      });
      if (worker === undefined) runWorkers.delete(offer.runId);
      else runWorkers.set(offer.runId, worker.workerId);
      // WP-275b: the claim is the run's `created → starting`, as the SQL's outer update writes it.
      const claimedRun = runs.get(offer.runId);
      if (claimedRun !== undefined && claimedRun.status === 'created') {
        runs.set(offer.runId, { ...claimedRun, status: 'starting' });
      }
      if (claim.owner === null || claim.expiresAt === null) {
        leases.delete(offer.runId);
      } else {
        leases.set(offer.runId, { owner: claim.owner, expiresAt: claim.expiresAt });
      }
      return {
        offerId: offer.id,
        runId: offer.runId,
        taskId: offer.taskId,
        kind: offer.kind,
        epoch,
        owner: claim.owner,
        images: claimedImages === null ? null : { ...claimedImages },
        ...(worker === undefined
          ? {}
          : { workerUserId: options.remoteWorkers?.(worker.workerId)?.userId ?? null }),
      };
    },
    /** WP-281: the SQL adapter's release, its decision the shared `decideRelease`. */
    release: async (_tx, input) => {
      const offer = offers.get(input.runId);
      const run = runs.get(input.runId);
      if (offer === undefined || run === undefined) {
        return { kind: 'lease_lost' };
      }
      const remote = remoteOf(input.runId);
      const decision = decideRelease(
        {
          offerState: offer.state,
          offerEpoch: offer.leaseEpoch,
          tokenEpoch: remote.tokenEpoch,
          released: remote.releasedAt !== null,
          offerOwner: remote.workerId === null ? null : `worker:${remote.workerId}`,
          runStatus: run.status,
          runEpoch: epochs.get(input.runId) ?? 0,
          leaseOwner: leases.get(input.runId)?.owner ?? null,
          marked: spawnMarkers.has(input.runId),
        },
        input,
      );
      if (decision !== 'release') {
        return { kind: decision };
      }
      offers.set(input.runId, { ...offer, state: 'open' });
      offerRemote.set(input.runId, {
        ...remote,
        releasedAt: input.now,
        releaseReason: input.reason,
        excluded:
          input.excludeWorkerId === null || remote.excluded.includes(input.excludeWorkerId)
            ? remote.excluded
            : [...remote.excluded, input.excludeWorkerId],
      });
      runs.set(input.runId, { ...run, status: 'created' });
      leases.delete(input.runId);
      runWorkers.delete(input.runId);
      return {
        kind: 'released',
        offerId: offer.id,
        taskId: offer.taskId,
        projectId: offer.projectId,
      };
    },
    carriedExclusions: async (_tx, entry) => {
      const previous = [...offers.values()]
        .filter(
          (offer) =>
            offer.kind === 'stage' &&
            offer.taskId === entry.taskId &&
            offer.stage === entry.stage &&
            offer.attempt === entry.attempt,
        )
        .at(-1);
      if (previous === undefined) return [];
      const remote = remoteOf(previous.runId);
      const reason = runs.get(previous.runId)?.terminalReason ?? null;
      const lost = remote.workerId !== null && reason === 'lease_expired' ? [remote.workerId] : [];
      return [...new Set([...remote.excluded, ...lost])];
    },
    runTokenHolder: async (_tx, runId) => {
      const offer = offers.get(runId);
      const run = runs.get(runId);
      if (offer === undefined || run === undefined) {
        return null;
      }
      const remote = remoteOf(runId);
      return {
        runId,
        offerId: offer.id,
        kind: offer.kind,
        tokenHash: remote.tokenHash,
        tokenEpoch: remote.tokenEpoch,
        workerId: remote.workerId,
        workerUsable:
          remote.workerId !== null && options.remoteWorkers?.(remote.workerId)?.usable === true,
        runStatus: run.status,
        endedAt: endedAts.get(runId) ?? null,
      };
    },
    load: async (_tx, runId) => {
      const offer = offers.get(runId);
      return offer === undefined ? null : clone(offer);
    },
    /** WP-276: the SQL adapter's one conditional update — only an `open` offer moves. */
    withdraw: async (_tx, input) => {
      // `run_offers_withdrawn_reason_shape` (migration 0094), spelled out so a sentence that would
      // fail the database's check fails here too (WP-278 review, BACKLOG 731).
      if (input.reason.length < 1 || input.reason.length > 64) {
        throw new PipelineStoreError(
          `withdrawn_reason must be 1–64 characters (run_offers_withdrawn_reason_shape), got ${input.reason.length}`,
        );
      }
      const offer = [...offers.values()].find((candidate) =>
        'taskId' in input.by
          ? candidate.taskId === input.by.taskId &&
            candidate.kind === 'stage' &&
            candidate.state === 'open'
          : candidate.runId === input.by.runId && candidate.state === 'open',
      );
      if (offer === undefined) {
        return null;
      }
      offers.set(offer.runId, {
        ...offer,
        state: 'withdrawn',
        withdrawnAt: input.now,
        withdrawnReason: input.reason,
      });
      return { offerId: offer.id, runId: offer.runId };
    },
    expiredOpen: async (_tx, input) =>
      [...offers.values()]
        .filter(
          (offer) =>
            offer.state === 'open' &&
            offer.routing.expiresAt !== null &&
            Date.parse(offer.routing.expiresAt) <= Date.parse(input.now),
        )
        .sort(
          (a, b) => Date.parse(a.routing.expiresAt ?? '') - Date.parse(b.routing.expiresAt ?? ''),
        )
        .slice(0, input.limit)
        .map((offer) => ({
          runId: offer.runId,
          taskId: offer.taskId,
          projectId: offer.projectId,
          kind: offer.kind,
          offeredAt: offer.offeredAt,
          expiresAt: offer.routing.expiresAt as IsoDateTime,
        })),
    unroutedOpen: async (_tx, limit) =>
      [...offers.values()]
        .filter(
          (offer) =>
            offer.state === 'open' &&
            offer.routing.serverFrom === null &&
            offer.routing.workersFrom === null,
        )
        .sort((a, b) => Date.parse(a.offeredAt) - Date.parse(b.offeredAt))
        .slice(0, limit)
        .map((offer) => ({
          offerId: offer.id,
          runId: offer.runId,
          projectId: offer.projectId,
          kind: offer.kind,
          offeredAt: offer.offeredAt,
        })),
    reroute: async (_tx, input) => {
      const offer = [...offers.values()].find((candidate) => candidate.id === input.offerId);
      if (
        offer === undefined ||
        offer.state !== 'open' ||
        offer.routing.serverFrom !== null ||
        offer.routing.workersFrom !== null
      ) {
        return false;
      }
      offers.set(offer.runId, {
        ...offer,
        routing: {
          ...offer.routing,
          serverFrom: input.routing.serverFrom,
          workersFrom: input.routing.workersFrom,
          expiresAt: input.routing.expiresAt,
        },
      });
      return true;
    },
    openWithoutPlan: async (_tx, limit) =>
      [...offers.values()]
        .filter((offer) => offer.state === 'open' && !plans.has(offer.runId))
        .slice(0, limit)
        .map((offer) => ({ runId: offer.runId, kind: offer.kind })),
    liveStageOffer: async (_tx, taskId) => {
      const offer = [...offers.values()].find(
        (candidate) =>
          candidate.taskId === taskId &&
          candidate.kind === 'stage' &&
          (candidate.state === 'open' || candidate.state === 'claimed'),
      );
      return offer === undefined ? null : clone(offer);
    },
  };

  /**
   * WP-278's routing reads and the claimant's liveness. **Divergence:** liveness has no clock here —
   * a holder is running from its renewal until its release, where the database also lets an
   * unrenewed row expire — and an online assignee is whatever a test set.
   */
  const executionRepository: ExecutionRoutingRepository = {
    settings: async (_tx, projectId) => {
      const stored = executionSettings.get(projectId);
      return stored === undefined ? null : clone(stored);
    },
    assigneeOnline: async (_tx, input) => onlineAssignees.has(`${input.projectId}#${input.userId}`),
    serverClaimantRunning: async () => serverClaimants.size > 0,
    renewServerClaimant: async (_tx, input) => {
      serverClaimants.add(input.holder);
    },
    releaseServerClaimant: async (_tx, holder) => {
      serverClaimants.delete(holder);
    },
  };

  /** `run_plans` (WP-275a): written once, read by the run id; `finish` clears the seal above. */
  const runPlanRepository: RunPlanRepository = {
    insert: async (_tx, plan) => {
      if (!runs.has(plan.runId)) {
        throw new PipelineStoreError(
          `run ${plan.runId} does not exist (run_plans.run_id references runs)`,
        );
      }
      if (plans.has(plan.runId)) {
        throw new PipelineStoreError(
          `run ${plan.runId} already has a plan (run_plans.run_id is the key)`,
        );
      }
      plans.set(plan.runId, clone({ ...plan }));
    },
    load: async (_tx, runId) => {
      const plan = plans.get(runId);
      return plan === undefined ? null : clone(plan);
    },
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
    lockLiveRunOf: async (_tx, taskId, options) => {
      const live = [...runs.values()].filter(
        (run) =>
          run.taskId === taskId &&
          isActiveRunStatus(run.status) &&
          (options?.stage === undefined || run.stage === options.stage),
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
      // The SQL's three nullable columns: an absent subject or reason list is stored as `null`.
      approvals.set(
        stored.approval.id,
        clone({
          ...stored,
          subjectArtifactId: stored.subjectArtifactId ?? null,
          subjectDetail: stored.subjectDetail ?? null,
          reasons: stored.reasons ?? null,
          autoDecided: stored.autoDecided === true,
        }),
      );
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
      // `reminders_sent` is not `save`'s column (WP-84), as for a question — and neither are the
      // subject and the reasons (TD-035): they are what was asked, written once by the insert.
      approvals.set(
        stored.approval.id,
        clone({
          ...stored,
          approval: { ...stored.approval, remindersSent: current.approval.remindersSent },
          subjectArtifactId: current.subjectArtifactId ?? null,
          subjectDetail: current.subjectDetail ?? null,
          reasons: current.reasons ?? null,
          // S-28.16: set by a later platform decision, never cleared.
          autoDecided: current.autoDecided === true || stored.autoDecided === true,
        }),
      );
    },
    pendingBudgetBelowSamples: async (_tx, query) =>
      [...approvals.values()]
        .filter((stored) => {
          if (stored.approval.kind !== 'budget' || stored.approval.status !== 'pending') {
            return false;
          }
          const samples =
            stored.subjectDetail?.estimate_samples ??
            tasks.get(stored.approval.taskId)?.estimateSamples ??
            null;
          return samples !== null && samples < query.belowSamples;
        })
        .sort(
          (a, b) =>
            a.approval.requestedAt.localeCompare(b.approval.requestedAt) ||
            a.approval.id.localeCompare(b.approval.id),
        )
        .slice(0, query.limit)
        .map((stored) => stored.approval.id),
    /**
     * **Recorded only** — the stricter half of the adapter (rule 1): PostgreSQL also derives a
     * subject for a row written before migration 0103 (TD-035 decision 5), and this store holds no
     * such row, so it never derives one and answers `null` where the adapter might pin a plan.
     */
    planSubject: async (_tx, approvalId) => {
      const stored = approvals.get(approvalId);
      return stored === undefined ||
        stored.approval.kind !== 'plan' ||
        stored.subjectArtifactId === undefined ||
        stored.subjectArtifactId === null
        ? null
        : { artifactId: stored.subjectArtifactId, basis: 'recorded' };
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
  // Questions only: no approval expires or is given a deadline since S-27.1 (BD-006's 2026-11-07
  // amendment), so the expiry and backfill reads never name one — an approval's old `deadline_at`
  // is history here exactly as in the PostgreSQL store.
  const waiting = (): (WaitingQuestion & { readonly deadlineAt: IsoDateTime | null })[] =>
    [...questions.values()]
      .filter((question) => question.status === 'open' && unfinished(question.taskId))
      .map((question) => ({
        aggregate: 'question' as const,
        id: question.id,
        projectId: question.projectId,
        taskId: question.taskId,
        deadlineAt: question.deadlineAt,
      }));
  const strip = ({
    deadlineAt: _deadlineAt,
    ...row
  }: WaitingQuestion & {
    readonly deadlineAt: IsoDateTime | null;
  }): WaitingQuestion => row;
  const deadlineRecovery: DeadlineRecoveryStore = {
    overdue: async (_tx, query) =>
      waiting()
        .filter((row) => row.deadlineAt !== null && row.deadlineAt < query.dueBefore)
        .sort(
          (a, b) =>
            (a.deadlineAt ?? '').localeCompare(b.deadlineAt ?? '') || a.id.localeCompare(b.id),
        )
        .slice(0, query.limit)
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
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, query.limit)
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
      // Nearest deadline first, at most `limit` — the PostgreSQL store's order, no kinder.
      return rows
        .sort((a, b) => a.deadlineAt.localeCompare(b.deadlineAt) || a.id.localeCompare(b.id))
        .slice(0, query.limit);
    },
    remindableApprovals: async (_tx, query) => {
      const rows: RemindableApproval[] = [];
      for (const { approval } of approvals.values()) {
        if (
          approval.status === 'pending' &&
          approval.remindersSent < query.limitSent &&
          tasks.get(approval.taskId)?.task.state === 'waiting_approval' &&
          approval.requestedAt < query.requestedBefore
        ) {
          rows.push({
            aggregate: 'approval',
            id: approval.id,
            projectId: approval.projectId,
            taskId: approval.taskId,
            requestedAt: approval.requestedAt,
            remindersSent: approval.remindersSent,
          });
        }
      }
      // Oldest request first, at most `limit` — the PostgreSQL store's order, no kinder.
      return rows
        .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt) || a.id.localeCompare(b.id))
        .slice(0, query.limit);
    },
    backfillDeadline: async (_tx, input) => {
      const question = questions.get(input.id);
      if (question === undefined || question.status !== 'open' || question.deadlineAt !== null) {
        return false;
      }
      questions.set(input.id, { ...question, deadlineAt: input.deadlineAt });
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

  /** `task_duty_leases` (migration 0091, WP-184), keyed `(task_id, lease)` like its primary key. */
  const dutyLeases = new Map<string, { holder: string; expiresAt: number }>();
  const dutyLeaseRepository: TaskDutyLeaseRepository = {
    claim: async (_tx, input) => {
      const key = `${input.taskId}#${input.lease}`;
      const held = dutyLeases.get(key);
      if (
        held !== undefined &&
        held.holder !== input.holder &&
        held.expiresAt > Date.parse(input.now)
      ) {
        return false;
      }
      dutyLeases.set(key, { holder: input.holder, expiresAt: Date.parse(input.expiresAt) });
      return true;
    },
    renew: async (_tx, input) => {
      const held = dutyLeases.get(`${input.taskId}#${input.lease}`);
      if (
        held === undefined ||
        held.holder !== input.holder ||
        held.expiresAt <= Date.parse(input.now)
      ) {
        return false;
      }
      held.expiresAt = Date.parse(input.expiresAt);
      return true;
    },
    release: async (_tx, input) => {
      const key = `${input.taskId}#${input.lease}`;
      if (dutyLeases.get(key)?.holder === input.holder) {
        dutyLeases.delete(key);
      }
    },
  };

  return {
    dutyLeases: dutyLeaseRepository,
    deadlineRecovery,
    supersededRecovery,
    supersededRows: () => [...superseded.values()].map((row) => clone(row)),
    tasks: taskRepository,
    artifacts: artifactRepository,
    runs: runRepository,
    offers: offerRepository,
    runPlans: runPlanRepository,
    execution: executionRepository,
    questions: questionRepository,
    approvals: approvalRepository,
    breakdown: breakdownRepository,
    runCommands: runCommandRepository,
    bugTraces: bugTraceRepository,
    owners: {
      classifyAssignee: async (_tx, input) =>
        classify(input.projectId, input.provider, input.externalId),
      mayOwn: async (_tx, input) => mayOwnIn(input.projectId, input.userId),
      // S-26.3: the first seeded `person` link of that user and provider — the SQL's oldest.
      personIdentity: async (_tx, input) => {
        for (const [key, userId] of ownerIdentities) {
          const [provider, externalId] = key.split('\0');
          if (userId === input.userId && provider === input.provider && externalId !== undefined) {
            return { externalId };
          }
        }
        return null;
      },
    },
    seedIdentity: (provider, externalId, userId) => {
      ownerIdentities.set(identityKey(provider, externalId), userId);
    },
    seedProjectMember: (projectId, userId) => {
      projectMembers.add(`${projectId}\0${userId}`);
    },
    unseedProjectMember: (projectId, userId) => {
      projectMembers.delete(`${projectId}\0${userId}`);
    },
    seedBindingAccount: (projectId, provider, externalId) => {
      bindingAccounts.add(`${projectId}\0${identityKey(provider, externalId)}`);
    },
    ownershipOf: (taskId) => structuredClone(ownerships.get(taskId) ?? UNOWNED),
    ownerBackfillOf: (taskId) => ({ ...backfillOf(taskId) }),
    runCommandRows: () => [...runCommandRows.values()].map((row) => clone(row)),
    offerRows: () => [...offers.values()].map((row) => clone(row)),
    leaseEpochOf: (runId) => epochs.get(runId) ?? 0,
    setExecutionSettings: (projectId, settings) => {
      if (settings === null) executionSettings.delete(projectId);
      else executionSettings.set(projectId, clone(settings));
    },
    setAssigneeOnline: (projectId, userId, online) => {
      const key = `${projectId}#${userId}`;
      if (online) onlineAssignees.add(key);
      else onlineAssignees.delete(key);
    },
    serverClaimantHolders: () => [...serverClaimants],
    unrouteOffer: (runId) => {
      const offer = offers.get(runId);
      if (offer === undefined) return;
      offers.set(runId, {
        ...offer,
        routing: { ...offer.routing, serverFrom: null, workersFrom: null, expiresAt: null },
      });
    },
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
    providerModeOf: (runId) => providerModes.get(runId) ?? null,
    savedWorkOf: (runId) => {
      const saved = savedWorks.get(runId);
      return saved === undefined ? null : clone(saved);
    },
    startFailureOf: (runId) => {
      const failure = startFailures.get(runId);
      return failure === undefined ? null : clone(failure);
    },
    leaseOf: (runId) => {
      const held = leases.get(runId);
      return held === undefined ? null : { ...held };
    },
    snapshot: () => [...tasks.values()].map(clone),
    setPersonalTaskLimit: (userId, limit) => {
      if (limit === null) personalLimits.delete(userId);
      else personalLimits.set(userId, limit);
    },
    get stageRows() {
      return stages.map((row) => ({ ...row }));
    },
  };
};

export type { Approval, Question };

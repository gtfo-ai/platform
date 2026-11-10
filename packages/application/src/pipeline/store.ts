/**
 * The pipeline's persistence port — the rows technical/03 keeps for a task, behind an interface
 * this ring can name.
 *
 * Everything here is **transaction-bound**: every method takes the `Transaction` handle of a
 * `TransactionScope`, so an aggregate's state and its events commit together (technical/02's
 * transactional outbox). There is deliberately no `beginTransaction` on the port — opening a
 * transaction is the caller's decision, and a repository that could open its own is how a handler
 * ends up holding two connections at once, which the dispatcher's `2 × concurrency + 1` pool floor
 * does not account for.
 *
 * One port with five small members rather than five ports, because they are always constructed
 * together against one database and are held to one shared contract suite. The members are grouped
 * by aggregate, which is the boundary that matters: nothing outside `tasks` writes a task row.
 *
 * ## What the store adds to the aggregates
 *
 * The Task aggregate (`@platform/domain`) owns the state machine, the stage attempts and the
 * iteration counters. A running pipeline needs four more things that are not state transitions and
 * therefore are not on the aggregate: the **template snapshot** it was started with (technical/12
 * freezes the effective config at task start), the **merge request** it is working through, the
 * **workpad** comment it edits in place (BD-023), and the **spend so far**. Those live on the row.
 */
import type {
  AcceptanceCriterion,
  Actor,
  AgentRole,
  ApprovalReason,
  ArtifactType,
  BudgetApprovalSubjectDetail,
  CiGateEnding,
  CiManualNotRun,
  ContextPackRecord,
  EstimateBasis,
  HistorySample,
  Id,
  IsoDateTime,
  JsonObject,
  JsonValue,
  MergeRequestRef,
  MergeRequestSnapshot,
  PausedBudgetScope,
  PipelineTemplate,
  ProviderMode,
  RunClaimantKind,
  RunCost,
  RunOfferKind,
  RunSavedWork,
  RunStartFailure,
  RunStatus,
  RunTerminalReason,
  Size,
  Slug,
  StoredTicketClaim,
  TaskCoverage,
  TaskDependencies,
  TaskMode,
  TaskPipelineDial,
  TaskReviewers,
  TaskReviewThreads,
  TaskStageExitState,
  TaskStageOutcome,
  TicketRef,
  TicketSnapshot,
  TokenUsage,
  WorkpadRef,
} from '@platform/contracts';
import type {
  Approval,
  AssigneeClass,
  ExecutionSettings,
  IterationLimits,
  OfferRouting,
  Question,
  QueuedTask,
  Task,
  TaskOwnership,
} from '@platform/domain';
import type { PromptsWithheld } from '../config/repository-config.js';
import type { ConcurrencyConflict } from '../events/concurrency.js';
import type { Transaction } from '../ports/transaction.js';
import type { CiPendingRead } from './ci-pending-read.js';
import type { RunSettingsSnapshot } from './settings-snapshot.js';

/**
 * How a superseded merge request's `close_superseded_mr` duty ended (migration 0043, WP-59 review
 * round 1) — or `abandoned`, the recovery pass's own ending after one re-enqueue did not take.
 */
export type SupersededMergeRequestOutcome =
  | 'closed'
  | 'merged'
  | 'readopted'
  | 'unbound'
  | 'shadow'
  | 'abandoned';

/**
 * A merge request a rework let go of (`superseded_merge_requests`, PROGRESS backlog 178): written
 * in the rework's own transaction, because after it commits no other row names the merge request.
 */
export interface SupersededMergeRequest {
  readonly taskId: Id;
  readonly projectId: Id;
  readonly mr: MergeRequestRef;
  readonly newBranch: string | null;
  /** The rework's `task.stage.returned` — the close wake-up's cause, which a re-enqueue carries. */
  readonly causeEventId: Id;
  readonly supersededAt: IsoDateTime;
}

/** Intake's routing inputs, as {@link StoredTask.refreezeRouting} keeps them (WP-106). */
export interface RefreezeRouting {
  readonly issueType: string | null;
  readonly canCreateTickets: boolean;
}

/** A task as the pipeline holds it: the aggregate plus the row's own columns. */
export interface StoredTask {
  readonly task: Task;
  /** The template the task started with; a later edit to project settings never moves a task. */
  readonly template: PipelineTemplate;
  /**
   * The dial's two pipeline policies as they were when the task started (`tasks.pipeline_dial`,
   * migration 0049, WP-62) — what every `compilePipeline` call over this task passes.
   *
   * Frozen for `template`'s reason: a dial moved while the task runs does not move it. Written by
   * the insert and by nothing else. `null` is *"no dial applies"* — a project whose dial was never
   * materialised, a task kind the dial does not shape (each creating site says which), or a row
   * written before the column existed — and compiles the template exactly as before WP-62.
   */
  readonly pipelineDial: TaskPipelineDial | null;
  /**
   * **Whether this task's pipeline has the human `qa` stage** (`tasks.qa_stage`, migration 0088,
   * TD-029 decision 9, WP-177) — what every `compilePipeline` call over this task passes beside
   * {@link StoredTask.pipelineDial}.
   *
   * Frozen at creation for the dial's reason: a lifecycle mapping changed while the task runs does
   * not reshape it. Intake is the one creating site that reads a ticket binding, and it writes
   * `true` when the binding maps the `qa` slot; every other creating site writes `false`. Written
   * by the insert and by nothing else.
   */
  readonly qaStage: boolean;
  /**
   * **This task's frozen limits and dial were taken under a `configRefusal`** (WP-106, migration
   * 0066, PROGRESS backlogs 311 and 354): the project's stored configuration could not be read
   * when the task was created, so `task.limits` and {@link StoredTask.pipelineDial} are the
   * platform's defaults rather than the document's. Every run of such a project is refused at
   * admission until the document parses, and the first run admitted after that takes both again
   * from the parsed document ({@link TaskRepository.refreezeSettings}) — so the task never runs on
   * the defaults it was created with. An intake-created task's **template** is routed again too,
   * but only while it is still at `intake` ({@link StoredTask.refreezeRouting}, review round 2). Set by the insert, cleared only by `refreezeSettings`.
   * Absent reads as `false`.
   */
  readonly settingsRefreezePending?: boolean;
  /**
   * What intake routed the ticket on, kept while {@link StoredTask.settingsRefreezePending} is set
   * on an intake-created task (WP-106 review round 2, migration 0066): the template was chosen with
   * the refused document's spike and epic-split switches read as off, so the re-take routes again
   * on the parsed document from these inputs. Absent or `null` for every other task.
   */
  readonly refreezeRouting?: RefreezeRouting | null;
  /** Normalised by the task-management adapter — lower is more urgent (`QueuedTask`). */
  readonly priorityRank: number;
  readonly createdAt: IsoDateTime;
  readonly branch: string | null;
  readonly mr: MergeRequestRef | null;
  readonly workpad: WorkpadRef | null;
  /**
   * Sum of the runs' measured cost, in USD (`tasks.cost_actual`). A run nobody measured adds
   * nothing here — its spend is unknown, not zero — and the task cap holds it beside this figure
   * instead (`RunRepository.heldFor`, WP-131).
   */
  readonly costActualUsd: number;
  readonly estimateUsd: number | null;
  /**
   * What {@link StoredTask.estimateUsd} rests on (WP-28, migration 0022).
   *
   * `null` means **the estimator has not run on this task** — a task that has not finished
   * refinement, or a row written before the column existed. It is *not* how "there was nothing to
   * estimate from" is spelled: that is `'unknown'` with a `null` estimate and zero samples, which
   * is the estimator's stated refusal (standing rule 16). The budget gate distinguishes the two by
   * reading the number and never the word, and the workpad prints a different sentence for each.
   */
  readonly estimateBasis: EstimateBasis | null;
  /** How many finished tasks the estimate averaged; `null` exactly when {@link estimateBasis} is. */
  readonly estimateSamples: number | null;
  /**
   * The risk classes the merge request's **changed paths** fall into — product/19 §14, WP-37.
   *
   * Written by {@link TaskRepository.saveRiskClasses} from the `risk_route` duty at the rebase gate
   * and by nothing else; empty until a task has a merge request the platform has read the diff of.
   * An empty list is *"nothing this project classes was touched"* and is a different fact from a
   * project with no classes at all — which is why the duty logs which of the two it found rather
   * than leaving the reader of an empty column to guess.
   *
   * It is deliberately **not** what the plan-approval gate reads: that gate answers before there is
   * a merge request, from the Implementation Plan's own paths (`risk-classes.ts` has the argument).
   */
  readonly riskClasses: readonly string[];
  /**
   * What the project's CI reported for this task's head revision, against its default branch
   * (product/18:38, WP-39, migration 0027).
   *
   * Written by {@link TaskRepository.saveCoverage} from the `coverage` outbound duty and by nothing
   * else. `null` means **nothing has been measured** — no pipeline has finished on the merge
   * request, or the project's `policies.coverage_source` is `'none'` and the platform never asked —
   * which is a different fact from a record whose `head_pct` is `null` (*the pipeline finished and
   * reported no coverage*). The panel prints a different sentence for each, because a zero here
   * would read as "the agent's change covers nothing" (standing rule 16).
   *
   * The record names its own base: `base_branch`, `base_sha` and `measured_at` are the default
   * branch, its head at the moment of the write and that moment, so a reader can tell how stale the
   * comparison is without re-deriving it (standing rule 63).
   */
  readonly coverage: TaskCoverage | null;
  /**
   * What the dependency gate found in this task's diff and what it did about it (product/04:58,
   * WP-38, migration 0028).
   *
   * Written by {@link TaskRepository.saveDependencies} from the `dependency_gate` outbound duty and
   * by nothing else. `null` means **the gate has not run** — no implementation stage has completed,
   * so there is no diff — which is a different fact from a record whose `added` is empty (*it ran
   * and the diff touched no manifest*), and the Checks panel prints a different sentence for each.
   */
  readonly dependencies: TaskDependencies | null;
  /**
   * Who this merge request needs a review from, as the routing computed it (product/10:38,
   * WP-37's producer and WP-38's record, migration 0028).
   *
   * Written by {@link TaskRepository.saveRequiredReviewers} from the `risk_route` outbound duty and
   * by nothing else. `null` means the routing has not run; a record whose `handles` is empty is the
   * routing saying *"no CODEOWNERS match, no project reviewers and no mapped requester"*, and one
   * whose `unresolved` is not empty is it saying *"these are the people this change needs and this
   * provider has no account for them"* — which is the case the `set_reviewers` audit row cannot
   * record, because no call is made when nothing resolved.
   */
  readonly requiredReviewers: TaskReviewers | null;
  /**
   * The merge request's human review threads, open and resolved, as BD-007's review window last read
   * them (product/10:38, WP-46, migration 0048).
   *
   * Written by {@link TaskRepository.saveReviewThreads} from the `mr.comment.debounce` job and —
   * for a review-only task, counting the platform's own findings (WP-73, backlog 209) — from the
   * `review_only_observe` duty. `null` means **nobody has read them** — no human has commented
   * while the task waited at `ready_for_merge`, or the review has not been observed — which is a
   * different fact from a record whose `open` is zero.
   */
  readonly reviewThreads: TaskReviewThreads | null;
  /**
   * The human who asked for this task — step **three** of product/19:138's reviewer precedence.
   *
   * **Written by the three commands that hold the actor** (WP-67, PROGRESS backlog 92): discovery
   * (`onboarding/discovery.ts`), a shadow batch (`shadow/batch.ts`) and a history bootstrap's chunk
   * tasks (`bootstrap/collect.ts`, from the batch's `requested_by`) — **and, since WP-79 (backlog
   * 243), for a ticket-started task, from the ticket's reporter**: intake's insert writes the
   * reporter's platform user, resolved only through `user_identities` and never by an email match
   * (`resolveRequester` in `ticket-snapshot.ts`), and {@link TaskRepository.saveRequester} fills a
   * `null` when a later stage re-reads the ticket. An unmapped reporter stays `null`, and the
   * provider account itself is never stored here. The other creation sites write `null` and each
   * says why: review-only and the ticket linter are started by a provider delivery rather than a
   * person, and the maintenance scheduler is the platform's own. `null` makes the fallback resolve
   * to nobody, and the routing says so by name instead of assigning silently; a user id still
   * needs a `user_identities` row on the **git** provider for the routing to reach an account.
   */
  readonly requestedByUserId: Id | null;
  /**
   * The branch head the platform's gates judged on the way into `ready_for_merge` (WP-79,
   * migration 0056, PROGRESS backlog 267).
   *
   * Written only by {@link TaskRepository.saveReadyHead}, from `applyDecision`'s entry into Ready:
   * the gate settlement's head, the ready-head check's head when it found the branch unmoved on a
   * template with no rebase gate (since WP-105 an unmoved head otherwise re-enters `rebase_gate`,
   * whose settlement records it), and `null` for every other entry — so the value always describes the **latest** Ready entry. `null`
   * is *"no gate judged a head"* (a template with its gates disabled, a row older than the column),
   * which the `ready_head_check` duty reads exactly like a moved head.
   */
  readonly readyHeadSha: string | null;
  /**
   * The head the CI gate judged when it last settled — `null` when it failed, has not run, or the
   * row predates the column (WP-79 review round 2, migration 0056, PROGRESS backlog 275). Written
   * only by {@link TaskRepository.saveCiSettlement} from the gate settlement; read by the rebase
   * gate's settlement, which lets a task into Ready only for the head CI passed.
   */
  readonly ciHeadSha: string | null;
  /**
   * The protected paths the CI gate's **last** settlement excused provisionally — declared by the
   * plan, not yet judged by the Code review (`protected_paths_awaiting_review`) — redacted, and
   * empty for every other settlement, for a gate that has not run, and for a row written before
   * the column (WP-102, migration 0065, Q109 (b)). Written only by
   * {@link TaskRepository.saveCiSettlement}, beside `ciHeadSha`; read by the rebase gate's
   * settlement, which compares them with the latest Review Verdict's confirmations before Ready
   * (`unconfirmedExcusedPaths` in `tamper.ts`).
   */
  readonly ciExcusedPaths: readonly string[];
  /**
   * The ticket's own words as the platform read them once (WP-15f, migration 0015).
   *
   * `null` means **the platform has not read this ticket** — a fetch that failed, a project with no
   * task-management binding, or a task created before the column existed. It is never how a ticket
   * with an empty description is spelled: that is a snapshot whose `description` is `''` (standing
   * rule 18). `packages/application/src/pipeline/ticket-snapshot.ts` owns the bounds, the
   * redaction and both writers.
   */
  readonly ticketSnapshot: TicketSnapshot | null;
  /** When {@link ticketSnapshot} was read; `null` exactly when it is (`tasks_ticket_snapshot_at_paired`). */
  readonly ticketSnapshotAt: IsoDateTime | null;
  /**
   * The latest instant the provider **told** the platform this task's ticket changed (WP-60,
   * migration 0044) — Q61 (b)'s *"the task's last provider signal"*, which did not exist before.
   *
   * The platform's receipt time of the newest `ticket.updated` for the task's ticket (the event's
   * `occurred_at`), a platform instant like {@link ticketSnapshotAt}, so "the snapshot predates the
   * signal" is one comparison of two platform instants — stamped by two processes, whose skew bound
   * `isTicketSnapshotStale` states. `null` means no edit has been announced
   * since the task existed. Written only by {@link TaskRepository.recordTicketSignal}, and never
   * by the insert (a task is born with no signal: the one that started it is older than its
   * snapshot, which is read after it).
   */
  readonly ticketSignalAt: IsoDateTime | null;
  /**
   * The human merge request a **review-only** task reviews (WP-24, migration 0020).
   *
   * `null` for every task that is not one, which is every task on a project that has not enabled
   * the mode. It is written **once, by the `insert` that creates the task** and never updated, so
   * it is not in `save`'s column list and no second writer exists (`tasks-column-ownership.test.ts`
   * holds that rather than this sentence): a review is of the merge request as it was when the
   * platform read it, and a later revision is a new review, not an edit of this one.
   */
  readonly reviewSubject: MergeRequestSnapshot | null;
  /**
   * The batch of merged history a **history-bootstrap** task's one stage reads (WP-35, migration
   * 0030).
   *
   * `null` for every task that is not one. Written **once, by the `insert` that creates the task**
   * and never updated, exactly like {@link reviewSubject} and for the same two reasons: the sample
   * is the input the collection made for *this* run, and a second writer beside the stage executor
   * is standing rule 79's lost update. It is therefore not in `save`'s column list and
   * `tasks-column-ownership.test.ts` is what holds that rather than this sentence.
   */
  readonly historySample: HistorySample | null;
  /**
   * The row's optimistic-concurrency token, as it was when this snapshot was read (WP-15e,
   * migration 0019).
   *
   * It is a column of the row rather than a field of the aggregate, for the reason every other
   * field here is: it is not a state transition. Putting it on `Task` would make all thirty-odd
   * domain commands responsible for incrementing a storage token, in a ring that has no I/O and
   * cannot see the write it is guarding — and the guarantee would then be only as good as the
   * command that remembered. The store owns it because the store owns the write, and every
   * `save` call site gets it for free through the `{ ...stored, task: … }` spread it already
   * writes.
   */
  readonly version: number;
}

/** The version every task row starts at (`tasks.version` defaults to it in SQL too). */
export const INITIAL_TASK_VERSION = 1;

/**
 * A `save` that landed on a row another transaction has moved since it was read.
 *
 * The caller must re-read the task and re-decide; it must **never** re-apply the snapshot it was
 * holding, which is the lost update this exists to refuse. `retryOnTaskConflict`
 * (`./task-conflict.ts`) is the bounded loop that does it, and `EventBus` re-runs a handler's whole
 * transaction on one.
 */
export class TaskConcurrentModificationError extends Error implements ConcurrencyConflict {
  override readonly name = 'TaskConcurrentModificationError';
  /** The marker `EventBus` and `retryOnTaskConflict` branch on — see `events/concurrency.ts`. */
  readonly concurrencyConflict = true as const;
  readonly taskId: Id;
  readonly expectedVersion: number;
  readonly actualVersion: number | null;

  // Fields and assignments, **never** a TypeScript parameter property. `readonly x: T` in a
  // constructor signature is one of the few constructs Node's strip-only type stripping refuses
  // (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`), and this repository runs its sources that way: `pnpm dev`,
  // `pnpm db:migrate` and the runlet shim all go through `scripts/ts-source-resolver.mjs`. It
  // typechecks, it lints, and every vitest tier passes because esbuild compiles it — the only thing
  // that finds it is a test that spawns a real `node` on the sources, which is how this comment
  // exists (WP-15e; `runlet/conformance.contract.test.ts` failed with "c.sock never appeared").
  constructor(taskId: Id, expectedVersion: number, actualVersion: number | null) {
    super(
      `task ${taskId} was modified concurrently: expected version ${expectedVersion}, found ` +
        `${actualVersion === null ? 'no row' : actualVersion}`,
    );
    this.taskId = taskId;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

/**
 * A task insert refused because the project's default branch is no longer the branch the caller
 * checked (WP-149, PROGRESS backlog 443): a change of `projects.default_branch` committed between
 * intake's protection check and the insert's transaction. **Retryable** — nothing was written, and
 * the intake job's retry reads the new branch and checks its protection.
 */
export class DefaultBranchChangedError extends Error {
  override readonly name = 'DefaultBranchChangedError';
  readonly projectId: Id;
  readonly checked: string;
  readonly stored: string | null;

  // Fields, not parameter properties: see TaskConcurrentModificationError's constructor.
  constructor(projectId: Id, checked: string, stored: string | null) {
    super(
      `the default branch of project ${projectId} changed from "${checked}" to ` +
        `${stored === null ? 'no row' : `"${stored}"`} while the task was being created; ` +
        'the protection of the new branch has not been checked, so the creation is refused and retried',
    );
    this.projectId = projectId;
    this.checked = checked;
    this.stored = stored;
  }
}

/** What {@link TaskRepository.recordMergeRequest} did (WP-138). */
export type MergeRequestRecording =
  | { readonly kind: 'recorded' }
  | { readonly kind: 'refused'; readonly recorded: MergeRequestRef | null };

export interface TaskRepository {
  load(tx: Transaction, taskId: Id): Promise<StoredTask | null>;
  /**
   * Intake's idempotency key: one task per ticket per mode (`tasks_project_id_ticket_key_mode`).
   *
   * **A ticket is the same ticket under a new key** (WP-134, PROGRESS backlog 418): when the caller
   * knows the provider's stable id (`TicketRef.id`, Jira's issue id), a task recorded with that id
   * answers too, whatever key it was created under — so an issue moved from `OLD-1` to `NEW-5`
   * finds the task `OLD-1` started (`tasks_project_ticket_id_mode`, migration 0077). Without an id
   * the key alone decides, as before.
   */
  findByTicket(
    tx: Transaction,
    query: {
      readonly projectId: Id;
      readonly provider: string;
      readonly ticketKey: string;
      readonly ticketId?: string | null | undefined;
      readonly mode: TaskMode;
    },
  ): Promise<StoredTask | null>;
  /**
   * The task a **signal about** a ticket belongs to — WP-145's rule, for a reader rather than a
   * writer (WP-148: a ticket comment that asks the task). With a `ticketId`, a task matches when it
   * carries that id, or when it carries **no** id and has the signal's key; without one, the key
   * alone decides. So a comment on a moved issue reaches its task by the id before any
   * `ticket.updated` has re-keyed it, and an unrelated issue that now holds the old key reaches no
   * task that knows its own id — the collision {@link findByTicket}'s *key or id* would allow,
   * which is right for intake (one task per key) and wrong here. Any state; oldest first, a task
   * matched by its id before one matched by its key.
   */
  findByTicketSignal(
    tx: Transaction,
    query: {
      readonly projectId: Id;
      readonly provider: string;
      readonly ticketKey: string;
      readonly ticketId: string | null;
      readonly mode: TaskMode;
    },
  ): Promise<StoredTask | null>;
  findByMergeRequest(
    tx: Transaction,
    query: { readonly projectId: Id; readonly iid: number },
  ): Promise<StoredTask | null>;
  /** Every task of a project sitting at `stage`, whatever its state. */
  listAtStage(tx: Transaction, projectId: Id, stage: Slug): Promise<readonly StoredTask[]>;
  /**
   * The project's other **live** tasks that are working through a merge request — WP-26's conflict
   * warnings (product/04 S6b: *"two active tasks touch the same files"*).
   *
   * *Live* is "not `done` and not `cancelled`", which is wider than `active`: a task parked in
   * `needs_human` or `paused` still has an open merge request, and a warning that ignored it would
   * go silent exactly when a human is already involved. `excludeTaskId` is the asking task, which
   * is always excluded rather than filtered out by the caller — a task overlaps itself completely.
   *
   * `limit` is the caller's and is not optional: this is the fan-out of a provider read per row
   * (`conflictWarningHandler` reads each merge request's changed files), so the bound belongs at
   * the call site that knows what it can afford. Oldest first, so the set a task is compared
   * against is stable between two runs of the same gate.
   */
  listWithMergeRequest(
    tx: Transaction,
    projectId: Id,
    query: { readonly excludeTaskId: Id; readonly limit: number },
  ): Promise<readonly StoredTask[]>;
  /**
   * How many tasks this project has **completed** — BD-006's probation, "the first 5 tasks".
   *
   * `done` only: a cancelled task was not delivered and a task still in flight has not been either,
   * so counting them would end probation without a single merged change. It is a `Promise<number>`
   * rather than a page because the caller only ever compares it to a small threshold, and the
   * comparison is `<`, so a project past the threshold costs the same query as one inside it.
   */
  countCompleted(tx: Transaction, projectId: Id): Promise<number>;
  /**
   * Inserts the task, after taking its project row `for share` (WP-142).
   *
   * `guard.defaultBranch` (WP-149, PROGRESS backlog 443) is the branch whose protection the caller
   * checked before this transaction: the insert re-reads `projects.default_branch` **under that
   * lock** and throws {@link DefaultBranchChangedError} when it differs, so a change that committed
   * between the check and the insert cannot leave a task on a branch nobody checked. Intake passes
   * it; a caller that checked no branch passes none.
   */
  insert(
    tx: Transaction,
    stored: StoredTask,
    guard?: { readonly defaultBranch: string },
  ): Promise<void>;
  /**
   * Writes the aggregate's own columns, and only if the row is still at `stored.version`.
   *
   * Two halves, and they close the two halves of PROGRESS backlog 18 (WP-15e):
   *
   * 1. **It refuses a stale write.** `update … where id = $1 and version = $n`, bumping the version
   *    with the same statement. A write that matches no row is either a task that does not exist
   *    (`PipelineRowMissingError`, as before) or one another transaction has moved since this
   *    snapshot was read, and the second throws {@link TaskConcurrentModificationError} for the
   *    caller to retry against a fresh read. Silently winning is the lost update that put a task's
   *    recorded spend back from 2.80 to 2.40 and left a feature ticket sitting at `ci_gate`.
   * 2. **It writes only what it owns.** `workpad_ref`, `ticket_snapshot`, `ticket_snapshot_at`,
   *    `size`, `estimate_usd`, `estimate_basis` and `estimate_samples` belong to the narrow writers
   *    below and to `CostStore.saveEstimate`; `save` does not name them, so it cannot put back a
   *    `null` one of them filled in. That direction was live until WP-15e: `saveWorkpad` stopped the workpad job
   *    from clobbering the executor, and nothing stopped the executor from clobbering the workpad.
   *    **`mr_ref` joined them at WP-138**: the merge request is the `open_mr` tool's record
   *    (`recordMergeRequest`), the rework's let-go (`releaseMergeRequest`) and the provider's head
   *    (`saveMergeRequestHead`); a snapshot's `mr` is ignored here, and the returned snapshot carries
   *    the row's own.
   *
   * The partition is enforced rather than described: `tasks-column-ownership.test.ts` reads the SQL
   * of every `update tasks` statement in the tree off disk and fails when two of them name the same
   * column (standing rule 44 — a scope claim is a checkable claim).
   *
   * **The residual, which is about the *other* binary rather than about this code.** The predicate
   * protects a writer that carries a version. A **pre-WP-15e process** writes `where id = $1` with
   * no predicate and no `version = version + 1`, so it wins silently *and* leaves the token
   * unmoved — which means a concurrent new-process `save` succeeds too, and both updates land with
   * one lost. Nothing in this build produces that shape: the image runs `migrate` and then
   * `server` from one artefact, and there is no rolling deploy of two versions of this code. It is
   * stated because an optimistic check is a claim about *every* writer of the row, and the claim
   * is only true while every writer is this one. technical/03 carries the same sentence beside the
   * column; migration 0019 does not, because an applied migration is never edited (TD-011) and a
   * residual that can be closed must live where it can be.
   *
   * **It returns the snapshot at its new version, and a caller that writes twice must use it.**
   * Two saves in one transaction are an ordinary shape here — the saga's `recordMergeRequest` fills
   * the branch from the record and then `applyDecision` moves the stage — and the second one carries the version the first
   * one consumed unless the value travels. The saga's own tests found this within minutes of the
   * check existing, which is the argument for returning it rather than documenting the hazard.
   */
  save(tx: Transaction, stored: StoredTask): Promise<StoredTask>;
  /**
   * Writes **only** `workpad_ref` — the one column a writer outside the pipeline's own ordering
   * touches.
   *
   * `save` writes the aggregate's columns, which is correct for a saga step: the aggregate it
   * writes is the one it read in the same transaction, and the pipeline orders those. The workpad
   * is different since WP-15d: the render happens in a `pipeline.outbound` job, concurrently with
   * the stage executor's own transactions, so a `save` from there is a read-modify-write of *every*
   * column against a snapshot somebody else has already moved on from. **Measured** rather than
   * reasoned: a bug ticket walked all seven agent stages and finished with `cost_actual` 2.40
   * instead of 2.80, because the workpad's whole-row write landed between the executor's read and
   * its write and put a stale cost back. One column, one update, and that direction is gone.
   *
   * It does **not** bump `tasks.version`, and that is the point of the partition: this column is
   * not one `save` writes, so a bump here would refuse an in-flight aggregate write that never
   * touched the workpad.
   *
   * @throws when the task does not exist, like `save` — a write that hit no row is how a projection
   * silently stops being written.
   */
  saveWorkpad(tx: Transaction, taskId: Id, workpad: WorkpadRef): Promise<void>;
  /**
   * Writes **only** `ticket_snapshot` and `ticket_snapshot_at` — the second writer outside the
   * pipeline's own ordering (WP-15f).
   *
   * Same argument as {@link saveWorkpad}, one work package later: the backfill runs in the
   * `stage.execute` job beside the stage executor's transactions, so a whole-row `save` from there
   * would put back the cost, the state and the stage as they were when the job started. That is
   * PROGRESS backlog entry 18, measured at 0.40 USD of a task's recorded spend, and a narrow write
   * is how a new writer joins without becoming its next instance.
   *
   * The two columns move together because migration 0015's
   * `tasks_ticket_snapshot_at_paired` check says they must: a snapshot with no read time cannot say
   * how old it is, and a read time with no snapshot claims a read that produced nothing. Like
   * {@link saveWorkpad}, it does not bump `tasks.version`.
   *
   * @throws when the task does not exist, like `save` and `saveWorkpad`.
   */
  saveTicketSnapshot(
    tx: Transaction,
    taskId: Id,
    snapshot: TicketSnapshot,
    readAt: IsoDateTime,
  ): Promise<void>;
  /**
   * Writes **only** `risk_classes` — the fourth narrow writer, and the third for the same reason
   * (WP-37).
   *
   * The classes are computed in the `risk_route` duty, a `pipeline.outbound` job that runs beside
   * the stage executor's transactions, so a whole-row `save` from there would put back the state,
   * the stage and the cost as they were when the job started (standing rule 79, measured at 0.40
   * USD in WP-15d). One column, one statement, no version bump: `save` does not name this column,
   * so bumping the token here would refuse an in-flight aggregate write that never touched it.
   *
   * The list is written **whole**, replacing whatever was there: the gate is re-entered every time
   * the default branch moves, and a class that no longer matches the merge request's files must
   * disappear from the row rather than accumulate (a task page that only ever gains classes would
   * be a page that cannot be corrected).
   *
   * @throws when the task does not exist, like `save` and the other narrow writes.
   */
  saveRiskClasses(tx: Transaction, taskId: Id, classes: readonly string[]): Promise<void>;
  /**
   * Writes **only** `ready_head_sha` — the head the gates judged on the way into Ready (WP-79,
   * migration 0056).
   *
   * One caller: `applyDecision`'s entry into `ready_for_merge`, inside the entry's own transaction,
   * right after the aggregate's `save`. Narrow rather than a column of `save` because the ruling
   * that created it asked for one writer, and a `save` column has thirty-odd. No version bump:
   * `save` does not name the column. `null` is written as readily as a head, so an entry that
   * judged nothing never inherits an earlier entry's head.
   *
   * @throws when the task does not exist, like `save` and the other narrow writes.
   */
  saveReadyHead(tx: Transaction, taskId: Id, headSha: string | null): Promise<void>;
  /**
   * Writes **only** `template`, `template_snapshot`, `iteration_limits`, `pipeline_dial`,
   * `settings_refreeze_pending = false` and `refreeze_routing = null`,
   * in one statement (WP-106, migration 0066): the frozen values of a task created under a
   * `configRefusal`, taken again from the parsed document — the template routed again while the
   * task is still at `intake`. Two callers: the stage-completion handler at `intake` (in the
   * handler's transaction) and the stage executor's admission as the backstop (in its own). No
   * version bump: `save` names none of these columns, so a whole-row write cannot put the defaults
   * back.
   *
   * @throws when the task does not exist.
   */
  refreezeSettings(
    tx: Transaction,
    taskId: Id,
    frozen: {
      readonly limits: IterationLimits;
      readonly pipelineDial: TaskPipelineDial | null;
      /** The template id and its snapshot, routed again (round 2); the same ones when unchanged. */
      readonly templateId: string;
      readonly template: PipelineTemplate;
    },
  ): Promise<void>;
  /**
   * Writes **only** `ci_head_sha` and `ci_excused_paths`, in one statement — the head a CI gate
   * settlement passed (`null` for a failed one, WP-79 review round 2) and the protected paths it
   * excused provisionally (empty unless it passed `protected_paths_awaiting_review`, WP-102). One
   * caller: the CI gate's settlement in `jobs.ts`, inside its own transaction. No version bump:
   * `save` names neither column. Named `saveCiHead` until WP-102.
   *
   * @throws when the task does not exist.
   */
  saveCiSettlement(
    tx: Transaction,
    taskId: Id,
    settlement: { readonly headSha: string | null; readonly excusedPaths: readonly string[] },
  ): Promise<void>;
  /**
   * `tasks.ticket_claim` (migration 0088, TD-029 decision 5, WP-177), or `null` when the task never
   * claimed its ticket — a binding with no `lifecycle` block, a task with no provider ticket, or a
   * row older than the column. Parsed through `storedTicketClaimSchema`, never cast.
   */
  ticketClaim(tx: Transaction, taskId: Id): Promise<StoredTicketClaim | null>;
  /**
   * Writes **only** `ticket_claim`, the whole record — the column's one statement (technical/03's
   * M10-head amendment). Its callers: the claim (`ensureTicketClaim`, between the `stage.execute`
   * job's transactions), the release (`releaseTicket`, `ticket-release.ts` — from the
   * `ticket_release` duty, and since WP-178 from the claiming job itself for a *Rework*), a person's
   * *Rework* (marks it stale, in the command's own transaction) and, from WP-178, the human-return
   * window's return (stale) — each stale mark with its `stale_cause`.
   * No version bump: `save` does not name the column, so no whole-row write can put an older
   * claim back.
   *
   * @throws when the task does not exist.
   */
  saveTicketClaim(tx: Transaction, taskId: Id, claim: StoredTicketClaim): Promise<void>;
  /**
   * The task's four ownership columns (S-26.1, migration 0104), `UNOWNED` for a row nobody has
   * written them on. `ticket_assignee` is parsed through `ticketAssigneeSchema`, never cast.
   *
   * @throws when the task does not exist.
   */
  ownership(tx: Transaction, taskId: Id): Promise<TaskOwnership>;
  /**
   * Writes **only** the four ownership columns — their one statement (TD-031's 2026-11-06
   * amendment item 1), a **compare-and-set** on the owner and the stored assignee the decision was
   * made over: it writes only while `owner_user_id` and `ticket_assignee` still hold `expected`, and
   * answers whether it did. A `false` is a decision made over a stale read; the caller re-reads and
   * decides again rather than writing what it held.
   *
   * No version bump: `save` names none of the columns, so no whole-row write can put an older owner
   * back. A caller that also appends `task.owner.changed` from outside the task's own transactions
   * bumps the version first (`bumpVersion`), as every stream appender does. Its callers are the
   * owner decisions in `owner-sync.ts` (intake's sync, a stage's re-read, the `owner_sync` duty, the
   * command, the link adoption) and the write-back's preset and restore of `ticket_assignee` in
   * `owner-write-back.ts` (S-26.3).
   *
   * @throws when the task does not exist.
   */
  saveOwner(
    tx: Transaction,
    taskId: Id,
    write: {
      readonly expected: Pick<TaskOwnership, 'ownerUserId' | 'ticketAssignee'>;
      readonly next: TaskOwnership;
    },
  ): Promise<boolean>;
  /**
   * The **live** tasks (not `done`, not `cancelled`) that nobody owns and whose stored tracker
   * assignee is `(provider, externalId)` — what a newly linked identity adopts (the hook S-26.6
   * calls, `adoptOwnersOnLink`). Oldest first.
   */
  unownedLiveByAssignee(
    tx: Transaction,
    identity: { readonly provider: string; readonly externalId: string },
  ): Promise<readonly { readonly taskId: Id; readonly projectId: Id }[]>;
  /**
   * The tasks still **owed an owner-backfill read** whose next attempt may be claimed now (BACKLOG
   * 1510/1511, migration 0110, `recovery/owner-backfill.ts`): live (not `done`, not `cancelled`),
   * mode `normal`, no stored tracker assignee (`ticket_assignee is null`), `owner_backfill_at` null,
   * fewer than `maxAttempts` attempts claimed, `owner_backfill_retry_at` null or not after `now`,
   * and created before `olderThan` — the most recently touched first (`updated_at` descending, then
   * id), at most `limit` — each with the attempts claimed so far, which the claim compares against.
   */
  ownerBackfillDue(
    tx: Transaction,
    query: {
      readonly olderThan: IsoDateTime;
      readonly now: IsoDateTime;
      readonly maxAttempts: number;
      readonly limit: number;
    },
  ): Promise<readonly { readonly taskId: Id; readonly projectId: Id; readonly attempts: number }[]>;
  /**
   * Claims a task's next owner-backfill attempt: `owner_backfill_attempts + 1` and
   * `owner_backfill_retry_at = retryAt`, in one statement and **only while** the row is unsettled,
   * still at `expectedAttempts` (the count {@link ownerBackfillDue} read) and its retry time is not
   * after `now` — a compare-and-set, so two passes that found the same row claim one attempt
   * between them, and the retry time is the one for the attempt actually claimed. Answers
   * the attempt's number (1-based), or `null` when nothing was claimed (no such task included).
   * No version bump and no `updated_at`: `save` does not name the columns, and the pass's order
   * must not move under its own writes.
   */
  claimOwnerBackfillAttempt(
    tx: Transaction,
    taskId: Id,
    claim: {
      readonly now: IsoDateTime;
      readonly expectedAttempts: number;
      readonly retryAt: IsoDateTime;
    },
  ): Promise<number | null>;
  /**
   * Ends a task's owner backfill: `owner_backfill_at = at` **only while it is null** — a definitive
   * read, or the last attempt failed too. Answers whether it wrote; `false` for a task that does
   * not exist. One statement, the column's only writer; no `updated_at`.
   */
  settleOwnerBackfill(tx: Transaction, taskId: Id, at: IsoDateTime): Promise<boolean>;
  /**
   * Fills `requested_by_user_id` when it is still `null` — the column's first `update` writer
   * (WP-79, PROGRESS backlog 243).
   *
   * Called by `ensureTicketSnapshot` when a stage re-reads a ticket whose reporter maps to a
   * platform user. **Fill, never overwrite**: the statement is `… where requested_by_user_id is
   * null`, so a requester a command wrote at the insert (discovery, a shadow batch) or intake
   * resolved is never replaced by a later read. Narrow because it runs in the `stage.execute` job
   * beside the stage executor (standing rule 79); no version bump, because `save` does not name the
   * column. Answers whether the row moved.
   *
   * @throws when the task does not exist.
   */
  saveRequester(tx: Transaction, taskId: Id, userId: Id): Promise<boolean>;
  /**
   * Moves `ticket_signal_at` forward on every **live** task of one ticket — the ninth narrow writer
   * (WP-60, Q61 (b)).
   *
   * One statement over the project's tasks whose ticket is `(provider, ticketKey)` and whose state
   * is not `done` or `cancelled`, setting the column to the **later** of what it holds and `at`: a
   * redelivered or out-of-order `ticket.updated` can never move it backwards, so the write is
   * idempotent and commutative, which is what an event handler's redelivery needs. No version bump:
   * `save` does not name the column, so bumping the token here would refuse an in-flight aggregate
   * write that never touched it — the partition `tasks-column-ownership.test.ts` holds.
   *
   * Answers how many rows moved, so the handler can log a signal that reached no task.
   *
   * **By the ticket's stable id first** (WP-145, PROGRESS backlog 437): with a `ticketId`, a task
   * matches when it carries that id, or when it carries **no** id (a pre-0077 row, or a provider
   * with none) and has the signal's key — so an unrelated issue that holds a moved issue's old key
   * reaches no task that knows its own id. Without a `ticketId` the key alone decides, as before.
   */
  readonly recordTicketSignal: (
    tx: Transaction,
    signal: {
      readonly projectId: Id;
      readonly provider: string;
      readonly ticketKey: string;
      readonly ticketId?: string | null;
      readonly at: IsoDateTime;
    },
  ) => Promise<number>;
  /**
   * The **live** tasks (`state not in ('done', 'cancelled')`) whose ticket is `provider`'s issue
   * `ticketId` (WP-145), oldest first — the tasks a `ticket.updated` under that id may move to a new
   * key. A task with no recorded id is never answered: its identity is its key.
   */
  readonly listLiveByTicketId: (
    tx: Transaction,
    query: { readonly projectId: Id; readonly provider: string; readonly ticketId: string },
  ) => Promise<readonly StoredTask[]>;
  /**
   * Moves a live task's ticket to the key its issue holds now — the narrow writer of
   * `ticket_key`/`ticket_url` (WP-145, PROGRESS backlog 437; until it, both were insert-only).
   *
   * **Compare-and-set**: written only while the row still holds `fromKey`, is live, and **no other
   * task of the project in the same mode holds `ticket.key`** (the `(project_id, ticket_key, mode)`
   * unique key, which a pre-0077 task created under the new key would otherwise turn into a failed
   * dispatch). `pinBranch`, when not `null`, fills `branch` **only while it is `null`**
   * (`coalesce`), so the work keeps the `agentic/<old key>` branch the first Developer run checks
   * out and `open_mr` opens from. Bumps `version` (rule 79: `branch` is `save`'s column) — which is
   * also the row lock the caller's append on the task's stream needs before it reads the sequence.
   * Answers whether the row moved.
   */
  readonly rekeyTicket: (
    tx: Transaction,
    taskId: Id,
    change: {
      readonly fromKey: string;
      readonly ticketKey: string;
      readonly ticketUrl: string;
      readonly pinBranch: string | null;
    },
  ) => Promise<boolean>;
  /**
   * Records the merge request the developer's `open_mr` opened or adopted — the one writer that
   * sets `mr_ref` to a merge request (WP-138 ruling (e)).
   *
   * **Compare-and-set**: written only while `mr_ref` is `null` or already names the same `iid`
   * (then the stored reference is replaced, **except its `head_sha`**, which only
   * `saveMergeRequestHead` moves forward — review round 1), and only while the task's `branch`
   * is `null` or is `mr.branch` — so a call from a run a rework has since moved to a new branch
   * cannot put the rejected merge request back. Anything else is refused and answered
   * `{ kind: 'refused', recorded }` with the reference the row holds; nothing is written. No version
   * bump: since WP-138 `save` does not name `mr_ref`, so no whole-row write can put an older value
   * back (the partition `tasks-column-ownership.test.ts` holds).
   *
   * @throws when the task does not exist.
   */
  readonly recordMergeRequest: (
    tx: Transaction,
    taskId: Id,
    mr: MergeRequestRef,
  ) => Promise<MergeRequestRecording>;
  /**
   * Lets go of the task's merge request — `mr_ref = null`, only while it still names `iid` (WP-138).
   * One caller: the rework command, in the transaction that also moves the task to its new branch
   * (WP-59, Q92). Narrow because `mr_ref` left `save`'s columns at WP-138. Answers whether it moved.
   */
  readonly releaseMergeRequest: (tx: Transaction, taskId: Id, iid: number) => Promise<boolean>;
  /**
   * Moves `mr_ref.head_sha` **forward only** — a push the provider announced, a human's or the
   * take-over's (WP-60, PROGRESS backlog 182; ordered at review round 1).
   *
   * `at` is the provider's instant of the update (`mr.updated`'s `updated_at`), stored beside the
   * head as `tasks.mr_head_at` (migration 0044). The write happens only while `mr_ref` still names
   * merge request `iid`, the task is live, and `at` is **strictly later** than the stored instant (or
   * none is stored): GitLab documents no delivery order, and the conflict warning, the diff
   * coalescer and the risk routing key on this head, so a late delivery for an older push must never
   * move it back. **An equal
   * instant moves nothing** — two updates the provider stamped at the same instant cannot be ordered,
   * and the first one applied stands. GitLab's webhook instants are **whole seconds** (the page's
   * example carries `.000`), so two pushes inside one second leave the first-applied revision
   * recorded until a later delivery moves it; the CI gate is not exposed to that, because it reads the
   * provider's live head rather than this record (WP-60 review round 2). When the sha is already the recorded one, only `mr_head_at`
   * advances (no version bump: `save` does not own that column), so a stale delivery arriving after
   * the platform's own push was announced is refused too.
   *
   * A head that **does** move bumps `version` in the same statement. That was rule 79's answer while
   * `mr_ref` belonged to `save`; since WP-138 `save` no longer names the column, and the bump stays
   * so a decision a handler made over a snapshot read before the push is refused and re-made rather
   * than written. The census in `tasks-column-ownership.test.ts` names all three `mr_ref` writers.
   *
   * Answers whether the head moved.
   *
   * @throws when the task does not exist.
   */
  readonly saveMergeRequestHead: (
    tx: Transaction,
    taskId: Id,
    head: { readonly iid: number; readonly headSha: string; readonly at: IsoDateTime },
  ) => Promise<boolean>;
  /**
   * Moves `version` — the token {@link TaskRepository.save} guards with — and writes no column of
   * the aggregate (WP-59 review round 1); the SQL adapter also sets the bookkeeping `updated_at`, as
   * every writer of the row does.
   *
   * For a writer that appends to a task's stream **from outside** the task's own transactions: the
   * conflict warning's half on the peer of a pair. That append makes any in-flight
   * load-then-append on the same stream lose the stream-sequence race, and `StreamConflictError` is
   * retried by nobody — so the appender bumps the token **first, in the same transaction**, and
   * every owner whose snapshot predates it meets {@link TaskConcurrentModificationError} at its
   * `save` instead, which the bus and `retryOnTaskConflict` already retry. First, because the
   * statement takes the row lock: a peer transaction that has already saved is waited out, and the
   * appender's re-load after it reads the committed sequence.
   *
   * @throws when the task does not exist.
   */
  readonly bumpVersion: (tx: Transaction, taskId: Id) => Promise<void>;
  /**
   * Records the merge request a rework let go of — in the rework's own transaction (WP-59 review
   * round 1, PROGRESS backlog 178). Not a column of `tasks`: a row of its own table, so it is no new
   * writer of the task row and survives the task adopting the next merge request. A second
   * supersession of the same `(task, iid)` rewrites the row, unsettled again.
   */
  readonly recordSupersededMergeRequest: (
    tx: Transaction,
    record: SupersededMergeRequest,
  ) => Promise<void>;
  /**
   * The `close_superseded_mr` duty's mark: the row reached an ending, and which. A row already
   * settled is left as it is — the first ending is the one that happened.
   */
  readonly settleSupersededMergeRequest: (
    tx: Transaction,
    input: {
      readonly taskId: Id;
      readonly iid: number;
      readonly outcome: SupersededMergeRequestOutcome;
      readonly at: IsoDateTime;
      readonly detail?: string;
    },
  ) => Promise<void>;
  /**
   * Writes **only** `coverage` — the fifth narrow writer, and the fourth for the same reason
   * (WP-39, migration 0027).
   *
   * The record is computed in the `coverage` duty, a `pipeline.outbound` job that fires on
   * `ci.pipeline.finished` and therefore runs beside the stage executor's transactions: a whole-row
   * `save` from there would put back the state, the stage and the cost as they were when the job
   * started (standing rule 79, measured at 0.40 USD in WP-15d). One column, one statement, no
   * version bump — `save` does not name this column.
   *
   * The record is written **whole**, replacing whatever was there: a new pipeline on the same merge
   * request is a new measurement, and the head, the base and the delta have to move together or the
   * panel would show a delta computed from two different revisions. It is also the **cache** the
   * duty reads — `base_sha` is what tells the next wake-up whether the base it is about to read has
   * already been read — which is another reason a partial write would be wrong.
   *
   * @throws when the task does not exist, like `save` and the other narrow writes.
   */
  saveCoverage(tx: Transaction, taskId: Id, coverage: TaskCoverage): Promise<void>;
  /**
   * Writes **only** `dependencies` — the sixth narrow writer, and the fifth for the same reason
   * (WP-38, migration 0028).
   *
   * The record is computed in the `dependency_gate` duty, a `pipeline.outbound` job that fires when
   * the Developer stage completes and therefore runs beside the stage executor's transactions: a
   * whole-row `save` from there would put back the state, the stage and the cost as they were when
   * the job started (standing rule 79, measured at 0.40 USD in WP-15d). One column, one statement,
   * no version bump — `save` does not name this column.
   *
   * It is narrow **even in the `ask` ending**, which does write the whole task in the same
   * transaction: the aggregate write moves the state to `waiting_answers` and the record is not the
   * aggregate's, so the two are written by the two writers that own them rather than merged into
   * one read-modify-write (the partition `tasks-column-ownership.test.ts` checks off disk).
   *
   * The record is written **whole**, replacing whatever was there: each implementation run is a new
   * diff, and the packages, the decision and the question it opened have to move together.
   *
   * @throws when the task does not exist, like `save` and the other narrow writes.
   */
  saveDependencies(tx: Transaction, taskId: Id, dependencies: TaskDependencies): Promise<void>;
  /**
   * Writes **only** `required_reviewers` — the seventh narrow writer (WP-38, migration 0028).
   *
   * Written by the `risk_route` duty (WP-37's), which computed this and until now kept it nowhere:
   * the people a merge request needs a review from lived only in the `set_reviewers` audit row, and
   * that row is written **only when at least one handle resolved to an account**, so a `CODEOWNERS`
   * naming a group left no record at all. product/10:38 asks the Checks panel for *"risk classes
   * **and required reviewers**"*, and this is the half that was missing.
   *
   * Whole-record replacement for the reason `saveRiskClasses` replaces its list: the routing is
   * re-run on every rebase-gate entry and a reviewer the change no longer needs has to leave the
   * row.
   *
   * @throws when the task does not exist, like `save` and the other narrow writes.
   */
  saveRequiredReviewers(tx: Transaction, taskId: Id, reviewers: TaskReviewers): Promise<void>;
  /**
   * Writes **only** `review_threads` — the eighth narrow writer (WP-46, migration 0048).
   *
   * Written by BD-007's review window (`mr.comment.debounce`), which read every discussion on the
   * merge request and until WP-46 kept only a sentence about them. The window is a job that runs
   * beside the stage executor's transactions, so a whole-row `save` from there would put back the
   * state, the stage and the cost as they were when it started (standing rule 79). One column, one
   * statement, no version bump — `save` does not name this column.
   *
   * Whole-record replacement: each window is a new reading of the same threads, and the two counts
   * and the instant have to move together.
   *
   * @throws when the task does not exist, like `save` and the other narrow writes.
   */
  saveReviewThreads(tx: Transaction, taskId: Id, threads: TaskReviewThreads): Promise<void>;
  /**
   * Adds a run's spend to `tasks.cost_actual` — the third narrow writer, and the first that is
   * **not** a read-modify-write at all (WP-31).
   *
   * An ask-the-task run happens beside whatever the pipeline is doing, so it has the same problem
   * `saveWorkpad` and `saveTicketSnapshot` have and one more: the value it writes *depends on the
   * value already there*. A `save` would put back the state, the stage and the workpad as they were
   * when the ask started; even a narrow `set cost_actual = $2` would lose a stage's spend that
   * committed while the ask was running. So the statement is `cost_actual = cost_actual + $2`,
   * which is atomic in the database and needs no version token — the two writers are adding to a
   * running total and their order does not matter.
   *
   * The stage executor keeps its own `save`, because it holds the aggregate and writes the state
   * with it; nothing here changes that. Like the other narrow writes it does not bump
   * `tasks.version`: adding spend is not a change the aggregate's optimistic concurrency is about.
   *
   * A negative amount is refused rather than clamped: money only ever goes one way here, and a
   * caller that computed one has a defect the ledger should not absorb (standing rule 20).
   *
   * @throws when the task does not exist, like `save` and the two writes above.
   */
  addSpend(tx: Transaction, taskId: Id, usd: number): Promise<void>;
  /**
   * The task's own cap, when a maintainer raised it — `tasks.budget_cap_usd` (migration 0072, WP-131
   * review round 1) — or `null` when the default applies. Read by the task cap at admission (the
   * stage executor and the ask executor) in place of `ProjectSettings.taskBudgetUsd`.
   *
   * @throws when the task does not exist.
   */
  budgetCap(tx: Transaction, taskId: Id): Promise<number | null>;
  /**
   * The cap behind the task's **newest** `task.paused` — its `budget_scope` (WP-131 review round 2)
   * — or `null` when the newest pause was not for budget, named no cap (an event appended before the
   * field existed), or there is none. `raiseTaskBudgetCommand` raises only a task the **task** cap
   * paused: raising it for a project's or an organisation's pause would loosen a cap for good and
   * resume into the same pause.
   */
  pausedBudgetScope(tx: Transaction, taskId: Id): Promise<PausedBudgetScope | null>;
  /**
   * Every pause on the task's stream, oldest first (S-27.1, BACKLOG 1480): the `task.paused`
   * instant, and the instant the pause ended — the first `task.resumed` or `task.stage.entered`
   * after it — or `null` while it lasts. What finds the approval wait a pause interrupted (an
   * approval requested before the newest pause and pending, or decided, after it) and what shifts an
   * approval's reminders by the working time its task spent paused (`reminders.ts`).
   */
  pauses(tx: Transaction, taskId: Id): Promise<readonly TaskPause[]>;
  /**
   * **Raises** the task's cap to `capUsd`, and only raises it: answers `raised: false` with the cap
   * in force when `capUsd` is not above it (`defaultCapUsd` when the task has no override), and
   * writes nothing then. The one writer of `tasks.budget_cap_usd`, narrow like `addSpend` (standing
   * rule 79) — `save` never names the column — and it takes the row lock (`for update`) so two
   * raises in one instant compare against each other rather than against the same stale figure.
   *
   * @throws when the task does not exist.
   */
  raiseBudgetCap(
    tx: Transaction,
    input: { readonly taskId: Id; readonly capUsd: number; readonly defaultCapUsd: number },
  ): Promise<{ readonly raised: boolean; readonly previousCapUsd: number }>;
  /**
   * WIP counting (BD-010); `countsAsActive` / `countsInPipeline` decide which states count.
   *
   * **It serialises admission per project for the rest of `tx`** (WP-91): an implementation makes
   * a second caller for the same project wait until the first caller's transaction ends, and then
   * counts what it committed — so two admissions in one instant cannot both pass a limit of one.
   * The counted rows are the tasks themselves (committed state, not a projection written after the
   * fact — standing rule 89). The SQL adapter takes a transaction-scoped advisory lock; the
   * in-memory store is single-threaded and needs none. `pipeline-store-concurrency-suite.ts` holds
   * both to it.
   *
   * **What the serialisation costs, bounded** (WP-115, PROGRESS backlog 314). Two callers take it:
   * `intake_check`, inside a `pipeline.outbound` job (one worker per process, so a process never
   * has two intakes waiting on each other), and `pipeline.scheduler`, inside a dispatch (up to
   * `APP_DISPATCH_MAX_CONCURRENCY` at once). A waiter holds only connections the pool floor already
   * reserves for it — the outbound worker's one, or the dispatch's two — so it cannot make another
   * project's work wait for the pool; and the lock is held from the count to the caller's commit,
   * a handful of statements. Measured at the e2e tier (three `apps/server` processes, dispatcher
   * concurrency 4, M = 20 and 60 intakes for one project beside one for another, then the same
   * number of scheduler passes; Apple M3 Max, load 4–7): **no** wait on this lock of 1 ms or more
   * in any run (server-logged with `log_lock_waits` at `deadlock_timeout = 1ms`, the instrument
   * proved by a deliberate 30 ms wait), every pool's waiting count **0**, and the second project's
   * latency the same with the lock and without it (3.50 s at M = 20, set by the outbound queue's
   * order, not by the lock). The numbers are in PROGRESS under backlog 314.
   */
  counts(
    tx: Transaction,
    projectId: Id,
  ): Promise<{ readonly activeTasks: number; readonly tasksInPipeline: number }>;
  /** Queued tasks of a project, for the scheduler to order with `orderQueue`. */
  queued(tx: Transaction, projectId: Id): Promise<readonly QueuedTask[]>;
  /** One `task_stages` row per entry (technical/03); `attempt` comes from the aggregate. */
  recordStageEntered(
    tx: Transaction,
    entry: {
      readonly taskId: Id;
      readonly stage: Slug;
      readonly attempt: number;
      readonly causedByEventId: Id | null;
    },
  ): Promise<void>;
  /**
   * **Counts one more re-offerable ending on the stage entry** and answers the new count (WP-285,
   * WP-286, TD-031 §12): `lost` is `task_stages.lost_runs` — a run the lease sweep ended
   * `lease_expired` — and `usage_limited` is `usage_limited_runs` — a run that ended `rate_limited`.
   * One `update … returning`, in the terminal writer's own transaction, so two writers cannot both
   * read a count of zero. The first of each re-plans the entry and the second escalates it. `null`
   * when the entry has no row (a stage the task never recorded entering): the caller escalates.
   *
   * **It locks the task's row before the entry's** (`tasks`, then `task_stages`), the order every
   * other terminal writer takes them in — `settleRun`'s `addSpend` before its `recordStageExited`
   * — so the lease sweep, which writes nothing to `tasks` before it counts, cannot take them the
   * other way round.
   */
  countStageRunEnding(
    tx: Transaction,
    entry: {
      readonly taskId: Id;
      readonly stage: Slug;
      readonly attempt: number;
      readonly kind: 'lost' | 'usage_limited';
    },
  ): Promise<number | null>;
  /**
   * Closes the row `recordStageEntered` opened, with what the stage decided.
   *
   * `state` is one of `taskStageExitStateSchema`'s three words and the store **parses** it before
   * writing (WP-55): the column's vocabulary is the contracts', not whatever a caller spelled.
   * `returnedTo` is the stage a return sent the task to — non-null exactly when `state` is
   * `returned` — and it is what {@link lastReturnReason} reads by.
   */
  recordStageExited(
    tx: Transaction,
    entry: {
      readonly taskId: Id;
      readonly stage: Slug;
      readonly attempt: number;
      readonly state: TaskStageExitState;
      /** One word of `taskStageOutcomeSchema`, parsed by the store before it writes (WP-73). */
      readonly outcome: TaskStageOutcome;
      readonly returnReason: string | null;
      readonly returnedTo: Slug | null;
      /**
       * The length `returnReason` would have had had its writer not cut it, or `null`/absent when
       * nothing was cut (WP-81, migration 0058). Written by one caller: a failed CI gate bounds the
       * failing job's log to its head and tail, and the next run's `return_feedback` marker
       * announces that cut as `truncated="true"` (technical/04). A positive integer when present.
       */
      readonly returnReasonOriginalChars?: number | null;
    },
  ): Promise<void>;
  /**
   * Closes a stage row **that is still open** as `failed`, because its attempt can no longer
   * resume — the task was parked there, a new attempt was entered, the task was cancelled or
   * finished (WP-46, PROGRESS backlogs 160 and 212) — and does nothing to a row that is already
   * closed. The `outcome` says which ending it was.
   *
   * The conditional is the whole difference from {@link recordStageExited}: such an ending is the
   * last word on an attempt only when nothing closed it first. An agent stage's row is closed by
   * the stage executor (with its verdict, or `failed`) before any escalation that follows, and a
   * gate the platform settled and then could not move past (an illegal transition, caught and
   * escalated) has already recorded its verdict — overwriting either would replace what the stage
   * decided with what the task did next. So the write is `where state = 'running'`, and a closed
   * row keeps its outcome. `return_reason` carries the escalation's reason with no target, as the
   * executor's `failed` rows do; `lastReturnReason` never reads a row that is not a return.
   *
   * The invariant this serves is stated once, at `closeLeftStage` in `transitions.ts`.
   */
  closeOpenStage(
    tx: Transaction,
    entry: {
      readonly taskId: Id;
      readonly stage: Slug;
      readonly attempt: number;
      /** One word of `taskStageOutcomeSchema`, parsed by the store before it writes (WP-73). */
      readonly outcome: TaskStageOutcome;
      readonly reason: string;
    },
  ): Promise<void>;
  /**
   * Records the **convergence signature** of one stage attempt (`task_stages.signature`).
   *
   * A column of its own rather than a reuse of `outcome`, and the reason is a defect this replaced:
   * `outcome` is written by whichever path closes the row — the executor writes the verdict, the
   * transition writes `returned` — so a signature stored there is overwritten by the very
   * transition it exists to stop. Convergence detection needs a value nothing else writes.
   *
   * The signature is machine-facing and stable across attempts (product/04 S4 "Three identical
   * failures in a row", S5 "the same findings as the previous round"); the human-facing text stays
   * in `return_reason`.
   */
  recordStageSignature(
    tx: Transaction,
    entry: {
      readonly taskId: Id;
      readonly stage: Slug;
      readonly attempt: number;
      readonly signature: string;
    },
  ): Promise<void>;
  /**
   * **Keeps a gate's last failure through a person's return** (WP-152, PROGRESS backlog 491,
   * migration 0086): moves `stage`'s attempt `attempt`'s `return_reason` (and its
   * `return_reason_original_chars`) into `attached_feedback` (and `attached_feedback_original_chars`)
   * — **only** on a row closed `returned` that holds a non-empty reason — records `send` as
   * `attached_feedback_sent`, and answers whether it moved one. The move does not depend on `send`
   * (ruling (a): the excerpt is kept); `send` is the person's choice of whether the next run is handed
   * it (ruling (b)), and {@link lastReturnReason} reads it.
   *
   * Why a move and not a read: a person's return from `needs_human` closes the **same** row the
   * gate's spent loop closed — the same `(task, stage, attempt)` — and {@link recordStageExited}
   * overwrites its `return_reason` with the person's note, so the CI excerpt was lost before anyone
   * could ask for it (measured at `068a0cfb`). The command calls this in its own transaction, just
   * before the return writes the row; {@link lastReturnReason} then hands the target stage both.
   * The text moves as it is: it was redacted when the gate stored it (TD-012), and nothing here
   * re-derives or keys anything on it (rule 70).
   *
   * A row that is open, closed some other way, or holds no reason (or an empty one) moves nothing
   * (`false`), so the caller can refuse a request to attach where there is nothing to attach
   * (`no_gate_feedback`).
   */
  attachReturnReason(
    tx: Transaction,
    entry: {
      readonly taskId: Id;
      readonly stage: Slug;
      readonly attempt: number;
      /** Whether the next run is handed the kept text (`attach_gate_feedback`). */
      readonly send: boolean;
    },
  ): Promise<boolean>;
  /**
   * Whether `stage`'s attempt `attempt` has a `task_stages` row, and whether it is still open
   * (`running`, never exited) — WP-108 review round 1, PROGRESS backlog 365. `absent` for a task
   * written before every entry opened a row: the executor treats it as open, the fail-open
   * direction for a row nothing could have closed.
   */
  stageAttemptState(
    tx: Transaction,
    taskId: Id,
    stage: Slug,
    attempt: number,
  ): Promise<'open' | 'closed' | 'absent'>;
  /**
   * When `stage`'s attempt `attempt` was entered (`task_stages.entered_at`, the database's clock)
   * and whether it is still open — `null` when the attempt has no row (WP-136).
   *
   * The CI gate's wait on a poll-only binding is timed from this instant, read on every fire, so a
   * lost, recovered or replayed job cannot restart the clock; a hand-back opens a new attempt, and
   * a job of the old attempt finds it closed.
   */
  stageAttemptEntry(
    tx: Transaction,
    taskId: Id,
    stage: Slug,
    attempt: number,
  ): Promise<{ readonly open: boolean; readonly enteredAt: IsoDateTime } | null>;
  /**
   * Records the CI gate's last pending read on `stage`'s attempt `attempt` — `null` for a pending
   * read that found no pipeline to wait on (backlog 1078, migration 0107). Writes **only an open
   * row** (`state = 'running'` and never exited), so a job of an attempt somebody left cannot move a
   * closed attempt's last read, and answers whether it wrote. A narrow write of one column of
   * `task_stages`, never the task row: the gate's poll runs beside the stage executor.
   */
  recordCiPendingRead(
    tx: Transaction,
    entry: { readonly taskId: Id; readonly stage: Slug; readonly attempt: number },
    read: CiPendingRead | null,
  ): Promise<boolean>;
  /**
   * `stage`'s attempt `attempt`'s own last pending read, or `null` when it has none recorded (or
   * no row) — what tells the gate whether a read is the attempt's first (backlog 1078).
   */
  ciPendingReadOf(
    tx: Transaction,
    taskId: Id,
    stage: Slug,
    attempt: number,
  ): Promise<CiPendingRead | null>;
  /**
   * Records how the CI gate's own wait ended `stage`'s attempt `attempt` (`task_stages.ci_ending`,
   * backlog 1078) — in the settling transaction, before the escalation closes the row, and **only
   * while the row is open**; answers whether it wrote. The task read words the stop from it.
   */
  recordCiEnding(
    tx: Transaction,
    entry: { readonly taskId: Id; readonly stage: Slug; readonly attempt: number },
    ending: CiGateEnding,
  ): Promise<boolean>;
  /**
   * Records what a CI **pass** left unstarted on `stage`'s open attempt
   * (`task_stages.ci_manual_not_run`, migration 0109, S-27.2, TD-036 decision 5) — in the settling
   * transaction, before the pass closes the row, and **only while the row is open**; answers
   * whether it wrote. The one writer. `attempt` is the settling job's, or absent for a pipeline's
   * event (`ci-settle.ts`), which settles whatever attempt is open — at most one per stage.
   */
  recordCiManualNotRun(
    tx: Transaction,
    entry: { readonly taskId: Id; readonly stage: Slug; readonly attempt?: number },
    value: CiManualNotRun,
  ): Promise<boolean>;
  /**
   * What `stage`'s **current pass** left unstarted (S-27.2, the security review of #114): the
   * `ci_manual_not_run` of the stage's **newest** attempt, only when that attempt closed `completed`
   * and no stage of the task was sent back (`returned`) after it closed — `null` while a later
   * attempt is open, after a send-back, when it recorded none or none has passed. A stored value
   * that does not parse is refused, never defaulted. The workpad reads it, so its CI line is never
   * about a pass the task has since moved away from.
   */
  latestCiManualNotRun(tx: Transaction, taskId: Id, stage: Slug): Promise<CiManualNotRun | null>;
  /**
   * The last pending read of `stage`'s latest attempt **before** `attempt` — what a retry's first
   * read compares itself with (backlog 1078 criterion 3) — or `null` when there is no earlier
   * attempt or it recorded none. A stored value that does not parse is refused, never defaulted.
   */
  previousCiPendingRead(
    tx: Transaction,
    taskId: Id,
    stage: Slug,
    attempt: number,
  ): Promise<CiPendingRead | null>;
  /** The last `limit` signatures at `stage`, oldest first — the order `hasIdenticalFailureStreak` wants. */
  recentStageSignatures(
    tx: Transaction,
    taskId: Id,
    stage: Slug,
    limit: number,
  ): Promise<readonly string[]>;
  /**
   * The finding `stage`'s attempt `attempt` was sent back to fix, for that run's prompt — or `null`
   * when this attempt was not entered by a return.
   *
   * **The reason is read off the attempt that produced it** (WP-55, PROGRESS backlog 67, ruling
   * (a)): the newest closed row on this task whose `returned_to` is `stage` **and which closed after
   * `stage`'s previous attempt did** (or was entered, for an attempt nobody closed, or for an
   * attempt that is itself a return to `stage` — a human return or rework at the stage the task is
   * at, whose exit *is* the return) — and, once
   * attempt `attempt` has been entered, no later than that entry, so the question has one answer
   * however many loops follow. The first two halves are load-bearing. Until WP-55 the read was *this stage's own* newest `return_reason`, which on
   * every shipped edge is the complaint this stage made when *it* returned somewhere else — a wrong
   * sentence inside the block the role prompt presents as feedback. And without the second half, a
   * stage re-entered by a forward move would be handed the finding of a loop it already answered.
   */
  lastReturnReason(
    tx: Transaction,
    taskId: Id,
    stage: Slug,
    attempt: number,
  ): Promise<ReturnFeedback | null>;
  /**
   * The take-over a human still holds on this task, or `null` — WP-56, PROGRESS backlog 69.
   *
   * A **narrow read of the task's own event stream**, not a column: `tasks` records that a task is
   * `paused` and not *why*, and the session id of the run a take-over interrupted is on no row at
   * all. The answer is the newest of the events that can start or end a take-over
   * ({@link TAKE_OVER_BOUNDARY_EVENTS}), and it is a take-over exactly when that newest one is
   * `task.taken_over`. So a hand-back withdraws it, and so do a resume, a stage entry, a completion
   * and a cancellation — the pipeline moving again means nobody is holding the task — while an
   * **escalation does not**: a taken-over task the inactivity timer parks in `needs_human` is still
   * in the hands of the person who took it, and the workpad that tells everybody so must keep
   * saying where the branch is (criterion 6).
   *
   * It is what the workpad render and the take-over timer both ask, so the block and the timer
   * follow **state** rather than whichever wake-up happened to carry the payload.
   */
  takenOver(tx: Transaction, taskId: Id): Promise<TakeOverRecord | null>;
  /**
   * The `ticket.status.changed` events recorded for this task's ticket **after its latest entry into
   * `stage`** (its newest `task.stage.entered` naming it), at most `limit`, **newest first** or —
   * with `order: 'oldest_first'` — oldest first, or `[]` when the task never entered the stage.
   * WP-178 criterion (14): the human-return window reads the newest at `qa` for
   * `HumanReturnInput.leftQa` — the newest change whose `from` is the `qa` slot — and, since WP-178's
   * review, the oldest at both human stages for the entry status (TD-029 decision 7's amendment (e)),
   * so a bound of `limit` never hides the changes the entry is read from.
   *
   * The ticket is the task's by WP-145's rule (`findByTicketSignal`'s): by the stable id when both
   * the event and the row carry one, by the key otherwise, of the task's provider. Ordered by the
   * log's `position`, which is the order both streams were committed in. A read of the append-only
   * log; it writes nothing.
   */
  ticketStatusChangesSinceEntry(
    tx: Transaction,
    query: {
      readonly taskId: Id;
      readonly stage: Slug;
      readonly limit: number;
      /** Absent is `newest_first`. */
      readonly order?: 'newest_first' | 'oldest_first';
    },
  ): Promise<readonly TicketStatusChange[]>;
  /**
   * Records what the human-return window saw of the ticket's status during one entry into a human
   * stage — `task_stages.entry_ticket_status` and `ticket_seen_at_qa` on the `(task, stage,
   * attempt)` row (migration 0089, WP-178 review, TD-029 decision 7's amendment (a) and (b)) — and
   * answers the row's values after the write. `entryStatus` is written **only while the column is
   * null** (the entry is the first reading, never moved); `seenAtQa` is **or**-ed in (a sighting is
   * never cleared). `null` when the row does not exist. One statement, so two firings of the window
   * cannot both write the entry.
   */
  observeHumanStageStatus(
    tx: Transaction,
    entry: {
      readonly taskId: Id;
      readonly stage: Slug;
      readonly attempt: number;
      readonly entryStatus: string;
      readonly seenAtQa: boolean;
    },
  ): Promise<HumanStageStatus | null>;
}

/** What {@link TaskRepository.observeHumanStageStatus} answers: the row's record after the write. */
export interface HumanStageStatus {
  /** Provider text (BD-022). */
  readonly entryStatus: string;
  readonly seenAtQa: boolean;
}

/** One `ticket.status.changed`, as {@link TaskRepository.ticketStatusChangesSinceEntry} reads it. */
export interface TicketStatusChange {
  /** Provider text (BD-022). */
  readonly from: string;
  /** Provider text (BD-022). */
  readonly to: string;
}

/**
 * The events whose newest occurrence on a task's stream decides whether it is taken over (WP-56).
 *
 * One list for the SQL store and the in-memory one, so the two answer the same question; the
 * contract suite asserts each ending. `task.escalated` is **deliberately absent**, for the reason
 * {@link TaskRepository.takenOver} gives.
 */
export const TAKE_OVER_BOUNDARY_EVENTS = [
  'task.taken_over',
  'task.handed_back',
  'task.resumed',
  'task.stage.entered',
  'task.completed',
  'task.cancelled',
] as const;

/** One pause of a task, as {@link TaskRepository.pauses} reads it off the task's stream. */
export interface TaskPause {
  readonly pausedAt: IsoDateTime;
  /** The first `task.resumed` or `task.stage.entered` after it; `null` while the task is paused. */
  readonly endedAt: IsoDateTime | null;
}

/** The events that end a pause, for {@link TaskRepository.pauses} — one list for both stores. */
export const PAUSE_ENDING_EVENTS = ['task.resumed', 'task.stage.entered'] as const;

/** A take-over in force, as `task.taken_over` recorded it (product/19 §19, WP-27). */
export interface TakeOverRecord {
  /** The `task.taken_over` event's own id — which take-over this is, when there were several. */
  readonly eventId: Id;
  /** When it was taken. */
  readonly at: IsoDateTime;
  readonly branch: string;
  readonly sessionId: string | null;
  readonly stage: Slug;
  /** The user the `task.taken_over` event names as its actor — who holds the task. */
  readonly holderUserId: Id | null;
  /**
   * The newest **activity** by the holder, and the instant the inactivity timeout counts from
   * (WP-44, PROGRESS backlog 167; product/19 §19's *"5 working days of inactivity"*).
   *
   * Activity is, exactly: the take-over itself, and a `human_actions` row on this task written by
   * {@link holderUserId} after it — any command they issue (a pause, an answer, feedback, a steer,
   * an ask). **Not** a row by anybody else, and **not** `mr.updated`: the event reaches this ring
   * with no author, because **our normalisers drop it** — GitLab's merge-request hook does name who
   * triggered it (`user`), as GitHub's `sender` would — and the platform's own pushes produce the
   * same event, so counting it unattributed would let a bot's push, or the platform's, keep a
   * person's take-over alive. Carrying the author on `mr.updated` is a normaliser change (PROGRESS
   * backlog 207); an `mr.updated` by the holder is then the second signal. Until then it is absent.
   *
   * One definition, read by both the timer (`expireTakeOver`) and its recovery row
   * (`recovery/deadline.ts`), so the two cannot disagree about when a take-over went quiet.
   */
  readonly lastActivityAt: IsoDateTime;
}

/**
 * The finding a return carried, as {@link TaskRepository.lastReturnReason} reads it back (WP-81):
 * the stored reason and, when its writer cut it, the length it would have had uncut — which the
 * prompt's `return_feedback` marker announces as `truncated="true"` rather than as a line in the
 * body. `originalChars` is `null` for every reason nothing cut.
 */
export interface ReturnFeedback {
  readonly reason: string;
  readonly originalChars: number | null;
  /**
   * The artifact **the returning attempt produced**, when it produced one — which is the verdict
   * that caused the return (WP-83, PROGRESS backlog 159's stale-artifact half).
   *
   * Read by link: the `ReviewVerdict` or `AcceptanceVerdict` (the only types a verdict returns a
   * task by) whose `produced_by_run_id` is a run of the returning `task_stages` row
   * (`runs.task_stage_id`), the highest version if an attempt had several runs; another artifact
   * type the attempt produced is never the cause. So a review
   * or acceptance return names its own `ReviewVerdict`/`AcceptanceVerdict` version, and a return
   * that no artifact caused — a gate's (CI, the rebase, a protected path), a human's return or
   * rework, the review window's threads — has **none**, because a gate produces nothing and a human
   * return leaves the stage while its attempt has produced nothing (an attempt that produced its
   * verdict has already left the stage). **Absent** rather than `null` when there is none, so a
   * caller that reads only the reason is unchanged.
   *
   * The planner shows a returned stage this verdict and no other (`planner.ts`,
   * `artifactsShownTo`).
   */
  readonly cause?: ReturnCause;
  /**
   * The gate's last failure a person sent on with this return (WP-152, migration 0086): the
   * returning row's `attached_feedback`, which {@link TaskRepository.attachReturnReason} moved there
   * before the person's note took `return_reason`, **when `attached_feedback_sent`**. **Absent**
   * when nothing was sent — every return but a person's from a parked gate with the box left ticked,
   * an unticked one included, whose text is kept on the row and not handed on — so a caller that
   * reads only the reason is unchanged. When present, {@link reason} is the person's note.
   */
  readonly attached?: AttachedReturnFeedback;
}

/** {@link ReturnFeedback.attached}: the gate's stored text and its uncut length (WP-152). */
export interface AttachedReturnFeedback {
  readonly reason: string;
  /** The length the gate's text had before the gate cut it, `null` when nothing was cut (WP-81). */
  readonly originalChars: number | null;
}

/** Which artifact caused a return: its type and version, which identify it on the task. */
export interface ReturnCause {
  readonly type: ArtifactType;
  readonly version: number;
}

export interface StoredArtifact {
  readonly id: Id;
  readonly taskId: Id;
  readonly type: ArtifactType;
  readonly version: number;
  readonly markdown: string | null;
  /**
   * The artifact's `data`, **already redacted** (TD-012, WP-52).
   *
   * Every writer passes it through `redactArtifactData` first: prose replaced, an identifier field
   * carrying an injected secret refused rather than rewritten. The redaction is at the write
   * because `artifacts` is append-only — a row written today cannot be fixed later.
   */
  readonly data: JsonValue;
  readonly schemaVersion: string;
  readonly producedByRunId: Id | null;
  /**
   * How many replacements the redaction made in {@link data}.
   *
   * `null` reads as *"no redactor ran"* and is reachable only for a row written before migration
   * 0038; `0` is *"the redactor ran and replaced nothing"*. The two are different facts, which is
   * why this is nullable on the way **out** and required on the way **in** ({@link NewArtifact}).
   */
  readonly redactionCount: number | null;
  readonly createdAt: IsoDateTime;
}

/**
 * What a writer must supply — {@link StoredArtifact} with the redaction count **required**.
 *
 * A new row may never claim the pre-0038 `null`: a writer with nothing to redact writes `0`, and
 * one that skipped redaction altogether is refused by the type here and by the table's own
 * `artifacts_redaction_count_recorded` check (migration 0038). That is criterion (2)'s second
 * direction — "a writer that redacted nothing is impossible" — held in two places rather than
 * promised in one (standing rule 42).
 */
export type NewArtifact = Omit<StoredArtifact, 'redactionCount'> & {
  readonly redactionCount: number;
};

export interface ArtifactRepository {
  /** "Artifacts are versioned; a stage re-run creates a new version, never overwrites." */
  nextVersion(tx: Transaction, taskId: Id, type: ArtifactType): Promise<number>;
  insert(tx: Transaction, artifact: NewArtifact): Promise<void>;
  latest(tx: Transaction, taskId: Id, type: ArtifactType): Promise<StoredArtifact | null>;
  listFor(tx: Transaction, taskId: Id): Promise<readonly StoredArtifact[]>;
}

/**
 * {@link RunRepository.lastEnded}'s answer: how the stage's latest ended run ended (PROGRESS
 * backlog 476) — the platform's own record, in closed vocabularies, for the next attempt's prompt.
 */
export interface EndedRun {
  readonly runId: Id;
  readonly status: RunStatus;
  readonly terminalReason: RunTerminalReason | null;
  readonly numTurns: number;
}

/** {@link RunRepository.lastSavedWork}'s answer: the run, how it ended, and what it saved. */
export interface SavedAttempt {
  readonly runId: Id;
  readonly terminalReason: RunTerminalReason;
  readonly numTurns: number;
  readonly savedWork: RunSavedWork;
}

export interface StoredRun {
  readonly id: Id;
  readonly taskId: Id;
  readonly projectId: Id;
  /**
   * The stage attempt this run belongs to — a **link**, not a column of `runs`.
   *
   * technical/03 keeps the stage on `task_stages`, so an adapter resolves `runs.task_stage_id` from
   * `(taskId, stage, attempt)` on insert and joins it back on load. `null` is therefore "this run
   * is attached to no stage attempt", which is what a run created outside the pipeline has and what
   * every run stored before WP-15h has — that work package is where the link started being written
   * at all, and where the reader that needs it (`RunRecord.stage` is required) started refusing the
   * rows that have none.
   */
  readonly stage: Slug | null;
  readonly role: string;
  readonly mode: string;
  readonly attempt: number;
  readonly model: string;
  readonly effort: string;
  readonly promptVersion: string;
  readonly status: RunStatus;
  readonly terminalReason: RunTerminalReason | null;
  readonly sessionId: string | null;
  readonly numTurns: number;
  readonly usage: TokenUsage | null;
  readonly cost: RunCost | null;
  readonly wallMs: number;
  readonly createdAt: IsoDateTime;
  /**
   * When the run asked for its CLI — its CLI spawn marker's instant — or `null` for a run that
   * never did.
   *
   * Read since WP-15i, because `POST /api/runs/:run_id/cancel` ends a run from **another process**
   * than the one executing it: the executor has the `Run` aggregate it created in memory and can
   * compute the wall time from it, and a cancelling request has only the row. Without this the
   * cancelled run's `wall_ms` would have to be written as `0`, which is a measurement nobody made.
   *
   * Since WP-275b it is written by the CLI spawn marker (`markCliSpawnRequested`), never by the
   * insert, so it is `null` for every run that ended before it asked for its CLI.
   */
  readonly startedAt: IsoDateTime | null;
  /**
   * When the process holding the run recorded that it was about to ask for the run's CLI —
   * `runs.cli_spawn_requested_at` (migration 0085, WP-150) — or `null` when it never did.
   *
   * `null` is a **proof**, not an absence: no CLI is started without this record
   * ({@link RunRepository.markCliSpawnRequested}), so a run whose marker is null never sent a model
   * request and is a measured zero, which no cap holds (BD-010's 2026-10-06 amendment). Every row
   * written before the migration was backfilled, so it reads as having reached the CLI.
   *
   * Optional on the type because `insert` never writes it — the marker's own method does — and
   * `load` always answers it.
   */
  readonly cliSpawnRequestedAt?: IsoDateTime | null;
  /**
   * The ask this run answers (`runs.ask_id`, migration 0082) — read back since WP-276, because the
   * ask's ending is settled by a claimant that holds nothing but the run id. `null` (or absent from
   * a writer's own shape) for a stage run.
   */
  readonly askId?: Id | null;
}

/**
 * What a writer must supply to create a run — {@link StoredRun} plus the three columns Q64 gave a
 * writer at WP-52.
 *
 * They are on the **write** shape only, and deliberately not on `StoredRun`: `load` would then have
 * to select two `text` columns holding a whole assembled prompt on every read of a run row, for the
 * benefit of no caller in the pipeline. The reader that wants them is the API projection
 * (`apps/server/src/queries/pipeline-queries.ts`), which selects exactly those columns and nothing
 * else.
 */
export type NewRun = StoredRun & {
  /**
   * The ask this run answers (`runs.ask_id`, migration 0082, WP-149) — set by the ask executor's
   * insert alone, absent for a stage run. What {@link RunRepository.askShutdownEndings} counts by.
   */
  readonly askId?: Id;
  /**
   * `RunSpec.systemPromptAppend` — layers 1-3 — redacted at the write (TD-012).
   *
   * `null` is *"this run was created without an assembled prompt"*, which no production path
   * produces: both `runs.insert` call sites pass the spec the runner was handed. It exists for a
   * store-level fixture that creates a row to test something else, and it is what the reader
   * distinguishes from a stored prompt by name (409 `prompt_not_recorded`).
   */
  readonly systemPrompt: string | null;
  /** `RunSpec.userPrompt` — layers 4-6: the task block, the context pack, the output contract. */
  readonly userPrompt: string | null;
  /**
   * How many replacements the redactor made **in those two columns**.
   *
   * Not the run's total: the transcript's own count is the runner's (`RunOutcome.redactionCount`)
   * and the artifact's is on the artifact row. A prompt with nothing to redact writes `0`.
   */
  readonly redactionCount: number;
  /**
   * The context pack the run was planned with — `StageRunPlan.contextPack`, the record `run.started`
   * carries — stored as `run_context_pack` rows plus the header columns on `runs` (migration 0041,
   * WP-57, PROGRESS backlog 31).
   *
   * Written in the **same statement batch as the row**, so a run and its pack commit together or
   * not at all. `null` is *"no pack was recorded"*, which no production path produces — both
   * `runs.insert` call sites pass their plan's record — and which the reader refuses by name
   * (409 `context_pack_not_recorded`); an **empty** pack is a record with empty tiers, never `null`.
   * Write-only for the reason the prompt columns are: the pipeline never reads it back, and the API
   * projection selects it itself.
   */
  readonly contextPack: ContextPackRecord | null;
  /**
   * The effective configuration the run was planned with and its hash — `runs.settings_snapshot`
   * and `runs.settings_hash`, whose first writer this is (WP-91, PROGRESS backlog 227;
   * `settings-snapshot.ts` has what is in it and how the hash is taken).
   *
   * Written in the row's own insert. `null` is *"no snapshot was recorded"*, which no production
   * path produces — both `runs.insert` call sites pass one — and which the row spells as
   * `settings_hash is null` beside 0004's `'{}'` default; that pair is also what every run created
   * before WP-91 reads as. Write-only, for the prompt columns' reason.
   */
  readonly settings: RunSettingsSnapshot | null;
  /**
   * The reservation the run was admitted at — its per-run cap, `runs.reserve_usd` (migration 0072,
   * WP-131): `runBudgetUsd` for a stage run, `features.ask.budget_usd` for an ask. It is what every
   * cap **holds** the run at if it ends with nobody measuring it ({@link RunRepository.heldFor},
   * `../cost/pending.ts`). `null` is *"no reservation was recorded"*, which no production path
   * produces; a figure of `0` (a stage configured at no cap) is stored as `null` too, because the
   * column refuses it. Write-only, for the prompt columns' reason.
   */
  readonly reserveUsd: number | null;
  /**
   * Why the project's prompt files were withheld from this run's prompt — `runs.prompts_withheld`
   * (migration 0073, WP-121, PROGRESS backlog 363): the repository reading's record
   * (`ProjectSettings.repositoryPromptsWithheld`), frozen at the insert. `null` is *"nothing was
   * withheld"* — and an ask, which is given no prompt file. Write-only, for the prompt columns' reason.
   */
  readonly promptsWithheld: PromptsWithheld | null;
  /**
   * The provider mode the run was **planned** with — `RunSpec.providerMode`, `runs.provider_mode`
   * (PROGRESS backlog 454). Required, because the column's `default 'api'` is exactly what made
   * every `local`-mode run read as API-billed before this had a writer. Write-only, for the prompt
   * columns' reason: the API projection reads it, `load` does not.
   */
  readonly providerMode: ProviderMode;
};

/**
 * The fence a claimant's write carries (WP-274, TD-031 decision 2): the epoch its claim was granted
 * and the `lease_owner` it wrote. A write that carries one is conditional on both.
 */
export interface RunLeaseFence {
  readonly epoch: number;
  /** `null` only in a composition that configures no run lease (`offers.ts`, `OfferAndClaimInput`). */
  readonly owner: string | null;
}

/**
 * A fenced write found the run **live** under another claim — a different `lease_epoch` or
 * `lease_owner` (WP-274, TD-031 decision 2's in-process `LeaseLostError`). A run that is already
 * terminal is not this error: `finish` answers `false` for it, as it always has.
 *
 * Thrown rather than answered so that a caller's transaction rolls back whatever it wrote before
 * the fenced statement — a claimant that lost the run writes nothing (TD-031 §2).
 */
export class LeaseLostError extends Error {
  override readonly name = 'LeaseLostError';
  readonly code = 'lease_lost' as const;
  readonly runId: Id;
  readonly fence: RunLeaseFence;

  constructor(runId: Id, fence: RunLeaseFence) {
    super(
      `run ${runId} is live under another claim than epoch ${fence.epoch} held by ${fence.owner}: lease_lost`,
    );
    this.runId = runId;
    this.fence = fence;
  }
}

/**
 * `run_offers.withdrawn_reason` — a **code**, never a sentence (WP-278 review, BACKLOG 731): the
 * column is checked at 1–64 characters (migration 0094), and a sentence built from a free reason
 * (`the task was escalated: ${reason}`) failed that check and rolled back the escalation that
 * closed the offer. The sentence stays where it is read — `run.offer.withdrawn`'s `reason`, the
 * escalation's brief. A run's own terminal writer closes an offer with its terminal reason
 * (`closeRunOffer`), which is an enum value and as short.
 */
export const OFFER_WITHDRAWAL_CODES = [
  'paused_by_human',
  'cancelled_by_human',
  'taken_over',
  'dead_lettered',
  'config_unreadable',
  'write_conflict',
  'job_escalated',
  'mr_closed',
  'mr_merged',
  'stage_left',
  'run_plan_missing',
  'offer_timeout',
  // TD-031 §2 (backlog 744): a budget refused the run at the claim (`claim-admission.ts`).
  'budget_at_claim',
] as const;
export type OfferWithdrawalCode = (typeof OFFER_WITHDRAWAL_CODES)[number];

/** A `run_offers` row's lifecycle (TD-031 decision 1, migration 0094). */
export type RunOfferState = 'open' | 'claimed' | 'settled' | 'withdrawn';

/** An offer as written in its run's creation transaction (WP-274). */
export interface NewRunOffer {
  readonly id: Id;
  readonly runId: Id;
  readonly taskId: Id;
  readonly projectId: Id;
  /** The stage entry the run serves; `null` for an ask's offer. */
  readonly stage: Slug | null;
  readonly attempt: number;
  readonly kind: RunOfferKind;
  readonly offeredAt: IsoDateTime;
  /**
   * Who may claim it, and from when (WP-278, TD-031 decision 8): `routeOffer`'s answer over the
   * project's execution settings. `serverFrom` and `workersFrom` both `null` is an offer written
   * before WP-278, which the server's claim takes at once.
   */
  readonly routing: OfferRouting;
  /**
   * The workers this offer is **not** for (`excluded_worker_ids`, TD-031 §12): the stage entry's
   * previous offer's exclusions, plus the worker that lost it —
   * {@link RunOfferRepository.carriedExclusions}, read by `stage.execute` when it re-plans an entry.
   * Absent is none.
   */
  readonly excludedWorkerIds?: readonly Id[];
}

/** An offer's routing read back: `expiresAt` is `null` for an offer written before WP-278. */
export interface StoredOfferRouting extends Omit<OfferRouting, 'expiresAt'> {
  readonly expiresAt: IsoDateTime | null;
}

/** An offer read back. */
export interface StoredRunOffer extends Omit<NewRunOffer, 'routing'> {
  readonly routing: StoredOfferRouting;
  readonly state: RunOfferState;
  readonly leaseEpoch: number;
  readonly claimantKind: RunClaimantKind | null;
  readonly claimedAt: IsoDateTime | null;
  readonly settledAt: IsoDateTime | null;
  readonly withdrawnAt: IsoDateTime | null;
  readonly withdrawnReason: string | null;
}

/**
 * Which open offers a claim may take — TD-031 §2's `<eligibility for this claimant>`.
 *
 * Since WP-276 the server's claimant loop (`./claimant.ts`) takes **any** open offer, stage or ask,
 * oldest first: `{}`. `runId` narrows the claim to one offer, which is what a test that drives one
 * run asks for. Routing (WP-278) narrows the server's claim to `server_from`; a remote worker's claim
 * is narrowed by {@link RunOfferClaim.worker} (WP-281).
 */
export interface RunOfferEligibility {
  readonly runId?: Id;
}

/**
 * **A remote worker's claim** (WP-281, TD-031 decisions 2, 7 and 8). The repository's one claim
 * statement checks TD-031 §8's eligibility **in the statement** against these: the worker is not
 * revoked and its user may act (backlog 714: re-checked where the claim commits, not only at the
 * request's authentication), not paused, not excluded from the offer, its user's effective project
 * role (the higher of its organisation role and a membership, backlog 886) `member` or above, the offer's images held, the project's run credential `minted`
 * (`remote_run_credential` is WP-282's), the offer a **stage** offer (an ask's ending is not served
 * to a worker before WP-283), and `now ≥ workers_from` or the assignee's head start.
 */
export interface RemoteClaimant {
  readonly workerId: Id;
  /** The image digests the worker reports holding (`claims`' `image_digests`). */
  readonly heldImageDigests: readonly string[];
  /**
   * The core's run and egress images by digest — what an offer that names none is packaged with,
   * written onto the offer by the claim (`run_offers.image_digests`, TD-031 decision 4).
   */
  readonly images: { readonly run: string; readonly egress: string };
  /** SHA-256 hex of the run token minted for this claim (TD-031 decision 7); never the token. */
  readonly runTokenHash: string;
  /**
   * **A pick** — *take this one* from the worker's local page (WP-293, TD-031's 2026-11-05
   * claim-scope amendment, decision 3): the claim names its run ({@link RunOfferEligibility.runId},
   * required) and **ignores the worker's claim scope and its claim policy and nothing else** —
   * `workers_from`, another user's head start, the exclusions and both pauses still hold — and, for
   * a **stage** offer, admits only a task nobody owns or the worker's user owns (S-26.4, TD-031's
   * 2026-11-06 amendment item 7: a pick never takes another person's task). Absent or `false`: an
   * automatic claim, which the scope and the policy narrow.
   */
  readonly pick?: boolean;
}

/**
 * The worker a {@link RunOfferRepository.claimable} list is computed for — a {@link RemoteClaimant}
 * without the run token, because the list claims nothing.
 */
export type RemoteListing = Pick<RemoteClaimant, 'workerId' | 'heldImageDigests' | 'images'>;

/** A task's owner as the worker's offers list and a pick's refusal name them (S-26.4). */
export interface OfferOwner {
  readonly userId: Id;
  readonly name: string;
}

/**
 * One open offer a remote worker could claim now (WP-293): the claim's own eligibility, narrowed by
 * the worker's project list (S-26.4; a legacy `[]` narrows nothing), and `automatic` — whether its
 * claim policy takes it by itself.
 */
export interface ClaimableRunOffer {
  readonly runId: Id;
  readonly taskId: Id;
  readonly projectId: Id;
  readonly kind: RunOfferKind;
  readonly stage: string | null;
  readonly role: AgentRole;
  readonly offeredAt: IsoDateTime;
  readonly automatic: boolean;
  /** The task's owner, `null` for nobody — whatever the offer's kind (S-26.4). */
  readonly owner: OfferOwner | null;
  /** A stage offer of a task the worker's user owns, or an ask they asked (S-26.4). */
  readonly mine: boolean;
  /**
   * The task's tracker assignee is a person the platform cannot match to a member of its project
   * (S-26.1's *held elsewhere*, the claim's own fragment): a pick claims it without assigning
   * (S-26.7 shows it).
   */
  readonly heldElsewhere: boolean;
}

/**
 * Why an offer is withdrawn by somebody other than a task transition: `withdrawnReason` is the
 * offer's `withdrawn_reason` — a short platform code, the column is at most 64 characters — and
 * `brief` is the platform's sentence the task's escalation (or the ask's refusal) carries.
 */
export interface OfferWithdrawalReason {
  readonly withdrawnReason: OfferWithdrawalCode;
  readonly brief: string;
}

/** An open offer past its `expires_at` (WP-278): what the offer-timeout recovery withdraws. */
export interface ExpiredRunOffer {
  readonly runId: Id;
  readonly taskId: Id;
  readonly projectId: Id;
  readonly kind: RunOfferKind;
  readonly offeredAt: IsoDateTime;
  readonly expiresAt: IsoDateTime;
}

/** One claim (TD-031 §2): who claims, under which owner, until when. */
export interface RunOfferClaim {
  readonly eligibility: RunOfferEligibility;
  readonly claimantKind: RunClaimantKind;
  /** Present exactly for `claimantKind: 'worker'` (WP-281). */
  readonly worker?: RemoteClaimant;
  /** `server:<process>` for the server's runner (`serverLeaseOwner`); `null` with no lease configured. */
  readonly owner: string | null;
  /** The lease's expiry, or `null` for a composition that runs no heartbeat (no lease configured). */
  readonly expiresAt: IsoDateTime | null;
  readonly now: IsoDateTime;
}

/** What a claim that won answers: the offer, its run and the epoch the claim now holds. */
export interface ClaimedRunOffer {
  readonly offerId: Id;
  readonly runId: Id;
  readonly taskId: Id;
  /** `stage` or `ask` — which ending the claimant settles the run through (TD-031 decision 13). */
  readonly kind: RunOfferKind;
  readonly epoch: number;
  readonly owner: string | null;
  /** The images the offer names after the claim — `null` for a server claim of an offer naming none. */
  readonly images?: { readonly run: string; readonly egress: string } | null;
  /**
   * A worker claim's worker's user, read in the claim's own statement (S-26.4) — the person a pick
   * assigns. Absent for a server claim.
   */
  readonly workerUserId?: Id | null;
}

/** What {@link RunOfferRepository.release} answers (WP-281, TD-031 decision 6 as amended §4). */
export type RunOfferRelease =
  /** This call undid the claim: the offer `claimed → open`, the run `starting → created`. */
  | {
      readonly kind: 'released';
      readonly offerId: Id;
      readonly taskId: Id;
      readonly projectId: Id;
    }
  /** A repeat: the offer is open at this epoch with a release recorded — nothing was written. */
  | { readonly kind: 'already_released' }
  /** The run's CLI spawn marker is written: a started run ends through `finish` (`409 run_started`). */
  | { readonly kind: 'run_started' }
  /** The run is not live under this claim — another epoch, another owner, or ended. */
  | { readonly kind: 'lease_lost' };

/**
 * Who holds a run's token (WP-281, TD-031 decision 7): the offer's `run_token_hash`, the epoch it was
 * minted for, the remote worker that claimed and whether it may still act — read in one statement, so
 * a revoked worker or a user who may no longer act authenticates nothing.
 */
export interface RunTokenHolder {
  readonly runId: Id;
  readonly offerId: Id;
  readonly kind: RunOfferKind;
  /** SHA-256 hex, or `null` for an offer no remote worker ever claimed. */
  readonly tokenHash: string | null;
  readonly tokenEpoch: number | null;
  /** `run_offers.worker_id` — the last remote claimant, kept by a release until the next claim. */
  readonly workerId: Id | null;
  /** The worker is not revoked and its user may act (`USER_MAY_ACT`). */
  readonly workerUsable: boolean;
  readonly runStatus: RunStatus;
  /** `runs.ended_at`, or `null` while the run is live. */
  readonly endedAt: IsoDateTime | null;
}

/** What {@link RunOfferRepository.withdraw} moved `open → withdrawn`. */
export interface WithdrawnRunOffer {
  readonly offerId: Id;
  readonly runId: Id;
}

/**
 * `run_offers` (migration 0094, WP-274, TD-031 decisions 1–2).
 *
 * **Closing is not here.** Every terminal writer of a run closes its offer in the run's terminal
 * transaction, and every terminal writer goes through {@link RunRepository.finish} — so `finish`
 * closes it, after it won the row: `claimed → settled`, `open → withdrawn`. The census that holds
 * every writer to that is `run-terminal-writers.test.ts`.
 */
export interface RunOfferRepository {
  /**
   * Writes the offer `open`, at epoch 0. Refused by the database (a unique violation) when the task
   * already has an open or claimed **stage** offer — the per-task index that replaces the job
   * singleton for a run's duration (TD-031 §1).
   */
  insert(tx: Transaction, offer: NewRunOffer): Promise<void>;
  /**
   * **The one claim** (TD-031 §2): the oldest eligible `open` offer, `for update skip locked`,
   * moved to `claimed` with its epoch incremented — and, in the same statement, the run's
   * `lease_owner`, `lease_expires_at` and `lease_epoch`. Answers `null` when no eligible offer is
   * open (another claim took it, or it was closed), and never claims an offer whose run has ended.
   */
  claim(tx: Transaction, claim: RunOfferClaim): Promise<ClaimedRunOffer | null>;
  /**
   * **What a remote worker could claim now** (WP-293, TD-031's claim-scope amendment, decision 4):
   * at most `limit` open offers of live runs, oldest first, that the worker's claim would admit with
   * its scope ignored — **the claim's own eligibility text**, so the list and a pick cannot
   * disagree — each with whether the scope takes it automatically. Locks nothing.
   */
  claimable(
    tx: Transaction,
    input: { readonly worker: RemoteListing; readonly now: IsoDateTime; readonly limit: number },
  ): Promise<readonly ClaimableRunOffer[]>;
  /**
   * **Why a pick claimed nothing, when it is ownership** (S-26.4, TD-031's 2026-11-06 amendment
   * item 7): the run's offer is an open **stage** offer of a live run that the worker's eligibility
   * admits now, and its task is owned by another person — that owner and when the owner last
   * changed; `null` for every other reason, so the one refusal still names no other. Locks nothing.
   */
  pickOwnerRefusal(
    tx: Transaction,
    input: { readonly runId: Id; readonly worker: RemoteListing; readonly now: IsoDateTime },
  ): Promise<{ readonly owner: OfferOwner; readonly ownerChangedAt: IsoDateTime | null } | null>;
  load(tx: Transaction, runId: Id): Promise<StoredRunOffer | null>;
  /**
   * **The withdrawal** (WP-276, TD-031 decision 3): **one conditional statement**, `update run_offers
   * set state = 'withdrawn' … where … and state = 'open'`, answering the row it moved or `null`. A
   * claim that won the row lock first leaves it `claimed`, and this touches nothing — the caller then
   * records a `cancel` run command instead. `taskId` selects the task's open **stage** offer (an
   * ask's offer is outside the per-task index and is never withdrawn by a stage transition); `runId`
   * selects one offer whatever its kind (a claimant that found the offer has no plan).
   *
   * The offer is the **first** of the three rows a withdrawal locks — `run_offers`, then `runs`, then
   * `tasks` (TD-031's 2026-11-04 amendment §5) — so the caller ends the run and saves the task after.
   */
  withdraw(
    tx: Transaction,
    input: {
      readonly by: { readonly taskId: Id } | { readonly runId: Id };
      /** The code `withdrawn_reason` stores (never a sentence: the column holds 64 characters). */
      readonly reason: OfferWithdrawalCode;
      readonly now: IsoDateTime;
    },
  ): Promise<WithdrawnRunOffer | null>;
  /**
   * The task's open or claimed **stage** offer — the one the per-task index admits — or `null`. Read
   * without a lock: a withdrawal that finds it `claimed` uses it to name the run its `cancel` is for,
   * under the lock {@link RunCommandRepository.lockRun} then takes in the one order.
   */
  liveStageOffer(tx: Transaction, taskId: Id): Promise<StoredRunOffer | null>;
  /**
   * **A release** (WP-281, TD-031 decision 6 and its 2026-11-04 amendment §4): undoes the claim at
   * `epoch` held by `owner`, only while the run is `starting` with no CLI spawn marker — the offer
   * `claimed → open` with its epoch **kept** (so the releasing claimant's fence is stale), the release
   * recorded, `excludeWorkerId` appended to `excluded_worker_ids` when given, and the run's
   * `lease_owner`, `lease_expires_at` and `worker_id` cleared, `starting → created`. Locks the offer,
   * then the run (the one lock order). The caller appends `run.offer.released` and revokes the
   * minted credential after the commit.
   */
  release(
    tx: Transaction,
    input: {
      readonly runId: Id;
      readonly epoch: number;
      readonly owner: string;
      readonly reason: string;
      readonly excludeWorkerId: Id | null;
      readonly now: IsoDateTime;
    },
  ): Promise<RunOfferRelease>;
  /** The run token's holder (WP-281), or `null` for a run with no offer. */
  runTokenHolder(tx: Transaction, runId: Id): Promise<RunTokenHolder | null>;
  /**
   * **The exclusions a re-planned stage entry carries** (WP-286, TD-031 §12): the newest stage
   * offer of `(task, stage, attempt)` — its `excluded_worker_ids`, plus its `worker_id` when its run
   * ended `lease_expired` (the lost worker; a revoked worker's runs end that way too, WP-280). **Not**
   * a worker a usage limit stopped (`rate_limited`): its own pause refuses it at the claim until the
   * reset, and excluding it would leave a single-worker core with nobody to claim (TD-031's
   * 2026-11-05 amendment). `[]` for an entry with no offer yet, and for one whose newest offer a
   * server claimant held. Each id once, in the order they were excluded.
   */
  carriedExclusions(
    tx: Transaction,
    entry: { readonly taskId: Id; readonly stage: Slug; readonly attempt: number },
  ): Promise<readonly Id[]>;
  /**
   * Open offers whose run has **no** stored plan (TD-031's 2026-11-04 amendment §2) — the claimant
   * withdraws each through its kind's executor before it claims. Reachable only for a run offered by a
   * build before WP-275a.
   */
  openWithoutPlan(
    tx: Transaction,
    limit: number,
  ): Promise<readonly { readonly runId: Id; readonly kind: RunOfferKind }[]>;
  /**
   * Open offers whose `expires_at` is at or before `now` (WP-278, TD-031 decision 1: *an offer that
   * nobody claims by `expires_at` is withdrawn*), oldest first — the offer-timeout recovery row's
   * read (`recovery/offer-timeout.ts`). An offer written before WP-278 has no `expires_at` and is
   * never found.
   */
  expiredOpen(
    tx: Transaction,
    input: { readonly now: IsoDateTime; readonly limit: number },
  ): Promise<readonly ExpiredRunOffer[]>;
  /**
   * Open offers with **neither** `server_from` nor `workers_from` — written before WP-278, which a
   * worker reads as *never* and which never expire (backlog 887) — oldest first: the re-route's
   * read (`recovery/offer-timeout.ts`'s {@link UnroutedRunOffer} pass).
   */
  unroutedOpen(tx: Transaction, limit: number): Promise<readonly UnroutedRunOffer[]>;
  /**
   * Writes `routing`'s `server_from`, `workers_from` and `expires_at` onto an offer that is still
   * open **and still unrouted** — one conditional update, so a claim or a second pass that moved it
   * first leaves it alone (`false`). The assignee columns are not touched: an offer written before
   * WP-278 has none.
   */
  reroute(
    tx: Transaction,
    input: { readonly offerId: Id; readonly routing: OfferRouting },
  ): Promise<boolean>;
}

/** {@link RunOfferRepository.unroutedOpen}'s answer (backlog 887). */
export interface UnroutedRunOffer {
  readonly offerId: Id;
  readonly runId: Id;
  readonly projectId: Id;
  readonly kind: RunOfferKind;
  readonly offeredAt: IsoDateTime;
}

/**
 * Where a project's agent runs execute, and who can claim them now (WP-278, TD-031 decision 8):
 * `project_execution_settings`, `workers` and `server_claimants` (migration 0097). What the offer's
 * writer reads to route it, and what the server claimant writes to say it is running.
 */
export interface ExecutionRoutingRepository {
  /** The project's stored settings, or `null` when none is stored (the defaults apply). */
  settings(tx: Transaction, projectId: Id): Promise<ExecutionSettings | null>;
  /**
   * Whether `userId` has a worker **online** for this project at `now` (TD-031 §8): a worker of
   * theirs that is not revoked, not paused, seen in the last 60 s, and their effective project role
   * (the higher of the organisation role and a membership, backlog 886) is `member` or above. `workers.last_seen_at` is written by every authenticated worker
   * protocol call (WP-281), the heartbeat's every 20 s among them.
   */
  assigneeOnline(
    tx: Transaction,
    input: { readonly projectId: Id; readonly userId: Id; readonly now: IsoDateTime },
  ): Promise<boolean>;
  /** Whether any process holds a fresh `server_claimants` row — on the database's clock. */
  serverClaimantRunning(tx: Transaction): Promise<boolean>;
  /** Writes or renews this process's row, `expires_at = now() + ttl`, and prunes long-dead rows. */
  renewServerClaimant(
    tx: Transaction,
    input: { readonly holder: string; readonly ttlMs: number },
  ): Promise<void>;
  /** Deletes this process's row when its claimant stops. */
  releaseServerClaimant(tx: Transaction, holder: string): Promise<void>;
}

/** One `ReviewVerdict.checklists_applied` entry, as the planner decides it (WP-45). */
export interface AppliedChecklistRecord {
  readonly name: string;
  readonly item_count: number;
  readonly required_by: readonly string[];
  readonly truncated: boolean;
}

/**
 * The run's planned spec as stored — `run_plans` (migration 0095, WP-275a, TD-031's 2026-11-04
 * amendment §2). The spec is opaque bytes here: sealed by the `RunPlanSealer` port before the write
 * and opened by `loadRunPackage` after the read, so this repository never sees a plaintext spec.
 */
export interface NewRunPlan {
  readonly runId: Id;
  /** The sealed document's shape (`RUN_PLAN_FORMAT`). */
  readonly format: number;
  readonly sealedSpec: Uint8Array;
  /** The `APP_SECRET_KEY` generation that sealed it. */
  readonly keyId: string;
  /** The spec's `secretEnvNames` — names, never values. */
  readonly secretEnvNames: readonly string[];
  /** What the planner gave a Reviewer run, or `null` when it recorded nothing (WP-45). */
  readonly reviewChecklists: readonly AppliedChecklistRecord[] | null;
  /** `questionTimeoutOf(settings)` at plan time. */
  readonly questionTimeout: string;
}

export interface StoredRunPlan extends Omit<NewRunPlan, 'sealedSpec'> {
  /** `null` once the run is terminal: `RunRepository.finish` clears it in the run's transaction. */
  readonly sealedSpec: Uint8Array | null;
}

export interface RunPlanRepository {
  /** Written once, in the run's creation transaction, beside the run row. */
  insert(tx: Transaction, plan: NewRunPlan): Promise<void>;
  /** The plan, or `null` for a run planned before WP-275a (or one that does not exist). */
  load(tx: Transaction, runId: Id): Promise<StoredRunPlan | null>;
}

/**
 * {@link RunRepository.lockSettlement}'s answer: what `settleRun` asks of the run row before it
 * writes anything (WP-275, TD-031 decision 3) — whether it is still live, under which claim, and,
 * once terminal, how it ended. The last two are **the stored result** a repeated settle answers:
 * `status`, `terminal_reason` and `lease_epoch` are columns the first settle's `finish` left on the
 * row, so the idempotency of `(run_id, epoch)` needs no column of its own.
 */
export interface RunSettlement {
  readonly runId: Id;
  readonly status: RunStatus;
  /** `null` while the run is live. */
  readonly terminalReason: RunTerminalReason | null;
  /** `runs.lease_epoch` (WP-274): `0` for a run no claim took. */
  readonly leaseEpoch: number;
  /** `runs.lease_owner`, or `null` in a composition that configures no run lease. */
  readonly leaseOwner: string | null;
}

export interface RunRepository {
  insert(tx: Transaction, run: NewRun): Promise<void>;
  /**
   * The run row as `settleRun` needs it, locked **`for update`** — or `null` when there is no such run
   * (WP-275, TD-031 decision 3).
   *
   * Exclusive, and taken **first** in the settle's transaction, so that what the settle decides from
   * it stays true until it commits: no cancel, sweep or second settle can end the row in between,
   * and a second settle of the same run waits here and then reads it terminal.
   *
   * **One lock order** (WP-276, backlog 697, TD-031's 2026-11-04 amendment §5): it locks the run's
   * **offer** row first, then the run — `run_offers` → `runs` → `tasks`, the order every transaction
   * that locks more than one of them takes: the claim, every `finish` caller (a person's cancel, the
   * lease sweep, the holder's applied cancel, the take-over's stop, the shutdown hand-back, the ask's
   * ending), and the withdrawal. `tasks.save` is optimistic and written last everywhere.
   */
  lockSettlement(tx: Transaction, runId: Id): Promise<RunSettlement | null>;
  /**
   * The context-pack record the run was planned with, **read back** from what transaction 1b stored
   * (`run_context_pack` and the header columns on `runs`, migration 0041) — PROGRESS backlog 709: a
   * claimant outside the job that planned the run appends `run.started` with this, never with a
   * planner's memory. `null` when the run recorded none (a row written before 0041, or none at all).
   */
  contextPack(tx: Transaction, runId: Id): Promise<ContextPackRecord | null>;
  /**
   * Moves a **live** run to a terminal status, and answers whether this caller is the one that did.
   *
   * `false` means the row was already terminal when the statement ran: somebody else ended this run
   * first. Since WP-15i there really are two candidates — the stage executor, which ends the run it
   * started, and `POST /api/runs/:run_id/cancel`, which a human can fire while that run is in
   * flight — so an unconditional `update … where id = $1` is the read-modify-write race standing
   * rule 79 names, with the human's decision as the value that gets overwritten. The predicate is
   * the run's own state machine (`ACTIVE_RUN_STATUSES`), which is why this needs no version column:
   * a terminal status is terminal, so "did I move it" and "was it still live" are the same question.
   *
   * A caller that loses **must not** write the rest of what it was going to write — the executor
   * returns `skipped` rather than completing a stage on a run a human cancelled, and the cancel
   * command answers 409 rather than reporting a cancellation that did not happen.
   *
   * **The winner also closes the run's offer** (WP-274, TD-031 §12): `claimed → settled`, `open →
   * withdrawn` (with the terminal reason), in the same transaction — so every terminal writer frees
   * the per-task index for the task's next stage. **Lock order** (WP-276, backlog 697): `finish`
   * locks the run's offer row **before** its `update runs`, and every caller that locked the run
   * earlier in its transaction (`lockSettlement`, a cancel's `lockRun`/`lockLiveRunOf` with
   * `forUpdate`, the sweep's `claimExpiredRun`) locked the offer before it — `run_offers` → `runs` →
   * `tasks`, the claim's own order, so a claim and a terminal writer of one run cannot deadlock.
   *
   * **A claimant passes its fence** ({@link RunLeaseFence}): the write is then also conditional on
   * `lease_epoch` and `lease_owner`, and a **live** row held under another claim throws
   * {@link LeaseLostError}. A writer that is not the claimant — a person's cancel ending the record
   * in place, the lease sweep — passes none and ends the row whoever holds it, as before.
   *
   * **The winner also clears the run's sealed plan** (WP-275a, TD-031's 2026-11-04 amendment §2):
   * `run_plans.sealed_spec = null` in the same transaction, so a sealed spec exists only while its
   * run is live — a leaf row reached only under the run's lock, so the lock order is unchanged.
   *
   * **The winner also closes the run's pending commands** (WP-85): every `run_commands` row still
   * pending is stamped `run_ended` in the same transaction, after the row moved, so a command
   * recorded against the live run is either closed here or refused at its own lock
   * ({@link RunCommandRepository}). A loser closes nothing — the winner already did.
   *
   * @throws when the run does not exist at all, which is a different fact from "already finished".
   */
  finish(
    tx: Transaction,
    outcome: {
      readonly runId: Id;
      readonly status: RunStatus;
      readonly terminalReason: RunTerminalReason;
      readonly sessionId: string | null;
      readonly numTurns: number;
      readonly usage: TokenUsage;
      /**
       * What the run cost, or `null` when **nobody measured it**.
       *
       * `null` since WP-47, for the lease sweep: it ends a run whose process vanished and has no
       * figure of its own to write, and `{ usd: 0 }` there would publish "this run was free" — the
       * exact reading standing rule 16 exists to refuse. Both cost columns are left unset, so every
       * cap **holds** the ended row at the reservation it was admitted at (`reserve_usd`, WP-131)
       * rather than counting a measurement — never spend, and never a free run.
       *
       * The two are written apart: `is_estimate: false` fills `usd_reported`, `true` fills
       * `usd_estimated` (WP-47, migration 0035), and the other one is `null`.
       *
       * **Not `null` for a run that never asked for its CLI** (WP-150): every writer passes the
       * measured zero (`MEASURED_ZERO_COST`) for a row whose `cli_spawn_requested_at` is null, so
       * no cap holds a run that cannot have spent.
       */
      readonly cost: RunCost | null;
      readonly wallMs: number;
      /**
       * `true` when {@link cost} is the runner's **floor** rather than a measurement — a
       * `cost_unreported` stop (`runs.figure_is_floor`, WP-131 pre-review round, backlog 407). The
       * cost is written as given (WP-119 kept the floor); the caps hold the run at its reservation
       * and the totals count it as unmeasured. Absent is `false`.
       */
      readonly costIsFloor?: boolean;
      /**
       * Why the run never started — `runs.exit_detail`, the column's first writer (PROGRESS backlog
       * 453). Redacted and bounded by the caller (`runStartFailureOf`); absent for every run that
       * started, which leaves the column null.
       */
      readonly startFailure?: RunStartFailure;
      /**
       * What the workspace did with the run's unfinished work — `runs.saved_work` (migration 0083,
       * PROGRESS backlog 467). Absent when no export was attempted, which leaves the column null.
       */
      readonly savedWork?: RunSavedWork;
      /** The claimant's fence (WP-274); absent for a writer that is not the run's claimant. */
      readonly lease?: RunLeaseFence;
    },
  ): Promise<boolean>;
  /**
   * The run's **cost**, written after the row is already terminal — Q70 (b), PROGRESS backlog 50.
   *
   * The narrow write of WP-15d's shape, one table across, and it exists because ending a run and
   * knowing what it cost are two different processes' facts. `POST /api/runs/:run_id/cancel` and
   * the lease sweep both end a row with no figure — neither can know one — while the process that
   * is *running* the session knows exactly, and is refused `finish` because it lost the race the
   * conditional predicate arbitrates. Without this the money is simply lost: the ledger's handler
   * has already seen a `run.finished` carrying no figure (zero usage, and a `null` cost since
   * WP-119 — a `{ usd: 0 }` before it) and taken its `no_spend` branch.
   *
   * **Never a whole-row save** (standing rule 79): it writes the usage, the cost, the turns, the
   * wall time and the session id, and nothing about the run's *status* — the terminal status the
   * other writer chose is the one that stands.
   *
   * Refuses, by answering `false`, in the three cases where writing would be wrong rather than
   * late: the run is still live (its own `finish` is the writer), a cost has already been recorded
   * on the row, or the ledger has already charged this run. The last is what makes a repeat of the
   * caller's transaction a no-op rather than a second charge.
   *
   * @throws when the run does not exist at all, exactly as {@link RunRepository.finish} does.
   */
  recordCost(
    tx: Transaction,
    late: {
      readonly runId: Id;
      readonly sessionId: string | null;
      readonly numTurns: number;
      readonly usage: TokenUsage;
      readonly cost: RunCost;
      readonly wallMs: number;
      /** The cost is the runner's floor (`runs.figure_is_floor`, WP-131 review round 1). */
      readonly costIsFloor?: boolean;
    },
  ): Promise<boolean>;
  /**
   * Records that this run's CLI is about to be asked to start — `runs.cli_spawn_requested_at`
   * (migration 0085, WP-150, BD-010's 2026-10-06 amendment).
   *
   * A **compare-and-set**: it writes only where the column is null **and** the run is still live,
   * and answers whether it wrote. `false` is the answer for a run another writer already ended (a
   * cancel ended in place, the lease sweep) and for a second call: the caller then starts no CLI.
   * The caller runs it in a transaction of its own and commits it **before** it asks for the CLI
   * (`RunStartHooks.beforeCliSpawn`), so the record is durable whenever a CLI can exist. Never a
   * whole-row write (standing rule 79): the run's cost and lease are other writers'.
   *
   * **Since WP-275b it is also the run's `starting → running`** (TD-031's 2026-11-04 amendment §4):
   * the same statement writes `status = 'running'` and `started_at = at`, and the caller appends
   * `run.started` in the same transaction — so `started_at` is null, and the run has no
   * `run.started`, for every run that ended before it asked for its CLI.
   *
   * @throws when the run does not exist at all, exactly as {@link RunRepository.finish} does.
   */
  markCliSpawnRequested(
    tx: Transaction,
    marker: {
      readonly runId: Id;
      readonly at: IsoDateTime;
      /**
       * The claimant's fence (WP-275b): the write is then also conditional on `lease_epoch` and
       * `lease_owner`, and a **live** row held under another claim throws {@link LeaseLostError}
       * — the claimant withholds the `spawn` frame. Absent only for a row no claim took.
       */
      readonly lease?: RunLeaseFence;
    },
  ): Promise<boolean>;
  /**
   * How many of this stage entry's runs **immediately preceding** `runId` ended with a recorded
   * start failure — the retry counter of a start failure, counted from stored rows (WP-275a,
   * TD-031's 2026-11-04 amendment §3), as {@link shutdownEndings} counts hand-backs.
   *
   * The entry is `(task, stage, attempt)`; its runs are ordered by **`created_at`** (then `id`),
   * never `started_at`, which is null for a run that never started. Walking back from `runId`, a
   * run counts while it ended `error_during_execution` with a start failure recorded
   * (`runs.exit_detail`); the first run that did not — a run that started, or a shutdown hand-back —
   * ends the streak. Read under the settle's lock, so `runId` itself is live and not counted.
   */
  startFailures(
    tx: Transaction,
    entry: {
      readonly taskId: Id;
      readonly stage: Slug;
      readonly attempt: number;
      readonly runId: Id;
    },
  ): Promise<number>;
  /**
   * Renews the run's lease — `runs.lease_expires_at` under `lease_owner` (TD-003, WP-47, WP-274).
   *
   * Both columns have existed since migration 0004 and had **no reader and no writer** until WP-47.
   * The owner is the process executing the run: it takes the lease in the transaction that creates
   * the row (through the offer's claim since WP-274) and renews it on a heartbeat while the session is live, so *"nothing is renewing this
   * lease"* becomes a question a query can ask. It is the only thing a missing heartbeat licenses
   * anybody to conclude — never that the model stopped, never that the work was wasted.
   *
   * Conditional on the run still being live **and** on the claim's fence — `lease_epoch` and
   * `lease_owner` both this caller's (WP-274, TD-031 §2) — and answers whether it wrote. Since WP-274
   * it only **renews**: the lease is claimed by {@link RunOfferRepository.claim}, which writes the
   * owner and the epoch with the offer. A `false` is not an error: the run has ended, or another
   * claim holds it, and a heartbeat that kept writing either would be renewing a claim it does not
   * hold. The caller (`renewRunLease`) answers `lease_lost` and stops beating.
   */
  renewLease(
    tx: Transaction,
    lease: {
      readonly runId: Id;
      readonly owner: string;
      readonly epoch: number;
      readonly expiresAt: IsoDateTime;
    },
  ): Promise<boolean>;
  load(tx: Transaction, runId: Id): Promise<StoredRun | null>;
  /**
   * How many of this **stage entry's** runs ended `shutdown` — handed back by a `runner` stop
   * (WP-144, PROGRESS backlog 432). The bound on the hand-back is counted from the runs' own end
   * reasons rather than kept in a column: the third stop of one entry escalates
   * (`MAX_SHUTDOWN_HAND_BACKS`). An entry is `(task, stage, attempt)`; a new attempt of the stage
   * (a return, a hand-back by a person) starts a new count.
   */
  shutdownEndings(
    tx: Transaction,
    entry: { readonly taskId: Id; readonly stage: Slug; readonly attempt: number },
  ): Promise<number>;
  /**
   * The **latest ended run** of this task at this stage, when it saved unfinished work — the
   * product owner's 2026-10-05 decision (PROGRESS backlog 467) — or `null` when that run saved none,
   * or the stage has no ended run.
   *
   * Asked at admission, before the new run's row exists, so "latest" is the previous attempt of the
   * stage (a retry, a return, a hand-back — any of them). Only the latest counts: a later run that
   * completed, or one that saved nothing, means the branch is no longer *a previous attempt's
   * unfinished work*, and the planner must not say it is. Ordered by `created_at`, then `id`
   * (uuidv7), over terminal runs only.
   */
  lastSavedWork(
    tx: Transaction,
    query: { readonly taskId: Id; readonly stage: Slug },
  ): Promise<SavedAttempt | null>;
  /**
   * The **latest ended run** of this task at this stage, however it ended, or `null` when the stage
   * has none (PROGRESS backlog 476) — {@link lastSavedWork}'s row without its condition. Asked at
   * admission for the same reason, so "latest" is the previous run of the stage. Its answer becomes
   * one sentence of the next attempt's prompt: *attempt 2* with no reason sent an agent looking for
   * return feedback that did not exist.
   */
  lastEnded(
    tx: Transaction,
    query: { readonly taskId: Id; readonly stage: Slug },
  ): Promise<EndedRun | null>;
  /**
   * When the **latest run** of this task at this stage started — its `started_at`, or its
   * `created_at` for a run that never reached `started` — or `null` when the stage has no run.
   * Latest by `created_at`, then `id` (uuidv7), whatever the run's status.
   *
   * WP-178's horizon (TD-029 decision 7): the human-return window counts only the words written
   * after the start of the task's latest `implementation` run, so the words a run was already
   * given, and the words written while the agent's review stages ran, are told apart.
   */
  latestStartedAt(
    tx: Transaction,
    query: { readonly taskId: Id; readonly stage: Slug },
  ): Promise<IsoDateTime | null>;
  /**
   * How many of this **ask's** runs ended `shutdown` (WP-149, PROGRESS backlog 445) — the ask's
   * hand-back bound (`MAX_ASK_HAND_BACKS`), counted from the runs' own end reasons through
   * `runs.ask_id` rather than carried in the `task.ask` payload, which a deduplicated enqueue or a
   * retried old payload could reset. A run written before migration 0082 names no ask and counts for
   * none.
   */
  askShutdownEndings(tx: Transaction, askId: Id): Promise<number>;
  /**
   * What the task's runs add up to — the `totals` of `task.completed` / `task.cancelled`.
   *
   * `is_estimate` is true when **any** run's cost was priced by the platform (`usd_estimated`)
   * rather than reported by the provider (BD-011): a total that mixes the two is an estimate, and
   * reporting it as measured is the direction that misleads. A run **nobody measured** is not an
   * estimate — it is absent from `costUsd` — and is counted by `unmeasuredRuns` instead, so the
   * total can say what it excludes (WP-131, PROGRESS backlog 403). `runs` still counts it.
   */
  totalsFor(
    tx: Transaction,
    taskId: Id,
  ): Promise<{
    readonly runs: number;
    readonly costUsd: number;
    readonly isEstimate: boolean;
    readonly unmeasuredRuns: number;
    readonly wallMs: number;
  }>;
  /**
   * The task's ended runs **nobody measured**, held at the reservations they were admitted at —
   * what the task cap adds beside `tasks.cost_actual` (WP-131, PROGRESS backlog 402;
   * `../cost/pending.ts`).
   *
   * Only a run that **asked for its CLI** (`cli_spawn_requested_at` set, WP-150): one that never did
   * is a measured zero and is not held, in either store.
   *
   * An ended run with both cost columns null moves `cost_actual` by nothing, ever, so without this
   * a task whose runs kept ending unmeasured was admitted retry after retry under its cap. Each is
   * held at its own `runs.reserve_usd`, or at `admittingReserveUsd` when the row recorded none
   * (written before migration 0072). It is **never** written into `cost_actual`, which is spend
   * (standing rule 16), and it does not roll over: it ends when `recordCost` writes the run's figure.
   */
  heldFor(
    tx: Transaction,
    taskId: Id,
    admittingReserveUsd: number,
  ): Promise<{ readonly heldUsd: number; readonly heldRuns: number }>;
}

/**
 * What a recorded run command asks the holder to do (WP-85, TD-028 decision 9) — a steer's turn, a
 * take-over's stop with the export its workspace owes, or (WP-101, TD-028 decision 11) a cancel's
 * stop, which owes nothing but the stop. Stored redacted: the command redacted the text before it
 * was recorded, and the holder delivers the stored bytes.
 */
export type RunCommandInstruction =
  | {
      readonly kind: 'steer';
      readonly text: string;
      /** In the instruction as well as `actor_user_id`, which a deleted user sets null. */
      readonly authorUserId: Id;
      readonly authorLabel: string;
    }
  | {
      readonly kind: 'take_over';
      readonly branch: string;
      readonly commitMessage: string;
      readonly tarball: boolean;
      readonly keepUntil: IsoDateTime;
    }
  | { readonly kind: 'cancel' };

/** The two instructions that stop the session; a steer recorded behind one waits for the ending. */
export const STOPPING_RUN_COMMAND_KINDS: readonly RunCommandInstruction['kind'][] = [
  'take_over',
  'cancel',
];

/** Why the process that could have applied a command did not (migration 0060). */
export type RunCommandRefusal = 'run_ended' | 'register_miss' | 'delivery_failed' | 'undecodable';

export interface NewRunCommand {
  /** Derived from the `Idempotency-Key` when the request carried one (migration 0060). */
  readonly id: Id;
  readonly runId: Id;
  readonly taskId: Id;
  readonly actorUserId: Id | null;
  readonly instruction: RunCommandInstruction;
}

/** A command still waiting for the holder, as the holder reads it. */
export interface PendingRunCommand {
  readonly id: Id;
  readonly runId: Id;
  readonly taskId: Id;
  readonly actorUserId: Id | null;
  /**
   * `null` when the stored payload is not a shape this build can deliver (WP-85 review round 1):
   * the row is handed back rather than thrown on, so the holder refuses it `undecodable` by itself
   * and the other rows of the drain still apply.
   */
  readonly instruction: RunCommandInstruction | null;
  /** The stored `kind`, kept for a row whose instruction could not be read. */
  readonly kind: string;
}

/** The run row a command is about to be recorded against, read under a `for share` lock. */
export interface LockedRun {
  readonly runId: Id;
  readonly taskId: Id;
  readonly status: RunStatus;
  /** `runs.lease_owner`: the process the notification is addressed to, or `null` when none holds it. */
  readonly leaseOwner: string | null;
  /**
   * `runs.lease_expires_at`, or `null` for a run no process ever leased (WP-101, TD-028 decision
   * 11). A cancel compares it with its own clock: in the future, a holder is renewing it and the
   * cancel is recorded for that holder; absent or past, nobody holds the session and the record is
   * ended in place.
   */
  readonly leaseExpiresAt: IsoDateTime | null;
  /**
   * The SDK session the run is in, as far as the **database** knows it — or `null`.
   *
   * `runs.session_id` is written only when a run ends, and the handle that knows it mid-run is in
   * the holder's process. What the database does have is the run's own `system`/`init` transcript
   * entry, which the runner writes the moment the CLI reports its session (`run_messages`); the SQL
   * adapter reads it from there. So a take-over answered by a process that does not hold the run
   * still carries `claude --resume <session>` (product/19 §19) once the session has started, and
   * `null` — never a guess — before (WP-85).
   */
  readonly sessionId: string | null;
}

/**
 * `run_commands` — a human command on its way to the process holding the run (WP-85, TD-028
 * decision 9; the states and their writers are in migration 0060's header).
 *
 * **The lock is what makes "a command for a run that ended is never applied late" hold.** A command
 * is recorded only after {@link lockRun} has read the run live under `for share`, in the same
 * transaction; `RunRepository.finish` updates that row and then closes every pending command
 * `run_ended`, in its transaction. So either the ending waits for the command to commit and then
 * closes it, or the command waits for the ending and reads the run terminal — there is no order in
 * which a pending row outlives its run. {@link markApplied} takes the same lock, so the holder's
 * stamp and the ending are ordered the same way.
 */
export interface RunCommandRepository {
  /**
   * The run, locked `for share`, or `null` when there is no such run.
   *
   * `forUpdate` takes the row exclusively instead (WP-101): a cancel may go on to `finish` the row
   * it read, and two cancels that each held `for share` and then both asked for the row
   * exclusively would deadlock rather than one refusing the other.
   */
  lockRun(
    tx: Transaction,
    runId: Id,
    options?: { readonly forUpdate?: boolean },
  ): Promise<LockedRun | null>;
  /**
   * The task's live run (`ACTIVE_RUN_STATUSES`), locked `for share`, or `null` when it has none.
   *
   * `stage` narrows it to a run attached to that stage (any attempt), so an **ask** run — which has
   * no stage — is never mistaken for the stage's (PROGRESS backlog 494: a retry stops the stage's
   * run and nothing else). `forUpdate` takes the row exclusively, for {@link lockRun}'s reason: the
   * caller may go on to `finish` the row it read.
   */
  lockLiveRunOf(
    tx: Transaction,
    taskId: Id,
    options?: { readonly forUpdate?: boolean; readonly stage?: Slug },
  ): Promise<LockedRun | null>;
  insert(tx: Transaction, command: NewRunCommand): Promise<void>;
  /**
   * Pending commands for the live runs **this holder** leases, oldest first — optionally for one run.
   * Bounded by `limit`; a burst beyond it is taken by the next drain.
   *
   * **A steer behind a stop is not handed out** (WP-101): while the run has a `cancel` or
   * `take_over` row that is not refused ({@link STOPPING_RUN_COMMAND_KINDS}), its pending steers are
   * left for the run's own ending to close `run_ended`. A turn delivered to a session that is being
   * stopped is a turn the run pays for and nobody reads.
   */
  pending(
    tx: Transaction,
    query: { readonly owner: string; readonly runId?: Id; readonly limit: number },
  ): Promise<readonly PendingRunCommand[]>;
  /**
   * Stamps `applied_at` — only while the row is pending **and** its run is live and leased to
   * `owner`, under a `for share` lock on the run. `false` when anything else got there first: the
   * other wake-up path, the run's ending, or a lease this process does not hold. The one arbiter
   * between the notification and the poll (standing rule 9).
   */
  markApplied(
    tx: Transaction,
    input: { readonly id: Id; readonly owner: string },
  ): Promise<boolean>;
  /**
   * Turns an `applied` stamp into the refusal `delivery_failed` — only while it still reads applied
   * (WP-85 review round 1). Never back to pending: the stamp stays the exactly-once arbiter, so
   * neither the notification nor the poll can deliver the command a second time.
   */
  markDeliveryFailed(tx: Transaction, input: { readonly id: Id }): Promise<boolean>;
  /** Stamps a refusal, only while the row is pending; `false` when it was already settled. */
  markRefused(
    tx: Transaction,
    input: { readonly id: Id; readonly reason: RunCommandRefusal },
  ): Promise<boolean>;
  /**
   * technical/08's steer window, **shared by every process on the database** (WP-101, PROGRESS
   * backlog 295): takes a transaction-scoped advisory lock on `userId` and answers whether that user
   * has recorded **no** `steer` row within the last `windowMs`, read by the database's own clock
   * (`created_at` is its default).
   *
   * The lock is the point. Two steers by one user in two processes would otherwise both read "no
   * row yet" at READ COMMITTED and both insert; with it the second transaction waits for the first
   * to commit and then reads its row. It is held to the end of the caller's transaction, so the
   * caller must insert the row it admitted **in the same transaction**, and must take it before any
   * row lock (`lockRun`), which is the order every steer takes.
   */
  admitSteer(
    tx: Transaction,
    input: { readonly userId: Id; readonly windowMs: number },
  ): Promise<boolean>;
}

export interface QuestionRepository {
  insert(tx: Transaction, question: Question): Promise<void>;
  load(tx: Transaction, questionId: Id): Promise<Question | null>;
  /** The aggregate's own columns — never `reminders_sent`, which only {@link recordReminder} writes. */
  save(tx: Transaction, question: Question): Promise<void>;
  /**
   * One reminder went out (WP-84, BD-006): `reminders_sent + 1`, **only** while the question is
   * still `open` and the counter still reads `sent` — `false` when an answer, an expiry or another
   * reminder got there first. Narrow rather than `save` because a reminder appends no event, so
   * nothing else would serialise it against an answer saved in a concurrent transaction.
   */
  recordReminder(
    tx: Transaction,
    input: { readonly id: Id; readonly sent: number },
  ): Promise<boolean>;
  /** Every question of the task still `open`; a blocking one keeps the task waiting. */
  open(tx: Transaction, taskId: Id): Promise<readonly Question[]>;
}

/** An approval, plus the stage attempt it was requested for (see the WP-15 migration). */
export interface StoredApproval {
  readonly approval: Approval;
  readonly stage: Slug | null;
  readonly attempt: number | null;
  /**
   * What was asked about and why (TD-035, migration 0103) — written **once, by `insert`**, and never
   * by {@link ApprovalRepository.save}, so a decision cannot rewrite what was asked. Absent or
   * `null` is *not recorded*: every row written before 0103.
   *
   * `subjectArtifactId` is the plan gate's `ImplementationPlan`; `subjectDetail` the budget gate's
   * figures; `reasons` every reason the gate asked for, in TD-035's closed vocabulary.
   */
  readonly subjectArtifactId?: Id | null;
  readonly subjectDetail?: BudgetApprovalSubjectDetail | null;
  readonly reasons?: readonly ApprovalReason[] | null;
  /**
   * `true` for a plan the project's low-risk rule let go ahead (S-28.8, migration 0114,
   * `autoApproveApproval`): approved by the platform, no decider. Written once, by `insert`, like
   * the reasons; absent is `false`.
   */
  readonly autoDecided?: boolean;
}

/**
 * The plan a plan approval is about, as {@link ApprovalRepository.planSubject} answers it.
 *
 * `recorded` is the gate's own `subject_artifact_id`; `derived` is TD-035 decision 5's one exact
 * chain for a row written before migration 0103 — `artifacts.produced_by_run_id → runs.task_stage_id
 * → task_stages(task, stage, attempt)` of the approval, with exactly one `ImplementationPlan` at its
 * end. The task read publishes the same answer, with the same label.
 */
export interface ApprovalPlanSubject {
  readonly artifactId: Id;
  readonly basis: 'recorded' | 'derived';
}

export interface ApprovalRepository {
  insert(tx: Transaction, stored: StoredApproval): Promise<void>;
  load(tx: Transaction, approvalId: Id): Promise<StoredApproval | null>;
  /** The decision's columns — never `reminders_sent`, which only {@link recordReminder} writes. */
  save(tx: Transaction, stored: StoredApproval): Promise<void>;
  /**
   * One reminder went out (WP-84, BD-006's Q95 amendment): `reminders_sent + 1`, only while the
   * approval is still `pending` and the counter still reads `sent`. The question's narrow write,
   * for the question's reason.
   */
  recordReminder(
    tx: Transaction,
    input: { readonly id: Id; readonly sent: number },
  ): Promise<boolean>;
  /**
   * The approval already recorded for this exact stage attempt, if any.
   *
   * Keyed on the *attempt* rather than on the task, because an approved plan does not approve the
   * next plan: a task that returns to Architecture and produces a second `ImplementationPlan` has
   * to be approved again, and a lookup by `(task, kind)` alone would wave it through.
   */
  forStageAttempt(
    tx: Transaction,
    query: {
      readonly taskId: Id;
      readonly kind: string;
      readonly stage: Slug;
      readonly attempt: number;
    },
  ): Promise<StoredApproval | null>;
  /**
   * The newest approval of this kind on the task, whatever stage attempt asked for it.
   *
   * The **budget** gate's lookup, and the difference from {@link forStageAttempt} is a difference
   * between the two questions rather than a second way of asking one (WP-28). A plan approval is a
   * statement about *a plan*: a task that returns to Architecture and produces a second
   * `ImplementationPlan` has to be approved again, which is why that lookup carries the attempt. A
   * budget approval is a statement about *the estimate*, and the estimate is written **once** —
   * `costEstimateHandler`'s `estimateUsd !== null` guard — so a re-refinement produces the same
   * number and asking a maintainer to release the same spend twice is asking the same question
   * twice. Measured before it was written: `enteredAttempt`
   * (`packages/domain/src/aggregates/task.ts`) increments on every re-entry, so keying the budget
   * gate on `(task, kind, stage, attempt)` would have asked again on attempt 2.
   *
   * Any status counts as *asked*, including `rejected` and `expired`: the question a second ask
   * would put is the one already answered, and a maintainer who wants the task to proceed raises
   * the threshold or hands the task back rather than waiting to be asked again.
   */
  latestOfKind(
    tx: Transaction,
    query: { readonly taskId: Id; readonly kind: string },
  ): Promise<StoredApproval | null>;
  /**
   * The plan this **plan** approval is about — recorded, or derived for a pre-0103 row by TD-035
   * decision 5's exact chain — or `null` when neither pins one (not a plan approval, no stage
   * attempt, no plan or more than one at the chain's end). The decide command's subject (TD-035
   * decision 6); never a guess, and never "the task's latest plan".
   */
  planSubject(tx: Transaction, approvalId: Id): Promise<ApprovalPlanSubject | null>;
}

/**
 * One proposed child ticket of an epic split, as the platform stores it (WP-40, migration 0033).
 *
 * **A queue of its own rather than an `approvals` row**, which is Q85's recommendation and its
 * reasoning: a breakdown is *N independent decisions* and an approval is one, so a PM who accepts
 * five of seven children needs a row per child to say so. The shape is `kb_proposals`' — a status,
 * who decided and when, and a rejection that **leaves the row** rather than deleting it.
 *
 * **Every string here is untrusted and every one of them is stored redacted** (TD-012, BD-022).
 * `title`, `description`, `acceptanceCriteria` and `rationale` are model output over an untrusted
 * epic and go through the platform's redactor in `breakdownQueueHandler`; `reason` is a human's
 * free text and goes through the same redactor in `decideBreakdown`. This is the **sixth** place
 * the platform stores untrusted external text, after `inbox`, `kb_chunks`, `tasks.ticket_snapshot`,
 * `tasks.review_subject` and `task_asks`, and it is the one whose contents become tickets in
 * somebody else's tracker — the largest external write this platform makes.
 *
 * What that redaction is and is not: TD-012 **step 2**, the pattern rules. Step 1 — the exact
 * values of a binding's own credentials — belongs to the binding, which this writer cannot resolve
 * (it runs inside the dispatcher's transaction, where `integrationsForProject` is refused), and is
 * applied by the adapter at the call. So a binding credential a model echoed leaves here at the
 * write and is removed at the write into the tracker; `epic-split.ts`'s own note carries the
 * measurement and `redactionCount` is what says a redactor stopped working.
 */
export interface StoredBreakdownItem {
  readonly id: Id;
  readonly projectId: Id;
  readonly taskId: Id;
  /** The run whose artifact proposed it; `null` only for a row a harness inserted. */
  readonly runId: Id | null;
  readonly artifactId: Id;
  /** Declaration order in the artifact, which is the order a PM reads them in. */
  readonly position: number;
  readonly title: string;
  readonly description: string;
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
  readonly size: Size;
  readonly rationale: string;
  readonly status: 'queued' | 'accepted' | 'rejected';
  readonly decidedByUserId: Id | null;
  readonly decidedAt: IsoDateTime | null;
  /**
   * The human's own words about the decision — untrusted text, redacted by `decideBreakdown`.
   *
   * The command that owns them is the one place they are stored, so that is where TD-012 is
   * applied: the route hands them over bounded by `decideBreakdownRequestSchema` and nothing else
   * on the way has a redactor.
   */
  readonly reason: string | null;
  /** What `createTicket` produced. `null` on an accepted row whose call has not happened yet. */
  readonly ticketKey: string | null;
  readonly ticketUrl: string | null;
  /**
   * How many replacements the redactor made in everything stored on this row.
   *
   * Summed over **both** writers — the model's fields at the insert and the human's `reason` at the
   * decision, which adds to it — for the reason migration 0024's note gives: a redactor that
   * stopped working leaves no other trace, and a count that covered one field of five would
   * under-report the row it sits beside. Not published: it is an operator's signal, not a reader's.
   */
  readonly redactionCount: number;
  readonly createdAt: IsoDateTime;
}

/**
 * The epic-split queue (WP-40).
 *
 * `decide` is a **narrow** write for standing rule 79's reason: the rows are written by the stage's
 * own handler, decided by an HTTP command and stamped with a ticket key by a `pipeline.outbound`
 * duty that runs beside both, so a whole-row save from any of the three would be a lost update.
 * Each method names the columns its writer owns and no others.
 */
export interface BreakdownRepository {
  insert(tx: Transaction, items: readonly StoredBreakdownItem[]): Promise<void>;
  /** Every child of a task, in `position` order — the queue as a human reads it. */
  listForTask(tx: Transaction, taskId: Id): Promise<readonly StoredBreakdownItem[]>;
  /**
   * Moves the named **queued** children to `accepted` or `rejected`, and answers the rows it moved
   * **as they now are** — the decision applied, not the state it found.
   *
   * That is a contract rather than an implementation detail, and it is asserted on both stores
   * (`pipeline-store-suite.ts` › "answers the rows a decision moved, as they are after it"): a
   * data-modifying CTE is invisible to the rest of its own statement, so the adapter's first
   * version returned the rows it had just updated *with their old status* while the in-memory fake
   * returned them updated — the divergence standing rule 1 exists to catch, in the direction that
   * would have made the fake kinder.
   *
   * The `queued` predicate is in the statement rather than in the caller: two maintainers deciding
   * the same child at the same instant is a race the database settles, and the second one gets an
   * empty list for that id rather than overwriting the first one's decision.
   *
   * `reason` arrives **already redacted** by {@link StoredBreakdownItem.reason}'s owner, with
   * `reasonRedactions` the count that redaction made, which this write adds to the row's own
   * {@link StoredBreakdownItem.redactionCount}.
   */
  decide(
    tx: Transaction,
    input: {
      readonly taskId: Id;
      readonly itemIds: readonly Id[];
      readonly status: 'accepted' | 'rejected';
      readonly decidedByUserId: Id;
      readonly decidedAt: IsoDateTime;
      readonly reason: string | null;
      readonly reasonRedactions: number;
    },
  ): Promise<readonly StoredBreakdownItem[]>;
  /** The ticket a `createTicket` call produced, on the child that asked for it. */
  recordTicket(
    tx: Transaction,
    input: {
      readonly itemId: Id;
      readonly ticketKey: string;
      readonly ticketUrl: string | null;
    },
  ): Promise<void>;
}

/** What {@link BugTraceRepository.latest} answers about one ticket's defect trace (WP-90). */
export interface LatestBugTrace {
  readonly outcome: 'linked' | 'no_link' | 'unreadable';
  /** The ticket's own `ticket.created` instant, as the trace recorded it. */
  readonly filedAt: IsoDateTime;
}

/**
 * The one read of the defect trace the pipeline makes — WP-90, PROGRESS backlog 192.
 *
 * A `ticket.updated` re-traces a bug only when the trace the statistics read would take is not
 * `linked`, and this is that question, asked with the **same ordering** as the read
 * (`apps/server/src/queries/stats-queries.ts` § `bugTraces`): a `linked` trace first, then the
 * newest. `null` for a ticket that was never traced — not a bug, or a bug whose first trace never
 * landed — which is never re-traced, because nothing says it is a bug.
 */
export interface BugTraceRepository {
  latest(
    tx: Transaction,
    ticket: { readonly projectId: Id; readonly provider: string; readonly key: string },
  ): Promise<LatestBugTrace | null>;
}

/**
 * One task's **duty lease** — WP-184, migration 0091: who is performing a group of the task's
 * outbound duties right now, across every process (`task_duty_leases`).
 *
 * The `IntegrationActionExecutor`'s idempotency record is written **after** the call (its step 5),
 * so two performers of one key that overlap both call the provider — measured in WP-184's unit
 * suite, and the reason this exists. The `stage.execute` job performs the review conversation's
 * owed duties before it plans the next agent stage, and the `pipeline.outbound` duty that also
 * fires performs the same ones; the lease makes them take turns, and the idempotency keys make the
 * second turn a replay that calls nothing.
 *
 * A lease **expires**: a holder renews it while it works and deletes it when it is done, so a
 * holder whose process died blocks the group for at most one lease length. The instant is the
 * caller's clock, in both halves, so a test's clock decides expiry as production's does.
 */
export interface TaskDutyLeaseRepository {
  /**
   * Takes the lease when nobody holds it, when its holder's lease has expired, or when `holder`
   * already holds it (a renewal). Answers whether `holder` holds it now.
   */
  claim(
    tx: Transaction,
    input: {
      readonly taskId: Id;
      readonly lease: string;
      readonly holder: string;
      readonly now: IsoDateTime;
      readonly expiresAt: IsoDateTime;
    },
  ): Promise<boolean>;
  /**
   * Extends `holder`'s **own** live row and nothing else (WP-184 review round 1): it never inserts,
   * so a renewal that lands after the holder's release cannot bring the row back. Answers whether
   * a row was extended.
   */
  renew(
    tx: Transaction,
    input: {
      readonly taskId: Id;
      readonly lease: string;
      readonly holder: string;
      readonly now: IsoDateTime;
      readonly expiresAt: IsoDateTime;
    },
  ): Promise<boolean>;
  /** Gives the lease back — only `holder`'s; somebody else's lease is left alone. */
  release(
    tx: Transaction,
    input: { readonly taskId: Id; readonly lease: string; readonly holder: string },
  ): Promise<void>;
}

export interface PipelineStore {
  /** WP-184's per-task duty lease (migration 0091). */
  readonly dutyLeases: TaskDutyLeaseRepository;
  readonly tasks: TaskRepository;
  readonly artifacts: ArtifactRepository;
  readonly runs: RunRepository;
  /** WP-274's offers (migration 0094, TD-031 decisions 1–2). */
  readonly offers: RunOfferRepository;
  /** The run's planned spec, sealed (WP-275a, migration 0095). */
  readonly runPlans: RunPlanRepository;
  /** WP-278's execution settings and claimant liveness (migration 0097, TD-031 decision 8). */
  readonly execution: ExecutionRoutingRepository;
  readonly questions: QuestionRepository;
  readonly approvals: ApprovalRepository;
  /** WP-40's epic-split queue: one row per proposed child ticket. */
  readonly breakdown: BreakdownRepository;
  /** WP-85's commands on their way to the process holding a live run. */
  readonly runCommands: RunCommandRepository;
  /** WP-90's read of a ticket's defect trace, off the project's event stream. */
  readonly bugTraces: BugTraceRepository;
  /** S-26.1's questions about who may own a task — `user_identities`, roles, the binding's account. */
  readonly owners: TaskOwnerDirectory;
}

/**
 * **Who a tracker assignee is, and who may own a task** (S-26.1, TD-031's 2026-11-06 amendment
 * items 1 and 6) — read in the caller's transaction, live, so a link or a role change made since
 * the last read counts at once.
 *
 * Only through `user_identities`, keyed by the provider-issued account id: never an email, never a
 * display name (BD-022, Q10 — an owner's machine gets the head start, and a guessed identity would
 * route a run to a stranger's machine).
 */
export interface TaskOwnerDirectory {
  /**
   * `member` when `(provider, externalId)` is a `person` identity linked to a user whose effective
   * role in the project (the higher of the organisation role and a membership,
   * `userMayRunInProjectSql`) is `member` or above and who is not disabled; `platform` when it is a
   * `machine` identity, or
   * the account of one of the project's bindings (`bindings.account_identity`, migration 0090) that
   * maps to no such member; `person` otherwise — unlinked, or linked below `member`.
   */
  classifyAssignee(
    tx: Transaction,
    input: { readonly projectId: Id; readonly provider: string; readonly externalId: string },
  ): Promise<AssigneeClass>;
  /**
   * Whether `userId`'s effective role in the project is `member` or above and the account is not
   * disabled (`users.status`) — who may own a task.
   */
  mayOwn(tx: Transaction, input: { readonly projectId: Id; readonly userId: Id }): Promise<boolean>;
  /**
   * The user's **`person`** identity for `provider` — what the owner write-back assigns the ticket
   * to (S-26.3, TD-031's 2026-11-06 amendment item 4) — or `null` when they have none. A `machine`
   * identity is never one (it has no user). A user linked to two accounts of one provider answers
   * the **oldest** link (`created_at`, then the account id), so one owner always names one account.
   */
  personIdentity(
    tx: Transaction,
    input: { readonly userId: Id; readonly provider: string },
  ): Promise<{ readonly externalId: string } | null>;
}

/** Everything the pipeline needs to name a ticket it has not created a task for yet. */
export interface IntakeTicket {
  readonly ref: TicketRef;
  readonly issueType: string | null;
  readonly priority: string | null;
}

/** The system actor every pipeline-issued command carries (technical/03 `events.actor`). */
export const PIPELINE_ACTOR: Actor = { kind: 'system', component: 'pipeline' };

/** Convenience for a payload that is a `JsonObject` when it is an object at all. */
export const asJsonObject = (value: JsonValue | null | undefined): JsonObject | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;

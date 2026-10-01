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
  ArtifactType,
  ContextPackRecord,
  EstimateBasis,
  HistorySample,
  Id,
  IsoDateTime,
  JsonObject,
  JsonValue,
  MergeRequestRef,
  MergeRequestSnapshot,
  PipelineTemplate,
  RunCost,
  RunStatus,
  RunTerminalReason,
  Size,
  Slug,
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
import type { Approval, IterationLimits, Question, QueuedTask, Task } from '@platform/domain';
import type { ConcurrencyConflict } from '../events/concurrency.js';
import type { Transaction } from '../ports/transaction.js';
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
  /** Sum of the runs' reported cost, in USD (`tasks.cost_actual`). */
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

export interface TaskRepository {
  load(tx: Transaction, taskId: Id): Promise<StoredTask | null>;
  /** Intake's idempotency key: one task per ticket per mode (`tasks_project_id_ticket_key_mode`). */
  findByTicket(
    tx: Transaction,
    query: {
      readonly projectId: Id;
      readonly provider: string;
      readonly ticketKey: string;
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
  insert(tx: Transaction, stored: StoredTask): Promise<void>;
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
   * Two saves in one transaction are an ordinary shape here — `recordMergeRequest` records the MR
   * and then `applyDecision` moves the stage — and the second one carries the version the first
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
   */
  readonly recordTicketSignal: (
    tx: Transaction,
    signal: {
      readonly projectId: Id;
      readonly provider: string;
      readonly ticketKey: string;
      readonly at: IsoDateTime;
    },
  ) => Promise<number>;
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
   * `mr_ref` belongs to `save`, so a head that **does** move bumps `version` in the same statement
   * (rule 79): a `save` over a snapshot read before it is refused rather than putting the old
   * revision back. The census in `tasks-column-ownership.test.ts` names both statements.
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
   * When the run's session was started, or `null` for a row that never reached `starting`.
   *
   * Read since WP-15i, because `POST /api/runs/:run_id/cancel` ends a run from **another process**
   * than the one executing it: the executor has the `Run` aggregate it created in memory and can
   * compute the wall time from it, and a cancelling request has only the row. Without this the
   * cancelled run's `wall_ms` would have to be written as `0`, which is a measurement nobody made.
   *
   * The SQL adapter writes `started_at = now()` in the insert, so a caller does not supply it; it
   * is on this type because `load` answers it.
   */
  readonly startedAt: IsoDateTime | null;
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
};

export interface RunRepository {
  insert(tx: Transaction, run: NewRun): Promise<void>;
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
       * exact reading standing rule 16 exists to refuse. Both cost columns are left unset, so the
       * pending term values the ended row at 0 (nothing committed) rather than at a measurement.
       *
       * The two are written apart: `is_estimate: false` fills `usd_reported`, `true` fills
       * `usd_estimated` (WP-47, migration 0035), and the other one is `null`.
       */
      readonly cost: RunCost | null;
      readonly wallMs: number;
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
   * has already seen a `run.finished` carrying zeros and taken its `no_spend` branch.
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
    },
  ): Promise<boolean>;
  /**
   * Claims or renews the run's lease — `runs.lease_owner` / `lease_expires_at` (TD-003, WP-47).
   *
   * Both columns have existed since migration 0004 and had **no reader and no writer** until WP-47.
   * The owner is the process executing the run: it claims the lease in the transaction that creates
   * the row and renews it on a heartbeat while the session is live, so *"nothing is renewing this
   * lease"* becomes a question a query can ask. It is the only thing a missing heartbeat licenses
   * anybody to conclude — never that the model stopped, never that the work was wasted.
   *
   * Conditional on the run still being live **and** on the lease being this process's (or unheld),
   * and answers whether it wrote. A `false` is not an error: the run has ended, or another process
   * took the lease over, and a heartbeat that kept writing either would be renewing a claim it does
   * not hold. The caller stops beating and lets its own `finish` arbitrate.
   */
  renewLease(
    tx: Transaction,
    lease: {
      readonly runId: Id;
      readonly owner: string;
      readonly expiresAt: IsoDateTime;
    },
  ): Promise<boolean>;
  load(tx: Transaction, runId: Id): Promise<StoredRun | null>;
  /**
   * What the task's runs add up to — the `totals` of `task.completed` / `task.cancelled`.
   *
   * `is_estimate` is true when **any** run's cost was an estimate rather than a provider-reported
   * figure (BD-011): a total that mixes the two is an estimate, and reporting it as measured is
   * the direction that misleads.
   */
  totalsFor(
    tx: Transaction,
    taskId: Id,
  ): Promise<{
    readonly runs: number;
    readonly costUsd: number;
    readonly isEstimate: boolean;
    readonly wallMs: number;
  }>;
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
  /** The task's live run (`ACTIVE_RUN_STATUSES`), locked `for share`, or `null` when it has none. */
  lockLiveRunOf(tx: Transaction, taskId: Id): Promise<LockedRun | null>;
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

export interface PipelineStore {
  readonly tasks: TaskRepository;
  readonly artifacts: ArtifactRepository;
  readonly runs: RunRepository;
  readonly questions: QuestionRepository;
  readonly approvals: ApprovalRepository;
  /** WP-40's epic-split queue: one row per proposed child ticket. */
  readonly breakdown: BreakdownRepository;
  /** WP-85's commands on their way to the process holding a live run. */
  readonly runCommands: RunCommandRepository;
  /** WP-90's read of a ticket's defect trace, off the project's event stream. */
  readonly bugTraces: BugTraceRepository;
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

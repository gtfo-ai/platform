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
  TaskReviewers,
  TicketRef,
  TicketSnapshot,
  TokenUsage,
  WorkpadRef,
} from '@platform/contracts';
import type { Approval, Question, QueuedTask, Task } from '@platform/domain';
import type { ConcurrencyConflict } from '../events/concurrency.js';
import type { Transaction } from '../ports/transaction.js';

/** A task as the pipeline holds it: the aggregate plus the row's own columns. */
export interface StoredTask {
  readonly task: Task;
  /** The template the task started with; a later edit to project settings never moves a task. */
  readonly template: PipelineTemplate;
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
   * The human who asked for this task — step **three** of product/19:138's reviewer precedence.
   *
   * `tasks.requested_by_user_id` **has no writer anywhere in this build**: intake creates a task
   * from a ticket a rule matched, and the three commands that create one (discovery, review-only,
   * the ticket linter) carry the actor into the `human_actions` row rather than onto the task. So
   * this is `null` on every row, the fallback resolves to nobody, and WP-37 says so by name instead
   * of assigning silently. It is read rather than omitted because the alternative — routing that
   * cannot express its own last step — is the state `readCodeowners` sat in for five milestones.
   */
  readonly requestedByUserId: Id | null;
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
  /** WIP counting (BD-010); `countsAsActive` / `countsInPipeline` decide which states count. */
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
  /** Closes the row `recordStageEntered` opened, with what the stage decided. */
  recordStageExited(
    tx: Transaction,
    entry: {
      readonly taskId: Id;
      readonly stage: Slug;
      readonly attempt: number;
      readonly outcome: string;
      readonly returnReason: string | null;
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
  /** The last `limit` signatures at `stage`, oldest first — the order `hasIdenticalFailureStreak` wants. */
  recentStageSignatures(
    tx: Transaction,
    taskId: Id,
    stage: Slug,
    limit: number,
  ): Promise<readonly string[]>;
  /** The `return_reason` of the most recent closed attempt at `stage`, for the next run's prompt. */
  lastReturnReason(tx: Transaction, taskId: Id, stage: Slug): Promise<string | null>;
}

export interface StoredArtifact {
  readonly id: Id;
  readonly taskId: Id;
  readonly type: ArtifactType;
  readonly version: number;
  readonly markdown: string | null;
  readonly data: JsonValue;
  readonly schemaVersion: string;
  readonly producedByRunId: Id | null;
  readonly createdAt: IsoDateTime;
}

export interface ArtifactRepository {
  /** "Artifacts are versioned; a stage re-run creates a new version, never overwrites." */
  nextVersion(tx: Transaction, taskId: Id, type: ArtifactType): Promise<number>;
  insert(tx: Transaction, artifact: StoredArtifact): Promise<void>;
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

export interface RunRepository {
  insert(tx: Transaction, run: StoredRun): Promise<void>;
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
      readonly cost: RunCost;
      readonly wallMs: number;
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

export interface QuestionRepository {
  insert(tx: Transaction, question: Question): Promise<void>;
  load(tx: Transaction, questionId: Id): Promise<Question | null>;
  save(tx: Transaction, question: Question): Promise<void>;
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
  save(tx: Transaction, stored: StoredApproval): Promise<void>;
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

export interface PipelineStore {
  readonly tasks: TaskRepository;
  readonly artifacts: ArtifactRepository;
  readonly runs: RunRepository;
  readonly questions: QuestionRepository;
  readonly approvals: ApprovalRepository;
  /** WP-40's epic-split queue: one row per proposed child ticket. */
  readonly breakdown: BreakdownRepository;
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

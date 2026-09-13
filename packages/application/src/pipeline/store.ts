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
  Actor,
  ArtifactType,
  Id,
  IsoDateTime,
  JsonObject,
  JsonValue,
  MergeRequestRef,
  PipelineTemplate,
  RunCost,
  RunStatus,
  RunTerminalReason,
  Slug,
  TaskMode,
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
   *    `size` and `estimate_usd` belong to the narrow writers below and to
   *    `CostStore.saveEstimate`; `save` does not name them, so it cannot put back a `null` one of
   *    them filled in. That direction was live until WP-15e: `saveWorkpad` stopped the workpad job
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
}

export interface RunRepository {
  insert(tx: Transaction, run: StoredRun): Promise<void>;
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
  ): Promise<void>;
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
}

export interface PipelineStore {
  readonly tasks: TaskRepository;
  readonly artifacts: ArtifactRepository;
  readonly runs: RunRepository;
  readonly questions: QuestionRepository;
  readonly approvals: ApprovalRepository;
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

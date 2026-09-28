/**
 * The deferred dependency-gate ending whose wake-up was lost — PROGRESS backlog **240**, WP-84, a
 * row of `./stranded.ts`'s table.
 *
 * ## What is wrong without this
 *
 * WP-67 defers a dependency gate's `ask` or `block` that met a stop a human owns: the record says
 * so (`tasks.dependencies.deferred_stage`), and the `task.resumed` handler in
 * `pipeline/dependency-gate.ts` reads it and enqueues the `dependency_gate_resume` duty through
 * `HandlerContext.afterCommit`. That enqueue is at-most-once (TD-004): a process that dies between
 * the resume's commit and the enqueue leaves an `active` task carrying a deferral nothing will
 * perform — the question WP-67 exists to make sure is asked is not, or a package the policy blocks
 * rides on to review — until the task happens to stop and resume again. Redispatching the event is
 * no remedy: its `handler_executions` record makes the dispatcher skip it.
 *
 * ## What it looks for
 *
 * A task that is **`active`**, whose record still names a `deferred_stage`, and whose **newest
 * `task.resumed`** is older than the pass's grace. The resume is the instant the wake-up was owed
 * from — the deferral itself was written while the task was stopped, and a task leaves every one of
 * the four stops a human owns through a stage entry that emits `task.resumed` (`RESUMED_FROM` in the
 * Task aggregate), so no column had to be added to say *when the task became active*: the event log
 * already does. `active` is the whole of the state filter because it is the only state in which the
 * duty performs something and clears the record: at a human-owned stop it leaves the deferral for
 * the next resume, and past review Q91's answer drops an `ask` — both are the duty's own endings on
 * the next wake-up, not lost ones.
 *
 * ## What bounds it
 *
 * `tasks.dependency_recovery_attempted_at` (migration 0059) — the instant this pass re-enqueued the
 * duty, committed **before** the enqueue (the order `stranded.ts`'s `runAttemptOrEndSite` argues
 * for). The query admits a task again only when its newest `task.resumed` is **later** than the
 * mark: one attempt per resume. So a duty that keeps failing is re-enqueued once, not every pass
 * (backlog 105), and a later deferral that meets a later resume is recoverable in its own turn.
 *
 * **There is no ending**, and that is the difference from the attempt-or-end rows. Their ending
 * releases something the lost row holds for ever — a project's one live bootstrap, an ask's thread.
 * A deferral holds nothing: it stays on the record, the panel shows it, and the next `task.resumed`
 * performs it through the ordinary handler. What a failed recovery costs is exactly what backlog
 * 240 cost before this row, for one task, after one logged attempt — and a duty that throws is
 * retried by the queue and dead-lettered with its error like every other `pipeline.outbound` job.
 *
 * A re-enqueue is idempotent end to end: the duty re-validates on fire under the row lock and clears
 * the record in the transaction that performs the ending, so a wake-up that was only *slow* finds
 * nothing to do.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import type { Transaction } from '../ports/transaction.js';
import type { StrandedQuery } from './stranded.js';

/** One `active` task whose deferred ending nobody performed. */
export interface StrandedDeferredDependency {
  readonly taskId: Id;
  readonly projectId: Id;
  /** The newest `task.resumed` — the event the lost wake-up was caused by. */
  readonly resumedEventId: Id;
  readonly resumedAt: IsoDateTime;
}

export interface DeferredDependencyRecoveryStore {
  /**
   * `active` tasks with `dependencies.deferred_stage` set whose newest `task.resumed` is older than
   * `query.olderThan` and later than the task's recovery mark (or it has none). Oldest resume first,
   * at most `query.limit`. `query.endingBefore` is not read: this row has no ending.
   */
  strandedDeferredDependencies(
    tx: Transaction,
    query: StrandedQuery,
  ): Promise<readonly StrandedDeferredDependency[]>;
  /** Records this pass's one attempt for the task's current resume. */
  markDeferredDependencyAttempt(
    tx: Transaction,
    input: { readonly taskId: Id; readonly at: IsoDateTime },
  ): Promise<void>;
}

export interface DeferredDependencyRecoverySite {
  readonly store: DeferredDependencyRecoveryStore;
}

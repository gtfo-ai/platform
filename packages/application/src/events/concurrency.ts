/**
 * The one thing the dispatcher needs to know about an optimistic-concurrency refusal (WP-15e).
 *
 * A repository that refuses to write over a row another transaction has moved throws — and the unit
 * that has to be run again is the **whole transaction**, because the previous attempt may have
 * written rows the retry would duplicate (`approvals.insert` runs before `tasks.save` in
 * `planApprovalGate`, and its id comes from `ids.next()`). An event handler does not own its
 * transaction; `EventBus` does. So the bus is where a handler's retry lives, and this module is the
 * whole of the coupling: a structural marker and a bound, with no knowledge of tasks, stores or
 * the pipeline.
 *
 * **A structural flag rather than an `instanceof`.** The dispatcher is generic machinery that must
 * not import a repository's error class to recognise one of its errors, and two copies of a module
 * in one process — a bundler, a linked workspace, a test double compiled separately — make
 * `instanceof` answer `false` for an error that is exactly the one being asked about.
 */

/** An error that says "somebody else wrote this row; re-read and decide again". */
export interface ConcurrencyConflict {
  readonly concurrencyConflict: true;
}

/**
 * Whether an error is a refused write over a row another transaction moved.
 *
 * Deliberately structural and deliberately narrow: a truthy `concurrencyConflict` is not enough,
 * because a handler's own untrusted payload could carry one. It must be exactly `true`.
 */
export const isConcurrencyConflict = (error: unknown): error is ConcurrencyConflict =>
  typeof error === 'object' &&
  error !== null &&
  (error as { concurrencyConflict?: unknown }).concurrencyConflict === true;

/**
 * How many times a unit that lost a race is run again before it is treated as a failure.
 *
 * One constant for both retry sites — the bus's handler transaction and the pipeline's own
 * `retryOnTaskConflict` — because two numbers describing one policy is the drift standing rule 63
 * is about.
 *
 * Six (three until 2026-11-26, BD-034, BACKLOG 1659), and the number is a judgement rather than a
 * measurement: a conflict means another transaction committed between this one's read and its
 * write, so the losing side re-reads a row that is *already* settled. One task is written by several
 * queues at once — `stage.execute`, `pipeline.outbound`, the review window, a person's command, the
 * dispatcher — each at concurrency 1 but on as many replicas as run, so a short burst can beat a
 * writer three times running; a lost race is recoverable by definition, and BD-034 says a
 * recoverable condition waits rather than escalates. `retryOnTaskConflict` also backs off between
 * its attempts ({@link conflictBackoffMs}); the bus re-runs at once, because a bus failure falls
 * through to the dispatch's own retry with backoff, never to a person. Six losses in a row spread
 * over most of a second is a writer that keeps rewriting the row — a loop a person has to look at.
 */
export const MAX_CONCURRENCY_CONFLICT_ATTEMPTS = 6;

/**
 * The wait before job-side attempt `attempt + 1` after attempt `attempt` lost its race (BD-034,
 * BACKLOG 1659): 25 ms doubling (25, 50, 100, 200, 400), each scaled by a jitter in `[0.5, 1]` so
 * two losers do not collide again in step — at most 775 ms across the five waits. Taken **between**
 * transactions, never inside one: nothing is held while it waits.
 */
export const conflictBackoffMs = (attempt: number, random: () => number = Math.random): number =>
  Math.round(25 * 2 ** Math.max(0, Math.min(attempt - 1, 10)) * (0.5 + random() / 2));

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
 * Three, and the number is a judgement rather than a measurement: a conflict means another
 * transaction committed between this one's read and its write, so the losing side re-reads a row
 * that is *already* settled. Losing three times running needs three independent writers landing in
 * the same handful of milliseconds, which the shipped configuration cannot produce
 * (`APP_DISPATCH_MAX_CONCURRENCY` is 1 and every pipeline job worker's concurrency is 1). The
 * honest way to move it is to measure a real conflict rate, and nothing produces production load
 * yet (PROGRESS backlog 1).
 */
export const MAX_CONCURRENCY_CONFLICT_ATTEMPTS = 3;

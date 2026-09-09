/**
 * The ambient database transaction, as the application ring is allowed to see it: opaque.
 *
 * technical/01 keeps adapters out of `application`, so this ring may not name a `pg.Client`. It
 * still has to *pass one around* — TD-005 requires an aggregate's state, its events and the
 * dispatcher's bookkeeping to commit together — so the handle travels as this marker interface and
 * the adapter narrows it back to its own type. `adapter` is what makes that narrowing safe: an
 * adapter handed a foreign handle rejects it instead of casting it.
 */
export interface Transaction {
  /** Name of the adapter that opened this transaction (`postgres`, `memory`, …). */
  readonly adapter: string;
}

/** Thrown when an adapter is handed a transaction handle another adapter created. */
export class ForeignTransactionError extends Error {
  readonly expected: string;
  readonly actual: string;

  constructor(expected: string, actual: string) {
    super(`transaction belongs to the "${actual}" adapter, expected "${expected}"`);
    this.name = 'ForeignTransactionError';
    this.expected = expected;
    this.actual = actual;
  }
}

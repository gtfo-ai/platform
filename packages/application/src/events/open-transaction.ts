/**
 * "Is a database transaction open on this call path?" — the fact the outbound guard rests on.
 *
 * ## Why this exists (WP-15d)
 *
 * CLAUDE.md states the shape a unit of pipeline work has: *transaction / no transaction /
 * transaction*, "so no database connection is held while a run is". Three handlers broke it —
 * `pipeline.intake`, `pipeline.workpad` and `pipeline.status.mapping` each called a provider while
 * `context.scope.tx` was open — and the cost was paid twice before anyone named the cause: a
 * foreign key that made every e2e fail (the audit row commits before the saga does) and a pool
 * floor that had to grow a third connection per in-flight dispatch. Measured at the shipped
 * defaults with one git read held open, an event with nothing to do with that provider **was not
 * dispatched at all** for as long as the call was in flight, because `APP_DISPATCH_MAX_CONCURRENCY`
 * ships as 1 and the slot was inside the handler
 * (`test/e2e/pipeline/outbound-shape.e2e.test.ts`).
 *
 * Prose did not prevent it and a review did not catch it, so it is a **runtime** fact now: the two
 * places that hand pipeline code an open scope mark it here, and
 * {@link assertOutsideTransaction} refuses. A guard enforced only by TypeScript is not enforced at
 * a boundary (standing rule 14), and a rule written only in a docblock is the rule that gets
 * broken by the next work package (rule 30).
 *
 * ## The mechanism, and what it can and cannot see
 *
 * `AsyncLocalStorage` propagates through `await`, so everything a handler or a job calls while its
 * transaction is open sees the mark, however many layers down. What it **cannot** see:
 *
 *  - a transaction opened by something that does not go through the two marking sites — a
 *    composition root that calls `unitOfWork.transaction` itself, or an adapter that takes its own
 *    `pool.connect()`. The marks are on `EventBus`'s handler invocation and on the `UnitOfWork` the
 *    pipeline runtime is given, which together cover every transaction the pipeline opens;
 *  - work deliberately detached from the async context (a callback stored and run later,
 *    `setTimeout`, an unawaited promise that outlives the transaction). Detaching is how a caller
 *    would *lose* the mark, so the failure direction is a call that is refused when it need not be
 *    — noisy, not silent;
 *  - a connection held by anything other than a transaction.
 *
 * It is deliberately **not** a lock or a nesting counter: the question is binary, and a nested
 * `transaction()` is a thing the `UnitOfWork` port already refuses to promise.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { TransactionScope, UnitOfWork } from '../ports/unit-of-work.js';

/**
 * Thrown when work that must not hold a pooled connection is attempted inside a transaction.
 *
 * Its own class rather than an `ApplicationError` code, because the *only* correct response is to
 * move the call: there is no retry, no fallback and no configuration that makes it right.
 */
export class TransactionOpenError extends Error {
  override readonly name = 'TransactionOpenError';
  /** What was attempted — `integrations.forProject`, `get_default_branch_head`. */
  readonly attempted: string;

  constructor(attempted: string) {
    super(
      `${attempted} was attempted inside an open database transaction. A provider call holds a ` +
        'pooled connection for the length of somebody else’s HTTP round trip and nests the ' +
        'audit write inside the caller’s transaction, so the pipeline makes it from a job ' +
        'instead: enqueue with HandlerContext.afterCommit and re-validate when the job fires ' +
        '(TD-004, technical/06 § "Outbound: actions"). See packages/application/src/pipeline/' +
        'outbound.ts for the shape.',
    );
    this.attempted = attempted;
  }
}

const storage = new AsyncLocalStorage<true>();

/** Runs `fn` with "a transaction is open" marked for everything it awaits. */
export const withOpenTransaction = async <T>(fn: () => Promise<T>): Promise<T> =>
  storage.run(true, fn);

/** Is a transaction open on this call path? */
export const transactionIsOpen = (): boolean => storage.getStore() === true;

/** @throws {TransactionOpenError} when a transaction is open on this call path. */
export const assertOutsideTransaction = (attempted: string): void => {
  if (transactionIsOpen()) {
    throw new TransactionOpenError(attempted);
  }
};

/**
 * The same `UnitOfWork`, with every transaction it opens marked.
 *
 * The pipeline runtime wraps the unit of work it is handed, so the job path is under the same rule
 * as the handler path — the stage executor and the two job handlers already call providers outside
 * their transactions, and this is what keeps them there. It is a decorator rather than a change to
 * the adapters because there are three `UnitOfWork` implementations (PostgreSQL, the in-memory
 * double, and whatever a test writes) and a rule maintained in three places is a rule that drifts
 * (standing rule 7).
 */
export const markTransactions = (unitOfWork: UnitOfWork): UnitOfWork => ({
  transaction: <T>(fn: (scope: TransactionScope) => Promise<T>): Promise<T> =>
    withOpenTransaction(async () => unitOfWork.transaction(fn)),
});

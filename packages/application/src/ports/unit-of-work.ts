/**
 * One transaction, and everything that must commit with it (TD-005's transactional outbox).
 *
 * A `TransactionScope` is handed to use cases and to event handlers. It carries the opaque
 * `Transaction` handle — which later work packages' repositories narrow back to their adapter's
 * type — plus the three ports the dispatcher itself needs bound to the same transaction, so that
 * "aggregate state + its events + the handler's execution record" is one atomic write.
 */

import type { TransactionalBroadcast } from './broadcast.js';
import type { DispatchQueue } from './dispatch-queue.js';
import type { EventAppender } from './event-store.js';
import type { HandlerExecutionWriter } from './handler-executions.js';
import type { Transaction } from './transaction.js';

export interface TransactionScope {
  /** Opaque handle; adapters narrow it, the application ring only passes it on. */
  readonly tx: Transaction;
  readonly events: EventAppender;
  readonly dispatchQueue: DispatchQueue;
  readonly handlerExecutions: HandlerExecutionWriter;
  /** Publishes on commit, never before. */
  readonly broadcast: TransactionalBroadcast;
}

export interface UnitOfWork {
  /**
   * Runs `fn` in one transaction: commits when it resolves, rolls back when it throws.
   *
   * Nested calls are not supported — the dispatcher deliberately runs each handler in its own
   * transaction so a failure rolls back that handler alone.
   */
  transaction<T>(fn: (scope: TransactionScope) => Promise<T>): Promise<T>;
}

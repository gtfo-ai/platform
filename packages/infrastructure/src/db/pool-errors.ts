/**
 * What a `pg.Pool` does when a connection it is **not** using dies.
 *
 * `pg.Pool` emits `'error'` for exactly one thing: a failure on a client that is sitting *idle* in
 * the pool. A failing query rejects its own promise, and a failure on a checked-out client is
 * delivered to its borrower — neither reaches here. By the time this event fires pg-pool has
 * already removed and ended that client (`makeIdleListener` → `pool._remove`), so the pool is
 * still usable and there is nothing left to fail. But `'error'` is an `EventEmitter`'s one magic
 * event: with no listener it is **thrown**, and it is thrown from a socket data callback, where
 * nobody is awaiting. That is an uncaught exception, and an uncaught exception ends the process.
 *
 * ## The measurement that made this necessary (2026-09-12, PostgreSQL 18, pg 8.23, pg-pool 3.14)
 *
 * `await pool.end()` resolves while the sockets of the clients it has just removed are **still
 * open**. `Pool._remove` filters the client out of `_clients` and calls `client.end()` *without
 * awaiting the callback*; `_pulseQueue` then sees an empty `_clients` and fires the end callback
 * in the same tick. Held against pg-pool's own `remove` event, the order is
 * `['end-resolved']` first and `['end-resolved', 'remove-event']` a tick later, with the removed
 * client's socket reporting `destroyed === false` at the moment `end()` resolved. (A bare
 * `pg.Client.end()` does not have this property: it resolves on the connection's `end` event, so a
 * client the caller closed itself is genuinely closed.)
 *
 * So a pool that was shut down correctly can still receive a FATAL for a few milliseconds
 * afterwards. In CI (run 34671397340) that window landed under the e2e harness's
 * `drop database … with (force)`: `57P01` arrived on an idle client of an `apps/server` instance
 * whose `stop()` had already returned, and failed a whole job in which every test had passed. The
 * serialized error carried `database` and `port` because pg-pool's idle listener hangs the dead
 * `Client` off the error as `err.client` before re-emitting it.
 *
 * ## Why this reports instead of re-throwing
 *
 * Two collaborators in this repository can already fail in the background with nobody awaiting —
 * pg-boss (`onError`) and the `LISTEN` connection (`NotificationClient.onError`) — and both answer
 * the same way: report it, keep serving. A server that exits because an *idle* socket died is not
 * safer than one that logs it; it is just down, and it goes down on exactly the events an operator
 * expects it to survive (a failover, a `pg_terminate_backend`, a rolling restart). So nothing here
 * re-throws, and the branch is in the **level**: a connection that was taken away is a `warn`, and
 * anything else is an `error` naming the code, because "I do not recognise this" is a thing worth
 * waking up for even when it is not worth dying for.
 *
 * This is deliberately *not* the rule the test harness uses. `createTestPool`
 * (`test/integration/support/postgres.ts`) swallows `57P01` and re-throws everything else: a
 * harness that hides a database error hides it from the only person who would have fixed it.
 */
import { type Logger, silentLogger } from '@platform/application';
import type pg from 'pg';

/**
 * The connection was taken away; the pool has already discarded it and will open another.
 *
 * SQLSTATE `57P0x` is the server saying so (administrator command, crash of a sibling backend,
 * shutdown in progress) and `08xxx` is the connection class; the three `E*` values are Node's
 * socket errors, which arrive on the same `.code` property. Nothing here is a statement about the
 * platform's own SQL — an idle client has no statement in flight to be wrong.
 */
export const CONNECTION_LOSS_CODES: ReadonlySet<string> = new Set([
  '57P01',
  '57P02',
  '57P03',
  '08003',
  '08006',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
]);

/** `.code` of a `DatabaseError` or of a Node socket error, when there is one. */
export const errorCode = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const { code } = error as { code?: unknown };
  return typeof code === 'string' ? code : undefined;
};

/** True when the code names a connection that was closed under the pool rather than a fault. */
export const isConnectionLoss = (error: unknown): boolean => {
  const code = errorCode(error);
  return code !== undefined && CONNECTION_LOSS_CODES.has(code);
};

/**
 * Attaches the `'error'` listener a long-lived pool must have, and returns the pool.
 *
 * Idempotent in the only sense that matters: it is called once, from the factory, so no pool this
 * repository builds is ever without it. `packages/infrastructure/src/db/pool-errors.test.ts` holds
 * that as a census over `git ls-files`.
 */
export const guardIdleClientErrors = (pool: pg.Pool, logger: Logger = silentLogger): pg.Pool => {
  pool.on('error', (error: Error) => {
    const code = errorCode(error);
    if (isConnectionLoss(error)) {
      logger.warn(
        { err: error, code },
        'an idle pool connection was closed by the server; the pool discarded it',
      );
      return;
    }
    logger.error({ err: error, code }, 'an idle pool connection failed for an unrecognised reason');
  });
  return pool;
};

/**
 * The runtime connection pool and the Drizzle handle built on it (TD-011).
 *
 * Every connection starts as the least-privilege application role. That is what makes
 * technical/03's `REVOKE UPDATE, DELETE` on the append-only tables bite: a privilege check is
 * skipped for a superuser and for the object owner, and the default Compose deployment connects as
 * both. Starting the session as a plain NOLOGIN role drops those, so an accidental `UPDATE events`
 * fails with `permission denied` instead of rewriting the audit log.
 *
 * It is a guard against bugs, not a sandbox: a process that can run arbitrary SQL can still
 * `SET ROLE` back to the login role. An operator who wants the stronger property gives the app a
 * dedicated login role that is a member of `platform_app` and owns nothing.
 */
import { type Logger, silentLogger } from '@platform/application';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { DatabaseConfig } from './config.js';
import { guardIdleClientErrors } from './pool-errors.js';
import * as schema from './schema/index.js';

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseHandle {
  readonly pool: pg.Pool;
  readonly db: Database;
  /**
   * Ends the pool.
   *
   * It does **not** promise that every socket is closed when it resolves: pg-pool fires its end
   * callback as soon as the client list is empty, without waiting for the `client.end()` calls it
   * just made (measured in `pool-errors.ts`). That is why the pool carries an `'error'` listener —
   * a FATAL can still arrive after this resolves, and with no listener it would be thrown.
   */
  readonly close: () => Promise<void>;
}

/** Same shape PostgreSQL stores for an unquoted identifier; anything else is rejected, not escaped. */
const BARE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export const createDatabasePool = (
  config: DatabaseConfig,
  logger: Logger = silentLogger,
): DatabaseHandle => {
  if (config.appRole !== '' && !BARE_IDENTIFIER.test(config.appRole)) {
    throw new Error(`APP_DB_APP_ROLE must be a bare lower-case identifier, got ${config.appRole}`);
  }

  // The role is set in the startup packet rather than by a `SET ROLE` statement on the 'connect'
  // event: the statement version races the borrower's first query (pg warns about it), and a
  // startup GUC also survives `RESET ROLE`, so nothing inside a session can climb back up to the
  // login role. A connection pooler that rejects startup options (pgbouncer in transaction mode)
  // needs APP_DB_APP_ROLE unset and a login role that already has the right grants.
  // `connectionTimeoutMillis` is not tuning: without it `pg` waits for ever for a free connection,
  // so a pool too small for the work in flight hangs silently instead of failing. The dispatcher
  // holds two connections per concurrent dispatch, which makes that mistake easy to make.
  // The `'error'` listener is attached here, at the only place this repository builds a pool, so
  // that "a pool without one" is not a thing a reviewer has to notice. See `pool-errors.ts` for
  // what that event is and why it is reported rather than re-thrown.
  const pool = guardIdleClientErrors(
    new pg.Pool({
      connectionString: config.url,
      max: config.poolMax,
      connectionTimeoutMillis: config.connectionTimeoutMs,
      ...(config.appRole === '' ? {} : { options: `-c role=${config.appRole}` }),
    }),
    logger,
  );

  const db = drizzle(pool, { schema });

  return {
    pool,
    db,
    close: async () => {
      await pool.end();
    },
  };
};

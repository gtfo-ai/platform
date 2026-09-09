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
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { DatabaseConfig } from './config.js';
import * as schema from './schema/index.js';

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseHandle {
  readonly pool: pg.Pool;
  readonly db: Database;
  readonly close: () => Promise<void>;
}

/** Same shape PostgreSQL stores for an unquoted identifier; anything else is rejected, not escaped. */
const BARE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export const createDatabasePool = (config: DatabaseConfig): DatabaseHandle => {
  if (config.appRole !== '' && !BARE_IDENTIFIER.test(config.appRole)) {
    throw new Error(`APP_DB_APP_ROLE must be a bare lower-case identifier, got ${config.appRole}`);
  }

  // The role is set in the startup packet rather than by a `SET ROLE` statement on the 'connect'
  // event: the statement version races the borrower's first query (pg warns about it), and a
  // startup GUC also survives `RESET ROLE`, so nothing inside a session can climb back up to the
  // login role. A connection pooler that rejects startup options (pgbouncer in transaction mode)
  // needs APP_DB_APP_ROLE unset and a login role that already has the right grants.
  const pool = new pg.Pool({
    connectionString: config.url,
    max: config.poolMax,
    ...(config.appRole === '' ? {} : { options: `-c role=${config.appRole}` }),
  });

  const db = drizzle(pool, { schema });

  return {
    pool,
    db,
    close: async () => {
      await pool.end();
    },
  };
};

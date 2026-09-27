/**
 * `held_connection_liveness` — whether any process holds an account's inbound connection now
 * (migration 0054, WP-72, PROGRESS backlog 200).
 *
 * Three statements, each its own autocommit on the pool: a renewal is not part of anything else
 * the holder does, and the notify duty reads it in the phase where it holds no transaction. Every
 * instant is `now()` — the database's — on both sides, which is the property the migration's
 * header argues for.
 */
import type { HeldConnectionLiveness } from '@platform/application';
import type { Id } from '@platform/contracts';
import type { SqlExecutor } from '../events/sql.js';

/** A TTL is a positive whole number of milliseconds; anything else is a caller's bug, refused. */
const assertTtl = (ttlMs: number): void => {
  if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
    throw new TypeError(`a liveness TTL must be a positive integer of milliseconds, got ${ttlMs}`);
  }
};

export const createPostgresHeldConnectionLiveness = (sql: SqlExecutor): HeldConnectionLiveness => ({
  renew: async (integrationId: Id, holder: string, ttlMs: number): Promise<void> => {
    assertTtl(ttlMs);
    await sql.query(
      `insert into held_connection_liveness (integration_id, holder, renewed_at, expires_at)
       values ($1, $2, now(), now() + make_interval(secs => $3::double precision / 1000))
       on conflict (integration_id) do update
         set holder = excluded.holder,
             renewed_at = excluded.renewed_at,
             expires_at = excluded.expires_at`,
      [integrationId, holder, ttlMs],
    );
  },
  release: async (integrationId: Id, holder: string): Promise<void> => {
    await sql.query(
      'delete from held_connection_liveness where integration_id = $1 and holder = $2',
      [integrationId, holder],
    );
  },
  isHeld: async (integrationId: Id): Promise<boolean> => {
    const { rows } = await sql.query<{ held: boolean }>(
      `select exists (
         select 1 from held_connection_liveness where integration_id = $1 and expires_at > now()
       ) as held`,
      [integrationId],
    );
    return rows[0]?.held === true;
  },
});

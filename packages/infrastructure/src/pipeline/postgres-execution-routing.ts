/**
 * Where a project's agent runs execute, and who can claim them now — on PostgreSQL (migration
 * 0097; WP-278, TD-031 decision 8). The port's docblock (`ExecutionRoutingRepository`,
 * `packages/application/src/pipeline/store.ts`) carries the contract; the migration's header carries
 * why the settings are a table and why claimant liveness is a row.
 *
 * - **Settings** are read as stored; a row the table's checks admitted is a valid
 *   `ExecutionSettings`, so nothing is defaulted here — no row is `null`, and the caller applies
 *   TD-031 §8's defaults.
 * - **An online assignee** (TD-031 §8): a worker of the user that is `active`, not paused (or paused
 *   until a past instant), seen in the last {@link ASSIGNEE_ONLINE_SECONDS} on the database's clock,
 *   and the user's **effective** project role — the higher of the organisation role and a project
 *   membership, `rbac.ts`'s rule (backlog 886) — `member` or above, on an account that is not
 *   disabled (`userMayOwnInProjectSql`, S-26.1: an owner's window is never held for a user the claim
 *   would refuse) — whose **claim scope takes
 *   the project** (`null`, the legacy `'{}'`, or naming it; WP-293, TD-031's claim-scope amendment §5)
 *   and whose **claim policy is not `pick_only`** (S-26.4, TD-031's 2026-11-06 amendment item 6:
 *   `effectiveClaimPolicySql`, so a legacy `'{}'` is still pick only), so a pick-only worker holds no
 *   offer for `assignee_window` for nothing. The domain's `mayHoldHeadStart`. The assignee of a stage
 *   offer is the task's owner (S-26.1); the head start is fixed at offer time and a reassignment does
 *   not re-route an open offer — the old owner's window runs out, and inside it their machine still
 *   claims only what its policy admits. `last_seen_at` is written by every
 *   authenticated worker protocol call (WP-281, `WorkerStore.recordContact`).
 * - **Server claimant liveness**, both halves on the database's clock (`held_connection_liveness`'s
 *   shape, migration 0054): the writer sets `expires_at = now() + ttl`, the reader compares with
 *   `now()`, so two processes whose wall clocks disagree cannot disagree about whether a claimant is
 *   running. A renewal also deletes rows that expired more than a day ago, which bounds the table by
 *   the processes that ran in the last day.
 */
import type { ExecutionRoutingRepository, Transaction } from '@platform/application';
import type { ExecutionMode, ExecutionPreference } from '@platform/contracts';
import { postgresTransaction } from '../events/postgres-unit-of-work.js';
import type { SqlExecutor } from '../events/sql.js';
import { effectiveClaimPolicySql, projectListTakesSql } from './postgres-run-offers.js';
import { userMayOwnInProjectSql } from './running-role.js';

const sqlOf = (tx: Transaction): SqlExecutor => postgresTransaction(tx).client;

/** TD-031 §8: a worker is online when its last heartbeat is younger than this. */
export const ASSIGNEE_ONLINE_SECONDS = 60;

export const createPostgresExecutionRoutingRepository = (): ExecutionRoutingRepository => ({
  settings: async (tx, projectId) => {
    const { rows } = await sqlOf(tx).query<{
      mode: ExecutionMode;
      prefer: ExecutionPreference;
      fallback_after_seconds: number | null;
      assignee_window_seconds: number;
      offer_timeout_seconds: number;
    }>(
      `select mode, prefer, fallback_after_seconds, assignee_window_seconds, offer_timeout_seconds
         from project_execution_settings where project_id = $1`,
      [projectId],
    );
    const row = rows[0];
    return row === undefined
      ? null
      : {
          mode: row.mode,
          prefer: row.prefer,
          fallbackAfterSeconds: row.fallback_after_seconds,
          assigneeWindowSeconds: row.assignee_window_seconds,
          offerTimeoutSeconds: row.offer_timeout_seconds,
        };
  },
  assigneeOnline: async (tx, input) => {
    const { rows } = await sqlOf(tx).query<{ online: boolean }>(
      `select exists (
         select 1
           from workers w
          where w.user_id = $2
            and w.state = 'active'
            and (w.paused_until is null or w.paused_until <= $3::timestamptz)
            and w.manually_paused_at is null
            and ${projectListTakesSql('w', '$1::uuid')}
            and ${effectiveClaimPolicySql('w')} <> 'pick_only'
            and w.last_seen_at > now() - make_interval(secs => $4::float8)
            and ${userMayOwnInProjectSql('w.user_id', '$1::uuid')}
       ) as online`,
      [input.projectId, input.userId, input.now, ASSIGNEE_ONLINE_SECONDS],
    );
    return rows[0]?.online === true;
  },
  serverClaimantRunning: async (tx) => {
    const { rows } = await sqlOf(tx).query<{ running: boolean }>(
      'select exists (select 1 from server_claimants where expires_at > now()) as running',
    );
    return rows[0]?.running === true;
  },
  renewServerClaimant: async (tx, input) => {
    const sql = sqlOf(tx);
    await sql.query(
      `insert into server_claimants (holder, renewed_at, expires_at)
       values ($1, now(), now() + make_interval(secs => $2::float8))
       on conflict (holder) do update
         set renewed_at = excluded.renewed_at, expires_at = excluded.expires_at`,
      [input.holder, input.ttlMs / 1000],
    );
    await sql.query(`delete from server_claimants where expires_at < now() - interval '1 day'`);
  },
  releaseServerClaimant: async (tx, holder) => {
    await sqlOf(tx).query('delete from server_claimants where holder = $1', [holder]);
  },
});

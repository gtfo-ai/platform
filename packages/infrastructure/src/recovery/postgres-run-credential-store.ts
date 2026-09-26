/**
 * The two reads behind the run-credential recovery row — PROGRESS backlog **155** (WP-77).
 *
 * `packages/application/src/recovery/run-credential.ts` carries the argument: which credential is
 * stranded, why the bound is the audit row the attempt writes, and what the row does not reach.
 * What is here is the SQL, and three things about it are load-bearing.
 *
 * **"Revoked" is `ok` with `revoked: true`, and nothing else.** A `revoke_credential` row that is
 * `failed`, `would_have`, or `ok` with `revoked: false` (the recovery's own `unconfirmed`) does not
 * count as a revocation — the reading WP-76's review round 2 fixed for the teardown path, stated
 * once more here because a query that asked only "is there a revoke row" would count the failure
 * this row exists to repair. The recovery's own row counts **as an attempt** whatever it says, via
 * `payload ->> 'origin'`, which is the bound.
 *
 * **Driven from `runs`, into the audit through `(task_id, created_at)`.** The runs that ended inside
 * the credential's longest lifetime come off `runs_ended_at_idx` (migration 0039); each probes
 * `integration_actions_task_idx` for its own task. `created_at > $endedAfter` on both audit reads is
 * not a guess: a credential still live now was minted after `now - horizon`, which is exactly
 * `endedAfter`, and a revoke comes after its mint — so the bound is correct *and* lets PostgreSQL
 * prune the table's monthly partitions.
 *
 * **The binding that minted must still be the project's git binding.** `revoke_id` is an address on
 * that binding's host; the join is what keeps a re-bound project's old address from being sent to a
 * new server. The residual is stated in the application module.
 */
import type {
  CredentialScope,
  RecoverableRunCredential,
  Transaction,
  UnrevokedRunCredentialStore,
} from '@platform/application';
import type { Id, TaskMode } from '@platform/contracts';
import { postgresTransaction } from '../events/postgres-unit-of-work.js';
import type { SqlExecutor } from '../events/sql.js';

const sqlOf = (tx: Transaction): SqlExecutor => postgresTransaction(tx).client;

/** The statuses a run is live in; everything else is terminal (`run_status`, migration 0002). */
const LIVE_RUN_STATUSES = ['created', 'starting', 'running'];

interface Row extends Record<string, unknown> {
  readonly run_id: string;
  readonly task_id: string;
  readonly project_id: string;
  readonly mode: string;
  readonly integration_id: string;
  readonly revoke_id: string;
  readonly scope: string;
  readonly expires_at: string;
}

/**
 * The predicate both reads share, literally — the pass and the duty's re-validation must ask the
 * same question (the reasoning `postgres-expired-run-store.ts` gives for its own).
 *
 * `$1` the live statuses, `$2` `now`, `$3` `endedAfter`.
 */
const FROM_AND_PREDICATE = `
   from runs r
   join tasks t on t.id = r.task_id
   join integration_actions m
     on m.task_id = r.task_id
    and m.created_at > $3::timestamptz
    and m.action = 'mint_credential'
    and m.status = 'ok'
    and m.payload ->> 'run_id' = r.id::text
    and m.result ->> 'revoke_id' is not null
    and case
          when m.result ->> 'expires_at' ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$'
          then (m.result ->> 'expires_at')::timestamptz > $2::timestamptz
          -- An expiry that is not an instant cannot be compared, and a cast error here would fail
          -- the whole pass — every row of the table, not this one. Unreadable is treated as live:
          -- the revoke is harmless if it is not, and the one attempt still bounds it.
          else true
        end
   join bindings b
     on b.project_id = r.project_id
    and b.integration_id = m.integration_id
   join integrations i
     on i.id = m.integration_id
    and i.type = 'git'
  where r.status <> all($1::run_status[])
    and r.ended_at is not null
    and not exists (
      select 1
        from integration_actions v
       where v.task_id = r.task_id
         and v.created_at > $3::timestamptz
         and v.action = 'revoke_credential'
         and v.payload ->> 'revoke_id' = m.result ->> 'revoke_id'
         and (
           -- "revoked = 'true'" is equivalent today (a non-recovery "ok" revoke row always carries
           -- it, and recovery rows are caught by "origin" below) and is kept as the definition
           -- "runCredentialWrites.revoke" uses, so a later writer cannot make "ok" mean done alone.
           (v.status = 'ok' and v.result ->> 'revoked' = 'true')
           or v.payload ->> 'origin' = 'recovery'
         )
    )`;

const SELECT = `select r.id as run_id, r.task_id, r.project_id, t.mode::text as mode,
                       m.integration_id, m.result ->> 'revoke_id' as revoke_id,
                       m.result ->> 'scope' as scope, m.result ->> 'expires_at' as expires_at`;

const toCredential = (row: Row): RecoverableRunCredential => ({
  runId: row.run_id as Id,
  taskId: row.task_id as Id,
  projectId: row.project_id as Id,
  mode: row.mode as TaskMode,
  integrationId: row.integration_id as Id,
  revokeId: row.revoke_id,
  scope: row.scope as CredentialScope,
  expiresAt: row.expires_at,
});

/**
 * How far back the re-validation looks for the mint, since the duty has no run window of its own.
 * Only a partition-pruning bound — the mint's own `expires_at > now` is the precise cut — so it is
 * generous: a week, against the 48 hours a credential of this build can live.
 */
const REVALIDATION_LOOKBACK_MS = 7 * 24 * 60 * 60_000;

export const createPostgresRunCredentialStore = (): UnrevokedRunCredentialStore => ({
  unrevokedRunCredentials: async (tx, query) => {
    const { rows } = await sqlOf(tx).query<Row>(
      `${SELECT}
       ${FROM_AND_PREDICATE}
          and r.ended_at < $4::timestamptz
          and r.ended_at >= $3::timestamptz
        order by r.ended_at, m.created_at
        limit $5`,
      [LIVE_RUN_STATUSES, query.now, query.endedAfter, query.endedBefore, query.limit],
    );
    return rows.map(toCredential);
  },

  unrevokedRunCredential: async (tx, input) => {
    const { rows } = await sqlOf(tx).query<Row>(
      `${SELECT}
       ${FROM_AND_PREDICATE}
          and r.id = $4
          and m.result ->> 'revoke_id' = $5
        limit 1`,
      [
        LIVE_RUN_STATUSES,
        input.now,
        new Date(Date.parse(input.now) - REVALIDATION_LOOKBACK_MS).toISOString(),
        input.runId,
        input.revokeId,
      ],
    );
    const row = rows[0];
    return row === undefined ? null : toCredential(row);
  },
});

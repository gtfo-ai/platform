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
 * **No binding is asked** (WP-80, TD-028 decision 10). Until WP-80 the read joined `bindings`, so a
 * credential minted through an integration the project had since been unbound from was never found
 * and only reported. The revoke is now built from the **minting** integration, bound or not, which
 * is the host that issued the address by construction — so the join is gone and the refusal it
 * stood for lives in `runCredentialRevocations` (never an integration but the minting one). What is
 * left out is a mint whose **integration row no longer exists**: `unreachableRunCredentials` reads
 * that, the same predicate with the integration negated, and it is **reported**, never revoked.
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
const fromAndPredicate = (integration: 'present' | 'gone'): string => `
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
   ${INTEGRATION_CLAUSE[integration]}
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
    )${integration === 'gone' ? GONE_PREDICATE : ''}`;

/**
 * The one clause the two finding reads differ by (WP-80; WP-73b's split, whose question was the
 * binding until TD-028 decision 10). `present` is the recovery's: the minting integration exists and
 * is a git integration — bound to the project or not. `gone` is the report's: no integration row
 * has that id, which the join cannot say, so it is dropped and a `not exists` joins the `where`.
 */
const INTEGRATION_CLAUSE = {
  present: `join integrations i
     on i.id = m.integration_id
    and i.type = 'git'
    and i.retired_at is null`,
  gone: '',
} as const;

/**
 * A **retired** integration (WP-114) counts as gone: its credentials are destroyed, so no adapter
 * can be built to revoke through it, and the binding repository answers no account for it. The
 * retire is refused while an unexpired, unconfirmed mint of it exists, so a row here is a mint
 * whose provider call was in flight across the retire — reported, never called.
 */
const GONE_PREDICATE = `
    and not exists (
      select 1 from integrations i where i.id = m.integration_id and i.retired_at is null)`;

const FROM_AND_PREDICATE = fromAndPredicate('present');

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

  unreachableRunCredentials: async (tx, query, alreadyReported) => {
    // The pairs already reported are skipped **before** the limit applies (WP-73b review round 1),
    // so each pass reaches the next unreported rows rather than the same oldest `limit` again.
    const { rows } = await sqlOf(tx).query<Row>(
      `${SELECT}
       ${fromAndPredicate('gone')}
          and r.ended_at < $4::timestamptz
          and r.ended_at >= $3::timestamptz
          and (m.integration_id::text, m.result ->> 'revoke_id') not in (
                select * from unnest($6::text[], $7::text[]))
        order by r.ended_at, m.created_at
        limit $5`,
      [
        LIVE_RUN_STATUSES,
        query.now,
        query.endedAfter,
        query.endedBefore,
        query.limit,
        alreadyReported.map((key) => key.integrationId),
        alreadyReported.map((key) => key.revokeId),
      ],
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

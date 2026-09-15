/**
 * The two reads behind the run-lease sweep — PROGRESS backlog **109** (WP-47).
 *
 * `packages/application/src/recovery/run-lease.ts` carries the whole argument: who owns a lease,
 * what a missing heartbeat licenses anybody to conclude, why the bound is **both** the lease and the
 * wall clock, and why the ending needs no attempt mark. What is here is the SQL, and two things
 * about it are load-bearing rather than incidental.
 *
 * **The status set is `('starting','running')`, not `ACTIVE_RUN_STATUSES`.** `created` is in that
 * constant because it holds a slot against `max_parallel_runs`, but the Run aggregate has no
 * `created → failed` edge — `created` is an in-memory pre-state — so a row in it is one this
 * ending cannot express. Nothing in the tree inserts one (both `runs.insert` call sites write the
 * status of a `markRunning` aggregate), so the narrowing costs nothing and stops the sweep from
 * finding a row it would then have to throw over. The partial index
 * `runs_active_idx on runs (status) where status in ('created','starting','running')` still serves
 * it: the predicate is implied by it and the live set is bounded by BD-010's `max_parallel_runs`
 * rather than by the size of the table, which is why migration 0035 added no index of its own.
 *
 * **`claimExpiredRun` takes `for update`, and that is the whole of the negative case.** The pass
 * reads a batch of candidates in one transaction and ends each one in another, so between the two a
 * heartbeat may renew the lease. Re-reading the predicate would not be enough at READ COMMITTED: a
 * heartbeat committing between a `select` and an `update` leaves `status = any(active)` true and the
 * sweep would end a live run. The lock makes the two orders the only two possible: either this
 * transaction wins and the heartbeat's own predicate then fails, or the heartbeat wins and this
 * claim sees the renewed `lease_expires_at` and answers `false`.
 */
import type {
  ExpiredRunLease,
  ExpiredRunQuery,
  ExpiredRunStore,
  Transaction,
} from '@platform/application';
import type { Id, IsoDateTime, Slug } from '@platform/contracts';
import { postgresTransaction } from '../events/postgres-unit-of-work.js';
import type { SqlExecutor } from '../events/sql.js';

const sqlOf = (tx: Transaction): SqlExecutor => postgresTransaction(tx).client;

/** The statuses this ending can express; see the module docblock for why `created` is not one. */
const SWEEPABLE_RUN_STATUSES = ['starting', 'running'];

interface ExpiredRunRow extends Record<string, unknown> {
  readonly id: string;
  readonly task_id: string;
  readonly project_id: string;
  readonly stage: string | null;
  readonly attempt: number;
  readonly lease_owner: string | null;
  readonly lease_expires_at: Date | string | null;
  readonly started_at: Date | string | null;
}

/** `timestamptz` comes back as a `Date` from pg; the port speaks ISO-8601. */
const iso = (value: Date | string | null): IsoDateTime | null =>
  value === null ? null : (new Date(value).toISOString() as IsoDateTime);

/**
 * The double bound, as one `where` fragment both statements share.
 *
 * Shared literally rather than by copy: the pass's read and the ending's claim must ask the **same**
 * question, and two spellings of it is how a sweep starts ending rows its own query would not have
 * returned.
 *
 * `$n` are, in order: the sweepable statuses, the lease cutoff, the `started_at` cutoff.
 */
const EXPIRED_RUN_PREDICATE = `r.status = any($1::run_status[])
   and (
     (r.lease_expires_at is not null and r.lease_expires_at < $2::timestamptz)
     or (
       r.lease_expires_at is null
       and r.started_at is not null
       and r.started_at < $3::timestamptz
     )
   )`;

const boundsOf = (query: ExpiredRunQuery): readonly unknown[] => [
  SWEEPABLE_RUN_STATUSES,
  query.leaseExpiredBefore,
  query.startedBefore,
];

export const createPostgresExpiredRunStore = (): ExpiredRunStore => ({
  expiredRuns: async (tx, query): Promise<readonly ExpiredRunLease[]> => {
    const { rows } = await sqlOf(tx).query<ExpiredRunRow>(
      `select r.id, r.task_id, r.project_id, s.stage, r.attempt, r.lease_owner,
              r.lease_expires_at, r.started_at
         from runs r
         left join task_stages s on s.id = r.task_stage_id
        where ${EXPIRED_RUN_PREDICATE}
        order by r.started_at nulls first
        limit $4`,
      [...boundsOf(query), query.limit],
    );
    return rows.map((row) => ({
      runId: row.id as Id,
      taskId: row.task_id as Id,
      projectId: row.project_id as Id,
      stage: row.stage as Slug | null,
      attempt: row.attempt,
      leaseOwner: row.lease_owner,
      leaseExpiresAt: iso(row.lease_expires_at),
      startedAt: iso(row.started_at),
    }));
  },

  claimExpiredRun: async (tx, input) => {
    const { rows } = await sqlOf(tx).query<{ id: string }>(
      `select r.id
         from runs r
        where ${EXPIRED_RUN_PREDICATE}
          and r.id = $4
          for update`,
      [...boundsOf(input.query), input.runId],
    );
    return rows.length === 1;
  },
});

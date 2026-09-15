/**
 * `StatsStore` on PostgreSQL — `stats_task_delivery` and `stats_event_daily` (migration 0034),
 * WP-41.
 *
 * **This module is the only writer of those two tables**, which is not a claim in prose:
 * `stats-writers.test.ts` is a census over every file git knows about (tracked and untracked,
 * standing rule 85) for an `insert into` or an `update` of either, and expects exactly this file.
 *
 * Every method takes the `Transaction` the application ring passes around and narrows it with
 * `postgresTransaction`, so each row commits with the `handler_executions` claim that says the
 * projector ran (TD-005) — which is what makes the projection exactly-once under a redelivery and
 * under `events/replay.ts` alike, with no unique key doing the work.
 *
 * ## Two upserts, two different answers on conflict, and both are decisions
 *
 * `recordDelivery` is `do nothing`: the **first** merge is the delivery, so a reopened-and-remerged
 * merge request does not move a task between buckets after a reader has seen it there.
 * `addCounter` **adds**, because a counter is the sum of its contributions; the idempotency comes
 * from the claim above rather than from the statement, which is why the port offers no `set`.
 */
import type { StatsStore, Transaction } from '@platform/application';
import { organisationTimezoneOf } from '../cost/postgres-cost-store.js';
import { postgresTransaction } from '../events/postgres-unit-of-work.js';
import type { SqlExecutor } from '../events/sql.js';

const sqlOf = (tx: Transaction): SqlExecutor => postgresTransaction(tx).client;

export const createPostgresStatsStore = (): StatsStore => ({
  organisationTimezone: async (tx, projectId) => organisationTimezoneOf(sqlOf(tx), projectId),

  /**
   * The same predicate `TaskRepository.findByMergeRequest` and the human-time store use —
   * `(mr_ref ->> 'iid')::int` — and the same tie-break, newest task first, so the two projections
   * and the saga can never disagree about which task a merge request belongs to (rule 9).
   */
  taskForMergeRequest: async (tx, subject) => {
    const { rows } = await sqlOf(tx).query<{ id: string }>(
      `select id from tasks
        where project_id = $1 and (mr_ref ->> 'iid')::int = $2
        order by created_at desc limit 1`,
      [subject.projectId, subject.iid],
    );
    return (rows[0]?.id as never) ?? null;
  },

  recordDelivery: async (tx, delivery) => {
    await sqlOf(tx).query(
      `insert into stats_task_delivery (task_id, project_id, merged_at)
       values ($1, $2, $3)
       on conflict (task_id) do nothing`,
      [delivery.taskId, delivery.projectId, delivery.mergedAt],
    );
  },

  addCounter: async (tx, delta) => {
    await sqlOf(tx).query(
      `insert into stats_event_daily (project_id, day, metric, count, total)
       values ($1, $2::date, $3, $4, $5)
       on conflict (project_id, day, metric) do update
         set count = stats_event_daily.count + excluded.count,
             total = stats_event_daily.total + excluded.total,
             updated_at = now()`,
      [delta.projectId, delta.day, delta.metric, delta.count, delta.total],
    );
  },
});

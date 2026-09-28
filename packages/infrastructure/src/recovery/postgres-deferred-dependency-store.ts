/**
 * The deferred-dependency recovery's read and its mark — PROGRESS backlog **240** (WP-84).
 *
 * `packages/application/src/recovery/deferred-dependency.ts` carries the argument: why the newest
 * `task.resumed` is the instant the lost wake-up was owed from, why `active` is the whole state
 * filter, and why the bound is one attempt per resume with no ending.
 *
 * The read is a lateral join onto the task's own stream — `events_stream_idx (stream_type,
 * stream_id, stream_seq)` answers "the newest `task.resumed`" per candidate — and the candidates are
 * narrowed first by `state = 'active'` and a set `deferred_stage`, so a pass costs the tasks that
 * carry a deferral rather than the table.
 *
 * The mark is `dependency_recovery_attempted_at`, this file's column alone (migration 0059; the
 * `tasks` column census pins the owner). It is written with `state = 'active'` in the predicate so
 * a task that stopped between the read and the write is not marked for a resume it has left.
 */
import type {
  DeferredDependencyRecoveryStore,
  StrandedDeferredDependency,
} from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import { postgresTransaction } from '../events/postgres-unit-of-work.js';

interface Row extends Record<string, unknown> {
  readonly task_id: string;
  readonly project_id: string;
  readonly resumed_event_id: string;
  readonly resumed_at: Date | string;
}

export const createPostgresDeferredDependencyStore = (): DeferredDependencyRecoveryStore => ({
  strandedDeferredDependencies: async (tx, query) => {
    const result = await postgresTransaction(tx).client.query<Row>(
      `select t.id as task_id, t.project_id, r.id as resumed_event_id, r.occurred_at as resumed_at
         from tasks t
         cross join lateral (
           select e.id, e.occurred_at
             from events e
            where e.stream_type = 'task' and e.stream_id = t.id and e.type = 'task.resumed'
            order by e.stream_seq desc
            limit 1
         ) r
        where t.state = 'active'
          and t.dependencies ->> 'deferred_stage' is not null
          and r.occurred_at < $1
          and (t.dependency_recovery_attempted_at is null
               or t.dependency_recovery_attempted_at < r.occurred_at)
        order by r.occurred_at
        limit $2`,
      [query.olderThan, query.limit],
    );
    return result.rows.map(
      (row): StrandedDeferredDependency => ({
        taskId: row.task_id as Id,
        projectId: row.project_id as Id,
        resumedEventId: row.resumed_event_id as Id,
        resumedAt: new Date(row.resumed_at).toISOString() as IsoDateTime,
      }),
    );
  },

  markDeferredDependencyAttempt: async (tx, input) => {
    await postgresTransaction(tx).client.query(
      `update tasks set dependency_recovery_attempted_at = $2 where id = $1 and state = 'active'`,
      [input.taskId, input.at],
    );
  },
});

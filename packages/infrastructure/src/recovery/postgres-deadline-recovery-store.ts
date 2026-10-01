/**
 * The deadline recovery's reads and its one write, over PostgreSQL (WP-56 round 2, PROGRESS
 * backlog 161 and 162; the rules are `packages/application/src/recovery/deadline.ts`').
 *
 * Every read excludes a **finished** task (`done`, `cancelled`): a question a cancelled task left
 * `open` owes nobody an answer, and a query that found it would find it on every pass for ever. The
 * take-over read is the store's `takenOver` rule set-wise: a `paused` task whose newest boundary
 * event (`TAKE_OVER_BOUNDARY_EVENTS`) is `task.taken_over`.
 */
import {
  type DeadlineRecoveryStore,
  TAKE_OVER_BOUNDARY_EVENTS,
  type Transaction,
  type UnremindedAggregate,
  type WaitingAggregate,
} from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import { postgresTransaction } from '../events/postgres-unit-of-work.js';
import type { SqlExecutor } from '../events/sql.js';
import { takeOverLastActivitySql } from '../pipeline/take-over-activity.js';

const sqlOf = (tx: Transaction): SqlExecutor => postgresTransaction(tx).client;

interface WaitingRow extends Record<string, unknown> {
  readonly aggregate: 'question' | 'approval';
  readonly id: string;
  readonly project_id: string;
  readonly task_id: string;
}

const toWaiting = (row: WaitingRow): WaitingAggregate => ({
  aggregate: row.aggregate,
  id: row.id as Id,
  projectId: row.project_id as Id,
  taskId: row.task_id as Id,
});

/** Open questions and pending approvals of an unfinished task, with a predicate on `deadline_at`. */
const waiting = (deadline: string): string => `
  (select 'question' as aggregate, q.id, t.project_id, q.task_id, q.deadline_at
     from questions q join tasks t on t.id = q.task_id
    where q.status = 'open' and t.state not in ('done', 'cancelled') and ${deadline.replaceAll('#', 'q')}
    order by q.deadline_at nulls first, q.id limit $LIMIT)
  union all
  (select 'approval' as aggregate, a.id, t.project_id, a.task_id, a.deadline_at
     from approvals a join tasks t on t.id = a.task_id
    where a.status = 'pending' and t.state not in ('done', 'cancelled') and ${deadline.replaceAll('#', 'a')}
    order by a.deadline_at nulls first, a.id limit $LIMIT)`;

export const createPostgresDeadlineRecoveryStore = (): DeadlineRecoveryStore => ({
  overdue: async (tx, query) => {
    const { rows } = await sqlOf(tx).query<WaitingRow>(
      waiting('#.deadline_at < $1').replaceAll('$LIMIT', '$2'),
      [query.dueBefore, query.limit],
    );
    return rows.map(toWaiting);
  },
  heldTasks: async (tx, query) => {
    // The holder's last activity is `takeOverLastActivitySql`, the expression `tasks.takenOver`
    // uses, so the recovery and the timer compute one instant (WP-44, PROGRESS backlog 167).
    const { rows } = await sqlOf(tx).query<{
      task_id: string;
      taken_at: Date | string;
      last_activity_at: Date | string;
    }>(
      `select t.id as task_id, e.occurred_at as taken_at,
              ${takeOverLastActivitySql('t.id', 'e')} as last_activity_at
         from tasks t
         join lateral (
           select type, occurred_at, actor from events
            where stream_type = 'task' and stream_id = t.id and type = any($1::text[])
            order by stream_seq desc limit 1
         ) e on true
        where t.state = 'paused' and e.type = 'task.taken_over'
        order by e.occurred_at, t.id
        limit $2`,
      [[...TAKE_OVER_BOUNDARY_EVENTS], query.limit],
    );
    return rows.map((row) => ({
      taskId: row.task_id as Id,
      takenAt: new Date(row.taken_at).toISOString() as IsoDateTime,
      lastActivityAt: new Date(row.last_activity_at).toISOString() as IsoDateTime,
    }));
  },
  undated: async (tx, query) => {
    const { rows } = await sqlOf(tx).query<WaitingRow>(
      waiting('#.deadline_at is null').replaceAll('$LIMIT', '$1'),
      [query.limit],
    );
    return rows.map(toWaiting);
  },
  /**
   * The fourth row's read (WP-108, backlog 291): never reminded, still waiting, deadline ahead. The
   * reminder instant itself is the working calendar's and is asked by the caller.
   */
  unreminded: async (tx, query) => {
    const { rows } = await sqlOf(tx).query<{
      aggregate: 'question' | 'approval';
      id: string;
      project_id: string;
      task_id: string;
      since: Date | string;
      deadline_at: Date | string;
    }>(
      `(select 'question' as aggregate, q.id, t.project_id, q.task_id, q.asked_at as since,
               q.deadline_at
          from questions q join tasks t on t.id = q.task_id
         where q.status = 'open' and q.reminders_sent = 0 and t.state not in ('done', 'cancelled')
           and q.deadline_at > $1 and q.asked_at < $2
         order by q.deadline_at, q.id limit $3)
       union all
       (select 'approval' as aggregate, a.id, t.project_id, a.task_id, a.requested_at as since,
               a.deadline_at
          from approvals a join tasks t on t.id = a.task_id
         where a.status = 'pending' and a.reminders_sent = 0 and t.state not in ('done', 'cancelled')
           and a.deadline_at > $1 and a.requested_at < $2
         order by a.deadline_at, a.id limit $3)`,
      [query.deadlineAfter, query.sinceBefore, query.limit],
    );
    return rows.map(
      (row): UnremindedAggregate => ({
        ...toWaiting(row),
        since: new Date(row.since).toISOString() as IsoDateTime,
        deadlineAt: new Date(row.deadline_at).toISOString() as IsoDateTime,
      }),
    );
  },
  backfillDeadline: async (tx, input) => {
    // Conditional on the row still waiting and still undated: that predicate is the whole of what
    // makes the backfill happen once (a second pass, or a concurrent one, writes nothing).
    const result = await sqlOf(tx).query(
      input.aggregate === 'question'
        ? `update questions set deadline_at = $2
            where id = $1 and deadline_at is null and status = 'open'`
        : `update approvals set deadline_at = $2
            where id = $1 and deadline_at is null and status = 'pending'`,
      [input.id, input.deadlineAt],
    );
    return (result.rowCount ?? 0) > 0;
  },
});

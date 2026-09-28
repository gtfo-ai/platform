/**
 * The re-post row's read and its mark — PROGRESS backlog **236** half (2) (WP-84).
 *
 * `packages/application/src/recovery/notification-repost.ts` carries the argument: why the bound is
 * the gauge's own window, why the original duty is re-enqueued rather than a duty of this row's, and
 * what a re-post does not re-check.
 *
 * The read rides `notifications_undelivered_idx` (migration 0023, `where delivered_at is null`), the
 * index the `notifications_undelivered` gauge already reads, so a pass costs the undelivered rows. The
 * mark carries `delivered_at is null` in its predicate: a row the job delivered between the read and
 * the write is not marked, and the re-enqueued duty then finds it delivered and stops.
 */
import type { NotificationRepostStore, UndeliveredNotification } from '@platform/application';
import type { Id, IsoDateTime, NotificationClass } from '@platform/contracts';
import { postgresTransaction } from '../events/postgres-unit-of-work.js';

interface Row extends Record<string, unknown> {
  readonly id: string;
  readonly project_id: string | null;
  readonly task_id: string | null;
  readonly approval_id: string | null;
  readonly question_id: string | null;
  readonly class: string;
  readonly cause_event_id: string;
  readonly created_at: Date | string;
}

export const createPostgresNotificationRepostStore = (): NotificationRepostStore => ({
  undeliveredImmediate: async (tx, query) => {
    const result = await postgresTransaction(tx).client.query<Row>(
      `select id, project_id, task_id, approval_id, question_id, class, cause_event_id, created_at
         from notifications
        where delivered_at is null
          and planned_delivery = 'immediate'
          and digest_day is null
          and repost_attempted_at is null
          and created_at < $1
        order by created_at
        limit $2`,
      [query.before, query.limit],
    );
    return result.rows.map(
      (row): UndeliveredNotification => ({
        id: row.id as Id,
        projectId: row.project_id === null ? null : (row.project_id as Id),
        taskId: row.task_id === null ? null : (row.task_id as Id),
        approvalId: row.approval_id === null ? null : (row.approval_id as Id),
        questionId: row.question_id === null ? null : (row.question_id as Id),
        // The column's own check constraint (migration 0059) holds it to the enum.
        notificationClass: row.class as NotificationClass,
        causeEventId: row.cause_event_id as Id,
        createdAt: new Date(row.created_at).toISOString() as IsoDateTime,
      }),
    );
  },

  withholdRepost: async (tx, input) => {
    await postgresTransaction(tx).client.query(
      `update notifications set delivered_at = $2, delivered_as = 'withheld'
        where id = $1 and delivered_at is null`,
      [input.id, input.at],
    );
  },

  markRepostAttempt: async (tx, input) => {
    await postgresTransaction(tx).client.query(
      'update notifications set repost_attempted_at = $2 where id = $1 and delivered_at is null',
      [input.id, input.at],
    );
  },
});

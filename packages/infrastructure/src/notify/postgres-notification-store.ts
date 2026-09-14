/**
 * `NotificationStore` on PostgreSQL — the `notifications` table of migration 0023 (WP-32).
 *
 * Every method takes the `Transaction` handle the application ring passes around and narrows it
 * with `postgresTransaction`, so a claim and the rows it claims move together and nothing here can
 * open a transaction of its own.
 *
 * ## Three statements worth reading twice
 *
 *  - **`record` is `on conflict do nothing returning id`.** The unique key is
 *    `(project_id, cause_event_id, class)`, so a duplicated wake-up inserts nothing and the caller
 *    is told `false` rather than being handed a second row to deliver. `returning` is what makes
 *    the answer honest: `rowCount` on a conflicting insert is 0 in `pg`, but reading it that way
 *    would also report 0 for a statement that failed to match for another reason, and there is no
 *    other reason here.
 *  - **`claimForDigest` is a single `update … returning`**, not a select followed by an update. Two
 *    ticks that overlapped would otherwise both read the same rows and both post them; the queue's
 *    `exclusive` policy is the first line of defence and this is the one that does not depend on it.
 *    It re-claims a row whose `digest_day` is an *earlier* day and which is still undelivered —
 *    that is a claim a failed day left behind, and the alternative to re-claiming it is a
 *    notification nobody ever sees.
 *  - **`before` is a bound, never `now()`.** The caller passes the instant its tick read, so a
 *    retry of the same job claims the same set: a row created while the first attempt was posting
 *    belongs to the next digest rather than to a message that has already gone out.
 *  - **A row planned `immediate` is held to the caller's *second*, older bound.** Such a row is
 *    undelivered either because its delivery failed or because it is happening right now — the row
 *    cannot tell the two apart, and claiming the second kind posts the notification twice. The
 *    `case` in `claimForDigest` is that bound; the port's docblock has the argument, and the
 *    residual it leaves (a delivery still in flight after the caller's grace) is stated there.
 */
import type {
  NotificationEntry,
  NotificationStore,
  StoredNotification,
  Transaction,
} from '@platform/application';
import type { Id, IsoDateTime, NotificationClass, TaskMode } from '@platform/contracts';
import type { NotificationDelivery } from '@platform/domain';
import { postgresTransaction } from '../events/postgres-unit-of-work.js';
import type { SqlExecutor } from '../events/sql.js';

const sqlOf = (tx: Transaction): SqlExecutor => postgresTransaction(tx).client;

const iso = (value: Date | string | null): IsoDateTime | null =>
  value === null ? null : (new Date(value).toISOString() as IsoDateTime);

interface NotificationRow extends Record<string, unknown> {
  id: string;
  project_id: string;
  task_id: string | null;
  class: string;
  cause_event_id: string;
  title: string;
  detail: string | null;
  url: string | null;
  urgent: boolean;
  planned_delivery: string;
  mode: string;
  created_at: Date | string;
  delivered_at: Date | string | null;
  delivered_as: string | null;
  digest_day: Date | string | null;
  redaction_count: number;
}

/**
 * `digest_day` back as `YYYY-MM-DD`, and the conversion is the thing to read twice.
 *
 * `pg` parses a `date` into a **`Date` at the process's local midnight**, so `toISOString()` is the
 * wrong way to render it: in any zone east of UTC that is the *previous* day. Measured — the suite
 * claimed `2026-06-02` and read back `2026-06-01` on a machine in `Europe/Prague`, which is the
 * whole reason this function exists rather than a `.slice(0, 10)` at the call site. The local
 * components are what `pg` put there, so they are what is read back out.
 */
const day = (value: Date | string | null): string | null => {
  if (value === null) {
    return null;
  }
  if (typeof value === 'string') {
    return value.slice(0, 10);
  }
  return `${String(value.getFullYear()).padStart(4, '0')}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
};

const toStored = (row: NotificationRow): StoredNotification => ({
  id: row.id as Id,
  projectId: row.project_id as Id,
  taskId: row.task_id === null ? null : (row.task_id as Id),
  notificationClass: row.class as NotificationClass,
  causeEventId: row.cause_event_id as Id,
  title: row.title,
  detail: row.detail,
  url: row.url,
  urgent: row.urgent,
  plannedDelivery: row.planned_delivery as NotificationDelivery,
  mode: row.mode as TaskMode,
  createdAt: iso(row.created_at) as IsoDateTime,
  deliveredAt: iso(row.delivered_at),
  deliveredAs: row.delivered_as === null ? null : (row.delivered_as as NotificationDelivery),
  digestDay: day(row.digest_day),
  redactionCount: row.redaction_count,
});

export const createPostgresNotificationStore = (): NotificationStore => ({
  record: async (tx: Transaction, entry: NotificationEntry): Promise<boolean> => {
    const { rows } = await sqlOf(tx).query<{ id: string }>(
      `insert into notifications (
         id, project_id, task_id, class, cause_event_id, title, detail, url,
         urgent, planned_delivery, mode, created_at, redaction_count
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       on conflict (project_id, cause_event_id, class) do nothing
       returning id`,
      [
        entry.id,
        entry.projectId,
        entry.taskId,
        entry.notificationClass,
        entry.causeEventId,
        entry.title,
        entry.detail,
        entry.url,
        entry.urgent,
        entry.plannedDelivery,
        entry.mode,
        entry.createdAt,
        entry.redactionCount,
      ],
    );
    return rows.length === 1;
  },

  markDelivered: async (tx, input) => {
    await sqlOf(tx).query(
      'update notifications set delivered_at = $2, delivered_as = $3 where id = $1',
      [input.id, input.at, input.via],
    );
  },

  projectsAwaitingDigest: async (tx, input) => {
    const { rows } = await sqlOf(tx).query<{ project_id: string }>(
      `select project_id
         from notifications
        where delivered_at is null and created_at < $1
        group by project_id
        order by min(created_at)
        limit $2`,
      [input.before, input.limit],
    );
    return rows.map((row) => row.project_id as Id);
  },

  claimForDigest: async (tx, input) => {
    const { rows } = await sqlOf(tx).query<NotificationRow>(
      `update notifications
          set digest_day = $2::date
        where id in (
          select id
            from notifications
           where project_id = $1
             and delivered_at is null
             and created_at < case
                   when planned_delivery = 'immediate' then $5::timestamptz
                   else $3::timestamptz
                 end
             and (digest_day is null or digest_day <= $2::date)
           order by created_at
           limit $4
        )
        returning *`,
      [input.projectId, input.day, input.before, input.limit, input.immediateBefore],
    );
    return rows.map(toStored).sort((left, right) => (left.createdAt < right.createdAt ? -1 : 1));
  },

  markDigested: async (tx, input) => {
    if (input.ids.length === 0) {
      return;
    }
    await sqlOf(tx).query(
      `update notifications
          set delivered_at = $2, delivered_as = 'digest'
        where id = any($1::uuid[])`,
      [[...input.ids], input.at],
    );
  },

  digestDelivered: async (tx, input) => {
    const { rows } = await sqlOf(tx).query<{ exists: boolean }>(
      `select exists (
         select 1 from notifications
          where project_id = $1 and digest_day = $2::date
            and delivered_at is not null and delivered_as = 'digest'
       ) as exists`,
      [input.projectId, input.day],
    );
    return rows[0]?.exists === true;
  },
});

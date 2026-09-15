/**
 * The statistics projections (WP-41, product/19 §10). Mirrors `migrations/0034_statistics.sql`.
 *
 * Two tables and no more, for the reason that migration states: a fact that is already a row is
 * read where it lives, and only a fact that exists solely in the event log gets a projection.
 */
import {
  bigint,
  date,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/** One row per task whose merge request merged, at merge time. */
export const statsTaskDelivery = pgTable('stats_task_delivery', {
  taskId: uuid('task_id').primaryKey(),
  projectId: uuid('project_id').notNull(),
  mergedAt: timestamp('merged_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Daily counters folded from the four metric events nothing else reads.
 *
 * `count` is how many events contributed; `total` is the quantity they summed. `numeric` comes back
 * from `pg` as a **string**, which every reader here converts once — the same care
 * `human_time_entries.minutes` needs.
 */
export const statsEventDaily = pgTable(
  'stats_event_daily',
  {
    projectId: uuid('project_id').notNull(),
    day: date('day').notNull(),
    metric: text('metric').notNull(),
    count: bigint('count', { mode: 'number' }).notNull().default(0),
    total: numeric('total', { precision: 18, scale: 6 }).notNull().default('0'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.day, table.metric] })],
);

export type StatsTaskDeliveryRow = typeof statsTaskDelivery.$inferSelect;
export type StatsEventDailyRow = typeof statsEventDaily.$inferSelect;

/**
 * The migrator's own tables. Readable by the application role, never writable by it.
 */
import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/** Applied migrations, one row per SQL file (TD-019). Created by the migrator, not by a file. */
export const platformMigrations = pgTable('platform_migrations', {
  name: text('name').primaryKey(),
  checksum: text('checksum').notNull(),
  appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),
  durationMs: integer('duration_ms').notNull(),
});

/** What the application role may do to a table. */
export type AppAccess = 'read_write' | 'append_only' | 'read_only';

/**
 * Storage policy per table: what the application role may do to it, whether it is range-partitioned
 * and on which column, and its retention window (technical/03).
 *
 * `retention_days` is the bound on `platform_drop_expired_partitions`, so the application role has
 * SELECT here and nothing else; the migrate entrypoint writes it.
 */
export const platformTablePolicy = pgTable('platform_table_policy', {
  tableName: text('table_name').primaryKey(),
  appAccess: text('app_access').$type<AppAccess>().notNull().default('read_write'),
  partitionColumn: text('partition_column'),
  retentionScope: text('retention_scope'),
  retentionDays: integer('retention_days'),
});

export type PlatformMigration = typeof platformMigrations.$inferSelect;
export type PlatformTablePolicy = typeof platformTablePolicy.$inferSelect;

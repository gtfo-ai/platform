/**
 * Where a project's agent runs execute, and whether the instance has a server claimant (migration
 * 0097, WP-278, TD-031 decision 8). The DDL is authoritative and the parity test enforces it; the
 * migration's header carries the reasoning (why the database and never `.agentic/config.yml`, why
 * seconds, why a liveness row rather than a process's own configuration).
 */
import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** One row per project an administrator configured; no row is TD-031 §8's defaults. */
export const projectExecutionSettings = pgTable('project_execution_settings', {
  projectId: uuid('project_id').primaryKey(),
  mode: text('mode').$type<'server_only' | 'workers_only' | 'hybrid'>().notNull().default('hybrid'),
  prefer: text('prefer').$type<'server' | 'workers'>().notNull().default('server'),
  /** `null` is the default for `prefer`. */
  fallbackAfterSeconds: integer('fallback_after_seconds'),
  assigneeWindowSeconds: integer('assignee_window_seconds').notNull().default(120),
  offerTimeoutSeconds: integer('offer_timeout_seconds').notNull().default(86400),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** One row per process running the server claimant, fresh while `expires_at > now()`. */
export const serverClaimants = pgTable('server_claimants', {
  holder: text('holder').primaryKey(),
  renewedAt: timestamp('renewed_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export type ProjectExecutionSettingsRow = typeof projectExecutionSettings.$inferSelect;

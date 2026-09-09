/**
 * Event log, dispatch bookkeeping and the webhook inbox (technical/03, TD-005).
 * Mirrors `migrations/0005_events.sql`.
 */
import type { Actor, JsonObject } from '@platform/contracts';
import { sql } from 'drizzle-orm';
import {
  bigint,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { xid8 } from './columns.js';

export const events = pgTable(
  'events',
  {
    position: bigint('position', { mode: 'number' }).generatedAlwaysAsIdentity(),
    streamType: text('stream_type').notNull(),
    streamId: uuid('stream_id').notNull(),
    streamSeq: integer('stream_seq').notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<JsonObject>().notNull(),
    actor: jsonb('actor').$type<Actor>().notNull(),
    causeEventPosition: bigint('cause_event_position', { mode: 'number' }),
    correlationId: uuid('correlation_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    xactId: xid8('xact_id').notNull().default(sql`pg_current_xact_id()`),
  },
  (table) => [primaryKey({ columns: [table.occurredAt, table.position] })],
);

/**
 * Enforces `UNIQUE(stream_type, stream_id, stream_seq)` globally, which a partitioned `events`
 * table cannot express itself. Maintained by the `events_stream_seq_guard` trigger, which takes
 * this row's lock as it upserts, so appends to one stream serialise on their own. Read-only for
 * the application role: `SELECT … FOR UPDATE` here fails with 42501, so TD-005's pessimistic
 * aggregate load must lock the aggregate's own row (`tasks`, `runs`, …) instead.
 */
export const eventStreams = pgTable(
  'event_streams',
  {
    streamType: text('stream_type').notNull(),
    streamId: uuid('stream_id').notNull(),
    lastSeq: integer('last_seq').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.streamType, table.streamId] })],
);

export const handlerExecutions = pgTable(
  'handler_executions',
  {
    eventPosition: bigint('event_position', { mode: 'number' }).notNull(),
    handler: text('handler').notNull(),
    priority: integer('priority').notNull(),
    status: text('status').notNull(),
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.eventPosition, table.handler] })],
);

/** Webhook dedup and raw audit. Headers and payload are untrusted data (BD-022). */
export const inbox = pgTable(
  'inbox',
  {
    provider: text('provider').notNull(),
    deliveryId: text('delivery_id').notNull(),
    integrationId: uuid('integration_id'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    headers: jsonb('headers').$type<JsonObject>().notNull().default({}),
    payload: jsonb('payload').$type<JsonObject>().notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    error: text('error'),
  },
  (table) => [primaryKey({ columns: [table.provider, table.deliveryId] })],
);

export type EventRow = typeof events.$inferSelect;
export type NewEventRow = typeof events.$inferInsert;
export type HandlerExecution = typeof handlerExecutions.$inferSelect;
export type InboxRow = typeof inbox.$inferSelect;

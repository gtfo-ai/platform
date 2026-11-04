/**
 * Remote workers and the device flow (migration 0096, WP-280, TD-031 decisions 7 and 10c).
 * The DDL is authoritative and the parity test enforces it; the migration's header carries the
 * reasoning (what is hashed, what revocation writes, why the codes are rows).
 */
import { integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** One registered machine, tied to the user who approved its device code. */
export const workers = pgTable('workers', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull(),
  name: text('name').notNull(),
  /** SHA-256 hex of the `wkr_` credential; the credential itself is never stored. */
  credentialHash: text('credential_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  protocolVersion: integer('protocol_version'),
  imageDigests: jsonb('image_digests').$type<readonly string[]>().notNull().default([]),
  state: text('state').$type<'active' | 'revoked'>().notNull().default('active'),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  pausedUntil: timestamp('paused_until', { withTimezone: true }),
  pausedReason: text('paused_reason').$type<'usage_limited'>(),
  concurrency: integer('concurrency').notNull().default(1),
});

/** A device-flow code pair, both halves stored hashed (RFC 8628's shape, TD-031 §10c). */
export const workerDeviceCodes = pgTable('worker_device_codes', {
  id: uuid('id').primaryKey(),
  deviceCodeHash: text('device_code_hash').notNull(),
  userCodeHash: text('user_code_hash').notNull(),
  clientAddress: text('client_address').notNull(),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  intervalSeconds: integer('interval_seconds').notNull(),
  lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  approvedBy: uuid('approved_by'),
  workerName: text('worker_name'),
  deniedAt: timestamp('denied_at', { withTimezone: true }),
  deniedBy: uuid('denied_by'),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  workerId: uuid('worker_id'),
});

export type WorkerRow = typeof workers.$inferSelect;
export type WorkerDeviceCodeRow = typeof workerDeviceCodes.$inferSelect;

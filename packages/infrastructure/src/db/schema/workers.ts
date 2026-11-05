/**
 * Remote workers and the device flow (migration 0096, WP-280, TD-031 decisions 7 and 10c).
 * The DDL is authoritative and the parity test enforces it; the migration's header carries the
 * reasoning (what is hashed, what revocation writes, why the codes are rows).
 */
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

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
  /** The owner's hold from the worker's local page (migration 0099, WP-292); `null` while not held. */
  manuallyPausedAt: timestamp('manually_paused_at', { withTimezone: true }),
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

/**
 * A remote run's mutating platform tool calls (migration 0098, WP-282, TD-031 §10b): a claim before
 * the call, the redacted answer after it, keyed by the run and the SHA-256 of the `tool_use_id`.
 */
export const runToolCalls = pgTable(
  'run_tool_calls',
  {
    runId: uuid('run_id').notNull(),
    toolUseDigest: text('tool_use_digest').notNull(),
    toolName: text('tool_name').notNull(),
    inputDigest: text('input_digest').notNull(),
    leaseEpoch: integer('lease_epoch').notNull(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    result: jsonb('result'),
    isError: boolean('is_error'),
    redactionCount: integer('redaction_count').notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.runId, table.toolUseDigest] })],
);

/** Tool approvals a remote run asked for, decided once and delivered once (migration 0098). */
export const runToolApprovals = pgTable('run_tool_approvals', {
  id: uuid('id').primaryKey(),
  runId: uuid('run_id').notNull(),
  toolUseDigest: text('tool_use_digest').notNull(),
  toolName: text('tool_name').notNull(),
  leaseEpoch: integer('lease_epoch').notNull(),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  decision: text('decision').$type<'allow' | 'deny'>(),
  reason: text('reason'),
  questionId: uuid('question_id'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
});

/** The SDK session mirror of a remote run, one redacted JSONL line per row (migration 0098). */
export const runSessionLines = pgTable(
  'run_session_lines',
  {
    runId: uuid('run_id').notNull(),
    sessionId: text('session_id').notNull(),
    lineNo: integer('line_no').notNull(),
    line: text('line').notNull(),
    redactionCount: integer('redaction_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.runId, table.sessionId, table.lineNo] })],
);

export type WorkerRow = typeof workers.$inferSelect;
export type WorkerDeviceCodeRow = typeof workerDeviceCodes.$inferSelect;

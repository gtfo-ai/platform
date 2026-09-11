/**
 * Cost ledger, price list, rollups and governance (technical/03 § "Cost and governance", BD-011).
 * Mirrors `migrations/0007_cost.sql`.
 */
import type { JsonObject, JsonValue } from '@platform/contracts';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  budgetScopeEnum,
  budgetWindowEnum,
  costModeEnum,
  humanTimeKindEnum,
  integrationDirectionEnum,
} from './enums.js';

const uuidv7 = sql`uuidv7()`;
const usd = (name: string) => numeric(name, { precision: 12, scale: 6 });

/** USD per million tokens; a new price is a new row, the old one gets an `effective_to`. */
export const priceList = pgTable('price_list', {
  id: uuid('id').primaryKey().default(uuidv7),
  modelId: text('model_id').notNull(),
  effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
  effectiveTo: timestamp('effective_to', { withTimezone: true }),
  input: usd('input').notNull(),
  output: usd('output').notNull(),
  cacheWrite5m: usd('cache_write_5m').notNull(),
  cacheWrite1h: usd('cache_write_1h').notNull(),
  cacheRead: usd('cache_read').notNull(),
  batchMultiplier: numeric('batch_multiplier', { precision: 6, scale: 4 }).notNull().default('0.5'),
  fastInput: usd('fast_input'),
  fastOutput: usd('fast_output'),
  sourceUrl: text('source_url').notNull(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Append-only ledger, one row per run per model. */
export const costEntries = pgTable(
  'cost_entries',
  {
    id: uuid('id').notNull().default(uuidv7),
    runId: uuid('run_id').notNull(),
    taskId: uuid('task_id').notNull(),
    projectId: uuid('project_id').notNull(),
    stage: text('stage').notNull(),
    model: text('model').notNull(),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    cacheWrite5m: bigint('cache_write_5m', { mode: 'number' }).notNull().default(0),
    cacheWrite1h: bigint('cache_write_1h', { mode: 'number' }).notNull().default(0),
    cacheRead: bigint('cache_read', { mode: 'number' }).notNull().default(0),
    usd: usd('usd').notNull(),
    isEstimate: boolean('is_estimate').notNull().default(false),
    priceListId: uuid('price_list_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.id, table.createdAt] })],
);

export const costRollupDaily = pgTable(
  'cost_rollup_daily',
  {
    orgId: uuid('org_id').notNull(),
    projectId: uuid('project_id').notNull(),
    template: text('template').notNull(),
    stage: text('stage').notNull(),
    model: text('model').notNull(),
    day: date('day').notNull(),
    mode: costModeEnum('mode').notNull(),
    runs: integer('runs').notNull().default(0),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    cacheWrite5m: bigint('cache_write_5m', { mode: 'number' }).notNull().default(0),
    cacheWrite1h: bigint('cache_write_1h', { mode: 'number' }).notNull().default(0),
    cacheRead: bigint('cache_read', { mode: 'number' }).notNull().default(0),
    usd: numeric('usd', { precision: 14, scale: 6 }).notNull().default('0'),
    wallMs: bigint('wall_ms', { mode: 'number' }).notNull().default(0),
    turns: integer('turns').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.projectId, table.day, table.template, table.stage, table.model, table.mode],
    }),
  ],
);

export const budgets = pgTable('budgets', {
  id: uuid('id').primaryKey().default(uuidv7),
  scope: budgetScopeEnum('scope').notNull(),
  scopeId: uuid('scope_id'),
  window: budgetWindowEnum('window').notNull(),
  limitUsd: usd('limit_usd').notNull(),
  notifyPct: integer('notify_pct').array().notNull().default(sql`'{50,80,100}'`),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Projection over the cost ledger; rebuildable. */
export const budgetWindows = pgTable(
  'budget_windows',
  {
    budgetId: uuid('budget_id').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    spentUsd: numeric('spent_usd', { precision: 14, scale: 6 }).notNull().default('0'),
    notifiedPct: integer('notified_pct').array().notNull().default(sql`'{}'`),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.budgetId, table.windowStart] })],
);

export const humanTimeEntries = pgTable('human_time_entries', {
  id: uuid('id').primaryKey().default(uuidv7),
  taskId: uuid('task_id').notNull(),
  kind: humanTimeKindEnum('kind').notNull(),
  userId: uuid('user_id'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  minutes: numeric('minutes', { precision: 10, scale: 2 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Append-only; payload and result are redacted before they are written (TD-012). */
export const integrationActions = pgTable(
  'integration_actions',
  {
    id: uuid('id').notNull().default(uuidv7),
    integrationId: uuid('integration_id').notNull(),
    /** Added at WP-15b (migration 0013): an action is project-scoped even with no task. */
    projectId: uuid('project_id'),
    taskId: uuid('task_id'),
    direction: integrationDirectionEnum('direction').notNull(),
    action: text('action').notNull(),
    payload: jsonb('payload').$type<JsonObject>().notNull().default({}),
    result: jsonb('result').$type<JsonObject>(),
    status: text('status').notNull(),
    durationMs: integer('duration_ms'),
    /**
     * TD-012's replacement count, and **no `.default()`** — migration 0013 drops the database
     * default it needed to add the column, so an insert that omits this is refused rather than
     * recorded as "nothing was redacted" (standing rule 18).
     */
    redactionCount: integer('redaction_count').notNull(),
    /** Provider attempts including the successful one; 0 for `would_have` and `replayed`. */
    attempts: integer('attempts').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.id, table.createdAt] })],
);

/**
 * The `IdempotencyStore` port's table (WP-15b, migration 0013).
 *
 * `storageKey` is `idempotencyStorageKey(scope)` from `@platform/application`; `result` is the
 * redacted remembered result and is `not null`, because a stored JSON `null` is a legitimate value
 * and "never seen" is the absence of the row.
 */
export const integrationIdempotency = pgTable('integration_idempotency', {
  storageKey: text('storage_key').primaryKey(),
  integrationId: uuid('integration_id').notNull(),
  action: text('action').notNull(),
  result: jsonb('result').$type<JsonValue>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type PriceListRow = typeof priceList.$inferSelect;
export type CostEntry = typeof costEntries.$inferSelect;
export type CostRollupDaily = typeof costRollupDaily.$inferSelect;
export type Budget = typeof budgets.$inferSelect;
export type BudgetWindowRow = typeof budgetWindows.$inferSelect;
export type IntegrationAction = typeof integrationActions.$inferSelect;
export type IntegrationIdempotencyRow = typeof integrationIdempotency.$inferSelect;

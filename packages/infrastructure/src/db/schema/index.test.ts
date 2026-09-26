/**
 * Structural checks on the Drizzle schema that need no database. The column-by-column comparison
 * against the migrated database lives in the `integration` tier
 * (`test/integration/db/schema-parity.integration.test.ts`).
 */
import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schema from './index.js';

const tables = (Object.values(schema) as unknown[]).filter((value): value is PgTable =>
  is(value, PgTable),
);

describe('Drizzle schema', () => {
  it('declares the tables technical/03 specifies', () => {
    // 45 from technical/03 (WP-03), plus `event_dispatch`, the dispatch queue TD-005 needs
    // (WP-04), plus `accounts` and `verifications`, the two tables Better Auth needs that
    // technical/03 does not name (TD-022, migration 0011, WP-06), plus
    // `integration_idempotency`, the `IdempotencyStore` port's table (migration 0013, WP-15b),
    // plus `kb_health_reports`, which technical/07 § "Librarian pipeline" names and no migration
    // had created (migration 0018, WP-18b), plus `notifications`, the chat outbox product/18:33's
    // digest and quiet hours need and technical/03 did not name until WP-32 amended it
    // (migration 0023), plus `task_asks`, the ask-the-task thread product/10:57 asks for and
    // which has no home anywhere else — `questions` is a *stage's* request for human input
    // (technical/02:24), the opposite direction (migration 0024, WP-31), plus `shadow_batches`
    // and `shadow_batch_tickets` — the set of tickets somebody selected on one day and what each
    // was compared against, which product/19 §13's *"aggregate report per shadow batch"* needs and
    // which `shadow_reports` (a row per task) cannot express (migration 0029, WP-34), plus
    // `history_bootstrap_batches` and `history_bootstrap_chunks` — the history bootstrap's
    // selection and its per-run chunks, which product/19 §18's *"batches of ~20 MRs per run"*
    // needs somewhere to live and which no earlier table describes (migration 0030, WP-35), plus
    // `ticket_breakdown_items` — the epic split's queue, one row per proposed child ticket, which
    // `approvals` cannot express because a breakdown is N independent decisions and an approval is
    // one (Q85, migration 0033, WP-40), plus `stats_task_delivery` and `stats_event_daily` — the
    // two facts the statistics endpoint needs whose only record was an event: when a task's merge
    // request merged (no table holds a merge time) and the daily counters of the four metric
    // events nothing read (migration 0034, WP-41), plus `knowledge_curations` — that a curation of
    // one artifact happened, which no table recorded and without which the lost-wake-up recovery
    // cannot tell a curation that proposed nothing from one that never ran (migration 0036, WP-48),
    // plus `kb_index_refusals` — the documents the parser refused at the last index run, which were
    // in no table and therefore in no health report (migration 0041, WP-57, PROGRESS backlog 37).
    expect(tables.length).toBe(61);
  });

  it('names every table and column in snake_case, matching the wire format', () => {
    for (const table of tables) {
      const config = getTableConfig(table);
      expect(config.name, config.name).toMatch(/^[a-z][a-z0-9_]*$/);
      for (const column of config.columns) {
        expect(column.name, `${config.name}.${column.name}`).toMatch(/^[a-z][a-z0-9_]*$/);
      }
    }
  });

  it('has no duplicate table name', () => {
    const names = tables.map((table) => getTableConfig(table).name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives every table a primary key', () => {
    for (const table of tables) {
      const config = getTableConfig(table);
      const hasKey =
        config.primaryKeys.length > 0 || config.columns.some((column) => column.primary);
      // redaction_log is the one log without a key: the same rule may match one message twice.
      expect(hasKey || config.name === 'redaction_log', `${config.name} has a primary key`).toBe(
        true,
      );
    }
  });

  it('stores every timestamp with a time zone', () => {
    for (const table of tables) {
      const config = getTableConfig(table);
      for (const column of config.columns) {
        if (column.getSQLType().startsWith('timestamp')) {
          expect(column.getSQLType(), `${config.name}.${column.name}`).toBe(
            'timestamp with time zone',
          );
        }
      }
    }
  });

  it('keeps money in numeric, never in a float', () => {
    for (const table of tables) {
      const config = getTableConfig(table);
      for (const column of config.columns) {
        if (/usd|cost|limit_usd|input$|output$|cache_/.test(column.name)) {
          expect(
            column.getSQLType().startsWith('numeric') || column.getSQLType() === 'bigint',
            `${config.name}.${column.name} is ${column.getSQLType()}`,
          ).toBe(true);
        }
      }
    }
  });
});

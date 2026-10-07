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
    // in no table and therefore in no health report (migration 0041, WP-57, PROGRESS backlog 37),
    // plus `kb_term_statistics` — Q58's per-project document frequencies, counted at index time
    // so a query term every page contains can be dropped (migration 0042, WP-58), plus
    // `superseded_merge_requests` — the merge request a rework let go of, which after the rework's
    // commit no other row names, and which the recovery pass has to be able to find if the close's
    // wake-up is lost (migration 0043, WP-59 review round 1, PROGRESS backlog 178), plus
    // `project_repository_config` — the last reading of a project's own `.agentic/config.yml` on
    // its default branch, the `repo` layer technical/12's merge names and nothing produced
    // (migration 0050, WP-63, PROGRESS backlog 44), plus `command_idempotency` — the
    // `Idempotency-Key` record a command claims before it performs, which `human_actions` could not
    // be because it is append-only and already holds the duplicates a unique index would refuse
    // (migration 0053, WP-67, PROGRESS backlog 47), plus `held_connection_liveness` — whether any
    // process holds an account's inbound connection now, which no configuration can answer and
    // which the notify duty asks before it posts buttons (migration 0054, WP-72, backlog 200), plus
    // `minted_credential_shapes` — the non-secret shape of every minted run credential, from which
    // every process compiles a redaction rule for a value only its minter held (migration 0057,
    // WP-80, TD-012's M5 amendment, backlog 259), plus `run_commands` — a human command for a live
    // run on its way to the process holding the run's lease, which no table could carry because the
    // register it lands in is per process (migration 0060, WP-85, TD-028 decision 9, backlog 134),
    // plus `chat_threads` — which task a chat thread belongs to, which only an adapter's per-call
    // memory held, so a threaded reply reached nothing (migration 0062, WP-88, backlog 195), plus
    // `discovery_record_recoveries` — the discovery recorder's recovery mark and ending, keyed on
    // the artifact as `knowledge_curations` is (migration 0075, WP-124, backlog 366), plus
    // `expired_job_escalations` — the expired-last-try recovery's once-per-job-id mark, which
    // pg-boss's own table cannot carry because the platform does not write it (migration 0087,
    // WP-156, backlog 421).
    expect(tables.length).toBe(71);
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

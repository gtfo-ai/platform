/**
 * Migration **0085** releases nothing that was held before it (WP-150 criterion (4), ruling (a)).
 *
 * `runs.cli_spawn_requested_at` is the proof a run never asked for its CLI: null is a **measured
 * zero**, held by no cap. A column added as null on every existing row would therefore have
 * released, at upgrade, every run WP-131 holds — runs that may well have spent. So the migration
 * backfills it, and this file holds that from the database's side: three rows written by the
 * schema **before** 0085 — an ended run nobody measured, a measured one, and one that never
 * reached `starting` — and after the upgrade the first is still held at its reservation by the
 * production read (`RunRepository.heldFor`), each row reads as having reached the CLI, and the one
 * with no `started_at` is backfilled to its `created_at`.
 */
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Transaction } from '@platform/application';
import type { Id } from '@platform/contracts';
import { SHIPPED_TEMPLATES } from '@platform/domain';
import { db, pipeline } from '@platform/infrastructure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestClient,
  createTestDatabase,
  type TestDatabase,
  withClient,
} from '../support/postgres.js';

const MIGRATIONS = fileURLToPath(
  new URL('../../../packages/infrastructure/src/db/migrations/', import.meta.url),
);
const MARKER_MIGRATION = '0085_run_cli_spawn_marker.sql';

let database: TestDatabase;
let before: string;
let taskId: Id;
const rows: { unmeasured?: Id; measured?: Id; neverStarted?: Id } = {};

describe('migration 0085: a run held before it is still held after it (WP-150)', () => {
  beforeAll(async () => {
    database = await createTestDatabase('cli_spawn_marker_upgrade');
    before = mkdtempSync(join(tmpdir(), 'wp150-migrations-'));
    for (const file of readdirSync(MIGRATIONS)) {
      if (file.endsWith('.sql') && file < MARKER_MIGRATION) {
        cpSync(join(MIGRATIONS, file), join(before, file));
      }
    }
    await db.runMigrations({
      connectionString: database.connectionString,
      migrationsDirectory: before,
    });
    await withClient(database.connectionString, async (client) => {
      const org = await client.query<{ id: string }>(
        "insert into organizations (name) values ('upgrade') returning id",
      );
      const project = await client.query<{ id: string }>(
        `insert into projects (org_id, key, name, repo_url)
         values ($1, 'api', 'API', 'https://git.example.test/acme/api.git') returning id`,
        [org.rows[0]?.id],
      );
      const projectId = project.rows[0]?.id as Id;
      const task = await client.query<{ id: string }>(
        `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template)
         values ($1, 'fake-jira', 'ACME-1', 'https://jira.example.test/browse/ACME-1', 'feature')
         returning id`,
        [projectId],
      );
      taskId = task.rows[0]?.id as Id;
      const insertRun = async (columns: {
        readonly status: string;
        readonly startedAt: string | null;
        readonly usdReported: number | null;
      }): Promise<Id> => {
        const run = await client.query<{ id: string }>(
          `insert into runs (task_id, project_id, role, model, prompt_version, status,
                             created_at, started_at, ended_at, usd_reported, reserve_usd)
           values ($1, $2, 'developer', 'claude-opus-5', 'developer@1', $3::run_status,
                   '2026-10-01T08:00:00Z', $4::timestamptz,
                   case when $3::text in ('starting', 'running') then null else '2026-10-01T08:30:00Z'::timestamptz end,
                   $5, 15)
           returning id`,
          [taskId, projectId, columns.status, columns.startedAt, columns.usdReported],
        );
        return run.rows[0]?.id as Id;
      };
      // Ended, nobody measured it: WP-131 holds it at its 15 USD reservation.
      rows.unmeasured = await insertRun({
        status: 'timed_out',
        startedAt: '2026-10-01T08:00:01Z',
        usdReported: null,
      });
      rows.measured = await insertRun({
        status: 'completed',
        startedAt: '2026-10-01T08:00:02Z',
        usdReported: 3,
      });
      // A row that never reached `starting`, so it has no `started_at` to backfill from.
      rows.neverStarted = await insertRun({ status: 'failed', startedAt: null, usdReported: null });
      const held = await client.query<{ n: string }>(
        `select count(*) as n from runs where usd_reported is null and usd_estimated is null
           and status not in ('created', 'starting', 'running')`,
      );
      // Two rows are unmeasured before the upgrade.
      expect(Number(held.rows[0]?.n)).toBe(2);
    });
    await db.runMigrations({ connectionString: database.connectionString });
  }, 180_000);

  afterAll(async () => {
    rmSync(before, { recursive: true, force: true });
    await database?.drop();
  });

  it('backfills every existing row, so each reads as having reached its CLI', async () => {
    await withClient(database.connectionString, async (client) => {
      const { rows: read } = await client.query<{
        id: string;
        marker: Date | null;
        started_at: Date | null;
        created_at: Date;
      }>('select id, cli_spawn_requested_at as marker, started_at, created_at from runs');
      expect(read).toHaveLength(3);
      for (const row of read) {
        expect(row.marker).not.toBeNull();
        expect(row.marker?.toISOString()).toBe((row.started_at ?? row.created_at).toISOString());
      }
    });
  });

  /**
   * Review round 1 — the rolling-upgrade window. `migrate` runs before `app` and `runner` are
   * recreated, so the previous release still inserts runs (its insert does not name the column) and
   * starts their CLIs. The column's `default now()` marks such a row, so one that ends unmeasured is
   * held; this release's insert names the column and writes `null` (the shared store suite's
   * WP-150 case reads that back). Canary: the column without its default — this case fails.
   */
  it('marks a run inserted by the previous release, which does not name the column, so it is held', async () => {
    const store = pipeline.createPostgresPipelineStore({ templates: SHIPPED_TEMPLATES });
    const client = createTestClient(database.connectionString);
    await client.connect();
    try {
      const { rows: inserted } = await client.query<{ id: string; marker: Date | null }>(
        `insert into runs (task_id, project_id, role, model, prompt_version, status,
                           terminal_reason, started_at, ended_at, reserve_usd)
         select task_id, project_id, role, model, prompt_version, 'failed'::run_status,
                'shutdown'::run_terminal_reason, now(), now(), 15
           from runs where id = $1
         returning id, cli_spawn_requested_at as marker`,
        [rows.unmeasured],
      );
      expect(inserted[0]?.marker).not.toBeNull();
      const tx = { adapter: 'postgres', client } as unknown as Transaction;
      // The two pre-0085 rows, and the old release's run that ended unmeasured.
      expect(await store.runs.heldFor(tx, taskId, 2)).toEqual({ heldUsd: 45, heldRuns: 3 });
      await client.query('delete from runs where id = $1', [inserted[0]?.id]);
    } finally {
      await client.end();
    }
  });

  it('still holds the unmeasured run at its reservation through the production read', async () => {
    const store = pipeline.createPostgresPipelineStore({ templates: SHIPPED_TEMPLATES });
    const client = createTestClient(database.connectionString);
    await client.connect();
    try {
      const tx = { adapter: 'postgres', client } as unknown as Transaction;
      // Both pre-0085 unmeasured rows stay held: the ended one and the one that never started.
      expect(await store.runs.heldFor(tx, taskId, 2)).toEqual({ heldUsd: 30, heldRuns: 2 });
      expect((await store.runs.load(tx, rows.unmeasured as Id))?.cliSpawnRequestedAt).toBe(
        '2026-10-01T08:00:01.000Z',
      );
      // …and the task's totals still name both as unmeasured, rather than as measured zeros.
      expect((await store.runs.totalsFor(tx, taskId)).unmeasuredRuns).toBe(2);
    } finally {
      await client.end();
    }
  });
});

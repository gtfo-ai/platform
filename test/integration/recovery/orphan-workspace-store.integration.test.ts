/**
 * The orphaned-workspace pass's row read against PostgreSQL 18 (WP-103, PROGRESS backlog 286).
 *
 * The decision is unit-tested in `packages/application/src/recovery/orphan-workspaces.test.ts`; what
 * only a database can say is that the read answers a live row as live, a terminal row with the
 * `ended_at` `runs.finish` wrote, and **no row** for an id that has none — the absence the pass
 * reads as *unknown*, which is one of its two reasons to remove a container. So the pass itself is
 * driven here over the real store and a real unit of work, with the launcher's two verbs as the
 * only double, and the assertion is which ids reached `destroy`.
 */
import { randomUUID } from 'node:crypto';
import type { Transaction } from '@platform/application';
import { runOrphanWorkspaceReap } from '@platform/application';
import type { Id } from '@platform/contracts';
import { FEATURE_TEMPLATE } from '@platform/domain';
import { eventing, recovery as recoveryAdapters } from '@platform/infrastructure';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestClient, createTestPool } from '../support/postgres.js';

let database: MigratedDatabase;
let pool: pg.Pool;
let projectId: string;
let taskId: string;
let attempt = 0;

const store = recoveryAdapters.createPostgresOrphanWorkspaceRunStore();
const NOW = Date.parse('2026-09-30T12:00:00.000Z');

const withTx = async <T>(fn: (tx: Transaction) => Promise<T>): Promise<T> => {
  const client = createTestClient(database.connectionString);
  await client.connect();
  try {
    return await fn({ adapter: 'postgres', client } as unknown as Transaction);
  } finally {
    await client.end();
  }
};

const seedRun = async (status: string, endedAt: string | null): Promise<string> => {
  attempt += 1;
  const stage = await pool.query<{ id: string }>(
    `insert into task_stages (task_id, stage, attempt, state)
     values ($1, 'implementation', $2, 'running') returning id`,
    [taskId, attempt],
  );
  const inserted = await pool.query<{ id: string }>(
    `insert into runs (task_id, task_stage_id, project_id, role, model, effort, prompt_version,
                       attempt, status, started_at, ended_at)
     values ($1, $2, $3, 'developer', 'claude-opus-5', 'high', 'feature@1+developer',
             $4, $5::run_status, '2026-09-30T10:00:00.000Z', $6::timestamptz) returning id`,
    [taskId, stage.rows[0]?.id, projectId, attempt, status, endedAt],
  );
  return inserted.rows[0]?.id as string;
};

beforeAll(async () => {
  database = await createMigratedDatabase('orphan-workspaces');
  pool = createTestPool(database.connectionString, { max: 4 });
  const org = await pool.query<{ id: string }>(
    "insert into organizations (name) values ('orphans') returning id",
  );
  const project = await pool.query<{ id: string }>(
    `insert into projects (org_id, key, name, repo_url)
     values ($1, 'orphans', 'Orphans', 'https://git.example.test/acme/orphans.git') returning id`,
    [org.rows[0]?.id],
  );
  projectId = project.rows[0]?.id as string;
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

beforeEach(async () => {
  attempt = 0;
  await pool.query('delete from runs');
  await pool.query('delete from tasks');
  const task = await pool.query<{ id: string }>(
    `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, state,
                        current_stage, template_snapshot)
     values ($1, 'fake-jira', 'ACME-1', 'https://jira.example.test/browse/ACME-1', 'feature',
             'active', 'implementation', $2::jsonb) returning id`,
    [projectId, JSON.stringify(FEATURE_TEMPLATE)],
  );
  taskId = task.rows[0]?.id as string;
});

describe('the orphaned-workspace row read (WP-103)', () => {
  it('answers a live row, a terminal row with its ended_at, and nothing for an id with no row', async () => {
    const live = await seedRun('running', null);
    const ended = await seedRun('failed', '2026-09-30T11:00:00.000Z');
    const unknown = randomUUID();
    const states = await withTx(async (tx) => store.runStates(tx, [live, ended, unknown] as Id[]));
    expect([...states].sort((a, b) => a.runId.localeCompare(b.runId))).toEqual(
      [
        { runId: live, status: 'running', endedAt: null },
        { runId: ended, status: 'failed', endedAt: '2026-09-30T11:00:00.000Z' },
      ].sort((a, b) => a.runId.localeCompare(b.runId)),
    );
    expect(await withTx(async (tx) => store.runStates(tx, []))).toEqual([]);
  });

  it('drives the pass: the ended and the unknown container go, the live one stays (criterion 2)', async () => {
    const live = await seedRun('running', null);
    const ended = await seedRun('cancelled', '2026-09-30T11:00:00.000Z');
    const endedJustNow = await seedRun('completed', '2026-09-30T11:59:30.000Z');
    const unknown = randomUUID();
    const old = '2026-09-30T09:00:00.000Z';
    const destroyed: string[] = [];
    const report = await runOrphanWorkspaceReap({
      inventory: {
        list: async () =>
          [live, ended, endedJustNow, unknown].map((runId) => ({
            runId,
            createdAt: old,
            running: true,
          })),
        destroy: async (runId) => {
          destroyed.push(runId);
          return { found: true };
        },
      },
      store,
      unitOfWork: new eventing.PostgresUnitOfWork({ pool }),
      clock: { now: () => NOW },
      graceMs: 60_000,
    });
    expect(destroyed).toEqual([ended, unknown]);
    expect(report.reaped).toEqual({ terminal: 1, unknown: 1 });
    expect(report.kept.run_live).toBe(1);
    expect(report.kept.ended_within_grace).toBe(1);
  });
});

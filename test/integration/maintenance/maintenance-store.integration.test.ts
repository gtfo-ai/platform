/**
 * The maintenance scheduler's three reads, against a real PostgreSQL 18 (WP-36).
 *
 * The unit tier drives the scheduler through a double, so **every one of these queries is
 * unexercised there** — which is the tier split this file exists for: the predicate that decides
 * what the dedicated budget counts, the jsonb walk over `tasks.dependencies`, and the ordering that
 * decides which hygiene report is "the latest" are all SQL and nothing else.
 *
 * The one that matters most is `maintenanceSpendSince`'s **predicate**. It is the one thing WP-36
 * had to decide rather than copy from WP-34, and its whole value is what it *excludes*: a `chore`
 * ticket a human filed runs on the same template and must not be charged to the maintenance cap, so
 * a query that counted it would stop the scheduler for work maintenance never did.
 */
import type { Transaction } from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import { maintenance as maintenanceAdapters } from '@platform/infrastructure';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

let database: MigratedDatabase;
let pool: pg.Pool;
let projectId: string;

const store = new maintenanceAdapters.PostgresMaintenanceStore();

const withTx = async <T>(fn: (tx: Transaction) => Promise<T>): Promise<T> => {
  const client = new pg.Client({ connectionString: database.connectionString });
  await client.connect();
  try {
    return await fn({ adapter: 'postgres', client } as unknown as Transaction);
  } finally {
    await client.end();
  }
};

/** One task, with whatever reference and dependency record the case needs. */
const seedTask = async (input: {
  readonly ticketProvider: string;
  readonly ticketKey: string;
  readonly dependencies?: unknown;
}): Promise<string> => {
  const task = await pool.query<{ id: string }>(
    `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, mode, dependencies)
     values ($1, $2, $3, 'https://example.test/' || $3, 'chore', 'normal', $4)
     returning id`,
    [projectId, input.ticketProvider, input.ticketKey, JSON.stringify(input.dependencies ?? null)],
  );
  return task.rows[0]?.id as string;
};

const seedSpend = async (taskId: string, usd: number, at: string): Promise<void> => {
  const run = await pool.query<{ id: string }>(
    `insert into runs (task_id, project_id, role, model, prompt_version)
     values ($1, $2, 'developer', 'claude-opus-5', 'developer@1') returning id`,
    [taskId, projectId],
  );
  await pool.query(
    `insert into cost_entries (run_id, task_id, project_id, stage, model, usd, created_at)
     values ($1, $2, $3, 'implementation', 'claude-opus-5', $4, $5)`,
    [run.rows[0]?.id, taskId, projectId, usd, at],
  );
};

const dependency = (input: {
  readonly name: string;
  readonly status: string;
  readonly deprecated: boolean | null;
  readonly lastPublishedAt: string | null;
}) => ({
  head_sha: null,
  decision: 'allow',
  added: [
    {
      ecosystem: 'npm',
      name: input.name,
      from: 'manifest',
      path: 'package.json',
      policy: 'allow',
      allowlisted: false,
      metadata: {
        status: input.status,
        license: 'MIT',
        last_published_at: input.lastPublishedAt,
        deprecated: input.deprecated,
        source_url: null,
      },
    },
  ],
  unread: [],
  truncated: false,
  question_id: null,
  checked_at: '2026-09-01T00:00:00.000Z',
});

beforeAll(async () => {
  database = await createMigratedDatabase('maintenance');
  pool = createTestPool(database.connectionString, { max: 4 });
  const org = await pool.query<{ id: string }>(
    "insert into organizations (name) values ('maintenance') returning id",
  );
  const project = await pool.query<{ id: string }>(
    `insert into projects (org_id, key, name, repo_url)
     values ($1, 'maint', 'Maintenance', 'https://git.example.test/acme/maint.git')
     returning id`,
    [org.rows[0]?.id],
  );
  projectId = project.rows[0]?.id as string;
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

describe('what the dedicated budget counts', () => {
  it('sums the chores the scheduler created, and excludes a chore ticket a human filed', async () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 60_000).toISOString();
    // `cost_entries` is monthly-partitioned and refuses a row outside the current and previous
    // month, so every instant here is a small offset from now (the shadow store's own lesson).
    const older = new Date(now.getTime() - 3 * 24 * 60 * 60_000).toISOString();

    const scheduled = await seedTask({
      ticketProvider: 'platform',
      ticketKey: 'chore!kb-2026-W38',
    });
    const alsoScheduled = await seedTask({
      ticketProvider: 'platform',
      ticketKey: 'chore!deps-2026-W38',
    });
    // A `chore` **ticket**, on the same template, filed by a person. The predicate this test exists
    // for is the one that keeps their delivery out of the maintenance cap.
    const human = await seedTask({ ticketProvider: 'jira', ticketKey: 'ACME-77' });
    // …and another task the platform created for a different feature, so "platform-issued" alone is
    // not enough either.
    const review = await seedTask({ ticketProvider: 'platform', ticketKey: 'mr!7' });

    await seedSpend(scheduled, 3, recent);
    await seedSpend(human, 100, recent);
    await seedSpend(review, 40, recent);
    await seedSpend(alsoScheduled, 7, older);

    await withTx(async (tx) => {
      const since = new Date(now.getTime() - 24 * 60 * 60_000).toISOString() as IsoDateTime;
      expect(await store.maintenanceSpendSince(tx, projectId as Id, since)).toBe(3);
      // The other direction: widen the window and the older chore joins in, which is what makes the
      // figure above a window rather than a coincidence (standing rule 42).
      const wide = new Date(now.getTime() - 7 * 24 * 60 * 60_000).toISOString() as IsoDateTime;
      expect(await store.maintenanceSpendSince(tx, projectId as Id, wide)).toBe(10);
    });
  });
});

describe('the knowledge hygiene report a kb chore is briefed from', () => {
  it('answers null before the nightly pass has ever run, and the newest row afterwards', async () => {
    await withTx(async (tx) => {
      expect(await store.latestKbHygiene(tx, projectId as Id)).toBeNull();
    });

    const insert = async (documents: number, at: string, detail: string): Promise<void> => {
      await pool.query(
        `insert into kb_health_reports (project_id, commit_sha, documents, findings, source, created_at)
         values ($1, $2, $3, $4::jsonb, 'hygiene', $5)`,
        [
          projectId,
          'a'.repeat(40),
          documents,
          JSON.stringify([{ kind: 'expired', path: 'lessons/old.md', detail }]),
          at,
        ],
      );
    };
    await insert(3, '2026-09-14T03:15:00.000Z', 'the older pass');
    await insert(9, '2026-09-15T03:15:00.000Z', 'the newer pass');

    await withTx(async (tx) => {
      const report = await store.latestKbHygiene(tx, projectId as Id);
      expect(report?.documents).toBe(9);
      expect(report?.findings).toEqual([
        { kind: 'expired', path: 'lessons/old.md', detail: 'the newer pass' },
      ]);
      expect(report?.commitSha).toBe('a'.repeat(40));
    });
  });
});

describe('the packages a deps chore is briefed from', () => {
  it('reports deprecated and long-unreleased packages, and never one nobody looked up', async () => {
    await seedTask({
      ticketProvider: 'jira',
      ticketKey: 'ACME-80',
      dependencies: dependency({
        name: 'left-pad',
        status: 'checked',
        deprecated: true,
        lastPublishedAt: '2026-08-01T00:00:00.000Z',
      }),
    });
    await seedTask({
      ticketProvider: 'jira',
      ticketKey: 'ACME-81',
      dependencies: dependency({
        name: 'ancient',
        status: 'checked',
        deprecated: false,
        lastPublishedAt: '2019-01-01T00:00:00.000Z',
      }),
    });
    // The shipped state of a build whose operator declared no registry host: the gate recorded the
    // package and asked nobody. Reporting it would publish a non-answer as a finding (rule 16).
    await seedTask({
      ticketProvider: 'jira',
      ticketKey: 'ACME-82',
      dependencies: dependency({
        name: 'unchecked',
        status: 'not_checked',
        deprecated: null,
        lastPublishedAt: null,
      }),
    });
    // A package the registry answered for and had nothing to say against.
    await seedTask({
      ticketProvider: 'jira',
      ticketKey: 'ACME-83',
      dependencies: dependency({
        name: 'healthy',
        status: 'checked',
        deprecated: false,
        lastPublishedAt: new Date().toISOString(),
      }),
    });

    await withTx(async (tx) => {
      const stale = await store.staleDependencies(tx, projectId as Id, {
        unreleasedSince: '2025-09-15T00:00:00.000Z' as IsoDateTime,
        limit: 25,
      });
      expect(stale.map((entry) => entry.name).sort()).toEqual(['ancient', 'left-pad']);
      expect(stale.find((entry) => entry.name === 'left-pad')?.deprecated).toBe(true);
      expect(stale.find((entry) => entry.name === 'ancient')?.lastPublishedAt).toBe(
        '2019-01-01T00:00:00.000Z',
      );
      expect(stale.every((entry) => entry.path === 'package.json')).toBe(true);
    });
  });

  it('answers one row per package, however many tasks added it', async () => {
    for (const key of ['ACME-90', 'ACME-91']) {
      await seedTask({
        ticketProvider: 'jira',
        ticketKey: key,
        dependencies: dependency({
          name: 'duplicated',
          status: 'checked',
          deprecated: true,
          lastPublishedAt: null,
        }),
      });
    }
    await withTx(async (tx) => {
      const stale = await store.staleDependencies(tx, projectId as Id, {
        unreleasedSince: '2025-09-15T00:00:00.000Z' as IsoDateTime,
        limit: 25,
      });
      expect(stale.filter((entry) => entry.name === 'duplicated')).toHaveLength(1);
    });
  });
});

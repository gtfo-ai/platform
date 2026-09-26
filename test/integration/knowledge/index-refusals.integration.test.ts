/**
 * A document the parser refused reaches the health report (WP-57, PROGRESS backlog 37's second half,
 * criterion 4), asserted where the claim lands: a `kb_health_reports` row read back through the
 * endpoint's own projection, after the **production** indexer wrote the refusal through the
 * **production** `PostgresKnowledgeStore` and the **production** nightly pass read it through
 * `PostgresProposalStore`. Nothing here seeds `kb_index_refusals` or `kb_health_reports`.
 *
 * What is doubled is the vault read — `memoryVaultSource` over `FIXTURE_VAULT`, which carries one
 * document whose frontmatter the parser refuses (`FIXTURE_INVALID_PATH`). The git half of a vault
 * read is `git-vault-index.integration.test.ts`'s, and it is not what this criterion is about.
 *
 * The events partition for the fixed clock's month is created by the test, because migrations create
 * the current month and a few ahead, and the clock here is injected rather than read (rule 86).
 */
import type { Jobs } from '@platform/application';
import {
  createKnowledgeIndexer,
  FIXTURE_INVALID_PATH,
  FIXTURE_KNOWLEDGE_DIR,
  FIXTURE_PROJECT_KEY,
  FIXTURE_REPO_PATHS,
  FIXTURE_VAULT,
  memoryVaultSource,
  runKnowledgeHygiene,
  silentLogger,
  vaultSnapshotOf,
} from '@platform/application';
import type { Id } from '@platform/contracts';
import { fixedClock, sequentialIds } from '@platform/domain';
import { db, eventing, knowledge } from '@platform/infrastructure';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findKbHealth } from '../../../apps/server/src/queries/knowledge-queries.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool, withClient } from '../support/postgres.js';

/**
 * In the **future**, and fixed: the event store refuses a back-dated append against the real clock
 * (`assertInPartitionWindow`), so a fixed past date would stop working next month, and a date read
 * from the clock would be rule 86's flake. The month's partition is created below.
 */
const NOW = '2030-03-10T03:15:00.000Z';

let database: MigratedDatabase;
let pool: pg.Pool;
let projectId: Id;

beforeAll(async () => {
  database = await createMigratedDatabase('index-refusals');
  await withClient(database.connectionString, async (client) => {
    const { rows } = await client.query<{ name: string }>(
      `select platform_partition_name('events', '2030-03-01'::date) as name`,
    );
    await client.query(
      `create table if not exists public.${client.escapeIdentifier(rows[0]?.name as string)}
         partition of events for values from ('2030-03-01') to ('2030-04-01')`,
    );
  });
  pool = createTestPool(database.connectionString, { options: '-c role=platform_app', max: 4 });
  const org = await pool.query<{ id: string }>(
    "insert into organizations (name) values ('refusals') returning id",
  );
  const project = await pool.query<{ id: string }>(
    `insert into projects (org_id, key, name, repo_url)
     values ($1, 'demo', 'Demo', 'https://git.example.test/acme/demo.git') returning id`,
    [org.rows[0]?.id],
  );
  projectId = project.rows[0]?.id as Id;
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

/** The pass enqueues an apply only for a project with a decided proposal; this one has none. */
const noJobs = {
  enqueue: async () => {
    throw new Error('the hygiene pass enqueued a job for a project with nothing to apply');
  },
} as unknown as Jobs;

const indexAt = async (commitSha: string, documents: typeof FIXTURE_VAULT) => {
  const unitOfWork = new eventing.PostgresUnitOfWork({ pool });
  const indexer = createKnowledgeIndexer({
    vault: memoryVaultSource({
      status: 'ok',
      snapshot: vaultSnapshotOf(documents, {
        commitSha,
        knowledgeDir: FIXTURE_KNOWLEDGE_DIR,
        repoPaths: FIXTURE_REPO_PATHS,
      }),
    }),
    store: new knowledge.PostgresKnowledgeStore(pool),
    unitOfWork,
    eventStore: new eventing.PostgresEventStore(pool),
    clock: fixedClock(NOW),
    ids: sequentialIds(0x5700),
    logger: silentLogger,
  });
  return indexer.index({
    projectId,
    projectKey: FIXTURE_PROJECT_KEY,
    knowledgeDir: FIXTURE_KNOWLEDGE_DIR,
  });
};

const hygiene = async (start: number, now: string) =>
  runKnowledgeHygiene({
    unitOfWork: new eventing.PostgresUnitOfWork({ pool }),
    proposals: new knowledge.PostgresProposalStore(pool),
    jobs: noJobs,
    clock: fixedClock(now),
    ids: sequentialIds(start),
    projects: async () => [projectId],
  });

describe('a document the parser refused', () => {
  it('is stored by the index run and reported by the nightly pass', async () => {
    const report = await indexAt('f1c7ea4', FIXTURE_VAULT);
    expect(report.status).toBe('indexed');
    expect(report.invalid.map((entry) => entry.path)).toEqual([FIXTURE_INVALID_PATH]);

    const stored = await pool.query<{ path: string; line: number | null; commit_sha: string }>(
      'select path, line, commit_sha from kb_index_refusals where project_id = $1',
      [projectId],
    );
    expect(stored.rows).toEqual([
      { path: FIXTURE_INVALID_PATH, line: report.invalid[0]?.line ?? null, commit_sha: 'f1c7ea4' },
    ]);

    await hygiene(0x5800, NOW);
    const drizzled = drizzle(pool, { schema: db.schema });
    const health = await findKbHealth(drizzled, projectId);
    const invalid = health?.findings.filter((finding) => finding.kind === 'invalid');
    expect(invalid?.map((finding) => finding.path)).toEqual([FIXTURE_INVALID_PATH]);
    expect(invalid?.[0]?.detail).toContain('no context pack includes it');
    expect(invalid?.[0]?.detail).toContain(report.invalid[0]?.reason ?? '');
    // `documents` is the indexed count, which the refused page is not part of.
    expect(health?.documents).toBe(report.documents);
  });

  it('leaves the report when it is fixed at the next commit', async () => {
    // The refused page removed from the vault: the next index run replaces the refusals with none,
    // and the next pass reports no `invalid` finding — the table describes the commit the index is
    // at, not every commit it has ever seen.
    await indexAt(
      'f1c7eb5',
      FIXTURE_VAULT.filter((document) => document.path !== FIXTURE_INVALID_PATH),
    );
    const stored = await pool.query('select 1 from kb_index_refusals where project_id = $1', [
      projectId,
    ]);
    expect(stored.rowCount).toBe(0);

    await hygiene(0x5900, '2030-03-11T03:15:00.000Z');
    const drizzled = drizzle(pool, { schema: db.schema });
    const health = await findKbHealth(drizzled, projectId);
    expect(health?.commit_sha).toBe('f1c7eb5');
    expect(health?.findings.some((finding) => finding.kind === 'invalid')).toBe(false);
  });
});

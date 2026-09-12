/**
 * The Librarian's queues and its nightly pass, against **real pg-boss and a real PostgreSQL** —
 * WP-18b.
 *
 * Two of the three claims here cannot be made anywhere else, and the third is the one that would be
 * easiest to believe without evidence:
 *
 *  - **"singleton per project" is pg-boss's answer, not a double's.** The in-memory adapter is asked
 *    the same questions in `packages/infrastructure/src/jobs/knowledge-librarian.test.ts`; a fake
 *    agreeing with a fake is not evidence (standing rule 1), so the same `enqueueKnowledgeApply`
 *    calls are made against the real queue here.
 *  - **the nightly schedule is one schedule**, however many worker processes register it — asked of
 *    the thing that stores it (`pgboss.schedule`).
 *  - **the hygiene pass writes a report and removes nothing.** The refusal is the half worth having:
 *    an expired page a human wrote is *reported* and is still indexed afterwards, and the pass makes
 *    no provider call at all (it holds no integrations port — see `hygiene.ts`).
 */
import { randomUUID } from 'node:crypto';
import {
  declareKnowledgeApplyQueue,
  declareKnowledgeHygieneQueue,
  enqueueKnowledgeApply,
  JOB_QUEUES,
  KNOWLEDGE_HYGIENE_CRON,
  KNOWLEDGE_HYGIENE_CRON_KEY,
  knowledgeHygieneSchedule,
  runKnowledgeHygiene,
  type StoredKnowledgeProposal,
} from '@platform/application';
import type { Id } from '@platform/contracts';
import {
  eventing as eventingAdapters,
  jobs as jobsAdapters,
  knowledge as knowledgeAdapters,
} from '@platform/infrastructure';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

// pg-boss refuses anything below 500 ms (`attorney.js` § applyPollingInterval).
const POLL_SECONDS = 0.5;
const AT = '2026-09-12T03:15:00.000Z';

let database: MigratedDatabase;
let pool: pg.Pool;
let eventing: ReturnType<typeof eventingAdapters.createEventing>;
let jobsRuntime: ReturnType<typeof jobsAdapters.createPgBossJobs>;
let orgId: string;

const project = async (key: string): Promise<Id> => {
  const inserted = await pool.query<{ id: string }>(
    `insert into projects (org_id, key, name, repo_url, default_branch, knowledge_dir)
     values ($1, $2, 'Demo', 'https://git.example.test/acme/api.git', 'main', '.agentic/knowledge')
     returning id`,
    [orgId, key],
  );
  return inserted.rows[0]?.id as Id;
};

const proposalRow = (
  projectId: Id,
  overrides: Partial<StoredKnowledgeProposal> = {},
): StoredKnowledgeProposal => ({
  id: randomUUID() as Id,
  projectId,
  taskId: null,
  runId: null,
  source: 'task',
  kind: 'technical',
  type: 'lesson',
  targetPath: '.agentic/knowledge/lessons/L-1.md',
  delta: '# a page\n',
  evidence: [],
  significance: 0.5,
  status: 'auto_applied',
  decidedByUserId: null,
  decidedAt: null,
  appliedCommitSha: null,
  createdAt: AT as StoredKnowledgeProposal['createdAt'],
  ...overrides,
});

beforeAll(async () => {
  database = await createMigratedDatabase('librarian');
  pool = createTestPool(database.connectionString, { max: 6 });
  eventing = eventingAdapters.createEventing({
    pool,
    connectionString: database.connectionString,
    config: { maxConcurrency: 1 },
  });
  jobsRuntime = jobsAdapters.createPgBossJobs({
    database: jobsAdapters.asJobsDatabase(pool),
    pollingIntervalSeconds: POLL_SECONDS,
    onError: () => {},
  });
  await jobsRuntime.start();
  await declareKnowledgeApplyQueue(jobsRuntime.jobs);
  await declareKnowledgeHygieneQueue(jobsRuntime.jobs);

  const org = await pool.query<{ id: string }>(
    "insert into organizations (name) values ('librarian') returning id",
  );
  orgId = org.rows[0]?.id as string;
}, 240_000);

afterAll(async () => {
  await jobsRuntime?.stop();
  await eventing?.stop();
  await pool?.end();
  await database?.drop();
});

describe('the knowledge.apply queue, on pg-boss', () => {
  it('folds a burst of decisions for one project and keeps two projects apart', async () => {
    const first = await project(`A${randomUUID().slice(0, 8)}`);
    const second = await project(`B${randomUUID().slice(0, 8)}`);

    const one = await enqueueKnowledgeApply(jobsRuntime.jobs, {
      projectId: first,
      reason: 'auto_apply',
    });
    const two = await enqueueKnowledgeApply(jobsRuntime.jobs, {
      projectId: first,
      reason: 'decision',
    });
    // The key is what makes this the test of the *key* rather than of the policy: with it removed,
    // both projects share pg-boss's null key and the second would be refused (standing rule 35).
    const other = await enqueueKnowledgeApply(jobsRuntime.jobs, {
      projectId: second,
      reason: 'decision',
    });

    expect([one.status, two.status, other.status]).toEqual(['enqueued', 'coalesced', 'enqueued']);
    const { rows } = await pool.query<{ count: number }>(
      `select count(*)::int as count from pgboss.job where name = $1 and state = 'created'`,
      [JOB_QUEUES.knowledgeApply],
    );
    expect(rows[0]?.count).toBe(2);
  });
});

describe('the nightly hygiene schedule, on pg-boss', () => {
  it('is one row however many processes register it, with its zone', async () => {
    for (let process = 0; process < 3; process += 1) {
      await jobsRuntime.jobs.scheduleCron(knowledgeHygieneSchedule('Europe/Prague'));
    }
    const schedules = await jobsRuntime.jobs.listCronSchedules(JOB_QUEUES.knowledgeHygiene);
    expect(schedules).toHaveLength(1);
    expect(schedules[0]?.cron).toBe(KNOWLEDGE_HYGIENE_CRON);
    expect(schedules[0]?.key).toBe(KNOWLEDGE_HYGIENE_CRON_KEY);
    expect(schedules[0]?.timezone).toBe('Europe/Prague');
  });
});

describe('the hygiene pass, over real rows', () => {
  it('reports what it found, asks for the stalled apply, and deletes nothing', async () => {
    const projectId = await project(`H${randomUUID().slice(0, 8)}`);
    const store = new knowledgeAdapters.PostgresProposalStore(pool);

    // A page a **human** wrote, expired a year ago, and one dangling link out of it.
    const document = await pool.query<{ id: string }>(
      `insert into kb_documents (project_id, path, expires, frontmatter, tokens)
       values ($1, '.agentic/knowledge/handbook.md', '2025-01-01'::date, '{"id":"H-1"}'::jsonb, 120)
       returning id`,
      [projectId],
    );
    await pool.query(
      `insert into kb_links (from_document_id, to_path, kind) values ($1, 'lessons/gone.md', 'wikilink')`,
      [document.rows[0]?.id],
    );
    await pool.query(
      `insert into kb_index_state (project_id, commit_sha, fts_built_at) values ($1, 'c0ffee1', now())`,
      [projectId],
    );
    // …and a decision nothing applied, which is the recovery this pass exists for.
    await eventing.unitOfWork.transaction(async (scope) => {
      await store.insert(scope.tx, [
        proposalRow(projectId, {
          status: 'queued',
          decidedAt: AT as StoredKnowledgeProposal['decidedAt'],
          decidedByUserId: null,
        }),
      ]);
    });

    const report = await runKnowledgeHygiene({
      unitOfWork: eventing.unitOfWork,
      proposals: store,
      jobs: jobsRuntime.jobs,
      clock: { now: () => AT as never },
      ids: { next: () => randomUUID() as Id },
      projects: async () => [projectId],
    });

    expect(report.projects).toBe(1);
    expect(report.findings).toBe(2);
    expect(report.reapplied).toBeGreaterThanOrEqual(1);

    const reports = await pool.query<{ documents: number; findings: unknown; commit_sha: string }>(
      'select documents, findings, commit_sha from kb_health_reports where project_id = $1',
      [projectId],
    );
    expect(reports.rows).toHaveLength(1);
    expect(reports.rows[0]?.documents).toBe(1);
    expect(reports.rows[0]?.commit_sha).toBe('c0ffee1');
    const findings = reports.rows[0]?.findings as { kind: string }[];
    expect(findings.map((finding) => finding.kind).sort()).toEqual(['dangling', 'expired']);

    // **The refusal**: the expired page a human wrote is still indexed. A pass that "cleaned up"
    // would pass every assertion above and fail this one (product/05: a page is never deleted by
    // the platform).
    const kept = await pool.query<{ count: number }>(
      'select count(*)::int as count from kb_documents where project_id = $1',
      [projectId],
    );
    expect(kept.rows[0]?.count).toBe(1);
    const links = await pool.query<{ count: number }>(
      'select count(*)::int as count from kb_links where from_document_id = $1',
      [document.rows[0]?.id],
    );
    expect(links.rows[0]?.count).toBe(1);
  });
});

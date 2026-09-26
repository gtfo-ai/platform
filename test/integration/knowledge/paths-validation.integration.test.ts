/**
 * A `paths:`-scoped page, end to end on PostgreSQL — WP-58's share of PROGRESS backlog 170,
 * criterion (4): *"asserted at the boundary with the production planner over the fixture vault"*.
 *
 * Everything that decides is production: the indexer writes the fixture vault — and, since WP-58,
 * the tracked listing of the commit it read — through `PostgresKnowledgeStore`; the **stage
 * planner** is `createStageRunPlanner` with the production `headPaths` shape
 * (`KnowledgeStore.readPathWitnesses`, as `apps/server/src/pipeline.ts` composes it) and the production
 * assembler over the same store; the nightly pass reads the index through `PostgresProposalStore`
 * and the report is read back through the endpoint's own projection. Nothing seeds
 * `kb_index_state.path_witnesses` or `kb_health_reports`.
 *
 * Doubled: the vault read (`memoryVaultSource` over `FIXTURE_VAULT`, whose `FIXTURE_REPO_PATHS`
 * lack `src/legacy/importer.ts` — the one glob in the vault that resolves to nothing), the role
 * prompts and the skill bodies (the planner reads them for digests; `planner.test.ts` covers them).
 */
import type { Jobs, StageRunRequest } from '@platform/application';
import {
  createContextPackAssembler,
  createKnowledgeIndexer,
  createStageRunPlanner,
  FIXTURE_KNOWLEDGE_DIR,
  FIXTURE_PROJECT_KEY,
  FIXTURE_REPO_PATHS,
  FIXTURE_UNVALIDATED_PATH,
  FIXTURE_VAULT,
  memoryVaultSource,
  runKnowledgeHygiene,
  SKILLS_BY_ROLE,
  silentLogger,
  vaultSnapshotOf,
} from '@platform/application';
import { agentRoleSchema, type Id, type IsoDateTime } from '@platform/contracts';
import { fixedClock, type RolePromptDefinition, sequentialIds } from '@platform/domain';
import { db, eventing, knowledge } from '@platform/infrastructure';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findKbHealth } from '../../../apps/server/src/queries/knowledge-queries.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool, withClient } from '../support/postgres.js';

/** In the future and fixed, for the reason `index-refusals.integration.test.ts` gives. */
const NOW = '2030-04-10T03:15:00.000Z';
const SESSION_LESSON = `${FIXTURE_KNOWLEDGE_DIR}/lessons/L-2026-01-04-session-fixtures.md`;

let database: MigratedDatabase;
let pool: pg.Pool;
let projectId: Id;

beforeAll(async () => {
  database = await createMigratedDatabase('paths-validation');
  await withClient(database.connectionString, async (client) => {
    const { rows } = await client.query<{ name: string }>(
      `select platform_partition_name('events', '2030-04-01'::date) as name`,
    );
    await client.query(
      `create table if not exists public.${client.escapeIdentifier(rows[0]?.name as string)}
         partition of events for values from ('2030-04-01') to ('2030-05-01')`,
    );
  });
  pool = createTestPool(database.connectionString, { options: '-c role=platform_app', max: 4 });
  const org = await pool.query<{ id: string }>(
    "insert into organizations (name) values ('paths') returning id",
  );
  const project = await pool.query<{ id: string }>(
    `insert into projects (org_id, key, name, repo_url)
     values ($1, 'demo', 'Demo', 'https://git.example.test/acme/demo.git') returning id`,
    [org.rows[0]?.id],
  );
  projectId = project.rows[0]?.id as Id;

  const report = await createKnowledgeIndexer({
    vault: memoryVaultSource({
      status: 'ok',
      snapshot: vaultSnapshotOf(FIXTURE_VAULT, {
        commitSha: 'a58a58a',
        knowledgeDir: FIXTURE_KNOWLEDGE_DIR,
        repoPaths: FIXTURE_REPO_PATHS,
      }),
    }),
    store: new knowledge.PostgresKnowledgeStore(pool),
    unitOfWork: new eventing.PostgresUnitOfWork({ pool }),
    eventStore: new eventing.PostgresEventStore(pool),
    clock: fixedClock(NOW),
    ids: sequentialIds(0x5800),
    logger: silentLogger,
  }).index({ projectId, projectKey: FIXTURE_PROJECT_KEY, knowledgeDir: FIXTURE_KNOWLEDGE_DIR });
  expect(report.status).toBe('indexed');
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

const prompts = Object.fromEntries(
  agentRoleSchema.options.map((role) => [
    role,
    { role, version: '1', text: `You are the ${role}.` } satisfies RolePromptDefinition,
  ]),
);
const skills = Object.fromEntries(
  [...new Set(Object.values(SKILLS_BY_ROLE).flat())].map((name) => [
    name,
    { name, version: '1', text: `# ${name}\n` },
  ]),
);

/** The Developer stage of a task whose plan names two files — one tracked, one not. */
const implementationRequest = {
  runId: '00000000-0000-4000-8000-0000000058a1',
  stage: {
    id: 'implementation',
    kind: 'agent',
    role: 'developer',
    produces: 'ImplementationNotes',
  },
  attempt: 1,
  task: {
    task: {
      id: '00000000-0000-4000-8000-0000000058a2',
      mode: 'normal',
      template: 'feature',
      ticket: { provider: 'jira', key: 'DEMO-58', url: 'https://jira.example.test/browse/DEMO-58' },
    },
    ticketSnapshot: null,
  },
  artifacts: [
    {
      id: '00000000-0000-4000-8000-0000000058a3',
      type: 'ImplementationPlan',
      version: 1,
      markdown: null,
      data: {
        files_to_change: [
          { path: 'src/api/session.ts', change: 'seed the fixture user first' },
          { path: 'src/legacy/importer.ts', change: 'keep the timestamps' },
        ],
      },
      schemaVersion: '1',
      producedByRunId: null,
    },
  ],
  settings: { config: {} },
  returnFeedback: null,
};

describe('a `paths:` page with the production planner (WP-58, backlog 170)', () => {
  it('stores the witnesses of the indexed commit beside the index', async () => {
    const stored = await new knowledge.PostgresKnowledgeStore(pool).readPathWitnesses(projectId);
    // One witness per resolving glob, never the repository listing (backlog 175).
    expect(stored).toEqual([
      'src/api/session.test.ts',
      'src/api/session.ts',
      'src/billing/invoice.ts',
      'src/billing/tax.ts',
    ]);
  });

  it('admits a page whose glob resolves, by `paths`, and records the other unvalidated', async () => {
    const store = new knowledge.PostgresKnowledgeStore(pool);
    const planner = createStageRunPlanner({
      workspacePath: (taskId) => `/workspaces/${taskId}`,
      prompts: prompts as never,
      skills,
      boundSkills: async () => [],
      nonce: { next: () => '58a58a58a58a58a58a58a58a58a58a58' },
      contextPacks: createContextPackAssembler({ store, logger: silentLogger }),
      headPaths: (id: Id) => store.readPathWitnesses(id),
      clock: { now: () => NOW as IsoDateTime },
    });
    const plan = await planner.plan({
      ...implementationRequest,
      task: {
        ...implementationRequest.task,
        task: { ...implementationRequest.task.task, projectId },
      },
      settings: { ...implementationRequest.settings, projectId },
    } as unknown as StageRunRequest);

    expect(plan.contextPack.tier1.find((entry) => entry.path === SESSION_LESSON)).toMatchObject({
      reason: 'paths',
      score: 1,
      validated: true,
    });
    expect(
      plan.contextPack.tier1.find((entry) => entry.path === FIXTURE_UNVALIDATED_PATH),
    ).toMatchObject({ reason: 'paths', validated: false });
    expect(plan.spec.contextPack.some((entry) => entry.path.includes('legacy-importer'))).toBe(
      false,
    );
  });

  it('flags the unresolvable page in the next health report, and never a resolving one', async () => {
    await runKnowledgeHygiene({
      unitOfWork: new eventing.PostgresUnitOfWork({ pool }),
      proposals: new knowledge.PostgresProposalStore(pool),
      jobs: {
        enqueue: async () => {
          throw new Error('the pass enqueued an apply for a project with nothing to apply');
        },
      } as unknown as Jobs,
      clock: fixedClock(NOW),
      ids: sequentialIds(0x5900),
      projects: async () => [projectId],
    });
    const health = await findKbHealth(drizzle(pool, { schema: db.schema }), projectId);
    const flagged = health?.findings.filter((finding) => finding.kind === 'unresolved_paths');
    expect(flagged?.map((finding) => finding.path)).toEqual([FIXTURE_UNVALIDATED_PATH]);
    expect(flagged?.[0]?.detail).toContain('src/legacy/importer.ts');
    // The negative: the vault's four other `paths:` pages resolve, and none of them is flagged.
    expect(health?.findings.some((finding) => finding.path === SESSION_LESSON)).toBe(false);
  });
});

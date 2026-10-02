/**
 * **A curation the project's settings refused is re-offered until the document parses** — WP-125
 * criterion 2, PROGRESS backlog **356**, against PostgreSQL 18.
 *
 * Before WP-125 a refusal wrote nothing, so the recovery pass read it as a lost wake-up: one
 * re-offer under `knowledge_curations.recovery_attempted_at`, then `abandoned_at` — the task's
 * proposals gone if nobody fixed the document within one recovery interval. Every piece here is the
 * production one except the job queue: the Librarian's own curation (`recordLibrarianProposals`),
 * the **real** project read that parses `projects.config` (`createLibrarianProjectRead`, which throws
 * `ProjectSettingsInvalidError` by name), the real proposal store, the real stranded-work store and
 * the pass (`runStrandedRecovery`), and the count `GET …/config`'s refusal quotes
 * (`countCurationsWaitingOnSettings`). The queue is a recorder: a re-offer is asserted as the job the
 * pass enqueued, and the worker's run of it is the next call in the case.
 *
 * The canary (recorded in PROGRESS under WP-125): with the refusal's `recovery_attempted_at = null`
 * removed from `markCurationRefused`, the pass an ending window later **ends** the curation instead
 * of re-offering it, and the case fails on the second pass's report.
 */
import { randomUUID } from 'node:crypto';
import {
  exactSecretRedactor,
  type Jobs,
  type LibrarianJobOptions,
  recordLibrarianProposals,
  runStrandedRecovery,
  STRANDED_ENDING_AFTER_MS,
  silentLogger,
} from '@platform/application';
import type { Id, IsoDateTime, LibrarianProposalsData } from '@platform/contracts';
import {
  db,
  eventing as eventingAdapters,
  knowledge as knowledgeAdapters,
  recovery as recoveryAdapters,
} from '@platform/infrastructure';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLibrarianProjectRead } from '../../../apps/server/src/knowledge.js';
import { countCurationsWaitingOnSettings } from '../../../apps/server/src/queries/project-queries.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

const GRACE_MS = 60_000;

let database: MigratedDatabase;
let pool: pg.Pool;
let eventing: ReturnType<typeof eventingAdapters.createEventing>;
let orgId: string;

const ARTIFACT_DATA: LibrarianProposalsData = {
  proposals: [
    {
      action: 'add',
      kind: 'technical',
      type: 'lesson',
      target_path: 'lessons/L-2026-10-02-locks.md',
      delta: '# take the lock inside the transaction\n',
      evidence: ['https://git.example.test/acme/api/-/merge_requests/7'],
      significance: 0.4,
      reason: 'nothing in the vault covers it',
    },
  ],
  health: [],
  summary: 'one page',
};

beforeAll(async () => {
  database = await createMigratedDatabase('curation-refusal');
  pool = createTestPool(database.connectionString, { max: 6 });
  eventing = eventingAdapters.createEventing({
    pool,
    connectionString: database.connectionString,
    config: { maxConcurrency: 1 },
  });
  const org = await pool.query<{ id: string }>(
    "insert into organizations (name) values ('curation-refusal') returning id",
  );
  orgId = org.rows[0]?.id as string;
}, 240_000);

afterAll(async () => {
  await eventing?.stop();
  await pool?.end();
  await database?.drop();
});

/** A project whose stored settings carry a key this release does not know, and one finished task. */
const seed = async (): Promise<{ projectId: Id; taskId: Id; artifactId: Id }> => {
  const key = `C${randomUUID().slice(0, 6)}`;
  const project = await pool.query<{ id: string }>(
    `insert into projects (org_id, key, name, repo_url, default_branch, knowledge_dir, config)
     values ($1, $2, 'Refused', 'https://git.example.test/acme/api.git', 'main', '.agentic/knowledge',
             '{"version": 1, "bogus_root_key": true}'::jsonb)
     returning id`,
    [orgId, key],
  );
  const projectId = project.rows[0]?.id as Id;
  const task = await pool.query<{ id: string }>(
    `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, mode, state)
     values ($1, 'jira', $2, 'https://jira.example.test/browse/X-1', 'feature', 'normal', 'done')
     returning id`,
    [projectId, `${key}-1`],
  );
  const taskId = task.rows[0]?.id as Id;
  const artifact = await pool.query<{ id: string }>(
    `insert into artifacts (task_id, type, data, schema_version, created_at, redaction_count)
     values ($1, 'LibrarianProposals', $2::jsonb, '1', now() - interval '10 minutes', 0)
     returning id`,
    [taskId, JSON.stringify(ARTIFACT_DATA)],
  );
  return { projectId, taskId, artifactId: artifact.rows[0]?.id as Id };
};

const recordingJobs = (): { jobs: Jobs; enqueued: { queue: string; data: unknown }[] } => {
  const enqueued: { queue: string; data: unknown }[] = [];
  const jobs = {
    enqueue: async (request: { queue: string; data: unknown }) => {
      enqueued.push({ queue: request.queue, data: request.data });
      return { status: 'enqueued', jobId: randomUUID() };
    },
  } as unknown as Jobs;
  return { jobs, enqueued };
};

const at = (offsetMs: number): IsoDateTime =>
  new Date(Date.now() + offsetMs).toISOString() as IsoDateTime;

describe('a curation the project’s stored settings refused (WP-125, backlog 356)', () => {
  it('is re-offered at the next interval, not ended, and lands once the document parses', async () => {
    const { projectId, taskId, artifactId } = await seed();
    const { jobs, enqueued } = recordingJobs();
    const librarian: LibrarianJobOptions = {
      unitOfWork: eventing.unitOfWork,
      eventStore: eventing.store,
      proposals: new knowledgeAdapters.PostgresProposalStore(pool),
      knowledge: new knowledgeAdapters.PostgresKnowledgeStore(pool),
      jobs,
      clock: { now: () => at(0) },
      ids: { next: () => randomUUID() as Id },
      redactor: exactSecretRedactor([]),
      project: createLibrarianProjectRead(pool, silentLogger),
      artifact: async () => ({
        data: ARTIFACT_DATA as never,
        runId: null,
        taskMode: 'normal',
        ticketKey: 'X-1',
      }),
      logger: silentLogger,
    };
    const job = { project_id: projectId, task_id: taskId, artifact_id: artifactId };
    const database_ = drizzle(pool, { schema: db.schema });
    const pass = (offsetMs: number) =>
      runStrandedRecovery({
        store: recoveryAdapters.createPostgresStrandedWorkStore(),
        unitOfWork: eventing.unitOfWork,
        jobs,
        clock: { now: () => at(offsetMs) },
        graceMs: GRACE_MS,
      }).then((report) => report.find((site) => site.site === 'knowledge_curation'));

    // The live delivery is refused by name, and the refusal is what the 409 counts.
    const live = await recordLibrarianProposals(librarian, job);
    expect(live.status).toBe('refused');
    expect(live.reason).toContain('Unrecognized key: "bogus_root_key"');
    expect(await countCurationsWaitingOnSettings(database_, projectId)).toBe(1);

    // The first pass re-offers it, and the worker's run is refused again.
    expect(await pass(0)).toMatchObject({ found: 1, reEnqueued: 1, ended: 0 });
    expect(enqueued.filter((entry) => entry.queue === 'knowledge.proposals')).toHaveLength(1);
    expect((await recordLibrarianProposals(librarian, job)).status).toBe('refused');
    // An ending racing that refusal (the pass read the row while it was still attempted) writes
    // nothing: the refusal cleared the attempt, and the ending requires one (standing rule 9).
    await eventing.unitOfWork.transaction(async (scope) =>
      recoveryAdapters.createPostgresStrandedWorkStore().endCuration(scope.tx, {
        artifactId,
        reason: 'a racing ending',
        at: at(0),
      }),
    );

    // A whole ending window later the curation is offered **again**: the refusal did not spend the
    // recovery's attempt. Before WP-125 this pass ended it (`abandoned_at`) and the proposals were lost.
    expect(await pass(STRANDED_ENDING_AFTER_MS + 2 * GRACE_MS)).toMatchObject({
      found: 1,
      reEnqueued: 1,
      ended: 0,
    });
    const curation = await pool.query<{
      abandoned_at: Date | null;
      settings_refused_at: Date | null;
    }>('select abandoned_at, settings_refused_at from knowledge_curations where artifact_id = $1', [
      artifactId,
    ]);
    expect(curation.rows[0]?.abandoned_at).toBeNull();
    expect(curation.rows[0]?.settings_refused_at).not.toBeNull();
    expect(await countCurationsWaitingOnSettings(database_, projectId)).toBe(1);

    // The operator fixes the document; the next offer lands the proposals.
    await pool.query(`update projects set config = '{}'::jsonb where id = $1`, [projectId]);
    const landed = await recordLibrarianProposals(librarian, job);
    expect(landed.status).toBe('recorded');
    expect(landed.queued + landed.autoApplied).toBe(1);
    const rows = await pool.query<{ count: number }>(
      'select count(*)::int as count from kb_proposals where project_id = $1',
      [projectId],
    );
    expect(rows.rows[0]?.count).toBe(1);
    expect(await countCurationsWaitingOnSettings(database_, projectId)).toBe(0);
    expect(await pass(2 * STRANDED_ENDING_AFTER_MS)).toMatchObject({ found: 0 });
  });

  it('still ends a curation whose re-offered wake-up was lost again (the bound the refusal does not touch)', async () => {
    const { artifactId } = await seed();
    const { jobs } = recordingJobs();
    const pass = (offsetMs: number) =>
      runStrandedRecovery({
        store: recoveryAdapters.createPostgresStrandedWorkStore(),
        unitOfWork: eventing.unitOfWork,
        jobs,
        clock: { now: () => at(offsetMs) },
        graceMs: GRACE_MS,
      }).then((report) => report.find((site) => site.site === 'knowledge_curation'));
    // No curation ever runs: the re-offer is lost too, so the pass ends it an ending window later.
    expect(await pass(0)).toMatchObject({ reEnqueued: 1, ended: 0 });
    expect(await pass(STRANDED_ENDING_AFTER_MS + 2 * GRACE_MS)).toMatchObject({ ended: 1 });
    const curation = await pool.query<{ abandoned_at: Date | null }>(
      'select abandoned_at from knowledge_curations where artifact_id = $1',
      [artifactId],
    );
    expect(curation.rows[0]?.abandoned_at).not.toBeNull();
  });
});

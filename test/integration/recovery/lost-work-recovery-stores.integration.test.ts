/**
 * The two WP-124 recovery rows' reads, marks and endings against PostgreSQL 18 and real pg-boss —
 * PROGRESS backlog 366, TD-004's M7 amendment.
 *
 * The passes' behaviour is asserted in `packages/application/src/recovery/lost-work.test.ts`; this
 * is the half that proves the SQL answers each predicate, including its "no job owed" half against
 * jobs sent through the real pg-boss sender, and that both writes are conditional on it.
 *
 * Each case runs in one transaction that is rolled back; the jobs a case sends are committed by the
 * sender, so each case keys them by a project or an artifact of its own.
 */
import type { Transaction } from '@platform/application';
import { JOB_QUEUES } from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import { db, jobs, knowledge, recovery as recoveryAdapters } from '@platform/infrastructure';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestClient, strictPoolLogger } from '../support/postgres.js';

let database: MigratedDatabase;
let handle: ReturnType<typeof db.createDatabasePool>;
let sender: ReturnType<typeof jobs.createPgBossJobs>;
let orgId: string;
let client: pg.Client;
let tx: Transaction;
let counter = 0;

const applies = recoveryAdapters.createPostgresKnowledgeApplyRecoveryStore({
  jobsSchema: 'pgboss',
});
const discoveries = recoveryAdapters.createPostgresDiscoveryRecordRecoveryStore({
  jobsSchema: 'pgboss',
});

const minutesAgo = (minutes: number): IsoDateTime =>
  new Date(Date.now() - minutes * 60_000).toISOString() as IsoDateTime;

const query = (overrides: Partial<{ olderThan: string; endingBefore: string }> = {}) => ({
  olderThan: (overrides.olderThan ?? minutesAgo(1)) as IsoDateTime,
  endingBefore: (overrides.endingBefore ?? minutesAgo(60)) as IsoDateTime,
  limit: 50,
});

const seedProject = async (): Promise<Id> => {
  counter += 1;
  const { rows } = await client.query<{ id: string }>(
    `insert into projects (org_id, key, name, repo_url)
     values ($1, $2, 'Lost work', 'https://git.example.test/acme/api.git') returning id`,
    [orgId, `lw${counter}`],
  );
  return rows[0]?.id as Id;
};

const seedProposal = async (
  projectId: Id,
  input: {
    readonly status: string;
    readonly decidedMinutesAgo?: number | null;
    readonly createdMinutesAgo?: number;
    readonly applied?: boolean;
    readonly attemptedMinutesAgo?: number | null;
  },
): Promise<Id> => {
  counter += 1;
  const { rows } = await client.query<{ id: string }>(
    `insert into kb_proposals (project_id, source, kind, type, target_path, delta, significance,
                               status, decided_at, applied_commit_sha, created_at,
                               apply_recovery_attempted_at)
     values ($1, 'task', 'technical', 'lesson', $2, '# page', 0.5, $3::knowledge_proposal_status,
             case when $4::int is null then null else now() - ($4::int * interval '1 minute') end,
             $5, now() - ($6::int * interval '1 minute'),
             case when $7::int is null then null else now() - ($7::int * interval '1 minute') end)
     returning id`,
    [
      projectId,
      `.agentic/knowledge/lessons/L-${counter}.md`,
      input.status,
      input.decidedMinutesAgo === undefined ? 10 : input.decidedMinutesAgo,
      input.applied === true ? 'a'.repeat(40) : null,
      input.createdMinutesAgo ?? 30,
      input.attemptedMinutesAgo ?? null,
    ],
  );
  return rows[0]?.id as Id;
};

const sendApplyJob = async (projectId: Id): Promise<string> => {
  const sent = await sender.jobs.enqueue({
    queue: JOB_QUEUES.knowledgeApply,
    data: { project_id: projectId, reason: 'decision' },
    singletonKey: `project:${projectId}`,
  });
  expect(sent.status).toBe('enqueued');
  return (sent as { readonly jobId: string }).jobId;
};

/** A discovery task with a `DiscoveryDraft` artifact stored `minutes` ago, and its event. */
const seedDraft = async (
  projectId: Id,
  minutes: number,
): Promise<{ readonly taskId: Id; readonly artifactId: Id; readonly eventId: Id }> => {
  counter += 1;
  const task = await client.query<{ id: string }>(
    `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, state)
     values ($1, 'platform', $2, 'platform:discovery', 'discovery', 'done') returning id`,
    [projectId, `discovery-${counter}`],
  );
  const taskId = task.rows[0]?.id as Id;
  const artifact = await client.query<{ id: string }>(
    `insert into artifacts (task_id, type, data, schema_version, created_at, redaction_count)
     values ($1, 'DiscoveryDraft', '{}'::jsonb, '1', now() - ($2::int * interval '1 minute'), 0)
     returning id`,
    [taskId, minutes],
  );
  const artifactId = artifact.rows[0]?.id as Id;
  const event = await client.query<{ id: string }>(
    `insert into events (stream_type, stream_id, stream_seq, type, payload, actor)
     values ('task', $1, 1, 'artifact.created', $2::jsonb,
             '{"kind":"system","component":"pipeline"}'::jsonb) returning id`,
    [
      taskId,
      JSON.stringify({ project_id: projectId, task_id: taskId, artifact: { id: artifactId } }),
    ],
  );
  return { taskId, artifactId, eventId: event.rows[0]?.id as Id };
};

const seedEvaluation = async (projectId: Id, source: string, minutes: number): Promise<void> => {
  await client.query(
    `insert into readiness_evaluations (project_id, level, criteria, source, evaluated_at)
     values ($1, 1, '[]'::jsonb, $2, now() - ($3::int * interval '1 minute'))`,
    [projectId, source, minutes],
  );
};

const sendRecordJob = async (projectId: Id, artifactId: Id): Promise<string> => {
  const sent = await sender.jobs.enqueue({
    queue: JOB_QUEUES.discoveryRecord,
    data: { project_id: projectId, task_id: 'irrelevant', artifact_id: artifactId },
  });
  expect(sent.status).toBe('enqueued');
  return (sent as { readonly jobId: string }).jobId;
};

beforeAll(async () => {
  database = await createMigratedDatabase('lost-work');
  handle = db.createDatabasePool(
    {
      url: database.connectionString,
      appRole: 'platform_app',
      poolMax: 4,
      connectionTimeoutMs: db.DATABASE_CONFIG_DEFAULTS.connectionTimeoutMs,
      partitionMonthsAhead: 3,
      transcriptRetentionDays: null,
    },
    strictPoolLogger,
  );
  sender = jobs.createPgBossJobs({
    database: jobs.asJobsDatabase(handle.pool),
    supervise: false,
    schedule: false,
  });
  await sender.start();
  const setup = createTestClient(database.connectionString);
  await setup.connect();
  try {
    const org = await setup.query<{ id: string }>(
      "insert into organizations (name) values ('lost work') returning id",
    );
    orgId = org.rows[0]?.id as string;
  } finally {
    await setup.end();
  }
}, 120_000);

afterAll(async () => {
  await sender?.stop();
  await handle?.close();
  await database?.drop();
});

beforeEach(async () => {
  client = createTestClient(database.connectionString);
  await client.connect();
  await client.query('begin');
  tx = { adapter: 'postgres', client } as unknown as Transaction;
});

afterEach(async () => {
  await client.query('rollback');
  await client.end();
});

describe('the knowledge-apply recovery store (WP-124, backlog 366)', () => {
  it('finds an approved, uncommitted proposal with no apply owed to its project, and none of the others', async () => {
    const project = await seedProject();
    const approved = await seedProposal(project, { status: 'queued' });
    const byPolicy = await seedProposal(project, {
      status: 'auto_applied',
      decidedMinutesAgo: null,
    });
    await seedProposal(project, { status: 'queued', decidedMinutesAgo: null }); // undecided
    await seedProposal(project, { status: 'queued', applied: true }); // committed
    await seedProposal(project, { status: 'rejected' });
    await seedProposal(project, { status: 'queued', decidedMinutesAgo: 0 }); // inside the grace
    // Attempted recently: waiting for its own re-enqueued apply, so not read.
    await seedProposal(project, { status: 'queued', attemptedMinutesAgo: 5 });
    const attemptedLong = await seedProposal(project, {
      status: 'queued',
      attemptedMinutesAgo: 90,
    });

    const owed = await seedProject();
    await seedProposal(owed, { status: 'queued' });
    await sendApplyJob(owed);

    const found = await applies.strandedApplies(tx, query());
    expect(found.map((row) => row.proposalId).sort()).toEqual(
      [approved, byPolicy, attemptedLong].sort(),
    );
    expect(
      found.find((row) => row.proposalId === attemptedLong)?.recoveryAttemptedAt,
    ).not.toBeNull();
    expect(found.find((row) => row.proposalId === approved)?.recoveryAttemptedAt).toBeNull();
  });

  it('finds the proposal again once pg-boss has given up on its project’s apply', async () => {
    const project = await seedProject();
    const approved = await seedProposal(project, { status: 'queued' });
    const jobId = await sendApplyJob(project);
    expect((await applies.strandedApplies(tx, query())).map((row) => row.proposalId)).not.toContain(
      approved,
    );
    await client.query(
      "update pgboss.job set state = 'failed', completed_on = now() where id = $1",
      [jobId],
    );
    expect((await applies.strandedApplies(tx, query())).map((row) => row.proposalId)).toContain(
      approved,
    );
  });

  it('marks only while the proposal is stranded and unattempted, and ends only an attempted one', async () => {
    const project = await seedProject();
    const fresh = await seedProposal(project, { status: 'queued' });
    const attempted = await seedProposal(project, {
      status: 'auto_applied',
      attemptedMinutesAgo: 90,
    });
    const committed = await seedProposal(project, { status: 'queued', applied: true });

    expect(
      await applies.markApplyAttempt(tx, {
        proposalIds: [fresh, attempted, committed],
        at: minutesAgo(0),
      }),
    ).toEqual([fresh]);
    expect(await applies.markApplyAttempt(tx, { proposalIds: [fresh], at: minutesAgo(0) })).toEqual(
      [],
    );

    expect(
      await applies.endApply(tx, { proposalIds: [attempted, committed], reason: 'gave up' }),
    ).toEqual([attempted]);
    const row = await client.query<{ status: string; apply_failure_reason: string | null }>(
      'select status::text, apply_failure_reason from kb_proposals where id = $1',
      [attempted],
    );
    expect(row.rows[0]).toEqual({ status: 'apply_failed', apply_failure_reason: 'gave up' });
    // Not awaiting apply any more: neither the pass nor the hygiene sweep reads it again.
    expect((await applies.strandedApplies(tx, query())).map((r) => r.proposalId)).not.toContain(
      attempted,
    );
  });

  it('writes neither the mark nor the ending once an apply is owed again (standing rule 9)', async () => {
    const project = await seedProject();
    const fresh = await seedProposal(project, { status: 'queued' });
    const attempted = await seedProposal(project, { status: 'queued', attemptedMinutesAgo: 90 });
    await sendApplyJob(project);
    expect(await applies.markApplyAttempt(tx, { proposalIds: [fresh], at: minutesAgo(0) })).toEqual(
      [],
    );
    expect(await applies.endApply(tx, { proposalIds: [attempted], reason: 'x' })).toEqual([]);
  });

  /**
   * WP-125, PROGRESS backlog 369: a proposal the apply pass deferred behind an open knowledge
   * merge request waits on a person's merge. Neither marked nor ended — an `apply_failed` an hour
   * later would say the platform could not commit it, which is false.
   */
  it('never marks or ends a proposal deferred behind an open knowledge merge request (WP-125)', async () => {
    const project = await seedProject();
    const deferred = await seedProposal(project, { status: 'queued' });
    const deferredAttempted = await seedProposal(project, {
      status: 'queued',
      attemptedMinutesAgo: 90,
    });
    const stranded = await seedProposal(project, { status: 'queued' });
    await client.query(
      `update kb_proposals set apply_deferred_reason = 'waits for knowledge merge request !4'
        where id = any($1::uuid[])`,
      [[deferred, deferredAttempted]],
    );
    const found = (await applies.strandedApplies(tx, query())).map((row) => row.proposalId);
    expect(found).toContain(stranded);
    expect(found).not.toContain(deferred);
    expect(found).not.toContain(deferredAttempted);
    expect(
      await applies.markApplyAttempt(tx, { proposalIds: [deferred], at: minutesAgo(0) }),
    ).toEqual([]);
    expect(await applies.endApply(tx, { proposalIds: [deferredAttempted], reason: 'x' })).toEqual(
      [],
    );
  });

  it('lets a maintainer approve an apply_failed proposal again, clearing the mark and the reason', async () => {
    const project = await seedProject();
    const failed = await seedProposal(project, { status: 'queued', attemptedMinutesAgo: 90 });
    await applies.endApply(tx, { proposalIds: [failed], reason: 'gave up' });
    const store = new knowledge.PostgresProposalStore(client as never);
    expect(
      await store.decide(tx, {
        id: failed,
        status: 'queued',
        decidedByUserId: null as never,
        decidedAt: minutesAgo(0),
      }),
    ).toBe(true);
    const row = await client.query(
      `select status::text, apply_failure_reason, apply_recovery_attempted_at
         from kb_proposals where id = $1`,
      [failed],
    );
    expect(row.rows[0]).toEqual({
      status: 'queued',
      apply_failure_reason: null,
      apply_recovery_attempted_at: null,
    });
  });
});

describe('the discovery-record recovery store (WP-124, backlog 366)', () => {
  it('finds the project’s newest draft with no evaluation and no job owed, with its event', async () => {
    const project = await seedProject();
    const older = await seedDraft(project, 30);
    const newest = await seedDraft(project, 20);

    const recorded = await seedProject();
    await seedDraft(recorded, 20);
    await seedEvaluation(recorded, 'discovery', 10);

    const reEvaluated = await seedProject();
    await seedDraft(reEvaluated, 20);
    await seedEvaluation(reEvaluated, 'recheck', 10); // a re-check does not record a draft

    const owed = await seedProject();
    const pending = await seedDraft(owed, 20);
    await sendRecordJob(owed, pending.artifactId);

    const young = await seedProject();
    await seedDraft(young, 0);

    const found = await discoveries.strandedDiscoveryRecords(tx, query());
    const ids = found.map((row) => row.artifactId);
    expect(ids).toContain(newest.artifactId);
    expect(ids, 'an older draft a later run superseded is never recorded over it').not.toContain(
      older.artifactId,
    );
    expect(ids).not.toContain(pending.artifactId);
    expect(found.filter((row) => row.projectId === reEvaluated)).toHaveLength(1);
    expect(found.filter((row) => row.projectId === recorded)).toHaveLength(0);
    expect(found.filter((row) => row.projectId === young)).toHaveLength(0);
    expect(found.find((row) => row.artifactId === newest.artifactId)).toMatchObject({
      taskId: newest.taskId,
      artifactEventId: newest.eventId,
      recoveryAttemptedAt: null,
    });
  });

  it('marks once while stranded, reads the attempt back after the ending window, and ends it once', async () => {
    const project = await seedProject();
    const draft = await seedDraft(project, 120);
    expect(
      await discoveries.markDiscoveryRecordAttempt(tx, {
        artifactId: draft.artifactId,
        at: minutesAgo(90),
      }),
    ).toBe(true);
    expect(
      await discoveries.markDiscoveryRecordAttempt(tx, {
        artifactId: draft.artifactId,
        at: minutesAgo(0),
      }),
    ).toBe(false);

    const found = await discoveries.strandedDiscoveryRecords(tx, query());
    expect(
      found.find((row) => row.artifactId === draft.artifactId)?.recoveryAttemptedAt,
    ).not.toBeNull();

    expect(
      await discoveries.endDiscoveryRecord(tx, {
        artifactId: draft.artifactId,
        reason: 'never recorded',
        at: minutesAgo(0),
      }),
    ).toBe(true);
    expect(
      await discoveries.endDiscoveryRecord(tx, {
        artifactId: draft.artifactId,
        reason: 'again',
        at: minutesAgo(0),
      }),
    ).toBe(false);
    expect(
      (await discoveries.strandedDiscoveryRecords(tx, query())).map((row) => row.artifactId),
    ).not.toContain(draft.artifactId);
  });

  it('writes neither the mark nor the ending once the draft was recorded (standing rule 9)', async () => {
    const project = await seedProject();
    const fresh = await seedDraft(project, 120);
    await seedEvaluation(project, 'discovery', 0);
    expect(
      await discoveries.markDiscoveryRecordAttempt(tx, {
        artifactId: fresh.artifactId,
        at: minutesAgo(0),
      }),
    ).toBe(false);

    const other = await seedProject();
    const attempted = await seedDraft(other, 120);
    await discoveries.markDiscoveryRecordAttempt(tx, {
      artifactId: attempted.artifactId,
      at: minutesAgo(90),
    });
    await seedEvaluation(other, 'rediscovery', 0);
    expect(
      await discoveries.endDiscoveryRecord(tx, {
        artifactId: attempted.artifactId,
        reason: 'x',
        at: minutesAgo(0),
      }),
    ).toBe(false);
  });
});

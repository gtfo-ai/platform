/**
 * The run-credential recovery row against a real PostgreSQL 18 — WP-77, PROGRESS backlog **155**.
 *
 * Criterion (5) is **countable at the boundary**: the fake git provider's own
 * `credentials[].revocations` — what the provider was *asked*, not a record of intent (standing
 * rule 1) — goes 0 → 1 for a run whose lease expired, 0 → 1 for a run whose teardown revoke failed
 * once, and **stays 1** for a run revoked normally. The last is the negative (rule 42), and it is a
 * meaningful one (rule 43): the three runs have the same shape — terminal, a `mint_credential` row,
 * a `revoke_credential` row for two of them — so a query that asked only "is there a revoke row"
 * would miss the failed teardown, and one that ignored revoke rows would revoke the normal run
 * twice. Both directions are therefore decided by the SQL, which is why this is the tier.
 *
 * Everything that writes is the production path: the mint and the teardown revoke go through
 * `runCredentialWrites` and the real executor into the real `integration_actions`, the lease sweep
 * ends the dead run through `runStrandedRecovery`, the pass finds with the Postgres store, and the
 * duty re-validates and revokes. The fake's clock starts at the wall clock because the predicate
 * compares the mint's recorded expiry with the pass's `now`.
 */
import { randomUUID } from 'node:crypto';
import type {
  Jobs,
  PipelineIntegrations,
  PipelineIntegrationsPort,
  RecoverableRunCredential,
} from '@platform/application';
import {
  allowAnyIntegrationHost,
  createIntegrationActionExecutor,
  createVirtualTimer,
  declarePipelineQueues,
  noSecretsRedactor,
  RUN_CREDENTIAL_TTL_SECONDS,
  runCredentialRecoveryHorizonMs,
  runCredentialWrites,
  runRunCredentialRevocation,
  runStrandedRecovery,
} from '@platform/application';
import type { Id, IsoDateTime, TaskMode } from '@platform/contracts';
import { FEATURE_TEMPLATE, SHIPPED_TEMPLATES } from '@platform/domain';
import {
  eventing,
  integrations as integrationAdapters,
  jobs as jobsAdapters,
  pipeline as pipelineAdapters,
  recovery as recoveryAdapters,
} from '@platform/infrastructure';
import { createFakeGitProvider, type FakeGitProvider } from '@platform/integrations';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

const PROJECT_PATH = 'acme/api';
const GRACE_MS = 60_000;
const WALL_CLOCK_MS = 60 * 60_000;

let database: MigratedDatabase;
let pool: pg.Pool;
let projectId: Id;
let gitIntegrationId: Id;

const credentialStore = recoveryAdapters.createPostgresRunCredentialStore();
const pipeline = pipelineAdapters.createPostgresPipelineStore({ templates: SHIPPED_TEMPLATES });

const iso = (offsetMs = 0): IsoDateTime =>
  new Date(Date.now() + offsetMs).toISOString() as IsoDateTime;

/** The production executor over the real `integration_actions`, for one fake provider instance. */
const integrationsOver = (git: FakeGitProvider): PipelineIntegrationsPort => {
  const unitOfWork = new eventing.PostgresUnitOfWork({ pool });
  const executor = createIntegrationActionExecutor({
    egress: allowAnyIntegrationHost(),
    auditLog: integrationAdapters.createPostgresIntegrationAuditLog({
      unitOfWork,
      eventStore: new eventing.PostgresEventStore(pool),
      ids: { next: () => randomUUID() as Id },
    }),
    redactor: noSecretsRedactor(),
    timer: createVirtualTimer({ autoAdvance: true }),
    clock: { now: () => iso() } as never,
  });
  const bound: PipelineIntegrations = {
    executor,
    git: { port: git, ref: git.ref, project: PROJECT_PATH, redactor: noSecretsRedactor() },
    taskManagement: null,
    communication: null,
  };
  return { forProject: async () => bound } as unknown as PipelineIntegrationsPort;
};

const fakeGit = (): FakeGitProvider =>
  createFakeGitProvider({
    integrationId: gitIntegrationId,
    projects: [{ path: PROJECT_PATH }],
    clockStart: iso(),
  });

let ticket = 0;

/** A task and one run of it, live, whose lease expires `leaseOffsetMs` from now. */
const seedRun = async (
  mode: TaskMode,
  leaseOffsetMs: number,
): Promise<{ taskId: Id; runId: Id }> => {
  ticket += 1;
  const task = await pool.query<{ id: string }>(
    `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, state,
                        current_stage, template_snapshot, mode)
     values ($1, 'fake-jira', $2, 'https://jira.example.test/browse/ACME', 'feature',
             'active', 'implementation', $3::jsonb, $4::task_mode) returning id`,
    [projectId, `ACME-${ticket}`, JSON.stringify(FEATURE_TEMPLATE), mode],
  );
  const taskId = task.rows[0]?.id as Id;
  const stage = await pool.query<{ id: string }>(
    `insert into task_stages (task_id, stage, attempt, state)
     values ($1, 'implementation', 1, 'entered') returning id`,
    [taskId],
  );
  const run = await pool.query<{ id: string }>(
    `insert into runs (task_id, task_stage_id, project_id, role, model, effort, prompt_version,
                       attempt, status, started_at, lease_owner, lease_expires_at)
     values ($1, $2, $3, 'developer', 'claude-opus-5', 'high', 'feature@1+developer',
             1, 'running', now() - interval '20 minutes', 'runner-1:0f0f0f0f',
             now() + ($4::int * interval '1 millisecond')) returning id`,
    [taskId, stage.rows[0]?.id, projectId, leaseOffsetMs],
  );
  return { taskId, runId: run.rows[0]?.id as Id };
};

/** The run's ending as the stage executor writes it, for a run whose runner did not die. */
const endRun = async (runId: Id): Promise<void> => {
  await pool.query(
    `update runs set status = 'completed', terminal_reason = 'success', ended_at = now()
      where id = $1`,
    [runId],
  );
};

const mint = async (
  port: PipelineIntegrationsPort,
  ids: { taskId: Id; runId: Id },
  mode: TaskMode,
  scope: 'push' | 'read',
) => {
  const writes = runCredentialWrites(await port.forProject(projectId, undefined as never));
  const answer = await writes.mint({
    runId: ids.runId,
    taskId: ids.taskId,
    projectId,
    mode,
    scope,
    branchPatterns: scope === 'push' ? ['agentic/*'] : [],
    ttlSeconds: RUN_CREDENTIAL_TTL_SECONDS,
  });
  if (answer.kind !== 'minted') {
    throw new Error(`expected a credential, got ${answer.reason}`);
  }
  return { writes, credential: answer.credential };
};

/** A queue runtime with `pipeline.outbound` declared, as `createPipelineRuntime.start` declares it. */
const queues = async () => {
  const runtime = jobsAdapters.createInMemoryJobs();
  await declarePipelineQueues(runtime.jobs);
  return runtime;
};

/** One whole recovery pass at `now` — the lease site and the credential site — into `jobs`. */
const pass = async (now: IsoDateTime, jobs: Jobs) =>
  runStrandedRecovery({
    store: recoveryAdapters.createPostgresStrandedWorkStore(),
    unitOfWork: new eventing.PostgresUnitOfWork({ pool }),
    jobs,
    clock: { now: () => now },
    graceMs: GRACE_MS,
    credentials: {
      store: credentialStore,
      horizonMs: runCredentialRecoveryHorizonMs(RUN_CREDENTIAL_TTL_SECONDS),
    },
    runs: {
      store: recoveryAdapters.createPostgresExpiredRunStore(),
      pipeline,
      unitOfWork: new eventing.PostgresUnitOfWork({ pool }),
      eventStore: new eventing.PostgresEventStore(pool),
      context: (correlationId) => ({
        ids: { next: () => randomUUID() as Id },
        actor: { kind: 'system', component: 'pipeline.run-lease.sweep' },
        clock: { now: () => now },
        correlationId,
        causeEventId: null,
      }),
      wallClockMs: WALL_CLOCK_MS,
    },
  });

/** Every `revoke_run_credential` wake-up a pass enqueued, run through the duty as the job would. */
const runDuties = async (
  runtime: ReturnType<typeof jobsAdapters.createInMemoryJobs>,
  port: PipelineIntegrationsPort,
  now: IsoDateTime,
) => {
  const wakeUps = runtime
    .snapshot()
    .filter((job) => job.data['duty'] === 'revoke_run_credential')
    .map((job) => job.data);
  for (const data of wakeUps) {
    await runRunCredentialRevocation(
      {
        unitOfWork: new eventing.PostgresUnitOfWork({ pool }),
        integrations: port,
        clock: { now: () => now },
        runCredentials: credentialStore,
      },
      data as never,
    );
  }
  return wakeUps;
};

const revokeRows = async (taskId: Id) =>
  (
    await pool.query<{ status: string; payload: Record<string, unknown>; result: unknown }>(
      `select status, payload, result from integration_actions
        where task_id = $1 and action = 'revoke_credential' order by created_at`,
      [taskId],
    )
  ).rows;

beforeAll(async () => {
  database = await createMigratedDatabase('run-credential');
  pool = createTestPool(database.connectionString, { max: 8 });
  const org = await pool.query<{ id: string }>(
    "insert into organizations (name) values ('credential') returning id",
  );
  const project = await pool.query<{ id: string }>(
    `insert into projects (org_id, key, name, repo_url)
     values ($1, 'cred', 'Credential', 'https://git.example.test/acme/api.git') returning id`,
    [org.rows[0]?.id],
  );
  projectId = project.rows[0]?.id as Id;
  const integration = await pool.query<{ id: string }>(
    `insert into integrations (org_id, type, provider, name)
     values ($1, 'git', 'fake-git', 'git') returning id`,
    [org.rows[0]?.id],
  );
  gitIntegrationId = integration.rows[0]?.id as Id;
  await pool.query('insert into bindings (project_id, integration_id) values ($1, $2)', [
    projectId,
    gitIntegrationId,
  ]);
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

beforeEach(async () => {
  await pool.query('delete from runs');
  await pool.query('delete from task_stages');
});

describe('a run credential nothing confirmed revoked (WP-77, backlog 155)', () => {
  it('revokes the dead runner’s and the failed teardown’s, once each, and leaves the revoked one alone', async () => {
    const git = fakeGit();
    const port = integrationsOver(git);

    // (a) The runner dies between mint and revoke: the lease expired ten minutes ago.
    const dead = await seedRun('normal', -10 * 60_000);
    await mint(port, dead, 'normal', 'push');

    // (b) The teardown revoke fails once — a non-retryable error, so the executor's own retry does
    //     not quietly succeed on a second attempt — and the run ends normally.
    const failed = await seedRun('normal', 5 * 60_000);
    const minted = await mint(port, failed, 'normal', 'push');
    git.core.script.failNext('revoke_credential', new Error('the provider went away'));
    await expect(
      minted.writes.revoke(minted.credential, { ...failed, projectId, mode: 'normal' }),
    ).rejects.toThrow(/the provider went away/);
    await endRun(failed.runId);

    // (c) The negative: revoked normally, then ended — the same shape as (b) but for the outcome.
    const normal = await seedRun('normal', 5 * 60_000);
    const kept = await mint(port, normal, 'normal', 'push');
    await kept.writes.revoke(kept.credential, { ...normal, projectId, mode: 'normal' });
    await endRun(normal.runId);

    // Before: nothing asked for (a) or (b); one revocation for (c).
    expect(git.credentials.map((row) => row.revocations)).toEqual([0, 0, 1]);

    // Pass 1 ends the dead run's row; its reads happened before that, and (b) ended a moment ago —
    // inside the grace, where its own teardown may still be revoking. Nothing is enqueued.
    const first = await queues();
    const firstReport = await pass(iso(), first.jobs);
    expect(firstReport.find((site) => site.site === 'run_lease')).toMatchObject({ ended: 1 });
    expect(firstReport.find((site) => site.site === 'run_credential')).toMatchObject({ found: 0 });

    // Pass 2, a grace later, finds (a) and (b) — and not (c).
    const later = iso(5 * 60_000);
    const second = await queues();
    const secondReport = await pass(later, second.jobs);
    expect(secondReport.find((site) => site.site === 'run_credential')).toMatchObject({
      found: 2,
      reEnqueued: 2,
    });
    const wakeUps = await runDuties(second, port, later);
    expect(wakeUps.map((data) => data['run_id']).toSorted()).toEqual(
      [dead.runId, failed.runId].toSorted(),
    );

    // Criterion (5), at the boundary: 0 → 1, 0 → 1, and 1 stays 1.
    expect(git.credentials.map((row) => [row.revocations, row.revoked])).toEqual([
      [1, true],
      [1, true],
      [1, true],
    ]);

    // The attempt's own row is the bound: a third pass finds nothing, and a duplicate wake-up of
    // pass 2 — a pass that ran again before its job was taken — asks nobody.
    const third = await queues();
    const thirdReport = await pass(iso(10 * 60_000), third.jobs);
    expect(thirdReport.find((site) => site.site === 'run_credential')).toMatchObject({ found: 0 });
    await runDuties(second, port, iso(10 * 60_000));
    expect(git.credentials.map((row) => row.revocations)).toEqual([1, 1, 1]);

    // What the audit says: (b) has the teardown's failure and then the recovery's success; (a)
    // has the recovery's alone; (c) has only its teardown's.
    expect(
      (await revokeRows(failed.taskId)).map((row) => [row.status, row.payload['origin']]),
    ).toEqual([
      ['failed', undefined],
      ['ok', 'recovery'],
    ]);
    expect((await revokeRows(dead.taskId)).map((row) => row.result)).toEqual([
      { revoked: true, confirmation: 'revoked', revoke_id: expect.any(String) },
    ]);
    expect((await revokeRows(normal.taskId)).map((row) => row.payload['origin'])).toEqual([
      undefined,
    ]);
  });

  it('revokes a shadow task’s read credential under the carve-out, performed and not would_have', async () => {
    const git = fakeGit();
    const port = integrationsOver(git);
    const shadow = await seedRun('shadow', 5 * 60_000);
    await mint(port, shadow, 'shadow', 'read');
    await endRun(shadow.runId);

    const later = iso(5 * 60_000);
    const runtime = await queues();
    await pass(later, runtime.jobs);
    await runDuties(runtime, port, later);

    expect(git.credentials.map((row) => [row.scope, row.revocations])).toEqual([['read', 1]]);
    expect((await revokeRows(shadow.taskId)).map((row) => row.status)).toEqual(['ok']);
    expect((await revokeRows(shadow.taskId))[0]?.payload).toMatchObject({
      task_mode: 'shadow',
      origin: 'recovery',
    });
  });

  it('records a provider’s not_found as unconfirmed, never as revoked, and does not ask again', async () => {
    // The mint went through one provider instance; the recovery reaches another that never minted
    // it — as GitLab's per-call adapter always does — and that one answers `not_found`.
    const minter = fakeGit();
    const lost = await seedRun('normal', 5 * 60_000);
    await mint(integrationsOver(minter), lost, 'normal', 'push');
    await endRun(lost.runId);
    const stranger = fakeGit();
    const port = integrationsOver(stranger);

    const later = iso(5 * 60_000);
    const runtime = await queues();
    await pass(later, runtime.jobs);
    await runDuties(runtime, port, later);

    const rows = await revokeRows(lost.taskId);
    expect(rows.map((row) => [row.status, row.result])).toEqual([
      ['ok', { revoked: false, confirmation: 'unconfirmed', revoke_id: expect.any(String) }],
    ]);
    // Never a claim that the minter's token is gone — it is not.
    expect(minter.credentials.map((row) => row.revoked)).toEqual([false]);

    const again = await queues();
    const report = await pass(iso(10 * 60_000), again.jobs);
    expect(report.find((site) => site.site === 'run_credential')).toMatchObject({ found: 0 });
  });

  it('leaves a live run’s credential to its runner, and an expired one to its expiry', async () => {
    const git = fakeGit();
    const port = integrationsOver(git);
    // Live: the lease is fresh, so neither site touches it.
    const live = await seedRun('normal', 30 * 60_000);
    const liveMint = await mint(port, live, 'normal', 'push');
    // Ended, never revoked — but read at an instant after its credential's recorded expiry.
    const expired = await seedRun('normal', 5 * 60_000);
    await mint(port, expired, 'normal', 'push');
    await endRun(expired.runId);

    const store = credentialStore;
    const found = await new eventing.PostgresUnitOfWork({ pool }).transaction(async (scope) => ({
      soon: await store.unrevokedRunCredentials(scope.tx, {
        endedBefore: iso(5 * 60_000),
        endedAfter: iso(-48 * 60 * 60_000),
        now: iso(5 * 60_000),
        limit: 10,
      }),
      afterExpiry: await store.unrevokedRunCredentials(scope.tx, {
        endedBefore: iso(49 * 60 * 60_000),
        endedAfter: iso(-48 * 60 * 60_000),
        now: iso(49 * 60 * 60_000),
        limit: 10,
      }),
    }));

    expect(found.soon.map((row: RecoverableRunCredential) => row.runId)).toEqual([expired.runId]);
    expect(found.soon[0]).toMatchObject({
      integrationId: gitIntegrationId,
      scope: 'push',
      mode: 'normal',
    });
    expect(found.afterExpiry).toEqual([]);
    // The duty's re-validation has no run window of its own, so the terminal predicate is all that
    // stands between a woken duty and a live run's token (WP-77 review round 1): asked directly for
    // the live run's credential it answers nothing, and for the ended one it still answers.
    const revalidated = await new eventing.PostgresUnitOfWork({ pool }).transaction(
      async (scope) => ({
        live: await store.unrevokedRunCredential(scope.tx, {
          runId: live.runId,
          revokeId: liveMint.credential.revokeId ?? '',
          now: iso(5 * 60_000),
        }),
        ended: await store.unrevokedRunCredential(scope.tx, {
          runId: expired.runId,
          revokeId: found.soon[0]?.revokeId ?? '',
          now: iso(5 * 60_000),
        }),
      }),
    );
    expect(revalidated.live).toBeNull();
    expect(revalidated.ended?.runId).toBe(expired.runId);
    expect(git.credentials.map((row) => row.revocations)).toEqual([0, 0]);
  });
});

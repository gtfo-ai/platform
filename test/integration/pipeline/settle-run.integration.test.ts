/**
 * `settleRun` against a real PostgreSQL 18 — WP-275 criteria (2)–(4), TD-031 decision 3.
 *
 * The unit tier (`packages/application/src/pipeline/settle.test.ts`) holds the command over the memory
 * store, which takes no row lock. What only a database shows is the lock the command's first statement
 * takes (`RunRepository.lockSettlement`, `for update`) and the rollback a refused settle relies on:
 *
 *  1. **Two settles of one run at once** — on two connections, over many iterations — append exactly
 *     one terminal event, charge the task once, and answer one `settled` and one `already_settled`
 *     with the same stored result.
 *  2. **The second waits on the first's lock**: a settle held between its lock and its `finish` makes
 *     a second settle of the same run wait (seen in `pg_locks`), which then answers `already_settled`.
 *  3. **A stale fence** — epoch or owner — is `lease_lost` and leaves the run, the task and the log as
 *     they were.
 */
import {
  claimRunOffer,
  createWorkingCalendar,
  INITIAL_TASK_VERSION,
  LeaseLostError,
  type PipelineStore,
  type RunOutcome,
  type SettleRunDeps,
  type SettleRunRequest,
  type SettleRunResult,
  type StoredTask,
  settleRun,
  type Transaction,
} from '@platform/application';
import type { Id, IsoDateTime, Slug } from '@platform/contracts';
import type { Run } from '@platform/domain';
import { compilePipeline, FEATURE_TEMPLATE, SHIPPED_TEMPLATES, stageOf } from '@platform/domain';
import { eventing, pipeline, redaction } from '@platform/infrastructure';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recentInstant } from '../../support/recent-instant.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestClient, createTestPool } from '../support/postgres.js';

/** Frozen, but taken from the wall clock: the settle appends events at it (`recent-instant.ts`). */
const NOW: IsoDateTime = recentInstant();
const OWNER = 'server:settle-run-test';
const ITERATIONS = 40;

let database: MigratedDatabase;
let pool: pg.Pool;
let projectId: Id;
let store: PipelineStore;
let counter = 0;
const nextId = (): Id => {
  counter += 1;
  return `00000000-0000-4000-8275-${counter.toString(16).padStart(12, '0')}` as Id;
};

beforeAll(async () => {
  database = await createMigratedDatabase('settle-run');
  pool = createTestPool(database.connectionString, { max: 8 });
  store = pipeline.createPostgresPipelineStore({ templates: SHIPPED_TEMPLATES });
  const org = await pool.query<{ id: string }>(
    "insert into organizations (name) values ('settle-run') returning id",
  );
  const project = await pool.query<{ id: string }>(
    `insert into projects (org_id, key, name, repo_url)
     values ($1, 'api', 'API', 'https://git.example.test/acme/api.git') returning id`,
    [org.rows[0]?.id],
  );
  projectId = project.rows[0]?.id as Id;
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

/**
 * A committed task at `implementation` attempt 1 with its stage row, and one `running` run with its
 * stage offer claimed by {@link OWNER} at epoch 1 — the state the job's transaction 1 leaves.
 */
const seedClaimedRun = async (): Promise<{ readonly taskId: Id; readonly runId: Id }> => {
  const client = createTestClient(database.connectionString);
  await client.connect();
  try {
    await client.query('begin');
    const tx = { adapter: 'postgres', client } as unknown as Transaction;
    const taskId = nextId();
    const stored = {
      task: {
        id: taskId,
        projectId,
        ticket: {
          provider: 'fake-jira',
          key: `ACME-${counter}`,
          url: `https://jira.example.test/browse/ACME-${counter}`,
        },
        template: 'feature',
        mode: 'normal',
        state: 'active',
        currentStage: 'implementation' as Slug,
        stageAttempts: { implementation: 1 },
        iterationCounters: {},
        limits: {
          code_review: 3,
          business_review: 2,
          ci_fix: 3,
          human_rounds: 3,
          refinement_questions: 2,
          architecture_revisions: 2,
          rebase: 2,
          rebase_rechecks: 10,
          dependency_policy: 2,
        },
        sequence: 1,
      },
      template: FEATURE_TEMPLATE,
      pipelineDial: null,
      qaStage: false,
      priorityRank: 2,
      createdAt: NOW,
      branch: null,
      mr: null,
      workpad: null,
      costActualUsd: 0,
      estimateUsd: null,
      estimateBasis: null,
      estimateSamples: null,
      ticketSnapshot: null,
      ticketSnapshotAt: null,
      ticketSignalAt: null,
      reviewSubject: null,
      historySample: null,
      riskClasses: [],
      coverage: null,
      dependencies: null,
      requiredReviewers: null,
      reviewThreads: null,
      readyHeadSha: null,
      ciHeadSha: null,
      ciExcusedPaths: [],
      requestedByUserId: null,
      version: INITIAL_TASK_VERSION,
    } as unknown as StoredTask;
    await store.tasks.insert(tx, stored);
    await client.query(
      `insert into task_stages (task_id, stage, attempt, state) values ($1, 'implementation', 1, 'running')`,
      [taskId],
    );
    const runId = nextId();
    await store.runs.insert(tx, {
      id: runId,
      taskId,
      projectId,
      stage: 'implementation' as Slug,
      role: 'developer',
      mode: 'normal',
      attempt: 1,
      model: 'claude-opus-5',
      effort: 'high',
      promptVersion: 'test@1',
      systemPrompt: null,
      userPrompt: null,
      redactionCount: 0,
      contextPack: null,
      settings: null,
      reserveUsd: 15,
      promptsWithheld: null,
      providerMode: 'api',
      status: 'running',
      terminalReason: null,
      sessionId: null,
      numTurns: 0,
      usage: null,
      cost: null,
      wallMs: 0,
      createdAt: NOW,
      startedAt: NOW,
    });
    await client.query('update runs set cli_spawn_requested_at = $2 where id = $1', [runId, NOW]);
    await store.offers.insert(tx, {
      id: nextId(),
      runId,
      taskId,
      projectId,
      stage: 'implementation' as Slug,
      attempt: 1,
      kind: 'stage',
      offeredAt: NOW,
    });
    const claimed = await claimRunOffer(store.offers, tx, {
      eligibility: { runId },
      claimantKind: 'server',
      owner: OWNER,
      expiresAt: '2099-01-01T00:00:00.000Z' as IsoDateTime,
      now: NOW,
    });
    expect(claimed?.epoch).toBe(1);
    await client.query('commit');
    return { taskId, runId };
  } finally {
    await client.end();
  }
};

const eventStore = () => new eventing.PostgresEventStore(pool);

const deps = (overrides: Partial<SettleRunDeps> = {}): SettleRunDeps => ({
  unitOfWork: new eventing.PostgresUnitOfWork({ pool }),
  store,
  context: (correlationId) => ({
    ids: { next: () => crypto.randomUUID() as Id },
    actor: { kind: 'system', component: 'test' },
    clock: { now: () => NOW },
    correlationId,
    causeEventId: null,
  }),
  calendar: createWorkingCalendar(),
  ...overrides,
});

/** A failed run: `recordUnsuccessful` → `finish`, the spend, and `escalateOnRun` — every kind of write. */
const FAILED: RunOutcome = {
  runId: '' as Id,
  status: 'failed',
  terminalReason: 'error_during_execution',
  sessionId: 'session-275',
  numTurns: 3,
  usage: {
    input_tokens: 10,
    output_tokens: 20,
    cache_write_5m_tokens: 0,
    cache_write_1h_tokens: 0,
    cache_read_tokens: 0,
  },
  modelUsage: [],
  cost: { usd: 0.25, is_estimate: false, price_list_id: null },
  wallMs: 1000,
  structuredOutput: null,
  error: 'the CLI exited with 1',
  redactionCount: 0,
};

/** The request the job's transaction 1 would have built for this run. */
const requestFor = async (
  taskId: Id,
  runId: Id,
  fence: SettleRunRequest['fence'] = { epoch: 1, owner: OWNER },
): Promise<SettleRunRequest> => {
  const stage = stageOf(
    compilePipeline('feature', FEATURE_TEMPLATE, null, false),
    'implementation',
  );
  if (stage === null) throw new Error('feature has no implementation stage');
  const run: Run = {
    id: runId,
    taskId,
    projectId,
    stage: 'implementation' as Slug,
    role: 'developer',
    mode: 'normal',
    attempt: 1,
    model: 'claude-opus-5',
    effort: 'high',
    promptVersion: 'test@1',
    status: 'running',
    startedAt: NOW,
    lastOutputAt: null,
    endedAt: null,
    terminalReason: null,
    sequence: await eventStore().nextStreamSequence('run', runId),
  };
  return {
    job: { taskId, projectId, stage: 'implementation' as Slug, attempt: 1 },
    settings: {} as SettleRunRequest['settings'],
    stage,
    run,
    outcome: { ...FAILED, runId },
    stopReason: null,
    redactor: redaction.patternRedactor(),
    reviewChecklists: null,
    fence,
  };
};

/** What a settle can change: the run row, the task's spend and version, and the run's terminal events. */
const stateOf = async (taskId: Id, runId: Id) => {
  const run = await pool.query<{
    status: string;
    terminal_reason: string | null;
    lease_epoch: number;
  }>('select status, terminal_reason, lease_epoch from runs where id = $1', [runId]);
  const task = await pool.query<{ cost_actual: string; version: number; state: string }>(
    'select cost_actual, version, state from tasks where id = $1',
    [taskId],
  );
  const terminal = await pool.query<{ count: string }>(
    `select count(*) from events where type in ('run.finished', 'run.failed') and payload->>'run_id' = $1`,
    [runId],
  );
  const all = await pool.query<{ count: string }>(
    'select count(*) from events where correlation_id = $1',
    [taskId],
  );
  return {
    run: run.rows[0],
    task: { ...task.rows[0], cost_actual: Number(task.rows[0]?.cost_actual) },
    terminalEvents: Number(terminal.rows[0]?.count),
    events: Number(all.rows[0]?.count),
  };
};

describe('two settles of one run at once (WP-275, criterion 4)', () => {
  it(`append one terminal event and charge once, in each of ${ITERATIONS} iterations`, async () => {
    const tally = { aSettled: 0, bSettled: 0 };
    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const { taskId, runId } = await seedClaimedRun();
      const request = await requestFor(taskId, runId);
      const results: readonly SettleRunResult[] = await Promise.all([
        settleRun(deps(), request),
        settleRun(deps(), request),
      ]);
      expect(results.map((result) => result.kind).sort(), `iteration ${iteration}`).toEqual([
        'already_settled',
        'settled',
      ]);
      expect(results[0]?.ending).toEqual(results[1]?.ending);
      expect(results[0]?.ending).toEqual({
        runId,
        epoch: 1,
        status: 'failed',
        terminalReason: 'error_during_execution',
      });
      const state = await stateOf(taskId, runId);
      expect(state.terminalEvents).toBe(1);
      expect(state.task.cost_actual).toBeCloseTo(0.25, 6);
      expect(state.task.state).toBe('needs_human');
      if (results[0]?.kind === 'settled') tally.aSettled += 1;
      else tally.bSettled += 1;
    }
    // Which side wins is PostgreSQL's scheduling; both together are every iteration.
    expect(tally.aSettled + tally.bSettled).toBe(ITERATIONS);
  }, 120_000);
});

describe('a second settle waits on the first one’s lock (WP-275, criteria 2 and 4)', () => {
  it('blocks at lockSettlement, then answers the stored result and appends nothing', async () => {
    const { taskId, runId } = await seedClaimedRun();
    const request = await requestFor(taskId, runId);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reachedFinish: () => void = () => {};
    const atFinish = new Promise<void>((resolve) => {
      reachedFinish = resolve;
    });
    /** The first settle stops between its lock and its `finish`, holding the row. */
    const holding: PipelineStore = {
      ...store,
      runs: {
        ...store.runs,
        finish: async (tx, outcome) => {
          reachedFinish();
          await held;
          return store.runs.finish(tx, outcome);
        },
      },
    };
    const first = settleRun(deps({ store: holding }), request);
    await atFinish;
    const second = settleRun(deps(), request);
    // The second settle is waiting on the run row's lock, not running beside the first: its
    // backend waits on a lock while running `lockSettlement`'s statement.
    try {
      await expect
        .poll(
          async () =>
            Number(
              (
                await pool.query<{ count: string }>(
                  `select count(*) from pg_stat_activity
                    where wait_event_type = 'Lock'
                      and query like '%from runs where id = $1 for update%'`,
                )
              ).rows[0]?.count,
            ),
          { timeout: 10_000, interval: 50 },
        )
        .toBe(1);
    } finally {
      release();
    }
    const [a, b] = await Promise.all([first, second]);
    expect(a.kind).toBe('settled');
    expect(b.kind).toBe('already_settled');
    expect(b.ending).toEqual(a.ending);
    expect(b.outcome.kind).toBe('skipped');
    const state = await stateOf(taskId, runId);
    expect(state.terminalEvents).toBe(1);
    expect(state.task.cost_actual).toBeCloseTo(0.25, 6);

    // And a third, later, appends nothing either.
    const before = await stateOf(taskId, runId);
    const third = await settleRun(deps(), request);
    expect(third).toMatchObject({ kind: 'already_settled', ending: a.ending });
    expect(await stateOf(taskId, runId)).toEqual(before);
  }, 60_000);
});

describe('a settle with a stale fence (WP-275, criterion 3)', () => {
  it.each([
    ['a newer epoch', { epoch: 2, owner: OWNER }],
    ['an older epoch', { epoch: 0, owner: OWNER }],
    ['another owner', { epoch: 1, owner: 'server:somebody-else' }],
  ] as const)(
    'is lease_lost and changes nothing — %s',
    async (_name, fence) => {
      const { taskId, runId } = await seedClaimedRun();
      const before = await stateOf(taskId, runId);
      await expect(
        settleRun(deps(), await requestFor(taskId, runId, fence)),
      ).rejects.toBeInstanceOf(LeaseLostError);
      expect(await stateOf(taskId, runId)).toEqual(before);
      expect(before.run?.status).toBe('running');
      // The claim's own settle still ends it.
      const settled = await settleRun(deps(), await requestFor(taskId, runId));
      expect(settled.kind).toBe('settled');
    },
    60_000,
  );

  it('is lease_lost on a settled run too, and changes nothing', async () => {
    const { taskId, runId } = await seedClaimedRun();
    await settleRun(deps(), await requestFor(taskId, runId));
    const before = await stateOf(taskId, runId);
    await expect(
      settleRun(deps(), await requestFor(taskId, runId, { epoch: 2, owner: OWNER })),
    ).rejects.toBeInstanceOf(LeaseLostError);
    expect(await stateOf(taskId, runId)).toEqual(before);
  }, 60_000);
});

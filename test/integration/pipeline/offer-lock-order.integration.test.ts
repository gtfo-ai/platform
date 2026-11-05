/**
 * **One lock order, and the withdrawal against the claim** — WP-276 criteria (3), (4), (9) and (12),
 * TD-031 decision 3 and its 2026-11-04 amendment §5 (backlog 697), against a real PostgreSQL 18.
 *
 * The memory store takes no row lock, so what is asserted here is only what two connections show:
 *
 *  1. **The withdrawal and the claim, in both orders** (criterion 3): the withdrawal's one conditional
 *     `update run_offers … where state = 'open'` held uncommitted makes the claim skip the row (it
 *     never waits) — withdrawn and cancelled; the claim held uncommitted makes the withdrawal wait on
 *     the offer row and then touch nothing — claimed, with a `cancel` run command for its holder.
 *  2. **`run_offers` → `runs` → `tasks`** (criterion 9): a terminal writer (a person's cancel: the
 *     run locked for update, then `finish`) holds its first lock while a withdrawal of the same
 *     run's offer starts, then finishes — no `40P01`, exactly one of them ends the run. The **canary**
 *     puts the old order back (the run locked before its offer) and the same interleaving deadlocks:
 *     PostgreSQL answers one side `40P01`. The canary is the opposite order written in this file —
 *     the source is not mutated — so the property it pins is the order, not a line.
 *  3. **A terminal writer against the claim**: the claim takes `for update of o, r skip locked`, so a
 *     writer holding the run makes the claim answer nothing at once rather than wait.
 *  4. **Cancel mid-run with a real owner** (criterion 12): a run claimed by `server:<process>` at a
 *     live epoch, its record ended by a person's cancel while its session runs on; the claimant's
 *     `settleRun` answers `already_settled` with the stored `cancelled` ending, its measured spend
 *     reaches the ledger once as a `late` cost row, and a second settle writes nothing.
 *  5. **The database unreachable past the TTL** (criterion 4): the server claimant stops its run at
 *     `TTL − ½·renew` — before the lease sweep may end the row at `lease_expires_at + grace`.
 */
import {
  claimRunOffer,
  closeStageOffer,
  createLateCostRecorder,
  createRunClaimant,
  createRunStopReasons,
  createTestRunPlanSealer,
  createWorkingCalendar,
  declarePipelineQueues,
  INITIAL_TASK_VERSION,
  type PipelineStore,
  type RunOutcome,
  type SettleRunDeps,
  type StoredTask,
  settleRun,
  sweepExpiredRunLeases,
  type Transaction,
  unroutedOfferForTest,
} from '@platform/application';
import type { Id, IsoDateTime, Slug } from '@platform/contracts';
import { FEATURE_TEMPLATE, SHIPPED_TEMPLATES } from '@platform/domain';
import { cost, eventing, jobs, pipeline, recovery, redaction } from '@platform/infrastructure';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recentInstant } from '../../support/recent-instant.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestClient, createTestPool } from '../support/postgres.js';

const NOW: IsoDateTime = recentInstant();
const OWNER = 'server:lock-order-test';

let database: MigratedDatabase;
let pool: pg.Pool;
let projectId: Id;
let store: PipelineStore;
let counter = 0;
const nextId = (): Id => {
  counter += 1;
  return `00000000-0000-4000-8276-${counter.toString(16).padStart(12, '0')}` as Id;
};

beforeAll(async () => {
  database = await createMigratedDatabase('offer-lock-order');
  pool = createTestPool(database.connectionString, { max: 10 });
  store = pipeline.createPostgresPipelineStore({ templates: SHIPPED_TEMPLATES });
  const org = await pool.query<{ id: string }>(
    "insert into organizations (name) values ('offer-lock-order') returning id",
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

/** One connection, one transaction, ended exactly once. */
const begin = async () => {
  const client = createTestClient(database.connectionString);
  await client.connect();
  await client.query('begin');
  await client.query("set local deadlock_timeout = '200ms'");
  let ended = false;
  const end = async (verb: 'commit' | 'rollback'): Promise<void> => {
    if (ended) return;
    ended = true;
    try {
      await client.query(verb);
    } finally {
      await client.end();
    }
  };
  return {
    client,
    tx: { adapter: 'postgres', client } as unknown as Transaction,
    commit: async () => end('commit'),
    rollback: async () => end('rollback'),
  };
};

/**
 * A committed task at `implementation` attempt 1 with its stage row, and one run with an `open`
 * stage offer — `created` (the job ended at the offer) or `running` — optionally claimed by
 * {@link OWNER}.
 */
const seed = async (input: {
  readonly status: 'created' | 'running';
  readonly claim: boolean;
}): Promise<{ readonly taskId: Id; readonly runId: Id }> => {
  const setup = await begin();
  try {
    const taskId = nextId();
    await store.tasks.insert(setup.tx, {
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
    } as unknown as StoredTask);
    await setup.client.query(
      `insert into task_stages (task_id, stage, attempt, state) values ($1, 'implementation', 1, 'running')`,
      [taskId],
    );
    const runId = nextId();
    await store.runs.insert(setup.tx, {
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
      contextPack: { tier0: [], tier1: [], budget_tokens: 1000, total_tokens: 0 },
      settings: null,
      reserveUsd: 15,
      promptsWithheld: null,
      providerMode: 'api',
      status: input.status,
      terminalReason: null,
      sessionId: null,
      numTurns: 0,
      usage: null,
      cost: null,
      wallMs: 0,
      createdAt: NOW,
      startedAt: input.status === 'running' ? NOW : null,
    });
    // The run's events so far, so the withdrawal's `run.finished` appends at the next sequence.
    await store.offers.insert(setup.tx, {
      id: nextId(),
      runId,
      taskId,
      projectId,
      stage: 'implementation' as Slug,
      attempt: 1,
      kind: 'stage',
      offeredAt: NOW,
      routing: unroutedOfferForTest(NOW),
    });
    if (input.claim) {
      const claimed = await claimRunOffer(store.offers, setup.tx, {
        eligibility: { runId },
        claimantKind: 'server',
        owner: OWNER,
        expiresAt: '2099-01-01T00:00:00.000Z' as IsoDateTime,
        now: NOW,
      });
      expect(claimed?.epoch).toBe(1);
    }
    await setup.commit();
    return { taskId, runId };
  } catch (error) {
    await setup.rollback();
    throw error;
  }
};

const context = (correlationId: Id) => ({
  ids: { next: () => crypto.randomUUID() as Id },
  actor: { kind: 'system' as const, component: 'test' },
  clock: { now: () => NOW },
  correlationId,
  causeEventId: null,
});

const noBroadcast = { publish: async () => {} };

/** `closeStageOffer` on its own connection: the withdrawal of a stage transition (criterion 3). */
const withdrawal = async (taskId: Id, holder = begin()) => {
  const connection = await holder;
  try {
    const closed = await closeStageOffer(
      { store },
      {
        tx: connection.tx,
        broadcast: noBroadcast,
        events: new eventing.PostgresEventAppender(connection.client, noBroadcast),
      },
      {
        taskId,
        code: 'paused_by_human',
        reason: 'the task was paused by a human',
        context: context(taskId),
      },
    );
    await connection.commit();
    return closed.closing;
  } catch (error) {
    await connection.rollback();
    throw error;
  }
};

const rowsOf = async (runId: Id) => {
  const offer = await pool.query<{ state: string }>(
    'select state from run_offers where run_id = $1',
    [runId],
  );
  const run = await pool.query<{ status: string }>('select status from runs where id = $1', [
    runId,
  ]);
  const commands = await pool.query<{ kind: string }>(
    'select kind from run_commands where run_id = $1',
    [runId],
  );
  return {
    offer: offer.rows[0]?.state,
    run: run.rows[0]?.status,
    commands: commands.rows.map((row) => row.kind),
  };
};

const claimOn = async (connection: Awaited<ReturnType<typeof begin>>, runId: Id) =>
  claimRunOffer(store.offers, connection.tx, {
    eligibility: { runId },
    claimantKind: 'server',
    owner: OWNER,
    expiresAt: '2099-01-01T00:00:00.000Z' as IsoDateTime,
    now: NOW,
  });

describe('the withdrawal against a concurrent claim, in both orders (WP-276 criterion 3)', () => {
  it('withdrawal first: the claim skips the held offer, and the run ends withdrawn and cancelled', async () => {
    const { taskId, runId } = await seed({ status: 'created', claim: false });
    const holder = await begin();
    // The withdrawal's conditional update, held uncommitted.
    expect(
      await store.offers.withdraw(holder.tx, {
        by: { taskId },
        reason: 'paused_by_human',
        now: NOW,
      }),
    ).not.toBeNull();
    const claimant = await begin();
    await claimant.client.query("set local lock_timeout = '2s'");
    expect(await claimOn(claimant, runId)).toBeNull();
    await claimant.commit();
    await holder.rollback();
    // Now the whole withdrawal, uncontended, as a transition runs it.
    expect(await withdrawal(taskId)).toMatchObject({ kind: 'withdrawn', runId });
    expect(await rowsOf(runId)).toEqual({ offer: 'withdrawn', run: 'cancelled', commands: [] });
  });

  it('claim first: the withdrawal waits on the offer, touches nothing, and records a cancel', async () => {
    const { taskId, runId } = await seed({ status: 'created', claim: false });
    const claimant = await begin();
    expect(await claimOn(claimant, runId)).toMatchObject({ epoch: 1 });
    const pending = withdrawal(taskId);
    // The withdrawal is now blocked on the claim's row lock; the claim commits and releases it.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await claimant.commit();
    expect(await pending).toMatchObject({ kind: 'cancel_recorded', runId });
    expect(await rowsOf(runId)).toEqual({
      offer: 'claimed',
      run: 'starting',
      commands: ['cancel'],
    });
  });
});

/**
 * A person's cancel ends an unheld run in place: the run row locked for update, then `finish`. In
 * the one order its first lock is the offer (`lockRun` with `forUpdate`); the canary takes the run
 * first, the order before WP-276.
 */
const cancelInPlace = async (
  connection: Awaited<ReturnType<typeof begin>>,
  runId: Id,
  order: 'offer_first' | 'run_first',
) => {
  if (order === 'offer_first') {
    await store.runCommands.lockRun(connection.tx, runId, { forUpdate: true });
  } else {
    await connection.client.query('select id from runs where id = $1 for update', [runId]);
  }
  return async () =>
    store.runs.finish(connection.tx, {
      runId,
      status: 'cancelled',
      terminalReason: 'cancelled',
      sessionId: null,
      numTurns: 0,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_write_5m_tokens: 0,
        cache_write_1h_tokens: 0,
        cache_read_tokens: 0,
      },
      cost: null,
      wallMs: 0,
    });
};

const sqlStateOf = (error: unknown): string | undefined =>
  (error as { code?: string } | undefined)?.code;

/**
 * **Every terminal writer, in the one order** (criterion 9): each takes its first lock in a
 * transaction held open while a stage transition's withdrawal of the same task's offer starts on a
 * second connection, then ends the run and commits. No `40P01`; the writer ends the run, and the
 * withdrawal — waiting on the offer row — then finds it closed and touches nothing. The settle-shaped
 * writers (a settle, the holder's applied cancel, the take-over's stop, the shutdown hand-back, the
 * ask's ending) lock through `lockSettlement` and finish under the claim's fence; the sweep through
 * `claimExpiredRun`; a person's cancel and a take-over through `lockRun`/`lockLiveRunOf`.
 */
type Writer = {
  readonly name: string;
  readonly claim: boolean;
  readonly kind?: 'stage' | 'ask';
  readonly status: 'completed' | 'cancelled' | 'failed';
  readonly reason:
    | 'success'
    | 'cancelled'
    | 'shutdown'
    | 'lease_expired'
    | 'error_during_execution';
  readonly firstLock: (
    connection: Awaited<ReturnType<typeof begin>>,
    runId: Id,
    taskId: Id,
  ) => Promise<void>;
  readonly fenced: boolean;
};

const settleLock: Writer['firstLock'] = async (connection, runId) => {
  await store.runs.lockSettlement(connection.tx, runId);
};

const WRITERS: readonly Writer[] = [
  {
    name: 'settleRun (a stage run ending)',
    claim: true,
    status: 'completed',
    reason: 'success',
    firstLock: settleLock,
    fenced: true,
  },
  {
    name: "the holder's applied cancel (its settle)",
    claim: true,
    status: 'cancelled',
    reason: 'cancelled',
    firstLock: settleLock,
    fenced: true,
  },
  {
    name: "the take-over's stop (its settle)",
    claim: true,
    status: 'cancelled',
    reason: 'cancelled',
    firstLock: settleLock,
    fenced: true,
  },
  {
    name: 'the shutdown hand-back (its settle)',
    claim: true,
    status: 'failed',
    reason: 'shutdown',
    firstLock: settleLock,
    fenced: true,
  },
  {
    name: "the ask's ending",
    claim: true,
    kind: 'ask',
    status: 'completed',
    reason: 'success',
    firstLock: settleLock,
    fenced: true,
  },
  {
    name: 'the lease sweep',
    claim: true,
    status: 'failed',
    reason: 'lease_expired',
    fenced: false,
    firstLock: async (connection, runId) => {
      await connection.client.query(
        "update runs set lease_expires_at = now() - interval '1 hour' where id = $1",
        [runId],
      );
      const claimed = await recovery
        .createPostgresExpiredRunStore()
        .claimExpiredRun(connection.tx, {
          runId,
          query: {
            leaseExpiredBefore: '2999-01-01T00:00:00.000Z' as IsoDateTime,
            startedBefore: '1999-01-01T00:00:00.000Z' as IsoDateTime,
            limit: 1,
          },
        });
      expect(claimed).toBe(true);
    },
  },
  {
    name: "a person's cancel (lockRun)",
    claim: false,
    status: 'cancelled',
    reason: 'cancelled',
    fenced: false,
    firstLock: async (connection, runId) => {
      await store.runCommands.lockRun(connection.tx, runId, { forUpdate: true });
    },
  },
  {
    name: 'a take-over (lockLiveRunOf)',
    claim: true,
    status: 'cancelled',
    reason: 'cancelled',
    fenced: false,
    firstLock: async (connection, _runId, taskId) => {
      await store.runCommands.lockLiveRunOf(connection.tx, taskId, { forUpdate: true });
    },
  },
];

describe('every terminal writer against a withdrawal, in the one order (WP-276 criterion 9)', () => {
  it.each(WRITERS.map((writer) => [writer.name, writer] as const))(
    '%s: no 40P01, and exactly one of them ends the run',
    async (_name, writer) => {
      const { taskId, runId } = await seed({ status: 'created', claim: writer.claim });
      if (writer.kind === 'ask') {
        await pool.query("update run_offers set kind = 'ask', stage = null where run_id = $1", [
          runId,
        ]);
      }
      const connection = await begin();
      await writer.firstLock(connection, runId, taskId);
      const pending = withdrawal(taskId).then(
        (closing) => ({ ok: true as const, closing }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      const ended = await store.runs.finish(connection.tx, {
        runId,
        status: writer.status,
        terminalReason: writer.reason,
        sessionId: null,
        numTurns: 0,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_write_5m_tokens: 0,
          cache_write_1h_tokens: 0,
          cache_read_tokens: 0,
        },
        cost: null,
        wallMs: 0,
        ...(writer.fenced ? { lease: { epoch: 1, owner: OWNER } } : {}),
      });
      await connection.commit();
      const withdrawn = await pending;
      expect(withdrawn.ok, sqlStateOf(withdrawn.ok ? undefined : withdrawn.error)).toBe(true);
      expect(ended).toBe(true);
      expect(withdrawn.ok && withdrawn.closing.kind).toBe('none');
      expect((await rowsOf(runId)).run).toBe(writer.status);
    },
    60_000,
  );
});

describe('one lock order, run_offers → runs → tasks (WP-276 criterion 9, backlog 697)', () => {
  it('a terminal writer holding its first lock and a withdrawal of the same run: no 40P01, exactly one ends it', async () => {
    const { taskId, runId } = await seed({ status: 'created', claim: false });
    const writer = await begin();
    const finish = await cancelInPlace(writer, runId, 'offer_first');
    const pending = withdrawal(taskId).then(
      (closing) => ({ ok: true as const, closing }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    const ended = await finish();
    await writer.commit();
    const withdrawn = await pending;
    expect(withdrawn.ok, sqlStateOf(withdrawn.ok ? undefined : withdrawn.error)).toBe(true);
    // The writer ended it; the withdrawal then found the offer closed and touched nothing.
    expect(ended).toBe(true);
    expect(withdrawn.ok && withdrawn.closing.kind).toBe('none');
    expect(await rowsOf(runId)).toMatchObject({ offer: 'withdrawn', run: 'cancelled' });
  });

  it('the canary: the old order — the run before its offer — deadlocks the same interleaving (40P01)', async () => {
    const { taskId, runId } = await seed({ status: 'created', claim: false });
    const writer = await begin();
    const finish = await cancelInPlace(writer, runId, 'run_first');
    const pending = withdrawal(taskId).then(
      () => null,
      (error: unknown) => sqlStateOf(error),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    const writerState = await finish().then(
      () => null,
      (error: unknown) => sqlStateOf(error),
    );
    await writer.rollback();
    const states = [writerState, await pending];
    expect(states).toContain('40P01');
  });

  it('a terminal writer holding the run makes a claim answer nothing at once, never wait', async () => {
    const { runId } = await seed({ status: 'created', claim: false });
    const writer = await begin();
    const finish = await cancelInPlace(writer, runId, 'offer_first');
    const claimant = await begin();
    await claimant.client.query("set local lock_timeout = '2s'");
    expect(await claimOn(claimant, runId)).toBeNull();
    await claimant.commit();
    expect(await finish()).toBe(true);
    await writer.commit();
    expect(await rowsOf(runId)).toMatchObject({ offer: 'withdrawn', run: 'cancelled' });
  });
});

/** The settle's collaborators over PostgreSQL, with the production late-cost recorder. */
const settleDeps = (): SettleRunDeps => ({
  unitOfWork: new eventing.PostgresUnitOfWork({ pool }),
  store,
  context,
  calendar: createWorkingCalendar(),
  redactor: redaction.patternRedactor(),
  settings: async () => ({ configRefusal: 'seeded run, no settings' }) as never,
  jobs: { enqueue: async () => ({ status: 'enqueued', jobId: 'job-276' }) } as never,
  lateCost: createLateCostRecorder({
    store: cost.createPostgresCostStore(),
    runs: store.runs,
    tasks: store.tasks,
    context: (correlationId, causeEventId) => ({
      ...context(correlationId),
      causeEventId,
    }),
  }),
});

const MEASURED: RunOutcome = {
  runId: '' as Id,
  status: 'cancelled',
  terminalReason: 'cancelled',
  sessionId: 'session-276',
  numTurns: 2,
  usage: {
    input_tokens: 100,
    output_tokens: 50,
    cache_write_5m_tokens: 0,
    cache_write_1h_tokens: 0,
    cache_read_tokens: 0,
  },
  modelUsage: [],
  cost: { usd: 0.42, is_estimate: false, price_list_id: null },
  wallMs: 5000,
  structuredOutput: null,
  error: null,
  redactionCount: 0,
};

const countsOf = async (runId: Id) => {
  const events = await pool.query<{ count: string }>(
    "select count(*) from events where payload->>'run_id' = $1",
    [runId],
  );
  const entries = await pool.query<{ count: string; late: number }>(
    'select count(*), count(*) filter (where late)::int as late from cost_entries where run_id = $1',
    [runId],
  );
  const runs = await pool.query<{ status: string; usd: string | null }>(
    'select status, usd_reported as usd from runs where id = $1',
    [runId],
  );
  return {
    events: Number(events.rows[0]?.count),
    costEntries: Number(entries.rows[0]?.count),
    late: Number(entries.rows[0]?.late),
    run: runs.rows[0],
  };
};

describe('cancel mid-run with a real owner, through PostgreSQL (WP-276 criterion 12)', () => {
  it('the claimant’s settle answers already_settled with the stored cancelled ending, charges once late, and repeats nothing', async () => {
    const { runId } = await seed({ status: 'running', claim: true });
    await pool.query('update runs set cli_spawn_requested_at = $2 where id = $1', [runId, NOW]);
    // A person's cancel ends the record in place while the session runs on.
    const person = await begin();
    const finish = await cancelInPlace(person, runId, 'offer_first');
    expect(await finish()).toBe(true);
    await person.commit();

    const first = await settleRun(settleDeps(), {
      runId,
      fence: { epoch: 1, owner: OWNER },
      outcome: { ...MEASURED, runId },
      stopReason: null,
    });
    expect(first.kind).toBe('already_settled');
    expect(first.ending).toMatchObject({
      status: 'cancelled',
      terminalReason: 'cancelled',
      epoch: 1,
    });
    const after = await countsOf(runId);
    expect(after.late).toBeGreaterThan(0);
    expect(after.late).toBe(after.costEntries);
    expect(Number(after.run?.usd)).toBeCloseTo(0.42, 6);

    const second = await settleRun(settleDeps(), {
      runId,
      fence: { epoch: 1, owner: OWNER },
      outcome: { ...MEASURED, runId },
      stopReason: null,
    });
    expect(second.kind).toBe('already_settled');
    expect(await countsOf(runId)).toEqual(after);
  }, 60_000);
});

describe('the database unreachable past the TTL (WP-276 criterion 4)', () => {
  /**
   * The claim commits; then every transaction the claimant opens waits on `gate` and fails as an
   * unreachable database would. The self-stop fires at `TTL − ½·renew` on the claimant's monotonic
   * clock while the read-back of its plan is still waiting, so when that read fails the claimant has
   * already given up: it settles nothing. The sweep, on the database's clock, may end the row only
   * at `lease_expires_at + APP_LEASE_SKEW_GRACE` — and does then, not a second before.
   */
  it('the server claimant gives up at TTL − ½·renew and pushes nothing; the sweep acts only after the grace', async () => {
    const { runId } = await seed({ status: 'created', claim: false });
    let monotonic = 0;
    const timers: { at: number; fire: () => void }[] = [];
    const unitOfWork = new eventing.PostgresUnitOfWork({ pool });
    let opened = 0;
    let openGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const flaky = {
      transaction: async <T>(fn: Parameters<typeof unitOfWork.transaction<T>>[0]): Promise<T> => {
        opened += 1;
        if (opened === 1) return unitOfWork.transaction(fn); // the claim
        await gate;
        throw new Error('connect ECONNREFUSED: the database is unreachable');
      },
    };
    const settled: unknown[] = [];
    let started = 0;
    const claimant = createRunClaimant({
      unitOfWork: flaky,
      store,
      runner: {
        start: () => {
          started += 1;
          throw new Error('a claimant that gave up must not start the run');
        },
      },
      stopReasons: createRunStopReasons(),
      context,
      clock: { now: () => NOW },
      runPlans: createTestRunPlanSealer(),
      lease: {
        owner: OWNER,
        schedule: () => () => {},
        monotonicNow: () => monotonic,
        timer: (afterMs, fire) => {
          timers.push({ at: monotonic + afterMs, fire });
          return () => {};
        },
      },
      settle: {
        stage: async (request) => {
          settled.push(request);
          return { kind: 'settled' };
        },
        ask: async () => ({ kind: 'settled' }),
      },
    });
    const drained = claimant.drain();
    for (let tries = 0; tries < 50 && opened < 2; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const lease = await pool.query<{ expires: Date; status: string; owner: string }>(
      'select lease_expires_at as expires, status, lease_owner as owner from runs where id = $1',
      [runId],
    );
    expect(lease.rows[0]).toMatchObject({ status: 'starting', owner: OWNER });
    // 249.999 s without a renewal: still running. 250 s: it gives up.
    monotonic = 249_999;
    for (const timer of timers) if (timer.at <= monotonic) timer.fire();
    expect(timers.some((timer) => timer.at === 250_000)).toBe(true);
    monotonic = 250_000;
    for (const timer of timers) if (timer.at <= monotonic) timer.fire();
    openGate();
    await drained;
    expect(settled, 'a self-terminated claimant pushes nothing more').toEqual([]);
    expect(started).toBe(0);
    // The sweep may act only at lease_expires_at + grace.
    const expires = new Date(lease.rows[0]?.expires as Date).getTime();
    // WP-286: the swept run is its entry's first loss, so the sweep re-plans it into this queue.
    const queue = jobs.createInMemoryJobs().jobs;
    await declarePipelineQueues(queue);
    const sweepAt = (ms: number) =>
      sweepExpiredRunLeases({
        store: recovery.createPostgresExpiredRunStore(),
        pipeline: store,
        unitOfWork,
        context,
        clock: { now: () => new Date(ms).toISOString() as IsoDateTime },
        graceMs: 60_000,
        skewGraceMs: 120_000,
        wallClockMs: 3_600_000,
        limit: 10,
        replan: { jobs: queue, revokeCredentials: async () => {} },
      });
    expect((await sweepAt(expires + 119_000)).ended).toBe(0);
    expect((await sweepAt(expires + 121_000)).ended).toBe(1);
    expect((await pool.query('select status from runs where id = $1', [runId])).rows[0]).toEqual({
      status: 'failed',
    });
  }, 60_000);
});

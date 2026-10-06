/**
 * A human command reaches a live run through the database — WP-85, TD-028 decision 9, against a
 * real PostgreSQL 18.
 *
 * The contract suite holds the in-memory store's `run_commands` predicates to PostgreSQL's one call
 * at a time; what only a database can show is the **interleaving**, so every case here opens its
 * transactions on separate connections and lets PostgreSQL's locks decide the order:
 *
 *  1. **A command for a run that ended is never applied late (criterion 3)** — in both orders. A
 *     command that holds the run `for share` makes the ending wait, and the ending then closes it
 *     `run_ended`; an ending in progress makes the command wait, and the command then reads the run
 *     terminal. And the holder's stamp waits for an ending in progress and then writes nothing.
 *  2. **With `LISTEN` down, the heartbeat applies the command within one beat (criterion 2)** — the
 *     real `PostgresBroadcast`, closed before the command commits, so its notification reaches
 *     nobody, and the real heartbeat with one driven beat.
 *  3. **With `LISTEN` up, the notification alone applies it** — no beat at all.
 *  4. **The steer window is one window** (WP-101, backlog 295): a second steer by the same user in
 *     another transaction waits on the user's advisory lock and is then refused.
 */
import {
  countingStartHooks,
  createLiveRuns,
  createRunCommandInbox,
  INITIAL_TASK_VERSION,
  type PipelineStore,
  type RunCommandInstruction,
  type RunHandle,
  runCommandsTopic,
  type SteerMessage,
  type StoredTask,
  startRunHeartbeat,
  type Transaction,
} from '@platform/application';
import type { Id, IsoDateTime, Slug } from '@platform/contracts';
import { FEATURE_TEMPLATE, SHIPPED_TEMPLATES } from '@platform/domain';
import { broadcast as broadcastAdapters, eventing, pipeline } from '@platform/infrastructure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestClient, createTestPool } from '../support/postgres.js';

const OWNER = 'runner-host:0000cafe';
const NOW = '2026-09-28T09:00:00.000Z' as IsoDateTime;

let database: MigratedDatabase;
let projectId: Id;
let userId: Id;
let store: PipelineStore;
let counter = 0;
const nextId = (): Id => {
  counter += 1;
  return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, '0')}` as Id;
};

beforeAll(async () => {
  database = await createMigratedDatabase('run-commands');
  store = pipeline.createPostgresPipelineStore({ templates: SHIPPED_TEMPLATES });
  const client = createTestClient(database.connectionString);
  await client.connect();
  try {
    const org = await client.query<{ id: string }>(
      "insert into organizations (name) values ('run-commands') returning id",
    );
    const project = await client.query<{ id: string }>(
      `insert into projects (org_id, key, name, repo_url)
       values ($1, 'api', 'API', 'https://git.example.test/acme/api.git') returning id`,
      [org.rows[0]?.id],
    );
    projectId = project.rows[0]?.id as Id;
    const user = await client.query<{ id: string }>(
      `insert into users (email, name) values ('operator@example.test', 'Operator') returning id`,
    );
    userId = user.rows[0]?.id as Id;
  } finally {
    await client.end();
  }
}, 120_000);

afterAll(async () => {
  await database?.drop();
});

/** One connection, one transaction, ended exactly once. */
const begin = async () => {
  const client = createTestClient(database.connectionString);
  await client.connect();
  await client.query('begin');
  const { rows } = await client.query<{ pid: number }>('select pg_backend_pid() as pid');
  let ended = false;
  const end = async (verb: 'commit' | 'rollback'): Promise<void> => {
    if (ended) {
      return;
    }
    ended = true;
    await client.query(verb);
    await client.end();
  };
  return {
    tx: { adapter: 'postgres', client } as unknown as Transaction,
    pid: rows[0]?.pid as number,
    commit: async () => end('commit'),
    rollback: async () => end('rollback'),
  };
};

/**
 * Waits until the backend `pid` is blocked on a lock — bounded (standing rule 2: the wait is for
 * the state, never for a duration), and a failure names what it was waiting for.
 */
const blockedOnLock = async (pid: number): Promise<void> => {
  const probe = createTestClient(database.connectionString);
  await probe.connect();
  try {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const { rows } = await probe.query<{ waiting: boolean }>(
        "select wait_event_type = 'Lock' as waiting from pg_stat_activity where pid = $1",
        [pid],
      );
      if (rows[0]?.waiting === true) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`backend ${pid} never blocked on a lock`);
  } finally {
    await probe.end();
  }
};

/** A committed task with one `running` run leased to {@link OWNER}. */
const liveRun = async (): Promise<{ runId: Id; taskId: Id }> => {
  const setup = await begin();
  const taskId = nextId();
  const stored: StoredTask = {
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
  await store.tasks.insert(setup.tx, stored);
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
    contextPack: null,
    settings: null,
    reserveUsd: null,
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
  await store.runs.renewLease(setup.tx, { runId, owner: OWNER, expiresAt: NOW });
  await setup.commit();
  return { runId, taskId };
};

const steer = (text: string): RunCommandInstruction => ({
  kind: 'steer',
  text,
  authorUserId: userId,
  authorLabel: 'Operator',
});

const finishIn = (tx: Transaction, runId: Id): Promise<boolean> =>
  store.runs.finish(tx, {
    runId,
    status: 'completed',
    terminalReason: 'success',
    sessionId: 'session-1',
    numTurns: 1,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_write_5m_tokens: 0,
      cache_write_1h_tokens: 0,
      cache_read_tokens: 0,
    },
    cost: { usd: 0.01, is_estimate: false, price_list_id: null },
    wallMs: 10,
  });

const rowOf = async (id: Id) => {
  const client = createTestClient(database.connectionString);
  await client.connect();
  try {
    const { rows } = await client.query<{
      applied_at: Date | null;
      refused_reason: string | null;
    }>('select applied_at, refused_reason from run_commands where id = $1', [id]);
    return rows[0] ?? null;
  } finally {
    await client.end();
  }
};

describe('a command for a run that ended is never applied late (criterion 3)', () => {
  it('command first: the ending waits for it, then closes it run_ended', async () => {
    const run = await liveRun();
    const command = await begin();
    const locked = await store.runCommands.lockRun(command.tx, run.runId);
    expect(locked?.status).toBe('running');
    const id = nextId();
    await store.runCommands.insert(command.tx, {
      id,
      ...run,
      actorUserId: userId,
      instruction: steer('in the nick of time'),
    });

    const ending = await begin();
    const finished = finishIn(ending.tx, run.runId);
    await blockedOnLock(ending.pid);
    await command.commit();
    expect(await finished).toBe(true);
    await ending.commit();

    expect(await rowOf(id)).toEqual({ applied_at: null, refused_reason: 'run_ended' });
  });

  it('ending first: the command waits for it, then reads the run terminal and records nothing', async () => {
    const run = await liveRun();
    const ending = await begin();
    expect(await finishIn(ending.tx, run.runId)).toBe(true);

    const command = await begin();
    const locking = store.runCommands.lockRun(command.tx, run.runId);
    await blockedOnLock(command.pid);
    await ending.commit();
    expect((await locking)?.status).toBe('completed');
    await command.rollback();
  });

  it('the holder’s stamp waits for an ending in progress, then writes nothing', async () => {
    const run = await liveRun();
    const recording = await begin();
    const id = nextId();
    await store.runCommands.insert(recording.tx, {
      id,
      ...run,
      actorUserId: userId,
      instruction: steer('racing the end'),
    });
    await recording.commit();

    const ending = await begin();
    expect(await finishIn(ending.tx, run.runId)).toBe(true);
    const holder = await begin();
    const stamping = store.runCommands.markApplied(holder.tx, { id, owner: OWNER });
    await blockedOnLock(holder.pid);
    await ending.commit();
    expect(await stamping).toBe(false);
    await holder.commit();

    expect(await rowOf(id)).toEqual({ applied_at: null, refused_reason: 'run_ended' });
  });
});

/**
 * WP-101, PROGRESS backlog 295: technical/08's steer window is **shared state**. Two steers by one
 * user in two processes are two transactions on two connections, and at READ COMMITTED each would
 * read "no steer yet" and insert — which is what a per-process `Map` did N times over. The
 * advisory lock `admitSteer` takes is what makes the second wait for the first and then read it.
 *
 * **The canary is this case**: with the `pg_advisory_xact_lock` statement removed from
 * `postgres-run-commands.ts`'s `admitSteer`, the second transaction never blocks —
 * `blockedOnLock` throws *"backend … never blocked on a lock"* — and it admits a second steer.
 */
describe('the steer window is one window for every process (WP-101, criterion 5)', () => {
  const freshUser = async (): Promise<Id> => {
    const client = createTestClient(database.connectionString);
    await client.connect();
    try {
      const { rows } = await client.query<{ id: string }>(
        'insert into users (email, name) values ($1, $2) returning id',
        [`steerer-${nextId()}@example.test`, 'Steerer'],
      );
      return rows[0]?.id as Id;
    } finally {
      await client.end();
    }
  };

  it('makes a second steer by the same user wait for the first to commit, then refuses it', async () => {
    const run = await liveRun();
    const author = await freshUser();
    const window = { userId: author, windowMs: 5_000 };

    const first = await begin();
    expect(await store.runCommands.admitSteer(first.tx, window)).toBe(true);
    await store.runCommands.insert(first.tx, {
      id: nextId(),
      ...run,
      actorUserId: author,
      instruction: { kind: 'steer', text: 'first', authorUserId: author, authorLabel: 'Steerer' },
    });

    const second = await begin();
    const admitting = store.runCommands.admitSteer(second.tx, window);
    // The second process waits on the user's lock, not on anything the first holds by accident.
    await blockedOnLock(second.pid);
    await first.commit();
    expect(await admitting).toBe(false);
    await second.rollback();

    // Per user: a colleague's window is their own.
    const colleague = await freshUser();
    const other = await begin();
    expect(await store.runCommands.admitSteer(other.tx, { ...window, userId: colleague })).toBe(
      true,
    );
    await other.rollback();
  });

  it('forgets a steer once it is older than the window', async () => {
    const run = await liveRun();
    const author = await freshUser();
    const seed = createTestClient(database.connectionString);
    await seed.connect();
    try {
      await seed.query(
        `insert into run_commands (id, run_id, task_id, kind, payload, actor_user_id, created_at)
         values ($1, $2, $3, 'steer', $4::jsonb, $5, now() - interval '6 seconds')`,
        [
          nextId(),
          run.runId,
          run.taskId,
          JSON.stringify({ text: 'old', author_user_id: author, author_label: 'Steerer' }),
          author,
        ],
      );
    } finally {
      await seed.end();
    }
    const check = await begin();
    expect(await store.runCommands.admitSteer(check.tx, { userId: author, windowMs: 5_000 })).toBe(
      true,
    );
    // …and the same row is inside a window one second longer (rule 42, the other side).
    expect(await store.runCommands.admitSteer(check.tx, { userId: author, windowMs: 7_000 })).toBe(
      false,
    );
    await check.rollback();
  });
});

describe('the kinds a row may carry (migration 0064, WP-101)', () => {
  it('admits cancel beside steer and take_over, and refuses a kind it does not know', async () => {
    const run = await liveRun();
    const seed = createTestClient(database.connectionString);
    await seed.connect();
    try {
      await seed.query(
        `insert into run_commands (id, run_id, task_id, kind, payload)
         values ($1, $2, $3, 'cancel', '{}'::jsonb)`,
        [nextId(), run.runId, run.taskId],
      );
      await expect(
        seed.query(
          `insert into run_commands (id, run_id, task_id, kind, payload)
           values ($1, $2, $3, 'pause', '{}'::jsonb)`,
          [nextId(), run.runId, run.taskId],
        ),
      ).rejects.toThrow(/run_commands_kind_known/);
    } finally {
      await seed.end();
    }
  });
});

describe('a row the holder cannot read (WP-85 review round 1)', () => {
  it('is refused undecodable by itself, and the rows behind it still apply', async () => {
    const run = await liveRun();
    const seed = createTestClient(database.connectionString);
    await seed.connect();
    const bad = nextId();
    try {
      await seed.query(
        `insert into run_commands (id, run_id, task_id, kind, payload, created_at)
         values ($1, $2, $3, 'steer', '{"not": "a steer"}'::jsonb, now() - interval '1 minute')`,
        [bad, run.runId, run.taskId],
      );
    } finally {
      await seed.end();
    }
    const good = nextId();
    const recording = await begin();
    await store.runCommands.insert(recording.tx, {
      id: good,
      ...run,
      actorUserId: userId,
      instruction: steer('readable'),
    });
    await recording.commit();

    const steers: SteerMessage[] = [];
    const live = createLiveRuns();
    live
      .observe({
        start: () => ({
          runId: run.runId,
          sessionId: null,
          outcome: new Promise(() => undefined),
          steer: async (message: SteerMessage) => {
            steers.push(message);
          },
          stop: async () => undefined,
        }),
      })
      .start({ runId: run.runId, taskId: run.taskId } as never, countingStartHooks());
    const pool = createTestPool(database.connectionString, { max: 2 });
    const inbox = createRunCommandInbox({
      unitOfWork: new eventing.PostgresUnitOfWork({ pool }),
      store,
      liveRuns: live,
      owner: OWNER,
    });
    try {
      await inbox.drain();
    } finally {
      await inbox.stop();
      await pool.end();
    }

    expect(await rowOf(bad)).toEqual({ applied_at: null, refused_reason: 'undecodable' });
    expect((await rowOf(good))?.applied_at).not.toBeNull();
    expect(steers.map((message) => message.text)).toEqual(['readable']);
  });
});

describe('the holder applies a command recorded in another process', () => {
  /** The holder's register with one live handle that records the turns it was given. */
  const holding = (runId: Id, taskId: Id) => {
    const steers: SteerMessage[] = [];
    const handle: RunHandle = {
      runId,
      sessionId: 'session-1',
      outcome: new Promise(() => undefined),
      steer: async (message) => {
        steers.push(message);
      },
      stop: async () => undefined,
    };
    const live = createLiveRuns();
    live.observe({ start: () => handle }).start({ runId, taskId } as never, countingStartHooks());
    return { live, steers };
  };

  /** What the API process does: record the row and `pg_notify` the owner, in one transaction. */
  const recordAndNotify = async (
    unitOfWork: eventing.PostgresUnitOfWork,
    run: { runId: Id; taskId: Id },
    text: string,
  ): Promise<Id> => {
    const id = nextId();
    await unitOfWork.transaction(async (scope) => {
      const locked = await store.runCommands.lockRun(scope.tx, run.runId);
      await store.runCommands.insert(scope.tx, {
        id,
        ...run,
        actorUserId: userId,
        instruction: steer(text),
      });
      await scope.broadcast.publish({
        topic: runCommandsTopic(locked?.leaseOwner as string),
        payload: { lease_owner: locked?.leaseOwner as string, run_id: run.runId },
      });
    });
    return id;
  };

  it('with LISTEN disconnected, applies it within one heartbeat (criterion 2)', async () => {
    const run = await liveRun();
    const pool = createTestPool(database.connectionString, { max: 3 });
    const unitOfWork = new eventing.PostgresUnitOfWork({ pool });
    const listening = new broadcastAdapters.PostgresBroadcast({
      connectionString: database.connectionString,
      publisher: pool,
    });
    const { live, steers } = holding(run.runId, run.taskId);
    const inbox = createRunCommandInbox({ unitOfWork, store, liveRuns: live, owner: OWNER });
    try {
      await inbox.listen(listening);
      await inbox.drain();
      // The holder's LISTEN goes away before the command commits: its notification reaches nobody.
      await listening.close();
      const id = await recordAndNotify(unitOfWork, run, 'heard on the beat');
      expect((await rowOf(id))?.applied_at ?? null).toBeNull();

      let beat: () => void = () => undefined;
      let beaten: () => void = () => undefined;
      const drained = new Promise<void>((resolve) => {
        beaten = resolve;
      });
      const stop = startRunHeartbeat(
        {
          unitOfWork,
          store,
          clock: { now: () => NOW },
          lease: {
            owner: OWNER,
            schedule: (_every, fire) => {
              beat = fire;
              return () => undefined;
            },
            onRenewed: async (runId) => {
              await inbox.drain({ runId, onMiss: 'refuse' });
              beaten();
            },
          },
        },
        run.runId,
      );
      beat();
      // Bounded, and named when it fails: a beat that never reaches the inbox is the defect.
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        drained,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('the heartbeat never drained the command')),
            5_000,
          );
        }),
      ]).finally(() => clearTimeout(timer));
      await stop();

      expect(steers.map((message) => message.text)).toEqual(['heard on the beat']);
      expect((await rowOf(id))?.applied_at).not.toBeNull();
    } finally {
      await inbox.stop();
      await pool.end();
    }
  });

  it('with LISTEN up, the notification alone applies it — no beat', async () => {
    const run = await liveRun();
    const pool = createTestPool(database.connectionString, { max: 3 });
    const unitOfWork = new eventing.PostgresUnitOfWork({ pool });
    const listening = new broadcastAdapters.PostgresBroadcast({
      connectionString: database.connectionString,
      publisher: pool,
    });
    const { live, steers } = holding(run.runId, run.taskId);
    const inbox = createRunCommandInbox({ unitOfWork, store, liveRuns: live, owner: OWNER });
    try {
      await inbox.listen(listening);
      await inbox.drain();
      const id = await recordAndNotify(unitOfWork, run, 'heard on the notification');

      // Bounded: the wait is for the stamp, and a failure says what never happened.
      for (let attempt = 0; attempt < 200 && steers.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await inbox.drain();

      expect(steers.map((message) => message.text)).toEqual(['heard on the notification']);
      expect((await rowOf(id))?.applied_at).not.toBeNull();
    } finally {
      await inbox.stop();
      await listening.close();
      await pool.end();
    }
  });
});

/**
 * Unit tests for the pg-boss adapter's *mapping*: what the port's vocabulary becomes in pg-boss's.
 *
 * They drive the `PgBossLike` seam with a recording stub, so every branch runs without a database.
 * That the mapping is also *correct* — that `singletonSeconds` really does collapse a burst — is
 * what `test/integration/jobs/pg-boss-jobs.integration.test.ts` proves against the real library.
 */
import { JobsValidationError } from '@platform/application';
import { PgBoss } from 'pg-boss';
import { describe, expect, it, vi } from 'vitest';
import {
  asJobsDatabase,
  createPgBossJobs,
  DEFAULT_JOBS_SCHEMA,
  type PgBossJobRecord,
  type PgBossLike,
  type PgBossScheduleRecord,
  wrapPgBoss,
} from './pg-boss-jobs.js';

interface Recorder {
  readonly boss: PgBossLike;
  readonly calls: { method: string; args: unknown[] }[];
  readonly workers: Map<string, (jobs: readonly PgBossJobRecord[]) => Promise<void>>;
  sendResult: string | null;
  schedules: PgBossScheduleRecord[];
}

const recorder = (): Recorder => {
  const calls: { method: string; args: unknown[] }[] = [];
  const workers = new Map<string, (jobs: readonly PgBossJobRecord[]) => Promise<void>>();
  const state: Recorder = {
    calls,
    workers,
    sendResult: 'job-1',
    schedules: [],
    boss: {
      start: async () => {
        calls.push({ method: 'start', args: [] });
      },
      stop: async (options) => {
        calls.push({ method: 'stop', args: [options] });
      },
      createQueue: async (name, options) => {
        calls.push({ method: 'createQueue', args: [name, options] });
      },
      send: async (name, data, options) => {
        calls.push({ method: 'send', args: [name, data, options] });
        return state.sendResult;
      },
      work: async (name, options, handler) => {
        calls.push({ method: 'work', args: [name, options] });
        workers.set(name, handler);
        return `worker-${name}`;
      },
      offWork: async (name, options) => {
        calls.push({ method: 'offWork', args: [name, options] });
      },
      schedule: async (name, cron, data, options) => {
        calls.push({ method: 'schedule', args: [name, cron, data, options] });
      },
      unschedule: async (name, key) => {
        calls.push({ method: 'unschedule', args: [name, key] });
      },
      getSchedules: async (name) => {
        calls.push({ method: 'getSchedules', args: [name] });
        return state.schedules;
      },
      on: () => undefined,
    },
  };
  return state;
};

const lastCall = (state: Recorder, method: string): unknown[] => {
  const found = [...state.calls].reverse().find((call) => call.method === method);
  if (found === undefined) {
    throw new Error(`no ${method} call was recorded`);
  }
  return found.args;
};

describe('construction', () => {
  it('requires exactly one of a database handle or a connection string', () => {
    expect(() => createPgBossJobs()).toThrow(JobsValidationError);
    expect(() =>
      createPgBossJobs({
        database: { executeSql: async () => ({ rows: [] }) },
        connectionString: 'postgres://x',
      }),
    ).toThrow(JobsValidationError);
  });

  it('installs into the same schema the migrator uses', () => {
    expect(DEFAULT_JOBS_SCHEMA).toBe('pgboss');
  });

  it('routes pg-boss background errors to the supplied sink', async () => {
    const state = recorder();
    const errors: unknown[] = [];
    const on = vi.fn();
    createPgBossJobs({ pgBoss: { ...state.boss, on }, onError: (error) => errors.push(error) });
    expect(on).toHaveBeenCalledWith('error', expect.any(Function));

    // The registered listener is the sink we passed.
    const listener = on.mock.calls[0]?.[1] as (error: unknown) => void;
    listener(new Error('boom'));
    expect(errors.map(String)).toEqual(['Error: boom']);
  });

  it('warns rather than swallowing when no sink is supplied', () => {
    const state = recorder();
    const on = vi.fn();
    const emitWarning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    try {
      createPgBossJobs({ pgBoss: { ...state.boss, on } });
      const listener = on.mock.calls[0]?.[1] as (error: unknown) => void;
      listener(new Error('boom'));
      expect(emitWarning).toHaveBeenCalledWith('Error: boom');
    } finally {
      emitWarning.mockRestore();
    }
  });
});

describe('defineQueue', () => {
  it('maps the port vocabulary onto pg-boss queue options', async () => {
    const state = recorder();
    const runtime = createPgBossJobs({ pgBoss: state.boss });

    await runtime.jobs.defineQueue({
      name: 'stage.execute',
      policy: 'stately',
      retryLimit: 3,
      retryDelaySeconds: 30,
      retryBackoff: true,
      expireInSeconds: 600,
      deleteAfterSeconds: 86_400,
      deadLetterQueue: 'stage.execute.dead',
    });

    expect(lastCall(state, 'createQueue')).toEqual([
      'stage.execute',
      {
        policy: 'stately',
        retryLimit: 3,
        retryDelay: 30,
        retryBackoff: true,
        expireInSeconds: 600,
        deleteAfterSeconds: 86_400,
        deadLetter: 'stage.execute.dead',
      },
    ]);
  });

  it('omits every option the caller did not set', async () => {
    const state = recorder();
    const runtime = createPgBossJobs({ pgBoss: state.boss });
    await runtime.jobs.defineQueue({ name: 'dispatch' });
    expect(lastCall(state, 'createQueue')).toEqual(['dispatch', {}]);
  });

  it('validates both names before touching the database', async () => {
    const state = recorder();
    const runtime = createPgBossJobs({ pgBoss: state.boss });
    await expect(runtime.jobs.defineQueue({ name: 'Nope' })).rejects.toThrow(JobsValidationError);
    await expect(runtime.jobs.defineQueue({ name: 'ok', deadLetterQueue: 'Nope' })).rejects.toThrow(
      /dead letter queue/,
    );
    expect(state.calls.filter((call) => call.method === 'createQueue')).toHaveLength(0);
  });
});

describe('enqueue', () => {
  it('sends a plain job', async () => {
    const state = recorder();
    const runtime = createPgBossJobs({ pgBoss: state.boss });
    const result = await runtime.jobs.enqueue({ queue: 'dispatch', data: { event_id: 'e1' } });

    expect(result).toEqual({ status: 'enqueued', jobId: 'job-1' });
    expect(lastCall(state, 'send')).toEqual(['dispatch', { event_id: 'e1' }, {}]);
  });

  it('passes a timer through as startAfter', async () => {
    const state = recorder();
    const runtime = createPgBossJobs({ pgBoss: state.boss });
    const startAfter = new Date('2026-06-02T14:00:00Z');
    await runtime.jobs.enqueue({ queue: 'question.timeout', startAfter, priority: 5 });

    expect(lastCall(state, 'send')).toEqual([
      'question.timeout',
      null,
      { startAfter, priority: 5 },
    ]);
  });

  it('maps throttle coalescing onto singletonKey + singletonSeconds', async () => {
    const state = recorder();
    const runtime = createPgBossJobs({ pgBoss: state.boss });
    await runtime.jobs.enqueue({
      queue: 'mr.comment.debounce',
      coalesce: { key: 'mr:42', windowSeconds: 120 },
    });

    expect(lastCall(state, 'send')[2]).toEqual({
      singletonKey: 'mr:42',
      singletonSeconds: 120,
      singletonNextSlot: false,
    });
  });

  it('maps throttle_with_trailing onto singletonNextSlot', async () => {
    const state = recorder();
    const runtime = createPgBossJobs({ pgBoss: state.boss });
    await runtime.jobs.enqueue({
      queue: 'mr.comment.debounce',
      coalesce: { key: 'mr:42', windowSeconds: 120, mode: 'throttle_with_trailing' },
    });

    expect(lastCall(state, 'send')[2]).toMatchObject({ singletonNextSlot: true });
  });

  it('never sends a coalesced job with a startAfter, whichever mode it is', async () => {
    const state = recorder();
    const runtime = createPgBossJobs({ pgBoss: state.boss });
    await expect(
      runtime.jobs.enqueue({
        queue: 'mr.comment.debounce',
        startAfter: new Date('2026-06-02T14:00:00Z'),
        coalesce: { key: 'mr:42', windowSeconds: 120 },
      }),
    ).rejects.toThrow(/startAfter and coalesce/);
    expect(state.calls.filter((call) => call.method === 'send')).toHaveLength(0);
  });

  it('passes a bare singleton key straight through', async () => {
    const state = recorder();
    const runtime = createPgBossJobs({ pgBoss: state.boss });
    await runtime.jobs.enqueue({ queue: 'stage.execute', singletonKey: 'task:7' });
    expect(lastCall(state, 'send')[2]).toEqual({ singletonKey: 'task:7' });
  });

  it('reports a null job id as coalesced, not as a failure', async () => {
    const state = recorder();
    state.sendResult = null;
    const runtime = createPgBossJobs({ pgBoss: state.boss });
    await expect(runtime.jobs.enqueue({ queue: 'dispatch' })).resolves.toEqual({
      status: 'coalesced',
      jobId: null,
    });
  });

  it('rejects an invalid request before sending', async () => {
    const state = recorder();
    const runtime = createPgBossJobs({ pgBoss: state.boss });
    await expect(runtime.jobs.enqueue({ queue: 'Dispatch' })).rejects.toThrow(JobsValidationError);
    expect(state.calls.filter((call) => call.method === 'send')).toHaveLength(0);
  });
});

describe('cron', () => {
  it('passes the time zone as tz and defaults the key to the empty string', async () => {
    const state = recorder();
    const runtime = createPgBossJobs({ pgBoss: state.boss });
    await runtime.jobs.scheduleCron({
      queue: 'db.partitions.maintain',
      cron: '20 3 * * *',
      timezone: 'Europe/Prague',
    });

    expect(lastCall(state, 'schedule')).toEqual([
      'db.partitions.maintain',
      '20 3 * * *',
      null,
      { tz: 'Europe/Prague', key: '' },
    ]);
  });

  it('refuses a schedule with no time zone', async () => {
    const state = recorder();
    const runtime = createPgBossJobs({ pgBoss: state.boss });
    await expect(
      runtime.jobs.scheduleCron({ queue: 'q', cron: '* * * * *', timezone: '  ' }),
    ).rejects.toThrow(/time zone/);
  });

  it('validates the schedule key', async () => {
    const state = recorder();
    const runtime = createPgBossJobs({ pgBoss: state.boss });
    await expect(
      runtime.jobs.scheduleCron({ queue: 'q', cron: '* * * * *', timezone: 'UTC', key: 'a b' }),
    ).rejects.toThrow(/schedule key/);
  });

  it('normalises listed schedules and sorts them', async () => {
    const state = recorder();
    state.schedules = [
      { name: 'b', key: 'k', cron: '* * * * *', timezone: 'UTC', data: { a: 1 } },
      { name: 'a', key: '', cron: '0 * * * *', timezone: 'Europe/Prague', data: null },
    ];
    const runtime = createPgBossJobs({ pgBoss: state.boss });

    expect(await runtime.jobs.listCronSchedules()).toEqual([
      { queue: 'a', key: '', cron: '0 * * * *', timezone: 'Europe/Prague' },
      { queue: 'b', key: 'k', cron: '* * * * *', timezone: 'UTC', data: { a: 1 } },
    ]);
  });

  it('filters by queue and unschedules by key', async () => {
    const state = recorder();
    state.schedules = [
      { name: 'a', key: '', cron: '* * * * *', timezone: 'UTC' },
      { name: 'b', key: '', cron: '* * * * *', timezone: 'UTC' },
    ];
    const runtime = createPgBossJobs({ pgBoss: state.boss });

    expect(await runtime.jobs.listCronSchedules('a')).toHaveLength(1);
    await runtime.jobs.unscheduleCron('a', 'nightly');
    expect(lastCall(state, 'unschedule')).toEqual(['a', 'nightly']);
    await runtime.jobs.unscheduleCron('a');
    expect(lastCall(state, 'unschedule')).toEqual(['a', '']);
    await expect(runtime.jobs.unscheduleCron('Nope')).rejects.toThrow(JobsValidationError);
  });
});

describe('work', () => {
  it('subscribes one job at a time and hands the handler a typed context', async () => {
    const state = recorder();
    const runtime = createPgBossJobs({ pgBoss: state.boss, pollingIntervalSeconds: 5 });
    const seen: unknown[] = [];

    const worker = await runtime.jobs.work({
      queue: 'dispatch',
      handler: async (job) => {
        seen.push({ id: job.id, queue: job.queue, data: job.data });
      },
    });

    expect(lastCall(state, 'work')).toEqual([
      'dispatch',
      { batchSize: 1, pollingIntervalSeconds: 5 },
    ]);

    const controller = new AbortController();
    await state.workers.get('dispatch')?.([
      { id: 'j1', name: 'dispatch', data: { a: 1 }, signal: controller.signal },
    ]);
    expect(seen).toEqual([{ id: 'j1', queue: 'dispatch', data: { a: 1 } }]);

    await worker.stop();
    expect(lastCall(state, 'offWork')).toEqual(['dispatch', { wait: true }]);
  });

  it('substitutes an empty payload for a job stored with none', async () => {
    const state = recorder();
    const runtime = createPgBossJobs({ pgBoss: state.boss });
    const seen: unknown[] = [];
    await runtime.jobs.work({
      queue: 'dispatch',
      handler: async (job) => {
        seen.push(job.data);
      },
    });

    await state.workers.get('dispatch')?.([
      {
        id: 'j1',
        name: 'dispatch',
        data: null as unknown as object,
        signal: new AbortController().signal,
      },
    ]);
    expect(seen).toEqual([{}]);
  });

  it('passes the requested concurrency and per-worker poll interval', async () => {
    const state = recorder();
    const runtime = createPgBossJobs({ pgBoss: state.boss });
    await runtime.jobs.work({
      queue: 'dispatch',
      concurrency: 4,
      pollingIntervalSeconds: 0.5,
      handler: async () => {},
    });
    expect(lastCall(state, 'work')[1]).toEqual({
      batchSize: 1,
      pollingIntervalSeconds: 0.5,
      localConcurrency: 4,
    });
  });

  it('rejects a bad queue name before subscribing', async () => {
    const state = recorder();
    const runtime = createPgBossJobs({ pgBoss: state.boss });
    await expect(runtime.jobs.work({ queue: 'Nope', handler: async () => {} })).rejects.toThrow(
      JobsValidationError,
    );
  });
});

describe('lifecycle', () => {
  it('starts and stops the underlying instance', async () => {
    const state = recorder();
    const runtime = createPgBossJobs({ pgBoss: state.boss });
    await runtime.start();
    await runtime.stop();
    expect(lastCall(state, 'stop')).toEqual([{ close: true, graceful: true }]);
  });
});

describe('asJobsDatabase', () => {
  it('adapts a pool to the interface pg-boss executes SQL through', async () => {
    const query = vi.fn(async () => ({ rows: [{ one: 1 }] }));
    const database = asJobsDatabase({ query });

    expect(await database.executeSql('select 1')).toEqual({ rows: [{ one: 1 }] });
    expect(query).toHaveBeenCalledWith('select 1', []);

    await database.executeSql('select $1', ['x']);
    expect(query).toHaveBeenLastCalledWith('select $1', ['x']);
  });

  it('exposes no listen capability, so pg-boss polls rather than holding a session', () => {
    expect('listen' in asJobsDatabase({ query: async () => ({ rows: [] }) })).toBe(false);
  });
});

describe('wrapPgBoss', () => {
  /**
   * A real `PgBoss`, handed a database stub so nothing connects. Its methods are then spied, so the
   * library's own implementations never run: what is under test is the argument pass-through, which
   * is the one thing in this file the integration suite cannot tell apart from a typo.
   */
  const boss = (): PgBoss =>
    new PgBoss({
      db: { executeSql: async () => ({ rows: [] }) },
      schema: 'pgboss',
      migrate: false,
      createSchema: false,
      supervise: false,
      schedule: false,
    });

  it('forwards every call to the library unchanged', async () => {
    const instance = boss();
    const spies = {
      start: vi.spyOn(instance, 'start').mockResolvedValue(instance),
      stop: vi.spyOn(instance, 'stop').mockResolvedValue(undefined),
      createQueue: vi.spyOn(instance, 'createQueue').mockResolvedValue(undefined),
      send: vi.spyOn(instance, 'send').mockResolvedValue('id'),
      work: vi.spyOn(instance, 'work').mockResolvedValue('worker'),
      offWork: vi.spyOn(instance, 'offWork').mockResolvedValue(undefined),
      schedule: vi.spyOn(instance, 'schedule').mockResolvedValue(undefined),
      unschedule: vi.spyOn(instance, 'unschedule').mockResolvedValue(undefined),
      getSchedules: vi.spyOn(instance, 'getSchedules').mockResolvedValue([]),
      on: vi.spyOn(instance, 'on'),
    };
    const wrapped = wrapPgBoss(instance);

    await wrapped.start();
    await wrapped.stop({ close: true, graceful: true });
    await wrapped.createQueue('q', { policy: 'stately' });
    expect(await wrapped.send('q', { a: 1 }, { priority: 2 })).toBe('id');
    await wrapped.work('q', { batchSize: 1 }, async () => {});
    await wrapped.offWork('q', { wait: true });
    await wrapped.schedule('q', '* * * * *', null, { tz: 'UTC', key: '' });
    await wrapped.unschedule('q', 'k');
    expect(await wrapped.getSchedules('q')).toEqual([]);
    wrapped.on('error', () => {});

    expect(spies.start).toHaveBeenCalledTimes(1);
    expect(spies.stop).toHaveBeenCalledWith({ close: true, graceful: true });
    expect(spies.createQueue).toHaveBeenCalledWith('q', { policy: 'stately' });
    expect(spies.send).toHaveBeenCalledWith('q', { a: 1 }, { priority: 2 });
    expect(spies.work).toHaveBeenCalledWith('q', { batchSize: 1 }, expect.any(Function));
    expect(spies.offWork).toHaveBeenCalledWith('q', { wait: true });
    expect(spies.schedule).toHaveBeenCalledWith('q', '* * * * *', null, { tz: 'UTC', key: '' });
    expect(spies.unschedule).toHaveBeenCalledWith('q', 'k');
    expect(spies.getSchedules).toHaveBeenCalledWith('q');
    expect(spies.on).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('passes the library batch through to the adapter handler', async () => {
    const instance = boss();
    let captured: ((jobs: unknown[]) => Promise<unknown>) | undefined;
    vi.spyOn(instance, 'work').mockImplementation((async (
      _name: string,
      _options: unknown,
      handler: (jobs: unknown[]) => Promise<unknown>,
    ) => {
      captured = handler;
      return 'worker';
    }) as unknown as PgBoss['work']);

    const seen: unknown[] = [];
    await wrapPgBoss(instance).work('q', {}, async (received) => {
      seen.push(...received);
    });

    await captured?.([{ id: 'j1', name: 'q', data: {}, signal: new AbortController().signal }]);
    expect(seen).toHaveLength(1);
  });

  it('builds its own instance from a connection string when no pool is supplied', () => {
    // Nothing connects until start(), so this only covers the construction branch.
    expect(() =>
      createPgBossJobs({ connectionString: 'postgres://app:app@127.0.0.1:5432/app' }),
    ).not.toThrow();
  });
});

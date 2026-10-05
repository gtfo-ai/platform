/**
 * The holder's half of TD-028 decision 9 (WP-85): what the lease holder does with a pending
 * `run_commands` row, driven over the in-memory store — whose predicates the contract suite holds
 * to PostgreSQL's (`test/contract/support/pipeline-store-suite.ts`).
 *
 * The command's half (recording the row beside the event, refusing a run that is not live) is
 * `human-commands.test.ts`'s; the SQL's lock ordering against the run's ending is
 * `test/integration/pipeline/run-commands.integration.test.ts`'s.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { TOPIC_PATTERN } from '../ports/broadcast.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { ClaudeRunner, RunHandle, RunStop, SteerMessage } from '../ports/runner.js';
import { MemoryEventing } from '../testing/memory-eventing.js';
import { createMemoryPipelineStore, type MemoryPipelineStore } from '../testing/memory-pipeline.js';
import { type HeartbeatSchedule, startRunHeartbeat } from './lease.js';
import { createLiveRuns, type LiveRuns } from './live-runs.js';
import { createRunCommandInbox, runCommandsTopic } from './run-commands.js';
import type { RunCommandInstruction } from './store.js';

const TASK = '00000000-0000-4000-8000-0000000000a1' as Id;
const RUN = '00000000-0000-4000-8000-0000000000a2' as Id;
const USER = '00000000-0000-4000-8000-0000000000a3' as Id;
const OWNER = 'runner-host:0000cafe';
const NOW = '2026-09-28T09:00:00.000Z' as IsoDateTime;

let commandSeq = 0;
const commandId = (): Id => {
  commandSeq += 1;
  return `00000000-0000-4000-8000-${commandSeq.toString(16).padStart(12, '0')}` as Id;
};

const steer = (text: string): RunCommandInstruction => ({
  kind: 'steer',
  text,
  authorUserId: USER,
  authorLabel: 'Ada',
});

interface World {
  readonly eventing: MemoryEventing;
  readonly store: MemoryPipelineStore;
}

/** A store holding one `running` run, leased to `owner` unless told otherwise. */
const world = async (owner: string | null = OWNER): Promise<World> => {
  const eventing = new MemoryEventing();
  const store = createMemoryPipelineStore();
  await eventing.transaction(async (scope) => {
    await store.runs.insert(scope.tx, {
      id: RUN,
      taskId: TASK,
      projectId: '00000000-0000-4000-8000-0000000000a4' as Id,
      stage: null,
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
    if (owner !== null) {
      await store.runs.renewLease(scope.tx, { runId: RUN, owner, expiresAt: NOW });
    }
  });
  return { eventing, store };
};

const record = async (w: World, instruction: RunCommandInstruction): Promise<Id> => {
  const id = commandId();
  await w.eventing.transaction(async (scope) => {
    await w.store.runCommands.insert(scope.tx, {
      id,
      runId: RUN,
      taskId: TASK,
      actorUserId: USER,
      instruction,
    });
  });
  return id;
};

/** A handle that records, and a runner that hands it out (so `liveRuns.observe` registers it). */
const recordingRunner = (options: { readonly failSteer?: boolean } = {}) => {
  const steers: SteerMessage[] = [];
  const stops: RunStop[] = [];
  const handle: RunHandle = {
    runId: RUN,
    sessionId: 'session-1',
    outcome: new Promise(() => undefined),
    steer: async (message) => {
      if (options.failSteer === true) {
        throw new Error('the session socket is gone');
      }
      steers.push(message);
    },
    stop: async (stop) => {
      stops.push(stop);
    },
  };
  const runner: ClaudeRunner = { start: () => handle };
  return { steers, stops, runner };
};

const startRun = (live: LiveRuns, runner: ClaudeRunner): void => {
  live.observe(runner).start({ runId: RUN, taskId: TASK } as never);
};

const inboxOver = (w: World, live: LiveRuns, logger: Logger = silentLogger) =>
  createRunCommandInbox({
    unitOfWork: w.eventing,
    store: w.store,
    liveRuns: live,
    owner: OWNER,
    logger,
  });

const rowsOf = (w: World) => w.store.runCommandRows();

describe('runCommandsTopic', () => {
  it('is a legal broadcast topic keyed by the owner, and differs between owners', () => {
    const topic = runCommandsTopic('runner-7f3a.internal.example:9c1d2e3f');
    expect(topic).toMatch(TOPIC_PATTERN);
    expect(topic).toBe(runCommandsTopic('runner-7f3a.internal.example:9c1d2e3f'));
    expect(topic).not.toBe(runCommandsTopic('runner-7f3a.internal.example:9c1d2e40'));
  });
});

describe('the run command inbox', () => {
  it('applies a pending steer on a wake-up addressed to its owner, and ignores one addressed to another', async () => {
    const w = await world();
    const live = createLiveRuns();
    const { steers, runner } = recordingRunner();
    startRun(live, runner);
    const inbox = inboxOver(w, live);
    await inbox.listen(w.eventing.broadcast);
    await inbox.drain();
    const id = await record(w, steer('check the rounding'));

    // Another owner's wake-up on the same topic (a digest collision) is not ours: nothing moves.
    await w.eventing.broadcast.publish({
      topic: runCommandsTopic(OWNER),
      payload: { lease_owner: 'someone-else:1', run_id: RUN },
    });
    await inbox.drain({ runId: '00000000-0000-4000-8000-0000000000ff' as Id });
    expect(steers).toEqual([]);

    await w.eventing.broadcast.publish({
      topic: runCommandsTopic(OWNER),
      payload: { lease_owner: OWNER, run_id: RUN },
    });
    await inbox.drain();
    expect(steers).toEqual([
      { text: 'check the rounding', authorUserId: USER, authorLabel: 'Ada' },
    ]);
    expect(rowsOf(w)).toMatchObject([{ id, applied: true, refusedReason: null }]);
    await inbox.stop();
  });

  it('delivers exactly once when the notification and the heartbeat race for one row (rule 9)', async () => {
    const w = await world();
    const live = createLiveRuns();
    const { steers, runner } = recordingRunner();
    startRun(live, runner);
    // Two holders of one owner's paths that share nothing but the store — the notification's drain
    // and the heartbeat's — so the in-process chain cannot be what serialises them.
    const fromNotify = inboxOver(w, live);
    const fromBeat = inboxOver(w, live);
    await record(w, steer('once'));

    await Promise.all([fromNotify.drain(), fromBeat.drain({ runId: RUN, onMiss: 'refuse' })]);

    expect(steers).toHaveLength(1);
    expect(rowsOf(w)).toMatchObject([{ applied: true }]);
  });

  it('applies a command within one heartbeat when nothing is listening (criterion 2)', async () => {
    const w = await world();
    const live = createLiveRuns();
    const { steers, runner } = recordingRunner();
    startRun(live, runner);
    const inbox = inboxOver(w, live);
    // No `listen`: the notification path is down, as it is for a holder whose LISTEN was
    // reconnecting when the command committed.
    let beat: () => void = () => undefined;
    let beaten: () => void = () => undefined;
    const drained = new Promise<void>((resolve) => {
      beaten = resolve;
    });
    const schedule: HeartbeatSchedule = (_every, fire) => {
      beat = fire;
      return () => undefined;
    };
    const stop = startRunHeartbeat(
      {
        unitOfWork: w.eventing,
        store: w.store,
        clock: { now: () => NOW },
        lease: {
          owner: OWNER,
          schedule,
          onRenewed: async (runId) => {
            await inbox.drain({ runId, onMiss: 'refuse' });
            beaten();
          },
        },
      },
      RUN,
    );
    await record(w, steer('heard on the beat'));
    expect(steers).toEqual([]);

    // One beat — the wait is for the work the beat does, never for a duration.
    beat();
    await drained;
    await stop();

    expect(steers.map((message) => message.text)).toEqual(['heard on the beat']);
    expect(rowsOf(w)).toMatchObject([{ applied: true }]);
  });

  it('leaves a register miss pending on a wake-up, and the heartbeat refuses it register_miss', async () => {
    const w = await world();
    const live = createLiveRuns();
    const inbox = inboxOver(w, live);
    await record(w, steer('nobody home'));

    await inbox.drain();
    expect(rowsOf(w)).toMatchObject([{ applied: false, refusedReason: null }]);

    await inbox.drain({ runId: RUN, onMiss: 'refuse' });
    expect(rowsOf(w)).toMatchObject([{ applied: false, refusedReason: 'register_miss' }]);
  });

  /**
   * WP-119 (PROGRESS backlog 336, option (a)): a **stop** the heartbeat refuses `register_miss` while
   * its run still reads `running` and leased to this process is the one refusal that leaves a session
   * nobody will stop, so it is logged at `error`, once, naming the leak. A steer refused the same way
   * stays at `warn`, and so does a stop whose run is no longer this process's (the negative halves).
   */
  describe('a stop refused register_miss on a live lease (WP-119, backlog 336)', () => {
    const recordingLogger = () => {
      const lines: { level: 'warn' | 'error'; fields: Record<string, unknown>; message: string }[] =
        [];
      const logger: Logger = {
        ...silentLogger,
        warn: (fields, message) => {
          lines.push({ level: 'warn', fields: { ...fields }, message });
        },
        error: (fields, message) => {
          lines.push({ level: 'error', fields: { ...fields }, message });
        },
      };
      return { lines, logger };
    };

    it.each(['cancel', 'take_over'] as const)(
      'logs a refused %s once at error, naming the leak',
      async (kind) => {
        const w = await world();
        const { lines, logger } = recordingLogger();
        const inbox = inboxOver(w, createLiveRuns(), logger);
        const id = await record(
          w,
          kind === 'cancel'
            ? { kind: 'cancel' }
            : {
                kind: 'take_over',
                branch: 'agentic/ACME-1',
                commitMessage: 'wip: hand-over to Ada',
                tarball: false,
                keepUntil: '2026-10-12T09:00:00.000Z' as IsoDateTime,
              },
        );

        await inbox.drain({ runId: RUN, onMiss: 'refuse' });
        // A second beat finds nothing pending: the line is not repeated.
        await inbox.drain({ runId: RUN, onMiss: 'refuse' });

        expect(rowsOf(w)).toMatchObject([{ applied: false, refusedReason: 'register_miss' }]);
        expect(lines.map((line) => line.level)).toEqual(['error']);
        expect(lines[0]?.fields).toMatchObject({
          run_id: RUN,
          task_id: TASK,
          command_id: id,
          kind,
          lease_owner: OWNER,
        });
        expect(lines[0]?.message).toContain('MAX_LIVE_RUNS');
      },
    );

    it('keeps a refused steer at warn: no session is left running by refusing it', async () => {
      const w = await world();
      const { lines, logger } = recordingLogger();
      await record(w, steer('nobody home'));
      await inboxOver(w, createLiveRuns(), logger).drain({ runId: RUN, onMiss: 'refuse' });
      expect(lines.map((line) => line.level)).toEqual(['warn']);
    });

    it.each([
      { moved: 'no longer reads running', change: { status: 'completed' } },
      { moved: 'is leased to another process', change: { leaseOwner: 'another-process:1' } },
    ] as const)('keeps a refused stop at warn once the run $moved', async ({ change }) => {
      const w = await world();
      const { lines, logger } = recordingLogger();
      await record(w, { kind: 'cancel' });
      // The miss is read while the row is pending; the run's row moves before the refusal reads it.
      const inbox = createRunCommandInbox({
        unitOfWork: w.eventing,
        store: {
          runCommands: {
            ...w.store.runCommands,
            lockRun: async (tx, runId, options) => {
              const locked = await w.store.runCommands.lockRun(tx, runId, options);
              return locked === null ? null : { ...locked, ...change };
            },
          },
        },
        liveRuns: createLiveRuns(),
        owner: OWNER,
        logger,
      });
      await inbox.drain({ runId: RUN, onMiss: 'refuse' });
      expect(rowsOf(w)).toMatchObject([{ refusedReason: 'register_miss' }]);
      expect(lines.map((line) => line.level)).toEqual(['warn']);
    });
  });

  it('applies a command recorded in the start window once the run’s handle is registered', async () => {
    const w = await world();
    const live = createLiveRuns();
    const { steers, runner } = recordingRunner();
    const inbox = inboxOver(w, live);
    // The row is leased and running before `runner.start` has registered a handle — the window
    // decision 3 is about. A wake-up now finds nothing and must not refuse.
    await record(w, steer('early'));
    await inbox.drain();
    expect(rowsOf(w)).toMatchObject([{ refusedReason: null, applied: false }]);

    // The composition's order: the inbox outside the register, so the handle exists when it looks.
    inbox.observe(live.observe(runner)).start({ runId: RUN, taskId: TASK } as never);
    await inbox.drain({ runId: RUN });

    expect(steers.map((message) => message.text)).toEqual(['early']);
  });

  it('never applies a command for a run whose lease is another process’s', async () => {
    const w = await world('another-process:1');
    const live = createLiveRuns();
    const { steers, runner } = recordingRunner();
    startRun(live, runner);
    await record(w, steer('not yours'));

    await inboxOver(w, live).drain({ runId: RUN, onMiss: 'refuse' });

    expect(steers).toEqual([]);
    expect(rowsOf(w)).toMatchObject([{ applied: false, refusedReason: null }]);
  });

  it('stops a taken-over run with the export its workspace owes, without waiting for the stop', async () => {
    const w = await world();
    const live = createLiveRuns();
    const { stops, runner } = recordingRunner();
    startRun(live, runner);
    await record(w, {
      kind: 'take_over',
      branch: 'agentic/ACME-1',
      commitMessage: 'wip: hand-over to Ada',
      tarball: true,
      keepUntil: '2026-10-12T09:00:00.000Z' as IsoDateTime,
    });

    await inboxOver(w, live).drain();

    expect(stops).toEqual([
      {
        reason: 'taken_over',
        workspaceExport: {
          branch: 'agentic/ACME-1',
          commitMessage: 'wip: hand-over to Ada',
          tarball: true,
          keepUntil: '2026-10-12T09:00:00.000Z',
        },
      },
    ]);
  });

  it('refuses a delivery that failed delivery_failed, never applied, and never retries it (review round 1)', async () => {
    const w = await world();
    const live = createLiveRuns();
    const attempts: string[] = [];
    let fail = true;
    const handle: RunHandle = {
      runId: RUN,
      sessionId: 'session-1',
      outcome: new Promise(() => undefined),
      steer: async (message) => {
        attempts.push(message.text);
        if (fail) {
          throw new Error('the session is closing');
        }
      },
      stop: async () => undefined,
    };
    startRun(live, { start: () => handle });
    const errors: string[] = [];
    const logger: Logger = {
      ...silentLogger,
      error: (_fields: unknown, message?: string) => {
        errors.push(message ?? '');
      },
    } as Logger;
    const inbox = inboxOver(w, live, logger);
    await record(w, steer('first'));
    await record(w, steer('second'));

    await inbox.drain();

    // Both were taken (the stamp is the arbiter) and both failed, so both read delivery_failed —
    // not applied, which would be a turn the session never took.
    expect(rowsOf(w)).toMatchObject([
      { applied: false, refusedReason: 'delivery_failed' },
      { applied: false, refusedReason: 'delivery_failed' },
    ]);
    expect(errors.filter((line) => /delivery_failed/.test(line))).toHaveLength(2);

    // Never back to pending: every later wake-up, the heartbeat's included, finds nothing to do.
    fail = false;
    await inbox.drain();
    await inbox.drain({ runId: RUN, onMiss: 'refuse' });
    expect(attempts).toEqual(['first', 'second']);
  });

  it('refuses an unreadable row undecodable by itself, and still applies the rows behind it (review round 1)', async () => {
    const w = await world();
    const live = createLiveRuns();
    const { steers, runner } = recordingRunner();
    startRun(live, runner);
    const bad = await record(w, steer('stored in a shape this build cannot read'));
    await record(w, steer('readable'));
    // The SQL adapter hands back an unreadable payload as a row with no instruction; this store
    // cannot hold one, so its `pending` is wrapped to say the same of the first row.
    const store = {
      runCommands: {
        ...w.store.runCommands,
        pending: async (...args: Parameters<typeof w.store.runCommands.pending>) =>
          (await w.store.runCommands.pending(...args)).map((row) =>
            row.id === bad ? { ...row, instruction: null } : row,
          ),
      },
    };
    const inbox = createRunCommandInbox({
      unitOfWork: w.eventing,
      store,
      liveRuns: live,
      owner: OWNER,
    });

    await inbox.drain();

    expect(rowsOf(w)).toMatchObject([
      { id: bad, applied: false, refusedReason: 'undecodable' },
      { applied: true, refusedReason: null },
    ]);
    expect(steers.map((message) => message.text)).toEqual(['readable']);
  });

  it('drains nothing once stopped', async () => {
    const w = await world();
    const live = createLiveRuns();
    const { steers, runner } = recordingRunner();
    startRun(live, runner);
    const inbox = inboxOver(w, live);
    await inbox.stop();
    await record(w, steer('after the stop'));

    await inbox.drain();
    await inbox.stop();

    expect(steers).toEqual([]);
  });
});

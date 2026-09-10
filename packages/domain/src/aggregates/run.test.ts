import { type ContextPackRecord, runStatusSchema, type TokenUsage } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { addMs, type Clock, fixedClock } from '../clock.js';
import {
  IllegalTransitionError,
  InvariantViolationError,
  PermissionDeniedError,
} from '../errors.js';
import { type CommandContext, FIRST_STREAM_SEQ } from '../events.js';
import { type IdSource, sequentialIds } from '../ids.js';
import {
  ACTIVE_RUN_STATUSES,
  assertRunTransition,
  assertSingleActiveRun,
  canTransitionRun,
  createRun,
  DEFAULT_STALL_TIMEOUT_MS,
  failRun,
  finishRun,
  isActiveRunStatus,
  isStalled,
  markRunning,
  RUN_TRANSITIONS,
  type Run,
  recordOutput,
  startRun,
  steerRun,
} from './run.js';

const RUN_ID = '00000000-0000-4000-8000-0000000000f1';
const TASK_ID = '00000000-0000-4000-8000-0000000000aa';
const PROJECT_ID = '00000000-0000-4000-8000-0000000000bb';
const USER_ID = '00000000-0000-4000-8000-0000000000e9';

const world = (): { ids: IdSource; clock: Clock } => ({
  ids: sequentialIds(),
  clock: fixedClock('2026-09-09T09:00:00.000Z', 60_000),
});

const context = (shared: { ids: IdSource; clock: Clock }): CommandContext => ({
  ids: shared.ids,
  actor: { kind: 'system', component: 'test' },
  clock: shared.clock,
});

const contextPack: ContextPackRecord = {
  tier0: [{ path: '.agentic/knowledge/index.md', tokens: 400 }],
  tier1: [],
  budget_tokens: 8_000,
  total_tokens: 400,
  kb_commit: null,
};

const usage: TokenUsage = {
  input_tokens: 1_000,
  output_tokens: 200,
  cache_write_5m_tokens: 0,
  cache_write_1h_tokens: 0,
  cache_read_tokens: 500,
};

const newRun = (): Run =>
  createRun({
    id: RUN_ID,
    taskId: TASK_ID,
    projectId: PROJECT_ID,
    stage: 'implementation',
    role: 'developer',
    mode: 'normal',
    attempt: 1,
    model: 'claude-opus-5',
    effort: 'high',
    promptVersion: 'implementation@1.0',
  });

/** A run in `starting`, with its `run.created` already emitted. */
const startedRun = (shared = world()): Run => startRun(newRun(), context(shared)).aggregate;

/** A run in `running`, with its `run.created` and `run.started` already emitted. */
const runningRun = (shared = world()): Run =>
  markRunning(startedRun(shared), { contextPack }, context(shared)).aggregate;

describe('Run transition table', () => {
  it('covers exactly the statuses the contracts define', () => {
    expect(Object.keys(RUN_TRANSITIONS).sort()).toEqual([...runStatusSchema.options].sort());
  });

  it('matches the edge list transcribed from technical/02', () => {
    // Written out by hand from "created → starting → running → (completed | failed | cancelled |
    // budget_exceeded | timed_out | stalled)", so a wrong row in the table under test disagrees
    // with the document rather than with itself.
    expect(RUN_TRANSITIONS).toEqual({
      created: ['starting'],
      starting: ['running', 'failed', 'cancelled', 'timed_out'],
      running: ['completed', 'failed', 'cancelled', 'budget_exceeded', 'timed_out', 'stalled'],
      completed: [],
      failed: [],
      cancelled: [],
      budget_exceeded: [],
      timed_out: [],
      stalled: [],
    });
  });

  it('makes every terminal status terminal', () => {
    for (const [status, targets] of Object.entries(RUN_TRANSITIONS)) {
      if (!isActiveRunStatus(status as never)) {
        expect(targets, status).toEqual([]);
      }
    }
    expect([...ACTIVE_RUN_STATUSES]).toEqual(['created', 'starting', 'running']);
  });

  it('throws for an illegal transition', () => {
    expect(canTransitionRun('completed', 'running')).toBe(false);
    expect(() => assertRunTransition('completed', 'running')).toThrow(IllegalTransitionError);
  });
});

describe('run lifecycle', () => {
  it('enters the log at `run.created`, when the platform commits to launching it', () => {
    const created = newRun();
    expect(created.status).toBe('created');
    expect(created.sequence).toBe(FIRST_STREAM_SEQ);

    const shared = world();
    const { aggregate, events } = startRun(created, context(shared));
    expect(aggregate.status).toBe('starting');
    expect(events.map((event) => event.type)).toEqual(['run.created']);
    expect(events[0]?.stream_type).toBe('run');
    expect(events[0]?.stream_seq).toBe(FIRST_STREAM_SEQ);
    expect(events[0]?.correlation_id).toBe(TASK_ID);
    // The whole identity of the run, so the row can be rebuilt from the log alone.
    expect(events[0]?.payload).toMatchObject({
      run_id: RUN_ID,
      stage: 'implementation',
      role: 'developer',
      mode: 'normal',
      attempt: 1,
      model: 'claude-opus-5',
      effort: 'high',
      prompt_version: 'implementation@1.0',
    });
  });

  it('refuses to start a run twice', () => {
    const shared = world();
    const started = startedRun(shared);
    expect(() => startRun(started, context(shared))).toThrow(IllegalTransitionError);
  });

  it('emits run.started when the session begins', () => {
    const shared = world();
    const { aggregate, events } = markRunning(startedRun(shared), { contextPack }, context(shared));
    expect(aggregate.status).toBe('running');
    expect(aggregate.startedAt).toBe(aggregate.lastOutputAt);
    expect(aggregate.startedAt).not.toBeNull();
    expect(events.map((event) => event.type)).toEqual(['run.started']);
    expect(events[0]?.payload).toMatchObject({
      model: 'claude-opus-5',
      effort: 'high',
      prompt_version: 'implementation@1.0',
    });
    expect(events[0]?.stream_type).toBe('run');
    expect(events[0]?.correlation_id).toBe(TASK_ID);
  });

  it('refuses to go straight from created to running', () => {
    expect(() => markRunning(newRun(), { contextPack }, context(world()))).toThrow(
      IllegalTransitionError,
    );
  });

  it('records the wall time and the usage when it finishes', () => {
    const shared = world();
    const running = runningRun(shared);
    const { aggregate, events } = finishRun(
      running,
      {
        status: 'completed',
        terminalReason: 'success',
        usage,
        modelUsage: [{ ...usage, model: 'claude-opus-5', usd: 0.42 }],
        cost: { usd: 0.42, is_estimate: false },
        numTurns: 12,
      },
      context(shared),
    );
    expect(aggregate.status).toBe('completed');
    expect(aggregate.terminalReason).toBe('success');
    expect(events.map((event) => event.type)).toEqual(['run.finished']);
    expect(events[0]?.payload).toMatchObject({ num_turns: 12, wall_ms: 60_000 });
  });

  it('reports zero wall time for a run that never started', () => {
    const shared = world();
    const { events } = finishRun(
      startedRun(shared),
      {
        status: 'cancelled',
        terminalReason: 'cancelled',
        usage,
        modelUsage: [],
        cost: { usd: 0, is_estimate: true },
        numTurns: 0,
      },
      context(shared),
    );
    expect(events[0]?.payload).toMatchObject({ wall_ms: 0 });
  });

  it('reports a failure with its error', () => {
    const shared = world();
    const { aggregate, events } = failRun(
      runningRun(shared),
      { status: 'failed', terminalReason: 'error_during_execution', error: 'the CLI crashed' },
      context(shared),
    );
    expect(aggregate.status).toBe('failed');
    expect(events.map((event) => event.type)).toEqual(['run.failed']);
    expect(events[0]?.payload).toMatchObject({ error: 'the CLI crashed', usage: null, cost: null });
  });

  it('carries usage and cost on a budget-stopped failure', () => {
    const shared = world();
    const { events } = failRun(
      runningRun(shared),
      {
        status: 'stalled',
        terminalReason: 'stalled',
        error: 'no output for 5 minutes',
        usage,
        cost: { usd: 1.5, is_estimate: true },
      },
      context(shared),
    );
    expect(events[0]?.payload).toMatchObject({ status: 'stalled', cost: { usd: 1.5 } });
  });
});

describe('output and stalls', () => {
  it('resets the stall clock on output', () => {
    const shared = world();
    const running = runningRun(shared);
    const startedAt = running.lastOutputAt as string;
    expect(isStalled(running, addMs(startedAt, DEFAULT_STALL_TIMEOUT_MS - 1))).toBe(false);
    expect(isStalled(running, addMs(startedAt, DEFAULT_STALL_TIMEOUT_MS))).toBe(true);

    const fed = recordOutput(running, addMs(startedAt, 60_000));
    expect(isStalled(fed, addMs(startedAt, DEFAULT_STALL_TIMEOUT_MS))).toBe(false);
    expect(isStalled(fed, addMs(startedAt, DEFAULT_STALL_TIMEOUT_MS + 60_000))).toBe(true);
    expect(DEFAULT_STALL_TIMEOUT_MS).toBe(300_000);
  });

  it('honours a custom stall timeout', () => {
    const running = runningRun();
    const startedAt = running.lastOutputAt as string;
    expect(isStalled(running, addMs(startedAt, 30_000), 60_000)).toBe(false);
    expect(isStalled(running, addMs(startedAt, 60_000), 60_000)).toBe(true);
  });

  it('never calls a run that is not running stalled', () => {
    expect(isStalled(newRun(), '2030-01-01T00:00:00.000Z')).toBe(false);
  });

  it('refuses output for a run that is not running', () => {
    expect(() => recordOutput(newRun(), '2026-09-09T09:00:00.000Z')).toThrow(
      InvariantViolationError,
    );
  });
});

describe('steering', () => {
  it('pushes a user turn into a live run', () => {
    const shared = world();
    const { events } = steerRun(
      runningRun(shared),
      { message: 'use the existing helper', authorUserId: USER_ID, authorRole: 'member' },
      context(shared),
    );
    expect(events.map((event) => event.type)).toEqual(['run.steered']);
    expect(events[0]?.payload).toMatchObject({ author_user_id: USER_ID });
  });

  it('refuses to steer a run that is not running', () => {
    const shared = world();
    expect(() =>
      steerRun(
        startedRun(shared),
        { message: 'hello', authorUserId: USER_ID, authorRole: 'admin' },
        context(shared),
      ),
    ).toThrow(PermissionDeniedError);
  });

  it('refuses to steer without the permission', () => {
    const shared = world();
    expect(() =>
      steerRun(
        runningRun(shared),
        { message: 'hello', authorUserId: USER_ID, authorRole: 'viewer' },
        context(shared),
      ),
    ).toThrow(PermissionDeniedError);
  });
});

describe('one active run per task (technical/02 invariant)', () => {
  it('refuses a second active run', () => {
    const running = runningRun();
    expect(() => assertSingleActiveRun([running], TASK_ID)).toThrow(InvariantViolationError);
  });

  it('allows a new run once the previous one finished', () => {
    const shared = world();
    const finished = finishRun(
      runningRun(shared),
      {
        status: 'completed',
        terminalReason: 'success',
        usage,
        modelUsage: [],
        cost: { usd: 0.1, is_estimate: false },
        numTurns: 1,
      },
      context(shared),
    ).aggregate;
    expect(() => assertSingleActiveRun([finished], TASK_ID)).not.toThrow();
  });

  it('ignores runs of other tasks', () => {
    const other = { ...runningRun(), taskId: '00000000-0000-4000-8000-0000000000ab' };
    expect(() => assertSingleActiveRun([other], TASK_ID)).not.toThrow();
  });
});

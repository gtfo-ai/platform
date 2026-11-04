import {
  type ContextPackRecord,
  runFinishedEvent,
  runStatusSchema,
  type TokenUsage,
} from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { addMs, type Clock, fixedClock } from '../clock.js';
import { IllegalTransitionError, InvariantViolationError } from '../errors.js';
import { type CommandContext, FIRST_STREAM_SEQ } from '../events.js';
import { type IdSource, sequentialIds } from '../ids.js';
import {
  ACTIVE_RUN_STATUSES,
  assertRunTransition,
  assertSingleActiveRun,
  canTransitionRun,
  claimRun,
  createRun,
  DEFAULT_STALL_TIMEOUT_MS,
  failRun,
  finishRun,
  isActiveRunStatus,
  isStalled,
  markRunning,
  offerRun,
  RUN_TRANSITIONS,
  type Run,
  recordOutput,
  recordRunCreated,
  releaseRunClaim,
} from './run.js';

const RUN_ID = '00000000-0000-4000-8000-0000000000f1';
const TASK_ID = '00000000-0000-4000-8000-0000000000aa';
const PROJECT_ID = '00000000-0000-4000-8000-0000000000bb';

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

/** A run in `created` with its `run.created` emitted — the row written with its offer. */
const recordedRun = (shared = world()): Run =>
  recordRunCreated(newRun(), context(shared)).aggregate;

/** A run in `starting`: recorded, then claimed (WP-275b, TD-031's 2026-11-04 amendment §4). */
const startedRun = (shared = world()): Run =>
  claimRun(
    recordedRun(shared),
    {
      offerId: '00000000-0000-4000-8000-0000000000c0',
      claimantKind: 'server',
      workerId: null,
      epoch: 1,
    },
    context(shared),
  ).aggregate;

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
      created: ['starting', 'cancelled'],
      starting: ['running', 'failed', 'cancelled', 'timed_out', 'created'],
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
  it('enters the log at `run.created` when its row is written, and stays `created`', () => {
    const created = newRun();
    expect(created.status).toBe('created');
    expect(created.sequence).toBe(FIRST_STREAM_SEQ);

    const shared = world();
    const { aggregate, events } = recordRunCreated(created, context(shared));
    expect(aggregate.status).toBe('created');
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

  it('refuses to record a run twice, or one that has left `created`', () => {
    const shared = world();
    expect(() => recordRunCreated(recordedRun(shared), context(shared))).toThrow(
      InvariantViolationError,
    );
    expect(() => recordRunCreated(startedRun(shared), context(shared))).toThrow(
      InvariantViolationError,
    );
  });

  it('is `created → starting` at the claim, and the claim cannot be repeated', () => {
    const shared = world();
    const started = startedRun(shared);
    expect(started.status).toBe('starting');
    expect(() =>
      claimRun(
        started,
        {
          offerId: '00000000-0000-4000-8000-0000000000c0',
          claimantKind: 'server',
          workerId: null,
          epoch: 2,
        },
        context(shared),
      ),
    ).toThrow(IllegalTransitionError);
  });

  it('admits a withdrawal from `created` and a release from `starting` (WP-276, WP-281)', () => {
    expect(canTransitionRun('created', 'cancelled')).toBe(true);
    expect(canTransitionRun('starting', 'created')).toBe(true);
    // A withdrawn run that no claimant took ends with its own `run.finished`, and no `run.started`.
    const shared = world();
    const withdrawn = finishRun(
      recordedRun(shared),
      {
        status: 'cancelled',
        terminalReason: 'cancelled',
        usage,
        modelUsage: [],
        cost: null,
        numTurns: 0,
      },
      context(shared),
    );
    expect(withdrawn.aggregate.status).toBe('cancelled');
    expect(withdrawn.events.map((event) => event.type)).toEqual(['run.finished']);
    expect(withdrawn.events[0]?.payload).toMatchObject({ wall_ms: 0 });
    // Nothing but the withdrawal and the claim leave `created`.
    expect(canTransitionRun('created', 'running')).toBe(false);
    expect(canTransitionRun('created', 'failed')).toBe(false);
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

  it('carries a stop nothing measured as a null cost, never a zero (WP-119)', () => {
    const shared = world();
    const { aggregate, events } = finishRun(
      runningRun(shared),
      {
        status: 'timed_out',
        terminalReason: 'timed_out',
        usage,
        modelUsage: [],
        cost: null,
        numTurns: 0,
      },
      context(shared),
    );
    expect(aggregate.status).toBe('timed_out');
    expect(events[0]?.payload).toMatchObject({ cost: null });
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

describe('the unfinished work an ending saved (backlog 467)', () => {
  const saved = { branch: 'agentic/ACME-1', commit_sha: 'abc1234def', pushed: true };

  it('carries it on `run.failed` and `run.finished` when given, and omits the key when not', () => {
    const failed = failRun(
      runningRun(),
      {
        status: 'failed',
        terminalReason: 'error_max_turns',
        error: 'out of turns',
        savedWork: saved,
      },
      context(world()),
    );
    expect(failed.events[0]?.payload).toMatchObject({ saved_work: saved });

    const finished = finishRun(
      runningRun(),
      {
        status: 'timed_out',
        terminalReason: 'timed_out',
        usage,
        modelUsage: [],
        cost: null,
        numTurns: 12,
        savedWork: { ...saved, pushed: false, commit_sha: null },
      },
      context(world()),
    );
    expect(finished.events[0]?.payload).toMatchObject({
      saved_work: { ...saved, pushed: false, commit_sha: null },
    });

    const plain = failRun(
      runningRun(),
      { status: 'failed', terminalReason: 'crash', error: 'crashed' },
      context(world()),
    );
    expect(plain.events[0]?.payload).not.toHaveProperty('saved_work');
  });
});

describe('the cause a stop before the CLI spawn marker records (WP-154 (b′))', () => {
  const cause = {
    kind: 'not_started' as const,
    diagnosis:
      'cancelled by a person before its CLI was asked to start: while its workspace and run shim were being prepared',
    detail: null,
    truncated: false,
    attempt: 1,
    retryable: false,
  };

  it('carries it on `run.finished` when given, and omits the key when not', () => {
    const ending = {
      status: 'cancelled' as const,
      terminalReason: 'cancelled' as const,
      usage,
      modelUsage: [],
      cost: { usd: 0, is_estimate: false, price_list_id: null },
      numTurns: 0,
    };
    const stopped = finishRun(runningRun(), { ...ending, startFailure: cause }, context(world()));
    expect(stopped.events[0]?.payload).toMatchObject({ start_failure: cause });
    expect(runFinishedEvent.safeParse(stopped.events[0]).success).toBe(true);

    const started = finishRun(runningRun(), ending, context(world()));
    expect(started.events[0]?.payload).not.toHaveProperty('start_failure');
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

describe('the offer and the claim (WP-274, TD-031 decisions 1–2)', () => {
  const OFFER_ID = '00000000-0000-4000-8000-0000000000c1';

  it('records run.offered then run.claimed on the run stream, the claim moving it to `starting`', () => {
    const shared = world();
    const recorded = recordedRun(shared);
    const offered = offerRun(recorded, { offerId: OFFER_ID, kind: 'stage' }, context(shared));
    const claimed = claimRun(
      offered.aggregate,
      { offerId: OFFER_ID, claimantKind: 'server', workerId: null, epoch: 1 },
      context(shared),
    );
    expect(offered.aggregate.status).toBe('created');
    expect(claimed.aggregate.status).toBe('starting');
    expect([...offered.events, ...claimed.events].map((event) => event.type)).toEqual([
      'run.offered',
      'run.claimed',
    ]);
    expect(offered.events[0]?.payload).toMatchObject({
      run_id: RUN_ID,
      offer_id: OFFER_ID,
      kind: 'stage',
      stage: 'implementation',
      attempt: 1,
    });
    expect(claimed.events[0]?.payload).toMatchObject({
      offer_id: OFFER_ID,
      claimant_kind: 'server',
      worker_id: null,
      lease_epoch: 1,
    });
    // The stream continues: `run.started` follows the claim (TD-031 §1).
    const running = markRunning(claimed.aggregate, { contextPack }, context(shared));
    expect(running.events[0]?.stream_seq).toBe((claimed.events[0]?.stream_seq ?? 0) + 1);
  });

  it('refuses a claim at an epoch below 1, and an offer or claim of an ended run', () => {
    const shared = world();
    const recorded = recordedRun(shared);
    expect(() =>
      claimRun(
        recorded,
        { offerId: OFFER_ID, claimantKind: 'server', workerId: null, epoch: 0 },
        context(shared),
      ),
    ).toThrow(InvariantViolationError);
    const ended = failRun(
      runningRun(shared),
      { status: 'failed', terminalReason: 'error_during_execution', error: 'boom' },
      context(shared),
    ).aggregate;
    expect(() => offerRun(ended, { offerId: OFFER_ID, kind: 'stage' }, context(shared))).toThrow(
      InvariantViolationError,
    );
    expect(() =>
      claimRun(
        ended,
        { offerId: OFFER_ID, claimantKind: 'server', workerId: null, epoch: 1 },
        context(shared),
      ),
    ).toThrow(InvariantViolationError);
  });
});

describe('releaseRunClaim (WP-281, TD-031 decision 6)', () => {
  const release = {
    offerId: '00000000-0000-4000-8000-0000000000c0',
    workerId: '00000000-0000-4000-8000-0000000000d1',
    epoch: 1,
    reason: 'image_missing',
  } as const;

  it('moves a claimed run starting → created and records run.offer.released after run.claimed', () => {
    const shared = world();
    const started = startedRun(shared);
    const released = releaseRunClaim(started, release, context(shared));
    expect(released.aggregate.status).toBe('created');
    expect(released.events.map((event) => event.type)).toEqual(['run.offer.released']);
    expect(released.events[0]?.stream_seq).toBe(started.sequence);
    expect(released.events[0]?.payload).toMatchObject({
      run_id: RUN_ID,
      worker_id: release.workerId,
      lease_epoch: 1,
      reason: 'image_missing',
    });
    // Claimed again afterwards: the released run is an ordinary `created` run.
    expect(
      claimRun(
        released.aggregate,
        { ...release, claimantKind: 'worker', epoch: 2 },
        context(shared),
      ).aggregate.status,
    ).toBe('starting');
  });

  it('refuses a run that started, one never claimed and one that ended', () => {
    const shared = world();
    expect(() => releaseRunClaim(runningRun(shared), release, context(shared))).toThrow(
      IllegalTransitionError,
    );
    expect(() => releaseRunClaim(recordedRun(shared), release, context(shared))).toThrow(
      IllegalTransitionError,
    );
    const ended = failRun(
      startedRun(shared),
      { status: 'failed', terminalReason: 'error_during_execution', error: 'launcher refused' },
      context(shared),
    ).aggregate;
    expect(() => releaseRunClaim(ended, release, context(shared))).toThrow(IllegalTransitionError);
  });

  it('refuses an epoch below 1', () => {
    const shared = world();
    expect(() =>
      releaseRunClaim(startedRun(shared), { ...release, epoch: 0 }, context(shared)),
    ).toThrow(InvariantViolationError);
  });
});

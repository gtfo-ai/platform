/**
 * Model-based property test for the Run state machine (technical/10, technical/02).
 *
 * The model is the transition table plus "`run.created` first, at most one `run.started`, then
 * exactly one terminal event". Every command runs; the model predicts success or the typed
 * rejection. Since WP-275b the run is recorded in `created` when its row is written with its offer,
 * so the setup records it, and the claim is the command that moves it to `starting`.
 */
import type {
  ContextPackRecord,
  DomainEvent,
  RunStatus,
  RunTerminalReason,
  TokenUsage,
} from '@platform/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type Clock, fixedClock } from '../clock.js';
import { IllegalTransitionError, InvariantViolationError } from '../errors.js';
import type { CommandContext } from '../events.js';
import { type IdSource, sequentialIds } from '../ids.js';
import { MODEL_RUNS, PROPERTY_TEST_TIMEOUT_MS } from '../testing/property.js';
import {
  canTransitionRun,
  claimRun,
  createRun,
  failRun,
  finishRun,
  isActiveRunStatus,
  markRunning,
  RUN_TRANSITIONS,
  type Run,
  recordOutput,
  recordRunCreated,
} from './run.js';

const RUN_ID = '00000000-0000-4000-8000-0000000000f1';
const TASK_ID = '00000000-0000-4000-8000-0000000000aa';
const PROJECT_ID = '00000000-0000-4000-8000-0000000000bb';

const contextPack: ContextPackRecord = {
  tier0: [],
  tier1: [],
  budget_tokens: 1_000,
  total_tokens: 0,
  kb_commit: null,
};

const usage: TokenUsage = {
  input_tokens: 10,
  output_tokens: 5,
  cache_write_5m_tokens: 0,
  cache_write_1h_tokens: 0,
  cache_read_tokens: 0,
};

interface RunModel {
  status: RunStatus;
  created: boolean;
  started: boolean;
  terminalEvents: number;
}

interface RunReal {
  run: Run;
  events: DomainEvent[];
  readonly ids: IdSource;
  readonly clock: Clock;
}

const context = (real: RunReal): CommandContext => ({
  ids: real.ids,
  actor: { kind: 'system', component: 'model-test' },
  clock: real.clock,
});

const recorded = (real: Omit<RunReal, 'run' | 'events'> & { readonly run: Run }): RunReal => {
  const decision = recordRunCreated(real.run, context({ ...real, events: [] }));
  return { ...real, run: decision.aggregate, events: [...decision.events] };
};

const setup = (): { model: RunModel; real: RunReal } => ({
  model: { status: 'created', created: true, started: false, terminalEvents: 0 },
  real: recorded({
    run: createRun({
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
    }),
    ids: sequentialIds(),
    clock: fixedClock('2026-09-09T09:00:00.000Z', 30_000),
  }),
});

const assertInvariants = (model: RunModel, real: RunReal): void => {
  expect(Object.keys(RUN_TRANSITIONS)).toContain(real.run.status);
  expect(real.run.status).toBe(model.status);

  // `run.created` is emitted exactly once and `run.started` at most once, and only after the transition
  // that produces them; nothing in the log appears twice.
  expect(real.events.filter((event) => event.type === 'run.created')).toHaveLength(
    model.created ? 1 : 0,
  );
  expect(real.events.filter((event) => event.type === 'run.started')).toHaveLength(
    model.started ? 1 : 0,
  );
  // Nothing reaches the log before `run.created`: the first event on the stream is always it.
  expect(real.events[0]?.type ?? 'run.created').toBe('run.created');

  // A terminal status produces exactly one terminal event, and nothing follows it.
  const terminal = real.events.filter(
    (event) => event.type === 'run.finished' || event.type === 'run.failed',
  );
  // `run.started` is the CLI spawn marker's event (WP-275b): a run that ended without one never
  // reached `running`, and nothing but `run.claimed` (and the ending) may precede it.
  expect(terminal).toHaveLength(model.terminalEvents);
  expect(model.terminalEvents).toBeLessThanOrEqual(1);
  if (!isActiveRunStatus(real.run.status)) {
    expect(real.run.endedAt).not.toBeNull();
    expect(real.run.terminalReason).not.toBeNull();
  }

  // Contiguous from `FIRST_STREAM_SEQ`: the database's `stream_seq >= 1` check refuses a stream
  // that opens at zero (migration 0005).
  expect(real.events.map((event) => event.stream_seq)).toEqual(
    real.events.map((_, index) => index + 1),
  );
  expect(real.run.sequence).toBe(real.events.length + 1);
  expect(new Set(real.events.map((event) => event.id)).size).toBe(real.events.length);
};

type RunCommand = fc.Command<RunModel, RunReal>;

class Claim implements RunCommand {
  check(): boolean {
    return true;
  }
  run(model: RunModel, real: RunReal): void {
    const claim = {
      offerId: '00000000-0000-4000-8000-0000000000c1',
      claimantKind: 'server' as const,
      workerId: null,
      epoch: 1,
    };
    if (!isActiveRunStatus(model.status)) {
      // An ended run is offered and claimed by nobody (`assertOfferable`).
      expect(() => claimRun(real.run, claim, context(real))).toThrow(InvariantViolationError);
      return;
    }
    if (!canTransitionRun(model.status, 'starting')) {
      expect(() => claimRun(real.run, claim, context(real))).toThrow(IllegalTransitionError);
      return;
    }
    const decision = claimRun(real.run, claim, context(real));
    real.run = decision.aggregate;
    real.events.push(...decision.events);
    model.status = 'starting';
  }
  toString(): string {
    return 'claim()';
  }
}

class MarkRunning implements RunCommand {
  check(): boolean {
    return true;
  }
  run(model: RunModel, real: RunReal): void {
    const command = (): unknown => markRunning(real.run, { contextPack }, context(real));
    if (!canTransitionRun(model.status, 'running')) {
      expect(command).toThrow(IllegalTransitionError);
      return;
    }
    const decision = markRunning(real.run, { contextPack }, context(real));
    real.run = decision.aggregate;
    real.events.push(...decision.events);
    model.status = 'running';
    model.started = true;
  }
  toString(): string {
    return 'markRunning()';
  }
}

class RecordOutput implements RunCommand {
  check(): boolean {
    return true;
  }
  run(model: RunModel, real: RunReal): void {
    const at = real.clock.now();
    if (model.status !== 'running') {
      expect(() => recordOutput(real.run, at)).toThrow(InvariantViolationError);
      return;
    }
    real.run = recordOutput(real.run, at);
  }
  toString(): string {
    return 'recordOutput()';
  }
}

class Finish implements RunCommand {
  private readonly status: 'completed' | 'cancelled' | 'budget_exceeded' | 'timed_out';
  private readonly reason: RunTerminalReason;
  constructor(
    status: 'completed' | 'cancelled' | 'budget_exceeded' | 'timed_out',
    reason: RunTerminalReason,
  ) {
    this.status = status;
    this.reason = reason;
  }
  check(): boolean {
    return true;
  }
  run(model: RunModel, real: RunReal): void {
    const input = {
      status: this.status,
      terminalReason: this.reason,
      usage,
      modelUsage: [],
      cost: { usd: 0.01, is_estimate: false },
      numTurns: 3,
    } as const;
    if (!canTransitionRun(model.status, this.status)) {
      expect(() => finishRun(real.run, input, context(real))).toThrow(IllegalTransitionError);
      return;
    }
    const decision = finishRun(real.run, input, context(real));
    real.run = decision.aggregate;
    real.events.push(...decision.events);
    model.status = this.status;
    model.terminalEvents += 1;
  }
  toString(): string {
    return `finish(${this.status})`;
  }
}

class Fail implements RunCommand {
  private readonly status: 'failed' | 'stalled';
  constructor(status: 'failed' | 'stalled') {
    this.status = status;
  }
  check(): boolean {
    return true;
  }
  run(model: RunModel, real: RunReal): void {
    const input = {
      status: this.status,
      terminalReason: this.status === 'stalled' ? ('stalled' as const) : ('crash' as const),
      error: 'model test',
    };
    if (!canTransitionRun(model.status, this.status)) {
      expect(() => failRun(real.run, input, context(real))).toThrow(IllegalTransitionError);
      return;
    }
    const decision = failRun(real.run, input, context(real));
    real.run = decision.aggregate;
    real.events.push(...decision.events);
    model.status = this.status;
    model.terminalEvents += 1;
  }
  toString(): string {
    return `fail(${this.status})`;
  }
}

class Checked implements RunCommand {
  private readonly inner: RunCommand;
  constructor(inner: RunCommand) {
    this.inner = inner;
  }
  check(model: Readonly<RunModel>): boolean {
    return this.inner.check(model);
  }
  run(model: RunModel, real: RunReal): void {
    this.inner.run(model, real);
    assertInvariants(model, real);
  }
  toString(): string {
    return this.inner.toString();
  }
}

const commandArbitraries: fc.Arbitrary<RunCommand>[] = [
  fc.constant(new Claim()),
  fc.constant(new MarkRunning()),
  fc.constant(new RecordOutput()),
  fc.constantFrom(
    new Finish('completed', 'success'),
    new Finish('cancelled', 'cancelled'),
    new Finish('budget_exceeded', 'error_max_budget_usd'),
    new Finish('timed_out', 'timed_out'),
  ),
  fc.constantFrom(new Fail('failed'), new Fail('stalled')),
].map((arbitrary) => arbitrary.map((command) => new Checked(command)));

describe('Run state machine — model-based properties', () => {
  it(
    'keeps the aggregate in step with technical/02 for every command sequence',
    () => {
      fc.assert(
        fc.property(fc.commands(commandArbitraries, { size: '+1' }), (commands) => {
          fc.modelRun(setup, commands);
        }),
        { numRuns: MODEL_RUNS },
      );
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );
});

/**
 * **Every ending a run can reach before its CLI spawn marker is a legal edge from `starting`**
 * (WP-275b criterion 1): since `run.started` is appended at the marker, a run that ends before it
 * ends from `starting` — and each of these endings is written by a real writer today: a start
 * failure and a hand-back (`settleRun`'s `not_started` and `shutdown` branches), a person's stop
 * (`cancelled`), the lease sweep (`failed`/`lease_expired`) and the wall clock (`timed_out`).
 */
describe('endings before the CLI spawn marker', () => {
  const PRE_MARKER_ENDINGS = [
    {
      writer: 'a start failure (settleRun not_started)',
      status: 'failed',
      reason: 'error_during_execution',
    },
    { writer: 'a shutdown hand-back', status: 'failed', reason: 'shutdown' },
    { writer: "a person's cancel or take-over stop", status: 'cancelled', reason: 'cancelled' },
    { writer: 'the lease sweep', status: 'failed', reason: 'lease_expired' },
    { writer: 'the wall clock', status: 'timed_out', reason: 'timed_out' },
  ] as const;

  it('ends a claimed, unspawned run through each writer, legally, with no run.started', () => {
    fc.assert(
      fc.property(fc.constantFrom(...PRE_MARKER_ENDINGS), (ending) => {
        const { real } = setup();
        const claimed = claimRun(
          real.run,
          {
            offerId: '00000000-0000-4000-8000-0000000000c1',
            claimantKind: 'server',
            workerId: null,
            epoch: 1,
          },
          context(real),
        );
        expect(canTransitionRun(claimed.aggregate.status, ending.status)).toBe(true);
        const decision =
          ending.status === 'failed'
            ? failRun(
                claimed.aggregate,
                { status: 'failed', terminalReason: ending.reason, error: ending.writer },
                context(real),
              )
            : finishRun(
                claimed.aggregate,
                {
                  status: ending.status,
                  terminalReason: ending.reason,
                  usage,
                  modelUsage: [],
                  cost: null,
                  numTurns: 0,
                },
                context(real),
              );
        const events = [...real.events, ...claimed.events, ...decision.events].map(
          (event) => event.type,
        );
        expect(events).toEqual([
          'run.created',
          'run.claimed',
          ending.status === 'failed' ? 'run.failed' : 'run.finished',
        ]);
        expect(decision.aggregate.startedAt).toBeNull();
      }),
      { numRuns: MODEL_RUNS },
    );
  });
});

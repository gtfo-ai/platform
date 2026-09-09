/**
 * Model-based property test for the Run state machine (technical/10, technical/02).
 *
 * The model is the transition table plus "one `run.started`, then exactly one terminal event".
 * Every command runs; the model predicts success or the typed rejection.
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
import {
  IllegalTransitionError,
  InvariantViolationError,
  PermissionDeniedError,
} from '../errors.js';
import type { CommandContext } from '../events.js';
import { type IdSource, sequentialIds } from '../ids.js';
import { MODEL_RUNS, PROPERTY_TEST_TIMEOUT_MS } from '../testing/property.js';
import {
  canTransitionRun,
  createRun,
  failRun,
  finishRun,
  isActiveRunStatus,
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

const setup = (): { model: RunModel; real: RunReal } => ({
  model: { status: 'created', created: false, started: false, terminalEvents: 0 },
  real: {
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
    events: [],
    ids: sequentialIds(),
    clock: fixedClock('2026-09-09T09:00:00.000Z', 30_000),
  },
});

const assertInvariants = (model: RunModel, real: RunReal): void => {
  expect(Object.keys(RUN_TRANSITIONS)).toContain(real.run.status);
  expect(real.run.status).toBe(model.status);

  // `run.created` and `run.started` are each emitted at most once, and only after the transition
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
  expect(terminal).toHaveLength(model.terminalEvents);
  expect(model.terminalEvents).toBeLessThanOrEqual(1);
  if (!isActiveRunStatus(real.run.status)) {
    expect(real.run.endedAt).not.toBeNull();
    expect(real.run.terminalReason).not.toBeNull();
  }

  expect(real.events.map((event) => event.stream_seq)).toEqual(
    real.events.map((_, index) => index),
  );
  expect(real.run.sequence).toBe(real.events.length);
  expect(new Set(real.events.map((event) => event.id)).size).toBe(real.events.length);
};

type RunCommand = fc.Command<RunModel, RunReal>;

class Start implements RunCommand {
  check(): boolean {
    return true;
  }
  run(model: RunModel, real: RunReal): void {
    if (!canTransitionRun(model.status, 'starting')) {
      expect(() => startRun(real.run, context(real))).toThrow(IllegalTransitionError);
      return;
    }
    const decision = startRun(real.run, context(real));
    real.run = decision.aggregate;
    real.events.push(...decision.events);
    model.status = 'starting';
    model.created = true;
  }
  toString(): string {
    return 'start()';
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
  constructor(
    private readonly status: 'completed' | 'cancelled' | 'budget_exceeded' | 'timed_out',
    private readonly reason: RunTerminalReason,
  ) {}
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
  constructor(private readonly status: 'failed' | 'stalled') {}
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

class Steer implements RunCommand {
  check(): boolean {
    return true;
  }
  run(model: RunModel, real: RunReal): void {
    const input = {
      message: 'try the other helper',
      authorUserId: USER_ID,
      authorRole: 'member' as const,
    };
    if (model.status !== 'running') {
      expect(() => steerRun(real.run, input, context(real))).toThrow(PermissionDeniedError);
      return;
    }
    const decision = steerRun(real.run, input, context(real));
    real.run = decision.aggregate;
    real.events.push(...decision.events);
  }
  toString(): string {
    return 'steer()';
  }
}

class Checked implements RunCommand {
  constructor(private readonly inner: RunCommand) {}
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
  fc.constant(new Start()),
  fc.constant(new MarkRunning()),
  fc.constant(new RecordOutput()),
  fc.constantFrom(
    new Finish('completed', 'success'),
    new Finish('cancelled', 'cancelled'),
    new Finish('budget_exceeded', 'error_max_budget_usd'),
    new Finish('timed_out', 'timed_out'),
  ),
  fc.constantFrom(new Fail('failed'), new Fail('stalled')),
  fc.constant(new Steer()),
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

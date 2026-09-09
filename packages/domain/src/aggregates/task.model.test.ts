/**
 * Model-based property test for the Task state machine (technical/10: "fast-check property/
 * model-based tests (`fc.commands`) for the task/run/question state machines — every event
 * sequence leaves a legal state; iteration limits and WIP limits never exceeded").
 *
 * The model is technical/02's diagram: a state, a current stage and the iteration counters. Every
 * command is *always* run; the model predicts whether it succeeds or throws, so both the happy
 * path and the rejection of illegal transitions are under test rather than only the paths a
 * `check()` gate would let through.
 */
import type { DomainEvent, QuestionRecord, TaskState, TaskTotals } from '@platform/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type Clock, fixedClock } from '../clock.js';
import { IllegalTransitionError, InvariantViolationError } from '../errors.js';
import type { CommandContext } from '../events.js';
import { type IdSource, sequentialIds } from '../ids.js';
import {
  ITERATION_LOOPS,
  type IterationCounters,
  type IterationLimits,
  type IterationLoop,
  resolveIterationLimits,
} from '../policies/iteration-limits.js';
import {
  askQuestion,
  cancelTask,
  completeStage,
  completeTask,
  createTask,
  enterStage,
  escalateTask,
  handBackTask,
  markReadyForMerge,
  pauseTask,
  queueTask,
  recordMerge,
  requestApproval,
  returnToStage,
  startRetrospective,
  type Task,
  type TaskDecision,
  takeOverTask,
} from './task.js';
import { canTransitionTask, TASK_TRANSITIONS } from './task-state-machine.js';

const TASK_ID = '00000000-0000-4000-8000-0000000000aa';
const PROJECT_ID = '00000000-0000-4000-8000-0000000000bb';
const STAGES = ['refinement', 'architecture', 'implementation', 'code_review'] as const;

/**
 * One id source and one clock per world, so ids stay unique and timestamps advance across the
 * whole command sequence — the same discipline the application ring will use.
 */
const context = (real: TaskReal): CommandContext => ({
  ids: real.ids,
  actor: { kind: 'system', component: 'model-test' },
  clock: real.clock,
});

const totals: TaskTotals = { cost_usd: 1, is_estimate: false, runs: 1, wall_ms: 1 };

const question = (blocking: boolean): QuestionRecord => ({
  id: '00000000-0000-4000-8000-0000000000c1',
  task_id: TASK_ID,
  stage: 'refinement',
  run_id: null,
  text: 'a question',
  options: null,
  blocking,
  status: 'open',
  asked_at: '2026-09-09T09:00:00.000Z',
  deadline_at: null,
  reminders_sent: 0,
  answer: null,
  answered_by_user_id: null,
  answered_via: null,
  answered_at: null,
});

interface TaskModel {
  state: TaskState;
  currentStage: string | null;
  counters: Record<IterationLoop, number>;
  limits: IterationLimits;
  returns: number;
  escalations: number;
}

interface TaskReal {
  task: Task;
  events: DomainEvent[];
  readonly ids: IdSource;
  readonly clock: Clock;
}

/** Tight limits so the property reaches the escalation path in short command sequences. */
const LIMITS: IterationLimits = resolveIterationLimits({
  code_review_iterations: 2,
  business_review_iterations: 1,
  ci_fix_iterations: 1,
  human_rounds: 1,
});

const setup = (): { model: TaskModel; real: TaskReal } => {
  const ids = sequentialIds();
  const clock = fixedClock('2026-09-09T09:00:00.000Z', 1_000);
  const created = createTask(
    {
      id: TASK_ID,
      projectId: PROJECT_ID,
      ticket: { provider: 'jira-cloud', key: 'PROJ-1', url: 'https://example.invalid/PROJ-1' },
      template: 'feature',
      mode: 'normal',
      limits: LIMITS,
    },
    { ids, clock, actor: { kind: 'system', component: 'model-test' } },
  );
  return {
    model: {
      state: 'queued',
      currentStage: null,
      counters: Object.fromEntries(ITERATION_LOOPS.map((loop) => [loop, 0])) as Record<
        IterationLoop,
        number
      >,
      limits: LIMITS,
      returns: 0,
      escalations: 0,
    },
    real: { task: created.aggregate, events: [...created.events], ids, clock },
  };
};

const countersSum = (counters: IterationCounters): number =>
  ITERATION_LOOPS.reduce((sum, loop) => sum + (counters[loop] ?? 0), 0);

/**
 * The invariants, checked after every single command rather than only at the end of a sequence,
 * so a failure names the command that broke them.
 */
const assertInvariants = (model: TaskModel, real: TaskReal): void => {
  // 1. Every sequence leaves a legal state, and the state is the one the diagram predicts.
  expect(Object.keys(TASK_TRANSITIONS)).toContain(real.task.state);
  expect(real.task.state).toBe(model.state);
  expect(real.task.currentStage).toBe(model.currentStage);

  // 2. Iteration limits are never exceeded (BD-008, technical/02 invariants).
  for (const loop of ITERATION_LOOPS) {
    expect(real.task.iterationCounters[loop] ?? 0).toBeLessThanOrEqual(model.limits[loop]);
    expect(real.task.iterationCounters[loop] ?? 0).toBe(model.counters[loop]);
  }

  // 3. One `task.stage.returned` per counted iteration, no more.
  expect(real.events.filter((event) => event.type === 'task.stage.returned')).toHaveLength(
    model.returns,
  );
  expect(countersSum(real.task.iterationCounters)).toBe(model.returns);

  // 4. Every escalation is recorded as an event.
  expect(real.events.filter((event) => event.type === 'task.escalated')).toHaveLength(
    model.escalations,
  );

  // 5. The stream is contiguous, matches the aggregate's sequence, and has unique ids.
  expect(real.events.map((event) => event.stream_seq)).toEqual(
    real.events.map((_, index) => index),
  );
  expect(real.task.sequence).toBe(real.events.length);
  expect(new Set(real.events.map((event) => event.id)).size).toBe(real.events.length);
};

/** Runs a command that moves the machine to `target`, asserting success or rejection. */
const transition = (
  model: TaskModel,
  real: TaskReal,
  target: TaskState,
  command: () => TaskDecision,
): TaskDecision | null => {
  if (!canTransitionTask(model.state, target)) {
    expect(command).toThrow(IllegalTransitionError);
    return null;
  }
  const decision = command();
  real.task = decision.aggregate;
  real.events.push(...decision.events);
  model.state = target;
  return decision;
};

type TaskCommand = fc.Command<TaskModel, TaskReal>;

class EnterStage implements TaskCommand {
  constructor(private readonly stage: string) {}
  check(): boolean {
    return true;
  }
  run(model: TaskModel, real: TaskReal): void {
    const decision = transition(model, real, 'active', () =>
      enterStage(real.task, { stage: this.stage }, context(real)),
    );
    if (decision !== null) {
      model.currentStage = this.stage;
    }
  }
  toString(): string {
    return `enterStage(${this.stage})`;
  }
}

class CompleteStage implements TaskCommand {
  check(): boolean {
    return true;
  }
  run(model: TaskModel, real: TaskReal): void {
    const stage = model.currentStage ?? 'refinement';
    const command = (): TaskDecision =>
      completeStage(real.task, { stage, artifacts: [] }, context(real));
    if (model.state !== 'active' || model.currentStage === null) {
      expect(command).toThrow(InvariantViolationError);
      return;
    }
    const decision = command();
    real.task = decision.aggregate;
    real.events.push(...decision.events);
  }
  toString(): string {
    return 'completeStage()';
  }
}

class ReturnToStage implements TaskCommand {
  constructor(private readonly loop: IterationLoop) {}
  check(): boolean {
    return true;
  }
  run(model: TaskModel, real: TaskReal): void {
    const command = (): TaskDecision =>
      returnToStage(
        real.task,
        {
          fromStage: model.currentStage ?? 'code_review',
          toStage: 'implementation',
          loop: this.loop,
          reason: 'model test',
          escalationBrief: 'a human must look at this',
        },
        context(real),
      );
    const exhausted = model.counters[this.loop] >= model.limits[this.loop];
    const target: TaskState = exhausted ? 'needs_human' : 'returned';
    const decision = transition(model, real, target, command);
    if (decision === null) {
      return;
    }
    if (exhausted) {
      model.escalations += 1;
    } else {
      model.counters[this.loop] += 1;
      model.returns += 1;
    }
  }
  toString(): string {
    return `returnToStage(${this.loop})`;
  }
}

class AskQuestion implements TaskCommand {
  constructor(private readonly blocking: boolean) {}
  check(): boolean {
    return true;
  }
  run(model: TaskModel, real: TaskReal): void {
    const command = (): TaskDecision =>
      askQuestion(real.task, { question: question(this.blocking) }, context(real));
    if (model.state !== 'active') {
      expect(command).toThrow(InvariantViolationError);
      return;
    }
    const decision = command();
    real.task = decision.aggregate;
    real.events.push(...decision.events);
    if (this.blocking) {
      model.state = 'waiting_answers';
    }
  }
  toString(): string {
    return `askQuestion(blocking=${this.blocking})`;
  }
}

class RequestApproval implements TaskCommand {
  check(): boolean {
    return true;
  }
  run(model: TaskModel, real: TaskReal): void {
    transition(model, real, 'waiting_approval', () =>
      requestApproval(
        real.task,
        {
          approval: {
            id: '00000000-0000-4000-8000-0000000000d1',
            task_id: TASK_ID,
            kind: 'plan',
            status: 'pending',
            requested_at: '2026-09-09T09:00:00.000Z',
            deadline_at: null,
            decided_by_user_id: null,
            decided_at: null,
            reason: null,
          },
        },
        context(real),
      ),
    );
  }
  toString(): string {
    return 'requestApproval()';
  }
}

class Pause implements TaskCommand {
  check(): boolean {
    return true;
  }
  run(model: TaskModel, real: TaskReal): void {
    transition(model, real, 'paused', () =>
      pauseTask(real.task, { reason: 'manual' }, context(real)),
    );
  }
  toString(): string {
    return 'pause()';
  }
}

class Escalate implements TaskCommand {
  check(): boolean {
    return true;
  }
  run(model: TaskModel, real: TaskReal): void {
    const decision = transition(model, real, 'needs_human', () =>
      escalateTask(
        real.task,
        { reason: 'stuck', blockerBrief: 'decide the approach' },
        context(real),
      ),
    );
    if (decision !== null) {
      model.escalations += 1;
    }
  }
  toString(): string {
    return 'escalate()';
  }
}

class TakeOver implements TaskCommand {
  check(): boolean {
    return true;
  }
  run(model: TaskModel, real: TaskReal): void {
    transition(model, real, 'paused', () =>
      takeOverTask(
        real.task,
        { branch: 'agentic/PROJ-1', stage: model.currentStage ?? 'implementation' },
        context(real),
      ),
    );
  }
  toString(): string {
    return 'takeOver()';
  }
}

class HandBack implements TaskCommand {
  check(): boolean {
    return true;
  }
  run(model: TaskModel, real: TaskReal): void {
    const stage = 'code_review';
    const decision = transition(model, real, 'active', () =>
      handBackTask(
        real.task,
        { branch: 'agentic/PROJ-1', stage, summary: 'continued by hand' },
        context(real),
      ),
    );
    if (decision !== null) {
      model.currentStage = stage;
    }
  }
  toString(): string {
    return 'handBack()';
  }
}

class ReadyForMerge implements TaskCommand {
  check(): boolean {
    return true;
  }
  run(model: TaskModel, real: TaskReal): void {
    const decision = transition(model, real, 'ready_for_merge', () =>
      markReadyForMerge(real.task, context(real)),
    );
    if (decision !== null) {
      model.currentStage = 'ready_for_merge';
    }
  }
  toString(): string {
    return 'readyForMerge()';
  }
}

class Merge implements TaskCommand {
  check(): boolean {
    return true;
  }
  run(model: TaskModel, real: TaskReal): void {
    const decision = transition(model, real, 'merged', () => recordMerge(real.task, context(real)));
    if (decision !== null) {
      model.currentStage = 'merged_gate';
    }
  }
  toString(): string {
    return 'merge()';
  }
}

class Retro implements TaskCommand {
  check(): boolean {
    return true;
  }
  run(model: TaskModel, real: TaskReal): void {
    const decision = transition(model, real, 'retro', () =>
      startRetrospective(real.task, context(real)),
    );
    if (decision !== null) {
      model.currentStage = 'retrospective';
    }
  }
  toString(): string {
    return 'retro()';
  }
}

class Complete implements TaskCommand {
  check(): boolean {
    return true;
  }
  run(model: TaskModel, real: TaskReal): void {
    transition(model, real, 'done', () =>
      completeTask(real.task, { outcome: 'merged', totals }, context(real)),
    );
  }
  toString(): string {
    return 'complete()';
  }
}

class Cancel implements TaskCommand {
  check(): boolean {
    return true;
  }
  run(model: TaskModel, real: TaskReal): void {
    transition(model, real, 'cancelled', () =>
      cancelTask(real.task, { outcome: 'cancelled', totals }, context(real)),
    );
  }
  toString(): string {
    return 'cancel()';
  }
}

class Queue implements TaskCommand {
  check(): boolean {
    return true;
  }
  run(model: TaskModel, real: TaskReal): void {
    const command = (): TaskDecision => queueTask(real.task, { reason: 'wip' }, context(real));
    if (model.state !== 'queued') {
      expect(command).toThrow(InvariantViolationError);
      return;
    }
    const decision = command();
    real.task = decision.aggregate;
    real.events.push(...decision.events);
  }
  toString(): string {
    return 'queue()';
  }
}

/** Wraps a command so the invariants are re-checked after every step of every sequence. */
class Checked implements TaskCommand {
  constructor(private readonly inner: TaskCommand) {}
  check(model: Readonly<TaskModel>): boolean {
    return this.inner.check(model);
  }
  run(model: TaskModel, real: TaskReal): void {
    this.inner.run(model, real);
    assertInvariants(model, real);
  }
  toString(): string {
    return this.inner.toString();
  }
}

const rawCommandArbitraries: fc.Arbitrary<TaskCommand>[] = [
  fc.constantFrom(...STAGES).map((stage) => new EnterStage(stage)),
  fc.constant(new CompleteStage()),
  fc.constantFrom(...ITERATION_LOOPS).map((loop) => new ReturnToStage(loop)),
  fc.boolean().map((blocking) => new AskQuestion(blocking)),
  fc.constant(new RequestApproval()),
  fc.constant(new Pause()),
  fc.constant(new Escalate()),
  fc.constant(new TakeOver()),
  fc.constant(new HandBack()),
  fc.constant(new ReadyForMerge()),
  fc.constant(new Merge()),
  fc.constant(new Retro()),
  fc.constant(new Complete()),
  fc.constant(new Cancel()),
  fc.constant(new Queue()),
];

const commandArbitraries: fc.Arbitrary<TaskCommand>[] = rawCommandArbitraries.map((arbitrary) =>
  arbitrary.map((command) => new Checked(command)),
);

describe('Task state machine — model-based properties', () => {
  it('keeps the aggregate in step with technical/02 for every command sequence', () => {
    fc.assert(
      fc.property(fc.commands(commandArbitraries, { size: '+1' }), (commands) => {
        fc.modelRun(setup, commands);
      }),
      { numRuns: 300 },
    );
  });

  it('escalates rather than exceeding a limit, for any number of returns', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ITERATION_LOOPS),
        fc.integer({ min: 1, max: 8 }),
        (loop, attempts) => {
          const { real } = setup();
          let task = enterStage(real.task, { stage: 'code_review' }, context(real)).aggregate;
          const events: DomainEvent[] = [];
          for (let round = 0; round < attempts; round += 1) {
            const decision = returnToStage(
              task,
              {
                fromStage: 'code_review',
                toStage: 'implementation',
                loop,
                reason: 'again',
                escalationBrief: 'human needed',
              },
              context(real),
            );
            task = decision.aggregate;
            events.push(...decision.events);
            if (task.state === 'needs_human') {
              break;
            }
            task = enterStage(task, { stage: 'code_review' }, context(real)).aggregate;
          }
          const counter = task.iterationCounters[loop] ?? 0;
          expect(counter).toBeLessThanOrEqual(LIMITS[loop]);
          if (attempts > LIMITS[loop]) {
            expect(task.state).toBe('needs_human');
            expect(events.some((event) => event.type === 'task.escalated')).toBe(true);
          }
        },
      ),
    );
  });
});

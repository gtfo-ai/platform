import type { ApprovalRecord, DomainEvent, QuestionRecord, TaskTotals } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { fixedClock } from '../clock.js';
import { IllegalTransitionError, InvariantViolationError } from '../errors.js';
import type { CommandContext } from '../events.js';
import { sequentialIds } from '../ids.js';
import { resolveIterationLimits } from '../policies/iteration-limits.js';
import {
  askQuestion,
  assertMutatingActionAllowed,
  cancelTask,
  completeStage,
  completeTask,
  createTask,
  enterStage,
  escalateTask,
  handBackTask,
  isTaskFinished,
  markReadyForMerge,
  pauseTask,
  queueTask,
  recordMerge,
  requestApproval,
  returnToStage,
  startRetrospective,
  type Task,
  takeOverTask,
} from './task.js';

const TASK_ID = '00000000-0000-4000-8000-0000000000aa';
const PROJECT_ID = '00000000-0000-4000-8000-0000000000bb';

const context = (): CommandContext => ({
  ids: sequentialIds(),
  actor: { kind: 'system', component: 'test' },
  clock: fixedClock('2026-09-09T09:00:00.000Z', 1_000),
});

const ticket = {
  provider: 'jira-cloud',
  key: 'PROJ-1',
  url: 'https://example.invalid/browse/PROJ-1',
};

const totals: TaskTotals = { cost_usd: 4.5, is_estimate: false, runs: 3, wall_ms: 1_000 };

const newTask = (overrides: Partial<Task> = {}): Task => ({
  ...createTask(
    { id: TASK_ID, projectId: PROJECT_ID, ticket, template: 'feature', mode: 'normal' },
    context(),
  ).aggregate,
  ...overrides,
});

/** A task sitting in `active` at `stage`, as the pipeline would have left it. */
const activeTask = (stage = 'implementation', overrides: Partial<Task> = {}): Task => ({
  ...newTask(),
  state: 'active',
  currentStage: stage,
  stageAttempts: { [stage]: 1 },
  ...overrides,
});

const types = (events: readonly DomainEvent[]): string[] => events.map((event) => event.type);

const questionRecord = (blocking: boolean): QuestionRecord => ({
  id: '00000000-0000-4000-8000-0000000000c1',
  task_id: TASK_ID,
  stage: 'refinement',
  run_id: null,
  text: 'Which locale should the export use?',
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

const approvalRecord: ApprovalRecord = {
  id: '00000000-0000-4000-8000-0000000000d1',
  task_id: TASK_ID,
  kind: 'plan',
  status: 'pending',
  requested_at: '2026-09-09T09:00:00.000Z',
  deadline_at: null,
  decided_by_user_id: null,
  decided_at: null,
  reason: null,
};

describe('createTask', () => {
  it('starts queued and emits task.created', () => {
    const { aggregate, events } = createTask(
      {
        id: TASK_ID,
        projectId: PROJECT_ID,
        ticket,
        template: 'feature',
        mode: 'normal',
        estimateUsd: 18,
      },
      context(),
    );

    expect(aggregate.state).toBe('queued');
    expect(aggregate.currentStage).toBeNull();
    expect(aggregate.sequence).toBe(1);
    expect(aggregate.limits).toEqual(resolveIterationLimits());
    expect(types(events)).toEqual(['task.created']);
    const [created] = events;
    expect(created?.payload).toMatchObject({ estimate_usd: 18, template: 'feature' });
    expect(created?.stream_type).toBe('task');
    expect(created?.correlation_id).toBe(TASK_ID);
  });

  it('takes the effective iteration limits when it has them', () => {
    const limits = resolveIterationLimits({ code_review_iterations: 1 });
    const { aggregate } = createTask(
      { id: TASK_ID, projectId: PROJECT_ID, ticket, template: 'bug', mode: 'shadow', limits },
      context(),
    );
    expect(aggregate.limits.code_review).toBe(1);
    expect(aggregate.mode).toBe('shadow');
  });
});

describe('queueTask', () => {
  it('records why the task is still waiting', () => {
    const { aggregate, events } = queueTask(newTask(), { reason: 'wip' }, context());
    expect(aggregate.state).toBe('queued');
    expect(types(events)).toEqual(['task.queued']);
    expect(events[0]?.payload).toMatchObject({ reason: 'wip' });
  });

  it('refuses to queue a task that already left the queue', () => {
    expect(() => queueTask(activeTask(), { reason: 'wip' }, context())).toThrow(
      InvariantViolationError,
    );
  });
});

describe('enterStage', () => {
  it('moves a queued task into its first stage', () => {
    const { aggregate, events } = enterStage(
      newTask(),
      { stage: 'refinement', dequeueReason: 'wip' },
      context(),
    );
    expect(aggregate.state).toBe('active');
    expect(aggregate.currentStage).toBe('refinement');
    expect(aggregate.stageAttempts).toEqual({ refinement: 1 });
    expect(types(events)).toEqual(['task.dequeued', 'task.stage.entered']);
    expect(events[1]?.payload).toMatchObject({ stage: 'refinement', attempt: 1 });
  });

  it('counts attempts per stage', () => {
    const first = enterStage(newTask(), { stage: 'implementation' }, context());
    const second = enterStage(first.aggregate, { stage: 'implementation' }, context());
    expect(second.aggregate.stageAttempts).toEqual({ implementation: 2 });
    expect(second.events[0]?.payload).toMatchObject({ attempt: 2 });
  });

  it('emits task.resumed when the task was waiting', () => {
    const waiting = newTask({ state: 'waiting_answers' });
    const { events } = enterStage(
      waiting,
      { stage: 'refinement', resumeReason: 'question answered' },
      context(),
    );
    expect(types(events)).toEqual(['task.resumed', 'task.stage.entered']);
    expect(events[0]?.payload).toMatchObject({ reason: 'question answered' });
  });

  it('does not claim a resume when the task was already active', () => {
    const { events } = enterStage(activeTask('refinement'), { stage: 'architecture' }, context());
    expect(types(events)).toEqual(['task.stage.entered']);
  });

  it('refuses to reactivate a finished task', () => {
    const done = newTask({ state: 'done' });
    expect(() => enterStage(done, { stage: 'refinement' }, context())).toThrow(
      IllegalTransitionError,
    );
  });
});

describe('completeStage', () => {
  it('records the artifacts the stage produced', () => {
    const { aggregate, events } = completeStage(
      activeTask('refinement'),
      {
        stage: 'refinement',
        artifacts: [
          {
            id: '00000000-0000-4000-8000-0000000000e1',
            artifact_type: 'RefinedSpec',
            version: 1,
          },
        ],
        verdict: 'proceed',
      },
      context(),
    );
    expect(aggregate.state).toBe('active');
    expect(types(events)).toEqual(['task.stage.completed']);
    expect(events[0]?.payload).toMatchObject({ verdict: 'proceed' });
  });

  it('refuses to complete a stage the task is not in', () => {
    expect(() =>
      completeStage(activeTask('refinement'), { stage: 'architecture', artifacts: [] }, context()),
    ).toThrow(InvariantViolationError);
  });

  it('refuses to complete a stage while the task is not active', () => {
    expect(() =>
      completeStage(
        newTask({ state: 'waiting_answers', currentStage: 'refinement' }),
        { stage: 'refinement', artifacts: [] },
        context(),
      ),
    ).toThrow(InvariantViolationError);
  });
});

describe('returnToStage', () => {
  const returnInput = {
    fromStage: 'code_review',
    toStage: 'implementation',
    loop: 'code_review' as const,
    reason: 'two blockers',
    escalationBrief: 'review keeps finding the same blocker; a human must decide',
  };

  it('counts the iteration and moves to returned', () => {
    const { aggregate, events } = returnToStage(activeTask('code_review'), returnInput, context());
    expect(aggregate.state).toBe('returned');
    expect(aggregate.iterationCounters.code_review).toBe(1);
    expect(types(events)).toEqual(['task.stage.returned']);
    expect(events[0]?.payload).toMatchObject({
      from_stage: 'code_review',
      to_stage: 'implementation',
      iteration: 1,
    });
  });

  it('escalates instead of exceeding the limit (BD-008)', () => {
    const limits = resolveIterationLimits({ code_review_iterations: 2 });
    let task = activeTask('code_review', { limits });
    for (let round = 0; round < 2; round += 1) {
      task = returnToStage(task, returnInput, context()).aggregate;
      task = { ...task, state: 'active' };
    }
    expect(task.iterationCounters.code_review).toBe(2);

    const escalation = returnToStage(task, returnInput, context());
    expect(escalation.aggregate.state).toBe('needs_human');
    expect(escalation.aggregate.iterationCounters.code_review).toBe(2);
    expect(types(escalation.events)).toEqual(['task.escalated']);
    expect(escalation.events[0]?.payload).toMatchObject({
      blocker_brief: returnInput.escalationBrief,
    });
  });

  it('returns from ready_for_merge when a human comments (BD-007)', () => {
    const ready = newTask({ state: 'ready_for_merge', currentStage: 'ready_for_merge' });
    const { aggregate } = returnToStage(
      ready,
      { ...returnInput, fromStage: 'ready_for_merge', loop: 'human_rounds' },
      context(),
    );
    expect(aggregate.state).toBe('returned');
    expect(aggregate.iterationCounters.human_rounds).toBe(1);
  });
});

describe('waits', () => {
  it('stops the task only for a blocking question', () => {
    const blocking = askQuestion(
      activeTask('refinement'),
      { question: questionRecord(true) },
      context(),
    );
    expect(blocking.aggregate.state).toBe('waiting_answers');
    expect(types(blocking.events)).toEqual(['task.question.asked']);

    const nonBlocking = askQuestion(
      activeTask('refinement'),
      { question: questionRecord(false) },
      context(),
    );
    expect(nonBlocking.aggregate.state).toBe('active');
    expect(types(nonBlocking.events)).toEqual(['task.question.asked']);
  });

  it('waits for an approval', () => {
    const { aggregate, events } = requestApproval(
      activeTask('architecture'),
      { approval: approvalRecord },
      context(),
    );
    expect(aggregate.state).toBe('waiting_approval');
    expect(types(events)).toEqual(['task.approval.requested']);
  });
});

describe('pause, escalate, take over, hand back', () => {
  it('pauses with a reason', () => {
    const { aggregate, events } = pauseTask(activeTask(), { reason: 'budget' }, context());
    expect(aggregate.state).toBe('paused');
    expect(events[0]?.payload).toMatchObject({ reason: 'budget' });
  });

  it('escalates with a blocker brief', () => {
    const { aggregate, events } = escalateTask(
      activeTask(),
      { reason: 'ambiguous spec', blockerBrief: 'confirm the export format with the PM' },
      context(),
    );
    expect(aggregate.state).toBe('needs_human');
    expect(types(events)).toEqual(['task.escalated']);
  });

  it('pauses on take-over and re-enters a stage on hand-back', () => {
    const takenOver = takeOverTask(
      activeTask(),
      { branch: 'agentic/PROJ-1', stage: 'implementation', sessionId: 'sess-1' },
      context(),
    );
    expect(takenOver.aggregate.state).toBe('paused');
    expect(types(takenOver.events)).toEqual(['task.taken_over']);

    const handedBack = handBackTask(
      takenOver.aggregate,
      { branch: 'agentic/PROJ-1', stage: 'code_review', summary: 'fixed the migration by hand' },
      context(),
    );
    expect(handedBack.aggregate.state).toBe('active');
    expect(handedBack.aggregate.currentStage).toBe('code_review');
    expect(types(handedBack.events)).toEqual(['task.handed_back', 'task.stage.entered']);
  });
});

describe('the tail of the pipeline', () => {
  it('runs ready → merged → retro → done', () => {
    const ready = markReadyForMerge(activeTask(), context());
    expect(ready.aggregate.state).toBe('ready_for_merge');
    expect(ready.aggregate.currentStage).toBe('ready_for_merge');

    const merged = recordMerge(ready.aggregate, context());
    expect(merged.aggregate.state).toBe('merged');

    const retro = startRetrospective(merged.aggregate, context());
    expect(retro.aggregate.state).toBe('retro');

    const done = completeTask(retro.aggregate, { outcome: 'merged', totals }, context());
    expect(done.aggregate.state).toBe('done');
    expect(types(done.events)).toEqual(['task.completed']);
    expect(isTaskFinished(done.aggregate)).toBe(true);
  });

  it('refuses to skip from ready straight to done', () => {
    const ready = markReadyForMerge(activeTask(), context()).aggregate;
    expect(() => completeTask(ready, { outcome: 'merged', totals }, context())).toThrow(
      IllegalTransitionError,
    );
  });

  it('cancels from anywhere that is not finished', () => {
    const { aggregate, events } = cancelTask(
      activeTask(),
      { outcome: "won't do", totals },
      context(),
    );
    expect(aggregate.state).toBe('cancelled');
    expect(types(events)).toEqual(['task.cancelled']);
    expect(isTaskFinished(aggregate)).toBe(true);
    expect(() => cancelTask(aggregate, { outcome: 'again', totals }, context())).toThrow(
      IllegalTransitionError,
    );
  });
});

describe('shadow mode invariant', () => {
  it('never lets a shadow task act on an external system', () => {
    const shadow = newTask({ mode: 'shadow' });
    expect(() => assertMutatingActionAllowed(shadow, 'ticket.transition')).toThrow(
      InvariantViolationError,
    );
    expect(() => assertMutatingActionAllowed(newTask(), 'ticket.transition')).not.toThrow();
  });
});

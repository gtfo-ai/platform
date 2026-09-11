import { questionStatusSchema } from '@platform/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type Clock, fixedClock } from '../clock.js';
import {
  IllegalTransitionError,
  InvariantViolationError,
  PermissionDeniedError,
} from '../errors.js';
import { type CommandContext, FIRST_STREAM_SEQ } from '../events.js';
import { type IdSource, sequentialIds } from '../ids.js';
import { PROPERTY_TEST_TIMEOUT_MS } from '../testing/property.js';
import {
  answerQuestion,
  canTransitionQuestion,
  expireQuestion,
  isOverdue,
  markQuestionEscalated,
  openQuestion,
  QUESTION_TRANSITIONS,
  type Question,
  recordReminder,
  toQuestionRecord,
} from './question.js';

const QUESTION_ID = '00000000-0000-4000-8000-0000000000c1';
const TASK_ID = '00000000-0000-4000-8000-0000000000aa';
const PROJECT_ID = '00000000-0000-4000-8000-0000000000bb';
const USER_ID = '00000000-0000-4000-8000-0000000000e9';

const world = (): { ids: IdSource; clock: Clock } => ({
  ids: sequentialIds(),
  clock: fixedClock('2026-09-09T09:00:00.000Z', 1_000),
});

const context = (shared: { ids: IdSource; clock: Clock }): CommandContext => ({
  ids: shared.ids,
  actor: { kind: 'user', user_id: USER_ID },
  clock: shared.clock,
});

const open = (shared = world(), blocking = true): Question =>
  openQuestion(
    {
      id: QUESTION_ID,
      taskId: TASK_ID,
      projectId: PROJECT_ID,
      stage: 'refinement',
      runId: '00000000-0000-4000-8000-0000000000f1',
      text: 'Which locale should the export use?',
      options: ['the user locale', 'always en-GB'],
      blocking,
      deadlineAt: '2026-09-10T09:00:00.000Z',
    },
    context(shared),
  );

describe('Question transition table', () => {
  it('covers exactly the statuses the contracts define', () => {
    expect(Object.keys(QUESTION_TRANSITIONS).sort()).toEqual(
      [...questionStatusSchema.options].sort(),
    );
  });

  it('lets an expired question escalate but nothing come back from answered', () => {
    expect(canTransitionQuestion('expired', 'escalated')).toBe(true);
    expect(canTransitionQuestion('answered', 'expired')).toBe(false);
    expect(canTransitionQuestion('escalated', 'answered')).toBe(false);
  });
});

describe('openQuestion', () => {
  it('records the question without emitting: the task owns `task.question.asked`', () => {
    const question = open();
    expect(question.status).toBe('open');
    expect(question.askedAt).toBe('2026-09-09T09:00:00.000Z');
    expect(question.remindersSent).toBe(0);
    expect(question.sequence).toBe(FIRST_STREAM_SEQ);
  });

  it('maps onto the wire record the event carries', () => {
    expect(toQuestionRecord(open())).toEqual({
      id: QUESTION_ID,
      task_id: TASK_ID,
      stage: 'refinement',
      run_id: '00000000-0000-4000-8000-0000000000f1',
      text: 'Which locale should the export use?',
      options: ['the user locale', 'always en-GB'],
      blocking: true,
      status: 'open',
      asked_at: '2026-09-09T09:00:00.000Z',
      deadline_at: '2026-09-10T09:00:00.000Z',
      reminders_sent: 0,
      answer: null,
      answered_by_user_id: null,
      answered_via: null,
      answered_at: null,
    });
  });

  it('defaults the optional fields', () => {
    const minimal = openQuestion(
      {
        id: QUESTION_ID,
        taskId: TASK_ID,
        projectId: PROJECT_ID,
        stage: 'refinement',
        text: 'anything?',
        blocking: false,
      },
      context(world()),
    );
    expect(minimal.runId).toBeNull();
    expect(minimal.options).toBeNull();
    expect(minimal.deadlineAt).toBeNull();
    expect(toQuestionRecord(minimal).options).toBeNull();
  });
});

describe('answering', () => {
  it('records the answer and its channel', () => {
    const shared = world();
    const { aggregate, events } = answerQuestion(
      open(shared),
      { answer: 'the user locale', userId: USER_ID, role: 'member', channel: 'slack' },
      context(shared),
    );
    expect(aggregate.status).toBe('answered');
    expect(aggregate.answer).toBe('the user locale');
    expect(aggregate.answeredVia).toBe('slack');
    expect(aggregate.answeredAt).toBe(aggregate.answeredAt);
    expect(events.map((event) => event.type)).toEqual(['task.question.answered']);
    expect(events[0]?.stream_type).toBe('question');
    expect(events[0]?.correlation_id).toBe(TASK_ID);
  });

  it('lets the first answer win', () => {
    const shared = world();
    const answered = answerQuestion(
      open(shared),
      { answer: 'first', userId: USER_ID, role: 'member', channel: 'ui' },
      context(shared),
    ).aggregate;
    expect(() =>
      answerQuestion(
        answered,
        { answer: 'second', userId: USER_ID, role: 'admin', channel: 'ticket' },
        context(shared),
      ),
    ).toThrow(IllegalTransitionError);
  });

  it('refuses an unprivileged answer', () => {
    const shared = world();
    expect(() =>
      answerQuestion(
        open(shared),
        { answer: 'no', userId: USER_ID, role: 'viewer', channel: 'ui' },
        context(shared),
      ),
    ).toThrow(PermissionDeniedError);
  });
});

describe('reminders, expiry and escalation', () => {
  it('counts reminders while the question is open', () => {
    const reminded = recordReminder(recordReminder(open()));
    expect(reminded.remindersSent).toBe(2);
  });

  it('refuses to remind about a closed question', () => {
    const shared = world();
    const expired = expireQuestion(open(shared), context(shared)).aggregate;
    expect(() => recordReminder(expired)).toThrow(InvariantViolationError);
  });

  it('knows when it is overdue', () => {
    const question = open();
    expect(isOverdue(question, '2026-09-09T23:59:00.000Z')).toBe(false);
    expect(isOverdue(question, '2026-09-10T09:00:01.000Z')).toBe(true);
    expect(isOverdue({ ...question, deadlineAt: null }, '2030-01-01T00:00:00.000Z')).toBe(false);
    expect(isOverdue({ ...question, status: 'answered' }, '2030-01-01T00:00:00.000Z')).toBe(false);
  });

  it('expires and then escalates', () => {
    const shared = world();
    const expired = expireQuestion(open(shared), context(shared));
    expect(expired.aggregate.status).toBe('expired');
    expect(expired.events.map((event) => event.type)).toEqual(['task.question.expired']);

    const escalated = markQuestionEscalated(expired.aggregate);
    expect(escalated.status).toBe('escalated');
    expect(() => markQuestionEscalated(escalated)).toThrow(IllegalTransitionError);
  });

  it('never expires a question that was already answered', () => {
    const shared = world();
    const answered = answerQuestion(
      open(shared),
      { answer: 'yes', userId: USER_ID, role: 'maintainer', channel: 'api' },
      context(shared),
    ).aggregate;
    expect(() => expireQuestion(answered, context(shared))).toThrow(IllegalTransitionError);
  });
});

describe('Question state machine — properties', () => {
  it(
    'reaches at most one terminal status, whatever the order of events',
    () => {
      const step = fc.constantFrom('answer', 'expire', 'escalate', 'remind');
      fc.assert(
        fc.property(fc.array(step, { maxLength: 8 }), (steps) => {
          const shared = world();
          let question = open(shared);
          let events = 0;
          for (const action of steps) {
            try {
              if (action === 'answer') {
                const decision = answerQuestion(
                  question,
                  { answer: 'a', userId: USER_ID, role: 'maintainer', channel: 'ui' },
                  context(shared),
                );
                question = decision.aggregate;
                events += decision.events.length;
              } else if (action === 'expire') {
                const decision = expireQuestion(question, context(shared));
                question = decision.aggregate;
                events += decision.events.length;
              } else if (action === 'escalate') {
                question = markQuestionEscalated(question);
              } else {
                question = recordReminder(question);
              }
            } catch (error) {
              // Every rejection is typed; nothing throws a bare Error.
              expect(
                error instanceof IllegalTransitionError || error instanceof InvariantViolationError,
              ).toBe(true);
            }
          }
          expect(questionStatusSchema.options).toContain(question.status);
          // `answered` and `expired` are mutually exclusive, so at most one event was emitted.
          expect(events).toBeLessThanOrEqual(1);
          if (question.status === 'escalated') {
            expect(events).toBe(1);
          }
        }),
      );
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );
});

/**
 * The Question aggregate — technical/02: `open → answered | expired → (escalated)`.
 *
 * "Posted to ticket/Slack/UI; **first answer wins**." That rule is the state machine: only an
 * `open` question can be answered, so a second answer arriving from another channel is rejected
 * rather than overwriting the first.
 *
 * Producers follow technical/02's catalogue: `task.question.asked` is emitted by the stage
 * executor through the Task aggregate (it is what moves the task to `waiting_answers`), while
 * `task.question.answered` and `task.question.expired` are emitted here, on the question's own
 * stream, correlated to the task.
 */
import type {
  AnswerChannel,
  Id,
  IsoDateTime,
  QuestionRecord,
  QuestionStatus,
  Slug,
  UserRole,
} from '@platform/contracts';
import { isBefore } from '../clock.js';
import { IllegalTransitionError, InvariantViolationError } from '../errors.js';
import { type CommandContext, type Decision, eventRecorder, FIRST_STREAM_SEQ } from '../events.js';
import { assertCan } from '../permissions.js';

export const QUESTION_TRANSITIONS = {
  open: ['answered', 'expired'],
  answered: [],
  /** Unanswered after the timeout → reminder, then `Needs human` (product/04 S1). */
  expired: ['escalated'],
  escalated: [],
} as const satisfies Record<QuestionStatus, readonly QuestionStatus[]>;

export const canTransitionQuestion = (from: QuestionStatus, to: QuestionStatus): boolean =>
  (QUESTION_TRANSITIONS[from] as readonly QuestionStatus[]).includes(to);

export const assertQuestionTransition = (from: QuestionStatus, to: QuestionStatus): void => {
  if (!canTransitionQuestion(from, to)) {
    throw new IllegalTransitionError('Question', from, to);
  }
};

export interface Question {
  readonly id: Id;
  readonly taskId: Id;
  readonly projectId: Id;
  readonly stage: Slug;
  readonly runId: Id | null;
  /** Written by an agent; rendered, never executed. */
  readonly text: string;
  readonly options: readonly string[] | null;
  readonly blocking: boolean;
  readonly status: QuestionStatus;
  readonly askedAt: IsoDateTime;
  readonly deadlineAt: IsoDateTime | null;
  readonly remindersSent: number;
  readonly answer: string | null;
  readonly answeredByUserId: Id | null;
  readonly answeredVia: AnswerChannel | null;
  readonly answeredAt: IsoDateTime | null;
  readonly sequence: number;
}

export type QuestionDecision = Decision<Question>;

const recorderFor = (question: Question, context: CommandContext) =>
  eventRecorder({ streamType: 'question', streamId: question.id }, question.sequence, {
    ...context,
    correlationId: context.correlationId ?? question.taskId,
  });

export interface OpenQuestionInput {
  readonly id: Id;
  readonly taskId: Id;
  readonly projectId: Id;
  readonly stage: Slug;
  readonly runId?: Id;
  readonly text: string;
  readonly options?: readonly string[];
  readonly blocking: boolean;
  /**
   * When the question expires. Computed by the caller because `1 working day` (the default, Q8)
   * needs the organisation's working-day calendar, which is a scheduling concern (WP-05).
   */
  readonly deadlineAt?: IsoDateTime;
}

/**
 * Creates the question. No event: `task.question.asked` is the task's, and it carries this
 * record — see `askQuestion` in `./task.ts`.
 */
export const openQuestion = (input: OpenQuestionInput, context: CommandContext): Question => ({
  id: input.id,
  taskId: input.taskId,
  projectId: input.projectId,
  stage: input.stage,
  runId: input.runId ?? null,
  text: input.text,
  options: input.options ?? null,
  blocking: input.blocking,
  status: 'open',
  askedAt: context.clock.now(),
  deadlineAt: input.deadlineAt ?? null,
  remindersSent: 0,
  answer: null,
  answeredByUserId: null,
  answeredVia: null,
  answeredAt: null,
  sequence: FIRST_STREAM_SEQ,
});

/** The wire shape (`questionRecordSchema`) the task's `task.question.asked` carries. */
export const toQuestionRecord = (question: Question): QuestionRecord => ({
  id: question.id,
  task_id: question.taskId,
  stage: question.stage,
  run_id: question.runId,
  text: question.text,
  options: question.options === null ? null : [...question.options],
  blocking: question.blocking,
  status: question.status,
  asked_at: question.askedAt,
  deadline_at: question.deadlineAt,
  reminders_sent: question.remindersSent,
  answer: question.answer,
  answered_by_user_id: question.answeredByUserId,
  answered_via: question.answeredVia,
  answered_at: question.answeredAt,
});

/** A reminder went out. The catalogue has no reminder event; the counter is on the record. */
export const recordReminder = (question: Question): Question => {
  if (question.status !== 'open') {
    throw new InvariantViolationError(
      'question.reminder',
      `only an open question is reminded about, this one is "${question.status}"`,
    );
  }
  return { ...question, remindersSent: question.remindersSent + 1 };
};

/** Past its deadline and still open. */
export const isOverdue = (question: Question, now: IsoDateTime): boolean =>
  question.status === 'open' && question.deadlineAt !== null && isBefore(question.deadlineAt, now);

export interface AnswerQuestionInput {
  /** Untrusted human text (BD-022); only verified, mapped identities get here (Q10). */
  readonly answer: string;
  readonly userId: Id;
  readonly role: UserRole;
  readonly channel: AnswerChannel;
}

/** First answer wins: answering anything but an open question is an illegal transition. */
export const answerQuestion = (
  question: Question,
  input: AnswerQuestionInput,
  context: CommandContext,
): QuestionDecision => {
  assertQuestionTransition(question.status, 'answered');
  assertCan(input.role, 'task.answer_question', { kind: 'question', status: question.status });
  const recorder = recorderFor(question, context);
  const answeredAt = recorder.occurredAt;
  recorder.emit('task.question.answered', {
    project_id: question.projectId,
    task_id: question.taskId,
    question_id: question.id,
    answer: input.answer,
    answered_by_user_id: input.userId,
    channel: input.channel,
  });
  return {
    aggregate: {
      ...question,
      status: 'answered',
      answer: input.answer,
      answeredByUserId: input.userId,
      answeredVia: input.channel,
      answeredAt,
      sequence: recorder.sequence,
    },
    events: recorder.events,
  };
};

/** The timer fired (default 1 working day, Q8). The escalation handler reacts to this event. */
export const expireQuestion = (question: Question, context: CommandContext): QuestionDecision => {
  assertQuestionTransition(question.status, 'expired');
  const recorder = recorderFor(question, context);
  recorder.emit('task.question.expired', {
    project_id: question.projectId,
    task_id: question.taskId,
    question_id: question.id,
  });
  return {
    aggregate: { ...question, status: 'expired', sequence: recorder.sequence },
    events: recorder.events,
  };
};

/**
 * The escalation handler parked the task. No event of its own: `task.escalated` (emitted by the
 * Task aggregate) is the record, and duplicating it here would double-count escalations.
 */
export const markQuestionEscalated = (question: Question): Question => {
  assertQuestionTransition(question.status, 'escalated');
  return { ...question, status: 'escalated' };
};

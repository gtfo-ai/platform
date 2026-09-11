/**
 * The commands a human (or a timer) issues against a running task.
 *
 * technical/02: "Interfaces and handlers issue commands; aggregates validate and emit events." The
 * saga listens to `task.question.answered` and `task.approval.decided`; **these** are what produce
 * them. They exist as use cases rather than as handler code for two reasons: the API (technical/08
 * `POST /api/tasks/:id/questions/:qid/answer`), the ticket-comment adapter and the Slack action
 * handler all issue the same command from three different transports, and each one has to write the
 * aggregate and its event in the same transaction.
 *
 * Every one of them is a **mutation**, so it fails closed: an answer to a question that is not open
 * is an `IllegalTransitionError` from the aggregate, and a permission the role does not carry is a
 * `PermissionDeniedError` from `can()`. Neither is caught here.
 */
import type { AnswerChannel, Id, UserRole } from '@platform/contracts';
import type { CommandContext } from '@platform/domain';
import { answerQuestion, decideApproval, expireApproval, expireQuestion } from '@platform/domain';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import type { PipelineStore } from './store.js';

export interface TaskCommandDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly store: PipelineStore;
  readonly context: (correlationId: Id) => CommandContext;
}

export class UnknownAggregateError extends Error {
  override readonly name = 'UnknownAggregateError';
}

/**
 * "First answer wins" (technical/02): the aggregate refuses a second answer, so two channels
 * racing produce one answer and one error rather than two answers.
 */
export const answerTaskQuestion = async (
  deps: TaskCommandDependencies,
  input: {
    readonly questionId: Id;
    readonly answer: string;
    readonly userId: Id;
    readonly role: UserRole;
    readonly channel: AnswerChannel;
  },
): Promise<void> => {
  await deps.unitOfWork.transaction(async (scope) => {
    const question = await deps.store.questions.load(scope.tx, input.questionId);
    if (question === null) {
      throw new UnknownAggregateError(`question ${input.questionId} does not exist`);
    }
    const decision = answerQuestion(
      question,
      {
        answer: input.answer,
        userId: input.userId,
        role: input.role,
        channel: input.channel,
      },
      deps.context(question.taskId),
    );
    await deps.store.questions.save(scope.tx, decision.aggregate);
    await scope.events.append(decision.events);
  });
};

/** The `question.timeout` timer fired (TD-004). The saga escalates on the event this emits. */
export const expireTaskQuestion = async (
  deps: TaskCommandDependencies,
  questionId: Id,
): Promise<void> => {
  await deps.unitOfWork.transaction(async (scope) => {
    const question = await deps.store.questions.load(scope.tx, questionId);
    if (question === null || question.status !== 'open') {
      // The timer cannot be cancelled (TD-004), so it fires for questions that were answered in
      // the meantime. Finding nothing to do is the normal case, not an error.
      return;
    }
    const decision = expireQuestion(question, deps.context(question.taskId));
    await deps.store.questions.save(scope.tx, decision.aggregate);
    await scope.events.append(decision.events);
  });
};

/** BD-006: only a mapped maintainer decides, which `decideApproval` enforces through `can()`. */
export const decideTaskApproval = async (
  deps: TaskCommandDependencies,
  input: {
    readonly approvalId: Id;
    readonly decision: 'approved' | 'rejected';
    readonly userId: Id;
    readonly role: UserRole;
    readonly reason?: string;
  },
): Promise<void> => {
  await deps.unitOfWork.transaction(async (scope) => {
    const stored = await deps.store.approvals.load(scope.tx, input.approvalId);
    if (stored === null) {
      throw new UnknownAggregateError(`approval ${input.approvalId} does not exist`);
    }
    const decision = decideApproval(
      stored.approval,
      {
        decision: input.decision,
        userId: input.userId,
        role: input.role,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      },
      deps.context(stored.approval.taskId),
    );
    await deps.store.approvals.save(scope.tx, { ...stored, approval: decision.aggregate });
    await scope.events.append(decision.events);
  });
};

export const expireTaskApproval = async (
  deps: TaskCommandDependencies,
  approvalId: Id,
): Promise<void> => {
  await deps.unitOfWork.transaction(async (scope) => {
    const stored = await deps.store.approvals.load(scope.tx, approvalId);
    if (stored === null || stored.approval.status !== 'pending') {
      return;
    }
    const decision = expireApproval(stored.approval, deps.context(stored.approval.taskId));
    await deps.store.approvals.save(scope.tx, { ...stored, approval: decision.aggregate });
    await scope.events.append(decision.events);
  });
};

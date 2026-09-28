/**
 * BD-006's *"with a reminder before escalation"* — PROGRESS backlog **165**, WP-84.
 *
 * A blocking question nobody answered escalates to `needs_human` at its deadline (WP-56); BD-006
 * says a reminder comes first, and Q95 put approvals on the question's calendar, so an approval
 * gets the same reminder. Until this module `recordReminder` and the calendar's reminder
 * arithmetic had no caller, and the first a person heard of a missed question was the escalation.
 *
 * ## The ruling it is written to
 *
 * **A reminder is one more `deadline.sweep` kind** (`question_reminder`, `approval_reminder`) —
 * the architect's ruling on WP-84's row. So it has the timer's whole shape and none of its own:
 * armed after commit by the `pipeline.deadlines` handler beside the expiry timer, one pooled
 * worker, and **re-validated on fire** because a timer cannot be cancelled — an answered question,
 * a decided approval, a finished task or a reminder already sent all do nothing.
 *
 * ## When
 *
 * `reminderTimeOf`: halfway through the working time between the row's own two instants (asked or
 * requested, and `deadline_at`), on the organisation's calendar. One reminder per aggregate.
 *
 * ## What it does, in this order, and why the order
 *
 *  1. **Read** the aggregate in a transaction and decide: settled, not due, or due.
 *  2. **Enqueue the notification** — a `notify` duty of class `reminder` — outside every
 *     transaction (TD-004).
 *  3. **Count it**: `reminders_sent + 1` through the repository's narrow `recordReminder`, guarded
 *     by the status and by the count step 1 read.
 *
 * The enqueue comes **before** the count so the reminder is at-least-once rather than at-most-once:
 * a process that dies between them leaves the count at 0, the queue retries this job, and the
 * notification's own unique key (`(project, cause, class)`, with a cause derived from the aggregate
 * alone) stops the second enqueue at one row and one post. The reverse order would lose the
 * reminder to exactly the crash `recovery/stranded.ts` exists for, with nothing to find it by. The
 * narrow write rather than `save` is the lost-update argument: a reminder appends no event, so the
 * stream cannot serialise it against an answer, and a whole-row `save` over a snapshot read before
 * the answer would put the question back to `open`.
 *
 * ## What it does not do, stated
 *
 *  - `reminders_sent` counts reminders the platform **raised**. Delivering one is the notify band's:
 *    a project with no chat binding is told nothing, as for every notification, and the count still
 *    reads 1 — the task page shows the question either way.
 *  - A reminder timer whose arming was lost is not recovered: `recovery/deadline.ts` recovers the
 *    **expiry** (the loss that strands a task), and a lost reminder costs one message.
 *  - The notify duty re-checks the aggregate once more when it fires (`notify/duty.ts`), so a
 *    question answered in the minutes between is not reminded about; one answered after the post is.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import { isBefore, isTaskFinished, recordApprovalReminder, recordReminder } from '@platform/domain';
import { APPROVAL_DETAIL } from '../notify/handlers.js';
import { nameDerivedId } from '../notify/maintenance-report.js';
import type { Transaction } from '../ports/transaction.js';
import { reminderTimeOf } from '../scheduling/working-calendar.js';
import type { DeadlineOutcome } from './commands.js';
import type { DeadlineSweepOptions } from './deadlines.js';
import { enqueueOutbound } from './jobs.js';

/** Which aggregate a reminder is about. */
export type RemindedAggregate = 'question' | 'approval';

/**
 * The notification's identity: one per aggregate, whatever retries or redeliveries do.
 *
 * Name-derived, the maintenance report's precedent (`notifications.cause_event_id` has no foreign
 * key): a reminder has no event to be caused by (technical/02), and a fresh id per attempt would
 * give a retry a second row and a second post.
 */
export const reminderCauseId = (aggregate: RemindedAggregate, id: Id): Id =>
  nameDerivedId(`reminder:${aggregate}:${id}`);

type Plan =
  | { readonly kind: 'outcome'; readonly outcome: DeadlineOutcome }
  | {
      readonly kind: 'due';
      readonly projectId: Id;
      readonly taskId: Id;
      readonly sent: number;
      readonly detail: string;
    };

const SETTLED: Plan = { kind: 'outcome', outcome: { kind: 'settled' } };

/** Due, not due, or nothing owed — the same questions for both aggregates. */
const timing = (
  options: DeadlineSweepOptions,
  since: IsoDateTime,
  deadlineAt: IsoDateTime | null,
): { readonly kind: 'none' } | { readonly kind: 'not_due'; readonly dueAt: IsoDateTime } | null => {
  if (deadlineAt === null) {
    return { kind: 'none' };
  }
  const at = reminderTimeOf(options.calendar, new Date(since), new Date(deadlineAt));
  if (at === null) {
    return { kind: 'none' };
  }
  const dueAt = at.toISOString() as IsoDateTime;
  return isBefore(options.clock.now(), dueAt) ? { kind: 'not_due', dueAt } : null;
};

const taskFinished = async (
  options: DeadlineSweepOptions,
  tx: Transaction,
  taskId: Id,
): Promise<boolean> => {
  const stored = await options.store.tasks.load(tx, taskId);
  return stored === null || isTaskFinished(stored.task);
};

const planQuestion = async (
  options: DeadlineSweepOptions,
  tx: Transaction,
  id: Id,
): Promise<Plan> => {
  const question = await options.store.questions.load(tx, id);
  if (question === null || question.status !== 'open' || question.remindersSent > 0) {
    return SETTLED;
  }
  if (await taskFinished(options, tx, question.taskId)) {
    return SETTLED;
  }
  const when = timing(options, question.askedAt, question.deadlineAt);
  if (when !== null) {
    return when.kind === 'none' ? SETTLED : { kind: 'outcome', outcome: when };
  }
  // The domain's invariant, asked before anything is sent: only an open question is reminded about.
  recordReminder(question);
  return {
    kind: 'due',
    projectId: question.projectId,
    taskId: question.taskId,
    sent: question.remindersSent,
    // The model's question, bounded and redacted by the duty exactly as the first notification's.
    detail: `Still unanswered: ${question.text}`,
  };
};

const planApproval = async (
  options: DeadlineSweepOptions,
  tx: Transaction,
  id: Id,
): Promise<Plan> => {
  const stored = await options.store.approvals.load(tx, id);
  const approval = stored?.approval ?? null;
  if (approval === null || approval.status !== 'pending' || approval.remindersSent > 0) {
    return SETTLED;
  }
  if (await taskFinished(options, tx, approval.taskId)) {
    return SETTLED;
  }
  const when = timing(options, approval.requestedAt, approval.deadlineAt);
  if (when !== null) {
    return when.kind === 'none' ? SETTLED : { kind: 'outcome', outcome: when };
  }
  recordApprovalReminder(approval);
  return {
    kind: 'due',
    projectId: approval.projectId,
    taskId: approval.taskId,
    sent: approval.remindersSent,
    // Platform text keyed by the kind, as the approval's own notification carries.
    detail: `Still waiting for a decision: ${APPROVAL_DETAIL[approval.kind]} Decide on the task page.`,
  };
};

/**
 * One reminder timer, re-validated and acted on — what `settleDeadline` does for the two reminder
 * kinds. `reminded` when this call counted the reminder; `settled` when there was nothing owed or a
 * concurrent writer (an answer, a decision, another reminder) got there first.
 */
export const remindWaitingAggregate = async (
  options: DeadlineSweepOptions,
  aggregate: RemindedAggregate,
  id: Id,
): Promise<DeadlineOutcome> => {
  const plan = await options.unitOfWork.transaction(async (scope) =>
    aggregate === 'question'
      ? planQuestion(options, scope.tx, id)
      : planApproval(options, scope.tx, id),
  );
  if (plan.kind === 'outcome') {
    return plan.outcome;
  }
  await enqueueOutbound(options.jobs, {
    duty: 'notify',
    project_id: plan.projectId,
    task_id: plan.taskId,
    cause_event_id: reminderCauseId(aggregate, id),
    notification_class: 'reminder',
    notification_detail: plan.detail,
    reminder_of: id,
    reminder_aggregate: aggregate,
  });
  const counted = await options.unitOfWork.transaction(async (scope) =>
    aggregate === 'question'
      ? options.store.questions.recordReminder(scope.tx, { id, sent: plan.sent })
      : options.store.approvals.recordReminder(scope.tx, { id, sent: plan.sent }),
  );
  return counted ? { kind: 'reminded' } : { kind: 'settled' };
};

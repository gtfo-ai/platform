/**
 * BD-006's reminders — PROGRESS backlog **165** (WP-84) for a question, and BD-006's 2026-11-07
 * amendment (S-27.1, BACKLOG 1470) for an approval.
 *
 * A blocking question nobody answered escalates to `needs_human` at its deadline (WP-56), and one
 * reminder comes first. **An approval never expires** since S-27.1: it waits until a person decides
 * it, and the reminders are what keep it in front of them — at most five, after which chat is quiet
 * and the approval stays a *Needs you* item.
 *
 * ## The ruling it is written to
 *
 * **A reminder is one more `deadline.sweep` kind** (`question_reminder`, `approval_reminder`) —
 * the architect's ruling on WP-84's row. So it has the timer's whole shape and none of its own:
 * armed after commit by the `pipeline.deadlines` handler, one pooled worker, and **re-validated on
 * fire** because a timer cannot be cancelled — an answered question, a decided approval, a finished
 * task or a reminder already sent all do nothing.
 *
 * ## When
 *
 *  - **A question**: `reminderTimeOf`, halfway through the working time between the row's own two
 *    instants (`asked_at`, `deadline_at`), on the organisation's calendar. One reminder.
 *  - **An approval** ({@link approvalReminderAt}): the *n*-th at *(n − ½)* question timeouts after
 *    `requested_at`, on the same calendar, for *n* = 1…{@link APPROVAL_REMINDER_LIMIT} — so the
 *    first lands where an approval's one reminder landed before S-27.1, and with the default
 *    `1 working day` the rest follow once a working day. *n* is **not** in the job's payload
 *    (`deadlineSweepDataSchema` stays strict and gains no index): it is `reminders_sent + 1`, read
 *    when the job fires, and the timeout is the project's `question_timeout` read then too — there
 *    is no `approval_timeout` key (the Q95 amendment refused a dial cell, and that still holds).
 *
 * ## What it does, in this order, and why the order
 *
 *  1. **Read** the aggregate in a transaction and decide: settled, not due, or due.
 *  2. **Enqueue the notification** — a `notify` duty of class `reminder` — outside every
 *     transaction (TD-004).
 *  3. **Count it**: `reminders_sent + 1` through the repository's narrow `recordReminder`, guarded
 *     by the status and by the count step 1 read.
 *  4. **Arm the next one** (an approval below its limit) — only **after** step 3 has committed. The
 *     running job still holds the timer's singleton key (`deadlineKey`,
 *     `approval:<id>:approval_reminder`; the queue is `stately`, one queued beside one active), so
 *     the next arm is the one queued job; and arming it before the count committed would let it read
 *     the old count and compute the reminder that is being sent now.
 *
 * The enqueue comes **before** the count so the reminder is at-least-once rather than at-most-once:
 * a process that dies between them leaves the count where it was, the queue retries this job, and
 * the notification's own unique key (`(project, cause, class)`, with a cause derived from the
 * aggregate and the reminder's ordinal alone) stops the second enqueue at one row and one post. The
 * reverse order would lose the reminder to exactly the crash `recovery/stranded.ts` exists for, with
 * nothing to find it by. The narrow write rather than `save` is the lost-update argument: a reminder
 * appends no event, so the stream cannot serialise it against an answer, and a whole-row `save`
 * over a snapshot read before the answer would put the question back to `open`.
 *
 * ## What it does not do, stated
 *
 *  - `reminders_sent` counts reminders the platform **raised**. Delivering one is the notify band's:
 *    a project with no chat binding is told nothing, as for every notification, and the count still
 *    moves — the task page and the Inbox show the wait either way.
 *  - A reminder timer whose arming was lost **is** recovered (WP-108, PROGRESS backlog 291; S-27.1
 *    for an approval's later reminders): `recovery/deadline.ts`'s reminder row finds a question never
 *    reminded whose reminder instant passed a grace ago, and a pending approval whose **next**
 *    reminder is a grace overdue, and calls this function for it — so a late timer and the pass meet
 *    in one place, and the count and the notification's cause id decide between them. A question
 *    already past its deadline is the expiry's and is not reminded.
 *  - The notify duty re-checks the aggregate once more when it fires (`notify/duty.ts`), so a
 *    question answered, or an approval decided, in the minutes between is not reminded about; one
 *    answered after the post is.
 *  - An approval whose project configuration cannot be read is not reminded: the pace is that
 *    document's `question_timeout`, so no reminder is timed from the defaults (WP-106's ruling for the
 *    backfill); the reminder row asks again on its next pass.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import {
  APPROVAL_REMINDER_LIMIT,
  isBefore,
  isTaskFinished,
  recordApprovalReminder,
  recordReminder,
} from '@platform/domain';
import { APPROVAL_DETAIL } from '../notify/handlers.js';
import { nameDerivedId } from '../notify/maintenance-report.js';
import type { Transaction } from '../ports/transaction.js';
import {
  reminderTimeOf,
  resolveDeadline,
  type WorkingCalendar,
} from '../scheduling/working-calendar.js';
import type { DeadlineOutcome } from './commands.js';
import { questionTimeoutOf } from './deadline-rules.js';
import { enqueueDeadline } from './deadline-timer.js';
import type { DeadlineSweepOptions } from './deadlines.js';
import { enqueueOutbound } from './jobs.js';
import type { ProjectSettingsPort } from './settings.js';

/** Which aggregate a reminder is about. */
export type RemindedAggregate = 'question' | 'approval';

/**
 * The notification's identity: one per aggregate **and reminder**, whatever retries or
 * redeliveries do.
 *
 * Name-derived, the maintenance report's precedent (`notifications.cause_event_id` has no foreign
 * key): a reminder has no event to be caused by (technical/02), and a fresh id per attempt would
 * give a retry a second row and a second post. The first reminder's cause is
 * `reminder:<aggregate>:<id>`, unchanged since WP-84, so a row an earlier build recorded is still
 * the same reminder; an approval's later ones append their ordinal (`…:<n>`, S-27.1).
 */
export const reminderCauseId = (aggregate: RemindedAggregate, id: Id, ordinal = 1): Id =>
  nameDerivedId(
    ordinal === 1 ? `reminder:${aggregate}:${id}` : `reminder:${aggregate}:${id}:${ordinal}`,
  );

/**
 * When the `ordinal`-th reminder of an approval requested at `requestedAt` is due — BD-006's
 * 2026-11-07 amendment, item 2: *(n − ½)* question timeouts after the request, on the working
 * calendar.
 *
 * Built from the arithmetic the question's reminder already uses: the timeout is laid end to end
 * from the request ({@link resolveDeadline}, so *T₀* = the request and *Tₖ* = *Tₖ₋₁* + one timeout),
 * and the *n*-th reminder is {@link reminderTimeOf} between *Tₙ₋₁* and *Tₙ* — halfway through the
 * working time of the *n*-th timeout. So the first is exactly the instant an approval's one
 * reminder had before S-27.1, and a Friday-afternoon request with the default `1 working day` is
 * reminded at noon on Monday, Tuesday, Wednesday, Thursday and Friday.
 *
 * `null` for an ordinal outside 1…{@link APPROVAL_REMINDER_LIMIT}, and for a timeout that encloses
 * nothing to be halfway through.
 */
export const approvalReminderAt = (
  calendar: WorkingCalendar,
  requestedAt: IsoDateTime,
  timeout: string,
  ordinal: number,
): IsoDateTime | null => {
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > APPROVAL_REMINDER_LIMIT) {
    return null;
  }
  let from = new Date(requestedAt);
  for (let step = 1; step < ordinal; step += 1) {
    from = resolveDeadline(calendar, from, timeout);
  }
  const at = reminderTimeOf(calendar, from, resolveDeadline(calendar, from, timeout));
  return at === null ? null : (at.toISOString() as IsoDateTime);
};

/**
 * The pace of a project's approval reminders — its question timeout (`questionTimeoutOf`) — or
 * `null` when its configuration cannot be read, because that document is where the pace comes from.
 */
export const approvalReminderTimeout = async (
  settings: ProjectSettingsPort,
  projectId: Id,
  tx?: Transaction,
): Promise<string | null> => {
  const read = await settings.forProject(projectId, tx);
  return read.configRefusal === undefined ? questionTimeoutOf(read) : null;
};

type Plan =
  | { readonly kind: 'outcome'; readonly outcome: DeadlineOutcome }
  | {
      readonly kind: 'due';
      readonly projectId: Id;
      readonly taskId: Id;
      readonly sent: number;
      readonly detail: string;
      /** An approval's next reminder, armed once this one is counted; `null` after the last. */
      readonly next: IsoDateTime | null;
    };

const SETTLED: Plan = { kind: 'outcome', outcome: { kind: 'settled' } };

/** Due, not due, or nothing owed — a question's one reminder. */
const questionTiming = (
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
  const when = questionTiming(options, question.askedAt, question.deadlineAt);
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
    next: null,
  };
};

const planApproval = async (
  options: DeadlineSweepOptions,
  tx: Transaction,
  id: Id,
): Promise<Plan> => {
  const stored = await options.store.approvals.load(tx, id);
  const approval = stored?.approval ?? null;
  if (
    approval === null ||
    approval.status !== 'pending' ||
    approval.remindersSent >= APPROVAL_REMINDER_LIMIT
  ) {
    // Decided, or its reminders spent: no timer is left, and its ending is a decision or the
    // task's end (BD-006's 2026-11-07 amendment, item 5).
    return SETTLED;
  }
  if (await taskFinished(options, tx, approval.taskId)) {
    return SETTLED;
  }
  const timeout = await approvalReminderTimeout(options.settings, approval.projectId, tx);
  if (timeout === null) {
    options.logger?.warn(
      { approval_id: id, task_id: approval.taskId },
      'an approval was not reminded about: its project configuration could not be read, and the reminders keep its question_timeout',
    );
    return SETTLED;
  }
  const ordinal = approval.remindersSent + 1;
  const dueAt = approvalReminderAt(options.calendar, approval.requestedAt, timeout, ordinal);
  if (dueAt === null) {
    return SETTLED;
  }
  if (isBefore(options.clock.now(), dueAt)) {
    return { kind: 'outcome', outcome: { kind: 'not_due', dueAt } };
  }
  recordApprovalReminder(approval);
  return {
    kind: 'due',
    projectId: approval.projectId,
    taskId: approval.taskId,
    sent: approval.remindersSent,
    // Platform text keyed by the kind, as the approval's own notification carries.
    detail: `Still waiting for a decision: ${APPROVAL_DETAIL[approval.kind]} Decide on the task page.`,
    next: approvalReminderAt(options.calendar, approval.requestedAt, timeout, ordinal + 1),
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
    cause_event_id: reminderCauseId(aggregate, id, plan.sent + 1),
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
  if (!counted) {
    return { kind: 'settled' };
  }
  // Step 4, after the count committed: the next reminder of an approval below its limit.
  if (aggregate === 'approval' && plan.next !== null) {
    await enqueueDeadline(
      options.jobs,
      { aggregate: 'approval', id, kind: 'approval_reminder' },
      plan.next,
    );
  }
  return { kind: 'reminded' };
};

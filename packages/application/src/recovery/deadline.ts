/**
 * The deadline row of the lost-wake-up table (WP-56 round 2, PROGRESS backlog **161** and **162**;
 * S-27.1 for approvals).
 *
 * `pipeline.deadlines` arms every timer from `HandlerContext.afterCommit`, which is at-most-once
 * (TD-004): a process that dies after the dispatch commits, or an enqueue that throws (the bus logs
 * it and moves on), leaves an open question or a paused take-over with **no timer** — waiting for
 * ever, which is BD-006 unmet exactly as it was before WP-56. And every question written **before**
 * WP-56 has `deadline_at is null`, so nothing would ever arm one for it. This site answers both, on
 * `recovery/stranded.ts`'s pass and interval.
 *
 * **An approval has no deadline** since S-27.1 (BD-006's 2026-11-07 amendment): it waits until a
 * person decides it, so the approval halves of the overdue sweep and of the backfill are deleted —
 * a stored `deadline_at` an earlier build wrote is history, and nothing here reads it. What is left
 * of an approval here is its **reminders**.
 *
 * | what it finds | what it does | why that and not something else |
 * |---|---|---|
 * | an open question whose `deadline_at` passed more than a grace ago | {@link settleDeadline} — the job's own path, re-validating | a timer that was armed has fired inside the grace and moved the row off `open`, so the query cannot find it; the one it finds is the one whose timer was lost |
 * | a paused task still taken over whose five working days of inactivity passed more than a grace ago | the same | a take-over has no stored deadline; it is recomputed from the holder's last activity (the take-over, or a later `human_actions` row of theirs — WP-44) on the calendar, as the job does |
 * | an open question with **no** deadline | writes one **counted from now**, then arms it | below |
 * | an open question **never reminded** whose reminder time passed more than a grace ago and whose deadline has **not** passed (WP-108, backlog **291**) | {@link remindWaitingAggregate} — the reminder timer's own path, re-validating | below |
 * | a pending approval with reminders left whose **next** reminder ({@link approvalReminderAt}, ordinal `reminders_sent + 1`) is more than a grace overdue (S-27.1) | the same | below |
 *
 * **Counted from the backfill, not from `asked_at`** (the refiner's recommendation, taken). A
 * deadline computed from when a question was asked would expire every question an instance had
 * open on the day it upgraded, in the first pass, and escalate every one of those tasks at once
 * with a brief saying nobody answered in time — when nobody had been told there was a time. Counted
 * from now, each gets the full `question_timeout` it would have had if it were asked today. The
 * write is conditional on the column still being null and the row still waiting, so it is done
 * once. A **take-over** is the exception, and it is stated rather than hidden: it has no column to
 * hold a backfilled deadline (adding one is a migration for a one-off), so a take-over older than
 * five working days on the day of the upgrade escalates on the first pass. That escalation takes
 * nothing from the person holding it — the task moves to `needs_human`, the workpad keeps the
 * branch — which is why this narrowing was chosen over migration 0041.
 *
 * **The reminder rows (WP-108, PROGRESS backlog 291; S-27.1).** A reminder timer is armed by the same
 * `afterCommit` as the expiry, so it is lost by the same crash — and the expiry rows above recover
 * only the expiry, so until WP-108 a lost arm cost BD-006's *"one reminder before escalation"* for
 * good. For a **question** the row finds, by one predicate: `reminders_sent = 0`, still waiting, a
 * deadline **after now**, and {@link reminderTimeOf} — halfway through the working time between the
 * row's own `asked_at` and its deadline, the live timer's instant — more than a grace ago. A row past
 * its deadline is **not** reminded: it is the expiry's, and a *"still unanswered"* line after the
 * escalation would contradict it. **The backfill ruling:** for an old row given a deadline counted
 * from now, that instant is usually already in the past, and the row is reminded on the **next**
 * pass rather than at a reminder time re-counted from the backfill. For an **approval** it finds a
 * pending one with `reminders_sent` below the limit whose next reminder — computed from
 * `requested_at` and the project's `question_timeout` as the timer computes it — is more than a
 * grace ago: a lost first arm, a later arm lost between a count and its enqueue, and an approval an
 * earlier build armed only one reminder for (its first went out; this pass gives it the rest, one a
 * pass, each re-arming the next). **The arbiter with a live timer** (standing rule 9): both go
 * through `remindWaitingAggregate`, whose count is a narrow `reminders_sent + 1` guarded by the count
 * it read, and whose notification's cause id is derived from the aggregate and the ordinal alone — so
 * a late timer and this pass racing each other post one message and count one reminder. **The
 * limit's residual:** the reads are ordered (questions by deadline, approvals by `requested_at`),
 * and rows whose reminder time has not come are read and skipped, so more than `limit` such rows of
 * one kind ahead of a due one hold it back until they leave the read — when they are reminded, or
 * at the latest at their own deadlines (a question) or their last reminder (an approval). That wait
 * has no bound of its own: a steady stream of rows ahead, or one whose reminder throws every pass,
 * can hold a due row back. For a question its one reminder is then lost (the expiry still comes);
 * for an approval it is late, and the approval stays a *Needs you* item either way. Stated rather
 * than paged (PROGRESS backlog 367).
 *
 * **What bounds it.** No attempt mark, and none is needed for the reason the `run_lease` and
 * `task_ask_run` rows need none: the action moves the row out of the query (an expired question is
 * not `open`, a backfilled one is not `null`, a reminded one has a higher `reminders_sent`, and an
 * approval at the limit is not read). A row whose action **throws** is found again on the next pass;
 * that is logged as an error per pass rather than silently retried, and it is one read and one
 * failed write a minute, not a paid run. Rows on a **finished** task are excluded by the query, so a
 * question a cancelled task left open is not found for ever.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import { APPROVAL_REMINDER_LIMIT } from '@platform/domain';
import { questionDeadlineRule, takeOverDeadline } from '../pipeline/deadline-rules.js';
import {
  type DeadlineSweepData,
  type DeadlineSweepOptions,
  enqueueDeadline,
  settleDeadline,
} from '../pipeline/deadlines.js';
import {
  approvalReminderAt,
  approvalReminderTimeout,
  remindWaitingAggregate,
} from '../pipeline/reminders.js';
import type { ProjectSettingsPort } from '../pipeline/settings.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { Transaction } from '../ports/transaction.js';
import { reminderTimeOf } from '../scheduling/working-calendar.js';

/** An open question (or, for a reminder, a pending approval), as the recovery reads it. */
export interface WaitingAggregate {
  readonly aggregate: 'question' | 'approval';
  readonly id: Id;
  readonly projectId: Id;
  readonly taskId: Id;
}

/** An open question, as the expiry and backfill reads answer it (no approval expires, S-27.1). */
export interface WaitingQuestion extends WaitingAggregate {
  readonly aggregate: 'question';
}

/**
 * An open question never reminded about (WP-108, backlog 291), with the two instants its reminder
 * is timed from — the same two the live timer reads.
 */
export interface UnremindedAggregate extends WaitingAggregate {
  readonly aggregate: 'question';
  /** `asked_at`. */
  readonly since: IsoDateTime;
  readonly deadlineAt: IsoDateTime;
}

/**
 * A pending approval with reminders left (S-27.1): the instant its reminders count from and how
 * many went out, which is what the next one's ordinal is.
 */
export interface RemindableApproval extends WaitingAggregate {
  readonly aggregate: 'approval';
  readonly requestedAt: IsoDateTime;
  readonly remindersSent: number;
}

/** A paused task whose newest take-over boundary is `task.taken_over`. */
export interface HeldTask {
  readonly taskId: Id;
  /** The `task.taken_over` instant. */
  readonly takenAt: IsoDateTime;
  /**
   * The holder's last activity — `TakeOverRecord.lastActivityAt`'s rule, computed by the same
   * expression — and the instant the inactivity timeout counts from (WP-44, PROGRESS backlog 167).
   */
  readonly lastActivityAt: IsoDateTime;
}

export interface DeadlineRecoveryStore {
  /**
   * Open questions of an **unfinished** task whose `deadline_at` is before `dueBefore`, oldest
   * deadline first, at most `limit`. No approval: none expires (S-27.1).
   */
  overdue(
    tx: Transaction,
    query: { readonly dueBefore: IsoDateTime; readonly limit: number },
  ): Promise<readonly WaitingQuestion[]>;
  /** Paused tasks still taken over (`TAKE_OVER_BOUNDARY_EVENTS`' rule), at most `limit`. */
  heldTasks(tx: Transaction, query: { readonly limit: number }): Promise<readonly HeldTask[]>;
  /** Open questions of an unfinished task with no deadline at all. No approval (S-27.1). */
  undated(tx: Transaction, query: { readonly limit: number }): Promise<readonly WaitingQuestion[]>;
  /**
   * Open questions of an unfinished task with `reminders_sent = 0`, a deadline **after**
   * `deadlineAfter` and an `asked_at` before `sinceBefore` (a reminder lies strictly after it),
   * nearest deadline first, at most `limit`. Whether the reminder time itself has passed is the
   * caller's question: it is the working calendar's arithmetic, which SQL does not have.
   */
  unreminded(
    tx: Transaction,
    query: {
      readonly deadlineAfter: IsoDateTime;
      readonly sinceBefore: IsoDateTime;
      readonly limit: number;
    },
  ): Promise<readonly UnremindedAggregate[]>;
  /**
   * Pending approvals of an unfinished task with `reminders_sent` below `limitSent` and a
   * `requested_at` before `requestedBefore` (every reminder lies strictly after it), oldest request
   * first, at most `limit` (S-27.1). Whether the next reminder is due is the caller's question, for
   * the reason {@link unreminded} gives.
   */
  remindableApprovals(
    tx: Transaction,
    query: {
      readonly requestedBefore: IsoDateTime;
      readonly limitSent: number;
      readonly limit: number;
    },
  ): Promise<readonly RemindableApproval[]>;
  /**
   * The backfill's one write: `deadline_at` on a question that has none and is still open. `false`
   * when the row moved or was given one meanwhile — which is what makes the backfill happen once.
   */
  backfillDeadline(
    tx: Transaction,
    input: WaitingQuestion & { readonly deadlineAt: IsoDateTime },
  ): Promise<boolean>;
}

/** The site's collaborators, as `./stranded.ts` takes them. */
export interface DeadlineRecoverySite {
  readonly store: DeadlineRecoveryStore;
  /** The `deadline.sweep` job's own options, so the recovery acts through the job's paths. */
  readonly sweep: Omit<DeadlineSweepOptions, 'clock' | 'logger'>;
  /** Where the backfill and the approval reminders read a project's `question_timeout` from. */
  readonly settings: ProjectSettingsPort;
}

export interface DeadlineRecoveryReport {
  readonly found: number;
  /** Deadlines whose timer was lost, and which the pass expired. */
  readonly expired: number;
  /** Questions given their first deadline and armed. */
  readonly backfilled: number;
  /**
   * Questions never reminded whose reminder time passed a grace ago and whose deadline has not,
   * and approvals whose next reminder is a grace overdue.
   */
  readonly reminderFound: number;
  /** Of those, the reminders this pass raised (WP-108, backlog 291; S-27.1). */
  readonly reminded: number;
}

const questionTimeoutData = (row: WaitingQuestion): DeadlineSweepData => ({
  aggregate: 'question',
  id: row.id,
  kind: 'question_timeout',
});

export const recoverDeadlines = async (
  site: DeadlineRecoverySite,
  input: {
    readonly now: IsoDateTime;
    readonly graceMs: number;
    readonly limit: number;
    readonly clock: { now(): IsoDateTime };
    readonly logger?: Logger;
  },
): Promise<DeadlineRecoveryReport> => {
  const logger = input.logger ?? silentLogger;
  const dueBefore = new Date(
    Date.parse(input.now) - Math.max(0, input.graceMs),
  ).toISOString() as IsoDateTime;
  const found = await site.sweep.unitOfWork.transaction(async (scope) => ({
    overdue: await site.store.overdue(scope.tx, { dueBefore, limit: input.limit }),
    held: await site.store.heldTasks(scope.tx, { limit: input.limit }),
    undated: await site.store.undated(scope.tx, { limit: input.limit }),
    unreminded: await site.store.unreminded(scope.tx, {
      deadlineAfter: input.now,
      sinceBefore: dueBefore,
      limit: input.limit,
    }),
    approvals: await site.store.remindableApprovals(scope.tx, {
      requestedBefore: dueBefore,
      limitSent: APPROVAL_REMINDER_LIMIT,
      limit: input.limit,
    }),
  }));
  const sweep: DeadlineSweepOptions = {
    ...site.sweep,
    clock: input.clock,
    ...(input.logger === undefined ? {} : { logger: input.logger }),
  };

  const lost: DeadlineSweepData[] = [
    ...found.overdue.map(questionTimeoutData),
    ...found.held
      // From the holder's last activity, never from the take-over alone: a person who issued a
      // command on Wednesday is not five working days quiet on the Friday after taking it (WP-44).
      .filter((held) => takeOverDeadline(site.sweep.calendar, held.lastActivityAt) < dueBefore)
      .map(
        (held): DeadlineSweepData => ({
          aggregate: 'task',
          id: held.taskId,
          kind: 'take_over_inactivity',
        }),
      ),
  ];
  let expired = 0;
  for (const data of lost) {
    try {
      const outcome = await settleDeadline(sweep, data);
      if (outcome.kind === 'expired') {
        expired += 1;
        logger.warn(
          { ...data },
          'a deadline passed with no timer to act on it — its arming was lost — so the recovery pass expired it (PROGRESS backlog 161)',
        );
      }
    } catch (error) {
      logger.error(
        { ...data, err: error },
        'a deadline whose timer was lost could not be expired; the next pass tries again (PROGRESS backlog 161)',
      );
    }
  }

  let backfilled = 0;
  // Caught per row, as the expiry loop above is (WP-56 review round 2): an error escaping here would
  // abort `runStrandedRecovery` before its later sites — the run-lease sweep among them — and, the
  // query being ordered, the same poison row would block them on every pass.
  for (const row of found.undated) {
    try {
      const settings = await site.settings.forProject(row.projectId);
      if (settings.configRefusal !== undefined) {
        // WP-106 review round 1: the timeout is the unreadable document's
        // (`pipeline.limits.question_timeout`), so no deadline is written from the defaults. The
        // row stays undated and the next pass asks again.
        logger.warn(
          { ...questionTimeoutData(row), task_id: row.taskId },
          'a question with no deadline was not given one: the project configuration could not be read',
        );
        continue;
      }
      const deadlineAt = questionDeadlineRule(site.sweep.calendar, settings)(input.now);
      if (deadlineAt === null) {
        continue;
      }
      const written = await site.sweep.unitOfWork.transaction(async (scope) =>
        site.store.backfillDeadline(scope.tx, { ...row, deadlineAt }),
      );
      if (!written) {
        continue;
      }
      // After the write commits, as every enqueue is (TD-004); a crash between the two leaves a row
      // with a deadline and no timer, which is the overdue half of this very site.
      await enqueueDeadline(site.sweep.jobs, questionTimeoutData(row), deadlineAt);
      backfilled += 1;
      logger.warn(
        { ...questionTimeoutData(row), task_id: row.taskId, deadline_at: deadlineAt },
        'a question written before deadlines existed was given its first one, counted from now rather than from when it was asked (PROGRESS backlog 162)',
      );
    } catch (error) {
      logger.error(
        { ...questionTimeoutData(row), task_id: row.taskId, err: error },
        'a question with no deadline could not be given one; the next pass tries again (PROGRESS backlog 162)',
      );
    }
  }

  const dueQuestions = found.unreminded.filter((row) =>
    questionReminderOverdue(site, row, dueBefore, input.now),
  );
  const dueApprovals: RemindableApproval[] = [];
  for (const row of found.approvals) {
    try {
      if (await approvalReminderOverdue(site, row, dueBefore)) {
        dueApprovals.push(row);
      }
    } catch (error) {
      logger.error(
        { ...reminderDataOf(row), task_id: row.taskId, err: error },
        'a pending approval’s next reminder could not be timed; the next pass tries again',
      );
    }
  }
  let reminded = 0;
  // Caught per row, as both loops above are, and for their reason.
  for (const row of [...dueQuestions, ...dueApprovals]) {
    try {
      const outcome = await remindWaitingAggregate(sweep, row.aggregate, row.id);
      if (outcome.kind === 'reminded') {
        reminded += 1;
        logger.warn(
          { ...reminderDataOf(row), task_id: row.taskId },
          'a question or approval was not reminded about although its reminder time had passed — its reminder timer was lost, it was given a deadline by the backfill, or it predates its reminders — so the recovery pass reminded it once (PROGRESS backlog 291, S-27.1)',
        );
      }
    } catch (error) {
      logger.error(
        { ...reminderDataOf(row), task_id: row.taskId, err: error },
        'a question or approval whose reminder was lost could not be reminded; the next pass tries again (PROGRESS backlog 291)',
      );
    }
  }

  return {
    found: lost.length + found.undated.length,
    expired,
    backfilled,
    reminderFound: dueQuestions.length + dueApprovals.length,
    reminded,
  };
};

const reminderDataOf = (row: WaitingAggregate): DeadlineSweepData =>
  row.aggregate === 'question'
    ? { aggregate: 'question', id: row.id, kind: 'question_reminder' }
    : { aggregate: 'approval', id: row.id, kind: 'approval_reminder' };

/**
 * The question reminder row's predicate, the half SQL cannot ask: the reminder instant the live
 * timer would have fired at ({@link reminderTimeOf}, from the row's own two instants) is more than
 * the grace ago, and the deadline is still ahead. Asked again here rather than trusted to the
 * store, so a store that answered a row past its deadline still cannot make the pass remind it.
 */
const questionReminderOverdue = (
  site: DeadlineRecoverySite,
  row: UnremindedAggregate,
  dueBefore: IsoDateTime,
  now: IsoDateTime,
): boolean => {
  if (Date.parse(row.deadlineAt) <= Date.parse(now)) {
    return false;
  }
  const at = reminderTimeOf(site.sweep.calendar, new Date(row.since), new Date(row.deadlineAt));
  return at !== null && at.getTime() < Date.parse(dueBefore);
};

/**
 * The approval reminder row's predicate (S-27.1): its **next** reminder — ordinal
 * `reminders_sent + 1`, at {@link approvalReminderAt} over the project's `question_timeout` — is
 * more than the grace ago. An unreadable project configuration times nothing (the pace is that
 * document's), so the row is skipped and asked again on the next pass.
 */
const approvalReminderOverdue = async (
  site: DeadlineRecoverySite,
  row: RemindableApproval,
  dueBefore: IsoDateTime,
): Promise<boolean> => {
  const timeout = await approvalReminderTimeout(site.settings, row.projectId);
  if (timeout === null) {
    return false;
  }
  const at = approvalReminderAt(
    site.sweep.calendar,
    row.requestedAt,
    timeout,
    row.remindersSent + 1,
  );
  return at !== null && Date.parse(at) < Date.parse(dueBefore);
};

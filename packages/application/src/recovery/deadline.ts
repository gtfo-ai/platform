/**
 * The deadline row of the lost-wake-up table (WP-56 round 2, PROGRESS backlog **161** and **162**).
 *
 * `pipeline.deadlines` arms every timer from `HandlerContext.afterCommit`, which is at-most-once
 * (TD-004): a process that dies after the dispatch commits, or an enqueue that throws (the bus logs
 * it and moves on), leaves an open question, a pending approval or a paused take-over with **no
 * timer** — waiting for ever, which is BD-006 unmet exactly as it was before WP-56. And every row
 * written **before** WP-56 has `deadline_at is null`, so nothing would ever arm one for it. This
 * site answers both, on `recovery/stranded.ts`'s pass and interval.
 *
 * | what it finds | what it does | why that and not something else |
 * |---|---|---|
 * | an open question / pending approval whose `deadline_at` passed more than a grace ago | {@link settleDeadline} — the job's own path, re-validating | a timer that was armed has fired inside the grace and moved the row off `open`/`pending`, so the query cannot find it; the one it finds is the one whose timer was lost |
 * | a paused task still taken over whose five working days passed more than a grace ago | the same | a take-over has no stored deadline; it is recomputed from the `task.taken_over` event on the calendar, as the job does |
 * | an open question / pending approval with **no** deadline | writes one **counted from now**, then arms it | below |
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
 * **What bounds it.** No attempt mark, and none is needed for the reason the `run_lease` and
 * `task_ask_run` rows need none: the action moves the row out of the query (an expired question is
 * not `open`, a backfilled one is not `null`). A row whose expiry **throws** is found again on the
 * next pass; that is logged as an error per pass rather than silently retried, and it is one read
 * and one failed write a minute, not a paid run. Rows on a **finished** task are excluded by the
 * query, so a question a cancelled task left open is not found for ever.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import { questionDeadlineRule, takeOverDeadline } from '../pipeline/deadline-rules.js';
import {
  type DeadlineSweepData,
  type DeadlineSweepOptions,
  enqueueDeadline,
  settleDeadline,
} from '../pipeline/deadlines.js';
import type { ProjectSettingsPort } from '../pipeline/settings.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { Transaction } from '../ports/transaction.js';

/** An open question or pending approval, as the recovery reads it. */
export interface WaitingAggregate {
  readonly aggregate: 'question' | 'approval';
  readonly id: Id;
  readonly projectId: Id;
  readonly taskId: Id;
}

/** A paused task whose newest take-over boundary is `task.taken_over`. */
export interface HeldTask {
  readonly taskId: Id;
  /** The `task.taken_over` instant the inactivity timeout counts from. */
  readonly takenAt: IsoDateTime;
}

export interface DeadlineRecoveryStore {
  /**
   * Open questions and pending approvals of an **unfinished** task whose `deadline_at` is before
   * `dueBefore`, oldest deadline first, at most `limit` of each.
   */
  overdue(
    tx: Transaction,
    query: { readonly dueBefore: IsoDateTime; readonly limit: number },
  ): Promise<readonly WaitingAggregate[]>;
  /** Paused tasks still taken over (`TAKE_OVER_BOUNDARY_EVENTS`' rule), at most `limit`. */
  heldTasks(tx: Transaction, query: { readonly limit: number }): Promise<readonly HeldTask[]>;
  /** Open questions and pending approvals of an unfinished task with no deadline at all. */
  undated(tx: Transaction, query: { readonly limit: number }): Promise<readonly WaitingAggregate[]>;
  /**
   * The backfill's one write: `deadline_at` on a row that has none and is still waiting. `false`
   * when the row moved or was given one meanwhile — which is what makes the backfill happen once.
   */
  backfillDeadline(
    tx: Transaction,
    input: WaitingAggregate & { readonly deadlineAt: IsoDateTime },
  ): Promise<boolean>;
}

/** The site's collaborators, as `./stranded.ts` takes them. */
export interface DeadlineRecoverySite {
  readonly store: DeadlineRecoveryStore;
  /** The `deadline.sweep` job's own options, so the recovery expires through the job's path. */
  readonly sweep: Omit<DeadlineSweepOptions, 'clock' | 'logger'>;
  /** Where the backfill reads a project's `question_timeout` from. */
  readonly settings: ProjectSettingsPort;
}

export interface DeadlineRecoveryReport {
  readonly found: number;
  /** Deadlines whose timer was lost, and which the pass expired. */
  readonly expired: number;
  /** Rows given their first deadline and armed. */
  readonly backfilled: number;
}

const dataOf = (row: WaitingAggregate): DeadlineSweepData =>
  row.aggregate === 'question'
    ? { aggregate: 'question', id: row.id, kind: 'question_timeout' }
    : { aggregate: 'approval', id: row.id, kind: 'approval_timeout' };

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
  }));
  const sweep: DeadlineSweepOptions = {
    ...site.sweep,
    clock: input.clock,
    ...(input.logger === undefined ? {} : { logger: input.logger }),
  };

  const lost: DeadlineSweepData[] = [
    ...found.overdue.map(dataOf),
    ...found.held
      .filter((held) => takeOverDeadline(site.sweep.calendar, held.takenAt) < dueBefore)
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
      const deadlineAt = questionDeadlineRule(site.sweep.calendar, settings.config)(input.now);
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
      await enqueueDeadline(site.sweep.jobs, dataOf(row), deadlineAt);
      backfilled += 1;
      logger.warn(
        { ...dataOf(row), task_id: row.taskId, deadline_at: deadlineAt },
        'a question or approval written before deadlines existed was given its first one, counted from now rather than from when it was asked (PROGRESS backlog 162)',
      );
    } catch (error) {
      logger.error(
        { ...dataOf(row), task_id: row.taskId, err: error },
        'a question or approval with no deadline could not be given one; the next pass tries again (PROGRESS backlog 162)',
      );
    }
  }

  return {
    found: lost.length + found.undated.length,
    expired,
    backfilled,
  };
};

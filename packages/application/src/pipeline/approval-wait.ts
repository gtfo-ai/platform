/**
 * **The approval wait a pause interrupted** — S-27.1, the coordinator's ruling on BACKLOG 1480
 * (BD-006's 2026-11-07 amendment: an approval waits until a person decides it).
 *
 * A task waiting for an approval may be paused (by a person, a take-over or a budget cap). Before
 * this ruling a resume of it re-entered the stage past the approval, and the approval kept being
 * reminded about while the task was paused. Now:
 *
 * 1. **A resume goes back to the wait.** `resumeTaskCommand` asks {@link interruptedApproval}; when
 *    the pause interrupted an approval, the task returns to `waiting_approval`
 *    (`resumeIntoApprovalWait`) and never enters the stage. Only the approval's own decision moves
 *    it on: one still pending waits, and one decided while the task was paused — the saga ignored
 *    that decision then, because the task was not waiting — is applied by the saga on the
 *    `task.resumed` the resume appends (`pipeline.approval.resumed`, `saga.ts`).
 * 2. **No reminder while paused.** An approval is reminded about only while its task is
 *    `waiting_approval`; the timer that fires during a pause settles, and the resume arms the next
 *    one. The schedule resumes rather than catches up: every reminder is shifted by the working time
 *    the task spent paused since the request ({@link shiftedByPauses}), and the count is
 *    `reminders_sent`, so the cap of five holds.
 * 3. A retry-stage or retry-run of such a paused task is refused like one of a `waiting_approval`
 *    task (`assertNoPendingApproval`, asked by `humanEnter`).
 *
 * **Which approval a pause interrupted** is read off two facts the platform already stores: the
 * task's newest `task.paused` (`TaskRepository.pauses`) and its newest approval of each kind. The
 * one requested at or before that pause and still pending — or decided **after** it — is the wait.
 * A decision before the pause was applied before it (the task was not waiting when it was paused),
 * so it is not the wait; an approval requested after it cannot exist (a paused task asks nothing).
 */
import { approvalKindSchema, type Id, type IsoDateTime } from '@platform/contracts';
import type { Transaction } from '../ports/transaction.js';
import {
  advanceWorkingTime,
  type WorkingCalendar,
  workingMinutesBetween,
} from '../scheduling/working-calendar.js';
import type { PipelineStore, StoredApproval, TaskPause } from './store.js';

/** The approval the task's newest pause interrupted, pending or decided since — or `null`. */
export const interruptedApproval = async (
  store: Pick<PipelineStore, 'tasks' | 'approvals'>,
  tx: Transaction,
  taskId: Id,
): Promise<StoredApproval | null> => {
  const pause = (await store.tasks.pauses(tx, taskId)).at(-1);
  if (pause === undefined) {
    return null;
  }
  const pausedAt = Date.parse(pause.pausedAt);
  let found: StoredApproval | null = null;
  for (const kind of approvalKindSchema.options) {
    const latest = await store.approvals.latestOfKind(tx, { taskId, kind });
    if (latest === null || Date.parse(latest.approval.requestedAt) > pausedAt) {
      continue;
    }
    const decidedAt = latest.approval.decidedAt;
    const waiting =
      latest.approval.status === 'pending' ||
      (decidedAt !== null && Date.parse(decidedAt) > pausedAt);
    if (
      waiting &&
      (found === null ||
        Date.parse(latest.approval.requestedAt) > Date.parse(found.approval.requestedAt))
    ) {
      found = latest;
    }
  }
  return found;
};

/**
 * `at` moved later by the working time the task spent paused since `since` (its approval's
 * request): the pauses that began at or after `since` and have ended. An open pause adds nothing —
 * a paused task is not reminded at all, and its resume closes the pause before the next reminder
 * is timed.
 */
export const shiftedByPauses = (
  calendar: WorkingCalendar,
  at: IsoDateTime,
  pauses: readonly TaskPause[],
  since: IsoDateTime,
): IsoDateTime => {
  const sinceMs = Date.parse(since);
  const minutes = pauses
    .filter((pause) => pause.endedAt !== null && Date.parse(pause.pausedAt) >= sinceMs)
    .reduce(
      (sum, pause) =>
        sum +
        workingMinutesBetween(
          calendar,
          new Date(pause.pausedAt),
          new Date(pause.endedAt as string),
        ),
      0,
    );
  return minutes === 0
    ? at
    : (advanceWorkingTime(calendar, new Date(at), minutes).toISOString() as IsoDateTime);
};

/** The task's approval still **pending**, of whichever kind, or `null` — the newest of each kind. */
export const pendingApproval = async (
  store: Pick<PipelineStore, 'approvals'>,
  tx: Transaction,
  taskId: Id,
): Promise<StoredApproval | null> => {
  for (const kind of approvalKindSchema.options) {
    const latest = await store.approvals.latestOfKind(tx, { taskId, kind });
    if (latest?.approval.status === 'pending') {
      return latest;
    }
  }
  return null;
};

/**
 * The approval a resume of a stopped (`paused` or `needs_human`) task goes back to waiting for:
 * the one its newest pause interrupted, pending or decided since ({@link interruptedApproval}), or
 * else any approval still pending — a task escalated with one (a take-over that timed out, a
 * conflict) keeps it, and only its decision may move the task on (the review of #113).
 */
export const approvalToResumeInto = async (
  store: Pick<PipelineStore, 'tasks' | 'approvals'>,
  tx: Transaction,
  taskId: Id,
): Promise<StoredApproval | null> =>
  (await interruptedApproval(store, tx, taskId)) ?? (await pendingApproval(store, tx, taskId));

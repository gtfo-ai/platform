/**
 * **The merge check at Ready, for tasks nothing else wakes** (S-28.13, M28 ruling R3b (2)–(3)) — a
 * row of the recovery pass (`./stranded.ts`).
 *
 * The `ready_merge_check` duty (`pipeline/ready-merge-check.ts`) is woken when a task's merge
 * request is marked ready and on a resolution signal. Two kinds of task get neither:
 *
 *  - a task that was **already waiting at Ready when S-28.13 shipped** — AUT-6655, with five of
 *    the platform's own threads blocking its merge. It has no `task_merge_checks` row, so this row
 *    finds it once, and the duty closes the platform's threads and reads the provider;
 *  - a task whose last check read **"not mergeable now"** (or "not decided yet"): the provider's
 *    answer can change with no signal the platform hears — a pipeline passes, a person approves —
 *    so it is checked again {@link READY_MERGE_RECHECK_MS} after its last claim, until a check reads
 *    "mergeable" or the task leaves Ready.
 *
 * Each task is **claimed** before its duty is enqueued (`claimReadyMergeCheck`: an insert, or a
 * conditional update of a stale claim), so two passes enqueue one check. **The bound**:
 * {@link READY_MERGE_CHECK_PER_PASS} tasks a pass, never more than the pass's own `limit` — one
 * merge-request read each, and a discussions read when threads are the reason.
 */
import type { IsoDateTime } from '@platform/contracts';
import { enqueueOutbound } from '../pipeline/jobs.js';
import type { TaskRepository } from '../pipeline/store.js';
import type { Jobs } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';

/** The site name the pass reports under (`./stranded.ts`). */
export const READY_MERGE_CHECK_SITE = 'ready_merge_check';

/** Tasks one pass checks, at most. */
export const READY_MERGE_CHECK_PER_PASS = 20;

/** How long after its last claim a check that did not read "mergeable" is due again. */
export const READY_MERGE_RECHECK_MS = 10 * 60_000;

export interface ReadyMergeCheckRecoverySite {
  readonly tasks: Pick<TaskRepository, 'readyMergeCheckDue' | 'claimReadyMergeCheck'>;
}

/** One pass: the due tasks, each claimed in a transaction of its own, then its check enqueued. */
export const recoverReadyMergeChecks = async (
  options: { readonly unitOfWork: UnitOfWork; readonly jobs: Jobs; readonly logger?: Logger },
  site: ReadyMergeCheckRecoverySite,
  input: { readonly now: IsoDateTime; readonly limit: number },
): Promise<{ readonly found: number; readonly enqueued: number }> => {
  const staleBefore = new Date(Date.parse(input.now) - READY_MERGE_RECHECK_MS).toISOString();
  const due = await options.unitOfWork.transaction(async (scope) =>
    site.tasks.readyMergeCheckDue(scope.tx, {
      staleBefore: staleBefore as IsoDateTime,
      limit: Math.max(0, Math.min(input.limit, READY_MERGE_CHECK_PER_PASS)),
    }),
  );
  let enqueued = 0;
  for (const row of due) {
    const claimed = await options.unitOfWork.transaction(async (scope) =>
      site.tasks.claimReadyMergeCheck(scope.tx, row.taskId, input.now, staleBefore as IsoDateTime),
    );
    if (!claimed) {
      // Another pass claimed it first; that pass enqueued the check.
      continue;
    }
    await enqueueOutbound(options.jobs, {
      duty: 'ready_merge_check',
      project_id: row.projectId,
      task_id: row.taskId,
      // Required on the wire; the pass has no cause event, and the task id names what woke it.
      cause_event_id: row.taskId,
    });
    enqueued += 1;
  }
  if (enqueued > 0) {
    (options.logger ?? silentLogger).info(
      { enqueued },
      'tasks at Ready had their merge request’s mergeability checked (S-28.13)',
    );
  }
  return { found: due.length, enqueued };
};

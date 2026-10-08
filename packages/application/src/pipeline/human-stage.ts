/**
 * **Is this task waiting at a human stage where a person's word returns it?** — technical/02's
 * M10-head amendment, asked in one place (WP-178 (a)).
 *
 * Two answers since WP-178 (TD-029 decisions 7 and 9): `ready_for_merge`, which is a task **state**
 * of its own, and the optional `qa` stage, which adds no state — a task there is `active` with
 * current stage `qa`, as a spike task at `human_review` is. Before WP-178 every reader asked only
 * `state === 'ready_for_merge'`: the review window (`jobs.ts`), the comment, merge and
 * default-branch handlers (`saga.ts`) and the merge-request poll's waiting set
 * (`postgres-ticket-poll.ts`). Each asks this now, so a task at `qa` is returned, merged and
 * re-checked exactly as one at `ready_for_merge` is.
 *
 * A **paused** task is at neither: a pause is a person's stop (`isHumanOwnedStop`), and nothing a
 * person writes meanwhile is decided until the resume brings it back.
 */
import type { HumanReturnStage } from '@platform/domain';
import { QA_STAGE_ID } from '@platform/domain';
import type { StoredTask } from './store.js';

/** The human stage the task waits at, or `null` when it waits at none. */
export const humanReturnStageOf = (stored: Pick<StoredTask, 'task'>): HumanReturnStage | null => {
  if (stored.task.state === 'ready_for_merge') {
    return 'ready_for_merge';
  }
  return stored.task.state === 'active' && stored.task.currentStage === QA_STAGE_ID ? 'qa' : null;
};

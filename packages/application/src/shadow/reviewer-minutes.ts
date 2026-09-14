/**
 * product/19 §13's *"reviewer minutes estimate (from MR events)"*, for somebody else's merge
 * request — WP-34.
 *
 * The arithmetic is **not** re-derived: it is product/19 §16's, which
 * `packages/application/src/human-time/minutes.ts` already implements for the platform's own merge
 * requests (WP-29). *"review = from the first human MR activity (comment, approval, review start)
 * to merge or last activity, capped at 8 h per calendar day and excluding gaps > 2 h"*. Two
 * definitions of a reviewer minute would be two numbers a founder could put beside each other and
 * find different (standing rule 9), so this file is the *gathering* of the activities and nothing
 * else.
 *
 * ## What it can see, and the two errors that follow
 *
 * The only activity a git provider publishes for a **historical** merge request through this
 * platform's port is a discussion note with a `created_at` and a `system` flag. So:
 *
 *  - **approvals are invisible** — PROGRESS backlog **90** records that `mr.approved` is in
 *    product/08:10's contract and absent from the event catalogue — which makes this figure
 *    **under**-state a merge request approved without comment, in the limit to `null`;
 *  - **a bot's note counts as a human's** — PROGRESS backlog **88**, one direction further: a CI
 *    bot or a linter that is not this platform posts ordinary notes, which makes the figure
 *    **over**-state. `system: true` excludes the provider's *own* notes ("added 3 commits") and
 *    nothing else.
 *
 * The two run in opposite directions and do **not** cancel. The report's `notes` says the figure is
 * an estimate; this docblock is where the direction of its error is written down.
 *
 * ## The zone
 *
 * `reviewMinutes` caps *"per calendar day"*, which needs a zone, and this function has none to
 * offer: the merge request belongs to somebody else's repository and the batch is not a budget
 * window. It uses **UTC**, and the consequence is bounded and stated: the cap only bites on a
 * window longer than eight hours in a day, and the difference between UTC's midnight and an
 * organisation's is at most one day's worth of re-slicing at the boundary. Anything that needed the
 * organisation's calendar would have to take it as an argument, and nothing does yet.
 */

import { continuesWindow, reviewMinutes, roundMinutes } from '../human-time/minutes.js';
import type { Discussion } from '../ports/integrations/git-provider.js';

/** The zone the daily cap is applied in; see the docblock. */
export const SHADOW_REVIEW_TIMEZONE = 'UTC';

/**
 * Minutes of human review on a merge request, or `null` when there is no evidence of any.
 *
 * `null` rather than `0`, because *"nobody commented"* and *"somebody commented for no time"* are
 * different facts and only one of them is something this can establish (standing rule 16).
 *
 * `until` is the merge instant when the caller knows it — product/19 §16 says the window runs *"to
 * merge or last activity"*, and a merge that happened after the last comment is part of the review.
 * `null` means "use the last activity", which is what a merge request with no recorded merge time
 * gets.
 */
export const reviewerMinutesFromDiscussions = (
  discussions: readonly Discussion[],
  options: { readonly until: string | null },
): number | null => {
  const instants = discussions
    .flatMap((discussion) => discussion.notes)
    .filter((note) => !note.system)
    .map((note) => Date.parse(note.created_at))
    .filter((value) => !Number.isNaN(value))
    .sort((left, right) => left - right);
  const first = instants[0];
  if (first === undefined) {
    return null;
  }
  const mergedAt = options.until === null ? Number.NaN : Date.parse(options.until);
  const closing = Number.isNaN(mergedAt) ? null : mergedAt;

  // One window per run of activity no more than two hours apart, exactly as WP-29's projector
  // builds them — the gap rule is what keeps a merge request that sat open for a month from being
  // read as a month of review.
  let windowStart = first;
  let last = first;
  let total = 0;
  const close = (end: number): void => {
    total += reviewMinutes(
      new Date(windowStart).toISOString(),
      new Date(end).toISOString(),
      SHADOW_REVIEW_TIMEZONE,
    );
  };
  for (const at of instants.slice(1)) {
    if (continuesWindow(new Date(last).toISOString(), new Date(at).toISOString())) {
      last = at;
      continue;
    }
    close(last);
    windowStart = at;
    last = at;
  }
  // The merge extends the **last** window only when it is inside the gap rule; a merge request
  // merged a week after its last comment is not a week of review.
  if (
    closing !== null &&
    closing > last &&
    continuesWindow(new Date(last).toISOString(), new Date(closing).toISOString())
  ) {
    last = closing;
  }
  close(last);
  return roundMinutes(total);
};

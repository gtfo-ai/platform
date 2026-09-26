/**
 * The rejected merge request whose close wake-up was lost — PROGRESS backlog **178**, WP-59 review
 * round 1, a row of `./stranded.ts`'s table.
 *
 * ## What is wrong without this
 *
 * `reworkStageCommand` lets go of the task's merge request in its transaction (`tasks.mr_ref =
 * null`, so the provider's `mr.closed` for it cannot escalate the task it was closed *for*) and
 * enqueues the `close_superseded_mr` duty after the commit. That enqueue is at-most-once (TD-004): a
 * process that died between the two left the rejected merge request **open, uncommented and
 * detached from every task** — the platform no longer reacts to its `mr.merged` — and nothing could
 * find it again, because the same commit cleared the only row that named it. A reviewer who had not
 * seen the rework could then merge the approach a person rejected.
 *
 * ## What it looks for, and what bounds it
 *
 * The rework now also writes a `superseded_merge_requests` row (migration 0043) in the same
 * transaction, and the duty **settles** it at every ending it can reach — closed, found merged,
 * re-adopted by its task, no git binding any more, a shadow task. So *"unsettled after a pass
 * interval"* is exactly *"the duty has not ended it"*: its wake-up was lost, or it failed.
 *
 * The bound is the row's own `recovery_attempted_at` — the attempt-or-end shape the bootstrap, ask,
 * record and curation rows share: **one** re-enqueue, marked before it is sent; and when the row is
 * still unsettled a whole ending window after that attempt, the **ending**: the row is settled
 * `abandoned` with the reason, and the pass logs it at **error**. That is the visibility a close that
 * fails for good gets, and it is the cheap one: an error line naming the task, the merge request and
 * its URL, plus the `abandoned` row a query can list — and, underneath, every attempt's `failed`
 * audit row in `integration_actions`. It is **not** an escalation of the task: the task is working
 * on its new branch and has nothing to do about a provider that refuses a close; the operator does.
 *
 * A re-enqueue is idempotent end to end: the duty re-validates on fire (a task that re-adopted the
 * merge request leaves it open), and both of its writes carry platform-owned idempotency keys, so a
 * wake-up that was only *slow* rather than lost costs a replayed row and no second comment.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import type { Transaction } from '../ports/transaction.js';
import type { StrandedQuery } from './stranded.js';

/** One unsettled superseded merge request, with everything its wake-up's payload needs. */
export interface StrandedSupersededMergeRequest {
  readonly taskId: Id;
  readonly projectId: Id;
  readonly iid: number;
  readonly mrUrl: string;
  readonly mrProjectPath: string | null;
  readonly newBranch: string | null;
  readonly causeEventId: Id;
  /** `null` until this pass has spent the row's one attempt. */
  readonly recoveryAttemptedAt: IsoDateTime | null;
}

export interface SupersededMergeRequestRecoveryStore {
  /**
   * Unsettled rows the pass must act on: never attempted and superseded before
   * `query.olderThan`, or attempted before `query.endingBefore`. Oldest first, at most
   * `query.limit`.
   */
  strandedSupersededMergeRequests(
    tx: Transaction,
    query: StrandedQuery,
  ): Promise<readonly StrandedSupersededMergeRequest[]>;
  /** Records this pass's one attempt, which is what the next pass reads. */
  markSupersededAttempt(
    tx: Transaction,
    input: { readonly taskId: Id; readonly iid: number; readonly at: IsoDateTime },
  ): Promise<void>;
  /** The ending: settled `abandoned`, with the reason in `detail`. */
  endSupersededMergeRequest(
    tx: Transaction,
    input: {
      readonly taskId: Id;
      readonly iid: number;
      readonly reason: string;
      readonly at: IsoDateTime;
    },
  ): Promise<void>;
}

export interface SupersededMergeRequestRecoverySite {
  readonly store: SupersededMergeRequestRecoveryStore;
}

/** Platform text only: the reason stored on an abandoned row. */
export const supersededEndingReason = (attemptedAt: IsoDateTime): string =>
  `the platform re-enqueued this merge request's close at ${attemptedAt} after its wake-up was lost or failed, and it was still not closed a whole ending window later; close it by hand (PROGRESS backlog 178)`;

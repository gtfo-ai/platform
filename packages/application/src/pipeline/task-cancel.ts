/**
 * **The one way a task is cancelled** — a person's *Cancel task* (`commands.ts`'s
 * `cancelTaskCommand`) and the platform's own cancellation of a task whose ticket a person finished
 * (M28 ruling 4b, S-28.14: the reverse sync, `ticket-status-recheck.ts`, and the claim,
 * `ticket-claim.ts`) run the same steps in the caller's task transaction, so the platform's is not a
 * second implementation:
 *
 *  1. the totals read from the runs, never from the request;
 *  2. the stage's offer closed **first** (`closeStageOffer`: an open offer withdrawn and its run
 *     ended, a claimed one told to stop through a `cancel` run command for its lease holder, which
 *     ends the run through its own settle and releases its reservation) — `run_offers` → `runs` →
 *     `tasks`, TD-031's lock order;
 *  3. the task saved `cancelled` (the aggregate's `cancelTask`, so a refused transition throws);
 *  4. the attempt it was at closed, so it can never resume (WP-46);
 *  5. an approval it still waited for withdrawn (S-27.1);
 *  6. the events appended in that order.
 *
 * The caller owns the transaction and its retry (`writeTask`, `inTaskTransaction` — both under
 * `retryOnTaskConflict`), and the `task.cancelled` event is what tells the task's people
 * (`notify/handlers.ts`, its `outcome` is the detail) and gives the ticket back
 * (`ticket-lifecycle.ts`'s release). **The merge request is never touched** here or by anything the
 * event wakes.
 */
import type { Id } from '@platform/contracts';
import { type CommandContext, cancelTask, withdrawApproval } from '@platform/domain';
import type { TransactionScope } from '../ports/unit-of-work.js';
import { pendingApproval } from './approval-wait.js';
import { closeStageOffer } from './offer-withdrawal.js';
import type { OfferWithdrawalCode, PipelineStore, StoredTask } from './store.js';
import { CANCELLED_OUTCOME, closeCurrentStageRow } from './transitions.js';

export interface CancellationInput {
  /** `task.cancelled`'s `outcome` — the sentence a person reads, in the notification and on the page. */
  readonly outcome: string;
  /** `run_offers.withdrawn_reason`'s code. */
  readonly offerCode: OfferWithdrawalCode;
  /** Platform text: `run.offer.withdrawn`'s reason. */
  readonly offerReason: string;
  /** The closed attempt's recorded reason. */
  readonly stageNote: string;
  /** The person whose command this is (recorded on a run's `cancel`); absent for the platform. */
  readonly actorUserId?: Id;
}

/** Cancels `stored` in the caller's task transaction — see the module docblock. */
export const cancelTaskInScope = async (
  deps: { readonly store: PipelineStore },
  scope: TransactionScope,
  stored: StoredTask,
  context: CommandContext,
  input: CancellationInput,
): Promise<void> => {
  const totals = await deps.store.runs.totalsFor(scope.tx, stored.task.id);
  const decision = cancelTask(
    stored.task,
    {
      outcome: input.outcome,
      totals: {
        cost_usd: totals.costUsd,
        is_estimate: totals.isEstimate,
        // WP-131 (backlog 403): what `cost_usd` excludes, so a reader of the total is told.
        unmeasured_runs: totals.unmeasuredRuns,
        runs: totals.runs,
        wall_ms: totals.wallMs,
      },
    },
    context,
  );
  // WP-276: the stage's offer is closed first — `run_offers` → `runs` → `tasks`.
  const closing = await closeStageOffer(deps, scope, {
    taskId: stored.task.id,
    code: input.offerCode,
    reason: input.offerReason,
    context,
    actorUserId: input.actorUserId ?? null,
  });
  await deps.store.tasks.save(scope.tx, { ...stored, task: decision.aggregate });
  // The attempt the task was at can never resume now, paused or not (WP-46, backlog 212).
  await closeCurrentStageRow(deps.store, scope.tx, stored.task, CANCELLED_OUTCOME, input.stageNote);
  // S-27.1 (review of #113): an approval the task still waited for is withdrawn — nobody can
  // decide it now, and since an approval never expires it would stay in the Inbox for ever. The
  // aggregate records it on the approval's stream, as a decision does (`withdrawApproval`).
  const waiting = await pendingApproval(deps.store, scope.tx, stored.task.id);
  const withdrawn = waiting === null ? null : withdrawApproval(waiting.approval, context);
  if (waiting !== null && withdrawn !== null) {
    await deps.store.approvals.save(scope.tx, { ...waiting, approval: withdrawn.aggregate });
  }
  await scope.events.append([...closing.events, ...decision.events, ...(withdrawn?.events ?? [])]);
};

/** The tracker's word: Jira, GitLab, or *the tracker*. */
export const trackerWord = (provider: string): string =>
  provider.startsWith('jira') ? 'Jira' : provider.startsWith('gitlab') ? 'GitLab' : 'the tracker';

/** How a merge request is named in a sentence: GitLab's `!12`, anything else `#12`. */
const mergeRequestName = (ref: {
  readonly provider?: string | null;
  readonly iid: number;
}): string => `${(ref.provider ?? '').startsWith('gitlab') ? '!' : '#'}${String(ref.iid)}`;

/**
 * **Why the platform cancelled a task whose ticket moved** (M28 ruling 4b, S-28.14) — the
 * `task.cancelled` outcome, so the notification and the task page say it in plain words: the
 * ticket's key, the status name (the redacted, bounded read) and the tracker; and, when the task
 * has a merge request, that it was left alone and what the person does with it.
 *
 * `mergeRequest.open` is what the caller read: `true` — read open; `null` — not read (the claim's
 * path), so the sentence does not claim it is open.
 */
export const ticketMovedCancelOutcome = (input: {
  readonly key: string;
  readonly provider: string;
  readonly status: string;
  readonly reason: 'ticket_closed_in_tracker' | 'ticket_taken_by_person';
  readonly mergeRequest: {
    readonly ref: {
      readonly provider?: string | null;
      readonly iid: number;
      readonly url: string;
    };
    readonly open: boolean | null;
  } | null;
}): string => {
  const where = trackerWord(input.provider);
  const head =
    input.reason === 'ticket_closed_in_tracker'
      ? `Cancelled automatically: ${input.key} is "${input.status}" in ${where}, a status that means it is finished.`
      : `Cancelled automatically: ${input.key} was moved to "${input.status}" in ${where}, a status the platform did not set — a person seems to be working on it.`;
  const mr = input.mergeRequest;
  if (mr === null) {
    return head;
  }
  const name = mergeRequestName(mr.ref);
  return mr.open === true
    ? `${head} Its merge request ${name} is still open — close or merge it yourself: ${mr.ref.url}`
    : `${head} Its merge request ${name} was left as it is — if it is still open, close or merge it yourself: ${mr.ref.url}`;
};

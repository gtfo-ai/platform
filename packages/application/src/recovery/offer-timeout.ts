/**
 * **An offer nobody took** — a row of `./stranded.ts`'s table (WP-278, TD-031 decisions 1 and 8).
 *
 * ## What is lost
 *
 * Since WP-276 an agent run waits as an **offer** (`run_offers`, `open`) until a claimant takes it:
 * the server's claimant loop from the offer's `server_from`, a remote worker (WP-281) from its
 * `workers_from` or inside the assignee's window. Nothing guarantees one ever does — a
 * `workers_only` project with no worker connected, a `server_only` project on a core with no
 * runner, a project whose credential no remote claim admits — and an open offer holds the task's
 * stage entry (the per-task index) for as long as it is open. Before this row, nothing ended it.
 *
 * ## What it does
 *
 * Every offer carries `expires_at = offered_at + offer_timeout` (the project's execution setting,
 * 24 h by default, written by `routeOffer` at offer time). The pass reads the open offers whose
 * `expires_at` has passed (`RunOfferRepository.expiredOpen`) and withdraws each through its kind's
 * executor (`PipelineRuntime.withdrawOffer`): **one conditional update** on the offer — a claim
 * that won the row first leaves it `claimed`, the withdrawal touches nothing, and the run goes on —
 * then the run `created → cancelled` at the measured zero (`run.offer.withdrawn`, `run.finished`),
 * and the task escalated to `needs_human` with the brief *no claimant took this run* (a stage) or
 * the ask refused with it (an ask, TD-031 §13).
 *
 * ## What bounds it
 *
 * The offer's own state: a withdrawn offer is not `open`, so the read cannot find it twice, and it
 * needs no attempt mark — the shape the `run_lease` and `task_ask_run` rows have. It is an
 * **ending** and never a re-offer: a run nobody took in a day is a configuration a person has to
 * look at (no worker, no runner, a credential refused), and offering it again would hide that.
 * An offer written before WP-278 has no `expires_at` and is never found here.
 */
import type { IsoDateTime } from '@platform/contracts';
import type {
  ExpiredRunOffer,
  OfferWithdrawalReason,
  RunOfferRepository,
} from '../pipeline/store.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';

/** The site name the pass reports under (`./stranded.ts`, `ports/job-exhaustion.ts`). */
export const OFFER_TIMEOUT_SITE = 'run_offer_timeout';

/** `run_offers.withdrawn_reason` for an expired offer: a code, the column holds 64 characters. */
export const OFFER_TIMEOUT_REASON = 'offer_timeout';

/** The escalation's brief (TD-031 decision 1: *no claimant took this run*), naming when it expired. */
export const offerTimeoutBrief = (
  offer: Pick<ExpiredRunOffer, 'offeredAt' | 'expiresAt'>,
): string =>
  `no claimant took this run: it was offered at ${offer.offeredAt} and nobody claimed it before its offer timeout at ${offer.expiresAt}. Check where this project's runs may execute (project settings, Execution) — a workers-only project needs a connected worker, a server-only project a server runner`;

export interface OfferTimeoutRecoverySite {
  readonly store: Pick<RunOfferRepository, 'expiredOpen'>;
  /**
   * The withdrawal through the offer's kind (`PipelineRuntime.withdrawOffer`), in transactions of
   * its own; `false` when a claim took the offer first.
   */
  readonly withdraw: (offer: ExpiredRunOffer, reason: OfferWithdrawalReason) => Promise<boolean>;
}

/** One pass: read the expired offers, then withdraw each in its own transaction. */
export const recoverExpiredOffers = async (
  options: { readonly unitOfWork: UnitOfWork; readonly logger?: Logger },
  site: OfferTimeoutRecoverySite,
  input: { readonly now: IsoDateTime; readonly limit: number },
): Promise<{ readonly found: number; readonly ended: number }> => {
  const logger = options.logger ?? silentLogger;
  const expired = await options.unitOfWork.transaction(async (scope) =>
    site.store.expiredOpen(scope.tx, input),
  );
  let ended = 0;
  for (const offer of expired) {
    const brief = offerTimeoutBrief(offer);
    const withdrawn = await site.withdraw(offer, { withdrawnReason: OFFER_TIMEOUT_REASON, brief });
    if (!withdrawn) continue;
    ended += 1;
    logger.warn(
      {
        project_id: offer.projectId,
        task_id: offer.taskId,
        run_id: offer.runId,
        offer_kind: offer.kind,
        offered_at: offer.offeredAt,
        expires_at: offer.expiresAt,
      },
      offer.kind === 'stage'
        ? 'no claimant took this run before its offer timeout, so the offer was withdrawn and the task escalated to needs_human (TD-031 decision 1)'
        : 'no claimant took this ask’s run before its offer timeout, so the offer was withdrawn and the ask refused (TD-031 decisions 1 and 13)',
    );
  }
  return { found: expired.length, ended };
};

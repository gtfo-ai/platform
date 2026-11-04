/**
 * Offers and the claim — WP-274, TD-031 decisions 1–2 (migration 0094).
 *
 * Every agent run is an **offer** (`run_offers`, one row per run) written in the run's creation
 * transaction, and becomes a claimant's only through **one claim**: {@link claimRunOffer}, the single
 * function every claimant calls, over the repository's one SQL statement (`for update skip locked`,
 * the epoch incremented, the run's `lease_owner`/`lease_expires_at`/`lease_epoch` written with it).
 * Every later write the claimant makes carries the claim's {@link RunLeaseFence}.
 *
 * ## What WP-274 changes, and what it deliberately does not
 *
 * The server's runner is the **only** claimant, and it claims inside the job that wrote the offer —
 * `stage.execute` ({@link offerAndClaimInJob} from `stage-executor.ts`'s run-creation transaction)
 * and `task.ask` (the ask executor's). So a run still executes inside its job, the job's singleton
 * still holds for the run's duration, and every existing tier is unchanged; what is new is the row,
 * its epoch and the two events. WP-276 moves the run out of the job and makes the claim a loop.
 *
 * The run row is inserted with its lease in the same transaction (WP-47's rule: a live row with no
 * lease is the row the sweep's backstop takes an hour to reach). Since WP-275b it is inserted
 * **`created`** — TD-031's 2026-11-04 amendment §4 — the claim moves it to `starting`, and the CLI
 * spawn marker to `running` with `run.started`; WP-276 puts time between the offer and the claim.
 *
 * ## Who closes the offer
 *
 * Not this module: `RunRepository.finish` closes it, in the terminal writer's transaction, because
 * every terminal writer goes through `finish` (`run-terminal-writers.test.ts` holds that).
 */
import type { Id, IsoDateTime, RunOfferKind } from '@platform/contracts';
import { type CommandContext, claimRun, offerRun, type Run } from '@platform/domain';
import type { Transaction } from '../ports/transaction.js';
import type { ClaimedRunOffer, RunLeaseFence, RunOfferClaim, RunOfferRepository } from './store.js';

/** The `lease_owner` the server's runner writes: `server:<process>` (TD-031 §2). */
export const serverLeaseOwner = (process: string): string => `server:${process}`;

/**
 * **The one claim** (TD-031 §2). Every claimant calls this and nothing else touches an offer's
 * `open → claimed` edge; it answers `null` when no eligible offer was open.
 */
export const claimRunOffer = async (
  offers: RunOfferRepository,
  tx: Transaction,
  claim: RunOfferClaim,
): Promise<ClaimedRunOffer | null> => offers.claim(tx, claim);

/** The claim took nothing in the very transaction that wrote the offer — an invariant broke. */
export class OfferNotClaimedError extends Error {
  override readonly name = 'OfferNotClaimedError';
  readonly runId: Id;

  constructor(runId: Id) {
    super(
      `the offer of run ${runId} was written in this transaction and the claim took nothing: the run is not this job's to run`,
    );
    this.runId = runId;
  }
}

export interface OfferAndClaimInput {
  /** The run as it stands after `startRun` — its row already inserted in this transaction. */
  readonly run: Run;
  readonly kind: RunOfferKind;
  readonly offerId: Id;
  /**
   * `server:<process>` ({@link serverLeaseOwner}), or `null` in a composition that configures **no**
   * run lease (a test harness with no heartbeat): the claim still happens and still increments the
   * epoch, and the run row keeps the null `lease_owner`/`lease_expires_at` such a composition wrote
   * before WP-274 — so the cancel and steer branches that read "nobody holds this run" are unchanged.
   */
  readonly owner: string | null;
  readonly expiresAt: IsoDateTime | null;
  readonly now: IsoDateTime;
}

export interface OfferedAndClaimed {
  /** The run with `run.offered` and `run.claimed` recorded on its stream. */
  readonly run: Run;
  readonly events: ReturnType<typeof offerRun>['events'];
  /** What every later write of this run by this claimant carries. */
  readonly fence: RunLeaseFence;
}

/**
 * Writes the run's offer and claims it at once — the in-job claimant of WP-274 (criterion 1), inside
 * the run's creation transaction. Throws {@link OfferNotClaimedError} if the claim takes nothing,
 * which within one transaction means a broken invariant rather than a race.
 */
export const offerAndClaimInJob = async (
  offers: RunOfferRepository,
  tx: Transaction,
  input: OfferAndClaimInput,
  context: CommandContext,
): Promise<OfferedAndClaimed> => {
  await offers.insert(tx, {
    id: input.offerId,
    runId: input.run.id,
    taskId: input.run.taskId,
    projectId: input.run.projectId,
    stage: input.run.stage,
    attempt: input.run.attempt,
    kind: input.kind,
    offeredAt: input.now,
  });
  const offered = offerRun(input.run, { offerId: input.offerId, kind: input.kind }, context);
  const claimed = await claimRunOffer(offers, tx, {
    eligibility: { runId: input.run.id },
    claimantKind: 'server',
    owner: input.owner,
    expiresAt: input.expiresAt,
    now: input.now,
  });
  if (claimed === null) {
    throw new OfferNotClaimedError(input.run.id);
  }
  const recorded = claimRun(
    offered.aggregate,
    {
      offerId: claimed.offerId,
      claimantKind: 'server',
      workerId: null,
      epoch: claimed.epoch,
    },
    context,
  );
  return {
    run: recorded.aggregate,
    events: [...offered.events, ...recorded.events],
    fence: { epoch: claimed.epoch, owner: claimed.owner },
  };
};

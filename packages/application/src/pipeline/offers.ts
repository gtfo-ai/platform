/**
 * Offers and the claim — WP-274, TD-031 decisions 1–3 (migration 0094); the asynchronous hand-off
 * since WP-276.
 *
 * Every agent run is an **offer** (`run_offers`, one row per run) written in the run's creation
 * transaction ({@link offerRun}), and becomes a claimant's only through **one claim**:
 * {@link claimRunOffer}, the single function every claimant calls, over the repository's one SQL
 * statement (`for update of o, r skip locked`, the epoch incremented, the run's
 * `lease_owner`/`lease_expires_at`/`lease_epoch` written with it, the run `created → starting`).
 * Every later write the claimant makes carries the claim's {@link RunLeaseFence}.
 *
 * ## The job ends at the offer (WP-276)
 *
 * Until WP-276 the job that wrote the offer claimed it in the same transaction and ran the session
 * itself. Now `stage.execute` (and `task.ask`) **end after the offer**: the run waits, `created`, for
 * a claimant — the server's claimant loop (`./claimant.ts`, composed by configuration, TD-031
 * decision 13) or, from WP-281, a remote worker. The offer is announced on {@link RUN_OFFERS_TOPIC}
 * when its transaction commits, so a claimant that is listening wakes at once; a claimant's own poll
 * is the guarantee for a notification sent while nothing listened.
 *
 * ## Who closes the offer
 *
 * `RunRepository.finish` closes it, in the terminal writer's transaction, because every terminal
 * writer goes through `finish` (`run-terminal-writers.test.ts` holds that) — and a task transition
 * that leaves the stage entry while the offer is still open **withdraws** it (`./offer-withdrawal.ts`).
 */
import type { Id, IsoDateTime, RunOfferKind } from '@platform/contracts';
import {
  type CommandContext,
  claimRun,
  type Run,
  offerRun as recordRunOffered,
} from '@platform/domain';
import type { Transaction } from '../ports/transaction.js';
import type { TransactionScope } from '../ports/unit-of-work.js';
import type { ClaimedRunOffer, RunLeaseFence, RunOfferClaim, RunOfferRepository } from './store.js';

/** The `lease_owner` the server's runner writes: `server:<process>` (TD-031 §2). */
export const serverLeaseOwner = (process: string): string => `server:${process}`;

/**
 * The broadcast topic an offer is announced on when its transaction commits — TD-031's
 * `pg_notify('run_offers')`. The payload names the offer's kind and run, and a claimant needs
 * neither: it wakes and claims through the one claim, which picks the oldest eligible offer.
 */
export const RUN_OFFERS_TOPIC = 'run_offers';

/**
 * **The one claim** (TD-031 §2). Every claimant calls this and nothing else touches an offer's
 * `open → claimed` edge; it answers `null` when no eligible offer was open.
 */
export const claimRunOffer = async (
  offers: RunOfferRepository,
  tx: Transaction,
  claim: RunOfferClaim,
): Promise<ClaimedRunOffer | null> => offers.claim(tx, claim);

export interface OfferRunInput {
  /** The run as `recordRunCreated` left it — its row already inserted in this transaction. */
  readonly run: Run;
  readonly kind: RunOfferKind;
  readonly offerId: Id;
  readonly now: IsoDateTime;
}

/**
 * Writes the run's offer `open` in its creation transaction, records `run.offered` on the run's
 * stream, and announces it on {@link RUN_OFFERS_TOPIC} at commit (WP-276). The caller appends the
 * returned events with the run's own. **No claim**: the run waits, `created`, for a claimant.
 */
export const offerRun = async (
  offers: RunOfferRepository,
  scope: Pick<TransactionScope, 'tx' | 'broadcast'>,
  input: OfferRunInput,
  context: CommandContext,
): Promise<ReturnType<typeof recordRunOffered>> => {
  await offers.insert(scope.tx, {
    id: input.offerId,
    runId: input.run.id,
    taskId: input.run.taskId,
    projectId: input.run.projectId,
    stage: input.run.stage,
    attempt: input.run.attempt,
    kind: input.kind,
    offeredAt: input.now,
  });
  await scope.broadcast.publish({
    topic: RUN_OFFERS_TOPIC,
    payload: { run_id: input.run.id, kind: input.kind },
  });
  return recordRunOffered(input.run, { offerId: input.offerId, kind: input.kind }, context);
};

/** What {@link recordClaim} answers: the run `starting` and the fence every later write carries. */
export interface RecordedClaim {
  readonly run: Run;
  readonly events: ReturnType<typeof claimRun>['events'];
  readonly fence: RunLeaseFence;
}

/** `run.claimed` for a claim the repository granted — the run `created → starting` in the log. */
export const recordClaim = (
  run: Run,
  claimed: ClaimedRunOffer,
  context: CommandContext,
): RecordedClaim => {
  const recorded = claimRun(
    run,
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
    events: recorded.events,
    fence: { epoch: claimed.epoch, owner: claimed.owner },
  };
};

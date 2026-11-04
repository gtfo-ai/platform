/**
 * A test's way to give a seeded run a lease (WP-274).
 *
 * Before WP-274 a test planted a lease with `runs.renewLease`, whose first write **claimed** an
 * unheld row. Since then the lease is written only by the offer's one claim (TD-031 §2,
 * `../pipeline/offers.ts`), and `renewLease` renews only under the epoch that claim granted — so a
 * test that wants a leased run goes through the same claim production does, and gets the fence its
 * later writes must carry. Over any `PipelineStore` (the memory store and PostgreSQL alike), which
 * is what lets the contract suite use it.
 *
 * The offer is `kind: 'ask'` by default: an ask's offer is outside the per-task index, so a test
 * that seeds several live runs on one task is not refused by an index it is not about. A test about
 * the index passes `kind: 'stage'` (and a stage).
 */
import type { Id, IsoDateTime, RunOfferKind, Slug } from '@platform/contracts';
import { claimRunOffer } from '../pipeline/offers.js';
import type { PipelineStore, RunLeaseFence } from '../pipeline/store.js';
import type { Transaction } from '../ports/transaction.js';

export interface TestRunClaim {
  readonly offerId: Id;
  readonly runId: Id;
  readonly taskId: Id;
  readonly projectId: Id;
  /** `null` writes no lease (a composition with no heartbeat); the claim still takes the epoch. */
  readonly owner: string | null;
  readonly expiresAt: IsoDateTime | null;
  readonly now: IsoDateTime;
  readonly kind?: RunOfferKind;
  readonly stage?: Slug | null;
  readonly attempt?: number;
}

/** Writes the run's offer and claims it; throws when the claim takes nothing. */
export const offerAndClaimForTest = async (
  store: Pick<PipelineStore, 'offers'>,
  tx: Transaction,
  input: TestRunClaim,
): Promise<RunLeaseFence> => {
  await store.offers.insert(tx, {
    id: input.offerId,
    runId: input.runId,
    taskId: input.taskId,
    projectId: input.projectId,
    stage: input.stage ?? null,
    attempt: input.attempt ?? 1,
    kind: input.kind ?? 'ask',
    offeredAt: input.now,
  });
  const claimed = await claimRunOffer(store.offers, tx, {
    eligibility: { runId: input.runId },
    claimantKind: 'server',
    owner: input.owner,
    expiresAt: input.expiresAt,
    now: input.now,
  });
  if (claimed === null) {
    throw new Error(`the test's claim of run ${input.runId} took nothing`);
  }
  return { epoch: claimed.epoch, owner: claimed.owner };
};

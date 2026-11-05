/**
 * Whether a worker can take work now, and what stops it — read off the server's answer (S-22.19,
 * the worker UX review's N1): each `GET /api/workers` item carries `claim_blockers` (the claim's own
 * predicates minus the per-offer ones, in the vocabulary's order), `can_claim` (that list is empty)
 * and `last_claimed_at`. S-23.20 shipped a stub here that guessed three blockers from the heartbeat
 * and the pause columns; S-23.24 replaced it with these fields, so **nothing here derives a
 * blocker** — the core is the one place that knows the images, the protocol and the projects.
 *
 * The words for each blocker are `WORKER_CLAIM_BLOCKER_WORDS` in `ui/humanize.ts`, the same table
 * the worker's own page reads, so both sides say a blocker in the same words.
 *
 * ## `takes`: the one judgement this module adds
 *
 * `can_claim` is `false` for a *pick only* worker (`pick_only`): it claims nothing **by itself**,
 * yet a run its owner picks on its page still starts. A screen that asks "can this worker work?" —
 * the wizard's *Ready to work*, Home's worker step — must not hold such a worker forever, so
 * {@link WorkerReadiness.takes} names three answers in the words a project's execution read uses
 * (`automatically`, `picked_only`, `no`): `picked_only` is exactly "its only blocker is its owner's
 * choice".
 */
import {
  orderClaimBlockers,
  type WorkerClaimBlocker,
  type WorkerSummary,
} from '@platform/contracts';

export type { WorkerClaimBlocker } from '@platform/contracts';

export interface WorkerReadiness {
  /** The server's verdict: an automatic claim would be admitted now. */
  readonly can_claim: boolean;
  /** Why not, in the vocabulary's order — the first is the one a row shows. */
  readonly claim_blockers: readonly WorkerClaimBlocker[];
  /** By itself, only when its owner picks a run, or not at all (see the module note). */
  readonly takes: 'automatically' | 'picked_only' | 'no';
  /** When it last claimed a run, or `null` — its first run is a milestone. */
  readonly last_claimed_at: string | null;
}

/** The server's answer for one worker of `GET /api/workers`, with {@link WorkerReadiness.takes}. */
export const workerReadinessOf = (worker: WorkerSummary): WorkerReadiness => {
  const blockers = orderClaimBlockers(worker.claim_blockers);
  const takes =
    worker.can_claim && blockers.length === 0
      ? 'automatically'
      : blockers.length > 0 && blockers.every((blocker) => blocker === 'pick_only')
        ? 'picked_only'
        : 'no';
  return {
    can_claim: takes === 'automatically',
    claim_blockers: blockers,
    takes,
    last_claimed_at: worker.last_claimed_at,
  };
};

/** It takes work — by itself, or when its owner picks a run: what *Ready to work* waits for. */
export const isReadyToWork = (readiness: WorkerReadiness): boolean => readiness.takes !== 'no';

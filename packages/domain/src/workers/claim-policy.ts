/**
 * **What a person's machine takes by itself** — the claim policy, pure (S-26.4, TD-031's 2026-11-06
 * amendment items 6–7, BD-032's 2026-11-06 amendment 2).
 *
 * A worker's automatic claims are narrowed on two orthogonal axes:
 *
 * - **which projects** — the claim scope, `workers.claim_project_ids` (migration 0101): `null` every
 *   project, otherwise those;
 * - **which tasks** — the claim policy, `workers.claim_policy` (migration 0108): `everything`,
 *   `mine_and_unassigned`, `mine` or `pick_only`.
 *
 * Two readings make the rows the previous builds wrote keep their meaning with no data rewrite:
 *
 * 1. **A `null` policy** reads as `pick_only` when the scope is the legacy `[]` (*pick only* before
 *    the policy existed) and as `everything` otherwise ({@link effectiveClaimPolicy}).
 * 2. **A legacy `[]` scope narrows no project** ({@link projectListOf}): wherever the project list
 *    narrows — the automatic claim, the pick list — `[]` reads as `null`. Its whole meaning moved
 *    into the policy.
 *
 * {@link claimPolicyTakes} is the policy as one function of the offer's facts; the SQL spelling the
 * claim asks **in its own statement** is `workerPolicyTakesSql` in
 * `packages/infrastructure/src/pipeline/postgres-run-offers.ts`, and
 * `test/integration/pipeline/claim-policy.integration.test.ts` holds the two to one matrix. Like the
 * scope, the policy **only narrows**: it is asked beside the eligibility, never instead of any part
 * of it, so no policy admits an offer the eligibility refuses.
 *
 * Nothing here reads a clock or a row.
 */
import type { WorkerClaimPolicy } from '@platform/contracts';

/** The policy a worker's row reads as: the stored one, or what a `null` means (rule 1). */
export const effectiveClaimPolicy = (
  stored: WorkerClaimPolicy | null,
  claimProjectIds: readonly string[] | null,
): WorkerClaimPolicy =>
  stored ?? (claimProjectIds !== null && claimProjectIds.length === 0 ? 'pick_only' : 'everything');

/** The project list as it narrows: a legacy `[]` narrows nothing (rule 2). */
export const projectListOf = (
  claimProjectIds: readonly string[] | null,
): readonly string[] | null =>
  claimProjectIds === null || claimProjectIds.length === 0 ? null : claimProjectIds;

/** Whether the project list takes `projectId` (rule 2): `null` or `[]` every project. */
export const projectListTakes = (
  claimProjectIds: readonly string[] | null,
  projectId: string,
): boolean => {
  const list = projectListOf(claimProjectIds);
  return list === null || list.includes(projectId);
};

/**
 * What the policy asks of one offer:
 *
 * - `mine` — a **stage** offer's task is owned by the worker's user; an **ask** offer was asked by
 *   them (an ask's "mine" is its asker, never the task's owner — TD-031's amendment item 6);
 * - `unassigned` — a stage offer's task has no owner and is **not held elsewhere**
 *   (`taskIsUnassigned`, `tasks/owner.ts`). An ask always has its asker, so it is never unassigned.
 */
export interface ClaimPolicyOfferFacts {
  readonly mine: boolean;
  readonly unassigned: boolean;
}

/** Whether an **automatic** claim under `policy` takes the offer. A pick does not ask this. */
export const claimPolicyTakes = (
  policy: WorkerClaimPolicy,
  offer: ClaimPolicyOfferFacts,
): boolean => {
  switch (policy) {
    case 'everything':
      return true;
    case 'mine_and_unassigned':
      return offer.mine || offer.unassigned;
    case 'mine':
      return offer.mine;
    case 'pick_only':
      return false;
  }
};

/**
 * The policy a worker is written with when its device code is collected (TD-031's amendment item
 * 6; BD-032's amendment 2: *a personal subscription should not run a colleague's ticket unless its
 * owner chose that*).
 */
export const NEW_WORKER_CLAIM_POLICY: WorkerClaimPolicy = 'mine_and_unassigned';

/**
 * Whether the worker's owner's head start may go to this worker (TD-031 §8 as amended): its policy
 * claims something by itself — never `pick_only`, which would hold an offer for `assignee_window`
 * for nothing — and its project list takes the project.
 */
export const mayHoldHeadStart = (
  policy: WorkerClaimPolicy,
  claimProjectIds: readonly string[] | null,
  projectId: string,
): boolean => policy !== 'pick_only' && projectListTakes(claimProjectIds, projectId);

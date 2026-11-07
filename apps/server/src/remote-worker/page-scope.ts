/**
 * **An older local page's claim-scope vocabulary, mapped onto the claim policy** (S-26.4, the review
 * of PR #98) — kept for **older cached pages** since S-26.7.
 *
 * S-26.7's page (`apps/web/src/worker/pick-work.tsx`, `ui/claim-policy-card.tsx`) speaks the policy
 * itself: every save names `claim_policy` (and `null`, never `[]`, for every project), which the
 * write below passes through unchanged, and it reads `GET /api/local/claim-scope?vocabulary=policy`,
 * which skips the read's mapping, so a *pick only* machine's projects come back as stored. Neither
 * half is needed for it. Both stay for a tab still open on the page an earlier image served: it
 * keeps polling the updated worker, and nothing in the request says which page it is but the
 * absence of the policy.
 *
 * That older page speaks protocol 3's two spellings: `[]` is *pick only* and anything else is
 * *takes these projects by itself*. A protocol-4 core refuses `[]` (`422 claim_scope_empty`: *pick
 * only* is the policy `pick_only`), and a `pick_only` worker over `null` would read on that page as
 * "takes every project by itself". So the worker translates, exactly as the core translates a
 * version-3 worker (`pick-verbs.ts`):
 *
 * - **a save** with no `claim_policy` of its own: `[]` is `{claim_project_ids: null, claim_policy:
 *   pick_only}`; any other list (or `null`) while the policy reads `pick_only` leaves *pick only* —
 *   `mine_and_unassigned`, the default a new machine is written with — over those projects, so the
 *   page is never trapped in *pick only*. A save that names a policy is sent as it is.
 * - **a read** of a worker whose policy reads `pick_only` answers `[]`, so the page says *pick only*
 *   truthfully.
 *
 * Pure: the policy the core last said is handed in.
 */
import type { WorkerClaimPolicy, WorkerLocalClaimScope } from '@platform/contracts';

/** The body the worker's `PUT claim-scope` sends for one page save. */
export interface ClaimScopeWrite {
  readonly claim_project_ids: string[] | null;
  readonly claim_policy?: WorkerClaimPolicy;
}

/** A page save in its own vocabulary, as the core's protocol-4 `PUT claim-scope` reads it. */
export const claimScopeWriteOfPage = (
  projectIds: readonly string[] | null,
  policy: WorkerClaimPolicy | undefined,
  currentPolicy: WorkerClaimPolicy | null,
): ClaimScopeWrite => {
  const list = projectIds === null ? null : [...projectIds];
  if (policy !== undefined) {
    return { claim_project_ids: list, claim_policy: policy };
  }
  if (list !== null && list.length === 0) {
    return { claim_project_ids: null, claim_policy: 'pick_only' };
  }
  if (currentPolicy === 'pick_only') {
    return { claim_project_ids: list, claim_policy: 'mine_and_unassigned' };
  }
  return { claim_project_ids: list };
};

/** The core's answer as the page reads it: a `pick_only` worker's scope is the page's `[]`. */
export const claimScopeReadForPage = (answer: WorkerLocalClaimScope): WorkerLocalClaimScope =>
  answer.claim_policy === 'pick_only' ? { ...answer, claim_project_ids: [] } : answer;

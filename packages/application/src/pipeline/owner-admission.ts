/**
 * **A person's limit at admission** (S-28.6, the M28 ruling B on BD-010).
 *
 * The owner's feedback: one limit per project on the tasks in the pipeline "should be per worker
 * (user), each can have a separate limit, configurable". A task with an owner (`tasks.owner_user_id`,
 * S-26.1) is admitted only while its owner's tasks in flight — `countsTowardOwner`: `active`,
 * `returned`, `waiting_answers`, `waiting_approval`, across every project — are below their limit
 * (`ownerLimitOf`: their own `users.max_tasks_in_flight`, never above the organisation's value,
 * else the project's `pipeline.wip.max_tasks_per_owner`, 3 by default). An unowned task is bound by
 * the project's two limits only.
 *
 * **Enforced at admission only** — intake and the scheduler. A pick or a take that assigns an owner
 * is never refused by it (the claim never consults a WIP limit), nor is a resume or a hand-back: a
 * person can overshoot their limit that way, and the next admission then waits for them.
 *
 * **Serialised per owner**: `TaskRepository.ownerAdmission` takes a transaction-scoped advisory lock
 * on the owner before it counts, after the caller's project lock (`counts`) — one order for every
 * admitter, so two intakes of one person's tickets in one instant cannot both pass.
 */
import type { Id } from '@platform/contracts';
import { ownerAdmits, ownerLimitOf, type WipLimits } from '@platform/domain';
import type { Transaction } from '../ports/transaction.js';
import type { PipelineStore } from './store.js';

/** What the per-person limit answered for one owned task. */
export interface OwnerAdmission {
  readonly admitted: boolean;
  readonly inFlight: number;
  readonly limit: number;
}

/**
 * Asks the per-person limit for a task owned by `ownerUserId`, under `wip` (the task's project's
 * limits). Takes the owner's admission lock for the rest of `tx`.
 */
export const admitOwner = async (
  store: PipelineStore,
  tx: Transaction,
  wip: WipLimits,
  ownerUserId: Id,
): Promise<OwnerAdmission> => {
  const { inFlight, personalLimit } = await store.tasks.ownerAdmission(tx, ownerUserId);
  const limit = ownerLimitOf(wip, personalLimit);
  return { admitted: ownerAdmits(inFlight, limit), inFlight, limit };
};

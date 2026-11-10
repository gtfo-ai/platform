/**
 * The claim-blocker vocabulary (S-22.19, TD-031's 2026-11-05 blocker-vocabulary amendment) — a
 * module of its own, importing only zod, so `api.ts` (a project's execution read) and `workers.ts`
 * (the Workers screen's rows) both carry it without an import cycle (`worker.ts` imports `api.ts`).
 */
import * as z from 'zod';

/**
 * **Why a worker takes no work** — one vocabulary for the Workers screen, a project's execution
 * read and the worker's own local page (TD-031's 2026-11-05 blocker-vocabulary amendment, S-22.19).
 * Ordered **most fundamental first**: a list of blockers is always sorted in this order, and the
 * first is the one sentence a screen shows. Each side answers the half it can know:
 *
 * - `not_set_up` *(local)*: no platform chosen, no Claude sign-in, or the machine not approved yet;
 * - `revoked`: its credential was revoked — it must be approved again;
 * - `owner_disabled` *(core)*: its owner's account is disabled or banned, so the claim refuses it;
 * - `offline`: the core has not heard from it in a minute *(core)*, or it cannot reach its core
 *   *(local)*;
 * - `protocol_outdated`: it speaks a worker protocol the core no longer accepts;
 * - `platform_images_unresolved` *(core)*: the core cannot name its own run images (a private
 *   registry with no `APP_WORKER_IMAGE_DIGESTS`), so it answers every claim `503
 *   digests_unresolved` — a fault of the platform's, not the worker's;
 * - `claude_rejected` *(local)*: Claude refused the token it holds;
 * - `paused`: its owner paused it on its page;
 * - `draining`: a drain — finish what runs, take nothing new (the page's *Drain*, or its updater);
 * - `usage_limited`: paused until its Claude usage limit resets;
 * - `launcher_unreachable` *(local)*: its launcher does not answer, so it cannot start a run;
 * - `workspace_unavailable`: its launcher answered but could not provision a run's workspace (S-28.12
 *   — Docker out of network ranges, unreachable, out of disk, an image it cannot pull); it handed the
 *   run back and claims nothing until a retry on a backoff, or its owner's *Try again*, succeeds.
 *   The core holds it from the worker's `release provision_failed` until its next claim;
 * - `images_missing`: it holds none of the run images (its launcher is down, or still pulling);
 * - `images_outdated`: it holds images of another build than the core's current one;
 * - `no_eligible_project` *(core)*: no project would give it work — none it may run in admits
 *   workers, or its claim scope names none of those;
 * - `pick_only` *(core)*: its owner chose *pick only*, so it claims nothing **by itself** — a run
 *   picked on its page still starts. The last, because it is the owner's choice rather than a fault.
 *
 * An empty list means the core would admit an **automatic** claim from it now (`can_claim`).
 *
 * The words are `WORKER_CLAIM_BLOCKER_WORDS` in `apps/web/src/ui/humanize.ts`, exhaustive by type.
 */
export const WORKER_CLAIM_BLOCKERS = [
  'not_set_up',
  'revoked',
  'owner_disabled',
  'offline',
  'protocol_outdated',
  'platform_images_unresolved',
  'claude_rejected',
  'paused',
  'draining',
  'usage_limited',
  'launcher_unreachable',
  'workspace_unavailable',
  'images_missing',
  'images_outdated',
  'no_eligible_project',
  'pick_only',
] as const;
export const workerClaimBlockerSchema = z.enum(WORKER_CLAIM_BLOCKERS);
export type WorkerClaimBlocker = z.infer<typeof workerClaimBlockerSchema>;

/** A list of blockers in the vocabulary's order, each once — what every answer carries. */
export const workerClaimBlockersSchema = z
  .array(workerClaimBlockerSchema)
  .max(WORKER_CLAIM_BLOCKERS.length)
  .refine(
    (list) =>
      list.every(
        (blocker, index) =>
          index === 0 ||
          WORKER_CLAIM_BLOCKERS.indexOf(list[index - 1] as WorkerClaimBlocker) <
            WORKER_CLAIM_BLOCKERS.indexOf(blocker),
      ),
    'blockers are distinct and in the vocabulary’s order',
  );

/** Sorts and de-duplicates blockers into the vocabulary's order. */
export const orderClaimBlockers = (
  blockers: Iterable<WorkerClaimBlocker>,
): WorkerClaimBlocker[] => {
  const present = new Set(blockers);
  return WORKER_CLAIM_BLOCKERS.filter((blocker) => present.has(blocker));
};

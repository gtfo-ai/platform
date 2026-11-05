/**
 * Whether a worker can take work now, and what stops it — a **stub** of the server read that is
 * coming (N1 of the worker UX review), derived from what `GET /api/workers` already says.
 *
 * ## The contract to come
 *
 * The server will add three fields to each `GET /api/workers` item, computed with the claim's own
 * predicates (`WORKER_ELIGIBLE` in `postgres-run-offers.ts`) minus the per-offer clauses:
 *
 * ```ts
 * can_claim: boolean
 * claim_blockers: ('offline' | 'paused' | 'draining' | 'usage_limited' | 'images_missing'
 *                  | 'images_outdated' | 'protocol_outdated' | 'no_eligible_project')[]
 * last_claimed_at: string | null   // max(run_offers.claimed_at) for this worker
 * ```
 *
 * When it lands, {@link workerReadinessOf} reads those fields instead and
 * {@link WORKER_BLOCKER_WORDS} is replaced by the contracts' shared words table — both sides of the
 * worker (this SPA and the worker's own page) say a blocker in the same words.
 *
 * ## What the stub can say today
 *
 * - **offline** — not seen in the last minute (TD-031's online worker: a heartbeat in the last 60 s);
 * - **paused** — its owner paused it on its own page (`manually_paused_at`). The core stores a
 *   *drain* the same way, so the stub cannot tell `draining` apart: N1 reads the pause's
 *   `human_actions` row for that;
 * - **usage_limited** — paused until a Claude usage limit resets (`paused_until` in the future);
 * - a **revoked** worker can never claim; it has no blocker word because the wizard never follows one.
 *
 * Everything else — the images it holds against this platform's, its protocol, whether any project
 * would give it work — is the server's to answer, so the stub **never claims a worker is ready on
 * those grounds**: it says nothing about them, and `can_claim` is true only for what it can see. That
 * is the residual of the stub, stated: a worker with the previous build's images reads *ready* here
 * until N1 lands.
 */
import type { WorkerSummary } from '@platform/contracts';

/** N1's blocker vocabulary, exactly as the server will publish it. */
export const WORKER_CLAIM_BLOCKERS = [
  'offline',
  'paused',
  'draining',
  'usage_limited',
  'images_missing',
  'images_outdated',
  'protocol_outdated',
  'no_eligible_project',
] as const;

export type WorkerClaimBlocker = (typeof WORKER_CLAIM_BLOCKERS)[number];

/** A worker is online when it was seen in the last minute (TD-031; the Workers screen's rule). */
export const WORKER_ONLINE_WITHIN_MS = 60_000;

/**
 * Each blocker in plain words — what it means, and what to do — shared by every screen that says
 * why a worker takes nothing. A placeholder for the contracts' table (see the module note); the
 * `Record` is exhaustive, so a blocker added to the vocabulary does not typecheck without its words.
 */
export const WORKER_BLOCKER_WORDS: Readonly<
  Record<WorkerClaimBlocker, { readonly word: string; readonly fix: string }>
> = {
  offline: {
    word: 'Not connected',
    fix: 'Start the worker on that computer: run the start command again in its folder, and check its page at http://127.0.0.1:7357.',
  },
  paused: {
    word: 'Paused by its owner',
    fix: 'Resume it on the worker’s page (http://127.0.0.1:7357 on that computer).',
  },
  draining: {
    word: 'Draining: finishing its runs, taking nothing new',
    fix: 'Resume it on the worker’s page, or restart the worker.',
  },
  usage_limited: {
    word: 'Paused by a Claude usage limit',
    fix: 'It resumes by itself when the limit resets.',
  },
  images_missing: {
    word: 'It has no run images yet',
    fix: 'Its images may still be downloading. On that computer run docker compose ps: the launcher must be running.',
  },
  images_outdated: {
    word: 'It has an older build than this platform',
    fix: 'Its updater fixes this within a few minutes. To do it now, download the compose file again and start the worker again.',
  },
  protocol_outdated: {
    word: 'It needs an update',
    fix: 'Download the compose file again and start the worker again.',
  },
  no_eligible_project: {
    word: 'No project gives it work',
    fix: 'An administrator lets workers run a project in that project’s settings, under Execution.',
  },
};

export interface WorkerReadiness {
  readonly can_claim: boolean;
  readonly claim_blockers: readonly WorkerClaimBlocker[];
  /** When it last took a run; `null` until N1 lands (no read reports it today). */
  readonly last_claimed_at: string | null;
}

/** Seen in the last minute. */
export const isWorkerOnline = (worker: WorkerSummary, nowMs: number): boolean =>
  worker.last_seen_at !== null &&
  nowMs - Date.parse(worker.last_seen_at) <= WORKER_ONLINE_WITHIN_MS;

/** The stub's answer for one worker of today's `GET /api/workers` (see the module note). */
export const workerReadinessOf = (worker: WorkerSummary, nowMs: number): WorkerReadiness => {
  const blockers: WorkerClaimBlocker[] = [];
  if (!isWorkerOnline(worker, nowMs)) {
    blockers.push('offline');
  }
  if (worker.manually_paused_at !== null) {
    blockers.push('paused');
  }
  if (worker.paused_until !== null && Date.parse(worker.paused_until) > nowMs) {
    blockers.push('usage_limited');
  }
  return {
    can_claim: worker.state === 'active' && blockers.length === 0,
    claim_blockers: blockers,
    last_claimed_at: null,
  };
};

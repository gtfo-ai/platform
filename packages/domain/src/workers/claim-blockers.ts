/**
 * **Why a worker takes no work** — the two halves of one vocabulary (TD-031's 2026-11-05
 * blocker-vocabulary amendment, S-22.19; `WORKER_CLAIM_BLOCKERS` in `@platform/contracts`).
 *
 * Pure: each side hands in the facts it holds and gets the blockers back in the vocabulary's order.
 *
 * - **The core's half** ({@link coreClaimBlockersOf}) is the claim's own predicates
 *   (`workerEligibleSql` in `postgres-run-offers.ts`) **minus the per-offer ones** — an offer's
 *   exclusions, its assignee head start, its `workers_from`: revoked; not seen within the online
 *   window; a protocol outside the accepted range; the owner's hold (a drain's when its newest
 *   `worker.pause` row says so); a usage pause still ahead; no image held, or not the core's
 *   current run and egress images; and no project that would give it work. While the core cannot
 *   name its own digests nothing is said about images — a blocker the core cannot establish is not
 *   invented — and a revoked worker is **only** revoked: whatever else its row says is history.
 * - **The worker's half** ({@link localClaimBlockersOf}) is what only the machine knows: its
 *   connection (set up, revoked, the core's `426`, unreachable), whether Claude refused its token,
 *   its holds, whether its launcher answered and which images it holds against the digests the
 *   core's handshake named.
 */
import {
  isAcceptedWorkerProtocol,
  orderClaimBlockers,
  type WorkerClaimBlocker,
} from '@platform/contracts';

/** The core's run and egress images (`CoreImageDigests.platform_runtime`/`platform_egress`). */
export interface RunImageDigests {
  readonly run: string;
  readonly egress: string;
}

/** What the core knows about one worker, as `GET /api/workers` reads it. */
export interface CoreWorkerClaimFacts {
  readonly revoked: boolean;
  /** Seen within the online window, on the database's clock. */
  readonly online: boolean;
  /** The protocol of its last call; `null` before any. */
  readonly protocolVersion: number | null;
  /** The owner's hold: `null` none, `paused`, or a drain's (`via: worker_ui_drain`/`worker_internal_drain`). */
  readonly hold: 'paused' | 'draining' | null;
  /** A usage limit's pause still ahead, on the database's clock. */
  readonly usagePaused: boolean;
  /** The image digests it last reported holding. */
  readonly heldDigests: readonly string[];
  /** The core's current run and egress digests, or `null` while it cannot name them. */
  readonly coreDigests: RunImageDigests | null;
  /**
   * How many projects would give it work — its user may run there, the project admits workers and
   * its run credential may reach a worker, inside its claim scope (*pick only* is every project).
   * `null` when not asked (a project-scoped read asks its own question).
   */
  readonly eligibleProjects: number | null;
}

/** Whether a worker holding `held` holds both of the core's run images. */
export const holdsRunImages = (held: readonly string[], core: RunImageDigests): boolean =>
  held.includes(core.run) && held.includes(core.egress);

const imageBlockers = (
  held: readonly string[],
  core: RunImageDigests | null,
): WorkerClaimBlocker[] => {
  if (held.length === 0) return ['images_missing'];
  if (core !== null && !holdsRunImages(held, core)) return ['images_outdated'];
  return [];
};

/** The core's half of a worker's blockers, in the vocabulary's order; empty when it can claim. */
export const coreClaimBlockersOf = (facts: CoreWorkerClaimFacts): WorkerClaimBlocker[] => {
  if (facts.revoked) return ['revoked'];
  const blockers: WorkerClaimBlocker[] = [];
  if (!facts.online) blockers.push('offline');
  if (facts.protocolVersion !== null && !isAcceptedWorkerProtocol(facts.protocolVersion)) {
    blockers.push('protocol_outdated');
  }
  if (facts.hold !== null) blockers.push(facts.hold);
  if (facts.usagePaused) blockers.push('usage_limited');
  blockers.push(...imageBlockers(facts.heldDigests, facts.coreDigests));
  if (facts.eligibleProjects === 0) blockers.push('no_eligible_project');
  return orderClaimBlockers(blockers);
};

/** The connection states of the worker's local page that are not yet a set-up worker. */
const SETTING_UP = new Set(['needs_platform', 'needs_claude', 'logging_in', 'handshaking']);

/** What the worker itself knows, as its local page's state carries it. */
export interface LocalWorkerClaimFacts {
  /** `WorkerLocalConnection`. */
  readonly connection: string;
  readonly claudeRejected: boolean;
  readonly manuallyPaused: boolean;
  readonly draining: boolean;
  readonly usagePaused: boolean;
  /** `true`/`false` once its launcher was asked; `null` before the first probe. */
  readonly launcherAnswered: boolean | null;
  /** What it holds now (nothing when the launcher did not answer, or its images are missing). */
  readonly heldDigests: readonly string[];
  /** The run and egress digests its core's handshake named, or `null` before one. */
  readonly coreDigests: RunImageDigests | null;
}

/** The worker's half of its blockers, in the vocabulary's order; empty when it takes work. */
export const localClaimBlockersOf = (facts: LocalWorkerClaimFacts): WorkerClaimBlocker[] => {
  if (facts.connection === 'revoked') return ['revoked'];
  const blockers: WorkerClaimBlocker[] = [];
  if (SETTING_UP.has(facts.connection)) blockers.push('not_set_up');
  if (facts.connection === 'core_unreachable' || facts.connection === 'stopped') {
    blockers.push('offline');
  }
  if (facts.connection === 'upgrade_required') blockers.push('protocol_outdated');
  if (facts.claudeRejected) blockers.push('claude_rejected');
  if (facts.draining) blockers.push('draining');
  else if (facts.manuallyPaused) blockers.push('paused');
  if (facts.usagePaused) blockers.push('usage_limited');
  if (facts.launcherAnswered === false) blockers.push('launcher_unreachable');
  else if (facts.launcherAnswered === true) {
    blockers.push(...imageBlockers(facts.heldDigests, facts.coreDigests));
  }
  return orderClaimBlockers(blockers);
};

/**
 * **Why a worker takes no work** (S-22.19): the one vocabulary of the Workers screen, a project's execution panel and the worker's own local page.
 *
 * A module of its own, re-exported unchanged by `ui/humanize.ts` (the screens import it from there):
 * the worker's local page imports **this** module and never `humanize.ts`, so its 120 kB entry
 * carries only the words it shows — `worker/import-graph.test.ts` holds that (BACKLOG 1455).
 */
import type { WorkerClaimBlocker } from '@platform/contracts';

/** A claim blocker in a person's words: a short `word` for a row, and the `fix` beside it. */
export interface ClaimBlockerWords {
  readonly word: string;
  readonly fix: string;
}

/**
 * What an outdated worker's owner does: nothing. Its updater checks when it starts and every minute
 * after, drains the worker and brings it up to date by itself. Re-running the installer is a repair
 * that never changes images, and a hand-edited compose file skips the updater's verification, so
 * neither is advice (S-23.27).
 */
export const UPDATER_FIX =
  'Its updater is bringing it up to date. Nothing to do; this usually takes a minute or two.';

/**
 * **Why a worker takes no work**, in one set of words for the Workers screen, a project's execution
 * panel and the worker's own local page (TD-031's 2026-11-05 blocker-vocabulary amendment, S-22.19).
 * Each sentence names *the worker* or *it*, so it reads the same on the platform and on the machine.
 *
 * Home's count of several machines words the same blockers a second way, singular and plural
 * ("2 not connected, 1 needs an update"): `COUNT_WORDS` in `features/home-setup.ts`, kept out of
 * this table so the worker's page does not load it (S-25.15). Reword a blocker in both.
 */
export const WORKER_CLAIM_BLOCKER_WORDS: Readonly<Record<WorkerClaimBlocker, ClaimBlockerWords>> = {
  not_set_up: {
    word: 'Not set up yet',
    fix: 'Finish the steps on the worker’s page: choose this platform, sign in to Claude and approve the machine.',
  },
  revoked: {
    word: 'Removed from the platform',
    fix: 'To use this computer again, approve it again from the worker’s page.',
  },
  owner_disabled: {
    word: 'Its owner’s account is disabled',
    fix: 'An administrator re-enables the owner’s account in Settings, under Users; the worker then takes work again.',
  },
  offline: {
    word: 'Not connected to the platform',
    fix: 'Start the worker on that computer (“docker compose up -d” in its folder) and check that it reaches the platform.',
  },
  protocol_outdated: {
    word: 'Needs an update',
    fix: `It speaks an older version than this platform accepts. ${UPDATER_FIX}`,
  },
  platform_images_unresolved: {
    word: 'The platform can’t name its run images',
    fix: 'An administrator makes the platform’s images public in their registry, or pins the worker image versions in the platform’s configuration (the operator guide names the setting); until then no worker can take work.',
  },
  claude_rejected: {
    word: 'Claude refused its sign-in',
    fix: 'Sign in to Claude again on the worker’s page.',
  },
  paused: {
    word: 'Paused by its owner',
    fix: 'Resume it on the worker’s page.',
  },
  draining: {
    word: 'Draining: finishing its runs, taking nothing new',
    fix: 'Resume it on the worker’s page, or restart the worker.',
  },
  usage_limited: {
    word: 'Paused: Claude usage limit',
    fix: 'It resumes by itself when the limit resets.',
  },
  launcher_unreachable: {
    word: 'Its launcher isn’t answering',
    fix: 'The worker checks again before each claim. On that computer, “docker compose ps” must show the launcher running; “docker compose up -d” starts it.',
  },
  images_missing: {
    word: 'It has no run images',
    fix: 'Its launcher isn’t answering, or the images are still downloading. On that computer, run “docker compose up -d” and let the download finish.',
  },
  images_outdated: {
    word: 'It has an older build than this platform',
    fix: UPDATER_FIX,
  },
  no_eligible_project: {
    word: 'No project gives it work',
    fix: 'An administrator lets workers run a project’s stages in the project’s settings, under Execution; the worker’s page chooses which of those it takes by itself.',
  },
  pick_only: {
    word: 'Takes only runs its owner picks',
    fix: 'Its owner set it to Only what I pick, under What this machine takes on the worker’s page; a run picked there still starts.',
  },
};

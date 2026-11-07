/**
 * **Why a project's work does not go to a worker** (S-23.24) — the project's Execution settings.
 *
 * A module of its own since S-25.13: only lazy screens show these words, and `ui/humanize.ts` —
 * which the SPA's first paint imports — does **not** re-export them, because a re-export would put
 * them back in the initial graph (TD-013's budget, `bundle:check`). Screens import this module.
 */
import type { ProjectExecutionWaiting, ProjectExecutionWorker } from '@platform/contracts';
import type { ClaimBlockerWords } from './worker-blockers.js';

/** Why a project keeps one worker off its runs (S-22.19's `project_reason`). */
export type ProjectWorkerReason = NonNullable<ProjectExecutionWorker['project_reason']>;

/**
 * A project's reason for keeping a worker off its runs, beside the worker's own blockers — the
 * Execution panel's *Who would take this project's work* (S-23.24). Same shape as
 * {@link WORKER_CLAIM_BLOCKER_WORDS}: a short `word` for the line and a `fix`.
 */
export const PROJECT_WORKER_REASON_WORDS: Readonly<Record<ProjectWorkerReason, ClaimBlockerWords>> =
  {
    server_only: {
      word: 'The project runs on the platform server only',
      fix: 'An administrator lets workers run it here, under Who runs this project’s agents.',
    },
    credential_refused: {
      word: 'Its git connection’s token may not go to a developer’s computer',
      fix: 'An administrator allows it on the project’s git connection.',
    },
    role: {
      word: 'Its owner may not run this project’s work',
      fix: 'An administrator gives its owner a role in the organisation that runs agent work.',
    },
    scope_excludes: {
      word: 'It doesn’t take this project by itself: its owner’s choice',
      fix: 'Its owner changes what it takes by itself on the worker’s page; a run picked there still starts.',
    },
  };

/** Why a waiting run may not go to a worker now (S-22.19's `waiting.closed_to_workers`). */
export type WaitingClosedReason = keyof ProjectExecutionWaiting['closed_to_workers'];

/** The end of "N waiting runs can't go to workers: …", per reason (S-23.24). */
export const WAITING_CLOSED_REASON_WORDS: Readonly<Record<WaitingClosedReason, string>> = {
  credential_refused: 'the git connection’s token may not go to a developer’s computer',
  server_only:
    'they were offered to the platform server only (pausing and resuming a task offers its run again)',
  server_first: 'the platform server goes first, and its head start has not ended yet',
};

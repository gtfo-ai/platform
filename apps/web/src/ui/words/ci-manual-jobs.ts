/**
 * **A pipeline's manual jobs nobody started, on the task page** (S-27.2, TD-036) — the CI check's
 * words and Ready's.
 *
 * A module of its own since S-25.13: only lazy screens show these words, and `ui/humanize.ts` —
 * which the SPA's first paint imports — does **not** re-export them, because a re-export would put
 * them back in the initial graph (TD-013's budget, `bundle:check`). Screens import this module.
 */

/**
 * **The CI check's words when a pass left manual jobs nobody started** (S-27.2, TD-036 decision 5):
 * *CI passed — the manual job sentry-release-commit was not run*. Platform words only; the job names
 * between `lead` and `tail` are the provider's and are rendered as untrusted text by the caller.
 */
export const manualNotRunWords = (
  count: number,
): { readonly lead: string; readonly tail: string; readonly links: string } =>
  count === 1
    ? { lead: 'CI passed — the manual job', tail: 'was not run', links: 'Start it on its page:' }
    : {
        lead: 'CI passed — the manual jobs',
        tail: 'were not run',
        links: 'Start them on their pages:',
      };

/**
 * **What Ready says about a pipeline the provider still shows blocked** (S-27.2, TD-036 decision 7):
 * *"GitLab shows pipeline n, the latest for this commit, as blocked at the manual job X. If this
 * project requires pipelines to succeed, GitLab won't merge it until X has run: start it on
 * GitLab."* The platform never says a merge request *can be merged*. Platform words only, around
 * the pipeline id and the job names the caller renders as untrusted text; `provider` is the
 * provider's display name.
 */
export const readyBlockedWords = (
  provider: string,
  count: number,
): {
  readonly shows: string;
  readonly blockedAt: string;
  readonly requires: string;
  readonly start: string;
} => ({
  // The sentence opens with the name: "the git provider" (a provider this build does not name) too.
  shows: `${provider.charAt(0).toUpperCase()}${provider.slice(1)} shows`,
  blockedAt: `, the latest for this commit, as blocked at the manual ${count === 1 ? 'job' : 'jobs'}`,
  requires: `. If this project requires pipelines to succeed, ${provider} won’t merge it until`,
  start: count === 1 ? `has run: start it on ${provider}.` : `have run: start them on ${provider}.`,
});

/** A manual job's three choices in `pipeline.ci.manual_jobs` (S-28.7), as the settings card says them. */
export const MANUAL_JOB_MODE_LABEL = {
  run: 'Start it automatically',
  wait: 'Wait for a person',
  ignore: 'Don’t run, don’t wait',
} as const;

/** What each choice does, under its label. */
export const MANUAL_JOB_MODE_HINT = {
  run: 'The platform starts it when the pipeline holds it, and its result counts: if it fails, CI fails.',
  wait: 'A person starts it in the git host; CI waits for it, and its result counts.',
  ignore:
    'Never started and never counted, even when the git host shows the pipeline blocked at it.',
} as const;

/**
 * **What the platform did about a job set to run** (S-28.7), around the job's name the caller
 * renders as untrusted text; `provider` is the provider's display name.
 *  - started, while CI waits: *Started build_composer for you — waiting for its result.*
 *  - started, afterwards: *The platform started build_composer for you.*
 *  - refused: *Could not start codeception: the platform's GitLab account may not run it. Start it in
 *    GitLab, or give the account permission.*
 *  - unsupported: *Could not start codeception: this GitLab connection cannot start manual jobs.
 *    Start it in GitLab.*
 */
export const manualStartedWords = (
  outcome: 'started' | 'refused' | 'unsupported',
  provider: string,
  waiting: boolean,
): { readonly lead: string; readonly tail: string } => {
  switch (outcome) {
    case 'started':
      return waiting
        ? { lead: 'Started', tail: 'for you — waiting for its result.' }
        : { lead: 'The platform started', tail: 'for you.' };
    case 'refused':
      return {
        lead: 'Could not start',
        tail: `: ${provider === 'the git provider' ? 'the platform’s account on the git provider' : `the platform’s ${provider} account`} may not run it. Start it in ${provider}, or give the account permission.`,
      };
    case 'unsupported':
      return {
        lead: 'Could not start',
        tail: `: this ${provider} connection cannot start manual jobs. Start it in ${provider}.`,
      };
  }
};

/** *nette-tester is manual and not set to run — not run, not counted.* (S-28.7) */
export const MANUAL_NOT_SET_TAIL = 'is manual and not set to run — not run, not counted.';

/** The link a wait on a person offers when the held job has no choice yet (S-28.7). */
export const START_NEXT_TIME = 'Have the platform start it next time';

/** The settings card's anchor, which *Have the platform start it next time* links to (S-28.7). */
export const MANUAL_CI_JOBS_ANCHOR = 'manual-ci-jobs';

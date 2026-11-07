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

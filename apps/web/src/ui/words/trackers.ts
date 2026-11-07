/**
 * **A tracker's name as a person says it** (S-26.8b; its own module since S-25.15 part B), for
 * *Assigned in Jira to …*, *also assigns DEMO-1 in Jira* and the short form *Waiting for: Vojtěch
 * Kaizr’s Jira ticket*. The ticket's `provider` is the binding's provider id (`jira-cloud`), or a
 * fixture's shorter spelling.
 *
 * A module of its own because the short form is drawn on Home's *Needs you*, which the SPA's first
 * paint imports: `./owners.ts`, where the name lived, is a lazy screen's (S-25.13), and importing
 * it from Home would put all of it back in the initial graph (TD-013's budget). It re-exports
 * {@link trackerName}, so its callers are unchanged.
 */
export const TRACKER_NAME: Readonly<Record<string, string>> = {
  'jira-cloud': 'Jira',
  jira: 'Jira',
  gitlab: 'GitLab',
  github: 'GitHub',
  linear: 'Linear',
};

/** The tracker's own name, or `null` for a provider this build does not name (never the raw id). */
export const knownTrackerName = (provider: string): string | null =>
  Object.hasOwn(TRACKER_NAME, provider) ? (TRACKER_NAME[provider] ?? null) : null;

/** The tracker's name in a sentence: *the tracker* for one this build does not name. */
export const trackerName = (provider: string): string =>
  knownTrackerName(provider) ?? 'the tracker';

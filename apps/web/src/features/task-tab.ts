/**
 * The task page's tabs as a search parameter (S-23.9b, research/19 § 5.2 "Task").
 *
 * `?tab=` rather than component state, for `?artifact=`'s reason: a tab is a place a person can
 * send somebody. Both task routes validate it with {@link taskSearchSchema}, and a value that is not
 * one of the four is **dropped** rather than refused (`.catch`), so an old or mistyped link opens the
 * Overview instead of a router error. A module of its own, with no React, because the route tree
 * imports it eagerly while the screen itself is a lazy chunk.
 *
 * `?artifact=<id>` keeps working (WP-52): a link that names an artifact — the ask thread's citation,
 * the flow's *Open artifact* — opens the Artifacts tab on it, whatever `tab` says.
 */
import * as z from 'zod';

export const TASK_TABS = ['overview', 'artifacts', 'runs', 'activity'] as const;

export type TaskTab = (typeof TASK_TABS)[number];

export const TASK_TAB_LABEL: Readonly<Record<TaskTab, string>> = {
  overview: 'Overview',
  artifacts: 'Artifacts',
  runs: 'Runs',
  activity: 'Activity',
};

/**
 * Both task routes' search: `artifact` is compared against the task's own artifact ids (an unknown
 * one opens nothing), `tab` is one of the four or nothing.
 */
export const taskSearchSchema = z.object({
  artifact: z.string().optional(),
  tab: z.enum(TASK_TABS).optional().catch(undefined),
});

export type TaskSearch = z.infer<typeof taskSearchSchema>;

/** The tab the page shows: an artifact the task has selects Artifacts; otherwise `tab`, or Overview. */
export const currentTaskTab = (search: TaskSearch, artifactIds: readonly string[]): TaskTab => {
  if (search.artifact !== undefined && artifactIds.includes(search.artifact)) {
    return 'artifacts';
  }
  return search.tab ?? 'overview';
};

/**
 * The search a tab's link sets: the tab (Overview is the default and is written as no parameter),
 * and the open artifact kept only on the Artifacts tab — otherwise it would select Artifacts again.
 */
export const taskTabSearch = (
  previous: Record<string, unknown>,
  tab: TaskTab,
): Record<string, unknown> => ({
  ...previous,
  tab: tab === 'overview' ? undefined : tab,
  artifact: tab === 'artifacts' ? previous['artifact'] : undefined,
});

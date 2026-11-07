/**
 * **The return loops' words** — the flow canvas's loop pill, the board's loop badge and the task
 * page's return sentences.
 *
 * A module of its own since S-25.13: only lazy screens show these words, and `ui/humanize.ts` —
 * which the SPA's first paint imports — does **not** re-export them, because a re-export would put
 * them back in the initial graph (TD-013's budget, `bundle:check`). Screens import this module.
 */
import type { TaskCiFailure } from '@platform/contracts';
import { titleCase } from './stages.js';

/**
 * The bounded return loops (`tasks.iteration_counters`' keys, the graph edges' `loop`), as the flow
 * canvas's loop pill says them (S-23.5): the rounds a stage may send the task back for, in the
 * plural, because the pill counts them (S-25.5, research/21 § 4). A loop the platform does not ship
 * is title-cased, never printed raw; `humanize.test.ts` holds the table to the domain's
 * `ITERATION_LOOPS`.
 */
export const LOOP_LABEL: Readonly<Record<string, string>> = {
  code_review: 'Review rounds',
  business_review: 'Acceptance rounds',
  ci_fix: 'CI fixes',
  human_rounds: 'Human review rounds',
  refinement_questions: 'Question rounds',
  architecture_revisions: 'Plan revisions',
  rebase: 'Conflict fixes',
  rebase_rechecks: 'Up-to-date re-checks',
  dependency_policy: 'Dependency checks',
};

/**
 * How a CI pipeline that sent a task back ended (S-25.11): `task_stages.signature`'s status, as the
 * task page's return and stop sentences open — "CI failed on the merge request".
 */
export const CI_FAILURE_LABEL: Readonly<Record<TaskCiFailure['status'], string>> = {
  failed: 'CI failed',
  canceled: 'CI was cancelled',
  skipped: 'CI was skipped',
};

/** What a loop is, one hover away (product/10's 2026-11-06 *Plain words* rule). */
export const LOOP_DEFINITION =
  'How many times this step may send the task back before a person is asked to decide.';

export const loopLabel = (slug: string): string =>
  Object.hasOwn(LOOP_LABEL, slug) ? (LOOP_LABEL[slug] as string) : titleCase(slug);

/**
 * What one round of each loop is called on the board's loop badge (S-25.4, product/10's Board
 * amendment: *"Review round 2 of 3"*, never *"Review 2/3"*). A noun in the singular, because the
 * badge counts one round at a time; `humanize.test.ts` holds it to the same domain list as
 * {@link LOOP_LABEL}.
 */
export const LOOP_ROUND_LABEL: Readonly<Record<string, string>> = {
  code_review: 'Review',
  business_review: 'Acceptance',
  ci_fix: 'CI fix',
  human_rounds: 'Human review',
  refinement_questions: 'Question',
  architecture_revisions: 'Plan revision',
  rebase: 'Conflict fix',
  rebase_rechecks: 'Up-to-date re-check',
  dependency_policy: 'Dependency check',
};

/** *Review round 2 of 3*, or *Review round 2* when the loop's limit is not known. */
export const loopRoundLabel = (slug: string, count: number, limit?: number): string => {
  const noun = Object.hasOwn(LOOP_ROUND_LABEL, slug)
    ? (LOOP_ROUND_LABEL[slug] as string)
    : titleCase(slug);
  return `${noun} round ${count}${limit === undefined ? '' : ` of ${limit}`}`;
};

/** 1 → "1st", 2 → "2nd", 11 → "11th", 23 → "23rd". */
export const ordinal = (value: number): string => {
  const tens = value % 100;
  const suffix =
    tens >= 11 && tens <= 13
      ? 'th'
      : value % 10 === 1
        ? 'st'
        : value % 10 === 2
          ? 'nd'
          : value % 10 === 3
            ? 'rd'
            : 'th';
  return `${value}${suffix}`;
};

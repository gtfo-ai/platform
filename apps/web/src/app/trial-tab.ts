/**
 * When a project's *Trial* tab is shown (S-25.7, product/10's 2026-11-06 IA amendment, Q-UX-3):
 * *"Its tab appears only before the project's first live task or while a trial exists; otherwise it
 * lives under project Settings."* Plain data and no React, so the frame (in the initial graph)
 * imports it at no cost, and the rule is asserted on its own (`trial-tab.test.ts`).
 *
 * - A **live task** is a task the pipeline runs for real: `mode: 'normal'` and a ticket a provider
 *   knows. A trial's own tasks are `mode: 'shadow'`, and a discovery is one of the platform's
 *   one-off tasks (ticket provider `platform`) — neither is the project going live.
 * - **A trial exists** while the project has any trial (shadow batch) on record, running or
 *   finished: its report is what a person comes back to read.
 * - The tab is also shown while it is the **current** page, reached from Settings, so the row
 *   always marks where the reader is.
 *
 * Read off the board's first page of tasks (newest first), which the frame already holds. A page
 * with no live task whose older pages hold one shows the tab when it should not only if the whole
 * page is trial or platform tasks — and a page of trial tasks means a trial exists, which shows it
 * anyway. Until the reads answer, the tab is not drawn: one appearing is less jarring than one
 * vanishing.
 */

/** A ticket a provider knows — not one of the platform's own one-off tasks (`home-setup.ts`). */
const PLATFORM_TICKET_PROVIDER = 'platform';

export interface TrialTabFacts {
  /** The board's first page of tasks; `undefined` until it answers. */
  readonly tasks:
    | readonly { readonly mode: string; readonly ticket: { readonly provider: string } }[]
    | undefined;
  /** How many trials the project has; `undefined` until (or unless) that read answers. */
  readonly trials: number | undefined;
  /** The Trial page is the one being shown. */
  readonly current: boolean;
}

/** Whether `task` is the project going live: a real ticket, run for real. */
export const isLiveTask = (task: {
  readonly mode: string;
  readonly ticket: { readonly provider: string };
}): boolean => task.mode === 'normal' && task.ticket.provider !== PLATFORM_TICKET_PROVIDER;

/** Whether the trials read is needed to decide: only once a live task exists. */
export const needsTrialCount = (tasks: TrialTabFacts['tasks']): boolean =>
  tasks?.some(isLiveTask) === true;

export const trialTabShown = ({ tasks, trials, current }: TrialTabFacts): boolean => {
  if (current) {
    return true;
  }
  if (tasks === undefined) {
    return false;
  }
  if (!tasks.some(isLiveTask)) {
    return true;
  }
  return trials !== undefined && trials > 0;
};

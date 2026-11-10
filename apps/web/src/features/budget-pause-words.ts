/**
 * **A budget pause, in numbers** (S-28.1, M28 rulings 1–3): what the admission compared, why the run
 * did not start, and the cap that lets it — never *"it has spent its cap"* for a task that has not.
 *
 * AUT-6655 on Autix: a task at $10.99 of a $50.00 cap paused before Implementation because that
 * stage reserves up to $40.00 per run, and the page said *"It has spent its cap of $50.00"* beside
 * *"Cost so far $10.99"*. The owner raised the cap to 51, 52, 53 and 54, each accepted and each
 * paused again two seconds later. These sentences say the arithmetic (the read's
 * `paused_budget_figures`), the minimum, and that the reserve is a ceiling, not spend. A pause
 * recorded without figures says what is known and invents none.
 *
 * Pure and dependency-free (`formatUsd` aside), so the callout and the raise dialog share one set of
 * words.
 */
import type { PausedBudgetFigures, TaskRecord } from '@platform/contracts';
import { formatUsd } from '../ui/kit.js';
import { stageLabel } from '../ui/words/stages.js';

/** Up to the next cent, so a figure the page names as *at least* is never a hair below the minimum. */
export const upToCents = (usd: number): number =>
  Math.ceil(Number((usd * 100).toFixed(6)) - 1e-9) / 100;

/** The smallest cap the server admits, in cents — what *at least $…* says. */
export const minimumCapUsd = (figures: PausedBudgetFigures): number =>
  upToCents(figures.required_cap_usd);

/**
 * The raise dialog's pre-filled figure (M28 ruling 2): the minimum, rounded up to a whole dollar —
 * a sensible step a person reads at a glance, and never below what the server admits.
 */
export const suggestedCapUsd = (figures: PausedBudgetFigures): number =>
  Math.ceil(minimumCapUsd(figures) - 1e-9);

/** By how much the next run would exceed `capUsd`, in cents. */
const overByUsd = (figures: PausedBudgetFigures, capUsd: number): number =>
  upToCents(Math.max(0, figures.required_cap_usd - capUsd));

/** "1 run" / "3 runs". */
const runsWord = (count: number): string => `${count} ${count === 1 ? 'run' : 'runs'}`;

/**
 * ", with $15.00 held for 1 run nobody measured" — or nothing, when nothing is held (BD-010's
 * 2026-11-10 amendment, decision 2: the hold **with its count**). For a `budgets` row or a feature
 * cap the hold also covers runs still going, which the count does not.
 */
const heldWords = (figures: PausedBudgetFigures, taskCap: boolean): string => {
  if (figures.held_usd <= 0) return '';
  const held = formatUsd(figures.held_usd);
  if (taskCap) {
    return figures.held_runs > 0
      ? `, with ${held} held for ${runsWord(figures.held_runs)} nobody measured`
      : `, with ${held} held`;
  }
  return figures.held_runs > 0
    ? `, with ${held} held for runs still going and ${runsWord(figures.held_runs)} nobody measured`
    : `, with ${held} held for runs still going`;
};

/** A budget name at the start of a sentence: its first letter upper-cased. */
const capitalise = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** Which budget a scope names, in words — the subject of the non-task sentences. */
const BUDGET_NAME: Readonly<Record<string, string>> = {
  project: 'the project’s budget',
  organization: 'the organisation’s budget',
  shadow: 'the project’s shadow-mode budget for the month',
  maintenance: 'the project’s maintenance budget for the month',
  bootstrap: 'this history bootstrap’s budget',
};

/**
 * The callout's sentence for a budget pause (M28 ruling 3). For the task's own cap: where it stopped,
 * the spend against the cap, what the next run reserves, by how much it would exceed the cap, the
 * minimum, and that the task then continues where it is — finished stages are not redone.
 */
export const budgetPauseSentence = (
  task: Pick<TaskRecord, 'paused_budget_scope' | 'paused_budget_figures' | 'budget_cap_usd'>,
  canRaise: boolean,
): string => {
  const figures = task.paused_budget_figures;
  const scope = task.paused_budget_scope;
  if (scope === 'task') {
    if (figures === null) {
      // A pause recorded before its figures were: say the rule, not a spend it may not have made.
      return (
        `Its next run did not fit under its cap of ${formatUsd(task.budget_cap_usd)}: what it has spent ` +
        'plus what that run may spend is above it. ' +
        (canRaise
          ? 'Raise the cap and it continues at the stage it stopped at; finished stages are not redone.'
          : 'A person who may change budgets can raise it.')
      );
    }
    const stage = stageLabel(figures.stage);
    const minimum = formatUsd(minimumCapUsd(figures));
    // The live cap, not the one the pause recorded: a raise that was not followed by a resume.
    const cap = task.budget_cap_usd;
    if (cap + 1e-9 >= figures.required_cap_usd) {
      return (
        `Paused before starting ${stage}. Its cap is now ${formatUsd(cap)}, enough for the next run ` +
        `(at least ${minimum}). Resume it and it continues at ${stage}; finished stages are not redone.`
      );
    }
    // "Spent its cap" only when it has (BD-010's 2026-11-10 amendment, decision 2).
    const spent =
      figures.spent_usd >= cap
        ? `it has spent its cap: ${formatUsd(figures.spent_usd)} of ${formatUsd(cap)}`
        : `spent ${formatUsd(figures.spent_usd)} of the ${formatUsd(cap)} cap`;
    return (
      `Paused before starting ${stage}: ${spent}${heldWords(figures, true)}; the next ` +
      `run reserves up to ${formatUsd(figures.reserve_usd)}, which would exceed the cap by ` +
      `${formatUsd(overByUsd(figures, cap))}. ` +
      (canRaise
        ? `Raise the cap to at least ${minimum} — the task then continues at ${stage}; finished stages are not redone.`
        : `A person who may change budgets can raise the cap to at least ${minimum} — the task then continues at ${stage}; finished stages are not redone.`)
    );
  }
  if (scope === 'run') {
    return 'Its last run reached the most one run of this stage may spend, and stopped there. Resume it to run the stage again, or raise that stage’s run budget in the project’s settings.';
  }
  const name = scope === null ? null : (BUDGET_NAME[scope] ?? null);
  if (name === null) {
    return 'A budget it counts against cannot take its next run.';
  }
  if (figures === null) {
    return `${capitalise(name)} cannot take its next run. It continues once that budget is raised, where that cap is set.`;
  }
  // A refusal at the claim asks with a reserve of 0 (the run's own reservation is already in the
  // held figure), so there is no "next run reserves" to name: what is committed exceeds the cap.
  const excess =
    figures.reserve_usd > 0
      ? `the next run reserves up to ${formatUsd(figures.reserve_usd)}, which would exceed it by ` +
        formatUsd(overByUsd(figures, figures.cap_usd))
      : `what is already committed exceeds it by ${formatUsd(overByUsd(figures, figures.cap_usd))}`;
  return (
    `Paused before starting ${stageLabel(figures.stage)}: ${name} has ` +
    `${formatUsd(figures.spent_usd)} spent of ${formatUsd(figures.cap_usd)}` +
    `${heldWords(figures, false)}; ${excess}. ` +
    `It continues once that budget is raised to at least ${formatUsd(minimumCapUsd(figures))}, ` +
    'where that cap is set.'
  );
};

/**
 * The raise dialog's explanation (M28 ruling 2): *"Spent $10.99. The next Implementation run
 * reserves up to $40.00 — a ceiling, not spend: unused reserve is returned. The cap must be at least
 * $50.99 for the task to continue."*
 */
export const raiseExplanation = (figures: PausedBudgetFigures): string => {
  const stage = stageLabel(figures.stage);
  return (
    `Spent ${formatUsd(figures.spent_usd)}` +
    (figures.held_usd > 0
      ? `, and ${formatUsd(figures.held_usd)} is held for ${runsWord(figures.held_runs)} nobody measured`
      : '') +
    `. The next ${stage} run reserves up to ${formatUsd(figures.reserve_usd)} — ` +
    'a ceiling, not spend: unused reserve is returned. The cap must be at least ' +
    `${formatUsd(minimumCapUsd(figures))} for the task to continue. ` +
    // BD-010's residual: the reserve is the stage's per-run cap, and the pause names that lever.
    `A project that wants a smaller reserve lowers ${stage}’s run budget in its configuration.`
  );
};

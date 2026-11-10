/**
 * **A budget pause in numbers** (S-28.1, M28 rulings 1–3) — the words the callout and the raise
 * dialog share. AUT-6655's page said "It has spent its cap of $50.00" beside "Cost so far $10.99";
 * these hold the arithmetic sentence, the minimum's rounding and the rule that **no** wording of a
 * budget pause says "spent its cap", whichever cap and whether or not the figures were recorded.
 */
import type { PausedBudgetFigures, PausedBudgetScope } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import {
  budgetPauseSentence,
  minimumCapUsd,
  raiseExplanation,
  suggestedCapUsd,
} from './budget-pause-words.js';

const AUT_6655: PausedBudgetFigures = {
  stage: 'implementation',
  spent_usd: 10.99,
  held_usd: 0,
  held_runs: 0,
  reserve_usd: 40,
  cap_usd: 50,
  required_cap_usd: 50.99,
};

const SCOPES: readonly (PausedBudgetScope | null)[] = [
  'task',
  'organization',
  'project',
  'shadow',
  'maintenance',
  'bootstrap',
  'run',
  null,
];

describe('budget pause words (S-28.1)', () => {
  it('says the task cap’s arithmetic as M28 ruling 3 words it', () => {
    expect(
      budgetPauseSentence(
        { paused_budget_scope: 'task', paused_budget_figures: AUT_6655, budget_cap_usd: 50 },
        true,
      ),
    ).toBe(
      'Paused before starting Implementation: spent $10.99 of the $50.00 cap; the next run reserves up to $40.00, which would exceed the cap by $0.99. Raise the cap to at least $50.99 — the task then continues at Implementation; finished stages are not redone.',
    );
  });

  it('names a hold apart from the spend, and who raises it for a reader who may not', () => {
    const sentence = budgetPauseSentence(
      {
        paused_budget_scope: 'task',
        paused_budget_figures: { ...AUT_6655, held_usd: 15, held_runs: 1, required_cap_usd: 65.99 },
        budget_cap_usd: 50,
      },
      false,
    );
    expect(sentence).toContain(
      'spent $10.99 of the $50.00 cap, with $15.00 held for runs nobody measured;',
    );
    expect(sentence).toContain('which would exceed the cap by $15.99.');
    expect(sentence).toContain(
      'A person who may change budgets can raise the cap to at least $65.99',
    );
  });

  it('says the count of runs nobody measured in the dialog too (BD-010 2026-11-10, decision 2)', () => {
    expect(
      raiseExplanation({ ...AUT_6655, held_usd: 30, held_runs: 2, required_cap_usd: 80.99 }),
    ).toContain('Spent $10.99, and $30.00 is held for 2 runs nobody measured.');
  });

  it('reads the live cap after a raise that was not followed by a resume', () => {
    expect(
      budgetPauseSentence(
        { paused_budget_scope: 'task', paused_budget_figures: AUT_6655, budget_cap_usd: 51 },
        true,
      ),
    ).toBe(
      'Paused before starting Implementation. Its cap is now $51.00, enough for the next run (at least $50.99). Resume it and it continues at Implementation; finished stages are not redone.',
    );
    // A raise that is still short says the shortfall against the live cap, not the recorded one.
    expect(
      budgetPauseSentence(
        {
          paused_budget_scope: 'task',
          paused_budget_figures: { ...AUT_6655, required_cap_usd: 60 },
          budget_cap_usd: 55,
        },
        true,
      ),
    ).toContain('which would exceed the cap by $5.00');
  });

  it('says "spent its cap" only when the spend reached the cap', () => {
    expect(
      budgetPauseSentence(
        {
          paused_budget_scope: 'task',
          paused_budget_figures: { ...AUT_6655, spent_usd: 52, required_cap_usd: 92 },
          budget_cap_usd: 50,
        },
        true,
      ),
    ).toContain('it has spent its cap: $52.00 of $50.00');
  });

  it('says what is committed when a claim-time refusal reserved nothing more', () => {
    const sentence = budgetPauseSentence(
      {
        paused_budget_scope: 'organization',
        paused_budget_figures: {
          stage: 'implementation',
          spent_usd: 90,
          held_usd: 15,
          held_runs: 0,
          reserve_usd: 0,
          cap_usd: 100,
          required_cap_usd: 105,
        },
        budget_cap_usd: 50,
      },
      true,
    );
    expect(sentence).toContain('what is already committed exceeds it by $5.00');
    expect(sentence).not.toContain('reserves up to $0.00');
  });

  it('says a project’s figures too, raised where that cap is set', () => {
    expect(
      budgetPauseSentence(
        {
          paused_budget_scope: 'project',
          paused_budget_figures: {
            ...AUT_6655,
            cap_usd: 100,
            spent_usd: 61,
            required_cap_usd: 101,
          },
          budget_cap_usd: 50,
        },
        true,
      ),
    ).toBe(
      'Paused before starting Implementation: the project’s budget has $61.00 spent of $100.00; the next run reserves up to $40.00, which would exceed it by $1.00. It continues once that budget is raised to at least $101.00, where that cap is set.',
    );
  });

  /** M28 ruling 3: no surface says "spent its cap" when it has not — every scope, with and without figures. */
  it.each(SCOPES)('never says “spent its cap” for a %s pause that has not spent it', (scope) => {
    for (const figures of [AUT_6655, null]) {
      for (const canRaise of [true, false]) {
        const sentence = budgetPauseSentence(
          { paused_budget_scope: scope, paused_budget_figures: figures, budget_cap_usd: 50 },
          canRaise,
        );
        expect(sentence).not.toMatch(/spent its (cap|budget)/);
      }
    }
  });

  it('rounds the minimum up to the cent and the suggestion up to the dollar, never below', () => {
    expect(minimumCapUsd(AUT_6655)).toBe(50.99);
    expect(suggestedCapUsd(AUT_6655)).toBe(51);
    // A minimum past a cent by a millionth is the next cent, never the cent below it.
    expect(minimumCapUsd({ ...AUT_6655, required_cap_usd: 50.990001 })).toBe(51);
    // A whole-dollar minimum is offered as itself.
    expect(suggestedCapUsd({ ...AUT_6655, required_cap_usd: 30 })).toBe(30);
  });

  it('explains the reserve as a ceiling, not spend (M28 ruling 2)', () => {
    expect(raiseExplanation(AUT_6655)).toBe(
      'Spent $10.99. The next Implementation run reserves up to $40.00 — a ceiling, not spend: unused reserve is returned. The cap must be at least $50.99 for the task to continue. A project that wants a smaller reserve lowers Implementation’s run budget in its configuration.',
    );
  });
});

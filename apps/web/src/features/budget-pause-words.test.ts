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
        paused_budget_figures: { ...AUT_6655, held_usd: 15, required_cap_usd: 65.99 },
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
  it.each(SCOPES)('never says “spent its cap” for a %s pause', (scope) => {
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
      'Spent $10.99. The next Implementation run reserves up to $40.00 — a ceiling, not spend: unused reserve is returned. The cap must be at least $50.99 for the task to continue.',
    );
  });
});

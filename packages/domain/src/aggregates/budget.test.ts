import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type Clock, fixedClock } from '../clock.js';
import { PolicyViolationError } from '../errors.js';
import type { CommandContext } from '../events.js';
import { type IdSource, sequentialIds } from '../ids.js';
import {
  type Budget,
  createBudget,
  DEFAULT_NOTIFY_PCT,
  isExhausted,
  percentSpent,
  recordSpend,
  resetWindow,
  roundUsd,
  toBudgetRecord,
} from './budget.js';

const BUDGET_ID = '00000000-0000-4000-8000-0000000000b1';
const PROJECT_ID = '00000000-0000-4000-8000-0000000000bb';

const world = (): { ids: IdSource; clock: Clock } => ({
  ids: sequentialIds(),
  clock: fixedClock('2026-09-09T09:00:00.000Z', 1_000),
});

const context = (shared: { ids: IdSource; clock: Clock }): CommandContext => ({
  ids: shared.ids,
  actor: { kind: 'system', component: 'budget-projector' },
  clock: shared.clock,
});

const projectBudget = (limitUsd = 100): Budget =>
  createBudget({
    id: BUDGET_ID,
    scope: 'project',
    scopeId: PROJECT_ID,
    projectId: PROJECT_ID,
    window: 'month',
    limitUsd,
    windowStart: '2026-09-01T00:00:00.000Z',
  });

/** Folds a list of costs through the aggregate, returning the final budget and every event. */
const spend = (budget: Budget, amounts: readonly number[], shared = world()) => {
  let current = budget;
  const events = [];
  for (const usd of amounts) {
    const decision = recordSpend(current, { usd }, context(shared));
    current = decision.aggregate;
    events.push(...decision.events);
  }
  return { budget: current, events };
};

describe('createBudget', () => {
  it('uses the documented notification thresholds', () => {
    expect([...DEFAULT_NOTIFY_PCT]).toEqual([50, 80]);
    expect(projectBudget().notifyPct).toEqual([50, 80]);
    expect(projectBudget().spentUsd).toBe(0);
  });

  it('sorts custom thresholds so they fire in order', () => {
    const budget = createBudget({
      id: BUDGET_ID,
      scope: 'org',
      window: 'day',
      limitUsd: 10,
      notifyPct: [90, 25, 50],
    });
    expect(budget.notifyPct).toEqual([25, 50, 90]);
    expect(budget.scopeId).toBeNull();
    expect(budget.projectId).toBeNull();
  });

  it('refuses a negative or non-finite limit', () => {
    expect(() =>
      createBudget({ id: BUDGET_ID, scope: 'task', window: 'total', limitUsd: -1 }),
    ).toThrow(PolicyViolationError);
    expect(() =>
      createBudget({ id: BUDGET_ID, scope: 'task', window: 'total', limitUsd: Number.NaN }),
    ).toThrow(PolicyViolationError);
  });

  it('maps onto the wire record', () => {
    expect(toBudgetRecord(projectBudget())).toEqual({
      id: BUDGET_ID,
      scope: 'project',
      scope_id: PROJECT_ID,
      window: 'month',
      limit_usd: 100,
      notify_pct: [50, 80],
      spent_usd: 0,
      window_start: '2026-09-01T00:00:00.000Z',
    });
  });
});

describe('recordSpend', () => {
  it('notifies each threshold exactly once per window', () => {
    const { budget, events } = spend(projectBudget(), [40, 15, 20, 5, 10]);
    expect(budget.spentUsd).toBe(90);
    const thresholds = events.filter((event) => event.type === 'budget.threshold.reached');
    expect(thresholds.map((event) => (event.payload as { pct: number }).pct)).toEqual([50, 80]);
    expect(events.filter((event) => event.type === 'budget.exhausted')).toHaveLength(0);
  });

  it('emits both thresholds at once when one entry jumps past them', () => {
    const { events } = spend(projectBudget(), [85]);
    expect(events.map((event) => event.type)).toEqual([
      'budget.threshold.reached',
      'budget.threshold.reached',
    ]);
  });

  it('exhausts once, then keeps recording (running runs finish — BD-010)', () => {
    const { budget, events } = spend(projectBudget(), [100, 30]);
    expect(isExhausted(budget)).toBe(true);
    expect(budget.spentUsd).toBe(130);
    expect(events.filter((event) => event.type === 'budget.exhausted')).toHaveLength(1);
  });

  it('treats a zero limit as exhausted from the first entry', () => {
    const zero = createBudget({ id: BUDGET_ID, scope: 'run', window: 'total', limitUsd: 0 });
    expect(percentSpent(zero)).toBe(100);
    const { events } = spend(zero, [0]);
    expect(events.map((event) => event.type)).toEqual([
      'budget.threshold.reached',
      'budget.threshold.reached',
      'budget.exhausted',
    ]);
  });

  it('refuses a negative or non-finite cost entry', () => {
    const shared = world();
    expect(() => recordSpend(projectBudget(), { usd: -1 }, context(shared))).toThrow(
      PolicyViolationError,
    );
    expect(() =>
      recordSpend(projectBudget(), { usd: Number.POSITIVE_INFINITY }, context(shared)),
    ).toThrow(PolicyViolationError);
  });

  it('carries the scope on every event, for the dashboards', () => {
    const { events } = spend(projectBudget(), [60]);
    expect(events[0]?.payload).toMatchObject({
      project_id: PROJECT_ID,
      scope: 'project',
      scope_id: PROJECT_ID,
      window: 'month',
      limit_usd: 100,
    });
    expect(events[0]?.stream_type).toBe('budget');
  });
});

describe('resetWindow', () => {
  it('clears the spend and the notifications so they fire again', () => {
    const shared = world();
    const spent = spend(projectBudget(), [90], shared).budget;
    const reset = resetWindow(spent, { windowStart: '2026-10-01T00:00:00.000Z' }, context(shared));
    expect(reset.aggregate.spentUsd).toBe(0);
    expect(reset.aggregate.notifiedPct).toEqual([]);
    expect(reset.aggregate.exhaustedNotified).toBe(false);
    expect(reset.aggregate.windowStart).toBe('2026-10-01T00:00:00.000Z');
    expect(reset.events.map((event) => event.type)).toEqual(['budget.reset']);

    const again = spend(reset.aggregate, [90], shared);
    expect(again.events.filter((event) => event.type === 'budget.threshold.reached')).toHaveLength(
      2,
    );
  });
});

describe('budget properties', () => {
  const cost = fc.double({ min: 0, max: 40, noNaN: true, noDefaultInfinity: true });

  it('never notifies a threshold twice, whatever the order of cost entries', () => {
    fc.assert(
      fc.property(fc.array(cost, { maxLength: 20 }), (amounts) => {
        const { events } = spend(projectBudget(), amounts);
        const pcts = events
          .filter((event) => event.type === 'budget.threshold.reached')
          .map((event) => (event.payload as { pct: number }).pct);
        expect(new Set(pcts).size).toBe(pcts.length);
        expect(
          events.filter((event) => event.type === 'budget.exhausted').length,
        ).toBeLessThanOrEqual(1);
      }),
    );
  });

  it('keeps spend equal to the sum of the entries, rounded as the database stores it', () => {
    fc.assert(
      fc.property(fc.array(cost, { maxLength: 20 }), (amounts) => {
        const { budget } = spend(projectBudget(), amounts);
        const expected = amounts.reduce((total, usd) => roundUsd(total + usd), 0);
        expect(budget.spentUsd).toBe(expected);
        expect(budget.spentUsd).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  it('emits `budget.exhausted` exactly when the limit is reached', () => {
    fc.assert(
      fc.property(fc.array(cost, { maxLength: 20 }), (amounts) => {
        const { budget, events } = spend(projectBudget(), amounts);
        const exhausted = events.some((event) => event.type === 'budget.exhausted');
        expect(exhausted).toBe(isExhausted(budget));
      }),
    );
  });
});

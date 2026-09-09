import { describe, expect, it } from 'vitest';
import { type Budget, createBudget } from '../aggregates/budget.js';
import { PolicyViolationError } from '../errors.js';
import {
  assertRunMayStart,
  blockingBudget,
  DEFAULT_STAGE_RUN_BUDGET_USD,
  DEFAULT_TASK_BUDGET_USD,
  resolveRunCapUsd,
  shouldPauseTaskForBudget,
} from './budgets.js';

const budget = (
  id: string,
  limitUsd: number,
  spentUsd: number,
  scope: Budget['scope'],
): Budget => ({
  ...createBudget({ id, scope, window: 'month', limitUsd }),
  spentUsd,
});

const ORG = '00000000-0000-4000-8000-000000000001';
const PROJECT = '00000000-0000-4000-8000-000000000002';
const TASK = '00000000-0000-4000-8000-000000000003';

describe('documented defaults', () => {
  it('keeps the task cap and the per-stage caps of product/04 and product/09', () => {
    expect(DEFAULT_TASK_BUDGET_USD).toBe(50);
    expect(DEFAULT_STAGE_RUN_BUDGET_USD).toEqual({
      intake: 0.1,
      refinement: 2,
      investigation: 5,
      architecture: 5,
      implementation: 15,
      code_review: 5,
      business_review: 3,
      retrospective: 2,
      librarian: 2,
    });
  });
});

describe('blockingBudget', () => {
  it('finds nothing while every budget has room', () => {
    expect(
      blockingBudget([budget(ORG, 100, 20, 'org'), budget(PROJECT, 50, 49.999999, 'project')]),
    ).toBeNull();
  });

  it('reports the first exhausted budget in the order it was given', () => {
    const org = budget(ORG, 100, 100, 'org');
    const project = budget(PROJECT, 50, 50, 'project');
    expect(blockingBudget([org, project])).toBe(org);
    expect(blockingBudget([project, org])).toBe(project);
  });

  it('blocks at the limit, not past it', () => {
    expect(blockingBudget([budget(TASK, 10, 10, 'task')])).not.toBeNull();
    expect(blockingBudget([budget(TASK, 10, 9.999999, 'task')])).toBeNull();
  });

  it('has a guard form that names the scope and the numbers', () => {
    expect(() => assertRunMayStart([budget(ORG, 100, 20, 'org')])).not.toThrow();
    try {
      assertRunMayStart([budget(PROJECT, 50, 60, 'project')]);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyViolationError);
      const violation = error as PolicyViolationError;
      expect(violation.policy).toBe('budget.exhausted');
      expect(violation.message).toContain('project budget');
      expect(violation.message).toContain('60 of 50 USD');
    }
  });
});

describe('resolveRunCapUsd', () => {
  it('prefers the configured cap', () => {
    expect(resolveRunCapUsd('implementation', 30)).toBe(30);
  });

  it('falls back to the stage default', () => {
    expect(resolveRunCapUsd('implementation')).toBe(15);
  });

  it('leaves an unlisted custom stage uncapped', () => {
    expect(resolveRunCapUsd('security_scan')).toBeNull();
  });
});

describe('shouldPauseTaskForBudget', () => {
  it('pauses the task when its own cap is reached (product/09)', () => {
    expect(shouldPauseTaskForBudget(budget(TASK, 50, 50, 'task'))).toBe(true);
    expect(shouldPauseTaskForBudget(budget(TASK, 50, 10, 'task'))).toBe(false);
    expect(shouldPauseTaskForBudget(null)).toBe(false);
  });
});

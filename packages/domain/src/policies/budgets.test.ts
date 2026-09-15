import {
  BOOTSTRAP_BATCH_SIZE,
  DEFAULT_BOOTSTRAP_BUDGET_USD,
  DEFAULT_BOOTSTRAP_MERGE_REQUESTS,
} from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { type Budget, createBudget } from '../aggregates/budget.js';
import { PolicyViolationError } from '../errors.js';
import {
  assertRunMayStart,
  blockingBudget,
  DEFAULT_STAGE_RUN_BUDGET_USD,
  DEFAULT_TASK_BUDGET_USD,
  estimateHistoryBootstrap,
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
      // product/06 § "Step 2": the Discovery agent is cheap and bounded (WP-21).
      discovery: 2,
      // product/19 § 12 prices a lint at ~$0.10 per ticket; the cap is five times it (WP-25).
      ticket_lint: 0.5,
      // product/04 S6b's "short Implementation run": a third of `implementation`'s cap (WP-26).
      conflict_resolution: 5,
      // product/19 §18's Sonnet mining run, and the figure product/19's $20 default rests on (WP-35).
      history_mining: 2,
    });
  });
});

describe('estimateHistoryBootstrap', () => {
  it('derives product/19 §18’s own $20 default from N, the batch size and the per-run cap', () => {
    // The arithmetic the document's two numbers meet in: 200 merge requests at 20 per run is ten
    // runs, and a Sonnet stage's cap here is $2. If either constant moves, this fails rather than
    // the wizard quietly showing a figure that no longer matches the cap it is compared with.
    const estimate = estimateHistoryBootstrap({
      mergeRequests: DEFAULT_BOOTSTRAP_MERGE_REQUESTS,
      batchSize: BOOTSTRAP_BATCH_SIZE,
      capUsd: DEFAULT_BOOTSTRAP_BUDGET_USD,
      runBudgetUsd: DEFAULT_STAGE_RUN_BUDGET_USD.history_mining as number,
    });
    expect(estimate.batches).toBe(10);
    expect(estimate.estimatedUsd).toBe(DEFAULT_BOOTSTRAP_BUDGET_USD);
    // Equal is **not** over: a batch whose estimate is exactly the cap runs to the end.
    expect(estimate.stopsAtCap).toBe(false);
  });

  it('rounds a partial batch up, because nineteen merge requests still cost a run', () => {
    const estimate = estimateHistoryBootstrap({
      mergeRequests: 21,
      batchSize: 20,
      capUsd: 20,
      runBudgetUsd: 2,
    });
    expect(estimate.batches).toBe(2);
    expect(estimate.estimatedUsd).toBe(4);
  });

  it('says so in advance when the estimate is above the cap, rather than refusing', () => {
    // The direction product/19 asks for: the batch still starts and stops when the cap is spent, so
    // the operator is told before the fact instead of finding out from a paused task.
    const estimate = estimateHistoryBootstrap({
      mergeRequests: 1000,
      batchSize: 20,
      capUsd: 20,
      runBudgetUsd: 2,
    });
    expect(estimate.batches).toBe(50);
    expect(estimate.estimatedUsd).toBe(100);
    expect(estimate.stopsAtCap).toBe(true);
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

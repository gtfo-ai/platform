/**
 * The stage executor's endings.
 *
 * The happy one is asserted by `saga.test.ts`, which walks a whole template through it. These are
 * the ones a template never reaches by itself: a run that overspends, a run whose cost the platform
 * could not read, a run that produced no artifact, and a job that arrives after the task has moved.
 */
import type { DomainEvent } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import {
  createPipelineHarness,
  type HarnessOptions,
  type PipelineHarness,
} from '../testing/pipeline-harness.js';
import { COST_UNREPORTED, runBudgetUsd, taskBudgetExhausted } from './stage-executor.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1';

const ticketMatched = (): DomainEvent =>
  domainEventSchemasByType['ticket.matched'].parse({
    id: '00000000-0000-4000-9000-000000000001',
    stream_type: 'project',
    stream_id: PROJECT,
    stream_seq: 1,
    correlation_id: null,
    cause_event_id: null,
    actor: { kind: 'integration', integration_id: PROJECT, provider: 'fake-jira' },
    occurred_at: '2026-06-01T09:00:00.000Z',
    type: 'ticket.matched',
    payload: {
      project_id: PROJECT,
      ticket: {
        provider: 'fake-jira',
        key: 'ACME-1',
        url: 'https://jira.example.test/browse/ACME-1',
      },
      rule: 'label:agentic',
      priority: null,
      issue_type: 'Story',
      epic: null,
      links: [],
    },
  }) as DomainEvent;

const harnessWith = (options: HarnessOptions): PipelineHarness =>
  createPipelineHarness({ projectId: PROJECT, ...options });

const taskOf = (harness: PipelineHarness) => {
  const [stored] = harness.store.snapshot();
  if (stored === undefined) {
    throw new Error('no task was created');
  }
  return stored;
};

const escalationOf = (harness: PipelineHarness) =>
  harness.events().find((entry) => entry.type === 'task.escalated') as
    | Extract<DomainEvent, { type: 'task.escalated' }>
    | undefined;

describe('a run the platform stopped', () => {
  it('pauses the task when the run really did overspend', async () => {
    const harness = harnessWith({
      runs: {
        refinement: {
          status: 'budget_exceeded',
          terminalReason: 'error_max_budget_usd',
          costUsd: 2.5,
          error: 'the platform stopped the run: budget_exceeded',
        },
      },
    });
    await harness.publish([ticketMatched()]);

    const task = taskOf(harness);
    expect(task.task.state).toBe('paused');
    expect(harness.types()).toContain('task.paused');
    // The spend is real, so it is counted.
    expect(task.costActualUsd).toBeCloseTo(2.5, 6);
    expect(escalationOf(harness)).toBeUndefined();
  });

  it('escalates when the platform could not tell what the run cost', async () => {
    // WP-12 publishes this fault *as* `budget_exceeded` / `error_max_budget_usd`, because the
    // terminal-reason enum has no name for it. Branching on the status alone would pause the task
    // and tell a human to raise a cap that was never reached.
    const harness = harnessWith({
      runs: {
        refinement: {
          status: 'budget_exceeded',
          terminalReason: 'error_max_budget_usd',
          costUsd: 0,
          stopReason: COST_UNREPORTED,
          error: 'the platform stopped the run: cost_unreported — …',
        },
      },
    });
    await harness.publish([ticketMatched()]);

    const task = taskOf(harness);
    expect(task.task.state).toBe('needs_human');
    expect(harness.types()).not.toContain('task.paused');
    const escalation = escalationOf(harness);
    expect(escalation?.payload.reason).toContain('could not tell what the run cost');
  });

  it('tells the two apart by the transcript row, not by the status', async () => {
    // Rule 10 as an experiment: the only difference between these two harnesses is the
    // `run_stopped` row, and the endings differ.
    const spec = {
      status: 'budget_exceeded' as const,
      terminalReason: 'error_max_budget_usd' as const,
      costUsd: 1,
    };
    const overspent = harnessWith({ runs: { refinement: spec } });
    const blind = harnessWith({ runs: { refinement: { ...spec, stopReason: COST_UNREPORTED } } });
    await overspent.publish([ticketMatched()]);
    await blind.publish([ticketMatched()]);
    expect(taskOf(overspent).task.state).toBe('paused');
    expect(taskOf(blind).task.state).toBe('needs_human');
  });

  it('escalates a run that failed, and does not retry it', async () => {
    const harness = harnessWith({
      runs: {
        refinement: {
          status: 'failed',
          terminalReason: 'error_during_execution',
          error: 'the CLI exited with 1',
        },
      },
    });
    await harness.publish([ticketMatched()]);
    expect(taskOf(harness).task.state).toBe('needs_human');
    expect(harness.specs).toHaveLength(1);
    expect(harness.types()).toContain('run.failed');
  });

  it('escalates a completed run that produced no artifact', async () => {
    const harness = harnessWith({
      runs: {
        refinement: { status: 'completed', terminalReason: 'success', structuredOutput: null },
      },
    });
    await harness.publish([ticketMatched()]);
    expect(escalationOf(harness)?.payload.reason).toContain('produced no artifact');
  });

  it('escalates a completed run whose artifact carries no verdict the platform knows', async () => {
    const harness = harnessWith({
      runs: {
        refinement: {
          status: 'completed',
          terminalReason: 'success',
          structuredOutput: { decision: 'ship it' },
        },
      },
    });
    await harness.publish([ticketMatched()]);
    expect(escalationOf(harness)?.payload.reason).toContain('"ship it"');
  });
});

describe('the task budget', () => {
  it('pauses before the run rather than after it', async () => {
    const harness = harnessWith({
      // Refinement's default cap is 2 USD (product/04's table), so a 1 USD task budget cannot
      // afford it and nothing is spent at all.
      settings: { taskBudgetUsd: 1 },
      runs: {
        refinement: { status: 'completed', terminalReason: 'success', structuredOutput: {} },
      },
    });
    await harness.publish([ticketMatched()]);
    expect(taskOf(harness).task.state).toBe('paused');
    expect(harness.specs).toHaveLength(0);
    expect(taskOf(harness).costActualUsd).toBe(0);
  });

  it('counts what this run may spend, not only what the task has spent', () => {
    const settings = { config: {}, taskBudgetUsd: 10 } as never;
    const stored = { costActualUsd: 9 } as never;
    // 9 spent + refinement's 2 USD cap is over 10, even though 9 is under it.
    expect(taskBudgetExhausted(stored, settings, 'refinement')).toBe(true);
    expect(taskBudgetExhausted({ costActualUsd: 7 } as never, settings, 'refinement')).toBe(false);
  });

  it('takes the per-run cap from the project when it sets one', () => {
    const withOverride = {
      config: { stages: { refinement: { budget_usd: 0.5 } } },
      taskBudgetUsd: 50,
    } as never;
    expect(runBudgetUsd(withOverride, 'refinement')).toBe(0.5);
    expect(runBudgetUsd({ config: {} } as never, 'refinement')).toBe(2);
    // A stage product/04's table does not name still gets a cap rather than none.
    expect(runBudgetUsd({ config: {} } as never, 'security_scan')).toBe(5);
  });
});

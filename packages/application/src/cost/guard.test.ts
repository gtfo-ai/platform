/**
 * The budget guard, and the stage executor it is asked from.
 *
 * Both directions, on purpose (standing rule 42): below the ceiling a stage runs, at and above it
 * the task is paused. And because the guard's default is "never block", a test that asserts a run
 * happened must say **which** guard it composed (standing rule 10) — the harness case below
 * composes a real one over a real budget and asserts the negative *with* it.
 */
import type { DomainEvent, Id, IsoDateTime } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { createMemoryCostStore } from '../testing/memory-cost.js';
import { createPipelineHarness, type PipelineHarness } from '../testing/pipeline-harness.js';
import { createBudgetGuard, noBudgetGuard } from './guard.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;
const BUDGET = '00000000-0000-4000-8000-0000000000f1' as Id;
const TASK = '00000000-0000-4000-8000-0000000000c1' as Id;
const TX = { adapter: 'memory' } as never;
const NOW = '2026-06-11T12:00:00.000Z' as IsoDateTime;

const storeWith = (limitUsd: number, spentUsd: number, scope: 'org' | 'project' | 'task') => {
  const store = createMemoryCostStore();
  store.seedBudget({
    id: BUDGET,
    scope,
    scopeId: scope === 'org' ? null : scope === 'project' ? PROJECT : TASK,
    projectId: scope === 'org' ? null : PROJECT,
    window: 'month',
    limitUsd,
  });
  return { store, spentUsd };
};

const charge = async (store: ReturnType<typeof createMemoryCostStore>, usd: number) => {
  await store.budgets.saveWindow(TX, {
    budgetId: BUDGET,
    windowStart: '2026-06-01T00:00:00.000Z' as IsoDateTime,
    spentUsd: usd,
    notifiedPct: [],
  });
};

describe('createBudgetGuard (BD-010: an org or project budget stops *new* runs)', () => {
  it('lets a run start below the limit', async () => {
    const { store } = storeWith(10, 0, 'project');
    await charge(store, 9.999999);
    expect(await createBudgetGuard({ store }).blockingFor(TX, PROJECT, NOW)).toBeNull();
  });

  it('blocks at the limit, not one cent past it', async () => {
    const { store } = storeWith(10, 0, 'project');
    await charge(store, 10);
    const blocker = await createBudgetGuard({ store }).blockingFor(TX, PROJECT, NOW);
    expect(blocker).toMatchObject({
      scope: 'project',
      window: 'month',
      limitUsd: 10,
      spentUsd: 10,
    });
  });

  it('blocks on the organisation’s budget too', async () => {
    const { store } = storeWith(5, 0, 'org');
    await charge(store, 5);
    expect(await createBudgetGuard({ store }).blockingFor(TX, PROJECT, NOW)).toMatchObject({
      scope: 'org',
    });
  });

  /**
   * The task scope is the stage executor's own check against the project's configuration
   * (`taskBudgetExhausted`), and enforcing it from a row as well would give one question two
   * answers. The row is still *projected* — its spend is visible — which is what this asserts.
   */
  it('ignores a task-scoped budget row, which the executor enforces from configuration', async () => {
    const { store } = storeWith(1, 0, 'task');
    await charge(store, 100);
    expect(await createBudgetGuard({ store }).blockingFor(TX, PROJECT, NOW)).toBeNull();
  });

  it('never blocks when a deployment has no budgets at all', async () => {
    const store = createMemoryCostStore();
    expect(await createBudgetGuard({ store }).blockingFor(TX, PROJECT, NOW)).toBeNull();
  });

  /**
   * The zone `budgetWindowStart` **refuses** — a fixed offset, which ES2024 `Intl` accepts and DST
   * arithmetic cannot use.
   *
   * The guard runs inside the stage executor's admission transaction, so a throw here does not
   * surface as a bad answer: it fails the `stage.execute` job into its retry loop, and the task
   * never learns whether it may run. It therefore takes the same substitution the ledger takes
   * (`resolveBudgetTimezone`) and answers from the **UTC** window — which is what makes this a
   * *behaviour* assertion rather than a "does not throw" one: the row below is charged at the UTC
   * month start, so only a guard that read that window can find it.
   *
   * Nothing else in any tier admits a stage under a fixed-offset zone — `ledger.e2e.test.ts` sets
   * one only after the task has settled — so without this case the substitution is dead code that a
   * mutant restores to a throw with every test still green (measured by the reviewer).
   */
  it('substitutes UTC for a zone it cannot compute in, rather than throwing', async () => {
    const { store } = storeWith(10, 0, 'project');
    store.seedTimezone(PROJECT, '+02:00');
    await charge(store, 10);
    const blocker = await createBudgetGuard({ store }).blockingFor(TX, PROJECT, NOW);
    expect(blocker).toMatchObject({
      scope: 'project',
      spentUsd: 10,
      windowStart: '2026-06-01T00:00:00.000Z',
    });
  });

  it('reads the window the organisation’s calendar is in', async () => {
    const { store } = storeWith(10, 0, 'project');
    store.seedTimezone(PROJECT, 'Europe/Prague');
    await charge(store, 10);
    // The June window in Prague starts at 22:00 UTC on 31 May, so the row charged above (keyed on
    // the UTC month start) is a *different* window and does not block.
    expect(await createBudgetGuard({ store }).blockingFor(TX, PROJECT, NOW)).toBeNull();
  });
});

describe('noBudgetGuard', () => {
  it('is the default, and it never blocks', async () => {
    expect(await noBudgetGuard.blockingFor(TX, PROJECT, NOW)).toBeNull();
  });
});

/**
 * The same question asked of the **pipeline**: does an exhausted project budget pause a task?
 *
 * Driven through the real saga, the real interpreter and the real stage executor, with the guard
 * composed the way `apps/server` composes it (`cost: true` on the harness). Both directions, and
 * the negative one names the guard it ran with — otherwise it would pass against no guard at all
 * (standing rule 10).
 */
const ticketMatched = (projectId: Id): DomainEvent =>
  domainEventSchemasByType['ticket.matched'].parse({
    id: '00000000-0000-4000-9000-0000000000c1',
    stream_type: 'project',
    stream_id: projectId,
    stream_seq: 1,
    correlation_id: null,
    cause_event_id: null,
    actor: { kind: 'integration', integration_id: projectId, provider: 'fake-jira' },
    occurred_at: '2026-06-01T09:00:00.000Z',
    type: 'ticket.matched',
    payload: {
      project_id: projectId,
      ticket: { provider: 'fake-jira', key: 'ACME-1', url: 'https://jira.example.test/ACME-1' },
      rule: 'label:agentic',
      priority: null,
      issue_type: 'Story',
      epic: null,
      links: [],
    },
  }) as DomainEvent;

/** Refinement asks a question, so the walk stops after one run and needs one script. */
const ASKING_SPEC = {
  goal: 'Show the totals in the invoice footer.',
  user_value: 'Finance can read the invoice without a calculator.',
  in_scope: ['the footer'],
  out_of_scope: [],
  acceptance_criteria: [],
  non_functional: [],
  dependencies: [],
  size: 'M',
  drift: { flag: 'none', justification: 'in the documented direction' },
  assumptions: [],
  questions: [{ id: 'q1', text: 'Which currency?' }],
  decision: 'ask',
  kb_citations: [],
};

const pipelineWithBudget = async (limitUsd: number, spentUsd: number): Promise<PipelineHarness> => {
  const harness = createPipelineHarness({
    projectId: PROJECT,
    cost: true,
    runs: {
      refinement: { status: 'completed', terminalReason: 'success', structuredOutput: ASKING_SPEC },
    },
  });
  const cost = harness.cost;
  if (cost === null) {
    throw new Error('the harness was asked for a cost store and produced none');
  }
  cost.seedBudget({
    id: BUDGET,
    scope: 'project',
    scopeId: PROJECT,
    projectId: PROJECT,
    window: 'month',
    limitUsd,
  });
  await cost.budgets.saveWindow(TX, {
    budgetId: BUDGET,
    windowStart: '2026-06-01T00:00:00.000Z' as IsoDateTime,
    spentUsd,
    notifiedPct: [],
  });
  return harness;
};

const taskOf = (harness: PipelineHarness) => {
  const [task] = harness.store.snapshot();
  if (task === undefined) {
    throw new Error('no task was created');
  }
  return task;
};

describe('a project budget, through the whole pipeline', () => {
  it('pauses the task at the limit, and starts no run', async () => {
    const harness = await pipelineWithBudget(10, 10);
    await harness.publish([ticketMatched(PROJECT)]);
    expect(taskOf(harness).task.state).toBe('paused');
    expect(harness.specs).toEqual([]);
    expect(harness.types()).toContain('task.paused');
  });

  it('runs the stage below the limit, with the same guard composed', async () => {
    const harness = await pipelineWithBudget(10, 9.999999);
    expect(harness.cost).not.toBeNull();
    await harness.publish([ticketMatched(PROJECT)]);
    expect(harness.specs.map((spec) => spec.stage)).toEqual(['refinement']);
    expect(taskOf(harness).task.state).not.toBe('paused');
  });

  it('charges the ledger for the run it did allow, and the entries reconcile', async () => {
    const harness = await pipelineWithBudget(100, 0);
    await harness.publish([ticketMatched(PROJECT)]);
    const cost = harness.cost as NonNullable<PipelineHarness['cost']>;
    // The harness's scripted run reports 0.25 USD; the ledger is derived from the run, not seeded.
    expect(cost.entries.map((entry) => entry.usd)).toEqual([0.25]);
    expect(cost.rollups.reduce((sum, row) => sum + row.usd, 0)).toBeCloseTo(
      cost.entries.reduce((sum, entry) => sum + entry.usd, 0),
      6,
    );
    expect(cost.windows).toMatchObject([{ budgetId: BUDGET, spentUsd: 0.25 }]);
  });
});

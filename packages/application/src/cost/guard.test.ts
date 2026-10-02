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
import { raiseTaskBudgetCommand, TaskNotPausedByItsCapError } from '../pipeline/commands.js';
import { createMemoryCostStore } from '../testing/memory-cost.js';
import { createPipelineHarness, type PipelineHarness } from '../testing/pipeline-harness.js';
import {
  type BlockingBudget,
  blockingBudgetDetail,
  createBudgetGuard,
  noBudgetGuard,
} from './guard.js';

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
    expect(await createBudgetGuard({ store }).blockingFor(TX, PROJECT, NOW, 0)).toBeNull();
  });

  it('blocks at the limit, not one cent past it', async () => {
    const { store } = storeWith(10, 0, 'project');
    await charge(store, 10);
    const blocker = await createBudgetGuard({ store }).blockingFor(TX, PROJECT, NOW, 0);
    expect(blocker).toMatchObject({
      scope: 'project',
      window: 'month',
      limitUsd: 10,
      spentUsd: 10,
    });
  });

  /**
   * **The window the ledger has not finished writing** — the defect measured on WP-40's tree.
   *
   * `budget_windows.spent_usd` is written by the cost ledger's handler on `run.finished`, after the
   * run's own transaction; between the two a second admission reads a window that is lower than it
   * is. The guard therefore asks `pendingSpend` as well, and the two numbers stay apart in the
   * answer: 9 charged and one live run holding the 2 it may spend is 11 against a limit of 10.
   */
  it('counts a run the ledger has not recorded yet, and reports it apart from the spend', async () => {
    const { store } = storeWith(10, 0, 'project');
    await charge(store, 9);
    store.seedPendingRuns(PROJECT, 1);
    const blocker = await createBudgetGuard({ store }).blockingFor(TX, PROJECT, NOW, 2);
    expect(blocker).toMatchObject({ scope: 'project', limitUsd: 10, spentUsd: 9, pendingUsd: 2 });
  });

  /** Standing rule 42: the same mechanism, from the other side — a window under its limit runs. */
  it('lets a run start when the spend and what is in flight are still under the limit', async () => {
    const { store } = storeWith(10, 0, 'project');
    await charge(store, 5);
    store.seedPendingRuns(PROJECT, 1);
    expect(await createBudgetGuard({ store }).blockingFor(TX, PROJECT, NOW, 2)).toBeNull();
  });

  /**
   * The valuation is the **caller's** reservation, not a constant this module chose: the same
   * seeded run values at nothing when the caller says a run may spend nothing, which is what the
   * maintenance scheduler passes when it is creating a task rather than admitting a run.
   */
  it('values a run in flight at what the caller says a run may spend', async () => {
    const { store } = storeWith(10, 0, 'project');
    await charge(store, 9);
    store.seedPendingRuns(PROJECT, 1);
    expect(await createBudgetGuard({ store }).blockingFor(TX, PROJECT, NOW, 0)).toBeNull();
  });

  it('blocks on the organisation’s budget too', async () => {
    const { store } = storeWith(5, 0, 'org');
    await charge(store, 5);
    expect(await createBudgetGuard({ store }).blockingFor(TX, PROJECT, NOW, 0)).toMatchObject({
      scope: 'org',
    });
  });

  /**
   * The organisation scope's `scope_id` is **null** (migration 0007: *"exactly one subject"*), so
   * its pending term is every run of the deployment rather than a join on a column that is not
   * there — a separate branch in the adapter, and therefore a case of its own here.
   */
  it('counts what is in flight for the organisation scope, whose scope_id is null', async () => {
    const { store } = storeWith(5, 0, 'org');
    await charge(store, 4);
    store.seedPendingRuns(null, 1);
    expect(await createBudgetGuard({ store }).blockingFor(TX, PROJECT, NOW, 1)).toMatchObject({
      scope: 'org',
      spentUsd: 4,
      pendingUsd: 1,
    });
  });

  /**
   * WP-131 (PROGRESS backlog 402), criterion (2) for the two `budgets` scopes: a run of the window
   * that ended with **nobody measuring it** is held at the reservation it was admitted at, and the
   * answer keeps the hold apart from the charge and from the live reservations.
   *
   * The row's figures exactly — a 20 USD cap, one unmeasured run held at 15, a 10 USD admission,
   * nothing charged — because since the pre-review round (backlog 406) this guard makes the
   * comparison the other caps make: `0 + 15 + 10 > 20`. The canary is the same window with no hold,
   * which admits the same run (`0 + 10 <= 20`).
   */
  it.each([
    { scope: 'project' as const, seed: PROJECT },
    { scope: 'org' as const, seed: null },
  ])(
    'refuses a 10 USD admission to a $scope budget of 20 holding one unmeasured run at 15, and names the hold (WP-131)',
    async ({ scope, seed }) => {
      const { store } = storeWith(20, 0, scope);
      store.seedHeldRuns(seed, [15]);
      const blocker = await createBudgetGuard({ store }).blockingFor(TX, PROJECT, NOW, 10);
      expect(blocker).toMatchObject({
        scope,
        limitUsd: 20,
        spentUsd: 0,
        pendingUsd: 0,
        heldUsd: 15,
        heldRuns: 1,
        reserveUsd: 10,
      });
      expect(blockingBudgetDetail(blocker as BlockingBudget)).toBe(
        `the ${scope} budget for this month cannot take this run: 0 spent of 20 USD since ` +
          '2026-06-01T00:00:00.000Z, plus 1 run nobody measured, held at its cap: 15 USD, and ' +
          'this run may spend 10 more',
      );

      // The canary in the fixture: the same window with no hold admits the same run.
      const { store: free } = storeWith(20, 0, scope);
      expect(await createBudgetGuard({ store: free }).blockingFor(TX, PROJECT, NOW, 10)).toBeNull();
    },
  );

  /**
   * A row written before migration 0072 recorded no reservation, and is held at the **admitting**
   * reserve — the only figure an admission has for it, in the fail-closed direction: one such run
   * at a 5 USD admission is `5 + 5 <= 20`, at a 10 USD admission `10 + 10 <= 20` (exactly full), at
   * an 11 USD one `11 + 11 > 20`.
   */
  it('holds a run that recorded no reservation at the admitting reserve (WP-131)', async () => {
    const { store } = storeWith(20, 0, 'project');
    store.seedHeldRuns(PROJECT, [null]);
    expect(await createBudgetGuard({ store }).blockingFor(TX, PROJECT, NOW, 10)).toBeNull();
    expect(await createBudgetGuard({ store }).blockingFor(TX, PROJECT, NOW, 11)).toMatchObject({
      heldUsd: 11,
      heldRuns: 1,
    });
  });

  /**
   * Backlog 406 (the pre-review round's ruling): the admitting run's own reservation counts, as it
   * does for every other cap — both sides of the boundary (standing rule 42). 10 charged of 20: a
   * run that may spend exactly the remaining 10 is admitted, one that may spend a cent more is not,
   * and before the ruling both were admitted (the window was not yet used up).
   */
  it('admits a run that exactly fills the window, and refuses one a cent over it (406)', async () => {
    const { store } = storeWith(20, 0, 'project');
    await charge(store, 10);
    const guard = createBudgetGuard({ store });
    expect(await guard.blockingFor(TX, PROJECT, NOW, 10)).toBeNull();
    const blocker = await guard.blockingFor(TX, PROJECT, NOW, 10.01);
    expect(blocker).toMatchObject({ scope: 'project', spentUsd: 10, reserveUsd: 10.01 });
    // The words must be true for a window that is not used up: no "exhausted" at 10 of 20.
    expect(blockingBudgetDetail(blocker as BlockingBudget)).not.toContain('exhausted');
    expect(blockingBudgetDetail(blocker as BlockingBudget)).toContain(
      'this run may spend 10.01 more',
    );
  });

  /** A window that **is** used up refuses even a run that may spend nothing. */
  it('refuses any run once the window is used up, whatever it may spend (406)', async () => {
    const { store } = storeWith(20, 0, 'project');
    await charge(store, 20);
    expect(await createBudgetGuard({ store }).blockingFor(TX, PROJECT, NOW, 0)).toMatchObject({
      spentUsd: 20,
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
    expect(await createBudgetGuard({ store }).blockingFor(TX, PROJECT, NOW, 0)).toBeNull();
  });

  it('never blocks when a deployment has no budgets at all', async () => {
    const store = createMemoryCostStore();
    expect(await createBudgetGuard({ store }).blockingFor(TX, PROJECT, NOW, 0)).toBeNull();
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
    const blocker = await createBudgetGuard({ store }).blockingFor(TX, PROJECT, NOW, 0);
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
    expect(await createBudgetGuard({ store }).blockingFor(TX, PROJECT, NOW, 0)).toBeNull();
  });
});

describe('noBudgetGuard', () => {
  it('is the default, and it never blocks', async () => {
    expect(await noBudgetGuard.blockingFor(TX, PROJECT, NOW, 0)).toBeNull();
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
  drift: { flag: false, justification: 'in the documented direction' },
  assumptions: [],
  questions: [{ id: 'q1', text: 'Which currency?', blocking: true }],
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

  /**
   * WP-131 review round 2: the pause names **which** cap — `project` here — and the task's own cap
   * may not be raised for it. Raising it would loosen the task's safety cap for good and resume
   * straight into the project's pause again. The other side is the stage executor's case, where
   * the task cap paused it and the raise is accepted.
   */
  it('names the project cap on the pause, and refuses to raise the task’s own cap for it (WP-131)', async () => {
    const harness = await pipelineWithBudget(10, 10);
    await harness.publish([ticketMatched(PROJECT)]);
    const paused = harness.events().filter((event) => event.type === 'task.paused');
    expect(
      paused.map((event) => (event.payload as { budget_scope?: string }).budget_scope),
    ).toEqual(['project']);
    const taskId = taskOf(harness).task.id;
    await expect(
      raiseTaskBudgetCommand(harness.humanCommands, {
        taskId,
        userId: '00000000-0000-4000-8000-00000000a131' as Id,
        capUsd: 500,
      }),
    ).rejects.toBeInstanceOf(TaskNotPausedByItsCapError);
    expect(
      await harness.memory.transaction(async (scope) =>
        harness.store.tasks.budgetCap(scope.tx, taskId),
      ),
    ).toBeNull();
  });

  it('runs the stage below the limit, with the same guard composed', async () => {
    // 8 of 10 charged and refinement may spend 2: the run exactly fills the window, which is
    // admitted (`capIsSpent` is `>`); since backlog 406 the 2 counts, so 9.999999 would refuse.
    const harness = await pipelineWithBudget(10, 8);
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

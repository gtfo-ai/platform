/**
 * The late cost: the money a run that somebody else ended still owes (WP-47, Q70 (b), backlog 50).
 *
 * Driven against the **real** in-memory cost store and the real ledger body, because the claim the
 * work package makes is not "a method was called" — it is that the tokens reach `cost_entries`, the
 * rollup **and** the budgets, which are three different tables and three different ways of losing
 * the same money. WP-19's own invariant cannot catch this (standing rule 79): `sum(entries) =
 * sum(rollup)` is true and blind for a run that contributes nothing to either.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import { FEATURE_TEMPLATE } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import type { RunRepository, StoredTask } from '../pipeline/store.js';
import { INITIAL_TASK_VERSION } from '../pipeline/store.js';
import type { Transaction } from '../ports/transaction.js';
import type { TransactionScope } from '../ports/unit-of-work.js';
import { createMemoryCostStore, type MemoryCostStore } from '../testing/memory-cost.js';
import { MemoryEventing } from '../testing/memory-eventing.js';
import { createMemoryPipelineStore } from '../testing/memory-pipeline.js';
import { createLateCostRecorder, noLateCostRecorder } from './late.js';

const RUN = '00000000-0000-4000-8000-0000000000e1' as Id;
const TASK = '00000000-0000-4000-8000-0000000000d1' as Id;
const PROJECT = '00000000-0000-4000-8000-0000000000a1' as Id;
const ORG = '00000000-0000-4000-8000-0000000000b1' as Id;
const BUDGET = '00000000-0000-4000-8000-0000000000c1' as Id;
const AT = '2026-09-15T10:00:00.000Z' as IsoDateTime;

/** What the process that ran the session measured — a real attempt, not a zero. */
const MEASURED = {
  runId: RUN,
  taskId: TASK,
  sessionId: 'session-1',
  numTurns: 7,
  usage: {
    input_tokens: 1_000,
    output_tokens: 500,
    cache_write_5m_tokens: 0,
    cache_write_1h_tokens: 0,
    cache_read_tokens: 0,
  },
  modelUsage: [],
  cost: { usd: 2.5, is_estimate: false, price_list_id: null },
  wallMs: 120_000,
};

const scope = {
  tx: { adapter: 'memory' },
  events: { append: async () => [] },
} as unknown as TransactionScope;

const seededStore = (): MemoryCostStore => {
  const store = createMemoryCostStore();
  store.seedTask({ id: TASK, projectId: PROJECT });
  store.seedPrice({
    modelId: 'claude-opus-5',
    priceListId: '00000000-0000-4000-8000-00000000c001' as Id,
    effectiveFrom: '2026-01-01T00:00:00.000Z' as IsoDateTime,
    input: 15,
    output: 75,
    cacheWrite5m: 18.75,
    cacheWrite1h: 30,
    cacheRead: 1.5,
  });
  store.seedBudget({
    id: BUDGET,
    scope: 'project',
    scopeId: PROJECT,
    projectId: PROJECT,
    window: 'day',
    limitUsd: 100,
    notifyPct: [80],
  });
  return store;
};

const runs = (recorded: boolean, calls: { count: number }): RunRepository =>
  ({
    recordCost: async () => {
      calls.count += 1;
      return recorded;
    },
  }) as unknown as RunRepository;

const recorderOver = (store: MemoryCostStore, recorded: boolean) => {
  const calls = { count: 0 };
  store.seedTimezone(PROJECT, 'UTC');
  const recorder = createLateCostRecorder({
    store,
    runs: runs(recorded, calls),
    tasks: { addSpend: async () => {} },
    context: (correlationId, causeEventId) => ({
      ids: { next: () => '00000000-0000-4000-8000-0000000000f1' as Id },
      actor: { kind: 'system', component: 'cost-ledger' },
      clock: { now: () => AT },
      correlationId,
      causeEventId,
    }),
  });
  return { recorder, calls };
};

describe('the late cost recorder', () => {
  it('charges the entries, the rollup and the budget — all three, because losing any one loses the money', async () => {
    const store = seededStore();
    store.seedRun({
      runId: RUN,
      taskId: TASK,
      projectId: PROJECT,
      orgId: ORG,
      template: 'feature',
      stage: 'implementation',
      model: 'claude-opus-5',
      startedAt: AT,
    });
    const { recorder, calls } = recorderOver(store, true);

    const outcome = await recorder.record(scope, MEASURED, AT);

    expect(calls.count).toBe(1);
    expect(outcome.recorded).toBe(true);
    expect(outcome.charge?.entries).toBe(1);
    // The provider's figure is the truth (BD-011), so the entry sums to what the runner reported
    // rather than to what the price table would have guessed.
    expect(store.entries.map((entry) => entry.usd)).toEqual([2.5]);
    expect(store.rollups.map((delta) => delta.usd)).toEqual([2.5]);
    expect(store.windows.map((window) => window.spentUsd)).toEqual([2.5]);
  });

  it('labels the rows `late`, so a reconciliation can tell a correction from the original charge', async () => {
    const store = seededStore();
    store.seedRun({
      runId: RUN,
      taskId: TASK,
      projectId: PROJECT,
      orgId: ORG,
      template: 'feature',
      stage: 'implementation',
      model: 'claude-opus-5',
      startedAt: AT,
    });
    const { recorder } = recorderOver(store, true);

    await recorder.record(scope, MEASURED, AT);

    expect(store.entries.map((entry) => entry.late)).toEqual([true]);
  });

  it('charges nothing when the row refuses the write, which is what makes a repeat a no-op', async () => {
    const store = seededStore();
    store.seedRun({
      runId: RUN,
      taskId: TASK,
      projectId: PROJECT,
      orgId: ORG,
      template: 'feature',
      stage: 'implementation',
      model: 'claude-opus-5',
      startedAt: AT,
    });
    const { recorder } = recorderOver(store, false);

    const outcome = await recorder.record(scope, MEASURED, AT);

    expect(outcome).toEqual({ recorded: false, charge: null });
    // Not "one fewer entry": **none**, and no rollup and no budget movement either. A recorder that
    // charged on the refused path would double every cancelled run's spend on a job retry.
    expect(store.entries).toHaveLength(0);
    expect(store.rollups).toHaveLength(0);
    expect(store.windows).toHaveLength(0);
  });

  it('is absent-shaped rather than throwing when a composition has no ledger', async () => {
    // A deployment with no cost store composes this, and the assertion is which one ran (standing
    // rule 10): the outcome says nothing was recorded, rather than the caller having to know.
    await expect(noLateCostRecorder.record(scope, MEASURED, AT)).resolves.toEqual({
      recorded: false,
      charge: null,
    });
  });
});

/**
 * WP-131 criterion (5) — the release of a hold (PROGRESS backlog 402).
 *
 * A run a human cancelled in place ends with both cost columns null, so every cap **holds** it at
 * the reservation it was admitted at (`./pending.ts`); the task cap reads that hold through
 * `RunRepository.heldFor`. The late figure is what releases it, and the release must move
 * `tasks.cost_actual` in the **same** transaction — `cost_actual` is the only spend the task cap
 * reads, and no other write moves it for this run, so a release that did not would drop the money
 * from the task cap at the very moment it stopped holding the reservation.
 *
 * Driven against the real in-memory pipeline store (the row, the hold and `addSpend` are all
 * its own) and the real in-memory cost store (the ledger rows).
 */
describe('the late cost releases the hold (WP-131)', () => {
  const storedTask = (): StoredTask => ({
    task: {
      id: TASK,
      projectId: PROJECT,
      ticket: { provider: 'fake-jira', key: 'ACME-131', url: 'https://jira.test/ACME-131' },
      template: 'feature',
      mode: 'normal',
      state: 'active',
      currentStage: 'implementation',
      stageAttempts: { implementation: 1 },
      iterationCounters: {},
      limits: {
        code_review: 3,
        business_review: 2,
        ci_fix: 3,
        human_rounds: 3,
        refinement_questions: 2,
        architecture_revisions: 2,
        rebase: 2,
        rebase_rechecks: 10,
        dependency_policy: 2,
      },
      sequence: 1,
    },
    template: FEATURE_TEMPLATE,
    priorityRank: 2,
    createdAt: AT,
    branch: null,
    mr: null,
    workpad: null,
    costActualUsd: 0,
    estimateUsd: null,
    estimateBasis: null,
    estimateSamples: null,
    ticketSnapshot: null,
    reviewSubject: null,
    historySample: null,
    riskClasses: [],
    coverage: null,
    dependencies: null,
    requiredReviewers: null,
    reviewThreads: null,
    readyHeadSha: null,
    ciHeadSha: null,
    ciExcusedPaths: [],
    requestedByUserId: null,
    pipelineDial: null,
    ticketSnapshotAt: null,
    ticketSignalAt: null,
    version: INITIAL_TASK_VERSION,
  });

  /** A task with one implementation run admitted at 15 USD that a cancel ended with no figure. */
  const cancelledUnmeasured = async () => {
    const pipeline = createMemoryPipelineStore();
    const eventing = new MemoryEventing();
    await eventing.transaction(async (tx) => {
      await pipeline.tasks.insert(tx.tx, storedTask());
      await pipeline.runs.insert(tx.tx, {
        id: RUN,
        taskId: TASK,
        projectId: PROJECT,
        stage: 'implementation',
        role: 'developer',
        mode: 'normal',
        attempt: 1,
        model: 'claude-opus-5',
        effort: 'high',
        promptVersion: 'developer@1',
        systemPrompt: null,
        userPrompt: null,
        redactionCount: 0,
        contextPack: null,
        settings: null,
        reserveUsd: 15,
        status: 'running',
        terminalReason: null,
        sessionId: 'session-1',
        numTurns: 0,
        usage: null,
        cost: null,
        wallMs: 0,
        createdAt: AT,
        startedAt: AT,
      });
      // The in-place cancel's ending: terminal, and nobody measured it (WP-101, WP-119).
      await pipeline.runs.finish(tx.tx, {
        runId: RUN,
        status: 'cancelled',
        terminalReason: 'cancelled',
        sessionId: 'session-1',
        numTurns: 0,
        usage: MEASURED.usage,
        cost: null,
        wallMs: 0,
      });
    });
    const store = seededStore();
    store.seedRun({
      runId: RUN,
      taskId: TASK,
      projectId: PROJECT,
      orgId: ORG,
      template: 'feature',
      stage: 'implementation',
      model: 'claude-opus-5',
      startedAt: AT,
    });
    store.seedTimezone(PROJECT, 'UTC');
    return { pipeline, eventing, store };
  };

  const context = (correlationId: string, causeEventId: string | null) => ({
    ids: { next: () => '00000000-0000-4000-8000-0000000000f2' as Id },
    actor: { kind: 'system' as const, component: 'cost-ledger' },
    clock: { now: () => AT },
    correlationId,
    causeEventId,
  });

  it('moves the run from the hold to cost_actual, and charges the ledger, in the caller’s transaction', async () => {
    const { pipeline, eventing, store } = await cancelledUnmeasured();
    const heldBefore = await eventing.transaction(async (tx) =>
      pipeline.runs.heldFor(tx.tx, TASK, 2),
    );
    expect(heldBefore).toEqual({ heldUsd: 15, heldRuns: 1 });

    // Every write the recorder makes is handed the **same** transaction handle: the row, the
    // task's spend and the ledger commit together or not at all.
    const handles: { readonly write: string; readonly tx: Transaction }[] = [];
    const recorder = createLateCostRecorder({
      store,
      runs: {
        ...pipeline.runs,
        recordCost: async (tx, late) => {
          handles.push({ write: 'recordCost', tx });
          return pipeline.runs.recordCost(tx, late);
        },
      },
      tasks: {
        addSpend: async (tx, taskId, usd) => {
          handles.push({ write: 'addSpend', tx });
          return pipeline.tasks.addSpend(tx, taskId, usd);
        },
      },
      context,
    });

    const outcome = await eventing.transaction(async (tx) => {
      const recorded = await recorder.record(tx, MEASURED, AT);
      handles.forEach((handle) => {
        expect(handle.tx).toBe(tx.tx);
      });
      return recorded;
    });

    expect(outcome.recorded).toBe(true);
    expect(handles.map((handle) => handle.write)).toEqual(['recordCost', 'addSpend']);
    const after = await eventing.transaction(async (tx) => ({
      held: await pipeline.runs.heldFor(tx.tx, TASK, 2),
      task: await pipeline.tasks.load(tx.tx, TASK),
    }));
    // Released from the hold, and moved into the spend the task cap reads — 2.5, not 15 and not 0.
    expect(after.held).toEqual({ heldUsd: 0, heldRuns: 0 });
    expect(after.task?.costActualUsd).toBe(2.5);
    expect(store.entries.map((entry) => entry.usd)).toEqual([2.5]);
  });

  it('moves nothing when the row refuses the figure, so the hold stands and nothing is counted twice', async () => {
    const { pipeline, eventing, store } = await cancelledUnmeasured();
    const recorder = createLateCostRecorder({
      store,
      runs: pipeline.runs,
      tasks: pipeline.tasks,
      context,
    });
    await eventing.transaction(async (tx) => recorder.record(tx, MEASURED, AT));
    // A second report of the same run: the row already carries a figure and refuses it.
    const again = await eventing.transaction(async (tx) => recorder.record(tx, MEASURED, AT));
    expect(again).toEqual({ recorded: false, charge: null });
    const task = await eventing.transaction(async (tx) => pipeline.tasks.load(tx.tx, TASK));
    expect(task?.costActualUsd).toBe(2.5);
  });
});

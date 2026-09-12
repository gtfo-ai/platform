/**
 * The cost ledger handler, over the in-memory store and the real `EventBus`.
 *
 * The branches live here because a branch is cheap to reach in this tier; the reconciliation
 * against a **database** is `test/integration/cost/`, and the reconciliation after a *real* run is
 * the e2e tier's (never against a seeded ledger — WP-19's acceptance criterion).
 */
import type { DomainEvent, Id } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { EventBus } from '../events/event-bus.js';
import type { Logger } from '../ports/logger.js';
import { createMemoryCostStore, type MemoryCostStore } from '../testing/memory-cost.js';
import { MemoryEventing } from '../testing/memory-eventing.js';
import { testClock, testIds } from '../testing/pipeline-harness.js';
import { costHandlers } from './runtime.js';

const ORG = '00000000-0000-4000-8000-00000000e001' as Id;
const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;
const TASK = '00000000-0000-4000-8000-0000000000c1' as Id;
const RUN = '00000000-0000-4000-8000-0000000000d1' as Id;
const BUDGET = '00000000-0000-4000-8000-0000000000f1' as Id;

const OPUS_PRICE = {
  priceListId: '00000000-0000-4000-8000-0000000000a1',
  modelId: 'claude-opus-5',
  input: 5,
  output: 25,
  cacheWrite5m: 6.25,
  cacheWrite1h: 10,
  cacheRead: 0.5,
  effectiveFrom: '2020-01-01T00:00:00.000Z' as const,
};

/** `stream_seq` is per stream and the harness gives each test a fresh log, so it resets with it. */
let stream = 0;
/** Event ids never repeat, even across harnesses: a duplicate id is a different defect. */
let eventId = 0;

const nextIds = (): { readonly seq: number; readonly id: string } => {
  stream += 1;
  eventId += 1;
  return { seq: stream, id: `00000000-0000-4000-9000-${eventId.toString(16).padStart(12, '0')}` };
};

const runFinished = (payload: Record<string, unknown>, at = '2026-06-01T09:00:00.000Z') => {
  const { seq, id } = nextIds();
  return domainEventSchemasByType['run.finished'].parse({
    id,
    stream_type: 'run',
    stream_id: RUN,
    stream_seq: seq,
    correlation_id: TASK,
    cause_event_id: null,
    actor: { kind: 'system', component: 'runner' },
    occurred_at: at,
    type: 'run.finished',
    payload: {
      project_id: PROJECT,
      task_id: TASK,
      run_id: RUN,
      status: 'completed',
      terminal_reason: 'success',
      usage: {
        input_tokens: 1_000_000,
        output_tokens: 0,
        cache_write_5m_tokens: 0,
        cache_write_1h_tokens: 0,
        cache_read_tokens: 0,
      },
      model_usage: [],
      cost: { usd: 2.5, is_estimate: false, price_list_id: null },
      num_turns: 3,
      wall_ms: 12_000,
      ...payload,
    },
  }) as DomainEvent;
};

const runFailed = (payload: Record<string, unknown>) => {
  const { seq, id } = nextIds();
  return domainEventSchemasByType['run.failed'].parse({
    id,
    stream_type: 'run',
    stream_id: RUN,
    stream_seq: seq,
    correlation_id: TASK,
    cause_event_id: null,
    actor: { kind: 'system', component: 'runner' },
    occurred_at: '2026-06-01T09:00:00.000Z',
    type: 'run.failed',
    payload: {
      project_id: PROJECT,
      task_id: TASK,
      run_id: RUN,
      status: 'failed',
      terminal_reason: 'error_during_execution',
      // The one payload field that carries somebody else's words. It must reach no ledger row.
      error: 'the agent crashed with token sk-ant-planted-secret-value in the message',
      usage: null,
      cost: null,
      ...payload,
    },
  }) as DomainEvent;
};

/** Every line the ledger logged, so a warning can be asserted by name rather than trusted. */
interface LoggedLine {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly fields: Readonly<Record<string, unknown>>;
  readonly message: string;
}

interface LedgerHarness {
  readonly memory: MemoryEventing;
  readonly store: MemoryCostStore;
  readonly logs: readonly LoggedLine[];
  publish(events: readonly DomainEvent[]): Promise<void>;
  types(): readonly string[];
}

const ledgerHarness = (): LedgerHarness => {
  stream = 0;
  const logs: LoggedLine[] = [];
  const logger: Logger = {
    debug: (fields, message) => logs.push({ level: 'debug', fields, message }),
    info: (fields, message) => logs.push({ level: 'info', fields, message }),
    warn: (fields, message) => logs.push({ level: 'warn', fields, message }),
    error: (fields, message) => logs.push({ level: 'error', fields, message }),
  };
  const memory = new MemoryEventing();
  const bus = new EventBus({ unitOfWork: memory, retryDelayMs: 0, maxRetryDelayMs: 0 });
  const store = createMemoryCostStore();
  const ids = testIds();
  const clock = testClock();
  store.seedRun({
    runId: RUN,
    taskId: TASK,
    projectId: PROJECT,
    orgId: ORG,
    template: 'feature',
    stage: 'implementation',
    model: 'claude-opus-5',
    startedAt: '2026-06-01T08:50:00.000Z',
  });
  for (const handler of costHandlers({
    store,
    logger,
    context: (correlationId, causeEventId) => ({
      ids,
      actor: { kind: 'system', component: 'cost-ledger' },
      clock: { now: () => clock.now() },
      correlationId,
      causeEventId,
    }),
  })) {
    bus.register(handler);
  }
  return {
    memory,
    store,
    get logs() {
      return [...logs];
    },
    publish: async (events) => {
      await memory.transaction(async (scope) => scope.events.append(events));
      for (let guard = 0; guard < 50; guard += 1) {
        const next = memory.pending[0];
        if (next === undefined) {
          return;
        }
        const stored = memory.log.find((row) => row.position === next.eventPosition);
        if (stored === undefined) {
          return;
        }
        const result = await bus.dispatch(stored);
        if (result.status === 'failed') {
          throw new Error(
            `dispatch failed: ${result.handlers.map((entry) => `${entry.handler}:${entry.error ?? ''}`).join(', ')}`,
          );
        }
      }
      throw new Error('the ledger harness dispatched 50 events without draining');
    },
    types: () => memory.log.map((row) => row.event.type),
  };
};

describe('the cost ledger handler', () => {
  it('writes one entry, one usage row and one rollup for a reported run', async () => {
    const harness = ledgerHarness();
    await harness.publish([runFinished({})]);

    expect(harness.store.entries).toHaveLength(1);
    const [entry] = harness.store.entries;
    expect(entry).toMatchObject({
      runId: RUN,
      taskId: TASK,
      projectId: PROJECT,
      orgId: ORG,
      template: 'feature',
      stage: 'implementation',
      model: 'claude-opus-5',
      usd: 2.5,
      isEstimate: false,
    });
    expect(harness.store.modelUsage).toHaveLength(1);
    expect(harness.store.rollups).toEqual([
      expect.objectContaining({ runs: 1, usd: 2.5, turns: 3, wallMs: 12_000, mode: 'actual' }),
    ]);
  });

  it('sums the entries to the rollup, which is the reconciliation criterion', async () => {
    const harness = ledgerHarness();
    await harness.publish([runFinished({})]);
    await harness.publish([runFinished({ cost: { usd: 1.25, is_estimate: false } })]);

    const entries = harness.store.entries.reduce((sum, entry) => sum + entry.usd, 0);
    const rollups = harness.store.rollups.reduce((sum, row) => sum + row.usd, 0);
    expect(entries).toBeCloseTo(3.75, 6);
    expect(rollups).toBeCloseTo(entries, 6);
    expect(harness.store.rollups.reduce((sum, row) => sum + row.runs, 0)).toBe(2);
  });

  it('prices a run the producer could not cost, and labels it an estimate (BD-011)', async () => {
    const harness = ledgerHarness();
    harness.store.seedPrice(OPUS_PRICE);
    await harness.publish([runFinished({ cost: { usd: 0, is_estimate: true } })]);

    expect(harness.store.entries).toMatchObject([{ usd: 5, isEstimate: true }]);
    expect(harness.store.rollups[0]?.mode).toBe('estimated');
    expect(harness.store.modelUsage[0]?.usdEstimated).toBe(5);
  });

  it('writes no ledger row for a model it cannot price, and keeps the usage (rule 16)', async () => {
    const harness = ledgerHarness();
    await harness.publish([runFinished({ cost: { usd: 0, is_estimate: true } })]);

    expect(harness.store.entries).toEqual([]);
    expect(harness.store.rollups).toEqual([]);
    expect(harness.store.modelUsage).toMatchObject([{ usdEstimated: null, usdReported: null }]);
  });

  it('charges nothing for a run the platform has no row for', async () => {
    const harness = ledgerHarness();
    await harness.publish([runFinished({ run_id: '00000000-0000-4000-8000-00000000dead' as Id })]);
    expect(harness.store.entries).toEqual([]);
  });

  it('charges a failed run that still burned tokens, and stores none of its error text', async () => {
    const harness = ledgerHarness();
    harness.store.seedPrice(OPUS_PRICE);
    await harness.publish([
      runFailed({
        usage: {
          input_tokens: 200_000,
          output_tokens: 0,
          cache_write_5m_tokens: 0,
          cache_write_1h_tokens: 0,
          cache_read_tokens: 0,
        },
      }),
    ]);

    expect(harness.store.entries).toMatchObject([{ usd: 1, isEstimate: true }]);
    // TD-012 / BD-022: the ledger stores numbers and identifiers. Nothing it wrote contains the
    // planted string, asserted over every row rather than over the field it would have landed in.
    const written = JSON.stringify({
      entries: harness.store.entries,
      usage: harness.store.modelUsage,
      rollups: harness.store.rollups,
    });
    expect(written).not.toContain('sk-ant-planted-secret-value');
    expect(written).not.toContain('crashed');
  });

  it('writes nothing for a failed run that reported neither usage nor cost', async () => {
    const harness = ledgerHarness();
    await harness.publish([runFailed({})]);
    expect(harness.store.entries).toEqual([]);
    expect(harness.store.modelUsage).toEqual([]);
  });

  it('never double-charges a redelivered event (the handler_executions claim)', async () => {
    const harness = ledgerHarness();
    const event = runFinished({});
    await harness.publish([event]);
    const stored = harness.memory.log.at(-1);
    expect(stored).toBeDefined();
    // A second dispatch of the very same position: the claim is terminal, so the handler is skipped.
    const bus = new EventBus({ unitOfWork: harness.memory });
    for (const handler of costHandlers({
      store: harness.store,
      context: () => {
        throw new Error('unreachable: the handler must be skipped');
      },
    })) {
      bus.register(handler);
    }
    const result = await bus.dispatch(stored as NonNullable<typeof stored>);
    expect(result.status).toBe('completed');
    expect(harness.store.entries).toHaveLength(1);
  });
});

describe('the organisation timezone', () => {
  it('charges the day the organisation is in, not the one UTC is in', async () => {
    const harness = ledgerHarness();
    harness.store.seedTimezone(PROJECT, 'Europe/Prague');
    await harness.publish([runFinished({}, '2026-06-11T22:30:00.000Z')]);
    expect(harness.store.rollups[0]?.day).toBe('2026-06-12');
  });

  /**
   * The fail-open branch, asserted on **both** of its observable halves.
   *
   * The day is the effect; the warning is the only record that a substitution happened at all — no
   * ledger row carries the zone it was charged in (the residual stated at `usableTimezone`), so a
   * reconciliation that finds a day it did not expect has nothing but this line to explain it. A
   * test that asserted only the day would pass against a silent fallback, which is the version an
   * operator cannot debug.
   */
  it('falls back to UTC on a zone it cannot compute in, and says so by name', async () => {
    const harness = ledgerHarness();
    // A fixed offset: `assertTimeZone` refuses it, because it has no DST rules.
    harness.store.seedTimezone(PROJECT, '+02:00');
    await harness.publish([runFinished({}, '2026-06-11T22:30:00.000Z')]);
    expect(harness.store.rollups[0]?.day).toBe('2026-06-11');
    expect(harness.store.entries).toHaveLength(1);

    const warned = harness.logs.find(
      (line) => line.level === 'warn' && line.message.includes('not an IANA zone'),
    );
    expect(warned).toBeDefined();
    expect(warned?.fields).toMatchObject({ timezone: '+02:00', fallback: 'UTC' });
  });

  it('says nothing about the zone when it is usable (standing rule 10)', async () => {
    const harness = ledgerHarness();
    harness.store.seedTimezone(PROJECT, 'Europe/Prague');
    await harness.publish([runFinished({}, '2026-06-11T22:30:00.000Z')]);
    // Scoped to the zone: this run's model has no price row in the harness, so the ledger warns
    // about *that* — a bare "no warnings" assertion would be asserting the wrong silence.
    expect(harness.logs.filter((line) => line.message.includes('IANA zone'))).toEqual([]);
    expect(harness.store.rollups[0]?.day).toBe('2026-06-12');
  });
});

describe('the budgets projection (BD-010, product/09)', () => {
  const withBudget = (limitUsd: number, notifyPct: readonly number[] = [50, 80]) => {
    const harness = ledgerHarness();
    harness.store.seedBudget({
      id: BUDGET,
      scope: 'project',
      scopeId: PROJECT,
      projectId: PROJECT,
      window: 'month',
      limitUsd,
      notifyPct,
    });
    return harness;
  };

  it('folds the run’s spend into the window', async () => {
    const harness = withBudget(100);
    await harness.publish([runFinished({})]);
    expect(harness.store.windows).toMatchObject([
      { budgetId: BUDGET, spentUsd: 2.5, windowStart: '2026-06-01T00:00:00.000Z' },
    ]);
  });

  it('says nothing below the first threshold, and announces it at the crossing', async () => {
    const harness = withBudget(10, [50]);
    await harness.publish([runFinished({ cost: { usd: 4, is_estimate: false } })]);
    expect(harness.types()).not.toContain('budget.threshold.reached');

    await harness.publish([runFinished({ cost: { usd: 1, is_estimate: false } })]);
    expect(harness.types()).toContain('budget.threshold.reached');
    expect(harness.types()).not.toContain('budget.exhausted');
  });

  it('announces exhaustion at the limit, not one cent past it (standing rule 42)', async () => {
    const harness = withBudget(5, [50]);
    await harness.publish([runFinished({ cost: { usd: 4.999999, is_estimate: false } })]);
    expect(harness.types()).not.toContain('budget.exhausted');

    await harness.publish([runFinished({ cost: { usd: 0.000001, is_estimate: false } })]);
    expect(harness.types()).toContain('budget.exhausted');
  });

  it('announces each threshold once per window, however many runs cross it', async () => {
    const harness = withBudget(10, [50]);
    await harness.publish([runFinished({ cost: { usd: 6, is_estimate: false } })]);
    await harness.publish([runFinished({ cost: { usd: 1, is_estimate: false } })]);
    expect(harness.types().filter((type) => type === 'budget.threshold.reached')).toHaveLength(1);
  });

  it('starts a fresh window at the boundary, with its notifications reset', async () => {
    const harness = withBudget(10, [50]);
    await harness.publish([runFinished({ cost: { usd: 6, is_estimate: false } })]);
    await harness.publish([
      runFinished({ cost: { usd: 6, is_estimate: false } }, '2026-07-02T09:00:00.000Z'),
    ]);
    expect(harness.store.windows.map((row) => row.windowStart)).toEqual([
      '2026-06-01T00:00:00.000Z',
      '2026-07-01T00:00:00.000Z',
    ]);
    expect(harness.store.windows.map((row) => row.spentUsd)).toEqual([6, 6]);
    // Two crossings of 50 %, one per window: a threshold is per window, not per budget.
    expect(harness.types().filter((type) => type === 'budget.threshold.reached')).toHaveLength(2);
  });

  it('charges the organisation, the project and the task scopes together', async () => {
    const harness = ledgerHarness();
    harness.store.seedBudget({
      id: '00000000-0000-4000-8000-0000000000f2' as Id,
      scope: 'org',
      scopeId: null,
      projectId: null,
      window: 'day',
      limitUsd: 1000,
    });
    harness.store.seedBudget({
      id: BUDGET,
      scope: 'project',
      scopeId: PROJECT,
      projectId: PROJECT,
      window: 'month',
      limitUsd: 100,
    });
    harness.store.seedBudget({
      id: '00000000-0000-4000-8000-0000000000f3' as Id,
      scope: 'task',
      scopeId: TASK,
      projectId: PROJECT,
      window: 'total',
      limitUsd: 50,
    });
    await harness.publish([runFinished({})]);
    expect(harness.store.windows).toHaveLength(3);
    expect(harness.store.windows.every((row) => row.spentUsd === 2.5)).toBe(true);
  });

  it('does not charge a budget of another project', async () => {
    const harness = ledgerHarness();
    harness.store.seedBudget({
      id: BUDGET,
      scope: 'project',
      scopeId: '00000000-0000-4000-8000-0000000000b9' as Id,
      projectId: '00000000-0000-4000-8000-0000000000b9' as Id,
      window: 'month',
      limitUsd: 10,
    });
    await harness.publish([runFinished({})]);
    expect(harness.store.windows).toEqual([]);
  });
});

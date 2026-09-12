import type { Id, ModelUsage, TokenUsage } from '@platform/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PROPERTY_TEST_TIMEOUT_MS } from '../testing/property.js';
import {
  type CostLedgerEntry,
  ledgerEntriesForRun,
  type ReportedRunSpend,
  type RunCostContext,
  rollupDeltasFor,
  spendTotalUsd,
} from './ledger.js';
import type { PriceRates } from './pricing.js';
import { ZERO_TOKEN_USAGE } from './pricing.js';

const CONTEXT: RunCostContext = {
  runId: '00000000-0000-4000-8000-0000000000r1' as Id,
  taskId: '00000000-0000-4000-8000-0000000000t1' as Id,
  projectId: '00000000-0000-4000-8000-0000000000p1' as Id,
  orgId: '00000000-0000-4000-8000-0000000000o1' as Id,
  template: 'feature',
  stage: 'implementation',
  model: 'claude-opus-5',
};

const rates = (modelId: string): PriceRates => ({
  priceListId: `price-${modelId}`,
  modelId,
  input: 5,
  output: 25,
  cacheWrite5m: 6.25,
  cacheWrite1h: 10,
  cacheRead: 0.5,
});

const OPUS_ONLY = (model: string) => (model === 'claude-opus-5' ? rates(model) : null);
const ALL_PRICED = (model: string) => rates(model);
const NONE_PRICED = () => null;

const usage = (overrides: Partial<TokenUsage> = {}): TokenUsage => ({
  ...ZERO_TOKEN_USAGE,
  ...overrides,
});

const modelUsage = (model: string, tokens: Partial<TokenUsage>, usd: number): ModelUsage => ({
  model,
  ...usage(tokens),
  usd,
});

const spend = (overrides: Partial<ReportedRunSpend> = {}): ReportedRunSpend => ({
  usage: usage({ input_tokens: 1_000_000, output_tokens: 100_000 }),
  modelUsage: [],
  usd: 2.5,
  isEstimate: false,
  numTurns: 4,
  wallMs: 9_000,
  ...overrides,
});

describe('ledgerEntriesForRun — the reported branch', () => {
  it('writes one row carrying the invoice number when there is no per-model breakdown', () => {
    const derived = ledgerEntriesForRun(CONTEXT, spend(), OPUS_ONLY);
    expect(derived.reason).toBe('ok');
    expect(derived.entries).toHaveLength(1);
    const [entry] = derived.entries as [CostLedgerEntry];
    expect(entry.model).toBe('claude-opus-5');
    expect(entry.usd).toBe(2.5);
    expect(entry.isEstimate).toBe(false);
    expect(entry.usdReported).toBe(2.5);
    // The price table is still consulted, so the audit can compare the invoice with the estimate.
    expect(entry.usdEstimated).toBeCloseTo(7.5, 6);
    expect(entry.priceListId).toBe('price-claude-opus-5');
    expect(entry.primary).toBe(true);
  });

  it('splits the invoice across models and totals to it exactly', () => {
    const derived = ledgerEntriesForRun(
      CONTEXT,
      spend({
        usd: 3,
        modelUsage: [
          modelUsage('claude-opus-5', { input_tokens: 400_000 }, 1.999_999),
          modelUsage('claude-haiku-4-5', { input_tokens: 200_000 }, 0.9),
        ],
      }),
      ALL_PRICED,
    );
    expect(derived.entries.map((entry) => entry.model)).toEqual([
      'claude-opus-5',
      'claude-haiku-4-5',
    ]);
    expect(spendTotalUsd(derived.entries)).toBe(3);
    // The residual lands on the run's own model, and is reported rather than smoothed away.
    expect(derived.residualUsd).toBeCloseTo(0.100_001, 6);
    expect(derived.entries[0]?.primary).toBe(true);
    expect(derived.entries[1]?.primary).toBe(false);
  });

  it('keeps a model with no price row, because the invoice does not need the table', () => {
    const derived = ledgerEntriesForRun(
      CONTEXT,
      spend({
        usd: 2,
        modelUsage: [
          modelUsage('claude-opus-5', { input_tokens: 100_000 }, 1.5),
          modelUsage('some-new-model', { input_tokens: 10_000 }, 0.5),
        ],
      }),
      OPUS_ONLY,
    );
    expect(derived.entries).toHaveLength(2);
    expect(derived.unpricedModels).toEqual(['some-new-model']);
    expect(derived.entries[1]?.usdEstimated).toBeNull();
    expect(spendTotalUsd(derived.entries)).toBe(2);
  });
});

describe('ledgerEntriesForRun — the estimated branch (BD-011, BD-004 local mode)', () => {
  it('prices from the table when the producer says the cost is an estimate', () => {
    const derived = ledgerEntriesForRun(
      CONTEXT,
      spend({ usd: 0, isEstimate: true, usage: usage({ input_tokens: 2_000_000 }) }),
      OPUS_ONLY,
    );
    expect(derived.entries).toHaveLength(1);
    expect(derived.entries[0]?.isEstimate).toBe(true);
    expect(derived.entries[0]?.usd).toBe(10);
    expect(derived.entries[0]?.usdReported).toBeNull();
  });

  /**
   * WP-12's obligation on this work package, in the ledger's own terms: a run stopped because the
   * CLI reported no usable `total_cost_usd` is a **fault**, not an overspend. The ledger must not
   * count the cap as spend — and must not record a zero either, because the tokens were real.
   */
  it('prices a cost_unreported run from the table instead of counting zero or the cap', () => {
    const derived = ledgerEntriesForRun(
      CONTEXT,
      spend({ usd: 0, isEstimate: false, usage: usage({ input_tokens: 1_000_000 }) }),
      OPUS_ONLY,
    );
    expect(derived.reason).toBe('ok');
    expect(derived.entries[0]?.usd).toBe(5);
    expect(derived.entries[0]?.isEstimate).toBe(true);
  });

  it('refuses a model it cannot price rather than writing a zero row (standing rule 16)', () => {
    const derived = ledgerEntriesForRun(
      CONTEXT,
      spend({ usd: null, usage: usage({ input_tokens: 1_000 }) }),
      NONE_PRICED,
    );
    expect(derived.entries).toEqual([]);
    expect(derived.reason).toBe('unpriced');
    expect(derived.unpricedModels).toEqual(['claude-opus-5']);
    // The tokens were still consumed: usage is a measurement, pricing is an interpretation of it.
    expect(derived.modelUsage).toEqual([
      {
        model: 'claude-opus-5',
        usage: usage({ input_tokens: 1_000 }),
        usdReported: null,
        usdEstimated: null,
      },
    ]);
  });

  it('moves the counters to a surviving row when the primary model is the unpriced one', () => {
    const derived = ledgerEntriesForRun(
      { ...CONTEXT, model: 'some-new-model' },
      spend({
        usd: null,
        modelUsage: [
          modelUsage('some-new-model', { input_tokens: 1_000 }, 0),
          modelUsage('claude-opus-5', { input_tokens: 1_000_000 }, 0),
        ],
      }),
      OPUS_ONLY,
    );
    expect(derived.entries).toHaveLength(1);
    expect(derived.entries[0]?.model).toBe('claude-opus-5');
    expect(derived.entries[0]?.primary).toBe(true);
  });
});

describe('ledgerEntriesForRun — the cases with nothing to write', () => {
  it('writes nothing when the producer reported neither usage nor cost', () => {
    const derived = ledgerEntriesForRun(
      CONTEXT,
      spend({ usage: null, usd: null, modelUsage: [] }),
      ALL_PRICED,
    );
    expect(derived.entries).toEqual([]);
    expect(derived.reason).toBe('no_usage_and_no_cost');
  });

  it('writes nothing for a run that produced no tokens and cost nothing', () => {
    const derived = ledgerEntriesForRun(
      CONTEXT,
      spend({ usage: ZERO_TOKEN_USAGE, usd: 0 }),
      ALL_PRICED,
    );
    expect(derived.entries).toEqual([]);
    expect(derived.reason).toBe('no_spend');
  });

  it('does write a row for a reported cost with no tokens — the invoice is the truth', () => {
    const derived = ledgerEntriesForRun(
      CONTEXT,
      spend({ usage: ZERO_TOKEN_USAGE, usd: 0.05 }),
      ALL_PRICED,
    );
    expect(derived.entries).toHaveLength(1);
    expect(derived.entries[0]?.usd).toBe(0.05);
  });
});

describe('the model id is the only producer string the ledger stores, so it is bounded', () => {
  it('refuses an over-long model id rather than truncating it onto another model’s key', () => {
    const hostile = 'm'.repeat(129);
    const derived = ledgerEntriesForRun(
      CONTEXT,
      spend({
        usd: 2,
        modelUsage: [
          modelUsage('claude-opus-5', { input_tokens: 100_000 }, 1.5),
          modelUsage(hostile, { input_tokens: 10_000 }, 0.5),
        ],
      }),
      ALL_PRICED,
    );
    expect(derived.entries.map((entry) => entry.model)).toEqual(['claude-opus-5']);
    expect(derived.refusedModels).toEqual([hostile]);
    // The invoice still totals, because the residual lands on the surviving primary row.
    expect(spendTotalUsd(derived.entries)).toBe(2);
  });

  it('keeps a model id exactly at the bound (standing rule 42: assert both sides)', () => {
    const atBound = 'm'.repeat(128);
    const derived = ledgerEntriesForRun(
      { ...CONTEXT, model: atBound },
      spend({ usd: 1 }),
      ALL_PRICED,
    );
    expect(derived.entries.map((entry) => entry.model)).toEqual([atBound]);
    expect(derived.refusedModels).toEqual([]);
  });

  it('writes nothing at all when every model id is refused', () => {
    const derived = ledgerEntriesForRun(
      { ...CONTEXT, model: 'm'.repeat(200) },
      spend({ usd: 1 }),
      ALL_PRICED,
    );
    expect(derived.entries).toEqual([]);
    expect(derived.reason).toBe('model_id_refused');
  });
});

describe('a producer that reports one model twice', () => {
  /**
   * The rows are deduplicated by `cost_entries`' unique key and the rollup deltas are **summed**, so
   * a duplicate that reached both writes would break `sum(entries) = sum(rollups)` — the invariant
   * this ledger is measured by. It is folded here instead, so the invariant holds by construction.
   */
  it('folds the duplicate into one entry, summing its usage and its cost', () => {
    const derived = ledgerEntriesForRun(
      CONTEXT,
      spend({
        usd: 3,
        modelUsage: [
          modelUsage('claude-opus-5', { input_tokens: 400_000 }, 2),
          modelUsage('claude-opus-5', { input_tokens: 100_000, output_tokens: 7 }, 0.5),
        ],
      }),
      ALL_PRICED,
    );
    expect(derived.entries).toHaveLength(1);
    expect(derived.entries[0]?.usage).toEqual(usage({ input_tokens: 500_000, output_tokens: 7 }));
    // 2 + 0.5 reported, and the 0.5 residual to the invoice lands on the same (primary) row.
    expect(derived.entries[0]?.usdReported).toBeCloseTo(2.5, 6);
    expect(spendTotalUsd(derived.entries)).toBe(3);
    expect(derived.modelUsage).toHaveLength(1);

    const deltas = rollupDeltasFor(derived.entries, { numTurns: 1, wallMs: 1, day: '2026-09-12' });
    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.usd).toBe(spendTotalUsd(derived.entries));
  });

  it('keeps a reported nothing as nothing when both halves reported nothing', () => {
    const derived = ledgerEntriesForRun(
      CONTEXT,
      spend({
        usd: null,
        modelUsage: [
          modelUsage('claude-opus-5', { input_tokens: 1_000_000 }, 0),
          modelUsage('claude-opus-5', { input_tokens: 1_000_000 }, 0),
        ],
      }),
      ALL_PRICED,
    );
    expect(derived.entries).toHaveLength(1);
    expect(derived.entries[0]?.usdReported).toBeNull();
    // Priced from the folded usage: two million input tokens at 5 USD per million.
    expect(derived.entries[0]?.usd).toBe(10);
  });
});

describe('rollupDeltasFor', () => {
  it('counts the run, its turns and its wall time exactly once across models', () => {
    const derived = ledgerEntriesForRun(
      CONTEXT,
      spend({
        usd: 3,
        modelUsage: [
          modelUsage('claude-opus-5', { input_tokens: 400_000 }, 2),
          modelUsage('claude-haiku-4-5', { input_tokens: 200_000 }, 1),
        ],
      }),
      ALL_PRICED,
    );
    const deltas = rollupDeltasFor(derived.entries, {
      numTurns: 4,
      wallMs: 9_000,
      day: '2026-09-12',
    });
    expect(deltas).toHaveLength(2);
    expect(deltas.reduce((sum, delta) => sum + delta.runs, 0)).toBe(1);
    expect(deltas.reduce((sum, delta) => sum + delta.wallMs, 0)).toBe(9_000);
    expect(deltas.reduce((sum, delta) => sum + delta.turns, 0)).toBe(4);
    // The reconciliation the acceptance criterion names: entries and rollups carry one total.
    expect(deltas.reduce((sum, delta) => sum + delta.usd, 0)).toBe(spendTotalUsd(derived.entries));
    expect(deltas.every((delta) => delta.mode === 'actual')).toBe(true);
    expect(deltas.every((delta) => delta.day === '2026-09-12')).toBe(true);
  });

  it('labels priced rows `estimated`, which is the rollup’s own mode column', () => {
    const derived = ledgerEntriesForRun(
      CONTEXT,
      spend({ usd: null, usage: usage({ input_tokens: 1_000_000 }) }),
      ALL_PRICED,
    );
    const deltas = rollupDeltasFor(derived.entries, { numTurns: 1, wallMs: 1, day: '2026-09-12' });
    expect(deltas.every((delta) => delta.mode === 'estimated')).toBe(true);
  });
});

describe('the ledger totals to the reported cost, for any breakdown', () => {
  it(
    'sums to the invoice whatever the per-model numbers say',
    () => {
      const money = fc.integer({ min: 0, max: 1_000_000 }).map((cents) => cents / 10_000);
      fc.assert(
        fc.property(
          fc.double({ min: 0.000_001, max: 100, noNaN: true }),
          fc.array(fc.tuple(fc.string({ minLength: 1, maxLength: 6 }), money), {
            minLength: 0,
            maxLength: 4,
          }),
          (total, models) => {
            const unique = new Map(models);
            const derived = ledgerEntriesForRun(
              CONTEXT,
              spend({
                usd: total,
                modelUsage: [...unique].map(([model, usd]) =>
                  modelUsage(model, { input_tokens: 10 }, usd),
                ),
              }),
              ALL_PRICED,
            );
            const rounded = Math.round(total * 1_000_000) / 1_000_000;
            expect(spendTotalUsd(derived.entries)).toBeCloseTo(rounded, 6);
            expect(derived.entries.filter((entry) => entry.primary)).toHaveLength(1);
          },
        ),
      );
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );
});

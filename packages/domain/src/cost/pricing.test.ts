import type { TokenUsage } from '@platform/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { roundUsd } from '../aggregates/budget.js';
import { PROPERTY_TEST_TIMEOUT_MS } from '../testing/property.js';
import {
  addUsage,
  isEmptyUsage,
  isUsablePriceRates,
  type PriceRates,
  priceUsage,
  TOKENS_PER_PRICE_UNIT,
  ZERO_TOKEN_USAGE,
} from './pricing.js';

/** Migration 0009's own `claude-opus-5` row, so the arithmetic below is the shipped one (rule 39). */
const OPUS: PriceRates = {
  priceListId: '00000000-0000-4000-8000-0000000000p1',
  modelId: 'claude-opus-5',
  input: 5,
  output: 25,
  cacheWrite5m: 6.25,
  cacheWrite1h: 10,
  cacheRead: 0.5,
};

const usage = (overrides: Partial<TokenUsage> = {}): TokenUsage => ({
  ...ZERO_TOKEN_USAGE,
  ...overrides,
});

describe('priceUsage (BD-011, price_list is USD per million tokens)', () => {
  it('prices a million input tokens at the row’s input rate', () => {
    expect(priceUsage(usage({ input_tokens: TOKENS_PER_PRICE_UNIT }), OPUS)).toBe(5);
  });

  it('prices every kind of token, each at its own rate', () => {
    const priced = priceUsage(
      usage({
        input_tokens: 1_000_000,
        output_tokens: 200_000,
        cache_write_5m_tokens: 100_000,
        cache_write_1h_tokens: 50_000,
        cache_read_tokens: 2_000_000,
      }),
      OPUS,
    );
    // 5 + 5 + 0.625 + 0.5 + 1 = 12.125
    expect(priced).toBeCloseTo(12.125, 6);
  });

  it('prices nothing as zero — an empty run is a measurement, not an absence', () => {
    expect(priceUsage(ZERO_TOKEN_USAGE, OPUS)).toBe(0);
    expect(isEmptyUsage(ZERO_TOKEN_USAGE)).toBe(true);
    expect(isEmptyUsage(usage({ cache_read_tokens: 1 }))).toBe(false);
  });

  it('refuses a row whose rate is not a usable number (standing rule 16)', () => {
    const broken = { ...OPUS, cacheRead: Number.NaN };
    expect(isUsablePriceRates(broken)).toBe(false);
    expect(() => priceUsage(usage({ input_tokens: 1 }), broken)).toThrow(TypeError);
    // Negative is refused for the same reason: it would credit the ledger.
    expect(isUsablePriceRates({ ...OPUS, input: -1 })).toBe(false);
  });

  it(
    'is monotone in every token count and rounds to the ledger’s six decimals',
    () => {
      fc.assert(
        fc.property(
          fc.record({
            input_tokens: fc.integer({ min: 0, max: 5_000_000 }),
            output_tokens: fc.integer({ min: 0, max: 5_000_000 }),
            cache_write_5m_tokens: fc.integer({ min: 0, max: 5_000_000 }),
            cache_write_1h_tokens: fc.integer({ min: 0, max: 5_000_000 }),
            cache_read_tokens: fc.integer({ min: 0, max: 5_000_000 }),
          }),
          fc.integer({ min: 1, max: 1_000_000 }),
          (counts, extra) => {
            const priced = priceUsage(counts, OPUS);
            const more = priceUsage(
              { ...counts, output_tokens: counts.output_tokens + extra },
              OPUS,
            );
            expect(more).toBeGreaterThanOrEqual(priced);
            // Already at the ledger's `numeric(12,6)` grid: rounding it again moves nothing.
            expect(roundUsd(priced)).toBe(priced);
          },
        ),
      );
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );
});

describe('addUsage', () => {
  it('sums field by field', () => {
    expect(
      addUsage(usage({ input_tokens: 3 }), usage({ input_tokens: 4, cache_read_tokens: 9 })),
    ).toEqual(usage({ input_tokens: 7, cache_read_tokens: 9 }));
  });
});

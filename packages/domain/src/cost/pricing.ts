/**
 * Pricing token usage from the price table — BD-011, technical/03 § "Cost and governance".
 *
 * BD-011: "Store provider-reported cost and token counts per run as the source of truth. Maintain a
 * versioned price table … to compute live estimates during streaming and to compute *API-equivalent*
 * cost in `local` mode, always labelled *estimated*."
 *
 * Prices are **USD per million tokens** (`price_list`, migration 0009), which is how the vendor
 * publishes them. The division happens once, here, so no caller re-derives the factor.
 *
 * Nothing in this module reads a clock or a database: choosing *which* price row applies to a run
 * (`effective_from <= run.started_at`) is a query, and it lives in the store port.
 */
import type { TokenUsage } from '@platform/contracts';
import { roundUsd } from '../aggregates/budget.js';

/** Prices are quoted per million tokens. */
export const TOKENS_PER_PRICE_UNIT = 1_000_000;

/**
 * One `price_list` row, as the domain needs it.
 *
 * `id` travels with the rates because every `cost_entries` row records the price list version it
 * was computed from (technical/03: "derived data carries the price-list version it was built
 * from"), so an operator who corrects a price can tell which rows were priced with the wrong one.
 */
export interface PriceRates {
  readonly priceListId: string;
  readonly modelId: string;
  readonly input: number;
  readonly output: number;
  readonly cacheWrite5m: number;
  readonly cacheWrite1h: number;
  readonly cacheRead: number;
}

/**
 * Refuses a rate that is not a finite, non-negative number.
 *
 * The rows come from a database column an operator can edit, and a `NaN` compares false against
 * every ceiling (standing rule 16) — a price that cannot be read must stop the estimate rather than
 * silently produce one.
 */
export const isUsablePriceRates = (rates: PriceRates): boolean =>
  [rates.input, rates.output, rates.cacheWrite5m, rates.cacheWrite1h, rates.cacheRead].every(
    (rate) => Number.isFinite(rate) && rate >= 0,
  );

/**
 * USD for one run's token usage at these rates, rounded to the `numeric(12,6)` the ledger stores.
 *
 * @throws {TypeError} when a rate is absent or unusable — an unpriced model is answered by the
 * caller with *no ledger row*, never with a zero one (standing rule 16: a missing number is not
 * zero, and a zero-cost row is indistinguishable from a free run).
 */
export const priceUsage = (usage: TokenUsage, rates: PriceRates): number => {
  if (!isUsablePriceRates(rates)) {
    throw new TypeError(
      `price list row ${rates.priceListId} for "${rates.modelId}" has an unusable rate`,
    );
  }
  const usd =
    (usage.input_tokens * rates.input +
      usage.output_tokens * rates.output +
      usage.cache_write_5m_tokens * rates.cacheWrite5m +
      usage.cache_write_1h_tokens * rates.cacheWrite1h +
      usage.cache_read_tokens * rates.cacheRead) /
    TOKENS_PER_PRICE_UNIT;
  return roundUsd(usd);
};

/** True when nothing was consumed: the run produced no tokens of any kind. */
export const isEmptyUsage = (usage: TokenUsage): boolean =>
  usage.input_tokens === 0 &&
  usage.output_tokens === 0 &&
  usage.cache_write_5m_tokens === 0 &&
  usage.cache_write_1h_tokens === 0 &&
  usage.cache_read_tokens === 0;

/** Field-wise sum, for folding several models' usage back into a run total. */
export const addUsage = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  input_tokens: a.input_tokens + b.input_tokens,
  output_tokens: a.output_tokens + b.output_tokens,
  cache_write_5m_tokens: a.cache_write_5m_tokens + b.cache_write_5m_tokens,
  cache_write_1h_tokens: a.cache_write_1h_tokens + b.cache_write_1h_tokens,
  cache_read_tokens: a.cache_read_tokens + b.cache_read_tokens,
});

export const ZERO_TOKEN_USAGE: TokenUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_write_5m_tokens: 0,
  cache_write_1h_tokens: 0,
  cache_read_tokens: 0,
};

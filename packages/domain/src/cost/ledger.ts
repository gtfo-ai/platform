/**
 * What one finished run owes the cost ledger — technical/03 § "Cost and governance", BD-011.
 *
 * `cost_entries` is "an append-only ledger (one per run per model)", so the job of this module is to
 * turn the `run.finished` / `run.failed` payload into those rows, and to be explicit about the cases
 * where there is **nothing to write**. That is the whole reason it is a pure function with an
 * enumerated outcome rather than a few lines inside the handler.
 *
 * ## The branches, enumerated (standing rule 68)
 *
 * | the producer reported | the ledger writes |
 * |---|---|
 * | neither usage nor cost (`run.failed` carries both as nullish) | nothing, `no_usage_and_no_cost` |
 * | zero tokens and zero USD | nothing, `no_spend` — a run that never started is not a free run |
 * | a positive `total_cost_usd`, `is_estimate: false` | **reported** rows summing to that number |
 * | `is_estimate: true` (BD-004 `local` mode) | **estimated** rows priced from the price table |
 * | tokens but no usable cost (WP-12's `cost_unreported`) | **estimated** rows, same path |
 * | a model with no price row | no row for that model, and its name in `unpricedModels` |
 * | a model id past {@link MAX_LEDGER_MODEL_ID_LENGTH} | no row, and its name in `refusedModels` |
 *
 * Two of those are standing rule 16 in the place it was earned: WP-12's budget watchdog was silent
 * at `NaN > 0.01` because `total_cost_usd` may be **absent**, and the review that found it left this
 * work package the obligation *"WP-19 must not count a `cost_unreported` run as spend"*. A missing
 * number is therefore never a zero row here: it is either priced from the table and labelled an
 * estimate, or refused and named.
 *
 * ## Why the rows sum to the run's reported cost
 *
 * The provider reports a run total **and** a per-model breakdown, and the two need not agree to the
 * last microdollar — they are rounded independently. The ledger's invariant is that
 * `sum(entries.usd)` is the run's reported cost, because that is the number an invoice can be
 * reconciled against (BD-011: "provider-reported cost is truth"); the per-model residual is
 * attributed to the **primary** entry rather than dropped. `residualUsd` on the derivation says how
 * much was moved, so a producer whose breakdown drifts is visible instead of quietly smoothed.
 */
import type { Id, ModelUsage, TokenUsage } from '@platform/contracts';
import { roundUsd } from '../aggregates/budget.js';
import {
  addUsage,
  isEmptyUsage,
  type PriceRates,
  priceUsage,
  ZERO_TOKEN_USAGE,
} from './pricing.js';

/** The run's own row, as the ledger needs it: `run.finished` carries neither model nor stage. */
export interface RunCostContext {
  readonly runId: Id;
  readonly taskId: Id;
  readonly projectId: Id;
  readonly orgId: Id;
  /** `tasks.template` — part of the rollup's key, so a template's cost is a query. */
  readonly template: string;
  /** The stage slug the run belongs to; runs outside a stage record `(none)`. */
  readonly stage: string;
  /** `runs.model` — the model the platform asked for, and the primary entry's model. */
  readonly model: string;
}

/** What the producer said the run cost. `null` fields are absences, never zeros. */
export interface ReportedRunSpend {
  readonly usage: TokenUsage | null;
  readonly modelUsage: readonly ModelUsage[];
  readonly usd: number | null;
  readonly isEstimate: boolean;
  readonly numTurns: number;
  readonly wallMs: number;
}

export interface CostLedgerEntry {
  readonly runId: Id;
  readonly taskId: Id;
  readonly projectId: Id;
  readonly orgId: Id;
  readonly template: string;
  readonly stage: string;
  readonly model: string;
  readonly usage: TokenUsage;
  /** What the ledger counts as spent: reported when there is a report, priced when there is not. */
  readonly usd: number;
  readonly isEstimate: boolean;
  readonly priceListId: string | null;
  /** The provider's own per-model number, when it gave one. */
  readonly usdReported: number | null;
  /** The price table's number, when a row covered this model at this instant. */
  readonly usdEstimated: number | null;
  /**
   * The run's own model row. It carries `runs`, `turns` and `wall_ms` into the rollup, so a
   * two-model run counts as **one** run and one wall time rather than two of each.
   */
  readonly primary: boolean;
}

export type LedgerReason =
  | 'ok'
  | 'no_usage_and_no_cost'
  | 'no_spend'
  | 'unpriced'
  | 'model_id_refused';

/**
 * One `run_model_usage` row's worth of facts, derived whether or not the model got a ledger row.
 *
 * Usage is a **measurement** and pricing is an interpretation of it, so a model the price table
 * cannot price still has its tokens recorded — with `usdEstimated: null` rather than `0`, which is
 * the distinction standing rule 18 exists for.
 */
export interface DerivedModelUsage {
  readonly model: string;
  readonly usage: TokenUsage;
  readonly usdReported: number | null;
  readonly usdEstimated: number | null;
}

export interface LedgerDerivation {
  readonly entries: readonly CostLedgerEntry[];
  /** Every storable model's usage, including models that produced no ledger row. */
  readonly modelUsage: readonly DerivedModelUsage[];
  /** Models the price table could not price at this instant; each one lost its row. */
  readonly unpricedModels: readonly string[];
  /** Model ids too long or empty to be an identifier; see {@link isStorableModelId}. */
  readonly refusedModels: readonly string[];
  readonly reason: LedgerReason;
  /** USD moved onto the primary entry so the rows sum to the reported total. */
  readonly residualUsd: number;
}

/**
 * The longest model id the ledger will key a row on.
 *
 * `modelUsageSchema.model` is `nonEmptyStringSchema` — **unbounded** — and it is the only string in
 * the `run.finished` payload that reaches a ledger row at all (everything else the ledger stores is
 * a number or an id the platform minted). A producer is not the platform (BD-022): the value comes
 * off the CLI's result line, so it is bounded here rather than trusted. Vendor ids run to about 30
 * characters; 128 is four times the longest one shipped.
 *
 * A value past the bound is **refused, not truncated**: truncation is many-to-one, so two models
 * whose ids agree on their first 128 characters would collapse onto one ledger key and one rollup
 * row — the same argument that refuses a redacted idempotency key (technical/06).
 */
export const MAX_LEDGER_MODEL_ID_LENGTH = 128;

export const isStorableModelId = (model: string): boolean =>
  model.length > 0 && model.length <= MAX_LEDGER_MODEL_ID_LENGTH;

/** Prices for one model at one instant, or `null` when the table has no row for it. */
export type PriceLookup = (model: string) => PriceRates | null;

const usageOf = (model: ModelUsage): TokenUsage => ({
  input_tokens: model.input_tokens,
  output_tokens: model.output_tokens,
  cache_write_5m_tokens: model.cache_write_5m_tokens,
  cache_write_1h_tokens: model.cache_write_1h_tokens,
  cache_read_tokens: model.cache_read_tokens,
});

const tokenWeight = (usage: TokenUsage): number =>
  usage.input_tokens +
  usage.output_tokens +
  usage.cache_write_5m_tokens +
  usage.cache_write_1h_tokens +
  usage.cache_read_tokens;

/**
 * Which row carries the run's own counters.
 *
 * The run's declared model wins; otherwise the heaviest usage, with the model name as the
 * tie-break so the choice is deterministic for a producer that reports two identical models (which
 * would otherwise make a backfill disagree with the original write).
 */
const primaryIndexOf = (
  models: readonly { readonly model: string; readonly usage: TokenUsage }[],
  runModel: string,
): number => {
  const declared = models.findIndex((entry) => entry.model === runModel);
  if (declared >= 0) {
    return declared;
  }
  let best = 0;
  for (let index = 1; index < models.length; index += 1) {
    const candidate = models[index] as { model: string; usage: TokenUsage };
    const incumbent = models[best] as { model: string; usage: TokenUsage };
    const byWeight = tokenWeight(candidate.usage) - tokenWeight(incumbent.usage);
    if (byWeight > 0 || (byWeight === 0 && candidate.model < incumbent.model)) {
      best = index;
    }
  }
  return best;
};

/**
 * Folds a producer that reported one model twice into one entry.
 *
 * `cost_entries` is keyed `(run_id, model, created_at)` and the rollup is keyed
 * `(project, day, template, stage, model, mode)`, so a duplicate would be **deduplicated by the
 * database on one side and summed on the other** — and `sum(entries) = sum(rollups)`, the invariant
 * this work package is measured by, would be false for that run. Making it impossible here costs
 * eight lines; leaving it to the unique key makes the ledger's headline property depend on a
 * producer's good manners.
 *
 * Unreachable from `normaliseModelUsage` today, which builds from `Object.entries` — but "today" is
 * a fact about one caller, and the invariant is a fact about the ledger (standing rule 44).
 */
const foldByModel = (
  split: readonly {
    readonly model: string;
    readonly usage: TokenUsage;
    readonly usd: number | null;
  }[],
): readonly {
  readonly model: string;
  readonly usage: TokenUsage;
  readonly usd: number | null;
}[] => {
  const folded = new Map<string, { model: string; usage: TokenUsage; usd: number | null }>();
  for (const entry of split) {
    const seen = folded.get(entry.model);
    if (seen === undefined) {
      folded.set(entry.model, { ...entry });
      continue;
    }
    seen.usage = addUsage(seen.usage, entry.usage);
    // `null` is "the producer reported no cost for this model", so two nulls stay null and a number
    // beside a null is the number — never `0 + n`, which would read as a reported zero.
    seen.usd = seen.usd === null ? entry.usd : roundUsd(seen.usd + (entry.usd ?? 0));
  }
  return [...folded.values()];
};

/** The per-model split, or the run's single model when the producer reported no breakdown. */
const splitOf = (
  context: RunCostContext,
  spend: ReportedRunSpend,
): readonly {
  readonly model: string;
  readonly usage: TokenUsage;
  readonly usd: number | null;
}[] =>
  spend.modelUsage.length > 0
    ? spend.modelUsage.map((model) => ({
        model: model.model,
        usage: usageOf(model),
        usd: model.usd > 0 ? model.usd : null,
      }))
    : [
        {
          model: context.model,
          usage: spend.usage ?? ZERO_TOKEN_USAGE,
          usd: spend.usd !== null && spend.usd > 0 ? spend.usd : null,
        },
      ];

/**
 * The ledger rows one run owes, and why there are none when there are none.
 *
 * @param at the instant the price lookup was made against — the run's start, per technical/03
 *   ("pick the row with `effective_from <= run.started_at`"). Passed in rather than read, because
 *   this ring has no clock.
 */
export const ledgerEntriesForRun = (
  context: RunCostContext,
  spend: ReportedRunSpend,
  prices: PriceLookup,
): LedgerDerivation => {
  const refusedModels = [
    ...(spend.modelUsage.length > 0
      ? spend.modelUsage.map((model) => model.model)
      : [context.model]),
  ].filter((model) => !isStorableModelId(model));
  const nothing = (reason: LedgerReason, unpriced: readonly string[] = []): LedgerDerivation => ({
    entries: [],
    modelUsage: [],
    unpricedModels: unpriced,
    refusedModels,
    reason,
    residualUsd: 0,
  });

  if (spend.usage === null && spend.usd === null && spend.modelUsage.length === 0) {
    return nothing('no_usage_and_no_cost');
  }
  const split = foldByModel(
    splitOf(context, spend).filter((entry) => isStorableModelId(entry.model)),
  );
  if (split.length === 0) {
    return nothing('model_id_refused');
  }
  const anyTokens = split.some((entry) => !isEmptyUsage(entry.usage));
  const reportedTotal = spend.usd !== null && spend.usd > 0 && !spend.isEstimate ? spend.usd : null;
  if (!anyTokens && reportedTotal === null) {
    return nothing('no_spend');
  }

  const base = {
    runId: context.runId,
    taskId: context.taskId,
    projectId: context.projectId,
    orgId: context.orgId,
    template: context.template,
    stage: context.stage,
  };
  const unpriced: string[] = [];
  const priced = split.map((entry) => {
    const rates = prices(entry.model);
    const estimated = rates === null ? null : priceUsage(entry.usage, rates);
    if (rates === null) {
      unpriced.push(entry.model);
    }
    return { ...entry, rates, estimated };
  });

  const primary = primaryIndexOf(split, context.model);
  const modelUsage: readonly DerivedModelUsage[] = priced.map((entry) => ({
    model: entry.model,
    usage: entry.usage,
    usdReported: entry.usd,
    usdEstimated: entry.estimated,
  }));

  // ── reported: the invoice number is the total, and the breakdown splits it ────────────────
  if (reportedTotal !== null) {
    const declared = priced.map((entry) => entry.usd ?? 0);
    const declaredSum = roundUsd(declared.reduce((sum, usd) => sum + usd, 0));
    const residual = roundUsd(reportedTotal - declaredSum);
    const entries = priced.map((entry, index) => ({
      ...base,
      model: entry.model,
      usage: entry.usage,
      usd: roundUsd((entry.usd ?? 0) + (index === primary ? residual : 0)),
      isEstimate: false,
      priceListId: entry.rates?.priceListId ?? null,
      usdReported: entry.usd,
      usdEstimated: entry.estimated,
      primary: index === primary,
    }));
    return {
      entries,
      modelUsage,
      unpricedModels: unpriced,
      refusedModels,
      reason: 'ok',
      residualUsd: residual,
    };
  }

  // ── estimated: no usable invoice number, so the price table answers (BD-011) ──────────────
  const entries = priced
    .filter((entry) => entry.estimated !== null)
    .map((entry) => ({
      ...base,
      model: entry.model,
      usage: entry.usage,
      usd: entry.estimated as number,
      isEstimate: true,
      priceListId: entry.rates?.priceListId ?? null,
      usdReported: entry.usd,
      usdEstimated: entry.estimated,
      primary: split[primary]?.model === entry.model,
    }));
  if (entries.length === 0) {
    // No ledger row — but the tokens were still consumed, so `run_model_usage` keeps them and the
    // caller logs the unpriced models by name.
    return {
      entries: [],
      modelUsage,
      unpricedModels: unpriced,
      refusedModels,
      reason: 'unpriced',
      residualUsd: 0,
    };
  }
  // The primary model may be the unpriced one; the counters still have to land somewhere, so the
  // first surviving row takes them. Without this a two-model run whose primary is unpriced would
  // record no `runs` and no `wall_ms` at all.
  const withPrimary = entries.some((entry) => entry.primary)
    ? entries
    : entries.map((entry, index) => ({ ...entry, primary: index === 0 }));
  return {
    entries: withPrimary,
    modelUsage,
    unpricedModels: unpriced,
    refusedModels,
    reason: 'ok',
    residualUsd: 0,
  };
};

/** What one run adds to `cost_rollup_daily`, one delta per `(template, stage, model, mode)`. */
export interface RollupDelta {
  readonly orgId: Id;
  readonly projectId: Id;
  readonly template: string;
  readonly stage: string;
  readonly model: string;
  /** `YYYY-MM-DD` in the organisation's timezone — the caller's calendar, not this ring's. */
  readonly day: string;
  readonly mode: 'actual' | 'estimated';
  readonly runs: number;
  readonly usage: TokenUsage;
  readonly usd: number;
  readonly wallMs: number;
  readonly turns: number;
}

/**
 * Folds a run's entries into rollup deltas.
 *
 * `runs`, `wall_ms` and `turns` are the **run's** facts and land on the primary entry only, so
 * summing the rollup over a day gives the number of runs and the wall time, not a multiple of them.
 * The token and USD columns are per entry, which is what makes `sum(cost_entries.usd)` equal
 * `sum(cost_rollup_daily.usd)` — the reconciliation this work package is measured by.
 */
export const rollupDeltasFor = (
  entries: readonly CostLedgerEntry[],
  run: { readonly numTurns: number; readonly wallMs: number; readonly day: string },
): readonly RollupDelta[] =>
  entries.map((entry) => ({
    orgId: entry.orgId,
    projectId: entry.projectId,
    template: entry.template,
    stage: entry.stage,
    model: entry.model,
    day: run.day,
    mode: entry.isEstimate ? ('estimated' as const) : ('actual' as const),
    runs: entry.primary ? 1 : 0,
    usage: entry.usage,
    usd: entry.usd,
    wallMs: entry.primary ? run.wallMs : 0,
    turns: entry.primary ? run.numTurns : 0,
  }));

/** What the run spent in total, for the budget projection. */
export const spendTotalUsd = (entries: readonly CostLedgerEntry[]): number =>
  roundUsd(entries.reduce((sum, entry) => sum + entry.usd, 0));

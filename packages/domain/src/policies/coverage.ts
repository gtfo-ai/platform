/**
 * The coverage delta — product/18:38 (*"Test coverage change of the MR shown in Checks when the
 * project's CI reports coverage"*, default *"on when available"*, configuration *"coverage
 * source"*) and product/10:38's Checks item, WP-39.
 *
 * Three schemas have carried the head number since WP-09 — `MergeRequest.coverage_pct`,
 * `PipelineStatus.coverage_pct` and the `ci.pipeline.finished` payload — and there was no delta,
 * because nothing stored the **second** number. This module is the arithmetic and the default; the
 * reads, the cache and the storage are `packages/application/src/pipeline/coverage.ts`.
 *
 * ## One percentage, not a per-file map
 *
 * A provider reports **one** coverage figure per pipeline. Per-file coverage lives in the coverage
 * *artifact*, which is what `GitProviderCapabilities.coverageArtifacts` is about and which nothing
 * in this build downloads — so a "coverage delta" here is one number for the whole change, and
 * product/10:38's Checks item is met to exactly that extent. The configuration key says the same
 * thing from the other side: `policies.coverage_source` has no `artifact` value.
 *
 * ## Percentage points, and why the subtraction is worth a function
 *
 * Two coverage percentages subtract to a number of percentage **points** — 81.5 % against 79.0 % is
 * `+2.5 pp`, not "+2.5 %" and not "+3 % more covered". The rounding is here rather than at the
 * three call sites because binary floating point makes `81.5 - 79.0` print as `2.5` and
 * `81.4 - 79.1` print as `2.3000000000000114`, and a maintainer reading a merge-readiness panel
 * should not be shown fifteen decimal places of IEEE-754.
 */
import type { PoliciesConfig } from '@platform/contracts';

/**
 * product/18:38's *"on when available"*, as the value the shipped configuration carries.
 *
 * It lives here beside the reader rather than only in `PLATFORM_DEFAULT_CONFIG`, for the reason
 * `DEFAULT_ASK_BUDGET_USD` does: the merge is not the only path to this value — a project settings
 * port built from `{}` (every unit test, and `defaultProjectSettings`) never sees the platform
 * layer at all, so a reader that fell back to `undefined` would behave as though a project had
 * turned the feature off. One spelling, two readers (standing rule 41).
 */
export const DEFAULT_COVERAGE_SOURCE = 'pipeline' as const;

export type CoverageSource = NonNullable<PoliciesConfig['coverage_source']>;

/**
 * Where this project's coverage number comes from, defaulted.
 *
 * Takes the `policies` block rather than the whole configuration so that the domain ring states
 * what it reads; the caller in the application ring does the `config.policies` hop.
 */
export const coverageSourceOf = (policies: PoliciesConfig | undefined): CoverageSource =>
  policies?.coverage_source ?? DEFAULT_COVERAGE_SOURCE;

/** Percentage points, rounded to two decimals; `null` unless **both** sides are numbers. */
export const coverageDeltaPoints = (
  headPct: number | null,
  basePct: number | null,
): number | null => {
  if (headPct === null || basePct === null) {
    return null;
  }
  // `Math.round` over a scaled value rather than `toFixed`, which returns a string and rounds
  // half-away-from-zero on a decimal the double does not hold exactly. Negative zero is folded
  // into zero: `-0` serialises as `-0` in JSON and would render as "−0.0 pp" on the panel, which
  // reads as a loss that did not happen.
  const points = Math.round((headPct - basePct) * 100) / 100;
  return points === 0 ? 0 : points;
};

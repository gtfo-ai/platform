/**
 * The cost estimate a task gets at refinement — product/09 § "Budgets":
 * *"each task gets a cost estimate at refinement (size × project history); an optional per-project
 * threshold routes expensive tasks to budget approval by a maintainer before Implementation."*
 *
 * The product documents say **"size × project history"** and nothing more, so the model below is a
 * recommendation implemented under **Q65** rather than a specification read off a page. What it is
 * *not* allowed to be is a guess dressed as a number: a project with no finished task has no
 * history, and this returns `null` with `basis: 'unknown'` rather than a default anybody could
 * mistake for a measurement (standing rule 16 — a missing number is not zero, and an estimate of
 * zero would route every task past a budget approval).
 *
 * ## The model, in one line
 *
 * `estimate = mean over the sample of (actual cost ÷ the sample's size weight) × this size's weight`
 *
 * So the history does not have to contain tasks of *this* size — which matters, because the first
 * `XL` of a project arrives after a dozen `M`s and product/09 asks for an estimate at refinement
 * anyway. When every sample *is* this size, the formula collapses to the plain mean, which is the
 * property test that pins it.
 *
 * The weights are a straight doubling per step. They are a stated assumption, not a measurement:
 * BD-013's model defaults were accepted "provisionally; revisit after 20 dogfood tasks" (Q23) and
 * the same applies here. `estimateAccuracy` exists so the revisit has a number to work from.
 */
import type { Size } from '@platform/contracts';
import { roundUsd } from '../aggregates/budget.js';

/**
 * Relative effort per size step. Assumption (Q65), doubling per step: an `XL` is eight `S`s.
 *
 * Every weight is positive, which the estimate relies on — a zero weight would divide a sample's
 * cost by nothing.
 */
export const SIZE_COST_WEIGHTS: Readonly<Record<Size, number>> = { S: 1, M: 2, L: 4, XL: 8 };

/** One finished task, as the estimator reads it. */
export interface TaskCostSample {
  readonly size: Size;
  /** `tasks.cost_actual` — what the task really spent. */
  readonly costUsd: number;
}

/**
 * Where the number came from, so a reader never has to guess whether an estimate is informed.
 *
 * `project_history` is the product's own answer; `org_history` is the fallback for a project's
 * first task, which is exactly when an estimate is least informed and most wanted; `unknown` is the
 * refusal.
 */
export type EstimateBasis = 'project_history' | 'org_history' | 'unknown';

export interface TaskCostEstimate {
  /** USD, or `null` when there is nothing to estimate from. */
  readonly usd: number | null;
  readonly basis: EstimateBasis;
  /** How many finished tasks the number rests on. Zero exactly when `basis` is `unknown`. */
  readonly samples: number;
}

/** A sample teaches nothing unless it finished with a real, positive spend. */
const isUsableSample = (sample: TaskCostSample): boolean =>
  Number.isFinite(sample.costUsd) && sample.costUsd > 0 && SIZE_COST_WEIGHTS[sample.size] > 0;

/** Mean cost per unit of size weight, or `null` when the sample teaches nothing. */
const unitCostOf = (samples: readonly TaskCostSample[]): number | null => {
  const usable = samples.filter(isUsableSample);
  if (usable.length === 0) {
    return null;
  }
  const total = usable.reduce(
    (sum, sample) => sum + sample.costUsd / SIZE_COST_WEIGHTS[sample.size],
    0,
  );
  return total / usable.length;
};

export interface EstimateHistory {
  /** Finished tasks of this project. */
  readonly project: readonly TaskCostSample[];
  /** Finished tasks of the organisation, this project's included; used when the project has none. */
  readonly org: readonly TaskCostSample[];
}

/**
 * The estimate for a task of `size`, and the basis it rests on.
 *
 * Deterministic and total: every input produces an answer, and the one answer it will not produce
 * is a number with no evidence behind it.
 */
export const estimateTaskCostUsd = (size: Size, history: EstimateHistory): TaskCostEstimate => {
  const weight = SIZE_COST_WEIGHTS[size];
  const fromProject = unitCostOf(history.project);
  if (fromProject !== null) {
    return {
      usd: roundUsd(fromProject * weight),
      basis: 'project_history',
      samples: history.project.filter(isUsableSample).length,
    };
  }
  const fromOrg = unitCostOf(history.org);
  if (fromOrg !== null) {
    return {
      usd: roundUsd(fromOrg * weight),
      basis: 'org_history',
      samples: history.org.filter(isUsableSample).length,
    };
  }
  return { usd: null, basis: 'unknown', samples: 0 };
};

/**
 * Estimate accuracy — product/09: *"Estimate accuracy is tracked."*
 *
 * The ratio of actual to estimate, so 1 is perfect, 2 is twice the estimate and 0.5 is half. `null`
 * when either side is missing or the estimate was zero: a task with no estimate has no accuracy,
 * and dividing by zero would report `Infinity` as a data point.
 *
 * It needs no storage of its own — `tasks.estimate_usd` and `tasks.cost_actual` are both on the
 * row — which is why this is a function and not a table.
 */
export const estimateAccuracy = (
  estimateUsd: number | null,
  actualUsd: number | null,
): number | null => {
  if (
    estimateUsd === null ||
    actualUsd === null ||
    !Number.isFinite(estimateUsd) ||
    !Number.isFinite(actualUsd) ||
    estimateUsd <= 0
  ) {
    return null;
  }
  return actualUsd / estimateUsd;
};

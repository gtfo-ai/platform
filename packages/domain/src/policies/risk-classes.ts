/**
 * product/19 §14 / BD-030 — *"MRs labelled with risk classes from touched paths (auth, payments,
 * migrations, infra) that can force plan approval, a named reviewer or a stricter review
 * checklist"*.
 *
 * `policies.risk_classes` has been in the configuration schema since WP-01 and nothing read it; this
 * is its first reader, and it answers one of the three requirements the document lists —
 * `plan_approval` — because that is the one the pipeline has a gate for (`planApprovalGate`).
 * `reviewer:@handle` and `checklist:<name>` are parsed by `riskRequirementSchema` and have no
 * consumer; that is recorded rather than silently dropped, in `AUTONOMY_POLICY_READERS`'s shape.
 *
 * ## Which paths, and the residual that comes with them
 *
 * The paths are the **Implementation Plan's** `files_to_change[].path` — the first moment the
 * platform knows what a task will touch, and the moment plan approval is decided, so the class is
 * available exactly when it is needed. The authoritative source product/19 §14 names is the merge
 * request's own diff, which arrives later and is not read by anything today.
 *
 * That difference has a direction, and it is the safe one: a plan is written by a model, so a model
 * that **omits** a path escapes the class and the task is *not* gated — never the reverse. A model
 * cannot use this to skip a gate it would otherwise get, because the classes only ever add
 * approvals. A path that the implementation touches and the plan did not name is therefore the open
 * case, and closing it is a read of the merge request's changed files at the rebase gate, where
 * WP-26 already fetches them.
 *
 * Nothing here is case-folded, for {@link pathMatchesPattern}'s stated reason: a missed match costs
 * an approval that is not asked for, never a write that should not happen.
 */
import type { RiskClass } from '@platform/contracts';
import { pathMatchesPattern } from './path-patterns.js';

/** Which of a project's declared risk classes the given paths fall into, in declaration order. */
export const riskClassesForPaths = (
  classes: Readonly<Record<string, RiskClass>> | undefined,
  paths: readonly string[],
): readonly string[] => {
  if (classes === undefined) {
    return [];
  }
  return Object.entries(classes)
    .filter(([, declared]) =>
      declared.paths.some((pattern) => paths.some((path) => pathMatchesPattern(pattern, path))),
    )
    .map(([name]) => name);
};

/**
 * The subset of {@link riskClassesForPaths} whose `require` list asks for a plan approval.
 *
 * Separate from the match itself because the other two requirements product/19 §14 defines —
 * `reviewer:@handle` and `checklist:<name>` — have no consumer in this build, and a function that
 * returned "the classes that matched" would read as if all three were acted on.
 */
export const riskClassesRequiringPlanApproval = (
  classes: Readonly<Record<string, RiskClass>> | undefined,
  paths: readonly string[],
): readonly string[] =>
  riskClassesForPaths(classes, paths).filter((name) =>
    (classes?.[name]?.require ?? []).includes('plan_approval'),
  );

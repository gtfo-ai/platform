/**
 * Who reviews a merge request — product/19:138, BD-030 (WP-37).
 *
 * One sentence fixes the whole of it: *"CODEOWNERS match first, then project `reviewers` config,
 * then the requesting human as fallback; risk classes add required reviewers rather than replace."*
 * This module is that sentence as a pure function, so the three steps can be asserted separately
 * and the "add rather than replace" half cannot quietly become "replace" in a refactor.
 *
 * ## What it does not do
 *
 * **It resolves nothing.** CODEOWNERS carries handles (`@dana`, `@team/security`, an email address)
 * and a provider's merge-request API wants its own account identifiers — GitLab's takes
 * `reviewer_ids` and nothing else. Turning one into the other is I/O, so it belongs to the
 * `risk_route` duty (`packages/application/src/pipeline/risk-routing.ts`), which reports every
 * handle it could not resolve **by name** and assigns nobody for it. A handle this function returns
 * is therefore a *routing decision*, not an assignment.
 *
 * ## The CODEOWNERS matcher, and the two places it is deliberately narrower than GitLab's
 *
 * Patterns are read with {@link pathMatchesPattern}, the same matcher `protected_paths` and
 * `risk_classes.*.paths` use — one syntax, one implementation (standing rule 41). Two documented
 * CODEOWNERS constructs are **not** honoured, and both fail in the direction that costs a reviewer
 * rather than a write:
 *
 *  - a `!` exclusion is read as an ordinary pattern, which then matches nothing (no path begins
 *    with `!`), so an exclusion silently excludes — which is what it was written to do;
 *  - a character class (`[abc]*.ts`) never reaches here at all: `parseCodeowners` reads a line
 *    opening with `[` as a section heading, which is what GitLab's own parser does.
 *
 * A leading `/` is stripped because CODEOWNERS anchors at the repository root and the platform's
 * paths are already repository-relative; `docs/` and `docs/**` are the same instruction to
 * {@link pathMatchesPattern} already.
 *
 * **The last matching rule wins**, which is GitLab's documented precedence
 * (<https://docs.gitlab.com/user/project/codeowners/reference/>, retrieved 2026-09-10 by WP-09's
 * parser, whose own test pins that it keeps later rules rather than deduplicating: *"precedence is
 * the caller's to apply"*). This is that caller.
 */
import { pathMatchesPattern } from './path-patterns.js';

/**
 * The shape of a parsed `CODEOWNERS` file, structurally rather than by import.
 *
 * `codeownersRulesSchema` lives on the git-provider **port**, in `packages/application`, which this
 * ring may not import (the dependency rule: `domain ← application`). Declaring the two fields it
 * reads keeps the matcher in the ring that has no I/O, and the port's own type satisfies it.
 */
export interface CodeownersRuleSet {
  readonly rules: readonly {
    readonly pattern: string;
    readonly owners: readonly string[];
  }[];
}

/** Which step of product/19:138's precedence produced the base reviewers. */
export type ReviewerRoutingSource = 'codeowners' | 'project_config' | 'requester' | 'none';

export interface ReviewerRouting {
  readonly source: ReviewerRoutingSource;
  /** What the precedence chose, before risk classes add anything. */
  readonly base: readonly string[];
  /** What the matched risk classes require on top (`reviewer:@handle`). */
  readonly required: readonly string[];
  /** `base` then `required`, de-duplicated in that order and capped at `limit`. */
  readonly handles: readonly string[];
  /** True when the cap dropped a handle, so "nobody else" is never mistaken for "nobody more". */
  readonly truncated: boolean;
}

const ownersOf = (rules: CodeownersRuleSet, path: string): readonly string[] => {
  let owners: readonly string[] = [];
  for (const rule of rules.rules) {
    // Last match wins, so the loop never breaks early.
    if (pathMatchesPattern(rule.pattern.replace(/^\/+/, ''), path)) {
      owners = rule.owners;
    }
  }
  return owners;
};

/**
 * The owners of every changed path, in the order the paths were given.
 *
 * A merge request touching two owned areas routes to both: CODEOWNERS answers per path, and taking
 * only the first path's owners would hide the second area's owner behind file order.
 */
export const codeownersFor = (
  rules: CodeownersRuleSet | null,
  paths: readonly string[],
): readonly string[] => {
  if (rules === null) {
    return [];
  }
  const found: string[] = [];
  for (const path of paths) {
    for (const owner of ownersOf(rules, path)) {
      if (!found.includes(owner)) {
        found.push(owner);
      }
    }
  }
  return found;
};

/**
 * product/19:138's three steps, in the document's order, plus the class requirements.
 *
 * `requester` is the *provider account* of the human who asked for the task, already resolved
 * through the identity mapping — `null` when there is none, which on this build is every task
 * (`tasks.requested_by_user_id` has no writer, and `user_identities` is empty until an operator
 * fills it: PROGRESS backlog 79). The caller says so by name rather than assigning silently, which
 * is why this returns `source: 'none'` instead of an empty list with no explanation.
 */
export const resolveReviewerRouting = (input: {
  readonly codeowners: readonly string[];
  readonly configured: readonly string[];
  readonly requester: string | null;
  readonly classReviewers: readonly string[];
  readonly limit: number;
}): ReviewerRouting => {
  const base =
    input.codeowners.length > 0
      ? { source: 'codeowners' as const, handles: input.codeowners }
      : input.configured.length > 0
        ? { source: 'project_config' as const, handles: input.configured }
        : input.requester !== null
          ? { source: 'requester' as const, handles: [input.requester] }
          : { source: 'none' as const, handles: [] as readonly string[] };

  // Risk classes **add**: they are appended to whatever the precedence chose and never replace it,
  // so a class and a CODEOWNERS entry that disagree produce both.
  const all: string[] = [];
  for (const handle of [...base.handles, ...input.classReviewers]) {
    if (!all.includes(handle)) {
      all.push(handle);
    }
  }
  const limit = Math.max(input.limit, 0);
  return {
    source: base.source,
    base: [...base.handles],
    required: [...new Set(input.classReviewers)],
    handles: all.slice(0, limit),
    truncated: all.length > limit,
  };
};

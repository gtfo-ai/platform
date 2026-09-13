/**
 * Review-only mode's two decisions, as pure functions (WP-24).
 *
 * product/18 § "Opt-in features": *"The Reviewer stage on human-authored MRs (label, path or all
 * MRs), posting findings as discussion threads and a neutral summary that never blocks merge"*,
 * configured with *"trigger (label / all MRs / paths), severity floor for posting (default
 * `major`), max findings per MR (default 10)"*. product/04 § "Operating modes that reuse stages"
 * is the same sentence from the pipeline's side: *"the Code review stage alone, on human MRs"*.
 *
 * Two questions, and both are decided here rather than in the saga so they can be enumerated
 * rather than sampled:
 *
 *  1. **does this merge request match the project's filter** ({@link mergeRequestMatchesFilter});
 *  2. **which of the model's findings are posted, and in which order** ({@link selectFindings}).
 *
 * Neither touches a clock, a provider or a store. The application ring supplies the configuration
 * and the merge request; what it gets back is a verdict with a *reason*, because "nothing happened"
 * is the answer a non-matching merge request must produce and an operator still has to be able to
 * read why (standing rule 18: the absent case must not be the quiet one).
 */
import type { ReviewFinding, Severity } from '@platform/contracts';
import { pathMatchesPattern } from './path-patterns.js';

/** product/18: *"severity floor for posting (default `major`)"*. */
export const DEFAULT_REVIEW_SEVERITY_FLOOR: Severity = 'major';

/** product/18: *"max findings per MR (default 10)"*. */
export const DEFAULT_MAX_REVIEW_FINDINGS = 10;

/** product/18's trigger: *"label / all MRs / paths"*. */
export type ReviewOnlyTrigger = 'label' | 'all' | 'paths';

/** The project's `features.review_only`, resolved (the effective config always fills it in). */
export interface ReviewOnlySettings {
  readonly enabled: boolean;
  readonly trigger: ReviewOnlyTrigger;
  /** The label a `label` trigger looks for. Compared case-insensitively; see below. */
  readonly label: string;
  /** The globs a `paths` trigger looks for, in technical/12's syntax. */
  readonly paths: readonly string[];
  readonly severityFloor: Severity;
  readonly maxFindings: number;
}

/** What the filter needs to know about the merge request; all of it is provider text (BD-022). */
export interface ReviewOnlyCandidate {
  readonly labels: readonly string[];
  /**
   * The paths the merge request touches, or `null` when the platform did not read the diff.
   *
   * Required and nullable rather than optional, for the reason `PromptTask.ticketSnapshot` is:
   * `null` means *the platform could not read the changed files*, which is a different fact from a
   * merge request that changes none, and an optional field lets a caller mean the second by
   * forgetting the first.
   */
  readonly changedPaths: readonly string[] | null;
}

export type ReviewOnlyMatch =
  | { readonly matched: true; readonly reason: string }
  | { readonly matched: false; readonly reason: string };

/**
 * Labels are compared **case-insensitively and after trimming**, because a human types them.
 *
 * GitLab and GitHub both preserve the case an author typed and neither treats `Agentic-Review` as a
 * different label from `agentic-review` in its own UI search. Folding here costs a false *match* —
 * a project whose two labels differ only in case gets a review it asked for under the other
 * spelling — which is the direction that does not silently do nothing (standing rule 20 applies to
 * the *mutation* this triggers, and the mutation is a comment on a merge request, not a write).
 */
const sameLabel = (left: string, right: string): boolean =>
  left.trim().toLowerCase() === right.trim().toLowerCase();

/**
 * Does the project's filter select this merge request?
 *
 * Never throws, and answers `false` with a reason for every way a filter can fail to decide —
 * including a `paths` trigger on a merge request whose diff the platform could not read, which is
 * refused rather than treated as "no paths changed, therefore no match by luck". The two spellings
 * are indistinguishable to a caller that only looks at the boolean, and only one of them is worth
 * an operator's attention.
 */
export const mergeRequestMatchesFilter = (
  settings: ReviewOnlySettings,
  candidate: ReviewOnlyCandidate,
): ReviewOnlyMatch => {
  if (!settings.enabled) {
    return { matched: false, reason: 'review-only mode is not enabled for this project' };
  }
  switch (settings.trigger) {
    case 'all':
      return { matched: true, reason: 'the project reviews every merge request' };
    case 'label': {
      const matched = candidate.labels.some((label) => sameLabel(label, settings.label));
      return matched
        ? { matched: true, reason: `the merge request carries the label "${settings.label}"` }
        : {
            matched: false,
            reason: `the merge request does not carry the label "${settings.label}"`,
          };
    }
    default: {
      if (candidate.changedPaths === null) {
        return {
          matched: false,
          reason: 'the merge request’s changed files could not be read, so no path could match',
        };
      }
      if (settings.paths.length === 0) {
        return {
          matched: false,
          reason: 'the project triggers on paths and has configured none',
        };
      }
      const hit = settings.paths.find((pattern) =>
        (candidate.changedPaths ?? []).some((path) => pathMatchesPattern(pattern, path)),
      );
      return hit === undefined
        ? { matched: false, reason: 'no changed file matches the configured paths' }
        : { matched: true, reason: `a changed file matches "${hit}"` };
    }
  }
};

/** Most severe first, so a cut by `max_findings` drops the least important (product/18). */
const SEVERITY_ORDER: readonly Severity[] = ['blocker', 'major', 'minor', 'nit'];

export const severityRank = (severity: Severity): number => SEVERITY_ORDER.indexOf(severity);

/**
 * One finding to post, carrying **the position it held in the artifact the model produced**.
 *
 * The position is the platform's own identity for a finding, and it exists because
 * `reviewFindingSchema.id` is `nonEmptyStringSchema` — a string the model chose, with no uniqueness
 * asked for anywhere in the reviewer's prompt. Two findings that share an id are two findings; a
 * caller that identifies them by `finding.id` has one. The application ring builds the per-thread
 * idempotency key out of {@link SelectedFinding.index} for exactly that reason
 * (`pipeline/review-only.ts` § `reviewFindingIdempotencyKey`), so this field is part of the contract
 * rather than a convenience.
 */
export interface SelectedFinding {
  /**
   * The finding's index in the array the model returned — **not** its place in the posting order.
   *
   * Both cuts below reorder and drop; the index is taken before either, so it does not move when a
   * project changes its severity floor or its cap, and two selections of the same artifact give the
   * same finding the same number.
   */
  readonly index: number;
  readonly finding: ReviewFinding;
}

/** What {@link selectFindings} decided, including what it dropped and why. */
export interface SelectedFindings {
  /** In posting order: most severe first, then the model's own order within a severity. */
  readonly posted: readonly SelectedFinding[];
  /** Findings below the severity floor. */
  readonly belowFloor: number;
  /** Findings at or above the floor that did not fit under `max_findings`. */
  readonly overFlow: number;
}

/**
 * The findings a review-only run posts, from the ones the model returned.
 *
 * Two cuts, in this order and never the other way round: the **floor** first, because product/18
 * configures a severity floor "for posting" and a `nit` should not consume the budget a `blocker`
 * needs; then the **cap**, over what survived. Reversing them would let twenty nits crowd out a
 * blocker and still report "10 posted", which is the shape of a limit that silently inverts its own
 * purpose.
 *
 * The sort is **stable**: `Array.prototype.sort` is required to be stable since ES2019, so findings
 * of equal severity keep the order the model chose, which is the only ordering information it gave.
 *
 * Each survivor keeps {@link SelectedFinding.index}, its place in `findings` **before** either cut —
 * the number the caller identifies a thread by, and the one thing about a finding the model did not
 * write.
 */
export const selectFindings = (
  findings: readonly ReviewFinding[],
  settings: Pick<ReviewOnlySettings, 'severityFloor' | 'maxFindings'>,
): SelectedFindings => {
  const floor = severityRank(settings.severityFloor);
  const atOrAbove = findings
    .map((finding, index): SelectedFinding => ({ index, finding }))
    .filter((entry) => severityRank(entry.finding.severity) <= floor);
  const ordered = [...atOrAbove].sort(
    (left, right) => severityRank(left.finding.severity) - severityRank(right.finding.severity),
  );
  const posted = ordered.slice(0, Math.max(0, settings.maxFindings));
  return {
    posted,
    belowFloor: findings.length - atOrAbove.length,
    overFlow: ordered.length - posted.length,
  };
};

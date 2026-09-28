/**
 * **BD-024's tamper check, as part of the CI gate's read** — WP-81, PROGRESS backlog 95 (its last
 * item), BD-024 §2: *"modifications or deletions of existing tests and of CI/lint configuration are
 * flagged by the CI gate/reviewer as blockers unless the plan explicitly listed them with a reason,
 * and the Code review must confirm the reason."* product/04 S4 puts it in the CI gate.
 *
 * It is **deterministic** — a comparison of three lists, never a model's opinion — and it is **not
 * a stage**: the CI gate computes it when its pipeline is terminal, and a failure is the gate's
 * failure (technical/02 has the inputs and the endings; this docblock has the reasoning).
 *
 * ## The three inputs
 *
 *  - **The changed paths of existing files** ({@link changedExistingPaths}): the paths the merge
 *    request's diff lists at the live head that were **modified or deleted**, and the **old** name
 *    of a rename (moving a protected test away is deleting it). An **added** file is not flagged —
 *    BD-024 §2 reads *"modifications or deletions of existing tests and of CI/lint configuration"*,
 *    and "existing" qualifies both halves; §3 *requires* a bug fix to add a test, and every feature
 *    is expected to add them, so counting additions would return nearly every task (orchestrator's
 *    ruling, WP-81 round 1). That includes a new `.github/workflows/*.yml`. The status is read fail
 *    closed (standing rule 20): a file is treated as added only when the provider says
 *    `new_file: true` and neither renamed nor deleted it — a missing or contradictory status reads as
 *    modified, and a file whose two names differ without a rename flag counts under both. Read
 *    through the one coalesced diff read every other duty at that revision shares
 *    (`diff-coalescer.ts`, WP-59), so the gate costs no second download within the window.
 *    **The same policy at write time** (WP-99): the workspace's path guard (`path-guard.ts`) allows
 *    a write that creates a protected path and holds a write to an existing one to the plan's
 *    declaration, read through {@link exceptionsOf} below — so the guard and this gate cannot read
 *    two different plans. Until WP-99 the guard refused a new file too (PROGRESS backlog 279).
 *  - **The effective protected paths** (`effectiveProtectedPaths`, the planner's own list).
 *  - **The declared and confirmed exceptions**: the latest Implementation Plan's
 *    `protected_path_changes[].path`, of which a path is excused only when the latest Review
 *    Verdict's `protected_path_changes_confirmed` also matches it — the two halves of BD-024's
 *    *"listed … and the Code review must confirm"*.
 *
 * Patterns are read with `pathMatchesPattern`, technical/12's syntax, with **no case folding** —
 * unlike `path-guard.ts`, which folds because the filesystem underneath may alias two spellings of
 * one file. A diff lists the repository's own paths, which are exact.
 *
 * ## "Confirmed" needs a review to have happened
 *
 * Every shipped template runs `ci_gate` **before** `code_review`, so on the first pass there is no
 * Review Verdict of the current change to confirm anything. The latest verdict counts as a judgement
 * of the change only when it is **newer than the latest Implementation Notes** — the Developer's
 * report after its push — which is the artifact order the store keeps. A declared path with no such
 * verdict is excused **provisionally** (`awaiting_review`): the gate passes and records no
 * `ci_head_sha`, so the rebase gate re-enters `ci_gate` before Ready and this check is made again
 * with the verdict in hand (technical/02; the cheaper alternative is Q109). A declared path a newer
 * verdict did not confirm is a failure like an undeclared one.
 *
 * ## What it refuses to guess
 *
 * The caller reads the inputs and this function judges them; the reader in `gates.ts` never turns an
 * unreadable input into an empty one (standing rule 20). An empty diff is *not yet computed*, not
 * *nothing changed* (GitLab computes it asynchronously — the coalescer's own docblock), and a diff
 * at the read's bound hides the rest.
 */

import { implementationPlanDataSchema, reviewVerdictDataSchema } from '@platform/contracts';
import { pathMatchesPattern } from '@platform/domain';
import type { FileDiff } from '../ports/integrations/git-provider.js';
import type { StoredArtifact } from './store.js';

export interface TamperInputs {
  /** {@link changedExistingPaths} of the diff, unredacted, because they are matched. */
  readonly changedPaths: readonly string[];
  readonly protectedPaths: readonly string[];
  /** The latest plan's `protected_path_changes[].path`. */
  readonly declared: readonly string[];
  /** The latest Review Verdict's `protected_path_changes_confirmed`, when it judged this change. */
  readonly confirmed: readonly string[];
  /** A Review Verdict newer than the latest Implementation Notes exists. */
  readonly reviewed: boolean;
}

export type TamperVerdict =
  /** No protected path changed, or every one was declared and confirmed. */
  | { readonly kind: 'clean' }
  /** Every protected path changed was declared; the review has not judged the change yet. */
  | { readonly kind: 'awaiting_review'; readonly paths: readonly string[] }
  /** A protected path changed that was not declared, or that a review did not confirm. */
  | {
      readonly kind: 'changed';
      readonly undeclared: readonly string[];
      readonly unconfirmed: readonly string[];
    };

/**
 * The paths of a diff that name an **existing** file the change modified, deleted or renamed away
 * — the tamper check's first input (the module docblock has the ruling and the fail-closed reading
 * of a missing status).
 */
export const changedExistingPaths = (
  files: readonly Pick<
    FileDiff,
    'new_path' | 'old_path' | 'new_file' | 'renamed_file' | 'deleted_file'
  >[],
): readonly string[] =>
  files.flatMap((file) => {
    const renamed = file.renamed_file === true;
    const deleted = file.deleted_file === true;
    if (file.new_file === true && !renamed && !deleted) {
      return [];
    }
    if (renamed && !deleted) {
      return [file.old_path];
    }
    return file.old_path === file.new_path ? [file.new_path] : [file.old_path, file.new_path];
  });

const matchesAny = (patterns: readonly string[], path: string): boolean =>
  patterns.some((pattern) => pathMatchesPattern(pattern, path));

/**
 * changed ∩ protected, minus declared-and-confirmed. Pure and total, so every branch is a unit
 * case (`tamper.test.ts`) and the saga cases drive it through the gate.
 */
export const judgeTamper = (inputs: TamperInputs): TamperVerdict => {
  const touched = [...new Set(inputs.changedPaths)]
    .filter((path) => matchesAny(inputs.protectedPaths, path))
    .sort();
  const undeclared = touched.filter((path) => !matchesAny(inputs.declared, path));
  const declared = touched.filter((path) => matchesAny(inputs.declared, path));
  const unconfirmed = declared.filter((path) => !matchesAny(inputs.confirmed, path));
  if (undeclared.length > 0) {
    return { kind: 'changed', undeclared, unconfirmed: inputs.reviewed ? unconfirmed : [] };
  }
  if (unconfirmed.length === 0) {
    return { kind: 'clean' };
  }
  return inputs.reviewed
    ? { kind: 'changed', undeclared: [], unconfirmed }
    : { kind: 'awaiting_review', paths: unconfirmed };
};

/**
 * The declared and confirmed lists out of a task's artifacts, in the store's order (oldest first,
 * `ArtifactRepository.listFor`).
 *
 * An artifact whose body does not parse contributes **nothing** — no declaration and no
 * confirmation — which can only make the check stricter (every artifact was validated when it was
 * written, so this is a row from an older schema, not a model's output).
 */
export const exceptionsOf = (
  artifacts: readonly StoredArtifact[],
): Pick<TamperInputs, 'declared' | 'confirmed' | 'reviewed'> => {
  const lastIndexOf = (type: StoredArtifact['type']): number =>
    artifacts.reduce((found, artifact, index) => (artifact.type === type ? index : found), -1);
  const planAt = lastIndexOf('ImplementationPlan');
  const reviewAt = lastIndexOf('ReviewVerdict');
  const notesAt = lastIndexOf('ImplementationNotes');
  const plan =
    planAt < 0 ? null : implementationPlanDataSchema.safeParse(artifacts[planAt]?.data).data;
  const review =
    reviewAt < 0 ? null : reviewVerdictDataSchema.safeParse(artifacts[reviewAt]?.data).data;
  const reviewed = review != null && reviewAt > notesAt;
  return {
    declared: (plan?.protected_path_changes ?? []).map((change) => change.path),
    confirmed: reviewed ? (review?.protected_path_changes_confirmed ?? []) : [],
    reviewed,
  };
};

/**
 * Every path, redacted (a path is provider text). None is left out: the diff read is bounded at
 * `MAX_CONFLICT_FILES`, so the list is too, and a reason longer than the prompt's cap is cut by the
 * assembler, which announces it in the marker — a platform `and N more` would be a line in the body.
 */
const named = (paths: readonly string[], redact: (text: string) => string): string =>
  paths.map((path) => redact(path)).join(', ');

/**
 * The platform's sentence for a failed tamper check — the start of the return reason, naming the
 * paths (redacted: a path is provider text) and which half of BD-024 each failed.
 */
export const tamperFailureDetail = (
  verdict: Extract<TamperVerdict, { kind: 'changed' }>,
  redact: (text: string) => string,
): string => {
  const parts = [
    ...(verdict.undeclared.length === 0
      ? []
      : [
          `changed protected paths the Implementation Plan does not declare in protected_path_changes: ${named(verdict.undeclared, redact)}`,
        ]),
    ...(verdict.unconfirmed.length === 0
      ? []
      : [
          `changed protected paths the plan declares but the Code review did not confirm in protected_path_changes_confirmed: ${named(verdict.unconfirmed, redact)}`,
        ]),
  ];
  return `tamper check failed (BD-024) — ${parts.join('; ')}. Revert these changes, or have the plan declare each one with its reason for the Code review to confirm.`;
};

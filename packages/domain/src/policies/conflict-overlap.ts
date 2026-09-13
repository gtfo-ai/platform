/**
 * Which files two concurrent tasks both touch — product/04 S6b's *"The board warns when two active
 * tasks touch the same files"* and BD-030's *"conflict warnings between concurrent tasks"* (WP-26).
 *
 * It is the whole of the computation, and it is pure: the caller reads two merge requests' changed
 * paths from the git provider and this decides what to say about them. Three rules, each of which
 * is a decision rather than an implementation detail.
 *
 * **A path is compared as the provider spelled it, after normalisation to the *new* path.** A file
 * a merge request renamed has two names, and two tasks that both touch it — one before the rename,
 * one after — conflict exactly as two tasks touching one name do. So each side contributes both
 * `old_path` and `new_path`, and the intersection is over the union. The cost is stated: a file
 * *moved* by one task and *edited* by the other is reported under two paths rather than one, which
 * over-warns. Over-warning is the safe direction for a warning nothing branches on.
 *
 * **Case is significant, and directories are not compared.** `Src/a.ts` and `src/a.ts` are two
 * paths here, because the platform does not know whether the repository is on a case-folding
 * filesystem (standing rule 26's shape, in the direction that under-warns rather than inventing a
 * fold the repository may not have). Two tasks editing *different* files in one directory are not
 * an overlap: git merges those without a conflict, and a warning that fired on them would fire on
 * every pair of tasks in a small repository and be switched off.
 *
 * **`truncated` is a statement about the comparison, not about the result.** The caller bounds how
 * many files it reads per merge request, so an empty overlap can mean "nothing in common" or
 * "nothing in common *in what was read*". The two are different facts and the caller has to be able
 * to say which (standing rule 18: the absent case must not be the quiet one).
 */

/** One merge request's changed files, as the caller read them from the provider. */
export interface ChangedPaths {
  /** Paths after the change. */
  readonly newPaths: readonly string[];
  /** Paths before it; equal to the new path for a file that was not renamed. */
  readonly oldPaths: readonly string[];
  /** True when the provider had more files than the caller asked for. */
  readonly truncated: boolean;
}

/**
 * How many overlapping paths a warning names.
 *
 * Twenty is the same number `taskConflictWarnedEvent.paths` publishes, and it is a readability
 * bound rather than a safety one: a human reading *"touches the same files as ACME-9"* stops
 * reading long before twenty paths, and `path_count` carries the number that was found.
 */
export const MAX_OVERLAP_PATHS = 20;

/**
 * The longest path a warning repeats.
 *
 * A repository path is provider text (BD-022) and nothing bounds it upstream: POSIX allows 4 096
 * bytes and git itself allows more. 256 is `MAX_MR_REF_CHARS`, the bound review-only mode already
 * applies to a path it puts in a prompt, and using the same number keeps one answer for one kind of
 * string.
 */
export const MAX_OVERLAP_PATH_CHARS = 256;

export interface PathOverlap {
  /** The overlapping paths, sorted, bounded to {@link MAX_OVERLAP_PATHS}. */
  readonly paths: readonly string[];
  /** How many were **found** — not the length of `paths` when the list was cut. */
  readonly count: number;
  /** Either side's file list was cut before the comparison; see the module docblock. */
  readonly truncated: boolean;
}

const pathsOf = (side: ChangedPaths): ReadonlySet<string> =>
  new Set(
    [...side.newPaths, ...side.oldPaths]
      .map((path) => path.trim())
      .filter((path) => path.length > 0)
      .map((path) => path.slice(0, MAX_OVERLAP_PATH_CHARS)),
  );

/**
 * The files both merge requests touch.
 *
 * Sorted so that two runs over the same pair produce the same warning — an idempotent provider call
 * that posts a different body every time is a thread that churns somebody's merge request.
 */
export const pathOverlap = (left: ChangedPaths, right: ChangedPaths): PathOverlap => {
  const theirs = pathsOf(right);
  const shared = [...pathsOf(left)].filter((path) => theirs.has(path)).sort();
  return {
    paths: shared.slice(0, MAX_OVERLAP_PATHS),
    count: shared.length,
    truncated: left.truncated || right.truncated,
  };
};

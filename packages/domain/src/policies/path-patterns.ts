/**
 * One repository-path glob → one `RegExp`, for every consumer of technical/12's path lists.
 *
 * `protected_paths`, `risk_classes.*.paths` and — since WP-24 — `features.review_only.paths` are
 * all written in the same syntax, so they are read by the same function. It lived in
 * `packages/infrastructure/src/runner/path-guard.ts` until this work package needed it in the
 * domain ring as well; moving it rather than copying it is standing rule 41 (*a value bounded twice
 * has two untestable guards*) applied to a matcher: two implementations of one syntax agree until
 * the day somebody fixes one of them.
 *
 * ## The syntax, which is an operator's expectation and not a library's
 *
 * `**` crosses separators, `*` and `?` do not, and a pattern that names a directory (`infra/`,
 * `infra/**` or a bare `infra`) matches that directory and everything under it — that is how
 * `protected_paths` is written in technical/12 and how an operator expects it to read.
 *
 * ## What this does **not** do, stated because its first caller is a security guard
 *
 * It does no case folding and no Unicode normalisation. `path-guard.ts` folds both the pattern and
 * the path *before* calling this, with a fold measured against the filesystem, because there the
 * question is "may this run overwrite that file" and a missed equivalence is a protected file
 * written. WP-24's review-only filter does **not** fold, and that is a decision with a stated cost:
 * the question there is "is this human's merge request one the project asked to have reviewed", so
 * a missed match costs a review that does not happen — never a write that should not.
 */

/**
 * A private-use code point that stands in for `**` while the single-`*` pass runs.
 *
 * It cannot occur in a path pattern, whereas a space can — and a space as the placeholder turns
 * `my dir/*` into `my.*dir/[^/]*`. (U+0000 would do the same job and is a control character biome
 * rejects, and a literal NUL is refused by `nul:check` besides.)
 */
const DOUBLE_STAR = '\uE000';

/**
 * The stand-in for a double star followed by a separator, which matches **zero** or more
 * directories (technical/12's WP-81 amendment): the default `*.test.*` rule under any directory
 * names `totals.test.ts` at the root as well as `src/totals.test.ts`, and `a`, double star, `b`
 * names `a/b`. Until WP-81 it compiled to "any text, then a slash", which demands at least one
 * directory, so four of the default protected paths (the test, spec, `__tests__` and `migrations`
 * rules) missed a root-level file — measured, and a fail-open in both the workspace guard and the CI
 * gate's tamper check. (Spelled out in words because the glob itself would close this comment.)
 * U+E002, not U+E001: `path-guard.ts` folds a filesystem-produced solidus to U+E001 before it
 * calls this compiler, and that stand-in must stay a literal here.
 */
const DOUBLE_STAR_DIRECTORY = '\uE002';

export const pathPatternToRegExp = (pattern: string): RegExp => {
  // `infra/`, `infra/**` and `infra` are the same instruction. Trimming a trailing `/**` — not only
  // the trailing slashes — is what makes `infra/**` cover `infra` itself, which the sentence above
  // claims and the code did not do: the two regexes differed by the directory node.
  const trimmed = pattern.replace(/\/+$/, '').replace(/^(.+)\/\*\*$/, '$1');
  const escaped = trimmed.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const body = escaped
    .replace(/\*\*\//g, DOUBLE_STAR_DIRECTORY)
    .replace(/\*\*/g, DOUBLE_STAR)
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replaceAll(DOUBLE_STAR_DIRECTORY, '(?:.*/)?')
    .replaceAll(DOUBLE_STAR, '.*');
  // `infra` also matches `infra/anything`; `infra/**` already does on its own.
  return new RegExp(`^${body}(?:/.*)?$`);
};

/**
 * Does `relativePath` match `pattern`, byte for byte?
 *
 * The literal comparison. A caller that needs an equivalence class — anything deciding whether a
 * *write* is allowed — folds both sides first and uses {@link pathPatternToRegExp} directly, the
 * way `path-guard.ts` does.
 */
export const pathMatchesPattern = (pattern: string, relativePath: string): boolean =>
  pathPatternToRegExp(pattern).test(relativePath);

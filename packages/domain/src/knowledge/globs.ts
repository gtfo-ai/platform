/**
 * Glob matching for a knowledge document's `paths:` frontmatter — technical/07 step 1, "documents
 * whose `paths` globs match any touched path → score 1.0".
 *
 * **Why this is not `path-guard.ts`'s matcher, which does a similar job three rings away.** That
 * one is a *security* guard over BD-024's protected paths, and rules 15/26 made it fold Unicode
 * case the way the running filesystem does, because there the question is "could this write reach
 * the protected file" and the answer has to be conservative in the deny direction. This one answers
 * "is this lesson relevant", where a false positive costs a few hundred tokens of a context pack
 * and a false negative costs a missed lesson. Sharing an implementation would mean either giving a
 * relevance signal a filesystem-dependent fold — so that a pack's contents changed with the Node
 * build's Unicode tables — or giving a security guard a matcher tuned for recall. They are separate
 * on purpose, and each says so.
 *
 * The syntax is technical/12's, matching what an operator already writes in `protected_paths`:
 * `**` crosses separators, `*` and `?` do not, and a pattern naming a directory (`src/`, `src` and
 * the `/**` spelling) covers that directory and everything under it.
 */

/** Characters that must survive into the regex as literals. */
const REGEX_METACHARACTERS = /[.+^${}()|[\]\\]/g;

/**
 * A placeholder no repository path can contain, used to stage the `**` replacement.
 *
 * Written as the escape `\0` and never as a literal NUL byte. A literal one makes git classify
 * the blob as binary, so the change stops appearing in `git diff` and `grep -rn` skips the file
 * (CLAUDE.md, standing rule 30) — and this file was written with two literal NULs in it, which
 * `pnpm nul:check` did not catch because its scope is `git ls-files` and a new file is not yet
 * tracked. NUL is still the right sentinel, because no repository path can contain one; the
 * escape is the fix, not a different character.
 */
const CROSSING_WILDCARD = '\0crossing\0';

const globToRegExp = (pattern: string): RegExp => {
  // `src/`, `src/**` and `src` are the same instruction — trimming the trailing `/**` is what makes
  // `src/**` cover `src` itself, which `path-guard.ts` learned the same way.
  const trimmed = pattern.replace(/\/+$/, '').replace(/^(.+)\/\*\*$/, '$1');
  const escaped = trimmed.replace(REGEX_METACHARACTERS, '\\$&');
  const body = escaped
    .replace(/\*\*\/?/g, CROSSING_WILDCARD)
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replaceAll(CROSSING_WILDCARD, '(?:.*/)?');
  return new RegExp(`^${body}(?:/.*)?$`);
};

/** Repository paths are compared in POSIX form with no leading `./` or `/`. */
export const normaliseRepoPath = (candidate: string): string =>
  candidate.replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+/, '');

export const matchesRepoGlob = (pattern: string, candidate: string): boolean =>
  globToRegExp(normaliseRepoPath(pattern)).test(normaliseRepoPath(candidate));

/**
 * The candidates a set of globs matches.
 *
 * Returns the matches rather than a boolean so a caller can say *which* touched path made a
 * document relevant — the `reason` a context pack owes the audit (technical/12 § context pack) and
 * the evidence a reviewer needs when a pack looks wrong.
 */
export const matchingRepoPaths = (
  patterns: readonly string[],
  candidates: readonly string[],
): readonly string[] => {
  if (patterns.length === 0 || candidates.length === 0) return [];
  const compiled = patterns.map((pattern) => globToRegExp(normaliseRepoPath(pattern)));
  return candidates.filter((candidate) => {
    const normalised = normaliseRepoPath(candidate);
    return compiled.some((expression) => expression.test(normalised));
  });
};

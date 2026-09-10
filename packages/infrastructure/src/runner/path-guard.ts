/**
 * The `PreToolUse(Edit|Write)` path guard — technical/04:
 *
 * > path guard (workspace only; `.agentic/`, `.claude/`, `CLAUDE.md` writes flagged; secrets
 * > patterns in content denied).
 *
 * plus BD-024's protected paths, which technical/04 puts on the `Bash` hook in the same words:
 * "blocks writes outside the workspace and protected paths … unless the plan lists them".
 *
 * **This is the second line, not the first.** The container is: TD-021 mounts the workspace as the
 * only writable tree, so a write outside it fails on the filesystem whether or not this hook runs.
 * The guard exists because the container is not the thing the *model* is told, because `local`
 * provider mode has no container, and because a denial with a reason is what steers the agent back
 * — an EACCES is just a confusing tool error it will retry.
 *
 * **What it cannot do.** It resolves `..` and absolute paths, and it does not follow symlinks: that
 * needs a `realpath` on the *run's* filesystem, which is inside the container the platform is
 * deliberately outside of (TD-025). A symlink planted inside the workspace that points out of it
 * therefore passes this guard and is stopped by the mount. Written down rather than implied.
 *
 * **Protected paths have no such backstop.** The workspace *is* writable, so for BD-024's
 * `protected_paths` this guard is the whole enforcement rather than a second line, and everything
 * below is written for that: a path is compared in a folded form (see {@link matchesPathPattern})
 * because the filesystem underneath decides which names are the same file, and it is not the one
 * asking.
 */
import path from 'node:path';
import { detectSecrets } from '../redaction/pattern-redaction.js';

export type PathDecision = 'allow' | 'flag' | 'deny';

export interface PathVerdict {
  readonly decision: PathDecision;
  /** Empty for a plain allow; otherwise the text shown to the model and stored in the transcript. */
  readonly reason: string;
  /** The workspace-relative path the verdict is about, when one could be derived. */
  readonly relativePath: string | null;
}

/**
 * Configuration paths a task may edit but never quietly: `.agentic/` holds the rules that govern
 * the run, `.claude/` holds hooks and skills the SDK loads, and `CLAUDE.md` is instructions to
 * every later agent. BD-025 reads these from the default branch precisely so a task cannot change
 * the rules that judge it; a task that *edits* them is legitimate work that Code review must see.
 */
export const FLAGGED_CONFIG_PATHS: readonly string[] = ['.agentic/**', '.claude/**', 'CLAUDE.md'];

/**
 * Glob → RegExp for repository paths.
 *
 * `**` crosses separators, `*` and `?` do not, and a pattern that names a directory (`infra/`,
 * `infra/**` or a bare `infra`) matches that directory and everything under it — that is how
 * `protected_paths` is written in technical/12 and how an operator expects it to read.
 */
const globToRegExp = (pattern: string): RegExp => {
  // `infra/`, `infra/**` and `infra` are the same instruction. Trimming a trailing `/**` — not only
  // the trailing slashes — is what makes `infra/**` cover `infra` itself, which the sentence above
  // claims and the code did not do: the two regexes differed by the directory node.
  const trimmed = pattern.replace(/\/+$/, '').replace(/^(.+)\/\*\*$/, '$1');
  const escaped = trimmed.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  // A private-use code point stands in for `**` while the single-`*` pass runs. It cannot occur in
  // a path pattern, whereas a space can — and a space as the placeholder turns `my dir/*` into
  // `my.*dir/[^/]*`. (U+0000 would do the same job and is a control character biome rejects.)
  const body = escaped
    .replace(/\*\*/g, '\uE000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\uE000/g, '.*');
  // `infra` also matches `infra/anything`; `infra/**` already does on its own.
  return new RegExp(`^${body}(?:/.*)?$`);
};

/**
 * A private-use code point that stands in for a `/` **produced by the fold** rather than present in
 * the path. See {@link foldSegment}.
 *
 * **What matters is that it is a literal, not which literal it is.** Three values break it, each
 * differently: `/` is the fail-open the stand-in exists to prevent; `''` erases the character, so
 * `a\uFF0Fb.ts` and `ab.ts` become one path; and anything {@link globToRegExp} reads as syntax —
 * U+E000, which it uses for `**`, or `*`, or `?` — turns a *pattern* holding one of the folded
 * characters into a wildcard. Every other value only widens equality, which fails closed, and that
 * is why the review's `'*'` mutation survived all 77 tests. The three properties are pinned by
 * "pins the stand-in for a fold-produced solidus to a literal character" in `path-guard.test.ts`
 * rather than by this sentence.
 */
const FOLDED_SOLIDUS = '\uE001';

/**
 * Folds one path *segment* (a name between two `/`).
 *
 * NFKC, then lowercase, then `ß → ss`, and finally any `/` the first two steps *created* is pinned
 * to {@link FOLDED_SOLIDUS} so the fold can widen equality but never structure.
 *
 * `toLowerCase` is lowercase **mapping**; a filesystem compares with full case **folding**, which
 * decomposes further, and the difference is a set of protected paths that are not protected. Every
 * line below was settled by asking the volume — writing both names and comparing inodes — rather
 * than by reasoning about which Unicode operation ought to apply:
 *
 *  * `conﬁg` (U+FB01) **is** `config`, `ſecrets` (U+017F) **is** `secrets`, `aßets` **is**
 *    `assets` and `straße` **is** `strasse` on APFS: same inode, and the second write overwrote the
 *    first. `toLowerCase` alone folds none of the four. NFKC folds the ligatures and the long s;
 *    the sharp s it does **not** fold, hence the explicit expansion (which also covers `ẞ`
 *    U+1E9E, because `toLowerCase` maps it to `ß` first).
 *  * The volume keeps `ı` (U+0131) and `İ` (U+0130) apart from `i`, and so does this fold —
 *    `toLowerCase` rather than `toLocaleLowerCase`, so a Turkish server locale cannot change it.
 *  * `K` (U+212A), `Ω` (U+2126), `Å` (U+212B) and NFD spellings all collide on the volume and all
 *    fold here.
 *
 * **NFKC is wider than the filesystem**, deliberately: `x²`/`x2`, `Ⅸ`/`ix` and NBSP/space are
 * distinct files on APFS and the same string after this fold. That direction costs a false *deny*
 * plus a reason string the agent can act on, which is the trade BD-024 asks for — the same trade a
 * genuinely case-sensitive volume (Linux) buys with `INFRA/main.tf`.
 *
 * **The one place a wider fold would fail *open*** is the separator, which is why the last step
 * exists — and it is a *class*, not the character that was found first. Exactly five code points in
 * the whole of Unicode fold to something containing `/` (swept U+0001–U+10FFFF on Node 25.1,
 * ICU 77.1 / Unicode 16.0): U+FF0F FULLWIDTH SOLIDUS, and the four compatibility abbreviations
 * U+2100 `℀` → `a/c`, U+2101 `℁` → `a/s`, U+2105 `℅` → `c/o` and U+2106 `℆` → `c/u`. The volume
 * folds none of them: each is one ordinary file inside its directory, its own inode, its name
 * intact in `readdir`. Left as `/`, the fold would split such a name into two segments and
 * `src/*.ts`, whose `*` may not cross a separator, would stop matching `src/a℀b.ts` and answer
 * **allow** for a file the operator's glob covers. Pinning keeps the segment count of the folded
 * path equal to the segment count of the path, and it is written as a plain `replaceAll` so that a
 * sixth code point in a later Unicode version needs no change here. The cost is that a name
 * containing U+E001 literally folds together with the same name spelled with one of the five — a
 * widening, i.e. a false deny.
 */
const foldSegment = (segment: string): string =>
  segment.normalize('NFKC').toLowerCase().replaceAll('ß', 'ss').replaceAll('/', FOLDED_SOLIDUS);

/**
 * The form a path is compared in (see {@link foldSegment} for the fold itself and the evidence).
 *
 * **The guard may not inherit the filesystem's equivalence classes.** Whether `.ENV` and `.env` are
 * one file is decided by the volume, not by this code: APFS (macOS, the default) and NTFS are
 * case-insensitive, and APFS folds case *fully* and normalisation as well, so a write to `.ENV` —
 * or to a decomposed spelling of `.env`, or to `conﬁg/app.yaml` — **overwrites** the protected
 * file. A narrower match answers `allow` for a write that lands on it, and since protected paths
 * have no container backstop (the workspace mount is writable) that is the whole of BD-024 failing
 * open. It is not hypothetical: `local` provider mode and every macOS or Windows bind mount are
 * this case.
 *
 * Splitting on `/` before folding is safe in both directions: `/` is a starter with no canonical
 * composition, so normalising the segments separately is normalising the whole.
 *
 * **What this guarantees, and where it is best-effort.** The guarantee is over the classes the
 * volume folds **onto an ASCII name**, which is the set BD-024 needs: a `protected_paths` list is
 * written in ASCII — technical/12's example is (`tests/**`, `.gitlab-ci.yml`, `.agentic/**`,
 * `.claude/**`, `CLAUDE.md`) and so is {@link FLAGGED_CONFIG_PATHS} — so an ASCII rule can only be
 * evaded through a name the volume unifies with an ASCII one. Measured rather than argued, on
 * 2026-09-10, macOS 25.6 / APFS against Node 25.1 (ICU 77.1, Unicode 16.0), by writing the names
 * and comparing inodes:
 *
 *  * against a corpus of every ASCII character and every two- and three-letter lowercase name
 *    (18,352 files — full case folding expands to at most three ASCII letters), sweeping
 *    U+0080–U+1FFFF: the volume folds **13** code points onto an ASCII name (`ß`, `ſ`, U+037E,
 *    `ẞ`, U+1FEF, `K` U+212A and the seven ﬀ/ﬁ/ﬂ/ﬃ/ﬄ/ﬅ/ﬆ ligatures) and this fold folds every
 *    one of them with the same name: **0 misses**;
 *  * against the single-character ASCII names, sweeping the whole of U+0080–U+10FFFF: 4 such code
 *    points, **0 misses**.
 *
 * **Wider than that the fold is best-effort, and it is expected to drift.** `toLowerCase()` reads
 * the case table of the running Node/ICU build; the volume compares with the table baked into the
 * OS release; the two are versioned independently, and the gap is therefore not a fixed list.
 * Measured the same day, the same way: the volume folds U+A7D2 with U+A7D3 and U+A7CE with U+A7CF
 * while ICU 77.1 maps neither in either direction, and the same holds for U+1C84/U+1C85,
 * U+0345/U+1FBE, `ς`/`σ` and the whole U+16EA0↔U+16EBB run in plane 1 — all of them recently
 * encoded letters. **In none of these classes is either side an ASCII name.**
 *
 * Two instruments count them differently, and the disagreement is about the corpus rather than the
 * guard (standing rule 5): a generator that proposes a partner from `toUpperCase`/NFD and then asks
 * the volume finds **75** code points over the whole range but is blind to a pair ICU does not know
 * at all; the review's class census over the BMP and plane 1, which asks only the volume, finds
 * **43** and is blind to nothing except its own scope. Neither set contains the other. A hard-coded
 * table would be stale at the next bump of either side, which is why there is none: the boundary
 * above is the durable statement, and `path-guard.filesystem.test.ts` re-measures the volume on
 * every run.
 */
const foldForMatch = (value: string): string => value.split('/').map(foldSegment).join('/');

export const matchesPathPattern = (pattern: string, relativePath: string): boolean =>
  globToRegExp(foldForMatch(pattern)).test(foldForMatch(relativePath));

const firstMatch = (patterns: readonly string[], relativePath: string): string | undefined =>
  patterns.find((pattern) => matchesPathPattern(pattern, relativePath));

export interface PathGuardConfig {
  readonly workspacePath: string;
  readonly protectedPaths: readonly string[];
  readonly plannedProtectedPaths: readonly string[];
}

/**
 * Judges one write target.
 *
 * Order matters: escaping the workspace is decided before anything else, because a path outside it
 * has no meaningful "relative path" to match patterns against and a pattern that happened to match
 * would otherwise report the wrong reason.
 */
export const guardWritePath = (target: string, config: PathGuardConfig): PathVerdict => {
  if (target.trim().length === 0) {
    return { decision: 'deny', reason: 'the write has no path', relativePath: null };
  }
  // A path carrying a NUL is not a path anything will write: Node's `fs` rejects it with
  // `ERR_INVALID_ARG_VALUE` before the syscall. It is *denied* rather than allowed because the two
  // readings of `CLAUDE.md\u0000.txt` disagree — a C library truncates at the NUL and writes
  // `CLAUDE.md`, this guard's patterns see a different name — and a guard that has to guess which
  // reading the writer takes has not judged the write.
  if (target.includes('\u0000')) {
    return {
      decision: 'deny',
      reason:
        'the path contains a NUL byte, which no filesystem call accepts; write to a plain path.',
      relativePath: null,
    };
  }
  const workspace = path.resolve(config.workspacePath);
  const resolved = path.resolve(workspace, target);
  const relative = path.relative(workspace, resolved);
  if (relative.length === 0 || relative.startsWith('..') || path.isAbsolute(relative)) {
    return {
      decision: 'deny',
      reason:
        `"${target}" is outside the task workspace. The workspace is the only writable tree ` +
        '(BD-021); ask a human through ask_human if the change genuinely belongs elsewhere.',
      relativePath: null,
    };
  }
  const relativePath = relative.split(path.sep).join('/');

  const protectedPattern = firstMatch(config.protectedPaths, relativePath);
  if (protectedPattern !== undefined) {
    const planned = firstMatch(config.plannedProtectedPaths, relativePath);
    if (planned === undefined) {
      return {
        decision: 'deny',
        reason:
          `"${relativePath}" matches the protected path "${protectedPattern}" and the approved ` +
          'plan does not list it (BD-024). Propose the change in the plan and have it approved first.',
        relativePath,
      };
    }
  }

  const flagged = firstMatch(FLAGGED_CONFIG_PATHS, relativePath);
  if (flagged !== undefined) {
    return {
      decision: 'flag',
      reason:
        `"${relativePath}" is agent configuration (${flagged}); the write is allowed and is ` +
        'flagged for Code review (BD-025).',
      relativePath,
    };
  }

  return { decision: 'allow', reason: '', relativePath };
};

/**
 * Refuses to write secret-shaped content, whatever the path (technical/04: "secrets patterns in
 * content denied").
 *
 * It reuses the TD-012 rule set rather than a second list, so a shape the transcript redactor
 * knows how to hide is a shape the guard knows how to refuse — one corpus, two uses.
 */
export const guardWriteContent = (content: string): PathVerdict => {
  const hits = detectSecrets(content);
  if (hits.length === 0) {
    return { decision: 'allow', reason: '', relativePath: null };
  }
  const rules = [...new Set(hits.map((hit) => hit.ruleId))].join(', ');
  return {
    decision: 'deny',
    reason:
      `the content looks like it contains a credential (${rules}). Secrets never go in the ` +
      'repository (BD-002); use the platform integration instead.',
    relativePath: null,
  };
};

/** The tool-input fields the built-in write tools carry their target path in. */
const PATH_FIELDS = ['file_path', 'path', 'notebook_path'] as const;
/** The tool-input fields that carry content the agent is about to write. */
const CONTENT_FIELDS = ['content', 'new_string', 'new_source'] as const;

export const writeTargetOf = (input: unknown): string | null => {
  if (typeof input !== 'object' || input === null) {
    return null;
  }
  const record = input as Record<string, unknown>;
  for (const field of PATH_FIELDS) {
    const value = record[field];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return null;
};

/**
 * Every string the tool input would write. `MultiEdit`-style tools nest their edits in an array, so
 * the walk goes one level into arrays of objects rather than only reading the top level — a guard
 * that reads `content` and stops lets `edits: [{ new_string: "<token>" }]` straight through.
 */
export const writeContentsOf = (input: unknown): readonly string[] => {
  const out: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 3 || typeof value !== 'object' || value === null) {
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item, depth + 1);
      }
      return;
    }
    const record = value as Record<string, unknown>;
    for (const field of CONTENT_FIELDS) {
      const candidate = record[field];
      if (typeof candidate === 'string' && candidate.length > 0) {
        out.push(candidate);
      }
    }
    for (const nested of Object.values(record)) {
      if (Array.isArray(nested) || (typeof nested === 'object' && nested !== null)) {
        visit(nested, depth + 1);
      }
    }
  };
  visit(input, 0);
  return out;
};

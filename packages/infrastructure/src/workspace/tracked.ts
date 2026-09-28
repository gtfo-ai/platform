/**
 * **Which protected paths exist at the merge base of the run's checkout and the default branch** —
 * the launcher's half of WP-99 (technical/04's WP-99 amendment, technical/05 § "Command and tool
 * policy").
 *
 * The path guard allows a write that **creates** a protected path and holds a write to an
 * **existing** one to the plan's `protected_path_changes` (BD-024 §2 as amended at WP-81, the CI
 * gate's `changedExistingPaths`). It runs on the platform side and cannot `stat` the run's
 * container, so the launcher answers "exists" once, from the fresh checkout, before the runner
 * starts the CLI. This module is that answer's two pure halves: the shell the helper runs and the
 * parser that turns its output into an {@link ExistingProtectedPaths}.
 *
 * ## "Existing" is the merge base's tree, not the checkout's (WP-99 review round 1)
 *
 * The CI gate reads the merge request's diff, which is computed against the **merge base** of the
 * task branch and the default branch. A re-entry (`ci_fix`, a review return, a hand-back) checks out
 * the task branch, whose index also holds the tests earlier runs of the same task added — files the
 * diff calls additions. Listing the checkout's index would make a `ci_fix` Developer unable to edit
 * the failing test it wrote itself. So the script computes `git merge-base HEAD <base ref>` (the
 * base ref is the clone's `refs/remotes/origin/<default>`) and lists `git ls-tree -r` **at that
 * commit**. On a first run the checkout *is* the default branch and the merge base is its head, so
 * nothing changes there. The orchestrator amended the row's *"tracked at the run's checkout ref"*
 * to this.
 *
 * ## The listing is read fail closed
 *
 * `git ls-tree -r` prints one `<mode> <type> <object>\t<path>` line per entry. Four things make the
 * output trustworthy or make it `unlisted` (standing rule 20: a listing the parser cannot vouch for
 * is never read as a shorter listing — a missing line would read as a *new* file, the fail-open
 * direction):
 *
 *  - **A merge base.** No default branch known, a base ref the clone does not have, unrelated
 *    histories, a shallow clone that cuts the history — `git merge-base` fails and the script
 *    prints only a `no-base` trailer.
 *  - **A trailer with the count.** A parse whose entry lines do not equal it — a log cut by the
 *    daemon's tail, a line lost, a stderr line mixed in — is `unlisted`.
 *  - **A bound before the listing.** A tree past {@link MAX_TRACKED_ENTRIES} prints only the
 *    trailer.
 *  - **Every line parses, every path decodes.** `core.quotePath` is forced on, so git C-quotes any
 *    path with a control character, a quote, a backslash or a byte above 0x7F; the parser decodes
 *    the escapes to bytes and then decodes UTF-8 **fatally**. A path that is not UTF-8 cannot be
 *    compared with the path a tool call names, so it makes the listing `unlisted` rather than
 *    disappearing from it.
 *
 * ## What is carried
 *
 * `paths`: the **regular** files at the base matching one of the run's protected patterns, through
 * the guard's own {@link matchesPathPattern} — the folded comparison. That is sufficient for the
 * guard: a target that matches a protected pattern and folds onto a base path `Q` makes `Q` match
 * the same pattern (both are compared in the folded form), so `Q` is in the list.
 *
 * `opaque`: **every** symlink (`120000`) and submodule (`160000`) at the base, and any mode git may
 * add later — **plus the checkout's own** (review round 2): a link an earlier run of the same task
 * committed on the task branch is not at the base, and without it `lib/x.test.ts` through a
 * committed `lib -> tests` would read as new and overwrite the existing `tests/x.test.ts`. A write at or under one lands somewhere its path does not name — `lib/x.test.ts`
 * through a `lib → tests` link overwrites `tests/x.test.ts` — so the guard counts such a target as
 * existing (the ruling's *"a symlinked target reads as existing"*).
 */

import {
  type ExistingProtectedPaths,
  MAX_EXISTING_PROTECTED_PATHS,
  MAX_OPAQUE_TRACKED_PATHS,
  MAX_TRACKED_ENTRIES,
  unlistedProtectedPaths,
} from '@platform/application';
import { matchesPathPattern } from '../runner/path-guard.js';

/** The first word of the listing's last line. Platform text; no git output starts with `@@`. */
export const TRACKED_LISTING_TRAILER = '@@agentic-tracked';

/** Modes git writes for a regular file. Everything else is carried as opaque. */
const REGULAR_MODES = new Set(['100644', '100755']);

/**
 * The helper's script: the merge base, the count, a bound, the listing, the trailer.
 *
 * The base ref arrives in `$BASE_REF` and is only ever used **quoted**; `directory` is always a
 * platform constant ({@link WORKSPACE_WORKDIR} in production, a test's own temporary directory in
 * the e2e tier) and is checked here because it is concatenated. `-c core.quotePath=true` so the
 * output is ASCII whatever the repository configures; `-c safe.directory=…` because git refuses a
 * repository owned by another uid unless it is told (command-line configuration is protected
 * configuration, so the repository cannot unset it). `--end-of-options` keeps a base ref that
 * starts with `-` from being read as an option, whatever the caller validated.
 */
export const trackedListingScript = (directory: string): string => {
  if (!/^\/[A-Za-z0-9._/-]*$/.test(directory)) {
    throw new Error(`the listing directory must be a plain absolute path (got ${directory})`);
  }
  const git = `git -C '${directory}' -c core.quotePath=true -c 'safe.directory=${directory}'`;
  return [
    'set -e',
    `base=$(${git} merge-base --end-of-options HEAD "$BASE_REF" 2>/dev/null) || { echo "${TRACKED_LISTING_TRAILER} no-base"; exit 0; }`,
    `count=$(${git} ls-tree -r --full-tree "$base" | wc -l | tr -d ' ')`,
    `if [ "$count" -gt ${String(MAX_TRACKED_ENTRIES)} ]; then echo "${TRACKED_LISTING_TRAILER} too-many $count"; exit 0; fi`,
    `${git} ls-tree -r --full-tree "$base"`,
    // Review round 2: the checkout's **own** symlinks and submodules too — one an earlier run of
    // this task committed (`lib -> tests`) is not at the base, and a write through it lands on a
    // file that is. Only those two modes; `|| true` because `grep` exits 1 when there are none.
    `echo "${TRACKED_LISTING_TRAILER} head"`,
    `heads=$(${git} ls-tree -r --full-tree HEAD | grep -cE '^(120000|160000) ' || true)`,
    `if [ "$heads" -gt ${String(MAX_OPAQUE_TRACKED_PATHS)} ]; then echo "${TRACKED_LISTING_TRAILER} too-many-links $heads"; exit 0; fi`,
    `${git} ls-tree -r --full-tree HEAD | grep -E '^(120000|160000) ' || true`,
    `echo "${TRACKED_LISTING_TRAILER} end $count $heads"`,
  ].join('\n');
};

/**
 * A default branch the launcher may name in `$BASE_REF`: git's own ref-name rules, narrowed to a
 * plain alphabet (no `..`, no leading `-` or `/`, no trailing `/` or `.lock`). Anything else is
 * `unlisted` rather than a guess at what the operator meant.
 */
export const isListableBranchName = (name: string): boolean =>
  /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,254}$/.test(name) &&
  !name.includes('..') &&
  !name.includes('//') &&
  !name.endsWith('/') &&
  !name.endsWith('.lock');

/**
 * The answers both providers give before any helper: no checkout, no protected paths, no or an
 * unlistable default branch — each `unlisted`, with the platform's reason. `null` means "list".
 */
export const listingRefusal = (
  cacheKey: string | null,
  request: { readonly patterns: readonly string[]; readonly defaultBranch: string | null },
): ExistingProtectedPaths | null => {
  if (cacheKey === null) {
    return unlistedProtectedPaths('the workspace has no checkout, so nothing is tracked in it');
  }
  if (request.patterns.length === 0) {
    return unlistedProtectedPaths('the run has no protected paths, so nothing was listed');
  }
  if (request.defaultBranch === null) {
    return unlistedProtectedPaths(
      'no default branch is known, so the merge base the diff is computed against cannot be found',
    );
  }
  if (!isListableBranchName(request.defaultBranch)) {
    return unlistedProtectedPaths(
      'the default branch name is not one the listing will pass to git',
    );
  }
  return null;
};

/** How many log lines the helper's output may take: every entry, the trailer, and slack. */
export const TRACKED_LISTING_LOG_TAIL = MAX_TRACKED_ENTRIES + MAX_OPAQUE_TRACKED_PATHS + 8;

const ENTRY = /^([0-7]{6}) (blob|commit|tree) ([0-9a-f]{40}|[0-9a-f]{64})\t(.+)$/;

const SIMPLE_ESCAPES: Readonly<Record<string, number>> = {
  a: 0x07,
  b: 0x08,
  t: 0x09,
  n: 0x0a,
  v: 0x0b,
  f: 0x0c,
  r: 0x0d,
  '"': 0x22,
  '\\': 0x5c,
};

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** The same table, the other way round: the byte → the escape git writes for it. */
const ESCAPE_BY_BYTE: ReadonlyMap<number, string> = new Map(
  Object.entries(SIMPLE_ESCAPES).map(([letter, byte]) => [byte, `\\${letter}`] as const),
);

/**
 * Decodes one path as `git ls-tree` prints it under `core.quotePath`: plain, or a C-quoted string
 * with the escapes git's `quote_c_style` writes. `null` for anything else — an unknown escape, an
 * unterminated quote, bytes that are not UTF-8, a NUL.
 */
export const decodeGitPath = (raw: string): string | null => {
  if (!raw.startsWith('"')) {
    return raw.includes('\0') ? null : raw;
  }
  if (raw.length < 2 || !raw.endsWith('"')) {
    return null;
  }
  const body = raw.slice(1, -1);
  const bytes: number[] = [];
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] as string;
    if (char === '"') {
      return null;
    }
    if (char !== '\\') {
      const code = char.charCodeAt(0);
      if (code > 0x7e || code < 0x20) {
        return null;
      }
      bytes.push(code);
      continue;
    }
    const next = body[index + 1];
    if (next === undefined) {
      return null;
    }
    const simple = SIMPLE_ESCAPES[next];
    if (simple !== undefined) {
      bytes.push(simple);
      index += 1;
      continue;
    }
    const octal = body.slice(index + 1, index + 4);
    if (!/^[0-3][0-7]{2}$/.test(octal)) {
      return null;
    }
    bytes.push(Number.parseInt(octal, 8));
    index += 3;
  }
  try {
    const decoded = utf8.decode(Uint8Array.from(bytes));
    return decoded.includes('\0') ? null : decoded;
  } catch {
    return null;
  }
};

/**
 * The inverse of {@link decodeGitPath}: a path as `git ls-tree` prints it under `core.quotePath`.
 * Used by the fake provider and the e2e harness to produce git's shape, and by the round-trip
 * property that holds the decoder to it.
 */
export const quoteGitPath = (path: string): string => {
  const bytes = new TextEncoder().encode(path);
  const plain = bytes.every(
    (byte) => byte >= 0x20 && byte <= 0x7e && byte !== 0x22 && byte !== 0x5c,
  );
  if (plain) {
    return path;
  }
  let body = '';
  for (const byte of bytes) {
    const sequence = ESCAPE_BY_BYTE.get(byte);
    if (sequence !== undefined) {
      body += sequence;
    } else if (byte >= 0x20 && byte <= 0x7e) {
      body += String.fromCharCode(byte);
    } else {
      body += `\\${byte.toString(8).padStart(3, '0')}`;
    }
  }
  return `"${body}"`;
};

/** One `git ls-tree -r` line, in git's own shape (the object id is irrelevant to the parser). */
export const trackedListingLine = (entry: {
  readonly path: string;
  readonly mode: string;
}): string =>
  `${entry.mode} ${entry.mode === '160000' ? 'commit' : 'blob'} ${'0'.repeat(40)}\t${quoteGitPath(entry.path)}`;

/** A whole listing in the helper's shape: the entries, then the trailer with their count. */
export const trackedListingOutput = (
  entries: readonly { readonly path: string; readonly mode: string }[],
  /** The checkout's own symlinks and submodules (`120000`/`160000`), listed after the base's. */
  headLinks: readonly { readonly path: string; readonly mode: string }[] = [],
): string =>
  [
    ...entries.map(trackedListingLine),
    `${TRACKED_LISTING_TRAILER} head`,
    ...headLinks.map(trackedListingLine),
    `${TRACKED_LISTING_TRAILER} end ${String(entries.length)} ${String(headLinks.length)}`,
  ]
    .map((line) => `${line}\n`)
    .join('');

/**
 * The helper's output → the guard's input. Total: every failure is an `unlisted` with a reason, and
 * nothing here throws.
 */
export const parseTrackedListing = (
  output: string,
  patterns: readonly string[],
): ExistingProtectedPaths => {
  const lines = output.split('\n').filter((line) => line.length > 0);
  const trailer = lines.at(-1)?.split(' ') ?? [];
  if (trailer[0] !== TRACKED_LISTING_TRAILER) {
    return unlistedProtectedPaths('the tracked-path listing ended without its trailer');
  }
  if (trailer[1] === 'no-base') {
    return unlistedProtectedPaths(
      'the merge base of the checkout and the default branch could not be computed (no such ref, unrelated or cut history)',
    );
  }
  if (trailer[1] === 'too-many') {
    return unlistedProtectedPaths(
      `the tree at the merge base holds more than ${String(MAX_TRACKED_ENTRIES)} entries, past the listing's bound`,
    );
  }
  if (trailer[1] === 'too-many-links') {
    return unlistedProtectedPaths(
      `the checkout holds more than ${String(MAX_OPAQUE_TRACKED_PATHS)} symlinks and submodules, past the bound`,
    );
  }
  const count = Number(trailer[2]);
  const heads = Number(trailer[3]);
  if (
    trailer[1] !== 'end' ||
    trailer.length !== 4 ||
    !Number.isSafeInteger(count) ||
    !Number.isSafeInteger(heads)
  ) {
    return unlistedProtectedPaths('the tracked-path listing ended with an unreadable trailer');
  }
  const separator = lines.indexOf(`${TRACKED_LISTING_TRAILER} head`);
  if (separator < 0) {
    return unlistedProtectedPaths(
      'the tracked-path listing has no section for the checkout’s links',
    );
  }
  const entries = lines.slice(0, separator);
  const headLines = lines.slice(separator + 1, -1);
  if (entries.length !== count || headLines.length !== heads) {
    return unlistedProtectedPaths(
      `the tracked-path listing has ${String(entries.length)} entries where git counted ${String(count)}, and ${String(headLines.length)} links where it counted ${String(heads)}`,
    );
  }
  const paths: string[] = [];
  const opaque: string[] = [];
  for (const line of entries) {
    const match = ENTRY.exec(line);
    const decoded = match === null ? null : decodeGitPath(match[4] as string);
    if (match === null || decoded === null || match[2] === 'tree') {
      return unlistedProtectedPaths(
        'the tracked-path listing has a line the platform cannot read (a path that is not UTF-8, or an entry that is not a file, a symlink or a submodule)',
      );
    }
    if (!REGULAR_MODES.has(match[1] as string)) {
      opaque.push(decoded);
    } else if (patterns.some((pattern) => matchesPathPattern(pattern, decoded))) {
      paths.push(decoded);
    }
  }
  for (const line of headLines) {
    const match = ENTRY.exec(line);
    const decoded = match === null ? null : decodeGitPath(match[4] as string);
    if (match === null || decoded === null || REGULAR_MODES.has(match[1] as string)) {
      return unlistedProtectedPaths(
        'the tracked-path listing has a checkout link line the platform cannot read',
      );
    }
    if (!opaque.includes(decoded)) {
      opaque.push(decoded);
    }
  }
  if (paths.length > MAX_EXISTING_PROTECTED_PATHS) {
    return unlistedProtectedPaths(
      `the merge base holds ${String(paths.length)} protected files, past the bound of ${String(MAX_EXISTING_PROTECTED_PATHS)}`,
    );
  }
  if (opaque.length > MAX_OPAQUE_TRACKED_PATHS) {
    return unlistedProtectedPaths(
      `the merge base and the checkout hold ${String(opaque.length)} symlinks and submodules, past the bound of ${String(MAX_OPAQUE_TRACKED_PATHS)}`,
    );
  }
  return { state: 'listed', paths, opaque };
};

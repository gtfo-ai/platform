#!/usr/bin/env node
/**
 * Fails when a tracked file carries merge debris: a conflict marker git wrote, or a `.orig`/`.rej`
 * file a failed merge or patch left behind.
 *
 * This exists because it happened. The WP-13 squash merge (`d1e7b69`) put a whole conflict — seven
 * `<` and ` HEAD`, the seven-`=` separator, seven `>` and ` main` — into **`CLAUDE.md`**, the file
 * that is this repository's instructions to every future agent, and it sat on `main` for about an
 * hour (fixed in `3db7e45`). Every gate was green: `verify` reads no Markdown, biome and `tsc` do
 * not see `.md` at all, gitleaks has no rule for it, and the merge commit was made with
 * `--no-verify`. It was found because a subagent happened to read the file for unrelated work —
 * that is luck, not a gate, and luck does not repeat on demand (standing rule 30: when a defect is
 * mechanically detectable, add the check).
 *
 * ## What counts as a marker, and what that trades
 *
 * git writes four kinds of line, `conflict-marker-size` characters wide (default 7), and they are
 * not equally distinguishable from ordinary text:
 *
 *  - a run of `<` and a run of `>`, optionally followed by a space and a label. **Always** an
 *    offender, in any file, anywhere in it. No legitimate line of this repository's text begins
 *    with seven or more of either followed by a space or the end of the line.
 *  - a run of `|` (the diff3/zdiff3 base section) and a run of `=` (the separator). Counted **only
 *    between an opening marker and its close**, because outside one they are ordinary content:
 *    seven `=` under a title is a Markdown setext heading, seven `|` is an empty six-column GFM
 *    table row, and both are ASCII art in a plain-text file. This guard would fire on a legitimate
 *    line exactly once before somebody switched it off, which is the corollary of standing rule 7
 *    about allow-lists — so it does not fire on those.
 *
 * The trade is stated rather than hidden. **Missed**: a half-resolved conflict where the opening
 * *and* closing markers were deleted and a bare separator left behind — git never writes that, a
 * human editing one line out of three does. **False positive**: seven-deep nested Markdown
 * blockquotes, and ASCII art of seven or more `<`/`>` at the start of a line. Both are exempted
 * per path in `.gitattributes`, below, rather than by weakening the pattern.
 *
 * A run of *more* than the default seven is matched too: that is what a path declaring a larger
 * `conflict-marker-size` gets written into it. A path declaring a size **below** seven would get
 * markers this guard does not look for — nothing here does, git's own default is the floor in
 * practice, and such a declaration would be visible in the same file the exemption lives in.
 *
 * Fenced code blocks are **not** treated specially: git writes markers wherever the conflict is,
 * including inside a fence in a Markdown file, so skipping fences would blind the guard to exactly
 * the file type that was hit. A fenced conflict that is genuinely documentation — the marker lines
 * of a worked example — is an exemption, not a parser feature. (A fenced separator with no opening
 * marker around it is ordinary content and is not reported at all; see the region rule above.)
 *
 * ## `.orig` and `.rej`
 *
 * Included, because the content check cannot see them: a `.rej` holds rejected diff hunks and
 * carries no markers at all, and a `.orig` is whatever the tool saved. Both are debris from the
 * same event as the markers, both are worthless to a reader of the tree, and the corpus to check
 * them against — the tracked file list — is already in hand. This part is a **deny**-list, so its
 * drift direction is a miss and never a false pass: `mergetool` also leaves `*.BASE.*`,
 * `*.LOCAL.*`, `*.REMOTE.*` and `*.BACKUP.*`, which are not matched here. The `BACKUP` one is the
 * conflicted file itself and so is caught by content; the other three are clean versions and are
 * not caught at all.
 *
 * ## Scope, asked of git rather than carried in a list (standing rule 7)
 *
 * The scope is `git ls-files`: every path this repository tracks, staged or committed, with no
 * extension list and no directory list to drift. The exemption is git's own declaration too, for
 * the same reason `check-nul.mjs` uses `binary`: it is granted in the tree, in a file reviewers
 * read, and never by editing this script.
 *
 *   docs/example-merge.md conflict-markers
 *
 * Only the bare attribute (`conflict-markers: set`) exempts. `conflict-markers=yes`, or any other
 * spelling, leaves the path checked and the failure names the spelling that works — a drift that
 * fails closed. A path declared `binary` (or `-text`) is skipped as well: it is not text and has
 * no lines to read.
 *
 * That exemption is also the guard's own off switch, so it is bounded: an empty `git ls-files` and
 * an empty list of *examined* files are both failures with exit code 2, not passes. A single
 * `* conflict-markers` line in `.gitattributes` would otherwise report `PASS (0 files)` for ever —
 * a check that succeeds because it looked at nothing (standing rule 4).
 *
 * ## What it cannot check
 *
 * That a file *without* markers was merged correctly. A conflict resolved by taking one side
 * wholesale leaves no trace for any syntactic guard, and this one makes no claim about it.
 *
 * Prints exactly one `PASS: conflict:check` / `FAIL: conflict:check` line on stdout, like every
 * other verification step (docs/technical/14-orchestration-protocol.md).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

const fail = (message, code = 1) => {
  process.stderr.write(`${message}\n`);
  process.stdout.write('FAIL: conflict:check\n');
  process.exit(code);
};

/**
 * The marker patterns, built from quantifiers so that this file — which is itself tracked, and
 * therefore itself checked — contains no marker for the guard to find. Same move as writing the
 * NUL byte as `\0` (CLAUDE.md).
 *
 * `{7,}` rather than `{7}`: seven is git's `DEFAULT_CONFLICT_MARKER_SIZE`, and a path declaring a
 * larger `conflict-marker-size` gets longer runs written into it.
 */
const OPENING = /^<{7,}(?: .*)?$/;
const CLOSING = /^>{7,}(?: .*)?$/;
/** Only meaningful inside an open conflict region; see the docblock. */
const BASE = /^\|{7,}(?: .*)?$/;
const SEPARATOR = /^={7,}$/;

/** Debris a failed merge or a rejected patch leaves behind, caught by name rather than content. */
const DEBRIS = /\.(?:orig|rej)$/i;

/** At most this many marker lines are reported per file; the rest are counted. */
const REPORTED_PER_FILE = 3;

const tracked = spawnSync('git', ['ls-files', '-z'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});

if (tracked.error || tracked.status !== 0) {
  fail(`could not list tracked files: ${tracked.error?.message ?? tracked.stderr}`, 2);
}

const paths = tracked.stdout.split('\0').filter((path) => path !== '');

if (paths.length === 0) {
  // Rule 4: a check that quietly examined nothing would pass for ever.
  fail('found no tracked files to check; is this the repository root?', 2);
}

/**
 * `git check-attr -z <attrs> --stdin` answers with `path\0attribute\0value\0` triples.
 *
 * `conflict-markers: set` is the exemption a path declares for itself; `binary: set` and
 * `text: unset` (`-text`) are the two spellings of "this is not text", which `check-nul.mjs` reads
 * the same way. Everything else — including `unspecified`, which is what every current path
 * answers — is a text file this guard reads.
 */
const attributes = spawnSync(
  'git',
  ['check-attr', '-z', 'conflict-markers', 'binary', 'text', '--stdin'],
  {
    cwd: repositoryRoot,
    input: `${paths.join('\0')}\0`,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  },
);

if (attributes.error || attributes.status !== 0) {
  fail(`could not read git attributes: ${attributes.error?.message ?? attributes.stderr}`, 2);
}

const exempt = new Set();
const declaredBinary = new Set();
const fields = attributes.stdout.split('\0');
for (let index = 0; index + 2 < fields.length; index += 3) {
  const [path, attribute, value] = [fields[index], fields[index + 1], fields[index + 2]];
  if (attribute === 'conflict-markers' && value === 'set') {
    exempt.add(path);
  }
  if ((attribute === 'binary' && value === 'set') || (attribute === 'text' && value === 'unset')) {
    declaredBinary.add(path);
  }
}

/**
 * The marker lines of one file, in order.
 *
 * A trailing `\r` is stripped before matching: a file with CRLF endings holds the separator
 * followed by `\r`, and a pattern anchored with `$` would miss every one of them.
 */
const markersIn = (contents) => {
  const found = [];
  let open = false;
  const lines = contents.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? '').replace(/\r$/, '');
    if (OPENING.test(line)) {
      open = true;
    } else if (CLOSING.test(line)) {
      open = false;
    } else if (!(open && (BASE.test(line) || SEPARATOR.test(line)))) {
      continue;
    }
    found.push({ line: index + 1, text: line.length > 80 ? `${line.slice(0, 77)}...` : line });
  }
  return found;
};

const offenders = [];
let examined = 0;

for (const path of paths) {
  if (exempt.has(path)) {
    continue;
  }
  if (DEBRIS.test(path)) {
    offenders.push(`${path}: a leftover merge/patch artefact is tracked`);
    continue;
  }
  if (declaredBinary.has(path)) {
    continue;
  }
  let contents;
  try {
    contents = readFileSync(join(repositoryRoot, path), 'utf8');
  } catch {
    // A tracked path that is not a readable file here (a symlink to nowhere, a gitlink) has no
    // lines of this repository's to check.
    continue;
  }
  examined += 1;
  const markers = markersIn(contents);
  for (const marker of markers.slice(0, REPORTED_PER_FILE)) {
    offenders.push(`${path}:${marker.line}: ${marker.text}`);
  }
  if (markers.length > REPORTED_PER_FILE) {
    offenders.push(`${path}: and ${markers.length - REPORTED_PER_FILE} more marker line(s)`);
  }
}

if (examined === 0) {
  // The mirror of the empty-`git ls-files` guard above, and the reason the `.gitattributes`
  // exemption cannot be used to switch this check off: `* conflict-markers` declares every tracked
  // path exempt, and a guard that examined nothing would then report success for ever (standing
  // rule 4). The other route here is every tracked path being unreadable — a tree of gitlinks or
  // dangling symlinks — which is equally not a corpus this check has verified.
  fail(
    `examined none of the ${paths.length} tracked path(s): ${exempt.size} are exempt via .gitattributes, ${declaredBinary.size} are declared binary, and the rest could not be read. A check with an empty corpus has verified nothing, so this is a failure rather than a pass.`,
    2,
  );
}

if (offenders.length > 0) {
  process.stderr.write(
    'tracked file(s) carry merge debris. A committed conflict marker is a broken file that every tool but git ignores: it typechecks nowhere, lints nowhere, and in a Markdown file it renders as text.\n',
  );
  for (const offender of offenders) {
    process.stderr.write(`  ${offender}\n`);
  }
  process.stderr.write(
    'Finish the merge and delete the artefact. A path that legitimately contains marker lines declares `conflict-markers` in .gitattributes — the bare attribute, no value.\n',
  );
  fail(`(${examined} tracked text files examined)`);
}

process.stdout.write(
  `PASS: conflict:check (${examined} tracked text files, ${declaredBinary.size} declared binary, ${exempt.size} exempt, no conflict markers and no .orig/.rej debris)\n`,
);

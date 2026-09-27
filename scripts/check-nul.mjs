#!/usr/bin/env node
/**
 * Fails when a source file — tracked, or untracked and not ignored — contains a literal NUL byte.
 *
 * This exists because it happened **twice**. WP-05 put a literal NUL in a template string in
 * `packages/infrastructure/src/jobs/in-memory-jobs.ts`; WP-10 put one in
 * `packages/integrations/src/providers/slack/threads.ts`. The ledger entry for the first ends
 * "worth a lint rule if it ever recurs", and it recurred, so here is the rule.
 *
 * A NUL byte is not a cosmetic problem. Git classifies a blob as binary the moment it finds one in
 * the first 8000 bytes, and from then on:
 *
 *  - `git diff` and `git log -p` print `Bin 0 -> 3808 bytes` instead of the change, so the content
 *    of a fix is invisible to its reviewer — which is exactly what happened at WP-05;
 *  - the file cannot be three-way merged, so any concurrent edit is a manual conflict;
 *  - `grep -rn` skips it, so it disappears from every search of the tree.
 *
 * Nothing else catches it. It is valid TypeScript, so the compiler is happy; the string it builds
 * is the string the author meant, so every test passes; biome formats it without complaint. Only
 * git objects, and only after the commit.
 *
 * ## Scope, asked of git rather than carried in a list (standing rule 7)
 *
 * The scope is every path git knows about and does not ignore — `git ls-files` **plus**
 * `git ls-files --others --exclude-standard` — with no extension list and no directory list to
 * drift. The untracked half is backlog 10: the guard used to read the tracked set alone, so a new
 * file carrying a NUL passed `verify` until it was staged, which is how WP-16's two went unseen.
 * An ignored file is not read, because an ignored file is not a source file. The list, the
 * vanished-path rule and the unreadable-path report are `census-files.mjs`'s, shared with every
 * other census: a path that disappears between the listing and the read is dropped, and a path
 * that exists and cannot be read (a dangling symlink, a gitlink) is **named** on stderr and in the
 * PASS line rather than skipped in silence. This repository stores no images, no archives and no
 * compiled artefacts, so the rule is simply "no source file may contain a NUL byte".
 *
 * The escape hatch for the day one is added is also git's own declaration rather than a second
 * hand-maintained list: a path whose `binary` attribute is set, or whose `text` attribute is
 * explicitly unset, in `.gitattributes` is skipped. That is the same statement a contributor has
 * to make anyway for git to stop trying to diff and merge the file, so the exemption cannot be
 * granted by editing this script — it is granted in the tree, in a file reviewers read.
 *
 * That escape hatch is also the guard's own off switch, so it is bounded twice: an empty file
 * list and an empty list of *examined text files* are both failures, not passes. A single
 * `* binary` line in `.gitattributes` would otherwise have reported `PASS (0 tracked text files)`
 * forever — a check that succeeds because it looked at nothing (standing rule 4).
 *
 * Prints exactly one `PASS: nul:check` / `FAIL: nul:check` line on stdout, like every other
 * verification step (docs/technical/14-orchestration-protocol.md).
 */
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { censusPaths, readCensus } from './census-files.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

const fail = (message, code = 1) => {
  process.stderr.write(`${message}\n`);
  process.stdout.write('FAIL: nul:check\n');
  process.exit(code);
};

let paths;
try {
  paths = censusPaths(repositoryRoot);
} catch (error) {
  fail(`could not list the files to check: ${error.message}`, 2);
}

if (paths.length === 0) {
  // Rule 4: a check that quietly examined nothing would pass forever.
  fail('found no files to check; is this the repository root?', 2);
}

/**
 * Paths git has been *told* are binary, and are therefore allowed to contain NUL.
 *
 * `git check-attr -z binary,text --stdin` answers with `path\0attribute\0value\0` triples. A
 * declared binary is `binary: set`; `text: unset` (`-text`) is the other spelling of the same
 * intent. Everything else — including `unspecified`, which is what all 534 current paths answer —
 * is a text source and must not contain a NUL.
 */
const attributes = spawnSync('git', ['check-attr', '-z', 'binary', 'text', '--stdin'], {
  cwd: repositoryRoot,
  input: `${paths.join('\0')}\0`,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});

if (attributes.error || attributes.status !== 0) {
  fail(`could not read git attributes: ${attributes.error?.message ?? attributes.stderr}`, 2);
}

const declaredBinary = new Set();
const fields = attributes.stdout.split('\0');
for (let index = 0; index + 2 < fields.length; index += 3) {
  const [path, attribute, value] = [fields[index], fields[index + 1], fields[index + 2]];
  if ((attribute === 'binary' && value === 'set') || (attribute === 'text' && value === 'unset')) {
    declaredBinary.add(path);
  }
}

const offenders = [];
const { files, vanished, unreadable } = readCensus(
  repositoryRoot,
  paths.filter((path) => !declaredBinary.has(path)),
  { encoding: null },
);
const examined = files.length;

for (const { path, contents } of files) {
  const at = contents.indexOf(0);
  if (at !== -1) {
    const line = contents.subarray(0, at).toString('utf8').split('\n').length;
    offenders.push(`${path}:${line} (byte ${at})`);
  }
}

// A path that exists and could not be read has not been checked, and saying nothing about it
// would read as "checked, clean". A dangling symlink or a gitlink has no bytes of this
// repository's, so it does not fail the check — but it is named, here and in the verdict line.
for (const { path, reason } of unreadable) {
  process.stderr.write(`not checked: ${path} (${reason})\n`);
}

if (examined === 0) {
  // The mirror of the empty-`git ls-files` guard above, and the reason the `.gitattributes`
  // exemption cannot be used to switch this check off: `* binary` declares every path
  // exempt, and a guard that examined nothing would then report success forever (standing rule 4).
  // The other route here is every path being unreadable — a tree of gitlinks or dangling
  // symlinks — which is equally not a corpus this check has verified.
  fail(
    `examined none of the ${paths.length} path(s): ${declaredBinary.size} are declared binary in .gitattributes and the rest could not be read. A check with an empty corpus has verified nothing, so this is a failure rather than a pass.`,
    2,
  );
}

if (offenders.length > 0) {
  process.stderr.write(
    `${offenders.length} source file(s) contain a literal NUL byte. git will treat each as binary: its diff renders as "Bin", it cannot be three-way merged, and grep skips it.\n`,
  );
  for (const offender of offenders) {
    process.stderr.write(`  ${offender}\n`);
  }
  process.stderr.write(
    'Write the byte as the escape \\0 in the source, or declare the path binary in .gitattributes if it really is.\n',
  );
  fail(`(${examined} text files examined)`);
}

const residue = [
  unreadable.length > 0 ? `, ${unreadable.length} not readable (named above)` : '',
  vanished.length > 0 ? `, ${vanished.length} vanished while checking` : '',
].join('');

process.stdout.write(
  `PASS: nul:check (${examined} text files tracked or untracked, ${declaredBinary.size} declared binary${residue}, none with a NUL byte)\n`,
);

#!/usr/bin/env node
/**
 * Fails when a tracked source file contains a literal NUL byte.
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
 * The scope is `git ls-files`: every path this repository tracks, with no extension list and no
 * directory list to drift. Today that is 534 files and **none** of them is a genuine binary — this
 * repository stores no images, no archives and no compiled artefacts — so the rule is simply "no
 * tracked file may contain a NUL byte".
 *
 * The escape hatch for the day one is added is also git's own declaration rather than a second
 * hand-maintained list: a path whose `binary` attribute is set, or whose `text` attribute is
 * explicitly unset, in `.gitattributes` is skipped. That is the same statement a contributor has
 * to make anyway for git to stop trying to diff and merge the file, so the exemption cannot be
 * granted by editing this script — it is granted in the tree, in a file reviewers read.
 *
 * That escape hatch is also the guard's own off switch, so it is bounded twice: an empty
 * `git ls-files` and an empty list of *examined text files* are both failures, not passes. A single
 * `* binary` line in `.gitattributes` would otherwise have reported `PASS (0 tracked text files)`
 * forever — a check that succeeds because it looked at nothing (standing rule 4).
 *
 * Prints exactly one `PASS: nul:check` / `FAIL: nul:check` line on stdout, like every other
 * verification step (docs/technical/14-orchestration-protocol.md).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

const fail = (message, code = 1) => {
  process.stderr.write(`${message}\n`);
  process.stdout.write('FAIL: nul:check\n');
  process.exit(code);
};

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
  // Rule 4: a check that quietly examined nothing would pass forever.
  fail('found no tracked files to check; is this the repository root?', 2);
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
let examined = 0;

for (const path of paths) {
  if (declaredBinary.has(path)) {
    continue;
  }
  let contents;
  try {
    contents = readFileSync(join(repositoryRoot, path));
  } catch {
    // A tracked path that is not a readable file here (a symlink to nowhere, a gitlink) has no
    // bytes of this repository's to check.
    continue;
  }
  examined += 1;
  const at = contents.indexOf(0);
  if (at !== -1) {
    const line = contents.subarray(0, at).toString('utf8').split('\n').length;
    offenders.push(`${path}:${line} (byte ${at})`);
  }
}

if (examined === 0) {
  // The mirror of the empty-`git ls-files` guard above, and the reason the `.gitattributes`
  // exemption cannot be used to switch this check off: `* binary` declares every tracked path
  // exempt, and a guard that examined nothing would then report success forever (standing rule 4).
  // The other route here is every tracked path being unreadable — a tree of gitlinks or dangling
  // symlinks — which is equally not a corpus this check has verified.
  fail(
    `examined none of the ${paths.length} tracked path(s): ${declaredBinary.size} are declared binary in .gitattributes and the rest could not be read. A check with an empty corpus has verified nothing, so this is a failure rather than a pass.`,
    2,
  );
}

if (offenders.length > 0) {
  process.stderr.write(
    `${offenders.length} tracked source file(s) contain a literal NUL byte. git will treat each as binary: its diff renders as "Bin", it cannot be three-way merged, and grep skips it.\n`,
  );
  for (const offender of offenders) {
    process.stderr.write(`  ${offender}\n`);
  }
  process.stderr.write(
    'Write the byte as the escape \\0 in the source, or declare the path binary in .gitattributes if it really is.\n',
  );
  fail(`(${examined} tracked text files examined)`);
}

process.stdout.write(
  `PASS: nul:check (${examined} tracked text files, ${declaredBinary.size} declared binary, none with a NUL byte)\n`,
);

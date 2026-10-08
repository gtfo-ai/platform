#!/usr/bin/env node
/**
 * `node scripts/git-long-options-check.mjs` — the Docker check of WP-161 ruling (c) and criterion (7).
 *
 * 1. **The table is current**: it regenerates `git-long-options.generated.ts` from the run image's
 *    git (`scripts/git-long-options.mjs`, which writes nothing here) and compares it with the
 *    committed file byte for byte.
 * 2. **The pinned-git oracle row**: in a throwaway repository, in a container with no network that is
 *    removed afterwards, a `pre-commit` hook that only `exit 1`s refuses a plain commit, and
 *    `git commit --no-verif` commits past it — git resolved the abbreviation to `--no-verify` —
 *    while `--no-ver` is refused as ambiguous. Nothing else runs: the hook is the failing one, the
 *    commits are empty.
 * 3. **The policy floors what git ran**: `git commit --no-verif -m x` carries the `--no-verify`
 *    abbreviation floor, and the table resolves `no-ver` to nothing.
 *
 * Not a `verify` target, for `runlet-container-check`'s reason: it needs a Docker daemon and the
 * run image. Prints one `PASS:`/`FAIL:` line per check and a final `PASS: git-long-options-check`.
 *
 * Usage: `node scripts/git-long-options-check.mjs [--image <ref>]`
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { promisify } from 'node:util';
import { DEFAULT_IMAGE, GENERATED_PATH, generateText } from './git-long-options.mjs';

const exec = promisify(execFile);
const at = process.argv.indexOf('--image');
const image = at === -1 ? DEFAULT_IMAGE : process.argv[at + 1];

const { hazardousArguments, gitResolvesLongOption } = await import(
  '../packages/domain/src/policies/command-policy.ts'
);
const { GIT_LONG_OPTIONS } = await import(
  '../packages/domain/src/policies/git-long-options.generated.ts'
);

const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}\n`);
};

// 1. the table
const committed = await readFile(GENERATED_PATH, 'utf8');
const regenerated = await generateText(image);
if (committed === regenerated) {
  check('table is current', true, `regenerated from ${image}, identical`);
} else {
  const a = committed.split('\n');
  const b = regenerated.split('\n');
  const first = a.findIndex((line, index) => line !== b[index]);
  check('table is current', false, `differs from line ${first + 1}: ${JSON.stringify(b[first])}`);
}

// 2. the oracle row
const ORACLE = `
set -u
export HOME="$(mktemp -d)" GIT_CONFIG_NOSYSTEM=1
cd "$(mktemp -d)" && git init -q .
git config user.name check && git config user.email check@example.invalid
printf '#!/bin/sh\\nexit 1\\n' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
git commit -q --allow-empty -m plain >/dev/null 2>&1; echo "plain $?"
git commit -q --allow-empty --no-verif -m abbreviated >/dev/null 2>&1; echo "no-verif $?"
git commit -q --allow-empty --no-ver -m ambiguous >/dev/null 2>&1; echo "no-ver $?"
git --version
`;
const { stdout } = await exec('docker', [
  'run',
  '--rm',
  '--network',
  'none',
  '--entrypoint',
  'sh',
  image,
  '-c',
  ORACLE,
]);
const status = Object.fromEntries(
  stdout
    .trim()
    .split('\n')
    .filter((line) => /^\S+ \d+$/.test(line))
    .map((line) => line.split(' ')),
);
const version = stdout.trim().split('\n').at(-1);
check(
  'a failing pre-commit hook refuses a plain commit',
  status.plain !== '0',
  `exit ${status.plain}`,
);
check(
  'git commit --no-verif commits past it (git resolved --no-verify)',
  status['no-verif'] === '0',
  `exit ${status['no-verif']}, ${version}`,
);
check(
  'git commit --no-ver is refused as ambiguous',
  status['no-ver'] === '129',
  `exit ${status['no-ver']}`,
);

// 3. the policy
const floored = hazardousArguments('git commit --no-verif -m x').some((entry) =>
  entry.pattern.startsWith('git --no-verify abbreviated'),
);
check('the policy floors git commit --no-verif', floored);
check(
  'the table resolves no-ver to nothing (ambiguous, as git does)',
  gitResolvesLongOption(GIT_LONG_OPTIONS.commit, 'no-ver') === null,
);

const ok = results.every(Boolean);
process.stdout.write(`${ok ? 'PASS' : 'FAIL'}: git-long-options-check\n`);
process.exitCode = ok ? 0 : 1;

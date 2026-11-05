#!/usr/bin/env node
/**
 * **The pre-push hook's unit + contract run, for pushes to `main` only** (owner, 2026-11-05).
 *
 * `lefthook.yml` runs the unit + contract tier on pre-push because this project pushes straight to
 * `main`, where CI's verdict arrives after the tree is public. That reason holds for a push to
 * `main` and for nothing else: a push to any other branch is a pull request's head, and CI runs the
 * whole suite on it before anything can merge. Running the ~6.5-minute tier locally on every PR push
 * as well measured a load average of 113-134 on a 14-core machine with several agents pushing at
 * once, and timed out disk-scanning tests that pass alone — so a PR push now skips it, and a push
 * that updates `refs/heads/main` still runs it in full.
 *
 * Git hands pre-push one line per ref on stdin — `<local ref> <local sha> <remote ref> <remote sha>`
 * (githooks(5)); `lefthook.yml` passes it through with `use_stdin`. A push whose stdin is empty or
 * unreadable is treated as a push to `main` (the safe side: run the tests).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { isProgram } from './is-program.mjs';

export const MAIN_REF = 'refs/heads/main';

/**
 * Whether the push described by git's pre-push stdin must run the test tier: true when any line
 * updates `refs/heads/main`, or when there is no parseable line at all.
 */
export const pushNeedsTests = (stdin) => {
  const refs = String(stdin)
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields.length >= 4)
    .map((fields) => fields[2]);
  if (refs.length === 0) return true;
  return refs.includes(MAIN_REF);
};

if (isProgram(import.meta.url)) {
  let stdin = '';
  try {
    stdin = readFileSync(0, 'utf8');
  } catch {
    stdin = '';
  }
  if (!pushNeedsTests(stdin)) {
    process.stdout.write(
      'unit + contract: skipped — not a push to main; CI runs the suite on the pull request\n',
    );
    process.exit(0);
  }
  const result = spawnSync('pnpm', ['run', '-s', 'test'], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

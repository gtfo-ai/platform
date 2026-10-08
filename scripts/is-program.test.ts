import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterAll, describe, expect, it } from 'vitest';
import { checkoutGitEnv } from './git-scratch-env.mjs';
import { isProgram } from './is-program.mjs';

/**
 * **A script run through a symlinked path is still the program** — WP-73b, PROGRESS backlog 258.
 *
 * `changelog.mjs`, `notices.mjs` and `version.mjs` compared their resolved URL with
 * `path.resolve(argv[1])`, so through a symlink they did nothing and exited 0 — and
 * `notices:check` is a `verify:static` step, so the check passed without comparing anything. Each
 * is run here through a directory that is a **symlink to `scripts/`**, and asserted to have done
 * its work: for `notices.mjs --check`, that a stale file **fails** (the other direction of a
 * check, rule 42 — a script that does nothing exits 0 too).
 */
const scratch = mkdtempSync(join(tmpdir(), 'is-program-'));
const linked = join(scratch, 'linked-scripts');
symlinkSync(import.meta.dirname, linked);

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const run = (script: string, ...args: string[]) =>
  spawnSync(process.execPath, [join(linked, script), ...args], {
    cwd: scratch,
    encoding: 'utf8',
    // The scripts read this checkout (their own location names it), never a repository `GIT_DIR` names.
    env: { ...checkoutGitEnv(), GITHUB_OUTPUT: '' },
  });

describe('the "am I the program?" guard through a symlink (backlog 258)', () => {
  it('answers yes for the real entry and for a path through a symlink, and no for another file', () => {
    const self = new URL('./is-program.mjs', import.meta.url).href;
    const saved = process.argv[1];
    try {
      process.argv[1] = join(import.meta.dirname, 'is-program.mjs');
      expect(isProgram(self)).toBe(true);
      process.argv[1] = join(linked, 'is-program.mjs');
      expect(isProgram(self)).toBe(true);
      process.argv[1] = join(linked, 'notices.mjs');
      expect(isProgram(self)).toBe(false);
      process.argv[1] = join(scratch, 'no-such-file.mjs');
      expect(isProgram(self)).toBe(false);
    } finally {
      if (saved === undefined) {
        process.argv.splice(1, 1);
      } else {
        process.argv[1] = saved;
      }
    }
  });

  it('notices.mjs --check fails a stale file when run through the symlink', () => {
    const stale = join(scratch, 'STALE_NOTICES.md');
    writeFileSync(stale, '# not the rendered notices\n');
    const result = run('notices.mjs', '--check', '--out', stale);
    expect(`${result.stdout}${result.stderr}`).toContain('is stale');
    expect(result.status).toBe(1);
  }, 60_000);

  it('changelog.mjs --stdout renders the changelog when run through the symlink', () => {
    const result = run('changelog.mjs', '--stdout');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^# /m);
  }, 60_000);

  it('version.mjs answers when run through the symlink', () => {
    const result = run('version.mjs');
    // "next version: …" or "no version — …": either is the script having run; silence is not.
    expect(result.stderr).toMatch(/(next version|no version)/);
  }, 60_000);
});

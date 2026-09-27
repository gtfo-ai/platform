import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  bytesScanned,
  containerArgs,
  gitLayout,
  scanVerdict,
  stagedAddedLines,
} from './gitleaks-audit.mjs';

/**
 * The pre-commit secret scan, in the arrangement it failed open in: a **linked worktree**.
 *
 * Backlog 8: the container fallback could not follow a linked worktree's `.git` file, so gitleaks
 * scanned nothing, printed `no leaks found` and exited 0 over a staged credential. The failing
 * path and the passing path were spelled identically, so the refusal is asserted on its own here
 * — against a scanner that prints exactly what the broken fallback printed — and the real binary
 * is driven in a real linked worktree in both directions, so the refusal cannot be what makes the
 * clean case pass or the leak case fail.
 *
 * The container path itself needs a Docker daemon and is not a unit case; it was measured by hand
 * at WP-68 (PROGRESS, WP-68 notes) with the mount layout `containerArgs` produces, asserted below.
 */
const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const REPOSITORY = join(SCRIPTS, '..');

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Secret Scan Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Secret Scan Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  // The fixture decides which scanner runs; a CI variable would only change the not-run branch.
  CI: '',
};

/**
 * What the container fallback printed in a linked worktree, measured at WP-68 with a staged
 * credential (colour codes stripped). Exit status 0.
 */
const MEASURED_EMPTY_SCAN = [
  '6:35AM ERR [git] fatal: not a git repository: /Users/example/repo/.git/worktrees/wt',
  '6:35AM ERR error="stderr is not empty"',
  '6:35AM INF 0 commits scanned.',
  '6:35AM INF scanned ~0 bytes (0) in 27ms',
  '6:35AM INF no leaks found',
].join('\n');

/**
 * A credential-shaped value assembled at run time, so this file is not itself a finding for the
 * repository's own scan. It is not a credential anybody issued.
 */
const PLANTED = `${['gh', 'p_'].join('')}${'x7Kq9Lm2Pz4Rt8Vw1Yb6Nc3Hd5Jf0Gs2Ae9U'}`;

const git = (cwd: string, ...args: readonly string[]): string => {
  const result = spawnSync('git', [...args], { cwd, env: GIT_ENV, encoding: 'utf8' });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`fixture setup failed: git ${args.join(' ')}: ${result.stderr}`);
  }
  return result.stdout;
};

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A main repository with one commit and a linked worktree of it, the scan script copied into the
 * worktree (it derives the repository from its own location) and **no** `node_modules` there —
 * the state an agent worktree is in before anybody runs `pnpm install` in it.
 */
const linkedWorktree = (): { main: string; worktree: string } => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'gitleaks-worktree-')));
  roots.push(base);
  const main = join(base, 'main');
  mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main', '.');
  copyFileSync(join(REPOSITORY, '.gitleaks.toml'), join(main, '.gitleaks.toml'));
  writeFileSync(join(main, 'README.md'), '# fixture\n');
  writeFileSync(join(main, '.gitignore'), '/node_modules/\n/scripts/\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'fixture');
  const worktree = join(base, 'wt');
  git(main, 'worktree', 'add', '-q', '--detach', worktree);
  mkdirSync(join(worktree, 'scripts'));
  for (const file of ['gitleaks.mjs', 'gitleaks-audit.mjs']) {
    copyFileSync(join(SCRIPTS, file), join(worktree, 'scripts', file));
  }
  return { main, worktree };
};

/** A stand-in scanner at `<root>/node_modules/.bin/gitleaks`. */
const installScanner = (root: string, script: string): void => {
  const bin = join(root, 'node_modules', '.bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gitleaks'), script);
  chmodSync(join(bin, 'gitleaks'), 0o755);
};

/** The repository's own pinned binary, reached through the main worktree's `node_modules`. */
const linkRealScanner = (root: string): void => {
  const bin = join(root, 'node_modules', '.bin');
  mkdirSync(bin, { recursive: true });
  symlinkSync(join(REPOSITORY, 'node_modules', '.bin', 'gitleaks'), join(bin, 'gitleaks'));
};

const preCommitScan = (
  worktree: string,
): { status: number | null; stdout: string; stderr: string } => {
  const result = spawnSync(
    process.execPath,
    [join(worktree, 'scripts', 'gitleaks.mjs'), 'git', '--staged', '--require'],
    { cwd: worktree, env: GIT_ENV, encoding: 'utf8' },
  );
  if (result.error !== undefined) {
    throw new Error(`could not run the scan: ${result.error.message}`);
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

const FIXTURE_TIMEOUT_MS = 60_000;

describe('the verdict on a finished scan', () => {
  it('refuses the exact output the broken fallback printed, although gitleaks exited 0', () => {
    expect(bytesScanned(MEASURED_EMPTY_SCAN)).toBe(0);
    const verdict = scanVerdict({ status: 0, output: MEASURED_EMPTY_SCAN, mayBeEmpty: false });
    expect(verdict.ok).toBe(false);
    // The git failure alone is enough, even where an empty staged diff would allow zero bytes.
    expect(scanVerdict({ status: 0, output: MEASURED_EMPTY_SCAN, mayBeEmpty: true }).ok).toBe(
      false,
    );
  });

  it('refuses zero bytes unless the host says there was nothing to read, and a missing count always', () => {
    const empty = 'INF 0 commits scanned.\nINF scanned ~0 bytes (0) in 3ms\nINF no leaks found';
    expect(scanVerdict({ status: 0, output: empty, mayBeEmpty: false }).ok).toBe(false);
    expect(scanVerdict({ status: 0, output: empty, mayBeEmpty: true })).toEqual({
      ok: true,
      status: 0,
    });
    expect(scanVerdict({ status: 0, output: 'INF no leaks found', mayBeEmpty: true }).ok).toBe(
      false,
    );
  });

  it('believes a scan that read bytes, and passes a finding or an error through unchanged', () => {
    const read = '\u001b[32mINF\u001b[0m scanned ~65 bytes (65 bytes) in 93ms\nINF no leaks found';
    expect(bytesScanned(read)).toBe(65);
    expect(scanVerdict({ status: 0, output: read, mayBeEmpty: false })).toEqual({
      ok: true,
      status: 0,
    });
    expect(scanVerdict({ status: 1, output: 'WRN leaks found: 1', mayBeEmpty: false })).toEqual({
      ok: true,
      status: 1,
    });
  });
});

describe('the pre-commit scan in a linked worktree', () => {
  it(
    'describes a linked worktree to the container through the common git directory',
    () => {
      const { main, worktree } = linkedWorktree();
      const layout = gitLayout(worktree);

      expect(layout).toMatchObject({
        workTree: worktree,
        commonDir: join(main, '.git'),
        linked: true,
        relativeGitDir: join('worktrees', 'wt'),
      });
      const args = containerArgs(layout ?? expect.fail('no layout'), 'image@sha256:x', ['git']);
      expect(args).toEqual(
        expect.arrayContaining([
          `${worktree}:/repo:ro`,
          `${join(main, '.git')}:/gitcommon:ro`,
          'GIT_DIR=/gitcommon/worktrees/wt',
          'GIT_COMMON_DIR=/gitcommon',
          'GIT_WORK_TREE=/repo',
        ]),
      );
      // An ordinary checkout: the git directory is the common one, so GIT_DIR is its root.
      expect(containerArgs(gitLayout(main) ?? expect.fail('no layout'), 'i', [])).toContain(
        'GIT_DIR=/gitcommon',
      );
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    'fails loudly when the scanner exits 0 over zero bytes of a staged change, and passes the same output over an empty one',
    () => {
      const { worktree } = linkedWorktree();
      installScanner(
        worktree,
        `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(MEASURED_EMPTY_SCAN.split('\n').slice(2).join('\n'))} >&2\nexit 0\n`,
      );
      writeFileSync(join(worktree, 'change.ts'), 'export const change = 1;\n');
      git(worktree, 'add', 'change.ts');
      expect(stagedAddedLines(worktree)).toBe(1);

      const refused = preCommitScan(worktree);

      expect(refused.stderr).toContain('THE SECRET SCAN READ NOTHING');
      expect(refused.stderr).toContain('scanned ~0 bytes of a target that has content to scan');
      expect(refused.status).toBe(1);

      // The control: the same scanner and the same output over a staged diff that adds nothing
      // (a message-only amend) is a correct empty scan, so the refusal is about the evidence and
      // not about the scanner.
      git(worktree, 'reset', '-q');
      expect(stagedAddedLines(worktree)).toBe(0);
      const empty = preCommitScan(worktree);
      expect(empty.stderr).not.toContain('THE SECRET SCAN READ NOTHING');
      expect(empty.status).toBe(0);
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    "finds a staged credential with the main worktree's binary, and passes a clean change it really read",
    () => {
      const { main, worktree } = linkedWorktree();
      // Resolution step 2: the worktree has no node_modules, the main worktree does.
      linkRealScanner(main);

      writeFileSync(join(worktree, 'leak.ts'), `export const value = '${PLANTED}';\n`);
      git(worktree, 'add', 'leak.ts');
      const leak = preCommitScan(worktree);
      expect(`${leak.stdout}${leak.stderr}`).toContain('leaks found: 1');
      expect(leak.status).toBe(1);

      git(worktree, 'reset', '-q');
      writeFileSync(join(worktree, 'clean.ts'), 'export const clean = 1;\n');
      git(worktree, 'add', 'clean.ts');
      const clean = preCommitScan(worktree);
      expect(bytesScanned(clean.stderr)).toBeGreaterThan(0);
      expect(clean.stderr).toContain('no leaks found');
      expect(clean.status).toBe(0);
    },
    FIXTURE_TIMEOUT_MS,
  );
});

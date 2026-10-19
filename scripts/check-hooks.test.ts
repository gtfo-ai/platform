import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkHooks, outsidePaths, readHooks } from './check-hooks.mjs';
import { initScratchRepository } from './git-scratch-env.mjs';

/**
 * `check-hooks.mjs` (WP-219, PROGRESS backlog 615): the reader of a hook's absolute paths, and the
 * whole check against scratch repositories whose hooks a real `lefthook install` wrote.
 */
const repositoryRoot = realpathSync(join(import.meta.dirname, '..'));

/** The lines of lefthook 2.1.12's hook that carry paths, as `lefthook install` writes them. */
const hookText = (installer: string) =>
  [
    '#!/bin/sh',
    'if [ "$LEFTHOOK" = "0" ]; then',
    '  exit 0',
    'fi',
    'call_lefthook()',
    '{',
    '  if test -n "$LEFTHOOK_BIN"',
    '  then',
    '    "$LEFTHOOK_BIN" "$@"',
    '  elif lefthook -h >/dev/null 2>&1',
    '  then',
    '    lefthook "$@"',
    `  elif ${installer} -h >/dev/null 2>&1`,
    '  then',
    `    ${installer} "$@"`,
    '  else',
    '    dir="$(git rev-parse --show-toplevel)"',
    "    cpuArch=$(uname -m | sed 's/aarch64/arm64/;s/x86_64/x64/')",
    '    if test -f "$dir/node_modules/lefthook/bin/index.js"',
    '    then',
    '      "$dir/node_modules/lefthook/bin/index.js" "$@"',
    '    fi',
    '  fi',
    '}',
    'call_lefthook run "pre-commit" "$@"',
  ].join('\n');

describe('outsidePaths', () => {
  const root = '/Users/someone/Projects/Agentic Platform/github/platform';
  const binary =
    'node_modules/.pnpm/lefthook-darwin-arm64@2.1.12/node_modules/lefthook-darwin-arm64/bin/lefthook';

  it('admits a path under a root that holds a space, unquoted as lefthook writes it', () => {
    expect(outsidePaths(hookText(`${root}/${binary}`), [root])).toEqual([]);
  });

  it('names a path outside every root whole, spaces included, on each line that carries it', () => {
    const elsewhere = `/private/tmp/session one/scratchpad/wp205-rev/copy/${binary}`;
    expect(outsidePaths(hookText(elsewhere), [root])).toEqual([
      { line: 13, path: elsewhere },
      { line: 15, path: elsewhere },
    ]);
  });

  it('reads a root as a directory, not as a string prefix', () => {
    const sibling = `${root}-copy/${binary}`;
    expect(outsidePaths(hookText(sibling), [root]).map(({ path }) => path)).toEqual([
      sibling,
      sibling,
    ]);
  });

  it('names a path under another worktree nested inside the main tree, by the longest prefix', () => {
    const nested = `${root}/.claude/worktrees/x`;
    const inNested = `${nested}/${binary}`;
    expect(outsidePaths(hookText(inNested), [root], [nested]).map(({ path }) => path)).toEqual([
      inNested,
      inNested,
    ]);
    // The nested worktree running the check admits its own path.
    expect(outsidePaths(hookText(inNested), [nested, root], [])).toEqual([]);
  });

  it('does not report /dev/null, a run-time path, a shebang or a sed expression', () => {
    expect(outsidePaths(hookText(`${root}/${binary}`), ['/elsewhere'])).toHaveLength(2);
    expect(
      outsidePaths('#!/bin/sh\nlefthook -h >/dev/null 2>&1\n"$dir/x" "$@"\n', ['/elsewhere']),
    ).toEqual([]);
  });
});

describe('readHooks', () => {
  it('reads every installed hook and none of git’s samples, and nothing from a missing directory', () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'check-hooks-read-')));
    try {
      writeFileSync(join(directory, 'pre-commit'), 'a');
      writeFileSync(join(directory, 'pre-commit.sample'), 'b');
      mkdirSync(join(directory, 'nested'));
      expect(readHooks(directory)).toEqual([{ name: 'pre-commit', text: 'a' }]);
      expect(readHooks(join(directory, 'absent'))).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

const lefthookPackage = join(repositoryRoot, 'node_modules', 'lefthook', 'package.json');
const lefthookInstalled = existsSync(lefthookPackage);
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A scratch main checkout under a spaced directory, one linked worktree, and a lefthook copy. */
const buildRepository = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'check-hooks-')));
  roots.push(root);
  const main = join(root, 'spaced dir', 'main');
  const worktree = join(root, 'spaced dir', 'wt one');
  mkdirSync(main, { recursive: true });
  const env = initScratchRepository(main, {
    initArgs: ['-b', 'main'],
    config: { 'core.hooksPath': join(main, '.git', 'hooks') },
  });
  const run = (command: string, args: string[], cwd: string) =>
    execFileSync(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
      killSignal: 'SIGKILL',
    });
  writeFileSync(join(main, 'lefthook.yml'), 'pre-commit:\n  jobs:\n    - run: "true"\n');
  run('git', ['add', '-A'], main);
  run('git', ['commit', '-q', '-m', 'chore: the scratch repository'], main);
  run('git', ['worktree', 'add', '-q', '--detach', worktree], main);
  const { getExePath } = createRequire(realpathSync(lefthookPackage))('./get-exe.js') as {
    getExePath: () => string;
  };
  /** Installs the hooks with a copy of lefthook placed at `directory`, so the hooks name it. */
  const installFrom = (directory: string) => {
    mkdirSync(directory, { recursive: true });
    const binary = join(directory, 'lefthook');
    copyFileSync(getExePath(), binary);
    chmodSync(binary, 0o755);
    run(binary, ['install', '-f'], main);
    return binary;
  };
  return { root, main, worktree, env, run, installFrom };
};

describe('checkHooks against a scratch repository (WP-219)', () => {
  it.skipIf(!lefthookInstalled)(
    lefthookInstalled
      ? 'passes with no hooks installed, and says there are none'
      : 'skipped: lefthook not installed',
    () => {
      const { main, env } = buildRepository();
      expect(checkHooks(main, env)).toMatchObject({ hooks: [], findings: [] });
    },
  );

  it.skipIf(!lefthookInstalled)(
    lefthookInstalled
      ? 'passes hooks installed from the main checkout, from it and from a linked worktree'
      : 'skipped: lefthook not installed',
    () => {
      const { main, worktree, env, installFrom } = buildRepository();
      const binary = installFrom(join(main, 'node_modules', '.bin'));
      expect(readFileSync(join(main, '.git', 'hooks', 'pre-commit'), 'utf8')).toContain(binary);
      for (const cwd of [main, worktree]) {
        const outcome = checkHooks(cwd, env);
        expect(outcome.hooks).toEqual(['pre-commit']);
        expect(outcome.findings).toEqual([]);
      }
    },
  );

  it.skipIf(!lefthookInstalled)(
    lefthookInstalled
      ? 'fails a copy of the hooks with one path pointed at a scratch directory, naming the hook and the path'
      : 'skipped: lefthook not installed',
    () => {
      const { root, main, worktree, env, installFrom } = buildRepository();
      const binary = installFrom(join(main, 'node_modules', '.bin'));
      const hook = join(main, '.git', 'hooks', 'pre-commit');
      const elsewhere = join(root, 'another session', 'copy', 'lefthook');
      writeFileSync(hook, readFileSync(hook, 'utf8').replaceAll(binary, elsewhere));
      for (const cwd of [main, worktree]) {
        const { findings } = checkHooks(cwd, env);
        expect(findings.length).toBeGreaterThan(0);
        expect(findings.map(({ hook: name, path }) => [name, path])).toEqual(
          findings.map(() => ['pre-commit', elsewhere]),
        );
      }
    },
  );

  it.skipIf(!lefthookInstalled)(
    lefthookInstalled
      ? 'fails hooks a sibling copy installed, from the main checkout, and admits a worktree’s own'
      : 'skipped: lefthook not installed',
    () => {
      const { root, main, worktree, env, installFrom } = buildRepository();
      installFrom(join(root, 'spaced dir', 'copy two', 'node_modules', '.bin'));
      expect(checkHooks(main, env).findings.length).toBeGreaterThan(0);
      installFrom(join(worktree, 'node_modules', '.bin'));
      expect(checkHooks(worktree, env).findings).toEqual([]);
      expect(checkHooks(main, env).findings.map(({ path }) => path)).toContain(
        join(worktree, 'node_modules', '.bin', 'lefthook'),
      );
    },
  );

  it.skipIf(!lefthookInstalled)(
    lefthookInstalled
      ? 'fails, from the main checkout, hooks a worktree nested under the main tree installed (round 1)'
      : 'skipped: lefthook not installed',
    () => {
      const { main, env, run, installFrom } = buildRepository();
      const nested = join(main, '.claude', 'worktrees', 'x');
      run('git', ['worktree', 'add', '-q', '--detach', nested], main);
      const binary = installFrom(join(nested, 'node_modules', '.bin'));
      rmSync(binary);
      const fromMain = checkHooks(main, env);
      expect(fromMain.excluded).toContain(nested);
      expect(fromMain.findings.length).toBeGreaterThan(0);
      expect(new Set(fromMain.findings.map(({ path }) => path))).toEqual(new Set([binary]));
      expect(checkHooks(nested, env).findings).toEqual([]);
    },
  );
});

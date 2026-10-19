#!/usr/bin/env node
/**
 * Fails when a git hook installed in this repository's shared git directory names an absolute path
 * outside this checkout — WP-219, PROGRESS backlog 615.
 *
 * The hooks live in the **common** git directory, so every linked worktree and every copy that
 * shares it runs the same three scripts, and `lefthook install` (the root `prepare` script, and
 * lefthook's own npm `postinstall`) rewrites them with the absolute path of **whichever copy ran
 * it** (`os.Executable()`, measured at WP-219). A session's worktree that ran `pnpm install` left
 * every checkout's hooks calling a binary under that worktree, which disappears with it. The rule
 * that keeps a worktree from writing them is technical/14's (`pnpm install --ignore-scripts`); this
 * is the check that notices when the rule was not followed.
 *
 * **What counts as inside.** The main working tree — the directory that owns the common git
 * directory, which is the one whose install the rule permits — and the top level of the checkout
 * running the check (the same directory, in the main checkout), each also by its real path. A
 * worktree's own path is admitted so the check reads the ruling's words ("outside this checkout's
 * top level"); the main tree is admitted so that hooks installed by the main checkout, the state
 * the rule asks for, do not fail every linked worktree's `verify`. So a worktree that wrote the
 * hooks is told by the **main** checkout's `verify`, which is the orchestrator's.
 *
 * **Except another worktree inside them.** `/.claude/worktrees/` (`.gitignore`) is this
 * repository's home for linked worktrees, and it is under the main tree, so "under the main tree"
 * alone admitted a nested worktree's binary — the exact 615 case (WP-219 review round 1, measured
 * by the reviewer). Every other worktree `git worktree list --porcelain` names is therefore an
 * **excluded** root, and a path belongs to whichever root, admitted or excluded, is its **longest**
 * prefix: so a nested worktree's path is outside from the main checkout, and the checkout running
 * the check still admits its own paths wherever it is nested.
 *
 * **What it reads.** Every regular file in `git rev-parse --git-path hooks` (which honours
 * `core.hooksPath`) except git's `*.sample` files. A path is a `/` at the start of a line or after
 * whitespace, a quote or `=`; one that begins with an admitted root followed by `/` is inside, so
 * a root holding a space (this machine's) is matched as a prefix rather than split. An outside path
 * is reported up to ` -h`, ` "$@"`, a quote, a shell operator or the end of the line, which is
 * where lefthook's template ends one. `/dev/null` is not a path anyone installs.
 *
 * **What it cannot see**, stated: a path after any other character (`>/x`, a shebang's `#!/x`), a
 * relative path, and a path the hook builds at run time (`"$dir/node_modules/…"`, which is the
 * per-checkout lookup and is meant to vary). A directory under the main tree that is not a
 * registered worktree — a plain copy, a pruned worktree's leftover, a `node_modules` someone placed
 * by hand — is admitted, because nothing but `git worktree list` tells a checkout from a directory.
 * A hook naming the main tree's own binary is admitted even when that binary is gone; whether the
 * path still resolves is not asked. A hook naming the main tree through a symlink alias is reported
 * as outside, because the roots are compared as written; a real install writes the resolved path
 * (measured, WP-219 review round 2), so only a hand-written hook meets this.
 *
 * No hooks installed (a clone before its first `pnpm install`) is a pass that says so. `LEFTHOOK=0`
 * does not stop an install (measured, WP-219), so it is not a way to reach that state. Prints exactly one
 * `PASS: hooks:check` / `FAIL: hooks:check` line on stdout (docs/technical/14).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { checkoutGitEnv } from './git-scratch-env.mjs';
import { isProgram } from './is-program.mjs';

/** Absolute paths a hook may name that are no checkout's. */
export const IGNORED_PATHS = Object.freeze(['/dev/null']);

const PATH_START = /(?:^|(?<=[\s"'=]))\//g;
const PATH_END = /\s+(?:-h(?=\s|$)|"\$@"|[>&|;\]])|["']|\s*$/;

const asPrefix = (root) => `${root.replace(/\/+$/, '')}/`;

/**
 * Every absolute path in a hook's text that is not inside `roots`, with its line number. A path is
 * inside when its longest matching prefix among `roots` and `excluded` is one of `roots`.
 */
export function outsidePaths(text, roots, excluded = []) {
  const prefixes = [
    ...roots.map((root) => ({ prefix: asPrefix(root), inside: true })),
    ...excluded.map((root) => ({ prefix: asPrefix(root), inside: false })),
  ].sort((a, b) => b.prefix.length - a.prefix.length);
  const found = [];
  text.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(PATH_START)) {
      const start = match.index;
      const rest = line.slice(start);
      if (prefixes.find(({ prefix }) => rest.startsWith(prefix))?.inside) continue;
      const end = PATH_END.exec(rest.slice(1));
      const path = rest.slice(0, end === null ? rest.length : end.index + 1);
      if (IGNORED_PATHS.includes(path)) continue;
      found.push({ line: index + 1, path });
    }
  });
  return found;
}

/** The installed hooks in `hooksDir`, git's `*.sample` files excepted; none when it is absent. */
export function readHooks(hooksDir) {
  if (!existsSync(hooksDir)) return [];
  return readdirSync(hooksDir)
    .filter((name) => !name.endsWith('.sample'))
    .sort()
    .map((name) => join(hooksDir, name))
    .filter((path) => statSync(path).isFile())
    .map((path) => ({ name: basename(path), text: readFileSync(path, 'utf8') }));
}

const withRealPath = (path) => {
  try {
    return [path, realpathSync(path)];
  } catch {
    return [path];
  }
};

/** Where the hooks are and which roots are inside, asked of git from `cwd`. */
export function hookLocations(cwd, env = checkoutGitEnv()) {
  const result = spawnSync(
    'git',
    [
      'rev-parse',
      '--path-format=absolute',
      '--show-toplevel',
      '--git-common-dir',
      '--git-path',
      'hooks',
    ],
    { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
  );
  if (result.status !== 0) {
    throw new Error(
      `git rev-parse exited ${result.status ?? result.signal}: ${result.stderr.trim()}`,
    );
  }
  const [topLevel, commonDir, hooksDir] = result.stdout.trim().split('\n');
  const mainTree = basename(commonDir) === '.git' ? [dirname(commonDir)] : [];
  const roots = [...new Set([topLevel, ...mainTree].flatMap(withRealPath))];
  const listed = spawnSync('git', ['worktree', 'list', '--porcelain'], {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
  if (listed.status !== 0) {
    throw new Error(
      `git worktree list exited ${listed.status ?? listed.signal}: ${listed.stderr.trim()}`,
    );
  }
  const excluded = [
    ...new Set(
      listed.stdout
        .split('\n')
        .filter((line) => line.startsWith('worktree '))
        .flatMap((line) => withRealPath(line.slice('worktree '.length))),
    ),
  ].filter((path) => !roots.includes(path));
  return { hooksDir, roots, excluded };
}

/** The whole check: the hooks read, and every outside path named by hook and line. */
export function checkHooks(cwd, env = checkoutGitEnv()) {
  const { hooksDir, roots, excluded } = hookLocations(cwd, env);
  const hooks = readHooks(hooksDir);
  const findings = hooks.flatMap(({ name, text }) =>
    outsidePaths(text, roots, excluded).map((finding) => ({ hook: name, ...finding })),
  );
  return { hooksDir, roots, excluded, hooks: hooks.map(({ name }) => name), findings };
}

if (isProgram(import.meta.url)) {
  const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
  let outcome;
  try {
    outcome = checkHooks(repositoryRoot);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.stdout.write('FAIL: hooks:check\n');
    process.exit(2);
  }
  const { hooksDir, roots, hooks, findings } = outcome;
  if (findings.length > 0) {
    for (const { hook, line, path } of findings) {
      process.stderr.write(
        `${join(hooksDir, hook)}:${line}: ${path} is outside ${roots.join(' and ')}\n`,
      );
    }
    process.stderr.write(
      'Reinstall the hooks from the main checkout (`pnpm exec lefthook install`; an up-to-date `pnpm install` does not rewrite them, measured); a worktree or copy installs with `pnpm install --ignore-scripts` (technical/14).\n',
    );
    process.stdout.write('FAIL: hooks:check\n');
    process.exit(1);
  }
  process.stdout.write(
    hooks.length === 0
      ? `PASS: hooks:check (no hooks installed in ${hooksDir})\n`
      : `PASS: hooks:check (${hooks.length} hooks in ${hooksDir}, every absolute path inside ${roots.join(' and ')})\n`,
  );
}

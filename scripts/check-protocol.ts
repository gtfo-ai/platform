/**
 * `pnpm protocol:check` — a change to the worker protocol's version is a release that can follow the
 * one before it (TD-032 decision 7, WP-273). A step of `verify:static`, so CI's lint job runs it.
 *
 * ## What it compares
 *
 * `WORKER_PROTOCOL_VERSION` and `ACCEPTED_WORKER_PROTOCOLS` in `packages/contracts/src/worker.ts`,
 * read as **text** in three places: the working tree (off disk, so a file being written is checked
 * before it is staged — standing rule 85), the push's **base** commit, and the base's **first
 * parent** — "the value one release earlier", because every push to `main` is a release (TD-019's
 * 2026-09-16 amendment). The base is resolved by `resolveMigrationsBase` (`check-migrations.ts`),
 * the one resolution `verify:commits` and `migrations:check` already share: `--from` /
 * `COMMIT_RANGE_FROM`, the GitHub event payload, `@{upstream}`, then a branch's merge base with
 * `origin/main`; a shallow clone is refused by name.
 *
 * ## The rules
 *
 * Let `N` be the tree's version, `B` the base's and `P` the base's first parent's.
 *
 * 1. **The tree's constants are literals in the declared shape** — a positive integer and a sorted
 *    list of distinct positive integers that contains `N` and nothing outside `{N-1, N}` (TD-031 §9:
 *    the core accepts `[N-1, N]`). A constant this reader cannot find fails the check: a check that
 *    cannot read the value must not pass.
 * 2. **With no constant at the base** (before WP-273, or a base without the file) the tree's value is
 *    an introduction, not a bump, and only rule 1 applies.
 * 3. **`N = B`**: no bump, so the accepted list is the base's, unchanged. Dropping `N-1` without a bump
 *    would strand every worker one version behind; adding one is not a shape rule 1 admits.
 * 4. **`N ≠ B`** is a bump, admitted only when
 *    - `N = B + 1` — no skip, no decrease;
 *    - the accepted list still contains `B` — the release that bumps `N` serves the workers it was
 *      serving (expand before contract);
 *    - `B = P` — **TD-032 §7's own rule**: *a bump is refused when the base commit's value differs
 *      from the value one release earlier* — no two bumps in consecutive pushes, so a worker at `N-1`
 *      always meets one release that serves it before it must update. A `P` with no constant (the
 *      base introduced it, or has no parent) is not a bump.
 *
 * ## What it cannot see, stated
 *
 * - **A push is a release, and git does not record pushes.** "One release earlier" is read as the
 *   base's first parent. When the previous push carried several commits and its *last* commit did
 *   not touch the constant, `P` equals `B` although that push bumped — the check then admits a bump
 *   in the next push. CI's run on that push is still held to rules 3–4 against its own base.
 * - Whether the base is on `main`, as `migrations:check` states for itself.
 * - That a release honoured the shapes it advertises: this reads two literals, not the routes.
 *
 * Prints exactly one `PASS: protocol:check` / `FAIL: protocol:check` line on stdout
 * (docs/technical/14); everything else goes to stderr.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MigrationsBaseError, resolveMigrationsBase } from './check-migrations.js';
import { CommitRangeError, type GitRunner, gitRunner } from './commit-range.mjs';
import type { Environment } from './git-scratch-env.mjs';

/** Where the two constants live, relative to the repository root. */
export const WORKER_PROTOCOL_PATH = 'packages/contracts/src/worker.ts';

/** The two constants as one revision declares them. */
export interface ProtocolDeclaration {
  readonly version: number;
  readonly accepted: readonly number[];
}

/** A file that holds the constants in a shape this reader cannot parse. */
export class ProtocolDeclarationError extends Error {
  override readonly name = 'ProtocolDeclarationError';
}

const VERSION_LINE = /^export const WORKER_PROTOCOL_VERSION\s*=\s*(\d+)\s*;/m;
const ACCEPTED_LINE =
  /^export const ACCEPTED_WORKER_PROTOCOLS\s*=\s*\[([^\]]*)\]\s*(?:as const\s*)?;/m;

/**
 * The constants in a file's text, `null` when the file declares neither (an older revision), and a
 * {@link ProtocolDeclarationError} when it declares one but not the other, or a value that is not a
 * literal of the expected form.
 */
export const parseProtocolDeclaration = (text: string | null): ProtocolDeclaration | null => {
  if (text === null) return null;
  const version = VERSION_LINE.exec(text);
  const accepted = ACCEPTED_LINE.exec(text);
  if (version === null && accepted === null) {
    if (/WORKER_PROTOCOL_VERSION|ACCEPTED_WORKER_PROTOCOLS/.test(text)) {
      throw new ProtocolDeclarationError(
        `${WORKER_PROTOCOL_PATH} names the protocol constants but not as \`export const NAME = <literal>;\``,
      );
    }
    return null;
  }
  if (version === null || accepted === null) {
    throw new ProtocolDeclarationError(
      `${WORKER_PROTOCOL_PATH} declares ${version === null ? 'ACCEPTED_WORKER_PROTOCOLS' : 'WORKER_PROTOCOL_VERSION'} without ${version === null ? 'WORKER_PROTOCOL_VERSION' : 'ACCEPTED_WORKER_PROTOCOLS'} as a literal`,
    );
  }
  const items = (accepted[1] ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (items.some((item) => !/^\d+$/.test(item))) {
    throw new ProtocolDeclarationError(
      `ACCEPTED_WORKER_PROTOCOLS is not a list of integer literals: [${accepted[1] ?? ''}]`,
    );
  }
  return { version: Number(version[1]), accepted: items.map(Number) };
};

/** Rule 1: the shape a declaration must have, as findings. */
export const shapeFindings = ({ version, accepted }: ProtocolDeclaration): string[] => {
  const findings: string[] = [];
  if (!Number.isSafeInteger(version) || version < 1) {
    findings.push(`WORKER_PROTOCOL_VERSION must be a positive integer; it is ${version}`);
  }
  const sorted = [...new Set(accepted)].sort((a, b) => a - b);
  if (
    sorted.length !== accepted.length ||
    sorted.some((value, index) => value !== accepted[index])
  ) {
    findings.push(
      `ACCEPTED_WORKER_PROTOCOLS must be sorted and distinct; it is [${accepted.join(', ')}]`,
    );
  }
  if (!accepted.includes(version)) {
    findings.push(`ACCEPTED_WORKER_PROTOCOLS must contain WORKER_PROTOCOL_VERSION (${version})`);
  }
  const outside = accepted.filter((value) => value !== version && value !== version - 1);
  if (outside.length > 0 || accepted.some((value) => value < 1)) {
    findings.push(
      `ACCEPTED_WORKER_PROTOCOLS holds only N-1 and N (TD-031 decision 9); [${accepted.join(', ')}] has ${outside.join(', ') || 'a value below 1'}`,
    );
  }
  return findings;
};

/**
 * Every finding for `tree` against `base` and `previous` (the base's first parent) — empty when the
 * change is admitted. `null` is "no declaration there".
 */
export const protocolFindings = (
  tree: ProtocolDeclaration,
  base: ProtocolDeclaration | null,
  previous: ProtocolDeclaration | null,
): string[] => {
  const findings = shapeFindings(tree);
  if (base === null) return findings;
  const same = (a: readonly number[], b: readonly number[]) =>
    a.length === b.length && a.every((value, index) => value === b[index]);
  if (tree.version === base.version) {
    if (!same(tree.accepted, base.accepted)) {
      findings.push(
        `ACCEPTED_WORKER_PROTOCOLS changed from [${base.accepted.join(', ')}] to [${tree.accepted.join(', ')}] without a version bump; the accepted range moves only with WORKER_PROTOCOL_VERSION (TD-032 decision 7)`,
      );
    }
    return findings;
  }
  if (tree.version !== base.version + 1) {
    findings.push(
      `WORKER_PROTOCOL_VERSION moved from ${base.version} to ${tree.version}; a bump is exactly ${base.version + 1} — no skip and no decrease (TD-032 decision 7)`,
    );
  }
  if (!tree.accepted.includes(base.version)) {
    findings.push(
      `the bump to ${tree.version} drops ${base.version} from ACCEPTED_WORKER_PROTOCOLS; the release that bumps N still serves N-1 (expand before contract, TD-032 decision 7)`,
    );
  }
  if (previous !== null && previous.version !== base.version) {
    findings.push(
      `the base already bumped WORKER_PROTOCOL_VERSION (${previous.version} → ${base.version}) over the release before it; no two bumps in consecutive pushes (TD-032 decision 7)`,
    );
  }
  return findings;
};

/** The file's text at `rev`, or `null` when it does not exist there. */
const showAt = (git: GitRunner, rev: string, path: string): string | null => {
  const shown = git.run(['show', `${rev}:${path}`]);
  return shown.status === 0 ? shown.stdout : null;
};

/** The base's first parent, or `null` for a root commit. */
const firstParentOf = (git: GitRunner, rev: string): string | null => {
  const parent = git.run(['rev-parse', '--verify', '--quiet', `${rev}^1^{commit}`]);
  return parent.status === 0 ? parent.stdout.trim() : null;
};

/** The three declarations the rules compare: the tree's, the base's and the release before it. */
export const readDeclarations = (
  root: string,
  base: string,
  git: GitRunner,
): {
  readonly tree: ProtocolDeclaration | null;
  readonly base: ProtocolDeclaration | null;
  readonly previous: ProtocolDeclaration | null;
} => {
  let treeText: string | null;
  try {
    treeText = readFileSync(join(root, WORKER_PROTOCOL_PATH), 'utf8');
  } catch {
    treeText = null;
  }
  const parent = firstParentOf(git, base);
  return {
    tree: parseProtocolDeclaration(treeText),
    base: parseProtocolDeclaration(showAt(git, base, WORKER_PROTOCOL_PATH)),
    previous:
      parent === null ? null : parseProtocolDeclaration(showAt(git, parent, WORKER_PROTOCOL_PATH)),
  };
};

const USAGE = 'usage: node scripts/check-protocol.mjs [--from <rev>] [--to <rev>]';

/** The command line: one PASS/FAIL line on `stdout`, the reasons on `stderr`; the exit code. */
export const runProtocolCheck = (
  argv: readonly string[],
  {
    root,
    env = process.env,
    stdout = (text: string) => process.stdout.write(text),
    stderr = (text: string) => process.stderr.write(text),
  }: {
    readonly root: string;
    readonly env?: Environment;
    readonly stdout?: (text: string) => unknown;
    readonly stderr?: (text: string) => unknown;
  },
): number => {
  const fail = (message: string, code = 1): number => {
    stderr(`${message}\n`);
    stdout('FAIL: protocol:check\n');
    return code;
  };
  let from: string | null = null;
  let to: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (arg === '--from' || arg === '--to') {
      const value = argv[index + 1];
      if (value === undefined) return fail(`${arg} needs a value\n${USAGE}`, 2);
      if (arg === '--from') from = value;
      else to = value;
      index += 1;
    } else if (arg.startsWith('--from=')) from = arg.slice('--from='.length);
    else if (arg.startsWith('--to=')) to = arg.slice('--to='.length);
    else return fail(`unexpected argument ${JSON.stringify(arg)}\n${USAGE}`, 2);
  }
  const git = gitRunner(root, env);
  try {
    const { base, label } = resolveMigrationsBase(git, { from, to, env }, 'the protocol constants');
    if (base === null) {
      stdout(`PASS: protocol:check (${label}; nothing to compare)\n`);
      return 0;
    }
    const declarations = readDeclarations(root, base, git);
    if (declarations.tree === null) {
      return fail(
        `${WORKER_PROTOCOL_PATH} declares no WORKER_PROTOCOL_VERSION / ACCEPTED_WORKER_PROTOCOLS literal; the check cannot pass a value it cannot read`,
      );
    }
    const findings = protocolFindings(declarations.tree, declarations.base, declarations.previous);
    if (findings.length > 0) {
      for (const finding of findings) stderr(`${WORKER_PROTOCOL_PATH}: ${finding}\n`);
      return fail(`protocol:check against ${label}: ${findings.length} finding(s)`);
    }
    const { version, accepted } = declarations.tree;
    const verdict =
      declarations.base === null
        ? 'introduced'
        : declarations.base.version === version
          ? 'unchanged'
          : `bumped from ${declarations.base.version}`;
    stdout(
      `PASS: protocol:check (worker protocol ${version}, accepts [${accepted.join(', ')}], ${verdict}; ${label})\n`,
    );
    return 0;
  } catch (error) {
    if (
      error instanceof MigrationsBaseError ||
      error instanceof CommitRangeError ||
      error instanceof ProtocolDeclarationError
    ) {
      return fail(error.message);
    }
    throw error;
  }
};

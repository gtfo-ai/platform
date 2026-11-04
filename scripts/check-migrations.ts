/**
 * `pnpm migrations:check` — every migration this change adds declares a class, and the class is
 * true (TD-032 decision 1, the TD-011 amendment of 2026-11-04, WP-271). A step of `verify:static`,
 * so CI's lint job runs it.
 *
 * ## What it compares
 *
 * The **working tree's** migrations directory — read off disk, as `loadMigrations` reads it, so a
 * file somebody is writing right now is checked before it is staged (standing rule 85) — against
 * the same directory at the **push's base commit**. The base is resolved exactly as `verify:commits`
 * resolves its range (`commit-range.mjs`: `--from`/`COMMIT_RANGE_FROM`, the GitHub event payload,
 * then `@{upstream}`); the range's `from` is the base. Two additions, both stated:
 *
 * - **A shallow clone is refused by name**: what existed at the base is unknowable in one, and a
 *   check that cannot know the base must not pass. CI's lint job checks out with `fetch-depth: 0`.
 * - **A local branch with no upstream** (an orchestrator's worktree branch) falls back to its merge
 *   base with `origin/main`, which is the base its push to `main` will be compared with, and says
 *   so on stderr. With no `origin/main` either it fails, naming `--from`.
 *
 * ## The rules
 *
 * 1. **An applied file is never edited** (TD-011, now checked rather than trusted): every file at
 *    the base is still in the tree with the same SHA-256 — the checksum the migrator records — and
 *    none is deleted.
 * 2. **Every new file declares its class** in its first line (`migration-class.ts`). Files that
 *    exist at the base are exempt: 0001–0091 are applied history and carry none.
 * 3. **An `additive` file holds only admitted statements** (`migration-scanner.ts`; an unknown
 *    statement fails). Its `alter type … add value 'v'` is admitted only when `'v'` is already in
 *    `packages/contracts` at the base commit (`git grep`).
 * 4. **A `contract` file's `expands:` exists at the base and is `additive` there** — so the expand
 *    was released by an earlier push (every push to `main` is a release, TD-019) and the two never
 *    land in one release.
 * 5. **`raises-rollback-floor` moves the label**: a header carrying it fails unless
 *    `docker/app.Dockerfile`'s `org.platform.rollback-floor` is a larger integer in the tree than at
 *    the base (an absent label reads as 0).
 *
 * ## What it cannot see, stated
 *
 * - Whether the base is **on `main`**: it is whatever the range resolution answers. CI's push and
 *   pull-request ranges start on `main`; a local `@{upstream}` that is a feature branch can admit a
 *   contract whose expand was pushed there but never released — CI's run on the pull request is
 *   the one that holds rule 4.
 * - The scanner's own blind spots (its docblock): a function body, a view's meaning, a volatile
 *   default.
 * - A new file numbered below an applied one is not refused here (the migrator applies it on a
 *   fresh database in a different order than on an upgraded one).
 *
 * Prints exactly one `PASS: migrations:check` / `FAIL: migrations:check` line on stdout
 * (docs/technical/14); everything else goes to stderr.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MigrationHeaderError,
  parseMigrationHeader,
} from '../packages/infrastructure/src/db/migration-class.js';
import {
  declaredFunctionSignatures,
  scanAdditive,
} from '../packages/infrastructure/src/db/migration-scanner.js';
import { MIGRATION_FILE } from '../packages/infrastructure/src/db/migrations.js';
import {
  CommitRangeError,
  type GitRunner,
  gitRunner,
  isShallowCheckout,
  resolveCommitRange,
} from './commit-range.mjs';
import type { Environment } from './git-scratch-env.mjs';

/** Where the migrations live, relative to the repository root. */
export const MIGRATIONS_PATH = 'packages/infrastructure/src/db/migrations';
/** The image whose label a `raises-rollback-floor` migration must move (TD-032 decision 2). */
export const APP_DOCKERFILE = 'docker/app.Dockerfile';
export const ROLLBACK_FLOOR_LABEL = 'org.platform.rollback-floor';
/** Where an enum value must already exist before `alter type … add value` is additive. */
export const CONTRACTS_PATH = 'packages/contracts';
/** The ref a branch with no upstream is compared with. */
export const MAINLINE_REF = 'refs/remotes/origin/main';

/** One thing wrong, located. */
export interface MigrationsFinding {
  readonly file: string;
  readonly line?: number;
  readonly message: string;
}

/** The base could not be decided, so nothing was checked. */
export class MigrationsBaseError extends Error {
  override readonly name = 'MigrationsBaseError';
}

/** The base commit and how it was decided, or `null` when the range is empty (a branch deletion). */
export interface MigrationsBase {
  readonly base: string | null;
  readonly label: string;
}

/** The push's base commit, resolved as `verify:commits` resolves its range (see the docblock). */
export const resolveMigrationsBase = (
  git: GitRunner,
  options: {
    readonly from?: string | null;
    readonly to?: string | null;
    readonly env?: Environment;
  },
): MigrationsBase => {
  if (isShallowCheckout(git)) {
    throw new MigrationsBaseError(
      'this checkout is shallow, so the migrations at the push’s base are unknowable — use `fetch-depth: 0`.',
    );
  }
  let range: ReturnType<typeof resolveCommitRange>;
  try {
    range = resolveCommitRange(git, options);
  } catch (error) {
    if (!(error instanceof CommitRangeError)) throw error;
    if (error.code !== 'no_upstream') throw new MigrationsBaseError(error.message);
    const fallback = git.run(['merge-base', 'HEAD', MAINLINE_REF]);
    if (fallback.status !== 0) {
      throw new MigrationsBaseError(
        `${error.message} There is no ${MAINLINE_REF} to fall back to either.`,
      );
    }
    const base = fallback.stdout.trim();
    return { base, label: `no upstream; the merge base with ${MAINLINE_REF}, ${base.slice(0, 9)}` };
  }
  if (range.contiguous !== null) return { base: range.contiguous.from, label: range.label };
  if (range.revList.length === 0) return { base: null, label: range.label };
  throw new MigrationsBaseError(
    `${range.label}: there is no base commit to compare the migrations with; pass --from <rev>`,
  );
};

const sha256 = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');

/** Every `<name>.sql` under {@link MIGRATIONS_PATH} at `base`, with its contents. */
export const migrationsAt = (git: GitRunner, base: string): Map<string, string> => {
  const listing = git.run(['ls-tree', '-r', '-z', base, '--', `${MIGRATIONS_PATH}/`]);
  if (listing.status !== 0) {
    throw new MigrationsBaseError(`git ls-tree ${base}: ${listing.stderr.trim()}`);
  }
  const entries = listing.stdout
    .split('\0')
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const [meta = '', path = ''] = entry.split('\t');
      return { blob: meta.split(' ')[2] ?? '', path };
    })
    .filter((entry) => entry.path.endsWith('.sql'));
  const files = new Map<string, string>();
  for (const { blob, path } of entries) {
    const shown = git.run(['cat-file', 'blob', blob]);
    if (shown.status !== 0)
      throw new MigrationsBaseError(`git cat-file ${blob}: ${shown.stderr.trim()}`);
    files.set(path.slice(MIGRATIONS_PATH.length + 1), shown.stdout);
  }
  return files;
};

/** The `org.platform.rollback-floor` label's value in a Dockerfile's text, or `null`. */
export const rollbackFloorOf = (dockerfile: string | null): number | null => {
  if (dockerfile === null) return null;
  const match = new RegExp(
    `${ROLLBACK_FLOOR_LABEL.replaceAll('.', '\\.')}\\s*=\\s*"?(\\d+)"?`,
  ).exec(dockerfile);
  return match === null ? null : Number(match[1]);
};

/** A file's text at `base`, or `null` when it does not exist there. */
const showAt = (git: GitRunner, base: string, path: string): string | null => {
  const shown = git.run(['show', `${base}:${path}`]);
  return shown.status === 0 ? shown.stdout : null;
};

/** Whether `value` appears quoted anywhere under `packages/contracts` at `base`. */
export const enumValueAt = (git: GitRunner, base: string, value: string): boolean => {
  const quoted = [`'${value}'`, `"${value}"`, `\`${value}\``];
  const result = git.run([
    'grep',
    '-q',
    '-F',
    ...quoted.flatMap((needle) => ['-e', needle]),
    base,
    '--',
    CONTRACTS_PATH,
  ]);
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new MigrationsBaseError(`git grep at ${base}: ${result.stderr.trim()}`);
};

/** Every finding for the tree at `root` against `base` — empty when the change is clean. */
export const checkMigrations = (
  root: string,
  base: string,
  git: GitRunner,
): {
  readonly findings: MigrationsFinding[];
  readonly added: string[];
  readonly applied: number;
} => {
  const findings: MigrationsFinding[] = [];
  const atBase = migrationsAt(git, base);
  const directory = join(root, MIGRATIONS_PATH);
  const tree = new Map(
    readdirSync(directory)
      .filter((entry) => entry.endsWith('.sql'))
      .sort()
      .map((entry) => [entry, readFileSync(join(directory, entry), 'utf8')] as const),
  );

  // Rule 1: an applied file is never edited or deleted.
  for (const [file, sql] of atBase) {
    const now = tree.get(file);
    if (now === undefined) {
      findings.push({
        file,
        message: 'is applied at the base and deleted here; migrations are forward-only (TD-011)',
      });
    } else if (sha256(now) !== sha256(sql)) {
      findings.push({
        file,
        message:
          'is applied at the base and edited here; its checksum is recorded by every database that applied it — add a new file instead (TD-011)',
      });
    }
  }

  const added = [...tree.keys()].filter((file) => !atBase.has(file));
  const sorted = [...tree.keys()];
  for (const file of added) {
    const sql = tree.get(file) as string;
    if (!MIGRATION_FILE.test(file)) {
      findings.push({ file, message: 'does not match <nnnn>_<snake_case>.sql' });
      continue;
    }
    // Rule 2: a header, and a valid one.
    let header: ReturnType<typeof parseMigrationHeader>;
    try {
      header = parseMigrationHeader(sql);
    } catch (error) {
      if (!(error instanceof MigrationHeaderError)) throw error;
      findings.push({ file, line: 1, message: error.message });
      continue;
    }
    if (header === null) {
      findings.push({
        file,
        line: 1,
        message:
          'declares no class: a new migration opens with `-- migration-class: additive` or `-- migration-class: contract; expands: <nnnn>_<name>` (TD-032 decision 1)',
      });
      continue;
    }
    // Rule 5: the rollback floor moves with the change that says it raises it.
    if (header.raisesRollbackFloor) {
      const before = rollbackFloorOf(showAt(git, base, APP_DOCKERFILE)) ?? 0;
      const now = rollbackFloorOf(readOptional(join(root, APP_DOCKERFILE)));
      if (now === null || now <= before) {
        findings.push({
          file,
          line: 1,
          message: `says raises-rollback-floor, but ${APP_DOCKERFILE}'s ${ROLLBACK_FLOOR_LABEL} label is ${now ?? 'absent'} here and ${before} at the base; raise it in the same change (TD-032 decision 2)`,
        });
      }
    }
    if (header.class === 'contract') {
      // Rule 4: the expand was released by an earlier push.
      const expand = `${header.expands as string}.sql`;
      const expandAtBase = atBase.get(expand);
      if (expandAtBase === undefined) {
        findings.push({
          file,
          line: 1,
          message: tree.has(expand)
            ? `expands ${header.expands}, which is new in this change too; the expand must be released by an earlier push (TD-032 decision 1)`
            : `expands ${header.expands}, which does not exist at the base`,
        });
        continue;
      }
      let expandHeader: ReturnType<typeof parseMigrationHeader> = null;
      try {
        expandHeader = parseMigrationHeader(expandAtBase);
      } catch {
        expandHeader = null;
      }
      if (expandHeader?.class !== 'additive') {
        findings.push({
          file,
          line: 1,
          message: `expands ${header.expands}, which is not declared additive at the base (${expandHeader?.class ?? 'no class'})`,
        });
      }
      continue;
    }
    // Rule 3: an additive file holds only admitted statements.
    const earlier = sorted
      .filter((other) => other < file)
      .map((other) => tree.get(other) as string);
    const refusals = scanAdditive(sql, {
      enumValueAtBase: (value) => enumValueAt(git, base, value),
      functionSignatures: declaredFunctionSignatures(earlier),
    });
    for (const refusal of refusals) {
      findings.push({
        file,
        line: refusal.line,
        message: `${refusal.statement === '' ? '' : `\`${refusal.statement}\`: `}${refusal.reason}`,
      });
    }
  }
  return { findings, added, applied: atBase.size };
};

const readOptional = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

const USAGE = 'usage: node scripts/check-migrations.mjs [--from <rev>] [--to <rev>]';

/** The command line: one PASS/FAIL line on `stdout`, the reasons on `stderr`; the exit code. */
export const runMigrationsCheck = (
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
    stdout('FAIL: migrations:check\n');
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
    const { base, label } = resolveMigrationsBase(git, { from, to, env });
    if (base === null) {
      stdout(`PASS: migrations:check (${label}; nothing to compare)\n`);
      return 0;
    }
    const { findings, added, applied } = checkMigrations(root, base, git);
    if (findings.length > 0) {
      for (const finding of findings) {
        stderr(
          `${MIGRATIONS_PATH}/${finding.file}${finding.line === undefined ? '' : `:${finding.line}`}: ${finding.message}\n`,
        );
      }
      return fail(`migrations:check against ${label}: ${findings.length} finding(s)`);
    }
    stdout(
      `PASS: migrations:check (${added.length} new migration(s) classified and checked, ${applied} applied at the base unchanged; ${label})\n`,
    );
    return 0;
  } catch (error) {
    if (error instanceof MigrationsBaseError || error instanceof CommitRangeError) {
      return fail(error.message);
    }
    throw error;
  }
};

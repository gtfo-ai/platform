#!/usr/bin/env node
/**
 * `node scripts/git-long-options.mjs` — writes `packages/domain/src/policies/git-long-options.generated.ts`
 * (WP-161 ruling (c), PROGRESS backlog 515).
 *
 * git resolves an abbreviated long option (`--no-verif`) by its parse-options tables, so the command
 * policy floors any `--t` that is a prefix of a hazardous spelling unless git's own resolution of
 * `t` against the subcommand's table answers exactly one option that is not hazardous. Those tables
 * are **git's**, not a list somebody keeps: this script reads them out of the run image's git with
 * `git <sub> --git-completion-helper-all`, inside a throwaway repository in a container with no
 * network that is removed afterwards. That flag is parse-options' own: it prints the subcommand's
 * long options and exits before the subcommand does anything (`parse-options.c`, `show_gitcomp`).
 * Nothing else runs — no payload, no hook, no remote.
 *
 * It covers every subcommand an allow, ask or block entry names (`POLICY_GIT_SUBCOMMANDS`), plus
 * every builtin whose table holds a hazardous spelling (`GIT_ABBREVIATION_HAZARDS`). `log`, `show`
 * and `whatchanged` print only their own words; their diff options are diff's, which git matches
 * **exactly** (`git log --textco` and `git diff --ext-dif` were refused, measured), so diff's
 * spellings are added to them as exact-only entries — `git log -p --text` resolves to `--text`.
 *
 * It **refuses** to write a table it expected and did not get: a git that drops the undocumented
 * helper, or prints nothing for a subcommand the policy names, fails here loudly instead of
 * silently giving every abbreviation the floor (or, worse, an empty table that resolves nothing).
 *
 * Not a `verify` target, for `runlet-container-check`'s reason: it needs a Docker daemon and the
 * run image. `node scripts/git-long-options-check.mjs` regenerates and diffs.
 *
 * Usage: `node scripts/git-long-options.mjs [--image <ref>] [--out <path>]`
 * (default image `platform-runtime:${GIT_OPTIONS_IMAGE_TAG:-wp151}`).
 */
import { execFile, spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import './ts-source-resolver.mjs';

const exec = promisify(execFile);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const GENERATED_PATH = path.join(
  REPO,
  'packages/domain/src/policies/git-long-options.generated.ts',
);
export const DEFAULT_IMAGE = `platform-runtime:${process.env.GIT_OPTIONS_IMAGE_TAG ?? 'wp151'}`;

const { POLICY_GIT_SUBCOMMANDS, GIT_ABBREVIATION_HAZARDS } = await import(
  '../packages/domain/src/policies/command-policy.ts'
);

/**
 * Builtins not probed: daemons, servers and credential helpers that speak a protocol on standard
 * input, the remote helpers (`remote-ext` runs its argument), and internal workers. None of them is
 * a verb a run writes, and none takes a long option this policy floors.
 */
const NOT_PROBED = new Set([
  'credential',
  'credential-cache',
  'credential-cache--daemon',
  'credential-store',
  'fsmonitor--daemon',
  'remote-ext',
  'remote-fd',
  'upload-pack',
  'upload-archive',
  'upload-archive--writer',
  'receive-pack',
  'checkout--worker',
  'index-pack',
  'fast-import',
  'mailinfo',
  'mailsplit',
  'unpack-objects',
  'submodule--helper',
]);

/** Subcommands measured to print no table (scripts, or a builtin that does not use parse-options for it). */
export const EXPECTED_TABLELESS = ['mergetool', 'fetch-pack', 'submodule'];

/** The subcommands whose diff options are diff's, matched exactly. */
const DIFF_FAMILY = ['log', 'show', 'whatchanged'];

/** Runs one shell script in the image, with no network, in a throwaway repository. */
const inImage = async (image, script, args = []) => {
  const { stdout } = await exec(
    'docker',
    ['run', '--rm', '--network', 'none', '--entrypoint', 'sh', image, '-c', script, 'sh', ...args],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  return stdout;
};

const PROBE = `
set -u
export HOME="$(mktemp -d)" GIT_CONFIG_NOSYSTEM=1
cd "$(mktemp -d)" && git init -q .
git --version
out="$(mktemp)"
for sub in "$@"; do
  timeout 5 git "$sub" --git-completion-helper-all </dev/null >"$out" 2>/dev/null
  status=$?
  printf '%s\\t%s\\t%s\\n' "$sub" "$status" "$(tr '\\n' ' ' <"$out")"
done
`;

/** The words of one helper output: `--name=` → `name`, the `--` separator dropped, duplicates gone. */
const spellings = (out) => [
  ...new Set(
    out
      .split(/\s+/)
      .filter((word) => word.length > 0 && word !== '--')
      .map((word) => word.replace(/^--/, '').replace(/=$/, '')),
  ),
];

/** Reads the tables out of the image. */
export const readTables = async (image = DEFAULT_IMAGE) => {
  const builtins = (await inImage(image, 'git --list-cmds=builtins')).split(/\s+/).filter(Boolean);
  const named = new Set(POLICY_GIT_SUBCOMMANDS);
  const probe = [
    ...new Set([
      ...named,
      ...EXPECTED_TABLELESS,
      ...builtins.filter((sub) => !NOT_PROBED.has(sub)),
    ]),
  ].sort();
  const [versionLine, ...lines] = (await inImage(image, PROBE, probe)).trimEnd().split('\n');
  const version = (versionLine ?? '').trim();
  if (!/^git version \d+\.\d+\.\d+/.test(version)) {
    throw new Error(`git --version printed ${JSON.stringify(versionLine)}`);
  }
  const hazards = new Set(GIT_ABBREVIATION_HAZARDS.map((hazard) => hazard.spelling));
  const tables = new Map();
  const tableless = [];
  for (const line of lines) {
    const [sub, status, out = ''] = line.split('\t');
    const words = out.trim().split(/\s+/).filter(Boolean);
    const isTable =
      status === '0' && words.length > 0 && words.every((word) => /^--[a-z0-9-]*=?$/.test(word));
    if (!isTable) {
      if (named.has(sub) && !EXPECTED_TABLELESS.includes(sub)) {
        throw new Error(
          `git ${sub} --git-completion-helper-all printed no option table (exit ${status}): ${out.slice(0, 200)}`,
        );
      }
      if (EXPECTED_TABLELESS.includes(sub)) {
        tableless.push(sub);
      }
      continue;
    }
    if (EXPECTED_TABLELESS.includes(sub)) {
      throw new Error(`git ${sub} now prints a table; take it off EXPECTED_TABLELESS`);
    }
    const own = spellings(out);
    if (
      named.has(sub) ||
      DIFF_FAMILY.includes(sub) ||
      own.some((spelling) => hazards.has(spelling))
    ) {
      tables.set(sub, own);
    }
  }
  const diff = tables.get('diff');
  if (diff === undefined || diff.length === 0) {
    throw new Error('git diff printed no option table');
  }
  const result = {};
  for (const sub of [...tables.keys()].sort()) {
    const abbreviates = tables.get(sub);
    const exact = DIFF_FAMILY.includes(sub)
      ? diff.filter((word) => !abbreviates.includes(word))
      : [];
    result[sub] = { abbreviates, exact };
  }
  for (const sub of DIFF_FAMILY) {
    if (result[sub] === undefined) {
      throw new Error(`git ${sub} printed no option table`);
    }
  }
  for (const spelling of hazards) {
    if (!Object.values(result).some((table) => table.abbreviates.includes(spelling))) {
      throw new Error(`no table holds the hazardous spelling --${spelling}`);
    }
  }
  return { version, image, tables: result, tableless: tableless.sort() };
};

const quote = (value) => `'${value}'`;

/** The generated module's text, formatted by biome afterwards. */
export const render = ({ version, image, tables, tableless }) => {
  const body = Object.entries(tables)
    .map(
      ([sub, table]) =>
        `  ${/^[a-z]+$/.test(sub) ? sub : quote(sub)}: {\n    abbreviates: [${table.abbreviates.map(quote).join(', ')}],\n    exact: [${table.exact.map(quote).join(', ')}],\n  },`,
    )
    .join('\n');
  return `/**
 * GENERATED by \`node scripts/git-long-options.mjs\` — do not edit; regenerate, and check with
 * \`node scripts/git-long-options-check.mjs\` (WP-161 ruling (c), PROGRESS backlog 515).
 *
 * git's long-option tables for the subcommands the command policy names and every builtin whose
 * table holds a hazardous spelling, read from \`git <sub> --git-completion-helper-all\` in the run
 * image. Pure data: the policy's abbreviation floor (\`gitResolvesLongOption\` in
 * \`command-policy.ts\`) reads it, and it can only ever **remove** a floor, by git's own rule.
 * The stated residual: a table older than the image's git can drop a floor only if git **removed**
 * the option it resolved to.
 */

/** Where these tables were read. */
export const GIT_LONG_OPTIONS_SOURCE = {
  git: ${quote(version)},
  image: ${quote(image)},
} as const;

/** One subcommand's long options, without the leading \`--\` or a trailing \`=\`. */
export interface GitLongOptionTable {
  /** Spellings git's parse-options resolves by an exact match or a unique prefix. */
  readonly abbreviates: readonly string[];
  /** Spellings git matches only exactly: diff's options under \`log\`, \`show\` and \`whatchanged\`. */
  readonly exact: readonly string[];
}

export const GIT_LONG_OPTIONS: Readonly<Record<string, GitLongOptionTable>> = {
${body}
};

/** Subcommands the generator probed that print no table, so an abbreviation there keeps its floor. */
export const GIT_TABLELESS_SUBCOMMANDS: readonly string[] = [${tableless.map(quote).join(', ')}];
`;
};

/** The module's text formatted as the repository formats its sources (biome, read from standard input). */
export const formatted = (text) => {
  const result = spawnSync(
    path.join(REPO, 'node_modules/.bin/biome'),
    ['format', `--stdin-file-path=${path.relative(REPO, GENERATED_PATH)}`],
    { cwd: REPO, input: text, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`biome format failed: ${result.stderr}`);
  }
  return result.stdout;
};

/** Generates the module's text (for the check, which writes nothing). */
export const generateText = async (image = DEFAULT_IMAGE) =>
  formatted(render(await readTables(image)));

const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const flag = (name) => {
    const at = process.argv.indexOf(name);
    return at === -1 ? undefined : process.argv[at + 1];
  };
  const image = flag('--image') ?? DEFAULT_IMAGE;
  const out = flag('--out') ?? GENERATED_PATH;
  const tables = await readTables(image);
  await writeFile(out, formatted(render(tables)));
  process.stdout.write(
    `wrote ${path.relative(REPO, out)}: ${Object.keys(tables.tables).length} tables from ${tables.version} (${image})\n`,
  );
}

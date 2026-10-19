/**
 * The recorded-command census (WP-225, Q122 (a), TD-030 decision 4 and § Alternatives): how many
 * of the Bash command lines a database's runs actually wrote fall in each scanner cell, each
 * uncertainty reason and each tier-3 class. `scripts/command-census.mjs` is the command; this
 * module is the reading and the counting, so the tests drive the same functions.
 *
 * ## What it reads
 *
 * The transcript sink (`packages/infrastructure/src/runner/postgres-transcript-sink.ts`) stores the
 * whole `TranscriptEvent` as `run_messages.payload`. A Bash call is a `tool_use` content block
 * `{ type: 'tool_use', tool_use_id, tool_name: 'Bash', input: { command } }` inside the `content`
 * of a `kind = 'assistant'` row (`transcript-normaliser.ts` maps the SDK's `name`/`input` onto
 * those keys). The `tool_name` **column** is null on an assistant row (one message may hold several
 * calls), so the read filters on the payload, not on the column. The same block also arrives as a
 * `stream_block` row, coalesced from the partial deltas; those rows are **not** read, so a call is
 * counted once, from the finished message — a stream cut before its message landed never ran. A
 * call stored twice under one `tool_use_id` (a resumed session) is counted once, except under the
 * normaliser's `unknown` placeholder for a missing id, where each call counts. A row with a
 * `blob_id` holds a stub, so it is counted as skipped and never parsed (the sink writes none today).
 *
 * The read is one `repeatable read, read only` transaction (`withReadOnlySession`), bounded by
 * `since` (on `created_at`, the partition key) and by a cap on assistant rows; whether the cap was
 * reached is printed.
 *
 * ## What it prints, and what it never prints
 *
 * **Counts only.** A recorded line is a project's own text — redacted at write (TD-012) but not
 * cleared for a public repository — so no line, no fragment of one, and no argument a reason was
 * built from (`unknownProgramRunsJudgedName(<program>, …)` names a program off the line) is ever
 * printed or written. Every label on stdout comes from a fixed vocabulary: the cell values, the
 * uncertainty reasons' **names** (an unnamed one is `unnamed`), and the class names below. No
 * recorded line becomes a fixture either; TD-030's corpus keeps its `composed` provenance.
 *
 * ## The tier-3 classes (TD-030 decision 1), each a heuristic
 *
 * Every class reads the line through the scanner's own structure — `splitCommandSegments` for the
 * fragments the shell would run, `commandArgvCandidates` for each fragment's argv with wrappers and
 * assignments peeled and argv[0] reduced to its basename — and then applies a rule that is a
 * heuristic, not a reader. A line may be in several classes; `any` counts it once.
 *
 *  - **`inline_interpreter`** — an inline script to a composing interpreter: `python*` with `-c`,
 *    `node`/`nodejs`/`bun` with `-e`/`-p`/`--eval`/`--print`, `perl` with `-e`/`-E` in a cluster,
 *    `ruby` with `-e`, `php` with `-r`, `deno eval`, or any of them with no script operand at all
 *    (the script comes from standard input: a here-document, a pipe, `<`), except a bare
 *    version/help query. *Under-reports*: an interpreter under another name (`python` behind an
 *    alias, `/opt/x/bin/py`), a value-taking option the reader does not know, which it then reads as
 *    the script operand (`python3 -W error -c …` is read; `node --stack-size 99 -e …` is not), and
 *    a script handed through an environment variable (`PYTHONSTARTUP`, `NODE_OPTIONS`). *Over-reports*
 *    a REPL started with no input.
 *  - **`written_script`** — a script file the run wrote and then ran. *Wrote*: an earlier or the same
 *    call's `Write`/`Edit`/`MultiEdit` `file_path`, a redirection target (`commandWriteTargets`) or a
 *    `tee` operand. *Ran*: a shell, `source`/`.` or one of the interpreters above handed it as its
 *    first operand, or a command word written as a path (`./x.sh`, `scripts/x`). Matched by
 *    **basename**. *Under-reports*: a file written any other way (`cp`, `curl -o`, `sed -i`, a
 *    program's own output, a checkout), a name built by an expansion, a file run by a program that
 *    reads it as configuration (`make`, `npm run`, a test runner), a file written in another run, and
 *    a run whose earlier calls fell before `since` or past the cap. *Over-reports* a different file
 *    of the same basename.
 *  - **`git_dash_c`** — `git -C <dir>`, read by the boundary's own `readGitGlobalOptions`. *Not
 *    counted*: `--git-dir`, `--work-tree`, `GIT_DIR=` and `cd <dir>; git …`, which reach the same
 *    planted configuration (backlog 587) but are not this class's spelling.
 *  - **`unshipped_wrapper_expansion`** — a program the policy does not know (asked of the policy:
 *    `<name> sudo` reads `unknownProgramRunsJudgedName(<name>, sudo)`) in a fragment holding an
 *    `$` expansion outside single quotes, on a line holding a command or process substitution
 *    anywhere (the scanner cuts a substitution out of its fragment). *Under-reports*: a name with a
 *    character outside `A–Z a–z 0–9 . _ + -` (not probed), and a program the policy knows by an
 *    `allow`/`ask` entry that admits only some of its lines. *Over-reports*: the expansion may be an
 *    assignment in front of the program, the program's own name, or (for a substitution) in another
 *    fragment of the line, rather than an argument handed to it.
 *
 * Each class also counts how many of its lines **ran under `auto`** (the `auto` cell `allow` or
 * `auto`), which is the half Q122's question is about. What the counts mean is the architect's.
 */
import {
  basename,
  commandArgvCandidates,
  commandWriteTargets,
  DEFAULT_COMMAND_POLICY,
  evaluateCommand,
  readGitGlobalOptions,
  splitCommandSegments,
  UNCERTAINTY,
  unknownProgramRunsJudgedName,
} from '../packages/domain/src/policies/command-policy.js';
import { decideUnattendedCommand } from '../packages/domain/src/policies/unattended-commands.js';
import {
  CORPUS_MODES,
  corpusCells,
  uncertaintyTag,
} from '../packages/domain/src/testing/command-corpus.js';
import { createDatabaseClient } from '../packages/infrastructure/src/db/client.js';

export const TIER3_CLASSES = [
  'inline_interpreter',
  'written_script',
  'git_dash_c',
  'unshipped_wrapper_expansion',
] as const;
export type Tier3Class = (typeof TIER3_CLASSES)[number];

/** The cell values a corpus cell can carry, and `throws` for a policy that threw. */
export const CELL_VALUES = [
  'allow',
  'ask',
  'auto',
  'deny',
  'block',
  'git',
  'hazard',
  'uncertain',
  'throws',
] as const;

/** The reason names a printed count may carry: `UNCERTAINTY`'s keys, the builders, and two more. */
const REASON_NAMES = new Set([
  ...Object.keys(UNCERTAINTY),
  'environmentSpellsFloor',
  'expansionCompletesBlockEntry',
  'flagValueHidesBlockEntry',
  'optionMayBeBlockEntry',
  'unknownProgramRunsJudgedName',
  'unreadGitConfigKey',
  'xargsCompletesBlockEntry',
  // The unattended git boundary's own uncertain reading, which carries no evaluation reason.
  'gitBoundary',
]);

const INTERPRETER = /^(?:python(?:\d+(?:\.\d+)*)?|node|nodejs|perl|ruby|php|bun|deno)$/;
const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'mksh', 'source', '.']);
const VERSION_OR_HELP = new Set(['-V', '-v', '--version', '-h', '--help', '-help', '-?']);
/** Options that take a separate value, per interpreter family, so the value is not the operand. */
const VALUE_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  python: new Set(['-W', '-X', '-Q']),
  node: new Set(['-r', '--require', '--import', '--loader', '-C', '--conditions', '--input-type']),
  perl: new Set(['-I', '-M', '-m']),
  ruby: new Set(['-I', '-r', '-C', '-E']),
  php: new Set(['-d', '-c', '-z']),
};
const INLINE_FLAG: Readonly<Record<string, RegExp>> = {
  python: /^-[A-Za-z]*c/,
  node: /^(?:-[a-z]*[ep]|--eval(?:=.*)?|--print(?:=.*)?)$/,
  perl: /^-[A-Za-z]*[eE]/,
  ruby: /^-[A-Za-z]*e/,
  php: /^-[A-Za-z]*r/,
};

const family = (name: string): string => {
  if (name.startsWith('python')) return 'python';
  if (name === 'nodejs' || name === 'bun') return 'node';
  return name;
};

/** Whether this argv runs an inline (or standard-input) script in a composing interpreter. */
const inlineInterpreter = ([name, ...rest]: readonly string[]): boolean => {
  if (name === undefined || !INTERPRETER.test(name)) return false;
  const kind = family(name);
  if (kind === 'deno') {
    const operand = rest.find((word) => !word.startsWith('-'));
    return (
      operand === 'eval' || (operand === undefined && !rest.some((w) => VERSION_OR_HELP.has(w)))
    );
  }
  const values = VALUE_OPTIONS[kind] ?? new Set<string>();
  const inline = INLINE_FLAG[kind] as RegExp;
  for (let index = 0; index < rest.length; index += 1) {
    const word = rest[index] as string;
    if (word === '-' || word === '--') break;
    if (!word.startsWith('-')) return false;
    if (VERSION_OR_HELP.has(word)) return false;
    if (word === '-m' && kind === 'python') return false;
    if (inline.test(word)) return true;
    if (values.has(word)) index += 1;
  }
  // No script operand: the script is standard input.
  return true;
};

/** The first word after the options, the script a shell or interpreter is handed. */
const firstOperand = (rest: readonly string[]): string | undefined => {
  for (const word of rest) {
    if (word === '-c' || word === '-e' || word === '-r') return undefined;
    if (!word.startsWith('-')) return word;
  }
  return undefined;
};

/** Whether this fragment holds a `$` expansion outside single quotes, or a backtick. */
const holdsExpansion = (fragment: string): boolean => {
  let single = false;
  for (let index = 0; index < fragment.length; index += 1) {
    const char = fragment[index];
    if (char === "'") single = !single;
    else if (!single && char === '\\') index += 1;
    else if (
      !single &&
      (char === '`' || (char === '$' && /[A-Za-z_{(@*#?0-9!-]/.test(fragment[index + 1] ?? '')))
    )
      return true;
  }
  return false;
};

/** Whether the fragment spells `name` as a path's last segment (`./x.sh`, `scripts/x`). */
const writtenAsPath = (fragment: string, name: string): boolean =>
  fragment
    .split(/[\s;&|()<>]+/)
    .some((word) => word.includes('/') && basename(word.replace(/["']/g, '')) === name);

const PROBE_NAME = /^[A-Za-z0-9._+-]+$/;

/** Asks the policy whether it reads `name` as a program it does not know (WP-203's rule). */
const createUnknownProgramProbe = (): ((name: string) => boolean) => {
  const memo = new Map<string, boolean>();
  return (name) => {
    if (!PROBE_NAME.test(name)) return false;
    let unknown = memo.get(name);
    if (unknown === undefined) {
      const reason = unknownProgramRunsJudgedName(name, 'sudo');
      unknown = evaluateCommand(
        { command: `${name} sudo` },
        DEFAULT_COMMAND_POLICY,
      ).uncertainty.some((found) => found === reason);
      memo.set(name, unknown);
    }
    return unknown;
  };
};

/** Paths a Bash line writes: its redirection targets and its `tee` operands, as basenames. */
export const writtenBy = (line: string): readonly string[] => {
  const written = commandWriteTargets(line).map(basename);
  for (const fragment of splitCommandSegments(line)) {
    for (const [name, ...rest] of commandArgvCandidates(fragment)) {
      if (name === 'tee')
        written.push(...rest.filter((word) => !word.startsWith('-')).map(basename));
    }
  }
  return written;
};

/**
 * The tier-3 classes one line is in. `written` holds the basenames the run wrote before this call;
 * the line's own writes are added by the caller first (`printf … > x.sh; sh x.sh`).
 */
export const tier3ClassesOf = (
  line: string,
  written: ReadonlySet<string>,
  isUnknownProgram: (name: string) => boolean = createUnknownProgramProbe(),
): ReadonlySet<Tier3Class> => {
  const found = new Set<Tier3Class>();
  // The fragments have their substitutions cut out (each is a fragment of its own), so a command
  // substitution anywhere on the line counts for every fragment of it.
  const substitutes = /`|\$\(|[<>]\(/.test(line);
  for (const fragment of splitCommandSegments(line)) {
    const expands = substitutes || holdsExpansion(fragment);
    for (const argv of commandArgvCandidates(fragment)) {
      const [name, ...rest] = argv;
      if (name === undefined) continue;
      if (inlineInterpreter(argv)) found.add('inline_interpreter');
      const handed = SHELLS.has(name) || INTERPRETER.test(name) ? firstOperand(rest) : undefined;
      const byPath = written.has(name) && writtenAsPath(fragment, name);
      if ((handed !== undefined && written.has(basename(handed))) || byPath)
        found.add('written_script');
      if (
        name === 'git' &&
        readGitGlobalOptions(rest).options.some(({ option }) => option === '-C')
      ) {
        found.add('git_dash_c');
      }
      if (expands && isUnknownProgram(name)) found.add('unshipped_wrapper_expansion');
    }
  }
  return found;
};

/** One recorded tool call, in the order the run made it. */
export interface RecordedCall {
  readonly runId: string;
  readonly toolUseId: string | null;
  readonly toolName: string;
  /** The Bash `command`, or null when the input carried none as a string. */
  readonly command: string | null;
  /** A `Write`/`Edit`/`MultiEdit` `file_path`, or null. */
  readonly filePath: string | null;
}

export interface CensusCounts {
  readonly runs: number;
  readonly lines: number;
  readonly skippedNoCommand: number;
  readonly cells: Readonly<Record<(typeof CORPUS_MODES)[number], Readonly<Record<string, number>>>>;
  readonly uncertainty: Readonly<Record<string, number>>;
  readonly tier3: Readonly<Record<Tier3Class | 'any', { lines: number; ranUnderAuto: number }>>;
}

const cellValue = (cell: string): string => {
  const value = cell.split(':')[0] as string;
  return (CELL_VALUES as readonly string[]).includes(value) ? value : 'other';
};

const reasonNamesOf = (command: string): ReadonlySet<string> => {
  const decision = decideUnattendedCommand({ command }, DEFAULT_COMMAND_POLICY, 'auto');
  const names = new Set(
    decision.evaluation.uncertainty.map((reason) => {
      const name = uncertaintyTag(reason).split('(')[0] as string;
      return REASON_NAMES.has(name) ? name : 'unnamed';
    }),
  );
  if (decision.rule === 'uncertain' && names.size === 0) names.add('gitBoundary');
  return names;
};

const bump = (counts: Record<string, number>, key: string): void => {
  counts[key] = (counts[key] ?? 0) + 1;
};

/** Counts the calls: each Bash line through the three cells, the reasons and the classes. */
export const censusCounts = (calls: readonly RecordedCall[]): CensusCounts => {
  const isUnknownProgram = createUnknownProgramProbe();
  const cells = { attended: {}, auto: {}, deny: {} } as Record<
    (typeof CORPUS_MODES)[number],
    Record<string, number>
  >;
  const uncertainty: Record<string, number> = {};
  const tier3 = Object.fromEntries(
    [...TIER3_CLASSES, 'any'].map((name) => [name, { lines: 0, ranUnderAuto: 0 }]),
  ) as Record<Tier3Class | 'any', { lines: number; ranUnderAuto: number }>;
  const writtenByRun = new Map<string, Set<string>>();
  const seen = new Set<string>();
  let lines = 0;
  let skippedNoCommand = 0;
  for (const call of calls) {
    // The normaliser stores a missing id as the literal `unknown`: such calls are distinct.
    if (call.toolUseId !== null && call.toolUseId !== 'unknown') {
      const key = `${call.runId}\0${call.toolUseId}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    const written = writtenByRun.get(call.runId) ?? new Set<string>();
    writtenByRun.set(call.runId, written);
    if (call.toolName !== 'Bash') {
      if (call.filePath !== null) written.add(basename(call.filePath));
      continue;
    }
    if (call.command === null) {
      skippedNoCommand += 1;
      continue;
    }
    lines += 1;
    let values: Record<(typeof CORPUS_MODES)[number], string>;
    try {
      const line = corpusCells(call.command);
      values = {
        attended: cellValue(line.attended),
        auto: cellValue(line.auto),
        deny: cellValue(line.deny),
      };
    } catch {
      values = { attended: 'throws', auto: 'throws', deny: 'throws' };
    }
    for (const mode of CORPUS_MODES) bump(cells[mode], values[mode]);
    let classes: ReadonlySet<Tier3Class>;
    try {
      for (const name of reasonNamesOf(call.command)) bump(uncertainty, name);
      for (const path of writtenBy(call.command)) written.add(path);
      classes = tier3ClassesOf(call.command, written, isUnknownProgram);
    } catch {
      bump(uncertainty, 'throws');
      classes = new Set();
    }
    const ran = values.auto === 'allow' || values.auto === 'auto';
    for (const name of [...classes, ...(classes.size > 0 ? (['any'] as const) : [])]) {
      tier3[name].lines += 1;
      if (ran) tier3[name].ranUnderAuto += 1;
    }
  }
  return {
    runs: writtenByRun.size,
    lines,
    skippedNoCommand,
    cells,
    uncertainty,
    tier3,
  };
};

export interface CensusRead {
  readonly calls: readonly RecordedCall[];
  readonly rowsRead: number;
  readonly capReached: boolean;
  readonly skippedBlobRows: number;
}

/** The minimal client surface the read needs. */
export interface CensusClient {
  query<R>(text: string, values?: readonly unknown[]): Promise<{ rows: R[] }>;
}

/**
 * Opens one `repeatable read, read only` transaction on `connectionString`, runs `work` in it and
 * rolls it back. Any write inside it fails with SQLSTATE 25006 (`read_only_sql_transaction`).
 */
export const withReadOnlySession = async <T>(
  connectionString: string,
  work: (client: CensusClient) => Promise<T>,
): Promise<T> => {
  // The listener is required by the factory; a dropped connection fails the pending query anyway.
  const client = createDatabaseClient(connectionString, () => {});
  await client.connect();
  try {
    await client.query('begin isolation level repeatable read, read only');
    try {
      return await work(client as unknown as CensusClient);
    } finally {
      await client.query('rollback');
    }
  } finally {
    await client.end();
  }
};

const CALLS_SQL = `
with page as (
  select run_id, seq, payload
    from run_messages
   where kind = 'assistant' and created_at >= $1 and blob_id is null
   order by created_at, run_id, seq
   limit $2
)
select page.run_id::text as run_id,
       block.value->>'tool_use_id' as tool_use_id,
       block.value->>'tool_name' as tool_name,
       case when jsonb_typeof(block.value->'input'->'command') = 'string'
            then block.value->'input'->>'command' end as command,
       case when jsonb_typeof(block.value->'input'->'file_path') = 'string'
            then block.value->'input'->>'file_path' end as file_path
  from page
  cross join lateral jsonb_array_elements(
    case when jsonb_typeof(page.payload->'content') = 'array'
         then page.payload->'content' else '[]'::jsonb end
  ) with ordinality as block(value, ordinality)
 where block.value->>'type' = 'tool_use'
   and block.value->>'tool_name' in ('Bash', 'Write', 'Edit', 'MultiEdit')
 order by page.run_id, page.seq, block.ordinality`;

/** Reads the Bash, Write and Edit calls of assistant rows since `since`, at most `cap` rows. */
export const readRecordedCalls = async (
  client: CensusClient,
  since: Date,
  cap: number,
): Promise<CensusRead> => {
  const { rows } = await client.query<{
    run_id: string;
    tool_use_id: string | null;
    tool_name: string;
    command: string | null;
    file_path: string | null;
  }>(CALLS_SQL, [since, cap]);
  const counted = await client.query<{ rows: number; blobs: number }>(
    `select (select count(*)::int from (
               select 1 from run_messages
                where kind = 'assistant' and created_at >= $1 and blob_id is null
                limit $2 + 1) page) as rows,
            (select count(*)::int from run_messages
              where kind = 'assistant' and created_at >= $1 and blob_id is not null) as blobs`,
    [since, cap],
  );
  const { rows: found = 0, blobs = 0 } = counted.rows[0] ?? {};
  return {
    calls: rows.map((row) => ({
      runId: row.run_id,
      toolUseId: row.tool_use_id,
      toolName: row.tool_name,
      command: row.command,
      filePath: row.file_path,
    })),
    rowsRead: Math.min(found, cap),
    capReached: found > cap,
    skippedBlobRows: blobs,
  };
};

const DAY_MS = 86_400_000;
const MAX_CAP = 10_000_000;

/** `{ since, cap }` from the command's arguments, or a sentence naming what is wrong. */
export const parseCensusArguments = (
  argv: readonly string[],
  now: Date = new Date(),
): { since: Date; cap: number } | string => {
  let since = new Date(now.getTime() - 30 * DAY_MS);
  let cap = 100_000;
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (flag === '--since' && value !== undefined) {
      since = new Date(value);
      if (Number.isNaN(since.getTime())) return '--since takes an ISO 8601 date';
    } else if (flag === '--cap' && value !== undefined) {
      cap = Number(value);
      if (!Number.isInteger(cap) || cap < 1 || cap > MAX_CAP) {
        return `--cap takes an integer from 1 to ${MAX_CAP}`;
      }
    } else {
      return 'usage: command-census.mjs [--since <ISO date>] [--cap <rows>]';
    }
  }
  return { since, cap };
};

/** The report: one `key: count` per line, every key from a fixed vocabulary. */
export const formatCensus = (
  read: Omit<CensusRead, 'calls'>,
  counts: CensusCounts,
  window: { readonly since: Date; readonly cap: number },
): string => {
  const out = [
    `since: ${window.since.toISOString()}`,
    `row_cap: ${window.cap}`,
    `assistant_rows_read: ${read.rowsRead}`,
    `cap_reached: ${read.capReached ? 'yes' : 'no'}`,
    `skipped_blob_rows: ${read.skippedBlobRows}`,
    `runs: ${counts.runs}`,
    `bash_lines: ${counts.lines}`,
    `skipped_no_command: ${counts.skippedNoCommand}`,
  ];
  for (const mode of CORPUS_MODES) {
    for (const value of [...CELL_VALUES, 'other']) {
      out.push(`cell.${mode}.${value}: ${counts.cells[mode][value] ?? 0}`);
    }
  }
  for (const name of [...REASON_NAMES, 'unnamed', 'throws'].sort()) {
    const count = counts.uncertainty[name] ?? 0;
    if (count > 0) out.push(`uncertainty.${name}: ${count}`);
  }
  for (const name of [...TIER3_CLASSES, 'any'] as const) {
    out.push(`tier3.${name}: ${counts.tier3[name].lines}`);
    out.push(`tier3.${name}.ran_under_auto: ${counts.tier3[name].ranUnderAuto}`);
  }
  return `${out.join('\n')}\n`;
};

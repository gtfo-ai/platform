#!/usr/bin/env node
/**
 * Holds `docs/technical/03-data-model.md` to the tables the migrations create (WP-97, PROGRESS
 * backlog 124).
 *
 * technical/03 is the page an operator sizes an installation from and the page CLAUDE.md says wins
 * a disagreement with the code — and it was hand-maintained against a schema that grew in sixty-odd
 * forward-only migrations. By WP-48 twelve of the schema's sixty tables had no entry on it, nine of
 * them not even named; the history pair got one at WP-66 and the other ten waited, because the
 * only census that knew the table list (`test/integration/db/migrations.integration.test.ts`) needs
 * a live database and compares the database with *itself*. This is the static half: every table a
 * migration creates must have an entry on the page, or a declared exemption with its reason, and
 * it runs in `verify:static` — so a new table fails the lint job until somebody writes its entry.
 *
 * ## What "the tables the migrations create" means
 *
 * Read from `packages/infrastructure/src/db/migrations/*.sql` in file order — tracked **and**
 * untracked (`census-files.mjs`, standing rule 85), because the migration being written right now
 * is the one whose table is missing — plus the one table created outside them, the migrator's own
 * `platform_migrations` (`MIGRATION_LOG_DDL` in `migrator.ts`: it must exist before the first
 * migration can be recorded). Each statement is applied in order:
 *
 *  - `create [unlogged] table [if not exists] [public.]<name>` adds a table;
 *  - `alter table [if exists] [only] <old> rename to <new>` renames one (none today; handled so the
 *    first rename cannot leave the old name documented and the new one silently absent);
 *  - `drop table [if exists] <name>[, …]` removes one (none today, for the same reason);
 *  - `create table <child> partition of <parent>` is a **partition**, described by its parent's
 *    entry, and is not asked for an entry of its own.
 *
 * Comments (`--`, block) and single-quoted literals are removed first. That is what keeps the one
 * dynamic `create table` in the corpus — `'create table public.%I partition of public.%I …'`, the
 * monthly partition maker of `0001_bootstrap.sql` — from reading as a table: the `events_YYYY_MM`
 * (and `run_messages_…`, `cost_entries_…`, …) partitions it makes at run time are named by
 * `platform_partition_name()` and never appear in a migration at all. A temporary table is not part
 * of the schema and is skipped. A name qualified with a schema other than `public` is not the
 * platform's: `pgboss.*` is installed by pg-boss itself when `migrate` runs (TD-004), from no file
 * this check reads, and technical/03 describes it as a schema rather than as tables.
 *
 * ## What "an entry" means
 *
 * A backticked column list — `` `name(` `` — anywhere on the page, which is the one shape every
 * table on it is written in (`- \`tasks(id, …)\``, `…; \`sessions(id, …)\``). A mention in prose is
 * not an entry: `task_asks` was *named* in `knowledge_curations`' paragraph for eleven migrations
 * while its columns were written nowhere.
 *
 * The other direction is checked too, narrowly: a list item that **opens** with a column list
 * (`- \`name(`) must name a table the migrations create, unless it is declared in
 * {@link SPECIFIED_NOT_CREATED} with its reason — so a table dropped or renamed leaves a failure
 * rather than a stale entry. Inline mentions such as `uuidv7()` are therefore never read as tables.
 *
 * ## What it cannot see
 *
 * Whether an entry's **columns** are right — the page is a logical schema written in prose, and a
 * column list is not parsed. A `create table` spelled through `execute` of a string built at run
 * time (the partition maker's shape) is invisible by construction, which is why partitions are
 * described by their parent. A quoted identifier is read as its lower-cased name.
 *
 * Prints exactly one `PASS: data-model:check` / `FAIL: data-model:check` line on stdout
 * (docs/technical/14-orchestration-protocol.md). Its test tier is `check-data-model.test.ts`
 * (standing rule 33).
 */
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { censusFiles, censusText } from './census-files.mjs';
import { isProgram } from './is-program.mjs';

export const MIGRATIONS_DIRECTORY = 'packages/infrastructure/src/db/migrations';
export const MIGRATOR_SOURCE = 'packages/infrastructure/src/db/migrator.ts';
export const DATA_MODEL_PAGE = 'docs/technical/03-data-model.md';

/**
 * Tables a migration creates that the page need not describe, each with its reason. **Empty**:
 * every table present at WP-97 has an entry, including Better Auth's two (`accounts`,
 * `verifications`), whose shape the library dictates but whose contents — an Argon2id hash, a reset
 * token — an operator backing the database up needs to know about. An entry here must name a table
 * the migrations create and that the page does not describe; either going stale fails the check.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const UNDOCUMENTED_TABLES = {};

/**
 * Entries the page opens with a column list that no migration creates, each with its reason.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const SPECIFIED_NOT_CREATED = {
  feedback:
    'specified and unbuilt: the page says the projection is owed to the reader that needs one (WP-15i), and `feedback.received` in the event log is its persistence until then',
};

/** Removes `--` and block comments and the contents of single-quoted literals, keeping newlines. */
export const withoutCommentsAndLiterals = (sql) => {
  let out = '';
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];
    if (char === '-' && next === '-') {
      const end = sql.indexOf('\n', index);
      index = end === -1 ? sql.length : end;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += sql.slice(index, stop).replace(/[^\n]/g, ' ');
      index = stop;
      continue;
    }
    if (char === "'") {
      // A literal ends at a quote that is not doubled (`''` is an escaped quote inside it).
      let cursor = index + 1;
      while (cursor < sql.length) {
        if (sql[cursor] === "'" && sql[cursor + 1] === "'") {
          cursor += 2;
          continue;
        }
        if (sql[cursor] === "'") break;
        cursor += 1;
      }
      out += `'${sql.slice(index + 1, cursor).replace(/[^\n]/g, ' ')}'`;
      index = cursor + 1;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
};

const IDENT = '"?[A-Za-z_][A-Za-z0-9_$]*"?';
const QUALIFIED = `(?:${IDENT}\\s*\\.\\s*)?${IDENT}`;
const STATEMENT = new RegExp(
  [
    `\\bcreate\\s+(?<temp>(?:(?:global|local)\\s+)?(?:temporary|temp)\\s+)?(?:unlogged\\s+)?table\\s+(?:if\\s+not\\s+exists\\s+)?(?<created>${QUALIFIED})(?:\\s+partition\\s+of\\s+(?<parent>${QUALIFIED}))?`,
    `\\balter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?(?<from>${QUALIFIED})\\s+rename\\s+to\\s+(?<to>${IDENT})`,
    `\\bdrop\\s+table\\s+(?:if\\s+exists\\s+)?(?<dropped>${QUALIFIED}(?:\\s*,\\s*${QUALIFIED})*)`,
  ].join('|'),
  'gi',
);

/** `public.x`, `"X"`, `x` → `x`; a name in another schema → `null` (not the platform's). */
const tableName = (qualified) => {
  const parts = qualified.split('.').map((part) => part.trim().replaceAll('"', '').toLowerCase());
  if (parts.length === 1) return parts[0];
  return parts[0] === 'public' ? parts[1] : null;
};

/**
 * The tables a sequence of SQL documents leaves behind, applied in order, each with the document
 * that created it (or renamed it last), and the partitions each parent has.
 *
 * @param {readonly { path: string, sql: string }[]} documents
 */
export const tablesCreated = (documents) => {
  /** @type {Map<string, string>} */
  const tables = new Map();
  /** @type {Map<string, string>} */
  const partitions = new Map();
  for (const { path, sql } of documents) {
    for (const match of withoutCommentsAndLiterals(sql).matchAll(STATEMENT)) {
      const groups = match.groups ?? {};
      if (groups.created !== undefined) {
        if (groups.temp !== undefined) continue;
        const name = tableName(groups.created);
        if (name === null) continue;
        if (groups.parent !== undefined) {
          partitions.set(name, tableName(groups.parent) ?? groups.parent);
          continue;
        }
        tables.set(name, path);
      } else if (groups.from !== undefined) {
        const from = tableName(groups.from);
        if (from === null) continue;
        const to = tableName(groups.to);
        if (tables.delete(from)) tables.set(to, path);
        else if (partitions.has(from)) {
          partitions.set(to, partitions.get(from));
          partitions.delete(from);
        }
      } else if (groups.dropped !== undefined) {
        for (const each of groups.dropped.split(',')) {
          const name = tableName(each);
          if (name === null) continue;
          tables.delete(name);
          partitions.delete(name);
        }
      }
    }
  }
  return { tables, partitions };
};

/** Every table the page gives a backticked column list, anywhere. */
export const describedTables = (page) =>
  new Set([...page.matchAll(/`([a-z_][a-z0-9_]*)\(/g)].map((match) => match[1]));

/** The tables named by a list item that opens with a column list — the page's table entries. */
export const entryTables = (page) =>
  new Set([...page.matchAll(/^\s*- `([a-z_][a-z0-9_]*)\(/gm)].map((match) => match[1]));

/**
 * Every disagreement between the schema and the page, as sentences; empty when they agree.
 *
 * @param {{ tables: Map<string, string>, page: string, undocumented?: Readonly<Record<string, string>>, specified?: Readonly<Record<string, string>> }} input
 */
export const dataModelProblems = ({
  tables,
  page,
  undocumented = UNDOCUMENTED_TABLES,
  specified = SPECIFIED_NOT_CREATED,
}) => {
  const described = describedTables(page);
  const entries = entryTables(page);
  const problems = [];
  for (const [name, path] of [...tables].sort(([a], [b]) => a.localeCompare(b))) {
    if (!described.has(name) && undocumented[name] === undefined) {
      problems.push(
        `\`${name}\` (created by ${path}) has no entry in ${DATA_MODEL_PAGE}: write \`${name}(column, …)\` from the migration, or declare it in UNDOCUMENTED_TABLES with its reason`,
      );
    }
  }
  for (const name of Object.keys(undocumented).sort()) {
    if (!tables.has(name)) {
      problems.push(`UNDOCUMENTED_TABLES names \`${name}\`, which no migration creates`);
    } else if (described.has(name)) {
      problems.push(
        `UNDOCUMENTED_TABLES names \`${name}\`, which ${DATA_MODEL_PAGE} now describes — remove the exemption`,
      );
    }
  }
  for (const name of [...entries].sort()) {
    if (!tables.has(name) && specified[name] === undefined) {
      problems.push(
        `${DATA_MODEL_PAGE} has an entry for \`${name}\`, which no migration creates: a dropped or renamed table leaves its entry behind — correct the page, or declare it in SPECIFIED_NOT_CREATED with its reason`,
      );
    }
  }
  for (const name of Object.keys(specified).sort()) {
    if (tables.has(name)) {
      problems.push(
        `SPECIFIED_NOT_CREATED names \`${name}\`, which a migration now creates — remove the declaration`,
      );
    } else if (!entries.has(name)) {
      problems.push(
        `SPECIFIED_NOT_CREATED names \`${name}\`, which ${DATA_MODEL_PAGE} no longer has an entry for`,
      );
    }
  }
  return problems;
};

/** The migrator's own DDL, which is a template literal rather than a migration file. */
export const migratorDdl = (source) =>
  /const MIGRATION_LOG_DDL = `([^`]*)`/.exec(source)?.[1] ?? null;

/**
 * Reads the corpus under `root` and compares it with the page.
 *
 * @param {string} root
 */
export const checkDataModel = (root) => {
  const migrations = censusFiles(root, {
    pathspecs: [MIGRATIONS_DIRECTORY],
    include: (path) =>
      path.startsWith(`${MIGRATIONS_DIRECTORY}/`) &&
      /^\d{4}_[^/]+\.sql$/.test(path.slice(MIGRATIONS_DIRECTORY.length + 1)),
  })
    .map(({ path, contents }) => ({ path, sql: contents }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const ddl = migratorDdl(censusText(root, MIGRATOR_SOURCE));
  const problems = [];
  if (migrations.length === 0) {
    // Standing rule 4: a check whose corpus is empty would pass for ever.
    problems.push(`found no migration under ${MIGRATIONS_DIRECTORY}`);
  }
  if (ddl === null) {
    problems.push(
      `could not find MIGRATION_LOG_DDL in ${MIGRATOR_SOURCE}, so \`platform_migrations\` would go unchecked`,
    );
  }
  const documents =
    ddl === null ? migrations : [{ path: MIGRATOR_SOURCE, sql: ddl }, ...migrations];
  const { tables, partitions } = tablesCreated(documents);
  if (migrations.length > 0 && tables.size === 0) {
    problems.push('the migrations create no table this parser recognises');
  }
  problems.push(...dataModelProblems({ tables, page: censusText(root, DATA_MODEL_PAGE) }));
  return { migrations: migrations.length, tables, partitions, problems };
};

if (isProgram(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  let result;
  try {
    result = checkDataModel(root);
  } catch (error) {
    process.stderr.write(`could not read the corpus: ${error.message}\n`);
    process.stdout.write('FAIL: data-model:check\n');
    process.exit(2);
  }
  if (result.problems.length > 0) {
    process.stderr.write(`${result.problems.length} disagreement(s) with ${DATA_MODEL_PAGE}:\n`);
    for (const problem of result.problems) process.stderr.write(`  ${problem}\n`);
    process.stdout.write('FAIL: data-model:check\n');
    process.exit(1);
  }
  const exempt = Object.keys(UNDOCUMENTED_TABLES).length;
  process.stdout.write(
    `PASS: data-model:check (${result.tables.size} tables from ${result.migrations} migrations and the migrator, ${result.tables.size - exempt} described in technical/03, ${exempt} exempt)\n`,
  );
}

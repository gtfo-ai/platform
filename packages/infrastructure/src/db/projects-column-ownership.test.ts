/**
 * Every column of `projects` and the statements that write it — read off disk (WP-129, PROGRESS
 * backlog 383).
 *
 * The `tasks` table has had this since WP-15e (`pipeline/tasks-column-ownership.test.ts`); `projects`
 * had only WP-113's census of the one column it added. Every writer of a `projects` column was
 * narrow when this was written — `config`, the autonomy dial, `readiness_level`,
 * `proposed_risk_classes` and `maintenance_last_blocker` each have their own statement — and that
 * narrowness was argued in prose (`packages/application/src/onboarding/ports.ts`, the readiness
 * store's docblock) and checked nowhere. The lost update it prevents is the one WP-15e measured on
 * `tasks`: a whole-row write from a job that runs beside a wizard step puts back a configuration or
 * an autonomy dial a human changed a moment ago, and it is silent.
 *
 * **`projects` has no `version` column, by decision** (WP-129's ruling, plan § M7): every writer is
 * narrow, so there is no read-modify-write for a token to arbitrate, and this census makes a
 * whole-row writer a refused line rather than a reviewed one. The day a writer genuinely needs the
 * whole row, it needs WP-15e's token first — and that is a change to this file's table, which is
 * where the decision becomes visible.
 *
 * ## What it holds
 *
 *  - {@link COLUMN_WRITERS} names **every** column of the Drizzle table (both directions, so a new
 *    migration's column is unowned until somebody declares it), and for each the file of every
 *    statement that writes it, one entry per statement. A column only the insert writes declares
 *    `[]`.
 *  - The computed table must **equal** the declared one: a new writer, a writer that moved, a
 *    statement that grew a column and a whole-row `update projects` all fail, by column.
 *  - Outside the migrations a column has **one** writing statement, except the co-owners
 *    {@link CO_OWNED_COLUMNS} names with a count and a reason; `updated_at` is shared
 *    ({@link SHARED_COLUMNS}).
 *  - A `.set(…)` this census cannot read — a variable, a spread of one — is reported, never
 *    skipped: it is the whole-row writer's Drizzle spelling.
 *  - Every file that **inserts** a row is declared ({@link INSERT_SITES}), and an upsert (an insert
 *    that updates on conflict) is refused as unreadable, because its update half is a writer this
 *    table could not attribute.
 *
 * ## WP-113's census is its stricter half
 *
 * `maintenance/maintenance-blocker-writers.test.ts` holds `maintenance_last_blocker` alone and is
 * kept where it is (migration 0069 cites it by path, and an applied migration is never edited). It
 * is **stricter** than this file for its column: it counts any `maintenance_last_blocker =` anywhere
 * in code — a `where` that compares included — and any `insert into projects` that names it, where
 * this file reads only `set` clauses and lists insert sites by file. The two agree on the one owner,
 * and a case below asserts that they do.
 *
 * ## What it reads
 *
 * Every `.ts`, `.mts`, `.cts`, `.tsx`, `.js`, `.mjs`, `.cjs` and `.sql` file git knows about, tracked or untracked
 * (`scripts/census-files.mjs`, rule 85), **except test files**, which seed and refuse rows on
 * purpose. TypeScript and JavaScript go through the repository's one comment stripper
 * (`scripts/source-scanner.mjs`), so a docblock that quotes a statement is not a writer; SQL drops
 * its `--` lines. The spellings:
 *
 *  - raw SQL `update [only] [public.]projects [[as] alias] set … [where|returning …]`, the names
 *    optionally double-quoted, in a string or a migration;
 *  - Drizzle's `sql` template `update ${projects} set …`;
 *  - Drizzle's `.update(projects).set({ … })`, whose **top-level** keys — `key: value`, shorthand
 *    `key`, and the keys of each object a parenthesised spread may choose — are mapped to column
 *    names through the table's own definition. A key that is not a column, a spread of a variable
 *    and a computed key are reported rather than skipped;
 *  - `insert into projects` (qualified or quoted alike) and Drizzle's `.insert(projects)`, as insert
 *    sites;
 *  - `merge into projects`, which is reported as unreadable and fails: its `when matched then
 *    update` clauses are a writer this census does not parse, and no statement here uses one.
 *
 * ## What it cannot see
 *
 * A statement whose table or column name is built at runtime (concatenation, `sql.identifier`), a
 * Drizzle chain that binds the table to another name first, and a writer outside this repository
 * (an operator's `psql`) — the holes the `tasks` census and WP-113's state. It also says nothing
 * about whether two **declared** co-owners can race; the reason beside each says why they cannot
 * lose each other's write.
 */
import path from 'node:path';
import { getTableColumns } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  CensusUnreadableError,
  censusPaths,
  readCensus,
} from '../../../../scripts/census-files.mjs';
import { withoutComments } from '../../../../scripts/source-scanner.mjs';
import { projects } from './schema/identity.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');

const TEST_SOURCE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const MIGRATIONS = 'packages/infrastructure/src/db/migrations/';

const ONBOARDING_QUERIES = 'apps/server/src/queries/onboarding-queries.ts';
const READINESS_STORE = 'packages/infrastructure/src/knowledge/postgres-readiness-store.ts';
const BLOCKER_STORE =
  'packages/infrastructure/src/maintenance/postgres-maintenance-blocker-store.ts';
const MIGRATION_0021 = `${MIGRATIONS}0021_autonomy_materialised.sql`;

/**
 * Every column of `projects`, and the file of every statement that writes it — one entry per
 * statement, so two statements in one file are named twice.
 */
const COLUMN_WRITERS: Readonly<Record<string, readonly string[]>> = {
  // Written by the insert and never again: identity, the repository's address and the vault's
  // location. Nothing renames or re-points a project in 0.1; a writer that starts to is a line here.
  id: [],
  org_id: [],
  key: [],
  name: [],
  repo_url: [],
  default_branch: [],
  agentic_dir: [],
  knowledge_dir: [],
  status: [],
  created_at: [],
  // `writeProjectConfig` (`PUT …/config`) — a compare-and-set on `config_hash` only when the request
  // carries a base hash, a plain write when it does not; and
  // migration 0021's one-off rewrite of a stored `review_only.trigger: manual` (backlog 58).
  config: [ONBOARDING_QUERIES, MIGRATION_0021],
  config_source: [ONBOARDING_QUERIES],
  config_hash: [ONBOARDING_QUERIES],
  // `writeProjectConfig` (when the request carries a level) and `writeProjectAutonomy` (select or
  // re-apply a preset) — the declared co-owners, below; migration 0021's four backfills of the
  // policies, one per level.
  autonomy_level: [ONBOARDING_QUERIES, ONBOARDING_QUERIES],
  autonomy_policies: [
    ONBOARDING_QUERIES,
    ONBOARDING_QUERIES,
    MIGRATION_0021,
    MIGRATION_0021,
    MIGRATION_0021,
    MIGRATION_0021,
  ],
  // `PostgresReadinessStore.record` — the projection of the evaluation it inserts in the same
  // transaction (WP-21).
  readiness_level: [READINESS_STORE],
  // `PostgresReadinessStore.saveRiskClassProposal` (WP-37, migration 0026).
  proposed_risk_classes: [READINESS_STORE],
  // `recordBlocker`'s compare-and-set (WP-113, migration 0069) — and WP-113's census holds it alone.
  maintenance_last_blocker: [BLOCKER_STORE],
  // The bookkeeping timestamp; shared, below.
  updated_at: [ONBOARDING_QUERIES, ONBOARDING_QUERIES],
};

/**
 * Columns any statement may set alongside its own — `updated_at` only, for the reason the `tasks`
 * census gives: two writers racing on it disagree about a millisecond and nothing else.
 */
const SHARED_COLUMNS: ReadonlySet<string> = new Set(['updated_at']);

/**
 * Columns two runtime statements write **by decision**, with the count — so a third still fails.
 *
 * `autonomy_level` and `autonomy_policies` are one fact in two columns (BD-027:14), and both
 * statements set **both**, from the request's level and this release's preset — neither reads the
 * row it writes, so neither can put back a stale value the other wrote: the later human choice wins,
 * which is what a dial is. `writeProjectConfig` carries the level when the settings form sends one;
 * `writeProjectAutonomy` is the dial's own control, and it deliberately names no `config`.
 */
const CO_OWNED_COLUMNS: Readonly<Record<string, number>> = {
  autonomy_level: 2,
  autonomy_policies: 2,
};

/** Every file that creates a `projects` row, with how many insert statements it holds. */
const INSERT_SITES: Readonly<Record<string, number>> = {
  // `createProject`, the wizard's step 1 (WP-21), `on conflict do nothing` on `key`.
  [ONBOARDING_QUERIES]: 1,
  // The e2e harness's seed rows — not test-named, so in scope, and declared rather than exempted.
  'test/e2e/support/instance.ts': 1,
  'test/e2e/support/pipeline.ts': 1,
};

interface ProjectsWrite {
  readonly file: string;
  readonly kind: 'update' | 'insert';
  /** Column names a `set` assigns; empty for an insert. */
  readonly columns: readonly string[];
  /** Why this statement could not be attributed, when it could not. */
  readonly unreadable?: string;
}

/** Drizzle property name → SQL column name, read off the table itself rather than restated. */
const COLUMN_OF_PROPERTY: ReadonlyMap<string, string> = new Map(
  Object.entries(getTableColumns(projects)).map(([property, column]) => [property, column.name]),
);

const TABLE_COLUMNS: readonly string[] = [...COLUMN_OF_PROPERTY.values()];

/** Comment-free text: the shared stripper for TypeScript and JavaScript, `--` lines dropped for SQL. */
const codeOf = (file: string, contents: string): string =>
  file.endsWith('.sql')
    ? contents
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
    : withoutComments(contents);

/**
 * Splits on commas outside parentheses, brackets, braces and quoted text — `'…'` (SQL literals and
 * TypeScript strings), `"…"` and template literals.
 */
const topLevelParts = (clause: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (const character of clause) {
    if (quote !== null) {
      if (character === quote) quote = null;
    } else if (character === "'" || character === '"' || character === '`') {
      quote = character;
    } else if ('([{'.includes(character)) {
      depth += 1;
    } else if (')]}'.includes(character)) {
      depth -= 1;
    } else if (depth === 0 && character === ',') {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
};

/** The `{…}` groups at the top level of `text` — the object literals a ternary spread chooses between. */
const braceGroups = (text: string): string[] => {
  const groups: string[] = [];
  let depth = 0;
  let start = -1;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? '';
    if ('([{'.includes(character)) {
      if (depth === 0 && character === '{') start = index;
      depth += 1;
    }
    if (')]}'.includes(character)) {
      depth -= 1;
      if (depth === 0 && character === '}' && start !== -1) {
        groups.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return groups;
};

const PROPERTY = /^([A-Za-z_$][\w$]*)\s*:/;
const SHORTHAND = /^[A-Za-z_$][\w$]*$/;

/**
 * The top-level keys of an object literal — `key: value`, shorthand `key`, and the keys of every
 * object a parenthesised spread may choose (`...(cond ? {} : { a, b })`). Anything else — a spread of
 * a variable, a computed key, a method — is a key this cannot name, and is returned as `null`.
 */
const objectKeys = (literal: string): (string | null)[] =>
  topLevelParts(literal.trim().slice(1, -1)).flatMap((part): (string | null)[] => {
    if (part.startsWith('...')) {
      const spread = part.slice(3).trim();
      return spread.startsWith('(') ? braceGroups(spread.slice(1)).flatMap(objectKeys) : [null];
    }
    const property = PROPERTY.exec(part)?.[1];
    if (property !== undefined) return [property];
    return SHORTHAND.test(part) ? [part] : [null];
  });

/** The text between `open` (an opening parenthesis's index) and its matching close. */
const balancedFrom = (code: string, open: number): string | null => {
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    if (code[index] === '(') depth += 1;
    if (code[index] === ')') {
      depth -= 1;
      if (depth === 0) return code.slice(open + 1, index);
    }
  }
  return null;
};

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * The statement a raw `update projects set` opens: to the quote that closes the literal it sits in
 * (TypeScript) or to its `;` (SQL), then its `set` clause up to `where` or `returning`.
 */
const rawUpdate = (
  file: string,
  code: string,
  index: number,
  headLength: number,
): ProjectsWrite => {
  const sqlFile = file.endsWith('.sql');
  const before = code.slice(0, index).trimEnd().at(-1);
  const quote = !sqlFile && (before === '`' || before === "'" || before === '"') ? before : null;
  const terminator = sqlFile ? ';' : (quote ?? '\n');
  const end = code.indexOf(terminator, index + headLength);
  const statement = code.slice(index + headLength, end === -1 ? undefined : end);
  const clause = statement.split(/\b(?:where|returning)\b/i)[0] ?? '';
  const columns = topLevelParts(clause).map((part) => part.split('=')[0]?.trim() ?? '');
  const unreadable =
    columns.length === 0
      ? 'a set clause with no assignment'
      : columns.find((column) => !IDENTIFIER.test(column)) === undefined
        ? undefined
        : `an assignment target that is not a column name: ${columns.join(', ')}`;
  return { file, kind: 'update', columns, ...(unreadable === undefined ? {} : { unreadable }) };
};

/** `.update(projects).set({ … })`: the object's top-level keys, mapped to the table's column names. */
const drizzleUpdate = (file: string, code: string, index: number): ProjectsWrite => {
  const set = code.indexOf('.set(', index);
  const argument = set === -1 ? null : balancedFrom(code, set + '.set'.length);
  if (argument === null) {
    return { file, kind: 'update', columns: [], unreadable: 'no `.set(…)` after the update' };
  }
  const object = argument.trim();
  if (!object.startsWith('{') || !object.endsWith('}')) {
    return {
      file,
      kind: 'update',
      columns: [],
      unreadable: `a set of \`${object}\`, not a literal`,
    };
  }
  const keys = objectKeys(object);
  const columns = keys.map((key) => (key === null ? undefined : COLUMN_OF_PROPERTY.get(key)));
  if (keys.includes(null)) {
    return {
      file,
      kind: 'update',
      columns: [],
      unreadable: 'a key this cannot name (a spread of a value, a computed key)',
    };
  }
  const unknown = keys.filter((key, position) => key !== null && columns[position] === undefined);
  if (unknown.length > 0) {
    return {
      file,
      kind: 'update',
      columns: [],
      unreadable: `keys that are not columns: ${unknown.join(', ')}`,
    };
  }
  const named = [...new Set(columns.filter((column): column is string => column !== undefined))];
  return {
    file,
    kind: 'update',
    columns: named,
    ...(named.length === 0 ? { unreadable: 'a `.set({…})` naming no column' } : {}),
  };
};

/** The statement an insert opens, to its `;`, refused when it updates on conflict. */
const insert = (file: string, code: string, index: number): ProjectsWrite => {
  const end = code.indexOf(';', index);
  const statement = code.slice(index, end === -1 ? undefined : end);
  return /onConflictDoUpdate|on\s+conflict[\s\S]*?\bdo\s+update\b/i.test(statement)
    ? { file, kind: 'insert', columns: [], unreadable: 'an upsert: its update half is a writer' }
    : { file, kind: 'insert', columns: [] };
};

/**
 * The table's name as SQL may spell it: optionally schema-qualified (`public.`), optionally quoted
 * (`"projects"`). Review round 1: `update public.projects set …` slipped past the first spelling.
 */
const TABLE = String.raw`(?:"?public"?\s*\.\s*)?"?projects"?`;
/** An optional alias after the table (`projects p`, `projects as p`), never the keyword `set`. */
const ALIAS = String.raw`(?:\s+(?:as\s+)?(?!set\b)[a-z_]\w*)?`;

/** `merge into projects` — a writer whose `when matched then update` clauses this does not parse. */
const merge = (file: string): ProjectsWrite => ({
  file,
  kind: 'update',
  columns: [],
  unreadable: 'a `merge into projects`, which this census does not parse',
});

const SPELLINGS: readonly {
  readonly pattern: RegExp;
  readonly read: (file: string, code: string, match: RegExpMatchArray) => ProjectsWrite;
}[] = [
  {
    pattern: new RegExp(String.raw`\bupdate\s+(?:only\s+)?${TABLE}${ALIAS}\s+set\b`, 'gi'),
    read: (file, code, match) => rawUpdate(file, code, match.index ?? 0, match[0].length),
  },
  {
    pattern: /\bupdate\s+\$\{\s*(?:[\w$]+\.)?projects\s*\}\s+set\b/gi,
    read: (file, code, match) => rawUpdate(file, code, match.index ?? 0, match[0].length),
  },
  {
    pattern: /\.update\(\s*(?:[\w$]+\.)?projects\s*\)/g,
    read: (file, code, match) => drizzleUpdate(file, code, match.index ?? 0),
  },
  {
    pattern: new RegExp(
      String.raw`\binsert\s+into\s+(?:${TABLE}|\$\{\s*(?:[\w$]+\.)?projects\s*\})[\s(]`,
      'gi',
    ),
    read: (file, code, match) => insert(file, code, match.index ?? 0),
  },
  {
    pattern: new RegExp(
      String.raw`\bmerge\s+into\s+(?:${TABLE}|\$\{\s*(?:[\w$]+\.)?projects\s*\})[\s(]`,
      'gi',
    ),
    read: (file) => merge(file),
  },
  {
    pattern: /\.insert\(\s*(?:[\w$]+\.)?projects\s*\)/g,
    read: (file, code, match) => insert(file, code, match.index ?? 0),
  },
];

/** Every write of `projects` in one file, in source order. */
const writesIn = (file: string, contents: string): ProjectsWrite[] => {
  const code = codeOf(file, contents);
  return SPELLINGS.flatMap(({ pattern, read }) =>
    [...code.matchAll(pattern)].map((match) => ({
      at: match.index ?? 0,
      write: read(file, code, match),
    })),
  )
    .sort((left, right) => left.at - right.at)
    .map(({ write }) => write);
};

const allWrites = (): ProjectsWrite[] => {
  const paths = censusPaths(REPO_ROOT, {
    pathspecs: ['*.ts', '*.mts', '*.cts', '*.tsx', '*.js', '*.mjs', '*.cjs', '*.sql'],
  }).filter((file) => !TEST_SOURCE.test(file));
  const { files, unreadable } = readCensus(REPO_ROOT, paths);
  if (unreadable.length > 0) {
    throw new CensusUnreadableError(unreadable);
  }
  return files.flatMap(({ path: file, contents }) => writesIn(file, contents));
};

/** Column → the file of each update statement that writes it, every table column present. */
const columnWriters = (writes: readonly ProjectsWrite[]): Record<string, string[]> => {
  const table: Record<string, string[]> = Object.fromEntries(
    TABLE_COLUMNS.map((column) => [column, [] as string[]]),
  );
  for (const write of writes) {
    if (write.kind !== 'update') continue;
    for (const column of write.columns) {
      table[column] = [...(table[column] ?? []), write.file];
    }
  }
  return Object.fromEntries(
    Object.entries(table).map(([column, files]) => [column, [...files].sort()]),
  );
};

const sortedDeclaration = (
  declared: Readonly<Record<string, readonly string[]>>,
): Record<string, string[]> =>
  Object.fromEntries(
    Object.entries(declared).map(([column, files]) => [column, [...files].sort()]),
  );

/**
 * What a census over `writes` reports against a declaration — empty when the tree matches it.
 * Pure, so the canaries below run it over a planted tree rather than over this repository.
 */
const findings = (
  writes: readonly ProjectsWrite[],
  declared: Readonly<Record<string, readonly string[]>>,
): string[] => {
  const problems: string[] = [];
  for (const write of writes) {
    if (write.unreadable !== undefined) {
      problems.push(`${write.file}: unreadable ${write.kind} (${write.unreadable})`);
    }
  }
  for (const column of TABLE_COLUMNS) {
    if (!(column in declared)) problems.push(`${column}: a column with no declared writers`);
  }
  for (const column of Object.keys(declared)) {
    if (!TABLE_COLUMNS.includes(column)) problems.push(`${column}: declared, and not a column`);
  }
  const actual = columnWriters(writes);
  const expected = sortedDeclaration(declared);
  for (const column of TABLE_COLUMNS) {
    const has = JSON.stringify(actual[column] ?? []);
    const wants = JSON.stringify(expected[column] ?? []);
    if (column in declared && has !== wants) {
      problems.push(`${column}: written by ${has}, declared ${wants}`);
    }
  }
  for (const [column, files] of Object.entries(actual)) {
    if (SHARED_COLUMNS.has(column)) continue;
    const runtime = files.filter((file) => !file.startsWith(MIGRATIONS)).length;
    if (runtime > (CO_OWNED_COLUMNS[column] ?? 1)) {
      problems.push(`${column}: ${runtime} runtime writing statements`);
    }
  }
  return problems;
};

describe('`projects` column ownership (WP-129)', () => {
  it('declares every column of the table, and nothing that is not one', () => {
    expect(Object.keys(COLUMN_WRITERS).sort()).toEqual([...TABLE_COLUMNS].sort());
  });

  it('parses every write of `projects` it finds into plain column names', () => {
    // Fail closed (standing rule 20): a statement this census cannot attribute is reported by name.
    expect(
      allWrites()
        .filter((write) => write.unreadable !== undefined)
        .map((write) => `${write.file}: ${write.unreadable}`),
    ).toEqual([]);
  });

  it('gives every column exactly its declared writing statements', () => {
    expect(columnWriters(allWrites())).toEqual(sortedDeclaration(COLUMN_WRITERS));
  });

  it('has one runtime writer per column, except the declared co-owners, and reports nothing', () => {
    expect(findings(allWrites(), COLUMN_WRITERS)).toEqual([]);
  });

  it('creates rows only where it says it does, and never by an upsert', () => {
    const sites: Record<string, number> = {};
    for (const write of allWrites()) {
      if (write.kind === 'insert') sites[write.file] = (sites[write.file] ?? 0) + 1;
    }
    expect(sites).toEqual(INSERT_SITES);
  });

  it('agrees with WP-113’s stricter half on `maintenance_last_blocker`', () => {
    // `maintenance/maintenance-blocker-writers.test.ts` names this one file for the column.
    expect(columnWriters(allWrites()).maintenance_last_blocker).toEqual([BLOCKER_STORE]);
  });

  describe('calibration (standing rule 21)', () => {
    it('sees every spelling of a write…', () => {
      expect(
        writesIn(
          'a.ts',
          "await sql.query('update projects set readiness_level = $2 where id = $1', [a, b]);",
        ),
      ).toEqual([{ file: 'a.ts', kind: 'update', columns: ['readiness_level'] }]);
      expect(
        writesIn(
          'a.ts',
          'await sql.query(`update projects\n   set config = $2::jsonb, config_hash = $3\n where id = $1`, []);',
        ),
      ).toEqual([{ file: 'a.ts', kind: 'update', columns: ['config', 'config_hash'] }]);
      expect(
        writesIn(
          'a.ts',
          // biome-ignore lint/suspicious/noTemplateCurlyInString: planted source text, read as data
          'await tx.execute(sql`update ${projects} set name = ${n} where id = ${id}`);',
        ),
      ).toEqual([{ file: 'a.ts', kind: 'update', columns: ['name'] }]);
      expect(
        writesIn(
          'a.ts',
          'await db.update(schema.projects).set({ autonomyLevel: l, autonomyPolicies: materialise({ level: l, at }), updatedAt: now }).where(x);',
        ),
      ).toEqual([
        {
          file: 'a.ts',
          kind: 'update',
          columns: ['autonomy_level', 'autonomy_policies', 'updated_at'],
        },
      ]);
      expect(
        writesIn(
          'a.ts',
          'db.update(projects).set({ config, ...(x ? {} : { status: s }) }).where(y);',
        ),
      ).toEqual([{ file: 'a.ts', kind: 'update', columns: ['config', 'status'] }]);
      expect(
        writesIn(
          'a.sql',
          "update projects set autonomy_policies = jsonb_build_object('level', 'observe', 'p', '{\"a\":1,\"b\":2}'::jsonb) where autonomy_level = 'observe';",
        ),
      ).toEqual([{ file: 'a.sql', kind: 'update', columns: ['autonomy_policies'] }]);
      expect(
        writesIn('a.ts', 'await tx.insert(projects).values({ key }).onConflictDoNothing();'),
      ).toEqual([{ file: 'a.ts', kind: 'insert', columns: [] }]);
      expect(writesIn('a.sql', 'insert into projects (org_id, key) values ($1, $2);')).toEqual([
        { file: 'a.sql', kind: 'insert', columns: [] },
      ]);
    });

    it('…and reports, rather than skips, what it cannot attribute', () => {
      expect(
        writesIn('a.ts', 'await db.update(projects).set(row).where(x);')[0]?.unreadable,
      ).toMatch(/not a literal/);
      expect(
        writesIn('a.ts', 'await db.update(projects).set({ ...row }).where(x);')[0]?.unreadable,
      ).toMatch(/cannot name/);
      expect(
        writesIn('a.ts', 'await db.update(projects).set({ nmae: n }).where(x);')[0]?.unreadable,
      ).toMatch(/not columns: nmae/);
      expect(
        writesIn('a.ts', 'await db.update(projects).set({ [column]: n }).where(x);')[0]?.unreadable,
      ).toMatch(/cannot name/);
      expect(
        writesIn(
          'a.ts',
          'await db.insert(projects).values(v).onConflictDoUpdate({ target: projects.key, set: v });',
        )[0]?.unreadable,
      ).toMatch(/upsert/);
      expect(
        writesIn(
          'a.sql',
          'insert into projects (key) values ($1) on conflict (key) do update set name = excluded.name;',
        )[0]?.unreadable,
      ).toMatch(/upsert/);
    });

    it.each([
      ["'update projects p set config = $2 where p.id = $1'", ['config']],
      ["'update projects as p set config = $2 where p.id = $1'", ['config']],
      ["'update public.projects set config = $2 where id = $1'", ['config']],
      ["'UPDATE ONLY projects SET config = $2 WHERE id = $1'", ['config']],
      ['\'update "projects" set config = $2 where id = $1\'', ['config']],
      ['\'update "public"."projects" set config = $2 where id = $1\'', ['config']],
    ])('reads an aliased, qualified or quoted update (review round 1): %s', (source, columns) => {
      expect(writesIn('a.ts', `await sql.query(${source}, []);`)).toEqual([
        { file: 'a.ts', kind: 'update', columns },
      ]);
    });

    it('reads a qualified or quoted insert, and refuses `merge into projects` (review round 1)', () => {
      expect(writesIn('a.sql', 'insert into public.projects (key) values ($1);')).toEqual([
        { file: 'a.sql', kind: 'insert', columns: [] },
      ]);
      expect(writesIn('a.sql', 'insert into "projects" (key) values ($1);')).toEqual([
        { file: 'a.sql', kind: 'insert', columns: [] },
      ]);
      expect(
        writesIn(
          'a.sql',
          'merge into projects p using incoming i on p.id = i.id when matched then update set config = i.config;',
        ),
      ).toEqual([
        {
          file: 'a.sql',
          kind: 'update',
          columns: [],
          unreadable: 'a `merge into projects`, which this census does not parse',
        },
      ]);
    });

    it('…and none of what is not one', () => {
      expect(writesIn('a.ts', '/** `update projects set config = $2` */\nconst x = 1;')).toEqual(
        [],
      );
      expect(writesIn('a.ts', '// await db.update(projects).set({ config })\n')).toEqual([]);
      expect(writesIn('a.sql', '-- update projects set config = null;\nselect 1;')).toEqual([]);
      expect(writesIn('a.ts', "'select readiness_level from projects where id = $1'")).toEqual([]);
      expect(
        writesIn('a.ts', 'await db.select().from(projects).where(eq(projects.id, id));'),
      ).toEqual([]);
      expect(writesIn('a.ts', "'update project_members set role = $2 where user_id = $1'")).toEqual(
        [],
      );
    });
  });

  describe('canaries: the census fails on what it exists to refuse', () => {
    const tree = (): ProjectsWrite[] => allWrites();

    it('fails on a whole-row `update projects`', () => {
      const wholeRow = writesIn(
        'packages/infrastructure/src/onboarding/postgres-project-store.ts',
        "await sql.query('update projects set name = $2, config = $3, autonomy_level = $4, autonomy_policies = $5, readiness_level = $6 where id = $1', row);",
      );
      const problems = findings([...tree(), ...wholeRow], COLUMN_WRITERS);
      for (const column of [
        'name',
        'config',
        'autonomy_level',
        'autonomy_policies',
        'readiness_level',
      ]) {
        expect(problems.some((problem) => problem.startsWith(`${column}: written by`))).toBe(true);
      }
      expect(problems).toContain('readiness_level: 2 runtime writing statements');
    });

    it('fails on a whole-row Drizzle `.set(row)`', () => {
      const wholeRow = writesIn(
        'apps/server/src/x.ts',
        'await db.update(projects).set(row).where(eq(projects.id, id));',
      );
      expect(findings([...tree(), ...wholeRow], COLUMN_WRITERS)).toEqual([
        'apps/server/src/x.ts: unreadable update (a set of `row`, not a literal)',
      ]);
    });

    it('fails on a column nobody declared', () => {
      const { maintenance_last_blocker: _dropped, ...declared } = COLUMN_WRITERS;
      expect(findings(tree(), declared)).toEqual([
        'maintenance_last_blocker: a column with no declared writers',
      ]);
    });

    it('fails on a second writer of a single-owner column', () => {
      const second = writesIn(
        'packages/application/src/x.ts',
        "await sql.query('update projects set maintenance_last_blocker = null where id = $1', [id]);",
      );
      expect(findings([...tree(), ...second], COLUMN_WRITERS)).toEqual([
        `maintenance_last_blocker: written by ${JSON.stringify(['packages/application/src/x.ts', BLOCKER_STORE].sort())}, declared ${JSON.stringify([BLOCKER_STORE])}`,
        'maintenance_last_blocker: 2 runtime writing statements',
      ]);
    });
  });
});

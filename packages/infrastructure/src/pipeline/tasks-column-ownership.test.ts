/**
 * Every column of `tasks` has **one** writing statement — read off disk (WP-15e).
 *
 * This is the half of PROGRESS backlog 18 that a version column cannot do. Optimistic concurrency
 * makes `save` refuse a write over a row that moved; it says nothing about a column `save` names
 * that it has no business naming. That was live on `main` until this work package: WP-15d gave the
 * workpad job `saveWorkpad` so it would stop clobbering the executor's cost, and `save` still wrote
 * `workpad_ref`, so the executor went on clobbering the workpad — one direction fixed, one
 * direction not, and nothing could tell, because the property was *described* in a docblock rather
 * than checked.
 *
 * So it is checked. Standing rule **44**: a "this is the only place X happens" docblock must be
 * enforced by the same check that enforces X, or it is decoration.
 *
 * ## Scope
 *
 * git's, not a list carried here (rule 7): tracked sources **and** untracked-but-committable ones
 * (rule 85), `.ts` and `.sql`. A new adapter that writes `tasks` is inside the scope the moment the
 * file exists, which is the point — the writer this guard exists to catch is the one nobody has
 * written yet.
 *
 * ## What it reads, and the three things it cannot
 *
 * It finds `update tasks set … where …` inside a string or template literal — the character before
 * `update` must be a quote or a backtick, and the line must not begin a comment — and takes the
 * identifier on the left of every top-level assignment. That rule is what keeps the prose in
 * `store.ts` ("every `update tasks` statement") and in `memory-pipeline.ts` out of the corpus,
 * because a guard that fires on legitimate content gets switched off.
 *
 *  - **A statement built by concatenation is invisible.** `\`update tasks set \` + column` parses as
 *    a set clause with no assignments and is reported as unparsable rather than skipped, but a
 *    column name that only exists at runtime cannot be attributed to an owner at all.
 *  - **It cannot see an `insert … on conflict do update`.** `tasks` has no upsert writer today and
 *    the census below would not find one; a reviewer adding one owes this guard a case.
 *  - **It says nothing about the in-memory store**, which is TypeScript rather than SQL. The
 *    memory store's own `save` is held to the same column set by the shared contract suites, and
 *    its divergence register says so explicitly.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');

/**
 * Columns more than one statement may write, with the reason.
 *
 * `updated_at` is a bookkeeping timestamp every writer sets to `now()`; two writers racing on it
 * disagree about a millisecond and about nothing else, and giving it an owner would mean a narrow
 * write could not touch it — which is worse, because then a narrow write would leave the row
 * looking untouched.
 */
const SHARED_COLUMNS: ReadonlySet<string> = new Set(['updated_at']);

/** The owner of every `tasks` column that any statement in this repository writes. */
const EXPECTED_OWNERSHIP: Readonly<Record<string, readonly string[]>> = {
  'packages/infrastructure/src/cost/postgres-cost-store.ts': ['size', 'estimate_usd'],
  'packages/infrastructure/src/pipeline/postgres-pipeline-store.ts': [
    // `saveTicketSnapshot`
    'ticket_snapshot',
    'ticket_snapshot_at',
    // `saveWorkpad`
    'workpad_ref',
    // `save` — the aggregate's own columns, plus the token that guards them
    'state',
    'current_stage',
    'branch',
    'mr_ref',
    'stage_attempts',
    'iteration_counters',
    'cost_actual',
    'version',
    'completed_at',
  ],
};

const gitFiles = (args: readonly string[]): string[] =>
  execFileSync('git', [...args, '-z', '--', '*.ts', '*.sql'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
    .split('\0')
    .filter((file) => file.length > 0);

const sources = (): string[] => [
  ...new Set([
    ...gitFiles(['ls-files']),
    ...gitFiles(['ls-files', '--others', '--exclude-standard']),
  ]),
];

interface Statement {
  readonly file: string;
  readonly columns: readonly string[];
}

const UPDATE_TASKS = /update\s+tasks\s+set\b([\s\S]*?)\bwhere\b/gi;

/** The line `index` falls on, so a match inside a comment can be recognised. */
const lineAt = (source: string, index: number): string => {
  const start = source.lastIndexOf('\n', index) + 1;
  const end = source.indexOf('\n', index);
  return source.slice(start, end === -1 ? source.length : end);
};

/** Splits a `set` clause on commas that are not inside parentheses. */
const assignments = (clause: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of clause) {
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (character === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
};

const statementsIn = (file: string, source: string): Statement[] => {
  const found: Statement[] = [];
  UPDATE_TASKS.lastIndex = 0;
  for (const match of source.matchAll(UPDATE_TASKS)) {
    const index = match.index ?? 0;
    const before = source.slice(0, index).replace(/\s+$/, '');
    const quote = before.at(-1);
    if (quote !== '`' && quote !== "'" && quote !== '"') {
      continue;
    }
    const line = lineAt(source, index).trimStart();
    if (line.startsWith('*') || line.startsWith('//') || line.startsWith('--')) {
      continue;
    }
    const columns = assignments(match[1] ?? '').map((part) => part.split('=')[0]?.trim() ?? '');
    found.push({ file, columns });
  }
  return found;
};

const allStatements = (): Statement[] =>
  sources().flatMap((file) => statementsIn(file, readFileSync(path.join(REPO_ROOT, file), 'utf8')));

describe('`tasks` column ownership (WP-15e)', () => {
  it('parses every `update tasks` statement it finds into plain column names', () => {
    // Fail closed: a set clause this guard cannot read is a statement whose columns cannot be
    // attributed, and reporting it as "no columns" would be a silent hole (standing rule 20).
    for (const statement of allStatements()) {
      expect(statement.columns.length).toBeGreaterThan(0);
      for (const column of statement.columns) {
        expect(column, `${statement.file} writes an unreadable assignment target`).toMatch(
          /^[a-z_][a-z0-9_]*$/,
        );
      }
    }
  });

  it('gives every column exactly one writing statement', () => {
    const owners = new Map<string, string[]>();
    for (const [index, statement] of allStatements().entries()) {
      for (const column of statement.columns) {
        if (SHARED_COLUMNS.has(column)) {
          continue;
        }
        owners.set(column, [...(owners.get(column) ?? []), `${statement.file}#${index}`]);
      }
    }
    const contested = [...owners].filter(([, writers]) => writers.length > 1);
    // `workpad_ref` was in this list on `main` at 5121d73 — written by `save` and by `saveWorkpad`
    // — which is the defect, not a false positive.
    expect(Object.fromEntries(contested)).toEqual({});
  });

  it('writes exactly the columns this change says it writes, per file', () => {
    const byFile = new Map<string, Set<string>>();
    for (const statement of allStatements()) {
      const columns = byFile.get(statement.file) ?? new Set<string>();
      for (const column of statement.columns) {
        if (!SHARED_COLUMNS.has(column)) {
          columns.add(column);
        }
      }
      byFile.set(statement.file, columns);
    }
    expect(
      Object.fromEntries([...byFile].map(([file, columns]) => [file, [...columns].sort()])),
    ).toEqual(
      Object.fromEntries(
        Object.entries(EXPECTED_OWNERSHIP).map(([file, columns]) => [file, [...columns].sort()]),
      ),
    );
  });
});

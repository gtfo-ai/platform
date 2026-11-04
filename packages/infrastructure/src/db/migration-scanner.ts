/**
 * The statement scanner behind `migrations:check`'s `additive` rule (TD-032 decision 1, WP-271).
 *
 * An `additive` migration promises that *the previous release's code works on the schema after it
 * and on every row the new release writes*. That is a property nobody can check in general, so the
 * check admits a **closed list** of statement shapes TD-032 names and refuses everything else —
 * an unknown statement **fails**, and the escape is to declare the file `contract`, never to teach
 * the scanner a guess.
 *
 * ## What is admitted (TD-032 §1, as amended on 2026-11-04 — A to D)
 *
 * The rulings are TD-032's 2026-11-04 amendment
 * (`docs/decisions/technical/TD-032-automatic-updates-and-migration-classes.md`, sections A–D);
 * this table is that amendment's list, and the amendment wins where they differ.
 *
 * | statement | admitted when |
 * |---|---|
 * | `create [unlogged] table` | always, subject to B (the old build never names the table) |
 * | `create index` | never `concurrently`: the migrator applies each file in one transaction, where it cannot run |
 * | `create unique index` | only on a table the same file creates (A) — on an existing table it can refuse a row the old build writes |
 * | `alter table … add [column]` | the column is nullable or has a default, with no inline `check`, `unique` or `primary key` (write a check as `add constraint … not valid`); subject to B |
 * | `alter table … add constraint` on a table the same file creates | always (A), subject to B |
 * | `alter table … add constraint … check`/`foreign key … not valid` on an existing table | only over columns the same file added earlier, nullable with no default, and a check only when null-propagating by construction (C) |
 * | `alter table … validate constraint` | always (it completes a `not valid`; a row it refuses fails the migration, and the running build carries on) |
 * | `create [or replace] function` | the name is new, or an earlier migration declared it with the same arguments and return type |
 * | `create [or replace] view` | always — PostgreSQL itself refuses a replacement that drops, renames or retypes a column |
 * | `create [or replace] [constraint] trigger` | only on a table the same file creates (D); `create event trigger` never |
 * | `grant`, `comment on` | always |
 * | `alter type … add value 'v'` | `'v'` is already in `packages/contracts` at the base commit (the caller answers) |
 * | `insert into platform_table_policy` | every `table_name` it registers is a table the same file creates, every value a literal (A; technical/03: every migration that creates a table registers it) |
 *
 * **A's precondition, held here and not only stated**: "a table this file creates" is only a plain
 * `create [unlogged] table <name>` — never `if not exists`, `temp`/`temporary`, a `partition of` or
 * `inherits` child, or `create table … as`; and a call to a routine this file or an earlier
 * migration declares is refused wherever a call is evaluated. Weakening either re-opens decision 1.
 *
 * **B — references.** Every `references <table>` (inline in `create table` or `add column`, or in an
 * `add [constraint …] foreign key`) naming a table the file did not create must state `on delete
 * cascade`, `on delete set null` or `on delete set default`, and never `match full`: with the default
 * `no action` a row the newer build writes refuses the previous build's delete of the parent.
 * `on update` is not read (no platform code updates a primary key).
 *
 * **C — a `not valid` check is null-propagating by construction** when every atom compares exactly
 * one same-file nullable column with literals (`=`, `<>`, `<`, `<=`, `>`, `>=`, `[not] in (…)`,
 * `between … and …`, `like`), atoms joined by `and`, `or` and parentheses. A null column then makes
 * every atom null and the check passes for every row the previous build writes.
 *
 * **D — refused by name**: `create type`, `create domain`, `create sequence`, `create event
 * trigger`, and a trigger on an existing table.
 *
 * Every other statement is refused, by name. In particular nothing that **drops**, **renames** or
 * **changes a column's type** is ever admitted, whatever table it names — `migration-scanner.test.ts`
 * holds that as a property over generated spellings, case, whitespace and comments.
 *
 * ## How it reads SQL
 *
 * A tokenizer, not a regular expression over the text: comments (`--`, nested `/* *\/`), string
 * literals (`'…'`, `E'…'`, `U&'…'`), quoted identifiers (`"…"`) and dollar-quoted bodies (`$tag$…$tag$`)
 * become opaque tokens first, so a keyword inside one is never read as a statement (`comment on …
 * is 'drop table x'` is a comment), and a quoted identifier never satisfies a keyword test (`add
 * column "x default" int not null` is still `not null` without a default). Statements are split on
 * `;` outside all of those. Unquoted words are lower-cased; a quoted identifier keeps its case.
 *
 * ## What it cannot see, stated
 *
 * - A function's **body** is opaque: `create function f() … as $$ drop table x $$` is admitted when
 *   `f` is new, because creating it changes nothing the old build calls. **What the scanner holds
 *   instead is that nothing the migration evaluates calls it** (WP-271 review round 1, which found
 *   three admitted statements that ran a function the same file created): `select f()` is refused
 *   as a statement; `create table … as` is refused; every value of a `platform_table_policy` insert
 *   must be a literal; and an expression PostgreSQL evaluates over existing rows at migration time
 *   — an added column's `default` or generated expression, an `add constraint … not valid` check
 *   that the later `validate` runs, a `create index` expression or predicate on an existing table —
 *   may call only the builtins in {@link PURE_CALLS}. A call is a name followed by `(`; a type
 *   modifier (`numeric(12, 6)`), a keyword (`in (…)`, `check (…)`) and the table after `on`,
 *   `only` or `references` are not calls.
 * - Whether a `create or replace function` with the same signature keeps the same **behaviour**.
 * - Whether a `create or replace view`'s columns keep their **meaning** (PostgreSQL holds their
 *   names and types).
 * - A `default` built from the admitted builtins that is still expensive, and the lock a
 *   `create index` takes.
 * - **Overload resolution** is PostgreSQL's, not the scanner's: `lower(1)` calls a migration's
 *   `lower(integer)` rather than the builtin, because an exact match wins (review round 2). So the
 *   scanner never decides which overload a call reaches: a call to **any** name this file or an
 *   earlier migration defines — any schema, any signature — is refused wherever calls are checked,
 *   and a `create function` named like a member of `PURE_CALLS` (or a keyword it skips) is refused.
 *   What remains is an overload no `create function` the scanner can read declared: one in a
 *   schema earlier on the `search_path` that no migration made, or one an earlier `contract`
 *   migration introduced by `alter function … rename`, `create extension` or a name spelling the
 *   reader cannot parse.
 * - A function reached without a call's spelling: an operator a migration defined (`create
 *   operator` is refused, so only one an earlier migration made), or a cast.
 * - **B's action against the column**: an `on delete set null` over a `not null` column (or a
 *   `set default` whose default names no parent row) still makes the parent's delete fail; the
 *   scanner reads the action, not the column it acts on.
 * - **C's "no default" against the column's type**: a column whose type is a domain carrying a
 *   default or `not null` reads as nullable with no default here. No migration creates a domain
 *   (D keeps `create domain` refused), so only one made outside the migrations could.
 * - The enum-value lookup is the caller's:`migrations:check` asks `git grep` for the quoted value
 *   anywhere under `packages/contracts` at the base commit, so a value that appears there only in
 *   another enum is admitted.
 */
export type SqlToken =
  /** An unquoted word, lower-cased. */
  | { readonly kind: 'word'; readonly text: string; readonly line: number }
  /** A `"quoted identifier"`, its text as written. */
  | { readonly kind: 'ident'; readonly text: string; readonly line: number }
  /** A string literal's value. */
  | { readonly kind: 'string'; readonly text: string; readonly line: number }
  /** A dollar-quoted body — opaque. */
  | { readonly kind: 'dollar'; readonly text: string; readonly line: number }
  | { readonly kind: 'number'; readonly text: string; readonly line: number }
  /** `$1` and the like. */
  | { readonly kind: 'param'; readonly text: string; readonly line: number }
  /** Any other single character. */
  | { readonly kind: 'punct'; readonly text: string; readonly line: number };

/** SQL the tokenizer could not read to its end — an unterminated literal, comment or body. */
export class SqlTokenizeError extends Error {
  override readonly name = 'SqlTokenizeError';
  readonly line: number;

  // No parameter property: Node's strip-only loader refuses one, and `migrations:check` runs
  // this file through it.
  constructor(message: string, line: number) {
    super(`line ${line}: ${message}`);
    this.line = line;
  }
}

const WORD_START = /[A-Za-z_\u0080-￿]/;
const WORD_PART = /[A-Za-z0-9_$\u0080-￿]/;
const DIGIT = /[0-9]/;
const DOLLAR_TAG = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;

const countNewlines = (text: string): number => {
  let count = 0;
  for (const character of text) {
    if (character === '\n') count += 1;
  }
  return count;
};

/** Reads a quoted run starting at `start` (the opening quote); `''`-style doubling escapes. */
const readQuoted = (
  sql: string,
  start: number,
  quote: string,
  backslashEscapes: boolean,
  line: number,
): { readonly text: string; readonly end: number } => {
  let text = '';
  let index = start + 1;
  while (index < sql.length) {
    const character = sql[index] as string;
    if (backslashEscapes && character === '\\') {
      text += sql.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (character === quote) {
      if (sql[index + 1] === quote) {
        text += quote;
        index += 2;
        continue;
      }
      return { text, end: index + 1 };
    }
    text += character;
    index += 1;
  }
  throw new SqlTokenizeError(
    `unterminated ${quote === '"' ? 'quoted identifier' : 'string literal'}`,
    line,
  );
};

/** The tokens of `sql`, comments and whitespace dropped. */
export const tokenizeSql = (sql: string): SqlToken[] => {
  const tokens: SqlToken[] = [];
  let index = 0;
  let line = 1;
  while (index < sql.length) {
    const character = sql[index] as string;
    const next = sql[index + 1];
    if (character === '\n') {
      line += 1;
      index += 1;
    } else if (/\s/.test(character)) {
      index += 1;
    } else if (character === '-' && next === '-') {
      const end = sql.indexOf('\n', index);
      index = end === -1 ? sql.length : end;
    } else if (character === '/' && next === '*') {
      const opened = line;
      let depth = 1;
      index += 2;
      while (index < sql.length && depth > 0) {
        if (sql.startsWith('/*', index)) {
          depth += 1;
          index += 2;
        } else if (sql.startsWith('*/', index)) {
          depth -= 1;
          index += 2;
        } else {
          if (sql[index] === '\n') line += 1;
          index += 1;
        }
      }
      if (depth > 0) throw new SqlTokenizeError('unterminated block comment', opened);
    } else if (character === "'" || (/[eEbBxXnN]/.test(character) && next === "'")) {
      const quoteAt = character === "'" ? index : index + 1;
      const escapes = character === 'e' || character === 'E';
      const read = readQuoted(sql, quoteAt, "'", escapes, line);
      tokens.push({ kind: 'string', text: read.text, line });
      line += countNewlines(sql.slice(index, read.end));
      index = read.end;
    } else if (/[uU]/.test(character) && next === '&' && sql[index + 2] === "'") {
      const read = readQuoted(sql, index + 2, "'", false, line);
      tokens.push({ kind: 'string', text: read.text, line });
      line += countNewlines(sql.slice(index, read.end));
      index = read.end;
    } else if (character === '"') {
      const read = readQuoted(sql, index, '"', false, line);
      tokens.push({ kind: 'ident', text: read.text, line });
      line += countNewlines(sql.slice(index, read.end));
      index = read.end;
    } else if (character === '$' && next !== undefined && DIGIT.test(next)) {
      let end = index + 1;
      while (end < sql.length && DIGIT.test(sql[end] as string)) end += 1;
      tokens.push({ kind: 'param', text: sql.slice(index, end), line });
      index = end;
    } else if (character === '$' && DOLLAR_TAG.test(sql.slice(index, index + 64))) {
      const tag = (DOLLAR_TAG.exec(sql.slice(index, index + 64)) as RegExpExecArray)[0];
      const close = sql.indexOf(tag, index + tag.length);
      if (close === -1) throw new SqlTokenizeError(`unterminated dollar-quoted body ${tag}`, line);
      const body = sql.slice(index + tag.length, close);
      tokens.push({ kind: 'dollar', text: body, line });
      line += countNewlines(sql.slice(index, close + tag.length));
      index = close + tag.length;
    } else if (WORD_START.test(character)) {
      let end = index + 1;
      while (end < sql.length && WORD_PART.test(sql[end] as string)) end += 1;
      tokens.push({ kind: 'word', text: sql.slice(index, end).toLowerCase(), line });
      index = end;
    } else if (
      DIGIT.test(character) ||
      (character === '.' && next !== undefined && DIGIT.test(next))
    ) {
      const match = /^[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?|^[0-9]+\.?/.exec(
        sql.slice(index),
      ) as RegExpExecArray;
      tokens.push({ kind: 'number', text: match[0], line });
      index += match[0].length;
    } else {
      tokens.push({ kind: 'punct', text: character, line });
      index += 1;
    }
  }
  return tokens;
};

/** One statement: its tokens (without the `;`) and the line it starts on. */
export interface SqlStatement {
  readonly tokens: readonly SqlToken[];
  readonly line: number;
}

/** `sql` split into statements on `;` outside literals, comments and bodies; empty ones dropped. */
export const splitStatements = (sql: string): SqlStatement[] => {
  const statements: SqlStatement[] = [];
  let current: SqlToken[] = [];
  const flush = () => {
    if (current.length > 0) {
      statements.push({ tokens: current, line: (current[0] as SqlToken).line });
    }
    current = [];
  };
  for (const token of tokenizeSql(sql)) {
    if (token.kind === 'punct' && token.text === ';') flush();
    else current.push(token);
  }
  flush();
  return statements;
};

// ── reading helpers ─────────────────────────────────────────────────────────────────────────

const isWord = (token: SqlToken | undefined, ...words: string[]): boolean =>
  token?.kind === 'word' && words.includes(token.text);

const isPunct = (token: SqlToken | undefined, text: string): boolean =>
  token?.kind === 'punct' && token.text === text;

const nameText = (token: SqlToken | undefined): string | null =>
  token?.kind === 'word' || token?.kind === 'ident' ? token.text : null;

/**
 * A possibly schema-qualified name at `at`, normalised (`public.` dropped), and where it ends —
 * or `null` when `at` is not a name.
 */
const readName = (
  tokens: readonly SqlToken[],
  at: number,
): { readonly name: string; readonly next: number } | null => {
  const first = nameText(tokens[at]);
  if (first === null) return null;
  if (isPunct(tokens[at + 1], '.')) {
    const second = nameText(tokens[at + 2]);
    if (second === null) return null;
    return { name: first === 'public' ? second : `${first}.${second}`, next: at + 3 };
  }
  return { name: first, next: at + 1 };
};

/** Skips the words of `sequence` at `at` when they are all there; returns the next index. */
const skipWords = (tokens: readonly SqlToken[], at: number, ...sequence: string[]): number =>
  sequence.every((word, offset) => isWord(tokens[at + offset], word)) ? at + sequence.length : at;

/** The index just past the parenthesised group that opens at `at`, or `null`. */
const closeParen = (tokens: readonly SqlToken[], at: number): number | null => {
  if (!isPunct(tokens[at], '(')) return null;
  let depth = 0;
  for (let index = at; index < tokens.length; index += 1) {
    if (isPunct(tokens[index], '(')) depth += 1;
    if (isPunct(tokens[index], ')')) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return null;
};

/** `tokens` split on commas at parenthesis depth zero. */
const splitTopLevel = (tokens: readonly SqlToken[]): SqlToken[][] => {
  const parts: SqlToken[][] = [[]];
  let depth = 0;
  for (const token of tokens) {
    if (isPunct(token, '(')) depth += 1;
    if (isPunct(token, ')')) depth -= 1;
    if (depth === 0 && isPunct(token, ',')) parts.push([]);
    else (parts[parts.length - 1] as SqlToken[]).push(token);
  }
  return parts;
};

/** The words of `tokens` outside any parentheses. */
const topLevelWords = (tokens: readonly SqlToken[]): string[] => {
  const words: string[] = [];
  let depth = 0;
  for (const token of tokens) {
    if (isPunct(token, '(')) depth += 1;
    else if (isPunct(token, ')')) depth -= 1;
    else if (depth === 0 && token.kind === 'word') words.push(token.text);
  }
  return words;
};

const render = (tokens: readonly SqlToken[]): string =>
  tokens
    .map((token) => {
      if (token.kind === 'ident') return `"${token.text}"`;
      if (token.kind === 'string') return `'${token.text}'`;
      if (token.kind === 'dollar') return '$$…$$';
      return token.text;
    })
    .join(' ');

/** The first few words of a statement, for a finding a person reads. */
export const describeStatement = (statement: SqlStatement): string => {
  const text = render(statement.tokens.slice(0, 8));
  return statement.tokens.length > 8 ? `${text} …` : text;
};

// ── functions: the signature an earlier migration declared ─────────────────────────────────

const RETURNS_STOP = new Set([
  'as',
  'language',
  'immutable',
  'stable',
  'volatile',
  'security',
  'strict',
  'called',
  'set',
  'cost',
  'rows',
  'parallel',
  'leakproof',
  'window',
  'not',
  'external',
  'support',
  'transform',
  'begin',
  'return',
]);

interface FunctionSignature {
  readonly name: string;
  readonly signature: string;
}

/** `create [or replace] function <name>(<args>) returns <type>` read off a statement. */
const readFunction = (tokens: readonly SqlToken[]): FunctionSignature | null => {
  let at = skipWords(tokens, 0, 'create');
  if (at === 0) return null;
  at = skipWords(tokens, at, 'or', 'replace');
  if (!isWord(tokens[at], 'function')) return null;
  const named = readName(tokens, at + 1);
  if (named === null) return null;
  const argsEnd = closeParen(tokens, named.next);
  if (argsEnd === null) return null;
  const args = render(tokens.slice(named.next, argsEnd));
  let returns = '';
  if (isWord(tokens[argsEnd], 'returns')) {
    const kept: SqlToken[] = [];
    let depth = 0;
    for (let index = argsEnd + 1; index < tokens.length; index += 1) {
      const token = tokens[index] as SqlToken;
      if (isPunct(token, '(')) depth += 1;
      if (isPunct(token, ')')) depth -= 1;
      if (depth === 0 && (token.kind === 'dollar' || token.kind === 'string')) break;
      if (depth === 0 && token.kind === 'word' && RETURNS_STOP.has(token.text)) break;
      kept.push(token);
    }
    returns = render(kept);
  }
  return { name: named.name, signature: `${args} returns ${returns}` };
};

/**
 * Every function signature the migrations in `sqls` declare, by normalised name — the context
 * {@link scanAdditive} compares a `create or replace function` with.
 */
export const declaredFunctionSignatures = (sqls: readonly string[]): Map<string, Set<string>> => {
  const declared = new Map<string, Set<string>>();
  for (const sql of sqls) {
    for (const statement of splitStatements(sql)) {
      const found = readFunction(statement.tokens);
      if (found === null) continue;
      const set = declared.get(found.name) ?? new Set<string>();
      set.add(found.signature);
      declared.set(found.name, set);
    }
  }
  return declared;
};

// ── calls: what an expression evaluated at migration time may invoke ──────────────────────

/**
 * The builtins an expression evaluated over existing rows may call: PostgreSQL's own, none of
 * which writes anything. Everything else — above all a function the same file creates — is
 * refused, because its body is opaque to the scanner and runs with the migrator's privileges.
 */
export const PURE_CALLS: ReadonlySet<string> = new Set([
  'now',
  'clock_timestamp',
  'statement_timestamp',
  'transaction_timestamp',
  'gen_random_uuid',
  'uuidv7',
  'lower',
  'upper',
  'btrim',
  'length',
  'char_length',
  'octet_length',
  'coalesce',
  'nullif',
  'greatest',
  'least',
  'abs',
  'date_trunc',
  'jsonb_typeof',
  'jsonb_array_length',
  'array_length',
  'cardinality',
]);
const PURE_CALL_LIST = 'PostgreSQL builtins that write nothing (`PURE_CALLS`)';

/** Words followed by `(` that are syntax or a type modifier, never a call. */
const NOT_A_CALL = new Set([
  // `on delete set null (column)` (PostgreSQL 15) — `null` is never a function.
  'null',
  'in',
  'any',
  'all',
  'some',
  'exists',
  'as',
  'check',
  'key',
  'unique',
  'values',
  'include',
  'where',
  'with',
  'and',
  'or',
  'not',
  'is',
  'then',
  'else',
  'when',
  'on',
  'using',
  'array',
  'row',
  'numeric',
  'decimal',
  'varchar',
  'char',
  'character',
  'varying',
  'bit',
  'varbit',
  'time',
  'timestamp',
  'timestamptz',
  'interval',
  'float',
  'btree',
  'hash',
  'gist',
  'spgist',
  'gin',
  'brin',
]);

/** Words whose following name is a table, so `references t (id)` is not a call of `t`. */
const NAMES_A_TABLE = new Set(['references', 'on', 'only']);

/**
 * The first call in `tokens` that {@link PURE_CALLS} does not admit, or `null`. A call is a word
 * or quoted identifier (optionally schema-qualified) followed by `(`; a qualified or quoted name
 * is never a builtin here, and neither is any name in `shadowed` — the functions this file or an
 * earlier migration defines, by their unqualified name (review round 2).
 */
const impureCall = (tokens: readonly SqlToken[], shadowed: ReadonlySet<string>): string | null => {
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const token = tokens[index] as SqlToken;
    if (!isPunct(tokens[index + 1], '(') || (token.kind !== 'word' && token.kind !== 'ident')) {
      continue;
    }
    const qualified = isPunct(tokens[index - 1], '.');
    const start = qualified ? index - 2 : index;
    if (isWord(tokens[start - 1], ...NAMES_A_TABLE)) continue;
    // A name a migration defines may be an overload that beats the builtin of the same name
    // (`lower(integer)` is an exact match for `lower(1)`), so it is a call whatever it spells.
    const called = qualified ? `${nameText(tokens[index - 2]) ?? ''}.${token.text}` : token.text;
    if (shadowed.has(token.text)) return called;
    if (!qualified && token.kind === 'word') {
      if (NOT_A_CALL.has(token.text) || PURE_CALLS.has(token.text)) continue;
    }
    return called;
  }
  return null;
};

/** One value of an `insert … values` row that is a literal: a string, a number, null or a boolean. */
const isLiteral = (value: readonly SqlToken[]): boolean => {
  const [only] = value;
  if (value.length !== 1 || only === undefined) return false;
  return only.kind === 'string' || only.kind === 'number' || isWord(only, 'null', 'true', 'false');
};

// ── classification ──────────────────────────────────────────────────────────────────────────

/** What the scanner needs to know beyond the file itself. */
export interface AdditiveScanContext {
  /** Whether an enum value already exists in `packages/contracts` at the base commit. */
  readonly enumValueAtBase: (value: string) => boolean;
  /** Function signatures earlier migrations declared ({@link declaredFunctionSignatures}). */
  readonly functionSignatures: ReadonlyMap<string, ReadonlySet<string>>;
}

export type StatementVerdict =
  | { readonly additive: true; readonly shape: string }
  | { readonly additive: false; readonly reason: string };

/** A statement the scanner did not admit, located for the person who wrote it. */
export interface AdditiveRefusal {
  readonly line: number;
  readonly statement: string;
  readonly reason: string;
}

const admit = (shape: string): StatementVerdict => ({ additive: true, shape });
const refuse = (reason: string): StatementVerdict => ({ additive: false, reason });

const NOT_ON_LIST =
  "not on TD-032's additive allow-list; declare the file `contract; expands: <nnnn>_<name>` if it is not additive";

interface FileState {
  /** Tables created earlier in the same file. */
  readonly tables: Set<string>;
  /**
   * Columns added earlier in the same file to an **existing** table, nullable and with no default,
   * by table — the only columns a `not valid` constraint there may name (TD-032 amendment C).
   */
  readonly nullableAdded: Map<string, Set<string>>;
  /**
   * Every function or procedure name this file or an earlier migration defines, unqualified and
   * in any signature: a call to one is never taken for a builtin.
   */
  readonly shadowed: ReadonlySet<string>;
}

/** The unqualified name of a routine `create [or replace] function|procedure` declares, or `null`. */
const declaredRoutine = (tokens: readonly SqlToken[]): string | null => {
  if (!isWord(tokens[0], 'create')) return null;
  const at = skipWords(tokens, 1, 'or', 'replace');
  if (!isWord(tokens[at], 'function', 'procedure')) return null;
  const named = readName(tokens, at + 1);
  return named === null ? null : (named.name.split('.').at(-1) as string);
};

const AMENDMENT = "TD-032's 2026-11-04 amendment";

/**
 * B: the first `references <table>` in `tokens` naming a table this file did not create (nor
 * `own`, the table the statement itself creates) that does not state `on delete cascade`, `set
 * null` or `set default`, or that states `match full` — as a refusal reason, or `null`.
 */
const referenceRefusal = (
  tokens: readonly SqlToken[],
  file: FileState,
  own: string | null,
): string | null => {
  for (let index = 0; index < tokens.length; index += 1) {
    if (!isWord(tokens[index], 'references')) continue;
    const named = readName(tokens, index + 1);
    if (named === null) return `a reference the scanner cannot read; ${NOT_ON_LIST}`;
    if (file.tables.has(named.name) || named.name === own) continue;
    // The clause runs to the next comma or close at the depth `references` sits at.
    let depth = 0;
    let end = named.next;
    for (; end < tokens.length; end += 1) {
      if (isPunct(tokens[end], '(')) depth += 1;
      else if (isPunct(tokens[end], ')')) {
        if (depth === 0) break;
        depth -= 1;
      } else if (depth === 0 && isPunct(tokens[end], ',')) break;
    }
    const words = topLevelWords(tokens.slice(named.next, end));
    const at = (word: string, offset: number) =>
      words.findIndex((w, i) => i >= offset && w === word);
    const match = at('match', 0);
    if (match !== -1 && words[match + 1] === 'full') {
      return `the reference to the existing table ${named.name} is \`match full\`, which ${AMENDMENT} B refuses`;
    }
    let onDelete = -1;
    for (let i = 0; i < words.length - 1; i += 1) {
      if (words[i] === 'on' && words[i + 1] === 'delete') onDelete = i + 2;
    }
    const action = onDelete === -1 ? [] : words.slice(onDelete, onDelete + 2);
    const settles =
      action[0] === 'cascade' ||
      (action[0] === 'set' && (action[1] === 'null' || action[1] === 'default'));
    if (!settles) {
      return `the reference to the existing table ${named.name} states no \`on delete cascade\`, \`set null\` or \`set default\`: with \`no action\` or \`restrict\` a row the newer build writes refuses the previous build's delete of the parent (${AMENDMENT} B)`;
    }
  }
  return null;
};

const COMPARISONS = new Set(['=', '<>', '<', '<=', '>', '>=']);

/**
 * C: whether `tokens` (a check's expression) is null-propagating by construction over `columns` —
 * atoms comparing exactly one such column with literals, joined by `and`, `or` and parentheses.
 * A tiny recursive reader; anything it does not recognise is a refusal.
 */
const nullPropagating = (tokens: readonly SqlToken[], columns: ReadonlySet<string>): boolean => {
  let at = 0;
  const literal = (): boolean => {
    const token = tokens[at];
    if (token?.kind === 'string' || token?.kind === 'number' || isWord(token, 'true', 'false')) {
      at += 1;
      return true;
    }
    if (isPunct(token, '-') && tokens[at + 1]?.kind === 'number') {
      at += 2;
      return true;
    }
    return false;
  };
  const column = (): boolean => {
    const name = nameText(tokens[at]);
    if (name === null || !columns.has(name) || isPunct(tokens[at + 1], '(')) return false;
    if (isPunct(tokens[at + 1], '.')) return false;
    at += 1;
    return true;
  };
  const operator = (): boolean => {
    const first = tokens[at];
    if (first?.kind !== 'punct') return false;
    const second = tokens[at + 1];
    const pair = second?.kind === 'punct' ? first.text + second.text : null;
    if (pair !== null && COMPARISONS.has(pair)) {
      at += 2;
      return true;
    }
    if (COMPARISONS.has(first.text)) {
      at += 1;
      return true;
    }
    return false;
  };
  const literalList = (): boolean => {
    if (!isPunct(tokens[at], '(')) return false;
    at += 1;
    for (;;) {
      if (!literal()) return false;
      if (!isPunct(tokens[at], ',')) break;
      at += 1;
    }
    if (!isPunct(tokens[at], ')')) return false;
    at += 1;
    return true;
  };
  const atom = (): boolean => {
    if (column()) {
      if (isWord(tokens[at], 'not') && isWord(tokens[at + 1], 'in')) {
        at += 2;
        return literalList();
      }
      if (isWord(tokens[at], 'in')) {
        at += 1;
        return literalList();
      }
      if (isWord(tokens[at], 'between')) {
        at += 1;
        if (!literal() || !isWord(tokens[at], 'and')) return false;
        at += 1;
        return literal();
      }
      if (isWord(tokens[at], 'like')) {
        at += 1;
        return literal();
      }
      return operator() && literal();
    }
    return literal() && operator() && column();
  };
  const primary = (): boolean => {
    if (isPunct(tokens[at], '(')) {
      at += 1;
      if (!disjunction() || !isPunct(tokens[at], ')')) return false;
      at += 1;
      return true;
    }
    return atom();
  };
  const conjunction = (): boolean => {
    if (!primary()) return false;
    while (isWord(tokens[at], 'and')) {
      at += 1;
      if (!primary()) return false;
    }
    return true;
  };
  function disjunction(): boolean {
    if (!conjunction()) return false;
    while (isWord(tokens[at], 'or')) {
      at += 1;
      if (!conjunction()) return false;
    }
    return true;
  }
  return disjunction() && at === tokens.length;
};

/** D: `create [or replace] [constraint] trigger <name> … on <table>` — admitted on a same-file table. */
const classifyTrigger = (
  tokens: readonly SqlToken[],
  at: number,
  file: FileState,
): StatementVerdict => {
  const named = readName(tokens, at + 1);
  const on = named === null ? -1 : tokens.findIndex((t, i) => i >= named.next && isWord(t, 'on'));
  const table = on === -1 ? null : readName(tokens, skipWords(tokens, on + 1, 'only'));
  if (table === null) return refuse(`a create trigger the scanner cannot read; ${NOT_ON_LIST}`);
  return file.tables.has(table.name)
    ? admit('create trigger (on a table this file creates)')
    : refuse(
        `a trigger on the existing table ${table.name} changes what the previous build's own writes do; only a trigger on a table the same file creates is additive (${AMENDMENT} D)`,
      );
};

const REFUSED_OBJECTS: ReadonlyMap<string, string> = new Map([
  [
    'type',
    `create type stays refused (${AMENDMENT} D): use a text column with a \`check\` inside \`create table\`, or declare the file \`contract\``,
  ],
  [
    'domain',
    `create domain stays refused (${AMENDMENT} D): use a text column with a \`check\` inside \`create table\`, or declare the file \`contract\``,
  ],
  [
    'sequence',
    `create sequence stays refused (${AMENDMENT} D): use \`generated … as identity\` inside \`create table\`, or declare the file \`contract\``,
  ],
]);

const classifyCreate = (
  tokens: readonly SqlToken[],
  context: AdditiveScanContext,
  file: FileState,
): StatementVerdict => {
  let at = 1;
  const orReplace = skipWords(tokens, at, 'or', 'replace') !== at;
  at = skipWords(tokens, at, 'or', 'replace');
  if (isWord(tokens[at], 'function')) {
    const routine = declaredRoutine(tokens);
    if (routine !== null && (PURE_CALLS.has(routine) || NOT_A_CALL.has(routine))) {
      return refuse(
        `function ${routine} shares its name with a builtin or a keyword the scanner admits as no harm; an overload of it would run wherever the builtin is called`,
      );
    }
    const found = readFunction(tokens);
    if (found === null)
      return refuse(`a function declaration the scanner cannot read; ${NOT_ON_LIST}`);
    const known = context.functionSignatures.get(found.name);
    if (known === undefined) return admit('create function (new)');
    return known.has(found.signature)
      ? admit('create or replace function (same signature)')
      : refuse(
          `function ${found.name} was declared by an earlier migration with a different signature; the previous build calls the old one`,
        );
  }
  let temporary = false;
  while (isWord(tokens[at], 'temp', 'temporary', 'recursive')) {
    temporary ||= isWord(tokens[at], 'temp', 'temporary');
    at += 1;
  }
  if (isWord(tokens[at], 'view')) return admit('create view');
  if (isWord(tokens[at], 'trigger')) return classifyTrigger(tokens, at, file);
  if (isWord(tokens[at], 'constraint') && isWord(tokens[at + 1], 'trigger')) {
    return classifyTrigger(tokens, at + 1, file);
  }
  if (isWord(tokens[at], 'event') && isWord(tokens[at + 1], 'trigger')) {
    return refuse(
      `create event trigger fires on DDL anywhere in the database, so it is never additive (${AMENDMENT} D)`,
    );
  }
  if (orReplace) return refuse(`create or replace ${nameText(tokens[at]) ?? '…'}: ${NOT_ON_LIST}`);
  while (isWord(tokens[at], 'unlogged', 'global', 'local', 'temp', 'temporary')) {
    temporary ||= isWord(tokens[at], 'temp', 'temporary');
    at += 1;
  }
  if (isWord(tokens[at], 'table')) {
    if (temporary) {
      // A temporary table shadows a permanent one of the same name for the rest of the session,
      // so "a table this file creates" could be made to name an existing one (review round 1).
      return refuse(`a migration creates no temporary table; ${NOT_ON_LIST}`);
    }
    const afterTable = skipWords(tokens, at + 1, 'if', 'not', 'exists');
    const named = readName(tokens, afterTable);
    if (named === null) return refuse(`a create table the scanner cannot read; ${NOT_ON_LIST}`);
    // `as` outside the column list is `create table … as <query>` (inside it, a generated column).
    if (topLevelWords(tokens.slice(named.next)).includes('as')) {
      return refuse(
        `create table ${named.name} … as runs a query at migration time, which can call any function; create the table and fill it in a contract migration`,
      );
    }
    // `if not exists` on a table that already exists creates nothing, so it never makes the
    // table "this file's" (review round 1: it admitted a `not null` column on `tasks`).
    // Nor does a partition or an inheriting child: the previous build's inserts into the parent
    // route into it, so a constraint or a unique index on it can refuse them (review round 2).
    const after = topLevelWords(tokens.slice(named.next));
    const child = isWord(tokens[named.next], 'partition') || after.includes('inherits');
    const own = afterTable === at + 1 && !child ? named.name : null;
    const reference = referenceRefusal(tokens.slice(named.next), file, own);
    if (own !== null) file.tables.add(own);
    return reference === null ? admit('create table') : refuse(reference);
  }
  const unique = isWord(tokens[at], 'unique');
  if (unique) at += 1;
  const refusedObject = REFUSED_OBJECTS.get(nameText(tokens[at]) ?? '');
  if (refusedObject !== undefined && !unique) return refuse(refusedObject);
  if (!isWord(tokens[at], 'index'))
    return refuse(`create ${nameText(tokens[at]) ?? '…'}: ${NOT_ON_LIST}`);
  if (isWord(tokens[at + 1], 'concurrently')) {
    return refuse(
      "create index concurrently cannot run inside the migrator's per-file transaction (TD-032 §1); write `create index`",
    );
  }
  const on = tokens.findIndex((token, index) => index > at && isWord(token, 'on'));
  const table = on === -1 ? null : readName(tokens, skipWords(tokens, on + 1, 'only'));
  if (table === null) return refuse(`a create index the scanner cannot read; ${NOT_ON_LIST}`);
  if (!file.tables.has(table.name)) {
    const call = impureCall(tokens.slice(on), file.shadowed);
    if (call !== null) {
      return refuse(
        `an index on the existing table ${table.name} evaluates ${call}() over every row at migration time; only ${PURE_CALL_LIST} may be called there`,
      );
    }
  }
  if (!unique) return admit('create index');
  return file.tables.has(table.name)
    ? admit('create unique index (on a table this file creates)')
    : refuse(
        `a unique index on the existing table ${table.name} can refuse a row the previous build writes`,
      );
};

/** The column names of the parenthesised list that opens at `at`, or `null` when it is not one. */
const columnList = (tokens: readonly SqlToken[], at: number): string[] | null => {
  const end = closeParen(tokens, at);
  if (end === null) return null;
  const names = splitTopLevel(tokens.slice(at + 1, end - 1)).map((part) =>
    part.length === 1 ? nameText(part[0]) : null,
  );
  return names.every((name): name is string => name !== null) ? names : null;
};

/**
 * C: a `check`/`foreign key … not valid` on an existing table names only columns this file added
 * there, nullable with no default, and a check is null-propagating by construction — as a refusal
 * reason, or `null`.
 */
const notValidRefusal = (
  action: readonly SqlToken[],
  kind: 'check' | 'foreign',
  table: string,
  added: ReadonlySet<string>,
): string | null => {
  const keyword = action.findIndex((token) => isWord(token, kind));
  if (kind === 'foreign') {
    const columns = isWord(action[keyword + 1], 'key') ? columnList(action, keyword + 2) : null;
    if (columns === null) return `a foreign key the scanner cannot read; ${NOT_ON_LIST}`;
    const old = columns.find((column) => !added.has(column));
    return old === undefined
      ? null
      : `the \`not valid\` foreign key on the existing table ${table} names ${old}, which this file did not add there as a nullable column with no default; PostgreSQL enforces a \`not valid\` constraint on every later write, so the previous build's rows would be refused (${AMENDMENT} C)`;
  }
  const end = closeParen(action, keyword + 1);
  if (end === null) return `a check the scanner cannot read; ${NOT_ON_LIST}`;
  return nullPropagating(action.slice(keyword + 2, end - 1), added)
    ? null
    : `the \`not valid\` check on the existing table ${table} is not null-propagating by construction over columns this file added there nullable with no default (atoms comparing one such column with literals, joined by \`and\`/\`or\`); PostgreSQL enforces it on every later write, so a row the previous build writes could be refused (${AMENDMENT} C)`;
};

const classifyAddConstraint = (
  action: readonly SqlToken[],
  sameFile: boolean,
  table: string,
  file: FileState,
): StatementVerdict => {
  if (sameFile) return admit('add constraint (on a table this file creates)');
  const words = topLevelWords(action);
  const kind = isWord(action[1], 'constraint') ? nameText(action[3]) : nameText(action[1]);
  if (
    (kind === 'check' || kind === 'foreign') &&
    words.at(-2) === 'not' &&
    words.at(-1) === 'valid'
  ) {
    const call = impureCall(action, file.shadowed);
    if (call !== null) {
      return refuse(
        `the constraint on ${table} calls ${call}(), which its \`validate constraint\` runs over every existing row; only ${PURE_CALL_LIST} may be called there`,
      );
    }
    const narrowed = notValidRefusal(
      action,
      kind,
      table,
      file.nullableAdded.get(table) ?? new Set(),
    );
    return narrowed === null
      ? admit('add constraint … not valid (over this file’s columns)')
      : refuse(narrowed);
  }
  return refuse(
    `a constraint on the existing table ${table} is additive only as \`add constraint … not valid\` (a check or a foreign key), validated by a later \`validate constraint\``,
  );
};

const classifyAddColumn = (
  action: readonly SqlToken[],
  sameFile: boolean,
  table: string,
  file: FileState,
): StatementVerdict => {
  let at = skipWords(action, 1, 'column');
  at = skipWords(action, at, 'if', 'not', 'exists');
  const column = nameText(action[at]);
  if (column === null) return refuse(`an add column the scanner cannot read; ${NOT_ON_LIST}`);
  if (sameFile) return admit('add column (on a table this file creates)');
  const words = topLevelWords(action.slice(at + 1));
  const notNull = words.some((word, index) => word === 'not' && words[index + 1] === 'null');
  if (notNull && !words.includes('default')) {
    return refuse(
      `column ${table}.${column} is not null without a default, so every insert the previous build makes fails`,
    );
  }
  for (const inline of ['primary', 'unique', 'check']) {
    if (words.includes(inline)) {
      return refuse(
        `column ${table}.${column} carries an inline ${inline === 'primary' ? 'primary key' : inline} constraint; add the column bare and the constraint as \`add constraint … not valid\``,
      );
    }
  }
  const call = impureCall(action.slice(at + 1), file.shadowed);
  if (call !== null) {
    return refuse(
      `column ${table}.${column} calls ${call}(), which PostgreSQL evaluates for the existing rows at migration time; only ${PURE_CALL_LIST} may be called in a default or generated expression`,
    );
  }
  // `if not exists` may add nothing (the column can predate the file), so it is never recorded.
  const bare =
    !notNull &&
    !words.includes('default') &&
    !words.includes('generated') &&
    at === skipWords(action, 1, 'column');
  if (bare) {
    const added = file.nullableAdded.get(table) ?? new Set<string>();
    added.add(column);
    file.nullableAdded.set(table, added);
  }
  return admit('add column (nullable or defaulted)');
};

const classifyAlterTable = (tokens: readonly SqlToken[], file: FileState): StatementVerdict => {
  let at = skipWords(tokens, 2, 'if', 'exists');
  at = skipWords(tokens, at, 'only');
  const named = readName(tokens, at);
  if (named === null) return refuse(`an alter table the scanner cannot read; ${NOT_ON_LIST}`);
  at = named.next;
  if (isPunct(tokens[at], '*')) at += 1;
  const sameFile = file.tables.has(named.name);
  const actions = splitTopLevel(tokens.slice(at));
  const verdicts = actions.map((action): StatementVerdict => {
    if (isWord(action[0], 'add')) {
      const reference = referenceRefusal(action, file, null);
      if (reference !== null) return refuse(reference);
      if (isWord(action[1], 'constraint', 'check', 'foreign')) {
        return classifyAddConstraint(action, sameFile, named.name, file);
      }
      if (isWord(action[1], 'primary', 'unique', 'exclude')) {
        return sameFile
          ? admit('add constraint (on a table this file creates)')
          : refuse(
              `${isWord(action[1], 'primary') ? 'a primary key' : `an ${nameText(action[1])}`} constraint on the existing table ${named.name} can refuse a row the previous build writes`,
            );
      }
      return classifyAddColumn(action, sameFile, named.name, file);
    }
    if (isWord(action[0], 'validate') && isWord(action[1], 'constraint')) {
      return admit('validate constraint');
    }
    return refuse(
      `alter table ${named.name} ${nameText(action[0]) ?? render(action.slice(0, 1))} … is not additive: only \`add\` and \`validate constraint\` are (TD-032 §1)`,
    );
  });
  return verdicts.find((verdict) => !verdict.additive) ?? admit('alter table … add');
};

const classifyAlterType = (
  tokens: readonly SqlToken[],
  context: AdditiveScanContext,
): StatementVerdict => {
  const named = readName(tokens, 2);
  if (
    named === null ||
    !isWord(tokens[named.next], 'add') ||
    !isWord(tokens[named.next + 1], 'value')
  ) {
    return refuse(`alter type … is additive only as \`add value\`; ${NOT_ON_LIST}`);
  }
  const at = skipWords(tokens, named.next + 2, 'if', 'not', 'exists');
  const value = tokens[at];
  if (value?.kind !== 'string')
    return refuse(`an add value the scanner cannot read; ${NOT_ON_LIST}`);
  return context.enumValueAtBase(value.text)
    ? admit('alter type … add value (already in packages/contracts at the base)')
    : refuse(
        `enum value '${value.text}' of ${named.name} is not in packages/contracts at the base commit, so the previous build cannot parse a row that carries it (TD-032 §1: land it in contracts one release earlier)`,
      );
};

/** `insert into platform_table_policy (…) values (…)` registering only this file's tables. */
const classifyTablePolicy = (tokens: readonly SqlToken[], file: FileState): StatementVerdict => {
  const named = readName(tokens, 2);
  const registry =
    'only `insert into platform_table_policy` registering a table this file creates is';
  if (named?.name !== 'platform_table_policy') return refuse(`insert: ${registry} additive`);
  const columnsEnd = closeParen(tokens, named.next);
  if (columnsEnd === null || !isWord(tokens[columnsEnd], 'values')) {
    return refuse(
      `insert into platform_table_policy without a column list and values: ${registry} additive`,
    );
  }
  const columns = splitTopLevel(tokens.slice(named.next + 1, columnsEnd - 1)).map((part) =>
    part.length === 1 ? nameText(part[0]) : null,
  );
  const position = columns.indexOf('table_name');
  if (position === -1)
    return refuse(`insert into platform_table_policy names no table_name: ${registry} additive`);
  const rows = splitTopLevel(tokens.slice(columnsEnd + 1));
  for (const row of rows) {
    const end = closeParen(row, 0);
    if (end === null || end !== row.length) {
      return refuse(
        `insert into platform_table_policy with something other than literal rows: ${registry} additive`,
      );
    }
    const values = splitTopLevel(row.slice(1, -1));
    if (!values.every(isLiteral)) {
      return refuse(
        `insert into platform_table_policy with a computed value: every value is a literal, because an expression can call any function (${registry} additive)`,
      );
    }
    const value = values[position];
    const literal = value?.length === 1 && value[0]?.kind === 'string' ? value[0].text : null;
    if (literal === null || !file.tables.has(literal)) {
      return refuse(
        `insert into platform_table_policy registers ${literal ?? 'a computed name'}, which this file does not create: ${registry} additive`,
      );
    }
  }
  return admit('insert into platform_table_policy (this file’s tables)');
};

/** The verdict on one statement; `file` accumulates the tables created so far. */
const classify = (
  statement: SqlStatement,
  context: AdditiveScanContext,
  file: FileState,
): StatementVerdict => {
  const { tokens } = statement;
  if (isWord(tokens[0], 'create')) return classifyCreate(tokens, context, file);
  if (isWord(tokens[0], 'alter') && isWord(tokens[1], 'table'))
    return classifyAlterTable(tokens, file);
  if (isWord(tokens[0], 'alter') && isWord(tokens[1], 'type'))
    return classifyAlterType(tokens, context);
  if (isWord(tokens[0], 'grant')) return admit('grant');
  if (isWord(tokens[0], 'comment') && isWord(tokens[1], 'on')) return admit('comment');
  if (isWord(tokens[0], 'insert') && isWord(tokens[1], 'into'))
    return classifyTablePolicy(tokens, file);
  return refuse(`${nameText(tokens[0]) ?? render(tokens.slice(0, 1))} …: ${NOT_ON_LIST}`);
};

/**
 * Every statement of `sql` the additive allow-list does not admit — an empty list means the file
 * is additive as far as the scanner can tell. SQL it cannot tokenize is one refusal, never a pass.
 */
export const scanAdditive = (sql: string, context: AdditiveScanContext): AdditiveRefusal[] => {
  let statements: SqlStatement[];
  try {
    statements = splitStatements(sql);
  } catch (error) {
    if (error instanceof SqlTokenizeError) {
      return [{ line: error.line, statement: '', reason: error.message }];
    }
    throw error;
  }
  // Every routine name the file defines, wherever in the file, and every one an earlier migration
  // declared: a call to any of them is refused wherever the scanner checks calls.
  const shadowed = new Set<string>();
  for (const statement of statements) {
    const routine = declaredRoutine(statement.tokens);
    if (routine !== null) shadowed.add(routine);
  }
  for (const name of context.functionSignatures.keys()) {
    shadowed.add(name.split('.').at(-1) as string);
  }
  const file: FileState = { tables: new Set(), nullableAdded: new Map(), shadowed };
  const refusals: AdditiveRefusal[] = [];
  for (const statement of statements) {
    const verdict = classify(statement, context, file);
    if (!verdict.additive) {
      refusals.push({
        line: statement.line,
        statement: describeStatement(statement),
        reason: verdict.reason,
      });
    }
  }
  return refusals;
};

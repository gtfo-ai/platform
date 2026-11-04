import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type AdditiveScanContext,
  declaredFunctionSignatures,
  PURE_CALLS,
  SqlTokenizeError,
  scanAdditive,
  splitStatements,
  tokenizeSql,
} from './migration-scanner.js';
import { migrationsDirectory } from './migrations.js';

/**
 * The additive allow-list of TD-032 decision 1, one rule at a time over fixture SQL (WP-271
 * criterion (4)), and the property the row names: nothing that drops, renames or changes a
 * column's type is ever additive, however it is spelled.
 */
const context = (overrides: Partial<AdditiveScanContext> = {}): AdditiveScanContext => ({
  enumValueAtBase: () => false,
  functionSignatures: new Map(),
  ...overrides,
});

const refusals = (sql: string, overrides: Partial<AdditiveScanContext> = {}) =>
  scanAdditive(sql, context(overrides));

const isAdditive = (sql: string, overrides: Partial<AdditiveScanContext> = {}): boolean =>
  refusals(sql, overrides).length === 0;

describe('the tokenizer', () => {
  it('drops comments, nested block comments included, and keeps literals opaque', () => {
    const tokens = tokenizeSql(
      "/* a /* nested */ drop table x */ comment on table t is 'drop table y'; -- drop table z\n",
    );
    expect(tokens.map((token) => `${token.kind}:${token.text}`)).toEqual([
      'word:comment',
      'word:on',
      'word:table',
      'word:t',
      'word:is',
      'string:drop table y',
      'punct:;',
    ]);
  });

  it('reads doubled quotes, escape strings, U& strings, quoted identifiers and dollar bodies', () => {
    const tokens = tokenizeSql(
      `'it''s' E'a\\'b' U&'d\\0061t' "Mixed""Case" $fn$ body; with 'quotes' $fn$ $$x$$ $1 1.5e3 .5`,
    );
    expect(tokens.map((token) => `${token.kind}:${token.text}`)).toEqual([
      "string:it's",
      "string:a\\'b",
      'string:d\\0061t',
      'ident:Mixed"Case',
      "dollar: body; with 'quotes' ",
      'dollar:x',
      'param:$1',
      'number:1.5e3',
      'number:.5',
    ]);
  });

  it('lower-cases a bare word and keeps a word containing $ whole', () => {
    expect(tokenizeSql('CREATE Table a$b$').map((token) => token.text)).toEqual([
      'create',
      'table',
      'a$b$',
    ]);
  });

  it('counts lines through comments, literals and bodies', () => {
    const statements = splitStatements("-- a\n/* b\n*/ select 'c\nd';\n\n$$\n$$;\ngrant x;");
    expect(statements.map((statement) => statement.line)).toEqual([3, 6, 8]);
  });

  it.each([
    ['a string literal', "select 'open"],
    ['a quoted identifier', 'select "open'],
    ['a block comment', 'select /* open'],
    ['a dollar body', 'select $tag$ open $other$'],
  ])('refuses an unterminated %s with its line', (_, sql) => {
    expect(() => tokenizeSql(`\n${sql}`)).toThrow(SqlTokenizeError);
    expect(() => tokenizeSql(`\n${sql}`)).toThrow(/^line 2: unterminated/);
  });

  it('splits statements on semicolons outside literals, and drops empty ones', () => {
    const statements = splitStatements("comment on table t is 'a;b';;\n grant x ; ");
    expect(statements).toHaveLength(2);
  });
});

describe('scanAdditive — what TD-032 §1 admits', () => {
  it('admits create table, and a plain index on any table', () => {
    expect(
      isAdditive(`
        create table if not exists public.widgets (id uuid primary key, name text not null);
        create unlogged table scratch (x int);
        create index widgets_name_idx on widgets (name);
        create index if not exists tasks_extra_idx on only public.tasks using gin (payload);
        create index on runs (status) where status = 'running';
      `),
    ).toBe(true);
  });

  it('refuses create index concurrently, which the per-file transaction cannot run', () => {
    const [refusal] = refusals('create index concurrently tasks_idx on tasks (id);');
    expect(refusal?.reason).toMatch(
      /create index concurrently cannot run inside the migrator's per-file transaction/,
    );
    expect(refusals('CREATE UNIQUE INDEX CONCURRENTLY t_idx ON t (id);')).toHaveLength(1);
  });

  it('admits a unique index only on a table the same file creates', () => {
    expect(
      isAdditive(
        "create table run_offers (task_id uuid, state text);\ncreate unique index run_offers_one_open on run_offers (task_id) where state = 'open';",
      ),
    ).toBe(true);
    expect(refusals('create unique index tasks_key on tasks (ticket_key);')[0]?.reason).toMatch(
      /a unique index on the existing table tasks can refuse a row the previous build writes/,
    );
  });

  it('admits add column when nullable or defaulted, and names the column when not', () => {
    expect(
      isAdditive(`
        alter table runs add column lease_epoch bigint not null default 0;
        alter table runs add column worker_id uuid references runs (id) on delete set null;
        alter table if exists only runs add if not exists note text collate "C";
        alter table runs add column total numeric(12, 6) generated always as (a + b) stored;
        alter table runs add column a int, add column b text default 'x';
      `),
    ).toBe(true);
    expect(refusals('alter table runs add column owner text not null;')[0]?.reason).toBe(
      'column runs.owner is not null without a default, so every insert the previous build makes fails',
    );
  });

  it('reads not null and default as keywords, never inside a quoted identifier', () => {
    expect(refusals('alter table runs add column "x default" int not null;')).toHaveLength(1);
    expect(isAdditive('alter table runs add column "not null" int;')).toBe(true);
  });

  it('refuses an inline check, unique or primary key on a new column of an existing table', () => {
    for (const inline of ['check (x > 0)', 'unique', 'primary key']) {
      expect(refusals(`alter table runs add column x int ${inline};`)[0]?.reason).toMatch(
        /carries an inline .* constraint; add the column bare and the constraint as `add constraint … not valid`/,
      );
    }
  });

  it('admits a check or foreign key added not valid, and the validate that completes it', () => {
    expect(
      isAdditive(`
        alter table platform_migrations add constraint known check (class in ('additive', 'contract')) not valid;
        alter table runs add constraint runs_worker_fk foreign key (worker_id) references workers (id) on delete set null not valid;
        alter table runs add check (x is not null) not valid;
        alter table platform_migrations validate constraint known;
      `),
    ).toBe(true);
  });

  it('refuses a validated constraint on an existing table, and unique/primary/exclude there', () => {
    expect(refusals('alter table bindings add constraint b check (x is null);')[0]?.reason).toMatch(
      /a constraint on the existing table bindings is additive only as `add constraint … not valid`/,
    );
    expect(refusals('alter table t add constraint u unique (a) not valid;')).toHaveLength(1);
    for (const kind of ['primary key (a)', 'unique (a)', 'exclude using gist (a with &&)']) {
      expect(refusals(`alter table t add ${kind};`)[0]?.reason).toMatch(
        /constraint on the existing table t can refuse a row the previous build writes/,
      );
    }
  });

  it('admits any add on a table the same file creates', () => {
    expect(
      isAdditive(`
        create table offers (id uuid);
        alter table offers add column state text not null;
        alter table offers add constraint offers_state check (state <> '');
        alter table offers add primary key (id);
      `),
    ).toBe(true);
  });

  it('admits grant and comment on', () => {
    expect(
      isAdditive(
        "grant select on widgets to platform_app;\ncomment on column runs.x is 'drop it';",
      ),
    ).toBe(true);
  });

  it('admits create view and create or replace view, never a materialized one', () => {
    expect(
      isAdditive(
        'create view v as select 1;\ncreate or replace view w as select 2;\ncreate or replace temp recursive view r (n) as select 1;',
      ),
    ).toBe(true);
    expect(refusals('create materialized view m as select 1;')[0]?.reason).toMatch(
      /^create materialized: not on TD-032's additive allow-list/,
    );
  });

  it('admits a new function, and a replacement only with the signature an earlier file declared', () => {
    const earlier = declaredFunctionSignatures([
      'create or replace function public.platform_f(p_role text, p_n int default 3) returns boolean language plpgsql as $$ begin return true; end $$;',
    ]);
    const replace = (signature: string) =>
      `create or replace function platform_f${signature} language plpgsql as $$ begin drop table x; end $$;`;
    expect(
      isAdditive(replace('(p_role text, p_n int default 3) returns boolean'), {
        functionSignatures: earlier,
      }),
    ).toBe(true);
    expect(
      isAdditive(replace('(P_ROLE TEXT, p_n INT DEFAULT 3) RETURNS BOOLEAN'), {
        functionSignatures: earlier,
      }),
    ).toBe(true);
    expect(
      refusals(replace('(p_role text) returns boolean'), { functionSignatures: earlier })[0]
        ?.reason,
    ).toMatch(
      /function platform_f was declared by an earlier migration with a different signature/,
    );
    expect(
      isAdditive(replace('(p_role text, p_n int default 3) returns integer'), {
        functionSignatures: earlier,
      }),
    ).toBe(false);
    expect(isAdditive('create function brand_new() returns void as $$ $$ language sql;')).toBe(
      true,
    );
    expect(
      isAdditive(
        'create function t() returns table (a int, b text) language sql as $$ select 1, $$;',
      ),
    ).toBe(true);
  });

  it('reads the signatures an earlier file declared, overloads included', () => {
    const declared = declaredFunctionSignatures([
      'create function f(a int) returns int as $$ select 1 $$ language sql; create function f(a text) returns setof text stable as $$ $$ language sql;',
      'do $$ begin create function g() returns int as $b$ $b$ language sql; end $$;',
    ]);
    expect([...declared.keys()]).toEqual(['f']);
    expect([...(declared.get('f') ?? [])]).toEqual([
      '( a int ) returns int',
      '( a text ) returns setof text',
    ]);
  });

  it('admits add value only when the value is in packages/contracts at the base', () => {
    const asked: string[] = [];
    const enumValueAtBase = (value: string) => {
      asked.push(value);
      return value === 'rate_limited';
    };
    expect(
      isAdditive("alter type run_status add value if not exists 'rate_limited' after 'failed';", {
        enumValueAtBase,
      }),
    ).toBe(true);
    expect(
      refusals("alter type public.run_status add value 'paused';", { enumValueAtBase })[0]?.reason,
    ).toMatch(/enum value 'paused' of run_status is not in packages\/contracts at the base commit/);
    expect(asked).toEqual(['rate_limited', 'paused']);
    expect(refusals("alter type run_status rename value 'a' to 'b';")[0]?.reason).toMatch(
      /alter type … is additive only as `add value`/,
    );
  });

  it('admits registering this file’s own tables in platform_table_policy, and nothing else', () => {
    expect(
      isAdditive(
        "create table a (x int); create table b (x int);\ninsert into platform_table_policy (table_name, app_access) values ('a', 'read_write'), ('b', 'append_only');",
      ),
    ).toBe(true);
    expect(
      refusals(
        "insert into platform_table_policy (table_name, app_access) values ('tasks', 'read_write');",
      )[0]?.reason,
    ).toMatch(/registers tasks, which this file does not create/);
    for (const sql of [
      "create table a (x int); insert into platform_table_policy values ('a');",
      "create table a (x int); insert into platform_table_policy (app_access) values ('read_write');",
      "create table a (x int); insert into platform_table_policy (table_name) values ('a') on conflict do nothing;",
      "create table a (x int); insert into platform_table_policy (table_name) select 'a';",
      "create table a (x int); insert into platform_table_policy (table_name) values (lower('A'));",
      "create table a (x int); insert into price_list (model) values ('a');",
    ]) {
      expect(isAdditive(sql), sql).toBe(false);
    }
  });

  it('refuses every other statement, naming it, with the escape stated', () => {
    for (const sql of [
      'update runs set x = 1;',
      'delete from runs;',
      'revoke all on runs from public;',
      'do $$ begin perform 1; end $$;',
      "create type t as enum ('a');",
      'create trigger t after insert on runs for each row execute function f();',
      'select platform_f();',
      'begin;',
      'set lock_timeout = 1;',
      'create or replace table t (x int);',
      'alter index i set tablespace x;',
      'alter table t;',
    ]) {
      const found = refusals(sql);
      expect(found, sql).toHaveLength(1);
    }
    expect(refusals('update runs set x = 1;')[0]?.reason).toBe(
      "update …: not on TD-032's additive allow-list; declare the file `contract; expands: <nnnn>_<name>` if it is not additive",
    );
  });

  it('locates each refusal by line and quotes the statement’s start', () => {
    expect(
      refusals('create table a (x int);\n\n  drop table b;\nalter table c rename to d;'),
    ).toEqual([
      { line: 3, statement: 'drop table b', reason: expect.stringContaining('drop …') },
      {
        line: 4,
        statement: 'alter table c rename to d',
        reason: expect.stringContaining('alter table c rename'),
      },
    ]);
  });

  it('answers SQL it cannot tokenize with one refusal, never a pass', () => {
    expect(refusals("create table a (x int);\ncomment on table a is 'open")).toEqual([
      { line: 2, statement: '', reason: 'line 2: unterminated string literal' },
    ]);
  });

  it('finds the shipped 0092 additive, and 0091 additive by the same rules', () => {
    const read = (name: string) => readFileSync(join(migrationsDirectory, name), 'utf8');
    expect(refusals(read('0092_migration_class.sql'))).toEqual([]);
    expect(refusals(read('0091_task_duty_leases.sql'))).toEqual([]);
    // 0090 adds a validated check on an existing table: a contract change by the allow-list.
    expect(refusals(read('0090_binding_account_identity.sql'))).toHaveLength(1);
  });
});

/**
 * WP-271 criterion (4): **the scanner never classifies a `drop`, `rename` or `alter column … type`
 * as additive** — whatever the case, the whitespace, the comments between the words, the quoting
 * and schema of the names, the optional clauses, and whether an admitted action shares the
 * statement or an admitted statement shares the file.
 */
describe('scanAdditive — a destructive statement is never additive (property)', () => {
  const identifier = fc.oneof(
    fc.stringMatching(/^[a-z_][a-z0-9_]{0,10}$/),
    fc
      .stringMatching(/^[A-Za-z][A-Za-z0-9_ ]{0,10}$/)
      .map((name) => `"${name.replaceAll('"', '')}"`),
  );
  const qualified = fc
    .tuple(fc.boolean(), identifier)
    .map(([schema, name]) => (schema ? `public.${name}` : name));
  const separator = fc.constantFrom(
    ' ',
    '  ',
    '\t',
    '\n',
    ' /* c */ ',
    ' /* a /* b */ c */ ',
    ' -- line\n',
    '\n-- x\n ',
  );

  /** Every word of a template with a random case, joined by random separators. */
  const spell = (parts: readonly string[]) =>
    fc
      .tuple(
        fc.array(fc.boolean(), { minLength: parts.length, maxLength: parts.length }),
        fc.array(separator, { minLength: parts.length, maxLength: parts.length }),
      )
      .map(([uppers, gaps]) =>
        parts
          .map((part, index) =>
            // A quoted identifier keeps its case; a keyword or bare name may be either.
            part.startsWith('"') || part.startsWith("'")
              ? part
              : uppers[index]
                ? part.toUpperCase()
                : part,
          )
          .reduce((text, part, index) => (index === 0 ? part : `${text}${gaps[index]}${part}`), ''),
      );

  const alterPrefix = fc
    .tuple(fc.boolean(), fc.boolean(), qualified)
    .map(([ifExists, only, table]) => [
      'alter',
      'table',
      ...(ifExists ? ['if', 'exists'] : []),
      ...(only ? ['only'] : []),
      table,
    ]);

  const destructiveAction = fc.oneof(
    fc
      .tuple(fc.boolean(), fc.boolean(), identifier, fc.constantFrom([], ['cascade'], ['restrict']))
      .map(([column, ifExists, name, tail]) => [
        'drop',
        ...(column ? ['column'] : []),
        ...(ifExists ? ['if', 'exists'] : []),
        name,
        ...tail,
      ]),
    fc.tuple(identifier).map(([name]) => ['drop', 'constraint', name]),
    fc
      .tuple(fc.boolean(), identifier, identifier)
      .map(([column, from, to]) => ['rename', ...(column ? ['column'] : []), from, 'to', to]),
    fc.tuple(identifier).map(([to]) => ['rename', 'to', to]),
    fc.tuple(identifier, identifier).map(([from, to]) => ['rename', 'constraint', from, 'to', to]),
    fc
      .tuple(
        fc.boolean(),
        identifier,
        fc.boolean(),
        fc.constantFrom('int', 'bigint', 'text', 'numeric(12, 6)', 'jsonb'),
        fc.boolean(),
      )
      .map(([column, name, setData, type, using]) => [
        'alter',
        ...(column ? ['column'] : []),
        name,
        ...(setData ? ['set', 'data'] : []),
        'type',
        type,
        ...(using ? ['using', `${name}::${type}`] : []),
      ]),
  );

  const additiveAction = fc.constantFrom(
    ['add', 'column', 'extra', 'int'],
    ['validate', 'constraint', 'c'],
    ['add', 'note', 'text'],
  );

  /** `alter table … <actions>` with one destructive action somewhere in the list. */
  const destructiveAlter = fc
    .tuple(
      alterPrefix,
      fc.array(additiveAction, { maxLength: 2 }),
      destructiveAction,
      fc.array(additiveAction, { maxLength: 2 }),
    )
    .chain(([prefix, before, destructive, after]) => {
      const actions = [...before, destructive, ...after];
      const parts = [...prefix];
      actions.forEach((action, index) => {
        parts.push(...action);
        if (index < actions.length - 1) parts.push(',');
      });
      return spell(parts);
    });

  const destructiveObject = fc
    .tuple(
      fc.constantFrom(
        'table',
        'index',
        'view',
        'materialized view',
        'type',
        'function',
        'sequence',
        'schema',
        'trigger',
        'column',
      ),
      fc.boolean(),
      qualified,
      fc.constantFrom([], ['cascade']),
    )
    .chain(([kind, ifExists, name, tail]) =>
      spell(['drop', ...kind.split(' '), ...(ifExists ? ['if', 'exists'] : []), name, ...tail]),
    );

  const renamedObject = fc
    .tuple(
      fc.constantFrom('index', 'view', 'type', 'sequence', 'function', 'schema'),
      qualified,
      identifier,
    )
    .chain(([kind, name, to]) => spell(['alter', kind, name, 'rename', 'to', to]));

  const renamedValue = fc
    .tuple(qualified, fc.stringMatching(/^[a-z]{1,6}$/), fc.stringMatching(/^[a-z]{1,6}$/))
    .chain(([type, from, to]) =>
      spell(['alter', 'type', type, 'rename', 'value', `'${from}'`, 'to', `'${to}'`]),
    );

  const retypedDomain = fc
    .tuple(qualified, identifier)
    .chain(([table, column]) => spell(['alter', 'table', table, 'alter', column, 'type', 'text']));

  const destructive = fc.oneof(
    destructiveAlter,
    destructiveObject,
    renamedObject,
    renamedValue,
    retypedDomain,
  );

  const admittedNeighbour = fc.constantFrom(
    'create table neighbour (x int)',
    "comment on table neighbour is 'drop table x'",
    'grant select on neighbour to platform_app',
    'create index neighbour_idx on neighbour (x)',
  );

  it('refuses it on its own, with or without a trailing semicolon', () => {
    fc.assert(
      fc.property(destructive, fc.boolean(), (statement, semicolon) => {
        const found = scanAdditive(
          `${statement}${semicolon ? ';' : ''}`,
          context({ enumValueAtBase: () => true }),
        );
        expect(found.length, statement).toBeGreaterThan(0);
      }),
      { numRuns: 500 },
    );
  });

  it('refuses the file when it sits among admitted statements, even with every lookup answering yes', () => {
    fc.assert(
      fc.property(
        fc.array(admittedNeighbour, { maxLength: 3 }),
        destructive,
        fc.array(admittedNeighbour, { maxLength: 3 }),
        (before, statement, after) => {
          const sql = [
            '-- migration-class: additive',
            ...before.map((s) => `${s};`),
            `${statement};`,
            ...after.map((s) => `${s};`),
          ].join('\n');
          const found = scanAdditive(sql, context({ enumValueAtBase: () => true }));
          expect(found.length, sql).toBeGreaterThan(0);
        },
      ),
      { numRuns: 300 },
    );
  });

  /**
   * Review round 1: a destructive body in a function the same file creates, reached by a statement
   * the scanner admitted. Each vector evaluates the function at migration time; every one must be
   * refused, however it is cased and spaced.
   */
  const destructiveFunction = fc
    .tuple(fc.stringMatching(/^[a-z][a-z0-9_]{0,8}$/), destructive)
    .map(([name, body]) => ({
      name,
      sql: `create function ${name}() returns text language plpgsql as $body$ begin ${body}; return 'x'; end $body$`,
    }));
  const evaluation = (name: string) =>
    fc.oneof(
      spell(['create', 'table', 'copy_t', 'as', 'select', `${name}()`]),
      spell(['alter', 'table', 'runs', 'add', 'column', 'q', 'text', 'default', `${name}()`]),
      spell([
        'alter',
        'table',
        'runs',
        'add',
        'column',
        'q',
        'text',
        'generated',
        'always',
        'as',
        `(${name}())`,
        'stored',
      ]),
      spell(['create', 'index', 'on', 'runs', `((${name}()))`]),
      spell(['create', 'index', 'on', 'runs', '(id)', 'where', `${name}()`, '=', "'x'"]),
      spell([
        'alter',
        'table',
        'runs',
        'add',
        'constraint',
        'c',
        'check',
        `(${name}()`,
        "<>'')",
        'not',
        'valid',
      ]),
      spell([
        'create',
        'table',
        'p',
        '(x int);',
        'insert',
        'into',
        'platform_table_policy',
        '(table_name,',
        'app_access)',
        'values',
        `('p', ${name}())`,
      ]),
      fc.constant(`select ${name}()`),
    );

  it('refuses every statement that evaluates a function the same file creates', () => {
    fc.assert(
      fc.property(
        destructiveFunction.chain((created) =>
          evaluation(created.name).map((evaluated) => `${created.sql};\n${evaluated};`),
        ),
        (sql) => {
          const found = scanAdditive(sql, context({ enumValueAtBase: () => true }));
          expect(found.length, sql).toBeGreaterThan(0);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('scanAdditive — “a table this file creates” cannot be forged (review round 1)', () => {
  it.each([
    ['if not exists', 'create table if not exists tasks (id int);'],
    ['IF NOT EXISTS, upper-cased', 'CREATE UNLOGGED TABLE IF NOT EXISTS public.tasks (id int);'],
  ])('%s creates nothing that is the file’s own', (_, create) => {
    for (const follow of [
      'alter table tasks add column x int not null;',
      'create unique index on tasks (x);',
      'alter table tasks add primary key (x);',
      'alter table tasks add constraint c check (x > 0);',
      "insert into platform_table_policy (table_name) values ('tasks');",
    ]) {
      expect(refusals(`${create}\n${follow}`), follow).toHaveLength(1);
    }
  });

  it.each([
    ['temp', 'create temp table tasks (id int);'],
    ['temporary', 'create temporary table tasks (id int);'],
    ['global temporary', 'create global temporary table tasks (id int);'],
    ['local temp', 'create local temp table tasks (id int);'],
  ])('refuses a %s table, which shadows a permanent one of its name', (_, create) => {
    const found = refusals(`${create}\nalter table public.tasks add column x int not null;`);
    expect(found[0]?.reason).toMatch(/^a migration creates no temporary table/);
    expect(found).toHaveLength(2);
  });

  it('still makes a plainly created table the file’s own, qualified or not', () => {
    expect(
      isAdditive(
        'create table public.offers (id uuid generated always as identity);\nalter table offers add column state text not null;\ncreate unique index on public.offers (state);',
      ),
    ).toBe(true);
  });
});

describe('scanAdditive — nothing evaluated at migration time calls a function (review round 1)', () => {
  const withF =
    'create function zz() returns int language plpgsql as $$ begin drop table tasks; return 1; end $$;\n';

  it.each([
    ['create table … as', 'create table t2 as select zz();', /create table t2 … as runs a query/],
    [
      'create table (columns) as',
      'create table t2 (a) as select zz();',
      /create table t2 … as runs a query/,
    ],
    ['a default', 'alter table runs add column q int default zz();', /calls zz\(\)/],
    [
      'a qualified default',
      'alter table runs add column q int default public.zz();',
      /calls public\.zz\(\)/,
    ],
    ['a quoted default', 'alter table runs add column q int default "zz"();', /calls zz\(\)/],
    [
      'a generated column',
      'alter table runs add column q int generated always as (zz()) stored;',
      /calls zz\(\)/,
    ],
    ['an index expression', 'create index on runs ((zz()));', /evaluates zz\(\) over every row/],
    [
      'an index predicate',
      'create index on runs (id) where zz() = 1;',
      /evaluates zz\(\) over every row/,
    ],
    [
      'a not-valid check its validate runs',
      'alter table runs add constraint c check (zz() = 1) not valid;',
      /calls zz\(\), which its `validate constraint` runs/,
    ],
    [
      'a computed policy value',
      "create table n (id int); insert into platform_table_policy (table_name, app_access) values ('n', zz());",
      /with a computed value/,
    ],
  ])('refuses %s', (_, statement, reason) => {
    const found = refusals(`${withF}${statement}`);
    expect(found).toHaveLength(1);
    expect(found[0]?.reason).toMatch(reason);
  });

  it('admits the builtins, type modifiers, keywords and referenced tables that are not calls', () => {
    expect(
      isAdditive(`
        alter table runs add column a timestamptz not null default now();
        alter table runs add column b uuid default gen_random_uuid();
        alter table runs add column c numeric(12, 6) generated always as (coalesce(x, 0)) stored;
        alter table runs add column d uuid references public.workers (id);
        alter table runs add constraint e check (lower(f) in ('a', 'b')) not valid;
        alter table runs add constraint g foreign key (h) references workers (id) not valid;
        create index on only public.runs using gin ((lower(name)));
        create table n (id int default zz());
        insert into platform_table_policy (table_name, app_access, retention_days) values ('n', 'read_write', null);
      `),
    ).toBe(true);
  });
});

describe('scanAdditive — review round 2: overloads, child tables, computed values, impure builtins', () => {
  it.each([
    [
      'lower',
      'create function lower(integer) returns integer language sql as $$ delete from tasks; select 1 $$;\nalter table tasks add column z int default lower(1);',
    ],
    [
      'length',
      'create function length(integer) returns integer language sql as $$ delete from tasks; select 1 $$;\ncreate index i on tasks (length(1));',
    ],
    [
      'upper, schema-qualified',
      'create or replace function public.upper(int) returns int language sql as $$ delete from tasks; select 1 $$;\nalter table tasks add constraint c check (upper(1) = 1) not valid;',
    ],
  ])('refuses an overload of the builtin %s, and the call that would reach it', (_, sql) => {
    const found = refusals(sql);
    expect(found).toHaveLength(2);
    expect(found[0]?.reason).toMatch(/shares its name with a builtin/);
    expect(found[1]?.reason).toMatch(/calls (lower|length|upper)\(\)|evaluates length\(\)/);
  });

  it('refuses a call to any routine the file or an earlier migration defines, whatever its name', () => {
    expect(
      refusals(
        'alter table tasks add column z int default platform_f(1);\ncreate procedure platform_f(int) language sql as $$ delete from tasks $$;',
      ).map((refusal) => refusal.reason),
    ).toEqual([
      expect.stringMatching(/calls platform_f\(\)/),
      expect.stringMatching(/^create procedure/),
    ]);
    const earlier = declaredFunctionSignatures([
      'create function coalesce_rows(int) returns int language sql as $$ select 1 $$;',
    ]);
    expect(
      refusals('create index on tasks ((coalesce_rows(1)));', { functionSignatures: earlier }),
    ).toHaveLength(1);
  });

  it('refuses a call to a builtin name an earlier migration overloaded (review round 3)', () => {
    const earlier = declaredFunctionSignatures([
      'create function lower(integer) returns integer language sql as $$ delete from tasks; select 1 $$;',
    ]);
    expect(
      refusals('alter table tasks add column z int default lower(1);', {
        functionSignatures: earlier,
      }),
    ).toHaveLength(1);
    expect(refusals("alter table tasks add column z text default lower('A');")).toEqual([]);
  });

  it('pins the builtins an evaluated expression may call, so the list cannot grow silently', () => {
    expect([...PURE_CALLS].sort()).toEqual([
      'abs',
      'array_length',
      'btrim',
      'cardinality',
      'char_length',
      'clock_timestamp',
      'coalesce',
      'date_trunc',
      'gen_random_uuid',
      'greatest',
      'jsonb_array_length',
      'jsonb_typeof',
      'least',
      'length',
      'lower',
      'now',
      'nullif',
      'octet_length',
      'statement_timestamp',
      'transaction_timestamp',
      'upper',
      'uuidv7',
    ]);
  });

  it.each([
    [
      'partition of',
      "create table pgboss.j_x partition of pgboss.job for values in ('q');",
      'pgboss.j_x',
    ],
    ['inherits', 'create table tasks_child (extra int) inherits (tasks);', 'tasks_child'],
  ])('never makes a %s table the file’s own: the parent’s inserts reach it', (_, create, child) => {
    for (const follow of [
      `alter table ${child} add constraint c check (false);`,
      `create unique index on ${child} (id);`,
      `alter table ${child} add primary key (id);`,
      `alter table ${child} add column z int not null;`,
    ]) {
      expect(refusals(`${create}\n${follow}`), follow).toHaveLength(1);
    }
  });

  it.each([
    ["('n' || zz())", "('n', 'n' || 'x')"],
    ["('n', ('read_write'))", "('n', ('read_write'))"],
    ["('n', 'read' || 'write')", "('n', 'read' || 'write')"],
    ["('n', -1)", "('n', 'read_write', -1)"],
  ])('refuses a policy value that is not one literal token: %s', (_, row) => {
    const columns =
      row.split(',').length === 3
        ? '(table_name, app_access, retention_days)'
        : '(table_name, app_access)';
    expect(
      refusals(
        `create table n (id int);\ninsert into platform_table_policy ${columns} values ${row};`,
      )[0]?.reason,
    ).toMatch(/with a computed value/);
  });

  it.each([
    'pg_sleep(1)',
    "nextval('s')",
    "set_config('a', 'b', false)",
    'pg_advisory_lock(1)',
    "lo_import('/etc/passwd')",
    "dblink_exec('x')",
  ])('refuses the impure builtin %s wherever a call is checked', (call) => {
    expect(refusals(`alter table tasks add column z text default ${call};`)).toHaveLength(1);
    expect(refusals(`create index on tasks ((${call}));`)).toHaveLength(1);
    expect(
      refusals(`alter table tasks add constraint c check (${call} is null) not valid;`),
    ).toHaveLength(1);
  });
});

/**
 * The `'error'` listener every pool carries, from both sides, plus the census that keeps it true.
 *
 * No connection is opened here: `new pg.Pool` is lazy, so the pool `createDatabasePool` returns can
 * be handed the exact event pg-pool would have emitted. That is the whole surface — what this file
 * cannot show is that PostgreSQL really sends `57P01` under a forced drop, which is measured for
 * real in `test/integration/support/postgres.integration.test.ts`.
 */

import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LogFields, Logger } from '@platform/application';
import { describe, expect, it } from 'vitest';
import { censusFiles } from '../../../../scripts/census-files.mjs';
import { createDatabasePool } from './client.js';
import { CONNECTION_LOSS_CODES, errorCode, isConnectionLoss } from './pool-errors.js';

interface Line {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly fields: LogFields;
  readonly message: string;
}

const recordingLogger = (): { logger: Logger; lines: Line[] } => {
  const lines: Line[] = [];
  const at =
    (level: Line['level']) =>
    (fields: LogFields, message: string): void => {
      lines.push({ level, fields, message });
    };
  return {
    lines,
    logger: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') },
  };
};

const config = {
  url: 'postgres://platform:not-a-real-password@127.0.0.1:5432/platform',
  appRole: '',
  poolMax: 2,
  connectionTimeoutMs: 1000,
  partitionMonthsAhead: 3,
  transcriptRetentionDays: null,
} as const;

const databaseError = (code: string): Error => Object.assign(new Error(`boom ${code}`), { code });

describe('the pool a runtime is built on', () => {
  it("throws an 'error' event that nobody listens for — the premise the listener exists for", () => {
    // Not a test of our code: a statement of the Node semantics the whole fix rests on. If this
    // ever stops being true, the listener below is decoration rather than a guard.
    const bare = new EventEmitter();
    expect(() => bare.emit('error', databaseError('57P01'))).toThrow('boom 57P01');
  });

  it('reports a terminated idle connection as a warning and does not throw', () => {
    const { logger, lines } = recordingLogger();
    const handle = createDatabasePool(config, logger);

    // Exactly what pg-pool's `makeIdleListener` re-emits after a `drop database … with (force)`
    // reaches an idle client, down to the dead client hanging off the error.
    const error = Object.assign(databaseError('57P01'), { client: { database: 'x' } });
    expect(() => handle.pool.emit('error', error)).not.toThrow();

    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe('warn');
    expect(lines[0]?.fields).toMatchObject({ code: '57P01' });
    expect(lines[0]?.message).toContain('closed by the server');
  });

  it('reports a code it does not recognise at error level — the other side of the boundary', () => {
    const { logger, lines } = recordingLogger();
    const handle = createDatabasePool(config, logger);

    expect(() => handle.pool.emit('error', databaseError('42P01'))).not.toThrow();

    expect(lines).toHaveLength(1);
    // The false branch of `isConnectionLoss` has a meaning: nobody dies for it, but it is not
    // filed away as routine either. A test asserting only "did not throw" would pass with the
    // classification deleted.
    expect(lines[0]?.level).toBe('error');
    expect(lines[0]?.fields).toMatchObject({ code: '42P01' });
    expect(lines[0]?.message).toContain('unrecognised');
  });

  it('recognises loss of a connection by code, and nothing else', () => {
    // Derived from the constant, not restated beside it (standing rule 68): a hand-written list is
    // a second place to forget a code, and it already had forgotten `ETIMEDOUT`. The two anchors
    // keep the loop from going vacuous if the set is ever emptied or gutted.
    expect(CONNECTION_LOSS_CODES.size).toBeGreaterThanOrEqual(8);
    expect(CONNECTION_LOSS_CODES.has('57P01')).toBe(true);
    for (const code of CONNECTION_LOSS_CODES) {
      expect(isConnectionLoss(databaseError(code))).toBe(true);
    }
    for (const code of ['42P01', '23505', '53300', '']) {
      expect(isConnectionLoss(databaseError(code))).toBe(false);
    }
    // An error with no `code` at all is not a connection loss, and does not blow up the classifier.
    expect(isConnectionLoss(new Error('no code'))).toBe(false);
    expect(isConnectionLoss(null)).toBe(false);
    expect(errorCode(new Error('no code'))).toBeUndefined();
    expect(errorCode({ code: 7 })).toBeUndefined();
  });
});

/**
 * A pool built anywhere else is a pool with no listener, and one of those failed a CI job.
 *
 * Two files may construct one — the runtime factory above, and the test harness's
 * `createTestPool`, which attaches a *stricter* listener for a reason stated at its own line.
 * Anything else is refused here.
 *
 * ## Which files it reads, and the entry-10 hole it does not repeat
 *
 * Both `git ls-files` **and** `git ls-files --others --exclude-standard`: the tracked set plus the
 * untracked-but-not-ignored one. The decision in one line — *an ignored file is not a source file,
 * and an untracked one is* — because the opposite rule is how backlog entry 10 got its name: a
 * guard that reads only the tracked set is blind to the file somebody is writing right now, which
 * is exactly the file a new mistake is in. It bit this census on its first day (rule 59: a guard
 * that reads the repository's own sources has itself inside its scope, and that is where it fails
 * first) — every pre-commit run was green because the new files were untracked. Since WP-68 the
 * list, and what happens to a path that vanished or cannot be read, are `scripts/census-files.mjs`'s,
 * the one helper every census in the repository reads through.
 *
 * ## The spellings it catches, and the ones it cannot
 *
 * It is a regex over file text, so what it catches is the `new` operator, whitespace, an optional
 * `pg.` qualifier, the identifier `Pool` and an opening parenthesis — written out here rather than
 * shown, because a docblock that reproduced the matched form would match itself, which is how this
 * file first failed its own census. The proof that the pattern still bites is the planted-file
 * case below, not this sentence. What it does **not** see:
 *
 *  - **an aliased import** — `import { Pool as Connections } from 'pg'` then `new Connections(…)`,
 *    or `const P = pg.Pool` then `new P(…)`;
 *  - **a pool built by something else's factory** — `drizzle`'s, a fixture helper's, or any
 *    function that returns a pool it constructed behind the name of a variable;
 *  - **a constructor reached reflectively** — `Reflect.construct` on the class, or a computed
 *    member access that spells the name as a string;
 *  - **a pool that arrives from outside this repository** — a dependency that opens its own, which
 *    is why `createEventing` and pg-boss are handed one rather than allowed to make one.
 *
 * Each of those is a way to build an unguarded pool that this test would call clean. The census is
 * a floor against the accident — somebody copying a nearby line — not a proof, and the guarantee
 * that actually holds is the one at the factory: a pool built there always has a listener.
 */
const POOL_SITES_ALLOWED = new Set([
  'packages/infrastructure/src/db/client.ts',
  'test/integration/support/postgres.ts',
]);

const POOL_CONSTRUCTION = /new\s+(?:pg\.)?Pool\s*\(/;
const SOURCE_FILE = /\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/;

/** The census itself, so the repository and a planted fixture are judged by the same function. */
const poolSites = (root: string): string[] =>
  // The list, the vanished-path rule and the unreadable-path report are the one census helper's
  // (`scripts/census-files.mjs`, WP-68): tracked plus untracked-but-not-ignored, a path that
  // disappeared since the listing dropped, and one that cannot be read named in a throw.
  censusFiles(root, { include: (path) => SOURCE_FILE.test(path) })
    .filter(({ contents }) => POOL_CONSTRUCTION.test(contents))
    .map(({ path }) => path);

describe('the census that keeps every pool guarded', () => {
  it('finds no unguarded pool construction in a source file of this repository', () => {
    const root = new URL('../../../../', import.meta.url).pathname;
    const found = poolSites(root);

    // A positive anchor: if the pattern stopped matching anything, the assertion below would be
    // vacuously green (standing rule 10).
    expect(found).not.toHaveLength(0);
    expect(found.filter((path) => !POOL_SITES_ALLOWED.has(path)).sort()).toEqual([]);
  });

  it('names a planted pool whether it is tracked or merely untracked, and skips an ignored one', () => {
    // The positive proof, run against a repository built for it rather than against prose. Three
    // files, one of each kind, so the untracked case and the ignored case are each other's control:
    // "reads untracked files" and "reads everything on disk" are different guards, and only one of
    // them is wanted.
    const root = mkdtempSync(join(tmpdir(), 'pool-census-'));
    try {
      const git = (...args: string[]): void => {
        execFileSync('git', args, { cwd: root, stdio: 'ignore' });
      };
      git('init', '-q');
      writeFileSync(join(root, '.gitignore'), 'ignored.ts\n');
      // Assembled rather than written out: a literal of the matched form would make *this* file a
      // pool site when the case above reads it, which is the exact way this census first failed.
      const planted = `import pg from 'pg';\nexport const p = new pg.${'Pool'}({});\n`;
      for (const name of ['tracked.ts', 'untracked.ts', 'ignored.ts']) {
        writeFileSync(join(root, name), planted);
      }
      git('add', 'tracked.ts', '.gitignore');

      expect(poolSites(root).sort()).toEqual(['tracked.ts', 'untracked.ts']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * A bare client built anywhere else is a client nobody listens to, and backlog 30 measured what
 * that costs: a connected `pg.Client` with no `'error'` listener and no pool anywhere raises a
 * forced drop's `57P01` as an **uncaught exception** (`postgres.integration.test.ts` holds the
 * measurement). "Every client is ended" is a dataflow question no census can answer, so the
 * question is moved to where a grep can answer it: the test harness **owns** a bare client —
 * `createTestClient` attaches the listener at construction and `withClient` owns a scoped one's
 * lifetime — and this census refuses a construction anywhere else.
 *
 * Four files may construct one, each for the reason beside it. Two are production and were
 * accounted for when backlog 30 was filed: the broadcast adapter's client carries its error
 * through the `onError` seam the notification client wires, and the migrator's ends in a
 * `finally` and carries **no** listener, which is backlog 30's labelled hypothesis (a failover
 * mid-migration would end the migrate container untyped), recorded rather than changed here.
 *
 * It reads what the pool census reads, through the same helper. What it catches: the `new`
 * operator followed by the `pg`-qualified `Client` constructor, and a **named import** of `Client`
 * from `pg` in any spelling (`as` included), since a file that imports the class by name has no
 * other use for it. What it does **not** see — the pool census's list, one level down:
 *
 *  - **an alias of the qualified name** — the class assigned to a variable, then constructed;
 *  - **`pg.native`'s client**, or a client reached reflectively (`Reflect.construct`, a computed
 *    member access spelling the name as a string);
 *  - **a client built by something else** — a dependency that opens its own (pg-boss, drizzle's
 *    drivers), or a helper returning one it constructed behind a variable name;
 *  - **a default import renamed** — `import postgres from 'pg'` then the qualified constructor
 *    under that name.
 *
 * A floor against the accident — somebody copying a nearby line — not a proof.
 */
const CLIENT_SITES_ALLOWED = new Map([
  ['test/integration/support/postgres.ts', 'createTestClient, which attaches the listener'],
  [
    'test/integration/support/postgres.integration.test.ts',
    'measures the premise, so it builds the unguarded client this census refuses',
  ],
  ['packages/infrastructure/src/broadcast/postgres-broadcast.ts', 'errors reach the onError seam'],
  ['packages/infrastructure/src/db/migrator.ts', 'ends in a finally; no listener (backlog 247)'],
]);

// Assembled, like the pool census's plant, so neither pattern matches this file's own text.
// Spellings it cannot see (review round 1): a default-plus-named import (`import pg, { Client }
// from 'pg'`), a destructure (`const { Client } = pg`), and any construction through a variable.
const CLIENT_CONSTRUCTION = new RegExp(`new\\s+pg\\s*\\.\\s*${'Client'}\\s*\\(`);
const CLIENT_NAMED_IMPORT = new RegExp(
  `import\\s+(?:type\\s+)?\\{[^}]*\\b${'Client'}\\b[^}]*\\}\\s*from\\s*['"]${'pg'}['"]`,
);

const clientSites = (root: string): string[] =>
  censusFiles(root, { include: (path) => SOURCE_FILE.test(path) })
    .filter(
      ({ contents }) => CLIENT_CONSTRUCTION.test(contents) || CLIENT_NAMED_IMPORT.test(contents),
    )
    .map(({ path }) => path);

describe('the census that keeps every bare client owned by the harness', () => {
  it('finds no bare client constructed outside the files that account for one', () => {
    const root = new URL('../../../../', import.meta.url).pathname;
    const found = clientSites(root);

    // Both anchors: the harness factory is found (so the pattern bites) and every allowed entry
    // still constructs one (so the list cannot rot into permission for nothing).
    expect(found).toContain('test/integration/support/postgres.ts');
    expect([...CLIENT_SITES_ALLOWED.keys()].filter((path) => !found.includes(path))).toEqual([]);
    expect(
      found
        .filter((path) => !CLIENT_SITES_ALLOWED.has(path))
        .map((path) => `${path} constructs a bare pg client; use createTestClient or withClient`)
        .sort(),
    ).toEqual([]);
  });

  it('names a planted client whether it is tracked or merely untracked, and skips an ignored one', () => {
    const root = mkdtempSync(join(tmpdir(), 'client-census-'));
    try {
      const git = (...args: string[]): void => {
        execFileSync('git', args, { cwd: root, stdio: 'ignore' });
      };
      git('init', '-q');
      writeFileSync(join(root, '.gitignore'), 'ignored.ts\n');
      const constructed = `import pg from 'pg';\nexport const c = new pg.${'Client'}({});\n`;
      const imported = `import { ${'Client'} as Bare } from '${'pg'}';\nexport const c = new Bare();\n`;
      writeFileSync(join(root, 'tracked.ts'), constructed);
      writeFileSync(join(root, 'untracked.ts'), constructed);
      writeFileSync(join(root, 'aliased.ts'), imported);
      writeFileSync(join(root, 'ignored.ts'), constructed);
      // The control for the pattern itself: an HTTP test client of the same name is not pg's.
      writeFileSync(join(root, 'http.ts'), `export const c = new ${'Client'}('http://x');\n`);
      git('add', 'tracked.ts', '.gitignore');

      expect(clientSites(root).sort()).toEqual(['aliased.ts', 'tracked.ts', 'untracked.ts']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

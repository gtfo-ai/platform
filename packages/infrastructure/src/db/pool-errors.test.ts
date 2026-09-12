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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LogFields, Logger } from '@platform/application';
import { describe, expect, it } from 'vitest';
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
 * first) — every pre-commit run was green because the new files were untracked.
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

const gitPaths = (root: string, args: readonly string[]): string[] =>
  execFileSync('git', [...args, '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter((path) => SOURCE_FILE.test(path));

/** Every source file git knows about and does not ignore, tracked or not. */
const censusFiles = (root: string): string[] => [
  ...gitPaths(root, ['ls-files']),
  ...gitPaths(root, ['ls-files', '--others', '--exclude-standard']),
];

/** The census itself, so the repository and a planted fixture are judged by the same function. */
const poolSites = (root: string): string[] =>
  censusFiles(root).filter((path) => {
    const full = join(root, path);
    // A path can disappear between `ls-files` and here (a concurrent editor, a temp file); a
    // census that crashed on that would be a census people turn off.
    return existsSync(full) && POOL_CONSTRUCTION.test(readFileSync(full, 'utf8'));
  });

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

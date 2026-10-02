/**
 * The one-off re-read of `patterns` readings (WP-121, TD-012's M7 amendment (1), PROGRESS backlog
 * 359): a bounded pass, every outcome of a re-read, and a loop that ends. The table half is
 * `test/integration/config/repository-config-store.integration.test.ts`; the upgrade, end to end
 * over a real mirror, is `test/integration/config/prompt-reread.integration.test.ts`.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import type { Logger } from '../ports/logger.js';
import {
  PATTERN_REREAD_BATCH,
  rereadPatternReadings,
  startPatternReadingReread,
} from './prompt-reread.js';
import {
  PATTERN_READING_WITHHELD_REASON,
  type PatternReadingStore,
  type ProjectBindingSecrets,
  type PromptsWithheld,
  type RepositoryConfigRefresh,
} from './repository-config.js';

const id = (n: number): Id =>
  `00000000-0000-4000-8000-0000000012${String(n).padStart(2, '0')}` as Id;
const SHA = 'a'.repeat(40);
const AT = '2026-10-02T09:00:00.000Z' as IsoDateTime;

const recorded: RepositoryConfigRefresh = {
  status: 'recorded',
  snapshot: { status: 'absent', commitSha: SHA, readAt: AT },
  promptsWithheld: null,
};

/** A table of `patterns` rows the re-read turns `exact` — what the SQL adapter does, in memory. */
const tableOf = (ids: readonly Id[]) => {
  const patterns = new Set(ids);
  const withheld = new Map<Id, PromptsWithheld>();
  const asked: { limit: number; excluding: readonly Id[] }[] = [];
  const store: PatternReadingStore = {
    patternReadings: async (limit, excluding) => {
      asked.push({ limit, excluding: [...excluding] });
      return [...patterns].filter((project) => !excluding.includes(project)).slice(0, limit);
    },
    withholdPatternReading: async (projectId, record) => {
      if (patterns.has(projectId)) withheld.set(projectId, record);
    },
  };
  return { patterns, withheld, asked, store };
};

const noCredentials = async () => ({ secrets: [], unreadable: [] });

const lines: { level: string; message: string }[] = [];
const logger: Logger = {
  debug: (_fields, message) => lines.push({ level: 'debug', message }),
  info: (_fields, message) => lines.push({ level: 'info', message }),
  warn: (_fields, message) => lines.push({ level: 'warn', message }),
  error: (_fields, message) => lines.push({ level: 'error', message }),
};

describe('one pass over the patterns readings (WP-121)', () => {
  it('re-reads each, records why one could not be read, and never throws for one', async () => {
    const table = tableOf([id(1), id(2), id(3), id(4)]);
    const pass = await rereadPatternReadings(
      {
        store: table.store,
        refresh: async ({ projectId, overPatternsOnly }) => {
          // The pass always asks for the conditional write (review round 1).
          expect(overPatternsOnly).toBe(true);
          if (projectId === id(1)) {
            table.patterns.delete(projectId);
            return recorded;
          }
          if (projectId === id(2)) {
            return { status: 'unavailable', reason: 'no mirror: token SECRET-ish\nsecond line' };
          }
          if (projectId === id(3)) {
            // A `patterns` row's snapshot carries its withheld record (`snapshotOfRow`); a stale
            // answer over **that** is a failure (round 2: over an `exact` row it is done).
            return {
              status: 'stale',
              snapshot: {
                status: 'absent',
                commitSha: SHA,
                readAt: AT,
                promptsWithheld: { reason: 'patterns', integrations: [] },
              },
            };
          }
          throw new Error('the secret store is unreachable');
        },
        credentials: noCredentials,
        redactText: (value) => value.replaceAll('SECRET-ish', '[REDACTED]'),
        logger,
      },
      [],
    );
    expect(pass).toEqual({ reread: [id(1)], failed: [id(2), id(3), id(4)], more: false });
    const reasonOf = (n: number) => table.withheld.get(id(n))?.reason ?? '';
    expect(table.withheld.has(id(1))).toBe(false);
    // Platform sentence first, then the cause — redacted, on one line.
    expect(reasonOf(2)).toBe(
      `${PATTERN_READING_WITHHELD_REASON}. It could not be read again: no mirror: token [REDACTED] second line`,
    );
    expect(reasonOf(3)).toContain(`older than the stored reading's commit ${SHA}`);
    expect(reasonOf(4)).toContain('It could not be read again: the secret store is unreachable');
    expect(table.withheld.get(id(2))?.integrations).toEqual([]);
  });

  it('takes a bounded batch, skips what it is told to, and says when the batch was full', async () => {
    const table = tableOf([id(1), id(2), id(3)]);
    const refresh = async ({ projectId }: { readonly projectId: Id }) => {
      table.patterns.delete(projectId);
      return recorded;
    };
    const first = await rereadPatternReadings(
      {
        store: table.store,
        refresh,
        credentials: noCredentials,
        redactText: (v) => v,
        logger,
        limit: 2,
      },
      [id(9)],
    );
    expect(first).toEqual({ reread: [id(1), id(2)], failed: [], more: true });
    expect(table.asked).toEqual([{ limit: 2, excluding: [id(9)] }]);
    expect(PATTERN_REREAD_BATCH).toBeGreaterThan(0);
  });
});

/** WP-121 review round 1: the stored failure is published, so it gets both redaction steps. */
describe('a failure reason, as it is stored (WP-121 review round 1)', () => {
  const CREDENTIAL = 'FAKE-wp121-round1-credential-in-git-output-01';
  const fail = async (credentials: () => Promise<ProjectBindingSecrets>) => {
    const table = tableOf([id(1), id(2)]);
    const pass = await rereadPatternReadings(
      {
        store: table.store,
        refresh: async ({ projectId }) =>
          projectId === id(2)
            ? { status: 'superseded' }
            : { status: 'unavailable', reason: `fatal: could not read from ${CREDENTIAL}@host` },
        credentials,
        redactText: (value) => value,
        logger,
      },
      [],
    );
    return { pass, reason: table.withheld.get(id(1))?.reason ?? '' };
  };

  it('replaces a credential the platform holds by its placeholder, and counts a superseded row as done', async () => {
    const { pass, reason } = await fail(async () => ({
      secrets: [{ name: 'gitlab:a1:token', value: CREDENTIAL }],
      unreadable: [],
    }));
    expect(pass).toEqual({ reread: [id(2)], failed: [id(1)], more: false });
    expect(reason).not.toContain(CREDENTIAL);
    expect(reason).toContain(
      'fatal: could not read from [REDACTED:integration:gitlab:a1:token]@host',
    );
  });

  it('counts a stale answer over an exact row as done, and over a patterns row as failed (WP-121 round 2)', async () => {
    const table = tableOf([id(1), id(2)]);
    const pass = await rereadPatternReadings(
      {
        store: table.store,
        refresh: async ({ projectId }) =>
          projectId === id(1)
            ? // An index run recorded an `exact` reading before this pass read the row.
              { status: 'stale', snapshot: { status: 'absent', commitSha: SHA, readAt: AT } }
            : {
                status: 'stale',
                snapshot: {
                  status: 'absent',
                  commitSha: SHA,
                  readAt: AT,
                  promptsWithheld: { reason: 'patterns', integrations: [] },
                },
              },
        credentials: noCredentials,
        redactText: (value) => value,
        logger,
      },
      [],
    );
    expect(pass).toEqual({ reread: [id(1)], failed: [id(2)], more: false });
  });

  it('stores no cause at all when the credentials cannot all be read, or not read at all', async () => {
    for (const credentials of [
      async () => ({ secrets: [], unreadable: [{ integration: 'i', reason: 'old key' }] }),
      async (): Promise<ProjectBindingSecrets> => {
        throw new Error('the secret store is down');
      },
    ]) {
      const { reason } = await fail(credentials);
      expect(reason).not.toContain(CREDENTIAL);
      expect(reason).toContain('the cause is not recorded');
    }
  });
});

describe('the passes, until nothing is left to try (WP-121)', () => {
  it('ends after the first pass that is not full, never asking twice for a project it touched', async () => {
    // Project 2's re-read "succeeds" but its row stays `patterns` (a writer that did not mark it):
    // the loop must still end, because it excludes every project it touched.
    const table = tableOf([id(1), id(2), id(3), id(4), id(5)]);
    let reads = 0;
    const loop = startPatternReadingReread({
      store: table.store,
      refresh: async ({ projectId }) => {
        reads += 1;
        if (projectId === id(5)) return { status: 'unavailable', reason: 'gone' };
        if (projectId !== id(2)) table.patterns.delete(projectId);
        return recorded;
      },
      credentials: noCredentials,
      redactText: (v) => v,
      logger,
      limit: 2,
      pauseMs: 0,
    });
    await loop.settled;
    expect(reads).toBe(5);
    expect(table.asked.map((call) => call.excluding)).toEqual([
      [],
      [id(1), id(2)],
      [id(1), id(2), id(3), id(4)],
    ]);
    expect([...table.withheld.keys()]).toEqual([id(5)]);
    await loop.stop();
  });

  it('stops during its pause rather than waiting it out', async () => {
    const table = tableOf([id(1), id(2), id(3)]);
    const loop = startPatternReadingReread({
      store: table.store,
      refresh: async ({ projectId }) => {
        table.patterns.delete(projectId);
        return recorded;
      },
      credentials: noCredentials,
      redactText: (v) => v,
      logger,
      limit: 1,
      pauseMs: 3_600_000,
    });
    // Let the first pass finish and the hour-long pause begin.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const started = Date.now();
    await loop.stop();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(table.patterns.size).toBe(2);
  });

  it('logs at error and ends when the store itself fails, withholding stays the read side’s', async () => {
    lines.length = 0;
    const loop = startPatternReadingReread({
      store: {
        patternReadings: async () => {
          throw new Error('connection refused');
        },
        withholdPatternReading: async () => {},
      },
      refresh: async () => recorded,
      credentials: noCredentials,
      redactText: (v) => v,
      logger,
    });
    await loop.settled;
    expect(lines.filter((line) => line.level === 'error').map((line) => line.message)).toEqual([
      expect.stringContaining('re-read of pattern-redacted repository readings stopped'),
    ]);
  });
});

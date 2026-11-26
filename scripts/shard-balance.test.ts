import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { TestSpecification, Vitest } from 'vitest/node';
import config from '../vitest.config.js';
import { BalancedSequencer, SHARD_TIMINGS_PATH } from './balanced-sequencer.js';
import {
  assignParts,
  estimateParts,
  fileKey,
  parseVitestLog,
  refreshedTimings,
  type ShardFile,
  type ShardTimings,
  UNKNOWN_FILE_MS,
} from './shard-balance.js';

const fixture = (files: Record<string, number>, workers = 3): ShardTimings => ({
  source: { run: '1', retrieved: '2026-11-26' },
  workers,
  projects: {
    unit: { overheadMs: 0 },
    contract: { overheadMs: 0 },
    process: { overheadMs: 0, serial: true },
    'e2e-fake-claude': { overheadMs: 0 },
  },
  files,
});

const file = (key: string): ShardFile => ({ key, project: key.slice(0, key.indexOf(':')) });

const keysOf = (parts: readonly (readonly ShardFile[])[]) =>
  parts.map((part) => part.map((entry) => entry.key));

/** Every key of `files` in exactly one part, and nothing else in any part. */
const expectPartition = (files: readonly ShardFile[], parts: readonly (readonly ShardFile[])[]) => {
  const assigned = parts.flat().map((entry) => entry.key);
  expect(new Set(assigned).size, 'no file is in two parts').toBe(assigned.length);
  expect([...assigned].sort()).toEqual(files.map((entry) => entry.key).sort());
};

const TABLE = JSON.parse(readFileSync(SHARD_TIMINGS_PATH, 'utf8')) as ShardTimings;

describe('the duration-balanced split', () => {
  it('gives every file exactly one part, for any files, any table and any part count', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.record({
            project: fc.constantFrom('unit', 'contract', 'process', 'e2e-fake-claude', 'new'),
            path: fc.stringMatching(/^[a-z]{1,6}\/[a-z]{1,6}\.test\.ts$/),
            ms: fc.option(fc.nat({ max: 300_000 }), { nil: undefined }),
          }),
          { selector: (entry) => `${entry.project}:${entry.path}`, maxLength: 60 },
        ),
        fc.integer({ min: 1, max: 6 }),
        (entries, count) => {
          const files = entries.map((entry) => file(fileKey(entry.project, entry.path)));
          const timings = fixture(
            Object.fromEntries(
              entries
                .filter((entry) => entry.ms !== undefined)
                .map((entry) => [fileKey(entry.project, entry.path), entry.ms as number]),
            ),
          );
          const parts = assignParts(files, timings, count);
          expect(parts).toHaveLength(count);
          expectPartition(files, parts);
        },
      ),
    );
  });

  it('gives the same parts whatever order the files arrive in', () => {
    const files = Object.keys(TABLE.files).map(file);
    const reversed = [...files].reverse();
    const interleaved = [
      ...files.filter((_, at) => at % 2 === 1),
      ...files.filter((_, at) => at % 2 === 0),
    ];
    const first = keysOf(assignParts(files, TABLE, 3));
    expect(keysOf(assignParts(reversed, TABLE, 3))).toEqual(first);
    expect(keysOf(assignParts(interleaved, TABLE, 3))).toEqual(first);
    // And equal weights fall back on the key, never on the arrival order.
    const ties = ['unit:c.test.ts', 'unit:a.test.ts', 'unit:b.test.ts', 'unit:d.test.ts'];
    const tied = fixture(Object.fromEntries(ties.map((key) => [key, 10])));
    const once = keysOf(assignParts(ties.map(file), tied, 2));
    expect(keysOf(assignParts([...ties].reverse().map(file), tied, 2))).toEqual(once);
  });

  it('places a file the table does not name, at its project’s median — or a default for a new project', () => {
    const timings = fixture({
      'unit:a.test.ts': 100,
      'unit:b.test.ts': 300,
      'unit:c.test.ts': 500,
    });
    const files = [
      ...Object.keys(timings.files).map(file),
      file('unit:new.test.ts'),
      file('brand-new:x.test.ts'),
    ];
    for (const count of [1, 2, 3, 4, 7]) {
      expectPartition(files, assignParts(files, timings, count));
    }
    // One part each: its estimate is its file's weight, so the weight an unknown file got is visible.
    const [newUnit] = estimateParts([[file('unit:new.test.ts')]], timings);
    const [newProject] = estimateParts([[file('brand-new:x.test.ts')]], timings);
    expect(newUnit).toBe(300);
    expect(newProject).toBe(UNKNOWN_FILE_MS);
  });

  it('balances the parts on their wall time: shared workers, one long file, serial files one for one', () => {
    // Twelve files of 60 and one of 180 over three workers: the long file's part may hold nothing
    // else that would outlast it, and the others share the rest evenly.
    const keys = Array.from(
      { length: 12 },
      (_, at) => `unit:f${String(at).padStart(2, '0')}.test.ts`,
    );
    const timings = fixture({
      ...Object.fromEntries(keys.map((key) => [key, 60])),
      'unit:long.test.ts': 180,
    });
    const files = Object.keys(timings.files).map(file);
    const parts = assignParts(files, timings, 3);
    const estimates = estimateParts(parts, timings);
    expect(Math.max(...estimates)).toBe(180);
    // A serial file adds its whole duration: two serial files of 90 never share a part.
    const serial = fixture({
      'process:a.test.ts': 90,
      'process:b.test.ts': 90,
      'unit:c.test.ts': 9,
    });
    const serialParts = assignParts(Object.keys(serial.files).map(file), serial, 2);
    expect(
      serialParts.map((part) => part.filter((entry) => entry.project === 'process').length),
    ).toEqual([1, 1]);
  });

  it('splits the checked-in table’s tiers far closer to even than the hash split did', () => {
    // Run 45861948638 (the hash split): e2e parts 553 s / 496 s / 1124 s of file time. Balanced,
    // no part's estimate is more than 10 % over the mean, or over the tier's longest file.
    for (const tier of [['unit', 'contract', 'process'], ['e2e-fake-claude']]) {
      const files = Object.keys(TABLE.files)
        .map(file)
        .filter((entry) => tier.includes(entry.project));
      const parts = assignParts(files, TABLE, 3);
      expectPartition(files, parts);
      const estimates = estimateParts(parts, TABLE);
      const longest = Math.max(
        ...estimateParts(
          files.map((entry) => [entry]),
          TABLE,
        ),
      );
      const mean = estimates.reduce((sum, value) => sum + value, 0) / estimates.length;
      expect(Math.max(...estimates), tier.join('+')).toBeLessThanOrEqual(
        Math.max(longest, mean * 1.1),
      );
    }
  });

  it('refuses a file the run holds twice, and a part count below one', () => {
    expect(() =>
      assignParts([file('unit:a.test.ts'), file('unit:a.test.ts')], fixture({}), 2),
    ).toThrow(/twice/);
    expect(() => assignParts([], fixture({}), 0)).toThrow(/parts/);
  });
});

describe('the checked-in timing table', () => {
  it('names a calibrated project for every file, a positive figure for each, in key order', () => {
    expect(TABLE.workers).toBeGreaterThan(0);
    const keys = Object.keys(TABLE.files);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys).toEqual([...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    for (const [key, ms] of Object.entries(TABLE.files)) {
      expect(Object.keys(TABLE.projects), key).toContain(key.slice(0, key.indexOf(':')));
      expect(Number.isInteger(ms) && ms >= 0, key).toBe(true);
    }
  });
});

describe('the sequencer vitest runs', () => {
  it('is the root configuration’s, so every project is split by it', () => {
    expect(config.test?.sequence?.sequencer).toBe(BalancedSequencer);
  });

  /** A specification as `shard` and `sort` read it: the module, its project and the group order. */
  const spec = (project: string, relative: string, groupOrder = 0) =>
    ({
      moduleId: `/repo/${relative}`,
      project: { name: project, config: { sequence: { groupOrder } } },
    }) as unknown as TestSpecification;

  const ctx = (shard: { index: number; count: number } | undefined) =>
    ({ config: { root: '/repo', shard } }) as unknown as Vitest;

  const specs = [
    ...Object.keys(TABLE.files)
      .filter((key) => !key.startsWith('process:'))
      .slice(0, 40)
      .map((key) => spec(key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1))),
    spec('process', 'scripts/collection-watchdog.test.ts', 1),
    spec('unit', 'scripts/not-in-the-table.test.ts'),
  ];

  it('gives every specification to exactly one of the parts, by repository-relative key', async () => {
    const parts = await Promise.all(
      [1, 2, 3].map((index) => new BalancedSequencer(ctx({ index, count: 3 })).shard(specs)),
    );
    const all = parts.flat();
    expect(new Set(all).size).toBe(all.length);
    expect(new Set(all)).toEqual(new Set(specs));
  });

  it('runs a part’s files longest first within each group order', async () => {
    const sequencer = new BalancedSequencer(ctx({ index: 1, count: 1 }));
    const sorted = await sequencer.sort(specs);
    const orders = sorted.map((entry) => entry.project.config.sequence.groupOrder);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(sorted.at(-1)?.project.name).toBe('process');
    const weights = sorted
      .filter((entry) => entry.project.config.sequence.groupOrder === 0)
      .map((entry) => {
        const key = fileKey(entry.project.name, entry.moduleId.slice('/repo/'.length));
        return estimateParts([[file(key)]], TABLE)[0] as number;
      });
    expect(weights.length).toBeGreaterThan(1);
    expect(weights).toEqual([...weights].sort((a, b) => b - a));
  });
});

describe('reading a CI run’s log', () => {
  const ESC = '\u001b';
  const line = (job: string, body: string) =>
    `${job}\tUNKNOWN STEP\t2026-11-26T16:49:34.2572694Z ${body}`;
  const log = [
    line(
      'unit + contract (part 1/3)',
      ` ${ESC}[32m✓${ESC}[39m  unit  scripts/a.test.ts (3 tests) 120ms`,
    ),
    line(
      'unit + contract (part 2/3)',
      ' ✓  process  scripts/b.test.ts (2 tests | 1 skipped) 17788ms',
    ),
    line(
      'e2e-fake-claude (part 3/3)',
      ' ✓  e2e-fake-claude  test/e2e/x.e2e.test.ts (13 tests) 309337ms',
    ),
    line('e2e-fake-claude (part 3/3)', '     ✓ a test inside the file 99890ms'),
    // The merge job replays every file line; it is not read.
    line('unit + contract', ' ✓  unit  scripts/a.test.ts (3 tests) 999ms'),
    line('ui', ' ✓  ui  apps/web/src/c.test.tsx (1 test) 5ms'),
  ].join('\n');

  it('reads each part’s file lines, colour or not, and nothing else', () => {
    expect(Object.fromEntries(parseVitestLog(log))).toEqual({
      'unit:scripts/a.test.ts': 120,
      'process:scripts/b.test.ts': 17788,
      'e2e-fake-claude:test/e2e/x.e2e.test.ts': 309337,
    });
  });

  it('refuses a file two parts reported', () => {
    const twice = `${log}\n${line('unit + contract (part 2/3)', ' ✓  unit  scripts/a.test.ts (3 tests) 130ms')}`;
    expect(() => parseVitestLog(twice)).toThrow(/two parts/);
  });

  it('writes a sorted table that keeps the calibrations, and refuses a run with no part', () => {
    const previous = fixture({ 'unit:old.test.ts': 1 }, 4);
    const table = refreshedTimings(previous, parseVitestLog(log), '42', '2026-11-27');
    expect(table.workers).toBe(4);
    expect(table.projects).toEqual(previous.projects);
    expect(table.source).toEqual({ run: '42', retrieved: '2026-11-27' });
    expect(Object.keys(table.files)).toEqual([
      'e2e-fake-claude:test/e2e/x.e2e.test.ts',
      'process:scripts/b.test.ts',
      'unit:scripts/a.test.ts',
    ]);
    expect(() => refreshedTimings(previous, new Map(), '42', '2026-11-27')).toThrow(/no file/);
  });
});

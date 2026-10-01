import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import * as vitestConfig from '../vitest.config.js';
import { censusPaths } from './census-files.mjs';
import {
  earnedFloor,
  freshnessProblem,
  METRICS,
  percent,
  ratchet,
  ratchetVerdicts,
  ringFigures,
  slackPoints,
  summaryProvenanceProblems,
  vitestPicomatch,
} from './coverage-ratchet.mjs';

/**
 * `coverage-ratchet.mjs` (WP-97, PROGRESS backlog 254): the arithmetic, the verdicts, the refusal
 * of a summary that is not this run's, and the whole check in process against this repository's own
 * configuration and a summary written here — a real coverage run is `pnpm test`'s, which is running
 * around this file and has cleaned `coverage/` at its start, so the script's CLI reads a synthetic
 * summary through the same function it calls.
 */
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const picomatch = vitestPicomatch() as (glob: string | readonly string[]) => (p: string) => boolean;
const bar80 = (): Record<string, number> => ({
  lines: 80,
  branches: 80,
  functions: 80,
  statements: 80,
});

describe('the arithmetic', () => {
  it('is istanbul’s percentage, which is what vitest compares a threshold with', () => {
    expect(percent(1516, 2634)).toBe(57.55);
    expect(percent(2, 3)).toBe(66.66);
    expect(percent(0, 0)).toBe(100);
    expect(percent(5, 5)).toBe(100);
  });

  it('takes two points or two items of slack, whichever is larger', () => {
    expect(slackPoints(2634)).toBe(2);
    expect(slackPoints(55)).toBeCloseTo(3.636, 3);
    expect(slackPoints(0)).toBe(2);
  });

  it('earns WP-70’s floor, capped at the bar, so a re-pin to it always satisfies the check', () => {
    expect(earnedFloor({ pct: 57.55, total: 2634, bar: 80 })).toBe(55);
    expect(earnedFloor({ pct: 81.81, total: 55, bar: 80 })).toBe(78);
    expect(earnedFloor({ pct: 99, total: 1000, bar: 80 })).toBe(80);
    // The case a "two points above" rule gets wrong: 70.5 over 68 earns 68, so nothing to re-pin.
    expect(earnedFloor({ pct: 70.5, total: 1000, bar: 80 })).toBe(68);
    expect(earnedFloor({ pct: 71, total: 1000, bar: 80 })).toBe(69);
  });
});

describe('the verdicts', () => {
  const root = '/checkout';
  const file = (covered: number, total: number) =>
    Object.fromEntries(METRICS.map((metric) => [metric, { covered, total }]));
  const rings = {
    debt: {
      glob: 'apps/debt/**/*.ts',
      thresholds: { lines: 54, branches: 54, functions: 54, statements: 54 },
    },
    held: { glob: 'apps/held/**/*.ts', thresholds: bar80() },
    tight: {
      glob: 'apps/tight/**/*.ts',
      thresholds: { lines: 90, branches: 90, functions: 90, statements: 90 },
    },
  };
  const judge = (summary: Record<string, unknown>) =>
    ratchetVerdicts(ringFigures(summary as never, rings, root, picomatch), rings, () => bar80());

  it('sums a ring over the files its glob matches, and only those', () => {
    const measured = ringFigures(
      {
        total: file(0, 0),
        '/checkout/apps/debt/a.ts': file(50, 100),
        '/checkout/apps/debt/b/c.ts': file(10, 100),
        '/checkout/apps/held/a.ts': file(1, 1),
      } as never,
      rings,
      root,
      picomatch,
    );
    expect(measured.debt).toEqual({
      files: 2,
      figures: Object.fromEntries(METRICS.map((m) => [m, { covered: 60, total: 200, pct: 30 }])),
    });
    expect(measured.tight?.files).toBe(0);
  });

  it('passes a figure inside the slack, and a floor tighter than the rule would set', () => {
    const { problems, report } = judge({
      '/checkout/apps/debt/a.ts': file(5699, 10_000),
      '/checkout/apps/held/a.ts': file(99, 100),
      '/checkout/apps/tight/a.ts': file(91, 100),
    });
    expect(problems).toEqual([]);
    expect(report[0]).toBe(
      'debt: lines 56.99 (floor 54, earned 54) | branches 56.99 (floor 54, earned 54) | functions 56.99 (floor 54, earned 54) | statements 56.99 (floor 54, earned 54)',
    );
  });

  it('refuses a rise the floor did not follow, naming the floor it earned', () => {
    const { problems } = judge({
      '/checkout/apps/debt/a.ts': file(5700, 10_000),
      '/checkout/apps/held/a.ts': file(100, 100),
      '/checkout/apps/tight/a.ts': file(100, 100),
    });
    expect(problems).toHaveLength(4);
    expect(problems[0]).toMatch(
      /^debt lines: measured 57\.00 has earned a floor of 55 .* re-pin it to 55/,
    );
  });

  it('refuses a figure below its floor, and a ring nothing measured', () => {
    const { problems } = judge({
      '/checkout/apps/debt/a.ts': file(5399, 10_000),
      '/checkout/apps/held/a.ts': file(79, 100),
    });
    expect(problems.filter((p) => p.includes('is below its floor'))).toHaveLength(8);
    expect(problems.at(-1)).toBe(
      'tight: no file in the summary matches the ring, so nothing was measured',
    );
  });
});

describe('which run the summary is', () => {
  it('refuses a summary written before the target started, and says nothing without a target', () => {
    expect(freshnessProblem(1000, '2000')).toMatch(/before this target started/);
    expect(freshnessProblem(2000, '2000')).toBeNull();
    expect(freshnessProblem(1000, undefined)).toBeNull();
    expect(freshnessProblem(1000, 'soon')).toMatch(/is not a number/);
  });

  it('refuses another checkout’s files, a missing counted file, and an empty summary', () => {
    const counted = ['apps/a.ts', 'apps/b.ts'];
    expect(
      summaryProvenanceProblems(
        { total: {}, '/checkout/apps/a.ts': {}, '/checkout/apps/b.ts': {} },
        '/checkout',
        counted,
      ),
    ).toEqual([]);
    expect(
      summaryProvenanceProblems(
        { '/other/apps/a.ts': {}, '/checkout/apps/a.ts': {} },
        '/checkout',
        counted,
      ),
    ).toEqual([
      expect.stringMatching(/1 file\(s\) outside this checkout \(first: \/other\/apps\/a\.ts\)/),
      expect.stringMatching(/lacks 1 file\(s\) this checkout counts \(first: apps\/b\.ts\)/),
    ]);
    expect(summaryProvenanceProblems({ total: {} }, '/checkout', [])).toEqual([
      'the summary lists no file',
    ]);
  });
});

describe('the whole check, against this repository’s configuration', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coverage-ratchet-'));
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  const coverage = (vitestConfig.default.test?.coverage ?? {}) as {
    include: string[];
    exclude: string[];
  };
  const included = picomatch(coverage.include);
  const excluded = picomatch(coverage.exclude);
  const counted = censusPaths(repositoryRoot, {
    include: (path) => path.endsWith('.ts') && included(path) && !excluded(path),
  });
  const ringOf = (path: string): string =>
    Object.entries(vitestConfig.COVERAGE_RINGS).find(([, ring]) =>
      picomatch(ring.glob)(path),
    )?.[0] ?? 'none';

  /** Every counted file at exactly its ring's floor (over 10 000 items), with an optional nudge. */
  const summaryAtFloors = (nudge: (path: string, metric: string) => number = () => 0) =>
    Object.fromEntries(
      counted.map((path) => {
        const ring = vitestConfig.COVERAGE_RINGS[ringOf(path)];
        return [
          join(repositoryRoot, path),
          Object.fromEntries(
            METRICS.map((metric) => [
              metric,
              {
                total: 10_000,
                covered: (ring?.thresholds[metric] ?? 0) * 100 + nudge(path, metric),
              },
            ]),
          ),
        ];
      }),
    );

  const run = (summary: unknown, startedAt?: string) => {
    const summaryPath = join(directory, 'coverage-summary.json');
    writeFileSync(summaryPath, JSON.stringify(summary));
    return ratchet({
      root: repositoryRoot,
      summaryPath,
      startedAt,
      config: vitestConfig as never,
      picomatch,
    });
  };

  it('passes every ring sitting exactly on its floor', () => {
    const result = run(summaryAtFloors());
    expect(result.out).toMatch(/^PASS: coverage:ratchet \(10 rings × 4 metrics over \d+ files/);
    expect(result.code).toBe(0);
  });

  it('fails one covered branch short of the server floor, and names the ring', () => {
    const server = counted.find((path) => ringOf(path) === 'server') ?? '';
    const serverFloor = vitestConfig.COVERAGE_RINGS.server?.thresholds.branches ?? 0;
    const result = run(
      summaryAtFloors((path, metric) =>
        path === server && metric === 'branches' ? -serverFloor * 100 : 0,
      ),
    );
    expect(result).toMatchObject({ code: 1, out: 'FAIL: coverage:ratchet' });
    expect(result.err).toContainEqual(
      expect.stringMatching(/^server branches: measured .* is below its floor 57/),
    );
  });

  it('fails a debt ring that earned a higher floor, and passes a ring held at the bar', () => {
    const result = run(summaryAtFloors(() => 1000));
    expect(result.code).toBe(1);
    const refused = result.err.filter((line) => line.includes('has earned a floor'));
    expect(refused.map((line) => line.split(' ')[0])).toEqual(
      expect.arrayContaining(['server', 'infrastructure', 'launcher']),
    );
    expect(refused.some((line) => line.startsWith('application '))).toBe(false);
  });

  it('refuses a summary from before the target, or one missing a counted file', () => {
    const stale = run(summaryAtFloors(), String(Date.now() + 60_000));
    expect(stale.code).toBe(2);
    expect(stale.err.join('\n')).toMatch(/before this target started/);
    const partial = summaryAtFloors();
    delete partial[join(repositoryRoot, counted[0] ?? '')];
    const missing = run(partial);
    expect(missing.code).toBe(2);
    expect(missing.err.join('\n')).toMatch(/lacks 1 file\(s\) this checkout counts/);
  });

  it('refuses no summary at all, naming the step that writes it', () => {
    const result = ratchet({
      root: repositoryRoot,
      summaryPath: join(directory, 'absent.json'),
      startedAt: undefined,
      config: vitestConfig as never,
      picomatch,
    });
    expect(result.code).toBe(2);
    expect(result.err[0]).toMatch(/could not read .* run `pnpm test` first/);
  });
});

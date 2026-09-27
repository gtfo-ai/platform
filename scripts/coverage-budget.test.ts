import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import vitestConfig, {
  COVERAGE_EXCLUDED_FILES,
  COVERAGE_INCLUDE,
  COVERAGE_RINGS,
  PROCESS_SUITES,
} from '../vitest.config.js';
import { censusPaths } from './census-files.mjs';
import { nestedCheckoutExcludes } from './nested-checkouts.js';

/**
 * The coverage budget is a partition, and its exclusions are a census (WP-70, PROGRESS backlog 87
 * and 115).
 *
 * `vitest.config.ts` holds coverage **per ring** with no global threshold, so a file that matches
 * no ring's glob is counted by **nothing** — the silent way out of a budget. And a file matching two
 * rings is held twice, to two different numbers. So every file coverage counts must match exactly
 * one ring, read off the tree git knows (tracked and untracked, `census-files.mjs`) rather than
 * off a list.
 *
 * **The matcher is vitest's own.** vitest resolves a threshold glob with `picomatch`, and a second
 * implementation answers differently on exactly the patterns a ring needs: Node's
 * `path.matchesGlob` matches `packages/infrastructure/src/runlet2/x.ts` against
 * `{…,!(runlet|testing)/**\/…}` and picomatch 4.0.7 does not (measured, WP-70). A census that
 * matched with the other one would certify a partition vitest does not apply. So `picomatch` is
 * required **from vitest's own location**, which is the copy vitest runs.
 *
 * The exclusions are pinned here in both directions, so adding one is an edit to this file too —
 * a decision rather than a line added under a precedent.
 *
 * What it cannot see: whether a ring's number is *right* — that is a coverage run, and technical/10
 * carries the measurement the numbers were set from.
 */
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

type Matcher = (path: string) => boolean;
const picomatch = createRequire(fileURLToPath(import.meta.resolve('vitest')))('picomatch') as (
  glob: string | readonly string[],
) => Matcher;

const rings = Object.entries(COVERAGE_RINGS).map(([name, ring]) => ({
  name,
  matches: picomatch(ring.glob),
}));

const ringsOf = (path: string): readonly string[] =>
  rings.filter((ring) => ring.matches(path)).map((ring) => ring.name);

const coverage = vitestConfig.test?.coverage as {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly thresholds: Readonly<Record<string, unknown>>;
};

/** The source files a coverage run counts, by the config's own include and exclude globs. */
const countedFiles = (): readonly string[] => {
  const included = picomatch(coverage.include);
  const excluded = picomatch(coverage.exclude);
  return censusPaths(repositoryRoot, {
    include: (path) => path.endsWith('.ts') && included(path) && !excluded(path),
  });
};

describe('the coverage budget', () => {
  it('counts the files the config includes, and the corpus is not empty', () => {
    expect(coverage.include).toEqual(COVERAGE_INCLUDE);
    const files = countedFiles();
    // A glob that matched nothing would satisfy the partition below vacuously (standing rule 4).
    expect(files.length).toBeGreaterThan(400);
    expect(files).toContain('packages/domain/src/index.ts');
    expect(files).toContain('apps/server/src/runtime.ts');
  });

  it('includes every app with TypeScript sources except the browser bundle, so a new app is counted', () => {
    // Review round 1: `COVERAGE_INCLUDE` names apps one by one, and a new `apps/<name>/src` was
    // neither counted nor gated while the partition below stayed green. `apps/web` is the ui tier's.
    const apps = new Set(
      censusPaths(repositoryRoot, {
        include: (path) => /^apps\/[^/]+\/src\/.*\.ts$/.test(path),
      }).map((path) => path.split('/')[1]),
    );
    apps.delete('web');
    const included = picomatch(coverage.include);
    const uncounted = [...apps].filter((app) => !included(`apps/${app}/src/index.ts`));
    expect(uncounted).toEqual([]);
  });

  it('holds every counted file in exactly one ring', () => {
    const misplaced = countedFiles()
      .map((path) => ({ path, rings: ringsOf(path) }))
      .filter((entry) => entry.rings.length !== 1);
    expect(misplaced).toEqual([]);
  });

  it('would see a file that falls between the rings, and one held by two', () => {
    // The other direction: the partition check is not blind to either failure.
    expect(ringsOf('packages/infrastructure/src/runlet2/transport.ts')).toEqual([]);
    expect(ringsOf('packages/newring/src/index.ts')).toEqual([]);
    expect(ringsOf('packages/infrastructure/src/runlet/shim.ts')).toEqual(['runlet']);
    expect(ringsOf('packages/infrastructure/src/runlet/testing.ts')).toEqual(['test support']);
    expect(ringsOf('packages/application/src/testing/pipeline-harness.ts')).toEqual([
      'test support',
    ]);
    expect(ringsOf('packages/domain/src/testing/property.ts')).toEqual(['test support']);
  });

  it('sets no global threshold, because vitest counts every file into it', () => {
    // `resolveThresholds` (vitest 5.0.0): "Global threshold is for all files, even if they are
    // included by glob patterns" — a global number re-imports every ring's noise into every gate.
    for (const metric of ['lines', 'branches', 'functions', 'statements', 'perFile']) {
      expect(coverage.thresholds).not.toHaveProperty(metric);
    }
    expect(Object.keys(coverage.thresholds).sort()).toEqual(
      Object.values(COVERAGE_RINGS)
        .map((ring) => ring.glob)
        .sort(),
    );
  });

  it('names what a ring owes whenever it is held below the bar', () => {
    for (const [name, ring] of Object.entries(COVERAGE_RINGS)) {
      const bar =
        name === 'domain'
          ? { lines: 90, branches: 85, functions: 90, statements: 90 }
          : { lines: 80, branches: 80, functions: 80, statements: 80 };
      const below = Object.entries(ring.thresholds).filter(
        ([metric, value]) => value < bar[metric as keyof typeof bar],
      );
      expect({ name, owes: below.length > 0 && !ring.owes }).toEqual({ name, owes: false });
      expect({ name, owes: below.length === 0 && ring.owes !== undefined }).toEqual({
        name,
        owes: false,
      });
    }
  });
});

describe('the coverage exclusions', () => {
  it('are exactly these, so a new one is an edit here as well as there', () => {
    expect(COVERAGE_EXCLUDED_FILES.map((exclusion) => exclusion.path)).toEqual([
      'apps/server/src/migrate.ts',
      'apps/launcher/src/index.ts',
      'apps/runlet/src/index.ts',
      'apps/server/src/queries/stats-queries.ts',
    ]);
  });

  it('are the only entries coverage.exclude adds to the shared globs', () => {
    // Everything else in the list is a glob every project shares, a test or declaration file, or
    // a nested checkout (`nestedCheckoutExcludes`) — so neither a file nor a directory of source
    // can be taken out of the count without an entry above.
    const shared = new Set([
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/*.test.ts',
      '**/*.d.ts',
      ...nestedCheckoutExcludes(repositoryRoot),
    ]);
    expect(coverage.exclude.filter((glob) => !shared.has(glob))).toEqual(
      COVERAGE_EXCLUDED_FILES.map((exclusion) => exclusion.path),
    );
  });

  it('each exist, and are each named by the file that drives them', () => {
    for (const exclusion of COVERAGE_EXCLUDED_FILES) {
      expect(existsSync(join(repositoryRoot, exclusion.path)), exclusion.path).toBe(true);
      const driver = readFileSync(join(repositoryRoot, exclusion.exercisedBy), 'utf8');
      const module = basename(exclusion.path, '.ts');
      const named = driver.includes(exclusion.path) || driver.includes(`/${module}.js'`);
      expect({ exclusion: exclusion.path, named }).toEqual({
        exclusion: exclusion.path,
        named: true,
      });
    }
  });

  it('say which tier drives them, and that tier is the driver file’s own', () => {
    for (const exclusion of COVERAGE_EXCLUDED_FILES) {
      const tier = PROCESS_SUITES.includes(exclusion.exercisedBy)
        ? 'process'
        : exclusion.exercisedBy.endsWith('.integration.test.ts')
          ? 'integration'
          : exclusion.exercisedBy.includes('.test.')
            ? 'another tier'
            : 'image';
      expect({ path: exclusion.path, tier: exclusion.tier }).toEqual({
        path: exclusion.path,
        tier,
      });
    }
  });
});

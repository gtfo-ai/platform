import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import vitestConfig, { PROPERTY_SEED_SETUP } from '../vitest.config.js';
import { censusFiles } from './census-files.mjs';
import {
  chooseSeed,
  drawSeed,
  EXPLORATION_PROJECTS,
  explorationArgs,
  propertyFiles,
  replayCommand,
  replayFileCommand,
  runsAProperty,
  verdictLine,
} from './property-exploration.mjs';
import { GATE_PROPERTY_SEED, PROPERTY_SEED_VARIABLE, seedFrom } from './property-seed.mjs';
import { withoutComments } from './source-scanner.mjs';

/**
 * One seed for every property in the gate, a fresh one weekly (WP-97, PROGRESS backlogs 253 and
 * 270): `property-seed.mjs`, the setup file `test/support/property-seed.ts`, and
 * `property-exploration.mjs`.
 *
 * **This file is inside its own scope** (standing rule 59): the censuses below read every source
 * git knows about, this one included, so its planted fixtures are assembled from `FC` rather than
 * written out — a fixture that spelled the call would make this file a property file, and one that
 * spelled a seed would fail the census it is testing.
 */
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const FC = 'fc';

type Matcher = (path: string) => boolean;
const picomatch = createRequire(fileURLToPath(import.meta.resolve('vitest')))('picomatch') as (
  glob: string | readonly string[],
) => Matcher;

interface Project {
  readonly test: {
    readonly name: string;
    readonly include: readonly string[];
    readonly exclude?: readonly string[];
    readonly setupFiles?: readonly string[];
  };
}
const projects = (vitestConfig.test?.projects ?? []) as unknown as readonly Project[];

/**
 * Where a source sets a seed of its own, which would defeat both the gate's seed and the weekly
 * one: any `fc.configureGlobal` but the setup file's (it replaces the whole configuration, seed
 * included, unless it spreads the old one), and a `seed` key — written out or shorthand — in a file
 * that runs a property, which is how a single `fc.assert` pins its own.
 */
const CONFIGURES_GLOBAL = /\bfc\s*\.\s*configureGlobal\s*\(/;
const SEED_KEY = /[{,]\s*seed\s*[:,}]/;
const ownSeedSites = (files: readonly { path: string; contents: string }[]): string[] =>
  files
    .filter(({ path }) => path !== PROPERTY_SEED_SETUP)
    .filter(({ contents }) => {
      // The raw text first: stripping only removes text, so a file the raw patterns miss cannot
      // match after it, and the scanner then runs on a handful of files rather than on 1,700.
      if (!CONFIGURES_GLOBAL.test(contents) && !SEED_KEY.test(contents)) return false;
      const code = withoutComments(contents);
      return CONFIGURES_GLOBAL.test(code) || (runsAProperty(code) && SEED_KEY.test(code));
    })
    .map(({ path }) => path);

describe('the seed a run draws from', () => {
  it('is the gate’s unless the environment names another, and refuses a malformed one', () => {
    expect(seedFrom({})).toEqual({ seed: GATE_PROPERTY_SEED, source: 'gate' });
    expect(seedFrom({ [PROPERTY_SEED_VARIABLE]: '' })).toEqual({
      seed: GATE_PROPERTY_SEED,
      source: 'gate',
    });
    expect(seedFrom({ [PROPERTY_SEED_VARIABLE]: '42' })).toEqual({
      seed: 42,
      source: 'environment',
    });
    expect(seedFrom({ [PROPERTY_SEED_VARIABLE]: '-2147483648' }).seed).toBe(-(2 ** 31));
    for (const bad of ['abc', '1e3', '4.2', ' 42', '2147483648', 'missing']) {
      expect(() => seedFrom({ [PROPERTY_SEED_VARIABLE]: bad }), bad).toThrow(
        PROPERTY_SEED_VARIABLE,
      );
    }
  });

  it('reaches this file, which imports nothing that sets it', () => {
    // The setup file ran in this file's module graph before it: the `fast-check` it configured is
    // the one imported above. Under the weekly run the environment's seed is the expected one.
    expect(fc.readConfigureGlobal().seed).toBe(seedFrom(process.env).seed);
  });
});

describe('the seed census', () => {
  const sources = censusFiles(repositoryRoot, {
    pathspecs: ['packages', 'apps', 'scripts', 'test'],
    include: (path) => /\.(?:ts|tsx|mjs)$/.test(path),
  });

  it('finds the property files, in more than one package', () => {
    const files = propertyFiles(repositoryRoot);
    expect(files.length).toBeGreaterThanOrEqual(40);
    expect(files).toContain('packages/domain/src/cost/ledger.test.ts');
    expect(files).toContain('packages/contracts/src/events.test.ts');
    expect(files).toContain('packages/application/src/events/event-bus.property.test.ts');
    expect(files).toContain('packages/infrastructure/src/runlet/framing.test.ts');
    expect(files).not.toContain('scripts/property-seed.test.ts');
  });

  it('puts the setup file in every vitest project', () => {
    expect(projects.length).toBeGreaterThanOrEqual(6);
    const without = projects
      .filter((project) => !(project.test.setupFiles ?? []).includes(PROPERTY_SEED_SETUP))
      .map((project) => project.test.name);
    expect(without).toEqual([]);
  });

  it('runs every property file under a project the exploration run names', () => {
    const collectedBy = (file: string): string[] =>
      projects
        .filter((project) => {
          const included = picomatch(project.test.include);
          const excluded = picomatch(project.test.exclude ?? []);
          return included(file) && !excluded(file);
        })
        .map((project) => project.test.name);
    const stranded = propertyFiles(repositoryRoot)
      .map((file) => ({ file, projects: collectedBy(file) }))
      .filter((entry) => !entry.projects.some((name) => EXPLORATION_PROJECTS.includes(name)));
    expect(stranded).toEqual([]);
  });

  it('finds no file that sets a seed of its own', () => {
    expect(sources.length).toBeGreaterThan(400);
    expect(ownSeedSites(sources)).toEqual([]);
  });

  it('names a planted file that sets its own seed, in either spelling', () => {
    const run = `${FC}.assert(${FC}.property(a, f)`;
    expect(
      ownSeedSites([
        {
          path: 'packages/x/src/global.test.ts',
          contents: `${FC}.configureGlobal({ numRuns: 5 });`,
        },
        { path: 'packages/x/src/param.test.ts', contents: `${run}, { seed: 7 });` },
        { path: 'packages/x/src/shorthand.test.ts', contents: `${run}, { numRuns, seed });` },
        { path: 'packages/x/src/fine.test.ts', contents: `${run}, { numRuns: 5 });` },
        {
          path: 'packages/x/src/commented.test.ts',
          contents: `// ${FC}.configureGlobal({ seed: 1 })\n${run});`,
        },
        { path: PROPERTY_SEED_SETUP, contents: `${FC}.configureGlobal({ seed: 1 });` },
      ]),
    ).toEqual([
      'packages/x/src/global.test.ts',
      'packages/x/src/param.test.ts',
      'packages/x/src/shorthand.test.ts',
    ]);
  });

  it('reads a property call in code, not in a comment', () => {
    expect(runsAProperty(`${FC}.assert(p);`)).toBe(true);
    expect(runsAProperty(`${FC} . check (p);`)).toBe(true);
    expect(runsAProperty(`/** runs ${FC}.assert(p) */\nconst x = 1;`)).toBe(false);
    expect(runsAProperty(`${FC}.sample(p);`)).toBe(false);
  });
});

describe('the exploration run', () => {
  it('draws a seed the setup file accepts, or takes the one it is given', () => {
    for (let draw = 0; draw < 50; draw += 1) {
      const seed = drawSeed();
      expect(seedFrom({ [PROPERTY_SEED_VARIABLE]: String(seed) }).seed).toBe(seed);
    }
    expect(chooseSeed([], () => 99)).toBe(99);
    expect(chooseSeed(['--seed', '123'], () => 99)).toBe(123);
    expect(() => chooseSeed(['--seed'], () => 99)).toThrow(PROPERTY_SEED_VARIABLE);
    expect(() => chooseSeed(['--seed', 'x'], () => 99)).toThrow(PROPERTY_SEED_VARIABLE);
  });

  it('runs the files on the three projects, without coverage', () => {
    const args = explorationArgs(['a.test.ts', 'b.test.ts']);
    expect(args).toEqual([
      'exec',
      'vitest',
      'run',
      '--project',
      'unit',
      '--project',
      'contract',
      '--project',
      'process',
      'a.test.ts',
      'b.test.ts',
    ]);
    expect(args.join(' ')).not.toContain('coverage');
  });

  it('names the seed and its replay in a failing verdict, and the seed in a passing one', () => {
    expect(verdictLine({ passed: true, seed: 5, files: 44 })).toBe(
      'PASS: properties:explore (seed 5, 44 property files)',
    );
    expect(verdictLine({ passed: false, seed: 5, files: 44 })).toBe(
      'FAIL: properties:explore (seed 5 — replay: pnpm run -s properties:explore --seed 5)',
    );
    expect(replayCommand(5)).toContain('--seed 5');
    expect(replayFileCommand(5, 'x.test.ts')).toBe(
      `${PROPERTY_SEED_VARIABLE}=5 pnpm exec vitest run x.test.ts`,
    );
  });
});

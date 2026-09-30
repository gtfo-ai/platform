#!/usr/bin/env node
/**
 * Runs every property file in the repository on a **fresh** fast-check seed, and on a failure
 * names the seed so the counterexample can be replayed (WP-97, PROGRESS backlog 270).
 *
 * The gate runs every property on one fixed seed (`property-seed.mjs` says why), which keeps a
 * coverage figure a property of the tree and costs exploration. This buys it back out of the gate:
 * `.github/workflows/property-exploration.yml` runs it weekly and on dispatch — **never** on a pull
 * request, so a counterexample is a red workflow somebody reads rather than a flaky merge — and a
 * developer can run it too (`pnpm run -s properties:explore`).
 *
 *     pnpm run -s properties:explore             a random 31-bit seed
 *     pnpm run -s properties:explore --seed 42   that seed (a replay)
 *
 * **Which files.** Every test file git knows about (tracked and untracked, standing rule 85) whose
 * text, comments removed, calls `fc.assert` or `fc.check` — the same question the seed census asks
 * in `property-seed.test.ts`. They run under the `unit`, `contract` and `process` projects, which
 * between them collect every such file today (the census holds that), with no coverage, because a
 * figure measured on a random seed is exactly the noise the gate's seed exists to remove.
 *
 * **The seed is printed before the run and again in the verdict**, and on a failure the replay
 * command is printed with it — to stderr, to the step summary when GitHub provides one
 * (`GITHUB_STEP_SUMMARY`), and in the one `FAIL: properties:explore (seed N)` line on stdout. A
 * replay sets `PROPERTY_SEED`, which the setup file of every project reads instead of the gate's
 * seed; fast-check's own failure report (seed, path, shrunk counterexample) is printed by vitest
 * above it as usual.
 *
 * Its test tier is `property-seed.test.ts` (standing rule 33).
 */
import { spawnSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { censusFiles } from './census-files.mjs';
import { isProgram } from './is-program.mjs';
import { PROPERTY_SEED_VARIABLE, seedFrom } from './property-seed.mjs';
import { withoutComments } from './source-scanner.mjs';

/** A call that runs a property — the census's and this script's one definition. */
export const RUNS_A_PROPERTY = /\bfc\s*\.\s*(?:assert|check)\s*\(/;

/** The projects that collect every property file today (`property-seed.test.ts` holds it). */
export const EXPLORATION_PROJECTS = ['unit', 'contract', 'process'];

/** Whether a source's code — comments removed, strings kept — runs a property. */
export const runsAProperty = (source) =>
  // The raw text first: stripping only removes text, so a miss here is a miss after it too.
  RUNS_A_PROPERTY.test(source) && RUNS_A_PROPERTY.test(withoutComments(source));

/** Every test file under `root` that runs a property, sorted. */
export const propertyFiles = (root) =>
  censusFiles(root, { include: (path) => /\.test\.tsx?$/.test(path) })
    .filter(({ contents }) => runsAProperty(contents))
    .map(({ path }) => path)
    .sort();

/** A fresh seed in `[0, 2^31)`, inside what `seedFrom` accepts. */
export const drawSeed = () => randomInt(0, 2 ** 31);

/** The seed a run uses: `--seed N` when given (validated as `seedFrom` does), a fresh one otherwise. */
export const chooseSeed = (argv, draw = drawSeed) => {
  const at = argv.indexOf('--seed');
  if (at === -1) return draw();
  return seedFrom({ [PROPERTY_SEED_VARIABLE]: argv[at + 1] ?? 'missing' }).seed;
};

/** The `pnpm` arguments that run `files` on the exploration projects, without coverage. */
export const explorationArgs = (files) => [
  'exec',
  'vitest',
  'run',
  ...EXPLORATION_PROJECTS.flatMap((project) => ['--project', project]),
  ...files,
];

/** The command a developer pastes to replay a seed. */
export const replayCommand = (seed) => `pnpm run -s properties:explore --seed ${seed}`;

/** The same replay narrowed to one file, which is what a developer does next. */
export const replayFileCommand = (seed, file) =>
  `${PROPERTY_SEED_VARIABLE}=${seed} pnpm exec vitest run ${file}`;

/** The one stdout line. */
export const verdictLine = ({ passed, seed, files }) =>
  passed
    ? `PASS: properties:explore (seed ${seed}, ${files} property files)`
    : `FAIL: properties:explore (seed ${seed} — replay: ${replayCommand(seed)})`;

const main = () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  let seed;
  try {
    seed = chooseSeed(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.stdout.write('FAIL: properties:explore\n');
    process.exit(2);
  }
  const files = propertyFiles(root);
  if (files.length === 0) {
    // Standing rule 4: a run over nothing would pass for ever.
    process.stderr.write('found no property file to run\n');
    process.stdout.write(`FAIL: properties:explore (seed ${seed})\n`);
    process.exit(2);
  }
  process.stderr.write(`property exploration: seed ${seed} over ${files.length} files\n`);
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const run = spawnSync(pnpm, explorationArgs(files), {
    cwd: root,
    stdio: ['inherit', 2, 'inherit'],
    env: { ...process.env, [PROPERTY_SEED_VARIABLE]: String(seed) },
  });
  const passed = run.error === undefined && run.status === 0;
  const verdict = verdictLine({ passed, seed, files: files.length });
  if (!passed) {
    process.stderr.write(
      `property exploration failed on seed ${seed}; replay: ${replayCommand(seed)} — or one file: ${replayFileCommand(seed, '<file>')}\n`,
    );
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${verdict}\n`);
  }
  process.stdout.write(`${verdict}\n`);
  process.exit(passed ? 0 : 1);
};

if (isProgram(import.meta.url)) {
  main();
}

#!/usr/bin/env node
/**
 * The coverage ratchet (WP-97, PROGRESS backlog 254): a ring's floor may not sit below what the
 * ring has **earned**, and a ring's measured figure may not sit below its floor.
 *
 * ## Why a floor needed a ratchet
 *
 * WP-70 replaced the one global threshold with per-ring floors (`COVERAGE_RINGS` in
 * `vitest.config.ts`) set by one rule: the bar where a ring clears it by the slack, otherwise
 * `floor(measured − slack)`, with the slack **two points or two items, whichever is larger**. The
 * rule said how a floor is set and nothing held it afterwards: a debt ring whose tests improved kept
 * its old floor, so the ground it gained could be lost again without any gate going red — WP-70's
 * review measured that the server ring's floor then admitted a wholly untested module of about 124
 * branches. And a floor could be *lowered* by editing one number. The second half is the census's
 * (`coverage-budget.test.ts` pins every threshold to technical/10's table, both directions, so a
 * lowered floor without its table row fails the unit tier); this file is the first.
 *
 * ## The rule, and why it is `floor(…)` rather than "two points above"
 *
 * For each ring and each of the four metrics, with the run's measured percentage `m` over `n`
 * items and the ring's bar `b` (80, the domain's 90/85/90/90):
 *
 *     slack  = max(2, 200 / n)                       — two points or two items
 *     earned = min(b, floor(m − slack))
 *
 * and the ring fails when `m < floor` (**below its floor** — vitest's threshold check says the same
 * one step earlier, so this line is for a run whose thresholds were bypassed) or when
 * `floor < earned` (**risen unpinned**). The second is exactly WP-70's setting rule read backwards,
 * so re-pinning to `earned` always satisfies it: a check stated as `m > floor + 2` would not — at
 * `m = 70.5` over a floor of 68 the re-pin `floor(68.5) = 68` would still fail. In words: a ring
 * fails once its measured figure clears its floor by more than the slack plus the fraction an
 * integer floor leaves — at two points of slack, as soon as `m ≥ floor + 3`. A ring held at the bar
 * cannot fail upwards (`earned ≤ b = floor`); a floor above what the rule would set is a tightening
 * and is allowed.
 *
 * ## Where it runs — the ruling, and reading the right run
 *
 * **Where coverage is measured, never in the census** (plan row WP-97): the census reads the tree,
 * and a measured figure exists only after a coverage run. So this is the step after `test` in
 * `verify:tests`, which is CI's `unit + contract` job's one command — the job that produced the
 * figures, in its own checkout.
 *
 * It reads `coverage/coverage-summary.json`, which that run wrote, and two runs in **one checkout**
 * share that directory: vitest cleans it at the start of a run and writes it at the end, so a
 * second run can delete or replace the first one's summary under it. So the summary is refused
 * unless it is **this run's**, as far as a file can say so:
 *
 *  - **written after the target started** — `scripts/verify.mjs` hands every step
 *    `VERIFY_TARGET_STARTED_AT`, and a summary older than it is a previous run's (the `test` step
 *    wrote nothing, or wrote elsewhere). Run on its own, with no target around it, the check says
 *    how old the summary it read is instead;
 *  - **covering every file this checkout counts** (`coverage.include` minus `coverage.exclude`,
 *    over the files git knows about, tracked and untracked), and **no file outside this
 *    checkout** — so another worktree's summary, or a run under another configuration, is refused.
 *
 * The residual, stated rather than implied: a second **full** run in the **same** checkout that
 * finishes between this run's write and this read is read in its place. It measured the same
 * working tree with the same configuration, so its figures are this tree's unless the tree changed
 * in between; and a partial run (a file filter) can only read **lower** — fewer tests cover no more
 * — so it can produce a false *below its floor*, never a false pass of that check, though it can
 * hide a rise. CI's job is one run in one checkout, where none of this arises.
 *
 * Prints exactly one `PASS: coverage:ratchet` / `FAIL: coverage:ratchet` line on stdout
 * (technical/14); the per-ring figures go to stderr. Its test tier is `coverage-ratchet.test.ts`
 * (standing rule 33). Plain JavaScript like the other `verify` steps; it loads `vitest.config.ts`
 * through `ts-source-resolver.mjs`, because the configuration is where the rings are.
 */
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { censusPaths } from './census-files.mjs';
import { isProgram } from './is-program.mjs';

export const COVERAGE_SUMMARY = 'coverage/coverage-summary.json';
export const STARTED_AT_VARIABLE = 'VERIFY_TARGET_STARTED_AT';
export const METRICS = /** @type {const} */ (['lines', 'branches', 'functions', 'statements']);

/**
 * istanbul's percentage (`istanbul-lib-coverage`'s `percent`), which is what vitest compares a
 * threshold with: floored to two decimals, and 100 for an empty denominator.
 */
export const percent = (covered, total) =>
  total > 0 ? Math.floor((1000 * 100 * covered) / total / 10) / 100 : 100;

/** Two points or two items, whichever is larger — WP-70's slack. */
export const slackPoints = (total) => (total > 0 ? Math.max(2, 200 / total) : 2);

/** The floor WP-70's rule sets for a measured figure: the bar, or `floor(measured − slack)`. */
export const earnedFloor = ({ pct, total, bar }) =>
  Math.min(bar, Math.floor(pct - slackPoints(total)));

/**
 * Per ring and metric: the items covered and total over the summary's files that match the ring's
 * glob, and the percentage vitest would compare with the threshold.
 *
 * @param {Record<string, Record<string, { total: number, covered: number }>>} summary
 * @param {Readonly<Record<string, { glob: string }>>} rings
 * @param {string} root
 * @param {(glob: string) => (path: string) => boolean} matcher
 */
export const ringFigures = (summary, rings, root, matcher) => {
  const files = Object.entries(summary)
    .filter(([path]) => path !== 'total')
    .map(([path, metrics]) => ({ path: relative(root, path).split(sep).join('/'), metrics }));
  return Object.fromEntries(
    Object.entries(rings).map(([name, ring]) => {
      const matches = matcher(ring.glob);
      const members = files.filter((file) => matches(file.path));
      const figures = Object.fromEntries(
        METRICS.map((metric) => {
          const total = members.reduce((sum, file) => sum + (file.metrics[metric]?.total ?? 0), 0);
          const covered = members.reduce(
            (sum, file) => sum + (file.metrics[metric]?.covered ?? 0),
            0,
          );
          return [metric, { covered, total, pct: percent(covered, total) }];
        }),
      );
      return [name, { files: members.length, figures }];
    }),
  );
};

/**
 * Every ring figure the ratchet refuses, as sentences, beside a one-line report per ring.
 *
 * @param {ReturnType<typeof ringFigures>} measured
 * @param {Readonly<Record<string, { thresholds: Record<string, number> }>>} rings
 * @param {(ring: string) => Record<string, number>} barOf
 */
export const ratchetVerdicts = (measured, rings, barOf) => {
  const problems = [];
  const report = [];
  for (const [name, ring] of Object.entries(rings)) {
    const ringMeasured = measured[name];
    if (ringMeasured === undefined || ringMeasured.files === 0) {
      problems.push(`${name}: no file in the summary matches the ring, so nothing was measured`);
      continue;
    }
    const parts = [];
    for (const metric of METRICS) {
      const { pct, total } = ringMeasured.figures[metric];
      const floor = ring.thresholds[metric];
      const earned = earnedFloor({ pct, total, bar: barOf(name)[metric] });
      parts.push(`${metric} ${pct.toFixed(2)} (floor ${floor}, earned ${earned})`);
      if (pct < floor) {
        problems.push(
          `${name} ${metric}: measured ${pct.toFixed(2)} is below its floor ${floor} — cover what the change added, or lower the floor in vitest.config.ts and technical/10's table with the measurement in PROGRESS.md`,
        );
      } else if (floor < earned) {
        problems.push(
          `${name} ${metric}: measured ${pct.toFixed(2)} has earned a floor of ${earned} (min(bar, floor(measured − slack ${slackPoints(total).toFixed(2)}))) and the floor is ${floor} — re-pin it to ${earned} in vitest.config.ts and technical/10's table`,
        );
      }
    }
    report.push(`${name}: ${parts.join(' | ')}`);
  }
  return { problems, report };
};

/**
 * Whether the summary is this checkout's whole run: every counted file present, none foreign.
 *
 * @param {Record<string, unknown>} summary
 * @param {string} root
 * @param {readonly string[]} counted repository-relative paths coverage counts
 */
export const summaryProvenanceProblems = (summary, root, counted) => {
  const paths = Object.keys(summary).filter((path) => path !== 'total');
  const relativePaths = new Set(paths.map((path) => relative(root, path).split(sep).join('/')));
  const foreign = paths.filter((path) => relative(root, path).startsWith('..'));
  const missing = counted.filter((path) => !relativePaths.has(path));
  const problems = [];
  if (paths.length === 0) problems.push('the summary lists no file');
  if (foreign.length > 0) {
    problems.push(
      `the summary measured ${foreign.length} file(s) outside this checkout (first: ${foreign[0]}) — another checkout's run`,
    );
  }
  if (missing.length > 0) {
    problems.push(
      `the summary lacks ${missing.length} file(s) this checkout counts (first: ${missing[0]}) — a run of another tree or another configuration`,
    );
  }
  return problems;
};

/** A summary written before the target started is a previous run's. */
export const freshnessProblem = (writtenAtMs, startedAt) => {
  if (startedAt === undefined || startedAt === '') return null;
  const started = Number(startedAt);
  if (!Number.isFinite(started)) return `${STARTED_AT_VARIABLE} is not a number: ${startedAt}`;
  return writtenAtMs < started
    ? `the summary was written at ${new Date(writtenAtMs).toISOString()}, before this target started at ${new Date(started).toISOString()} — it is a previous run's, and this run wrote none`
    : null;
};

/** vitest's own `picomatch`, as `coverage-budget.test.ts` uses it: the matcher vitest applies. */
export const vitestPicomatch = () =>
  createRequire(fileURLToPath(import.meta.resolve('vitest')))('picomatch');

/**
 * The whole check, without the process around it: reads the summary at `summaryPath`, refuses one
 * that is not this run's, and judges every ring. Returns the exit code and what to print.
 *
 * @param {{
 *   root: string,
 *   summaryPath: string,
 *   startedAt: string | undefined,
 *   config: { default: { test: { coverage: { include: string[], exclude: string[] } } }, COVERAGE_RINGS: Record<string, { glob: string, thresholds: Record<string, number> }>, coverageBarOf: (ring: string) => Record<string, number> },
 *   picomatch: (glob: string | readonly string[]) => (path: string) => boolean,
 *   now?: number,
 * }} input
 */
export const ratchet = ({ root, summaryPath, startedAt, config, picomatch, now = Date.now() }) => {
  const failed = (code, err) => ({ code, err, out: 'FAIL: coverage:ratchet' });
  let summary;
  let writtenAtMs;
  try {
    summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
    writtenAtMs = statSync(summaryPath).mtimeMs;
  } catch (error) {
    return failed(2, [
      `could not read ${COVERAGE_SUMMARY}: ${error.message} — run \`pnpm test\` first`,
    ]);
  }
  const coverage = config.default.test.coverage;
  const included = picomatch(coverage.include);
  const excluded = picomatch(coverage.exclude);
  const counted = censusPaths(root, {
    include: (path) => path.endsWith('.ts') && included(path) && !excluded(path),
  });
  const refused = [
    freshnessProblem(writtenAtMs, startedAt),
    ...summaryProvenanceProblems(summary, root, counted),
  ].filter((problem) => problem !== null);
  if (refused.length > 0) return failed(2, [`${COVERAGE_SUMMARY} is not this run's:`, ...refused]);

  const measured = ringFigures(summary, config.COVERAGE_RINGS, root, picomatch);
  const { problems, report } = ratchetVerdicts(
    measured,
    config.COVERAGE_RINGS,
    config.coverageBarOf,
  );
  if (problems.length > 0) {
    return failed(1, [...report, `${problems.length} ring figure(s) refused:`, ...problems]);
  }
  const age =
    startedAt === undefined ? `, summary ${Math.round((now - writtenAtMs) / 1000)} s old` : '';
  const rings = Object.keys(config.COVERAGE_RINGS).length;
  return {
    code: 0,
    err: report,
    out: `PASS: coverage:ratchet (${rings} rings × 4 metrics over ${counted.length} files: none below its floor, none above it by more than the slack${age})`,
  };
};

const main = async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  await import('./ts-source-resolver.mjs');
  const config = await import('../vitest.config.ts');
  const result = ratchet({
    root,
    summaryPath: join(root, COVERAGE_SUMMARY),
    startedAt: process.env[STARTED_AT_VARIABLE],
    config,
    picomatch: vitestPicomatch(),
  });
  for (const line of result.err) process.stderr.write(`${line}\n`);
  process.stdout.write(`${result.out}\n`);
  process.exit(result.code);
};

if (isProgram(import.meta.url)) {
  await main();
}

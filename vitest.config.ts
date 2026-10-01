import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { nestedCheckoutExcludes } from './scripts/nested-checkouts.js';

const repositoryRoot = fileURLToPath(new URL('.', import.meta.url));

/**
 * Excluded by **every** project, and by coverage.
 *
 * It is one constant spread into every project rather than a list per project, because that is what
 * makes "a new project inherits the scoping" true by construction instead of by review, and the
 * spread at the end of it is the reason it exists.
 *
 * `nestedCheckoutExcludes` asks the filesystem which directories under this root belong to another
 * checkout — a linked worktree, a nested clone, a submodule — and excludes each. Without it the
 * leading `**` of the `integration` and `e2e-fake-claude` includes reaches into
 * `.claude/worktrees/agent-<id>/`, where this repository's own agent worktrees live, and a
 * verification run reports on code that is not in this checkout. Measured with one agent worktree
 * nested here: `integration` collected 24 files of which 12 were the other checkout's, and
 * `e2e-fake-claude` 4 of which 2 were; with the exclusion, 12 and 2. See
 * `scripts/nested-checkouts.ts` for why the rule is "a directory holding a `.git` entry" rather
 * than a `.claude/worktrees` constant.
 *
 * The anchored projects — `unit`, `contract`, `ui` — cannot reach `.claude/worktrees/`, and were
 * measured not to: 142/20/16 files either way with a worktree present. They are covered anyway,
 * because an anchor is only safe against *where the harness happens to put a checkout today*. A
 * nested checkout planted under `packages/` and `apps/web/src/` **is** collected by them, measured
 * as 143/21/17 against this checkout's 142/20/16. Being anchored is not the same as being scoped.
 *
 * Those five projects were the whole audit. The sixth, `process` (WP-69), names its files one by
 * one ({@link PROCESS_SUITES}) and so cannot collect another checkout's, and carries the exclusions
 * anyway for the reason above. There is no root-level `include`: with `projects` set
 * the root config collects nothing of its own, and the only other glob list in this file is
 * `coverage.include`, which is anchored and carries these exclusions too — `all: true` would
 * otherwise pull another checkout's sources into the denominator of every threshold.
 */
const excludeEverywhere = [
  '**/node_modules/**',
  '**/dist/**',
  '**/coverage/**',
  ...nestedCheckoutExcludes(repositoryRoot),
];

/**
 * The seed every fast-check property draws from, set before each test file by this setup file
 * (WP-97, PROGRESS backlog 270) — `scripts/property-seed.mjs` has the decision: the gate's fixed
 * seed, or `PROPERTY_SEED` for the weekly exploration run and a replay of what it found.
 *
 * In **every** project, for the reason {@link excludeEverywhere} is one constant: a new project
 * inherits it by construction. `scripts/property-seed.test.ts` holds that, and that no file sets a
 * seed of its own.
 */
export const PROPERTY_SEED_SETUP = 'test/support/property-seed.ts';

/**
 * The suites that start **real processes** and wait on them structurally (WP-69, PROGRESS backlog
 * 25) — the `process` project's whole membership.
 *
 * A structural wait asserts that something happens (a socket is bound, a pid file is written, a pid
 * disappears), and how long it takes is **process scheduling**: exactly the quantity the parallel
 * `unit`+`contract` run moves by an order of magnitude on a busy host. The conformance suite failed
 * a push at a one-minute load of 12.63 and again at 7.97 inside that run, and passed alone. So these
 * files do not run inside it: the `process` project runs them **after** it (`groupOrder: 1`), **one
 * file at a time** (`fileParallelism: false`), under a `testTimeout` of their own — the same answer
 * `integration` and `e2e-fake-claude` already give to suites that own real resources. The waits
 * take their deadline from the running test's budget (`structural-wait.ts`), so a wait that runs
 * out still fails first and names its component.
 *
 * Still a step of `verify` and of CI's unit job: `pnpm test` names all three projects in one run,
 * so coverage is one report and the pre-push hook runs these files too. `scripts/verify.test.ts`
 * holds that every project here is run by some verification target, and that this list is exactly
 * the test files importing `structural-wait.js` — so the list cannot drift from what uses it.
 */
export const PROCESS_SUITES = [
  'packages/infrastructure/src/runlet/conformance.contract.test.ts',
  'packages/infrastructure/src/runlet/shim.test.ts',
  'packages/infrastructure/src/runlet/structural-wait.test.ts',
];

/** What coverage measures: the source rings the `unit`, `contract` and `process` projects reach. */
export const COVERAGE_INCLUDE = [
  'packages/*/src/**/*.ts',
  'apps/server/src/**/*.ts',
  'apps/launcher/src/**/*.ts',
  'apps/runlet/src/**/*.ts',
];

/** A source file taken out of the coverage denominator, and the evidence that nothing is hidden. */
export interface CoverageExclusion {
  readonly path: string;
  /** Why it has nothing a counted tier could assert — the only two kinds admitted so far. */
  readonly kind: 'process entrypoint' | 'database reads';
  /** The file that drives it, which names it; `scripts/coverage-budget.test.ts` reads both. */
  readonly exercisedBy: string;
  /**
   * Which tier that is — and so whether `verify` runs it. `process` and `unit` are inside `verify`
   * (a `unit` driver starts the file as a subprocess, which reports no coverage to the run that
   * started it); `integration` gates on `verify:integration`, and `image` on nothing but the image
   * starting.
   */
  readonly tier: 'process' | 'unit' | 'integration' | 'image';
}

/**
 * The files coverage does not count (WP-70, PROGRESS backlog 115) — **a census, not a list**:
 * `scripts/coverage-budget.test.ts` pins these paths in both directions, checks that each
 * `exercisedBy` file exists and names the excluded one, and that `coverage.exclude` holds nothing
 * else by path. So a new entry is a decision somebody makes in two files rather than a line somebody
 * adds under a precedent.
 *
 * Every entry says **which tier** drives it, and two of the four are tiers `verify` does not run —
 * which is the honest shape of an exclusion: the code is exercised somewhere, just not where the
 * number is counted. The other two are driven inside `verify`, as subprocesses, which is why their
 * lines are still not counted.
 *
 * `packages/infrastructure/src/db/client.ts` **was** on this list, as a pool with no branch of its own
 * exercised only by the integration tier; since the `'error'` listener fix its unit test
 * (`db/pool-errors.test.ts`) builds the pool itself, so the tier coverage counts reaches it and it is
 * counted again (WP-70).
 */
export const COVERAGE_EXCLUDED_FILES: readonly CoverageExclusion[] = [
  {
    // The one-shot `migrate` CLI: environment in, one JSON line per step out, exit code. Its two
    // failure exit codes are asserted by starting it as a process from the unit tier (PROGRESS
    // backlog 252), which reports no coverage back; its success path is the image's — compose's
    // `migrate` service runs this exact file — while the integration harness calls `runMigrations`
    // directly.
    path: 'apps/server/src/migrate.ts',
    kind: 'process entrypoint',
    exercisedBy: 'apps/server/src/migrate.test.ts',
    tier: 'unit',
  },
  {
    // The launcher's process entrypoint: environment in, signals mapped, `process.exit` out. Every
    // decision it could get wrong is in `runtime.ts`, which the unit tier drives; this file is run
    // by the launcher image's `CMD` and by no test.
    path: 'apps/launcher/src/index.ts',
    kind: 'process entrypoint',
    exercisedBy: 'docker/launcher.Dockerfile',
    tier: 'image',
  },
  {
    // The run shim's entrypoint: `process.env` in, `process.exit` out, every decision delegated to
    // `packages/infrastructure/src/runlet`. The conformance suite starts this exact file as a real
    // process against a real socket, in the `process` project (WP-69) — inside `verify` — and a
    // subprocess reports no coverage to the run that started it.
    path: 'apps/runlet/src/index.ts',
    kind: 'process entrypoint',
    exercisedBy: 'packages/infrastructure/src/runlet/conformance.contract.test.ts',
    tier: 'process',
  },
  {
    // WP-41's statistics reads: fourteen SQL statements and their row mappers, nothing a unit test
    // could reach without a database. They are driven by the **integration** tier, which collects
    // no coverage and which `verify` does not run (`verify:integration` does). The one branch that
    // was not a `where` clause — the refusal of a range holding more than `MAX_TASK_ROWS` tasks —
    // moved to `boundTaskRows` in `queries/stats-metrics.ts` (WP-70), which is counted, and whose
    // unit case asserts both kinds at the bound; the integration tier asserts both call sites.
    path: 'apps/server/src/queries/stats-queries.ts',
    kind: 'database reads',
    exercisedBy: 'test/integration/stats/stats-queries.integration.test.ts',
    tier: 'integration',
  },
];

interface CoverageThresholds {
  readonly branches: number;
  readonly lines: number;
  readonly functions: number;
  readonly statements: number;
}

/** The bar technical/10 sets for every ring but the domain's. */
const COVERAGE_BAR: CoverageThresholds = { lines: 80, branches: 80, functions: 80, statements: 80 };
/** The domain ring's bar: technical/10's 90 % lines / 85 % branches / 90 % functions / 90 % statements. */
const DOMAIN_COVERAGE_BAR: CoverageThresholds = {
  lines: 90,
  branches: 85,
  functions: 90,
  statements: 90,
};

/**
 * The bar a ring is held to when it clears it by the slack — read by the census (`owes` below the
 * bar) and by the ratchet (`scripts/coverage-ratchet.mjs`, a floor never needs to exceed it), so
 * the two numbers have one home.
 */
export const coverageBarOf = (ring: string): CoverageThresholds =>
  ring === 'domain' ? DOMAIN_COVERAGE_BAR : COVERAGE_BAR;

/**
 * The coverage budget, **per ring** (WP-70, PROGRESS backlog 87) — where coverage is owed, rather
 * than one average that lets the rings which carry it hide the rings which owe it.
 *
 * **Why not one global number.** The measurement that opened WP-70 (technical/10 § Coverage and
 * gates has the table) put the global branch figure at 80.02 % against 80, and every ring's number
 * is a weighted part of it: `packages/application` at 84 % and `packages/integrations` at 86 % were
 * paying for `apps/server` at 57 % and `packages/infrastructure` at 70 %. A module added anywhere
 * moved a gate nobody in that ring could see, and so did noise: WP-70's own runs over one tree
 * moved by two branches inside `packages/domain/src/cost/ledger.ts`, which a then-unseeded
 * property test reached on some draws and not others (every property is seeded since WP-97,
 * {@link PROPERTY_SEED_SETUP}). vitest counts every file into the global figure even when a glob
 * already holds it (`resolveThresholds`, vitest 5.0.0), so a global threshold cannot be kept beside
 * these without re-importing all of that; it is **not** set. `text-summary` still prints it.
 *
 * **The rule every number below follows.** Each ring is held to the bar technical/10 sets (80, and
 * the domain's 90/85/90/90) where its measured figure clears that bar by the slack, and otherwise to
 * `floor(measured − slack)`, where slack is **two points or two items, whichever is larger** — so a
 * three-file ring is not held to one branch. A threshold under the bar is **debt, named**: the
 * `owes` line says which files carry it. Paying it raises the number; nothing lowers one without a
 * measurement that says why.
 *
 * **Two checks hold that rule since WP-97** (PROGRESS backlog 254). The census
 * (`scripts/coverage-budget.test.ts`) pins every threshold here to technical/10's *pinned floors*
 * table, in both directions, so a floor moves only by an edit in two places. The ratchet
 * (`scripts/coverage-ratchet.mjs`, the step after `test` in `verify:tests`) reads the run's
 * measured figures and fails a ring below its floor, or one that has earned
 * `min(bar, floor(measured − slack))` above its floor without a re-pin — the rule above read
 * backwards, so re-pinning to what it names always passes.
 *
 * **The runlet ring.** The run shim's modules (`packages/infrastructure/src/runlet/`) are the files
 * the `process` project covers, whose covered branches can depend on process scheduling, so they
 * are a ring of their own and their noise lands on their own gate: 83.74 % against 80 is thirteen
 * branches of margin, and no run WP-70 made moved one of them.
 *
 * **Test support is a ring of its own**, not part of the product rings' denominators: the in-memory
 * doubles and the harness under `packages/*\/src/testing/` and the `testing.ts` modules are imported
 * by no production module (a grep, WP-70 — nothing enforces it), and counting them inside
 * `packages/application` raised that ring from 84.41 % to 85.33 % branches. They are still
 * measured, because the harness is code the tests trust.
 *
 * `scripts/coverage-budget.test.ts` holds the partition: every file coverage counts matches
 * **exactly one** ring's glob, so a new directory cannot fall between two rings or into none.
 *
 * **`!(x)` is a prefix refusal, not a name refusal** (picomatch 4.0.7, PROGRESS backlog 255): it
 * rejects every name that *begins* with `x`, so a directory `runlet2/` or a file `testing2.ts`
 * matches **no** ring below and the partition census fails naming it with `rings: []`. The file is
 * not at fault then; the glob is — rewrite it with an explicit exclusion of the one directory or
 * file (`runlet/`, `testing/`, `testing.ts`) rather than renaming the newcomer.
 */
export const COVERAGE_RINGS: Readonly<
  Record<
    string,
    { readonly glob: string; readonly thresholds: CoverageThresholds; readonly owes?: string }
  >
> = {
  domain: {
    glob: 'packages/domain/src/{!(testing).ts,!(testing)/**/!(testing).ts}',
    thresholds: { lines: 90, branches: 85, functions: 90, statements: 90 },
  },
  contracts: {
    glob: 'packages/contracts/src/{!(testing).ts,!(testing)/**/!(testing).ts}',
    thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 },
  },
  application: {
    glob: 'packages/application/src/{!(testing).ts,!(testing)/**/!(testing).ts}',
    thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 },
  },
  integrations: {
    glob: 'packages/integrations/src/{!(testing).ts,!(testing)/**/!(testing).ts}',
    thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 },
  },
  prompts: {
    glob: 'packages/prompts/src/{!(testing).ts,!(testing)/**/!(testing).ts}',
    thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 },
  },
  infrastructure: {
    glob: 'packages/infrastructure/src/{!(testing).ts,!(runlet|testing)/**/!(testing).ts}',
    thresholds: { lines: 79, branches: 68, functions: 66, statements: 78 },
    owes: 'branches: 1012 uncovered (WP-97), 652 of them in the `postgres-*` stores, which the integration tier drives against PostgreSQL 18 and collects no coverage from; then `workspace/` 104 and `runner/` 103',
  },
  runlet: {
    glob: 'packages/infrastructure/src/runlet/{**/,}!(testing).ts',
    thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 },
  },
  server: {
    glob: 'apps/server/src/**/*.ts',
    thresholds: { lines: 65, branches: 57, functions: 54, statements: 64 },
    owes: 'branches: 1118 uncovered (WP-97) — `queries/*.ts` 476, `routes/*` 310, `runtime.ts` 116, `knowledge.ts` 44, `pipeline.ts` 40: SQL and composition the integration and e2e tiers drive, uncounted',
  },
  launcher: {
    glob: 'apps/launcher/src/**/*.ts',
    thresholds: { lines: 80, branches: 80, functions: 78, statements: 80 },
    owes: 'functions: 10 of 55 (WP-97) — `logging.ts` 6, `runtime.ts` 3, `export-retention.ts` 1 — and two items of slack is 3.64 points here',
  },
  'test support': {
    glob: 'packages/*/src/{testing/**/*.ts,**/testing.ts}',
    thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 },
  },
};

/**
 * Test tiers per docs/technical/10-testing-strategy.md.
 *
 *   unit             fast, no container — domain ring, policies, pure adapters. Two files do real
 *                    filesystem I/O in a temp directory on purpose, and say so at the top:
 *                    `scripts/check-ignored.test.ts` and
 *                    `packages/infrastructure/src/runner/path-guard.filesystem.test.ts`, whose
 *                    whole point is which names the running volume treats as one file.
 *   contract         integration-type ports against fakes / recorded fixtures
 *   process          the suites that start real processes ({@link PROCESS_SUITES}), after the
 *                    two above and one file at a time, in the same `pnpm test` run
 *   integration      Testcontainers + PGlite database suites
 *   e2e-fake-claude  one ticket through the pipeline with the fake Claude runner
 *   ui               web app reducers/components (happy-dom) — Playwright lives separately
 *
 * The tiers map onto the verification contract in
 * docs/technical/14-orchestration-protocol.md via `scripts/verify.mjs`.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          setupFiles: [PROPERTY_SEED_SETUP],
          environment: 'node',
          include: [
            'packages/*/src/**/*.test.ts',
            'apps/server/src/**/*.test.ts',
            'apps/launcher/src/**/*.test.ts',
            'apps/runlet/src/**/*.test.ts',
            // The verification scripts are part of the build's correctness, and one of them —
            // `check-ignored.mjs` — is the only thing standing between an unanchored `.gitignore`
            // pattern and a pushed tree that does not compile. It is tested against real
            // repositories it builds in a temp directory, so it is I/O-bound in a way the rest of
            // this tier is not, but it needs no container and no fixture data.
            'scripts/**/*.test.ts',
          ],
          exclude: [
            ...excludeEverywhere,
            '**/*.contract.test.ts',
            '**/*.integration.test.ts',
            '**/*.e2e.test.ts',
            ...PROCESS_SUITES,
          ],
        },
      },
      {
        test: {
          name: 'contract',
          setupFiles: [PROPERTY_SEED_SETUP],
          environment: 'node',
          include: ['packages/*/src/**/*.contract.test.ts', 'test/contract/**/*.test.ts'],
          exclude: [...excludeEverywhere, ...PROCESS_SUITES],
        },
      },
      {
        test: {
          name: 'process',
          setupFiles: [PROPERTY_SEED_SETUP],
          environment: 'node',
          include: PROCESS_SUITES,
          exclude: excludeEverywhere,
          // After `unit` and `contract` (group 0) have finished, and one file at a time: the host's
          // scheduler is then this file's, not five thousand other tests'.
          sequence: { groupOrder: 1 },
          fileParallelism: false,
          // The budget the structural waits take their share of. Generous on purpose: it bounds a
          // wait for something structural, never a duration, so a dead component still fails at
          // the speed it dies wherever a test asserts the death, and what this number decides is
          // only how long a slow host is given before a wait names what it was waiting for.
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
      {
        test: {
          name: 'integration',
          setupFiles: [PROPERTY_SEED_SETUP],
          environment: 'node',
          include: ['**/*.integration.test.ts', 'test/integration/**/*.test.ts'],
          exclude: excludeEverywhere,
          // One PostgreSQL 18 container serves the whole project; each file gets its own database
          // inside it (test/integration/support/postgres.ts).
          globalSetup: ['test/integration/support/global-setup.ts'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
      {
        test: {
          name: 'e2e-fake-claude',
          setupFiles: [PROPERTY_SEED_SETUP],
          environment: 'node',
          include: ['**/*.e2e.test.ts', 'test/e2e/**/*.test.ts'],
          exclude: excludeEverywhere,
          // The e2e tier runs whole `apps/server` instances against a real PostgreSQL 18, so it
          // needs the same container the integration tier uses. technical/10 describes this tier as
          // running against `docker compose` (app + db), and `compose.yml` exists — but the tier
          // deliberately does **not** use it: Testcontainers gives the same coverage ("the app in
          // this process against a real database") without building the product image on every run,
          // and it is the database this tier needs rather than the packaging. What *is* asserted
          // against the real images lives in the tier too — `test/e2e/workspace/` drives
          // `platform-runtime` and `platform-egress` through the real provider, and
          // `test/e2e/compose/` reads the compose file itself.
          globalSetup: ['test/integration/support/global-setup.ts'],
          testTimeout: 180_000,
          hookTimeout: 180_000,
        },
      },
      {
        test: {
          name: 'ui',
          setupFiles: [PROPERTY_SEED_SETUP],
          environment: 'happy-dom',
          include: ['apps/web/src/**/*.test.ts', 'apps/web/src/**/*.test.tsx'],
          exclude: excludeEverywhere,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      // `json-summary` writes `coverage/coverage-summary.json`, the per-file figures the ring table
      // in technical/10 was measured from (WP-70) — so the next reading is a file, not a scrollback.
      reporter: ['text-summary', 'json-summary', 'lcov'],
      reportsDirectory: './coverage',
      include: COVERAGE_INCLUDE,
      exclude: [
        ...excludeEverywhere,
        '**/*.test.ts',
        '**/*.d.ts',
        ...COVERAGE_EXCLUDED_FILES.map((exclusion) => exclusion.path),
      ],
      // Per ring, and **no global threshold** ({@link COVERAGE_RINGS} says why).
      thresholds: Object.fromEntries(
        Object.values(COVERAGE_RINGS).map((ring) => [ring.glob, ring.thresholds]),
      ),
    },
  },
});

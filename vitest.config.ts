import { defineConfig } from 'vitest/config';

/**
 * Test tiers per docs/technical/10-testing-strategy.md.
 *
 *   unit             fast, no container — domain ring, policies, pure adapters. Two files do real
 *                    filesystem I/O in a temp directory on purpose, and say so at the top:
 *                    `scripts/check-ignored.test.ts` and
 *                    `packages/infrastructure/src/runner/path-guard.filesystem.test.ts`, whose
 *                    whole point is which names the running volume treats as one file.
 *   contract         integration-type ports against fakes / recorded fixtures
 *   integration      Testcontainers + PGlite database suites
 *   e2e-fake-claude  one ticket through the pipeline with the fake Claude runner
 *   ui               web app reducers/components (happy-dom) — Playwright lives separately
 *
 * The tiers map onto the verification contract in
 * docs/technical/14-orchestration-protocol.md via `scripts/verify.mjs`.
 */
const defaultExclude = ['**/node_modules/**', '**/dist/**', '**/coverage/**'];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
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
            ...defaultExclude,
            '**/*.contract.test.ts',
            '**/*.integration.test.ts',
            '**/*.e2e.test.ts',
          ],
        },
      },
      {
        test: {
          name: 'contract',
          environment: 'node',
          include: ['packages/*/src/**/*.contract.test.ts', 'test/contract/**/*.test.ts'],
          exclude: defaultExclude,
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['**/*.integration.test.ts', 'test/integration/**/*.test.ts'],
          exclude: defaultExclude,
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
          environment: 'node',
          include: ['**/*.e2e.test.ts', 'test/e2e/**/*.test.ts'],
          exclude: defaultExclude,
          // The e2e tier runs whole `apps/server` instances against a real PostgreSQL 18, so it
          // needs the same container the integration tier uses. technical/10 describes this tier as
          // running against `docker compose` (app + db); the compose file lands with WP-22, and
          // until it does, "the app in this process against a real database" is the same coverage
          // without a second image to build on every run.
          globalSetup: ['test/integration/support/global-setup.ts'],
          testTimeout: 180_000,
          hookTimeout: 180_000,
        },
      },
      {
        test: {
          name: 'ui',
          environment: 'happy-dom',
          include: ['apps/web/src/**/*.test.ts', 'apps/web/src/**/*.test.tsx'],
          exclude: defaultExclude,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      reportsDirectory: './coverage',
      // Explicit include: only the rings exercised by the unit + contract tiers.
      include: [
        'packages/*/src/**/*.ts',
        'apps/server/src/**/*.ts',
        'apps/launcher/src/**/*.ts',
        'apps/runlet/src/**/*.ts',
      ],
      exclude: [
        '**/*.test.ts',
        '**/*.d.ts',
        // Thin I/O shells with no branch of their own: a `pg` pool built from validated config, and
        // the one-shot CLI that maps a report onto stdout. Both are exercised end to end by the
        // `integration` tier, which runs a real PostgreSQL 18 and does not collect coverage.
        'packages/infrastructure/src/db/client.ts',
        'apps/server/src/migrate.ts',
        // The run shim's entrypoint: `process.env` in, `process.exit` out, every decision it makes
        // delegated to `packages/infrastructure/src/runlet`. The contract tier starts this exact
        // file as a real process against a real socket
        // (`packages/infrastructure/src/runlet/conformance.contract.test.ts`), which is the only
        // way to exercise an entrypoint and collects no coverage from a subprocess.
        'apps/runlet/src/index.ts',
      ],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
        // The domain ring carries the strictest budget (technical/10).
        'packages/domain/src/**/*.ts': {
          lines: 90,
          branches: 85,
          functions: 90,
          statements: 90,
        },
      },
    },
  },
});

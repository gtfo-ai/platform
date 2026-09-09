import { defineConfig } from 'vitest/config';

/**
 * Test tiers per docs/technical/10-testing-strategy.md.
 *
 *   unit             fast, no I/O — domain ring, policies, pure adapters
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
      include: ['packages/*/src/**/*.ts', 'apps/server/src/**/*.ts', 'apps/launcher/src/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/*.d.ts',
        // Thin I/O shells with no branch of their own: a `pg` pool built from validated config, and
        // the one-shot CLI that maps a report onto stdout. Both are exercised end to end by the
        // `integration` tier, which runs a real PostgreSQL 18 and does not collect coverage.
        'packages/infrastructure/src/db/client.ts',
        'apps/server/src/migrate.ts',
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

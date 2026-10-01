/**
 * `migrate.ts`'s two failure exit codes, asserted on the process (PROGRESS backlog 252) — and,
 * since WP-106, its refusal of an `APP_JOBS_SCHEMA` it cannot honour (backlog 296), which is the
 * first of its two exit-2 causes.
 *
 * The file is a one-shot entrypoint whose last line sets `process.exitCode`, so importing it would
 * run it; these cases start it the way `pnpm db:migrate` does — `node` with the repository's
 * source resolver — with an environment built here rather than inherited, so a developer's own
 * `DATABASE_URL` cannot turn a refusal into a migration. No Docker and no database: the second
 * case points at a port nothing listens on, which is refused before any SQL is sent.
 *
 * What it does not assert is the success path (exit 0), which needs a database and is the image's
 * and the integration harness's (`runMigrations` directly). Compose reads only zero versus
 * non-zero (`service_completed_successfully`), so the two codes are distinguished here for the
 * operator reading a log, not for any machine.
 */
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));

const runMigrate = (env: Record<string, string>) => {
  const result = spawnSync(
    process.execPath,
    ['--import', './scripts/ts-source-resolver.mjs', 'apps/server/src/migrate.ts'],
    {
      cwd: repositoryRoot,
      env: { PATH: process.env.PATH ?? '', ...env },
      encoding: 'utf8',
      timeout: 60_000,
    },
  );
  const lines = result.stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { level: string; msg: string; error?: string });
  return { status: result.status, lines, stderr: result.stderr };
};

/** A loopback port that was free a moment ago and has nothing listening on it now. */
const closedPort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === 'string') {
    throw new Error('expected a TCP address');
  }
  return address.port;
};

describe('the migrate entrypoint', () => {
  it('exits 2 and names the variable when there is no database configuration', () => {
    const run = runMigrate({});
    expect(run.status, run.stderr).toBe(2);
    expect(run.lines).toEqual([
      expect.objectContaining({
        level: 'error',
        msg: 'invalid database configuration',
        error: expect.stringContaining('DATABASE_URL'),
      }),
    ]);
  });

  /**
   * WP-106 (PROGRESS backlog 296, option (b)): `migrate` installs pg-boss into `pgboss` and reads no
   * variable for another schema, so it refuses an `APP_JOBS_SCHEMA` naming one — before any SQL,
   * naming the variable and itself — rather than installing where no server would look. The
   * environment carries a database URL to a closed port, so only the refusal can produce exit 2.
   */
  it('exits 2 and names APP_JOBS_SCHEMA and migrate when the variable is not pgboss', async () => {
    const port = await closedPort();
    const run = runMigrate({
      APP_JOBS_SCHEMA: 'jobs',
      DATABASE_URL: `postgres://fake:fake@127.0.0.1:${port}/none`,
    });
    expect(run.status, run.stderr).toBe(2);
    expect(run.lines).toEqual([
      expect.objectContaining({
        level: 'error',
        msg: 'invalid jobs configuration',
        error: expect.stringMatching(/^APP_JOBS_SCHEMA is "jobs".*the migrate service installs/),
      }),
    ]);
  });

  it('exits 1 when the configuration is valid and the migration fails', async () => {
    const port = await closedPort();
    const run = runMigrate({ DATABASE_URL: `postgres://fake:fake@127.0.0.1:${port}/none` });
    expect(run.status, run.stderr).toBe(1);
    expect(run.lines.at(-1)).toEqual(
      expect.objectContaining({ level: 'error', msg: 'migration failed' }),
    );
  });
});

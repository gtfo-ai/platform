/**
 * The migrator's control flow, driven against a fake client. Everything here is about *decisions* —
 * lock, order, skip, refuse, degrade — which is exactly what a real database would hide behind a
 * slow round trip. The SQL those decisions emit is proven against PostgreSQL 18 in the
 * `integration` tier.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checksumOf } from './migrations.js';
import {
  DEFAULT_APP_ROLE,
  findUnknownMigrations,
  MIGRATION_LOCK_KEY,
  type MigrateDependencies,
  type MigrateEvent,
  type MigrationClient,
  runMigrations,
} from './migrator.js';

const scratches: string[] = [];
afterAll(() => {
  for (const dir of scratches) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A migrations directory with predictable contents. */
const migrationDir = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), 'platform-migrator-'));
  scratches.push(dir);
  for (const [name, sql] of Object.entries(files)) {
    writeFileSync(join(dir, name), sql);
  }
  return dir;
};

const TWO_MIGRATIONS = {
  '0001_first.sql': 'create table one ();',
  '0002_second.sql': 'create table two ();',
};

interface Recorded {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface FakeState {
  /** Rows already in `platform_migrations`, keyed by name. */
  readonly applied?: Map<string, string>;
  /** What `platform_apply_grants` returns. */
  readonly grantsApplied?: boolean;
  /** Raised on the notice channel as soon as a listener attaches. */
  readonly notices?: readonly string[];
  /** Statement text fragment that should throw when executed. */
  readonly failOn?: string;
}

const fakeClient = (state: FakeState = {}) => {
  const queries: Recorded[] = [];
  let ended = false;
  let noticeListener: ((notice: { message?: string }) => void) | undefined;

  const client: MigrationClient = {
    query: async <R extends Record<string, unknown>>(text: string, values?: readonly unknown[]) => {
      queries.push({ text, values: values ?? [] });
      if (state.failOn !== undefined && text.includes(state.failOn)) {
        throw new Error(`boom: ${state.failOn}`);
      }
      if (text.includes('from platform_migrations')) {
        const rows = [...(state.applied ?? new Map())].map(([name, checksum]) => ({
          name,
          checksum,
        }));
        return { rows: rows as unknown as R[] };
      }
      if (text.includes('platform_ensure_partitions')) {
        return { rows: [{ created: ['events_2026_09'] }] as unknown as R[] };
      }
      if (text.includes('platform_apply_grants')) {
        return { rows: [{ applied: state.grantsApplied ?? true }] as unknown as R[] };
      }
      return { rows: [] };
    },
    on: (_event, listener) => {
      noticeListener = listener;
      for (const message of state.notices ?? []) {
        listener({ message });
      }
      return client;
    },
    end: async () => {
      ended = true;
      await Promise.resolve();
    },
  };

  return {
    client,
    queries,
    texts: () => queries.map((query) => query.text),
    wasEnded: () => ended,
    raiseNotice: (message: string) => noticeListener?.({ message }),
  };
};

const dependencies = (
  client: MigrationClient,
  installJobs: MigrateDependencies['installJobs'] = async () => 40,
): MigrateDependencies => ({
  connect: async () => client,
  installJobs,
});

const collect = () => {
  const events: MigrateEvent[] = [];
  return { events, log: (event: MigrateEvent) => events.push(event) };
};

describe('runMigrations', () => {
  it('takes the advisory lock before it looks at anything, and releases it', async () => {
    const fake = fakeClient();
    const { events, log } = collect();

    await runMigrations(
      {
        connectionString: 'postgres://fake',
        migrationsDirectory: migrationDir(TWO_MIGRATIONS),
        log,
      },
      dependencies(fake.client),
    );

    const first = fake.queries[0];
    expect(first?.text).toContain('pg_advisory_lock');
    expect(first?.values).toEqual([MIGRATION_LOCK_KEY[0], MIGRATION_LOCK_KEY[1]]);
    expect(fake.texts().at(-1)).toContain('pg_advisory_unlock');
    expect(fake.wasEnded()).toBe(true);
    expect(events.map((event) => event.kind).slice(0, 2)).toEqual(['lock_wait', 'lock_acquired']);
  });

  it('applies pending migrations in order, each inside its own transaction', async () => {
    const fake = fakeClient();

    const report = await runMigrations(
      { connectionString: 'postgres://fake', migrationsDirectory: migrationDir(TWO_MIGRATIONS) },
      dependencies(fake.client),
    );

    expect(report.applied).toEqual(['0001_first', '0002_second']);
    expect(report.skipped).toEqual([]);
    const transactional = fake
      .texts()
      .filter((text) => ['begin', 'commit'].includes(text) || text.startsWith('create table'));
    expect(transactional).toEqual([
      'begin',
      'create table one ();',
      'commit',
      'begin',
      'create table two ();',
      'commit',
    ]);
  });

  it('skips a migration already recorded with the same checksum', async () => {
    const dir = migrationDir(TWO_MIGRATIONS);
    const fake = fakeClient({
      applied: new Map([['0001_first', checksumOf('create table one ();')]]),
    });

    const report = await runMigrations(
      { connectionString: 'postgres://fake', migrationsDirectory: dir },
      dependencies(fake.client),
    );

    expect(report.skipped).toEqual(['0001_first']);
    expect(report.applied).toEqual(['0002_second']);
  });

  it('refuses to run when an applied file has been edited (TD-019)', async () => {
    const fake = fakeClient({ applied: new Map([['0001_first', 'a-different-checksum']]) });

    await expect(
      runMigrations(
        { connectionString: 'postgres://fake', migrationsDirectory: migrationDir(TWO_MIGRATIONS) },
        dependencies(fake.client),
      ),
    ).rejects.toThrow(/forward-only/);
    // Still released and closed, so the next container is not locked out.
    expect(fake.texts().at(-1)).toContain('pg_advisory_unlock');
    expect(fake.wasEnded()).toBe(true);
  });

  it('rolls back and names the file when a migration fails', async () => {
    const fake = fakeClient({ failOn: 'create table two' });

    await expect(
      runMigrations(
        { connectionString: 'postgres://fake', migrationsDirectory: migrationDir(TWO_MIGRATIONS) },
        dependencies(fake.client),
      ),
    ).rejects.toThrow(/migration 0002_second failed/);
    expect(fake.texts()).toContain('rollback');
  });

  it('stores the retention window instead of leaving it to the caller of the drop function', async () => {
    const fake = fakeClient();

    const report = await runMigrations(
      {
        connectionString: 'postgres://fake',
        migrationsDirectory: migrationDir(TWO_MIGRATIONS),
        transcriptRetentionDays: 90,
      },
      dependencies(fake.client),
    );

    const update = fake.queries.find((query) => query.text.includes('set retention_days'));
    expect(update?.values).toEqual([90, 'transcripts']);
    expect(report.transcriptRetentionDays).toBe(90);
  });

  it('defaults retention to keep-forever', async () => {
    const fake = fakeClient();

    const report = await runMigrations(
      { connectionString: 'postgres://fake', migrationsDirectory: migrationDir(TWO_MIGRATIONS) },
      dependencies(fake.client),
    );

    const update = fake.queries.find((query) => query.text.includes('set retention_days'));
    expect(update?.values).toEqual([null, 'transcripts']);
    expect(report.transcriptRetentionDays).toBeNull();
  });

  it('applies grants to the default role and reports it', async () => {
    const fake = fakeClient();

    const report = await runMigrations(
      { connectionString: 'postgres://fake', migrationsDirectory: migrationDir(TWO_MIGRATIONS) },
      dependencies(fake.client),
    );

    const grants = fake.queries.find((query) => query.text.includes('platform_apply_grants'));
    expect(grants?.values).toEqual([DEFAULT_APP_ROLE]);
    expect(report.grantsAppliedTo).toBe(DEFAULT_APP_ROLE);
  });

  it('skips the grant step when no application role is configured', async () => {
    const fake = fakeClient();
    const { events, log } = collect();

    const report = await runMigrations(
      {
        connectionString: 'postgres://fake',
        migrationsDirectory: migrationDir(TWO_MIGRATIONS),
        appRole: '',
        log,
      },
      dependencies(fake.client),
    );

    expect(fake.texts().some((text) => text.includes('platform_apply_grants'))).toBe(false);
    expect(report.grantsAppliedTo).toBeNull();
    expect(events.some((event) => event.kind === 'grants')).toBe(false);
    // The definer functions must therefore be locked down by the migration files themselves, not
    // by the grant step — asserted for real in test/integration/db/grants.integration.test.ts.
  });

  it('reports no grants when the role could not be created', async () => {
    const fake = fakeClient({ grantsApplied: false });

    const report = await runMigrations(
      { connectionString: 'postgres://fake', migrationsDirectory: migrationDir(TWO_MIGRATIONS) },
      dependencies(fake.client),
    );

    expect(report.grantsAppliedTo).toBeNull();
  });

  it('forwards server notices, which is how the SQL reports what an operator must fix', async () => {
    const fake = fakeClient({ notices: ['role appuser cannot assume platform_app'] });
    const { events, log } = collect();

    await runMigrations(
      {
        connectionString: 'postgres://fake',
        migrationsDirectory: migrationDir(TWO_MIGRATIONS),
        log,
      },
      dependencies(fake.client),
    );

    expect(events).toContainEqual({
      kind: 'notice',
      message: 'role appuser cannot assume platform_app',
    });
  });

  it('installs pg-boss into its own schema and reports the version', async () => {
    const fake = fakeClient();
    const installs: [string, string][] = [];

    const report = await runMigrations(
      {
        connectionString: 'postgres://fake',
        migrationsDirectory: migrationDir(TWO_MIGRATIONS),
        pgBossSchema: 'jobs',
      },
      dependencies(fake.client, async (connectionString, schema) => {
        installs.push([connectionString, schema]);
        return 41;
      }),
    );

    expect(installs).toEqual([['postgres://fake', 'jobs']]);
    expect(report.pgBossSchema).toBe('jobs');
    expect(report.pgBossSchemaVersion).toBe(41);
  });

  it('still releases the lock when the very first statement fails', async () => {
    const fake = fakeClient({ failOn: 'pg_advisory_lock' });

    await expect(
      runMigrations(
        { connectionString: 'postgres://fake', migrationsDirectory: migrationDir(TWO_MIGRATIONS) },
        dependencies(fake.client),
      ),
    ).rejects.toThrow(/boom/);
    expect(fake.wasEnded()).toBe(true);
  });

  it('creates the partition window after pg-boss and before the grants', async () => {
    const fake = fakeClient();

    const report = await runMigrations(
      {
        connectionString: 'postgres://fake',
        migrationsDirectory: migrationDir(TWO_MIGRATIONS),
        partitionMonthsAhead: 5,
      },
      dependencies(fake.client),
    );

    const ensure = fake.queries.findIndex((query) =>
      query.text.includes('platform_ensure_partitions'),
    );
    const grants = fake.queries.findIndex((query) => query.text.includes('platform_apply_grants'));
    expect(ensure).toBeGreaterThan(-1);
    expect(grants).toBeGreaterThan(ensure);
    expect(fake.queries[ensure]?.values).toEqual([5]);
    expect(report.partitionsCreated).toEqual(['events_2026_09']);
  });
});

describe('findUnknownMigrations', () => {
  /** Answers the two catalogue questions `findUnknownMigrations` asks, and nothing else. */
  const catalogue = (present: boolean, names: string[]): MigrationClient => ({
    query: async <R extends Record<string, unknown>>(text: string) => {
      if (text.includes('to_regclass')) {
        return { rows: [{ present }] as unknown as R[] };
      }
      return { rows: names.map((name) => ({ name })) as unknown as R[] };
    },
    on: () => undefined,
    end: () => Promise.resolve(),
  });

  const known = [{ name: '0001_first', sql: '', checksum: '' }];

  it('reports nothing on a database that has never been migrated', async () => {
    await expect(findUnknownMigrations(catalogue(false, []), known)).resolves.toEqual([]);
  });

  it('reports nothing when the database is at or behind this build', async () => {
    await expect(findUnknownMigrations(catalogue(true, ['0001_first']), known)).resolves.toEqual(
      [],
    );
  });

  it('names the migrations this build does not know about (TD-019 downgrade guard)', async () => {
    await expect(
      findUnknownMigrations(catalogue(true, ['0001_first', '0099_from_the_future']), known),
    ).resolves.toEqual(['0099_from_the_future']);
  });
});

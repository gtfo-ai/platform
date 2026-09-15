/**
 * WP-03 acceptance: the Testcontainers migration test.
 *
 * Proves the properties `migrate` promises (TD-019): it applies the schema on an empty database,
 * it is idempotent, it refuses to run when an applied file has been edited, and two of them
 * starting at once serialise on the advisory lock instead of racing.
 */
import { db } from '@platform/infrastructure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestDatabase, withClient } from '../support/postgres.js';

/** Every table technical/03 specifies, plus the migrator's own two. */
const EXPECTED_TABLES = [
  // WP-06: the two tables Better Auth needs that technical/03 does not name (TD-022,
  // migration 0011). `users` and `sessions` existed already and gained columns.
  'accounts',
  'approvals',
  'artifacts',
  'bindings',
  'blobs',
  'budget_windows',
  'budgets',
  'code_files',
  'code_maps',
  'config_audit',
  'cost_entries',
  'cost_rollup_daily',
  // WP-04: the dispatch queue TD-005's outbox needs (migration 0010).
  'event_dispatch',
  'event_streams',
  'events',
  'handler_executions',
  'human_actions',
  // WP-35, migration 0030: what an operator asked the history bootstrap for, and one row per
  // mining run of it. product/19 §18's *"batches of ~20 MRs per Sonnet 5 run"* is a set of runs,
  // and nothing in this schema described one.
  'history_bootstrap_batches',
  'history_bootstrap_chunks',
  'human_time_entries',
  'inbox',
  'integration_actions',
  'integration_idempotency',
  'integrations',
  'kb_chunks',
  'kb_documents',
  'kb_health_reports',
  'kb_index_state',
  'kb_links',
  'kb_proposals',
  'notifications',
  'organizations',
  'platform_migrations',
  'platform_table_policy',
  'price_list',
  'project_members',
  'projects',
  'questions',
  'readiness_evaluations',
  'redaction_log',
  'run_context_pack',
  'run_messages',
  'run_model_usage',
  'runs',
  'secrets',
  'sessions',
  // WP-34, migration 0029: the set of tickets somebody selected on one day, and what each was
  // compared against. `shadow_reports` is a row per **task** and cannot express a batch, which is
  // what product/19 §13's *"aggregate report per shadow batch"* is about.
  'shadow_batch_tickets',
  'shadow_batches',
  'shadow_reports',
  // WP-31 (migration 0024): the ask-the-task thread product/10:57 asks for. `questions` is a
  // *stage's* request for human input (technical/02:24), the opposite direction, so a human's
  // question to the platform had no home anywhere in this schema.
  'task_asks',
  'task_stages',
  'tasks',
  // WP-40 (migration 0033): the epic split's queue, one row per proposed child ticket. `approvals`
  // cannot express it — a breakdown is N independent decisions and an approval is one (Q85).
  'ticket_breakdown_items',
  'user_identities',
  'users',
  'verifications',
  'workspaces',
];

const PARTITIONED_TABLES = [
  'config_audit',
  'cost_entries',
  'events',
  'integration_actions',
  'redaction_log',
  'run_messages',
];

describe('migrate on an empty PostgreSQL 18', () => {
  let database: MigratedDatabase;

  beforeAll(async () => {
    database = await createMigratedDatabase('migrations');
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('applies every migration file exactly once and reports what it did', () => {
    const names = db.loadMigrations().map((migration) => migration.name);
    expect(names.length).toBeGreaterThan(0);
    expect(database.report.applied).toEqual(names);
    expect(database.report.skipped).toEqual([]);
    expect(database.report.grantsAppliedTo).toBe('platform_app');
  });

  it('creates every table technical/03 specifies and nothing else', async () => {
    const tables = await withClient(database.connectionString, async (client) => {
      const { rows } = await client.query<{ relname: string }>(
        `select c.relname
           from pg_class c
          where c.relnamespace = 'public'::regnamespace
            and c.relkind in ('r', 'p')
            and not c.relispartition`,
      );
      // Sorted here rather than in SQL: the database's collation decides where `event_streams`
      // falls relative to `events`, and that differs between locales.
      return rows.map((row) => row.relname).sort();
    });

    expect(tables).toEqual([...EXPECTED_TABLES].sort());
  });

  it('partitions the six append-only tables by month', async () => {
    const partitioned = await withClient(database.connectionString, async (client) => {
      const { rows } = await client.query<{ relname: string; strategy: string }>(
        `select c.relname, p.partstrat as strategy
           from pg_class c
           join pg_partitioned_table p on p.partrelid = c.oid
          where c.relnamespace = 'public'::regnamespace
          order by c.relname`,
      );
      return rows;
    });

    expect(partitioned.map((row) => row.relname)).toEqual(PARTITIONED_TABLES);
    // 'r' = range partitioning.
    expect(partitioned.every((row) => row.strategy === 'r')).toBe(true);
  });

  it('records the storage policy of every table that declares one', async () => {
    const policy = await withClient(database.connectionString, async (client) => {
      const { rows } = await client.query<{
        table_name: string;
        app_access: string;
        partition_column: string | null;
        retention_scope: string | null;
        retention_days: number | null;
      }>('select * from platform_table_policy');
      // Sorted here, not in SQL: the collation decides where `event_streams` falls.
      return rows.sort((a, b) => (a.table_name < b.table_name ? -1 : 1));
    });

    const row = (
      table_name: string,
      app_access: string,
      partition_column: string | null,
      retention_scope: string | null = null,
    ) => ({ table_name, app_access, partition_column, retention_scope, retention_days: null });

    expect(policy).toEqual([
      // WP-06 (migration 0011): read_write is the default for an unregistered table, so these four
      // change no privilege — they are here because "the registry lists every table" is only
      // useful as an invariant if it is actually true.
      row('accounts', 'read_write', null),
      row('config_audit', 'append_only', 'created_at'),
      row('cost_entries', 'append_only', 'created_at'),
      // Registered read_write on purpose: the dispatcher claims, defers and deletes its own queue
      // rows. `handler_executions` is unregistered and therefore read_write too — technical/03
      // does not list it among the append-only tables, because the dispatcher updates a row's
      // status and attempt count in place as it works.
      row('event_dispatch', 'read_write', null),
      row('event_streams', 'read_only', null),
      row('events', 'append_only', 'occurred_at'),
      // WP-35 (migration 0030): a batch moves through three statuses and a chunk is stamped once by
      // the recorder, so both are read_write.
      row('history_bootstrap_batches', 'read_write', null),
      row('history_bootstrap_chunks', 'read_write', null),
      row('human_actions', 'append_only', null),
      // WP-29 (migration 0025): the human-time projection. `read_write` because a **review** entry
      // is a window that grows — the first comment opens it and every later activity moves its
      // ending — and registered rather than defaulted so the "registry lists every table"
      // invariant above stays true. It is the first row this table has ever had a writer for.
      row('human_time_entries', 'read_write', null),
      // WP-15c (migration 0014): `inbox` was the one table 0005 created without registering it, and
      // the access it needs is the default — so the row changes no privilege and closes the gap in
      // the registry that made the omission invisible.
      row('inbox', 'read_write', null),
      row('integration_actions', 'append_only', 'created_at'),
      // WP-15b (migration 0013): read_write, because nothing expires an idempotency key today and
      // whatever eventually does will delete rows. Registered rather than defaulted, so the
      // "registry lists every table" invariant above stays true.
      row('integration_idempotency', 'read_write', null),
      // WP-32 (migration 0023): the notification outbox. `read_write` because a row is updated
      // twice at most — claimed by a digest, then delivered — and registered rather than defaulted
      // so the "registry lists every table" invariant above stays true.
      row('notifications', 'read_write', null),
      row('redaction_log', 'append_only', 'created_at'),
      row('run_messages', 'append_only', 'created_at', 'transcripts'),
      row('sessions', 'read_write', null),
      // WP-31 (migration 0024): the ask-the-task thread. `read_write` because a row is updated at
      // most three times — the run is attached, the answer is stored, the ticket mirror is stamped.
      row('task_asks', 'read_write', null),
      // WP-40 (migration 0033): the epic-split queue. `read_write` because a row is written once by
      // the stage's handler, moved once by a human's decision and stamped once by the duty.
      row('ticket_breakdown_items', 'read_write', null),
      row('users', 'read_write', null),
      row('verifications', 'read_write', null),
    ]);
  });

  it('records the retention window the operator configured, not a caller argument', async () => {
    // Null here means keep forever (Q13); the drop function reads this row, never a parameter.
    expect(database.report.transcriptRetentionDays).toBeNull();

    const configured = await createTestDatabase('retention');
    try {
      const report = await db.runMigrations({
        connectionString: configured.connectionString,
        transcriptRetentionDays: 45,
      });
      expect(report.transcriptRetentionDays).toBe(45);

      const stored = await withClient(configured.connectionString, async (client) => {
        const { rows } = await client.query<{ retention_days: number | null }>(
          "select retention_days from platform_table_policy where retention_scope = 'transcripts'",
        );
        return rows.map((r) => r.retention_days);
      });
      expect(stored).toEqual([45]);
    } finally {
      await configured.drop();
    }
  });

  it('installs the pg-boss schema in the same database (TD-004)', async () => {
    expect(database.report.pgBossSchemaVersion).toBeGreaterThan(0);

    const jobTables = await withClient(database.connectionString, async (client) => {
      const { rows } = await client.query<{ count: string }>(
        "select count(*)::text as count from pg_class where relnamespace = 'pgboss'::regnamespace and relkind in ('r','p')",
      );
      return Number(rows[0]?.count ?? '0');
    });

    expect(jobTables).toBeGreaterThan(0);
  });

  it('seeds the price list from the verified table (BD-011)', async () => {
    const prices = await withClient(database.connectionString, async (client) => {
      const { rows } = await client.query<{
        model_id: string;
        input: string;
        output: string;
        cache_write_5m: string;
        cache_write_1h: string;
        cache_read: string;
        batch_multiplier: string;
      }>(
        'select model_id, input, output, cache_write_5m, cache_write_1h, cache_read, batch_multiplier from price_list order by model_id',
      );
      return rows;
    });

    expect(prices.map((row) => row.model_id)).toEqual([
      'claude-fable-5-1',
      'claude-haiku-4-5',
      'claude-opus-5',
      'claude-sonnet-5',
    ]);

    const opus = prices.find((row) => row.model_id === 'claude-opus-5');
    expect(Number(opus?.input)).toBe(5);
    expect(Number(opus?.output)).toBe(25);
    // 1.25x / 2x / 0.1x of base input (research/04).
    expect(Number(opus?.cache_write_5m)).toBe(6.25);
    expect(Number(opus?.cache_write_1h)).toBe(10);
    expect(Number(opus?.cache_read)).toBe(0.5);
    expect(Number(opus?.batch_multiplier)).toBe(0.5);

    // Fable 5.1 is the exception: cache reads are 0.025x, not 0.1x.
    const fable = prices.find((row) => row.model_id === 'claude-fable-5-1');
    expect(Number(fable?.cache_read)).toBe(0.25);
  });

  it('gives every entity table a uuidv7 default and a working generated tsvector', async () => {
    await withClient(database.connectionString, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        "insert into organizations (name) values ('acme') returning id",
      );
      // uuidv7 is version 7 (the 13th hex digit of the canonical form).
      expect(rows[0]?.id.charAt(14)).toBe('7');

      const run = await seedRun(client);
      await client.query(
        "insert into run_messages (run_id, seq, kind, payload, search_text) values ($1, 1, 'assistant', '{}'::jsonb, 'hello partition world')",
        [run],
      );
      const { rows: found } = await client.query<{ count: string }>(
        "select count(*)::text as count from run_messages where search @@ to_tsquery('simple', 'partition')",
        [],
      );
      expect(Number(found[0]?.count)).toBe(1);
    });
  });

  it('is idempotent: a second run applies nothing', async () => {
    const report = await db.runMigrations({ connectionString: database.connectionString });
    expect(report.applied).toEqual([]);
    expect(report.skipped).toEqual(db.loadMigrations().map((migration) => migration.name));
    expect(report.partitionsCreated).toEqual([]);
  });

  it('refuses to run when an applied migration file has been edited (TD-019)', async () => {
    await withClient(database.connectionString, async (client) => {
      await client.query("update platform_migrations set checksum = 'tampered' where name = $1", [
        '0001_bootstrap',
      ]);
    });

    await expect(db.runMigrations({ connectionString: database.connectionString })).rejects.toThrow(
      /forward-only/,
    );

    // Leave the database usable for whatever runs after this file.
    await withClient(database.connectionString, async (client) => {
      const [first] = db.loadMigrations();
      await client.query('update platform_migrations set checksum = $2 where name = $1', [
        first?.name,
        first?.checksum,
      ]);
    });
  });

  it('reports a migration this build does not know about (TD-019 downgrade guard)', async () => {
    await withClient(database.connectionString, async (client) => {
      await client.query(
        "insert into platform_migrations (name, checksum, duration_ms) values ('9999_from_the_future', 'x', 0)",
      );
      await expect(db.findUnknownMigrations(client)).resolves.toEqual(['9999_from_the_future']);
      await client.query("delete from platform_migrations where name = '9999_from_the_future'");
    });
  });
});

describe('concurrent migrate containers', () => {
  it('serialise on the advisory lock: each migration is applied exactly once', async () => {
    const database = await createTestDatabase('lockrace');
    try {
      const [first, second] = await Promise.all([
        db.runMigrations({ connectionString: database.connectionString }),
        db.runMigrations({ connectionString: database.connectionString }),
      ]);

      const names = db.loadMigrations().map((migration) => migration.name);
      // Whoever got the lock first did all the work; the other found everything applied.
      const applied = [...first.applied, ...second.applied].sort();
      expect(applied).toEqual([...names].sort());
      expect(first.applied.length === 0 || second.applied.length === 0).toBe(true);

      const rows = await withClient(database.connectionString, async (client) => {
        const { rows: counted } = await client.query<{ count: string }>(
          'select count(*)::text as count from platform_migrations',
        );
        return Number(counted[0]?.count ?? '0');
      });
      expect(rows).toBe(names.length);
    } finally {
      await database.drop();
    }
  });
});

/** Inserts the org → project → task → run chain and returns the run id. */
const seedRun = async (client: {
  query: <R extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ) => Promise<{ rows: R[] }>;
}): Promise<string> => {
  const org = await client.query<{ id: string }>(
    "insert into organizations (name) values ('seed') returning id",
  );
  const orgId = org.rows[0]?.id;
  const project = await client.query<{ id: string }>(
    `insert into projects (org_id, key, name, repo_url)
     values ($1, 'seed_' || substr(md5(random()::text), 1, 8), 'seed', 'https://example.invalid/seed')
     returning id`,
    [orgId],
  );
  const projectId = project.rows[0]?.id;
  const task = await client.query<{ id: string }>(
    `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template)
     values ($1, 'fake', 'SEED-' || substr(md5(random()::text), 1, 8), 'https://example.invalid/t', 'feature')
     returning id`,
    [projectId],
  );
  const taskId = task.rows[0]?.id;
  const run = await client.query<{ id: string }>(
    `insert into runs (task_id, project_id, role, model, prompt_version)
     values ($1, $2, 'developer', 'claude-opus-5', 'developer@1')
     returning id`,
    [taskId, projectId],
  );
  return run.rows[0]?.id as string;
};

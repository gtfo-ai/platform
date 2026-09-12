/**
 * WP-03 acceptance: `REVOKE` verified.
 *
 * technical/03 makes six tables append-only by revoking UPDATE and DELETE "from the application
 * role". These tests act as that role — `SET ROLE platform_app`, exactly what the runtime pool
 * does — and assert the writes that must fail actually fail, rather than merely asserting the
 * catalogue contains the right ACL entry.
 */
import { randomUUID } from 'node:crypto';
import { db } from '@platform/infrastructure';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import {
  createTestDatabase,
  strictPoolLogger,
  type TestDatabase,
  withClient,
} from '../support/postgres.js';

/** PostgreSQL's insufficient_privilege. */
const INSUFFICIENT_PRIVILEGE = '42501';

/**
 * The seven tables technical/03 makes append-only, each with a column of its own to attempt an
 * UPDATE on — a column the table does not have would fail as `undefined_column` and prove nothing.
 */
const APPEND_ONLY_TABLES: readonly (readonly [table: string, column: string])[] = [
  ['config_audit', 'entity_type'],
  ['cost_entries', 'model'],
  ['events', 'type'],
  ['human_actions', 'action'],
  ['integration_actions', 'action'],
  ['redaction_log', 'rule_id'],
  ['run_messages', 'subtype'],
];

const expectDenied = async (client: pg.Client, statement: string): Promise<void> => {
  await expect(client.query(statement)).rejects.toMatchObject({
    code: INSUFFICIENT_PRIVILEGE,
  });
};

describe('least-privilege application role', () => {
  let database: MigratedDatabase;

  beforeAll(async () => {
    database = await createMigratedDatabase('grants');
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('exists as a NOLOGIN role and owns nothing', async () => {
    await withClient(database.connectionString, async (client) => {
      const { rows } = await client.query<{
        rolcanlogin: boolean;
        rolsuper: boolean;
        rolcreaterole: boolean;
        rolcreatedb: boolean;
      }>(
        'select rolcanlogin, rolsuper, rolcreaterole, rolcreatedb from pg_roles where rolname = $1',
        ['platform_app'],
      );
      expect(rows[0]).toEqual({
        rolcanlogin: false,
        rolsuper: false,
        rolcreaterole: false,
        rolcreatedb: false,
      });

      const owned = await client.query<{ count: string }>(
        `select count(*)::text as count
           from pg_class
          where relowner = to_regrole('platform_app')::oid`,
      );
      expect(Number(owned.rows[0]?.count)).toBe(0);
    });
  });

  it('cannot UPDATE, DELETE or TRUNCATE any append-only table', async () => {
    await withClient(database.connectionString, async (client) => {
      await client.query('set role platform_app');
      for (const [table, column] of APPEND_ONLY_TABLES) {
        await expectDenied(client, `update ${table} set ${column} = ${column}`);
        await expectDenied(client, `delete from ${table}`);
        await expectDenied(client, `truncate ${table}`);
      }
      await client.query('reset role');
    });
  });

  it('can still append to the event log, and reading it back is unrestricted', async () => {
    await withClient(database.connectionString, async (client) => {
      await client.query('set role platform_app');
      const streamId = '01890000-0000-7000-8000-000000000001';
      await client.query(
        `insert into events (stream_type, stream_id, stream_seq, type, payload, actor)
         values ('task', $1, 1, 'task.created', '{}'::jsonb, '{"kind":"system"}'::jsonb)`,
        [streamId],
      );
      const { rows } = await client.query<{ count: string }>(
        'select count(*)::text as count from events where stream_id = $1',
        [streamId],
      );
      expect(Number(rows[0]?.count)).toBe(1);

      // The append succeeded, but rewriting history still does not.
      await expectDenied(client, "update events set type = 'tampered'");
      await client.query('reset role');
    });
  });

  it('may UPDATE and DELETE the mutable tables', async () => {
    await withClient(database.connectionString, async (client) => {
      await client.query('set role platform_app');
      const { rows } = await client.query<{ id: string }>(
        "insert into organizations (name) values ('mutable') returning id",
      );
      await client.query('update organizations set name = $2 where id = $1', [
        rows[0]?.id,
        'renamed',
      ]);
      await client.query('delete from organizations where id = $1', [rows[0]?.id]);
      await client.query('reset role');
    });
  });

  it('cannot write the migration log or the storage policy registry', async () => {
    await withClient(database.connectionString, async (client) => {
      await client.query('set role platform_app');
      // Readable — the application checks whether the schema is newer than the code (TD-019).
      await client.query('select name from platform_migrations');
      await client.query('select table_name from platform_table_policy');

      await expectDenied(
        client,
        "insert into platform_migrations (name, checksum, duration_ms) values ('x', 'y', 0)",
      );
      await expectDenied(
        client,
        "insert into platform_table_policy (table_name) values ('smuggled')",
      );
      // retention_days is the bound on the one destructive function the role may call, so it must
      // be unreachable from the application side.
      await expectDenied(client, 'update platform_table_policy set retention_days = 1');
      await client.query('reset role');
    });
  });

  it('may run partition maintenance but not re-grant privileges', async () => {
    await withClient(database.connectionString, async (client) => {
      await client.query('set role platform_app');
      // SECURITY DEFINER, granted explicitly: the maintenance job runs as this role.
      await client.query('select platform_ensure_partitions(1)');
      await client.query("select platform_drop_expired_partitions('transcripts')");

      await expectDenied(client, "select platform_apply_grants('platform_app')");
      await client.query('reset role');
    });
  });

  it('cannot widen the retention window: the drop function takes no window at all', async () => {
    await withClient(database.connectionString, async (client) => {
      // An old transcript partition and a deliberately generous configured window.
      await client.query(
        "create table run_messages_2021_01 partition of run_messages for values from ('2021-01-01') to ('2021-02-01')",
      );
      await client.query(
        "update platform_table_policy set retention_days = 36500 where retention_scope = 'transcripts'",
      );

      await client.query('set role platform_app');
      // The two-argument form the role would need to choose its own window does not exist.
      await expect(
        client.query("select platform_drop_expired_partitions('transcripts', 1)"),
      ).rejects.toMatchObject({ code: '42883' });
      // What it may call honours the configured window, so the old partition survives.
      const { rows } = await client.query<{ dropped: string[] }>(
        "select platform_drop_expired_partitions('transcripts') as dropped",
      );
      expect(rows[0]?.dropped).toEqual([]);
      await client.query('reset role');

      const survivors = await client.query<{ relname: string }>(
        `select c.relname from pg_class parent
           join pg_inherits i on i.inhparent = parent.oid
           join pg_class c on c.oid = i.inhrelid
          where parent.relname = 'run_messages'
            and parent.relnamespace = 'public'::regnamespace`,
      );
      expect(survivors.rows.map((row) => row.relname)).toContain('run_messages_2021_01');
    });
  });

  it('cannot forge the event sequence: event_streams is read-only for the application', async () => {
    await withClient(database.connectionString, async (client) => {
      const streamId = '01890000-0000-7000-8000-0000000000ee';
      await client.query('set role platform_app');
      await client.query(
        `insert into events (stream_type, stream_id, stream_seq, type, payload, actor)
         values ('task', $1, 1, 'task.created', '{}'::jsonb, '{"kind":"system"}'::jsonb)`,
        [streamId],
      );

      // The row the trigger maintains is visible but untouchable — with write access the role
      // could delete it and re-append sequence 1, forging the invariant it stands for.
      await client.query('select last_seq from event_streams where stream_id = $1', [streamId]);
      await expectDenied(client, 'delete from event_streams');
      await expectDenied(client, 'update event_streams set last_seq = 0');
      await expectDenied(
        client,
        "insert into event_streams (stream_type, stream_id, last_seq) values ('task', '01890000-0000-7000-8000-0000000000ef', 1)",
      );
      await expectDenied(client, 'truncate event_streams');

      // So a replayed sequence still fails.
      await expect(
        client.query(
          `insert into events (stream_type, stream_id, stream_seq, type, payload, actor)
           values ('task', $1, 1, 'task.created', '{}'::jsonb, '{"kind":"system"}'::jsonb)`,
          [streamId],
        ),
      ).rejects.toMatchObject({ code: '23505' });
      await client.query('reset role');
    });
  });

  it('cannot create objects of its own in the public schema', async () => {
    await withClient(database.connectionString, async (client) => {
      await client.query('set role platform_app');
      await expectDenied(client, 'create table smuggled (id int)');
      await client.query('reset role');
    });
  });

  it('degrades to a warning instead of a failed migration when the role is absent', async () => {
    await withClient(database.connectionString, async (client) => {
      const notices: string[] = [];
      client.on('notice', (notice) => notices.push(notice.message ?? ''));

      const { rows } = await client.query<{ applied: boolean }>(
        "select platform_apply_grants('no_such_role') as applied",
      );
      expect(rows[0]?.applied).toBe(false);
      expect(notices.join(' ')).toMatch(/does not exist/);
    });
  });

  it('has full DML on the pg-boss schema, which owns its own tables (TD-004)', async () => {
    await withClient(database.connectionString, async (client) => {
      await client.query('set role platform_app');
      await client.query('select count(*) from pgboss.job');
      await client.query('reset role');
    });
  });
});

describe('the SECURITY DEFINER functions, on a database migrated with no application role', () => {
  let database: TestDatabase;
  let report: db.MigrateReport;
  const probeRole = `probe_${randomUUID().replaceAll('-', '')}`.slice(0, 40);

  beforeAll(async () => {
    database = await createTestDatabase('definer');
    // APP_DB_APP_ROLE='' — the configuration .env.example documents for a pooler that rejects
    // startup options. It skips platform_apply_grants entirely, so anything the functions rely on
    // that step for is not protected at all.
    report = await db.runMigrations({ connectionString: database.connectionString, appRole: '' });

    await withClient(database.connectionString, async (client) => {
      await client.query(`create role "${probeRole}"`);
      await client.query(`grant connect on database "${database.name}" to "${probeRole}"`);
    });
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('really did skip the grant step', () => {
    expect(report.grantsAppliedTo).toBeNull();
  });

  it('are unreachable by a role holding nothing but CONNECT', async () => {
    await withClient(database.connectionString, async (client) => {
      await client.query(`set role "${probeRole}"`);
      // EXECUTE is granted to PUBLIC by default; each function revokes it where it is defined, so
      // the protection cannot be skipped by configuration.
      await expectDenied(client, "select platform_drop_expired_partitions('transcripts')");
      await expectDenied(client, 'select platform_ensure_partitions(1)');
      await expectDenied(client, "select platform_apply_grants('platform_app')");
      await expectDenied(client, "select platform_partition_name('run_messages', current_date)");
      await client.query('reset role');
    });
  });

  it('leave the partitions intact after that attempt', async () => {
    await withClient(database.connectionString, async (client) => {
      const { rows } = await client.query<{ count: string }>(
        `select count(*)::text as count
           from pg_class parent
           join pg_inherits i on i.inhparent = parent.oid
          where parent.relname = 'run_messages'
            and parent.relnamespace = 'public'::regnamespace`,
      );
      expect(Number(rows[0]?.count)).toBeGreaterThan(0);
    });
  });
});

describe('the runtime pool', () => {
  let database: MigratedDatabase;

  beforeAll(async () => {
    database = await createMigratedDatabase('pool');
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('hands out connections already switched to the application role', async () => {
    const handle = db.createDatabasePool(
      {
        url: database.connectionString,
        appRole: 'platform_app',
        poolMax: 2,
        connectionTimeoutMs: 5_000,
        partitionMonthsAhead: 3,
        transcriptRetentionDays: null,
      },
      strictPoolLogger,
    );

    try {
      const who = await handle.pool.query<{ current_role: string }>('select current_role');
      expect(who.rows[0]?.current_role).toBe('platform_app');

      // The whole point of the switch: the owner's privileges are gone.
      await expect(handle.pool.query("update events set type = 'tampered'")).rejects.toMatchObject({
        code: INSUFFICIENT_PRIVILEGE,
      });

      // Set in the startup packet, so RESET ROLE returns to it rather than to the login role.
      await handle.pool.query('reset role');
      const afterReset = await handle.pool.query<{ current_role: string }>('select current_role');
      expect(afterReset.rows[0]?.current_role).toBe('platform_app');
    } finally {
      await handle.close();
    }
  });

  it('leaves the connection alone when no role is configured', async () => {
    const handle = db.createDatabasePool(
      {
        url: database.connectionString,
        appRole: '',
        poolMax: 1,
        connectionTimeoutMs: 5_000,
        partitionMonthsAhead: 3,
        transcriptRetentionDays: null,
      },
      strictPoolLogger,
    );

    try {
      const who = await handle.pool.query<{ current_role: string }>('select current_role');
      expect(who.rows[0]?.current_role).not.toBe('platform_app');
    } finally {
      await handle.close();
    }
  });

  it('refuses a role name it would have to escape', () => {
    expect(() =>
      db.createDatabasePool(
        {
          url: database.connectionString,
          appRole: 'app"; drop database x; --',
          poolMax: 1,
          connectionTimeoutMs: 5_000,
          partitionMonthsAhead: 3,
          transcriptRetentionDays: null,
        },
        strictPoolLogger,
      ),
    ).toThrow(/bare lower-case identifier/);
  });
});

/**
 * The command idempotency record against a real PostgreSQL 18 (WP-67, PROGRESS backlog 47).
 *
 * Three things only this tier can check, because each is a claim about the database rather than
 * about a `Map`:
 *
 *  - **two concurrent identical commands produce one effect** (criterion (3)). Driven through
 *    `claimIdempotentAttempt` — the helper every command route calls, in the route's own order
 *    (claim, then `run` the effect and the audit row) — with the real claim, release and audit
 *    writers bound to the database; the effect is a row written in a transaction of its own, so the
 *    interleaving is real connections, which is what the old read-then-perform lookup could not
 *    survive (both reads returned null under READ COMMITTED). Asserted twice: once held open on a
 *    barrier so the second request provably arrives mid-effect, and once as a burst with no barrier
 *    at all. The route itself is driven over this record by the e2e tier
 *    (`test/e2e/server/command-api.e2e.test.ts`, a concurrent feedback pair through a real instance),
 *    because this tier has no HTTP framework of its own;
 *  - the record's **three states** as SQL: a first claim wins, a held key answers `in_flight`, a
 *    release frees only an uncompleted key, and the audit row completes the claim;
 *  - migration 0053's **backfill over duplicates already in `human_actions`** — the upgrade a unique
 *    index would have failed — keeps every audit row and records the **first** as the key's answer.
 */
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db as dbAdapters } from '@platform/infrastructure';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpError } from '../../../apps/server/src/errors.js';
import {
  claimCommandAttempt,
  countStaleCommandClaims,
  findCommandAttempt,
  releaseCommandAttempt,
} from '../../../apps/server/src/queries/idempotency-queries.js';
import type { Database } from '../../../apps/server/src/queries/identity-queries.js';
import { recordHumanAction } from '../../../apps/server/src/queries/onboarding-queries.js';
import { claimIdempotentAttempt } from '../../../apps/server/src/routes/idempotency.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import {
  createTestDatabase,
  createTestPool,
  type TestDatabase,
  withClient,
} from '../support/postgres.js';

const FEEDBACK_ID = '00000000-0000-4000-8000-0000000000f1';

let database: MigratedDatabase;
let pool: pg.Pool;
let sql: Database;
let userId: string;
let projectId: string;
let taskId: string;

beforeAll(async () => {
  database = await createMigratedDatabase('command_idempotency');
  pool = createTestPool(database.connectionString, { max: 8 });
  sql = drizzle(pool) as unknown as Database;
  const org = await pool.query<{ id: string }>(
    "insert into organizations (name) values ('idempotency') returning id",
  );
  const user = await pool.query<{ id: string }>(
    "insert into users (email, name) values ('operator@example.test', 'Operator') returning id",
  );
  userId = user.rows[0]?.id as string;
  const project = await pool.query<{ id: string }>(
    `insert into projects (org_id, key, name, repo_url)
     values ($1, 'idem', 'Idem', 'https://git.example.test/acme/idem.git') returning id`,
    [org.rows[0]?.id],
  );
  projectId = project.rows[0]?.id as string;
  const task = await pool.query<{ id: string }>(
    `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, state)
     values ($1, 'fake-jira', 'IDEM-1', 'https://jira.example.test/browse/IDEM-1', 'feature', 'active')
     returning id`,
    [projectId],
  );
  taskId = task.rows[0]?.id as string;
  // The command's effect, written by the stub in a transaction of its own: a row per performance.
  await pool.query('create table wp67_effects (id serial primary key, idempotency text not null)');
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

/** A barrier the stub waits on while its effect's transaction is open. */
interface Gate {
  entered: Promise<void>;
  open: () => void;
}

const gate = (): Gate & { enter: () => void; wait: Promise<void> } => {
  let enter = (): void => undefined;
  let open = (): void => undefined;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { entered, enter, wait, open };
};

const records = {
  claimAttempt: async (query: Parameters<typeof claimCommandAttempt>[1]) =>
    claimCommandAttempt(sql, query),
  releaseAttempt: async (query: Parameters<typeof releaseCommandAttempt>[1]) =>
    releaseCommandAttempt(sql, query),
};

interface Answer {
  readonly status: number;
  readonly code?: string;
  readonly performed?: boolean;
  readonly feedbackId?: string;
}

/**
 * One `task.feedback` command, in `routes/commands.ts`'s order: claim the key, then — under the
 * claim — perform the effect and write the audit row that completes it. The effect is a row in a
 * transaction of its own, held open on `hold` when a case needs the second request mid-effect.
 */
const feedbackCommand =
  (
    performances: { count: number },
    hold: ReturnType<typeof gate> | null,
    /** The task the audit row names; a missing one makes the real insert fail on its foreign key. */
    auditTaskId: () => string = () => taskId,
  ) =>
  async (key: string): Promise<Answer> => {
    try {
      const attempt = await claimIdempotentAttempt(records, {
        userId,
        action: 'task.feedback',
        key,
        request: { task_id: taskId, body: { scope: 'task', text: 'Looks right.' } },
      });
      if (attempt.replayed) {
        return {
          status: 200,
          performed: false,
          feedbackId: attempt.previous?.feedback_id as string,
        };
      }
      return await attempt.run(async (effectReturned) => {
        performances.count += 1;
        // Only the first performance waits: a build that let a second one through fails on the
        // assertion below rather than hanging on the barrier (measured on the canary).
        const held = hold !== null && performances.count === 1 ? hold : null;
        const client = await pool.connect();
        try {
          await client.query('begin');
          await client.query('insert into wp67_effects (idempotency) values ($1)', [key]);
          if (held !== null) {
            held.enter();
            await held.wait;
          }
          await client.query('commit');
        } finally {
          client.release();
        }
        effectReturned();
        await recordHumanAction(sql, {
          userId,
          action: 'task.feedback',
          params: {
            task_id: taskId,
            feedback_id: FEEDBACK_ID,
            idempotency_key: key,
            ...(attempt.digest === null ? {} : { body_digest: attempt.digest }),
          },
          taskId: auditTaskId(),
        });
        return { status: 200, performed: true, feedbackId: FEEDBACK_ID };
      });
    } catch (error) {
      if (error instanceof HttpError) {
        return { status: error.statusCode, code: error.code };
      }
      throw error;
    }
  };

const count = async (text: string, values: unknown[]): Promise<number> => {
  const { rows } = await pool.query<{ count: number }>(text, values);
  return Number(rows[0]?.count ?? 0);
};

const effects = (key: string) =>
  count('select count(*)::int as count from wp67_effects where idempotency = $1', [key]);

const auditRows = (key: string) =>
  count(
    `select count(*)::int as count from human_actions
      where action = 'task.feedback' and params ->> 'idempotency_key' = $1`,
    [key],
  );

describe('two concurrent identical commands (criterion (3))', () => {
  it('performs once when the second arrives while the first is mid-effect', async () => {
    const hold = gate();
    const performances = { count: 0 };
    const feedback = feedbackCommand(performances, hold);
    const before = await effects('feedback-held');
    const first = feedback('feedback-held');
    await hold.entered;
    // The first request holds the key and has an uncommitted effect on another connection.
    const second = await feedback('feedback-held');
    expect(second).toEqual({ status: 409, code: 'idempotency_key_in_flight' });
    hold.open();
    expect(await first).toEqual({ status: 200, performed: true, feedbackId: FEEDBACK_ID });

    // And after it has answered, the same request is a replay of it.
    expect(await feedback('feedback-held')).toEqual({
      status: 200,
      performed: false,
      feedbackId: FEEDBACK_ID,
    });

    expect(performances.count).toBe(1);
    expect(await effects('feedback-held')).toBe(before + 1);
    expect(await auditRows('feedback-held')).toBe(1);
    const record = await findCommandAttempt(sql, {
      userId,
      action: 'task.feedback',
      key: 'feedback-held',
    });
    expect(record?.status).toBe('performed');
  });

  it('performs each key once under a burst of simultaneous pairs', async () => {
    const performances = { count: 0 };
    const feedback = feedbackCommand(performances, null);
    const keys = Array.from({ length: 12 }, (_, index) => `feedback-burst-${index}`);
    const answers = await Promise.all(keys.flatMap((key) => [feedback(key), feedback(key)]));
    // Each pair: one performed, and the other either in flight or a replay — never two.
    for (const [index, key] of keys.entries()) {
      const pair = [answers[index * 2], answers[index * 2 + 1]];
      expect(pair.filter((answer) => answer?.performed === true).length, key).toBe(1);
      expect(await effects(key), key).toBe(1);
      expect(await auditRows(key), key).toBe(1);
    }
    expect(performances.count).toBe(keys.length);
  });
});

describe('a failure after the effect (WP-67 review round 1)', () => {
  it('keeps the key claimed when the audit insert fails, so the retry performs nothing', async () => {
    const performances = { count: 0 };
    let auditTask = '00000000-0000-4000-8000-00000000dead';
    const feedback = feedbackCommand(performances, null, () => auditTask);
    // The effect commits, then the real audit insert fails on its foreign key — inside the one
    // transaction `recordHumanAction` now opens, so neither the row nor the completion is left.
    await expect(feedback('feedback-audit-fails')).rejects.toThrow();
    expect(await effects('feedback-audit-fails')).toBe(1);
    expect(await auditRows('feedback-audit-fails')).toBe(0);

    auditTask = taskId;
    expect(await feedback('feedback-audit-fails')).toEqual({
      status: 409,
      code: 'idempotency_key_in_flight',
    });
    expect(performances.count).toBe(1);
    expect(await effects('feedback-audit-fails')).toBe(1);
    const record = await findCommandAttempt(sql, {
      userId,
      action: 'task.feedback',
      key: 'feedback-audit-fails',
    });
    expect(record?.status).toBe('in_flight');
  });
});

describe('the record’s states, as SQL', () => {
  const query = (key: string) => ({ userId, action: 'task.pause', key });

  it('rolls the audit row back with a completion that fails after it, so the key never reads performed-without-row', async () => {
    // Review round 2: the foreign-key case fails the *first* statement, so it cannot tell one
    // transaction from two. Here the audit insert succeeds and the completion is refused by a
    // trigger scoped to this one key: a split `recordHumanAction` would keep the audit row.
    await claimCommandAttempt(sql, { ...query('sql-split'), digest: 'ds' });
    await pool.query(`create or replace function wp67_refuse_completion() returns trigger
      language plpgsql as $$ begin raise exception 'completion refused (test)'; end $$`);
    await pool.query(`create trigger wp67_refuse_completion before update on command_idempotency
      for each row when (new.idempotency_key = 'sql-split') execute function wp67_refuse_completion()`);
    try {
      await expect(
        recordHumanAction(sql, {
          userId,
          action: 'task.pause',
          params: { task_id: taskId, idempotency_key: 'sql-split', body_digest: 'ds' },
          taskId,
        }),
      ).rejects.toThrow();
    } finally {
      await pool.query('drop trigger wp67_refuse_completion on command_idempotency');
      await pool.query('drop function wp67_refuse_completion()');
    }
    expect(
      await count(
        `select count(*)::int as count from human_actions
          where action = 'task.pause' and params ->> 'idempotency_key' = $1`,
        ['sql-split'],
      ),
    ).toBe(0);
    expect((await findCommandAttempt(sql, query('sql-split')))?.status).toBe('in_flight');
  });

  it('claims once, answers in_flight while held, and frees an uncompleted claim on release', async () => {
    expect(await claimCommandAttempt(sql, { ...query('sql-1'), digest: 'd1' })).toEqual({
      status: 'claimed',
    });
    const held = await claimCommandAttempt(sql, { ...query('sql-1'), digest: 'd1' });
    expect(held.status).toBe('in_flight');
    await releaseCommandAttempt(sql, query('sql-1'));
    expect(await findCommandAttempt(sql, query('sql-1'))).toBeNull();
    expect((await claimCommandAttempt(sql, { ...query('sql-1'), digest: 'd1' })).status).toBe(
      'claimed',
    );
  });

  it('is completed by the audit row, and a release after that changes nothing', async () => {
    await claimCommandAttempt(sql, { ...query('sql-2'), digest: 'd2' });
    await recordHumanAction(sql, {
      userId,
      action: 'task.pause',
      params: { task_id: taskId, idempotency_key: 'sql-2', body_digest: 'd2' },
      taskId,
    });
    await releaseCommandAttempt(sql, query('sql-2'));
    expect(await findCommandAttempt(sql, query('sql-2'))).toEqual({
      status: 'performed',
      bodyDigest: 'd2',
      params: { task_id: taskId, idempotency_key: 'sql-2', body_digest: 'd2' },
    });
  });

  it('records a keyed audit row that took no claim, so the table indexes every used key', async () => {
    await recordHumanAction(sql, {
      userId,
      action: 'project.create',
      params: { key: 'idem', idempotency_key: 'sql-3', body_digest: 'd3' },
    });
    const found = await findCommandAttempt(sql, { userId, action: 'project.create', key: 'sql-3' });
    expect(found?.status).toBe('performed');
  });

  it('keeps the first attempt when a second audit row names a completed key', async () => {
    await recordHumanAction(sql, {
      userId,
      action: 'task.resume',
      params: { idempotency_key: 'sql-4', body_digest: 'first', n: 1 },
    });
    await recordHumanAction(sql, {
      userId,
      action: 'task.resume',
      params: { idempotency_key: 'sql-4', body_digest: 'second', n: 2 },
    });
    const found = await findCommandAttempt(sql, { userId, action: 'task.resume', key: 'sql-4' });
    expect(found).toMatchObject({ status: 'performed', bodyDigest: 'first', params: { n: 1 } });
  });
});

const MIGRATIONS = fileURLToPath(
  new URL('../../../packages/infrastructure/src/db/migrations/', import.meta.url),
);
const RECORD_MIGRATION = '0053_command_idempotency.sql';

describe('migration 0053 over duplicates already in human_actions', () => {
  let upgraded: TestDatabase;
  let before: string;
  let upgradeUser: string;

  beforeAll(async () => {
    upgraded = await createTestDatabase('command_idempotency_upgrade');
    before = mkdtempSync(join(tmpdir(), 'wp67-migrations-'));
    for (const file of readdirSync(MIGRATIONS)) {
      if (file.endsWith('.sql') && file < RECORD_MIGRATION) {
        cpSync(join(MIGRATIONS, file), join(before, file));
      }
    }
    await dbAdapters.runMigrations({
      connectionString: upgraded.connectionString,
      migrationsDirectory: before,
    });
    await withClient(upgraded.connectionString, async (client) => {
      const user = await client.query<{ id: string }>(
        "insert into users (email, name) values ('upgrade@example.test', 'Upgrade') returning id",
      );
      upgradeUser = user.rows[0]?.id as string;
      const insert = (params: object, at: string, who: string | null = upgradeUser) =>
        client.query(
          `insert into human_actions (user_id, action, params, created_at)
           values ($1, 'task.feedback', $2::jsonb, $3)`,
          [who, JSON.stringify(params), at],
        );
      // The double-perform this migration exists to stop, already in the table: two rows, one key.
      await insert(
        { idempotency_key: 'dup', body_digest: 'd', feedback_id: 'first' },
        '2026-09-01T10:00:00Z',
      );
      await insert(
        { idempotency_key: 'dup', body_digest: 'd', feedback_id: 'second' },
        '2026-09-01T10:00:01Z',
      );
      // A row from before WP-21 recorded a digest; a key the header could never have carried; a
      // row whose user was deleted; and a row with no key at all.
      await insert({ idempotency_key: 'legacy' }, '2026-08-01T10:00:00Z');
      await insert({ idempotency_key: 'has space', body_digest: 'd' }, '2026-08-01T10:00:00Z');
      await insert({ idempotency_key: 'orphan', body_digest: 'd' }, '2026-08-01T10:00:00Z', null);
      await insert({ note: 'no key' }, '2026-08-01T10:00:00Z');
    });
    await dbAdapters.runMigrations({ connectionString: upgraded.connectionString });
  }, 180_000);

  afterAll(async () => {
    rmSync(before, { recursive: true, force: true });
    await upgraded?.drop();
  });

  it('applies, keeps every audit row, and answers each key with its first attempt', async () => {
    await withClient(upgraded.connectionString, async (client) => {
      const audit = await client.query<{ count: number }>(
        'select count(*)::int as count from human_actions',
      );
      expect(audit.rows[0]?.count).toBe(6);
      const records = await client.query<{
        idempotency_key: string;
        body_digest: string | null;
        feedback_id: string | null;
        completed: boolean;
      }>(
        `select c.idempotency_key, c.body_digest, h.params ->> 'feedback_id' as feedback_id,
                c.completed_at is not null as completed
           from command_idempotency c
           left join human_actions h on h.id = c.human_action_id
          order by c.idempotency_key`,
      );
      expect(records.rows).toEqual([
        { idempotency_key: 'dup', body_digest: 'd', feedback_id: 'first', completed: true },
        { idempotency_key: 'legacy', body_digest: null, feedback_id: null, completed: true },
      ]);
    });
  });
});

/**
 * The `command_idempotency_claims_unknown` gauge's reading (WP-73, PROGRESS backlog 241): an
 * uncompleted claim older than the bound, by action — and neither a completed claim nor a fresh one,
 * both directions (standing rule 42).
 */
describe('the stale-claim count behind the operator’s gauge', () => {
  it('counts an uncompleted claim past the bound, by action, and not a completed or a fresh one', async () => {
    const insert = (action: string, key: string, claimedAt: string, completed: boolean) =>
      pool.query(
        `insert into command_idempotency (user_id, action, idempotency_key, claimed_at, completed_at)
         values ($1, $2, $3, $4::timestamptz, case when $5 then $4::timestamptz + interval '1 second' end)`,
        [userId, action, key, claimedAt, completed],
      );
    await insert('wp73.stale', 'wp73-stale-1', '2026-01-01T00:00:00Z', false);
    await insert('wp73.stale', 'wp73-stale-2', '2026-01-01T00:00:00Z', false);
    await insert('wp73.other', 'wp73-stale-3', '2026-01-01T00:00:00Z', false);
    await insert('wp73.done', 'wp73-done-1', '2026-01-01T00:00:00Z', true);
    await insert('wp73.fresh', 'wp73-fresh-1', '2026-03-01T00:00:00Z', false);

    const counted = (await countStaleCommandClaims(sql, new Date('2026-02-01T00:00:00Z')))
      .filter((entry) => entry.action.startsWith('wp73.'))
      .sort((a, b) => a.action.localeCompare(b.action));
    expect(counted).toEqual([
      { action: 'wp73.other', claims: 1 },
      { action: 'wp73.stale', claims: 2 },
    ]);
  });
});

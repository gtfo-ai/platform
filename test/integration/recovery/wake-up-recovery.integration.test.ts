/**
 * The two WP-84 recovery rows' SQL against PostgreSQL 18 — PROGRESS backlog **240** (a deferred
 * dependency-gate ending whose `task.resumed` wake-up was lost) and **236** half (2) (a
 * planned-`immediate` notification whose job spent every attempt), migration 0059.
 *
 * The unit tier (`packages/application/src/recovery/stranded.test.ts` › "the WP-84 rows") holds the
 * pass's order — mark, then enqueue — over stub stores; this tier holds what only SQL decides: both
 * directions of each predicate, the one-attempt-per-resume bound read off the event log, the
 * `delivered_at is null` guard on the re-post mark, and that a row with no project (the refused
 * organisation configuration's row, Q103) is found and counted by the gauge's own reading.
 */
import type { Transaction } from '@platform/application';
import { undeliveredNotificationBounds } from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import { notify, recovery as recoveryAdapters } from '@platform/infrastructure';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestClient, createTestPool } from '../support/postgres.js';

let database: MigratedDatabase;
let pool: pg.Pool;
let projectId: Id;

const deferredStore = recoveryAdapters.createPostgresDeferredDependencyStore();
const repostStore = recoveryAdapters.createPostgresNotificationRepostStore();

/** Every instant relative to the wall clock, so the rows land in the partition the migrator made. */
const ago = (ms: number): IsoDateTime => new Date(Date.now() - ms).toISOString() as IsoDateTime;
const MINUTE = 60_000;

const withTx = async <T>(fn: (tx: Transaction) => Promise<T>): Promise<T> => {
  const client = createTestClient(database.connectionString);
  await client.connect();
  try {
    return await fn({ adapter: 'postgres', client } as unknown as Transaction);
  } finally {
    await client.end();
  }
};

const DEFERRED = {
  head_sha: null,
  decision: 'ask',
  added: [],
  unread: [],
  truncated: false,
  question_id: null,
  checked_at: '2026-09-28T09:00:00.000Z',
  deferred_stage: 'implementation',
};

let tickets = 0;
const newTask = async (
  state: string,
  dependencies: Record<string, unknown> | null = DEFERRED,
): Promise<Id> => {
  tickets += 1;
  const row = await pool.query<{ id: string }>(
    `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, mode, state,
                        dependencies)
     values ($1, 'jira', $2, 'https://jira.example.test/browse/' || $2, 'feature', 'normal',
             $3::task_state, $4::jsonb)
     returning id`,
    [
      projectId,
      `WAKE-${tickets}`,
      state,
      dependencies === null ? null : JSON.stringify(dependencies),
    ],
  );
  return row.rows[0]?.id as Id;
};

const seqs = new Map<string, number>();
/** Appends a `task.resumed` to the task's own stream at `at`, and answers its event id. */
const resumed = async (taskId: Id, at: IsoDateTime): Promise<Id> => {
  const seq = (seqs.get(taskId) ?? 0) + 1;
  seqs.set(taskId, seq);
  const row = await pool.query<{ id: string }>(
    `insert into events (stream_type, stream_id, stream_seq, type, payload, actor, occurred_at)
     values ('task', $1, $2, 'task.resumed', $3::jsonb, $4::jsonb, $5)
     returning id`,
    [
      taskId,
      seq,
      JSON.stringify({ project_id: projectId, task_id: taskId, stage: 'implementation' }),
      JSON.stringify({ kind: 'system', component: 'pipeline' }),
      at,
    ],
  );
  return row.rows[0]?.id as Id;
};

const deferredFound = async (taskId: Id) =>
  (
    await withTx((tx) =>
      deferredStore.strandedDeferredDependencies(tx, {
        olderThan: ago(MINUTE),
        endingBefore: ago(60 * MINUTE),
        limit: 50,
      }),
    )
  ).filter((row) => row.taskId === taskId);

beforeAll(async () => {
  database = await createMigratedDatabase('wake-ups');
  pool = createTestPool(database.connectionString, { max: 4 });
  const org = await pool.query<{ id: string }>(
    "insert into organizations (name) values ('wake-ups') returning id",
  );
  const project = await pool.query<{ id: string }>(
    `insert into projects (org_id, key, name, repo_url)
     values ($1, 'wake', 'Wake-ups', 'https://git.example.test/acme/wake.git') returning id`,
    [org.rows[0]?.id],
  );
  projectId = project.rows[0]?.id as Id;
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

describe('the deferred-dependency row (backlog 240)', () => {
  it('finds an active task still carrying a deferral a pass interval after its newest resume, with that resume', async () => {
    const taskId = await newTask('active');
    await resumed(taskId, ago(30 * MINUTE));
    const newest = await resumed(taskId, ago(10 * MINUTE));
    const rows = await deferredFound(taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ taskId, projectId, resumedEventId: newest });
  });

  it('finds none inside the grace, none at a stop a human owns, and none with nothing deferred', async () => {
    const young = await newTask('active');
    await resumed(young, ago(10_000));
    expect(await deferredFound(young)).toEqual([]);

    const paused = await newTask('paused');
    await resumed(paused, ago(10 * MINUTE));
    expect(await deferredFound(paused)).toEqual([]);

    const performed = await newTask('active', { ...DEFERRED, deferred_stage: null });
    await resumed(performed, ago(10 * MINUTE));
    expect(await deferredFound(performed)).toEqual([]);

    // A record written before WP-67 has no `deferred_stage` key at all.
    const { deferred_stage: _absent, ...older } = DEFERRED;
    const legacy = await newTask('active', older);
    await resumed(legacy, ago(10 * MINUTE));
    expect(await deferredFound(legacy)).toEqual([]);

    // …and an active task that never resumed has no wake-up that could have been lost.
    const never = await newTask('active');
    expect(await deferredFound(never)).toEqual([]);
  });

  it('is bounded to one attempt per resume by its mark, and a later resume makes it recoverable again', async () => {
    const taskId = await newTask('active');
    await resumed(taskId, ago(20 * MINUTE));
    expect(await deferredFound(taskId)).toHaveLength(1);

    await withTx((tx) =>
      deferredStore.markDeferredDependencyAttempt(tx, { taskId, at: ago(15 * MINUTE) }),
    );
    expect(await deferredFound(taskId), 'the attempt for this resume is spent').toEqual([]);

    const later = await resumed(taskId, ago(5 * MINUTE));
    const rows = await deferredFound(taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.resumedEventId).toBe(later);
  });

  it('does not mark a task that stopped between the read and the write', async () => {
    const taskId = await newTask('paused');
    await withTx((tx) => deferredStore.markDeferredDependencyAttempt(tx, { taskId, at: ago(0) }));
    const row = await pool.query<{ mark: Date | null }>(
      'select dependency_recovery_attempted_at as mark from tasks where id = $1',
      [taskId],
    );
    expect(row.rows[0]?.mark).toBeNull();
  });
});

describe('the re-post row (backlog 236 (2))', () => {
  let causes = 0;
  const insertNotification = async (input: {
    readonly projectId: Id | null;
    readonly createdAt: IsoDateTime;
    readonly planned?: 'immediate' | 'digest';
    readonly deliveredAt?: IsoDateTime | null;
    readonly digestDay?: string | null;
    readonly notificationClass?: string;
  }): Promise<Id> => {
    causes += 1;
    const cause = `00000000-0000-4000-9000-${causes.toString(16).padStart(12, '0')}`;
    const row = await pool.query<{ id: string }>(
      `insert into notifications (project_id, task_id, class, cause_event_id, title, planned_delivery,
                                  created_at, delivered_at, delivered_as, digest_day)
       values ($1, null, $2, $3, 'A title', $4, $5, $6, $7, $8::date)
       returning id`,
      [
        input.projectId,
        input.notificationClass ?? 'budget_exhausted',
        cause,
        input.planned ?? 'immediate',
        input.createdAt,
        input.deliveredAt ?? null,
        input.deliveredAt === undefined || input.deliveredAt === null ? null : 'immediate',
        input.digestDay ?? null,
      ],
    );
    return row.rows[0]?.id as Id;
  };
  const undelivered = async (ids: readonly Id[]) =>
    (
      await withTx((tx) =>
        repostStore.undeliveredImmediate(tx, { before: ago(48 * MINUTE), limit: 50 }),
      )
    ).filter((row) => ids.includes(row.id));

  it('finds an undelivered immediate row past the window — organisation-scoped included — and nothing else', async () => {
    const orgRow = await insertNotification({ projectId: null, createdAt: ago(60 * MINUTE) });
    const projectRow = await insertNotification({
      projectId,
      createdAt: ago(60 * MINUTE),
      notificationClass: 'reminder',
    });
    const young = await insertNotification({ projectId: null, createdAt: ago(10 * MINUTE) });
    const delivered = await insertNotification({
      projectId,
      createdAt: ago(60 * MINUTE),
      deliveredAt: ago(59 * MINUTE),
    });
    const claimed = await insertNotification({
      projectId,
      createdAt: ago(60 * MINUTE),
      digestDay: '2026-09-28',
    });
    const digest = await insertNotification({
      projectId,
      createdAt: ago(60 * MINUTE),
      planned: 'digest',
    });
    const found = await undelivered([orgRow, projectRow, young, delivered, claimed, digest]);
    expect(found.map((row) => row.id).sort()).toEqual([orgRow, projectRow].sort());
    expect(found.find((row) => row.id === orgRow)).toMatchObject({
      projectId: null,
      taskId: null,
      approvalId: null,
      notificationClass: 'budget_exhausted',
    });
    expect(found.find((row) => row.id === projectRow)?.notificationClass).toBe('reminder');

    // The same row the gauge counts: `countStaleUndeliveredNotifications` reads the organisation's
    // refused-configuration row too, which is what Q103's half of 236 needed.
    const counted = await notify.countStaleUndeliveredNotifications(
      pool,
      undeliveredNotificationBounds(ago(0)),
    );
    expect(counted.immediate).toBeGreaterThanOrEqual(2);
  });

  it('re-posts a row once: the mark takes it out of the next pass, and a delivered row is never marked', async () => {
    const row = await insertNotification({ projectId: null, createdAt: ago(60 * MINUTE) });
    await withTx((tx) => repostStore.markRepostAttempt(tx, { id: row, at: ago(0) }));
    expect(await undelivered([row])).toEqual([]);

    const delivered = await insertNotification({
      projectId,
      createdAt: ago(60 * MINUTE),
      deliveredAt: ago(1_000),
    });
    await withTx((tx) => repostStore.markRepostAttempt(tx, { id: delivered, at: ago(0) }));
    const mark = await pool.query<{ mark: Date | null }>(
      'select repost_attempted_at as mark from notifications where id = $1',
      [delivered],
    );
    expect(mark.rows[0]?.mark).toBeNull();
  });

  it('does not count, find or re-post a withheld row (review round 2)', async () => {
    const withheld = await insertNotification({
      projectId,
      createdAt: ago(60 * MINUTE),
      notificationClass: 'reminder',
    });
    const beforeCount = await notify.countStaleUndeliveredNotifications(
      pool,
      undeliveredNotificationBounds(ago(0)),
    );
    await withTx((tx) => repostStore.withholdRepost(tx, { id: withheld, at: ago(0) }));
    const row = await pool.query<{ delivered_as: string | null; has_at: boolean }>(
      'select delivered_as, delivered_at is not null as has_at from notifications where id = $1',
      [withheld],
    );
    expect(row.rows[0]).toEqual({ delivered_as: 'withheld', has_at: true });
    expect(await undelivered([withheld])).toEqual([]);
    const afterCount = await notify.countStaleUndeliveredNotifications(
      pool,
      undeliveredNotificationBounds(ago(0)),
    );
    expect(afterCount.immediate).toBe(beforeCount.immediate - 1);
    // The same guard as the mark: a delivered row is never turned into a withheld one.
    const delivered = await insertNotification({
      projectId,
      createdAt: ago(60 * MINUTE),
      deliveredAt: ago(59 * MINUTE),
    });
    await withTx((tx) => repostStore.withholdRepost(tx, { id: delivered, at: ago(0) }));
    const kept = await pool.query<{ delivered_as: string }>(
      'select delivered_as from notifications where id = $1',
      [delivered],
    );
    expect(kept.rows[0]?.delivered_as).toBe('immediate');
  });

  it('accepts the reminder class and refuses a class the build does not know', async () => {
    await expect(
      insertNotification({ projectId, createdAt: ago(0), notificationClass: 'reminder' }),
    ).resolves.toBeDefined();
    await expect(
      insertNotification({ projectId, createdAt: ago(0), notificationClass: 'nudge' }),
    ).rejects.toThrow(/notifications_class_known/);
  });
});

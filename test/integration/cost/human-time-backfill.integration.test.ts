/**
 * **WP-29's backfill criterion, on a real PostgreSQL**: *"the projector is registered through
 * `events/replay.ts`, and a replayed range of `events` produces rows **equal** to those a live
 * dispatch produced — an equality, not a spot check — and a second pass is a no-op."*
 *
 * The shape is a **comparison between two tasks**, which is the only way an equality can be
 * asserted rather than approximated:
 *
 *  1. one task's events are dispatched by a bus with the projector registered — the production path;
 *  2. an identical sequence for a second task is dispatched by a bus with **no** projector, which is
 *     exactly what every `apps/server` before this work package did: the dispatch completes, the
 *     `event_dispatch` row is deleted and the `$dispatch` marker is written, so a re-dispatch can
 *     never serve a handler registered afterwards (PROGRESS backlog 20);
 *  3. `replayEvents` reads that range of the append-only log into the projector;
 *  4. the two tasks' rows are compared **field by field**, and a second replay changes nothing.
 *
 * Everything the two sequences differ in is controlled: the same `occurred_at` instants, the same
 * author, the same question latency. `created_at` is excluded from the comparison and is the only
 * exclusion — it is the database's `now()`, which is the transaction's start, so it cannot be equal
 * across two transactions and says nothing about the fold (WP-19's ledger notes make the same point
 * about `cost_entries.created_at`).
 *
 * What only a database shows is the part the mechanism rests on: `handler_executions` is a real
 * table with a real primary key, and the claim the replay makes is the same one the dispatcher
 * makes.
 */
import { EventBus, humanTimeHandlers, replayEvents } from '@platform/application';
import type { DomainEvent } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { eventing, humanTime } from '@platform/infrastructure';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

const APP_ROLE = 'platform_app';

/**
 * The story's instants are relative to **now**, not fixed dates — which the database insisted on.
 *
 * `events` is monthly-partitioned and `assertInPartitionWindow` refuses anything older than the
 * previous month (*"the event log is never back-dated"*, technical/03), so the fixed 2026-06 dates
 * this file was first written with failed on append. The offsets are what the assertions are about
 * anyway: the review window is the distance between two comments, and the question's minutes are
 * the distance between `asked_at` and the answer.
 *
 * One base for **both** tasks, computed once, which is what makes the two sequences comparable at
 * all. It is rounded down to the second so that a `to_char` comparison of the stored instants is
 * not a comparison of two different microsecond renderings.
 */
const BASE_MS = Math.floor((Date.now() - 3 * 60 * 60_000) / 1000) * 1000;

/** `BASE_MS` plus `minutes`, as an ISO instant. */
const at = (minutes: number): string => new Date(BASE_MS + minutes * 60_000).toISOString();

interface ComparableEntry extends Record<string, unknown> {
  kind: string;
  user_id: string | null;
  external_author: string | null;
  started_at: string;
  ended_at: string | null;
  minutes: string | null;
}

describe('the human-time backfill (PostgreSQL)', () => {
  let database: MigratedDatabase;
  let pool: pg.Pool;
  let unitOfWork: eventing.PostgresUnitOfWork;
  let store: eventing.PostgresEventStore;
  let projectId: string;
  let userId: string;

  beforeAll(async () => {
    database = await createMigratedDatabase('human-time-backfill');
    pool = createTestPool(database.connectionString, {
      options: `-c role=${APP_ROLE}`,
      max: 8,
      connectionTimeoutMillis: 5_000,
    });
    unitOfWork = new eventing.PostgresUnitOfWork({ pool });
    store = new eventing.PostgresEventStore(pool);
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  beforeEach(async () => {
    const org = await pool.query<{ id: string }>(
      "insert into organizations (name) values ('backfill') returning id",
    );
    const project = await pool.query<{ id: string }>(
      `insert into projects (org_id, key, name, repo_url)
       values ($1, $2, 'API', 'https://git.example.test/acme/api.git') returning id`,
      [org.rows[0]?.id, `api-${Date.now()}-${Math.random().toString(16).slice(2)}`],
    );
    projectId = project.rows[0]?.id as string;
    const user = await pool.query<{ id: string }>(
      `insert into users (email, name) values ($1, 'Ada') returning id`,
      [`ada-${Date.now()}-${Math.random().toString(16).slice(2)}@example.invalid`],
    );
    userId = user.rows[0]?.id as string;
    // The mapped author, so the comparison exercises the `user_identities` read as well.
    await pool.query(
      'insert into user_identities (provider, external_id, user_id) values ($1, $2, $3)',
      ['gitlab', `ada-${userId}`, userId],
    );
  });

  /** A task that owns merge request `iid`, with one question asked at a known instant. */
  const seedTask = async (iid: number): Promise<{ taskId: string; questionId: string }> => {
    const task = await pool.query<{ id: string }>(
      `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, mr_ref)
       values ($1, 'fake-jira', $2, 'https://jira.example.test/x', 'feature', $3) returning id`,
      [
        projectId,
        `ACME-${iid}-${Date.now()}`,
        JSON.stringify({
          provider: 'gitlab',
          project_path: 'acme/api',
          iid,
          url: `https://git.example.test/acme/api/-/merge_requests/${iid}`,
        }),
      ],
    );
    const taskId = task.rows[0]?.id as string;
    const question = await pool.query<{ id: string }>(
      `insert into questions (task_id, text, asked_at) values ($1, 'which retry budget?', $2)
       returning id`,
      [taskId, at(40)],
    );
    return { taskId, questionId: question.rows[0]?.id as string };
  };

  /** The same story for any task: two comments, a question, an approval, a steer and the merge. */
  const story = (
    taskId: string,
    questionId: string,
    iid: number,
  ): readonly Record<string, unknown>[] => {
    const mr = {
      provider: 'gitlab',
      project_path: 'acme/api',
      iid,
      url: `https://git.example.test/acme/api/-/merge_requests/${iid}`,
      branch: 'agentic/ACME-1',
      head_sha: 'a'.repeat(40),
    };
    const author = {
      provider: 'gitlab',
      external_id: `ada-${userId}`,
      email: null,
      display_name: 'Ada',
      verified: true,
    };
    return [
      {
        type: 'mr.review.comment',
        occurred_at: at(0),
        payload: {
          project_id: projectId,
          task_id: null,
          mr,
          thread_id: 'discussion-1',
          author,
          text: 'the retry helper needs a bound',
          resolved: false,
        },
      },
      {
        type: 'mr.review.comment',
        occurred_at: at(30),
        payload: {
          project_id: projectId,
          task_id: null,
          mr,
          thread_id: 'discussion-1',
          author,
          text: 'and a test for the bound',
          resolved: false,
        },
      },
      {
        type: 'task.question.answered',
        occurred_at: at(55),
        payload: {
          project_id: projectId,
          task_id: taskId,
          question_id: questionId,
          answer: 'three',
          answered_by_user_id: userId,
          channel: 'ui',
        },
      },
      {
        type: 'task.approval.decided',
        occurred_at: at(60),
        payload: {
          project_id: projectId,
          task_id: taskId,
          approval_id: '00000000-0000-4000-8000-0000000000f1',
          decision: 'approved',
          decided_by_user_id: userId,
          reason: null,
        },
      },
      {
        type: 'run.steered',
        occurred_at: at(65),
        payload: {
          project_id: projectId,
          task_id: taskId,
          run_id: '00000000-0000-4000-8000-0000000000d1',
          message: 'use the existing helper',
          author_user_id: userId,
        },
      },
      {
        type: 'mr.merged',
        occurred_at: at(80),
        payload: {
          project_id: projectId,
          task_id: null,
          mr,
          draft: false,
          head_sha: 'a'.repeat(40),
          diff_stats: null,
          merge_commit_sha: 'c'.repeat(40),
        },
      },
    ];
  };

  const eventFor = (taskId: string, seq: number, spec: Record<string, unknown>): DomainEvent =>
    domainEventSchemasByType[spec.type as keyof typeof domainEventSchemasByType].parse({
      id: crypto.randomUUID(),
      stream_type: 'task',
      stream_id: taskId,
      stream_seq: seq,
      correlation_id: taskId,
      cause_event_id: null,
      actor: { kind: 'system', component: 'test' },
      occurred_at: spec.occurred_at,
      type: spec.type,
      payload: spec.payload,
    }) as DomainEvent;

  const projector = () => humanTimeHandlers({ store: humanTime.createPostgresHumanTimeStore() });

  /** Every row of a task, in a shape two tasks can be compared in. */
  const entriesOf = async (taskId: string): Promise<readonly ComparableEntry[]> => {
    const { rows } = await pool.query<ComparableEntry>(
      `select kind, user_id, external_author,
              to_char(started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') as started_at,
              to_char(ended_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') as ended_at,
              minutes
         from human_time_entries
        where task_id = $1
        order by kind, started_at, external_author nulls first`,
      [taskId],
    );
    return rows;
  };

  it('replays a range into rows equal to a live dispatch’s, and a second pass changes nothing', async () => {
    const live = await seedTask(7);
    const backfilled = await seedTask(8);

    // ── (1) the production path: a bus that has the projector ──
    const bus = new EventBus({ unitOfWork, retryDelayMs: 0, maxRetryDelayMs: 0 });
    for (const handler of projector()) {
      bus.register(handler);
    }
    let seq = 0;
    for (const spec of story(live.taskId, live.questionId, 7)) {
      seq += 1;
      const [appended] = await unitOfWork.transaction(async (scope) =>
        scope.events.append([eventFor(live.taskId, seq, spec)]),
      );
      const result = await bus.dispatch(appended as NonNullable<typeof appended>);
      expect(result.status).toBe('dispatched');
    }

    const liveRows = await entriesOf(live.taskId);
    // The story is four entries: one review window, one question, one approval, one steer.
    expect(liveRows).toHaveLength(4);
    // In `human_time_kind`'s own order — a PostgreSQL enum sorts by its declaration, not
    // alphabetically, and that declaration is product/19 §16's list with migration 0025's `steer`
    // appended. Two comments 30 minutes apart and a merge 50 minutes after the last of them is one
    // 80-minute window; the question was asked 15 minutes before it was answered.
    expect(liveRows.map((row) => [row.kind, row.minutes])).toEqual([
      ['review', '80.00'],
      ['question', '15.00'],
      ['approval', '10.00'],
      ['steer', '5.00'],
    ]);

    // ── (2) the world before this work package: a sweeper with no projector ──
    const sweeper = new EventBus({ unitOfWork, retryDelayMs: 0, maxRetryDelayMs: 0 });
    let firstPosition = 0;
    let lastPosition = 0;
    seq = 0;
    for (const spec of story(backfilled.taskId, backfilled.questionId, 8)) {
      seq += 1;
      const [appended] = await unitOfWork.transaction(async (scope) =>
        scope.events.append([eventFor(backfilled.taskId, seq, spec)]),
      );
      const stored = appended as NonNullable<typeof appended>;
      firstPosition = firstPosition === 0 ? stored.position : firstPosition;
      lastPosition = stored.position;
      expect((await sweeper.dispatch(stored)).status).toBe('dispatched');
    }
    expect(await entriesOf(backfilled.taskId)).toEqual([]);
    expect(await store.countPendingDispatch()).toBe(0);

    // ── (3) the projector is registered afterwards and the log is replayed ──
    const range = {
      handlers: projector(),
      fromPosition: firstPosition - 1,
      toPosition: lastPosition,
    };
    const report = await replayEvents({ store, unitOfWork }, range);
    expect(report).toMatchObject({ scanned: 6, applied: 6, skipped: 0, failures: [] });

    // ── (4) the equality, field by field ──
    const replayedRows = await entriesOf(backfilled.taskId);
    expect(replayedRows).toEqual(liveRows);

    // ── and a second pass is a no-op ──
    const second = await replayEvents({ store, unitOfWork }, range);
    expect(second).toMatchObject({ scanned: 6, applied: 0, skipped: 6 });
    expect(await entriesOf(backfilled.taskId)).toEqual(replayedRows);
  }, 120_000);

  it('does not record twice for an event the dispatcher already gave the projector', async () => {
    const task = await seedTask(9);
    const bus = new EventBus({ unitOfWork, retryDelayMs: 0, maxRetryDelayMs: 0 });
    for (const handler of projector()) {
      bus.register(handler);
    }
    // One flat kind, because that is the half of the fold that is **not** idempotent on its own:
    // a second execution would append a second ten-minute approval, so what stops it is the
    // `handler_executions` claim and nothing else.
    const [appended] = await unitOfWork.transaction(async (scope) =>
      scope.events.append([
        eventFor(task.taskId, 1, {
          type: 'task.approval.decided',
          occurred_at: at(60),
          payload: {
            project_id: projectId,
            task_id: task.taskId,
            approval_id: '00000000-0000-4000-8000-0000000000f1',
            decision: 'approved',
            decided_by_user_id: userId,
            reason: null,
          },
        }),
      ]),
    );
    const stored = appended as NonNullable<typeof appended>;
    await bus.dispatch(stored);
    const charged = await entriesOf(task.taskId);
    expect(charged).toHaveLength(1);

    const report = await replayEvents(
      { store, unitOfWork },
      { handlers: projector(), fromPosition: stored.position - 1, toPosition: stored.position },
    );
    expect(report).toMatchObject({ scanned: 1, applied: 0, skipped: 1 });
    expect(await entriesOf(task.taskId)).toEqual(charged);
  }, 120_000);
});

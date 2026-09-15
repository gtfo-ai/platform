/**
 * **WP-41's criterion 5, on a real PostgreSQL**: *"the projections are backfillable — registered
 * through `events/replay.ts` so a replayed range of the append-only `events` table produces rows
 * **equal** to a live dispatch's, an equality, not a spot check — and a second pass is a no-op."*
 *
 * The shape is WP-29's and it is the only way an equality can be asserted rather than approximated:
 * a **comparison between two projects**.
 *
 *  1. one project's events are dispatched by a bus with the projector registered — the production
 *     path;
 *  2. an identical sequence for a second project is dispatched by a bus with **no** projector,
 *     which is exactly what every `apps/server` before this work package did: the dispatch
 *     completes, the `event_dispatch` row is deleted and the `$dispatch` marker is written, so a
 *     re-dispatch can never serve a handler registered afterwards;
 *  3. `replayEvents` reads that range of the append-only log into the projector;
 *  4. the two projects' rows are compared **field by field**, and a second replay changes nothing.
 *
 * Everything the two sequences differ in is controlled: the same `occurred_at` instants, the same
 * outcomes, the same counts. `updated_at` and `created_at` are excluded and are the only exclusions
 * — they are the database's `now()`, which cannot be equal across two transactions and says nothing
 * about the fold.
 *
 * Two projects rather than two tasks, because `stats_event_daily` is keyed by `(project, day,
 * metric)`: two tasks of one project would fold into the *same* counter rows and the comparison
 * would be a comparison of one number with itself.
 */
import { EventBus, replayEvents, statsHandlers } from '@platform/application';
import type { DomainEvent } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { eventing, stats } from '@platform/infrastructure';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

const APP_ROLE = 'platform_app';

/**
 * The story's instants are relative to **now**, not fixed dates — which the database insists on:
 * `events` is monthly-partitioned and `assertInPartitionWindow` refuses anything older than the
 * previous month. Rounded down to the second so two renderings of the same instant compare equal.
 */
const BASE_MS = Math.floor((Date.now() - 3 * 60 * 60_000) / 1000) * 1000;

const at = (minutes: number): string => new Date(BASE_MS + minutes * 60_000).toISOString();

interface ComparableCounter extends Record<string, unknown> {
  day: string;
  metric: string;
  count: string;
  total: string;
}

describe('the statistics backfill (PostgreSQL)', () => {
  let database: MigratedDatabase;
  let pool: pg.Pool;
  let unitOfWork: eventing.PostgresUnitOfWork;
  let store: eventing.PostgresEventStore;
  let orgId: string;

  beforeAll(async () => {
    database = await createMigratedDatabase('stats-backfill');
    pool = createTestPool(database.connectionString, {
      options: `-c role=${APP_ROLE}`,
      max: 8,
      connectionTimeoutMillis: 5_000,
    });
    unitOfWork = new eventing.PostgresUnitOfWork({ pool });
    store = new eventing.PostgresEventStore(pool);
    const org = await pool.query<{ id: string }>(
      "insert into organizations (name, timezone) values ('backfill', 'UTC') returning id",
    );
    orgId = org.rows[0]?.id as string;
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  const seedProject = async (): Promise<{ projectId: string; taskId: string }> => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const project = await pool.query<{ id: string }>(
      `insert into projects (org_id, key, name, repo_url)
       values ($1, $2, 'API', 'https://git.example.test/acme/api.git') returning id`,
      [orgId, `api-${suffix}`],
    );
    const projectId = project.rows[0]?.id as string;
    const task = await pool.query<{ id: string }>(
      `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template)
       values ($1, 'fake-jira', $2, 'https://jira.example.test/x', 'feature') returning id`,
      [projectId, `ACME-${suffix}`],
    );
    return { projectId, taskId: task.rows[0]?.id as string };
  };

  /** The same story for any project: a merge, two rebase settlements, a warning, a review, a lint. */
  const story = (projectId: string, taskId: string): readonly Record<string, unknown>[] => {
    const mr = {
      provider: 'gitlab',
      project_path: 'acme/api',
      iid: 7,
      url: 'https://git.example.test/acme/api/-/merge_requests/7',
      branch: 'agentic/ACME-1',
      head_sha: 'a'.repeat(40),
    };
    return [
      {
        type: 'task.rebase.checked',
        occurred_at: at(0),
        payload: {
          project_id: projectId,
          task_id: taskId,
          mr,
          conflicts: true,
          attempt: 1,
          outcome: 'resolved',
        },
      },
      {
        type: 'task.rebase.checked',
        occurred_at: at(5),
        payload: {
          project_id: projectId,
          task_id: taskId,
          mr,
          conflicts: false,
          attempt: 1,
          outcome: 'clean',
        },
      },
      {
        type: 'task.conflict.warned',
        occurred_at: at(10),
        payload: {
          project_id: projectId,
          task_id: taskId,
          mr,
          other_task_id: '00000000-0000-4000-8000-0000000000c9',
          other_ticket_key: 'ACME-98',
          paths: ['src/retry.ts'],
          path_count: 4,
          truncated: false,
        },
      },
      {
        type: 'task.review.observed',
        occurred_at: at(15),
        payload: {
          project_id: projectId,
          task_id: taskId,
          mr,
          head_sha_reviewed: 'a'.repeat(40),
          head_sha_now: 'b'.repeat(40),
          threads_posted: 5,
          threads_resolved: 4,
          threads_accepted: 3,
          threads_dismissed: 1,
          threads_unresolved: 1,
        },
      },
      {
        type: 'task.lint.posted',
        occurred_at: at(20),
        payload: {
          project_id: projectId,
          task_id: taskId,
          ticket: {
            provider: 'jira',
            key: 'ACME-4',
            url: 'https://tickets.example.test/browse/ACME-4',
          },
          score: 62,
          missing: [],
          questions_posted: 3,
          ticket_updated_at: null,
        },
      },
      {
        type: 'mr.merged',
        occurred_at: at(30),
        payload: {
          project_id: projectId,
          task_id: taskId,
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

  const projector = () => statsHandlers({ store: stats.createPostgresStatsStore() });

  const countersOf = async (projectId: string): Promise<readonly ComparableCounter[]> => {
    const { rows } = await pool.query<ComparableCounter>(
      `select to_char(day, 'YYYY-MM-DD') as day, metric, count::text as count, total::text as total
         from stats_event_daily where project_id = $1 order by day, metric`,
      [projectId],
    );
    return rows;
  };

  const deliveriesOf = async (projectId: string): Promise<readonly { merged_at: string }[]> => {
    const { rows } = await pool.query<{ merged_at: string }>(
      `select to_char(merged_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') as merged_at
         from stats_task_delivery where project_id = $1 order by merged_at`,
      [projectId],
    );
    return rows;
  };

  it('replays a range into rows equal to a live dispatch’s, and a second pass changes nothing', async () => {
    const live = await seedProject();
    const backfilled = await seedProject();

    // ── (1) the production path: a bus that has the projector ──
    const bus = new EventBus({ unitOfWork, retryDelayMs: 0, maxRetryDelayMs: 0 });
    for (const handler of projector()) {
      bus.register(handler);
    }
    let seq = 0;
    for (const spec of story(live.projectId, live.taskId)) {
      seq += 1;
      const [appended] = await unitOfWork.transaction(async (scope) =>
        scope.events.append([eventFor(live.taskId, seq, spec)]),
      );
      expect((await bus.dispatch(appended as NonNullable<typeof appended>)).status).toBe(
        'dispatched',
      );
    }

    const liveCounters = await countersOf(live.projectId);
    // Six events, six counter rows: two rebase outcomes, one conflict, three review counters and
    // one lint — and `review_only.observed` beside the three thread totals.
    expect(liveCounters.map((row) => [row.metric, row.count, row.total])).toEqual([
      ['conflict.warned', '1', '4.000000'],
      ['rebase.clean', '1', '0.000000'],
      ['rebase.resolved', '1', '0.000000'],
      ['review_only.observed', '1', '0.000000'],
      ['review_only.threads_accepted', '1', '3.000000'],
      ['review_only.threads_dismissed', '1', '1.000000'],
      ['review_only.threads_posted', '1', '5.000000'],
      ['ticket_lint.posted', '1', '3.000000'],
    ]);
    expect(await deliveriesOf(live.projectId)).toHaveLength(1);

    // ── (2) the world before this work package: a sweeper with no projector ──
    const sweeper = new EventBus({ unitOfWork, retryDelayMs: 0, maxRetryDelayMs: 0 });
    let firstPosition = 0;
    let lastPosition = 0;
    seq = 0;
    for (const spec of story(backfilled.projectId, backfilled.taskId)) {
      seq += 1;
      const [appended] = await unitOfWork.transaction(async (scope) =>
        scope.events.append([eventFor(backfilled.taskId, seq, spec)]),
      );
      const stored = appended as NonNullable<typeof appended>;
      firstPosition = firstPosition === 0 ? stored.position : firstPosition;
      lastPosition = stored.position;
      expect((await sweeper.dispatch(stored)).status).toBe('dispatched');
    }
    expect(await countersOf(backfilled.projectId)).toEqual([]);
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
    expect(await countersOf(backfilled.projectId)).toEqual(liveCounters);
    expect(await deliveriesOf(backfilled.projectId)).toEqual(await deliveriesOf(live.projectId));

    // ── and a second pass is a no-op ──
    const second = await replayEvents({ store, unitOfWork }, range);
    expect(second).toMatchObject({ scanned: 6, applied: 0, skipped: 6 });
    expect(await countersOf(backfilled.projectId)).toEqual(liveCounters);
  }, 120_000);

  it('does not count twice for an event the dispatcher already gave the projector', async () => {
    const project = await seedProject();
    const bus = new EventBus({ unitOfWork, retryDelayMs: 0, maxRetryDelayMs: 0 });
    for (const handler of projector()) {
      bus.register(handler);
    }
    // A counter is the half of the fold that is **not** idempotent on its own: a second execution
    // would add to the row again, so what stops it is the `handler_executions` claim and nothing
    // else (standing rule 79 — the assertion is on the rows, never on a return value).
    const [appended] = await unitOfWork.transaction(async (scope) =>
      scope.events.append([
        eventFor(project.taskId, 1, {
          type: 'task.rebase.checked',
          occurred_at: at(0),
          payload: {
            project_id: project.projectId,
            task_id: project.taskId,
            mr: {
              provider: 'gitlab',
              project_path: 'acme/api',
              iid: 7,
              url: 'https://git.example.test/acme/api/-/merge_requests/7',
            },
            conflicts: false,
            attempt: 0,
            outcome: 'clean',
          },
        }),
      ]),
    );
    const stored = appended as NonNullable<typeof appended>;
    await bus.dispatch(stored);
    const counted = await countersOf(project.projectId);
    expect(counted.map((row) => row.count)).toEqual(['1']);

    const report = await replayEvents(
      { store, unitOfWork },
      { handlers: projector(), fromPosition: stored.position - 1, toPosition: stored.position },
    );
    expect(report).toMatchObject({ scanned: 1, applied: 0, skipped: 1 });
    expect(await countersOf(project.projectId)).toEqual(counted);
  }, 120_000);
});

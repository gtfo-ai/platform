/**
 * Re-queueing a dead-lettered event, against a real PostgreSQL 18 and a real dispatcher (WP-95,
 * PROGRESS backlog 126, criterion 2: *"re-queueing a dead-lettered event dispatches it once and
 * leaves the original row"*).
 *
 * What is asserted, and why each half needs the database:
 *
 * - **The original row is left.** The re-queue changes the queue row **in place** — same
 *   `event_position`, `attempts` 0, `dead_lettered_at` cleared — and the log row at that position is
 *   byte-for-byte what it was, with nothing appended: `events` is append-only (TD-005) and a copy
 *   would be served twice by the next replay.
 * - **It is dispatched once.** After the fix, one dispatch runs the handler that failed exactly once
 *   more; the handler that had already **succeeded** for the event does not run again — its effect
 *   (a real row, as in `dispatcher.integration.test.ts`) is still one — because
 *   `handler_executions` records the success and the claim skips it. A further dispatch finds no
 *   queue row and does nothing.
 * - **The locking read is the arbiter** (standing rule 9): two re-queues fired together
 *   produce one success and one `not_dead_lettered`, and a re-queue of a row in any other state is
 *   refused by name.
 * - **The list's task join** resolves an event on a task's stream to that task, and an event on a
 *   stream that is no task to `null` — the population the list exists for.
 */

import {
  createDeadLetterCommands,
  type DeadLetterCommands,
  DeadLetterRequeueRefusedError,
  EventBus,
  streamId,
  taskQueued,
} from '@platform/application';
import type { Id } from '@platform/contracts';
import { eventing } from '@platform/infrastructure';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

const APP_ROLE = 'platform_app';
/** Small, so a dead letter takes two dispatches rather than ten. */
const MAX_ATTEMPTS = 2;

describe('re-queueing a dead-lettered event (PostgreSQL)', () => {
  let database: MigratedDatabase;
  let pool: pg.Pool;
  let unitOfWork: eventing.PostgresUnitOfWork;
  let commands: DeadLetterCommands;
  let taskId: Id;

  beforeAll(async () => {
    database = await createMigratedDatabase('dead-letter-requeue');
    pool = createTestPool(database.connectionString, {
      options: `-c role=${APP_ROLE}`,
      // Two connections per dispatch, two concurrent re-queues, and the assertions' reads.
      max: 8,
      connectionTimeoutMillis: 5_000,
    });
    unitOfWork = new eventing.PostgresUnitOfWork({ pool });
    commands = createDeadLetterCommands({
      unitOfWork,
      store: new eventing.PostgresDeadLetterStore(pool),
    });
    const org = await pool.query<{ id: string }>(
      "insert into organizations (name) values ('dead-letters') returning id",
    );
    const project = await pool.query<{ id: string }>(
      `insert into projects (org_id, key, name, repo_url)
       values ($1, 'acme', 'ACME', 'https://git.example.test/acme/api.git') returning id`,
      [org.rows[0]?.id],
    );
    const task = await pool.query<{ id: string }>(
      `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template)
       values ($1, 'fake-jira', 'ACME-7', 'https://jira.example.test/browse/ACME-7', 'feature')
       returning id`,
      [project.rows[0]?.id],
    );
    taskId = task.rows[0]?.id as Id;
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  const effects = async (action: string): Promise<number> => {
    const { rows } = await pool.query<{ count: string }>(
      'select count(*) as count from human_actions where action = $1',
      [action],
    );
    return Number(rows[0]?.count ?? 0);
  };

  /**
   * A dispatcher with two handlers on `task.queued`: one that always succeeds and one that fails
   * while `state.broken` holds. Each writes a real row as its effect.
   */
  const world = (tag: string) => {
    const state = { broken: true, flakyRuns: 0, firstRuns: 0 };
    const bus = new EventBus({
      unitOfWork,
      retryDelayMs: 0,
      maxRetryDelayMs: 0,
      maxDispatchAttempts: MAX_ATTEMPTS,
    });
    const effect = async (context: { scope: { tx: { adapter: string } } }, action: string) => {
      const { client } = eventing.postgresTransaction(context.scope.tx);
      await client.query('insert into human_actions (action) values ($1)', [action]);
    };
    bus.register({
      name: `${tag}.first`,
      priority: 10,
      eventTypes: ['task.queued'],
      handle: async (context) => {
        state.firstRuns += 1;
        await effect(context, `${tag}.first:${context.event.position}`);
      },
    });
    bus.register({
      name: `${tag}.flaky`,
      priority: 20,
      eventTypes: ['task.queued'],
      handle: async (context) => {
        state.flakyRuns += 1;
        if (state.broken) {
          throw new Error(`deterministic until fixed: ${tag}`);
        }
        await effect(context, `${tag}.flaky:${context.event.position}`);
      },
    });
    return { bus, state };
  };

  const deadLetteredEvent = async (tag: string, stream: Id) => {
    const { bus, state } = world(tag);
    // The task's stream is used by more than one case, so the sequence is read, not assumed.
    const streamSeq = await new eventing.PostgresEventStore(pool).nextStreamSequence(
      'task',
      stream,
    );
    const [event] = await unitOfWork.transaction(async (scope) =>
      scope.events.append([taskQueued({ streamType: 'task', streamId: stream, streamSeq })]),
    );
    if (event === undefined) {
      throw new Error('append returned nothing');
    }
    // Dispatched directly rather than swept: other cases in this file leave their own rows.
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      await bus.dispatch(event);
    }
    return { bus, state, event };
  };

  const queueRow = async (position: number) =>
    (
      await pool.query<{
        position: string;
        attempts: number;
        dead: Date | null;
        handler: string | null;
      }>(
        `select event_position as position, attempts, dead_lettered_at as dead,
                dead_letter_handler as handler
           from event_dispatch where event_position = $1`,
        [position],
      )
    ).rows[0];

  const logRow = async (position: number) =>
    (
      await pool.query<{ id: string; type: string; payload: unknown; stream_seq: number }>(
        'select id, type, payload, stream_seq from events where position = $1',
        [position],
      )
    ).rows;

  const countEvents = async (): Promise<number> =>
    Number(
      (await pool.query<{ count: string }>('select count(*) as count from events')).rows[0]?.count,
    );

  it('re-queues in place, leaves the log row, and dispatches the event once', async () => {
    const { bus, state, event } = await deadLetteredEvent('once', taskId);
    // The dead letter, as WP-49 leaves it: terminal, naming the handler; one effect of the handler
    // that succeeded, none of the one that failed.
    expect(await queueRow(event.position)).toMatchObject({
      attempts: MAX_ATTEMPTS,
      handler: 'once.flaky',
    });
    expect((await queueRow(event.position))?.dead).not.toBeNull();
    expect(state.firstRuns).toBe(1);
    expect(await effects(`once.first:${event.position}`)).toBe(1);
    expect(await effects(`once.flaky:${event.position}`)).toBe(0);
    const logBefore = await logRow(event.position);
    const eventsBefore = await countEvents();

    const requeued = await commands.requeue(event.position);
    expect(requeued.row).toMatchObject({
      position: event.position,
      handler: 'once.flaky',
      attempts: MAX_ATTEMPTS,
      task: { id: taskId, ticketKey: 'ACME-7', projectKey: 'acme' },
    });

    // **The original row is left**: the same queue row, back to pending, and the log untouched —
    // the same event at the same position, and nothing appended.
    expect(await queueRow(event.position)).toEqual({
      position: String(event.position),
      attempts: 0,
      dead: null,
      handler: null,
    });
    expect(await logRow(event.position)).toEqual(logBefore);
    expect(logBefore).toHaveLength(1);
    expect(await countEvents()).toBe(eventsBefore);

    // **Dispatched once**: the fix lands, one dispatch runs the failed handler once more and skips
    // the one that already succeeded — its effect is still one.
    state.broken = false;
    const flakyBefore = state.flakyRuns;
    expect((await bus.dispatch(event)).status).toBe('dispatched');
    expect(state.flakyRuns).toBe(flakyBefore + 1);
    expect(state.firstRuns).toBe(1);
    expect(await effects(`once.first:${event.position}`)).toBe(1);
    expect(await effects(`once.flaky:${event.position}`)).toBe(1);
    // …and a second dispatch finds nothing to do: the queue row completed as any dispatch does.
    expect((await bus.dispatch(event)).status).toBe('completed');
    expect(state.flakyRuns).toBe(flakyBefore + 1);
    expect(await effects(`once.flaky:${event.position}`)).toBe(1);
    expect(await queueRow(event.position)).toBeUndefined();
    expect(await logRow(event.position)).toEqual(logBefore);

    // A re-queue now has nothing to act on, and says why.
    await expect(commands.requeue(event.position)).rejects.toMatchObject({
      refusal: 'already_dispatched',
    });
  });

  it('refuses a row that is queued and not dead-lettered, and a position with no event', async () => {
    const [pending] = await unitOfWork.transaction(async (scope) =>
      scope.events.append([
        taskQueued({ streamType: 'task', streamId: streamId(9_501) as Id, streamSeq: 1 }),
      ]),
    );
    if (pending === undefined) {
      throw new Error('append returned nothing');
    }
    await expect(commands.requeue(pending.position)).rejects.toMatchObject({
      refusal: 'not_dead_lettered',
    });
    // Refused, so untouched.
    expect(await queueRow(pending.position)).toMatchObject({ attempts: 0, dead: null });
    await expect(commands.requeue(987_654_321)).rejects.toMatchObject({
      refusal: 'unknown_event',
    });
  });

  it('lets exactly one of two concurrent re-queues through', async () => {
    const { event } = await deadLetteredEvent('race', streamId(9_502) as Id);
    const outcomes = await Promise.allSettled([
      commands.requeue(event.position),
      commands.requeue(event.position),
    ]);
    const accepted = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const refused = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(accepted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    const reason = (refused[0] as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(DeadLetterRequeueRefusedError);
    expect((reason as DeadLetterRequeueRefusedError).refusal).toBe('not_dead_lettered');
    expect(await queueRow(event.position)).toMatchObject({ attempts: 0, dead: null });
  });

  it('lists dead letters newest first, with the task an event names and null for none', async () => {
    const onTask = await deadLetteredEvent('list-task', taskId);
    const onNothing = await deadLetteredEvent('list-none', streamId(9_503) as Id);
    const page = await commands.list({ limit: 50 });
    const positions = page.items.map((item) => item.position);
    expect(positions).toEqual([...positions].sort((a, b) => b - a));
    expect(page.total).toBe(page.items.length);
    const task = page.items.find((item) => item.position === onTask.event.position);
    const none = page.items.find((item) => item.position === onNothing.event.position);
    expect(task).toMatchObject({
      eventType: 'task.queued',
      streamType: 'task',
      handler: 'list-task.flaky',
      attempts: MAX_ATTEMPTS,
      task: { id: taskId, ticketKey: 'ACME-7', projectKey: 'acme' },
    });
    expect(task?.error).toContain('deterministic until fixed');
    expect(none?.task).toBeNull();
    // The cursor pages strictly below the position it names.
    const below = await commands.list({ limit: 50, beforePosition: onNothing.event.position });
    expect(below.items.every((item) => item.position < onNothing.event.position)).toBe(true);
  });
});

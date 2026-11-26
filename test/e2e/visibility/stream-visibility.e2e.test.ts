/**
 * **The live stream says nothing about a hidden project** — BD-035 over a real `GET /events`
 * (S-30.3 acceptance 4).
 *
 * The narrowed member (one worker, scoped to [A]), a member who chose nothing and the administrator
 * each hold an `org` stream. An event is appended for a task in B, then one for a task in A, by the
 * production appender — whose live hint wakes this instance's domain-event bridge — so every frame
 * crosses the real read, the real projection and the real hub. The narrowed stream receives A's
 * frame and never B's; the other two receive both. The A frame is the narrowed stream's own
 * positive control: B's was appended first, so by the time A's arrived B's had been decided.
 *
 * The pipeline is not composed (`pipeline: null`): nothing reacts to the appended events, so the
 * only thing they do is reach the streams.
 */
import { taskDequeued } from '@platform/application';
import type { Id } from '@platform/contracts';
import { eventing } from '@platform/infrastructure';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestPool } from '../../integration/support/postgres.js';
import { type Instance, startInstance } from '../support/instance.js';
import { SseStream } from '../support/sse-client.js';
import { type VisibilityWorld, visibilityWorld } from '../support/visibility.js';

let instance: Instance;
let world: VisibilityWorld;
const streams: SseStream[] = [];

beforeEach(async () => {
  instance = await startInstance({ label: 'stream-visibility', pipeline: null });
  world = await visibilityWorld(instance);
}, 180_000);

afterEach(async () => {
  for (const stream of streams.splice(0)) {
    await stream.disconnect();
  }
  await instance?.stop();
});

/** Appends one `task.dequeued` for `taskId` in `projectId`, as the pipeline's appender does. */
const appendFor = async (taskId: string, projectId: string): Promise<number> => {
  const pool = createTestPool(instance.database.connectionString, { max: 2 });
  try {
    const unitOfWork = new eventing.PostgresUnitOfWork({ pool });
    const store = new eventing.PostgresEventStore(pool);
    const streamSeq = await store.nextStreamSequence('task', taskId as Id);
    return await unitOfWork.transaction(async (scope) => {
      const [event] = await scope.events.append([
        taskDequeued(
          { streamType: 'task', streamId: taskId as Id, streamSeq },
          taskId as Id,
          projectId as Id,
        ),
      ]);
      if (event === undefined) {
        throw new Error('append returned nothing');
      }
      return event.position;
    });
  } finally {
    await pool.end();
  }
};

const openOrg = async (client: VisibilityWorld['admin']): Promise<SseStream> => {
  const stream = await SseStream.open(`${instance.baseUrl}/events?topics=org`, {
    headers: client.headers(),
  });
  streams.push(stream);
  expect(stream.response.status).toBe(200);
  await stream.waitFor(() => stream.events().length >= 1, 'the opening frame');
  return stream;
};

const taskIdsOf = (stream: SseStream): string[] =>
  stream
    .events()
    .filter((event) => event.event === 'task.dequeued')
    .map((event) => (JSON.parse(event.data) as { data: { task_id: string } }).data.task_id);

describe('the org stream, per person (BD-035)', () => {
  it('carries nothing about B to the member whose worker takes [A], and everything to the others', async () => {
    const narrowed = await openOrg(world.narrowed);
    const open = await openOrg(world.open);
    const admin = await openOrg(world.admin);

    await appendFor(world.taskB, world.projectB);
    await appendFor(world.taskA, world.projectA);

    for (const stream of [open, admin]) {
      await stream.waitFor(() => taskIdsOf(stream).length >= 2, 'both frames');
      expect(taskIdsOf(stream)).toEqual([world.taskB, world.taskA]);
    }
    await narrowed.waitFor(() => taskIdsOf(narrowed).includes(world.taskA), 'A’s frame');
    expect(taskIdsOf(narrowed)).toEqual([world.taskA]);
  });

  it('answers a topic of B as one that does not exist, at /events and at /events/subscriptions', async () => {
    const hidden = await SseStream.open(
      `${instance.baseUrl}/events?topics=project:${world.projectB}`,
      { headers: world.narrowed.headers() },
    );
    streams.push(hidden);
    expect(hidden.response.status).toBe(404);
    const missing = await SseStream.open(
      `${instance.baseUrl}/events?topics=project:00000000-0000-4000-8000-0000000dead0`,
      { headers: world.narrowed.headers() },
    );
    streams.push(missing);
    expect(missing.response.status).toBe(404);

    const stream = await SseStream.open(
      `${instance.baseUrl}/events?topics=org&connection_id=narrowed-1`,
      { headers: world.narrowed.headers() },
    );
    streams.push(stream);
    expect(stream.response.status).toBe(200);
    const added = await world.narrowed.post('/events/subscriptions', {
      connection_id: 'narrowed-1',
      add: [`task:${world.taskB}`],
    });
    expect(added.status).toBe(404);
    const allowed = await world.narrowed.post('/events/subscriptions', {
      connection_id: 'narrowed-1',
      add: [`task:${world.taskA}`],
    });
    expect(allowed.status).toBe(200);
  });
});

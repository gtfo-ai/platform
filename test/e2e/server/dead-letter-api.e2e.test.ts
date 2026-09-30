/**
 * **The dead-letter pair on a whole `apps/server` instance** (WP-95, PROGRESS backlog 126).
 *
 * The route test drives both routes through fakes and the integration test drives the store and a
 * dispatcher against PostgreSQL; neither is evidence that `runtime.ts` composes the pair, that the
 * admin gate holds on a real session, or that the instance's **own** dispatcher serves a re-queued
 * event. This file is.
 *
 * The dead letter is made the way the bus leaves one, in the transaction that appended the event —
 * so no dispatcher ever sees it pending — on an event type this build declares **unconsumed**
 * (`task.dequeued`): re-dispatching it runs no handler, so the instance's worker completing it is
 * the whole observable, and nothing else in the instance moves. What is asserted: the list names it
 * with its task and a redacted error; a maintainer is refused; the re-queue answers 200, writes one
 * `human_actions` row on the task, and the instance dispatches the event — the queue row completes
 * — while `events` keeps exactly the one row it had.
 */
import { taskDequeued } from '@platform/application';
import { deadLettersResponseSchema, type Id } from '@platform/contracts';
import { eventing } from '@platform/infrastructure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestClient, createTestPool } from '../../integration/support/postgres.js';
import {
  BOOTSTRAP_EMAIL,
  BOOTSTRAP_PASSWORD,
  Client,
  type Instance,
  type SeededProject,
  seedProject,
  startInstance,
} from '../support/instance.js';

/** Obviously fake, in a shape the platform's redaction patterns catch. */
const FAKE_TOKEN = 'glpat-FAKE000000000000000';

let instance: Instance;
let seeded: SeededProject;

beforeAll(async () => {
  instance = await startInstance({ label: 'dead-letters', logLevel: 'error' });
  seeded = await seedProject(instance);
}, 180_000);

afterAll(async () => {
  await instance?.stop();
});

const rows = async <T extends Record<string, unknown>>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> => {
  const client = createTestClient(instance.database.connectionString);
  await client.connect();
  try {
    return (await client.query<T>(text, [...params])).rows;
  } finally {
    await client.end();
  }
};

const signIn = async (email: string, password: string): Promise<Client> => {
  const client = new Client(instance.baseUrl);
  const response = await client.post('/api/auth/sign-in/email', { email, password });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return client;
};

/** One event on the seeded task's stream, dead-lettered in the transaction that appended it. */
const deadLetter = async (): Promise<number> => {
  const pool = createTestPool(instance.database.connectionString, { max: 2 });
  try {
    const unitOfWork = new eventing.PostgresUnitOfWork({ pool });
    const store = new eventing.PostgresEventStore(pool);
    const taskId = seeded.taskId as Id;
    const streamSeq = await store.nextStreamSequence('task', taskId);
    return await unitOfWork.transaction(async (scope) => {
      const [event] = await scope.events.append([
        taskDequeued(
          { streamType: 'task', streamId: taskId, streamSeq },
          taskId,
          seeded.projectId as Id,
        ),
      ]);
      if (event === undefined) {
        throw new Error('append returned nothing');
      }
      const { client } = eventing.postgresTransaction(scope.tx);
      await client.query(
        `update event_dispatch
            set attempts = 10, dead_lettered_at = now(), dead_letter_handler = 'e2e.fixture',
                error = $2
          where event_position = $1`,
        [event.position, `provider refused token ${FAKE_TOKEN}`],
      );
      return event.position;
    });
  } finally {
    await pool.end();
  }
};

/** Polls a condition a bounded number of times; the dispatcher's own poll is one second. */
const eventually = async (check: () => Promise<boolean>, what: string): Promise<void> => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
};

describe('the dead-letter pair, on a running instance', () => {
  it('lists, refuses a maintainer, re-queues with one audit row, and the instance dispatches it once', async () => {
    const position = await deadLetter();
    const admin = await signIn(BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD);

    // ── the list ────────────────────────────────────────────────────────────
    const listed = await admin.json<unknown>('/api/org/dead-letters');
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    const page = deadLettersResponseSchema.parse(listed.body);
    const item = page.items.find((entry) => entry.position === position);
    expect(item).toMatchObject({
      event_type: 'task.dequeued',
      stream_type: 'task',
      handler: 'e2e.fixture',
      attempts: 10,
      task: { id: seeded.taskId, ticket_key: 'E2E-1', project_key: 'e2e' },
    });
    expect(item?.error).toContain('provider refused token');
    expect(item?.error).not.toContain(FAKE_TOKEN);
    expect(page.total).toBeGreaterThanOrEqual(1);

    // ── a maintainer is refused both ────────────────────────────────────────
    const created = await admin.post<{ user: { id: string } }>('/api/auth/admin/create-user', {
      email: 'maintainer@example.test',
      password: 'not-a-real-password-maint-0000',
      name: 'maintainer',
      role: 'maintainer',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const maintainer = await signIn('maintainer@example.test', 'not-a-real-password-maint-0000');
    expect((await maintainer.json('/api/org/dead-letters')).status).toBe(403);
    const refused = await maintainer.json(`/api/org/dead-letters/${position}/requeue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(refused.status).toBe(403);

    const eventsBefore = await rows<{ id: string; payload: unknown }>(
      'select id, payload from events where position = $1',
      [position],
    );
    expect(eventsBefore).toHaveLength(1);

    // ── the re-queue ────────────────────────────────────────────────────────
    const requeued = await admin.json<{ position: number; performed: boolean }>(
      `/api/org/dead-letters/${position}/requeue`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'e2e-requeue-1' },
        body: '{}',
      },
    );
    expect(requeued.status, JSON.stringify(requeued.body)).toBe(200);
    expect(requeued.body).toMatchObject({ position, performed: true });

    const audit = await rows<{ task_id: string | null; params: Record<string, unknown> }>(
      "select task_id, params from human_actions where action = 'org.dead_letter.requeue'",
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.task_id).toBe(seeded.taskId);
    expect(audit[0]?.params).toMatchObject({
      position,
      handler: 'e2e.fixture',
      idempotency_key: 'e2e-requeue-1',
    });

    // The instance's own dispatcher serves it: the queue row completes, the log keeps its one row.
    await eventually(
      async () =>
        (await rows('select 1 from event_dispatch where event_position = $1', [position]))
          .length === 0,
      `the instance to dispatch event ${position}`,
    );
    expect(
      await rows<{ id: string; payload: unknown }>(
        'select id, payload from events where position = $1',
        [position],
      ),
    ).toEqual(eventsBefore);

    // A replay performs nothing and writes no second row; a new key finds nothing to re-queue.
    const replay = await admin.json<{ performed: boolean }>(
      `/api/org/dead-letters/${position}/requeue`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'e2e-requeue-1' },
        body: '{}',
      },
    );
    expect(replay.status).toBe(200);
    expect(replay.body.performed).toBe(false);
    const again = await admin.json<{ error: { code: string } }>(
      `/api/org/dead-letters/${position}/requeue`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    );
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('event_already_dispatched');
    expect(
      await rows("select 1 from human_actions where action = 'org.dead_letter.requeue'"),
    ).toHaveLength(1);
  });
});

/**
 * A task or run event appended by one instance reaches a stream another instance holds (S-23.14).
 *
 * "Instance A" is a pool and a `PostgresUnitOfWork` — the production appender, publishing its live
 * hint inside the transaction. "Instance B" is another pool, its own `PostgresBroadcast` listening
 * connection, an `SseHub` and the bridge over the production read (`readLiveEvents`). They share
 * nothing but the database, which is the claim: the `NOTIFY` is delivered after A's commit, and B
 * reads the rows back itself. The unit tier (`apps/server/src/sse/domain-event-bridge.test.ts`)
 * covers the bridge's decisions against a double; this file is what only PostgreSQL can answer —
 * the hint really is delivered after the commit, the range it names is readable when it arrives,
 * and the read's type and scope filters are SQL that means what it says.
 */
import { LIVE_EVENTS_APPENDED_TOPIC, makeEvent, streamId, taskQueued } from '@platform/application';
import type { Id, SseFrame, SseTopic } from '@platform/contracts';
import { sseFrameSchema } from '@platform/contracts';
import { broadcast as broadcastAdapter, db, eventing } from '@platform/infrastructure';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readLiveEvents } from '../../../apps/server/src/queries/live-event-queries.js';
import {
  type DomainEventBridge,
  type LiveEventReadRequest,
  startDomainEventBridge,
} from '../../../apps/server/src/sse/domain-event-bridge.js';
import { SseHub, type SseTransport } from '../../../apps/server/src/sse/hub.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

const PROJECT = '00000000-0000-4000-8000-0000000000ff' as Id;
const USER = '00000000-0000-4000-8000-0000000000aa';
const PLANT = 'PLANTED-question-words';

interface Sent {
  readonly id?: string;
  readonly event?: string;
  readonly data: unknown;
}

let database: MigratedDatabase;
let poolA: pg.Pool;
let poolB: pg.Pool;
let instanceA: eventing.PostgresUnitOfWork;

beforeAll(async () => {
  database = await createMigratedDatabase('domain-event-bridge');
  poolA = createTestPool(database.connectionString, { options: '-c role=platform_app', max: 4 });
  poolB = createTestPool(database.connectionString, { options: '-c role=platform_app', max: 4 });
  instanceA = new eventing.PostgresUnitOfWork({ pool: poolA });
}, 180_000);

afterAll(async () => {
  await poolA?.end();
  await poolB?.end();
  await database?.drop();
});

/** Instance B: its own listening connection, hub and bridge, reading through the production query. */
const startInstanceB = async () => {
  const broadcast = new broadcastAdapter.PostgresBroadcast({
    connectionString: database.connectionString,
    publisher: poolB,
  });
  const hub = new SseHub({
    bufferSize: 64,
    maxQueuedFrames: 256,
    maxTopicsPerConnection: 8,
    maxBufferedTopics: 16,
    retryMs: 1_000,
    pingIntervalMs: 0,
    maxConnections: 8,
    shutdownDrainMs: 500,
  });
  const drizzled = drizzle(poolB, { schema: db.schema });
  const reads: { request: LiveEventReadRequest; positions: number[] }[] = [];
  const bridge: DomainEventBridge = await startDomainEventBridge({
    hub,
    broadcast,
    read: async (request) => {
      const rows = await readLiveEvents(drizzled, request);
      reads.push({ request, positions: rows.map((row) => row.position) });
      return rows;
    },
  });
  // A second listener on the same connection, so a test can wait for the hint itself to arrive.
  const hints: unknown[] = [];
  const hintWatch = await broadcast.subscribe([LIVE_EVENTS_APPENDED_TOPIC], (message) => {
    hints.push(message.payload);
  });
  let connections = 0;
  const watch = (topics: readonly string[]) => {
    const sent: Sent[] = [];
    const transport: SseTransport = {
      send: async (message) => {
        sent.push(message);
      },
      comment: () => undefined,
      close: () => undefined,
      isConnected: true,
    };
    connections += 1;
    hub.open({ id: `b-${connections}`, userId: USER, topics: topics as SseTopic[], transport });
    return sent;
  };
  return {
    hub,
    bridge,
    reads,
    hints,
    watch,
    stop: async () => {
      await bridge.stop();
      await hintWatch.close();
      await hub.shutdown();
      await broadcast.close();
    },
  };
};

const frames = (sent: readonly Sent[]): (SseFrame & { frame: 'domain_event' })[] =>
  sent
    .map((message) => sseFrameSchema.parse(message.data))
    .filter(
      (frame): frame is SseFrame & { frame: 'domain_event' } => frame.frame === 'domain_event',
    );

/** Waits for a stream to have received `count` domain-event frames — the last row asserted on. */
const waitForFrames = async (sent: readonly Sent[], count: number): Promise<void> => {
  await expect.poll(() => frames(sent).length, { timeout: 15_000, interval: 20 }).toBe(count);
};

const stageEntered = (task: Id, seq: number) =>
  makeEvent(
    'task.stage.entered',
    { project_id: PROJECT, task_id: task, stage: 'development', attempt: 1 },
    { streamType: 'task', streamId: task, streamSeq: seq },
  );

describe('the domain-event bridge across two instances', () => {
  it('turns events instance A appended into frames on the streams instance B holds', async () => {
    const b = await startInstanceB();
    try {
      const task = streamId(0x5101) as Id;
      const run = streamId(0x5102) as Id;
      const question = streamId(0x5103) as Id;
      const worker = streamId(0x5104) as Id;
      const org = b.watch(['org']);
      const taskStream = b.watch([`task:${task}`]);

      const appended = await instanceA.transaction(async (scope) =>
        scope.events.append([
          stageEntered(task, 1),
          makeEvent(
            'task.question.asked',
            {
              project_id: PROJECT,
              task_id: task,
              question: {
                id: question,
                task_id: task,
                stage: 'development',
                run_id: run,
                text: PLANT,
                blocking: true,
                status: 'open',
                asked_at: new Date().toISOString(),
                reminders_sent: 0,
              },
            },
            { streamType: 'task', streamId: task, streamSeq: 2 },
          ),
          makeEvent(
            'run.claimed',
            {
              project_id: PROJECT,
              task_id: task,
              run_id: run,
              offer_id: streamId(0x5105) as Id,
              claimant_kind: 'worker',
              worker_id: worker,
              lease_epoch: 1,
            },
            { streamType: 'run', streamId: run, streamSeq: 1 },
          ),
        ]),
      );

      await waitForFrames(org, 3);
      await waitForFrames(taskStream, 3);
      const received = frames(org);
      expect(received.map((frame) => frame.seq)).toEqual(appended.map((entry) => entry.position));
      expect(received.map((frame) => frame.type)).toEqual([
        'task.stage.entered',
        'task.question.asked',
        'run.claimed',
      ]);
      expect(received[1]?.data.question_id).toBe(question);
      expect(received[2]?.data).toMatchObject({
        run_id: run,
        worker_id: worker,
        claimant_kind: 'worker',
      });
      // The agent's words stayed in the database: the stream carries ids.
      expect(JSON.stringify(org)).not.toContain(PLANT);
      expect(JSON.stringify(taskStream)).not.toContain(PLANT);
    } finally {
      await b.stop();
    }
  }, 60_000);

  it('delivers a burst of transactions in position order, each once', async () => {
    const b = await startInstanceB();
    try {
      const org = b.watch(['org']);
      const positions: number[] = [];
      for (let n = 0; n < 12; n += 1) {
        const task = streamId(0x5200 + n) as Id;
        const [stored] = await instanceA.transaction(async (scope) =>
          scope.events.append([stageEntered(task, 1)]),
        );
        positions.push(stored?.position ?? -1);
      }

      await waitForFrames(org, positions.length);
      expect(frames(org).map((frame) => frame.seq)).toEqual(positions);
    } finally {
      await b.stop();
    }
  }, 60_000);

  it('catches up an event whose hint never arrived when the next one does', async () => {
    const b = await startInstanceB();
    try {
      const org = b.watch(['org']);
      const anchor = await instanceA.transaction(async (scope) =>
        scope.events.append([stageEntered(streamId(0x5300) as Id, 1)]),
      );
      await waitForFrames(org, 1);

      // Its NOTIFY goes to a channel nobody listens on: a hint that is dropped.
      const deaf = new eventing.PostgresUnitOfWork({
        pool: poolA,
        broadcastChannel: 'nobody_listens',
      });
      const dropped = await deaf.transaction(async (scope) =>
        scope.events.append([stageEntered(streamId(0x5301) as Id, 1)]),
      );
      const next = await instanceA.transaction(async (scope) =>
        scope.events.append([stageEntered(streamId(0x5302) as Id, 1)]),
      );

      await waitForFrames(org, 3);
      expect(frames(org).map((frame) => frame.seq)).toEqual(
        [...anchor, ...dropped, ...next].map((entry) => entry.position),
      );
    } finally {
      await b.stop();
    }
  }, 60_000);

  it('reads nothing for a topic nobody watches, and only the watched task’s rows otherwise', async () => {
    const b = await startInstanceB();
    try {
      // Only a run's transcript is watched here: a live hint must cost no query.
      b.watch([`run:${streamId(0x5400)}`]);
      const first = b.hints.length;
      await instanceA.transaction(async (scope) =>
        scope.events.append([stageEntered(streamId(0x5401) as Id, 1)]),
      );
      await expect.poll(() => b.hints.length, { timeout: 15_000, interval: 20 }).toBe(first + 1);
      expect(b.bridge.pending).toBe(0);
      expect(b.reads).toEqual([]);

      // Now one task is watched: a transaction touching it and another reads back its row alone.
      const watched = streamId(0x5402) as Id;
      const other = streamId(0x5403) as Id;
      const taskStream = b.watch([`task:${watched}`]);
      const appended = await instanceA.transaction(async (scope) =>
        scope.events.append([
          stageEntered(other, 1),
          stageEntered(watched, 1),
          taskQueued({ streamType: 'task', streamId: watched, streamSeq: 2 }, watched, PROJECT),
          // Names the watched task, and is not a live type: inside the range, never read.
          makeEvent(
            'ticket.comment.added',
            {
              project_id: PROJECT,
              task_id: watched,
              ticket: {
                provider: 'jira',
                key: 'PRJ-9',
                url: 'https://jira.example.test/browse/PRJ-9',
              },
              comment_id: 'c-9',
              author: { provider: 'jira', external_id: 'a-9', verified: false },
              text: PLANT,
            },
            { streamType: 'project', streamId: streamId(0x5404) as Id, streamSeq: 1 },
          ),
        ]),
      );

      await waitForFrames(taskStream, 2);
      expect(b.reads).toHaveLength(1);
      expect(b.reads[0]?.request.scope).toEqual({
        kind: 'ids',
        projectIds: [],
        taskIds: [watched],
      });
      // The other task's row and the provider event are filtered in SQL, not after it.
      expect(b.reads[0]?.positions).toEqual([appended[1]?.position, appended[2]?.position]);
      expect(JSON.stringify(taskStream)).not.toContain(PLANT);
    } finally {
      await b.stop();
    }
  }, 60_000);
});

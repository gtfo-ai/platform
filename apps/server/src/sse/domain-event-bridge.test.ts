/**
 * The domain-event bridge's decisions, each driven against a **real** `SseHub` (S-23.14).
 *
 * The hub is real for the transcript bridge's reason: the claim is "a stored event becomes a frame
 * on a connection", not "the bridge called a method". The broadcast and the read are doubles; the
 * cross-process half — a real `NOTIFY` from one process's transaction and a real read in another —
 * is `test/integration/server/domain-event-bridge.integration.test.ts`.
 */
import type { Broadcast, BroadcastListener, BroadcastMessage, Logger } from '@platform/application';
import { LIVE_EVENTS_APPENDED_TOPIC } from '@platform/application';
import { type SseFrame, type SseTopic, sseFrameSchema } from '@platform/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type DomainEventBridge,
  type LiveEventReadRequest,
  type LiveEventRow,
  MAX_SCOPED_IDS,
  scopeOf,
  startDomainEventBridge,
} from './domain-event-bridge.js';
import { SseHub, type SseHubOptions, type SseTransport } from './hub.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT = '11111111-1111-4111-8111-222222222222';
const TASK = '22222222-2222-4222-8222-222222222222';
const OTHER_TASK = '22222222-2222-4222-8222-333333333333';
const RUN = '33333333-3333-4333-8333-333333333333';
const QUESTION = '44444444-4444-4444-8444-444444444444';
const USER = '55555555-5555-4555-8555-555555555555';
const PLANT = 'PLANTED-question-text';

const hubOptions: SseHubOptions = {
  bufferSize: 64,
  maxQueuedFrames: 256,
  maxTopicsPerConnection: 8,
  maxBufferedTopics: 16,
  retryMs: 1_000,
  pingIntervalMs: 0,
  maxConnections: 8,
  shutdownDrainMs: 500,
};

const eventId = (position: number) =>
  `00000000-0000-4000-8000-${position.toString(16).padStart(12, '0')}`;

/** A stored `task.stage.entered`, the simplest live event, at a position. */
const stageEntered = (
  position: number,
  options: { task?: string; project?: string } = {},
): LiveEventRow => ({
  position,
  id: eventId(position),
  type: 'task.stage.entered',
  stream_type: 'task',
  stream_id: options.task ?? TASK,
  occurred_at: '2026-11-05T09:00:00.000Z',
  payload: {
    project_id: options.project ?? PROJECT,
    task_id: options.task ?? TASK,
    stage: 'development',
    attempt: 1,
  },
});

const questionAsked = (position: number): LiveEventRow => ({
  position,
  id: eventId(position),
  type: 'task.question.asked',
  stream_type: 'task',
  stream_id: TASK,
  occurred_at: '2026-11-05T09:00:00.000Z',
  payload: {
    project_id: PROJECT,
    task_id: TASK,
    question: { id: QUESTION, task_id: TASK, stage: 'refinement', run_id: RUN, text: PLANT },
  },
});

const fakeBroadcast = () => {
  const listeners: { topics: ReadonlySet<string>; listener: BroadcastListener }[] = [];
  const broadcast: Broadcast = {
    publish: async (message) => {
      deliver(message);
    },
    subscribe: async (topics, listener) => {
      const entry = { topics: new Set(topics), listener };
      listeners.push(entry);
      return {
        close: async () => {
          const at = listeners.indexOf(entry);
          if (at >= 0) {
            listeners.splice(at, 1);
          }
        },
      };
    },
    close: async () => {
      listeners.length = 0;
    },
  };
  const deliver = (message: BroadcastMessage): void => {
    for (const entry of listeners) {
      if (entry.topics.has(message.topic)) {
        entry.listener(message);
      }
    }
  };
  return { broadcast, deliver };
};

interface Sent {
  readonly id?: string;
  readonly event?: string;
  readonly data: unknown;
}

interface Harness {
  readonly hub: SseHub;
  readonly bridge: DomainEventBridge;
  readonly reads: LiveEventReadRequest[];
  /** The stored rows, mutable: a test commits to it the way a transaction does. */
  readonly rows: LiveEventRow[];
  readonly logs: string[];
  /** Delivers a hint and waits for the pump to finish — never for a duration (rule 2). */
  hint(from: number, to: number): Promise<void>;
  deliver(message: BroadcastMessage): void;
  settle(): Promise<void>;
  watch(topics: readonly string[], id?: string): { sent: Sent[]; close: () => void };
}

const harnesses: Harness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.bridge.stop();
    await harness.hub.shutdown();
  }
});

const start = async (
  options: {
    readonly rows?: readonly LiveEventRow[];
    readonly batchSize?: number;
    readonly fail?: () => boolean;
    readonly hold?: () => Promise<void>;
  } = {},
): Promise<Harness> => {
  const hub = new SseHub(hubOptions);
  const { broadcast, deliver } = fakeBroadcast();
  const reads: LiveEventReadRequest[] = [];
  const rows = [...(options.rows ?? [])];
  const logs: string[] = [];
  const log = (_: unknown, message: string) => {
    logs.push(message);
  };
  const logger: Logger = { debug: () => undefined, info: () => undefined, warn: log, error: log };
  const bridge = await startDomainEventBridge({
    hub,
    broadcast,
    logger,
    ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
    read: async (request) => {
      reads.push(request);
      if (options.fail?.() === true) {
        throw new Error('the database said no');
      }
      await options.hold?.();
      const { scope } = request;
      return rows
        .filter((row) => row.position > request.after && row.position <= request.upTo)
        .filter((row) => {
          if (scope.kind === 'all') {
            return true;
          }
          const payload = row.payload as { project_id?: string; task_id?: string };
          return (
            scope.projectIds.includes(payload.project_id ?? '') ||
            scope.taskIds.includes(payload.task_id ?? '')
          );
        })
        .sort((a, b) => a.position - b.position)
        .slice(0, request.limit);
    },
  });
  const settle = async () => {
    while (bridge.pending > 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  let connections = 0;
  const harness: Harness = {
    hub,
    bridge,
    reads,
    rows,
    logs,
    deliver,
    settle,
    hint: async (from, to) => {
      deliver({ topic: LIVE_EVENTS_APPENDED_TOPIC, payload: { from, to } });
      await settle();
    },
    watch: (topics, id) => {
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
      const handle = hub.open({
        id: id ?? `connection-${connections}`,
        userId: USER,
        topics: topics as SseTopic[],
        transport,
      });
      return { sent, close: handle.close };
    },
  };
  harnesses.push(harness);
  return harness;
};

/** The domain-event frames a stream received, parsed with the published schema. */
const frames = (sent: readonly Sent[]): (SseFrame & { frame: 'domain_event' })[] =>
  sent
    .map((message) => sseFrameSchema.parse(message.data))
    .filter(
      (frame): frame is SseFrame & { frame: 'domain_event' } => frame.frame === 'domain_event',
    );

describe('a live event somebody is watching', () => {
  it('reaches the org, project and task streams, as a projection with the position as seq', async () => {
    const harness = await start({ rows: [questionAsked(7)] });
    const org = harness.watch(['org']);
    const project = harness.watch([`project:${PROJECT}`]);
    const task = harness.watch([`task:${TASK}`]);

    await harness.hint(7, 7);

    for (const stream of [org, project, task]) {
      const received = frames(stream.sent);
      expect(received).toHaveLength(1);
      expect(received[0]?.type).toBe('task.question.asked');
      expect(received[0]?.data).toEqual({
        id: eventId(7),
        type: 'task.question.asked',
        stream_type: 'task',
        stream_id: TASK,
        occurred_at: '2026-11-05T09:00:00.000Z',
        project_id: PROJECT,
        task_id: TASK,
        question_id: QUESTION,
      });
      // The question's words never reach a browser: the client refetches through the read API.
      expect(JSON.stringify(stream.sent)).not.toContain(PLANT);
    }
    // The first message on each stream is the connection's own `retry:` ping, which has no id.
    const ids = (sent: readonly Sent[]) =>
      sent.filter((message) => message.id !== undefined).map((message) => message.id);
    expect(ids(org.sent)).toEqual(['org:7']);
    expect(ids(project.sent)).toEqual([`project:${PROJECT}:7`]);
    expect(ids(task.sent)).toEqual([`task:${TASK}:7`]);
    expect(org.sent.find((message) => message.id === 'org:7')?.event).toBe('task.question.asked');
  });

  it('publishes only to the topics that have a subscriber, so no buffer grows for nobody', async () => {
    const harness = await start({ rows: [stageEntered(3)] });
    const task = harness.watch([`task:${TASK}`]);

    await harness.hint(3, 3);

    expect(frames(task.sent)).toHaveLength(1);
    expect(harness.hub.bufferedSeqs(`task:${TASK}`)).toEqual([3]);
    expect(harness.hub.bufferedSeqs('org')).toEqual([]);
    expect(harness.hub.bufferedSeqs(`project:${PROJECT}`)).toEqual([]);
  });

  it('publishes a project stream’s event to no task topic nobody watches', async () => {
    const harness = await start({ rows: [stageEntered(4)] });
    const project = harness.watch([`project:${PROJECT}`]);

    await harness.hint(4, 4);

    expect(frames(project.sent).map((frame) => frame.seq)).toEqual([4]);
    expect(harness.hub.bufferedSeqs(`project:${PROJECT}`)).toEqual([4]);
    expect(harness.hub.bufferedSeqs(`task:${TASK}`)).toEqual([]);
    expect(harness.hub.bufferedSeqs('org')).toEqual([]);
  });

  it('starts at the range the first hint names, not at the beginning of the log', async () => {
    const harness = await start({ rows: [stageEntered(1), stageEntered(2), stageEntered(9)] });
    const org = harness.watch(['org']);

    await harness.hint(9, 9);

    expect(frames(org.sent).map((frame) => frame.seq)).toEqual([9]);
    expect(harness.reads).toEqual([{ after: 8, upTo: 9, limit: 200, scope: { kind: 'all' } }]);
  });
});

describe('nothing is read for a topic nobody watches', () => {
  it('reads nothing when no stream is open, and nothing for a stream that watches only a run', async () => {
    const harness = await start({ rows: [stageEntered(1)] });

    await harness.hint(1, 1);
    expect(harness.reads).toEqual([]);

    harness.watch([`run:${RUN}`]);
    await harness.hint(1, 1);
    expect(harness.reads).toEqual([]);

    // The counter can move: the same hint with a live topic watched reads.
    harness.watch(['org']);
    await harness.hint(1, 1);
    expect(harness.reads).toHaveLength(1);
  });

  it('scopes the read to the watched project and task when no org stream is open', async () => {
    const harness = await start({
      rows: [
        stageEntered(1, { task: OTHER_TASK, project: OTHER_PROJECT }),
        stageEntered(2),
        stageEntered(3, { task: OTHER_TASK, project: PROJECT }),
      ],
    });
    const task = harness.watch([`task:${TASK}`]);
    const project = harness.watch([`project:${PROJECT}`]);

    await harness.hint(1, 3);

    expect(harness.reads[0]?.scope).toEqual({
      kind: 'ids',
      projectIds: [PROJECT],
      taskIds: [TASK],
    });
    expect(frames(task.sent).map((frame) => frame.seq)).toEqual([2]);
    expect(frames(project.sent).map((frame) => frame.seq)).toEqual([2, 3]);
  });

  it('forgets its watermark once nobody watches, so a returning stream reads no backlog', async () => {
    const harness = await start({ rows: [stageEntered(1)] });
    const first = harness.watch(['org']);
    await harness.hint(1, 1);
    first.close();

    for (let position = 2; position <= 9; position += 1) {
      harness.rows.push(stageEntered(position));
      await harness.hint(position, position);
    }
    expect(harness.reads).toHaveLength(1);

    harness.rows.push(stageEntered(10));
    const second = harness.watch(['org']);
    await harness.hint(10, 10);

    // From the new hint's range, not from position 1: a client that opens a screen refetches it.
    expect(harness.reads.at(-1)).toMatchObject({ after: 9, upTo: 10 });
    expect(frames(second.sent).map((frame) => frame.seq)).toEqual([10]);
  });
});

describe('the catch-up read', () => {
  it('catches up events whose own hint was lost', async () => {
    const harness = await start({ rows: [stageEntered(4)] });
    const org = harness.watch(['org']);
    await harness.hint(4, 4);

    // 5 and 6 committed and their hint was dropped; 7's arrives.
    harness.rows.push(stageEntered(5), stageEntered(6), stageEntered(7));
    await harness.hint(7, 7);

    expect(frames(org.sent).map((frame) => frame.seq)).toEqual([4, 5, 6, 7]);
    expect(harness.reads.at(-1)).toMatchObject({ after: 4, upTo: 7 });
  });

  it('publishes a transaction that committed after a higher position, once, and nothing twice', async () => {
    // Positions are not in commit order: 8 and 9 belong to a transaction that committed after the
    // one that wrote 10. A watermark alone would have skipped them.
    const harness = await start({ rows: [stageEntered(10)] });
    const org = harness.watch(['org']);
    await harness.hint(10, 10);

    harness.rows.push(stageEntered(8), stageEntered(9));
    await harness.hint(8, 9);
    harness.rows.push(stageEntered(11));
    await harness.hint(11, 11);

    expect(frames(org.sent).map((frame) => frame.seq)).toEqual([10, 8, 9, 11]);
  });

  it('skips the positions it already published when a late range spans them', async () => {
    // One transaction wrote 9 and 10 and committed; another wrote 8 and 11 and committed later, so
    // its range (8, 11) re-reads 9 and 10. Each position is still published once.
    const harness = await start({ rows: [stageEntered(9), stageEntered(10)] });
    const org = harness.watch(['org']);
    await harness.hint(9, 10);

    harness.rows.push(stageEntered(8), stageEntered(11));
    await harness.hint(8, 11);

    expect(harness.reads.at(-1)).toMatchObject({ after: 7, upTo: 11 });
    expect(frames(org.sent).map((frame) => frame.seq)).toEqual([9, 10, 8, 11]);
  });

  it('keeps reading while a full batch says there may be more', async () => {
    const harness = await start({
      rows: [stageEntered(1), stageEntered(2), stageEntered(3)],
      batchSize: 2,
    });
    const org = harness.watch(['org']);

    await harness.hint(1, 3);

    expect(frames(org.sent).map((frame) => frame.seq)).toEqual([1, 2, 3]);
    expect(harness.reads.map((read) => [read.after, read.upTo])).toEqual([
      [0, 3],
      [2, 3],
    ]);
  });

  it('runs one pump: a burst that arrives mid-read is one more read, published in order', async () => {
    let release: () => void = () => undefined;
    let held = true;
    const harness = await start({
      rows: [stageEntered(1)],
      hold: () =>
        held
          ? new Promise<void>((resolve) => {
              release = () => {
                held = false;
                resolve();
              };
            })
          : Promise.resolve(),
    });
    const org = harness.watch(['org']);

    harness.deliver({ topic: LIVE_EVENTS_APPENDED_TOPIC, payload: { from: 1, to: 1 } });
    harness.rows.push(stageEntered(2), stageEntered(3), stageEntered(4));
    for (const position of [2, 3, 4]) {
      harness.deliver({
        topic: LIVE_EVENTS_APPENDED_TOPIC,
        payload: { from: position, to: position },
      });
    }
    expect(harness.reads).toHaveLength(1);
    release();
    await harness.settle();

    expect(frames(org.sent).map((frame) => frame.seq)).toEqual([1, 2, 3, 4]);
    expect(harness.reads.map((read) => [read.after, read.upTo])).toEqual([
      [0, 1],
      [1, 4],
    ]);
  });

  it('drops a malformed hint without reading, and skips a row the projection refuses', async () => {
    const harness = await start({
      rows: [{ ...stageEntered(1), id: 'not-a-uuid' }, stageEntered(2)],
    });
    const org = harness.watch(['org']);

    harness.deliver({ topic: LIVE_EVENTS_APPENDED_TOPIC, payload: { from: 3, to: 1 } });
    harness.deliver({ topic: LIVE_EVENTS_APPENDED_TOPIC, payload: { run_id: RUN } });
    await harness.settle();
    expect(harness.reads).toEqual([]);
    expect(harness.logs.filter((line) => /malformed live-event hint/.test(line))).toHaveLength(2);

    await harness.hint(1, 2);
    expect(frames(org.sent).map((frame) => frame.seq)).toEqual([2]);
    expect(harness.logs.some((line) => /projection refuses/.test(line))).toBe(true);
  });

  it('logs a failed read and reads the same range again on the next hint', async () => {
    let failing = true;
    const harness = await start({ rows: [stageEntered(1)], fail: () => failing });
    const org = harness.watch(['org']);

    await harness.hint(1, 1);
    expect(frames(org.sent)).toEqual([]);
    expect(harness.logs.some((line) => /could not read appended domain events/.test(line))).toBe(
      true,
    );

    failing = false;
    harness.rows.push(stageEntered(2));
    await harness.hint(2, 2);
    expect(frames(org.sent).map((frame) => frame.seq)).toEqual([1, 2]);
  });
});

describe('stop()', () => {
  it('waits for the read in flight and publishes nothing it returns', async () => {
    let release: () => void = () => undefined;
    const harness = await start({
      rows: [stageEntered(1)],
      hold: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    const org = harness.watch(['org']);
    harness.deliver({ topic: LIVE_EVENTS_APPENDED_TOPIC, payload: { from: 1, to: 1 } });
    expect(harness.bridge.pending).toBe(1);

    let stopped = false;
    const stopping = harness.bridge.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);

    release();
    await stopping;
    expect(harness.bridge.pending).toBe(0);
    expect(frames(org.sent)).toEqual([]);

    // And a hint after the stop reaches nobody: the subscription is closed.
    harness.deliver({ topic: LIVE_EVENTS_APPENDED_TOPIC, payload: { from: 1, to: 1 } });
    expect(harness.reads).toHaveLength(1);
  });
});

describe('scopeOf', () => {
  it('reads everything for org, the watched ids otherwise, and nothing for runs alone', () => {
    expect(scopeOf([`run:${RUN}`])).toBeNull();
    expect(scopeOf([])).toBeNull();
    expect(scopeOf([`task:${TASK}`, 'org'])).toEqual({ kind: 'all' });
    expect(scopeOf([`task:${TASK}`, `project:${PROJECT}`, `run:${RUN}`])).toEqual({
      kind: 'ids',
      projectIds: [PROJECT],
      taskIds: [TASK],
    });
  });

  it('reads every live event past its id bound rather than building an unbounded filter', () => {
    const at = (n: number) => `task:22222222-2222-4222-8222-${n.toString(16).padStart(12, '0')}`;
    const atBound = Array.from({ length: MAX_SCOPED_IDS }, (_, n) => at(n));
    expect(scopeOf(atBound)?.kind).toBe('ids');
    expect(scopeOf([...atBound, at(MAX_SCOPED_IDS)])).toEqual({ kind: 'all' });
  });
});

/**
 * The bridge's four decisions, each driven against a **real** `SseHub` (WP-15h).
 *
 * The hub is not doubled here on purpose: the whole claim is "a stored row becomes a frame on the
 * `run:<id>` topic", and a fake hub would let this file assert that the bridge called a method
 * rather than that a connection received a frame. The broadcast and the database read *are* doubles
 * — the first because the cross-process half is a PostgreSQL property and is asserted against a
 * real one in `test/integration/server/read-api.integration.test.ts`, the second because the
 * projection has its own coverage there too.
 */
import type { Broadcast, BroadcastListener, BroadcastMessage } from '@platform/application';
import { RUN_TRANSCRIPT_TOPIC } from '@platform/application';
import type { TranscriptEvent } from '@platform/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { SseHub, type SseHubOptions, type SseTransport } from './hub.js';
import { startTranscriptBridge, type TranscriptBridge } from './transcript-bridge.js';

const RUN = '11111111-1111-4111-8111-111111111111';
const OTHER_RUN = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';

const hubOptions: SseHubOptions = {
  bufferSize: 16,
  maxQueuedFrames: 64,
  maxTopicsPerConnection: 8,
  maxBufferedTopics: 16,
  retryMs: 1_000,
  pingIntervalMs: 0,
  maxConnections: 4,
  shutdownDrainMs: 500,
};

/** Records every frame written to one stream. */
const recordingTransport = () => {
  const sent: { id?: string; event?: string; data: unknown }[] = [];
  const transport: SseTransport = {
    send: async (message) => {
      sent.push(message);
    },
    comment: () => undefined,
    close: () => undefined,
    isConnected: true,
  };
  return { transport, sent };
};

/** A broadcast whose delivery the test drives by hand. */
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
  return {
    broadcast,
    deliver,
    get subscriberCount() {
      return listeners.length;
    },
  };
};

const entry = (seq: number, text: string, runId = RUN): TranscriptEvent => ({
  run_id: runId,
  seq,
  created_at: '2026-09-12T10:00:00.000Z',
  redaction_count: 0,
  kind: 'assistant',
  model: 'claude-opus-5',
  content: [{ type: 'text', text }],
});

interface Harness {
  readonly hub: SseHub;
  readonly bridge: TranscriptBridge;
  readonly deliver: (message: BroadcastMessage) => void;
  readonly reads: { runId: string; after: number | null; limit: number }[];
  /** The stored rows, mutable: a test appends to it the way a run does. */
  readonly rows: TranscriptEvent[];
  hint(runId: string, seq: number): Promise<void>;
  /** Waits for every pump to finish, rather than for a duration (standing rule 2). */
  settle(): Promise<void>;
  watch(runId: string): { sent: { id?: string; event?: string; data: unknown }[] };
}

const harnesses: Harness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.bridge.stop();
    await harness.hub.shutdown();
  }
});

const start = async (options: {
  readonly rows: readonly TranscriptEvent[];
  readonly batchSize?: number;
  readonly fail?: boolean;
  /**
   * Holds every read until the test resolves it — the only way to have two hints meet while a
   * pump is in flight, which is what decisions 3 and 3b are about. A promise the test controls
   * rather than a sleep (standing rule 2).
   */
  readonly hold?: () => Promise<void>;
}): Promise<Harness> => {
  const hub = new SseHub(hubOptions);
  const { broadcast, deliver } = fakeBroadcast();
  const reads: { runId: string; after: number | null; limit: number }[] = [];
  const rows = [...options.rows];
  const bridge = await startTranscriptBridge({
    hub,
    broadcast,
    ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
    read: async (runId, after, limit) => {
      reads.push({ runId, after, limit });
      if (options.fail === true) {
        throw new Error('the database said no');
      }
      await options.hold?.();
      return rows
        .filter((row) => row.run_id === runId && (after === null || row.seq > after))
        .slice(0, limit);
    },
  });

  const harness: Harness = {
    hub,
    bridge,
    deliver,
    reads,
    rows,
    hint: async (runId, seq) => {
      deliver({ topic: RUN_TRANSCRIPT_TOPIC, payload: { run_id: runId, seq } });
      // The listener is synchronous and the pump is not; settle it rather than sleeping.
      while (bridge.pending > 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
    settle: async () => {
      while (bridge.pending > 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
    watch: (runId) => {
      const { transport, sent } = recordingTransport();
      hub.open({
        id: `connection-${runId}`,
        userId: USER,
        topics: [`run:${runId}`],
        transport,
      });
      return { sent };
    },
  };
  harnesses.push(harness);
  return harness;
};

/** The transcript entries a stream received, unwrapped from the `SseFrame` envelope. */
const frames = (sent: { event?: string; data: unknown }[]): TranscriptEvent[] =>
  sent
    .filter((message) => message.event === 'assistant')
    .map((message) => (message.data as { data: TranscriptEvent }).data);

describe('a hint for a run somebody is watching', () => {
  it('reads the rows back and publishes one frame per entry, in seq order', async () => {
    const harness = await start({ rows: [entry(0, 'first'), entry(1, 'second')] });
    const stream = harness.watch(RUN);

    await harness.hint(RUN, 0);
    await harness.hint(RUN, 1);

    expect(frames(stream.sent)).toEqual([entry(0, 'first'), entry(1, 'second')]);
    // The frame's `seq` is the row's own, so `id:` is a position in `run_messages` and the client's
    // `Last-Event-ID` means the same thing as `?after=` on the REST endpoint.
    expect(stream.sent.filter((m) => m.event === 'assistant').map((m) => m.id)).toEqual([
      `run:${RUN}:0`,
      `run:${RUN}:1`,
    ]);
  });

  it('starts at the entry the first hint names, not at the beginning of the run', async () => {
    // A stream that opens mid-run gets its history from `GET /api/runs/:id/messages`; republishing
    // everything from seq 0 would duplicate a page the client already merged.
    const harness = await start({
      rows: [entry(0, 'old'), entry(1, 'older'), entry(2, 'new')],
    });
    const stream = harness.watch(RUN);

    await harness.hint(RUN, 2);

    expect(frames(stream.sent)).toEqual([entry(2, 'new')]);
    expect(harness.reads).toEqual([{ runId: RUN, after: 1, limit: 200 }]);
  });

  it('catches up the entries whose own hint was lost', async () => {
    // The port documents a dropped notification as normal. The hint is a position and the read is a
    // catch-up read, so the next hint that does arrive carries the gap with it.
    const harness = await start({
      rows: [entry(0, 'a'), entry(1, 'b'), entry(2, 'c'), entry(3, 'd')],
    });
    const stream = harness.watch(RUN);

    await harness.hint(RUN, 0);
    await harness.hint(RUN, 3);

    expect(frames(stream.sent)).toEqual([
      entry(0, 'a'),
      entry(1, 'b'),
      entry(2, 'c'),
      entry(3, 'd'),
    ]);
  });

  it('keeps reading while a full batch says there may be more', async () => {
    const harness = await start({
      rows: [entry(0, 'a'), entry(1, 'b'), entry(2, 'c')],
      batchSize: 2,
    });
    const stream = harness.watch(RUN);

    await harness.hint(RUN, 0);

    expect(frames(stream.sent)).toHaveLength(3);
    // Two reads, not three: the first comes back full (2 of 2) so there may be more, the second
    // comes back short and ends the pump. A third read would be one query per idle run.
    expect(harness.reads.map((read) => read.after)).toEqual([-1, 1]);
  });

  /**
   * **Decision 3, which every other case here is too fast to reach.**
   *
   * The broadcast listener is synchronous and a read is not, so hints genuinely arrive while a pump
   * is in flight. Two pumps on one run would each read from the *same* watermark and publish
   * overlapping batches in whatever order their queries returned — and the hub's replay is
   * **positional**, so an out-of-order ring buffer is a reconnect that skips entries. The second
   * hint must therefore set `again` rather than start anything.
   */
  it('runs one pump per run, and the second hint is absorbed into it', async () => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    let first = true;
    const harness = await start({
      rows: [entry(0, 'a')],
      hold: async () => {
        // Only the first read waits; the catch-up read the absorbed hint causes must not.
        if (first) {
          first = false;
          await held;
        }
      },
    });
    const stream = harness.watch(RUN);

    try {
      // Neither hint is awaited: both are delivered while the first read is still outstanding.
      harness.deliver({ topic: RUN_TRANSCRIPT_TOPIC, payload: { run_id: RUN, seq: 0 } });
      harness.rows.push(entry(1, 'b'));
      harness.deliver({ topic: RUN_TRANSCRIPT_TOPIC, payload: { run_id: RUN, seq: 1 } });
      // One pump, not two — the discriminating assertion, made while both hints are outstanding.
      expect(harness.bridge.pending).toBe(1);
      expect(harness.reads).toHaveLength(1);
    } finally {
      // In `finally`, so a failed assertion above does not leave the pump held: `afterEach` stops
      // the bridge, and stopping now waits for the read in flight (decision 3b).
      release();
    }
    await harness.settle();

    // Two reads, and the second one finds nothing: the first query resolved *after* `b` was stored,
    // so it returned both rows and left the watermark at 1 — which is the collapsing this shape
    // exists for. The absorbed hint still causes one catch-up pass rather than being dropped.
    expect(harness.reads.map((read) => read.after)).toEqual([-1, 1]);
    expect(frames(stream.sent)).toEqual([entry(0, 'a'), entry(1, 'b')]);
  });
});

describe('a hint for a run nobody is watching', () => {
  it('reads nothing', async () => {
    // TD-014: content is forwarded "only while a client is subscribed to the run". The rows are
    // durable and the endpoint serves them; a run with no viewer costs one map lookup.
    const harness = await start({ rows: [entry(0, 'unseen')] });
    await harness.hint(RUN, 0);
    expect(harness.reads).toEqual([]);
  });

  it('does not publish another run’s entries to a watched topic', async () => {
    const harness = await start({ rows: [entry(0, 'mine'), entry(0, 'theirs', OTHER_RUN)] });
    const stream = harness.watch(RUN);

    await harness.hint(OTHER_RUN, 0);

    expect(harness.reads).toEqual([]);
    expect(frames(stream.sent)).toEqual([]);
  });
});

describe('what the bridge refuses to do', () => {
  it('drops a malformed hint without stopping the subscription', async () => {
    const harness = await start({ rows: [entry(0, 'a')] });
    const stream = harness.watch(RUN);

    harness.deliver({ topic: RUN_TRANSCRIPT_TOPIC, payload: { run_id: 'not-a-uuid', seq: 0 } });
    harness.deliver({ topic: RUN_TRANSCRIPT_TOPIC, payload: { seq: 0 } });
    // Anything with the connection string can write on the channel, so the shape is re-validated.
    harness.deliver({ topic: RUN_TRANSCRIPT_TOPIC, payload: { run_id: RUN, seq: -1 } });
    expect(harness.reads).toEqual([]);

    // …and a well-formed one still works, which is what makes this a drop rather than a death.
    await harness.hint(RUN, 0);
    expect(frames(stream.sent)).toEqual([entry(0, 'a')]);
  });

  it('survives a failing read: the stream is behind, the process is not down', async () => {
    const harness = await start({ rows: [entry(0, 'a')], fail: true });
    const stream = harness.watch(RUN);

    await harness.hint(RUN, 0);

    expect(harness.reads).toHaveLength(1);
    expect(frames(stream.sent)).toEqual([]);
    expect(harness.bridge.pending).toBe(0);
  });

  it('forgets a run once nobody is watching it', async () => {
    // Decision 4: `#runs` would otherwise grow for the lifetime of the process. The observable
    // consequence is the *watermark* — a forgotten run starts again from the hint it is given.
    const harness = await start({ rows: [entry(0, 'a')] });
    const first = harness.watch(RUN);
    await harness.hint(RUN, 0);
    expect(frames(first.sent)).toEqual([entry(0, 'a')]);

    // The run keeps going after the last viewer has left.
    harness.rows.push(entry(1, 'b'), entry(2, 'c'));
    harness.hub.close(`connection-${RUN}`);
    await harness.hint(RUN, 1);

    // A remembered run would still hold watermark 0 and replay `b` as well as `c`; a forgotten one
    // starts from the hint it is given. The count is the discriminator, so it is asserted whole.
    const second = harness.watch(RUN);
    await harness.hint(RUN, 2);
    expect(frames(second.sent)).toEqual([entry(2, 'c')]);
  });

  it('stops listening when it is stopped', async () => {
    const harness = await start({ rows: [entry(0, 'a')] });
    harness.watch(RUN);
    await harness.bridge.stop();

    await harness.hint(RUN, 0);
    expect(harness.reads).toEqual([]);
  });

  /**
   * Decision 3b. `runtime.ts` closes the broadcast and then the pool on the lines after `stop()`
   * resolves, so a pump still holding a query would read from a closing pool and publish into a hub
   * the shutdown has moved past. The read in flight is waited for and its rows are **not** published
   * — they are durable, and a reconnecting client refetches them over HTTP.
   */
  it('waits for a read already in flight, and publishes nothing after it', async () => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    let finished = false;
    const harness = await start({
      rows: [entry(0, 'a')],
      hold: async () => {
        await held;
      },
    });
    const stream = harness.watch(RUN);

    harness.deliver({ topic: RUN_TRANSCRIPT_TOPIC, payload: { run_id: RUN, seq: 0 } });
    expect(harness.bridge.pending).toBe(1);

    const stopping = harness.bridge.stop().then(() => {
      finished = true;
    });
    try {
      // `stop()` has not resolved while the read is outstanding — the half a `stop()` that only
      // closed the subscription would get wrong, and it would look identical from the other side.
      await new Promise((resolve) => setImmediate(resolve));
      expect(finished).toBe(false);
    } finally {
      release();
    }
    await stopping;
    expect(finished).toBe(true);
    expect(harness.bridge.pending).toBe(0);
    expect(frames(stream.sent)).toEqual([]);
  });
});

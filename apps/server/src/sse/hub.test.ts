import type { SseFrame, SseTopic } from '@platform/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConnectionIdInUseError,
  frameEventName,
  frameId,
  parseCursor,
  parseCursors,
  ShuttingDownError,
  SseHub,
  type SseTransport,
  TooManyConnectionsError,
  TooManyTopicsError,
  UnknownConnectionError,
} from './hub.js';

const RUN = '0199aa11-2b3c-7d4e-8f90-000000000001';
const TASK = '0199aa11-2b3c-7d4e-8f90-000000000002';
const RUN_TOPIC = `run:${RUN}` as SseTopic;
const TASK_TOPIC = `task:${TASK}` as SseTopic;

const transcript = (topic: SseTopic, seq: number, message = 'hello'): SseFrame => ({
  frame: 'transcript',
  topic,
  seq,
  data: {
    run_id: RUN,
    seq,
    created_at: '2026-09-09T10:15:30Z',
    parent_tool_use_id: null,
    redaction_count: 0,
    kind: 'steer',
    message,
    author_user_id: '0199aa11-2b3c-7d4e-8f90-000000000003',
  },
});

const streamBlock = (topic: SseTopic, seq: number): SseFrame => ({
  frame: 'transcript',
  topic,
  seq,
  data: {
    run_id: RUN,
    seq,
    created_at: '2026-09-09T10:15:30Z',
    parent_tool_use_id: null,
    redaction_count: 0,
    kind: 'stream_block',
    block_index: 0,
    block: { type: 'text', text: 'partial' },
    first_delta_at: '2026-09-09T10:15:30Z',
    last_delta_at: '2026-09-09T10:15:31Z',
  },
});

type Message = { id?: string; event?: string; data: unknown; retry?: number };

interface Recorder extends SseTransport {
  /** Writes that have **drained** — the socket accepted them and the promise resolved. */
  readonly sent: Message[];
  readonly comments: string[];
  closed: boolean;
  /** Writes handed to the transport and not finished. `settle` needs it to know it is not done. */
  readonly pending: number;
  /** Of those, the ones parked on the gate. `settle` needs it to prove a stall is hopeless. */
  readonly parked: number;
  /** Drained frames, as `<event>@<id>` — the shape delivery assertions read most easily. */
  trace(): string[];
  /** The same, in the order the **bytes reached the socket**; see `recorder`. */
  wire(): string[];
}

/**
 * A fake socket that costs what a real one costs.
 *
 * `@fastify/sse` writes a frame with `reply.raw.write()`; when the kernel buffer is full that
 * returns `false` and the promise resolves only on the socket's `'drain'` event. Both are
 * **macrotasks**, so one frame costs two turns of the event loop and never a microtask. Modelling
 * the worst case on every write is deliberate — a fake may be stricter than the real adapter,
 * never kinder — and it matters three times over here:
 *
 *  - a live frame really can arrive in the middle of a replay batch, which is the interleaving
 *    every defect this file guards has lived in;
 *  - a drain detector that stops at the first turn without progress stops *between two frames*
 *    rather than at the end. With this transport the old detector reported **2** of 766 frames; and
 *  - **the byte order is the call order, not the completion order.** `send()` formats the frame and
 *    calls `reply.raw.write()` *synchronously*, inside `writeToStream`'s promise executor
 *    (`node_modules/@fastify/sse/index.js`, `writeToStream`); only waiting for `'drain'` is
 *    asynchronous. A frame written past the chain while a chain link is mid-drain therefore lands
 *    on the wire *after* that link's bytes and *before* its promise settles. Recording only at
 *    completion made the instrument unable to see the very interleaving it certifies: the sixth
 *    layer of this module's defect reads `ping, reset, shutdown, shutdown` in completion order and
 *    `ping, shutdown, reset, shutdown` on the wire, and only the second one shows the harm — a
 *    `reset` after the frame that ends the stream.
 *
 * `blockWrites` is the other half: a socket whose `'drain'` never arrives. Given a predicate it
 * parks only the frames it selects, which is how a deadline is made to land inside one specific
 * write without racing the clock for it. `close()` releases the gate, because `reply.raw.end()`
 * flushes what is already buffered.
 */
const recorder = (
  options: { blockWrites?: boolean | ((message: Message) => boolean) } = {},
): Recorder => {
  const sent: Message[] = [];
  const written: Message[] = [];
  const comments: string[] = [];
  const gate: (() => void)[] = [];
  const blocks =
    typeof options.blockWrites === 'function'
      ? options.blockWrites
      : (): boolean => options.blockWrites === true;
  let pending = 0;
  let parked = 0;
  const self: Recorder = {
    sent,
    comments,
    closed: false,
    get pending() {
      return pending;
    },
    get parked() {
      return parked;
    },
    send: async (message) => {
      // `reply.raw.write()` happens here, synchronously — the bytes are on the wire before this
      // function has awaited anything.
      written.push(message);
      pending += 1;
      try {
        if (blocks(message)) {
          parked += 1;
          try {
            await new Promise<void>((resolve) => {
              gate.push(resolve);
            });
          } finally {
            parked -= 1;
          }
        }
        // `reply.raw.write()` returned false…
        await new Promise<void>((resolve) => setImmediate(resolve));
        // …and this is the socket's `'drain'`.
        await new Promise<void>((resolve) => setImmediate(resolve));
        sent.push(message);
      } finally {
        pending -= 1;
      }
    },
    comment: (text) => {
      comments.push(text);
    },
    close: () => {
      self.closed = true;
      // `reply.raw.end()` flushes what is already buffered, so a write in flight still lands.
      for (const release of gate.splice(0)) {
        release();
      }
    },
    get isConnected() {
      return !self.closed;
    },
    trace: () => sent.map((message) => `${message.event ?? '?'}@${message.id ?? '-'}`),
    wire: () => written.map((message) => `${message.event ?? '?'}@${message.id ?? '-'}`),
  };
  return self;
};

const hubWith = (overrides: Partial<ConstructorParameters<typeof SseHub>[0]> = {}): SseHub =>
  new SseHub({
    bufferSize: 4,
    maxQueuedFrames: 4,
    maxTopicsPerConnection: 8,
    maxBufferedTopics: 32,
    retryMs: 1_000,
    pingIntervalMs: 20_000,
    maxConnections: 10,
    shutdownDrainMs: 1_000,
    ...overrides,
  });

const ORG_TOPIC = 'org' as SseTopic;

/**
 * Consecutive turns of the event loop with nothing moving before a chain is called settled.
 *
 * It has to be more than the macrotasks one write costs, or the gap between two frames reads as
 * the end of the batch. That is not a hypothetical: the previous detector returned after **one**
 * quiet turn, which was enough only because the transport it was watching resolved on a microtask.
 */
const QUIET_TURNS = 6;

/**
 * Turns a write that is *not* parked on the gate may be in flight with nothing moving.
 *
 * This is a bound on the fake's own construction rather than on elapsed time: a write that is not
 * gated resolves after exactly two `setImmediate` callbacks, and `setImmediate` callbacks run in
 * FIFO order within the check phase, so an ungated write always completes within two or three of
 * `settle`'s turns **whatever the machine is doing**. Load moves the wall clock, not the ordering.
 * Fifty is therefore headroom on a structural fact, not a threshold on a measurement.
 *
 * It is only a backstop; the state that matters is proved instead — see `settle`.
 */
const MAX_DRAINING_TURNS = 50;

/**
 * Waits until every one of `clients` has genuinely gone quiet.
 *
 * Two things are needed and neither is sufficient alone: no write in flight (a socket write is a
 * macrotask, so "nothing happened this turn" is the normal state *during* a write), and nothing
 * observable — bytes, drained frames, comments, the closed flag — moving for `QUIET_TURNS` turns.
 *
 * The version this replaces returned after one turn without progress. It failed loudly on the
 * 766-frame completeness assertion below, because that assertion is positive and it reported 2.
 * Sitting next to `expect(closed).toBe(false)` the same detector passes silently and certifies
 * nothing at all — which is how three rounds of the same defect were each signed off green.
 *
 * ## What it can prove, and the one thing it cannot
 *
 * A stall is called hopeless when **every write in flight is parked on the fake's gate**. That is
 * a proof rather than a threshold: the gate is released by `close()` and by nothing else, so while
 * the transport is open no number of further turns changes anything. The turn counter above only
 * covers the other case, and there it is a bound on the fake's construction.
 *
 * **The limitation, stated because the previous bound hid it behind a number.** A gate is released
 * by `close()`, and `close()` can be reached from a `setTimeout` — the shutdown drain deadline is
 * exactly that. `settle` cannot see a pending timer, so it must not be called while a timer is the
 * only thing that can release a gate: it would report the state hopeless while progress was still
 * scheduled. Every call site here awaits the promise its timer resolves (`hub.shutdown()`) before
 * settling, which is the condition that makes this sound; a future test that settles *during* a
 * drain breaks it. The direction of that failure is safe — a named error, never a false pass —
 * and the error message names both possible causes so it cannot be misread as a product defect.
 */
const settle = async (...clients: readonly Recorder[]): Promise<void> => {
  const snapshot = (): string =>
    clients
      .map(
        (client) =>
          `${client.wire().length}/${client.sent.length}/${client.comments.length}/${client.closed}`,
      )
      .join('|');
  let previous = snapshot();
  let quiet = 0;
  let draining = 0;
  for (let turn = 0; turn < 20_000; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    const now = snapshot();
    if (now !== previous) {
      previous = now;
      quiet = 0;
      draining = 0;
      continue;
    }
    const busy = clients.filter((client) => client.pending > 0);
    if (busy.length > 0) {
      quiet = 0;
      if (busy.every((client) => client.parked === client.pending)) {
        throw new Error(
          `every write in flight is parked on the fake transport's gate, which only close() releases: either the code under test never closes this stream, or settle() was called while a timer was the only thing that could (state ${now})`,
        );
      }
      draining += 1;
      if (draining >= MAX_DRAINING_TURNS) {
        throw new Error(
          `a write has been draining for ${MAX_DRAINING_TURNS} turns with nothing moving, and an ungated write costs two: the transport is not draining (state ${now})`,
        );
      }
      continue;
    }
    quiet += 1;
    if (quiet >= QUIET_TURNS) {
      return;
    }
  }
  throw new Error(`the write chain never went quiet; last state ${snapshot()}`);
};

/**
 * Waits until the write chain has reached the frame the fake transport's gate holds.
 *
 * This is the state `settle` throws on, and the difference is entirely in what the caller knows.
 * `settle` cannot see a pending timer, so "every write in flight is parked" is for it an
 * unexplained stall. A caller that has faked the clock *can* see it: nothing but its own
 * `advanceTimersByTime` can produce another frame, so the same state is a proof that the drain has
 * stopped exactly where the gate is — and where the gate is, is chosen by the test rather than by
 * how much work fits inside a real interval.
 *
 * Only ever call it with the clock faked, or with no timer outstanding; otherwise it can return
 * while a timer is still due to release the gate, and the count it pins is a measurement again.
 *
 * The bound is a number of turns of the event loop, not of milliseconds: the chain costs two turns
 * per frame whatever the machine is doing, so the longest replay this file builds costs 765 × 2,
 * and 20 000 — `settle`'s own bound — is an order of magnitude of headroom on it. Load makes a
 * turn take longer; it does not make one take more turns.
 */
const stalledOnGate = async (client: Recorder): Promise<void> => {
  for (let turn = 0; turn < 20_000; turn += 1) {
    if (client.pending > 0 && client.parked === client.pending) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(
    `the write chain never reached the frame the fake transport's gate holds; ${client.wire().length} written, ${client.sent.length} drained, ${client.pending} in flight of which ${client.parked} parked`,
  );
};

/**
 * `work`, or `fallback` when it has not settled within `turns` turns of the event loop.
 *
 * A watchdog on a promise that may never resolve has to be measured in *something*, and the choice
 * decides what a failure means. Milliseconds are right when what is being waited for is a real
 * timer — `shutdown` above waits out a real `shutdownDrainMs`, so its watchdog is seconds. Once
 * the deadline has fired, though, what is left is microtasks and `setImmediate` callbacks: load
 * changes how long a turn takes and not how many are needed, so a turn count is a bound on the
 * code and a millisecond count would be a bound on the machine.
 *
 * Without a watchdog at all, a drain that never returns fails by vitest's own timeout — which
 * reads as a flake rather than as the defect it is (the ledger's mutation H).
 */
const withinTurns = async <T>(work: Promise<T>, turns: number, fallback: T): Promise<T> => {
  let settled = false;
  const finished = work.then((value) => {
    settled = true;
    return value;
  });
  const watchdog = async (): Promise<T> => {
    for (let turn = 0; turn < turns && !settled; turn += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    return fallback;
  };
  return Promise.race([finished, watchdog()]);
};

describe('cursor parsing', () => {
  it('splits on the last colon, because a topic contains one', () => {
    expect(parseCursor(`${RUN_TOPIC}:42`)).toEqual({ topic: RUN_TOPIC, seq: 42 });
    expect(parseCursor('org:7')).toEqual({ topic: 'org', seq: 7 });
  });

  it('rejects anything that is not a topic and a number', () => {
    expect(parseCursor('org:not-a-number')).toBeNull();
    expect(parseCursor('nonsense:1')).toBeNull();
    expect(parseCursor('org')).toBeNull();
    expect(parseCursor(':1')).toBeNull();
  });

  it('drops unparseable entries rather than refusing the whole reconnect', () => {
    const cursors = parseCursors(`org:1, garbage , ${RUN_TOPIC}:9`);
    expect([...cursors]).toEqual([
      ['org', 1],
      [RUN_TOPIC, 9],
    ]);
  });

  it('takes the last cursor when a topic is repeated', () => {
    expect(parseCursors('org:1,org:5').get('org')).toBe(5);
  });

  it('treats an absent header as no cursors at all', () => {
    expect(parseCursors(undefined).size).toBe(0);
    expect(parseCursors(null).size).toBe(0);
    expect(parseCursors('').size).toBe(0);
  });
});

describe('frame shaping', () => {
  it('names the event after the catalogue type or the transcript kind', () => {
    expect(frameEventName(transcript(RUN_TOPIC, 1))).toBe('steer');
    expect(frameEventName({ frame: 'control', type: 'shutdown' })).toBe('shutdown');
  });

  it('gives replayable frames an id and control frames none', () => {
    // A control frame with an id would overwrite the browser's Last-Event-ID with a position that
    // is not in any topic; the next reconnect would then replay from nowhere.
    expect(frameId(transcript(RUN_TOPIC, 3))).toBe(`${RUN_TOPIC}:3`);
    expect(frameId({ frame: 'control', topic: 'org', type: 'reset' })).toBeUndefined();
  });
});

describe('SseHub', () => {
  let hub: SseHub;

  beforeEach(() => {
    hub = hubWith();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends the retry interval once on a fresh connection and nothing else', async () => {
    const client = recorder();
    hub.open({ id: 'c1', userId: 'u1', topics: [RUN_TOPIC], transport: client });
    await settle(client);

    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]?.retry).toBe(1_000);
    expect(client.sent[0]?.id).toBeUndefined();
  });

  it('fans a published frame out to every subscriber of its topic and nobody else', async () => {
    const watcher = recorder();
    const bystander = recorder();
    hub.open({ id: 'c1', userId: 'u1', topics: [RUN_TOPIC], transport: watcher });
    hub.open({ id: 'c2', userId: 'u2', topics: [TASK_TOPIC], transport: bystander });

    hub.publish(transcript(RUN_TOPIC, 1));
    await settle(watcher, bystander);

    expect(watcher.trace()).toEqual(['ping@-', `steer@${RUN_TOPIC}:1`]);
    expect(bystander.trace()).toEqual(['ping@-']);
  });

  it('refuses to publish a control frame: those are the hub’s to make', () => {
    expect(() => {
      hub.publish({ frame: 'control', topic: 'org', type: 'reset' });
    }).toThrow(TypeError);
  });

  describe('replay', () => {
    it('sends exactly the frames after the cursor', async () => {
      hub.publish(transcript(RUN_TOPIC, 1, 'seen'));
      hub.publish(transcript(RUN_TOPIC, 2, 'missed one'));
      hub.publish(transcript(RUN_TOPIC, 3, 'missed two'));

      const client = recorder();
      hub.open({
        id: 'c1',
        userId: 'u1',
        topics: [RUN_TOPIC],
        cursors: new Map([[RUN_TOPIC, 1]]),
        transport: client,
      });
      await settle(client);

      expect(client.trace()).toEqual([`steer@${RUN_TOPIC}:2`, `steer@${RUN_TOPIC}:3`]);
      // The first replayed frame carries the retry interval, so a reconnecting client is told it.
      expect(client.sent[0]?.retry).toBe(1_000);
    });

    it('sends nothing when the cursor is already the newest frame', async () => {
      hub.publish(transcript(RUN_TOPIC, 1));
      const client = recorder();
      hub.open({
        id: 'c1',
        userId: 'u1',
        topics: [RUN_TOPIC],
        cursors: new Map([[RUN_TOPIC, 1]]),
        transport: client,
      });
      await settle(client);
      expect(client.trace()).toEqual(['ping@-']);
    });

    it('resets when the cursor fell out of the ring buffer', async () => {
      // bufferSize is 4, so seq 1 is evicted by the fifth frame.
      for (let seq = 1; seq <= 5; seq += 1) {
        hub.publish(transcript(RUN_TOPIC, seq));
      }
      expect(hub.bufferedSeqs(RUN_TOPIC)).toEqual([2, 3, 4, 5]);

      const client = recorder();
      hub.open({
        id: 'c1',
        userId: 'u1',
        topics: [RUN_TOPIC],
        cursors: new Map([[RUN_TOPIC, 1]]),
        transport: client,
      });
      await settle(client);

      expect(client.trace()).toEqual(['reset@-']);
      expect(client.sent[0]?.data).toMatchObject({ frame: 'control', topic: RUN_TOPIC });
    });

    it('resets when the process has no buffer at all — a restart, not a gap it can name', async () => {
      const client = recorder();
      hub.open({
        id: 'c1',
        userId: 'u1',
        topics: [RUN_TOPIC],
        cursors: new Map([[RUN_TOPIC, 7]]),
        transport: client,
      });
      await settle(client);
      expect(client.trace()).toEqual(['reset@-']);
    });

    it('resets one topic and replays another on the same connection', async () => {
      hub.publish(transcript(RUN_TOPIC, 1));
      hub.publish(transcript(RUN_TOPIC, 2));

      const client = recorder();
      hub.open({
        id: 'c1',
        userId: 'u1',
        topics: [RUN_TOPIC, TASK_TOPIC],
        cursors: new Map([
          [RUN_TOPIC, 1],
          [TASK_TOPIC, 99],
        ]),
        transport: client,
      });
      await settle(client);

      expect(client.trace()).toEqual([`steer@${RUN_TOPIC}:2`, 'reset@-']);
    });

    it('keeps the replay ahead of frames published while it is still being written', async () => {
      hub.publish(transcript(RUN_TOPIC, 1, 'a'));
      hub.publish(transcript(RUN_TOPIC, 2, 'b'));

      // Writes block until the transport is released, so a live publish lands mid-replay.
      const client = recorder({ blockWrites: true });
      hub.open({
        id: 'c1',
        userId: 'u1',
        topics: [RUN_TOPIC],
        cursors: new Map([[RUN_TOPIC, 1]]),
        transport: client,
      });
      hub.publish(transcript(RUN_TOPIC, 3, 'c'));
      client.close();
      await settle(client);

      // Whatever made it out, the order is the log's order and nothing is duplicated.
      const ids = client.sent.map((message) => message.id);
      expect(ids).toEqual(ids.filter((id, index) => ids.indexOf(id) === index));
      expect(ids).toEqual([...ids].sort());
    });
  });

  /**
   * The write chain, at the shipped defaults, with a producer running at the socket's own rate.
   *
   * Three rounds of review each fixed one layer of the same defect and left the next, and the
   * reason is in the two tests these replace: one injected **one** live frame against a cap of
   * 512 — the smallest probe that can be built — and the other injected none at all. Both passed
   * throughout. The shape of the failure is a queue that grows while a replay drains, so the probe
   * has to be the live frame *count*, and it has to be a parameter rather than a constant.
   *
   * The measured matrix, all with a producer publishing one frame for each frame the socket gets
   * through: 255 replay + 800 live lived, 510 + 800 lived, 765 + 400 lived, **765 + 520 closed the
   * connection at frame 514 with no `reset` at all**. Only the replay length decided it, and 765 is
   * an ordinary tab: `org`, a project and a task, three topics × a 256-frame buffer.
   */
  describe('a large replay and live traffic sharing one write chain', () => {
    const PRODUCTION = {
      bufferSize: 256,
      maxQueuedFrames: 512,
      maxTopicsPerConnection: 64,
    } as const;
    const TOPICS = [RUN_TOPIC, TASK_TOPIC, ORG_TOPIC];

    /** A reconnect that has missed 255 frames on each of `topicCount` topics. */
    const reconnect = (topicCount: number, transport: Recorder) => {
      const production = hubWith(PRODUCTION);
      const topics = TOPICS.slice(0, topicCount);
      for (const topic of topics) {
        for (let seq = 1; seq <= 256; seq += 1) {
          production.publish(transcript(topic, seq));
        }
      }
      production.open({
        id: 'c1',
        userId: 'u1',
        topics,
        cursors: new Map(topics.map((topic) => [topic, 1])),
        transport,
      });
      return { production, topics };
    };

    /**
     * Publishes `count` live frames, `perWrite` of them for every frame the socket gets through.
     *
     * `perWrite: 1` is a producer running at exactly the consumer's rate — the queue neither grows
     * nor shrinks, which is the definition of a stream that is keeping up. Anything above 1 is a
     * consumer falling behind.
     */
    const paceLive = async (
      hub: SseHub,
      client: Recorder,
      count: number,
      perWrite = 1,
    ): Promise<number> => {
      let published = 0;
      let seen = -1;
      for (let turn = 0; turn < 100_000 && published < count && !client.closed; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
        if (client.sent.length === seen) {
          continue;
        }
        seen = client.sent.length;
        for (let i = 0; i < perWrite && published < count && !client.closed; i += 1) {
          published += 1;
          hub.publish(transcript(RUN_TOPIC, 1_000 + published));
        }
      }
      return published;
    };

    it.each([
      { topicCount: 2, live: 0 },
      { topicCount: 1, live: 800 },
      { topicCount: 2, live: 800 },
      { topicCount: 3, live: 1 },
      { topicCount: 3, live: 400 },
      { topicCount: 3, live: 520 },
      { topicCount: 3, live: 800 },
    ])(
      'delivers $topicCount×255 replayed frames and $live live ones, and keeps the stream',
      async ({ topicCount, live }) => {
        const client = recorder();
        const { production, topics } = reconnect(topicCount, client);

        expect(await paceLive(production, client, live)).toBe(live);
        await settle(client);

        expect(client.closed).toBe(false);
        expect(production.connectionCount).toBe(1);
        expect(client.sent).toHaveLength(255 * topicCount + live);
        expect(client.trace()).toEqual([
          ...topics.flatMap((topic) =>
            Array.from({ length: 255 }, (_, i) => `steer@${topic}:${i + 2}`),
          ),
          ...Array.from({ length: live }, (_, i) => `steer@${RUN_TOPIC}:${1_001 + i}`),
        ]);
        // Nothing was silently swapped for a reset, and nothing was silently dropped.
        expect(client.trace()).not.toContain('reset@-');
      },
      60_000,
    );

    it('still drops a consumer the producer outruns, however large its replay was', async () => {
      // The other half of the invariant, at the same size of replay that must *not* trip the cap:
      // four frames published for every one the socket gets through is a reader falling behind for
      // real, and that is the failure the cap exists for. Without this, "never close a stream with
      // a big replay" could be satisfied by never closing a stream at all.
      const client = recorder();
      const { production, topics } = reconnect(3, client);

      await paceLive(production, client, 100_000, 4);
      await settle(client);

      expect(client.closed).toBe(true);
      expect(production.connectionCount).toBe(0);
      // And it was told, once per topic, rather than being cut off in silence.
      expect(client.trace().filter((entry) => entry === 'reset@-')).toHaveLength(topics.length);
      expect(client.trace().at(-1)).toBe('reset@-');
    }, 60_000);
  });

  describe('partials', () => {
    it('drops coalesced stream_block frames when the client asked for ?partials=0', async () => {
      const client = recorder();
      hub.open({
        id: 'c1',
        userId: 'u1',
        topics: [RUN_TOPIC],
        partials: false,
        transport: client,
      });
      hub.publish(streamBlock(RUN_TOPIC, 1));
      hub.publish(transcript(RUN_TOPIC, 2));
      await settle(client);

      expect(client.trace()).toEqual(['ping@-', `steer@${RUN_TOPIC}:2`]);
    });

    it('sends them by default', async () => {
      const client = recorder();
      hub.open({ id: 'c1', userId: 'u1', topics: [RUN_TOPIC], transport: client });
      hub.publish(streamBlock(RUN_TOPIC, 1));
      await settle(client);
      expect(client.trace()).toEqual(['ping@-', `stream_block@${RUN_TOPIC}:1`]);
    });

    // "This client has been told the reconnect interval" is an obligation two paths can discharge
    // — the first frame of the replay, or the synthetic `ping` when there is nothing to replay —
    // and `first` is their arbiter. It used to be consumed by a frame the filter then dropped, so
    // neither path discharged it and nobody noticed, because a browser has a default.
    it('still sends the retry interval when the filter drops the first replayed frame', async () => {
      hub.publish(transcript(RUN_TOPIC, 1, 'seen'));
      hub.publish(streamBlock(RUN_TOPIC, 2));
      hub.publish(transcript(RUN_TOPIC, 3, 'missed'));

      const client = recorder();
      hub.open({
        id: 'c1',
        userId: 'u1',
        topics: [RUN_TOPIC],
        partials: false,
        cursors: new Map([[RUN_TOPIC, 1]]),
        transport: client,
      });
      await settle(client);

      expect(client.trace()).toEqual([`steer@${RUN_TOPIC}:3`]);
      expect(client.sent[0]?.retry).toBe(1_000);
    });

    it('falls back to the ping frame when the filter drops the whole replay', async () => {
      hub.publish(transcript(RUN_TOPIC, 1, 'seen'));
      hub.publish(streamBlock(RUN_TOPIC, 2));

      const client = recorder();
      hub.open({
        id: 'c1',
        userId: 'u1',
        topics: [RUN_TOPIC],
        partials: false,
        cursors: new Map([[RUN_TOPIC, 1]]),
        transport: client,
      });
      await settle(client);

      expect(client.trace()).toEqual(['ping@-']);
      expect(client.sent[0]?.retry).toBe(1_000);
    });
  });

  describe('subscriptions', () => {
    it('adds and removes topics on an open stream', async () => {
      const client = recorder();
      hub.open({ id: 'c1', userId: 'u1', topics: ['org'], transport: client });

      hub.publish(transcript(RUN_TOPIC, 1));
      await settle(client);
      expect(client.trace()).toEqual(['ping@-']);

      hub.updateSubscriptions('c1', 'u1', { add: [RUN_TOPIC] });
      hub.publish(transcript(RUN_TOPIC, 2));
      await settle(client);
      expect(client.trace()).toEqual(['ping@-', `steer@${RUN_TOPIC}:2`]);

      hub.updateSubscriptions('c1', 'u1', { remove: [RUN_TOPIC] });
      hub.publish(transcript(RUN_TOPIC, 3));
      await settle(client);
      expect(client.trace()).toEqual(['ping@-', `steer@${RUN_TOPIC}:2`]);
    });

    it('forgets a topic nobody watches any more', async () => {
      const client = recorder();
      hub.open({ id: 'c1', userId: 'u1', topics: ['org', RUN_TOPIC], transport: client });
      expect(hub.watchedTopics.sort()).toEqual(['org', RUN_TOPIC].sort());

      hub.updateSubscriptions('c1', 'u1', { remove: [RUN_TOPIC] });
      // An emptied set left behind would accumulate one entry per topic anybody has ever watched.
      expect(hub.watchedTopics).toEqual(['org']);
    });

    it('refuses an update that would take the stream over the topic cap, and changes nothing', () => {
      const small = hubWith({ maxTopicsPerConnection: 2 });
      small.open({ id: 'c1', userId: 'u1', topics: ['org', RUN_TOPIC], transport: recorder() });
      expect(() => small.updateSubscriptions('c1', 'u1', { add: [TASK_TOPIC] })).toThrow(
        TooManyTopicsError,
      );
      // Rejected, not half-applied.
      expect(small.watchedTopics.sort()).toEqual(['org', RUN_TOPIC].sort());
    });

    it('does not replay a newly added topic', async () => {
      hub.publish(transcript(RUN_TOPIC, 1));
      const client = recorder();
      hub.open({ id: 'c1', userId: 'u1', topics: ['org'], transport: client });
      hub.updateSubscriptions('c1', 'u1', { add: [RUN_TOPIC] });
      await settle(client);
      expect(client.trace()).toEqual(['ping@-']);
    });

    it('reports another user’s connection id as unknown, not as forbidden', () => {
      const client = recorder();
      hub.open({ id: 'c1', userId: 'u1', topics: ['org'], transport: client });
      // Telling a caller that an id exists but is not theirs is an oracle for guessing ids.
      expect(() => hub.updateSubscriptions('c1', 'someone-else', { add: [RUN_TOPIC] })).toThrow(
        UnknownConnectionError,
      );
      expect(() => hub.updateSubscriptions('nope', 'u1', { add: [RUN_TOPIC] })).toThrow(
        UnknownConnectionError,
      );
    });
  });

  describe('limits', () => {
    it('replaces the same user’s stale stream when a connection id comes back', async () => {
      // A laptop wakes up and the browser reconnects before this process has noticed the old
      // socket died. Without this, the old connection stays in the topic index for ever and its
      // eventual close removes the *new* one from the map.
      const stale = recorder();
      const fresh = recorder();
      hub.open({ id: 'c1', userId: 'u1', topics: [RUN_TOPIC], transport: stale });
      await settle(stale);
      expect(stale.trace()).toEqual(['ping@-']);

      hub.open({ id: 'c1', userId: 'u1', topics: [RUN_TOPIC], transport: fresh });
      expect(stale.closed).toBe(true);
      expect(hub.connectionCount).toBe(1);

      hub.publish(transcript(RUN_TOPIC, 1));
      await settle(stale, fresh);
      // The replaced stream receives nothing more, and the new one receives everything.
      expect(stale.trace()).toEqual(['ping@-']);
      expect(fresh.trace()).toEqual(['ping@-', `steer@${RUN_TOPIC}:1`]);
    });

    it('refuses to let one user displace another user’s stream', () => {
      const mine = recorder();
      hub.open({ id: 'c1', userId: 'u1', topics: [RUN_TOPIC], transport: mine });
      expect(() =>
        hub.open({ id: 'c1', userId: 'u2', topics: [RUN_TOPIC], transport: recorder() }),
      ).toThrow(ConnectionIdInUseError);
      expect(mine.closed).toBe(false);
      expect(hub.connectionCount).toBe(1);
    });

    it('refuses a connection over the cap', () => {
      const small = hubWith({ maxConnections: 1 });
      small.open({ id: 'c1', userId: 'u1', topics: ['org'], transport: recorder() });
      expect(() =>
        small.open({ id: 'c2', userId: 'u1', topics: ['org'], transport: recorder() }),
      ).toThrow(TooManyConnectionsError);
    });

    it('closes a consumer that stops reading rather than buffering live frames for ever', async () => {
      const stuck = recorder({ blockWrites: true });
      const small = hubWith({ bufferSize: 64, maxQueuedFrames: 3 });
      small.open({ id: 'c1', userId: 'u1', topics: [RUN_TOPIC], transport: stuck });

      for (let seq = 1; seq <= 10; seq += 1) {
        small.publish(transcript(RUN_TOPIC, seq));
      }
      expect(stuck.closed).toBe(true);
      expect(small.connectionCount).toBe(0);
    });

    it('keeps fanning out when the frame that trips the cap unsubscribes a peer mid-iteration', async () => {
      // `publish` iterates the topic's subscriber `Set` while dropping one re-entrantly deletes
      // that same connection from it: `write` → `#dropStalled` → `close` → `#onDropped` →
      // `SseHub.close` → `subscribers.delete(...)`, all synchronously, inside the `for…of`.
      //
      // Deleting the element being visited is spec-defined and safe (a `Set` is walked by index
      // over `[[SetData]]`, and `delete` leaves a hole rather than compacting it), but "safe" was
      // an unstated assumption in a module whose entire defect history is unstated assumptions.
      // What it buys is asserted instead: the *next* subscriber still receives the frame that
      // dropped its predecessor, and every frame after it.
      const small = hubWith({ bufferSize: 64, maxQueuedFrames: 3 });
      const stalled = recorder({ blockWrites: true });
      const healthy = recorder();
      small.open({ id: 'c1', userId: 'u1', topics: [RUN_TOPIC], transport: stalled });
      small.open({ id: 'c2', userId: 'u1', topics: [RUN_TOPIC], transport: healthy });

      // One frame per drain, so that only the blocked client accumulates a queue: a synchronous
      // burst would outrun the healthy one too, and the cap is a measure of the consumer.
      for (let seq = 1; seq <= 6; seq += 1) {
        small.publish(transcript(RUN_TOPIC, seq));
        await settle(healthy);
      }

      expect(stalled.closed).toBe(true);
      expect(small.connectionCount).toBe(1);
      await settle(healthy);
      expect(healthy.trace()).toEqual([
        'ping@-',
        ...Array.from({ length: 6 }, (_, i) => `steer@${RUN_TOPIC}:${i + 1}`),
      ]);
    });

    it('does not let a large replay trip the live-frame cap', async () => {
      // The same stalled transport, but the frames are a replay rather than live traffic: a
      // reconnect must never be dropped for being big, only a reader that stops reading.
      const slow = recorder({ blockWrites: true });
      const small = hubWith({ bufferSize: 64, maxQueuedFrames: 3 });
      for (let seq = 1; seq <= 20; seq += 1) {
        small.publish(transcript(RUN_TOPIC, seq));
      }
      small.open({
        id: 'c1',
        userId: 'u1',
        topics: [RUN_TOPIC],
        cursors: new Map([[RUN_TOPIC, 1]]),
        transport: slow,
      });
      expect(slow.closed).toBe(false);
      expect(small.connectionCount).toBe(1);
    });

    it('refuses more topics on one stream than a replay for it could be bounded by', () => {
      const small = hubWith({ maxTopicsPerConnection: 2 });
      expect(() =>
        small.open({
          id: 'c1',
          userId: 'u1',
          topics: ['org', RUN_TOPIC, TASK_TOPIC],
          transport: recorder(),
        }),
      ).toThrow(TooManyTopicsError);
    });

    it('stops the ping timer when a connection closes', () => {
      vi.useFakeTimers();
      const client = recorder();
      const pinging = hubWith({ pingIntervalMs: 100 });
      const handle = pinging.open({
        id: 'c1',
        userId: 'u1',
        topics: ['org'],
        transport: client,
      });
      vi.advanceTimersByTime(250);
      expect(client.comments).toEqual(['ping', 'ping']);

      handle.close();
      vi.advanceTimersByTime(1_000);
      expect(client.comments).toEqual(['ping', 'ping']);
    });
  });

  describe('buffer retention', () => {
    // `#buffers` is keyed by topic and topics are per task and per run. Nothing ever tells the hub
    // that a run has ended, so before this the map grew for the lifetime of the process — the one
    // structure here with no bound at all, while `#byTopic` was carefully pruned two lines away.
    it('forgets the ring buffer of the least recently published topic', () => {
      const small = hubWith({ maxBufferedTopics: 2 });
      small.publish(transcript(RUN_TOPIC, 1));
      small.publish(transcript(TASK_TOPIC, 1));
      small.publish(transcript(ORG_TOPIC, 1));

      expect(small.bufferedSeqs(RUN_TOPIC)).toEqual([]);
      expect(small.bufferedSeqs(TASK_TOPIC)).toEqual([1]);
      expect(small.bufferedSeqs(ORG_TOPIC)).toEqual([1]);
    });

    it('measures recency by publishing, not by first sight', () => {
      // Otherwise the busiest topic on the server is the first one evicted.
      const small = hubWith({ maxBufferedTopics: 2 });
      small.publish(transcript(RUN_TOPIC, 1));
      small.publish(transcript(TASK_TOPIC, 1));
      small.publish(transcript(RUN_TOPIC, 2));
      small.publish(transcript(ORG_TOPIC, 1));

      expect(small.bufferedSeqs(TASK_TOPIC)).toEqual([]);
      expect(small.bufferedSeqs(RUN_TOPIC)).toEqual([1, 2]);
    });

    it('answers a cursor into an evicted topic with reset rather than with silence', async () => {
      const small = hubWith({ maxBufferedTopics: 1 });
      small.publish(transcript(RUN_TOPIC, 1));
      small.publish(transcript(TASK_TOPIC, 1));

      const client = recorder();
      small.open({
        id: 'c1',
        userId: 'u1',
        topics: [RUN_TOPIC],
        cursors: new Map([[RUN_TOPIC, 1]]),
        transport: client,
      });
      await settle(client);
      // The safe direction, and the same answer a restarted process gives.
      expect(client.trace()).toEqual(['reset@-']);
    });
  });

  describe('shutdown', () => {
    it('writes the shutdown frame, waits for it, then closes every stream', async () => {
      const first = recorder();
      const second = recorder();
      hub.open({ id: 'c1', userId: 'u1', topics: ['org'], transport: first });
      hub.open({ id: 'c2', userId: 'u2', topics: [RUN_TOPIC], transport: second });

      const drained = await hub.shutdown();

      expect(drained).toBe(2);
      // The drained branch, named: the frame reached the transport *before* it was closed — that
      // is what "drains" means — and it is the only `shutdown` either client saw. `toEqual` rather
      // than `at(-1)`, because "the last frame is a shutdown" is also true of a stream that was
      // sent two of them and a `reset` in between.
      expect(first.trace()).toEqual(['ping@-', 'shutdown@-']);
      expect(second.trace()).toEqual(['ping@-', 'shutdown@-']);
      expect(first.wire()).toEqual(['ping@-', 'shutdown@-']);
      expect(second.wire()).toEqual(['ping@-', 'shutdown@-']);
      expect(first.closed && second.closed).toBe(true);
      expect(hub.connectionCount).toBe(0);
    });

    it('announces the shutdown once when it is called twice at the same time', async () => {
      // The seventh layer, and the third path to "the client has been told the server is going
      // away". `#shutdownAnnounced` does not arbitrate this pair: the on-chain link *sets* it and
      // never *reads* it, so two on-chain links are outside that partition entirely. Nothing is
      // removed from `#connections` until the drain finishes, so a second call snapshots the same
      // connection, queues a second `shutdown` behind the first, and that link passes `#closed`
      // and `isConnected` exactly as the first did — the wire reads `ping, shutdown, shutdown`.
      //
      // Not reachable through today's composition root (Fastify's `preClose` fires once and
      // `runtime.stop()` guards itself), which is a fact about the callers rather than about the
      // hub, and WP-12/WP-15 add callers.
      const client = recorder();
      hub.open({ id: 'c1', userId: 'u1', topics: ['org'], transport: client });
      await settle(client);

      // Concurrent, not sequential: the second call is made before the first has awaited its
      // drain, which is the only window in which `#connections` still holds the connection.
      const [firstCall, secondCall] = await Promise.all([hub.shutdown(), hub.shutdown()]);
      await settle(client);

      // The mutation-killer, named rather than left to a whole-array diff: one `shutdown` frame
      // reached the socket, not two.
      expect(
        client.wire().filter((frame) => frame === 'shutdown@-'),
        'the client was told the server is going away more than once',
      ).toHaveLength(1);
      // …and the exact wire, because "told once" is not the only thing that can go wrong here.
      expect(client.wire()).toEqual(['ping@-', 'shutdown@-']);
      expect(client.trace()).toEqual(['ping@-', 'shutdown@-']);
      // One call owns the shutdown; the other announces nothing and says so. It returns
      // immediately rather than joining the first drain — see `SseHub.shutdown`.
      expect([firstCall, secondCall]).toEqual([1, 0]);
      expect(client.closed).toBe(true);
      expect(hub.connectionCount).toBe(0);
    });

    it('leaks no topic index when a subscription arrives during the drain window', async () => {
      // `updateSubscriptions` is the one hub entry point that is not gated by `#shuttingDown`
      // (shared state 11). The audit says that is benign, and rule 3 says a claim in a comment is
      // not evidence, so it is probed here: the update lands after `shutdown` has snapshotted the
      // connections and queued their frames, and before the drain has finished.
      const client = recorder();
      hub.open({ id: 'c1', userId: 'u1', topics: ['org'], transport: client });
      await settle(client);

      const draining = hub.shutdown();
      const updated = hub.updateSubscriptions('c1', 'u1', { add: [TASK_TOPIC] });

      expect(updated.topics).toEqual(['org', TASK_TOPIC]);
      expect(await draining).toBe(1);
      await settle(client);

      // Nothing is left behind: `shutdown`'s close loop walks `connection.topics` as it stands at
      // that moment, so a topic added mid-drain is unsubscribed with the rest.
      expect(hub.watchedTopics).toEqual([]);
      expect(hub.connectionCount).toBe(0);
      // And the new topic bought the client nothing on the wire — no replay for an added topic,
      // and `publish` has already stopped fanning out.
      expect(client.wire()).toEqual(['ping@-', 'shutdown@-']);
    });

    it('gives up on a stream that will not drain instead of holding the whole shutdown', async () => {
      // `flushed()` waits on the write chain, and the chain carries everything the client has not
      // read — a replay batch included. A reader that has stopped never drains it, so an unbounded
      // wait here holds `preClose` until the process-level grace period kills the container, and
      // every shutdown step queued behind the SSE drain (jobs, the pool) never runs at all.
      const stuck = recorder({ blockWrites: true });
      const impatient = hubWith({ shutdownDrainMs: 20 });
      impatient.open({ id: 'c1', userId: 'u1', topics: ['org'], transport: stuck });

      // Raced against a deadline of its own, because the failure mode *is* not returning: without
      // it, removing the bound makes this test hang and be killed by vitest's default timeout,
      // which reads as a flake rather than as the defect it is.
      const outcome = await Promise.race([
        impatient.shutdown().then((count) => `drained ${count}`),
        new Promise<string>((resolve) => {
          const timer = setTimeout(() => {
            resolve('shutdown never returned');
          }, 2_000);
          timer.unref?.();
        }),
      ]);

      expect(outcome).toBe('drained 1');
      expect(stuck.closed).toBe(true);
      expect(impatient.connectionCount).toBe(0);

      // …and it is told, rather than cut off in silence. The `shutdown` frame rides the same chain
      // as the replay, so a stream that runs out of drain budget has not written it and never
      // will: the deadline that stops one client holding the deploy is a budget replay and control
      // frames share. Abandoning writes them past the chain, exactly as a stalled drop does.
      //
      // The abandoned branch is the only one that can produce this: `blockWrites` means the chain
      // never moves, so the on-chain `shutdown` cannot be what arrived. And it arrived **once** —
      // the two paths are exclusive, not merely both present.
      await settle(stuck);
      expect(stuck.wire()).toEqual(['ping@-', 'reset@-', 'shutdown@-']);
      expect(stuck.trace()).toEqual(['ping@-', 'reset@-', 'shutdown@-']);
    });

    it('tells a client the server is going away exactly once, even when the deadline lands inside that very write', async () => {
      // The sixth layer of "two paths share a quantity", and the quantity is *whether the client
      // has been told*. `shutdown` is written on the chain by `SseHub.shutdown` and off the chain
      // by `abandon()`, and nothing made the two exclusive: a chain link already past its
      // `#closed` check and inside `await send(...)` when the deadline fires produces both. On the
      // wire — `@fastify/sse` hands the bytes over synchronously — that reads `shutdown`, `reset`,
      // `reset`, `shutdown`: a `reset` *after* the frame that ends the stream, sending the client
      // back to refetch a stream it has already been told is over. That is the reconnect-into-the-
      // same-wall failure this whole work package exists to prevent.
      //
      // Neither half of the interleaving is raced against the clock. The shutdown frame's drain
      // never arrives, so `flushed()` can never resolve and the deadline always wins; and the
      // chain link is a microtask, which always runs before any timer. `shutdownDrainMs` could be
      // any value at all.
      const client = recorder({ blockWrites: (message) => message.event === 'shutdown' });
      const impatient = hubWith({ shutdownDrainMs: 20 });
      impatient.open({ id: 'c1', userId: 'u1', topics: ['org', RUN_TOPIC], transport: client });
      await settle(client);
      expect(client.wire()).toEqual(['ping@-']);

      await impatient.shutdown();
      await settle(client);

      // The order a client actually sees, which is the assertion the completion-ordered trace
      // could not make: told once, and nothing after the frame that ends the stream.
      expect(client.wire()).toEqual(['ping@-', 'shutdown@-']);
      // And it drained, rather than only being handed to a socket that had gone.
      expect(client.trace()).toEqual(['ping@-', 'shutdown@-']);
      expect(client.closed).toBe(true);
      expect(impatient.connectionCount).toBe(0);
    });

    it('abandons a replay the deadline caught mid-flight, and says so per topic before it ends', async () => {
      // The measured case: a client that is reading perfectly well but has 765 frames of replay in
      // front of it when the deploy starts. It got 33 frames and no `shutdown` at all.
      //
      // The version this replaces asserted only "`shutdown` is last", which **both** branches
      // satisfy — so it certified the observable rather than the code, and would have passed on
      // the drained branch it was written to exclude. It is the `reset` per topic that only
      // `abandon()` writes, so that is what is asserted, exactly and in order.
      //
      // Which branch runs is decided structurally rather than by the clock: one replay frame's
      // drain never arrives, so `flushed()` cannot resolve however long the deadline is. "Slower
      // than N milliseconds" would be an assertion about the machine; "never" is not.
      //
      // **Where the drain stopped is not decided by the clock either, and that is what this
      // version fixes.** It used to run a real twenty-millisecond deadline and then assert the
      // exact wire — 264 replayed frames and then the tail — on the reasoning that 264 frames were
      // what reached the socket inside twenty milliseconds. How many frames fit in a real interval
      // is a property of the machine: under CPU contention this same code delivered 55, 91, 111,
      // 210 and 248 frames in five consecutive runs, every one of them correct behaviour and every
      // one of them red, and CI is a two-core runner. So the deadline is injected instead of
      // waited out — `setTimeout` is the hub's only use of the clock (`withDeadline`) and faking
      // it hands this test the moment the deadline fires. The chain is driven first to the one
      // place it can never leave on its own, the frame the gate holds, and the clock is moved only
      // once nothing else can move. The prefix below is then pinned by the gate, and the gate is
      // set by this test: 264 is a fact about `blockWrites`, not about the runner.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const production = hubWith({
        bufferSize: 256,
        maxTopicsPerConnection: 64,
        shutdownDrainMs: 20,
      });
      const topics = [RUN_TOPIC, TASK_TOPIC, ORG_TOPIC];
      for (const topic of topics) {
        for (let seq = 1; seq <= 256; seq += 1) {
          production.publish(transcript(topic, seq));
        }
      }
      const stalls = `${TASK_TOPIC}:10`;
      const client = recorder({ blockWrites: (message) => message.id === stalls });
      production.open({
        id: 'c1',
        userId: 'u1',
        topics,
        cursors: new Map(topics.map((topic) => [topic, 1])),
        transport: client,
      });

      // 255 frames of the first topic and nine of the second reach the socket; the tenth is where
      // the gate holds it, so this is where the drain stops — 264 frames of the 765 it was asked
      // for, with the third topic not started.
      const replayed = [
        ...Array.from({ length: 255 }, (_, i) => `steer@${RUN_TOPIC}:${i + 2}`),
        ...Array.from({ length: 9 }, (_, i) => `steer@${TASK_TOPIC}:${i + 2}`),
      ];

      const closing = production.shutdown();
      await stalledOnGate(client);
      expect(client.wire(), 'the drain stopped at the frame the gate holds').toEqual(replayed);

      // Only now does the deadline expire, with the drain provably stuck partway through the
      // batch — which is the state this test exists to describe, reached deliberately rather than
      // hoped for.
      vi.advanceTimersByTime(20);
      const outcome = await withinTurns(
        closing.then((count) => `drained ${count}`),
        200,
        'shutdown never returned',
      );
      expect(outcome, 'the drain is bounded, so shutdown returns').toBe('drained 1');
      await settle(client);

      // And then, past the chain: one `reset` per topic — including the two the client never saw a
      // frame of — and one `shutdown`, last. Nothing more of the replay, because `close()` makes
      // every link still queued behind the gate early-return.
      expect(client.wire()).toEqual([...replayed, 'reset@-', 'reset@-', 'reset@-', 'shutdown@-']);
      expect(client.closed).toBe(true);
      expect(production.connectionCount).toBe(0);
    }, 60_000);

    it('puts nothing on the wire after the frame that says the stream has ended', async () => {
      // The dispatcher does not stop the instant `preClose` runs, so a publish lands mid-drain. It
      // used to be appended to the chain *behind* the shutdown frame: the client was told the
      // stream had ended and then sent more of it, and the drain became a moving target that a
      // busy topic could extend indefinitely.
      const client = recorder();
      hub.open({ id: 'c1', userId: 'u1', topics: [RUN_TOPIC], transport: client });

      const closing = hub.shutdown();
      hub.publish(transcript(RUN_TOPIC, 1));
      await closing;
      await settle(client);

      expect(client.trace().at(-1)).toBe('shutdown@-');
      expect(client.trace()).not.toContain(`steer@${RUN_TOPIC}:1`);
    });

    it('stops the keep-alive comment before it announces the shutdown', async () => {
      // The ping writes past `#chain` and is gated by `#closed` alone — not by `#shuttingDown`,
      // which is what stops `publish`. So during the drain window (up to `shutdownDrainMs`, five
      // seconds by default, against a twenty-second ping) the timer was the one writer that could
      // still reach a socket that had already been told the stream was over. Harmless in itself —
      // a comment reaches no `onmessage` handler — but "nothing is written after `shutdown`" was
      // a sentence with an exception nobody had written down.
      //
      // Only `setInterval` is faked: the drain deadline and the fake socket's own `setImmediate`
      // turns have to keep running, or the shutdown never completes.
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const client = recorder();
      const pinging = hubWith({ pingIntervalMs: 100 });
      pinging.open({ id: 'c1', userId: 'u1', topics: ['org'], transport: client });
      vi.advanceTimersByTime(250);
      expect(client.comments).toEqual(['ping', 'ping']);

      const closing = pinging.shutdown();
      vi.advanceTimersByTime(1_000);
      await closing;
      await settle(client);

      expect(client.comments).toEqual(['ping', 'ping']);
      expect(client.wire()).toEqual(['ping@-', 'shutdown@-']);
    });

    it('refuses new streams once shutdown has started, and says why', async () => {
      await hub.shutdown();
      // Not "too many connections": the reason is the reason, and an operator reading the log of a
      // deploy should not be sent looking at APP_SSE_MAX_CONNECTIONS.
      expect(() =>
        hub.open({ id: 'late', userId: 'u1', topics: ['org'], transport: recorder() }),
      ).toThrow(ShuttingDownError);
    });
  });

  it('counts every frame it writes, by kind', async () => {
    const kinds: string[] = [];
    const counting = hubWith({
      onFrameSent: (kind) => {
        kinds.push(kind);
      },
    });
    const counted = recorder();
    counting.publish(transcript(RUN_TOPIC, 1));
    counting.open({
      id: 'c1',
      userId: 'u1',
      topics: [RUN_TOPIC],
      cursors: new Map([[RUN_TOPIC, 99]]),
      transport: counted,
    });
    counting.publish(transcript(RUN_TOPIC, 2));
    await settle(counted);

    expect(kinds).toEqual(['control', 'live']);
  });
});

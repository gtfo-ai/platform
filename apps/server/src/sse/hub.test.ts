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

interface Recorder extends SseTransport {
  readonly sent: { id?: string; event?: string; data: unknown; retry?: number }[];
  readonly comments: string[];
  closed: boolean;
  /** Frames written, as `<event>@<id>` — the shape assertions read most easily. */
  trace(): string[];
}

const recorder = (options: { blockWrites?: boolean; slowWrites?: boolean } = {}): Recorder => {
  const sent: Recorder['sent'] = [];
  const comments: string[] = [];
  const gate: (() => void)[] = [];
  const self: Recorder = {
    sent,
    comments,
    closed: false,
    send: async (message) => {
      if (options.blockWrites === true) {
        await new Promise<void>((resolve) => gate.push(resolve));
      }
      if (options.slowWrites === true) {
        // `@fastify/sse` waits for the socket's `'drain'` event when the kernel buffer is full,
        // which is a **macrotask** — so a large batch does not drain in one microtask turn and a
        // live frame really can arrive in the middle of it. That interleaving is the whole point
        // of the "poisoned budget" test below, and a microtask-only fake cannot produce it.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      sent.push(message);
    },
    comment: (text) => {
      comments.push(text);
    },
    close: () => {
      self.closed = true;
      for (const release of gate.splice(0)) {
        release();
      }
    },
    get isConnected() {
      return !self.closed;
    },
    trace: () => sent.map((message) => `${message.event ?? '?'}@${message.id ?? '-'}`),
  };
  return self;
};

const hubWith = (overrides: Partial<ConstructorParameters<typeof SseHub>[0]> = {}): SseHub =>
  new SseHub({
    bufferSize: 4,
    maxQueuedLiveFrames: 4,
    maxTopicsPerConnection: 8,
    retryMs: 1_000,
    pingIntervalMs: 20_000,
    maxConnections: 10,
    ...overrides,
  });

const ORG_TOPIC = 'org' as SseTopic;

/**
 * Lets a connection's write chain settle completely.
 *
 * `await Promise.resolve()` a fixed number of times only advances the chain by that many links,
 * which quietly turned "did the hub send everything?" into "did the hub send the first ten?" — the
 * shape of assertion that let a replay defect through. `setImmediate` yields to the event loop,
 * and the microtask queue is drained in full before it fires, so one turn resolves a chain of any
 * length; two are taken because a write can schedule another.
 */
const settle = async (chain?: () => number): Promise<void> => {
  let previous = -1;
  for (let i = 0; i < 2_000; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    if (chain === undefined) {
      if (i >= 1) {
        return;
      }
      continue;
    }
    const now = chain();
    if (now === previous) {
      return;
    }
    previous = now;
  }
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
    await settle();

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
    await settle();

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
      await settle();

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
      await settle();
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
      await settle();

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
      await settle();
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
      await settle();

      expect(client.trace()).toEqual([`steer@${RUN_TOPIC}:2`, 'reset@-']);
    });

    it('delivers every missed frame of a multi-topic reconnect at the shipped defaults', async () => {
      // The defect this pins: `maxQueued` was `bufferSize`, and `open()` queues the whole replay
      // synchronously, so a reconnect bigger than one buffer tripped the slow-consumer guard
      // mid-loop, closed the connection, and made every already-queued frame early-return. Two
      // topics with 255 missed frames each — well inside the shipped 256-frame buffer — delivered
      // **zero** frames and no `reset`, and the client then reconnected on `retry:` into the same
      // wall for ever. The assertion is completeness, which the ordering and dedup tests never
      // made: exactly the frames after each cursor, on both topics, and the stream still open.
      const production = hubWith({
        bufferSize: 256,
        maxQueuedLiveFrames: 512,
        maxTopicsPerConnection: 64,
      });
      for (let seq = 1; seq <= 256; seq += 1) {
        production.publish(transcript(RUN_TOPIC, seq));
        production.publish(transcript(TASK_TOPIC, seq));
      }

      const client = recorder();
      production.open({
        id: 'c1',
        userId: 'u1',
        topics: [RUN_TOPIC, TASK_TOPIC],
        cursors: new Map([
          [RUN_TOPIC, 1],
          [TASK_TOPIC, 1],
        ]),
        transport: client,
      });
      await settle();

      expect(client.closed).toBe(false);
      expect(production.connectionCount).toBe(1);
      expect(client.sent).toHaveLength(510);
      expect(client.trace()).toEqual([
        ...Array.from({ length: 255 }, (_, i) => `steer@${RUN_TOPIC}:${i + 2}`),
        ...Array.from({ length: 255 }, (_, i) => `steer@${TASK_TOPIC}:${i + 2}`),
      ]);
      // Nothing was silently swapped for a reset either.
      expect(client.trace()).not.toContain('reset@-');
    });

    it('does not let a large replay poison the live-frame budget mid-drain', async () => {
      // The second half of the same defect, one layer down. Exempting replay from being *rejected*
      // by the cap was necessary and not sufficient: replay frames still incremented the counter
      // the live check reads, so a batch bigger than the cap left the budget exhausted for as long
      // as it took to drain. The first live frame to arrive during that window — and one does,
      // because the socket write is a macrotask — was read as "this consumer is too slow" and
      // killed the stream. At the shipped defaults, three near-full topics plus one live publish
      // delivered 1 frame of 766 and closed the connection with no `reset`.
      const production = hubWith({
        bufferSize: 256,
        maxQueuedLiveFrames: 512,
        maxTopicsPerConnection: 64,
      });
      const topics = [RUN_TOPIC, TASK_TOPIC, ORG_TOPIC];
      for (const topic of topics) {
        for (let seq = 1; seq <= 256; seq += 1) {
          production.publish(transcript(topic, seq));
        }
      }

      const client = recorder({ slowWrites: true });
      production.open({
        id: 'c1',
        userId: 'u1',
        topics,
        cursors: new Map(topics.map((topic) => [topic, 1])),
        transport: client,
      });

      // A live frame lands while the 765-frame replay is still draining. Waiting for the batch to
      // have started — rather than for a fixed number of turns — is what makes the interleaving
      // real: at this point the queue holds hundreds of replay frames, which is exactly the state
      // that used to exhaust the live budget.
      while (client.sent.length === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(client.sent.length).toBeLessThan(765);
      production.publish(transcript(RUN_TOPIC, 257));

      // Each write costs a macrotask here, so the chain is drained by watching it make progress
      // rather than by a fixed number of turns.
      await settle(() => client.sent.length);

      expect(client.closed).toBe(false);
      expect(production.connectionCount).toBe(1);
      // 3 × 255 replayed + the one live frame.
      expect(client.sent).toHaveLength(766);
      expect(client.trace().at(-1)).toBe(`steer@${RUN_TOPIC}:257`);
      expect(client.trace()).not.toContain('reset@-');
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
      await settle();

      // Whatever made it out, the order is the log's order and nothing is duplicated.
      const ids = client.sent.map((message) => message.id);
      expect(ids).toEqual(ids.filter((id, index) => ids.indexOf(id) === index));
      expect(ids).toEqual([...ids].sort());
    });
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
      await settle();

      expect(client.trace()).toEqual(['ping@-', `steer@${RUN_TOPIC}:2`]);
    });

    it('sends them by default', async () => {
      const client = recorder();
      hub.open({ id: 'c1', userId: 'u1', topics: [RUN_TOPIC], transport: client });
      hub.publish(streamBlock(RUN_TOPIC, 1));
      await settle();
      expect(client.trace()).toEqual(['ping@-', `stream_block@${RUN_TOPIC}:1`]);
    });
  });

  describe('subscriptions', () => {
    it('adds and removes topics on an open stream', async () => {
      const client = recorder();
      hub.open({ id: 'c1', userId: 'u1', topics: ['org'], transport: client });

      hub.publish(transcript(RUN_TOPIC, 1));
      await settle();
      expect(client.trace()).toEqual(['ping@-']);

      hub.updateSubscriptions('c1', 'u1', { add: [RUN_TOPIC] });
      hub.publish(transcript(RUN_TOPIC, 2));
      await settle();
      expect(client.trace()).toEqual(['ping@-', `steer@${RUN_TOPIC}:2`]);

      hub.updateSubscriptions('c1', 'u1', { remove: [RUN_TOPIC] });
      hub.publish(transcript(RUN_TOPIC, 3));
      await settle();
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
      await settle();
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
      await settle();
      expect(stale.trace()).toEqual(['ping@-']);

      hub.open({ id: 'c1', userId: 'u1', topics: [RUN_TOPIC], transport: fresh });
      expect(stale.closed).toBe(true);
      expect(hub.connectionCount).toBe(1);

      hub.publish(transcript(RUN_TOPIC, 1));
      await settle();
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
      const small = hubWith({ bufferSize: 64, maxQueuedLiveFrames: 3 });
      small.open({ id: 'c1', userId: 'u1', topics: [RUN_TOPIC], transport: stuck });

      for (let seq = 1; seq <= 10; seq += 1) {
        small.publish(transcript(RUN_TOPIC, seq));
      }
      expect(stuck.closed).toBe(true);
      expect(small.connectionCount).toBe(0);
    });

    it('does not let a large replay trip the live-frame cap', async () => {
      // The same stalled transport, but the frames are a replay rather than live traffic: a
      // reconnect must never be dropped for being big, only a reader that stops reading.
      const slow = recorder({ blockWrites: true });
      const small = hubWith({ bufferSize: 64, maxQueuedLiveFrames: 3 });
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

  describe('shutdown', () => {
    it('writes the shutdown frame, waits for it, then closes every stream', async () => {
      const first = recorder();
      const second = recorder();
      hub.open({ id: 'c1', userId: 'u1', topics: ['org'], transport: first });
      hub.open({ id: 'c2', userId: 'u2', topics: [RUN_TOPIC], transport: second });

      const drained = await hub.shutdown();

      expect(drained).toBe(2);
      // The frame reached the transport *before* it was closed — that is what "drains" means.
      expect(first.trace().at(-1)).toBe('shutdown@-');
      expect(second.trace().at(-1)).toBe('shutdown@-');
      expect(first.closed && second.closed).toBe(true);
      expect(hub.connectionCount).toBe(0);
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
    counting.publish(transcript(RUN_TOPIC, 1));
    counting.open({
      id: 'c1',
      userId: 'u1',
      topics: [RUN_TOPIC],
      cursors: new Map([[RUN_TOPIC, 99]]),
      transport: recorder(),
    });
    counting.publish(transcript(RUN_TOPIC, 2));
    await settle();

    expect(kinds).toEqual(['control', 'live']);
  });
});

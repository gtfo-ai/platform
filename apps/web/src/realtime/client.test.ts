import type { SseFrame, SseTopic } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { createRealtimeClient, type EventStream, type RealtimeStatus } from './client.js';

/**
 * The client half of the SSE contract, against a transport made of callbacks.
 *
 * No `EventSource`, no server and no clock: the stream factory, the timer and the connection id
 * are all injected, so every assertion here is about the client's decisions rather than about how
 * fast this machine is (standing rule 2). The one thing a fake transport cannot prove — that a
 * real browser reconnects and that the server accepts the cursor — is proved in
 * `test/web-e2e/realtime.spec.ts` against a real Chromium and a real HTTP stream.
 */
interface FakeStream extends EventStream {
  readonly url: string;
  readonly listeners: Map<string, ((event: MessageEvent<string>) => void)[]>;
  closed: boolean;
  emit(event: string, data: unknown, id?: string): void;
  fail(): void;
  /** What a real `EventSource` fires when the response starts. */
  opened(): void;
}

const RUN_TOPIC = 'run:11111111-1111-4111-8111-111111111111' as SseTopic;
const ORG_TOPIC = 'org' as SseTopic;
const PROJECT_TOPIC = 'project:33333333-3333-4333-8333-333333333333' as SseTopic;
const RUN_TOPIC_2 = 'run:44444444-4444-4444-8444-444444444444' as SseTopic;

/** Lets a rejected `updateSubscriptions` reach the client's `.catch()`. */
const settle = async (): Promise<void> => {
  for (let tick = 0; tick < 5; tick += 1) {
    await Promise.resolve();
  }
};

const topicsOf = (stream: FakeStream | undefined): string | null =>
  new URL(stream?.url ?? '', 'http://test.invalid').searchParams.get('topics');
const TASK_TOPIC = 'task:22222222-2222-4222-8222-222222222222' as SseTopic;

const transcriptFrame = (topic: SseTopic, seq: number): SseFrame => ({
  frame: 'transcript',
  topic,
  seq,
  data: {
    kind: 'assistant',
    run_id: '11111111-1111-4111-8111-111111111111',
    seq,
    created_at: '2026-09-10T09:00:00.000Z',
    redaction_count: 0,
    model: 'claude-opus-5',
    content: [{ type: 'text', text: `frame ${seq}` }],
  },
});

const control = (type: 'ping' | 'reset' | 'shutdown', topic: SseTopic | null): SseFrame => ({
  frame: 'control',
  topic,
  type,
  detail: null,
});

interface Harness {
  readonly streams: FakeStream[];
  readonly frames: SseFrame[];
  readonly resets: (SseTopic | null)[];
  readonly statuses: RealtimeStatus[];
  readonly timers: Map<number, () => void>;
  readonly subscriptions: unknown[];
  runTimers(): void;
  readonly client: ReturnType<typeof createRealtimeClient>;
}

interface HarnessOptions {
  readonly withSubscriptions?: boolean;
  /** Answers each POST after it is recorded; the default resolves. A rejection is the 404 path. */
  readonly answerSubscription?: (body: unknown) => Promise<void>;
}

const harness = (options: HarnessOptions = {}): Harness => {
  const streams: FakeStream[] = [];
  const frames: SseFrame[] = [];
  const resets: (SseTopic | null)[] = [];
  const statuses: RealtimeStatus[] = [];
  /**
   * Scheduled callbacks, keyed by handle.
   *
   * Keyed rather than appended, and `clearTimer` genuinely removes: a harness whose `clearTimer`
   * did nothing would run a *cancelled* timer and report a defect the product does not have —
   * kinder in the direction that produces false failures, and in the other direction it would
   * hide a timer the client forgot to cancel (standing rule 1).
   */
  const timers = new Map<number, () => void>();
  let nextHandle = 0;
  const subscriptions: unknown[] = [];

  const client = createRealtimeClient({
    openStream: (url) => {
      const listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();
      const stream: FakeStream = {
        url,
        listeners,
        closed: false,
        addEventListener: (type, listener) => {
          listeners.set(type, [...(listeners.get(type) ?? []), listener]);
        },
        close: () => {
          stream.closed = true;
        },
        emit: (event, data, id) => {
          const message = new MessageEvent<string>(event, {
            data: typeof data === 'string' ? data : JSON.stringify(data),
            ...(id === undefined ? {} : { lastEventId: id }),
          });
          for (const listener of listeners.get(event) ?? []) {
            listener(message);
          }
        },
        fail: () => {
          for (const listener of listeners.get('error') ?? []) {
            listener(new MessageEvent<string>('error', { data: '' }));
          }
        },
        opened: () => {
          for (const listener of listeners.get('open') ?? []) {
            listener(new MessageEvent<string>('open', { data: '' }));
          }
        },
      };
      streams.push(stream);
      return stream;
    },
    ...(options.withSubscriptions === true
      ? {
          updateSubscriptions: async (body) => {
            subscriptions.push(body);
            await options.answerSubscription?.(body);
          },
        }
      : {}),
    onFrame: (frame) => {
      frames.push(frame);
    },
    onReset: (topic) => {
      resets.push(topic);
    },
    onStatus: (status) => {
      statuses.push(status);
    },
    setTimer: (callback) => {
      nextHandle += 1;
      timers.set(nextHandle, callback);
      return nextHandle;
    },
    clearTimer: (handle) => {
      timers.delete(handle);
    },
    newConnectionId: () => 'connection-1',
    backoffMs: () => 1,
  });

  return {
    streams,
    frames,
    resets,
    statuses,
    timers,
    subscriptions,
    runTimers: () => {
      const pending = [...timers.values()];
      timers.clear();
      for (const timer of pending) {
        timer();
      }
    },
    client,
  };
};

describe('the realtime client', () => {
  it('opens one stream carrying every retained topic and the connection id', () => {
    const { client, streams } = harness();
    client.setTopics([RUN_TOPIC, TASK_TOPIC]);

    expect(streams).toHaveLength(1);
    const url = new URL(streams[0]?.url ?? '', 'http://test.invalid');
    expect(url.pathname).toBe('/events');
    expect(url.searchParams.get('topics')).toBe(`${RUN_TOPIC},${TASK_TOPIC}`);
    expect(url.searchParams.get('connection_id')).toBe('connection-1');
    expect(url.searchParams.get('last_event_id')).toBeNull();
  });

  it('reports the stream as open when the transport opens, before anything is said on it', () => {
    // This app never polls, so a badge that only turns green on the first frame reads
    // "Reconnecting" on a healthy but quiet stream — the lie the badge exists to prevent.
    const { client, streams } = harness();
    client.setTopics([RUN_TOPIC]);
    expect(client.status()).toBe('connecting');

    streams[0]?.opened();

    expect(client.status()).toBe('open');
  });

  it('parses a frame, records its cursor and reports it as open', () => {
    const { client, streams, frames } = harness();
    client.setTopics([RUN_TOPIC]);
    streams[0]?.emit('assistant', transcriptFrame(RUN_TOPIC, 7), `${RUN_TOPIC}:7`);

    expect(frames).toHaveLength(1);
    expect(client.cursors().get(RUN_TOPIC)).toBe(7);
    expect(client.status()).toBe('open');
  });

  it('drops a frame that does not match the published schema instead of throwing', () => {
    const { client, streams, frames } = harness();
    client.setTopics([RUN_TOPIC]);

    streams[0]?.emit('assistant', { frame: 'transcript', topic: RUN_TOPIC }, `${RUN_TOPIC}:1`);
    streams[0]?.emit('assistant', 'not json at all', `${RUN_TOPIC}:2`);

    expect(frames).toHaveLength(0);
    expect(client.droppedFrames()).toBe(2);
    // And the stream is still usable: one bad frame must not end a working connection.
    streams[0]?.emit('assistant', transcriptFrame(RUN_TOPIC, 3), `${RUN_TOPIC}:3`);
    expect(frames).toHaveLength(1);
  });

  it('does not move a cursor for a frame that carries no id', () => {
    const { client, streams } = harness();
    client.setTopics([RUN_TOPIC]);
    streams[0]?.emit('ping', control('ping', RUN_TOPIC));

    expect(client.cursors().size).toBe(0);
  });

  describe('reset', () => {
    it('forgets the topic’s cursor and tells the owner to refetch', () => {
      const { client, streams, resets } = harness();
      client.setTopics([RUN_TOPIC, TASK_TOPIC]);
      streams[0]?.emit('assistant', transcriptFrame(RUN_TOPIC, 5), `${RUN_TOPIC}:5`);
      streams[0]?.emit('assistant', transcriptFrame(TASK_TOPIC, 9), `${TASK_TOPIC}:9`);
      expect(client.cursors().get(RUN_TOPIC)).toBe(5);

      streams[0]?.emit('reset', control('reset', RUN_TOPIC));

      expect(resets).toEqual([RUN_TOPIC]);
      expect(client.cursors().has(RUN_TOPIC)).toBe(false);
      // The other topic's position is untouched: a reset is per topic.
      expect(client.cursors().get(TASK_TOPIC)).toBe(9);
    });

    it('forgets every cursor when the reset is about the whole connection', () => {
      const { client, streams, resets } = harness();
      client.setTopics([RUN_TOPIC, TASK_TOPIC]);
      streams[0]?.emit('assistant', transcriptFrame(RUN_TOPIC, 5), `${RUN_TOPIC}:5`);
      streams[0]?.emit('assistant', transcriptFrame(TASK_TOPIC, 9), `${TASK_TOPIC}:9`);

      streams[0]?.emit('reset', control('reset', null));

      expect(resets).toEqual([null]);
      expect(client.cursors().size).toBe(0);
    });

    it('is not resurrected by the last-event-ID a real EventSource carries on a control frame', () => {
      // `EventSource` keeps its last-event-ID buffer across frames that carry no `id:`, so a
      // control frame arrives with the id of the previous replayable one. Reading the cursor from
      // there undid the reset; the client reads it from the frame's own `topic`/`seq` instead.
      const { client, streams } = harness();
      client.setTopics([RUN_TOPIC]);
      streams[0]?.emit('assistant', transcriptFrame(RUN_TOPIC, 5), `${RUN_TOPIC}:5`);
      expect(client.cursors().get(RUN_TOPIC)).toBe(5);

      // The stale id the browser replays, on a frame the server wrote without one.
      streams[0]?.emit('reset', control('reset', RUN_TOPIC), `${RUN_TOPIC}:5`);
      expect(client.cursors().has(RUN_TOPIC)).toBe(false);

      streams[0]?.emit('shutdown', control('shutdown', null), `${RUN_TOPIC}:5`);
      expect(client.cursors().has(RUN_TOPIC)).toBe(false);
    });

    it('is not delivered to onFrame: a control frame is not content', () => {
      const { client, streams, frames } = harness();
      client.setTopics([RUN_TOPIC]);
      streams[0]?.emit('reset', control('reset', RUN_TOPIC));
      expect(frames).toHaveLength(0);
    });
  });

  describe('shutdown', () => {
    it('closes the stream, reports the status and reconnects on the timer', () => {
      const { client, streams, statuses, runTimers } = harness();
      client.setTopics([RUN_TOPIC]);
      streams[0]?.emit('assistant', transcriptFrame(RUN_TOPIC, 4), `${RUN_TOPIC}:4`);

      streams[0]?.emit('shutdown', control('shutdown', null));

      expect(statuses).toContain('server_shutdown');
      expect(streams[0]?.closed).toBe(true);
      expect(streams).toHaveLength(1);

      runTimers();

      expect(streams).toHaveLength(2);
      expect(client.reconnects()).toBe(1);
    });

    it('reconnects carrying the complete cursor set, not just the last frame', () => {
      const { client, streams, runTimers } = harness();
      client.setTopics([RUN_TOPIC, TASK_TOPIC]);
      streams[0]?.emit('assistant', transcriptFrame(RUN_TOPIC, 4), `${RUN_TOPIC}:4`);
      streams[0]?.emit('assistant', transcriptFrame(TASK_TOPIC, 12), `${TASK_TOPIC}:12`);

      streams[0]?.emit('shutdown', control('shutdown', null));
      runTimers();

      const url = new URL(streams[1]?.url ?? '', 'http://test.invalid');
      // `Last-Event-ID` would carry only `task:…:12`. The query carries both.
      expect(url.searchParams.get('last_event_id')).toBe(`${RUN_TOPIC}:4,${TASK_TOPIC}:12`);
    });

    it('asks for the live stream again after a reset, rather than replaying an unplaceable cursor', () => {
      const { client, streams, runTimers } = harness();
      client.setTopics([RUN_TOPIC]);
      streams[0]?.emit('assistant', transcriptFrame(RUN_TOPIC, 4), `${RUN_TOPIC}:4`);
      streams[0]?.emit('reset', control('reset', RUN_TOPIC));

      streams[0]?.emit('shutdown', control('shutdown', null));
      runTimers();

      const url = new URL(streams[1]?.url ?? '', 'http://test.invalid');
      expect(url.searchParams.get('last_event_id')).toBeNull();
      expect(url.searchParams.get('topics')).toBe(RUN_TOPIC);
    });
  });

  describe('transport errors', () => {
    it('closes the source before scheduling its own reconnect, so the browser does not race it', () => {
      const { client, streams, runTimers } = harness();
      client.setTopics([RUN_TOPIC]);

      streams[0]?.fail();

      // The close is what stops `EventSource`'s built-in retry to the stale URL.
      expect(streams[0]?.closed).toBe(true);
      expect(client.status()).toBe('reconnecting');
      expect(streams).toHaveLength(1);

      runTimers();
      expect(streams).toHaveLength(2);
    });

    it('ignores an error from a stream it has already replaced', () => {
      const { client, streams, runTimers } = harness();
      client.setTopics([RUN_TOPIC]);
      streams[0]?.fail();
      runTimers();
      expect(streams).toHaveLength(2);

      streams[0]?.fail();
      runTimers();

      expect(streams).toHaveLength(2);
      expect(client.reconnects()).toBe(1);
    });

    it('opens nothing after close(), including from a timer that was already queued', () => {
      const { client, streams, runTimers } = harness();
      client.setTopics([RUN_TOPIC]);
      streams[0]?.fail();

      client.close();
      runTimers();

      expect(streams).toHaveLength(1);
      expect(client.status()).toBe('closed');
    });
  });

  describe('topics', () => {
    it('updates the subscription over HTTP rather than reopening, when the endpoint is wired', async () => {
      const h = harness({ withSubscriptions: true });
      h.client.setTopics([RUN_TOPIC]);
      h.streams[0]?.opened();
      h.client.setTopics([RUN_TOPIC, TASK_TOPIC]);
      await Promise.resolve();

      expect(h.streams).toHaveLength(1);
      expect(h.subscriptions).toEqual([{ connection_id: 'connection-1', add: [TASK_TOPIC] }]);
    });

    it('reopens when there is no subscription endpoint', () => {
      const { client, streams } = harness();
      client.setTopics([RUN_TOPIC]);
      client.setTopics([RUN_TOPIC, TASK_TOPIC]);

      expect(streams).toHaveLength(2);
      expect(new URL(streams[1]?.url ?? '', 'http://test.invalid').searchParams.get('topics')).toBe(
        `${RUN_TOPIC},${TASK_TOPIC}`,
      );
    });

    it('claims the pending reconnect when a topic change opens the stream itself', () => {
      // A screen mounting while a reconnect is queued must not leave the timer to open a second
      // stream a moment later. The timer is the same shared obligation `sse/hub.ts` audits on the
      // server side: two paths can discharge it, so exactly one must.
      const { client, streams, runTimers } = harness();
      client.setTopics([RUN_TOPIC]);
      streams[0]?.fail();
      expect(streams).toHaveLength(1);

      client.setTopics([RUN_TOPIC, TASK_TOPIC]);
      expect(streams).toHaveLength(2);

      runTimers();

      expect(streams, 'the cancelled timer opened a third stream').toHaveLength(2);
    });

    it('does nothing when the topic set has not changed', () => {
      const { client, streams } = harness();
      client.setTopics([RUN_TOPIC]);
      client.setTopics([RUN_TOPIC]);
      expect(streams).toHaveLength(1);
    });

    it('forgets the cursor of a topic it stops watching', () => {
      const h = harness({ withSubscriptions: true });
      h.client.setTopics([RUN_TOPIC, TASK_TOPIC]);
      h.streams[0]?.emit('assistant', transcriptFrame(RUN_TOPIC, 3), `${RUN_TOPIC}:3`);

      h.client.setTopics([TASK_TOPIC]);

      expect(h.client.cursors().has(RUN_TOPIC)).toBe(false);
    });

    it('ignores a frame for a dropped topic, so no cursor survives the removal', async () => {
      // `setTopics` removes the topic from the client synchronously and tells the server over
      // HTTP, so the still-open stream can deliver the dropped topic in between — and on the
      // `.catch()` path the server never hears about it at all. A cursor written then is one
      // nothing deletes: it rides every reconnect as `last_event_id=run:…:4` for a topic the
      // connection is not subscribed to.
      const h = harness({ withSubscriptions: true });
      h.client.setTopics([RUN_TOPIC, TASK_TOPIC]);

      // The counter is proved to move before it is asserted to stay still (standing rule 29).
      h.streams[0]?.emit('assistant', transcriptFrame(RUN_TOPIC, 3), `${RUN_TOPIC}:3`);
      expect(h.frames).toHaveLength(1);
      expect(h.client.ignoredFrames()).toBe(0);

      h.client.setTopics([TASK_TOPIC]);
      h.streams[0]?.emit('assistant', transcriptFrame(RUN_TOPIC, 4), `${RUN_TOPIC}:4`);

      expect(h.client.ignoredFrames(), 'the frame was not ignored').toBe(1);
      expect(h.frames, 'a frame for a dropped topic reached the owner').toHaveLength(1);
      expect(h.client.cursors().has(RUN_TOPIC), 'the dropped topic got a cursor back').toBe(false);

      await Promise.resolve();
      h.streams[0]?.fail();
      h.runTimers();

      const url = new URL(h.streams.at(-1)?.url ?? '', 'http://test.invalid');
      expect(url.searchParams.get('topics')).toBe(TASK_TOPIC);
      expect(url.searchParams.get('last_event_id') ?? '').not.toContain(RUN_TOPIC);
    });
  });

  /**
   * Every stream shares one `connection_id`, so a POST sent before the new stream's `open` is
   * answered by whichever stream the server holds under that id — none (404), or the one being
   * displaced, whose 200 is for a topic the new stream's URL never carried. The client therefore
   * POSTs only for an open stream, and sends the difference once it opens (S-23.16).
   */
  describe('a topic change while the stream is opening', () => {
    it('sends nothing before open and one POST with every added topic after it (cold load)', async () => {
      const h = harness({ withSubscriptions: true });
      h.client.setTopics([ORG_TOPIC]);
      h.client.setTopics([ORG_TOPIC, RUN_TOPIC]);
      h.client.setTopics([ORG_TOPIC, RUN_TOPIC, TASK_TOPIC]);
      h.client.setTopics([ORG_TOPIC, RUN_TOPIC, TASK_TOPIC, PROJECT_TOPIC]);
      await settle();

      expect(h.subscriptions, 'a POST went out before the stream opened').toEqual([]);
      expect(h.streams).toHaveLength(1);
      expect(topicsOf(h.streams[0])).toBe(ORG_TOPIC);

      h.streams[0]?.opened();
      await settle();

      expect(h.subscriptions).toEqual([
        { connection_id: 'connection-1', add: [RUN_TOPIC, TASK_TOPIC, PROJECT_TOPIC] },
      ]);
      expect(h.streams, 'the client reopened instead').toHaveLength(1);
    });

    it('carries a topic added between a reopen and its open', async () => {
      // The first add is refused (the server holds no stream under the id yet), so the client
      // reopens; the next add must reach the *new* stream, not the one it is displacing.
      let refuse = true;
      const h = harness({
        withSubscriptions: true,
        answerSubscription: async () => {
          if (refuse) {
            refuse = false;
            throw new Error('404 no open stream with this id');
          }
        },
      });
      h.client.setTopics([ORG_TOPIC]);
      h.streams[0]?.opened();
      h.client.setTopics([ORG_TOPIC, RUN_TOPIC]);
      await settle();

      expect(h.streams, 'a refused POST did not reopen').toHaveLength(2);
      expect(h.streams[0]?.closed).toBe(true);
      expect(topicsOf(h.streams[1])).toBe(`${ORG_TOPIC},${RUN_TOPIC}`);

      h.client.setTopics([ORG_TOPIC, RUN_TOPIC, RUN_TOPIC_2]);
      await settle();
      expect(h.subscriptions, 'the add went to a stream that has not opened').toHaveLength(1);

      h.streams[1]?.opened();
      await settle();

      expect(h.subscriptions).toEqual([
        { connection_id: 'connection-1', add: [RUN_TOPIC] },
        { connection_id: 'connection-1', add: [RUN_TOPIC_2] },
      ]);
      expect(h.streams).toHaveLength(2);
    });

    it('does not re-add a topic removed before open, and removes one the URL carried', async () => {
      const h = harness({ withSubscriptions: true });
      h.client.setTopics([ORG_TOPIC, RUN_TOPIC]);
      // Added and dropped again before open: the server never needs to hear of it.
      h.client.setTopics([ORG_TOPIC, RUN_TOPIC, TASK_TOPIC]);
      h.client.setTopics([ORG_TOPIC, RUN_TOPIC]);
      // Carried by the URL, dropped before open: the server must be told.
      h.client.setTopics([ORG_TOPIC]);
      await settle();
      expect(h.subscriptions).toEqual([]);

      h.streams[0]?.opened();
      await settle();

      expect(h.subscriptions).toEqual([{ connection_id: 'connection-1', remove: [RUN_TOPIC] }]);
      expect(h.client.topics()).toEqual([ORG_TOPIC]);
    });

    it('sends nothing on open when the desired set ended where the URL started', async () => {
      const h = harness({ withSubscriptions: true });
      h.client.setTopics([ORG_TOPIC]);
      h.client.setTopics([ORG_TOPIC, RUN_TOPIC]);
      h.client.setTopics([ORG_TOPIC]);

      h.streams[0]?.opened();
      await settle();

      expect(h.subscriptions).toEqual([]);
    });

    it('POSTs every add and remove at once after open, as before', async () => {
      const h = harness({ withSubscriptions: true });
      h.client.setTopics([ORG_TOPIC]);
      h.streams[0]?.opened();

      h.client.setTopics([ORG_TOPIC, RUN_TOPIC]);
      expect(h.subscriptions).toEqual([{ connection_id: 'connection-1', add: [RUN_TOPIC] }]);

      h.client.setTopics([ORG_TOPIC, TASK_TOPIC]);
      expect(h.subscriptions).toEqual([
        { connection_id: 'connection-1', add: [RUN_TOPIC] },
        { connection_id: 'connection-1', add: [TASK_TOPIC], remove: [RUN_TOPIC] },
      ]);
      await settle();
      expect(h.streams).toHaveLength(1);
    });

    it('holds topic changes again once a reconnect has replaced the open stream', async () => {
      const h = harness({ withSubscriptions: true });
      h.client.setTopics([ORG_TOPIC]);
      h.streams[0]?.opened();
      h.streams[0]?.fail();
      h.runTimers();
      expect(h.streams).toHaveLength(2);

      h.client.setTopics([ORG_TOPIC, RUN_TOPIC]);
      await settle();
      expect(h.subscriptions, 'the add went out before the new stream opened').toEqual([]);

      h.streams[1]?.opened();
      await settle();
      expect(h.subscriptions).toEqual([{ connection_id: 'connection-1', add: [RUN_TOPIC] }]);
    });

    it('does not reopen for a refused POST whose stream was already replaced', async () => {
      // The successor's URL was built from the desired set, which already held the change.
      const pending: { refuse?: () => void } = {};
      const h = harness({
        withSubscriptions: true,
        answerSubscription: async () =>
          await new Promise<void>((_resolve, reject) => {
            pending.refuse = () => {
              reject(new Error('404 no open stream with this id'));
            };
          }),
      });
      h.client.setTopics([ORG_TOPIC]);
      h.streams[0]?.opened();
      h.client.setTopics([ORG_TOPIC, RUN_TOPIC]);
      h.streams[0]?.fail();
      h.runTimers();
      expect(h.streams).toHaveLength(2);
      expect(topicsOf(h.streams[1])).toBe(`${ORG_TOPIC},${RUN_TOPIC}`);

      expect(pending.refuse).toBeDefined();
      pending.refuse?.();
      await settle();

      expect(h.streams, 'a stale refusal reopened the successor').toHaveLength(2);
      expect(h.client.reconnects()).toBe(1);
    });
  });
});

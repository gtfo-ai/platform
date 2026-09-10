/**
 * The client half of TD-014: one multiplexed SSE stream per tab.
 *
 * `apps/server/src/sse/hub.ts` is the other half, and its module docblock is the contract this
 * file is written against. What that contract obliges a client to do, and where each obligation
 * is discharged here:
 *
 * | Server behaviour (technical/08, hub.ts) | Here |
 * |---|---|
 * | `id: <topic>:<seq>` on replayable frames only | `#record` — a frame with no id moves no cursor |
 * | `event: reset` when the cursor cannot be placed | `#onControl` → forget that topic's cursor, tell the owner to refetch |
 * | `event: shutdown` before the stream ends | `#onControl` → close, reconnect on the ordinary backoff |
 * | reconnect replays from `Last-Event-ID` / `?last_event_id=` | `#url` sends the **complete** cursor set |
 * | `: ping` every 20 s | ignored by construction: a comment is not a message |
 * | `POST /events/subscriptions` addresses a stream by `connection_id` | `setTopics` |
 * | a topic removal is asynchronous, so its frames keep arriving | `#onMessage` ignores them, keeping the cursor map a subset of `topics` |
 *
 * ### Why the reconnect is ours and not `EventSource`'s
 * `EventSource` reconnects by itself, to **the same URL**, carrying `Last-Event-ID` for the last
 * frame it saw. On a multiplexed stream that is one topic's position and the URL's cursor list is
 * stale, so its automatic reconnect would replay the wrong window for every other topic. The
 * client therefore closes the source on `error` — which is what stops the browser's own retry —
 * and opens a fresh one whose query string carries every cursor it holds. That is also why the
 * `retry:` field the server sends is not honoured: `EventSource` applies it to a reconnect this
 * client does not use, and the backoff below is the one that runs.
 *
 * ### Why a `reset` drops the cursor
 * `reset` means "I cannot prove what you missed". Reconnecting with the same unplaceable cursor
 * would earn a second `reset` and a third; forgetting it asks for the live stream instead, and the
 * refetch the owner performs is what fills the gap. The cursor is dropped **before** `onReset`
 * runs, so a handler that reconnects synchronously cannot resurrect it.
 *
 * ### Untrusted input
 * Every `data:` payload is parsed with `sseFrameSchema` from `@platform/contracts` before anything
 * reads a field off it (BD-022). A frame that does not parse is counted and dropped — not thrown,
 * because one malformed frame must not take down a stream that is otherwise delivering.
 */
import type { SseFrame, SseTopic } from '@platform/contracts';
import {
  DOMAIN_EVENT_TYPES,
  sseControlEventSchema,
  sseFrameSchema,
  transcriptKindSchema,
} from '@platform/contracts';
import { serialiseCursors } from './cursors.js';

/** The subset of `EventSource` this client uses, so a test can supply one made of callbacks. */
export interface EventStream {
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
}

export type EventStreamFactory = (url: string) => EventStream;

export type RealtimeStatus =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'server_shutdown'
  | 'closed';

export interface RealtimeClientOptions {
  readonly openStream: EventStreamFactory;
  /** `POST /events/subscriptions`; injected so `setTopics` is testable without a server. */
  readonly updateSubscriptions?: (body: {
    readonly connection_id: string;
    readonly add?: readonly SseTopic[];
    readonly remove?: readonly SseTopic[];
  }) => Promise<void>;
  readonly onFrame: (frame: SseFrame) => void;
  /**
   * "Your cursor for this topic is unreliable — refetch." `null` means the whole connection, which
   * is what `abandon()` sends when a stream is dropped mid-flight.
   */
  readonly onReset: (topic: SseTopic | null) => void;
  readonly onStatus?: (status: RealtimeStatus) => void;
  /** Injected: a wall clock in a test is a hardware assertion (standing rule 2). */
  readonly setTimer?: (callback: () => void, delayMs: number) => number;
  readonly clearTimer?: (handle: number) => void;
  readonly newConnectionId?: () => string;
  /** Exponential with a ceiling; `attempt` starts at 1. */
  readonly backoffMs?: (attempt: number) => number;
  readonly path?: string;
}

const defaultBackoff = (attempt: number): number => Math.min(1000 * 2 ** (attempt - 1), 30_000);

/**
 * The events the hub can name. `frameEventName()` on the server returns the catalogue type, the
 * transcript kind or the control name, so a client cannot enumerate them — it listens to
 * `message` (the default for a frame with no `event:` field) *and* installs one listener per name
 * it knows. Since every frame the hub writes carries an `event:`, the practical answer is to
 * listen for the union of the control names and to rely on `data` for everything else: the
 * discriminator this client switches on is `data.frame`, never the SSE event name.
 *
 * `EventSource` has no "any event" listener, so the names are enumerated. They come from
 * `@platform/contracts` (`sseControlEventSchema`, `domainEventTypeSchema`, `transcriptKindSchema`)
 * rather than from a list written here, which is what stops this from drifting when the catalogue
 * grows.
 */
export const STREAM_EVENT_NAMES: readonly string[] = [
  'message',
  ...sseControlEventSchema.options,
  ...DOMAIN_EVENT_TYPES,
  ...transcriptKindSchema.options,
];

export interface RealtimeClient {
  readonly connect: () => void;
  readonly close: () => void;
  readonly setTopics: (topics: readonly SseTopic[]) => void;
  readonly status: () => RealtimeStatus;
  readonly topics: () => readonly SseTopic[];
  readonly cursors: () => ReadonlyMap<string, number>;
  readonly connectionId: () => string;
  /** Frames that failed `sseFrameSchema`. A number that moves is a contract mismatch, not noise. */
  readonly droppedFrames: () => number;
  /** Frames delivered for a topic this client had already dropped. See `onMessage`. */
  readonly ignoredFrames: () => number;
  /** How many times the stream has been reopened. Exposed so a test can assert it did not. */
  readonly reconnects: () => number;
}

export const createRealtimeClient = (
  options: RealtimeClientOptions,
  eventNames: readonly string[] = STREAM_EVENT_NAMES,
): RealtimeClient => {
  const setTimer =
    options.setTimer ??
    // `@types/node` types the global `setTimeout` as returning a `Timeout`; in a browser it is a
    // number. The client only ever hands the value back to its own `clearTimer`, so the handle is
    // opaque and the cast is about the two type declarations, not about the value.
    ((callback: () => void, delay: number) =>
      globalThis.setTimeout(callback, delay) as unknown as number);
  const clearTimer =
    options.clearTimer ??
    ((handle: number) => {
      globalThis.clearTimeout(handle);
    });
  const backoffMs = options.backoffMs ?? defaultBackoff;
  const path = options.path ?? '/events';
  const connectionId = (options.newConnectionId ?? (() => crypto.randomUUID()))();

  const cursors = new Map<string, number>();
  let topics: SseTopic[] = [];
  let source: EventStream | null = null;
  let status: RealtimeStatus = 'idle';
  let attempt = 0;
  let retryHandle: number | null = null;
  let dropped = 0;
  let ignored = 0;
  let reconnects = 0;
  let disposed = false;

  const setStatus = (next: RealtimeStatus): void => {
    if (status !== next) {
      status = next;
      options.onStatus?.(next);
    }
  };

  const url = (): string => {
    const query = new URLSearchParams({
      topics: topics.join(','),
      connection_id: connectionId,
    });
    const cursor = serialiseCursors(cursors);
    if (cursor !== '') {
      query.set('last_event_id', cursor);
    }
    return `${path}?${query.toString()}`;
  };

  const detach = (): void => {
    // Closing before opening a new source is what stops `EventSource`'s own retry — see the
    // module note. A source left open would reconnect to a URL whose cursors are stale.
    source?.close();
    source = null;
  };

  /**
   * Cancels a scheduled reconnect.
   *
   * Anything that opens a stream *now* has to claim the pending timer as well, or the timer opens
   * a second one a moment later and the first is orphaned — the shared-obligation shape of
   * `sse/hub.ts`'s own audit, on this side of the wire. `open()` is the one place that opens, so it
   * is the one place that cancels.
   */
  const cancelRetry = (): void => {
    if (retryHandle !== null) {
      clearTimer(retryHandle);
      retryHandle = null;
    }
  };

  const scheduleReconnect = (): void => {
    if (disposed || topics.length === 0) {
      return;
    }
    attempt += 1;
    cancelRetry();
    retryHandle = setTimer(() => {
      retryHandle = null;
      reconnects += 1;
      open();
    }, backoffMs(attempt));
  };

  const onControl = (frame: Extract<SseFrame, { frame: 'control' }>): void => {
    switch (frame.type) {
      case 'ping':
        return;
      case 'reset': {
        const topic = frame.topic ?? null;
        if (topic === null) {
          cursors.clear();
        } else {
          cursors.delete(topic);
        }
        options.onReset(topic);
        return;
      }
      case 'shutdown': {
        setStatus('server_shutdown');
        detach();
        scheduleReconnect();
        return;
      }
    }
  };

  const onMessage = (event: MessageEvent<string>): void => {
    if (disposed) {
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(event.data);
    } catch {
      dropped += 1;
      return;
    }
    const parsed = sseFrameSchema.safeParse(raw);
    if (!parsed.success) {
      dropped += 1;
      return;
    }
    const frame = parsed.data;

    // A delivered frame proves the stream works, so the backoff starts from zero next time.
    attempt = 0;
    setStatus('open');

    if (frame.frame === 'control') {
      onControl(frame);
      return;
    }

    // **A frame for a topic this client no longer holds moves nothing.**
    //
    // `setTopics` drops the topic from `topics` synchronously and tells the server *asynchronously*
    // (`POST /events/subscriptions`), so the open stream can still deliver that topic's frames
    // until the server has processed the removal — and on the `.catch()` path it never does. A
    // cursor written in that window is one `setTopics` has already finished deleting, so nothing
    // deletes it: it rides every later reconnect as `topics=org&last_event_id=project:…:7`, asking
    // the server to replay a topic this connection is not subscribed to. Ignoring the frame keeps
    // the cursor map a subset of `topics`, which is the invariant `#url` depends on.
    //
    // Counted rather than silent: `ignoredFrames()` moving is a subscription that is out of step,
    // and a test that asserts the map stayed empty cannot tell that from a frame never arriving
    // (standing rule 29).
    if (!topics.includes(frame.topic)) {
      ignored += 1;
      return;
    }

    // **The cursor comes from the frame, not from `event.lastEventId`.**
    //
    // The server writes `id: ${topic}:${seq}` for replayable frames and *deliberately none* for
    // control frames, so that a `reset` or a `shutdown` cannot overwrite the client's position
    // (`sse/hub.ts`, decision 1). But `EventSource` keeps a **last-event-ID buffer that persists
    // across frames that carry no id**, so `event.lastEventId` on a control frame is the id of the
    // previous *replayable* one — reading it there resurrected the very cursor a `reset` had just
    // dropped, and the next reconnect asked to replay from a position the server had already said
    // it could not place. Found by `test/web-e2e/realtime.spec.ts` against a real `EventSource`;
    // no fake transport would have shown it, because the buffer is the browser's.
    //
    // Taking `topic` and `seq` off the frame is also simply more direct: they are the two values
    // the server composed the id from in the first place.
    cursors.set(frame.topic, frame.seq);

    options.onFrame(frame);
  };

  const open = (): void => {
    if (disposed || topics.length === 0) {
      return;
    }
    cancelRetry();
    detach();
    setStatus(status === 'idle' ? 'connecting' : 'reconnecting');
    const stream = options.openStream(url());
    source = stream;
    // An open socket is open, whether or not anything has been said on it. Deriving the status
    // from the first *frame* instead left the badge reading "Reconnecting" on a healthy but quiet
    // stream — which is exactly the lie the badge exists to prevent, since this app never polls.
    stream.addEventListener('open', () => {
      if (disposed || source !== stream) {
        return;
      }
      attempt = 0;
      setStatus('open');
    });
    for (const name of eventNames) {
      stream.addEventListener(name, onMessage);
    }
    stream.addEventListener('error', () => {
      if (disposed || source !== stream) {
        return;
      }
      setStatus('reconnecting');
      detach();
      scheduleReconnect();
    });
  };

  return {
    connect: () => {
      if (disposed || source !== null) {
        return;
      }
      open();
    },
    close: () => {
      disposed = true;
      cancelRetry();
      detach();
      setStatus('closed');
    },
    setTopics: (next) => {
      const wanted = [...new Set(next)];
      const added = wanted.filter((topic) => !topics.includes(topic));
      const removed = topics.filter((topic) => !wanted.includes(topic));
      if (added.length === 0 && removed.length === 0) {
        return;
      }
      const hadStream = source !== null;
      topics = wanted;
      for (const topic of removed) {
        cursors.delete(topic);
      }
      if (!hadStream) {
        open();
        return;
      }
      if (options.updateSubscriptions === undefined) {
        // No subscription endpoint wired: reopening is the only way to change the topic set, and
        // it is correct — the cursors travel with the new URL.
        reconnects += 1;
        open();
        return;
      }
      void options
        .updateSubscriptions({
          connection_id: connectionId,
          ...(added.length === 0 ? {} : { add: added }),
          ...(removed.length === 0 ? {} : { remove: removed }),
        })
        .catch(() => {
          // The stream is still open and still carrying its old topics; reopening resynchronises
          // it. `hub.updateSubscriptions` replays nothing for an added topic anyway, so the owner
          // refetches either way.
          reconnects += 1;
          open();
        });
    },
    status: () => status,
    topics: () => topics,
    cursors: () => cursors,
    connectionId: () => connectionId,
    droppedFrames: () => dropped,
    ignoredFrames: () => ignored,
    reconnects: () => reconnects,
  };
};

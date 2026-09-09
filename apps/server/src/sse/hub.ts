/**
 * The multiplexed SSE stream of TD-014 and technical/08 § "SSE contract".
 *
 * One connection per tab carries every topic that tab is watching (`org`, `project:<id>`,
 * `task:<id>`, `run:<id>`). Each frame is written as
 *
 *     id: <topic>:<seq>
 *     event: <catalogue event type | transcript kind>
 *     data: <the SseFrame of @platform/contracts, as JSON>
 *
 * and the server keeps a bounded ring buffer per topic so a client that reconnects with a cursor
 * gets exactly what it missed, or `event: reset` when the server cannot prove it can.
 *
 * ## Three decisions worth knowing before changing anything here
 *
 * **Control frames carry no `id:`.** A browser's `EventSource` remembers the last `id:` it saw and
 * sends it back as `Last-Event-ID`. Giving `reset` or `shutdown` an id would therefore overwrite
 * the client's cursor with something that is not a position in any topic, and the next reconnect
 * would replay from nowhere. Only `domain_event` and `transcript` frames — the replayable ones —
 * carry ids.
 *
 * **The publisher owns `seq`, the hub does not invent it.** For a task topic the sequence is the
 * event's `stream_seq`; for a run's transcript it is the `run_messages.seq`. A hub-assigned
 * counter would be per-process, so two replicas would hand the same client two different
 * numberings for one topic. Replay is therefore *positional*: find the buffered frame whose `seq`
 * equals the cursor and send everything after it. That is correct even where a topic fans several
 * streams in (`org`, `project:<id>`) and its sequence numbers are not monotonic.
 *
 * **A cursor the buffer cannot place is a `reset`, never a guess.** Buffer empty (a restarted
 * process), cursor older than the oldest retained frame, or a seq the hub never sent: in all three
 * the honest answer is "I cannot tell you what you missed, refetch" — technical/08's `reset`.
 *
 * ## What this is not, yet
 *
 * Fan-out **between** app instances. TD-014 routes that through `NOTIFY` behind the `Broadcast`
 * port, and the port's own documentation is explicit that a broadcast carries a hint rather than
 * content: the receiving instance is expected to read the rows back from `events` / `run_messages`.
 * Those read-back paths are built by the work packages that write those rows (WP-15, WP-12), so
 * wiring a hint transport now would produce an instance that announces changes it cannot render.
 * Single instance is what this hub supports, and `docs/technical/PROGRESS.md` carries it as
 * discovered work rather than a comment claiming otherwise.
 */
import type { Logger } from '@platform/application';
import { silentLogger } from '@platform/application';
import type { SseFrame, SseTopic } from '@platform/contracts';
import { sseTopicSchema } from '@platform/contracts';

/** What the hub needs from a transport. `sse/routes.ts` binds it to `@fastify/sse`. */
export interface SseTransport {
  /** Writes one `id:`/`event:`/`data:`/`retry:` block. Resolves when it has been handed to the socket. */
  send(message: {
    readonly id?: string;
    readonly event?: string;
    readonly data: unknown;
    readonly retry?: number;
  }): Promise<void>;
  /** Writes a comment line (`: ping`). Comments keep the connection warm and carry no id. */
  comment(text: string): void;
  /** Ends the response. Idempotent. */
  close(): void;
  readonly isConnected: boolean;
}

export interface OpenConnectionRequest {
  /** Client-chosen, so `POST /events/subscriptions` can address the stream it just opened. */
  readonly id: string;
  /** The authenticated user. A subscription update from anyone else is refused. */
  readonly userId: string;
  readonly topics: readonly SseTopic[];
  /** Per-topic resume cursors from `Last-Event-ID` or `?last_event_id=`. */
  readonly cursors?: ReadonlyMap<string, number>;
  /** `?partials=0` drops coalesced `stream_block` frames (technical/08). @default true */
  readonly partials?: boolean;
  readonly transport: SseTransport;
}

export interface SseHubOptions {
  /** Frames retained per topic for replay. Ring-buffer depth, and nothing else. */
  readonly bufferSize: number;
  /**
   * Live frames that may be waiting to be written to one connection before it is treated as a
   * stalled reader and dropped.
   *
   * Deliberately **not** `bufferSize`: the two numbers answer different questions, and tying them
   * together is what made a multi-topic reconnect deliver nothing (see `Connection.write`). A
   * replay batch is exempt from this cap because it is finite by construction.
   */
  readonly maxQueuedLiveFrames: number;
  /**
   * Topics one stream may carry. It bounds the largest replay a single reconnect can ask for —
   * `bufferSize × maxTopicsPerConnection` frames — which is the only thing that keeps an exempt
   * replay batch from being unbounded after all.
   *
   * **That bound is large, and it is a bound rather than a safe value.** A transcript frame
   * serialises to roughly 660 bytes, so at the shipped defaults (`bufferSize` 256,
   * `maxTopicsPerConnection` 64) one stream's replay is about 10.8 MiB, and the real ceiling is
   * that times `maxConnections` — about 10.5 GiB at 1 000 streams if every one of them reconnected
   * at once with full buffers. Nothing in normal use approaches it (a tab watches a board and a
   * handful of tasks), but anyone raising `APP_SSE_MAX_TOPICS` is raising that product and should
   * lower `APP_SSE_BUFFER_SIZE` or `APP_SSE_MAX_CONNECTIONS` to match.
   */
  readonly maxTopicsPerConnection: number;
  /** Value of the `retry:` field sent once per connection. */
  readonly retryMs: number;
  /** `: ping` interval (technical/08 says 20 s). */
  readonly pingIntervalMs: number;
  /** Hard cap on simultaneous streams. */
  readonly maxConnections: number;
  readonly logger?: Logger;
  /** Called for each frame written, so the route can count them without knowing the hub. */
  readonly onFrameSent?: (kind: 'live' | 'replay' | 'control') => void;
}

export class TooManyConnectionsError extends Error {
  constructor(limit: number) {
    super(`the server already holds ${limit} event streams (APP_SSE_MAX_CONNECTIONS)`);
    this.name = 'TooManyConnectionsError';
  }
}

/** The server is going away, so it will not take a stream it is about to have to drain. */
export class ShuttingDownError extends Error {
  constructor() {
    super('the server is shutting down and is not accepting new event streams');
    this.name = 'ShuttingDownError';
  }
}

/** Another user already holds this connection id; see `SseHub.open`. */
export class ConnectionIdInUseError extends Error {
  constructor(connectionId: string) {
    super(`connection id ${JSON.stringify(connectionId)} is already held by another user`);
    this.name = 'ConnectionIdInUseError';
  }
}

export class UnknownConnectionError extends Error {
  constructor(connectionId: string) {
    super(`no open event stream with connection id ${JSON.stringify(connectionId)}`);
    this.name = 'UnknownConnectionError';
  }
}

/** More topics on one stream than a replay for it could be bounded by; see `SseHubOptions`. */
export class TooManyTopicsError extends Error {
  constructor(count: number, limit: number) {
    super(`a stream may carry ${limit} topics, not ${count} (APP_SSE_MAX_TOPICS)`);
    this.name = 'TooManyTopicsError';
  }
}

interface BufferedFrame {
  readonly seq: number;
  readonly frame: SseFrame;
}

/** Splits `<topic>:<seq>` on the **last** colon: a topic is itself `task:<uuid>`. */
export const parseCursor = (entry: string): { topic: string; seq: number } | null => {
  const separator = entry.lastIndexOf(':');
  if (separator <= 0) {
    return null;
  }
  const topic = entry.slice(0, separator);
  const raw = entry.slice(separator + 1);
  if (!/^\d+$/.test(raw) || !sseTopicSchema.safeParse(topic).success) {
    return null;
  }
  return { topic, seq: Number.parseInt(raw, 10) };
};

/**
 * Parses the comma-separated cursor list of `Last-Event-ID` / `?last_event_id=`.
 *
 * An unparseable entry is dropped rather than rejecting the whole connection: the header is
 * replayed verbatim by browsers from whatever the server last sent, and refusing the stream would
 * turn one bad frame id into a client that can never reconnect. A dropped cursor means that topic
 * is treated as having none, which produces a `reset` — the safe direction.
 */
export const parseCursors = (raw: string | undefined | null): Map<string, number> => {
  const cursors = new Map<string, number>();
  for (const entry of (raw ?? '').split(',')) {
    const trimmed = entry.trim();
    if (trimmed === '') {
      continue;
    }
    const parsed = parseCursor(trimmed);
    if (parsed !== null) {
      // Last one wins, so a client repeating a topic cannot end up resuming from the older of two.
      cursors.set(parsed.topic, parsed.seq);
    }
  }
  return cursors;
};

/** The `event:` name of a frame — the catalogue type, the transcript kind, or the control name. */
export const frameEventName = (frame: SseFrame): string => {
  switch (frame.frame) {
    case 'domain_event':
      return frame.type;
    case 'transcript':
      return frame.data.kind;
    case 'control':
      return frame.type;
  }
};

/** The `id:` of a replayable frame; control frames deliberately have none (see the module note). */
export const frameId = (frame: SseFrame): string | undefined =>
  frame.frame === 'control' ? undefined : `${frame.topic}:${frame.seq}`;

class Connection {
  readonly id: string;
  readonly userId: string;
  readonly topics: Set<string>;
  readonly partials: boolean;
  readonly #transport: SseTransport;
  readonly #logger: Logger;
  readonly #maxQueuedLiveFrames: number;
  readonly #onFrameSent: ((kind: 'live' | 'replay' | 'control') => void) | undefined;
  /**
   * Told when the connection ends itself — a failed write or a consumer too slow to keep up.
   *
   * Without it the hub would keep a closed connection in its topic indexes for ever: the writes
   * become no-ops, so nothing looks broken, and the process leaks one entry per dropped client.
   */
  #onDropped: (() => void) | undefined;

  /**
   * Writes are serialised through one promise chain, which is what keeps a replay batch ahead of
   * the live frames that arrive while it is still being written.
   */
  #chain: Promise<void> = Promise.resolve();
  /** Everything waiting to be written — replay, control and live. Reported in the log line only. */
  #queued = 0;
  /** Live frames waiting to be written. The only thing the slow-consumer cap measures. */
  #queuedLive = 0;
  #closed = false;
  #ping: ReturnType<typeof setInterval> | undefined;

  constructor(
    request: OpenConnectionRequest,
    options: {
      logger: Logger;
      maxQueuedLiveFrames: number;
      onFrameSent?: (kind: 'live' | 'replay' | 'control') => void;
    },
  ) {
    this.id = request.id;
    this.userId = request.userId;
    this.topics = new Set(request.topics);
    this.partials = request.partials ?? true;
    this.#transport = request.transport;
    this.#logger = options.logger;
    this.#maxQueuedLiveFrames = options.maxQueuedLiveFrames;
    this.#onFrameSent = options.onFrameSent;
  }

  set onDropped(callback: () => void) {
    this.#onDropped = callback;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Everything written so far has reached the socket. Used by shutdown to prove it drained. */
  async flushed(): Promise<void> {
    await this.#chain;
  }

  startPing(intervalMs: number): void {
    this.#ping = setInterval(() => {
      if (this.#closed || !this.#transport.isConnected) {
        return;
      }
      // technical/08 § "SSE contract": `: ping` every 20 s. A comment, not an event: it must not
      // reach an `onmessage` handler and must not carry an id.
      this.#transport.comment('ping');
    }, intervalMs);
    this.#ping.unref?.();
  }

  write(frame: SseFrame, kind: 'live' | 'replay' | 'control', retryMs?: number): void {
    if (this.#closed) {
      return;
    }
    if (!this.partials && frame.frame === 'transcript' && frame.data.kind === 'stream_block') {
      return;
    }
    // The slow-consumer guard is about **live** frames, and it has to be about them twice over:
    // only a live frame is *rejected* by it, and only a live frame *counts towards* it.
    //
    // The guard exists for one failure: a client that has stopped reading, on a stream that keeps
    // producing, growing this process's heap by one frame per publish for ever. That is unbounded,
    // and dropping the connection is the recoverable answer — it reconnects with its cursor.
    //
    // A replay is not that. It is a finite batch decided once at `open()`, bounded by
    // `bufferSize × topics`, queued **synchronously** before a single write has had a chance to
    // run. That mattered in two separate ways, and the second one is easy to miss:
    //
    //  1. Exempting replay from being rejected is necessary — applying the live cap to it closed
    //     the connection mid-loop, made every already-queued frame early-return on `#closed`, and
    //     delivered zero frames with no `reset`, so the client reconnected on `retry:` straight
    //     into the same wall. Two topics with 255 missed frames each did it at the defaults.
    //  2. Exempting it is not *sufficient*, because a shared counter still leaks the batch's size
    //     into the budget the live check reads. A 765-frame replay left `#queued` far above the
    //     cap while it drained, so the first live frame to arrive mid-drain — and one will, because
    //     `@fastify/sse` waits for a socket `'drain'`, a macrotask, exactly when the batch is big —
    //     was read as "this consumer is too slow" and killed the stream after one frame.
    //
    // Hence two counters. `#queuedLive` is what the cap measures, and it only ever counts frames
    // the cap is about.
    //
    // Control frames (`reset`, `shutdown`) are exempt from both for the same reason plus one more:
    // they are how a client is *told* something went wrong, so dropping them turns a recoverable
    // state into a silent one.
    if (kind === 'live' && this.#queuedLive >= this.#maxQueuedLiveFrames) {
      this.#logger.warn(
        {
          connection_id: this.id,
          queued_live: this.#queuedLive,
          queued_total: this.#queued,
          limit: this.#maxQueuedLiveFrames,
        },
        'sse consumer is too slow, closing the stream',
      );
      this.close();
      return;
    }

    this.#queued += 1;
    if (kind === 'live') {
      this.#queuedLive += 1;
    }
    const id = frameId(frame);
    this.#chain = this.#chain
      .then(async () => {
        if (this.#closed || !this.#transport.isConnected) {
          return;
        }
        await this.#transport.send({
          ...(id === undefined ? {} : { id }),
          event: frameEventName(frame),
          data: frame,
          ...(retryMs === undefined ? {} : { retry: retryMs }),
        });
        this.#onFrameSent?.(kind);
      })
      .catch((error: unknown) => {
        this.#logger.warn(
          { connection_id: this.id, error: String(error) },
          'sse write failed, closing the stream',
        );
        this.close();
      })
      .finally(() => {
        this.#queued -= 1;
        if (kind === 'live') {
          this.#queuedLive -= 1;
        }
      });
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    if (this.#ping !== undefined) {
      clearInterval(this.#ping);
      this.#ping = undefined;
    }
    this.#transport.close();
    this.#onDropped?.();
  }
}

export class SseHub {
  readonly #options: SseHubOptions;
  readonly #logger: Logger;
  readonly #connections = new Map<string, Connection>();
  /** topic -> the connections watching it. Kept as a reverse index so publish is O(subscribers). */
  readonly #byTopic = new Map<string, Set<Connection>>();
  /** topic -> the last `bufferSize` frames, oldest first. */
  readonly #buffers = new Map<string, BufferedFrame[]>();
  #shuttingDown = false;

  constructor(options: SseHubOptions) {
    this.#options = options;
    this.#logger = options.logger ?? silentLogger;
  }

  get connectionCount(): number {
    return this.#connections.size;
  }

  get shuttingDown(): boolean {
    return this.#shuttingDown;
  }

  /** Topics with at least one subscriber. Exposed so a test can see the index is not leaking. */
  get watchedTopics(): string[] {
    return [...this.#byTopic.keys()];
  }

  /** Frames currently retained for a topic. Exposed for tests and for the readiness view. */
  bufferedSeqs(topic: string): number[] {
    return (this.#buffers.get(topic) ?? []).map((entry) => entry.seq);
  }

  /**
   * Registers a stream and replays what it missed.
   *
   * The bookkeeping between reading the buffers and adding the connection to the topic indexes is
   * deliberately synchronous: a `publish` interleaving there would either be missed by the replay
   * *and* by the live path, or delivered by both.
   */
  open(request: OpenConnectionRequest): { close: () => void } {
    if (this.#shuttingDown) {
      throw new ShuttingDownError();
    }
    if (request.topics.length > this.#options.maxTopicsPerConnection) {
      throw new TooManyTopicsError(request.topics.length, this.#options.maxTopicsPerConnection);
    }

    // The connection id is client-chosen, so a second stream can arrive carrying one that is
    // already open. It happens for a mundane reason: a laptop wakes up and the browser reconnects
    // before this process has noticed the old socket died. Refusing that would break exactly the
    // reconnect this whole module exists to support, so the stale stream is torn down and the new
    // one takes the id — but only for the **same user**. Letting anyone displace anyone else's
    // stream by guessing an id would be a denial of service with no authorisation step in it.
    const existing = this.#connections.get(request.id);
    if (existing !== undefined) {
      if (existing.userId !== request.userId) {
        throw new ConnectionIdInUseError(request.id);
      }
      this.close(request.id);
    }

    if (this.#connections.size >= this.#options.maxConnections) {
      throw new TooManyConnectionsError(this.#options.maxConnections);
    }

    const connection = new Connection(request, {
      logger: this.#logger,
      maxQueuedLiveFrames: this.#options.maxQueuedLiveFrames,
      ...(this.#options.onFrameSent === undefined
        ? {}
        : { onFrameSent: this.#options.onFrameSent }),
    });

    // 1. decide what to replay, from the buffers as they are right now
    const plan: { topic: string; frames: BufferedFrame[]; reset: boolean }[] = [];
    for (const topic of connection.topics) {
      const cursor = request.cursors?.get(topic);
      if (cursor === undefined) {
        plan.push({ topic, frames: [], reset: false });
        continue;
      }
      const buffer = this.#buffers.get(topic) ?? [];
      const index = buffer.findIndex((entry) => entry.seq === cursor);
      if (index === -1) {
        plan.push({ topic, frames: [], reset: true });
      } else {
        plan.push({ topic, frames: buffer.slice(index + 1), reset: false });
      }
    }

    // 2. register, still synchronously
    connection.onDropped = () => {
      this.close(connection.id);
    };
    this.#connections.set(connection.id, connection);
    for (const topic of connection.topics) {
      this.#subscribe(connection, topic);
    }

    // 3. queue the replay ahead of anything live
    let first = true;
    for (const { topic, frames, reset } of plan) {
      if (reset) {
        connection.write(
          {
            frame: 'control',
            topic: topic as SseTopic,
            type: 'reset',
            detail: 'the requested position is outside the replay buffer; refetch this topic',
          },
          'control',
          first ? this.#options.retryMs : undefined,
        );
        first = false;
        continue;
      }
      for (const buffered of frames) {
        connection.write(buffered.frame, 'replay', first ? this.#options.retryMs : undefined);
        first = false;
      }
    }
    if (first) {
      // Nothing to replay: the `retry:` field still has to reach the client, so it is sent as a
      // comment-free control frame the client can ignore. A ping is the frame with no meaning.
      connection.write({ frame: 'control', type: 'ping' }, 'control', this.#options.retryMs);
    }

    connection.startPing(this.#options.pingIntervalMs);

    this.#logger.info(
      { connection_id: connection.id, user_id: connection.userId, topics: [...connection.topics] },
      'sse stream opened',
    );

    return { close: () => this.close(connection.id) };
  }

  /** Appends to the topic's ring buffer and writes to every subscriber. */
  publish(frame: SseFrame): void {
    if (frame.frame === 'control') {
      throw new TypeError(
        'control frames are produced by the hub (reset, shutdown, ping), never published through it',
      );
    }
    const topic = frame.topic;
    const buffer = this.#buffers.get(topic) ?? [];
    buffer.push({ seq: frame.seq, frame });
    if (buffer.length > this.#options.bufferSize) {
      buffer.splice(0, buffer.length - this.#options.bufferSize);
    }
    this.#buffers.set(topic, buffer);

    for (const connection of this.#byTopic.get(topic) ?? []) {
      connection.write(frame, 'live');
    }
  }

  /**
   * Adds and removes topics on an open stream (`POST /events/subscriptions`).
   *
   * A newly added topic is **not** replayed: the client asked to start watching something it was
   * not watching, so it fetches the current state over REST and follows from here. Replaying a
   * buffer it never had a cursor into would deliver arbitrary history.
   */
  updateSubscriptions(
    connectionId: string,
    userId: string,
    changes: { readonly add?: readonly SseTopic[]; readonly remove?: readonly SseTopic[] },
  ): { topics: string[] } {
    const connection = this.#connections.get(connectionId);
    // A connection id belonging to somebody else is reported as unknown, not as forbidden: telling
    // a caller that an id exists but is not theirs is an oracle for guessing ids.
    if (connection === undefined || connection.userId !== userId) {
      throw new UnknownConnectionError(connectionId);
    }
    // Both changes are applied to a copy first, so a rejected update leaves the stream exactly as
    // it was rather than half-changed.
    const next = new Set(connection.topics);
    for (const topic of changes.remove ?? []) {
      next.delete(topic);
    }
    for (const topic of changes.add ?? []) {
      next.add(topic);
    }
    if (next.size > this.#options.maxTopicsPerConnection) {
      throw new TooManyTopicsError(next.size, this.#options.maxTopicsPerConnection);
    }

    for (const topic of changes.remove ?? []) {
      connection.topics.delete(topic);
      const subscribers = this.#byTopic.get(topic);
      subscribers?.delete(connection);
      // An emptied set is removed rather than left behind: `#byTopic` would otherwise accumulate
      // one entry per topic anybody has ever watched, for the lifetime of the process.
      if (subscribers?.size === 0) {
        this.#byTopic.delete(topic);
      }
    }
    for (const topic of changes.add ?? []) {
      connection.topics.add(topic);
      this.#subscribe(connection, topic);
    }
    return { topics: [...connection.topics] };
  }

  close(connectionId: string): void {
    const connection = this.#connections.get(connectionId);
    if (connection === undefined) {
      return;
    }
    this.#connections.delete(connectionId);
    for (const topic of connection.topics) {
      const subscribers = this.#byTopic.get(topic);
      subscribers?.delete(connection);
      if (subscribers?.size === 0) {
        this.#byTopic.delete(topic);
      }
    }
    connection.close();
    this.#logger.info({ connection_id: connectionId }, 'sse stream closed');
  }

  /**
   * TD-002's `preClose`: tell every client the server is going away, wait for that frame to reach
   * the socket, then end the streams.
   *
   * Draining is the whole point. A client whose socket is dropped without a `shutdown` frame
   * reconnects on `retry:` and cannot tell a deploy from a network fault; one that receives the
   * frame knows to reconnect deliberately, with its cursor. So the frame is written and **awaited**
   * before the transport is closed.
   */
  async shutdown(): Promise<number> {
    this.#shuttingDown = true;
    const connections = [...this.#connections.values()];
    for (const connection of connections) {
      connection.write({ frame: 'control', type: 'shutdown' }, 'control');
    }
    await Promise.all(connections.map(async (connection) => connection.flushed()));
    for (const connection of connections) {
      this.close(connection.id);
    }
    this.#buffers.clear();
    return connections.length;
  }

  #subscribe(connection: Connection, topic: string): void {
    const subscribers = this.#byTopic.get(topic) ?? new Set<Connection>();
    subscribers.add(connection);
    this.#byTopic.set(topic, subscribers);
  }
}

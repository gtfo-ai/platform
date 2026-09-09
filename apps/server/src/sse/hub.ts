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
 * ## Everything two paths in here share
 *
 * One defect has now been found here seven times by six readers, and every one of them was the
 * same sentence: *two paths share a quantity*. The cap rejected replay frames; then the cap's
 * counter still counted them; then the write chain still carried both, so the counter measured the
 * replay rather than the consumer; then the shutdown drain was a deadline they shared; then the
 * `shutdown` frame itself sat on the shared chain behind the replay; then — the sixth — the
 * on-chain `shutdown` and the off-chain one shared *whether the client had been told*, with
 * nothing arbitrating them, so both wrote and a `reset` landed after the frame that ends the
 * stream; and then the seventh, which is the same obligation again from a *third* path:
 * `SseHub.shutdown` had no re-entry guard, so two overlapping calls queued two `shutdown` frames
 * on one chain and both were written. Each fix was correct and left the next layer.
 *
 * The sixth taught the general form, which is wider than state: **when two code paths can each
 * discharge an obligation, the fact that the obligation has been met is itself a shared quantity
 * and needs an explicit arbiter.**
 *
 * **That rule has two directions and only one of them is obvious.** An arbiter is correct when it
 * is claimed *before any path can act* and *by the path that actually performs the obligation*.
 * Miss the first and the obligation is discharged twice — layers six and seven, a duplicated
 * `shutdown` and a `reset` after the end of the stream. Miss the second and it is discharged
 * **never**, which is the dual and a distinct class of defect: obligation 16's `first` flag was
 * consumed by a path that queued a frame the `partials` filter then dropped, so for a
 * `?partials=0` client *no* path delivered `retry:` and nothing anywhere was written twice. A
 * check for over-discharge — "can both of these run?" — does not find that one; the question that
 * finds it is "does claiming the arbiter *prove* the obligation was met?". Both are on the list.
 *
 * So the list below is in two halves — quantities, then obligations — and anything added to this
 * module belongs on it before it is written.
 *
 * ### Shared state
 *
 *  1. **`#chain`** — shared, by design and unavoidably: a replayed frame must precede the live
 *     frames of the same topic, and one chain is how that is guaranteed. Most of this half is a
 *     consequence of that one sharing, so the honest fix is never to un-share it but to stop other
 *     quantities from *inferring* anything about the consumer from it.
 *  2. **`#queued`, the slow-consumer cap** — shared counter, and it has to be: the queue is one
 *     queue. It is read as *growth beyond `#openingBacklog`*, never as depth. See `write`.
 *  3. **`#openingBacklog`** — sealed once, by `open()`, after the replay is queued. Deliberately
 *     not re-sealed: `updateSubscriptions` adds topics that carry no replay, so they buy no
 *     headroom, and a same-id reconnect builds a fresh `Connection` that seals its own.
 *  4. **`shutdownDrainMs`** — a per-connection deadline that the replay and the `shutdown` frame
 *     share. A stream that runs out of it is told out of band; see `Connection.abandon`.
 *  5. **`#buffers` and ring eviction** — shared across every connection, and mutated by `publish`
 *     (`push`/`splice`) and `#evictBuffers` (`delete`) while a replay is in flight. Safe because
 *     `open()` takes `buffer.slice(...)`, a new array: eviction can free the topic, and the plan
 *     still delivers what it read. Bounded by `maxBufferedTopics`, LRU by last publish.
 *  6. **`#byTopic`'s subscriber sets** — `publish` iterates one while dropping a stalled client
 *     deletes from it re-entrantly and synchronously (`write` → `#dropStalled` → `close` →
 *     `#onDropped` → `SseHub.close` → `subscribers.delete`). Safe by specification rather than by
 *     luck: a `Set` is walked by index over `[[SetData]]` and `delete` leaves a hole instead of
 *     compacting, so "values deleted before being visited" are skipped and everything else is
 *     visited exactly once (ECMA-262 § `Set.prototype.forEach` / `CreateSetIterator`;
 *     https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Set/forEach).
 *     Deleting the element being visited is therefore invisible to the walk. `SseHub.close` may
 *     also `delete` the whole `Set` from the map mid-iteration; the loop holds the `Set` itself, so
 *     that is a no-op for it. What this buys — the *next* subscriber still gets the frame that
 *     dropped its predecessor — is asserted in `hub.test.ts`, not just argued here.
 *  7. **The `: ping` timer** — writes straight to the transport, past `#chain`. Safe: `@fastify/sse`
 *     issues one `reply.raw.write()` per whole frame and handles backpressure after it, and Node
 *     writes chunks in order, so a comment cannot land inside a frame. It is not replayable, so
 *     its position relative to frames carries no meaning. It is also *not* counted by the cap, so
 *     a stalled reader accrues one small chunk per interval in the socket's own buffer — bounded
 *     by the interval, and released when the socket errors or the stream is dropped. It is gated
 *     by `#closed` alone and not by `#shuttingDown`, so `SseHub.shutdown` stops it explicitly
 *     rather than leaving the drain window as an unwritten exception to "nothing after `shutdown`".
 *  8. **`#onFrameSent`** — one callback for all three kinds, but it is a metric labelled by kind,
 *     not a budget, and nothing reads it back.
 *  9. **`maxConnections`** — global and unrelated to replay. It has no per-user share, so one
 *     account can hold every stream; recorded rather than fixed here.
 * 10. **The `partials` filter** — applied to replay and live alike, which is what the client asked
 *     for. It drops frames silently, which is why `write` reports whether it queued anything; see
 *     obligation 16.
 * 11. **`#shuttingDown`** — the hub's own flag, read by `open` (refuse), `publish` (stop fanning
 *     out) and now `shutdown` itself (refuse a second run), and *not* read by `updateSubscriptions`
 *     or by `Connection`'s ping, which is gated by `#closed` alone. `updateSubscriptions` during
 *     the drain window is benign, and that is asserted in `hub.test.ts` rather than argued here:
 *     it writes nothing (no replay for an added topic, and `publish` has already stopped), and
 *     `shutdown`'s own loop closes every connection afterwards, walking `connection.topics` as it
 *     stands at that moment — so `watchedTopics` is `[]` at the end whatever the update added.
 *     It is listed because "benign" is a fact about today's code, not about the flag.
 * 12. **`connection.topics`** — mutated by `updateSubscriptions` (add/remove) while
 *     `#resetEveryTopic` iterates it and `SseHub.close` iterates it to unsubscribe. Both readers
 *     are synchronous and neither yields, and every mutation happens on the request path, so no
 *     mutation can land inside either walk; the set a `reset` batch describes is therefore the set
 *     the stream had at that instant. Benign for the same reason as item 6, and by specification
 *     rather than by luck, but it is a mutable structure two paths share and belongs on this list.
 *
 * ### Shared obligations — two paths could each discharge it, so who arbitrates?
 *
 * 13. **"The client has been told the server is going away."** **Three** paths, not two, which is
 *     what an earlier version of this audit got wrong: the `shutdown` frame `SseHub.shutdown`
 *     queues on `#chain`, the one `abandon()` writes past it when the drain deadline expires, and
 *     *a second `SseHub.shutdown` call*, which queues a second frame on the same chain behind the
 *     first. Arbiters, one per pair: **`#shutdownAnnounced`** (with `#closed`) between the
 *     on-chain and the off-chain path, claimed synchronously before either writes anything — a
 *     chain link that has not started is stopped by `#closed`, one that has started is stopped by
 *     the flag, and the gap between them was the sixth layer; and **`#shuttingDown`** between the
 *     on-chain path and *itself*, because the chain link only ever **sets** `#shutdownAnnounced`
 *     and never reads it, so that flag cannot separate two on-chain links. The claim that the
 *     first two "partition the race exactly, no gap and no overlap" was true only of the pair it
 *     named; a third path was outside the partition entirely, and that was the seventh layer. It
 *     cannot be discharged once the transport is gone (`#writeControlOffChain` and the chain link
 *     both check `isConnected`); a client whose socket has already errored is not owed a frame it
 *     could not receive.
 * 14. **"The client has been told a topic's cursor is unreliable" (`reset`).** Paths:
 *     `#dropStalled` and `abandon`. Arbiter: **`#closed`** — each sets it, and each returns early
 *     on it, so exactly one can run. `open()`'s per-topic `reset` answers a different question (a
 *     cursor it cannot place) and is written before either can happen.
 * 15. **"The stream is ended."** Paths: `#dropStalled`, `abandon`, `write`'s `.catch` on a failed
 *     send, `SseHub.close` (the route's `onClose`, `open()`'s same-id displacement, and
 *     `shutdown`'s own loop). Arbiter: **`#closed`**, which makes `Connection.close` idempotent,
 *     plus the `#connections` lookup, which makes `SseHub.close` idempotent. `#closed` is also the
 *     one kill switch every queued chain link of every kind early-returns on, which is what turned
 *     round one's mid-replay close into *zero* frames delivered and no `reset`.
 *
 *     This is also the full list of things that can close a stream **mid-replay**, and an earlier
 *     version of this audit gave it as two. The three it missed are benign, but the value of an
 *     audit is exhaustiveness and one that is trusted and incomplete is worse than none: `.catch`
 *     means the socket has gone, `onClose` means the client has, and displacement means the client
 *     has replaced this stream with a newer one — in all three there is nobody left to tell, which
 *     is why none of them writes a control frame first and only `#dropStalled` and `abandon` do.
 * 16. **"The client has been told the reconnect interval" (`retry:`).** Paths: the first frame
 *     `open()` queues, or the synthetic `ping` frame when there is nothing to replay. Arbiter: the
 *     `first` flag — which used to be consumed by a frame the `partials` filter then dropped, so
 *     for a `?partials=0` client whose first missed frame was a `stream_block` *neither* path
 *     discharged it. `write` now reports whether it queued the frame, and `first` moves only then.
 * 17. **"The connection is out of the hub's indexes and out of its count."** Paths: `SseHub.close`
 *     called directly, and `Connection.#onDropped` calling it back re-entrantly from inside
 *     `Connection.close`. Arbiter: the `#connections` map, deleted from *before* `connection.close()`
 *     runs, so the re-entrant call finds nothing and returns.
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
   * How far one connection's write queue may grow **beyond the size it opened at** before the
   * client is treated as a stalled reader and dropped.
   *
   * Deliberately **not** `bufferSize`: the two numbers answer different questions, and tying them
   * together is what made a multi-topic reconnect deliver nothing (see `Connection.write`).
   * Deliberately measured as *growth*, not as depth: a replay batch is queued in full at `open()`,
   * so a depth cap reads a large reconnect as a slow consumer — which is the same defect three
   * times over. Growth is what a consumer that has stopped reading actually causes.
   */
  readonly maxQueuedFrames: number;
  /**
   * Topics one stream may carry. It bounds the largest replay a single reconnect can ask for —
   * `bufferSize × maxTopicsPerConnection` frames — which is the only thing that keeps a replay
   * batch, exempt from the backlog cap, from being unbounded after all.
   *
   * **That bound is large, and it is a bound rather than a safe value.** A transcript frame
   * serialises to roughly 660 bytes, so at the shipped defaults (`bufferSize` 256,
   * `maxTopicsPerConnection` 64) one stream's replay covers 16 384 frames — 10 813 440 bytes,
   * which is **10.31 MiB** — and 1 000 such streams on distinct topics would retain
   * 10 813 440 000 bytes, **10.07 GiB**. (Those are binary units: the figures used to be decimal
   * numbers carrying binary labels, off by 4.6 % and 7.1 %.) The frames themselves live once each
   * in `#buffers`, so what actually caps that total is `maxBufferedTopics`, not `maxConnections`:
   * a replay plan holds references, not copies. Anyone raising `APP_SSE_MAX_TOPICS` is raising the
   * per-stream figure and should lower `APP_SSE_BUFFER_SIZE` to match.
   */
  readonly maxTopicsPerConnection: number;
  /**
   * Topics whose ring buffer is retained, least-recently-published evicted first.
   *
   * `#buffers` is keyed by topic, and topics are `task:<uuid>` / `run:<uuid>` — one per task and
   * run the process has ever published for. Nothing ever tells the hub that a run has finished, so
   * without this the map grows for the lifetime of the process and is the only genuinely unbounded
   * structure here. Evicting a buffer costs a reconnecting client its replay and gives it `reset`
   * instead, which is the direction this module always errs in.
   */
  readonly maxBufferedTopics: number;
  /** Value of the `retry:` field sent once per connection. */
  readonly retryMs: number;
  /** `: ping` interval (technical/08 says 20 s). */
  readonly pingIntervalMs: number;
  /** Hard cap on simultaneous streams. */
  readonly maxConnections: number;
  /**
   * How long `shutdown()` waits for one stream's queue to reach the socket before giving up on it.
   *
   * Without a bound, `preClose` awaits a write chain that a stalled reader never drains: one dead
   * client would hold the whole deploy until the process-level grace period killed it, and the
   * shutdown steps behind the SSE drain (jobs, pool) would never run at all.
   */
  readonly shutdownDrainMs: number;
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
  readonly #maxQueuedFrames: number;
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
  /** Everything waiting to be written — replay, control and live. What the cap measures. */
  #queued = 0;
  /** Live frames waiting to be written. Reported in the log line only. */
  #queuedLive = 0;
  /**
   * `#queued` at the instant `open()` finished queueing the replay batch — the depth this stream
   * legitimately started at. See `write` for why the cap is measured from here.
   */
  #openingBacklog = 0;
  #closed = false;
  /**
   * Whether this client has been told the server is going away.
   *
   * Two paths can write that frame — the one `SseHub.shutdown` queues on `#chain`, and the one
   * `abandon()` writes past it — and *the fact that the obligation has been met is itself a
   * quantity they share*. Nothing arbitrated it, so they were not exclusive: a chain link already
   * past its `#closed` check and inside `await send(...)` when the deadline fired produced both,
   * and since `@fastify/sse` hands the bytes to the socket synchronously the wire read
   * `shutdown, reset, reset, shutdown` — a `reset` *after* the frame that ends the stream.
   *
   * Claimed **synchronously, before either path writes anything**: the chain link sets it in the
   * statement before its `await send(...)`, because the window it closes is exactly that awaited
   * drain, and `abandon()` reads and sets it before its first `reset`, because its `reset`s are
   * part of what must not happen twice or out of order.
   *
   * With `#closed` it partitions *that pair* with no gap and no overlap: a chain link that has not
   * started is stopped by `#closed`, which `abandon()` sets before it yields (it yields nowhere —
   * see there); one that has started is stopped by this.
   *
   * **It arbitrates that pair and no other, and saying otherwise was the seventh layer.** This
   * flag is *set* by the on-chain link and *read* only by `abandon()`, so it cannot separate two
   * on-chain links from each other: a second `SseHub.shutdown` call queues a second frame behind
   * the first, and the second link passes `#closed` and `isConnected` exactly as the first did.
   * What separates them is `SseHub.shutdown`'s own `#shuttingDown` guard, one layer up, where the
   * duplicate is not written rather than suppressed. Making the link read this flag as well would
   * suppress the symptom and leave the second call's `stopPing`, its snapshot and its close loop
   * running twice; see `SseHub.shutdown`.
   */
  #shutdownAnnounced = false;
  #ping: ReturnType<typeof setInterval> | undefined;

  constructor(
    request: OpenConnectionRequest,
    options: {
      logger: Logger;
      maxQueuedFrames: number;
      onFrameSent?: (kind: 'live' | 'replay' | 'control') => void;
    },
  ) {
    this.id = request.id;
    this.userId = request.userId;
    this.topics = new Set(request.topics);
    this.partials = request.partials ?? true;
    this.#transport = request.transport;
    this.#logger = options.logger;
    this.#maxQueuedFrames = options.maxQueuedFrames;
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

  /**
   * Records the queue depth the stream opened at, once `open()` has queued its replay.
   *
   * Called exactly once, from `open()`, after the replay batch and the `retry:`-carrying control
   * frame are on the chain. Everything queued after this point is traffic the stream has to keep
   * up with; everything before it is the finite batch the client asked for.
   */
  sealOpeningBacklog(): void {
    this.#openingBacklog = this.#queued;
  }

  /**
   * Stops the keep-alive comment.
   *
   * Called by `close()`, and by `SseHub.shutdown` *before* it queues the `shutdown` frame. The
   * ping writes past `#chain` and is gated by `#closed` alone, not by the hub's `#shuttingDown`,
   * so without this the one thing that can still reach the socket during the drain window is the
   * ping timer — `: ping` after the frame that ends the stream. It is a comment rather than an
   * event, so no `onmessage` handler ever sees it, but "nothing is written after `shutdown`" is
   * either true or it is a sentence with an exception nobody wrote down.
   */
  stopPing(): void {
    if (this.#ping !== undefined) {
      clearInterval(this.#ping);
      this.#ping = undefined;
    }
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

  /**
   * Queues one frame, and reports whether it was queued.
   *
   * The return value exists for one caller: `open()` hands the `retry:` field to the first frame
   * it writes, and it may only consume that "first" when a frame really is on its way. The two
   * silent drops below — a closed stream, and the `partials` filter — used to consume it anyway,
   * so a `?partials=0` client whose first missed frame was a `stream_block` was never told the
   * reconnect interval by anyone. Two paths can discharge that obligation (the first replayed
   * frame, or the synthetic `ping` when there is nothing to replay) and the flag is their arbiter,
   * so the flag has to move on the write actually happening rather than on it being attempted.
   */
  write(frame: SseFrame, kind: 'live' | 'replay' | 'control', retryMs?: number): boolean {
    if (this.#closed) {
      return false;
    }
    if (!this.partials && frame.frame === 'transcript' && frame.data.kind === 'stream_block') {
      return false;
    }
    // The slow-consumer guard, and the three ways it has been got wrong.
    //
    // It exists for one failure: a client that has stopped reading, on a stream that keeps
    // producing, growing this process's heap by one frame per publish for ever. That is unbounded,
    // and dropping the connection is the recoverable answer — it reconnects with its cursor.
    //
    // A replay is not that. It is a finite batch decided once at `open()`, bounded by
    // `bufferSize × topics`, queued **synchronously** before a single write has had a chance to
    // run. Three rounds of fixing this each closed one layer and left the next:
    //
    //  1. Exempting replay from being *rejected* is necessary — applying the cap to it closed the
    //     connection mid-loop, made every already-queued frame early-return on `#closed`, and
    //     delivered zero frames with no `reset`. Two topics with 255 missed frames each did it.
    //  2. Exempting it from *rejection* is not sufficient while a shared counter still leaks the
    //     batch's size into the budget the live check reads. A separate `#queuedLive` fixed that.
    //  3. And a counter of live frames is still not a measure of the consumer, because replay and
    //     live share `#chain`: no live frame can drain until the replay has, so `#queuedLive`
    //     counts *live frames that arrived during the replay*. At the shipped defaults a 765-frame
    //     replay (3 topics × 256 — one tab watching `org`, a project and a task) plus a producer
    //     writing at exactly the socket's own rate closed a perfectly healthy stream at frame 514.
    //     Replay length alone decided it: 765 + 400 lived, 765 + 520 died.
    //
    // The gate below is measured against `#openingBacklog` for that reason. A stream that opened
    // with 765 frames queued and still has 765 queued is keeping up exactly; one whose queue has
    // grown past what it started with by more than the cap is not. Depth cannot tell those apart —
    // which is why every depth-shaped fix, including `#queued >= cap + replayOutstanding`, is
    // arithmetically the same test as `#queuedLive >= cap` and leaves the defect in place.
    //
    // What it gives up, stated as a number rather than as a reassurance. `#openingBacklog` does
    // not decay, so a stream that opened with a large replay keeps that headroom for its whole
    // life, and the queue is bounded by `bufferSize × topics + cap` rather than by `cap` alone: at
    // the shipped ceiling that is 255 × 64 + 512 = **16 832 frames**, 11 109 120 bytes, **10.59
    // MiB** on one connection — **33 times** the 512-frame, 330 KiB budget it replaces. The frames
    // are references into `#buffers` only while `#buffers` still holds them; a queue that is not
    // draining outlives the ring, and from then on it is the only thing retaining them. What keeps
    // this transient is that the connection is dropped the moment the bound is crossed, and its
    // chain, its closures and every frame they hold become unreachable with it.
    //
    // Replay and control frames are never rejected: a replay is finite, and control frames
    // (`reset`, `shutdown`) are how a client is *told* something went wrong, so dropping them
    // turns a recoverable state into a silent one.
    if (kind === 'live' && this.#queued >= this.#openingBacklog + this.#maxQueuedFrames) {
      this.#dropStalled();
      return false;
    }

    this.#queued += 1;
    if (kind === 'live') {
      this.#queuedLive += 1;
    }
    const id = frameId(frame);
    const announcesShutdown = frame.frame === 'control' && frame.type === 'shutdown';
    this.#chain = this.#chain
      .then(async () => {
        if (this.#closed || !this.#transport.isConnected) {
          return;
        }
        if (announcesShutdown) {
          // Synchronously, immediately before the send: from here on `abandon()` must not write a
          // second one. See `#shutdownAnnounced`.
          this.#shutdownAnnounced = true;
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
    return true;
  }

  /**
   * Writes one control frame past `#chain`, for the two cases where the chain is the problem.
   *
   * Every frame that matters here is one the client is *told* something by, and both callers are
   * about to abandon a queue that is not moving: a frame appended to the chain behind that queue
   * would never be written at all. `@fastify/sse` hands the bytes to the socket synchronously
   * inside `send()` and only the returned promise waits for `'drain'`, so the frame is queued
   * behind whatever is already buffered and `end()` flushes it if the socket ever moves again.
   * Best effort is the most that is available against a reader that has stopped, and it is
   * strictly more than nothing.
   *
   * Control frames carry no `id:`, so nothing downstream positions itself by them, and the caller
   * closes immediately afterwards, which makes every chain link still queued behind it early-return
   * on `#closed`.
   *
   * That last sentence used to end "exactly one of the two paths reaches the wire", and it was
   * false: `#closed` only stops a link that has **not started**. A link already inside its
   * `await send(...)` is past every check there is, and both paths wrote. `#shutdownAnnounced` is
   * the missing half of that arbitration; this method is deliberately not where it lives, because
   * the frame that must not be duplicated is decided by the *obligation*, not by the transport
   * call — `abandon()` checks it before it writes anything at all, including its `reset`s, which
   * would otherwise land after the frame that ends the stream.
   */
  #writeControlOffChain(frame: SseFrame): void {
    if (!this.#transport.isConnected) {
      return;
    }
    void this.#transport
      .send({ event: frameEventName(frame), data: frame })
      .then(() => {
        this.#onFrameSent?.('control');
      })
      .catch(() => {
        // The socket is already gone; closing is all that is left to do.
      });
  }

  /** `reset` for every topic this stream carries; see `#dropStalled` for why it is every topic. */
  #resetEveryTopic(detail: string): void {
    for (const topic of this.topics) {
      this.#writeControlOffChain({
        frame: 'control',
        topic: topic as SseTopic,
        type: 'reset',
        detail,
      });
    }
  }

  /**
   * Ends a stream whose consumer has stopped keeping up — but says so first.
   *
   * A stream cut with no `reset` is indistinguishable from a network fault. The client reconnects
   * on `retry:` with the cursor it last saw, the hub replays from there, and everything this
   * method dropped is gone without either side knowing: the client believes it has a complete
   * stream. `reset` is the frame technical/08 defines for exactly this — "I cannot tell you what
   * you missed, refetch" — and it costs one frame to turn a silent loss into a recoverable one.
   *
   * **One per topic**, because a browser's `EventSource` sends back a single `Last-Event-ID`. Its
   * next connection carries one topic's cursor, and the topics it does not name are treated as
   * fresh subscriptions: no replay, no `reset`, and a silent gap on every one of them.
   */
  #dropStalled(): void {
    this.#logger.warn(
      {
        connection_id: this.id,
        queued_live: this.#queuedLive,
        queued_total: this.#queued,
        opening_backlog: this.#openingBacklog,
        limit: this.#maxQueuedFrames,
      },
      'sse consumer is too slow, closing the stream',
    );
    this.#resetEveryTopic('the stream fell too far behind to be delivered; refetch this topic');
    this.close();
  }

  /**
   * Ends a stream whose queue did not reach the socket before `shutdown`'s deadline.
   *
   * This is the fifth layer of the same defect, and it hid behind the fix for the fourth. Bounding
   * the drain stopped one stalled client holding the whole deploy — but the `shutdown` frame is
   * written *on* `#chain`, behind the replay, so the deadline is a budget replay and control
   * frames share. A healthy client with a 765-frame replay was measured getting 33 frames and no
   * `shutdown` at all: cut off in silence, which is precisely the harm `#dropStalled` exists to
   * prevent. So the abandoned case does what the drop case does, off the chain, and the good case
   * keeps its on-chain frame so "nothing is written after `shutdown`" still holds there.
   *
   * `reset` first and `shutdown` last: the queue being abandoned means this client's cursor no
   * longer describes what it has, and `shutdown` has to be the last thing on the wire.
   *
   * **And it is not the only path that can discharge either obligation, which was the sixth layer
   * of this defect.** The deadline can expire while the on-chain `shutdown` is mid-write, and then
   * this client has already been told; writing again duplicates the frame, and the `reset`s land
   * *after* it. So the announcement is claimed once, here, before anything is written — see
   * `#shutdownAnnounced`. Suppressing the `reset`s with it is not a compromise but the correct
   * answer: the chain is FIFO and `shutdown` is the last thing queued on it (`publish` refuses
   * once `#shuttingDown`, `open` throws), so a started `shutdown` link *proves* every frame ahead
   * of it drained, and a client that has received everything has an accurate cursor.
   *
   * This method yields at no point — `#writeControlOffChain` starts the send and returns — which
   * is what makes `#closed`, set at the end of it, a complete guard in the other direction: no
   * chain link can run between the first `reset` and the `close()`.
   */
  abandon(): void {
    if (this.#closed || this.#shutdownAnnounced) {
      return;
    }
    this.#shutdownAnnounced = true;
    this.#resetEveryTopic('the server shut down before this topic finished sending; refetch it');
    this.#writeControlOffChain({ frame: 'control', type: 'shutdown' });
    this.close();
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.stopPing();
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
      maxQueuedFrames: this.#options.maxQueuedFrames,
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
    //
    // `first` is the arbiter of "this client has been told the reconnect interval", an obligation
    // the first replayed frame and the synthetic `ping` below can each discharge. It therefore
    // moves only when a frame was actually queued: `write` drops a `stream_block` for a
    // `?partials=0` client, and consuming `first` on a dropped frame left that client with no
    // `retry:` from either path.
    let first = true;
    for (const { topic, frames, reset } of plan) {
      if (reset) {
        const queued = connection.write(
          {
            frame: 'control',
            topic: topic as SseTopic,
            type: 'reset',
            detail: 'the requested position is outside the replay buffer; refetch this topic',
          },
          'control',
          first ? this.#options.retryMs : undefined,
        );
        first = first && !queued;
        continue;
      }
      for (const buffered of frames) {
        const queued = connection.write(
          buffered.frame,
          'replay',
          first ? this.#options.retryMs : undefined,
        );
        first = first && !queued;
      }
    }
    if (first) {
      // Nothing to replay: the `retry:` field still has to reach the client, so it is sent as a
      // comment-free control frame the client can ignore. A ping is the frame with no meaning.
      connection.write({ frame: 'control', type: 'ping' }, 'control', this.#options.retryMs);
    }
    // Everything queued above is the batch this client asked for; everything after it is traffic
    // the client has to keep up with. `Connection.write` measures the slow-consumer cap from here.
    connection.sealOpeningBacklog();

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
    // Re-inserting moves the topic to the end of the map's iteration order, so `#evictBuffers`
    // can treat that order as least-recently-published-first without a second structure.
    this.#buffers.delete(topic);
    this.#buffers.set(topic, buffer);
    this.#evictBuffers();

    // Once every client has been told the server is going away, nothing more may be written to
    // them. Otherwise a producer that is still running turns `shutdown`'s drain into a moving
    // target and puts frames on the wire *after* the frame that says the stream has ended.
    if (this.#shuttingDown) {
      return;
    }
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
   *
   * **Called twice, it must announce nothing twice.** This is the seventh layer of the same
   * sentence and the third path to obligation 13: without the guard below, two overlapping calls
   * each snapshot `#connections` — nothing is removed from it until the drain finishes — and each
   * queues a `shutdown` frame, so the second one passes `#closed` and `isConnected` on the chain
   * and writes. `#shutdownAnnounced` does not arbitrate that pair, because the on-chain link
   * *sets* it and never *reads* it; the arbiter for on-chain-versus-on-chain is `#shuttingDown`,
   * which is what makes the whole sequence happen once per hub. Reachability today is a property
   * of the callers rather than of the hub — Fastify's `preClose` fires exactly once and
   * `runtime.stop()` has its own guard — which is exactly the kind of argument that stops being
   * true when a caller is added, so it is arbitrated here instead of relied upon there.
   *
   * The second caller returns `0` **immediately**; it does not join the first drain. That is the
   * honest reading of the return value (frames announced by *this* call) and enough for a
   * `preClose`, but a future caller that needs to wait for the streams to be gone must hold the
   * first call's promise rather than call this again.
   */
  async shutdown(): Promise<number> {
    if (this.#shuttingDown) {
      return 0;
    }
    this.#shuttingDown = true;
    const connections = [...this.#connections.values()];
    for (const connection of connections) {
      // The ping goes past the chain and is stopped by `close()` alone, so it is the one writer
      // that could still reach the socket after the `shutdown` frame during the drain window.
      connection.stopPing();
      connection.write({ frame: 'control', type: 'shutdown' }, 'control');
    }
    // Bounded, because `flushed()` waits on the whole chain and the chain carries whatever the
    // client has not read yet — a replay batch included. A reader that has stopped never drains
    // it, and an unbounded wait here would hold `preClose` until the process-level grace period
    // killed the container, leaving every shutdown step behind this one unrun.
    const results = await Promise.all(
      connections.map(async (connection) =>
        withDeadline(connection.flushed(), this.#options.shutdownDrainMs),
      ),
    );
    const abandoned = results.filter((drained) => !drained).length;
    if (abandoned > 0) {
      this.#logger.warn(
        { streams: abandoned, drain_ms: this.#options.shutdownDrainMs },
        'sse streams did not drain before the deadline and were told so out of band',
      );
    }
    for (const [index, connection] of connections.entries()) {
      // The deadline is a budget the replay and the `shutdown` frame share, because both are on
      // one chain. A stream that ran out of it has not written its `shutdown` yet and never will,
      // so it is written past the chain instead — see `Connection.abandon`.
      if (results[index] === false) {
        connection.abandon();
      }
      this.close(connection.id);
    }
    this.#buffers.clear();
    return connections.length;
  }

  /** Drops the least-recently-published topics until `maxBufferedTopics` holds. */
  #evictBuffers(): void {
    while (this.#buffers.size > this.#options.maxBufferedTopics) {
      // `Map` iterates in insertion order and `publish` re-inserts, so the first key is the topic
      // nobody has published to for the longest.
      const oldest = this.#buffers.keys().next();
      if (oldest.done === true) {
        return;
      }
      this.#buffers.delete(oldest.value);
    }
  }

  #subscribe(connection: Connection, topic: string): void {
    const subscribers = this.#byTopic.get(topic) ?? new Set<Connection>();
    subscribers.add(connection);
    this.#byTopic.set(topic, subscribers);
  }
}

/**
 * Resolves `true` when `work` finishes first, `false` when `timeoutMs` elapses.
 *
 * The timer is unrefed and cleared either way: a shutdown that is waiting on a dead socket must
 * not be the thing keeping the event loop alive.
 */
const withDeadline = async (work: Promise<void>, timeoutMs: number): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([work.then(() => true), deadline]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
};

/**
 * The missing half of TD-007: a `run_messages` row becomes a frame on the `run:<id>` SSE topic.
 *
 * `RunTranscriptSink`'s docblock has said since WP-12 that an entry goes to *"`run_messages` plus
 * the `run:<id>` SSE topic"*, and `sse/hub.ts` has listed that topic since WP-06. **Nothing
 * published one** until this file (PROGRESS backlog 29). It is the reader half of the hint
 * `createPostgresTranscriptSink` now broadcasts.
 *
 * ## How a frame reaches a connection in a *different* process
 *
 * This is the question the work package had to answer explicitly, and the answer is: **through the
 * broadcast, not through the hub**. The writer is a `ROLE=worker` process (it runs the agent) and
 * the stream is held by a `ROLE=api` process; they share nothing but the database. So:
 *
 * ```
 *   worker: append row ──▶ NOTIFY platform_broadcast {topic: run.transcript.appended, {run_id, seq}}
 *                                                    │
 *   api:    LISTEN ◀──────────────────────────────────┘
 *           │  has any connection subscribed to run:<id>?  no ──▶ drop
 *           │                                            yes
 *           └─▶ select from run_messages where seq > watermark ──▶ hub.publish(frame per row)
 * ```
 *
 * Every instance that serves the API runs one of these, so every instance answers for the streams
 * it holds and no instance answers for another's. `ROLE=all` — the shipped default — is the same
 * path with both ends in one process; PostgreSQL delivers a notification to every listening
 * session including the publisher's own, so nothing is special-cased for it.
 *
 * ## Four decisions
 *
 *  1. **A hint is a position, and the read is a catch-up read.** The bridge keeps a watermark per
 *     run and reads *everything after it*, not the one row the hint named. That is what makes a
 *     dropped notification (the port documents them as droppable) cost latency instead of a hole,
 *     and it collapses a burst of hints into one query. `NOTIFY` also collapses identical payloads
 *     from one transaction, so per-row hints are not per-row queries anyway.
 *  2. **Only a watched run is read back** — TD-014: partial content is "only forwarded while a
 *     client is subscribed to the run". A run nobody is watching costs one map lookup per entry and
 *     no query, and a client that opens the screen afterwards gets the history from
 *     `GET /api/runs/:id/messages`, which is the same page the SPA already merges the stream into.
 *     The cost is stated rather than hidden: a client that reconnects with a cursor into a gap that
 *     opened while nobody was watching gets `reset` and refetches, which is exactly what the hub
 *     does for any cursor it cannot place.
 *  3. **One pump per run, never two.** The listener is synchronous and hints arrive faster than a
 *     query returns, so a naive `void read()` would interleave two catch-up reads of the same run
 *     and publish frames out of `seq` order — and the hub's replay is *positional*, so an
 *     out-of-order buffer is a replay that skips entries. Each run therefore has at most one pump
 *     in flight, and a hint that arrives while one is running sets a flag it re-reads at the end.
 *  3b. **`stop()` waits for the pumps.** A pump holds a query and calls `hub.publish`, and
 *     `runtime.ts` closes the broadcast and then the pool on the lines after `stop()` returns — so
 *     a stop that only closed the subscription would leave a read racing a closing pool. The flag
 *     is set first (nothing new starts, and a read already in flight publishes nothing when it
 *     lands), then the subscription is closed, then the in-flight set is awaited. Bounded by the
 *     work, never by a timer (standing rule 2).
 *  4. **State exists only while somebody is watching.** `#runs` is keyed by run id and would
 *     otherwise grow for the lifetime of the process — the same unbounded-map shape
 *     `SseHub.maxBufferedTopics` exists to bound. An entry is dropped as soon as a hint arrives for
 *     a run with no subscribers, and after a pump that ends with none, so the map is bounded by the
 *     topics the hub itself bounds.
 */
import type { Broadcast, BroadcastSubscription, Logger } from '@platform/application';
import { RUN_TRANSCRIPT_TOPIC, runTopic, silentLogger } from '@platform/application';
import type { Id, TranscriptEvent } from '@platform/contracts';
import * as z from 'zod';
import type { SseHub } from './hub.js';

/**
 * The hint, re-validated on arrival.
 *
 * A `NOTIFY` payload is a string from the database, and while this one is written by the platform's
 * own sink, "the publisher is ours" is a claim about today's code rather than about the channel:
 * anything with the connection string can send one. A malformed hint is dropped with a log line
 * rather than crashing the listener, because there is no caller to refuse to (rule 20's open half).
 */
const hintSchema = z.strictObject({
  run_id: z.uuid(),
  seq: z.int().nonnegative(),
});

/** Reads the entries of a run after `after`, in `seq` order. The bridge's only database dependency. */
export type TranscriptReader = (
  runId: string,
  after: number | null,
  limit: number,
) => Promise<readonly TranscriptEvent[]>;

export interface TranscriptBridgeOptions {
  readonly hub: SseHub;
  readonly broadcast: Broadcast;
  readonly read: TranscriptReader;
  readonly logger?: Logger;
  /** Entries one catch-up read may publish. A burst beyond it is picked up by the next pass. */
  readonly batchSize?: number;
}

export interface TranscriptBridge {
  /**
   * Stops listening and **waits for the reads already in flight**. Idempotent.
   *
   * It resolves with no pump running and nothing more publishable, which is what the composition
   * root needs: it closes the broadcast and the pool on the next lines.
   */
  stop(): Promise<void>;
  /** In-flight pumps, for a test that wants to wait for the work rather than for a duration. */
  readonly pending: number;
}

const DEFAULT_BATCH_SIZE = 200;

interface RunState {
  /** The highest `seq` already published on this run's topic; null before the first read. */
  watermark: number | null;
  running: boolean;
  /** A hint that arrived while the pump was running. */
  again: boolean;
}

export const startTranscriptBridge = async (
  options: TranscriptBridgeOptions,
): Promise<TranscriptBridge> => {
  const logger = options.logger ?? silentLogger;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const states = new Map<string, RunState>();
  /**
   * The pumps in flight, so {@link TranscriptBridge.stop} can wait for them.
   *
   * Waiting is not optional: a pump holds a database query and calls {@link SseHub.publish}, and
   * `runtime.ts` closes the broadcast and then the pool immediately after `stop()` returns — so a
   * pump still running would query a closing pool and write to a hub the shutdown has moved past.
   * The wait is bounded by the work itself (the read already in flight, and then the loop stops on
   * `stopped`), never by a timer: a wall-clock deadline here would be a hardware assertion
   * (standing rule 2).
   */
  const inFlight = new Set<Promise<void>>();
  let stopped = false;
  let subscription: BroadcastSubscription | null = null;

  const pump = async (runId: string, state: RunState): Promise<void> => {
    const topic = runTopic(runId as Id);
    while (!stopped) {
      state.again = false;
      const entries = await options.read(runId, state.watermark, batchSize);
      if (stopped) {
        // The read was already in flight when `stop()` was called. Publishing its rows now would
        // write to a hub the shutdown has passed; the entries are durable and a reconnecting
        // client refetches them from `GET /api/runs/:id/messages`.
        return;
      }
      for (const entry of entries) {
        options.hub.publish({
          frame: 'transcript',
          topic,
          // **The publisher owns `seq` and it is the row's own** (`sse/hub.ts`): the id a client
          // sends back as `Last-Event-ID` is therefore a position in `run_messages`, and
          // `?after=<seq>` on the REST endpoint means the same thing. A second numbering here
          // would make a reconnect resume from a number the page cannot express.
          seq: entry.seq,
          data: entry,
        });
        state.watermark = entry.seq;
      }
      // A full batch means there may be more; a hint that arrived mid-read means there is.
      if (!state.again && entries.length < batchSize) {
        return;
      }
      if (!options.hub.hasSubscribers(topic)) {
        return;
      }
    }
  };

  const onHint = (runId: string, seq: number): void => {
    if (stopped) {
      return;
    }
    const topic = runTopic(runId as Id);
    if (!options.hub.hasSubscribers(topic)) {
      // Decision 2 and decision 4 in one line: nothing to send it to, and nothing to remember.
      states.delete(runId);
      return;
    }
    // The first hint for a watched run starts one entry back, so the entry it announces is the
    // first one published rather than the first one skipped.
    const state = states.get(runId) ?? { watermark: seq - 1, running: false, again: false };
    states.set(runId, state);
    if (state.running) {
      state.again = true;
      return;
    }
    state.running = true;
    const task = pump(runId, state)
      .catch((error: unknown) => {
        // A read that failed is a stream that is behind, not a process that should die. The rows
        // are durable and the client refetches; the next entry of the run tries again.
        logger.error(
          { err: error, run_id: runId },
          'could not read a run’s transcript back for its event stream',
        );
      })
      .finally(() => {
        state.running = false;
        inFlight.delete(task);
        if (!options.hub.hasSubscribers(runTopic(runId as Id))) {
          states.delete(runId);
        }
      });
    inFlight.add(task);
  };

  subscription = await options.broadcast.subscribe([RUN_TRANSCRIPT_TOPIC], (message) => {
    const parsed = hintSchema.safeParse(message.payload);
    if (!parsed.success) {
      logger.warn(
        { topic: message.topic },
        'dropped a malformed transcript hint from the broadcast channel',
      );
      return;
    }
    onHint(parsed.data.run_id, parsed.data.seq);
  });

  logger.info(
    { topic: RUN_TRANSCRIPT_TOPIC },
    'the transcript bridge is listening: appended run_messages rows reach the run:<id> stream',
  );

  return {
    get pending() {
      return inFlight.size;
    },
    stop: async () => {
      // The flag first, so nothing new starts and a pump already inside `read` publishes nothing
      // when it returns; then the subscription, then the wait. `allSettled`, because a pump that
      // rejects is a logged stream failure and not a reason for `stop()` to throw at a caller that
      // is shutting down anyway.
      stopped = true;
      const held = subscription;
      subscription = null;
      await held?.close();
      await Promise.allSettled([...inFlight]);
      states.clear();
    },
  };
};

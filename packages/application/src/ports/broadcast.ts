/**
 * The `Broadcast` port (TD-014): fan-out of small notifications between app instances.
 *
 * The Postgres adapter is `LISTEN`/`NOTIFY`; a Redis/NATS adapter can replace it later without
 * touching a caller. Two rules follow from what NOTIFY is:
 *
 * 1. **It carries hints, not content.** A payload is capped (`MAX_BROADCAST_BYTES`) and a message
 *    can be dropped when nobody is listening. Everything a client actually renders is replayed
 *    from `events` / `run_messages` by the SSE layer (technical/08); a broadcast only says
 *    "something changed on this topic, come and read it".
 * 2. **One per committing transaction.** `TransactionalBroadcast` publishes inside the caller's
 *    transaction, so nothing is announced that then rolls back, and Postgres collapses identical
 *    notifications from one transaction into a single delivery.
 */
import type { Id, JsonObject } from '@platform/contracts';

/**
 * Topic the outbox worker listens on for its wake-up hint (TD-005: "NOTIFY is used only as a
 * wake-up hint once per committing transaction"). Latency, never correctness: the sweep finds
 * everything on its own if no hint arrives.
 */
export const EVENTS_APPENDED_TOPIC = 'events.appended';

/**
 * Topic the SSE layer listens on for "a transcript entry was appended" (WP-15h).
 *
 * **One dotted topic for every run, not one topic per run**, for the same reason
 * {@link EVENTS_APPENDED_TOPIC} is one: `subscribe` fixes its topic set at subscription time and
 * the Postgres adapter filters in-process off a single `LISTEN`, so a topic per run would mean
 * re-subscribing every time a browser tab opened a transcript. The run id travels in the payload
 * and the subscriber filters on it — which it has to do anyway, because it only forwards a run
 * somebody is watching (TD-014: partial content is "only forwarded while a client is subscribed to
 * the run").
 *
 * It carries {@link TranscriptAppendedHint} — a **position**, never the entry. The entry is read
 * back from `run_messages` by whichever process holds the stream, which is what makes a 7 000-byte
 * cap irrelevant to a transcript row that can be far larger.
 */
export const RUN_TRANSCRIPT_TOPIC = 'run.transcript.appended';

/**
 * The payload of {@link RUN_TRANSCRIPT_TOPIC}: which run, and how far it has got.
 *
 * A `type` rather than an `interface` on purpose — only an alias gets the implicit index signature
 * that makes it assignable to {@link BroadcastMessage.payload}'s `JsonObject`.
 */
export type TranscriptAppendedHint = {
  readonly run_id: string;
  readonly seq: number;
};

/** SSE topics of technical/08 (`GET /events?topics=org,project:<id>,task:<id>,run:<id>`). */
export const ORG_TOPIC = 'org';
export const projectTopic = (projectId: Id): string => `project:${projectId}`;
export const taskTopic = (taskId: Id): string => `task:${taskId}`;
export const runTopic = (runId: Id): string => `run:${runId}`;

/**
 * Cap on one serialised message. PostgreSQL's own limit is 8 000 bytes per notification payload;
 * the margin covers the JSON envelope the adapter wraps around the payload.
 */
export const MAX_BROADCAST_BYTES = 7_000;

/** Topics are matched literally, so their shape is constrained rather than escaped. */
export const TOPIC_PATTERN = /^[a-z][a-z0-9_.]*(:[A-Za-z0-9_-]{1,64})?$/;

export interface BroadcastMessage {
  readonly topic: string;
  readonly payload: JsonObject;
}

export type BroadcastListener = (message: BroadcastMessage) => void;

export interface BroadcastSubscription {
  /** Stops delivery to this listener. Idempotent. */
  close(): Promise<void>;
}

export interface Broadcast {
  /** Publishes outside any transaction — delivered immediately, best effort. */
  publish(message: BroadcastMessage): Promise<void>;

  /** Delivers every message published on `topics` until the subscription is closed. */
  subscribe(topics: readonly string[], listener: BroadcastListener): Promise<BroadcastSubscription>;

  /** Releases the transport. Idempotent. */
  close(): Promise<void>;
}

/** Transaction-bound publish: delivered when — and only when — the transaction commits. */
export interface TransactionalBroadcast {
  publish(message: BroadcastMessage): Promise<void>;
}

/** Thrown rather than truncating: a silently shortened notification is a debugging trap. */
export class BroadcastMessageTooLargeError extends Error {
  readonly topic: string;
  readonly bytes: number;

  constructor(topic: string, bytes: number) {
    super(
      `broadcast on "${topic}" is ${bytes} bytes, over the ${MAX_BROADCAST_BYTES}-byte limit; broadcasts carry hints, clients replay the content (technical/08)`,
    );
    this.name = 'BroadcastMessageTooLargeError';
    this.topic = topic;
    this.bytes = bytes;
  }
}

/** Validates a topic against `TOPIC_PATTERN`, returning it, so adapters can inline the check. */
export const assertTopic = (topic: string): string => {
  if (!TOPIC_PATTERN.test(topic)) {
    throw new TypeError(
      `"${topic}" is not a broadcast topic: expected "org", "project:<id>", "task:<id>", "run:<id>" or a dotted name`,
    );
  }
  return topic;
};

/**
 * The `org`, `project:<id>` and `task:<id>` topics' producer (S-23.14): appended `task.*` and
 * `run.*` events become `domain_event` frames, in whichever process holds the stream.
 *
 * `sse/hub.ts` has named these topics since WP-06 and the SPA has subscribed to them since WP-20,
 * and nothing published there: the hub's docblock left the domain event's read-back to "the work
 * package that builds it". This is it, and it is the transcript bridge's shape
 * (`sse/transcript-bridge.ts`, TD-014) with one difference that the hint forces.
 *
 * ```
 *   any process: append task.* / run.* rows ──▶ NOTIFY {topic: events.appended.live, {from, to}}
 *                                                                          │
 *   api:  LISTEN ◀─────────────────────────────────────────────────────────┘
 *         │  is any org / project:<id> / task:<id> topic watched here?  no ──▶ forget, read nothing
 *         │                                                              yes
 *         └─▶ select … from events where position in (low, to] and type is live
 *                                       [and the row's project or task is watched]
 *             ──▶ projectLiveDomainEvent ──▶ hub.publish to each watched topic it names
 * ```
 *
 * ## Six decisions
 *
 *  1. **A hint names positions, and the read is a catch-up read.** `events.position` is an
 *     identity column: it is neither gapless nor in commit order (migration 0005, research/07), so
 *     a reader that kept only a watermark would skip a row whose transaction took a lower position
 *     and committed after a higher one. The hint therefore carries its own transaction's range
 *     (`LIVE_EVENTS_APPENDED_TOPIC`), delivered after the commit, and the read is
 *     `(min(watermark, from − 1), max(to)]` — the hint's own rows *and* everything after the
 *     watermark, so a **dropped** hint (the port documents them as droppable) is caught up by the
 *     next one instead of leaving a hole. A burst of hints that arrive while a read is in flight is
 *     folded into one range and one more read. **The residual, stated:** a hint that is lost *and*
 *     names positions below the watermark (a late committer whose `NOTIFY` was dropped) is never
 *     read back; the screens catch up on their next refetch (BACKLOG 800).
 *  2. **Each position is published once.** That read can meet rows it has already published (a late
 *     transaction's range spans other transactions' rows), so the bridge remembers the last
 *     {@link DEDUPE_POSITIONS} positions it published and skips them. A position older than that
 *     memory, re-read, is published again: an invalidation is idempotent, so the cost of the bound
 *     is a duplicate refetch, never a missing one.
 *  3. **The frame is a projection, never the event.** `projectLiveDomainEvent`
 *     (`@platform/contracts`) copies ids, the stage and three small enums, each through its own
 *     schema, and nothing else — no question text, reason, brief, answer or message (BD-022, and
 *     least exposure: the client refetches through the read API, which authorises every field it
 *     returns). A row the projection refuses is skipped with a log line rather than stalling the
 *     stream behind it, and the read selects the payload only to project it.
 *  4. **Nothing is read for a topic nobody watches.** Every pass derives its scope from the hub's
 *     own subscriber index: `org` watched → every live event; otherwise only rows whose
 *     `project_id` or `task_id` is a watched `project:<id>` / `task:<id>` (bounded at
 *     {@link MAX_SCOPED_IDS} ids, past which it reads them all — the `org` case); nothing watched →
 *     no query, and the watermark and the dedupe memory are dropped, so state exists only while
 *     somebody is watching (the transcript bridge's decision 4). A frame is published only to a
 *     topic that has a subscriber at that moment, so no ring buffer is grown for nobody.
 *  5. **One pump, never two.** The listener is synchronous and hints arrive faster than a query
 *     returns; two interleaved reads would publish out of order. A hint that arrives mid-read widens
 *     the pending range and the pump reads again at the end.
 *  6. **`stop()` waits for the pump**, for the transcript bridge's reason: `runtime.ts` closes the
 *     broadcast and the pool on the lines after it. The flag first, then the subscription, then
 *     the wait — bounded by the work, never by a timer.
 *
 * ## Authorisation: unchanged, and stated
 *
 * This module adds **no** subscription surface. Who may subscribe to `org`, `project:<id>` or
 * `task:<id>` is `sse/topic-access.ts`, exactly as before (`org.read`, `project.read`,
 * `task.read` — every one of them `viewer`, and an organisation role is never demoted by a
 * project membership, `auth/rbac.ts`), and a frame reaches a connection only through the hub's
 * subscriber index for the topic it is published on. What a frame tells a subscriber is that a
 * task or run of a project it may already read changed, with that task's, run's, question's or
 * approval's id — ids the read API already serves the same reader. The one id it does not is
 * `worker_id` on `run.claimed`: an opaque UUID, whose worker's name and owner stay behind
 * `org.workers.manage` (`GET /api/workers`).
 */
import type { Broadcast, BroadcastSubscription, Logger } from '@platform/application';
import {
  LIVE_EVENTS_APPENDED_TOPIC,
  ORG_TOPIC,
  projectTopic,
  silentLogger,
  taskTopic,
} from '@platform/application';
import {
  type Id,
  type LiveDomainEventSource,
  projectLiveDomainEvent,
  type SseTopic,
} from '@platform/contracts';
import * as z from 'zod';
import type { SseHub } from './hub.js';

/**
 * The hint, re-validated on arrival: a `NOTIFY` payload is a string anyone with the connection
 * string can send. A malformed one is dropped with a log line (rule 20's open half).
 */
const hintSchema = z
  .strictObject({
    from: z.int().nonnegative(),
    to: z.int().nonnegative(),
  })
  .refine((hint) => hint.from <= hint.to, { message: 'from is not after to' });

/** Which rows a read may return: every live event, or those of the watched projects and tasks. */
export type LiveEventScope =
  | { readonly kind: 'all' }
  | {
      readonly kind: 'ids';
      readonly projectIds: readonly string[];
      readonly taskIds: readonly string[];
    };

export interface LiveEventReadRequest {
  /** Exclusive lower bound on `events.position`. */
  readonly after: number;
  /** Inclusive upper bound on `events.position`. */
  readonly upTo: number;
  readonly limit: number;
  readonly scope: LiveEventScope;
}

/** A stored live event, as the bridge reads it: its position and the projection's source. */
export interface LiveEventRow extends LiveDomainEventSource {
  readonly position: number;
}

/** Reads live events in `(after, upTo]`, in position order. The bridge's only database dependency. */
export type LiveEventReader = (request: LiveEventReadRequest) => Promise<readonly LiveEventRow[]>;

export interface DomainEventBridgeOptions {
  readonly hub: SseHub;
  readonly broadcast: Broadcast;
  readonly read: LiveEventReader;
  readonly logger?: Logger;
  /** Rows one read may return. A burst beyond it is read by the next pass. */
  readonly batchSize?: number;
}

export interface DomainEventBridge {
  /** Stops listening and **waits for the read in flight**. Idempotent. */
  stop(): Promise<void>;
  /** Whether a pump is running, for a test that waits for the work rather than a duration. */
  readonly pending: number;
}

const DEFAULT_BATCH_SIZE = 200;
/** Positions remembered as published; see decision 2. */
export const DEDUPE_POSITIONS = 4_096;
/** Watched project and task ids a read filters on before it reads every live event instead. */
export const MAX_SCOPED_IDS = 256;

const TOPIC_PREFIXES = { project: 'project:', task: 'task:' } as const;

/** The read scope the hub's subscriber index implies, or `null` when nothing live is watched. */
export const scopeOf = (watchedTopics: readonly string[]): LiveEventScope | null => {
  const projectIds: string[] = [];
  const taskIds: string[] = [];
  for (const topic of watchedTopics) {
    if (topic === ORG_TOPIC) {
      return { kind: 'all' };
    }
    if (topic.startsWith(TOPIC_PREFIXES.project)) {
      projectIds.push(topic.slice(TOPIC_PREFIXES.project.length));
    } else if (topic.startsWith(TOPIC_PREFIXES.task)) {
      taskIds.push(topic.slice(TOPIC_PREFIXES.task.length));
    }
  }
  if (projectIds.length === 0 && taskIds.length === 0) {
    return null;
  }
  if (projectIds.length + taskIds.length > MAX_SCOPED_IDS) {
    return { kind: 'all' };
  }
  return { kind: 'ids', projectIds, taskIds };
};

interface PumpState {
  /** The highest position read up to; null until the first hint while something is watched. */
  watermark: number | null;
  /** The pending range's exclusive low end and inclusive high end; null when nothing is pending. */
  low: number | null;
  high: number | null;
  running: boolean;
  readonly published: Set<number>;
  readonly order: number[];
}

const freshState = (): PumpState => ({
  watermark: null,
  low: null,
  high: null,
  running: false,
  published: new Set(),
  order: [],
});

export const startDomainEventBridge = async (
  options: DomainEventBridgeOptions,
): Promise<DomainEventBridge> => {
  const logger = options.logger ?? silentLogger;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  let state = freshState();
  let inFlight: Promise<void> | null = null;
  let stopped = false;
  let subscription: BroadcastSubscription | null = null;

  const remember = (position: number): void => {
    state.published.add(position);
    state.order.push(position);
    if (state.order.length > DEDUPE_POSITIONS) {
      const evicted = state.order.shift();
      if (evicted !== undefined) {
        state.published.delete(evicted);
      }
    }
  };

  const publish = (row: LiveEventRow): void => {
    const data = projectLiveDomainEvent(row);
    if (data === null) {
      logger.warn(
        { position: row.position, type: row.type },
        'skipped a stored event the live projection refuses',
      );
      return;
    }
    const topics: SseTopic[] = [];
    if (options.hub.hasSubscribers(ORG_TOPIC)) {
      topics.push(ORG_TOPIC);
    }
    if (data.project_id !== undefined) {
      const topic = projectTopic(data.project_id as Id) as SseTopic;
      if (options.hub.hasSubscribers(topic)) {
        topics.push(topic);
      }
    }
    if (data.task_id !== undefined) {
      const topic = taskTopic(data.task_id as Id) as SseTopic;
      if (options.hub.hasSubscribers(topic)) {
        topics.push(topic);
      }
    }
    for (const topic of topics) {
      // **The publisher owns `seq`** (`sse/hub.ts`): the global position, one numbering for every
      // topic an event is fanned into, so a `Last-Event-ID` names the same row on all three.
      options.hub.publish({
        frame: 'domain_event',
        topic,
        seq: row.position,
        type: data.type,
        data,
      });
    }
  };

  const pump = async (current: PumpState): Promise<void> => {
    while (!stopped && current === state && current.low !== null && current.high !== null) {
      const scope = scopeOf(options.hub.watchedTopics);
      if (scope === null) {
        // Everybody left while the hints were queued: decision 4, nothing to read for nobody.
        state = freshState();
        return;
      }
      const after =
        current.watermark === null ? current.low : Math.min(current.watermark, current.low);
      const upTo = current.high;
      current.low = null;
      current.high = null;
      let rows: readonly LiveEventRow[];
      try {
        rows = await options.read({ after, upTo, limit: batchSize, scope });
      } catch (error) {
        // The range goes back on the pending range, so the next hint reads it again rather than
        // starting past it: a failed read costs latency, never the rows it was reading.
        current.low = current.low === null ? after : Math.min(current.low, after);
        current.high = current.high === null ? upTo : Math.max(current.high, upTo);
        throw error;
      }
      if (stopped || current !== state) {
        // Stopped, or reset because nobody watches any more: the rows are durable and a client
        // that comes back refetches through the read API.
        return;
      }
      for (const row of rows) {
        if (current.published.has(row.position)) {
          continue;
        }
        publish(row);
        remember(row.position);
      }
      const last = rows.at(-1);
      if (rows.length >= batchSize && last !== undefined) {
        // A full batch: read on from the last row, up to at least where this pass was going.
        current.low = current.low === null ? last.position : Math.min(current.low, last.position);
        current.high = current.high === null ? upTo : Math.max(current.high, upTo);
        current.watermark = Math.max(current.watermark ?? last.position, last.position);
      } else {
        current.watermark = Math.max(current.watermark ?? upTo, upTo);
      }
    }
  };

  const onHint = (from: number, to: number): void => {
    if (stopped) {
      return;
    }
    if (scopeOf(options.hub.watchedTopics) === null) {
      // Decision 4: nobody here watches a live topic, so nothing is read and nothing remembered.
      if (!state.running) {
        state = freshState();
      }
      return;
    }
    const current = state;
    current.low = current.low === null ? from - 1 : Math.min(current.low, from - 1);
    current.high = current.high === null ? to : Math.max(current.high, to);
    if (current.running) {
      return;
    }
    current.running = true;
    const task = pump(current)
      .catch((error: unknown) => {
        // A read that failed is a stream that is behind, not a process that should die. The rows
        // are durable, and the pump put the failed range back, so the next hint reads it again.
        logger.error(
          { err: error },
          'could not read appended domain events back for the event stream',
        );
      })
      .finally(() => {
        current.running = false;
        if (inFlight === task) {
          inFlight = null;
        }
      });
    inFlight = task;
  };

  subscription = await options.broadcast.subscribe([LIVE_EVENTS_APPENDED_TOPIC], (message) => {
    const parsed = hintSchema.safeParse(message.payload);
    if (!parsed.success) {
      logger.warn(
        { topic: message.topic },
        'dropped a malformed live-event hint from the broadcast channel',
      );
      return;
    }
    onHint(parsed.data.from, parsed.data.to);
  });

  logger.info(
    { topic: LIVE_EVENTS_APPENDED_TOPIC },
    'the domain-event bridge is listening: appended task and run events reach the org, project and task streams',
  );

  return {
    get pending() {
      return inFlight === null ? 0 : 1;
    },
    stop: async () => {
      stopped = true;
      const held = subscription;
      subscription = null;
      await held?.close();
      if (inFlight !== null) {
        await inFlight.catch(() => undefined);
      }
      state = freshState();
    },
  };
};

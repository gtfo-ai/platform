/**
 * The client half of the `id: <topic>:<seq>` wire format (technical/08 § "SSE contract").
 *
 * The server's `parseCursor` splits on the **last** colon because a topic is itself `task:<uuid>`;
 * this does the same, and the two are held to each other by a test that feeds this module the
 * exact strings `apps/server/src/sse/hub.ts` emits (`frameId`). Getting the split wrong in the
 * kinder direction — first colon — would turn every reconnect into a `reset` and nothing would
 * look broken, only slow, which is why it is asserted rather than assumed.
 */
import { sseTopicSchema } from '@platform/contracts';

export interface Cursor {
  readonly topic: string;
  readonly seq: number;
}

/** `task:<uuid>:41` → `{ topic: 'task:<uuid>', seq: 41 }`; anything else → `null`. */
export const parseFrameId = (entry: string): Cursor | null => {
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
 * The `?last_event_id=` value for a reconnect: every topic whose position is known, in one string.
 *
 * `Last-Event-ID` — which a browser sends by itself — carries only the id of the *last frame
 * received*, which on a multiplexed stream is one topic's position out of many. The query
 * parameter is the complete cursor, and `sse/routes.ts` prefers it exactly because "it is the one
 * the client chose". A topic missing from this string is a topic the client is asking to be reset
 * on, which is what it wants after a `reset` it has already refetched from.
 */
export const serialiseCursors = (cursors: ReadonlyMap<string, number>): string =>
  [...cursors].map(([topic, seq]) => `${topic}:${seq}`).join(',');

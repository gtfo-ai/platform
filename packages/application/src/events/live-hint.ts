/**
 * The hint an `append` publishes for the live SSE topics (S-23.14) — one function, so the
 * PostgreSQL appender and the in-memory one announce the same thing.
 */
import { isLiveDomainEventType } from '@platform/contracts';
import {
  type BroadcastMessage,
  LIVE_EVENTS_APPENDED_TOPIC,
  type LiveEventsAppendedHint,
} from '../ports/broadcast.js';
import type { StoredEvent } from '../ports/event-store.js';

/**
 * `{from, to}` over the live events of one `append` call, or `null` when it wrote none.
 *
 * The range is the lowest and highest position of the **live** rows, so a reader that reads it
 * back may meet other transactions' rows inside it; it publishes each position once (the bridge's
 * dedupe), and a row not yet committed is announced by its own transaction's hint.
 */
export const liveEventsAppendedHint = (
  appended: readonly StoredEvent[],
): BroadcastMessage | null => {
  let from: number | null = null;
  let to: number | null = null;
  for (const stored of appended) {
    if (!isLiveDomainEventType(stored.event.type)) {
      continue;
    }
    from = from === null ? stored.position : Math.min(from, stored.position);
    to = to === null ? stored.position : Math.max(to, stored.position);
  }
  if (from === null || to === null) {
    return null;
  }
  const payload: LiveEventsAppendedHint = { from, to };
  return { topic: LIVE_EVENTS_APPENDED_TOPIC, payload };
};

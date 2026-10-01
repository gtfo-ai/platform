/**
 * **One merge-request transition, one event — whichever door saw it** (WP-110, PROGRESS backlog
 * 297).
 *
 * A git binding may hear about a merge request two ways since WP-110: the provider's webhook, and
 * the merge-request poller (`pipeline/mr-poll.ts`). WP-87's ticket poller could leave the two doors'
 * duplicates to intake's one-task-per-ticket rule, because every consumer of `ticket.matched` is
 * absorbed by it. The consumers of a merge request's **lifecycle** events are not all like that,
 * read off the tree before this was written:
 *
 *  - `mr.merged` → `pipeline.merge.measure` enqueues a measurement per event, and the statistics
 *    read keeps the first `task.mr.measured` **per cause event** — so a second `mr.merged` for one
 *    merge counts its lines twice (`delivery-measures.ts`);
 *  - `mr.closed` → the saga escalates a non-terminal task, and a second one met a task already at
 *    `needs_human`, for which `needs_human → needs_human` is not an edge — a handler that throws on
 *    every attempt and is dead-lettered;
 *  - `mr.opened` → review-only mode, which is one review per merge request already.
 *
 * So the dedup is made where both doors meet, `recordNormalisedDelivery`, and it is a statement
 * about the **log**, not about a key: a lifecycle draft that would repeat the newest lifecycle
 * event the project's log already holds for that merge request is dropped before the append
 * ({@link repeatsLifecycle}). GitLab's own state machine makes the rule exact — a merged merge
 * request cannot be reopened, and a closed one is closed again only after a reopen — so the only
 * thing a repeat can be is the same transition seen twice.
 *
 * ## Why the read is outside the transaction, and still race-free
 *
 * Every inbound event is appended to the **project** stream, under the sequence the recorder reads
 * before its transaction opens (`events_enforce_stream_seq` refuses a stale one as
 * `StreamConflictError`, and the recorder retries). This read is made **after** that sequence read.
 * A competing delivery that appended the same transition before it is seen by it; one that appended
 * after it has moved the stream past the sequence this attempt holds, so this attempt's append is
 * refused, retried, and the retry's read sees the competitor's event. Either way one of the two
 * lands. The residual is the one the rule cannot reach: an attempt that drops *every* draft appends
 * nothing and so takes no part in the race — which is the outcome it wanted anyway.
 */
import type { DomainEvent, Id } from '@platform/contracts';
import type { EventStore } from '../ports/event-store.js';

/** The three catalogue events that move a merge request's lifecycle. */
export const MERGE_REQUEST_LIFECYCLE_EVENTS = ['mr.opened', 'mr.merged', 'mr.closed'] as const;
export type MergeRequestLifecycleEvent = (typeof MERGE_REQUEST_LIFECYCLE_EVENTS)[number];

export const isMergeRequestLifecycleEvent = (type: string): type is MergeRequestLifecycleEvent =>
  (MERGE_REQUEST_LIFECYCLE_EVENTS as readonly string[]).includes(type);

/** A merge request as the log names it: the project, the repository path, the iid. */
export interface MergeRequestLifecycleKey {
  readonly projectId: Id;
  /** `mr.project_path`, or `null` when the payload names none (a binding that serves one path). */
  readonly projectPath: string | null;
  readonly iid: number;
}

/**
 * The newest lifecycle event the project's log holds for one merge request — the read the dedup
 * stands on. Not transactional, and must not be: see the module docblock for why the sequence
 * guard makes that safe.
 */
export interface MergeRequestLifecycleReader {
  latest(key: MergeRequestLifecycleKey): Promise<MergeRequestLifecycleEvent | null>;
}

/**
 * Whether `next` would repeat what the log already says. Merged is terminal on GitLab (no reopen),
 * so nothing follows it; an open follows a close (a reopen) and nothing else; a close follows an
 * open and nothing else.
 */
export const repeatsLifecycle = (
  latest: MergeRequestLifecycleEvent | null,
  next: MergeRequestLifecycleEvent,
): boolean => {
  if (latest === null) {
    return false;
  }
  switch (next) {
    case 'mr.opened':
      return latest === 'mr.opened' || latest === 'mr.merged';
    case 'mr.merged':
      return latest === 'mr.merged';
    case 'mr.closed':
      return latest === 'mr.closed' || latest === 'mr.merged';
  }
};

/** The key a lifecycle draft's payload names, or `null` for a payload that names no merge request. */
export const lifecycleKeyOf = (
  projectId: Id,
  payload: unknown,
): MergeRequestLifecycleKey | null => {
  const mr = (payload as { mr?: { iid?: unknown; project_path?: unknown } } | null)?.mr;
  if (mr === undefined || mr === null || typeof mr.iid !== 'number') {
    return null;
  }
  return {
    projectId,
    projectPath: typeof mr.project_path === 'string' ? mr.project_path : null,
    iid: mr.iid,
  };
};

/** One spelling of a key, for a map: the path is part of the identity. */
export const lifecycleKeyText = (key: MergeRequestLifecycleKey): string =>
  `${key.projectId}\0${key.projectPath ?? ''}\0${key.iid}`;

const matches = (key: MergeRequestLifecycleKey, event: DomainEvent): boolean => {
  if (!isMergeRequestLifecycleEvent(event.type)) {
    return false;
  }
  const found = lifecycleKeyOf(key.projectId, event.payload);
  return found !== null && found.iid === key.iid && (found.projectPath ?? null) === key.projectPath;
};

/**
 * The reader over the event store's own stream read — every event of the project stream, newest
 * lifecycle match wins. The reference implementation the unit tier and the memory event store use;
 * the PostgreSQL reader answers the same question from a partial index (migration 0068) instead of
 * reading the stream, which on a long-lived project is the whole of its history.
 */
export const createStreamMergeRequestLifecycle = (
  store: Pick<EventStore, 'readStream'>,
): MergeRequestLifecycleReader => ({
  latest: async (key) => {
    const stream = await store.readStream('project', key.projectId);
    for (let index = stream.length - 1; index >= 0; index -= 1) {
      const event = stream[index]?.event;
      if (event !== undefined && matches(key, event)) {
        return event.type as MergeRequestLifecycleEvent;
      }
    }
    return null;
  },
});

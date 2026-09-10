/**
 * Frames in, cache invalidations out (technical/09 § "Real-time state").
 *
 * The bridge is deliberately **event-agnostic**. It does not switch on the catalogue's ~60 event
 * types; it reads the ids an event carries — the envelope's `stream_type`/`stream_id` and
 * `correlation_id`, and the `project_id` / `task_id` / `run_id` that technical/02 puts in every
 * payload that has them — and invalidates the query prefixes those ids own. A `switch` over the
 * catalogue would need a new arm for every event a later work package adds, and the arm nobody
 * adds is a screen that quietly stops updating (standing rule 7: do not carry your own list).
 *
 * technical/09 also asks for `setQueryData` on "known shapes" (card cost, time-in-stage, run
 * status). That is an optimisation over this: invalidation is always correct and costs a refetch,
 * `setQueryData` is faster and is wrong the moment a payload and a DTO drift apart. The
 * measurement that would justify it — a board under load — does not exist yet, so this work
 * package ships the correct one and records the other as follow-up.
 *
 * A `reset` is the one case where correctness *requires* the coarse answer: the server has said it
 * cannot prove what the client missed, so everything under that topic is suspect.
 */
import type { SseFrame, SseTopic } from '@platform/contracts';
import type { QueryClient } from '@tanstack/react-query';
import { queryKeys } from '../api/keys.js';

/** Reads a string field off a payload whose union member is not known at the type level. */
const readId = (source: unknown, key: string): string | null => {
  if (typeof source !== 'object' || source === null) {
    return null;
  }
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'string' && value !== '' ? value : null;
};

/** Every query prefix a domain event can have made stale. */
export const staleKeysForEvent = (event: SseFrame & { frame: 'domain_event' }): unknown[][] => {
  const payload = event.data.payload;
  const keys: unknown[][] = [];

  const projectId =
    readId(payload, 'project_id') ??
    (event.data.stream_type === 'project' ? event.data.stream_id : null);
  if (projectId !== null) {
    keys.push([...queryKeys.project(projectId)]);
    keys.push([...queryKeys.projects]);
  }

  const taskId =
    readId(payload, 'task_id') ??
    event.data.correlation_id ??
    (event.data.stream_type === 'task' ? event.data.stream_id : null);
  if (typeof taskId === 'string' && taskId !== '') {
    keys.push([...queryKeys.task(taskId)]);
  }

  const runId =
    readId(payload, 'run_id') ?? (event.data.stream_type === 'run' ? event.data.stream_id : null);
  if (runId !== null) {
    keys.push([...queryKeys.run(runId)]);
  }

  // Questions, approvals and runs are what the org-level screens show, and both are cheap lists.
  if (event.data.stream_type === 'question' || event.data.stream_type === 'approval') {
    keys.push([...queryKeys.inbox]);
  }
  if (event.data.stream_type === 'run') {
    keys.push([...queryKeys.agents]);
  }
  keys.push(['org', 'audit']);

  return keys;
};

/** Every query prefix a `reset` on this topic makes unreliable. */
export const staleKeysForTopic = (topic: SseTopic | null): unknown[][] => {
  if (topic === null || topic === 'org') {
    // The whole connection, or the org topic: nothing about the cache is provably current.
    return [[]];
  }
  const separator = topic.indexOf(':');
  const kind = topic.slice(0, separator);
  const id = topic.slice(separator + 1);
  switch (kind) {
    case 'project':
      return [[...queryKeys.project(id)], [...queryKeys.projects]];
    case 'task':
      return [[...queryKeys.task(id)]];
    case 'run':
      return [[...queryKeys.run(id)]];
    default:
      return [[]];
  }
};

export interface QueryBridgeOptions {
  readonly queryClient: QueryClient;
  /** Transcript frames do not live in Query; they go to the per-run store. */
  readonly onTranscript?: (frame: SseFrame & { frame: 'transcript' }) => void;
}

export interface QueryBridge {
  readonly onFrame: (frame: SseFrame) => void;
  readonly onReset: (topic: SseTopic | null) => void;
}

export const createQueryBridge = (options: QueryBridgeOptions): QueryBridge => {
  const invalidate = (keys: readonly unknown[][]): void => {
    for (const key of keys) {
      void options.queryClient.invalidateQueries({ queryKey: key });
    }
  };

  return {
    onFrame: (frame) => {
      if (frame.frame === 'transcript') {
        options.onTranscript?.(frame);
        return;
      }
      if (frame.frame === 'domain_event') {
        invalidate(staleKeysForEvent(frame));
      }
    },
    onReset: (topic) => {
      invalidate(staleKeysForTopic(topic));
    },
  };
};

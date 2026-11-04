/**
 * Frames in, cache invalidations out (technical/09 § "Real-time state").
 *
 * The bridge is deliberately **event-agnostic**. It does not switch on the catalogue's ~60 event
 * types; it reads the ids a frame carries — the envelope's `stream_type`/`stream_id`, and the
 * `project_id` / `task_id` / `run_id` / `worker_id` the server's projection copies out of the
 * payload (S-23.14, `liveDomainEventSchema`) — and invalidates the query prefixes those ids own.
 * One family is read off the type's prefix rather than an arm per type: `task.question.*` and
 * `task.approval.*` refresh the inbox. A `switch` over the catalogue would need a new arm for every
 * event a later work package adds, and the arm nobody adds is a screen that quietly stops updating
 * (standing rule 7: do not carry your own list).
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

/** The inbox lists open questions and approvals (`inboxResponseSchema`), so their events refresh it. */
const INBOX_PREFIXES = ['task.question.', 'task.approval.'] as const;

/**
 * Every query prefix a domain event can have made stale.
 *
 * Since S-23.14 a frame carries a **projection** (`liveDomainEventSchema`): the envelope's ids, the
 * `project_id` / `task_id` / `run_id` / `question_id` / `approval_id` / `worker_id` the payload named,
 * and never its text — so this reads ids, and the screens refetch the words through the read API.
 */
export const staleKeysForEvent = (event: SseFrame & { frame: 'domain_event' }): unknown[][] => {
  const data = event.data;
  const keys: unknown[][] = [];

  const projectId = data.project_id ?? (data.stream_type === 'project' ? data.stream_id : null);
  if (projectId !== null) {
    keys.push([...queryKeys.project(projectId)]);
    keys.push([...queryKeys.projects]);
  }

  const taskId = data.task_id ?? (data.stream_type === 'task' ? data.stream_id : null);
  if (taskId !== null) {
    keys.push([...queryKeys.task(taskId)]);
  }

  const runId = data.run_id ?? (data.stream_type === 'run' ? data.stream_id : null);
  if (runId !== null) {
    keys.push([...queryKeys.run(runId)]);
  }

  // Questions, approvals and runs are what the org-level screens show, and both are cheap lists.
  if (
    data.stream_type === 'question' ||
    data.stream_type === 'approval' ||
    INBOX_PREFIXES.some((prefix) => data.type.startsWith(prefix))
  ) {
    keys.push([...queryKeys.inbox]);
  }
  if (runId !== null) {
    keys.push([...queryKeys.agents]);
  }
  if (data.worker_id !== undefined) {
    keys.push([...queryKeys.workers]);
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

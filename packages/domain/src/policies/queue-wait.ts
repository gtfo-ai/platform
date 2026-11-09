/**
 * **Why a queued task has not started, and what frees it** — the pure half of `queue_wait`
 * (S-25.16, BD-010), in the domain since S-25.20 so the server's read (`apps/server/src/queries/
 * queue-wait.ts`) and the web app's word tests (`apps/web/src/features/queue-words.test.ts`, the
 * S-25.16 review) build it through **one** function rather than a copy each.
 *
 * It is the scheduler's own question asked again: the counts of {@link wipCountsOf}, the decision of
 * {@link queueAdmissionOf}, the order of {@link orderQueue}, and the holders of {@link holdsPlace}.
 * The priority arrives already ranked (`priorityRankOf` is the application's, because "Highest" is
 * provider vocabulary the domain does not know).
 */
import {
  type Id,
  type IsoDateTime,
  MAX_QUEUE_WAIT_HOLDERS,
  type QueueWait,
  type TaskState,
} from '@platform/contracts';
import { holdsPlace, orderQueue, queueAdmissionOf, type WipLimits, wipCountsOf } from './wip.js';

/** One of the project's live tasks (not `done`, not `cancelled`), as the read selects it. */
export interface QueueLiveTask {
  readonly id: string;
  readonly state: TaskState;
  readonly ticketKey: string;
  /** Lower is more urgent — `priorityRankOf` over the ticket's priority. */
  readonly priorityRank: number;
  /** At the store's millisecond resolution, so ties break as the scheduler breaks them. */
  readonly createdAt: IsoDateTime;
}

/** Waiting-for-a-person first (what a reader can act on), then the oldest, then the id. */
const holderOrder = (a: QueueLiveTask, b: QueueLiveTask): number => {
  const human = Number(b.state === 'needs_human') - Number(a.state === 'needs_human');
  if (human !== 0) {
    return human;
  }
  const age = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  return age !== 0 ? age : a.id.localeCompare(b.id);
};

/**
 * The `queue_wait` of every **queued** task among `taskIds`, over the project's live tasks — keyed
 * by task id; a task that is not queued is absent (its `queue_wait` is `null`).
 */
export const queueWaitsOver = (
  live: readonly QueueLiveTask[],
  taskIds: readonly string[],
  limits: WipLimits,
): ReadonlyMap<string, QueueWait> => {
  const counts = wipCountsOf(live.map((task) => task.state));
  const admission = queueAdmissionOf(counts, limits);
  // Both limits, as the scheduler checks both on every event (review of #124): a reader that knew
  // only the refusing one would promise a start the other limit then refuses.
  const running = { count: counts.activeTasks, limit: limits.maxParallelTasks };
  const pipeline = { count: counts.tasksInPipeline, limit: limits.maxTasksInPipeline };
  const queue = orderQueue(
    live
      .filter((task) => task.state === 'queued')
      .map((task) => ({
        id: task.id as Id,
        priorityRank: task.priorityRank,
        createdAt: task.createdAt,
      })),
  );
  const position = new Map(queue.map((task, index) => [task.id as string, index + 1]));
  // The places a reader must see freed: the pipeline's whenever it is full (it holds the running
  // tasks too, and only a task that finishes or is cancelled leaves it), else the running ones.
  const basis = pipeline.count >= pipeline.limit ? 'max_tasks_in_pipeline' : 'max_parallel_tasks';
  const holders =
    admission.status === 'admitted'
      ? null
      : live.filter((task) => holdsPlace(basis, task.state)).sort(holderOrder);

  const answers = new Map<string, QueueWait>();
  for (const taskId of taskIds) {
    const at = position.get(taskId);
    if (at === undefined) {
      continue;
    }
    answers.set(
      taskId,
      admission.status === 'admitted' || holders === null
        ? { status: 'admitted', position: at, queued: queue.length, running, pipeline }
        : {
            status: 'waiting',
            reason: admission.reason,
            count: admission.count,
            limit: admission.limit,
            position: at,
            queued: queue.length,
            running,
            pipeline,
            holders: {
              total: holders.length,
              needs_human: holders.filter((task) => task.state === 'needs_human').length,
              items: holders.slice(0, MAX_QUEUE_WAIT_HOLDERS).map((task) => ({
                task_id: task.id as Id,
                ticket_key: task.ticketKey,
                state: task.state,
              })),
            },
          },
    );
  }
  return answers;
};

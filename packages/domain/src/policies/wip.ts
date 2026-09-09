/**
 * WIP limits — BD-010 and product/09 § "Concurrency limits (WIP)".
 *
 * "Per project: `max_parallel_tasks` (default 2), `max_tasks_in_pipeline` (default 5, i.e.
 * including waiting ones), `max_parallel_runs` per organisation (default 4, protects against rate
 * limits). Tasks beyond limits wait in `Queued` ordered by ticket priority then age. Limits exist
 * to keep review load humane, not only to protect spend."
 */
import type { Id, IsoDateTime, TaskState } from '@platform/contracts';

export interface WipLimits {
  /** Project: tasks actively moving through stages. */
  readonly maxParallelTasks: number;
  /** Project: tasks in the pipeline at all, waiting ones included. */
  readonly maxTasksInPipeline: number;
  /** Organisation: concurrent runs, which is what the provider rate-limits. */
  readonly maxParallelRuns: number;
}

export const DEFAULT_WIP_LIMITS = {
  maxParallelTasks: 2,
  maxTasksInPipeline: 5,
  maxParallelRuns: 4,
} as const satisfies WipLimits;

/** States in which a task occupies a `max_parallel_tasks` slot: it is moving right now. */
const ACTIVE_TASK_STATES: ReadonlySet<TaskState> = new Set<TaskState>(['active', 'returned']);

/** States that do not occupy a pipeline slot: not started yet, or finished. */
const OUT_OF_PIPELINE_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  'queued',
  'done',
  'cancelled',
]);

export const countsAsActive = (state: TaskState): boolean => ACTIVE_TASK_STATES.has(state);

export const countsInPipeline = (state: TaskState): boolean => !OUT_OF_PIPELINE_STATES.has(state);

export type WipRejection = 'max_parallel_tasks' | 'max_tasks_in_pipeline' | 'max_parallel_runs';

export type WipDecision =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly reason: WipRejection; readonly limit: number };

/**
 * May a queued task start? Counting is the caller's job — it holds the project's task list — so
 * this function stays pure and cheap enough to call on every scheduler tick.
 */
export const evaluateTaskAdmission = (
  counts: { readonly activeTasks: number; readonly tasksInPipeline: number },
  limits: WipLimits = DEFAULT_WIP_LIMITS,
): WipDecision => {
  if (counts.activeTasks >= limits.maxParallelTasks) {
    return { admitted: false, reason: 'max_parallel_tasks', limit: limits.maxParallelTasks };
  }
  if (counts.tasksInPipeline >= limits.maxTasksInPipeline) {
    return { admitted: false, reason: 'max_tasks_in_pipeline', limit: limits.maxTasksInPipeline };
  }
  return { admitted: true };
};

/** May another run start anywhere in the organisation? */
export const evaluateRunAdmission = (
  counts: { readonly activeRuns: number },
  limits: WipLimits = DEFAULT_WIP_LIMITS,
): WipDecision =>
  counts.activeRuns >= limits.maxParallelRuns
    ? { admitted: false, reason: 'max_parallel_runs', limit: limits.maxParallelRuns }
    : { admitted: true };

/**
 * A queued task as the scheduler sees it. `priorityRank` is normalised by the task-management
 * adapter (lower is more urgent) because "Highest"/"P1"/"Critical" are provider vocabulary and
 * the domain does not know any provider.
 */
export interface QueuedTask {
  readonly id: Id;
  readonly priorityRank: number;
  readonly createdAt: IsoDateTime;
}

/** Queue order: ticket priority first, then age, then id so the order is total and stable. */
export const compareQueuedTasks = (a: QueuedTask, b: QueuedTask): number => {
  if (a.priorityRank !== b.priorityRank) {
    return a.priorityRank - b.priorityRank;
  }
  const byAge = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  return byAge !== 0 ? byAge : a.id.localeCompare(b.id);
};

/** The queue in the order the scheduler should admit from. */
export const orderQueue = (tasks: readonly QueuedTask[]): readonly QueuedTask[] =>
  [...tasks].sort(compareQueuedTasks);

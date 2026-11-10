/**
 * WIP limits — BD-010 and product/09 § "Concurrency limits (WIP)".
 *
 * "Per project: `max_parallel_tasks` (default 2), `max_tasks_in_pipeline` (default 5, i.e.
 * including waiting ones), `max_parallel_runs` per organisation (default 4, protects against rate
 * limits). Tasks beyond limits wait in `Queued` ordered by ticket priority then age. Limits exist
 * to keep review load humane, not only to protect spend."
 */
import type { Id, IsoDateTime, TaskState, WipLimitsConfig } from '@platform/contracts';

export interface WipLimits {
  /** Project: tasks actively moving through stages. */
  readonly maxParallelTasks: number;
  /** Project: tasks in the pipeline at all, waiting ones included. */
  readonly maxTasksInPipeline: number;
  /** Organisation: concurrent runs, which is what the provider rate-limits. */
  readonly maxParallelRuns: number;
  /**
   * A person: their owned tasks in flight at once (S-28.6, the M28 ruling B) — the default a
   * person with no limit of their own is held to in this project ({@link countsTowardOwner}).
   */
  readonly maxTasksPerOwner: number;
  /**
   * The highest limit a person may set for themself (or an administrator for them): the
   * organisation's stated `max_tasks_per_owner`, else the schema's bound (S-28.6).
   */
  readonly ownerLimitMaximum: number;
}

/** The schema's bound on a per-person limit — `MAX_WIP_TASKS_PER_OWNER` (S-28.6). */
export const TASKS_PER_OWNER_BOUND = 200;

export const DEFAULT_WIP_LIMITS = {
  maxParallelTasks: 2,
  maxTasksInPipeline: 5,
  maxParallelRuns: 4,
  maxTasksPerOwner: 3,
  ownerLimitMaximum: TASKS_PER_OWNER_BOUND,
} as const satisfies WipLimits;

/** A project limit the organisation's value lowered — reported, never applied in silence. */
export interface WipBound {
  readonly key:
    | 'pipeline.wip.max_parallel_tasks'
    | 'pipeline.wip.max_tasks_in_pipeline'
    | 'pipeline.wip.max_tasks_per_owner';
  /** What the project (or, when it states nothing, BD-010's default) asked for. */
  readonly stated: number;
  /** The organisation's value, which is what admission uses. */
  readonly bound: number;
}

/**
 * The WIP limits a project is admitted against — `pipeline.wip` (WP-91, backlog 224).
 *
 * The project's value where it states one, BD-010's default where it does not, and in either case
 * **never above the organisation's** (`organizations.settings.pipeline.wip`): the organisation's
 * value is a maximum, so a project can only tighten it (Q101's shape, one layer up). A lowered
 * organisation value therefore applies at the next read, and every limit it lowered is answered in
 * `bounded` so the effective-configuration view can say so rather than show a number nobody wrote.
 * `maxParallelRuns` is the organisation's own limit and stays BD-010's default (backlog 127).
 */
export const resolveWipLimits = (
  project: WipLimitsConfig | undefined,
  organisation: WipLimitsConfig | undefined,
): { readonly limits: WipLimits; readonly bounded: readonly WipBound[] } => {
  const bounded: WipBound[] = [];
  const pick = (
    key: WipBound['key'],
    stated: number | undefined,
    fallback: number,
    bound: number | undefined,
  ): number => {
    const wanted = stated ?? fallback;
    if (bound !== undefined && wanted > bound) {
      bounded.push({ key, stated: wanted, bound });
      return bound;
    }
    return wanted;
  };
  return {
    limits: {
      maxParallelTasks: pick(
        'pipeline.wip.max_parallel_tasks',
        project?.max_parallel_tasks,
        DEFAULT_WIP_LIMITS.maxParallelTasks,
        organisation?.max_parallel_tasks,
      ),
      maxTasksInPipeline: pick(
        'pipeline.wip.max_tasks_in_pipeline',
        project?.max_tasks_in_pipeline,
        DEFAULT_WIP_LIMITS.maxTasksInPipeline,
        organisation?.max_tasks_in_pipeline,
      ),
      maxParallelRuns: DEFAULT_WIP_LIMITS.maxParallelRuns,
      maxTasksPerOwner: pick(
        'pipeline.wip.max_tasks_per_owner',
        project?.max_tasks_per_owner,
        organisation?.max_tasks_per_owner ?? DEFAULT_WIP_LIMITS.maxTasksPerOwner,
        organisation?.max_tasks_per_owner,
      ),
      ownerLimitMaximum: organisation?.max_tasks_per_owner ?? TASKS_PER_OWNER_BOUND,
    },
    bounded,
  };
};

/**
 * **The limit one person is held to in a project** (S-28.6, the M28 ruling B): their own
 * `users.max_tasks_in_flight` when they set one — never above the organisation's value
 * ({@link WipLimits.ownerLimitMaximum}), which applies at the next read when lowered — else the
 * project's default ({@link WipLimits.maxTasksPerOwner}).
 */
export const ownerLimitOf = (limits: WipLimits, personal: number | null): number =>
  personal === null ? limits.maxTasksPerOwner : Math.min(personal, limits.ownerLimitMaximum);

/** States in which a task occupies a `max_parallel_tasks` slot: it is moving right now. */
const ACTIVE_TASK_STATES: ReadonlySet<TaskState> = new Set<TaskState>(['active', 'returned']);

/**
 * States that do not occupy a pipeline slot: not started yet, finished — and, since S-28.6 (the
 * owner's decision, the M28 ruling B), **stopped**: a `paused` task and one at `needs_human` wait
 * for a person to unblock them and hold no place. A task waiting for an answer or an approval
 * (`waiting_answers`, `waiting_approval`) still does.
 */
const OUT_OF_PIPELINE_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  'queued',
  'done',
  'cancelled',
  'paused',
  'needs_human',
]);

/** States in which an owned task counts toward its owner's limit (S-28.6, the M28 ruling B). */
const OWNER_COUNTED_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  'active',
  'returned',
  'waiting_answers',
  'waiting_approval',
]);

export const countsAsActive = (state: TaskState): boolean => ACTIVE_TASK_STATES.has(state);

export const countsInPipeline = (state: TaskState): boolean => !OUT_OF_PIPELINE_STATES.has(state);

/** Whether an owned task in `state` holds one of its owner's places (S-28.6). */
export const countsTowardOwner = (state: TaskState): boolean => OWNER_COUNTED_STATES.has(state);

/** The task states {@link countsTowardOwner} counts, as a list — what the SQL filters on. */
export const OWNER_COUNTED_TASK_STATES: readonly TaskState[] = [...OWNER_COUNTED_STATES];

/** The task states {@link countsInPipeline} leaves out, as a list — what the SQL filters on. */
export const OUT_OF_PIPELINE_TASK_STATES: readonly TaskState[] = [...OUT_OF_PIPELINE_STATES];

/**
 * **May a person's queued task start?** (S-28.6) — their tasks in flight against their limit.
 * Unowned tasks never ask it.
 */
export const ownerAdmits = (inFlight: number, limit: number): boolean => inFlight < limit;

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

/** The two counts {@link evaluateTaskAdmission} reads, over a project's task states (BD-010). */
export interface WipCounts {
  readonly activeTasks: number;
  readonly tasksInPipeline: number;
}

/**
 * The counts the store's `TaskRepository.counts` answers, as a function of the project's task
 * states — the same two predicates ({@link countsAsActive}, {@link countsInPipeline}), so a reader
 * that holds the states counts what the scheduler counts (S-25.16).
 */
export const wipCountsOf = (states: Iterable<TaskState>): WipCounts => {
  let activeTasks = 0;
  let tasksInPipeline = 0;
  for (const state of states) {
    if (countsAsActive(state)) {
      activeTasks += 1;
    }
    if (countsInPipeline(state)) {
      tasksInPipeline += 1;
    }
  }
  return { activeTasks, tasksInPipeline };
};

/** The project limit a queued task waits behind — the two {@link evaluateTaskAdmission} refuses. */
export type QueueWaitReason = 'max_parallel_tasks' | 'max_tasks_in_pipeline';

/**
 * **Why a queued task has not started** (S-25.16): the scheduler's own admission
 * ({@link evaluateTaskAdmission}) over the same counts and the same resolved limits, with the count
 * it compared. `admitted` is the honest third state — the limits have room and the scheduler has
 * not run since (it runs whenever a place may have freed, S-25.21) — never a guess at a wait.
 */
export type QueueAdmission =
  | { readonly status: 'admitted' }
  | {
      readonly status: 'waiting';
      readonly reason: QueueWaitReason;
      /** The count the limit was compared with: active tasks, or tasks in the pipeline. */
      readonly count: number;
      readonly limit: number;
    };

export const queueAdmissionOf = (
  counts: WipCounts,
  limits: WipLimits = DEFAULT_WIP_LIMITS,
): QueueAdmission => {
  const decision = evaluateTaskAdmission(counts, limits);
  if (decision.admitted) {
    return { status: 'admitted' };
  }
  switch (decision.reason) {
    case 'max_parallel_tasks':
      return {
        status: 'waiting',
        reason: decision.reason,
        count: counts.activeTasks,
        limit: decision.limit,
      };
    case 'max_tasks_in_pipeline':
      return {
        status: 'waiting',
        reason: decision.reason,
        count: counts.tasksInPipeline,
        limit: decision.limit,
      };
    default:
      // Deliberately unreachable: `evaluateTaskAdmission` refuses on the two project limits only;
      // `max_parallel_runs` is `evaluateRunAdmission`'s. Thrown rather than read as a wait.
      throw new Error(`task admission refused on ${decision.reason}, which it never decides`);
  }
};

/** Whether a task in `state` holds one of the places `reason` counts (S-25.16). */
export const holdsPlace = (reason: QueueWaitReason, state: TaskState): boolean =>
  reason === 'max_parallel_tasks' ? countsAsActive(state) : countsInPipeline(state);

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
  /** The task's owner (S-26.1), `null` for nobody — what the per-person limit asks (S-28.6). */
  readonly ownerUserId?: Id | null;
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

/**
 * **Why a queued task has not started, and what frees it** — `queue_wait` (S-25.16, BD-010).
 *
 * On the Autix core (2026-11-09) five tickets sat *Queued* for 1½–3½ days with no run, because the
 * five tasks at *Needs you* filled `max_tasks_in_pipeline` (5) — a stopped task holds a pipeline
 * place (`countsInPipeline`) — and no screen said so. This read is the scheduler's own question
 * asked again at read time, never stored:
 *
 *  - **the same counts** — the project's task states through `wipCountsOf`, the two predicates the
 *    store's `TaskRepository.counts` filters on (`state in ('active','returned')` and
 *    `state not in ('queued','done','cancelled')`, held to it by the integration test);
 *  - **the same limits** — `ProjectSettings.wip` from the settings port the scheduler is given
 *    (`settings.forProject`), so the organisation's bound and a refused configuration's floor apply
 *    here exactly as they do to admission;
 *  - **the same decision** — `queueAdmissionOf`, which is `evaluateTaskAdmission` with the count it
 *    compared; and **the same order** — `orderQueue` over the rank the store reads
 *    (`priorityRankOf`) and the age at the store's millisecond resolution.
 *
 * One statement per project read (the project's live tasks), plus the settings read, and only when
 * the page holds a queued task: never one per item. A queued task the limits would admit now answers
 * `admitted` — the scheduler runs when a task leaves the active set, and none has since.
 */
import { priorityRankOf } from '@platform/application';
import {
  type Id,
  type IsoDateTime,
  MAX_QUEUE_WAIT_HOLDERS,
  type QueueWait,
  type TaskState,
} from '@platform/contracts';
import {
  holdsPlace,
  orderQueue,
  queueAdmissionOf,
  type WipLimits,
  wipCountsOf,
} from '@platform/domain';
import { db as dbAdapters } from '@platform/infrastructure';
import { and, eq, notInArray } from 'drizzle-orm';

type Database = dbAdapters.Database;
const { tasks } = dbAdapters.schema;

/**
 * The limits a project is admitted against — `ProjectSettings.wip`, read through the scheduler's
 * own settings port by the composition (`app.ts`). A test hands a fixed one.
 */
export type WipLimitsReader = (projectId: string) => Promise<WipLimits>;

/** The states no limit counts, and the only ones this read need not fetch. */
const FINISHED_STATES: readonly TaskState[] = ['done', 'cancelled'];

interface LiveTask {
  readonly id: string;
  readonly state: TaskState;
  readonly ticketKey: string;
  readonly priority: string | null;
  readonly createdAt: Date;
}

/** Waiting-for-a-person first (what a reader can act on), then the oldest, then the id. */
const holderOrder = (a: LiveTask, b: LiveTask): number => {
  const human = Number(b.state === 'needs_human') - Number(a.state === 'needs_human');
  if (human !== 0) {
    return human;
  }
  const age = a.createdAt.getTime() - b.createdAt.getTime();
  return age !== 0 ? age : a.id.localeCompare(b.id);
};

/**
 * The `queue_wait` of every **queued** task among `taskIds`, all of project `projectId` — keyed by
 * task id; a task that is not queued at this read is absent (its `queue_wait` is `null`). Nothing is
 * read when `taskIds` is empty.
 */
export const queueWaitsFor = async (
  database: Database,
  projectId: string,
  taskIds: readonly string[],
  wipLimits: WipLimitsReader,
): Promise<ReadonlyMap<string, QueueWait>> => {
  if (taskIds.length === 0) {
    return new Map();
  }
  const [limits, rows] = await Promise.all([
    wipLimits(projectId),
    database
      .select({
        id: tasks.id,
        state: tasks.state,
        ticketKey: tasks.ticketKey,
        priority: tasks.priority,
        createdAt: tasks.createdAt,
      })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), notInArray(tasks.state, [...FINISHED_STATES]))),
  ]);
  return queueWaitsOf(rows, taskIds, limits);
};

/** The pure half of {@link queueWaitsFor}, over the project's live tasks. Exported for its test. */
export const queueWaitsOf = (
  live: readonly LiveTask[],
  taskIds: readonly string[],
  limits: WipLimits,
): ReadonlyMap<string, QueueWait> => {
  const admission = queueAdmissionOf(wipCountsOf(live.map((task) => task.state)), limits);
  const queue = orderQueue(
    live
      .filter((task) => task.state === 'queued')
      .map((task) => ({
        id: task.id as Id,
        priorityRank: priorityRankOf(task.priority),
        // The store's resolution (`queued` reads `created_at` into a `Date`), so ties break alike.
        createdAt: task.createdAt.toISOString() as IsoDateTime,
      })),
  );
  const position = new Map(queue.map((task, index) => [task.id as string, index + 1]));
  const holders =
    admission.status === 'admitted'
      ? null
      : live.filter((task) => holdsPlace(admission.reason, task.state)).sort(holderOrder);

  const answers = new Map<string, QueueWait>();
  for (const taskId of taskIds) {
    const at = position.get(taskId);
    if (at === undefined) {
      continue;
    }
    answers.set(
      taskId,
      admission.status === 'admitted' || holders === null
        ? { status: 'admitted', position: at, queued: queue.length }
        : {
            status: 'waiting',
            reason: admission.reason,
            count: admission.count,
            limit: admission.limit,
            position: at,
            queued: queue.length,
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

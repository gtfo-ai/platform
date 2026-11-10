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
 * `admitted` — the scheduler has not run since a place freed (since S-25.21 it runs whenever one may
 * have: a task leaving the active set, a WIP limit raised).
 *
 * **Which limit binds** (S-25.21): `organisation_bound` says the refusing limit is the
 * organisation's maximum — `resolveWipLimits`' `bounded`, carried on the settings port's
 * `wipBounded` — so the page does not send the reader to a project value that would change nothing.
 */
import { priorityRankOf } from '@platform/application';
import type { IsoDateTime, QueueWait, TaskState } from '@platform/contracts';
import {
  OWNER_COUNTED_TASK_STATES,
  ownerLimitOf,
  type QueueOwnerLoad,
  queueWaitsOver,
  type WipBound,
  type WipLimits,
} from '@platform/domain';
import { db as dbAdapters } from '@platform/infrastructure';
import { and, eq, inArray, notInArray } from 'drizzle-orm';

type Database = dbAdapters.Database;
const { tasks, users } = dbAdapters.schema;

/**
 * The limits a project is admitted against — `ProjectSettings.wip`, read through the scheduler's
 * own settings port by the composition (`app.ts`) — with the keys of those the organisation's
 * maximum lowered (`ProjectSettings.wipBounded`, S-25.21). A test hands a fixed one.
 */
export type WipLimitsReader = (projectId: string) => Promise<WipLimitsInForce>;

export interface WipLimitsInForce {
  readonly limits: WipLimits;
  /** The limits the organisation's maximum lowered — `resolveWipLimits`' `bounded`, by key. */
  readonly bounded: readonly WipBound['key'][];
}

/** The states no limit counts, and the only ones this read need not fetch. */
const FINISHED_STATES: readonly TaskState[] = ['done', 'cancelled'];

interface LiveTask {
  readonly id: string;
  readonly state: TaskState;
  readonly ticketKey: string;
  readonly priority: string | null;
  readonly createdAt: Date;
}

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
  const [inForce, rows] = await Promise.all([
    wipLimits(projectId),
    database
      .select({
        id: tasks.id,
        state: tasks.state,
        ticketKey: tasks.ticketKey,
        priority: tasks.priority,
        createdAt: tasks.createdAt,
        ownerUserId: tasks.ownerUserId,
      })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), notInArray(tasks.state, [...FINISHED_STATES]))),
  ]);
  const owners = await ownerLoadsFor(database, rows, taskIds, inForce.limits);
  return queueWaitsOf(rows, taskIds, inForce.limits, inForce.bounded, owners);
};

/**
 * **Each asked queued task's owner and their load** (S-28.6, the M28 ruling B): the person's tasks
 * in flight in **every** project (`countsTowardOwner`, as `TaskRepository.ownerAdmission` counts),
 * their own `users.max_tasks_in_flight`, and their name — one statement per distinct owner. An
 * unowned task is absent.
 */
const ownerLoadsFor = async (
  database: Database,
  live: readonly (LiveTask & { readonly ownerUserId: string | null })[],
  taskIds: readonly string[],
  limits: WipLimits,
): Promise<ReadonlyMap<string, QueueOwnerLoad>> => {
  const asked = new Set(taskIds);
  const ownerOf = new Map(
    live
      .filter((task) => task.state === 'queued' && asked.has(task.id) && task.ownerUserId !== null)
      .map((task) => [task.id, task.ownerUserId as string]),
  );
  const loads = new Map<string, QueueOwnerLoad>();
  for (const userId of new Set(ownerOf.values())) {
    const [person] = await database
      .select({ name: users.name, personal: users.maxTasksInFlight })
      .from(users)
      .where(eq(users.id, userId));
    if (person === undefined) continue;
    const held = await database
      .select({
        id: tasks.id,
        state: tasks.state,
        ticketKey: tasks.ticketKey,
        createdAt: tasks.createdAt,
      })
      .from(tasks)
      .where(
        and(eq(tasks.ownerUserId, userId), inArray(tasks.state, [...OWNER_COUNTED_TASK_STATES])),
      );
    loads.set(userId, {
      userId,
      // Shown to anyone who reads the project: a name, never an email address.
      name: person.name.trim() === '' ? 'the owner' : person.name,
      count: held.length,
      limit: ownerLimitOf(limits, person.personal),
      holders: held.map((task) => ({
        id: task.id,
        state: task.state,
        ticketKey: task.ticketKey,
        priorityRank: 0,
        createdAt: task.createdAt.toISOString() as IsoDateTime,
      })),
    });
  }
  return new Map(
    [...ownerOf].flatMap(([taskId, userId]) => {
      const load = loads.get(userId);
      return load === undefined ? [] : [[taskId, load] as const];
    }),
  );
};

/**
 * The pure half of {@link queueWaitsFor}, over the project's live tasks: the ticket's priority
 * ranked as the scheduler ranks it, then the domain's `queueWaitsOver` — the one function the web
 * app's word tests build `queue_wait` through too (S-25.20). Exported for its test.
 */
export const queueWaitsOf = (
  live: readonly LiveTask[],
  taskIds: readonly string[],
  limits: WipLimits,
  bounded: readonly WipBound['key'][] = [],
  owners: ReadonlyMap<string, QueueOwnerLoad> = new Map(),
): ReadonlyMap<string, QueueWait> =>
  queueWaitsOver(
    live.map((task) => ({
      id: task.id,
      state: task.state,
      ticketKey: task.ticketKey,
      priorityRank: priorityRankOf(task.priority),
      // The store's resolution (`queued` reads `created_at` into a `Date`), so ties break alike.
      createdAt: task.createdAt.toISOString() as IsoDateTime,
    })),
    taskIds,
    limits,
    bounded,
    owners,
  );

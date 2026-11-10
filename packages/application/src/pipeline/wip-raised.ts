/**
 * **A raised WIP limit starts the queue** (S-25.21, BACKLOG 1369, BD-010).
 *
 * The scheduler (`saga.ts`'s `pipeline.scheduler`) is an event handler, so a place that opens
 * without an event starts nothing: before this, an administrator who raised `max_parallel_tasks`
 * from 2 to 3 saw the queued task read *a place is free* until some unrelated task finished. The two
 * writes that can raise a limit in force — `PUT /api/projects/:id/config` and `PATCH /api/org` —
 * therefore append a `config.changed` on the project's stream for every project whose limit **in
 * force** rose, and the scheduler subscribes to it.
 *
 * ## What it records, and what it does not
 *
 *  - **Only a raise.** {@link raisedWipLimits} compares the limits admission used before the write
 *    with the ones it uses after — `ProjectSettings.wip`, the organisation's bound applied — so a
 *    write that changed nothing in force, or lowered a limit, appends nothing. A lowered limit frees
 *    no place, and it is the scheduler's next admission that applies it.
 *  - **After the write has committed**, in a transaction of its own on the project stream
 *    ({@link appendOnProjectWithRetry}): the configuration writes are plain database writes that
 *    hold no event store. The residual is stated rather than hidden — a process that dies between
 *    the two leaves the queued task at *a place is free* until the next event the scheduler hears,
 *    which is exactly the state before S-25.21, and never a task started past a limit.
 *  - **The values are platform numbers**, the in-force limits as decimal strings; nothing a caller
 *    typed reaches the payload beyond those two integers, so there is nothing to redact.
 */
import type { Actor, Id, IsoDateTime } from '@platform/contracts';
import { configChangedEvent } from '@platform/contracts';
import type { WipLimits } from '@platform/domain';
import type { Logger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { appendOnProjectWithRetry } from './project-stream.js';

/** One limit in force that a write raised. */
export interface WipRaise {
  readonly key:
    | 'pipeline.wip.max_parallel_tasks'
    | 'pipeline.wip.max_tasks_in_pipeline'
    | 'pipeline.wip.max_tasks_per_owner';
  readonly from: number;
  readonly to: number;
}

const WIP_FIELDS = [
  ['pipeline.wip.max_parallel_tasks', 'maxParallelTasks'],
  ['pipeline.wip.max_tasks_in_pipeline', 'maxTasksInPipeline'],
  // S-28.6: the per-person default, and — when only the maximum rose — the ceiling a person's own
  // limit is held under, both said as the one key (the first that rose).
  ['pipeline.wip.max_tasks_per_owner', 'maxTasksPerOwner'],
  ['pipeline.wip.max_tasks_per_owner', 'ownerLimitMaximum'],
] as const;

/** The project limits in force that rose from `before` to `after`; empty when none did. */
export const raisedWipLimits = (before: WipLimits, after: WipLimits): WipRaise[] => {
  const raised: WipRaise[] = [];
  for (const [key, field] of WIP_FIELDS) {
    if (after[field] > before[field] && !raised.some((one) => one.key === key)) {
      raised.push({ key, from: before[field], to: after[field] });
    }
  }
  return raised;
};

export interface WipRaisedDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly ids: { next(): Id };
  readonly clock: { now(): string };
  readonly logger?: Logger;
}

/** The port the configuration routes call once their write has committed. */
export interface WipRaisedRecorder {
  record(input: {
    readonly projectId: Id;
    /** Which layer the write changed: the project's settings, or the organisation's maximum. */
    readonly scope: 'project' | 'org';
    readonly raised: readonly WipRaise[];
    readonly actor: Actor;
  }): Promise<void>;
}

/**
 * Appends one `config.changed` for a project whose limits `raised` names — nothing for an empty
 * list. Refuses to run inside an open transaction, as every project-stream append does.
 */
export const createWipRaisedRecorder = (
  dependencies: WipRaisedDependencies,
): WipRaisedRecorder => ({
  record: async (input) => {
    if (input.raised.length === 0) {
      return;
    }
    await appendOnProjectWithRetry(
      {
        unitOfWork: dependencies.unitOfWork,
        ...(dependencies.logger === undefined ? {} : { logger: dependencies.logger }),
      },
      { projectId: input.projectId, writer: 'wip_raised' },
      async (scope, streamSeq) => {
        await scope.events.append([
          configChangedEvent.parse({
            id: dependencies.ids.next(),
            stream_type: 'project',
            stream_id: input.projectId,
            stream_seq: streamSeq,
            correlation_id: null,
            cause_event_id: null,
            actor: input.actor,
            occurred_at: dependencies.clock.now() as IsoDateTime,
            type: 'config.changed',
            payload: {
              project_id: input.projectId,
              scope: input.scope,
              scope_id: null,
              diff: input.raised.map((raise) => ({
                key: raise.key,
                from: String(raise.from),
                to: String(raise.to),
              })),
            },
          }),
        ]);
      },
    );
  },
});

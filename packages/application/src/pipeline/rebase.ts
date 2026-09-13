/**
 * The rebase gate's bookkeeping — WP-26, BD-030, product/04 S6b.
 *
 * The **gate** itself is `gates.ts` (it reads `has_conflicts` and says pass, fail or not-yet), the
 * **resolution** is a stage of the template (`CONFLICT_RESOLUTION_STAGE`, whose docblock in
 * `packages/domain/src/pipeline/templates.ts` carries the argument for a run rather than a provider
 * call), and the **conflict warning** is `conflict-warning.ts`. What is here is the gate's two stage
 * ids and its measurement: `task.rebase.checked`, product/16's *"conflicts auto-resolved vs
 * escalated"*, appended once per settlement by the job that settled it.
 *
 * It is a module of its own rather than a corner of `conflict-warning.ts` because `jobs.ts` imports
 * it: a duty module imports `jobs.ts` for `enqueueOutbound`, so anything `jobs.ts` needs back has to
 * sit where the import does not return (PROGRESS backlog 21 — this repository has paid for one
 * module-graph cycle already).
 */
import type { Id, MergeRequestRef } from '@platform/contracts';
import { buildEvent } from '@platform/domain';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import type { PipelineSagaOptions } from './saga.js';
import { PIPELINE_ACTOR } from './store.js';

/** The gate product/04 S6b is about; `BUILTIN_GATE_STAGE_IDS` names it too. */
export const REBASE_GATE_STAGE = 'rebase_gate';

/**
 * The id of the stage a failed rebase gate enters.
 *
 * The **stage** is `CONFLICT_RESOLUTION_STAGE` in `packages/domain/src/pipeline/templates.ts`, which
 * is a `Stage` *value* spliced into the three ticket templates; this is its id, named here so the
 * application ring's least-privilege table (`PLATFORM_TOOLS_DENIED_BY_STAGE`) can key on it without
 * reaching into template data for a string. `templates.test.ts` holds the two together by asserting
 * the stage's position in every ticket template, and a mismatch would show up there as a stage the
 * gate's `fail_to` does not name.
 */
export const CONFLICT_RESOLUTION_STAGE = 'conflict_resolution';

/**
 * The rebase gate's outcome, as product/16 counts it.
 *
 * Derived from *the snapshot the gate read* and the bounded loop as it stood, which is why it is a
 * pure function taking both: the same two facts the gate's own transition is decided from, so the
 * event cannot disagree with the transition it describes.
 */
export type RebaseOutcome = 'clean' | 'resolved' | 'conflicted' | 'exhausted';

export const rebaseOutcomeFor = (input: {
  readonly conflicts: boolean;
  /** `iteration_counters.rebase` — conflict-resolution runs already spent on this task. */
  readonly attempts: number;
  /** `limits.rebase` — the ceiling `returnToStage` will enforce. */
  readonly limit: number;
}): RebaseOutcome => {
  if (!input.conflicts) {
    return input.attempts > 0 ? 'resolved' : 'clean';
  }
  return input.attempts < input.limit ? 'conflicted' : 'exhausted';
};

export interface RebaseJobOptions extends PipelineSagaOptions {
  readonly unitOfWork: UnitOfWork;
}

/**
 * Appends `task.rebase.checked` — the metric, in its own transaction after the gate settled.
 *
 * **Its own transaction, and after**, for the reason `runReviewOnlyObservation` re-loads before it
 * appends: `stream_seq` is `event_streams.last_seq + 1` and the settlement has just written the
 * transition's events, so the sequence has to be read where the append happens. The task is
 * re-loaded for that and for nothing else — the *content* is the check the gate made, which is
 * decided by the caller from the snapshot the gate evaluated.
 *
 * A lost wake-up costs one row of a statistic, which is the fail-open direction for a notification
 * (standing rule 20); a duplicate appends a second identical row, which a consumer deduplicates on
 * `(task_id, mr.head_sha, attempt)` exactly as `task.review.observed` asks it to.
 */
export const recordRebaseCheck = async (
  options: RebaseJobOptions,
  input: {
    readonly taskId: Id;
    readonly mr: MergeRequestRef;
    readonly conflicts: boolean;
    readonly attempts: number;
    readonly limit: number;
    readonly causeEventId: Id | null;
  },
): Promise<void> => {
  const outcome = rebaseOutcomeFor(input);
  await options.unitOfWork.transaction(async (scope) => {
    const current = await options.store.tasks.load(scope.tx, input.taskId);
    if (current === null) {
      return;
    }
    await scope.events.append([
      buildEvent(
        'task.rebase.checked',
        {
          project_id: current.task.projectId,
          task_id: current.task.id,
          mr: input.mr,
          conflicts: input.conflicts,
          attempt: input.attempts,
          outcome,
        },
        {
          streamType: 'task',
          streamId: current.task.id,
          streamSeq: current.task.sequence,
        },
        {
          ids: options.ids,
          actor: PIPELINE_ACTOR,
          clock: options.clock as never,
          correlationId: current.task.id,
          causeEventId: input.causeEventId,
        },
      ),
    ]);
  });
};

/**
 * **A step that decides a task's next transition or policy from the project's settings refuses to
 * decide on the defaults** — WP-106, PROGRESS backlogs 311 and 354, review round 1.
 *
 * Since WP-106 the settings port answers a stored configuration this release cannot parse as
 * `ProjectSettings.configRefusal`, and the unreadable layer contributes nothing. That is safe for a
 * reader that only reports (a notification, the status mapping), and it is **not** safe for one that
 * decides where a task goes next. The reviewer measured it: a plan-approval gate that read the
 * defaults let an Autonomous project with `plan_approval: 'always'` reach `ready_for_merge` without
 * an approval, and nothing asked the gate again after the document was fixed. So every such step
 * **parks the task by name instead**, in the state whose whole meaning is *a human must act*. It
 * parks with the outcome `settings_config_invalid` on the attempt and the refusal's own sentence
 * (key paths, redacted and bounded values, the write that fixes them) in the brief. A person
 * resumes it after the fix, and the step is then asked again on the parsed document.
 *
 * Two spellings, one ending: {@link escalateForConfigRefusalInHandler} for an event handler, which
 * owns no transaction (the bus does, and re-runs the handler on a conflict), and
 * {@link escalateForConfigRefusal} for a job, which owns its own on the conflict bound, as
 * `escalateTaskAfterConflict` does.
 */
import type { DomainEvent, Id } from '@platform/contracts';
import type { CommandContext } from '@platform/domain';
import { escalateTask, IllegalTransitionError } from '@platform/domain';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { Transaction } from '../ports/transaction.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { REFREEZE_PENDING_SENTENCE } from './refreeze.js';
import { PIPELINE_ACTOR, type PipelineStore, type StoredTask } from './store.js';
import { type ConflictEscalationOptions, retryOnTaskConflict } from './task-conflict.js';
import { closeParkedStageRow } from './transitions.js';

/** The brief a person reads: what was not decided, why, and what to do. */
const briefFor = (stored: StoredTask, refusal: string, what: string): string =>
  `The platform did not decide ${what} for ${stored.task.ticket.key}, because the project's ` +
  `configuration could not be read: ${refusal}. Nothing was decided on the platform's defaults. ` +
  'Correct the configuration, then resume the task from its page; the step is asked again on the ' +
  'corrected configuration.' +
  (stored.settingsRefreezePending === true ? ` ${REFREEZE_PENDING_SENTENCE}.` : '');

const escalation = (stored: StoredTask, refusal: string, what: string, context: CommandContext) =>
  escalateTask(
    stored.task,
    {
      reason: `${what} was not decided, because ${refusal}`,
      blockerBrief: briefFor(stored, refusal, what),
    },
    context,
  );

/**
 * Parks the task from inside an event handler's transaction. Returns `false` (and writes nothing)
 * for a task that has already finished, which cannot be escalated and has nothing left to decide.
 */
export const escalateForConfigRefusalInHandler = async (
  input: {
    readonly store: PipelineStore;
    readonly tx: Transaction;
    readonly emit: (events: readonly DomainEvent[]) => Promise<void>;
    readonly context: CommandContext;
  },
  stored: StoredTask,
  refusal: string,
  what: string,
): Promise<boolean> => {
  try {
    const escalated = escalation(stored, refusal, what, input.context);
    await input.store.tasks.save(input.tx, { ...stored, task: escalated.aggregate });
    await closeParkedStageRow(input.store, input.tx, escalated, 'settings_config_invalid');
    await input.emit(escalated.events);
    return true;
  } catch (error) {
    if (error instanceof IllegalTransitionError) {
      return false;
    }
    throw error;
  }
};

/**
 * Parks the task in a transaction of the job's own, on the conflict bound. A task that is no
 * longer runnable (already parked, finished) is left as it is and logged.
 */
export const escalateForConfigRefusal = async (
  options: ConflictEscalationOptions,
  input: { readonly taskId: Id; readonly refusal: string; readonly what: string },
): Promise<void> => {
  const logger: Logger = options.logger ?? silentLogger;
  await retryOnTaskConflict(
    {
      taskId: input.taskId,
      what: `parking a task whose configuration could not be read (${input.what})`,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    },
    async () =>
      options.unitOfWork.transaction(async (scope) => {
        const stored = await options.store.tasks.load(scope.tx, input.taskId);
        if (stored === null) {
          return;
        }
        const parked = await escalateForConfigRefusalInHandler(
          {
            store: options.store,
            tx: scope.tx,
            emit: async (events) => {
              await scope.events.append(events);
            },
            context: options.context(stored.task.id),
          },
          stored,
          input.refusal,
          input.what,
        );
        if (!parked) {
          logger.warn(
            { task_id: stored.task.id, state: stored.task.state, what: input.what },
            'the project configuration could not be read and the task cannot be escalated from its state; nothing was decided',
          );
        }
      }),
  );
};

/** What a `pipeline.outbound` duty holds that {@link parkForConfigRefusal} needs. */
export interface ConfigRefusalJobOptions {
  readonly unitOfWork: UnitOfWork;
  readonly store: PipelineStore;
  readonly ids: CommandContext['ids'];
  readonly clock: { now(): string };
  readonly logger?: Logger;
}

/**
 * {@link escalateForConfigRefusal} for a duty that holds the saga's options, with the pipeline's
 * own actor (the context `escalateTaskAfterConflict`'s callers build).
 */
export const parkForConfigRefusal = async (
  options: ConfigRefusalJobOptions,
  input: { readonly taskId: Id; readonly refusal: string; readonly what: string },
): Promise<void> =>
  escalateForConfigRefusal(
    {
      unitOfWork: options.unitOfWork,
      store: options.store,
      context: (taskId) => ({
        ids: options.ids,
        actor: PIPELINE_ACTOR,
        clock: options.clock as CommandContext['clock'],
        correlationId: taskId,
        causeEventId: null,
      }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    },
    input,
  );

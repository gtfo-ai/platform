/**
 * What a poisoned event does to its task (WP-49, PROGRESS backlog 43; Q59's answer, reused).
 *
 * The dispatcher's half is a bound: an event whose handler fails
 * {@link DEFAULT_MAX_DISPATCH_ATTEMPTS} times leaves the queue into a terminal state and its stream
 * moves on (`events/event-bus.ts`). That is the half that stops the damage, and on its own it would
 * leave **a task that stops moving with no error on it** — the symptom PROGRESS backlog 43 names,
 * and the one standing rule 79's measurement produced from an entirely different cause, which is why
 * a second producer of it is worth closing. This module is the other half: the task is parked in
 * `needs_human` with a brief that says which event and which handler, exactly as
 * {@link escalateTaskAfterConflict} does for a write that lost every race. **No new task state and no new escalation vocabulary** — the
 * plan's row says so, Q59 refused a third spelling of "stuck", and every screen, template and
 * `retry-stage` command already knows this one.
 *
 * ## Which task
 *
 * `stream_id` when the event is on a **task** stream, and `correlation_id` otherwise — which
 * technical/03 defines as *"the task the event belongs to, for cross-stream correlation"*, so a
 * poisoned `run.finished` or `question.answered` parks the task it is about rather than nothing. A
 * candidate that is not a task id loads no row, which is the same ending as no candidate at all.
 *
 * **An event with no task has an ending too, and it is deliberately quiet**: the dead letter itself
 * stands (the event is out of the queue, the row records the handler, `event_dispatch_dead_lettered`
 * counts it and the bus logged an error naming it), and nothing is escalated, because there is no
 * task to park and inventing one would put a maintenance fault in a human's work queue. An
 * organisation-scoped or project-scoped event that keeps failing is an **operator's** problem, and
 * the metric is what tells them.
 *
 * ## What the brief may say
 *
 * The event position, its type and the handler's name — all three are the platform's own strings.
 * **Never the handler's error message**, for the reason `stage-executor.ts` states at the other
 * escalation Q59 answers: an error may quote a provider, a URL or a credential, and nothing on this
 * path holds a redactor (BD-022, TD-012). The message is on `event_dispatch.error` and in the log,
 * both of which an operator reads and neither of which the API serves.
 *
 * ## It runs inside the dispatcher's transaction
 *
 * So the escalation and the dead letter commit together — see `events/dead-letter.ts` for why, and
 * for what a throw from here means. Two things follow. `tasks.save` is versioned (WP-15e), so a
 * conflict with another writer of the same task **escapes**, rolls the dead letter back with it and
 * is tried again on the next sweep; that is the ending this call site has, and it is the fourth
 * shape in `task-save-sites.test.ts`. And a task that cannot be escalated at all — already
 * `needs_human`, `done` or `cancelled` — is skipped by asking {@link canTransitionTask} first, which
 * is also what makes a *second* poisoned event of the same task write nothing.
 */
import type { Id } from '@platform/contracts';
import type { CommandContext } from '@platform/domain';
import { canTransitionTask, escalateTask } from '@platform/domain';
import type { DeadLetterRecord, DeadLetterSink } from '../events/dead-letter.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { TransactionScope } from '../ports/unit-of-work.js';
import type { PipelineStore } from './store.js';

export interface DeadLetterEscalationOptions {
  readonly store: PipelineStore;
  /** The system actor every escalation this sink writes carries. */
  readonly context: (taskId: Id, causeEventId: Id) => CommandContext;
  readonly logger?: Logger;
}

/** The task an event is about, or `null` when it is about none. */
export const taskOfEvent = (record: DeadLetterRecord): Id | null => {
  const {
    stream_type: streamType,
    stream_id: streamId,
    correlation_id: correlationId,
  } = record.event.event;
  if (streamType === 'task') {
    return streamId;
  }
  return correlationId ?? null;
};

const reasonFor = (record: DeadLetterRecord): string =>
  `event ${record.event.position} (${record.event.event.type}) failed ${record.attempts} times in handler "${record.handler}" and was dead-lettered`;

const blockerBriefFor = (record: DeadLetterRecord, ticketKey: string): string =>
  `The platform could not finish handling one of ${ticketKey}'s events. Event ` +
  `${record.event.position} (${record.event.event.type}) was given to the handler ` +
  `"${record.handler}" ${record.attempts} times and failed every time, so it has been taken out of ` +
  'the dispatch queue and the events behind it are moving again. That means a step of this task ' +
  'was never performed — which one depends on the handler — and nothing will retry it by itself. ' +
  'The error text is in the platform log and on the dispatch row; it is deliberately not repeated ' +
  'here, because it may quote text the platform does not control. Look at the task, then hand it ' +
  'back at the stage it should resume from.';

/**
 * The sink the composition root registers on the bus.
 *
 * Idempotent in both directions by construction: the queue row is marked terminal in this same
 * transaction, so a later sweep never brings the event back, and a task that is already parked
 * fails the transition check rather than being parked twice.
 */
export const createDeadLetterEscalation = (
  options: DeadLetterEscalationOptions,
): DeadLetterSink => {
  const logger = options.logger ?? silentLogger;
  return async (scope: TransactionScope, record: DeadLetterRecord): Promise<void> => {
    const taskId = taskOfEvent(record);
    if (taskId === null) {
      logger.error(
        {
          position: record.event.position,
          type: record.event.event.type,
          stream_type: record.event.event.stream_type,
          handler: record.handler,
        },
        'an event was dead-lettered and names no task, so nothing was escalated; this one is an operator’s to read (WP-49)',
      );
      return;
    }
    const stored = await options.store.tasks.load(scope.tx, taskId);
    if (stored === null) {
      logger.error(
        {
          position: record.event.position,
          type: record.event.event.type,
          task_id: taskId,
          handler: record.handler,
        },
        'an event was dead-lettered and the task it names does not exist, so nothing was escalated (WP-49)',
      );
      return;
    }
    if (!canTransitionTask(stored.task.state, 'needs_human')) {
      logger.warn(
        {
          position: record.event.position,
          task_id: stored.task.id,
          state: stored.task.state,
          handler: record.handler,
        },
        'an event was dead-lettered and its task cannot be escalated from where it is; the dead letter stands (WP-49)',
      );
      return;
    }
    const escalated = escalateTask(
      stored.task,
      { reason: reasonFor(record), blockerBrief: blockerBriefFor(record, stored.task.ticket.key) },
      options.context(stored.task.id, record.event.event.id),
    );
    await options.store.tasks.save(scope.tx, { ...stored, task: escalated.aggregate });
    await scope.events.append(escalated.events);
    logger.error(
      {
        position: record.event.position,
        type: record.event.event.type,
        task_id: stored.task.id,
        handler: record.handler,
        attempts: record.attempts,
      },
      'an event was dead-lettered and its task was escalated to needs_human with a brief naming the event and the handler (WP-49)',
    );
  };
};

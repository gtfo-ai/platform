/**
 * The notify band — technical/02's Slack consumer at TD-005 priority **210** (WP-32).
 *
 * > `| task.created | Intake | … | Workpad (110), **Slack notify (210)**, UI (220) |`
 *
 * Until this file existed the band was a column in a document and two `EVENT_CONSUMPTION` entries
 * pointing at a **finished** work package (`budget.threshold.reached` and `budget.exhausted` named
 * *"Slack (210), WP-10"*, and WP-10 was DONE). `CommunicationPort` had no caller anywhere.
 *
 * ## One handler, eight event types, and why that is not a catch-all
 *
 * `sweepReadiness` counts a type as covered only when something registered **for that type by
 * name** — a handler with `eventTypes: 'all'` does not count, because WP-19's audit projection
 * would otherwise have turned the gate green for every type in the catalogue. An array of eight
 * named types is a by-name registration eight times over, so the arbiter is satisfied and a
 * deployment that sweeps the outbox really can deliver these.
 *
 * ## The handler decides and never calls (WP-15d)
 *
 * A provider call from inside a handler holds a pooled connection and the platform's dispatch slot
 * for the length of somebody else's HTTP round trip, and `events/open-transaction.ts` refuses it on
 * both paths. So this decides *what* would be said and enqueues a `pipeline.outbound` duty through
 * `HandlerContext.afterCommit`; `notify/duty.ts` re-derives everything else from committed state
 * when the job fires, because a job is a wake-up and not a message (TD-004).
 *
 * What rides the payload is what **no row holds**: the class, and the event's own words — a return
 * reason, a blocker brief, the question a model asked, the two numbers of a budget window. That is
 * the same rule `blocker_brief` has followed on this queue since WP-15d.
 */
import type { DomainEvent, NotificationClass } from '@platform/contracts';
import type { EventHandler, HandlerContext } from '../events/handler.js';
import { enqueueOutbound, type PipelineOutboundData } from '../pipeline/jobs.js';
import type { PipelineSagaOptions } from '../pipeline/saga.js';
import { boundText, NOTIFICATION_DETAIL_MAX } from './render.js';

/** TD-005: 200–299 is notifications/UI, and technical/02 puts the chat consumer at 210. */
export const NOTIFY_PRIORITY = 210;

/** Exactly the types this build notifies about; the table in `consumption.ts` says so too. */
export const NOTIFIED_EVENT_TYPES = [
  'task.created',
  'task.stage.returned',
  'task.question.asked',
  'task.escalated',
  'task.completed',
  'task.cancelled',
  'budget.threshold.reached',
  'budget.exhausted',
] as const satisfies readonly DomainEvent['type'][];

interface Decided {
  readonly notificationClass: NotificationClass;
  readonly projectId: string;
  readonly taskId: string | null;
  /** Platform text naming what this is about when there is no task to name it. */
  readonly subject: string | null;
  readonly detail: string | null;
}

/** `$12.35 of $10.00` — two numbers the platform produced, never a provider string. */
const money = (usd: number): string => `$${usd.toFixed(2)}`;

/**
 * What this event would say, or `null` for an event this build does not notify about.
 *
 * Exported for its own unit test: the mapping from an event to a class is the half a reviewer
 * should be able to read without a bus, a queue and a fake provider in the way.
 */
export const decideNotification = (event: DomainEvent): Decided | null => {
  switch (event.type) {
    case 'task.created':
      return {
        notificationClass: 'task_started',
        projectId: event.payload.project_id,
        taskId: event.payload.task_id,
        subject: null,
        detail: `Pipeline: ${event.payload.template}.`,
      };
    case 'task.stage.returned':
      return {
        notificationClass: 'stage_returned',
        projectId: event.payload.project_id,
        taskId: event.payload.task_id,
        subject: null,
        detail: `${event.payload.from_stage} → ${event.payload.to_stage}: ${event.payload.reason}`,
      };
    case 'task.question.asked':
      return {
        notificationClass: 'question',
        projectId: event.payload.project_id,
        taskId: event.payload.task_id,
        subject: null,
        detail: event.payload.question.text,
      };
    case 'task.escalated':
      return {
        notificationClass: 'escalation',
        projectId: event.payload.project_id,
        taskId: event.payload.task_id,
        subject: null,
        // The brief rather than the reason: it is the sentence that tells a human what to do, and
        // the reason is its first line. `workpad.ts` makes the same choice for the ticket comment.
        detail: event.payload.blocker_brief,
      };
    case 'task.completed':
      return {
        notificationClass: 'task_completed',
        projectId: event.payload.project_id,
        taskId: event.payload.task_id,
        subject: null,
        detail: `${event.payload.outcome} — ${money(event.payload.totals.cost_usd)}, ${
          event.payload.totals.runs
        } run${event.payload.totals.runs === 1 ? '' : 's'}.`,
      };
    case 'task.cancelled':
      return {
        notificationClass: 'task_cancelled',
        projectId: event.payload.project_id,
        taskId: event.payload.task_id,
        subject: null,
        detail: event.payload.outcome,
      };
    case 'budget.threshold.reached':
    case 'budget.exhausted': {
      /**
       * **An org-scoped budget has no project and therefore no channel** (standing rule 18's
       * shape: the absent case must not be the quiet one).
       *
       * A chat binding belongs to a project (`bindings`), so a budget whose `project_id` is null —
       * which is exactly BD-010's organisation cap — cannot be routed to a channel by this build.
       * Returning `null` here is what makes that a *decision* with a name rather than a crash in
       * the duty, and it is recorded as discovered work rather than answered by picking an
       * arbitrary project's channel.
       */
      const projectId = event.payload.project_id;
      if (projectId === null || projectId === undefined) {
        return null;
      }
      const spent = `${money(event.payload.spent_usd)} of ${money(event.payload.limit_usd)}`;
      return {
        notificationClass:
          event.type === 'budget.exhausted' ? 'budget_exhausted' : 'budget_threshold',
        projectId,
        taskId: null,
        subject: event.payload.scope === 'task' ? 'This task' : 'This project',
        detail:
          event.type === 'budget.exhausted'
            ? `${spent} spent in the ${event.payload.window} window. New runs are blocked until the window resets or the cap is raised.`
            : `${spent} spent in the ${event.payload.window} window (${event.payload.pct}%).`,
      };
    }
    default:
      return null;
  }
};

export const notifyHandler = (options: PipelineSagaOptions): EventHandler => ({
  name: 'notify.chat',
  priority: NOTIFY_PRIORITY,
  eventTypes: [...NOTIFIED_EVENT_TYPES],
  handle: async (context: HandlerContext) => {
    const event = context.event.event;
    const decided = decideNotification(event);
    if (decided === null) {
      return;
    }
    const data: PipelineOutboundData = {
      duty: 'notify',
      project_id: decided.projectId,
      ...(decided.taskId === null ? {} : { task_id: decided.taskId }),
      cause_event_id: event.id,
      notification_class: decided.notificationClass,
      ...(decided.subject === null ? {} : { notification_subject: decided.subject }),
      ...(decided.detail === null
        ? {}
        : { notification_detail: boundText(decided.detail, NOTIFICATION_DETAIL_MAX) }),
    };
    context.afterCommit(async () => {
      await enqueueOutbound(options.jobs, data);
    });
  },
});

/** Everything the notification band registers. One entry today; the shape the others have. */
export const notifyHandlers = (options: PipelineSagaOptions): readonly EventHandler[] => [
  notifyHandler(options),
];

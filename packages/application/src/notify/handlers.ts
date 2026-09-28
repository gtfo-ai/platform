/**
 * The notify band — technical/02's Slack consumer at TD-005 priority **210** (WP-32).
 *
 * > `| task.created | Intake | … | Workpad (110), **Slack notify (210)**, UI (220) |`
 *
 * Until this file existed the band was a column in a document and two `EVENT_CONSUMPTION` entries
 * pointing at a **finished** work package (`budget.threshold.reached` and `budget.exhausted` named
 * *"Slack (210), WP-10"*, and WP-10 was DONE). `CommunicationPort` had no caller anywhere.
 *
 * ## One handler, nine event types, and why that is not a catch-all
 *
 * `sweepReadiness` counts a type as covered only when something registered **for that type by
 * name** — a handler with `eventTypes: 'all'` does not count, because WP-19's audit projection
 * would otherwise have turned the gate green for every type in the catalogue. An array of nine
 * named types is a by-name registration nine times over, so the arbiter is satisfied and a
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
import type { ApprovalKind, DomainEvent, NotificationClass } from '@platform/contracts';
import type { EventHandler, HandlerContext } from '../events/handler.js';
import {
  enqueueOrganisationOutbound,
  enqueueOutbound,
  type OrganisationOutboundData,
  type PipelineOutboundData,
} from '../pipeline/jobs.js';
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
  // WP-43: posted with buttons now that a click can reach the platform (see `notify/duty.ts`).
  'task.approval.requested',
] as const satisfies readonly DomainEvent['type'][];

interface Decided {
  readonly notificationClass: NotificationClass;
  /** `null` for an organisation-scoped notification — an organisation budget (WP-65). */
  readonly projectId: string | null;
  readonly taskId: string | null;
  /** Platform text naming what this is about when there is no task to name it. */
  readonly subject: string | null;
  readonly detail: string | null;
  /** The approval an `approval` notification is about; its buttons carry the id. */
  readonly approvalId?: string;
  /** The question a `question` notification asks, so a retry or a re-post can re-check it (WP-84). */
  readonly questionId?: string;
}

/** Platform text for each approval kind — the only words the `approval` class carries. */
export const APPROVAL_DETAIL: Readonly<Record<ApprovalKind, string>> = {
  plan: 'The implementation plan needs a maintainer’s approval before the task goes on.',
  budget:
    'The estimated cost is over this project’s threshold; a maintainer decides whether to spend it.',
  knowledge: 'A knowledge-base change needs a maintainer’s approval.',
  rework: 'A rework needs a maintainer’s approval.',
};

/** `$12.35 of $10.00` — two numbers the platform produced, never a provider string. */
const money = (usd: number): string => `$${usd.toFixed(2)}`;

/**
 * What this event would say, or `null` for an event this build does not notify about.
 *
 * Exported for its own unit test: the mapping from an event to a class is the half a reviewer
 * should be able to read without a bus, a queue and a fake provider in the way.
 */
/** A return reason's first line — see the `task.stage.returned` case. */
const firstLine = (reason: string): string => {
  const end = reason.indexOf('\n');
  return end === -1 ? reason : reason.slice(0, end);
};

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
        // **The reason's first line only** (WP-46 review round 1, PROGRESS backlog 211), and what
        // that first line *is* depends on who returned the task (WP-65, backlog 215):
        //  - a **human-comment** return: platform text — the thread count, every comment below it
        //    collapsed onto a line of its own (`review-threads.ts`);
        //  - a **review-verdict** return: `[summary] ` is the platform's tag and everything after
        //    it is the reviewer **model's** summary (`verdicts.ts`, `verdictReturnReason`);
        //  - an **acceptance-verdict** return: a `[not met]` line carrying the model's evidence;
        //  - a gate's or a policy's return: platform text naming the gate.
        // So the first line may be model text steered by the code it reviewed (BD-022), and chat
        // renders markup. The line is therefore not trusted to be link-free: every link in a
        // notification's **detail** is rendered label-less by `notificationDraft`
        // (`unlabelledLinks`, `render.ts`), so a `[Approve](https://…)` reaches the channel as the
        // bare URL rather than as a label the bot appears to vouch for. The rest of the reason
        // stays on the task, behind its link.
        detail: `${event.payload.from_stage} → ${event.payload.to_stage}: ${firstLine(event.payload.reason)}`,
      };
    case 'task.question.asked':
      return {
        notificationClass: 'question',
        projectId: event.payload.project_id,
        taskId: event.payload.task_id,
        subject: null,
        detail: event.payload.question.text,
        questionId: event.payload.question.id,
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
    case 'task.approval.requested':
      return {
        notificationClass: 'approval',
        projectId: event.payload.project_id,
        taskId: event.payload.task_id,
        subject: null,
        // Platform text keyed by the approval's kind, never the plan's own words: the plan is an
        // artifact on the task page, and a channel is not where a model's output is reviewed.
        detail: APPROVAL_DETAIL[event.payload.approval.kind],
        approvalId: event.payload.approval.id,
      };
    case 'budget.threshold.reached':
    case 'budget.exhausted': {
      /**
       * **An organisation budget has no project** (WP-65, PROGRESS backlog 80).
       *
       * BD-010's organisation cap is the one budget that stops every project, and its payload
       * carries `project_id: null`. It was `null` here — decided, logged, and heard by nobody —
       * until WP-65 gave it a channel: the organisation's **own** chat account's, which a human
       * already chose (`integrations.config`), delivered by the `notify_organisation` duty. It is
       * never routed to an arbitrary project's binding, which would read as that project's cap.
       */
      const projectId = event.payload.project_id ?? null;
      const spent = `${money(event.payload.spent_usd)} of ${money(event.payload.limit_usd)}`;
      return {
        notificationClass:
          event.type === 'budget.exhausted' ? 'budget_exhausted' : 'budget_threshold',
        projectId,
        taskId: null,
        subject:
          event.payload.scope === 'org'
            ? 'The organisation'
            : event.payload.scope === 'task'
              ? 'This task'
              : 'This project',
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
    const detail =
      decided.detail === null ? null : boundText(decided.detail, NOTIFICATION_DETAIL_MAX);
    if (decided.projectId === null) {
      const organisation: OrganisationOutboundData = {
        duty: 'notify_organisation',
        cause_event_id: event.id,
        notification_class: decided.notificationClass,
        ...(decided.subject === null ? {} : { notification_subject: decided.subject }),
        ...(detail === null ? {} : { notification_detail: detail }),
      };
      context.afterCommit(async () => {
        await enqueueOrganisationOutbound(options.jobs, organisation);
      });
      return;
    }
    const data: PipelineOutboundData = {
      duty: 'notify',
      project_id: decided.projectId,
      ...(decided.taskId === null ? {} : { task_id: decided.taskId }),
      cause_event_id: event.id,
      notification_class: decided.notificationClass,
      ...(decided.subject === null ? {} : { notification_subject: decided.subject }),
      ...(decided.approvalId === undefined ? {} : { approval_id: decided.approvalId }),
      ...(decided.questionId === undefined ? {} : { question_id: decided.questionId }),
      ...(detail === null ? {} : { notification_detail: detail }),
    };
    context.afterCommit(async () => {
      await enqueueOutbound(options.jobs, data);
    });
  },
});

/**
 * **A settled approval's message loses its buttons** (WP-65, PROGRESS backlog 202).
 *
 * WP-43 posts an approval with Approve / Request changes buttons, and nothing ever edited that
 * message: once the approval was decided on the task page — or expired at its deadline (WP-56) —
 * the buttons stayed live, and a press was recorded as `decision_refused: already_decided`. The
 * aggregate refused correctly; the control lied. So the decision wakes a `pipeline.outbound` duty
 * that edits the message through `updateMessage` to say how it was settled, and a message with no
 * buttons is the answer to a press nobody should make.
 *
 * Decides nothing about *whether* a message exists — the duty asks the outbox row, on fire, because
 * the notify duty that posted it may be minutes behind this one.
 */
export const approvalSettledHandler = (options: PipelineSagaOptions): EventHandler => ({
  name: 'notify.approval_settled',
  priority: NOTIFY_PRIORITY,
  eventTypes: ['task.approval.decided'],
  handle: async (context: HandlerContext) => {
    const event = context.event.event;
    if (event.type !== 'task.approval.decided') {
      return;
    }
    const data: PipelineOutboundData = {
      duty: 'approval_settled',
      project_id: event.payload.project_id,
      task_id: event.payload.task_id,
      cause_event_id: event.id,
      approval_id: event.payload.approval_id,
      approval_decision: event.payload.decision,
    };
    context.afterCommit(async () => {
      await enqueueOutbound(options.jobs, data);
    });
  },
});

/** Everything the notification band registers. */
export const notifyHandlers = (options: PipelineSagaOptions): readonly EventHandler[] => [
  notifyHandler(options),
  approvalSettledHandler(options),
];

/**
 * The workpad and the status mapping — the two things a human sees on the ticket (BD-023).
 *
 * Both are handlers in TD-005's **integrations** band (100–199), after the core band has decided
 * what happened: the pipeline moves the task, and these tell the outside world. That order is the
 * whole point of the bands — a workpad that rendered before the transition committed would show a
 * stage the task had not entered.
 *
 * ## The handler decides; the job calls (WP-15d)
 *
 * Neither handler touches a provider. Each enqueues one `pipeline.outbound` job from
 * `HandlerContext.afterCommit` and the job makes the call, outside every transaction, re-reading
 * the task row when it fires. Two things follow, and both are improvements rather than costs:
 *
 *  - the render is a function of **committed** state. A handler renders inside the transaction that
 *    is still writing the state it renders; a job renders after it, so what reaches the ticket is
 *    what a human would read back out of the database;
 *  - a lost wake-up self-heals. The render is derived from the task row on every event, so the next
 *    event renders what the lost one would have — which is why these two duties need no durability
 *    beyond `afterCommit`, where the intake check needs the job's own re-validation.
 *
 * What it costs is the **ordering** the old shape had for free. The status mapping (110) and the
 * workpad (120) used to call the provider in that order inside one dispatch; now they enqueue in
 * that order onto one queue served by one worker, which normally preserves it but is a property of
 * the queue rather than a guarantee of the pipeline. Nothing depends on it: each duty re-derives
 * its content from the task row, so either order converges on the same ticket. A test that asserts
 * both must wait for **both** (standing rule 76).
 *
 * ## One comment, edited in place
 *
 * BD-023: "the single sticky comment on the ticket that the platform edits in place with state,
 * checklist, cost and links". `upsertWorkpad` creates it on the first call and edits it afterwards,
 * keyed by a marker the platform owns — so a task never produces a second one, however many times
 * these handlers run. That is also what makes them idempotent under redelivery: rendering is a pure
 * function of the task, so the same task renders the same comment.
 *
 * ## The status mapping is the project's vocabulary, not the platform's
 *
 * technical/12's `status_mapping` maps a **stage id or a task state** onto the provider's own
 * status name (`refinement: "In Refinement"`, `ready_for_merge: "In Review"`). The stage wins when
 * both match, because it is the more specific statement. A key nobody configured means "do not
 * transition" — not "guess": a wrong transition on somebody's board is worse than none, and
 * `transition` refuses a status the workflow does not have anyway (product/08).
 */
import type { Id, Slug, TaskState } from '@platform/contracts';
import type { EventHandler } from '../events/handler.js';
import type { Jobs } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import type { PipelineIntegrationsPort } from './integrations.js';
import { integrationsForProject, noRunScopedSecrets, ticketWrites } from './integrations.js';
import { enqueueOutbound, type PipelineOutboundData } from './jobs.js';
import type { ProjectSettingsPort } from './settings.js';
import type { PipelineStore, StoredTask } from './store.js';

export interface WorkpadOptions {
  readonly store: PipelineStore;
  readonly settings: ProjectSettingsPort;
  readonly integrations: PipelineIntegrationsPort;
  readonly jobs: Jobs;
  readonly logger?: Logger;
}

/** What the two duties need on top of the handlers: a transaction of their own to open. */
export interface WorkpadJobOptions extends WorkpadOptions {
  readonly unitOfWork: UnitOfWork;
}

/** The marker `upsertWorkpad` keys the comment on. One per task, stable for its whole life. */
export const workpadMarker = (taskId: Id): string => `agentic:task:${taskId}`;

/** Events that change what the workpad says. */
const WORKPAD_EVENTS = [
  'task.created',
  'task.queued',
  'task.stage.entered',
  'task.stage.returned',
  'task.question.asked',
  'task.approval.requested',
  'task.escalated',
  'task.paused',
  'task.resumed',
  'task.completed',
  'task.cancelled',
] as const;

/** Events that may move the ticket's status. */
const STATUS_EVENTS = [
  'task.stage.entered',
  'task.escalated',
  'task.paused',
  'task.completed',
  'task.cancelled',
] as const;

export interface WorkpadView {
  readonly ticketKey: string;
  readonly state: TaskState;
  readonly currentStage: Slug | null;
  /** Stage ids in template order, with the ones the task has entered. */
  readonly stages: readonly { readonly id: Slug; readonly entered: boolean }[];
  readonly costUsd: number;
  readonly budgetUsd: number;
  readonly mrUrl: string | null;
  /** The last blocker brief, when the task is parked. */
  readonly blocker: string | null;
}

/**
 * The workpad's markdown.
 *
 * A pure function of the view, so it is unit-testable and so two renders of the same task are
 * byte-identical — which is what stops an edit-in-place from churning the ticket's history.
 *
 * Nothing here interpolates untrusted text except the ticket key and the merge-request URL, both of
 * which the platform received from the provider and stores verbatim (BD-022: rendered, never
 * executed).
 */
export const renderWorkpad = (view: WorkpadView): string => {
  const checklist = view.stages
    .map((stage) => {
      const mark = stage.id === view.currentStage ? '▶' : stage.entered ? '✓' : '·';
      return `- ${mark} ${stage.id}`;
    })
    .join('\n');
  const lines = [
    `**${view.ticketKey}** — ${view.state}${view.currentStage === null ? '' : ` (${view.currentStage})`}`,
    '',
    checklist,
    '',
    `Cost so far: ${view.costUsd.toFixed(2)} of ${view.budgetUsd.toFixed(2)} USD`,
  ];
  if (view.mrUrl !== null) {
    lines.push(`Merge request: ${view.mrUrl}`);
  }
  if (view.blocker !== null) {
    lines.push('', '**Needs a human**', view.blocker);
  }
  return lines.join('\n');
};

const viewOf = (stored: StoredTask, budgetUsd: number, blocker: string | null): WorkpadView => ({
  ticketKey: stored.task.ticket.key,
  state: stored.task.state,
  currentStage: stored.task.currentStage,
  stages: stored.template.stages.map((stage) => ({
    id: stage.id,
    entered: (stored.task.stageAttempts[stage.id] ?? 0) > 0,
  })),
  costUsd: stored.costActualUsd,
  budgetUsd,
  mrUrl: stored.mr?.url ?? null,
  blocker,
});

/**
 * The ticket status a task should be in, or `null` when the project has not mapped it.
 *
 * The stage is the more specific statement and wins; the state is the fallback, which is what
 * covers `waiting_answers`, `paused` and `done` — states with no stage of their own.
 */
export const mappedStatus = (
  mapping: Readonly<Record<string, string>> | undefined,
  state: TaskState,
  currentStage: Slug | null,
): string | null => {
  if (mapping === undefined) {
    return null;
  }
  if (currentStage !== null && mapping[currentStage] !== undefined) {
    return mapping[currentStage] ?? null;
  }
  return mapping[state] ?? null;
};

/** The payload both handlers read off the event; every task-scoped event carries the first two. */
interface TaskEventPayload {
  readonly task_id?: Id;
  readonly project_id?: Id;
  readonly blocker_brief?: string;
}

export const workpadHandler = (options: WorkpadOptions): EventHandler => ({
  name: 'pipeline.workpad',
  priority: 120,
  eventTypes: [...WORKPAD_EVENTS],
  handle: async (context) => {
    const payload = context.event.event.payload as TaskEventPayload;
    const taskId = payload.task_id;
    const projectId = payload.project_id;
    if (taskId === undefined || projectId === undefined) {
      return;
    }
    const data: PipelineOutboundData = {
      duty: 'workpad',
      project_id: projectId,
      task_id: taskId,
      cause_event_id: context.event.event.id,
      // The one thing the render cannot re-derive from the task row.
      ...(payload.blocker_brief === undefined ? {} : { blocker_brief: payload.blocker_brief }),
    };
    context.afterCommit(async () => {
      await enqueueOutbound(options.jobs, data);
    });
  },
});

/**
 * The status a task's *event* maps to is decided **here**, and carried to the job.
 *
 * This is the one place the two duties differ, and the difference is the product's rather than the
 * mechanism's. A workpad is a *picture*: re-rendering it from the task row when the job fires is
 * strictly better, because what reaches the ticket is then what a human would read back out of the
 * database. A transition is a *movement*: a task that moved twice while the queue was busy owes the
 * board both moves in order, and a job that re-derived the status would send the last one twice and
 * never show the one in between. So the handler reads the row it is already in a transaction with,
 * maps the status, and the job performs it — no provider call either way.
 *
 * A status nobody mapped enqueues nothing at all: "do not transition" is not "guess", and a job
 * that woke up to do nothing is a row in the queue for every event of every task.
 */
export const statusMappingHandler = (options: WorkpadOptions): EventHandler => ({
  name: 'pipeline.status.mapping',
  priority: 110,
  eventTypes: [...STATUS_EVENTS],
  handle: async (context) => {
    const logger = options.logger ?? silentLogger;
    const payload = context.event.event.payload as TaskEventPayload;
    const taskId = payload.task_id;
    const projectId = payload.project_id;
    if (taskId === undefined || projectId === undefined) {
      return;
    }
    const stored = await options.store.tasks.load(context.scope.tx, taskId);
    if (stored === null) {
      return;
    }
    const settings = await options.settings.forProject(stored.task.projectId);
    const status = mappedStatus(
      settings.config.status_mapping,
      stored.task.state,
      stored.task.currentStage,
    );
    if (status === null) {
      logger.debug(
        { task_id: taskId, state: stored.task.state, stage: stored.task.currentStage },
        'no ticket status is mapped for this state; leaving the ticket alone',
      );
      return;
    }
    const data: PipelineOutboundData = {
      duty: 'status',
      project_id: projectId,
      task_id: taskId,
      cause_event_id: context.event.event.id,
      status,
    };
    context.afterCommit(async () => {
      await enqueueOutbound(options.jobs, data);
    });
  },
});

/**
 * `pipeline.outbound` duty **workpad**: render the task as it is now and edit the comment.
 *
 * Three steps in CLAUDE.md's shape — read in a transaction, call the provider in none, remember the
 * comment in another — and the last one re-loads rather than writing back the row it read: the task
 * may have moved between the load and the provider's answer, and a `save` of the stale snapshot
 * would undo it.
 */
export const runWorkpadRender = async (
  options: WorkpadJobOptions,
  data: PipelineOutboundData,
): Promise<void> => {
  const taskId = data.task_id as Id | undefined;
  if (taskId === undefined) {
    return;
  }
  const stored = await options.unitOfWork.transaction(async (scope) =>
    options.store.tasks.load(scope.tx, taskId),
  );
  if (stored === null) {
    return;
  }
  const settings = await options.settings.forProject(stored.task.projectId);
  const markdown = renderWorkpad(
    viewOf(stored, settings.taskBudgetUsd, data.blocker_brief ?? null),
  );
  // The workpad is written outside any run, so the call's scope holds no minted credential (Q55).
  const integrations = await integrationsForProject(
    options.integrations,
    stored.task.projectId,
    noRunScopedSecrets(),
  );
  const ref = await ticketWrites(integrations).upsertWorkpad(
    stored.task.ticket,
    workpadMarker(taskId),
    markdown,
    {
      projectId: stored.task.projectId,
      taskId,
      mode: stored.task.mode,
      causeEventId: data.cause_event_id as Id,
    },
  );
  if (ref === null) {
    return;
  }
  await options.unitOfWork.transaction(async (scope) => {
    const current = await options.store.tasks.load(scope.tx, taskId);
    if (current === null || current.workpad?.comment_id === ref.comment_id) {
      return;
    }
    // Remember where it lives, so a later render edits rather than creates — and so the UI can
    // link to it. `saveWorkpad`, never `save`: this transaction runs beside the stage executor's,
    // and a whole-row write here puts back the cost, the state and the stage as they were when
    // this job started. Measured — it cost a task 0.40 USD of recorded spend.
    //
    // **Narrowed field by field, and that is not cosmetic** (WP-15h). `upsertWorkpad` returns a
    // `CommentRef`, which is `workpadRefSchema.extend({ marker_id })`; `saveWorkpad` declares a
    // `WorkpadRef` and TypeScript passes the wider object through structurally, so the adapter
    // `JSON.stringify`d the provider's `marker_id` into `tasks.workpad_ref`. The column's published
    // shape is **strict**, so the first thing ever to read the row back — `GET /api/tasks/:id` —
    // answered 500 on `Unrecognized key: "marker_id"` for every task that had a workpad. The
    // marker is not lost by dropping it: it is `workpadMarker(taskId)`, a pure function of the id
    // the row is keyed by, which is why the published shape never carried it.
    await options.store.tasks.saveWorkpad(scope.tx, taskId, {
      provider: ref.provider,
      ticket_key: ref.ticket_key,
      comment_id: ref.comment_id,
      url: ref.url,
    });
  });
};

/**
 * `pipeline.outbound` duty **status**: move the ticket to the status the handler mapped.
 *
 * The task is re-read — it may have been cancelled, or never have existed — but the *status* is the
 * one the handler decided on, for the reason {@link statusMappingHandler} gives. A wake-up lost
 * here costs a ticket that lags the board until the next mapped event, which is the fail-open
 * direction on a notification (standing rule 20).
 */
export const runStatusTransition = async (
  options: WorkpadJobOptions,
  data: PipelineOutboundData,
): Promise<void> => {
  const taskId = data.task_id as Id | undefined;
  const status = data.status as string | undefined;
  if (taskId === undefined || status === undefined || status === '') {
    return;
  }
  const stored = await options.unitOfWork.transaction(async (scope) =>
    options.store.tasks.load(scope.tx, taskId),
  );
  if (stored === null) {
    return;
  }
  const integrations = await integrationsForProject(
    options.integrations,
    stored.task.projectId,
    noRunScopedSecrets(),
  );
  await ticketWrites(integrations).transition(stored.task.ticket, status, {
    projectId: stored.task.projectId,
    taskId,
    mode: stored.task.mode,
    causeEventId: data.cause_event_id as Id,
  });
};

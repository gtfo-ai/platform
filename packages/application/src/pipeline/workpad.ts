/**
 * The workpad and the status mapping — the two things a human sees on the ticket (BD-023).
 *
 * Both are handlers in TD-005's **integrations** band (100–199), after the core band has decided
 * what happened: the pipeline moves the task, and these tell the outside world. That order is the
 * whole point of the bands — a workpad that rendered before the transition committed would show a
 * stage the task had not entered.
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
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { PipelineIntegrations } from './integrations.js';
import { ticketWrites } from './integrations.js';
import type { ProjectSettingsPort } from './settings.js';
import type { PipelineStore, StoredTask } from './store.js';

export interface WorkpadOptions {
  readonly store: PipelineStore;
  readonly settings: ProjectSettingsPort;
  readonly integrations: PipelineIntegrations;
  readonly logger?: Logger;
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

export const workpadHandler = (options: WorkpadOptions): EventHandler => ({
  name: 'pipeline.workpad',
  priority: 120,
  eventTypes: [...WORKPAD_EVENTS],
  handle: async (context) => {
    const event = context.event.event;
    const payload = event.payload as { task_id?: Id; blocker_brief?: string };
    const taskId = payload.task_id;
    if (taskId === undefined) {
      return;
    }
    const stored = await options.store.tasks.load(context.scope.tx, taskId);
    if (stored === null) {
      return;
    }
    const settings = await options.settings.forProject(stored.task.projectId);
    const markdown = renderWorkpad(
      viewOf(stored, settings.taskBudgetUsd, payload.blocker_brief ?? null),
    );
    const ref = await ticketWrites(options.integrations).upsertWorkpad(
      stored.task.ticket,
      workpadMarker(taskId),
      markdown,
      {
        projectId: stored.task.projectId,
        taskId,
        mode: stored.task.mode,
      },
    );
    if (ref !== null && stored.workpad?.comment_id !== ref.comment_id) {
      // Remember where it lives, so a later render edits rather than creates — and so the UI can
      // link to it.
      await options.store.tasks.save(context.scope.tx, { ...stored, workpad: ref });
    }
  },
});

export const statusMappingHandler = (options: WorkpadOptions): EventHandler => ({
  name: 'pipeline.status.mapping',
  priority: 110,
  eventTypes: [...STATUS_EVENTS],
  handle: async (context) => {
    const logger = options.logger ?? silentLogger;
    const event = context.event.event;
    const taskId = (event.payload as { task_id?: Id }).task_id;
    if (taskId === undefined) {
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
    await ticketWrites(options.integrations).transition(stored.task.ticket, status, {
      projectId: stored.task.projectId,
      taskId,
      mode: stored.task.mode,
    });
  },
});

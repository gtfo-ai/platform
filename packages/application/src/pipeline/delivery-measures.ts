/**
 * Two measurements the delivery metrics need and no event carried — product/16's *"LOC added /
 * removed / changed per merged MR (from MR diff stats)"* and its *"defect escape"* (WP-61, PROGRESS
 * backlog **179** and **114**, **Q87**).
 *
 * The shape is WP-15d's: a handler **decides** inside the dispatcher's transaction and a
 * `pipeline.outbound` duty **calls** the provider outside every transaction, then appends what it
 * found as an event. Nothing here writes a statistics row — the statistics read takes the first
 * `task.mr.measured` per cause event and joins `ticket.bug.traced` to the deliveries
 * (`apps/server/src/queries/stats-queries.ts`) — so the facts are in the append-only log and a
 * projection built on them later can be replayed from it. **Idempotency is the read's**: a job
 * redelivered after its append committed (a crash before the ack, an expiry mid-read) appends a
 * second event with the same `cause_event_id`, and the read keeps the first.
 *
 * ## Why both events land on the **project** stream
 *
 * A merged task's own stream is live with the retrospective stage by the time the read returns,
 * and a bug ticket usually has no task at all. Neither event decides anything about a task, so
 * neither needs the task row's `version` token (the dance `conflict-warning.ts` does for a live
 * stream); the sequence is read with `nextStreamSequence` just before the append, exactly as the
 * knowledge ring's project-stream writers do, and a racing append on the same stream fails the
 * transaction with `StreamConflictError`, which fails the job, which pg-boss retries.
 *
 * ## `task.mr.measured` — one read per merge the platform made
 *
 * **The platform's own merge requests only**, decided rather than inherited: product/16 says *"per
 * merged MR"* on a table of the platform's metrics, and counting every merge request a binding
 * reports would cost one GraphQL read per human merge for a number nobody asked this platform to
 * publish. A merge request that belongs to no task is not measured, and says so in the log.
 *
 * The delivery's own `diff_stats` is **never read**: GitLab sends `null` there and the fake fills it
 * (its divergence 17), so a metric built on it would be green in every tier and absent in
 * production — backlog 113's trap. The only source is `getMergeRequestDiffStats`.
 *
 * **Residual, stated:** a merge request reopened and merged again is measured twice, while
 * `stats_task_delivery` keeps the first merge only, so its lines count twice in `loc_changed`. The
 * inbox deduplicates a *redelivered* webhook, so this needs two distinct merges.
 *
 * ## `ticket.bug.traced` — the link half, never a guess
 *
 * A ticket is a **bug** when the project's own `templates` map (`templateByIssueType`) routes its
 * issue type to the `bug` template — the project's statement of which of its types are bugs, and
 * the one intake already acts on — so no second list exists to drift from it. The decision needs
 * the project's settings, which is I/O, so it is the **job's** (the division `ticket-lint.ts` makes):
 * the handler enqueues for every `ticket.created` and the job returns early for a type that is not
 * a bug, with no provider call.
 *
 * The trace reads the ticket once and runs **only the link half** of WP-34's resolver over its
 * links ({@link findMergeRequestByTicketLinks}). The title scan is the wrong half, and adjacency —
 * a merge followed by a bug within thirty days — is not a trace at all (criterion 6). Every bug
 * gets an event, found or not, because Q87's answer publishes the rate **only with its coverage**:
 * how many bug tickets carried a link the platform could resolve.
 */
import type { DomainEvent, Id, MergeRequestRef } from '@platform/contracts';
import { ticketRefSchema } from '@platform/contracts';
import { buildEvent } from '@platform/domain';
import type { EventHandler, HandlerContext } from '../events/handler.js';
import type { EventStore } from '../ports/event-store.js';
import type { TicketRefInput } from '../ports/integrations/task-management.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { findMergeRequestByTicketLinks } from '../shadow/human-merge-request.js';
import {
  gitReads,
  integrationsForProject,
  noRunScopedSecrets,
  ticketReads,
} from './integrations.js';
import { enqueueOutbound, type PipelineOutboundData } from './jobs.js';
import type { PipelineSagaOptions } from './saga.js';
import type { ProjectSettings } from './settings.js';
import { PIPELINE_ACTOR } from './store.js';

/** The template id whose issue types this platform counts as bugs. */
export const BUG_TEMPLATE_ID = 'bug';

export interface DeliveryMeasuresOptions extends PipelineSagaOptions {
  readonly unitOfWork: UnitOfWork;
  /** The project stream's next sequence, read just before the append (the module docblock says why). */
  readonly eventStore: Pick<EventStore, 'nextStreamSequence'>;
}

/**
 * Is this issue type one the project routes to the `bug` template?
 *
 * The same lookup intake classifies by (`templateForIssueType`: trimmed, lower-cased), asked a
 * narrower question: it does not fall back to the default template, because "not mapped" is not
 * "a bug", and a ticket with no type is not one either.
 */
export const isBugIssueType = (settings: ProjectSettings, issueType: string | null): boolean =>
  issueType !== null &&
  settings.templateByIssueType[issueType.trim().toLowerCase()] === BUG_TEMPLATE_ID;

// ── The handlers ─────────────────────────────────────────────────────────────

/**
 * `mr.merged` → measure the merge request, if it is one the platform made.
 *
 * Priority **120**, the integrations band: it asks the outside world something, and the core
 * band's consumers of `mr.merged` (the saga's merged gate) settle first. The task is found the way
 * every other `mr.*` consumer finds it — the payload's `task_id` when a producer knew it, otherwise
 * `tasks.mr_ref`'s iid — because a webhook names a merge request, not a platform task.
 */
const mergeMeasureHandler = (options: PipelineSagaOptions): EventHandler => ({
  name: 'pipeline.merge.measure',
  priority: 120,
  eventTypes: ['mr.merged'],
  handle: async (context: HandlerContext) => {
    const event = context.event.event;
    if (event.type !== 'mr.merged') {
      return;
    }
    const { payload } = event;
    const taskId =
      payload.task_id ??
      (
        await options.store.tasks.findByMergeRequest(context.scope.tx, {
          projectId: payload.project_id,
          iid: payload.mr.iid,
        })
      )?.task.id ??
      null;
    if (taskId === null) {
      options.logger?.debug(
        { project_id: payload.project_id, iid: payload.mr.iid },
        'merge measure: this merge request belongs to no task, so the platform does not measure it',
      );
      return;
    }
    const data: PipelineOutboundData = {
      duty: 'merge_measure',
      project_id: payload.project_id,
      task_id: taskId,
      cause_event_id: event.id,
      // The merge request that merged, from the event: the task row's `mr_ref` may already name a
      // later one if the task was reworked, and the measurement belongs to this merge.
      iid: payload.mr.iid,
      mr_url: payload.mr.url,
      ...(payload.mr.project_path === null || payload.mr.project_path === undefined
        ? {}
        : { mr_project_path: payload.mr.project_path }),
    };
    context.afterCommit(async () => {
      await enqueueOutbound(options.jobs, data);
    });
  },
});

/**
 * `ticket.created` → consider a defect trace.
 *
 * Priority **120** and it decides nothing but "a ticket arrived": whether it is a bug is a settings
 * read, which is the job's (the module docblock). The event's `issue_type` and instant ride the
 * payload, because no row holds them — the instant is what the thirty days are measured back from.
 */
const bugTraceHandler = (options: PipelineSagaOptions): EventHandler => ({
  name: 'pipeline.bug.trace',
  priority: 120,
  eventTypes: ['ticket.created'],
  handle: async (context: HandlerContext) => {
    const event = context.event.event;
    if (event.type !== 'ticket.created') {
      return;
    }
    const data: PipelineOutboundData = {
      duty: 'bug_trace',
      project_id: event.payload.project_id,
      cause_event_id: event.id,
      ticket: event.payload.ticket,
      issue_type: event.payload.issue_type ?? null,
      filed_at: event.occurred_at,
    };
    context.afterCommit(async () => {
      await enqueueOutbound(options.jobs, data);
    });
  },
});

/** Every handler this module registers, for the runtime to spread. */
export const deliveryMeasureHandlers = (options: PipelineSagaOptions): readonly EventHandler[] => [
  mergeMeasureHandler(options),
  bugTraceHandler(options),
];

// ── The duties ───────────────────────────────────────────────────────────────

/** Appends one event on the project's stream, in a transaction of its own. */
const appendOnProject = async (
  options: DeliveryMeasuresOptions,
  projectId: Id,
  build: (streamSeq: number) => DomainEvent,
): Promise<void> => {
  const streamSeq = await options.eventStore.nextStreamSequence('project', projectId);
  await options.unitOfWork.transaction(async (scope) => {
    await scope.events.append([build(streamSeq)]);
  });
};

const commandContext = (options: DeliveryMeasuresOptions, correlationId: Id, causeEventId: Id) => ({
  ids: options.ids,
  actor: PIPELINE_ACTOR,
  clock: options.clock as never,
  correlationId,
  causeEventId,
});

/**
 * `pipeline.outbound` duty **merge_measure**: one `getMergeRequestDiffStats`, one event.
 *
 * **Re-validates on fire** (TD-004): the task still exists. It does not require any state — a
 * merge is a fact whatever the task did next. A project whose git binding is gone records
 * **nothing**: no read was made, so there is no measurement to report, not even an unmeasured one.
 */
export const runMergeMeasure = async (
  options: DeliveryMeasuresOptions,
  data: PipelineOutboundData,
): Promise<void> => {
  const logger: Logger = options.logger ?? silentLogger;
  const projectId = data.project_id as Id;
  const taskId = data.task_id as Id | undefined;
  const iid = typeof data.iid === 'number' ? data.iid : null;
  const url = typeof data.mr_url === 'string' ? data.mr_url : null;
  if (taskId === undefined || iid === null || url === null) {
    logger.warn({ project_id: projectId }, 'merge measure: the wake-up named no merge request');
    return;
  }
  const exists = await options.unitOfWork.transaction(async (scope) =>
    options.store.tasks.load(scope.tx, taskId),
  );
  if (exists === null) {
    return;
  }
  const integrations = await integrationsForProject(
    options.integrations,
    projectId,
    noRunScopedSecrets(),
  );
  if (integrations.git === null) {
    logger.info(
      { task_id: taskId },
      'merge measure: this project has no git binding, so nothing was read and nothing is recorded',
    );
    return;
  }
  const ref = {
    iid,
    url,
    ...(typeof data.mr_project_path === 'string' ? { project_path: data.mr_project_path } : {}),
  };
  const stats = await gitReads(integrations).mergeRequestDiffStats(ref, { projectId, taskId });
  await appendOnProject(
    options,
    projectId,
    (streamSeq) =>
      buildEvent(
        'task.mr.measured',
        {
          project_id: projectId,
          task_id: taskId,
          mr: ref,
          // `null` is recorded, never replaced by zeros (standing rule 16): the read counts it as an
          // unmeasured merge, which keeps it out of the lines-per-merge mean.
          diff_stats: stats,
        },
        { streamType: 'project', streamId: projectId, streamSeq },
        commandContext(options, taskId, data.cause_event_id as Id),
      ) as DomainEvent,
  );
  logger.info(
    { task_id: taskId, iid, measured: stats !== null },
    stats === null
      ? 'merge measure: the provider answered no diff stats for this merge request; recorded as unmeasured'
      : 'merge measure: recorded the merged merge request’s size',
  );
};

/**
 * `pipeline.outbound` duty **bug_trace**: is this a bug, and which merge request do its own links
 * name?
 *
 * Every refusal before the bug decision records nothing — the ticket is not a bug, so it is in
 * neither side of the rate. Every outcome after it records one `ticket.bug.traced`, because the
 * coverage is a count of them: a bug the platform could not read is `unreadable` and counts against
 * the coverage rather than vanishing from it.
 */
export const runBugTrace = async (
  options: DeliveryMeasuresOptions,
  data: PipelineOutboundData,
): Promise<void> => {
  const logger: Logger = options.logger ?? silentLogger;
  const projectId = data.project_id as Id;
  const filedAt = typeof data.filed_at === 'string' ? data.filed_at : null;
  if (data.ticket === undefined || filedAt === null) {
    logger.warn({ project_id: projectId }, 'bug trace: the wake-up named no ticket');
    return;
  }
  // The job payload is a wire boundary and the ticket in it is provider text — parsed, never cast.
  const source: TicketRefInput = ticketRefSchema.parse(data.ticket);
  const settings = await options.settings.forProject(projectId);
  const eventType = typeof data.issue_type === 'string' ? data.issue_type : null;
  if (eventType !== null && !isBugIssueType(settings, eventType)) {
    return;
  }

  const integrations = await integrationsForProject(
    options.integrations,
    projectId,
    noRunScopedSecrets(),
  );
  const context = { projectId, taskId: null };
  // A provider failure **throws** and fails the job, as the linter's read does: a transient
  // refusal is retried rather than recorded as a bug nobody could read.
  const ticket = await ticketReads(integrations).ticket(source, context);
  // The delivery named no type: the ticket's own answers the question, and a ticket that could not
  // be read cannot be classified, so it is not counted as a bug at all.
  if (eventType === null && (ticket === null || !isBugIssueType(settings, ticket.issue_type))) {
    return;
  }

  const record = async (trace: {
    readonly outcome: 'linked' | 'no_link' | 'unreadable';
    readonly mr: MergeRequestRef | null;
    readonly taskId: Id | null;
  }): Promise<void> => {
    await appendOnProject(
      options,
      projectId,
      (streamSeq) =>
        buildEvent(
          'ticket.bug.traced',
          {
            project_id: projectId,
            ticket: source,
            filed_at: filedAt,
            outcome: trace.outcome,
            found_by: trace.outcome === 'linked' ? 'ticket_link' : null,
            mr: trace.mr,
            task_id: trace.taskId,
          },
          { streamType: 'project', streamId: projectId, streamSeq },
          commandContext(options, projectId, data.cause_event_id as Id),
        ) as DomainEvent,
    );
    logger.info(
      { project_id: projectId, ticket_key: source.key, outcome: trace.outcome },
      'bug trace: recorded what the ticket’s own links say',
    );
  };

  if (ticket === null || integrations.git === null) {
    // No task-management binding, a reference no provider issued, or no git binding to resolve a
    // link against: the platform could not look, which is a coverage fact and not "no link".
    await record({ outcome: 'unreadable', mr: null, taskId: null });
    return;
  }
  const found = await findMergeRequestByTicketLinks(
    { reads: gitReads(integrations), context },
    ticket.links,
  );
  if (found === null) {
    await record({ outcome: 'no_link', mr: null, taskId: null });
    return;
  }
  const owner = await options.unitOfWork.transaction(async (scope) =>
    options.store.tasks.findByMergeRequest(scope.tx, {
      projectId,
      iid: found.mergeRequest.iid,
    }),
  );
  await record({ outcome: 'linked', mr: found.mergeRequest, taskId: owner?.task.id ?? null });
};

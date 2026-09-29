/**
 * The review-thread count, re-read when a thread is resolved without a comment that would open
 * BD-007's window — WP-90, PROGRESS backlog 210's remaining halves.
 *
 * `tasks.review_threads` is written by the review window (`reviewWindowHandler`, `jobs.ts`), and the
 * window is armed only by a comment on an **unresolved** thread while the task waits at
 * `ready_for_merge`. So a reviewer who resolves threads left the Checks panel saying *2 open* for a
 * merge request they had cleared. Two signals do reach the platform when that happens, and this
 * module reads both:
 *
 *  - **`mr.updated` with `blocking_threads_resolved`** — GitLab's merge-request hook fires with
 *    `action: "update"` when all threads are resolved, carrying `changes.blocking_discussions_resolved`
 *    (the normaliser, `gitlab/inbound.ts`). It is the one signal GitLab sends for a resolution with no
 *    note, and it has two limits the panel's sentence states: it is the **last** resolution only (one
 *    thread of three resolved sends nothing), and it is sent only by a project that **requires**
 *    resolved threads before merging — elsewhere the value is always `true` and never changes;
 *  - **`mr.review.comment` with `resolved: true`** — a note written into a thread that is resolved
 *    when the normaliser reads it back ("comment and resolve"). The saga's window handler returns on
 *    it (`saga.ts`), rightly — a resolved thread is no reason to send a task back — and this one
 *    re-counts instead.
 *
 * ## Count only, never the decision
 *
 * The duty reads the discussions — the same `listDiscussions` the window reads, through
 * `IntegrationActionExecutor`, outside every transaction — and writes **only** the count, through
 * the column's narrow writer ({@link TaskRepository.saveReviewThreads}) in a transaction of its own,
 * with the window's own predicate (`reviewThreadCounts`), so the two writers cannot disagree about
 * which thread is open. It never returns a task: a resolution must not trigger the return decision,
 * and a thread *re-opened* (`blocking_threads_resolved: false`) is counted here and acted on only by
 * the window a comment arms. It is **not a diff read** — the discussion list is the window's own
 * read, bounded by the adapter, and nothing here downloads a patch (backlog 64's lesson).
 *
 * ## Bounded, and re-validated on fire
 *
 * One read per signal delivery, and each signal is a human's act on the merge request. The duty
 * re-validates on fire (TD-004): the task still exists, still waits at `ready_for_merge`, and its
 * merge request is still the one the signal named — a rework in between moved `mr_ref`, and the
 * count of the old merge request is not this task's. **Residual, stated:** two readings racing — a
 * window and a refresh, or two refreshes — write in the order they commit, not in the order they
 * read, so the later commit wins even if it read first; both readings are milliseconds apart and the
 * next signal corrects either.
 */
import type { Id } from '@platform/contracts';
import type { EventHandler, HandlerContext } from '../events/handler.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { gitReads, integrationsForProject, noRunScopedSecrets } from './integrations.js';
import { enqueueOutbound, type PipelineOutboundData } from './jobs.js';
import { isPlatformNote, reviewThreadCounts } from './review-threads.js';
import type { PipelineSagaOptions } from './saga.js';

/** The handler's name is its `handler_executions` key; renaming it re-runs it over the log. */
export const REVIEW_THREADS_REFRESH_HANDLER = 'pipeline.review.threads.refresh';

export interface ReviewThreadsRefreshOptions extends PipelineSagaOptions {
  readonly unitOfWork: UnitOfWork;
}

/** Which merge request a signal names, or `null` when the event is not a resolution signal. */
const resolutionSignal = (
  event: HandlerContext['event']['event'],
): { readonly projectId: Id; readonly iid: number } | null => {
  if (event.type === 'mr.updated') {
    const flag = event.payload.blocking_threads_resolved;
    return flag === true || flag === false
      ? { projectId: event.payload.project_id, iid: event.payload.mr.iid }
      : null;
  }
  if (event.type === 'mr.review.comment') {
    // The platform's own note arriving back is nobody resolving anything (WP-73, backlog 214).
    return event.payload.resolved && !isPlatformNote({ body: event.payload.text })
      ? { projectId: event.payload.project_id, iid: event.payload.mr.iid }
      : null;
  }
  return null;
};

/**
 * A resolution signal → enqueue a count-only re-read for the task waiting on that merge request.
 *
 * Priority **120**, the integrations band: it asks the outside world something and decides nothing
 * the pipeline waits for. `ready_for_merge` only, the state the window writes the count in.
 */
const refreshHandler = (options: PipelineSagaOptions): EventHandler => ({
  name: REVIEW_THREADS_REFRESH_HANDLER,
  priority: 120,
  eventTypes: ['mr.updated', 'mr.review.comment'],
  handle: async (context: HandlerContext) => {
    const event = context.event.event;
    const signal = resolutionSignal(event);
    if (signal === null) {
      return;
    }
    const stored = await options.store.tasks.findByMergeRequest(context.scope.tx, signal);
    if (stored === null || stored.task.state !== 'ready_for_merge') {
      return;
    }
    const data: PipelineOutboundData = {
      duty: 'review_threads_refresh',
      project_id: stored.task.projectId,
      task_id: stored.task.id,
      cause_event_id: event.id,
      iid: signal.iid,
    };
    context.afterCommit(async () => {
      await enqueueOutbound(options.jobs, data);
    });
  },
});

/** Every handler this module registers, for the runtime to spread. */
export const reviewThreadsRefreshHandlers = (
  options: PipelineSagaOptions,
): readonly EventHandler[] => [refreshHandler(options)];

/**
 * `pipeline.outbound` duty **review_threads_refresh**: one `listDiscussions`, one narrow write.
 *
 * A project whose git binding is gone writes **nothing**: `{open: 0}` would say the threads were
 * read (the window's own rule).
 */
export const runReviewThreadsRefresh = async (
  options: ReviewThreadsRefreshOptions,
  data: PipelineOutboundData,
): Promise<void> => {
  const logger: Logger = options.logger ?? silentLogger;
  const taskId = data.task_id as Id | undefined;
  const iid = typeof data.iid === 'number' ? data.iid : null;
  if (taskId === undefined || iid === null) {
    logger.warn(
      { project_id: data.project_id },
      'review threads refresh: the wake-up named no task',
    );
    return;
  }
  const stored = await options.unitOfWork.transaction(async (scope) =>
    options.store.tasks.load(scope.tx, taskId),
  );
  if (
    stored === null ||
    stored.task.state !== 'ready_for_merge' ||
    stored.mr === null ||
    stored.mr.iid !== iid
  ) {
    logger.debug(
      { task_id: taskId, iid },
      'review threads refresh: the task no longer waits on this merge request; nothing is read',
    );
    return;
  }
  const integrations = await integrationsForProject(
    options.integrations,
    stored.task.projectId,
    noRunScopedSecrets(),
  );
  if (integrations.git === null) {
    logger.debug({ task_id: taskId }, 'review threads refresh: no git binding to read');
    return;
  }
  const discussions = await gitReads(integrations).discussions(stored.mr, {
    projectId: stored.task.projectId,
    taskId,
  });
  const counts = reviewThreadCounts(discussions, options.clock.now());
  await options.unitOfWork.transaction(async (scope) =>
    options.store.tasks.saveReviewThreads(scope.tx, taskId, counts),
  );
  logger.info(
    { task_id: taskId, iid, open: counts.open, resolved: counts.resolved },
    'review threads refresh: re-counted the merge request’s threads after a resolution',
  );
};

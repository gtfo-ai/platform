/**
 * **Ready before CI** — WP-138 ruling (g).
 *
 * The developer opens its merge request as a draft, and a project may skip merge-request pipelines
 * for a draft title (the product owner's Autix does: `Draft:` is excluded by its `rules:`). GitLab
 * documents three events that start a merge-request pipeline — a new merge request from a branch
 * with commits, a push to its source branch, and the merge request's *Run pipeline* button — and
 * marking a draft ready is not one of them
 * (<https://docs.gitlab.com/ci/pipelines/merge_request_pipelines/>, read 2026-10-03; measuring it on a
 * real project is `docs/TODO.md`'s row). So when the Developer stage completes:
 *
 *  1. a handler on `task.stage.completed` for the stage that produces `ImplementationNotes`
 *     (priority 120, the integrations band, beside the dependency gate) enqueues the `mr_ready`
 *     duty after its commit — it decides, the job calls (WP-15d);
 *  2. the duty marks the merge request ready (the provider's own draft-prefix rewrite; an update of
 *     a merge request that is already ready changes nothing), and — when the head the answer names
 *     has **no** pipeline and the default branch has a CI file **or the platform cannot tell**
 *     (no mirror, a fetch that failed) — asks the provider for a merge-request pipeline (the *Run
 *     pipeline* button's API), keyed per head sha. Asking when unsure costs at worst one refused
 *     request; not asking leaves the CI gate waiting on a pipeline nobody started (review round 1).
 *
 * Both calls are the executor's: a shadow task records `would_have` and changes nothing on the
 * provider. A provider that refuses to create such a pipeline (`invalid_request` — a CI
 * configuration with no job for one) is logged and left: the CI gate then waits on a head with no
 * pipeline (ruling (f)) and WP-136 bounds that wait. The duty's exhaustion is bound-and-escalate:
 * a draft nobody marks ready is a CI gate that waits for a pipeline the project never runs.
 */
import type { Id } from '@platform/contracts';
import { compilePipeline, stageOf } from '@platform/domain';
import type { EventHandler, HandlerContext } from '../events/handler.js';
import { IntegrationError } from '../ports/integrations/common.js';
import { type Logger, silentLogger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { ciConfigOnDefaultBranch } from './gates.js';
import {
  codeMergeRequestWrites,
  gitReads,
  integrationsForProject,
  noRunScopedSecrets,
} from './integrations.js';
import { enqueueOutbound, type PipelineOutboundData } from './jobs.js';
import type { PipelineSagaOptions } from './saga.js';

const IMPLEMENTATION_ARTIFACT = 'ImplementationNotes';

/** `task.stage.completed` for the Developer stage → mark the merge request ready, in a job. */
const mergeRequestReadyHandler = (options: PipelineSagaOptions): EventHandler => ({
  name: 'pipeline.merge-request.ready',
  priority: 120,
  eventTypes: ['task.stage.completed'],
  handle: async (context: HandlerContext) => {
    const event = context.event.event;
    if (event.type !== 'task.stage.completed') {
      return;
    }
    const stored = await options.store.tasks.load(context.scope.tx, event.payload.task_id);
    if (stored === null) {
      return;
    }
    const pipeline = compilePipeline(stored.task.template, stored.template, stored.pipelineDial);
    if (stageOf(pipeline, event.payload.stage)?.produces !== IMPLEMENTATION_ARTIFACT) {
      return;
    }
    const data: PipelineOutboundData = {
      duty: 'mr_ready',
      project_id: event.payload.project_id,
      task_id: event.payload.task_id,
      cause_event_id: event.id,
    };
    context.afterCommit(async () => {
      await enqueueOutbound(options.jobs, data);
    });
  },
});

export const mergeRequestReadyHandlers = (
  options: PipelineSagaOptions,
): readonly EventHandler[] => [mergeRequestReadyHandler(options)];

export type MergeRequestReadyOutcome =
  | 'no_task'
  | 'no_merge_request'
  | 'no_binding'
  | 'marked_ready'
  /** A shadow task: `would_have` rows, nothing changed on the provider and no pipeline asked for. */
  | 'shadow';

/**
 * `pipeline.outbound` duty **mr_ready**. Re-validates on fire (TD-004): a task that is gone, ended
 * or has no merge request any more is left alone. Answers what it did and whether it asked for a
 * pipeline, for the log and the tests.
 */
export const runMergeRequestReady = async (
  options: PipelineSagaOptions & { readonly unitOfWork: UnitOfWork },
  data: PipelineOutboundData,
): Promise<{ readonly outcome: MergeRequestReadyOutcome; readonly pipeline: boolean }> => {
  const logger: Logger = options.logger ?? silentLogger;
  const taskId = data.task_id as Id | undefined;
  if (taskId === undefined) {
    return { outcome: 'no_task', pipeline: false };
  }
  const stored = await options.unitOfWork.transaction(async (scope) =>
    options.store.tasks.load(scope.tx, taskId),
  );
  if (stored === null || stored.task.state === 'done' || stored.task.state === 'cancelled') {
    return { outcome: 'no_task', pipeline: false };
  }
  const mr = stored.mr;
  if (mr === null) {
    return { outcome: 'no_merge_request', pipeline: false };
  }
  // Outside every transaction (WP-15d), and outside a run: the scope holds no minted credential.
  const integrations = await integrationsForProject(
    options.integrations,
    stored.task.projectId,
    noRunScopedSecrets(),
  );
  if (integrations.git === null) {
    return { outcome: 'no_binding', pipeline: false };
  }
  const context = {
    projectId: stored.task.projectId,
    taskId,
    mode: stored.task.mode,
  };
  const writes = codeMergeRequestWrites(integrations);
  const ready = await writes.markReady(
    { ref: mr, idempotencyKey: `mr_ready:${taskId}:${mr.iid}:${String(data.cause_event_id)}` },
    context,
  );
  if (stored.task.mode === 'shadow' || ready === null) {
    return { outcome: 'shadow', pipeline: false };
  }
  const outcome: MergeRequestReadyOutcome = 'marked_ready';
  // The head the provider's answer names — the live one, not the record's, which may lag a push.
  const head = ready.ref.head_sha ?? ready.head_sha;
  // The CI file first: a project known to have none is never asked for a pipeline, so its head is
  // not read. One the platform cannot read is asked (review round 1: at worst a refused request).
  const ci = await ciConfigOnDefaultBranch(options.repositoryFiles, stored.task.projectId);
  if (ci.kind === 'absent') {
    logger.info(
      { task_id: taskId, iid: mr.iid },
      'mr_ready: the default branch has no CI file; no pipeline is requested',
    );
    return { outcome, pipeline: false };
  }
  const status = await gitReads(integrations).pipelineStatus(head, context);
  if (status !== null) {
    return { outcome, pipeline: false };
  }
  try {
    await writes.createPipeline(
      { ref: mr, idempotencyKey: `mr_pipeline:${taskId}:${mr.iid}:${head}` },
      context,
    );
  } catch (error) {
    if (!(error instanceof IntegrationError) || error.code !== 'invalid_request') {
      throw error;
    }
    logger.warn(
      { task_id: taskId, iid: mr.iid, err: error },
      'mr_ready: the provider refused a merge-request pipeline; the CI gate waits for one (WP-136 bounds the wait)',
    );
    return { outcome, pipeline: false };
  }
  return { outcome, pipeline: true };
};

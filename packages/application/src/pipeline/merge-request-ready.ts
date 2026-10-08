/**
 * **The merge request stays a draft until Ready** — the product owner's decision of 2026-10-06
 * (first local test, PROGRESS backlog 486), which reverses WP-138 ruling (g)'s *"ready before CI"*.
 *
 * WP-138 marked the developer's draft merge request ready as soon as the Developer stage completed,
 * because the product owner's Autix skips merge-request pipelines for a `Draft:` title. The product
 * owner's words reverse it: *"Not marking the MR ready until it is green and verified."* A person
 * looking at the provider should see a draft while CI and the review stages run, and a ready merge
 * request only once the platform has nothing left to check. A project whose CI rules skip or hold
 * jobs for drafts now has to let an agent's draft run them (Autix's rule is changed for `agentic/*`
 * source branches); the CI gate says so plainly while it waits (`gates.ts`, held at a manual job)
 * and the readiness CI-rules check models the merge-request pipeline of a draft (`ci-rules.ts`).
 *
 * Three duties, each a handler that decides inside its transaction and a `pipeline.outbound` job
 * that calls outside every transaction (WP-15d), all at TD-005 priority 120 (the integrations band):
 *
 *  1. **`mr_pipeline`** — on `task.stage.completed` for the stage that produces `ImplementationNotes`.
 *     It no longer marks anything ready: it reads the merge request's live head and, when that head
 *     has **no** pipeline — or one held at a `manual` job (backlog 459) — and the default branch has a
 *     CI file **or the platform cannot tell**, asks the provider for a merge-request pipeline (the
 *     *Run pipeline* button's API), keyed per head sha. GitLab documents three events that start a
 *     merge-request pipeline — a new merge request from a branch with commits, a push to its source
 *     branch, and that button (<https://docs.gitlab.com/ci/pipelines/merge_request_pipelines/>, read
 *     2026-10-03). Asking when unsure costs at worst one refused request; not asking leaves the CI
 *     gate waiting on a pipeline nobody started (WP-138 review round 1).
 *  2. **`mr_ready`** — on `task.stage.entered` for `ready_for_merge`: reads the merge request and
 *     removes the draft prefix when it has one (a re-entry nothing drafted writes nothing). Every
 *     way into Ready is that event — the rebase gate's pass, a resume from a pause at Ready, the
 *     `ready_head_check` duty's entry — so each one is covered, keyed per entry.
 *  3. **`mr_draft`** — on `task.stage.entered` for an **agent** stage of a task that has been at
 *     `ready_for_merge` before (`stageAttempts.ready_for_merge ≥ 1`): an agent is about to change
 *     the merge request again (a reviewer's comments sent it back, the rebase gate's conflict
 *     resolution, a person's return), so it is put back to draft until the task is Ready again. A
 *     **gate** re-entry from Ready (a default-branch move re-checks the rebase gate, a person's push
 *     re-runs the CI gate) does not: nothing of the platform's changes the merge request there, and
 *     toggling draft on every default-branch move would be noise on the provider for no change.
 *     The duty reads the merge request first and writes only when it is open and not a draft.
 *     A person who marks it ready by hand meanwhile is overruled the same way, deliberately: the
 *     decision is that it is ready only when the platform has nothing left to check.
 *
 * All calls are the executor's: a shadow task records `would_have` and changes nothing on the
 * provider. A provider that refuses to create a pipeline (`invalid_request` — a CI configuration
 * with no job for one) is logged and left: the CI gate then waits on a head with no pipeline
 * (ruling (f)) and WP-136 bounds that wait.
 *
 * Exhaustion (`ports/job-exhaustion.ts`): `mr_pipeline` and `mr_ready` are bound-and-escalate — a
 * CI gate waiting for a pipeline nobody asked for, and a task at Ready whose merge request a person
 * cannot merge because it is still a draft; `mr_draft` is listed only — the next entry into Ready
 * marks it ready again, and nobody waits on the draft.
 */
import type { Id } from '@platform/contracts';
import { compilePipeline, READY_FOR_MERGE_STAGE, stageOf } from '@platform/domain';
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
  type PipelineIntegrations,
} from './integrations.js';
import { enqueueOutbound, type PipelineOutboundData } from './jobs.js';
import type { PipelineSagaOptions } from './saga.js';
import type { StoredTask } from './store.js';

const IMPLEMENTATION_ARTIFACT = 'ImplementationNotes';

type MergeRequestDuty = 'mr_pipeline' | 'mr_ready' | 'mr_draft';

const enqueueAfterCommit = (
  options: PipelineSagaOptions,
  context: HandlerContext,
  duty: MergeRequestDuty,
  payload: { readonly project_id: string; readonly task_id: string },
): void => {
  const data: PipelineOutboundData = {
    duty,
    project_id: payload.project_id,
    task_id: payload.task_id,
    cause_event_id: context.event.event.id,
  };
  context.afterCommit(async () => {
    await enqueueOutbound(options.jobs, data);
  });
};

/** `task.stage.completed` for the Developer stage → ask for a pipeline if it needs one, in a job. */
const mergeRequestPipelineHandler = (options: PipelineSagaOptions): EventHandler => ({
  name: 'pipeline.merge-request.pipeline',
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
    const pipeline = compilePipeline(
      stored.task.template,
      stored.template,
      stored.pipelineDial,
      stored.qaStage,
    );
    if (stageOf(pipeline, event.payload.stage)?.produces !== IMPLEMENTATION_ARTIFACT) {
      return;
    }
    enqueueAfterCommit(options, context, 'mr_pipeline', event.payload);
  },
});

/**
 * `task.stage.entered` → `mr_ready` for Ready, `mr_draft` for an agent stage after Ready. One
 * handler for the one event type, because both answers read the same loaded row.
 */
const mergeRequestDraftStateHandler = (options: PipelineSagaOptions): EventHandler => ({
  name: 'pipeline.merge-request.draft-state',
  priority: 120,
  eventTypes: ['task.stage.entered'],
  handle: async (context: HandlerContext) => {
    const event = context.event.event;
    if (event.type !== 'task.stage.entered') {
      return;
    }
    const stored = await options.store.tasks.load(context.scope.tx, event.payload.task_id);
    if (stored === null || stored.mr === null) {
      return;
    }
    if (event.payload.stage === READY_FOR_MERGE_STAGE) {
      enqueueAfterCommit(options, context, 'mr_ready', event.payload);
      return;
    }
    if ((stored.task.stageAttempts[READY_FOR_MERGE_STAGE] ?? 0) < 1) {
      return;
    }
    const pipeline = compilePipeline(
      stored.task.template,
      stored.template,
      stored.pipelineDial,
      stored.qaStage,
    );
    if (stageOf(pipeline, event.payload.stage)?.kind !== 'agent') {
      return;
    }
    enqueueAfterCommit(options, context, 'mr_draft', event.payload);
  },
});

export const mergeRequestReadyHandlers = (
  options: PipelineSagaOptions,
): readonly EventHandler[] => [
  mergeRequestPipelineHandler(options),
  mergeRequestDraftStateHandler(options),
];

type DutyOptions = PipelineSagaOptions & { readonly unitOfWork: UnitOfWork };

/** What every duty answers before it calls: there is nothing to do, or here is what to do it on. */
type Resolved =
  | { readonly kind: 'skip'; readonly outcome: 'no_task' | 'no_merge_request' | 'no_binding' }
  | {
      readonly kind: 'go';
      readonly stored: StoredTask;
      readonly taskId: Id;
      readonly mr: NonNullable<StoredTask['mr']>;
      readonly integrations: PipelineIntegrations;
      readonly context: {
        readonly projectId: Id;
        readonly taskId: Id;
        readonly mode: StoredTask['task']['mode'];
      };
    };

/**
 * Re-validates on fire (TD-004) — a task that is gone, ended, in a state `admits` refuses, or has no
 * merge request is left alone — and resolves the project's bindings outside every transaction
 * (WP-15d) and outside a run, so the scope holds no minted credential.
 */
const resolve = async (
  options: DutyOptions,
  data: PipelineOutboundData,
  admits: (state: StoredTask['task']['state']) => boolean,
): Promise<Resolved> => {
  const taskId = data.task_id as Id | undefined;
  if (taskId === undefined) {
    return { kind: 'skip', outcome: 'no_task' };
  }
  const stored = await options.unitOfWork.transaction(async (scope) =>
    options.store.tasks.load(scope.tx, taskId),
  );
  if (stored === null || !admits(stored.task.state)) {
    return { kind: 'skip', outcome: 'no_task' };
  }
  const mr = stored.mr;
  if (mr === null) {
    return { kind: 'skip', outcome: 'no_merge_request' };
  }
  const integrations = await integrationsForProject(
    options.integrations,
    stored.task.projectId,
    noRunScopedSecrets(),
  );
  if (integrations.git === null) {
    return { kind: 'skip', outcome: 'no_binding' };
  }
  return {
    kind: 'go',
    stored,
    taskId,
    mr,
    integrations,
    context: { projectId: stored.task.projectId, taskId, mode: stored.task.mode },
  };
};

export type MergeRequestPipelineOutcome =
  | 'no_task'
  | 'no_merge_request'
  | 'no_binding'
  /** The merge request is merged or closed on the provider: nothing to start a pipeline for. */
  | 'not_open'
  /** The head has a pipeline that is not held, or the default branch has no CI file. */
  | 'not_needed'
  | 'requested'
  /** The provider refused the pipeline (`invalid_request`); the CI gate's wait is the ending. */
  | 'refused'
  /** A shadow task: `would_have`, nothing asked of the provider. */
  | 'shadow';

/**
 * `pipeline.outbound` duty **mr_pipeline**: a merge-request pipeline for the Developer's head when
 * it has none or its pipeline is held at a manual job. Never marks the merge request ready.
 */
export const runMergeRequestPipeline = async (
  options: DutyOptions,
  data: PipelineOutboundData,
): Promise<MergeRequestPipelineOutcome> => {
  const logger: Logger = options.logger ?? silentLogger;
  const resolved = await resolve(
    options,
    data,
    (state) => state !== 'done' && state !== 'cancelled',
  );
  if (resolved.kind === 'skip') {
    return resolved.outcome;
  }
  const { stored, taskId, mr, integrations, context } = resolved;
  // The head the provider names now — the live one, not the record's, which may lag a push.
  const live = await gitReads(integrations).mergeRequest(mr, context);
  if (live !== null && live.state !== 'opened') {
    return 'not_open';
  }
  const head = live?.ref.head_sha ?? live?.head_sha ?? mr.head_sha ?? null;
  if (head === null) {
    return 'not_needed';
  }
  // The CI file first: a project known to have none is never asked for a pipeline, so its head is
  // not read. One the platform cannot read is asked (review round 1: at worst a refused request).
  // Since WP-139 the file is the one the provider names (GitLab's `ci_config_path`), and a
  // configuration outside the repository counts as present.
  const ci = await ciConfigOnDefaultBranch(options.repositoryFiles, integrations, {
    projectId: stored.task.projectId,
    taskId,
  });
  if (ci.kind === 'absent') {
    logger.info(
      { task_id: taskId, iid: mr.iid, ci_config_path: ci.path },
      'mr_pipeline: the default branch has no CI file; no pipeline is requested',
    );
    return 'not_needed';
  }
  /**
   * **A pipeline held at a manual job is not evidence either** (first local test, 2026-10-06,
   * backlog 459). A project may hold jobs for a draft: Autix's `Draft:` rule made `build_composer`
   * manual, and `phpstan`, `codesniffer` and `codeception` all need it, so the draft's pipeline is
   * created and ends `manual`. So a pipeline whose status is `manual`, or which holds a job waiting
   * at `manual`, gets a fresh merge-request pipeline asked for, still once per head (the key).
   * Since backlog 486 the merge request is still a draft when this runs, so on a project whose
   * rules hold jobs for drafts the fresh pipeline is held too — and the CI gate's pending detail
   * says so plainly; the fix is the project's CI rule, which the readiness check names.
   *
   * The first version of backlog 459's fix asked whenever the duty took a draft off, which re-ran
   * every project's pipeline and left the fake-Claude tier's scripted pipelines waiting on one
   * nobody finished (eight e2e cases stuck at `ci_gate`); a held job is the evidence that mattered.
   */
  const status = await gitReads(integrations).pipelineStatus(head, context);
  // A **blocking** manual job only (`allow_failure: false`): an optional one — Autix's image builds
  // are `when: manual, allow_failure: true` in every merge-request pipeline — holds nothing, and
  // counting it asked for a second pipeline on every Developer completion (first local test,
  // 2026-10-06, backlog 459's follow-up).
  const heldAtManual =
    status !== null &&
    (status.status === 'manual' ||
      status.jobs.some((job) => job.status === 'manual' && !job.allow_failure));
  if (status !== null && !heldAtManual) {
    return 'not_needed';
  }
  const writes = codeMergeRequestWrites(integrations);
  try {
    const created = await writes.createPipeline(
      { ref: mr, idempotencyKey: `mr_pipeline:${taskId}:${mr.iid}:${head}` },
      context,
    );
    return created === null ? 'shadow' : 'requested';
  } catch (error) {
    if (!(error instanceof IntegrationError) || error.code !== 'invalid_request') {
      throw error;
    }
    logger.warn(
      { task_id: taskId, iid: mr.iid, err: error },
      'mr_pipeline: the provider refused a merge-request pipeline; the CI gate waits for one (WP-136 bounds the wait)',
    );
    return 'refused';
  }
};

export type MergeRequestReadyOutcome =
  | 'no_task'
  | 'no_merge_request'
  | 'no_binding'
  /** Already ready, or merged or closed: nothing to take off. */
  | 'unchanged'
  | 'marked_ready'
  /** A shadow task: a `would_have` row, nothing changed on the provider. */
  | 'shadow';

/**
 * `pipeline.outbound` duty **mr_ready**: the merge request marked ready because the task is at
 * `ready_for_merge`. A task that has left Ready by the time the job fires (a reviewer's comment sent
 * it back, a person paused it) is left alone — `mr_draft` owns that direction.
 */
export const runMergeRequestReady = async (
  options: DutyOptions,
  data: PipelineOutboundData,
): Promise<MergeRequestReadyOutcome> => {
  const resolved = await resolve(options, data, (state) => state === 'ready_for_merge');
  if (resolved.kind === 'skip') {
    return resolved.outcome;
  }
  const { taskId, mr, integrations, context } = resolved;
  // Read first, as `mr_draft` does: a re-entry into Ready that nothing drafted in between (a
  // default-branch move re-checks the rebase gate and comes straight back) writes nothing.
  const live = await gitReads(integrations).mergeRequest(mr, context);
  if (live === null || live.state !== 'opened' || !live.draft) {
    return 'unchanged';
  }
  const ready = await codeMergeRequestWrites(integrations).markReady(
    { ref: mr, idempotencyKey: `mr_ready:${taskId}:${mr.iid}:${String(data.cause_event_id)}` },
    context,
  );
  return ready === null ? 'shadow' : 'marked_ready';
};

export type MergeRequestDraftOutcome =
  | 'no_task'
  | 'no_merge_request'
  | 'no_binding'
  /** Already a draft, or merged or closed: nothing to put back. */
  | 'unchanged'
  | 'marked_draft'
  | 'shadow';

/**
 * `pipeline.outbound` duty **mr_draft**: the merge request put back to draft because an agent stage
 * is changing it again. Only while the task is `active` — at Ready (it came back faster than this
 * job fired) or beyond, the merge request is meant to be ready.
 */
export const runMergeRequestDraft = async (
  options: DutyOptions,
  data: PipelineOutboundData,
): Promise<MergeRequestDraftOutcome> => {
  const resolved = await resolve(options, data, (state) => state === 'active');
  if (resolved.kind === 'skip') {
    return resolved.outcome;
  }
  const { taskId, mr, integrations, context } = resolved;
  const live = await gitReads(integrations).mergeRequest(mr, context);
  if (live === null || live.state !== 'opened' || live.draft) {
    return 'unchanged';
  }
  const drafted = await codeMergeRequestWrites(integrations).markDraft(
    { ref: mr, idempotencyKey: `mr_draft:${taskId}:${mr.iid}:${String(data.cause_event_id)}` },
    context,
  );
  return drafted === null ? 'shadow' : 'marked_draft';
};

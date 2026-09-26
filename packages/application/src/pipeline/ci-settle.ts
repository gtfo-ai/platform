/**
 * Settling the CI gate from a finished pipeline — **only for the merge request's live head**
 * (WP-60 review round 2).
 *
 * ## What was wrong
 *
 * The saga's `ci.pipeline.finished` handler settled the gate from **any** finished pipeline for the
 * merge request's iid, without comparing the pipeline's `head_sha` with anything: a green pipeline
 * for a commit that was no longer the branch's head passed the gate. That predates WP-60 — and WP-60
 * made it sharper, because the recorded head can now move when a human pushes and briefly hold an
 * older revision while deliveries are in flight (`provider-signals.ts` states the window).
 *
 * ## The shape, and why it is a duty
 *
 * The question *"is this the head?"* is only honest against the provider's **live** answer, and a
 * handler runs inside the dispatch transaction, where no provider call may be made (WP-15d). So the
 * handler **decides** that a pipeline for a task at a CI gate finished, and this `pipeline.outbound`
 * duty **reads** the merge request (one `get_merge_request`, through the executor) and settles only
 * when the finished pipeline ran on the live head. Any other pipeline is ignored, by name in the
 * log: an older one is history, and a newer one will announce itself. The poll path
 * (`gates.ts`, `stage.execute`) asks the same live head.
 *
 * Settling goes through `settleGate` (`jobs.ts`), which re-validates the task in its own
 * transaction, applies the product/04 S4 convergence rule (three identical failures escalate) and
 * enqueues the next stage — so both paths share one settlement and one convergence rule.
 *
 * **The read count this costs**: one `get_merge_request` per finished pipeline for a task waiting
 * at a CI gate, and one per poll of the gate (`gates.ts`). A pipeline for a task *not* at the gate
 * costs nothing — the handler filters it before enqueueing.
 */
import type { Id } from '@platform/contracts';
import { compilePipeline, stageOf } from '@platform/domain';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { ciFailureSignature } from './gates.js';
import { gitReads, integrationsForProject, noRunScopedSecrets } from './integrations.js';
import { type PipelineOutboundData, settleGate } from './jobs.js';
import type { PipelineSagaOptions } from './saga.js';

export interface CiSettleOptions extends PipelineSagaOptions {
  readonly unitOfWork: UnitOfWork;
}

export const runCiSettle = async (
  options: CiSettleOptions,
  data: PipelineOutboundData,
): Promise<void> => {
  const logger: Logger = options.logger ?? silentLogger;
  const taskId = data.task_id as Id | undefined;
  const stage = data.stage;
  const headSha = data.head_sha;
  const status = data.ci_status;
  if (
    taskId === undefined ||
    stage === undefined ||
    headSha === undefined ||
    status === undefined
  ) {
    logger.warn(
      { duty: data.duty, task_id: taskId ?? null },
      'ci_settle woken without its payload',
    );
    return;
  }
  const stored = await options.unitOfWork.transaction(async (scope) =>
    options.store.tasks.load(scope.tx, taskId),
  );
  if (stored === null || stored.mr === null || stored.task.state !== 'active') {
    return;
  }
  if (stored.task.currentStage !== stage) {
    return;
  }
  const waiting = stageOf(compilePipeline(stored.task.template, stored.template), stage);
  if (waiting?.kind !== 'gate') {
    return;
  }

  // Outside every transaction (WP-15d); a run's credential is not in scope (Q55).
  const integrations = await integrationsForProject(
    options.integrations,
    stored.task.projectId,
    noRunScopedSecrets(),
  );
  const live = await gitReads(integrations).mergeRequest(stored.mr, {
    projectId: stored.task.projectId,
    taskId,
  });
  const liveHead = live?.ref.head_sha ?? null;
  if (liveHead !== headSha) {
    logger.info(
      { task_id: taskId, pipeline_head: headSha, live_head: liveHead },
      'a pipeline finished for a revision that is not the merge request’s head; the CI gate ignores it',
    );
    return;
  }

  const failing = [...(data.failed_jobs ?? [])].sort();
  const passed = status === 'success';
  await settleGate(
    options,
    { taskId, stage },
    {
      kind: 'gate_settled',
      stage,
      passed,
      detail: passed
        ? `pipeline for ${headSha} succeeded`
        : `pipeline for ${headSha} ${status}${failing.length === 0 ? '' : `: ${failing.join(', ')}`}`,
      ...(passed ? {} : { ciSignature: ciFailureSignature(status, failing, headSha) }),
    },
  );
};

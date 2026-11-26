/**
 * **A pipeline result that arrives after the CI gate stopped waiting** resumes the task (BD-034,
 * BACKLOG 1658).
 *
 * The CI gate parks a task when its wait ends (`ci-wait.ts`): a `manual` pipeline or no pipeline at
 * the CI timeout, or a pipeline still progressing at the 24-hour ceiling. Until 2026-11-26 the
 * pipeline's own `ci.pipeline.finished`, arriving later, reached `ci-settle.ts` and was dropped
 * because the task was no longer `active` — so a person had to notice that the pipeline had
 * finished and hand the task back at `ci_gate`, which is exactly what the platform can do itself.
 *
 * ## What resumes, and what never does
 *
 * Only a task the CI gate's **own wait** parked, and only for the result that wait was waiting for.
 * Every one of these is required, read again inside the resuming transaction where it can change:
 *
 *  - the task is `needs_human` at a gate that waits on `ci.pipeline.finished`, and the gate's
 *    current attempt is **closed with `ci_ending = 'ci_timed_out'`** (`task_stages.ci_ending`, written
 *    in the parking transaction, backlog 1078). A task parked there for anything else — three
 *    identical failures (convergence), a held `manual` pipeline unchanged on retry
 *    (`ci_held_unchanged`), a conflict, a dead letter, a refused template — has another ending or
 *    none, and is left for its person;
 *  - **no approval is pending** — only an approval's own decision moves such a task (S-27.1);
 *  - the merge request is still **open** and its live head is the commit the pipeline ran on — a
 *    closed or merged merge request, or an older head, is history, as `ci-settle.ts` treats it;
 *  - the event is a **result** (`ci.pipeline.finished`); a held pipeline (`ci.pipeline.held`) is
 *    not, and wakes nothing here.
 *
 * **Decided, not overlooked** (review of BD-034's follow-ups): a brief **added** to the parked task
 * afterwards (`amendEscalation`, e.g. a provider fact that arrived while it waited) does not stop the
 * resume — the state is still the CI wait's ending, and the resumed gate re-reads the merge request
 * itself; a fact that ends the task (the merge request closed or merged) is refused above by the live
 * read.
 *
 * ## How it resumes
 *
 * It re-enters the gate as the pipeline itself would — `applyDecision` with an `enter` decision, by
 * the **pipeline** actor, with a `task.resumed` saying why — so the task leaves `needs_human` at a
 * **new** `ci_gate` attempt, no `human_actions` row is written and no loop is spent (BD-008's
 * human rounds are a person's). It does **not** settle the gate itself: the new attempt's own first
 * check reads the finished pipeline for the live head and settles it through the one settlement
 * every path shares (`judgeCiSettlement` → `settleGate`), so the tamper check (BD-024 §2) and the
 * three-identical-failures rule still apply — a green pipeline moves on, a red one returns to
 * `ci_fix`, spending its loop as any failure does.
 *
 * ## Why it is bounded
 *
 * Each resume needs a real pipeline result for the live head, and opens an attempt whose
 * `ci_ending` is empty, so the same result cannot resume twice; the resumed gate reads a finished
 * pipeline and settles it at its first check, so it does not time out again on the same head. A
 * later head is a new pipeline, and the CI-fix loop and convergence bound what follows.
 *
 * **What it does not cover**: a poll-only binding receives no late event, so a task its CI wait
 * parked is still resumed by a person (BACKLOG has the line).
 */
import type { Id } from '@platform/contracts';
import {
  type CommandContext,
  compilePipeline,
  IllegalTransitionError,
  stageOf,
} from '@platform/domain';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import { pendingApproval } from './approval-wait.js';
import type { CiSettleOptions } from './ci-settle.js';
import { gitReads, integrationsForProject, noRunScopedSecrets } from './integrations.js';
import { enqueueStage, inTaskTransaction, type PipelineOutboundData } from './jobs.js';
import { PIPELINE_ACTOR, type StoredTask } from './store.js';
import { applyDecision } from './transitions.js';

/** The `task.resumed` reason a late result writes — platform text only. */
export const LATE_CI_RESULT_REASON =
  'the pipeline the CI gate stopped waiting for has finished, so the platform resumed the gate to judge it';

/** Is `stored` a task the CI gate's own wait parked at `stage`, as far as the row can say? */
const parkedByCiWait = async (
  options: CiSettleOptions,
  tx: Parameters<CiSettleOptions['store']['tasks']['load']>[0],
  stored: StoredTask,
  stage: string,
): Promise<boolean> => {
  const { task } = stored;
  if (task.state !== 'needs_human' || task.currentStage !== stage) {
    return false;
  }
  const waiting = stageOf(
    compilePipeline(task.template, stored.template, stored.pipelineDial, stored.qaStage),
    stage,
  );
  if (
    waiting?.kind !== 'gate' ||
    !waiting.on.some((entry) => entry.on === 'ci.pipeline.finished')
  ) {
    return false;
  }
  const attempt = task.stageAttempts[stage];
  if (attempt === undefined) {
    return false;
  }
  const entry = await options.store.tasks.stageAttemptEntry(tx, task.id, stage, attempt);
  return entry !== null && !entry.open && entry.ciEnding === 'ci_timed_out';
};

/**
 * The late result's whole path, from `ci_settle` for a task in `needs_human`: answers whether it
 * resumed the task. Never throws for the task's state; a provider read that fails throws to the
 * duty's retry, like every other read of the duty.
 */
export const resumeOnLateCiResult = async (
  options: CiSettleOptions,
  data: PipelineOutboundData,
  stored: StoredTask,
): Promise<boolean> => {
  const logger: Logger = options.logger ?? silentLogger;
  const taskId = stored.task.id;
  const stage = data.stage;
  const headSha = data.head_sha;
  // A held pipeline is not a result; a payload with no status is not one either.
  if (
    stage === undefined ||
    headSha === undefined ||
    data.ci_held === true ||
    data.ci_status === undefined ||
    stored.mr === null
  ) {
    return false;
  }
  const parked = await options.unitOfWork.transaction(async (scope) =>
    parkedByCiWait(options, scope.tx, stored, stage),
  );
  if (!parked) {
    return false;
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
  if (live === null || live.state !== 'opened' || live.ref.head_sha !== headSha) {
    logger.info(
      {
        task_id: taskId,
        pipeline_head: headSha,
        live_head: live?.ref.head_sha ?? null,
        live_state: live?.state ?? null,
      },
      'a pipeline finished after the CI gate parked its task, but not on the open merge request’s head; the task stays with its person',
    );
    return false;
  }
  const work = await inTaskTransaction(
    options,
    taskId,
    'resuming a CI gate on a late pipeline result',
    async (scope) => {
      const current = await options.store.tasks.load(scope.tx, taskId);
      if (current === null || !(await parkedByCiWait(options, scope.tx, current, stage))) {
        return null;
      }
      // S-27.1: only an approval's own decision moves a task that has one pending.
      if ((await pendingApproval(options.store, scope.tx, taskId)) !== null) {
        return null;
      }
      const context: CommandContext = {
        ids: options.ids,
        actor: PIPELINE_ACTOR,
        clock: options.clock as CommandContext['clock'],
        correlationId: taskId,
        causeEventId: (data.cause_event_id ?? null) as Id | null,
      };
      const applied = await applyDecision({
        offerClosing: { events: scope.events, broadcast: scope.broadcast },
        store: options.store,
        pipeline: compilePipeline(
          current.task.template,
          current.template,
          current.pipelineDial,
          current.qaStage,
        ),
        tx: scope.tx,
        stored: current,
        decision: { kind: 'enter', stage },
        context,
        causedByEventId: (data.cause_event_id ?? null) as Id | null,
        resumeReason: LATE_CI_RESULT_REASON,
        // A refused edge is not a reason to park the task a second time: it stays as it was.
        onIllegalTransition: 'throw',
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      });
      await scope.events.append(applied.events);
      return applied.work;
    },
  ).catch((error: unknown) => {
    // Only the state machine's refusal is an ending here (a merged task, an edge the table lacks):
    // the task stays as its person found it. Anything else is the duty's to retry.
    if (!(error instanceof IllegalTransitionError)) {
      throw error;
    }
    logger.warn(
      { task_id: taskId, stage, err: error },
      'a late pipeline result could not resume its parked task; it stays with its person',
    );
    return null;
  });
  if (work === null) {
    return false;
  }
  logger.info(
    { task_id: taskId, stage, head_sha: headSha, ci_status: data.ci_status },
    'a pipeline finished after the CI gate parked its task: the gate is entered again to judge it',
  );
  await enqueueStage(options.jobs, work);
  return true;
};

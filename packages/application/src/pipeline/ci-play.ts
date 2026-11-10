/**
 * **The platform starts the manual CI jobs a project chose, and never the others** (S-28.7, the
 * M28 ruling on the owner's feedback of 2026-11-10).
 *
 * Autix's CI holds `build_composer` (and, once it has run, `codeception` and `crawler-test`) at
 * `manual` while the merge request's title is `Draft:` — and the platform keeps the merge request a
 * draft until Ready, so every task's CI gate waited up to its CI timeout for a person. A project now
 * says, per exact job name, in `pipeline.ci.manual_jobs` (project settings only): `run`, `wait` or
 * `ignore` (`ci-manual-jobs.ts`).
 *
 * ## Who decides and who calls
 *
 * The CI gate's judgement (`judgeCiPipeline`'s `toStart`) names the `run` jobs that are `manual`
 * now, on the poll (`gates.ts`, through `stage.execute`) and on a held pipeline's event
 * (`ci-settle.ts`). After its own transactions, that job enqueues one `pipeline.outbound` wake-up
 * per job — {@link enqueueCiPlays} — for every job this attempt has not recorded yet. Each poll and
 * each held hook re-judges, so the **second wave** (the test jobs that `needs:` a started build
 * job, `manual` only once it has succeeded) is started when it appears.
 *
 * ## What the duty re-validates on fire (TD-004: a wake-up is not a message)
 *
 * The task is still `active` at this `ci_gate` attempt, and the row is open; the merge request's
 * **live** head is the head the judgement read; that head's **latest** pipeline is the pipeline
 * named; the job is still `manual` and not a trigger job; and the project settings still say `run`
 * for its name. Anything else does nothing. Then one call, `playJob`, through
 * `IntegrationActionExecutor` with the idempotency key `ci_play:<task>:<pipeline id>:<job id>` —
 * provider ids that are **digits only** (refused otherwise), so no provider text is in the key and
 * a repeated wake-up plays a job at most once.
 *
 * ## What it records
 *
 * The outcome on the attempt (`task_stages.ci_manual_started`, migration 0113), one entry per job
 * id: `started`; `refused` — the provider refused the platform's account (`forbidden`, a `403`):
 * the job falls back to `wait`, and the gate's words say the platform's account may not start it;
 * `unsupported` — the binding cannot start a manual job at all (`capabilities().manualJobPlay`).
 * A recorded job is never offered again on this attempt. A job that is no longer playable (someone
 * started it meanwhile) records nothing: the next read sees it running.
 *
 * ## What it leaves to the gate
 *
 * The played job's **result** is the gate's: a `run` job is a required check, so its failure fails
 * the gate (`judgeCiPipeline`), whatever its `allow_failure`. The CI timeout is unchanged: it counts
 * from the gate's entry (`ci-wait.ts`), and a job the platform starts within one poll of the hold
 * runs inside the same budget as any job of the pipeline (BACKLOG 1544 holds the case of a pipeline
 * whose manual jobs alone outlast it).
 */

import type {
  CiManualStarted,
  CiManualStartedJob,
  CiManualStartOutcome,
  TaskMode,
} from '@platform/contracts';
import { type Id, type IsoDateTime, providerNumericIdSchema } from '@platform/contracts';
import { IntegrationError } from '../ports/integrations/common.js';
import type { PipelineStatus } from '../ports/integrations/git-provider.js';
import { JOB_QUEUES, type Jobs } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { manualJobModeOf, manualJobPolicyOf } from './ci-manual-jobs.js';
import { safeProviderUrl } from './ci-pending-read.js';
import { boundedJobName, CI_GATE_STAGE } from './gates.js';
import {
  codeMergeRequestWrites,
  gitReads,
  integrationsForProject,
  noRunScopedSecrets,
} from './integrations.js';
// Types only: `jobs.ts` imports this module, so a value import back would be a cycle.
import type { OutboundJobData, PipelineOutboundData } from './jobs.js';
import type { PipelineSagaOptions } from './saga.js';
import type { PipelineStore } from './store.js';

export interface CiPlayOptions extends PipelineSagaOptions {
  readonly unitOfWork: UnitOfWork;
}

type PipelineJob = PipelineStatus['jobs'][number];

/** One `run` job the judgement found `manual`, as the wake-up carries it. */
export interface CiPlayRequest {
  readonly taskId: Id;
  readonly projectId: Id;
  readonly attempt: number;
  /** The task's mode: a trial (`shadow`) task is offered no start at all (it would record none). */
  readonly mode: TaskMode;
  readonly headSha: string;
  readonly pipelineId: string;
  readonly jobs: readonly Pick<PipelineJob, 'id' | 'name'>[];
}

/** What {@link enqueueCiPlays} did, and what the attempt had recorded — the wait's words read both. */
export interface CiPlaysEnqueued {
  /** The job ids a wake-up was enqueued for. */
  readonly owed: ReadonlySet<string>;
  readonly recorded: CiManualStarted | null;
}

/** The idempotency key of one play — provider ids, digits only (the M28 ruling). */
export const ciPlayIdempotencyKey = (taskId: Id, pipelineId: string, jobId: string): string =>
  `ci_play:${taskId}:${pipelineId}:${jobId}`;

const isNumericId = (value: unknown): value is string =>
  providerNumericIdSchema.safeParse(value).success;

/**
 * **Enqueues one `ci_play_manual` wake-up per job this attempt has not recorded yet** — called by
 * the job that judged the pipeline (the gate's poll, or `ci-settle.ts`), after its transactions,
 * never from a handler. A job whose id or pipeline id is not digits only is not offered (the key
 * would carry provider text), and a trial (`shadow`) task is offered nothing: its play would ask
 * the provider nothing and record nothing, so every poll would offer it again. Answers the job ids
 * it enqueued and the attempt's record, which the wait's words are built from (`ciPlayDetail`).
 */
export const enqueueCiPlays = async (
  options: { readonly jobs: Jobs; readonly unitOfWork: UnitOfWork; readonly store: PipelineStore },
  request: CiPlayRequest,
  causeEventId: string,
): Promise<CiPlaysEnqueued> => {
  const recorded = await options.unitOfWork.transaction(async (scope) =>
    options.store.tasks.ciManualStartedOf(scope.tx, request.taskId, CI_GATE_STAGE, request.attempt),
  );
  if (request.mode === 'shadow' || !isNumericId(request.pipelineId)) {
    return { owed: new Set(), recorded };
  }
  const seen = new Set((recorded ?? []).map((entry) => entry.job_id));
  const owed = request.jobs.filter((job) => isNumericId(job.id) && !seen.has(job.id));
  for (const job of owed) {
    const data: PipelineOutboundData = {
      duty: 'ci_play_manual',
      project_id: request.projectId,
      task_id: request.taskId,
      cause_event_id: causeEventId,
      stage: CI_GATE_STAGE,
      ci_attempt: request.attempt,
      head_sha: request.headSha,
      ci_pipeline_id: request.pipelineId,
      ci_job_id: job.id,
    };
    // `enqueueOutbound`'s one line, written here because importing it would close a cycle.
    await options.jobs.enqueue<OutboundJobData>({ queue: JOB_QUEUES.pipelineOutbound, data });
  }
  return { owed: new Set(owed.map((job) => job.id)), recorded };
};

export type CiPlayOutcome =
  /** The payload is not one this build wrote (a field missing, or an id that is not digits). */
  | 'invalid_payload'
  /** The task is gone, stopped, past this `ci_gate` attempt, or its row is closed. */
  | 'moved_on'
  | 'no_binding'
  /** The merge request's live head is not the head the judgement read. */
  | 'head_moved'
  /** The head's latest pipeline is not the pipeline named. */
  | 'pipeline_moved'
  /** The job is not `manual` any more (someone started it), or is a trigger job, or is gone. */
  | 'not_manual'
  /** The project settings do not say `run` for the job's name any more. */
  | 'not_run'
  | 'started'
  | 'refused'
  | 'unsupported'
  /** The provider would not play it any more (`invalid_request`, `conflict`, `not_found`). */
  | 'not_playable'
  /** A shadow task: nothing was asked of the provider. */
  | 'shadow';

/** `pipeline.outbound` duty **ci_play_manual** — see the module docblock. */
export const runCiPlayManual = async (
  options: CiPlayOptions,
  data: PipelineOutboundData,
): Promise<CiPlayOutcome> => {
  const logger: Logger = options.logger ?? silentLogger;
  const taskId = data.task_id as Id | undefined;
  const attempt = data.ci_attempt;
  const headSha = data.head_sha;
  const pipelineId = data.ci_pipeline_id;
  const jobId = data.ci_job_id;
  if (
    taskId === undefined ||
    data.stage !== CI_GATE_STAGE ||
    typeof attempt !== 'number' ||
    !Number.isInteger(attempt) ||
    attempt < 1 ||
    typeof headSha !== 'string' ||
    !isNumericId(pipelineId) ||
    !isNumericId(jobId)
  ) {
    logger.warn(
      { duty: data.duty, task_id: taskId ?? null },
      'ci_play_manual woken without its payload',
    );
    return 'invalid_payload';
  }
  const entry = { taskId, stage: CI_GATE_STAGE, attempt };
  const loaded = await options.unitOfWork.transaction(async (scope) => ({
    stored: await options.store.tasks.load(scope.tx, taskId),
    row: await options.store.tasks.stageAttemptEntry(scope.tx, taskId, CI_GATE_STAGE, attempt),
  }));
  const stored = loaded.stored;
  if (
    stored === null ||
    stored.mr === null ||
    stored.task.state !== 'active' ||
    stored.task.currentStage !== CI_GATE_STAGE ||
    (stored.task.stageAttempts[CI_GATE_STAGE] ?? 0) !== attempt ||
    loaded.row?.open !== true
  ) {
    return 'moved_on';
  }
  const integrations = await integrationsForProject(
    options.integrations,
    stored.task.projectId,
    noRunScopedSecrets(),
  );
  const git = integrations.git;
  if (git === null) {
    return 'no_binding';
  }
  const context = { projectId: stored.task.projectId, taskId };
  const live = await gitReads(integrations).mergeRequest(stored.mr, context);
  if ((live?.ref.head_sha ?? null) !== headSha) {
    return 'head_moved';
  }
  const status = await gitReads(integrations).pipelineStatus(headSha, context);
  if (status === null || status.id !== pipelineId) {
    return 'pipeline_moved';
  }
  const job = status.jobs.find((candidate) => candidate.id === jobId);
  if (job === undefined || job.status !== 'manual' || job.trigger === true) {
    return 'not_manual';
  }
  const settings = await options.settings.forProject(stored.task.projectId);
  // WP-106: a configuration this release cannot read stands in the defaults; the platform starts
  // nothing on them (the defaults name no `run` job, and the gate refuses the configuration).
  if (
    settings.configRefusal !== undefined ||
    manualJobModeOf(manualJobPolicyOf(settings), job.name) !== 'run'
  ) {
    return 'not_run';
  }
  const redact = (text: string): string => git.redactor.redactText(text).value;
  const record = async (outcome: CiManualStartOutcome): Promise<void> => {
    const started: CiManualStartedJob = {
      job_id: jobId,
      pipeline_id: pipelineId,
      name: boundedJobName(job.name, redact),
      url: safeProviderUrl(job.web_url, redact),
      at: options.clock.now() as IsoDateTime,
      outcome,
    };
    const written = await options.unitOfWork.transaction(async (scope) =>
      options.store.tasks.recordCiManualStarted(scope.tx, entry, started),
    );
    logger.info(
      { task_id: taskId, attempt, pipeline_id: pipelineId, job_id: jobId, outcome, written },
      'ci_play_manual: a manual job the project set to run',
    );
  };
  if (git.port.capabilities().manualJobPlay !== true) {
    await record('unsupported');
    return 'unsupported';
  }
  try {
    const played = await codeMergeRequestWrites(integrations).playJob(
      { jobId, idempotencyKey: ciPlayIdempotencyKey(taskId, pipelineId, jobId) },
      { ...context, mode: stored.task.mode },
    );
    if (played === null) {
      return 'shadow';
    }
  } catch (error) {
    if (!(error instanceof IntegrationError)) {
      throw error;
    }
    if (error.code === 'forbidden') {
      // The M28 ruling: a refusal of the platform's account falls back to `wait` for this job.
      await record('refused');
      return 'refused';
    }
    if (error.code === 'unsupported_capability') {
      await record('unsupported');
      return 'unsupported';
    }
    if (
      error.code === 'invalid_request' ||
      error.code === 'conflict' ||
      error.code === 'not_found'
    ) {
      logger.info(
        { task_id: taskId, job_id: jobId, code: error.code },
        'ci_play_manual: the provider would not play the job any more; the gate’s next read decides',
      );
      return 'not_playable';
    }
    throw error;
  }
  await record('started');
  return 'started';
};

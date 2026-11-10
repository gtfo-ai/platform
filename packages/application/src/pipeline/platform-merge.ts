/**
 * **The platform may merge** (S-28.15, BD-007's 2026-11-10 amendment, TD-038 as amended by the M28
 * ruling of 2026-11-10). The owner: *"ready to merge even agentic can merge, not only person — in
 * the agentic workflow we want as least human steps as possible"*; and, amending: *"the merge
 * decision once approved or does not need the approval because platform decided it is safe then
 * platform merge"*.
 *
 * With `policies.merge.by: platform` (set on the project settings page; a repository file may only
 * say `person`, `repository-grades.ts`), the `pipeline.outbound` duty **`platform_merge`** merges a
 * task's merge request at `ready_for_merge`. It is woken by `ready_merge_check` when that check read
 * the provider's "mergeable" or a rebase as its only obstacle (`./ready-merge-check.ts`) — one fresh
 * read, no second poller — and the recovery pass's `ready_merge_check` row asks again every ten
 * minutes for a task the platform merges with no decisive attempt for its reviewed head (a merge
 * that waited, a rebase in flight, or a lost wake-up).
 *
 * ## Who merges (TD-038 decision 2)
 *
 * `mergeByPersonReasons` in `@platform/domain`: the setting, a provider without the capability
 * `merge`, shadow mode. **The plan decision is the human checkpoint**: probation and risk classes
 * ask a person *there*, so a task whose plan a person approved, the platform's low-risk rule let
 * through, or that needed no approval, is merged — and the recorded merge names which of the three
 * it rested on (`plan_decision`, `plan_approval_id`). A latest plan approval that is neither
 * approved nor absent is a fail-closed wait (`plan_not_decided`), never a merge.
 *
 * ## `need_rebase` (TD-038 amendment A)
 *
 * When the provider's only obstacle is a rebase, the duty asks for one (`rebaseMergeRequest`, at
 * most {@link MAX_REBASES_PER_READY_ENTRY} per Ready entry), with the change digest and the commit
 * count recorded first; once the provider rebased, the new head is accepted as the reviewed change
 * only when both are identical and the CI gate's own verdict passes its pipeline — then
 * `ready_head_sha = ci_head_sha = H′` and the next wake-up merges with `sha = H′`. A rebase the
 * provider could not make re-enters BD-030's rebase gate.
 *
 * ## The fresh check (TD-038 decision 3)
 *
 * Re-read **outside every transaction**, and the merge happens only when every item holds
 * (`platformMergeWait`): the task at `ready_for_merge`; no human-return window open (a queued or
 * running `mr.comment.debounce` job for the merge request) and no person's merge-request note
 * younger than the window; the latest review verdict approves; the ticket's fresh status neither
 * closed nor hands-off; the merge request `opened`, not a draft, no `merge_blocker` and `mergeable`
 * true; the repository's merge settings known; and **MR head == `tasks.ready_head_sha` ==
 * `tasks.ci_head_sha`** on a pipeline with a CI gate. A failing item is recorded as
 * `task_merge_checks.merge_wait` for the page, never an attempt.
 *
 * ## The call and its bounds (TD-038 decisions 4–5)
 *
 * `reviewWrites(...).merge` — through `IntegrationActionExecutor`, idempotent on
 * `platform_merge:<task>:<head>`, **one executor attempt**, the head passed as the expected sha, the
 * repository's own squash and branch-removal settings passed back unchanged. **One decisive call per
 * (task, head)**: a row in `task_merges` for the head (migration 0119) ends every later wake-up
 * before the call. A refusal (401/405/409/422) is recorded `refused` and left to a person; a
 * transport failure throws into the job's retry (`pipeline.outbound`: three tries), each try
 * re-reading the merge request first — already merged on a retry means the lost answer was a merge,
 * recorded `merged` — and the **last** try records `failed`. Each ending appends
 * `task.merge.attempted` (system actor) once, with its row, which the notify band announces.
 *
 * ## One path to `merged_gate` (TD-038 decision 6)
 *
 * The duty never moves the task: `mr.merged` (webhook or poll) does, as for a person's merge. A
 * signal that never comes is {@link recoverLostMergeSignal}'s, asked by `ready_merge_check` when the
 * recovery pass finds the task still at Ready ten minutes after a `merged` row.
 */
import type { DomainEvent, Id, IsoDateTime, JsonObject, Slug } from '@platform/contracts';
import { reviewVerdictDataSchema } from '@platform/contracts';
import {
  buildEvent,
  changeDigest,
  compilePipeline,
  interpret,
  type MergePlanDecision,
  mergeByPersonReasons,
  platformMergeWait,
  READY_FOR_MERGE_STAGE,
  stageOf,
  ticketStatusDisposition,
  withStatusMappingStatuses,
} from '@platform/domain';
import { TransactionOpenError } from '../events/open-transaction.js';
import type { InboundRecorderOptions } from '../integrations/inbound.js';
import { recordNormalisedDelivery } from '../integrations/inbound.js';
import { IntegrationError } from '../ports/integrations/common.js';
import {
  MergeRefusedError,
  type MergeRequest,
  RebaseRefusedError,
} from '../ports/integrations/git-provider.js';
import { isLastTry, JOB_QUEUES, type JobContext } from '../ports/jobs.js';
import { type Logger, silentLogger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { CI_GATE_STAGE, ciVerdictOf, manualJobPolicyFor } from './gates.js';
import {
  gitReads,
  integrationsForProject,
  noRunScopedSecrets,
  type PipelineIntegrations,
  reviewWrites,
} from './integrations.js';
import { escalateTaskWithBrief } from './job-escalation.js';
import type { PipelineOutboundData } from './jobs.js';
import { appendOnProjectWithRetry } from './project-stream.js';
import { isPlatformNote } from './review-threads.js';
import type { PipelineSagaOptions } from './saga.js';
import { autonomyPresetFor, type ProjectSettings } from './settings.js';
import { enqueueStage } from './stage-enqueue.js';
import { PIPELINE_ACTOR, type StoredTask, type TaskMergeRecord } from './store.js';
import { inTaskTransaction } from './task-transaction.js';
import { readTicketForTask } from './ticket-snapshot.js';
import { applyDecision } from './transitions.js';

/** What a composition root hands the duty that no store holds (S-28.15). */
export interface PlatformMergePorts {
  /**
   * Is a human-return window open for this merge request — an `mr.comment.debounce` job with the
   * singleton key `mr:<iid>` created, retrying or active? (pg-boss's own table, read by
   * `createPostgresReviewWindowProbe`.)
   */
  readonly reviewWindowOpen: (iid: number) => Promise<boolean>;
  /** The webhook ingress's database half, for a lost `mr.merged` (TD-038 decision 6). */
  readonly recorder: Omit<InboundRecorderOptions, 'decisions' | 'logger'>;
}

export interface PlatformMergeOptions extends PipelineSagaOptions {
  readonly unitOfWork: UnitOfWork;
  /** Absent: the platform never merges in this process, and says so in the log. */
  readonly platformMerge?: PlatformMergePorts;
}

/** What the duty did — for the tests and the log line. */
export type PlatformMergeOutcome =
  | 'no_task'
  | 'not_at_ready'
  | 'no_binding'
  | 'person'
  | 'already_attempted'
  | 'not_composed'
  | 'waiting'
  | 'merged'
  | 'refused'
  | 'failed'
  | 'rebase_asked'
  | 'rebase_refused'
  | 'rebase_conflict'
  | 'rebase_changed'
  | 'rebase_accepted';

/** The idempotency key of the merge call: one per task and reviewed head (TD-038 decision 3). */
export const platformMergeKey = (taskId: string, headSha: string): string =>
  `platform_merge:${taskId}:${headSha}`;

/** The idempotency key of a rebase: one per task and head before it (TD-038 amendment A). */
export const platformRebaseKey = (taskId: string, headSha: string): string =>
  `platform_rebase:${taskId}:${headSha}`;

/** How many recovery passes record a lost `mr.merged` before the task is escalated (decision 6). */
export const LOST_MERGE_SIGNAL_PASSES = 3;

/** Provider rebases per entry into Ready (TD-038 amendment A, decision 5). */
export const MAX_REBASES_PER_READY_ENTRY = 3;

/** Files the change digest reads at most; a longer list gives no digest (amendment A). */
export const CHANGE_DIGEST_MAX_FILES = 500;

/** After a rebase is asked, the duty looks again once this much later (the recovery pass after). */
export const REBASE_FOLLOW_UP_MS = 60_000;

/** The outcomes that end the platform's attempts for a head; `rebased` is still in flight. */
const DECISIVE = new Set<TaskMergeRecord['outcome']>([
  'merged',
  'refused',
  'failed',
  'rebase_refused',
  'rebase_conflict',
  'rebase_changed',
]);

/** The plan decision a merge rests on, and the approval row it was read from. */
export interface PlanDecisionRead {
  /** `null`: the latest plan approval is neither approved nor absent — fail closed. */
  readonly plan: MergePlanDecision | null;
  readonly approvalId: Id | null;
}

/** The plan decision the merge rests on: the task's latest plan approval, read in `tx`. */
export const planDecisionOf = async (
  options: Pick<PlatformMergeOptions, 'store'>,
  tx: Parameters<PlatformMergeOptions['store']['approvals']['latestOfKind']>[0],
  taskId: Id,
): Promise<PlanDecisionRead> => {
  const approval = await options.store.approvals.latestOfKind(tx, { taskId, kind: 'plan' });
  if (approval === null) {
    return { plan: 'not_required', approvalId: null };
  }
  if (approval.approval.status !== 'approved') {
    return { plan: null, approvalId: approval.approval.id };
  }
  return {
    plan: approval.autoDecided === true ? 'approved_by_platform' : 'approved_by_person',
    approvalId: approval.approval.id,
  };
};

/** Shadow mode: a shadow task, or a project whose materialised dial is in shadow mode. */
const inShadow = (stored: StoredTask, settings: ProjectSettings): boolean =>
  stored.task.mode === 'shadow' || autonomyPresetFor(settings)?.shadowMode === true;

/** Who merges this task — `mergeByPersonReasons` over its settings and the binding's capability. */
export const mergeDecisionFor = (input: {
  readonly stored: StoredTask;
  readonly settings: ProjectSettings;
  readonly providerCanMerge: boolean;
}): ReturnType<typeof mergeByPersonReasons> =>
  mergeByPersonReasons({
    setting: input.settings.config.policies?.merge?.by,
    providerCanMerge: input.providerCanMerge,
    // A configuration that cannot be read is no statement that the platform may merge.
    shadow: inShadow(input.stored, input.settings) || input.settings.configRefusal !== undefined,
  });

/** Who merges a task at Ready, for the merge check (`./ready-merge-check.ts`). */
export const whoMerges = async (
  options: Pick<PlatformMergeOptions, 'settings'>,
  stored: StoredTask,
  integrations: PipelineIntegrations,
): Promise<{ readonly by: 'person' | 'platform'; readonly reason: string | null }> => {
  const settings = await options.settings.forProject(stored.task.projectId);
  const reasons = mergeDecisionFor({
    stored,
    settings,
    providerCanMerge: integrations.git?.port.capabilities().merge === true,
  });
  const [first] = reasons;
  return first === undefined ? { by: 'platform', reason: null } : { by: 'person', reason: first };
};

/** A person's note — not a provider system note, not the platform's own — younger than `since`. */
const personWroteSince = (
  discussions: readonly {
    readonly notes: readonly { body: string; system: boolean; created_at: string }[];
  }[],
  since: number,
): boolean =>
  discussions.some((discussion) =>
    discussion.notes.some(
      (note) => !note.system && !isPlatformNote(note) && Date.parse(note.created_at) >= since,
    ),
  );

/** What the duty read in its first transaction. */
interface MergeRead {
  readonly stored: StoredTask & { readonly mr: NonNullable<StoredTask['mr']> };
  readonly verdict: string | null;
  readonly plan: PlanDecisionRead;
  readonly attempt: TaskMergeRecord | null;
  readonly merges: readonly TaskMergeRecord[];
  readonly readyEnteredAt: string | null;
}

/** Everything a step of the duty needs. */
interface MergeStep {
  readonly options: PlatformMergeOptions;
  readonly read: MergeRead;
  readonly integrations: PipelineIntegrations;
  readonly settings: ProjectSettings;
  readonly causeEventId: Id;
  readonly job: Pick<JobContext, 'retries'> | undefined;
  readonly decide: (wait: string | null) => Promise<void>;
}

/**
 * `pipeline.outbound` duty **platform_merge** — see the module docblock. `job` carries the try, so
 * the last one records `failed` rather than throwing.
 */
export const runPlatformMerge = async (
  options: PlatformMergeOptions,
  data: Pick<PipelineOutboundData, 'task_id' | 'cause_event_id'>,
  job?: Pick<JobContext, 'retries'>,
): Promise<PlatformMergeOutcome> => {
  const logger: Logger = options.logger ?? silentLogger;
  const taskId = data.task_id as Id | undefined;
  if (taskId === undefined) {
    return 'no_task';
  }
  const read = await options.unitOfWork.transaction(async (scope): Promise<MergeRead | null> => {
    const stored = await options.store.tasks.load(scope.tx, taskId);
    if (
      stored === null ||
      stored.task.state !== 'ready_for_merge' ||
      stored.task.currentStage !== READY_FOR_MERGE_STAGE ||
      stored.mr === null
    ) {
      return null;
    }
    const verdict = reviewVerdictDataSchema.safeParse(
      (await options.store.artifacts.latest(scope.tx, taskId, 'ReviewVerdict'))?.data,
    );
    const entry = await options.store.tasks.stageAttemptEntry(
      scope.tx,
      taskId,
      READY_FOR_MERGE_STAGE as Slug,
      stored.task.stageAttempts[READY_FOR_MERGE_STAGE] ?? 1,
    );
    return {
      stored: stored as MergeRead['stored'],
      verdict: verdict.success ? verdict.data.verdict : null,
      plan: await planDecisionOf(options, scope.tx, taskId),
      attempt:
        stored.readyHeadSha === null
          ? null
          : await options.store.tasks.mergeFor(scope.tx, taskId, stored.readyHeadSha),
      merges: await options.store.tasks.mergesOf(scope.tx, taskId),
      readyEnteredAt: entry?.enteredAt ?? null,
    };
  });
  if (read === null) {
    return 'not_at_ready';
  }
  if (read.attempt !== null && DECISIVE.has(read.attempt.outcome)) {
    // One decisive call per task and reviewed head (TD-038 decision 5): a refusal, a failure or a
    // merge for this head ends every later wake-up before anything is read.
    return 'already_attempted';
  }
  const { stored } = read;
  const projectId = stored.task.projectId;
  const settings = await options.settings.forProject(projectId);
  const integrations = await integrationsForProject(
    options.integrations,
    projectId,
    noRunScopedSecrets(),
  );
  const git = integrations.git;
  if (git === null) {
    return 'no_binding';
  }
  const decideAs = async (mergeBy: 'person' | 'platform', wait: string | null): Promise<void> => {
    await options.unitOfWork.transaction(async (scope) =>
      options.store.tasks.recordMergeDecision(scope.tx, taskId, { mergeBy, wait }),
    );
  };
  const reasons = mergeDecisionFor({
    stored,
    settings,
    providerCanMerge: git.port.capabilities().merge === true,
  });
  if (reasons.length > 0) {
    // The first reason is what the page says: *A person merges: this project's setting*.
    await decideAs('person', reasons[0] ?? null);
    logger.info({ task_id: taskId, reasons }, 'platform merge: a person merges this task');
    return 'person';
  }
  const ports = options.platformMerge;
  if (ports === undefined) {
    logger.error(
      { task_id: taskId },
      'platform merge: this process composed no review-window probe or recorder, so it merges nothing; the merge is left to a person',
    );
    return 'not_composed';
  }
  const step: MergeStep = {
    options,
    read,
    integrations,
    settings,
    causeEventId: (data.cause_event_id ?? taskId) as Id,
    job,
    decide: async (wait) => decideAs('platform', wait),
  };
  const mr = stored.mr;
  const headSha = stored.readyHeadSha;
  const context = { projectId, taskId };
  const reads = gitReads(integrations);
  const live = await reads.mergeRequest(mr, context);
  if (live === null) {
    await step.decide('provider_blocked');
    return 'waiting';
  }
  if (
    live.state === 'merged' &&
    headSha !== null &&
    read.attempt === null &&
    (job?.retries?.count ?? 0) > 0
  ) {
    // A retry after a transport failure, and the merge request is merged: the lost answer was the
    // platform's merge (TD-038 decision 5, "already merged → done").
    await recordAttempt(step, {
      headSha,
      outcome: 'merged',
      providerStatus: null,
      mergeCommitSha: live.merge_commit_sha ?? null,
    });
    return 'merged';
  }
  if (read.attempt !== null && read.attempt.outcome === 'rebased') {
    return continueRebase(step, read.attempt, live);
  }
  const windowMs = options.reviewCommentWindowMs ?? 2 * 60_000;
  const now = Date.parse(options.clock.now());
  const windowOpen = await ports.reviewWindowOpen(mr.iid);
  const discussions = windowOpen ? [] : await reads.discussions(mr, context);
  const personWordsPending = windowOpen || personWroteSince(discussions, now - windowMs);
  const ticket = await freshTicket(options, stored, settings);
  const wait = platformMergeWait({
    atReady: true,
    paused: false,
    personWordsPending,
    latestVerdict: read.verdict,
    plan: read.plan.plan,
    ticket,
    mergeRequest: {
      state: live.state,
      draft: live.draft,
      mergeable: live.mergeable,
      blocked: live.merge_blocker != null,
      headSha: live.head_sha,
      optionsKnown: live.merge_options != null,
      rebaseOnly: live.merge_blocker?.reason === 'rebase',
    },
    readyHeadSha: headSha,
    ciHeadSha: stored.ciHeadSha,
    hasCiGate: hasCiGate(stored),
  });
  if (wait === 'needs_rebase' && headSha !== null) {
    return startRebase(step, headSha);
  }
  if (wait !== null || headSha === null || live.merge_options == null) {
    await step.decide(wait ?? 'provider_blocked');
    logger.info({ task_id: taskId, wait }, 'platform merge: waiting — a check does not hold yet');
    return 'waiting';
  }
  await step.decide(null);
  let merged: MergeRequest | null;
  try {
    merged = await reviewWrites(integrations).merge(
      {
        ref: mr,
        request: {
          expected_head_sha: headSha,
          squash: live.merge_options.squash,
          remove_source_branch: live.merge_options.remove_source_branch,
        },
        idempotencyKey: platformMergeKey(taskId, headSha),
      },
      { ...context, mode: stored.task.mode },
    );
  } catch (error) {
    if (error instanceof TransactionOpenError) {
      throw error;
    }
    if (error instanceof MergeRefusedError) {
      // Final for this head (TD-038 decision 5): recorded, announced, left to a person.
      await recordAttempt(step, {
        headSha,
        outcome: 'refused',
        providerStatus: error.status,
        mergeCommitSha: null,
      });
      logger.warn(
        { task_id: taskId, status: error.status, http_status: error.httpStatus },
        'platform merge: the provider refused the merge; it is left to a person',
      );
      return 'refused';
    }
    if (!isLastTry(job ?? {})) {
      // A transport failure: the job's next try re-reads the merge request first.
      throw error;
    }
    await recordAttempt(step, {
      headSha,
      outcome: 'failed',
      providerStatus: error instanceof IntegrationError ? error.code : 'unavailable',
      mergeCommitSha: null,
    });
    logger.error(
      { task_id: taskId, err: error },
      'platform merge: the provider could not be reached on the last try; the merge is left to a person',
    );
    return 'failed';
  }
  if (merged === null) {
    // A shadow task makes no call — unreachable, `shadow_mode` held it above; said, not assumed.
    return 'person';
  }
  await recordAttempt(step, {
    headSha,
    outcome: 'merged',
    providerStatus: null,
    mergeCommitSha: merged.merge_commit_sha ?? null,
  });
  logger.info(
    { task_id: taskId, head_sha: headSha, merge_commit_sha: merged.merge_commit_sha ?? null },
    'platform merge: merged; the task moves on when the provider reports the merge',
  );
  return 'merged';
};

/** Does the task's frozen pipeline run an enabled CI gate? */
const hasCiGate = (stored: StoredTask): boolean => {
  const pipeline = compilePipeline(
    stored.task.template,
    stored.template,
    stored.pipelineDial,
    stored.qaStage,
  );
  const ci = stageOf(pipeline, CI_GATE_STAGE);
  return ci?.enabled === true && ci.kind === 'gate';
};

/** The merge request's change digest and commit count, or `null` for either it cannot know. */
const changeOf = async (
  step: MergeStep,
): Promise<{ readonly digest: string | null; readonly commits: number | null }> => {
  const { stored } = step.read;
  const context = { projectId: stored.task.projectId, taskId: stored.task.id };
  const reads = gitReads(step.integrations);
  const files = await reads.mergeRequestDiff(stored.mr, CHANGE_DIGEST_MAX_FILES, context);
  const digest =
    files === null
      ? null
      : changeDigest(
          files.map((file) => ({
            oldPath: file.old_path,
            newPath: file.new_path,
            newFile: file.new_file,
            deletedFile: file.deleted_file,
            renamedFile: file.renamed_file,
            diff: file.diff ?? null,
            omitted: file.omitted,
          })),
          files.length >= CHANGE_DIGEST_MAX_FILES,
        );
  return { digest, commits: await reads.mergeRequestCommitCount(stored.mr, context) };
};

/**
 * **`need_rebase`, the only obstacle** (TD-038 amendment A, decisions 2–3 and 5): at most
 * {@link MAX_REBASES_PER_READY_ENTRY} rebases per entry into Ready; the change digest and the
 * commit count recorded **before** the call; then the provider's rebase, through the executor.
 */
const startRebase = async (step: MergeStep, headSha: string): Promise<PlatformMergeOutcome> => {
  const { options, read } = step;
  const { stored } = read;
  const logger = options.logger ?? silentLogger;
  const git = step.integrations.git;
  if (git === null || git.port.capabilities().rebase !== true) {
    await step.decide('rebase_unsupported');
    return 'waiting';
  }
  const since = read.readyEnteredAt === null ? Number.NaN : Date.parse(read.readyEnteredAt);
  const rebases = read.merges.filter(
    (merge) =>
      merge.outcome.startsWith('rebase') &&
      (Number.isNaN(since) || Date.parse(merge.attemptedAt) >= since),
  ).length;
  if (rebases >= MAX_REBASES_PER_READY_ENTRY) {
    await step.decide('rebase_bound');
    logger.info(
      { task_id: stored.task.id, rebases },
      'platform merge: the provider wants a rebase again and the bound is spent; a person rebases and merges',
    );
    return 'waiting';
  }
  const before = await changeOf(step);
  if (before.digest === null || before.commits === null) {
    await step.decide('rebase_no_digest');
    return 'waiting';
  }
  try {
    await reviewWrites(step.integrations).rebase(
      { ref: stored.mr, idempotencyKey: platformRebaseKey(stored.task.id, headSha) },
      { projectId: stored.task.projectId, taskId: stored.task.id, mode: stored.task.mode },
    );
  } catch (error) {
    if (error instanceof TransactionOpenError) {
      throw error;
    }
    if (error instanceof RebaseRefusedError || isLastTry(step.job ?? {})) {
      await recordAttempt(step, {
        headSha,
        outcome: 'rebase_refused',
        providerStatus:
          error instanceof RebaseRefusedError
            ? error.status
            : error instanceof IntegrationError
              ? error.code
              : 'unavailable',
        mergeCommitSha: null,
        changeDigest: before.digest,
        commitCount: before.commits,
      });
      await step.decide('rebase_refused');
      return 'rebase_refused';
    }
    throw error;
  }
  await recordAttempt(step, {
    headSha,
    outcome: 'rebased',
    providerStatus: null,
    mergeCommitSha: null,
    changeDigest: before.digest,
    commitCount: before.commits,
  });
  await step.decide('rebase_in_progress');
  // One follow-up a minute later — not a loop: the recovery pass asks again after that.
  await options.jobs.enqueue({
    queue: JOB_QUEUES.pipelineOutbound,
    startAfter: new Date(Date.parse(options.clock.now()) + REBASE_FOLLOW_UP_MS),
    data: {
      duty: 'platform_merge',
      project_id: stored.task.projectId,
      task_id: stored.task.id,
      cause_event_id: step.causeEventId,
    } satisfies PipelineOutboundData,
  });
  return 'rebase_asked';
};

/**
 * **After the provider's rebase** (TD-038 amendment A, decisions 3–4): a failed rebase re-enters
 * BD-030's rebase gate; a new head is accepted as the reviewed change only when the digest and the
 * commit count are identical and the CI gate's own verdict passes its pipeline — then
 * `ready_head_sha = ci_head_sha = H′` and the next wake-up merges with `sha = H′`.
 */
const continueRebase = async (
  step: MergeStep,
  rebase: TaskMergeRecord,
  live: MergeRequest,
): Promise<PlatformMergeOutcome> => {
  const { options, read } = step;
  const { stored } = read;
  const taskId = stored.task.id;
  const context = { projectId: stored.task.projectId, taskId };
  const reads = gitReads(step.integrations);
  const state = await reads.mergeRequestRebase(stored.mr, context);
  if (state === null || state.in_progress) {
    await step.decide('rebase_in_progress');
    return 'waiting';
  }
  if (state.failed) {
    await options.unitOfWork.transaction(async (scope) =>
      options.store.tasks.settleRebase(scope.tx, taskId, rebase.headSha, {
        outcome: 'rebase_conflict',
        providerStatus: 'rebase_failed',
        rebasedTo: null,
      }),
    );
    await reenterRebaseGate(options, taskId);
    return 'rebase_conflict';
  }
  if (live.state !== 'opened' || live.head_sha === rebase.headSha) {
    // Queued and not yet run, or the merge request left `opened`: nothing to judge yet.
    await step.decide('rebase_in_progress');
    return 'waiting';
  }
  const after = await changeOf(step);
  const changed =
    after.digest === null || after.digest !== rebase.changeDigest
      ? 'digest_changed'
      : after.commits === null || after.commits !== rebase.commitCount
        ? 'commits_changed'
        : null;
  const settle = async (status: string): Promise<PlatformMergeOutcome> => {
    await options.unitOfWork.transaction(async (scope) =>
      options.store.tasks.settleRebase(scope.tx, taskId, rebase.headSha, {
        outcome: 'rebase_changed',
        providerStatus: status,
        rebasedTo: live.head_sha,
      }),
    );
    await step.decide('rebase_changed');
    return 'rebase_changed';
  };
  if (changed !== null) {
    return settle(changed);
  }
  const pipeline = await reads.pipelineStatus(live.head_sha, context);
  if (pipeline === null) {
    await step.decide('rebase_pipeline');
    return 'waiting';
  }
  const git = step.integrations.git;
  const verdict = ciVerdictOf(
    pipeline,
    await manualJobPolicyFor(options, stored.task.projectId, pipeline),
    {
      redact: (text) => (git === null ? text : git.redactor.redactText(text).value),
      checkedAt: options.clock.now(),
    },
  );
  if (verdict.kind === 'waiting') {
    await step.decide('rebase_pipeline');
    return 'waiting';
  }
  if (verdict.reading.kind !== 'passed') {
    return settle('pipeline_failed');
  }
  // The rebased head is the reviewed change (amendment A, decision 3): a narrow write of both heads,
  // compare-and-set on the head the rebase started from.
  const accepted = await options.unitOfWork.transaction(async (scope) => {
    const current = await options.store.tasks.load(scope.tx, taskId);
    if (current === null || current.readyHeadSha !== rebase.headSha) {
      return false;
    }
    await options.store.tasks.saveReadyHead(scope.tx, taskId, live.head_sha);
    await options.store.tasks.saveCiSettlement(scope.tx, taskId, {
      headSha: live.head_sha,
      excusedPaths: current.ciExcusedPaths,
    });
    await options.store.tasks.settleRebase(scope.tx, taskId, rebase.headSha, {
      outcome: 'rebased',
      providerStatus: null,
      rebasedTo: live.head_sha,
    });
    return true;
  });
  if (!accepted) {
    await step.decide('head_moved');
    return 'waiting';
  }
  await options.jobs.enqueue({
    queue: JOB_QUEUES.pipelineOutbound,
    data: {
      duty: 'platform_merge',
      project_id: stored.task.projectId,
      task_id: taskId,
      cause_event_id: step.causeEventId,
    } satisfies PipelineOutboundData,
  });
  return 'rebase_accepted';
};

/**
 * A rebase the provider could not make is a conflict (TD-038 amendment A, decision 4): the task
 * re-enters BD-030's rebase gate the way `default_branch.moved` takes it there, spending
 * `rebase_rechecks`; the gate's read finds the conflict and runs `conflict_resolution`.
 */
const reenterRebaseGate = async (options: PlatformMergeOptions, taskId: Id): Promise<void> => {
  const work = await inTaskTransaction(
    options,
    taskId,
    'returning a task whose rebase failed to the rebase gate',
    async (scope) => {
      const current = await options.store.tasks.load(scope.tx, taskId);
      if (current === null || current.task.state !== 'ready_for_merge') {
        return null;
      }
      const pipeline = compilePipeline(
        current.task.template,
        current.template,
        current.pipelineDial,
        current.qaStage,
      );
      const decision = interpret(pipeline, {
        kind: 'event',
        stage: READY_FOR_MERGE_STAGE as Slug,
        event: 'default_branch.moved',
        detail:
          'the git provider could not rebase the merge request, so the rebase gate checks for a conflict',
      });
      const applied = await applyDecision({
        offerClosing: { events: scope.events, broadcast: scope.broadcast },
        store: options.store,
        pipeline,
        tx: scope.tx,
        stored: current,
        decision,
        context: {
          ids: options.ids,
          actor: PIPELINE_ACTOR,
          clock: options.clock as never,
          correlationId: taskId,
          causeEventId: null,
        },
        causedByEventId: null,
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      });
      await scope.events.append(applied.events);
      return applied.work;
    },
  );
  if (work !== null) {
    await enqueueStage(options.jobs, work);
  }
};

/** The ticket's fresh disposition, or `null` when the project judges no ticket status. */
const freshTicket = async (
  options: PlatformMergeOptions,
  stored: StoredTask,
  settings: ProjectSettings,
): Promise<'open' | 'closed' | 'hands_off' | 'unread' | null> => {
  const base = settings.ticketStatusPolicy ?? null;
  if (base === null) {
    return null;
  }
  const policy = withStatusMappingStatuses(
    base,
    settings.ticketLifecycle?.slots,
    settings.config.status_mapping,
  );
  const read = await readTicketForTask(options, {
    projectId: stored.task.projectId,
    taskId: stored.task.id,
    ticket: stored.task.ticket,
  });
  if (read === null) {
    // Fail closed: a bound ticket the platform cannot read is not known to be open.
    return 'unread';
  }
  const disposition = ticketStatusDisposition(read.status, read.statusCategory, policy, true);
  return disposition === 'closed' || disposition === 'hands_off' ? disposition : 'open';
};

/**
 * The attempt's row and — for a merge's ending — its event, in one project-stream transaction: the
 * event is appended only when this call wrote the row, so a replayed job announces nothing twice. A
 * rebase row is recorded without an event; the page says it.
 */
const recordAttempt = async (
  step: MergeStep,
  input: {
    readonly headSha: string;
    readonly outcome: TaskMergeRecord['outcome'];
    readonly providerStatus: string | null;
    readonly mergeCommitSha: string | null;
    readonly changeDigest?: string | null;
    readonly commitCount?: number | null;
  },
): Promise<boolean> => {
  const { options, read } = step;
  const { stored } = read;
  const projectId = stored.task.projectId;
  // A plan approval that is not approved never reaches the call (`plan_not_decided`).
  const plan = read.plan.plan ?? 'not_required';
  return appendOnProjectWithRetry(
    options,
    { projectId, writer: 'platform_merge' },
    async (scope, streamSeq) => {
      const wrote = await options.store.tasks.recordMerge(scope.tx, {
        taskId: stored.task.id,
        headSha: input.headSha,
        outcome: input.outcome,
        providerStatus: input.providerStatus,
        mergeCommitSha: input.mergeCommitSha,
        planDecision: plan,
        planApprovalId: read.plan.approvalId,
        changeDigest: input.changeDigest ?? null,
        commitCount: input.commitCount ?? null,
        rebasedTo: null,
        attemptedAt: options.clock.now() as IsoDateTime,
        signalPasses: 0,
      });
      if (
        !wrote ||
        (input.outcome !== 'merged' && input.outcome !== 'refused' && input.outcome !== 'failed')
      ) {
        return wrote;
      }
      await scope.events.append([
        buildEvent(
          'task.merge.attempted',
          {
            project_id: projectId,
            task_id: stored.task.id,
            mr: stored.mr,
            head_sha: input.headSha,
            outcome: input.outcome,
            provider_status: input.providerStatus,
            merge_commit_sha: input.mergeCommitSha,
            plan_decision: plan,
            plan_approval_id: read.plan.approvalId,
          },
          { streamType: 'project', streamId: projectId, streamSeq },
          {
            ids: options.ids,
            actor: PIPELINE_ACTOR,
            clock: options.clock as never,
            correlationId: stored.task.id,
            causeEventId: step.causeEventId,
          },
        ) as DomainEvent,
      ]);
      return true;
    },
  );
};

/**
 * **A lost `mr.merged`** (TD-038 decision 6): the merge request reads merged, the platform merged
 * it (`task_merges` `merged`) more than the recovery window ago, and the task is still at Ready. The
 * recovery pass's `ready_merge_check` row asks; each pass counts, the first
 * {@link LOST_MERGE_SIGNAL_PASSES} record `mr.merged` through `recordNormalisedDelivery` — the inbox
 * key and the lifecycle rule drop a repeat, so a late webhook is a duplicate there — and the pass
 * after them escalates the task with a brief.
 */
export const recoverLostMergeSignal = async (
  options: PlatformMergeOptions,
  input: {
    readonly stored: StoredTask;
    readonly live: MergeRequest;
    readonly integrations: PipelineIntegrations;
    readonly staleBefore: number;
  },
): Promise<'none' | 'recorded' | 'escalated'> => {
  const { stored, live } = input;
  const git = input.integrations.git;
  const latest = await options.unitOfWork.transaction(async (scope) =>
    options.store.tasks.latestMerge(scope.tx, stored.task.id),
  );
  if (
    git === null ||
    latest === null ||
    latest.outcome !== 'merged' ||
    !(Date.parse(latest.attemptedAt) < input.staleBefore)
  ) {
    return 'none';
  }
  const passes = await options.unitOfWork.transaction(async (scope) =>
    options.store.tasks.countMergeSignalPass(scope.tx, stored.task.id, latest.headSha),
  );
  const projectId = stored.task.projectId;
  if (passes > LOST_MERGE_SIGNAL_PASSES) {
    await escalateTaskWithBrief(options, {
      taskId: stored.task.id,
      projectId,
      causeEventId: null,
      reason: 'the platform merged the merge request and the provider never reported the merge',
      brief: (ticketKey) =>
        `The platform merged the merge request of ${ticketKey} (reviewed commit ${latest.headSha.slice(0, 7)}), and the git provider has not reported the merge after ${LOST_MERGE_SIGNAL_PASSES} checks ten minutes apart, so the task did not move on. Check the merge request on the provider and the project's webhook or merge-request polling, then hand the task back at the merged gate or close it.`,
      what: 'platform_merge',
    });
    return 'escalated';
  }
  const ports = options.platformMerge;
  if (ports === undefined) {
    return 'none';
  }
  const ref = {
    provider: live.ref.provider ?? git.ref.provider,
    project_path: live.ref.project_path ?? git.project,
    iid: live.ref.iid,
    url: live.ref.url,
    branch: live.ref.branch ?? null,
    head_sha: live.head_sha,
  };
  const payload = {
    project_id: projectId,
    task_id: null,
    mr: ref,
    draft: live.draft,
    head_sha: live.head_sha,
    diff_stats: null,
    merge_commit_sha: live.merge_commit_sha ?? null,
  };
  const actor = {
    kind: 'integration' as const,
    integration_id: git.ref.integrationId,
    provider: git.ref.provider,
  };
  const drafts = [{ type: 'mr.merged' as const, payload, actor }];
  const deliveryId = git.redactor.redactText(
    `${git.ref.provider}:platform-merge:${projectId}:${ref.project_path}!${ref.iid}@${latest.headSha}`,
  ).value;
  const redacted = git.redactor.redactJson({
    source: 'platform_merge',
    mr: ref,
  } as unknown as JsonObject);
  await recordNormalisedDelivery(
    {
      ...ports.recorder,
      decisions: {
        apply: async () => {
          throw new Error('a lost merge signal carries no human decision');
        },
      },
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    },
    {
      provider: git.ref.provider,
      deliveryId,
      integrationId: git.ref.integrationId as Id,
      redactor: git.redactor,
      headers: { value: {}, count: 0 },
      payload: { value: redacted.value as JsonObject, count: redacted.count },
      normalised: [{ events: [...drafts], ignored: [] }],
      byProject: [{ projectId, drafts }],
    },
  );
  return 'recorded';
};

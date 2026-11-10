/**
 * **"Ready to merge" tells the truth about the provider** (S-28.13, M28 ruling R3b (2)–(3)).
 *
 * AUT-6655 sat at `ready_for_merge` — the platform told its owner the merge request was ready —
 * while GitLab answered `detailed_merge_status: discussions_not_resolved`: five threads were open,
 * every one of them the platform's own (three review summaries and two nits nobody would answer
 * once the Reviewer approved). The owner's rule: the platform resolves threads after itself, and
 * every wait says what, why and what next. The `pipeline.outbound` duty **`ready_merge_check`**
 * does both, at Ready:
 *
 *  1. when the task's latest `ReviewVerdict` approves, it closes the platform's own review threads
 *     in which no person has written (`closeOwnThreads`, `review-conversation.ts`) — those the
 *     verdict's `resolved_threads` confirmed fixed without the *Left as is* note — and, when one
 *     the platform had resolved is open again (a person's reopen, TD-029 Amendment D.3), arms the
 *     human-return window, which returns the task;
 *  2. it reads the merge request and records whether the provider would merge it **now**
 *     (`MergeRequest.merge_blocker`) in `task_merge_checks` (migration 0118), with the count of
 *     unresolved threads when that is the reason. The task read serves a "not now" as the
 *     `merge_request_blocked` subject of `provider_sync`, and the task page says it in plain words
 *     with a link to the merge request; a later "mergeable" clears it.
 *
 * ## Who wakes it
 *
 *  - **`mr_ready`**, once the merge request reads non-draft at Ready (`merge-request-ready.ts`) —
 *    after the draft is off, so the platform's own draft is never reported as the blocker;
 *  - **a resolution signal** for a task whose last check read "not now"
 *    (`review-threads-refresh.ts`'s handler: GitLab's `blocking_discussions_resolved` on
 *    `mr.updated`, a comment that resolved a thread);
 *  - **the recovery pass** (`recovery/ready-merge-check.ts`): a task at Ready with **no** record —
 *    which is every task already waiting when this ships, AUT-6655 included — once, and a record
 *    that is not "mergeable" again ten minutes after its claim, so a block that clears without a
 *    signal (a pipeline that passed, an approval) clears on the page too.
 *
 * Re-validated on fire (TD-004): the task still exists, is at `ready_for_merge`, has a merge request
 * and is not a review-only task. Every provider call is the executor's, outside every transaction;
 * shadow mode closes nothing (`would_have` rows) and still records the read. Notification-shaped
 * (`JOB_EXHAUSTION`): a lost check leaves the page as it was until the recovery pass.
 */
import type { Id } from '@platform/contracts';
import { reviewVerdictDataSchema } from '@platform/contracts';
import { READY_FOR_MERGE_STAGE } from '@platform/domain';
import type { MergeRequest } from '../ports/integrations/git-provider.js';
import type { Jobs } from '../ports/jobs.js';
import { type Logger, silentLogger } from '../ports/logger.js';
import { READY_MERGE_RECHECK_MS } from '../recovery/ready-merge-check.js';
import {
  gitReads,
  integrationsForProject,
  noRunScopedSecrets,
  type PipelineIntegrations,
} from './integrations.js';
import { enqueueOutbound, enqueueReviewCommentWindow, type PipelineOutboundData } from './jobs.js';
import { type PlatformMergeOptions, recoverLostMergeSignal, whoMerges } from './platform-merge.js';
import { closeOwnThreads, type ReviewConversationOptions } from './review-conversation.js';
import { REVIEW_ONLY_TEMPLATE_ID } from './review-only.js';
import type { ReadyMergeCheck, StoredTask } from './store.js';

/**
 * S-28.15 (TD-038): after the read, who merges this task is recorded for the page, and — with the
 * platform merging and the provider's "mergeable" — the `platform_merge` duty is enqueued; with the
 * setting at `person` nothing is enqueued at all. A merge request that reads merged while the task
 * is still at Ready is a possibly lost `mr.merged` (`recoverLostMergeSignal`).
 */
const decideMerge = async (
  merge: PlatformMergeOptions,
  input: {
    readonly stored: StoredTask & { readonly mr: NonNullable<StoredTask['mr']> };
    readonly live: MergeRequest | null;
    readonly check: ReadyMergeCheck;
    readonly integrations: PipelineIntegrations;
    readonly checkedAt: string;
  },
): Promise<void> => {
  const { stored, live } = input;
  if (live?.state === 'merged') {
    await recoverLostMergeSignal(merge, {
      stored,
      live,
      integrations: input.integrations,
      staleBefore: Date.parse(input.checkedAt) - READY_MERGE_RECHECK_MS,
    });
    return;
  }
  const who = await whoMerges(merge, stored, input.integrations);
  // A rebase the provider wants is the platform's to ask for (TD-038 amendment A): the duty decides.
  const rebaseOnly = live?.state === 'opened' && live.merge_blocker?.reason === 'rebase';
  await merge.unitOfWork.transaction(async (scope) =>
    merge.store.tasks.recordMergeDecision(scope.tx, stored.task.id, {
      mergeBy: who.by,
      wait: who.reason,
    }),
  );
  if (who.by === 'platform' && (input.check.mergeable === true || rebaseOnly)) {
    await enqueueOutbound(merge.jobs, {
      duty: 'platform_merge',
      project_id: stored.task.projectId,
      task_id: stored.task.id,
      cause_event_id: stored.task.id,
    });
  }
};

/** What the duty did — for the tests and the log line. */
export type ReadyMergeCheckOutcome =
  | 'no_task'
  | 'not_at_ready'
  | 'no_binding'
  | 'mergeable'
  | 'blocked'
  | 'unknown';

/**
 * `pipeline.outbound` duty **ready_merge_check** — see the module docblock.
 */
export const runReadyMergeCheck = async (
  options: ReviewConversationOptions & { readonly jobs: Jobs },
  data: Pick<PipelineOutboundData, 'task_id'>,
  /**
   * S-28.15 (TD-038): who merges and the platform's merge. Absent — a caller that only checks —
   * records no merge decision and enqueues no merge.
   */
  merge?: PlatformMergeOptions,
): Promise<ReadyMergeCheckOutcome> => {
  const logger: Logger = options.logger ?? silentLogger;
  const taskId = data.task_id as Id | undefined;
  if (taskId === undefined) {
    return 'no_task';
  }
  const read = await options.unitOfWork.transaction(async (scope) => {
    const stored = await options.store.tasks.load(scope.tx, taskId);
    const verdict =
      stored === null
        ? null
        : await options.store.artifacts.latest(scope.tx, taskId, 'ReviewVerdict');
    return { stored, verdict };
  });
  const { stored } = read;
  if (stored === null) {
    return 'no_task';
  }
  if (
    stored.task.state !== 'ready_for_merge' ||
    stored.task.currentStage !== READY_FOR_MERGE_STAGE ||
    stored.mr === null ||
    stored.task.template === REVIEW_ONLY_TEMPLATE_ID
  ) {
    return 'not_at_ready';
  }
  const atReady = stored as StoredTask & { readonly mr: NonNullable<StoredTask['mr']> };
  const integrations = await integrationsForProject(
    options.integrations,
    stored.task.projectId,
    noRunScopedSecrets(),
  );
  if (integrations.git === null) {
    return 'no_binding';
  }
  const approved = reviewVerdictDataSchema.safeParse(read.verdict?.data);
  if (approved.success && approved.data.verdict === 'approve') {
    // M28 ruling R3b (2), again at Ready: idempotent, so a thread closed after the approving
    // review is not touched twice, and a task that waited from before this shipped is cleaned up.
    // The threads the Reviewer confirmed fixed are resolved without the *Left as is* note, in case
    // `review_threads_resolve` was lost (review of #155).
    const closed = await closeOwnThreads(options, integrations, {
      stored: atReady,
      logger,
      confirmed: new Set(approved.data.resolved_threads ?? []),
    });
    if (closed.reopened > 0) {
      // TD-029 Amendment D.3: a person reopened one of the platform's threads — a return signal
      // with no note, so no comment arms the window; this check does.
      await enqueueReviewCommentWindow(options.jobs, {
        taskId: stored.task.id,
        projectId: stored.task.projectId,
        iid: atReady.mr.iid,
        windowMs: 0,
        now: new Date(options.clock?.now() ?? Date.now()),
      });
    }
  }
  const context = { projectId: stored.task.projectId, taskId: stored.task.id };
  const reads = gitReads(integrations);
  const live = await reads.mergeRequest(atReady.mr, context);
  const checkedAt = new Date(options.clock?.now() ?? Date.now()).toISOString();
  const blocker = live?.merge_blocker ?? null;
  let check: ReadyMergeCheck;
  if (live === null || live.state !== 'opened' || blocker?.reason === 'checking') {
    // Not read, merged or closed (another duty owns those), or the provider has not decided yet:
    // nothing is said, and the recovery pass asks again.
    check = {
      checkedAt,
      mergeable: null,
      reason: null,
      providerStatus: null,
      unresolvedThreads: null,
    };
  } else if (blocker === null) {
    check = {
      checkedAt,
      mergeable: true,
      reason: null,
      providerStatus: null,
      unresolvedThreads: null,
    };
  } else {
    const unresolved =
      blocker.reason === 'unresolved_threads'
        ? (await reads.discussions(atReady.mr, context)).filter(
            (discussion) => discussion.resolvable && !discussion.resolved,
          ).length
        : null;
    check = {
      checkedAt,
      mergeable: false,
      reason: blocker.reason,
      providerStatus: blocker.provider_status,
      unresolvedThreads: unresolved,
    };
  }
  await options.unitOfWork.transaction(async (scope) =>
    options.store.tasks.recordReadyMergeCheck(scope.tx, stored.task.id, check),
  );
  if (merge !== undefined) {
    await decideMerge(merge, { stored: atReady, live, check, integrations, checkedAt });
  }
  const outcome: ReadyMergeCheckOutcome =
    check.mergeable === true ? 'mergeable' : check.mergeable === false ? 'blocked' : 'unknown';
  logger.info(
    {
      task_id: stored.task.id,
      outcome,
      reason: check.reason,
      unresolved_threads: check.unresolvedThreads,
    },
    'ready to merge: the provider’s mergeability was read and recorded',
  );
  return outcome;
};

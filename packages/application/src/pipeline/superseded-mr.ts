/**
 * `pipeline.outbound` duty **close_superseded_mr** — the provider half of product/04:86's *"human
 * rejection = reset, not patching"*: *"the old MR is closed, a fresh branch is created"* (WP-59,
 * PROGRESS backlog 51, **Q92**).
 *
 * `reworkStageCommand` decides, in its transaction: the task lets go of its merge request and takes
 * a new branch (`reworkBranchName`). This duty calls, after the commit and outside every
 * transaction (WP-15d): a comment on the old merge request **naming the new branch** — Q92's
 * *"its closing comment naming the new one"*, so whoever reads the closed merge request can find
 * where the work went — and then the close. Comment first, because a merge request that is closed
 * with no word is the one a reviewer reopens.
 *
 * ## What it re-validates, and what it deliberately does not
 *
 * A job is a wake-up (TD-004). The merge request is **not** on any row any more — the command
 * cleared `tasks.mr_ref` so that the provider's `mr.closed` webhook for it finds no task and cannot
 * escalate the task it was closed *for* — so it rides the payload, the way the review-only duties
 * carry theirs. On fire the duty re-reads the task and gives up when the task is gone, or when the
 * task's **current** merge request is this one again: a task that re-adopted the iid is working on
 * it, and closing it would be closing live work. It does **not** give up on a task that has since
 * finished or been cancelled: the rejected merge request is obsolete either way, and leaving it open
 * is the residual this duty exists to remove.
 *
 * ## Both calls are idempotent, in two layers
 *
 * Each carries a platform-owned idempotency key — the task and the iid, nothing a model or a
 * provider wrote (WP-24 round 2's rule) — so a retry after the provider answered replays. Under
 * that, the port's close is idempotent by its own contract (an already-closed merge request
 * succeeds), which covers a retry whose idempotency record was never written. A **merged** merge
 * request is refused by the port with `conflict`, and that ending is logged and swallowed rather
 * than retried: nothing a retry does can un-merge it, and the comment already says where the work
 * went (standing rule 20 — a notification-shaped write, not the task's own mutation).
 *
 * Both are made under the **task's mode**, so a shadow task records `would_have` and touches
 * nothing — although a shadow task never has a merge request to reach this duty with.
 *
 * ## Every ending settles the rework's row (PROGRESS backlog 178)
 *
 * The rework wrote a `superseded_merge_requests` row in its own transaction; this duty settles it
 * with the ending it reached — `closed`, `merged`, `readopted`, `unbound` or `shadow` — and leaves it
 * unsettled **only** when the close failed some other way and the job is being retried. The recovery
 * pass (`recovery/superseded-mr.ts`) re-drives a row still unsettled a pass interval later — which
 * is how a wake-up lost between the rework's commit and its enqueue is found at all.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import { IntegrationError } from '../ports/integrations/common.js';
import type { MergeRequestRefInput } from '../ports/integrations/git-provider.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import { integrationsForProject, noRunScopedSecrets, reviewWrites } from './integrations.js';
import type { PipelineOutboundData } from './jobs.js';
import type { RebaseJobOptions } from './rebase.js';
import type { SupersededMergeRequestOutcome } from './store.js';

/** The comment's marker, so a reader can tell the platform's note from a human's. */
export const supersededMarker = (taskId: Id): string => `<!-- agentic:superseded:${taskId} -->`;

/** The two idempotency keys: platform ids only. */
export const supersededCommentKey = (taskId: Id, iid: number): string =>
  `mr_superseded_comment:${taskId}:${iid}`;
export const supersededCloseKey = (taskId: Id, iid: number): string =>
  `mr_superseded_close:${taskId}:${iid}`;

/**
 * What the comment says. Pure, so a retry renders the same bytes. `newBranch` is derived from the
 * ticket key, which is provider text (BD-022), and it is redacted where it is sent
 * (`reviewWrites.thread`).
 */
export const renderSupersededComment = (input: {
  readonly taskId: Id;
  readonly newBranch: string | null;
}): string =>
  [
    supersededMarker(input.taskId),
    '**Superseded.** A person rejected this approach and asked for the work to be redone, so this merge request is being closed rather than patched.',
    '',
    input.newBranch === null
      ? 'The work continues from the default branch; a new merge request will be opened for it.'
      : `The work continues on the branch \`${input.newBranch}\`; a new merge request will be opened from it.`,
  ].join('\n');

export const runSupersededMergeRequestClose = async (
  options: RebaseJobOptions,
  data: PipelineOutboundData,
): Promise<void> => {
  const logger: Logger = options.logger ?? silentLogger;
  const taskId = data.task_id as Id | undefined;
  const iid = data.iid;
  const url = data.mr_url;
  if (taskId === undefined || iid === undefined || url === undefined) {
    logger.warn(
      { task_id: taskId ?? null, duty: data.duty },
      'close_superseded_mr: the wake-up names no merge request, so there is nothing to close',
    );
    return;
  }
  const stored = await options.unitOfWork.transaction(async (scope) =>
    options.store.tasks.load(scope.tx, taskId),
  );
  if (stored === null) {
    return;
  }
  const settle = async (outcome: SupersededMergeRequestOutcome): Promise<void> => {
    // The row the rework wrote (PROGRESS backlog 178): settled at every ending, so the recovery
    // pass re-drives exactly the wake-ups that never reached one.
    await options.unitOfWork.transaction(async (scope) =>
      options.store.tasks.settleSupersededMergeRequest(scope.tx, {
        taskId,
        iid,
        outcome,
        at: options.clock.now() as IsoDateTime,
      }),
    );
  };
  if (stored.mr?.iid === iid) {
    logger.info(
      { task_id: taskId, iid },
      'close_superseded_mr: the task is working on this merge request again, so it is left open',
    );
    await settle('readopted');
    return;
  }

  // Outside every transaction (WP-15d), and outside a run (Q55).
  const integrations = await integrationsForProject(
    options.integrations,
    stored.task.projectId,
    noRunScopedSecrets(),
  );
  if (integrations.git === null) {
    logger.info(
      { task_id: taskId, iid },
      'close_superseded_mr: this project has no git binding any more, so the merge request cannot be closed from here',
    );
    await settle('unbound');
    return;
  }
  const writes = reviewWrites(integrations);
  const ref: MergeRequestRefInput = {
    provider: null,
    project_path: data.mr_project_path ?? null,
    iid,
    url,
    branch: null,
    head_sha: null,
  };
  const context = { projectId: stored.task.projectId, taskId, mode: stored.task.mode };

  await writes.thread(
    {
      ref,
      path: null,
      line: null,
      markdown: renderSupersededComment({ taskId, newBranch: data.new_branch ?? null }),
      idempotencyKey: supersededCommentKey(taskId, iid),
    },
    context,
  );
  let closed: Awaited<ReturnType<typeof writes.close>>;
  try {
    closed = await writes.close({ ref, idempotencyKey: supersededCloseKey(taskId, iid) }, context);
  } catch (error) {
    if (error instanceof IntegrationError && error.code === 'conflict') {
      logger.info(
        { task_id: taskId, iid },
        'close_superseded_mr: the merge request was merged before it could be closed; nothing a retry does can change that',
      );
      await settle('merged');
      return;
    }
    // Any other failure leaves the row unsettled on purpose: pg-boss retries the job, and the
    // recovery pass re-drives it once more after that and then ends it loudly (backlog 178).
    throw error;
  }
  // A shadow task's close is `would_have` and answers no merge request; nothing was sent.
  await settle(closed === null && stored.task.mode === 'shadow' ? 'shadow' : 'closed');
  logger.info(
    { task_id: taskId, iid },
    'close_superseded_mr: the rejected merge request is closed',
  );
};

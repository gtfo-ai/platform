/**
 * **Resolve on merge** — the Sentry half product/08 promises for a bug task's merge, built opt-in
 * (WP-111, PROGRESS backlog 302, ruled option (b)).
 *
 * product/08: *"On merge: comment on the Sentry issue with the MR link; optional resolve-in-next-
 * release."* The comment half cannot be built on documented Sentry API — Sentry publishes no comment
 * or code-link endpoint, so the adapter refuses both (Q43) — and this module does not call either.
 * The resolve half is built, and **only for a binding that asks for it**: `resolve_on_merge` on the
 * errors binding, off by default, because product/08 calls it *"optional"* and it writes to
 * somebody else's Sentry.
 *
 * ## The shape is WP-15d's: the handler decides, the job calls
 *
 * One handler on `mr.merged` at TD-005 priority 120 (the integrations band, beside the merge
 * measure) finds the task the merge belongs to and enqueues the `resolve_on_merge` duty **only for
 * a task on the `bug` template** — a row read inside the dispatcher's transaction, no provider. The
 * duty, outside every transaction:
 *
 *  1. re-validates on fire (TD-004): the task exists and is still a bug task;
 *  2. resolves the project's errors binding through `observabilityForProject` — **none** is the end
 *     (nothing read, nothing written, no `integration_actions` row); one that **will not load
 *     throws**, because a write the operator asked for that silently stopped happening is the
 *     failure nobody would see (rule 20: *broken is not absent*);
 *  3. reads the binding's `resolveOnMerge()` — `false` is the end, with no row;
 *  4. runs `linkedIssues` over the task's **stored ticket snapshot** (the text the platform already
 *     read, bounded and redacted at intake — WP-15f), the same scan the bug pre-fetch uses;
 *  5. calls `resolve` once per linked issue through the executor (`errorWrites`): one
 *     `integration_actions` row each, `would_have` for a shadow task.
 *
 * ## Idempotent twice over
 *
 * WP-110 made `mr.merged` arrive from a webhook **or** a poll and deduplicated the two in the event
 * log (`recordNormalisedDelivery` drops a merge the log already holds), and `handler_executions`
 * answers a redelivered event before this handler runs. Neither is this duty's guarantee, so it
 * keeps its own: each resolve carries an `IdempotencyPlan` keyed on **the task and the issue**
 * ({@link resolveOnMergeKey}), never on the wake-up. A job retried after Sentry answered, or a second
 * distinct `mr.merged` for the same task (a merge request reopened and merged again), therefore
 * **replays** — a `replayed` audit row, no provider call — and resolves nothing twice. The key is
 * platform text around a task id and an issue id the adapter parsed out of a link to its own
 * instance (digits, for Sentry), so it never needs redacting (`idempotencyScopeFor` refuses one that
 * does).
 *
 * ## What it does not do, stated
 *
 *  - **No release.** `resolve` is sent without `inRelease`: the platform learns that a merge
 *    happened, not which release will carry it, and a wrong release would tell Sentry the fix shipped
 *    somewhere it did not. product/08's *"resolve-in-next-release"* is Sentry's own
 *    `resolvedInNextRelease` status, which the adapter does not send (filed with WP-111).
 *  - **No comment, no link** (Q43, above). The vendor's `Fixes <SHORT-ID>` commit convention is the
 *    route the setup guide gives for linking code to an issue.
 *  - **Which issues** is the ticket text's choice, inside the binding's organisation only
 *    (`linkedIssues` recognises a link to the binding's own host and organisation and nothing else):
 *    the residual the pre-fetch already states, here with a write behind it. The snapshot keeps the
 *    title, the description **and the newest twenty comments that carry no platform
 *    marker** (`ticket-snapshot.ts`, `commentsOf`), so on a flagged binding **anyone who can comment on the ticket** — not
 *    only its author — can make the platform resolve any issue of that organisation by linking it
 *    on a bug ticket that then merges. It is why the flag is off unless an operator sets it.
 *  - A failure on one issue does not stop the others: a refusal Sentry will repeat (`not_found`, a
 *    `forbidden` token) is logged and stays on the record as a `failed` row; a failure a retry may
 *    cure (`rate_limited`, `unavailable`) fails the job after the rest were tried, and the retry
 *    replays what already succeeded.
 */
import type { Id } from '@platform/contracts';
import type { EventHandler, HandlerContext } from '../events/handler.js';
import { IntegrationError } from '../ports/integrations/common.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { BUG_TEMPLATE_ID } from './delivery-measures.js';
import { errorWrites, noRunScopedSecrets, observabilityForProject } from './integrations.js';
import { enqueueOutbound, type PipelineOutboundData } from './jobs.js';
import type { PipelineSagaOptions } from './saga.js';
import type { StoredTask } from './store.js';

export interface ResolveOnMergeOptions extends PipelineSagaOptions {
  readonly unitOfWork: UnitOfWork;
}

/**
 * The idempotency key of one resolve: the task and the issue, never the wake-up — so a second merge
 * event for the same task replays rather than resolving again (module docblock).
 */
export const resolveOnMergeKey = (taskId: Id, issueId: string): string =>
  `resolve_on_merge:${taskId}:${issueId}`;

const isBugTask = (stored: StoredTask): boolean => stored.task.template === BUG_TEMPLATE_ID;

/**
 * `mr.merged` → resolve the bug task's linked issues, if its binding asks.
 *
 * Priority **120**, beside the merge measure: it asks the outside world something, and the core
 * band's merged gate settles first. The task is found as every `mr.*` consumer finds it — the
 * payload's `task_id` when the producer knew it, otherwise `tasks.mr_ref`'s iid. Whether the
 * binding is flagged is the **job's** question: answering it needs the binding, which is I/O.
 */
export const resolveOnMergeHandler = (options: PipelineSagaOptions): EventHandler => ({
  name: 'pipeline.errors.resolve_on_merge',
  priority: 120,
  eventTypes: ['mr.merged'],
  handle: async (context: HandlerContext) => {
    const event = context.event.event;
    if (event.type !== 'mr.merged') {
      return;
    }
    const { payload } = event;
    const stored =
      payload.task_id === null || payload.task_id === undefined
        ? await options.store.tasks.findByMergeRequest(context.scope.tx, {
            projectId: payload.project_id,
            iid: payload.mr.iid,
          })
        : await options.store.tasks.load(context.scope.tx, payload.task_id);
    if (stored === null || !isBugTask(stored)) {
      return;
    }
    const data: PipelineOutboundData = {
      duty: 'resolve_on_merge',
      project_id: payload.project_id,
      task_id: stored.task.id,
      cause_event_id: event.id,
    };
    context.afterCommit(async () => {
      await enqueueOutbound(options.jobs, data);
    });
  },
});

/** The ticket text a link is looked for in — the pre-fetch's own choice of fields. */
const snapshotText = (stored: StoredTask): string | null => {
  const snapshot = stored.ticketSnapshot;
  if (snapshot === null) {
    return null;
  }
  return [
    snapshot.title,
    snapshot.description,
    ...snapshot.comments.map((comment) => comment.body),
  ].join('\n');
};

/**
 * `pipeline.outbound` duty **resolve_on_merge** — the module docblock's five steps.
 *
 * @throws when the errors binding exists and will not load, when a resolve failed in a way a retry
 * may cure, and `TransactionOpenError` when a later change moves a call inside a transaction.
 */
export const runResolveOnMerge = async (
  options: ResolveOnMergeOptions,
  data: PipelineOutboundData,
): Promise<void> => {
  const logger: Logger = options.logger ?? silentLogger;
  const projectId = data.project_id as Id;
  const taskId = data.task_id as Id | undefined;
  if (taskId === undefined) {
    logger.warn({ project_id: projectId }, 'resolve on merge: the wake-up named no task');
    return;
  }
  const stored = await options.unitOfWork.transaction(async (scope) =>
    options.store.tasks.load(scope.tx, taskId),
  );
  if (stored === null || !isBugTask(stored)) {
    return;
  }
  const binding = await observabilityForProject(
    options.integrations,
    projectId,
    'errors',
    // Outside a run: nothing on this path holds a minted credential (Q55).
    noRunScopedSecrets(),
  );
  if (binding === null) {
    logger.debug(
      { task_id: taskId },
      'resolve on merge: this project has no errors binding, so nothing is resolved',
    );
    return;
  }
  if (!binding.port.resolveOnMerge()) {
    logger.debug(
      { task_id: taskId, integration_id: binding.ref.integrationId },
      'resolve on merge: the errors binding does not set resolve_on_merge, so nothing is resolved',
    );
    return;
  }
  const text = snapshotText(stored);
  if (text === null) {
    logger.warn(
      { task_id: taskId },
      'resolve on merge: the task holds no ticket snapshot, so no linked issue can be found',
    );
    return;
  }
  const links = binding.port.linkedIssues(text);
  const context = {
    projectId,
    taskId,
    mode: stored.task.mode,
  };
  const retryable: IntegrationError[] = [];
  for (const link of links) {
    try {
      const resolved = await errorWrites(binding).resolve(link.id, {
        ...context,
        idempotencyKey: resolveOnMergeKey(taskId, link.id),
      });
      logger.info(
        { task_id: taskId, issue_id: link.id, status: resolved.status },
        'resolve on merge: resolved an issue the bug ticket links',
      );
    } catch (error) {
      if (!(error instanceof IntegrationError)) {
        throw error;
      }
      logger.warn(
        { task_id: taskId, issue_id: link.id, err: error },
        'resolve on merge: the provider refused to resolve an issue the bug ticket links',
      );
      if (error.retryable) {
        retryable.push(error);
      }
    }
  }
  logger.info(
    { task_id: taskId, linked_issues: links.length, retryable_failures: retryable.length },
    'resolve on merge: done',
  );
  const [first] = retryable;
  if (first !== undefined) {
    throw first;
  }
};

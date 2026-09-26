/**
 * A Reviewer run over the **human** merge request of a shadow ticket — product/19 §13's *"Reviewer
 * findings the human MR would have received (posted nowhere)"* and the human half of *"acceptance
 * criteria the human MR covers vs the agent's"* (WP-45, PROGRESS backlog 100).
 *
 * ## The shape, decided
 *
 * **A one-stage review task, in `shadow` mode, per shadow ticket.** `runs.task_id` is `not null`, so
 * a run needs a task whatever else is decided (`onboarding/discovery.ts` and `pipeline/review-only.ts`
 * make the same argument), and review-only mode already has the one-stage template that runs the
 * Reviewer over a merge request the platform read (`REVIEW_ONLY_TEMPLATE`). So this module creates a
 * task on that template through the same `insertReviewTask`, with two differences and both are the
 * point:
 *
 *  - **`mode: 'shadow'`.** The task's mode is what `IntegrationActionExecutor` reads, so every thread
 *    the review-only posting duty would put on the human's merge request is recorded as a
 *    `would_have` audit row and nothing reaches the provider — *"posted nowhere"* is the executor's
 *    guarantee, not this module's. The same mode puts the run's spend under the project's shadow
 *    budget (`shadowSpendSince` groups the ledger by `tasks.mode`), which is the only cap product/19
 *    §13 needs for a second run per ticket.
 *  - **The shadow task's `RefinedSpec` is copied onto it.** The Reviewer is then given a
 *    specification *and* a `merge_request` block, which is the case its prompt (version 3) answers
 *    with `criteria` — one judgement per acceptance criterion, by id. The copy is an artifact row
 *    with no producing run, like the report itself.
 *
 * **One per ticket, not one per merge request**, because the criteria are per ticket: two tickets
 * delivered by one human merge request are two comparisons against two specifications. The key is
 * {@link shadowReviewTicketKeyFor}, and `unique (project_id, ticket_key, mode)` makes the creation
 * idempotent exactly as `mr!<iid>` does for review-only mode.
 *
 * ## When the report is written
 *
 * The report duty creates the review and **waits**: it writes nothing until the review task has
 * ended, and {@link shadowHumanReviewEndedHandler} wakes it again when it does. "Ended" is
 * `done`, `cancelled`, `needs_human` **or `paused`**. The last is a decision: a review paused on the
 * shadow budget may never resume, and a batch whose report waited on it would never complete, so the
 * report is written without the review and `notes` names the state. A review resumed after its
 * report was written is not folded in — the report is written once (`shadow_reports` is keyed by the
 * task) — and that residual is stated here rather than implied.
 */
import type { Id, MergeRequestRef, ReviewVerdictData, TicketRef } from '@platform/contracts';
import { reviewVerdictDataSchema } from '@platform/contracts';
import type { EventHandler, HandlerContext } from '../events/handler.js';
import { gitReads, integrationsForProject, noRunScopedSecrets } from '../pipeline/integrations.js';
import { enqueueOutbound, enqueueStage, type PipelineOutboundData } from '../pipeline/jobs.js';
import {
  boundMergeRequestSnapshot,
  insertReviewTask,
  MAX_MR_FILES,
  REVIEW_ONLY_TEMPLATE_ID,
  REVIEW_ONLY_TICKET_PROVIDER,
  type ReviewOnlyOptions,
  reviewTicketKeyFor,
} from '../pipeline/review-only.js';
import type { StoredTask } from '../pipeline/store.js';
import { silentLogger } from '../ports/logger.js';

/**
 * `mr!<iid>/shadow/<shadow task id>` — the review of one human merge request **for one shadow
 * ticket**.
 *
 * It starts with review-only mode's own key so `reviewedIidOf` reads the merge request out of it,
 * and it carries the shadow task so the review's ending can wake the right report without a column
 * of its own.
 */
export const shadowReviewTicketKeyFor = (iid: number, shadowTaskId: Id): string =>
  `${reviewTicketKeyFor(iid)}/shadow/${shadowTaskId}`;

/** The shadow task a review task's key names, or `null` for every other key. */
export const shadowTaskOfReviewKey = (ticketKey: string): Id | null => {
  const match =
    /^mr!\d+\/shadow\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(
      ticketKey,
    );
  return match === null ? null : (match[1] as Id);
};

/** The review task's states the report stops waiting at — see the module docblock for `paused`. */
export const HUMAN_REVIEW_ENDED_STATES: ReadonlySet<string> = new Set([
  'done',
  'cancelled',
  'needs_human',
  'paused',
]);

/** What the report is told about the review of the human merge request. */
export type HumanReview =
  /** A verdict exists: its findings, and its criteria when the Reviewer judged them. */
  | { readonly kind: 'reviewed'; readonly verdict: ReviewVerdictData }
  /** The review task ended without a verdict the platform can read. */
  | { readonly kind: 'ended_without_verdict'; readonly state: string }
  /** The provider would not return the human merge request, so no review could be created. */
  | { readonly kind: 'unreadable' };

/**
 * The review of a shadow task's human merge request: what it concluded, or `'waiting'` when it has
 * not ended — having created and started it, the first time it is asked.
 *
 * Called from the report duty, **outside every transaction**: the two provider reads that feed the
 * review's snapshot are made here, between the lookup and the creation, which is the read / call /
 * write shape `runReviewOnlyCheck` has.
 */
export const humanReviewOf = async (
  options: ReviewOnlyOptions,
  input: {
    readonly shadow: StoredTask;
    readonly humanMr: MergeRequestRef;
    readonly causeEventId: Id | null;
  },
): Promise<HumanReview | 'waiting'> => {
  const logger = options.logger ?? silentLogger;
  const { shadow, humanMr } = input;
  const projectId = shadow.task.projectId;
  const ticket: TicketRef = {
    provider: REVIEW_ONLY_TICKET_PROVIDER,
    key: shadowReviewTicketKeyFor(humanMr.iid, shadow.task.id),
    url: humanMr.url,
  };
  const lookup = {
    projectId,
    provider: ticket.provider,
    ticketKey: ticket.key,
    mode: 'shadow',
  } as const;

  const existing = await options.unitOfWork.transaction(async (scope) => {
    const review = await options.store.tasks.findByTicket(scope.tx, lookup);
    if (review === null) {
      return null;
    }
    if (!HUMAN_REVIEW_ENDED_STATES.has(review.task.state)) {
      return 'waiting' as const;
    }
    const artifact = await options.store.artifacts.latest(
      scope.tx,
      review.task.id,
      'ReviewVerdict',
    );
    const verdict = artifact === null ? null : reviewVerdictDataSchema.safeParse(artifact.data);
    return verdict?.success === true
      ? ({ kind: 'reviewed', verdict: verdict.data } as const)
      : ({ kind: 'ended_without_verdict', state: review.task.state } as const);
  });
  if (existing !== null) {
    return existing;
  }

  const integrations = await integrationsForProject(
    options.integrations,
    projectId,
    noRunScopedSecrets(),
  );
  const git = integrations.git;
  const reads = gitReads(integrations);
  const context = { projectId, taskId: shadow.task.id };
  const mergeRequest = git === null ? null : await reads.mergeRequest(humanMr, context);
  if (git === null || mergeRequest === null) {
    return { kind: 'unreadable' };
  }
  const files = await reads.mergeRequestDiff(humanMr, MAX_MR_FILES, context);
  const snapshot = boundMergeRequestSnapshot(mergeRequest, files ?? [], git.redactor);
  const settings = await options.settings.forProject(projectId);

  const work = await options.unitOfWork.transaction(async (scope) => {
    if ((await options.store.tasks.findByTicket(scope.tx, lookup)) !== null) {
      return null;
    }
    const inserted = await insertReviewTask(options, scope, {
      projectId,
      ticket,
      mode: 'shadow',
      snapshot,
      settings,
      causeEventId: input.causeEventId,
    });
    // The agent's specification, so the Reviewer judges the human's change against the same
    // criteria the agent's own Acceptance Tester used — the yardstick the report labels.
    const spec = await options.store.artifacts.latest(scope.tx, shadow.task.id, 'RefinedSpec');
    if (spec !== null) {
      await options.store.artifacts.insert(scope.tx, {
        id: options.ids.next(),
        taskId: inserted.stored.task.id,
        type: 'RefinedSpec',
        version: 1,
        markdown: null,
        data: spec.data,
        schemaVersion: spec.schemaVersion,
        // No run of this task produced it: it is the shadow task's, copied.
        producedByRunId: null,
        redactionCount: 0,
        createdAt: options.clock.now(),
      });
    }
    return inserted.work;
  });
  if (work !== null) {
    logger.info(
      { task_id: shadow.task.id, human_mr: humanMr.iid },
      'shadow: reviewing the human merge request before the report is written',
    );
    await enqueueStage(options.jobs, work);
  }
  return 'waiting';
};

/**
 * The review of a human merge request ended — wake its shadow task's report (WP-45).
 *
 * TD-005 priority **130**, beside the report's own trigger: it decides and enqueues, and the report
 * duty re-validates on fire (the report may already exist, and `insertReport` answers whether it
 * wrote), so a redelivered ending writes nothing twice.
 */
export const shadowHumanReviewEndedHandler = (options: ReviewOnlyOptions): EventHandler => ({
  name: 'shadow.human_review.ended',
  priority: 130,
  eventTypes: ['task.completed', 'task.escalated', 'task.cancelled', 'task.paused'],
  handle: async (context: HandlerContext) => {
    const event = context.event.event;
    if (
      event.type !== 'task.completed' &&
      event.type !== 'task.escalated' &&
      event.type !== 'task.cancelled' &&
      event.type !== 'task.paused'
    ) {
      return;
    }
    const stored = await options.store.tasks.load(context.scope.tx, event.payload.task_id);
    if (
      stored === null ||
      stored.task.mode !== 'shadow' ||
      stored.task.template !== REVIEW_ONLY_TEMPLATE_ID
    ) {
      return;
    }
    const shadowTaskId = shadowTaskOfReviewKey(stored.task.ticket.key);
    if (shadowTaskId === null) {
      return;
    }
    const data: PipelineOutboundData = {
      duty: 'shadow_report',
      project_id: stored.task.projectId,
      task_id: shadowTaskId,
      cause_event_id: event.id,
    };
    context.afterCommit(async () => {
      await enqueueOutbound(options.jobs, data);
    });
  },
});

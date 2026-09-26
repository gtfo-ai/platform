/**
 * The human-time projector — technical/03:88's *"derived from events by a projector"*, product/19
 * §16, product/09:29 (WP-29).
 *
 * **One handler, one writer.** Every row of `human_time_entries` is written here, in the handler's
 * own transaction, together with the `handler_executions` claim that says the handler ran (TD-005).
 * That is what makes it idempotent under redelivery: a second dispatch of an event finds a
 * `succeeded` claim and never reaches this code, and so does a backfill pass over the same range
 * (`events/replay.ts`). Nothing here writes an id, a sequence or a counter of its own that a second
 * run could advance.
 *
 * ## What supplies each of product/19 §16's anchors, and what does not
 *
 * > *"review = from the first human MR activity (comment, approval, review start) to merge or last
 * > activity"*
 *
 * The catalogue (technical/02) has `mr.opened`, `mr.updated`, `mr.merged`, `mr.closed`,
 * `mr.review.comment` and, since WP-60, `mr.approved`. So:
 *
 *  - **comment** → `mr.review.comment`, carrying its `author`.
 *  - **approval** → `mr.approved` (WP-60, PROGRESS backlog 90), carrying its `approver`. Until
 *    WP-60 there was no such event, and **a reviewer who approved a merge request without writing a
 *    comment contributed zero minutes** — this paragraph said so as the projector's residual. That
 *    sentence is no longer true for a merge request whose provider sends the approval, which the
 *    only registered git provider (GitLab) does; a withdrawn approval is still not read (the
 *    normaliser drops it, `gitlab/inbound.ts` says why).
 *  - **merge** → `mr.merged`, the window's ending.
 *  - **review start** → *nothing*: there is no review-requested type, and this residual stands.
 *  - `mr.updated` is deliberately **not** read. It carries no author at all (`mrPayload` has none),
 *    so it cannot attribute a minute to anybody, and it fires for the platform's *own* pushes — the
 *    Developer stage pushing commits would read as a human reviewing. It is consumed since WP-60,
 *    but by the pipeline and for the revision it carries (`pipeline/provider-signals.ts`), never
 *    as activity.
 *
 * The other three kinds are exact, because the platform itself produces both ends:
 * `task.question.answered` (with the `questions` row for *"asked"*), `task.approval.decided` and
 * `run.steered`.
 *
 * ## What it refuses to record, and why each refusal is not a zero
 *
 *  - A merge request that belongs to **no task**: `human_time_entries.task_id` is `not null`, and
 *    every human-authored merge request review-only mode observes is one of these. Named in the log.
 *  - The platform's **own** merge-request comments. Every comment this platform posts carries an
 *    HTML marker (`<!-- agentic:… -->`, {@link PLATFORM_COMMENT_MARKER_PREFIX}), so a bot comment
 *    is not counted as a human reviewing. Two residuals, both stated at the constant.
 *  - A comment or an approval by an account an operator **declared a machine** (WP-61, PROGRESS
 *    backlog 88, `user_identities.kind`, migration 0045) — somebody else's bot, which carries no
 *    marker. Declared, never guessed: nothing here reads a `[bot]` suffix or a provider's bot flag.
 *    A bot declared **after** its activity was folded keeps the rows it already has — the
 *    `handler_executions` claim makes a replay a no-op for them — and the statistics read excludes
 *    those rows instead (`apps/server/src/queries/stats-queries.ts`).
 *  - An **expired** approval, and a decision with no decider: nobody spent ten minutes deciding.
 *  - A provider account id longer than {@link MAX_EXTERNAL_AUTHOR_CHARS}: refused rather than
 *    truncated, because truncation is many-to-one and would answer one reviewer's minutes with
 *    another's (WP-19 made the same call for `cost_entries.model`).
 *
 * Every one of these logs by name, and none of them writes a row at all — because a row is a claim
 * that somebody spent time, and the absence of a measurement is not zero (standing rule 16).
 *
 * The one **measured** zero this projector does write is the review window that has seen exactly one
 * activity: product/19 §16 defines the review as the wall clock *"from the first human MR activity …
 * to merge or last activity"*, so one comment and nothing else is a window of zero length. That is
 * the document's arithmetic rather than a defect, and it is why `HumanTimeSummary` publishes an
 * entry **count** beside the minutes: `0 minutes over 1 entry` and `no entries` are different facts.
 */
import type { DomainEvent, Id, IsoDateTime } from '@platform/contracts';
import { resolveBudgetTimezone } from '../cost/window.js';
import type { EventHandler, HandlerContext } from '../events/handler.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import {
  APPROVAL_FLAT_MINUTES,
  continuesWindow,
  elapsedMinutes,
  questionMinutes,
  reviewMinutes,
  STEER_FLAT_MINUTES,
} from './minutes.js';
import type {
  ExternalAccount,
  HumanTimeEntry,
  HumanTimeIdentity,
  HumanTimeStore,
} from './ports.js';

/** The handler's name is its `handler_executions` key; renaming it re-runs it over the whole log. */
export const HUMAN_TIME_HANDLER = 'human.time';

/**
 * technical/02:166's own band for this consumer: *"stats (230)"* on the `mr.*` row.
 *
 * TD-005's 200–299 band is notifications and UI, and a statistics projection is the same kind of
 * consumer — it decides nothing the pipeline waits for. Running **after** the core handlers is also
 * what this projector needs: at 230 the task↔merge-request association an earlier handler wrote has
 * already committed, so `taskForMergeRequest` can find it.
 */
export const HUMAN_TIME_PRIORITY = 230;

/**
 * The marker every comment this platform posts on a merge request carries.
 *
 * `reviewMarkerFor`, `reviewSummaryMarkerFor` (WP-24), `conflictWarningMarker` (WP-26) and the
 * ticket linter's `LINT_COMMENT_MARKER` (WP-25) all start with it, which
 * `platform-comment-marker.test.ts` asserts against those builders rather than against a copy of
 * the string — so a new marker that forgot the prefix fails there.
 *
 * **Two residuals, in opposite directions.** A human who pastes this prefix into a review comment
 * loses that comment's contribution to their own window (they can only under-report themselves).
 * A *different* bot — CI, a dependency updater — has no marker, so its comments are counted as
 * human review activity **until an operator declares its account a machine** (WP-61, PROGRESS
 * backlog 88: `POST /api/org/identities` with `kind: "machine"`), after which the projector refuses
 * them. The platform still cannot tell a robot from a person by itself, and does not try; an
 * undeclared bot over-counts exactly as before.
 */
export const PLATFORM_COMMENT_MARKER_PREFIX = '<!-- agentic:';

/**
 * The bound on a stored provider account id. 256 characters is `nonEmptyStringSchema.max(256)`, the
 * same bound WP-26 put on a ticket key, and two orders of magnitude past any real account id.
 */
export const MAX_EXTERNAL_AUTHOR_CHARS = 256;

export interface HumanTimeProjectorOptions {
  readonly store: HumanTimeStore;
  readonly logger?: Logger;
}

/** `"<provider>:<external id>"`, or `null` when it is too long to be an identity (see above). */
export const externalAuthorKey = (account: ExternalAccount): string | null => {
  const key = `${account.provider}:${account.externalId}`;
  return key.length > MAX_EXTERNAL_AUTHOR_CHARS ? null : key;
};

/**
 * Two identities are the same reviewer when they name the same platform user — or, when both carry
 * the provider account, the same account: an operator who maps `gitlab:ada` **between** two of
 * Ada's comments would otherwise open a second window at the second comment (`null === ADA` is
 * false), dropping the gap between the sittings from the total and showing one person on two
 * lines, which is the reconciliation migration 0025's `external_author` exists for.
 */
const sameIdentity = (a: HumanTimeIdentity, b: HumanTimeIdentity): boolean => {
  if (a.externalAuthor !== null && b.externalAuthor !== null) {
    return a.externalAuthor === b.externalAuthor;
  }
  return a.userId !== null && a.userId === b.userId;
};

/**
 * The organisation's zone, or UTC — and it **fails open**, exactly as the cost ledger does.
 *
 * `resolveBudgetTimezone` is shared with the ledger, the budgets read and the guard so that one bad
 * setting cannot produce four different behaviours (standing rule 9). A handler that threw would
 * park the stream it is on and stop recording minutes for every project, over one organisation's
 * misconfiguration — rule 20's shape — so the substitution is logged by name and the window is
 * measured in UTC, which is what an unset zone already means (Q12).
 */
const usableTimezone = async (
  options: HumanTimeProjectorOptions,
  context: HandlerContext,
  projectId: Id,
  logger: Logger,
): Promise<string> => {
  const configured = await options.store.organisationTimezone(context.scope.tx, projectId);
  const resolved = resolveBudgetTimezone(configured);
  if (resolved.substituted) {
    logger.warn(
      { timezone: configured, fallback: resolved.timezone, project_id: projectId },
      'human time: the organisation timezone is not an IANA zone this runtime can do calendar arithmetic in; the review window is measured in UTC',
    );
  }
  return resolved.timezone;
};

/**
 * Opens or extends the review window this activity belongs to.
 *
 * `identity === null` is the **merge**: it has no author, so it ends every window that is still
 * within the gap, and opens none — a merge with no prior review activity is not review time
 * (product/19 §16 starts the window at the *first human MR activity*, not at the merge).
 */
const foldReviewActivity = async (
  options: HumanTimeProjectorOptions,
  context: HandlerContext,
  input: {
    readonly taskId: Id;
    readonly projectId: Id;
    readonly at: IsoDateTime;
    readonly identity: HumanTimeIdentity | null;
  },
  logger: Logger,
): Promise<void> => {
  const { identity } = input;
  const entries = await options.store.reviewEntries(context.scope.tx, input.taskId);
  const candidates =
    identity === null ? entries : entries.filter((entry) => sameIdentity(entry, identity));

  const open = candidates.filter((entry) => continuesWindow(lastActivityOf(entry), input.at));

  if (open.length === 0) {
    if (identity === null) {
      logger.debug(
        { task_id: input.taskId },
        'human time: a merge with no review window inside the gap; nothing to end',
      );
      return;
    }
    await options.store.appendEntry(context.scope.tx, {
      taskId: input.taskId,
      kind: 'review',
      ...identity,
      startedAt: input.at,
      endedAt: input.at,
      // A window that has just opened has measured nothing yet — and `0` here is a *measurement*
      // rather than an absence, which is why it is a number and not `null`: `null` means "still
      // open, nothing computed", and this window is both open and worth exactly no minutes so far.
      minutes: 0,
    });
    return;
  }

  const timezone = await usableTimezone(options, context, input.projectId, logger);
  for (const entry of open) {
    // Only forward. An event whose `occurred_at` is inside a window the projector has already
    // extended past adds nothing, and moving `ended_at` backwards would *shrink* a measured window
    // — which a replay beside live traffic, or a provider clock that went backwards, would do.
    if (elapsedMinutes(lastActivityOf(entry), input.at) === 0) {
      continue;
    }
    await options.store.extendEntry(context.scope.tx, entry.id, {
      endedAt: input.at,
      minutes: reviewMinutes(entry.startedAt, input.at, timezone),
    });
  }
};

/** The window's last known activity: its ending, or its start when it has none. */
const lastActivityOf = (entry: HumanTimeEntry): IsoDateTime => entry.endedAt ?? entry.startedAt;

/** The task that owns this merge request, or `null` with the reason logged. */
const taskOfMergeRequest = async (
  options: HumanTimeProjectorOptions,
  context: HandlerContext,
  subject: { readonly projectId: Id; readonly taskId: Id | null; readonly iid: number },
  logger: Logger,
): Promise<Id | null> => {
  const taskId =
    subject.taskId ??
    (await options.store.taskForMergeRequest(context.scope.tx, {
      projectId: subject.projectId,
      iid: subject.iid,
    }));
  if (taskId === null) {
    logger.debug(
      { project_id: subject.projectId, iid: subject.iid },
      'human time: this merge request belongs to no task, and an entry is task-scoped; nothing is recorded',
    );
  }
  return taskId;
};

const onReviewComment = async (
  options: HumanTimeProjectorOptions,
  context: HandlerContext,
  event: Extract<DomainEvent, { type: 'mr.review.comment' }>,
  logger: Logger,
): Promise<void> => {
  if (event.payload.text.includes(PLATFORM_COMMENT_MARKER_PREFIX)) {
    logger.debug(
      { project_id: event.payload.project_id, iid: event.payload.mr.iid },
      'human time: this comment carries the platform’s own marker, so it is not human review activity',
    );
    return;
  }
  await foldAuthoredActivity(
    options,
    context,
    {
      projectId: event.payload.project_id,
      taskId: event.payload.task_id ?? null,
      iid: event.payload.mr.iid,
      author: event.payload.author,
      at: event.occurred_at,
    },
    logger,
  );
};

/**
 * One review activity by a named person on a merge request — a comment or, since WP-60, an
 * approval: find the task, refuse an over-long account id, resolve the platform user, fold.
 */
const foldAuthoredActivity = async (
  options: HumanTimeProjectorOptions,
  context: HandlerContext,
  input: {
    readonly projectId: Id;
    readonly taskId: Id | null;
    readonly iid: number;
    readonly author: { readonly provider: string; readonly external_id: string };
    readonly at: IsoDateTime;
  },
  logger: Logger,
): Promise<void> => {
  const taskId = await taskOfMergeRequest(
    options,
    context,
    { projectId: input.projectId, taskId: input.taskId, iid: input.iid },
    logger,
  );
  if (taskId === null) {
    return;
  }
  const account: ExternalAccount = {
    provider: input.author.provider,
    externalId: input.author.external_id,
  };
  const externalAuthor = externalAuthorKey(account);
  if (externalAuthor === null) {
    logger.warn(
      { task_id: taskId, provider: account.provider, length: account.externalId.length },
      'human time: this reviewer’s account id is longer than an identity may be; the minutes are refused rather than attributed to a truncated key',
    );
    return;
  }
  const resolution = await options.store.resolveAccount(context.scope.tx, account);
  if (resolution.kind === 'machine') {
    // PROGRESS backlog 88 (WP-61): an operator declared this account a bot — CI, a dependency
    // updater — so its comment or approval is not a person reviewing. Refused, not written as a
    // zero-minute row: it neither opens a window nor extends one, and a row would be a claim that
    // somebody spent time (standing rule 16). The marker check on comments stays beside this one,
    // because it is the one that still holds for the platform's own bot account.
    logger.debug(
      { task_id: taskId, provider: account.provider },
      'human time: an operator declared this account a machine, so its activity is not human review time; nothing is recorded',
    );
    return;
  }
  const userId = resolution.kind === 'person' ? resolution.userId : null;
  await foldReviewActivity(
    options,
    context,
    { taskId, projectId: input.projectId, at: input.at, identity: { userId, externalAuthor } },
    logger,
  );
};

/**
 * An approval — product/19 §16's *"approval"* anchor of the review window (WP-60, PROGRESS backlog
 * 90). The same fold as a comment: it opens the approver's window or extends it, and an approval
 * with no comment beside it is a window of one activity — a measured zero, as a lone comment is.
 *
 * Dated by the envelope's `occurred_at`, the same clock a comment is dated by, and **not** by the
 * payload's `approved_at`: that is the provider's instant, `null` on a GitLab older than 18.10, and
 * two clocks inside one window would make its length depend on two machines agreeing. No marker
 * check: the platform never approves a merge request, so there is no bot approval of its own to
 * exclude — another bot's approval counts as a person's unless an operator declared its account a
 * machine (WP-61), which {@link foldAuthoredActivity} refuses for approvals and comments alike.
 *
 * **Folded and stored, not published** (WP-61, PROGRESS backlog 188): which account GitLab names as
 * the delivery's `user` for an approval, and whether `approved` arrives beside `approval`, are
 * inferences from the documentation until `docs/TODO.md`'s real-GitLab check is taken. So the
 * statistics read leaves every review window an approval touched **out** of the published reviewer
 * minutes, and says so in the metric's definition; the rows stay, so the figure can include them
 * the day the check answers without a replay.
 */
const onApproved = async (
  options: HumanTimeProjectorOptions,
  context: HandlerContext,
  event: Extract<DomainEvent, { type: 'mr.approved' }>,
  logger: Logger,
): Promise<void> => {
  await foldAuthoredActivity(
    options,
    context,
    {
      projectId: event.payload.project_id,
      taskId: event.payload.task_id ?? null,
      iid: event.payload.mr.iid,
      author: event.payload.approver,
      at: event.occurred_at,
    },
    logger,
  );
};

const onMerged = async (
  options: HumanTimeProjectorOptions,
  context: HandlerContext,
  event: Extract<DomainEvent, { type: 'mr.merged' }>,
  logger: Logger,
): Promise<void> => {
  const taskId = await taskOfMergeRequest(
    options,
    context,
    {
      projectId: event.payload.project_id,
      taskId: event.payload.task_id ?? null,
      iid: event.payload.mr.iid,
    },
    logger,
  );
  if (taskId === null) {
    return;
  }
  await foldReviewActivity(
    options,
    context,
    { taskId, projectId: event.payload.project_id, at: event.occurred_at, identity: null },
    logger,
  );
};

const onQuestionAnswered = async (
  options: HumanTimeProjectorOptions,
  context: HandlerContext,
  event: Extract<DomainEvent, { type: 'task.question.answered' }>,
  logger: Logger,
): Promise<void> => {
  const askedAt = await options.store.questionAskedAt(context.scope.tx, event.payload.question_id);
  if (askedAt === null) {
    logger.warn(
      { task_id: event.payload.task_id, question_id: event.payload.question_id },
      'human time: no questions row for this answer, so "asked → answered" has no beginning; nothing is recorded',
    );
    return;
  }
  await options.store.appendEntry(context.scope.tx, {
    taskId: event.payload.task_id,
    kind: 'question',
    // Only a **verified** identity ever reaches this event (technical/02:161, BD-022), so unlike a
    // review comment this user id is never a guess — and never null.
    userId: event.payload.answered_by_user_id,
    externalAuthor: null,
    startedAt: askedAt,
    endedAt: event.occurred_at,
    minutes: questionMinutes(askedAt, event.occurred_at),
  });
};

const onApprovalDecided = async (
  options: HumanTimeProjectorOptions,
  context: HandlerContext,
  event: Extract<DomainEvent, { type: 'task.approval.decided' }>,
  logger: Logger,
): Promise<void> => {
  const decidedBy = event.payload.decided_by_user_id ?? null;
  if (event.payload.decision === 'expired' || decidedBy === null) {
    logger.debug(
      { task_id: event.payload.task_id, decision: event.payload.decision },
      'human time: this approval was not decided by a person, so no minutes are recorded',
    );
    return;
  }
  await options.store.appendEntry(context.scope.tx, {
    taskId: event.payload.task_id,
    kind: 'approval',
    userId: decidedBy,
    externalAuthor: null,
    // A flat kind is a **point** with a conventional cost, and the equal instants are what say so:
    // product/19 §16's ten minutes are the reading a person did before deciding, which the platform
    // never observed and must not pretend to have timed.
    startedAt: event.occurred_at,
    endedAt: event.occurred_at,
    minutes: APPROVAL_FLAT_MINUTES,
  });
};

const onSteered = async (
  options: HumanTimeProjectorOptions,
  context: HandlerContext,
  event: Extract<DomainEvent, { type: 'run.steered' }>,
): Promise<void> => {
  await options.store.appendEntry(context.scope.tx, {
    taskId: event.payload.task_id,
    kind: 'steer',
    // The steer command is authenticated, so the author is a platform user by construction (WP-27).
    userId: event.payload.author_user_id,
    externalAuthor: null,
    startedAt: event.occurred_at,
    endedAt: event.occurred_at,
    minutes: STEER_FLAT_MINUTES,
  });
};

/** The catalogue types this projector folds — read by `EVENT_CONSUMPTION`'s test, not restated. */
export const humanTimeProjector = (options: HumanTimeProjectorOptions): EventHandler => ({
  name: HUMAN_TIME_HANDLER,
  priority: HUMAN_TIME_PRIORITY,
  eventTypes: [
    'mr.review.comment',
    'mr.approved',
    'mr.merged',
    'task.question.answered',
    'task.approval.decided',
    'run.steered',
  ],
  handle: async (context) => {
    const logger = options.logger ?? silentLogger;
    const event = context.event.event;
    switch (event.type) {
      case 'mr.review.comment':
        return onReviewComment(options, context, event, logger);
      case 'mr.approved':
        return onApproved(options, context, event, logger);
      case 'mr.merged':
        return onMerged(options, context, event, logger);
      case 'task.question.answered':
        return onQuestionAnswered(options, context, event, logger);
      case 'task.approval.decided':
        return onApprovalDecided(options, context, event, logger);
      case 'run.steered':
        return onSteered(options, context, event);
      default:
        return;
    }
  },
});

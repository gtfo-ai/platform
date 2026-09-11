/**
 * The PipelineSaga — technical/02 § "Sagas": "one per task; owns the task state machine, listens
 * to stage/gate/question/approval/MR/CI events, applies templates and policies, starts runs,
 * enforces iteration limits and budgets."
 *
 * It is a set of **event handlers**, not a long-lived object: the task row is the saga's state and
 * every handler loads it, decides one step and commits. That is what makes it survive a restart
 * without a workflow engine, and what makes each step idempotent — the dispatcher's
 * `handler_executions` row means a redelivery never re-runs a committed step, and the state checks
 * at the top of each handler mean an out-of-order one is ignored rather than misapplied.
 *
 * ## The shape every handler has
 *
 * ```
 * load the task  →  is this event still relevant?  →  interpret  →  apply  →  emit
 *                                                                         ↘  afterCommit: enqueue
 * ```
 *
 * The enqueue is the only thing that leaves the transaction, and it leaves it *after* the commit
 * (`HandlerContext.afterCommit`), because `Jobs.enqueue` does not join it. Every job the pipeline
 * enqueues re-validates when it fires, so a duplicate wake-up is harmless and a lost one is
 * recoverable by the next event.
 *
 * ## What "still relevant" means, and why it is not an error
 *
 * Standing rule 20: fail closed on a mutation, fail open on an inbound notification. Almost
 * everything here is a notification — a pipeline finished, a comment was written, a branch moved —
 * and the honest answer to one that does not match the task's current state is to ignore it. A CI
 * result for a commit the task has moved past is not a failure; treating it as one would park a
 * task for a human every time somebody re-ran an old pipeline.
 */
import { type DomainEvent, type Id, type Slug, ticketRefSchema } from '@platform/contracts';
import type { CommandContext, PipelineSignal } from '@platform/domain';
import {
  compilePipeline,
  createApproval,
  createTask,
  escalateTask,
  evaluateTaskAdmission,
  hasIdenticalFailureStreak,
  interpret,
  isRepeatOfPreviousRound,
  isRunnableTaskState,
  markQuestionEscalated,
  orderQueue,
  queueTask,
  requestApproval,
  resolveIterationLimits,
  resumeStage,
  returnLoopFor,
  stageOf,
  toApprovalRecord,
} from '@platform/domain';
import type { EventHandler, HandlerContext } from '../events/handler.js';
import type { Jobs } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import type { PipelineIntegrationsPort } from './integrations.js';
import { gitReads, integrationsForProject, noRunScopedSecrets } from './integrations.js';
import {
  enqueueOutbound,
  enqueueReviewCommentWindow,
  enqueueStage,
  type PipelineOutboundData,
} from './jobs.js';
import type { ProjectSettingsPort } from './settings.js';
import { templateForIssueType } from './settings.js';
import type { PipelineStore, StoredTask } from './store.js';
import { PIPELINE_ACTOR } from './store.js';
import { applyDecision } from './transitions.js';
import { reviewFindingSignature } from './verdicts.js';
import { statusMappingHandler, workpadHandler } from './workpad.js';

export interface PipelineSagaOptions {
  readonly store: PipelineStore;
  readonly settings: ProjectSettingsPort;
  readonly jobs: Jobs;
  readonly integrations: PipelineIntegrationsPort;
  readonly ids: { next(): Id };
  readonly clock: { now(): string };
  readonly logger?: Logger;
  /** BD-007's batch window for human merge-request comments. @default 2 minutes */
  readonly reviewCommentWindowMs?: number;
}

/** BD-007, technical/02 § ReviewCommentBatcher: "debounces `mr.review.comment` for 2 minutes". */
export const DEFAULT_REVIEW_COMMENT_WINDOW_MS = 2 * 60_000;

const contextFor = (
  options: PipelineSagaOptions,
  correlationId: Id,
  causeEventId: Id | null,
): CommandContext => ({
  ids: options.ids,
  actor: PIPELINE_ACTOR,
  clock: options.clock as CommandContext['clock'],
  correlationId,
  causeEventId,
});

/** Loads the task an event is about, or `null` when the platform has none for it. */
const loadTask = async (
  options: PipelineSagaOptions,
  context: HandlerContext,
  taskId: Id | null | undefined,
): Promise<StoredTask | null> =>
  taskId === null || taskId === undefined
    ? null
    : options.store.tasks.load(context.scope.tx, taskId);

/**
 * One step: interpret the signal against the task's own template and apply what comes back.
 *
 * Everything the step writes goes in the handler's transaction; the follow-up job is registered
 * for after the commit.
 */
const step = async (
  options: PipelineSagaOptions,
  context: HandlerContext,
  stored: StoredTask,
  signal: PipelineSignal,
): Promise<StoredTask> => {
  const pipeline = compilePipeline(stored.task.template, stored.template);
  const decision = interpret(pipeline, signal);
  const applied = await applyDecision({
    store: options.store,
    pipeline,
    tx: context.scope.tx,
    stored,
    decision,
    context: contextFor(options, stored.task.id, context.event.event.id),
    causedByEventId: context.event.event.id,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  await emitAndSchedule(options, context, applied.events, applied.work);
  return applied.stored;
};

const emitAndSchedule = async (
  options: PipelineSagaOptions,
  context: HandlerContext,
  events: readonly DomainEvent[],
  work: {
    readonly taskId: Id;
    readonly projectId: Id;
    readonly stage: Slug;
    readonly attempt: number;
  } | null,
): Promise<void> => {
  if (events.length > 0) {
    await context.emit(events);
  }
  if (work !== null) {
    context.afterCommit(async () => {
      await enqueueStage(options.jobs, work);
    });
  }
};

// ── S0 Intake ────────────────────────────────────────────────────────────────

/**
 * product/04 S0: create the task, classify it, check the WIP limits, start it or queue it.
 *
 * The protected-branch check is part of intake rather than of the first push because it is a
 * property of the *project* and the honest time to refuse is before any spend: a default branch
 * with no protection makes the push credential the agent will be given (which has no branch
 * scoping of its own, Q40) enough to write to `main`.
 *
 * ## The handler decides to intake; the job intakes (WP-15d)
 *
 * The check is two provider reads, and this handler runs at priority **10** — the core band, with
 * the dispatcher's transaction and its own open and `APP_DISPATCH_MAX_CONCURRENCY` shipping as 1.
 * Making the calls here held both connections and the platform's only dispatch slot for the length
 * of somebody else's HTTP round trip: measured, nothing else was dispatched *at all* while one git
 * read was in flight. So the handler does the one cheap thing that is worth doing inside the
 * transaction — the 1:1 dedup, so a repeated `ticket.matched` does not even cost a provider read —
 * and {@link runIntakeCheck} does the rest from a job.
 *
 * **Nothing is written here, deliberately.** The task is created by the job, in the same
 * transaction that admits or escalates it, so there is no window in which a half-intaken task row
 * exists for the scheduler to start behind the check's back.
 *
 * **The cost, stated as it actually is.** A crash between this commit and the enqueue
 * (`afterCommit` is at-most-once, TD-004) leaves the ticket without a task, and **nothing re-emits
 * it**: there is no poller in this build, and WP-15c's ingress is specified to deduplicate a
 * re-delivery on `inbox(provider, delivery_id)`, so the same webhook arriving twice performs
 * nothing twice. It is also **unlogged**, and cannot be logged here — the process that would write
 * the line is the one that died; `EventBus` logs a callback that *threw*, which is a different
 * failure. What would find it is a query the platform does not run yet — a matched ticket with no
 * task row — and that belongs to the ingress (WP-15c), not to this handler. Until then the residual
 * is: one ticket, silently not started, recoverable by re-matching it by hand.
 */
const intakeHandler = (options: PipelineSagaOptions): EventHandler => ({
  name: 'pipeline.intake',
  priority: 10,
  eventTypes: ['ticket.matched'],
  handle: async (context) => {
    const event = context.event.event;
    if (event.type !== 'ticket.matched') {
      return;
    }
    const { payload } = event;
    const existing = await options.store.tasks.findByTicket(context.scope.tx, {
      projectId: payload.project_id,
      provider: payload.ticket.provider,
      ticketKey: payload.ticket.key,
      mode: 'normal',
    });
    if (existing !== null) {
      // Intake is 1:1 with a ticket (technical/02); a second `ticket.matched` for the same key is
      // a poll that overlapped a webhook, not a second task.
      return;
    }
    const data: PipelineOutboundData = {
      duty: 'intake_check',
      project_id: payload.project_id,
      cause_event_id: event.id,
      ticket: payload.ticket,
      issue_type: payload.issue_type ?? null,
      priority: payload.priority ?? null,
    };
    context.afterCommit(async () => {
      await enqueueOutbound(options.jobs, data);
    });
  },
});

/** What {@link runIntakeCheck} needs beyond the saga's own collaborators. */
export interface IntakeCheckOptions extends PipelineSagaOptions {
  readonly unitOfWork: UnitOfWork;
}

/**
 * `pipeline.outbound` duty **intake_check**: ask the provider, then create the task.
 *
 * CLAUDE.md's shape, with the decision at the end: *read* (the dedup, in a transaction of its own),
 * *call* (the two git reads, in none), *write* (create and either escalate, queue or start, in one
 * transaction). Everything the handler used to do in one transaction still happens in one
 * transaction — it is simply not the dispatcher's.
 *
 * It **re-validates on fire** (TD-004), which is what makes the wake-up replaceable: a job that
 * arrives twice, or long after the event, finds the task already created and returns. That is the
 * durability `afterCommit` alone cannot give, and the reason this duty is a job rather than a
 * callback.
 */
export const runIntakeCheck = async (
  options: IntakeCheckOptions,
  data: PipelineOutboundData,
): Promise<void> => {
  const projectId = data.project_id as Id;
  // The job payload is a wire boundary like any other, and the ticket in it is provider text.
  const ticket = ticketRefSchema.parse(data.ticket);
  const causeEventId = data.cause_event_id as Id;

  const alreadyIntaken = await options.unitOfWork.transaction(async (scope) =>
    options.store.tasks.findByTicket(scope.tx, {
      projectId,
      provider: ticket.provider,
      ticketKey: ticket.key,
      mode: 'normal',
    }),
  );
  if (alreadyIntaken !== null) {
    return;
  }

  const settings = await options.settings.forProject(projectId);
  const unprotected = await unprotectedDefaultBranch(options, projectId);

  const work = await options.unitOfWork.transaction(async (scope) => {
    const existing = await options.store.tasks.findByTicket(scope.tx, {
      projectId,
      provider: ticket.provider,
      ticketKey: ticket.key,
      mode: 'normal',
    });
    if (existing !== null) {
      return null;
    }
    const template = templateForIssueType(settings, data.issue_type ?? null);
    const commandContext = contextFor(options, projectId, causeEventId);
    const created = createTask(
      {
        id: options.ids.next(),
        projectId,
        ticket,
        template,
        mode: 'normal',
        limits: resolveIterationLimits(settings.config.pipeline?.limits),
      },
      { ...commandContext, correlationId: null },
    );
    const stored: StoredTask = {
      task: created.aggregate,
      template: settings.templates[template] as StoredTask['template'],
      priorityRank: priorityRankOf((data.priority as string | null | undefined) ?? null),
      createdAt: options.clock.now(),
      branch: null,
      mr: null,
      workpad: null,
      costActualUsd: 0,
      estimateUsd: null,
    };
    await options.store.tasks.insert(scope.tx, stored);

    if (unprotected !== null) {
      const escalated = escalateTask(
        created.aggregate,
        {
          reason: `the default branch "${unprotected}" is not protected`,
          blockerBrief:
            `The platform will not start ${ticket.key}: the repository's default branch "${unprotected}" is not protected, ` +
            'and the push credential an agent is given cannot be scoped to a branch. Protect the branch in the repository settings, then hand the task back.',
        },
        contextFor(options, created.aggregate.id, causeEventId),
      );
      await options.store.tasks.save(scope.tx, { ...stored, task: escalated.aggregate });
      await scope.events.append([...created.events, ...escalated.events]);
      return null;
    }

    const counts = await options.store.tasks.counts(scope.tx, projectId);
    const admission = evaluateTaskAdmission(counts, settings.wip);
    if (!admission.admitted) {
      const queued = queueTask(
        created.aggregate,
        { reason: admission.reason === 'max_parallel_runs' ? 'wip' : 'wip' },
        contextFor(options, created.aggregate.id, causeEventId),
      );
      await options.store.tasks.save(scope.tx, { ...stored, task: queued.aggregate });
      await scope.events.append([...created.events, ...queued.events]);
      return null;
    }

    const pipeline = compilePipeline(stored.task.template, stored.template);
    const applied = await applyDecision({
      store: options.store,
      pipeline,
      tx: scope.tx,
      stored,
      decision: interpret(pipeline, { kind: 'start' }),
      context: contextFor(options, stored.task.id, causeEventId),
      causedByEventId: causeEventId,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
    await scope.events.append([...created.events, ...applied.events]);
    return applied.work;
  });

  if (work !== null) {
    await enqueueStage(options.jobs, work);
  }
};

/**
 * `null` when the branch is protected, when there is no git binding, or when nobody can tell.
 *
 * Called from the job and never from a handler: `integrationsForProject` refuses inside a
 * transaction, so a future caller that tries gets an error rather than a held connection.
 */
const unprotectedDefaultBranch = async (
  options: PipelineSagaOptions,
  projectId: Id,
): Promise<string | null> => {
  // Outside a run: the branch check happens before a workspace exists, so there is no minted
  // credential for the redactor to hold (Q55, `noRunScopedSecrets`).
  const reads = gitReads(
    await integrationsForProject(options.integrations, projectId, noRunScopedSecrets()),
  );
  // No task exists yet — the row is written by the transaction this read precedes — so the audit
  // row names the project and the action, and the ticket key is in the payload the caller passes.
  const callContext = { projectId, taskId: null };
  const head = await reads.defaultBranch(callContext);
  if (head === null) {
    return null;
  }
  const protectedBranch = await reads.branchProtected(head.branch, callContext);
  return protectedBranch === false ? head.branch : null;
};

/** Provider priority names, normalised for `orderQueue` (lower is more urgent, BD-010). */
export const priorityRankOf = (priority: string | null): number => {
  switch (priority?.trim().toLowerCase()) {
    case 'highest':
    case 'blocker':
    case 'critical':
    case 'p0':
      return 0;
    case 'high':
    case 'major':
    case 'p1':
      return 1;
    case 'low':
    case 'minor':
    case 'p3':
      return 3;
    case 'lowest':
    case 'trivial':
    case 'p4':
      return 4;
    default:
      return 2;
  }
};

// ── Stage completion ─────────────────────────────────────────────────────────

const stageCompletedHandler = (options: PipelineSagaOptions): EventHandler => ({
  name: 'pipeline.stage.completed',
  priority: 10,
  eventTypes: ['task.stage.completed'],
  handle: async (context) => {
    const event = context.event.event;
    if (event.type !== 'task.stage.completed') {
      return;
    }
    const stored = await loadTask(options, context, event.payload.task_id);
    if (stored === null || stored.task.currentStage !== event.payload.stage) {
      return;
    }
    // Not `state === 'active'`: `retrospective` is entered in the `retro` state and completes from
    // it. What disqualifies a completion is the task having stopped — the executor may have parked
    // it on a blocking question in the same transaction that completed the stage, and then the
    // interpreter would say `wait` anyway.
    if (!isRunnableTaskState(stored.task.state)) {
      return;
    }

    const withMr = await recordMergeRequest(options, context, stored, event.payload.stage);
    const signal: PipelineSignal = {
      kind: 'stage_completed',
      stage: event.payload.stage,
      verdict: event.payload.verdict ?? null,
    };

    const converged = await convergenceEscalation(options, context, withMr, event.payload.stage);
    if (converged) {
      return;
    }

    const gate = await planApprovalGate(options, context, withMr, event.payload.stage, signal);
    if (gate) {
      return;
    }

    await step(options, context, withMr, signal);
  },
});

/**
 * product/04 S5: "if a re-review reports the same findings as the previous round, stop immediately
 * and escalate instead of burning the remaining iterations".
 *
 * The signature comes from the review's structured findings, never from its prose, so a model that
 * rewords the same finding twice is still recognised as the same round.
 */
const convergenceEscalation = async (
  options: PipelineSagaOptions,
  context: HandlerContext,
  stored: StoredTask,
  stage: Slug,
): Promise<boolean> => {
  if (stage !== 'code_review') {
    return false;
  }
  const latest = await options.store.artifacts.latest(
    context.scope.tx,
    stored.task.id,
    'ReviewVerdict',
  );
  if (latest === null) {
    return false;
  }
  const signature = reviewFindingSignature(latest.data);
  if (signature.length === 0) {
    return false;
  }
  const previous = await options.store.tasks.recentStageSignatures(
    context.scope.tx,
    stored.task.id,
    'code_review',
    5,
  );
  if (!isRepeatOfPreviousRound(previous, signature)) {
    await options.store.tasks.recordStageSignature(context.scope.tx, {
      taskId: stored.task.id,
      stage,
      attempt: stored.task.stageAttempts[stage] ?? 1,
      signature,
    });
    return false;
  }
  const escalated = escalateTask(
    stored.task,
    {
      reason: 'the review reported the same findings as the previous round',
      blockerBrief:
        `The reviewer of ${stored.task.ticket.key} reported exactly the findings it reported last round, so another Implementation pass would change nothing. ` +
        'Read the review verdict, decide whether the findings are right, and either fix them yourself or hand the task back with a different instruction.',
    },
    contextFor(options, stored.task.id, context.event.event.id),
  );
  await options.store.tasks.save(context.scope.tx, { ...stored, task: escalated.aggregate });
  await context.emit(escalated.events);
  return true;
};

/**
 * product/04 S2: "require human plan approval above a size threshold (default: require for L/XL)".
 *
 * Keyed on the stage *attempt*: a second plan needs a second approval, and an approval recorded
 * for attempt 1 must not wave attempt 2 through.
 */
const planApprovalGate = async (
  options: PipelineSagaOptions,
  context: HandlerContext,
  stored: StoredTask,
  stage: Slug,
  signal: PipelineSignal,
): Promise<boolean> => {
  if (signal.kind !== 'stage_completed' || signal.verdict !== 'approve') {
    return false;
  }
  const settings = await options.settings.forProject(stored.task.projectId);
  const pipeline = compilePipeline(stored.task.template, stored.template);
  const completed = stageOf(pipeline, stage);
  if (completed?.produces !== 'ImplementationPlan') {
    return false;
  }
  const attempt = stored.task.stageAttempts[stage] ?? 1;
  const already = await options.store.approvals.forStageAttempt(context.scope.tx, {
    taskId: stored.task.id,
    kind: 'plan',
    stage,
    attempt,
  });
  if (already !== null) {
    return false;
  }
  const override =
    settings.config.pipeline?.template_overrides?.[stored.task.template]?.stages?.[stage];
  const mode = override?.plan_approval ?? 'above_size';
  if (mode === 'never') {
    return false;
  }
  const plan = await options.store.artifacts.latest(
    context.scope.tx,
    stored.task.id,
    'ImplementationPlan',
  );
  const size =
    typeof plan?.data === 'object' && plan.data !== null && !Array.isArray(plan.data)
      ? (plan.data as Record<string, unknown>).estimated_size
      : null;
  const threshold = override?.size_threshold ?? 'L';
  const ranked = ['S', 'M', 'L', 'XL'];
  const needsApproval =
    mode === 'always' ||
    (typeof size === 'string' && ranked.indexOf(size) >= ranked.indexOf(threshold));
  if (!needsApproval) {
    return false;
  }

  const commandContext = contextFor(options, stored.task.id, context.event.event.id);
  const approval = createApproval(
    {
      id: options.ids.next(),
      taskId: stored.task.id,
      projectId: stored.task.projectId,
      kind: 'plan',
    },
    commandContext,
  );
  await options.store.approvals.insert(context.scope.tx, { approval, stage, attempt });
  const requested = requestApproval(
    stored.task,
    { approval: toApprovalRecord(approval) },
    commandContext,
  );
  await options.store.tasks.save(context.scope.tx, { ...stored, task: requested.aggregate });
  await context.emit(requested.events);
  return true;
};

/**
 * The developer stage reports the merge request it opened in its `ImplementationNotes`
 * (technical/12: `mr: {url, iid, head_sha}`). That is how the platform learns which merge request
 * a task owns — the git provider's own `mr.opened` webhook cannot say which *task* it belongs to.
 */
const recordMergeRequest = async (
  options: PipelineSagaOptions,
  context: HandlerContext,
  stored: StoredTask,
  stage: Slug,
): Promise<StoredTask> => {
  const pipeline = compilePipeline(stored.task.template, stored.template);
  if (stageOf(pipeline, stage)?.produces !== 'ImplementationNotes') {
    return stored;
  }
  const notes = await options.store.artifacts.latest(
    context.scope.tx,
    stored.task.id,
    'ImplementationNotes',
  );
  const data = notes?.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return stored;
  }
  const mr = (data as Record<string, unknown>).mr;
  if (typeof mr !== 'object' || mr === null || Array.isArray(mr)) {
    return stored;
  }
  const record = mr as Record<string, unknown>;
  const iid = record.iid;
  const url = record.url;
  if (typeof iid !== 'number' || typeof url !== 'string') {
    return stored;
  }
  const next: StoredTask = {
    ...stored,
    branch: typeof record.branch === 'string' ? record.branch : stored.branch,
    mr: {
      // Which account and which repository path this merge request is on is **not** recorded here
      // (WP-15d): learning it means resolving the project's bindings, which is a pool borrow and a
      // credential decryption, and this runs inside the handler's transaction. `gitReads` fills
      // both in from the binding that is live when the ref is used, which is also the more correct
      // answer — a project that was re-bound would otherwise be addressed at its old account.
      provider: null,
      project_path: null,
      iid,
      url,
      branch: typeof record.branch === 'string' ? record.branch : null,
      head_sha: typeof record.head_sha === 'string' ? record.head_sha : null,
    },
  };
  await options.store.tasks.save(context.scope.tx, next);
  return next;
};

// ── Questions and approvals ──────────────────────────────────────────────────

const questionHandler = (options: PipelineSagaOptions): EventHandler => ({
  name: 'pipeline.question',
  priority: 10,
  eventTypes: ['task.question.answered', 'task.question.expired'],
  handle: async (context) => {
    const event = context.event.event;
    if (event.type !== 'task.question.answered' && event.type !== 'task.question.expired') {
      return;
    }
    const stored = await loadTask(options, context, event.payload.task_id);
    if (stored === null || stored.task.state !== 'waiting_answers') {
      return;
    }
    const question = await options.store.questions.load(
      context.scope.tx,
      event.payload.question_id,
    );
    if (question === null) {
      return;
    }
    const commandContext = contextFor(options, stored.task.id, event.id);

    if (event.type === 'task.question.expired') {
      // technical/02: `task.question.expired` → Escalation. The question's own record moves to
      // `escalated` so a second timer cannot re-escalate it.
      await options.store.questions.save(context.scope.tx, markQuestionEscalated(question));
      const escalated = escalateTask(
        stored.task,
        {
          reason: `the question asked at "${question.stage}" was not answered in time`,
          blockerBrief:
            `${stored.task.ticket.key} is waiting for an answer to: ${question.text}\n\n` +
            'Answer it on the ticket, in Slack or in the UI and the task will carry on from where it stopped.',
        },
        commandContext,
      );
      await options.store.tasks.save(context.scope.tx, { ...stored, task: escalated.aggregate });
      await context.emit(escalated.events);
      return;
    }

    const stillOpen = await options.store.questions.open(context.scope.tx, stored.task.id);
    if (stillOpen.some((entry) => entry.blocking)) {
      // "First answer wins" is per question; the task waits until every blocking one is answered.
      return;
    }

    const resumed = resumeStage(
      stored.task,
      {
        stage: question.stage,
        loop: returnLoopFor(question.stage) ?? 'refinement_questions',
        reason: 'the blocking questions were answered',
        escalationBrief:
          `${stored.task.ticket.key} has been round the question loop at "${question.stage}" as many times as its limit allows. ` +
          'Read the answers so far and either give the stage what it needs in one go, or hand the task back at a different stage.',
      },
      commandContext,
    );
    await options.store.tasks.save(context.scope.tx, { ...stored, task: resumed.aggregate });
    await emitAndSchedule(
      options,
      context,
      resumed.events,
      resumed.aggregate.state === 'active'
        ? {
            taskId: stored.task.id,
            projectId: stored.task.projectId,
            stage: question.stage,
            attempt: resumed.aggregate.stageAttempts[question.stage] ?? 1,
          }
        : null,
    );
  },
});

const approvalHandler = (options: PipelineSagaOptions): EventHandler => ({
  name: 'pipeline.approval',
  priority: 10,
  eventTypes: ['task.approval.decided'],
  handle: async (context) => {
    const event = context.event.event;
    if (event.type !== 'task.approval.decided') {
      return;
    }
    const stored = await loadTask(options, context, event.payload.task_id);
    if (stored === null || stored.task.state !== 'waiting_approval') {
      return;
    }
    const record = await options.store.approvals.load(context.scope.tx, event.payload.approval_id);
    const stage = record?.stage ?? stored.task.currentStage;
    if (stage === null) {
      return;
    }
    const commandContext = contextFor(options, stored.task.id, event.id);

    if (event.payload.decision === 'approved') {
      // Re-ask the interpreter the question the approval interrupted. The approval row now exists
      // and is decided, so `planApprovalGate` lets it through this time.
      await step(options, context, stored, {
        kind: 'stage_completed',
        stage,
        verdict: 'approve',
      });
      return;
    }

    if (event.payload.decision === 'rejected') {
      // product/04 S2: a rejected plan goes back to Architecture with the human's reasoning.
      const resumed = resumeStage(
        stored.task,
        {
          stage,
          loop: returnLoopFor(stage) ?? 'architecture_revisions',
          reason: event.payload.reason ?? 'the plan was rejected',
          escalationBrief:
            `The plan for ${stored.task.ticket.key} has been rejected as many times as its limit allows. ` +
            'Write what the plan should say instead, and hand the task back at Architecture.',
        },
        commandContext,
      );
      await options.store.tasks.save(context.scope.tx, { ...stored, task: resumed.aggregate });
      await emitAndSchedule(
        options,
        context,
        resumed.events,
        resumed.aggregate.state === 'active'
          ? {
              taskId: stored.task.id,
              projectId: stored.task.projectId,
              stage,
              attempt: resumed.aggregate.stageAttempts[stage] ?? 1,
            }
          : null,
      );
      return;
    }

    const escalated = escalateTask(
      stored.task,
      {
        reason: 'the approval expired',
        blockerBrief:
          `Nobody decided the ${record?.approval.kind ?? 'plan'} approval for ${stored.task.ticket.key} in time. ` +
          'Approve or reject it in the UI, or hand the task back at the stage it should resume from.',
      },
      commandContext,
    );
    await options.store.tasks.save(context.scope.tx, { ...stored, task: escalated.aggregate });
    await context.emit(escalated.events);
  },
});

// ── Gates fed by provider events ─────────────────────────────────────────────

const ciHandler = (options: PipelineSagaOptions): EventHandler => ({
  name: 'pipeline.ci',
  priority: 10,
  eventTypes: ['ci.pipeline.finished'],
  handle: async (context) => {
    const event = context.event.event;
    if (event.type !== 'ci.pipeline.finished') {
      return;
    }
    const iid = event.payload.mr?.iid;
    const stored =
      iid === undefined || iid === null
        ? null
        : await options.store.tasks.findByMergeRequest(context.scope.tx, {
            projectId: event.payload.project_id,
            iid,
          });
    if (stored === null || stored.task.state !== 'active') {
      return;
    }
    const stage = stored.task.currentStage;
    if (stage === null) {
      return;
    }
    const pipeline = compilePipeline(stored.task.template, stored.template);
    const waiting = stageOf(pipeline, stage);
    if (
      waiting?.kind !== 'gate' ||
      !waiting.on.some((entry) => entry.on === 'ci.pipeline.finished')
    ) {
      // A pipeline result for a task that is not at the CI gate is somebody else's news.
      return;
    }
    const passed = event.payload.status === 'success';
    const failing = event.payload.failed_jobs.map((job) => job.name).sort();
    const detail = passed
      ? `pipeline for ${event.payload.head_sha} succeeded`
      : `pipeline for ${event.payload.head_sha} ${event.payload.status}${failing.length === 0 ? '' : `: ${failing.join(', ')}`}`;

    if (!passed) {
      // Stable across attempts on purpose: the head sha changes every round, so a signature that
      // carried it would never repeat and convergence detection would never fire.
      const signature = `ci:${event.payload.status}:${failing.join(',')}`;
      const history = [
        ...(await options.store.tasks.recentStageSignatures(
          context.scope.tx,
          stored.task.id,
          stage,
          2,
        )),
        signature,
      ];
      if (hasIdenticalFailureStreak(history, 3)) {
        // product/04 S4: "Three identical failures in a row stop the loop early."
        const escalated = escalateTask(
          stored.task,
          {
            reason: 'the same CI failure three times in a row',
            blockerBrief:
              `The pipeline for ${stored.task.ticket.key} has failed three times with exactly the same jobs (${failing.join(', ') || 'none reported'}). ` +
              'Another Implementation pass is unlikely to change it. Look at the job log, fix what is wrong, and hand the task back.',
          },
          contextFor(options, stored.task.id, event.id),
        );
        await options.store.tasks.save(context.scope.tx, { ...stored, task: escalated.aggregate });
        await context.emit(escalated.events);
        return;
      }
      await options.store.tasks.recordStageSignature(context.scope.tx, {
        taskId: stored.task.id,
        stage,
        attempt: stored.task.stageAttempts[stage] ?? 1,
        signature,
      });
    }

    await step(options, context, stored, { kind: 'gate_settled', stage, passed, detail });
  },
});

const mergeRequestHandler = (options: PipelineSagaOptions): EventHandler => ({
  name: 'pipeline.merge.request',
  priority: 10,
  eventTypes: ['mr.merged', 'mr.closed'],
  handle: async (context) => {
    const event = context.event.event;
    if (event.type !== 'mr.merged' && event.type !== 'mr.closed') {
      return;
    }
    const stored = await options.store.tasks.findByMergeRequest(context.scope.tx, {
      projectId: event.payload.project_id,
      iid: event.payload.mr.iid,
    });
    if (stored === null) {
      return;
    }
    if (event.type === 'mr.closed') {
      if (stored.task.state === 'done' || stored.task.state === 'cancelled') {
        return;
      }
      // product/04 S7: "MR close/decline → `Needs human` with reason".
      const escalated = escalateTask(
        stored.task,
        {
          reason: 'the merge request was closed',
          blockerBrief:
            `The merge request for ${stored.task.ticket.key} was closed without being merged. ` +
            'Say why on the ticket: if the approach was wrong, hand the task back at Architecture; if the work is not wanted, cancel the task.',
        },
        contextFor(options, stored.task.id, event.id),
      );
      await options.store.tasks.save(context.scope.tx, { ...stored, task: escalated.aggregate });
      await context.emit(escalated.events);
      return;
    }
    const stage = stored.task.currentStage;
    if (stage === null || stored.task.state !== 'ready_for_merge') {
      return;
    }
    await step(options, context, stored, {
      kind: 'event',
      stage,
      event: 'mr.merged',
      detail: 'the merge request was merged',
    });
  },
});

/**
 * BD-007's batching, the enqueue half.
 *
 * The window is a **delayed wake-up with re-validation**, not a coalesced job: both of the Jobs
 * port's coalescing modes are leading-edge, so the first comment would bounce the task back to
 * Implementation while the human was still typing. The queue is `stately` per merge request, so a
 * burst collapses onto the first comment's timer; `jobs.ts` re-reads every unresolved thread when
 * it fires.
 */
const reviewCommentHandler = (options: PipelineSagaOptions): EventHandler => ({
  name: 'pipeline.review.comment',
  priority: 10,
  eventTypes: ['mr.review.comment'],
  handle: async (context) => {
    const event = context.event.event;
    if (event.type !== 'mr.review.comment') {
      return;
    }
    if (event.payload.resolved) {
      return;
    }
    const stored = await options.store.tasks.findByMergeRequest(context.scope.tx, {
      projectId: event.payload.project_id,
      iid: event.payload.mr.iid,
    });
    if (stored === null || stored.task.state !== 'ready_for_merge') {
      return;
    }
    const windowMs = options.reviewCommentWindowMs ?? DEFAULT_REVIEW_COMMENT_WINDOW_MS;
    const taskId = stored.task.id;
    const projectId = stored.task.projectId;
    const iid = event.payload.mr.iid;
    context.afterCommit(async () => {
      await enqueueReviewCommentWindow(options.jobs, {
        taskId,
        projectId,
        iid,
        windowMs,
        now: new Date(options.clock.now()),
      });
    });
  },
});

const defaultBranchHandler = (options: PipelineSagaOptions): EventHandler => ({
  name: 'pipeline.default.branch',
  priority: 10,
  eventTypes: ['default_branch.moved'],
  handle: async (context) => {
    const event = context.event.event;
    if (event.type !== 'default_branch.moved') {
      return;
    }
    const waiting = await options.store.tasks.listAtStage(
      context.scope.tx,
      event.payload.project_id,
      'ready_for_merge',
    );
    for (const stored of waiting) {
      if (stored.task.state !== 'ready_for_merge') {
        continue;
      }
      await step(options, context, stored, {
        kind: 'event',
        stage: 'ready_for_merge',
        event: 'default_branch.moved',
        detail: `${event.payload.branch} moved to ${event.payload.new_head}`,
      });
    }
  },
});

// ── The WIP scheduler ────────────────────────────────────────────────────────

/**
 * BD-010: "Tasks beyond limits wait in `Queued` ordered by ticket priority then age."
 *
 * A slot is freed by any event that takes a task out of the active set, so the scheduler listens
 * to all of them rather than to `task.completed` alone — a task parked in `Needs human` frees a
 * slot exactly as a finished one does.
 */
const schedulerHandler = (options: PipelineSagaOptions): EventHandler => ({
  name: 'pipeline.scheduler',
  priority: 30,
  eventTypes: ['task.completed', 'task.cancelled', 'task.escalated', 'task.paused'],
  handle: async (context) => {
    const event = context.event.event;
    if (
      event.type !== 'task.completed' &&
      event.type !== 'task.cancelled' &&
      event.type !== 'task.escalated' &&
      event.type !== 'task.paused'
    ) {
      return;
    }
    const projectId = event.payload.project_id;
    const settings = await options.settings.forProject(projectId);
    const counts = await options.store.tasks.counts(context.scope.tx, projectId);
    if (!evaluateTaskAdmission(counts, settings.wip).admitted) {
      return;
    }
    const queued = orderQueue(await options.store.tasks.queued(context.scope.tx, projectId));
    const next = queued[0];
    if (next === undefined) {
      return;
    }
    const stored = await options.store.tasks.load(context.scope.tx, next.id);
    if (stored === null || stored.task.state !== 'queued') {
      return;
    }
    await step(options, context, stored, { kind: 'start' });
  },
});

export const pipelineHandlers = (options: PipelineSagaOptions): readonly EventHandler[] => [
  // Core band (0–99): what happened. Integrations band (100–199): telling the outside world.
  statusMappingHandler(options),
  workpadHandler(options),
  intakeHandler(options),
  stageCompletedHandler(options),
  questionHandler(options),
  approvalHandler(options),
  ciHandler(options),
  mergeRequestHandler(options),
  reviewCommentHandler(options),
  defaultBranchHandler(options),
  schedulerHandler(options),
];

export const pipelineSagaLogger = (options: PipelineSagaOptions): Logger =>
  options.logger ?? silentLogger;

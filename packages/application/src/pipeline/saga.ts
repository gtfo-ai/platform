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
import {
  type DomainEvent,
  type Id,
  type IsoDateTime,
  type RiskClass,
  type Size,
  type Slug,
  ticketRefSchema,
} from '@platform/contracts';
import type {
  AutonomyPreset,
  CommandContext,
  CompiledPipeline,
  PipelineDecision,
  PipelineSignal,
} from '@platform/domain';
import {
  amendEscalation,
  compilePipeline,
  createApproval,
  createTask,
  escalateTask,
  evaluateTaskAdmission,
  interpret,
  isRepeatOfPreviousRound,
  isRunnableTaskState,
  markQuestionEscalated,
  orderQueue,
  queueTask,
  READY_FOR_MERGE_STAGE,
  requestApproval,
  requiresBudgetApproval,
  requiresPlanApproval,
  resumeStage,
  returnLoopFor,
  riskClassesRequiringPlanApproval,
  stageOf,
  toApprovalRecord,
} from '@platform/domain';
import type { RepositoryFileSource } from '../config/repository-config.js';
import type { EventHandler, HandlerContext } from '../events/handler.js';
import type { Jobs } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import type { WorkingCalendar } from '../scheduling/working-calendar.js';
import { escalateForConfigRefusalInHandler } from './config-refusal.js';
import { questionDeadlineRule } from './deadline-rules.js';
import type { PipelineIntegrations, PipelineIntegrationsPort } from './integrations.js';
import { gitReads, integrationsForProject, noRunScopedSecrets } from './integrations.js';
import {
  enqueueOutbound,
  enqueueReviewCommentWindow,
  enqueueStage,
  type PipelineOutboundData,
} from './jobs.js';
import { refrozen, refrozenColumns } from './refreeze.js';
import { isPlatformNote } from './review-threads.js';
import type { ProjectSettingsPort } from './settings.js';
import {
  autonomyPresetFor,
  epicSplitRouting,
  iterationLimitsFor,
  picksUpNewTickets,
  pipelineDialFor,
  spikeRefusal,
  templateForIssueType,
} from './settings.js';
import type { PipelineStore, StoredTask } from './store.js';
import { DefaultBranchChangedError, INITIAL_TASK_VERSION, PIPELINE_ACTOR } from './store.js';
import { type RequesterOptions, readTicketForTask, resolveRequester } from './ticket-snapshot.js';
import { applyDecision, closeParkedStageRow, ESCALATED_OUTCOME } from './transitions.js';
import { reviewFindingSignature, verdictReturnReason } from './verdicts.js';
import { statusMappingHandler, workpadHandler } from './workpad.js';

export interface PipelineSagaOptions {
  readonly store: PipelineStore;
  readonly settings: ProjectSettingsPort;
  readonly jobs: Jobs;
  readonly integrations: PipelineIntegrationsPort;
  readonly ids: { next(): Id };
  readonly clock: { now(): string };
  /**
   * The organisation's working calendar (WP-56), composed from `APP_WORKING_DAYS`,
   * `APP_WORKING_HOURS`, `APP_HOLIDAYS` and `TZ` — what every deadline the pipeline holds a human
   * to is resolved on: a question's, an approval's and a take-over's. Required, because a pipeline
   * composed without one is the pipeline PROGRESS backlog 74 measured, where nothing expires.
   */
  readonly calendar: WorkingCalendar;
  readonly logger?: Logger;
  /** BD-007's batch window for human merge-request comments. @default 2 minutes */
  readonly reviewCommentWindowMs?: number;
  /**
   * The default branch's files, read from the platform's mirror (TD-026) — what the CI gate asks
   * before it reads a head with no pipeline as *"the project has no CI"* (WP-138 ruling (f)).
   *
   * Optional, and absent is **not** a permissive path: a gate that cannot ask whether the default
   * branch has a CI file answers `pending`, never a pass (standing rule 31's direction, rule 18's
   * shape). `apps/server` composes the mirror's reader; a unit test that means "no CI" passes one
   * that answers the file absent.
   */
  readonly repositoryFiles?: RepositoryFileSource;
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
  const pipeline = compilePipeline(stored.task.template, stored.template, stored.pipelineDial);
  const decision = await withVerdictFindings(
    options,
    context,
    stored,
    pipeline,
    signal,
    interpret(pipeline, signal),
  );
  const applied = await applyDecision({
    store: options.store,
    pipeline,
    tx: context.scope.tx,
    stored,
    decision,
    signal,
    context: contextFor(options, stored.task.id, context.event.event.id),
    causedByEventId: context.event.event.id,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  await emitAndSchedule(options, context, applied.events, applied.work);
  return applied.stored;
};

/**
 * An agent stage's return carries **the verdict's own findings**, not the interpreter's literal
 * `requested changes` (WP-55, the agent half of PROGRESS backlog 159).
 *
 * The interpreter is pure and cannot read the artifact; this is the first place the decision and the
 * artifact are both at hand, and it is before `applyDecision` writes the reason onto the returning
 * attempt's row — which is where the next run's `return_feedback` block is read from. The artifact
 * is the returning stage's **latest** of its declared type: the stage executor stored it in the
 * transaction that completed the stage, which is what appended the event this step reacts to.
 * `verdictReturnReason` states the cap and the redaction; a verdict with nothing to say keeps the
 * interpreter's words. The human-comment half of 159 is WP-46's, in the review window: its reason is
 * the threads' own text, not their count (`review-threads.ts`).
 */
const withVerdictFindings = async (
  options: PipelineSagaOptions,
  context: HandlerContext,
  stored: StoredTask,
  pipeline: CompiledPipeline,
  signal: PipelineSignal,
  decision: PipelineDecision,
): Promise<PipelineDecision> => {
  if (decision.kind !== 'return' || signal.kind !== 'stage_completed') {
    return decision;
  }
  const produces = stageOf(pipeline, signal.stage)?.produces ?? null;
  if (produces === null) {
    return decision;
  }
  const artifact = await options.store.artifacts.latest(context.scope.tx, stored.task.id, produces);
  const reason = artifact === null ? null : verdictReturnReason(produces, artifact.data);
  return reason === null ? decision : { ...decision, reason };
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
 * (`afterCommit` is at-most-once, TD-004) leaves the ticket without a task, and neither inbound
 * door re-emits it: WP-15c's ingress deduplicates a re-delivery on `inbox(provider, delivery_id)`,
 * and the ticket poller (WP-87) deduplicates a re-poll of an unchanged ticket on the same table —
 * it re-matches the ticket only once the ticket changes. It is also unlogged here, because the
 * process that would write the line is the one that died. What finds it is
 * `pipeline.intake.reconcile` (`intake-reconcile.ts`, PROGRESS backlog 20): a matched ticket with no
 * task row, re-emitted once.
 *
 * **Both doors meet here.** A binding with a webhook and polling can announce one ticket twice — the
 * two doors never share an `inbox` key, because a search result carries no delivery identifier —
 * and this `findByTicket` is what makes the second announcement start nothing
 * (`pipeline/ticket-poll.ts`).
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
      // A moved issue is the same ticket under a new key (WP-134, backlog 418).
      ticketId: payload.ticket.id ?? null,
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
export interface IntakeCheckOptions extends PipelineSagaOptions, RequesterOptions {
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
      ticketId: ticket.id ?? null,
      mode: 'normal',
    }),
  );
  if (alreadyIntaken !== null) {
    return;
  }

  const settings = await options.settings.forProject(projectId);

  /**
   * **Observe means Observe** — product/18's level 0 is *"No agent MRs"*, and its preset says so
   * as `picksUpNewTickets: false` (WP-34, PROGRESS backlog 72 (c)).
   *
   * Asked **here**, before the bindings are resolved and before the ticket is read, so an Observe
   * project makes no provider call at all for a ticket it is not going to take: the cheapest
   * refusal is the one that happens before the work.
   *
   * It is the *materialised* preset (BD-027:14) with the project's own overrides on top, which is
   * what `autonomyPresetFor` answers. A project whose dial was **never materialised** keeps the
   * pre-WP-34 behaviour and picks the ticket up — `null` is *"this project's dial has never been
   * applied"* and not *"observe"*, and substituting a preset for it is the read-time re-derivation
   * BD-027:14 forbids. Migration 0021 backfilled every row that existed and all three writers
   * supply one, so that branch is reachable only from a harness.
   *
   * What it refuses is **creating a task**, which is the whole of what "picks up new tickets"
   * means: the ticket is left exactly as it was, nothing is posted on it, and a maintainer who
   * wants it delivered turns the dial. Shadow mode is the other half of the same decision and is
   * the only thing that runs at this position (`shadow/batch.ts`).
   */
  if (!picksUpNewTickets(settings)) {
    (options.logger ?? silentLogger).info(
      { project_id: projectId, ticket_key: ticket.key },
      'this project’s autonomy dial does not pick up new tickets, so no task was created',
    );
    return;
  }

  // One resolution for both reads of this job. Outside a run, so the call's scope holds no minted
  // credential (Q55, `noRunScopedSecrets`); outside every transaction, which
  // `integrationsForProject` refuses to be otherwise.
  const integrations = await integrationsForProject(
    options.integrations,
    projectId,
    noRunScopedSecrets(),
  );
  const unprotected = await unprotectedDefaultBranch(
    integrations,
    projectId,
    settings.defaultBranch,
  );
  /**
   * **The ticket's own words, read once, before the task exists** (WP-15f, Q61).
   *
   * Here rather than in a duty of its own, because this is the only point that is *ordered* with
   * respect to the first agent stage: the transaction below both creates the task and enqueues the
   * stage, so a snapshot fetched after it would race the prompt it exists to fill.
   * `ticket-snapshot.ts` has the full ordering argument.
   *
   * It answers `null` rather than throwing for every reason a ticket's text can be unavailable, so
   * a task still starts when Jira is down — the ticket is *why* the task exists, and refusing to
   * create it would turn a provider outage into lost work (standing rule 20). The next agent stage
   * reads it (`ensureTicketSnapshot`), so the failure is recoverable rather than permanent.
   */
  // The read's **start** is what the snapshot is as fresh as (WP-60): an edit announced while the
  // provider answers is then dated after the snapshot, and the next agent stage re-reads it
  // (`isTicketSnapshotStale`), where the read's end would have hidden it for the rest of the task.
  const ticketSnapshotReadAt = options.clock.now() as IsoDateTime;
  const ticketRead = await readTicketForTask(
    options,
    { projectId, taskId: null, ticket },
    integrations,
  );
  const ticketSnapshot = ticketRead?.snapshot ?? null;
  /**
   * **Who asked for this task** — the ticket's reporter, when an operator has mapped their account
   * (WP-79, PROGRESS backlog 243). Resolved here, outside the transaction, for the reason the read
   * above is: the directory is a pool query of its own. Only through `user_identities`; an
   * unmapped reporter, a machine account or a failed read leaves `null`, which is the routing's
   * named *"there is no fallback"* (`resolveRequester` has the rules).
   */
  const requestedByUserId = await resolveRequester(
    options,
    ticket.provider,
    ticketRead?.reporter ?? null,
  );

  /**
   * **Can this project's tracker be written to at all?** (WP-40, criterion 6.)
   *
   * Asked here because it is the last place with the binding in hand and outside a transaction, and
   * asked *before* the template is chosen because the answer decides the template: the epic-split
   * variant ends in `createTicket` calls, so routing an epic to it on a read-only binding would
   * queue a breakdown whose acceptance could only throw — a human's decision spent on nothing. The
   * refusal is logged by name rather than left for the duty to discover (standing rule 18).
   *
   * Every other template is unaffected: `epicSplitRouting` is the only reader, and it answers
   * `not_claimed` for a project that has not turned the variant on.
   */
  const routing = {
    canCreateTickets: integrations.taskManagement?.port.capabilities().createTicket === true,
  };
  const splitRouting = epicSplitRouting(settings, data.issue_type ?? null, routing);
  if (splitRouting.kind === 'refused') {
    (options.logger ?? silentLogger).info(
      { project_id: projectId, ticket_key: ticket.key, reason: splitRouting.reason },
      'this ticket was not routed to the epic-split variant',
    );
  }
  // The plain spike's own opt-in (WP-40 round 2). Said out loud for standing rule 18's reason: a
  // ticket typed `Spike` on a project that has not turned the template on runs the default
  // pipeline, which is the shipped behaviour and looks like nothing happening.
  const spikeOff = spikeRefusal(settings, data.issue_type ?? null);
  if (spikeOff !== null) {
    (options.logger ?? silentLogger).info(
      { project_id: projectId, ticket_key: ticket.key, reason: spikeOff },
      'this ticket was not routed to the spike template',
    );
  }

  const creation = options.unitOfWork.transaction(async (scope) => {
    const existing = await options.store.tasks.findByTicket(scope.tx, {
      projectId,
      provider: ticket.provider,
      ticketKey: ticket.key,
      ticketId: ticket.id ?? null,
      mode: 'normal',
    });
    if (existing !== null) {
      return null;
    }
    const template = templateForIssueType(settings, data.issue_type ?? null, routing);
    const commandContext = contextFor(options, projectId, causeEventId);
    const created = createTask(
      {
        id: options.ids.next(),
        projectId,
        ticket,
        template,
        mode: 'normal',
        limits: iterationLimitsFor(settings),
      },
      { ...commandContext, correlationId: null },
    );
    const stored: StoredTask = {
      task: created.aggregate,
      template: settings.templates[template] as StoredTask['template'],
      // WP-62: the dial's two pipeline policies, frozen off the project's materialised preset — the
      // one creating site where they apply, because product/19 §11 sets them for picked-up tickets.
      pipelineDial: pipelineDialFor(settings),
      // WP-106 (migration 0066): the limits and the dial above are the platform's defaults when the
      // project's configuration could not be read; the first admitted run takes them again.
      settingsRefreezePending: settings.configRefusal !== undefined,
      // Review round 2: the template above was routed with the refused document's switches read as
      // off, so the inputs are kept and the re-take routes the ticket again (`refrozen`).
      refreezeRouting:
        settings.configRefusal === undefined
          ? null
          : {
              issueType: (data.issue_type as string | null | undefined) ?? null,
              canCreateTickets: routing.canCreateTickets,
            },
      priorityRank: priorityRankOf((data.priority as string | null | undefined) ?? null),
      createdAt: options.clock.now(),
      branch: null,
      mr: null,
      workpad: null,
      costActualUsd: 0,
      estimateUsd: null,
      estimateBasis: null,
      estimateSamples: null,
      version: INITIAL_TASK_VERSION,
      ticketSnapshot,
      ticketSnapshotAt: ticketSnapshot === null ? null : ticketSnapshotReadAt,
      ticketSignalAt: null,
      // Never a review-only task: this is the ticket path (WP-24's is `review-only.ts`).
      reviewSubject: null,
      historySample: null,
      // Filled in at the rebase gate from the merge request's own diff (WP-37): a task that has
      // not written code yet has touched nothing to be classed.
      riskClasses: [],
      coverage: null,
      dependencies: null,
      requiredReviewers: null,
      reviewThreads: null,
      readyHeadSha: null,
      ciHeadSha: null,
      ciExcusedPaths: [],
      // The reporter's platform user, resolved above through `user_identities` and never by an
      // email match (WP-79, backlog 92's half (b)); `null` when nobody mapped the account.
      requestedByUserId,
    };
    /**
     * **The branch checked is the branch stored** (WP-149, PROGRESS backlog 443): the insert
     * re-reads `projects.default_branch` under the project-row lock it takes and refuses — nothing
     * written, `DefaultBranchChangedError` — when a change committed after `settings` was read and
     * the protection above was asked of the old branch. The throw fails this job, and its retry
     * (`PIPELINE_OUTBOUND_RETRY`) reads the new branch and asks again; past the retries the intake
     * reconciler re-matches the ticket.
     */
    await options.store.tasks.insert(scope.tx, stored, { defaultBranch: settings.defaultBranch });

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
      await closeParkedStageRow(options.store, scope.tx, escalated, ESCALATED_OUTCOME);
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

    const pipeline = compilePipeline(stored.task.template, stored.template, stored.pipelineDial);
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
  const work = await creation.catch((error: unknown) => {
    if (error instanceof DefaultBranchChangedError) {
      (options.logger ?? silentLogger).warn(
        {
          project_id: projectId,
          ticket_key: ticket.key,
          checked_branch: error.checked,
          stored_branch: error.stored,
        },
        'the default branch changed while the task was being created; nothing was created and the intake is retried against the new branch',
      );
    }
    throw error;
  });

  if (work !== null) {
    await enqueueStage(options.jobs, work);
  }
};

/**
 * `null` when the branch is protected, when there is no git binding, or when nobody can tell.
 *
 * **The branch is the stored `projects.default_branch`** (WP-142, backlog 441) — the branch the
 * task's runs will check out and its merge request will target — never the provider's default:
 * during a move (`develop` → `main`) the two differ, and protecting the provider's while the
 * platform delivers to the stored one checked the wrong branch.
 *
 * Called from the job and never from a handler: `integrationsForProject` refuses inside a
 * transaction, so a future caller that tries gets an error rather than a held connection. The
 * bindings are resolved by the caller and passed in, because the intake check now makes two
 * provider reads — this one and the ticket's own text (WP-15f) — and resolving twice would decrypt
 * the project's credentials twice for one job.
 */
const unprotectedDefaultBranch = async (
  integrations: PipelineIntegrations,
  projectId: Id,
  defaultBranch: string,
): Promise<string | null> => {
  if (integrations.git === null) {
    return null;
  }
  // No task exists yet — the row is written by the transaction this read precedes — so the audit
  // row names the project and the action, and the ticket key is in the payload the caller passes.
  const protectedBranch = await gitReads(integrations).branchProtected(defaultBranch, {
    projectId,
    taskId: null,
  });
  return protectedBranch === false ? defaultBranch : null;
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

    /**
     * WP-106 review round 1: **what follows a stage is not decided on the defaults.** The plan and
     * budget approval gates below, and the interpreter's next step, all read the project's
     * settings. Under a `configRefusal` they would read the platform's defaults (no
     * `plan_approval: always`, no risk classes, no budget threshold), and the measured result was
     * a task reaching `ready_for_merge` without the approval its project asks for. So the task is
     * parked by name here, and the completion is decided again when a person resumes it on the
     * corrected configuration.
     */
    const settings = await options.settings.forProject(withMr.task.projectId, context.scope.tx);
    if (settings.configRefusal !== undefined) {
      await escalateForConfigRefusalInHandler(
        {
          store: options.store,
          tx: context.scope.tx,
          emit: async (events) => {
            await context.emit(events);
          },
          context: contextFor(options, withMr.task.id, context.event.event.id),
        },
        withMr,
        settings.configRefusal,
        `what follows the "${event.payload.stage}" stage (its approval gates and the next stage)`,
      );
      return;
    }

    /**
     * WP-106 (migration 0066, review round 2): a task created while the configuration could not be
     * read froze the defaults — its iteration limits, its dial and, for intake, its **template**
     * (the spike and epic-split switches read as off). They are taken again here, the first step
     * decided on readable settings, before any gate or the next stage reads them: at `intake` the
     * ticket is routed again exactly as intake would have routed it on the parsed document.
     */
    const current = refrozen(withMr, settings);
    if (current !== withMr) {
      await options.store.tasks.refreezeSettings(
        context.scope.tx,
        current.task.id,
        refrozenColumns(current),
      );
    }

    const converged = await convergenceEscalation(options, context, current, event.payload.stage);
    if (converged) {
      return;
    }

    const gate = await planApprovalGate(options, context, current, event.payload.stage, signal);
    if (gate) {
      return;
    }

    // The two gates are disjoint by construction — the plan gate fires on the stage that produces
    // an `ImplementationPlan` and the budget gate on the one that produces a `RefinedSpec` — so the
    // order between them is not load-bearing. It is stated because a template that ever produced
    // both from one stage would need an arbiter rather than a sequence (standing rule 9).
    const budget = await budgetApprovalGate(options, context, current, event.payload.stage, signal);
    if (budget) {
      return;
    }

    await step(options, context, current, signal);
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
  await closeParkedStageRow(options.store, context.scope.tx, escalated, 'converged');
  await context.emit(escalated.events);
  return true;
};

/** Sizes in ascending order — the wire values of `sizeSchema`, narrowed from a model's string. */
const SIZES = ['S', 'M', 'L', 'XL'] as const satisfies readonly Size[];

/**
 * What the plan-approval gate does for a project whose dial has **never been materialised**.
 *
 * It reproduces the pre-WP-30 gate exactly — approve above size L, no probation, no risk classes —
 * and it is a named constant rather than a `??` chain so that the branch is visible and testable.
 * It is deliberately **not** `AUTONOMY_PRESETS.supervised`: substituting the release's supervised
 * preset would turn probation on for a project that never chose a dial position, which is a
 * behaviour change smuggled in as a default (standing rule 16).
 */
export const UNMATERIALISED_PLAN_APPROVAL = {
  picksUpNewTickets: true,
  stopAfterStage: null,
  planApproval: 'above_size',
  planApprovalSizeThreshold: 'L',
  planApprovalForRiskClasses: false,
  probation: false,
  probationTasks: 0,
  businessReview: true,
  questionTimeout: '1 working day',
  humanMrRounds: 3,
  knowledgeAutoApply: false,
  budgetApprovalThresholdUsd: null,
  reviewOnly: false,
  shadowMode: false,
  suggestedReadinessMin: 0,
} as const satisfies AutonomyPreset;

/** The paths an Implementation Plan declares it will touch (`files_to_change[].path`). */
const planPaths = (data: unknown): readonly string[] => {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return [];
  }
  const files = (data as Record<string, unknown>).files_to_change;
  if (!Array.isArray(files)) {
    return [];
  }
  return files.flatMap((entry) => {
    const path = (entry as Record<string, unknown> | null)?.path;
    return typeof path === 'string' ? [path] : [];
  });
};

/**
 * product/04 S2: "require human plan approval above a size threshold (default: require for L/XL)",
 * and since WP-30 the **dial** is what says so.
 *
 * Keyed on the stage *attempt*: a second plan needs a second approval, and an approval recorded
 * for attempt 1 must not wave attempt 2 through.
 *
 * ## Where the policy comes from, in one sentence per source
 *
 * The project's **materialised** preset (BD-027:14) decides, through the domain's
 * `requiresPlanApproval` — so `planApproval`, `planApprovalSizeThreshold`, `probation`,
 * `probationTasks` and `planApprovalForRiskClasses` are all read, rather than only the first two.
 * A project's `pipeline.template_overrides.<template>.stages.<stage>` entry is **finer grained than
 * the dial** and therefore wins over it, but only over the two fields it can express: an explicit
 * `plan_approval: never` on one stage does not turn off the risk-class gate, because a risk class is
 * a statement about the change and not about the stage (product/19 §14).
 *
 * A project whose dial has **never been materialised** keeps the pre-WP-30 behaviour exactly —
 * {@link UNMATERIALISED_PLAN_APPROVAL} — and that branch is named rather than defaulted:
 * substituting `AUTONOMY_PRESETS[level]` here is the read-time re-derivation BD-027:14 forbids, and
 * substituting the supervised preset would turn probation on for a project that never chose it.
 * Migration 0021 backfilled every row that existed and all three writers supply one, so the branch
 * is reachable only from a harness.
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
  /**
   * **A shadow task is not gated on plan approval** (WP-34), and the reason is what the gate is
   * for.
   *
   * product/04 S2 asks for a human decision *"before implementation"* because implementation is
   * what produces a merge request somebody has to live with. A shadow task produces none: every
   * mutating provider call it makes is refused and recorded as `would_have`
   * (`assertMutatingActionAllowed`), so there is nothing for an approval to protect.
   *
   * It is also the difference between a feature and a nuisance. `shadowMode` is true at exactly one
   * dial position, **Observe**, whose preset is `planApproval: 'always'` — so without this branch a
   * ten-ticket batch would stop on ten approval requests and product/19 §21's Phase A
   * (*"shadow mode on 10 closed tickets each"*) would be ten human clicks before any comparison
   * existed. Measured: the first walk of this work package's own e2e stopped at
   * `task.approval.requested` with nothing else to do.
   *
   * The **probation** counter is untouched by this: it counts the project's completed tasks, and a
   * shadow task never completes.
   */
  if (stored.task.mode === 'shadow') {
    return false;
  }
  // On the handler's own connection (WP-73, backlogs 19 and 221): no borrow inside the dispatch.
  const settings = await options.settings.forProject(stored.task.projectId, context.scope.tx);
  const pipeline = compilePipeline(stored.task.template, stored.template, stored.pipelineDial);
  const completed = stageOf(pipeline, stage);
  if (completed?.produces !== 'ImplementationPlan') {
    return false;
  }
  // **No yield to the dial's scope park** (WP-62 review round 1). product/19 §11 gives Assist
  // `always` in the plan-approval row, so a maintainer approves the plan first and the park applies
  // after it; the hand-back that continues a parked task is a `member` command and must not be a
  // way round a maintainer's approval (a plan touching a risk class included).
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
  const plan = await options.store.artifacts.latest(
    context.scope.tx,
    stored.task.id,
    'ImplementationPlan',
  );
  const rawSize =
    typeof plan?.data === 'object' && plan.data !== null && !Array.isArray(plan.data)
      ? (plan.data as Record<string, unknown>).estimated_size
      : null;
  const size = SIZES.find((candidate) => candidate === rawSize) ?? null;
  const preset: AutonomyPreset = {
    ...(autonomyPresetFor(settings) ?? UNMATERIALISED_PLAN_APPROVAL),
    ...(override?.plan_approval === undefined ? {} : { planApproval: override.plan_approval }),
    ...(override?.size_threshold === undefined
      ? {}
      : { planApprovalSizeThreshold: override.size_threshold }),
  };
  const needsApproval = requiresPlanApproval({
    preset,
    size,
    // Probation is "the first N tasks" of the project, so it is a count over the project and not
    // over this task. Asked only when the preset actually has probation on: a project past its
    // probation still pays the query otherwise, on every plan, for an answer nothing reads.
    tasksCompleted: preset.probation
      ? await options.store.tasks.countCompleted(context.scope.tx, stored.task.projectId)
      : 0,
    // product/19 §14, from the paths the plan itself declares — `risk-classes.ts` carries the
    // argument for reading them there rather than from a merge request diff that does not exist
    // yet, and the direction of the residual (a plan that omits a path escapes the class; a model
    // can never use it to *skip* a gate).
    riskClassesRequiringApproval: riskClassesRequiringPlanApproval(
      settings.config.policies?.risk_classes as Readonly<Record<string, RiskClass>> | undefined,
      planPaths(plan?.data),
    ),
  });
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
      // WP-56, BD-006's Q95 amendment: an approval expires on the question calendar and limit.
      deadlineFrom: questionDeadlineRule(options.calendar, settings),
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
 * Is this the moment product/09 calls *"before Implementation"* — and is there an Implementation?
 *
 * The estimate is made at refinement (`costEstimateHandler` on the `RefinedSpec`), so the first
 * stage completion that can read it is the one that produced the spec. "Before Implementation" is
 * then the rest of the question, and it is asked of the **compiled pipeline** rather than of a
 * template name: the three ticket templates put a different number of stages between refinement and
 * implementation (`chore` has no architecture stage at all), and two templates have no
 * implementation stage whatever — `ticket_lint`'s one stage also produces a `RefinedSpec`
 * (WP-25) and `discovery`'s produces a draft. Gating those would park a linter comment in front of
 * a maintainer for a spend that is one short run.
 *
 * `conflict_resolution` also produces `ImplementationNotes` and sits *after* refinement in
 * declaration order, so it satisfies this on its own; that is harmless and deliberate — a template
 * that can reach a conflict resolution has an `implementation` stage in front of it in all three
 * cases, and the question this predicate exists to answer is "is there still agent work to pay for".
 */
export const spendIsStillAhead = (pipeline: CompiledPipeline, stage: Slug): boolean => {
  const index = pipeline.stages.findIndex((entry) => entry.id === stage);
  if (index < 0 || pipeline.stages[index]?.produces !== 'RefinedSpec') {
    return false;
  }
  return pipeline.stages.slice(index + 1).some((entry) => entry.produces === 'ImplementationNotes');
};

/**
 * product/09: *"an optional per-project threshold routes expensive tasks to budget approval by a
 * maintainer before Implementation"* — WP-28, and the gate `requiresBudgetApproval` was written for.
 *
 * It is `planApprovalGate`'s sibling in every mechanical respect and differs in three decided ones.
 *
 * **What it reads.** `AutonomyPreset.budgetApprovalThresholdUsd`, out of the project's
 * **materialised** preset (`autonomyPresetFor`, BD-027:14) — never `AUTONOMY_PRESETS[level]`, which
 * is the read-time re-derivation that decision forbids. A project whose dial has never been
 * materialised is **not gated**: that is the pre-WP-28 behaviour exactly, and it is a named branch
 * rather than a substituted preset, for the reason {@link UNMATERIALISED_PLAN_APPROVAL} gives one
 * function up. A materialised preset whose threshold is `null` is the dial saying *"no budget
 * approval at this position"* (Observe and Autonomous both do), and is likewise not gated.
 *
 * **Which number crosses it (Q71 (a), implemented).** The **point estimate** on the task row, not
 * the p75 of a range: product/19 §15's range was specified for a median-of-30 model that Q65
 * already replaced, and there is no distribution to take a quantile of. `tasks.estimate_usd` beside
 * `tasks.cost_actual` is what the revisit will be made from.
 *
 * **What happens when there is no estimate (Q71 (b), implemented).** Nothing: `estimate_usd is
 * null` does **not** gate. A gate that fires on a missing number is standing rule 16 inverted, and
 * `basis: 'unknown'` is exactly a project's first tasks — parking every one of them in front of a
 * maintainer is the worst possible first impression. The absence is made *visible* instead, on the
 * workpad (`renderWorkpad`) and on the task DTO (`estimate_basis`), and the per-task cap (BD-010,
 * default $50) is what bounds the spend meanwhile.
 *
 * **Keyed on the task and the kind, not on the stage attempt.** The estimate is written once
 * (`costEstimateHandler`'s `estimateUsd !== null` guard), so a re-refinement produces the same
 * number and a second ask would be the same question — see `ApprovalRepository.latestOfKind`, which
 * carries the measurement.
 */
const budgetApprovalGate = async (
  options: PipelineSagaOptions,
  context: HandlerContext,
  stored: StoredTask,
  stage: Slug,
  signal: PipelineSignal,
): Promise<boolean> => {
  if (signal.kind !== 'stage_completed' || signal.verdict !== 'approve') {
    return false;
  }
  if (
    !spendIsStillAhead(
      compilePipeline(stored.task.template, stored.template, stored.pipelineDial),
      stage,
    )
  ) {
    return false;
  }
  const estimateUsd = stored.estimateUsd;
  if (estimateUsd === null) {
    // Named rather than silent: "this project has no finished task to estimate from" is the one
    // case where the gate is off *and* somebody might have expected it on.
    (options.logger ?? silentLogger).debug(
      { task_id: stored.task.id, estimate_basis: stored.estimateBasis },
      'budget approval: the task has no estimate, so no threshold can be crossed',
    );
    return false;
  }
  const already = await options.store.approvals.latestOfKind(context.scope.tx, {
    taskId: stored.task.id,
    kind: 'budget',
  });
  if (already !== null) {
    return false;
  }
  const settings = await options.settings.forProject(stored.task.projectId, context.scope.tx);
  const preset = autonomyPresetFor(settings);
  if (preset === null) {
    // Never materialised: the pre-WP-28 behaviour, which is no budget gate at all. A named branch
    // rather than a substituted preset, for the reason {@link UNMATERIALISED_PLAN_APPROVAL} gives.
    return false;
  }
  // The one place the threshold is read, and the only guard: `requiresBudgetApproval` answers false
  // for a `null` threshold, so a second check for it here would be an inner layer the outer one
  // makes unreachable — untestable by construction (standing rule 22).
  if (!requiresBudgetApproval(preset, estimateUsd)) {
    return false;
  }
  (options.logger ?? silentLogger).info(
    {
      task_id: stored.task.id,
      estimate_usd: estimateUsd,
      threshold_usd: preset.budgetApprovalThresholdUsd,
      estimate_basis: stored.estimateBasis,
      estimate_samples: stored.estimateSamples,
    },
    'budget approval: the estimate is over this project’s threshold; the task waits for a maintainer',
  );

  const attempt = stored.task.stageAttempts[stage] ?? 1;
  const commandContext = contextFor(options, stored.task.id, context.event.event.id);
  const approval = createApproval(
    {
      id: options.ids.next(),
      taskId: stored.task.id,
      projectId: stored.task.projectId,
      kind: 'budget',
      // The plan gate's expiry, for the reason WP-28 gave for sharing its decision shape.
      deadlineFrom: questionDeadlineRule(options.calendar, settings),
    },
    commandContext,
  );
  // The stage and attempt are recorded truthfully even though the lookup above does not use them:
  // they are what `approvalHandler` resumes from, and what an audit reads to say where the task was
  // when the spend was questioned.
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
 * The merge request the platform recorded, checked against the one the developer stage reported
 * (WP-138 ruling (e)).
 *
 * Until WP-138 this handler **took** the reference from `ImplementationNotes.mr` — a model's
 * claim — and wrote it to `tasks.mr_ref`, so whatever iid a run reported became the merge request
 * `mr.merged` advances the task on. The record is now written by the platform itself, when the
 * `open_mr` tool opens or adopts a merge request (`tasks.recordMergeRequest`), and this handler
 * only **compares**: a report that names another merge request than the record is logged, and the
 * stage executor has already noted it on the stored artifact and stored the record's reference in
 * its place (`withPlatformMergeRequestRecord`). A report with no record behind it is logged too and
 * moves nothing — a shadow task, or a run that never called the tool.
 *
 * The one column it still writes is `tasks.branch` (`save`'s), filled from the record when the task
 * had none: the next run of the task checks out that branch (`checkoutOf`).
 */
const recordMergeRequest = async (
  options: PipelineSagaOptions,
  context: HandlerContext,
  stored: StoredTask,
  stage: Slug,
): Promise<StoredTask> => {
  const pipeline = compilePipeline(stored.task.template, stored.template, stored.pipelineDial);
  if (stageOf(pipeline, stage)?.produces !== 'ImplementationNotes') {
    return stored;
  }
  const notes = await options.store.artifacts.latest(
    context.scope.tx,
    stored.task.id,
    'ImplementationNotes',
  );
  const reported = reportedMergeRequestIid(notes?.data);
  const recorded = stored.mr;
  if (reported !== null && (recorded === null || recorded.iid !== reported)) {
    (options.logger ?? silentLogger).warn(
      {
        task_id: stored.task.id,
        reported_iid: reported,
        recorded_iid: recorded?.iid ?? null,
      },
      'the developer stage reported a merge request the platform did not record; the record stands',
    );
  }
  if (recorded === null || stored.branch !== null || recorded.branch == null) {
    return stored;
  }
  // The saved snapshot: this handler writes the task again a few lines later, through
  // `applyDecision`, and the second write carries the version this one consumed (WP-15e).
  return options.store.tasks.save(context.scope.tx, { ...stored, branch: recorded.branch });
};

/** The iid an `ImplementationNotes` artifact reports, or `null` when it reports none. */
const reportedMergeRequestIid = (data: unknown): number | null => {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return null;
  }
  const mr = (data as Record<string, unknown>).mr;
  if (typeof mr !== 'object' || mr === null || Array.isArray(mr)) {
    return null;
  }
  const iid = (mr as Record<string, unknown>).iid;
  return typeof iid === 'number' ? iid : null;
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
          // The brief names only commands the aggregates accept on this task **now** (WP-56 round 2,
          // backlog 163): the question is `escalated`, whose transitions are `[]`, so answering it
          // is refused — the old sentence ("answer it … and the task will carry on") promised the
          // one thing that cannot happen. The task is `needs_human` at the asking stage, which
          // `retryStageCommand` accepts; `returnToStageCommand` does **not** (`needs_human →
          // returned` is not an edge — measured, it was this sentence's first draft), so it is not
          // offered. `deadlines.test.ts` performs the retry on an expired question's task.
          blockerBrief:
            `${stored.task.ticket.key} was waiting for an answer to: ${question.text}\n\n` +
            'Nobody answered in time, and an expired question can no longer be answered. To go on, ' +
            `retry "${question.stage}" from the task page — it runs again and asks afresh, and that ` +
            'question can be answered — or cancel the task.',
        },
        commandContext,
      );
      await options.store.tasks.save(context.scope.tx, { ...stored, task: escalated.aggregate });
      await closeParkedStageRow(options.store, context.scope.tx, escalated, 'question.expired');
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

    if (event.payload.decision === 'rejected' && record?.approval.kind === 'budget') {
      // **A rejected budget is not a rejected plan, and it does not go round the loop again.**
      //
      // Rejecting a plan is a statement about *this plan*, so product/04 S2 sends the task back to
      // Architecture to write a better one. Rejecting a spend is a statement about *the task*: the
      // estimate is written once and a second refinement round would produce the same number, so
      // resuming the stage would walk straight back into a gate that is already keyed as asked and
      // spend the money the maintainer just refused. The task stops and says why — `needs_human`,
      // which is the existing vocabulary rather than a state of its own (Q59).
      const refused = escalateTask(
        stored.task,
        {
          reason: 'a maintainer rejected the cost estimate for this task',
          blockerBrief:
            `The estimated cost of ${stored.task.ticket.key} was not approved${
              typeof event.payload.reason === 'string' && event.payload.reason.length > 0
                ? `: ${event.payload.reason}`
                : ''
            }. ` +
            'Nothing has been spent on Implementation. Either raise the project’s budget-approval ' +
            'threshold and hand the task back at the stage it should resume from, or cancel it.',
        },
        commandContext,
      );
      await options.store.tasks.save(context.scope.tx, { ...stored, task: refused.aggregate });
      await closeParkedStageRow(options.store, context.scope.tx, refused, 'budget.rejected');
      await context.emit(refused.events);
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
        // Names only what is accepted now (WP-56 round 2, backlog 163): an `expired` approval has
        // no transitions, so "approve or reject it" was refused, and `needs_human → returned` is not
        // an edge either, so a return is not offered. Retrying the stage the approval interrupted
        // is accepted on the `needs_human` task; for a **budget** approval it carries
        // on without asking again (`latestOfKind` finds the expired one), which the sentence says,
        // because a maintainer who retries is making the spend decision.
        blockerBrief:
          `Nobody decided the ${record?.approval.kind ?? 'plan'} approval for ${stored.task.ticket.key} in time, ` +
          'and an expired approval can no longer be approved or rejected. To go on, ' +
          (record?.approval.kind === 'budget'
            ? `retry "${stage}" from the task page — the task then carries on without asking for the budget again, so retrying is the approval — `
            : `retry "${stage}" from the task page to have the plan written and asked for again — `) +
          'or cancel the task.',
      },
      commandContext,
    );
    await options.store.tasks.save(context.scope.tx, { ...stored, task: escalated.aggregate });
    await closeParkedStageRow(options.store, context.scope.tx, escalated, 'approval.expired');
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
    const pipeline = compilePipeline(stored.task.template, stored.template, stored.pipelineDial);
    const waiting = stageOf(pipeline, stage);
    if (
      waiting?.kind !== 'gate' ||
      !waiting.on.some((entry) => entry.on === 'ci.pipeline.finished')
    ) {
      // A pipeline result for a task that is not at the CI gate is somebody else's news.
      return;
    }
    /**
     * **Decided here, settled by a duty** (WP-60 review round 2). This handler used to settle the
     * gate from the payload for **any** pipeline of this iid, so a green pipeline for a commit that
     * was no longer the head passed it. Whether the pipeline ran on the head is a question for the
     * provider's live answer, which a handler inside the dispatch transaction may not ask (WP-15d):
     * `ci_settle` (`ci-settle.ts`) reads it and settles only on a match — the convergence rule
     * (three identical failures) moved with it, into the settlement both paths share (`jobs.ts`).
     */
    const data: PipelineOutboundData = {
      duty: 'ci_settle',
      project_id: event.payload.project_id,
      task_id: stored.task.id,
      cause_event_id: event.id,
      stage,
      head_sha: event.payload.head_sha,
      ci_status: event.payload.status,
      failed_jobs: event.payload.failed_jobs.map((job) => job.name),
      failed_job_logs: event.payload.failed_jobs.map((job) => ({
        name: job.name,
        log_ref: job.log_ref ?? null,
      })),
    };
    context.afterCommit(async () => {
      await enqueueOutbound(options.jobs, data);
    });
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
    /** Parks the task with a brief, closing the stage row it was at with the event's name. */
    const escalateFor = async (
      outcome: 'mr.closed' | 'mr.merged',
      reason: string,
      brief: string,
    ) => {
      const escalated = escalateTask(
        stored.task,
        { reason, blockerBrief: brief },
        contextFor(options, stored.task.id, event.id),
      );
      await options.store.tasks.save(context.scope.tx, { ...stored, task: escalated.aggregate });
      await closeParkedStageRow(options.store, context.scope.tx, escalated, outcome);
      await context.emit(escalated.events);
    };
    if (event.type === 'mr.closed') {
      if (stored.task.state === 'done' || stored.task.state === 'cancelled') {
        return;
      }
      if (stored.task.state === 'needs_human') {
        // `needs_human → needs_human` is not an edge, and the task already waits for a person
        // (WP-110). The close is added to the brief instead (review round 1): the notification and
        // the workpad re-read `task.escalated`, so the person handling the task learns of it. A
        // repeat of the same close never reaches here — the inbound lifecycle dedup drops it.
        const amended = amendEscalation(
          stored.task,
          {
            reason: 'the merge request was closed',
            blockerBrief:
              `The merge request for ${stored.task.ticket.key} was closed without being merged while the task was waiting for a human. ` +
              'Deal with the earlier escalation knowing it: hand the task back at Architecture if the approach was wrong, or cancel it if the work is not wanted.',
          },
          contextFor(options, stored.task.id, event.id),
        );
        await options.store.tasks.save(context.scope.tx, { ...stored, task: amended.aggregate });
        await context.emit(amended.events);
        return;
      }
      // product/04 S7: "MR close/decline → `Needs human` with reason".
      await escalateFor(
        'mr.closed',
        'the merge request was closed',
        `The merge request for ${stored.task.ticket.key} was closed without being merged. ` +
          'Say why on the ticket: if the approach was wrong, hand the task back at Architecture; if the work is not wanted, cancel the task.',
      );
      return;
    }
    const stage = stored.task.currentStage;
    if (stage === null) {
      return;
    }
    if (stored.task.state === 'paused' && stage !== READY_FOR_MERGE_STAGE) {
      // Q104: a merge of a task paused at any **other** stage is not the decision the pause was
      // waiting for — the pipeline never got the change to Ready — so it is escalated with a brief
      // rather than dropped, which is what this branch did before WP-73.
      await escalateFor(
        'mr.merged',
        'the merge request was merged while the task was paused before it was ready',
        `The merge request for ${stored.task.ticket.key} was merged on the provider while the task was paused at ${stage}, ` +
          'before the pipeline had marked it ready. Check what was merged; then cancel the task, or hand it back if work remains.',
      );
      return;
    }
    const state = stored.task.state;
    if (state === 'needs_human') {
      // `needs_human → needs_human` is not an edge, and the task already waits for a person; the
      // merge is logged so it is not lost without a trace (WP-73b, backlog 264). The brief the task
      // carries is the earlier one — the one case the entry leaves as this line.
      (options.logger ?? silentLogger).warn(
        { task_id: stored.task.id, stage, mr_iid: event.payload.mr.iid },
        'the merge request was merged while the task was waiting for a human; its brief does not mention the merge',
      );
      return;
    }
    if (
      state === 'active' ||
      state === 'returned' ||
      state === 'waiting_answers' ||
      state === 'waiting_approval'
    ) {
      // WP-73b, backlog 264: a merge made on the provider while the pipeline is still working
      // towards Ready is not the decision `ready_for_merge` waits for. It used to be dropped here
      // — the task ran on against a merged merge request and never reached `retro` — and is now
      // escalated, as `mr.closed` is from every non-terminal state and as Q104 (c) escalates a
      // merge of a task paused before Ready.
      await escalateFor(
        'mr.merged',
        'the merge request was merged before the pipeline marked it ready',
        `The merge request for ${stored.task.ticket.key} was merged on the provider while the task was ${state} at ${stage}, ` +
          'before the pipeline had marked it ready. Check what was merged; then cancel the task, or hand it back if work remains.',
      );
      return;
    }
    // `paused` here is a task paused **at** `ready_for_merge` (Q104, answer (a)): the merge is the
    // human decision the pause held the platform back for, so it ends the pause — `recordMerge`
    // emits `task.resumed` before the merge's own `task.stage.entered` (backlog 244). Every other
    // state left (`queued`, `merged`, `retro`, `done`, `cancelled`) has already moved past a merge
    // or never had a stage.
    if (state !== 'ready_for_merge' && state !== 'paused') {
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
    if (isPlatformNote({ body: event.payload.text })) {
      // The platform's own note — a conflict warning, a review-only finding — arriving back as a
      // Note hook is not a reviewer speaking, so it arms no window (WP-73, backlog 214). The
      // window's own predicate ignores it too, so this is the cheaper half, not the only one.
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
    /**
     * WP-142 (backlog 441): only a move of the **stored** default branch re-checks a waiting task.
     * A webhook's `default_branch.moved` names the provider's default (GitLab's push hook), which
     * during a move is not the branch the merge requests target, and re-entering the rebase gate on
     * it would spend `rebase_rechecks` on a branch nothing merges into.
     */
    const settings = await options.settings.forProject(event.payload.project_id, context.scope.tx);
    if (event.payload.branch !== settings.defaultBranch) {
      (options.logger ?? silentLogger).info(
        {
          project_id: event.payload.project_id,
          moved: event.payload.branch,
          default_branch: settings.defaultBranch,
        },
        'a branch that is not this project’s default branch moved; no waiting task is re-checked',
      );
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
    const settings = await options.settings.forProject(projectId, context.scope.tx);
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

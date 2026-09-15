/**
 * The ticket readiness linter — product/18's *"A light Refinement pass on new tickets of configured
 * issue types that are **not** labelled for the agent; posts one short comment: the questions a
 * developer would ask, missing acceptance criteria, an agent-readiness score"*, and product/04's
 * *"a light Refinement pass on unlabelled tickets that posts one comment"* (WP-25).
 *
 * ## The task shape, decided the same way twice before
 *
 * A lint is **a task on the one-stage `TICKET_LINT_TEMPLATE`**, in `mode: 'normal'`, carrying a
 * platform-issued ticket reference built from the ticket's key. The three reasons are WP-21's and
 * WP-24's, and only the third is new here:
 *
 *  1. `runs.task_id` is `not null`, so a lint run needs a task whatever else is decided — and making
 *     it a stage of one means the admission guard, the cost ledger, the transcript sink, the budget
 *     cap, the conflict retry and the `needs_human` escalation are the ones every other run gets.
 *  2. `tasks.mode` stays `('normal','shadow')`: `linter` is a **run** mode in technical/04's table,
 *     and the planner maps the template to it (`RUN_MODE_BY_TEMPLATE`).
 *  3. The ticket key is {@link lintTicketKeyFor}, **not the ticket's own key**, and that is the
 *     decision to check first. `unique (project_id, ticket_key, mode)` is what makes one lint per
 *     ticket; if the lint task carried `ACME-2` it would *be* the row `pipeline.intake`'s dedup
 *     finds, so labelling a linted ticket for the agent afterwards would create no task at all —
 *     the linter's own closing line ("add the label") would break the thing it offers. With
 *     `lint!ACME-2` the two coexist: the lint task on the board is visibly not a delivery, and the
 *     delivery is created normally when the label arrives.
 *
 * ## What "one comment" rests on, in the order the guards fire
 *
 * product/18 says *"posts one short comment"* and product/19 § 17 says *"Never re-posted"*. Four
 * things hold that, and none of them is a provider's error:
 *
 *  - the **task key** above: a second `ticket.created` for the same ticket finds the lint task and
 *    creates nothing, so there is no second run;
 *  - the **idempotency key** {@link lintCommentIdempotencyKey}: one per task, no part of it written
 *    by a model, so a redelivered wake-up *and* a re-run of the stage replay the provider's first
 *    answer instead of adding a comment (`integration_idempotency` has no expiry — migration 0013);
 *  - the **filter**: a ticket that already carries the agent label is not linted at all — and,
 *    because that label is the *project's* and the pick-up rule is the *integration's* (Q75), the
 *    question the platform actually cares about is asked separately and on the job's own state:
 *    {@link lintRefusal}, "is this ticket already a task the pipeline is delivering";
 *  - the lint task's **platform ticket reference**, which is why the workpad and the status mapping
 *    write nothing: `ticketWrites` refuses a platform-issued reference by name (it used to be
 *    refused by the *provider*, with a failed audit row and a retrying job — standing rule 47).
 *
 * ## The ticket's own words, read once
 *
 * The duty reads the ticket through `ticketReads` — the same `readTicket` path WP-15f built, through
 * `IntegrationActionExecutor`, audited — and uses that one answer for both questions it has: the
 * filter (issue type, labels) and `boundTicketSnapshot`, which is what reaches the prompt. A read
 * that **throws** fails the job rather than starting a lint without the ticket, and a read that
 * finds no binding settles: unlike the pipeline's own intake, where the ticket is why the task
 * exists and a Jira outage must not lose it, here the ticket's text *is* the whole input and
 * spending a budget without it would produce a comment about nothing (standing rule 20's
 * fail-closed direction for a decision to spend — the argument `runReviewOnlyCheck` makes about the
 * diff).
 *
 * ## What the comment is, and what it is not
 *
 * The **score and the gaps are the platform's** (`packages/domain/src/policies/ticket-lint.ts`),
 * computed from the `RefinedSpec` the run produced; the **questions are the model's**, selected and
 * bounded here. The model never sees the score and never writes one — `RefinedSpec` has no field for
 * it — so it cannot flatter its own ticket. The text that leaves the platform is redacted with the
 * task-management binding's redactor at the write (`ticketWrites.lintComment`), because it is model
 * output on its way to a third party; `artifacts.data` still stores the spec unredacted (PROGRESS
 * backlog 35), which this work package neither closes nor widens.
 */
import {
  type Actor,
  type Id,
  type IsoDateTime,
  type TicketRef,
  ticketRefSchema,
} from '@platform/contracts';
import type { TicketLintSettings, TicketReadiness } from '@platform/domain';
import {
  buildEvent,
  compilePipeline,
  createTask,
  DEFAULT_LINT_ISSUE_TYPES,
  DEFAULT_LINT_LABEL,
  interpret,
  MAX_LINT_QUESTIONS,
  resolveIterationLimits,
  scoreTicketReadiness,
  selectLintQuestions,
  type TicketLintSpec,
  ticketMatchesLintFilter,
} from '@platform/domain';
import type { EventHandler, HandlerContext } from '../events/handler.js';
import type { Ticket, TicketRefInput } from '../ports/integrations/task-management.js';
import { silentLogger } from '../ports/logger.js';
import type { Transaction } from '../ports/transaction.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import {
  integrationsForProject,
  noRunScopedSecrets,
  ticketReads,
  ticketWrites,
} from './integrations.js';
import { enqueueOutbound, enqueueStage, type PipelineOutboundData } from './jobs.js';
import type { PipelineSagaOptions } from './saga.js';
import { priorityRankOf } from './saga.js';
import type { ProjectSettings } from './settings.js';
import { INITIAL_TASK_VERSION, PIPELINE_ACTOR, type StoredTask } from './store.js';
import { boundTicketSnapshot } from './ticket-snapshot.js';
import { applyDecision } from './transitions.js';

/** The id `TICKET_LINT_TEMPLATE` is registered under in `SHIPPED_TEMPLATES`. */
export const TICKET_LINT_TEMPLATE_ID = 'ticket_lint';

/** The one agent stage of that template, and the key of its own stage defaults and budget. */
export const TICKET_LINT_STAGE = 'ticket_lint';

/**
 * The ticket provider a lint task carries — `platform`, the same value discovery and review-only
 * use, and for the same reason: nothing may resolve it to an adapter and write on a ticket that does
 * not exist. `ticketWrites` refuses it by name, which is what keeps the workpad and the status
 * mapping off a human's ticket.
 */
export const TICKET_LINT_TICKET_PROVIDER = 'platform';

const LINT_KEY_PREFIX = 'lint!';

/**
 * `lint!<the ticket's own key>` — one lint per ticket, per project.
 *
 * The `!` is the separator {@link REVIEW_ONLY_TICKET_PROVIDER}'s key uses and it is chosen for the
 * same property: no provider issues an issue key containing one, so a synthetic key can never
 * collide with a real ticket's — which is precisely what this key exists to avoid (see the module
 * docblock).
 */
export const lintTicketKeyFor = (ticketKey: string): string => `${LINT_KEY_PREFIX}${ticketKey}`;

/** The ticket a lint task is about, recovered from its platform-issued key. */
export const ticketKeyOfLintTask = (lintKey: string): string =>
  lintKey.startsWith(LINT_KEY_PREFIX) ? lintKey.slice(LINT_KEY_PREFIX.length) : lintKey;

/**
 * product/19 § 17: *"One comment, marker `<!-- agentic:linter -->`"*.
 *
 * The document's exact string, and a **constant rather than a per-task marker** — unlike BD-023's
 * workpad and unlike review-only's threads, both of which carry a task id because a project can have
 * many of them on one merge request. A ticket has at most one lint, ever, and product/19 wrote the
 * marker without a parameter: this is what a human or a later pass greps for to find out whether the
 * platform has already said something about a ticket.
 */
export const LINT_COMMENT_MARKER = '<!-- agentic:linter -->';

/**
 * The same fact in the **platform's** provider-agnostic dialect: `CommentRef.marker_id`.
 *
 * Both are carried, and they do different jobs. product/19's string is in the body, where a provider
 * that renders markdown hides it and a human greps for it. The marker **id** is what the port
 * understands: it sets `comments[].marker_id`, which is how `boundTicketSnapshot` recognises the
 * platform's own comments and drops them (a later Refinement must not be shown the platform's lint
 * as if a human had written it), and it is what the Jira adapter looks for *before* posting, which
 * is a third guard behind the idempotency key and the lint task's key.
 *
 * The residual, stated because it is visible to a user: Jira renders neither markdown nor HTML
 * comments, so on Jira the body's `<!-- agentic:linter -->` is a literal line and the marker id
 * arrives as the adapter's own `[agentic:marker:agentic:linter]` paragraph. product/19 § 17 names
 * the first spelling and BD-023's convention is the second; the comment carries both rather than
 * this work package choosing which document to contradict.
 */
export const LINT_COMMENT_MARKER_ID = 'agentic:linter';

/**
 * The idempotency key of the one comment — the task, and nothing else.
 *
 * **No part of it is model output** and no part of it is provider text: `taskId` is a uuid the
 * platform minted, so `idempotencyScopeFor` has nothing to refuse and no placeholder can reach it
 * (the rule WP-24's review round 2 earned). Identity is *this lint*, so a redelivered wake-up and a
 * re-run of the stage both replay the first answer — which is what product/19 § 17's *"Never
 * re-posted"* means when the wake-up is at-least-once.
 *
 * What it costs is the same trade review-only states: if the stage is re-run and the model writes
 * different questions, the comment keeps the first run's text. That is the fail-closed direction for
 * a mutation on somebody else's ticket (standing rule 20).
 */
export const lintCommentIdempotencyKey = (taskId: Id): string => `ticket_lint_comment:${taskId}`;

// ── The comment ──────────────────────────────────────────────────────────────

/**
 * product/19 § 17: *"≤ 10 lines"*.
 *
 * Ten is the marker, the score line, one blank, the questions heading, five questions and the offer
 * — which is the worst case, and `ticket-lint.test.ts` produces it rather than asserting the
 * arithmetic here (standing rule 39).
 */
export const MAX_LINT_COMMENT_LINES = 10;

/**
 * How long one question may be in the comment.
 *
 * Derived rather than chosen: the comment is ten lines on a ticket, so a question has to be *a
 * line*. 300 characters is about three printed lines in a Jira comment and an order of magnitude
 * under the 20 000 the same model's answer gets in an artifact (`MAX_ARTIFACT_CHARS`) — long enough
 * for a real question, short enough that five of them are still a comment somebody reads. Over it is
 * a **cut with an ellipsis**, never a refusal: a question nobody can shorten must still be asked
 * (standing rule 20).
 */
export const MAX_LINT_QUESTION_CHARS = 300;

/** The agent label as printed in the offer line; a project's own string, so it is bounded too. */
export const MAX_LINT_LABEL_CHARS = 64;

/**
 * The longest comment this renderer can produce, at the shipped caps — the figure
 * `ticket-lint.test.ts` pins by driving the renderer rather than by quoting it.
 *
 * The score line's own text, the heading and the offer are platform prose of known length; what
 * varies is five questions and the label.
 */
export const LINT_COMMENT_MAX_TEXT_CHARS =
  MAX_LINT_QUESTIONS * (MAX_LINT_QUESTION_CHARS + 2) + MAX_LINT_LABEL_CHARS + 400;

const cut = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** The platform's own label for each gap — product/19 § 17's three names, in its words. */
const GAP_LABEL: Readonly<Record<TicketReadiness['missing'][number], string>> = {
  acceptance_criteria: 'acceptance criteria',
  scope_boundaries: 'scope boundaries',
  validation: 'how it will be validated',
};

export interface LintCommentInput {
  readonly readiness: TicketReadiness;
  readonly questions: readonly string[];
  /** The label a human adds to have the ticket delivered — the project's own configured string. */
  readonly label: string;
}

/**
 * product/19 § 17's comment, and every clause of that sentence is here: the marker, the score, the
 * top three missing elements, up to five questions, and the one-line offer.
 *
 * **The platform writes every word that is not a question.** The questions are the model's and are
 * cut to {@link MAX_LINT_QUESTION_CHARS}; the label is the project's and is cut too. Nothing else in
 * the comment comes from outside this function, which is what makes the ten-line bound a property of
 * the renderer rather than a hope about the model.
 *
 * A ticket with no questions gets a four-line comment rather than an empty heading: *"no questions"*
 * is information, and an empty section reads like a bug.
 */
export const renderLintComment = (input: LintCommentInput): string => {
  const missing =
    input.readiness.missing.length === 0
      ? 'nothing obvious is missing'
      : `missing: ${input.readiness.missing.map((gap) => GAP_LABEL[gap]).join(', ')}`;
  const offer =
    `Add the label \`${cut(input.label, MAX_LINT_LABEL_CHARS)}\` to have this ticket ` +
    'picked up and delivered by the Agentic platform.';
  const questions = input.questions
    .slice(0, MAX_LINT_QUESTIONS)
    .map((question) => `- ${cut(question, MAX_LINT_QUESTION_CHARS)}`);
  return [
    LINT_COMMENT_MARKER,
    `**Agent readiness: ${input.readiness.score}/100** — ${missing}.`,
    '',
    ...(questions.length === 0
      ? []
      : ['Questions a developer would ask before starting:', ...questions]),
    offer,
  ].join('\n');
};

// ── Settings ─────────────────────────────────────────────────────────────────

/**
 * The project's `features.ticket_linter`, with every default filled in.
 *
 * The effective configuration already merges the shipped defaults, but the pipeline is handed
 * `ConfigValues` from several composition roots (a unit harness passes `{}`), so they are applied
 * here too — the same reason `resolveReviewOnlySettings` does it. An `issue_types` a project set to
 * `[]` is kept as `[]` (it matches nothing, deliberately); only an **absent** list falls back.
 */
export const resolveTicketLintSettings = (settings: ProjectSettings): TicketLintSettings => {
  const configured = settings.config.features?.ticket_linter;
  return {
    enabled: configured?.enabled ?? false,
    issueTypes: configured?.issue_types ?? DEFAULT_LINT_ISSUE_TYPES,
    label: configured?.label ?? DEFAULT_LINT_LABEL,
  };
};

// ── The handlers ─────────────────────────────────────────────────────────────

const actorFor = (): Actor => PIPELINE_ACTOR;

/** The duties need a transaction of their own: they run in a job, not in the dispatcher's. */
export interface TicketLintOptions extends PipelineSagaOptions {
  readonly unitOfWork: UnitOfWork;
}

/**
 * The two questions the platform answers out of its own tables — a reason to stop, or `null`.
 *
 * 1. **Has this ticket already been linted?** The lint task's key is the idempotency of the whole
 *    feature (see the module docblock).
 * 2. **Is this ticket already a task the pipeline is delivering?** Not redundant with the duty's
 *    label filter: a ticket that is already a task is one the pipeline is delivering **whatever
 *    the label says now** — a human may have removed the label, the project may pick tickets up by
 *    `pickup_status` rather than by a label at all, or its `pickup_label` may simply differ from
 *    `features.ticket_linter.label` (one is integration configuration, the other is the project's,
 *    and nothing ties them together — Q75). None of those wants a comment asking a human to add a
 *    label so that the pipeline picks up a ticket it is already delivering.
 *
 * `mode: 'normal'` on the second read is the delivery's mode: `unique (project_id, ticket_key,
 * mode)` is the key, `pipeline.intake` always creates `normal`, and nothing in this build creates a
 * `shadow` task.
 */
const lintRefusal = async (
  options: PipelineSagaOptions,
  tx: Transaction,
  projectId: Id,
  ticket: { readonly provider: string; readonly key: string },
): Promise<string | null> => {
  const linted = await options.store.tasks.findByTicket(tx, {
    projectId,
    provider: TICKET_LINT_TICKET_PROVIDER,
    ticketKey: lintTicketKeyFor(ticket.key),
    mode: 'normal',
  });
  if (linted !== null) {
    return 'the ticket has already been linted';
  }
  const delivered = await options.store.tasks.findByTicket(tx, {
    projectId,
    provider: ticket.provider,
    ticketKey: ticket.key,
    mode: 'normal',
  });
  if (delivered !== null) {
    return 'the ticket is already a task the pipeline is delivering';
  }
  return null;
};

/**
 * `ticket.created` → consider a lint.
 *
 * Priority 10, the core band, and it does **nothing but decide**: {@link lintRefusal}'s two cheap
 * indexed reads inside the dispatcher's transaction and an `afterCommit` enqueue. Whether the
 * project has the feature on is a *settings* read — I/O — so it belongs to the job, which is the
 * division `pipeline.intake` and `pipeline.review.only` both make.
 *
 * **This is the early-out, not the guard** (WP-25 round 2). Asked here alone, the delivery question
 * is dead in the very case it documents: `pipeline.intake` enqueues `intake_check` from
 * `afterCommit` and the task is created by that *job*, so when Jira's `jira:issue_created` delivery
 * produces `ticket.matched` **and** `ticket.created` — which is what the normaliser does for a
 * ticket created with the pick-up label already on it — no delivery task exists yet when this
 * handler looks. The question that decides is therefore asked again on fire, twice, in
 * {@link runTicketLintCheck}; every job re-validates because a timer cannot be cancelled (TD-004).
 */
export const ticketLintHandler = (options: PipelineSagaOptions): EventHandler => ({
  name: 'pipeline.ticket.lint',
  priority: 10,
  eventTypes: ['ticket.created'],
  handle: async (context: HandlerContext) => {
    const event = context.event.event;
    if (event.type !== 'ticket.created') {
      return;
    }
    const { payload } = event;
    const projectId = payload.project_id;
    const ticket = payload.ticket;

    const refusal = await lintRefusal(options, context.scope.tx, projectId, ticket);
    if (refusal !== null) {
      return;
    }
    const data: PipelineOutboundData = {
      duty: 'ticket_lint_check',
      project_id: projectId,
      cause_event_id: event.id,
      ticket,
    };
    context.afterCommit(async () => {
      await enqueueOutbound(options.jobs, data);
    });
  },
});

/**
 * `task.stage.completed` → post the comment.
 *
 * Priority **120**, the integrations band (TD-005), beside the workpad render and review-only's own
 * posting handler: the stage executor at 10 has already stored the artifact and moved the task, and
 * posting is an outbound call that must not run inside the core band's transaction.
 */
export const ticketLintPostHandler = (options: PipelineSagaOptions): EventHandler => ({
  name: 'pipeline.ticket.lint.post',
  priority: 120,
  eventTypes: ['task.stage.completed'],
  handle: async (context: HandlerContext) => {
    const event = context.event.event;
    if (event.type !== 'task.stage.completed' || event.payload.stage !== TICKET_LINT_STAGE) {
      return;
    }
    const stored = await options.store.tasks.load(context.scope.tx, event.payload.task_id);
    if (stored === null || stored.task.template !== TICKET_LINT_TEMPLATE_ID) {
      return;
    }
    const data: PipelineOutboundData = {
      duty: 'ticket_lint_post',
      project_id: stored.task.projectId,
      task_id: stored.task.id,
      cause_event_id: event.id,
    };
    context.afterCommit(async () => {
      await enqueueOutbound(options.jobs, data);
    });
  },
});

// ── The duties ───────────────────────────────────────────────────────────────

/**
 * `pipeline.outbound` duty **ticket_lint_check**: ask the provider, then create the task.
 *
 * The shape of `runIntakeCheck` and `runReviewOnlyCheck`: read (the dedup, in a transaction of its
 * own), call (one ticket read, in none), write (create and start, in one transaction). It
 * **re-validates on fire** (TD-004), so a wake-up that arrives twice finds the lint task and returns,
 * and every refusal is logged with its reason, because "nothing happened" is the normal outcome and
 * an operator still has to be able to read why (standing rule 18).
 *
 * **What re-validating means here, and it is both of {@link lintRefusal}'s questions** (WP-25 round
 * 2). The first version asked only "has this ticket been linted?", which left the delivery question
 * answered exactly once — in a handler that runs *before* `intake_check` has created the task (see
 * {@link ticketLintHandler}). The measured consequence, on a project that picks tickets up by
 * `pickup_status` or by a `pickup_label` that is not `features.ticket_linter.label`: two tasks for
 * one ticket, a charged lint run, and a comment on a ticket the pipeline was already delivering
 * asking its author to add a label so that it would be. Asked here it is answered against the state
 * the job finds, which is the state that matters.
 *
 * **The residual, stated rather than implied.** The second ask is inside the create transaction, so
 * a delivery task committed before it is seen. What it cannot see is a delivery task committed
 * *after* it — `intake_check` and `ticket_lint_check` are both `pipeline.outbound` duties, and on a
 * single process they are serial in enqueue order with intake first (its event has the lower
 * position and its handler committed first), so the window needs **two** processes working the
 * queue at once. Then the lint task exists and its comment is posted. A third ask in
 * {@link runTicketLintPost} would close that too and was not taken: it trades the comment for a run
 * that was charged and says nothing, for an interleaving a single-process instance does not have.
 */
export const runTicketLintCheck = async (
  options: TicketLintOptions,
  data: PipelineOutboundData,
): Promise<void> => {
  const logger = options.logger ?? silentLogger;
  const projectId = data.project_id as Id;
  const causeEventId = data.cause_event_id as Id;
  if (data.ticket === undefined) {
    logger.warn({ project_id: projectId }, 'ticket lint: the wake-up named no ticket');
    return;
  }
  // The job payload is a wire boundary like any other, and the ticket in it is provider text —
  // parsed, as `runIntakeCheck` parses the same field, never cast.
  const source: TicketRefInput = ticketRefSchema.parse(data.ticket);
  const lintTicket: TicketRef = {
    provider: TICKET_LINT_TICKET_PROVIDER,
    key: lintTicketKeyFor(source.key),
    url: source.url,
  };

  const settle = (reason: string): void => {
    logger.debug(
      { project_id: projectId, ticket_key: source.key, reason },
      'ticket lint: nothing to do',
    );
  };

  const refusal = await options.unitOfWork.transaction(async (scope) =>
    lintRefusal(options, scope.tx, projectId, source),
  );
  if (refusal !== null) {
    settle(refusal);
    return;
  }

  const settings = await options.settings.forProject(projectId);
  const feature = resolveTicketLintSettings(settings);
  if (!feature.enabled) {
    settle('the ticket readiness linter is not enabled for this project');
    return;
  }

  // Outside a run, so the call's scope holds no minted credential (Q55); outside every transaction,
  // which `integrationsForProject` refuses to be otherwise.
  const integrations = await integrationsForProject(
    options.integrations,
    projectId,
    noRunScopedSecrets(),
  );
  const binding = integrations.taskManagement;
  if (binding === null) {
    settle('the project has no task-management binding');
    return;
  }
  // One read, two answers: the filter's (issue type, labels) and the prompt's (the words). A
  // provider failure **throws** here and fails the job — see the module docblock.
  const ticket: Ticket | null = await ticketReads(integrations).ticket(source, {
    projectId,
    taskId: null,
  });
  if (ticket === null) {
    settle('the ticket could not be read');
    return;
  }
  const match = ticketMatchesLintFilter(feature, {
    issueType: ticket.issue_type,
    labels: ticket.labels,
  });
  if (!match.matched) {
    settle(match.reason);
    return;
  }
  const snapshot = boundTicketSnapshot(ticket, binding.redactor);

  // The transaction answers *why* it did nothing rather than a bare `null`, so a refusal it decides
  // is logged with its reason like every other one (standing rule 18).
  const outcome = await options.unitOfWork.transaction(async (scope) => {
    // Asked again, against the state *inside* the write's own transaction: everything between the
    // first ask and here is I/O — a settings read, a binding load and a call to the provider — and
    // the delivery task this refuses is created by another job (TD-004, and the docblock above).
    const again = await lintRefusal(options, scope.tx, projectId, source);
    if (again !== null) {
      return { kind: 'refused' as const, reason: again };
    }
    const commandContext = {
      ids: options.ids,
      actor: actorFor(),
      clock: options.clock as never,
      correlationId: null,
      causeEventId,
    };
    const created = createTask(
      {
        id: options.ids.next(),
        projectId,
        ticket: lintTicket,
        template: TICKET_LINT_TEMPLATE_ID,
        mode: 'normal',
        limits: resolveIterationLimits(settings.config.pipeline?.limits),
      },
      commandContext,
    );
    const stored: StoredTask = {
      task: created.aggregate,
      template: settings.templates[TICKET_LINT_TEMPLATE_ID] as StoredTask['template'],
      priorityRank: priorityRankOf(null),
      createdAt: options.clock.now(),
      branch: null,
      mr: null,
      workpad: null,
      costActualUsd: 0,
      estimateUsd: null,
      estimateBasis: null,
      estimateSamples: null,
      version: INITIAL_TASK_VERSION,
      // Written by the insert that creates the row, so no `update tasks` statement names the
      // column and PROGRESS backlog 18's lost-update class cannot reach it.
      ticketSnapshot: snapshot,
      ticketSnapshotAt: options.clock.now() as IsoDateTime,
      reviewSubject: null,
      historySample: null,
      // A lint task posts one comment and opens no merge request (WP-37).
      riskClasses: [],
      coverage: null,
      dependencies: null,
      requiredReviewers: null,
      requestedByUserId: null,
    };
    await options.store.tasks.insert(scope.tx, stored);

    /**
     * **No WIP admission and no protected-branch check**, for the reasons `runReviewOnlyCheck`
     * gives: the branch check exists because an agent is given a push credential (Q40) and a lint
     * pushes nothing, and a queued lint task has no producer to dequeue it. What bounds the spend is
     * the budget guard every run goes through and `DEFAULT_STAGE_RUN_BUDGET_USD.ticket_lint`.
     */
    const pipeline = compilePipeline(stored.task.template, stored.template);
    const applied = await applyDecision({
      store: options.store,
      pipeline,
      tx: scope.tx,
      stored,
      decision: interpret(pipeline, { kind: 'start' }),
      context: { ...commandContext, correlationId: stored.task.id },
      causedByEventId: causeEventId,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
    await scope.events.append([...created.events, ...applied.events]);
    return { kind: 'started' as const, work: applied.work };
  });

  if (outcome.kind === 'refused') {
    settle(outcome.reason);
    return;
  }
  if (outcome.work === null) {
    return;
  }
  logger.info(
    { project_id: projectId, ticket_key: source.key, reason: match.reason },
    'ticket lint: linting',
  );
  await enqueueStage(options.jobs, outcome.work);
};

/**
 * `pipeline.outbound` duty **ticket_lint_post**: score the artifact, post the one comment, record
 * the metric's baseline.
 *
 * The spec is read from the stored artifact rather than from the payload, because a job is a wake-up
 * and not a message (TD-004). The comment carries {@link lintCommentIdempotencyKey}, so a redelivery
 * replays instead of adding a second comment.
 *
 * **The event is appended even when the call replayed**, which is the same at-least-once residual
 * `runReviewOnlyObservation` states: a duplicate wake-up appends a second `task.lint.posted` with
 * the same numbers, and a consumer deduplicates on `task_id` — one lint task means one lint. The
 * alternative (append only when the provider was really called) trades a duplicate for a **lost**
 * metric whenever a job dies between the call and the append, and standing rule 20 puts a
 * notification on the fail-open side of that trade.
 */
export const runTicketLintPost = async (
  options: TicketLintOptions,
  data: PipelineOutboundData,
): Promise<void> => {
  const logger = options.logger ?? silentLogger;
  const taskId = data.task_id as Id;
  const stored = await options.unitOfWork.transaction(async (scope) =>
    options.store.tasks.load(scope.tx, taskId),
  );
  if (stored === null || stored.task.template !== TICKET_LINT_TEMPLATE_ID) {
    logger.debug({ task_id: taskId }, 'ticket lint: nothing to post');
    return;
  }
  const artifact = await options.unitOfWork.transaction(async (scope) =>
    options.store.artifacts.latest(scope.tx, taskId, 'RefinedSpec'),
  );
  if (artifact === null) {
    logger.warn({ task_id: taskId }, 'ticket lint: the stage produced no RefinedSpec');
    return;
  }
  const spec = artifact.data as TicketLintSpec;
  const readiness = scoreTicketReadiness(spec);
  const questions = selectLintQuestions(spec);

  const settings = await options.settings.forProject(stored.task.projectId);
  const feature = resolveTicketLintSettings(settings);
  const integrations = await integrationsForProject(
    options.integrations,
    stored.task.projectId,
    noRunScopedSecrets(),
  );
  if (integrations.taskManagement === null) {
    logger.warn({ task_id: taskId }, 'ticket lint: the project has no task-management binding');
    return;
  }
  // The **real** ticket, rebuilt from the lint task's own key and the binding that is live now —
  // the argument `addressed()` makes for a merge request, applied to a ticket.
  const ticket: TicketRefInput = {
    provider: integrations.taskManagement.ref.provider,
    key: ticketKeyOfLintTask(stored.task.ticket.key),
    url: stored.task.ticket.url,
  };
  const posted = await ticketWrites(integrations).lintComment(
    ticket,
    renderLintComment({ readiness, questions, label: feature.label }),
    {
      projectId: stored.task.projectId,
      taskId: stored.task.id,
      mode: stored.task.mode,
      idempotencyKey: lintCommentIdempotencyKey(stored.task.id),
      markerId: LINT_COMMENT_MARKER_ID,
    },
  );
  if (posted === null) {
    return;
  }

  await options.unitOfWork.transaction(async (scope) => {
    // Re-loaded inside the transaction: `task.sequence` is the next `stream_seq` and the log
    // refuses one that is not `last + 1`, so it has to be read where the append happens.
    const current = await options.store.tasks.load(scope.tx, taskId);
    if (current === null) {
      return;
    }
    await scope.events.append([
      buildEvent(
        'task.lint.posted',
        {
          project_id: current.task.projectId,
          task_id: current.task.id,
          ticket,
          score: readiness.score,
          missing: [...readiness.missing],
          questions_posted: questions.length,
          ticket_updated_at: current.ticketSnapshot?.ticket_updated_at ?? null,
        },
        {
          streamType: 'task',
          streamId: current.task.id,
          streamSeq: current.task.sequence,
        },
        {
          ids: options.ids,
          actor: actorFor(),
          clock: options.clock as never,
          correlationId: current.task.id,
          causeEventId: data.cause_event_id as Id,
        },
      ),
    ]);
  });
  logger.info(
    {
      task_id: stored.task.id,
      ticket_key: ticket.key,
      score: readiness.score,
      questions: questions.length,
    },
    'ticket lint: comment posted',
  );
};

/** Every handler this mode registers, in one place for the runtime to spread. */
export const ticketLintHandlers = (options: PipelineSagaOptions): readonly EventHandler[] => [
  ticketLintHandler(options),
  ticketLintPostHandler(options),
];

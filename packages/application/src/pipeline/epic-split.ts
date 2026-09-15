/**
 * The spike template's ending and its epic-split variant — product/04:117 (WP-40).
 *
 * > *"Research/analysis tickets: `Intake → Refinement → Architecture (produces a document instead of
 * > a plan) → Human`. Output is a markdown report attached to the ticket and stored in the KB under
 * > `research/`. No MR. Variant **epic split** (opt-in): the input is an epic and the output is a
 * > proposed ticket breakdown with acceptance criteria for the PM to accept."*
 *
 * The templates themselves are data (`packages/domain/src/pipeline/templates.ts`). This module is
 * what happens after their one document-producing stage finishes, and it is two different endings
 * that share a shape:
 *
 *  - **spike** → the report is attached to the ticket (a `pipeline.outbound` duty, through
 *    `IntegrationActionExecutor` like every other provider call) and the page is queued for the
 *    knowledge base under `research/` (`knowledge/research.ts`). The task then **rests** at
 *    `human_review`, which is product/04's last arrow.
 *  - **epic_split** → the children are written to a queue, one row each, and **nothing is created**
 *    until a human decides. `POST /api/tasks/:id/breakdown/decide` is that decision, the
 *    `breakdown_create` duty is what files the accepted ones, and the task leaves `human_review`
 *    only when no child is still waiting.
 *
 * ## Why the queue is written by a handler and the tickets by a job
 *
 * The queue write is a **database** write derived from an artifact the same dispatch already
 * stored, so it belongs in the handler's transaction: `handler_executions` claims `(position,
 * handler)`, which makes it exactly-once without a key of its own, and a wake-up that went missing
 * would leave a task parked at a human stage with an empty queue and no way back. The **ticket
 * creation** is a provider call and therefore cannot happen in a handler at all (WP-15d); it is a
 * `pipeline.outbound` duty keyed per child, so a replay files each ticket once.
 *
 * ## What is redacted where, stated rather than implied
 *
 * `ticket_breakdown_items` is **stored external text** — model output over an untrusted epic, plus
 * a human's free text on the decision — so it is redacted at the write like the other five sinks
 * (`inbox`, `kb_chunks`, `tasks.ticket_snapshot`, `tasks.review_subject`, `task_asks`), and the
 * count rides on the row. {@link redactBreakdownChild} does the model's fields when the queue is
 * written and {@link decideBreakdown} does the `reason` when a human decides; both use **the
 * platform's** redactor, which the composition root supplies and which is required rather than
 * optional (standing rule 31: an optional security dependency is an absent one).
 *
 * **What that is and is not.** It is TD-012 **step 2**, the pattern rules. Step 1 — the exact
 * values of the project's own binding credentials — is the *binding's* redactor, and this writer
 * cannot have one: the queue is written inside the dispatcher's transaction, where resolving a
 * project's integrations is refused by construction (`events/open-transaction.ts`, WP-15d). So a
 * binding credential a model echoed back is still in the row and is removed at the write into
 * somebody else's system, which is where the binding's redactor lives:
 * `ticketWrites.createChildTicket` for a child and `ticketWrites.reportComment` for the report —
 * the same division `reviewWrites.thread`, `lintComment` and `IntegrationActionExecutor`'s own
 * audit row make. Both halves are asserted with a planted credential apiece
 * (`pipeline/epic-split.test.ts` › "redacts every model-written field of a queued child, and counts
 * it", "files one ticket per accepted child, under the parent, and none twice"), and the second one
 * is what would still be measuring if the first ever redacted everything.
 *
 * The residual, stated: `artifacts.data` keeps the **unredacted** copy of the same words (PROGRESS
 * backlog **35**, which names artifacts as a TD-012 write list nobody applied). This row is no
 * longer a projection of that one, and closing the artifact is that backlog entry's, not this
 * module's.
 */
import type {
  Actor,
  BreakdownChild,
  Id,
  IsoDateTime,
  ResearchReportData,
  TicketBreakdownData,
  TicketRef,
} from '@platform/contracts';
import {
  MAX_BREAKDOWN_CHILDREN,
  MAX_BREAKDOWN_DESCRIPTION_CHARS,
  MAX_BREAKDOWN_TITLE_CHARS,
  researchReportDataSchema,
  ticketBreakdownDataSchema,
} from '@platform/contracts';
import {
  buildEvent,
  childTicketTitle,
  compilePipeline,
  EPIC_SPLIT_TEMPLATE_ID,
  interpret,
  renderChildDescription,
  SPIKE_HUMAN_STAGE,
  SPIKE_TEMPLATE_ID,
} from '@platform/domain';
import type { EventHandler, HandlerContext } from '../events/handler.js';
import type { SecretRedactor } from '../ports/integrations/audit.js';
import type { TicketDraft, TicketRefInput } from '../ports/integrations/task-management.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { integrationsForProject, noRunScopedSecrets, ticketWrites } from './integrations.js';
import { enqueueOutbound, type PipelineOutboundData } from './jobs.js';
import type { PipelineSagaOptions } from './saga.js';
import { resolveEpicSplitSettings } from './settings.js';
import { PIPELINE_ACTOR, type PipelineStore, type StoredBreakdownItem } from './store.js';
import { retryOnTaskConflict } from './task-conflict.js';
import { applyDecision } from './transitions.js';

/**
 * The stage both spike templates produce their document in.
 *
 * It is `architecture` rather than a stage id of its own, which is `SPIKE_TEMPLATE`'s decision and
 * the opposite of `TICKET_LINT_TEMPLATE`'s — the reasons are written at both templates. The
 * consequence here is that *the template* is what tells the two endings apart, never the stage.
 */
export const SPIKE_DOCUMENT_STAGE = 'architecture';

/**
 * The marker on the report comment, in the platform's provider-agnostic dialect.
 *
 * A marker does the second job it does for the linter's comment: a comment the platform wrote is
 * recognisable, so `boundTicketSnapshot` skips it and a later Refinement is never shown the
 * platform's own report as if a human had written it. It carries the **attempt**, because a spike
 * that returned to refinement and ran again has a new report to post rather than an old one to
 * replay.
 */
export const spikeReportMarkerFor = (taskId: Id, attempt: number): string =>
  `agentic:spike-report:${taskId}:${attempt}`;

/**
 * The comment's idempotency key — the task and the architecture **attempt**, and nothing else.
 *
 * No part of it is model output and no part of it is provider text, so `idempotencyScopeFor` has
 * nothing to refuse (the rule WP-24's review round 2 earned). What it costs is stated: if the same
 * attempt is re-run by hand, the comment keeps the first run's words, which is the fail-closed
 * direction for a mutation on somebody else's ticket (standing rule 20).
 */
export const spikeReportIdempotencyKey = (taskId: Id, attempt: number): string =>
  `spike_report:${taskId}:${attempt}`;

/**
 * One accepted child's idempotency key — **the queue row's own id**, which the platform minted.
 *
 * The row is the identity of the decision, so a redelivered `breakdown_create` wake-up, a second
 * decision that somehow reached the same row, and a job retried after the provider already answered
 * all replay the first ticket instead of filing a second one in somebody's backlog.
 */
export const childTicketIdempotencyKey = (itemId: Id): string => `epic_split_child:${itemId}`;

// ── The report ───────────────────────────────────────────────────────────────

/** A ticket key as a file-name component: everything outside the safe set becomes a hyphen. */
const pathSafe = (value: string): string =>
  value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'spike';

/**
 * Where the report is stored in the vault — product/04:117's *"stored in the KB under `research/`"*.
 *
 * **The path is the platform's, never the model's.** `LibrarianProposals` lets a model choose
 * `target_path` and `curateProposals` then refuses anything outside the vault; here there is nothing
 * to refuse, because the only thing that varies is the ticket key and it is folded to
 * `[A-Za-z0-9._-]` first. A model that could name the page could name `research/../../ci.yml`, and
 * a refusal a human has to read in a queue is worse than a path a model never had.
 */
export const researchPagePath = (ticket: Pick<TicketRef, 'key'>): string =>
  `research/${pathSafe(ticket.key)}.md`;

const bullets = (items: readonly string[]): readonly string[] => items.map((item) => `- ${item}`);

/**
 * The report a human reads, as markdown.
 *
 * **The platform writes every heading and the model writes every sentence under one.** That
 * division is `renderLintComment`'s and it is what makes the length of this document a property of
 * this function plus the artifact's own caps, rather than a hope about a model: the artifact bounds
 * the question, the summary, each finding, each option and the recommendation, and nothing here
 * adds an unbounded string.
 *
 * It is the **same bytes** for the ticket comment and for the knowledge page, deliberately: two
 * renderings of one report is two documents a reader has to reconcile.
 */
export const renderResearchReport = (input: {
  readonly report: ResearchReportData;
  readonly ticketKey: string;
}): string => {
  const findings = input.report.findings.flatMap((finding) => [
    `- **${finding.statement}** (confidence: ${finding.confidence})`,
    ...finding.evidence.map((evidence) => `  - evidence: ${evidence}`),
  ]);
  const options = input.report.options.flatMap((option) => [
    `### ${option.option} (effort: ${option.effort})`,
    ...(option.pros.length === 0 ? [] : ['For:', ...bullets(option.pros)]),
    ...(option.cons.length === 0 ? [] : ['Against:', ...bullets(option.cons)]),
  ]);
  const questions = input.report.open_questions.map(
    (question) => `- ${question.text}${question.blocking ? ' *(blocking)*' : ''}`,
  );
  return [
    `# Spike: ${input.ticketKey}`,
    '',
    `**Question**: ${input.report.question}`,
    '',
    input.report.summary,
    ...(findings.length === 0 ? [] : ['', '## What was established', ...findings]),
    ...(options.length === 0 ? [] : ['', '## Options weighed', ...options]),
    '',
    '## Recommendation',
    input.report.recommendation,
    ...(questions.length === 0 ? [] : ['', '## Still open', ...questions]),
    '',
    'Produced by the Agentic platform. No merge request was opened and no code was changed.',
  ].join('\n');
};

// ── The breakdown queue ──────────────────────────────────────────────────────

/**
 * Every model-authored string of one proposed child, redacted and then cut (WP-40 round 2).
 *
 * **Which strings, and why it is all of them.** The row is published by
 * `GET /api/tasks/:id/breakdown`, read by a PM deciding on it, and rendered into a ticket in
 * somebody else's tracker — and every field below travels that whole way. A redactor applied to
 * the description alone would be a redactor whose count under-reports the row it sits beside,
 * which is the one signal a redactor that stopped working leaves (migration 0024's note, and the
 * shape `redactAskAnswer` settled on at WP-31).
 *
 * **Which are deliberately left alone, so the omission is a decision.** `size` and
 * `validation.kind` are enums the contract fixes, and `position` is the platform's own counter.
 *
 * **Redact, then cut — in that order.** WP-30 measured why: a truncation applied first can publish
 * a prefix no rule matches (`glpat-FAKE`), while redacting first publishes the placeholder and
 * cuts *that*. The caps are the artifact schema's own, re-applied because a placeholder is often
 * longer than the value it replaced, so a title that arrived exactly at
 * `MAX_BREAKDOWN_TITLE_CHARS` comes out of the redactor past it. A criterion's clauses have no cap
 * in the schema that produced them, so none is invented here (standing rule 41).
 */
export const redactBreakdownChild = (
  child: BreakdownChild,
  redactor: SecretRedactor,
): { readonly child: BreakdownChild; readonly count: number } => {
  let count = 0;
  const clean = (value: string, cap?: number): string => {
    const redacted = redactor.redactText(value);
    count += redacted.count;
    return cap === undefined ? redacted.value : redacted.value.slice(0, cap);
  };
  return {
    child: {
      title: clean(child.title, MAX_BREAKDOWN_TITLE_CHARS),
      description: clean(child.description, MAX_BREAKDOWN_DESCRIPTION_CHARS),
      acceptance_criteria: child.acceptance_criteria.map((criterion) => ({
        id: clean(criterion.id),
        given: clean(criterion.given),
        when: clean(criterion.when),
        // biome-ignore lint/suspicious/noThenProperty: the published acceptance-criterion field name
        then: clean(criterion.then),
        validation: { kind: criterion.validation.kind, value: clean(criterion.validation.value) },
      })),
      size: child.size,
      rationale: clean(child.rationale, MAX_BREAKDOWN_DESCRIPTION_CHARS),
    },
    count,
  };
};

/** One artifact child as a queue row. `position` is declaration order, which is the reading order. */
const itemFor = (input: {
  readonly id: Id;
  readonly projectId: Id;
  readonly taskId: Id;
  readonly runId: Id | null;
  readonly artifactId: Id;
  readonly position: number;
  readonly child: BreakdownChild;
  readonly redactor: SecretRedactor;
  readonly createdAt: IsoDateTime;
}): StoredBreakdownItem => {
  const safe = redactBreakdownChild(input.child, input.redactor);
  return {
    id: input.id,
    projectId: input.projectId,
    taskId: input.taskId,
    runId: input.runId,
    artifactId: input.artifactId,
    position: input.position,
    title: safe.child.title,
    description: safe.child.description,
    acceptanceCriteria: safe.child.acceptance_criteria,
    size: safe.child.size,
    rationale: safe.child.rationale,
    status: 'queued',
    decidedByUserId: null,
    decidedAt: null,
    reason: null,
    ticketKey: null,
    ticketUrl: null,
    redactionCount: safe.count,
    createdAt: input.createdAt,
  };
};

/**
 * The draft an accepted child becomes.
 *
 * Its model-written parts arrive **already redacted** by TD-012 step 2 (the row was written that
 * way) and pass through the binding's own exact-match redactor at the call, which is step 1 and is
 * the half only the binding can do. Both are live: the module note says which credential each
 * catches and why neither makes the other unreachable.
 */
export const draftFor = (input: {
  readonly item: StoredBreakdownItem;
  readonly parent: TicketRef;
  readonly issueType: string;
  readonly projectKey: string;
}): TicketDraft => ({
  project_key: input.projectKey,
  issue_type: input.issueType,
  title: childTicketTitle(input.item),
  description: renderChildDescription({
    child: {
      title: input.item.title,
      description: input.item.description,
      acceptance_criteria: [...input.item.acceptanceCriteria],
      size: input.item.size,
      rationale: input.item.rationale,
    },
    parentKey: input.parent.key,
  }),
  labels: [],
  parent_key: input.parent.key,
});

/**
 * The project key a child is filed under — the parent's own, read off its key.
 *
 * Jira's `ACME-12` and GitLab's `acme/api#12` both put the project on the left of the separator, so
 * the parent's prefix is the only answer that cannot be wrong for the epic it splits: filing a
 * child in a project the epic is not in would be the platform choosing somebody else's backlog.
 * A key with no separator is used whole, which is the fail-loud direction — the provider refuses an
 * unknown project rather than inventing one.
 */
export const projectKeyOf = (ticket: Pick<TicketRef, 'key'>): string => {
  const separator = ticket.key.lastIndexOf('-');
  return separator > 0 ? ticket.key.slice(0, separator) : ticket.key;
};

// ── Handlers ─────────────────────────────────────────────────────────────────

export interface EpicSplitOptions extends PipelineSagaOptions {
  readonly unitOfWork: UnitOfWork;
}

/**
 * {@link EpicSplitOptions} plus the redactor, for the one thing here that **stores** model text.
 *
 * Two types rather than one, because the requirement is not the module's but the *writer's*: the
 * two `pipeline.outbound` duties call a provider and redact at the call through the binding's own
 * redactor, while `breakdownQueueHandler` puts a model's words in a row of the platform's own and
 * therefore needs TD-012 step 2 in hand. Widening `EpicSplitOptions` instead would have made every
 * duty ask for a collaborator it does not use, which is how a required dependency becomes one
 * somebody passes `noSecretsRedactor()` to.
 */
export interface BreakdownQueueOptions extends EpicSplitOptions {
  /**
   * TD-012 step 2 over what the model wrote about somebody else's epic.
   *
   * Required and not defaulted, for {@link BreakdownCommandOptions.redactor}'s reason: the queue
   * this writes is published, decided on and turned into tickets, and an optional security
   * dependency is an absent one (standing rule 31).
   */
  readonly redactor: SecretRedactor;
}

/**
 * What {@link decideBreakdown} needs, and **nothing more**.
 *
 * Narrower than {@link EpicSplitOptions} on purpose: the decision is served by every process that
 * serves the API, including one that composes no pipeline at all, and it genuinely needs no queue,
 * no settings port and no integrations — it moves rows and appends an event, and the event's
 * handler on a worker is what turns that into `createTicket` calls. A command that demanded the
 * whole saga's collaborators would have made an API-only deployment unable to accept a breakdown
 * for no reason it could state.
 */
export interface BreakdownCommandOptions {
  readonly store: Pick<PipelineStore, 'tasks' | 'breakdown'>;
  readonly unitOfWork: UnitOfWork;
  readonly ids: { next(): Id };
  readonly clock: { now(): string };
  /**
   * TD-012 over the human's own words about the decision.
   *
   * Required rather than optional, like `TaskCommandDependencies.redactor` and for the same
   * reason: `reason` is stored on every row this command moves and published by
   * `GET /api/tasks/:id/breakdown`, and a redactor a caller could leave out is one no caller
   * supplies (standing rule 31). The composition root passes the same pattern redactor
   * `routes/commands.ts` gets.
   */
  readonly redactor: SecretRedactor;
  readonly logger?: Logger;
}

const actorFor = (): Actor => PIPELINE_ACTOR;

/**
 * `task.stage.completed` on a **spike**'s document stage → attach the report.
 *
 * Priority **120**, the integrations band (TD-005), beside the workpad render and the linter's own
 * posting handler: the stage executor at 10 has already stored the artifact and moved the task, and
 * posting is an outbound call that must not run inside the core band's transaction.
 */
export const spikeReportHandler = (options: PipelineSagaOptions): EventHandler => ({
  name: 'pipeline.spike.report',
  priority: 120,
  eventTypes: ['task.stage.completed'],
  handle: async (context: HandlerContext) => {
    const event = context.event.event;
    if (event.type !== 'task.stage.completed' || event.payload.stage !== SPIKE_DOCUMENT_STAGE) {
      return;
    }
    const stored = await options.store.tasks.load(context.scope.tx, event.payload.task_id);
    if (stored === null || stored.task.template !== SPIKE_TEMPLATE_ID) {
      return;
    }
    const data: PipelineOutboundData = {
      duty: 'spike_report',
      project_id: stored.task.projectId,
      task_id: stored.task.id,
      cause_event_id: event.id,
      stage: SPIKE_DOCUMENT_STAGE,
    };
    context.afterCommit(async () => {
      await enqueueOutbound(options.jobs, data);
    });
  },
});

/**
 * `task.stage.completed` on an **epic split**'s document stage → write the queue.
 *
 * Priority **20**, the core band and behind the pipeline's own transitions (10): the executor has
 * stored the artifact by then and the saga has moved the task to `human_review`, which is the state
 * this queue is the content of. It reads one artifact and inserts rows — no provider, no settings,
 * no second connection — which is what makes it safe inside the dispatcher's transaction.
 *
 * It is **exactly-once without a key of its own**: `handler_executions` claims `(position,
 * handler)`, so a redelivered dispatch writes nothing twice, and a handler that throws is re-run
 * whole in a new transaction with nothing of the failed attempt left behind.
 *
 * An artifact with **no children** writes no rows and is not an error: a model that could not split
 * an epic has said something, and the task rests at `human_review` with an empty queue for a human
 * to read the artifact and decide. That is different from a run that failed, and the log line says
 * which one happened (standing rule 16).
 */
export const breakdownQueueHandler = (options: BreakdownQueueOptions): EventHandler => ({
  name: 'pipeline.epic.split.queue',
  priority: 20,
  eventTypes: ['task.stage.completed'],
  handle: async (context: HandlerContext) => {
    const event = context.event.event;
    if (event.type !== 'task.stage.completed' || event.payload.stage !== SPIKE_DOCUMENT_STAGE) {
      return;
    }
    const logger = options.logger ?? silentLogger;
    const stored = await options.store.tasks.load(context.scope.tx, event.payload.task_id);
    if (stored === null || stored.task.template !== EPIC_SPLIT_TEMPLATE_ID) {
      return;
    }
    const artifact = await options.store.artifacts.latest(
      context.scope.tx,
      stored.task.id,
      'TicketBreakdown',
    );
    if (artifact === null) {
      logger.warn(
        { task_id: stored.task.id },
        'epic split: the stage produced no TicketBreakdown, so nothing was queued',
      );
      return;
    }
    // Re-validated although the runner validated it on the way in: this row may have been written
    // by an older build, and a strict parse is what makes every field below a value the schema
    // admits rather than whatever JSON is in the column (BD-022).
    const parsed = ticketBreakdownDataSchema.safeParse(artifact.data);
    if (!parsed.success) {
      logger.warn(
        { task_id: stored.task.id, reason: parsed.error.issues[0]?.message ?? 'invalid' },
        'epic split: the stored artifact does not match the TicketBreakdown schema',
      );
      return;
    }
    const breakdown: TicketBreakdownData = parsed.data;
    if (breakdown.children.length === 0) {
      logger.info(
        { task_id: stored.task.id },
        'epic split: the run proposed no child tickets; the task waits with an empty queue',
      );
      return;
    }
    const createdAt = options.clock.now() as IsoDateTime;
    const items = breakdown.children.slice(0, MAX_BREAKDOWN_CHILDREN).map((child, position) =>
      itemFor({
        id: options.ids.next(),
        projectId: stored.task.projectId,
        taskId: stored.task.id,
        runId: artifact.producedByRunId,
        artifactId: artifact.id,
        position,
        child,
        redactor: options.redactor,
        createdAt,
      }),
    );
    await options.store.breakdown.insert(context.scope.tx, items);
    logger.info(
      {
        task_id: stored.task.id,
        children: items.length,
        // The row's own signal, summed over the queue: a redactor that stopped working leaves no
        // other trace (migration 0024's note, and `redactBreakdownChild`'s).
        redactions: items.reduce((total, item) => total + item.redactionCount, 0),
      },
      'epic split: the proposed breakdown is queued for a human',
    );
  },
});

/**
 * `task.breakdown.decided` → file what was accepted, and end the task when nothing is left.
 *
 * Priority **10**, the core band, because it moves the task. Two things happen and the order is the
 * point:
 *
 *  - **the step is conditional on `remaining === 0`.** The template says this event is what ends
 *    `human_review`; *this handler* decides whether this particular decision was the last one, so a
 *    PM who accepts five of seven children leaves the task exactly where they found it and can come
 *    back to the other two. A template cannot express that, because a template has no idea how many
 *    rows are queued.
 *  - **the creation is enqueued after the commit** (TD-004), because it is a provider call and a
 *    handler may not make one (WP-15d).
 */
export const breakdownDecidedHandler = (options: EpicSplitOptions): EventHandler => ({
  name: 'pipeline.epic.split.decided',
  priority: 10,
  eventTypes: ['task.breakdown.decided'],
  handle: async (context: HandlerContext) => {
    const event = context.event.event;
    if (event.type !== 'task.breakdown.decided') {
      return;
    }
    const { payload } = event;
    const stored = await options.store.tasks.load(context.scope.tx, payload.task_id);
    if (stored === null || stored.task.template !== EPIC_SPLIT_TEMPLATE_ID) {
      return;
    }
    if (payload.accepted > 0) {
      const data: PipelineOutboundData = {
        duty: 'breakdown_create',
        project_id: stored.task.projectId,
        task_id: stored.task.id,
        cause_event_id: event.id,
      };
      context.afterCommit(async () => {
        await enqueueOutbound(options.jobs, data);
      });
    }
    if (payload.remaining > 0 || stored.task.currentStage !== SPIKE_HUMAN_STAGE) {
      return;
    }
    const pipeline = compilePipeline(stored.task.template, stored.template);
    const applied = await applyDecision({
      store: options.store,
      pipeline,
      tx: context.scope.tx,
      stored,
      decision: interpret(pipeline, {
        kind: 'event',
        stage: SPIKE_HUMAN_STAGE,
        event: 'task.breakdown.decided',
        detail: `${payload.accepted} accepted, ${payload.rejected} rejected`,
      }),
      context: {
        ids: options.ids,
        actor: actorFor(),
        clock: options.clock as never,
        correlationId: stored.task.id,
        causeEventId: event.id,
      },
      causedByEventId: event.id,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
    await context.scope.events.append(applied.events);
  },
});

export const epicSplitHandlers = (options: BreakdownQueueOptions): readonly EventHandler[] => [
  spikeReportHandler(options),
  breakdownQueueHandler(options),
  breakdownDecidedHandler(options),
];

// ── The command ──────────────────────────────────────────────────────────────

export type BreakdownDecision = 'accept' | 'reject';

export interface DecideBreakdownResult {
  readonly accepted: number;
  readonly rejected: number;
  readonly remaining: number;
}

/**
 * A decision the platform will not make — the task is not an epic split, or nothing it named is
 * still waiting.
 *
 * `reason` is assigned in the body rather than declared as a **parameter property**, and that is a
 * hard requirement rather than a style: `apps/server` and `apps/runlet` run this source through
 * Node's type stripping (`scripts/ts-source-resolver.mjs`), which refuses a parameter property with
 * `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` — a whole process that would not boot, caught here only
 * because `runlet/conformance.contract.test.ts` starts the real shim.
 */
export class BreakdownRefusedError extends Error {
  override readonly name = 'BreakdownRefusedError';
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

/**
 * The PM's decision — product/04:117's *"for the PM to accept"*, as one command (WP-40, Q85).
 *
 * One transaction: the rows move, the event is appended, and the handler above reads both. Three
 * refusals, each by name rather than as a silent no-op:
 *
 *  - the task is not an epic split — *"there is nothing here to decide"*;
 *  - none of the named rows is still queued — which is the answer a **replay that lost its
 *    `Idempotency-Key`** gets, and it is a 409 rather than a success, because telling a caller
 *    "accepted" about rows somebody else decided would make the count they are shown a fiction;
 *  - the task does not exist.
 *
 * **The reason is redacted here** (TD-012), because here is where it is stored: the route bounds it
 * with `decideBreakdownRequestSchema` and has no redactor, and a stored copy of untrusted human
 * text is TD-012's business wherever it came from — the answer `returnTaskToStage` and
 * `answerTaskQuestion` already give their own free text. The count goes onto the rows the decision
 * moved, adding to what the model's fields already cost.
 *
 * The **countable effect** is the rows: N accepted children become N `createTicket` calls, and the
 * `queued` predicate lives in the repository's own statement so two maintainers deciding the same
 * child at the same instant cannot both win.
 */
export const decideBreakdown = async (
  options: BreakdownCommandOptions,
  input: {
    readonly taskId: Id;
    readonly itemIds: readonly Id[];
    readonly decision: BreakdownDecision;
    readonly userId: Id;
    readonly reason: string | null;
  },
): Promise<DecideBreakdownResult> =>
  retryOnTaskConflict(
    {
      taskId: input.taskId,
      what: 'deciding a proposed ticket breakdown',
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    },
    async () =>
      options.unitOfWork.transaction(async (scope) => {
        const stored = await options.store.tasks.load(scope.tx, input.taskId);
        if (stored === null) {
          throw new BreakdownRefusedError(`task ${input.taskId} does not exist`);
        }
        if (stored.task.template !== EPIC_SPLIT_TEMPLATE_ID) {
          throw new BreakdownRefusedError(
            `task ${input.taskId} is on the "${stored.task.template}" template, which proposes no ticket breakdown`,
          );
        }
        // TD-012 before the write, not at a transport: this is the only place the words are
        // stored, and the count rides on the same rows they land on.
        const reason =
          input.reason === null
            ? { value: null, count: 0 }
            : options.redactor.redactText(input.reason);
        const moved = await options.store.breakdown.decide(scope.tx, {
          taskId: input.taskId,
          itemIds: input.itemIds,
          status: input.decision === 'accept' ? 'accepted' : 'rejected',
          decidedByUserId: input.userId,
          decidedAt: options.clock.now() as IsoDateTime,
          reason: reason.value,
          reasonRedactions: reason.count,
        });
        if (moved.length === 0) {
          throw new BreakdownRefusedError(
            'none of the named children is still waiting for a decision',
          );
        }
        const all = await options.store.breakdown.listForTask(scope.tx, input.taskId);
        const result: DecideBreakdownResult = {
          accepted: input.decision === 'accept' ? moved.length : 0,
          rejected: input.decision === 'reject' ? moved.length : 0,
          remaining: all.filter((item) => item.status === 'queued').length,
        };
        await scope.events.append([
          buildEvent(
            'task.breakdown.decided',
            {
              project_id: stored.task.projectId,
              task_id: stored.task.id,
              accepted: result.accepted,
              rejected: result.rejected,
              remaining: result.remaining,
            },
            {
              streamType: 'task',
              streamId: stored.task.id,
              streamSeq: stored.task.sequence,
            },
            {
              ids: options.ids,
              actor: { kind: 'user', user_id: input.userId },
              clock: options.clock as never,
              correlationId: stored.task.id,
              causeEventId: null,
            },
          ),
        ]);
        return result;
      }),
  );

// ── The duties ───────────────────────────────────────────────────────────────

/**
 * `pipeline.outbound` duty **spike_report**: attach the report and queue the page.
 *
 * The shape every duty has: read (in a transaction of its own), call (in none), and here the
 * knowledge page is queued by the **knowledge** ring's own job rather than written from here — see
 * `knowledge/research.ts`, which is where the vault path, the byte budget and BD-018's apply policy
 * already live.
 *
 * Every refusal is logged with its reason, because "nothing happened" is a normal outcome — a
 * project with no task-management binding runs spikes perfectly well and simply has nowhere to
 * attach the report (standing rule 18).
 */
export const runSpikeReport = async (
  options: EpicSplitOptions,
  data: PipelineOutboundData,
): Promise<void> => {
  const logger = options.logger ?? silentLogger;
  const taskId = data.task_id as Id;
  const stored = await options.unitOfWork.transaction(async (scope) =>
    options.store.tasks.load(scope.tx, taskId),
  );
  if (stored === null || stored.task.template !== SPIKE_TEMPLATE_ID) {
    logger.debug({ task_id: taskId }, 'spike report: nothing to post');
    return;
  }
  const artifact = await options.unitOfWork.transaction(async (scope) =>
    options.store.artifacts.latest(scope.tx, taskId, 'ResearchReport'),
  );
  if (artifact === null) {
    logger.warn({ task_id: taskId }, 'spike report: the stage produced no ResearchReport');
    return;
  }
  const parsed = researchReportDataSchema.safeParse(artifact.data);
  if (!parsed.success) {
    logger.warn(
      { task_id: taskId, reason: parsed.error.issues[0]?.message ?? 'invalid' },
      'spike report: the stored artifact does not match the ResearchReport schema',
    );
    return;
  }
  const attempt = stored.task.stageAttempts[SPIKE_DOCUMENT_STAGE] ?? 1;
  const markdown = renderResearchReport({
    report: parsed.data,
    ticketKey: stored.task.ticket.key,
  });

  // Outside a run, so the call's scope holds no minted credential (Q55); outside every transaction,
  // which `integrationsForProject` refuses to be otherwise.
  const integrations = await integrationsForProject(
    options.integrations,
    stored.task.projectId,
    noRunScopedSecrets(),
  );
  const posted = await ticketWrites(integrations).reportComment(stored.task.ticket, markdown, {
    projectId: stored.task.projectId,
    taskId: stored.task.id,
    mode: stored.task.mode,
    idempotencyKey: spikeReportIdempotencyKey(stored.task.id, attempt),
    markerId: spikeReportMarkerFor(stored.task.id, attempt),
  });
  logger.info(
    {
      task_id: stored.task.id,
      ticket_key: stored.task.ticket.key,
      attached: posted !== null,
      chars: markdown.length,
    },
    posted === null
      ? 'spike report: the project has no task-management binding, so the report was not attached'
      : 'spike report: attached to the ticket',
  );
};

/**
 * `pipeline.outbound` duty **breakdown_create**: file the accepted children.
 *
 * It re-derives what to do from committed state when it fires (TD-004): the rows that are
 * `accepted` and have **no ticket yet**. So a duplicate wake-up creates nothing — and even if two
 * fired at once, each child's `IdempotencyPlan` is keyed on the row's id, so the second replays the
 * first call's answer rather than filing a second ticket.
 *
 * **A binding without `createTicket` refuses by name and makes no call at all**
 * (`ticketWrites.createChildTicket` checks the capability), which is the same refusal
 * `epicSplitRouting` makes at intake — the task should never have reached this template on such a
 * project, and this is the second of the two guards rather than the only one.
 */
export const runBreakdownCreate = async (
  options: EpicSplitOptions,
  data: PipelineOutboundData,
): Promise<void> => {
  const logger = options.logger ?? silentLogger;
  const taskId = data.task_id as Id;
  const stored = await options.unitOfWork.transaction(async (scope) =>
    options.store.tasks.load(scope.tx, taskId),
  );
  if (stored === null || stored.task.template !== EPIC_SPLIT_TEMPLATE_ID) {
    logger.debug({ task_id: taskId }, 'epic split: nothing to file');
    return;
  }
  const pending = (
    await options.unitOfWork.transaction(async (scope) =>
      options.store.breakdown.listForTask(scope.tx, taskId),
    )
  ).filter((item) => item.status === 'accepted' && item.ticketKey === null);
  if (pending.length === 0) {
    logger.debug({ task_id: taskId }, 'epic split: every accepted child already has a ticket');
    return;
  }

  const settings = await options.settings.forProject(stored.task.projectId);
  const feature = resolveEpicSplitSettings(settings);
  const integrations = await integrationsForProject(
    options.integrations,
    stored.task.projectId,
    noRunScopedSecrets(),
  );
  const writes = ticketWrites(integrations);
  const projectKey = projectKeyOf(stored.task.ticket);

  let filed = 0;
  for (const item of pending) {
    const created: TicketRefInput | null = await writes.createChildTicket(
      draftFor({
        item,
        parent: stored.task.ticket,
        issueType: feature.childIssueType,
        projectKey,
      }),
      {
        projectId: stored.task.projectId,
        taskId: stored.task.id,
        mode: stored.task.mode,
        idempotencyKey: childTicketIdempotencyKey(item.id),
      },
    );
    if (created === null) {
      logger.warn(
        { task_id: stored.task.id, item_id: item.id },
        'epic split: this project’s task-management binding cannot create tickets, so nothing was filed',
      );
      return;
    }
    await options.unitOfWork.transaction(async (scope) => {
      await options.store.breakdown.recordTicket(scope.tx, {
        itemId: item.id,
        ticketKey: created.key,
        ticketUrl: created.url ?? null,
      });
    });
    filed += 1;
  }
  logger.info(
    { task_id: stored.task.id, filed, parent: stored.task.ticket.key },
    'epic split: accepted children filed as tickets',
  );
};

/**
 * Starting a shadow batch — product/18:24, product/19 §13, Q82 (WP-34).
 *
 * > *"Runs the pipeline on selected closed tickets … without opening MRs or commenting on tickets;
 * > produces spec, plan, diff and a comparison with the human MR"*
 *
 * ## A batch is N ordinary tasks, and there is no second entry point
 *
 * One `tasks` row per selected ticket, on the project's own ticket templates, with
 * `mode = 'shadow'`. Everything that makes a run safe and accounted for is then the machinery every
 * other run goes through: the admission guard, the cost ledger, the transcript sink, the budget cap,
 * the conflict retry and the `needs_human` escalation. `onboarding/discovery.ts` carries the long
 * version of that argument and this is the second row to take it.
 *
 * What makes the mode *mean* something is already built and had never been reached: `tasks.mode`
 * flows into `RunSpec.mode` through `runModeFor` (`pipeline/planner.ts`), and every mutating
 * provider call goes through `IntegrationActionExecutor`, which answers `would_have` before it
 * reaches idempotency or a provider (`integrations/action-executor.ts`). This module sets the bit;
 * it does not re-implement the guard, and it must not.
 *
 * ## The three refusals, and which question each answers
 *
 * **Whether the project may run a batch at all** is asked once, before anything is read:
 *
 *  - `features.shadow_mode.enabled` is BD-028's opt-in — *"Everything here is optional, off or
 *    conservative by default"* — and it is the switch the wizard's card writes. Off is
 *    `feature_disabled`.
 *  - the **dial's** `shadowMode` is the project's autonomy position, and it is what product/19 §11
 *    means by *"Observe | Shadow mode, ticket linter, review-only on human MRs"*: `shadowMode` is
 *    `true` at `observe` and `false` at the other three. A project at Supervised that turned the
 *    feature on is `shadow_not_allowed` — the feature key says *"this team wants it"* and the dial
 *    says *"this project is past it"*, which are different questions with different answers.
 *
 * These are the two policies PROGRESS backlog 72 (c) attributes to this row: this function is
 * `shadowMode`'s first reader, and `runIntakeCheck` is `picksUpNewTickets`'s.
 *
 * **Whether a particular ticket may be shadowed** is asked per ticket, and answers by name:
 *
 *  - `already_shadowed` — the project already has a shadow task for this key. `unique (project_id,
 *    ticket_key, mode)` is what actually decides, and this read is what turns the loser of a race
 *    into an answer rather than into a constraint violation.
 *  - `ticket_unreadable` — no task-management binding, or the provider does not know the key. A
 *    shadow run with no ticket text would be an agent started on an identifier.
 *  - `no_comparison_base` — **Q82 (a)**, and the one that costs a ticket on purpose. A human merge
 *    request was found and the provider publishes no merge base for it, so the only tree the run
 *    could start from is today's default branch; a Jaccard overlap between a diff written against
 *    that and a human diff written against the tree six months ago measures drift, and similarity
 *    is the number the whole feature exists to publish. *"Refusing costs one ticket out of ten;
 *    approximating publishes a similarity figure nobody can trust."*
 *
 * A ticket with **no** human merge request at all is **not** refused — Q82 (b) is explicit that it
 * still produces a report, with `human_mr: null` and no overlap block. There is then nothing for the
 * base to match, so the run starts from the default branch and the report says so.
 *
 * ## What this command deliberately does not judge
 *
 * **Whether a key names a *closed* ticket.** product/18:24 says *"selected closed tickets"* and
 * Q82 (c) keeps it to closed ones for 0.1, but the platform has no definition of "closed" that is
 * not a project's own status mapping — `ticket.status` is a provider string, and the only mapping
 * this build carries goes the other way (`pipeline.status_mapping`, platform state → provider
 * status). So the operator's selection is taken as the operator's, and the *mechanism* that keeps
 * Q82 (c)'s answer true is that this is the only way a shadow task can be created: nothing picks
 * new tickets up in shadow mode, because `picksUpNewTickets` and `shadowMode` are false and true at
 * exactly one dial position each and never at the same one.
 */
import type { Id, IsoDateTime, MergeRequestRef, PipelineTemplate } from '@platform/contracts';
import type { CommandContext } from '@platform/domain';
import { compilePipeline, createTask, interpret, resolveIterationLimits } from '@platform/domain';
import type { PipelineIntegrations, PipelineIntegrationsPort } from '../pipeline/integrations.js';
import {
  gitReads,
  integrationsForProject,
  noRunScopedSecrets,
  ticketReads,
} from '../pipeline/integrations.js';
import { enqueueStage } from '../pipeline/jobs.js';
import type { ProjectSettings, ProjectSettingsPort } from '../pipeline/settings.js';
import {
  autonomyPresetFor,
  DEFAULT_TEMPLATE_ID,
  templateForIssueType,
} from '../pipeline/settings.js';
import {
  INITIAL_TASK_VERSION,
  PIPELINE_ACTOR,
  type PipelineStore,
  type StoredTask,
} from '../pipeline/store.js';
import { applyDecision } from '../pipeline/transitions.js';
import type { Jobs } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { findHumanMergeRequest, type HumanMergeRequestMatch } from './human-merge-request.js';
import type { ShadowStore } from './ports.js';

/**
 * How far back the merge-request scan looks, and how many it reads.
 *
 * product/18's own wording is *"your last N tickets"* and product/19 §18's history bootstrap reads
 * *"the last N merged MRs (default 200, max 1 000)"* over *"closed tickets of the last 6 months"*.
 * Six months is therefore the window this platform already treats as "recent history" and 200 is
 * the page size it already treats as affordable, so both are reused rather than invented. The scan
 * is made **once per batch**, not once per ticket: ten tickets against one list is one request, and
 * a per-ticket scan would be ten pages of the same data.
 */
export const SHADOW_HISTORY_DAYS = 183;
export const SHADOW_HISTORY_LIMIT = 200;

export type ShadowBatchRefusal = 'already_shadowed' | 'ticket_unreadable' | 'no_comparison_base';

/** Why a whole batch was refused; per-ticket refusals are {@link ShadowBatchRefusal}. */
export type ShadowBatchBlocker = 'feature_disabled' | 'shadow_not_allowed' | 'no_templates';

export const SHADOW_BATCH_BLOCKED_DETAIL: Readonly<Record<ShadowBatchBlocker, string>> = {
  feature_disabled:
    'shadow mode is off for this project; turn it on in settings (features.shadow_mode.enabled) before starting a batch',
  shadow_not_allowed:
    'this project’s autonomy dial does not allow shadow runs; shadow mode is what the Observe position runs, and a project past it delivers for real instead',
  no_templates:
    'this project’s settings define no ticket template, so there is no pipeline to run a shadow task on',
};

const REFUSAL_DETAIL: Readonly<Record<ShadowBatchRefusal, string>> = {
  already_shadowed: 'this project already has a shadow task for this ticket',
  ticket_unreadable:
    'the task-management provider does not know this ticket, so a shadow run would have no ticket to read',
  no_comparison_base:
    'the human merge request for this ticket publishes no merge base, and a comparison against today’s default branch would measure drift rather than similarity (Q82)',
};

export interface ShadowBatchOptions {
  readonly unitOfWork: UnitOfWork;
  readonly store: PipelineStore;
  readonly shadow: ShadowStore;
  readonly settings: ProjectSettingsPort;
  readonly integrations: PipelineIntegrationsPort;
  readonly jobs: Jobs;
  readonly ids: { next(): Id };
  readonly clock: { now(): IsoDateTime };
  readonly logger?: Logger;
}

export interface ShadowBatchTicketOutcome {
  readonly ticketKey: string;
  readonly taskId: Id | null;
  readonly refusedReason: string | null;
}

export type StartShadowBatchResult =
  | {
      readonly status: 'started';
      readonly batchId: Id;
      readonly tickets: readonly ShadowBatchTicketOutcome[];
    }
  | { readonly status: 'blocked'; readonly blocker: ShadowBatchBlocker; readonly detail: string };

/**
 * Whether this project may start a batch, and the sentence to say when it may not.
 *
 * Exported because the **read** endpoint publishes it: a screen that offered a button and then
 * showed a 409 would be telling a maintainer the answer twice, once uselessly.
 */
export const shadowBatchBlocker = (settings: ProjectSettings): ShadowBatchBlocker | null => {
  const features = settings.config.features as
    | { readonly shadow_mode?: { readonly enabled?: boolean; readonly budget_usd?: number } }
    | undefined;
  if (features?.shadow_mode?.enabled !== true) {
    return 'feature_disabled';
  }
  // A dial that was never materialised is **not** "the supervised preset" (BD-027:14), and it is
  // not permission either: with no recorded position there is nothing that said shadow is what this
  // project runs, so the conservative answer is the same as the other three positions'.
  if (autonomyPresetFor(settings)?.shadowMode !== true) {
    return 'shadow_not_allowed';
  }
  return null;
};

/** `features.shadow_mode.budget_usd`, or `null`. The cap the batch records and the guard reads. */
export const shadowBudgetUsd = (settings: ProjectSettings): number | null => {
  const features = settings.config.features as
    | { readonly shadow_mode?: { readonly budget_usd?: number } }
    | undefined;
  const value = features?.shadow_mode?.budget_usd;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
};

const contextFor = (
  options: ShadowBatchOptions,
  correlationId: Id | null,
  actorUserId: Id | null,
): CommandContext => ({
  ids: options.ids,
  // The *command* is audited in `human_actions` by the route; the pipeline actor stamps the events,
  // because the task is the pipeline's from the moment it exists — `startProjectDiscovery`'s answer.
  actor: actorUserId === null ? PIPELINE_ACTOR : { kind: 'user' as const, user_id: actorUserId },
  clock: options.clock as CommandContext['clock'],
  correlationId,
  causeEventId: null,
});

/** What one ticket resolved to before anything is written. */
interface Resolved {
  readonly ticketKey: string;
  readonly refusal: ShadowBatchRefusal | null;
  readonly issueType: string | null;
  readonly ticketUrl: string | null;
  readonly match: HumanMergeRequestMatch | null;
}

export const startShadowBatch = async (
  options: ShadowBatchOptions,
  input: {
    readonly projectId: Id;
    readonly ticketKeys: readonly string[];
    readonly requestedByUserId: Id | null;
  },
): Promise<StartShadowBatchResult> => {
  const logger = options.logger ?? silentLogger;
  const { projectId } = input;
  const settings = await options.settings.forProject(projectId);

  const blocker = shadowBatchBlocker(settings);
  if (blocker !== null) {
    return { status: 'blocked', blocker, detail: SHADOW_BATCH_BLOCKED_DETAIL[blocker] };
  }
  if (settings.templates[DEFAULT_TEMPLATE_ID] === undefined) {
    return {
      status: 'blocked',
      blocker: 'no_templates',
      detail: SHADOW_BATCH_BLOCKED_DETAIL.no_templates,
    };
  }

  // Outside every transaction (WP-15d), and outside a run, so the call's scope holds no minted
  // credential (Q55). Resolved once for the whole batch: the loop below makes one ticket read each
  // and shares one merge-request listing.
  const integrations = await integrationsForProject(
    options.integrations,
    projectId,
    noRunScopedSecrets(),
  );
  const resolved = await resolveTickets(options, { projectId, integrations }, input.ticketKeys);

  const batchId = options.ids.next();
  const budgetUsd = shadowBudgetUsd(settings);

  const outcome = await options.unitOfWork.transaction(async (scope) => {
    await options.shadow.createBatch(scope.tx, {
      id: batchId,
      projectId,
      requestedBy: input.requestedByUserId,
      budgetUsd,
    });
    const tickets: ShadowBatchTicketOutcome[] = [];
    const work: Awaited<ReturnType<typeof applyDecision>>['work'][] = [];

    for (const entry of resolved) {
      if (entry.refusal !== null || entry.ticketUrl === null) {
        const reason =
          entry.refusal === null ? REFUSAL_DETAIL.ticket_unreadable : REFUSAL_DETAIL[entry.refusal];
        await options.shadow.addTicket(scope.tx, batchId, {
          ticketKey: entry.ticketKey,
          taskId: null,
          baseSha: entry.match?.baseSha ?? null,
          humanMr: entry.match?.mergeRequest ?? null,
          humanMrSource: entry.match?.source ?? null,
          mergedAt: entry.match?.mergedAt ?? null,
          candidates: entry.match?.candidates ?? null,
          refusedReason: reason,
        });
        tickets.push({ ticketKey: entry.ticketKey, taskId: null, refusedReason: reason });
        continue;
      }

      // Re-read inside the transaction for `startProjectDiscovery`'s reason: the unique index
      // `(project_id, ticket_key, mode)` is what decides, and this read turns a race into an answer.
      const raced = await options.store.tasks.findByTicket(scope.tx, {
        projectId,
        provider: integrations.taskManagement?.ref.provider ?? 'unknown',
        ticketKey: entry.ticketKey,
        mode: 'shadow',
      });
      if (raced !== null) {
        await options.shadow.addTicket(scope.tx, batchId, {
          ticketKey: entry.ticketKey,
          taskId: null,
          baseSha: entry.match?.baseSha ?? null,
          humanMr: entry.match?.mergeRequest ?? null,
          humanMrSource: entry.match?.source ?? null,
          mergedAt: entry.match?.mergedAt ?? null,
          candidates: entry.match?.candidates ?? null,
          refusedReason: REFUSAL_DETAIL.already_shadowed,
        });
        tickets.push({
          ticketKey: entry.ticketKey,
          taskId: null,
          refusedReason: REFUSAL_DETAIL.already_shadowed,
        });
        continue;
      }

      // `shadow: true` (WP-40): a shadow task never routes to the epic-split variant. The whole
      // point of shadow mode is comparing what the agent produced with what a human did
      // (product/19 §13), and there is no human breakdown to compare a proposed one against — so an
      // epic on a shadow batch runs the ordinary template. `epicSplitRouting` states the refusal.
      const template = templateForIssueType(settings, entry.issueType, { shadow: true });
      const created = createTask(
        {
          id: options.ids.next(),
          projectId,
          ticket: {
            provider: integrations.taskManagement?.ref.provider ?? 'unknown',
            key: entry.ticketKey,
            url: entry.ticketUrl,
          },
          template,
          mode: 'shadow',
          limits: resolveIterationLimits(settings.config.pipeline?.limits),
        },
        contextFor(options, null, input.requestedByUserId),
      );
      const stored: StoredTask = {
        task: created.aggregate,
        template: settings.templates[template] as PipelineTemplate,
        priorityRank: 2,
        createdAt: options.clock.now(),
        branch: null,
        mr: null,
        workpad: null,
        costActualUsd: 0,
        estimateUsd: null,
        estimateBasis: null,
        estimateSamples: null,
        version: INITIAL_TASK_VERSION,
        // The ticket's own words are read by `ensureTicketSnapshot` from the first stage's job, the
        // same way a task whose intake could not reach the provider gets them.
        ticketSnapshot: null,
        ticketSnapshotAt: null,
        reviewSubject: null,
        historySample: null,
        riskClasses: [],
        coverage: null,
        dependencies: null,
        requiredReviewers: null,
        requestedByUserId: null,
      };
      await options.store.tasks.insert(scope.tx, stored);
      await options.shadow.addTicket(scope.tx, batchId, {
        ticketKey: entry.ticketKey,
        taskId: stored.task.id,
        baseSha: entry.match?.baseSha ?? null,
        humanMr: entry.match?.mergeRequest ?? null,
        humanMrSource: entry.match?.source ?? null,
        mergedAt: entry.match?.mergedAt ?? null,
        candidates: entry.match?.candidates ?? null,
        refusedReason: null,
      });

      /**
       * **No WIP admission, for the reason `review-only.ts` and `ticket-lint.ts` both give.**
       *
       * BD-010's limits bound *delivery* work in progress, and a queued task is dequeued by
       * `schedulerHandler` on `task.completed` — which a shadow task never reaches, because it
       * stops at `ready_for_merge` and nothing will ever merge a merge request it did not open. A
       * batch that parked eight of its ten tickets would park them for ever. What bounds the spend
       * instead is the **separate shadow budget** (`features.shadow_mode.budget_usd`, checked at
       * every run's admission by the stage executor) and `MAX_SHADOW_BATCH_TICKETS`.
       */
      const pipeline = compilePipeline(stored.task.template, stored.template);
      const applied = await applyDecision({
        store: options.store,
        pipeline,
        tx: scope.tx,
        stored,
        decision: interpret(pipeline, { kind: 'start' }),
        context: contextFor(options, stored.task.id, input.requestedByUserId),
        causedByEventId: null,
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      });
      await scope.events.append([...created.events, ...applied.events]);
      work.push(applied.work);
      tickets.push({ ticketKey: entry.ticketKey, taskId: stored.task.id, refusedReason: null });
    }
    return { tickets, work };
  });

  for (const item of outcome.work) {
    if (item !== null) {
      // After the commit: `Jobs.enqueue` does not join the transaction (TD-004), and the stage job
      // re-validates when it fires.
      await enqueueStage(options.jobs, item);
    }
  }

  logger.info(
    {
      project_id: projectId,
      batch_id: batchId,
      started: outcome.tickets.filter((ticket) => ticket.taskId !== null).length,
      refused: outcome.tickets.filter((ticket) => ticket.taskId === null).length,
    },
    'a shadow batch was started',
  );
  return { status: 'started', batchId, tickets: outcome.tickets };
};

/**
 * Reads each ticket and finds its human merge request, outside every transaction.
 *
 * The merged merge-request listing is fetched **once** and shared. A project with no git binding
 * gets `null` for it, which is not a refusal: a batch can still run and its reports carry no
 * comparison (`gitReads` answers `null` for an absent binding, standing rule 20).
 */
const resolveTickets = async (
  options: ShadowBatchOptions,
  scope: { readonly projectId: Id; readonly integrations: PipelineIntegrations },
  ticketKeys: readonly string[],
): Promise<readonly Resolved[]> => {
  const { projectId, integrations } = scope;
  const context = { projectId, taskId: null };
  const since = new Date(
    Date.parse(options.clock.now()) - SHADOW_HISTORY_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const reads = gitReads(integrations);
  const merged = await reads.mergedMergeRequests(since, SHADOW_HISTORY_LIMIT, context);
  const tickets = ticketReads(integrations);

  const provider = integrations.taskManagement?.ref.provider ?? 'unknown';

  const resolved: Resolved[] = [];
  for (const ticketKey of ticketKeys) {
    // A key the provider does not know is an `IntegrationError`, not a `null` — `readTicket`'s
    // contract is `not_found` for an unknown ticket. Caught here and turned into a named refusal,
    // because one mistyped key must not fail the other nine (standing rule 20: this is a read the
    // batch can do without).
    const ticket = await tickets
      .ticket({ provider, key: ticketKey, url: '' }, context)
      .catch(() => null);
    if (ticket === null) {
      resolved.push({
        ticketKey,
        refusal: 'ticket_unreadable',
        issueType: null,
        ticketUrl: null,
        match: null,
      });
      continue;
    }
    const match = await findHumanMergeRequest(
      { reads, context },
      { ticketKey, links: ticket.links, merged: merged ?? [] },
    );
    resolved.push({
      ticketKey,
      // Q82 (a): a merge request whose base the provider will not publish is refused by name; a
      // ticket with **no** merge request is not (Q82 (b)).
      refusal: match !== null && match.baseSha === null ? 'no_comparison_base' : null,
      issueType: ticket.issue_type,
      ticketUrl: ticket.ref.url,
      match,
    });
  }
  return resolved;
};

/** Re-exported so a caller can render the same sentence the row stores. */
export const shadowRefusalDetail = (refusal: ShadowBatchRefusal): string => REFUSAL_DETAIL[refusal];

export type { MergeRequestRef };

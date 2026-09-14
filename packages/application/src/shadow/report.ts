/**
 * The ShadowReport: what the agent would have built, and how close it was — product/19 §13 (WP-34).
 *
 * `shadow_reports` has existed since migration 0008 and this is its first writer;
 * `shadow.report.created` has been `'unconsumed'` in `EVENT_CONSUMPTION` since the table was
 * created and this is what emits it.
 *
 * ## When it runs, and why that moment rather than the end of the task
 *
 * A shadow task **never finishes**. The shipped templates' tail is *"… rebase gate → ready for
 * merge → merged gate → retrospective → done"*, and `ready_for_merge` advances on `mr.merged` — an
 * event that cannot arrive for a merge request the platform was refused permission to open. So the
 * last thing a shadow task does is **enter the one `kind: 'human'` stage of its template**, and
 * that is the trigger: `task.stage.entered` for a stage the compiled pipeline says is a human wait.
 * Keyed on the stage's *kind* rather than on the id `ready_for_merge`, because "the pipeline is
 * data" (technical/02) and a project that renamed the stage would otherwise get no report at all.
 *
 * Everything the report needs exists by then: the merge request the Developer stage reported
 * (`tasks.mr_ref`), the task's estimate (WP-28) and its recorded spend, and the human merge request
 * the batch resolved when it created the task.
 *
 * ## It is a `pipeline.outbound` duty, for WP-15d's reason
 *
 * It makes up to three provider reads — the agent's diff, the human's diff and the human's
 * discussions, and nothing else — so it cannot be a handler: a handler that called a provider would hold a
 * database connection across somebody else's latency. The handler decides, the job calls
 * (`events/open-transaction.ts` refuses the other arrangement mechanically).
 *
 * ## Idempotency
 *
 * `shadow_reports` is keyed by `task_id` and `insertReport` is an `on conflict do nothing` that
 * answers whether it wrote. A job that arrives twice — and a job always can (TD-004) — performs the
 * reads again and then writes nothing and appends nothing, so there is exactly one
 * `shadow.report.created` per task however many times the wake-up is delivered.
 */
import type {
  Id,
  IsoDateTime,
  MergeRequestRef,
  ReviewFinding,
  ShadowReportData,
} from '@platform/contracts';
import { shadowReportDataSchema } from '@platform/contracts';
import {
  buildEvent,
  compareShadowDiffs,
  compilePipeline,
  type ShadowDiffSummary,
  stageOf,
} from '@platform/domain';
import type { EventHandler, HandlerContext } from '../events/handler.js';
import { gitReads, integrationsForProject, noRunScopedSecrets } from '../pipeline/integrations.js';
import { enqueueOutbound, type PipelineOutboundData } from '../pipeline/jobs.js';
import type { PipelineSagaOptions } from '../pipeline/saga.js';
import { PIPELINE_ACTOR } from '../pipeline/store.js';
import type { Discussion, FileDiff } from '../ports/integrations/git-provider.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import type { ShadowBatchTicketRow, ShadowStore } from './ports.js';
import { reviewerMinutesFromDiscussions } from './reviewer-minutes.js';

/**
 * How many files of each side's diff the comparison reads.
 *
 * The same bound `review-only.ts` and the conflict warning use, for the same reason: a merge
 * request with four thousand files is a request whose size somebody else chose. A side that came
 * back at exactly the limit is **announced** in `notes` rather than silently compared, because a
 * Jaccard over a truncated file list is a smaller number for a reason that has nothing to do with
 * the agent.
 */
export const MAX_SHADOW_DIFF_FILES = 200;

export interface ShadowReportOptions extends PipelineSagaOptions {
  readonly unitOfWork: UnitOfWork;
  readonly shadow: ShadowStore;
}

/**
 * The handler: a shadow task has reached the stage where a human would take over.
 *
 * TD-005 priority **130**, the integrations band — after the core handlers have moved the task and
 * after the status mapping (110) and the workpad (120), because this reads a row those may still be
 * writing and because it is the least urgent thing that happens at this moment.
 */
const shadowReportHandler = (options: ShadowReportOptions): EventHandler => ({
  name: 'pipeline.shadow.report',
  priority: 130,
  eventTypes: ['task.stage.entered'],
  handle: async (context: HandlerContext) => {
    const event = context.event.event;
    if (event.type !== 'task.stage.entered') {
      return;
    }
    const stored = await options.store.tasks.load(context.scope.tx, event.payload.task_id);
    if (stored === null || stored.task.mode !== 'shadow') {
      return;
    }
    const pipeline = compilePipeline(stored.task.template, stored.template);
    if (stageOf(pipeline, event.payload.stage)?.kind !== 'human') {
      return;
    }
    const data: PipelineOutboundData = {
      duty: 'shadow_report',
      project_id: event.payload.project_id,
      task_id: event.payload.task_id,
      cause_event_id: event.id,
      stage: event.payload.stage,
    };
    context.afterCommit(async () => {
      await enqueueOutbound(options.jobs, data);
    });
  },
});

/**
 * The consumer of `shadow.report.created` — the batch's own completion.
 *
 * Core band, priority **40**: it writes `shadow_batches.completed_at` and nothing else, and
 * `completeIfDone` only writes when every task of the batch has a report *and* the row is not
 * already marked, so a redelivery performs nothing twice.
 *
 * This is the event's first consumer. It is deliberately small: the aggregate product/19 §13 asks
 * for is a **projection** over the batch's rows (`domain/shadow/comparison.ts`), not a fifth stored
 * number, so there is nothing for a handler to accumulate.
 */
const shadowBatchCompletionHandler = (options: ShadowReportOptions): EventHandler => ({
  name: 'shadow.batch.completion',
  priority: 40,
  eventTypes: ['shadow.report.created'],
  handle: async (context: HandlerContext) => {
    const event = context.event.event;
    if (event.type !== 'shadow.report.created') {
      return;
    }
    const batch = await options.shadow.batchOfTask(context.scope.tx, event.payload.task_id);
    if (batch === null || batch.completedAt !== null) {
      return;
    }
    const completed = await options.shadow.completeIfDone(
      context.scope.tx,
      batch.id,
      options.clock.now() as IsoDateTime,
    );
    if (completed) {
      (options.logger ?? silentLogger).info(
        { project_id: batch.projectId, batch_id: batch.id },
        'every task of this shadow batch now has a report',
      );
    }
  },
});

export const shadowHandlers = (options: ShadowReportOptions): readonly EventHandler[] => [
  shadowReportHandler(options),
  shadowBatchCompletionHandler(options),
];

/**
 * `pipeline.outbound` duty **shadow_report**: read both diffs, compare, store, announce.
 *
 * **What it re-validates on fire** (TD-004): the task still exists, is still a shadow task, and has
 * no report yet. Nothing else — a shadow task that was paused or escalated after reaching the human
 * stage still deserves its report, because the report is about what it produced rather than about
 * where it ended up.
 */
export const runShadowReport = async (
  options: ShadowReportOptions,
  data: PipelineOutboundData,
): Promise<void> => {
  const logger: Logger = options.logger ?? silentLogger;
  const taskId = data.task_id as Id | undefined;
  if (taskId === undefined) {
    return;
  }

  const loaded = await options.unitOfWork.transaction(async (scope) => {
    const stored = await options.store.tasks.load(scope.tx, taskId);
    if (stored === null || stored.task.mode !== 'shadow') {
      return null;
    }
    const batch = await options.shadow.batchOfTask(scope.tx, taskId);
    const tickets = batch === null ? [] : await options.shadow.tickets(scope.tx, batch.id);
    return {
      stored,
      ticket: tickets.find((entry) => entry.taskId === taskId) ?? null,
    };
  });
  if (loaded === null) {
    return;
  }
  const { stored, ticket } = loaded;

  const integrations = await integrationsForProject(
    options.integrations,
    stored.task.projectId,
    noRunScopedSecrets(),
  );
  const reads = gitReads(integrations);
  const context = { projectId: stored.task.projectId, taskId: stored.task.id };
  const humanMr: MergeRequestRef | null = ticket?.humanMr ?? null;

  const agentFiles =
    stored.mr === null
      ? null
      : await reads.mergeRequestDiff(stored.mr, MAX_SHADOW_DIFF_FILES, context);
  const humanFiles =
    humanMr === null ? null : await reads.mergeRequestDiff(humanMr, MAX_SHADOW_DIFF_FILES, context);
  const discussions: readonly Discussion[] =
    humanMr === null ? [] : await reads.discussions(humanMr, context);

  const report = buildShadowReport({
    ticketKey: stored.task.ticket.key,
    humanMr,
    ticketRow: ticket,
    agentFiles,
    humanFiles,
    discussions,
    predictedCostUsd: stored.estimateUsd,
    shadowCostUsd: stored.costActualUsd,
  });

  const artifactId = options.ids.next();
  const wrote = await options.unitOfWork.transaction(async (scope) => {
    // Re-loaded inside the transaction: `task.sequence` is the next `stream_seq`, and the log
    // refuses one that is not `last + 1`, so it has to be read where the append happens.
    const current = await options.store.tasks.load(scope.tx, stored.task.id);
    if (current === null) {
      return false;
    }
    const inserted = await options.shadow.insertReport(scope.tx, {
      taskId: stored.task.id,
      humanMr,
      comparison: report,
    });
    if (!inserted) {
      return false;
    }
    /**
     * The same document on the task's own artifact list.
     *
     * Two readers, one write, in one transaction: the task page reads `artifacts` like it does for
     * every other stage output, and the batch reads `shadow_reports` without scanning a task's
     * artifacts. The report is written once and never updated (the table's primary key is the task),
     * so there is no window in which the two could disagree — which is the objection a second copy
     * usually deserves.
     */
    const version = await options.store.artifacts.nextVersion(
      scope.tx,
      stored.task.id,
      'ShadowReport',
    );
    await options.store.artifacts.insert(scope.tx, {
      id: artifactId,
      taskId: stored.task.id,
      type: 'ShadowReport',
      version,
      markdown: null,
      data: report as unknown as never,
      schemaVersion: '1',
      // No run produced it: the platform computed it from rows and two provider reads.
      producedByRunId: null,
      createdAt: options.clock.now() as IsoDateTime,
    });
    await scope.events.append([
      buildEvent(
        'shadow.report.created',
        {
          project_id: stored.task.projectId,
          task_id: stored.task.id,
          artifact: {
            id: artifactId,
            artifact_type: 'ShadowReport',
            version,
            url: null,
          },
        },
        { streamType: 'task', streamId: current.task.id, streamSeq: current.task.sequence },
        {
          ids: options.ids,
          actor: PIPELINE_ACTOR,
          clock: options.clock as never,
          correlationId: current.task.id,
          causeEventId: (data.cause_event_id as Id | undefined) ?? null,
        },
      ),
    ]);
    return true;
  });

  logger.info(
    {
      task_id: stored.task.id,
      wrote,
      human_mr: humanMr?.iid ?? null,
      similarity: report.overlap?.files_jaccard ?? null,
    },
    wrote
      ? 'a shadow report was written'
      : 'this shadow task already had a report; nothing was written twice',
  );
};

/**
 * One side's summary, plus **how many of its files carried no patch**.
 *
 * The count is the carrier for round 2's major finding: a provider that declined to render a file
 * (`omitted`, `collapsed`, `too_large`, a null body) contributes its path and no lines, so a merge
 * request that plainly changed something is counted as zero lines. It is *"no counted line"* rather
 * than *"the provider refused"*, which is the honest reading and is one case wider: a pure rename or
 * a mode change carries no `+`/`-` body either, and it is equally true of it that the line counts
 * say nothing about it. `compareShadowDiffs` answers
 * `size_ratio: null` for that rather than `0`, and this is what lets `notes` say *why* — a number
 * that is absent for a reason the reader is told is a measurement; one that is absent silently is
 * a gap.
 */
interface SideSummary extends ShadowDiffSummary {
  readonly files: number;
  readonly unrendered: number;
}

const summarise = (files: readonly FileDiff[]): SideSummary => {
  let insertions = 0;
  let deletions = 0;
  let unrendered = 0;
  for (const file of files) {
    // The provider's patch, counted the way `git --numstat` would: a body line beginning `+`/`-`
    // that is not the `+++`/`---` header. A file the provider declined to render (`omitted`)
    // contributes its path and no lines, which is the honest half-answer rather than a zero that
    // reads as "nothing changed".
    const body = file.diff ?? '';
    let counted = 0;
    for (const line of body.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        insertions += 1;
        counted += 1;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        deletions += 1;
        counted += 1;
      }
    }
    if (counted === 0) {
      unrendered += 1;
    }
  }
  return {
    paths: files.map((file) => file.new_path),
    insertions,
    deletions,
    files: files.length,
    unrendered,
  };
};

/**
 * The report, built from what was read. Pure: every input is an argument.
 *
 * Exported so the unit tier can drive every combination of "which side was missing" without a
 * provider, which is the half of this work package that has branches.
 */
export const buildShadowReport = (input: {
  readonly ticketKey: string;
  readonly humanMr: MergeRequestRef | null;
  readonly ticketRow: ShadowBatchTicketRow | null;
  readonly agentFiles: readonly FileDiff[] | null;
  readonly humanFiles: readonly FileDiff[] | null;
  readonly discussions: readonly Discussion[];
  readonly predictedCostUsd: number | null;
  readonly shadowCostUsd: number;
}): ShadowReportData => {
  const agent = input.agentFiles === null ? null : summarise(input.agentFiles);
  const human = input.humanFiles === null ? null : summarise(input.humanFiles);
  const overlap = agent === null || human === null ? null : compareShadowDiffs(agent, human);
  const minutes =
    input.humanMr === null
      ? null
      : reviewerMinutesFromDiscussions(input.discussions, {
          // product/19 §16's window runs *"to merge or last activity"*, and the merge instant is
          // the batch's own record of the match (`shadow_batch_tickets.human_mr_merged_at`). It
          // was `null` here until WP-34's review round 2, which left the *"to merge"* half of the
          // arithmetic permanently unapplied; `reviewerMinutesFromDiscussions` still refuses a
          // merge outside the gap rule, so a merge request merged a week after its last comment is
          // not a week of review.
          until: input.ticketRow?.mergedAt ?? null,
        });

  const notes: string[] = [];
  if (input.humanMr === null) {
    notes.push(
      'no human merge request was found for this ticket, so there is no comparison — the report describes what the agent produced and nothing else',
    );
  } else if (input.ticketRow !== null && input.ticketRow.humanMrSource !== null) {
    notes.push(
      input.ticketRow.humanMrSource === 'ticket_link'
        ? 'the human merge request came from a link on the ticket itself'
        : 'the human merge request was found by matching the ticket key in a merged merge request’s title or source branch',
    );
  }
  if (agent === null) {
    notes.push(
      'this shadow task recorded no merge request, so the platform had no diff of its own to measure',
    );
  }
  if ((input.ticketRow?.candidates ?? 0) > 1) {
    // The direction of the error, at the number: the most recently merged wins, so a ticket
    // delivered across several merge requests is compared against the last one — which understates
    // the human's size and therefore overstates the agent (`human-merge-request.ts`).
    notes.push(
      `${String(input.ticketRow?.candidates)} merged merge requests name this ticket and the most recently merged is the one compared, so the human’s side is understated`,
    );
  }
  if (input.ticketRow?.baseSha != null) {
    notes.push(`both diffs are taken against ${input.ticketRow.baseSha}`);
  }
  // An unrendered patch is announced rather than left to become a zero. The overlap's
  // `size_ratio` is `null` when the human side has no counted line (round 2's major finding), and
  // these two sentences are what tell a reader which side the provider declined to render.
  for (const side of [
    { name: 'agent’s', summary: agent },
    { name: 'human merge request’s', summary: human },
  ]) {
    const { summary } = side;
    if (summary !== null && summary.unrendered > 0) {
      notes.push(
        `the provider rendered no patch for ${summary.unrendered} of the ${side.name} ${summary.files} changed file(s), so its line counts understate the change`,
      );
    }
  }
  if (overlap !== null && overlap.size_ratio === null) {
    notes.push(
      'the human merge request’s diff carries no counted line, so there is no size ratio to take — this is not a ratio of zero',
    );
  }
  if (input.agentFiles !== null && input.agentFiles.length >= MAX_SHADOW_DIFF_FILES) {
    notes.push(
      `the agent’s diff was cut at ${MAX_SHADOW_DIFF_FILES} files, so the overlap understates it`,
    );
  }
  if (input.humanFiles !== null && input.humanFiles.length >= MAX_SHADOW_DIFF_FILES) {
    notes.push(
      `the human diff was cut at ${MAX_SHADOW_DIFF_FILES} files, so the overlap understates it`,
    );
  }
  if (minutes === null && input.humanMr !== null) {
    notes.push(
      'the human merge request carries no human note, so no reviewer minutes could be derived from it',
    );
  }
  notes.push(
    'no reviewer looked at the human merge request: nothing in this build reviews somebody else’s diff during a shadow task',
  );

  const findings: readonly ReviewFinding[] | null = null;
  return shadowReportDataSchema.parse({
    ticket: input.ticketKey,
    human_mr: input.humanMr,
    agent_diff_stats:
      agent === null
        ? null
        : {
            files_changed: new Set(agent.paths).size,
            insertions: agent.insertions,
            deletions: agent.deletions,
          },
    overlap,
    agent_review_of_human_mr: findings,
    predicted_cost: input.predictedCostUsd,
    shadow_cost: input.shadowCostUsd,
    reviewer_minutes_estimate: minutes,
    notes: notes.join('; '),
  });
};

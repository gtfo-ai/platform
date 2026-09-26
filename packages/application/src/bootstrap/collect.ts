/**
 * Reading the team's history and turning it into mining runs — WP-35, product/19 §18.
 *
 * > *"Inputs: last N merged MRs (default 200, max 1 000) with discussions and diff stats; closed
 * > tickets of the last 6 months (titles, descriptions, resolution comments); commit messages."*
 *
 * ## Where this runs, and why it is a job rather than a command
 *
 * A job, on `bootstrap.history`, because the read volume is not something to do inside an HTTP
 * request: **up to 453 provider reads at N = 200** (`batch.ts` has the arithmetic), each of them through
 * `IntegrationActionExecutor` and therefore each of them taking the account's rate-limit budget.
 * Everything here happens **outside every transaction** — `integrationsForProject` and the executor
 * refuse to run inside one (WP-15d) — and the single write transaction at the end is the only
 * moment a connection is held.
 *
 * ## The three inputs, and what each costs
 *
 *  - **merged merge requests**: one `listMergedMergeRequests`, then one `listDiscussions` **per**
 *    merge request, because `MergedMergeRequest` carries a discussion *count* and not the comments —
 *    and, since WP-59, one `getMergeRequestDiffStats` per merge request whose listing carried no
 *    `diff_stats`, which on GitLab is all of them ({@link withDiffStats}).
 *    That fan-out is the port's shape rather than this caller's choice, and PROGRESS backlog 64
 *    records that GitLab publishes no `include=discussions` on the list endpoint.
 *  - **closed tickets**: one `matchTickets` on the project's **own** definition of closed —
 *    `status_mapping.done`, the status the platform moves a ticket to when a task finishes — then
 *    one `readTicket` per ticket kept, bounded at {@link HISTORY_TICKETS_PER_CHUNK} × the number of
 *    chunks. A project with no `status_mapping.done` gets **no ticket half** and the batch says so:
 *    there is no platform definition of "closed" (`shadow/batch.ts` states why), and guessing at one
 *    would mine whatever a project happens to call its last column.
 *  - **commit messages**: one `listCommits`, the port method this work package added. An adapter
 *    that does not support it answers `unsupported_capability`, which is caught and recorded as a
 *    batch with no commit half rather than a failed collection (standing rule 20).
 *
 * ## Idempotency
 *
 * pg-boss is at-least-once. A redelivery **after** the write transaction finds the batch at
 * `mining` and returns; one **before** it finds `collecting` with no chunks and redoes the whole
 * collection cleanly, because nothing outside the transaction was written. The unique index
 * `(batch_id, chunk_index)` is the backstop for the case neither covers.
 */
import type { Id, IsoDateTime, PipelineTemplate } from '@platform/contracts';
import type { CommandContext } from '@platform/domain';
import {
  compilePipeline,
  createTask,
  HISTORY_BOOTSTRAP_TEMPLATE_ID,
  interpret,
  resolveIterationLimits,
} from '@platform/domain';
import type { PipelineIntegrationsPort } from '../pipeline/integrations.js';
import {
  gitReads,
  integrationsForProject,
  noRunScopedSecrets,
  ticketReads,
} from '../pipeline/integrations.js';
import { enqueueStage } from '../pipeline/jobs.js';
import type { ProjectSettingsPort } from '../pipeline/settings.js';
import {
  INITIAL_TASK_VERSION,
  PIPELINE_ACTOR,
  type PipelineStore,
  type StoredTask,
} from '../pipeline/store.js';
import { applyDecision } from '../pipeline/transitions.js';
import type { SecretRedactor } from '../ports/integrations/audit.js';
import { IntegrationError, IntegrationUnsupportedError } from '../ports/integrations/common.js';
import type { Discussion, MergedMergeRequest } from '../ports/integrations/git-provider.js';
import type { Ticket, TicketMatchRule } from '../ports/integrations/task-management.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import type { HistoryBootstrapStore } from './ports.js';
import {
  buildHistorySample,
  HISTORY_COMMITS_PER_CHUNK,
  HISTORY_TICKETS_PER_CHUNK,
} from './sample.js';

/**
 * The ticket reference a mining task carries.
 *
 * `platform` is not a provider this build ships, deliberately: nothing may resolve it to an adapter
 * and try to transition a ticket that does not exist (`DISCOVERY_TICKET_PROVIDER`'s reason). The
 * key carries the batch id **and** the chunk index, because `unique (project_id, ticket_key, mode)`
 * has to admit a second bootstrap on the same project after the first has finished.
 */
export const BOOTSTRAP_TICKET_PROVIDER = 'platform';
export const bootstrapTicketKey = (batchId: string, chunkIndex: number): string =>
  `history-bootstrap-${batchId}-${chunkIndex}`;

export interface HistoryCollectOptions {
  readonly unitOfWork: UnitOfWork;
  readonly store: PipelineStore;
  readonly bootstrap: HistoryBootstrapStore;
  readonly settings: ProjectSettingsPort;
  readonly integrations: PipelineIntegrationsPort;
  readonly jobs: import('../ports/jobs.js').Jobs;
  readonly ids: { next(): Id };
  readonly clock: { now(): IsoDateTime };
  /** `APP_BASE_URL`; the project's own page stands in for the ticket's URL. */
  readonly baseUrl: string;
  /**
   * TD-012's redactor for the text this writes.
   *
   * Required, never defaulted: an optional security dependency is an absent one (standing rule
   * 31), and this module's whole output is somebody else's words on their way into a column.
   */
  readonly redactor: SecretRedactor;
  readonly logger?: Logger;
}

export interface HistoryCollectReport {
  readonly status: 'collected' | 'empty' | 'skipped';
  readonly chunks: number;
  readonly mergeRequests: number;
  readonly tickets: number;
  readonly commits: number;
  readonly redactions: number;
  readonly reason: string | null;
}

const EMPTY: HistoryCollectReport = {
  status: 'skipped',
  chunks: 0,
  mergeRequests: 0,
  tickets: 0,
  commits: 0,
  redactions: 0,
  reason: null,
};

const contextFor = (options: HistoryCollectOptions, correlationId: Id | null): CommandContext => ({
  ids: options.ids,
  // The pipeline actor stamps the events: the task is the pipeline's from the moment it exists,
  // and the *command* that asked for the batch is audited in `human_actions` by the route.
  actor: PIPELINE_ACTOR,
  clock: options.clock as CommandContext['clock'],
  correlationId,
  causeEventId: null,
});

const chunked = <T>(items: readonly T[], size: number): readonly (readonly T[])[] => {
  const groups: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    groups.push(items.slice(index, index + size));
  }
  return groups;
};

/**
 * Collects one batch's history and creates its mining tasks.
 *
 * Exported separately from the job handler so a test can drive it and read the report — the shape
 * `recordDiscoveryFindings` uses.
 */
/**
 * A mined merge request with its **diff stats**, read when the listing did not carry them — WP-59,
 * PROGRESS backlog 113, product/19 §18's *"with discussions and diff stats"*.
 *
 * The one shipped adapter's listing never carries them (GitLab divergence 1), so on GitLab this is
 * **one more provider read per merge request** — GraphQL's `diffStatsSummary` — and the bootstrap's
 * read volume at N = 200 is up to **453**, where it was 253 (`batch.ts` has the arithmetic). A
 * listing that does carry them costs nothing here.
 *
 * **A read the bootstrap can do without** (standing rule 20): a provider that does not implement
 * it, refuses it or answers something unparseable leaves the merge request sizeless rather than
 * failing a collection that has everything else in hand, and the batch's detail says how many.
 * A **retryable** failure is re-thrown, so the job retries rather than mining a sample that lost
 * its sizes to a blip.
 */
const withDiffStats = async (
  reads: ReturnType<typeof gitReads>,
  mr: MergedMergeRequest,
  context: { readonly projectId: Id; readonly taskId: null },
): Promise<MergedMergeRequest> => {
  if (mr.diff_stats != null) {
    return mr;
  }
  try {
    const stats = await reads.mergeRequestDiffStats(mr.ref, context);
    return stats === null ? mr : { ...mr, diff_stats: stats };
  } catch (error) {
    if (error instanceof IntegrationError && !error.retryable) {
      return mr;
    }
    throw error;
  }
};

export const collectHistory = async (
  options: HistoryCollectOptions,
  input: { readonly batchId: Id; readonly projectId: Id },
): Promise<HistoryCollectReport> => {
  const logger = options.logger ?? silentLogger;
  const { batchId, projectId } = input;

  const batch = await options.unitOfWork.transaction(async (scope) =>
    options.bootstrap.batch(scope.tx, batchId),
  );
  if (batch === null) {
    return { ...EMPTY, reason: 'the batch row no longer exists' };
  }
  if (batch.status !== 'collecting') {
    // A redelivery after the write transaction. Not a throw: this is a state the platform can
    // legitimately be in, and a throw would spend two pg-boss retries on it.
    return { ...EMPTY, reason: `the batch is already ${batch.status}` };
  }

  const settings = await options.settings.forProject(projectId);
  const template = settings.templates[HISTORY_BOOTSTRAP_TEMPLATE_ID];
  if (template === undefined) {
    const detail = `this project's settings define no "${HISTORY_BOOTSTRAP_TEMPLATE_ID}" template, so there is no pipeline to mine on`;
    await markEmpty(options, batchId, detail);
    return { ...EMPTY, status: 'empty', reason: detail };
  }

  // Outside every transaction (WP-15d), and outside a run, so the call's scope holds no minted
  // credential (Q55).
  const integrations = await integrationsForProject(
    options.integrations,
    projectId,
    noRunScopedSecrets(),
  );
  const reads = gitReads(integrations);
  const tickets = ticketReads(integrations);
  const context = { projectId, taskId: null };
  const since = new Date(
    Date.parse(options.clock.now()) - batch.days * 24 * 60 * 60 * 1000,
  ).toISOString();

  const merged = (await reads.mergedMergeRequests(since, batch.mergeRequests, context)) ?? [];
  if (merged.length === 0) {
    const detail = `no merge request has been merged on this project in the last ${batch.days} days, so there is no history to mine`;
    await markEmpty(options, batchId, detail);
    return { ...EMPTY, status: 'empty', reason: detail };
  }

  const withDiscussions: { mr: MergedMergeRequest; discussions: readonly Discussion[] }[] = [];
  let sizeless = 0;
  let statsReads = 0;
  for (const mr of merged) {
    // `1 + N`: the fan-out backlog 64 records, made once per merge request and bounded by N.
    const discussions = await reads.discussions(mr.ref, context);
    statsReads += mr.diff_stats == null ? 1 : 0;
    const sized = await withDiffStats(reads, mr, context);
    if (sized.diff_stats == null) {
      sizeless += 1;
    }
    withDiscussions.push({ mr: sized, discussions });
  }

  const groups = chunked(withDiscussions, batch.batchSize);

  /**
   * The commit half. One read, bounded at what the chunks can hold, and **recorded as absent rather
   * than failed** when the adapter has no such capability.
   */
  const commitLimit = groups.length * HISTORY_COMMITS_PER_CHUNK;
  let commits: readonly import('../ports/integrations/git-provider.js').RepositoryCommit[] = [];
  let missing: string | null = null;
  try {
    commits = (await reads.commits(since, commitLimit, context)) ?? [];
  } catch (error) {
    if (error instanceof IntegrationUnsupportedError) {
      missing = 'this git provider does not list commits, so the sample carries no commit messages';
      logger.info({ project_id: projectId, batch_id: batchId }, missing);
    } else {
      throw error;
    }
  }

  if (sizeless > 0) {
    // product/19 §18's *"with discussions and diff stats"*, and what the sample lost of it — said,
    // because a merge request with no size reads to the model as a merge request of no size
    // (PROGRESS backlog 113).
    const lost = `the git provider published no diff stats for ${sizeless} of ${merged.length} merge request(s), so their size is missing from the sample`;
    logger.info({ project_id: projectId, batch_id: batchId, sizeless }, lost);
    missing = missing === null ? lost : `${missing}; ${lost}`;
  }

  const closed = await closedTickets({
    tickets,
    context,
    since,
    limit: groups.length * HISTORY_TICKETS_PER_CHUNK,
    statusMapping: settings.config.status_mapping,
  });
  if (closed.reason !== null) {
    missing = missing === null ? closed.reason : `${missing}; ${closed.reason}`;
  }

  const outcome = await options.unitOfWork.transaction(async (scope) => {
    const created: { taskId: Id; work: Awaited<ReturnType<typeof applyDecision>>['work'] }[] = [];
    let redactions = 0;
    let ticketsUsed = 0;
    let commitsUsed = 0;

    for (const [chunkIndex, group] of groups.entries()) {
      const sample = buildHistorySample({
        mergeRequests: group,
        // Each chunk gets its own slice of the tickets and commits, so twenty runs do not all read
        // the same five tickets — the sample is a *window* on the history, not a copy of it.
        tickets: closed.tickets.slice(
          chunkIndex * HISTORY_TICKETS_PER_CHUNK,
          (chunkIndex + 1) * HISTORY_TICKETS_PER_CHUNK,
        ),
        commits: commits.slice(
          chunkIndex * HISTORY_COMMITS_PER_CHUNK,
          (chunkIndex + 1) * HISTORY_COMMITS_PER_CHUNK,
        ),
        redactor: options.redactor,
      });
      redactions += sample.redaction_count;
      ticketsUsed += sample.tickets.length;
      commitsUsed += sample.commits.length;

      const ticket = {
        provider: BOOTSTRAP_TICKET_PROVIDER,
        key: bootstrapTicketKey(batchId, chunkIndex),
        url: `${options.baseUrl.replace(/\/+$/, '')}/projects/${projectId}`,
      };
      const task = createTask(
        {
          id: options.ids.next(),
          projectId,
          ticket,
          template: HISTORY_BOOTSTRAP_TEMPLATE_ID,
          mode: 'normal',
          limits: resolveIterationLimits(settings.config.pipeline?.limits),
        },
        contextFor(options, null),
      );
      const stored: StoredTask = {
        task: task.aggregate,
        template: template as PipelineTemplate,
        // Behind a delivery, ahead of nothing: onboarding blocks nobody's merge request, and a
        // bootstrap that jumped the queue would delay the work the project is actually for.
        priorityRank: 3,
        createdAt: options.clock.now(),
        branch: null,
        mr: null,
        workpad: null,
        costActualUsd: 0,
        estimateUsd: null,
        estimateBasis: null,
        estimateSamples: null,
        version: INITIAL_TASK_VERSION,
        // There is no ticket to read: the sample is this task's input, written on the same insert.
        ticketSnapshot: null,
        ticketSnapshotAt: null,
        reviewSubject: null,
        historySample: sample,
        riskClasses: [],
        coverage: null,
        dependencies: null,
        requiredReviewers: null,
        requestedByUserId: null,
      };
      await options.store.tasks.insert(scope.tx, stored);
      await options.bootstrap.addChunk(scope.tx, {
        id: options.ids.next(),
        batchId,
        chunkIndex,
        taskId: stored.task.id,
        mergeRequests: sample.merge_requests.length,
        tickets: sample.tickets.length,
        commits: sample.commits.length,
        redactionCount: sample.redaction_count,
        truncated: sample.truncated,
      });

      /**
       * **No WIP admission**, for `review-only.ts`'s and `shadow/batch.ts`'s reason: a queued task
       * is dequeued on `task.completed`, and parking ten mining runs behind a project's delivery
       * limit would park the onboarding step that exists to make the project usable. What bounds
       * the spend is the batch's own cap, checked at every admission by the stage executor.
       */
      const pipeline = compilePipeline(HISTORY_BOOTSTRAP_TEMPLATE_ID, stored.template);
      const applied = await applyDecision({
        store: options.store,
        pipeline,
        tx: scope.tx,
        stored,
        decision: interpret(pipeline, { kind: 'start' }),
        context: contextFor(options, stored.task.id),
        causedByEventId: null,
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      });
      await scope.events.append([...task.events, ...applied.events]);
      created.push({ taskId: stored.task.id, work: applied.work });
    }

    await options.bootstrap.markMining(scope.tx, batchId);
    return { created, redactions, ticketsUsed, commitsUsed };
  });

  for (const item of outcome.created) {
    if (item.work !== null) {
      await enqueueStage(options.jobs, item.work);
    }
  }

  logger.info(
    {
      project_id: projectId,
      batch_id: batchId,
      chunks: outcome.created.length,
      merge_requests: withDiscussions.length,
      tickets: outcome.ticketsUsed,
      commits: outcome.commitsUsed,
      provider_reads:
        1 + withDiscussions.length + statsReads + 1 + (closed.reads > 0 ? closed.reads + 1 : 0),
      redactions: outcome.redactions,
      missing,
    },
    'a history bootstrap collected its batch',
  );
  return {
    status: 'collected',
    chunks: outcome.created.length,
    mergeRequests: withDiscussions.length,
    tickets: outcome.ticketsUsed,
    commits: outcome.commitsUsed,
    redactions: outcome.redactions,
    reason: missing,
  };
};

const markEmpty = async (
  options: HistoryCollectOptions,
  batchId: Id,
  detail: string,
): Promise<void> => {
  await options.unitOfWork.transaction(async (scope) => {
    await options.bootstrap.markEmpty(scope.tx, batchId, detail, options.clock.now());
  });
};

/**
 * product/19 §18's *"closed tickets of the last 6 months (titles, descriptions, resolution
 * comments)"*.
 *
 * `matchTickets` answers identities — `TicketMatch` carries `ref`, `issue_type`, `links` and no
 * text at all — so the words need one `readTicket` each. That is the second fan-out of this module
 * and it is why the ticket half is bounded at {@link HISTORY_TICKETS_PER_CHUNK} per chunk rather
 * than at N: five tickets beside twenty merge requests is what one prompt can hold, and reading two
 * hundred to use fifty would be spending somebody else's rate limit on text nobody sees.
 */
const closedTickets = async (input: {
  readonly tickets: ReturnType<typeof ticketReads>;
  readonly context: { readonly projectId: Id; readonly taskId: null };
  readonly since: string;
  readonly limit: number;
  readonly statusMapping: Readonly<Record<string, string>> | undefined;
}): Promise<{
  readonly tickets: readonly Ticket[];
  readonly reads: number;
  readonly reason: string | null;
}> => {
  const closedStatus = input.statusMapping?.done;
  if (closedStatus === undefined || closedStatus === '') {
    return {
      tickets: [],
      reads: 0,
      reason:
        'this project maps no ticket status to `done`, so the platform has no definition of "closed" here and the sample carries no tickets',
    };
  }
  const rule: TicketMatchRule = { kind: 'status', status: closedStatus };
  const matches = await input.tickets.matches(
    rule,
    { since: input.since, limit: input.limit },
    input.context,
  );
  if (matches === null) {
    return {
      tickets: [],
      reads: 0,
      reason: 'this project has no task-management integration, so the sample carries no tickets',
    };
  }
  const read: Ticket[] = [];
  for (const match of matches.slice(0, input.limit)) {
    // One mistyped or deleted key must not fail the collection (standing rule 20: this is a read
    // the bootstrap can do without), so an unreadable ticket is dropped rather than thrown.
    const ticket = await input.tickets.ticket(match.ref, input.context).catch(() => null);
    if (ticket !== null) {
      read.push(ticket);
    }
  }
  return { tickets: read, reads: matches.length, reason: null };
};

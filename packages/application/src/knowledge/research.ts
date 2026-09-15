/**
 * The spike's report, stored in the knowledge base — product/04:117's *"stored in the KB under
 * `research/`"* (WP-40).
 *
 * ## Why it reuses the Librarian's job rather than building a second path
 *
 * `recordDiscoveryFindings` already made this argument once and it holds twice as strongly here:
 * the proposal queue *is* what product/04 asks for — a page with its provenance, a maintainer's
 * decision, and, once approved, a commit on an `agentic/knowledge/*` branch with a merge request
 * and never onto the default branch (`knowledge/apply.ts`). A second reviewable store for the same
 * kind of artefact would be a second apply path, a second decision endpoint and a second screen.
 *
 * So this module is one function and one handler, wired onto the queue the Librarian's curation
 * already runs on (`JOB_QUEUES.knowledgeProposals`): the payload gained an `artifact_type`, and the
 * runtime dispatches on it. Everything the curation needs — the project's `knowledge_dir`, the
 * indexed paths, the artifact, the redactor, the ids and the clock — is already composed there.
 *
 * ## Nothing a spike drafts is ever auto-applied
 *
 * The thresholds are {@link RESEARCH_PROPOSAL_THRESHOLDS}, **forced** rather than read from the
 * project's `policies.knowledge_apply`, for `DISCOVERY_PROPOSAL_THRESHOLDS`' reason: BD-018's
 * auto-apply band is a judgement about a Librarian reconciling a delivered task against a vault it
 * was shown, and a research report is a model's answer to a question nobody has checked yet.
 * product/04:117 says the output is *"a markdown report … stored in the KB"*, and WP-40's criterion
 * is that it is stored **as a proposal, never applied silently**.
 *
 * ## The path is the platform's
 *
 * `research/<ticket-key>.md` (`researchPagePath`), folded to `[A-Za-z0-9._-]`. A `LibrarianProposals`
 * page is model-chosen and `curateProposals` refuses what falls outside the vault; here there is
 * nothing to refuse, because the model never names the file. The join, the byte cap and the
 * add-versus-update dedupe are still the curator's, so a second spike on the same ticket updates the
 * page rather than adding a duplicate.
 */
import type { Id, IsoDateTime, LibrarianProposal } from '@platform/contracts';
import {
  knowledgeProposalCreatedEvent,
  knowledgeProposalRecordSchema,
  researchReportDataSchema,
} from '@platform/contracts';
import type { KnowledgeApplyThresholds } from '@platform/domain';
import { curateProposals } from '@platform/domain';
import type { EventHandler } from '../events/handler.js';
import { renderResearchReport, researchPagePath } from '../pipeline/epic-split.js';
import type { Jobs } from '../ports/jobs.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { KnowledgeProposalsData, LibrarianJobOptions } from './librarian.js';
import type { StoredKnowledgeProposal } from './ports.js';

/** Every page a spike drafts is queued, and none of them is ever committed without a decision. */
export const RESEARCH_PROPOSAL_THRESHOLDS: KnowledgeApplyThresholds = {
  autoApply: false,
  discardBelow: 0,
  proposalAbove: 0,
};

/**
 * How confident the queue says the page is.
 *
 * **The platform's number, not the model's.** A `ResearchReport` has a per-*finding* confidence and
 * no confidence about itself, and a page-level figure derived by averaging them would be an
 * arithmetic claim nobody made. `0.5` is the middle of the interval and it orders the queue without
 * asserting anything — which is honest for a document whose whole point is that a human reads it.
 * Nothing downstream branches on it, because the thresholds above queue everything.
 */
export const RESEARCH_PAGE_SIGNIFICANCE = 0.5;

/** What one recording did, returned for the log and asserted by the tests. */
export interface ResearchPageReport {
  readonly status: 'recorded' | 'skipped';
  readonly reason: string | null;
  readonly path: string | null;
  readonly queued: number;
  readonly redactions: number;
}

const EMPTY: ResearchPageReport = {
  status: 'skipped',
  reason: null,
  path: null,
  queued: 0,
  redactions: 0,
};

/**
 * Turns one stored `ResearchReport` into a queued knowledge proposal.
 *
 * Exported separately from the job handler so a test can drive it and read the report — the shape
 * `recordLibrarianProposals` and `recordDiscoveryFindings` both use.
 */
export const recordResearchPage = async (
  options: LibrarianJobOptions,
  data: KnowledgeProposalsData,
): Promise<ResearchPageReport> => {
  const projectId = data.project_id as Id;
  const taskId = data.task_id as Id;
  const project = await options.project(projectId);
  if (project === null) {
    return { ...EMPTY, reason: 'the project no longer has a row' };
  }
  const artifact = await options.artifact({ taskId, artifactId: data.artifact_id as Id });
  if (artifact === null) {
    return { ...EMPTY, reason: 'the artifact or its task no longer exists' };
  }
  // Re-validated although the runner validated it on the way in: this row may have been written by
  // an older build, and a strict parse is what makes every field below a value the schema admits
  // rather than whatever JSON is in the column (BD-022).
  const parsed = researchReportDataSchema.safeParse(artifact.data);
  if (!parsed.success) {
    return {
      ...EMPTY,
      reason: `the stored artifact does not match the ResearchReport schema: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
    };
  }

  const tally = { count: 0 };
  const redact = (value: string): string => {
    const outcome = options.redactor.redactText(value);
    tally.count += outcome.count;
    return outcome.value;
  };
  const path = researchPagePath({ key: artifact.ticketKey });
  const proposal: LibrarianProposal = {
    // Always `add`: the curator turns it into an `update` when the index already holds the page,
    // which is what makes a second spike on the same ticket a revision rather than a duplicate.
    action: 'add',
    kind: 'technical',
    type: 'doc-update',
    target_path: path,
    delta: redact(renderResearchReport({ report: parsed.data, ticketKey: artifact.ticketKey })),
    // Platform text: which task produced the page, so a maintainer reading the queue can open it.
    evidence: [`produced by the spike task ${taskId} (${artifact.ticketKey})`],
    significance: RESEARCH_PAGE_SIGNIFICANCE,
    reason: redact(parsed.data.question),
  };

  const indexed = await options.knowledge.readIndexedBlobs(projectId);
  const curated = curateProposals({
    proposals: [proposal],
    knowledgeDir: project.knowledgeDir,
    indexedPaths: [...indexed.keys()],
    thresholds: RESEARCH_PROPOSAL_THRESHOLDS,
    // The task's real mode, unlike `recordDiscoveryFindings`, which knows it is never shadow: a
    // spike *can* be one in principle, and the curator's own reason line then says so on the row.
    // The thresholds above already force the queue, so the flag changes the reason and not the fate.
    shadow: artifact.taskMode === 'shadow',
  });
  const entry = curated[0];
  if (entry === undefined) {
    // **Deliberately unreachable defence in depth** (standing rule 22): `curateProposals` answers
    // one entry per proposal it is given — a refusal is an entry with `repoPath: null`, not an
    // absence — and exactly one is given above. The outer guard that makes it so is that call
    // site; this branch exists because the index access is `T | undefined` and a cast would be a
    // claim with nothing behind it.
    return { ...EMPTY, path, reason: 'the curator answered nothing for the page' };
  }
  if (entry.repoPath === null) {
    // The curator's own containment (BD-025). Reachable through a `projects.knowledge_dir` the
    // join cannot produce a vault path under — an empty one, say — and it is **recorded rather
    // than dropped**, with the curator's reason, because a page that silently vanished is the one
    // failure a maintainer cannot diagnose.
    return { ...EMPTY, path, reason: entry.reason };
  }

  const createdAt = options.clock.now() as IsoDateTime;
  const row: StoredKnowledgeProposal = {
    id: options.ids.next(),
    projectId,
    taskId,
    runId: artifact.runId,
    // technical/03's `knowledge_proposal_source`: this one came from a task, like a retrospective's.
    source: 'task',
    kind: entry.proposal.kind,
    type: entry.proposal.type,
    targetPath: entry.repoPath ?? entry.proposal.target_path,
    delta: entry.proposal.delta,
    evidence: entry.proposal.evidence,
    significance: entry.proposal.significance,
    status: entry.status,
    decidedByUserId: null,
    decidedAt: null,
    appliedCommitSha: null,
    createdAt,
  };

  const streamSeq = await options.eventStore.nextStreamSequence('project', projectId);
  await options.unitOfWork.transaction(async (scope) => {
    await options.proposals.insert(scope.tx, [row]);
    await scope.events.append([
      knowledgeProposalCreatedEvent.parse({
        id: options.ids.next(),
        stream_type: 'project',
        stream_id: projectId,
        stream_seq: streamSeq,
        actor: { kind: 'system', component: 'spike' },
        occurred_at: createdAt,
        type: 'knowledge.proposal.created',
        payload: {
          project_id: projectId,
          proposal: knowledgeProposalRecordSchema.parse({
            id: row.id,
            project_id: row.projectId,
            task_id: row.taskId,
            run_id: row.runId,
            source: row.source,
            kind: row.kind,
            type: row.type,
            target_path: row.targetPath,
            delta: row.delta,
            evidence: [...row.evidence],
            significance: row.significance,
            status: row.status,
            decided_by_user_id: null,
            decided_at: null,
            applied_commit_sha: null,
            created_at: row.createdAt,
          }),
        },
      }),
    ]);
  });

  return {
    status: 'recorded',
    reason: null,
    path: row.targetPath,
    queued: row.status === 'queued' ? 1 : 0,
    redactions: tally.count,
  };
};

export const researchPageJobHandler =
  (options: LibrarianJobOptions) =>
  async (job: { readonly data: KnowledgeProposalsData }): Promise<void> => {
    const logger = options.logger ?? silentLogger;
    const report = await recordResearchPage(options, job.data);
    const fields = {
      project_id: job.data.project_id,
      task_id: job.data.task_id,
      artifact_id: job.data.artifact_id,
      status: report.status,
      path: report.path,
      queued: report.queued,
      redactions: report.redactions,
      reason: report.reason,
    };
    if (report.status === 'skipped') {
      // Not a thrown error, for `librarianProposalsHandler`'s reason: every skip here is a state the
      // platform can legitimately be in, and a throw would spend two pg-boss retries on it.
      logger.warn(fields, 'a spike’s research page was not queued');
      return;
    }
    logger.info(fields, 'research page queued for the knowledge base');
  };

export const RESEARCH_ARTIFACT_HANDLER = 'knowledge.research.artifact';

/**
 * The one handler: a `ResearchReport` artifact was stored, so queue its page.
 *
 * It reads nothing and writes nothing — the shape `librarianTriggerHandlers` uses, and for the same
 * reason (a handler runs inside the dispatcher's transaction, where every read is a nested pool
 * borrow). `artifact.created` is already a consumed event, so this adds a handler to an event the
 * deployment already dispatches rather than changing what `EVENT_CONSUMPTION` declares.
 *
 * The residual is the one `librarian.ts` states: `afterCommit` is at-most-once, so a process that
 * dies between the commit and the enqueue loses this page. It is notification-shaped loss — the
 * artifact is still on the task, the report is still on the ticket, and nothing is corrupted.
 */
export const researchTriggerHandlers = (options: {
  readonly jobs: Jobs;
  readonly logger?: Logger;
}): readonly EventHandler[] => [
  {
    name: RESEARCH_ARTIFACT_HANDLER,
    priority: 95,
    eventTypes: ['artifact.created'],
    handle: async (context) => {
      const event = context.event.event;
      if (event.type !== 'artifact.created') return;
      if (event.payload.artifact.artifact_type !== 'ResearchReport') return;
      const data: KnowledgeProposalsData = {
        project_id: event.payload.project_id,
        task_id: event.payload.task_id,
        artifact_id: event.payload.artifact.id,
        artifact_type: 'ResearchReport',
      };
      context.afterCommit(async () => {
        await options.jobs.enqueue<KnowledgeProposalsData>({
          queue: JOB_QUEUES.knowledgeProposals,
          data,
        });
        (options.logger ?? silentLogger).debug(
          { project_id: data.project_id, task_id: data.task_id },
          'research page queueing requested',
        );
      });
    },
  },
];

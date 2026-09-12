/**
 * The Librarian pipeline — technical/07 § "Librarian pipeline", steps 2, 3 and 5 (WP-18b).
 *
 * The stage itself is data (`packages/domain/src/pipeline/templates.ts`) and its artifact is
 * `LibrarianProposals`. This module is what happens *after* the artifact is stored: the curation
 * that turns model output into `kb_proposals` rows, BD-018's apply policy, and the wake-up that
 * asks the apply job for a commit.
 *
 * ## Handler decides, job writes — and here the job does the reading too
 *
 * The `artifact.created` handler enqueues and nothing else. Everything the curation needs is I/O —
 * the project row, the indexed paths, the artifact, the task — and a handler runs inside the
 * dispatcher's transaction, where every read is a nested pool borrow (PROGRESS backlog 19). So the
 * shape is the one CLAUDE.md prescribes and `stage-executor.ts` already uses: **no transaction
 * while reading, one transaction to write**.
 *
 * The residual is stated rather than implied. `HandlerContext.afterCommit` is at-most-once
 * (TD-004), so a process that dies between the handler's commit and its enqueue loses the wake-up,
 * and this project's proposals are never recorded. That is a **notification-shaped** loss, which is
 * the direction standing rule 20 says to fail in: nothing is corrupted, the artifact is still on the
 * task, and the next retrospective proposes again. What is *not* recovered automatically is this
 * one batch — the nightly pass recovers an **approved** proposal that was never applied, which is
 * the loss that costs a human's decision, and deliberately not this one.
 *
 * ## Redaction happens once, before the curation (TD-012)
 *
 * A proposal's text is model output on its way to **two** sinks — a `kb_proposals` row and a commit
 * on the project's repository — so it passes the redactor once, here, and every later reader sees
 * the redacted bytes. Redact-then-bound rather than bound-then-redact, for the reason
 * `ticket-snapshot.ts` states at its own cap: an exact-match redactor cannot find a secret a cut has
 * already halved.
 */
import type { Id, IsoDateTime, JsonValue, LibrarianProposal, TaskMode } from '@platform/contracts';
import {
  knowledgeProposalCreatedEvent,
  knowledgeProposalRecordSchema,
  librarianProposalsDataSchema,
} from '@platform/contracts';
import type { Clock, CuratedProposal, IdSource, KnowledgeApplyThresholds } from '@platform/domain';
import { curateProposals, knowledgeApplyThresholds } from '@platform/domain';
import type { EventHandler } from '../events/handler.js';
import type { EventStore } from '../ports/event-store.js';
import type { SecretRedactor } from '../ports/integrations/audit.js';
import type { JobHandler, Jobs } from '../ports/jobs.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { enqueueKnowledgeApply } from './apply.js';
import type { KnowledgeProposalStore, KnowledgeStore, StoredKnowledgeProposal } from './ports.js';

/** `knowledge.proposals` payload — snake_case, like every other payload on the wire. */
export interface KnowledgeProposalsData {
  readonly project_id: string;
  readonly task_id: string;
  readonly artifact_id: string;
  readonly [key: string]: unknown;
}

/** What the job re-reads about the project when it fires (TD-004: a job is a wake-up). */
export interface LibrarianProject {
  /** `projects.knowledge_dir`, default `.agentic/knowledge`. */
  readonly knowledgeDir: string;
  /** `policies.knowledge_apply` from the project's effective configuration (BD-018). */
  readonly thresholds: KnowledgeApplyThresholds;
}

/** The artifact and the task the job curates, as the store hands them back. */
export interface LibrarianArtifact {
  readonly data: JsonValue;
  readonly runId: Id | null;
  readonly taskMode: TaskMode;
}

export interface LibrarianJobOptions {
  readonly unitOfWork: UnitOfWork;
  readonly eventStore: EventStore;
  readonly proposals: KnowledgeProposalStore;
  readonly knowledge: KnowledgeStore;
  readonly jobs: Jobs;
  readonly clock: Clock;
  readonly ids: IdSource;
  /**
   * TD-012 over proposal text, **required**: a redactor a composition root may omit is one
   * production omits (standing rule 31), and this text is written to a row and to a commit.
   */
  readonly redactor: SecretRedactor;
  /** One `projects` read — the shape `KnowledgeIndexJobOptions.project` uses, for the same reason. */
  readonly project: (projectId: Id) => Promise<LibrarianProject | null>;
  /** The artifact's `data` and the task's mode, or `null` when either has gone. */
  readonly artifact: (input: {
    readonly taskId: Id;
    readonly artifactId: Id;
  }) => Promise<LibrarianArtifact | null>;
  readonly logger?: Logger;
}

/** What one curation run did, returned for the log and asserted by the tests. */
export interface CurationReport {
  readonly status: 'recorded' | 'skipped';
  readonly reason: string | null;
  readonly queued: number;
  readonly autoApplied: number;
  readonly discarded: number;
  readonly redactions: number;
}

const EMPTY_REPORT: CurationReport = {
  status: 'skipped',
  reason: null,
  queued: 0,
  autoApplied: 0,
  discarded: 0,
  redactions: 0,
};

/**
 * The whole of one proposal's text through the redactor, counted.
 *
 * `reason` is redacted too although nothing commits it: it is model prose that goes into a row and
 * into the API response the proposals screen renders, and TD-012's list is "every write", not
 * "every write that reaches git".
 */
const redactProposal = (
  proposal: LibrarianProposal,
  redactor: SecretRedactor,
  tally: { count: number },
): LibrarianProposal => {
  const text = (value: string): string => {
    const outcome = redactor.redactText(value);
    tally.count += outcome.count;
    return outcome.value;
  };
  return {
    ...proposal,
    target_path: text(proposal.target_path),
    delta: text(proposal.delta),
    reason: text(proposal.reason),
    evidence: proposal.evidence.map(text),
  };
};

const rowFor = (
  curated: CuratedProposal,
  input: {
    readonly id: Id;
    readonly projectId: Id;
    readonly taskId: Id;
    readonly runId: Id | null;
    readonly createdAt: IsoDateTime;
  },
): StoredKnowledgeProposal => ({
  id: input.id,
  projectId: input.projectId,
  taskId: input.taskId,
  runId: input.runId,
  // technical/03's `knowledge_proposal_source`: this one came from a task's retrospective loop.
  source: 'task',
  kind: curated.proposal.kind,
  type: curated.proposal.type,
  // A refused proposal has no repository path by construction, and the row still has to say what
  // the model asked for — so the model's own (redacted) target is stored when there is no join.
  targetPath: curated.repoPath ?? curated.proposal.target_path,
  delta: curated.proposal.delta,
  evidence: curated.proposal.evidence,
  significance: curated.proposal.significance,
  status: curated.status,
  decidedByUserId: null,
  decidedAt: null,
  appliedCommitSha: null,
  createdAt: input.createdAt,
});

/**
 * Curates one Librarian artifact into rows, and asks for a commit when the policy decided on one.
 *
 * Exported separately from the job handler so a test can drive it directly and read the report; the
 * handler is the same call plus logging.
 */
export const recordLibrarianProposals = async (
  options: LibrarianJobOptions,
  data: KnowledgeProposalsData,
): Promise<CurationReport> => {
  const projectId = data.project_id as Id;
  const taskId = data.task_id as Id;
  const project = await options.project(projectId);
  if (project === null) {
    return { ...EMPTY_REPORT, reason: 'the project no longer has a row' };
  }
  const artifact = await options.artifact({ taskId, artifactId: data.artifact_id as Id });
  if (artifact === null) {
    return { ...EMPTY_REPORT, reason: 'the artifact or its task no longer exists' };
  }

  // Re-validated here although the runner validated it on the way in: this row may have been
  // written by an older build, and a strict parse is what makes every field below a value the
  // schema admits rather than whatever JSON is in the column (BD-022).
  const parsed = librarianProposalsDataSchema.safeParse(artifact.data);
  if (!parsed.success) {
    return {
      ...EMPTY_REPORT,
      reason: `the stored artifact does not match the LibrarianProposals schema: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
    };
  }

  const tally = { count: 0 };
  const redacted = parsed.data.proposals.map((proposal) =>
    redactProposal(proposal, options.redactor, tally),
  );
  const indexed = await options.knowledge.readIndexedBlobs(projectId);
  const curated = curateProposals({
    proposals: redacted,
    knowledgeDir: project.knowledgeDir,
    indexedPaths: [...indexed.keys()],
    thresholds: project.thresholds,
    shadow: artifact.taskMode === 'shadow',
  });

  if (curated.length === 0) {
    return { ...EMPTY_REPORT, reason: 'the Librarian proposed nothing' };
  }

  const createdAt = options.clock.now();
  const rows = curated.map((entry) =>
    rowFor(entry, {
      id: options.ids.next(),
      projectId,
      taskId,
      runId: artifact.runId,
      createdAt,
    }),
  );

  const streamSeq = await options.eventStore.nextStreamSequence('project', projectId);
  await options.unitOfWork.transaction(async (scope) => {
    await options.proposals.insert(scope.tx, rows);
    await scope.events.append(
      rows.map((row, index) =>
        knowledgeProposalCreatedEvent.parse({
          id: options.ids.next(),
          stream_type: 'project',
          stream_id: projectId,
          stream_seq: streamSeq + index,
          actor: { kind: 'system', component: 'librarian' },
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
      ),
    );
  });

  const autoApplied = rows.filter((row) => row.status === 'auto_applied').length;
  if (autoApplied > 0) {
    // Outside the transaction, because `Jobs.enqueue` does not join it (TD-004). A lost enqueue is
    // recovered by the nightly pass, which is what `projectsAwaitingApply` exists for.
    await enqueueKnowledgeApply(options.jobs, { projectId, reason: 'auto_apply' });
  }

  return {
    status: 'recorded',
    reason: null,
    queued: rows.filter((row) => row.status === 'queued').length,
    autoApplied,
    discarded: rows.filter((row) => row.status === 'discarded').length,
    redactions: tally.count,
  };
};

export const librarianProposalsHandler =
  (options: LibrarianJobOptions): JobHandler<KnowledgeProposalsData> =>
  async (job) => {
    const logger = options.logger ?? silentLogger;
    const report = await recordLibrarianProposals(options, job.data);
    const fields = {
      project_id: job.data.project_id,
      task_id: job.data.task_id,
      artifact_id: job.data.artifact_id,
      status: report.status,
      queued: report.queued,
      auto_applied: report.autoApplied,
      discarded: report.discarded,
      redactions: report.redactions,
      reason: report.reason,
    };
    if (report.status === 'skipped') {
      // Not a thrown error: every skip here is a state the platform can be in legitimately (a
      // deleted project, a superseded artifact) and a throw would spend two pg-boss retries on it.
      logger.warn(fields, 'a librarian curation run recorded nothing');
      return;
    }
    logger.info(fields, 'librarian proposals recorded');
  };

/** TD-005's core band, behind the pipeline's own transitions — the same band the indexer uses. */
export const LIBRARIAN_TRIGGER_PRIORITY = 95;

export const LIBRARIAN_ARTIFACT_HANDLER = 'knowledge.librarian.artifact';

/**
 * The one handler: a `LibrarianProposals` artifact was stored, so curate it.
 *
 * It reads nothing and writes nothing — see the module docblock. `artifact.created` is already a
 * consumed event (WP-19's cost projection handles it), so this adds a handler to an event the
 * deployment already dispatches rather than changing what `EVENT_CONSUMPTION` declares.
 */
export const librarianTriggerHandlers = (options: {
  readonly jobs: Jobs;
  readonly logger?: Logger;
}): readonly EventHandler[] => [
  {
    name: LIBRARIAN_ARTIFACT_HANDLER,
    priority: LIBRARIAN_TRIGGER_PRIORITY,
    eventTypes: ['artifact.created'],
    handle: async (context) => {
      const event = context.event.event;
      if (event.type !== 'artifact.created') return;
      if (event.payload.artifact.artifact_type !== 'LibrarianProposals') return;
      const data: KnowledgeProposalsData = {
        project_id: event.payload.project_id,
        task_id: event.payload.task_id,
        artifact_id: event.payload.artifact.id,
      };
      context.afterCommit(async () => {
        await options.jobs.enqueue<KnowledgeProposalsData>({
          queue: JOB_QUEUES.knowledgeProposals,
          data,
        });
        (options.logger ?? silentLogger).debug(
          { project_id: data.project_id, task_id: data.task_id },
          'librarian curation requested',
        );
      });
    },
  },
];

export const declareLibrarianQueues = async (jobs: Jobs): Promise<void> => {
  await jobs.defineQueue({
    name: JOB_QUEUES.knowledgeProposals,
    // `standard`: every wake-up carries a different artifact (see `JOB_QUEUES.knowledgeProposals`).
    policy: 'standard',
    retryLimit: 2,
    retryDelaySeconds: 30,
    retryBackoff: true,
  });
};

/** The thresholds a project's stored configuration implies, for a composition root's `project`. */
export const thresholdsFromConfig = (
  config: { readonly policies?: { readonly knowledge_apply?: unknown } } | null | undefined,
): KnowledgeApplyThresholds =>
  knowledgeApplyThresholds(
    (config?.policies?.knowledge_apply ?? null) as Parameters<typeof knowledgeApplyThresholds>[0],
  );

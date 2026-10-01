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
 * **The lost wake-up this residual used to state is recovered since WP-48** (PROGRESS backlog 36).
 * `HandlerContext.afterCommit` is at-most-once (TD-004), so a process that dies between the
 * handler's commit and its enqueue still loses the wake-up — but `recovery/stranded.ts` now finds
 * the artifact nothing curated and enqueues it again, once, and gives up with a reason if that does
 * not take. Two things made that possible and both are here: `KnowledgeProposalStore.markCurated`
 * writes `knowledge_curations` **in the transaction that writes the proposals**, so a curation that
 * proposed nothing is distinguishable from one that never ran (standing rule 18) and a second
 * delivery writes one set of rows rather than two; and {@link enqueueCuration} is the only enqueue
 * site, so the queue's `stately` policy has an artifact-shaped key to collapse on.
 *
 * ## Redaction happens once, before the curation (TD-012)
 *
 * A proposal's text is model output on its way to **two** sinks — a `kb_proposals` row and a commit
 * on the project's repository — so it passes the redactor once, here, and every later reader sees
 * the redacted bytes. Redact-then-bound rather than bound-then-redact, for the reason
 * `ticket-snapshot.ts` states at its own cap: an exact-match redactor cannot find a secret a cut has
 * already halved.
 */
import type {
  Id,
  IsoDateTime,
  JsonValue,
  LibrarianProposal,
  MaterialisedAutonomy,
  TaskMode,
} from '@platform/contracts';
import {
  knowledgeProposalCreatedEvent,
  knowledgeProposalRecordSchema,
  librarianProposalsDataSchema,
} from '@platform/contracts';
import type {
  AutonomyOverrideSource,
  Clock,
  CuratedProposal,
  IdSource,
  KnowledgeApplyThresholds,
} from '@platform/domain';
import {
  curateProposals,
  effectiveAutonomyPreset,
  knowledgeApplyThresholds,
} from '@platform/domain';
import type { EventHandler } from '../events/handler.js';
import { appendOnProjectWithRetry } from '../pipeline/project-stream.js';
import { ProjectSettingsInvalidError } from '../pipeline/settings.js';
import type { EventStore } from '../ports/event-store.js';
import type { SecretRedactor } from '../ports/integrations/audit.js';
import { jobQueueDefinition } from '../ports/job-queues.js';
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
  /**
   * Which curation this wake-up is for — absent means the Librarian's, which is what every job
   * enqueued before WP-40 carries (`createLibrarianRuntime` dispatches on it).
   *
   * A second **artifact type** on one queue rather than a second queue, because everything a
   * curation needs is already composed for this one: the project's `knowledge_dir`, the indexed
   * paths, the artifact, the redactor, the ids and the clock. `knowledge/research.ts` has the
   * argument for reusing the proposal queue at all.
   */
  readonly artifact_type?: 'LibrarianProposals' | 'ResearchReport';
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
  /**
   * The task's ticket key (WP-40).
   *
   * Read here rather than carried on the job payload because a job re-reads committed state when it
   * fires (TD-004), and it is the same query that already answers `taskMode`. The Librarian's own
   * curation does not use it; a spike's research page is filed at `research/<ticket-key>.md`, which
   * is the **platform's** path rather than the model's.
   */
  readonly ticketKey: string;
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
  /**
   * One `projects` read — the shape `KnowledgeIndexJobOptions.project` uses, for the same reason.
   *
   * It reads the project's stored settings (`policies.knowledge_apply`, the dial) **parsed**, and
   * throws `ProjectSettingsInvalidError` when they do not parse (WP-106): the curation records that
   * refusal ({@link readLibrarianProject}) rather than deciding auto-apply on a document it cannot
   * read.
   */
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
  /**
   * `refused` (WP-106): the project's stored settings do not parse, so nothing was curated and the
   * artifact was **not** marked curated. The reason names the keys. The recovery pass offers it
   * once more (bounded by `knowledge_curations.recovery_attempted_at`, WP-48) and then abandons it
   * with a reason, so a document still broken by then costs that task's proposals — notification-
   * shaped, which is why the bound is one re-offer rather than for ever (standing rule 20).
   */
  readonly status: 'recorded' | 'skipped' | 'refused';
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
 * {@link LibrarianJobOptions.project}, with a stored settings document this release cannot parse
 * answered as a **refusal** rather than an exception (WP-106, PROGRESS backlog 311).
 *
 * A refusal, not a throw, for the reason `librarianProposalsHandler` gives every skip: a throw
 * would spend pg-boss's retries on a document no retry can fix. And not a skip that marks the
 * artifact curated, because that would drop the proposals at once; the artifact stays uncurated, so
 * the recovery pass offers it once more ({@link CurationReport.status} has the bound). Any other
 * error still escapes.
 */
export const readLibrarianProject = async (
  options: Pick<LibrarianJobOptions, 'project'>,
  projectId: Id,
): Promise<
  | { readonly kind: 'read'; readonly project: LibrarianProject | null }
  | { readonly kind: 'refused'; readonly reason: string }
> => {
  try {
    return { kind: 'read', project: await options.project(projectId) };
  } catch (error) {
    if (error instanceof ProjectSettingsInvalidError) {
      return { kind: 'refused', reason: error.message };
    }
    throw error;
  }
};

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
  const read = await readLibrarianProject(options, projectId);
  if (read.kind === 'refused') {
    return { ...EMPTY_REPORT, status: 'refused', reason: read.reason };
  }
  const { project } = read;
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
    /**
     * **The mark is written even here, and that is the whole of backlog 36's blocker** (WP-48).
     *
     * A curation that ran and proposed nothing writes no `kb_proposals` row, so without this the
     * recovery pass could not tell it from one whose wake-up was lost and would re-run the curation
     * of every quiet task for ever (standing rule 18). `proposals: 0` on the row is the finding.
     */
    await options.unitOfWork.transaction(async (scope) => {
      await options.proposals.markCurated(scope.tx, {
        artifactId: data.artifact_id as Id,
        at: options.clock.now(),
        proposals: 0,
      });
    });
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

  // A lost sequence race re-runs this transaction — the claim with it, which rolled back — and
  // nothing above it (WP-109, backlog 333).
  const claimed = await appendOnProjectWithRetry(
    options,
    { projectId, writer: 'knowledge_curation' },
    async (scope, streamSeq) => {
      /**
       * The claim that makes the whole transaction idempotent (WP-48) — `record.ts`'s
       * `markChunkRecorded` one feature across. `curated_at is null` is in the predicate, so a second
       * delivery of this wake-up — which the recovery pass deliberately creates — writes no second
       * set of proposals and appends no second event.
       */
      if (
        !(await options.proposals.markCurated(scope.tx, {
          artifactId: data.artifact_id as Id,
          at: createdAt,
          proposals: rows.length,
        }))
      ) {
        return false;
      }
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
      return true;
    },
  );

  if (!claimed) {
    return { ...EMPTY_REPORT, reason: 'another delivery curated this artifact first' };
  }

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
    if (report.status === 'refused') {
      logger.warn(
        fields,
        'a librarian curation run was refused: the project’s stored settings do not parse, so nothing was curated; the recovery pass offers the artifact once more',
      );
      return;
    }
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
        await enqueueCuration(options.jobs, data);
        (options.logger ?? silentLogger).debug(
          { project_id: data.project_id, task_id: data.task_id },
          'librarian curation requested',
        );
      });
    },
  },
];

export const declareLibrarianQueues = async (jobs: Jobs): Promise<void> => {
  await jobs.defineQueue(jobQueueDefinition(JOB_QUEUES.knowledgeProposals));
};

/**
 * The **only** way a curation is asked for — the handler's, the research handler's and the
 * recovery pass's (WP-48, PROGRESS backlog 36).
 *
 * The queue was `standard` with no key, on the reasoning that *"each wake-up carries a different
 * artifact, so a coalescing policy would silently drop one task's proposals in favour of another's"*
 * — which is true of a key that is the **queue** and false of a key that is the **artifact**. With
 * `artifact:<id>` two tasks' curations never contend, and a second wake-up for the *same* artifact
 * — which this pass deliberately creates — collapses instead of running the curation twice.
 *
 * It is belt and braces rather than the guarantee: the durable one is
 * `KnowledgeProposalStore.markCurated`, which claims the artifact inside the write transaction, so
 * a redelivery after the first job **completed** (when the queue's key is free again) still writes
 * no second set of proposals. The key saves the work; the claim is what makes the result right.
 *
 * Every enqueue goes through here because a job put on a `stately` queue with **no** key takes the
 * queue-wide key, which is exactly the collapse the old comment warned about.
 */
export const enqueueCuration = async (jobs: Jobs, data: KnowledgeProposalsData): Promise<void> => {
  await jobs.enqueue<KnowledgeProposalsData>({
    queue: JOB_QUEUES.knowledgeProposals,
    data,
    singletonKey: `artifact:${data.artifact_id}`,
  });
};

/**
 * The thresholds a project's stored configuration **and its dial** imply, for a composition root's
 * `project` (WP-62, backlog 72 (a)).
 *
 * `policies.knowledge_apply.auto_apply` in the document is the override; where it is silent the
 * project's `knowledgeAutoApply` decides — read off the **materialised** preset (BD-027:14), so
 * Autonomous auto-applies the middle band and Supervised does not. `autonomy` is `null` for a
 * project whose dial was never materialised, which keeps the platform default rather than
 * substituting a preset (standing rule 16).
 */
export const thresholdsFromConfig = (
  config:
    | {
        readonly policies?: { readonly knowledge_apply?: unknown };
      }
    | null
    | undefined,
  autonomy: MaterialisedAutonomy | null,
): KnowledgeApplyThresholds => {
  const policy = (config?.policies?.knowledge_apply ?? null) as Parameters<
    typeof knowledgeApplyThresholds
  >[0];
  const knowledgeAutoApply =
    autonomy === null
      ? undefined
      : effectiveAutonomyPreset(autonomy, config as AutonomyOverrideSource).knowledgeAutoApply;
  return knowledgeApplyThresholds(policy, knowledgeAutoApply);
};

/**
 * What happens after a discovery run finishes — product/06 § "Step 2", product/17 (WP-21).
 *
 * One wake-up, two writes, one transaction:
 *
 *  1. the **readiness evaluation** (`readiness_evaluations` + the narrow `projects.readiness_level`
 *     write), which is the row `GET /api/projects/:id/readiness` has never had a producer for;
 *  2. the drafted pages as **knowledge proposals** (`kb_proposals`, source `bootstrap`), which is
 *     product/06's *"the draft is shown as a diff for the engineer to edit and accept. Nothing is
 *     committed without acceptance."*
 *
 * ## Why the draft goes through the proposal queue rather than into a table of its own
 *
 * The queue already is the thing product/06 asks for: a page with its provenance, a maintainer's
 * decision, and — once approved — a commit on an `agentic/knowledge/*` branch with a merge request
 * and never onto the default branch (`knowledge/apply.ts`). A second reviewable store for the same
 * kind of artefact would be a second apply path, a second decision endpoint and a second screen.
 * The only thing this module adds is the **source**: `bootstrap`, which is technical/03's own name
 * for "came from onboarding" and is what tells a reader in the queue that a human has not seen this
 * repository yet.
 *
 * ## Nothing a discovery run drafts is ever auto-applied
 *
 * The curator's thresholds are {@link DISCOVERY_PROPOSAL_THRESHOLDS} — forced, **not** read from
 * the project's `policies.knowledge_apply`. BD-018's auto-apply band is a judgement about a
 * Librarian that has watched a project deliver tasks; a discovery run is the platform's *first*
 * look at a repository it has never seen, and product/06 says in as many words that nothing is
 * committed without acceptance. So the band is empty here and every page is queued.
 *
 * ## Handler decides, job writes — and the reads happen in the job
 *
 * The same shape `librarian.ts` uses and for the same reason: everything this needs is I/O (the
 * project row, the artifact, the index, a git-provider read for R9), and a handler runs inside the
 * dispatcher's transaction where every read is a nested pool borrow (PROGRESS backlog 19). The
 * `artifact.created` handler enqueues and nothing else.
 *
 * The residual is the one `librarian.ts` states: `HandlerContext.afterCommit` is at-most-once, so a
 * process that dies between the handler's commit and its enqueue loses this wake-up and the project
 * keeps its previous readiness evaluation (or none). That is notification-shaped loss, which is the
 * direction standing rule 20 says to fail in — the artifact is still on the task and the wizard can
 * ask for the evaluation again. It is **not** silently invisible: `GET …/readiness` still answers
 * 409 with the row count, which is the operator-facing difference between "no producer" and "this
 * project's producer did not run".
 *
 * ## The byte budget (standing rule 63)
 *
 * Two caps, both on model output, both applied after redaction:
 *
 *  - a drafted page is at most `MAX_PROPOSAL_DELTA_BYTES` (64 KiB) — the curator's own cap, shared
 *    with the Librarian so one page has one budget;
 *  - at most {@link MAX_DISCOVERY_DOCUMENTS} pages are curated, and the rest are recorded as
 *    refusals rather than dropped.
 *
 * So one discovery run writes at most `MAX_DISCOVERY_DOCUMENTS × MAX_PROPOSAL_DELTA_BYTES` of page
 * text — **1.25 MiB** at the shipped constants (20 × 64 KiB) — plus the evaluation's `14 × 600`
 * characters of evidence (`evaluate-readiness.ts` derives that one). The figure is quoted from the
 * constants rather than carried beside them for the reason PROGRESS backlog 22 records: this
 * sentence said 2.5 MiB while the constant said 20, and a number a reader cannot re-derive from the
 * line below it is a number that has already drifted. `record.test.ts` pins the product.
 */
import type {
  DiscoveryDraftData,
  Id,
  IsoDateTime,
  JsonValue,
  LibrarianProposal,
} from '@platform/contracts';
import {
  discoveryDraftDataSchema,
  knowledgeProposalCreatedEvent,
  knowledgeProposalRecordSchema,
} from '@platform/contracts';
import type { Clock, IdSource, KnowledgeApplyThresholds } from '@platform/domain';
import { curateProposals, MAX_PROPOSALS_PER_RUN } from '@platform/domain';
import type { EventHandler } from '../events/handler.js';
import type {
  KnowledgeProposalStore,
  KnowledgeStore,
  StoredKnowledgeProposal,
} from '../knowledge/ports.js';
import type { EventStore } from '../ports/event-store.js';
import type { SecretRedactor } from '../ports/integrations/audit.js';
import type { JobHandler, Jobs } from '../ports/jobs.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { evaluateReadiness } from './evaluate-readiness.js';
import type { PlatformReadinessProbe, ReadinessStore } from './ports.js';

/** `onboarding.discovery` job payload — snake_case, like every other payload on the wire. */
export interface DiscoveryRecordData {
  readonly project_id: string;
  readonly task_id: string;
  readonly artifact_id: string;
  readonly [key: string]: unknown;
}

/**
 * The curator's thresholds for a discovery draft: **nothing is auto-applied**.
 *
 * `discardBelow: 0` keeps every page (a discovery draft has no noise band to discard — a page the
 * agent wrote is a page a human asked for), and `proposalAbove: 0` puts every one of them in the
 * queue whatever its confidence. `autoApply: false` is the belt to that braces: even if a later
 * edit moved the band, the flag alone stops a commit.
 */
export const DISCOVERY_PROPOSAL_THRESHOLDS: KnowledgeApplyThresholds = {
  autoApply: false,
  discardBelow: 0,
  proposalAbove: 0,
};

/**
 * How many drafted pages one discovery run may turn into proposals.
 *
 * It **is** the curator's own `MAX_PROPOSALS_PER_RUN` rather than a second number beside it: a
 * separate cap here would be a value bounded twice, and whichever of the two was looser could
 * never be made to fail (standing rule 41 — the first draft of this file set it to 40 and the
 * curator's 20 caught it). Slicing before the redaction still matters, because redaction is the
 * expensive pass and the artifact's `documents` array has no schema bound of its own.
 */
export const MAX_DISCOVERY_DOCUMENTS = MAX_PROPOSALS_PER_RUN;

/** `confidence` → the significance the queue orders and displays by. */
const SIGNIFICANCE_BY_CONFIDENCE: Readonly<Record<'high' | 'medium' | 'low', number>> = {
  high: 0.9,
  medium: 0.6,
  low: 0.3,
};

/** What the project row tells the job when it fires (TD-004: a job re-reads). */
export interface DiscoveryProject {
  /** `projects.knowledge_dir`, default `.agentic/knowledge`. */
  readonly knowledgeDir: string;
}

/** The artifact and the run that produced it. */
export interface DiscoveryArtifact {
  readonly data: JsonValue;
  readonly runId: Id | null;
}

export interface DiscoveryRecordOptions {
  readonly unitOfWork: UnitOfWork;
  readonly eventStore: EventStore;
  readonly readiness: ReadinessStore;
  readonly proposals: KnowledgeProposalStore;
  readonly knowledge: KnowledgeStore;
  readonly signals: PlatformReadinessProbe;
  readonly clock: Clock;
  readonly ids: IdSource;
  /**
   * TD-012 over everything the run wrote, **required**: a redactor a composition root may omit is
   * one production omits (standing rule 31), and this text lands in two rows and, once a maintainer
   * approves it, in a commit.
   */
  readonly redactor: SecretRedactor;
  readonly project: (projectId: Id) => Promise<DiscoveryProject | null>;
  readonly artifact: (input: {
    readonly taskId: Id;
    readonly artifactId: Id;
  }) => Promise<DiscoveryArtifact | null>;
  readonly logger?: Logger;
}

export interface DiscoveryRecordReport {
  readonly status: 'recorded' | 'skipped';
  readonly reason: string | null;
  readonly level: number | null;
  readonly queued: number;
  readonly discarded: number;
  readonly redactions: number;
}

const EMPTY: DiscoveryRecordReport = {
  status: 'skipped',
  reason: null,
  level: null,
  queued: 0,
  discarded: 0,
  redactions: 0,
};

/** One drafted page as the curator's input. Every string the model wrote is redacted here. */
const proposalsFrom = (
  draft: DiscoveryDraftData,
  redactor: SecretRedactor,
  tally: { count: number },
): readonly LibrarianProposal[] => {
  const text = (value: string): string => {
    const outcome = redactor.redactText(value);
    tally.count += outcome.count;
    return outcome.value;
  };
  return draft.documents.slice(0, MAX_DISCOVERY_DOCUMENTS).map((document) => ({
    // Always `add`: the curator turns it into an `update` when the index already holds the page,
    // which is the dedupe technical/07 step 2 asks for and is fresher than anything a first run
    // could know.
    action: 'add' as const,
    kind: 'technical' as const,
    type: 'doc-update' as const,
    target_path: text(document.path),
    delta: text(document.markdown),
    // Platform text: the confidence marker the Discovery agent's own prompt is written around, so
    // a maintainer reading the queue sees whether the page was verified or inferred.
    evidence: [`drafted by the Discovery agent at onboarding (confidence: ${document.confidence})`],
    significance: SIGNIFICANCE_BY_CONFIDENCE[document.confidence],
    reason: text(document.title),
  }));
};

const rowFor = (
  curated: ReturnType<typeof curateProposals>[number],
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
  // technical/03's `knowledge_proposal_source`: this one came from onboarding, not from a
  // retrospective. It is what tells a reader in the queue that nobody has seen this repository yet.
  source: 'bootstrap',
  kind: curated.proposal.kind,
  type: curated.proposal.type,
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
 * Records one discovery run's findings.
 *
 * Exported separately from the handler so a test can drive it and read the report, the shape
 * `recordLibrarianProposals` uses.
 */
export const recordDiscoveryFindings = async (
  options: DiscoveryRecordOptions,
  data: DiscoveryRecordData,
): Promise<DiscoveryRecordReport> => {
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
  const parsed = discoveryDraftDataSchema.safeParse(artifact.data);
  if (!parsed.success) {
    return {
      ...EMPTY,
      reason: `the stored artifact does not match the DiscoveryDraft schema: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
    };
  }
  const draft = parsed.data;

  // Outside every transaction: the probe reads the index and asks the git provider whether the
  // default branch is protected, and `integrationsForProject` refuses to run inside one.
  const signals = await options.signals.read(projectId);
  const indexed = await options.knowledge.readIndexedBlobs(projectId);

  const tally = { count: 0 };
  const createdAt = options.clock.now();
  const { evaluation, redactions } = evaluateReadiness({
    id: options.ids.next(),
    projectId,
    evaluatedAt: createdAt,
    source: 'discovery',
    agentClaims: draft.readiness,
    signals,
    redactor: options.redactor,
  });
  tally.count += redactions;

  const curated = curateProposals({
    proposals: proposalsFrom(draft, options.redactor, tally),
    knowledgeDir: project.knowledgeDir,
    indexedPaths: [...indexed.keys()],
    thresholds: DISCOVERY_PROPOSAL_THRESHOLDS,
    // Not a shadow task, and saying so rather than leaning on `shadow: true` to force the queue:
    // the flag would put a misleading reason on every row (`a shadow task never writes …`).
    shadow: false,
  });
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
  /**
   * **This transaction is not idempotent, and a pg-boss retry after it commits duplicates it.**
   *
   * The queue is `standard` with `retryLimit: 2`, and a job whose handler throws *after* the commit
   * — or whose lease expires while the process is dying — is re-delivered: a second
   * `readiness_evaluations` row (harmless, `latest` orders by instant) and a second set of
   * `kb_proposals` for the same pages (not harmless — a maintainer sees each page twice). It is the
   * same shape `librarian.ts` has for its own curation and is not a regression introduced here.
   * What would close it is an idempotency key on the **artifact**: a unique index on
   * `kb_proposals (project_id, task_id, target_path)` for a `bootstrap` proposal, or an `insert …
   * on conflict do nothing` keyed by the artifact id, either of which needs a migration.
   */
  await options.unitOfWork.transaction(async (scope) => {
    await options.readiness.record(scope.tx, evaluation);
    if (rows.length > 0) {
      await options.proposals.insert(scope.tx, rows);
    }
    await scope.events.append(
      rows.map((row, index) =>
        knowledgeProposalCreatedEvent.parse({
          id: options.ids.next(),
          stream_type: 'project',
          stream_id: projectId,
          stream_seq: streamSeq + index,
          actor: { kind: 'system', component: 'discovery' },
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

  return {
    status: 'recorded',
    reason: null,
    level: evaluation.level,
    queued: rows.filter((row) => row.status === 'queued').length,
    discarded: rows.filter((row) => row.status === 'discarded').length,
    redactions: tally.count,
  };
};

export const discoveryRecordHandler =
  (options: DiscoveryRecordOptions): JobHandler<DiscoveryRecordData> =>
  async (job) => {
    const logger = options.logger ?? silentLogger;
    const report = await recordDiscoveryFindings(options, job.data);
    const fields = {
      project_id: job.data.project_id,
      task_id: job.data.task_id,
      artifact_id: job.data.artifact_id,
      status: report.status,
      readiness_level: report.level,
      queued: report.queued,
      discarded: report.discarded,
      redactions: report.redactions,
      reason: report.reason,
    };
    if (report.status === 'skipped') {
      // Not a throw: every skip here is a state the platform can legitimately be in (a deleted
      // project, a superseded artifact), and a throw would spend two pg-boss retries on it.
      logger.warn(fields, 'a discovery run recorded nothing');
      return;
    }
    logger.info(fields, 'discovery findings recorded');
  };

/** TD-005's core band, behind the pipeline's own transitions — the band the Librarian uses. */
export const DISCOVERY_TRIGGER_PRIORITY = 95;

export const DISCOVERY_ARTIFACT_HANDLER = 'onboarding.discovery.artifact';

/**
 * The one handler: a `DiscoveryDraft` artifact was stored, so record what it found.
 *
 * It reads nothing and writes nothing — see the module docblock. `artifact.created` is already a
 * consumed event (WP-19's cost projection handles it), so this adds a handler to an event the
 * deployment already dispatches rather than changing what `EVENT_CONSUMPTION` declares.
 */
export const discoveryTriggerHandlers = (options: {
  readonly jobs: Jobs;
  readonly logger?: Logger;
}): readonly EventHandler[] => [
  {
    name: DISCOVERY_ARTIFACT_HANDLER,
    priority: DISCOVERY_TRIGGER_PRIORITY,
    eventTypes: ['artifact.created'],
    handle: async (context) => {
      const event = context.event.event;
      if (event.type !== 'artifact.created') return;
      if (event.payload.artifact.artifact_type !== 'DiscoveryDraft') return;
      const data: DiscoveryRecordData = {
        project_id: event.payload.project_id,
        task_id: event.payload.task_id,
        artifact_id: event.payload.artifact.id,
      };
      context.afterCommit(async () => {
        await options.jobs.enqueue({ queue: JOB_QUEUES.discoveryRecord, data });
      });
    },
  },
];

/** Declares the queue this module's job runs on. Idempotent. */
export const declareDiscoveryRecordQueue = async (jobs: Jobs): Promise<void> => {
  await jobs.defineQueue({
    name: JOB_QUEUES.discoveryRecord,
    // `standard`: every wake-up carries a different artifact (see `JOB_QUEUES.discoveryRecord`).
    policy: 'standard',
    retryLimit: 2,
    retryDelaySeconds: 30,
    retryBackoff: true,
  });
};

/**
 * What happens after a mining run finishes — product/19 §18's last sentence (WP-35).
 *
 * > *"Output goes to the proposal queue only."*
 *
 * One wake-up, one transaction: the run's `HistoryFindings` artifact becomes `kb_proposals` rows
 * with source **`history`**, the chunk is stamped with what it produced, and the batch is completed
 * once every chunk has reported.
 *
 * ## Three rules, and each one is enforced rather than instructed
 *
 * 1. **Every proposal cites evidence that resolves.** `curateHistoryFindings` (domain) refuses a
 *    proposal whose citation is not one of the merge requests or tickets the platform itself put in
 *    that run's prompt — the sample's `evidence_links`, which is why the sample carries them. A
 *    refused proposal is **written as `discarded`** with the platform's reason as its first evidence
 *    line, because technical/07 calls the discard path *"audit only"* and a drop nobody can see is
 *    not an audit. It is also the signal that matters most here: a run whose citations are all
 *    refused is a mining problem, and silence would present it as a run that found nothing.
 * 2. **Nothing is ever auto-applied.** {@link HISTORY_PROPOSAL_THRESHOLDS} is **forced**, not read
 *    from the project's `policies.knowledge_apply`. BD-018's auto-apply band is a judgement about a
 *    Librarian that has watched a project deliver; a bootstrap is the platform's first look at six
 *    months of somebody else's history, and product/06 says in as many words that nothing is
 *    committed without acceptance. A project with `auto_apply: true` still gets a queue, and the
 *    e2e asserts exactly that.
 * 3. **The source says where it came from.** `history`, not `bootstrap`: the latter has one writer,
 *    the Discovery recorder, and a reader of the queue has to be able to tell a page a model
 *    *drafted* from a convention it *mined* with citations a maintainer can follow (migration 0030).
 *
 * ## Handler decides, job writes
 *
 * `librarian.ts`'s shape and for its reason: everything this needs is I/O, and a handler runs inside
 * the dispatcher's transaction where every read is a nested pool borrow (PROGRESS backlog 19). The
 * `artifact.created` handler enqueues and nothing else. The residual is the one that module states:
 * `afterCommit` is at-most-once, so a process that dies between the commit and the enqueue loses
 * this wake-up — the artifact is still on the task, the chunk stays unrecorded, and the batch never
 * completes. That is notification-shaped loss and it is **visible**, which is the difference that
 * matters: `chunks_recorded < chunks` on the batch screen says which run never reported.
 */
import type { HistoryFindingsData, Id, IsoDateTime, JsonValue } from '@platform/contracts';
import {
  historyFindingsDataSchema,
  knowledgeProposalCreatedEvent,
  knowledgeProposalRecordSchema,
} from '@platform/contracts';
import type { KnowledgeApplyThresholds } from '@platform/domain';
import { curateHistoryFindings, curateProposals } from '@platform/domain';
import type { EventHandler } from '../events/handler.js';
import type {
  KnowledgeProposalStore,
  KnowledgeStore,
  StoredKnowledgeProposal,
} from '../knowledge/ports.js';
import type { EventStore } from '../ports/event-store.js';
import type { SecretRedactor } from '../ports/integrations/audit.js';
import type { Jobs } from '../ports/jobs.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import type { HistoryBootstrapStore } from './ports.js';

/**
 * Forced: nothing a mining run proposes is auto-applied, whatever the project's policy says.
 *
 * It is the same table `DISCOVERY_PROPOSAL_THRESHOLDS` is, for the same reason and with one more: a
 * bootstrap writes a dozen pages at once, and a bulk import that could commit itself is the one
 * thing product/06's *"never applied silently"* is about.
 *
 * **Which field does the work, stated because a canary found the answer surprising** (standing rule
 * 22). `dispositionFor` queues anything at or above `proposalAbove` and only consults `autoApply`
 * *inside* the band — so `proposalAbove: 0` is the operative guard here and `autoApply: false` is a
 * second layer the first makes **unreachable**. Both are kept: the day somebody widens the band, the
 * flag is what stops a mined page reaching a repository. A canary that flips only `autoApply` leaves
 * every test green, which is correct rather than a gap, and a canary that opens the band kills three
 * cases by name (`record.test.ts` names the significances that make it so).
 *
 * `discardBelow: 0` keeps every refusal **recorded** rather than dropped — technical/07 calls the
 * discard path "audit only", and a run whose citations were all invented is the signal that matters.
 */
export const HISTORY_PROPOSAL_THRESHOLDS: KnowledgeApplyThresholds = {
  autoApply: false,
  discardBelow: 0,
  proposalAbove: 0,
};

/** What the record half of `bootstrap.history` is woken with. */
export interface HistoryRecordJobData {
  readonly kind: 'record';
  readonly project_id: string;
  readonly task_id: string;
  readonly artifact_id: string;
  readonly [key: string]: unknown;
}

export interface HistoryRecordOptions {
  readonly unitOfWork: UnitOfWork;
  readonly bootstrap: HistoryBootstrapStore;
  readonly proposals: KnowledgeProposalStore;
  readonly knowledge: KnowledgeStore;
  readonly eventStore: EventStore;
  /** The project's row — `knowledge_dir` is what a vault-relative path is joined onto (BD-025). */
  readonly project: (projectId: Id) => Promise<{ readonly knowledgeDir: string } | null>;
  readonly artifact: (query: {
    readonly taskId: Id;
    readonly artifactId: Id;
  }) => Promise<{ readonly data: unknown; readonly runId: Id | null } | null>;
  /** The sample this run was shown — the platform's own record of what it may cite. */
  readonly sample: (taskId: Id) => Promise<{
    readonly merge_requests: readonly {
      readonly ref: string;
      readonly url: string;
      readonly rounds: number;
    }[];
    readonly tickets: readonly { readonly url: string }[];
    readonly evidence_links: readonly string[];
  } | null>;
  readonly redactor: SecretRedactor;
  readonly ids: { next(): Id };
  readonly clock: { now(): IsoDateTime };
  readonly logger?: Logger;
}

export interface HistoryRecordReport {
  readonly status: 'recorded' | 'skipped';
  readonly queued: number;
  readonly refused: number;
  readonly redactions: number;
  readonly reason: string | null;
}

const EMPTY: HistoryRecordReport = {
  status: 'skipped',
  queued: 0,
  refused: 0,
  redactions: 0,
  reason: null,
};

/** The platform's refusal, carried where a maintainer reading the queue will see it. */
const refusalEvidence = (reason: string): string => `refused by the platform: ${reason}`;

/**
 * Records one mining run's findings.
 *
 * Exported separately from the handler so a test can drive it and read the report — the shape
 * `recordDiscoveryFindings` uses.
 */
export const recordHistoryFindings = async (
  options: HistoryRecordOptions,
  data: HistoryRecordJobData,
): Promise<HistoryRecordReport> => {
  const logger = options.logger ?? silentLogger;
  const projectId = data.project_id as Id;
  const taskId = data.task_id as Id;

  const chunk = await options.unitOfWork.transaction(async (scope) =>
    options.bootstrap.chunkOfTask(scope.tx, taskId),
  );
  if (chunk === null) {
    return { ...EMPTY, reason: 'this task is not a mining run of any batch' };
  }
  if (chunk.recordedAt !== null) {
    return { ...EMPTY, reason: 'this chunk has already been recorded' };
  }

  const project = await options.project(projectId);
  if (project === null) {
    return { ...EMPTY, reason: 'the project no longer has a row' };
  }
  const artifact = await options.artifact({ taskId, artifactId: data.artifact_id as Id });
  if (artifact === null) {
    return { ...EMPTY, reason: 'the artifact or its task no longer exists' };
  }
  const sample = await options.sample(taskId);
  if (sample === null) {
    // Without the sample there is nothing to resolve a citation against, and accepting the
    // proposals anyway would publish exactly the unevidenced rows this module exists to refuse.
    return { ...EMPTY, reason: 'the task no longer carries the sample this run was shown' };
  }

  // Re-validated although the runner validated it on the way in: this row may have been written by
  // an older build, and a strict parse is what makes every field below a value the schema admits
  // rather than whatever JSON is in the column (BD-022).
  const parsed = historyFindingsDataSchema.safeParse(artifact.data);
  if (!parsed.success) {
    return {
      ...EMPTY,
      reason: `the stored artifact does not match the HistoryFindings schema: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
    };
  }
  const findings: HistoryFindingsData = parsed.data;

  const tally = { count: 0 };
  const text = (value: string): string => {
    const outcome = options.redactor.redactText(value);
    tally.count += outcome.count;
    return outcome.value;
  };

  const curated = curateHistoryFindings({
    proposals: findings.proposals,
    sample: {
      merge_requests: sample.merge_requests.map((mr) => ({
        ref: mr.ref,
        url: mr.url,
        rounds: mr.rounds,
        // The rest of `HistoryMergeRequest` is not read by the curator; these three are.
        title: '',
        author: '',
        merged_at: '1970-01-01T00:00:00.000Z' as IsoDateTime,
        files_changed: null,
        notes: [],
        truncated: false,
      })),
      tickets: sample.tickets.map((ticket) => ({
        key: '',
        url: ticket.url,
        title: '',
        description: '',
        comments: [],
        truncated: false,
      })),
      evidence_links: [...sample.evidence_links],
    },
  });

  const indexed = await options.knowledge.readIndexedBlobs(projectId);
  const accepted = curated.filter((entry) => entry.librarian !== null);
  const refused = curated.filter((entry) => entry.librarian === null);

  // Redacted **here** and not in the curator: the curator is pure domain code with no redactor, and
  // the text only becomes storage at this boundary (TD-012's write list).
  const librarian = accepted.map((entry) => {
    const proposal = entry.librarian as NonNullable<typeof entry.librarian>;
    return {
      ...proposal,
      target_path: text(proposal.target_path),
      delta: text(proposal.delta),
      reason: text(proposal.reason),
      evidence: proposal.evidence.map(text),
    };
  });

  const acceptedRows = curateProposals({
    proposals: librarian,
    knowledgeDir: project.knowledgeDir,
    indexedPaths: [...indexed.keys()],
    thresholds: HISTORY_PROPOSAL_THRESHOLDS,
    // Not a shadow task, and saying so rather than leaning on `shadow: true` to force the queue:
    // the flag would put a misleading reason on every row (`onboarding/record.ts`'s answer).
    shadow: false,
  });

  const createdAt = options.clock.now();
  const rows: StoredKnowledgeProposal[] = [
    ...acceptedRows.map((entry) => ({
      id: options.ids.next(),
      projectId,
      taskId,
      runId: artifact.runId,
      // technical/03's `knowledge_proposal_source`, and the value migration 0030 added: mined from
      // merged history, as opposed to `bootstrap`, which is the Discovery agent's drafted page.
      source: 'history' as const,
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
    })),
    ...refused.map((entry) => ({
      id: options.ids.next(),
      projectId,
      taskId,
      runId: artifact.runId,
      source: 'history' as const,
      kind: entry.proposal.kind,
      type: entry.proposal.type,
      // The model's path, unjoined: a refused proposal writes nothing, so it needs no repository
      // path — and joining one would make a row that looks applicable.
      targetPath: text(entry.proposal.target_path),
      delta: text(entry.proposal.delta),
      evidence: [
        refusalEvidence(entry.refusedReason as string),
        ...entry.proposal.evidence.map((citation) => text(`${citation.ref} ${citation.url}`)),
      ],
      significance: entry.proposal.significance,
      status: 'discarded' as const,
      decidedByUserId: null,
      decidedAt: null,
      appliedCommitSha: null,
      createdAt,
    })),
  ];

  const streamSeq = await options.eventStore.nextStreamSequence('project', projectId);
  const outcome = await options.unitOfWork.transaction(async (scope) => {
    // The claim that makes the whole transaction idempotent: `recorded_at is null` is in the
    // predicate, so a redelivery that raced this one writes nothing and appends no event.
    const claimed = await options.bootstrap.markChunkRecorded(scope.tx, chunk.id, {
      at: createdAt,
      proposals: rows.filter((row) => row.status === 'queued').length,
      refusedProposals: rows.filter((row) => row.status !== 'queued').length,
    });
    if (!claimed) {
      return { written: false, completed: false };
    }
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
          actor: { kind: 'system', component: 'history_bootstrap' },
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
            }) as JsonValue,
          },
        }),
      ),
    );
    const completed = await options.bootstrap.completeIfDone(scope.tx, chunk.batchId, createdAt);
    return { written: true, completed };
  });

  if (!outcome.written) {
    return { ...EMPTY, reason: 'another delivery recorded this chunk first' };
  }

  const report: HistoryRecordReport = {
    status: 'recorded',
    queued: rows.filter((row) => row.status === 'queued').length,
    refused: rows.filter((row) => row.status !== 'queued').length,
    redactions: tally.count,
    reason: null,
  };
  logger.info(
    {
      project_id: projectId,
      task_id: taskId,
      batch_id: chunk.batchId,
      chunk: chunk.chunkIndex,
      queued: report.queued,
      refused: report.refused,
      // The model's own claim about its coverage, beside the platform's count of what it was shown.
      merge_requests_read: findings.merge_requests_read,
      merge_requests_given: chunk.mergeRequests,
      redactions: report.redactions,
      batch_completed: outcome.completed,
    },
    'a history mining run recorded its findings',
  );
  return report;
};

/** TD-005's core band, behind the pipeline's own transitions — the band the Librarian uses. */
export const HISTORY_TRIGGER_PRIORITY = 96;

export const HISTORY_ARTIFACT_HANDLER = 'bootstrap.history.artifact';

/**
 * The one handler: a `HistoryFindings` artifact was stored, so record what it found.
 *
 * It reads nothing and writes nothing — see the module docblock. `artifact.created` is already a
 * consumed event (WP-19's cost projection handles it), so this adds a handler to an event the
 * deployment already dispatches rather than changing what `EVENT_CONSUMPTION` declares.
 */
export const historyTriggerHandlers = (options: {
  readonly jobs: Jobs;
  readonly logger?: Logger;
}): readonly EventHandler[] => [
  {
    name: HISTORY_ARTIFACT_HANDLER,
    priority: HISTORY_TRIGGER_PRIORITY,
    eventTypes: ['artifact.created'],
    handle: async (context) => {
      const event = context.event.event;
      if (event.type !== 'artifact.created') return;
      if (event.payload.artifact.artifact_type !== 'HistoryFindings') return;
      const data: HistoryRecordJobData = {
        kind: 'record',
        project_id: event.payload.project_id,
        task_id: event.payload.task_id,
        artifact_id: event.payload.artifact.id,
      };
      context.afterCommit(async () => {
        await options.jobs.enqueue({ queue: JOB_QUEUES.historyBootstrap, data });
      });
    },
  },
];

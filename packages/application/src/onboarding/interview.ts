/**
 * Recording the onboarding **business interview** — product/06 § "Step 3", WP-64 (PROGRESS
 * backlog 45).
 *
 * > "Answers become `business/*.md` pages plus glossary entries; the agent shows the generated
 * > pages for edit and acceptance."
 *
 * One command: a human's answers to product/19 §8's question bank become one **knowledge proposal**
 * per answered section, in the queue, with source `human`. Nothing is committed here — the
 * proposal queue's decision and apply path is the only way a page reaches the repository, and it
 * reaches it as a merge request on an `agentic/knowledge/*` branch (BD-012, BD-007), exactly as a
 * discovery draft does (`record.ts`). That is the whole of product/06's *"shows the generated pages
 * for edit and acceptance"*: the queue already has an edit decision.
 *
 * ## The answers are untrusted text, bounded and redacted like the ticket snapshot
 *
 * They are typed into a browser by a person the platform does not vouch for, they become a
 * repository page, and a page is later read into prompts (BD-022). So every string goes through the
 * caller's redactor **and then** is cut to `MAX_INTERVIEW_ANSWER_CHARS` — redact, then cut, the
 * order `ticket-snapshot.ts` states at its caps, because an exact-match redactor cannot find a
 * secret a cut has already halved — and a cut is **announced in the page** rather than silent.
 * The budget is stated at the constants (`@platform/domain`'s `interview.ts`): one page is at most
 * `MAX_PROPOSAL_DELTA_BYTES`, so eight pages are at most 8 × 64 KiB = 512 KiB per interview.
 *
 * ## Nothing is auto-applied, whatever the project's policy says
 *
 * The curator runs with `DISCOVERY_PROPOSAL_THRESHOLDS` — forced into the queue — for the reason
 * `record.ts` gives for a discovery draft, and a stronger one: product/19 §6 puts *"business rule;
 * change to `direction.md`"* in the band that is *"always proposal, maintainer only"*.
 *
 * ## Why no model writes the pages
 *
 * product/06 describes *"a conversational form driven by the Product Manager role"* that asks *"in
 * the interviewee's language"*. This build ships the form without the conversation: the pages are
 * the answers under platform headings, so what a maintainer approves is what a person said rather
 * than a model's summary of it. That deviation is Q102 in `docs/OPEN-QUESTIONS.md`, with the
 * recommendation this implements.
 */
import type { Id, IsoDateTime, LibrarianProposal } from '@platform/contracts';
import {
  knowledgeProposalCreatedEvent,
  knowledgeProposalRecordSchema,
  MAX_INTERVIEW_ANSWER_CHARS,
  MAX_INTERVIEW_REASON_CHARS,
} from '@platform/contracts';
import type {
  BusinessInterviewEntry,
  BusinessInterviewSection,
  BusinessInterviewSectionId,
  Clock,
  IdSource,
} from '@platform/domain';
import {
  BUSINESS_INTERVIEW_SECTIONS,
  curateProposals,
  renderInterviewPage,
} from '@platform/domain';
import type {
  KnowledgeProposalStore,
  KnowledgeStore,
  StoredKnowledgeProposal,
} from '../knowledge/ports.js';
import { appendOnProjectWithRetry } from '../pipeline/project-stream.js';
import type { EventStore } from '../ports/event-store.js';
import type { SecretRedactor } from '../ports/integrations/audit.js';
import type { Transaction } from '../ports/transaction.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { DISCOVERY_PROPOSAL_THRESHOLDS } from './record.js';

/** One section as the API hands it over — raw, before redaction and the cut. */
export type BusinessInterviewAnswer =
  | { readonly status: 'answered'; readonly text: string }
  | { readonly status: 'not_applicable'; readonly reason?: string };

export type BusinessInterviewAnswers = Readonly<
  Partial<Record<BusinessInterviewSectionId, BusinessInterviewAnswer>>
>;

export interface BusinessInterviewOptions {
  readonly unitOfWork: UnitOfWork;
  readonly eventStore: EventStore;
  readonly proposals: KnowledgeProposalStore;
  readonly knowledge: KnowledgeStore;
  readonly clock: Clock;
  readonly ids: IdSource;
  /** TD-012 over every answer, **required** (standing rule 31). */
  readonly redactor: SecretRedactor;
  /** `projects.knowledge_dir`, or `null` when the project has no row. */
  readonly project: (projectId: Id) => Promise<{ readonly knowledgeDir: string } | null>;
}

export interface RecordedInterviewPage {
  readonly proposalId: Id;
  readonly section: BusinessInterviewSectionId;
  /** Repository-relative: the knowledge directory joined, as the queue stores it. */
  readonly targetPath: string;
  readonly status: StoredKnowledgeProposal['status'];
  readonly truncated: boolean;
}

export type BusinessInterviewResult =
  | {
      readonly status: 'recorded';
      readonly pages: readonly RecordedInterviewPage[];
      /** Replacements the redactor made across every answer, for the audit row and the log. */
      readonly redactions: number;
    }
  | { readonly status: 'not_found' }
  /**
   * `claim` answered that this attempt was already recorded — a concurrent submit under the same
   * `Idempotency-Key` committed first. Nothing was written; the caller answers from that attempt.
   */
  | { readonly status: 'replayed' };

/** What {@link recordBusinessInterview} hands `claim`: the pages it is about to write. */
export interface RecordedInterview {
  readonly pages: readonly RecordedInterviewPage[];
  readonly redactions: number;
}

/** Thrown inside the transaction to roll it back when `claim` refuses; never escapes. */
class InterviewAlreadyRecorded extends Error {
  override readonly name = 'InterviewAlreadyRecorded';
}

/** Redact, then cut, and say whether the cut happened. */
const bounded = (
  raw: string,
  max: number,
  redactor: SecretRedactor,
  tally: { count: number },
): { readonly text: string; readonly truncated: boolean } => {
  const outcome = redactor.redactText(raw);
  tally.count += outcome.count;
  const characters = Array.from(outcome.value);
  return characters.length <= max
    ? { text: outcome.value, truncated: false }
    : // By code point, so a cut never splits a surrogate pair into a character nobody wrote.
      { text: characters.slice(0, max).join(''), truncated: true };
};

const entryOf = (
  answer: BusinessInterviewAnswer,
  redactor: SecretRedactor,
  tally: { count: number },
): BusinessInterviewEntry => {
  if (answer.status === 'not_applicable') {
    const reason = bounded(answer.reason ?? '', MAX_INTERVIEW_REASON_CHARS, redactor, tally);
    return { status: 'not_applicable', reason: reason.text, truncated: reason.truncated };
  }
  const text = bounded(answer.text, MAX_INTERVIEW_ANSWER_CHARS, redactor, tally);
  return { status: 'answered', text: text.text, truncated: text.truncated };
};

const proposalOf = (
  section: BusinessInterviewSection,
  entry: BusinessInterviewEntry,
): LibrarianProposal => ({
  // `add`: the curator turns it into an `update` when the index already holds the page — a project
  // that had a hand-written `business/glossary.md` gets a proposal to replace it, which the
  // maintainer sees as such in the queue.
  action: 'add',
  kind: 'business',
  type: 'doc-update',
  target_path: section.path,
  delta: renderInterviewPage(section, entry),
  // Platform text: where the page came from, never a byte of the answer.
  evidence: [
    `answered in the onboarding business interview (product/06 step 3), section "${section.title}"`,
  ],
  // A person's own answer about their product is the strongest evidence the queue ever holds.
  significance: 0.9,
  reason:
    entry.status === 'not_applicable'
      ? `${section.title}: marked not applicable in the onboarding interview`
      : `${section.title}: from the onboarding interview`,
});

/**
 * The platform's reason on an earlier interview answer a newer submission replaced — the first
 * evidence line of the row, the place `onboarding/record.ts` puts a superseded discovery draft's.
 * Platform text only: an id and an instant.
 */
export const supersededAnswerReason = (userId: Id, createdAt: IsoDateTime): string =>
  `superseded by the platform: a newer business interview answer for this page was submitted by user ${userId} at ${createdAt}`;

/**
 * Discards the **undecided** pages an earlier interview queued for the sections this one answered
 * again (WP-109 review round 1, PROGRESS backlog 370) — backlog 319's option (a), for the interview.
 *
 * Re-submitting step 3 (or the settings page's *Business context*) queued every page a second time
 * beside the first submission's, with nothing saying which was current. The limits are the
 * discovery recorder's, for the same reasons: `queued` rows nobody has decided, and only `human`
 * rows — the interview is the only `human` writer, and a Librarian's or a discovery draft for a
 * `business/` path is another author's claim (discovery refuses `business/` paths in any case).
 * In the interview's own transaction, after its rows are inserted and excluding them by id, so a
 * rolled-back attempt discards nothing.
 */
const supersedeEarlierAnswers = async (
  options: BusinessInterviewOptions,
  tx: Transaction,
  input: {
    readonly projectId: Id;
    readonly userId: Id;
    readonly createdAt: IsoDateTime;
    readonly rows: readonly StoredKnowledgeProposal[];
  },
): Promise<void> => {
  const queued = input.rows.filter((row) => row.status === 'queued');
  if (queued.length === 0) {
    return;
  }
  await options.proposals.supersedeQueued(tx, {
    projectId: input.projectId,
    source: 'human',
    paths: [...new Set(queued.map((row) => row.targetPath))],
    keep: input.rows.map((row) => row.id),
    reason: supersededAnswerReason(input.userId, input.createdAt),
  });
};

/**
 * Records one interview. Every answered or not-applicable section becomes one queued proposal; a
 * section absent from `answers` is a skip and writes nothing.
 */
export const recordBusinessInterview = async (
  options: BusinessInterviewOptions,
  input: {
    readonly projectId: Id;
    /** The interviewee — the actor of the proposal events; the route writes the audit row. */
    readonly userId: Id;
    readonly answers: BusinessInterviewAnswers;
    /**
     * The caller's audit and idempotency record, **inside the transaction that writes the
     * proposals** (WP-64 review round 1). Answering `false` means the attempt is already recorded:
     * the transaction rolls back and nothing is queued twice. The server serialises on the key and
     * re-checks inside it, so a crash between the proposals and the audit row cannot leave one
     * without the other, and a double submit cannot queue the pages twice. **Called once per
     * attempt** since WP-109: a lost project-stream race re-runs the whole transaction, so the claim
     * must be a write on `tx` that rolls back with it — which the server's is — and never a write
     * of its own.
     */
    readonly claim?: (tx: Transaction, recorded: RecordedInterview) => Promise<boolean>;
  },
): Promise<BusinessInterviewResult> => {
  const project = await options.project(input.projectId);
  if (project === null) {
    return { status: 'not_found' };
  }
  const tally = { count: 0 };
  const answered = BUSINESS_INTERVIEW_SECTIONS.flatMap((section) => {
    const answer = input.answers[section.id];
    return answer === undefined
      ? []
      : [{ section, entry: entryOf(answer, options.redactor, tally) }];
  });
  // The index decides add versus update, which the maintainer then sees in the queue.
  const indexed = await options.knowledge.readIndexedBlobs(input.projectId);
  const curated = curateProposals({
    proposals: answered.map(({ section, entry }) => proposalOf(section, entry)),
    knowledgeDir: project.knowledgeDir,
    indexedPaths: [...indexed.keys()],
    thresholds: DISCOVERY_PROPOSAL_THRESHOLDS,
    shadow: false,
  });
  const createdAt: IsoDateTime = options.clock.now();
  const rows: StoredKnowledgeProposal[] = curated.map((entry) => ({
    id: options.ids.next(),
    projectId: input.projectId,
    taskId: null,
    runId: null,
    // technical/03's `knowledge_proposal_source`: a person wrote it. Its first writer.
    source: 'human',
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
  }));

  const recorded: RecordedInterview = {
    pages: rows.map((row, index) => ({
      proposalId: row.id,
      section: (answered[index] as { section: BusinessInterviewSection }).section.id,
      targetPath: row.targetPath,
      status: row.status,
      truncated: (answered[index] as { entry: BusinessInterviewEntry }).entry.truncated,
    })),
    redactions: tally.count,
  };
  const claim = input.claim;
  try {
    /**
     * Through the shared retry (WP-109, backlog 357): another project-stream write between the
     * sequence read and the commit — a discovery record, an index run, a re-check — used to answer
     * the wizard's step 3 with `500 internal_error`. A lost race re-runs the whole transaction, the
     * claim **first** as before: the lost attempt's claim rolled back with its proposals, so a retried
     * attempt still writes exactly one `command_idempotency` row.
     */
    await appendOnProjectWithRetry(
      options,
      { projectId: input.projectId, writer: 'business_interview' },
      async (scope, streamSeq) => {
        // First, so a refused claim writes nothing at all.
        if (claim !== undefined && !(await claim(scope.tx, recorded))) {
          throw new InterviewAlreadyRecorded();
        }
        if (rows.length === 0) {
          return;
        }
        await options.proposals.insert(scope.tx, rows);
        await supersedeEarlierAnswers(options, scope.tx, {
          projectId: input.projectId,
          userId: input.userId,
          createdAt,
          rows,
        });
        await scope.events.append(
          rows.map((row, index) =>
            knowledgeProposalCreatedEvent.parse({
              id: options.ids.next(),
              stream_type: 'project',
              stream_id: input.projectId,
              stream_seq: streamSeq + index,
              actor: { kind: 'user', user_id: input.userId },
              occurred_at: createdAt,
              type: 'knowledge.proposal.created',
              payload: {
                project_id: input.projectId,
                proposal: knowledgeProposalRecordSchema.parse({
                  id: row.id,
                  project_id: row.projectId,
                  task_id: null,
                  run_id: null,
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
      },
    );
  } catch (error) {
    if (error instanceof InterviewAlreadyRecorded) {
      return { status: 'replayed' };
    }
    throw error;
  }

  return { status: 'recorded', ...recorded };
};

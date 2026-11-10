/**
 * **The review conversation on the merge request** — the Reviewer's findings posted as threads, the
 * Developer's replies on each thread it answered, and the Reviewer's resolution of its own threads
 * after a re-review (WP-179, BD-031 ruling 6, TD-029 decision 10, PROGRESS backlog 537 (a) and (b)).
 *
 * ## One handler decides, three duties call
 *
 * WP-15d's shape: {@link reviewConversationHandler} reads the committed artifact inside the
 * dispatcher's transaction and enqueues a `pipeline.outbound` duty after commit; the duty re-reads
 * everything when it fires (a job is a wake-up, TD-004) and makes its provider calls outside every
 * transaction, through `IntegrationActionExecutor` — so shadow mode (`would_have` rows, no write)
 * and the audit apply to every one of them. All three duties are **notification-shaped**
 * (`JOB_EXHAUSTION`): a lost post is a missing note on the merge request, and the artifact it
 * renders is on the task page whatever happens.
 *
 *  - **`review_findings_post`** — after a `code_review` completes, either verdict: one thread per
 *    finding, anchored where both `file` and `line` are present, then one summary note. A finding
 *    whose anchor the provider refuses is re-posted at merge-request level with its location in the
 *    body. Each carries `review_finding:<task>:<run>:<finding>` / `review_summary:<task>:<run>` as
 *    its idempotency key, so a replayed job posts nothing twice — **the key is the guard**, and a
 *    replay with the key dropped duplicates every thread (the canary in the unit suite).
 *  - **`conversation_replies`** — after a developer stage completes with
 *    `ImplementationNotes.thread_replies`: each target is checked against a **fresh**
 *    `listDiscussions` (and the ticket's comments), an unknown one is dropped and logged, and each
 *    reply is posted with `agentic:reply:<task>.<run>.<n>`. A reply to a ticket comment is a ticket
 *    comment with the same marker. **Since S-28.3 (M28 ruling R3)** a `fixed` or `documented`
 *    reply names the commit (*Addressed in `<sha>`*), a person's unresolved resolvable thread every
 *    entry of which is `fixed`/`documented` is then **resolved** (`not_changed` and `needs_person`
 *    leave it open), and a person's open thread the run did not answer gets *"Not addressed in this
 *    run — still open."*, so no thread is left silent.
 *  - **`review_threads_resolve`** — after a `code_review` completes with `resolved_threads`: only a
 *    named thread whose **first** note opens with this task's `review-finding` marker is resolved;
 *    a person's thread never is **by the Reviewer** — the Developer's `fixed`/`documented` reply
 *    resolves it (`conversation_replies`, R3).
 *
 * **The stage job performs them too** (WP-184, `owed-duties.ts`): the next agent stage's
 * `stage.execute` job runs the duties its latest completed agent run owes before it plans, because
 * the planner reads the conversation once and nothing orders this queue against that one. The two
 * performers take turns under the task's `review_conversation` lease (`duty-lease.ts`, taken in
 * `outbound.ts` for these duties), since the executor records a key only after its call; whichever
 * runs second replays.
 *
 * A dial level at which a stage does not run never completes it, so nothing is posted for it. A
 * review-only task (`REVIEW_ONLY_TEMPLATE_ID`) has duties of its own and is skipped here, and a task
 * with no merge request has nothing to post on.
 *
 * ## Its own notes are found by marker — and by author — never by a returned id
 *
 * `replyToDiscussion` may answer a **different** discussion from the one asked for (its docblock;
 * GitLab divergence 8, the fake's divergence 31): a reply to an individual note can arrive as a new
 * general note. So every later read this module makes of its own replies finds them by the marker
 * the body opens with, across **every** discussion, never by the id a reply call returned. A reply
 * whose marker is already on the merge request is not posted again, which also covers the residual
 * WP-173 left in the adapter's fallback (POST, then a read that may fail): a retry after the POST
 * landed finds the note by its marker even though the executor recorded no answer to replay. That
 * retry is the job's: since WP-189 the GitLab adapter throws such a read's failure non-retryable,
 * so the executor's own retry never re-runs the POST before this check.
 *
 * **The author is asked too** (TD-029 decision 10's ownership by marker *and* author): a note counts
 * as the platform's own reply, or as a finding thread the Reviewer may resolve, only when its author
 * is the binding's own account — the git binding's `authenticatedUser` on the merge request, the
 * task-management binding's `selfIdentity` on the ticket (WP-179 review round 1). A marker is text anyone can type; a person who
 * typed this task's finding marker into their own thread must not get that thread resolved, and a
 * person who typed a reply marker must not stop the platform's real reply. Both are the narrowing
 * direction — a mutation the platform does **not** make — so they cannot silence anybody, which is
 * the reason decision 6 refuses an author check for the opposite question (*is this a person's
 * word?*), and that question is still answered by marker alone (`isPlatformNote`).
 *
 * ## Untrusted text
 *
 * A finding, a summary, a reply and a person's name are model output over untrusted input (BD-022).
 * They were redacted when the artifact was stored (WP-52), they are bounded by the artifact schema
 * (`MAX_THREAD_REPLY_CHARS`, `MAX_THREAD_REPLY_PERSON_CHARS`), and they are redacted again at the
 * call (`reviewWrites.thread`/`reply`, `ticketWrites.replyComment`) with the binding's redactor,
 * where they leave the platform. Every body opens with a marker the platform wrote, and the write
 * helpers refuse one that does not (`assertOpensWithMarker`), so no model text can stand where the
 * marker is.
 */
import type { ExternalIdentity, Id, ReviewFinding } from '@platform/contracts';
import { implementationNotesDataSchema, reviewVerdictDataSchema } from '@platform/contracts';
import { isPlatformMergeRequestNote, opensWithPlatformCommentMarker } from '@platform/domain';
import type { EventHandler, HandlerContext } from '../events/handler.js';
import type { SecretRedactor } from '../ports/integrations/audit.js';
import { IntegrationError, IntegrationUnsupportedError } from '../ports/integrations/common.js';
import type { Discussion } from '../ports/integrations/git-provider.js';
import {
  MAX_LIST_COMMENTS_LIMIT,
  type TicketComment,
} from '../ports/integrations/task-management.js';
import { type Logger, silentLogger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import {
  gitReads,
  integrationsForProject,
  noRunScopedSecrets,
  reviewWrites,
  ticketReads,
  ticketWrites,
} from './integrations.js';
import { enqueueOutbound, type PipelineOutboundData } from './jobs.js';
import {
  conversationOpenIdempotencyKeyFor,
  conversationOpenNoteMarker,
  conversationReplyIdempotencyKeyFor,
  conversationReplyMarkerId,
  conversationReplyNoteMarker,
  conversationResolveIdempotencyKeyFor,
  findingKeysOf,
  renderConversationReply,
  renderFindingWith,
  renderLeftOpenNote,
  renderNotAddressedReply,
  renderReviewSummary,
  reviewFindingIdempotencyKeyFor,
  reviewFindingMarkerFor,
  reviewFindingMarkerPrefixFor,
  reviewFindingSummaryIdempotencyKeyFor,
  reviewFindingSummaryMarkerPrefixFor,
  reviewLeftOpenIdempotencyKeyFor,
  reviewLeftOpenNoteMarker,
  reviewThreadCloseIdempotencyKeyFor,
} from './review-notes.js';
import { REVIEW_ONLY_TEMPLATE_ID } from './review-only.js';
import type { PipelineSagaOptions } from './saga.js';
import {
  CONVERSATION_HANDLED_ID,
  type ConversationHandledInput,
  type StoredArtifact,
  type StoredTask,
} from './store.js';

/**
 * What the three duties read of their wake-up: which duty, which task, which artifact. Narrower
 * than `PipelineOutboundData` because the `stage.execute` job runs them too (WP-184) and has no
 * cause event to name — so it passes none rather than an invented id.
 */
export type ConversationDutyData = Pick<
  PipelineOutboundData,
  'duty' | 'task_id' | 'artifact_id'
> & {
  readonly [key: string]: unknown;
};

/** The duties need a transaction of their own; the handler runs inside the dispatcher's. */
export interface ReviewConversationOptions
  extends Pick<PipelineSagaOptions, 'store' | 'integrations' | 'logger'> {
  readonly unitOfWork: UnitOfWork;
  /**
   * The platform's clock, for the handled ledger's `handled_at` (M28 ruling R2). Absent, the
   * process clock.
   */
  readonly clock?: { readonly now: () => string };
}

// ── The handler: decide ─────────────────────────────────────────────────────

/**
 * `task.stage.completed` → which of the three duties this completion asks for.
 *
 * Priority **120**, the integrations band (TD-005), beside review-only's post and the workpad: the
 * stage executor at 10 has stored the artifact and moved the task. It reads the task and the
 * artifact the event names — two indexed reads — and enqueues after commit; it calls nothing.
 */
export const reviewConversationHandler = (options: PipelineSagaOptions): EventHandler => ({
  name: 'pipeline.review.conversation',
  priority: 120,
  eventTypes: ['task.stage.completed'],
  handle: async (context: HandlerContext) => {
    const event = context.event.event;
    if (event.type !== 'task.stage.completed') {
      return;
    }
    const types = new Set(event.payload.artifacts.map((artifact) => artifact.artifact_type));
    if (!types.has('ReviewVerdict') && !types.has('ImplementationNotes')) {
      return;
    }
    const stored = await options.store.tasks.load(context.scope.tx, event.payload.task_id);
    if (stored === null || stored.task.template === REVIEW_ONLY_TEMPLATE_ID || stored.mr === null) {
      return;
    }
    const duties: PipelineOutboundData[] = [];
    const base = {
      project_id: stored.task.projectId,
      task_id: stored.task.id,
      cause_event_id: event.id,
      stage: event.payload.stage,
    };
    for (const ref of event.payload.artifacts) {
      if (ref.artifact_type === 'ReviewVerdict') {
        duties.push({ ...base, duty: 'review_findings_post', artifact_id: ref.id });
        const verdict = await artifactOf(options, context, stored.task.id, ref.id, 'ReviewVerdict');
        const parsed = reviewVerdictDataSchema.safeParse(verdict?.data);
        if (parsed.success && (parsed.data.resolved_threads ?? []).length > 0) {
          duties.push({ ...base, duty: 'review_threads_resolve', artifact_id: ref.id });
        }
      } else if (ref.artifact_type === 'ImplementationNotes') {
        // S-28.3 review: every set of notes, replies or none — a run that answers nothing still
        // tells each person's open thread it is still open (M28 ruling R3).
        duties.push({ ...base, duty: 'conversation_replies', artifact_id: ref.id });
      }
    }
    if (duties.length === 0) {
      return;
    }
    context.afterCommit(async () => {
      for (const data of duties) {
        await enqueueOutbound(options.jobs, data);
      }
    });
  },
});

/** The artifact the event named — the latest of its type, when that is the one (it is, at once). */
const artifactOf = async (
  options: Pick<PipelineSagaOptions, 'store'>,
  context: HandlerContext,
  taskId: Id,
  artifactId: Id,
  type: 'ReviewVerdict' | 'ImplementationNotes',
): Promise<StoredArtifact | null> => {
  const latest = await options.store.artifacts.latest(context.scope.tx, taskId, type);
  if (latest !== null && latest.id === artifactId) {
    return latest;
  }
  const all = await options.store.artifacts.listFor(context.scope.tx, taskId);
  return all.find((artifact) => artifact.id === artifactId) ?? null;
};

// ── What every duty reads first ─────────────────────────────────────────────

interface DutySubject {
  readonly stored: StoredTask & { readonly mr: NonNullable<StoredTask['mr']> };
  readonly artifact: StoredArtifact;
  /** The run that produced the artifact — the `<run>` of every marker and key (decision 10). */
  readonly runId: string;
  /**
   * When that run was created — the instant its plan had just read the conversation — or `null`
   * when the run row is not there. The handled ledger records an item as handled only up to the
   * newest note written no later than this (review of #139): a note a person adds while the run
   * goes, or before the duty fires, is new business, never covered by this run's answer.
   */
  readonly runCreatedAt: string | null;
}

/**
 * The task and the artifact the wake-up names, re-read from committed state, or `null` when there
 * is nothing to post: the task is gone, has no merge request, or the artifact is not there.
 */
const subjectOf = async (
  options: ReviewConversationOptions,
  data: ConversationDutyData,
  logger: Logger,
): Promise<DutySubject | null> => {
  const taskId = data.task_id as Id | undefined;
  const artifactId = data.artifact_id as Id | undefined;
  if (taskId === undefined || artifactId === undefined) {
    logger.warn({ duty: data.duty }, 'review conversation: the wake-up names no task or artifact');
    return null;
  }
  const read = await options.unitOfWork.transaction(async (scope) => {
    const stored = await options.store.tasks.load(scope.tx, taskId);
    const artifacts =
      stored === null ? [] : await options.store.artifacts.listFor(scope.tx, taskId);
    const artifact = artifacts.find((candidate) => candidate.id === artifactId) ?? null;
    const run =
      artifact?.producedByRunId == null
        ? null
        : await options.store.runs.load(scope.tx, artifact.producedByRunId as Id);
    return { stored, artifact, runCreatedAt: run?.createdAt ?? null };
  });
  const { stored, artifact, runCreatedAt } = read;
  if (stored === null || stored.mr === null || artifact === null) {
    logger.debug(
      { task_id: taskId, duty: data.duty },
      'review conversation: no task, merge request or artifact to post for',
    );
    return null;
  }
  return {
    stored: stored as DutySubject['stored'],
    artifact,
    runId: artifact.producedByRunId ?? artifact.id,
    runCreatedAt,
  };
};

/** Whether a note is the binding's own: same external id, when the binding said who it is. */
const authoredBy = (author: ExternalIdentity | null | undefined, self: ExternalIdentity): boolean =>
  author != null && author.external_id === self.external_id;

/** A model string, redacted with the binding's redactor and bounded, for a log line only. */
const loggable = (value: string, redactor: SecretRedactor | null): string => {
  const redacted = redactor === null ? value : redactor.redactText(value).value;
  return redacted.slice(0, 80);
};

// ── review_findings_post ────────────────────────────────────────────────────

/**
 * The anchored call failed in a way that may mean the provider would not place the anchor
 * (decision 10): GitLab's `400` on a position is `invalid_request`, and a merge request with no
 * `diff_refs` is `invalid_response`. **`invalid_response` is also a 201 whose body did not parse**
 * — the anchored note then exists — so the re-post first looks for the finding's marker on the
 * merge request ({@link postFinding}), and posts nothing when it is already there (WP-179 review).
 */
const mayBeAnchorRefusal = (error: unknown): boolean =>
  error instanceof IntegrationError &&
  (error.code === 'invalid_request' || error.code === 'invalid_response');

/**
 * `pipeline.outbound` duty **review_findings_post**: each finding as a thread, then the summary.
 *
 * Every finding is posted — the pipeline's review is a gate, not review-only's advisory pass, so
 * there is no severity floor and no cap beyond the artifact's own. The findings go up before the
 * summary, so its count describes threads that exist; the count is the set of discussion ids the
 * provider answered, as review-only counts (`runReviewOnlyPost`). A shadow task posts nothing: each
 * write is a `would_have` row and the summary says nothing, because no thread was answered.
 */
export const runReviewFindingsPost = async (
  options: ReviewConversationOptions,
  data: ConversationDutyData,
): Promise<void> => {
  const logger = options.logger ?? silentLogger;
  const subject = await subjectOf(options, data, logger);
  if (subject === null) {
    return;
  }
  const { stored, artifact, runId } = subject;
  const parsed = reviewVerdictDataSchema.safeParse(artifact.data);
  if (!parsed.success) {
    logger.warn({ task_id: stored.task.id }, 'review findings: the ReviewVerdict does not parse');
    return;
  }
  const verdict = parsed.data;
  const integrations = await integrationsForProject(
    options.integrations,
    stored.task.projectId,
    noRunScopedSecrets(),
  );
  const git = integrations.git;
  if (git === null) {
    return;
  }
  const writes = reviewWrites(integrations);
  const reads = gitReads(integrations);
  const readContext = { projectId: stored.task.projectId, taskId: stored.task.id };
  const context = {
    projectId: stored.task.projectId,
    taskId: stored.task.id,
    mode: stored.task.mode,
  };
  const keys = findingKeysOf(verdict.findings, git.redactor);
  const threads = new Set<string>();
  for (const [index, finding] of verdict.findings.entries()) {
    const key = keys[index] as string;
    const thread = await postFinding(writes, context, {
      stored,
      finding,
      marker: reviewFindingMarkerFor(stored.task.id, runId, key),
      idempotencyKey: reviewFindingIdempotencyKeyFor(stored.task.id, runId, key),
      logger,
      alreadyPosted: async () => {
        const marker = reviewFindingMarkerFor(stored.task.id, runId, key);
        const [discussions, self] = [
          await reads.discussions(stored.mr, readContext),
          await reads.self(readContext),
        ];
        return (
          discussions.find((discussion) =>
            replyIsOnTheMergeRequest([discussion], marker, self ?? null),
          ) ?? null
        );
      },
    });
    if (thread !== null) {
      threads.add(thread.id);
    }
  }
  // S-28.13 (M28 ruling R3b (1)): a general note, never a thread — a summary blocks no merge.
  const summaryNote = await writes.note(
    {
      ref: stored.mr,
      markdown: renderReviewSummary({
        taskId: stored.task.id,
        runId,
        verdict: verdict.verdict,
        posted: threads.size,
        summary: verdict.summary,
      }),
      idempotencyKey: reviewFindingSummaryIdempotencyKeyFor(stored.task.id, runId),
    },
    context,
  );
  // TD-029 Amendment D.1: a provider that lists the note as resolvable (GitLab's documentation
  // shows both values, research/15 G2) gets it resolved at once, keyed beside the post.
  if (summaryNote?.resolvable === true && !summaryNote.resolved) {
    await writes.resolve(
      {
        ref: stored.mr,
        discussionId: summaryNote.id,
        idempotencyKey: `${reviewFindingSummaryIdempotencyKeyFor(stored.task.id, runId)}:resolve`,
      },
      context,
    );
  }
  logger.info(
    {
      task_id: stored.task.id,
      run_id: runId,
      findings: verdict.findings.length,
      posted: threads.size,
    },
    'review findings posted on the merge request',
  );
  const latest = await options.unitOfWork.transaction(async (scope) =>
    options.store.artifacts.latest(scope.tx, stored.task.id, 'ReviewVerdict'),
  );
  if (verdict.verdict === 'approve' && latest?.id === artifact.id) {
    // M28 ruling R3b (2): an approving review leaves none of the platform's own threads open —
    // this run's findings included, which nobody will answer now the task has moved on. Only
    // while it is still the task's latest verdict: a retried post after a later review that asked
    // for changes must not close that review's threads under "the reviewer approved" (#155).
    // The threads it named as fixed are `review_threads_resolve`'s, which runs beside this duty.
    await closeOwnThreads(options, integrations, {
      stored,
      logger,
      leave: new Set(verdict.resolved_threads ?? []),
    });
  }
};

/**
 * One finding: anchored when it has both a file and a line; re-posted at merge-request level with
 * its location in the body when the provider refuses the anchor (decision 10, WP-179 (c)). The
 * re-post carries the **same** key: the refused call stored no answer, so the key is free, and a
 * replay then replays the merge-request-level thread.
 */
const postFinding = async (
  writes: ReturnType<typeof reviewWrites>,
  context: {
    readonly projectId: Id;
    readonly taskId: Id;
    readonly mode: StoredTask['task']['mode'];
  },
  input: {
    readonly stored: DutySubject['stored'];
    readonly finding: ReviewFinding;
    readonly marker: string;
    readonly idempotencyKey: string;
    readonly logger: Logger;
    /** The discussion already opening with this finding's marker, by the binding's account. */
    readonly alreadyPosted: () => Promise<Discussion | null>;
  },
): Promise<Discussion | null> => {
  const { finding } = input;
  const file = finding.file ?? null;
  const line = finding.line ?? null;
  const unanchored = (location: { file: string; line: number | null } | null) =>
    writes.thread(
      {
        ref: input.stored.mr,
        path: null,
        line: null,
        markdown: renderFindingWith(input.marker, finding, location),
        idempotencyKey: input.idempotencyKey,
      },
      context,
    );
  if (file === null || line === null) {
    // Half an anchor is one no provider can place (the port refuses it), so the finding is a
    // merge-request-level thread that still names what it has.
    return unanchored(file === null ? null : { file, line });
  }
  try {
    return await writes.thread(
      {
        ref: input.stored.mr,
        path: file,
        line,
        markdown: renderFindingWith(input.marker, finding),
        idempotencyKey: input.idempotencyKey,
      },
      context,
    );
  } catch (error) {
    if (!mayBeAnchorRefusal(error)) {
      throw error;
    }
    const landed = await input.alreadyPosted();
    if (landed !== null) {
      input.logger.info(
        { task_id: input.stored.task.id, code: (error as IntegrationError).code },
        'review findings: the anchored call failed after its note landed; nothing is re-posted',
      );
      return landed;
    }
    input.logger.info(
      { task_id: input.stored.task.id, code: (error as IntegrationError).code },
      'review findings: the provider refused a diff anchor; the finding is posted on the merge request with its location',
    );
    return unanchored({ file, line });
  }
};

// ── conversation_replies ────────────────────────────────────────────────────

/** Whether any note on the merge request is this reply, by marker and author (never by id). */
const replyIsOnTheMergeRequest = (
  discussions: readonly Discussion[],
  marker: string,
  self: ExternalIdentity | null,
): boolean =>
  discussions.some((discussion) =>
    discussion.notes.some(
      (note) =>
        note.body.trimStart().startsWith(marker) &&
        (self === null || authoredBy(note.author, self)),
    ),
  );

/**
 * Whether any ticket comment is this reply: its marker id, or a body that opens with it — and, as
 * on the merge request, written by the task-management binding's own account (`selfIdentity`), so
 * a person who types the marker does not stop the platform's reply (WP-179 review). With no
 * identity answered, no comment counts and the reply is posted (the executor's key still replays).
 */
const replyIsOnTheTicket = (
  comments: readonly TicketComment[],
  markerId: string,
  self: ExternalIdentity | null,
): boolean =>
  self !== null &&
  comments.some(
    (comment) =>
      authoredBy(comment.author, self) &&
      (comment.marker_id === markerId ||
        (opensWithPlatformCommentMarker(comment.body) && opensWithExactly(comment.body, markerId))),
  );

/**
 * Whether a body opens with exactly this marker id — followed by whitespace or nothing, so reply
 * `…​.1` is never read as reply `…​.10` (a ticket reply's bare marker has no closing delimiter).
 */
const opensWithExactly = (body: string, markerId: string): boolean => {
  const text = body.trimStart();
  return text.startsWith(markerId) && /^(?:\s|$)/.test(text.slice(markerId.length));
};

/**
 * `pipeline.outbound` duty **conversation_replies**: the Developer's answers, each on its thread.
 *
 * Each `thread_id` is checked against a **fresh** read — the merge request's discussions first,
 * then the ticket's comments (one page of {@link MAX_LIST_COMMENTS_LIMIT}, read only when a target
 * is not a discussion) — and an id that is neither is dropped with a log line (decision 10). A
 * model can name only an id it was shown, so a drop is a thread that went away, a comment older than
 * the page, or an invented id. A reply already on the merge request or the ticket — found by its
 * marker, never by the id a reply call returned — is not posted again.
 */
export const runConversationReplies = async (
  options: ReviewConversationOptions,
  data: ConversationDutyData,
): Promise<void> => {
  const logger = options.logger ?? silentLogger;
  const subject = await subjectOf(options, data, logger);
  if (subject === null) {
    return;
  }
  const { stored, artifact, runId } = subject;
  const parsed = implementationNotesDataSchema.safeParse(artifact.data);
  // S-28.3 review: an empty list falls through — the run's silence is said on each open thread.
  const replies = parsed.success ? (parsed.data.thread_replies ?? []) : [];
  const integrations = await integrationsForProject(
    options.integrations,
    stored.task.projectId,
    noRunScopedSecrets(),
  );
  const readContext = { projectId: stored.task.projectId, taskId: stored.task.id };
  const writeContext = { ...readContext, mode: stored.task.mode };
  const reads = gitReads(integrations);
  const discussions =
    integrations.git === null ? [] : await reads.discussions(stored.mr, readContext);
  const self = integrations.git === null ? null : await reads.self(readContext);
  /**
   * S-28.3 review: the head the run left, read **live** — `tasks.mr_ref.head_sha` is written only
   * on a provider signal, which this duty races, so it is usually the commit from before the fix.
   * The run pushed when the live head differs from the head recorded on the task; when it does
   * not, a `fixed`/`documented` reply says *not pushed yet* and resolves nothing. Residual: a push
   * signal recorded before this duty reads the task makes the two equal, and a pushed fix then
   * reads as not pushed — the safe direction (a reply, no resolve).
   */
  const needsHead = replies.some((entry) => entry.kind === 'fixed' || entry.kind === 'documented');
  const liveHead =
    integrations.git === null || !needsHead
      ? null
      : ((await reads.mergeRequest(stored.mr, readContext))?.head_sha ?? null);
  const pushed = liveHead !== null && liveHead !== (stored.mr.head_sha ?? null);
  const known = new Set(discussions.map((discussion) => discussion.id));
  const needsComments = replies.some((reply) => !known.has(reply.thread_id));
  const page = needsComments
    ? await ticketReads(integrations).comments(
        stored.task.ticket,
        { limit: MAX_LIST_COMMENTS_LIMIT },
        readContext,
      )
    : null;
  const comments = page?.comments ?? [];
  const ticketSelf =
    page === null ? null : await ticketReads(integrations).selfIdentity(readContext);
  const redactor = integrations.git?.redactor ?? integrations.taskManagement?.redactor ?? null;

  let asked = 0;
  let resolvedThreads = 0;
  /** M28 ruling R2: what this duty answered, recorded once the replies are on the provider. */
  const answered: ConversationHandledInput[] = [];
  const handledAt = new Date(options.clock?.now() ?? Date.now()).toISOString();
  /**
   * M28 ruling R3: a person's thread is resolved after this run's replies only when **every**
   * entry naming it is `fixed` or `documented` — a mixed note's `needs_person` keeps it open.
   */
  const kindsByThread = new Map<string, Set<string>>();
  for (const entry of replies) {
    kindsByThread.set(
      entry.thread_id,
      (kindsByThread.get(entry.thread_id) ?? new Set()).add(entry.kind),
    );
  }
  const settledByRun = (threadId: string): boolean =>
    [...(kindsByThread.get(threadId) ?? [])].every(
      (kind) => kind === 'fixed' || kind === 'documented',
    );
  const resolving = new Set<string>();
  for (const [index, entry] of replies.entries()) {
    const markerId = conversationReplyMarkerId(stored.task.id, runId, index);
    const idempotencyKey = conversationReplyIdempotencyKeyFor(stored.task.id, runId, index);
    const body = (marker: string) =>
      renderConversationReply({
        marker,
        kind: entry.kind,
        reply: entry.reply,
        person: entry.person ?? null,
        // M28 ruling R3: name the commit — the live head the run left (S-28.3 review).
        addressedIn: liveHead,
        pushed,
      });
    if (known.has(entry.thread_id)) {
      const discussion = discussions.find((candidate) => candidate.id === entry.thread_id);
      const handled = handledRow(stored, runId, handledAt, {
        source: discussion?.resolvable === true ? 'mr_thread' : 'mr_note',
        threadId: entry.thread_id,
        lastNoteId: handledUpTo(discussion, subject.runCreatedAt),
      });
      const marker = conversationReplyNoteMarker(stored.task.id, runId, index);
      if (!replyIsOnTheMergeRequest(discussions, marker, self)) {
        await reviewWrites(integrations).reply(
          { ref: stored.mr, discussionId: entry.thread_id, markdown: body(marker), idempotencyKey },
          writeContext,
        );
        asked += 1;
      }
      if (handled !== null) answered.push(handled);
      if (
        discussion !== undefined &&
        isPersonThread(discussion) &&
        discussion.resolvable &&
        !discussion.resolved &&
        settledByRun(discussion.id) &&
        pushed &&
        !personWroteAfter(discussion, subject.runCreatedAt) &&
        !resolving.has(discussion.id)
      ) {
        resolving.add(discussion.id);
        // Re-read the one discussion right before resolving: a person's note written since the
        // first read blocks the resolve (S-28.3 review).
        const fresh = (await reads.discussions(stored.mr, readContext)).find(
          (candidate) => candidate.id === discussion.id,
        );
        if (
          fresh === undefined ||
          fresh.resolved ||
          personWroteAfter(fresh, subject.runCreatedAt)
        ) {
          continue;
        }
        const resolvedNow = await resolvePersonThread(integrations, {
          stored,
          discussionId: discussion.id,
          idempotencyKey: conversationResolveIdempotencyKeyFor(stored.task.id, runId, index),
          logger,
        });
        if (resolvedNow && handled !== null) {
          answered.push({ ...handled, source: 'mr_thread', kind: 'resolved' });
          resolvedThreads += 1;
        }
      }
      continue;
    }
    if (comments.some((comment) => comment.id === entry.thread_id)) {
      const handled = handledRow(stored, runId, handledAt, {
        source: 'ticket_comment',
        threadId: entry.thread_id,
        lastNoteId: entry.thread_id,
      });
      if (replyIsOnTheTicket(comments, markerId, ticketSelf)) {
        logger.debug({ task_id: stored.task.id, reply: index }, 'reply already on the ticket');
        if (handled !== null) answered.push(handled);
        continue;
      }
      await ticketWrites(integrations).replyComment(stored.task.ticket, body(markerId), {
        ...writeContext,
        idempotencyKey,
        markerId,
      });
      if (handled !== null) answered.push(handled);
      asked += 1;
      continue;
    }
    logger.warn(
      { task_id: stored.task.id, reply: index, thread_id: loggable(entry.thread_id, redactor) },
      'reply dropped: its thread is neither a discussion on the merge request nor a comment on the ticket',
    );
  }
  const unanswered = await sayStillOpen(options, integrations, {
    stored,
    runId,
    discussions,
    self,
    answeredThreads: new Set(replies.map((entry) => entry.thread_id)),
    logger,
  });
  const recorded = await recordHandled(options, answered);
  logger.info(
    {
      task_id: stored.task.id,
      run_id: runId,
      replies: replies.length,
      asked,
      resolved: resolvedThreads,
      still_open: unanswered,
      recorded,
    },
    'conversation replies posted',
  );
};

/**
 * The position of the newest *still open* note any run of this task posted in the discussion, or
 * -1 — so the note is said once per thread until a person writes again (S-28.3 review), never once
 * per run.
 */
const saidStillOpenSince = (discussion: Discussion, taskId: Id): number =>
  discussion.notes.findLastIndex(
    (note) =>
      note.body.trimStart().startsWith(`<!-- agentic:reply:${taskId}.`) &&
      note.body.includes(`.open-${discussion.id} -->`),
  );

/** The position of the newest person's note in a discussion, or -1 when it holds none. */
const lastPersonNoteIndex = (discussion: Discussion): number =>
  discussion.notes.findLastIndex((note) => !note.system && !isPlatformMergeRequestNote(note.body));

/**
 * Whether a person wrote in the discussion after the run was created (or when that is unknown) —
 * then the thread holds a request this run never read, and R3 does not resolve it.
 */
const personWroteAfter = (discussion: Discussion, before: string | null): boolean => {
  const bound = before === null ? Number.NaN : Date.parse(before);
  return discussion.notes.some((note) => {
    if (note.system || isPlatformMergeRequestNote(note.body)) return false;
    const at = Date.parse(note.created_at);
    return Number.isNaN(bound) || Number.isNaN(at) || at > bound;
  });
};

/** A person's thread: its first note is a person's — not a system note, not the platform's. */
const isPersonThread = (discussion: Discussion): boolean => {
  const first = discussion.notes[0];
  return first !== undefined && !first.system && !isPlatformMergeRequestNote(first.body);
};

/**
 * **Resolve what was fixed** (S-28.3, M28 ruling R3, which reverses TD-029 decision 10's *"a
 * person's thread is never resolved"*): after the Developer's `fixed` or `documented` reply on a
 * person's unresolved resolvable thread, the platform resolves it — through the executor, under
 * `conversation_resolve:<task>:<run>:<n>`, so a replay replays and shadow mode records
 * `would_have`. A provider that cannot resolve a discussion, or refuses this one, is logged and
 * skipped: the reply is posted and the thread stays open, which is where a person finds it.
 * Answers whether the thread was resolved on the provider (never in shadow mode).
 *
 * The caller resolves only when the live head moved past the head recorded on the task (the run
 * pushed) and re-reads the discussion right before this call, so a person's note written while the
 * run went blocks it. **Residual, stated:** a note a person writes between that re-read and this
 * call is under a resolved thread; GitLab keeps it visible, and the window does not read a resolved
 * thread, so it reaches the next run only through the conversation block.
 */
const resolvePersonThread = async (
  integrations: Awaited<ReturnType<typeof integrationsForProject>>,
  input: {
    readonly stored: DutySubject['stored'];
    readonly discussionId: string;
    readonly idempotencyKey: string;
    readonly logger: Logger;
  },
): Promise<boolean> => {
  const { stored } = input;
  try {
    const answer = await reviewWrites(integrations).resolve(
      { ref: stored.mr, discussionId: input.discussionId, idempotencyKey: input.idempotencyKey },
      { projectId: stored.task.projectId, taskId: stored.task.id, mode: stored.task.mode },
    );
    return stored.task.mode === 'normal' && answer !== null;
  } catch (error) {
    if (
      error instanceof IntegrationUnsupportedError ||
      (error instanceof IntegrationError &&
        (error.code === 'unsupported_capability' || error.code === 'invalid_request'))
    ) {
      input.logger.info(
        {
          task_id: stored.task.id,
          thread_id: loggable(input.discussionId, integrations.git?.redactor ?? null),
          reason: error.name,
        },
        'the provider did not resolve a thread the Developer fixed; the reply is posted and the thread stays open',
      );
      return false;
    }
    throw error;
  }
};

/**
 * **No thread is left silent** (S-28.3, M28 ruling R3): every person's unresolved resolvable thread
 * this run did not answer, whose newest person note the handled ledger does not cover, gets the
 * platform's *"Not addressed in this run — still open."* — keyed by the discussion
 * (`conversation_open:<task>:<run>:<discussion>`), found again by its marker before a retry posts,
 * and left unresolved. It is not recorded as answered: it is still open business. A discussion id
 * outside the ledger's shape is skipped (its marker would not be one). Answers how many it posted.
 */
const sayStillOpen = async (
  options: ReviewConversationOptions,
  integrations: Awaited<ReturnType<typeof integrationsForProject>>,
  input: {
    readonly stored: DutySubject['stored'];
    readonly runId: string;
    readonly discussions: readonly Discussion[];
    readonly self: ExternalIdentity | null;
    readonly answeredThreads: ReadonlySet<string>;
    readonly logger: Logger;
  },
): Promise<number> => {
  if (integrations.git === null) {
    return 0;
  }
  const { stored } = input;
  const ledger = await options.unitOfWork.transaction(async (scope) =>
    options.store.tasks.conversationHandled(scope.tx, stored.task.id),
  );
  let posted = 0;
  for (const discussion of input.discussions) {
    const last = lastPersonNoteIndex(discussion);
    if (
      !isPersonThread(discussion) ||
      !discussion.resolvable ||
      discussion.resolved ||
      input.answeredThreads.has(discussion.id) ||
      last < 0 ||
      saidStillOpenSince(discussion, stored.task.id) > last ||
      !CONVERSATION_HANDLED_ID.test(discussion.id) ||
      ledger.some(
        (row) =>
          row.threadId === discussion.id &&
          row.lastNoteId !== null &&
          discussion.notes.findIndex((note) => note.id === row.lastNoteId) >= last,
      )
    ) {
      continue;
    }
    const marker = conversationOpenNoteMarker(stored.task.id, input.runId, discussion.id);
    if (replyIsOnTheMergeRequest(input.discussions, marker, input.self)) {
      continue;
    }
    await reviewWrites(integrations).reply(
      {
        ref: stored.mr,
        discussionId: discussion.id,
        markdown: renderNotAddressedReply(marker),
        idempotencyKey: conversationOpenIdempotencyKeyFor(
          stored.task.id,
          input.runId,
          discussion.id,
        ),
      },
      { projectId: stored.task.projectId, taskId: stored.task.id, mode: stored.task.mode },
    );
    posted += 1;
  }
  if (posted > 0) {
    input.logger.info(
      { task_id: stored.task.id, run_id: input.runId, posted },
      'a person’s open thread this run did not answer was told it is still open',
    );
  }
  return posted;
};

// ── review_threads_resolve ──────────────────────────────────────────────────

/**
 * `pipeline.outbound` duty **review_threads_resolve**: the Reviewer's own finding threads its
 * re-review confirmed fixed (decision 10).
 *
 * A named thread is resolved only when its **first** note opens with this task's `review-finding`
 * marker and was written by the binding's own account; anything else — a person's thread, a thread
 * whose first note quotes the marker further down, a reply the platform posted into a person's
 * thread — is left open and logged. A thread already resolved, or one the provider says cannot be
 * resolved, is left as it is.
 */
export const runReviewThreadsResolve = async (
  options: ReviewConversationOptions,
  data: ConversationDutyData,
): Promise<void> => {
  const logger = options.logger ?? silentLogger;
  const subject = await subjectOf(options, data, logger);
  if (subject === null) {
    return;
  }
  const { stored, artifact } = subject;
  const parsed = reviewVerdictDataSchema.safeParse(artifact.data);
  const named = [...new Set(parsed.success ? (parsed.data.resolved_threads ?? []) : [])];
  if (named.length === 0) {
    return;
  }
  const integrations = await integrationsForProject(
    options.integrations,
    stored.task.projectId,
    noRunScopedSecrets(),
  );
  if (integrations.git === null) {
    return;
  }
  const readContext = { projectId: stored.task.projectId, taskId: stored.task.id };
  const reads = gitReads(integrations);
  const discussions = await reads.discussions(stored.mr, readContext);
  const self = await reads.self(readContext);
  const prefix = reviewFindingMarkerPrefixFor(stored.task.id);
  let resolved = 0;
  const resolvedRows: ConversationHandledInput[] = [];
  const handledAt = new Date(options.clock?.now() ?? Date.now()).toISOString();
  for (const id of named) {
    const discussion = discussions.find((candidate) => candidate.id === id);
    const first = discussion?.notes[0];
    const own =
      first !== undefined &&
      isPlatformMergeRequestNote(first.body) &&
      first.body.trimStart().startsWith(prefix) &&
      self !== null &&
      authoredBy(first.author, self);
    if (discussion === undefined || !own) {
      logger.warn(
        { task_id: stored.task.id, thread_id: loggable(id, integrations.git.redactor) },
        'a thread the reviewer named is not its own finding thread on this merge request; it is not resolved',
      );
      continue;
    }
    if (discussion.resolved || !discussion.resolvable) {
      continue;
    }
    await reviewWrites(integrations).resolve(
      { ref: stored.mr, discussionId: discussion.id },
      { ...readContext, mode: stored.task.mode },
    );
    const handled = handledRow(subject.stored, subject.runId, handledAt, {
      source: 'mr_thread',
      threadId: discussion.id,
      lastNoteId: handledUpTo(discussion, subject.runCreatedAt),
    });
    if (handled !== null) resolvedRows.push({ ...handled, kind: 'resolved' });
    resolved += 1;
  }
  const recorded = await recordHandled(options, resolvedRows);
  logger.info(
    { task_id: stored.task.id, named: named.length, resolved, recorded },
    'review threads resolved after the re-review',
  );
};

// ── The platform closes its own threads after an approval (S-28.13) ─────────

/**
 * Whether a discussion is one of this task's own review threads — its **first** note opens with
 * this task's `review-finding` or `review-summary` marker and was written by the binding's account
 * (the ownership test `review_threads_resolve` uses) — and which kind.
 */
const ownReviewThreadKind = (
  discussion: Discussion,
  taskId: Id,
  self: ExternalIdentity,
): 'finding' | 'summary' | null => {
  const first = discussion.notes[0];
  if (first === undefined || first.system || !authoredBy(first.author, self)) {
    return null;
  }
  const body = first.body.trimStart();
  if (!isPlatformMergeRequestNote(body)) return null;
  if (body.startsWith(reviewFindingMarkerPrefixFor(taskId))) return 'finding';
  if (body.startsWith(reviewFindingSummaryMarkerPrefixFor(taskId))) return 'summary';
  return null;
};

/**
 * Whether a person wrote anything in the discussion: a note that is not a provider system note and
 * is not the platform's own (a platform marker **and** the binding's account — a note somebody
 * else wrote that quotes a marker is still theirs).
 */
const personWroteIn = (discussion: Discussion, self: ExternalIdentity): boolean =>
  discussion.notes.some(
    (note) =>
      !note.system && !(authoredBy(note.author, self) && isPlatformMergeRequestNote(note.body)),
  );

/**
 * **The platform resolves its own threads after an approval** (S-28.13, M28 ruling R3b (2)).
 *
 * AUT-6655 waited at Ready with five unresolved threads, all the platform's: three review
 * summaries, a nit the Developer answered *Not changed* and a nit from the approving review nobody
 * answered — and GitLab refused the merge (`discussions_not_resolved`). So, once the Reviewer has
 * approved, every unresolved resolvable thread on the merge request that is this task's own review
 * thread ({@link ownReviewThreadKind}) **and in which no person has written** is resolved. A finding
 * thread the Developer did not answer `fixed`/`documented` first gets one closing note
 * ({@link renderLeftOpenNote}) saying it was left as it is and how to have it changed.
 *
 * A thread in which a person wrote anything is never resolved here: it is that person's
 * conversation, and R3's own rules apply to it. With no binding identity answered nothing is
 * resolved (ownership cannot be shown).
 *
 * **Idempotent across every performer** — the approving review's post, the Ready check
 * (`ready-merge-check.ts`) and the recovery pass that reaches tasks already waiting: the note is
 * keyed and marked by the discussion (`review_left_open:<task>:<discussion>`, found again by its
 * marker before a retry posts), and the resolve is keyed by the discussion too
 * (`review_thread_close:<task>:<discussion>`), and each resolve writes a `resolved` row to the
 * handled ledger. That row is what keeps a person's **reopen** standing (TD-029 Amendment D.3): a
 * thread the platform already resolved that is open again is never resolved a second time — it is
 * counted as `reopened`, and the Ready check arms the human-return window, which returns the task. Shadow mode records `would_have` and changes nothing. A provider that
 * cannot resolve a discussion is logged and skipped. Answers how many threads it resolved.
 */
export const closeOwnThreads = async (
  options: ReviewConversationOptions,
  integrations: Awaited<ReturnType<typeof integrationsForProject>>,
  input: {
    readonly stored: DutySubject['stored'];
    readonly logger: Logger;
    /** Threads another duty resolves (the approving verdict's `resolved_threads`); left alone. */
    readonly leave?: ReadonlySet<string>;
    /**
     * Threads the Reviewer confirmed fixed (an approving verdict's `resolved_threads`), resolved
     * here **without** the *Left as is* note — the Ready check's, in case `review_threads_resolve`
     * was lost (review of #155).
     */
    readonly confirmed?: ReadonlySet<string>;
  },
): Promise<ClosedOwnThreads> => {
  const none: ClosedOwnThreads = { resolved: 0, reopened: 0 };
  if (integrations.git === null) {
    return none;
  }
  const { stored, logger } = input;
  const readContext = { projectId: stored.task.projectId, taskId: stored.task.id };
  const writeContext = { ...readContext, mode: stored.task.mode };
  const reads = gitReads(integrations);
  const discussions = await reads.discussions(stored.mr, readContext);
  const findingPrefix = reviewFindingMarkerPrefixFor(stored.task.id);
  const summaryPrefix = reviewFindingSummaryMarkerPrefixFor(stored.task.id);
  const open = discussions.some((discussion) => {
    const body = discussion.notes[0]?.body.trimStart() ?? '';
    return (
      discussion.resolvable &&
      !discussion.resolved &&
      (body.startsWith(findingPrefix) || body.startsWith(summaryPrefix))
    );
  });
  if (!open) {
    // Nothing of this task's is open: no identity read, no write.
    return none;
  }
  const self = await reads.self(readContext);
  if (self === null) {
    logger.info(
      { task_id: stored.task.id },
      'the git binding did not say who it is, so the platform cannot tell its own threads; none is closed',
    );
    return none;
  }
  const own = discussions.filter(
    (discussion) =>
      discussion.resolvable &&
      !discussion.resolved &&
      !(input.leave?.has(discussion.id) ?? false) &&
      ownReviewThreadKind(discussion, stored.task.id, self) !== null &&
      !personWroteIn(discussion, self),
  );
  if (own.length === 0) {
    return none;
  }
  // TD-029 Amendment D.3: a thread the platform already resolved that is open again was reopened
  // by a person — a return signal for the window, never resolved a second time (and so no replayed
  // write every time the Ready check runs over it).
  const ledger = await options.unitOfWork.transaction(async (scope) =>
    options.store.tasks.conversationHandled(scope.tx, stored.task.id),
  );
  const resolvedBefore = new Set(
    ledger
      .filter((row) => row.kind === 'resolved' && row.source === 'mr_thread')
      .map((row) => row.threadId),
  );
  const candidates = own.filter((discussion) => !resolvedBefore.has(discussion.id));
  const reopened = own.length - candidates.length;
  if (candidates.length === 0) {
    return { resolved: 0, reopened };
  }
  const settled = new Set([
    ...(await settledThreadIds(options, stored.task.id)),
    ...(input.confirmed ?? []),
  ]);
  const handledAt = new Date(options.clock?.now() ?? Date.now()).toISOString();
  let resolved = 0;
  for (const discussion of candidates) {
    if (!CONVERSATION_HANDLED_ID.test(discussion.id)) {
      // Its marker and keys would not be an identity; left for a person.
      continue;
    }
    const kind = ownReviewThreadKind(discussion, stored.task.id, self);
    if (kind === 'finding' && !settled.has(discussion.id)) {
      const marker = reviewLeftOpenNoteMarker(stored.task.id, discussion.id);
      if (!replyIsOnTheMergeRequest(discussions, marker, self)) {
        await reviewWrites(integrations).reply(
          {
            ref: stored.mr,
            discussionId: discussion.id,
            markdown: renderLeftOpenNote(marker),
            idempotencyKey: reviewLeftOpenIdempotencyKeyFor(stored.task.id, discussion.id),
          },
          writeContext,
        );
      }
    }
    try {
      await reviewWrites(integrations).resolve(
        {
          ref: stored.mr,
          discussionId: discussion.id,
          idempotencyKey: reviewThreadCloseIdempotencyKeyFor(stored.task.id, discussion.id),
        },
        writeContext,
      );
      resolved += 1;
      // The ledger's `resolved` row is what tells a later reopen from a thread never closed —
      // written right after this resolve (review of #155), so a later thread's failure that
      // throws cannot leave a resolved thread without its row (a reopen then read as never closed).
      const row = handledRow(stored, '', handledAt, {
        source: 'mr_thread',
        threadId: discussion.id,
        lastNoteId: discussion.notes.at(-1)?.id ?? null,
      });
      if (row !== null) await recordHandled(options, [{ ...row, kind: 'resolved' }]);
    } catch (error) {
      if (
        error instanceof IntegrationUnsupportedError ||
        (error instanceof IntegrationError &&
          (error.code === 'unsupported_capability' || error.code === 'invalid_request'))
      ) {
        logger.info(
          { task_id: stored.task.id, reason: error.name },
          'the provider did not resolve one of the platform’s own review threads; it stays open',
        );
        continue;
      }
      throw error;
    }
  }
  logger.info(
    { task_id: stored.task.id, candidates: candidates.length, resolved, reopened },
    'the platform closed its own review threads after the approval',
  );
  return { resolved, reopened };
};

/** What {@link closeOwnThreads} did: threads it resolved, and own threads a person reopened. */
export interface ClosedOwnThreads {
  readonly resolved: number;
  readonly reopened: number;
}

/** Every thread id the Developer answered `fixed` or `documented`, across every run's notes. */
const settledThreadIds = async (
  options: ReviewConversationOptions,
  taskId: Id,
): Promise<ReadonlySet<string>> => {
  const artifacts = await options.unitOfWork.transaction(async (scope) =>
    options.store.artifacts.listFor(scope.tx, taskId),
  );
  const settled = new Set<string>();
  for (const artifact of artifacts) {
    if (artifact.type !== 'ImplementationNotes') continue;
    const parsed = implementationNotesDataSchema.safeParse(artifact.data);
    for (const entry of parsed.success ? (parsed.data.thread_replies ?? []) : []) {
      if (entry.kind === 'fixed' || entry.kind === 'documented') settled.add(entry.thread_id);
    }
  }
  return settled;
};

// ── The handled ledger (M28 ruling R2) ──────────────────────────────────────

/**
 * The newest note of a discussion written **no later than the run was created** — what this run's
 * answer can have handled (review of #139). A note a person added while the run went, or before the
 * duty fired, is after it, so it stays new business: the window returns the task on it and the next
 * prompt does not mark it answered. A note whose instant cannot be read is never covered. `null`
 * when the discussion is unknown, the run's instant is not known, or no note qualifies — and then
 * no row is written ({@link handledRow}), because a row naming no note would fall back to its own
 * instant and cover exactly the notes this bound exists to leave open.
 */
const handledUpTo = (discussion: Discussion | undefined, before: string | null): string | null => {
  if (discussion === undefined || before === null) {
    return null;
  }
  const bound = Date.parse(before);
  if (Number.isNaN(bound)) {
    return null;
  }
  return (
    discussion.notes
      .filter((note) => {
        const at = Date.parse(note.created_at);
        // The platform's own replies are never what a run answered: counting one would move the
        // row's last note on every replay and write a new row each time.
        return (
          !note.system &&
          !note.body.trimStart().startsWith('<!-- agentic:reply:') &&
          !Number.isNaN(at) &&
          at <= bound
        );
      })
      .at(-1)?.id ?? null
  );
};

/**
 * One ledger row for an item the platform answered — or `null` when the task is in **shadow** mode
 * (the reply was a `would_have` row, so nothing was answered on the provider) or an id is outside
 * the ledger's shape (skipped rather than cut: a cut id is another item's id).
 */
const handledRow = (
  stored: DutySubject['stored'],
  runId: string,
  handledAt: string,
  item: {
    readonly source: ConversationHandledInput['source'];
    readonly threadId: string;
    readonly lastNoteId: string | null;
  },
): ConversationHandledInput | null => {
  if (
    stored.task.mode !== 'normal' ||
    (item.source !== 'ticket_comment' && item.lastNoteId === null) ||
    !CONVERSATION_HANDLED_ID.test(item.threadId) ||
    (item.lastNoteId !== null && !CONVERSATION_HANDLED_ID.test(item.lastNoteId))
  ) {
    return null;
  }
  return {
    taskId: stored.task.id,
    source: item.source,
    threadId: item.threadId,
    lastNoteId: item.lastNoteId,
    runId: UUID.test(runId) ? (runId as Id) : null,
    kind: 'answered',
    author: null,
    writtenAt: null,
    handledAt,
  };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Records the rows in a transaction of its own, after the provider calls — so a row says the
 * answer is on the provider. Idempotent (`on conflict do nothing`): a replayed duty adds nothing.
 */
const recordHandled = async (
  options: ReviewConversationOptions,
  rows: readonly ConversationHandledInput[],
): Promise<number> =>
  rows.length === 0
    ? 0
    : options.unitOfWork.transaction(async (scope) =>
        options.store.tasks.recordConversationHandled(scope.tx, rows),
      );

/** The handler this module registers, for the runtime to spread. */
export const reviewConversationHandlers = (
  options: PipelineSagaOptions,
): readonly EventHandler[] => [reviewConversationHandler(options)];

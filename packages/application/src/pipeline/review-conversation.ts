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
 *    comment with the same marker.
 *  - **`review_threads_resolve`** — after a `code_review` completes with `resolved_threads`: only a
 *    named thread whose **first** note opens with this task's `review-finding` marker is resolved;
 *    a person's thread never is.
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
 * landed finds the note by its marker even though the executor recorded no answer to replay.
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
import { IntegrationError } from '../ports/integrations/common.js';
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
  conversationReplyIdempotencyKeyFor,
  conversationReplyMarkerId,
  conversationReplyNoteMarker,
  findingKeysOf,
  renderConversationReply,
  renderFindingWith,
  renderReviewSummary,
  reviewFindingIdempotencyKeyFor,
  reviewFindingMarkerFor,
  reviewFindingMarkerPrefixFor,
  reviewFindingSummaryIdempotencyKeyFor,
} from './review-notes.js';
import { REVIEW_ONLY_TEMPLATE_ID } from './review-only.js';
import type { PipelineSagaOptions } from './saga.js';
import type { StoredArtifact, StoredTask } from './store.js';

/** The duties need a transaction of their own; the handler runs inside the dispatcher's. */
export interface ReviewConversationOptions
  extends Pick<PipelineSagaOptions, 'store' | 'integrations' | 'logger'> {
  readonly unitOfWork: UnitOfWork;
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
        const notes = await artifactOf(
          options,
          context,
          stored.task.id,
          ref.id,
          'ImplementationNotes',
        );
        const parsed = implementationNotesDataSchema.safeParse(notes?.data);
        if (parsed.success && (parsed.data.thread_replies ?? []).length > 0) {
          duties.push({ ...base, duty: 'conversation_replies', artifact_id: ref.id });
        }
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
}

/**
 * The task and the artifact the wake-up names, re-read from committed state, or `null` when there
 * is nothing to post: the task is gone, has no merge request, or the artifact is not there.
 */
const subjectOf = async (
  options: ReviewConversationOptions,
  data: PipelineOutboundData,
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
    return { stored, artifact: artifacts.find((artifact) => artifact.id === artifactId) ?? null };
  });
  const { stored, artifact } = read;
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
  data: PipelineOutboundData,
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
  await writes.thread(
    {
      ref: stored.mr,
      path: null,
      line: null,
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
  logger.info(
    {
      task_id: stored.task.id,
      run_id: runId,
      findings: verdict.findings.length,
      posted: threads.size,
    },
    'review findings posted on the merge request',
  );
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
  data: PipelineOutboundData,
): Promise<void> => {
  const logger = options.logger ?? silentLogger;
  const subject = await subjectOf(options, data, logger);
  if (subject === null) {
    return;
  }
  const { stored, artifact, runId } = subject;
  const parsed = implementationNotesDataSchema.safeParse(artifact.data);
  const replies = parsed.success ? (parsed.data.thread_replies ?? []) : [];
  if (replies.length === 0) {
    return;
  }
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
  for (const [index, entry] of replies.entries()) {
    const markerId = conversationReplyMarkerId(stored.task.id, runId, index);
    const idempotencyKey = conversationReplyIdempotencyKeyFor(stored.task.id, runId, index);
    const body = (marker: string) =>
      renderConversationReply({
        marker,
        kind: entry.kind,
        reply: entry.reply,
        person: entry.person ?? null,
      });
    if (known.has(entry.thread_id)) {
      const marker = conversationReplyNoteMarker(stored.task.id, runId, index);
      if (replyIsOnTheMergeRequest(discussions, marker, self)) {
        logger.debug(
          { task_id: stored.task.id, reply: index },
          'reply already on the merge request',
        );
        continue;
      }
      await reviewWrites(integrations).reply(
        { ref: stored.mr, discussionId: entry.thread_id, markdown: body(marker), idempotencyKey },
        writeContext,
      );
      asked += 1;
      continue;
    }
    if (comments.some((comment) => comment.id === entry.thread_id)) {
      if (replyIsOnTheTicket(comments, markerId, ticketSelf)) {
        logger.debug({ task_id: stored.task.id, reply: index }, 'reply already on the ticket');
        continue;
      }
      await ticketWrites(integrations).replyComment(stored.task.ticket, body(markerId), {
        ...writeContext,
        idempotencyKey,
        markerId,
      });
      asked += 1;
      continue;
    }
    logger.warn(
      { task_id: stored.task.id, reply: index, thread_id: loggable(entry.thread_id, redactor) },
      'reply dropped: its thread is neither a discussion on the merge request nor a comment on the ticket',
    );
  }
  logger.info(
    { task_id: stored.task.id, run_id: runId, replies: replies.length, asked },
    'conversation replies posted',
  );
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
  data: PipelineOutboundData,
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
    resolved += 1;
  }
  logger.info(
    { task_id: stored.task.id, named: named.length, resolved },
    'review threads resolved after the re-review',
  );
};

/** The handler this module registers, for the runtime to spread. */
export const reviewConversationHandlers = (
  options: PipelineSagaOptions,
): readonly EventHandler[] => [reviewConversationHandler(options)];

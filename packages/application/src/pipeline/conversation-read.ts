/**
 * **The conversation a run reads** — the merge request's discussions and the ticket's comments, read
 * through the executor, redacted with each binding's redactor and bounded (WP-180, TD-029 decision
 * 11, BD-031 ruling 6, PROGRESS backlog 537 (c)).
 *
 * One reader, two consumers: the planner turns its answer into the `conversation` data blocks of
 * every agent stage's prompt (`assemblePrompt` renders them, WP-175), and `get_conversation`
 * answers the same entries as JSON ({@link conversationToolAnswer}). So the tool and the block can
 * never disagree about what the conversation was.
 *
 * ## What is read, and what is left out
 *
 * - **Every note of every discussion** (`listDiscussions`, WP-173: general notes are listed whatever
 *   `resolvable` says), from bots and people alike, **except provider system notes** ("changed the
 *   description"), which are nobody's word. A note the platform posted stays in and is labelled
 *   `platform: true` — decided **by marker, never by author** (`isPlatformWord`, TD-029 decision 6).
 * - **The ticket's comments** (`listComments`, WP-171), one page of {@link CONVERSATION_MAX_ENTRIES},
 *   when the task names a provider ticket and its binding declares `commentsRead`.
 * - A source with no binding, or a task with no merge request, contributes nothing. A task with
 *   **neither** source answers `null`: no block at all, which is a different statement from an
 *   empty conversation (`entries="0"`).
 *
 * ## The author: the stable handle, and the display name beside it
 *
 * TD-029 decision 11's WP-175 amendment: `author_ref` derives from the provider's **stable handle**
 * and never from the display name, so two people who share a name keep two refs. The handle this
 * reader passes is the port's `ExternalIdentity.external_id` — Jira's `accountId` (the amendment's
 * value) and, for GitLab, the user's numeric **id** (`identityOf` in the GitLab adapter), which the
 * port carries where the amendment names `author.username`. Both are per-account and stable; the id
 * survives a username rename, which the username does not. Recorded under WP-180 in PROGRESS.
 *
 * ## Redacted, then bounded, newest first; presented oldest first
 *
 * Every untrusted value — the body, the display name, the handle, the path and the id — goes through
 * the redactor of the binding that answered it (TD-012 steps 1 and 2, as the loader composed it),
 * **before** the bound, because an exact-match redactor cannot find a secret a cut has halved. An id
 * the redactor changed carries a placeholder the marker set refuses, so the assembler omits that entry
 * and counts it (`omitted`), rather than the model quoting back an id no provider issued.
 *
 * The bound keeps the **newest** {@link CONVERSATION_MAX_ENTRIES} entries and at most
 * {@link CONVERSATION_MAX_CHARS} characters of note text: walking newest first, an entry that fits
 * is kept, the first one that does not is cut to what is left (when anything is) and the walk stops.
 * Any entry dropped, any body cut, or a comment page whose `total` says the ticket holds more (or
 * does not say) makes the conversation `truncated`, which the assembler announces on every marker —
 * never as a line in a body. The answer is ordered oldest first.
 */
import type { Id, MergeRequestRef, TicketRef } from '@platform/contracts';
import type { PromptConversation, PromptConversationEntry } from '@platform/domain';
import { isPlatformWord } from '@platform/domain';
import { TransactionOpenError } from '../events/open-transaction.js';
import type { SecretRedactor } from '../ports/integrations/audit.js';
import type { Discussion } from '../ports/integrations/git-provider.js';
import type { CommentPage } from '../ports/integrations/task-management.js';
import {
  gitReads,
  integrationsForProject,
  noRunScopedSecrets,
  type PipelineIntegrationsPort,
  ticketReads,
} from './integrations.js';

/** The newest entries a conversation keeps (TD-029 decision 11, WP-180 ruling (a)). */
export const CONVERSATION_MAX_ENTRIES = 40;

/** The most note text, in characters, a conversation keeps (WP-180 ruling (a)). */
export const CONVERSATION_MAX_CHARS = 24_000;

/** What the reader is asked about: the run's own task, never one a model named. */
export interface ConversationSubject {
  readonly projectId: Id;
  readonly taskId: Id;
  readonly ticket: TicketRef;
  readonly mr: MergeRequestRef | null;
}

/**
 * The reader: the bounded, redacted conversation, or `null` when the task has no source to read.
 * A failed provider read **throws** — the planner decides what a failure means (WP-180 ruling (b)).
 */
export type ConversationReader = (
  subject: ConversationSubject,
) => Promise<PromptConversation | null>;

/** What one source answered, with the redactor of the binding that answered it. */
export interface ConversationSources {
  readonly discussions: {
    readonly items: readonly Discussion[];
    readonly redactor: SecretRedactor;
  } | null;
  readonly comments: { readonly page: CommentPage; readonly redactor: SecretRedactor } | null;
}

const redactWith =
  (redactor: SecretRedactor) =>
  (value: string): string =>
    redactor.redactText(value).value;

const mergeRequestEntries = (
  discussions: NonNullable<ConversationSources['discussions']>,
): PromptConversationEntry[] => {
  const redact = redactWith(discussions.redactor);
  return discussions.items.flatMap((discussion) =>
    discussion.notes
      .filter((note) => !note.system)
      .map((note): PromptConversationEntry => {
        const path = note.path ?? null;
        return {
          source: 'mr',
          threadId: redact(discussion.id),
          authorHandle: redact(note.author.external_id),
          author: redact(note.author.display_name ?? note.author.external_id),
          // Decided on the provider's own text, before redaction: a marker carries no secret.
          platform: isPlatformWord({
            form: path === null ? 'mr_note' : 'mr_diff',
            text: note.body,
            at: note.created_at,
          }),
          createdAt: note.created_at,
          path: path === null ? null : redact(path),
          line: path === null ? null : (note.line ?? null),
          body: redact(note.body),
        };
      }),
  );
};

const ticketEntries = (
  comments: NonNullable<ConversationSources['comments']>,
): PromptConversationEntry[] => {
  const redact = redactWith(comments.redactor);
  return comments.page.comments.map(
    (comment): PromptConversationEntry => ({
      source: 'ticket',
      commentId: redact(comment.id),
      authorHandle: redact(comment.author.external_id),
      author: redact(comment.author.display_name ?? comment.author.external_id),
      platform: isPlatformWord({
        form: 'ticket_comment',
        text: comment.body,
        at: comment.created_at,
        markerId: comment.marker_id ?? null,
      }),
      createdAt: comment.created_at,
      path: null,
      line: null,
      body: redact(comment.body),
    }),
  );
};

/**
 * The first `chars` UTF-16 units of `text`, one fewer when the cut would split a surrogate pair —
 * half a pair is not a character, and the model would read a replacement glyph (review round 1).
 */
export const cutAtCodePoint = (text: string, chars: number): string => {
  if (chars <= 0) return '';
  const cut = text.slice(0, chars);
  const last = cut.charCodeAt(cut.length - 1);
  return cut.length < text.length && last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
};

/** Which read failed: resolving the bindings, the merge request's discussions or the comments. */
export type ConversationReadSource = 'bindings' | 'mr' | 'ticket';

/**
 * A conversation read that failed, naming its source (review round 1), with the provider's error as
 * `cause`. `TransactionOpenError` is never wrapped: it is a moved call, and the planner rethrows it.
 */
export class ConversationReadError extends Error {
  override readonly name = 'ConversationReadError';
  readonly source: ConversationReadSource;
  readonly causeName: string;

  constructor(source: ConversationReadSource, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.source = source;
    this.causeName = cause instanceof Error ? cause.name : 'unknown';
  }
}

const attributed = async <T>(
  source: ConversationReadSource,
  read: () => Promise<T>,
): Promise<T> => {
  try {
    return await read();
  } catch (error) {
    if (error instanceof TransactionOpenError) throw error;
    throw new ConversationReadError(source, error);
  }
};

/** An instant for ordering; an unparsable one sorts as the oldest, and the assembler refuses it. */
const instantOf = (entry: PromptConversationEntry): number => {
  const at = Date.parse(entry.createdAt);
  return Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
};

/**
 * The pure half: what the sources answered, redacted and bounded, oldest first. `null` when no
 * source was read.
 */
export const conversationFrom = (sources: ConversationSources): PromptConversation | null => {
  if (sources.discussions === null && sources.comments === null) {
    return null;
  }
  const all = [
    ...(sources.discussions === null ? [] : mergeRequestEntries(sources.discussions)),
    ...(sources.comments === null ? [] : ticketEntries(sources.comments)),
  ];
  // Newest first, stable: two notes of one instant keep the order the providers answered.
  const newestFirst = all
    .map((entry, index) => ({ entry, index }))
    .sort(
      (left, right) => instantOf(right.entry) - instantOf(left.entry) || right.index - left.index,
    )
    .map(({ entry }) => entry);
  const page = sources.comments?.page ?? null;
  let truncated = page !== null && (page.total === null || page.total > page.comments.length);
  const kept: PromptConversationEntry[] = [];
  let remaining = CONVERSATION_MAX_CHARS;
  for (const entry of newestFirst) {
    if (kept.length === CONVERSATION_MAX_ENTRIES) {
      truncated = true;
      break;
    }
    if (entry.body.length <= remaining) {
      kept.push(entry);
      remaining -= entry.body.length;
      continue;
    }
    truncated = true;
    const body = cutAtCodePoint(entry.body, remaining);
    if (body.length > 0) {
      kept.push({ ...entry, body });
    }
    break;
  }
  return { entries: kept.reverse(), truncated };
};

export interface ConversationReaderOptions {
  readonly integrations: PipelineIntegrationsPort;
}

/**
 * The production reader: the project's bindings resolved per call, both reads through
 * `IntegrationActionExecutor` (audited, rate-limited, refused inside a transaction). **No run-scoped
 * secret** is in scope: the planner reads before the run exists, so no credential has been minted
 * for it (the scope WP-181's tool needs is that row's decision).
 */
export const createConversationReader =
  (options: ConversationReaderOptions): ConversationReader =>
  async (subject) => {
    const integrations = await attributed('bindings', () =>
      integrationsForProject(options.integrations, subject.projectId, noRunScopedSecrets()),
    );
    const context = { projectId: subject.projectId, taskId: subject.taskId };
    const git = integrations.git;
    const mr = subject.mr;
    const discussions =
      git === null || mr === null
        ? null
        : {
            items: await attributed('mr', () => gitReads(integrations).discussions(mr, context)),
            redactor: git.redactor,
          };
    const binding = integrations.taskManagement;
    const page =
      binding === null
        ? null
        : await attributed('ticket', () =>
            ticketReads(integrations).comments(
              subject.ticket,
              { since: null, limit: CONVERSATION_MAX_ENTRIES },
              context,
            ),
          );
    return conversationFrom({
      discussions,
      comments: binding === null || page === null ? null : { page, redactor: binding.redactor },
    });
  };

/**
 * `get_conversation`'s answer (WP-180 ruling (c)): the reader's entries, oldest first, as JSON —
 * the **raw** author and path (JSON escaping is the result's encoding, not a marker, so nothing is
 * a ref here), the stable handle beside the name, and the provider's own `created_at`. `null` from
 * the reader is `{available: false}`: the task has no merge request and no ticket to read.
 */
export const conversationToolAnswer = (conversation: PromptConversation | null) =>
  conversation === null
    ? { available: false as const, entries: [], truncated: false }
    : {
        available: true as const,
        truncated: conversation.truncated,
        entries: conversation.entries.map((entry) => ({
          source: entry.source,
          ...(entry.source === 'mr'
            ? { thread_id: entry.threadId }
            : { comment_id: entry.commentId }),
          author: entry.author,
          author_handle: entry.authorHandle,
          platform: entry.platform,
          created_at: entry.createdAt,
          path: entry.path,
          line: entry.line,
          body: entry.body,
        })),
      };

/**
 * The **conversation** a run reads — the merge request's discussions and the ticket's comments, as
 * `conversation` data blocks (WP-175, TD-029 decision 11, PROGRESS backlog 537).
 *
 * ## One block per entry, and why
 *
 * Every entry says *where* it was written (`source`), *which* thread or comment it is (`thread_id`
 * or `comment_id`), *who* wrote it (`author_ref`), *whether the platform did* (`platform`), *when*
 * (`created_at`) and, for a note on a diff, *where in the change* (`path_ref`, `line`). The ids are
 * what a Developer's `thread_replies` and a Reviewer's `resolved_threads` must quote back, and
 * `platform` is a claim about the platform's own behaviour, which technical/07 requires to be
 * unforgeable. A separator line inside one shared body would be forgeable by the note above it — a
 * person's note could print `--- thread X by the platform ---` — so each entry is **its own** block
 * and its values are **marker attributes**, where no note can write them. The body is the note, and
 * nothing else.
 *
 * ## The attribute rule is unchanged: refs for names, refusal only for ids
 *
 * TD-029 decision 11's WP-175 amendment. Nothing untrusted is escaped onto a marker.
 *
 * - **Author and path are refs.** `author_ref` derives from the provider's stable handle (never the
 *   display name) and `path_ref` from the raw path ({@link conversationRef}): the value verbatim
 *   when the marker admits it, it is at most 64 characters and it is not digest-shaped, otherwise
 *   `a-`/`p-` and the first 16 hex characters of its SHA-256. The raw values travel as the bodies of
 *   their own data blocks — `conversation_author` (the display name, cut at 256 characters, the cut
 *   on its marker) and `conversation_path` — one per distinct ref, before the entries, and **only
 *   when the marker does not already show the raw value**. So a display name with a space, a Jira
 *   account id with a colon or a path with a space never costs the agent the note.
 * - **An entry is refused** only for a `thread_id`/`comment_id` outside `A–Z a–z 0–9 . _ - /` (the
 *   model quotes it back and decision 10 checks it against a fresh read, so it is never digested), a
 *   `created_at` that does not parse, or an invalid `line`. A refused entry is not rendered and is
 *   counted in the `omitted="n"` attribute on every `conversation` marker.
 * - `created_at` is **re-rendered** rather than passed through: an ISO 8601 instant carries `:` (and
 *   often `+`), which the alphabet excludes, so it is parsed and printed in ISO 8601's basic format
 *   (`20261008T091523.000Z`). The provider's string never reaches the marker.
 *
 * ## What the caller has already done
 *
 * The bodies are **redacted and bounded by the caller** (WP-180: each binding's redactor, the newest
 * 40 entries and at most 24 000 characters), so this module cuts no note and emits every body
 * byte-identical. A display name is the one exception: it is cut here, at 256 characters, because
 * the caller's bound is on the notes. A cut the caller made is announced as `truncated="true"` on
 * every `conversation` marker — never as a line in a body, which a note could write for itself. Entries are ordered **oldest first** by
 * the instant they were written, whatever order they arrive in (a stable sort, so two notes of the
 * same instant keep the caller's order).
 *
 * ## The conversation-wide attributes
 *
 * `entries` (how many entry blocks the conversation has), `omitted` and `truncated` are repeated on
 * every entry's marker, so any one block read on its own tells the truth about the whole. A conversation
 * the caller supplied with **no** renderable entry is still one block — `entries="0"`, its
 * `omitted`, an empty body — because *the platform read the conversation and there is nothing* is a
 * different fact from *the platform gave this run no conversation* (no block at all).
 */
import { type DataBlock, markerValueRefusal } from './data-block.js';
import { sha256Hex } from './sha256.js';

/** Where an entry was written. Platform vocabulary, in the marker. */
export type ConversationSource = 'mr' | 'ticket';

interface ConversationEntryBase {
  /**
   * Who wrote it, as the provider displays them (`Jane Doe`) — redacted by the caller. Untrusted,
   * and never on a marker: it is the body of the entry's `conversation_author` block, cut at
   * {@link MAX_CONVERSATION_AUTHOR_CHARS}.
   */
  readonly author: string;
  /**
   * The provider's **stable handle** for the author — GitLab `author.username`, Jira
   * `author.accountId` (TD-029 decision 11's WP-175 amendment). `author_ref` derives from it and
   * never from {@link author}, so one person has one ref across the conversation and two people who
   * share a display name keep two. Untrusted: verbatim on the marker only when it is safe there.
   */
  readonly authorHandle: string;
  /**
   * Whether the platform wrote it — decided by the caller **by marker, never by author** (TD-029
   * decision 6; `isPlatformWord` in `lifecycle/human-return.ts`). A platform boolean.
   */
  readonly platform: boolean;
  /** When it was written: an ISO 8601 extended-format instant, re-rendered in the basic format. */
  readonly createdAt: string;
  /**
   * The file a diff note is anchored to, or null. Untrusted: on the marker as `path_ref`, verbatim
   * only when it is safe there, and otherwise in a `conversation_path` block.
   */
  readonly path: string | null;
  /**
   * The line a diff note is anchored to, or null. A positive integer with a {@link path}, or the
   * entry is refused: a line with no file names no place, and the platform does not guess one.
   */
  readonly line: number | null;
  /** The note's text — redacted and bounded by the caller, emitted byte-identical. Untrusted. */
  readonly body: string;
}

/** A merge-request note: every note belongs to a discussion (WP-173), named by `threadId`. */
export interface MergeRequestConversationEntry extends ConversationEntryBase {
  readonly source: 'mr';
  readonly threadId: string;
}

/** A ticket comment, named by `commentId`. */
export interface TicketConversationEntry extends ConversationEntryBase {
  readonly source: 'ticket';
  readonly commentId: string;
}

export type PromptConversationEntry = MergeRequestConversationEntry | TicketConversationEntry;

/** {@link PromptTask.conversation}: what the caller read, bounded, redacted. */
export interface PromptConversation {
  readonly entries: readonly PromptConversationEntry[];
  /** The caller's bound cut older entries or a body (WP-180). Announced on every marker. */
  readonly truncated: boolean;
}

/** The kind every conversation block carries. */
export const CONVERSATION_BLOCK_KIND = 'conversation';

/**
 * An ISO 8601 **extended**-format instant with a zone — the shape `isoDateTimeSchema` admits.
 * Anchored, so `Date.parse`'s looser forms (`Oct 8 2026`, a bare date) are refused rather than
 * guessed at.
 */
const EXTENDED_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * The platform's printing of an instant, in ISO 8601's **basic** format — `20261008T091523.000Z` —
 * or `null` when the value is not an instant the platform can read.
 *
 * Exported so a caller (and a test) can name the attribute a given note will carry.
 */
export const conversationInstant = (value: string): string | null => {
  if (!EXTENDED_INSTANT.test(value)) return null;
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  const iso = new Date(at).toISOString();
  // A year past 9999 prints as `+0…`; the anchored pattern above rules it out, and this re-checks it.
  return /^\d{4}-/.test(iso) ? iso.replaceAll('-', '').replaceAll(':', '') : null;
};

/** The kind of the block that carries an author's display name, keyed by `author_ref`. */
export const CONVERSATION_AUTHOR_BLOCK_KIND = 'conversation_author';
/** The kind of the block that carries a raw path, keyed by `path_ref`. */
export const CONVERSATION_PATH_BLOCK_KIND = 'conversation_path';

/** A display name reaches the prompt cut at this many characters, the cut on the marker. */
export const MAX_CONVERSATION_AUTHOR_CHARS = 256;

/** The longest raw value a ref carries verbatim; longer ones are digested. */
export const MAX_VERBATIM_REF_CHARS = 64;

/**
 * The digest shape, for **either** prefix: a raw handle or path shaped like one is digested itself,
 * so no provider value can pose as another value's digest.
 */
const DIGEST_REF = /^[ap]-[0-9a-f]{16}$/;

/**
 * The platform's ref for a raw author handle (`a`) or path (`p`): the value verbatim when the marker
 * admits it, it is at most {@link MAX_VERBATIM_REF_CHARS} characters and it is not digest-shaped;
 * otherwise the prefix and the first 16 hex characters of its SHA-256. Never refuses.
 */
export const conversationRef = (prefix: 'a' | 'p', raw: string): string =>
  markerValueRefusal(raw) === 'ok' && raw.length <= MAX_VERBATIM_REF_CHARS && !DIGEST_REF.test(raw)
    ? raw
    : `${prefix}-${sha256Hex(raw).slice(0, 16)}`;

interface RenderableEntry {
  readonly attributes: Readonly<Record<string, string | number>>;
  readonly at: number;
  readonly authorRef: string;
  /** Whether `authorRef` is the handle itself rather than its digest. */
  readonly authorVerbatim: boolean;
  readonly author: string;
  readonly pathRef: string | null;
  readonly path: string | null;
  readonly body: string;
}

/**
 * The entry's marker attributes, or `null` when the entry must be refused — only for an id the
 * marker cannot print (the model must quote it back, so it is never digested), an instant that
 * does not parse, or an invalid `line`. The author and the path never refuse an entry.
 */
const entryAttributes = (entry: PromptConversationEntry): RenderableEntry | null => {
  const id =
    entry.source === 'mr'
      ? { name: 'thread_id', value: entry.threadId }
      : { name: 'comment_id', value: entry.commentId };
  if (markerValueRefusal(id.value) !== 'ok') return null;
  const createdAt = conversationInstant(entry.createdAt);
  if (createdAt === null) return null;
  if (entry.line !== null && !(Number.isSafeInteger(entry.line) && entry.line > 0)) return null;
  if (entry.path === null && entry.line !== null) return null;
  const authorRef = conversationRef('a', entry.authorHandle);
  const pathRef = entry.path === null ? null : conversationRef('p', entry.path);
  return {
    attributes: {
      source: entry.source,
      [id.name]: id.value,
      author_ref: authorRef,
      ...(pathRef === null ? {} : { path_ref: pathRef }),
      platform: entry.platform ? 'true' : 'false',
      created_at: createdAt,
      ...(entry.line === null ? {} : { line: entry.line }),
    },
    at: Date.parse(entry.createdAt),
    authorRef,
    authorVerbatim: authorRef === entry.authorHandle,
    author: entry.author,
    pathRef,
    path: entry.path,
    body: entry.body,
  };
};

/**
 * One `conversation_author` block per distinct `author_ref` whose display name the marker does not
 * already show, carrying the **newest** entry's name for that ref (the entries arrive oldest first).
 */
const authorBlocks = (rendered: readonly RenderableEntry[]): DataBlock[] => {
  const names = new Map<string, string>();
  const verbatim = new Set<string>();
  for (const entry of rendered) {
    names.delete(entry.authorRef);
    names.set(entry.authorRef, entry.author);
    if (entry.authorVerbatim) verbatim.add(entry.authorRef);
  }
  const firstSeen = [...new Set(rendered.map((entry) => entry.authorRef))];
  return firstSeen.flatMap((ref) => {
    const name = names.get(ref) as string;
    // Skipped only when the marker shows the handle itself and the name is that handle — a name
    // spelled like a digest under an unsafe handle still gets its block (WP-175 review).
    if (verbatim.has(ref) && name === ref) return [];
    const cut = name.length > MAX_CONVERSATION_AUTHOR_CHARS;
    return [
      {
        kind: CONVERSATION_AUTHOR_BLOCK_KIND,
        attributes: {
          author_ref: ref,
          ...(cut ? { truncated: 'true', original_chars: name.length } : {}),
        },
        body: cut ? name.slice(0, MAX_CONVERSATION_AUTHOR_CHARS) : name,
      },
    ];
  });
};

/** One `conversation_path` block per distinct `path_ref` that is not the raw path itself. */
const pathBlocks = (rendered: readonly RenderableEntry[]): DataBlock[] => {
  const paths = new Map<string, string>();
  for (const entry of rendered) {
    if (entry.pathRef !== null && entry.path !== null && entry.pathRef !== entry.path) {
      if (!paths.has(entry.pathRef)) paths.set(entry.pathRef, entry.path);
    }
  }
  return [...paths].map(([ref, path]) => ({
    kind: CONVERSATION_PATH_BLOCK_KIND,
    attributes: { path_ref: ref },
    body: path,
  }));
};

/**
 * The conversation's blocks: the `conversation_author` and `conversation_path` blocks the entries
 * need, then one `conversation` block per renderable entry, oldest first — or a single empty
 * `conversation` block when nothing is renderable. Every `conversation` marker carries `entries`,
 * `omitted` and, when the caller cut, `truncated`.
 */
export const conversationBlocks = (conversation: PromptConversation): readonly DataBlock[] => {
  const rendered: RenderableEntry[] = [];
  let omitted = 0;
  for (const entry of conversation.entries) {
    const renderable = entryAttributes(entry);
    if (renderable === null) {
      omitted += 1;
    } else {
      rendered.push(renderable);
    }
  }
  // `Array.prototype.sort` is stable since ES2019, so notes of one instant keep the caller's order.
  rendered.sort((left, right) => left.at - right.at);
  const shared = {
    entries: rendered.length,
    omitted,
    ...(conversation.truncated ? { truncated: 'true' } : {}),
  };
  if (rendered.length === 0) {
    return [{ kind: CONVERSATION_BLOCK_KIND, attributes: shared, body: '' }];
  }
  return [
    ...authorBlocks(rendered),
    ...pathBlocks(rendered),
    ...rendered.map((entry) => ({
      kind: CONVERSATION_BLOCK_KIND,
      attributes: { ...entry.attributes, ...shared },
      body: entry.body,
    })),
  ];
};

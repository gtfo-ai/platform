/**
 * The mined history, bounded and redacted at the write — WP-35, product/19 §18.
 *
 * This is the fifth place the platform keeps somebody else's words, after `inbox`, `kb_chunks`,
 * `tasks.ticket_snapshot` and `tasks.review_subject`, and it takes the same three decisions all
 * four of them take (TD-012, BD-022):
 *
 *  1. **redact, then cut, in that order and never the other way round** — an exact-match redactor
 *    cannot find a secret a cut has already halved (`ticket-snapshot.ts` states the argument and
 *    `inbound.ts` the refusal path it comes from);
 *  2. **`redaction_count` is over the text as it was read**, not as it is stored, so a sample whose
 *    secret was cut off still says a secret was there — the only signal a redactor that stopped
 *    working leaves;
 *  3. **every cap is a cut with a marker, never a refusal**: a review comment nobody can shorten
 *    must still be mineable (standing rule 20).
 *
 * ## The byte budget, and where the numbers came from
 *
 * The anchor is the one this repository already has: `TICKET_SNAPSHOT_MAX_TEXT_CHARS` = **45 632
 * characters** is what one *ticket* may cost a prompt, derived at `ticket-snapshot.ts` from the
 * 12 000-token pack budget and `MAX_ARTIFACT_CHARS`. One mining run's prompt holds **twenty merge
 * requests**, so the question is what a merge request may cost relative to a ticket, and the answer
 * is stated rather than chosen:
 *
 * > a merge request in a sample is bounded at **one twelfth of a ticket**, because twenty of them
 * > share one prompt and a ticket's bound is what *one document* may cost.
 *
 * | part | cap | worst case |
 * |---|---|---|
 * | merge request: title | {@link MAX_HISTORY_TITLE_CHARS} = 512 | — |
 * | merge request: review notes | {@link MAX_HISTORY_NOTES_PER_MR} = 8 × {@link MAX_HISTORY_NOTE_CHARS} = 400 | 3 712 per merge request |
 * | merge requests per run | {@link BOOTSTRAP_BATCH_SIZE} = 20 | **74 240** |
 * | ticket: title + description + {@link MAX_HISTORY_TICKET_COMMENTS} = 4 comments | 512 + 2 000 + 4 × 400 | 4 112 per ticket |
 * | tickets per run | {@link HISTORY_TICKETS_PER_CHUNK} = 5 | **20 560** |
 * | commit messages per run | {@link HISTORY_COMMITS_PER_CHUNK} = 20 × {@link MAX_HISTORY_COMMIT_CHARS} = 200 | **4 000** |
 *
 * {@link HISTORY_SAMPLE_MAX_TEXT_CHARS} is their sum — **98 800 characters**, about **2.2 ×** one
 * ticket snapshot for twenty merge requests, five tickets and twenty commit messages. At four UTF-8
 * bytes per character that is at most **395 200 bytes** in the column before JSON escaping, and for
 * ASCII `estimateTokens` reads it as roughly **39 500** tokens — which is what makes product/19's
 * batch size of twenty a batch that fits in one run rather than a number in a document. The figure
 * is produced by a test from the constants rather than quoted beside them (PROGRESS backlog 22).
 */
import type {
  HistoryCommit,
  HistoryMergeRequest,
  HistorySample,
  HistoryTicket,
} from '@platform/contracts';
import { historySampleSchema } from '@platform/contracts';
import type { SecretRedactor } from '../ports/integrations/audit.js';
import type {
  Discussion,
  MergedMergeRequest,
  RepositoryCommit,
} from '../ports/integrations/git-provider.js';
import type { Ticket } from '../ports/integrations/task-management.js';

export const MAX_HISTORY_TITLE_CHARS = 512;
export const MAX_HISTORY_NOTE_CHARS = 400;
export const MAX_HISTORY_NOTES_PER_MR = 8;
export const MAX_HISTORY_AUTHOR_CHARS = 128;
export const MAX_HISTORY_TICKET_DESCRIPTION_CHARS = 2_000;
export const MAX_HISTORY_TICKET_COMMENTS = 4;
export const MAX_HISTORY_COMMIT_CHARS = 200;

/** How many closed tickets and commit messages ride beside one chunk's twenty merge requests. */
export const HISTORY_TICKETS_PER_CHUNK = 5;
export const HISTORY_COMMITS_PER_CHUNK = 20;

/** Derived from the caps above; see the table in the module docblock. */
export const HISTORY_SAMPLE_MAX_TEXT_CHARS = (batchSize: number): number =>
  batchSize * (MAX_HISTORY_TITLE_CHARS + MAX_HISTORY_NOTES_PER_MR * MAX_HISTORY_NOTE_CHARS) +
  HISTORY_TICKETS_PER_CHUNK *
    (MAX_HISTORY_TITLE_CHARS +
      MAX_HISTORY_TICKET_DESCRIPTION_CHARS +
      MAX_HISTORY_TICKET_COMMENTS * MAX_HISTORY_NOTE_CHARS) +
  HISTORY_COMMITS_PER_CHUNK * MAX_HISTORY_COMMIT_CHARS;

interface Cut {
  readonly text: string;
  readonly truncated: boolean;
}

interface Redacting {
  count: number;
}

const cut = (text: string, max: number): Cut =>
  text.length <= max ? { text, truncated: false } : { text: text.slice(0, max), truncated: true };

/** Redact then cut — `ticket-snapshot.ts` carries the argument for the order. */
const clean = (raw: string, max: number, redactor: SecretRedactor, tally: Redacting): Cut => {
  const redacted = redactor.redactText(raw);
  tally.count += redacted.count;
  return cut(redacted.value, max);
};

/**
 * A URL is redacted but **not cut**: half a URL is a link that resolves to nothing, and the whole
 * point of the sample's `evidence_links` is that a citation can be followed. A provider URL longer
 * than the cap would be pathological, and the cap it would hit instead is the schema's own.
 */
const cleanUrl = (raw: string, redactor: SecretRedactor, tally: Redacting): string => {
  const redacted = redactor.redactText(raw);
  tally.count += redacted.count;
  return redacted.value;
};

/** The non-system notes of one merge request's threads, oldest first, newest kept. */
const notesOf = (
  discussions: readonly Discussion[],
  redactor: SecretRedactor,
  tally: Redacting,
): { readonly notes: readonly string[]; readonly rounds: number; readonly truncated: boolean } => {
  const human = discussions.filter((discussion) =>
    discussion.notes.some((note) => note.system !== true),
  );
  const flat = human.flatMap((discussion) =>
    discussion.notes
      .filter((note) => note.system !== true)
      .map((note) => ({
        at: Date.parse(note.created_at) || 0,
        author: note.author.display_name ?? '',
        body: note.body,
      })),
  );
  // Newest first for the *selection* — the decisive round of a long review is at the bottom — and
  // oldest first in the output, because a thread reads forwards (`commentsOf`'s answer).
  const kept = [...flat]
    .sort((left, right) => right.at - left.at)
    .slice(0, MAX_HISTORY_NOTES_PER_MR);
  const notes = [...kept].reverse().map((note) => {
    const author = clean(note.author, MAX_HISTORY_AUTHOR_CHARS, redactor, tally);
    const body = clean(note.body, MAX_HISTORY_NOTE_CHARS, redactor, tally);
    return {
      line: `--- ${author.text} ---\n${body.text}`,
      truncated: author.truncated || body.truncated,
    };
  });
  return {
    notes: notes.map((note) => note.line),
    // product/19 §18's *"MRs with ≥ 3 review rounds"*: the platform's own count of non-system
    // threads, which `curateHistoryFindings` holds a `pitfall` to. It counts **threads** and not
    // notes, because a round of review is a thread somebody opened.
    rounds: human.length,
    truncated: flat.length > kept.length || notes.some((note) => note.truncated),
  };
};

export const boundMergeRequest = (
  input: { readonly mr: MergedMergeRequest; readonly discussions: readonly Discussion[] },
  redactor: SecretRedactor,
  tally: Redacting,
): HistoryMergeRequest => {
  const { notes, rounds, truncated } = notesOf(input.discussions, redactor, tally);
  const title = clean(input.mr.title, MAX_HISTORY_TITLE_CHARS, redactor, tally);
  const author = clean(
    input.mr.author.display_name ?? '',
    MAX_HISTORY_AUTHOR_CHARS,
    redactor,
    tally,
  );
  return {
    ref: `!${input.mr.ref.iid}`,
    url: cleanUrl(input.mr.ref.url, redactor, tally),
    title: title.text,
    author: author.text,
    merged_at: input.mr.merged_at,
    rounds,
    files_changed: input.mr.diff_stats?.files_changed ?? null,
    notes: [...notes],
    truncated: truncated || title.truncated || author.truncated,
  };
};

export const boundTicket = (
  ticket: Ticket,
  redactor: SecretRedactor,
  tally: Redacting,
): HistoryTicket => {
  const title = clean(ticket.title, MAX_HISTORY_TITLE_CHARS, redactor, tally);
  const description = clean(
    ticket.description,
    MAX_HISTORY_TICKET_DESCRIPTION_CHARS,
    redactor,
    tally,
  );
  // The platform's own comments are skipped for `commentsOf`'s reason: showing an agent the workpad
  // the platform rendered would be feeding it the platform's words as a human's.
  const human = ticket.comments.filter(
    (comment) => comment.marker_id === null || comment.marker_id === undefined,
  );
  const newest = [...human]
    .sort((left, right) => (Date.parse(right.created_at) || 0) - (Date.parse(left.created_at) || 0))
    .slice(0, MAX_HISTORY_TICKET_COMMENTS);
  const comments = [...newest].reverse().map((comment) => {
    const author = clean(
      comment.author.display_name ?? '',
      MAX_HISTORY_AUTHOR_CHARS,
      redactor,
      tally,
    );
    const body = clean(comment.body, MAX_HISTORY_NOTE_CHARS, redactor, tally);
    return { line: `--- ${author.text} ---\n${body.text}`, truncated: body.truncated };
  });
  return {
    key: clean(ticket.ref.key, MAX_HISTORY_AUTHOR_CHARS, redactor, tally).text,
    url: cleanUrl(ticket.ref.url, redactor, tally),
    title: title.text,
    description: description.text,
    comments: comments.map((comment) => comment.line),
    truncated:
      title.truncated ||
      description.truncated ||
      human.length > newest.length ||
      comments.some((comment) => comment.truncated),
  };
};

export const boundCommit = (
  commit: RepositoryCommit,
  redactor: SecretRedactor,
  tally: Redacting,
): HistoryCommit => {
  const message = clean(commit.message, MAX_HISTORY_COMMIT_CHARS, redactor, tally);
  return {
    // The sha is bounded by `shaSchema` at the port, so it is redacted and not cut.
    sha: redactor.redactText(commit.sha).value,
    message: message.text,
    truncated: message.truncated,
  };
};

/**
 * One chunk's sample: bounded, redacted, and honest about what it dropped.
 *
 * Pure and total — there is no input for which this throws before the closing `parse`, which is the
 * one place the builder is held to the published shape and can therefore only fire for a drift in
 * this function rather than for a provider's data.
 *
 * `evidence_links` is the platform's own list of what it put in the prompt, and it is the reason a
 * mined citation is checkable at all: `curateHistoryFindings` refuses a proposal whose link is not
 * in it. It is built here rather than derived later because *here* is where the platform knows.
 */
export const buildHistorySample = (input: {
  readonly mergeRequests: readonly {
    readonly mr: MergedMergeRequest;
    readonly discussions: readonly Discussion[];
  }[];
  readonly tickets: readonly Ticket[];
  readonly commits: readonly RepositoryCommit[];
  readonly redactor: SecretRedactor;
  /** True when the collection itself dropped something before it got here (a window, a cap). */
  readonly truncated?: boolean;
}): HistorySample => {
  const tally: Redacting = { count: 0 };
  const mergeRequests = input.mergeRequests.map((entry) =>
    boundMergeRequest(entry, input.redactor, tally),
  );
  const tickets = input.tickets
    .slice(0, HISTORY_TICKETS_PER_CHUNK)
    .map((ticket) => boundTicket(ticket, input.redactor, tally));
  const commits = input.commits
    .slice(0, HISTORY_COMMITS_PER_CHUNK)
    .map((commit) => boundCommit(commit, input.redactor, tally));
  return historySampleSchema.parse({
    merge_requests: mergeRequests,
    tickets,
    commits,
    evidence_links: [...mergeRequests.map((mr) => mr.url), ...tickets.map((ticket) => ticket.url)],
    truncated:
      (input.truncated ?? false) ||
      input.tickets.length > tickets.length ||
      input.commits.length > commits.length ||
      mergeRequests.some((mr) => mr.truncated) ||
      tickets.some((ticket) => ticket.truncated) ||
      commits.some((commit) => commit.truncated),
    redaction_count: tally.count,
  } satisfies HistorySample);
};

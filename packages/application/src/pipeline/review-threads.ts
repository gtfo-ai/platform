/**
 * What the human-return window keeps of what it reads — the thread counts for the Checks panel, and
 * every person's word for the Developer it sends the task back to (WP-46, rewritten at WP-178).
 *
 * The window (`reviewWindowHandler`, `jobs.ts`) reads every discussion on the merge request when it
 * closes. Until WP-46 the count of unresolved ones was all it kept, and the count became the return
 * reason — *"2 unresolved review threads"*. WP-46 added the reviewers' own words. **Until WP-178 the
 * window also decided on that count**: only a resolvable, unresolved thread with a person's note
 * returned the task, so a GitLab general note (`resolvable: false`) armed the window and was then
 * dropped, and the ticket's comments and status were never read (PROGRESS § "Architect ruling (M10
 * head, session 15)"). Since WP-178 the window reads four signals — the merge request's diff and
 * general notes, the ticket's comments and its status — and decides with the domain's
 * `humanReturnDecision` (TD-029 decisions 6–9); this module turns what it read into words
 * ({@link mergeRequestWords}, {@link ticketCommentWords}) and the words into the return reason
 * ({@link humanReturnFeedback}).
 *
 * ## The count is the panel's, and only the panel's
 *
 * {@link isOpenReviewThread} — resolvable, not resolved, and at least one note a person wrote — is
 * still the predicate of the Checks panel's *"review threads open/resolved"*
 * ({@link reviewThreadCounts}). It is **not** the return trigger any more (WP-178 (d)): a general
 * note is no thread in the panel's sense and is a word that returns the task.
 *
 * ## The words are untrusted, and every rule of the agent half applies to them
 *
 * A note or a comment is provider text somebody typed (BD-022). It reaches a prompt **only** as the
 * body of the `return_feedback` data block, which `assemblePrompt` fences with a per-prompt nonce;
 * nothing here is placed anywhere else. On its way there it is, in this order:
 *
 *  1. **redacted** through the bindings' redactors — both TD-012 steps, the bindings' own
 *     credentials and the platform's pattern rules — because the reason is **stored**: it is
 *     `task_stages.return_reason`, the `task.stage.returned` payload and a chat notification's
 *     detail. Redact *before* cutting, because an exact-match redactor cannot find a secret a cap
 *     has already halved (`ticket-snapshot.ts` has the argument);
 *  2. **collapsed to one line** per word — every line separator a model could use is a space —
 *     so every line of the reason opens with a tag the platform wrote (`[mr thread N]`,
 *     `[mr note N]`, `[ticket comment N]`, `[status]`; WP-46's were `[thread N]` and `[reply N]`)
 *     and a person cannot forge a `[mr thread 9]` line, a finding or a truncation notice. The same
 *     rule, and the same helper, as the agent half (`verdicts.ts`, WP-55);
 *  3. **bounded** at {@link MAX_REVIEW_FEEDBACK_CHARS}. Unlike an agent verdict's reason — a
 *     projection of an artifact row that is itself stored whole — these words exist nowhere
 *     else on the platform, so an unbounded reason would be a new unbounded store of provider text.
 *     The cut writes **no notice in the body**: the bound is deliberately larger than the prompt
 *     block's `MAX_FEEDBACK_CHARS`, so a reason this cut is always cut again by the assembler, and
 *     that cut is announced on the block's marker (`truncated="true"`), never as a line a
 *     person could have typed. The marker's `original_chars` is then the stored length, not the
 *     words' — a residual stated here rather than implied.
 *
 * The first line is platform text: the stage and the forms that returned the task.
 */
import type { TaskReviewThreads } from '@platform/contracts';
import {
  type HumanReturnForm,
  type HumanReturnStage,
  type HumanWord,
  isPlatformMergeRequestNote,
  MAX_FEEDBACK_CHARS,
  personsWordsSince,
} from '@platform/domain';
import type { SecretRedactor } from '../ports/integrations/audit.js';
import type { Discussion } from '../ports/integrations/git-provider.js';
import type { TicketComment } from '../ports/integrations/task-management.js';
import { collapseLines } from './verdicts.js';

/**
 * The most a human-comment return reason stores, in characters.
 *
 * Twice the prompt block's cap, and **strictly** larger than it on purpose: a reason cut here is
 * longer than `MAX_FEEDBACK_CHARS`, so the assembler cuts it again and announces that cut in the
 * block's marker. Equal caps would let a reason cut here arrive at exactly the block's size and be
 * served with no announcement at all.
 */
export const MAX_REVIEW_FEEDBACK_CHARS = 2 * MAX_FEEDBACK_CHARS;

/**
 * Whether a note is the **platform's own** (WP-73, PROGRESS backlog 214): it opens with a platform
 * marker, `<!-- agentic:<kind>:<id> -->`, anchored to the start of the body.
 *
 * **One copy of the marker test** (WP-178 criterion (13)): it delegates to the domain's
 * `isPlatformMergeRequestNote`, which `isPlatformWord` — the human-return decision's reading — reads
 * too. Until WP-178 the regex was here and in the domain, character for character, so a drift
 * between them would have let one note return a task while it was left out of the count, or the
 * other way round. Its callers — the comment handler (`saga.ts`), the poll's person filter
 * (`mr-poll.ts`), the thread refresh (`review-threads-refresh.ts`) and the counts below — therefore
 * agree with the window about whose note it is.
 *
 * **By marker, not by author**, and the reason is a fact about the port rather than a preference:
 * the backlog asked for the binding's own account first, and `GitProviderPort` publishes no
 * *"which account am I"* — a note's `author` is an `ExternalIdentity` nothing compares with the
 * binding's token. The marker is **forgeable**, stated rather than implied: a human who opens a
 * note with one hides that note from the count and from the Developer, and that is the fail-**open**
 * direction — one word fewer means the window does **not** send the task back — so a forged marker
 * can let a task stay at its human stage with a comment nobody acted on. What bounds it: the forger
 * has to be somebody who can comment on the merge request, the thread is still on the provider for
 * whoever merges, and a person who wants a thread ignored can already resolve it. The author check
 * that would close it needs a port member (PROGRESS backlog 266).
 */
export const isPlatformNote = (note: { readonly body: string }): boolean =>
  isPlatformMergeRequestNote(note.body);

/** A note a human wrote: not a provider system note, and not one the platform posted. */
const isHumanNote = (note: Discussion['notes'][number]): boolean =>
  !note.system && !isPlatformNote(note);

/**
 * Open: resolvable, not resolved, and at least one note a **human** wrote (BD-007's predicate).
 *
 * Until WP-73 "a human wrote" was spelt `!note.system`, so the platform's own conflict warning — a
 * bot-authored, non-system, un-anchored thread — counted as an open review thread on the Checks
 * panel, its text reached the Developer as reviewer feedback, and a window it armed could send a
 * `ready_for_merge` task back by itself (PROGRESS backlog 214). **Decided**: a human's reply
 * *inside* a platform thread makes it open — the reply is review conversation, and only the
 * platform's own note is ignored, never the thread's human half.
 */
export const isOpenReviewThread = (discussion: Discussion): boolean =>
  discussion.resolvable && !discussion.resolved && discussion.notes.some(isHumanNote);

/**
 * The panel's record: the window's own predicate for `open`, and resolvable-and-resolved with a
 * human note — so the platform's own threads are in neither number (WP-73, backlog 214).
 */
export const reviewThreadCounts = (
  discussions: readonly Discussion[],
  checkedAt: string,
): TaskReviewThreads => ({
  open: discussions.filter(isOpenReviewThread).length,
  // A platform thread nobody replied to is not a review thread either way (backlog 214).
  resolved: discussions.filter(
    (discussion) =>
      discussion.resolvable && discussion.resolved && discussion.notes.some(isHumanNote),
  ).length,
  checked_at: checkedAt,
});

export interface HumanReturnFeedback {
  readonly reason: string;
  /** How many secrets the redactor replaced — logged by the caller; the reason has no column. */
  readonly redactions: number;
}

/**
 * One person's word as the human-return window read it (WP-178): the domain's {@link HumanWord},
 * plus what the feedback quotes beside it — which thread or comment it belongs to, and a diff
 * note's location. Every field but `form`, `thread` and `reply` is provider text.
 */
export interface WindowWord extends HumanWord {
  /** The discussion's position among the discussions of its form, or the comment's, from 1. */
  readonly thread: number;
  /** A later note in its discussion — a reply, rather than the note that opened the thread. */
  readonly reply: boolean;
  /** A diff note's file. */
  readonly path?: string | null;
  readonly line?: number | null;
}

/**
 * The merge request's words, in the provider's order (WP-178, TD-029 decision 7).
 *
 * **Every note of every discussion, whatever its `resolvable`** (BD-031 ruling 4 (c), the amendment
 * to BD-007): a general note — GitLab lists it as its own discussion, `resolvable: false` — is a
 * word like a diff note. Before WP-178 the window kept only {@link isOpenReviewThread}, which needs
 * `resolvable`, so the product owner's example review of two general notes returned nothing
 * (PROGRESS § "Architect ruling (M10 head, session 15)", measurement 1).
 *
 * A **diff** discussion — one whose notes carry a file (`path`) — gives `mr_diff` words, every
 * other discussion `mr_note` words. A discussion the provider reports **resolved** gives none:
 * BD-007's *"a human resolved the threads inside the window"* is kept, because the batching window
 * is unchanged (BD-031's amendment to BD-007) and a person who resolves their own thread has
 * answered it. A general note is never resolved, so this costs ruling 4 (c) nothing. System and
 * platform notes are kept here and dropped by the decision (decision 6), so one filter decides.
 */
export const mergeRequestWords = (discussions: readonly Discussion[]): readonly WindowWord[] => {
  const seen: Record<'mr_diff' | 'mr_note', number> = { mr_diff: 0, mr_note: 0 };
  const words: WindowWord[] = [];
  for (const discussion of discussions) {
    if (discussion.resolved) {
      continue;
    }
    const form = discussion.notes.some((note) => typeof note.path === 'string')
      ? 'mr_diff'
      : 'mr_note';
    seen[form] += 1;
    discussion.notes.forEach((note, position) => {
      words.push({
        form,
        text: note.body,
        at: note.created_at,
        system: note.system,
        thread: seen[form],
        reply: position > 0,
        path: note.path ?? null,
        line: note.line ?? null,
      });
    });
  }
  return words;
};

/**
 * The ticket's words, oldest first: `listComments` answers newest first, and a person reads a
 * conversation forwards. `marker_id` is the provider's own reading of a platform marker (decision 6).
 */
export const ticketCommentWords = (comments: readonly TicketComment[]): readonly WindowWord[] =>
  [...comments].reverse().map((comment, index) => ({
    form: 'ticket_comment',
    text: comment.body,
    at: comment.created_at,
    markerId: comment.marker_id ?? null,
    thread: index + 1,
    reply: false,
  }));

const FORM_NAMES: Readonly<Record<HumanReturnForm, string>> = {
  status: 'the ticket’s status',
  mr_diff: 'a note on a diff discussion',
  mr_note: 'a general note on the merge request',
  ticket_comment: 'a ticket comment',
};

const tagOf = (word: WindowWord): string => {
  const n = String(word.thread);
  if (word.form === 'ticket_comment') return `[ticket comment ${n}]`;
  const kind = word.form === 'mr_diff' ? 'mr thread' : 'mr note';
  return word.reply ? `[${kind} ${n} reply]` : `[${kind} ${n}]`;
};

/**
 * The return reason for a human return (WP-178, TD-029 decision 7) — what the next implementation
 * run's `return_feedback` block, the retrospective and `get_task_context` are told. It replaces
 * `reviewThreadsReturnReason` (WP-46), and keeps every rule that function had — see the module
 * docblock: **redact before cutting**, **one line per word**, every line opened by a **tag the
 * platform wrote**, and **the bound** — over every form:
 *
 *  - the first line is platform text naming the stage and the forms that returned the task;
 *  - `[status]` — when the status returned it, the status name (provider text, redacted and on one
 *    line) and platform text that tells the agent to read the conversation through
 *    `get_conversation` and to ask a question when it finds nothing to fix (decision 7: a
 *    status-only return carries platform text instead of words);
 *  - then **every person's word newer than the horizon** — acknowledgements included, because they
 *    are part of the conversation the agent answers — tagged `[mr thread N]`, `[mr thread N reply]`,
 *    `[mr note N]`, `[mr note N reply]` or `[ticket comment N]`, a diff note with its location.
 */
export const humanReturnFeedback = (input: {
  readonly stage: HumanReturnStage;
  readonly forms: readonly HumanReturnForm[];
  readonly status: string | null;
  readonly words: readonly WindowWord[];
  readonly horizon: string | null;
  readonly redactor: SecretRedactor;
}): HumanReturnFeedback => {
  let redactions = 0;
  const clean = (text: string): string => {
    const redacted = input.redactor.redactText(text);
    redactions += redacted.count;
    return collapseLines(redacted.value);
  };
  const words = personsWordsSince(input.words, input.horizon);
  const lines = [
    `A person returned the task at ${input.stage}: ${input.forms.map((form) => FORM_NAMES[form]).join(', ')}.`,
  ];
  if (input.status !== null) {
    lines.push(
      `[status] The ticket was moved to "${clean(input.status)}", a status that sends it back to the agent.` +
        (words.length === 0
          ? ' Nobody wrote why: read the merge request’s and the ticket’s conversation with get_conversation to find what to fix, and ask a question if you find nothing to fix.'
          : ' Read the words below, and the whole conversation with get_conversation.'),
    );
  }
  for (const word of words) {
    const where =
      typeof word.path === 'string'
        ? ` ${clean(word.path)}${typeof word.line === 'number' ? `:${String(word.line)}` : ''}`
        : '';
    lines.push(`${tagOf(word)}${where} — ${clean(word.text)}`);
  }
  const reason = lines.join('\n');
  return {
    reason:
      reason.length > MAX_REVIEW_FEEDBACK_CHARS
        ? reason.slice(0, MAX_REVIEW_FEEDBACK_CHARS)
        : reason,
    redactions,
  };
};

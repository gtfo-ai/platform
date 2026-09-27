/**
 * What BD-007's review window keeps of the threads it reads — the counts for the Checks panel, and
 * the human reviewer's own words for the Developer it sends the task back to (WP-46).
 *
 * The window (`reviewWindowHandler`, `jobs.ts`) has always read every discussion on the merge
 * request when it closes and has always counted the unresolved ones, because the count decides
 * whether the task goes back to Implementation. Until WP-46 that was all it kept: the count became
 * the return reason — *"2 unresolved review threads"* — and that sentence was what the next
 * implementation run's `return_feedback` block, the retrospective and `get_task_context` were told.
 * So a human reviewer's words reached the Developer through no channel the platform controls
 * (PROGRESS backlog 159, the human half), and the count reached no screen (backlog 95 item 3).
 *
 * ## The two things kept, and the one rule that decides both
 *
 * **One predicate** decides what a thread is, for both: open is resolvable, not resolved, and has at
 * least one note a human wrote — the predicate the window already returned the task on. The panel's
 * count and the return decision therefore cannot disagree about which threads are open.
 *
 * ## The comments are untrusted, and every rule of the agent half applies to them
 *
 * A comment is provider text somebody typed (BD-022). It reaches a prompt **only** as the body of
 * the `return_feedback` data block, which `assemblePrompt` fences with a per-prompt nonce; nothing
 * here is placed anywhere else. On its way there it is, in this order:
 *
 *  1. **redacted** through the git binding's redactor — both TD-012 steps, the binding's own
 *     credentials and the platform's pattern rules — because the reason is **stored**: it is
 *     `task_stages.return_reason`, the `task.stage.returned` payload and a chat notification's
 *     detail. Redact *before* cutting, because an exact-match redactor cannot find a secret a cap
 *     has already halved (`ticket-snapshot.ts` has the argument);
 *  2. **collapsed to one line** per comment — every line separator a model could use is a space —
 *     so every line of the reason opens with a tag the platform wrote (`[thread N]`, `[reply N]`)
 *     and a commenter cannot forge a `[thread 9]` line, a finding or a truncation notice. The same
 *     rule, and the same helper, as the agent half (`verdicts.ts`, WP-55);
 *  3. **bounded** at {@link MAX_REVIEW_FEEDBACK_CHARS}. Unlike an agent verdict's reason — a
 *     projection of an artifact row that is itself stored whole — these comments exist nowhere
 *     else on the platform, so an unbounded reason would be a new unbounded store of provider text.
 *     The cut writes **no notice in the body**: the bound is deliberately larger than the prompt
 *     block's `MAX_FEEDBACK_CHARS`, so a reason this cut is always cut again by the assembler, and
 *     that cut is announced on the block's marker (`truncated="true"`), never as a line a
 *     commenter could have typed. The marker's `original_chars` is then the stored length, not the
 *     comments' — a residual stated here rather than implied.
 *
 * The first line is platform text — the count, in the words the reason has always had — so a
 * reader of the row who knew the old shape still finds it.
 */
import type { TaskReviewThreads } from '@platform/contracts';
import { MAX_FEEDBACK_CHARS } from '@platform/domain';
import type { SecretRedactor } from '../ports/integrations/audit.js';
import type { Discussion } from '../ports/integrations/git-provider.js';
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
 * The markers the platform writes into a note it posts on a merge request — the conflict warning's
 * `<!-- agentic:conflict-warning:<task> -->`, review-only's finding and summary markers — as one
 * shape, `<!-- agentic:<kind>:<id> -->`, **anchored to the start of the body**: every note the
 * platform posts opens with its marker (`conflictWarningBody`, `renderFinding`, the summary), and a
 * human quote-reply that copies one (`> <!-- agentic:… -->`) does not open with it, so it stays a
 * human's note (WP-73 review round 1).
 */
const PLATFORM_NOTE_MARKER = /^\s*<!-- agentic:[a-z][a-z0-9-]*:[^\s>]+ -->/;

/**
 * Whether a note is the **platform's own** (WP-73, PROGRESS backlog 214): it carries a platform
 * marker.
 *
 * **By marker, not by author**, and the reason is a fact about the port rather than a preference:
 * the backlog asked for the binding's own account first, and `GitProviderPort` publishes no
 * *"which account am I"* — a note's `author` is an `ExternalIdentity` nothing compares with the
 * binding's token. The marker is **forgeable**, stated rather than implied: a human who opens a
 * note with one hides that note from the count and from the Developer, and that is the fail-**open**
 * direction — one open thread fewer means the review window does **not** send the task back — so a
 * forged marker can let a `ready_for_merge` task stay Ready with a comment nobody acted on. What
 * bounds it: the forger has to be somebody who can comment on the merge request, the thread is
 * still on the provider for whoever merges, and a person who wants a thread ignored can already
 * resolve it. The author check that would close it needs a port member (PROGRESS backlog 266).
 */
export const isPlatformNote = (note: { readonly body: string }): boolean =>
  PLATFORM_NOTE_MARKER.test(note.body);

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

export interface ReviewThreadsReason {
  readonly reason: string;
  /** How many secrets the redactor replaced — logged by the caller; the reason has no column. */
  readonly redactions: number;
}

/**
 * The return reason for a human-comment return: the count, then every human note of every open
 * thread, one line each, redacted and bounded. See the module docblock for the order and why.
 */
export const reviewThreadsReturnReason = (
  open: readonly Discussion[],
  redactor: SecretRedactor,
): ReviewThreadsReason => {
  let redactions = 0;
  const clean = (text: string): string => {
    const redacted = redactor.redactText(text);
    redactions += redacted.count;
    return collapseLines(redacted.value);
  };
  const lines = [`${open.length} unresolved review thread${open.length === 1 ? '' : 's'}`];
  open.forEach((discussion, index) => {
    const notes = discussion.notes.filter(isHumanNote);
    notes.forEach((note, position) => {
      const tag = position === 0 ? `[thread ${index + 1}]` : `[reply ${index + 1}]`;
      const where =
        typeof note.path === 'string'
          ? ` ${clean(note.path)}${typeof note.line === 'number' ? `:${String(note.line)}` : ''}`
          : '';
      lines.push(`${tag}${where} — ${clean(note.body)}`);
    });
  });
  const reason = lines.join('\n');
  return {
    reason:
      reason.length > MAX_REVIEW_FEEDBACK_CHARS
        ? reason.slice(0, MAX_REVIEW_FEEDBACK_CHARS)
        : reason,
    redactions,
  };
};

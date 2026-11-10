/**
 * The human-return decision — TD-029 decisions 6, 7 and 9 as one pure function (BD-031, WP-174
 * ruling (e), technical/02's M10-head amendment, product/04 S6c and S7), **as amended by M28 ruling
 * R1** (S-28.2, which replaces TD-029 decision 8's acknowledgement rule).
 *
 * The human-return window (WP-178) fires and re-reads three things: the ticket's status, the merge
 * request's discussions and the ticket's comments. It hands them here with the task's current
 * stage, the binding's lifecycle slots, the horizon, the **handled ledger** (M28 ruling R2) and the
 * instant a forward status move was first seen, and gets one of three answers:
 *
 *  - **`return {forms}`** — a person's explicit signal returns the task to Implementation. The
 *    interpreter signal is `mr.review.comment` for every form (decision 7); the forms are what
 *    `task.human_return` records, with the counts and the status that event's invariants ask for.
 *  - **`pass`** — only at `qa`: the ticket left the `qa` status for a status that is not a return
 *    status (decision 9). The interpreter signal is `ticket.status.changed`.
 *  - **`none`** — nothing to do.
 *
 * Every answer carries `seen`: the person's words this firing read that did **not** return the
 * task and are not handled yet — what the window records in the ledger as *seen, not a change
 * request*, so the task page can say so and offer the person the button (M28 ruling R1).
 *
 * The rules, in the order they are applied:
 *
 *  1. **Only a human stage returns** (`qa`, `ready_for_merge`). At an agent stage nothing returns;
 *     the words reach the next run through the conversation block instead (decision 7).
 *  2. **Whose word is it** (decision 6): never by author. A provider system note belongs to nobody.
 *     A note on the merge request is the platform's when it **opens** with a platform marker
 *     (`<!-- agentic:<kind>:<id> -->`, {@link isPlatformMergeRequestNote}); a ticket comment is the
 *     platform's when the provider reports a `marker_id` or its body **opens with** one of
 *     `PLATFORM_COMMENT_MARKERS`. Every other word is a person's.
 *  3. **Only words newer than the horizon count** — the start of the task's latest `implementation`
 *     run (decision 7). A word whose timestamp cannot be read counts.
 *  4. **A handled word does not count** (M28 ruling R2): a word in a thread or comment the ledger
 *     records as answered, resolved or seen — up to the note the ledger names (`lastNoteId`), or,
 *     when it names none the window can find, written no later than the row — is old business. A
 *     person's **newer** note in the same thread counts again.
 *  5. **Only an explicit signal returns** (M28 ruling R1, language-independent): a person's note in
 *     an **unresolved, resolvable** merge-request discussion (`resolvable: true` on the word — a
 *     review thread is a change request by the provider's own semantics), or the **status** form.
 *     A ticket comment and a non-resolvable merge-request note never return the task, whatever they
 *     say — until M28 any of them that was not a short English acknowledgement did (TD-029 decision
 *     8), which sent AUT-6655 back to Implementation twice on a long Czech *QA: OK*.
 *  6. **The status returns** when it is one of `returned`, or the `in_progress` or `pick_up_from`
 *     status, compared by {@link lifecycleStatusKey} — **and differs from the status the ticket had
 *     at the human stage's entry** (`entryStatus`, TD-029 decision 7's WP-178 review amendment (a)).
 *  7. **Forward wins over return** (M28 ruling R1): when the ticket's status moved **forward** since
 *     the stage was entered — it differs from the entry status and is a lifecycle slot ahead of the
 *     stage, `approved`/`done` at Ready and `done` at QA ({@link isForwardMove}) — no word written no later than the instant the window first saw that
 *     move (`forwardSeenAt`) returns the task. A note written after it still does. (Until M28 the
 *     opposite held: return won over pass.)
 *  8. Any form returns → `return`. Otherwise, at `qa`, a status that is mapped, readable, not the
 *     `qa` status and not a return status → `pass` — **and only when the ticket has been seen
 *     leaving the `qa` status**: a recorded change out of it (`leftQa`, WP-178 criterion (14)), or
 *     an entry status at the `qa` slot or a sighting of it since (`entryStatus`/`seenAtQa`,
 *     amendment (b)). Otherwise `none`.
 */
import {
  humanReturnFormSchema,
  humanReturnStageSchema,
  lifecycleStatusKey,
  type Slug,
  type TicketLifecycle,
} from '@platform/contracts';
import { opensWithAskTrigger, opensWithPlatformCommentMarker } from '../ask/ask.js';
import { QA_STAGE_ID } from '../pipeline/templates.js';

/** The forms a person's word at a human stage takes (`task.human_return`'s `forms`). */
export type HumanReturnForm = (typeof humanReturnFormSchema.options)[number];

/** The human stages a person's word returns a task from. */
export type HumanReturnStage = (typeof humanReturnStageSchema.options)[number];

/** The forms a word arrives in: everything but `status`, which is the ticket's field. */
export type HumanWordForm = Exclude<HumanReturnForm, 'status'>;

/**
 * Where a handled item lives — `task_conversation_handled.source` (M28 ruling R2): a resolvable
 * merge-request discussion, a merge-request discussion that cannot be resolved (a general note),
 * or a ticket comment.
 */
export type ConversationHandledSource = 'mr_thread' | 'mr_note' | 'ticket_comment';

/** One note or comment, as the window read it. Every field but `form` is provider data. */
export interface HumanWord {
  readonly form: HumanWordForm;
  /** The body, verbatim. Untrusted (BD-022). */
  readonly text: string;
  /** When the provider says it was written (ISO 8601). */
  readonly at: string;
  /** A provider system note ("changed the description"): nobody's word. */
  readonly system?: boolean;
  /** A ticket comment's platform marker, when the provider reports one (`CommentRef.marker_id`). */
  readonly markerId?: string | null;
  /**
   * A merge-request word only: its discussion can be resolved and is not (M28 ruling R1 (b)). The
   * one shape of note that returns a task. Absent is `false`.
   */
  readonly resolvable?: boolean;
  /** The discussion's id, or the ticket comment's own id — what the ledger keys on. */
  readonly threadId?: string | null;
  /** The note's id (a ticket comment's is its own id) — what the ledger's `lastNoteId` names. */
  readonly noteId?: string | null;
}

/** One ledger row, as the decision reads it (M28 ruling R2, `task_conversation_handled`). */
export interface HandledThread {
  readonly source: ConversationHandledSource;
  readonly threadId: string;
  /** The newest note the platform had handled in that thread, or `null` when it named none. */
  readonly lastNoteId: string | null;
  /** When the platform handled it (ISO 8601). */
  readonly handledAt: string;
}

/** The binding's slots, with `pick_up_from` — the binding's `pickup_status` — beside them. */
export interface HumanReturnSlots {
  readonly lifecycle: TicketLifecycle;
  readonly pickUpFrom: string | null;
}

export interface HumanReturnInput<TWord extends HumanWord = HumanWord> {
  /** The task's current stage. */
  readonly stage: Slug;
  readonly slots: HumanReturnSlots;
  /** The ticket's status now, or `null` when it could not be read. Provider text. */
  readonly status: string | null;
  /** Merge-request words in the provider's order within each discussion, then ticket comments. */
  readonly words: readonly TWord[];
  /** The start of the task's latest `implementation` run (ISO 8601), or `null` when there is none. */
  readonly horizon: string | null;
  /** The task's handled ledger (M28 ruling R2); `[]` when nothing was handled. */
  readonly handled: readonly HandledThread[];
  /**
   * When the window first saw the ticket's current **forward** move during this entry (rule 7),
   * or `null` when it recorded none. Read only while {@link isForwardMove} holds; `null` then
   * means *this firing*, so every word it read is no later than the move.
   */
  readonly forwardSeenAt: string | null;
  /**
   * Where the ticket went when it was last seen **leaving the `qa` status** — the `to` of the newest
   * `ticket.status.changed` recorded for the task after its latest entry into `qa` whose `from` is
   * the `qa` slot — or `null` when no such change was recorded (WP-178 criterion (14)). Provider
   * text. `null` alone never passes; the entry record (`entryStatus`, `seenAtQa`) is the other way
   * through (amendment (b)).
   */
  readonly leftQa: string | null;
  /**
   * The ticket's status **at the human stage's entry** — the first status the window recorded after
   * the task entered `qa` or `ready_for_merge` (TD-029 decision 7's WP-178 review amendment (a)) —
   * or `null` when none was recorded. Provider text. The status form returns the task only when the
   * current status is a return status **and differs from this one**. `null` returns nothing by
   * status, and moves nothing forward.
   */
  readonly entryStatus: string | null;
  /**
   * Whether the ticket was seen at the `qa` status during this entry into `qa` (amendment (b)): at a
   * firing of the window, or as the `from`/`to` of a recorded change. With an entry status at the
   * `qa` slot, it is what lets a binding that records no `from` (one that only polls) pass QA.
   */
  readonly seenAtQa: boolean;
}

export type HumanReturnDecision<TWord extends HumanWord = HumanWord> =
  | {
      readonly kind: 'return';
      readonly from: HumanReturnStage;
      /** Each contributing form once, in `humanReturnFormSchema`'s order. */
      readonly forms: readonly HumanReturnForm[];
      /** The contributing words of each form; above zero exactly when the form is listed. */
      readonly counts: Readonly<Record<HumanWordForm, number>>;
      /** The ticket's status when the status returned the task, else `null`. */
      readonly status: string | null;
      /** Always empty: a return quotes every word in its feedback, and the horizon moves on. */
      readonly seen: readonly TWord[];
    }
  | { readonly kind: 'pass'; readonly status: string; readonly seen: readonly TWord[] }
  | { readonly kind: 'none'; readonly seen: readonly TWord[] };

/**
 * The markers the platform writes into a note it posts on a merge request — the conflict warning's
 * `<!-- agentic:conflict-warning:<task> -->`, review-only's finding and summary markers, the review
 * findings and replies — as one shape, `<!-- agentic:<kind>:<id> -->`, **anchored to the start of
 * the body**: every note the platform posts opens with its marker, and a person's quote-reply that
 * copies one (`> <!-- agentic:… -->`) does not open with it, so it stays a person's note (WP-73
 * review round 1).
 *
 * **The one copy** (WP-178 criterion (13)): the application's `isPlatformNote` delegates to
 * {@link isPlatformMergeRequestNote}, so the review window, the comment handler, the poll's person
 * filter and the thread refresh cannot disagree about whose note it is.
 */
const MR_PLATFORM_MARKER = /^\s*<!-- agentic:[a-z][a-z0-9-]*:[^\s>]+ -->/;

/** Whether a merge-request note's body opens with a platform marker (TD-029 decision 6). */
export const isPlatformMergeRequestNote = (body: string): boolean => MR_PLATFORM_MARKER.test(body);

/** Whether a word is the platform's own (decision 6) — by marker, never by author. */
export const isPlatformWord = (word: HumanWord): boolean =>
  word.form === 'ticket_comment'
    ? (word.markerId ?? null) !== null || opensWithPlatformCommentMarker(word.text)
    : isPlatformMergeRequestNote(word.text);

const isNewerThan = (at: string, horizon: string | null): boolean => {
  if (horizon === null) return true;
  const written = Date.parse(at);
  const since = Date.parse(horizon);
  return Number.isNaN(written) || Number.isNaN(since) || written > since;
};

/**
 * Every person's word newer than the horizon: rules 2 and 3 — what the window's feedback quotes
 * (decision 7: *"every person's word newer than the horizon"*). Generic, so a caller's own fields
 * on a word survive the filter.
 */
export const personsWordsSince = <TWord extends HumanWord>(
  words: readonly TWord[],
  horizon: string | null,
): readonly TWord[] =>
  words.filter(
    (word) => word.system !== true && !isPlatformWord(word) && isNewerThan(word.at, horizon),
  );

/** The ledger source a word belongs to (M28 ruling R2). */
export const handledSourceOf = (word: HumanWord): ConversationHandledSource =>
  word.form === 'ticket_comment'
    ? 'ticket_comment'
    : word.resolvable === true
      ? 'mr_thread'
      : 'mr_note';

const threadKey = (source: ConversationHandledSource, threadId: string): string =>
  `${source}\u0000${threadId}`;

/**
 * The words the ledger already handled (rule 4): per handled thread, every word up to and including
 * the note the row names — by the words' own order, which is the provider's within a discussion —
 * or, when the row names no note the window read, every word written no later than the row. A
 * word with no thread id is never handled.
 */
export const handledWords = <TWord extends HumanWord>(
  words: readonly TWord[],
  handled: readonly HandledThread[],
): ReadonlySet<TWord> => {
  const rows = new Map<string, HandledThread[]>();
  for (const row of handled) {
    const key = threadKey(row.source, row.threadId);
    rows.set(key, [...(rows.get(key) ?? []), row]);
  }
  const out = new Set<TWord>();
  const byThread = new Map<string, TWord[]>();
  for (const word of words) {
    if (typeof word.threadId !== 'string') continue;
    const key = threadKey(handledSourceOf(word), word.threadId);
    if (!rows.has(key)) continue;
    byThread.set(key, [...(byThread.get(key) ?? []), word]);
  }
  for (const [key, thread] of byThread) {
    for (const row of rows.get(key) ?? []) {
      const upTo =
        row.lastNoteId === null ? -1 : thread.findIndex((word) => word.noteId === row.lastNoteId);
      thread.forEach((word, index) => {
        const covered = upTo >= 0 ? index <= upTo : !isNewerThan(word.at, row.handledAt);
        if (covered) out.add(word);
      });
    }
  }
  return out;
};

/** The statuses that return a task (rule 6), as comparison keys. */
const returnStatusKeys = (slots: HumanReturnSlots): ReadonlySet<string> =>
  new Set(
    [...(slots.lifecycle.returned ?? []), slots.lifecycle.in_progress, slots.pickUpFrom]
      .filter((name): name is string => typeof name === 'string')
      .map(lifecycleStatusKey),
  );

/**
 * The lifecycle slots that are **ahead** of a human stage (review of #139, the coordinator's ruling
 * on "forward"): at `ready_for_merge` the `approved` and `done` slots, at `qa` the `done` slot. The
 * slots the platform writes itself on the way in — `in_review`, `approved` before `qa`, and `qa`
 * at `qa` — are never ahead, so the platform's own status write landing late is never read as a
 * person's forward move.
 */
const forwardSlotKeys = (stage: Slug, slots: HumanReturnSlots): ReadonlySet<string> =>
  new Set(
    (stage === QA_STAGE_ID
      ? [slots.lifecycle.done]
      : [slots.lifecycle.approved, slots.lifecycle.done]
    )
      .filter((name): name is string => typeof name === 'string')
      .map(lifecycleStatusKey),
  );

/**
 * Rule 7: the ticket's status moved **forward** since the human stage began — readable, different
 * from the entry status, and one of the lifecycle's slots ahead of the current stage
 * ({@link forwardSlotKeys}). An **unmapped** status (*Reopened*) is not forward: an open review
 * thread beside it still returns the task. An unknown entry moves nothing.
 */
export const isForwardMove = (input: {
  readonly stage: Slug;
  readonly slots: HumanReturnSlots;
  readonly status: string | null;
  readonly entryStatus: string | null;
}): boolean =>
  input.status !== null &&
  input.entryStatus !== null &&
  lifecycleStatusKey(input.status) !== lifecycleStatusKey(input.entryStatus) &&
  forwardSlotKeys(input.stage, input.slots).has(lifecycleStatusKey(input.status));

/**
 * The words that return the task (rules 4, 5 and 7, over the candidates of rules 2 and 3): in an
 * unresolved resolvable merge-request discussion, and — while the status has moved forward —
 * written after the window first saw that move. A ticket comment never returns a task (rule 5); an
 * `@agentic ask` comment (amendment (c), Q119) is one, so it never did either. A word whose instant
 * cannot be read is not after the move: forward wins (rule 7).
 */
const returningWords = <TWord extends HumanWord>(
  candidates: readonly TWord[],
  input: HumanReturnInput<TWord>,
): readonly TWord[] => {
  const forward = isForwardMove(input);
  const since = input.forwardSeenAt === null ? Number.NaN : Date.parse(input.forwardSeenAt);
  return candidates.filter(
    (word) =>
      word.form !== 'ticket_comment' &&
      word.resolvable === true &&
      (!forward || Date.parse(word.at) > since),
  );
};

const isPass = (input: HumanReturnInput<HumanWord>, returnsByStatus: boolean): boolean => {
  const qa = input.slots.lifecycle.qa;
  if (
    input.stage !== QA_STAGE_ID ||
    returnsByStatus ||
    qa === undefined ||
    input.status === null ||
    lifecycleStatusKey(input.status) === lifecycleStatusKey(qa) ||
    returnStatusKeys(input.slots).has(lifecycleStatusKey(input.status))
  ) {
    return false;
  }
  // Criterion (14): the ticket was seen leaving `qa`, for a status that is not a return status.
  const leftQa =
    input.leftQa !== null &&
    lifecycleStatusKey(input.leftQa) !== lifecycleStatusKey(qa) &&
    !returnStatusKeys(input.slots).has(lifecycleStatusKey(input.leftQa));
  // Amendment (b): the ticket was at `qa` when the stage began, or was seen there since — and is
  // neither there nor at a return status now. A binding that records no `from` passes this way.
  const wasAtQa =
    input.seenAtQa ||
    (input.entryStatus !== null &&
      lifecycleStatusKey(input.entryStatus) === lifecycleStatusKey(qa));
  return leftQa || wasAtQa;
};

/**
 * The status form (amendment (a)): the current status is a return status **and is not the status
 * the ticket had when the human stage began** — a change, never a state.
 */
const returnsByStatusOf = (input: HumanReturnInput<HumanWord>): boolean =>
  input.status !== null &&
  input.entryStatus !== null &&
  returnStatusKeys(input.slots).has(lifecycleStatusKey(input.status)) &&
  lifecycleStatusKey(input.status) !== lifecycleStatusKey(input.entryStatus);

/** TD-029's human-return decision, as M28 ruling R1 amends it. Pure and total. */
export const humanReturnDecision = <TWord extends HumanWord>(
  input: HumanReturnInput<TWord>,
): HumanReturnDecision<TWord> => {
  const stage = humanReturnStageSchema.safeParse(input.stage);
  if (!stage.success) {
    return { kind: 'none', seen: [] };
  }
  const handled = handledWords(input.words, input.handled);
  const candidates = personsWordsSince(input.words, input.horizon).filter(
    (word) => !handled.has(word),
  );
  const words = returningWords(candidates, input);
  const counts: Record<HumanWordForm, number> = { mr_diff: 0, mr_note: 0, ticket_comment: 0 };
  for (const word of words) {
    counts[word.form] += 1;
  }
  const returnsByStatus = returnsByStatusOf(input);
  const forms = humanReturnFormSchema.options.filter((form) =>
    form === 'status' ? returnsByStatus : counts[form] > 0,
  );
  if (forms.length > 0) {
    return {
      kind: 'return',
      from: stage.data,
      forms,
      counts,
      status: returnsByStatus ? input.status : null,
      seen: [],
    };
  }
  // Every candidate is a word that did not return the task: seen, not a change request — except an
  // `@agentic ask`, which ask-the-task answers (amendment (c), Q119): it was a question, and the
  // task page has nothing to say about it.
  const seen = candidates.filter(
    (word) => !(word.form === 'ticket_comment' && opensWithAskTrigger(word.text)),
  );
  return isPass(input, returnsByStatus) && input.status !== null
    ? { kind: 'pass', status: input.status, seen }
    : { kind: 'none', seen };
};

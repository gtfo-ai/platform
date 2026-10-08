/**
 * The human-return decision — TD-029 decisions 6, 7 and 9 as one pure function (BD-031, WP-174
 * ruling (e), technical/02's M10-head amendment, product/04 S6c and S7).
 *
 * The human-return window (WP-178) fires and re-reads three things: the ticket's status, the merge
 * request's discussions and the ticket's comments. It hands them here with the task's current
 * stage, the binding's lifecycle slots, the horizon and the project's added acknowledgement words,
 * and gets one of three answers:
 *
 *  - **`return {forms}`** — a person's word returns the task to Implementation. The interpreter
 *    signal is `mr.review.comment` for every form (decision 7); the forms are what
 *    `task.human_return` records, with the counts and the status that event's invariants ask for.
 *  - **`pass`** — only at `qa`: the ticket left the `qa` status for a status that is not a return
 *    status, and no person's word asks for anything (decision 9). The interpreter signal is
 *    `ticket.status.changed`.
 *  - **`none`** — nothing to do.
 *
 * The rules, in the order they are applied:
 *
 *  1. **Only a human stage returns** (`qa`, `ready_for_merge`). At an agent stage nothing returns;
 *     the words reach the next run through the conversation block instead (decision 7). A status
 *     signal at an agent stage — including the echo of the platform's own `in_progress` — is
 *     therefore `none` here.
 *  2. **Whose word is it** (decision 6): never by author. A provider system note belongs to nobody.
 *     A note on the merge request is the platform's when it **opens** with a platform marker
 *     (`<!-- agentic:<kind>:<id> -->`, {@link isPlatformMergeRequestNote}, which the application's
 *     `isPlatformNote` delegates to since WP-178); a ticket comment is the platform's when the
 *     provider reports a `marker_id` or its body **opens with** one of `PLATFORM_COMMENT_MARKERS`
 *     (`opensWithPlatformCommentMarker`, the ask classifier's rule since WP-178 — until then both
 *     asked *anywhere in the body*, which silenced a person who quoted a platform comment). Every
 *     other word is a person's.
 *  3. **Only words newer than the horizon count** — the start of the task's latest `implementation`
 *     run (decision 7). A word whose timestamp cannot be read counts: the failure direction is the
 *     one decision 8 chose, an extra run rather than a lost request.
 *  4. **An acknowledgement does not count** ({@link isAcknowledgement}, decision 8).
 *  5. **The status returns** when it is one of `returned`, or the `in_progress` or `pick_up_from`
 *     status, compared by {@link lifecycleStatusKey} — **and differs from the status the ticket had
 *     at the human stage's entry** (`entryStatus`, TD-029 decision 7's WP-178 review amendment (a)):
 *     every slot is optional, so a project that maps `in_progress` but not `approved` reaches a
 *     human stage with the ticket still at a status this rule counts, and before the amendment every
 *     firing — an acknowledgement included — returned it until `human_rounds` was spent. A ticket
 *     comment that is an `@agentic ask` is not a word that returns the task (amendment (c), Q119).
 *  6. Any form returns → `return`. Otherwise, at `qa`, a status that is mapped, readable, not the
 *     `qa` status and not a return status → `pass` — **and only when the ticket has been seen
 *     leaving the `qa` status**: a recorded change out of it (`leftQa`, WP-178 criterion (14)), or an
 *     entry status at the `qa` slot or a sighting of it since (`entryStatus`/`seenAtQa`, amendment
 *     (b), which is how a binding that only polls passes): TD-029 decision 9's pass is the
 *     ticket *leaving* `qa`, and a task can enter `qa` with its ticket still at the `approved` or
 *     `in_review` status (a `qa` lifecycle write that failed, decision 4), where the current status
 *     alone would read as a pass that no person made. Otherwise `none`.
 *
 * Return wins over pass: a ticket moved on while somebody also wrote "rename X" is returned, which
 * is the recoverable direction.
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
import { isAcknowledgement } from './acknowledgement.js';

/** The forms a person's word at a human stage takes (`task.human_return`'s `forms`). */
export type HumanReturnForm = (typeof humanReturnFormSchema.options)[number];

/** The human stages a person's word returns a task from. */
export type HumanReturnStage = (typeof humanReturnStageSchema.options)[number];

/** The forms a word arrives in: everything but `status`, which is the ticket's field. */
export type HumanWordForm = Exclude<HumanReturnForm, 'status'>;

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
}

/** The binding's slots, with `pick_up_from` — the binding's `pickup_status` — beside them. */
export interface HumanReturnSlots {
  readonly lifecycle: TicketLifecycle;
  readonly pickUpFrom: string | null;
}

export interface HumanReturnInput {
  /** The task's current stage. */
  readonly stage: Slug;
  readonly slots: HumanReturnSlots;
  /** The ticket's status now, or `null` when it could not be read. Provider text. */
  readonly status: string | null;
  readonly words: readonly HumanWord[];
  /** The start of the task's latest `implementation` run (ISO 8601), or `null` when there is none. */
  readonly horizon: string | null;
  /** The project's `human_returns.acknowledgements`; `[]` when none is configured. */
  readonly extraAcks: readonly string[];
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
   * current status is a return status **and differs from this one**: a ticket left where it was when
   * the stage began never returns the task by its status. `null` returns nothing by status.
   */
  readonly entryStatus: string | null;
  /**
   * Whether the ticket was seen at the `qa` status during this entry into `qa` (amendment (b)): at a
   * firing of the window, or as the `from`/`to` of a recorded change. With an entry status at the
   * `qa` slot, it is what lets a binding that records no `from` (one that only polls) pass QA.
   */
  readonly seenAtQa: boolean;
}

export type HumanReturnDecision =
  | {
      readonly kind: 'return';
      readonly from: HumanReturnStage;
      /** Each contributing form once, in `humanReturnFormSchema`'s order. */
      readonly forms: readonly HumanReturnForm[];
      /** The contributing words of each form; above zero exactly when the form is listed. */
      readonly counts: Readonly<Record<HumanWordForm, number>>;
      /** The ticket's status when the status returned the task, else `null`. */
      readonly status: string | null;
    }
  | { readonly kind: 'pass'; readonly status: string }
  | { readonly kind: 'none' };

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
 * Every person's word newer than the horizon: rules 2 and 3, acknowledgements included — what the
 * window's feedback quotes (decision 7: *"every person's word newer than the horizon"*). Generic, so
 * a caller's own fields on a word survive the filter.
 */
export const personsWordsSince = <TWord extends HumanWord>(
  words: readonly TWord[],
  horizon: string | null,
): readonly TWord[] =>
  words.filter(
    (word) => word.system !== true && !isPlatformWord(word) && isNewerThan(word.at, horizon),
  );

/**
 * The person's words that ask for something: rules 2–4 — and, since WP-178's review (TD-029
 * decision 7's amendment (c), Q119), not a ticket comment that is an `@agentic ask`: ask-the-task
 * answers it, and a question about the work is not a request to change it.
 */
export const contributingWords = <TWord extends HumanWord>(
  words: readonly TWord[],
  horizon: string | null,
  extraAcks: readonly string[],
): readonly TWord[] =>
  personsWordsSince(words, horizon).filter(
    (word) =>
      !isAcknowledgement(word.text, extraAcks) &&
      !(word.form === 'ticket_comment' && opensWithAskTrigger(word.text)),
  );

/** The statuses that return a task (rule 5), as comparison keys. */
const returnStatusKeys = (slots: HumanReturnSlots): ReadonlySet<string> =>
  new Set(
    [...(slots.lifecycle.returned ?? []), slots.lifecycle.in_progress, slots.pickUpFrom]
      .filter((name): name is string => typeof name === 'string')
      .map(lifecycleStatusKey),
  );

const isPass = (input: HumanReturnInput, returnsByStatus: boolean): boolean => {
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
const returnsByStatusOf = (input: HumanReturnInput): boolean =>
  input.status !== null &&
  input.entryStatus !== null &&
  returnStatusKeys(input.slots).has(lifecycleStatusKey(input.status)) &&
  lifecycleStatusKey(input.status) !== lifecycleStatusKey(input.entryStatus);

/** TD-029's human-return decision. Pure and total. */
export const humanReturnDecision = (input: HumanReturnInput): HumanReturnDecision => {
  const stage = humanReturnStageSchema.safeParse(input.stage);
  if (!stage.success) {
    return { kind: 'none' };
  }
  const words = contributingWords(input.words, input.horizon, input.extraAcks);
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
    };
  }
  return isPass(input, returnsByStatus) && input.status !== null
    ? { kind: 'pass', status: input.status }
    : { kind: 'none' };
};

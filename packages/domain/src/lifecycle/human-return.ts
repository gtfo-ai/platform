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
 *     (`<!-- agentic:<kind>:<id> -->`, the shape `isPlatformNote` reads); a ticket comment is the
 *     platform's when the provider reports a `marker_id` or its body carries one of
 *     {@link PLATFORM_COMMENT_MARKERS} (the ask classifier's rule). Every other word is a person's.
 *  3. **Only words newer than the horizon count** — the start of the task's latest `implementation`
 *     run (decision 7). A word whose timestamp cannot be read counts: the failure direction is the
 *     one decision 8 chose, an extra run rather than a lost request.
 *  4. **An acknowledgement does not count** ({@link isAcknowledgement}, decision 8).
 *  5. **The status returns** when it is one of `returned`, or the `in_progress` or `pick_up_from`
 *     status, compared by {@link lifecycleStatusKey}.
 *  6. Any form returns → `return`. Otherwise, at `qa`, a status that is mapped, readable, not the
 *     `qa` status and not a return status → `pass`. Otherwise `none`.
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
import { PLATFORM_COMMENT_MARKERS } from '../ask/ask.js';
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

/** The merge-request marker shape `isPlatformNote` reads, anchored to the start of the body. */
const MR_PLATFORM_MARKER = /^\s*<!-- agentic:[a-z][a-z0-9-]*:[^\s>]+ -->/;

/** Whether a word is the platform's own (decision 6) — by marker, never by author. */
export const isPlatformWord = (word: HumanWord): boolean =>
  word.form === 'ticket_comment'
    ? (word.markerId ?? null) !== null ||
      PLATFORM_COMMENT_MARKERS.some((marker) => word.text.includes(marker))
    : MR_PLATFORM_MARKER.test(word.text);

const isNewerThan = (at: string, horizon: string | null): boolean => {
  if (horizon === null) return true;
  const written = Date.parse(at);
  const since = Date.parse(horizon);
  return Number.isNaN(written) || Number.isNaN(since) || written > since;
};

/** The person's words that ask for something: rules 2–4. */
export const contributingWords = (
  words: readonly HumanWord[],
  horizon: string | null,
  extraAcks: readonly string[],
): readonly HumanWord[] =>
  words.filter(
    (word) =>
      word.system !== true &&
      !isPlatformWord(word) &&
      isNewerThan(word.at, horizon) &&
      !isAcknowledgement(word.text, extraAcks),
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
  return (
    input.stage === QA_STAGE_ID &&
    !returnsByStatus &&
    qa !== undefined &&
    input.status !== null &&
    lifecycleStatusKey(input.status) !== lifecycleStatusKey(qa)
  );
};

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
  const returnsByStatus =
    input.status !== null && returnStatusKeys(input.slots).has(lifecycleStatusKey(input.status));
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

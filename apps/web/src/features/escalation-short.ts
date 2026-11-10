/**
 * **Why a stopped task waits, in a row's words** (S-25.15 part B; product/10's Task detail
 * amendment of 2026-11-07, S-25.14's last bullet): the short form a board card, Home's *Needs you*
 * row and the Inbox's *Stopped* row say for a task that waits for a person (`needs_human`), from
 * the escalation's reason **key** — the list item's `escalation_reason`, the Inbox row's `reason` —
 * and never from its brief, which only the task page shows (under *Details*).
 *
 * - **A ticket someone else holds** (`ticket_assigned_elsewhere`): "Waiting for: Vojtěch Kaizr’s
 *   Jira ticket", the name from `tracker_assignee` (`unlinked_assignee` when it has none) through
 *   `./ticket-held-words.ts`' `ticketHolder`, the callout's own reading; with no name, "Waiting
 *   for: a Jira ticket someone else holds". The tracker's word is `ui/words/trackers.ts`'; a
 *   tracker this build does not name is left out ("Vojtěch Kaizr’s ticket") rather than said as
 *   *the tracker*.
 * - **Another key the platform words**: {@link ESCALATION_SHORT_WORDS}, the stage timeline's
 *   *Needs you: …* sentences (`./stage-outcome.ts`) shortened for a row. Exactly those keys: a key
 *   nobody words there is not given words here (`escalation-short.test.ts` holds the two lists
 *   equal).
 * - **Anything else** — a reason that is a sentence (most of the interpreter's are), a key nobody
 *   words, or none at all: "Needs a person", with the stage when the row does not already say it.
 *
 * Every name is somebody's own text: a part is platform text (a `string`) or `{ untrusted }`,
 * rendered by `WaitingWords` through `UntrustedText` (BD-022). Home is on the first paint, so the
 * words live here, beside the rows that use them, rather than in `ui/humanize.ts`. They never say
 * *claim*, *offer* or *seat*.
 */
import type { TaskRecord, TaskStageOutcomeWord } from '@platform/contracts';
import { stageLabel } from '../ui/words/stages.js';
import { knownTrackerName } from '../ui/words/trackers.js';
import { TICKET_ASSIGNED_ELSEWHERE, ticketHolder } from './ticket-held-words.js';
import type { WaitingPart } from './waiting-words.js';

/**
 * The stage timeline's *Needs you: …* sentences, shortened for a row — one per key
 * `stageOutcomeWordSentence` words that way, except `ticket_assigned_elsewhere`, which names whose
 * ticket it is ({@link escalationShort}).
 */
export const ESCALATION_SHORT_WORDS: Readonly<Partial<Record<TaskStageOutcomeWord, string>>> = {
  undecided: 'The check couldn’t decide',
  unsupported: 'A check the connections can’t answer',
  converged: 'The same failure repeated',
  'question.expired': 'A question expired unanswered',
  'approval.expired': 'An approval expired undecided',
  'budget.rejected': 'The budget approval was rejected',
  'take_over.expired': 'No activity from the person working on it',
  write_conflict: 'A write lost to another writer',
  dead_lettered: 'An event about it couldn’t be processed',
  repository_config_invalid: 'The repository’s settings file doesn’t parse',
  ticket_claim_failed: 'The platform couldn’t take the ticket',
  ticket_not_startable: 'The ticket moved to a status work doesn’t start from',
  ticket_closed_in_tracker: 'The ticket was finished in the tracker',
  settings_config_invalid: 'The project’s stored settings don’t parse',
  context_budget_above_ceiling: 'The context budget is above this release’s ceiling',
};

/** The generic short form, for a reason the platform has no words for. */
export const NEEDS_A_PERSON = 'Needs a person';

/** What a row's short form reads: the stop, and how it was worded (the tests' handle). */
export interface EscalationShort {
  /** `held_elsewhere` / `held_nameless`: a ticket someone else holds; `worded`: a key above. */
  readonly kind: 'held_elsewhere' | 'held_nameless' | 'worded' | 'generic';
  readonly parts: readonly WaitingPart[];
}

/** What the short form reads off a list item or an Inbox row. */
export interface EscalationSubject {
  /** The escalation's reason (`escalation_reason` / `reason`): a key, a sentence, or none. */
  readonly reason: string | null;
  readonly ticket: { readonly provider: string };
  readonly current_stage?: string | null;
  readonly tracker_assignee: TaskRecord['tracker_assignee'];
  readonly unlinked_assignee: TaskRecord['unlinked_assignee'];
}

export const escalationShort = (
  subject: EscalationSubject,
  /** Whether the generic form names the stage: a row whose meta line says it already does not. */
  options: { readonly stage: boolean },
): EscalationShort => {
  const { reason } = subject;
  if (reason === TICKET_ASSIGNED_ELSEWHERE) {
    const holder = ticketHolder(subject);
    const tracker = knownTrackerName(subject.ticket.provider);
    return holder.name === null
      ? {
          kind: 'held_nameless',
          parts: [
            tracker === null
              ? 'Waiting for: a ticket someone else holds'
              : `Waiting for: a ${tracker} ticket someone else holds`,
          ],
        }
      : {
          kind: 'held_elsewhere',
          parts: [
            'Waiting for: ',
            { untrusted: holder.name },
            tracker === null ? '’s ticket' : `’s ${tracker} ticket`,
          ],
        };
  }
  const worded =
    reason !== null && Object.hasOwn(ESCALATION_SHORT_WORDS, reason)
      ? ESCALATION_SHORT_WORDS[reason as TaskStageOutcomeWord]
      : undefined;
  if (worded !== undefined) {
    return { kind: 'worded', parts: [worded] };
  }
  const stage = subject.current_stage ?? null;
  return {
    kind: 'generic',
    parts: [
      options.stage && stage !== null ? `${NEEDS_A_PERSON} · ${stageLabel(stage)}` : NEEDS_A_PERSON,
    ],
  };
};

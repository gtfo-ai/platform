/**
 * **The words for the record values a few screens printed raw** (S-25.20, product/10's *Plain
 * words* rule): a run's mode, a command sent to a run, a prompt file's reading, a proposed child
 * ticket, a linked account's kind and an ask's citation — each was a code value on a badge
 * (`review_only`, `not_a_file`, `applied`). Each map is exhaustive over its contract enum, so a new
 * value is a type error here rather than a raw word on a screen; `vocabulary-census.test.ts` refuses
 * the bare `{x.status}`-in-JSX spelling that put them there.
 *
 * A module of its own, as `./settings.ts` is: only lazy screens show these words, and
 * `ui/humanize.ts` — which the first paint imports — does not re-export them (TD-013's budget,
 * `bundle:check`).
 */
import type {
  AskAnswerCitation,
  EffectiveConfigResponse,
  IdentityMapping,
  RunCommandRecord,
  RunMode,
  TicketBreakdownItem,
} from '@platform/contracts';

/** A run's mode, as the run page's badge says it (`normal` is drawn as no badge at all). */
export const RUN_MODE_LABEL: Readonly<Record<RunMode, string>> = {
  normal: 'Normal',
  shadow: 'Trial',
  review_only: 'Review only',
  linter: 'Ticket check',
  discovery: 'Discovery',
  retro: 'Retrospective',
  librarian: 'Librarian',
  ask: 'Question about the task',
  bootstrap: 'History reading',
};

/** Where a command sent to a run stands. */
export const RUN_COMMAND_STATE_LABEL: Readonly<Record<RunCommandRecord['state'], string>> = {
  pending: 'Waiting',
  applied: 'Applied',
  refused: 'Refused',
};

type PromptFileStatus = NonNullable<
  EffectiveConfigResponse['repository']['prompts']
>['files'][number]['status'];

/** How a prompt file in `.agentic/prompts/` was read. */
export const PROMPT_FILE_STATUS_LABEL: Readonly<Record<PromptFileStatus, string>> = {
  file: 'Read',
  not_a_file: 'Not a file',
  oversized: 'Too large',
};

/** A proposed child ticket of an epic's breakdown. */
export const BREAKDOWN_ITEM_STATUS_LABEL: Readonly<Record<TicketBreakdownItem['status'], string>> =
  {
    queued: 'Waiting for a decision',
    accepted: 'Accepted',
    rejected: 'Rejected',
  };

/** Whom a linked provider account belongs to. */
export const IDENTITY_KIND_LABEL: Readonly<Record<IdentityMapping['kind'], string>> = {
  person: 'Person',
  machine: 'Machine account',
};

/** What an answer about a task cites. */
export const ASK_CITATION_KIND_LABEL: Readonly<Record<AskAnswerCitation['kind'], string>> = {
  run: 'Run',
  artifact: 'Document',
  audit: 'Activity',
  knowledge: 'Knowledge base',
};

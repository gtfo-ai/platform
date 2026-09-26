/**
 * The context pack's text-step record (WP-44, PROGRESS backlog 172, Q58 (a)).
 *
 * `ContextPack` has carried `searchedTerms`, `uninformativeTerms` and `termFloor` since WP-58, and
 * they reached a `debug` log and nothing durable — so `run_context_pack`, `run.started` and the run
 * screen could not tell *"every term was uninformative"* from *"this project has no index"* from
 * *"the terms matched nothing"*. This module is the two pure steps that turn them into
 * `ContextPackRecord.text_search`: the outcome, at assembly, and the redaction, at the moment the
 * run's own redactor exists (the executor, beside the prompt columns it redacts the same way).
 *
 * The table of outcomes is `contextPackTextSearchSchema`'s docblock in `@platform/contracts`; it is
 * written there once rather than restated here.
 */
import type {
  ContextPackRecord,
  ContextPackTextOutcome,
  ContextPackTextSearch,
} from '@platform/contracts';
import { MAX_RECORDED_TERM_CHARS } from '@platform/contracts';
import type { SecretRedactor } from '../ports/integrations/audit.js';

/** What the assembler knows when it has searched. */
export interface TextStepFacts {
  /** Every keyword extracted from the task text, before the floor. */
  readonly queryTerms: readonly string[];
  readonly kept: readonly string[];
  readonly uninformative: readonly string[];
  readonly floor: 'applied' | 'no_statistics';
  /** Distinct documents the text query returned hits for. */
  readonly matchedDocuments: number;
}

export const textStepOutcome = (facts: TextStepFacts): ContextPackTextOutcome => {
  if (facts.queryTerms.length === 0) {
    return 'no_terms';
  }
  if (facts.kept.length === 0) {
    return 'all_uninformative';
  }
  return facts.matchedDocuments === 0 ? 'no_match' : 'matched';
};

/** Terms within the record's bound, and how many were not. */
const bounded = (terms: readonly string[]): { kept: string[]; omitted: number } => {
  const kept = terms.filter((term) => term.length > 0 && term.length <= MAX_RECORDED_TERM_CHARS);
  return { kept, omitted: terms.length - kept.length };
};

/** The record's `text_search` for a pack the assembler searched for. */
export const textSearchRecordOf = (facts: TextStepFacts): ContextPackTextSearch => {
  const kept = bounded(facts.kept);
  const dropped = bounded(facts.uninformative);
  return {
    outcome: textStepOutcome(facts),
    kept_terms: kept.kept,
    dropped_terms: dropped.kept,
    floor: facts.floor,
    matched_documents: facts.matchedDocuments,
    omitted_terms: kept.omitted + dropped.omitted,
  };
};

/** The record's `text_search` for a run whose project has no knowledge index: nothing searched. */
export const NOT_SEARCHED: ContextPackTextSearch = {
  outcome: 'not_searched',
  kept_terms: [],
  dropped_terms: [],
  floor: null,
  matched_documents: 0,
  omitted_terms: 0,
};

/**
 * The record with every term the run's redactor would change **left out** and counted.
 *
 * Applied by both executors with the same composed redactor that redacts the prompt columns, before
 * the record reaches `run.started` or `run_context_pack` — the terms are words of the ticket, the
 * spec and the feedback, so they are the prompt's own text in another shape (TD-012, BD-022). A
 * term that redacts to anything else is dropped rather than stored as a placeholder: a placeholder
 * is not a term, and half of one could be a secret's prefix.
 */
export const redactTextSearchTerms = (
  record: ContextPackRecord,
  redactor: SecretRedactor,
): ContextPackRecord => {
  const search = record.text_search;
  if (search === null || search === undefined) {
    return record;
  }
  let omitted = 0;
  const clean = (terms: readonly string[]): string[] =>
    terms.filter((term) => {
      const unchanged = redactor.redactText(term).value === term;
      if (!unchanged) {
        omitted += 1;
      }
      return unchanged;
    });
  const kept = clean(search.kept_terms);
  const dropped = clean(search.dropped_terms);
  return {
    ...record,
    text_search: {
      ...search,
      kept_terms: kept,
      dropped_terms: dropped,
      omitted_terms: search.omitted_terms + omitted,
    },
  };
};

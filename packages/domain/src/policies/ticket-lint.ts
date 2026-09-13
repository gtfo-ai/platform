/**
 * The ticket readiness linter's three decisions, as pure functions (WP-25).
 *
 * product/18 § "Opt-in features": *"A light Refinement pass on new tickets of configured issue types
 * that are **not** labelled for the agent; posts one short comment: the questions a developer would
 * ask, missing acceptance criteria, an agent-readiness score"*. product/04 § "Operating modes that
 * reuse stages" says the same from the pipeline's side: *"a light Refinement pass on unlabelled
 * tickets that posts one comment"*.
 *
 * Three questions, decided here rather than in the saga so each can be enumerated rather than
 * sampled:
 *
 *  1. **is this ticket one the project asked to be linted** ({@link ticketMatchesLintFilter});
 *  2. **how ready is it, and what is it missing** ({@link scoreTicketReadiness});
 *  3. **which of the model's questions go in the comment** ({@link selectLintQuestions}).
 *
 * ## The score is the platform's, never the model's
 *
 * product/19 § 17 asks the comment to carry *"readiness score (0–100) with the top 3 missing
 * elements (acceptance criteria, scope boundaries, validation)"*. `RefinedSpec` has no score field
 * and none is added: the score is **read off the artifact by the platform**, the way product/17's
 * R9/R11/R12 are read off the repository rather than believed from a `DiscoveryDraft`
 * (`packages/domain/src/readiness/criteria.ts`). A number a model wrote about its own output is a
 * claim; a number the platform computed from that output is a measurement, and only the second one
 * can be compared across two tickets or two months.
 *
 * Nothing here touches a clock, a provider or a store, and nothing throws: every input is treated as
 * possibly absent, because the caller reads it out of a stored `artifacts.data` row.
 */
import type { TicketReadinessGap } from '@platform/contracts';

/**
 * The issue types the platform lints when a project enables the feature and names none.
 *
 * technical/12's own example file — `ticket_linter: { enabled: false, issue_types: [Story, Task,
 * Bug] }` — so it is the document's list rather than this file's guess. They are Jira's standard
 * type names; a project on another provider names its own.
 */
export const DEFAULT_LINT_ISSUE_TYPES: readonly string[] = ['Story', 'Task', 'Bug'];

/**
 * The label that means *"for the agent"* — product/19 § 17's offer line, *"add label `agentic` to
 * have it delivered"*.
 *
 * One value with two jobs, and that is deliberate: it is what the linter **skips** and what the
 * comment **offers**. Printing an invitation to add a label the platform does not act on would be
 * the worst of the two spellings.
 */
export const DEFAULT_LINT_LABEL = 'agentic';

/** The project's `features.ticket_linter`, resolved (the effective config always fills it in). */
export interface TicketLintSettings {
  readonly enabled: boolean;
  /** Provider type names. **Empty matches nothing** — see {@link ticketMatchesLintFilter}. */
  readonly issueTypes: readonly string[];
  readonly label: string;
}

/** What the filter needs to know about the ticket; all of it is provider text (BD-022). */
export interface TicketLintCandidate {
  /** The provider's own issue type name, or `null` when the provider does not have the concept. */
  readonly issueType: string | null;
  readonly labels: readonly string[];
}

export type TicketLintMatch =
  | { readonly matched: true; readonly reason: string }
  | { readonly matched: false; readonly reason: string };

/**
 * Compared **case-insensitively and after trimming**, because a human types both of these into a
 * wizard and a ticket.
 *
 * The same rule `mergeRequestMatchesFilter` applies to labels and for the same reason, with one
 * difference in the direction the error falls: here a fold can cost a **skipped** lint (a ticket
 * typed `bug` matches a configured `Bug`, which is wanted) and it can also cost a ticket its lint
 * when the agent label is spelled in another case — which is the fail-closed direction for a comment
 * on somebody else's ticket (standing rule 20).
 */
const same = (left: string, right: string): boolean =>
  left.trim().toLowerCase() === right.trim().toLowerCase();

/**
 * Does the project's filter select this ticket for a lint?
 *
 * Never throws, and answers `false` **with a reason** for every way a filter can decline, because
 * "nothing happened" is the normal outcome here — most tickets in a linting project are not linted —
 * and an operator still has to be able to read why (standing rule 18).
 *
 * The order matters and is the product's: the **agent label wins over the issue type**. A ticket
 * labelled for the agent is going to be delivered by the pipeline, so linting it would post
 * questions on a ticket that is about to get a whole Refinement stage, and the comment's own offer
 * ("add the label") would be advice the author has already taken.
 */
export const ticketMatchesLintFilter = (
  settings: TicketLintSettings,
  candidate: TicketLintCandidate,
): TicketLintMatch => {
  if (!settings.enabled) {
    return {
      matched: false,
      reason: 'the ticket readiness linter is not enabled for this project',
    };
  }
  if (candidate.labels.some((label) => same(label, settings.label))) {
    return {
      matched: false,
      reason: `the ticket carries the label "${settings.label}", so the pipeline delivers it`,
    };
  }
  if (settings.issueTypes.length === 0) {
    return { matched: false, reason: 'the project lints no issue type' };
  }
  const type = candidate.issueType;
  if (type === null) {
    return {
      matched: false,
      reason: 'the ticket has no issue type, so no configured type matches',
    };
  }
  const hit = settings.issueTypes.find((configured) => same(configured, type));
  return hit === undefined
    ? { matched: false, reason: `"${type}" is not an issue type this project lints` }
    : { matched: true, reason: `the ticket is a "${hit}" and carries no agent label` };
};

// ── The score ────────────────────────────────────────────────────────────────

/**
 * What each gap costs, and the derivation of the four numbers.
 *
 * They are a **partition of 100**, which is the whole of the arithmetic: a spec with every gap and
 * the full five questions scores 0, and one with none scores 100, so no clamp is ever load-bearing
 * (`ticket-lint.property.test.ts` asserts the bound over arbitrary inputs rather than trusting this
 * sentence).
 *
 * The order of the three named gaps is product/19 § 17's own — *"acceptance criteria, scope
 * boundaries, validation"* — and the weights follow it, because the list reads as most-important
 * first and a developer picking a ticket up asks for them in that order. The fourth quantity is the
 * linter's own headline output: an open question is the unit of *"the questions a developer would
 * ask"*, so five of them is as far from ready as having no acceptance criteria at all.
 */
export const READINESS_PENALTIES: Readonly<Record<TicketReadinessGap, number>> = {
  acceptance_criteria: 35,
  scope_boundaries: 25,
  validation: 15,
};

/** What one open question costs. */
export const OPEN_QUESTION_PENALTY = 5;

/** product/19 § 17: *"up to 5 questions a developer would ask"*. */
export const MAX_LINT_QUESTIONS = 5;

/** product/19 § 17: *"the top 3 missing elements"*. */
export const MAX_LINT_MISSING = 3;

/**
 * The `RefinedSpec` fields the score reads, every one of them optional.
 *
 * A structural subset rather than `RefinedSpecData` because the caller reads it out of
 * `artifacts.data` — a `jsonb` column written by an older build, or by a stage whose structured
 * output the executor validated against a schema that has since changed. Treating an absent array as
 * empty is the reading that keeps this total; the alternative is a linter that throws on a row it
 * cannot recognise and posts nothing (standing rule 20).
 */
export interface TicketLintSpec {
  readonly in_scope?: readonly string[] | null;
  readonly out_of_scope?: readonly string[] | null;
  readonly acceptance_criteria?:
    | readonly { readonly validation?: { readonly kind?: string } | null }[]
    | null;
  readonly questions?: readonly { readonly text?: string; readonly blocking?: boolean }[] | null;
}

/** The platform's reading of one lint run's artifact. */
export interface TicketReadiness {
  /** 0–100, where 100 is a ticket an agent could pick up as written. */
  readonly score: number;
  /** The gaps, most costly first, capped at {@link MAX_LINT_MISSING}. */
  readonly missing: readonly TicketReadinessGap[];
  /** How many open questions the score counted — at most {@link MAX_LINT_QUESTIONS}. */
  readonly questions: number;
}

const list = <T>(value: readonly T[] | null | undefined): readonly T[] => value ?? [];

/**
 * Which of product/19 § 17's three elements this spec is missing.
 *
 * **`validation` is missing when no acceptance criterion carries an automatable check**, and a spec
 * with no criteria at all is therefore missing both — counted twice on purpose. The two are separate
 * pieces of advice to the ticket's author ("say what done means" and "say how it is checked"), and
 * suppressing the second for the ticket that needs it most would make the emptiest ticket look
 * better than a half-written one.
 */
const gapsOf = (spec: TicketLintSpec): readonly TicketReadinessGap[] => {
  const criteria = list(spec.acceptance_criteria);
  const gaps: TicketReadinessGap[] = [];
  if (criteria.length === 0) {
    gaps.push('acceptance_criteria');
  }
  if (list(spec.in_scope).length === 0 || list(spec.out_of_scope).length === 0) {
    gaps.push('scope_boundaries');
  }
  if (
    !criteria.some(
      (criterion) =>
        criterion.validation?.kind === 'command' || criterion.validation?.kind === 'test',
    )
  ) {
    gaps.push('validation');
  }
  return gaps;
};

/**
 * The readiness score and the gaps it is made of.
 *
 * Pure and total: there is no input for which this throws, and the result is always in `[0, 100]`.
 * The gaps come back ordered by what they cost rather than in the order they were found, so "the top
 * 3" is a statement about weight and not about the order of the checks above.
 */
export const scoreTicketReadiness = (spec: TicketLintSpec): TicketReadiness => {
  const gaps = [...gapsOf(spec)].sort(
    (left, right) => (READINESS_PENALTIES[right] ?? 0) - (READINESS_PENALTIES[left] ?? 0),
  );
  const questions = selectLintQuestions(spec).length;
  const penalty =
    gaps.reduce((total, gap) => total + (READINESS_PENALTIES[gap] ?? 0), 0) +
    questions * OPEN_QUESTION_PENALTY;
  return {
    score: Math.max(0, 100 - penalty),
    missing: gaps.slice(0, MAX_LINT_MISSING),
    questions,
  };
};

/**
 * The questions the comment carries: blocking ones first, then the model's own order, capped.
 *
 * **Blocking first** because `artifactQuestionSchema.blocking` is the model's statement that the
 * work cannot proceed without an answer, and a comment that has room for five questions should spend
 * it on those. Within a group the model's order is kept — `Array.prototype.sort` is stable since
 * ES2019 — because it is the only ranking it gave.
 *
 * A question whose text is blank is dropped rather than rendered: a bullet that says nothing costs
 * one of the five lines product/19 § 17 allows. It cannot happen for an artifact the executor
 * validated (`artifactQuestionSchema.text` is non-empty) and it can for a row this build did not
 * write, which is the same reason {@link TicketLintSpec} is tolerant.
 */
export const selectLintQuestions = (spec: TicketLintSpec): readonly string[] => {
  const asked = list(spec.questions)
    .map((question) => ({
      text: (question.text ?? '').trim(),
      blocking: question.blocking === true,
    }))
    .filter((question) => question.text.length > 0);
  return [...asked]
    .sort((left, right) => Number(right.blocking) - Number(left.blocking))
    .slice(0, MAX_LINT_QUESTIONS)
    .map((question) => question.text);
};

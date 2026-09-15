/**
 * The epic-split variant's two pure decisions — product/04:117, product/18:45 (WP-40).
 *
 * > *"Variant **epic split** (opt-in): the input is an epic and the output is a proposed ticket
 * > breakdown with acceptance criteria for the PM to accept"* · Default: *"off (spike template
 * > option)"*.
 *
 * Two questions live here rather than in the saga, for `ticket-lint.ts`'s reason: each can then be
 * enumerated rather than sampled, and neither touches a clock, a provider or a store.
 *
 *  1. **does this project's variant claim this ticket type** ({@link epicSplitClaims}) — the answer
 *     `templateForIssueType` needs before it routes an epic anywhere;
 *  2. **what does one accepted child become in the tracker** ({@link childTicketTitle},
 *     {@link renderChildDescription}) — the bounding of model output on its way into somebody
 *     else's backlog.
 *
 * ## What the platform writes and what the model writes
 *
 * The child's **title, description, rationale and acceptance criteria are the model's** and are
 * quoted; every other word of the created ticket is the platform's — the heading, the parent line
 * and the criteria table's own labels. That division is the one `renderLintComment` makes and it is
 * what makes the length of a created ticket a property of this function rather than a hope about a
 * model.
 */
import type { AcceptanceCriterion, BreakdownChild } from '@platform/contracts';
import {
  MAX_BREAKDOWN_CRITERIA,
  MAX_BREAKDOWN_DESCRIPTION_CHARS,
  MAX_BREAKDOWN_TITLE_CHARS,
} from '@platform/contracts';

/**
 * The ticket types the variant claims when a project enables it and names none.
 *
 * product/04:117 says *"the input is an **epic**"* and nothing else, so the list is that one word.
 * A project whose tracker calls it something else (`Initiative`, `Theme`) names its own, and an
 * **explicitly empty** list claims nothing.
 */
export const DEFAULT_EPIC_SPLIT_ISSUE_TYPES: readonly string[] = ['Epic'];

/**
 * What an accepted child is created as.
 *
 * `Task` rather than `Story`: it is the type Jira, GitLab and this repository's own fixtures all
 * have, and it is the one whose workflow a project is least likely to have specialised. A project
 * that wants otherwise sets `features.epic_split.child_issue_type` — which is a *project's*
 * decision and never a model's, because a type whose workflow has no `status_mapping` would leave
 * every created ticket in a column the platform cannot move it out of.
 */
export const DEFAULT_CHILD_ISSUE_TYPE = 'Task';

/** The project's `features.epic_split`, resolved (the effective config always fills it in). */
export interface EpicSplitSettings {
  readonly enabled: boolean;
  /** Provider type names. **Empty claims nothing** — see {@link epicSplitClaims}. */
  readonly issueTypes: readonly string[];
  readonly childIssueType: string;
}

/**
 * Compared **case-insensitively and after trimming**, because a human types the configured value
 * into a wizard and the provider supplies its own capitalisation (`epic`, `Epic`, `EPIC`).
 *
 * The same fold `ticketMatchesLintFilter` applies, and the direction the error falls is the
 * opposite one: a fold here can only cause a ticket to be *routed to the variant the project turned
 * on*, never to a provider write nobody asked for — nothing is created until a human accepts.
 */
const same = (left: string, right: string): boolean =>
  left.trim().toLowerCase() === right.trim().toLowerCase();

/**
 * Does this project's epic-split variant claim a ticket of this issue type?
 *
 * `false` for a project that has not enabled it, for a ticket with no issue type at all (a provider
 * without the concept), and for a project whose list is explicitly empty — the fail-closed reading
 * of "the types I named", and the same answer `review_only.paths` and `maintenance.chores` give.
 */
export const epicSplitClaims = (
  settings: EpicSplitSettings,
  issueType: string | null | undefined,
): boolean => {
  if (!settings.enabled || issueType === null || issueType === undefined) {
    return false;
  }
  return settings.issueTypes.some((candidate) => same(candidate, issueType));
};

/** Cuts with an ellipsis rather than refusing: half a title still names the ticket. */
const cut = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/**
 * The summary the created ticket carries.
 *
 * Bounded at the artifact's own {@link MAX_BREAKDOWN_TITLE_CHARS} rather than at a second number:
 * a value bounded twice has two untestable guards (standing rule 41), and the schema is the outer
 * one. It is applied again here because the row this reads may have been written by an older build.
 */
export const childTicketTitle = (child: Pick<BreakdownChild, 'title'>): string =>
  cut(child.title.trim(), MAX_BREAKDOWN_TITLE_CHARS);

/** One criterion as a line a human reads. The three clauses are the model's; the labels are ours. */
const criterionLine = (criterion: AcceptanceCriterion, index: number): string =>
  `${index + 1}. **Given** ${criterion.given} **when** ${criterion.when} **then** ${criterion.then} ` +
  `(${criterion.validation.kind}: ${criterion.validation.value})`;

/**
 * The body of a created child ticket — product/04:117's *"with acceptance criteria"*.
 *
 * Every word outside the quoted fields is the platform's, so the worst case is computable from the
 * caps: one description ({@link MAX_BREAKDOWN_DESCRIPTION_CHARS}), one rationale (the same), at most
 * {@link MAX_BREAKDOWN_CRITERIA} criteria, and the fixed prose. `epic-split.test.ts` produces the
 * worst case by driving this function rather than asserting the arithmetic here (standing rule 39).
 *
 * The parent line names the **epic's own key**, which is the platform's fact rather than the
 * model's: the child is linked to its parent by `TicketDraft.parent_key` as well, and the line is
 * what a human sees on a provider that does not render the link.
 */
export const renderChildDescription = (input: {
  readonly child: BreakdownChild;
  readonly parentKey: string;
}): string => {
  const criteria = input.child.acceptance_criteria
    .slice(0, MAX_BREAKDOWN_CRITERIA)
    .map((criterion, index) => criterionLine(criterion, index));
  return [
    `Proposed by the Agentic platform as part of splitting ${input.parentKey}, and accepted by a human before it was created.`,
    '',
    cut(input.child.description.trim(), MAX_BREAKDOWN_DESCRIPTION_CHARS),
    '',
    '**Acceptance criteria**',
    ...criteria,
    '',
    `**Why this is a ticket of its own**: ${cut(input.child.rationale.trim(), MAX_BREAKDOWN_DESCRIPTION_CHARS)}`,
  ].join('\n');
};

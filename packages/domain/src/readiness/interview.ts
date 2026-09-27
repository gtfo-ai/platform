/**
 * The onboarding **business interview** — product/06 § "Step 3", product/19 §8's question bank v1
 * (WP-64, PROGRESS backlog 45).
 *
 * > "Answers become `business/*.md` pages plus glossary entries; the agent shows the generated
 * > pages for edit and acceptance."
 *
 * This is the data and the renderer; the command that bounds, redacts and queues the pages is
 * `onboarding/interview.ts` in the application ring. Pure: nothing here reads a clock or a store.
 *
 * ## One section, one page, at the path the completeness score reads
 *
 * product/19 §8 has **eight** sections. Seven of them are product/06's business completeness
 * sections, and their page is the path {@link KNOWLEDGE_COMPLETENESS_SECTIONS} already fixes (Q68):
 * the path is looked up by id rather than spelled a second time, so the interview cannot write a page
 * the score does not read. The eighth, **Communication**, is not a scored section; its page is
 * `business/communication.md`, under product/05's business layer, and it moves no number — which is
 * stated rather than folded into another section's page, because a communication answer counting
 * as "review expectations" would be a score the repository did not earn.
 *
 * ## "Not applicable" is a page, and that is product/06's own rule
 *
 * product/19 §8: *"Each question has a 'skip' and 'not applicable' option"*; product/06: the score
 * is shown *"until every section is either filled or explicitly marked 'not applicable'"*. A skipped
 * section writes nothing. A section marked not applicable writes its page saying so, and because
 * Q68 scores a section by its page existing, the mark is visible to the score through the same
 * mechanism as an answer — with no new column and no new state. That is the cheapest honest
 * answer to Q68 (b) *for a project that has been through the interview*; a project that never ran
 * it still has nowhere else to mark one.
 *
 * ## The answer is the human's words, byte for byte
 *
 * It is untrusted text (BD-022): it becomes a repository page once a maintainer approves it, and a
 * page is later read into prompts through a data block. Nothing here strips or escapes it — the
 * `untrusted.tsx` answer: nothing to undo later — and nothing here can put it anywhere but the
 * page's body: the frontmatter and every heading are platform text, so an answer cannot give its
 * page an id, a type, a scope or a `paths:` glob.
 */
import {
  type BUSINESS_INTERVIEW_SECTION_IDS,
  MAX_INTERVIEW_ANSWER_CHARS,
  MAX_INTERVIEW_REASON_CHARS,
  MAX_PROPOSAL_DELTA_BYTES,
} from '@platform/contracts';
import { KNOWLEDGE_COMPLETENESS_SECTIONS } from './criteria.js';

/** product/19 §8's section ids — `BUSINESS_INTERVIEW_SECTION_IDS`, the wire's list, not a second spelling. */
export type BusinessInterviewSectionId = (typeof BUSINESS_INTERVIEW_SECTION_IDS)[number];

export interface BusinessInterviewSection {
  readonly id: BusinessInterviewSectionId;
  /** The page's title. Platform text. */
  readonly title: string;
  /** product/19 §8's questions for the section, as the form asks them. Platform text. */
  readonly questions: string;
  /** The completeness section it fills, or `null` for the one that fills none. */
  readonly completenessSection: string | null;
  /** Vault-relative, like every path in `KNOWLEDGE_COMPLETENESS_SECTIONS`. */
  readonly path: string;
}

const scoredPath = (id: string): string => {
  const section = KNOWLEDGE_COMPLETENESS_SECTIONS.find((entry) => entry.id === id);
  if (section === undefined) {
    // Unreachable while the two tables agree, which `interview.test.ts` asserts.
    throw new Error(`no completeness section "${id}"`);
  }
  return section.path;
};

/** product/19 §8, transcribed. */
export const BUSINESS_INTERVIEW_SECTIONS: readonly BusinessInterviewSection[] = [
  {
    id: 'product',
    title: 'Product',
    questions: 'What it is, for whom, what it is not, and its value in one sentence.',
    completenessSection: 'business_overview',
    path: scoredPath('business_overview'),
  },
  {
    id: 'users',
    title: 'Users',
    questions: 'The personas, their goals, and what annoys them.',
    completenessSection: 'personas',
    path: scoredPath('personas'),
  },
  {
    id: 'business_rules',
    title: 'Business rules',
    questions:
      'Invariants that must never break, regulatory constraints, and money, tax and privacy rules.',
    completenessSection: 'business_rules',
    path: scoredPath('business_rules'),
  },
  {
    id: 'glossary',
    title: 'Glossary',
    questions: 'About ten words that have a special meaning here, each with that meaning.',
    completenessSection: 'glossary',
    path: scoredPath('glossary'),
  },
  {
    id: 'direction',
    title: 'Direction',
    questions:
      'Goals for the next three to six months, non-goals, accepted technical debt, and planned rewrites.',
    completenessSection: 'direction',
    path: scoredPath('direction'),
  },
  {
    id: 'quality_bar',
    title: 'Quality bar',
    questions:
      'The definition of done, test expectations, accessibility, performance and security expectations, and documentation duties.',
    completenessSection: 'quality_bar',
    path: scoredPath('quality_bar'),
  },
  {
    id: 'review',
    title: 'Review expectations',
    questions:
      'Who reviews, what they care about most, the merge-request size you prefer, and must-have reviewers per area.',
    completenessSection: 'review_expectations',
    path: scoredPath('review_expectations'),
  },
  {
    id: 'communication',
    title: 'Communication',
    questions:
      'The language for tickets and merge requests, the tone, what goes to chat, and working hours for questions.',
    completenessSection: null,
    path: 'business/communication.md',
  },
];

export const findInterviewSection = (id: string): BusinessInterviewSection | undefined =>
  BUSINESS_INTERVIEW_SECTIONS.find((section) => section.id === id);

/**
 * The cap on one answer is `MAX_INTERVIEW_ANSWER_CHARS` (`@platform/contracts`, because the wire
 * refuses above it too), applied **after** redaction — the ticket snapshot's order: an exact-match
 * redactor cannot find a secret a cut has already halved.
 *
 * It is derived from the page budget rather than chosen beside it: a page is one proposal, and a
 * proposal's `delta` is at most `MAX_PROPOSAL_DELTA_BYTES` (64 KiB) — the curator refuses a longer
 * one. At four bytes a character (astral text, the worst case) 12 000 characters are 48 000 bytes,
 * which leaves {@link MAX_INTERVIEW_PAGE_OVERHEAD_BYTES} for the frontmatter, the headings, the
 * questions and the truncation notice; `interview.test.ts` renders the worst case and holds it
 * under the budget.
 */
/** What a page may spend on platform text around the answer — the budget's other half. */
export const MAX_INTERVIEW_PAGE_OVERHEAD_BYTES =
  MAX_PROPOSAL_DELTA_BYTES - MAX_INTERVIEW_ANSWER_CHARS * 4;

/** One section's input to {@link renderInterviewPage}, already redacted and cut. */
export type BusinessInterviewEntry =
  | { readonly status: 'answered'; readonly text: string; readonly truncated: boolean }
  | { readonly status: 'not_applicable'; readonly reason: string; readonly truncated: boolean };

const frontmatterOf = (section: BusinessInterviewSection): string =>
  [
    '---',
    `id: business-${section.id.replaceAll('_', '-')}`,
    `title: ${section.title}`,
    'type: reference',
    'kind: business',
    'scope: project',
    '---',
  ].join('\n');

const truncationNotice = (limit: number): string =>
  `_The platform cut this text at ${limit} characters; the rest was not stored._`;

/**
 * The page one section becomes. Every line outside the answer is platform text.
 *
 * The answer follows a fixed heading and is never interpreted: a `---` in it is a thematic break in
 * the body, not frontmatter (frontmatter is only ever the first block of a file, and this module
 * wrote that block), and a heading in it is a heading *inside* the section.
 */
export const renderInterviewPage = (
  section: BusinessInterviewSection,
  entry: BusinessInterviewEntry,
): string => {
  const head = [
    frontmatterOf(section),
    '',
    `# ${section.title}`,
    '',
    '_Written from the onboarding business interview (product/06, step 3). The text below is the interviewee’s own, unedited._',
    '',
    `## ${section.questions}`,
    '',
  ];
  if (entry.status === 'not_applicable') {
    return [
      ...head,
      'Marked **not applicable** to this project during the onboarding interview.',
      '',
      ...(entry.reason.trim().length > 0 ? ['Reason given:', '', entry.reason, ''] : []),
      ...(entry.truncated ? [truncationNotice(MAX_INTERVIEW_REASON_CHARS), ''] : []),
    ].join('\n');
  }
  return [
    ...head,
    entry.text,
    '',
    ...(entry.truncated ? [truncationNotice(MAX_INTERVIEW_ANSWER_CHARS), ''] : []),
  ].join('\n');
};

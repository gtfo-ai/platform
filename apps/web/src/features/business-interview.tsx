/**
 * The business interview — product/06 § "Step 3", product/19 §8's question bank v1 (WP-64).
 *
 * > "Answers become `business/*.md` pages plus glossary entries; the agent shows the generated
 * > pages for edit and acceptance."
 *
 * **One component, rendered by the wizard's step 3 *and* by the project settings page's "Business
 * context"** — the arrangement `history-bootstrap.tsx` and `operating-mode.tsx` have, for
 * product/18:55's reason: a mirror stays true by not having two of it.
 *
 * Eight sections, each with product/19 §8's three choices: answer it, mark it **not applicable**,
 * or leave it empty to skip it. Submitting writes **proposals**, never a commit: each answered
 * section becomes one page in the project's proposal queue, where a maintainer edits and approves
 * it and the approval opens a merge request (BD-012, BD-007). So the screen links to the queue
 * rather than claiming the pages exist.
 *
 * ## What this form is not
 *
 * product/06 describes *"a conversational form driven by the Product Manager role"*, asking in the
 * interviewee's language. This one is the question bank as a form with no model in it — the page is
 * the person's own words under the platform's headings (Q102). The screen says so, because an
 * operator who expected a conversation should not have to find that out from the pages.
 *
 * ## Everything the server answers is rendered as text
 *
 * The page paths come back from the server; they go through `ui/untrusted.tsx` like every other
 * string (BD-022), even though they are platform-chosen today.
 */
import {
  BUSINESS_INTERVIEW_SECTION_IDS,
  type BusinessInterviewRequest,
  MAX_INTERVIEW_ANSWER_CHARS,
  MAX_INTERVIEW_REASON_CHARS,
} from '@platform/contracts';
import { Link } from '@tanstack/react-router';
import { type ReactElement, useState } from 'react';
import { useOnboardingCommands } from '../app/queries.js';
import { Badge, Button, ErrorNotice } from '../ui/kit.js';
import { UntrustedText } from '../ui/untrusted.js';

type SectionId = (typeof BUSINESS_INTERVIEW_SECTION_IDS)[number];

/**
 * product/19 §8's sections and questions, as the form asks them.
 *
 * The **platform's** copy of the same bank is `BUSINESS_INTERVIEW_SECTIONS` in `@platform/domain`,
 * which the page headings are rendered from. It is restated rather than imported so the page does
 * not pull the domain ring into the bundle (the reason `project-settings.tsx` gives for the WIP
 * limits), and `business-interview.test.tsx` holds every title and question to the domain's, so the
 * form cannot ask one question while the page is headed with another.
 */
export const INTERVIEW_QUESTIONS: Readonly<
  Record<SectionId, { readonly title: string; readonly ask: string }>
> = {
  product: {
    title: 'Product',
    ask: 'What it is, for whom, what it is not, and its value in one sentence.',
  },
  users: { title: 'Users', ask: 'The personas, their goals, and what annoys them.' },
  business_rules: {
    title: 'Business rules',
    ask: 'Invariants that must never break, regulatory constraints, and money, tax and privacy rules.',
  },
  glossary: {
    title: 'Glossary',
    ask: 'About ten words that have a special meaning here, each with that meaning.',
  },
  direction: {
    title: 'Direction',
    ask: 'Goals for the next three to six months, non-goals, accepted technical debt, and planned rewrites.',
  },
  quality_bar: {
    title: 'Quality bar',
    ask: 'The definition of done, test expectations, accessibility, performance and security expectations, and documentation duties.',
  },
  review: {
    title: 'Review expectations',
    ask: 'Who reviews, what they care about most, the merge-request size you prefer, and must-have reviewers per area.',
  },
  communication: {
    title: 'Communication',
    ask: 'The language for tickets and merge requests, the tone, what goes to chat, and working hours for questions. (Not one of the ten scored sections.)',
  },
};

interface SectionDraft {
  readonly text: string;
  readonly notApplicable: boolean;
}

const EMPTY: SectionDraft = { text: '', notApplicable: false };

/** The request the drafts make — a section with neither an answer nor a mark is a skip. */
export const answersOf = (
  drafts: Readonly<Partial<Record<SectionId, SectionDraft>>>,
): BusinessInterviewRequest['answers'] => {
  const answers: Partial<Record<SectionId, BusinessInterviewRequest['answers'][SectionId]>> = {};
  for (const id of BUSINESS_INTERVIEW_SECTION_IDS) {
    const draft = drafts[id] ?? EMPTY;
    if (draft.notApplicable) {
      // The reason's own cap, which is shorter than an answer's: text typed before the box was
      // ticked is kept as the reason and cut to what the server accepts.
      answers[id] =
        draft.text.trim() === ''
          ? { status: 'not_applicable' }
          : { status: 'not_applicable', reason: draft.text.slice(0, MAX_INTERVIEW_REASON_CHARS) };
    } else if (draft.text.trim() !== '') {
      answers[id] = { status: 'answered', text: draft.text };
    }
  }
  return answers;
};

export const BusinessInterview = ({
  projectId,
  projectKey,
}: {
  readonly projectId: string;
  /** The project's human key — what the knowledge screen's route is addressed by. */
  readonly projectKey: string;
}): ReactElement => {
  const commands = useOnboardingCommands();
  const [drafts, setDrafts] = useState<Partial<Record<SectionId, SectionDraft>>>({});
  const answers = answersOf(drafts);
  const answered = Object.keys(answers).length;
  const update = (id: SectionId, change: Partial<SectionDraft>): void => {
    setDrafts((current) => ({ ...current, [id]: { ...(current[id] ?? EMPTY), ...change } }));
  };

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        commands.recordInterview.mutate({ projectId, answers });
      }}
    >
      <p className="text-xs text-fg-muted">
        Fifteen to thirty minutes. Every section is optional: leave it empty to skip it, or mark it
        not applicable. Each answer becomes a <code>business/</code> page proposed to the knowledge
        base — nothing is committed until a maintainer approves it in the proposal queue. This is
        the question bank as a form: your words are the page, and no agent rewrites them.
      </p>
      {BUSINESS_INTERVIEW_SECTION_IDS.map((id) => {
        const draft = drafts[id] ?? EMPTY;
        const question = INTERVIEW_QUESTIONS[id];
        return (
          <fieldset key={id} className="flex flex-col gap-1">
            <legend className="text-sm font-medium">{question.title}</legend>
            <p className="text-xs text-fg-muted">{question.ask}</p>
            <textarea
              aria-label={question.title}
              value={draft.text}
              rows={3}
              maxLength={
                draft.notApplicable ? MAX_INTERVIEW_REASON_CHARS : MAX_INTERVIEW_ANSWER_CHARS
              }
              placeholder={draft.notApplicable ? 'Why it does not apply (optional)' : ''}
              onChange={(event) => {
                update(id, { text: event.target.value });
              }}
              className="rounded-md border border-line bg-surface px-2 py-1 text-sm"
            />
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={draft.notApplicable}
                onChange={(event) => {
                  update(id, { notApplicable: event.target.checked });
                }}
              />
              Not applicable to this project
            </label>
          </fieldset>
        );
      })}
      <div>
        <Button
          type="submit"
          tone="primary"
          disabled={answered === 0 || commands.recordInterview.isPending}
        >
          Propose {answered === 1 ? 'the page' : `${answered} pages`}
        </Button>
      </div>
      {commands.recordInterview.isError ? (
        <ErrorNotice title="The interview could not be recorded." />
      ) : null}
      {commands.recordInterview.isSuccess ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs">
            {commands.recordInterview.data.performed
              ? 'Proposed, and waiting in the queue:'
              : 'These answers were already recorded; nothing was proposed twice:'}
          </p>
          <ul className="flex flex-col gap-1">
            {commands.recordInterview.data.pages.map((page) => (
              <li key={page.proposal_id} className="text-xs">
                <Badge>{page.status}</Badge> <UntrustedText value={page.target_path} />
                {page.truncated ? ' — cut at the length limit, and the page says so' : ''}
              </li>
            ))}
          </ul>
          <p className="text-sm">
            <Link to="/projects/$key/knowledge" params={{ key: projectKey }}>
              Review the proposed pages
            </Link>
          </p>
        </div>
      ) : null}
    </form>
  );
};

/**
 * Ask the task — product/10:57's *"a thread on the task page where anyone with access can ask 'why
 * did you choose X?'; answered from the audit trail and artifacts with links to the exact run and
 * prompt"* (WP-31).
 *
 * ## Everything here is untrusted, in both directions
 *
 * The **question** is a human's free text and the **answer** is a model's, so both go through
 * `UntrustedProse`/`UntrustedText` as React text nodes (BD-022). There is no markdown-to-HTML step
 * and nothing to undo; `apps/web/src/no-html.test.ts` fails the build if one appears.
 *
 * A **citation carries no URL**, deliberately: `askAnswerCitationSchema` names a *row* — a run id,
 * an artifact type and version, a `human_actions` id, a vault path — and this component builds the
 * link itself from the router's own route. A model that could write a link would be writing a link
 * this application publishes, and `urlSchema` is `z.url()`, which accepts `javascript:` (Q49).
 *
 * `dropped_citations` is **shown** rather than hidden: it counts the claims whose evidence named
 * another task or another project and was refused (product/11:30). A reader who can see that two
 * claims lost their evidence knows how much of the answer to trust.
 */
import type { AskAnswerCitation, TaskAsk } from '@platform/contracts';
import { Link } from '@tanstack/react-router';
import { type ReactElement, useState } from 'react';
import { useAskTask, useTaskAsks } from '../app/queries.js';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  formatDateTime,
  Loading,
  SectionHeading,
} from '../ui/kit.js';
import { UntrustedProse, UntrustedText } from '../ui/untrusted.js';

/** The four states an ask can be in, as one line a person can read. */
const STATUS_TONE = {
  pending: 'neutral',
  answered: 'success',
  refused: 'warning',
  failed: 'danger',
} as const;

const STATUS_LABEL = {
  pending: 'thinking…',
  answered: 'answered',
  refused: 'not run',
  failed: 'failed',
} as const;

/**
 * One citation, as a link this application built.
 *
 * A `run` citation is the only one this build can link: the run screen exists. An `artifact` or an
 * `audit` citation is rendered as the row it names, without a link, because there is no screen that
 * addresses one — naming what is missing rather than drawing a dead link (standing rule 18).
 */
const Citation = ({ citation }: { readonly citation: AskAnswerCitation }): ReactElement => {
  if (citation.kind === 'run' && typeof citation.run_id === 'string') {
    return (
      <li className="text-xs">
        <Link to="/runs/$runId" params={{ runId: citation.run_id }} className="underline">
          run {citation.run_id.slice(0, 8)}
        </Link>{' '}
        — <UntrustedText value={citation.detail} />
      </li>
    );
  }
  if (citation.kind === 'artifact') {
    return (
      <li className="text-xs">
        <UntrustedText
          value={`${citation.artifact_type ?? 'artifact'} v${citation.version ?? '?'}`}
        />{' '}
        — <UntrustedText value={citation.detail} />
      </li>
    );
  }
  return (
    <li className="text-xs">
      <span className="text-fg-muted">{citation.kind}</span>{' '}
      <UntrustedText value={citation.reference ?? '(unnamed)'} /> —{' '}
      <UntrustedText value={citation.detail} />
    </li>
  );
};

/** A stable key for a citation, built from the row it names. See the call site for why. */
const citationKey = (citation: AskAnswerCitation): string =>
  [
    citation.kind,
    citation.run_id ?? '',
    citation.artifact_type ?? '',
    citation.version ?? '',
    citation.reference ?? '',
  ].join('|');

const AskCard = ({ ask }: { readonly ask: TaskAsk }): ReactElement => (
  <Card className="flex flex-col gap-2">
    <div className="flex items-center gap-2">
      <Badge tone={STATUS_TONE[ask.status]}>{STATUS_LABEL[ask.status]}</Badge>
      <span className="text-xs text-fg-muted">
        {ask.source === 'ticket' ? 'from the ticket thread' : 'from this page'}
      </span>
      <span className="ml-auto text-xs text-fg-muted">{formatDateTime(ask.created_at)}</span>
    </div>
    {/* A human's own words, rendered and never executed (BD-022). */}
    <UntrustedProse value={ask.question} className="font-medium" />
    {ask.answer === null ? null : <UntrustedProse value={ask.answer} />}
    {ask.refusal_reason === null ? null : (
      <p className="text-xs text-fg-muted">
        <UntrustedText value={ask.refusal_reason} />
      </p>
    )}
    {ask.citations.length === 0 ? null : (
      <ul className="flex flex-col gap-1">
        {ask.citations.map((citation) => (
          // Keyed by what the citation **says**, not by its position: a citation carries no
          // identity of its own, and an index key would make two answers' lists collide in React's
          // reconciliation if the thread ever re-sorted. Two identical citations in one answer are
          // the only collision this can have, and they render identically.
          <Citation key={citationKey(citation)} citation={citation} />
        ))}
      </ul>
    )}
    {ask.dropped_citations === 0 ? null : (
      <p className="text-xs text-fg-muted">
        {ask.dropped_citations} citation(s) named a run or an artifact outside this task and were
        dropped.
      </p>
    )}
    {ask.mirrored_at === null ? null : (
      <p className="text-xs text-fg-muted">Also posted in the ticket thread.</p>
    )}
  </Card>
);

export const AskThread = ({ taskId }: { readonly taskId: string }): ReactElement => {
  const asks = useTaskAsks(taskId);
  const ask = useAskTask(taskId);
  const [question, setQuestion] = useState('');

  return (
    <section className="flex flex-col gap-3">
      <SectionHeading>Ask the task</SectionHeading>
      <p className="text-xs text-fg-muted">
        Answered from this task's own audit trail and artifacts, with links to the runs behind the
        answer.
      </p>
      <form
        className="flex flex-col gap-2"
        onSubmit={(submitted) => {
          submitted.preventDefault();
          if (question.trim() === '') {
            return;
          }
          ask.mutate(question.trim(), {
            onSuccess: () => {
              setQuestion('');
            },
          });
        }}
      >
        <label className="text-xs text-fg-muted" htmlFor="ask-question">
          Your question
        </label>
        <textarea
          id="ask-question"
          className="min-h-20 rounded border border-border bg-bg px-2 py-1 text-sm"
          value={question}
          // 4 000 is `MAX_ASK_QUESTION_CHARS`, which the server **refuses** past rather than
          // truncating: half a question is a different question. The control stops the caller from
          // reaching that refusal at all.
          maxLength={4_000}
          placeholder="why did you choose X?"
          onChange={(changed) => {
            setQuestion(changed.target.value);
          }}
        />
        <div className="flex items-center gap-2">
          <Button type="submit" tone="primary" disabled={ask.isPending || question.trim() === ''}>
            Ask
          </Button>
          <span className="text-xs text-fg-muted">
            One question is a short run against this task's own budget.
          </span>
        </div>
      </form>
      {ask.error === null || ask.error === undefined ? null : (
        <ErrorNotice title="That question was refused." detail={String(ask.error)} />
      )}
      {asks.isPending ? <Loading label="Loading the thread…" /> : null}
      {asks.error === null || asks.error === undefined ? null : (
        <ErrorNotice title="The thread could not be loaded." detail={String(asks.error)} />
      )}
      {asks.data !== undefined && asks.data.items.length === 0 ? (
        <EmptyState
          title="No questions yet"
          hint="Ask why something was decided and the platform answers from what it recorded."
        />
      ) : null}
      {(asks.data?.items ?? []).map((entry) => (
        <AskCard key={entry.id} ask={entry} />
      ))}
    </section>
  );
};

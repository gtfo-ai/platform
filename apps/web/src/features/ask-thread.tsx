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
import type { ArtifactRef, AskAnswerCitation, TaskAsk } from '@platform/contracts';
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
 * Two of the four kinds link. A **`run`** citation goes to the run screen, which has existed since
 * WP-20. An **`artifact`** citation goes to `?artifact=<id>` on this very task — the panel WP-52
 * added to `task-detail.tsx` — and the id is resolved *here*, from the task's own artifact list,
 * because a citation names a `(type, version)` pair and never an id (`askAnswerCitationSchema`:
 * a model that could write a link would be writing a link this application publishes). A citation
 * naming a version this task does not have stays plain text, which is the honest answer: the row it
 * points at is not on this task.
 *
 * **`audit` and `knowledge` still do not link, and that is declined rather than forgotten** —
 * PROGRESS backlog **86**, whose two halves WP-52 deliberately leaves. The audit half has a catch
 * the entry states: the task audit is **paged** (`apps/server/src/routes/asks.ts`), so an `#id`
 * anchor resolves only for a row on the first page and the honest shape is a cursor that lands on
 * the citation's row — a change to the audit endpoint, not to this component. The knowledge half is
 * cheaper (the API already takes a path) but needs a search parameter on `/projects/$key/knowledge`
 * and a KB screen that reads it, which is a second screen's worth of work in a row that already
 * opens the redaction path, the migration and the artifact route. Both stay as they are, printed as
 * the kind and the row they name — never as a dead link (standing rule 18).
 */
const Citation = ({
  citation,
  artifacts,
}: {
  readonly citation: AskAnswerCitation;
  /** The task's own artifacts: a citation names a `(type, version)` pair and never an id. */
  readonly artifacts: readonly ArtifactRef[];
}): ReactElement => {
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
    const named = artifacts.find(
      (artifact) =>
        artifact.artifact_type === citation.artifact_type && artifact.version === citation.version,
    );
    const label = `${citation.artifact_type ?? 'artifact'} v${citation.version ?? '?'}`;
    return (
      <li className="text-xs">
        {named === undefined ? (
          <UntrustedText value={label} />
        ) : (
          // `to="."` keeps whichever task route the reader is on — the thread is rendered from
          // both `/tasks/$taskId` and `/projects/$key/tasks/$taskId`, and naming the first would
          // drop a reader out of their project's context on every citation they followed.
          <Link
            to="."
            search={(previous: Record<string, unknown>) => ({ ...previous, artifact: named.id })}
            className="underline"
          >
            <UntrustedText value={label} />
          </Link>
        )}{' '}
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

const AskCard = ({
  ask,
  artifacts,
}: {
  readonly ask: TaskAsk;
  readonly artifacts: readonly ArtifactRef[];
}): ReactElement => (
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
          <Citation key={citationKey(citation)} citation={citation} artifacts={artifacts} />
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

export const AskThread = ({
  taskId,
  artifacts,
}: {
  readonly taskId: string;
  /** The task's own artifacts, so an `artifact` citation's `(type, version)` resolves to an id. */
  readonly artifacts: readonly ArtifactRef[];
}): ReactElement => {
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
        <AskCard key={entry.id} ask={entry} artifacts={artifacts} />
      ))}
    </section>
  );
};

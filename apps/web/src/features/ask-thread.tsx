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
 *
 * ## An ask that did not answer still tells the asker what happened (S-25.17)
 *
 * On Autix (AUT-6655) a failed ask showed only *the run ended "failed"*: no reason, no run, no way
 * to try again. A failed ask, and one whose run was cancelled, now says **why in words** — from the
 * run's own `terminal_reason`, which the thread carries as `run_terminal_reason` — links **its run**,
 * and offers **Ask again** with the question filled in. Nothing is salvaged from the run's refused
 * text: an answer the contract refused is not shown, even when it looked readable, because a
 * half-shaped answer the platform did not check is an answer it would be inventing.
 */
import type {
  ArtifactRef,
  AskAnswerCitation,
  RunTerminalReason,
  TaskAsk,
} from '@platform/contracts';
import { Link } from '@tanstack/react-router';
import { type ReactElement, useRef, useState } from 'react';
import { useAskTask, useTaskAsks } from '../app/queries.js';
import { TERMINAL_REASON_MEANING } from '../ui/humanize.js';
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

/** The answer the contract refused (S-25.17): the words the plan row fixed. */
export const ASK_WRONG_SHAPE = 'The answer didn’t come back in the expected shape.';

/**
 * The answer the platform held back (S-25.17 review): the run finished and its answer put a secret
 * the run was given into an identifier field, which the executor refuses to rewrite and ends by
 * name (`packages/application/src/ask/executor.ts`, the `refusedPath` branch). Not a shape failure.
 */
export const ASK_HELD_BACK =
  'The answer was held back because it quoted a credential. Ask again, or open the run.';

/** The executor's own opening of that refusal — the one sentence it stores for it. */
const HELD_BACK_REFUSAL = 'the answer put a secret';

/**
 * Why the run behind an ask ended without an answer, in a sentence (S-25.17) — the run page's own
 * table (`ui/words/terminal-reasons.ts`'s `TERMINAL_REASON_MEANING`, S-25.19: one table, not two),
 * so a reason added to the contract fails the build there until it is worded. Two entries are the
 * ask's own: `success` is reached only for a **failed** ask — the run finished and its result did
 * not match the `AskAnswer` contract — which is the same thing the structured-output retries running
 * out says, so both read {@link ASK_WRONG_SHAPE}.
 */
export const ASK_ENDED_BECAUSE: Readonly<Record<RunTerminalReason, string>> = {
  ...TERMINAL_REASON_MEANING,
  success: ASK_WRONG_SHAPE,
  error_max_structured_output_retries: ASK_WRONG_SHAPE,
};

/**
 * What the card says about an ask that got no answer, or `null` when it is not that kind of ask:
 * a **failed** ask, and a **refused** one whose run ended without succeeding (a cancelled run
 * refuses its ask). A refusal no run was started for — a spent cap, the feature off — keeps its
 * recorded reason alone, since asking again would meet the same refusal.
 */
export const askEnding = (ask: TaskAsk): { readonly words: string } | null => {
  if (ask.status === 'failed') {
    if (ask.refusal_reason?.startsWith(HELD_BACK_REFUSAL) === true) {
      return { words: ASK_HELD_BACK };
    }
    return {
      words:
        ask.run_terminal_reason === null
          ? 'The run that answers it ended before it wrote an answer.'
          : ASK_ENDED_BECAUSE[ask.run_terminal_reason],
    };
  }
  if (
    ask.status === 'refused' &&
    ask.run_id !== null &&
    ask.run_terminal_reason !== null &&
    ask.run_terminal_reason !== 'success'
  ) {
    return { words: ASK_ENDED_BECAUSE[ask.run_terminal_reason] };
  }
  return null;
};

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
  onAskAgain,
}: {
  readonly ask: TaskAsk;
  readonly artifacts: readonly ArtifactRef[];
  /** Fills the form with this question again (S-25.17). */
  readonly onAskAgain: (question: string) => void;
}): ReactElement => {
  const ending = askEnding(ask);
  return (
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
      {ending === null ? null : <p className="text-sm">{ending.words}</p>}
      {ask.refusal_reason === null ? null : (
        <p className="text-xs text-fg-muted">
          <UntrustedText value={ask.refusal_reason} />
        </p>
      )}
      {ending === null ? null : (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            size="sm"
            onClick={() => {
              onAskAgain(ask.question);
            }}
          >
            Ask again
          </Button>
          {ask.run_id === null ? null : (
            <Link to="/runs/$runId" params={{ runId: ask.run_id }} className="text-xs underline">
              Open this ask’s run
            </Link>
          )}
        </div>
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
};

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
  const field = useRef<HTMLTextAreaElement>(null);
  const askAgain = (previous: string): void => {
    setQuestion(previous);
    field.current?.focus();
  };

  return (
    <section className="flex flex-col gap-3">
      <SectionHeading>Ask the task</SectionHeading>
      <p className="text-xs text-fg-muted">
        Answered from this task's own audit trail and artifacts, with links to the runs behind the
        answer.
      </p>
      {/* The form on the card ground (S-25.10b); each answer below is a card of its own. */}
      <form
        className="flex flex-col gap-2 rounded-lg border border-line bg-default p-4"
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
          ref={field}
          id="ask-question"
          className="min-h-20 rounded-md border border-line-input bg-inset px-2 py-1 text-sm"
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
          <Button type="submit" disabled={ask.isPending || question.trim() === ''}>
            Ask
          </Button>
          <span className="text-xs text-fg-muted">
            One question is a short run against this task's own budget.
          </span>
        </div>
      </form>
      {ask.error === null || ask.error === undefined ? null : (
        <ErrorNotice title="That question was refused." error={ask.error} />
      )}
      {asks.isPending ? <Loading label="Loading the thread…" /> : null}
      {asks.error === null || asks.error === undefined ? null : (
        <ErrorNotice title="The thread could not be loaded." error={asks.error} />
      )}
      {asks.data !== undefined && asks.data.items.length === 0 ? (
        <EmptyState
          title="No questions yet"
          hint="Ask why something was decided and the platform answers from what it recorded."
        />
      ) : null}
      {(asks.data?.items ?? []).map((entry) => (
        <AskCard key={entry.id} ask={entry} artifacts={artifacts} onAskAgain={askAgain} />
      ))}
    </section>
  );
};

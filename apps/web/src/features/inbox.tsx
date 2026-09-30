/**
 * The questions inbox (product/10 § "Questions inbox").
 *
 * Everything pending for the signed-in user across every project, answerable in place. product/10
 * is explicit that "all channels are equivalent; first answer wins", so this screen links to the
 * task rather than pretending to be the only way in.
 */
import { Link } from '@tanstack/react-router';
import { type ReactElement, useState } from 'react';
import { useInbox } from '../app/queries.js';
import { useServices } from '../app/services.js';
import { useTopics } from '../realtime/provider.js';
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
import { UntrustedProse } from '../ui/untrusted.js';

/**
 * ` · due …` for a waiting item that has a deadline, nothing for one that has none. Questions and
 * approvals both expire since WP-56 (Q95), so the card of each says when (PROGRESS backlog 166).
 */
const dueSuffix = (deadline: string | null | undefined): string =>
  deadline === null || deadline === undefined ? '' : ` · due ${formatDateTime(deadline)}`;

export const InboxScreen = (): ReactElement => {
  useTopics(['org']);
  const inbox = useInbox();
  const { endpoints } = useServices();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const answer = (taskId: string, questionId: string): void => {
    const text = answers[questionId] ?? '';
    if (text.trim() === '') {
      return;
    }
    setBusy(questionId);
    setFailure(null);
    void endpoints
      .answerQuestion(taskId, questionId, { answer: text })
      .then(async () => {
        await inbox.refetch();
      })
      .catch(() => {
        setFailure(questionId);
      })
      .finally(() => {
        setBusy(null);
      });
  };

  const questions = inbox.data?.questions ?? [];
  const approvals = inbox.data?.approvals ?? [];

  return (
    <div className="flex flex-col gap-4">
      <SectionHeading>Inbox</SectionHeading>
      {/*
        PROGRESS backlog 163's inbox half, closed by decision at WP-95 rather than built: this list
        is what a person can still act on **here** — product/10's card per *pending* question, with
        an answer box — and an expired question or approval can no longer be answered or decided
        (`escalated: []`, `expired: []`). Listing it would be a card whose only control is refused,
        which is the defect 163 was filed about. Its task is `needs_human`, under **Needs human** on
        the board, and the task page lists the expired item beside the retry control the escalation
        brief names (WP-56). What was missing was that anybody said so, and this line is that.
      */}
      <p className="text-xs text-fg-muted" data-inbox-expiry-note="true">
        A question or approval that expires leaves this list: it can no longer be answered or
        decided. Its task waits under Needs human on its project’s board, and the task page is where
        it is retried or cancelled.
      </p>
      {inbox.isPending ? <Loading label="Loading inbox…" /> : null}
      {inbox.isError ? (
        <ErrorNotice title="Inbox could not be loaded." detail={String(inbox.error)} />
      ) : null}
      {inbox.isSuccess && questions.length === 0 && approvals.length === 0 ? (
        <EmptyState
          title="Nothing is waiting for you"
          hint="Questions an agent cannot answer itself, and approvals a maintainer owes, land here — and in the ticket and Slack at the same time. The first answer anywhere wins."
        />
      ) : null}

      {questions.map((question) => (
        <Card key={question.id} className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={question.blocking ? 'warning' : 'neutral'}>
              {question.blocking ? 'blocking' : 'question'}
            </Badge>
            <span className="text-xs text-fg-muted">{question.stage}</span>
            <Link
              to="/tasks/$taskId"
              params={{ taskId: question.task_id }}
              className="text-xs text-accent underline"
            >
              Open task
            </Link>
            <span className="ml-auto text-xs text-fg-muted">
              {formatDateTime(question.asked_at)}
              {dueSuffix(question.deadline_at)}
            </span>
          </div>
          <UntrustedProse value={question.text} />
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              answer(question.task_id, question.id);
            }}
          >
            <input
              aria-label={`Answer question ${question.id}`}
              value={answers[question.id] ?? ''}
              onChange={(event) => {
                setAnswers((current) => ({ ...current, [question.id]: event.target.value }));
              }}
              className="flex-1 rounded-md border border-line bg-surface px-2 py-1 text-sm"
              placeholder="Answer…"
            />
            <Button type="submit" tone="primary" disabled={busy === question.id}>
              Answer
            </Button>
          </form>
          {failure === question.id ? <ErrorNotice title="That answer was refused." /> : null}
        </Card>
      ))}

      {approvals.map((approval) => (
        <Card key={approval.id} className="flex flex-wrap items-center gap-2">
          <Badge tone="accent">{approval.kind}</Badge>
          <span className="text-xs text-fg-muted">{approval.status}</span>
          <Link
            to="/tasks/$taskId"
            params={{ taskId: approval.task_id }}
            className="text-xs text-accent underline"
          >
            Decide on the task
          </Link>
          <span className="ml-auto text-xs text-fg-muted">
            {formatDateTime(approval.requested_at)}
            {dueSuffix(approval.deadline_at)}
          </span>
        </Card>
      ))}
    </div>
  );
};

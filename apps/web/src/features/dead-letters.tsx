/**
 * Dead letters — the events the dispatcher gave up on, and the control that serves one again
 * (WP-95, PROGRESS backlog 126).
 *
 * WP-49 bounded a poisoned event: after `APP_DISPATCH_MAX_ATTEMPTS` failures it leaves the queue,
 * its stream moves on, and the task it names is escalated. What an operator got was a gauge
 * (`event_dispatch_dead_lettered`) that said how many, and a hand-typed `update` in the operator
 * guide to serve one again once the handler is fixed. This section is the list the gauge never had
 * and the re-queue as a product action: one press, one `human_actions` row, and — for an event that
 * names a task — a row that task's own audit shows.
 *
 * ## What a re-queue promises, in the words on the button's card
 *
 * The same event is dispatched again, not a copy; handlers that already succeeded for it are
 * skipped, so their effects are not repeated; and the task the dead letter escalated stays where it
 * is. If the handler still fails, the event is dead-lettered again after the same bound.
 *
 * Everything shown here is text: the error is a handler's message, redacted and bounded by the
 * server and rendered through `UntrustedText` (BD-022); the event type and handler are the
 * platform's own names but are rendered the same way, because a type this build no longer knows
 * is exactly what may be listed. Admin only on the server (`org.dead_letters.manage`); a non-admin
 * sees the refusal named rather than an empty list that would read as "nothing is poisoned".
 */
import type { DeadLetter } from '@platform/contracts';
import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { useDeadLetters, useSettingsCommands } from '../app/queries.js';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  formatDateTime,
  formatInteger,
  Loading,
  SectionHeading,
} from '../ui/kit.js';
import { UntrustedText } from '../ui/untrusted.js';

const DeadLetterCard = ({
  letter,
  pending,
  onRequeue,
}: {
  readonly letter: DeadLetter;
  readonly pending: boolean;
  readonly onRequeue: () => void;
}): ReactElement => (
  <Card className="flex flex-col gap-2">
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <Badge tone="danger">{`event ${letter.position}`}</Badge>
      <span className="font-mono">
        <UntrustedText value={letter.event_type} />
      </span>
      <span className="text-fg-muted">
        on <UntrustedText value={letter.stream_type} /> stream
      </span>
      <span className="ml-auto text-fg-muted">
        dead-lettered {formatDateTime(letter.dead_lettered_at)}
      </span>
    </div>
    <p className="text-xs">
      {letter.handler === null ? (
        <span className="text-fg-muted">The failing handler was not recorded.</span>
      ) : (
        <>
          Handler <UntrustedText className="font-mono" value={letter.handler} /> failed{' '}
          {formatInteger(letter.attempts)} time{letter.attempts === 1 ? '' : 's'}.
        </>
      )}
    </p>
    {letter.error === null ? null : (
      <p className="text-xs">
        <UntrustedText value={letter.error} />
        {letter.error_truncated ? (
          <span className="text-fg-muted"> (cut at the bound; the log has the rest)</span>
        ) : null}
      </p>
    )}
    <p className="text-xs text-fg-muted">
      {letter.task === null ? (
        'It names no task, so nobody was told about it except here and in the gauge.'
      ) : (
        <>
          Its task{' '}
          <Link
            to="/projects/$key/tasks/$taskId"
            params={{ key: letter.task.project_key, taskId: letter.task.id }}
            className="text-accent underline"
          >
            <UntrustedText value={letter.task.ticket_key} />
          </Link>{' '}
          was escalated; a re-queue leaves it where the escalation put it.
        </>
      )}
    </p>
    <div>
      <Button tone="primary" disabled={pending} onClick={onRequeue}>
        Re-queue
      </Button>
    </div>
  </Card>
);

export const DeadLetters = (): ReactElement => {
  const letters = useDeadLetters();
  const commands = useSettingsCommands();
  const items = letters.data?.items ?? [];
  return (
    <section>
      <SectionHeading>Dead letters</SectionHeading>
      <p className="pb-2 text-xs text-fg-muted">
        Events whose handler failed on every attempt, so the dispatcher stopped offering them. Fix
        the handler first: a re-queue dispatches the <strong>same</strong> event again — handlers
        that already succeeded for it are skipped, so nothing they did is repeated — and if it fails
        again it is dead-lettered again after the same number of attempts.
      </p>
      {letters.isPending ? <Loading label="Loading dead letters…" /> : null}
      {letters.isError ? (
        <ErrorNotice
          title="The dead letters could not be loaded."
          detail="Reading them needs the admin role."
        />
      ) : null}
      {letters.isSuccess && items.length === 0 ? (
        <EmptyState
          title="No dead letters"
          hint="Every event the platform appended has been dispatched or is still being retried."
        />
      ) : null}
      {letters.isSuccess && items.length > 0 ? (
        <p className="pb-2 text-xs" data-dead-letter-count="true">
          {items.length === letters.data.total
            ? `${formatInteger(letters.data.total)} dead-lettered event${letters.data.total === 1 ? '' : 's'}.`
            : `The newest ${formatInteger(items.length)} of ${formatInteger(letters.data.total)} dead-lettered events.`}
        </p>
      ) : null}
      {commands.requeueDeadLetter.isError ? (
        <ErrorNotice
          title="That event was not re-queued."
          detail={String(commands.requeueDeadLetter.error)}
        />
      ) : null}
      {commands.requeueDeadLetter.isSuccess ? (
        <p className="pb-2 text-xs" role="status">
          {`Event ${commands.requeueDeadLetter.data.position} is back in the queue.`}
        </p>
      ) : null}
      <div className="flex flex-col gap-2">
        {items.map((letter) => (
          <div key={letter.position} data-dead-letter={String(letter.position)}>
            <DeadLetterCard
              letter={letter}
              pending={commands.requeueDeadLetter.isPending}
              onRequeue={() => {
                commands.requeueDeadLetter.mutate(letter.position);
              }}
            />
          </div>
        ))}
      </div>
    </section>
  );
};

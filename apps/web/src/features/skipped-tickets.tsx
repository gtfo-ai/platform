/**
 * **Why a labelled ticket did not start** (S-28.5, M28 ruling 6): the newest tickets intake did not
 * turn into tasks, each with its reason in words — *Skipped AUT-6676: its status is Released.* —
 * read from `GET /api/projects/:id/skipped-tickets` and shown under the ticket lifecycle's status
 * lists, where the rule that skipped them is set. Nothing is shown while there is none.
 *
 * The key, the link and the status name are provider text (BD-022): the link goes through
 * `ExternalLink` (`safeHref`), the rest through `UntrustedText`.
 */
import type { SkippedTicket } from '@platform/contracts';
import type { ReactElement } from 'react';
import { useSkippedTickets } from '../app/queries.js';
import { ExternalLink, UntrustedText } from '../ui/untrusted.js';
import { sanitiseUntrusted } from '../ui/untrusted-text.js';

/** The reason, in words, after the key. Platform text around the tracker's status name. */
export const skippedReasonWords = (
  skipped: Pick<SkippedTicket, 'reason' | 'status'>,
): { readonly before: string; readonly status: string | null; readonly after: string } =>
  skipped.reason === 'assigned'
    ? {
        before: 'it is assigned to somebody else, and this project does not start such tickets.',
        status: null,
        after: '',
      }
    : skipped.status === null
      ? { before: 'its status is not one work starts from.', status: null, after: '' }
      : {
          before: 'its status is ',
          status: skipped.status,
          after: ', which is not a status work starts from (or means it is finished).',
        };

export const SkippedTickets = ({
  projectId,
}: {
  readonly projectId: string;
}): ReactElement | null => {
  const skipped = useSkippedTickets(projectId);
  const items = skipped.data?.items ?? [];
  if (items.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-col gap-1" data-lifecycle="skipped-tickets">
      <p className="text-sm font-medium">Tickets not started</p>
      <p className="text-xs text-fg-muted">
        These tickets matched the pick-up rule but did not become tasks. Move one to a status work
        starts from (or change the statuses above) and it is picked up again.
      </p>
      <ul className="flex flex-col gap-0.5 text-xs">
        {items.map((item) => {
          const words = skippedReasonWords(item);
          return (
            <li key={`${item.ticket.key}:${item.skipped_at}`} data-skipped-ticket={item.ticket.key}>
              Skipped{' '}
              <ExternalLink url={item.ticket.url} label={sanitiseUntrusted(item.ticket.key)} />:{' '}
              {words.before}
              {words.status === null ? null : <UntrustedText value={words.status} />}
              {words.after} <span className="text-fg-muted">({item.skipped_at.slice(0, 10)})</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

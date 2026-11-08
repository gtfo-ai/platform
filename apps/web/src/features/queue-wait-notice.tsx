/**
 * **Why a queued task has not started, and what frees it** (S-25.16): the task page's callout slot
 * for a `queued` task — the long form of `./queue-words.ts` over the read's `queue_wait`, the tasks
 * holding the places as links (each with its state's word, the ones waiting for a person first),
 * and *Change the limit* — the project's *Rules & limits* settings — only for a reader who may
 * change it (`can_change_limits`, the configuration write's own permission).
 *
 * Neutral information (`tone="info"`), never *Needs you*: nothing on this task is the reader's to
 * do. What frees it is on the tasks it lists, and their own pages ask for it. Every link is a
 * secondary one; the page's amber primary is never here.
 */
import type { QueueWait } from '@platform/contracts';
import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { Flash } from '../ui/flash.js';
import { TASK_STATE_LABEL } from '../ui/humanize.js';
import { UntrustedText } from '../ui/untrusted.js';
import { queueSentence } from './queue-words.js';

export const QueueWaitNotice = ({
  wait,
  ticketKey,
  projectKey,
  canChangeLimits,
  mayDecide,
}: {
  readonly wait: QueueWait;
  /** The task's own ticket key — provider text (BD-022). */
  readonly ticketKey: string;
  /** The board's key, when the projects read has it: *Change the limit* links there. */
  readonly projectKey: string | null;
  readonly canChangeLimits: boolean;
  /** Whether the reader may decide or cancel the holders (`can_cancel`): they then wait for *you*. */
  readonly mayDecide: boolean;
}): ReactElement => {
  const holders = wait.status === 'waiting' ? wait.holders : null;
  const more = holders === null ? 0 : holders.total - holders.items.length;
  return (
    <section aria-label="What happens next" data-testid="queue-wait-notice">
      <Flash tone="info">
        <div className="flex flex-col gap-2" data-queue-wait={wait.status}>
          <p data-queue-sentence="">
            {/* Platform words around the ticket key, which is the provider's text. */}
            <UntrustedText value={queueSentence(wait, ticketKey, mayDecide)} />
          </p>
          {holders === null || holders.items.length === 0 ? null : (
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium">Holding the places:</p>
              <ul className="flex flex-col gap-0.5 text-sm" data-queue-holders="">
                {holders.items.map((holder) => (
                  <li key={holder.task_id} data-queue-holder={holder.state}>
                    <Link
                      to="/tasks/$taskId"
                      params={{ taskId: holder.task_id }}
                      className="text-link underline"
                    >
                      <UntrustedText value={holder.ticket_key} />
                    </Link>
                    <span className="text-fg-muted">{` · ${TASK_STATE_LABEL[holder.state]}`}</span>
                  </li>
                ))}
                {more <= 0 ? null : (
                  <li className="text-fg-muted" data-queue-more="">{`and ${more} more`}</li>
                )}
              </ul>
            </div>
          )}
          {!canChangeLimits || projectKey === null || wait.status === 'admitted' ? null : (
            <p className="text-sm">
              <Link
                to="/projects/$key/settings/$section"
                params={{ key: projectKey, section: 'policies' }}
                className="text-link underline"
                data-queue-change-limit=""
              >
                Change the limit
              </Link>
            </p>
          )}
        </div>
      </Flash>
    </section>
  );
};

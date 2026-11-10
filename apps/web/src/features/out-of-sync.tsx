/**
 * **A ticket or a merge request out of sync, said on the task page** (S-28.10, TD-029's amendment
 * C (2)–(3)). AUT-6655 left Jira at *Ready for Merge* beside a **Draft** merge request after twenty
 * failed moves, and the page said nothing. The task read's `provider_sync` names each subject that
 * is out of sync, and this box says it in the product's words:
 *
 * - *Ticket status out of sync: Jira still says Ready for Merge; the platform wanted In Progress —
 *   Jira offers no such move from there (it offers: Released).* with the tracker's reason, **Retry**
 *   (the same lifecycle move, again) and **Open in Jira**;
 * - *The merge request is still a draft on GitLab* after the platform marked it ready, with the
 *   merge request's link — what the Ready callout's *ready to merge* must not hide;
 * - *GitLab will not merge this yet: 2 threads are unresolved* (S-28.13, M28 ruling R3b (3)) — the
 *   task is at Ready and the provider says it cannot be merged as it stands, with what to do and
 *   the merge request's link. It clears itself once a later check reads it mergeable.
 *
 * Information with an action, never *Needs you* on its own: the stage runs regardless (TD-029
 * decision 4). Every provider value — the statuses, the reason — is untrusted text (BD-022).
 */
import type { ProviderSync, TaskDetailResponse } from '@platform/contracts';
import type { ReactElement } from 'react';
import type { useTaskCommands } from '../app/queries.js';
import { Flash } from '../ui/flash.js';
import { Button, ErrorNotice } from '../ui/kit.js';
import { ExternalLink, UntrustedText } from '../ui/untrusted.js';
import { mergeBlockedNext, mergeBlockedWhy } from '../ui/words/merge-blockers.js';
import { trackerName } from '../ui/words/trackers.js';
import { providerName } from './gate-wait.js';

/** The lifecycle moment a slot names, mid-sentence. */
const SLOT_MOMENT: Readonly<Record<string, string>> = {
  in_progress: 'when work starts',
  in_review: 'when the code review starts',
  approved: 'when the agent’s review approves',
  qa: 'when the task enters QA',
  ready_for_merge: 'when the task is ready to merge',
  done: 'when the merge request is merged',
  pick_up_from: 'when the task is sent back',
};

/** "A, B and C". */
const listWords = (items: readonly string[]): string =>
  items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

const sameStatus = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/** The plain sentence for a ticket-status record — exported for the test and the Checks rail. */
export const ticketOutOfSyncSentence = (row: ProviderSync, provider: string): string => {
  const tracker = trackerName(provider);
  const moment = row.slot === null ? null : (SLOT_MOMENT[row.slot] ?? null);
  const where =
    row.observed === null
      ? `${tracker} could not be read afterwards`
      : `${tracker} still says ${row.observed}`;
  const offered =
    row.available === null
      ? ''
      : row.available.some((status) => sameStatus(status, row.target))
        ? ''
        : row.available.length === 0
          ? ` — ${tracker} offers no move from there`
          : ` — ${tracker} offers no such move from there (it offers: ${listWords(row.available)})`;
  return (
    `Ticket status out of sync: ${where}; the platform wanted ${row.target}` +
    `${moment === null ? '' : ` (${moment})`}${offered}.`
  );
};

/** The plain sentence for a merge request still a draft after it was marked ready. */
export const mergeRequestStillDraftSentence = (provider: string | null | undefined): string =>
  `The merge request is still a draft on ${providerName(provider)}: the platform marked it ready, and it read back as a draft, so it cannot be merged as it is. Mark it ready there; the platform checks it again.`;

/**
 * The Ready callout's sentence (S-28.10): the merge request's real state, why it cannot be merged
 * and what the platform is doing about it.
 */
export const readyStillDraftSentence = (provider: string | null | undefined): string =>
  `The merge request is still a draft on ${providerName(provider)} — it cannot be merged yet. The platform marked it ready and it read back as a draft; it tries again, and if it is still a draft when those tries are spent the task comes to you. Mark it ready there and the task is ready to merge.`;

/**
 * The plain sentence for a merge request the provider will not merge yet (S-28.13): what (it will
 * not merge it), why (the reason, in words), and what to do next.
 */
export const mergeRequestBlockedSentence = (
  row: Pick<ProviderSync, 'reason_code' | 'observed' | 'unresolved_threads'>,
  provider: string | null | undefined,
): string =>
  `${capitalised(providerName(provider))} will not merge this yet: ${mergeBlockedWhy(
    row.reason_code,
    row.observed,
    row.unresolved_threads ?? null,
  )}. ${mergeBlockedNext(row.reason_code)}`;

const capitalised = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

export const OutOfSyncNotice = ({
  detail,
  commands,
}: {
  readonly detail: TaskDetailResponse;
  readonly commands: Pick<ReturnType<typeof useTaskCommands>, 'retryTicketSync'>;
}): ReactElement | null => {
  // At Ready the callout itself says the merge request's draft state (`./task-callout.tsx`), and
  // a "will not merge: it is a draft" beside it would say the same thing twice (S-28.13).
  const all = detail.provider_sync ?? [];
  const stillDraft = all.some((row) => row.subject === 'merge_request_draft');
  const rows = all.filter(
    (row) =>
      !(row.subject === 'merge_request_draft' && detail.task.state === 'ready_for_merge') &&
      !(row.subject === 'merge_request_blocked' && row.reason_code === 'draft' && stillDraft),
  );
  if (rows.length === 0) {
    return null;
  }
  const { task } = detail;
  const tracker = trackerName(task.ticket.provider);
  return (
    <section aria-label="Out of sync" data-testid="out-of-sync">
      {rows.map((row) =>
        row.subject === 'ticket_status' ? (
          <Flash key={row.subject} tone="warning" title="The ticket’s status is out of sync">
            <div className="flex flex-col gap-2 pt-1">
              <p data-out-of-sync="ticket_status">
                {/* Provider text inside the platform's sentence (BD-022). */}
                <UntrustedText value={ticketOutOfSyncSentence(row, task.ticket.provider)} />
              </p>
              <p data-out-of-sync-reason="">
                {`Why ${tracker} refused (${row.attempts === 1 ? 'once' : `${row.attempts} times`}): `}
                <UntrustedText value={row.reason} />
              </p>
              <p className="text-sm text-fg-muted">
                The task carries on regardless. Retry asks {tracker} again; a later move that goes
                through clears this.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {detail.can_resume ? (
                  <Button
                    data-out-of-sync-action="retry"
                    disabled={commands.retryTicketSync.isPending}
                    onClick={() => {
                      commands.retryTicketSync.mutate();
                    }}
                  >
                    Retry
                  </Button>
                ) : null}
                <ExternalLink url={task.ticket.url} label={`Open in ${tracker}`} />
              </div>
              {commands.retryTicketSync.isError ? (
                <ErrorNotice
                  title="The retry was not sent."
                  error={commands.retryTicketSync.error}
                />
              ) : null}
            </div>
          </Flash>
        ) : row.subject === 'merge_request_blocked' ? (
          <Flash
            key={row.subject}
            tone="warning"
            title={`${capitalised(providerName(task.mr_ref?.provider))} will not merge this yet`}
          >
            <div className="flex flex-col gap-2 pt-1">
              <p data-out-of-sync="merge_request_blocked">
                {mergeRequestBlockedSentence(row, task.mr_ref?.provider)}
              </p>
              {task.mr_ref === null || task.mr_ref === undefined ? null : (
                <div>
                  <ExternalLink
                    url={task.mr_ref.url}
                    label={`Open the merge request on ${providerName(task.mr_ref.provider)}`}
                  />
                </div>
              )}
            </div>
          </Flash>
        ) : (
          <Flash key={row.subject} tone="warning" title="The merge request is still a draft">
            <div className="flex flex-col gap-2 pt-1">
              <p data-out-of-sync="merge_request_draft">
                {mergeRequestStillDraftSentence(task.mr_ref?.provider)}
              </p>
              {task.mr_ref === null || task.mr_ref === undefined ? null : (
                <div>
                  <ExternalLink
                    url={task.mr_ref.url}
                    label={`Open the merge request on ${providerName(task.mr_ref.provider)}`}
                  />
                </div>
              )}
            </div>
          </Flash>
        ),
      )}
    </section>
  );
};

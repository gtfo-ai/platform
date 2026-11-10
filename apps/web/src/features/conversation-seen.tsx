/**
 * **A comment is not a change request unless it says so** (S-28.2, M28 ruling R1): what the task
 * page says about a person's word at QA or Ready that the platform read and did **not** treat as a
 * change request — a ticket comment, a general merge-request note that cannot be resolved, or a
 * thread note written before the ticket moved forward.
 *
 * *"Petr commented on the ticket 5 m ago — not treated as a change request."* with **Open** (the
 * ticket or the merge request, where the word is) and **Send back to Implementation…** (the return
 * dialog, with Implementation picked), for a reader who may return the task. The second sentence
 * says what does send a task back, so nobody waits for a comment to do it.
 *
 * Information, never *Needs you*: the platform did not stop; the person decides. Every provider
 * string — the author's name and the URLs — is untrusted (BD-022): the name is a text node
 * (`UntrustedText`) and each URL goes through `safeHref` inside {@link ExternalLink}.
 */
import type { TaskConversationSeen } from '@platform/contracts';
import type { ReactElement } from 'react';
import { Flash } from '../ui/flash.js';
import { Button } from '../ui/kit.js';
import { formatAgo } from '../ui/relative-time.js';
import { ExternalLink, UntrustedText } from '../ui/untrusted.js';

/** Where the word was written, in the sentence's words. */
const WHERE: Readonly<Record<TaskConversationSeen['source'], string>> = {
  ticket_comment: 'commented on the ticket',
  mr_note: 'wrote a note on the merge request',
  mr_thread: 'wrote in a review thread before the ticket moved on',
};

/** What sends a task back, in one sentence — the three explicit signals (M28 ruling R1). */
export const SEND_BACK_RULE =
  'Only an open review thread on the merge request, moving the ticket to a status that sends it back, or the button here returns the task to Implementation.';

export const ConversationSeenNotice = ({
  seen,
  ticketUrl,
  mergeRequestUrl,
  maySendBack,
  nowMs,
  onSendBack,
}: {
  readonly seen: readonly TaskConversationSeen[];
  /** The task's ticket URL — provider text. */
  readonly ticketUrl: string | null;
  /** The task's merge request URL, when it has one — provider text. */
  readonly mergeRequestUrl: string | null;
  /** Whether the reader may return the task (`can_return`, and the task is not merged). */
  readonly maySendBack: boolean;
  readonly nowMs: number;
  /** Opens the return dialog with Implementation picked. */
  readonly onSendBack: () => void;
}): ReactElement | null => {
  if (seen.length === 0) {
    return null;
  }
  return (
    <section aria-label="Comments not treated as change requests" data-testid="conversation-seen">
      <Flash tone="info">
        <div className="flex flex-col gap-2">
          <ul className="flex flex-col gap-1">
            {seen.map((word) => {
              const url = word.source === 'ticket_comment' ? ticketUrl : mergeRequestUrl;
              const ago = word.written_at === null ? null : formatAgo(word.written_at, nowMs);
              return (
                <li
                  key={`${word.source}:${word.seen_at}:${word.written_at ?? ''}`}
                  data-conversation-seen={word.source}
                  className="flex flex-wrap items-baseline gap-x-2"
                >
                  <span>
                    {word.author === null ? 'A person' : <UntrustedText value={word.author} />}{' '}
                    {WHERE[word.source]}
                    {ago === null ? '' : ` ${ago}`} — not treated as a change request.
                  </span>
                  {url === null ? null : (
                    <ExternalLink url={url} label="Open" className="text-link underline" />
                  )}
                </li>
              );
            })}
          </ul>
          <p className="text-sm" data-conversation-seen-rule="">
            {SEND_BACK_RULE}
          </p>
          {maySendBack ? (
            <div>
              <Button data-conversation-seen-action="send-back" onClick={onSendBack}>
                Send back to Implementation…
              </Button>
            </div>
          ) : null}
        </div>
      </Flash>
    </section>
  );
};

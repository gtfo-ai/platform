/**
 * **A comment is not a change request unless it says so** (S-28.2, M28 ruling R1): the task page's
 * notice about a person's word at QA or Ready that did not send the task back — who, where and
 * when, *not treated as a change request*, the rule that does send a task back, **Open** (the
 * ticket or the merge request) and **Send back to Implementation…** for a reader who may. Over the
 * task read's own `taskConversationSeenSchema` shape; the author is a text node and every URL goes
 * through `safeHref`.
 */
import { type TaskConversationSeen, taskConversationSeenSchema } from '@platform/contracts';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationSeenNotice, SEND_BACK_RULE } from './conversation-seen.js';

const NOW = Date.parse('2026-11-10T11:00:00.000Z');
const TICKET_URL = 'https://jira.example.invalid/browse/AUT-1';
const MR_URL = 'https://git.example.invalid/acme/api/-/merge_requests/2768';
const HOSTILE = '<img src=x onerror=alert(1)>';

/** A row as the server publishes it — parsed, so a fixture the contract refuses fails here. */
const seen = (over: Partial<TaskConversationSeen> = {}): TaskConversationSeen =>
  taskConversationSeenSchema.parse({
    source: 'ticket_comment',
    author: 'Petr',
    written_at: '2026-11-10T10:43:00.000Z',
    seen_at: '2026-11-10T10:45:30.000Z',
    ...over,
  });

const renderNotice = (
  rows: readonly TaskConversationSeen[],
  options: { maySendBack?: boolean; onSendBack?: () => void } = {},
) =>
  render(
    <ConversationSeenNotice
      seen={rows}
      ticketUrl={TICKET_URL}
      mergeRequestUrl={MR_URL}
      maySendBack={options.maySendBack ?? true}
      nowMs={NOW}
      onSendBack={options.onSendBack ?? (() => {})}
    />,
  );

afterEach(() => {
  cleanup();
});

describe('the commented — not treated as a change request notice (M28 R1)', () => {
  it('says who commented where and when, that it is not a change request, and what sends a task back', () => {
    renderNotice([seen()]);
    const item = document.querySelector('[data-conversation-seen="ticket_comment"]');
    expect(item?.textContent).toContain(
      'Petr commented on the ticket 17 m ago — not treated as a change request.',
    );
    expect(screen.getByText(SEND_BACK_RULE)).toBeTruthy();
  });

  it('offers Open on the ticket for a ticket comment, and on the merge request for a note', () => {
    renderNotice([seen(), seen({ source: 'mr_note', author: 'Dana' })]);
    const links = screen.getAllByRole('link', { name: 'Open' });
    expect(links.map((link) => link.getAttribute('href'))).toEqual([TICKET_URL, MR_URL]);
    expect(document.querySelector('[data-conversation-seen="mr_note"]')?.textContent).toContain(
      'Dana wrote a note on the merge request',
    );
  });

  it('opens the send-back with one press, and offers no button to a reader who may not return the task', () => {
    const onSendBack = vi.fn();
    renderNotice([seen()], { onSendBack });
    fireEvent.click(screen.getByRole('button', { name: 'Send back to Implementation…' }));
    expect(onSendBack).toHaveBeenCalledTimes(1);
    cleanup();
    renderNotice([seen()], { maySendBack: false });
    expect(screen.queryByRole('button', { name: 'Send back to Implementation…' })).toBeNull();
    // The words and Open stay: the reader still learns what happened.
    expect(screen.getByRole('link', { name: 'Open' })).toBeTruthy();
  });

  it('renders an author as text, never markup, and names nobody it does not know', () => {
    renderNotice([seen({ author: HOSTILE }), seen({ author: null, written_at: null })]);
    expect(document.querySelector('img')).toBeNull();
    const items = document.querySelectorAll('[data-conversation-seen]');
    expect(items[0]?.textContent).toContain(HOSTILE);
    expect(items[1]?.textContent).toContain(
      'A person commented on the ticket — not treated as a change request.',
    );
  });

  it('renders nothing when nothing was seen', () => {
    const { container } = renderNotice([]);
    expect(container.textContent).toBe('');
  });
});

/**
 * The inbox's cards say when a waiting item expires (PROGRESS backlog 166, WP-73).
 *
 * Both a question and an approval carry `deadline_at` since WP-56 (Q95), and until WP-73 only the
 * question's card printed it. Each card is driven with a deadline and without one, both directions
 * (standing rule 42): a card that printed nothing would pass the null case, and a card that printed
 * `due Invalid Date` for `null` would pass the present one.
 */
import type { InboxResponse } from '@platform/contracts';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';
import { formatDateTime } from '../ui/kit.js';

const TASK = '00000000-0000-4000-8000-0000000000c1';
const DUE = '2026-09-30T15:00:00.000Z';

const SESSION: SessionResponse = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'operator@example.invalid',
    name: 'Fake Operator',
    role: 'admin',
  },
  session: { id: '00000000-0000-4000-8000-000000000002' },
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let inbox: InboxResponse;

const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
  const url = String(input);
  if (url.includes('/api/auth/get-session')) return json(SESSION);
  if (url.endsWith('/api/org/inbox')) return json(inbox);
  if (url.endsWith('/api/projects')) return json({ items: [] });
  return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
}) as typeof fetch;

const approval = (deadline: string | null): InboxResponse['approvals'][number] => ({
  id: '00000000-0000-4000-8000-0000000000a1',
  task_id: TASK,
  kind: 'plan',
  status: 'pending',
  requested_at: '2026-09-29T09:00:00.000Z',
  deadline_at: deadline,
  decided_by_user_id: null,
  decided_at: null,
  reason: null,
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  window.history.pushState({}, '', '/inbox');
});

const renderInbox = async (): Promise<HTMLElement> => {
  const { container } = render(createApp({ fetchImpl, realtime: false }).element);
  await screen.findByText('Decide on the task');
  return container;
};

describe('the approval card', () => {
  it('prints the approval’s due time, as the question card does', async () => {
    inbox = { questions: [], approvals: [approval(DUE)] };
    const container = await renderInbox();
    expect(container.textContent).toContain(`· due ${formatDateTime(DUE)}`);
  });

  it('prints no due time for an approval that has none', async () => {
    inbox = { questions: [], approvals: [approval(null)] };
    const container = await renderInbox();
    expect(container.textContent).toContain(formatDateTime('2026-09-29T09:00:00.000Z'));
    expect(container.textContent).not.toContain(' · due ');
  });
});

/**
 * PROGRESS backlog 163's inbox half, closed by decision at WP-95: an expired question or approval
 * leaves the inbox (`listInbox` serves `open` and `pending` only), and the screen says where it went
 * — on a full inbox and on an empty one, because the person who needs the sentence is the one whose
 * card just disappeared.
 */
describe('what the inbox says about an item that expired', () => {
  it('says an expired item leaves the list and names where its task is retried', async () => {
    inbox = { questions: [], approvals: [approval(DUE)] };
    const container = await renderInbox();
    const note = container.querySelector('[data-inbox-expiry-note]');
    expect(note?.textContent).toContain('expires leaves this list');
    expect(note?.textContent).toContain('Needs human');
    expect(note?.textContent).toContain('task page');
  });

  it('says it on an empty inbox too', async () => {
    inbox = { questions: [], approvals: [] };
    const { container } = render(createApp({ fetchImpl, realtime: false }).element);
    await screen.findByText('Nothing is waiting for you');
    expect(container.querySelector('[data-inbox-expiry-note]')).not.toBeNull();
  });
});

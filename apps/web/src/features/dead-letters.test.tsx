/**
 * The dead-letter section of the organisation settings page (WP-95, PROGRESS backlog 126).
 *
 * Driven through `createApp` with a fake server, so the real router, query client and endpoint
 * parsers are asserted: the screen **calls** `GET /api/org/dead-letters` and `POST
 * /api/org/dead-letters/:position/requeue` — the list the gauge never had and the re-queue the
 * operator guide used to spell as a hand-typed `update` — renders a handler's error as text
 * (BD-022), states the page against the total rather than as the total (standing rule 16), and
 * names a non-admin's refusal instead of drawing an empty list.
 */
import type { DeadLetter, DeadLettersResponse } from '@platform/contracts';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';

const SESSION: SessionResponse = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'operator@example.invalid',
    name: 'Fake Operator',
    role: 'admin',
  },
  session: { id: '00000000-0000-4000-8000-000000000002' },
};

const HOSTILE_ERROR =
  'provider said <script>window.__pwned=1</script> and [REDACTED:pattern:token]';

const letter = (overrides: Partial<DeadLetter>): DeadLetter => ({
  position: 4101,
  event_type: 'task.stage.completed',
  stream_type: 'task',
  stream_id: '00000000-0000-4000-8000-0000000000f1',
  occurred_at: '2026-09-29T08:00:00.000Z',
  dead_lettered_at: '2026-09-29T08:20:00.000Z',
  handler: 'pipeline.saga',
  attempts: 10,
  error: HOSTILE_ERROR,
  error_truncated: false,
  task: {
    id: '00000000-0000-4000-8000-0000000000f1',
    ticket_key: 'ACME-7',
    project_key: 'acme',
  },
  ...overrides,
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Sent {
  readonly url: string;
  readonly key: string | null;
}

const fetchFor = (list: DeadLettersResponse | 'forbidden') => {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes('/api/auth/get-session')) return json(SESSION);
    if (url.includes('/api/org/dead-letters/') && init?.method === 'POST') {
      sent.push({ url, key: new Headers(init.headers).get('Idempotency-Key') });
      return json({ position: 4101, performed: true, requeued_at: '2026-09-30T09:00:00.000Z' });
    }
    if (url.includes('/api/org/dead-letters')) {
      return list === 'forbidden'
        ? json(
            { error: { code: 'forbidden', message: 'org.dead_letters.manage needs admin' } },
            403,
          )
        : json(list);
    }
    if (url.endsWith('/api/org/users')) return json({ items: [] });
    if (url.endsWith('/api/org/budgets')) return json({ items: [] });
    if (url.endsWith('/api/org/identities')) return json({ items: [] });
    if (url.endsWith('/api/org/identities/candidates')) return json({ items: [] });
    if (url.endsWith('/api/version')) {
      return json({ version: '0.0.0-dev', commit: null, built_at: null });
    }
    if (url.endsWith('/api/projects')) return json({ items: [] });
    return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
  }) as typeof fetch;
  return { sent, fetchImpl };
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  window.history.pushState({}, '', '/settings');
});

describe('dead letters on the settings page', () => {
  it('lists each dead letter with its handler, its error as text and its task', async () => {
    const { fetchImpl } = fetchFor({
      items: [letter({}), letter({ position: 4099, task: null, handler: null, error: null })],
      total: 2,
      next_cursor: null,
    });
    const { container } = render(createApp({ fetchImpl, realtime: false }).element);
    await waitFor(() => {
      expect(container.querySelector('[data-dead-letter="4101"]')).not.toBeNull();
    });
    const first = container.querySelector('[data-dead-letter="4101"]')?.textContent ?? '';
    expect(first).toContain('task.stage.completed');
    expect(first).toContain('pipeline.saga');
    expect(first).toContain('10 times');
    expect(first).toContain(HOSTILE_ERROR);
    expect(first).toContain('ACME-7');
    expect(container.querySelector('script')).toBeNull();
    // The event that names no task says so: the population with no brief anywhere else.
    const second = container.querySelector('[data-dead-letter="4099"]')?.textContent ?? '';
    expect(second).toContain('names no task');
    expect(second).toContain('not recorded');
    expect(container.querySelector('[data-dead-letter-count]')?.textContent).toBe(
      '2 dead-lettered events.',
    );
  });

  it('states a page as the newest N of the total, never as the total', async () => {
    const { fetchImpl } = fetchFor({ items: [letter({})], total: 73, next_cursor: '4101' });
    const { container } = render(createApp({ fetchImpl, realtime: false }).element);
    await waitFor(() => {
      expect(container.querySelector('[data-dead-letter-count]')?.textContent).toBe(
        'The newest 1 of 73 dead-lettered events.',
      );
    });
  });

  it('re-queues through POST …/requeue, carrying an Idempotency-Key', async () => {
    const { sent, fetchImpl } = fetchFor({ items: [letter({})], total: 1, next_cursor: null });
    render(createApp({ fetchImpl, realtime: false }).element);
    const button = await screen.findByRole('button', { name: 'Re-queue' });
    const user = userEvent.setup();
    await user.click(button);
    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]?.url).toContain('/api/org/dead-letters/4101/requeue');
    expect(sent[0]?.key).toMatch(/^[A-Za-z0-9._:-]+$/);
    expect(await screen.findByText('Event 4101 is back in the queue.')).toBeTruthy();
  });

  it('names a non-admin’s refusal rather than drawing "no dead letters"', async () => {
    const { fetchImpl } = fetchFor('forbidden');
    const { container } = render(createApp({ fetchImpl, realtime: false }).element);
    expect(await screen.findByText('The dead letters could not be loaded.')).toBeTruthy();
    expect(container.textContent).not.toContain('No dead letters');
    expect(container.textContent).toContain('Reading them needs the admin role.');
  });

  /**
   * WP-114, PROGRESS backlog 327: a `503 dead_letters_unavailable` — a process that composed no
   * eventing — is shown to the administrator as what it is, never as a permission problem.
   */
  it('does not name a 503 a permission problem', async () => {
    const { fetchImpl: base } = fetchFor('forbidden');
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes('/api/org/dead-letters')
        ? json(
            {
              error: {
                code: 'dead_letters_unavailable',
                message: 'this process composed no event dispatch, so it cannot read dead letters',
              },
            },
            503,
          )
        : base(input, init)) as typeof fetch;
    const { container } = render(createApp({ fetchImpl, realtime: false }).element);
    expect(await screen.findByText('The dead letters could not be loaded.')).toBeTruthy();
    expect(container.textContent).not.toContain('Reading them needs the admin role.');
    expect(container.textContent).toContain('composed no event dispatch');
  });

  /**
   * WP-114, PROGRESS backlog 324: a total above one page reaches its last row — *Show older* sends
   * the server's `next_cursor` back unchanged until it answers `null`.
   */
  it('reaches the last row of a total above one page through Show older', async () => {
    const asked: string[] = [];
    const pages: Record<string, DeadLettersResponse> = {
      '(first)': {
        items: [letter({ position: 4103 }), letter({ position: 4102 })],
        total: 4,
        next_cursor: '4102',
      },
      '4102': {
        items: [letter({ position: 4101 })],
        total: 4,
        next_cursor: '4101',
      },
      '4101': { items: [letter({ position: 4100 })], total: 4, next_cursor: null },
    };
    const { fetchImpl: base } = fetchFor('forbidden');
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'https://agentic.example.test');
      if (url.pathname === '/api/org/dead-letters') {
        const cursor = url.searchParams.get('cursor') ?? '(first)';
        asked.push(cursor);
        return json(pages[cursor]);
      }
      return base(input, init);
    }) as typeof fetch;
    const { container } = render(createApp({ fetchImpl, realtime: false }).element);
    await waitFor(() => {
      expect(container.querySelector('[data-dead-letter-count]')?.textContent).toBe(
        'The newest 2 of 4 dead-lettered events.',
      );
    });
    const user = userEvent.setup();
    const showOlder = () =>
      screen
        .queryAllByRole('button', { name: 'Show older' })
        .filter((button) => button.closest('section')?.textContent?.includes('Dead letters'));
    for (const position of [4101, 4100]) {
      const [button] = showOlder();
      expect(button, `Show older before ${position}`).toBeDefined();
      await user.click(button as HTMLElement);
      await waitFor(() => {
        expect(container.querySelector(`[data-dead-letter="${position}"]`)).not.toBeNull();
      });
    }
    expect(asked).toEqual(['(first)', '4102', '4101']);
    expect(container.querySelector('[data-dead-letter-count]')?.textContent).toBe(
      '4 dead-lettered events.',
    );
    expect(showOlder()).toHaveLength(0);
  });
});

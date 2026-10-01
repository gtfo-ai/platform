/**
 * The failed-jobs section of the organisation settings page (WP-108, PROGRESS backlog 325).
 *
 * Driven through `createApp` with a fake server, so the real router, query client and endpoint
 * parser are asserted: the screen **calls** `GET /api/org/failed-jobs`, renders a failure's message
 * as text (BD-022), says what the queue's failure drops and what recovers it, states a page against
 * the total (standing rule 16), offers no re-queue, and names a refusal by its status.
 */
import type { FailedJob, FailedJobsResponse } from '@platform/contracts';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

const job = (overrides: Partial<FailedJob>): FailedJob => ({
  id: '00000000-0000-4000-8000-0000000000a1',
  queue: 'pipeline.outbound',
  attempts: 3,
  retry_limit: 2,
  created_at: '2026-09-30T08:00:00.000Z',
  failed_at: '2026-09-30T08:48:00.000Z',
  error: HOSTILE_ERROR,
  error_truncated: false,
  exhaustion: {
    kind: 'relies_on_retries',
    loss: 'one provider call the pipeline decided on',
    recovered_by: null,
  },
  ...overrides,
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fetchFor = (list: FailedJobsResponse | number) =>
  (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.includes('/api/auth/get-session')) return json(SESSION);
    if (url.includes('/api/org/failed-jobs')) {
      return typeof list === 'number'
        ? json(
            {
              error: {
                code: list === 403 ? 'forbidden' : 'failed_jobs_unavailable',
                message: 'no',
              },
            },
            list,
          )
        : json(list);
    }
    if (url.includes('/api/org/dead-letters'))
      return json({ items: [], total: 0, next_cursor: null });
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  window.history.pushState({}, '', '/settings');
});

describe('failed jobs on the settings page (WP-108)', () => {
  it('lists each failed job with its queue, its attempts, its error as text and what recovers it', async () => {
    const fetchImpl = fetchFor({
      items: [
        job({}),
        job({
          id: '00000000-0000-4000-8000-0000000000a2',
          queue: 'deadline.sweep',
          error: null,
          exhaustion: {
            kind: 'relies_on_retries',
            loss: 'one expiry or reminder',
            recovered_by: 'deadline, deadline_reminder',
          },
        }),
        job({ id: '00000000-0000-4000-8000-0000000000a3', queue: 'gone.queue', exhaustion: null }),
      ],
      total: 3,
      next_cursor: null,
    });
    const { container } = render(createApp({ fetchImpl, realtime: false }).element);
    await waitFor(() => {
      expect(
        container.querySelector('[data-failed-job="00000000-0000-4000-8000-0000000000a1"]'),
      ).not.toBeNull();
    });
    const first =
      container.querySelector('[data-failed-job="00000000-0000-4000-8000-0000000000a1"]')
        ?.textContent ?? '';
    expect(first).toContain('pipeline.outbound');
    expect(first).toContain('tried 3 times');
    expect(first).toContain(HOSTILE_ERROR);
    expect(first).toContain('one provider call the pipeline decided on');
    expect(first).toContain('Nothing recovers it automatically');
    expect(container.querySelector('script')).toBeNull();
    const second =
      container.querySelector('[data-failed-job="00000000-0000-4000-8000-0000000000a2"]')
        ?.textContent ?? '';
    expect(second).toContain('recorded no message');
    expect(second).toContain(
      'Recovered by the platform’s recovery pass: deadline, deadline_reminder.',
    );
    const third =
      container.querySelector('[data-failed-job="00000000-0000-4000-8000-0000000000a3"]')
        ?.textContent ?? '';
    expect(third).toContain('does not declare that queue');
    expect(container.querySelector('[data-failed-job-count]')?.textContent).toBe('3 failed jobs.');
    // A read: nothing here re-queues a job.
    expect(screen.queryAllByRole('button', { name: /re-?queue/i })).toHaveLength(0);
  });

  it('states a page as the newest N of the total, never as the total', async () => {
    const fetchImpl = fetchFor({ items: [job({})], total: 140, next_cursor: 'older-page' });
    const { container } = render(createApp({ fetchImpl, realtime: false }).element);
    await waitFor(() => {
      expect(container.querySelector('[data-failed-job-count]')?.textContent).toBe(
        'The newest 1 of 140 failed jobs.',
      );
    });
  });

  /**
   * WP-114, PROGRESS backlog 324: a total above one page reaches its last row through *Show older*,
   * which sends back the server's opaque `next_cursor` unchanged.
   */
  it('reaches the last row of a total above one page through Show older', async () => {
    const asked: string[] = [];
    const ids = ['a1', 'a2', 'a3'].map((suffix) => `00000000-0000-4000-8000-0000000000${suffix}`);
    const base = fetchFor(403);
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'https://agentic.example.test');
      if (url.pathname === '/api/org/failed-jobs') {
        const cursor = url.searchParams.get('cursor');
        asked.push(cursor ?? '(first)');
        return cursor === null
          ? json({
              items: [job({ id: ids[0] as string }), job({ id: ids[1] as string })],
              total: 3,
              next_cursor: '2026-09-30T08:48:00.000001Z_page-2',
            })
          : json({ items: [job({ id: ids[2] as string })], total: 3, next_cursor: null });
      }
      return base(input, init);
    }) as typeof fetch;
    const { container } = render(createApp({ fetchImpl, realtime: false }).element);
    await waitFor(() => {
      expect(container.querySelector('[data-failed-job-count]')?.textContent).toBe(
        'The newest 2 of 3 failed jobs.',
      );
    });
    expect(container.querySelector(`[data-failed-job="${ids[2]}"]`)).toBeNull();
    const older = (await screen.findAllByRole('button', { name: 'Show older' })).find((button) =>
      button.closest('section')?.textContent?.includes('Failed jobs'),
    );
    expect(older).toBeDefined();
    fireEvent.click(older as HTMLElement);
    await waitFor(() => {
      expect(container.querySelector(`[data-failed-job="${ids[2]}"]`)).not.toBeNull();
    });
    expect(asked).toEqual(['(first)', '2026-09-30T08:48:00.000001Z_page-2']);
    expect(container.querySelector('[data-failed-job-count]')?.textContent).toBe('3 failed jobs.');
    // The last page offers nothing older.
    expect(
      screen
        .queryAllByRole('button', { name: 'Show older' })
        .filter((button) => button.closest('section')?.textContent?.includes('Failed jobs')),
    ).toHaveLength(0);
  });

  it('names a non-admin’s refusal as the role, and a 503 as what it is', async () => {
    const forbidden = render(createApp({ fetchImpl: fetchFor(403), realtime: false }).element);
    expect(await screen.findByText('The failed jobs could not be loaded.')).toBeTruthy();
    expect(forbidden.container.textContent).toContain('Reading them needs the admin role.');
    expect(forbidden.container.textContent).not.toContain('No failed jobs');
    cleanup();
    const unavailable = render(createApp({ fetchImpl: fetchFor(503), realtime: false }).element);
    expect(await screen.findByText('The failed jobs could not be loaded.')).toBeTruthy();
    expect(unavailable.container.textContent).not.toContain('Reading them needs the admin role.');
  });
});

/**
 * The history bootstrap's control — product/06 step 3b (WP-35).
 *
 * Driven through `createApp` with a fake server, so what is asserted is the composition: the real
 * router, the real query client, the real endpoint parsers. Three things are worth a test here and
 * the rest is layout:
 *
 *  - the **estimate is the server's**, and moving N **re-asks** rather than multiplying two
 *    published numbers in the browser (standing rule 9 — the first disagreement would be money);
 *  - a **blocked** project sees the reason and a disabled button, rather than a button that answers
 *    409 when pressed;
 *  - the platform's `detail` and `blocked_reason` are rendered as **text**, never as markup, like
 *    every other string on every other screen (BD-022, and the rule is about the sink).
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';

const PROJECT = '00000000-0000-4000-8000-0000000000a1';

const SESSION: SessionResponse = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'operator@example.invalid',
    name: 'Fake Operator',
    role: 'admin',
  },
  session: { id: '00000000-0000-4000-8000-000000000002' },
};

/** A platform sentence about a batch that found nothing, with markup and a bidi override in it. */
const HOSTILE_DETAIL = '<img src=x onerror=alert(1)> ‮denim gnihton';

const PROJECT_ROW = {
  id: PROJECT,
  key: 'acme_api',
  name: 'ACME API',
  repo_url: 'https://git.example.test/acme/api.git',
  default_branch: 'main',
  agentic_dir: '.agentic',
  knowledge_dir: '.agentic/knowledge',
  autonomy_level: 'supervised',
  readiness_level: 1,
  status: 'active',
  created_at: '2026-09-13T04:00:00.000Z',
  updated_at: '2026-09-13T04:00:00.000Z',
  open_tasks: 0,
  spent_usd_30d: 0,
};

const estimateFor = (mergeRequests: number, capUsd = 20) => ({
  merge_requests: mergeRequests,
  batch_size: 20,
  batches: Math.ceil(mergeRequests / 20),
  estimated_usd: Math.ceil(mergeRequests / 20) * 2,
  cap_usd: capUsd,
  stops_at_cap: Math.ceil(mergeRequests / 20) * 2 > capUsd,
  days: 183,
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface WorldOptions {
  readonly canStart?: boolean;
  readonly blockedReason?: string | null;
  readonly detail?: string | null;
  readonly capUsd?: number;
}

let asked: (string | null)[];
let started: unknown[];

const fetchFor = (options: WorldOptions = {}) =>
  (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes('/api/auth/get-session')) return json(SESSION);
    if (url.includes('/history-bootstraps')) {
      if ((init?.method ?? 'GET') === 'POST') {
        started.push(JSON.parse(String(init?.body ?? '{}')));
        return json({
          batch_id: '00000000-0000-4000-8000-0000000000b9',
          estimate: estimateFor(200),
        });
      }
      const requested = new URL(url, 'https://app.example.test').searchParams.get('merge_requests');
      asked.push(requested);
      return json({
        items:
          options.detail === undefined
            ? []
            : [
                {
                  id: '00000000-0000-4000-8000-0000000000b9',
                  project_id: PROJECT,
                  status: 'empty',
                  created_at: '2026-09-13T04:00:00.000Z',
                  completed_at: '2026-09-13T04:01:00.000Z',
                  merge_requests: 40,
                  detail: options.detail,
                  cap_usd: 20,
                  estimated_usd: 4,
                  spent_usd: 0,
                  chunks: 0,
                  chunks_recorded: 0,
                  proposals: 0,
                  refused_proposals: 0,
                },
              ],
        can_start: options.canStart ?? true,
        blocked_reason: options.blockedReason ?? null,
        estimate: estimateFor(requested === null ? 200 : Number(requested), options.capUsd ?? 20),
        max_merge_requests: 1000,
      });
    }
    if (url.includes('/api/projects/') && url.includes('/readiness')) {
      return json({ error: { code: 'readiness_not_evaluated', message: 'none' } }, 409);
    }
    if (url.includes('/api/projects/') && url.includes('/bindings')) return json({ items: [] });
    if (url.endsWith('/api/projects')) return json({ items: [PROJECT_ROW] });
    if (url.endsWith('/api/integrations')) return json({ items: [] });
    return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
  }) as typeof fetch;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  asked = [];
  started = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  window.history.pushState({}, '', '/onboarding');
});

describe('the history bootstrap panel', () => {
  it('shows the estimate the server computed, before anything is started', async () => {
    render(createApp({ fetchImpl: fetchFor(), realtime: false }).element);
    expect(await screen.findByText(/At most \$20\.00/)).toBeTruthy();
    expect(screen.getByText(/10 run\(s\) of 20 merge requests/)).toBeTruthy();
    // Nothing was started by rendering.
    expect(started).toEqual([]);
  });

  it('re-asks the server when the number changes, rather than multiplying in the browser', async () => {
    render(createApp({ fetchImpl: fetchFor(), realtime: false }).element);
    const input = (await screen.findByLabelText('Merge requests to mine')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '40' } });
    await waitFor(() => {
      expect(screen.getByText(/2 run\(s\) of 20 merge requests/)).toBeTruthy();
    });
    // The first read is the project's own N, the second is the one the operator typed.
    expect(asked).toEqual([null, '40']);
  });

  it('sends the number the operator chose when the button is pressed', async () => {
    render(createApp({ fetchImpl: fetchFor(), realtime: false }).element);
    const input = (await screen.findByLabelText('Merge requests to mine')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '40' } });
    await waitFor(() => {
      expect(screen.getByText(/2 run\(s\)/)).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Mine the history' }));
    await waitFor(() => {
      expect(started).toEqual([{ merge_requests: 40 }]);
    });
  });

  it('says in advance that a batch will stop at the cap, rather than refusing it', async () => {
    render(createApp({ fetchImpl: fetchFor({ capUsd: 5 }), realtime: false }).element);
    expect(await screen.findByText(/will mine what the cap pays for and stop/)).toBeTruthy();
  });

  it('states the reason and disables the button for a project that may not start one', async () => {
    render(
      createApp({
        fetchImpl: fetchFor({
          canStart: false,
          blockedReason: 'the history bootstrap is off for this project',
        }),
        realtime: false,
      }).element,
    );
    expect(await screen.findByText(/is off for this project/)).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Mine the history' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(started).toEqual([]);
  });

  it('renders a batch’s platform detail as text, never as markup', async () => {
    const { container } = render(
      createApp({ fetchImpl: fetchFor({ detail: HOSTILE_DETAIL }), realtime: false }).element,
    );
    expect(await screen.findByText(/denim gnihton/)).toBeTruthy();
    // The string appears verbatim and creates no element: the app builds no markup from a string.
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

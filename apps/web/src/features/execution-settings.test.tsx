/**
 * The project settings page's **Execution** card (WP-278 criterion 6, TD-031 decision 8).
 *
 * Driven through `createApp` with a fake server, so the real router, query client and endpoint
 * parsers are in the path; asserted on what the card shows and on the request it sends.
 */
import type { ProjectSummary } from '@platform/contracts';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';

const PROJECT = '00000000-0000-4000-8000-0000000027c1';

const SESSION: SessionResponse = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'operator@example.invalid',
    name: 'Fake Operator',
    role: 'admin',
  },
  session: { id: '00000000-0000-4000-8000-000000000002' },
};

const PROJECT_ROW: ProjectSummary = {
  id: PROJECT,
  key: 'autix',
  name: 'Autix',
  repo_url: 'https://gitlab.example.test/acme/autix.git',
  default_branch: 'main',
  agentic_dir: '.agentic',
  knowledge_dir: '.agentic/knowledge',
  autonomy_level: 'supervised',
  readiness_level: 0,
  status: 'active',
  created_at: '2026-10-04T04:00:00.000Z',
  updated_at: '2026-10-04T04:00:00.000Z',
  open_tasks: 0,
  spent_usd_30d: 0,
};

const DEFAULTS = {
  mode: 'hybrid',
  prefer: 'server',
  fallback_after_seconds: null,
  assignee_window_seconds: 120,
  offer_timeout_seconds: 86_400,
  effective_fallback_after_seconds: 15,
  stored: false,
  server_claimant: 'none',
  notice:
    'No server runner is running on this instance, so this project is treated as workers only: workers may take its runs at once.',
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Sent {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

const server = (sent: Sent[]): typeof fetch =>
  (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      sent.push({
        method,
        url,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      });
    }
    if (url.includes('/api/auth/get-session')) return json(SESSION);
    if (url.endsWith('/execution') && method === 'PUT') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json({
        execution: { ...DEFAULTS, ...body, stored: true, effective_fallback_after_seconds: 300 },
        performed: true,
      });
    }
    if (url.endsWith('/execution')) return json(DEFAULTS);
    if (url.endsWith('/api/projects')) return json({ items: [PROJECT_ROW] });
    if (url.endsWith('/api/integrations')) return json({ items: [] });
    if (url.includes('/bindings')) return json({ items: [] });
    return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
  }) as typeof fetch;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('the Execution card (WP-278)', () => {
  it('shows the defaults and says the instance has no server runner', async () => {
    window.history.pushState({}, '', '/projects/autix/settings');
    render(createApp({ fetchImpl: server([]), realtime: false }).element);
    await screen.findByRole('button', { name: 'Save execution setting' });
    expect(screen.getByTestId('execution-settings').textContent).toContain(
      'Server and workers (hybrid)',
    );
    expect(screen.getByTestId('execution-notice').textContent).toMatch(/treated as workers only/);
    expect((screen.getByLabelText('Execution mode') as HTMLSelectElement).value).toBe('hybrid');
  });

  it('sends the whole setting when saved', async () => {
    window.history.pushState({}, '', '/projects/autix/settings');
    const sent: Sent[] = [];
    render(createApp({ fetchImpl: server(sent), realtime: false }).element);
    await screen.findByRole('button', { name: 'Save execution setting' });
    fireEvent.change(screen.getByLabelText('Execution mode'), {
      target: { value: 'workers_only' },
    });
    fireEvent.change(screen.getByLabelText('Offer timeout (seconds)'), {
      target: { value: '3600' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save execution setting' }));
    await waitFor(() =>
      expect(sent.filter((entry) => entry.url.endsWith('/execution'))).toEqual([
        {
          method: 'PUT',
          url: expect.stringContaining(`/api/projects/${PROJECT}/execution`),
          body: {
            mode: 'workers_only',
            prefer: 'server',
            fallback_after_seconds: null,
            assignee_window_seconds: 120,
            offer_timeout_seconds: 3600,
          },
        },
      ]),
    );
  });

  it('does not offer a save for a number that is not one', async () => {
    window.history.pushState({}, '', '/projects/autix/settings');
    render(createApp({ fetchImpl: server([]), realtime: false }).element);
    const save = await screen.findByRole('button', { name: 'Save execution setting' });
    fireEvent.change(screen.getByLabelText('Assignee head start (seconds)'), {
      target: { value: 'soon' },
    });
    expect((save as HTMLButtonElement).disabled).toBe(true);
  });
});

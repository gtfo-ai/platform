/**
 * The *Add a worker* wizard's Install step **on a core that does not serve the installer**
 * (S-23.20): `INSTALLER_AVAILABLE` mocked to `false`, so no installer line is shown and the by-hand
 * setup is the step itself, not a disclosure. The `true` state (today's, S-23.24) is
 * `worker-wizard.test.tsx`.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';
import { NOW, USER_ID } from './worker.test-fixture.js';

vi.mock('./worker-wizard-steps.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./worker-wizard-steps.js')>()),
  INSTALLER_AVAILABLE: false,
}));

const SESSION: SessionResponse = {
  user: { id: USER_ID, email: 'jan@example.invalid', name: 'Jan Example', role: 'admin' },
  session: { id: '00000000-0000-4000-8000-000000000002' },
};

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
  const path = new URL(String(input), 'http://localhost').pathname;
  if (path.startsWith('/api/auth/get-session')) return json(SESSION);
  if (path === '/api/workers') return json({ items: [], scope: 'own', timezone: 'UTC' });
  if (path === '/api/projects') return json({ items: [] });
  if (path === '/api/org/inbox') return json({ questions: [], approvals: [] });
  if (path === '/api/org/agents') return json({ items: [] });
  return new Response(JSON.stringify({ error: { code: 'not_found', message: path } }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // The wizard's chunk, loaded under the hook's bound rather than inside a `findBy…`.
  await import('./worker-wizard.js');
}, 60_000);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Add a worker: Install, where the installer is not served', () => {
  it('shows no installer line and makes the by-hand setup the step', async () => {
    const since = new Date(NOW - 60_000).toISOString();
    window.history.pushState({}, '', `/workers/new?step=install&since=${since}`);
    render(createApp({ fetchImpl, now: () => NOW, realtime: false }).element);
    await screen.findByRole('heading', { level: 2, name: 'Install' });
    const origin = window.location.origin;

    expect(document.querySelector('[data-installer]')).toBeNull();
    expect(screen.queryByText(/install\.(sh|ps1)/)).toBeNull();
    const byHand = document.querySelector('[data-by-hand]') as HTMLElement;
    expect(byHand.closest('details')).toBeNull();
    expect(
      (within(byHand).getByLabelText('Download the worker’s compose file') as HTMLInputElement)
        .value,
    ).toBe(`curl -fsSo compose.worker.yml ${origin}/api/worker/v1/compose.yml`);
    expect((within(byHand).getByLabelText('Start the worker') as HTMLInputElement).value).toBe(
      'docker compose --env-file .env.worker -f compose.worker.yml up -d',
    );
  });
});

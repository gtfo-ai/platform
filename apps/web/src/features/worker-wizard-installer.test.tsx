/**
 * The *Add a worker* wizard's Install step **once the core serves the installer** (S-23.20, S-22.20):
 * `INSTALLER_AVAILABLE` mocked to `true`, so the one-line installer is the default — the browser's
 * platform first, the other behind a disclosure, each with its script to read — and the by-hand
 * setup moves into *Set it up by hand*. The `false` state (today's) is `worker-wizard.test.tsx`.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';
import { NOW, USER_ID } from './worker.test-fixture.js';

vi.mock('./worker-wizard-steps.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./worker-wizard-steps.js')>()),
  INSTALLER_AVAILABLE: true,
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

describe('Add a worker: Install, once the installer is served', () => {
  it('shows the one-line installer first and moves the by-hand setup into a disclosure', async () => {
    const since = new Date(NOW - 60_000).toISOString();
    window.history.pushState({}, '', `/workers/new?step=install&since=${since}`);
    render(createApp({ fetchImpl, now: () => NOW, realtime: false }).element);
    await screen.findByRole('heading', { level: 2, name: 'Install' });
    const origin = window.location.origin;

    // happy-dom reports no Windows: the shell installer leads, PowerShell is behind a click.
    const first = document.querySelector('[data-installer="unix"]') as HTMLElement;
    expect(first.closest('details')).toBeNull();
    expect(
      (within(first).getByLabelText('macOS or Linux (Terminal)') as HTMLInputElement).value,
    ).toBe(`curl -fsSL '${origin}/api/worker/v1/install.sh' | sh`);
    expect(
      within(first).getByRole('link', { name: 'Read the script first' }).getAttribute('href'),
    ).toBe(`${origin}/api/worker/v1/install.sh`);
    const windows = document.querySelector('[data-installer="windows"]') as HTMLElement;
    expect(windows.closest('details')?.textContent).toContain('On Windows (PowerShell) instead');
    expect((within(windows).getByLabelText('Windows (PowerShell)') as HTMLInputElement).value).toBe(
      `irm '${origin}/api/worker/v1/install.ps1' | iex`,
    );

    const byHand = document.querySelector('[data-by-hand]') as HTMLElement;
    expect(byHand.closest('details')?.querySelector('summary')?.textContent).toBe(
      'Set it up by hand',
    );
    expect((within(byHand).getByLabelText('Start the worker') as HTMLInputElement).value).toBe(
      'docker compose --env-file .env.worker -f compose.worker.yml up -d',
    );
  });
});

/**
 * The top bar's account menu (TD-033 § 5) — who is signed in and the sign-out button, behind one
 * Base UI menu. Driven through `createApp` with a fake server, so the real shell and auth client are
 * in the path:
 *
 * - the trigger is named "Account menu" and the menu says who is signed in, with the role;
 * - there is no theme choice: one dark theme (TD-033's 2026-11-05 amendment), and nothing writes
 *   `<html data-theme>` or remembers a theme in `localStorage`;
 * - "Sign out" signs out and returns to the sign-in page.
 */
import { QueryClient } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionResponse } from '../auth/session.js';
import { createApp } from './app.js';

const SESSION: SessionResponse = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'operator@example.invalid',
    name: 'Fake Operator',
    role: 'maintainer',
  },
  session: { id: '00000000-0000-4000-8000-000000000002' },
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const server = (state: { signedIn: boolean; signOuts: number }) =>
  (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.includes('/api/auth/get-session')) return json(state.signedIn ? SESSION : null);
    if (url.includes('/api/auth/sign-out')) {
      state.signOuts += 1;
      state.signedIn = false;
      return json({});
    }
    if (url.endsWith('/api/setup-state')) return json({ first_sign_in: false });
    if (url.endsWith('/events/subscriptions')) return json({});
    return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
  }) as typeof fetch;

const start = (state: { signedIn: boolean; signOuts: number }) =>
  render(
    createApp({
      queryClient: new QueryClient({
        defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
      }),
      fetchImpl: server(state),
      realtime: false,
    }).element,
  );

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  localStorage.clear();
  window.history.pushState({}, '', '/agents');
});

describe('the account menu', () => {
  it('says who is signed in, as what', async () => {
    const user = userEvent.setup();
    start({ signedIn: true, signOuts: 0 });
    await user.click(await screen.findByRole('button', { name: 'Account menu' }));
    const menu = await screen.findByRole('menu');
    expect(menu.textContent).toContain('Signed in as Fake Operator');
    expect(menu.textContent).toContain('Role: maintainer');
  });

  it('offers no theme choice and writes no theme anywhere', async () => {
    const user = userEvent.setup();
    start({ signedIn: true, signOuts: 0 });
    await user.click(await screen.findByRole('button', { name: 'Account menu' }));
    const menu = await screen.findByRole('menu');
    expect(screen.queryByRole('group', { name: 'Theme' })).toBeNull();
    expect(menu.querySelectorAll('[role="menuitemradio"]')).toHaveLength(0);
    expect(menu.textContent).not.toMatch(/Dark|Light|System/);
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(screen.getByRole('banner').hasAttribute('data-theme')).toBe(false);
    expect(localStorage.getItem('agentic.theme')).toBeNull();
  });

  it('signs out and returns to the sign-in page', async () => {
    const user = userEvent.setup();
    const state = { signedIn: true, signOuts: 0 };
    start(state);
    await user.click(await screen.findByRole('button', { name: 'Account menu' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
    await waitFor(() => {
      expect(window.location.pathname).toBe('/sign-in');
    });
    expect(state.signOuts).toBe(1);
  });
});

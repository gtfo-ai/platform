/**
 * The top bar's account menu (TD-033 § 5) — the shell's theme `<select>` and its sign-out button,
 * moved behind one Base UI menu. Driven through `createApp` with a fake server, so the real shell,
 * theme provider and auth client are in the path:
 *
 * - the trigger is named "Account menu" and the menu says who is signed in, with the role;
 * - "Theme" is a radio group of Dark / Light / System whose choice reaches `<html data-theme>`
 *   and is remembered;
 * - "Sign out" signs out and returns to the sign-in page;
 * - the top bar itself is a dark scope in both themes.
 */
import { QueryClient } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionResponse } from '../auth/session.js';
import { THEME_STORAGE_KEY } from '../ui/theme.js';
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

  it('chooses the theme from a radio group, starting at the dark default', async () => {
    const user = userEvent.setup();
    start({ signedIn: true, signOuts: 0 });
    await user.click(await screen.findByRole('button', { name: 'Account menu' }));
    const theme = await screen.findByRole('group', { name: 'Theme' });
    const choices = within(theme).getAllByRole('menuitemradio');
    expect(choices.map((choice) => choice.textContent)).toEqual(['Dark', 'Light', 'System']);
    expect(
      within(theme).getByRole('menuitemradio', { name: 'Dark' }).getAttribute('aria-checked'),
    ).toBe('true');
    expect(document.documentElement.dataset['theme']).toBe('dark');

    await user.click(within(theme).getByRole('menuitemradio', { name: 'Light' }));
    await waitFor(() => {
      expect(document.documentElement.dataset['theme']).toBe('light');
    });
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    // The top bar stays night: it is a dark scope whatever the page's theme is.
    expect(screen.getByRole('banner').getAttribute('data-theme')).toBe('dark');
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

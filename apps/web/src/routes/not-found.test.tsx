/**
 * **An unknown address is a way back, inside the frame** (S-23.22, the final UX audit's item 12):
 * before this the router had no not-found component, so `/projects/ACME/typo` was TanStack's own
 * "Not Found" with no navigation and no link.
 */
import { QueryClient } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const SESSION = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'operator@example.invalid',
    name: 'Fake Operator',
    role: 'member',
  },
  session: { id: '00000000-0000-4000-8000-000000000002' },
};

const start = (path: string) => {
  window.history.pushState({}, '', path);
  return render(
    createApp({
      queryClient: new QueryClient({
        defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
      }),
      fetchImpl: (async (input: RequestInfo | URL) =>
        String(input).includes('/api/auth/get-session')
          ? json(SESSION)
          : json({ error: { code: 'not_found', message: 'no such route' } }, 404)) as typeof fetch,
      realtime: false,
    }).element,
  );
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('an address nothing matches', () => {
  it.each(['/nowhere', '/projects/ACME/typo', '/settings/x/y/z'])(
    'shows "This page does not exist" inside the shell for %s',
    async (path) => {
      start(path);
      const blank = await screen.findByText('This page does not exist');
      // Inside the frame: the top bar and its navigation are still there.
      expect(await screen.findByRole('banner')).toBeTruthy();
      const main = screen.getByRole('main');
      expect(main.contains(blank)).toBe(true);
      // The way back, and the path that was asked for, as text.
      const home = within(main).getByRole('link', { name: 'Go to Home' });
      expect(home.getAttribute('href')).toBe('/');
      expect(main.textContent).toContain(path);
    },
  );

  it('does not show it on a page that exists', async () => {
    start('/inbox');
    await screen.findByRole('banner');
    expect(screen.queryByText('This page does not exist')).toBeNull();
  });
});

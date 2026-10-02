/**
 * **An outage is not a missing role** — the settings page's three reads that named every failure a
 * permission problem (WP-122, PROGRESS backlog 385; 327's class, which WP-114 closed for three other
 * screens).
 *
 * Driven through `createApp` with a fake server. Each read answers `503` in turn and the screen must
 * show what the server said, never the role sentence; and each answers `403` once, so the sentence
 * is shown where it is true (both directions, standing rule 42). The settings audit's case is in
 * `project-settings.test.tsx` and the task page's in `task-record.test.tsx`.
 */
import { cleanup, render, screen } from '@testing-library/react';
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

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** One read the settings page makes, the notice its failure shows and its role sentence. */
const READS = [
  {
    path: '/api/org/users',
    title: 'The user list could not be loaded.',
    role: 'Reading the organisation needs the viewer role or above.',
  },
  {
    path: '/api/org/budgets',
    title: 'The organisation budgets could not be loaded.',
    role: 'Reading a budget needs the viewer role; setting one needs maintainer.',
  },
  {
    path: '/api/org/identities',
    title: 'The identity mappings could not be loaded.',
    role: 'Reading and writing them needs the admin role, because a mapping decides who may act as whom.',
  },
] as const;

const fetchFailing = (failing: string, status: number, message: string): typeof fetch =>
  (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    const path = new URL(url, 'http://localhost').pathname;
    if (url.includes('/api/auth/get-session')) return json(SESSION);
    if (path === failing) {
      return json(
        { error: { code: status === 403 ? 'forbidden' : 'unavailable', message } },
        status,
      );
    }
    if (path === '/api/org') {
      return json({ settings: {}, updated_at: '2026-09-29T08:00:00.000Z' });
    }
    if (path === '/api/org/dead-letters') return json({ items: [], total: 0, next_cursor: null });
    if (path === '/api/org/failed-jobs') return json({ items: [], total: 0, next_cursor: null });
    if (
      path === '/api/org/users' ||
      path === '/api/org/budgets' ||
      path === '/api/org/identities' ||
      path === '/api/org/identities/candidates' ||
      path === '/api/integrations' ||
      path === '/api/projects'
    ) {
      return json({ items: [] });
    }
    if (path === '/api/version') {
      return json({ version: '0.0.0-dev', commit: null, built_at: null });
    }
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

describe('the settings page’s read errors (WP-122)', () => {
  it.each(READS)('does not name a 503 on $path a permission problem', async (read) => {
    render(
      createApp({
        fetchImpl: fetchFailing(read.path, 503, 'the database is restarting'),
        realtime: false,
      }).element,
    );
    // The client retries a failed read once (`retry: 1`), so the notice arrives after that retry.
    expect(await screen.findByText(read.title, {}, { timeout: 5_000 })).toBeTruthy();
    expect(document.body.textContent).toContain('the database is restarting');
    expect(document.body.textContent).not.toContain(read.role);
  });

  it.each(READS)('keeps the role sentence on $path for a 403', async (read) => {
    render(
      createApp({
        fetchImpl: fetchFailing(read.path, 403, 'role viewer may not perform this'),
        realtime: false,
      }).element,
    );
    expect(await screen.findByText(read.title, {}, { timeout: 5_000 })).toBeTruthy();
    expect(document.body.textContent).toContain(read.role);
  });
});

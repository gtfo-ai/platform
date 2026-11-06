/**
 * Settings' Admin screens keep their URLs (S-25.6, product/10's 2026-11-06 IA amendment, Q-UX-1).
 *
 * Integrations, Workers and the Audit log left the top row for the *Admin* group of org Settings,
 * and the routes under them moved beneath a pathless layout (`routes/tree.tsx`'s `adminRoute`). What
 * must not move is any URL — above all two that installed workers print and that must resolve for
 * ever (the worker session's requirement, 2026-11-06):
 *
 *  - `/workers/approve?code=…`, the device flow's `verification_uri`. The core builds it from
 *    `WORKER_APPROVE_PAGE` in `apps/server/src/routes/worker-device.ts`; this file reads that
 *    constant **off the server's source** and opens exactly it, so a change on either side fails
 *    here, and asserts the query string reached the page (the code is in the field);
 *  - `/workers/new?step=ready`, the wizard's *Ready to work* step that a worker's own page links to.
 *
 * Driven through `createApp` with a fake server, so the real router resolves every path. Each old
 * URL must render at the same pathname, inside the Settings NavList with its Admin entry current —
 * except the two wizards, which take the whole width for their own Stepper (`staticData.bare`) —
 * and `/settings/<admin id>` goes to the screen's own URL.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { UserRole } from '@platform/contracts';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';
import { workerFixture } from '../features/worker.test-fixture.js';

const NOW = Date.parse('2026-11-06T10:00:00.000Z');
const INTEGRATION = '00000000-0000-4000-8000-0000000000c1';

/** `WORKER_APPROVE_PAGE`, as the server's own source declares it — never a copy of the string. */
const serverApprovePage = (): string => {
  const source = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
      'server',
      'src',
      'routes',
      'worker-device.ts',
    ),
    'utf8',
  );
  const declared = /export const WORKER_APPROVE_PAGE = '([^']+)';/.exec(source)?.[1];
  if (declared === undefined) {
    throw new Error('apps/server/src/routes/worker-device.ts declares no WORKER_APPROVE_PAGE');
  }
  return declared;
};

const session = (role: UserRole): SessionResponse => ({
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'operator@example.invalid',
    name: 'Fake Operator',
    role,
  },
  session: { id: '00000000-0000-4000-8000-000000000002' },
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let role: UserRole = 'admin';

const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
  const path = new URL(String(input), 'http://localhost').pathname;
  if (path.startsWith('/api/auth/get-session')) return json(session(role));
  if (path === '/events/subscriptions') return json({});
  if (path === '/api/projects') return json({ items: [], can_create: role === 'admin' });
  if (path === '/api/org/inbox') return json({ questions: [], approvals: [] });
  if (path === '/api/org/agents') return json({ items: [] });
  if (path === '/api/integrations') return json({ items: [], can_write: role === 'admin' });
  if (path === '/api/workers') {
    return json({
      items: [workerFixture({ created_at: new Date(NOW - 60_000).toISOString() })],
      scope: 'own',
      timezone: 'UTC',
    });
  }
  return json({ error: { code: 'not_found', message: `no route ${path}` } }, 404);
}) as typeof fetch;

const open = (url: string): void => {
  window.history.pushState({}, '', url);
  render(createApp({ fetchImpl, now: () => NOW, realtime: false }).element);
};

/** The Settings NavList and the label of its one current entry. */
const settingsNav = async (): Promise<{ nav: HTMLElement; current: string | null }> => {
  const nav = await screen.findByRole('navigation', { name: 'Settings' });
  const current = within(nav)
    .getAllByRole('link')
    .filter((link) => link.getAttribute('aria-current') === 'page');
  return { nav, current: current.length === 1 ? (current[0]?.textContent ?? null) : null };
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  role = 'admin';
});

describe('the Admin screens keep every URL they had', () => {
  it.each([
    ['/integrations', 'Integrations'],
    [`/integrations/${INTEGRATION}`, 'Integrations'],
    ['/workers', 'Workers'],
    ['/workers/approve', 'Workers'],
    ['/audit', 'Audit log'],
  ])('%s resolves where it was, inside Settings → Admin → %s', async (path, entry) => {
    open(path);
    const { nav, current } = await settingsNav();
    expect(current).toBe(entry);
    expect(within(nav).getByRole('heading', { name: 'Admin' })).toBeTruthy();
    expect(window.location.pathname).toBe(path);
    // Not the not-found screen: a route matched.
    expect(screen.queryByText('This page does not exist')).toBeNull();
  });

  it.each(['/integrations/new', '/workers/new'])(
    '%s, a wizard, resolves where it was and is drawn alone, with no Settings list beside its steps',
    async (path) => {
      open(path);
      // A wizard step is on screen: the route matched and the wizard rendered.
      await waitFor(() => {
        expect(document.querySelector('[data-wizard-step]')).not.toBeNull();
      });
      expect(window.location.pathname).toBe(path);
      expect(screen.queryByRole('navigation', { name: 'Settings' })).toBeNull();
    },
  );

  it('opens the device flow’s own URL, as the core issues it, with the code still in the query', async () => {
    const page = serverApprovePage();
    // The URL the core prints is the one this route tree serves: the constant is unchanged.
    expect(page).toBe('/workers/approve');
    open(`${page}?code=bcdf-ghjk`);
    const field = await screen.findByLabelText('Code shown by the machine');
    // The query string reached the screen: the code is in its field (which then drops it from the
    // address bar itself, WP-294).
    expect((field as HTMLInputElement).value.toUpperCase()).toBe('BCDF-GHJK');
    expect(window.location.pathname).toBe(page);
    expect((await settingsNav()).current).toBe('Workers');
  });

  it('opens the worker wizard at Ready to work from ?step=ready, the query string kept', async () => {
    const since = new Date(NOW - 60_000).toISOString();
    open(`/workers/new?step=ready&since=${encodeURIComponent(since)}`);
    await waitFor(() => {
      expect(document.querySelector('[data-wizard-step]')?.getAttribute('data-wizard-step')).toBe(
        'ready',
      );
    });
    expect(window.location.pathname).toBe('/workers/new');
    expect(new URLSearchParams(window.location.search).get('step')).toBe('ready');
    // A wizard: no Settings list beside its own Stepper (review of #83).
    expect(screen.queryByRole('navigation', { name: 'Settings' })).toBeNull();
  });

  it('sends a settings path named after an Admin entry to the screen’s own URL', async () => {
    open('/settings/workers');
    await waitFor(() => {
      expect(window.location.pathname).toBe('/workers');
    });
    expect((await settingsNav()).current).toBe('Workers');
  });

  it('shows a member the Workers entry, and not the two screens the server refuses below maintainer', async () => {
    role = 'member';
    open('/workers');
    const { nav, current } = await settingsNav();
    expect(current).toBe('Workers');
    const admin = within(nav).getByRole('heading', { name: 'Admin' }).closest('div');
    expect(
      within(admin as HTMLElement)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Workers']);
  });
});

/**
 * The keyboard shortcuts through the whole app (`createApp` over a fake server): each `g` jump, `?`
 * and its sheet, `j`/`k` in a list, the guard that keeps every one of them out of a field, and the
 * setting that turns the single keys off while ⌘K still opens the search. The decisions themselves
 * are table-tested in `shortcuts.test.ts`; this is the listener that applies them.
 */
import type { ProjectSummary } from '@platform/contracts';
import { QueryClient } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionResponse } from '../auth/session.js';
import { createApp } from './app.js';
import { SHORTCUT_GROUPS, SHORTCUTS_STORAGE_KEY } from './shortcuts.js';

const project = (n: number, key: string): ProjectSummary => ({
  id: `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`,
  key,
  name: `Project ${key}`,
  repo_url: `https://git.example.invalid/acme/${key}.git`,
  default_branch: 'main',
  agentic_dir: '.agentic',
  knowledge_dir: 'knowledge',
  autonomy_level: 'supervised',
  readiness_level: 2,
  status: 'active',
  created_at: '2026-06-01T09:00:00.000Z',
  updated_at: '2026-06-01T09:00:00.000Z',
  open_tasks: 0,
  spent_usd_30d: 0,
});

const PROJECTS = [project(1, 'acme'), project(2, 'bill'), project(3, 'cart')];

const SESSION: SessionResponse = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'operator@example.invalid',
    name: 'Fake Operator',
    role: 'member',
  },
  session: { id: '00000000-0000-4000-8000-000000000002' },
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
  const path = new URL(String(input), 'http://app.example.invalid').pathname;
  if (path === '/api/auth/get-session') return json(SESSION);
  if (path === '/api/setup-state') return json({ first_sign_in: false });
  if (path === '/events/subscriptions') return json({});
  if (path === '/api/projects') return json({ items: PROJECTS });
  if (path === '/api/org/agents') return json({ items: [] });
  if (path === '/api/org/inbox') return json({ questions: [], approvals: [] });
  if (/^\/api\/projects\/[^/]+\/tasks$/.test(path)) {
    return json({
      items: [],
      next_cursor: null,
      can_start_task: false,
      can_cancel_task: false,
      can_return_to_stage: false,
    });
  }
  return json({ error: { code: 'not_found', message: 'the fake server has no such route' } }, 404);
}) as typeof fetch;

const start = (path: string) => {
  window.history.pushState({}, '', path);
  return render(
    createApp({
      queryClient: new QueryClient({
        defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
      }),
      fetchImpl,
      realtime: false,
    }).element,
  );
};

const at = async (pathname: string): Promise<void> => {
  await waitFor(() => {
    expect(window.location.pathname).toBe(pathname);
  });
};

/** A field outside the app's own, to type into: the guard is about the target, not the screen. */
const field = (tag: 'input' | 'textarea' | 'div'): HTMLElement => {
  const element = document.createElement(tag);
  if (tag === 'div') {
    element.setAttribute('contenteditable', 'true');
  }
  element.setAttribute('aria-label', `scratch ${tag}`);
  document.body.append(element);
  return element;
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  document.body.innerHTML = '';
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('g jumps', () => {
  it.each([
    ['h', '/projects', '/'],
    ['p', '/', '/projects'],
    ['i', '/', '/inbox'],
    ['a', '/', '/agents'],
  ])('g %s goes from %s to %s', async (letter, from, to) => {
    const user = userEvent.setup();
    start(from);
    await screen.findByRole('banner');
    await at(from);
    await user.keyboard(`g${letter}`);
    await at(to);
  });

  it('g b goes to the board inside a project and does nothing outside one', async () => {
    const user = userEvent.setup();
    start('/projects/acme/knowledge');
    await screen.findByRole('banner');
    await user.keyboard('gb');
    await at('/projects/acme');
    cleanup();
    start('/inbox');
    await screen.findByRole('banner');
    await user.keyboard('gb');
    // Calibrated: the same listener still answers a jump it can make.
    await user.keyboard('gp');
    await at('/projects');
  });
});

describe('? and the sheet', () => {
  it('opens a dialog listing every shortcut', async () => {
    const user = userEvent.setup();
    start('/');
    await screen.findByRole('banner');
    await user.keyboard('?');
    const sheet = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    for (const row of SHORTCUT_GROUPS.flatMap((group) => group.rows)) {
      expect(within(sheet).getByText(row.does)).toBeTruthy();
    }
    const link = within(sheet).getByRole('link', { name: 'Turn them off in Settings' });
    expect(link.getAttribute('href')).toBe('/settings/keyboard');
  });

  it('leaves the keys to an open dialog: g p inside the sheet goes nowhere', async () => {
    const user = userEvent.setup();
    start('/');
    await screen.findByRole('banner');
    await user.keyboard('?');
    const sheet = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    await waitFor(() => {
      expect(sheet.contains(document.activeElement)).toBe(true);
    });
    await user.keyboard('gp');
    expect(window.location.pathname).toBe('/');
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBe(sheet);
  });
});

describe('j and k', () => {
  it('move the focus between the rows of a focused list, and leave a page with none alone', async () => {
    const user = userEvent.setup();
    start('/projects');
    const list = await screen.findByRole('list', { name: 'Projects' });
    const [first, second, third] = within(list).getAllByRole('link');
    first?.focus();
    await user.keyboard('j');
    expect(document.activeElement).toBe(second);
    await user.keyboard('j');
    expect(document.activeElement).toBe(third);
    await user.keyboard('k');
    expect(document.activeElement).toBe(second);
    // Outside a list, j is just a key.
    const outside = within(await screen.findByRole('banner')).getByRole('button', {
      name: 'Search or jump to…',
    });
    outside.focus();
    await user.keyboard('j');
    expect(document.activeElement).toBe(outside);
  });
});

describe('the guard', () => {
  it.each(['input', 'textarea', 'div'] as const)(
    'no shortcut fires while typing in a %s',
    async (tag) => {
      const user = userEvent.setup();
      start('/projects');
      await screen.findByRole('banner');
      await at('/projects');
      const target = field(tag);
      target.focus();
      await user.keyboard('gh?/');
      expect(window.location.pathname).toBe('/projects');
      expect(screen.queryByRole('dialog')).toBeNull();
      // The same keys from the page itself do fire: the guard, not the keys, held them back.
      target.blur();
      await user.keyboard('gh');
      await at('/');
    },
  );

  it('⌘K opens the search even from a field', async () => {
    const user = userEvent.setup();
    start('/');
    await screen.findByRole('banner');
    field('input').focus();
    await user.keyboard('{Meta>}k{/Meta}');
    expect(await screen.findByRole('dialog', { name: 'Search or jump to' })).toBeTruthy();
  });
});

describe('the setting', () => {
  it('turned off in Settings → Keyboard shortcuts, the single keys stop and ⌘K still opens the search', async () => {
    const user = userEvent.setup();
    start('/settings/keyboard');
    const toggle = await screen.findByRole('checkbox', { name: /Use single-key shortcuts/ });
    expect((toggle as HTMLInputElement).checked).toBe(true);
    await user.click(toggle);
    expect((toggle as HTMLInputElement).checked).toBe(false);
    expect(localStorage.getItem(SHORTCUTS_STORAGE_KEY)).toBe('off');
    toggle.blur();
    await user.keyboard('gp?');
    expect(window.location.pathname).toBe('/settings/keyboard');
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.keyboard('{Meta>}k{/Meta}');
    expect(await screen.findByRole('dialog', { name: 'Search or jump to' })).toBeTruthy();
    await user.keyboard('{Escape}');
    // And on again, at once.
    await user.click(toggle);
    toggle.blur();
    await user.keyboard('gp');
    await at('/projects');
  });
});

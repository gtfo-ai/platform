/**
 * The settings pages as sub-routes with a NavList (S-23.11b, research/19 § 5.2, TD-033 decision 1).
 *
 * Driven through `createApp` with a fake server, so the real router decides: `/settings` and
 * `/projects/$key/settings` — the URLs every existing link names — redirect to the first section
 * the caller may open, an unknown section does the same, the Operations group is shown only to an
 * administrator (and its paths redirect for anybody else, before any of its reads is asked), the
 * NavList marks the section in view, and each page has at most one primary action. The organisation
 * budgets' one Save is exercised here with its refusal, as no other test did.
 */
import type { UserRole } from '@platform/contracts';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';
import {
  ORG_SETTINGS_GROUPS,
  orgSettingsGroupsFor,
  PROJECT_SETTINGS_GROUPS,
} from './settings-sections.js';

const PROJECT = '00000000-0000-4000-8000-0000000000a1';

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

interface World {
  role: UserRole;
  requested: string[];
  budgetPuts: unknown[];
  budgetAnswer: { readonly status: number; readonly body: unknown };
}

let world: World;

const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  const path = new URL(url, 'http://localhost').pathname;
  world.requested.push(path);
  if (url.includes('/api/auth/get-session')) return json(session(world.role));
  if (path === '/api/org/budgets' && init?.method === 'PUT') {
    world.budgetPuts.push(JSON.parse(String(init.body)));
    return json(world.budgetAnswer.body, world.budgetAnswer.status);
  }
  if (path === '/api/org/budgets') {
    return json({
      items: [
        {
          id: '00000000-0000-4000-8000-0000000000d1',
          scope: 'org',
          scope_id: null,
          window: 'month',
          limit_usd: 40,
          notify_pct: [80],
          spent_usd: 3.25,
        },
      ],
    });
  }
  if (path === '/api/projects') {
    return json({
      items: [
        {
          id: PROJECT,
          key: 'api',
          name: 'API',
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
        },
      ],
    });
  }
  if (path === '/api/version') return json({ version: '0.0.0-dev', commit: null, built_at: null });
  if (path === '/api/org/users' || path === '/api/integrations') return json({ items: [] });
  return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
}) as typeof fetch;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  world = {
    role: 'admin',
    requested: [],
    budgetPuts: [],
    budgetAnswer: { status: 200, body: {} },
  };
});

const open = (path: string): void => {
  window.history.pushState({}, '', path);
  render(createApp({ fetchImpl, realtime: false }).element);
};

/** The primary buttons on the page — the beacon's class, as `integrations.test.tsx` counts them. */
const primaries = (): Element[] =>
  [...document.querySelectorAll('button, a')].filter((element) =>
    element.className.includes('border-primary-line'),
  );

describe('the org settings sub-routes', () => {
  it('opens /settings at its first section, with the NavList and the section marked current', async () => {
    open('/settings');
    const nav = await screen.findByRole('navigation', { name: 'Settings' });
    await waitFor(() => {
      expect(window.location.pathname).toBe('/settings/appearance');
    });
    expect(within(nav).getByRole('link', { name: 'Appearance' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'Session' }).getAttribute('aria-current')).toBe(
      null,
    );
    // Every group, in order, for the administrator.
    expect(
      within(nav)
        .getAllByRole('heading')
        .map((heading) => heading.textContent),
    ).toEqual(['Personal', 'Organisation', 'People', 'Operations']);
    expect(screen.getByLabelText('Theme preference')).toBeTruthy();
  });

  it('moves between sections through the NavList', async () => {
    open('/settings/appearance');
    const nav = await screen.findByRole('navigation', { name: 'Settings' });
    await userEvent.setup().click(within(nav).getByRole('link', { name: 'Instance' }));
    expect(await screen.findByRole('heading', { name: 'Instance' })).toBeTruthy();
    expect(window.location.pathname).toBe('/settings/instance');
    await waitFor(() => {
      expect(document.body.textContent).toContain('0.0.0-dev');
    });
  });

  it('redirects an unknown section to the first one', async () => {
    open('/settings/no-such-section');
    await waitFor(() => {
      expect(window.location.pathname).toBe('/settings/appearance');
    });
    expect(await screen.findByLabelText('Theme preference')).toBeTruthy();
  });

  it('shows Operations to nobody but an administrator, and redirects its paths before any read', async () => {
    world.role = 'maintainer';
    open('/settings/dead-letters');
    await waitFor(() => {
      expect(window.location.pathname).toBe('/settings/appearance');
    });
    const nav = await screen.findByRole('navigation', { name: 'Settings' });
    expect(
      within(nav)
        .getAllByRole('heading')
        .map((heading) => heading.textContent),
    ).toEqual(['Personal', 'Organisation', 'People']);
    expect(within(nav).queryByRole('link', { name: 'Dead letters' })).toBeNull();
    expect(world.requested).not.toContain('/api/org/dead-letters');
    // …and the other direction: the administrator's path renders the section and asks its read.
    cleanup();
    world.role = 'admin';
    world.requested = [];
    open('/settings/dead-letters');
    expect(await screen.findByRole('heading', { name: 'Dead letters' })).toBeTruthy();
    await waitFor(() => {
      expect(world.requested).toContain('/api/org/dead-letters');
    });
  });

  it('saves the organisation budgets with one Save, sending only the window that changed', async () => {
    open('/settings/budgets');
    const user = userEvent.setup();
    const save = (await screen.findByRole('button', { name: 'Save budgets' })) as HTMLButtonElement;
    await waitFor(() => {
      expect(document.body.textContent).toContain('spent $3.25 of $40.00 this window');
    });
    expect(save.disabled).toBe(true);
    await user.type(screen.getByLabelText('Per week'), '10');
    expect(save.disabled).toBe(false);
    await user.click(save);
    await waitFor(() => {
      expect(world.budgetPuts).toEqual([{ window: 'week', limit_usd: 10 }]);
    });
    // The page's one primary is its Save.
    expect(primaries()).toEqual([save]);
  });

  it('shows the server’s refusal of a budget save', async () => {
    world.budgetAnswer = {
      status: 403,
      body: { error: { code: 'forbidden', message: 'role viewer may not perform budget.write' } },
    };
    open('/settings/budgets');
    const user = userEvent.setup();
    const month = await screen.findByLabelText('Per month');
    await waitFor(() => {
      expect((month as HTMLInputElement).value).toBe('40');
    });
    await user.clear(month);
    await user.type(month, '25');
    await user.click(screen.getByRole('button', { name: 'Save budgets' }));
    expect(await screen.findByText('The budget was not saved.')).toBeTruthy();
    expect(document.body.textContent).toContain('role viewer may not perform budget.write');
    // The draft survives the refusal, so nothing typed is lost.
    expect((screen.getByLabelText('Per month') as HTMLInputElement).value).toBe('25');
  });

  it('draws each org section with at most one primary action', async () => {
    for (const group of ORG_SETTINGS_GROUPS) {
      for (const section of group.sections) {
        cleanup();
        open(`/settings/${section.id}`);
        await screen.findByRole('navigation', { name: 'Settings' });
        await waitFor(() => {
          expect(
            document
              .querySelector('[data-settings-section]')
              ?.getAttribute('data-settings-section'),
          ).toBe(section.id);
        });
        expect(primaries().length, section.id).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('the project settings sub-routes', () => {
  it('opens /projects/$key/settings at Connections, and an unknown section there too', async () => {
    open('/projects/api/settings');
    await waitFor(() => {
      expect(window.location.pathname).toBe('/projects/api/settings/connections');
    });
    const nav = await screen.findByRole('navigation', { name: 'Project settings' });
    expect(
      within(nav).getByRole('link', { name: 'Connections' }).getAttribute('aria-current'),
    ).toBe('page');
    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(
      PROJECT_SETTINGS_GROUPS.flatMap((group) => group.sections.map((section) => section.label)),
    );
    // The project's Settings tab stays current on a section.
    expect(
      screen.getByRole('navigation', { name: 'Project' }).querySelector('[aria-current="page"]')
        ?.textContent,
    ).toContain('Settings');
    cleanup();
    open('/projects/api/settings/nope');
    await waitFor(() => {
      expect(window.location.pathname).toBe('/projects/api/settings/connections');
    });
  });
});

describe('the section tables', () => {
  it('hide the administrator’s group from every other role, and from a session not yet read', () => {
    for (const role of ['maintainer', 'member', 'viewer', undefined] as const) {
      expect(orgSettingsGroupsFor(role).map((group) => group.label)).toEqual([
        'Personal',
        'Organisation',
        'People',
      ]);
    }
    expect(orgSettingsGroupsFor('admin').map((group) => group.label)).toContain('Operations');
  });
});

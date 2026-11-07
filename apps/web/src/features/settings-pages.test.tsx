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
  /** What a `PUT /api/org/budgets` answers, given its body — possibly later. */
  budgetAnswer: (body: unknown) => Answer | Promise<Answer>;
}

interface Answer {
  readonly status: number;
  readonly body: unknown;
}

let world: World;

const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  const path = new URL(url, 'http://localhost').pathname;
  world.requested.push(path);
  if (url.includes('/api/auth/get-session')) return json(session(world.role));
  if (path === '/api/org/budgets' && init?.method === 'PUT') {
    const body: unknown = JSON.parse(String(init.body));
    world.budgetPuts.push(body);
    const answer = await world.budgetAnswer(body);
    return json(answer.body, answer.status);
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
  if (path === '/api/org') return json({ settings: {}, updated_at: null });
  if (path === '/api/org/identities' || path === '/api/org/identities/candidates') {
    return json({ items: [] });
  }
  if (path === '/api/org/users' || path === '/api/integrations') return json({ items: [] });
  // S-26.8a: Your accounts' two reads — nothing linked, no code asked for.
  if (path === '/api/me/identities') return json({ items: [] });
  if (path === '/api/me/identity-links') return json({ code: null, matches: [] });
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
    budgetAnswer: () => ({ status: 200, body: {} }),
  };
});

/** Queries bound to one element (`within`). */
type Scope = ReturnType<typeof within>;

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
  it('opens /settings at the first section the administrator may change, with the NavList and the section marked current', async () => {
    open('/settings');
    const nav = await screen.findByRole('navigation', { name: 'Settings' });
    // S-25.6 (research/21 S13): Policies, not Session.
    await waitFor(() => {
      expect(window.location.pathname).toBe('/settings/policies');
    });
    expect(within(nav).getByRole('link', { name: 'Policies' }).getAttribute('aria-current')).toBe(
      'page',
    );
    // One dark theme (TD-033's 2026-11-05 amendment): no Appearance section and no theme control.
    expect(within(nav).queryByRole('link', { name: 'Appearance' })).toBeNull();
    // Every group, in order, for the administrator — the Admin group (Q-UX-1) among them.
    expect(
      within(nav)
        .getAllByRole('heading')
        .map((heading) => heading.textContent),
    ).toEqual(['Organisation', 'People', 'Admin', 'Operations', 'Personal']);
    // The Admin entries are the moved screens, at the URLs they always had.
    expect(
      ['Integrations', 'Workers', 'Audit log'].map((name) =>
        within(nav).getByRole('link', { name }).getAttribute('href'),
      ),
    ).toEqual(['/integrations', '/workers', '/audit']);
    expect(await screen.findByRole('heading', { name: 'Policies' })).toBeTruthy();
    expect(screen.queryByLabelText('Theme preference')).toBeNull();
  });

  it.each([
    ['admin', '/settings/policies', 'Policies'],
    ['maintainer', '/settings/budgets', 'Budgets'],
    ['member', '/settings/keyboard', 'Keyboard shortcuts'],
    ['viewer', '/settings/keyboard', 'Keyboard shortcuts'],
  ] as const)(
    'lands a %s on the first section the role may change: %s',
    async (role, path, name) => {
      world.role = role;
      open('/settings');
      await waitFor(() => {
        expect(window.location.pathname).toBe(path);
      });
      const nav = await screen.findByRole('navigation', { name: 'Settings' });
      expect(within(nav).getByRole('link', { name }).getAttribute('aria-current')).toBe('page');
    },
  );

  it('moves between sections through the NavList', async () => {
    open('/settings/session');
    const nav = await screen.findByRole('navigation', { name: 'Settings' });
    await userEvent.setup().click(within(nav).getByRole('link', { name: 'Instance' }));
    expect(await screen.findByRole('heading', { name: 'Instance' })).toBeTruthy();
    expect(window.location.pathname).toBe('/settings/instance');
    await waitFor(() => {
      expect(document.body.textContent).toContain('0.0.0-dev');
    });
  });

  it('redirects an unknown section to the one /settings opens', async () => {
    open('/settings/no-such-section');
    await waitFor(() => {
      expect(window.location.pathname).toBe('/settings/policies');
    });
    expect(await screen.findByRole('heading', { name: 'Policies' })).toBeTruthy();
  });

  it('redirects the retired Appearance bookmark like any unknown section, with no theme control anywhere', async () => {
    open('/settings/appearance');
    await waitFor(() => {
      expect(window.location.pathname).toBe('/settings/policies');
    });
    expect(await screen.findByRole('heading', { name: 'Policies' })).toBeTruthy();
    expect(screen.queryByLabelText('Theme preference')).toBeNull();
  });

  it('still opens Session where it is asked for by name', async () => {
    open('/settings/session');
    expect(await screen.findByRole('heading', { name: 'Session' })).toBeTruthy();
    expect(window.location.pathname).toBe('/settings/session');
  });

  it('shows the administrator’s sections to nobody else, and redirects their paths before any read', async () => {
    world.role = 'maintainer';
    open('/settings/dead-letters');
    // A maintainer lands on Budgets, the first section the role may change (S-25.6).
    await waitFor(() => {
      expect(window.location.pathname).toBe('/settings/budgets');
    });
    const nav = await screen.findByRole('navigation', { name: 'Settings' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual([
      'Policies',
      'Notifications',
      'Budgets',
      'Users',
      // The Admin group: Integrations and the Audit log are a maintainer's (`integration.read`,
      // `org.audit.read`), Workers everybody's own.
      'Integrations',
      'Workers',
      'Audit log',
      // Instance reads the public version: everybody's (review of PR #25).
      'Instance',
      'Session',
      'Keyboard shortcuts',
      // S-26.8a: a person's own accounts, everybody's.
      'Your accounts',
    ]);
    expect(world.requested).not.toContain('/api/org/dead-letters');
    // Linked accounts is the administrator's on the server (`org.users.manage`) too.
    cleanup();
    world.requested = [];
    open('/settings/identities');
    await waitFor(() => {
      expect(window.location.pathname).toBe('/settings/budgets');
    });
    expect(world.requested).not.toContain('/api/org/identities');
    cleanup();
    open('/settings/instance');
    expect(await screen.findByRole('heading', { name: 'Instance' })).toBeTruthy();
    expect(window.location.pathname).toBe('/settings/instance');
    // …and the other direction: the administrator's path renders the section and asks its read.
    cleanup();
    world.role = 'admin';
    world.requested = [];
    open('/settings/dead-letters');
    // S-25.6: the plain-words name (research/21 § 4); the URL is unchanged.
    expect(await screen.findByRole('heading', { name: 'Stuck events' })).toBeTruthy();
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

  it('shows the server’s refusal of a budget save beside its field, keeping the draft', async () => {
    world.budgetAnswer = () => ({
      status: 403,
      body: { error: { code: 'forbidden', message: 'role viewer may not perform budget.write' } },
    });
    open('/settings/budgets');
    const user = userEvent.setup();
    const month = await screen.findByLabelText('Per month');
    await waitFor(() => {
      expect((month as HTMLInputElement).value).toBe('40');
    });
    await user.clear(month);
    await user.type(month, '25');
    await user.click(screen.getByRole('button', { name: 'Save budgets' }));
    expect(await screen.findByText('Per month: the cap was not saved.')).toBeTruthy();
    expect(document.body.textContent).toContain('role viewer may not perform budget.write');
    // The draft survives the refusal, so nothing typed is lost.
    expect((screen.getByLabelText('Per month') as HTMLInputElement).value).toBe('25');
  });

  it('sends two changed windows in turn, stays pending until both settle, and keeps the first one’s refusal', async () => {
    // Review of PR #25: one mutation fired twice kept only the second call's state, so the day
    // cap's refusal vanished behind the week's success.
    let releaseDay: () => void = () => undefined;
    const dayAnswered = new Promise<void>((resolve) => {
      releaseDay = resolve;
    });
    world.budgetAnswer = (body) =>
      (body as { window: string }).window === 'day'
        ? dayAnswered.then(() => ({
            status: 403,
            body: { error: { code: 'forbidden', message: 'the day cap is refused' } },
          }))
        : { status: 200, body: {} };
    open('/settings/budgets');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Per day'), '5');
    await user.type(screen.getByLabelText('Per week'), '10');
    await user.click(screen.getByRole('button', { name: 'Save budgets' }));
    // The first window is in flight: the button is pending and the second has not been sent yet.
    const pending = await screen.findByRole('button', { name: 'Saving…' });
    expect((pending as HTMLButtonElement).disabled).toBe(true);
    expect(world.budgetPuts).toEqual([{ window: 'day', limit_usd: 5 }]);
    releaseDay();
    await waitFor(() => {
      expect(world.budgetPuts).toEqual([
        { window: 'day', limit_usd: 5 },
        { window: 'week', limit_usd: 10 },
      ]);
    });
    const day = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-budget-window="day"]');
      expect(found?.textContent).toContain('Per day: the cap was not saved.');
      return found as HTMLElement;
    });
    expect(day.textContent).toContain('the day cap is refused');
    expect(document.querySelector('[data-budget-window="week"]')?.textContent).not.toContain(
      'was not saved',
    );
    expect(await screen.findByRole('button', { name: 'Save budgets' })).toBeTruthy();
  });

  it.each([
    ['policies', (scope: Scope) => scope.findByLabelText('Organisation autonomy maximum')],
    ['notifications', (scope: Scope) => scope.findByLabelText('Organisation default chat account')],
    ['identities', (scope: Scope) => scope.findByRole('form', { name: 'Map a provider account' })],
    ['instance', (scope: Scope) => scope.findByText('0.0.0-dev')],
    ['session', (scope: Scope) => scope.findByText('Role: Administrator')],
    ['keyboard', (scope: Scope) => scope.findByRole('checkbox')],
    ['accounts', (scope: Scope) => scope.findByRole('button', { name: 'Link an account' })],
  ] as const)(
    'draws the %s section’s content inside a card, never on the page canvas (S-25.10b)',
    async (section, content) => {
      // The owner's rule (TD-033's 2026-11-05 amendment): the page is the canvas, a form or a
      // block of facts is a box on the card ground. Policies drew its form on the canvas while
      // Budgets drew its in a card; `test/web-e2e/settings-cards.spec.ts` holds every section in a
      // browser, this holds the ones that were found on it.
      open(`/settings/${section}`);
      const frame = await waitFor(() => {
        const found = document.querySelector<HTMLElement>('[data-settings-section]');
        expect(found?.getAttribute('data-settings-section')).toBe(section);
        return found as HTMLElement;
      });
      const card = (await content(within(frame))).closest('.bg-default');
      expect(card, section).not.toBeNull();
      expect(frame.contains(card)).toBe(true);
    },
  );

  it('draws each org section with at most one primary action', async () => {
    for (const group of ORG_SETTINGS_GROUPS) {
      for (const section of group.sections) {
        cleanup();
        // An Admin entry is a screen at its own URL, drawn in the same frame.
        open('to' in section ? section.to : `/settings/${section.id}`);
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

describe('a project’s settings on the card ground (S-25.10b, backlog 1292)', () => {
  it.each([
    ['trial', 'Open the trial page'],
    ['knowledge', 'Review drafted pages and pending proposals'],
  ] as const)('draws the %s section’s body inside a card', async (section, link) => {
    open(`/projects/api/settings/${section}`);
    const frame = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-settings-section]');
      expect(found?.getAttribute('data-settings-section')).toBe(section);
      return found as HTMLElement;
    });
    const card = (await within(frame).findByRole('link', { name: link })).closest('.bg-default');
    expect(card, section).not.toBeNull();
    expect(frame.contains(card)).toBe(true);
  });
});

describe('the section tables', () => {
  it('hide each section from a role below its own, and from a session not yet read', () => {
    const groups = (role: UserRole | undefined) =>
      orgSettingsGroupsFor(role).map((group) => [
        group.label,
        group.sections.map((section) => section.id),
      ]);
    expect(groups('maintainer')).toEqual([
      ['Organisation', ['policies', 'notifications', 'budgets']],
      ['People', ['users']],
      ['Admin', ['integrations', 'workers', 'audit']],
      ['Operations', ['instance']],
      ['Personal', ['session', 'keyboard', 'accounts']],
    ]);
    for (const role of ['member', 'viewer', undefined] as const) {
      expect(groups(role)).toEqual([
        ['Organisation', ['policies', 'notifications', 'budgets']],
        ['People', ['users']],
        ['Admin', ['workers']],
        ['Operations', ['instance']],
        ['Personal', ['session', 'keyboard', 'accounts']],
      ]);
    }
    expect(
      orgSettingsGroupsFor('admin').flatMap((group) => group.sections.map(({ id }) => id)),
    ).toEqual(ORG_SETTINGS_GROUPS.flatMap((group) => group.sections.map(({ id }) => id)));
  });
});

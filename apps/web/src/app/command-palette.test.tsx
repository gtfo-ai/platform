/**
 * The command palette (research/19 § 5.1): what it offers, how a query orders it, and — through the
 * whole app (`createApp` over a fake server) — that ⌘K, Ctrl+K, `/` and the top bar's button open
 * it, that typing filters and Enter goes, and that a project's name and a ticket's title are drawn
 * as text. Every option is asserted from data the fake server controls: a task is offered because
 * its project's tasks read answered it, never because the palette knows it.
 */
import type { ProjectSummary, TaskListItem, UserRole } from '@platform/contracts';
import { QueryClient } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionResponse } from '../auth/session.js';
import { createApp } from './app.js';
import { filterPalette, MAX_RESULTS, type PaletteItem, paletteItems } from './command-palette.js';
import { PALETTE_SCREENS } from './nav.js';
import { PROJECT_TABS } from './project-frame.js';

const HOSTILE_NAME = 'Acme <img src=x onerror="window.__pwned=true"> shop';
const HOSTILE_TITLE = 'Checkout <script>window.__pwned=true</script> button';

const project = (n: number, over: Partial<ProjectSummary> = {}): ProjectSummary => ({
  id: `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`,
  key: `p${n}`,
  name: `Project ${n}`,
  repo_url: `https://git.example.invalid/acme/p${n}.git`,
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
  ...over,
});

const ACME = project(1, { key: 'acme', name: HOSTILE_NAME });
const BILL = project(2, { key: 'bill', name: 'Billing' });

const task = (n: number, key: string, title: string | null, projectId = ACME.id): TaskListItem =>
  ({
    id: `00000000-0000-4000-8000-0000000003${String(n).padStart(2, '0')}`,
    project_id: projectId,
    ticket: { provider: 'jira', key, url: `https://tickets.example.invalid/${key}` },
    ticket_title: title,
    template: 'feature',
    mode: 'normal',
    state: 'active',
    current_stage: 'implementation',
    size: null,
    branch: null,
    mr_ref: null,
    workpad_ref: null,
    iteration_counters: {},
    risk_classes: [],
    coverage: null,
    dependencies: null,
    required_reviewers: null,
    review_threads: null,
    conflict: null,
    cost_actual_usd: 0,
    unmeasured_runs: 0,
    budget_cap_usd: 50,
    paused_reason: null,
    paused_budget_scope: null,
    cost_estimated_usd: 0,
    estimate_usd: null,
    estimate_basis: null,
    estimate_samples: null,
    estimate_accuracy: null,
    requested_by_user_id: null,
    requested_by_identity: null,
    created_at: '2026-06-01T09:00:00.000Z',
    updated_at: '2026-06-01T09:00:00.000Z',
    completed_at: null,
    ticket_claim: null,
    qa_stage: false,
    stages: [],
    open_questions: 0,
    pending_approvals: 0,
    loop_limits: null,
  }) as TaskListItem;

const TASKS = [task(1, 'ACME-21', HOSTILE_TITLE), task(2, 'ACME-22', null)];

interface World {
  readonly role?: UserRole;
  readonly canStart?: boolean;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fetchFor = (world: World) =>
  (async (input: RequestInfo | URL): Promise<Response> => {
    const path = new URL(String(input), 'http://app.example.invalid').pathname;
    if (path === '/api/auth/get-session') {
      const session: SessionResponse = {
        user: {
          id: '00000000-0000-4000-8000-000000000001',
          email: 'operator@example.invalid',
          name: 'Fake Operator',
          role: world.role ?? 'member',
        },
        session: { id: '00000000-0000-4000-8000-000000000002' },
      };
      return json(session);
    }
    if (path === '/api/setup-state') return json({ first_sign_in: false });
    if (path === '/events/subscriptions') return json({});
    if (path === '/api/projects') return json({ items: [ACME, BILL] });
    if (path === '/api/org/agents') return json({ items: [] });
    if (path === '/api/org/inbox') return json({ questions: [], approvals: [] });
    const tasks = /^\/api\/projects\/([^/]+)\/tasks$/.exec(path);
    if (tasks !== null) {
      return json({
        items: tasks[1] === ACME.id ? TASKS : [],
        next_cursor: null,
        can_start_task: world.canStart === true,
        can_cancel_task: true,
        can_return_to_stage: true,
        can_pause_task: true,
        can_resume_task: true,
      });
    }
    return json(
      { error: { code: 'not_found', message: 'the fake server has no such route' } },
      404,
    );
  }) as typeof fetch;

const start = (world: World, path: string) => {
  window.history.pushState({}, '', path);
  return render(
    createApp({
      queryClient: new QueryClient({
        defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
      }),
      fetchImpl: fetchFor(world),
      realtime: false,
    }).element,
  );
};

/** The palette, once its lazy chunk has loaded and the dialog is open. */
const palette = (): Promise<HTMLElement> =>
  screen.findByRole('dialog', { name: 'Search or jump to' });

const options = (dialog: HTMLElement): string[] =>
  within(dialog)
    .queryAllByRole('option')
    .map((option) => option.textContent ?? '');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const CONTEXT = {
  projects: [ACME, BILL],
  tasks: TASKS,
  current: null,
  canCreateProject: false,
  canStartTicket: false,
};

const labels = (items: readonly PaletteItem[]): string[] => items.map((item) => item.label);

describe('paletteItems', () => {
  it('offers every screen, project and cached task, and the actions the caller may take', () => {
    const items = paletteItems(CONTEXT);
    expect(items.filter((item) => item.group === 'Screen').map((item) => item.label)).toEqual(
      PALETTE_SCREENS.map((entry) => entry.label),
    );
    // S-25.6: the screens that left the top row are still a search away, at their own URLs.
    expect(
      items
        .filter((item) => item.group === 'Screen')
        .map((item) => (item.target.kind === 'screen' ? item.target.to : null)),
    ).toEqual([
      '/',
      '/projects',
      '/inbox',
      '/agents',
      '/stats',
      '/settings',
      '/integrations',
      '/workers',
      '/audit',
    ]);
    expect(items.filter((item) => item.group === 'Project').map((item) => item.label)).toEqual([
      HOSTILE_NAME,
      'Billing',
    ]);
    expect(items.filter((item) => item.group === 'Task').map((item) => item.label)).toEqual([
      'ACME-21',
      'ACME-22',
    ]);
    // A member outside a project: neither New project nor Start a ticket.
    expect(labels(items.filter((item) => item.group === 'Action'))).toEqual([
      'Open inbox',
      'Keyboard shortcuts',
    ]);
  });

  it('adds New project for an administrator, and Start a ticket and the tabs inside a project that allows it', () => {
    const inside = paletteItems({
      ...CONTEXT,
      current: ACME,
      canCreateProject: true,
      canStartTicket: true,
    });
    const actions = labels(inside.filter((item) => item.group === 'Action'));
    expect(actions).toContain('New project');
    expect(actions).toContain('Start a ticket in this project');
    expect(inside.filter((item) => item.target.kind === 'tab').map((item) => item.label)).toEqual(
      PROJECT_TABS.map((tab) => tab.label),
    );
    // Inside a project that does not allow it, no Start a ticket — the flag, not the place, decides.
    const refused = paletteItems({ ...CONTEXT, current: ACME, canStartTicket: false });
    expect(labels(refused)).not.toContain('Start a ticket in this project');
  });

  it('offers a task once even when two cached reads hold it, and finds its project’s key', () => {
    const items = paletteItems({ ...CONTEXT, tasks: [...TASKS, TASKS[0] as TaskListItem] });
    const tasks = items.filter((item) => item.group === 'Task');
    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.target).toEqual({ kind: 'task', taskId: TASKS[0]?.id, projectKey: 'acme' });
    const orphan = paletteItems({ ...CONTEXT, projects: [] }).find((item) => item.group === 'Task');
    expect(orphan?.target).toEqual({ kind: 'task', taskId: TASKS[0]?.id, projectKey: null });
  });
});

describe('filterPalette', () => {
  const items = paletteItems(CONTEXT);

  it('shows everything but the tasks for an empty query', () => {
    const shown = filterPalette(items, '  ');
    expect(shown.some((item) => item.group === 'Task')).toBe(false);
    expect(shown).toHaveLength(items.filter((item) => item.group !== 'Task').length);
  });

  it('finds a task by its ticket key, case-insensitively, and by its title', () => {
    expect(labels(filterPalette(items, 'acme-21'))).toEqual(['ACME-21']);
    expect(labels(filterPalette(items, 'checkout'))).toEqual(['ACME-21']);
  });

  it('puts a word that starts with the query before one that only contains it', () => {
    // "in" starts "Inbox", "Integrations" and "Open inbox"'s second word; it is only inside "Billing".
    const found = labels(filterPalette(items, 'in'));
    expect(found.indexOf('Billing')).toBeGreaterThan(found.indexOf('Inbox'));
    expect(found.indexOf('Billing')).toBeGreaterThan(found.indexOf('Integrations'));
    expect(found).toContain('Billing');
  });

  it('keeps at most MAX_RESULTS', () => {
    const many = paletteItems({
      ...CONTEXT,
      tasks: Array.from({ length: MAX_RESULTS + 10 }, (_, index) =>
        task(index + 10, `ACME-${String(index + 100)}`, null),
      ),
    });
    expect(filterPalette(many, 'acme-')).toHaveLength(MAX_RESULTS);
  });
});

describe('the palette in the app', () => {
  it('opens with ⌘K, filters as you type, and Enter goes to the task by its key', async () => {
    const user = userEvent.setup();
    // The board's read is what puts ACME's tasks in the cache.
    start({}, '/projects/acme');
    // The board's card is drawn from the tasks read: once it is, the read is in the cache. The
    // board is a lazy chunk, so the bound is wider than the default under a loaded machine.
    expect(
      (await screen.findAllByText('ACME-21', undefined, { timeout: 5000 })).length,
    ).toBeGreaterThan(0);
    await user.keyboard('{Meta>}k{/Meta}');
    const dialog = await palette();
    const field = within(dialog).getByRole('combobox', { name: 'Search or jump to' });
    expect(document.activeElement).toBe(field);
    await user.type(field, 'acme-21');
    expect(options(dialog)).toEqual([expect.stringContaining('ACME-21')]);
    // The active option is the field's `aria-activedescendant`, and it is the one Enter takes.
    const [only] = within(dialog).getAllByRole('option');
    expect(field.getAttribute('aria-activedescendant')).toBe(only?.id);
    expect(only?.getAttribute('aria-selected')).toBe('true');
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(window.location.pathname).toBe(`/projects/acme/tasks/${TASKS[0]?.id ?? ''}`);
    });
    expect(screen.queryByRole('dialog', { name: 'Search or jump to' })).toBeNull();
  });

  it('opens with Ctrl+K and with /, and ↓ moves the active option before Enter takes it', async () => {
    const user = userEvent.setup();
    start({}, '/');
    await screen.findByRole('banner');
    await user.keyboard('{Control>}k{/Control}');
    let dialog = await palette();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Search or jump to' })).toBeNull();
    });
    await user.keyboard('/');
    dialog = await palette();
    const field = within(dialog).getByRole('combobox');
    // `/` opened it and was not typed into it.
    expect((field as HTMLInputElement).value).toBe('');
    await user.type(field, 'proj');
    // "Projects" (a screen) first, then "Project …" names? None: the fixtures are Acme and Billing.
    expect(options(dialog)).toEqual([expect.stringMatching(/^Projects/)]);
    await user.clear(field);
    await user.type(field, 'in');
    const before = field.getAttribute('aria-activedescendant');
    await user.keyboard('{ArrowDown}');
    const after = field.getAttribute('aria-activedescendant');
    expect(after).not.toBe(before);
    const target = document.getElementById(after ?? '');
    expect(target?.getAttribute('aria-selected')).toBe('true');
    expect(target?.textContent).toMatch(/^Integrations/);
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(window.location.pathname).toBe('/integrations');
    });
  });

  it('opens from the top bar’s button and returns the focus to it on Escape', async () => {
    const user = userEvent.setup();
    start({}, '/');
    const button = await within(await screen.findByRole('banner')).findByRole('button', {
      name: 'Search or jump to…',
    });
    await user.click(button);
    await palette();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(document.activeElement).toBe(button);
    });
  });

  it('draws a project’s name and a ticket’s title as text, never as markup', async () => {
    const user = userEvent.setup();
    start({}, '/projects/acme');
    // The board's card is drawn from the tasks read: once it is, the read is in the cache. The
    // board is a lazy chunk, so the bound is wider than the default under a loaded machine.
    expect(
      (await screen.findAllByText('ACME-21', undefined, { timeout: 5000 })).length,
    ).toBeGreaterThan(0);
    await user.keyboard('{Meta>}k{/Meta}');
    const dialog = await palette();
    await user.type(within(dialog).getByRole('combobox'), 'acme');
    expect(within(dialog).getAllByText(HOSTILE_NAME).length).toBeGreaterThan(0);
    await user.clear(within(dialog).getByRole('combobox'));
    await user.type(within(dialog).getByRole('combobox'), 'checkout');
    expect(within(dialog).getByText(HOSTILE_TITLE)).toBeTruthy();
    expect(dialog.querySelector('img, script')).toBeNull();
    expect((window as { __pwned?: boolean }).__pwned).toBeUndefined();
  });

  it('Start a ticket in this project opens the board’s start form, only where the read allows it', async () => {
    const user = userEvent.setup();
    start({ canStart: true }, '/projects/acme/knowledge');
    await screen.findByRole('banner');
    await user.keyboard('{Meta>}k{/Meta}');
    const dialog = await palette();
    await user.type(within(dialog).getByRole('combobox'), 'start a ticket');
    await waitFor(() => {
      expect(options(dialog)).toEqual([expect.stringContaining('Start a ticket in this project')]);
    });
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(window.location.pathname).toBe('/projects/acme');
      expect(window.location.hash).toBe('#start-ticket');
    });
    cleanup();
    start({ canStart: false }, '/projects/acme');
    await user.keyboard('{Meta>}k{/Meta}');
    const refused = await palette();
    await user.type(within(refused).getByRole('combobox'), 'start a ticket');
    expect(options(refused)).toEqual([]);
    expect(within(refused).getByText(/A task is found by its ticket key/)).toBeTruthy();
    expect(within(refused).getByRole('status').textContent).toBe('Nothing matches.');
  });
});

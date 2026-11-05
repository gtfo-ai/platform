/**
 * The frame of every signed-in screen (S-23.4; TD-033 § 1, research/19 § 5.1) — the top bar, the
 * organisation's navigation, the project's layout route and the `/projects` list — driven through
 * `createApp` with a fake server, so the real router, query client, strict endpoint parsers and
 * realtime provider are in the path.
 *
 * Each claim the frame makes is asserted from data the fake server controls, never from a constant
 * the component also reads: the running count is the agents read's length, the inbox count is
 * questions plus approvals, the switcher lists exactly the projects read, *Start a ticket* exists
 * only when the tasks read says `can_start_task`, and the connection's live region keeps the exact
 * word the realtime spec asserts.
 */
import type { ProjectSummary, RunRecord } from '@platform/contracts';
import { QueryClient } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionResponse } from '../auth/session.js';
import { createApp } from './app.js';
import { NAV } from './shell.js';

const SESSION: SessionResponse = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'operator@example.invalid',
    name: 'Fake Operator',
    role: 'member',
  },
  session: { id: '00000000-0000-4000-8000-000000000002' },
};

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

const run = (n: number): RunRecord => ({
  id: `00000000-0000-4000-8000-0000000002${String(n).padStart(2, '0')}`,
  task_id: '00000000-0000-4000-8000-0000000003a1',
  project_id: project(1).id,
  stage: 'implementation',
  role: 'developer',
  mode: 'normal',
  attempt: 1,
  session_id: null,
  model: 'claude-test',
  effort: 'high',
  provider_mode: 'api',
  prompt_version: 'test@1',
  status: 'running',
  terminal_reason: null,
  started_at: '2026-10-06T10:00:00.000Z',
  ended_at: null,
  last_output_at: null,
  num_turns: 3,
  usage: {
    input_tokens: 1,
    output_tokens: 1,
    cache_write_5m_tokens: 0,
    cache_write_1h_tokens: 0,
    cache_read_tokens: 0,
  },
  model_usage: [],
  cost: null,
  wall_ms: 0,
  redaction_count: 0,
  settings_hash: null,
  start_failure: null,
  saved_work: null,
  latest_progress: null,
});

const question = (n: number) => ({
  id: `00000000-0000-4000-8000-0000000004${String(n).padStart(2, '0')}`,
  task_id: '00000000-0000-4000-8000-0000000003a1',
  stage: 'refinement',
  run_id: null,
  text: 'Which currency?',
  options: null,
  blocking: true,
  status: 'open',
  asked_at: '2026-10-06T10:00:00.000Z',
  deadline_at: null,
  reminders_sent: 0,
  answer: null,
  answered_by_user_id: null,
  answered_via: null,
  answered_at: null,
});

const approval = (n: number) => ({
  id: `00000000-0000-4000-8000-0000000005${String(n).padStart(2, '0')}`,
  task_id: '00000000-0000-4000-8000-0000000003a1',
  kind: 'plan',
  status: 'pending',
  requested_at: '2026-10-06T10:00:00.000Z',
  deadline_at: null,
  decided_by_user_id: null,
  decided_at: null,
  reason: null,
});

interface World {
  readonly projects: readonly ProjectSummary[];
  readonly running?: number;
  readonly questions?: number;
  readonly approvals?: number;
  readonly canStart?: boolean;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fetchFor = (world: World) =>
  (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    const path = new URL(url, 'http://app.example.invalid').pathname;
    if (path === '/api/auth/get-session') return json(SESSION);
    if (path === '/api/setup-state') return json({ first_sign_in: false });
    if (path === '/events/subscriptions') return json({});
    if (path === '/api/projects') return json({ items: world.projects });
    if (path === '/api/org/agents') {
      return json({
        items: Array.from({ length: world.running ?? 0 }, (_, index) => {
          const item = run(index + 1);
          return {
            run: item,
            project_id: item.project_id,
            task_id: item.task_id,
            role: item.role,
            last_output_at: null,
          };
        }),
      });
    }
    if (path === '/api/org/inbox') {
      return json({
        questions: Array.from({ length: world.questions ?? 0 }, (_, index) => question(index + 1)),
        approvals: Array.from({ length: world.approvals ?? 0 }, (_, index) => approval(index + 1)),
      });
    }
    if (/^\/api\/projects\/[^/]+\/tasks$/.test(path)) {
      return json({ items: [], next_cursor: null, can_start_task: world.canStart === true });
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

/** The top bar, once the authenticated route has rendered it. */
const banner = (): Promise<HTMLElement> => screen.findByRole('banner');

describe('the top bar', () => {
  it('counts the runs in flight from the agents read and links them to Agents', async () => {
    start({ projects: [project(1)], running: 3 }, '/');
    const link = await within(await banner()).findByRole('link', { name: '3 running' });
    expect(link.getAttribute('href')).toBe('/agents');
    // Something runs, so the dot is the animated beacon (reduced motion is the stylesheet's).
    expect(link.querySelector('[data-status="running"]')?.className).toContain('status-running');
  });

  it('says 0 running without the pulse, and no number at all before the read answers', async () => {
    start({ projects: [project(1)], running: 0 }, '/');
    const link = await within(await banner()).findByRole('link', { name: '0 running' });
    expect(link.querySelector('.status-running')).toBeNull();
    cleanup();
    // A read that fails is a number the frame does not know: no "0 running" is invented.
    window.history.pushState({}, '', '/');
    render(
      createApp({
        fetchImpl: (async (input: RequestInfo | URL) =>
          String(input).includes('/api/auth/get-session')
            ? json(SESSION)
            : json({ error: { code: 'not_found', message: 'no' } }, 404)) as typeof fetch,
        realtime: false,
      }).element,
    );
    expect(await within(await banner()).findByRole('link', { name: 'Agents' })).toBeTruthy();
    expect(within(await banner()).queryByText(/running/)).toBeNull();
  });

  it('counts open questions plus pending approvals on the inbox button', async () => {
    start({ projects: [project(1)], questions: 2, approvals: 3 }, '/');
    const inbox = await within(await banner()).findByRole('link', {
      name: 'Open the inbox, 5 waiting for you',
    });
    expect(inbox.getAttribute('href')).toBe('/inbox');
    expect(inbox.querySelector('[data-counter]')?.textContent).toBe('5');
    cleanup();
    start({ projects: [project(1)] }, '/');
    const empty = await within(await banner()).findByRole('link', {
      name: 'Open the inbox, nothing waiting for you',
    });
    expect(empty.querySelector('[data-counter]')).toBeNull();
  });

  it('keeps the connection’s live region and its exact word inside the indicator', async () => {
    start({ projects: [project(1)] }, '/');
    const status = await screen.findByTestId('connection-status');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    // `realtime: false` leaves the client idle: the word is the one `connectionLabel` gives it,
    // and the live region's whole text is that word (the realtime spec reads it with `toHaveText`).
    expect(status.textContent).toBe('Idle');
    expect(status.querySelector('[data-connection-dot]')).toBeTruthy();
    expect((await banner()).contains(status)).toBe(true);
  });

  it('shows the project switcher only inside a project, listing every project with the current checked', async () => {
    const user = userEvent.setup();
    start({ projects: [project(1), project(2, { name: 'Billing' })] }, '/');
    await within(await banner()).findByRole('link', { name: '0 running' });
    expect(within(await banner()).queryByRole('button', { name: /switch project/ })).toBeNull();
    cleanup();

    start({ projects: [project(1), project(2, { name: 'Billing' })] }, '/projects/p2/knowledge');
    const trigger = await within(await banner()).findByRole('button', {
      name: 'Billing, switch project',
    });
    await user.click(trigger);
    const menu = await screen.findByRole('menu');
    const items = within(menu).getAllByRole('menuitemradio');
    expect(items.map((item) => item.textContent)).toEqual(['p1Project 1', 'p2Billing']);
    expect(items.map((item) => item.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    await user.click(items[0] as HTMLElement);
    await waitFor(() => {
      expect(window.location.pathname).toBe('/projects/p1');
    });
    expect(
      await within(await banner()).findByRole('button', { name: 'Project 1, switch project' }),
    ).toBeTruthy();
  });

  it('offers New project everywhere and Start a ticket only where the caller may start one', async () => {
    const user = userEvent.setup();
    start({ projects: [project(1)], canStart: true }, '/');
    await user.click(await within(await banner()).findByRole('button', { name: 'Create new…' }));
    let menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['New project']);
    cleanup();

    start({ projects: [project(1)], canStart: false }, '/projects/p1');
    await screen.findByRole('heading', { level: 1, name: /Project 1/ });
    await user.click(within(await banner()).getByRole('button', { name: 'Create new…' }));
    menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: 'Start a ticket…' })).toBeNull();
    cleanup();

    start({ projects: [project(1)], canStart: true }, '/projects/p1/pipeline');
    await screen.findByRole('link', { name: 'Start a ticket' });
    await user.click(within(await banner()).getByRole('button', { name: 'Create new…' }));
    menu = await screen.findByRole('menu');
    await user.click(within(menu).getByRole('menuitem', { name: 'Start a ticket…' }));
    await waitFor(() => {
      expect(`${window.location.pathname}${window.location.hash}`).toBe(
        '/projects/p1#start-ticket',
      );
    });
    // The board's form takes the focus, so the next keystroke is the key.
    const field = await screen.findByLabelText('Start a ticket');
    await waitFor(() => {
      expect(document.activeElement).toBe(field);
    });
  });
});

describe('the organisation navigation', () => {
  it('is NAV, in order, with Home current on Home and the counts beside their entries', async () => {
    start({ projects: [project(1), project(2)], running: 1, questions: 4 }, '/');
    const nav = await screen.findByRole('navigation', { name: 'Primary' });
    await within(nav).findByRole('link', { name: 'Projects 2' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual(NAV.map((entry) => entry.to));
    // Exactly one current entry: the router's own active marking does not add a second.
    expect(links.filter((link) => link.hasAttribute('aria-current'))).toHaveLength(1);
    expect(within(nav).getByRole('link', { name: 'Home' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'Inbox 4' })).toBeTruthy();
    expect(within(nav).getByRole('link', { name: 'Agents 1' })).toBeTruthy();
    // Onboarding is not an entry: it is New project.
    expect(NAV.map((entry) => entry.label)).not.toContain('Onboarding');
    expect(NAV[0]?.label).toBe('Home');
  });

  it('marks the section of a nested path current, and gives way to the project tabs inside a project', async () => {
    start({ projects: [project(1)] }, '/workers/approve');
    const nav = await screen.findByRole('navigation', { name: 'Primary' });
    expect(within(nav).getByRole('link', { name: 'Workers' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'Home' }).hasAttribute('aria-current')).toBe(
      false,
    );
    cleanup();
    start({ projects: [project(1)] }, '/projects/p1');
    await screen.findByRole('navigation', { name: 'Project' });
    expect(screen.queryByRole('navigation', { name: 'Primary' })).toBeNull();
  });
});

describe('the project layout route', () => {
  it('draws the header and the tabs over the board, with no URL changed', async () => {
    start({ projects: [project(1, { readiness_level: 3 })], canStart: true }, '/projects/p1');
    const heading = await screen.findByRole('heading', { level: 1 });
    expect(heading.textContent).toBe('Project 1p1');
    expect(screen.getByText('L3 Agent-ready')).toBeTruthy();
    const tabs = screen.getByRole('navigation', { name: 'Project' });
    const links = within(tabs).getAllByRole('link');
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Board', '/projects/p1'],
      ['Knowledge', '/projects/p1/knowledge'],
      ['Pipeline', '/projects/p1/pipeline'],
      ['Budgets', '/projects/p1/budgets'],
      ['Shadow', '/projects/p1/shadow'],
      ['Settings', '/projects/p1/settings'],
    ]);
    expect(within(tabs).getByRole('link', { name: 'Board' }).getAttribute('aria-current')).toBe(
      'page',
    );
    // The page's one primary action, to the board's start form.
    const primary = await screen.findByRole('link', { name: 'Start a ticket' });
    expect(primary.hasAttribute('aria-current')).toBe(false);
    expect(primary.getAttribute('href')).toBe('/projects/p1#start-ticket');
    // The board is the index child, and its old underlined links to the sub-pages are gone.
    expect(await screen.findByRole('region', { name: 'Queued' })).toBeTruthy();
    const main = screen.getByRole('main');
    expect(
      within(main)
        .queryAllByRole('link', { name: 'Knowledge' })
        .filter((link) => !tabs.contains(link)),
    ).toEqual([]);
  });

  it('marks the sub-page’s tab, and omits Start a ticket for a caller who may not start one', async () => {
    start({ projects: [project(1)], canStart: false }, '/projects/p1/budgets');
    const tabs = await screen.findByRole('navigation', { name: 'Project' });
    expect(within(tabs).getByRole('link', { name: 'Budgets' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(within(tabs).getByRole('link', { name: 'Board' }).hasAttribute('aria-current')).toBe(
      false,
    );
    expect(screen.queryByRole('link', { name: 'Start a ticket' })).toBeNull();
  });

  it('keeps a task’s page on the Board tab and leaves the page its own h1', async () => {
    start({ projects: [project(1)] }, '/projects/p1/tasks/00000000-0000-4000-8000-0000000003a1');
    const tabs = await screen.findByRole('navigation', { name: 'Project' });
    expect(within(tabs).getByRole('link', { name: 'Board' }).getAttribute('aria-current')).toBe(
      'page',
    );
    const frame = document.querySelector('[data-project-frame]');
    expect(frame?.textContent).toContain('Project 1');
    expect(frame?.querySelector('h1')).toBeNull();
  });

  it('says an unknown key once and renders no page below it', async () => {
    start({ projects: [project(1)] }, '/projects/nope/knowledge');
    expect(await screen.findByText('No such project')).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Project' })).toBeNull();
    expect(screen.getAllByText('No such project')).toHaveLength(1);
  });
});

describe('the projects list', () => {
  it('lists every project with its key, readiness, open tasks and spend, under one primary action', async () => {
    start(
      {
        projects: [
          project(1, { readiness_level: 0, open_tasks: 4, spent_usd_30d: 12.5 }),
          project(2, { name: 'Billing', status: 'paused' }),
        ],
      },
      '/projects',
    );
    const list = await screen.findByRole('list', { name: 'Projects' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    const first = rows[0] as HTMLElement;
    expect(within(first).getByRole('link', { name: 'Project 1' }).getAttribute('href')).toBe(
      '/projects/p1',
    );
    expect(first.textContent).toContain('p1');
    expect(first.textContent).toContain('L0 Unverified');
    expect(first.textContent).toContain('4 open');
    expect(first.textContent).toContain('$12.50');
    expect((rows[1] as HTMLElement).textContent).toContain('paused');
    expect(screen.getByText('2 projects')).toBeTruthy();
    const main = screen.getByRole('main');
    expect(within(main).getByRole('heading', { level: 1, name: 'Projects' })).toBeTruthy();
    const action = within(main).getByRole('link', { name: 'New project' });
    expect(action.getAttribute('href')).toBe('/onboarding');
    // The org navigation marks Projects current on its own page.
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(nav).getByRole('link', { name: 'Projects 2' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('teaches when there is no project, and offers New project', async () => {
    start({ projects: [] }, '/projects');
    expect(await screen.findByText('No projects yet')).toBeTruthy();
    const main = screen.getByRole('main');
    const actions = within(main).getAllByRole('link', { name: 'New project' });
    expect(actions.map((link) => link.getAttribute('href'))).toEqual([
      '/onboarding',
      '/onboarding',
    ]);
    expect(within(main).queryByRole('list', { name: 'Projects' })).toBeNull();
  });
});

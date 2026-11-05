/**
 * The *Add a worker* wizard (S-23.20) through `createApp` with a fake server, so the real router
 * (and its validated `?step=&since=&installed=`), the real query client and the real endpoint
 * parsers are in the path.
 *
 * Held here: every step is reachable in order and none past a step that may not be passed; Install
 * is the person's word; the commands carry this platform's origin; the Claude sign-in and the three
 * troubleshooting items say what the owner's setup log needed; Approve is done only once a new
 * worker of this person appears — read again every 5 s on that step, and not on Install; Ready
 * lists the blockers in words; the last step links each project's Execution settings and ends on
 * its board; every step has exactly one primary button; a worker's name is rendered as text.
 */
import type { ProjectExecutionResponse, ProjectSummary, WorkerSummary } from '@platform/contracts';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';
import { WORKER_CLAIM_BLOCKER_WORDS } from '../ui/humanize.js';
import { NOW, USER_ID, workerFixture } from './worker.test-fixture.js';
import { WATCH_INTERVAL_MS } from './worker-wizard.js';

/** The wizard was opened a minute before the clock the app reads. */
const SINCE = new Date(NOW - 60_000).toISOString();

const session = (role: 'admin' | 'member'): SessionResponse => ({
  user: { id: USER_ID, email: 'jan@example.invalid', name: 'Jan Example', role },
  session: { id: '00000000-0000-4000-8000-000000000002' },
});

const project = (n: number, key: string, name: string): ProjectSummary => ({
  id: `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`,
  key,
  name,
  repo_url: `https://git.example.test/acme/${key}.git`,
  default_branch: 'main',
  agentic_dir: '.agentic',
  knowledge_dir: '.agentic/knowledge',
  autonomy_level: 'supervised',
  readiness_level: 1,
  status: 'active',
  created_at: `2026-10-0${n}T04:00:00.000Z`,
  updated_at: `2026-10-0${n}T04:00:00.000Z`,
  open_tasks: 0,
  spent_usd_30d: 0,
});

const execution = (mode: ProjectExecutionResponse['mode']): ProjectExecutionResponse => ({
  mode,
  prefer: 'server',
  fallback_after_seconds: null,
  assignee_window_seconds: 120,
  offer_timeout_seconds: 86_400,
  effective_fallback_after_seconds: 15,
  stored: true,
  server_claimant: 'none',
  notice: null,
  workers: [],
  waiting: {
    open: 0,
    closed_to_workers: { credential_refused: 0, server_only: 0, server_first: 0 },
  },
});

interface World {
  role: 'admin' | 'member';
  workers: WorkerSummary[];
  projects: { summary: ProjectSummary; execution: ProjectExecutionResponse }[];
  asked: string[];
}

const newWorld = (over: Partial<World> = {}): World => ({
  role: 'admin',
  workers: [],
  projects: [
    { summary: project(1, 'srv', 'Server Things'), execution: execution('server_only') },
    { summary: project(2, 'web', 'Web App'), execution: execution('workers_only') },
  ],
  asked: [],
  ...over,
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fetchFor = (world: World) =>
  (async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(String(input), 'http://localhost');
    const path = url.pathname;
    world.asked.push(path);
    if (path.startsWith('/api/auth/get-session')) return json(session(world.role));
    if (path === '/api/workers') {
      return json({ items: world.workers, scope: 'own', timezone: 'UTC' });
    }
    if (path === '/api/projects') {
      return json({ items: world.projects.map((entry) => entry.summary) });
    }
    const read = /^\/api\/projects\/([^/]+)\/execution$/.exec(path);
    const found = world.projects.find((entry) => entry.summary.id === read?.[1]);
    if (found !== undefined) return json(found.execution);
    if (path === '/api/org/inbox') return json({ questions: [], approvals: [] });
    if (path === '/api/org/agents') return json({ items: [] });
    return json({ error: { code: 'not_found', message: `no route ${path}` } }, 404);
  }) as typeof fetch;

const start = (world: World, url: string) => {
  window.history.pushState({}, '', url);
  return render(createApp({ fetchImpl: fetchFor(world), now: () => NOW, realtime: false }).element);
};

const wizardUrl = (step: string, extra = '') => `/workers/new?step=${step}&since=${SINCE}${extra}`;

/** The step's primary buttons: the beacon tone's own border class, which nothing else draws. */
const primaries = () =>
  [...document.querySelectorAll('main a, main button')].filter((element) =>
    element.className.includes('border-primary-line'),
  );

const stepStates = () =>
  within(screen.getByRole('list', { name: 'Worker setup steps' }))
    .getAllByRole('listitem')
    .map((item) => item.getAttribute('data-step-state'));

const continueButton = (name: RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('Add a worker: Install', () => {
  it('lists every step, shows the commands with this platform’s origin and continues only on the person’s word', async () => {
    start(newWorld(), '/workers/new');
    expect(await screen.findByRole('heading', { level: 2, name: 'Install' })).toBeTruthy();
    // With no `?since=` the wizard writes one into the URL, so it can be resumed.
    await waitFor(() =>
      expect(new URLSearchParams(window.location.search).get('since')).toBeTruthy(),
    );
    expect(
      within(screen.getByRole('list', { name: 'Worker setup steps' }))
        .getAllByRole('listitem')
        .map((item) => item.textContent?.replace(/^\d/, '')),
    ).toEqual([
      'Install, Current step',
      'Start it and sign in, Not started',
      'Approve, Not started',
      'Ready to work, Not started',
      'Choose projects, Not startedOptional',
    ]);

    const origin = window.location.origin;
    // INSTALLER_AVAILABLE (S-23.24): the macOS/Linux one-liner leads, with its script to read; no
    // Windows line yet (BACKLOG 984), and the by-hand setup is behind *Set it up by hand*.
    const installer = document.querySelector('[data-installer="unix"]') as HTMLElement;
    expect(installer.closest('details')).toBeNull();
    expect(
      (within(installer).getByLabelText('macOS or Linux (Terminal)') as HTMLInputElement).value,
    ).toBe(`curl -fsSL '${origin}/api/worker/v1/install.sh' | sh`);
    expect(
      within(installer).getByRole('link', { name: 'Read the script first' }).getAttribute('href'),
    ).toBe(`${origin}/api/worker/v1/install.sh`);
    expect(screen.getByText('Windows: coming next.')).toBeTruthy();
    expect(document.querySelector('[data-installer="windows"]')).toBeNull();
    expect(screen.queryByText(/install\.ps1|iex/)).toBeNull();

    const byHand = document.querySelector('[data-by-hand]') as HTMLElement;
    expect(byHand.closest('details')?.querySelector('summary')?.textContent).toBe(
      'Set it up by hand',
    );
    expect((within(byHand).getByLabelText('Start the worker') as HTMLInputElement).value).toBe(
      `docker compose --env-file .env.worker -f compose.worker.yml up -d`,
    );
    const download = within(byHand).getByLabelText(
      'Download the worker’s compose file',
    ) as HTMLInputElement;
    expect(download.value).toBe(
      `curl -fsSo compose.worker.yml ${origin}/api/worker/v1/compose.yml`,
    );
    const env = within(byHand).getByLabelText(
      'Then create a file named .env.worker beside it, with this line',
    ) as HTMLInputElement;
    expect(env.value).toBe(`APP_CORE_URL=${origin}`);
    expect(screen.getByText(/Docker running on that computer/)).toBeTruthy();
    expect(screen.getByText(/A Claude subscription/)).toBeTruthy();

    const next = continueButton(/Continue to Start it and sign in/);
    expect(next.disabled).toBe(true);
    expect(screen.getByText(/Tick “I’ve done this”/)).toBeTruthy();
    expect(primaries()).toHaveLength(1);

    fireEvent.click(screen.getByRole('checkbox', { name: 'I’ve done this' }));
    await waitFor(() =>
      expect(continueButton(/Continue to Start it and sign in/).disabled).toBe(false),
    );
    expect(new URLSearchParams(window.location.search).get('installed')).toBe('true');
    fireEvent.click(continueButton(/Continue to Start it and sign in/));
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Start it and sign in' }),
    ).toBeTruthy();
    expect(stepStates()).toEqual(['done', 'current', 'upcoming', 'upcoming', 'upcoming']);
  });

  it('asks for the workers once on Install, never on a 5 s watch', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const world = newWorld();
    start(world, wizardUrl('install'));
    await screen.findByRole('heading', { level: 2, name: 'Install' });
    await waitFor(() =>
      expect(world.asked.filter((path) => path === '/api/workers')).toHaveLength(1),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WATCH_INTERVAL_MS * 3);
    });
    expect(world.asked.filter((path) => path === '/api/workers')).toHaveLength(1);
  });
});

describe('Add a worker: Start it and sign in', () => {
  it('explains the Claude token exactly, gives the start command and the three troubleshooting items', async () => {
    start(newWorld(), wizardUrl('start', '&installed=true'));
    await screen.findByRole('heading', { level: 2, name: 'Start it and sign in' });
    const token = document.querySelector('[data-setup-token]')?.textContent ?? '';
    expect(token).toContain('Build something great — you can close this window');
    expect(token).toContain('terminal');
    expect(token).toMatch(/wrap over\s+two lines; join them/);
    expect(token).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(token).toContain('Don’t authorize again: every run creates a new token.');
    // The hand-made sign-in is the fallback, behind a disclosure; the worker's page is the way.
    expect(token.length).toBeGreaterThan(0);
    expect(document.querySelector('[data-setup-token]')?.closest('details')?.textContent).toContain(
      'If you set it up by hand',
    );
    expect(screen.getByText(/walks you through signing in to Claude/)).toBeTruthy();
    expect(
      (screen.getByLabelText('Run this in the worker’s folder') as HTMLInputElement).value,
    ).toBe('claude setup-token');
    expect((screen.getByLabelText('Then start the worker again') as HTMLInputElement).value).toBe(
      'docker compose --env-file .env.worker -f compose.worker.yml up -d',
    );
    expect(screen.getByRole('link', { name: 'http://127.0.0.1:7357' })).toBeTruthy();

    const trouble = within(screen.getByRole('region', { name: 'Troubleshooting' }));
    expect(trouble.getByText('Safari can’t connect to localhost:…/callback')).toBeTruthy();
    expect(trouble.getByText(/stopped before you authorized/)).toBeTruthy();
    expect(
      trouble.getByText('Downloading the script or compose.yml answers 503 or 426'),
    ).toBeTruthy();
    expect(trouble.getByText(/needs an update/)).toBeTruthy();
    expect(trouble.getByText('The page at 127.0.0.1:7357 doesn’t open')).toBeTruthy();
    expect(
      (trouble.getByLabelText('Show the worker’s containers') as HTMLInputElement).value,
    ).toContain(' ps');

    // A person may already hold the code: Continue is not held here.
    expect(continueButton(/Continue to Approve/).disabled).toBe(false);
    expect(primaries()).toHaveLength(1);
  });

  it('refuses a deep link past Install while it is not done', async () => {
    start(newWorld(), wizardUrl('approve'));
    expect(await screen.findByText('Approve is not open yet')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to Install' })).toBeTruthy();
  });
});

describe('Add a worker: Approve', () => {
  it('is done only once a new worker of this person appears, read again every 5 s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const world = newWorld({
      // Created before the wizard opened, and somebody else's: neither is this wizard's worker.
      workers: [
        workerFixture({
          id: '00000000-0000-4000-8000-000000000a02',
          name: 'old-laptop',
          created_at: new Date(NOW - 3_600_000).toISOString(),
        }),
        workerFixture({
          id: '00000000-0000-4000-8000-000000000a03',
          name: 'their-laptop',
          user: {
            id: '00000000-0000-4000-8000-0000000000ff',
            email: 'x@example.invalid',
            name: null,
          },
        }),
      ],
    });
    start(world, wizardUrl('approve', '&installed=true'));
    await screen.findByRole('heading', { level: 2, name: 'Approve' });
    const approve = screen.getByRole('link', { name: 'Approve the code' });
    expect(approve.getAttribute('href')).toBe('/workers/approve');
    expect(approve.getAttribute('target')).toBe('_blank');
    await screen.findByText(/Waiting for your new worker to appear/);
    expect(continueButton(/Continue to Ready to work/).disabled).toBe(true);
    expect(primaries()).toHaveLength(1);
    const asked = world.asked.filter((path) => path === '/api/workers').length;

    world.workers = [
      ...world.workers,
      workerFixture({
        id: '00000000-0000-4000-8000-000000000a04',
        name: '<b>jan</b>-mbp',
        created_at: new Date(NOW - 30_000).toISOString(),
      }),
    ];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WATCH_INTERVAL_MS);
    });
    expect(world.asked.filter((path) => path === '/api/workers').length).toBeGreaterThan(asked);
    await waitFor(() => expect(continueButton(/Continue to Ready to work/).disabled).toBe(false));
    // The name is its owner's text, rendered as text.
    expect(screen.getByText(/is approved and connected/).textContent).toContain('<b>jan</b>-mbp');
    expect(document.querySelector('main b')).toBeNull();
    // The server names no blocker for it, so Ready to work is already done by the server's facts.
    expect(stepStates()).toEqual(['done', 'done', 'current', 'done', 'upcoming']);
  });
});

describe('Add a worker: Ready to work', () => {
  it('lists the server’s blockers in plain words, with what to do, and holds Continue', async () => {
    const world = newWorld({
      workers: [
        workerFixture({
          created_at: new Date(NOW - 30_000).toISOString(),
          last_seen_at: new Date(NOW - 10 * 60_000).toISOString(),
          // The server's answer (S-22.19): what the core knows and the old stub could not.
          claim_blockers: ['offline', 'paused', 'images_outdated', 'no_eligible_project'],
          can_claim: false,
        }),
      ],
    });
    start(world, wizardUrl('ready'));
    await screen.findByRole('heading', { level: 2, name: 'Ready to work' });
    const list = within(screen.getByRole('list', { name: 'What the worker needs' }));
    expect(list.getByText(/^Not connected to the platform — last seen 10 m ago$/)).toBeTruthy();
    expect(list.getByText(WORKER_CLAIM_BLOCKER_WORDS.offline.fix)).toBeTruthy();
    expect(list.getByText('Paused by its owner')).toBeTruthy();
    expect(list.getByText(WORKER_CLAIM_BLOCKER_WORDS.paused.fix)).toBeTruthy();
    expect(list.getByText('It has an older build than this platform')).toBeTruthy();
    expect(list.getByText(WORKER_CLAIM_BLOCKER_WORDS.images_outdated.fix)).toBeTruthy();
    expect(list.getByText('No project gives it work')).toBeTruthy();
    // The lines it passes say so.
    expect(list.getByText('Not held by a Claude usage limit')).toBeTruthy();
    expect(list.getByText('Speaks this platform’s version')).toBeTruthy();
    expect(list.getByText('Has its run images')).toBeTruthy();
    // The stub's disclaimer is gone: the server checks the images, the version and the projects.
    expect(screen.queryByText(/can’t check the worker’s images/)).toBeNull();
    expect(screen.getByText(/can’t take work yet/)).toBeTruthy();
    expect(continueButton(/Continue to Choose projects/).disabled).toBe(true);
    expect(primaries()).toHaveLength(1);
  });

  it('lists a blocker outside the checked lines too, such as the platform’s own images', async () => {
    const world = newWorld({
      workers: [
        workerFixture({
          created_at: new Date(NOW - 30_000).toISOString(),
          claim_blockers: ['platform_images_unresolved'],
          can_claim: false,
        }),
      ],
    });
    start(world, wizardUrl('ready'));
    const list = within(await screen.findByRole('list', { name: 'What the worker needs' }));
    expect(list.getByText(WORKER_CLAIM_BLOCKER_WORDS.platform_images_unresolved.word)).toBeTruthy();
    expect(list.getByText('Connected')).toBeTruthy();
    expect(continueButton(/Continue to Choose projects/).disabled).toBe(true);
  });

  it('opens Choose projects once the worker can take work, and says when it last did', async () => {
    const world = newWorld({
      workers: [
        workerFixture({
          created_at: new Date(NOW - 30_000).toISOString(),
          last_claimed_at: new Date(NOW - 5 * 60_000).toISOString(),
        }),
      ],
    });
    start(world, wizardUrl('ready'));
    await screen.findByText(/can take work\./);
    const list = within(screen.getByRole('list', { name: 'What the worker needs' }));
    expect(list.getByText('Connected')).toBeTruthy();
    expect(list.getByText('Not paused')).toBeTruthy();
    expect(list.getByText('Has this platform’s current images')).toBeTruthy();
    expect(list.getByText('Took its first run — last took work 5 m ago')).toBeTruthy();
    fireEvent.click(continueButton(/Continue to Choose projects/));
    expect(await screen.findByRole('heading', { level: 2, name: 'Choose projects' })).toBeTruthy();
  });

  it('lets a pick-only worker continue: a run its owner picks still starts', async () => {
    const world = newWorld({
      workers: [
        workerFixture({
          created_at: new Date(NOW - 30_000).toISOString(),
          claim_projects: [],
          claim_blockers: ['pick_only'],
          can_claim: false,
        }),
      ],
    });
    start(world, wizardUrl('ready'));
    await screen.findByText(/takes only the runs its owner picks/);
    const list = within(screen.getByRole('list', { name: 'What the worker needs' }));
    expect(list.getByText(WORKER_CLAIM_BLOCKER_WORDS.pick_only.word)).toBeTruthy();
    expect(list.getByText('Hasn’t taken a run yet')).toBeTruthy();
    await waitFor(() => expect(continueButton(/Continue to Choose projects/).disabled).toBe(false));
  });
});

describe('Add a worker: Choose projects', () => {
  const ready = () =>
    newWorld({ workers: [workerFixture({ created_at: new Date(NOW - 30_000).toISOString() })] });

  it('says which projects let workers run, links the others’ Execution settings and ends on a board', async () => {
    start(ready(), wizardUrl('projects'));
    await screen.findByRole('heading', { level: 2, name: 'Choose projects' });
    const projects = within(await screen.findByRole('list', { name: 'Your projects' }));
    await projects.findByText('Workers run its stages.');
    expect(projects.getByText(/runs on the platform server only/)).toBeTruthy();
    const use = projects.getByRole('link', { name: 'Use workers for Server Things' });
    expect(use.getAttribute('href')).toBe('/projects/srv/settings/execution');
    // The ending: the board of the first project that lets workers run it, and Skip for now.
    const primary = primaries();
    expect(primary.map((element) => element.textContent)).toEqual(['Open the board']);
    expect(primary[0]?.getAttribute('href')).toBe('/projects/web');
    expect(screen.getByRole('link', { name: 'Skip for now' }).getAttribute('href')).toBe(
      '/workers',
    );
    expect(screen.getByText(/Step 5 of 5 · Optional/)).toBeTruthy();
  });

  it('ends on the Workers screen when no project lets workers run, and asks a member to ask', async () => {
    const world = ready();
    world.role = 'member';
    world.projects = [
      { summary: project(1, 'srv', 'Server Things'), execution: execution('server_only') },
    ];
    start(world, wizardUrl('projects'));
    const projects = within(await screen.findByRole('list', { name: 'Your projects' }));
    await waitFor(() =>
      expect(projects.getByText(/^Ask an administrator/).textContent).toBe(
        'Ask an administrator to turn on workers for Server Things.',
      ),
    );
    expect(projects.queryByRole('link', { name: /Use workers/ })).toBeNull();
    const primary = primaries();
    expect(primary.map((element) => element.textContent)).toEqual(['Go to Workers']);
    expect(screen.queryByRole('link', { name: 'Skip for now' })).toBeNull();
  });
});

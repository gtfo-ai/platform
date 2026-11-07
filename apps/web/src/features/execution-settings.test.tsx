/**
 * The project settings page's **Execution** card (WP-278 criterion 6, TD-031 decision 8), in plain
 * words since S-23.20: who runs the project's agents as one choice, durations as durations, the
 * server's state as a sentence, and the git connection's credential rule as a sentence with a link —
 * no configuration key in the visible text but the one hint that names it.
 *
 * Since S-23.24 it also says who would take the project's work — each worker the read lists, ✓ by
 * itself, only when its owner picks, or ✗ and why in the blocker words — and what waits.
 *
 * Driven through `createApp` with a fake server, so the real router, query client and endpoint
 * parsers are in the path; asserted on what the card shows and on the request it sends.
 */
import type { ProjectSummary } from '@platform/contracts';
import { REMOTE_RUN_CREDENTIAL_REFUSED_NOTICE } from '@platform/contracts';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';
import { UPDATER_FIX, WORKER_CLAIM_BLOCKER_WORDS } from '../ui/humanize.js';
import { executionWorkerWords, formatSeconds, waitingLines } from './execution-settings.js';

const PROJECT = '00000000-0000-4000-8000-0000000027c1';

const SESSION: SessionResponse = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'operator@example.invalid',
    name: 'Fake Operator',
    role: 'admin',
  },
  session: { id: '00000000-0000-4000-8000-000000000002' },
};

const PROJECT_ROW: ProjectSummary = {
  id: PROJECT,
  key: 'autix',
  name: 'Autix',
  repo_url: 'https://gitlab.example.test/acme/autix.git',
  default_branch: 'main',
  agentic_dir: '.agentic',
  knowledge_dir: '.agentic/knowledge',
  autonomy_level: 'supervised',
  readiness_level: 0,
  status: 'active',
  created_at: '2026-10-04T04:00:00.000Z',
  updated_at: '2026-10-04T04:00:00.000Z',
  open_tasks: 0,
  spent_usd_30d: 0,
};

const DEFAULTS = {
  mode: 'hybrid',
  prefer: 'server',
  fallback_after_seconds: null,
  assignee_window_seconds: 120,
  offer_timeout_seconds: 86_400,
  effective_fallback_after_seconds: 15,
  stored: false,
  server_claimant: 'none',
  others_take_unassigned: false,
  notice:
    'No server runner is running on this instance, so this project is treated as workers only: workers may take its runs at once.',
  workers: [],
  waiting: {
    open: 0,
    closed_to_workers: { credential_refused: 0, server_only: 0, server_first: 0 },
  },
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Sent {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

const GIT_INTEGRATION = '00000000-0000-4000-8000-0000000027c9';

const server = (sent: Sent[], execution: Record<string, unknown> = DEFAULTS): typeof fetch =>
  (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      sent.push({
        method,
        url,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      });
    }
    if (url.includes('/api/auth/get-session')) return json(SESSION);
    if (url.endsWith('/execution') && method === 'PUT') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json({
        execution: { ...DEFAULTS, ...body, stored: true, effective_fallback_after_seconds: 300 },
        performed: true,
      });
    }
    if (url.endsWith('/execution')) return json(execution);
    if (url.endsWith('/api/projects')) return json({ items: [PROJECT_ROW] });
    if (url.endsWith('/api/integrations')) return json({ items: [] });
    if (url.includes('/bindings')) {
      return json({
        items: [
          {
            integration_id: GIT_INTEGRATION,
            type: 'git',
            provider: 'gitlab',
            name: 'GitLab <b>main</b>',
            config: {},
          },
        ],
      });
    }
    return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
  }) as typeof fetch;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const open = async (fetchImpl: typeof fetch) => {
  window.history.pushState({}, '', '/projects/autix/settings/execution');
  render(createApp({ fetchImpl, realtime: false }).element);
  return screen.findByRole('button', { name: 'Save execution setting' }, { timeout: 5_000 });
};

const card = () => screen.getByTestId('execution-settings');

describe('the Execution card (WP-278, in plain words since S-23.20)', () => {
  it('says who runs the agents, whether the platform server runs any, and the server’s sentence', async () => {
    await open(server([]));
    expect(card().textContent).toContain(
      'Who runs this project’s agents now: Prefer the platform server (the default)',
    );
    expect(screen.getByTestId('execution-server').textContent).toBe(
      'The platform server doesn’t run agent work on this platform, so only workers can run agent stages.',
    );
    expect(screen.getByTestId('execution-notice').textContent).toMatch(/treated as workers only/);
    const choice = screen.getByLabelText('Who runs this project’s agents') as HTMLSelectElement;
    expect(choice.value).toBe('prefer_server');
    expect([...choice.options].map((option) => option.textContent)).toEqual([
      'Workers only',
      'Prefer workers',
      'Prefer the platform server',
      'Platform server only',
    ]);
    expect(screen.getByTestId('execution-choice-means').textContent).toMatch(
      /platform server takes each run first/,
    );
    // Durations are durations: the stored seconds are a preset's label, not a number field.
    const fallback = screen.getByLabelText(
      'If the platform server hasn’t taken it within',
    ) as HTMLSelectElement;
    expect(fallback.selectedOptions[0]?.textContent).toBe('The default (15 s)');
    expect(screen.getByText('Fallback: after this, a worker may take the run too.')).toBeTruthy();
    expect(
      (screen.getByLabelText('Head start for the assignee’s worker') as HTMLSelectElement)
        .selectedOptions[0]?.textContent,
    ).toBe('2 min');
    expect(
      (screen.getByLabelText('Give up and ask a person after') as HTMLSelectElement)
        .selectedOptions[0]?.textContent,
    ).toBe('1 day');
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('shows no configuration key outside a hint or a disclosure', async () => {
    await open(
      server([], {
        ...DEFAULTS,
        notice: `${String(DEFAULTS.notice)} ${REMOTE_RUN_CREDENTIAL_REFUSED_NOTICE}`,
      }),
    );
    await screen.findByRole('link', { name: 'Open the git connection' });
    const visible = card().cloneNode(true) as HTMLElement;
    for (const hidden of visible.querySelectorAll('details, [data-key-hint]')) {
      hidden.remove();
    }
    expect(visible.textContent).not.toMatch(/[a-z]+_[a-z_]+|\.agentic|config\.yml|seconds\)/);
    // The key is named once, in the hint beside the link, and the server's raw sentence is not shown.
    expect(card().querySelector('[data-key-hint]')?.textContent).toContain('remote_run_credential');
    expect(card().textContent).not.toContain(REMOTE_RUN_CREDENTIAL_REFUSED_NOTICE);
  });

  it('says the credential rule in a sentence and links the git connection', async () => {
    await open(
      server([], {
        ...DEFAULTS,
        mode: 'workers_only',
        notice: REMOTE_RUN_CREDENTIAL_REFUSED_NOTICE,
      }),
    );
    const link = await screen.findByRole('link', { name: 'Open the git connection' });
    expect(link.getAttribute('href')).toBe(`/integrations/${GIT_INTEGRATION}`);
    const notice = screen.getByTestId('execution-credential-notice');
    expect(notice.textContent).toMatch(/^Workers can’t take this project’s runs/);
    // The connection's name is an operator's text, rendered as text.
    expect(notice.textContent).toContain('GitLab <b>main</b>');
    expect(notice.querySelector('b')).toBeNull();
    // Nothing of the server's sentence is left over to show beside it.
    expect(screen.queryByTestId('execution-notice')).toBeNull();
  });

  it('sends the whole setting when saved: workers only, giving up after an hour', async () => {
    const sent: Sent[] = [];
    await open(server(sent));
    fireEvent.change(screen.getByLabelText('Who runs this project’s agents'), {
      target: { value: 'workers_only' },
    });
    // No preference, no fallback to choose.
    expect(screen.queryByLabelText(/within$/)).toBeNull();
    fireEvent.change(screen.getByLabelText('Give up and ask a person after'), {
      target: { value: '3600' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save execution setting' }));
    await waitFor(() =>
      expect(sent.filter((entry) => entry.url.endsWith('/execution'))).toEqual([
        {
          method: 'PUT',
          url: expect.stringContaining(`/api/projects/${PROJECT}/execution`),
          body: {
            mode: 'workers_only',
            prefer: 'server',
            fallback_after_seconds: null,
            assignee_window_seconds: 120,
            offer_timeout_seconds: 3600,
          },
        },
      ]),
    );
  });

  it('maps Prefer workers onto the hybrid mode, with the fallback in the words of that choice', async () => {
    const sent: Sent[] = [];
    await open(server(sent));
    fireEvent.change(screen.getByLabelText('Who runs this project’s agents'), {
      target: { value: 'prefer_workers' },
    });
    fireEvent.change(screen.getByLabelText('If no worker takes it within'), {
      target: { value: '300' },
    });
    expect(
      screen.getByText('Fallback: after this, the platform server may take the run too.'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save execution setting' }));
    await waitFor(() =>
      expect(sent.find((entry) => entry.url.endsWith('/execution'))?.body).toEqual({
        mode: 'hybrid',
        prefer: 'workers',
        fallback_after_seconds: 300,
        assignee_window_seconds: 120,
        offer_timeout_seconds: 86_400,
      }),
    );
  });

  it('takes raw seconds only under Custom…, and offers no save for a number that is not one', async () => {
    const save = await open(server([]));
    fireEvent.change(screen.getByLabelText('Head start for the assignee’s worker'), {
      target: { value: 'custom' },
    });
    const seconds = screen.getByLabelText('Head start for the assignee’s worker — in seconds');
    fireEvent.change(seconds, { target: { value: 'soon' } });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(seconds, { target: { value: '45' } });
    expect((save as HTMLButtonElement).disabled).toBe(false);
  });
});

const owner = {
  id: '00000000-0000-4000-8000-0000000027d0',
  name: 'Jan',
  email: 'jan@example.invalid',
};

describe('who would take this project’s work (S-23.24)', () => {
  it('lists each worker: by itself, only when picked, or not — with the reason in the blocker words', async () => {
    await open(
      server([], {
        ...DEFAULTS,
        workers: [
          {
            worker_id: '00000000-0000-4000-8000-0000000027d1',
            name: 'jan-mbp',
            owner,
            takes: 'automatically',
            blockers: [],
            project_reason: null,
          },
          {
            worker_id: '00000000-0000-4000-8000-0000000027d2',
            name: 'night-owl <img src=x>',
            owner: { ...owner, name: null },
            takes: 'no',
            blockers: ['images_outdated'],
            project_reason: null,
          },
          {
            worker_id: '00000000-0000-4000-8000-0000000027d3',
            name: 'gil-laptop',
            owner,
            takes: 'picked_only',
            blockers: [],
            project_reason: 'scope_excludes',
          },
          {
            worker_id: '00000000-0000-4000-8000-0000000027d4',
            name: 'hana-pc',
            owner,
            takes: 'no',
            blockers: [],
            project_reason: 'credential_refused',
          },
        ],
      }),
    );
    const panel = within(screen.getByTestId('execution-workers'));
    const lineOf = (takes: string, n: number) =>
      screen
        .getByTestId('execution-workers')
        .querySelectorAll(`[data-execution-worker="${takes}"]`)[n]?.textContent ?? '';
    expect(panel.getByRole('heading', { name: 'Would take this project’s work' })).toBeTruthy();
    expect(lineOf('automatically', 0)).toContain('jan-mbp');
    expect(lineOf('automatically', 0)).toContain('Takes its runs by itself');
    // A worker's own blocker, in the Workers screen's words; its name is text.
    expect(lineOf('no', 0)).toContain('night-owl <img src=x>');
    expect(lineOf('no', 0)).toContain(WORKER_CLAIM_BLOCKER_WORDS.images_outdated.word);
    expect(lineOf('no', 0)).toContain('jan@example.invalid');
    expect(screen.getByTestId('execution-workers').querySelector('img')).toBeNull();
    expect(lineOf('picked_only', 0)).toContain('Only runs its owner picks');
    // The project's own reason when the worker has none.
    expect(lineOf('no', 1)).toContain(
      'Its git connection’s token may not go to a developer’s computer',
    );
    expect(panel.getByText('No run is waiting for anybody to start it.')).toBeTruthy();
  });

  it('says a draining outdated worker is updating, in progress rather than failed (S-23.27)', () => {
    const line = (blockers: ('draining' | 'images_outdated' | 'protocol_outdated')[]) =>
      executionWorkerWords({
        worker_id: '00000000-0000-4000-8000-0000000027d5',
        name: 'ivo-mbp',
        owner,
        takes: 'no',
        blockers,
        project_reason: null,
      });
    expect(line(['draining', 'images_outdated'])).toEqual({
      status: 'running',
      words: `Updating now… ${UPDATER_FIX}`,
    });
    expect(line(['protocol_outdated', 'draining']).status).toBe('running');
    // Outdated and not draining yet, or draining for another reason: as it is.
    expect(line(['images_outdated'])).toEqual({
      status: 'failure',
      words: WORKER_CLAIM_BLOCKER_WORDS.images_outdated.word,
    });
    expect(line(['draining'])).toEqual({
      status: 'failure',
      words: WORKER_CLAIM_BLOCKER_WORDS.draining.word,
    });
  });

  it('says how many runs wait and why some can’t go to workers', async () => {
    await open(
      server([], {
        ...DEFAULTS,
        waiting: {
          open: 6,
          closed_to_workers: { credential_refused: 0, server_only: 2, server_first: 1 },
        },
      }),
    );
    const waiting = screen.getByTestId('execution-waiting');
    expect(waiting.textContent).toContain('3 runs are waiting for a worker.');
    expect(waiting.textContent).toContain(
      '2 waiting runs can’t go to workers: they were offered to the platform server only',
    );
    expect(waiting.textContent).toContain(
      '1 waiting run can’t go to workers: the platform server goes first',
    );
    // No workers: the way to add one.
    expect(
      within(screen.getByTestId('execution-workers'))
        .getByRole('link', { name: 'Add a worker' })
        .getAttribute('href'),
    ).toBe('/workers/new');
  });

  it('words the waiting runs exactly', () => {
    expect(
      waitingLines({
        open: 1,
        closed_to_workers: { credential_refused: 0, server_only: 0, server_first: 0 },
      }),
    ).toEqual(['1 run is waiting for a worker.']);
    expect(
      waitingLines({
        open: 2,
        closed_to_workers: { credential_refused: 2, server_only: 0, server_first: 0 },
      }),
    ).toEqual([
      '2 waiting runs can’t go to workers: the git connection’s token may not go to a developer’s computer.',
    ]);
  });
});

describe('formatSeconds', () => {
  it.each([
    [15, '15 s'],
    [59, '59 s'],
    [60, '1 min'],
    [90, '90 s'],
    [300, '5 min'],
    [3600, '1 h'],
    [7200, '2 h'],
    [86_400, '1 day'],
    [2_592_000, '30 days'],
  ])('%i is %s', (seconds, words) => {
    expect(formatSeconds(seconds)).toBe(words);
  });
});

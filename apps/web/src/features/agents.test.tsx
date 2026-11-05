/**
 * The Agents page (S-23.6) through `createApp` with a fake server — the real router, query client,
 * published parsers and lazy chunks in the path: the counts, the three views and the switch between
 * them, every desk's pose and name, reduced motion, the dialog a run opens, the list's cancel, a
 * transcript frame moving a desk, a run that ends while the page watches, and the empty page.
 *
 * happy-dom applies no CSS and measures nothing, so the drawing itself is the browser tier's
 * (`test/web-e2e/csp.spec.ts`); what is held here is what each view says and does.
 */
import type { AgentsResponse, RunRecord, TaskDetailResponse } from '@platform/contracts';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '../api/keys.js';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';
import type { EventStream } from '../realtime/client.js';
import { fakeEventStreams } from '../realtime/event-stream.test-fixture.js';
import { STUCK_AFTER_MS } from '../ui/activity.js';
import {
  agentItem,
  NOW,
  PROJECT,
  question,
  runRecord,
  taskDetail,
  uuid,
  worker,
  workerSeat,
} from '../viz/fleet/fleet.test-fixture.js';
import { FLEET_LIVE_UPDATE_MS } from '../viz/fleet/use-fleet.js';
import { FLEET_VIEW_STORAGE_KEY } from './agents-view.js';

/** A string that would be an element if anything here rendered markup (BD-022). */
const HOSTILE = '<img src=x onerror=alert(1)>';

const SESSION: SessionResponse = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'operator@example.invalid',
    name: 'Fake Operator',
    role: 'member',
  },
  session: { id: '00000000-0000-4000-8000-000000000002' },
};

const at = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

/** Six live runs, one of each thing an agent can be doing. */
const AGENTS: AgentsResponse = {
  items: [
    // DEMO-1, on the server, reading files.
    agentItem(1, { activity: { kind: 'tool', tool_name: 'Read', at: at(30_000) } }),
    // DEMO-2, on jan-mbp, asking to run a command.
    agentItem(2, {
      seat: workerSeat(30, 'jan-mbp'),
      run: { stage: 'code_review', role: 'reviewer' },
      role: 'reviewer',
      activity: { kind: 'waiting_permission', tool_name: 'Bash', at: at(20_000) },
    }),
    // DEMO-3, on jan-mbp, an architect thinking.
    agentItem(3, {
      seat: workerSeat(30, 'jan-mbp'),
      run: { stage: 'architecture', role: 'architect' },
      role: 'architect',
      activity: { kind: 'thinking', tool_name: null, at: at(10_000) },
    }),
    // DEMO-4, on the server, silent too long.
    agentItem(4, { activity: { kind: 'text', tool_name: null, at: at(STUCK_AFTER_MS + 60_000) } }),
    // DEMO-5, in the queue.
    agentItem(5, { seat: null, activity: null, run: { status: 'created', started_at: null } }),
    // DEMO-6, seated on jan-mbp, still starting.
    agentItem(6, { seat: workerSeat(30, 'jan-mbp'), activity: null, run: { status: 'starting' } }),
  ],
};

const WORKERS = {
  items: [
    worker(30, { name: 'jan-mbp', concurrency: 4 }),
    worker(31, {
      name: `night-owl ${HOSTILE}`,
      concurrency: 1,
      paused_until: new Date(NOW + 3_600_000).toISOString(),
      paused_reason: 'usage_limited' as const,
    }),
  ],
  scope: 'all' as const,
  timezone: 'UTC',
};

/** DEMO-9 has a question and no live run: it stands at the help desk. */
const INBOX = { questions: [question(70, uuid(1009), 'Three or five?\nmore')], approvals: [] };

const TASKS = new Map<string, TaskDetailResponse>([
  ...[1, 2, 3, 4, 5, 6].map((n): [string, TaskDetailResponse] => [
    uuid(1000 + n),
    taskDetail(uuid(1000 + n), `DEMO-${n}`, n === 1 ? `Checkout ${HOSTILE}` : `Task ${n}`),
  ]),
  [uuid(1009), taskDetail(uuid(1009), 'DEMO-9', 'Waiting on you')],
]);

const project = {
  id: PROJECT,
  key: 'demo',
  name: 'Demo',
  repo_url: 'https://git.example.test/acme/demo.git',
  default_branch: 'main',
  agentic_dir: '.agentic',
  knowledge_dir: '.agentic/knowledge',
  autonomy_level: 'observe',
  readiness_level: 1,
  status: 'active',
  created_at: '2026-09-13T04:00:00.000Z',
  updated_at: '2026-09-13T04:00:00.000Z',
  open_tasks: 0,
  spent_usd_30d: 0,
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Backend {
  agents: AgentsResponse;
  inbox: typeof INBOX;
  /** The topics the stream carries: the URL's at each open, then every subscription change. */
  topics: Set<string>;
  /** Every topic a subscription change removed, in order. */
  removed: string[];
  runs: Map<string, RunRecord>;
  posted: string[];
}

const backend = (agents: AgentsResponse = AGENTS, inbox: typeof INBOX = INBOX): Backend => ({
  agents,
  inbox,
  topics: new Set(),
  removed: [],
  runs: new Map(),
  posted: [],
});

const fetchFor = (state: Backend) =>
  (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const path = new URL(url, 'http://localhost').pathname;
    if (url.includes('/api/auth/get-session')) return json(SESSION);
    if (init?.method === 'POST' && path === '/events/subscriptions') {
      const body = JSON.parse(String(init.body)) as { add?: string[]; remove?: string[] };
      for (const topic of body.add ?? []) state.topics.add(topic);
      for (const topic of body.remove ?? []) {
        state.topics.delete(topic);
        state.removed.push(topic);
      }
      return json({});
    }
    if (init?.method === 'POST') {
      state.posted.push(path);
      const runId = /^\/api\/runs\/([^/]+)\/cancel$/.exec(path)?.[1];
      if (runId !== undefined) {
        return json(
          {
            run_id: runId,
            task_id: uuid(1001),
            status: 'running',
            task_state: 'active',
            performed: true,
            command_id: uuid(800),
          },
          202,
        );
      }
    }
    if (path === '/api/org/agents') return json(state.agents);
    if (path === '/api/workers') return json(WORKERS);
    if (path === '/api/org/inbox') return json(state.inbox);
    if (path === '/api/projects') return json({ items: [project] });
    if (/^\/api\/runs\/[^/]+\/messages$/.test(path)) return json({ items: [], next_seq: null });
    const runId = /^\/api\/runs\/([^/]+)$/.exec(path)?.[1];
    const run = runId === undefined ? undefined : state.runs.get(runId);
    if (run !== undefined) return json({ ...run, retry_defaults: null });
    const taskId = /^\/api\/tasks\/([^/]+)$/.exec(path)?.[1];
    const task = taskId === undefined ? undefined : TASKS.get(taskId);
    if (task !== undefined) return json(task);
    return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
  }) as typeof fetch;

/** A `matchMedia` for a viewport `width` px wide, with or without reduced motion. */
const media = (width: number, reduced = false): void => {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: query.includes('prefers-reduced-motion')
          ? reduced
          : Number(/min-width: (\d+)px/.exec(query)?.[1] ?? 0) <= width,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList,
  );
};

/**
 * A stream that opens as a browser's does and delivers nothing: it records which topics its URL
 * carried, and the subscription POSTs the client sends once it is open do the rest.
 */
const recordingStream = (state: Backend) => {
  const { openStream } = fakeEventStreams();
  return (url: string): EventStream => {
    const stream = openStream(url);
    state.topics = new Set(
      (new URL(url, 'http://localhost').searchParams.get('topics') ?? '')
        .split(',')
        .filter(Boolean),
    );
    return stream;
  };
};

const start = (path: string, state: Backend = backend(), live = false) => {
  window.history.pushState({}, '', path);
  const app = createApp({
    fetchImpl: fetchFor(state),
    now: () => NOW,
    ...(live ? { openStream: recordingStream(state) } : { realtime: false }),
  });
  render(app.element);
  return app;
};

const office = async () => screen.findByRole('region', { name: 'Office' });

/** The desk (or bench seat) whose button is named by `name`, and that button. */
const deskOf = async (name: RegExp) => {
  const button = await screen.findByRole('button', { name });
  return { button, desk: button.closest('li') as HTMLElement };
};

/**
 * The race this file's first screen lost under parallel load (S-23.13a): the first test to open the
 * Agents page, the map or the office paid the on-demand transform of its lazy chunk inside a
 * `findBy…`/`waitFor`'s 1 s bound — measured alone at 600–740 ms for the first test against
 * 40–90 ms for every later one — so a loaded host pushed it past the bound. The chunks are imported
 * once here, under the hook's own bound, so each wait measures the screen rather than the
 * transform; no wait in a test was widened. `stage-commands.test.tsx` and
 * `app/platform-updated.test.tsx` do the same for the task page.
 */
beforeAll(async () => {
  await Promise.all([
    import('./agents.js'),
    import('../viz/fleet/fleet-canvas.js'),
    import('../viz/fleet/office.js'),
  ]);
}, 60_000);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('the Agents page', () => {
  it('says what every agent is doing in the header, and offers the inbox while something needs you', async () => {
    media(1280);
    start('/agents');
    expect(await screen.findByRole('heading', { level: 1, name: 'Agents' })).toBeDefined();
    await waitFor(() => {
      expect(document.querySelector('[data-fleet-counts]')?.textContent).toBe(
        '2 working · 2 need you · 2 waiting · 1 free seat · 1 stuck',
      );
    });
    expect(screen.getByRole('link', { name: 'Open inbox' }).getAttribute('href')).toBe('/inbox');
    // The map is the default view, drawn by its own lazy chunk.
    expect(await screen.findByTestId('fleet-canvas-frame')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Map' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('switches views, keeps the choice in the URL and in this browser, and the URL wins', async () => {
    media(1280);
    start('/agents');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Office' }));
    await office();
    // The office is drawn from the stored choice at once; the URL is the router's navigate, which
    // settles after it — so the URL is waited for, not read in the same tick.
    await waitFor(() => {
      expect(window.location.search).toBe('?view=office');
    });
    expect(window.localStorage.getItem(FLEET_VIEW_STORAGE_KEY)).toBe('office');
    cleanup();

    start('/agents');
    await office();
    expect(screen.getByRole('button', { name: 'Office' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    cleanup();

    start('/agents?view=list');
    expect(await screen.findByRole('list', { name: 'Runs' })).toBeDefined();
    expect(screen.queryByRole('region', { name: 'Office' })).toBeNull();
  });

  it('follows the run:<id> of at most twelve runs, what needs a person first, and lets go on leaving', async () => {
    media(1280);
    const many = Array.from({ length: 14 }, (_, index) =>
      agentItem(index + 1, {
        activity:
          index === 13
            ? { kind: 'waiting_permission', tool_name: 'Bash', at: at(5_000) }
            : { kind: 'tool', tool_name: 'Read', at: at(5_000) },
      }),
    );
    const state = backend({ items: many }, { questions: [], approvals: [] });
    start('/agents?view=list', state, true);
    const user = userEvent.setup();
    const expected = [
      'org',
      ...[14, ...Array.from({ length: 11 }, (_, i) => i + 1)].map((n) => `run:${uuid(n)}`),
    ];
    await waitFor(() => {
      expect(
        [...state.topics].filter((topic) => topic.startsWith('run:') || topic === 'org').sort(),
      ).toEqual([...expected].sort());
    });
    expect(state.topics.has(`run:${uuid(12)}`)).toBe(false);

    await user.click(screen.getByRole('link', { name: /^Home/ }));
    await waitFor(() => {
      expect([...state.topics].filter((topic) => topic.startsWith('run:'))).toEqual([]);
    });
  });

  it('keeps every run topic when the same runs change their order', async () => {
    media(1280);
    const state = backend(
      { items: [agentItem(1), agentItem(2), agentItem(3)] },
      { questions: [], approvals: [] },
    );
    const app = start('/agents?view=list', state, true);
    await waitFor(() => {
      expect([...state.topics].filter((topic) => topic.startsWith('run:'))).toHaveLength(3);
    });
    const before = state.removed.length;
    // DEMO-3 now asks for a permission: it moves to the top of the attention order.
    state.agents = {
      items: [
        agentItem(1),
        agentItem(2),
        agentItem(3, {
          activity: { kind: 'waiting_permission', tool_name: 'Bash', at: at(1_000) },
        }),
      ],
    };
    await act(async () => {
      await app.queryClient.invalidateQueries({ queryKey: [...queryKeys.agents] });
    });
    const runs = await screen.findByRole('list', { name: 'Runs' });
    await waitFor(() => {
      expect(
        within(runs).getAllByRole('button', { name: /^demo · DEMO-/ })[0]?.textContent,
      ).toMatch(/DEMO-3/);
    });
    expect(state.removed.slice(before)).toEqual([]);
  });

  it('shows the list instead of the map on a narrow screen', async () => {
    media(600);
    start('/agents');
    expect(await screen.findByRole('list', { name: 'Runs' })).toBeDefined();
    expect(screen.getByText('The map needs a wider screen; here is the list.')).toBeDefined();
    expect(screen.queryByTestId('fleet-canvas-frame')).toBeNull();
  });
});

describe('the office', () => {
  it('poses every desk by what its agent is doing, and names each desk with the whole state', async () => {
    media(1280);
    start('/agents?view=office');
    await office();
    const cases: [RegExp, string, string][] = [
      [
        /^DEMO-1 · Checkout .+ · Implementation · working: Reading files · the platform server$/,
        'typing',
        'working',
      ],
      [
        /^DEMO-2 · Task 2 · Code review · needs you: Asking to use Bash · worker jan-mbp$/,
        'raise_hand',
        'needs_you',
      ],
      [
        /^DEMO-3 · Task 3 · Architecture · thinking: Brainstorming · worker jan-mbp$/,
        'thinking',
        'thinking',
      ],
      [
        /^DEMO-4 · Task 4 · Implementation · stuck: No activity for 6 min · the platform server$/,
        'confused',
        'stuck',
      ],
      [
        /^DEMO-6 · Task 6 · Implementation · waiting: Starting · worker jan-mbp$/,
        'sipping',
        'waiting',
      ],
    ];
    for (const [name, pose, activity] of cases) {
      const { desk } = await deskOf(name);
      expect(desk.getAttribute('data-pose'), String(name)).toBe(pose);
      expect(desk.getAttribute('data-activity'), String(name)).toBe(activity);
    }
    // The bubble and the nameplate are text beside the drawing.
    const { desk } = await deskOf(/^DEMO-1 · /);
    expect(within(desk).getByTestId('seat-bubble').textContent).toBe('Now: Reading files');
    expect(within(desk).getByTestId('seat-nameplate').textContent).toBe('DEMO-1 · Implementation');

    // The queue sits on the bench in the lobby.
    const bench = await deskOf(
      /^DEMO-5 · Task 5 · Implementation · waiting: Starting · no seat yet$/,
    );
    expect(bench.desk.getAttribute('data-bench')).toBe(uuid(5));
    expect(
      within(screen.getByRole('region', { name: 'Lobby' })).getByText(
        'Bench · 1 waiting for a seat',
      ),
    ).toBeDefined();

    // jan-mbp holds three of four: one free desk, asleep. night-owl is paused: its desk has coffee.
    const jan = screen.getByRole('region', { name: 'jan-mbp room' });
    expect(within(jan).getByText('3 of 4 slots busy')).toBeDefined();
    expect(jan.querySelector('[data-desk="free"]')?.getAttribute('data-pose')).toBe('sleeping');
    const owl = screen.getByRole('region', { name: `night-owl ${HOSTILE} room` });
    expect(owl.querySelector('[data-desk="free"]')?.getAttribute('data-pose')).toBe('sipping');
    expect(within(owl).getByText(/^Paused until /)).toBeDefined();
    // The worker's name is its owner's text: on the door plate as characters, never an element.
    expect(owl.querySelector('[data-door-plate]')?.textContent).toBe(`night-owl ${HOSTILE}`);
    expect(document.querySelector('img')).toBeNull();

    // The help desk: the question nobody's run holds and the permission ask, each a link to its task.
    const help = screen.getByRole('list', { name: 'At the help desk' });
    // DEMO-9's ticket key arrives with its own task read, which may answer after the office drew.
    await waitFor(() => {
      expect(
        within(help)
          .getAllByRole('link')
          .map((link) => link.getAttribute('aria-label')),
      ).toEqual(['DEMO-9 · asks · Three or five?', 'DEMO-2 · asks · Asking to use Bash']);
    });
    const links = within(help).getAllByRole('link');
    expect(links[0]?.getAttribute('href')).toBe(`/tasks/${uuid(1009)}`);
    expect(document.querySelector('[data-help-desk]')?.getAttribute('data-help-desk')).toBe('lit');
  });

  it('moves its bots out of step, and holds every one still under reduced motion', async () => {
    media(1280);
    start('/agents?view=office');
    const room = await office();
    await deskOf(/^DEMO-1 · /);
    expect(room.getAttribute('data-motion')).toBe('on');
    const phases = new Set(
      [...room.querySelectorAll('[data-desk] svg')].map(
        (svg) => /bot-phase-(\d)/.exec(svg.getAttribute('class') ?? '')?.[1],
      ),
    );
    expect(phases.size).toBeGreaterThan(1);
    expect(room.querySelector('svg.bot-static')).toBeNull();
    cleanup();

    media(1280, true);
    start('/agents?view=office');
    const still = await office();
    await deskOf(/^DEMO-1 · /);
    expect(still.getAttribute('data-motion')).toBe('reduced');
    const drawings = [
      ...still.querySelectorAll('[data-desk] svg, [data-bench] svg, [data-help] svg'),
    ];
    expect(drawings.length).toBeGreaterThan(5);
    expect(drawings.every((svg) => svg.getAttribute('class')?.includes('bot-static'))).toBe(true);
  });

  it('opens the run’s dialog from a desk: its activity, where it runs, the task and the run', async () => {
    media(1280);
    start('/agents?view=office');
    const user = userEvent.setup();
    const { button } = await deskOf(/^DEMO-2 · /);
    await user.click(button);
    const dialog = await screen.findByRole('dialog', { name: 'DEMO-2 · Code review' });
    expect(within(dialog).getByText(/Watch-only — the agent runs on/).textContent).toContain(
      'jan-mbp',
    );
    expect(within(dialog).getByText('Now: Asking to use Bash')).toBeDefined();
    expect(within(dialog).getByRole('link', { name: 'Open task' }).getAttribute('href')).toBe(
      `/tasks/${uuid(1002)}`,
    );
    expect(within(dialog).getByRole('link', { name: 'Open run' }).getAttribute('href')).toBe(
      `/runs/${uuid(2)}`,
    );
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('follows a run’s transcript between two agents reads', async () => {
    media(1280);
    const app = start('/agents?view=office');
    await deskOf(/^DEMO-1 · Checkout .+ · Implementation · working: Reading files/);
    act(() => {
      app.services.transcripts.apply({
        run_id: uuid(1),
        seq: 1,
        created_at: at(1_000),
        redaction_count: 0,
        parent_tool_use_id: null,
        kind: 'assistant',
        model: 'claude-test',
        content: [
          {
            type: 'tool_use',
            tool_use_id: 'edit',
            tool_name: 'Edit',
            input: { file_path: 'a.ts' },
          },
        ],
      });
    });
    await deskOf(/^DEMO-1 · Checkout .+ · Implementation · working: Editing code/);
    // A second frame inside the update window waits for its trailing update rather than
    // re-rendering the page at once — and is not lost.
    act(() => {
      app.services.transcripts.apply({
        run_id: uuid(1),
        seq: 2,
        created_at: at(500),
        redaction_count: 0,
        parent_tool_use_id: null,
        kind: 'assistant',
        model: 'claude-test',
        content: [
          { type: 'tool_use', tool_use_id: 'bash', tool_name: 'Bash', input: { command: 'ls' } },
        ],
      });
    });
    expect(
      screen.getByRole('button', { name: /· Implementation · working: Editing code ·/ }),
    ).toBeDefined();
    await waitFor(
      () => {
        expect(
          screen.getByRole('button', { name: /· Implementation · working: Running a command ·/ }),
        ).toBeDefined();
      },
      { timeout: FLEET_LIVE_UPDATE_MS * 3 },
    );
  });

  it('cheers at the desk of a run that just finished, once the run’s read says so', async () => {
    media(1280);
    const state = backend();
    const app = start('/agents?view=office', state);
    await deskOf(/^DEMO-1 · /);
    state.agents = { items: AGENTS.items.filter((item) => item.run.id !== uuid(1)) };
    state.runs.set(
      uuid(1),
      runRecord(1, { status: 'completed', ended_at: new Date(NOW - 1_000).toISOString() }),
    );
    await act(async () => {
      await app.queryClient.invalidateQueries({ queryKey: [...queryKeys.agents] });
    });
    const { desk } = await deskOf(
      /^DEMO-1 · Checkout .+ · Implementation · just finished · the platform server$/,
    );
    expect(desk.getAttribute('data-pose')).toBe('cheer');
    expect(within(desk).getByTestId('seat-bubble').textContent).toBe('Done!');
    // It is not counted as working any more.
    expect(document.querySelector('[data-fleet-counts]')?.textContent).toMatch(/^1 working/);
    // …and the list says it too, after the live runs, while the office keeps it at its desk.
    await userEvent.setup().click(screen.getByRole('button', { name: 'List' }));
    const runs = await screen.findByRole('list', { name: 'Runs' });
    const titles = within(runs)
      .getAllByRole('button', { name: /^demo · DEMO-/ })
      .map((button) => button.textContent?.split(' · ')[1]);
    expect(titles.at(-1)).toBe('DEMO-1');
    expect(within(runs).getByText('just finished')).toBeDefined();
  });
});

describe('the list', () => {
  it('puts what needs a person first, and cancels a run only after asking', async () => {
    media(1280);
    const state = backend();
    start('/agents?view=list', state);
    const user = userEvent.setup();
    const runs = await screen.findByRole('list', { name: 'Runs' });
    await within(runs).findByText(`demo · DEMO-1 · Checkout ${HOSTILE}`);
    // Each row's ticket line arrives with its own task read, in whatever order the server answers:
    // wait for all six, not the one named above (found with shuffled answer delays, S-23.13a).
    await waitFor(() => {
      expect(within(runs).getAllByRole('button', { name: /^demo · DEMO-/ })).toHaveLength(6);
    });
    const titles = within(runs)
      .getAllByRole('button', { name: /^demo · DEMO-/ })
      .map((button) => button.textContent);
    expect(titles.map((title) => title?.split(' · ')[1])).toEqual([
      'DEMO-2',
      'DEMO-4',
      'DEMO-1',
      'DEMO-3',
      'DEMO-5',
      'DEMO-6',
    ]);
    expect(runs.querySelector('img')).toBeNull();

    await user.click(within(runs).getByRole('button', { name: 'Actions for DEMO-1' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Cancel run…' }));
    const confirm = await screen.findByRole('dialog', { name: 'Cancel DEMO-1?' });
    expect(state.posted).toEqual([]);
    await user.click(within(confirm).getByRole('button', { name: 'Cancel run' }));
    await waitFor(() => {
      expect(state.posted).toEqual([`/api/runs/${uuid(1)}/cancel`]);
    });
    await within(runs).findByText(/^Cancel accepted/);
  });

  it('opens the run’s dialog from a row', async () => {
    media(1280);
    start('/agents?view=list');
    const user = userEvent.setup();
    const runs = await screen.findByRole('list', { name: 'Runs' });
    await user.click(await within(runs).findByRole('button', { name: /^demo · DEMO-3/ }));
    expect(await screen.findByRole('dialog', { name: 'DEMO-3 · Architecture' })).toBeDefined();
  });
});

describe('with nothing running', () => {
  it('teaches on the map and the list, and the office shows everyone asleep under the same words', async () => {
    media(1280);
    const nobody = { questions: [], approvals: [] };
    start('/agents', backend({ items: [] }, nobody));
    expect(await screen.findByRole('heading', { name: 'No agent is working' })).toBeDefined();
    expect(screen.getByRole('link', { name: 'Choose a board' }).getAttribute('href')).toBe(
      '/projects',
    );
    cleanup();

    start('/agents?view=office', backend({ items: [] }, nobody));
    const room = await office();
    expect(within(room).getByRole('heading', { name: 'No agent is working' })).toBeDefined();
    await waitFor(() => {
      expect(
        room.querySelectorAll('[data-desk="free"][data-pose="sleeping"]').length,
      ).toBeGreaterThan(1);
    });
    expect(room.querySelector('[data-desk]:not([data-desk="free"])')).toBeNull();
  });
});

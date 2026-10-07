/**
 * The onboarding wizard says what it is doing (WP-155, PROGRESS backlog 450, 451 and 452).
 *
 * Driven through `createApp` at `/onboarding` with a fake server, so the real router, query client,
 * endpoint parsers and — for the live case — the real realtime provider and query bridge are in the
 * path. One case per ruling item:
 *
 *  - (a) step 3 is *(optional)*, says it can be answered later from the settings page, and its
 *    *Skip for now* sends **no request**;
 *  - (b) the wizard's *Test connection* shows the Integrations card's answer — pending, failed with
 *    its checks, and the error notice — beside the integration that was tested;
 *  - (c) step 2 reads the discovery task back on load (a fresh app is a refresh), shows queued,
 *    running with the link to the run's live transcript, needs a person with the escalation's reason,
 *    and done with the readiness level — and follows the task when a frame for it arrives.
 */
import type {
  RediscoveryGateResponse,
  RunRecord,
  SseFrame,
  SseTopic,
  TaskDetailResponse,
  TaskState,
  TestIntegrationResponse,
} from '@platform/contracts';
import { sseFrameSchema } from '@platform/contracts';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';
import type { EventStream } from '../realtime/client.js';
import { discoveryPhaseOf } from './discovery-status.js';

const PROJECT = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-0000000000d1';
const RUN = '00000000-0000-4000-8000-0000000000d2';
const INTEGRATION = '00000000-0000-4000-8000-0000000000f1';
const OTHER_INTEGRATION = '00000000-0000-4000-8000-0000000000f3';

const SESSION: SessionResponse = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'operator@example.invalid',
    name: 'Fake Operator',
    role: 'admin',
  },
  session: { id: '00000000-0000-4000-8000-000000000002' },
};

const PROJECT_ROW = {
  id: PROJECT,
  key: 'acme_api',
  name: 'ACME API',
  repo_url: 'https://git.example.test/acme/api.git',
  default_branch: 'main',
  agentic_dir: '.agentic',
  knowledge_dir: '.agentic/knowledge',
  autonomy_level: 'supervised',
  readiness_level: 2,
  status: 'active',
  created_at: '2026-10-07T04:00:00.000Z',
  updated_at: '2026-10-07T04:00:00.000Z',
  open_tasks: 0,
  spent_usd_30d: 0,
};

const integration = (id: string, name: string) => ({
  id,
  type: 'git',
  provider: 'gitlab',
  name,
  config: {},
  health: { status: 'unknown', checked_at: null, detail: null },
  config_refusal: null,
  retired_at: null,
  credentials_readable: null,
  credentials_consequence: null,
});

const READINESS = {
  level: 2,
  evaluated_at: '2026-10-07T05:00:00.000Z',
  source: 'discovery',
  criteria: [],
  next_improvements: [],
  notices: [],
};

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  id: RUN,
  task_id: TASK,
  project_id: PROJECT,
  stage: 'discovery',
  role: 'discovery',
  mode: 'discovery',
  attempt: 1,
  session_id: null,
  model: 'claude-test',
  effort: 'high',
  provider_mode: 'api',
  prompt_version: 'test@1',
  status: 'running',
  terminal_reason: null,
  started_at: '2026-10-07T05:00:00.000Z',
  ended_at: null,
  last_output_at: null,
  num_turns: 1,
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
  ...over,
});

const taskDetail = (state: TaskState, runs: readonly RunRecord[]): TaskDetailResponse => ({
  task: {
    id: TASK,
    project_id: PROJECT,
    ticket: { provider: 'platform', key: 'discovery', url: 'https://agentic.example.test/' },
    ticket_title: null,
    template: 'discovery',
    mode: 'normal',
    state,
    current_stage: 'discovery',
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
    created_at: '2026-10-07T04:59:00.000Z',
    updated_at: '2026-10-07T04:59:00.000Z',
    completed_at: null,
  },
  taken_over: null,
  can_raise_budget: false,
  can_export: false,
  gate_feedback: null,
  human_time: {
    total_minutes: 0,
    by_kind: { review: 0, question: 0, approval: 0, steer: 0 },
    by_user: null,
    entries: 0,
    withheld: { entries: 0, minutes: 0 },
  },
  stages: [],
  artifacts: [],
  questions: [],
  approvals: [],
  runs: [...runs],
});

const gateFor = (
  state: TaskState,
  escalation: { at: string; reason: string; brief: string } | null = null,
): RediscoveryGateResponse => {
  const live = state !== 'done' && state !== 'cancelled';
  return {
    can_start: !live,
    blocker: live
      ? {
          code: 'discovery_in_flight',
          detail: `discovery task ${TASK} is in flight`,
          task_id: TASK,
        }
      : null,
    ceiling_usd: 2,
    last_discovery: {
      task_id: TASK,
      state,
      cost_usd: 0,
      findings_unrecorded: null,
      escalation,
    },
  };
};

/** The fake server's mutable state: a refresh is a new app over the same world. */
interface World {
  gate: RediscoveryGateResponse | null;
  task: TaskDetailResponse | null;
  readiness: 'recorded' | 'absent';
  /** `null` answers the probe with a 500; a function holds it until the test resolves it. */
  probe: TestIntegrationResponse | null | Promise<TestIntegrationResponse>;
  readonly sent: { url: string; method: string }[];
  readonly subscriptions: string[];
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fetchFor = (world: World) =>
  (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/events/subscriptions')) {
      world.subscriptions.push(String(init?.body));
      return json({});
    }
    if (url.includes('/api/auth/get-session')) return json(SESSION);
    if (method !== 'GET') {
      world.sent.push({ url, method });
      if (url.endsWith('/test')) {
        const probe = await world.probe;
        return probe === null
          ? json({ error: { code: 'internal', message: 'the probe exploded' } }, 500)
          : json(probe);
      }
      return json({ error: { code: 'not_found', message: 'no such command' } }, 404);
    }
    if (url.endsWith('/api/projects')) return json({ items: [PROJECT_ROW] });
    if (url.endsWith('/api/integrations')) {
      return json({
        items: [
          integration(INTEGRATION, 'Acme GitLab'),
          integration(OTHER_INTEGRATION, 'Other GitLab'),
        ],
      });
    }
    if (url.endsWith(`/api/projects/${PROJECT}/rediscovery`)) {
      return world.gate === null
        ? json({ error: { code: 'onboarding_unavailable', message: 'cannot say' } }, 503)
        : json(world.gate);
    }
    if (url.endsWith(`/api/projects/${PROJECT}/readiness`)) {
      return world.readiness === 'recorded'
        ? json(READINESS)
        : json({ error: { code: 'readiness_not_evaluated', message: 'none' } }, 409);
    }
    if (url.endsWith(`/api/tasks/${TASK}`) && world.task !== null) return json(world.task);
    if (url.includes('/bindings') || url.includes('/budgets') || url.includes('/audit')) {
      return json({ items: [] });
    }
    return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
  }) as typeof fetch;

const newWorld = (over: Partial<World> = {}): World => ({
  gate: null,
  task: null,
  readiness: 'absent',
  probe: null,
  sent: [],
  subscriptions: [],
  ...over,
});

const stepOf = (title: string): HTMLElement => {
  const heading = screen.getByText(title);
  const card = heading.closest('.rounded-lg');
  if (!(card instanceof HTMLElement)) {
    throw new Error(`no step card around "${title}"`);
  }
  return card;
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  window.history.pushState({}, '', '/onboarding');
});

describe('step 3 says it is optional (WP-155 (a), backlog 450)', () => {
  it('is headed optional, names the settings page, and skipping records nothing', async () => {
    const world = newWorld();
    render(createApp({ fetchImpl: fetchFor(world), realtime: false }).element);
    // The project is resumed once the list arrives; the form is what says it has.
    await screen.findByLabelText('Glossary');
    const step = stepOf('Business interview (optional)');
    expect(step.textContent).toContain('the whole step can be skipped and answered later');
    expect(within(step).getByRole('link', { name: 'settings' }).getAttribute('href')).toBe(
      '/projects/acme_api/settings',
    );
    expect(within(step).getByLabelText('Glossary')).toBeTruthy();

    fireEvent.click(within(step).getByRole('button', { name: 'Skip for now' }));
    expect(step.textContent).toContain('Skipped for now — nothing was recorded.');
    expect(within(step).queryByLabelText('Glossary')).toBeNull();
    fireEvent.click(within(step).getByRole('button', { name: 'Answer it now' }));
    expect(within(step).getByLabelText('Glossary')).toBeTruthy();

    // Records nothing (rule 79 — the effect is countable). An assertion taken right after the click
    // would pass before a request had been sent (rule 87), so a known command is sent **after** the
    // skip and waited for: requests leave in order, so anything the skip sent is in the log by then.
    const probe = screen.getAllByRole('button', { name: 'Test connection' })[0];
    if (probe === undefined) throw new Error('no Test connection button');
    fireEvent.click(probe);
    await waitFor(() => {
      expect(world.sent.length).toBeGreaterThan(0);
    });
    expect(world.sent.map((entry) => entry.url)).toEqual([
      expect.stringContaining(`/api/integrations/${INTEGRATION}/test`),
    ]);
  });
});

describe('step 1 shows what Test connection answered (WP-155 (b), backlog 451)', () => {
  it('shows pending, then the failed result with its checks, beside the tested integration only', async () => {
    let resolve: (value: TestIntegrationResponse) => void = () => undefined;
    const world = newWorld({
      probe: new Promise<TestIntegrationResponse>((settle) => {
        resolve = settle;
      }),
    });
    render(createApp({ fetchImpl: fetchFor(world), realtime: false }).element);
    const row = (await screen.findByText('Acme GitLab')).closest('[data-integration-row]');
    const other = screen.getByText('Other GitLab').closest('[data-integration-row]');
    if (!(row instanceof HTMLElement) || !(other instanceof HTMLElement)) {
      throw new Error('no integration rows');
    }
    fireEvent.click(within(row).getByRole('button', { name: 'Test connection' }));
    expect(await within(row).findByText('Testing the connection…')).toBeTruthy();
    await waitFor(() => {
      expect(world.sent.map((entry) => entry.url)).toEqual([
        expect.stringContaining(`/api/integrations/${INTEGRATION}/test`),
      ]);
    });
    act(() => {
      resolve({
        ok: false,
        checks: [
          { name: 'reachable', ok: true, detail: 'HTTP 200' },
          { name: 'authenticated', ok: false, detail: '401 <b>Unauthorized</b>' },
        ],
      });
    });
    expect(await within(row).findByText('Last test: failed')).toBeTruthy();
    expect(within(row).getByText('authenticated')).toBeTruthy();
    // The provider's words, as text (BD-022).
    expect(row.textContent).toContain('401 <b>Unauthorized</b>');
    expect(row.querySelector('b')).toBeNull();
    // Beside the integration that was tested, and not the other one.
    expect(other.textContent).not.toContain('Last test');
  });

  it('shows the error notice when the test could not be run', async () => {
    const world = newWorld({ probe: null });
    render(createApp({ fetchImpl: fetchFor(world), realtime: false }).element);
    const row = (await screen.findByText('Acme GitLab')).closest('[data-integration-row]');
    if (!(row instanceof HTMLElement)) throw new Error('no integration row');
    fireEvent.click(within(row).getByRole('button', { name: 'Test connection' }));
    const alert = await within(row).findByRole('alert');
    expect(alert.textContent).toContain('The connection test could not be run.');
  });
});

describe('step 2 reads the discovery task back (WP-155 (c), backlog 452)', () => {
  it('reads each phase from the task’s state and its runs', () => {
    expect(discoveryPhaseOf('queued', [])).toBe('queued');
    expect(discoveryPhaseOf('active', [])).toBe('queued');
    expect(discoveryPhaseOf('active', [run({ status: 'completed' })])).toBe('queued');
    expect(discoveryPhaseOf('active', [run()])).toBe('running');
    expect(discoveryPhaseOf('needs_human', [run({ status: 'failed' })])).toBe('needs_human');
    expect(discoveryPhaseOf('paused', [])).toBe('paused');
    expect(discoveryPhaseOf('done', [])).toBe('done');
    expect(discoveryPhaseOf('cancelled', [])).toBe('cancelled');
  });

  it('shows a running discovery after a refresh, with the link to its live transcript', async () => {
    // Nobody pressed anything in this app: a fresh app over a world with a live task is a refresh.
    const world = newWorld({ gate: gateFor('active'), task: taskDetail('active', [run()]) });
    render(createApp({ fetchImpl: fetchFor(world), realtime: false }).element);
    const status = await screen.findByTestId('discovery-status');
    await waitFor(() => {
      expect(status.getAttribute('data-discovery-phase')).toBe('running');
    });
    expect(
      within(status).getByRole('link', { name: 'Watch its live transcript' }).getAttribute('href'),
    ).toBe(`/runs/${RUN}`);
    expect(within(status).getByRole('link', { name: 'Open its task' }).getAttribute('href')).toBe(
      `/projects/acme_api/tasks/${TASK}`,
    );
    expect(world.sent).toEqual([]);
  });

  it('shows a queued discovery as queued', async () => {
    const world = newWorld({ gate: gateFor('active'), task: taskDetail('active', []) });
    render(createApp({ fetchImpl: fetchFor(world), realtime: false }).element);
    const status = await screen.findByTestId('discovery-status');
    await waitFor(() => {
      expect(status.textContent).toContain('Waiting for its run to start.');
    });
    expect(status.getAttribute('data-discovery-phase')).toBe('queued');
  });

  it('shows a parked discovery with the escalation’s reason and brief, as text', async () => {
    const escalation = {
      at: '2026-10-07T05:30:00.000Z',
      reason: 'run_failed',
      brief: 'The run failed: <img src=x onerror=alert(1)> exit 1',
    };
    const world = newWorld({
      gate: gateFor('needs_human', escalation),
      task: taskDetail('needs_human', [run({ status: 'failed', ended_at: escalation.at })]),
    });
    const { container } = render(
      createApp({ fetchImpl: fetchFor(world), realtime: false }).element,
    );
    const status = await screen.findByTestId('discovery-status');
    await waitFor(() => {
      expect(status.textContent).toContain('run_failed');
    });
    expect(status.getAttribute('data-discovery-phase')).toBe('needs_human');
    expect(status.textContent).toContain('needs a person');
    expect(status.textContent).toContain('The run failed: <img src=x onerror=alert(1)> exit 1');
    expect(container.querySelector('img')).toBeNull();
  });

  it('shows a finished discovery with the readiness level it recorded', async () => {
    const world = newWorld({
      gate: gateFor('done'),
      task: taskDetail('done', [run({ status: 'completed' })]),
      readiness: 'recorded',
    });
    render(createApp({ fetchImpl: fetchFor(world), realtime: false }).element);
    const status = await screen.findByTestId('discovery-status');
    await waitFor(() => {
      expect(status.textContent).toContain('the project is at readiness level 2');
    });
    expect(status.getAttribute('data-discovery-phase')).toBe('done');
  });

  it('shows nothing to follow before the first discovery, and says when the read failed', async () => {
    const before = newWorld({
      gate: { can_start: false, blocker: null, ceiling_usd: 2, last_discovery: null },
    });
    // Wait on the gate read itself (rule 87): before it, "nothing shown" proves nothing.
    let gateReads = 0;
    const counting = fetchFor(before);
    const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input instanceof Request ? input.url : input).endsWith('/rediscovery')) {
        gateReads += 1;
      }
      return counting(input, init);
    }) as typeof fetch;
    render(createApp({ fetchImpl, realtime: false }).element);
    await screen.findByText('Technical discovery');
    await waitFor(() => {
      expect(gateReads).toBeGreaterThan(0);
    });
    expect(before.sent).toEqual([]);
    expect(screen.queryByTestId('discovery-status')).toBeNull();
    cleanup();

    render(createApp({ fetchImpl: fetchFor(newWorld()), realtime: false }).element);
    expect(
      await screen.findByText(/Where the last discovery is could not be read/, undefined, {
        timeout: 4_000,
      }),
    ).toBeTruthy();
  });

  it('takes the task’s own state over the gate’s when the two reads disagree', async () => {
    // The gate names the task; the task says where it is. A gate read an instant older (it is
    // refetched on its own schedule) must not hold the step at the older state.
    const world = newWorld({ gate: gateFor('active'), task: taskDetail('paused', []) });
    render(createApp({ fetchImpl: fetchFor(world), realtime: false }).element);
    const status = await screen.findByTestId('discovery-status');
    await waitFor(() => {
      expect(status.getAttribute('data-discovery-phase')).toBe('paused');
    });
    expect(status.textContent).toContain('It is paused');
  });

  it('follows the task live: a frame for it moves the step from running to parked', async () => {
    const world = newWorld({ gate: gateFor('active'), task: taskDetail('active', [run()]) });
    const { streams, openStream } = fakeStreams();
    render(createApp({ fetchImpl: fetchFor(world), openStream }).element);
    const status = await screen.findByTestId('discovery-status');
    await waitFor(() => {
      expect(status.getAttribute('data-discovery-phase')).toBe('running');
    });
    const topic = `task:${TASK}` as SseTopic;
    // The step retained the task's topic: a stream was opened with it, or the open one was asked
    // to carry it — either way the newest stream is the one that speaks for it.
    await waitFor(() => {
      expect(
        world.subscriptions.some((body) => body.includes(topic)) ||
          decodeURIComponent(streams.at(-1)?.url ?? '').includes(topic),
      ).toBe(true);
    });
    const stream = streams.at(-1);
    // The server moves the task; the frame is what tells the page.
    const escalation = { at: '2026-10-07T05:30:00.000Z', reason: 'run_failed', brief: 'exit 1' };
    world.task = taskDetail('needs_human', [run({ status: 'failed' })]);
    world.gate = gateFor('needs_human', escalation);
    act(() => {
      stream?.open();
      stream?.emit(escalatedFrame(topic), `${topic}:1`);
    });
    await waitFor(() => {
      expect(status.getAttribute('data-discovery-phase')).toBe('needs_human');
    });
    await waitFor(() => {
      expect(status.textContent).toContain('run_failed');
    });
  });
});

/** A `task.escalated` frame on the task's topic, parsed with the published schema. */
const escalatedFrame = (topic: SseTopic): SseFrame => {
  const frame = sseFrameSchema.parse({
    frame: 'domain_event',
    topic,
    seq: 1,
    type: 'task.escalated',
    data: {
      id: '00000000-0000-4000-8000-0000000000e1',
      stream_type: 'task',
      stream_id: TASK,
      stream_seq: 3,
      correlation_id: TASK,
      cause_event_id: null,
      actor: { kind: 'system', component: 'pipeline' },
      occurred_at: '2026-10-07T05:30:00.000Z',
      type: 'task.escalated',
      payload: {
        project_id: PROJECT,
        task_id: TASK,
        reason: 'run_failed',
        blocker_brief: 'exit 1',
      },
    },
  });
  return frame;
};

/** A fake `EventSource` the test can speak SSE frames into (`task-timeline.test.tsx`'s shape). */
const fakeStreams = () => {
  const streams: {
    readonly url: string;
    readonly emit: (frame: SseFrame, id: string) => void;
    readonly open: () => void;
  }[] = [];
  const openStream = (url: string): EventStream => {
    const listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();
    streams.push({
      url,
      emit: (frame, id) => {
        const message = new MessageEvent<string>('message', {
          data: JSON.stringify(frame),
          lastEventId: id,
        });
        for (const listener of listeners.get('message') ?? []) listener(message);
      },
      open: () => {
        for (const listener of listeners.get('open') ?? []) {
          listener(new MessageEvent<string>('open', { data: '' }));
        }
      },
    });
    return {
      addEventListener: (type, listener) => {
        listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      },
      close: () => undefined,
    };
  };
  return { streams, openStream };
};

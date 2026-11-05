/**
 * The run page as an Actions job (S-23.10, research/19 § 5.2 "Run"): the header's way back to the
 * task and its actions, the job list in stage order, *Details*, the summary strip, the *Now:* line
 * and the newest *Live activity* rows, and the transcript as log steps.
 *
 * Driven through `createApp` with a fake server, as `run-cancel.test.tsx` is: the real router,
 * query client and endpoint parsers, so a body the screen cannot parse fails here.
 */
import type {
  RunReadResponse,
  RunRecord,
  TaskDetailResponse,
  TranscriptEvent,
} from '@platform/contracts';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';

const PROJECT = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-0000000000b1';
const REFINE = '00000000-0000-4000-8000-0000000000c1';
const IMPL_1 = '00000000-0000-4000-8000-0000000000c2';
const IMPL_2 = '00000000-0000-4000-8000-0000000000c3';

const SESSION: SessionResponse = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'operator@example.invalid',
    name: 'Fake Operator',
    role: 'member',
  },
  session: { id: '00000000-0000-4000-8000-000000000002' },
};

const HOSTILE_TITLE = '<img src=x onerror=alert(1)> Add VAT';

const runOf = (
  id: string,
  stage: string,
  attempt: number,
  status: RunRecord['status'],
  startedAt: string,
): RunRecord => ({
  id,
  task_id: TASK,
  project_id: PROJECT,
  stage,
  role: stage === 'refinement' ? 'product_manager' : 'developer',
  mode: 'normal',
  attempt,
  session_id: null,
  model: 'claude-test',
  effort: 'high',
  provider_mode: 'api',
  prompt_version: 'developer@9.9.9',
  status,
  terminal_reason: status === 'running' ? null : status === 'completed' ? 'success' : 'cancelled',
  started_at: startedAt,
  ended_at: status === 'running' ? null : '2026-11-05T09:30:00.000Z',
  last_output_at: null,
  num_turns: 7,
  usage: {
    input_tokens: 1200,
    output_tokens: 340,
    cache_write_5m_tokens: 0,
    cache_write_1h_tokens: 0,
    cache_read_tokens: 9000,
  },
  model_usage: [],
  cost: { usd: 0.84, is_estimate: true, price_list_id: null },
  wall_ms: 1_000,
  redaction_count: 0,
  settings_hash: null,
  start_failure: null,
  saved_work: null,
  latest_progress: null,
});

/** The task's runs, deliberately not in stage order. */
const RUNS: readonly RunRecord[] = [
  runOf(IMPL_2, 'implementation', 2, 'running', '2026-11-05T10:00:00.000Z'),
  runOf(REFINE, 'refinement', 1, 'completed', '2026-11-05T08:00:00.000Z'),
  runOf(IMPL_1, 'implementation', 1, 'cancelled', '2026-11-05T09:00:00.000Z'),
];

const stageRow = (stage: string, attempt: number, enteredAt: string) => ({
  stage,
  attempt,
  state: 'completed' as const,
  entered_at: enteredAt,
  exited_at: null,
  outcome: null,
});

const detail = (over: Partial<TaskDetailResponse> = {}): TaskDetailResponse => ({
  task: {
    id: TASK,
    project_id: PROJECT,
    ticket: { provider: 'jira', key: 'ACME-12', url: 'https://jira.example.test/browse/ACME-12' },
    ticket_title: HOSTILE_TITLE,
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
    cost_actual_usd: 1.25,
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
    created_at: '2026-11-05T07:00:00.000Z',
    updated_at: '2026-11-05T07:00:00.000Z',
    completed_at: null,
    ticket_claim: null,
    qa_stage: false,
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
  stages: [
    stageRow('refinement', 1, '2026-11-05T07:30:00.000Z'),
    stageRow('implementation', 1, '2026-11-05T08:30:00.000Z'),
    stageRow('implementation', 2, '2026-11-05T09:45:00.000Z'),
  ],
  artifacts: [],
  questions: [],
  approvals: [],
  runs: [...RUNS],
  ...over,
});

const envelope = {
  run_id: IMPL_2,
  parent_tool_use_id: null,
  redaction_count: 0,
} as const;

/** A Read that answered in 200 ms, then a Bash still running. */
const MESSAGES: TranscriptEvent[] = [
  {
    ...envelope,
    kind: 'assistant',
    seq: 1,
    created_at: '2026-11-05T10:00:01.000Z',
    model: 'claude-test',
    content: [
      { type: 'text', text: 'I will add the rate table first.' },
      {
        type: 'tool_use',
        tool_use_id: 'read-1',
        tool_name: 'Read',
        input: { file_path: 'src/invoice.ts' },
      },
    ],
  },
  {
    ...envelope,
    kind: 'user',
    seq: 2,
    created_at: '2026-11-05T10:00:01.200Z',
    content: [
      { type: 'tool_result', tool_use_id: 'read-1', is_error: false, content: 'export {};' },
    ],
  },
  {
    ...envelope,
    kind: 'assistant',
    seq: 3,
    created_at: '2026-11-05T10:00:02.000Z',
    model: 'claude-test',
    content: [
      {
        type: 'tool_use',
        tool_use_id: 'bash-1',
        tool_name: 'Bash',
        input: { command: 'pnpm test invoice' },
      },
    ],
  },
] as TranscriptEvent[];

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const asRead = (record: RunRecord): RunReadResponse => ({
  ...record,
  retry_defaults: { model: record.model, effort: record.effort },
});

const fetchFor = (task: TaskDetailResponse, shown: RunRecord, messages: TranscriptEvent[]) =>
  (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    const path = new URL(url, 'http://localhost').pathname;
    if (url.includes('/api/auth/get-session')) return json(SESSION);
    if (path === `/api/runs/${shown.id}/messages`) return json({ items: messages, next_seq: null });
    if (path === `/api/runs/${shown.id}/commands`) return json({ items: [] });
    if (path === `/api/runs/${shown.id}`) return json(asRead(shown));
    if (path === `/api/tasks/${TASK}`) return json(task);
    if (path === '/api/projects') return json({ items: [] });
    return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
  }) as typeof fetch;

const LIVE = RUNS[0] as RunRecord;
const NOW = Date.parse('2026-11-05T10:03:04.000Z');

const open = (shown: RunRecord = LIVE, task = detail(), messages = MESSAGES) => {
  window.history.pushState({}, '', `/runs/${shown.id}`);
  return render(
    createApp({
      fetchImpl: fetchFor(task, shown, messages),
      realtime: false,
      // The run started at 10:00; "now" is 3 m 4 s later, the Bash call inside its stuck bound.
      now: () => NOW,
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

describe('the run page’s header', () => {
  it('leads back to the task by its key and title, as text, and names the stage, role and attempt', async () => {
    const view = open();
    const back = await screen.findByRole('link', { name: /ACME-12/ });
    expect(back.getAttribute('href')).toBe(`/tasks/${TASK}`);
    expect(back.textContent).toContain(HOSTILE_TITLE);
    expect(view.container.querySelector('img')).toBeNull();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Implementation · Developer · attempt 2' }),
    ).toBeTruthy();
  });

  it('keeps Take over… and Download transcript in the run actions menu', async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: 'Run actions' }));
    const menu = within(await screen.findByRole('menu'));
    const download = menu.getByRole('menuitem', { name: 'Download transcript' });
    expect(new URL(download.getAttribute('href') ?? '').pathname).toBe(
      `/api/runs/${IMPL_2}/transcript.jsonl`,
    );
    await user.click(menu.getByRole('menuitem', { name: 'Take over…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Take over this task' });
    expect(within(dialog).getByRole('form', { name: `Take task ${TASK} over` })).toBeTruthy();
  });

  it('offers no take-over for a finished task that nobody holds', async () => {
    const user = userEvent.setup();
    const finished = detail();
    open(LIVE, { ...finished, task: { ...finished.task, state: 'done' } });
    await user.click(await screen.findByRole('button', { name: 'Run actions' }));
    const menu = within(await screen.findByRole('menu'));
    expect(menu.getByRole('menuitem', { name: 'Download transcript' })).toBeTruthy();
    expect(menu.queryByRole('menuitem', { name: 'Take over…' })).toBeNull();
  });
});

describe('the job list', () => {
  it('lists the task’s runs in stage order, each with its status, this one current', async () => {
    open();
    const nav = await screen.findByRole('navigation', { name: 'Runs of this task' });
    await waitFor(() => {
      expect(within(nav).getAllByRole('link')).toHaveLength(3);
    });
    const links = within(nav).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual([
      'Refinement, Completed',
      'Implementation, Cancelled',
      'Implementation · attempt 2, Running',
    ]);
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      `/runs/${REFINE}`,
      `/runs/${IMPL_1}`,
      `/runs/${IMPL_2}`,
    ]);
    expect(links.map((link) => link.getAttribute('aria-current'))).toEqual([null, null, 'page']);
  });

  it('keeps the settings line, the saved work and the prompt version under Details', async () => {
    const view = open();
    await screen.findByRole('navigation', { name: 'Runs of this task' });
    const details = view.container.querySelector('aside details');
    expect(details?.querySelector('summary')?.textContent).toContain('Details');
    expect(details?.hasAttribute('open')).toBe(false);
    expect(details?.querySelector('[data-run-settings="line"]')).not.toBeNull();
    expect(details?.textContent).toContain('developer@9.9.9');
  });
});

describe('the summary strip and what the agent is doing now', () => {
  it('says status, model, effort, cost, elapsed, turns and tokens', async () => {
    const view = open();
    await screen.findByRole('tab', { name: 'Transcript' });
    const strip = view.container.querySelector('[data-run-summary]');
    const text = strip?.textContent ?? '';
    for (const word of ['Status', 'Running', 'claude-test', 'high', '$0.84 est.', '3m 4s']) {
      expect(text).toContain(word);
    }
    expect(text).toContain('7');
    expect(text).toContain('1,200 in · 340 out · 9,000 cached');
  });

  it.each([
    [
      {
        kind: 'worker',
        worker_id: '00000000-0000-4000-8000-0000000283e1',
        worker_name: 'alice-laptop',
      },
      'Executed byalice-laptop (worker)',
    ],
    [{ kind: 'server', worker_id: null, worker_name: null }, 'Executed bythe platform server'],
    [null, 'Executed bynot claimed yet'],
  ] as const)(
    'says who executed the run from its seat (WP-283 (5)): %j',
    async (seat, expected) => {
      window.history.pushState({}, '', `/runs/${LIVE.id}`);
      const base = fetchFor(detail(), LIVE, MESSAGES);
      const view = render(
        createApp({
          fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) =>
            new URL(String(input), 'http://localhost').pathname === `/api/runs/${LIVE.id}`
              ? json({ ...asRead(LIVE), seat })
              : base(input, init)) as typeof fetch,
          realtime: false,
          now: () => NOW,
        }).element,
      );
      await screen.findByRole('tab', { name: 'Transcript' });
      await waitFor(() => {
        expect(view.container.querySelector('[data-run-summary]')?.textContent ?? '').toContain(
          expected,
        );
      });
    },
  );

  it('says Now: in the activity vocabulary and lists the newest live activity', async () => {
    const view = open();
    await waitFor(() => {
      expect(view.container.querySelector('[data-run-now]')?.textContent).toBe(
        'Now: Running a command',
      );
    });
    const rows = within(screen.getByRole('list', { name: 'Live activity' })).getAllByRole(
      'listitem',
    );
    expect(rows.map((row) => row.getAttribute('data-activity-row'))).toEqual([
      'done',
      'done',
      'current',
    ]);
  });

  it('shows neither for a run that has ended, nor the steer box', async () => {
    const ended = RUNS[1] as RunRecord;
    const view = open(ended, detail(), []);
    await screen.findByTestId('transcript-scroller');
    expect(view.container.querySelector('[data-run-now]')).toBeNull();
    expect(screen.queryByRole('list', { name: 'Live activity' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Steer the agent' })).toBeNull();
  });
});

describe('the transcript as log steps', () => {
  it('draws a finished call collapsed with its duration, and the running one open', async () => {
    const view = open();
    await waitFor(() => {
      expect(view.container.querySelectorAll('[data-log-step="tool"]')).toHaveLength(2);
    });
    const [read, bash] = [...view.container.querySelectorAll('[data-log-step="tool"]')];
    expect(read?.hasAttribute('open')).toBe(false);
    expect(read?.querySelector('summary')?.textContent).toContain('Read');
    expect(read?.querySelector('summary')?.textContent).toContain('src/invoice.ts');
    expect(read?.querySelector('[data-step-timing]')?.textContent).toBe('0.2s');
    expect(bash?.hasAttribute('open')).toBe(true);
    expect(bash?.querySelector('[data-step-timing]')?.textContent).toBe('running');
    // The assistant's words stay prose, outside any step.
    expect(view.container.querySelector('[data-block-kind="text"]')?.textContent).toContain(
      'I will add the rate table first.',
    );
    // The steer box sits under the log while the run is live.
    expect(screen.getByRole('textbox', { name: 'Steer the agent' })).toBeTruthy();
  });

  it('offers no steer box to a run still waiting for a seat, which the server would refuse', async () => {
    const created: RunRecord = { ...LIVE, status: 'created', started_at: null };
    open(created, detail(), []);
    expect(await screen.findByRole('button', { name: 'Cancel run' })).toBeTruthy();
    await screen.findByTestId('transcript-scroller');
    expect(screen.queryByRole('textbox', { name: 'Steer the agent' })).toBeNull();
  });
});

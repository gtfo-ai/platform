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
import { primaryLabels } from '../ui/primary-census.js';
import { seatlessWords, waitingItemOf } from './run-detail.js';

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
  stop_reason: null,
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
    paused_budget_figures: null,
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
    tracker_assignee: null,
    owner: null,
    owner_source: null,
    unlinked_assignee: null,
    owner_writes_back: false,
    waiting: null,
  },
  taken_over: null,
  can_raise_budget: false,
  can_export: false,
  can_pause: true,
  can_resume: true,
  can_cancel: true,
  can_return: true,
  can_rework: true,
  can_decide_approval: true,
  can_change_limits: false,
  can_retry_run: true,
  can_take_over: true,
  can_take: false,
  can_assign: false,
  can_unassign: false,
  take_writes_back: false,
  gate_feedback: null,
  returns: [],
  stop: null,
  gate_wait: null,
  last_gate_wait: null,
  escalation: null,
  loop_limits: null,
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

/** The run's project, as the projects read lists it: the run page is framed by it (S-25.4). */
const PROJECT_ROW = {
  id: PROJECT,
  key: 'acme',
  name: 'Acme',
  repo_url: 'https://git.example.invalid/acme/acme.git',
  default_branch: 'main',
  agentic_dir: '.agentic',
  knowledge_dir: 'knowledge',
  autonomy_level: 'supervised',
  readiness_level: 2,
  status: 'active',
  created_at: '2026-11-05T07:00:00.000Z',
  updated_at: '2026-11-05T07:00:00.000Z',
  open_tasks: 1,
  spent_usd_30d: 1,
};

const fetchFor = (
  task: TaskDetailResponse,
  shown: RunRecord,
  messages: TranscriptEvent[],
  /** A promise holds the projects read back until the test resolves it. */
  projects: readonly unknown[] | Promise<readonly unknown[]> = [],
) =>
  (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    const path = new URL(url, 'http://localhost').pathname;
    if (url.includes('/api/auth/get-session')) return json(SESSION);
    if (path === `/api/runs/${shown.id}/messages`) return json({ items: messages, next_seq: null });
    if (path === `/api/runs/${shown.id}/commands`) return json({ items: [] });
    if (path === `/api/runs/${shown.id}`) return json(asRead(shown));
    if (path === `/api/tasks/${TASK}`) return json(task);
    if (path === '/api/projects') return json({ items: await projects });
    return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
  }) as typeof fetch;

const LIVE = RUNS[0] as RunRecord;
const NOW = Date.parse('2026-11-05T10:03:04.000Z');
/** A usage limit's reset later the same day (WP-285). */
const USAGE_RESET = '2026-11-05T14:00:00.000Z';

const open = (
  shown: RunRecord = LIVE,
  task = detail(),
  messages = MESSAGES,
  projects: readonly unknown[] | Promise<readonly unknown[]> = [],
) => {
  window.history.pushState({}, '', `/runs/${shown.id}`);
  return render(
    createApp({
      fetchImpl: fetchFor(task, shown, messages, projects),
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

  it('sits inside its project’s frame, with the URL unchanged and the way back in the project (S-25.4)', async () => {
    open(LIVE, detail(), MESSAGES, [PROJECT_ROW]);
    // The project's tabs, the Board's current, and the breadcrumb that names the project.
    const tabs = await screen.findByRole('navigation', { name: 'Project' });
    expect(
      within(tabs)
        .getAllByRole('link')
        .find((link) => link.getAttribute('aria-current') === 'page')?.textContent,
    ).toBe('Board');
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' }).textContent).toContain('Acme');
    // The organisation's row gives way to the project's, as on every page of a project.
    expect(screen.queryByRole('navigation', { name: 'Primary' })).toBeNull();
    expect(window.location.pathname).toBe(`/runs/${IMPL_2}`);
    const back = await screen.findByRole('link', { name: /ACME-12/ });
    expect(back.getAttribute('href')).toBe(`/projects/acme/tasks/${TASK}`);
    // One `<h1>`: the run's; the project's name above it is not a heading.
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('never remounts the screen when the frame arrives late: a steer being typed survives (review of PR #80)', async () => {
    const user = userEvent.setup();
    let release: (items: readonly unknown[]) => void = () => undefined;
    const projects = new Promise<readonly unknown[]>((resolve) => {
      release = resolve;
    });
    open(LIVE, detail(), MESSAGES, projects);
    const box = (await screen.findByRole('textbox', {
      name: 'Message the agent',
    })) as HTMLInputElement;
    // While the projects read is out, neither row is drawn: no organisation row to take back.
    expect(screen.queryByRole('navigation', { name: 'Primary' })).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Project' })).toBeNull();
    await user.type(box, 'also check the rounding');

    release([PROJECT_ROW]);
    await screen.findByRole('navigation', { name: 'Project' });
    // The same element, with what was typed in it: the screen was not remounted.
    const after = screen.getByRole('textbox', { name: 'Message the agent' }) as HTMLInputElement;
    expect(after).toBe(box);
    expect(after.value).toBe('also check the rounding');
    expect(screen.queryByRole('navigation', { name: 'Primary' })).toBeNull();
  });

  it('keeps the organisation’s frame for a run whose project the caller cannot list', async () => {
    open();
    await screen.findByRole('link', { name: /ACME-12/ });
    expect(document.querySelector('[data-project-frame]')).toBeNull();
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeTruthy();
  });

  it('keeps Work on it yourself… and Download transcript in the run actions menu', async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: 'Run actions' }));
    const menu = within(await screen.findByRole('menu'));
    const download = menu.getByRole('menuitem', { name: 'Download transcript' });
    expect(new URL(download.getAttribute('href') ?? '').pathname).toBe(
      `/api/runs/${IMPL_2}/transcript.jsonl`,
    );
    await user.click(menu.getByRole('menuitem', { name: 'Work on it yourself…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Work on this task yourself' });
    expect(within(dialog).getByRole('form', { name: `Take task ${TASK} over` })).toBeTruthy();
  });

  it('offers no take-over for a finished task that nobody holds', async () => {
    const user = userEvent.setup();
    const finished = detail();
    open(LIVE, { ...finished, task: { ...finished.task, state: 'done' } });
    await user.click(await screen.findByRole('button', { name: 'Run actions' }));
    const menu = within(await screen.findByRole('menu'));
    expect(menu.getByRole('menuitem', { name: 'Download transcript' })).toBeTruthy();
    expect(menu.queryByRole('menuitem', { name: 'Work on it yourself…' })).toBeNull();
  });
});

/**
 * S-25.21 (BACKLOG 1393): the header's *Re-run ▾* and the `···` menu's *Work on it yourself…* are
 * drawn only for a reader whose role the routes admit — the task read's `can_retry_run`
 * (`run.retry`) and `can_take_over` (`task.take_over`). Both cases wait for the task read (the back
 * link carries its ticket key), so the viewer's absence is not the page before the read answered.
 */
describe('only what the reader’s role may do', () => {
  const ENDED = RUNS[1] as RunRecord;

  it('offers a member Re-run and Work on it yourself…', async () => {
    const user = userEvent.setup();
    open(ENDED, detail({ can_retry_run: true, can_take_over: true }), []);
    await screen.findByRole('link', { name: /ACME-12/ });
    expect(await screen.findByRole('button', { name: 'Re-run' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Run actions' }));
    const menu = within(await screen.findByRole('menu'));
    expect(menu.getByRole('menuitem', { name: 'Work on it yourself…' })).toBeTruthy();
  });

  it('offers a viewer neither, and still the transcript download', async () => {
    const user = userEvent.setup();
    open(ENDED, detail({ can_retry_run: false, can_take_over: false }), []);
    await screen.findByRole('link', { name: /ACME-12/ });
    expect(screen.queryByRole('button', { name: 'Re-run' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Run actions' }));
    const menu = within(await screen.findByRole('menu'));
    expect(menu.getByRole('menuitem', { name: 'Download transcript' })).toBeTruthy();
    expect(menu.queryByRole('menuitem', { name: 'Work on it yourself…' })).toBeNull();
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
      'Runs onalice-laptop (worker)',
    ],
    [
      {
        kind: 'worker',
        worker_id: '00000000-0000-4000-8000-0000000283e1',
        worker_name: 'alice-laptop',
        user_name: 'Alice',
      },
      'Runs onalice-laptop (Alice’s worker)',
    ],
    [{ kind: 'server', worker_id: null, worker_name: null }, 'Runs onthe platform server'],
    // S-25.4: a running run with no seat is not "not claimed yet" beside *Running*.
    [null, 'Runs onnot recorded'],
    // WP-285: the worker is paused by its usage limit — the Workers screen's own sentence.
    [
      {
        kind: 'worker',
        worker_id: '00000000-0000-4000-8000-0000000283e1',
        worker_name: 'alice-laptop',
        usage_pause: { until: USAGE_RESET, estimated: false, timezone: 'UTC' },
      },
      `Runs onalice-laptop (worker)Paused — usage limit until ${USAGE_RESET.slice(11, 16)}`,
    ],
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

  /**
   * S-23.22 (the final UX audit's item 5): the page said *that* a run ended and never *why* —
   * `TERMINAL_REASON_LABEL` had no caller in the SPA. A live run has no reason, so no metric.
   */
  it.each([
    ['error_max_turns', 'Ended becauseRan out of turns'],
    ['lease_expired', 'Ended becauseLost its worker'],
    ['success', 'Ended becauseSucceeded'],
  ] as const)('says why the run ended (%s)', async (reason, expected) => {
    const ended: RunRecord = {
      ...LIVE,
      status: 'failed',
      terminal_reason: reason,
      ended_at: '2026-11-05T10:02:00.000Z',
    };
    window.history.pushState({}, '', `/runs/${ended.id}`);
    const base = fetchFor(detail(), LIVE, MESSAGES);
    const view = render(
      createApp({
        fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) =>
          new URL(String(input), 'http://localhost').pathname === `/api/runs/${ended.id}`
            ? json(asRead(ended))
            : base(input, init)) as typeof fetch,
        realtime: false,
        now: () => NOW,
      }).element,
    );
    await waitFor(() => {
      expect(view.container.querySelector('[data-run-summary]')?.textContent ?? '').toContain(
        expected,
      );
    });
    expect(view.container.querySelector('[data-run-summary]')?.textContent).not.toContain(reason);
  });

  it('says no reason while the run is live', async () => {
    const view = open();
    await screen.findByRole('tab', { name: 'Transcript' });
    await waitFor(() => {
      expect(view.container.querySelector('[data-run-summary]')?.textContent).toContain('Status');
    });
    expect(view.container.querySelector('[data-run-summary]')?.textContent).not.toContain(
      'Ended because',
    );
  });

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

  it('links Now: Needs you to what the task waits for (S-25.4)', async () => {
    const question = {
      id: '00000000-0000-4000-8000-0000000000f1',
      task_id: TASK,
      stage: 'implementation',
      text: 'Round per line or per invoice?',
      options: null,
      blocking: true,
      status: 'open' as const,
      asked_at: '2026-11-05T10:01:00.000Z',
      reminders_sent: 0,
      answered_at: null,
      answer: null,
    };
    const view = open(LIVE, detail({ questions: [question] }), MESSAGES, [PROJECT_ROW]);
    const link = await screen.findByRole('link', { name: 'Answer the question →' });
    expect(view.container.querySelector('[data-run-now]')?.getAttribute('data-run-now')).toBe(
      'needs_you',
    );
    // Inside the project, onto the answer box the task page's *Answer* moves to.
    expect(link.getAttribute('href')).toBe(`/projects/acme/tasks/${TASK}#answer-${question.id}`);
  });

  it('names no waiting item for a task nothing waits on', () => {
    expect(waitingItemOf(detail())).toBeNull();
    expect(waitingItemOf(undefined)).toBeNull();
    expect(waitingItemOf(detail({ task: { ...detail().task, state: 'needs_human' } }))).toEqual({
      label: 'See what it needs',
      hash: null,
    });
  });

  it('shows neither for a run that has ended, nor the steer box', async () => {
    const ended = RUNS[1] as RunRecord;
    const view = open(ended, detail(), []);
    await screen.findByTestId('transcript-scroller');
    expect(view.container.querySelector('[data-run-now]')).toBeNull();
    expect(screen.queryByRole('list', { name: 'Live activity' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Message the agent' })).toBeNull();
  });
});

// S-23.23 (the UX audit's § 2): Steer and the transcript's *Following* toggle were both the
// beacon beside Re-run or Cancel run, so a live run drew two. A toggle is `default` with
// `aria-pressed`, Steer is an inline form's quiet submit, and Re-run is not offered while the run is
// live (the server refuses it).
describe('one primary action at most', () => {
  it('draws none on a live run — Cancel run is its one coloured action — and no Re-run', async () => {
    open();
    await screen.findByRole('textbox', { name: 'Message the agent' });
    // The toggle says its state with `aria-pressed`, not with the beacon's colour.
    expect(screen.getByRole('button', { name: /^Follow/ }).hasAttribute('aria-pressed')).toBe(true);
    expect(primaryLabels()).toEqual([]);
    // S-25.4 (product/10's Run detail amendment): a danger secondary — red outline — never amber.
    const cancel = screen.getByRole('button', { name: 'Cancel run' });
    expect(cancel.className).toContain('text-danger');
    expect(cancel.className).not.toContain('border-primary-line');
    expect(screen.queryByRole('button', { name: 'Re-run' })).toBeNull();
  });

  it('draws none inside the project frame either', async () => {
    open(LIVE, detail(), MESSAGES, [PROJECT_ROW]);
    await waitFor(() => {
      expect(document.querySelector('[data-project-frame]')).not.toBeNull();
    });
    await screen.findByRole('textbox', { name: 'Message the agent' });
    expect(primaryLabels()).toEqual([]);
  });

  it('draws none on a completed run, whose Following toggle is not an action', async () => {
    open(RUNS[1] as RunRecord, detail(), []);
    await screen.findByTestId('transcript-scroller');
    await screen.findByRole('button', { name: 'Re-run' });
    expect(primaryLabels()).toEqual([]);
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
    expect(screen.getByRole('textbox', { name: 'Message the agent' })).toBeTruthy();
  });

  it('offers no steer box to a run still waiting for a seat, which the server would refuse', async () => {
    const created: RunRecord = { ...LIVE, status: 'created', started_at: null };
    const view = open(created, detail(), []);
    expect(await screen.findByRole('button', { name: 'Cancel run' })).toBeTruthy();
    await screen.findByTestId('transcript-scroller');
    expect(screen.queryByRole('textbox', { name: 'Message the agent' })).toBeNull();
    // S-25.4: only a run nobody has taken yet is "waiting to be picked up".
    expect(view.container.querySelector('[data-run-summary]')?.textContent).toContain(
      'Runs onwaiting to be picked up',
    );
  });

  it('words a seatless run from its own status (S-25.4)', () => {
    expect(seatlessWords({ status: 'created', started_at: null })).toBe('waiting to be picked up');
    expect(seatlessWords({ status: 'running', started_at: '2026-11-05T10:00:00.000Z' })).toBe(
      'not recorded',
    );
    expect(seatlessWords({ status: 'starting', started_at: null })).toBe('not recorded');
    expect(seatlessWords({ status: 'cancelled', started_at: null })).toBe('never picked up');
    expect(seatlessWords({ status: 'completed', started_at: '2026-11-05T10:00:00.000Z' })).toBe(
      'not recorded',
    );
  });
});

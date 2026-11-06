/**
 * The flow canvas on its two screens (S-23.5), driven through `createApp` with a fake server, so the
 * real router, query client and published parsers are in the path:
 *
 * - the task page's Flow section: the canvas on a wide screen with the ordered list beside it for
 *   screen readers; the stage timeline — the task page's list mode (S-25.4) — instead of the canvas
 *   below 768 px or when *List* is pressed, never both; a card or a timeline entry opens the stage
 *   dialog — live activity, the log (untrusted text kept as text), the watch-only note, *Open run* —
 *   and a live `run:<id>` frame moves both;
 * - the Pipeline tab: the template picker, a stage's configuration in the dialog, the effective
 *   configuration folded below.
 *
 * happy-dom applies no CSS and measures nothing, so the canvas's own drawing is the browser tier's
 * (`test/web-e2e/csp.spec.ts`); what is held here is which view a reader gets and what it says.
 */
import type {
  AgentsResponse,
  RunRecord,
  TaskDetailResponse,
  TranscriptEvent,
} from '@platform/contracts';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app/app.js';
import type { SessionResponse } from '../../auth/session.js';
import { FEATURE_GRAPH } from './graph.test-fixture.js';

const PROJECT = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-0000000000b1';
const RUN = '00000000-0000-4000-8000-0000000000c1';
const NOW = Date.parse('2026-11-05T16:45:00.000Z');
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

const usage = {
  input_tokens: 1,
  output_tokens: 1,
  cache_write_5m_tokens: 0,
  cache_write_1h_tokens: 0,
  cache_read_tokens: 0,
};

const run: RunRecord = {
  id: RUN,
  task_id: TASK,
  project_id: PROJECT,
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
  started_at: '2026-11-05T16:38:00.000Z',
  ended_at: null,
  last_output_at: null,
  num_turns: 3,
  usage,
  model_usage: [],
  cost: { usd: 0.42, is_estimate: false, price_list_id: null },
  wall_ms: 0,
  redaction_count: 0,
  settings_hash: null,
  start_failure: null,
  saved_work: null,
  latest_progress: null,
};

const detail: TaskDetailResponse = {
  task: {
    id: TASK,
    project_id: PROJECT,
    ticket: { provider: 'jira', key: 'ACME-1', url: 'https://jira.example.test/browse/ACME-1' },
    ticket_title: null,
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
    created_at: '2026-11-05T16:00:00.000Z',
    updated_at: '2026-11-05T16:00:00.000Z',
    completed_at: null,
    ticket_claim: null,
    qa_stage: false,
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
  gate_feedback: null,
  human_time: {
    total_minutes: 0,
    by_kind: { review: 0, question: 0, approval: 0, steer: 0 },
    by_user: null,
    entries: 0,
    withheld: { entries: 0, minutes: 0 },
  },
  stages: [
    {
      stage: 'refinement',
      attempt: 1,
      state: 'completed',
      entered_at: '2026-11-05T16:00:00.000Z',
      exited_at: '2026-11-05T16:10:00.000Z',
      outcome: 'approve',
    },
    {
      stage: 'implementation',
      attempt: 1,
      state: 'running',
      entered_at: '2026-11-05T16:37:00.000Z',
      exited_at: null,
      outcome: null,
    },
  ],
  artifacts: [
    {
      id: '00000000-0000-4000-8000-0000000000d1',
      artifact_type: 'ImplementationNotes',
      version: 1,
      url: null,
    },
  ],
  questions: [],
  approvals: [],
  runs: [run],
};

const agents: AgentsResponse = {
  items: [
    {
      run,
      project_id: PROJECT,
      task_id: TASK,
      role: 'developer',
      last_output_at: null,
      seat: {
        kind: 'worker',
        worker_id: '00000000-0000-4000-8000-0000000000e1',
        worker_name: HOSTILE,
      },
      activity: { kind: 'tool', tool_name: 'Read', at: '2026-11-05T16:44:00.000Z' },
    },
  ],
};

const envelope = {
  run_id: RUN,
  created_at: '2026-11-05T16:39:00.000Z',
  redaction_count: 0,
  parent_tool_use_id: null,
} as const;

const messages: TranscriptEvent[] = [
  {
    ...envelope,
    seq: 1,
    kind: 'assistant',
    model: 'claude-test',
    content: [
      {
        type: 'tool_use',
        tool_use_id: 'bash',
        tool_name: 'Bash',
        input: { command: `pnpm test ${HOSTILE}` },
      },
    ],
  },
  {
    ...envelope,
    seq: 2,
    kind: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'bash', is_error: false, content: '12 passed' }],
  },
];

const project = {
  id: PROJECT,
  key: 'api',
  name: 'API',
  repo_url: 'https://git.example.test/acme/api.git',
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

const BUG_GRAPH = { ...FEATURE_GRAPH, template: 'bug' };

const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
  const url = String(input);
  if (url.includes('/api/auth/get-session')) return json(SESSION);
  if (url.endsWith(`/api/tasks/${TASK}/pipeline`)) return json(FEATURE_GRAPH);
  if (url.endsWith(`/api/tasks/${TASK}/asks`)) return json({ items: [] });
  if (url.endsWith(`/api/tasks/${TASK}/audit`)) return json({ items: [] });
  if (url.endsWith(`/api/tasks/${TASK}`)) return json(detail);
  if (url.includes(`/api/runs/${RUN}/messages`)) return json({ items: messages, next_seq: null });
  if (url.endsWith('/api/org/agents')) return json(agents);
  if (url.endsWith(`/api/projects/${PROJECT}/pipeline`)) {
    return json({ items: [FEATURE_GRAPH, BUG_GRAPH] });
  }
  if (url.endsWith('/api/projects')) return json({ items: [project] });
  return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
}) as typeof fetch;

/** A `matchMedia` for a viewport `width` px wide (happy-dom applies no CSS). */
const viewport = (width: number): void => {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: Number(/min-width: (\d+)px/.exec(query)?.[1] ?? 0) <= width,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList,
  );
};

const start = (path: string) => {
  window.history.pushState({}, '', path);
  const app = createApp({ fetchImpl, realtime: false, now: () => NOW });
  render(app.element);
  return app;
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('the task page’s Flow section', () => {
  it('shows the stage timeline instead of the canvas below 768 px, and never both (S-25.4)', async () => {
    viewport(600);
    start(`/tasks/${TASK}`);
    const user = userEvent.setup();
    // The task page's list mode is its timeline: the attempts newest first, with their runs.
    const timeline = await screen.findByRole('list', { name: 'Timeline, newest first' });
    expect(screen.queryByTestId('flow-canvas-frame')).toBeNull();
    // The pipeline is drawn once: no stage-card list beside the timeline.
    expect(screen.queryByRole('list', { name: 'Feature pipeline as a list' })).toBeNull();
    expect(document.querySelectorAll('[data-stage-timeline]')).toHaveLength(1);
    // No List toggle where there is no canvas to toggle from.
    expect(screen.queryByRole('button', { name: 'List' })).toBeNull();
    // An entry's stage name opens the same stage dialog a card does.
    await user.click(within(timeline).getByRole('button', { name: 'Implementation' }));
    const dialog = await screen.findByRole('dialog', { name: 'Implementation' });
    expect(within(dialog).getByRole('link', { name: 'Open run' }).getAttribute('href')).toBe(
      `/runs/${RUN}`,
    );
  });

  it('says each stage’s state on the cards, the list a screen reader reads beside the canvas', async () => {
    viewport(1280);
    start(`/tasks/${TASK}`);
    const list = await screen.findByRole('list', { name: 'Feature pipeline as a list' });
    expect(list.getAttribute('data-flow-list')).toBe('screen-reader');
    // The current card says what the agent is doing — the agents read's newest entry (*Reading
    // files*) until the transcript has delivered anything, then the transcript's (*Running a
    // command*, the fixture's Bash call). Which one this read lands on is the live stage panel's
    // transcript page racing the lazily loaded canvas, so both are the right answer here; the
    // hand-over itself is the dialog test's below.
    await within(list).findByRole('button', {
      name: /^Implementation, Developer, Working, Now: (Reading files|Running a command), claude-test · high$/,
    });
    expect(
      within(list).getByRole('button', { name: /^Refinement, Product manager, Done, / }),
    ).toBeDefined();
    const current = list.querySelector('li[aria-current="step"]');
    expect(current?.textContent).toContain('Implementation');
    expect(
      within(list).getByText('Can send back to Architecture (Plan revisions · used 0 of 2)'),
    ).toBeDefined();
  });

  it('opens a stage’s run: live activity, the log as text, the seat, and follows the stream', async () => {
    viewport(1280);
    const app = start(`/tasks/${TASK}`);
    const user = userEvent.setup();
    const list = await screen.findByRole('list', { name: 'Feature pipeline as a list' });
    await user.click(await within(list).findByRole('button', { name: /^Implementation, / }));
    const dialog = await screen.findByRole('dialog', { name: 'Implementation' });
    expect(within(dialog).getByRole('heading', { name: 'Live activity' })).toBeDefined();
    await within(dialog).findByText('Running a command');
    const log = within(dialog).getByTestId('stage-log');
    await waitFor(() => {
      expect(log.textContent).toContain(`$ pnpm test ${HOSTILE}`);
    });
    expect(log.textContent).toContain('12 passed');
    // The hostile command and the hostile worker name are characters, never elements.
    expect(dialog.querySelector('img')).toBeNull();
    expect(within(dialog).getByText(/Watch-only — the agent runs on/).textContent).toContain(
      HOSTILE,
    );
    expect(within(dialog).getByRole('link', { name: 'Open run' }).getAttribute('href')).toBe(
      `/runs/${RUN}`,
    );
    expect(
      within(dialog).getByRole('link', { name: 'Open artifact (Implementation notes v1)' }),
    ).toBeDefined();

    // A live frame lands in the store the realtime provider writes to: a row and a line appear.
    act(() => {
      app.services.transcripts.apply({
        ...envelope,
        seq: 3,
        kind: 'assistant',
        model: 'claude-test',
        content: [
          {
            type: 'tool_use',
            tool_use_id: 'edit',
            tool_name: 'Edit',
            input: { file_path: 'b.ts' },
          },
        ],
      });
    });
    await within(dialog).findByText('Editing code');
    expect(dialog.querySelector('[data-activity-row="current"]')?.textContent).toContain(
      'Editing code',
    );
    await waitFor(() => {
      expect(log.textContent).toContain('› Edit b.ts');
    });
    // A tool name the run sent is the run's text: filtered on the card and in the row, and in the
    // log only inside the text the renderer filters — never a bidi override or a control character.
    act(() => {
      app.services.transcripts.apply({
        ...envelope,
        seq: 4,
        kind: 'assistant',
        model: 'claude-test',
        content: [
          {
            type: 'tool_use',
            tool_use_id: 'evil',
            tool_name: 'evil\u202Etxt.exe\u0007',
            input: {},
          },
        ],
      });
    });
    await within(dialog).findByText('Using evil\uFFFDtxt.exe');
    await waitFor(() => {
      expect(log.textContent).toContain('› evil\uFFFDtxt.exe');
    });
    expect(dialog.textContent).not.toContain('\u202E');
    expect(dialog.textContent).not.toContain('\u0007');
    const card = within(list).getByRole('button', { name: /^Implementation, /, hidden: true });
    expect(card.getAttribute('aria-label')).toContain('Now: Using evil\uFFFDtxt.exe');
    expect(card.textContent).not.toContain('\u202E');
    expect(card.textContent).not.toContain('\u0007');
    act(() => {
      app.services.transcripts.apply({
        ...envelope,
        seq: 5,
        kind: 'assistant',
        model: 'claude-test',
        content: [
          {
            type: 'tool_use',
            tool_use_id: 'edit2',
            tool_name: 'Edit',
            input: { file_path: 'b.ts' },
          },
        ],
      });
    });
    // …and the card behind the dialog follows the transcript rather than the agents read.
    expect(
      within(list).getByRole('button', { name: /Now: Editing code/, hidden: true }),
    ).toBeDefined();

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('shows the canvas on a wide screen, the list beside it for screen readers, and toggles', async () => {
    viewport(1280);
    start(`/tasks/${TASK}`);
    const user = userEvent.setup();
    expect(await screen.findByTestId('flow-canvas-frame')).toBeDefined();
    const list = screen.getByRole('list', { name: 'Feature pipeline as a list' });
    expect(list.getAttribute('data-flow-list')).toBe('screen-reader');
    expect(list.className).toContain('sr-only');
    // Reachable by a screen reader, never a Tab stop nobody can see.
    const copies = within(list).getAllByRole('button');
    expect(copies.length).toBe(FEATURE_GRAPH.nodes.length);
    expect(copies.every((button) => button.getAttribute('tabindex') === '-1')).toBe(true);

    // Beside the canvas, the timeline is not drawn a second time (S-25.4).
    expect(screen.queryByRole('list', { name: 'Timeline, newest first' })).toBeNull();

    const toggle = screen.getByRole('button', { name: 'List' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    await user.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByTestId('flow-canvas-frame')).toBeNull();
    // The task page's list mode is its stage timeline, in the canvas's place.
    const timeline = screen.getByRole('list', { name: 'Timeline, newest first' });
    expect(within(timeline).getAllByTestId('timeline-entry')).toHaveLength(2);
    expect(screen.queryByRole('list', { name: 'Feature pipeline as a list' })).toBeNull();
    await user.click(toggle);
    expect(await screen.findByTestId('flow-canvas-frame')).toBeDefined();
    expect(screen.queryByRole('list', { name: 'Timeline, newest first' })).toBeNull();
  });

  it('expands to the full screen and back, Escape included', async () => {
    viewport(1280);
    start(`/tasks/${TASK}`);
    const user = userEvent.setup();
    await screen.findByTestId('flow-canvas-frame');
    await user.click(screen.getByRole('button', { name: 'Full screen' }));
    const exit = screen.getByRole('button', { name: 'Exit full screen' });
    expect(exit.getAttribute('aria-pressed')).toBe('true');
    expect(exit.closest('[data-flow-view]')?.className).toContain('fixed');
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Full screen' })).toBeDefined();
  });
});

describe('the Pipeline tab', () => {
  it('picks a template, opens a stage’s configuration, and folds the effective configuration', async () => {
    viewport(600);
    start('/projects/api/pipeline');
    const user = userEvent.setup();
    const picker = await screen.findByRole('combobox', { name: 'Template' });
    expect(screen.getByRole('list', { name: 'Feature pipeline as a list' })).toBeDefined();
    await user.selectOptions(picker, 'bug');
    const list = await screen.findByRole('list', { name: 'Bug pipeline as a list' });
    // A template has no progress: no state word on an enabled stage, Disabled on a walked-over one.
    within(list).getByRole('button', { name: 'Code review, Reviewer, claude-test · high' });
    within(list).getByRole('button', { name: /^QA, Acceptance tester, Disabled/ });

    await user.click(within(list).getByRole('button', { name: /^Code review, / }));
    const dialog = await screen.findByRole('dialog', { name: 'Code review' });
    expect(dialog.textContent).toContain('Review verdict');
    expect(dialog.textContent).toContain('back to Implementation, at most 3 times');
    expect(dialog.textContent).toContain('Approved → Rebase check');
    expect(within(dialog).queryByRole('link', { name: 'Open run' })).toBeNull();

    expect(screen.getByText('Effective configuration').closest('details')).not.toBeNull();
  });
});

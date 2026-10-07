/**
 * The task page's stage timeline and its running stage's transcript — WP-154 rulings (a)–(c),
 * criterion (1), PROGRESS backlog 455 items (2)–(4).
 *
 * Driven through `createApp` with a fake server, as `live-stage.test.tsx` is, so the real router,
 * query client and `taskDetailResponseSchema` parser are in the path. The transcript case goes one
 * layer further out: the frames arrive as **SSE frames** on a fake `EventSource`, through the real
 * realtime client and provider, which is the path a live frame takes in the browser — not a write
 * into the transcript store the provider would have made.
 */
import type { RunRecord, SseFrame, TaskDetailResponse, TranscriptEvent } from '@platform/contracts';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';
import type { EventStream } from '../realtime/client.js';
import { TASK_PAGE_TRANSCRIPT_BLOCKS } from './live-transcript.js';
import { latestRunOf, timelineEntries } from './stage-timeline.js';

const PROJECT = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-0000000000b1';
const REFINEMENT_FAILED = '00000000-0000-4000-8000-0000000000c1';
const REFINEMENT_DONE = '00000000-0000-4000-8000-0000000000c2';
const NOT_STARTED = '00000000-0000-4000-8000-0000000000c3';
const LIVE = '00000000-0000-4000-8000-0000000000c4';
const ASK = '00000000-0000-4000-8000-0000000000c5';
const NOW = Date.parse('2026-10-07T10:10:00.000Z');

const SESSION: SessionResponse = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'operator@example.invalid',
    name: 'Fake Operator',
    role: 'member',
  },
  session: { id: '00000000-0000-4000-8000-000000000002' },
};

const run = (over: Partial<RunRecord>): RunRecord => ({
  id: LIVE,
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
  status: 'completed',
  terminal_reason: 'success',
  started_at: '2026-10-07T10:00:00.000Z',
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
  ...over,
});

const RUNS: readonly RunRecord[] = [
  run({ id: REFINEMENT_FAILED, stage: 'refinement', role: 'product_manager', status: 'failed' }),
  run({ id: REFINEMENT_DONE, stage: 'refinement', role: 'product_manager' }),
  // An ask run answers beside the pipeline and belongs to no stage.
  run({ id: ASK, stage: null, role: 'ask', attempt: 1 }),
  run({
    id: NOT_STARTED,
    status: 'cancelled',
    terminal_reason: 'cancelled',
    start_failure: {
      kind: 'not_started',
      diagnosis:
        'cancelled by a person before its CLI was asked to start: no process was holding the run, so it was ended as a record',
      detail: null,
      truncated: false,
      attempt: 1,
      retryable: false,
    },
  }),
  run({ id: LIVE, attempt: 2, status: 'running', terminal_reason: null }),
];

const STAGES: TaskDetailResponse['stages'] = [
  {
    stage: 'refinement',
    attempt: 1,
    state: 'completed',
    entered_at: '2026-10-07T09:00:00.000Z',
    exited_at: '2026-10-07T09:10:00.000Z',
    outcome: null,
  },
  {
    stage: 'plan_approval',
    attempt: 1,
    state: 'completed',
    entered_at: '2026-10-07T09:10:00.000Z',
    exited_at: '2026-10-07T09:20:00.000Z',
    outcome: null,
  },
  {
    stage: 'implementation',
    attempt: 1,
    state: 'returned',
    entered_at: '2026-10-07T09:20:00.000Z',
    exited_at: '2026-10-07T09:30:00.000Z',
    outcome: null,
  },
  {
    stage: 'implementation',
    attempt: 2,
    state: 'running',
    entered_at: '2026-10-07T10:00:00.000Z',
    exited_at: null,
    outcome: null,
  },
];

const detail = (runs: readonly RunRecord[]): TaskDetailResponse => ({
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
    created_at: '2026-10-07T09:00:00.000Z',
    updated_at: '2026-10-07T09:00:00.000Z',
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
  stages: STAGES,
  artifacts: [],
  questions: [],
  approvals: [],
  runs: [...runs],
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fetchFor = (task: TaskDetailResponse, subscriptions: string[] = []) =>
  (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.endsWith('/events/subscriptions')) {
      subscriptions.push(String(init?.body));
      return json({});
    }
    if (url.includes('/api/auth/get-session')) return json(SESSION);
    if (url.endsWith(`/api/tasks/${TASK}/asks`)) return json({ items: [] });
    if (url.endsWith(`/api/tasks/${TASK}/audit`)) return json({ items: [] });
    if (url.endsWith(`/api/tasks/${TASK}`)) return json(task);
    if (url.includes(`/api/runs/${LIVE}/messages`)) return json({ items: [], next_seq: null });
    if (url.endsWith('/api/projects')) return json({ items: [] });
    return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
  }) as typeof fetch;

const assistant = (seq: number, text: string): TranscriptEvent => ({
  run_id: LIVE,
  seq,
  created_at: '2026-10-07T10:05:00.000Z',
  redaction_count: 0,
  kind: 'assistant',
  model: 'claude-test',
  content: [{ type: 'text', text }],
});

/** A fake `EventSource` the test can speak SSE frames into. */
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  window.history.pushState({}, '', `/tasks/${TASK}`);
});

describe('which run a timeline entry leads to (WP-154 (b))', () => {
  it('is the latest run of the same stage and attempt, never an ask run, and none for a stage with none', () => {
    expect(latestRunOf(RUNS, { stage: 'refinement', attempt: 1 })?.id).toBe(REFINEMENT_DONE);
    expect(latestRunOf(RUNS, { stage: 'implementation', attempt: 1 })?.id).toBe(NOT_STARTED);
    expect(latestRunOf(RUNS, { stage: 'implementation', attempt: 2 })?.id).toBe(LIVE);
    expect(latestRunOf(RUNS, { stage: 'plan_approval', attempt: 1 })).toBeNull();
    expect(
      timelineEntries(STAGES, RUNS).map((entry) => [
        `${entry.stage.stage}#${String(entry.stage.attempt)}`,
        entry.link,
      ]),
    ).toEqual([
      ['implementation#2', { kind: 'run', runId: LIVE, live: true }],
      ['implementation#1', { kind: 'not_started', runId: NOT_STARTED }],
      ['plan_approval#1', { kind: 'none' }],
      ['refinement#1', { kind: 'run', runId: REFINEMENT_DONE, live: false }],
    ]);
  });
});

describe('the stage timeline on the task page (WP-154 (a), (b))', () => {
  it('lists the stages newest first, each linking to its latest run or saying it has none', async () => {
    render(
      createApp({ fetchImpl: fetchFor(detail(RUNS)), realtime: false, now: () => NOW }).element,
    );
    const list = await screen.findByRole('list', { name: 'Timeline, newest first' });
    const entries = within(list).getAllByTestId('timeline-entry');
    expect(entries.map((entry) => entry.textContent?.slice(0, 20))).toEqual([
      expect.stringMatching(/^implementation/),
      expect.stringMatching(/^implementation/),
      expect.stringMatching(/^plan_approval/),
      expect.stringMatching(/^refinement/),
    ]);
    expect(entries[0]?.textContent).toContain('try 2');
    const hrefOf = (index: number, name: string) =>
      within(entries[index] as HTMLElement)
        .getByRole('link', { name })
        .getAttribute('href');
    expect(hrefOf(0, 'Open the run (live)')).toBe(`/runs/${LIVE}`);
    // A run that did not start leads to its run page, where the not-started panel is.
    expect(hrefOf(1, 'Why the run did not start')).toBe(`/runs/${NOT_STARTED}`);
    // A stage with no run says so and links nothing.
    expect(entries[2]?.textContent).toContain('No run for this stage.');
    expect(within(entries[2] as HTMLElement).queryByRole('link')).toBeNull();
    // The latest of the attempt's two runs, not the first.
    expect(hrefOf(3, 'Open the run')).toBe(`/runs/${REFINEMENT_DONE}`);
  });
});

describe('the running stage’s transcript on the task page (WP-154 (c))', () => {
  it('grows as SSE frames for the run arrive, and leads to the full run', async () => {
    const { streams, openStream } = fakeStreams();
    const subscriptions: string[] = [];
    const app = createApp({
      fetchImpl: fetchFor(detail(RUNS), subscriptions),
      openStream,
      now: () => NOW,
    });
    render(app.element);
    const transcript = await screen.findByTestId('live-transcript');
    expect(transcript.textContent).toContain('Nothing yet.');
    expect(
      within(transcript).getByRole('link', { name: 'Open the full run' }).getAttribute('href'),
    ).toBe(`/runs/${LIVE}`);

    // The panel retained `run:<id>`: the open stream was asked to carry it, so it is the one to
    // speak into (the client adds a topic to a live connection rather than reopening it).
    const topic = `run:${LIVE}` as const;
    await waitFor(() => {
      expect(subscriptions.some((body) => body.includes(topic))).toBe(true);
    });
    expect(streams).toHaveLength(1);
    const stream = streams[0];
    act(() => {
      stream?.open();
      stream?.emit(
        { frame: 'transcript', topic, seq: 1, data: assistant(1, 'reading the ticket') },
        `${topic}:1`,
      );
    });
    await waitFor(() => {
      expect(transcript.textContent).toContain('reading the ticket');
    });
    act(() => {
      stream?.emit(
        { frame: 'transcript', topic, seq: 2, data: assistant(2, 'writing the test') },
        `${topic}:2`,
      );
    });
    await waitFor(() => {
      expect(transcript.textContent).toContain('writing the test');
    });
    expect(transcript.textContent).toContain('reading the ticket');
    expect(transcript.querySelectorAll('[data-block-kind]')).toHaveLength(2);
  });

  it('shows only the newest 30 blocks, and says so', async () => {
    expect(TASK_PAGE_TRANSCRIPT_BLOCKS).toBe(30);
    const app = createApp({ fetchImpl: fetchFor(detail(RUNS)), realtime: false, now: () => NOW });
    render(app.element);
    const transcript = await screen.findByTestId('live-transcript');
    const total = TASK_PAGE_TRANSCRIPT_BLOCKS + 5;
    act(() => {
      for (let seq = 1; seq <= total; seq += 1) {
        app.services.transcripts.apply(assistant(seq, `block number ${String(seq)}.`));
      }
    });
    await waitFor(() => {
      expect(transcript.textContent).toContain(`block number ${String(total)}.`);
    });
    expect(transcript.querySelectorAll('[data-block-kind]')).toHaveLength(
      TASK_PAGE_TRANSCRIPT_BLOCKS,
    );
    expect(transcript.textContent).toContain(
      `The last ${String(TASK_PAGE_TRANSCRIPT_BLOCKS)} of ${String(total)} blocks.`,
    );
    expect(transcript.textContent).not.toContain('block number 5.');
    expect(transcript.textContent).toContain('block number 6.');
  });

  it('shows no transcript when no stage run is live', async () => {
    const ended = RUNS.map((entry) =>
      entry.id === LIVE ? { ...entry, status: 'completed' as const } : entry,
    );
    render(
      createApp({ fetchImpl: fetchFor(detail(ended)), realtime: false, now: () => NOW }).element,
    );
    await screen.findByRole('list', { name: 'Timeline, newest first' });
    expect(screen.queryByTestId('live-transcript')).toBeNull();
  });
});

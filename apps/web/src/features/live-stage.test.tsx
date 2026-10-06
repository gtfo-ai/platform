/**
 * The task page's live stage (PROGRESS backlog 455 (1) and 496): which run is live, which progress
 * line is the latest, and what the page shows — driven through `createApp` with a fake server, as
 * `take-over.test.tsx` is, so the real router, query client and `taskDetailResponseSchema` parser
 * are in the path. A live frame is applied to the app's own transcript store, which is where the
 * realtime provider puts every `run:<id>` frame.
 */
import type { RunRecord, TaskDetailResponse, TranscriptEvent } from '@platform/contracts';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';
import { latestProgressOf, liveStageRun } from './live-stage.js';

const PROJECT = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-0000000000b1';
const RUN = '00000000-0000-4000-8000-0000000000c1';
const EARLIER = '00000000-0000-4000-8000-0000000000c2';
const NOW = Date.parse('2026-10-06T10:10:00.000Z');

const SESSION: SessionResponse = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'operator@example.invalid',
    name: 'Fake Operator',
    role: 'member',
  },
  session: { id: '00000000-0000-4000-8000-000000000002' },
};

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
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
  latest_progress: {
    seq: 12,
    at: '2026-10-06T10:08:00.000Z',
    summary: 'slice 1 of 3 pushed; next the repository',
    percent_complete: 30,
  },
  ...over,
});

const progressFrame = (seq: number, summary: string): TranscriptEvent => ({
  run_id: RUN,
  seq,
  created_at: '2026-10-06T10:09:30.000Z',
  redaction_count: 0,
  kind: 'progress',
  parent_tool_use_id: null,
  summary,
  percent_complete: null,
  truncated: false,
});

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
    created_at: '2026-10-06T09:00:00.000Z',
    updated_at: '2026-10-06T09:00:00.000Z',
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

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fetchFor = (task: TaskDetailResponse) =>
  (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.includes('/api/auth/get-session')) return json(SESSION);
    if (url.endsWith(`/api/tasks/${TASK}/asks`)) return json({ items: [] });
    if (url.endsWith(`/api/tasks/${TASK}/audit`)) return json({ items: [] });
    if (url.endsWith(`/api/tasks/${TASK}`)) return json(task);
    if (url.endsWith('/api/projects')) return json({ items: [] });
    return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
  }) as typeof fetch;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  window.history.pushState({}, '', `/tasks/${TASK}`);
});

describe('which run is live', () => {
  it('is the newest stage run that has not ended, never an ask run', () => {
    const ended = run({ id: EARLIER, status: 'completed' });
    expect(liveStageRun([ended])).toBeNull();
    expect(liveStageRun([ended, run()])?.id).toBe(RUN);
    expect(liveStageRun([run({ id: EARLIER, status: 'starting' }), run()])?.id).toBe(RUN);
    expect(liveStageRun([run({ stage: null, role: 'ask' })])).toBeNull();
  });
});

describe('the latest progress line', () => {
  it('is the newer of the record’s and the stream’s, by seq', () => {
    const recorded = run().latest_progress;
    expect(latestProgressOf(recorded, [])).toEqual(recorded);
    expect(latestProgressOf(recorded, [progressFrame(11, 'older')])).toEqual(recorded);
    expect(latestProgressOf(recorded, [progressFrame(13, 'newer')])).toMatchObject({
      seq: 13,
      summary: 'newer',
      percent_complete: null,
    });
    expect(latestProgressOf(null, [])).toBeNull();
  });
});

describe('the live stage on the task page (backlogs 455 and 496)', () => {
  it('shows the live stage, its elapsed time and the latest line, and follows the stream', async () => {
    const app = createApp({
      fetchImpl: fetchFor(detail([run()])),
      realtime: false,
      now: () => NOW,
    });
    render(app.element);
    const panel = await screen.findByTestId('live-stage');
    expect(panel.textContent).toContain('implementation · developer');
    expect(panel.textContent).toContain('for 10m 0s');
    expect(panel.textContent).toContain('30%');
    expect(screen.getByTestId('live-stage-progress').textContent).toBe(
      'slice 1 of 3 pushed; next the repository',
    );
    expect(screen.getByRole('link', { name: 'Watch the run' }).getAttribute('href')).toBe(
      `/runs/${RUN}`,
    );

    // A frame older than the record changes nothing; a newer one replaces the line.
    act(() => {
      app.services.transcripts.apply(progressFrame(11, 'an older line'));
    });
    expect(screen.getByTestId('live-stage-progress').textContent).toBe(
      'slice 1 of 3 pushed; next the repository',
    );
    act(() => {
      app.services.transcripts.apply(progressFrame(14, 'slice 2 of 3 pushed; next the endpoint'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('live-stage-progress').textContent).toBe(
        'slice 2 of 3 pushed; next the endpoint',
      );
    });
  });

  it('renders the model’s words as text, never as markup (BD-022)', async () => {
    const hostile = '<img src=x onerror=alert(1)> **bold** [link](javascript:alert(1))';
    const app = createApp({
      fetchImpl: fetchFor(
        detail([
          run({
            latest_progress: {
              seq: 1,
              at: '2026-10-06T10:09:00.000Z',
              summary: hostile,
              percent_complete: null,
            },
          }),
        ]),
      ),
      realtime: false,
      now: () => NOW,
    });
    render(app.element);
    const line = await screen.findByTestId('live-stage-progress');
    expect(line.textContent).toBe(hostile);
    expect(line.querySelector('img, a, strong')).toBeNull();
  });

  it('says no line has been reported yet, and shows nothing when no stage run is live', async () => {
    const quiet = createApp({
      fetchImpl: fetchFor(detail([run({ latest_progress: null })])),
      realtime: false,
      now: () => NOW,
    });
    const first = render(quiet.element);
    expect((await screen.findByTestId('live-stage')).textContent).toContain(
      'No progress reported yet.',
    );
    first.unmount();

    const ended = createApp({
      fetchImpl: fetchFor(detail([run({ status: 'completed' })])),
      realtime: false,
      now: () => NOW,
    });
    render(ended.element);
    await screen.findByText('ACME-1');
    expect(screen.queryByTestId('live-stage')).toBeNull();
  });
});

/**
 * A run nobody measured is **not measured** on screen, never `$0.00` (WP-119, pre-review round;
 * standing rule 16).
 *
 * `RunRecord.cost` is `null` since WP-119 when both of the run's cost columns are null — the lease
 * sweep, a cancel ended in place, a stop or a crash that read no `result`. Driven through
 * `createApp` with a fake server, as `run-settings.test.tsx` is, so the real endpoint parsers
 * (`runRecordSchema`, `taskDetailResponseSchema`) read the `null` before a screen renders it.
 */
import type { RunRecord, TaskDetailResponse } from '@platform/contracts';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';
import { formatRunCost, NOT_MEASURED } from '../ui/kit.js';

const PROJECT = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-0000000000b1';
const FIRST = '00000000-0000-4000-8000-0000000000c1';
const SECOND = '00000000-0000-4000-8000-0000000000c2';
const AT = '2026-09-30T09:00:00.000Z';
const HASH_A = 'a1'.repeat(32);

const SESSION: SessionResponse = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'operator@example.invalid',
    name: 'Fake Operator',
    role: 'member',
  },
  session: { id: '00000000-0000-4000-8000-000000000002' },
};

const run = (id: string, stage: string, settingsHash: string | null): RunRecord => ({
  id,
  task_id: TASK,
  project_id: PROJECT,
  stage,
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
  started_at: AT,
  ended_at: AT,
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
  cost: { usd: 0, is_estimate: false, price_list_id: null },
  wall_ms: 0,
  redaction_count: 0,
  settings_hash: settingsHash,
  start_failure: null,
  saved_work: null,
  latest_progress: null,
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const detail = (runs: RunRecord[], unmeasuredRuns = 0): TaskDetailResponse =>
  ({
    task: {
      id: TASK,
      project_id: PROJECT,
      ticket: { provider: 'jira', key: 'DEMO-1', url: 'https://jira.example.invalid/DEMO-1' },
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
      cost_actual_usd: 0.4,
      unmeasured_runs: unmeasuredRuns,
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
      created_at: AT,
      updated_at: AT,
      completed_at: null,
    },
    taken_over: null,
    can_raise_budget: false,
    can_export: false,
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
    runs,
  }) as TaskDetailResponse;

const fetchWith = (
  shown: RunRecord,
  runs: RunRecord[],
  settings: () => Response,
  asked: string[],
  unmeasuredRuns = 0,
) =>
  (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    const path = new URL(url, 'http://localhost').pathname;
    asked.push(path);
    if (url.includes('/api/auth/get-session')) return json(SESSION);
    if (path === `/api/runs/${shown.id}/messages`) return json({ items: [], next_seq: null });
    if (path === `/api/runs/${shown.id}/commands`) return json({ items: [] });
    if (path === `/api/runs/${shown.id}/settings`) return settings();
    if (path === `/api/runs/${shown.id}`) return json(shown);
    if (path === `/api/tasks/${TASK}`) return json(detail(runs, unmeasuredRuns));
    if (path === '/api/projects') return json({ items: [] });
    if (path.startsWith(`/api/tasks/${TASK}/`)) return json({ items: [], next_cursor: null });
    return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
  }) as typeof fetch;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const open = (
  shown: RunRecord,
  runs: RunRecord[],
  settings: () => Response,
  at = `/runs/${shown.id}`,
  unmeasuredRuns = 0,
) => {
  const asked: string[] = [];
  window.history.pushState({}, '', at);
  const view = render(
    createApp({
      fetchImpl: fetchWith(shown, runs, settings, asked, unmeasuredRuns),
      realtime: false,
    }).element,
  );
  return { view, asked };
};

const unmeasured = (id: string, stage: string): RunRecord => ({
  ...run(id, stage, HASH_A),
  status: 'stalled',
  terminal_reason: 'stalled',
  cost: null,
});

const noSettings = () => json({ error: { code: 'settings_not_recorded', message: 'none' } }, 409);

describe('formatRunCost', () => {
  it('prints a measured zero as a zero, an estimate with its label, and nothing measured in words', () => {
    expect(formatRunCost({ usd: 0, is_estimate: false })).toBe('$0.00');
    expect(formatRunCost({ usd: 0.4, is_estimate: true }, { estimate: true })).toBe('$0.40 est.');
    expect(formatRunCost({ usd: 0.4, is_estimate: true })).toBe('$0.40');
    expect(formatRunCost(null)).toBe(NOT_MEASURED);
    expect(formatRunCost(null, { estimate: true })).toBe(NOT_MEASURED);
  });
});

describe('a run nobody measured, on screen (WP-119)', () => {
  it('says not measured on the run screen, never $0.00', async () => {
    const shown = unmeasured(SECOND, 'implementation');
    const { view } = open(shown, [shown], noSettings);
    await waitFor(() => {
      expect(view.container.textContent).toContain(NOT_MEASURED);
    });
    expect(view.container.textContent).not.toContain('$0.00');
  });

  it('says not measured in the task page’s run list, beside a measured run’s figure', async () => {
    const measured = {
      ...run(FIRST, 'refinement', HASH_A),
      cost: { usd: 0.4, is_estimate: false, price_list_id: null },
    };
    const shown = unmeasured(SECOND, 'implementation');
    const { view } = open(shown, [measured, shown], noSettings, `/tasks/${TASK}`);
    await waitFor(() => {
      expect(view.container.textContent).toContain('$0.40');
    });
    expect(view.container.textContent).toContain(NOT_MEASURED);
    expect(view.container.textContent).not.toContain('$0.00 ·');
  });
});

/**
 * WP-131 (PROGRESS backlog 403): the task's **Cost so far** is the sum of its measured runs, so the
 * page says what it leaves out — read through the real `taskDetailResponseSchema`, with the count
 * the projection publishes. The other direction is asserted too (standing rule 42): a task whose
 * runs were all measured shows no such line.
 */
describe('what the task’s cost leaves out (WP-131)', () => {
  it('says the total excludes the runs nobody measured', async () => {
    const measured = {
      ...run(FIRST, 'refinement', HASH_A),
      cost: { usd: 0.4, is_estimate: false, price_list_id: null },
    };
    const shown = unmeasured(SECOND, 'implementation');
    const { view } = open(shown, [measured, shown], noSettings, `/tasks/${TASK}`, 1);
    await waitFor(() => {
      expect(view.container.textContent).toContain('Excludes 1 run nobody measured.');
    });
    expect(view.container.textContent).toContain('$0.40');
  });

  it('says nothing of the kind when every run was measured', async () => {
    const measured = {
      ...run(FIRST, 'refinement', HASH_A),
      cost: { usd: 0.4, is_estimate: false, price_list_id: null },
    };
    const { view } = open(measured, [measured], noSettings, `/tasks/${TASK}`, 0);
    await waitFor(() => {
      expect(view.container.textContent).toContain('$0.40');
    });
    expect(view.container.textContent).not.toContain('Excludes');
    expect(view.container.textContent).not.toContain('nobody measured');
  });
});

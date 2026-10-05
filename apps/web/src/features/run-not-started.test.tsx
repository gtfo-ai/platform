/**
 * A run that never started shows **why**, in place of an empty transcript (PROGRESS backlog 453).
 *
 * Driven through `createApp` with a fake server, as `run-cancel.test.tsx` is: the real router,
 * query client and endpoint parser (`runRecordSchema`), so a `start_failure` the client cannot
 * parse fails here rather than reading as an empty page. The launcher's words are untrusted
 * (BD-022) and are asserted to arrive as text — a tag in them stays a tag on screen, never an
 * element.
 */
import type { RunRecord, RunStartFailure } from '@platform/contracts';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';

const PROJECT = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-0000000000b1';
const RUN = '00000000-0000-4000-8000-0000000000c1';

const SESSION: SessionResponse = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'operator@example.invalid',
    name: 'Fake Operator',
    role: 'member',
  },
  session: { id: '00000000-0000-4000-8000-000000000002' },
};

const FAILURE: RunStartFailure = {
  kind: 'not_started',
  diagnosis: 'RunStartError: workspace_failed',
  detail:
    "helper prep-run exited 1\nmkdir: can't create directory '/ctl/run': Permission denied <img src=x onerror=alert(1)>",
  truncated: false,
  attempt: 3,
  retryable: false,
};

const runWith = (startFailure: RunStartFailure | null): RunRecord => ({
  id: RUN,
  task_id: TASK,
  project_id: PROJECT,
  stage: 'discovery',
  role: 'discovery',
  mode: 'normal',
  attempt: 1,
  session_id: null,
  model: 'claude-test',
  effort: 'high',
  provider_mode: 'local',
  prompt_version: 'test@1',
  status: 'failed',
  terminal_reason: 'error_during_execution',
  started_at: '2026-10-05T09:00:00.000Z',
  ended_at: '2026-10-05T09:02:00.000Z',
  last_output_at: null,
  num_turns: 0,
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    cache_write_5m_tokens: 0,
    cache_write_1h_tokens: 0,
    cache_read_tokens: 0,
  },
  model_usage: [],
  cost: { usd: 0, is_estimate: false, price_list_id: null },
  wall_ms: 0,
  redaction_count: 0,
  settings_hash: null,
  start_failure: startFailure,
  saved_work: null,
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fetchWith = (run: RunRecord) =>
  (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.includes('/api/auth/get-session')) return json(SESSION);
    if (url.includes(`/api/runs/${RUN}/messages`)) return json({ items: [], next_seq: null });
    if (url.endsWith(`/api/runs/${RUN}/commands`)) return json({ items: [] });
    if (url.endsWith(`/api/runs/${RUN}`)) return json(run);
    if (url.endsWith('/api/projects')) return json({ items: [] });
    return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
  }) as typeof fetch;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  window.history.pushState({}, '', `/runs/${RUN}`);
});

describe('the run page of a run that never started (backlog 453)', () => {
  it('shows the diagnosis and the launcher’s words instead of the transcript', async () => {
    const view = render(
      createApp({ fetchImpl: fetchWith(runWith(FAILURE)), realtime: false }).element,
    );
    const panel = await screen.findByRole('region', { name: 'This run did not start' });
    expect(panel.textContent).toContain('RunStartError: workspace_failed');
    expect(panel.textContent).toContain(
      "mkdir: can't create directory '/ctl/run': Permission denied",
    );
    expect(panel.textContent).toContain('Attempt 3');
    expect(panel.textContent).toContain('the task was handed to a person');
    // The untrusted half arrives as text: the markup in it is on screen, not in the DOM.
    expect(panel.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(view.container.querySelector('img')).toBeNull();
    // No transcript and no steer box for a session that does not exist.
    expect(screen.queryByRole('textbox', { name: 'Steer the agent' })).toBeNull();
  });

  it('says the launcher gave no words when there were none, and announces a cut it made', async () => {
    render(
      createApp({
        fetchImpl: fetchWith(runWith({ ...FAILURE, detail: null, retryable: true, attempt: 1 })),
        realtime: false,
      }).element,
    );
    const panel = await screen.findByRole('region', { name: 'This run did not start' });
    expect(panel.textContent).toContain('The launcher gave no reason of its own');
    expect(panel.textContent).toContain('the stage was queued to try again');
    cleanup();

    render(
      createApp({
        fetchImpl: fetchWith(runWith({ ...FAILURE, truncated: true })),
        realtime: false,
      }).element,
    );
    const cut = await screen.findByRole('region', { name: 'This run did not start' });
    expect(cut.textContent).toContain('shortened by the platform');
  });

  it('shows the transcript and the steer box for a run that started', async () => {
    render(createApp({ fetchImpl: fetchWith(runWith(null)), realtime: false }).element);
    expect(await screen.findByRole('textbox', { name: 'Steer the agent' })).not.toBeNull();
    expect(screen.queryByRole('region', { name: 'This run did not start' })).toBeNull();
  });
});

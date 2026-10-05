/**
 * The run page says what the platform did with an unsuccessful run's unfinished work (PROGRESS
 * backlog 467) — driven through `createApp` with a fake server, as `run-not-started.test.tsx` is, so
 * a `saved_work` the client's `runRecordSchema` cannot parse fails here rather than vanishing.
 *
 * Three cases, one per answer the record can give: pushed, attempted and not pushed, and nothing.
 * The branch is derived from a ticket key, so it is asserted to arrive as text.
 */
import type { RunRecord, RunSavedWork } from '@platform/contracts';
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

const PUSHED: RunSavedWork = {
  branch: 'agentic/AUT-6820',
  commit_sha: '0123456789abcdef0123456789abcdef01234567',
  pushed: true,
};

const runWith = (saved: RunSavedWork | null): RunRecord => ({
  id: RUN,
  task_id: TASK,
  project_id: PROJECT,
  stage: 'implementation',
  role: 'developer',
  mode: 'normal',
  attempt: 1,
  session_id: 'fake-session',
  model: 'claude-test',
  effort: 'high',
  provider_mode: 'local',
  prompt_version: 'test@1',
  status: 'failed',
  terminal_reason: 'error_max_turns',
  started_at: '2026-10-05T09:00:00.000Z',
  ended_at: '2026-10-05T09:26:00.000Z',
  last_output_at: null,
  num_turns: 201,
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    cache_write_5m_tokens: 0,
    cache_write_1h_tokens: 0,
    cache_read_tokens: 0,
  },
  model_usage: [],
  cost: { usd: 1, is_estimate: true, price_list_id: null },
  wall_ms: 1_560_000,
  redaction_count: 0,
  settings_hash: null,
  start_failure: null,
  saved_work: saved,
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

describe('the run page of a run whose unfinished work was saved (backlog 467)', () => {
  it('names the branch and the commit, and says a retry continues from it', async () => {
    render(createApp({ fetchImpl: fetchWith(runWith(PUSHED)), realtime: false }).element);
    const line = await screen.findByLabelText('Unfinished work');
    expect(line.textContent).toBe(
      'Unfinished work saved: pushed to agentic/AUT-6820 at 0123456789ab. A retry of this stage continues from that branch.',
    );
  });

  it('says the push did not succeed and where the work still is', async () => {
    render(
      createApp({
        fetchImpl: fetchWith(runWith({ ...PUSHED, commit_sha: null, pushed: false })),
        realtime: false,
      }).element,
    );
    const line = await screen.findByLabelText('Unfinished work');
    expect(line.textContent).toContain('Unfinished work not saved: the push to agentic/AUT-6820');
    expect(line.textContent).toContain('only in this run’s workspace volume');
    expect(line.textContent).not.toContain('continues from');
  });

  it('says nothing for a run whose work was not saved', async () => {
    render(createApp({ fetchImpl: fetchWith(runWith(null)), realtime: false }).element);
    expect(await screen.findByRole('textbox', { name: 'Steer the agent' })).not.toBeNull();
    expect(screen.queryByLabelText('Unfinished work')).toBeNull();
  });
});

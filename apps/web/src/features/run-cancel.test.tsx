/**
 * The run screen's **Cancel run** says which of TD-028 decision 11's branches happened (WP-101,
 * review round 1): accepted for the process holding the session (`202`, a `command_id`), ended here
 * because no process held it (`200`, `command_id: null`), or refused.
 *
 * Driven through `createApp` with a fake server, as `take-over.test.tsx` is: the real router, query
 * client and endpoint parser (`cancelRunResponseSchema`), so a body the client cannot parse fails
 * here rather than reading as success.
 */
import type { RunReadResponse, RunRecord } from '@platform/contracts';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';

/** `GET /api/runs/:id` answers the record plus `retry_defaults` (WP-167); a run on its configuration. */
const asRead = (record: RunRecord): RunReadResponse => ({
  ...record,
  retry_defaults: { model: record.model, effort: record.effort },
});

const PROJECT = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-0000000000b1';
const RUN = '00000000-0000-4000-8000-0000000000c1';
const COMMAND = '00000000-0000-4000-8000-0000000000d1';

const SESSION: SessionResponse = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'operator@example.invalid',
    name: 'Fake Operator',
    role: 'member',
  },
  session: { id: '00000000-0000-4000-8000-000000000002' },
};

const RUNNING: RunRecord = {
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
  started_at: '2026-09-30T09:00:00.000Z',
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
  cost: { usd: 0, is_estimate: false, price_list_id: null },
  wall_ms: 0,
  redaction_count: 0,
  settings_hash: null,
  start_failure: null,
  saved_work: null,
  stop_reason: null,
  latest_progress: null,
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fetchWith = (cancel: () => Response, posted: string[], record: RunRecord = RUNNING) =>
  (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes('/api/auth/get-session')) return json(SESSION);
    if (init?.method === 'POST') {
      const path = new URL(url, 'http://localhost').pathname;
      posted.push(path);
      if (path === `/api/runs/${RUN}/cancel`) return cancel();
    }
    if (url.includes(`/api/runs/${RUN}/messages`)) return json({ items: [], next_seq: null });
    if (url.endsWith(`/api/runs/${RUN}/commands`)) return json({ items: [] });
    if (url.endsWith(`/api/runs/${RUN}`)) return json(asRead(record));
    if (url.endsWith('/api/projects')) return json({ items: [] });
    return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
  }) as typeof fetch;

const answer = (commandId: string | null, status: number) => () =>
  json(
    {
      run_id: RUN,
      task_id: TASK,
      status: commandId === null ? 'cancelled' : 'running',
      task_state: 'paused',
      performed: true,
      command_id: commandId,
    },
    status,
  );

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  window.history.pushState({}, '', `/runs/${RUN}`);
});

/**
 * S-23.10: *Cancel run* is the header's outline-danger button and it asks first — the dialog's own
 * *Cancel run* is what sends the command.
 */
const confirmCancel = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole('button', { name: 'Cancel run' }));
  const dialog = await screen.findByRole('dialog', { name: 'Cancel this run?' });
  await user.click(within(dialog).getByRole('button', { name: 'Cancel run' }));
};

const cancelThrough = async (cancel: () => Response) => {
  const posted: string[] = [];
  const user = userEvent.setup();
  const view = render(createApp({ fetchImpl: fetchWith(cancel, posted), realtime: false }).element);
  await confirmCancel(user);
  await waitFor(() => {
    expect(posted).toContain(`/api/runs/${RUN}/cancel`);
  });
  return view;
};

describe('Cancel run asks before it cancels (S-23.10)', () => {
  it('says what cancelling does, and sends nothing when the run is kept', async () => {
    const posted: string[] = [];
    const user = userEvent.setup();
    render(createApp({ fetchImpl: fetchWith(answer(null, 200), posted), realtime: false }).element);
    await user.click(await screen.findByRole('button', { name: 'Cancel run' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel this run?' });
    expect(dialog.textContent).toContain('Unfinished work is not saved');
    await user.click(within(dialog).getByRole('button', { name: 'Keep it running' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(posted).toEqual([]);
  });

  it('offers no Cancel run once the run has ended', async () => {
    const ended: RunRecord = {
      ...RUNNING,
      status: 'completed',
      terminal_reason: 'success',
      ended_at: '2026-09-30T09:05:00.000Z',
    };
    render(
      createApp({ fetchImpl: fetchWith(answer(null, 200), [], ended), realtime: false }).element,
    );
    await screen.findByRole('tab', { name: 'Transcript' });
    expect(screen.queryByRole('button', { name: 'Cancel run' })).toBeNull();
  });
});

describe('the run screen’s cancel says which branch happened (WP-101)', () => {
  it('says the stop was accepted for the process running the agent when a command was recorded (202)', async () => {
    const { container } = await cancelThrough(answer(COMMAND, 202));
    await waitFor(() => {
      expect(container.textContent).toContain('Cancel accepted');
    });
    expect(container.textContent).toContain('the process running the agent stops the session');
    expect(container.textContent).not.toContain('the run was ended here');
    expect(container.textContent).not.toContain('That cancel was refused.');
  });

  it('says the run was ended here when no process held it (200, no command)', async () => {
    const { container } = await cancelThrough(answer(null, 200));
    await waitFor(() => {
      expect(container.textContent).toContain(
        'No process was running this session, so the run was ended here.',
      );
    });
    expect(container.textContent).not.toContain('Cancel accepted');
  });

  it('says the cancel was refused when the server refused it', async () => {
    const { container } = await cancelThrough(() =>
      json(
        {
          error: {
            code: 'illegal_transition',
            message: 'run is "completed", so it cannot be cancelled',
          },
        },
        409,
      ),
    );
    await waitFor(() => {
      expect(container.textContent).toContain('That cancel was refused.');
    });
    expect(container.textContent).not.toContain('Cancel accepted');
    expect(container.textContent).not.toContain('the run was ended here');
  });
});

/**
 * WP-275b: a run is `starting` from its claim to its CLI spawn marker — live, with no `started_at`
 * and no `run.started` yet. The run screen shows the status, an elapsed time of `—` rather than a
 * time it does not have, and still offers **Cancel run**, which the server admits from `starting`.
 */
describe('the run screen of a starting run (WP-275b)', () => {
  it('shows starting with no elapsed time, and lets a person cancel it', async () => {
    const posted: string[] = [];
    const user = userEvent.setup();
    const starting: RunRecord = { ...RUNNING, status: 'starting', started_at: null, num_turns: 0 };
    const { container } = render(
      createApp({
        fetchImpl: fetchWith(answer(null, 200), posted, starting),
        realtime: false,
      }).element,
    );
    const cancel = await screen.findByRole('button', { name: 'Cancel run' });
    expect(container.textContent).toContain('Starting');
    expect(cancel).not.toHaveProperty('disabled', true);
    await confirmCancel(user);
    await waitFor(() => {
      expect(posted).toContain(`/api/runs/${RUN}/cancel`);
    });
  });
});

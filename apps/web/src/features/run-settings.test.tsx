/**
 * The run screen's settings line and Settings tab (WP-112, PROGRESS backlog 309).
 *
 * The comparison is asserted as a function over every branch it has (standing rule 68: enumerate
 * what you branch on), and then through `createApp` with a fake server, as `run-cancel.test.tsx`
 * is — the real router, query client and endpoint parsers (`runRecordSchema`,
 * `taskDetailResponseSchema`, `runSettingsResponseSchema`), so a body the client cannot parse fails
 * here rather than rendering as a finding.
 */
import type { RunRecord, TaskDetailResponse } from '@platform/contracts';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';
import { settingsChangeOf, settingsChangeText } from './run-settings.js';

const PROJECT = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-0000000000b1';
const FIRST = '00000000-0000-4000-8000-0000000000c1';
const SECOND = '00000000-0000-4000-8000-0000000000c2';
const AT = '2026-09-30T09:00:00.000Z';
const HASH_A = 'a1'.repeat(32);
const HASH_B = 'b2'.repeat(32);

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

describe('settingsChangeOf', () => {
  const first = run(FIRST, 'refinement', HASH_A);

  it('answers every branch, each from the hashes alone', () => {
    expect(settingsChangeOf(run(SECOND, 'implementation', null), [first]).kind).toBe(
      'not_recorded',
    );
    expect(settingsChangeOf(first, [first]).kind).toBe('first');
    expect(settingsChangeOf(first, []).kind).toBe('not_in_task');
    const same = run(SECOND, 'implementation', HASH_A);
    expect(settingsChangeOf(same, [first, same]).kind).toBe('same');
    const changed = run(SECOND, 'implementation', HASH_B);
    expect(settingsChangeOf(changed, [first, changed]).kind).toBe('changed');
    const old = run(FIRST, 'refinement', null);
    expect(settingsChangeOf(changed, [old, changed]).kind).toBe('previous_not_recorded');
  });

  it('compares with the run immediately before, not with the first', () => {
    const middle = run('00000000-0000-4000-8000-0000000000c3', 'planning', HASH_B);
    const last = run(SECOND, 'implementation', HASH_B);
    const change = settingsChangeOf(last, [run(FIRST, 'refinement', HASH_A), middle, last]);
    expect(change).toEqual({ kind: 'same', previous: middle });
  });

  it('never calls an unanswerable comparison a change', () => {
    const changed = run(SECOND, 'implementation', HASH_B);
    const text = settingsChangeText(
      settingsChangeOf(changed, [run(FIRST, 'refinement', null), changed]),
    );
    expect(text).toContain('cannot be said');
    expect(text).not.toContain('Changed');
  });
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const detail = (runs: RunRecord[]): TaskDetailResponse =>
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
  prompt: () => Response = () => json({ error: { code: 'not_found', message: 'none' } }, 404),
) =>
  (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    const path = new URL(url, 'http://localhost').pathname;
    asked.push(path);
    if (url.includes('/api/auth/get-session')) return json(SESSION);
    if (path === `/api/runs/${shown.id}/messages`) return json({ items: [], next_seq: null });
    if (path === `/api/runs/${shown.id}/commands`) return json({ items: [] });
    if (path === `/api/runs/${shown.id}/settings`) return settings();
    if (path === `/api/runs/${shown.id}/prompt`) return prompt();
    if (path === `/api/runs/${shown.id}`) return json(shown);
    if (path === `/api/tasks/${TASK}`) return json(detail(runs));
    if (path === '/api/projects') return json({ items: [] });
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
  prompt?: () => Response,
) => {
  const asked: string[] = [];
  window.history.pushState({}, '', `/runs/${shown.id}`);
  const view = render(
    createApp({ fetchImpl: fetchWith(shown, runs, settings, asked, prompt), realtime: false })
      .element,
  );
  return { view, asked };
};

const SNAPSHOT = {
  format: 1,
  effective: { version: 1, checklists: { review: ['<b>no secrets in logs</b>'] } },
  templates: ['feature'],
};

describe('the run screen shows the settings hash and marks a change (WP-112)', () => {
  it('shows the hash and marks a run whose settings changed since the task’s previous run', async () => {
    const shown = run(SECOND, 'implementation', HASH_B);
    const { view, asked } = open(shown, [run(FIRST, 'refinement', HASH_A), shown], () =>
      json({ settings_hash: HASH_B, snapshot: SNAPSHOT }),
    );
    await waitFor(() => {
      expect(view.container.textContent).toContain(
        'Changed since the previous run, refinement (attempt 1).',
      );
    });
    expect(view.container.textContent).toContain(HASH_B.slice(0, 12));
    expect(view.container.querySelector('[data-run-settings="line"]')?.textContent).toContain(
      'changed',
    );
    // The document is `transcript.read`: it is not fetched until the tab is opened.
    expect(asked).not.toContain(`/api/runs/${SECOND}/settings`);
  });

  it('says the same settings, and does not mark a change, when the hash did not move', async () => {
    const shown = run(SECOND, 'implementation', HASH_A);
    const { view } = open(shown, [run(FIRST, 'refinement', HASH_A), shown], () =>
      json({ settings_hash: HASH_A, snapshot: SNAPSHOT }),
    );
    await waitFor(() => {
      expect(view.container.textContent).toContain(
        'Same settings as the previous run, refinement (attempt 1).',
      );
    });
    expect(view.container.textContent).not.toContain('Changed since');
  });

  it('opens the snapshot as text in the Settings tab', async () => {
    const shown = run(SECOND, 'implementation', HASH_B);
    const { view, asked } = open(shown, [shown], () =>
      json({ settings_hash: HASH_B, snapshot: SNAPSHOT }),
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Settings' }));
    await waitFor(() => {
      expect(view.container.textContent).toContain(`sha256 ${HASH_B}`);
    });
    expect(asked).toContain(`/api/runs/${SECOND}/settings`);
    // Operator-typed text is a text node, never markup.
    expect(view.container.textContent).toContain('<b>no secrets in logs</b>');
    expect(view.container.querySelector('b')).toBeNull();
  });

  it('says a run created before WP-91 has no snapshot, in words, when the server refuses', async () => {
    const shown = run(SECOND, 'implementation', null);
    const { view } = open(shown, [shown], () =>
      json(
        {
          error: {
            code: 'settings_not_recorded',
            message: 'created before WP-91',
          },
        },
        409,
      ),
    );
    await waitFor(() => {
      expect(view.container.textContent).toContain('Not recorded: this run was created before');
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Settings' }));
    await waitFor(() => {
      expect(view.container.textContent).toContain('there is no snapshot to show');
    });
    expect(view.container.textContent).not.toContain('The settings could not be loaded.');
  });
});

/**
 * WP-121 (PROGRESS backlog 363): a run whose project prompt files were withheld says why on its
 * Prompt tab — the record frozen on the run (`runs.prompts_withheld`), served by `/prompt`.
 */
describe('the Prompt tab says why the project prompt files are missing (WP-121)', () => {
  const promptBody = (withheld: unknown) =>
    json({
      prompt_version: 'test@1',
      system_prompt: 'the role prompt',
      user_prompt: 'the task block',
      prompts_withheld: withheld,
    });

  it('names the reason and each unreadable integration, as text', async () => {
    const shown = run(SECOND, 'refinement', HASH_A);
    const { view } = open(
      shown,
      [shown],
      () => json({ settings_hash: HASH_A, snapshot: SNAPSHOT }),
      () =>
        promptBody({
          reason: 'the credentials of the <b>Sentry</b> integration cannot be decrypted',
          integrations: [
            { integration: 'integration "acme sentry" (sentry, 0f)', reason: 'old key' },
          ],
        }),
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Prompt' }));
    await waitFor(() => {
      expect(view.container.textContent).toContain(
        'The project’s prompt files were withheld from this prompt.',
      );
    });
    expect(view.container.textContent).toContain('<b>Sentry</b> integration cannot be decrypted');
    expect(view.container.textContent).toContain('integration "acme sentry" (sentry, 0f): old key');
    expect(view.container.querySelector('b')).toBeNull();
  });

  it('says nothing of the kind when nothing was withheld', async () => {
    const shown = run(SECOND, 'refinement', HASH_A);
    const { view } = open(
      shown,
      [shown],
      () => json({ settings_hash: HASH_A, snapshot: SNAPSHOT }),
      () => promptBody(null),
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Prompt' }));
    await waitFor(() => {
      expect(view.container.textContent).toContain('the task block');
    });
    expect(view.container.textContent).not.toContain('were withheld');
  });
});

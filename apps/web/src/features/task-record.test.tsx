/**
 * The task page's record (WP-122): product/09's *"Export as JSON per task"* as a link (PROGRESS
 * backlog 381), and the *Who did what* read that named every failure a missing role (backlog 385).
 *
 * Driven through `createApp` with a fake server, so the real endpoint parser reads `can_export` and
 * the real `DownloadLink` decides whether the path may become an `href`.
 */
import type { TaskDetailResponse } from '@platform/contracts';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';

const PROJECT = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-0000000000b1';
const AT = '2026-09-30T09:00:00.000Z';

const SESSION: SessionResponse = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'operator@example.invalid',
    name: 'Fake Operator',
    role: 'viewer',
  },
  session: { id: '00000000-0000-4000-8000-000000000002' },
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const detail = (
  canExport: boolean,
  task: Partial<TaskDetailResponse['task']> = {},
): TaskDetailResponse =>
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
      ticket_claim: null,
      qa_stage: false,
      ...task,
    },
    taken_over: null,
    can_raise_budget: false,
    can_export: canExport,
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
    runs: [],
  }) as TaskDetailResponse;

const open = (options: {
  readonly canExport: boolean;
  readonly audit?: { readonly status: number; readonly message: string };
  readonly task?: Partial<TaskDetailResponse['task']>;
}) => {
  const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    const path = new URL(url, 'http://localhost').pathname;
    if (url.includes('/api/auth/get-session')) return json(SESSION);
    if (path === `/api/tasks/${TASK}`) return json(detail(options.canExport, options.task));
    if (path === `/api/tasks/${TASK}/audit` && options.audit !== undefined) {
      return json(
        {
          error: {
            code: options.audit.status === 403 ? 'forbidden' : 'unavailable',
            message: options.audit.message,
          },
        },
        options.audit.status,
      );
    }
    if (path === '/api/projects') return json({ items: [] });
    if (path.startsWith(`/api/tasks/${TASK}/`)) return json({ items: [], next_cursor: null });
    return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
  }) as typeof fetch;
  window.history.pushState({}, '', `/tasks/${TASK}`);
  return render(createApp({ fetchImpl, realtime: false }).element);
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('the task record’s download (WP-122, backlog 381)', () => {
  it('offers Download JSON to a member, as a download of the export path', async () => {
    const view = open({ canExport: true });
    const link = (await view.findByText('Download JSON')).closest('a');
    expect(link?.getAttribute('href')).toBe(`/api/tasks/${TASK}/export`);
    expect(link?.hasAttribute('download')).toBe(true);
  });

  it('offers nothing to a viewer, whom the export route would refuse', async () => {
    const view = open({ canExport: false });
    await view.findByText('DEMO-1');
    expect(view.queryByText('Download JSON')).toBeNull();
    expect(view.container.querySelector(`a[href="/api/tasks/${TASK}/export"]`)).toBeNull();
  });
});

describe('Who did what, when its read fails (WP-122, backlog 385)', () => {
  it('does not name a 503 a permission problem', async () => {
    open({ canExport: false, audit: { status: 503, message: 'the audit store is not reachable' } });
    expect(
      await screen.findByText("This task's activity could not be loaded.", {}, { timeout: 5_000 }),
    ).toBeTruthy();
    expect(document.body.textContent).toContain('the audit store is not reachable');
    expect(document.body.textContent).not.toContain('needs the maintainer role');
    expect(screen.queryByText('Not shown')).toBeNull();
  });

  it('keeps the Not shown notice and the role sentence for a 403', async () => {
    open({ canExport: false, audit: { status: 403, message: 'role member may not read' } });
    expect(await screen.findByText('Not shown', {}, { timeout: 5_000 })).toBeTruthy();
    expect(document.body.textContent).toContain('reading the record needs the maintainer role');
  });
});

describe('the claim and the QA stage in the task header (WP-182 ruling (c))', () => {
  it('shows the claim the DTO publishes, and the QA stage', async () => {
    const view = open({
      canExport: false,
      task: {
        ticket_claim: { status: 'shadow', claimed_at: AT, released_at: null },
        qa_stage: true,
      },
    });
    expect(await view.findByText('claim (shadow)')).toBeTruthy();
    expect(view.getByText('QA stage')).toBeTruthy();
  });

  it('shows neither for a task that never claimed and has no QA stage', async () => {
    const view = open({ canExport: false });
    await view.findByText('DEMO-1');
    expect(view.container.querySelector('[data-ticket-claim]')).toBeNull();
    expect(view.queryByText('QA stage')).toBeNull();
  });
});

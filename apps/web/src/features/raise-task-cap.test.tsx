/**
 * **Raise this task's cap** on the task page (WP-131 review round 1) — the one way out of a task its
 * budget paused, offered only there. Driven through `createApp` with a fake server, so the real
 * endpoint parsers read the record and the real client sends the two commands: the raise, with an
 * `Idempotency-Key`, and then the existing resume.
 */
import type { TaskDetailResponse } from '@platform/contracts';
import { cleanup, render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
    role: 'member',
  },
  session: { id: '00000000-0000-4000-8000-000000000002' },
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Shape {
  readonly pausedReason: 'budget' | 'manual' | null;
  readonly scope?: 'task' | 'project' | null;
  readonly canRaise?: boolean;
}

const detail = (runs: never[], shape: Shape): TaskDetailResponse =>
  ({
    task: {
      id: TASK,
      project_id: PROJECT,
      ticket: { provider: 'jira', key: 'DEMO-1', url: 'https://jira.example.invalid/DEMO-1' },
      ticket_title: null,
      template: 'feature',
      mode: 'normal',
      state: shape.pausedReason === null ? 'active' : 'paused',
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
      unmeasured_runs: 1,
      budget_cap_usd: 50,
      paused_reason: shape.pausedReason,
      paused_budget_scope: shape.scope ?? null,
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
    },
    taken_over: null,
    can_raise_budget: shape.canRaise ?? true,
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
    runs,
  }) as TaskDetailResponse;

interface Sent {
  readonly path: string;
  readonly body: unknown;
  readonly key: string | null;
}

const open = (shape: Shape) => {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const path = new URL(url, 'http://localhost').pathname;
    if (url.includes('/api/auth/get-session')) return json(SESSION);
    if (init?.method === 'POST') {
      const headers = new Headers(init.headers);
      sent.push({
        path,
        body: JSON.parse(String(init.body ?? '{}')),
        key: headers.get('idempotency-key'),
      });
      return json({ task_id: TASK, state: 'active', current_stage: 'refinement', performed: true });
    }
    if (path === `/api/tasks/${TASK}`) return json(detail([], shape));
    if (path === '/api/projects') return json({ items: [] });
    if (path.startsWith(`/api/tasks/${TASK}/`)) return json({ items: [], next_cursor: null });
    return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
  }) as typeof fetch;
  window.history.pushState({}, '', `/tasks/${TASK}`);
  const view = render(createApp({ fetchImpl, realtime: false }).element);
  return { view, sent };
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

/** Every case where the control must not appear (WP-131 review round 2). */
const NOT_OFFERED: readonly { readonly label: string; readonly shape: Shape }[] = [
  {
    label: 'a pause the project’s cap caused',
    shape: { pausedReason: 'budget', scope: 'project' },
  },
  {
    label: 'a member, who may not raise a cap',
    shape: { pausedReason: 'budget', scope: 'task', canRaise: false },
  },
  { label: 'a budget pause that names no cap', shape: { pausedReason: 'budget', scope: null } },
  { label: 'a pause a person made', shape: { pausedReason: 'manual' } },
  { label: 'a running task', shape: { pausedReason: null } },
];

describe('raising a task’s cap (WP-131)', () => {
  it('offers the raise on a task its budget paused, and sends the raise then the resume', async () => {
    const user = userEvent.setup();
    const { view, sent } = open({ pausedReason: 'budget', scope: 'task' });
    await waitFor(() => {
      expect(view.getByText("Raise this task's cap")).toBeTruthy();
    });
    const button = view.getByText("Raise this task's cap").closest('button') as HTMLButtonElement;
    // Nothing above the cap entered yet: the button cannot send a figure the server would refuse.
    expect(button.disabled).toBe(true);
    await user.type(view.getByLabelText('New cap (USD)'), '80');
    expect(button.disabled).toBe(false);
    await user.click(button);
    await waitFor(() => {
      expect(sent.map((entry) => entry.path)).toEqual([
        `/api/tasks/${TASK}/budget`,
        `/api/tasks/${TASK}/resume`,
      ]);
    });
    expect(sent[0]?.body).toEqual({ cap_usd: 80 });
    expect(sent[0]?.key).not.toBeNull();
  });

  /**
   * Every case where the control must **not** appear (WP-131 review round 2): a pause another cap
   * caused — the project's here, raised where it is set — a caller without `budget.write` (a member,
   * `can_raise_budget: false`), a pause a person made, and a running task.
   */
  it.each(NOT_OFFERED)('does not offer it for $label', async ({ shape }) => {
    const { view } = open(shape);
    await waitFor(() => {
      expect(view.container.textContent).toContain('Cost so far');
    });
    expect(view.queryByText("Raise this task's cap")).toBeNull();
  });
});

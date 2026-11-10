/**
 * **Raise this task's cap** on the task page (WP-131 review round 1) — the one way out of a task its
 * budget paused, offered only there. Driven through `createApp` with a fake server, so the real
 * endpoint parsers read the record and the real client sends the two commands: the raise, with an
 * `Idempotency-Key`, and then the existing resume.
 */
import type { PausedBudgetFigures, TaskDetailResponse } from '@platform/contracts';
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
  /** The pause's arithmetic (S-28.1); none for a pause recorded before it. */
  readonly figures?: PausedBudgetFigures | null;
  /** The raise's answer: accepted, or refused as too low (S-28.1, M28 ruling 2). */
  readonly raise?: 'accepted' | 'insufficient';
}

/** AUT-6655's figures: $10.99 spent of a $50 cap, the next Implementation run reserving $40. */
const AUT_6655: PausedBudgetFigures = {
  stage: 'implementation',
  spent_usd: 10.99,
  held_usd: 0,
  held_runs: 0,
  reserve_usd: 40,
  cap_usd: 50,
  required_cap_usd: 50.99,
};

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
      paused_budget_figures: shape.figures ?? null,
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
      tracker_assignee: null,
      owner: null,
      owner_source: null,
      unlinked_assignee: null,
      owner_writes_back: false,
      waiting: null,
    },
    taken_over: null,
    can_raise_budget: shape.canRaise ?? true,
    can_export: false,
    can_pause: true,
    can_resume: true,
    can_cancel: true,
    can_return: true,
    can_rework: true,
    can_decide_approval: true,
    can_change_limits: false,
    can_retry_run: true,
    can_take_over: true,
    can_take: false,
    can_assign: false,
    can_unassign: false,
    take_writes_back: false,
    gate_feedback: null,
    returns: [],
    stop: null,
    gate_wait: null,
    last_gate_wait: null,
    escalation: null,
    loop_limits: null,
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
      if (shape.raise === 'insufficient' && path === `/api/tasks/${TASK}/budget`) {
        // The server's refusal of a raise the next run would still not fit under (S-28.1).
        return json(
          {
            error: {
              code: 'budget_raise_insufficient',
              message: 'a cap of 50.5 USD cannot let this task continue',
              details: [
                { path: 'required_cap_usd', message: '50.99' },
                { path: 'requested_cap_usd', message: '50.5' },
                { path: 'stage', message: 'implementation' },
                { path: 'spent_usd', message: '10.99' },
                { path: 'held_usd', message: '0' },
                { path: 'held_runs', message: '0' },
                { path: 'reserve_usd', message: '40' },
                { path: 'cap_usd', message: '50' },
              ],
            },
          },
          409,
        );
      }
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
    // S-23.9b: the raise is the header's one primary action here, and the callout says why it
    // waits; it opens a dialog with the same field.
    expect(
      (await view.findByRole('region', { name: 'Needs you' })).querySelector('[data-budget-reason]')
        ?.textContent,
    ).toBe(
      'Its next run did not fit under its cap of $50.00: what it has spent plus what that run may spend is above it. Raise the cap and it continues at the stage it stopped at; finished stages are not redone.',
    );
    await user.click(await view.findByRole('button', { name: 'Raise the cap…' }));
    await waitFor(() => {
      expect(view.getByText("Raise this task's cap", { selector: 'button' })).toBeTruthy();
    });
    const button = view.getByText("Raise this task's cap", {
      selector: 'button',
    }) as HTMLButtonElement;
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
    const user = userEvent.setup();
    const { view } = open(shape);
    await waitFor(() => {
      expect(view.container.textContent).toContain('Cost so far');
    });
    // Neither the header nor its menu — open, every case here can be cancelled — carries a raise.
    expect(view.queryByRole('button', { name: 'Raise the cap…' })).toBeNull();
    await user.click(await view.findByRole('button', { name: 'Task actions' }));
    expect(await view.findByRole('menuitem', { name: 'Cancel task…' })).toBeTruthy();
    expect(view.queryByRole('menuitem', { name: 'Raise the cap…' })).toBeNull();
    expect(view.queryByText("Raise this task's cap")).toBeNull();
  });
});

/**
 * **The pause in numbers, and a raise that cannot help refused** (S-28.1, M28 rulings 2, 3 and 5) —
 * AUT-6655: $10.99 spent of a $50.00 cap, the next Implementation run reserving up to $40.00. The
 * page said "It has spent its cap of $50.00"; the owner raised to 51, 52, 53 and 54, each accepted
 * and each paused again.
 */
describe('a budget pause says its arithmetic (S-28.1)', () => {
  it('says what was spent, what the next run reserves, by how much it would exceed the cap and the minimum', async () => {
    const { view } = open({ pausedReason: 'budget', scope: 'task', figures: AUT_6655 });
    const reason = (await view.findByRole('region', { name: 'Needs you' })).querySelector(
      '[data-budget-reason]',
    );
    expect(reason?.textContent).toBe(
      'Paused before starting Implementation: spent $10.99 of the $50.00 cap; the next run reserves up to $40.00, which would exceed the cap by $0.99. Raise the cap to at least $50.99 — the task then continues at Implementation; finished stages are not redone.',
    );
    // Never "spent its cap" for a task that has not.
    expect(view.container.textContent).not.toContain('spent its cap');
  });

  it('pre-fills the minimum rounded up to a dollar, explains the reserve, and refuses less', async () => {
    const user = userEvent.setup();
    const { view, sent } = open({ pausedReason: 'budget', scope: 'task', figures: AUT_6655 });
    await user.click(await view.findByRole('button', { name: 'Raise the cap…' }));
    const field = (await view.findByLabelText('New cap (USD)')) as HTMLInputElement;
    expect(field.value).toBe('51');
    expect(view.baseElement.querySelector('[data-raise-explanation]')?.textContent).toBe(
      'Spent $10.99. The next Implementation run reserves up to $40.00 — a ceiling, not spend: unused reserve is returned. The cap must be at least $50.99 for the task to continue. A project that wants a smaller reserve lowers Implementation’s run budget in its configuration.',
    );
    const button = view.getByText("Raise this task's cap", {
      selector: 'button',
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    // A figure above the cap in force but below the minimum is not sent: it would pause again.
    await user.clear(field);
    await user.type(field, '50.5');
    expect(button.disabled).toBe(true);
    await user.clear(field);
    await user.type(field, '50.99');
    expect(button.disabled).toBe(false);
    await user.click(button);
    await waitFor(() => {
      expect(sent.map((entry) => entry.path)).toEqual([
        `/api/tasks/${TASK}/budget`,
        `/api/tasks/${TASK}/resume`,
      ]);
    });
    expect(sent[0]?.body).toEqual({ cap_usd: 50.99 });
  });

  it('shows the server’s refusal in the dialog and resumes nothing (M28 ruling 5)', async () => {
    const user = userEvent.setup();
    // A pause recorded before its figures: the dialog cannot know the minimum, so the server says it.
    const { view, sent } = open({ pausedReason: 'budget', scope: 'task', raise: 'insufficient' });
    await user.click(await view.findByRole('button', { name: 'Raise the cap…' }));
    await user.type(await view.findByLabelText('New cap (USD)'), '50.5');
    await user.click(view.getByText("Raise this task's cap", { selector: 'button' }));
    await waitFor(() => {
      expect(view.baseElement.textContent).toContain(
        'That cap is too low for the task to continue. It has spent $10.99 and the next Implementation run reserves up to $40.00 (a ceiling, not spend). Enter at least $50.99.',
      );
    });
    // The raise was refused, so the resume was never sent.
    expect(sent.map((entry) => entry.path)).toEqual([`/api/tasks/${TASK}/budget`]);
  });
});

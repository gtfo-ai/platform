/**
 * The epic split's acceptance panel on the task page (WP-44, criterion 3; PROGRESS backlog 108 (a);
 * Q85's surface half), through `createApp` with a fake server.
 *
 * Three properties, each one the plan row names: the queue as it comes back with **a checkbox per
 * child and one button**, the decision carrying the SPA's **per-intent** `Idempotency-Key`, and the
 * control **absent** for a caller the server says may not decide — a member and a viewer read the
 * queue and see no button.
 */
import type { TaskDetailResponse, TicketBreakdownItem } from '@platform/contracts';
import { EPIC_SPLIT_TEMPLATE_ID } from '@platform/domain';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';
import { EPIC_SPLIT_TEMPLATE } from './task-detail.js';

const PROJECT = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-0000000000b1';
const CHILD = (n: number): string => `00000000-0000-4000-8000-0000000000e${n}`;

const SESSION: SessionResponse = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'pm@example.invalid',
    name: 'Fake PM',
    role: 'maintainer',
  },
  session: { id: '00000000-0000-4000-8000-000000000002' },
};

const TASK_DETAIL: TaskDetailResponse = {
  task: {
    id: TASK,
    project_id: PROJECT,
    ticket: { provider: 'jira', key: 'ACME-9', url: 'https://jira.example.test/browse/ACME-9' },
    ticket_title: null,
    template: 'epic_split',
    mode: 'normal',
    state: 'active',
    current_stage: 'human_review',
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
    cost_actual_usd: 0.8,
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
    created_at: '2026-09-13T04:00:00.000Z',
    updated_at: '2026-09-13T04:00:00.000Z',
    completed_at: null,
    ticket_claim: null,
    qa_stage: false,
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
  runs: [],
};

const child = (n: number, over: Partial<TicketBreakdownItem> = {}): TicketBreakdownItem => ({
  id: CHILD(n),
  task_id: TASK,
  position: n,
  title: `Child ${n} <b>bold</b>`,
  description: `What child ${n} does.`,
  acceptance_criteria: [
    {
      id: `AC-${n}`,
      given: 'a signed-in user',
      when: 'they open the page',
      // biome-ignore lint/suspicious/noThenProperty: Given/When/Then is the criterion's own shape (technical/12); a plain object, never awaited.
      then: 'it loads',
      validation: { kind: 'manual', value: 'look at it' },
    },
  ],
  size: 'S',
  rationale: `Why child ${n} is separate.`,
  status: 'queued',
  decided_by_user_id: null,
  decided_at: null,
  reason: null,
  ticket_key: null,
  ticket_url: null,
  created_at: '2026-09-13T05:00:00.000Z',
  ...over,
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fetchFor = (
  queue: { items: readonly TicketBreakdownItem[]; can_decide: boolean },
  decisions: { body: unknown; key: string | null }[],
) =>
  (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes('/api/auth/get-session')) return json(SESSION);
    if (init?.method === 'POST' && url.endsWith(`/api/tasks/${TASK}/breakdown/decide`)) {
      decisions.push({
        body: JSON.parse(String(init.body)),
        key: new Headers(init.headers).get('idempotency-key'),
      });
      return json({ task_id: TASK, performed: true, accepted: 2, rejected: 0, remaining: 1 });
    }
    if (url.endsWith(`/api/tasks/${TASK}/breakdown`)) return json(queue);
    if (url.endsWith(`/api/tasks/${TASK}/asks`)) return json({ items: [] });
    if (url.endsWith(`/api/tasks/${TASK}/audit`)) return json({ items: [] });
    if (url.endsWith(`/api/tasks/${TASK}`)) return json(TASK_DETAIL);
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

describe('the breakdown panel', () => {
  it('is keyed on the domain’s own template id', () => {
    expect(EPIC_SPLIT_TEMPLATE).toBe(EPIC_SPLIT_TEMPLATE_ID);
  });

  it('shows the queue, a checkbox per queued child, and accepts a subset with one request', async () => {
    const decisions: { body: unknown; key: string | null }[] = [];
    const user = userEvent.setup();
    const queue = {
      items: [
        child(1),
        child(2),
        child(3),
        child(4, {
          status: 'rejected',
          reason: 'covered by ACME-2',
          decided_by_user_id: SESSION.user.id,
          decided_at: '2026-09-13T05:30:00.000Z',
        }),
      ],
      can_decide: true,
    };
    const { container } = render(
      createApp({ fetchImpl: fetchFor(queue, decisions), realtime: false }).element,
    );
    await screen.findByText('Proposed breakdown');
    await waitFor(() => {
      expect(container.textContent).toContain('Child 1 <b>bold</b>');
    });
    // Model output rendered as text (BD-022): the characters are there, no element was made.
    expect(container.querySelector('b')).toBeNull();
    // A rejected row keeps its reason, and has no checkbox — only queued children do.
    expect(container.textContent).toContain('covered by ACME-2');
    expect(screen.getAllByRole('checkbox', { name: /Select child/ })).toHaveLength(3);

    await user.click(screen.getByRole('checkbox', { name: 'Select child 2' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select child 4' }));
    const accept = screen.getByRole('button', {
      name: /Accept 2 — creates tickets in your tracker/,
    });
    await user.click(accept);
    await waitFor(() => {
      expect(decisions).toHaveLength(1);
    });
    expect(decisions[0]?.body).toEqual({ decision: 'accept', item_ids: [CHILD(1), CHILD(3)] });
    expect(decisions[0]?.key).toMatch(/.+/);
  });

  it('leaves the control out for a caller the server says may not decide', async () => {
    const { container } = render(
      createApp({
        fetchImpl: fetchFor({ items: [child(1), child(2)], can_decide: false }, []),
        realtime: false,
      }).element,
    );
    await screen.findByText('Proposed breakdown');
    await waitFor(() => {
      expect(container.textContent).toContain('Child 1');
    });
    expect(screen.queryAllByRole('checkbox', { name: /Select child/ })).toEqual([]);
    expect(screen.queryByRole('button', { name: /Accept/ })).toBeNull();
    expect(container.textContent).toContain('needs the maintainer role');
  });
});

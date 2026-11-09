/**
 * **A queued task says what it waits for, and what frees it** (S-25.16; Autix, 2026-11-09: five
 * tickets *Queued* for days with no run while five stopped tasks filled the pipeline, and the page
 * said nothing).
 *
 * Driven through `createApp` against a fake server, as `ticket-held-elsewhere.test.tsx` is: the real
 * router and the endpoint parsers, so `queue_wait` is read through `taskDetailResponseSchema`.
 *
 * Covered: the header's *Now* line; the callout's sentence, neutral (`info`, never *Needs you* and
 * never amber) with the holding tasks as links to their pages and *and N more* past the cut;
 * *Change the limit* only for a reader the configuration write admits, both directions; the
 * parallel-limit form naming the running tasks; the honest `admitted`; and a ticket key rendered as
 * text, never markup.
 */
import type { QueueWait, TaskDetailResponse, TaskRecord } from '@platform/contracts';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';

const PROJECT = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-0000000000b1';
const ME = '00000000-0000-4000-8000-000000000001';
const AT = '2026-11-06T09:00:00.000Z';
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const session: SessionResponse = {
  user: { id: ME, email: 'operator@example.invalid', name: 'Fake Operator', role: 'admin' },
  session: { id: '00000000-0000-4000-8000-000000000002' },
};

const PROJECT_ROW = {
  id: PROJECT,
  key: 'aut',
  name: 'Autix',
  repo_url: 'https://git.example.invalid/acme/api.git',
  default_branch: 'main',
  agentic_dir: '.agentic',
  knowledge_dir: 'knowledge',
  autonomy_level: 'supervised',
  readiness_level: 2,
  status: 'active',
  created_at: AT,
  updated_at: AT,
  open_tasks: 10,
  spent_usd_30d: 0,
};

const TASK_ROW: TaskRecord = {
  id: TASK,
  project_id: PROJECT,
  ticket: { provider: 'jira-cloud', key: 'AUT-6862', url: 'https://jira.example.test/AUT-6862' },
  ticket_title: 'Export invoices as CSV',
  template: 'feature',
  mode: 'normal',
  state: 'queued',
  current_stage: null,
  size: null,
  branch: null,
  mr_ref: null,
  workpad_ref: null,
  iteration_counters: {},
  risk_classes: [],
  coverage: null,
  review_threads: null,
  dependencies: null,
  conflict: null,
  required_reviewers: null,
  cost_actual_usd: 0,
  unmeasured_runs: 0,
  budget_cap_usd: 5,
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
  waiting: null,
  owner: null,
  owner_source: null,
  unlinked_assignee: null,
  owner_writes_back: false,
  tracker_assignee: null,
};

const holders = (count: number, state: 'needs_human' | 'active' = 'needs_human') =>
  Array.from({ length: count }, (_, index) => ({
    task_id: id(100 + index),
    ticket_key: `AUT-66${String(index + 1).padStart(2, '0')}`,
    state,
  }));

const AUTIX: Extract<QueueWait, { status: 'waiting' }> = {
  status: 'waiting',
  reason: 'max_tasks_in_pipeline',
  count: 5,
  limit: 5,
  organisation_bound: false,
  position: 2,
  queued: 5,
  running: { count: 0, limit: 2 },
  pipeline: { count: 5, limit: 5 },
  holders: { total: 5, needs_human: 5, items: holders(5) },
};

const detail = (
  wait: QueueWait | null,
  over: Partial<TaskDetailResponse> = {},
  task: Partial<TaskRecord> = {},
): TaskDetailResponse => ({
  task: { ...TASK_ROW, ...task },
  taken_over: null,
  can_raise_budget: false,
  can_export: false,
  can_pause: true,
  can_resume: true,
  can_cancel: true,
  can_return: true,
  can_rework: true,
  can_decide_approval: true,
  can_change_limits: true,
  can_retry_run: true,
  can_take_over: true,
  take_writes_back: false,
  can_take: true,
  can_assign: true,
  can_unassign: false,
  gate_feedback: null,
  returns: [],
  stop: null,
  gate_wait: null,
  last_gate_wait: null,
  escalation: null,
  queue_wait: wait,
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
  runs: [],
  ...over,
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const start = (task: TaskDetailResponse, role: SessionResponse['user']['role'] = 'admin') => {
  const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    const path = new URL(url, 'http://localhost').pathname;
    if (url.includes('/api/auth/get-session')) {
      return json({ ...session, user: { ...session.user, role } });
    }
    if (path === `/api/tasks/${TASK}`) return json(task);
    if (path === '/api/projects') return json({ items: [PROJECT_ROW] });
    if (path === '/api/org/inbox')
      return json({ questions: [], approvals: [], ci_held: [], escalated: [] });
    if (path === `/api/projects/${PROJECT}/owner-candidates`) return json({ items: [] });
    if (path === `/api/tasks/${TASK}/asks`) return json({ items: [] });
    if (path === `/api/tasks/${TASK}/pipeline`) {
      return json({ error: { code: 'not_found', message: 'no graph in this fake' } }, 404);
    }
    if (path.startsWith(`/api/tasks/${TASK}/`)) return json({ items: [], next_cursor: null });
    return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
  }) as typeof fetch;
  window.history.pushState({}, '', `/tasks/${TASK}`);
  render(createApp({ fetchImpl, realtime: false }).element);
};

const notice = async (): Promise<HTMLElement> => screen.findByTestId('queue-wait-notice');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('a queued task’s page (S-25.16)', () => {
  it('says what holds it, what frees it and its place — neutral, with the holders as links', async () => {
    start(detail(AUTIX));
    const box = await notice();
    expect(box.querySelector('[data-queue-sentence]')?.textContent).toBe(
      'Waiting for a place: this project holds at most 5 tasks in its pipeline, and 5 are in it — ' +
        '5 of them wait for you. A place frees when one of them finishes or is cancelled, so decide ' +
        'them or cancel one. AUT-6862 is 2nd in the queue: 1 ticket is ahead of it.',
    );
    // Information, never the amber *Needs you* callout.
    expect(box.querySelector('[data-flash]')?.getAttribute('data-flash')).toBe('info');
    expect(screen.queryByTestId('needs-you-callout')).toBeNull();
    const links = within(box).getAllByRole('link');
    const holderLinks = links.filter((link) => /^AUT-66/.test(link.textContent ?? ''));
    expect(holderLinks.map((link) => link.getAttribute('href'))).toEqual(
      AUTIX.holders.items.map((held) => `/tasks/${held.task_id}`),
    );
    expect(box.querySelectorAll('[data-queue-holder="needs_human"]')).toHaveLength(5);
    expect(box.querySelector('[data-queue-more]')).toBeNull();
  });

  it('says the Now line in the header, which a queued task had none of', async () => {
    start(detail(AUTIX));
    await notice();
    expect(document.querySelector('[data-queue-now]')?.textContent).toBe(
      'Queued · Now: Waiting for a place · 2nd in queue · 5 of 5 places taken',
    );
  });

  it('offers Change the limit to a reader who may change it, and to nobody else', async () => {
    start(detail(AUTIX));
    const link = within(await notice()).getByRole('link', { name: 'Change the limit' });
    expect(link.getAttribute('href')).toBe('/projects/aut/settings/policies');

    cleanup();
    start(detail(AUTIX, { can_change_limits: false }));
    expect(within(await notice()).queryByRole('link', { name: 'Change the limit' })).toBeNull();
  });

  /**
   * S-25.21 (BACKLOG 1371): when the organisation's maximum is what binds, the project's value would
   * change nothing — so the callout says whose limit it is, links an organisation administrator to
   * the organisation's Policies, tells anyone else who can raise it, and offers the project link to
   * nobody.
   */
  describe('when the organisation’s maximum binds', () => {
    const BOUND: QueueWait = { ...AUTIX, organisation_bound: true };

    it('says so, and links an organisation administrator to its Policies', async () => {
      start(detail(BOUND), 'admin');
      const box = await notice();
      expect(box.querySelector('[data-queue-organisation-limit]')?.textContent).toBe(
        'Your organisation allows at most 5 tasks in a project’s pipeline, so this project’s own ' +
          'limit cannot go higher. Change the organisation’s limit',
      );
      const link = within(box).getByRole('link', { name: 'Change the organisation’s limit' });
      expect(link.getAttribute('href')).toBe('/settings/policies');
      // Never the project page, which would change nothing — even for a reader who may write it.
      expect(within(box).queryByRole('link', { name: 'Change the limit' })).toBeNull();
    });

    it('tells a reader who is not an administrator who can raise it, with no link', async () => {
      start(detail(BOUND), 'member');
      const box = await notice();
      expect(box.querySelector('[data-queue-organisation-limit]')?.textContent).toBe(
        'Your organisation allows at most 5 tasks in a project’s pipeline, so this project’s own ' +
          'limit cannot go higher. An organisation administrator can raise it.',
      );
      expect(
        within(box).queryByRole('link', { name: 'Change the organisation’s limit' }),
      ).toBeNull();
      expect(within(box).queryByRole('link', { name: 'Change the limit' })).toBeNull();
    });

    it('names the parallel limit in its own words', async () => {
      start(
        detail({
          ...AUTIX,
          reason: 'max_parallel_tasks',
          count: 1,
          limit: 1,
          organisation_bound: true,
          running: { count: 1, limit: 1 },
          pipeline: { count: 1, limit: 5 },
          holders: { total: 1, needs_human: 0, items: holders(1, 'active') },
        }),
      );
      expect(
        (await notice()).querySelector('[data-queue-organisation-limit]')?.textContent,
      ).toMatch(/^Your organisation allows at most 1 parallel task per project, /);
    });

    it('says nothing of the organisation when the project’s own limit binds', async () => {
      start(detail(AUTIX), 'admin');
      const box = await notice();
      expect(box.querySelector('[data-queue-organisation-limit]')).toBeNull();
      expect(within(box).getByRole('link', { name: 'Change the limit' })).toBeTruthy();
    });
  });

  it('says the holders wait for a person, and asks nothing, of a reader who may not cancel', async () => {
    start(detail(AUTIX, { can_cancel: false }));
    const sentence = (await notice()).querySelector('[data-queue-sentence]')?.textContent ?? '';
    expect(sentence).toContain('5 of them wait for a person.');
    expect(sentence).not.toMatch(/for you|decide them/);
  });

  it('lists ten holders and says how many more', async () => {
    const many: QueueWait = {
      ...AUTIX,
      count: 12,
      limit: 12,
      pipeline: { count: 12, limit: 12 },
      holders: { total: 12, needs_human: 12, items: holders(10) },
    };
    start(detail(many));
    const box = await notice();
    expect(box.querySelectorAll('[data-queue-holder]')).toHaveLength(10);
    expect(box.querySelector('[data-queue-more]')?.textContent).toBe('and 2 more');
  });

  it('names the running tasks for the parallel limit', async () => {
    const parallel: QueueWait = {
      status: 'waiting',
      reason: 'max_parallel_tasks',
      count: 2,
      limit: 2,
      organisation_bound: false,
      position: 1,
      queued: 1,
      running: { count: 2, limit: 2 },
      pipeline: { count: 2, limit: 5 },
      holders: { total: 2, needs_human: 0, items: holders(2, 'active') },
    };
    start(detail(parallel));
    const box = await notice();
    expect(box.querySelector('[data-queue-sentence]')?.textContent).toBe(
      'Waiting for a place: this project runs at most 2 tasks at once, and 2 are running. A place ' +
        'frees when one of them finishes, stops for a person, is paused or is cancelled. AUT-6862 is ' +
        'next in the queue and starts then.',
    );
    expect(box.querySelectorAll('[data-queue-holder="active"]')).toHaveLength(2);
  });

  it('says there is room for an admitted task, with nothing holding it and no limit to change', async () => {
    start(
      detail({
        status: 'admitted',
        position: 1,
        queued: 1,
        running: { count: 0, limit: 2 },
        pipeline: { count: 1, limit: 5 },
      }),
    );
    const box = await notice();
    expect(box.getAttribute('data-testid')).toBe('queue-wait-notice');
    expect(box.querySelector('[data-queue-wait]')?.getAttribute('data-queue-wait')).toBe(
      'admitted',
    );
    expect(box.querySelector('[data-queue-holders]')).toBeNull();
    expect(within(box).queryByRole('link', { name: 'Change the limit' })).toBeNull();
  });

  it('says nothing of a queue for a task the read gives no wait', async () => {
    start(detail(null));
    await screen.findAllByText('Export invoices as CSV');
    expect(screen.queryByTestId('queue-wait-notice')).toBeNull();
    expect(document.querySelector('[data-queue-now]')).toBeNull();
  });

  it('renders a hostile ticket key as text', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    start(detail(AUTIX, {}, { ticket: { ...TASK_ROW.ticket, key: hostile } }));
    const box = await notice();
    expect(box.textContent).toContain(`${hostile} is 2nd in the queue`);
    expect(box.querySelector('img')).toBeNull();
  });
});

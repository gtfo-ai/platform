/**
 * The inbox (S-23.11a: GitHub's notifications), driven through `createApp` with a fake server so
 * the real router, query client and endpoint parsers are asserted.
 *
 * What it holds: each row says when its item is due (PROGRESS backlog 166, WP-73), in both
 * directions — a row that printed nothing would pass the null case, one that printed `due Invalid
 * Date` the present one (standing rule 42); the expiry note survives as a hint and a *Learn more*
 * (backlog 163, WP-95); the NavList filters by kind and by project with counts read off the items
 * and their tasks; a question row expands in place and its *Answer* sends the command; and an
 * agent's question renders as text.
 */
import type { InboxResponse, TaskDetailResponse, TaskRecord } from '@platform/contracts';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';
import { formatDateTime } from '../ui/kit.js';
import { firstLine } from './inbox.js';

const TASK = '00000000-0000-4000-8000-0000000000c1';
const OTHER_TASK = '00000000-0000-4000-8000-0000000000c2';
const PROJECT = '00000000-0000-4000-8000-0000000000e1';
const DUE = '2026-09-30T15:00:00.000Z';
const NOW = Date.parse('2026-09-29T09:05:00.000Z');

const SESSION: SessionResponse = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'operator@example.invalid',
    name: 'Fake Operator',
    role: 'admin',
  },
  session: { id: '00000000-0000-4000-8000-000000000002' },
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let inbox: InboxResponse;

interface Sent {
  readonly url: string;
  readonly body: unknown;
}

const PROJECT_ROW = {
  id: PROJECT,
  key: 'acme',
  name: 'Acme service',
  repo_url: 'https://git.example.invalid/acme/service.git',
  default_branch: 'main',
  agentic_dir: '.agentic',
  knowledge_dir: 'knowledge',
  autonomy_level: 'supervised',
  readiness_level: 2,
  status: 'active',
  created_at: '2026-06-01T09:00:00.000Z',
  updated_at: '2026-06-01T09:00:00.000Z',
  open_tasks: 1,
  spent_usd_30d: 0,
};

const taskRecord = (id: string, key: string): TaskRecord => ({
  id,
  project_id: PROJECT,
  ticket: { provider: 'jira-cloud', key, url: 'https://jira.example.invalid/' },
  ticket_title: 'Retry budget',
  template: 'feature',
  mode: 'normal',
  state: 'waiting_answers',
  current_stage: 'refinement',
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
  created_at: '2026-09-29T07:00:00.000Z',
  updated_at: '2026-09-29T08:00:00.000Z',
  completed_at: null,
  ticket_claim: null,
  qa_stage: false,
});

const detail = (record: TaskRecord): TaskDetailResponse => ({
  task: record,
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
});

/** The task reads answer only for the tasks named; any other answers 404, "not known yet". */
const fakeServer = (
  tasks: Readonly<Record<string, string>> = {},
  options: { readonly refuseAnswers?: boolean } = {},
) => {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if ((init?.method ?? 'GET') === 'POST' && url.includes('/answer')) {
      sent.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
      if (options.refuseAnswers === true) {
        return json(
          {
            error: {
              code: 'illegal_transition',
              message: 'the question was already answered in the ticket',
            },
          },
          409,
        );
      }
      inbox = { ...inbox, questions: [] };
      return json({ question: null, performed: true });
    }
    if (url.includes('/api/auth/get-session')) return json(SESSION);
    if (url.endsWith('/api/org/inbox')) return json(inbox);
    if (url.endsWith('/api/projects')) return json({ items: [PROJECT_ROW] });
    for (const [taskId, key] of Object.entries(tasks)) {
      if (url.endsWith(`/api/tasks/${taskId}`)) return json(detail(taskRecord(taskId, key)));
    }
    return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
  }) as typeof fetch;
  return { sent, fetchImpl };
};

const approval = (deadline: string | null): InboxResponse['approvals'][number] => ({
  id: '00000000-0000-4000-8000-0000000000a1',
  task_id: TASK,
  kind: 'plan',
  status: 'pending',
  requested_at: '2026-09-29T09:00:00.000Z',
  deadline_at: deadline,
  decided_by_user_id: null,
  decided_at: null,
  reason: null,
});

const question = (
  overrides: Partial<InboxResponse['questions'][number]> = {},
): InboxResponse['questions'][number] => ({
  id: '00000000-0000-4000-8000-0000000000b1',
  task_id: OTHER_TASK,
  stage: 'refinement',
  run_id: null,
  text: 'Should the retry budget be three or five?\nThe ticket says both.',
  options: null,
  blocking: true,
  status: 'open',
  asked_at: '2026-09-29T08:00:00.000Z',
  deadline_at: DUE,
  reminders_sent: 0,
  answer: null,
  answered_by_user_id: null,
  answered_via: null,
  answered_at: null,
  ...overrides,
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  window.history.pushState({}, '', '/inbox');
});

const renderInbox = async (fetchImpl: typeof fetch): Promise<HTMLElement> => {
  const { container } = render(createApp({ fetchImpl, realtime: false, now: () => NOW }).element);
  await screen.findByRole('list', { name: 'Waiting for you' });
  return container;
};

describe('the approval row', () => {
  it('prints the approval’s due time, as the question row does', async () => {
    inbox = { questions: [], approvals: [approval(DUE)] };
    const container = await renderInbox(fakeServer().fetchImpl);
    expect(container.textContent).toContain(`· due ${formatDateTime(DUE)}`);
    expect(container.textContent).toContain('requested 5 m ago');
  });

  it('prints no due time for an approval that has none', async () => {
    inbox = { questions: [], approvals: [approval(null)] };
    const container = await renderInbox(fakeServer().fetchImpl);
    expect(container.textContent).toContain('requested 5 m ago');
    expect(container.textContent).not.toContain(' · due ');
  });

  it('links to the task, where it is decided, and names the kind in words', async () => {
    inbox = { questions: [], approvals: [approval(DUE)] };
    await renderInbox(fakeServer().fetchImpl);
    expect(screen.getByRole('link', { name: 'Decide on the task' }).getAttribute('href')).toBe(
      `/tasks/${TASK}`,
    );
    expect(screen.getByText('Plan approval is waiting for you')).toBeTruthy();
    // One link per approval row, not a title link and a button to the same task.
    expect(
      screen.getAllByRole('link').filter((link) => link.getAttribute('href') === `/tasks/${TASK}`),
    ).toHaveLength(1);
  });
});

/**
 * PROGRESS backlog 163's inbox half, closed by decision at WP-95: an expired question or approval
 * leaves the inbox (`listInbox` serves `open` and `pending` only), and the screen says where it went
 * — on a full inbox and on an empty one, because the person who needs the sentence is the one whose
 * row just disappeared. Since S-23.11a it is one line and a *Learn more*.
 */
describe('what the inbox says about an item that expired', () => {
  it('says an expired item leaves the list and names where its task is retried', async () => {
    inbox = { questions: [], approvals: [approval(DUE)] };
    const container = await renderInbox(fakeServer().fetchImpl);
    const note = container.querySelector('[data-inbox-expiry-note]');
    expect(note?.textContent).toContain('expires leaves this list');
    // The board column's name since S-23.2: TD-033's word for `needs_human`.
    expect(note?.textContent).toContain('Needs you');
    expect(note?.textContent).toContain('task page');
    expect(note?.querySelector('details summary')?.textContent).toBe('Learn more');
  });

  it('says it on an empty inbox too, under an informational blankslate', async () => {
    inbox = { questions: [], approvals: [] };
    const { container } = render(
      createApp({ fetchImpl: fakeServer().fetchImpl, realtime: false }).element,
    );
    await screen.findByText('Nothing needs you');
    expect(container.querySelector('[data-inbox-expiry-note]')).not.toBeNull();
    expect(container.querySelector('[data-blankslate="informational"]')).not.toBeNull();
  });
});

describe('the filters', () => {
  it('counts and filters by kind and by project, the project read off each item’s task', async () => {
    inbox = { questions: [question()], approvals: [approval(DUE)] };
    const { fetchImpl } = fakeServer({ [OTHER_TASK]: 'ACME-12' });
    await renderInbox(fetchImpl);
    const filters = screen.getByRole('navigation', { name: 'Inbox filters' });
    const button = (name: RegExp) => within(filters).getByRole('button', { name });
    expect(button(/^All/).textContent).toContain('2');
    expect(button(/^Questions/).textContent).toContain('1');
    expect(button(/^Approvals/).textContent).toContain('1');
    // The question's task answered with its project; the approval's did not, so it is in no project.
    const project = await within(filters).findByRole('button', { name: /^acme/ });
    expect(project.textContent).toContain('1');
    // Where the row is, from that task: project · ticket · stage.
    await waitFor(() => {
      expect(document.querySelector('[data-inbox-where]')?.textContent).toBe(
        'acme·ACME-12·Refinement',
      );
    });

    const user = userEvent.setup();
    await user.click(button(/^Approvals/));
    expect(button(/^Approvals/).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByText('Should the retry budget be three or five?')).toBeNull();
    expect(screen.getByText('Plan approval is waiting for you')).toBeTruthy();

    await user.click(project);
    expect(screen.getByText('Should the retry budget be three or five?')).toBeTruthy();
    expect(screen.queryByText('Plan approval is waiting for you')).toBeNull();
  });
});

describe('a question row', () => {
  it('shows the first line, expands in place, and Answer sends the command', async () => {
    inbox = { questions: [question()], approvals: [] };
    const { sent, fetchImpl } = fakeServer();
    await renderInbox(fetchImpl);
    const toggle = screen.getByRole('button', {
      name: 'Should the retry budget be three or five?',
    });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // Collapsed: the second line and the answer box are not on screen.
    expect(screen.queryByLabelText('Your answer')).toBeNull();
    expect(document.body.textContent).not.toContain('The ticket says both.');

    const user = userEvent.setup();
    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(document.body.textContent).toContain('The ticket says both.');
    const answer = screen.getByRole('button', { name: 'Answer' });
    // Nothing typed: nothing to send.
    expect((answer as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText('Your answer'), 'three');
    await user.click(answer);
    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]?.url).toContain(
      `/api/tasks/${OTHER_TASK}/questions/00000000-0000-4000-8000-0000000000b1/answer`,
    );
    expect(sent[0]?.body).toEqual({ answer: 'three' });
    // The inbox is read again, and the answered question has left it.
    expect(await screen.findByText('Nothing needs you')).toBeTruthy();
  });

  it('says the answer was refused when the server answers 409, and keeps the question', async () => {
    inbox = { questions: [question()], approvals: [] };
    const { sent, fetchImpl } = fakeServer({}, { refuseAnswers: true });
    await renderInbox(fetchImpl);
    const user = userEvent.setup();
    await user.click(
      screen.getByRole('button', { name: 'Should the retry budget be three or five?' }),
    );
    await user.type(screen.getByLabelText('Your answer'), 'five');
    await user.click(screen.getByRole('button', { name: 'Answer' }));
    expect(await screen.findByText('That answer was refused.')).toBeTruthy();
    expect(sent).toHaveLength(1);
    // Still there, with what was typed, so it can be sent again or answered elsewhere.
    expect((screen.getByLabelText('Your answer') as HTMLTextAreaElement).value).toBe('five');
    expect(screen.queryByText('Nothing needs you')).toBeNull();
  });

  it('renders an agent’s markup as text', async () => {
    inbox = {
      questions: [question({ text: '<img src=x onerror="window.__pwned=1"> retry?' })],
      approvals: [],
    };
    const container = await renderInbox(fakeServer().fetchImpl);
    expect(container.textContent).toContain('<img src=x');
    expect(container.querySelector('main img')).toBeNull();
  });
});

describe('firstLine', () => {
  it('is the first non-empty line, trimmed', () => {
    expect(firstLine('\n  Why three?  \nBecause.')).toBe('Why three?');
    expect(firstLine('   ')).toBe('   ');
  });
});

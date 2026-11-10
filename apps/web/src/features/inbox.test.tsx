/**
 * The inbox (S-23.11a: GitHub's notifications), driven through `createApp` with a fake server so
 * the real router, query client and endpoint parsers are asserted.
 *
 * What it holds: a question row says when it is due (PROGRESS backlog 166, WP-73), and an approval
 * row never does — it *waits for a maintainer* (S-27.1, BD-006's 2026-11-07 amendment), even when a
 * read still carries a deadline — in both directions (standing rule 42); the expiry note survives as
 * a hint and a *Learn more* (backlog 163, WP-95), and says an approval does not expire; the NavList filters by kind and by project with counts read off the items
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
import { ROW_LINK_ATTRIBUTE } from '../ui/row-link.js';
import { firstLine, timeLine } from './inbox.js';

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
  tracker_assignee: null,
  owner: null,
  owner_source: null,
  unlinked_assignee: null,
  owner_writes_back: false,
  waiting: null,
});

const detail = (record: TaskRecord): TaskDetailResponse => ({
  task: record,
  taken_over: null,
  can_raise_budget: false,
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
  runs: [],
});

/** The task reads answer only for the tasks named; any other answers 404, "not known yet". */
const PLAN_ARTIFACT = '00000000-0000-4000-8000-0000000000d1';

const fakeServer = (
  tasks: Readonly<Record<string, string>> = {},
  options: { readonly refuseAnswers?: boolean; readonly plan?: boolean } = {},
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
    if (options.plan === true && url.endsWith(`/api/artifacts/${PLAN_ARTIFACT}`)) {
      return json({
        id: PLAN_ARTIFACT,
        task_id: TASK,
        artifact_type: 'ImplementationPlan',
        version: 2,
        schema_version: '1',
        produced_by_run_id: null,
        created_at: '2026-09-29T08:30:00.000Z',
        redaction_count: 0,
        markdown: null,
        data: {
          estimated_size: 'L',
          files_to_change: Array.from({ length: 6 }, (_, index) => ({
            path: `src/file-${index}.ts`,
            change: 'edit',
          })),
        },
      });
    }
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
  it('says it waits for a maintainer and prints no due time, even when a read carries one (S-27.1)', async () => {
    // An earlier server's read could still carry an approval's old deadline: it is not a due time.
    inbox = { questions: [], approvals: [approval(DUE)], ci_held: [], escalated: [] };
    const container = await renderInbox(fakeServer().fetchImpl);
    expect(container.textContent).toContain('requested 5 m ago · waits for a maintainer');
    expect(container.textContent).not.toContain(' · due ');
    expect(container.textContent).not.toContain(formatDateTime(DUE));
  });

  it('says the same for an approval with no deadline, which is every approval since S-27.1', async () => {
    inbox = { questions: [], approvals: [approval(null)], ci_held: [], escalated: [] };
    const container = await renderInbox(fakeServer().fetchImpl);
    expect(container.textContent).toContain('requested 5 m ago · waits for a maintainer');
    expect(container.textContent).not.toContain(' · due ');
  });

  it('still prints a question’s due time beside it (the control)', async () => {
    inbox = { questions: [question()], approvals: [approval(null)], ci_held: [], escalated: [] };
    const container = await renderInbox(fakeServer().fetchImpl);
    expect(container.textContent).toContain(`· due ${formatDateTime(DUE)}`);
    expect(container.textContent).toContain('requested 5 m ago · waits for a maintainer');
  });

  it('links to the task with Review plan, and says the plan was not recorded when it was not', async () => {
    inbox = { questions: [], approvals: [approval(DUE)], ci_held: [], escalated: [] };
    await renderInbox(fakeServer().fetchImpl);
    expect(screen.getByRole('link', { name: 'Review plan' }).getAttribute('href')).toBe(
      `/tasks/${TASK}`,
    );
    // An approval asked before approvals recorded their plan: said, never guessed (TD-035).
    expect(screen.getByText('Plan approval · the plan it is about was not recorded')).toBeTruthy();
    // One link per approval row, not a title link and a button to the same task.
    expect(
      screen.getAllByRole('link').filter((link) => link.getAttribute('href') === `/tasks/${TASK}`),
    ).toHaveLength(1);
    // S-23.26: that one link is the row's stretched link, so a click anywhere on the row opens the
    // task — where the approval is decided with the plan on screen; the row decides nothing.
    expect(screen.getByRole('link', { name: 'Review plan' }).hasAttribute(ROW_LINK_ATTRIBUTE)).toBe(
      true,
    );
    // No row approves in one click (S-25.1).
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
  });

  it('names the plan it is about — version, size and files — read off the plan itself', async () => {
    inbox = {
      questions: [],
      ci_held: [],
      escalated: [],
      approvals: [
        {
          ...approval(DUE),
          subject: {
            kind: 'plan',
            artifact_id: PLAN_ARTIFACT,
            artifact_version: 2,
            stage: 'architecture',
            attempt: 1,
            basis: 'recorded',
          },
          reasons: [{ code: 'size_at_or_above', size: 'L', threshold: 'L', source: 'dial' }],
        },
      ],
    };
    await renderInbox(fakeServer({}, { plan: true }).fetchImpl);
    expect(await screen.findByText('Plan v2 · size L · 6 files')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Review plan' })).toBeTruthy();
  });
});

/**
 * PROGRESS backlog 163's inbox half, closed by decision at WP-95: an expired question or approval
 * leaves the inbox (`listInbox` serves `open` and `pending` only), and the screen says where it went
 * — on a full inbox and on an empty one, because the person who needs the sentence is the one whose
 * row just disappeared. Since S-23.11a it is one line and a *Learn more*.
 */
describe('what the inbox says about an item that expired', () => {
  // The title PROGRESS cites (frozen history); the line it opens with is S-25.5's, below.
  it('says an expired item leaves the list and names where its task is retried', async () => {
    inbox = { questions: [], approvals: [approval(DUE)], ci_held: [], escalated: [] };
    const container = await renderInbox(fakeServer().fetchImpl);
    const note = container.querySelector('[data-inbox-expiry-note]');
    expect(note?.textContent).toContain('A question that expires leaves this list');
    // The board column's name since S-23.2: TD-033's word for `needs_human`.
    expect(note?.textContent).toContain('Needs you');
    expect(note?.textContent).toContain('task page');
    expect(note?.querySelector('details summary')?.textContent).toBe('Learn more');
  });

  it('no longer says an approval expires: it waits for a maintainer (S-27.1)', async () => {
    inbox = { questions: [], approvals: [approval(null)], ci_held: [], escalated: [] };
    const container = await renderInbox(fakeServer().fetchImpl);
    const note = container.querySelector('[data-inbox-expiry-note]');
    expect(note?.textContent).toContain('An approval does not expire');
    expect(note?.textContent).toContain('until a maintainer approves or rejects it');
    expect(note?.textContent).not.toMatch(/question or approval that expires/);
  });

  it('leads with what the list is, before what an expired item does (S-25.5, F16)', async () => {
    inbox = { questions: [], approvals: [approval(DUE)], ci_held: [], escalated: [] };
    const container = await renderInbox(fakeServer().fetchImpl);
    const note = container.querySelector('[data-inbox-expiry-note]');
    expect(note?.querySelector('p')?.textContent).toBe(
      'Questions, approvals and stopped tasks waiting for a person, across all projects.',
    );
    expect(note?.querySelector('p')?.textContent).not.toContain('expire');
  });

  it('says it on an empty inbox too, under an informational blankslate', async () => {
    inbox = { questions: [], approvals: [], ci_held: [], escalated: [] };
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
    inbox = { questions: [question()], approvals: [approval(DUE)], ci_held: [], escalated: [] };
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
    expect(screen.getByText('Plan approval · the plan it is about was not recorded')).toBeTruthy();

    await user.click(project);
    expect(screen.getByText('Should the retry budget be three or five?')).toBeTruthy();
    expect(screen.queryByText('Plan approval · the plan it is about was not recorded')).toBeNull();
  });
});

describe('a question row', () => {
  it('shows the first line, expands in place, and Answer sends the command', async () => {
    inbox = { questions: [question()], approvals: [], ci_held: [], escalated: [] };
    const { sent, fetchImpl } = fakeServer();
    await renderInbox(fetchImpl);
    const toggle = screen.getByRole('button', {
      name: 'Should the retry budget be three or five?',
    });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // S-23.26: the toggle is the row's stretched control (a click anywhere opens the answer form,
    // on this page), and *Open task* is not — it keeps its own click above it.
    expect(toggle.hasAttribute(ROW_LINK_ATTRIBUTE)).toBe(true);
    expect(screen.getByRole('link', { name: 'Open task' }).hasAttribute(ROW_LINK_ATTRIBUTE)).toBe(
      false,
    );
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
    inbox = { questions: [question()], approvals: [], ci_held: [], escalated: [] };
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
      ci_held: [],
      escalated: [],
    };
    const container = await renderInbox(fakeServer().fetchImpl);
    expect(container.textContent).toContain('<img src=x');
    expect(container.querySelector('main img')).toBeNull();
  });

  /** S-28.9: the owner's "missing MD parser" in the inbox — the title plain, the body as markdown. */
  it('titles the row with the marks taken off and renders the expanded question as markdown', async () => {
    inbox = {
      questions: [
        question({
          text: '**Which** budget, `3` or `5`?\n1) **Three** keeps it fast\n2) **Five** is safer',
        }),
      ],
      approvals: [],
      ci_held: [],
      escalated: [],
    };
    const container = await renderInbox(fakeServer().fetchImpl);
    const toggle = screen.getByRole('button', { name: 'Which budget, 3 or 5?' });
    await userEvent.setup().click(toggle);
    const steps = [...(container.querySelector('main [data-markdown] ol')?.children ?? [])];
    expect(steps).toHaveLength(2);
    expect(steps[0]?.querySelector('strong')?.textContent).toBe('Three');
    expect(container.querySelector('main [data-markdown] code')?.textContent).toBe('3');
  });
});

describe('firstLine', () => {
  it('is the first non-empty line, trimmed', () => {
    expect(firstLine('\n  Why three?  \nBecause.')).toBe('Why three?');
    expect(firstLine('   ')).toBe('   ');
  });
});

/**
 * S-26.8b part 2 (BACKLOG 1300): a CI check held at a manual job needs a person now, so the read's
 * `ci_held` list is a row of its own — the job named as provider text, where it is (the read
 * carries the project and the ticket), and *Open*, which opens the task.
 */
describe('a CI check held at a manual job', () => {
  const held = (job: string | null): InboxResponse['ci_held'][number] => ({
    task_id: TASK,
    project_id: PROJECT,
    ticket: { provider: 'jira', key: 'ACME-9', url: 'https://tickets.example.invalid/ACME-9' },
    gate_wait: {
      pipeline_id: '41',
      pipeline_url: null,
      status: 'manual',
      held_job: job,
      held_job_url: null,
      draft: false,
      checked_at: '2026-09-29T09:04:00.000Z',
      waiting_since: '2026-09-29T09:00:00.000Z',
      timeout_minutes: 60,
    },
  });

  it('lists it beside the questions, counts it, and opens the task', async () => {
    inbox = {
      questions: [question()],
      approvals: [],
      ci_held: [held('deploy <b>prod</b>')],
      escalated: [],
    };
    const container = await renderInbox(fakeServer().fetchImpl);
    const row = await screen.findByText(
      'CI waits for someone to start the manual job deploy <b>prod</b>',
    );
    expect(row.closest('[data-inbox-ci-held]')?.getAttribute('data-inbox-ci-held')).toBe(TASK);
    // Provider text, rendered as text.
    expect(container.querySelector('main b')).toBeNull();
    expect(container.textContent).toContain('2 waiting for you');
    // Where it is, from the read itself: project · ticket · stage.
    await waitFor(() => {
      expect(row.closest('li')?.querySelector('[data-inbox-where]')?.textContent).toBe(
        'acme·ACME-9·CI',
      );
    });
    expect(container.textContent).toContain('waiting since 5 m ago');
    const open = screen.getByRole('link', { name: 'Open ACME-9' });
    expect(open.getAttribute('href')).toBe(`/tasks/${TASK}`);
    expect(screen.queryByText('Nothing needs you')).toBeNull();
  });

  it('says a manual job the read could not name, and keeps it out of the Questions filter', async () => {
    inbox = { questions: [], approvals: [], ci_held: [held(null)], escalated: [] };
    const container = await renderInbox(fakeServer().fetchImpl);
    await screen.findByText('CI waits for someone to start a manual job');
    const filters = screen.getByRole('navigation', { name: 'Inbox filters' });
    expect(within(filters).getByRole('button', { name: /^All/ }).textContent).toContain('1');
    await userEvent.setup().click(within(filters).getByRole('button', { name: /^Questions/ }));
    expect(container.querySelector('[data-inbox-ci-held]')).toBeNull();
  });
});

/**
 * S-25.15 part B (backlog 1360): a task stopped for a person (`needs_human`) is a row of its own
 * section — why it waits in short form, where it is, when it stopped — and the whole row opens the
 * task; nothing is decided here. A stopped task that also has a question is that question's row,
 * once, and the frame's badge counts what the page lists.
 */
describe('a task stopped for a person', () => {
  const VOJTECH = 'Vojtěch Kaizr';
  const STOPPED_TASK = '00000000-0000-4000-8000-0000000000c3';
  const escalated = (
    overrides: Partial<InboxResponse['escalated'][number]> = {},
  ): InboxResponse['escalated'][number] => ({
    task_id: STOPPED_TASK,
    project_id: PROJECT,
    ticket: { provider: 'jira-cloud', key: 'AUT-6676', url: 'https://tickets.example.invalid/A' },
    ticket_title: 'Export invoices as CSV',
    current_stage: 'refinement',
    reason: 'ticket_assigned_elsewhere',
    at: '2026-09-29T07:05:00.000Z',
    tracker_assignee: { display_name: VOJTECH, user_id: null },
    unlinked_assignee: { display_name: VOJTECH },
    ...overrides,
  });

  const renderStopped = async (fetchImpl: typeof fetch): Promise<HTMLElement> => {
    const { container } = render(createApp({ fetchImpl, realtime: false, now: () => NOW }).element);
    await screen.findByRole('list', { name: 'Stopped, waiting for a person' });
    return container;
  };

  const stopOf = (container: HTMLElement, taskId = STOPPED_TASK): HTMLElement | null =>
    container.querySelector<HTMLElement>(`[data-inbox-escalated="${taskId}"]`);

  it('names whose ticket it is, where it is and when it stopped, and the whole row opens the task', async () => {
    inbox = { questions: [], approvals: [], ci_held: [], escalated: [escalated()] };
    const container = await renderStopped(fakeServer().fetchImpl);
    const stop = stopOf(container);
    expect(stop?.textContent).toBe(`Waiting for: ${VOJTECH}’s Jira ticket`);
    expect(stop?.getAttribute('data-inbox-stop')).toBe('held_elsewhere');
    const row = stop?.closest('li') as HTMLElement;
    await waitFor(() => {
      expect(row.querySelector('[data-inbox-where]')?.textContent).toBe('acme·AUT-6676·Refinement');
    });
    expect(row.textContent).toContain('stopped 2 h ago');
    // One link, the row's stretched one, to the task — and no command in the row (M25).
    const links = [...row.querySelectorAll('a')];
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute('href')).toBe(`/tasks/${STOPPED_TASK}`);
    expect(links[0]?.hasAttribute(ROW_LINK_ATTRIBUTE)).toBe(true);
    expect(links[0]?.textContent).toBe('Open AUT-6676');
    expect(row.querySelectorAll('button')).toHaveLength(0);
    // Only the stopped section: the questions' list says nothing about an empty filter.
    expect(screen.queryByRole('list', { name: 'Waiting for you' })).toBeNull();
    expect(screen.queryByText('Nothing needs you')).toBeNull();
  });

  it('says a Jira ticket someone else holds when the platform knows no name', async () => {
    inbox = {
      questions: [],
      approvals: [],
      ci_held: [],
      escalated: [
        escalated({
          tracker_assignee: { display_name: null, user_id: null },
          unlinked_assignee: { display_name: null },
        }),
      ],
    };
    const container = await renderStopped(fakeServer().fetchImpl);
    expect(stopOf(container)?.textContent).toBe('Waiting for: a Jira ticket someone else holds');
    expect(stopOf(container)?.getAttribute('data-inbox-stop')).toBe('held_nameless');
  });

  it('renders the name as text, never markup (BD-022)', async () => {
    const name = 'Jan <img src=x onerror=alert(1)>';
    inbox = {
      questions: [],
      approvals: [],
      ci_held: [],
      escalated: [
        escalated({
          tracker_assignee: { display_name: name, user_id: null },
          unlinked_assignee: { display_name: name },
        }),
      ],
    };
    const container = await renderStopped(fakeServer().fetchImpl);
    expect(stopOf(container)?.textContent).toBe(`Waiting for: ${name}’s Jira ticket`);
    expect(container.querySelector('main img')).toBeNull();
  });

  it('words another reason key the platform words, and a sentence as Needs a person', async () => {
    const SENTENCE_TASK = '00000000-0000-4000-8000-0000000000c4';
    inbox = {
      questions: [],
      approvals: [],
      ci_held: [],
      escalated: [
        escalated({ reason: 'converged' }),
        escalated({
          task_id: SENTENCE_TASK,
          ticket: {
            provider: 'jira-cloud',
            key: 'AUT-7',
            url: 'https://tickets.example.invalid/B',
          },
          reason: 'stage "refinement" rejected the task',
          current_stage: 'code_review',
        }),
      ],
    };
    const container = await renderStopped(fakeServer().fetchImpl);
    expect(stopOf(container)?.textContent).toBe('The same failure repeated');
    expect(stopOf(container)?.getAttribute('data-inbox-stop')).toBe('worded');
    const generic = stopOf(container, SENTENCE_TASK);
    // The reason's own sentence is never the row: the stage is in the meta line already.
    expect(generic?.textContent).toBe('Needs a person');
    expect(generic?.getAttribute('data-inbox-stop')).toBe('generic');
    expect(generic?.closest('li')?.querySelector('[data-inbox-where]')?.textContent).toBe(
      'acme·AUT-7·Code review',
    );
  });

  it('lists a stopped task with a question once — as the question — and counts what it lists', async () => {
    inbox = {
      questions: [question({ task_id: STOPPED_TASK })],
      approvals: [],
      ci_held: [],
      escalated: [escalated(), escalated({ task_id: OTHER_TASK, reason: 'undecided' })],
    };
    const container = await renderInbox(fakeServer().fetchImpl);
    await screen.findByRole('list', { name: 'Stopped, waiting for a person' });
    // The question's task is not a second row; the other stopped task is.
    expect(stopOf(container)).toBeNull();
    expect(stopOf(container, OTHER_TASK)?.textContent).toBe('The check couldn’t decide');
    const filters = screen.getByRole('navigation', { name: 'Inbox filters' });
    const button = (name: RegExp) => within(filters).getByRole('button', { name });
    expect(button(/^All/).textContent).toContain('2');
    expect(button(/^Stopped/).textContent).toContain('1');
    // The frame's badge: the same two rows (`inboxRows`), not three.
    await waitFor(() => {
      expect(document.querySelector('[data-inbox-count]')?.getAttribute('data-inbox-count')).toBe(
        '2',
      );
    });
  });

  it('filters to the stopped tasks, and keeps them out of Questions', async () => {
    inbox = { questions: [question()], approvals: [], ci_held: [], escalated: [escalated()] };
    const container = await renderInbox(fakeServer({ [OTHER_TASK]: 'ACME-12' }).fetchImpl);
    const filters = screen.getByRole('navigation', { name: 'Inbox filters' });
    const button = (name: RegExp) => within(filters).getByRole('button', { name });
    const user = userEvent.setup();
    await user.click(button(/^Questions/));
    expect(stopOf(container)).toBeNull();
    expect(screen.getByText('Should the retry budget be three or five?')).toBeTruthy();
    await user.click(button(/^Stopped/));
    expect(stopOf(container)).not.toBeNull();
    expect(screen.queryByText('Should the retry budget be three or five?')).toBeNull();
    expect(screen.queryByRole('list', { name: 'Waiting for you' })).toBeNull();
  });
});

/**
 * The shared helper both rows print their time with (S-27.1): a question's deadline is a due time,
 * and an approval — passed no deadline — says who it waits for, with no *due*, *expires* or *until*
 * clause.
 */
describe('timeLine', () => {
  it('prints a question’s due time', () => {
    const line = timeLine('asked', '2026-09-29T09:00:00.000Z', DUE, NOW);
    expect(line).toBe(`asked 5 m ago · due ${formatDateTime(DUE)}`);
  });

  it('prints an approval with a null deadline as waiting for a maintainer, and nothing due', () => {
    const line = timeLine(
      'requested',
      '2026-09-29T09:00:00.000Z',
      null,
      NOW,
      'waits for a maintainer',
    );
    expect(line).toBe('requested 5 m ago · waits for a maintainer');
    expect(line).not.toMatch(/due|expire|until/);
  });

  it('prints a question with no deadline with neither', () => {
    expect(timeLine('asked', '2026-09-29T09:00:00.000Z', null, NOW)).toBe('asked 5 m ago');
  });
});

/**
 * The task page as a pull request page (S-23.9b, research/19 § 5.2 "Task"): the header and its one
 * primary action, the needs-you callout, the tabs in `?tab=`, the merge box's summary and the cost
 * meter.
 *
 * Driven through `createApp` with a fake server, as `checks-panel.test.tsx` is: the real router (so
 * the routes' `taskSearchSchema` is in the path), the real query client and the real endpoint
 * parsers. The commands are asserted by what the request carried.
 */
import type { TaskDetailResponse, TaskRecord } from '@platform/contracts';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';
import { checksSummary, dependencyStatus, gateStatus, tamperStatus } from './task-checks-text.js';
import { taskPrimaryAction } from './task-header.js';
import { currentTaskTab, taskSearchSchema, taskTabSearch } from './task-tab.js';

const PROJECT = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-0000000000b1';
const QUESTION = '00000000-0000-4000-8000-0000000000c1';
const APPROVAL = '00000000-0000-4000-8000-0000000000c2';
const ARTIFACT = '00000000-0000-4000-8000-0000000000d1';
const AT = '2026-09-13T04:00:00.000Z';
const HOSTILE = '<img src=x onerror=alert(1)>';

const SESSION: SessionResponse = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'operator@example.invalid',
    name: 'Fake Operator',
    role: 'admin',
  },
  session: { id: '00000000-0000-4000-8000-000000000002' },
};

const TASK_ROW: TaskRecord = {
  id: TASK,
  project_id: PROJECT,
  ticket: { provider: 'jira', key: 'ACME-12', url: 'https://jira.example.test/browse/ACME-12' },
  ticket_title: 'Add VAT to invoices',
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
  review_threads: null,
  dependencies: null,
  conflict: null,
  required_reviewers: null,
  cost_actual_usd: 1.2,
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
};

type StageRow = TaskDetailResponse['stages'][number];

const stage = (
  name: string,
  attempt: number,
  state: StageRow['state'],
  outcome: StageRow['outcome'],
): StageRow => ({
  stage: name,
  attempt,
  state,
  entered_at: AT,
  exited_at: state === 'running' ? null : AT,
  outcome,
});

const detail = (over: Partial<TaskDetailResponse> = {}, task: Partial<TaskRecord> = {}) =>
  ({
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
    gate_feedback: null,
    human_time: {
      total_minutes: 0,
      by_kind: { review: 0, question: 0, approval: 0, steer: 0 },
      by_user: null,
      entries: 0,
      withheld: { entries: 0, minutes: 0 },
    },
    stages: [
      stage('refinement', 1, 'completed', 'approve'),
      stage('implementation', 1, 'running', null),
    ],
    artifacts: [],
    questions: [],
    approvals: [],
    runs: [],
    ...over,
  }) satisfies TaskDetailResponse;

const QUESTION_ROW: TaskDetailResponse['questions'][number] = {
  id: QUESTION,
  task_id: TASK,
  stage: 'implementation',
  text: `Should the rate table be ${HOSTILE} per country?`,
  options: null,
  blocking: true,
  status: 'open',
  asked_at: AT,
  reminders_sent: 0,
  answered_at: null,
  answer: null,
};

const APPROVAL_ROW: TaskDetailResponse['approvals'][number] = {
  id: APPROVAL,
  task_id: TASK,
  kind: 'plan',
  status: 'pending',
  requested_at: AT,
  decided_at: null,
  reason: null,
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Sent {
  readonly path: string;
  readonly body: unknown;
}

const start = (task: TaskDetailResponse, at = `/tasks/${TASK}`) => {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const path = new URL(url, 'http://localhost').pathname;
    if (url.includes('/api/auth/get-session')) return json(SESSION);
    if (init?.method === 'POST') {
      sent.push({ path, body: JSON.parse(String(init.body ?? '{}')) });
      return json({
        task_id: TASK,
        state: 'active',
        current_stage: 'implementation',
        performed: true,
      });
    }
    if (path === `/api/artifacts/${ARTIFACT}`) {
      return json({
        id: ARTIFACT,
        task_id: TASK,
        artifact_type: 'ImplementationPlan',
        version: 2,
        schema_version: '1',
        produced_by_run_id: null,
        created_at: AT,
        redaction_count: 1,
        markdown: null,
        data: { summary: HOSTILE },
      });
    }
    if (path === `/api/tasks/${TASK}`) return json(task);
    if (path === '/api/projects') return json({ items: [] });
    // A command refreshes the inbox too; answered, so the next command is not held behind retries.
    if (path === '/api/org/inbox') return json({ questions: [], approvals: [] });
    // Every read a command's refresh re-asks is answered (never left to retry), so a second command
    // is not held disabled behind the first one's refresh.
    if (path === `/api/tasks/${TASK}/asks`) return json({ items: [] });
    if (path === `/api/tasks/${TASK}/pipeline`) {
      return json({ error: { code: 'not_found', message: 'no graph in this fake' } }, 404);
    }
    if (path.startsWith(`/api/tasks/${TASK}/`)) return json({ items: [], next_cursor: null });
    return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
  }) as typeof fetch;
  window.history.pushState({}, '', at);
  const view = render(createApp({ fetchImpl, realtime: false }).element);
  return { view, sent };
};

/** The beacon-toned buttons in the page (never a dialog's, which is outside `main`). */
const primaries = (): string[] =>
  [...document.querySelectorAll('main button, main a')]
    .filter((element) => element.className.includes('border-primary-line'))
    .map((element) => element.textContent ?? '');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('the header', () => {
  it('titles the page with the ticket’s own words, as text, the key muted beside them', async () => {
    start(detail({}, { ticket_title: `Add VAT ${HOSTILE}` }));
    const heading = await screen.findByRole('heading', { level: 1 });
    await waitFor(() => {
      expect(heading.textContent).toBe(`Add VAT ${HOSTILE} ACME-12`);
    });
    expect(heading.querySelector('img')).toBeNull();
    // The state in words beside an icon, and one meta line.
    expect(document.querySelector('[data-state-label="running"]')?.textContent).toBe('Active');
    const main = screen.getByRole('main');
    expect(main.textContent).toContain('Feature');
    expect(main.textContent).toContain('· Implementation');
    expect(main.textContent).toContain('· $1.20 so far');
    expect(within(main).getByRole('list', { name: 'Pipeline stages' })).toBeTruthy();
  });

  it('shows the key alone when the ticket’s title was never read', async () => {
    start(detail({}, { ticket_title: null }));
    const heading = await screen.findByRole('heading', { level: 1 });
    await waitFor(() => {
      expect(heading.textContent).toBe('ACME-12');
    });
  });
});

/**
 * research/19 § 3 item 1: one primary action per view, chosen by the state — and none for a task
 * nothing waits on. Counted over the rendered page, so a second beacon anywhere fails.
 */
describe('one primary action per state', () => {
  const cases: readonly [string, TaskDetailResponse, readonly string[]][] = [
    ['an open question', detail({ questions: [QUESTION_ROW] }), ['Answer']],
    [
      'a pending approval',
      detail({ approvals: [APPROVAL_ROW] }, { state: 'waiting_approval' }),
      ['Approve…'],
    ],
    ['a paused task', detail({}, { state: 'paused', paused_reason: 'manual' }), ['Resume']],
    [
      'a task its own cap paused, for a caller who may raise it',
      detail(
        { can_raise_budget: true },
        { state: 'paused', paused_reason: 'budget', paused_budget_scope: 'task' },
      ),
      ["Raise this task's cap…"],
    ],
    [
      'a task its own cap paused, for a caller who may not',
      detail(
        { can_raise_budget: false },
        { state: 'paused', paused_reason: 'budget', paused_budget_scope: 'task' },
      ),
      ['Resume'],
    ],
    ['an escalated task', detail({}, { state: 'needs_human' }), ['Resume']],
    ['a running task', detail(), []],
  ];

  it.each(cases)('%s', async (_name, task, expected) => {
    start(task);
    await screen.findByRole('heading', { level: 1 });
    await screen.findByText('Checks');
    await waitFor(() => {
      expect(primaries()).toEqual(expected);
    });
  });

  it('picks the holder, then the question, then the approval, then a resume', () => {
    const base = {
      state: 'needs_human' as const,
      canHandBack: true,
      openQuestions: 1,
      pendingApprovals: 1,
    };
    expect(taskPrimaryAction(base)).toBe('hand_back');
    expect(taskPrimaryAction({ ...base, canHandBack: false })).toBe('answer');
    expect(taskPrimaryAction({ ...base, canHandBack: false, openQuestions: 0 })).toBe('approve');
    expect(
      taskPrimaryAction({ ...base, canHandBack: false, openQuestions: 0, pendingApprovals: 0 }),
    ).toBe('resume');
    expect(
      taskPrimaryAction({
        state: 'active',
        canHandBack: false,
        openQuestions: 0,
        pendingApprovals: 0,
      }),
    ).toBeNull();
  });
});

describe('the needs-you callout', () => {
  it('answers a question inline, and the header’s Answer moves focus into its box', async () => {
    const user = userEvent.setup();
    const { sent } = start(detail({ questions: [QUESTION_ROW] }, { state: 'waiting_answers' }));
    const callout = await screen.findByRole('region', { name: 'Needs you' });
    // The agent's question is text, markup and all (BD-022).
    expect(callout.textContent).toContain(HOSTILE);
    expect(callout.querySelector('img')).toBeNull();

    const actions = document.querySelector('[data-page-actions]') as HTMLElement;
    await user.click(within(actions).getByRole('button', { name: 'Answer' }));
    const box = within(callout).getByLabelText(`Answer question ${QUESTION}`);
    expect(document.activeElement).toBe(box);

    await user.type(box, 'per country');
    await user.click(within(callout).getByRole('button', { name: 'Answer' }));
    await waitFor(() => {
      expect(sent.map((entry) => entry.path)).toEqual([
        `/api/tasks/${TASK}/questions/${QUESTION}/answer`,
      ]);
    });
    expect(sent[0]?.body).toEqual({ answer: 'per country' });
  });

  it('decides an approval inline, and through the header’s dialog with a reason', async () => {
    const user = userEvent.setup();
    const { sent } = start(detail({ approvals: [APPROVAL_ROW] }, { state: 'waiting_approval' }));
    const callout = await screen.findByRole('region', { name: 'Needs you' });
    expect(callout.textContent).toContain('The plan approval is waiting for you');
    await user.click(within(callout).getByRole('button', { name: 'Approve' }));
    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]).toEqual({
      path: `/api/tasks/${TASK}/approvals/${APPROVAL}/decide`,
      body: { decision: 'approve' },
    });

    await user.click(screen.getByRole('button', { name: 'Approve…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Plan approval' });
    await user.type(within(dialog).getByLabelText('Decision reason (optional)'), 'too wide');
    await user.click(within(dialog).getByRole('button', { name: 'Reject' }));
    await waitFor(() => {
      expect(sent).toHaveLength(2);
    });
    expect(sent[1]?.body).toEqual({ decision: 'reject', reason: 'too wide' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('says what stopped an escalated task, in the row’s own recorded word', async () => {
    start(
      detail(
        {
          stages: [
            stage('implementation', 1, 'completed', 'approve'),
            stage('ci_gate', 1, 'failed', 'undecided'),
          ],
        },
        { state: 'needs_human', current_stage: 'ci_gate' },
      ),
    );
    const callout = await screen.findByRole('region', { name: 'Needs you' });
    expect(callout.textContent).toContain('This task needs a person');
    expect(callout.querySelector('[data-escalation-reason]')?.textContent).toBe(
      'Needs you: the gate could not decide in its allotted checks.',
    );
  });

  it('states a budget pause, and where the cap that stopped it is raised', async () => {
    start(detail({}, { state: 'paused', paused_reason: 'budget', paused_budget_scope: 'project' }));
    const callout = await screen.findByRole('region', { name: 'Needs you' });
    expect(callout.textContent).toContain('This task is paused for its budget');
    expect(callout.querySelector('[data-budget-reason]')?.textContent).toContain(
      'where that cap is set',
    );
    // The state is drawn as needing a person, with the state's own word.
    expect(document.querySelector('[data-state-label="needs_you"]')?.textContent).toBe('Paused');
  });

  it('is not drawn for a task nothing waits on, nor for a pause a person made', async () => {
    start(detail({}, { state: 'paused', paused_reason: 'manual' }));
    await screen.findByText('Checks');
    expect(screen.queryByRole('region', { name: 'Needs you' })).toBeNull();
    expect(document.querySelector('[data-state-label="paused"]')?.textContent).toBe('Paused');
  });

  it('is not drawn for a task nothing waits on', async () => {
    start(detail());
    await screen.findByText('Checks');
    expect(screen.queryByRole('region', { name: 'Needs you' })).toBeNull();
  });
});

describe('the ··· menu', () => {
  it('pauses directly and cancels through a dialog that says what cancelling does', async () => {
    const user = userEvent.setup();
    const { sent } = start(detail());
    await user.click(await screen.findByRole('button', { name: 'Task actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Pause' }));
    await waitFor(() => {
      expect(sent.map((entry) => entry.path)).toEqual([`/api/tasks/${TASK}/pause`]);
    });

    await user.click(screen.getByRole('button', { name: 'Task actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Cancel task…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel this task?' });
    // Nothing is sent by opening it.
    expect(sent).toHaveLength(1);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel task' }));
    await waitFor(() => {
      expect(sent.map((entry) => entry.path)).toEqual([
        `/api/tasks/${TASK}/pause`,
        `/api/tasks/${TASK}/cancel`,
      ]);
    });
  });

  const menuItems = async (task: TaskDetailResponse): Promise<string[]> => {
    const user = userEvent.setup();
    start(task);
    await user.click(await screen.findByRole('button', { name: 'Task actions' }));
    const menu = await screen.findByRole('menu');
    return within(menu)
      .getAllByRole('menuitem')
      .map((item) => item.textContent ?? '');
  };

  it.each([
    [
      'a queued task: no pause or take-over',
      { state: 'queued' as const },
      ['Pause', 'Take over…'],
      'Cancel task…',
    ],
    [
      'a task a person paused: no take-over',
      { state: 'paused' as const, paused_reason: 'manual' as const },
      ['Take over…', 'Pause', 'Resume'],
      'Cancel task…',
    ],
    ['a merged task: no cancel', { state: 'merged' as const }, ['Cancel task…'], 'Retry stage…'],
    [
      'a task in its retrospective: no cancel',
      { state: 'retro' as const },
      ['Cancel task…'],
      'Retry stage…',
    ],
  ])('%s', async (_name, task, absent, present) => {
    const items = await menuItems(detail({}, task));
    expect(items).toContain(present);
    for (const item of absent) {
      expect(items).not.toContain(item);
    }
  });

  it('offers both on a running task, the control of the cases above', async () => {
    const items = await menuItems(detail());
    expect(items).toEqual(
      expect.arrayContaining([
        'Pause',
        'Take over…',
        'Return to stage…',
        'Rework…',
        'Cancel task…',
      ]),
    );
  });

  it('offers no return or rework once the task was merged', async () => {
    const items = await menuItems(
      detail(
        {
          stages: [
            stage('merged_gate', 1, 'completed', 'pass'),
            stage('retrospective', 1, 'failed', 'escalated'),
          ],
        },
        { state: 'needs_human', current_stage: 'retrospective' },
      ),
    );
    expect(items).toContain('Retry stage…');
    expect(items).not.toContain('Return to stage…');
    expect(items).not.toContain('Rework…');
  });

  it('offers no stage command for a task that has entered no stage', async () => {
    const user = userEvent.setup();
    start(detail({ stages: [] }, { state: 'queued', current_stage: null }));
    await user.click(await screen.findByRole('button', { name: 'Task actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Cancel task…' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Retry stage…' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Return to stage…' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Rework…' })).toBeNull();
  });
});

/**
 * S-23.23 (the UX audit's item 3): the page offers only what the caller's role may do. The flags are
 * the server's — each the command route's own permission (`apps/server/src/routes/tasks.ts`) — and
 * a control whose flag is false is not drawn.
 */
describe('only what the caller may do', () => {
  /** A member of the task's project: pause and resume, nothing a maintainer decides. */
  const MEMBER = {
    can_pause: true,
    can_resume: true,
    can_cancel: false,
    can_return: false,
    can_rework: false,
    can_decide_approval: false,
  } as const;
  const VIEWER = { ...MEMBER, can_pause: false, can_resume: false } as const;

  const menuOf = async (task: TaskDetailResponse): Promise<string[]> => {
    const user = userEvent.setup();
    start(task);
    await user.click(await screen.findByRole('button', { name: 'Task actions' }));
    return within(await screen.findByRole('menu'))
      .getAllByRole('menuitem')
      .map((item) => item.textContent ?? '');
  };

  it('offers a member no cancel, return or rework in the menu', async () => {
    const items = await menuOf(detail(MEMBER));
    expect(items).toContain('Pause');
    expect(items).toContain('Retry stage…');
    for (const absent of ['Cancel task…', 'Return to stage…', 'Rework…']) {
      expect(items).not.toContain(absent);
    }
  });

  it('offers a viewer no pause, and no Resume as the page’s primary action', async () => {
    const running = await menuOf(detail(VIEWER));
    expect(running).not.toContain('Pause');
    cleanup();
    start(detail(VIEWER, { state: 'paused', paused_reason: 'manual' }));
    await screen.findByText('Checks');
    await waitFor(() => {
      expect(primaries()).toEqual([]);
    });
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
  });

  it('tells a member a maintainer decides the approval, with no Approve or Reject to press', async () => {
    start(detail({ ...MEMBER, approvals: [APPROVAL_ROW] }, { state: 'waiting_approval' }));
    const callout = await screen.findByRole('region', { name: 'Needs you' });
    expect(callout.querySelector('[data-may-not-decide]')?.textContent).toBe(
      'A maintainer decides this.',
    );
    expect(within(callout).queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(within(callout).queryByRole('button', { name: 'Reject…' })).toBeNull();
    // …and *Approve…* is not the header's primary for them.
    expect(primaries()).not.toContain('Approve…');
  });

  it('offers a member who handles an escalation only the retry, and says who sends it back', async () => {
    start(detail(MEMBER, { state: 'needs_human' }));
    const callout = await screen.findByRole('region', { name: 'Needs you' });
    expect(within(callout).getByRole('button', { name: 'Retry stage…' })).toBeTruthy();
    expect(within(callout).queryByRole('button', { name: 'Return to stage…' })).toBeNull();
    expect(within(callout).queryByRole('button', { name: 'Rework…' })).toBeNull();
    expect(callout.textContent).toContain('is a maintainer’s decision');
  });
});

/** S-23.23 (the UX audit's item 8): a reject from the callout asks first, as the header's does. */
describe('the callout’s reject', () => {
  it('opens a confirmation that says what rejecting the plan does, and sends the reason typed', async () => {
    const user = userEvent.setup();
    const { sent } = start(detail({ approvals: [APPROVAL_ROW] }, { state: 'waiting_approval' }));
    const callout = await screen.findByRole('region', { name: 'Needs you' });
    await user.click(within(callout).getByRole('button', { name: 'Reject…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reject the plan approval?' });
    expect(dialog.textContent).toContain('goes back to Architecture with your reason');
    expect(sent).toEqual([]);
    await user.type(
      within(dialog).getByLabelText('Reason (recorded with the decision)'),
      'split the migration',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Reject' }));
    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]).toEqual({
      path: `/api/tasks/${TASK}/approvals/${APPROVAL}/decide`,
      body: { decision: 'reject', reason: 'split the migration' },
    });
  });
});

/** S-23.23 (the UX audit's § 2): a pressed *Good* or *Bad* is a toggle's state, not a beacon. */
describe('the feedback toggles', () => {
  it('keep the page at its one primary when pressed', async () => {
    const user = userEvent.setup();
    start(detail({}, { state: 'paused', paused_reason: 'manual' }));
    await waitFor(() => {
      expect(primaries()).toEqual(['Resume']);
    });
    const good = (await screen.findAllByRole('button', { name: 'Good' }))[0] as HTMLElement;
    await user.click(good);
    expect(good.getAttribute('aria-pressed')).toBe('true');
    expect(primaries()).toEqual(['Resume']);
  });
});

describe('the tabs', () => {
  const tabs = () => screen.getByRole('navigation', { name: 'Task' });
  const current = () =>
    within(tabs())
      .getAllByRole('link')
      .find((link) => link.getAttribute('aria-current') === 'page')?.textContent;
  const WITH_ARTIFACT = detail({
    artifacts: [{ id: ARTIFACT, artifact_type: 'ImplementationPlan', version: 2, url: null }],
  });

  it('opens on the Overview, and moves to a tab through ?tab=', async () => {
    const user = userEvent.setup();
    start(WITH_ARTIFACT);
    await screen.findByRole('navigation', { name: 'Task' });
    expect(current()).toBe('Overview');
    expect(screen.getByText('Stage timeline')).toBeTruthy();
    // The counts are the task's own.
    expect(within(tabs()).getByRole('link', { name: /Artifacts/ }).textContent).toBe('Artifacts1');

    await user.click(within(tabs()).getByRole('link', { name: /Activity/ }));
    await waitFor(() => {
      expect(window.location.search).toBe('?tab=activity');
    });
    expect(current()).toBe('Activity');
    expect(await screen.findByText('Who did what')).toBeTruthy();
    expect(screen.queryByText('Stage timeline')).toBeNull();
  });

  it('selects Artifacts for ?artifact=, renders the body as text with the raw JSON behind Details', async () => {
    const user = userEvent.setup();
    start(WITH_ARTIFACT, `/tasks/${TASK}?artifact=${ARTIFACT}`);
    const article = await screen.findByRole('article', { name: 'Artifact' });
    expect(current()).toBe('Artifacts1');
    expect(article.textContent).toContain('1 redaction');
    const raw = article.querySelector('details');
    expect(raw?.querySelector('summary')?.textContent).toBe('Raw JSON');
    // No prose of its own, so the JSON is open; and it is characters, not markup.
    expect(raw?.open).toBe(true);
    expect(raw?.textContent).toContain(HOSTILE);
    expect(article.querySelector('img')).toBeNull();

    // Back to the Overview drops the artifact, or it would select Artifacts again.
    await user.click(within(tabs()).getByRole('link', { name: 'Overview' }));
    await waitFor(() => {
      expect(window.location.search).toBe('');
    });
    expect(current()).toBe('Overview');
  });

  it('opens the Overview for a tab it does not know, rather than an error', async () => {
    start(WITH_ARTIFACT, `/tasks/${TASK}?tab=nonsense`);
    await screen.findByRole('navigation', { name: 'Task' });
    expect(current()).toBe('Overview');
  });

  it('reads and writes the search the way the routes validate it', () => {
    expect(taskSearchSchema.parse({ tab: 'runs' })).toEqual({ tab: 'runs' });
    expect(taskSearchSchema.parse({ tab: 'nonsense', artifact: 'a' })).toEqual({
      tab: undefined,
      artifact: 'a',
    });
    expect(currentTaskTab({ tab: 'runs', artifact: 'a' }, ['a'])).toBe('artifacts');
    // An artifact the task does not have selects nothing.
    expect(currentTaskTab({ tab: 'runs', artifact: 'gone' }, ['a'])).toBe('runs');
    expect(currentTaskTab({}, [])).toBe('overview');
    expect(taskTabSearch({ artifact: 'a', tab: 'runs' }, 'overview')).toEqual({
      artifact: undefined,
      tab: undefined,
    });
    expect(taskTabSearch({ artifact: 'a' }, 'artifacts')).toEqual({
      artifact: 'a',
      tab: 'artifacts',
    });
  });
});

describe('the merge box', () => {
  it('says every required check passes only when every one did', async () => {
    const passed = detail(
      {
        stages: [
          stage('ci_gate', 1, 'completed', 'protected_paths_clean'),
          stage('rebase_gate', 1, 'completed', 'pass'),
        ],
      },
      {
        state: 'ready_for_merge',
        current_stage: 'ready_for_merge',
        review_threads: { open: 0, resolved: 2, checked_at: AT },
        dependencies: {
          head_sha: 'b'.repeat(40),
          decision: 'allow',
          added: [],
          unread: [],
          truncated: false,
          question_id: null,
          checked_at: AT,
        },
      },
    );
    start(passed);
    const summary = await screen.findByText(/required check/);
    // No Acceptance Verdict: two required rows are not decided, so the box does not say *pass*.
    expect(summary.textContent).toBe('2 required checks are not decided yet');
    expect(screen.getByRole('list', { name: 'Merge-readiness checks' }).children).toHaveLength(13);
  });

  it('counts what needs a person first', async () => {
    start(
      detail({ questions: [QUESTION_ROW], stages: [stage('ci_gate', 1, 'returned', 'returned')] }),
    );
    expect((await screen.findByText(/need you/)).textContent).toBe('2 checks need you');
  });

  it('draws the cost against the cap as a meter, with no inline style', async () => {
    start(detail());
    await screen.findByText('Cost so far');
    const meter = screen.getByRole('meter', { name: "Spent of this task's cap" });
    expect(meter.getAttribute('value')).toBe('1.2');
    expect(meter.getAttribute('max')).toBe('5');
    expect(meter.hasAttribute('style')).toBe(false);
    expect(screen.getByText('$1.20 of $5.00 cap')).toBeTruthy();
  });

  it('never reads an undecided or unrecorded row as a pass', () => {
    expect(gateStatus(null)).toBe('queued');
    expect(gateStatus(stage('ci_gate', 1, 'running', null))).toBe('running');
    expect(gateStatus(stage('ci_gate', 1, 'completed', 'pass'))).toBe('success');
    expect(gateStatus(stage('ci_gate', 1, 'completed', 'fail'))).toBe('failure');
    expect(gateStatus(stage('ci_gate', 1, 'failed', 'undecided'))).toBe('needs_you');
    expect(gateStatus(stage('ci_gate', 1, 'returned', 'escalated'))).toBe('waiting');
    // *not recorded* is skipped, *clean* passes, a declared change waits for its confirmation.
    expect(tamperStatus(stage('ci_gate', 1, 'completed', 'pass'))).toBe('skipped');
    expect(tamperStatus(stage('ci_gate', 1, 'completed', 'protected_paths_clean'))).toBe('success');
    expect(tamperStatus(stage('ci_gate', 1, 'completed', 'protected_paths_awaiting_review'))).toBe(
      'waiting',
    );
    expect(
      tamperStatus(
        stage('ci_gate', 1, 'completed', 'protected_paths_awaiting_review'),
        stage('rebase_gate', 1, 'completed', 'protected_paths_confirmed'),
      ),
    ).toBe('success');
    expect(dependencyStatus(null)).toBe('queued');
    expect(
      checksSummary([
        { status: 'success', required: true },
        { status: 'skipped', required: true },
      ]),
    ).toEqual({ status: 'waiting', text: '1 required check is not decided yet' });
    expect(
      checksSummary([
        { status: 'success', required: true },
        { status: 'queued', required: false },
      ]),
    ).toEqual({ status: 'success', text: 'All required checks pass' });
    expect(checksSummary([{ status: 'needs_you', required: false }]).text).toBe(
      '1 check needs you',
    );
  });
});

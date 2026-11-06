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
import {
  CHECKS_CALLOUT_POINTER,
  checksSummary,
  dependencyStatus,
  gateStatus,
  tamperStatus,
} from './task-checks-text.js';
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

/** The plan the approval is about (S-25.1): model output, hostile text in its fields (BD-022). */
const PLAN = '00000000-0000-4000-8000-0000000000d2';
const PLAN_DATA = {
  approach: `Add a VAT column ${HOSTILE} and round once, at the boundary.`,
  alternatives_considered: [{ option: 'compute VAT on read', why_not: 'slow on large invoices' }],
  affected_modules: ['invoices'],
  files_to_change: [
    { path: 'src/invoice.ts', change: `round once ${HOSTILE}` },
    { path: 'src/vat.ts', change: 'the rate table' },
  ],
  data_changes: ['add invoices.vat_cents'],
  api_changes: [],
  validation_contract: [],
  test_plan: ['a rounding property test'],
  rollout_notes: '',
  risks: ['rounding drift on old invoices'],
  estimated_size: 'L',
  split_proposal: null,
  decisions_to_record: [],
  protected_path_changes: [],
};

const PLAN_SUBJECT = {
  kind: 'plan' as const,
  artifact_id: PLAN,
  artifact_version: 2,
  stage: 'architecture',
  attempt: 1,
  basis: 'recorded' as const,
};

const APPROVAL_ROW: TaskDetailResponse['approvals'][number] = {
  id: APPROVAL,
  task_id: TASK,
  kind: 'plan',
  status: 'pending',
  requested_at: AT,
  decided_at: null,
  reason: null,
  subject: PLAN_SUBJECT,
  reasons: [
    { code: 'probation', completed: 2, of: 5 },
    { code: 'size_at_or_above', size: 'L', threshold: 'L', source: 'dial' },
  ],
};

const PLAN_REF = { id: PLAN, artifact_type: 'ImplementationPlan' as const, version: 2, url: null };

const PROJECT_ROW = {
  id: PROJECT,
  key: 'acme',
  name: 'Acme',
  repo_url: 'https://git.example.invalid/acme/acme.git',
  default_branch: 'main',
  agentic_dir: '.agentic',
  knowledge_dir: 'knowledge',
  autonomy_level: 'supervised',
  readiness_level: 2,
  status: 'active',
  created_at: AT,
  updated_at: AT,
  open_tasks: 1,
  spent_usd_30d: 1,
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Sent {
  readonly path: string;
  readonly body: unknown;
}

const start = (
  task: TaskDetailResponse,
  at = `/tasks/${TASK}`,
  projects: readonly unknown[] = [],
  /** A read answered differently, by its path. */
  answers: Readonly<Record<string, () => Response>> = {},
) => {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const path = new URL(url, 'http://localhost').pathname;
    if (url.includes('/api/auth/get-session')) return json(SESSION);
    const answer = init?.method === 'POST' ? undefined : answers[path];
    if (answer !== undefined) return answer();
    if (init?.method === 'POST') {
      sent.push({ path, body: JSON.parse(String(init.body ?? '{}')) });
      return json({
        task_id: TASK,
        state: 'active',
        current_stage: 'implementation',
        performed: true,
      });
    }
    if (path === `/api/artifacts/${PLAN}`) {
      return json({
        id: PLAN,
        task_id: TASK,
        artifact_type: 'ImplementationPlan',
        version: 2,
        schema_version: '1',
        produced_by_run_id: null,
        created_at: AT,
        redaction_count: 0,
        markdown: null,
        data: PLAN_DATA,
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
    if (path === '/api/projects') return json({ items: projects });
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

  it('reads Needs you, not Active, for an active task with an open question and an approval (S-25.4)', async () => {
    start(detail({ questions: [QUESTION_ROW], approvals: [APPROVAL_ROW] }, { state: 'active' }));
    await screen.findByRole('heading', { level: 1 });
    await waitFor(() => {
      expect(document.querySelector('[data-state-label="needs_you"]')?.textContent).toBe(
        'Needs you',
      );
    });
    expect(document.querySelector('[data-state-label="running"]')).toBeNull();
  });

  it('puts the ticket and merge request links in the header, beside the key (S-25.4)', async () => {
    start(
      detail(
        {},
        {
          mr_ref: {
            provider: 'gitlab',
            project_path: 'acme/api',
            iid: 7,
            url: 'https://git.example.invalid/acme/api/-/merge_requests/7',
          },
        },
      ),
    );
    await screen.findByRole('heading', { level: 1 });
    const links = document.querySelector('[data-task-links]') as HTMLElement;
    expect(within(links).getByRole('link', { name: 'Ticket' }).getAttribute('href')).toBe(
      TASK_ROW.ticket.url,
    );
    expect(within(links).getByRole('link', { name: 'Merge request' }).getAttribute('href')).toBe(
      'https://git.example.invalid/acme/api/-/merge_requests/7',
    );
    // Once: the right rail no longer repeats them at its bottom.
    expect(screen.getAllByRole('link', { name: 'Ticket' })).toHaveLength(1);
    expect(screen.getAllByRole('link', { name: 'Merge request' })).toHaveLength(1);
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
      ['Review plan'],
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

  /**
   * S-25.1 (research/21 F1, BD-006's 2026-11-06 amendment): the card shows **the plan it is about**,
   * open, beside the buttons; the reasons in words, each with how to stop being asked and a link to
   * the setting; what each answer does next. *Approve* echoes the plan it showed (TD-035).
   */
  it('shows the plan it approves, open, with why it was asked and what each answer does', async () => {
    const user = userEvent.setup();
    const { sent } = start(
      detail({ approvals: [APPROVAL_ROW], artifacts: [PLAN_REF] }, { state: 'waiting_approval' }),
      `/tasks/${TASK}`,
      [PROJECT_ROW],
    );
    const callout = await screen.findByRole('region', { name: 'Needs you' });
    expect(callout.textContent).toContain('The plan approval is waiting for you');
    const card = within(callout).getByRole('region', { name: 'Plan approval' });
    // The plan, read by the id the approval names, shown open — its hostile text as text (BD-022).
    await waitFor(() => {
      expect(card.querySelector('[data-approval-plan="parsed"]')).not.toBeNull();
    });
    expect(card.textContent).toContain(`Add a VAT column ${HOSTILE}`);
    expect(card.textContent).toContain('Size L');
    expect(card.textContent).toContain('2 files to change');
    expect(card.textContent).toContain('src/invoice.ts');
    expect(card.textContent).toContain('rounding drift on old invoices');
    expect(card.querySelector('img')).toBeNull();
    expect(card.textContent).toContain('Plan v2 · Architecture, attempt 1');
    const whole = within(card).getByText('Read the whole plan').closest('details');
    expect(whole?.open).toBe(true);
    expect(whole?.textContent).toContain('a rounding property test');
    // Why it was asked — every reason — and per reason how to stop being asked, linked.
    expect(card.querySelector('[data-approval-reason="probation"]')?.textContent).toContain(
      '2 of its first 5 tasks are done',
    );
    expect(card.querySelector('[data-approval-retire="probation"]')?.textContent).toContain(
      'Probation ends by itself after 5 completed tasks (3 to go)',
    );
    expect(card.querySelector('[data-approval-reason="size_at_or_above"]')?.textContent).toContain(
      'The plan’s size is L, at or above the project’s threshold of L.',
    );
    const links = within(card).getAllByRole('link', { name: 'Autonomy dial' });
    expect(links).toHaveLength(2);
    expect(links[0]?.getAttribute('href')).toBe('/projects/acme/settings/policies');
    // What each answer does next.
    const next = card.querySelector('[data-approval-next]')?.textContent ?? '';
    expect(next).toContain('Approve: Implementation starts on this plan.');
    expect(next).toContain('Reject: the plan goes back to Architecture with your reason.');
    // Not the page's beacon: the header's *Review plan* is its one primary.
    expect(primaries()).toEqual(['Review plan']);

    await user.click(within(card).getByRole('button', { name: 'Approve' }));
    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]).toEqual({
      path: `/api/tasks/${TASK}/approvals/${APPROVAL}/decide`,
      body: { decision: 'approve', subject_artifact_id: PLAN },
    });
  });

  it('opens the same card from the header’s Review plan, and has no second approve dialog', async () => {
    const user = userEvent.setup();
    start(detail({ approvals: [APPROVAL_ROW] }, { state: 'waiting_approval' }));
    const callout = await screen.findByRole('region', { name: 'Needs you' });
    const card = within(callout).getByRole('region', { name: 'Plan approval' });
    const actions = document.querySelector('[data-page-actions]') as HTMLElement;
    await user.click(within(actions).getByRole('button', { name: 'Review plan' }));
    expect(document.activeElement).toBe(card);
    // It moved the reader to the plan; it opened nothing that could approve without it.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(within(actions).queryByRole('button', { name: 'Approve…' })).toBeNull();
  });

  it('offers only a reject for a plan approval whose plan was not recorded, and says so', async () => {
    const { subject: _plan, reasons: _reasons, ...unrecorded } = APPROVAL_ROW;
    start(detail({ approvals: [unrecorded] }, { state: 'waiting_approval' }));
    const callout = await screen.findByRole('region', { name: 'Needs you' });
    const card = within(callout).getByRole('region', { name: 'Plan approval' });
    expect(card.querySelector('[data-approval-subject="not-recorded"]')?.textContent).toContain(
      'was not recorded',
    );
    expect(card.querySelector('[data-approval-reasons="not-recorded"]')).not.toBeNull();
    expect(within(card).queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(within(card).getByRole('button', { name: 'Reject…' })).toBeTruthy();
    expect(card.querySelector('[data-approval-next]')?.textContent).not.toContain('Approve:');
  });

  it('offers only a reject when a newer plan than the one asked about exists', async () => {
    start(
      detail(
        {
          approvals: [APPROVAL_ROW],
          artifacts: [PLAN_REF, { ...PLAN_REF, id: ARTIFACT, version: 3 }],
        },
        { state: 'waiting_approval' },
      ),
    );
    const callout = await screen.findByRole('region', { name: 'Needs you' });
    const card = within(callout).getByRole('region', { name: 'Plan approval' });
    expect(card.querySelector('[data-approval-superseded]')?.textContent).toContain(
      'A newer plan (v3) exists',
    );
    expect(within(card).queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(within(card).getByRole('button', { name: 'Reject…' })).toBeTruthy();
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
    // …and *Review plan* is not the header's primary for them.
    expect(primaries()).not.toContain('Review plan');
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

/**
 * S-25.4 (research/21 S04): a task nobody has asked anything is *Ask the task*'s empty state. The
 * server answers that with `200 { items: [] }` (`apps/server/src/routes/asks.ts`), and only that is
 * empty: a refusal — a task that is gone, a role the read refuses — stays an error, by name.
 */
describe('Ask the task', () => {
  const ASKS = `/api/tasks/${TASK}/asks`;

  it('shows the empty state for a thread with no question, and no error', async () => {
    start(detail(), `/tasks/${TASK}`, [], { [ASKS]: () => json({ items: [] }) });
    expect(await screen.findByText('No questions yet')).toBeTruthy();
    expect(screen.queryByText('The thread could not be loaded.')).toBeNull();
  });

  it.each([
    [404, 'not_found'],
    [403, 'forbidden'],
  ])('keeps a %i refusal an error, never the empty state', async (status, code) => {
    start(detail(), `/tasks/${TASK}`, [], {
      [ASKS]: () => json({ error: { code, message: 'refused by the fake' } }, status),
    });
    expect(
      await screen.findByText('The thread could not be loaded.', {}, { timeout: 4_000 }),
    ).toBeTruthy();
    expect(screen.queryByText('No questions yet')).toBeNull();
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
    expect(screen.getByTestId('task-flow')).toBeTruthy();
    // The counts are the task's own.
    expect(within(tabs()).getByRole('link', { name: /Artifacts/ }).textContent).toBe('Artifacts1');

    await user.click(within(tabs()).getByRole('link', { name: /Activity/ }));
    await waitFor(() => {
      expect(window.location.search).toBe('?tab=activity');
    });
    expect(current()).toBe('Activity');
    expect(await screen.findByText('Who did what')).toBeTruthy();
    expect(screen.queryByTestId('task-flow')).toBeNull();
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

  it('counts what needs a person first — checks only, the callout’s items pointed at (S-25.4)', async () => {
    start(
      detail({ questions: [QUESTION_ROW], stages: [stage('ci_gate', 1, 'returned', 'returned')] }),
    );
    // The returned CI gate is the one check; the open question is the callout's, not a second.
    await waitFor(() => {
      expect(document.querySelector('[data-checks-summary]')?.textContent).toBe(
        '1 check needs you',
      );
    });
    expect(document.querySelector('[data-checks-callout]')?.textContent).toBe(
      CHECKS_CALLOUT_POINTER,
    );
    // The row stays (product/10:38 lists it), and says where it is answered.
    expect(document.querySelector('[data-check="questions"]')?.textContent).toContain(
      '1 · see above',
    );
  });

  it('says nothing about the callout when nothing waits there', async () => {
    start(detail({ stages: [stage('ci_gate', 1, 'returned', 'returned')] }));
    await waitFor(() => {
      expect(document.querySelector('[data-checks-summary]')?.textContent).toBe(
        '1 check needs you',
      );
    });
    expect(document.querySelector('[data-checks-callout]')).toBeNull();
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
    ).toEqual({ status: 'waiting', text: '1 required check is not decided yet', callout: null });
    expect(
      checksSummary([
        { status: 'success', required: true },
        { status: 'queued', required: false },
      ]),
    ).toEqual({ status: 'success', text: 'All required checks pass', callout: null });
    expect(checksSummary([{ status: 'needs_you', required: false }]).text).toBe(
      '1 check needs you',
    );
    // S-25.4: a callout item is never a check — not counted, and not a required row left open.
    expect(
      checksSummary([
        { status: 'success', required: true },
        { status: 'needs_you', required: true, callout: true },
      ]),
    ).toEqual({
      status: 'success',
      text: 'All required checks pass',
      callout: CHECKS_CALLOUT_POINTER,
    });
    expect(
      checksSummary([
        { status: 'success', required: true },
        { status: 'success', required: true, callout: true },
      ]).callout,
    ).toBeNull();
  });
});

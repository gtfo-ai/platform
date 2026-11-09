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
import { TICKET_TEMPLATES } from '@platform/domain';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';
import { stageLabel } from '../ui/humanize.js';
import { legacyApprovalExpired, taskPagePrimary, taskPrimaryAction } from './page-primary.js';
import { pauseWhy } from './task-callout.js';
import {
  CHECKED_TEMPLATES,
  CHECKS_CALLOUT_POINTER,
  CHECKS_START_STAGE,
  checksNotStartedText,
  checksSummary,
  dependencyStatus,
  gateStatus,
  TAMPER_NOT_CHECKED,
  TAMPER_NOT_CHECKED_YET,
  tamperStatus,
  tamperValueText,
} from './task-checks-text.js';
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
  tracker_assignee: null,
  owner: null,
  owner_source: null,
  unlinked_assignee: null,
  owner_writes_back: false,
  waiting: null,
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
    can_change_limits: false,
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

/**
 * S-25.12: the CI check's open read, AUT-6655's shape — held at the manual job
 * `sentry-release-commit` on a draft merge request, 60 minutes allowed. Twelve and a half minutes
 * in, by the page's own clock.
 */
const JOB_URL = 'https://git.example.invalid/acme/api/-/jobs/977';
const GITLAB_MR = {
  provider: 'gitlab',
  project_path: 'acme/api',
  iid: 7,
  url: 'https://git.example.invalid/acme/api/-/merge_requests/7',
};
const heldWait = (): NonNullable<TaskDetailResponse['gate_wait']> => ({
  pipeline_id: '3038234623',
  pipeline_url: 'https://git.example.invalid/acme/api/-/pipelines/3038234623',
  status: 'manual',
  held_job: 'sentry-release-commit',
  held_job_url: JOB_URL,
  draft: true,
  checked_at: new Date(Date.now() - 60_000).toISOString(),
  waiting_since: new Date(Date.now() - 12.5 * 60_000).toISOString(),
  timeout_minutes: 60,
});
const atCi = (wait: NonNullable<TaskDetailResponse['gate_wait']>) =>
  detail(
    {
      gate_wait: wait,
      stages: [
        stage('implementation', 1, 'completed', 'approve'),
        stage('ci_gate', 1, 'running', null),
      ],
    },
    { state: 'active', current_stage: 'ci_gate', mr_ref: GITLAB_MR },
  );

/**
 * S-25.15: AUT-6655's stop — the CI check timed out on a poll-only binding (`no_answer`,
 * `ci_ending: 'ci_timed_out'`), so the task waits for a person and the callout's next step is to
 * retry the stage.
 */
const ciTimedOut = (over: Partial<TaskDetailResponse> = {}) =>
  detail(
    {
      stop: {
        stage: 'ci_gate',
        attempt: 1,
        cause: 'no_answer',
        loop: null,
        ci_failure: null,
        recorded: 'pipeline 3038234623 was still held at the manual job sentry-release-commit',
        recorded_cut: false,
        ci_ending: 'ci_timed_out',
      },
      stages: [
        stage('implementation', 1, 'completed', 'approve'),
        stage('ci_gate', 1, 'failed', 'undecided'),
      ],
      ...over,
    },
    { state: 'needs_human', current_stage: 'ci_gate', mr_ref: GITLAB_MR },
  );

/**
 * S-25.20: AUT-6639 on Autix — a plan approval that expired before S-27.1. No structured stop; the
 * escalation's reason is the saga's sentence and its brief says to retry the stage.
 */
const legacyApprovalExpiredTask = (over: Partial<TaskDetailResponse> = {}) =>
  detail(
    {
      stop: null,
      stages: [
        stage('refinement', 1, 'completed', 'approve'),
        stage('architecture', 1, 'completed', 'approve'),
      ],
      escalation: {
        at: '2026-11-06T14:47:56.803Z',
        reason: 'the approval expired',
        brief:
          'Nobody decided the plan approval for AUT-6639 in time, and an expired approval can no ' +
          'longer be approved or rejected. To go on, retry "architecture" from the task page to ' +
          'have the plan written and asked for again — or cancel the task.',
        brief_original_chars: null,
      },
      ...over,
    },
    { state: 'needs_human', current_stage: 'architecture' },
  );

/** S-25.14's stop: the ticket is assigned to somebody else, nobody owns the task. */
const heldElsewhereTask = (over: Partial<TaskDetailResponse> = {}) =>
  detail(
    {
      can_take: true,
      escalation: {
        at: AT,
        reason: 'ticket_assigned_elsewhere',
        brief: 'ACME-12 is assigned to somebody else in Jira.',
        brief_original_chars: null,
      },
      ...over,
    },
    { state: 'needs_human' },
  );

/** The page's own facts for `taskPagePrimary`: a stage to retry, nothing owned, not merged. */
const PAGE_CONTEXT = { ownerOffers: [], stageOptions: 1, merged: false } as const;

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
    if (path === '/api/org/inbox')
      return json({ questions: [], approvals: [], ci_held: [], escalated: [] });
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
    // A plain escalation, with no structured stop: Resume, as before S-25.15.
    ['an escalated task', detail({}, { state: 'needs_human' }), ['Resume']],
    // S-25.15: the primary is the callout's own next step, never a Resume beside it.
    ['a task stopped because CI did not finish (AUT-6655)', ciTimedOut(), ['Retry stage…']],
    // S-25.20: a stop written before S-27.1 by an approval that expired is a retry stop too.
    [
      'a legacy stop whose approval expired (AUT-6639)',
      legacyApprovalExpiredTask(),
      ['Retry stage…'],
    ],
    [
      'a task whose ticket somebody else holds, for a reader who may take it',
      heldElsewhereTask(),
      ['Take it'],
    ],
    ['a running task', detail(), []],
    // S-25.12: the one next step is the held job, a link to its page.
    ['a CI check held at a manual job', atCi(heldWait()), ['Start the job in GitLab']],
    [
      'a CI check still running',
      atCi({ ...heldWait(), status: 'running', held_job: null, held_job_url: null }),
      [],
    ],
  ];

  it.each(cases)('%s', async (_name, task, expected) => {
    start(task);
    await screen.findByRole('heading', { level: 1 });
    await screen.findByText('Checks');
    await waitFor(() => {
      expect(primaries()).toEqual(expected);
    });
  });

  it('makes the callout’s Retry stage… the primary on AUT-6655, with Resume in the menu (S-25.15)', async () => {
    const user = userEvent.setup();
    start(ciTimedOut());
    const callout = await screen.findByRole('region', { name: 'Needs you' });
    await waitFor(() => {
      expect(primaries()).toEqual(['Retry stage…']);
    });
    // The amber button is the callout's, the one beside the sentence that names it.
    const retry = within(callout).getByRole('button', { name: 'Retry stage…' });
    expect(retry.className).toContain('border-primary-line');
    expect(callout.textContent).toContain('then retry the stage');
    // No Resume button anywhere on the page; it is a plain item of the menu.
    expect(within(screen.getByRole('main')).queryByRole('button', { name: 'Resume' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Task actions' }));
    const resume = await screen.findByRole('menuitem', { name: 'Resume' });
    expect(resume.className).not.toContain('border-primary-line');
  });

  it('reads AUT-6639’s legacy expired approval as a retry stop, and nothing else as one (S-25.20)', () => {
    expect(legacyApprovalExpired(legacyApprovalExpiredTask())).toBe(true);
    expect(
      legacyApprovalExpired(
        legacyApprovalExpiredTask({
          escalation: {
            at: AT,
            reason: 'approval.expired',
            brief: 'An approval expired undecided.',
            brief_original_chars: null,
          },
        }),
      ),
    ).toBe(true);
    // Another reason, no escalation, or a task no longer waiting for a person: not one.
    expect(
      legacyApprovalExpired(
        legacyApprovalExpiredTask({
          escalation: {
            at: AT,
            reason: 'ticket_claim_failed',
            brief: 'The tracker refused.',
            brief_original_chars: null,
          },
        }),
      ),
    ).toBe(false);
    expect(legacyApprovalExpired(legacyApprovalExpiredTask({ escalation: null }))).toBe(false);
    const paused = legacyApprovalExpiredTask();
    expect(legacyApprovalExpired({ ...paused, task: { ...paused.task, state: 'paused' } })).toBe(
      false,
    );
    expect(taskPagePrimary(legacyApprovalExpiredTask(), PAGE_CONTEXT)).toBe('retry_stage');
    // A merged task's way out is its retrospective, through Resume.
    expect(taskPagePrimary(legacyApprovalExpiredTask(), { ...PAGE_CONTEXT, merged: true })).toBe(
      'resume',
    );
  });

  it('draws no primary for a stop when the caller may neither resume nor retry', async () => {
    start(ciTimedOut({ can_resume: false }));
    await screen.findByRole('region', { name: 'Needs you' });
    await screen.findByText('Checks');
    await waitFor(() => {
      expect(primaries()).toEqual([]);
    });
  });

  it('decides a stop’s primary in one place: retry, then resume, never both', () => {
    const stopped = {
      state: 'needs_human' as const,
      canHandBack: false,
      openQuestions: 0,
      pendingApprovals: 0,
    };
    expect(taskPrimaryAction(stopped)).toBe('resume');
    expect(taskPrimaryAction({ ...stopped, stopRetry: true })).toBe('retry_stage');
    // Only a task that waits for a person: a paused one with an old stop still resumes.
    expect(taskPrimaryAction({ ...stopped, state: 'paused', stopRetry: true })).toBe('resume');
    expect(taskPrimaryAction({ ...stopped, stopRetry: true, canResume: false })).toBeNull();
    // A question still comes first, and the ticket held elsewhere is the box's Take it.
    expect(taskPrimaryAction({ ...stopped, stopRetry: true, openQuestions: 1 })).toBe('answer');
    expect(
      taskPrimaryAction({ ...stopped, stopRetry: true, heldElsewhere: true, canTake: true }),
    ).toBe('take');
    expect(taskPrimaryAction({ ...stopped, heldElsewhere: true, canTake: false })).toBeNull();
    // Review of #118: a pending approval comes before Retry. A reader who may decide it reviews
    // it; anybody else keeps Resume (it re-enters the approval's wait), or nothing.
    const pending = { ...stopped, stopRetry: true, pendingApprovals: 1 };
    expect(taskPrimaryAction({ ...pending, canDecide: true })).toBe('approve');
    expect(taskPrimaryAction({ ...pending, canDecide: false })).toBe('resume');
    expect(taskPrimaryAction({ ...pending, canDecide: false, canResume: false })).toBeNull();
  });

  it('keeps Resume, not Retry stage…, for a stop beside an approval the reader may not decide (review of #118)', async () => {
    start(ciTimedOut({ approvals: [APPROVAL_ROW], can_decide_approval: false }));
    await screen.findByRole('region', { name: 'Needs you' });
    await screen.findByText('Checks');
    await waitFor(() => {
      expect(primaries()).toEqual(['Resume']);
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
    // S-25.12: a held manual job comes after the cap, before a resume; a question still wins.
    expect(
      taskPrimaryAction({
        state: 'active',
        canHandBack: false,
        openQuestions: 0,
        pendingApprovals: 0,
        ciHeldLink: true,
      }),
    ).toBe('start_job');
    expect(
      taskPrimaryAction({
        state: 'active',
        canHandBack: false,
        openQuestions: 1,
        pendingApprovals: 0,
        ciHeldLink: true,
      }),
    ).toBe('answer');
  });
});

/**
 * S-25.12 (product/10's 2026-11-07 amendments): while the CI check waits, the header says what it
 * waits for, and a pipeline held at a manual job is *Needs you* at once — the header's state, its
 * *Now* line, its one primary and the callout, from the read's `gate_wait`.
 */
describe('a waiting CI check (S-25.12)', () => {
  it('makes a held manual job Needs you at once, with the job as the one next step', async () => {
    start(atCi(heldWait()), `/tasks/${TASK}`, [PROJECT_ROW]);
    const callout = await screen.findByRole('region', { name: 'Needs you' });
    await waitFor(() => {
      expect(document.querySelector('[data-state-label="needs_you"]')?.textContent).toBe(
        'Needs you',
      );
    });
    expect(screen.getByRole('main').textContent).toContain(
      'Now: CI waits for someone to start the manual job sentry-release-commit',
    );
    const primary = screen.getByRole('link', { name: 'Start the job in GitLab' });
    expect(primary.getAttribute('href')).toBe(JOB_URL);
    expect(
      within(callout).getByRole('link', { name: 'sentry-release-commit' }).getAttribute('href'),
    ).toBe(JOB_URL);
    // The draft note links the readiness panel's CI-rules warning.
    const readiness = await within(callout).findByRole('link', { name: 'Discovery & readiness' });
    expect(readiness.getAttribute('href')).toBe(`/projects/${PROJECT_ROW.key}/settings/discovery`);
    expect(within(callout).getByText(/12 min so far; the task gives up after 60/)).toBeTruthy();
  });

  it('reads a task paused by hand at a held job as paused, with Resume, not Needs you (review of PR #101)', async () => {
    const paused = atCi(heldWait());
    start({ ...paused, task: { ...paused.task, state: 'paused', paused_reason: 'manual' } });
    await screen.findByRole('heading', { level: 1 });
    await screen.findByText('Checks');
    await waitFor(() => {
      expect(primaries()).toEqual(['Resume']);
    });
    expect(document.querySelector('[data-state-label="paused"]')?.textContent).toBe('Paused');
    expect(document.querySelector('[data-state-label="needs_you"]')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Needs you' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Start the job in GitLab' })).toBeNull();
    const main = screen.getByRole('main').textContent ?? '';
    expect(main).not.toContain('Start it there and the task continues');
    expect(main).not.toContain('Now: CI waits');
    expect(main).not.toContain('Now: CI running');
  });

  it('says a running pipeline on the Now line and in the slot, and asks nothing', async () => {
    start(atCi({ ...heldWait(), status: 'running', held_job: null, held_job_url: null }));
    const notice = await screen.findByRole('region', { name: 'What happens next' });
    expect(notice.querySelector('[data-gate-wait="running"]')?.textContent).toBe(
      'CI is running (pipeline 3038234623, 12 min so far; the task gives up after 60).',
    );
    expect(screen.getByRole('main').textContent).toContain('Now: CI running · 12 min of 60');
    expect(screen.queryByRole('region', { name: 'Needs you' })).toBeNull();
    expect(document.querySelector('[data-state-label="needs_you"]')).toBeNull();
  });
});

describe('a run that waits for a machine (S-26.8b part 2, the M26 UX spec § 4)', () => {
  const VOJTECH = '00000000-0000-4000-8000-00000000a001';
  const offline = {
    reason: 'owner_worker_offline' as const,
    user: { user_id: VOJTECH, name: 'Vojtěch' },
    last_seen_at: null,
    assignee_name: null,
    blockers: [],
  };
  const LONG = 'Waiting for Vojtěch’s machine. It’s offline and has never connected.';

  it('says why on the Now line and in the callout, with the read’s owner steps as secondaries', async () => {
    start(
      detail(
        { can_take: true, can_assign: true },
        {
          state: 'active',
          current_stage: 'implementation',
          owner: { user_id: VOJTECH, name: 'Vojtěch' },
          owner_source: 'platform',
          waiting: offline,
        },
      ),
      `/tasks/${TASK}`,
      [PROJECT_ROW],
    );
    const notice = await screen.findByRole('region', { name: 'Why it waits' });
    expect(notice.querySelector('[data-waiting]')?.textContent).toBe(LONG);
    expect(screen.getByRole('main').textContent).toContain(`Now: ${LONG}`);
    // Information, never Needs you; and its steps are never the page's amber primary.
    expect(screen.queryByRole('region', { name: 'Needs you' })).toBeNull();
    const take = within(notice).getByRole('button', { name: 'Take it' });
    expect(primaries()).not.toContain('Take it');
    // An admin reading somebody else's machine is offered no Open Workers.
    expect(within(notice).queryByRole('link', { name: 'Open Workers' })).toBeNull();
    // The header's own control: Take it from somebody else asks first, naming them.
    await userEvent.setup().click(take);
    expect(
      await screen.findByRole('dialog', { name: 'Take ACME-12 from Vojtěch?' }, { timeout: 5000 }),
    ).toBeTruthy();
  });

  it('sends the callout’s Take it and Assign… through the header’s one owner control', async () => {
    const jan = { display_name: 'Jan Novák', user_id: null };
    const { sent } = start(
      detail(
        { can_take: true, can_assign: true, take_writes_back: true },
        {
          state: 'active',
          current_stage: 'implementation',
          unlinked_assignee: { display_name: 'Jan Novák' },
          tracker_assignee: jan,
          waiting: {
            ...offline,
            reason: 'assignee_not_linked',
            user: null,
            assignee_name: 'Jan Novák',
          },
        },
      ),
      `/tasks/${TASK}`,
      [PROJECT_ROW],
    );
    const user = userEvent.setup();
    const notice = await screen.findByRole('region', { name: 'Why it waits' });
    // Take it writes back, replacing whom the tracker shows: #103's confirmation, asked once.
    await user.click(within(notice).getByRole('button', { name: 'Take it' }));
    const confirm = await screen.findByRole('dialog', { name: 'Take ACME-12?' }, { timeout: 5000 });
    expect(confirm.textContent).toContain(
      'This also assigns ACME-12 in Jira to you, replacing Jan Novák.',
    );
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    await user.click(within(confirm).getByRole('button', { name: 'Take it and assign in Jira' }));
    await waitFor(() => {
      expect(sent).toContainEqual({
        path: `/api/tasks/${TASK}/owner`,
        body: { user_id: SESSION.user.id },
      });
    });
    // The header's own status line says what followed: the control is the header's.
    expect(
      await screen.findByText('Assigned to you. Your machine picks it up at the next stage.'),
    ).toBeTruthy();
    // Assign… opens #103's person picker — the one the header's own Assign… opens.
    await user.click(within(notice).getByRole('button', { name: 'Assign…' }));
    expect(
      await screen.findByRole('dialog', { name: 'Assign ACME-12' }, { timeout: 5000 }),
    ).toBeTruthy();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  it('says "your machine" to the machine’s owner, with Open Workers', async () => {
    start(
      detail(
        {},
        {
          state: 'active',
          current_stage: 'implementation',
          owner: { user_id: SESSION.user.id, name: 'Fake Operator' },
          owner_source: 'platform',
          waiting: { ...offline, user: { user_id: SESSION.user.id, name: 'Fake Operator' } },
        },
      ),
    );
    const notice = await screen.findByRole('region', { name: 'Why it waits' });
    await waitFor(() => {
      expect(notice.querySelector('[data-waiting]')?.textContent).toBe(
        'Waiting for your machine. It’s offline and has never connected.',
      );
    });
    expect(
      (await within(notice).findByRole('link', { name: 'Open Workers' })).getAttribute('href'),
    ).toBe('/workers');
  });

  it('says nothing more when somebody can take it now', async () => {
    start(
      detail(
        {},
        {
          state: 'active',
          current_stage: 'implementation',
          waiting: { ...offline, reason: null, user: null },
        },
      ),
    );
    await screen.findByRole('heading', { level: 1 });
    await screen.findByText('Checks');
    expect(screen.queryByRole('region', { name: 'Why it waits' })).toBeNull();
    expect(document.querySelector('[data-waiting]')).toBeNull();
    expect(screen.getByRole('main').textContent).not.toContain('machine. It’s');
  });
});

describe('the needs-you callout', () => {
  /**
   * S-27.1 (review of #113): a cancelled task's pending approval is withdrawn, which the server
   * stores as `expired` with the reason "the task was cancelled". A cancelled task is not
   * Needs you: the page offers no callout for it, and never says an approval expired undecided.
   */
  it('says nothing about an expired approval for a cancelled task whose approval was withdrawn', async () => {
    start(
      detail(
        {
          approvals: [
            {
              ...APPROVAL_ROW,
              status: 'expired',
              decided_at: AT,
              reason: 'the task was cancelled',
            },
          ],
          stages: [
            stage('refinement', 1, 'completed', 'approve'),
            stage('architecture', 1, 'completed', 'cancelled'),
          ],
        },
        { state: 'cancelled' },
      ),
    );
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('region', { name: 'Needs you' })).toBeNull();
    const text = document.body.textContent ?? '';
    expect(text).not.toContain('an approval expired undecided');
    expect(text).not.toContain('Needs you: an approval');
    expect(text).not.toMatch(/\bExpired\b/);
  });

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
      'and 2 of them are done',
    );
    expect(card.querySelector('[data-approval-retire="probation"]')?.textContent).toContain(
      'The extra checks end by themselves after 5 completed tasks (3 to go)',
    );
    expect(card.querySelector('[data-approval-reason="size_at_or_above"]')?.textContent).toContain(
      'The plan’s size is L, at or above the project’s threshold of L.',
    );
    const links = within(card).getAllByRole('link', { name: 'How much agents do alone' });
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
      'Needs you: the check could not decide in the tries it is allowed.',
    );
  });

  // BACKLOG 850: five tasks stuck on the Autix core said only that they needed a person, while each
  // escalation had written what stopped it and the way out.
  it('leads with the escalation’s own brief, instead of the row’s word, when the read has one', async () => {
    // Not `ticket_assigned_elsewhere`: that stop leads with whose ticket it is (S-25.14,
    // `ticket-held-elsewhere.test.tsx`) and keeps its brief under Details.
    const brief =
      'The platform did not start the "refinement" stage of AUT-6676: the tracker refused to ' +
      'assign the ticket to the binding’s account. Give that account Assign Issues, then hand ' +
      'the task back. <b>not markup</b>';
    start(
      detail(
        {
          stages: [stage('refinement', 1, 'failed', 'undecided')],
          escalation: {
            at: '2026-11-05T13:22:12.114Z',
            reason: 'ticket_claim_failed',
            brief,
            brief_original_chars: null,
          },
        },
        { state: 'needs_human', current_stage: 'refinement' },
      ),
    );
    const callout = await screen.findByRole('region', { name: 'Needs you' });
    const shown = callout.querySelector('[data-escalation-brief]');
    expect(shown?.textContent).toContain('Why it stopped');
    expect(shown?.textContent).toContain(brief);
    // Untrusted text, never markup (BD-022).
    expect(shown?.querySelector('b')).toBeNull();
    expect(shown?.textContent).not.toContain('(shortened)');
    // The brief replaces the generic outcome sentence rather than sitting under it.
    expect(callout.querySelector('[data-escalation-reason]')).toBeNull();
  });

  // Review of PR #111: a structured stop (S-25.11/12) is the one headline; the brief is kept, but
  // collapsed under *Details* in place of the stop's *What the platform saw last:* line.
  it('says why once when the read carries both a structured stop and the escalation’s brief', async () => {
    const brief = 'The CI check failed the same way twice.\n\nLook at job unit.';
    start(
      detail(
        {
          stages: [stage('ci_gate', 4, 'failed', 'undecided')],
          stop: {
            stage: 'ci_gate',
            attempt: 4,
            cause: 'same_failure',
            loop: null,
            ci_failure: { status: 'failed', jobs: 'unit' },
            recorded: 'pipeline 41 failed: unit',
            recorded_cut: false,
            ci_ending: null,
          },
          escalation: {
            at: '2026-11-06T22:53:34.691Z',
            reason: 'the same CI failure twice',
            brief,
            brief_original_chars: null,
          },
        },
        { state: 'needs_human', current_stage: 'ci_gate' },
      ),
    );
    const callout = await screen.findByRole('region', { name: 'Needs you' });
    // One headline: the structured stop's sentence; neither the brief nor the row's word as another.
    expect(callout.querySelector('[data-stop="same_failure"] [data-stop-sentence]')).not.toBeNull();
    expect(callout.querySelector('[data-escalation-brief]')).toBeNull();
    expect(callout.querySelector('[data-escalation-reason]')).toBeNull();
    expect(callout.querySelector('[data-stop-recorded]')).toBeNull();
    expect(callout.textContent).not.toContain('What the platform saw last');
    // The brief, collapsed, as prose: its blank line kept, in a block that wraps it (pre-wrap).
    const details = callout.querySelector<HTMLDetailsElement>('details[data-escalation-details]');
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(details?.querySelector('summary')?.textContent).toBe('Details');
    const prose = details?.querySelector('p.whitespace-pre-wrap');
    expect(prose?.textContent).toBe(brief);
  });

  it('shows no Details disclosure when the brief is the one why', async () => {
    start(
      detail(
        {
          stages: [stage('architecture', 1, 'completed', 'approve')],
          escalation: {
            at: '2026-11-06T14:47:56.803Z',
            reason: 'the approval expired',
            brief: 'Nobody decided the plan approval for AUT-6639 in time.',
            brief_original_chars: null,
          },
        },
        { state: 'needs_human', current_stage: 'architecture' },
      ),
    );
    const callout = await screen.findByRole('region', { name: 'Needs you' });
    expect(callout.querySelector('[data-escalation-brief]')?.textContent).toContain(
      'Nobody decided the plan approval for AUT-6639 in time.',
    );
    expect(callout.querySelector('[data-escalation-details]')).toBeNull();
  });

  it('says a cut brief was shortened', async () => {
    start(
      detail(
        {
          stages: [stage('ci_gate', 1, 'failed', 'undecided')],
          escalation: {
            at: '2026-11-06T22:53:34.691Z',
            reason: 'ci timed out',
            brief: 'x'.repeat(1_000),
            brief_original_chars: 1_400,
          },
        },
        { state: 'needs_human', current_stage: 'ci_gate' },
      ),
    );
    const callout = await screen.findByRole('region', { name: 'Needs you' });
    expect(callout.querySelector('[data-escalation-brief]')?.textContent).toContain('(shortened)');
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
    // S-25.20: a pause the read records nothing about still says it was a person's, and no name.
    const notice = await screen.findByRole('region', { name: 'Paused' });
    expect(notice.querySelector('[data-paused-by="unknown"]')?.textContent).toBe(
      'A person paused this task; the record does not say who.',
    );
  });

  // S-25.20: only a budget pause had words; a person's pause said nothing about who, when or why.
  it('says who paused a task, when and why, with Resume, as information (S-25.20)', async () => {
    const user = userEvent.setup();
    const { sent } = start(
      detail(
        {
          manual_pause: {
            at: AT,
            by: { user_id: '00000000-0000-4000-8000-0000000000e1', name: 'Pat <b>Pauser</b>' },
            via: 'pause',
            reason: 'waiting for the API freeze <i>x</i>',
            reason_cut: false,
          },
        },
        { state: 'paused', paused_reason: 'manual' },
      ),
    );
    const notice = await screen.findByRole('region', { name: 'Paused' });
    expect(screen.queryByRole('region', { name: 'Needs you' })).toBeNull();
    const by = notice.querySelector('[data-paused-by="pause"]');
    expect(by?.textContent).toContain('Paused by Pat <b>Pauser</b>, ');
    // A person's name and words, never markup (BD-022).
    expect(by?.querySelector('b')).toBeNull();
    expect(notice.querySelector('[data-paused-why]')?.textContent).toBe(
      'Why: waiting for the API freeze <i>x</i>',
    );
    expect(notice.querySelector('i')).toBeNull();
    // Its Resume is plain: the header's is the page's one amber primary.
    await waitFor(() => {
      expect(primaries()).toEqual(['Resume']);
    });
    const resume = within(notice).getByRole('button', { name: 'Resume' });
    expect(resume.className).not.toContain('border-primary-line');
    await user.click(resume);
    await waitFor(() => {
      expect(sent.map((entry) => entry.path)).toEqual([`/api/tasks/${TASK}/resume`]);
    });
  });

  it('says a Cancel run paused it, gives no why for the button’s own words, and no Resume for a reader who may not', async () => {
    start(
      detail(
        {
          can_resume: false,
          manual_pause: {
            at: AT,
            by: { user_id: '00000000-0000-4000-8000-0000000000e1', name: null },
            via: 'run_cancel',
            reason: null,
            reason_cut: false,
          },
        },
        { state: 'paused', paused_reason: 'manual' },
      ),
    );
    const notice = await screen.findByRole('region', { name: 'Paused' });
    expect(notice.querySelector('[data-paused-by="run_cancel"]')?.textContent).toMatch(
      /^Paused when a person cancelled its run, .+\. Cancelling a run pauses its task\.$/,
    );
    expect(notice.querySelector('[data-paused-why]')).toBeNull();
    expect(within(notice).queryByRole('button', { name: 'Resume' })).toBeNull();
    expect(notice.textContent).toContain('Nothing runs until a member of the project resumes it.');
    cleanup();
    // The platform's own Pause button sends "paused from the UI": that is no reason a person gave.
    expect(
      pauseWhy({
        at: AT,
        by: null,
        via: 'pause',
        reason: 'paused from the UI',
        reason_cut: false,
      }),
    ).toBeNull();
    expect(
      pauseWhy({ at: AT, by: null, via: 'pause', reason: 'release freeze', reason_cut: false }),
    ).toBe('release freeze');
  });

  // S-25.20: AUT-6655 read the generic options sentence first and the cause after it.
  it('leads with the cause, then the next step, and says the options last (S-25.20)', async () => {
    start(ciTimedOut());
    const callout = await screen.findByRole('region', { name: 'Needs you' });
    const text = callout.textContent ?? '';
    const cause = callout.querySelector('[data-stop-sentence]')?.textContent ?? '';
    const next = callout.querySelector('[data-stop-next]')?.textContent ?? '';
    const options = 'This task is waiting for a person.';
    expect(cause).not.toBe('');
    expect(next).not.toBe('');
    expect(text.indexOf(cause)).toBeGreaterThan(-1);
    expect(text.indexOf(cause)).toBeLessThan(text.indexOf(next));
    expect(text.indexOf(next)).toBeLessThan(text.indexOf(options));
  });

  it('puts the options sentence after the escalation’s own brief too (S-25.20)', async () => {
    start(legacyApprovalExpiredTask());
    const callout = await screen.findByRole('region', { name: 'Needs you' });
    const text = callout.textContent ?? '';
    expect(text.indexOf('Why it stopped')).toBeGreaterThan(-1);
    expect(text.indexOf('Nobody decided the plan approval')).toBeLessThan(
      text.indexOf('This task is waiting for a person.'),
    );
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
      ['Pause', 'Work on it yourself…'],
      'Cancel task…',
    ],
    [
      'a task a person paused: no take-over',
      { state: 'paused' as const, paused_reason: 'manual' as const },
      ['Work on it yourself…', 'Pause', 'Resume'],
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
        'Work on it yourself…',
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
    can_change_limits: false,
    can_take: false,
    can_assign: false,
    can_unassign: false,
    take_writes_back: false,
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
    expect(article.textContent).toContain('1 secret hidden');
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

  it('says Protected files was not checked when CI did not finish, and counts only CI (S-25.15)', async () => {
    start(ciTimedOut());
    await waitFor(() => {
      expect(document.querySelector('[data-checks-summary]')?.textContent).toBe(
        '1 check needs you',
      );
    });
    const tamper = document.querySelector('[data-check="tamper"]')?.textContent ?? '';
    expect(tamper).toContain(TAMPER_NOT_CHECKED);
    expect(tamper).not.toContain('needs you');
    // The CI item is the one that needs a person, and says why.
    expect(document.querySelector('[data-check="ci"]')?.textContent).toContain(
      'needs you: it could not decide',
    );
  });

  it('says Protected files was not checked yet when the row cannot say CI was unfinished (review of #118)', async () => {
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
    await waitFor(() => {
      expect(document.querySelector('[data-checks-summary]')?.textContent).toBe(
        '1 check needs you',
      );
    });
    const tamper = document.querySelector('[data-check="tamper"]')?.textContent ?? '';
    expect(tamper).toContain(TAMPER_NOT_CHECKED_YET);
    expect(tamper).not.toContain('didn’t finish');
    expect(document.querySelector('[data-check="tamper"]')?.getAttribute('data-check-status')).toBe(
      'skipped',
    );
  });

  // S-25.20: at Architecture nothing can have run, so the box says when the checks start.
  it('reads neutral before any check can run: when they start, no clock, no count (S-25.20)', async () => {
    start(
      detail(
        { stages: [stage('architecture', 1, 'running', null)] },
        { state: 'active', current_stage: 'architecture' },
      ),
    );
    await waitFor(() => {
      expect(document.querySelector('[data-checks-summary]')?.textContent).toBe(
        `Checks start at ${stageLabel(CHECKS_START_STAGE)}.`,
      );
    });
    expect(
      document.querySelector('[data-checks-summary]')?.getAttribute('data-checks-summary'),
    ).toBe('queued');
    expect(document.body.textContent).not.toContain('not decided yet');
  });

  it('says nothing new for a spike at Architecture, whose pipeline reaches no check (review of #126)', async () => {
    start(
      detail(
        { stages: [stage('architecture', 1, 'running', null)] },
        { state: 'active', current_stage: 'architecture', template: 'spike' },
      ),
    );
    await waitFor(() => {
      expect(document.querySelector('[data-checks-summary]')?.textContent).toMatch(
        /not decided yet|check/,
      );
    });
    expect(document.querySelector('[data-checks-summary]')?.textContent).not.toContain(
      'Checks start at',
    );
  });

  it('words the checks’ start from the stage the task is at, and steps aside once a gate ran', () => {
    expect(CHECKS_START_STAGE).toBe('implementation');
    const before = { state: 'active' as const, current_stage: 'refinement', template: 'feature' };
    expect(checksNotStartedText(before, [])).toBe('Checks start at Implementation.');
    expect(
      checksNotStartedText(
        { state: 'needs_human', current_stage: 'architecture', template: 'feature' },
        [],
      ),
    ).toBe('Checks start at Implementation.');
    expect(
      checksNotStartedText(
        { state: 'active', current_stage: 'implementation', template: 'feature' },
        [],
      ),
    ).toBe('Checks start when Implementation is done.');
    // A gate has a row (a return to an earlier stage after CI ran): the rows say what they say.
    expect(checksNotStartedText(before, [stage('ci_gate', 1, 'completed', 'pass')])).toBeNull();
    // At or past the first gate, a project's own stage, a finished task, or no stage: nothing.
    expect(
      checksNotStartedText({ state: 'active', current_stage: 'ci_gate', template: 'feature' }, []),
    ).toBeNull();
    expect(
      checksNotStartedText(
        { state: 'active', current_stage: 'code_review', template: 'feature' },
        [],
      ),
    ).toBeNull();
    expect(
      checksNotStartedText(
        { state: 'active', current_stage: 'design_spike', template: 'feature' },
        [],
      ),
    ).toBeNull();
    expect(
      checksNotStartedText(
        { state: 'cancelled', current_stage: 'refinement', template: 'feature' },
        [],
      ),
    ).toBeNull();
    expect(
      checksNotStartedText({ state: 'queued', current_stage: null, template: 'feature' }, []),
    ).toBeNull();
    // Review of #126: a spike or an epic split never reaches a check — no new sentence for them.
    for (const template of ['spike', 'epic_split', 'discovery']) {
      expect(
        checksNotStartedText({ state: 'active', current_stage: 'architecture', template }, []),
      ).toBeNull();
    }
    // The web's list is the domain's ticket templates, exactly.
    expect([...CHECKED_TEMPLATES].sort()).toEqual(Object.keys(TICKET_TEMPLATES).sort());
    // The box: neutral, and a check that needs a person still says so first.
    expect(checksSummary([{ status: 'queued', required: true }], 'Checks start at X.')).toEqual({
      status: 'queued',
      text: 'Checks start at X.',
      callout: null,
    });
    expect(
      checksSummary([{ status: 'needs_you', required: true }], 'Checks start at X.').text,
    ).toBe('1 check needs you');
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
    // S-25.15: a CI gate that never settled made no tamper check — muted, never *needs you* — while
    // one the platform could not evaluate (`unsupported`, which the tamper check also answers) does.
    expect(tamperStatus(stage('ci_gate', 1, 'failed', 'undecided'))).toBe('skipped');
    // Review of #118: only a stop whose `ci_ending` proves the pipeline unfinished, on this
    // attempt, says CI didn't finish; any other `undecided` (a finished pipeline whose changed files
    // were never listed, a silent provider) is *not checked yet*.
    const undecided = stage('ci_gate', 2, 'failed', 'undecided');
    const timedOut = {
      stage: 'ci_gate',
      attempt: 2,
      cause: 'no_answer' as const,
      loop: null,
      ci_failure: null,
      recorded: null,
      recorded_cut: false,
      ci_ending: 'ci_timed_out' as const,
    };
    expect(tamperValueText(undecided)).toBe(TAMPER_NOT_CHECKED_YET);
    expect(tamperValueText(undecided, null, timedOut)).toBe(TAMPER_NOT_CHECKED);
    expect(tamperValueText(undecided, null, { ...timedOut, ci_ending: 'ci_held_unchanged' })).toBe(
      TAMPER_NOT_CHECKED,
    );
    expect(tamperValueText(undecided, null, { ...timedOut, ci_ending: null })).toBe(
      TAMPER_NOT_CHECKED_YET,
    );
    // A stop recorded on an earlier attempt says nothing about this one.
    expect(tamperValueText(undecided, null, { ...timedOut, attempt: 1 })).toBe(
      TAMPER_NOT_CHECKED_YET,
    );
    expect(tamperStatus(stage('ci_gate', 1, 'failed', 'unsupported'))).toBe('needs_you');
    expect(tamperValueText(stage('ci_gate', 1, 'failed', 'unsupported'))).toBe(
      'needs you: it cannot be checked here',
    );
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

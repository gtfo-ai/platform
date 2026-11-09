/**
 * Home (`/`, S-23.7): needs you first, running now, the projects and the rail — and, on a new
 * instance, the setup checklist instead.
 *
 * Rewritten deliberately for the new layout. Driven through `createApp` with a fake server, so the
 * real endpoint parsers (strict schemas) read every DTO, and the router, the query cache and the
 * realtime bridge are the production ones. The checklist's done-ness *table* is
 * `home-setup.test.ts`; this file holds that the screen reads its facts from the server, draws one
 * primary button, renders untrusted text as text, and refreshes on an `org` frame.
 *
 * The WP-157 (a) banner cases (one broken organisation account, named once) are kept from the
 * dashboard this replaces.
 */
import type {
  AgentsResponse,
  ApprovalView,
  InboxResponse,
  IntegrationSummary,
  QuestionRecord,
  QueueWait,
  RunRecord,
  SseFrame,
  TaskDetailResponse,
  TaskRecord,
  UserRole,
  WorkerSummary,
} from '@platform/contracts';
import { sseFrameSchema } from '@platform/contracts';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';
import type { EventStream } from '../realtime/client.js';
import { WORKER_CLAIM_BLOCKER_WORDS } from '../ui/humanize.js';
import { ROW_LINK_ATTRIBUTE, ROW_LINK_HOST } from '../ui/row-link.js';
import { firstNameOf, greetingFor } from './dashboard.js';
import { workerFixture } from './worker.test-fixture.js';

const CONSEQUENCE =
  'Until they are replaced or the integration is retired, no project’s runs are given the project’s prompt files, because those files cannot be checked for these credentials.';

const PROJECT = (n: number) => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`;
const TASK = (n: number) => `00000000-0000-4000-8000-0000000002${String(n).padStart(2, '0')}`;
const RUN = '00000000-0000-4000-8000-000000000301';
// 2026-11-05 09:30 local time, so the greeting is a morning one wherever the test runs.
const NOW = new Date(2026, 10, 5, 9, 30).getTime();
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const session = (role: UserRole, name: string | null = 'Jan Example'): SessionResponse => ({
  user: { id: '00000000-0000-4000-8000-000000000001', email: 'jan@example.invalid', name, role },
  session: { id: '00000000-0000-4000-8000-000000000002' },
});

const integration = (
  type: IntegrationSummary['type'],
  over: Partial<IntegrationSummary> = {},
): IntegrationSummary => ({
  id: `00000000-0000-4000-8000-0000000000${type === 'git' ? 'c2' : type === 'communication' ? 'c3' : 'c1'}`,
  type,
  provider: type === 'git' ? 'gitlab' : type === 'communication' ? 'slack' : 'jira-cloud',
  name: `${type} account`,
  config: {},
  health: { status: 'unknown', checked_at: null, detail: null },
  config_refusal: null,
  retired_at: null,
  credentials_readable: null,
  credentials_consequence: null,
  activity: { last_call: null, last_delivery_at: null },
  current_health: { status: 'never_checked', basis: null, at: null },
  used_by: [],
  ...over,
});

const account = (readable: boolean | null): IntegrationSummary =>
  integration('communication', {
    name: '<b>acme workspace</b>',
    credentials_readable: readable,
    credentials_consequence: readable === false ? CONSEQUENCE : null,
  });

const CONNECTED = [integration('task_management'), integration('git')];

const project = (n: number, over: Record<string, unknown> = {}) => ({
  id: PROJECT(n),
  key: `p${n}`,
  name: `Project ${n}`,
  repo_url: `https://git.example.invalid/acme/p${n}.git`,
  default_branch: 'main',
  agentic_dir: '.agentic',
  knowledge_dir: 'knowledge',
  autonomy_level: 'supervised',
  readiness_level: 2,
  status: 'active',
  created_at: `2026-06-${String(n).padStart(2, '0')}T09:00:00.000Z`,
  updated_at: '2026-06-01T09:00:00.000Z',
  open_tasks: n,
  spent_usd_30d: 10 * n,
  ...over,
});

const task = (n: number, over: Partial<TaskRecord> = {}): TaskRecord => ({
  id: TASK(n),
  project_id: PROJECT(1),
  ticket: { provider: 'jira-cloud', key: `ACME-${n}`, url: 'https://jira.example.invalid/' },
  ticket_title: `Ticket ${n}`,
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
  created_at: minutesAgo(600),
  updated_at: minutesAgo(90),
  completed_at: null,
  ticket_claim: null,
  qa_stage: false,
  tracker_assignee: null,
  owner: null,
  owner_source: null,
  unlinked_assignee: null,
  owner_writes_back: false,
  waiting: null,
  ...over,
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

const question = (n: number, text: string, askedMinutesAgo: number): QuestionRecord => ({
  id: `00000000-0000-4000-8000-0000000004${String(n).padStart(2, '0')}`,
  task_id: TASK(n),
  stage: 'refinement',
  run_id: null,
  text,
  options: null,
  blocking: true,
  status: 'open',
  asked_at: minutesAgo(askedMinutesAgo),
  deadline_at: null,
  reminders_sent: 0,
  answer: null,
  answered_by_user_id: null,
  answered_via: null,
  answered_at: null,
});

const PLAN_ARTIFACT = '00000000-0000-4000-8000-000000000701';

const approval = (n: number, requestedMinutesAgo: number): ApprovalView => ({
  id: `00000000-0000-4000-8000-0000000005${String(n).padStart(2, '0')}`,
  task_id: TASK(n),
  kind: 'plan',
  status: 'pending',
  requested_at: minutesAgo(requestedMinutesAgo),
  deadline_at: null,
  decided_by_user_id: null,
  decided_at: null,
  reason: null,
});

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  id: RUN,
  task_id: TASK(7),
  project_id: PROJECT(1),
  stage: 'implementation',
  role: 'developer',
  mode: 'normal',
  attempt: 1,
  session_id: null,
  model: 'claude-test',
  effort: 'high',
  provider_mode: 'api',
  prompt_version: 'test@1',
  status: 'running',
  terminal_reason: null,
  started_at: minutesAgo(12),
  ended_at: null,
  last_output_at: null,
  num_turns: 1,
  usage: {
    input_tokens: 1,
    output_tokens: 1,
    cache_write_5m_tokens: 0,
    cache_write_1h_tokens: 0,
    cache_read_tokens: 0,
  },
  model_usage: [],
  cost: { usd: 0.84, is_estimate: false, price_list_id: null },
  wall_ms: 0,
  redaction_count: 0,
  settings_hash: null,
  start_failure: null,
  saved_work: null,
  latest_progress: null,
  ...over,
});

interface World {
  role: UserRole;
  name: string | null;
  integrations: IntegrationSummary[];
  projects: ReturnType<typeof project>[];
  questions: QuestionRecord[];
  approvals: ApprovalView[];
  /** S-26.8b part 2: the inbox read's `ci_held` (BACKLOG 1300); absent, none. */
  ciHeld?: InboxResponse['ci_held'];
  /** S-26.8b part 2: each agents row's `waiting`, by run id; absent, `null`. */
  waiting?: Readonly<Record<string, NonNullable<AgentsResponse['items'][number]['waiting']>>>;
  /** Every project's tasks; the fake filters by `state` the way the server does. */
  tasks: TaskRecord[];
  /** S-25.15 part B: the inbox read's `escalated`; absent, none. */
  escalated?: InboxResponse['escalated'];
  /** S-25.15 part B: each list item's `escalation_reason`, by task id; absent, `null`. */
  escalationReasons?: Readonly<Record<string, string>>;
  /** S-25.16: each list item's `queue_wait`, by task id; absent, `null`. */
  queueWaits?: Readonly<Record<string, QueueWait>>;
  runs: RunRecord[];
  /** `readiness` per project id: 200 when evaluated, 409 when not. */
  evaluated: Set<string>;
  /** Projects whose dial was applied. */
  materialised: Set<string>;
  monthCap: { limit: number; spent: number } | null;
  /** S-23.20: the execution read's `server_claimant`; absent, the read answers 404. */
  serverClaimant?: 'running' | 'none';
  workers: WorkerSummary[];
  /** S-25.6: the Operations reads' `total`s; `null`, the read answers 500. */
  stuckEvents: number | null;
  failedJobs: number | null;
  asked: string[];
}

const newWorld = (over: Partial<World> = {}): World => ({
  role: 'admin',
  name: 'Jan Example',
  integrations: [...CONNECTED],
  projects: [project(1)],
  questions: [],
  approvals: [],
  tasks: [task(9, { state: 'done' })],
  runs: [],
  evaluated: new Set(),
  materialised: new Set([PROJECT(1)]),
  monthCap: null,
  workers: [],
  stuckEvents: 0,
  failedJobs: 0,
  asked: [],
  ...over,
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fetchFor = (world: World) =>
  (async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(String(input), 'http://localhost');
    const path = url.pathname;
    world.asked.push(path);
    if (path === '/events/subscriptions') return json({});
    if (path.startsWith('/api/auth/get-session')) return json(session(world.role, world.name));
    // S-23.23: the server's own answer — `project.create` and `integration.write` are an admin's.
    if (path === '/api/integrations') {
      return json({ items: world.integrations, can_write: world.role === 'admin' });
    }
    if (path === '/api/projects') {
      return json({ items: world.projects, can_create: world.role === 'admin' });
    }
    if (path === '/api/workers')
      return json({ items: world.workers, scope: 'all', timezone: 'UTC' });
    if (/^\/api\/projects\/[^/]+\/execution$/.test(path) && world.serverClaimant !== undefined) {
      return json({
        mode: 'hybrid',
        prefer: 'server',
        fallback_after_seconds: null,
        assignee_window_seconds: 120,
        offer_timeout_seconds: 86_400,
        effective_fallback_after_seconds: 15,
        stored: false,
        server_claimant: world.serverClaimant,
        others_take_unassigned: false,
        notice: null,
        workers: [],
        waiting: {
          open: 0,
          closed_to_workers: { credential_refused: 0, server_only: 0, server_first: 0 },
        },
      });
    }
    if (path === '/api/org/agents') {
      return json({
        items: world.runs.map((entry) => ({
          run: entry,
          project_id: entry.project_id,
          task_id: entry.task_id,
          role: entry.role,
          last_output_at: null,
          seat: null,
          waiting: world.waiting?.[entry.id] ?? null,
          // S-25.7: the row shows the activity, so the fake carries the latest entry.
          activity: { kind: 'tool', tool_name: 'Read', at: minutesAgo(1) },
        })),
      });
    }
    if (path === '/api/org/inbox') {
      return json({
        questions: world.questions,
        approvals: world.approvals,
        ci_held: world.ciHeld ?? [],
        escalated: world.escalated ?? [],
      });
    }
    // The server refuses both below admin (`org.dead_letters.manage`); the fake does too.
    for (const [read, total] of [
      ['/api/org/dead-letters', world.stuckEvents],
      ['/api/org/failed-jobs', world.failedJobs],
    ] as const) {
      if (path !== read) continue;
      if (world.role !== 'admin') {
        return json({ error: { code: 'forbidden', message: 'admin only' } }, 403);
      }
      return total === null
        ? json({ error: { code: 'internal', message: 'the read failed' } }, 500)
        : json({ items: [], total, next_cursor: null });
    }
    if (path === `/api/artifacts/${PLAN_ARTIFACT}`) {
      return json({
        id: PLAN_ARTIFACT,
        task_id: TASK(4),
        artifact_type: 'ImplementationPlan',
        version: 3,
        schema_version: '1',
        produced_by_run_id: null,
        created_at: minutesAgo(130),
        redaction_count: 0,
        markdown: null,
        data: {
          estimated_size: 'M',
          files_to_change: [
            { path: 'src/a.ts', change: 'edit' },
            { path: 'src/b.ts', change: 'edit' },
          ],
        },
      });
    }
    if (path === '/api/org/budgets') {
      return json({
        items:
          world.monthCap === null
            ? []
            : [
                {
                  id: '00000000-0000-4000-8000-000000000601',
                  scope: 'org',
                  scope_id: null,
                  window: 'month',
                  limit_usd: world.monthCap.limit,
                  notify_pct: [80],
                  spent_usd: world.monthCap.spent,
                  window_start: '2026-11-01T00:00:00.000Z',
                },
              ],
      });
    }
    if (path === '/api/version') {
      return json({ version: '0.4.0-test', commit: null, built_at: null });
    }
    const projectRead = /^\/api\/projects\/([^/]+)\/(tasks|readiness|autonomy)$/.exec(path);
    if (projectRead !== null) {
      const [, id, what] = projectRead;
      if (what === 'tasks') {
        const state = url.searchParams.get('state');
        return json({
          // The board's page item: the record plus the card's glance (S-23.9a).
          items: world.tasks
            .filter((item) => item.project_id === id && (state === null || item.state === state))
            .map((item) => ({
              ...item,
              stages: [],
              open_questions: 0,
              pending_approvals: 0,
              loop_limits: null,
              gate_wait: null,
              latest_return: null,
              stop: null,
              escalation_reason: world.escalationReasons?.[item.id] ?? null,
              queue_wait: world.queueWaits?.[item.id] ?? null,
            })),
          next_cursor: null,
          can_start_task: true,
          can_cancel_task: true,
          can_return_to_stage: true,
          can_pause_task: true,
          can_resume_task: true,
        });
      }
      if (what === 'readiness') {
        return world.evaluated.has(id ?? '')
          ? json({
              level: 2,
              evaluated_at: '2026-10-07T05:00:00.000Z',
              source: 'discovery',
              criteria: [],
              next_improvements: [],
              notices: [],
            })
          : json({ error: { code: 'readiness_not_evaluated', message: 'not evaluated' } }, 409);
      }
      return json(autonomy(world.materialised.has(id ?? '')));
    }
    const taskRead = /^\/api\/tasks\/([^/]+)$/.exec(path);
    if (taskRead !== null) {
      const found = [...world.tasks, ...extraTasks(world)].find((item) => item.id === taskRead[1]);
      return found === undefined
        ? json({ error: { code: 'not_found', message: 'no such task' } }, 404)
        : json(detail(found));
    }
    return json({ error: { code: 'not_found', message: `no route ${path}` } }, 404);
  }) as typeof fetch;

/** The tasks the inbox rows and the runs point at, readable by id even when not listed. */
const extraTasks = (world: World): TaskRecord[] =>
  [
    ...world.questions.map((item) => item.task_id),
    ...world.approvals.map((item) => item.task_id),
    ...world.runs.map((item) => item.task_id),
  ].map((id) => task(Number(id.slice(-2)), { state: 'waiting_answers' }));

const autonomy = (materialised: boolean) => ({
  level: 'supervised',
  materialised,
  preset_version: 1,
  current_preset_version: 1,
  preset_outdated: false,
  applied_at: materialised ? '2026-10-07T05:00:00.000Z' : null,
  applied_by: null,
  policies: {
    picks_up_new_tickets: true,
    stop_after_stage: null,
    plan_approval: 'above_size',
    plan_approval_size_threshold: 'L',
    plan_approval_for_risk_classes: true,
    probation: true,
    probation_tasks: 2,
    business_review: true,
    question_timeout: '1 working day',
    human_mr_rounds: 3,
    knowledge_auto_apply: false,
    budget_approval_threshold_usd: 50,
    review_only: false,
    shadow_mode: false,
    suggested_readiness_min: 1,
  },
  is_custom: false,
  overrides: [],
  readiness_level: 2,
  suggested_cap: 'supervised',
  above_suggested_cap: false,
  organisation_maximum: null,
  level_in_force: 'supervised',
});

const start = (world: World, options: { openStream?: (url: string) => EventStream } = {}) =>
  render(
    createApp({
      fetchImpl: fetchFor(world),
      now: () => NOW,
      ...(options.openStream === undefined
        ? { realtime: false }
        : { openStream: options.openStream }),
    }).element,
  );

/** The page's primary buttons: the beacon tone's own border class, which nothing else draws. */
const primaries = (container: HTMLElement) =>
  [...container.querySelectorAll('main a, main button')].filter((element) =>
    element.className.includes('border-primary-line'),
  );

const box = (name: string) => screen.getByRole('region', { name });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  window.history.pushState({}, '', '/');
});

describe('the greeting', () => {
  it('greets by the time of day and the first name, never by the email', () => {
    expect(greetingFor(8)).toBe('Good morning');
    expect(greetingFor(12)).toBe('Good afternoon');
    expect(greetingFor(17)).toBe('Good afternoon');
    expect(greetingFor(18)).toBe('Good evening');
    const user = {
      id: '00000000-0000-4000-8000-000000000001',
      email: 'jan@example.invalid',
      name: 'Jan Example',
      role: 'member' as const,
    };
    expect(firstNameOf(user)).toBe('Jan');
    expect(firstNameOf({ ...user, name: null })).toBeNull();
    expect(firstNameOf({ ...user, name: '  ' })).toBeNull();
  });

  it('is the page’s heading', async () => {
    start(newWorld());
    await screen.findByRole('region', { name: 'Needs you' }, { timeout: 5000 });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Good morning, Jan.' }),
    ).toBeTruthy();
    const heading = screen.getByRole('heading', { level: 1 });
    // The brand's black weight, kept small (research/19 § 4.1).
    expect(heading.className).toContain('font-black');
  });
});

describe('Home, needs you first', () => {
  it('lists a CI check held at a manual job, which only a person can start (S-26.8b part 2)', async () => {
    const world = newWorld({
      ciHeld: [
        {
          task_id: TASK(7),
          project_id: PROJECT(1),
          ticket: {
            provider: 'jira',
            key: 'ACME-7',
            url: 'https://tickets.example.invalid/ACME-7',
          },
          gate_wait: {
            pipeline_id: '41',
            pipeline_url: null,
            status: 'manual',
            held_job: 'deploy',
            held_job_url: null,
            draft: false,
            checked_at: minutesAgo(1),
            waiting_since: minutesAgo(20),
            timeout_minutes: 60,
          },
        },
      ],
    });
    start(world);
    const needs = await screen.findByRole('list', { name: 'Needs you' });
    await waitFor(() => {
      expect(needs.textContent).toContain('CI waits for someone to start the manual job deploy');
    });
    expect(needs.textContent).toContain('ACME-7');
    expect(needs.textContent).toContain('CI');
    const link = within(needs).getByRole('link');
    expect(link.textContent).toContain('Open');
    expect(link.getAttribute('href')).toBe(`/tasks/${TASK(7)}`);
  });

  it('names the plan an approval is about — version, size, files — and its verb is Review plan', async () => {
    const world = newWorld({
      approvals: [
        {
          ...approval(4, 120),
          subject: {
            kind: 'plan',
            artifact_id: PLAN_ARTIFACT,
            artifact_version: 3,
            stage: 'architecture',
            attempt: 2,
            basis: 'recorded',
          },
          reasons: [{ code: 'probation', completed: 1, of: 5 }],
        },
      ],
    });
    start(world);
    const needs = await screen.findByRole('list', { name: 'Needs you' });
    await waitFor(() => {
      expect(needs.textContent).toContain('Plan v3 · size M · 2 files');
    });
    const link = within(needs).getByRole('link');
    expect(link.textContent).toContain('Review plan');
    expect(link.getAttribute('href')).toBe(`/tasks/${TASK(4)}`);
    // The row opens the task; it never approves (S-25.1).
    expect(within(needs).queryByRole('button', { name: /approve/i })).toBeNull();
  });

  it('lists questions, approvals and escalated tasks, oldest first, each with its action', async () => {
    const world = newWorld({
      questions: [question(3, 'Which retry budget, 3 or 5?\nThe ticket does not say.', 30)],
      approvals: [approval(4, 120)],
      tasks: [
        task(5, {
          state: 'needs_human',
          ticket_title: 'Budget cap hit',
          updated_at: minutesAgo(60),
        }),
        // Escalated, but its question is already a row above: one row, not two.
        task(3, { state: 'needs_human' }),
        task(6, { state: 'active' }),
      ],
    });
    start(world);
    const needs = await screen.findByRole('list', { name: 'Needs you' });
    await waitFor(() => {
      expect(within(needs).getAllByRole('listitem')).toHaveLength(3);
    });
    const rows = within(needs).getAllByRole('listitem');
    // Oldest first: the approval (2 h), the escalation (1 h), the question (30 min).
    // The approval names what it is about (S-25.1); this one was asked before that was recorded.
    expect(rows[0]?.textContent).toContain('Plan approval · the plan it is about was not recorded');
    expect(rows[1]?.textContent).toContain('Budget cap hit');
    expect(rows[2]?.textContent).toContain('Which retry budget, 3 or 5?');
    // Only the question's first line.
    expect(rows[2]?.textContent).not.toContain('The ticket does not say.');
    // Project key · ticket key · the stage's human name · age — the ticket key from the task read.
    await waitFor(() => {
      expect(rows[2]?.textContent).toContain('ACME-3');
    });
    expect(rows[2]?.textContent).toContain('p1');
    expect(rows[2]?.textContent).toContain('Refinement');
    expect(rows[2]?.textContent).toContain('30m 0s ago');
    expect(rows[1]?.textContent).toContain('Implementation');
    const actions = rows.map((row) => within(row).getByRole('link'));
    expect(actions.map((link) => link.textContent?.split(' ')[0])).toEqual([
      'Review',
      'Open',
      'Answer',
    ]);
    // *Review plan*, into the task — never *Approve*: no row approves in one click (S-25.1).
    expect(actions[0]?.textContent).toContain('Review plan');
    expect(actions[0]?.getAttribute('href')).toBe(`/tasks/${TASK(4)}`);
    expect(actions[2]?.getAttribute('href')).toBe(`/tasks/${TASK(3)}`);
    // S-23.26: the title is text, so each row's stretched link — what a click anywhere on the row
    // presses — is its action, into the task, and it is the only one.
    for (const [index, row] of rows.entries()) {
      expect(row.classList.contains(ROW_LINK_HOST)).toBe(true);
      expect([...row.querySelectorAll(`[${ROW_LINK_ATTRIBUTE}]`)]).toEqual([actions[index]]);
    }
    // The count says all three, and the header leads to the inbox.
    const header = box('Needs you');
    expect(within(header).getByText('3 waiting for you')).toBeTruthy();
    expect(within(header).getByRole('link', { name: 'View inbox →' }).getAttribute('href')).toBe(
      '/inbox',
    );
  });

  // S-25.15 part B: why a stopped task waits, in short form, on its row — every reason's kind.
  it('says why each stopped task waits: whose ticket it is, a key’s words, or Needs a person', async () => {
    const VOJTECH = 'Vojtěch <b>Kaizr</b>';
    const world = newWorld({
      tasks: [
        task(5, {
          state: 'needs_human',
          ticket: { provider: 'jira-cloud', key: 'ACME-5', url: 'https://jira.example.invalid/' },
          updated_at: minutesAgo(50),
          tracker_assignee: { display_name: VOJTECH, user_id: null },
          unlinked_assignee: { display_name: VOJTECH },
        }),
        task(6, {
          state: 'needs_human',
          updated_at: minutesAgo(40),
          tracker_assignee: null,
          unlinked_assignee: { display_name: null },
        }),
        task(7, { state: 'needs_human', updated_at: minutesAgo(30) }),
        task(8, { state: 'needs_human', updated_at: minutesAgo(20) }),
      ],
      escalationReasons: {
        [TASK(5)]: 'ticket_assigned_elsewhere',
        [TASK(6)]: 'ticket_assigned_elsewhere',
        [TASK(7)]: 'write_conflict',
        [TASK(8)]: 'stage "implementation" did not produce a verdict: error_max_turns',
      },
    });
    start(world);
    const needs = await screen.findByRole('list', { name: 'Needs you' });
    await waitFor(() => {
      expect(needs.querySelectorAll('[data-home-stop]')).toHaveLength(4);
    });
    const stops = [...needs.querySelectorAll('[data-home-stop]')].map((stop) => [
      stop.getAttribute('data-home-stop'),
      stop.textContent,
    ]);
    expect(stops).toEqual([
      ['held_elsewhere', `Waiting for: ${VOJTECH}’s Jira ticket`],
      ['held_nameless', 'Waiting for: a Jira ticket someone else holds'],
      ['worded', 'A write lost to another writer'],
      // The reason's own sentence is never the row; the meta line names the stage.
      ['generic', 'Needs a person'],
    ]);
    // The name is text, never markup (BD-022).
    expect(needs.querySelector('b')).toBeNull();
    const generic = needs.querySelector('[data-home-stop="generic"]')?.closest('li');
    expect(generic?.textContent).toContain('Implementation');
    expect(generic?.textContent).not.toContain('error_max_turns');
    // The title is still the ticket's, and the row still opens the task.
    expect(generic?.textContent).toContain('Ticket 8');
    expect(
      within(generic as HTMLElement)
        .getByRole('link')
        .getAttribute('href'),
    ).toBe(`/tasks/${TASK(8)}`);
  });

  it('dates a stopped task’s row by when it stopped, when the inbox read lists it', async () => {
    const stoppedRow = (n: number, minutes: number): InboxResponse['escalated'][number] => ({
      task_id: TASK(n),
      project_id: PROJECT(1),
      ticket: { provider: 'jira-cloud', key: `ACME-${n}`, url: 'https://jira.example.invalid/' },
      ticket_title: `Ticket ${n}`,
      current_stage: 'implementation',
      reason: 'converged',
      at: minutesAgo(minutes),
      tracker_assignee: null,
      unlinked_assignee: null,
    });
    const world = newWorld({
      tasks: [
        task(5, { state: 'needs_human', updated_at: minutesAgo(5) }),
        // Not in the read (past its cap, say): its last update, as before.
        task(6, { state: 'needs_human', updated_at: minutesAgo(10) }),
      ],
      escalated: [stoppedRow(5, 90)],
      escalationReasons: { [TASK(5)]: 'converged', [TASK(6)]: 'converged' },
    });
    start(world);
    const needs = await screen.findByRole('list', { name: 'Needs you' });
    await waitFor(() => {
      expect(needs.querySelectorAll('[data-home-stop]')).toHaveLength(2);
    });
    const rows = within(needs).getAllByRole('listitem');
    // Oldest first by that time: ACME-5 stopped 90 minutes ago, though it was updated 5 ago.
    expect(rows[0]?.textContent).toContain('ACME-5');
    expect(rows[0]?.textContent).toContain('1h 30m ago');
    expect(rows[0]?.textContent).not.toContain('5m 0s ago');
    expect(rows[1]?.textContent).toContain('ACME-6');
    expect(rows[1]?.textContent).toContain('10m 0s ago');
  });

  it('says no stop on a question’s row, nor on an approval’s (the control)', async () => {
    const world = newWorld({
      questions: [question(3, 'Which retry budget?', 30)],
      approvals: [approval(4, 120)],
      tasks: [task(3, { state: 'needs_human' })],
      escalationReasons: { [TASK(3)]: 'ticket_assigned_elsewhere' },
    });
    start(world);
    const needs = await screen.findByRole('list', { name: 'Needs you' });
    await waitFor(() => {
      expect(within(needs).getAllByRole('listitem')).toHaveLength(2);
    });
    expect(needs.querySelector('[data-home-stop]')).toBeNull();
  });

  it('says so calmly when nothing needs you', async () => {
    start(newWorld());
    expect(await screen.findByText('Nothing needs you right now.')).toBeTruthy();
    // Informational: no button to press about it.
    expect(within(box('Needs you')).queryByRole('button')).toBeNull();
  });

  it('renders a question an agent wrote as text, never as markup', async () => {
    const hostile = '<img src=x onerror="window.__pwned=1"> **bold** [x](javascript:alert(1))';
    start(newWorld({ questions: [question(3, hostile, 5)] }));
    const needs = await screen.findByRole('list', { name: 'Needs you' });
    await waitFor(() => {
      expect(needs.textContent).toContain('<img src=x onerror="window.__pwned=1">');
    });
    expect(needs.querySelector('img')).toBeNull();
    expect(needs.querySelector('strong')).toBeNull();
    expect(needs.querySelector('a[href^="javascript"]')).toBeNull();
  });
});

describe('Home, a queue the stopped tasks hold (S-25.16)', () => {
  const waiting = (
    needsHuman: number,
    reason: 'max_tasks_in_pipeline' | 'max_parallel_tasks',
  ): QueueWait => ({
    status: 'waiting',
    reason,
    count: 5,
    limit: 5,
    position: 1,
    queued: 5,
    running: { count: reason === 'max_parallel_tasks' ? 2 : 0, limit: 2 },
    pipeline: { count: reason === 'max_parallel_tasks' ? 2 : 5, limit: 5 },
    holders: {
      total: 5,
      needs_human: needsHuman,
      items: [{ task_id: TASK(3), ticket_key: 'ACME-3', state: 'needs_human' }],
    },
  });

  it('says how many tickets cannot start, linked to the board’s queue', async () => {
    const world = newWorld({
      tasks: [task(3, { state: 'needs_human' }), task(11, { state: 'queued' })],
      queueWaits: { [TASK(11)]: waiting(5, 'max_tasks_in_pipeline') },
    });
    start(world);
    const needs = await screen.findByRole('list', { name: 'Needs you' });
    const line = await within(needs).findByRole('link', {
      name: '5 tickets can’t start until these are decided or cancelled',
    });
    expect(line.getAttribute('href')).toBe('/projects/p1#queued-tasks');
    expect(needs.querySelector('[data-home-queue="p1"]')).not.toBeNull();
  });

  it.each<readonly [string, QueueWait]>([
    ['a parallel-tasks wait (running tasks hold it)', waiting(0, 'max_parallel_tasks')],
    ['a pipeline wait nobody stopped holds', waiting(0, 'max_tasks_in_pipeline')],
    [
      'a queue the limits admit',
      {
        status: 'admitted',
        position: 1,
        queued: 1,
        running: { count: 0, limit: 2 },
        pipeline: { count: 1, limit: 5 },
      },
    ],
  ])('says nothing for %s', async (_name, wait) => {
    // Project 2's queue is held: its line proves the queued reads answered before the assertion.
    const world = newWorld({
      projects: [project(1), project(2)],
      tasks: [
        task(3, { state: 'needs_human' }),
        task(11, { state: 'queued' }),
        task(21, { state: 'needs_human', project_id: PROJECT(2) }),
        task(22, { state: 'queued', project_id: PROJECT(2) }),
      ],
      queueWaits: { [TASK(11)]: wait, [TASK(22)]: waiting(1, 'max_tasks_in_pipeline') },
    });
    start(world);
    const needs = await screen.findByRole('list', { name: 'Needs you' });
    await waitFor(() => {
      expect(needs.querySelector('[data-home-queue="p2"]')).not.toBeNull();
    });
    expect(needs.querySelector('[data-home-queue="p1"]')).toBeNull();
  });
});

describe('Home, running now', () => {
  it('lists each live run with where it is, what it is doing, elapsed time, cost and latest progress', async () => {
    const world = newWorld({
      runs: [
        run({
          latest_progress: {
            seq: 4,
            at: minutesAgo(1),
            summary: 'Writing the <script>migration</script>\nthen the tests',
            percent_complete: null,
          },
        }),
      ],
    });
    start(world);
    const list = await screen.findByRole('list', { name: 'Running now' });
    const link = await within(list).findByRole('link', { name: 'Implementation · Developer' });
    expect(link.getAttribute('href')).toBe(`/runs/${RUN}`);
    const row = link.closest('li') as HTMLElement;
    // S-23.26: the run's link is the row's stretched link.
    expect(row.classList.contains(ROW_LINK_HOST)).toBe(true);
    expect([...row.querySelectorAll(`[${ROW_LINK_ATTRIBUTE}]`)]).toEqual([link]);
    await waitFor(() => {
      expect(row.textContent).toContain('ACME-7');
    });
    expect(row.textContent).toContain('p1');
    // What it is doing in the one activity vocabulary — never the model id (BACKLOG 1262).
    expect(row.querySelector('[data-home-activity]')?.textContent).toBe('Working: Reading files');
    expect(row.textContent).not.toContain('claude-test');
    expect(row.textContent).toContain('12m 0s');
    expect(row.textContent).toContain('$0.84');
    expect(row.textContent).toContain('Writing the <script>migration</script>');
    expect(row.textContent).not.toContain('then the tests');
    expect(row.querySelector('script')).toBeNull();
    expect(within(box('Running now')).getByRole('link', { name: 'Agents →' })).toBeTruthy();
  });

  it('says why a run waits for a machine, and "your machine" to its owner (S-26.8b part 2)', async () => {
    const offline = {
      reason: 'owner_worker_offline' as const,
      user: { user_id: '00000000-0000-4000-8000-00000000a001', name: 'Vojtěch' },
      last_seen_at: minutesAgo(120),
      assignee_name: null,
      blockers: [],
    };
    start(
      newWorld({
        runs: [run({ status: 'created', started_at: null })],
        waiting: { [RUN]: offline },
      }),
    );
    const list = await screen.findByRole('list', { name: 'Running now' });
    await waitFor(() => {
      expect(list.querySelector('[data-home-activity]')?.textContent).toBe(
        'Waiting · Vojtěch’s machine is offline',
      );
    });
    expect(list.querySelector('[data-home-waiting]')?.getAttribute('data-home-waiting')).toBe(
      'owner_worker_offline',
    );
  });

  it('says so when no agent is running', async () => {
    start(newWorld());
    expect(await screen.findByText('No agent is running right now.')).toBeTruthy();
  });
});

describe('Home, the projects and the rail', () => {
  it('lists every project compactly, the month against its cap, and the instance', async () => {
    const { container } = start(
      newWorld({
        projects: [project(1), project(2, { readiness_level: 0 })],
        monthCap: { limit: 1000, spent: 412 },
        tasks: [task(9, { state: 'done' })],
        evaluated: new Set([PROJECT(2)]),
      }),
    );
    const list = await screen.findByRole('list', { name: 'Projects' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    const projectLink = within(rows[0] as HTMLElement).getByRole('link', { name: 'Project 1' });
    // S-23.26: the project's name is the row's stretched link.
    expect(projectLink.hasAttribute(ROW_LINK_ATTRIBUTE)).toBe(true);
    // S-25.2: what agents may do, as the popover trigger that defines it.
    expect(
      within(rows[0] as HTMLElement).getByRole('button', {
        name: 'Readiness: Big plans need your OK',
      }),
    ).toBeTruthy();
    expect(rows[0]?.textContent).toContain('1 open');
    expect(rows[0]?.textContent).toContain('$10.00 · 30d');
    expect(
      within(rows[1] as HTMLElement)
        .getByRole('button', { name: 'Readiness: Plans need your OK' })
        .getAttribute('data-readiness-tone'),
    ).toBe('neutral');

    const spend = box('Spend');
    expect(await within(spend).findByText('$412.00 of $1,000.00')).toBeTruthy();
    const meter = spend.querySelector('meter');
    expect(meter?.getAttribute('value')).toBe('412');
    expect(meter?.getAttribute('max')).toBe('1000');
    expect(meter?.hasAttribute('style')).toBe(false);
    // The old organisation metric, moved here with its definition.
    expect(within(spend).getByText('Spend, last 30 days')).toBeTruthy();
    expect(within(spend).getByText('$30.00')).toBeTruthy();
    // S-25.7 (research/21 F8): Spend leads on to the caps and to what the spend bought.
    expect(
      within(spend).getByRole('link', { name: 'Organisation budgets' }).getAttribute('href'),
    ).toBe('/settings/budgets');
    expect(within(spend).getByRole('link', { name: 'Statistics' }).getAttribute('href')).toBe(
      '/stats',
    );

    const instance = box('Instance');
    expect(await within(instance).findByText('0.4.0-test')).toBeTruthy();
    expect(within(instance).getByText('Idle')).toBeTruthy();

    // Setup is finished, so the checklist is gone and New project is the one primary action.
    await waitFor(() => {
      expect(primaries(container).map((element) => element.textContent)).toEqual(['New project']);
    });
    expect(screen.queryByRole('region', { name: 'Set up' })).toBeNull();
  });

  it('says there is no monthly cap rather than drawing an empty meter', async () => {
    start(newWorld());
    expect(await screen.findByText('No monthly cap is set for the organisation.')).toBeTruthy();
    expect(box('Spend').querySelector('meter')).toBeNull();
  });
});

describe('Home on a new instance: the setup checklist', () => {
  const stepStates = () =>
    within(screen.getByRole('list', { name: 'Setup steps' }))
      .getAllByRole('listitem')
      .map((item) => item.getAttribute('data-step-state'));

  it('is the whole page for an admin with no integration and no project', async () => {
    const world = newWorld({ integrations: [], projects: [], tasks: [] });
    const { container } = start(world);
    expect(await screen.findByRole('heading', { name: 'Set up your instance' })).toBeTruthy();
    expect(stepStates()).toEqual(['current', 'upcoming', 'upcoming', 'upcoming', 'upcoming']);
    const primary = primaries(container);
    expect(primary.map((element) => element.textContent)).toEqual(['Continue setup']);
    expect(primary[0]?.getAttribute('href')).toBe('/integrations');
    // Home *is* the checklist: no boxes behind it.
    expect(screen.queryByRole('region', { name: 'Needs you' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Projects' })).toBeNull();
  });

  it('ticks what the server says is done, and continues at the first step that is not', async () => {
    // Connected, and no project yet.
    const world = newWorld({ projects: [], tasks: [] });
    const { container } = start(world);
    await screen.findByRole('heading', { name: 'Set up your instance' });
    expect(stepStates()).toEqual(['done', 'current', 'upcoming', 'upcoming', 'upcoming']);
    expect(primaries(container)[0]?.getAttribute('href')).toBe('/onboarding');
  });

  it('moves to the rail once a project exists, and resumes that project in the wizard', async () => {
    const world = newWorld({
      projects: [project(1, { readiness_level: 0 }), project(2, { readiness_level: 3 })],
      materialised: new Set(),
      tasks: [
        // The platform's own discovery task is not "your first ticket".
        task(9, {
          ticket: { provider: 'platform', key: 'discovery', url: 'https://agentic.example.test/' },
          template: 'discovery',
        }),
      ],
    });
    const { container } = start(world);
    const setup = await screen.findByRole('region', { name: 'Set up' });
    expect(within(setup).getByRole('heading', { name: 'Finish setting up' })).toBeTruthy();
    await waitFor(() => {
      // The oldest project (p1) is the one followed: level 0 and a 409 readiness — not discovered.
      expect(stepStates()).toEqual(['done', 'done', 'current', 'upcoming', 'upcoming']);
    });
    expect(world.asked).toContain(`/api/projects/${PROJECT(1)}/readiness`);
    const primary = primaries(container);
    expect(primary.map((element) => element.textContent)).toEqual(['Continue setup']);
    expect(primary[0]?.getAttribute('href')).toBe('/onboarding?project=p1');
    // New project steps back to a default button while setup is unfinished.
    expect(
      within(box('Projects')).getByRole('link', { name: 'New project' }).className,
    ).not.toContain('border-primary-line');
    // Needs you still comes first.
    expect(screen.getByRole('region', { name: 'Needs you' })).toBeTruthy();
  });

  it('ends at the board’s start form when only the first ticket is left', async () => {
    const world = newWorld({ tasks: [] });
    const { container } = start(world);
    await screen.findByRole('region', { name: 'Set up' });
    await waitFor(() => {
      expect(stepStates()).toEqual(['done', 'done', 'done', 'done', 'current']);
    });
    expect(primaries(container)[0]?.getAttribute('href')).toBe('/projects/p1#start-ticket');
  });

  it('adds Connect a worker before the first ticket only where the platform has no server runner', async () => {
    // A server runner: no worker step, and the workers are not even asked for.
    let world = newWorld({ tasks: [], serverClaimant: 'running' });
    start(world);
    await screen.findByRole('region', { name: 'Set up' });
    await waitFor(() => {
      expect(stepStates()).toEqual(['done', 'done', 'done', 'done', 'current']);
    });
    expect(world.asked).toContain(`/api/projects/${PROJECT(1)}/execution`);
    expect(world.asked).not.toContain('/api/workers');
    cleanup();

    // None, and no worker yet: the step leads, to the wizard.
    world = newWorld({ tasks: [], serverClaimant: 'none' });
    const { container } = start(world);
    await screen.findByRole('region', { name: 'Set up' });
    await waitFor(() => {
      expect(stepStates()).toEqual(['done', 'done', 'done', 'done', 'current', 'upcoming']);
    });
    expect(screen.getByRole('link', { name: 'Connect a worker' })).toBeTruthy();
    expect(primaries(container)[0]?.getAttribute('href')).toBe('/workers/new');
  });

  it('names a worker that cannot take work and resumes the wizard at Ready for it', async () => {
    const created = minutesAgo(30);
    const world = newWorld({
      tasks: [],
      serverClaimant: 'none',
      workers: [
        workerFixture({
          name: 'jan-mbp',
          created_at: created,
          last_seen_at: minutesAgo(20),
          // The server's answer, in the words both sides use (S-22.19, S-23.24).
          claim_blockers: ['offline', 'images_outdated'],
          can_claim: false,
        }),
      ],
    });
    const { container } = start(world);
    await screen.findByRole('region', { name: 'Set up' });
    await screen.findByText(
      `jan-mbp can’t take work yet: not connected to the platform. ${WORKER_CLAIM_BLOCKER_WORDS.offline.fix}`,
    );
    expect(primaries(container)[0]?.getAttribute('href')).toBe(
      `/workers/new?step=ready&since=${encodeURIComponent(created)}`,
    );
  });

  it('says a worker that is updating itself is updating, not that it can’t take work (S-23.27)', async () => {
    const world = newWorld({
      tasks: [],
      serverClaimant: 'none',
      workers: [
        workerFixture({
          name: 'jan-mbp',
          created_at: minutesAgo(30),
          last_seen_at: minutesAgo(0),
          claim_blockers: ['draining', 'images_outdated'],
          can_claim: false,
        }),
      ],
    });
    start(world);
    await screen.findByRole('region', { name: 'Set up' });
    await screen.findByText(
      'jan-mbp is updating now. Its updater is bringing it up to date. Nothing to do; this usually takes a minute or two.',
    );
    expect(screen.queryByText(/jan-mbp can’t take work yet/)).toBeNull();
  });

  it('ticks Connect a worker once a worker can take work', async () => {
    const world = newWorld({
      tasks: [],
      serverClaimant: 'none',
      workers: [workerFixture({ created_at: minutesAgo(30), last_seen_at: minutesAgo(0) })],
    });
    const { container } = start(world);
    await screen.findByRole('region', { name: 'Set up' });
    await waitFor(() => {
      expect(stepStates()).toEqual(['done', 'done', 'done', 'done', 'done', 'current']);
    });
    expect(primaries(container)[0]?.getAttribute('href')).toBe('/projects/p1#start-ticket');
  });

  it('is not shown to a member, who is told who sets the instance up', async () => {
    const world = newWorld({ role: 'member', integrations: [], projects: [], tasks: [] });
    const { container } = start(world);
    expect(await screen.findByText('Nothing is set up yet')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Setup steps' })).toBeNull();
    expect(primaries(container)).toHaveLength(0);
    expect(world.asked).not.toContain('/api/integrations');
  });
});

describe('Home once the setup project has run a ticket (S-25.6, research/21 F10)', () => {
  it('drops the checklist on a working install, though discovery and the dial were never ticked', async () => {
    // The F10 install: a ticket ran (task 9, a Jira ticket), and readiness 0 with no evaluation and
    // a dial never applied would have read "3 of 5 done" for good.
    const world = newWorld({
      projects: [project(1, { readiness_level: 0 })],
      materialised: new Set(),
    });
    const { container } = start(world);
    await screen.findByRole('link', { name: 'Project 1' });
    await waitFor(() => {
      expect(world.asked).toContain(`/api/projects/${PROJECT(1)}/tasks`);
    });
    await waitFor(() => {
      expect(primaries(container).map((element) => element.textContent)).toEqual(['New project']);
    });
    expect(screen.queryByRole('region', { name: 'Set up' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Missing from setup' })).toBeNull();
  });

  it('names a missing git host, what that costs, and where to connect one', async () => {
    const world = newWorld({ integrations: [integration('task_management')] });
    const { container } = start(world);
    const missing = await screen.findByRole('region', { name: 'Missing from setup' });
    expect(missing.textContent).toContain(
      'Merge requests can’t be opened until a git host is connected.',
    );
    expect(
      within(missing).getByRole('link', { name: 'Connect a git host →' }).getAttribute('href'),
    ).toBe('/integrations');
    // The checklist that said "4 of 5 done" with step 1 current is gone.
    expect(screen.queryByRole('region', { name: 'Set up' })).toBeNull();
    expect(screen.queryByText(/of 5 done/)).toBeNull();
    // The missing piece is a link, not a second primary: New project stays the page's one.
    expect(primaries(container).map((element) => element.textContent)).toEqual(['New project']);
  });

  it('names a missing worker where nothing on the server runs the project', async () => {
    const world = newWorld({ serverClaimant: 'none' });
    start(world);
    const missing = await screen.findByRole('region', { name: 'Missing from setup' });
    await waitFor(() => {
      expect(missing.querySelector('[data-missing-piece="worker"]')).not.toBeNull();
    });
    expect(
      within(missing).getByRole('link', { name: 'Connect a worker →' }).getAttribute('href'),
    ).toBe('/workers/new');
  });
});

describe('Home: background failures in Needs you, for an administrator (S-25.6, F14)', () => {
  it('adds a row per failing kind with its count, each to its settings section', async () => {
    const world = newWorld({
      questions: [question(1, 'Which currency?', 5)],
      stuckEvents: 3,
      failedJobs: 1,
    });
    start(world);
    const needs = await screen.findByRole('region', { name: 'Needs you' });
    const stuck = await within(needs).findByRole('link', { name: 'Review 3 events are stuck' });
    expect(stuck.getAttribute('href')).toBe('/settings/dead-letters');
    expect(
      within(needs)
        .getByRole('link', { name: 'Review 1 background job failed' })
        .getAttribute('href'),
    ).toBe('/settings/failed-jobs');
    // The count is every row: one question and the two background rows.
    await waitFor(() => {
      expect(within(needs).getByText('3 waiting for you')).toBeTruthy();
    });
    // After the people's rows.
    const rows = within(within(needs).getByRole('list', { name: 'Needs you' })).getAllByRole(
      'listitem',
    );
    expect(rows[0]?.textContent).toContain('Which currency?');
  });

  it('draws no row for a count of zero', async () => {
    const world = newWorld({ stuckEvents: 0, failedJobs: 0 });
    start(world);
    expect(await screen.findByText('Nothing needs you right now.')).toBeTruthy();
    expect(document.querySelector('[data-home-background]')).toBeNull();
    expect(world.asked).toContain('/api/org/dead-letters');
    expect(world.asked).toContain('/api/org/failed-jobs');
  });

  it.each([
    ['the stuck events', { stuckEvents: null, failedJobs: 0 }],
    ['the failed jobs', { stuckEvents: 0, failedJobs: null }],
  ] as const)(
    'says the failures could not be checked when %s read fails, and claims no count or calm (review of #83)',
    async (_what, counts) => {
      const world = newWorld(counts);
      start(world);
      const needs = await screen.findByRole('region', { name: 'Needs you' });
      expect(
        await within(needs).findByText('Background failures could not be checked.'),
      ).toBeTruthy();
      // Calibrated: the box is settled (the inbox answered), yet it says neither "Nothing needs you"
      // nor "0 waiting": an unknown is not a zero.
      await waitFor(() => {
        expect(world.asked).toContain('/api/org/inbox');
      });
      expect(within(needs).queryByText('Nothing needs you right now.')).toBeNull();
      expect(within(needs).queryByText(/waiting for you$/)).toBeNull();
      expect(needs.querySelector('[data-home-background]')).toBeNull();
    },
  );

  it('is not asked for, nor shown, below administrator', async () => {
    const world = newWorld({ role: 'maintainer', stuckEvents: 3, failedJobs: 1 });
    // (Asked anyway, the fake would refuse a maintainer with 403, as the server does.)
    start(world);
    await screen.findByRole('link', { name: 'Project 1' });
    expect(await screen.findByText('Nothing needs you right now.')).toBeTruthy();
    expect(document.querySelector('[data-home-background]')).toBeNull();
    expect(world.asked).not.toContain('/api/org/dead-letters');
    expect(world.asked).not.toContain('/api/org/failed-jobs');
  });
});

describe('Home for a role that cannot create a project', () => {
  it('offers no New project, so the page has no primary action', async () => {
    const world = newWorld({ role: 'maintainer', projects: [project(1)] });
    const { container } = start(world);
    await screen.findByRole('link', { name: 'Project 1' });
    expect(within(box('Projects')).queryByRole('link', { name: 'New project' })).toBeNull();
    expect(primaries(container)).toHaveLength(0);
    expect(screen.queryByRole('region', { name: 'Set up' })).toBeNull();
  });
});

describe('Home, live', () => {
  it('refreshes Needs you when the org topic carries a question’s event', async () => {
    const world = newWorld();
    const { streams, openStream } = fakeStreams();
    start(world, { openStream });
    expect(await screen.findByText('Nothing needs you right now.')).toBeTruthy();
    await waitFor(() => {
      expect(streams.length).toBeGreaterThan(0);
    });
    world.questions = [question(3, 'Is the new endpoint public?', 1)];
    act(() => {
      streams.at(-1)?.open();
      streams.at(-1)?.emit(questionAsked(), 'org:1');
    });
    const needs = screen.getByRole('list', { name: 'Needs you' });
    expect(await within(needs).findByText('Is the new endpoint public?')).toBeTruthy();
  });

  it('adds a run to Running now when the org topic carries a run’s event', async () => {
    const world = newWorld();
    const { streams, openStream } = fakeStreams();
    start(world, { openStream });
    expect(await screen.findByText('No agent is running right now.')).toBeTruthy();
    await waitFor(() => {
      expect(streams.length).toBeGreaterThan(0);
    });
    world.runs = [run()];
    act(() => {
      streams.at(-1)?.open();
      streams.at(-1)?.emit(runStarted(), 'org:2');
    });
    const list = screen.getByRole('list', { name: 'Running now' });
    expect(
      await within(list).findByRole('link', { name: 'Implementation · Developer' }),
    ).toBeTruthy();
    expect(screen.queryByText('No agent is running right now.')).toBeNull();
  });
});

describe('the dashboard and a broken organisation account (WP-157 (a), backlog 413)', () => {
  it('renders exactly one banner for one undecryptable account, whatever the project count', async () => {
    for (const projects of [1, 5]) {
      const world = newWorld({
        role: 'maintainer',
        integrations: [account(false)],
        projects: Array.from({ length: projects }, (_, index) => project(index + 1)),
      });
      const { container, unmount } = start(world);
      await screen.findByText(`Project ${projects}`);
      await waitFor(() => {
        expect(container.querySelectorAll('[data-unreadable-accounts]')).toHaveLength(1);
      });
      const banner = container.querySelector('[data-unreadable-accounts]');
      // The account is named, as text (BD-022), with the consequence the server wrote — and
      // neither the provider's slug nor "decrypted" (S-23.22).
      expect(banner?.textContent).toContain(
        'An integration’s credentials can no longer be read: <b>acme workspace</b>.',
      );
      expect(banner?.textContent).not.toContain('(slack)');
      expect(banner?.textContent).toContain(
        'no project’s runs are given the project’s prompt files',
      );
      // The way to the fix is a link to the integration itself.
      expect(banner?.querySelector('a')?.getAttribute('href')).toMatch(/^\/integrations\/[^/]+$/);
      expect(container.querySelector('b')).toBeNull();
      // One signal, not one per project row.
      expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
      unmount();
    }
  });

  it('renders none when the account decrypts, or when the read did not check it', async () => {
    for (const readable of [true, null]) {
      const world = newWorld({
        integrations: [...CONNECTED, account(readable)],
        projects: [project(1), project(2), project(3)],
      });
      const { container, unmount } = start(world);
      await screen.findByText('Project 3');
      // The list was read, so the absence below is an answer and not a pending query.
      await waitFor(() => {
        expect(world.asked).toContain('/api/integrations');
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(container.querySelector('[data-unreadable-accounts]')).toBeNull();
      expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
      unmount();
    }
  });

  it('does not ask a role that cannot read integrations', async () => {
    const world = newWorld({
      role: 'member',
      integrations: [account(false)],
      projects: [project(1), project(2)],
    });
    const { container } = start(world);
    await screen.findByText('Project 2');
    expect(container.querySelector('[data-unreadable-accounts]')).toBeNull();
    expect(world.asked).not.toContain('/api/integrations');
  });
});

/** A `run.started` frame on the `org` topic: ids only, as the server projects it (S-23.14). */
const runStarted = (): SseFrame =>
  sseFrameSchema.parse({
    frame: 'domain_event',
    topic: 'org',
    seq: 2,
    type: 'run.started',
    data: {
      id: '00000000-0000-4000-8000-0000000000e2',
      type: 'run.started',
      stream_type: 'run',
      stream_id: RUN,
      occurred_at: minutesAgo(0),
      project_id: PROJECT(1),
      task_id: TASK(7),
      run_id: RUN,
    },
  });

/** A `task.question.asked` frame on the `org` topic, parsed with the published schema (S-23.14). */
const questionAsked = (): SseFrame =>
  sseFrameSchema.parse({
    frame: 'domain_event',
    topic: 'org',
    seq: 1,
    type: 'task.question.asked',
    // The server's projection: ids only — the question's words stay behind the read API.
    data: {
      id: '00000000-0000-4000-8000-0000000000e1',
      type: 'task.question.asked',
      stream_type: 'task',
      stream_id: TASK(3),
      occurred_at: minutesAgo(1),
      project_id: PROJECT(1),
      task_id: TASK(3),
    },
  });

/** A fake `EventSource` the test can speak SSE frames into (`onboarding-status.test.tsx`'s shape). */
const fakeStreams = () => {
  const streams: {
    readonly url: string;
    readonly emit: (frame: SseFrame, id: string) => void;
    readonly open: () => void;
  }[] = [];
  const openStream = (url: string): EventStream => {
    const listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();
    streams.push({
      url,
      emit: (frame, id) => {
        const message = new MessageEvent<string>('message', {
          data: JSON.stringify(frame),
          lastEventId: id,
        });
        for (const listener of listeners.get('message') ?? []) listener(message);
      },
      open: () => {
        for (const listener of listeners.get('open') ?? []) {
          listener(new MessageEvent<string>('open', { data: '' }));
        }
      },
    });
    return {
      addEventListener: (type, listener) => {
        listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      },
      close: () => undefined,
    };
  };
  return { streams, openStream };
};

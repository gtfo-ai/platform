/**
 * Builders for the fleet's tests (S-23.6): a run, an agents item, a worker, a task's facts — each
 * the published contract's shape, with obviously fake values, overridable field by field.
 */
import type {
  InboxResponse,
  RunRecord,
  TaskDetailResponse,
  WorkerSummary,
} from '@platform/contracts';
import type { AgentItem, FleetTaskFacts } from './model.js';

export const NOW = Date.parse('2026-11-05T16:45:00.000Z');
export const PROJECT = '00000000-0000-4000-8000-0000000000a1';

/** A uuid whose last group is `n`, for runs, tasks and workers alike. */
export const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const usage = {
  input_tokens: 1,
  output_tokens: 1,
  cache_write_5m_tokens: 0,
  cache_write_1h_tokens: 0,
  cache_read_tokens: 0,
};

export const runRecord = (n: number, overrides: Partial<RunRecord> = {}): RunRecord => ({
  id: uuid(n),
  task_id: uuid(1000 + n),
  project_id: PROJECT,
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
  started_at: '2026-11-05T16:40:00.000Z',
  ended_at: null,
  last_output_at: null,
  num_turns: 1,
  usage,
  model_usage: [],
  cost: { usd: 0.42, is_estimate: false, price_list_id: null },
  wall_ms: 0,
  redaction_count: 0,
  settings_hash: null,
  start_failure: null,
  saved_work: null,
  latest_progress: null,
  ...overrides,
});

/** An agents item: by default a running developer on the server, reading files a minute ago. */
export const agentItem = (
  n: number,
  overrides: { readonly run?: Partial<RunRecord> } & Partial<Omit<AgentItem, 'run'>> = {},
): AgentItem => {
  const { run: runOverrides, ...rest } = overrides;
  const run = runRecord(n, runOverrides);
  return {
    run,
    project_id: run.project_id,
    task_id: run.task_id,
    role: run.role,
    last_output_at: null,
    seat: { kind: 'server', worker_id: null, worker_name: null },
    activity: { kind: 'tool', tool_name: 'Read', at: '2026-11-05T16:44:00.000Z' },
    ...rest,
  };
};

export const workerSeat = (n: number, name: string | null = `worker-${n}`): AgentItem['seat'] => ({
  kind: 'worker',
  worker_id: uuid(n),
  worker_name: name,
});

export const worker = (n: number, overrides: Partial<WorkerSummary> = {}): WorkerSummary => ({
  id: uuid(n),
  name: `worker-${n}`,
  user: { id: uuid(9), email: 'owner@example.invalid', name: 'Fake Owner' },
  created_at: '2026-11-01T00:00:00.000Z',
  last_seen_at: '2026-11-05T16:44:00.000Z',
  protocol_version: 1,
  image_digests: [],
  state: 'active',
  revoked_at: null,
  paused_until: null,
  paused_until_estimated: false,
  manually_paused_at: null,
  claim_projects: null,
  paused_reason: null,
  concurrency: 3,
  running: [],
  last_update: null,
  claim_blockers: [],
  can_claim: true,
  last_claimed_at: null,
  ...overrides,
});

export const facts = (key: string, overrides: Partial<FleetTaskFacts> = {}): FleetTaskFacts => ({
  projectId: PROJECT,
  ticketKey: key,
  title: `${key} title`,
  state: 'active',
  currentStage: 'implementation',
  stages: [{ stage: 'implementation', attempt: 1, state: 'running' }],
  templateStages: null,
  ...overrides,
});

export const EMPTY_INBOX: InboxResponse = { questions: [], approvals: [] };

export const question = (n: number, taskId: string, text: string) =>
  ({
    id: uuid(n),
    task_id: taskId,
    stage: 'implementation',
    run_id: null,
    text,
    options: null,
    blocking: true,
    status: 'open',
    asked_at: '2026-11-05T16:30:00.000Z',
    deadline_at: null,
    reminders_sent: 0,
    answer: null,
    answered_by_user_id: null,
    answered_at: null,
  }) as InboxResponse['questions'][number];

export const approval = (n: number, taskId: string) =>
  ({
    id: uuid(n),
    task_id: taskId,
    kind: 'plan',
    status: 'pending',
    requested_at: '2026-11-05T16:20:00.000Z',
    deadline_at: null,
    decided_by_user_id: null,
    decided_at: null,
    reason: null,
  }) as InboxResponse['approvals'][number];

/** A task's read with the fields the fleet uses; the rest is the minimum the schema needs. */
export const taskDetail = (
  taskId: string,
  key: string,
  title: string | null,
  overrides: Partial<TaskDetailResponse['task']> = {},
): TaskDetailResponse => ({
  task: {
    id: taskId,
    project_id: PROJECT,
    ticket: { provider: 'jira', key, url: `https://jira.example.test/browse/${key}` },
    ticket_title: title,
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
    created_at: '2026-11-05T16:00:00.000Z',
    updated_at: '2026-11-05T16:00:00.000Z',
    completed_at: null,
    ticket_claim: null,
    qa_stage: false,
    ...overrides,
  },
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
  returns: [],
  stop: null,
  gate_wait: null,
  last_gate_wait: null,
  loop_limits: null,
  human_time: {
    total_minutes: 0,
    by_kind: { review: 0, question: 0, approval: 0, steer: 0 },
    by_user: null,
    entries: 0,
    withheld: { entries: 0, minutes: 0 },
  },
  stages: [
    {
      stage: 'implementation',
      attempt: 1,
      state: 'running',
      entered_at: '2026-11-05T16:37:00.000Z',
      exited_at: null,
      outcome: null,
    },
  ],
  artifacts: [],
  questions: [],
  approvals: [],
  runs: [],
});

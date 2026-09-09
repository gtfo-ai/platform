import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DOMAIN_EVENT_TYPES,
  type DomainEvent,
  type DomainEventType,
  domainEventSchema,
  domainEventSchemasByType,
  domainEventTypeSchema,
  HANDLER_PRIORITY_BANDS,
  handlerPrioritySchema,
} from './events.js';

const uuid = (n: number) => `0199aa11-2b3c-7d4e-8f90-${String(n).padStart(12, '0')}`;
const AT = '2026-09-09T10:15:30Z';

const PROJECT = uuid(1);
const TASK = uuid(2);
const RUN = uuid(3);
const USER = uuid(4);

const ticket = {
  provider: 'jira',
  key: 'PROJ-123',
  url: 'https://example.atlassian.net/browse/PROJ-123',
};
const mr = {
  provider: 'gitlab',
  project_path: 'group/repo',
  iid: 42,
  url: 'https://gitlab.example.com/group/repo/-/merge_requests/42',
  branch: 'agentic/PROJ-123',
  head_sha: 'abc1234',
};
const identity = {
  provider: 'gitlab',
  external_id: '17',
  email: 'dev@example.com',
  display_name: 'Dev Eloper',
  verified: true,
};
const usage = {
  input_tokens: 1000,
  output_tokens: 500,
  cache_write_5m_tokens: 0,
  cache_write_1h_tokens: 0,
  cache_read_tokens: 200,
};
const cost = { usd: 1.25, is_estimate: false, price_list_id: uuid(9) };
const totals = { cost_usd: 4.2, is_estimate: false, runs: 6, wall_ms: 1_800_000 };
const artifactRef = { id: uuid(6), artifact_type: 'RefinedSpec', version: 1, url: null };
const projectScoped = { project_id: PROJECT };
const taskScoped = { project_id: PROJECT, task_id: TASK };
const budget = {
  project_id: PROJECT,
  budget_id: uuid(7),
  scope: 'project',
  scope_id: PROJECT,
  window: 'month',
  limit_usd: 500,
  spent_usd: 123.45,
};

/** One payload per catalogue entry. Every event type must appear exactly once. */
const PAYLOADS: Record<DomainEventType, Record<string, unknown>> = {
  'ticket.matched': {
    ...projectScoped,
    ticket,
    rule: 'label = agentic',
    priority: 'High',
    issue_type: 'Story',
    epic: 'PROJ-1',
    links: [{ kind: 'blocks', key: 'PROJ-99', url: null }],
  },
  'ticket.comment.added': {
    ...projectScoped,
    task_id: TASK,
    ticket,
    comment_id: '10023',
    author: identity,
    text: 'Please also cover the empty state.',
  },
  'ticket.status.changed': {
    ...projectScoped,
    task_id: TASK,
    ticket,
    from: 'To Do',
    to: 'In Refinement',
  },
  'task.created': { ...taskScoped, ticket, template: 'feature', mode: 'normal', estimate_usd: 12 },
  'task.queued': { ...taskScoped, reason: 'wip' },
  'task.dequeued': { ...taskScoped, reason: 'wip' },
  'task.stage.entered': { ...taskScoped, stage: 'refinement', attempt: 1 },
  'task.stage.completed': {
    ...taskScoped,
    stage: 'refinement',
    artifacts: [artifactRef],
    verdict: 'proceed',
  },
  'task.stage.returned': {
    ...taskScoped,
    from_stage: 'code_review',
    to_stage: 'implementation',
    reason: 'two blocker findings',
    feedback_ref: uuid(8),
    iteration: 2,
  },
  'task.question.asked': {
    ...taskScoped,
    question: {
      id: uuid(10),
      task_id: TASK,
      stage: 'refinement',
      run_id: RUN,
      text: 'Which module owns billing?',
      options: ['core', 'billing'],
      blocking: true,
      status: 'open',
      asked_at: AT,
      deadline_at: AT,
      reminders_sent: 0,
      answer: null,
      answered_by_user_id: null,
      answered_via: null,
      answered_at: null,
    },
  },
  'task.question.answered': {
    ...taskScoped,
    question_id: uuid(10),
    answer: 'billing',
    answered_by_user_id: USER,
    channel: 'slack',
  },
  'task.question.expired': { ...taskScoped, question_id: uuid(10) },
  'task.approval.requested': {
    ...taskScoped,
    approval: {
      id: uuid(11),
      task_id: TASK,
      kind: 'plan',
      status: 'pending',
      requested_at: AT,
      deadline_at: AT,
      decided_by_user_id: null,
      decided_at: null,
      reason: null,
    },
  },
  'task.approval.decided': {
    ...taskScoped,
    approval_id: uuid(11),
    decision: 'approved',
    decided_by_user_id: USER,
    reason: 'plan looks right',
  },
  'task.escalated': {
    ...taskScoped,
    reason: 'iteration limit reached',
    blocker_brief: 'Code review returned three times on the same finding.',
  },
  'task.paused': { ...taskScoped, reason: 'budget' },
  'task.resumed': { ...taskScoped, reason: 'budget raised' },
  'task.taken_over': {
    ...taskScoped,
    branch: 'agentic/PROJ-123',
    session_id: 'sess_FAKE_0001',
    stage: 'implementation',
  },
  'task.handed_back': {
    ...taskScoped,
    branch: 'agentic/PROJ-123',
    stage: 'code_review',
    summary: 'fixed the migration by hand',
  },
  'task.cancelled': { ...taskScoped, outcome: 'cancelled by maintainer', totals },
  'task.completed': { ...taskScoped, outcome: 'merged', totals },
  'run.started': {
    ...taskScoped,
    run_id: RUN,
    model: 'claude-opus-5',
    effort: 'high',
    prompt_version: 'refinement@1.3+project',
    context_pack: {
      tier0: [{ path: '.agentic/knowledge/index.md', tokens: 300 }],
      tier1: [
        {
          path: 'technical/overview.md',
          reason: 'paths',
          score: 0.82,
          tokens: 900,
          validated: true,
        },
      ],
      budget_tokens: 20_000,
      total_tokens: 1200,
      kb_commit: 'deadbee',
    },
  },
  'run.finished': {
    ...taskScoped,
    run_id: RUN,
    status: 'completed',
    terminal_reason: 'success',
    usage,
    model_usage: [{ ...usage, model: 'claude-opus-5', usd: 1.25 }],
    cost,
    num_turns: 24,
    wall_ms: 120_000,
  },
  'run.failed': {
    ...taskScoped,
    run_id: RUN,
    status: 'budget_exceeded',
    terminal_reason: 'error_max_budget_usd',
    error: 'run budget of $5 exhausted',
    usage,
    cost,
  },
  'run.steered': {
    ...taskScoped,
    run_id: RUN,
    message: 'use the existing repository, do not add a new one',
    author_user_id: USER,
  },
  'artifact.created': { ...taskScoped, artifact: artifactRef, produced_by_run_id: RUN },
  'workspace.provisioned': {
    ...taskScoped,
    workspace: {
      id: uuid(12),
      task_id: TASK,
      runner_id: 'runner-1',
      path: '/var/lib/app/workspaces/PROJ-123',
      status: 'ready',
      base_commit: 'abc1234',
      disk_bytes: 104_857_600,
      retention_until: AT,
    },
  },
  'workspace.destroyed': { ...taskScoped, workspace_id: uuid(12), reason: 'retention' },
  'workspace.exported': {
    ...taskScoped,
    workspace_id: uuid(12),
    export_blob_id: uuid(13),
    branch: 'agentic/PROJ-123',
  },
  'mr.opened': { ...projectScoped, task_id: TASK, mr, draft: true, head_sha: 'abc1234' },
  'mr.updated': {
    ...projectScoped,
    task_id: TASK,
    mr,
    draft: false,
    head_sha: 'abc1235',
    diff_stats: { files_changed: 8, insertions: 210, deletions: 45 },
  },
  'mr.merged': {
    ...projectScoped,
    task_id: TASK,
    mr,
    draft: false,
    head_sha: 'abc1235',
    diff_stats: null,
    merge_commit_sha: 'fee1234',
  },
  'mr.closed': { ...projectScoped, task_id: TASK, mr, draft: false, head_sha: 'abc1235' },
  'mr.review.comment': {
    ...projectScoped,
    task_id: TASK,
    mr,
    thread_id: 'disc_1',
    author: identity,
    text: 'This needs a test.',
    resolved: false,
  },
  'ci.pipeline.finished': {
    ...projectScoped,
    task_id: TASK,
    mr,
    head_sha: 'abc1235',
    status: 'failed',
    failed_jobs: [{ name: 'unit', log_ref: 'jobs/9911' }],
    coverage_pct: 81.4,
  },
  'default_branch.moved': { ...projectScoped, branch: 'main', new_head: 'beef123' },
  'budget.threshold.reached': { ...budget, pct: 80 },
  'budget.exhausted': budget,
  'budget.reset': { ...budget, window_start: AT },
  'feedback.received': {
    ...projectScoped,
    task_id: TASK,
    feedback: {
      id: uuid(14),
      project_id: PROJECT,
      task_id: TASK,
      author_user_id: USER,
      author_identity: identity,
      scope: 'task',
      text: 'The plan was clearer than usual.',
      rating: 5,
      source_channel: 'ui',
      created_at: AT,
    },
  },
  'knowledge.proposal.created': {
    ...projectScoped,
    proposal: {
      id: uuid(15),
      project_id: PROJECT,
      task_id: TASK,
      run_id: RUN,
      source: 'task',
      kind: 'technical',
      type: 'lesson',
      target_path: 'technical/conventions.md',
      delta: '+ Always run migrations through the advisory lock.',
      evidence: ['https://gitlab.example.com/group/repo/-/merge_requests/42'],
      significance: 0.7,
      status: 'queued',
      decided_by_user_id: null,
      decided_at: null,
      applied_commit_sha: null,
      created_at: AT,
    },
  },
  'knowledge.proposal.applied': {
    ...projectScoped,
    proposal_id: uuid(15),
    commit_sha: 'cafe123',
    decided_by_user_id: USER,
  },
  'knowledge.proposal.rejected': {
    ...projectScoped,
    proposal_id: uuid(15),
    reason: 'already documented',
    decided_by_user_id: USER,
  },
  'knowledge.index.rebuilt': {
    ...projectScoped,
    commit_sha: 'cafe123',
    documents: 42,
    chunks: 310,
    tokens: 91_000,
  },
  'readiness.evaluated': {
    ...projectScoped,
    level: 3,
    criteria: [{ id: 'R1', passed: true, evidence: 'pnpm test exits 0' }],
    source: 'discovery',
  },
  'config.changed': {
    project_id: PROJECT,
    scope: 'repo',
    scope_id: PROJECT,
    diff: [{ key: 'policies.autonomy', from: 'assist', to: 'supervised' }],
  },
  'integration.action.performed': {
    project_id: PROJECT,
    task_id: TASK,
    integration_id: uuid(16),
    action: 'comment.upsert',
    payload_redacted: { ticket: 'PROJ-123', body: '[REDACTED sha256:ab12cd]' },
    result: { comment_id: '10023' },
    duration_ms: 412,
  },
  'integration.action.failed': {
    project_id: PROJECT,
    task_id: TASK,
    integration_id: uuid(16),
    action: 'transition',
    payload_redacted: { ticket: 'PROJ-123' },
    error: '404 transition not available',
    duration_ms: 87,
  },
  'shadow.report.created': {
    ...taskScoped,
    artifact: { id: uuid(17), artifact_type: 'ShadowReport', version: 1, url: null },
  },
};

const eventOf = (type: DomainEventType, index: number): DomainEvent =>
  ({
    id: uuid(100 + index),
    stream_type: 'task',
    stream_id: TASK,
    stream_seq: index,
    correlation_id: TASK,
    cause_event_id: null,
    actor: { kind: 'system', component: 'pipeline' },
    occurred_at: AT,
    type,
    payload: PAYLOADS[type],
  }) as DomainEvent;

const FIXTURES = DOMAIN_EVENT_TYPES.map((type, index) => eventOf(type, index));

describe('event catalogue', () => {
  it('covers every catalogue entry exactly once, with no duplicates', () => {
    expect(new Set(DOMAIN_EVENT_TYPES).size).toBe(DOMAIN_EVENT_TYPES.length);
    expect(Object.keys(PAYLOADS).sort()).toEqual([...DOMAIN_EVENT_TYPES].sort());
  });

  it('names every event <aggregate>.<past-tense>', () => {
    for (const type of DOMAIN_EVENT_TYPES) {
      expect(type).toMatch(/^[a-z_]+(\.[a-z_]+)+$/);
    }
  });

  it.each(FIXTURES.map((event) => [event.type, event] as const))(
    'round-trips %s unchanged',
    (_type, event) => {
      const parsed = domainEventSchema.parse(event);
      expect(parsed).toEqual(event);
      // Parsing is idempotent: the output of a parse is itself valid input.
      expect(domainEventSchema.parse(parsed)).toEqual(parsed);
    },
  );

  it('exposes a per-type schema that accepts only its own event', () => {
    for (const event of FIXTURES) {
      expect(domainEventSchemasByType[event.type].parse(event)).toEqual(event);
    }
    const [first, second] = FIXTURES;
    if (!first || !second) throw new Error('expected at least two fixtures');
    expect(domainEventSchemasByType[first.type].safeParse(second).success).toBe(false);
  });

  it('rejects an unknown event type', () => {
    const [first] = FIXTURES;
    const result = domainEventSchema.safeParse({ ...first, type: 'task.teleported' });
    expect(result.success).toBe(false);
  });

  it('validates the catalogue name enum', () => {
    expect(domainEventTypeSchema.safeParse('run.started').success).toBe(true);
    expect(domainEventTypeSchema.safeParse('run.teleported').success).toBe(false);
  });
});

describe('event catalogue — property', () => {
  const knownKeys = (record: Record<string, unknown>) => new Set(Object.keys(record));

  it('rejects an unknown key in the envelope of any event', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...FIXTURES),
        fc.string({ minLength: 1, maxLength: 12 }),
        (event, key) => {
          fc.pre(!knownKeys(event as unknown as Record<string, unknown>).has(key));
          const result = domainEventSchema.safeParse({ ...event, [key]: 'x' });
          expect(result.success).toBe(false);
          expect(result.error?.issues.some((issue) => issue.code === 'unrecognized_keys')).toBe(
            true,
          );
        },
      ),
    );
  });

  it('rejects an unknown key in the payload of any event', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...FIXTURES),
        fc.string({ minLength: 1, maxLength: 12 }),
        (event, key) => {
          fc.pre(!knownKeys(event.payload as Record<string, unknown>).has(key));
          const mutated = { ...event, payload: { ...event.payload, [key]: 'x' } };
          expect(domainEventSchema.safeParse(mutated).success).toBe(false);
        },
      ),
    );
  });

  it('rejects any event whose required envelope field is missing', () => {
    const required = ['id', 'stream_type', 'stream_id', 'stream_seq', 'actor', 'occurred_at'];
    fc.assert(
      fc.property(fc.constantFrom(...FIXTURES), fc.constantFrom(...required), (event, field) => {
        const mutated: Record<string, unknown> = { ...event };
        delete mutated[field];
        expect(domainEventSchema.safeParse(mutated).success).toBe(false);
      }),
    );
  });
});

describe('handler priorities (TD-005)', () => {
  it('accepts the documented bands and rejects anything outside them', () => {
    for (const band of Object.values(HANDLER_PRIORITY_BANDS)) {
      expect(handlerPrioritySchema.safeParse(band.from).success).toBe(true);
      expect(handlerPrioritySchema.safeParse(band.to).success).toBe(true);
    }
    expect(handlerPrioritySchema.safeParse(-1).success).toBe(false);
    expect(handlerPrioritySchema.safeParse(1000).success).toBe(false);
    expect(handlerPrioritySchema.safeParse(1.5).success).toBe(false);
  });

  it('leaves no gap between the bands', () => {
    const bands = Object.values(HANDLER_PRIORITY_BANDS);
    for (let index = 1; index < bands.length; index += 1) {
      expect(bands[index]?.from).toBe((bands[index - 1]?.to ?? 0) + 1);
    }
  });
});

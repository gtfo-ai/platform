import { describe, expect, it } from 'vitest';
import {
  budgetRecordSchema,
  humanActionRecordSchema,
  jsonValueSchema,
  projectRecordSchema,
  runRecordSchema,
  taskRecordSchema,
} from './records.js';

const uuid = (n: number) => `0199aa11-2b3c-7d4e-8f90-${String(n).padStart(12, '0')}`;
const AT = '2026-09-09T10:15:30Z';

const usage = {
  input_tokens: 1000,
  output_tokens: 500,
  cache_write_5m_tokens: 0,
  cache_write_1h_tokens: 0,
  cache_read_tokens: 200,
};

describe('opaque JSON', () => {
  it('accepts arbitrarily nested provider payloads', () => {
    const payload = { a: [1, 'two', null, { b: { c: [true, {}] } }] };
    expect(jsonValueSchema.parse(payload)).toEqual(payload);
  });

  it('rejects values JSON cannot carry', () => {
    expect(jsonValueSchema.safeParse(undefined).success).toBe(false);
    expect(jsonValueSchema.safeParse(new Date()).success).toBe(false);
    expect(jsonValueSchema.safeParse({ nested: { fn: () => 1 } }).success).toBe(false);
  });
});

describe('records', () => {
  it('round-trips a task record', () => {
    const task = {
      id: uuid(1),
      project_id: uuid(2),
      ticket: { provider: 'jira', key: 'PROJ-1', url: 'https://example.atlassian.net/x' },
      template: 'feature',
      mode: 'normal' as const,
      state: 'active' as const,
      current_stage: 'implementation',
      size: 'M' as const,
      branch: 'agentic/PROJ-1',
      mr_ref: null,
      workpad_ref: null,
      iteration_counters: { code_review: 1, ci_fix: 0 },
      risk_classes: ['auth'],
      cost_actual_usd: 3.2,
      cost_estimated_usd: 0,
      requested_by_user_id: null,
      requested_by_identity: null,
      created_at: AT,
      updated_at: AT,
      completed_at: null,
    };
    expect(taskRecordSchema.parse(task)).toEqual(task);
    expect(taskRecordSchema.safeParse({ ...task, state: 'thinking' }).success).toBe(false);
    expect(
      taskRecordSchema.safeParse({ ...task, iteration_counters: { code_review: -1 } }).success,
    ).toBe(false);
  });

  it('round-trips a run record and rejects a negative counter', () => {
    const run = {
      id: uuid(3),
      task_id: uuid(1),
      project_id: uuid(2),
      stage: 'implementation',
      role: 'developer' as const,
      mode: 'normal' as const,
      attempt: 1,
      session_id: 'sess_FAKE_0001',
      model: 'claude-opus-5',
      effort: 'high' as const,
      provider_mode: 'api' as const,
      prompt_version: 'developer@2.0',
      status: 'running' as const,
      terminal_reason: null,
      started_at: AT,
      ended_at: null,
      last_output_at: AT,
      num_turns: 12,
      usage,
      model_usage: [{ ...usage, model: 'claude-opus-5', usd: 1.25 }],
      cost: { usd: 1.25, is_estimate: false, price_list_id: null },
      wall_ms: 60_000,
      redaction_count: 2,
    };
    expect(runRecordSchema.parse(run)).toEqual(run);
    expect(runRecordSchema.safeParse({ ...run, attempt: 0 }).success).toBe(false);
    expect(runRecordSchema.safeParse({ ...run, redaction_count: -1 }).success).toBe(false);
  });

  it('carries the spend of a budget window alongside its limit', () => {
    const budget = {
      id: uuid(4),
      scope: 'project' as const,
      scope_id: uuid(2),
      window: 'month' as const,
      limit_usd: 500,
      notify_pct: [50, 80, 100],
      spent_usd: 123.45,
      window_start: AT,
    };
    expect(budgetRecordSchema.parse(budget)).toEqual(budget);
    expect(budgetRecordSchema.safeParse({ ...budget, notify_pct: [0] }).success).toBe(false);
    expect(budgetRecordSchema.safeParse({ ...budget, window: 'fortnight' }).success).toBe(false);
  });

  it('bounds a project readiness level to the five documented levels', () => {
    const project = {
      id: uuid(5),
      key: 'platform',
      name: 'Platform',
      repo_url: 'https://gitlab.example.com/group/repo',
      default_branch: 'main',
      agentic_dir: '.agentic',
      knowledge_dir: '.agentic/knowledge',
      autonomy_level: 'supervised' as const,
      readiness_level: 3,
      status: 'active' as const,
      created_at: AT,
      updated_at: AT,
    };
    expect(projectRecordSchema.parse(project)).toEqual(project);
    expect(projectRecordSchema.safeParse({ ...project, readiness_level: 6 }).success).toBe(false);
  });

  it('audits a human action with the actor that took it', () => {
    const action = {
      id: uuid(6),
      task_id: uuid(1),
      actor: { kind: 'user' as const, user_id: uuid(7) },
      action: 'task.approve_plan',
      params: { approval_id: uuid(8) },
      created_at: AT,
    };
    expect(humanActionRecordSchema.parse(action)).toEqual(action);
    expect(humanActionRecordSchema.safeParse({ ...action, actor: { kind: 'user' } }).success).toBe(
      false,
    );
  });
});

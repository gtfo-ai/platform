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
      coverage: {
        head_sha: 'a'.repeat(40),
        head_pct: 81.5,
        base_branch: 'main',
        base_sha: 'b'.repeat(40),
        base_pct: 79,
        delta_pct: 2.5,
        measured_at: AT,
      },
      dependencies: {
        head_sha: 'a'.repeat(40),
        decision: 'ask' as const,
        added: [
          {
            ecosystem: 'npm' as const,
            name: '@scope/pkg',
            from: 'manifest' as const,
            path: 'package.json',
            policy: 'ask' as const,
            allowlisted: false,
            metadata: {
              status: 'checked' as const,
              license: 'MIT',
              last_published_at: AT,
              deprecated: false,
              source_url: 'https://www.npmjs.com/package/@scope/pkg',
            },
          },
        ],
        unread: [{ ecosystem: 'maven' as const, path: 'pom.xml' }],
        truncated: false,
        question_id: uuid(4),
        checked_at: AT,
      },
      required_reviewers: {
        source: 'codeowners' as const,
        handles: ['@ana', '@billing-team'],
        assigned: ['4242'],
        unresolved: ['@billing-team'],
        truncated: false,
        routed_at: AT,
      },
      cost_actual_usd: 3.2,
      cost_estimated_usd: 0,
      estimate_usd: 2.5,
      estimate_basis: 'project_history' as const,
      estimate_samples: 6,
      estimate_accuracy: 1.28,
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
    // The estimate's four fields are **nullable and required**, not optional: a task with no
    // estimate publishes four explicit nulls, so a reader can tell "not estimated" from a field
    // the projection forgot (standing rules 16 and 18).
    const unestimated = {
      ...task,
      estimate_usd: null,
      estimate_basis: null,
      estimate_samples: null,
      estimate_accuracy: null,
    };
    expect(taskRecordSchema.parse(unestimated)).toEqual(unestimated);
    const { estimate_basis: _dropped, ...withoutBasis } = task;
    expect(taskRecordSchema.safeParse(withoutBasis).success).toBe(false);
    /**
     * The coverage record, both ways (standing rule 42), because every field inside it is how a
     * *missing* number is spelled and the one thing this schema must never do is let a zero stand
     * in for one (WP-39, standing rule 16).
     */
    const unmeasured = { ...task, coverage: null };
    expect(taskRecordSchema.parse(unmeasured)).toEqual(unmeasured);
    const { coverage: _noCoverage, ...withoutCoverage } = task;
    expect(taskRecordSchema.safeParse(withoutCoverage).success).toBe(false);
    const reportedNothing = {
      ...task,
      coverage: {
        head_sha: 'a'.repeat(40),
        head_pct: null,
        base_branch: null,
        base_sha: null,
        base_pct: null,
        delta_pct: null,
        measured_at: AT,
      },
    };
    expect(taskRecordSchema.parse(reportedNothing)).toEqual(reportedNothing);
    // A delta is signed — it is percentage **points** — and that is the half a `min(0)` would cost.
    const dropped = { ...task, coverage: { ...task.coverage, head_pct: 70, delta_pct: -9 } };
    expect(taskRecordSchema.parse(dropped)).toEqual(dropped);
    // …and it is still bounded on both sides, and still strict about what it carries.
    expect(
      taskRecordSchema.safeParse({ ...task, coverage: { ...task.coverage, delta_pct: -101 } })
        .success,
    ).toBe(false);
    expect(
      taskRecordSchema.safeParse({ ...task, coverage: { ...task.coverage, head_pct: 101 } })
        .success,
    ).toBe(false);
    expect(
      taskRecordSchema.safeParse({ ...task, coverage: { ...task.coverage, lines_pct: 12 } })
        .success,
    ).toBe(false);
    /**
     * The dependency record, both ways (WP-38, standing rules 16, 18 and 42). `null` is *"the gate
     * has not run"* and an empty `added` is *"it ran and nothing was added"*: two different facts
     * the panel prints differently, so both must parse and neither may be spelled by an absent key.
     */
    const ungated = { ...task, dependencies: null, required_reviewers: null };
    expect(taskRecordSchema.parse(ungated)).toEqual(ungated);
    const { dependencies: _noDependencies, ...withoutDependencies } = task;
    expect(taskRecordSchema.safeParse(withoutDependencies).success).toBe(false);
    const { required_reviewers: _noReviewers, ...withoutReviewers } = task;
    expect(taskRecordSchema.safeParse(withoutReviewers).success).toBe(false);
    const clean = {
      ...task,
      dependencies: { ...task.dependencies, decision: 'none' as const, added: [], unread: [] },
    };
    expect(taskRecordSchema.parse(clean)).toEqual(clean);
    // A decision nothing renders, an ecosystem nothing detects and a licence longer than a name
    // are all refused at the boundary rather than stored and puzzled over at the screen.
    expect(
      taskRecordSchema.safeParse({
        ...task,
        dependencies: { ...task.dependencies, decision: 'maybe' },
      }).success,
    ).toBe(false);
    expect(
      taskRecordSchema.safeParse({
        ...task,
        dependencies: {
          ...task.dependencies,
          added: [{ ...task.dependencies.added[0], ecosystem: 'maven' }],
        },
      }).success,
    ).toBe(false);
    expect(
      taskRecordSchema.safeParse({
        ...task,
        dependencies: {
          ...task.dependencies,
          added: [
            {
              ...task.dependencies.added[0],
              metadata: { ...task.dependencies.added[0]?.metadata, license: 'A'.repeat(201) },
            },
          ],
        },
      }).success,
    ).toBe(false);
    // More reviewers than one merge request may carry (`MAX_ROUTED_REVIEWERS`).
    expect(
      taskRecordSchema.safeParse({
        ...task,
        required_reviewers: {
          ...task.required_reviewers,
          handles: Array.from({ length: 9 }, (_, index) => `@person-${index}`),
        },
      }).success,
    ).toBe(false);
    expect(taskRecordSchema.safeParse({ ...task, estimate_basis: 'a_guess' }).success).toBe(false);
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

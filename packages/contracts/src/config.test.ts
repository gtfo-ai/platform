import { describe, expect, it } from 'vitest';
import {
  agenticConfigSchema,
  commandPolicySchema,
  pipelineLimitsSchema,
  policiesConfigSchema,
  riskClassSchema,
  statusMappingSchema,
} from './config.js';

/**
 * The example from docs/technical/12-configuration-and-schemas.md § ".agentic/config.yml",
 * transcribed key for key. If this stops parsing, either the document or the schema moved.
 */
const DOC_EXAMPLE = {
  version: 1,
  project: {
    knowledge_dir: '.agentic/knowledge',
    context_budget_tokens: 12000,
    communication_language: 'auto',
    commit_convention: 'conventional',
    default_branch: 'main',
  },
  pipeline: {
    template_overrides: {
      feature: {
        stages: {
          business_review: { enabled: true },
          architecture: { plan_approval: 'above_size', size_threshold: 'L' },
        },
      },
      chore: { stages: { architecture: { enabled: false } } },
    },
    custom_stages: [],
    limits: {
      code_review_iterations: 3,
      business_review_iterations: 2,
      ci_fix_iterations: 3,
      human_rounds: 3,
      question_timeout: '1 working day',
    },
  },
  stages: {
    refinement: { model: 'claude-opus-5', effort: 'medium', max_turns: 30, budget_usd: 2 },
    architecture: { model: 'claude-opus-5', effort: 'high', budget_usd: 5 },
    implementation: {
      model: 'claude-opus-5',
      effort: 'high',
      max_turns: 200,
      budget_usd: 15,
      prompt: 'prompts/implementation.md',
      prompt_append: 'prompts/implementation.append.md',
    },
    code_review: { model: 'claude-opus-5', effort: 'high' },
  },
  policies: {
    autonomy: 'supervised',
    probation_tasks: 5,
    knowledge_apply: { auto_apply: false, discard_below: 0.2, proposal_above: 0.6 },
    dependency_policy: 'ask',
    drift_without_direction: 'disabled',
    protected_paths: ['tests/**', '.gitlab-ci.yml', '.agentic/**', '.claude/**', 'CLAUDE.md'],
    risk_classes: {
      auth: {
        paths: ['**/auth/**', '**/session/**'],
        require: ['plan_approval', 'reviewer:@security'],
      },
      migrations: { paths: ['**/migrations/**'], require: ['plan_approval'] },
    },
  },
  commands: {
    allow: ['npm test', 'npm run lint', 'make test', 'pytest *'],
    ask: ['npm install *', 'pip install *'],
    block: ['rm -rf /', 'git push --force*', 'docker *'],
  },
  features: {
    ticket_linter: { enabled: false, issue_types: ['Story', 'Task', 'Bug'] },
    review_only: {
      enabled: false,
      trigger: 'label',
      label: 'agentic-review',
      severity_floor: 'major',
    },
    maintenance: {
      enabled: false,
      schedule: 'weekly',
      budget_usd: 20,
      chores: ['deps', 'flaky', 'docs'],
    },
    digest: { enabled: true, at: '09:00', quiet_hours: null },
  },
  status_mapping: {
    refinement: 'In Refinement',
    waiting_answers: 'Waiting for input',
    implementation: 'In Progress',
    ready_for_merge: 'In Review',
    done: 'Done',
  },
};

describe('.agentic/config.yml', () => {
  it('parses the example from technical/12 unchanged', () => {
    expect(agenticConfigSchema.parse(DOC_EXAMPLE)).toEqual(DOC_EXAMPLE);
  });

  it('accepts the minimal file — only the schema version', () => {
    expect(agenticConfigSchema.parse({ version: 1 })).toEqual({ version: 1 });
  });

  it('refuses an unknown major version, naming the value it wanted', () => {
    const result = agenticConfigSchema.safeParse({ version: 2 });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('1');
  });

  it('requires the version', () => {
    expect(agenticConfigSchema.safeParse({}).success).toBe(false);
  });

  it.each([
    ['top level', { version: 1, polices: {} }],
    ['a nested section', { version: 1, project: { knowledge_base_dir: 'kb' } }],
    ['a deeply nested object', { version: 1, policies: { knowledge_apply: { autoapply: true } } }],
    ['inside an array element', { version: 1, pipeline: { custom_stages: [{ id: 'x' }] } }],
  ])('rejects an unknown key at %s', (_where, input) => {
    expect(agenticConfigSchema.safeParse(input).success).toBe(false);
  });

  it('names the offending key when it rejects one, so the operator can fix the typo', () => {
    const result = agenticConfigSchema.safeParse({ version: 1, polices: {} });
    const issue = result.error?.issues[0];
    expect(issue?.code).toBe('unrecognized_keys');
    expect(JSON.stringify(issue)).toContain('polices');
  });

  it('points at the path of a nested error', () => {
    const result = agenticConfigSchema.safeParse({
      version: 1,
      policies: { autonomy: 'yolo' },
    });
    expect(result.error?.issues[0]?.path).toEqual(['policies', 'autonomy']);
  });

  it('accepts user-chosen keys in the maps that are meant to be open', () => {
    const parsed = agenticConfigSchema.parse({
      version: 1,
      stages: { my_custom_stage: { effort: 'low' } },
      pipeline: { template_overrides: { my_template: { enabled: false } } },
      policies: {
        risk_classes: { payments: { paths: ['**/pay/**'], require: ['plan_approval'] } },
      },
      status_mapping: { my_custom_stage: 'Doing the thing' },
    });
    expect(parsed.stages?.my_custom_stage?.effort).toBe('low');
  });

  it('still constrains the shape of those map keys', () => {
    expect(
      agenticConfigSchema.safeParse({ version: 1, stages: { 'Not A Slug': {} } }).success,
    ).toBe(false);
  });
});

describe('config sub-schemas', () => {
  it('accepts both documented risk requirements and rejects free text', () => {
    expect(
      riskClassSchema.parse({ paths: ['**/auth/**'], require: ['plan_approval', 'reviewer:@sec'] }),
    ).toBeTruthy();
    expect(
      riskClassSchema.safeParse({ paths: ['**/auth/**'], require: ['ping the architect'] }).success,
    ).toBe(false);
    expect(riskClassSchema.safeParse({ paths: [], require: ['plan_approval'] }).success).toBe(
      false,
    );
  });

  it.each([
    ['1 working day', true],
    ['30 minutes', true],
    ['2 hours', true],
    ['4 days', true],
    ['soon', false],
    ['1 working fortnight', false],
    ['', false],
  ])('validates question_timeout %s', (value, expected) => {
    expect(pipelineLimitsSchema.safeParse({ question_timeout: value }).success).toBe(expected);
  });

  it('keeps the three command lists separate and optional', () => {
    expect(commandPolicySchema.parse({})).toEqual({});
    expect(commandPolicySchema.parse({ block: ['rm -rf /'] })).toEqual({ block: ['rm -rf /'] });
    expect(commandPolicySchema.safeParse({ deny: ['rm -rf /'] }).success).toBe(false);
  });

  it('bounds knowledge-apply thresholds to [0, 1] (BD-018)', () => {
    expect(
      policiesConfigSchema.safeParse({ knowledge_apply: { discard_below: 1.2 } }).success,
    ).toBe(false);
    expect(
      policiesConfigSchema.safeParse({ knowledge_apply: { discard_below: 0.2 } }).success,
    ).toBe(true);
  });

  it('accepts only the two documented drift settings (product/05 Q7)', () => {
    expect(policiesConfigSchema.safeParse({ drift_without_direction: 'disabled' }).success).toBe(
      true,
    );
    expect(
      policiesConfigSchema.safeParse({ drift_without_direction: 'label_unknown' }).success,
    ).toBe(true);
    expect(policiesConfigSchema.safeParse({ drift_without_direction: 'label' }).success).toBe(
      false,
    );
  });

  it('maps a state to a provider status name', () => {
    expect(statusMappingSchema.parse({ done: 'Done' })).toEqual({ done: 'Done' });
    expect(statusMappingSchema.safeParse({ done: '' }).success).toBe(false);
  });

  it('never accepts a secret-looking key anywhere in the file', () => {
    for (const secret of ['token', 'api_token', 'password', 'secret', 'ANTHROPIC_API_KEY']) {
      expect(agenticConfigSchema.safeParse({ version: 1, [secret]: 'x' }).success).toBe(false);
      expect(
        agenticConfigSchema.safeParse({ version: 1, project: { [secret]: 'x' } }).success,
      ).toBe(false);
    }
  });
});

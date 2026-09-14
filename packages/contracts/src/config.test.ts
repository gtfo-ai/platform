import { describe, expect, it } from 'vitest';
import {
  agenticConfigSchema,
  commandPolicySchema,
  MAX_CONTEXT_BUDGET_TOKENS,
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
    dependency_policy: {
      default: 'ask',
      ecosystems: { npm: 'block' },
      allowlist: ['npm:@scope/pkg'],
    },
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

  describe('a risk requirement is refused by name when this build cannot act on it (WP-37)', () => {
    const withRequirement = (requirement: string) =>
      agenticConfigSchema.safeParse({
        version: 1,
        policies: { risk_classes: { payments: { paths: ['**/pay/**'], require: [requirement] } } },
      });

    it('accepts the two that have a consumer', () => {
      expect(withRequirement('plan_approval').success).toBe(true);
      expect(withRequirement('reviewer:@security').success).toBe(true);
      expect(withRequirement('reviewer:@team/security').success).toBe(true);
      // The pattern takes an `@` only at the front, so an **email** owner — which a `CODEOWNERS`
      // file may name — cannot be written as a requirement. Pinned rather than silently true: it is
      // a limit of `REVIEWER_REQUIREMENT` as WP-01 wrote it, and the routing resolves a handle
      // through `GET /users?username=` in any case, which no email would answer.
      expect(withRequirement('reviewer:person@example.test').success).toBe(false);
    });

    it('refuses `checklist:<name>` with the reason and the open question', () => {
      const result = withRequirement('checklist:payments');
      expect(result.success).toBe(false);
      // The message is the whole point of refusing here rather than in a union: an operator whose
      // `payments` class silently did nothing is exactly who must not get `invalid_union`.
      expect(result.error?.issues[0]?.message).toContain('Q83');
      expect(result.error?.issues[0]?.message).toContain('checklist:payments');
      expect(result.error?.issues[0]?.path).toEqual([
        'policies',
        'risk_classes',
        'payments',
        'require',
        0,
      ]);
    });

    it('refuses `budget_approval`, naming the gate that cannot read it', () => {
      const result = withRequirement('budget_approval');
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toContain('budget_approval_threshold_usd');
    });

    it('refuses anything else with the two forms it does accept', () => {
      expect(withRequirement('approve').error?.issues[0]?.message).toContain('plan_approval');
    });
  });

  it('takes the project’s reviewers, which product/19:138’s middle step had no key for', () => {
    const parsed = agenticConfigSchema.parse({
      version: 1,
      policies: { reviewers: ['4242', '@dana'] },
    });
    expect(parsed.policies?.reviewers).toEqual(['4242', '@dana']);
    // Bounded: the list is one provider read per entry at the rebase gate.
    expect(
      agenticConfigSchema.safeParse({
        version: 1,
        policies: { reviewers: Array.from({ length: 9 }, (_, index) => `u${index}`) },
      }).success,
    ).toBe(false);
  });

  /**
   * product/18:38's one configuration key, *"coverage source"* (WP-39).
   *
   * Before this row the document told an operator to write a key a **strict** schema refused, which
   * is the same defect `policies.reviewers` above was added to close. Both values are asserted, and
   * so is the one an operator is most likely to reach for and this build cannot honour.
   */
  it('takes the coverage source product/18:38 names, and refuses a per-file one', () => {
    expect(
      agenticConfigSchema.parse({ version: 1, policies: { coverage_source: 'pipeline' } }).policies
        ?.coverage_source,
    ).toBe('pipeline');
    expect(
      agenticConfigSchema.parse({ version: 1, policies: { coverage_source: 'none' } }).policies
        ?.coverage_source,
    ).toBe('none');
    // `artifact` is what somebody reading product/10:38's "coverage delta" would write for per-file
    // coverage. Nothing in this build downloads a coverage artifact, so the key that promised it
    // would be a key with no reader — the defect PROGRESS backlog 58 is about.
    const refused = agenticConfigSchema.safeParse({
      version: 1,
      policies: { coverage_source: 'artifact' },
    });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.path).toEqual(['policies', 'coverage_source']);
  });

  /**
   * product/18:43's configuration column, both forms (WP-38, criterion 3).
   *
   * The document says *"`allow | ask | block` per ecosystem; allow-listed packages"* and until this
   * work package the key was a **scalar enum** with no allow-list at all — so the configuration the
   * product tells an operator to write could not be written, and a strict schema refused it. The
   * scalar stays as the shorthand, which is what technical/12's example file has always carried.
   */
  it('takes product/18:43’s per-ecosystem policy and its allow-list, and the scalar shorthand', () => {
    expect(
      agenticConfigSchema.parse({ version: 1, policies: { dependency_policy: 'block' } }).policies
        ?.dependency_policy,
    ).toBe('block');
    const perEcosystem = {
      default: 'ask',
      ecosystems: { npm: 'block', pypi: 'allow' },
      allowlist: ['npm:@scope/pkg', 'pypi:requests'],
    } as const;
    expect(
      agenticConfigSchema.parse({ version: 1, policies: { dependency_policy: perEcosystem } })
        .policies?.dependency_policy,
    ).toEqual(perEcosystem);
  });

  it('refuses an ecosystem nothing detects, an allow-list entry with no ecosystem, and a typo', () => {
    // A policy for an ecosystem no detector reads would be a key with no reader — PROGRESS backlog
    // 58's defect, and the one this whole row exists to close for `dependency_policy` itself.
    const unknownEcosystem = agenticConfigSchema.safeParse({
      version: 1,
      policies: { dependency_policy: { ecosystems: { maven: 'block' } } },
    });
    expect(unknownEcosystem.success).toBe(false);
    expect(JSON.stringify(unknownEcosystem.error?.issues)).toContain('maven');

    const badEntry = agenticConfigSchema.safeParse({
      version: 1,
      policies: { dependency_policy: { allowlist: ['lodash'] } },
    });
    expect(badEntry.success).toBe(false);
    expect(JSON.stringify(badEntry.error?.issues)).toContain('<ecosystem>:<package>');

    const wrongEcosystem = agenticConfigSchema.safeParse({
      version: 1,
      policies: { dependency_policy: { allowlist: ['maven:com.google.guava'] } },
    });
    expect(wrongEcosystem.success).toBe(false);
    expect(JSON.stringify(wrongEcosystem.error?.issues)).toContain('npm, pypi, go, cargo');

    // A typo in the scalar says **which three values** rather than zod's `invalid_union` — the
    // lesson `riskRequirementSchema` was rewritten for at WP-37.
    const typo = agenticConfigSchema.safeParse({
      version: 1,
      policies: { dependency_policy: 'aks' },
    });
    expect(typo.success).toBe(false);
    expect(typo.error?.issues[0]?.message).toContain('"allow", "ask" or "block"');
    expect(typo.error?.issues[0]?.path).toEqual(['policies', 'dependency_policy']);
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

describe('context_budget_tokens', () => {
  const withBudget = (value: number) =>
    agenticConfigSchema.safeParse({ ...DOC_EXAMPLE, project: { context_budget_tokens: value } });

  it('accepts a budget up to the smallest model context window', () => {
    expect(withBudget(MAX_CONTEXT_BUDGET_TOKENS).success).toBe(true);
    expect(withBudget(12_000).success).toBe(true);
    expect(withBudget(0).success).toBe(true);
  });

  it('refuses a budget above it, at the boundary rather than at the assembler (backlog 13)', () => {
    // Asserted from **both** sides (standing rule 42): a schema that refused everything would pass
    // this case and fail the one above.
    expect(withBudget(MAX_CONTEXT_BUDGET_TOKENS + 1).success).toBe(false);
    expect(withBudget(10_000_000).success).toBe(false);
    expect(withBudget(-1).success).toBe(false);
  });
});

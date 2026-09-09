import { type AutonomyLevel, agenticConfigSchema } from '@platform/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { autonomyRank } from '../policies/autonomy.js';
import { DEFAULT_COMMAND_POLICY } from '../policies/command-policy.js';
import { PROPERTY_TEST_TIMEOUT_MS } from '../testing/property.js';
import {
  type ConfigLayer,
  commandVerdictFor,
  mergeProjectConfig,
  organisationCommandMaximum,
  PLATFORM_DEFAULT_CONFIG,
} from './effective-config.js';

const layer = (source: ConfigLayer['source'], values: ConfigLayer['values']): ConfigLayer => ({
  source,
  values,
});

describe('the shipped defaults', () => {
  it('parse as a valid `.agentic/config.yml`', () => {
    expect(() =>
      agenticConfigSchema.parse({ version: 1, ...PLATFORM_DEFAULT_CONFIG }),
    ).not.toThrow();
  });

  it('carry the documented values', () => {
    expect(PLATFORM_DEFAULT_CONFIG.policies?.autonomy).toBe('supervised');
    expect(PLATFORM_DEFAULT_CONFIG.policies?.probation_tasks).toBe(5);
    expect(PLATFORM_DEFAULT_CONFIG.policies?.knowledge_apply).toEqual({
      auto_apply: false,
      discard_below: 0.2,
      proposal_above: 0.6,
    });
    expect(PLATFORM_DEFAULT_CONFIG.pipeline?.limits?.question_timeout).toBe('1 working day');
    expect(PLATFORM_DEFAULT_CONFIG.policies?.protected_paths).toContain('.agentic/**');
    expect(PLATFORM_DEFAULT_CONFIG.features?.digest?.at).toBe('09:00');
  });
});

describe('precedence and provenance', () => {
  it('applies default < org < project < repo whatever the order of the layers', () => {
    const layers = [
      layer('repo', { project: { default_branch: 'trunk' } }),
      layer('org', { project: { default_branch: 'develop', commit_convention: 'none' } }),
      layer('project', { project: { knowledge_dir: 'docs/kb' } }),
    ];
    const effective = mergeProjectConfig(layers);
    expect(effective.values.project).toEqual({
      knowledge_dir: 'docs/kb',
      communication_language: 'auto',
      commit_convention: 'none',
      default_branch: 'trunk',
    });
    expect(effective.sources['project.default_branch']).toBe('repo');
    expect(effective.sources['project.commit_convention']).toBe('org');
    expect(effective.sources['project.knowledge_dir']).toBe('project');
    expect(effective.sources['project.communication_language']).toBe('default');
  });

  it('merges nested objects key by key', () => {
    const effective = mergeProjectConfig([
      layer('project', { pipeline: { limits: { code_review_iterations: 5 } } }),
    ]);
    expect(effective.values.pipeline?.limits).toEqual({
      code_review_iterations: 5,
      business_review_iterations: 2,
      ci_fix_iterations: 3,
      human_rounds: 3,
      question_timeout: '1 working day',
    });
    expect(effective.sources['pipeline.limits.code_review_iterations']).toBe('project');
    expect(effective.sources['pipeline.limits.ci_fix_iterations']).toBe('default');
  });

  it('merges the user-keyed records (stages, risk classes, status mapping) per key', () => {
    const effective = mergeProjectConfig([
      layer('org', { stages: { refinement: { model: 'claude-opus-5', budget_usd: 2 } } }),
      layer('repo', {
        stages: { refinement: { budget_usd: 4 }, implementation: { max_turns: 200 } },
        status_mapping: { done: 'Done' },
      }),
    ]);
    expect(effective.values.stages).toEqual({
      refinement: { model: 'claude-opus-5', budget_usd: 4 },
      implementation: { max_turns: 200 },
    });
    expect(effective.sources['stages.refinement.model']).toBe('org');
    expect(effective.sources['stages.refinement.budget_usd']).toBe('repo');
    expect(effective.sources['status_mapping.done']).toBe('repo');
  });

  it('replaces arrays rather than concatenating them', () => {
    const effective = mergeProjectConfig([
      layer('repo', { policies: { protected_paths: ['src/generated/**'] } }),
    ]);
    expect(effective.values.policies?.protected_paths).toEqual(['src/generated/**']);
    expect(effective.sources['policies.protected_paths']).toBe('repo');
  });

  it('lets the caller override the platform defaults layer', () => {
    const effective = mergeProjectConfig([
      layer('default', { project: { default_branch: 'master' } }),
    ]);
    expect(effective.values.project).toEqual({ default_branch: 'master' });
    expect(effective.values.policies).toBeUndefined();
  });

  it('produces something that still parses as a config file', () => {
    const effective = mergeProjectConfig([
      layer('org', { policies: { autonomy: 'autonomous' } }),
      layer('repo', { features: { shadow_mode: { enabled: true, budget_usd: 25 } } }),
    ]);
    expect(() => agenticConfigSchema.parse({ version: 1, ...effective.values })).not.toThrow();
  });
});

describe('BD-027 — the organisation caps the autonomy dial', () => {
  it('lowers a project that asks for more than the organisation allows', () => {
    const effective = mergeProjectConfig([
      layer('org', { policies: { autonomy: 'assist' } }),
      layer('repo', { policies: { autonomy: 'autonomous' } }),
    ]);
    expect(effective.values.policies?.autonomy).toBe('assist');
    expect(effective.cappedAutonomy).toEqual({ requested: 'autonomous', applied: 'assist' });
    expect(effective.sources['policies.autonomy']).toBe('org');
  });

  it('leaves a project that asks for less alone', () => {
    const effective = mergeProjectConfig([
      layer('org', { policies: { autonomy: 'autonomous' } }),
      layer('project', { policies: { autonomy: 'observe' } }),
    ]);
    expect(effective.values.policies?.autonomy).toBe('observe');
    expect(effective.cappedAutonomy).toBeNull();
    expect(effective.sources['policies.autonomy']).toBe('project');
  });

  it('falls back to the shipped default as the cap when the organisation is silent', () => {
    // A silent organisation must not mean "unlimited": otherwise a repository could hand itself
    // `autonomous` by editing a file in its own tree, which BD-025 already distrusts.
    const effective = mergeProjectConfig([layer('repo', { policies: { autonomy: 'autonomous' } })]);
    expect(effective.values.policies?.autonomy).toBe('supervised');
    expect(effective.cappedAutonomy).toEqual({ requested: 'autonomous', applied: 'supervised' });
    expect(effective.sources['policies.autonomy']).toBe('default');
  });

  it('lets the organisation raise the cap above the shipped default', () => {
    const effective = mergeProjectConfig([
      layer('org', { policies: { autonomy: 'autonomous' } }),
      layer('repo', { policies: { autonomy: 'autonomous' } }),
    ]);
    expect(effective.values.policies?.autonomy).toBe('autonomous');
    expect(effective.cappedAutonomy).toBeNull();
  });

  it('does not cap when no layer states an autonomy at all', () => {
    const effective = mergeProjectConfig([
      layer('default', { project: { default_branch: 'main' } }),
      layer('repo', { policies: { autonomy: 'autonomous' } }),
    ]);
    expect(effective.values.policies?.autonomy).toBe('autonomous');
    expect(effective.cappedAutonomy).toBeNull();
  });

  it(
    'never ends above the organisation maximum, for any pair of levels',
    () => {
      const level = fc.constantFrom<AutonomyLevel>('observe', 'assist', 'supervised', 'autonomous');
      fc.assert(
        fc.property(level, level, (org, repo) => {
          const effective = mergeProjectConfig([
            layer('org', { policies: { autonomy: org } }),
            layer('repo', { policies: { autonomy: repo } }),
          ]);
          const applied = effective.values.policies?.autonomy as AutonomyLevel;
          expect(autonomyRank(applied)).toBeLessThanOrEqual(autonomyRank(org));
          expect(autonomyRank(applied)).toBeLessThanOrEqual(autonomyRank(repo));
        }),
      );
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );
});

describe('BD-025 — the command policy only narrows', () => {
  it('starts from the shipped lists when the organisation says nothing', () => {
    expect(organisationCommandMaximum(undefined)).toEqual({
      allow: DEFAULT_COMMAND_POLICY.allow,
      ask: DEFAULT_COMMAND_POLICY.ask,
      block: [...DEFAULT_COMMAND_POLICY.block],
    });
  });

  it('lets the organisation state its own maximum, but never unblock', () => {
    const maximum = organisationCommandMaximum({
      allow: ['make test'],
      ask: [],
      block: ['scp *'],
    });
    expect(maximum.allow).toEqual(['make test']);
    expect(maximum.ask).toEqual([]);
    expect(maximum.block).toContain('scp *');
    for (const blocked of DEFAULT_COMMAND_POLICY.block) {
      expect(maximum.block).toContain(blocked);
    }
  });

  it('ignores a repository that tries to allow what the organisation does not', () => {
    const effective = mergeProjectConfig([
      layer('org', { commands: { allow: ['make test', 'make lint'], ask: [], block: [] } }),
      layer('repo', { commands: { allow: ['make test', 'curl *'] } }),
    ]);
    expect(effective.commands.allow).toEqual(['make test']);
    expect(effective.ignoredAllowCommands).toEqual(['curl *']);
    expect(commandVerdictFor(effective, 'make test')).toBe('allow');
    expect(commandVerdictFor(effective, 'curl https://example.invalid')).toBe('ask');
  });

  it('lets a project narrow and the repository narrow again', () => {
    const effective = mergeProjectConfig([
      layer('org', { commands: { allow: ['a', 'b', 'c'], ask: [], block: [] } }),
      layer('project', { commands: { allow: ['a', 'b'] } }),
      layer('repo', { commands: { allow: ['a'] } }),
    ]);
    expect(effective.commands.allow).toEqual(['a']);
  });

  it('keeps every block from every layer', () => {
    const effective = mergeProjectConfig([
      layer('org', { commands: { block: ['scp *'] } }),
      layer('repo', { commands: { block: ['nc *'] } }),
    ]);
    expect(effective.commands.block).toEqual(expect.arrayContaining(['scp *', 'nc *', 'sudo *']));
    expect(effective.values.commands?.block).toEqual([...effective.commands.block]);
  });

  it('records which layer last stated each list', () => {
    const effective = mergeProjectConfig([
      layer('org', { commands: { allow: ['a'] } }),
      layer('repo', { commands: { block: ['b'] } }),
    ]);
    expect(effective.sources['commands.allow']).toBe('org');
    expect(effective.sources['commands.block']).toBe('repo');
    expect(effective.sources['commands.ask']).toBe('default');
  });

  it('resolves a command through the effective policy, resolved binary included', () => {
    const effective = mergeProjectConfig([]);
    expect(commandVerdictFor(effective, 'npm ci')).toBe('allow');
    expect(commandVerdictFor(effective, 'dckr ps', 'docker ps')).toBe('block');
  });
});

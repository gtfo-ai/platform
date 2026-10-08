/**
 * WP-63 review round 1: a repository file may **tighten, never loosen**, what an agent or a
 * reviewer is held to. Every loosening attempt the reviewer parsed as `valid` — an empty
 * `protected_paths`, `probation_tasks: 0`, `knowledge_apply.auto_apply: true`, a weakened risk class
 * — has no effect and is reported; every tightening takes effect (standing rule 42: both
 * directions, each).
 */
import { agenticConfigSchema } from '@platform/contracts';
import { AUTONOMY_POLICY_OVERRIDE_KEYS, PLATFORM_DEFAULT_CONFIG } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { projectConfigWithRepository } from './repository-config.js';
import {
  AUTONOMY_OVERRIDE_PATHS,
  REPOSITORY_KEY_GRADES,
  tightenRepositoryLayer,
  withoutNotAppliedKeys,
} from './repository-grades.js';

type Shaped = { readonly shape?: Record<string, unknown>; unwrap?: () => unknown };
const shapeOf = (schema: unknown): Record<string, unknown> => {
  let current = schema as Shaped;
  while (current.shape === undefined && current.unwrap !== undefined) {
    current = current.unwrap() as Shaped;
  }
  return current.shape ?? {};
};

/** Every key the schema lets a file state, spelled as `REPOSITORY_KEY_GRADES` spells it. */
const schemaKeys = (): string[] => {
  const root = shapeOf(agenticConfigSchema);
  const keys: string[] = [];
  // Read off the schema, never typed: a top-level key added to `agenticConfigSchema` appears here
  // ungraded and fails the comparison below (review round 2). The four expanded below are graded
  // key by key; every other top-level key is graded whole.
  for (const key of Object.keys(root)) {
    if (!['version', 'project', 'policies', 'pipeline', 'stages'].includes(key)) keys.push(key);
  }
  for (const key of Object.keys(shapeOf(root.project))) keys.push(`project.${key}`);
  for (const key of Object.keys(shapeOf(root.policies))) keys.push(`policies.${key}`);
  const pipeline = shapeOf(root.pipeline);
  for (const key of Object.keys(pipeline)) {
    if (key === 'limits') {
      for (const limit of Object.keys(shapeOf(pipeline.limits))) {
        keys.push(`pipeline.limits.${limit}`);
      }
    } else {
      keys.push(`pipeline.${key}`);
    }
  }
  const stages = (root.stages as { unwrap: () => { valueType: unknown } }).unwrap();
  for (const key of Object.keys(shapeOf(stages.valueType))) keys.push(`stages.*.${key}`);
  return keys.sort();
};

describe('the grades table', () => {
  it('grades every key the schema accepts, and nothing it does not', () => {
    expect(Object.keys(REPOSITORY_KEY_GRADES).sort()).toEqual(schemaKeys());
  });

  it('never applies a key that overrides a policy of the autonomy dial (Q78)', () => {
    for (const path of Object.values(AUTONOMY_POLICY_OVERRIDE_KEYS)) {
      expect(AUTONOMY_OVERRIDE_PATHS).toContain(path);
      // Graded as its own key, or under a parent that is not applied as a whole.
      const graded =
        REPOSITORY_KEY_GRADES[path] ?? REPOSITORY_KEY_GRADES[path.split('.').slice(0, 2).join('.')];
      expect(graded, path).toBe('not_applied');
    }
  });
});

describe('the keys a file may not apply', () => {
  it('drops `human_returns` and reports it, because an added word loosens a return (WP-170)', () => {
    expect(REPOSITORY_KEY_GRADES.human_returns).toBe('not_applied');
    const { values, notApplied } = withoutNotAppliedKeys({
      human_returns: { acknowledgements: ['danke'] },
      status_mapping: { done: 'Finished' },
    });
    expect(values).toEqual({ status_mapping: { done: 'Finished' } });
    expect(notApplied).toHaveLength(1);
    expect(notApplied[0]?.key).toBe('human_returns');
    expect(notApplied[0]?.reason).toMatch(/acknowledgement vocabulary/);
  });

  it('drops probation_tasks, auto_apply, the dial and a feature switch, and reports each', () => {
    const { values, notApplied } = withoutNotAppliedKeys({
      policies: {
        autonomy: 'autonomous',
        probation_tasks: 0,
        knowledge_apply: { auto_apply: true },
        protected_paths: ['secrets/**'],
      },
      pipeline: { limits: { human_rounds: 9, ci_fix_iterations: 4, ci_timeout_minutes: 120 } },
      features: { maintenance: { enabled: true } },
      stages: { implementation: { model: 'claude-sonnet-5', prompt: 'prompts/x.md' } },
    });
    // WP-92, criterion 3: `prompts/x.md` resolves into `.agentic/prompts/`, so it is applied.
    expect(values).toEqual({
      policies: { protected_paths: ['secrets/**'] },
      // WP-136: the CI timeout is operational, like the loop limits — the file may raise it.
      pipeline: { limits: { ci_fix_iterations: 4, ci_timeout_minutes: 120 } },
      stages: { implementation: { model: 'claude-sonnet-5', prompt: 'prompts/x.md' } },
    });
    expect(notApplied.map((item) => item.key).sort()).toEqual([
      'features',
      'pipeline.limits.human_rounds',
      'policies.autonomy',
      'policies.knowledge_apply',
      'policies.probation_tasks',
    ]);
  });

  it('applies both prompt keys when they name a prompt file, and drops one that names another path (WP-92)', () => {
    expect(REPOSITORY_KEY_GRADES['stages.*.prompt']).toBe('operational');
    expect(REPOSITORY_KEY_GRADES['stages.*.prompt_append']).toBe('operational');
    const read = {
      stages: {
        implementation: {
          prompt: 'prompts/implementation.md',
          prompt_append: '.agentic/prompts/implementation.append.md',
        },
      },
    };
    expect(withoutNotAppliedKeys(read)).toEqual({ values: read, notApplied: [] });

    const outside = withoutNotAppliedKeys({
      stages: {
        implementation: { prompt: '../secrets.md', prompt_append: 'prompts/ok.md' },
        refinement: { prompt: 'prompts/sub/dir.md' },
      },
    });
    // Dropped, so a settings value that resolves is not shadowed by the file's.
    expect(outside.values).toEqual({
      stages: { implementation: { prompt_append: 'prompts/ok.md' } },
    });
    expect(outside.notApplied.map((item) => item.key)).toEqual([
      'stages.implementation.prompt',
      'stages.refinement.prompt',
    ]);
  });

  it('keeps an operational key as written', () => {
    const operational = {
      stages: { refinement: { model: 'claude-sonnet-5', budget_usd: 3, max_turns: 20 } },
      status_mapping: { done: 'Closed' },
    };
    expect(withoutNotAppliedKeys(operational)).toEqual({ values: operational, notApplied: [] });
  });
});

describe('the tighten-only keys', () => {
  it('keeps every protected path the file leaves out, reports it, and adds the file’s own', () => {
    const emptied = tightenRepositoryLayer({}, { policies: { protected_paths: [] } });
    expect(emptied.values.policies?.protected_paths).toEqual(
      PLATFORM_DEFAULT_CONFIG.policies?.protected_paths,
    );
    expect(emptied.notApplied.map((item) => item.key)).toEqual(['policies.protected_paths']);
    const added = tightenRepositoryLayer(
      { policies: { protected_paths: ['tests/**'] } },
      { policies: { protected_paths: ['tests/**', 'secrets/**'] } },
    );
    expect(added.values.policies?.protected_paths).toEqual(['tests/**', 'secrets/**']);
    expect(added.notApplied).toEqual([]);
  });

  it('keeps a settings risk class whole, and lets the file add paths, requirements and classes', () => {
    const settings = {
      policies: {
        risk_classes: {
          payments: { paths: ['src/billing/**'], require: ['plan_approval' as const] },
        },
      },
    };
    const weakened = tightenRepositoryLayer(settings, {
      policies: { risk_classes: { payments: { paths: ['src/unused/**'], require: [] as never } } },
    });
    expect(weakened.values.policies?.risk_classes?.payments).toEqual({
      paths: ['src/billing/**', 'src/unused/**'],
      require: ['plan_approval'],
    });
    expect(weakened.notApplied.map((item) => item.key)).toEqual(['policies.risk_classes.payments']);
    const stricter = tightenRepositoryLayer(settings, {
      policies: {
        risk_classes: {
          payments: { paths: ['src/billing/**'], require: ['plan_approval', 'reviewer:@security'] },
          auth: { paths: ['src/auth/**'], require: ['plan_approval'] },
        },
      },
    });
    expect(stricter.values.policies?.risk_classes?.payments?.require).toEqual([
      'plan_approval',
      'reviewer:@security',
    ]);
    expect(stricter.values.policies?.risk_classes?.auth).toBeDefined();
    expect(stricter.notApplied).toEqual([]);
  });

  it('merges through the settings port with the loosening gone and the tightening in force', () => {
    const merged = projectConfigWithRepository(
      {
        policies: { probation_tasks: 5, protected_paths: ['tests/**'] },
        commands: { allow: ['npm test'] },
      },
      {
        status: 'valid',
        commitSha: 'a'.repeat(40),
        readAt: '2026-09-26T10:00:00.000Z' as never,
        ...withoutNotAppliedKeys({
          policies: { probation_tasks: 0, protected_paths: ['infra/**'] },
          commands: { allow: ['npm test', 'make deploy'] },
        }),
      },
    );
    expect(merged.values.policies?.probation_tasks).toBe(5);
    expect(merged.values.policies?.protected_paths).toEqual(['tests/**', 'infra/**']);
    // The file's commands travel separately, to narrow again after the settings' — never merged.
    expect(merged.values.commands).toEqual({ allow: ['npm test'] });
    expect(merged.repositoryCommands).toEqual({ allow: ['npm test', 'make deploy'] });
    expect(merged.notApplied.map((item) => item.key).sort()).toEqual([
      'policies.probation_tasks',
      'policies.protected_paths',
    ]);
  });
});

/** WP-91: `pipeline.wip` from the file may lower a limit and never raise it (Q101's shape). */
describe('the WIP limits a file may state', () => {
  it('applies a lower limit and keeps, and reports, a higher one', () => {
    const lowered = tightenRepositoryLayer(
      { pipeline: { wip: { max_parallel_tasks: 3 } } },
      { pipeline: { wip: { max_parallel_tasks: 1 } } },
    );
    expect(lowered.values.pipeline?.wip?.max_parallel_tasks).toBe(1);
    expect(lowered.notApplied).toEqual([]);

    const raised = tightenRepositoryLayer(
      { pipeline: { wip: { max_parallel_tasks: 3 } } },
      { pipeline: { wip: { max_parallel_tasks: 9, max_tasks_in_pipeline: 20 } } },
    );
    // The settings' 3, and BD-010's default of 5 where the settings are silent.
    expect(raised.values.pipeline?.wip).toEqual({
      max_parallel_tasks: 3,
      max_tasks_in_pipeline: 5,
    });
    expect(raised.notApplied.map((item) => item.key)).toEqual([
      'pipeline.wip.max_parallel_tasks',
      'pipeline.wip.max_tasks_in_pipeline',
    ]);
  });
});

/** BD-025's 2026-10-05 amendment: a file may move verification to CI, never back (backlog 460). */
describe('the verification mode a file may state', () => {
  const reading = (values: Record<string, unknown>) => ({
    status: 'valid' as const,
    commitSha: 'b'.repeat(40),
    readAt: '2026-10-05T10:00:00.000Z' as never,
    ...withoutNotAppliedKeys(values),
  });

  it('applies `ci` over a local or silent setting, through the settings port', () => {
    for (const settings of [{}, { verification: { mode: 'local' as const } }]) {
      const merged = projectConfigWithRepository(
        settings,
        reading({ verification: { mode: 'ci' } }),
      );
      expect(merged.values.verification?.mode).toBe('ci');
      expect(merged.sources['verification.mode']).toBe('repo');
      expect(merged.notApplied).toEqual([]);
    }
  });

  it('keeps `ci` from the settings over a file that says `local`, and reports it', () => {
    const merged = projectConfigWithRepository(
      { verification: { mode: 'ci' } },
      reading({ verification: { mode: 'local' } }),
    );
    expect(merged.values.verification?.mode).toBe('ci');
    expect(merged.sources['verification.mode']).toBe('project');
    expect(merged.notApplied.map((item) => item.key)).toEqual(['verification.mode']);
    expect(merged.notApplied[0]?.reason).toContain('never back to local');
  });

  it('lets a file restate `local` over a silent setting, which changes nothing', () => {
    const tightened = tightenRepositoryLayer({}, { verification: { mode: 'local' } });
    expect(tightened.values.verification?.mode).toBe('local');
    expect(tightened.notApplied).toEqual([]);
  });
});

describe('the unattended command mode a file may state (BD-025, 2026-10-06)', () => {
  const reading = (values: Record<string, unknown>) => ({
    status: 'valid' as const,
    commitSha: 'c'.repeat(40),
    readAt: '2026-10-06T10:00:00.000Z' as never,
    ...withoutNotAppliedKeys(values),
  });

  it('carries a file’s `deny` to the run’s narrowing, over an `auto` or silent setting', () => {
    for (const settings of [{}, { commands: { unattended: 'auto' as const } }]) {
      const merged = projectConfigWithRepository(
        settings,
        reading({ commands: { unattended: 'deny' } }),
      );
      expect(merged.repositoryCommands?.unattended).toBe('deny');
      expect(merged.notApplied).toEqual([]);
    }
  });

  it('drops a file’s `auto` over a `deny` setting, and reports it', () => {
    const merged = projectConfigWithRepository(
      { commands: { unattended: 'deny' } },
      reading({ commands: { unattended: 'auto', block: ['docker *'] } }),
    );
    expect(merged.repositoryCommands).toEqual({ block: ['docker *'] });
    expect(merged.notApplied.map((item) => item.key)).toEqual(['commands.unattended']);
    expect(merged.notApplied[0]?.reason).toContain('deny is still in force');
  });
});

/**
 * WP-91's ruling: a key the settings layer states and this build does not read is **reported** at
 * the write, as the repository read already reports the file's — never accepted in silence, and
 * never refused (a stored document that carries it must still read).
 */
import { agenticConfigSchema } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { SETTINGS_UNREAD_KEYS, settingsNotApplied } from './settings-grades.js';

describe('settingsNotApplied', () => {
  it('names a stage-level and a template-level `enabled`, with the reason', () => {
    const document = agenticConfigSchema.parse({
      version: 1,
      pipeline: {
        template_overrides: {
          feature: { stages: { business_review: { enabled: false } } },
          bug: { enabled: false, stages: { architecture: { plan_approval: 'always' } } },
        },
      },
    });
    const { version: _v, ...values } = document;
    const report = settingsNotApplied(values);
    expect(report.map((item) => item.key)).toEqual([
      'pipeline.template_overrides.bug.enabled',
      'pipeline.template_overrides.feature.stages.business_review.enabled',
    ]);
    expect(report[1]?.reason).toMatch(/Q99/);
  });

  it('reports nothing for keys that are read — plan_approval and size_threshold', () => {
    expect(
      settingsNotApplied({
        pipeline: {
          template_overrides: {
            bug: { stages: { architecture: { plan_approval: 'always', size_threshold: 'M' } } },
          },
        },
      }),
    ).toEqual([]);
    expect(settingsNotApplied({})).toEqual([]);
  });

  it('names custom stages, and a prompt file only when its value names a file no reader reads (WP-92)', () => {
    const report = settingsNotApplied({
      stages: {
        refinement: { prompt: 'prompts/refinement.md', prompt_append: 'extra.md' },
        implementation: { prompt: '.agentic/prompts/implementation.md' },
      },
      pipeline: { custom_stages: [] },
    });
    // `prompts/refinement.md` and `.agentic/prompts/implementation.md` resolve into the prompt
    // directory and are read, so they are not reported; `extra.md` names a file outside it.
    expect(report.map((item) => item.key)).toEqual([
      'pipeline.custom_stages',
      'stages.refinement.prompt_append',
    ]);
    expect(report[1]?.reason).toMatch(/\.agentic\/prompts\//);
  });

  it('no longer lists the prompt keys as unread (WP-92, criterion 3)', () => {
    expect(Object.keys(SETTINGS_UNREAD_KEYS)).not.toContain('stages.*.prompt');
    expect(Object.keys(SETTINGS_UNREAD_KEYS)).not.toContain('stages.*.prompt_append');
    expect(
      settingsNotApplied({
        stages: {
          code_review: { prompt: 'prompts/code_review.md', prompt_append: 'prompts/extra.md' },
        },
      }),
    ).toEqual([]);
  });

  it('lists only keys the schema can carry', () => {
    // Every pattern names a path under a key the strict schema accepts — a typo here would be a
    // report nobody could ever trigger.
    for (const pattern of Object.keys(SETTINGS_UNREAD_KEYS)) {
      expect(['pipeline', 'stages']).toContain(pattern.split('.')[0]);
    }
  });
});

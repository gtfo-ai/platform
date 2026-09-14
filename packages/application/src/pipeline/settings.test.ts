/**
 * `ProjectSettings` — the port's own small decisions, which had no test of their own.
 *
 * Two of them matter beyond this file. `templateForIssueType` decides which pipeline a ticket walks
 * (product/04 S0) and falls to the **fullest** template rather than the cheapest, which is the safe
 * direction; and `autonomyPresetFor` is what turns WP-30's stored document into the policies the
 * plan-approval gate reads, including the one override a project's configuration can express.
 */
import type { IsoDateTime } from '@platform/contracts';
import { AUTONOMY_PRESETS, materialiseAutonomy } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import {
  autonomyPresetFor,
  DEFAULT_TEMPLATE_ID,
  defaultProjectSettings,
  projectSettingsFrom,
  staticProjectSettings,
  templateForIssueType,
} from './settings.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1' as never;
const AT = '2026-09-14T10:00:00.000Z' as IsoDateTime;

describe('autonomyPresetFor', () => {
  it('is null for a project whose dial was never materialised', () => {
    // Not "the default preset" — standing rule 16, and the whole reason `planApprovalGate` names
    // its fallback rather than substituting one here.
    expect(autonomyPresetFor(defaultProjectSettings(PROJECT))).toBeNull();
  });

  it('is the stored preset for one whose dial was', () => {
    const settings = defaultProjectSettings(PROJECT, {
      autonomy: materialiseAutonomy({ level: 'autonomous', at: AT, appliedBy: null }),
    });
    expect(autonomyPresetFor(settings)).toEqual(AUTONOMY_PRESETS.autonomous);
  });

  it('applies the project’s own configuration override on top of it', () => {
    const settings = defaultProjectSettings(PROJECT, {
      autonomy: materialiseAutonomy({ level: 'supervised', at: AT, appliedBy: null }),
      config: { policies: { probation_tasks: 1 } },
    });
    expect(autonomyPresetFor(settings)?.probationTasks).toBe(1);
    // …and a document with no override changes nothing (standing rule 42).
    expect(
      autonomyPresetFor(
        defaultProjectSettings(PROJECT, {
          autonomy: materialiseAutonomy({ level: 'supervised', at: AT, appliedBy: null }),
          config: { policies: {} },
        }),
      ),
    ).toEqual(AUTONOMY_PRESETS.supervised);
  });
});

describe('templateForIssueType', () => {
  const settings = defaultProjectSettings(PROJECT);

  it('maps the provider’s own type names, case- and whitespace-insensitively', () => {
    expect(templateForIssueType(settings, 'Story')).toBe('feature');
    expect(templateForIssueType(settings, '  bug ')).toBe('bug');
    expect(templateForIssueType(settings, 'Sub-Task')).toBe('chore');
  });

  it('falls to the fullest template for a type nobody mapped, and for none at all', () => {
    // The safe direction: a chore on the feature template only costs a plan, while a feature on the
    // chore template skips architecture and business review.
    expect(templateForIssueType(settings, 'Escalation')).toBe(DEFAULT_TEMPLATE_ID);
    expect(templateForIssueType(settings, null)).toBe(DEFAULT_TEMPLATE_ID);
  });

  it('falls back when a project maps a type onto a template it does not have', () => {
    const broken = defaultProjectSettings(PROJECT, {
      templateByIssueType: { story: 'a-template-nobody-defined' },
    });
    expect(templateForIssueType(broken, 'Story')).toBe(DEFAULT_TEMPLATE_ID);
  });
});

describe('the port’s two constructors', () => {
  it('answers whatever the composition root computed', async () => {
    const settings = defaultProjectSettings(PROJECT, { taskBudgetUsd: 7 });
    expect(await staticProjectSettings(() => settings).forProject(PROJECT)).toBe(settings);
  });

  it('narrows an EffectiveConfig onto the fields the pipeline reads', () => {
    const built = projectSettingsFrom(
      PROJECT,
      { values: { version: 1 }, sources: {}, hash: 'h' } as never,
      { workspaceRoot: '/tmp/ws' },
    );
    expect(built.config).toEqual({ version: 1 });
    expect(built.workspaceRoot).toBe('/tmp/ws');
    expect(built.autonomy).toBeNull();
  });
});

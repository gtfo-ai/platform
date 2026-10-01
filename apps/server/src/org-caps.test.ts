/**
 * WP-113 (PROGRESS backlog 318): the pieces of the capped-projects answer the route test cannot
 * reach through its fake rows — how a row's level and WIP are read, and what an unparsable stored
 * document counts as. The route's own cases are `routes/settings.test.ts`'s.
 */
import { ProjectSettingsInvalidError } from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import { materialiseAutonomy } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { cappedProjectsOf, chosenAutonomyLevelOf, statedWipOf } from './org-caps.js';

const PROJECT = '00000000-0000-4000-8000-0000000000d1';

describe('chosenAutonomyLevelOf', () => {
  it('reads the materialised dial, and the column when the document is absent or does not parse', () => {
    const materialised = materialiseAutonomy({
      level: 'assist',
      at: '2026-09-14T10:00:00.000Z' as IsoDateTime,
      appliedBy: null,
    });
    expect(chosenAutonomyLevelOf(materialised, 'supervised')).toBe('assist');
    expect(chosenAutonomyLevelOf(null, 'supervised')).toBe('supervised');
    expect(chosenAutonomyLevelOf({ level: 'reckless' }, 'observe')).toBe('observe');
  });
});

describe('statedWipOf', () => {
  it('answers the layered value, and `refused` for a settings layer that does not parse', () => {
    expect(statedWipOf(() => ({ pipeline: { wip: { max_parallel_tasks: 3 } } }), null)).toEqual({
      max_parallel_tasks: 3,
    });
    expect(statedWipOf(() => ({}), null)).toBeUndefined();
    expect(
      statedWipOf(() => {
        throw new ProjectSettingsInvalidError(PROJECT as Id, ['pipeline.wip: 0']);
      }, null),
    ).toBe('refused');
  });

  it('rethrows anything that is not the settings refusal', () => {
    expect(() =>
      statedWipOf(() => {
        throw new Error('the database went away');
      }, null),
    ).toThrow('the database went away');
  });
});

describe('cappedProjectsOf', () => {
  it('reads a replaced document that did not parse as stating no maximum', () => {
    const capped = cappedProjectsOf({
      before: { autonomy: { maximum: 'reckless' } },
      after: { autonomy: { maximum: 'assist' } },
      projects: [{ id: PROJECT, key: 'DELTA', level: 'autonomous', wip: undefined }],
    });
    expect(capped).toEqual([
      {
        project_id: PROJECT,
        project_key: 'DELTA',
        setting: 'autonomy',
        before: 'autonomous',
        after: 'assist',
      },
    ]);
  });
});

/**
 * WP-113 (PROGRESS backlog 318): the pieces of the capped-projects answer the route test cannot
 * reach through its fake rows — how a row's level and WIP are read, and what an unparsable stored
 * document counts as. The route's own cases are `routes/settings.test.ts`'s.
 */
import { ProjectSettingsInvalidError } from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import { materialiseAutonomy } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import {
  cappedProjectsOf,
  chosenAutonomyLevelOf,
  raisedWipProjectsOf,
  statedWipOf,
} from './org-caps.js';

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

/**
 * S-25.21 (BACKLOG 1369): the other direction — the projects whose WIP limit **in force** a write
 * raised, so the route appends the event that starts their queue. Both sides of every boundary: a
 * raise, a lowering, a raise the project's own value still bounds, and a refused layer.
 */
describe('raisedWipProjectsOf', () => {
  const ROW = { id: PROJECT, key: 'DELTA', level: 'supervised' as const };

  it('lists a limit in force that rose, before and after', () => {
    // Organisation 1 → 3 over a project that states nothing: in force 1 → BD-010's 2.
    expect(
      raisedWipProjectsOf({
        before: { pipeline: { wip: { max_parallel_tasks: 1 } } },
        after: { pipeline: { wip: { max_parallel_tasks: 3 } } },
        projects: [{ ...ROW, wip: undefined }],
      }),
    ).toEqual([
      {
        projectId: PROJECT,
        raised: [{ key: 'pipeline.wip.max_parallel_tasks', from: 1, to: 2 }],
      },
    ]);
  });

  it('lists nothing for a lowering, for a raise the project’s own value still bounds, or a refused layer', () => {
    const removal = { before: { pipeline: { wip: { max_parallel_tasks: 1 } } }, after: {} };
    expect(
      raisedWipProjectsOf({
        before: { pipeline: { wip: { max_parallel_tasks: 3 } } },
        after: { pipeline: { wip: { max_parallel_tasks: 1 } } },
        projects: [{ ...ROW, wip: undefined }],
      }),
    ).toEqual([]);
    // The project states 1 itself: the organisation's maximum was never what bound it.
    expect(
      raisedWipProjectsOf({ ...removal, projects: [{ ...ROW, wip: { max_parallel_tasks: 1 } }] }),
    ).toEqual([]);
    expect(raisedWipProjectsOf({ ...removal, projects: [{ ...ROW, wip: 'refused' }] })).toEqual([]);
    // …and the same removal does raise a project that states nothing (to BD-010's 2).
    expect(
      raisedWipProjectsOf({ ...removal, projects: [{ ...ROW, wip: undefined }] }),
    ).toHaveLength(1);
  });
});

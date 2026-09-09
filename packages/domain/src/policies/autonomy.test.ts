import { autonomyLevelSchema, sizeSchema } from '@platform/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PROPERTY_TEST_TIMEOUT_MS } from '../testing/property.js';
import {
  AUTONOMY_ORDER,
  AUTONOMY_PRESET_VERSION,
  AUTONOMY_PRESETS,
  applyAutonomyPreset,
  autonomyRank,
  capAutonomy,
  describePresetOverrides,
  isCustomAutonomy,
  requiresBudgetApproval,
  requiresPlanApproval,
  suggestedAutonomyCap,
} from './autonomy.js';

describe('the four dial positions (product/19 §11)', () => {
  it('covers exactly the levels the contracts define', () => {
    expect(Object.keys(AUTONOMY_PRESETS).sort()).toEqual([...autonomyLevelSchema.options].sort());
    expect([...AUTONOMY_ORDER]).toEqual(['observe', 'assist', 'supervised', 'autonomous']);
    expect(AUTONOMY_PRESET_VERSION).toBe(1);
  });

  it('transcribes the preset table', () => {
    expect(AUTONOMY_PRESETS.observe).toMatchObject({
      picksUpNewTickets: false,
      reviewOnly: true,
      shadowMode: true,
      knowledgeAutoApply: false,
      budgetApprovalThresholdUsd: null,
      suggestedReadinessMin: 0,
    });
    expect(AUTONOMY_PRESETS.assist).toMatchObject({
      picksUpNewTickets: true,
      stopAfterStage: 'architecture',
      planApproval: 'always',
      probation: true,
      budgetApprovalThresholdUsd: 20,
    });
    expect(AUTONOMY_PRESETS.supervised).toMatchObject({
      planApproval: 'above_size',
      planApprovalSizeThreshold: 'L',
      probation: true,
      probationTasks: 5,
      businessReview: true,
      humanMrRounds: 3,
      budgetApprovalThresholdUsd: 50,
      suggestedReadinessMin: 1,
    });
    expect(AUTONOMY_PRESETS.autonomous).toMatchObject({
      planApproval: 'never',
      planApprovalForRiskClasses: true,
      probation: false,
      humanMrRounds: 5,
      knowledgeAutoApply: true,
      budgetApprovalThresholdUsd: null,
      suggestedReadinessMin: 2,
    });
  });

  it('keeps the question timeout at 1 working day everywhere (Q8)', () => {
    for (const level of autonomyLevelSchema.options) {
      expect(applyAutonomyPreset(level).questionTimeout).toBe('1 working day');
    }
  });

  it('never lets autonomy shrink as the dial goes up', () => {
    expect(autonomyRank('observe')).toBeLessThan(autonomyRank('assist'));
    expect(autonomyRank('assist')).toBeLessThan(autonomyRank('supervised'));
    expect(autonomyRank('supervised')).toBeLessThan(autonomyRank('autonomous'));
  });
});

describe('readiness caps the suggestion (product/18, Q21)', () => {
  it('suggests at most Assist at readiness level 0', () => {
    expect(suggestedAutonomyCap(0)).toBe('assist');
    expect(suggestedAutonomyCap(1)).toBe('supervised');
    expect(suggestedAutonomyCap(2)).toBe('autonomous');
    expect(suggestedAutonomyCap(5)).toBe('autonomous');
  });

  it(
    'caps a requested level without ever raising it',
    () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...autonomyLevelSchema.options),
          fc.constantFrom(...autonomyLevelSchema.options),
          (requested, cap) => {
            const applied = capAutonomy(requested, cap);
            expect(autonomyRank(applied)).toBeLessThanOrEqual(autonomyRank(requested));
            expect(autonomyRank(applied)).toBeLessThanOrEqual(autonomyRank(cap));
          },
        ),
      );
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );
});

describe('overrides show the dial as Custom (BD-027)', () => {
  it('reports nothing when the project matches its preset', () => {
    expect(describePresetOverrides('supervised', AUTONOMY_PRESETS.supervised)).toEqual([]);
    expect(isCustomAutonomy('supervised', {})).toBe(false);
  });

  it('lists the differing policies with both values', () => {
    const overrides = describePresetOverrides('supervised', { probation: false, humanMrRounds: 3 });
    expect(overrides).toEqual([{ policy: 'probation', preset: true, effective: false }]);
    expect(isCustomAutonomy('supervised', { probation: false })).toBe(true);
  });
});

describe('requiresPlanApproval (BD-006, BD-030)', () => {
  const preset = AUTONOMY_PRESETS.supervised;

  it('requires approval during probation, whatever the size', () => {
    expect(
      requiresPlanApproval({
        preset,
        size: 'S',
        tasksCompleted: 4,
        riskClassesRequiringApproval: [],
      }),
    ).toBe(true);
  });

  it('requires approval at or above the size threshold once probation is over', () => {
    const after = { preset, tasksCompleted: 5, riskClassesRequiringApproval: [] };
    expect(requiresPlanApproval({ ...after, size: 'M' })).toBe(false);
    expect(requiresPlanApproval({ ...after, size: 'L' })).toBe(true);
    expect(requiresPlanApproval({ ...after, size: 'XL' })).toBe(true);
    expect(requiresPlanApproval({ ...after, size: null })).toBe(false);
  });

  it('always requires it in Assist and never in Autonomous', () => {
    expect(
      requiresPlanApproval({
        preset: AUTONOMY_PRESETS.assist,
        size: 'S',
        tasksCompleted: 100,
        riskClassesRequiringApproval: [],
      }),
    ).toBe(true);
    expect(
      requiresPlanApproval({
        preset: AUTONOMY_PRESETS.autonomous,
        size: 'XL',
        tasksCompleted: 100,
        riskClassesRequiringApproval: [],
      }),
    ).toBe(false);
  });

  it('still requires it for a risk-classed change in Autonomous', () => {
    expect(
      requiresPlanApproval({
        preset: AUTONOMY_PRESETS.autonomous,
        size: 'S',
        tasksCompleted: 100,
        riskClassesRequiringApproval: ['auth'],
      }),
    ).toBe(true);
  });

  it(
    'never asks for less than the preset does, for any size',
    () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...sizeSchema.options),
          fc.nat({ max: 20 }),
          (size, tasksCompleted) => {
            const assist = requiresPlanApproval({
              preset: AUTONOMY_PRESETS.assist,
              size,
              tasksCompleted,
              riskClassesRequiringApproval: [],
            });
            expect(assist).toBe(true);
          },
        ),
      );
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );
});

describe('requiresBudgetApproval (product/18)', () => {
  it('routes an expensive task to a maintainer', () => {
    expect(requiresBudgetApproval(AUTONOMY_PRESETS.supervised, 51)).toBe(true);
    expect(requiresBudgetApproval(AUTONOMY_PRESETS.supervised, 50)).toBe(false);
    expect(requiresBudgetApproval(AUTONOMY_PRESETS.assist, 21)).toBe(true);
  });

  it('is off when the level sets no threshold', () => {
    expect(requiresBudgetApproval(AUTONOMY_PRESETS.autonomous, 10_000)).toBe(false);
  });
});

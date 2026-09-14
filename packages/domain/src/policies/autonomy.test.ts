import type { Id, IsoDateTime } from '@platform/contracts';
import {
  autonomyLevelSchema,
  autonomyPoliciesSchema,
  materialisedAutonomySchema,
  sizeSchema,
} from '@platform/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PROPERTY_TEST_TIMEOUT_MS } from '../testing/property.js';
import {
  AUTONOMY_ORDER,
  AUTONOMY_POLICY_WIRE_NAMES,
  AUTONOMY_PRESET_VERSION,
  AUTONOMY_PRESETS,
  applyAutonomyPreset,
  autonomyOverridesFromConfig,
  autonomyRank,
  capAutonomy,
  describePresetOverrides,
  effectiveAutonomyPreset,
  fromWireAutonomyPolicies,
  isCustomAutonomy,
  materialiseAutonomy,
  requiresBudgetApproval,
  requiresPlanApproval,
  suggestedAutonomyCap,
  toWireAutonomyPolicies,
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

  /**
   * The ladder is written down **twice** — as a function of the readiness level here, and as
   * `AutonomyPreset.suggestedReadinessMin` in the preset table — and this is what holds the two
   * together.
   *
   * `suggestedReadinessMin` has no reader in this build, which is what its `AUTONOMY_POLICY_READERS`
   * entry says (review round 2: the entry previously claimed a `routes/autonomy.ts` that does not
   * exist). A published number nothing reads is exactly the kind that drifts away from the
   * behaviour it describes, so the agreement is asserted rather than assumed: for every readiness
   * level, the cap is the **highest** position whose declared minimum that level meets.
   */
  it('agrees with the preset table’s own declared minimum, at every level', () => {
    for (const level of [0, 1, 2, 3, 5]) {
      const reachable = AUTONOMY_ORDER.filter(
        (position) => AUTONOMY_PRESETS[position].suggestedReadinessMin <= level,
      );
      const highest = reachable[reachable.length - 1];
      expect(suggestedAutonomyCap(level), `readiness ${level}`).toBe(highest);
    }
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

describe('materialising the dial (BD-027:14, WP-30)', () => {
  it('maps every preset field onto exactly the wire schema’s keys, and back', () => {
    // Standing rule 68: the mapping is over a **set**, so the set is enumerated rather than
    // sampled. A field added to `AutonomyPreset` and forgotten in the wire map fails to compile;
    // a key added to the schema and forgotten in the map fails here.
    expect(Object.keys(AUTONOMY_POLICY_WIRE_NAMES).sort()).toEqual(
      Object.keys(AUTONOMY_PRESETS.supervised).sort(),
    );
    expect(Object.values(AUTONOMY_POLICY_WIRE_NAMES).sort()).toEqual(
      Object.keys(autonomyPoliciesSchema.shape).sort(),
    );
    for (const level of AUTONOMY_ORDER) {
      const wire = toWireAutonomyPolicies(AUTONOMY_PRESETS[level]);
      expect(autonomyPoliciesSchema.parse(wire)).toEqual(wire);
      expect(fromWireAutonomyPolicies(wire)).toEqual(AUTONOMY_PRESETS[level]);
    }
  });

  it('records the level, the table’s version and who applied it', () => {
    const materialised = materialiseAutonomy({
      level: 'assist',
      at: '2026-09-14T10:00:00.000Z' as IsoDateTime,
      appliedBy: '00000000-0000-4000-8000-000000000001' as Id,
    });
    expect(materialisedAutonomySchema.parse(materialised)).toEqual(materialised);
    expect(materialised.preset_version).toBe(AUTONOMY_PRESET_VERSION);
    expect(materialised.policies.budget_approval_threshold_usd).toBe(20);
    // `applied_by` is nullable and is never a name the platform invents (a migration's rows).
    expect(
      materialiseAutonomy({
        level: 'observe',
        at: '2026-09-14T10:00:00.000Z' as IsoDateTime,
        appliedBy: null,
      }).applied_by,
    ).toBeNull();
  });

  /**
   * **The property BD-027:14 is about, driven directly.**
   *
   * *"changing a preset definition in a release never silently changes a project's effective
   * policies"*. A materialised document is data, so the falsification is to hand the reader a
   * document from a table that no longer exists and show the reader answers the **stored** values —
   * which is what an edited `AUTONOMY_PRESETS` would look like from a stored project's point of
   * view. The re-apply half is the other direction (standing rule 42): materialising again answers
   * the current table.
   */
  it('answers the stored policies after the source table has moved, and the new ones on re-apply', () => {
    const asShipped = materialiseAutonomy({
      level: 'supervised',
      at: '2026-09-14T10:00:00.000Z' as IsoDateTime,
      appliedBy: null,
    });
    // The release that edits the table: here, a document whose stored values differ from the
    // current source, which is the only observable difference an edit makes.
    const stored = {
      ...asShipped,
      policies: { ...asShipped.policies, probation_tasks: 99, plan_approval: 'always' as const },
    };
    const effective = effectiveAutonomyPreset(stored, undefined);
    expect(effective.probationTasks).toBe(99);
    expect(effective.planApproval).toBe('always');
    // …and nothing about the source table changed to make that happen.
    expect(AUTONOMY_PRESETS.supervised.probationTasks).toBe(5);
    // "Re-apply preset" is materialising again — the current table, for the same level.
    const reapplied = materialiseAutonomy({
      level: stored.level,
      at: '2026-09-14T11:00:00.000Z' as IsoDateTime,
      appliedBy: null,
    });
    expect(effectiveAutonomyPreset(reapplied, undefined).probationTasks).toBe(5);
    expect(effectiveAutonomyPreset(reapplied, undefined).planApproval).toBe('above_size');
  });

  it('applies the project’s own configuration override on top of the stored preset', () => {
    const stored = materialiseAutonomy({
      level: 'supervised',
      at: '2026-09-14T10:00:00.000Z' as IsoDateTime,
      appliedBy: null,
    });
    expect(effectiveAutonomyPreset(stored, { probation_tasks: 2 }).probationTasks).toBe(2);
    // "Probation for 0 tasks" and "probation off" are the same behaviour, so the count decides.
    expect(effectiveAutonomyPreset(stored, { probation_tasks: 0 }).probation).toBe(false);
    // Both ways (standing rule 42): a document with no override changes nothing.
    expect(effectiveAutonomyPreset(stored, {})).toEqual(fromWireAutonomyPolicies(stored.policies));
    expect(autonomyOverridesFromConfig(undefined)).toEqual({});
  });

  /**
   * *Custom* is measured against the **stored** preset, not against the level (criterion 2).
   *
   * Both directions: a project that overrode nothing is not Custom, and one that did is — with the
   * differences named. The third case is the one the baseline argument exists for: a project whose
   * stored preset differs from the current table is **not** Custom, because nobody overrode
   * anything; only the release moved.
   */
  it('computes Custom from the stored preset and both ways', () => {
    const stored = materialiseAutonomy({
      level: 'supervised',
      at: '2026-09-14T10:00:00.000Z' as IsoDateTime,
      appliedBy: null,
    });
    const baseline = fromWireAutonomyPolicies(stored.policies);
    expect(isCustomAutonomy(baseline, effectiveAutonomyPreset(stored, undefined))).toBe(false);
    const overridden = effectiveAutonomyPreset(stored, { probation_tasks: 2 });
    expect(isCustomAutonomy(baseline, overridden)).toBe(true);
    expect(
      describePresetOverrides(baseline, overridden)
        .map((entry) => entry.policy)
        .sort(),
    ).toEqual(['probationTasks']);

    const fromAnOlderRelease = fromWireAutonomyPolicies({
      ...stored.policies,
      human_mr_rounds: 9,
    });
    // Against the stored copy: not Custom, because nothing was overridden.
    expect(
      isCustomAutonomy(
        fromAnOlderRelease,
        effectiveAutonomyPreset(
          { ...stored, policies: { ...stored.policies, human_mr_rounds: 9 } },
          undefined,
        ),
      ),
    ).toBe(false);
    // Against the *level*, which is what a reader that re-derived would do: Custom, wrongly.
    expect(isCustomAutonomy('supervised', fromAnOlderRelease)).toBe(true);
  });
});

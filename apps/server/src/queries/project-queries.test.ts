/**
 * The dial's projection, as a pure function of the row (WP-30, BD-027).
 *
 * `findProjectAutonomy` is four columns and one derivation, and everything worth asserting is the
 * derivation — so it is separated and driven here rather than once, slowly, through a container.
 * Both directions throughout (standing rule 42): a projection that always said *Custom* and one
 * that never did would each pass half of this file.
 *
 * The module's other pure function, `dayMinus`, keeps its own suite at the bottom — this file's
 * original subject, which WP-30 wrote over instead of extending.
 */

import type { Id, IsoDateTime } from '@platform/contracts';
import {
  AUTONOMY_PRESET_VERSION,
  applyAutonomyPreset,
  materialiseAutonomy,
  toWireAutonomyPolicies,
} from '@platform/domain';
import { describe, expect, it } from 'vitest';
import type { AutonomyRow } from './project-queries.js';
import { autonomyResponseFrom, dayMinus, SPEND_WINDOW_DAYS } from './project-queries.js';

const AT = '2026-09-14T10:00:00.000Z' as IsoDateTime;

const row = (overrides: Partial<AutonomyRow> = {}): AutonomyRow => ({
  level: 'supervised',
  policies: materialiseAutonomy({ level: 'supervised', at: AT, appliedBy: null }),
  readinessLevel: 1,
  config: {},
  ...overrides,
});

describe('the materialised dial', () => {
  it('publishes the stored policies and says when they were applied', () => {
    const published = autonomyResponseFrom(row());
    expect(published.materialised).toBe(true);
    expect(published.applied_at).toBe(AT);
    expect(published.preset_version).toBe(AUTONOMY_PRESET_VERSION);
    expect(published.preset_outdated).toBe(false);
    expect(published.policies.probation_tasks).toBe(5);
    expect(published.is_custom).toBe(false);
    expect(published.overrides).toEqual([]);
  });

  /**
   * **BD-027:14 through the read.** The stored document differs from what this release ships — which
   * is the only observable difference an edited preset table makes — and the reader answers the
   * stored values, marks the copy out of date, and still does not call the project *Custom*, because
   * nobody overrode anything.
   */
  it('answers the stored policies when the release has moved, and says the preset is out of date', () => {
    const stored = materialiseAutonomy({ level: 'supervised', at: AT, appliedBy: null });
    const published = autonomyResponseFrom(
      row({ policies: { ...stored, policies: { ...stored.policies, probation_tasks: 99 } } }),
    );
    expect(published.policies.probation_tasks).toBe(99);
    expect(published.preset_outdated).toBe(true);
    expect(published.is_custom).toBe(false);
    // …and the source table still says otherwise, which is what makes that a difference.
    expect(applyAutonomyPreset('supervised').probationTasks).toBe(5);
  });

  it('says the preset is out of date when only the version moved', () => {
    const stored = materialiseAutonomy({ level: 'supervised', at: AT, appliedBy: null });
    expect(
      autonomyResponseFrom(row({ policies: { ...stored, preset_version: 99 } })).preset_outdated,
    ).toBe(true);
  });

  it('lists the differences a project’s own configuration makes, and calls it Custom', () => {
    const published = autonomyResponseFrom(row({ config: { policies: { probation_tasks: 2 } } }));
    expect(published.is_custom).toBe(true);
    // Only the field that actually moved: `probation` is `true` in the preset **and** effective at
    // a count of 2, so it is not a difference. A list built from the override map rather than from
    // the comparison would report it and read as two changes where a person made one.
    expect(published.overrides).toEqual([{ policy: 'probationTasks', preset: 5, effective: 2 }]);
    // The *effective* policies are what the pipeline reads, so they carry the override.
    expect(published.policies.probation_tasks).toBe(2);

    // …and a count of zero moves both, because "probation for 0 tasks" is "probation off".
    expect(
      autonomyResponseFrom(row({ config: { policies: { probation_tasks: 0 } } })).overrides,
    ).toEqual([
      { policy: 'probation', preset: true, effective: false },
      { policy: 'probationTasks', preset: 5, effective: 0 },
    ]);
  });

  it('names who applied it, or null, and never invents a name', () => {
    const by = '00000000-0000-4000-8000-000000000001' as Id;
    expect(
      autonomyResponseFrom(
        row({ policies: materialiseAutonomy({ level: 'assist', at: AT, appliedBy: by }) }),
      ).applied_by,
    ).toBe(by);
    expect(autonomyResponseFrom(row()).applied_by).toBeNull();
  });
});

describe('a dial that was never materialised', () => {
  it('says so, and publishes this release’s preset for the level marked as such', () => {
    // Standing rule 16: the absent case is not the quiet one. The policies are still answered —
    // a screen needs something to render — but `materialised: false` is what says they were never
    // chosen, and the pipeline keeps its pre-WP-30 gate for exactly this row.
    const published = autonomyResponseFrom(row({ policies: null }));
    expect(published.materialised).toBe(false);
    expect(published.applied_at).toBeNull();
    expect(published.preset_outdated).toBe(false);
    expect(published.policies).toEqual(toWireAutonomyPolicies(applyAutonomyPreset('supervised')));
    expect(published.level).toBe('supervised');
  });

  it('treats a document this release cannot parse the same way', () => {
    // A column written by a future release, or by hand. Parsing it as "whatever is in it" would
    // publish a policy set nothing validated; reading it as *not materialised* is the honest answer
    // and it is the one the pipeline's own reader gives.
    expect(autonomyResponseFrom(row({ policies: { level: 'supervised' } })).materialised).toBe(
      false,
    );
    expect(autonomyResponseFrom(row({ policies: 'not-a-document' })).materialised).toBe(false);
  });

  it('still applies the project’s own override on top', () => {
    const published = autonomyResponseFrom(
      row({ policies: null, config: { policies: { probation_tasks: 0 } } }),
    );
    expect(published.policies.probation).toBe(false);
    expect(published.is_custom).toBe(true);
  });
});

describe('the readiness suggestion', () => {
  it('is a suggestion, and says when the choice is above it', () => {
    // product/18, BD-026, Q21: readiness caps the **suggested** level and never the chosen one.
    // Both directions, because a flag that was always true would be a refusal in disguise.
    const above = autonomyResponseFrom(
      row({
        level: 'autonomous',
        policies: materialiseAutonomy({ level: 'autonomous', at: AT, appliedBy: null }),
        readinessLevel: 0,
      }),
    );
    expect(above.suggested_cap).toBe('assist');
    expect(above.above_suggested_cap).toBe(true);

    const within = autonomyResponseFrom(row({ readinessLevel: 2 }));
    expect(within.suggested_cap).toBe('autonomous');
    expect(within.above_suggested_cap).toBe(false);
  });

  it('reads the level off the materialised document rather than the column', () => {
    // The two agree in production — both writers set them together — and when they do not, the
    // document is the one that says what the policies mean.
    const published = autonomyResponseFrom(
      row({
        level: 'observe',
        policies: materialiseAutonomy({ level: 'autonomous', at: AT, appliedBy: null }),
      }),
    );
    expect(published.level).toBe('autonomous');
  });
});

/**
 * `dayMinus`, which is the whole of `spent_usd_30d`'s window arithmetic.
 *
 * It is calendar arithmetic on the `YYYY-MM-DD` key `cost_rollup_daily` is written with, and that
 * is the point: the key was computed in the organisation's timezone by `rollupDay` (WP-19, Q12), so
 * subtracting thirty days from an *instant* would be subtracting from the wrong clock — and would
 * be off by an hour across a DST boundary, which moves the answer by a whole day whenever the
 * instant is inside the first hour of one.
 *
 * **This suite was the whole of this file before WP-30** and was lost when the dial's projection
 * was written over it rather than beside it; it is restored unchanged (review round 2, standing
 * rule 44 — a deleted assertion is a decision somebody records).
 */
describe('dayMinus', () => {
  it('counts back in calendar days, across a month and a year boundary', () => {
    expect(dayMinus('2026-09-13', 0)).toBe('2026-09-13');
    expect(dayMinus('2026-09-13', 1)).toBe('2026-09-12');
    expect(dayMinus('2026-03-01', 1)).toBe('2026-02-28');
    expect(dayMinus('2026-01-01', 1)).toBe('2025-12-31');
    // A leap year, because February is where a day-count and a month-count disagree.
    expect(dayMinus('2028-03-01', 1)).toBe('2028-02-29');
  });

  it('spans exactly thirty days including today, which is what the DTO promises', () => {
    // `spent_usd_30d` is "the last thirty days", so the cutoff is today minus twenty-nine: the sum
    // is inclusive at both ends. Off by one here is a whole day of spend, silently.
    const cutoff = dayMinus('2026-09-30', SPEND_WINDOW_DAYS - 1);
    expect(cutoff).toBe('2026-09-01');
    const days =
      (Date.parse('2026-09-30T00:00:00Z') - Date.parse(`${cutoff}T00:00:00Z`)) / 86_400_000;
    expect(days + 1).toBe(SPEND_WINDOW_DAYS);
  });

  it('is unaffected by the clock the key was computed in', () => {
    // Whatever zone `rollupDay` used, the key it produced is a date and this is date arithmetic:
    // the same key gives the same cutoff regardless of where the process runs.
    expect(dayMinus('2026-10-25', 1)).toBe('2026-10-24');
    // …including the day European DST ends, which is 25 hours long in Europe/Prague.
    expect(dayMinus('2026-10-26', 1)).toBe('2026-10-25');
  });

  it('refuses a value that is not a rollup key rather than answering with Invalid Date', () => {
    for (const bad of ['', 'yesterday', '2026-13-45', 'null']) {
      expect(() => dayMinus(bad, 1), bad).toThrow(TypeError);
    }
  });
});

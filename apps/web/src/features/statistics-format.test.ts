/**
 * The statistics screen's formatting, one rule at a time (S-23.19): a value per unit, `null` as no
 * value, what the samples count, each metric's reading, the range's dates, the sections, and the
 * sparkline's geometry and words.
 */
import type { StatBucket, StatMetricId, StatUnit } from '@platform/contracts';
import { statMetricIdSchema, statUnitSchema } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import {
  formatCivilDate,
  formatSamples,
  formatStatValue,
  groupIntoSections,
  STAT_READING,
  STAT_SECTIONS,
  sparklineSegments,
  statReadingWords,
  trendSummary,
} from './statistics-format.js';

const bucket = (value: number | null, day = 1): StatBucket => ({
  start: `2026-06-${String(day).padStart(2, '0')}`,
  end: `2026-06-${String(day + 1).padStart(2, '0')}`,
  value,
  samples: value === null ? 0 : 1,
});

describe('formatStatValue', () => {
  it.each<[StatUnit, number, string]>([
    ['count', 1234, '1,234'],
    ['decimal', 8, '8.0'],
    ['decimal', 1.25, '1.3'],
    ['ratio', 0.5, '50.0%'],
    ['ratio', 0.99175, '99.2%'],
    ['usd', 123.05, '$123.05'],
    ['minutes', 135, '2 h 15 m'],
    ['hours', 10, '10.0 h'],
  ])('prints %s %d as %s', (unit, value, printed) => {
    expect(formatStatValue(value, unit)).toBe(printed);
  });

  it('answers every unit the contract declares', () => {
    // Parameterised over the enum (rule 68): a unit added to the contract and not here fails.
    for (const unit of statUnitSchema.options) {
      expect(formatStatValue(1, unit), unit).toEqual(expect.any(String));
    }
  });

  it('never prints a missing value as a number, in any unit', () => {
    for (const unit of statUnitSchema.options) {
      expect(formatStatValue(null, unit), unit).toBeNull();
    }
  });

  it('never multiplies an average count by 100', () => {
    // The owner's live page read "Returns per delivered task 800.0%" for eight returns.
    expect(formatStatValue(8, 'decimal')).not.toContain('%');
    expect(formatStatValue(8, 'ratio')).toBe('800.0%');
  });
});

describe('formatSamples (S-25.7, research/21 F15)', () => {
  it.each<[StatMetricId, number, string]>([
    ['tasks_started', 0, 'Nothing measured in this range'],
    ['tasks_started', 1, 'From 1 task'],
    ['merge_rate', 3, 'From 3 tasks'],
    ['returns_per_delivered_task', 1200, 'From 1,200 delivered tasks'],
    ['question_response_minutes', 2, 'From 2 answered questions'],
    ['cost_total', 1, 'From 1 day with spend'],
    // A metric whose samples are not a named thing says so plainly.
    ['concurrent_task_overlaps', 4, 'From 4 data points'],
  ])('says %s with %d samples as %s', (id, samples, printed) => {
    expect(formatSamples(id, samples)).toBe(printed);
  });

  it('never says "observation", for any metric of the contract', () => {
    for (const id of statMetricIdSchema.options) {
      for (const samples of [0, 1, 2]) {
        expect(formatSamples(id, samples), id).not.toMatch(/observation/i);
      }
    }
  });
});

describe('the reading direction (S-25.7, research/21 F15)', () => {
  it('gives every metric of the contract a reading, and says it in words', () => {
    // Parameterised over the enum (rule 68): the `Record` type fails a new id at the typecheck,
    // and this fails one that slipped past it at run time.
    expect(Object.keys(STAT_READING).sort()).toEqual([...statMetricIdSchema.options].sort());
    expect(statReadingWords('returns_per_delivered_task')).toBe('Lower is better');
    expect(statReadingWords('merge_rate')).toBe('Higher is better');
    expect(statReadingWords('cost_total')).toBe('A volume, not a score');
  });

  it('reads a count and a total as volumes, and an average per delivered task as a score (review of #86)', () => {
    // More conflicts resolved also means more conflicts; a total cost is how much, like `cost_total`.
    expect(STAT_READING.rebase_conflicts_resolved).toBeNull();
    expect(STAT_READING.total_cost_of_delivery).toBeNull();
    expect(STAT_READING.cost_total).toBeNull();
    // Agent time is an average per delivered task: less for the same delivery is better.
    expect(STAT_READING.agent_time_hours).toBe('lower');
  });

  it('reads a cost, a time and a rate of trouble as lower-is-better', () => {
    for (const id of [
      'cost_per_delivered_task',
      'cycle_time_hours',
      'human_intervention_rate',
      'estimate_accuracy',
    ] as const) {
      expect(STAT_READING[id], id).toBe('lower');
    }
  });
});

describe('formatCivilDate', () => {
  it('writes a civil date as the other screens write a date, in no reader’s zone', () => {
    expect(formatCivilDate('2026-09-10')).toBe('Sep 10, 2026');
    // The last day of a month stays on it: read and written in UTC, never shifted a day.
    expect(formatCivilDate('2026-09-30')).toBe('Sep 30, 2026');
    expect(formatCivilDate('not a date')).toBe('not a date');
  });
});

describe('the sections', () => {
  it('holds every metric of the contract exactly once', () => {
    const named = STAT_SECTIONS.flatMap((section) => section.metrics);
    expect(new Set(named).size).toBe(named.length);
    // Absent-only metrics are listed under "Not measured" and have no card; every other id of the
    // contract has a section, so none falls through to "Other" today.
    const alwaysAbsent: readonly StatMetricId[] = [
      'shadow_similarity',
      'clean_first_mr_rate_by_author',
      'readiness_attributed_returns',
      'queue_wait_minutes',
      'total_cost_of_delivery',
    ];
    expect([...named, ...alwaysAbsent].sort()).toEqual([...statMetricIdSchema.options].sort());
  });

  it('starts with the four sections the owner named, in that order', () => {
    expect(STAT_SECTIONS.slice(0, 4).map((section) => section.title)).toEqual([
      'Throughput',
      'Quality',
      'Cost',
      'Time',
    ]);
    expect(STAT_SECTIONS[2]?.metrics).toEqual([
      'cost_total',
      'cost_per_delivered_task',
      'estimated_spend_share',
      'estimate_accuracy',
      'cache_hit_ratio',
    ]);
  });

  it('leaves empty sections out and puts an unknown metric under Other', () => {
    const grouped = groupIntoSections([
      { id: 'cache_hit_ratio' as StatMetricId },
      { id: 'tasks_started' as StatMetricId },
      { id: 'shadow_similarity' as StatMetricId },
    ]);
    expect(grouped.map((section) => [section.title, section.metrics.map((m) => m.id)])).toEqual([
      ['Throughput', ['tasks_started']],
      ['Cost', ['cache_hit_ratio']],
      ['Other', ['shadow_similarity']],
    ]);
  });
});

describe('the sparkline', () => {
  it('draws nothing for fewer than two values — one point is not a trend', () => {
    expect(sparklineSegments([])).toBeNull();
    expect(sparklineSegments([bucket(3), bucket(null, 2)])).toBeNull();
    expect(trendSummary([bucket(3)], 'count', 'day')).toBeNull();
  });

  it('spans the width and the height between the lowest and the highest value', () => {
    expect(sparklineSegments([bucket(0, 1), bucket(5, 2), bucket(10, 3)])).toEqual([
      '0,22 50,12 100,2',
    ]);
  });

  it('draws a flat series through the middle rather than dividing by zero', () => {
    expect(sparklineSegments([bucket(4, 1), bucket(4, 2)])).toEqual(['0,12 100,12']);
  });

  it('breaks the line at a bucket with no value instead of dropping it to zero', () => {
    expect(sparklineSegments([bucket(1, 1), bucket(2, 2), bucket(null, 3), bucket(3, 4)])).toEqual([
      '0,22 33.33,12',
      '100,2',
    ]);
  });

  it('states the trend in words, in the metric’s own unit', () => {
    expect(trendSummary([bucket(0.25, 1), bucket(null, 2), bucket(0.5, 3)], 'ratio', 'week')).toBe(
      'Trend by week: 2 of 3 weeks with data; lowest 25.0%, highest 50.0%, latest 50.0%.',
    );
  });
});

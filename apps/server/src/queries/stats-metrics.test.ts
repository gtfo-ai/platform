/**
 * The statistics catalogue and its arithmetic — every definition, every ratio and every stated
 * absence, against rows a test wrote (WP-41).
 *
 * This is where the properties the *shape* is for are asserted: a metric this build cannot compute
 * is absent with an owner rather than zero (standing rule 16), a metric that has no observations
 * is `null` rather than zero unless zero is the measurement, minutes and dollars are never added
 * (Q73), and the CSV has no cell a spreadsheet would read as a number the platform did not measure.
 */
import type { IsoDateTime, StatMetric, StatMetricId } from '@platform/contracts';
import { orgStatsResponseSchema } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import {
  bucketStartOf,
  bucketsOf,
  foldStats,
  RANGE_DAYS,
  resolveRange,
  STATS_CATALOGUE,
  STATS_CSV_HEADER,
  STATS_METRIC_IDS,
  type StatsSources,
  statsToCsv,
} from './stats-metrics.js';

const EMPTY: StatsSources = {
  startedTasks: [],
  deliveredTasks: [],
  counters: [],
  cost: [],
  estimatedSpend: [],
  questions: [],
  humanMinutes: [],
  kbProposals: [],
  stageReturns: [],
};

const fold = (sources: Partial<StatsSources> = {}, bucket: 'day' | 'week' | 'month' = 'day') =>
  foldStats({
    range: resolveRange('7d', bucket, '2026-06-07'),
    timezone: 'UTC',
    timezoneSubstituted: false,
    projectId: null,
    generatedAt: '2026-06-07T12:00:00.000Z' as IsoDateTime,
    sources: { ...EMPTY, ...sources },
  });

const metric = (response: ReturnType<typeof fold>, id: StatMetricId): StatMetric => {
  const found = response.metrics.find((entry) => entry.id === id);
  if (found === undefined) {
    throw new Error(`no metric ${id}`);
  }
  return found;
};

const delivered = (overrides: Partial<StatsSources['deliveredTasks'][number]> = {}) => ({
  mergedDay: '2026-06-03',
  cycleHours: 10,
  agentHours: 1,
  returns: 0,
  humanReviewEntries: 0,
  questions: 0,
  costUsd: 4,
  estimateUsd: null,
  costActual: 4,
  ...overrides,
});

describe('the catalogue', () => {
  it('publishes every metric the contract declares, in one order', () => {
    // Standing rule 68: the table is parameterised over the DTO's enum, so a metric added to the
    // contract and forgotten here fails rather than disappearing from the screen.
    expect(STATS_METRIC_IDS.length).toBe(Object.keys(STATS_CATALOGUE).length);
    expect(fold().metrics.map((entry) => entry.id)).toEqual([...STATS_METRIC_IDS]);
  });

  it('gives every metric a definition, because a number is published with its meaning', () => {
    // product/10:63. Asserted over the whole table rather than over an example: a definition that
    // was forgotten would otherwise be invisible until somebody hovered the tooltip.
    for (const entry of fold().metrics) {
      expect(entry.definition.length, entry.id).toBeGreaterThan(40);
      expect(entry.label.length, entry.id).toBeGreaterThan(2);
    }
  });

  it('names an owner for every metric it cannot compute, and publishes no zero for one', () => {
    const absent = fold().metrics.filter((entry) => entry.absent !== null);
    // The anchor first (rule 4): a fold that produced no absent metrics would pass the loop below
    // without asserting anything.
    expect(absent.map((entry) => entry.id)).toEqual([
      'kb_usage',
      'tickets_edited_after_lint',
      'shadow_similarity',
      'clean_first_mr_rate_by_author',
      'readiness_attributed_returns',
      'loc_changed',
      'defect_escape',
      'queue_wait_minutes',
      'total_cost_of_delivery',
    ]);
    for (const entry of absent) {
      expect(entry.value, entry.id).toBeNull();
      expect(entry.samples, entry.id).toBe(0);
      // No buckets at all: an array of nulls invites a chart to draw a flat line, which is the
      // zero this shape exists to refuse (standing rule 16).
      expect(entry.buckets, entry.id).toEqual([]);
      expect(entry.absent?.reason.length ?? 0, entry.id).toBeGreaterThan(40);
      expect(entry.absent?.owner.length ?? 0, entry.id).toBeGreaterThan(5);
    }
  });

  it('never adds minutes to dollars (Q73)', () => {
    const response = fold({
      cost: [{ day: '2026-06-03', usd: 10, inputTokens: 100, cacheReadTokens: 50 }],
      humanMinutes: [{ day: '2026-06-03', kind: 'review', minutes: 120 }],
    });
    expect(metric(response, 'cost_total').value).toBe(10);
    expect(metric(response, 'human_minutes').value).toBe(120);
    // The single number product/09:29 asks for is the one metric that stays absent while no rate
    // exists, and its owner is the question that would supply one.
    expect(metric(response, 'total_cost_of_delivery').absent?.owner).toContain('Q73');
  });

  it('carries the error directions of the reviewer figures rather than publishing them silently', () => {
    const caveats = metric(fold(), 'reviewer_minutes_per_delivered_task').caveats.join(' ');
    expect(caveats).toContain('backlog 88');
    expect(caveats).toContain('backlog 90');
    expect(caveats).toContain('backlog 89');
    expect(caveats).toContain('do not cancel');
  });
});

describe('the arithmetic', () => {
  it('counts a delivery in the bucket it merged in, and a start in the bucket it started in', () => {
    const response = fold({
      startedTasks: [{ startedDay: '2026-06-01', intervened: false }],
      deliveredTasks: [delivered({ mergedDay: '2026-06-03' })],
    });
    expect(metric(response, 'tasks_started').buckets.map((b) => [b.start, b.value])).toContainEqual(
      ['2026-06-01', 1],
    );
    expect(
      metric(response, 'tasks_delivered').buckets.map((b) => [b.start, b.value]),
    ).toContainEqual(['2026-06-03', 1]);
    expect(metric(response, 'merge_rate').value).toBe(1);
  });

  it('answers null for a ratio with no denominator, and zero for a count with no events', () => {
    const response = fold();
    // "Nothing was delivered" is a measured zero; "there is nothing to divide" is not a zero.
    expect(metric(response, 'tasks_delivered').value).toBe(0);
    expect(metric(response, 'rebase_conflicts_escalated').value).toBe(0);
    expect(metric(response, 'merge_rate').value).toBeNull();
    expect(metric(response, 'cycle_time_hours').value).toBeNull();
    expect(metric(response, 'estimate_accuracy').value).toBeNull();
  });

  it('divides the summed numerator by the summed denominator, never the mean of the ratios', () => {
    const response = fold({
      startedTasks: [
        { startedDay: '2026-06-01', intervened: true },
        { startedDay: '2026-06-01', intervened: false },
        { startedDay: '2026-06-02', intervened: false },
      ],
    });
    // 1 of 3, not the mean of (1/2, 0/1) = 0.25 — a busy day must not weigh the same as a quiet one.
    expect(metric(response, 'human_intervention_rate').value).toBeCloseTo(1 / 3, 6);
  });

  it('holds first-pass acceptance to zero returns and zero human comments', () => {
    const response = fold({
      deliveredTasks: [
        delivered(),
        delivered({ returns: 1 }),
        delivered({ humanReviewEntries: 2 }),
        delivered({ questions: 3 }),
      ],
    });
    // Rule 42: one case at the boundary and one past it, in both directions — the clean task, the
    // returned one, the commented one. The task with a question is clean by *this* definition and
    // not by the clean-first-MR one, which is the difference between the two metrics.
    expect(metric(response, 'first_pass_acceptance').value).toBe(0.5);
    expect(metric(response, 'clean_first_mr_rate').value).toBe(0.5);
  });

  it('computes estimate accuracy from the estimate and the actual and from nothing else', () => {
    const response = fold({
      deliveredTasks: [
        delivered({ estimateUsd: 4, costActual: 8 }),
        delivered({ estimateUsd: 8, costActual: 8 }),
        // No estimate: not a zero-error data point, not in the mean at all.
        delivered({ estimateUsd: null, costActual: 8 }),
        // A task that spent nothing has no relative error to measure — dividing by it is Infinity.
        delivered({ estimateUsd: 4, costActual: 0 }),
      ],
    });
    expect(metric(response, 'estimate_accuracy').value).toBe(0.25);
    expect(metric(response, 'estimate_accuracy').samples).toBe(2);
  });

  it('reads the review-only counters as thread totals and the rest as event counts', () => {
    const response = fold({
      counters: [
        { day: '2026-06-02', metric: 'review_only.threads_accepted', count: 2, total: 5 },
        { day: '2026-06-02', metric: 'review_only.threads_dismissed', count: 2, total: 1 },
        { day: '2026-06-02', metric: 'rebase.resolved', count: 3, total: 0 },
        { day: '2026-06-02', metric: 'rebase.exhausted', count: 1, total: 0 },
        { day: '2026-06-02', metric: 'conflict.warned', count: 4, total: 12 },
        { day: '2026-06-02', metric: 'ticket_lint.posted', count: 6, total: 9 },
        // A counter no metric maps to is ignored rather than published under a guessed name.
        { day: '2026-06-02', metric: 'review_only.observed', count: 2, total: 0 },
      ],
    });
    expect(metric(response, 'review_findings_accepted').value).toBe(5);
    expect(metric(response, 'review_findings_dismissed').value).toBe(1);
    expect(metric(response, 'rebase_conflicts_resolved').value).toBe(3);
    expect(metric(response, 'rebase_conflicts_escalated').value).toBe(1);
    expect(metric(response, 'concurrent_task_overlaps').value).toBe(4);
    expect(metric(response, 'ticket_lint_comments').value).toBe(6);
  });

  it('publishes the estimated share of spend from the ledger rather than from `tasks.cost_estimated`', () => {
    // PROGRESS backlog 75: the column had no writer and WP-47 dropped it (migration 0035), so the
    // share is a projection over `cost_entries.is_estimate` and there is no fourth stored number.
    const response = fold({
      estimatedSpend: [{ day: '2026-06-02', usd: 10, estimatedUsd: 2.5 }],
    });
    expect(metric(response, 'estimated_spend_share').value).toBe(0.25);
  });

  it('computes the per-stage return rate, and refuses it for a stage nobody entered', () => {
    const response = fold({
      stageReturns: [
        { stage: 'code_review', entries: 4, returns: 1, rate: null },
        { stage: 'ci_gate', entries: 0, returns: 0, rate: null },
      ],
    });
    expect(response.returns_by_stage).toEqual([
      { stage: 'code_review', entries: 4, returns: 1, rate: 0.25 },
      { stage: 'ci_gate', entries: 0, returns: 0, rate: null },
    ]);
  });

  it('publishes a document the contract accepts', () => {
    // The route re-validates on the way out, so a shape this fold can produce and the schema
    // refuses is a 500 on a real instance (standing rule 1's shape at a serialiser).
    expect(() =>
      orgStatsResponseSchema.parse(
        fold({
          deliveredTasks: [delivered({ cycleHours: 1 / 3 })],
          cost: [{ day: '2026-06-03', usd: 1 / 7, inputTokens: 3, cacheReadTokens: 1 }],
        }),
      ),
    ).not.toThrow();
  });

  it('clamps a negative wall clock to zero rather than answering 500', () => {
    // A `nonnegative()` schema turns a clock that went backwards between two of the platform's own
    // writes into a serialisation failure; the honest answer to a −0.0001 h cycle time is zero.
    const response = fold({ deliveredTasks: [delivered({ cycleHours: -0.5 })] });
    expect(metric(response, 'cycle_time_hours').value).toBe(0);
  });
});

describe('the calendar', () => {
  it('ends the range on today and reaches back the range’s own length', () => {
    for (const [range, days] of Object.entries(RANGE_DAYS)) {
      const resolved = resolveRange(range as keyof typeof RANGE_DAYS, 'day', '2026-06-07');
      expect(resolved.to).toBe('2026-06-07');
      expect(bucketsOf(resolved)).toHaveLength(days);
    }
  });

  it('starts a week on Monday and a month on the first', () => {
    // 2026-06-07 is a Sunday, so its ISO week began on the 1st.
    expect(bucketStartOf('2026-06-07', 'week')).toBe('2026-06-01');
    expect(bucketStartOf('2026-06-08', 'week')).toBe('2026-06-08');
    expect(bucketStartOf('2026-06-07', 'month')).toBe('2026-06-01');
  });

  it('tiles the range with half-open buckets that leave no gap', () => {
    const buckets = bucketsOf(resolveRange('30d', 'week', '2026-06-07'));
    for (const [index, bucket] of buckets.entries()) {
      expect(bucket.end > bucket.start, bucket.start).toBe(true);
      const next = buckets[index + 1];
      if (next !== undefined) {
        expect(next.start).toBe(bucket.end);
      }
    }
  });

  it('folds a day into the bucket that contains it', () => {
    const response = fold({ deliveredTasks: [delivered({ mergedDay: '2026-06-03' })] }, 'month');
    expect(metric(response, 'tasks_delivered').buckets.map((b) => b.start)).toEqual(['2026-06-01']);
    expect(metric(response, 'tasks_delivered').buckets[0]?.end).toBe('2026-07-01');
  });
});

describe('the CSV', () => {
  const csv = () =>
    statsToCsv(
      fold({
        deliveredTasks: [delivered()],
        stageReturns: [{ stage: 'code_review', entries: 4, returns: 1, rate: null }],
      }),
    );

  it('is long, with a total row and a bucket row per metric', () => {
    const lines = csv().trimEnd().split('\n');
    expect(lines[0]).toBe(STATS_CSV_HEADER.join(','));
    const totals = lines.filter((line) => line.includes(',total,'));
    // One per metric plus one per stage — and *no* rows at all for an absent metric, which is what
    // keeps a spreadsheet from summing a cell the platform never measured.
    expect(totals.length).toBe(STATS_METRIC_IDS.length + 1);
    expect(lines.filter((line) => line.startsWith('loc_changed,'))).toHaveLength(1);
    expect(lines.filter((line) => line.startsWith('tasks_delivered,'))).toHaveLength(8);
  });

  it('quotes a definition that contains a comma, and leaves an absent value empty', () => {
    const lines = csv().split('\n');
    const absentRow = lines.find((line) => line.startsWith('defect_escape,'));
    expect(absentRow).toBeDefined();
    // The value column is empty — never `0` — and the reason is in the row beside it.
    expect(absentRow).toContain(',,');
    expect(absentRow).toContain('Unowned');
    expect(csv()).toContain('"');
  });

  it('ends with a newline', () => {
    expect(csv().endsWith('\n')).toBe(true);
  });
});

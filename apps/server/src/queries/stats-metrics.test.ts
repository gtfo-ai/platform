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
  kbUsage: [],
  stageReturns: [],
  withheldReviewMinutes: { minutes: 0, entries: 0 },
  overlaps: [],
  loc: [],
  lintEdits: [],
  bugTraces: [],
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
    // `defect_escape` is absent here because this fold traced no bug ticket — a **dynamic**
    // absence (Q87), asserted on its own below; the other five are absent in every build.
    expect(absent.map((entry) => entry.id)).toEqual([
      'shadow_similarity',
      'clean_first_mr_rate_by_author',
      'readiness_attributed_returns',
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

  /**
   * **`kb_usage` is computed, and its denominator is in its own definition** (WP-57, criterion 6;
   * PROGRESS backlog 112). A "runs that searched the knowledge base" number must never ship under
   * this name, so the definition is asserted to name the subset and the citation, and *not* to be
   * about searching.
   */
  it('computes knowledge usage over the subset of runs its definition names', () => {
    const response = fold({
      kbUsage: [
        { day: '2026-06-02', eligible: 3, cited: 2 },
        { day: '2026-06-05', eligible: 1, cited: 0 },
      ],
    });
    const usage = metric(response, 'kb_usage');
    expect(usage.absent).toBeNull();
    // Summed numerator over summed denominator, never the mean of the buckets' ratios.
    expect(usage.value).toBe(0.5);
    expect(usage.samples).toBe(4);
    expect(usage.buckets.find((bucket) => bucket.start === '2026-06-02')?.value).toBeCloseTo(2 / 3);
    // A day with no eligible run has no ratio — `null`, never `0` (standing rule 16).
    expect(usage.buckets.find((bucket) => bucket.start === '2026-06-03')?.value).toBeNull();
    expect(usage.definition).toContain('RefinedSpec');
    expect(usage.definition).toContain('ResearchReport');
    expect(usage.definition).toContain('denominator');
    expect(usage.definition).toContain('tier-1');
    expect(usage.definition).not.toMatch(/searched|kb_search/);
    expect(usage.caveats.join(' ')).toContain('kb_search');

    // No eligible run anywhere in the range: the metric is computed and has no value, which is a
    // different statement from the absence it used to publish.
    const quiet = metric(fold(), 'kb_usage');
    expect(quiet.absent).toBeNull();
    expect(quiet.value).toBeNull();
    expect(quiet.samples).toBe(0);
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
    expect(caveats).toContain('backlog 188');
    expect(caveats).toContain('backlog 89');
    expect(caveats).toContain('do not cancel');
  });

  /**
   * WP-61: the reviewer figures' **definitions** say what the caveats warn about — the per-task cap
   * (criterion 3, backlog 89) and the check approval-derived minutes wait on (backlog 188), named
   * in the metric's own definition rather than only in a caveat.
   */
  it('defines the day cap as per task and names the check approval minutes wait on', () => {
    for (const id of ['reviewer_minutes_per_delivered_task', 'human_minutes'] as const) {
      const entry = metric(fold(), id);
      expect(entry.definition, id).toContain('docs/TODO.md');
      expect(entry.definition, id).toContain('`approved`');
      expect(entry.definition, id).toContain('machine');
    }
    expect(metric(fold(), 'reviewer_minutes_per_delivered_task').definition).toContain(
      'per calendar day **per review window**',
    );
    expect(metric(fold(), 'reviewer_minutes_per_delivered_task').caveats.join(' ')).toContain(
      'more than 8 h',
    );
  });

  it('states the withheld approval windows as a count when there are any, and says nothing when there are none', () => {
    const withheld = fold({ withheldReviewMinutes: { minutes: 95.5, entries: 3 } });
    for (const id of ['reviewer_minutes_per_delivered_task', 'human_minutes'] as const) {
      expect(metric(withheld, id).caveats.join(' '), id).toContain(
        '3 review windows an approval touched, 95.5 minutes',
      );
    }
    expect(metric(fold(), 'human_minutes').caveats.join(' ')).not.toContain('Withheld in');
  });

  it('no longer claims approving is invisible to first-pass acceptance', () => {
    // Rule 83: the caveat said "approving produces no event on this build" from WP-41 until WP-61;
    // `mr.approved` exists since WP-60 and opens a review window, so the sentence was false.
    const caveats = metric(fold(), 'first_pass_acceptance').caveats.join(' ');
    expect(caveats).not.toContain('produces no event');
    expect(caveats).toContain('approved without commenting');
    expect(caveats).toContain('not** first-pass');
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
        // Counts comparisons; the metric counts distinct overlaps from `overlaps` (backlog 180).
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
    expect(metric(response, 'concurrent_task_overlaps').value).toBe(0);
    expect(metric(response, 'ticket_lint_comments').value).toBe(6);
  });

  it('counts concurrent-task overlaps from the distinct overlaps, not from the comparisons', () => {
    const response = fold({
      counters: [{ day: '2026-06-02', metric: 'conflict.warned', count: 10, total: 30 }],
      overlaps: [
        { day: '2026-06-02', count: 1 },
        { day: '2026-06-04', count: 2 },
      ],
    });
    expect(metric(response, 'concurrent_task_overlaps').value).toBe(3);
    expect(metric(response, 'concurrent_task_overlaps').definition).toContain('Distinct overlaps');
  });

  it('folds lines changed per merged merge request, and never an unmeasured merge as zero lines', () => {
    const response = fold({
      loc: [
        { day: '2026-06-02', measured: 2, lines: 150, unmeasured: 0 },
        { day: '2026-06-03', measured: 0, lines: 0, unmeasured: 3 },
      ],
    });
    const loc = metric(response, 'loc_changed');
    expect(loc.absent).toBeNull();
    // 150 lines over 2 measured merges — the three unmeasured ones are in neither side; folding
    // them as zeros would have published 30.
    expect(loc.value).toBe(75);
    expect(loc.samples).toBe(2);
    expect(loc.buckets.find((bucket) => bucket.start === '2026-06-03')?.value).toBeNull();
    expect(loc.caveats.join(' ')).toContain('3 merged merge requests in the period had no counts');
    // Nothing measured at all: no value, and no invented zero.
    expect(metric(fold(), 'loc_changed').value).toBeNull();
  });

  it('folds tickets improved after lint over the lints whose window has closed', () => {
    const response = fold({
      lintEdits: [
        { day: '2026-06-02', linted: 3, improved: 1 },
        { day: '2026-06-03', linted: 1, improved: 1 },
      ],
    });
    const edited = metric(response, 'tickets_edited_after_lint');
    expect(edited.absent).toBeNull();
    expect(edited.value).toBe(0.5);
    expect(edited.samples).toBe(4);
    expect(edited.definition).toContain('48 h');
    expect(edited.caveats.join(' ')).toContain('platform’s own status transitions');
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
    expect(lines.filter((line) => line.startsWith('queue_wait_minutes,'))).toHaveLength(1);
    expect(lines.filter((line) => line.startsWith('tasks_delivered,'))).toHaveLength(8);
  });

  it('quotes a definition that contains a comma, and leaves an absent value empty', () => {
    const lines = csv().split('\n');
    const absentRow = lines.find((line) => line.startsWith('defect_escape,'));
    expect(absentRow).toBeDefined();
    // The value column is empty — never `0` — and the reason is in the row beside it.
    expect(absentRow).toContain(',,');
    expect(absentRow).toContain('Q87');
    expect(csv()).toContain('"');
  });

  it('ends with a newline', () => {
    expect(csv().endsWith('\n')).toBe(true);
  });
});

/**
 * Q87's rule (WP-61 criteria 4 and 5, PROGRESS backlog 114): the defect-escape rate is published
 * only with its coverage, and below the derived ½ floor it is absent with the coverage as the
 * reason.
 */
describe('defect escape', () => {
  const traced = (bugs: number, linked: number, escaped: number, day = '2026-06-04') => ({
    day,
    bugs,
    linked,
    escaped,
  });

  it('is absent, naming the coverage, when fewer than half the bug tickets could be attributed', () => {
    const response = fold({
      deliveredTasks: [delivered(), delivered()],
      bugTraces: [traced(10, 4, 1)],
    });
    const defect = metric(response, 'defect_escape');
    expect(defect.value).toBeNull();
    expect(defect.buckets).toEqual([]);
    expect(defect.absent?.reason).toContain('4 of 10 bug tickets');
    expect(defect.absent?.reason).toContain('40 %');
    expect(defect.absent?.reason).toContain('Coverage below the floor');
  });

  it('is published at exactly half, with the coverage as a caveat and the lower-bound warning', () => {
    const response = fold({
      deliveredTasks: [delivered(), delivered(), delivered(), delivered()],
      bugTraces: [traced(2, 1, 1, '2026-06-02'), traced(2, 1, 0, '2026-06-05')],
    });
    const defect = metric(response, 'defect_escape');
    expect(defect.absent).toBeNull();
    // One escape over four deliveries: the numerator counted at filing, the denominator at merge.
    expect(defect.value).toBe(0.25);
    expect(defect.samples).toBe(4);
    const caveats = defect.caveats.join(' ');
    expect(caveats).toContain('2 of 4 bug tickets');
    expect(caveats).toContain('50 %');
    expect(caveats).toContain('lower bound');
  });

  it('is absent when no bug ticket was traced — "none filed" and "none seen" look the same', () => {
    const defect = metric(fold({ deliveredTasks: [delivered()] }), 'defect_escape');
    expect(defect.value).toBeNull();
    expect(defect.absent?.reason).toContain('No bug ticket was traced');
  });

  it('defines itself by the ticket’s own link and never by timing or title', () => {
    const { definition } = metric(fold(), 'defect_escape');
    expect(definition).toContain('link on the bug ticket');
    expect(definition).toContain('never by its title, never by timing');
  });
});

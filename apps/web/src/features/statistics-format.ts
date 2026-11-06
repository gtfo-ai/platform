/**
 * What the statistics screen prints for a number, a sample count and a trend — kept apart from the
 * screen so each rule is asserted on its own (`statistics-format.test.ts`).
 *
 * `null` is **never** printed as a number: a ratio with nothing to divide and a count of zero are
 * different facts (standing rule 16), so {@link formatStatValue} answers `null` and the card draws a
 * muted dash with *"No data in this range"* under it.
 */
import type { StatBucket, StatBucketSize, StatMetricId, StatUnit } from '@platform/contracts';
import { formatInteger, formatMinutes, formatUsd } from '../ui/kit.js';

const ONE_DECIMAL = new Intl.NumberFormat('en', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/**
 * One value in its own unit, or `null` when there is none to print.
 *
 * `decimal` is an average count — *8.0* returns per delivered task — and is never multiplied by
 * 100: that multiplication is what made eight returns read *800.0 %* before S-23.19 gave the
 * contract the unit.
 */
export const formatStatValue = (value: number | null, unit: StatUnit): string | null => {
  if (value === null) {
    return null;
  }
  switch (unit) {
    case 'count':
      return formatInteger(value);
    case 'decimal':
      return ONE_DECIMAL.format(value);
    case 'usd':
      return formatUsd(value);
    case 'minutes':
      return formatMinutes(value);
    case 'hours':
      return `${ONE_DECIMAL.format(value)} h`;
    case 'ratio':
      return `${ONE_DECIMAL.format(value * 100)}%`;
  }
};

/**
 * Which way a metric is good (research/21 S11, F15): *"Returns per delivered task 8.0"* with no
 * sense of good or bad was the finding. A `Record` over the contract's enum, as `ui/humanize.ts`'s
 * vocabularies are, so a metric added to the contract fails the typecheck here rather than reaching
 * the screen with no reading. `null` is a volume — how much happened — which is neither: more tasks
 * started or more money spent is not, on its own, better or worse. The read carries no previous
 * period, so the card says the direction and never a comparison it cannot make.
 */
export const STAT_READING: Readonly<Record<StatMetricId, 'higher' | 'lower' | null>> = {
  tasks_started: null,
  tasks_delivered: 'higher',
  merge_rate: 'higher',
  first_pass_acceptance: 'higher',
  clean_first_mr_rate: 'higher',
  human_intervention_rate: 'lower',
  returns_per_delivered_task: 'lower',
  cycle_time_hours: 'lower',
  agent_time_hours: null,
  cost_total: null,
  cost_per_delivered_task: 'lower',
  // The part the platform had to price itself: lower means more of the spend was reported.
  estimated_spend_share: 'lower',
  // An error (|estimate − actual| ÷ actual), whatever the id says.
  estimate_accuracy: 'lower',
  cache_hit_ratio: 'higher',
  question_response_minutes: 'lower',
  reviewer_minutes_per_delivered_task: 'lower',
  human_minutes: 'lower',
  kb_proposal_acceptance: 'higher',
  kb_usage: 'higher',
  rebase_conflicts_resolved: 'higher',
  rebase_conflicts_escalated: 'lower',
  concurrent_task_overlaps: 'lower',
  review_findings_accepted: 'higher',
  review_findings_dismissed: 'lower',
  ticket_lint_comments: null,
  tickets_edited_after_lint: 'higher',
  shadow_similarity: 'higher',
  clean_first_mr_rate_by_author: 'higher',
  readiness_attributed_returns: 'lower',
  loc_changed: null,
  defect_escape: 'lower',
  queue_wait_minutes: 'lower',
  total_cost_of_delivery: 'lower',
};

/** The card's reading line: *"Higher is better"*, *"Lower is better"*, or that it is a volume. */
export const statReadingWords = (id: StatMetricId): string => {
  const reading = STAT_READING[id];
  return reading === 'higher'
    ? 'Higher is better'
    : reading === 'lower'
      ? 'Lower is better'
      : 'A volume, not a score';
};

/**
 * What a metric's `samples` count, where the fold makes it a known thing (`foldStats` in
 * `apps/server/src/queries/stats-metrics.ts`: each `add` is one sample unless it says otherwise).
 * A metric this table does not name is said as *"N data points"* — never *"observations"*, which
 * research/21 § 4 found nobody reads.
 */
const SAMPLE_NOUN: Partial<Record<StatMetricId, readonly [string, string]>> = {
  // One sample per task started in the range.
  tasks_started: ['task', 'tasks'],
  merge_rate: ['task', 'tasks'],
  human_intervention_rate: ['task', 'tasks'],
  // One sample per task delivered (merged) in the range.
  tasks_delivered: ['delivered task', 'delivered tasks'],
  first_pass_acceptance: ['delivered task', 'delivered tasks'],
  clean_first_mr_rate: ['delivered task', 'delivered tasks'],
  returns_per_delivered_task: ['delivered task', 'delivered tasks'],
  cycle_time_hours: ['delivered task', 'delivered tasks'],
  agent_time_hours: ['delivered task', 'delivered tasks'],
  cost_per_delivered_task: ['delivered task', 'delivered tasks'],
  reviewer_minutes_per_delivered_task: ['delivered task', 'delivered tasks'],
  defect_escape: ['delivered task', 'delivered tasks'],
  estimate_accuracy: ['delivered task', 'delivered tasks'],
  // One per answered question, per decided proposal, per eligible run, per linted ticket.
  question_response_minutes: ['answered question', 'answered questions'],
  kb_proposal_acceptance: ['decided proposal', 'decided proposals'],
  kb_usage: ['run', 'runs'],
  tickets_edited_after_lint: ['linted ticket', 'linted tickets'],
  loc_changed: ['measured merge request', 'measured merge requests'],
  // The cost rollup is one row per day with spend.
  cost_total: ['day with spend', 'days with spend'],
  cache_hit_ratio: ['day with spend', 'days with spend'],
  estimated_spend_share: ['day with spend', 'days with spend'],
};

/** *"From 12 delivered tasks"*, *"From 1 task"*, or the sentence for none. */
export const formatSamples = (id: StatMetricId, samples: number): string => {
  if (samples === 0) {
    return 'Nothing measured in this range';
  }
  const [one, many] = SAMPLE_NOUN[id] ?? ['data point', 'data points'];
  return `From ${formatInteger(samples)} ${samples === 1 ? one : many}`;
};

const CIVIL_DATE = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' });

/**
 * A civil date (`2026-09-10`) the way every other screen writes a date — *"Sep 10, 2026"* — read
 * at UTC midnight and formatted in UTC, so the reader's own zone never moves it a day. A value
 * that is not a date is shown as it came.
 */
export const formatCivilDate = (day: string): string => {
  const at = new Date(`${day}T00:00:00.000Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(at.getTime())
    ? CIVIL_DATE.format(at)
    : day;
};

/**
 * The screen's sections, in reading order, and the metrics each holds.
 *
 * The first four are the owner's grouping (S-23.19); the last two hold the rest of the catalogue so
 * nothing the server measures is dropped. A metric this table does not name lands in *Other*, so a
 * metric added to the contract is shown before anybody files it here.
 */
export const STAT_SECTIONS: readonly {
  readonly title: string;
  readonly metrics: readonly StatMetricId[];
}[] = [
  {
    title: 'Throughput',
    metrics: ['tasks_started', 'tasks_delivered', 'merge_rate', 'cycle_time_hours'],
  },
  {
    title: 'Quality',
    metrics: [
      'first_pass_acceptance',
      'clean_first_mr_rate',
      'human_intervention_rate',
      'returns_per_delivered_task',
    ],
  },
  {
    title: 'Cost',
    metrics: [
      'cost_total',
      'cost_per_delivered_task',
      'estimated_spend_share',
      'estimate_accuracy',
      'cache_hit_ratio',
    ],
  },
  {
    title: 'Time',
    metrics: [
      'agent_time_hours',
      'question_response_minutes',
      'reviewer_minutes_per_delivered_task',
      'human_minutes',
    ],
  },
  { title: 'Knowledge', metrics: ['kb_proposal_acceptance', 'kb_usage'] },
  {
    title: 'Merge requests and tickets',
    metrics: [
      'loc_changed',
      'defect_escape',
      'rebase_conflicts_resolved',
      'rebase_conflicts_escalated',
      'concurrent_task_overlaps',
      'review_findings_accepted',
      'review_findings_dismissed',
      'ticket_lint_comments',
      'tickets_edited_after_lint',
    ],
  },
];

/** Groups metrics into {@link STAT_SECTIONS}' order; empty sections are left out. */
export const groupIntoSections = <Metric extends { readonly id: StatMetricId }>(
  metrics: readonly Metric[],
): readonly { readonly title: string; readonly metrics: readonly Metric[] }[] => {
  const named = new Set<StatMetricId>(STAT_SECTIONS.flatMap((section) => section.metrics));
  const byId = new Map(metrics.map((metric) => [metric.id, metric]));
  const sections = STAT_SECTIONS.map((section) => ({
    title: section.title,
    metrics: section.metrics.flatMap((id) => {
      const metric = byId.get(id);
      return metric === undefined ? [] : [metric];
    }),
  }));
  sections.push({ title: 'Other', metrics: metrics.filter((metric) => !named.has(metric.id)) });
  return sections.filter((section) => section.metrics.length > 0);
};

const BUCKET_WORD: Readonly<Record<StatBucketSize, readonly [string, string]>> = {
  day: ['day', 'days'],
  week: ['week', 'weeks'],
  month: ['month', 'months'],
};

/** The width and height of a sparkline's `viewBox`; the SVG scales to its box. */
export const SPARK_WIDTH = 100;
export const SPARK_HEIGHT = 24;
const SPARK_PAD = 2;

/**
 * A metric's buckets as polyline point lists — one list per run of buckets that have a value, so a
 * bucket with nothing to divide is a **gap** in the line rather than a drop to zero (rule 16).
 *
 * `null` when fewer than two buckets carry a value: a single point is not a trend.
 */
export const sparklineSegments = (buckets: readonly StatBucket[]): readonly string[] | null => {
  const values = buckets.flatMap((bucket) => (bucket.value === null ? [] : [bucket.value]));
  if (values.length < 2) {
    return null;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const step = buckets.length === 1 ? 0 : SPARK_WIDTH / (buckets.length - 1);
  const y = (value: number): number =>
    max === min
      ? SPARK_HEIGHT / 2
      : SPARK_HEIGHT - SPARK_PAD - ((value - min) / (max - min)) * (SPARK_HEIGHT - 2 * SPARK_PAD);
  const round = (n: number): string => String(Math.round(n * 100) / 100);
  const segments: string[] = [];
  let current: string[] = [];
  buckets.forEach((bucket, index) => {
    if (bucket.value === null) {
      if (current.length > 0) {
        segments.push(current.join(' '));
      }
      current = [];
      return;
    }
    current.push(`${round(index * step)},${round(y(bucket.value))}`);
  });
  if (current.length > 0) {
    segments.push(current.join(' '));
  }
  return segments;
};

/**
 * The sparkline in words, for a screen reader: how many buckets had a value, the lowest, the
 * highest and the latest. `null` exactly when {@link sparklineSegments} draws nothing.
 */
export const trendSummary = (
  buckets: readonly StatBucket[],
  unit: StatUnit,
  bucket: StatBucketSize,
): string | null => {
  const values = buckets.flatMap((entry) => (entry.value === null ? [] : [entry.value]));
  if (values.length < 2) {
    return null;
  }
  const [one, many] = BUCKET_WORD[bucket];
  const latest = values[values.length - 1] ?? 0;
  const format = (value: number): string => formatStatValue(value, unit) ?? '';
  return `Trend by ${one}: ${values.length} of ${buckets.length} ${buckets.length === 1 ? one : many} with data; lowest ${format(Math.min(...values))}, highest ${format(Math.max(...values))}, latest ${format(latest)}.`;
};

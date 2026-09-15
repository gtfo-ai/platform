/**
 * What every statistic **means**, and the arithmetic that turns rows into one — the half of
 * `GET /api/org/stats` a database is not needed to reach (WP-41, product/16, product/19 §10).
 *
 * The split is `human-time-summary.ts`'s and for the same reason: `stats-queries.ts` reads rows and
 * this module folds them, so every definition, every cap, every ratio and every stated absence is
 * asserted in the unit tier against values a test wrote, while the integration tier asserts that
 * the SQL produces those rows from real ones.
 *
 * ## Three rules the catalogue below is written to
 *
 * **1. A number this build cannot compute is absent, never zero** (standing rule 16). An absent
 * metric publishes `value: null` with a reason and an owner; it is structurally impossible to
 * publish *"nobody counted"* as `0`, because the two are different fields. product/16 and
 * product/18:59-63 name more metrics than this build can measure, and the ones it cannot are
 * **listed** rather than omitted — a screen that silently dropped them would read as complete.
 *
 * **2. Every number carries its definition** (product/10:63). The definition is part of the DTO
 * rather than a string in the SPA, so the tooltip cannot drift from the arithmetic — and a CSV
 * export carries it too.
 *
 * **3. A number whose error direction is known says so.** `caveats` is not decoration: reviewer
 * minutes over-count by every robot that comments (PROGRESS backlog **88**), under-count by every
 * reviewer who approves without commenting (backlog **90**), and rest on a cap the projector
 * applies per entry (backlog **89**, whose read-side half is applied here). The two errors run in
 * opposite directions and **do not cancel**, so publishing the figure silently would be publishing
 * a precision the platform does not have.
 *
 * ## What is deliberately not here
 *
 * No metric groups by `runs.mode`. PROGRESS backlog **57** — four of technical/04's run modes were
 * recorded as `normal` — was paid at WP-36, so such a breakdown is *possible* now; it is still not
 * published, because nothing on product/10's statistics screen asks for one and a breakdown nobody
 * reads is a number nobody would notice going wrong. The task-level filter this module *does* apply
 * is `tasks.mode` and the task's **template**, which is a different column and a different question
 * (`deliversMergeRequest` says what it asks).
 */
import type {
  IsoDateTime,
  OrgStatsResponse,
  StatAbsence,
  StatBucketSize,
  StatMetric,
  StatMetricId,
  StatRange,
  StatStageReturn,
  StatUnit,
} from '@platform/contracts';

// ── The calendar ─────────────────────────────────────────────────────────────

/**
 * How many civil days each range covers, inclusive of today.
 *
 * `365d` rather than `1y` because the buckets are days and a year is not a whole number of them;
 * the label a screen prints is the screen's business.
 */
export const RANGE_DAYS: Readonly<Record<StatRange, number>> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  '365d': 365,
};

export const DEFAULT_RANGE: StatRange = '30d';
export const DEFAULT_BUCKET: StatBucketSize = 'day';

/**
 * A civil date as a UTC instant — the *only* arithmetic this module does on dates.
 *
 * The days arrive already cut in the organisation's zone (`rollupDay`, Q12), so they are civil
 * dates with no offset left in them and their arithmetic is plain: a week is seven of them whatever
 * the zone did that Sunday. Doing it in UTC is therefore not an approximation, it is what a civil
 * date *is* — and it is why nothing below takes a timezone argument.
 */
const civilMs = (day: string): number => Date.parse(`${day}T00:00:00.000Z`);

const civilDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const DAY_MS = 24 * 60 * 60 * 1000;

export const addDays = (day: string, days: number): string =>
  civilDay(civilMs(day) + days * DAY_MS);

/** ISO weekday of a civil date, 1 = Monday — the week the working calendar and BD-010 use. */
const isoWeekday = (day: string): number => ((new Date(civilMs(day)).getUTCDay() + 6) % 7) + 1;

/** The first civil day of the bucket a day belongs to. */
export const bucketStartOf = (day: string, bucket: StatBucketSize): string => {
  switch (bucket) {
    case 'day':
      return day;
    case 'week':
      return addDays(day, -(isoWeekday(day) - 1));
    case 'month':
      return `${day.slice(0, 7)}-01`;
  }
};

/** The first civil day of the bucket after this one — the exclusive end the DTO publishes. */
const bucketEndOf = (start: string, bucket: StatBucketSize): string => {
  switch (bucket) {
    case 'day':
      return addDays(start, 1);
    case 'week':
      return addDays(start, 7);
    case 'month': {
      const year = Number(start.slice(0, 4));
      const month = Number(start.slice(5, 7));
      return month === 12
        ? `${year + 1}-01-01`
        : `${year}-${String(month + 1).padStart(2, '0')}-01`;
    }
  }
};

export interface ResolvedRange {
  readonly range: StatRange;
  readonly bucket: StatBucketSize;
  /** Inclusive first civil day. */
  readonly from: string;
  /** Inclusive last civil day — today in the organisation's zone. */
  readonly to: string;
}

/**
 * The range a query asks for, against today in the organisation's zone.
 *
 * `from` is **not** snapped back to a bucket boundary: a 30-day range asked for on a Wednesday ends
 * on that Wednesday, and its first week bucket is a partial one. Snapping would answer a different
 * question from the one the caller asked (*"the last 30 days"*) and would make two adjacent ranges
 * overlap; the bucket's own `start`/`end` say what it spans, so a partial bucket is visible rather
 * than implied.
 */
export const resolveRange = (
  range: StatRange,
  bucket: StatBucketSize,
  today: string,
): ResolvedRange => ({
  range,
  bucket,
  from: addDays(today, -(RANGE_DAYS[range] - 1)),
  to: today,
});

/** Every bucket of the range, in order, each `[start, end)`. */
export const bucketsOf = (
  resolved: ResolvedRange,
): readonly { readonly start: string; readonly end: string }[] => {
  const buckets: { start: string; end: string }[] = [];
  let cursor = bucketStartOf(resolved.from, resolved.bucket);
  const last = bucketStartOf(resolved.to, resolved.bucket);
  for (let guard = 0; guard < 400; guard += 1) {
    const end = bucketEndOf(cursor, resolved.bucket);
    buckets.push({ start: cursor, end });
    if (cursor === last) {
      return buckets;
    }
    cursor = end;
  }
  // Unreachable for every member of `RANGE_DAYS` (365 days is at most 365 buckets); a bound rather
  // than a `while` so a future range cannot turn a read into an infinite loop.
  return buckets;
};

// ── The rows this fold is made of ────────────────────────────────────────────

/** One task that was **started** in the range, with what a human had to do about it. */
export interface StartedTaskRow {
  /** The civil day `tasks.created_at` falls in, in the organisation's zone. */
  readonly startedDay: string;
  /**
   * product/19 §10's *"tasks with ≥ 1 of (question answered, approval, human return, needs_human)"*.
   */
  readonly intervened: boolean;
}

/** One task whose merge request merged in the range, and everything a metric asks of it. */
export interface DeliveredTaskRow {
  readonly mergedDay: string;
  /** Wall clock from `tasks.created_at` to the merge, in hours, never negative. */
  readonly cycleHours: number;
  /** Summed run wall time of the task, in hours — product/19 §10's *"agent time"*. */
  readonly agentHours: number;
  /** `task_stages` rows that ended `returned`. */
  readonly returns: number;
  /** Human review entries on the task (`human_time_entries.kind = 'review'`). */
  readonly humanReviewEntries: number;
  /** Questions the task asked, of any status. */
  readonly questions: number;
  /** The task's ledger spend. */
  readonly costUsd: number;
  /** `tasks.estimate_usd`, or `null` when the estimator never ran on it. */
  readonly estimateUsd: number | null;
  /** `tasks.cost_actual` — the denominator of product/19:99's accuracy. */
  readonly costActual: number;
}

export interface CounterRow {
  readonly day: string;
  readonly metric: string;
  readonly count: number;
  readonly total: number;
}

export interface CostDayRow {
  readonly day: string;
  readonly usd: number;
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
}

export interface EstimatedSpendRow {
  readonly day: string;
  readonly usd: number;
  /** The part of it priced from `price_list` rather than reported (BD-011, backlog **75**). */
  readonly estimatedUsd: number;
}

export interface QuestionRow {
  readonly answeredDay: string;
  readonly minutes: number;
}

/** Human minutes, already bucketed per `(identity, civil day)` — see {@link REVIEWER_DAY_CAP}. */
export interface HumanMinutesRow {
  readonly day: string;
  readonly kind: string;
  readonly minutes: number;
}

export interface KbProposalRow {
  readonly day: string;
  readonly applied: number;
  readonly rejected: number;
}

export interface StatsSources {
  readonly startedTasks: readonly StartedTaskRow[];
  readonly deliveredTasks: readonly DeliveredTaskRow[];
  readonly counters: readonly CounterRow[];
  readonly cost: readonly CostDayRow[];
  readonly estimatedSpend: readonly EstimatedSpendRow[];
  readonly questions: readonly QuestionRow[];
  readonly humanMinutes: readonly HumanMinutesRow[];
  readonly kbProposals: readonly KbProposalRow[];
  readonly stageReturns: readonly StatStageReturn[];
}

// ── The catalogue ────────────────────────────────────────────────────────────

/**
 * How a metric's buckets add up to its total.
 *
 * `sum` adds the numerators; `ratio` divides the summed numerator by the summed denominator (never
 * the mean of the buckets' ratios, which weights a quiet Sunday like a busy Monday); `mean` divides
 * the summed numerator by the number of observations.
 */
type Aggregation = 'sum' | 'ratio' | 'mean';

interface MetricDefinition {
  readonly label: string;
  readonly definition: string;
  readonly unit: StatUnit;
  readonly aggregation: Aggregation;
  readonly caveats?: readonly string[];
  /** Present exactly when this build cannot compute the metric at all. */
  readonly absent?: StatAbsence;
}

/**
 * product/19 §16's cap, applied here **a second time** — across tasks, per person, per civil day.
 *
 * PROGRESS backlog **89**: the projector applies the eight-hour cap *per entry*, which is right at
 * fold time (it is stateless, order-independent and therefore replayable) and is not what the
 * document's *"capped at 8 h per calendar day"* means once a figure sums across tasks. One person
 * reviewing three tasks on one day could otherwise be credited a day and a half. So the read caps
 * again, on the bucket key the projector cannot use — `(user_id or external_author, civil day)` —
 * and the metric says so in its own caveat rather than in a comment only this file's reader sees.
 */
export const REVIEWER_DAY_CAP_MINUTES = 8 * 60;

const REVIEWER_CAVEATS = [
  'Over-counts: a bot that is not this platform — CI, a dependency updater — opens and extends a review window like a person, because nothing records which provider accounts are robots (PROGRESS backlog 88).',
  'Under-counts: approving without commenting contributes nothing, because the event catalogue has no `mr.approved` (PROGRESS backlog 90). The two errors run in opposite directions and do not cancel.',
  'Capped twice: the projector caps 8 h per calendar day per entry, and this figure caps again per person per day **per kind** across tasks (PROGRESS backlog 89) — so one person reviewing and steering on the same day can be credited up to 16 h, which is exact for reviewer minutes and a stated over-count for the combined figure.',
] as const;

/**
 * Every metric this endpoint publishes, in the order a screen reads them.
 *
 * The absent ones are **in this table**, not omitted from it: product/16 and product/18 name them,
 * so a reader has to be told they are not measured and by whom they would be.
 */
export const STATS_CATALOGUE: Readonly<Record<StatMetricId, MetricDefinition>> = {
  tasks_started: {
    label: 'Tasks started',
    definition:
      'Tasks created in the period on a template that delivers a merge request (feature, bug, chore), excluding shadow-mode tasks. A discovery, review-only, ticket-lint, history-bootstrap or epic-split task is not counted: it never opens a merge request, so counting it would make the merge rate below a statement about how much the platform was configured to do.',
    unit: 'count',
    aggregation: 'sum',
  },
  tasks_delivered: {
    label: 'Tasks delivered',
    definition:
      "Tasks whose merge request merged, counted at merge time (product/19 §10). The instant is the platform's own `mr.merged`, so a task still running its retrospective is already counted.",
    unit: 'count',
    aggregation: 'sum',
  },
  merge_rate: {
    label: 'Merge rate',
    definition:
      'Tasks delivered in the period ÷ tasks started in the period. The two are counted at different instants — a merge and a creation — so a period that starts mid-flight can exceed 1.',
    unit: 'ratio',
    aggregation: 'ratio',
  },
  first_pass_acceptance: {
    label: 'First-pass acceptance',
    definition:
      'Delivered tasks with zero stage returns and zero human merge-request comments ÷ delivered tasks (product/16). A human comment is one the platform did not write, recognised by the marker every platform comment carries.',
    unit: 'ratio',
    aggregation: 'ratio',
    caveats: [
      'A reviewer who approved without commenting counts as first-pass acceptance, because approving produces no event on this build (PROGRESS backlog 90).',
    ],
  },
  clean_first_mr_rate: {
    label: 'Clean first-MR rate',
    definition:
      'Delivered tasks with zero questions and zero returns ÷ delivered tasks (product/19 §10). The per-author breakdown product/16 asks for is a separate metric below, and it is absent.',
    unit: 'ratio',
    aggregation: 'ratio',
  },
  human_intervention_rate: {
    label: 'Human intervention rate',
    definition:
      'Tasks started in the period with at least one answered question, decided approval, human return or escalation to `needs_human` ÷ tasks started (product/19 §10).',
    unit: 'ratio',
    aggregation: 'ratio',
  },
  returns_per_delivered_task: {
    label: 'Returns per delivered task',
    definition:
      'Stage returns on delivered tasks ÷ delivered tasks. The per-stage breakdown product/19 §10 defines is published beside the metrics as `returns_by_stage`.',
    unit: 'ratio',
    aggregation: 'ratio',
  },
  cycle_time_hours: {
    label: 'Cycle time',
    definition:
      'Mean wall clock from a task being created to its merge request merging, in hours, over the tasks delivered in the period. It is a **mean**: product/19 §10 asks for the median and p90, which a daily rollup cannot hold — a distribution needs the rows, and this endpoint reads one row per delivered task only within the range it was asked for.',
    unit: 'hours',
    aggregation: 'mean',
  },
  agent_time_hours: {
    label: 'Agent time',
    definition:
      'Mean summed run wall time per delivered task, in hours (product/19 §10 “agent time”). A run that never started contributes nothing.',
    unit: 'hours',
    aggregation: 'mean',
  },
  cost_total: {
    label: 'Cost',
    definition:
      'Provider-reported spend over the period, from the cost ledger (BD-011). A run priced from the price list rather than invoiced is included and is also counted in “estimated share of spend”.',
    unit: 'usd',
    aggregation: 'sum',
  },
  cost_per_delivered_task: {
    label: 'Cost per delivered task',
    definition:
      'Ledger spend of the tasks delivered in the period ÷ those tasks (product/19 §10). It charges a task’s whole spend to the period it merged in, including runs from earlier periods — which is what “cost per merged task” means.',
    unit: 'usd',
    aggregation: 'ratio',
    caveats: [
      'Understates a task a human cancelled mid-run: a cancelled run’s spend reaches no ledger row (PROGRESS backlog 50).',
    ],
  },
  estimated_spend_share: {
    label: 'Estimated share of spend',
    definition:
      'Ledger spend the platform priced itself ÷ total ledger spend (`cost_entries.is_estimate`, BD-011). High means the provider reported no cost for most runs — a `local`-mode deployment, or a producer that stopped reporting — so the cost figures above are prices rather than invoices.',
    unit: 'ratio',
    aggregation: 'ratio',
  },
  estimate_accuracy: {
    label: 'Estimate accuracy',
    definition:
      'Mean of |estimate − actual| ÷ actual over the delivered tasks that carry a refinement estimate (product/19:99). 0 is perfect; 1 means the estimate was wrong by the size of the actual. Computed from `tasks.estimate_usd` and `tasks.cost_actual` and from nothing else. product/19 asks for the median by size; this is the mean over all sizes, for the reason cycle time gives.',
    unit: 'ratio',
    aggregation: 'mean',
  },
  cache_hit_ratio: {
    label: 'Cache hit ratio',
    definition:
      'Cache-read tokens ÷ input tokens over the period (product/16). It can exceed 1: a cached prompt is read without being sent again, so the two counters are not parts of one whole.',
    unit: 'ratio',
    aggregation: 'ratio',
  },
  question_response_minutes: {
    label: 'Question response time',
    definition:
      'Mean minutes from a question being asked to being answered, over the questions answered in the period (product/19 §10). Questions still open are not in it — a question nobody has answered has no response time, and counting it as the time so far would make the number fall when somebody finally answers.',
    unit: 'minutes',
    aggregation: 'mean',
  },
  reviewer_minutes_per_delivered_task: {
    label: 'Reviewer minutes per delivered task',
    definition:
      'Human review minutes recorded in the period ÷ tasks delivered in the period (product/16). A review window runs from the first human merge-request comment to the merge or last activity, excluding gaps over 2 h (product/19 §16).',
    unit: 'minutes',
    aggregation: 'ratio',
    caveats: REVIEWER_CAVEATS,
  },
  human_minutes: {
    label: 'Human minutes',
    definition:
      'All human minutes recorded in the period — review, question, approval and steer (product/19 §16). Published beside the cost figures and never added to them: no rate exists to convert one into the other (Q73).',
    unit: 'minutes',
    aggregation: 'sum',
    caveats: REVIEWER_CAVEATS,
  },
  kb_proposal_acceptance: {
    label: 'Knowledge proposal acceptance',
    definition:
      'Proposals applied ÷ proposals decided (applied + rejected) in the period (product/16). A proposal nobody has decided is in neither side.',
    unit: 'ratio',
    aggregation: 'ratio',
  },
  kb_usage: {
    label: 'Knowledge usage',
    definition:
      'product/16: “% runs whose context pack included a KB document that the agent cited”.',
    unit: 'ratio',
    aggregation: 'ratio',
    absent: {
      reason:
        'The numerator exists and nothing reads it; the denominator does not exist. A run’s citations are `kb_citations` on the RefinedSpec and ResearchReport artifacts, joined to the run by `artifacts.produced_by_run_id`, with no production reader; the runs whose pack *included* a document would be `run_context_pack`, and nothing has ever written a row to it.',
      owner:
        'PROGRESS backlog 112, owned by backlog 31 (the context-pack writer): once a pack is recorded, this is one join, not a new signal.',
    },
  },
  rebase_conflicts_resolved: {
    label: 'Conflicts resolved automatically',
    definition:
      'Rebase-gate settlements whose outcome was `resolved` — the branch did not apply and a conflict-resolution run made it apply (product/16, BD-030).',
    unit: 'count',
    aggregation: 'sum',
  },
  rebase_conflicts_escalated: {
    label: 'Conflicts escalated',
    definition:
      'Rebase-gate settlements whose outcome was `exhausted` — the bounded resolution loop was spent and the task went to a human (product/16, BD-030).',
    unit: 'count',
    aggregation: 'sum',
  },
  concurrent_task_overlaps: {
    label: 'Concurrent-task overlaps',
    definition:
      'Conflict warnings posted — one per ordered pair, so a pair where both tasks were compared counts twice and a pair where only one was counts once (product/16, PROGRESS backlog 65).',
    unit: 'count',
    aggregation: 'sum',
  },
  review_findings_accepted: {
    label: 'Review-only findings accepted',
    definition:
      'Finding threads a review-only review posted that were resolved on a merge request whose head moved afterwards — this build’s reading of “resolved with a change” (product/18:59).',
    unit: 'count',
    aggregation: 'sum',
  },
  review_findings_dismissed: {
    label: 'Review-only findings dismissed',
    definition:
      'Finding threads resolved without the merge request’s head moving (product/18:59). Threads still open are in neither figure.',
    unit: 'count',
    aggregation: 'sum',
  },
  ticket_lint_comments: {
    label: 'Ticket lint comments',
    definition:
      'Readiness-lint comments posted on tickets in the period (product/18:60). One per ticket, at most.',
    unit: 'count',
    aggregation: 'sum',
  },
  tickets_edited_after_lint: {
    label: 'Tickets improved after lint',
    definition: 'product/18:60: “tickets improved after lint (edited within 48 h)”.',
    unit: 'ratio',
    aggregation: 'ratio',
    absent: {
      reason:
        'Nothing tells this platform that a ticket changed. Jira’s `jira:issue_updated` is normalised into `ticket.matched` and `ticket.status.changed` only, so an edited description produces no event at all — the lint event carries the ticket’s `updated_at` as the linter saw it precisely so that whoever adds the signal has a baseline.',
      owner: 'PROGRESS backlog 59 — one normaliser change; no work package owns it.',
    },
  },
  shadow_similarity: {
    label: 'Shadow similarity',
    definition:
      'product/19 §13: how close a shadow run’s diff came to the human merge request it was compared with.',
    unit: 'ratio',
    aggregation: 'mean',
    absent: {
      reason:
        'Measured and published per **batch**, which is the unit the comparison is meaningful in: a similarity averaged over batches run against different repositories at different times answers no question anybody asked. The distribution, the cost-by-size table and the launch candidates are already served.',
      owner: 'Served by `GET /api/shadow-batches/:id` (WP-34) and rendered on the Shadow screen.',
    },
  },
  clean_first_mr_rate_by_author: {
    label: 'Clean first-MR rate by ticket author',
    definition:
      'product/16: “tasks reaching Ready with zero returns and zero human comments, grouped by ticket author”, visible to everyone in the project (Q22).',
    unit: 'ratio',
    aggregation: 'ratio',
    absent: {
      reason:
        'No ticket author exists to group by. `ticketRef` publishes provider, key and url and carries no author (Q48), and even with one, attributing it to a person needs a `user_identities` row an admin has stated. The ungrouped rate is published above.',
      owner: 'Q48 for the field, PROGRESS backlog 79 for the mapping.',
    },
  },
  readiness_attributed_returns: {
    label: 'Readiness-attributed returns',
    definition: 'product/19 §10: “returns tagged with a readiness criterion ÷ returns”.',
    unit: 'ratio',
    aggregation: 'ratio',
    absent: {
      reason:
        'No return carries a readiness criterion. `task_stages.return_reason` is prose written by an agent and names no criterion id, and readiness itself is evaluated **once**, at discovery, so an attribution over it would be a constant per project rather than a trend.',
      owner:
        'PROGRESS backlog 46 (readiness is never re-evaluated); the tagging has no owner and no producer.',
    },
  },
  loc_changed: {
    label: 'Lines changed per merged MR',
    definition:
      'product/16: “LOC added/removed/changed per merged MR and aggregated per day (from MR diff stats)”, shown for information rather than as a target.',
    unit: 'count',
    aggregation: 'sum',
    absent: {
      reason:
        'The one git provider this build ships publishes no insertion/deletion counts: every `mr.*` event GitLab produces carries `diff_stats: null` (its REST merge request has `changes_count`, a string like “5+”). The **fake** git provider does fill the field, which is exactly why this metric is named absent rather than computed — a number that is measured in every test and null in production is worse than one that is missing in both.',
      owner:
        'Unowned — filed as discovered work by WP-41. It needs a provider read per merge request, not a query.',
    },
  },
  defect_escape: {
    label: 'Defect escape',
    definition:
      'product/16: “bugs filed against agent-merged MRs within 30 days ÷ merged MRs”, tracked with no target.',
    unit: 'ratio',
    aggregation: 'ratio',
    absent: {
      reason:
        'Nothing links a later bug ticket to the merge request that caused it. The platform sees bug tickets it is given and merge requests it made, and no signal connects the two — inferring it from text would be a guess published as a defect rate.',
      owner: 'Unowned — filed as discovered work by WP-41.',
    },
  },
  queue_wait_minutes: {
    label: 'Queue wait',
    definition:
      'product/16: “agent utilisation: parallel runs vs limit; queue wait time” — how long a task waited between being queued and being picked up.',
    unit: 'minutes',
    aggregation: 'mean',
    absent: {
      reason:
        '`task.dequeued` is declared unconsumed and nothing projects it, so the closing instant of the wait is in the event log and in no row. Scanning the log per request is what a projection exists to avoid.',
      owner:
        'Nobody yet: `task.dequeued` is declared unconsumed naming WP-20, which shipped without a projection of it; a row that folds `task.queued`/`task.dequeued` into a wait per task owns this metric.',
    },
  },
  total_cost_of_delivery: {
    label: 'Total cost of delivery',
    definition:
      'product/09:29 and product/18:32: “total cost of delivery = tokens + people”, one number.',
    unit: 'usd',
    aggregation: 'sum',
    absent: {
      reason:
        'Adding dollars to minutes needs an hourly rate, and no product document, decision record or configuration key supplies one. A default would not be neutral — it varies by team, by country and by whether it means salary or loaded cost — and it would be published on every screen as though it had been measured. Cost and human minutes are both published above, unsummed, which is what product/09:29’s own wording (“shown next to”) says.',
      owner:
        'Q73 — answer “convert when set” and the organisation setting `human_hour_rate_usd` is one route field and one control; answer “do not convert” and this metric is never built.',
    },
  },
};

/** The catalogue's order is the DTO's order, and the screen's. */
export const STATS_METRIC_IDS = Object.keys(STATS_CATALOGUE) as readonly StatMetricId[];

// ── The fold ─────────────────────────────────────────────────────────────────

interface Point {
  numerator: number;
  denominator: number;
  samples: number;
}

type Series = Map<string, Point>;

const pointOf = (series: Series, bucket: string): Point => {
  const existing = series.get(bucket);
  if (existing !== undefined) {
    return existing;
  }
  const fresh = { numerator: 0, denominator: 0, samples: 0 };
  series.set(bucket, fresh);
  return fresh;
};

class Fold {
  private readonly series = new Map<StatMetricId, Series>();

  private readonly bucket: StatBucketSize;
  constructor(bucket: StatBucketSize) {
    this.bucket = bucket;
  }

  /** Adds one observation to a metric's bucket. */
  add(
    id: StatMetricId,
    day: string,
    values: { numerator: number; denominator?: number; samples?: number },
  ): void {
    const series = this.series.get(id) ?? new Map<string, Point>();
    this.series.set(id, series);
    const point = pointOf(series, bucketStartOf(day, this.bucket));
    point.numerator += values.numerator;
    point.denominator += values.denominator ?? 0;
    point.samples += values.samples ?? 1;
  }

  seriesFor(id: StatMetricId): Series | undefined {
    return this.series.get(id);
  }
}

const aggregated = (point: Point, aggregation: Aggregation): number | null => {
  switch (aggregation) {
    case 'sum':
      return point.numerator;
    case 'ratio':
      return point.denominator === 0 ? null : point.numerator / point.denominator;
    case 'mean':
      return point.samples === 0 ? null : point.numerator / point.samples;
  }
};

/**
 * Six significant figures, and a bound on what a `z.number().nonnegative()` may carry.
 *
 * A ratio of two floats prints as `0.6666666666666666` and lands in a CSV that way; rounding is
 * done **once**, here, so the JSON and the CSV cannot differ in the last digit. `Math.max(0, …)` is
 * the clamp the schema's `nonnegative()` would otherwise turn into a 500: the only way a negative
 * reaches this point is a clock that went backwards between two of the platform's own writes, and
 * answering a wall-clock difference of −0.0001 h as zero is what that means.
 */
const publishable = (value: number | null): number | null => {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  const clamped = Math.max(0, value);
  // An integer is published exactly: `toPrecision(6)` turns a count of 1 234 567 into 1 234 570,
  // which is a rounding rule quietly corrupting the one kind of number that is not a measurement
  // with a tolerance.
  return Number.isInteger(clamped) ? clamped : Number(clamped.toPrecision(6));
};

const metricOf = (
  id: StatMetricId,
  fold: Fold,
  buckets: readonly { readonly start: string; readonly end: string }[],
): StatMetric => {
  const entry = STATS_CATALOGUE[id];
  const base = {
    id,
    label: entry.label,
    definition: entry.definition,
    unit: entry.unit,
    caveats: [...(entry.caveats ?? [])],
  };
  if (entry.absent !== undefined) {
    // An absent metric publishes no buckets at all. An array of nulls would invite a chart to draw
    // a flat line through them, which is the zero this whole shape exists to refuse (rule 16).
    return { ...base, value: null, samples: 0, buckets: [], absent: entry.absent };
  }
  const series = fold.seriesFor(id);
  const total = { numerator: 0, denominator: 0, samples: 0 };
  const points = buckets.map((bucket) => {
    const point = series?.get(bucket.start) ?? { numerator: 0, denominator: 0, samples: 0 };
    total.numerator += point.numerator;
    total.denominator += point.denominator;
    total.samples += point.samples;
    return {
      start: bucket.start,
      end: bucket.end,
      value: publishable(aggregated(point, entry.aggregation)),
      samples: point.samples,
    };
  });
  return {
    ...base,
    value: publishable(aggregated(total, entry.aggregation)),
    samples: total.samples,
    buckets: points,
    absent: null,
  };
};

export interface StatsFoldInput {
  readonly range: ResolvedRange;
  readonly timezone: string;
  readonly timezoneSubstituted: boolean;
  readonly projectId: string | null;
  readonly generatedAt: IsoDateTime;
  readonly sources: StatsSources;
}

/** Which `stats_event_daily` counter feeds which count metric, one to one. */
const COUNTER_METRICS: Readonly<Record<string, StatMetricId>> = {
  'rebase.resolved': 'rebase_conflicts_resolved',
  'rebase.exhausted': 'rebase_conflicts_escalated',
  'conflict.warned': 'concurrent_task_overlaps',
  'review_only.threads_accepted': 'review_findings_accepted',
  'review_only.threads_dismissed': 'review_findings_dismissed',
  'ticket_lint.posted': 'ticket_lint_comments',
};

/** The counters whose **total** is the metric rather than their count. */
const COUNTER_TOTALS = new Set(['review_only.threads_accepted', 'review_only.threads_dismissed']);

/**
 * Rows in, the published document out — the whole arithmetic of `GET /api/org/stats`.
 *
 * Every metric is folded from the rows it is defined over and from nothing else, so two metrics
 * that share a denominator (delivered tasks) cannot disagree about it.
 */
export const foldStats = (input: StatsFoldInput): OrgStatsResponse => {
  const fold = new Fold(input.range.bucket);
  const { sources } = input;

  for (const task of sources.startedTasks) {
    fold.add('tasks_started', task.startedDay, { numerator: 1 });
    fold.add('merge_rate', task.startedDay, { numerator: 0, denominator: 1 });
    fold.add('human_intervention_rate', task.startedDay, {
      numerator: task.intervened ? 1 : 0,
      denominator: 1,
    });
  }

  for (const task of sources.deliveredTasks) {
    const day = task.mergedDay;
    fold.add('tasks_delivered', day, { numerator: 1 });
    fold.add('merge_rate', day, { numerator: 1, denominator: 0, samples: 0 });
    fold.add('first_pass_acceptance', day, {
      numerator: task.returns === 0 && task.humanReviewEntries === 0 ? 1 : 0,
      denominator: 1,
    });
    fold.add('clean_first_mr_rate', day, {
      numerator: task.returns === 0 && task.questions === 0 ? 1 : 0,
      denominator: 1,
    });
    fold.add('returns_per_delivered_task', day, { numerator: task.returns, denominator: 1 });
    fold.add('cycle_time_hours', day, { numerator: task.cycleHours });
    fold.add('agent_time_hours', day, { numerator: task.agentHours });
    fold.add('cost_per_delivered_task', day, { numerator: task.costUsd, denominator: 1 });
    fold.add('reviewer_minutes_per_delivered_task', day, { numerator: 0, denominator: 1 });
    if (task.estimateUsd !== null && task.costActual > 0) {
      fold.add('estimate_accuracy', day, {
        numerator: Math.abs(task.estimateUsd - task.costActual) / task.costActual,
      });
    }
  }

  for (const row of sources.counters) {
    const id = COUNTER_METRICS[row.metric];
    if (id === undefined) {
      continue;
    }
    fold.add(id, row.day, {
      numerator: COUNTER_TOTALS.has(row.metric) ? row.total : row.count,
      samples: row.count,
    });
  }

  for (const row of sources.cost) {
    fold.add('cost_total', row.day, { numerator: row.usd });
    fold.add('cache_hit_ratio', row.day, {
      numerator: row.cacheReadTokens,
      denominator: row.inputTokens,
    });
  }

  for (const row of sources.estimatedSpend) {
    fold.add('estimated_spend_share', row.day, {
      numerator: row.estimatedUsd,
      denominator: row.usd,
    });
  }

  for (const row of sources.questions) {
    fold.add('question_response_minutes', row.answeredDay, { numerator: row.minutes });
  }

  for (const row of sources.humanMinutes) {
    fold.add('human_minutes', row.day, { numerator: row.minutes });
    if (row.kind === 'review') {
      fold.add('reviewer_minutes_per_delivered_task', row.day, {
        numerator: row.minutes,
        denominator: 0,
        samples: 0,
      });
    }
  }

  for (const row of sources.kbProposals) {
    fold.add('kb_proposal_acceptance', row.day, {
      numerator: row.applied,
      denominator: row.applied + row.rejected,
      samples: row.applied + row.rejected,
    });
  }

  const buckets = bucketsOf(input.range);
  return {
    range: {
      range: input.range.range,
      bucket: input.range.bucket,
      from: input.range.from,
      to: input.range.to,
      timezone: input.timezone,
      timezone_substituted: input.timezoneSubstituted,
    },
    project_id: input.projectId,
    metrics: STATS_METRIC_IDS.map((id) => metricOf(id, fold, buckets)),
    returns_by_stage: sources.stageReturns.map((row) => ({
      ...row,
      rate: publishable(row.entries === 0 ? null : row.returns / row.entries),
    })),
    generated_at: input.generatedAt,
  };
};

// ── The CSV ──────────────────────────────────────────────────────────────────

/**
 * Q45's other half: **what the CSV is**.
 *
 * It is **long** — one row per (metric, scope, bucket) — rather than wide, and that is the whole
 * decision. A wide table needs a column per metric and therefore a **cell** for a metric that is
 * absent, and an empty cell in a spreadsheet is read as zero by every reader and by every `SUM()`.
 * In long form an absent metric simply has no rows, and the `absent` column on the total row says
 * why. It also survives this catalogue growing, which a wide header cannot.
 *
 * **Nothing untrusted reaches it.** Every cell is a metric id, a unit, a civil date, a number or a
 * definition this repository wrote — no ticket key, no path, no provider text — so the CSV-injection
 * question (a cell beginning `=`, `+`, `-` or `@`) has no attack surface here rather than a
 * mitigation. The quoting below is therefore about commas and quotes in the platform's own prose,
 * and the property is worth keeping: a future column carrying provider text would need the
 * spreadsheet-formula guard as well, and this note is where the next author meets that.
 */
const csvCell = (value: string | number | null): string => {
  if (value === null) {
    return '';
  }
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

export const STATS_CSV_HEADER = [
  'metric',
  'label',
  'unit',
  'scope',
  'bucket_start',
  'bucket_end',
  'value',
  'samples',
  'absent',
  'definition',
] as const;

export const statsToCsv = (response: OrgStatsResponse): string => {
  const lines: string[] = [STATS_CSV_HEADER.join(',')];
  for (const metric of response.metrics) {
    lines.push(
      [
        metric.id,
        metric.label,
        metric.unit,
        'total',
        response.range.from,
        // The total row's bounds are the range's, and `to` is inclusive while a bucket's `end` is
        // exclusive — so it is published as the day after, which makes every row's interval
        // half-open and comparable.
        addDays(response.range.to, 1),
        metric.value,
        metric.samples,
        metric.absent === null ? null : `${metric.absent.reason} — ${metric.absent.owner}`,
        metric.definition,
      ]
        .map(csvCell)
        .join(','),
    );
    for (const bucket of metric.buckets) {
      lines.push(
        [
          metric.id,
          metric.label,
          metric.unit,
          'bucket',
          bucket.start,
          bucket.end,
          bucket.value,
          bucket.samples,
          null,
          null,
        ]
          .map(csvCell)
          .join(','),
      );
    }
  }
  for (const stage of response.returns_by_stage) {
    lines.push(
      [
        'return_rate_by_stage',
        stage.stage,
        'ratio',
        'total',
        response.range.from,
        addDays(response.range.to, 1),
        stage.rate,
        stage.entries,
        null,
        'Stage returns ÷ stage entries over the period (product/19 §10).',
      ]
        .map(csvCell)
        .join(','),
    );
  }
  // A trailing newline: a file whose last line has none is one line short in half the tools that
  // read it.
  return `${lines.join('\n')}\n`;
};

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
 * minutes over-count by every robot nobody declared a machine (PROGRESS backlog **88**; since WP-61
 * a declared one is refused), under-count by the start of every review (there is no
 * review-requested type) and by every window an approval touched, which is withheld until the
 * real-GitLab check backlog **188** names, and rest on a cap applied per review window (per entry) and
 * nowhere else (backlog **89**, WP-61's ruling). The errors run in opposite directions and **do not
 * cancel**, so publishing the figure silently would be publishing a precision the platform does not
 * have.
 *
 * **4. A number published only with its coverage carries it, or is absent** (Q87). The defect-escape
 * rate can see only the bugs whose own ticket links a merge request, so the count of those — out of
 * all the bug tickets it traced — rides in its caveats, and below {@link DEFECT_COVERAGE_FLOOR} the
 * rate is absent with the coverage as the reason. The catalogue's `caveats` and `absent` are the
 * static half; {@link foldStats} adds the half only the rows can say.
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

// ── The bound on what one answer is folded from ─────────────────────────────

/**
 * The most delivered — or started — tasks one answer may be folded from.
 *
 * 5 000 is two orders of magnitude past what a self-hosted instance delivers in a year at
 * product/19's own dogfood volumes, and it is a bound on **memory**, not a quota: the per-task rows
 * are the only unbounded input to the fold.
 */
export const MAX_TASK_ROWS = 5_000;

/** Raised when a range holds more tasks than one answer may be folded from. */
export class StatsRangeTooLargeError extends Error {
  override readonly name = 'StatsRangeTooLargeError';
  readonly kind: 'started' | 'delivered';
  readonly limit: number;
  constructor(kind: 'started' | 'delivered', limit: number) {
    super(
      `this range covers more than ${limit} ${kind} tasks, which is more than one statistics answer is folded from; narrow the range or the project`,
    );
    this.kind = kind;
    this.limit = limit;
  }
}

/**
 * The per-task rows a read returned, or the refusal by name when there are more than
 * {@link MAX_TASK_ROWS} of them — a truncated total is indistinguishable from a real one on a screen.
 *
 * The comparison lives **here**, in the module the unit tier covers, rather than beside the SQL in
 * `stats-queries.ts`, which is excluded from coverage (WP-70, PROGRESS backlog 115): the one branch
 * of that file that was not a `where` clause is the one a unit test can reach without a database.
 * The reads ask for `MAX_TASK_ROWS + 1` rows so that "exactly at the bound" and "past it" differ.
 */
export const boundTaskRows = <Row>(
  kind: 'started' | 'delivered',
  rows: readonly Row[],
): readonly Row[] => {
  if (rows.length > MAX_TASK_ROWS) {
    throw new StatsRangeTooLargeError(kind, MAX_TASK_ROWS);
  }
  return rows;
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
  /**
   * Human review windows on the task that contain a human **comment**: a `human_time_entries` row of
   * kind `review` with a non-marker `mr.review.comment` by the window's account inside its span
   * (WP-90, PROGRESS backlog 191). A window an approval opened and no comment joined is not one —
   * since WP-60 an approval opens a window too, and zero human comments is not zero review windows.
   */
  readonly humanCommentWindows: number;
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
  /** The provider's `input_tokens`: only the tokens after the last cache breakpoint. */
  readonly inputTokens: number;
  /** Tokens written to the cache, both lifetimes (`cache_write_5m + cache_write_1h`). */
  readonly cacheWriteTokens: number;
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

/**
 * Human minutes per civil day and kind, as the projector capped them **per review window** (per entry) and
 * with the two exclusions `stats-queries.ts` states: rows for a declared machine dropped, review
 * windows an approval touched withheld ({@link WithheldReviewMinutes}).
 */
export interface HumanMinutesRow {
  readonly day: string;
  readonly kind: string;
  readonly minutes: number;
}

/** The review windows an approval touched, withheld from every published figure (backlog 188). */
export interface WithheldReviewMinutes {
  readonly minutes: number;
  readonly entries: number;
}

/**
 * Merged merge requests measured on a civil day (PROGRESS backlog 179), one per cause `mr.merged`:
 * how many the provider answered counts for, their lines added plus removed, and how many it
 * answered none for.
 */
export interface LocRow {
  readonly day: string;
  readonly measured: number;
  readonly lines: number;
  readonly unmeasured: number;
}

/** Distinct concurrent-task overlaps first warned on a civil day (PROGRESS backlog 180). */
export interface OverlapRow {
  readonly day: string;
  readonly count: number;
}

/** Lints posted on a civil day whose 48 h have run out, and how many were followed by an edit. */
export interface LintEditRow {
  readonly day: string;
  readonly linted: number;
  readonly improved: number;
}

/**
 * Bug tickets filed on a civil day (PROGRESS backlog 114, Q87): how many were traced, how many
 * carried a resolvable merge-request link, and how many escaped a merge the platform delivered.
 */
export interface BugTraceRow {
  readonly day: string;
  readonly bugs: number;
  readonly linked: number;
  readonly escaped: number;
}

export interface KbProposalRow {
  readonly day: string;
  readonly applied: number;
  readonly rejected: number;
}

/**
 * The runs `kb_usage` is a ratio over, per civil day they started (WP-57, PROGRESS backlog 112).
 *
 * `eligible` is the denominator the metric's own definition names; `cited` is how many of them cite
 * at least one document their recorded pack admitted.
 */
export interface KbUsageRow {
  readonly day: string;
  readonly eligible: number;
  readonly cited: number;
}

export interface StatsSources {
  readonly startedTasks: readonly StartedTaskRow[];
  readonly deliveredTasks: readonly DeliveredTaskRow[];
  readonly counters: readonly CounterRow[];
  readonly cost: readonly CostDayRow[];
  readonly estimatedSpend: readonly EstimatedSpendRow[];
  readonly questions: readonly QuestionRow[];
  readonly humanMinutes: readonly HumanMinutesRow[];
  readonly withheldReviewMinutes: WithheldReviewMinutes;
  readonly kbProposals: readonly KbProposalRow[];
  readonly kbUsage: readonly KbUsageRow[];
  readonly stageReturns: readonly StatStageReturn[];
  readonly overlaps: readonly OverlapRow[];
  readonly loc: readonly LocRow[];
  readonly lintEdits: readonly LintEditRow[];
  readonly bugTraces: readonly BugTraceRow[];
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
 * The three caveats both reviewer figures carry, in the words a reader of the screen needs.
 *
 * Every string the catalogue publishes is **UI text** (TD-033 decision 6, S-23.19): it reaches the
 * statistics screen's tooltips and its "How these are measured" disclosure, and the CSV. So the
 * reasons behind a sentence are cited here, in comments, and never in the sentence —
 * `stats-user-text.test.ts` fails on a decision id, a work-package or backlog number, a spec page,
 * a migration number, a backtick or Markdown emphasis in any of them.
 *
 *  1. Over-count: an undeclared bot opens a review window like a person (PROGRESS backlog 88; since
 *     WP-61 a declared machine, `POST /api/org/identities` with `kind: "machine"`, is refused by
 *     the projector and its earlier rows are dropped by the read).
 *  2. Under-count: no review-requested event type exists, so a window opens at the first comment or
 *     approval; and every window an approval touched is withheld until `docs/TODO.md`'s check —
 *     "Does a real GitLab send `approval` *and* `approved` for the last required approver, and is
 *     the delivery's `user` the approver?" — is answered (PROGRESS backlog 188).
 *  3. The cap: product/19 §16's 8 h per calendar day is applied per review window (per entry) by
 *     the projector and nowhere else (WP-61 criterion 3, PROGRESS backlog 89). WP-41 had capped a
 *     second time per person per day at read time; a figure capped both ways answers neither
 *     definition, so the read-side cap is gone and the residual is published instead.
 */
const REVIEWER_CAVEATS = [
  'Over-counts: a bot other than this platform (CI, a dependency updater) opens and extends a review window like a person, unless an administrator has declared its account a machine. Nothing is inferred from an account’s name.',
  'Under-counts: the start of a review is not seen, so a window opens at the first comment or approval rather than when the reviewer began reading. Windows an approval touched are withheld until the platform has confirmed how GitLab identifies the approver; they are stored, not discarded. The over- and under-counts run in opposite directions and do not cancel.',
  'The 8 h daily cap applies to each review window on its own, not per person, so one person reviewing two tasks on one day can be credited more than 8 h.',
] as const;

/** product/18:60's *"edited within 48 h"*, in hours. */
export const LINT_EDIT_WINDOW_HOURS = 48;

/**
 * The changelog fields an edit must name to count as *improving* a linted ticket (PROGRESS backlog
 * 186), compared lower-cased. The linter reads a ticket's summary and description (`RefinedSpec`),
 * so those are what an improvement changes; a status, rank, sprint or watcher change is not one —
 * and the platform's own status-mapping transition is exactly such a change.
 */
export const LINT_IMPROVEMENT_FIELDS = ['summary', 'description'] as const;

/** product/16's *"bugs filed against agent-merged MRs within 30 days"*, in days. */
export const DEFECT_ESCAPE_WINDOW_DAYS = 30;

/**
 * The share of bug tickets that must carry a resolvable merge-request link before the defect-escape
 * rate is published at all — **½, a chosen floor**, the product's rule (Q87, product/16). It is
 * **not derived**: WP-61's criterion 5 asked for a floor derived in the change (rule 63), and
 * nothing measured or modelled here produces ½ — this is a deviation, recorded in PROGRESS under
 * WP-61, and the measurement that could replace the choice is `docs/TODO.md`'s open question.
 *
 * What the choice means, stated rather than presented as a derivation: of `B` bug tickets, `L`
 * carried a link the platform resolved and `U = B − L` did not; the true number of escapes lies in
 * `[E, E + U]` and the published figure is its **lower bound**, wrong in the direction that
 * flatters the platform. ½ is the point where the seen bugs are at least as many as the unseen
 * (`L ≥ U`) — a readable threshold, not a statistical one. A rate with **no** bug ticket behind it
 * is absent too: "no bug was filed" and "no bug reached the platform" (a binding with no webhook,
 * backlog 187) cannot be told apart.
 *
 * Two residuals the coverage does **not** see, stated at the number it gates:
 *
 *  - **a bug whose trace job exhausts its retries emits no `ticket.bug.traced`**, so it leaves the
 *    denominator silently instead of counting as `unreadable` — the coverage is then overstated by
 *    exactly those bugs. Since WP-90 a lost race for the project stream is retried inside the duty
 *    (backlog 193), so what exhausts the retries is a provider that keeps failing, not the log.
 *    Recording the exhaustion would need a dead-letter hook on the outbound queue that this build
 *    does not have for any duty; not done here;
 *  - **a bug that links only its later fix counts as `linked`** — it raises the coverage — while its
 *    origin is unknown: the thirty-day look-back keeps the fix out of the numerator, not out of the
 *    coverage. So the coverage is an upper bound on "bugs whose origin the platform could see";
 *  - **`linked` is final** (WP-90): a bug once traced `linked` is never traced again, so a link
 *    later removed from the ticket still counts in the coverage and, if its merge request escaped,
 *    in the numerator — an over-count in both, by exactly those bugs.
 */
export const DEFECT_COVERAGE_FLOOR = 0.5;

/**
 * Every metric this endpoint publishes, in the order a screen reads them.
 *
 * The absent ones are **in this table**, not omitted from it: product/16 and product/18 name them,
 * so a reader has to be told they are not measured and by whom they would be.
 *
 * **Every string below is UI text** (S-23.19): labels, definitions, caveats and absences reach the
 * screen and the CSV verbatim, so the reference behind each is the comment above it — never the
 * string. `stats-user-text.test.ts` holds that.
 */
export const STATS_CATALOGUE: Readonly<Record<StatMetricId, MetricDefinition>> = {
  // A template that delivers a merge request (`deliversMergeRequest`), `tasks.mode = 'normal'`.
  tasks_started: {
    label: 'Tasks started',
    definition:
      'Tasks created in the period that deliver a merge request (feature, bug and chore tasks), excluding shadow-mode tasks. Discovery, review-only, ticket-lint, history-bootstrap and epic-split tasks never open a merge request, so they are not counted — counting them would make the merge rate a statement about how much the platform was configured to do.',
    unit: 'count',
    aggregation: 'sum',
  },
  // product/19 §10; the instant is the platform's own `mr.merged` (`stats_task_delivery`).
  tasks_delivered: {
    label: 'Tasks delivered',
    definition:
      'Tasks whose merge request merged in the period, counted at the moment of the merge. A task still running its retrospective is already counted.',
    unit: 'count',
    aggregation: 'sum',
  },
  merge_rate: {
    label: 'Merge rate',
    definition:
      'Tasks delivered in the period ÷ tasks started in the period. The two are counted at different moments — a merge and a creation — so a period that begins with work already in flight can exceed 100%.',
    unit: 'ratio',
    aggregation: 'ratio',
  },
  // product/16. Caveats: PROGRESS backlog 191 (WP-90 counts only windows with a human comment) and
  // backlog 88 (declared machines).
  first_pass_acceptance: {
    label: 'First-pass acceptance',
    definition:
      'Delivered tasks with no stage returns and no human merge-request comments ÷ delivered tasks. A human comment is one the platform did not write, recognised by the marker every platform comment carries.',
    unit: 'ratio',
    aggregation: 'ratio',
    caveats: [
      'An approval is not a comment: a reviewer who approved without commenting leaves the task first-pass. A comment is matched to the task through its author’s review window, so a comment on another merge request of the same project inside that window makes this task not first-pass — an under-count.',
      'A comment from an account declared a machine does not count; one from an undeclared bot does, and makes the task not first-pass — an under-count. A person who pastes the platform’s comment marker into a comment is not counted — an over-count.',
    ],
  },
  // product/19 §10. The per-author breakdown product/16 asks for is `clean_first_mr_rate_by_author`.
  clean_first_mr_rate: {
    label: 'Clean first-MR rate',
    definition:
      'Delivered tasks with no questions and no stage returns ÷ delivered tasks. The breakdown by ticket author is listed under “Not measured, and why”.',
    unit: 'ratio',
    aggregation: 'ratio',
  },
  // product/19 §10; "escalation to a person" is the `needs_human` state.
  human_intervention_rate: {
    label: 'Human intervention rate',
    definition:
      'Tasks started in the period with at least one answered question, decided approval, human return or escalation to a person ÷ tasks started.',
    unit: 'ratio',
    aggregation: 'ratio',
  },
  /**
   * **An average count, so `decimal`** (S-23.19). It was declared `ratio` from WP-41 until S-23.19
   * and the screen multiplied it by 100: eight returns over one delivered task read *800.0 %*. The
   * per-stage breakdown product/19 §10 defines is `returns_by_stage` beside the metrics.
   */
  returns_per_delivered_task: {
    label: 'Returns per delivered task',
    definition:
      'Average number of stage returns per delivered task: stage returns on the tasks delivered in the period ÷ those tasks. 0.0 means no delivered task was sent back; the breakdown is under “Returns by stage”.',
    unit: 'decimal',
    aggregation: 'ratio',
  },
  // product/19 §10 asks for the median and p90; a distribution needs every task's figure, and the
  // read folds one row per delivered task inside the range only.
  cycle_time_hours: {
    label: 'Cycle time',
    definition:
      'Average time from a task being created to its merge request merging, in hours, over the tasks delivered in the period. It is the mean; the median and 90th percentile are not computed yet.',
    unit: 'hours',
    aggregation: 'mean',
  },
  // product/19 §10 "agent time": summed `runs.ended_at - runs.started_at` per delivered task.
  agent_time_hours: {
    label: 'Agent time',
    definition:
      'Average total run time per delivered task, in hours: the summed wall-clock time of every agent run on the task. A run that never started adds nothing.',
    unit: 'hours',
    aggregation: 'mean',
  },
  /**
   * `cost_rollup_daily.usd` over the range (BD-011's ledger, WP-19), which reconciles with
   * `sum(cost_entries.usd)` by construction (`rollupDeltasFor`). Labelled *in this range* since
   * S-23.19, because the per-task figure below is a **lifetime** one and the two sat side by side
   * with one word between them.
   */
  cost_total: {
    label: 'Spend in this range',
    definition:
      'Agent spend recorded in the period, on every task whether or not it was delivered, from the cost ledger. Spend the platform priced itself because the provider reported none is included; its share is “Estimated share of spend”.',
    unit: 'usd',
    aggregation: 'sum',
  },
  /**
   * product/19:97 — *"sum(cost_entries) of delivered tasks / delivered"* — and that is what this is:
   * each delivered task's **whole** ledger spend (`stats-queries.ts`' `deliveredTasks`, no date
   * filter on `cost_entries`) ÷ the delivered tasks. So it is not bounded by *Spend in this range*:
   * a task that ran for weeks and merged yesterday brings all of its spend into this range's figure
   * (the owner's live page, 2026-11-05: one delivered task, $123.05, beside $8.98 of in-range
   * spend). The label and the definition say *lifetime* so the two cannot be read as one quantity.
   * Caveat: Q70 (b) — a cancel stops a session its process holds and that process charges it
   * (WP-101), a session still running after a cancel ended its row records its spend against it
   * (WP-47), but a dead process has nobody left to report the figure.
   */
  cost_per_delivered_task: {
    label: 'Lifetime cost per delivered task',
    definition:
      'The whole spend of the tasks delivered in the period ÷ the number of those tasks. A task’s spend counts from its first run, including runs before the period began — so with few deliveries this can be larger than “Spend in this range”, which counts only money spent inside the period.',
    unit: 'usd',
    aggregation: 'ratio',
    caveats: [
      'Understates a task when one of its runs was cancelled and the process running it stopped before reporting what it spent: nothing measured that spend, and no figure is invented for it.',
    ],
  },
  // `cost_entries.is_estimate` (BD-011, PROGRESS backlog 75).
  estimated_spend_share: {
    label: 'Estimated share of spend',
    definition:
      'Spend the platform priced itself from its price list ÷ all spend in the period. High means the provider reported no cost for most runs — a local-mode deployment, or a provider that stopped reporting — so the cost figures are prices rather than invoices.',
    unit: 'ratio',
    aggregation: 'ratio',
  },
  // product/19:99, from `tasks.estimate_usd` and `tasks.cost_actual` only; product/19 asks for the
  // median by size, this is the mean over all sizes.
  estimate_accuracy: {
    label: 'Estimate error',
    definition:
      'Average relative error of the refinement estimate: |estimate − actual| ÷ actual, over the delivered tasks that carry an estimate. 0% is a perfect estimate; 100% means it was off by the size of the actual. The mean over all task sizes; the median by size is not computed yet.',
    unit: 'ratio',
    aggregation: 'mean',
  },
  /**
   * **A share of one whole since S-23.19, so it lies in [0, 1].** product/16 words it *"cache-read
   * tokens / input tokens"*, and WP-41 read `input_tokens` as the provider's field — but the
   * Messages API's `input_tokens` counts only the tokens **after the last cache breakpoint**, not
   * the prompt: *"total_input_tokens = cache_read_input_tokens + cache_creation_input_tokens +
   * input_tokens"* (platform.claude.com, *Prompt caching*, "Tracking cache performance", retrieved
   * 2026-11-05). A Claude Code session re-reads a large cached prompt every turn and sends a few
   * new tokens, so the old ratio published *3 016 250 %* on the owner's live page. "Input tokens" is
   * therefore read as the whole prompt: uncached input + cache writes (5 min and 1 h) + cache reads,
   * all from `cost_rollup_daily`.
   */
  cache_hit_ratio: {
    label: 'Cache hit ratio',
    definition:
      'Share of input tokens read from the prompt cache: cache-read tokens ÷ all input tokens (uncached input + tokens written to the cache + tokens read from it), over the period. Always between 0% and 100%; higher means cheaper runs.',
    unit: 'ratio',
    aggregation: 'ratio',
  },
  // product/19 §10, over `questions.answered_at` in the range.
  question_response_minutes: {
    label: 'Question response time',
    definition:
      'Average minutes from a question being asked to its answer, over the questions answered in the period. Questions still open are not included: an unanswered question has no response time yet, and counting the time so far would make the figure fall when somebody finally answers.',
    unit: 'minutes',
    aggregation: 'mean',
  },
  // product/16 and product/19 §16; the withholding and the cap are REVIEWER_CAVEATS' references.
  reviewer_minutes_per_delivered_task: {
    label: 'Reviewer minutes per delivered task',
    definition:
      'Human review minutes recorded in the period ÷ tasks delivered in the period. A review window runs from the first human comment or approval on a merge request to the merge or the last activity, leaves out gaps over 2 h, and is capped at 8 h per calendar day per review window. Windows an approval touched are withheld until the approver’s identity is confirmed, and accounts declared machines are left out.',
    unit: 'minutes',
    aggregation: 'ratio',
    caveats: REVIEWER_CAVEATS,
  },
  // product/19 §16; never added to dollars, because no hourly rate exists (Q73).
  human_minutes: {
    label: 'Human minutes',
    definition:
      'All human minutes recorded in the period — reviewing, answering questions, approving and steering. Shown beside the cost figures and never added to them: there is no hourly rate to convert one into the other. Its review part leaves out what “Reviewer minutes per delivered task” leaves out: windows an approval touched, and accounts declared machines.',
    unit: 'minutes',
    aggregation: 'sum',
    caveats: REVIEWER_CAVEATS,
  },
  // product/16.
  kb_proposal_acceptance: {
    label: 'Knowledge proposal acceptance',
    definition:
      'Knowledge proposals applied ÷ proposals decided (applied + rejected) in the period. A proposal nobody has decided yet is in neither side.',
    unit: 'ratio',
    aggregation: 'ratio',
  },
  /**
   * product/16's *"% runs whose context pack included a KB document that the agent cited"*, over a
   * named subset (WP-57, PROGRESS backlog 112): runs that produced a RefinedSpec or a ResearchReport
   * — the two artifacts that carry `kb_citations` — whose `run_context_pack` admitted a tier-1
   * document. A page reached with `kb_search` is not in the pack; a vault path outside `A–Z a–z 0–9
   * . _ - /` is degraded in the prompt's data-block attribute and cannot match. Runs created before
   * migration 0041 have no recorded pack.
   */
  kb_usage: {
    label: 'Knowledge usage',
    definition:
      'Share of eligible runs whose output cites a knowledge document their context pack included. Eligible runs are those started in the period that produced a refined specification or a research report — refinement and spike runs, the only ones whose output carries knowledge citations — and whose context pack included at least one tier-1 knowledge document. The 80% target applies to these runs, not to all runs.',
    unit: 'ratio',
    aggregation: 'ratio',
    caveats: [
      'Implementation, review and other runs produce no output that carries citations, so they are left out of both sides rather than counted as misses.',
      'A cited page the context pack did not include — one the agent found by searching the knowledge base — does not count, and neither does a page whose path could not be quoted exactly in the prompt; both under-count.',
      'A citation is the agent’s own claim that it used the page; nothing verifies that it read it.',
      'Runs from before context packs were recorded are in neither side.',
    ],
  },
  // product/16, BD-030: `rebase.resolved`.
  rebase_conflicts_resolved: {
    label: 'Conflicts resolved automatically',
    definition:
      'Rebase-gate checks where the branch did not apply cleanly and a conflict-resolution run made it apply.',
    unit: 'count',
    aggregation: 'sum',
  },
  // product/16, BD-030: `rebase.exhausted`.
  rebase_conflicts_escalated: {
    label: 'Conflicts escalated',
    definition:
      'Rebase-gate checks where the conflict-resolution attempts ran out and the task went to a person.',
    unit: 'count',
    aggregation: 'sum',
  },
  // product/16; distinct overlaps read from the log (PROGRESS backlog 180), repeats collapsed
  // (backlog 65).
  concurrent_task_overlaps: {
    label: 'Concurrent-task overlaps',
    definition:
      'Distinct overlaps first warned in the period: one per pair of tasks at one pair of revisions. The rebase gate warns again each time it re-finds an overlap, and for both tasks at once; those repeats are one overlap here. A new push to either branch that still overlaps is a new one.',
    unit: 'count',
    aggregation: 'sum',
  },
  // product/18:59.
  review_findings_accepted: {
    label: 'Review-only findings accepted',
    definition:
      'Finding threads a review-only review posted that were resolved on a merge request whose code changed afterwards — read as “resolved with a change”.',
    unit: 'count',
    aggregation: 'sum',
  },
  // product/18:59.
  review_findings_dismissed: {
    label: 'Review-only findings dismissed',
    definition:
      'Finding threads a review-only review posted that were resolved without the merge request’s code changing. Threads still open are in neither figure.',
    unit: 'count',
    aggregation: 'sum',
  },
  // product/18:60.
  ticket_lint_comments: {
    label: 'Ticket lint comments',
    definition: 'Readiness-lint comments posted on tickets in the period, at most one per ticket.',
    unit: 'count',
    aggregation: 'sum',
  },
  // product/18:60 "tickets improved after lint (edited within 48 h)"; PROGRESS backlog 186 (the
  // changelog fields), backlog 187 (a binding with no webhook).
  tickets_edited_after_lint: {
    label: 'Tickets improved after lint',
    definition:
      'Lint comments whose ticket’s summary or description was edited within 48 h after the comment ÷ lint comments, counted on the day the comment was posted. An edit counts only if the tracker reports a change to the summary or the description that is newer than what the linter read.',
    unit: 'ratio',
    aggregation: 'ratio',
    caveats: [
      'A status, rank, sprint or watcher change is not an improvement — which is also what keeps the platform’s own status transitions out. An edit of the summary or description by anybody, a bot included, counts.',
      'A lint comment less than 48 h old is in neither side until its window closes, so the last two days of a range carry fewer samples rather than a falling rate.',
      'A project whose tracker sends the platform no edits never reports one, so its lint comments count as not improved.',
    ],
  },
  // product/19 §13; served per batch by `GET /api/shadow-batches/:id` (WP-34).
  shadow_similarity: {
    label: 'Shadow similarity',
    definition:
      'How close a shadow run’s change came to the human merge request it was compared with.',
    unit: 'ratio',
    aggregation: 'mean',
    absent: {
      reason:
        'Measured per shadow batch, the unit in which the comparison means something: a similarity averaged over batches run against different repositories at different times answers no useful question.',
      owner:
        'Shown per batch on the Shadow screen, with the similarity distribution, the cost by size and the launch candidates.',
    },
  },
  // product/16 (visible to everyone in the project, Q22). Absent: `ticketRef` carries no author
  // (Q48), and attributing one to a person needs a `user_identities` row (PROGRESS backlog 79).
  clean_first_mr_rate_by_author: {
    label: 'Clean first-MR rate by ticket author',
    definition:
      'Delivered tasks with no returns and no human comments, grouped by the ticket’s author and visible to everyone in the project.',
    unit: 'ratio',
    aggregation: 'ratio',
    absent: {
      reason:
        'The platform does not record who wrote a ticket, and attributing a ticket to a person would also need that person’s tracker account linked to a platform user. The rate without the grouping is shown above.',
      owner: 'Needs the ticket’s author recorded and linked to a platform user; not scheduled yet.',
    },
  },
  // product/19 §10. `task_stages.return_reason` is agent prose and names no criterion id; readiness
  // itself is re-evaluated (WP-64, WP-94). The tagging has no producer (product/17).
  readiness_attributed_returns: {
    label: 'Readiness-attributed returns',
    definition:
      'Stage returns tagged with the readiness criterion that would have prevented them ÷ all returns.',
    unit: 'ratio',
    aggregation: 'ratio',
    absent: {
      reason:
        'No return carries a readiness criterion: a return’s reason is written by an agent as prose and names no criterion, so there is nothing to attribute.',
      owner: 'Nobody yet: returns would first need to be tagged with a criterion.',
    },
  },
  /**
   * product/16's "LOC added/removed/changed per merged MR … (from MR diff stats)", the platform's
   * own merge requests only (PROGRESS backlog 179): GitLab's `diffStatsSummary`, read once at the
   * merge, never the merge event. An average, so `decimal` since S-23.19 (it was `count`, which the
   * screen rounded to a whole line). A lost race for the log is retried with the answer already read
   * (backlog 193).
   */
  loc_changed: {
    label: 'Lines changed per merged MR',
    definition:
      'Lines added plus lines removed ÷ merged merge requests, for merge requests the platform made — shown for information, not as a target. The counts are read from the provider once, when the merge request merges.',
    unit: 'decimal',
    aggregation: 'ratio',
    caveats: [
      'A merge request a person merged without a platform task is not measured.',
      'Counted on the day the measurement was recorded, shortly after the merge. A merge request reopened and merged twice counts as two merges.',
      'A merge whose measurement fails on every retry, because the provider keeps refusing the read, has no measurement and is in neither the measured nor the unmeasured count.',
    ],
  },
  /**
   * product/16's "bugs filed against agent-merged MRs within 30 days ÷ merged MRs" (PROGRESS backlog
   * 114, Q87). A bug ticket is one whose issue type the project routes to the `bug` template. The
   * caveat is backlog 192 (a later link is traced on an edit) and backlog 187 (no webhook, no poll).
   */
  defect_escape: {
    label: 'Defect escape',
    definition:
      'Bug tickets filed in the period whose own link names a merge request the platform delivered in the 30 days before the filing ÷ tasks delivered in the period; tracked without a target. The merge request is found only through a link on the bug ticket — never by its title, never by timing. The two sides are counted at different moments, the filing and the merge, as the merge rate’s are.',
    unit: 'ratio',
    aggregation: 'ratio',
    caveats: [
      'A link added to a bug ticket after it was filed is seen when the ticket’s edit reaches the platform, which traces it again; a tracker that reports no edits keeps the bug as it was first traced. A bug counts on the day it was filed, so a link added later can change a past day’s figure.',
    ],
  },
  // product/16 "queue wait time". `task.dequeued` is declared unconsumed (naming WP-20, which
  // shipped without a projection); a fold of `task.queued`/`task.dequeued` owns this metric.
  queue_wait_minutes: {
    label: 'Queue wait',
    definition: 'How long a task waited between being queued and being picked up.',
    unit: 'minutes',
    aggregation: 'mean',
    absent: {
      reason:
        'The moment a task leaves the queue is recorded in the event log, but nothing turns it into a figure yet.',
      owner:
        'Nobody yet: it needs a projection that pairs each task’s queued and picked-up events.',
    },
  },
  // product/09:29 and product/18:32 "tokens + people". Owner: Q73 — "convert when set" makes it an
  // organisation setting `human_hour_rate_usd`; "do not convert" means it is never built.
  total_cost_of_delivery: {
    label: 'Total cost of delivery',
    definition: 'Agent spend plus people’s time, as one number.',
    unit: 'usd',
    aggregation: 'sum',
    absent: {
      reason:
        'Adding dollars to minutes needs an hourly rate, and none is configured. A default would not be neutral — it varies by team, by country and by whether it means salary or loaded cost — and it would be shown as though it had been measured. Spend and human minutes are both shown, side by side and unsummed.',
      owner:
        'Needs a decision on whether people’s time is converted to money at a configured hourly rate.',
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

/**
 * What only the rows can say about a metric: a caveat carrying a count, or an absence decided by one
 * (rule 4 of the module docblock). Added **after** the catalogue's own caveats, never instead.
 */
interface DynamicMetricFacts {
  readonly caveats?: readonly string[];
  readonly absent?: StatAbsence;
}

const metricOf = (
  id: StatMetricId,
  fold: Fold,
  buckets: readonly { readonly start: string; readonly end: string }[],
  facts: DynamicMetricFacts = {},
): StatMetric => {
  const entry = STATS_CATALOGUE[id];
  const base = {
    id,
    label: entry.label,
    definition: entry.definition,
    unit: entry.unit,
    caveats: [...(entry.caveats ?? []), ...(facts.caveats ?? [])],
  };
  const absent = entry.absent ?? facts.absent;
  if (absent !== undefined) {
    // An absent metric publishes no buckets at all. An array of nulls would invite a chart to draw
    // a flat line through them, which is the zero this whole shape exists to refuse (rule 16).
    return { ...base, value: null, samples: 0, buckets: [], absent };
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

/**
 * Which `stats_event_daily` counter feeds which count metric, one to one.
 *
 * `conflict.warned` is **not** here since WP-61: it counts comparisons, and the metric counts
 * distinct overlaps, read from the log (`OverlapRow`, PROGRESS backlog 180). The projector still
 * writes the counter — a projection is not rewritten under a replay — and nothing publishes it.
 */
const COUNTER_METRICS: Readonly<Record<string, StatMetricId>> = {
  'rebase.resolved': 'rebase_conflicts_resolved',
  'rebase.exhausted': 'rebase_conflicts_escalated',
  'review_only.threads_accepted': 'review_findings_accepted',
  'review_only.threads_dismissed': 'review_findings_dismissed',
  'ticket_lint.posted': 'ticket_lint_comments',
};

const percent = (share: number): string => `${Math.round(share * 1000) / 10} %`;

/**
 * Q87's rule, applied to the rows: the defect-escape rate with its coverage in its caveats, or
 * absent with the coverage as the reason ({@link DEFECT_COVERAGE_FLOOR} has the derivation).
 */
export const defectEscapeFacts = (rows: readonly BugTraceRow[]): DynamicMetricFacts => {
  const bugs = rows.reduce((sum, row) => sum + row.bugs, 0);
  const linked = rows.reduce((sum, row) => sum + row.linked, 0);
  // Q87 decided the rule; the share of real bug tickets that carry a resolvable link is
  // `docs/TODO.md`'s open measurement. The strings below are UI text and cite neither (S-23.19).
  const owner =
    'A team that links its bug tickets to the merge request they came from raises the coverage.';
  if (bugs === 0) {
    return {
      absent: {
        reason:
          'No bug ticket was traced in the period, so the share of bugs that could be attributed to a merge request — which this rate is only ever shown with — cannot be computed. “No bug was filed” and “no bug reached the platform” look the same from here.',
        owner,
      },
    };
  }
  const share = linked / bugs;
  const coverage = `${linked} of ${bugs} bug tickets filed in the period (${percent(share)}) carried a merge-request link the platform could resolve`;
  if (share < DEFECT_COVERAGE_FLOOR) {
    return {
      absent: {
        reason: `Coverage below the floor: ${coverage}, and the rate is published only when at least half did — below that, the bugs it cannot see outnumber the ones it can, and the number would describe what is missing.`,
        owner,
      },
    };
  }
  return {
    caveats: [
      `Coverage: ${coverage}. The rest could not be attributed and are not in the numerator, so the rate is a lower bound — it under-reports, in the direction that flatters the platform.`,
    ],
  };
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
      numerator: task.returns === 0 && task.humanCommentWindows === 0 ? 1 : 0,
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
    fold.add('defect_escape', day, { numerator: 0, denominator: 1 });
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

  let unmeasuredMerges = 0;
  for (const row of sources.loc) {
    unmeasuredMerges += row.unmeasured;
    fold.add('loc_changed', row.day, {
      numerator: row.lines,
      denominator: row.measured,
      samples: row.measured,
    });
  }

  for (const row of sources.overlaps) {
    fold.add('concurrent_task_overlaps', row.day, { numerator: row.count, samples: row.count });
  }

  for (const row of sources.lintEdits) {
    fold.add('tickets_edited_after_lint', row.day, {
      numerator: row.improved,
      denominator: row.linted,
      samples: row.linted,
    });
  }

  for (const row of sources.bugTraces) {
    fold.add('defect_escape', row.day, { numerator: row.escaped, denominator: 0, samples: 0 });
  }

  for (const row of sources.cost) {
    fold.add('cost_total', row.day, { numerator: row.usd });
    // Every prompt token, so the read share is a share of one whole (the catalogue entry has the
    // provider's definition): it cannot exceed 1 whatever the row says.
    fold.add('cache_hit_ratio', row.day, {
      numerator: row.cacheReadTokens,
      denominator: row.inputTokens + row.cacheWriteTokens + row.cacheReadTokens,
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

  for (const row of sources.kbUsage) {
    fold.add('kb_usage', row.day, {
      numerator: row.cited,
      denominator: row.eligible,
      samples: row.eligible,
    });
  }

  const withheld = sources.withheldReviewMinutes;
  const withheldCaveat =
    withheld.entries === 0
      ? []
      : [
          `Withheld in this period: ${withheld.entries} review window${withheld.entries === 1 ? '' : 's'} an approval touched, ${publishable(withheld.minutes)} minutes.`,
        ];
  const facts: Partial<Record<StatMetricId, DynamicMetricFacts>> = {
    reviewer_minutes_per_delivered_task: { caveats: withheldCaveat },
    human_minutes: { caveats: withheldCaveat },
    defect_escape: defectEscapeFacts(sources.bugTraces),
    loc_changed: {
      caveats:
        unmeasuredMerges === 0
          ? []
          : [
              `${unmeasuredMerges} merged merge request${unmeasuredMerges === 1 ? '' : 's'} in the period had no counts from the provider and ${unmeasuredMerges === 1 ? 'is' : 'are'} in neither side — not counted as zero lines.`,
            ],
    },
  };

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
    metrics: STATS_METRIC_IDS.map((id) => metricOf(id, fold, buckets, facts[id])),
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
        // product/19 §10.
        'Stage returns ÷ stage entries over the period.',
      ]
        .map(csvCell)
        .join(','),
    );
  }
  // A trailing newline: a file whose last line has none is one line short in half the tools that
  // read it.
  return `${lines.join('\n')}\n`;
};

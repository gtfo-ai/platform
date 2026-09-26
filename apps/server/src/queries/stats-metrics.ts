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
 * The `docs/TODO.md` item every approval-derived review minute waits on (PROGRESS backlog 188),
 * named once so the definition and the caveat cannot name two different checks.
 */
const APPROVAL_CHECK =
  '`docs/TODO.md`’s “Does a real GitLab send `approval` *and* `approved` for the last required approver, and is the delivery’s `user` the approver?”';

/**
 * product/19 §16's eight-hour cap is applied **per review window (per entry) per calendar day**, by the
 * projector, and by nothing here (WP-61 criterion 3, PROGRESS backlog 89).
 *
 * WP-41 had capped a second time at read time, per person per day across tasks. The ruling for
 * WP-61 is the other reading of *"capped at 8 h per calendar day"* — per entry, which is what the
 * projector can do statelessly and replay exactly — and a figure capped both ways answers neither
 * definition, so the read-side cap is gone and the residual is published instead: one person
 * reviewing two tasks on one day can be credited more than eight hours in a sum across tasks.
 */
const REVIEWER_CAVEATS = [
  'Over-counts: a bot that is not this platform — CI, a dependency updater — opens and extends a review window like a person unless an operator has declared its account a machine (`POST /api/org/identities` with `kind: "machine"`, PROGRESS backlog 88). A declared machine’s activity is refused by the projector and its earlier rows are left out of this figure; an undeclared one is counted. Nothing is inferred from an account’s name.',
  `Under-counts: a review’s start is not seen — the event catalogue has no review-requested type, so a window opens at the first comment or approval rather than when the reviewer began reading. And every review window an approval touched is **withheld** from this figure until ${APPROVAL_CHECK} is answered (PROGRESS backlog 188): the approver’s identity is an inference from GitLab’s documentation, and a wrong one would credit the wrong reviewer. Withheld windows are stored, not discarded. The over- and under-counts run in opposite directions and do not cancel.`,
  'Capped per review window: product/19 §16’s 8 h per calendar day is applied to each review window (one row of the projection) on its own, not per person — so one person can be credited more than 8 h in a day here, by reviewing two tasks, or one task in two windows separated by a gap over 2 h (PROGRESS backlog 89).',
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
 *    exactly those bugs. Recording the exhaustion would need a dead-letter hook on the outbound
 *    queue that this build does not have for any duty; not done here;
 *  - **a bug that links only its later fix counts as `linked`** — it raises the coverage — while its
 *    origin is unknown: the thirty-day look-back keeps the fix out of the numerator, not out of the
 *    coverage. So the coverage is an upper bound on "bugs whose origin the platform could see".
 */
export const DEFECT_COVERAGE_FLOOR = 0.5;

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
      'Under-counts: since WP-60 an approval opens a review window as a comment does (`mr.approved`, PROGRESS backlog 90), so a reviewer who approved without commenting makes the task **not** first-pass here, although nobody commented. A window of a declared machine account does not count (PROGRESS backlog 88); an undeclared bot’s does.',
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
      'Understates a task whose cancelled run’s process then died before reporting: the run that still runs records its spend against the terminated row (WP-47), but a dead process has nobody left to report the figure, so nothing measures it and nothing invents one (Q52).',
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
    definition: `Human review minutes recorded in the period ÷ tasks delivered in the period (product/16). A review window runs from the first human merge-request comment or approval to the merge or last activity, excluding gaps over 2 h, capped at 8 h per calendar day **per review window** (per entry; product/19 §16). Every window an approval touched is left out of the numerator until ${APPROVAL_CHECK} is answered (PROGRESS backlog 188); so are the windows of accounts an operator declared machines.`,
    unit: 'minutes',
    aggregation: 'ratio',
    caveats: REVIEWER_CAVEATS,
  },
  human_minutes: {
    label: 'Human minutes',
    definition: `All human minutes recorded in the period — review, question, approval and steer (product/19 §16). Published beside the cost figures and never added to them: no rate exists to convert one into the other (Q73). Its review part excludes what reviewer minutes excludes: windows an approval touched, until ${APPROVAL_CHECK} is answered, and declared machine accounts.`,
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
      'product/16’s “% runs whose context pack included a KB document that the agent cited”, over a **named subset of runs**: the denominator is the runs started in the period that produced a RefinedSpec or a ResearchReport — the only two artifacts that carry `kb_citations`, so refinement and spike runs — and whose recorded context pack admitted at least one tier-1 knowledge document. The numerator is those whose artifact cites, by its exact vault path, at least one of the tier-1 documents the pack admitted. product/16’s ≥ 80 % target is a target about this subset, not about all runs.',
    unit: 'ratio',
    aggregation: 'ratio',
    caveats: [
      'Not every run: implementation, review and the other roles produce no artifact with `kb_citations`, so a pack they were shown can never count as cited and they are left out of both sides rather than counted as misses (PROGRESS backlog 112).',
      'A cited page the pack did not carry — one the agent reached with `kb_search` — counts as no citation, because product/16’s sentence is about the pack. A page whose vault path the prompt could not carry verbatim (it degrades an attribute outside `A–Z a–z 0–9 . _ - /`) cannot match either; both under-count.',
      'A citation is the model’s own claim that it used the page; nothing verifies it read what it cites.',
      'Runs created before migration 0041 have no recorded pack and are in neither side.',
    ],
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
      'Distinct overlaps first warned in the period: one per unordered pair of tasks at one pair of revisions (product/16, PROGRESS backlog 180). The rebase gate warns again at every entry that re-finds an overlap, and for both tasks of the pair at once (PROGRESS backlog 65); those repeats are one overlap here. A push to either task’s branch that still overlaps is a new one. Counted on the day it was first warned.',
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
    definition:
      'product/18:60’s “tickets improved after lint (edited within 48 h)”: lint comments whose ticket’s summary or description was edited within 48 h after the comment ÷ lint comments, counted on the day the comment was posted (PROGRESS backlog 186). An edit counts only if the provider’s changelog names `summary` or `description` and the edit is newer than the ticket the linter read.',
    unit: 'ratio',
    aggregation: 'ratio',
    caveats: [
      'A status, rank, sprint or watcher change is not an improvement — which is also what keeps the platform’s own status transitions out, since the update event carries no editor to filter on. An edit to the summary or description by anybody, including a bot, counts.',
      'A lint comment posted less than 48 h ago is in neither side until its window closes, so the last two days of a range carry fewer samples rather than a falling rate.',
      'A project whose tracker binding has no webhook never reports an edit (PROGRESS backlog 187), so its lint comments count as not improved.',
    ],
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
      'product/16’s “LOC added/removed/changed per merged MR and aggregated per day (from MR diff stats)”, shown for information rather than as a target: lines added plus lines removed ÷ the merged merge requests they were measured on, for merge requests **the platform** made (PROGRESS backlog 179). The counts are read from the provider once, when the merge request merges (GitLab’s `diffStatsSummary`), and never taken from the merge event, which carries none on GitLab.',
    unit: 'count',
    aggregation: 'ratio',
    caveats: [
      'A merge request a human merged without a platform task is not measured: product/16’s table is about the platform’s own work, and each measurement is one provider read.',
      'Counted on the day the measurement was recorded, which follows the merge by one provider read. One measurement per merge — a repeated measurement of the same merge is not counted again — but a merge request reopened and merged twice is two merges.',
    ],
  },
  defect_escape: {
    label: 'Defect escape',
    definition:
      'product/16’s “bugs filed against agent-merged MRs within 30 days ÷ merged MRs”, tracked with no target: bug tickets filed in the period whose own link names a merge request the platform delivered in the 30 days before the bug was filed ÷ tasks delivered in the period (PROGRESS backlog 114, Q87). A bug ticket is one whose issue type the project routes to the `bug` template. The merge request is found **only** through a link on the bug ticket — never by its title, never by timing: a merge followed by a bug has no join key. The two sides are counted at different instants, the filing and the merge, as the merge rate’s are.',
    unit: 'ratio',
    aggregation: 'ratio',
  },
  queue_wait_minutes: {
    label: 'Queue wait',
    definition:
      'product/16: “agent utilisation: parallel runs vs limit; queue wait time” — how long a task waited between being queued and being picked up.',
    unit: 'minutes',
    aggregation: 'mean',
    absent: {
      reason:
        '`task.dequeued` is declared unconsumed and nothing projects it, so the closing instant of the wait is in the event log and in no row. A fold of `task.queued` against `task.dequeued` at read time is possible — WP-61 reads the log that way for four metrics — and nobody has built it.',
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
  const owner =
    'Q87 decided the rule; the share of real bug tickets that carry a resolvable link is `docs/TODO.md`’s open measurement, and a team that links its bug tickets to the merge request they came from raises it.';
  if (bugs === 0) {
    return {
      absent: {
        reason:
          'No bug ticket was traced in the period, so the share of bugs that could be attributed to a merge request — which this rate is only ever published with (Q87) — cannot be computed. “No bug was filed” and “no bug reached the platform” look the same from here.',
        owner,
      },
    };
  }
  const share = linked / bugs;
  const coverage = `${linked} of ${bugs} bug tickets filed in the period (${percent(share)}) carried a merge-request link the platform could resolve`;
  if (share < DEFECT_COVERAGE_FLOOR) {
    return {
      absent: {
        reason: `Coverage below the floor: ${coverage}, and the rate is published only when at least half did — below that, the bugs it cannot see outnumber the ones it can, and the number would describe what is missing (Q87, WP-61).`,
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
          `Withheld in this period: ${withheld.entries} review window${withheld.entries === 1 ? '' : 's'} an approval touched, ${publishable(withheld.minutes)} minutes (PROGRESS backlog 188).`,
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

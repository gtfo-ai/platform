/**
 * The rows `GET /api/org/stats` is folded from (WP-41, product/19 §10).
 *
 * Fourteen reads and no arithmetic worth the name: every ratio, mean and stated absence is
 * `./stats-metrics.ts`, which needs no database to reach. The split is `human-time-summary.ts`'s
 * and is what lets the definitions be asserted in the unit tier and the SQL in the integration one.
 *
 * ## Two read a projection this build writes, five read the event log, the rest read rows that existed
 *
 * `stats_task_delivery` and `stats_event_daily` (migration 0034) are the statistics projector's,
 * and they hold the two kinds of fact whose only other record was an event. Everything else is read
 * where it lives — `tasks`, `task_stages`, `questions`, `human_time_entries`, `cost_rollup_daily`,
 * `cost_entries`, `kb_proposals`, and since WP-57 `run_context_pack` joined to `artifacts` —
 * because a rollup that copied those would be a second number to keep in step with the first
 * (standing rule 41).
 *
 * **Five read `events` directly** (WP-61), and each is a question a counter folded from one event
 * at a time cannot answer, because it compares two events: distinct conflict overlaps (the same
 * pair warned at two gate entries is one overlap, PROGRESS backlog 180), a lint followed by an edit
 * within 48 h (backlog 186), a bug traced to a merge that was delivered within the thirty days
 * before it (backlog 114), the first measurement of each merge (backlog 179), and the approvals
 * that touched a review window (backlog 188).
 *
 * **What bounds each, read per statement rather than claimed for all** (review round 1, backlog
 * 194). Every one is limited to one event type by `events_type_occurred_at_idx`. Beyond that: the
 * lint fold and the merge measurements carry a sargable instant window both ways
 * ({@link eventInstantWindow}) — measured on the lint read, whose plan went from an `Append` over
 * every partition with `type` as the only index condition to one partition with `occurred_at` in
 * the index condition (PROGRESS, WP-61 round 2); the defect trace has a lower bound only (a trace
 * may land after the range ends); **the overlaps read has an upper bound only and scans the type's
 * history before it**, because "first warned" needs every earlier warning; and the approval and
 * edit sub-reads are correlated on the outer row's instants, which bound the index. None has a
 * projection's constant cost; a type with millions of rows would want one.
 *
 * ## The day is cut in the database, in the organisation's zone
 *
 * `(ts at time zone $tz)::date` is the same calendar `rollupDay` gives the projector and
 * `budgetWindowStart` gives the budgets (Q12, BD-010, standing rule 9). Doing it in SQL rather than
 * in TypeScript keeps a row's bucket out of the driver's `Date` parsing entirely — the defect
 * `TaskCursor` records, where `timestamptz` microseconds met JavaScript milliseconds.
 *
 * ## It refuses rather than truncates
 *
 * Every per-task read is bounded ({@link MAX_TASK_ROWS}) and a range that would exceed the bound is
 * **refused by name** rather than served short. A truncated total is indistinguishable from a real
 * one on a screen, and the whole point of this endpoint is that its numbers can be believed — so
 * the failure is a typed 409 telling the caller to narrow the range (the shape
 * `queries/pipeline-queries.ts` established for a projection that cannot answer honestly).
 */
import { resolveBudgetTimezone } from '@platform/application';
import { db as dbAdapters } from '@platform/infrastructure';
import { sql } from 'drizzle-orm';
import type {
  BugTraceRow,
  CostDayRow,
  CounterRow,
  DeliveredTaskRow,
  EstimatedSpendRow,
  HumanMinutesRow,
  KbProposalRow,
  KbUsageRow,
  LintEditRow,
  LocRow,
  OverlapRow,
  QuestionRow,
  ResolvedRange,
  StartedTaskRow,
  StatsSources,
  WithheldReviewMinutes,
} from './stats-metrics.js';
import {
  DEFECT_ESCAPE_WINDOW_DAYS,
  LINT_EDIT_WINDOW_HOURS,
  LINT_IMPROVEMENT_FIELDS,
} from './stats-metrics.js';

const { organizations } = dbAdapters.schema;

export type Database = dbAdapters.Database;

/**
 * The most delivered — or started — tasks one answer may be folded from.
 *
 * 5 000 is two orders of magnitude past what a self-hosted instance delivers in a year at
 * product/19's own dogfood volumes, and it is a bound on **memory**, not a quota: the per-task rows
 * are the only unbounded input here.
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

/** The organisation's zone, with `resolveBudgetTimezone`'s verdict rather than the raw column. */
export const findOrganisationTimezone = async (
  database: Database,
): Promise<{ readonly timezone: string; readonly substituted: boolean }> => {
  const rows = await database
    .select({ timezone: organizations.timezone })
    .from(organizations)
    .limit(1);
  return resolveBudgetTimezone(rows[0]?.timezone ?? null);
};

interface RangeBounds {
  /** Inclusive first civil day. */
  readonly from: string;
  /** **Exclusive** upper bound, the day after `range.to` — so "today" is whole. */
  readonly until: string;
  readonly timezone: string;
  readonly projectId: string | null;
  /**
   * The instant the answer is computed at — the route's clock, injected so a test can pin it. Only
   * the lint fold reads it: a lint whose 48 h have not yet run out is in neither side (see there).
   */
  readonly asOf: string;
}

const boundsOf = (
  range: ResolvedRange,
  timezone: string,
  projectId: string | null,
  asOf: string,
): RangeBounds => {
  const [year, month, day] = range.to.split('-').map(Number);
  const until = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) + 1))
    .toISOString()
    .slice(0, 10);
  return { from: range.from, until, timezone, projectId, asOf };
};

/**
 * The **instant** bounds of a range, widened by a day on each side, as constants on the column —
 * the sargable half of every read of the event log (WP-61 review round 1).
 *
 * A filter written as an expression on `occurred_at` — `(occurred_at at time zone $tz)::date`, or
 * `occurred_at + interval <= $asOf` — can neither prune `events`' monthly partitions nor bound the
 * `(type, occurred_at)` index, so the read scans the type's whole history (measured: the plan before
 * this line appended every partition and the index condition was `type` alone). The civil-day filter
 * stays beside this one and decides the bucket exactly; this one only says where to look, and a day
 * of margin each side covers every UTC offset (±14 h).
 */
const eventInstantWindow = (column: string, bounds: RangeBounds) => sql`
  ${sql.raw(column)} >= ((${bounds.from}::date - 1)::timestamp at time zone 'UTC')
  and ${sql.raw(column)} < ((${bounds.until}::date + 1)::timestamp at time zone 'UTC')
`;

/**
 * `human_time_entries h` was written for an account an operator has **since** declared a machine
 * (WP-61, PROGRESS backlog 88).
 *
 * The projector refuses a declared machine's activity from the day it is declared; this is the
 * other half, for the rows it wrote **before** — the `handler_executions` claim makes a replay a
 * no-op for those events, so they would otherwise stay in every figure for the whole range. Matched
 * on the account key the projector stores (`"<provider>:<external id>"`, `externalAuthorKey`).
 */
const MACHINE_AUTHORED = sql`exists (
  select 1 from user_identities ui
   where ui.kind = 'machine'
     and h.external_author = ui.provider || ':' || ui.external_id
)`;

/**
 * A **review** window an `mr.approved` touched — withheld from the published reviewer minutes
 * until `docs/TODO.md`'s real-GitLab check of the approval `user` is taken (PROGRESS backlog 188).
 *
 * The projector folds an approval into the approver's window (WP-60), so a window's minutes cannot
 * be split into "from comments" and "from the approval"; what can be said is whether an approval
 * by the window's account, in the window's project, landed inside its span — and every such window
 * is withheld **whole**. Deliberately not narrowed to the task's merge request: the task's
 * `mr_ref` can name a later merge request than the one the approval was on (a rework), and
 * matching on it would **publish** a window this rule exists to withhold. The residual runs the
 * safe way: a window is withheld when its reviewer approved some other merge request of the project
 * during it — an under-count, stated in the metric.
 */
const APPROVAL_TOUCHED = sql`(h.kind = 'review' and exists (
  select 1 from events e
   where e.type = 'mr.approved'
     and e.occurred_at >= h.started_at
     and e.occurred_at <= coalesce(h.ended_at, h.started_at)
     and e.payload ->> 'project_id' = t.project_id::text
     and (e.payload -> 'approver' ->> 'provider') || ':' || (e.payload -> 'approver' ->> 'external_id')
         = h.external_author
))`;

/**
 * `where` on a civil-day column derived from a `timestamptz`, plus the optional project filter.
 *
 * The comparison is on the **civil date** in the organisation's zone rather than on the instant, so
 * a row lands in exactly the bucket the fold will put it in. Comparing instants would put an event
 * from 23:30 on the last day of the range outside it in a zone ahead of UTC, and inside it in one
 * behind — which is a range that means something different per organisation.
 */
const dayFilter = (column: string, bounds: RangeBounds, projectColumn = 'project_id') => sql`
  (${sql.raw(column)} at time zone ${bounds.timezone})::date >= ${bounds.from}::date
  and (${sql.raw(column)} at time zone ${bounds.timezone})::date < ${bounds.until}::date
  ${bounds.projectId === null ? sql`` : sql`and ${sql.raw(projectColumn)} = ${bounds.projectId}::uuid`}
`;

const civilDay = (column: string, bounds: RangeBounds) =>
  sql`to_char((${sql.raw(column)} at time zone ${bounds.timezone})::date, 'YYYY-MM-DD')`;

const number = (value: unknown): number =>
  value === null || value === undefined ? 0 : Number(value);

/**
 * Tasks started in the range, and whether a human had to do anything about each.
 *
 * **The template filter is the honest half of the merge rate.** `tasks.mode` separates a shadow
 * task; it does not separate a *discovery*, review-only, ticket-lint, history-bootstrap or
 * epic-split task, all of which are `mode = 'normal'` and none of which can ever open a merge
 * request. Counting them would make "merge rate" a statement about how many adoption features the
 * project has switched on. The predicate is the task's own `template_snapshot` — the pipeline as it
 * was when the task started — asking whether its stages contain a `merged_gate`, which is precisely
 * "delivers a merge request"; a task with no snapshot (a row written before WP-15) falls back to
 * the three shipped ticket templates by name. A project's **own** template is therefore counted on
 * what it does rather than on what it is called, which a list of shipped ids could not do.
 */
const startedTasks = async (
  database: Database,
  bounds: RangeBounds,
): Promise<readonly StartedTaskRow[]> => {
  const { rows } = await database.execute<{ started_day: string; intervened: boolean }>(sql`
    select ${civilDay('t.created_at', bounds)} as started_day,
           (
             exists (select 1 from questions q where q.task_id = t.id and q.answered_at is not null)
             or exists (select 1 from approvals a where a.task_id = t.id and a.decided_at is not null)
             or exists (select 1 from task_stages s where s.task_id = t.id and s.outcome = 'returned')
             or t.state = 'needs_human'
           ) as intervened
      from tasks t
     where t.mode = 'normal'
       and (
         (t.template_snapshot is not null
           and t.template_snapshot -> 'stages' @> '[{"id": "merged_gate"}]'::jsonb)
         or (t.template_snapshot is null and t.template in ('feature', 'bug', 'chore'))
       )
       and ${dayFilter('t.created_at', bounds, 't.project_id')}
     limit ${MAX_TASK_ROWS + 1}
  `);
  if (rows.length > MAX_TASK_ROWS) {
    throw new StatsRangeTooLargeError('started', MAX_TASK_ROWS);
  }
  return rows.map((row) => ({ startedDay: row.started_day, intervened: row.intervened === true }));
};

/**
 * One row per task delivered in the range, with everything the per-task metrics ask of it.
 *
 * Four correlated sub-reads rather than four joins, deliberately: a join over `task_stages`,
 * `questions`, `human_time_entries` and `cost_entries` at once multiplies the rows and makes every
 * sum wrong in a way that looks plausible (the classic fan-out). Each sub-read answers one question
 * about one task.
 */
const deliveredTasks = async (
  database: Database,
  bounds: RangeBounds,
): Promise<readonly DeliveredTaskRow[]> => {
  const { rows } = await database.execute<{
    merged_day: string;
    cycle_hours: string | number;
    agent_hours: string | number | null;
    returns: string | number;
    human_review_entries: string | number;
    questions: string | number;
    cost_usd: string | number | null;
    estimate_usd: string | null;
    cost_actual: string | null;
  }>(sql`
    select ${civilDay('d.merged_at', bounds)} as merged_day,
           greatest(extract(epoch from (d.merged_at - t.created_at)) / 3600.0, 0) as cycle_hours,
           (select coalesce(sum(extract(epoch from (r.ended_at - r.started_at))) / 3600.0, 0)
              from runs r
             where r.task_id = t.id and r.started_at is not null and r.ended_at is not null)
             as agent_hours,
           (select count(*) from task_stages s where s.task_id = t.id and s.outcome = 'returned')
             as returns,
           (select count(*) from human_time_entries h
             where h.task_id = t.id and h.kind = 'review'
               and not ${MACHINE_AUTHORED}) as human_review_entries,
           (select count(*) from questions q where q.task_id = t.id) as questions,
           (select coalesce(sum(c.usd), 0) from cost_entries c where c.task_id = t.id) as cost_usd,
           t.estimate_usd,
           t.cost_actual
      from stats_task_delivery d
      join tasks t on t.id = d.task_id
     where t.mode = 'normal'
       and ${dayFilter('d.merged_at', bounds, 'd.project_id')}
     limit ${MAX_TASK_ROWS + 1}
  `);
  if (rows.length > MAX_TASK_ROWS) {
    throw new StatsRangeTooLargeError('delivered', MAX_TASK_ROWS);
  }
  return rows.map((row) => ({
    mergedDay: row.merged_day,
    cycleHours: number(row.cycle_hours),
    agentHours: number(row.agent_hours),
    returns: number(row.returns),
    humanReviewEntries: number(row.human_review_entries),
    questions: number(row.questions),
    costUsd: number(row.cost_usd),
    estimateUsd: row.estimate_usd === null ? null : Number(row.estimate_usd),
    costActual: number(row.cost_actual),
  }));
};

/** The projector's counters, already keyed by civil day in this organisation's zone. */
const counters = async (
  database: Database,
  bounds: RangeBounds,
): Promise<readonly CounterRow[]> => {
  const { rows } = await database.execute<{
    day: string;
    metric: string;
    count: string | number;
    total: string | number;
  }>(sql`
    select to_char(day, 'YYYY-MM-DD') as day, metric, sum(count) as count, sum(total) as total
      from stats_event_daily
     where day >= ${bounds.from}::date and day < ${bounds.until}::date
       ${bounds.projectId === null ? sql`` : sql`and project_id = ${bounds.projectId}::uuid`}
     group by day, metric
  `);
  return rows.map((row) => ({
    day: row.day,
    metric: row.metric,
    count: number(row.count),
    total: number(row.total),
  }));
};

/** WP-19's rollup, which is already per civil day and per project. */
const costByDay = async (
  database: Database,
  bounds: RangeBounds,
): Promise<readonly CostDayRow[]> => {
  const { rows } = await database.execute<{
    day: string;
    usd: string | number;
    input_tokens: string | number;
    cache_read: string | number;
  }>(sql`
    select to_char(day, 'YYYY-MM-DD') as day,
           sum(usd) as usd,
           sum(input_tokens) as input_tokens,
           sum(cache_read) as cache_read
      from cost_rollup_daily
     where day >= ${bounds.from}::date and day < ${bounds.until}::date
       ${bounds.projectId === null ? sql`` : sql`and project_id = ${bounds.projectId}::uuid`}
     group by day
  `);
  return rows.map((row) => ({
    day: row.day,
    usd: number(row.usd),
    inputTokens: number(row.input_tokens),
    cacheReadTokens: number(row.cache_read),
  }));
};

/**
 * PROGRESS backlog **75**'s projection, and the only one this work package adds to the cost side.
 *
 * That entry recommends *"`sum(usd) where is_estimate` over `cost_entries`, no fourth stored
 * number"*, and this is it. `tasks.cost_estimated` is not read here and **no longer exists**:
 * WP-47 took the entry's recommendation one table across and dropped the column (migration 0035),
 * because a `not null default 0` with no writer published `$0.00` of estimated spend as a
 * measurement. The task DTO's `cost_estimated_usd` is now the same projection this one is, scoped
 * to a task rather than to a day.
 */
const estimatedSpend = async (
  database: Database,
  bounds: RangeBounds,
): Promise<readonly EstimatedSpendRow[]> => {
  const { rows } = await database.execute<{
    day: string;
    usd: string | number;
    estimated_usd: string | number;
  }>(sql`
    select ${civilDay('c.created_at', bounds)} as day,
           sum(c.usd) as usd,
           sum(case when c.is_estimate then c.usd else 0 end) as estimated_usd
      from cost_entries c
     where ${dayFilter('c.created_at', bounds, 'c.project_id')}
     group by 1
  `);
  return rows.map((row) => ({
    day: row.day,
    usd: number(row.usd),
    estimatedUsd: number(row.estimated_usd),
  }));
};

/** Questions **answered** in the range, and how long each waited. */
const questionLatency = async (
  database: Database,
  bounds: RangeBounds,
): Promise<readonly QuestionRow[]> => {
  const { rows } = await database.execute<{ answered_day: string; minutes: string | number }>(sql`
    select ${civilDay('q.answered_at', bounds)} as answered_day,
           greatest(extract(epoch from (q.answered_at - q.asked_at)) / 60.0, 0) as minutes
      from questions q
      join tasks t on t.id = q.task_id
     where q.answered_at is not null
       and ${dayFilter('q.answered_at', bounds, 't.project_id')}
  `);
  return rows.map((row) => ({
    answeredDay: row.answered_day,
    minutes: number(row.minutes),
  }));
};

/**
 * Human minutes per civil day and kind, and the review minutes withheld from them.
 *
 * **No second cap.** product/19 §16's eight hours per calendar day are applied **per review
 * window** (per entry) by the projector, and that is the definition this figure publishes (WP-61
 * criterion 3, PROGRESS backlog 89): one person can be credited more than eight hours in a day in
 * the sum — two tasks, or one task in two windows a gap over 2 h apart — and the metric says so. WP-41 had applied a second cap here, over
 * `(user or account, day, kind)`; it was removed rather than kept beside the per-entry reading,
 * because two caps under one definition made the figure answer neither.
 *
 * Two exclusions, both stated in the metric: rows written for an account since declared a machine
 * ({@link MACHINE_AUTHORED}) are **dropped** — they are not human time at all — and review windows
 * an approval touched ({@link APPROVAL_TOUCHED}) are **withheld**: kept out of `minutes` and summed
 * separately, so the metric can say how much it is not publishing and why.
 */
const humanMinutes = async (
  database: Database,
  bounds: RangeBounds,
): Promise<{
  readonly rows: readonly HumanMinutesRow[];
  readonly withheld: WithheldReviewMinutes;
}> => {
  const { rows } = await database.execute<{
    day: string;
    kind: string;
    minutes: string | number | null;
    withheld_minutes: string | number | null;
    withheld_entries: string | number;
  }>(sql`
    select day, kind,
           sum(minutes) filter (where not withheld) as minutes,
           sum(minutes) filter (where withheld) as withheld_minutes,
           count(*) filter (where withheld) as withheld_entries
      from (
        select ${civilDay('h.started_at', bounds)} as day,
               h.kind as kind,
               coalesce(h.minutes, 0) as minutes,
               ${APPROVAL_TOUCHED} as withheld
          from human_time_entries h
          join tasks t on t.id = h.task_id
         where ${dayFilter('h.started_at', bounds, 't.project_id')}
           and not ${MACHINE_AUTHORED}
      ) entries
     group by day, kind
  `);
  let withheldMinutes = 0;
  let withheldEntries = 0;
  const published: HumanMinutesRow[] = [];
  for (const row of rows) {
    withheldMinutes += number(row.withheld_minutes);
    withheldEntries += number(row.withheld_entries);
    published.push({ day: row.day, kind: row.kind, minutes: number(row.minutes) });
  }
  return { rows: published, withheld: { minutes: withheldMinutes, entries: withheldEntries } };
};

/**
 * product/16's *"concurrent-task overlaps"* as **distinct overlaps**, not comparisons (WP-61,
 * PROGRESS backlog 180).
 *
 * `task.conflict.warned` is appended at every gate entry that re-finds an overlap, and since WP-59
 * for both orders of the pair, so the counter the projector keeps counts **comparisons** — a pair
 * waiting through five default-branch moves counted ten. An overlap is one **unordered pair of
 * tasks at one pair of revisions**: the two events one comparison appends share its cause event, so
 * they are grouped on `(cause, lower task id, higher task id)` to recover both sides' head shas, and
 * the overlap is the distinct `(lower, higher, lower's head, higher's head)`. The same pair at the
 * same revisions compared again is the same overlap; a push to either side is a new one — the
 * refiner's `(task, other, head sha)`, taken from both sides. It is counted on the day it was
 * **first** warned, so it is in exactly one bucket, and one first warned before the range is not in
 * it. A comparison whose peer got no event (the peer had finished, or had no merge request) has a
 * `null` on that side, and repeats of it still collapse onto one.
 */
const overlaps = async (
  database: Database,
  bounds: RangeBounds,
): Promise<readonly OverlapRow[]> => {
  const { rows } = await database.execute<{ day: string; count: string | number }>(sql`
    with sides as (
      select e.cause_event_id as cause,
             least(e.payload ->> 'task_id', e.payload ->> 'other_task_id') as lo,
             greatest(e.payload ->> 'task_id', e.payload ->> 'other_task_id') as hi,
             case when e.payload ->> 'task_id' < e.payload ->> 'other_task_id'
                  then e.payload -> 'mr' ->> 'head_sha' end as head_lo,
             case when e.payload ->> 'task_id' > e.payload ->> 'other_task_id'
                  then e.payload -> 'mr' ->> 'head_sha' end as head_hi,
             e.occurred_at
        from events e
       where e.type = 'task.conflict.warned'
         -- An **upper** bound only, and deliberately: an overlap is counted on the day it was
         -- *first* warned, so whether a warning inside the range is a first one needs every earlier
         -- warning of the pair — the full lookback, which no lower bound may cut. Nothing after
         -- the range can make a key's first warning earlier, so the upper bound is exact.
         and e.occurred_at < ((${bounds.until}::date + 1)::timestamp at time zone 'UTC')
         ${bounds.projectId === null ? sql`` : sql`and e.payload ->> 'project_id' = ${bounds.projectId}`}
    ),
    comparisons as (
      select lo, hi, max(head_lo) as head_lo, max(head_hi) as head_hi, min(occurred_at) as at
        from sides
       group by cause, lo, hi
    ),
    distinct_overlaps as (
      select min(at) as first_at
        from comparisons
       group by lo, hi, head_lo, head_hi
    )
    select ${civilDay('first_at', bounds)} as day, count(*) as count
      from distinct_overlaps
     where (first_at at time zone ${bounds.timezone})::date >= ${bounds.from}::date
       and (first_at at time zone ${bounds.timezone})::date < ${bounds.until}::date
     group by 1
  `);
  return rows.map((row) => ({ day: row.day, count: number(row.count) }));
};

/**
 * product/16's lines changed per merged merge request, from `task.mr.measured` (WP-61, PROGRESS
 * backlog 179).
 *
 * **The first measurement per cause event** — the `mr.merged` the `merge_measure` job was woken by —
 * so a job redelivered after its append committed (a crash before the ack, an expiry mid-read)
 * appends a second event and is still one merge here. That is why this is a read and not a counter
 * the statistics projector folds: an additive counter cannot tell a second measurement of one merge
 * from a second merge. A merge request reopened and merged again has a second `mr.merged`, and is
 * two merges. `diff_stats: null` is counted as **unmeasured**, never as zero lines.
 *
 * Bounded both ways by {@link eventInstantWindow}: a redelivery follows its first append by the
 * job's retry delay, far inside the day of margin, so the window cannot split a pair.
 */
const locMeasures = async (database: Database, bounds: RangeBounds): Promise<readonly LocRow[]> => {
  const { rows } = await database.execute<{
    day: string;
    measured: string | number;
    lines: string | number | null;
    unmeasured: string | number;
  }>(sql`
    with firsts as (
      select distinct on (coalesce(e.cause_event_id, e.id))
             e.occurred_at,
             e.payload ->> 'project_id' as project_id,
             e.payload -> 'diff_stats' as stats
        from events e
       where e.type = 'task.mr.measured'
         and ${eventInstantWindow('e.occurred_at', bounds)}
       order by coalesce(e.cause_event_id, e.id), e.occurred_at, e.position
    )
    select ${civilDay('m.occurred_at', bounds)} as day,
           count(*) filter (where jsonb_typeof(m.stats) = 'object') as measured,
           sum(case when jsonb_typeof(m.stats) = 'object'
                    then (m.stats ->> 'insertions')::bigint + (m.stats ->> 'deletions')::bigint
               end) as lines,
           count(*) filter (where jsonb_typeof(m.stats) is distinct from 'object') as unmeasured
      from firsts m
     where ${dayFilter('m.occurred_at', bounds, 'm.project_id::uuid')}
     group by 1
  `);
  return rows.map((row) => ({
    day: row.day,
    measured: number(row.measured),
    lines: number(row.lines),
    unmeasured: number(row.unmeasured),
  }));
};

/**
 * product/18:60's *"tickets improved after lint (edited within 48 h)"* — the fold of
 * `ticket.updated` over `task.lint.posted` (WP-61, PROGRESS backlog 186).
 *
 * A lint counts as **improved** when an update to the same ticket (project, provider and key)
 * arrived after it and within {@link LINT_EDIT_WINDOW_HOURS} hours, **named a field the lint is
 * about** — {@link LINT_IMPROVEMENT_FIELDS} in the provider's changelog — and, when the lint
 * recorded one, carried a provider `updated_at` later than the baseline the linter read. Three
 * filters, each with its reason:
 *
 *  - **the field filter** is what keeps the platform's own status-mapping transition — which the
 *    provider reports as an update authored by the binding's account — out of "improved", with a
 *    rank change, a sprint move and a watcher. An **editor** filter was the other option and is not
 *    available: `ticket.updated` carries no editor. So an edit of the summary or description by
 *    anyone counts, and a status move by anyone does not;
 *  - **the baseline** drops a delivery that arrives late for an edit made before the linter read
 *    the ticket;
 *  - **the window has to have closed**: a lint posted less than 48 h before the answer is computed
 *    is in **neither** side, because counting it as "not improved yet" would make the last two days
 *    of every chart fall.
 *
 * Bucketed by the lint's day. An update with no changelog (`changed_fields: []`) never counts — the
 * list is empty rather than invented, and "we do not know what changed" is not "the description".
 */
const lintEditsSql = (bounds: RangeBounds) => {
  const fields = sql.join(
    LINT_IMPROVEMENT_FIELDS.map((field) => sql`${field}`),
    sql`, `,
  );
  return sql`
    select ${civilDay('l.occurred_at', bounds)} as day,
           count(*) as linted,
           count(*) filter (where exists (
             select 1 from events u
              where u.type = 'ticket.updated'
                and u.occurred_at > l.occurred_at
                and u.occurred_at <= l.occurred_at + make_interval(hours => ${LINT_EDIT_WINDOW_HOURS}::int)
                and u.payload ->> 'project_id' = l.payload ->> 'project_id'
                and u.payload -> 'ticket' ->> 'provider' = l.payload -> 'ticket' ->> 'provider'
                and u.payload -> 'ticket' ->> 'key' = l.payload -> 'ticket' ->> 'key'
                and exists (
                  select 1 from jsonb_array_elements_text(u.payload -> 'changed_fields') as f(name)
                   where lower(f.name) in (${fields})
                )
                and (l.payload ->> 'ticket_updated_at' is null
                     or (u.payload ->> 'updated_at')::timestamptz
                        > (l.payload ->> 'ticket_updated_at')::timestamptz)
           )) as improved
      from events l
     where l.type = 'task.lint.posted'
       and ${eventInstantWindow('l.occurred_at', bounds)}
       and l.occurred_at <= ${bounds.asOf}::timestamptz - make_interval(hours => ${LINT_EDIT_WINDOW_HOURS}::int)
       and ${dayFilter('l.occurred_at', bounds, "(l.payload ->> 'project_id')::uuid")}
     group by 1
  `;
};

/**
 * The lint fold's statement for a range, exported so the integration tier can take its `EXPLAIN`
 * (WP-61 review round 1: whether the log read is bounded by the index and the partitions).
 */
export const lintEditsQuery = (
  range: ResolvedRange,
  options: { readonly timezone: string; readonly projectId: string | null; readonly asOf: string },
) => lintEditsSql(boundsOf(range, options.timezone, options.projectId, options.asOf));

const lintEdits = async (
  database: Database,
  bounds: RangeBounds,
): Promise<readonly LintEditRow[]> => {
  const { rows } = await database.execute<{
    day: string;
    linted: string | number;
    improved: string | number;
  }>(lintEditsSql(bounds));
  return rows.map((row) => ({
    day: row.day,
    linted: number(row.linted),
    improved: number(row.improved),
  }));
};

/**
 * product/16's defect escape, from `ticket.bug.traced` (WP-61, PROGRESS backlog 114, Q87).
 *
 * One row per civil day a bug was **filed** on: how many bug tickets the platform traced, how many
 * of those carried a merge-request link it could resolve (the coverage's numerator), and how many
 * resolved to a merge request **the platform delivered** within {@link DEFECT_ESCAPE_WINDOW_DAYS}
 * days before the bug was filed — a delivery being a `stats_task_delivery` row, the same instant
 * every delivery metric counts by, on a `mode = 'normal'` task.
 *
 * A ticket traced twice (a duplicate wake-up) is one bug: its **first** trace is the one read. The
 * thirty days are measured back from the trace's `filed_at` (the `ticket.created` instant) and
 * never forward, so the merge request that *fixes* a bug — merged after it was filed, and the one
 * a ticket most often links to — is never counted as the one it escaped from.
 */
const bugTraces = async (
  database: Database,
  bounds: RangeBounds,
): Promise<readonly BugTraceRow[]> => {
  const { rows } = await database.execute<{
    day: string;
    bugs: string | number;
    linked: string | number;
    escaped: string | number;
  }>(sql`
    with traces as (
      select distinct on (e.payload ->> 'project_id', e.payload -> 'ticket' ->> 'provider',
                          e.payload -> 'ticket' ->> 'key')
             (e.payload ->> 'filed_at')::timestamptz as filed_at,
             e.payload ->> 'project_id' as project_id,
             e.payload ->> 'outcome' as outcome,
             e.payload ->> 'task_id' as task_id
        from events e
       where e.type = 'ticket.bug.traced'
         -- A **lower** bound only: a trace is appended after the ticket.created it follows, so a
         -- bug filed in the range has its trace at or after the range's start. It may be appended
         -- after the range's end (a retried job, a range ending today), so no upper bound. The
         -- first-trace rule is unaffected: every duplicate of a bug in range is after its filing.
         and e.occurred_at >= ((${bounds.from}::date - 1)::timestamp at time zone 'UTC')
       order by e.payload ->> 'project_id', e.payload -> 'ticket' ->> 'provider',
                e.payload -> 'ticket' ->> 'key', e.occurred_at, e.position
    )
    select ${civilDay('tr.filed_at', bounds)} as day,
           count(*) as bugs,
           count(*) filter (where tr.outcome = 'linked') as linked,
           count(*) filter (where tr.outcome = 'linked' and exists (
             select 1 from stats_task_delivery d
               join tasks t on t.id = d.task_id
              where d.task_id::text = tr.task_id
                and t.mode = 'normal'
                and d.merged_at <= tr.filed_at
                and d.merged_at >= tr.filed_at - make_interval(days => ${DEFECT_ESCAPE_WINDOW_DAYS}::int)
           )) as escaped
      from traces tr
     where ${dayFilter('tr.filed_at', bounds, 'tr.project_id::uuid')}
     group by 1
  `);
  return rows.map((row) => ({
    day: row.day,
    bugs: number(row.bugs),
    linked: number(row.linked),
    escaped: number(row.escaped),
  }));
};

/** Knowledge proposals **decided** in the range (product/16's acceptance rate). */
const kbProposals = async (
  database: Database,
  bounds: RangeBounds,
): Promise<readonly KbProposalRow[]> => {
  const { rows } = await database.execute<{
    day: string;
    applied: string | number;
    rejected: string | number;
  }>(sql`
    select ${civilDay('p.decided_at', bounds)} as day,
           count(*) filter (where p.status = 'applied') as applied,
           count(*) filter (where p.status = 'rejected') as rejected
      from kb_proposals p
     where p.decided_at is not null
       and ${dayFilter('p.decided_at', bounds, 'p.project_id')}
     group by 1
  `);
  return rows.map((row) => ({
    day: row.day,
    applied: number(row.applied),
    rejected: number(row.rejected),
  }));
};

/**
 * The runs `kb_usage` is defined over, and which of them cited their pack (WP-57, PROGRESS backlog
 * 112). One join, no new signal: the run's **recorded** pack (`run_context_pack`, written since
 * migration 0041) against `kb_citations` on the artifact the run produced.
 *
 * The denominator is the catalogue's, word for word: a run that **started** in the range, whose pack
 * was recorded (`context_budget_tokens is not null` — a pre-0041 run is in neither side), that
 * admitted at least one tier-1 document (`validated`; a tier-1 row recorded `validated = false` was
 * never shown to the agent), and that produced one of the two artifact types carrying
 * `kb_citations`. A citation matches on the **exact** vault path — the `path` attribute of the
 * document's data block is that path — so a page reached through `kb_search` rather than the pack
 * counts as no citation, which is what product/16's sentence is about.
 *
 * `jsonb_typeof` guards the array read: both schemas require `kb_citations`, but an artifact row is
 * data written by a model through a validator this query cannot see, and a non-array there must be
 * "no citations" rather than an error that takes the whole statistics answer down.
 */
const kbUsage = async (database: Database, bounds: RangeBounds): Promise<readonly KbUsageRow[]> => {
  const { rows } = await database.execute<{
    day: string;
    eligible: string | number;
    cited: string | number;
  }>(sql`
    with eligible as (
      select r.id, r.started_at
        from runs r
       where r.context_budget_tokens is not null
         and r.started_at is not null
         and ${dayFilter('r.started_at', bounds, 'r.project_id')}
         and exists (select 1 from run_context_pack p
                      where p.run_id = r.id and p.tier = 1 and p.validated)
         and exists (select 1 from artifacts a
                      where a.produced_by_run_id = r.id
                        and a.type in ('RefinedSpec', 'ResearchReport'))
    )
    select ${civilDay('e.started_at', bounds)} as day,
           count(*) as eligible,
           count(*) filter (where exists (
             select 1
               from artifacts a
               cross join lateral jsonb_array_elements(
                 case when jsonb_typeof(a.data -> 'kb_citations') = 'array'
                      then a.data -> 'kb_citations' else '[]'::jsonb end) as c(citation)
               join run_context_pack p
                 on p.run_id = e.id and p.tier = 1 and p.validated
                and p.source_path = c.citation ->> 'path'
              where a.produced_by_run_id = e.id
                and a.type in ('RefinedSpec', 'ResearchReport')
           )) as cited
      from eligible e
     group by 1
  `);
  return rows.map((row) => ({
    day: row.day,
    eligible: number(row.eligible),
    cited: number(row.cited),
  }));
};

/**
 * product/19 §10's *"returns into stage ÷ stage entries"*, over the whole range rather than per
 * bucket: it is a comparison **between stages**, and a per-day series of it is nine sparse lines
 * nobody reads.
 */
/**
 * **`outcome`, not `state`.** Until WP-55 `task_stages.state` only ever held `entered` or `exited`,
 * and the return was recorded in `outcome` alone, so a predicate on `state = 'returned'` matched
 * nothing and published a return rate of exactly zero on every instance — the silent-zero this
 * whole endpoint is written against. Migration 0040 gave `state` the contracts' vocabulary and
 * rewrote every closed return to `state = 'returned'`, so the two predicates now agree; this one
 * stays on `outcome`, which every writer of a return has set since WP-15, and the integration tier
 * asserts it against real returns.
 */
const stageReturns = async (
  database: Database,
  bounds: RangeBounds,
): Promise<readonly { stage: string; entries: number; returns: number; rate: null }[]> => {
  const { rows } = await database.execute<{
    stage: string;
    entries: string | number;
    returns: string | number;
  }>(sql`
    select s.stage as stage,
           count(*) as entries,
           count(*) filter (where s.outcome = 'returned') as returns
      from task_stages s
      join tasks t on t.id = s.task_id
     where ${dayFilter('s.entered_at', bounds, 't.project_id')}
     group by s.stage
     order by s.stage
  `);
  return rows.map((row) => ({
    stage: row.stage,
    entries: number(row.entries),
    returns: number(row.returns),
    // The rate is computed by the fold, so the two directions of the same division cannot disagree.
    rate: null,
  }));
};

/**
 * Every row one answer is folded from, read in parallel.
 *
 * They are independent reads of independent tables and none of them is a write, so they are issued
 * together and the pool's own limit is what bounds them (`POOL_RESERVATIONS`). A statistics request
 * that serialised thirteen reads would hold a connection for their sum, which is the shape that makes
 * a dashboard tab feel like an outage on a busy instance.
 */
export const readStatsSources = async (
  database: Database,
  range: ResolvedRange,
  options: {
    readonly timezone: string;
    readonly projectId: string | null;
    /** The instant the answer is computed at (the lint fold's closed-window rule). */
    readonly asOf: string;
  },
): Promise<StatsSources> => {
  const bounds = boundsOf(range, options.timezone, options.projectId, options.asOf);
  const [
    started,
    delivered,
    counted,
    cost,
    estimated,
    questions,
    minutes,
    proposals,
    usage,
    stages,
    overlapRows,
    locRows,
    lintRows,
    bugRows,
  ] = await Promise.all([
    startedTasks(database, bounds),
    deliveredTasks(database, bounds),
    counters(database, bounds),
    costByDay(database, bounds),
    estimatedSpend(database, bounds),
    questionLatency(database, bounds),
    humanMinutes(database, bounds),
    kbProposals(database, bounds),
    kbUsage(database, bounds),
    stageReturns(database, bounds),
    overlaps(database, bounds),
    locMeasures(database, bounds),
    lintEdits(database, bounds),
    bugTraces(database, bounds),
  ]);
  return {
    startedTasks: started,
    deliveredTasks: delivered,
    counters: counted,
    cost,
    estimatedSpend: estimated,
    questions,
    humanMinutes: minutes.rows,
    withheldReviewMinutes: minutes.withheld,
    kbProposals: proposals,
    kbUsage: usage,
    stageReturns: stages,
    overlaps: overlapRows,
    loc: locRows,
    lintEdits: lintRows,
    bugTraces: bugRows,
  };
};

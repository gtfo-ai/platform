/**
 * The rows `GET /api/org/stats` is folded from (WP-41, product/19 §10).
 *
 * Eight reads and no arithmetic worth the name: every ratio, cap, mean and stated absence is
 * `./stats-metrics.ts`, which needs no database to reach. The split is `human-time-summary.ts`'s
 * and is what lets the definitions be asserted in the unit tier and the SQL in the integration one.
 *
 * ## Two of the eight read a projection this build writes; six read rows that already existed
 *
 * `stats_task_delivery` and `stats_event_daily` (migration 0034) are the statistics projector's,
 * and they hold the two kinds of fact whose only other record was an event. Everything else is read
 * where it lives — `tasks`, `task_stages`, `questions`, `human_time_entries`, `cost_rollup_daily`,
 * `cost_entries`, `kb_proposals` — because a rollup that copied those would be a second number to
 * keep in step with the first (standing rule 41).
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
  CostDayRow,
  CounterRow,
  DeliveredTaskRow,
  EstimatedSpendRow,
  HumanMinutesRow,
  KbProposalRow,
  QuestionRow,
  ResolvedRange,
  StartedTaskRow,
  StatsSources,
} from './stats-metrics.js';
import { REVIEWER_DAY_CAP_MINUTES } from './stats-metrics.js';

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
}

const boundsOf = (
  range: ResolvedRange,
  timezone: string,
  projectId: string | null,
): RangeBounds => {
  const [year, month, day] = range.to.split('-').map(Number);
  const until = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) + 1))
    .toISOString()
    .slice(0, 10);
  return { from: range.from, until, timezone, projectId };
};

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
             where h.task_id = t.id and h.kind = 'review') as human_review_entries,
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
 * Human minutes per civil day and kind — with PROGRESS backlog **89**'s cap applied **here**.
 *
 * The projector caps eight hours per calendar day *per entry*, which is stateless and replayable
 * and is not what *"capped at 8 h per calendar day"* means once a figure sums across tasks. So the
 * inner query groups by `(identity, day, kind)` and clamps, and the outer one sums the clamped
 * values. The identity is `coalesce(user_id::text, external_author)`: an unmapped reviewer has a
 * provider account to be capped by, which is what migration 0025's column exists for. An entry with
 * **neither** — which no producer writes — would collapse every such row onto one bucket, so it is
 * given its own key by `id` rather than being merged into a cap nobody owns.
 */
const humanMinutes = async (
  database: Database,
  bounds: RangeBounds,
): Promise<readonly HumanMinutesRow[]> => {
  const { rows } = await database.execute<{
    day: string;
    kind: string;
    minutes: string | number;
  }>(sql`
    select day, kind, sum(capped) as minutes
      from (
        select ${civilDay('h.started_at', bounds)} as day,
               h.kind as kind,
               least(sum(coalesce(h.minutes, 0)), ${REVIEWER_DAY_CAP_MINUTES}) as capped
          from human_time_entries h
          join tasks t on t.id = h.task_id
         where ${dayFilter('h.started_at', bounds, 't.project_id')}
         group by 1, 2, coalesce(h.user_id::text, h.external_author, h.id::text)
      ) capped_per_identity
     group by day, kind
  `);
  return rows.map((row) => ({
    day: row.day,
    kind: row.kind,
    minutes: number(row.minutes),
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
 * that serialised eight reads would hold a connection for their sum, which is the shape that makes
 * a dashboard tab feel like an outage on a busy instance.
 */
export const readStatsSources = async (
  database: Database,
  range: ResolvedRange,
  options: { readonly timezone: string; readonly projectId: string | null },
): Promise<StatsSources> => {
  const bounds = boundsOf(range, options.timezone, options.projectId);
  const [started, delivered, counted, cost, estimated, questions, minutes, proposals, stages] =
    await Promise.all([
      startedTasks(database, bounds),
      deliveredTasks(database, bounds),
      counters(database, bounds),
      costByDay(database, bounds),
      estimatedSpend(database, bounds),
      questionLatency(database, bounds),
      humanMinutes(database, bounds),
      kbProposals(database, bounds),
      stageReturns(database, bounds),
    ]);
  return {
    startedTasks: started,
    deliveredTasks: delivered,
    counters: counted,
    cost,
    estimatedSpend: estimated,
    questions,
    humanMinutes: minutes,
    kbProposals: proposals,
    stageReturns: stages,
  };
};

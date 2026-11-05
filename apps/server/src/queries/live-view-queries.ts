/**
 * What the live views need about a run that the run record does not say (S-23.15, TD-033
 * decisions 6 and 8): **who holds it** (its seat) and **what it is doing now** (its activity).
 * `listRunningAgents` (`pipeline-queries.ts`) asks both for the runs it lists, one query each for
 * the whole list — never one per run.
 *
 * ## The seat
 *
 * Read off the run's offer (`run_offers`, migration 0094): a **claimed** offer names its claimant
 * (`claimant_kind`), and a worker claimant its machine (`run_offers.worker_id`, else
 * `runs.worker_id`, migration 0096 — WP-281's claim writes both). `runs.worker_id` alone also
 * names a worker seat, because it is what revocation expires (`worker-queries.ts`). Everything
 * else is `null` — *not claimed yet*: an open offer, which is the queue the fleet map shows on its
 * side, and a run with no offer row at all, which only a run created before migration 0094 can be.
 * The latter is not guessed to be the server's, although the server was then the only claimant:
 * the screen would draw it at a seat on evidence the row does not hold.
 *
 * ## The activity, and why nothing it says comes from the entry's text
 *
 * The agents list is `run.read` (viewer) and carries no model output; the transcript is
 * `transcript.read`. So the newest entry is read **in SQL down to a handful of facts** — its kind,
 * the hook and its decision, the type of its last content block and that block's tool name cut to
 * 65 characters — and `payload` itself never leaves the database. {@link activityOfEntry} then
 * classifies those facts and admits a tool name only when it is an identifier
 * ({@link RUN_ACTIVITY_TOOL_NAME_MAX_CHARS} characters of `[A-Za-z0-9_:.-]`); anything else is
 * published as the literal `other`. A tool name is the model's choice, so it is untrusted (BD-022)
 * even bounded; the bound is what keeps it from being a channel for text.
 *
 * **The cost** ({@link newestEntryPerRun}): one `lateral` subquery per listed run, `where run_id =
 * … order by seq desc limit 1` — a backward probe of the primary key `(run_id, seq, created_at)`
 * in each partition, merged and stopped at the first row, never a sort of the run's transcript.
 * It is bounded below by the run's own `created_at` (less {@link RUN_CLOCK_SKEW_ALLOWANCE}), so the
 * partitions older than the run are pruned at run time.
 */
import type { RunActivity, RunSeat } from '@platform/contracts';
import { RUN_ACTIVITY_TOOL_NAME_MAX_CHARS, runActivityToolNameSchema } from '@platform/contracts';
import { db as dbAdapters } from '@platform/infrastructure';
import { eq, inArray, type SQL, sql } from 'drizzle-orm';

const { runOffers, runs, workers } = dbAdapters.schema;

type Database = dbAdapters.Database;

/** What {@link seatOf} reads: the run's offer (absent: no row) and the worker columns. */
export interface SeatFacts {
  readonly offerState: 'open' | 'claimed' | 'settled' | 'withdrawn' | null;
  readonly claimantKind: 'server' | 'worker' | null;
  readonly offerWorkerId: string | null;
  readonly runWorkerId: string | null;
  /** The name of the worker `offerWorkerId ?? runWorkerId` names, when its row exists. */
  readonly workerName: string | null;
}

/** The seat a run's facts license, or `null` (not claimed yet). Pure, for its unit test. */
export const seatOf = (facts: SeatFacts): RunSeat | null => {
  const workerId = facts.offerWorkerId ?? facts.runWorkerId;
  if (facts.offerState === 'claimed' && facts.claimantKind === 'server') {
    return { kind: 'server', worker_id: null, worker_name: null };
  }
  if (
    (facts.offerState === 'claimed' && facts.claimantKind === 'worker') ||
    facts.runWorkerId !== null
  ) {
    return {
      kind: 'worker',
      worker_id: workerId,
      worker_name: workerId === null ? null : facts.workerName,
    };
  }
  return null;
};

/** Each run's seat, in one query; a run with no seat is absent from the map. */
export const seatsFor = async (
  database: Database,
  runIds: readonly string[],
): Promise<Map<string, RunSeat>> => {
  const byRun = new Map<string, RunSeat>();
  if (runIds.length === 0) {
    return byRun;
  }
  const rows = await database
    .select({
      runId: runs.id,
      runWorkerId: runs.workerId,
      offerState: runOffers.state,
      claimantKind: runOffers.claimantKind,
      offerWorkerId: runOffers.workerId,
      workerName: workers.name,
    })
    .from(runs)
    .leftJoin(runOffers, eq(runOffers.runId, runs.id))
    .leftJoin(workers, eq(workers.id, sql`coalesce(${runOffers.workerId}, ${runs.workerId})`))
    .where(inArray(runs.id, [...runIds]));
  for (const row of rows) {
    const seat = seatOf({
      offerState: row.offerState,
      claimantKind: row.claimantKind,
      offerWorkerId: row.offerWorkerId,
      runWorkerId: row.runWorkerId,
      workerName: row.workerName,
    });
    if (seat !== null) {
      byRun.set(row.runId, seat);
    }
  }
  return byRun;
};

/** The facts SQL extracts from a run's newest transcript entry — never its text. */
export interface ActivityFacts {
  readonly kind: string;
  readonly at: Date;
  /** `run_messages.blob_id`: the payload is elsewhere, so only the columns are facts. */
  readonly blobbed: boolean;
  /** `run_messages.tool_name`, cut to 65 characters (a hook's, or a tool_use stream block's). */
  readonly columnToolName: string | null;
  /** A hook entry's `hook` and `decision`. */
  readonly hook: string | null;
  readonly decision: string | null;
  /** The type of the entry's block (a stream block) or of its last content block. */
  readonly blockType: string | null;
  /** That block's `tool_name`, cut to 65 characters. */
  readonly blockToolName: string | null;
}

/** A tool name the activity line may publish, or the literal `other`. */
export const boundedToolName = (name: string | null): string | null => {
  if (name === null) {
    return null;
  }
  return name.length <= RUN_ACTIVITY_TOOL_NAME_MAX_CHARS &&
    runActivityToolNameSchema.safeParse(name).success
    ? name
    : 'other';
};

/**
 * One entry's facts → the activity line. Pure, for its unit test.
 *
 *  - an assistant message or stream block whose (last) block is a `tool_use` → `tool`;
 *  - a `PreToolUse` hook that decided `ask` → `waiting_permission`, one that allowed the call →
 *    `tool` (the call is in flight; every other hook is `other`);
 *  - a `thinking` block → `thinking`, a `text` block → `text`;
 *  - a `progress` entry → `progress` (its summary is the run record's `latest_progress`, which is
 *    the same visibility as this list already);
 *  - anything else — a tool result, a system line, a steer, the result — → `other`.
 */
export const activityOfEntry = (facts: ActivityFacts): RunActivity => {
  const at = facts.at.toISOString();
  const line = (kind: RunActivity['kind'], toolName: string | null = null): RunActivity => ({
    kind,
    tool_name: boundedToolName(toolName),
    at,
  });
  if (facts.kind === 'progress') {
    return line('progress');
  }
  // A payload in `blobs` leaves a stub in the column: its JSON paths are not facts about the entry.
  if (facts.blobbed) {
    return line('other');
  }
  if (facts.kind === 'hook') {
    if (facts.hook !== 'PreToolUse') {
      return line('other');
    }
    if (facts.decision === 'ask') {
      return line('waiting_permission', facts.columnToolName);
    }
    return facts.decision === 'allow' ? line('tool', facts.columnToolName) : line('other');
  }
  if (facts.kind !== 'assistant' && facts.kind !== 'stream_block') {
    return line('other');
  }
  switch (facts.blockType) {
    case 'tool_use':
      return line('tool', facts.blockToolName ?? facts.columnToolName);
    case 'thinking':
      return line('thinking');
    case 'text':
      return line('text');
    default:
      return line('other');
  }
};

/**
 * How far before its run's `created_at` a transcript entry may be stamped and still be read.
 *
 * `runs.created_at` is the database's clock; an entry's `created_at` is the producer's — the
 * runner's, or a remote worker's (S-22.x) — so a strict bound would drop the newest entry of a run
 * whose producer's clock is behind. A day keeps the bound a partition pruner (the partitions are
 * monthly) without trusting two clocks to agree to the second.
 */
export const RUN_CLOCK_SKEW_ALLOWANCE = '1 day';

/**
 * Each listed run's newest `run_messages` row (optionally its newest `progress` row) with
 * `columns` read off it as `m`: one `lateral` probe per run, ordered by `seq` and stopped at the
 * first row. A run with no such row is absent from the answer. The ids are bound one parameter
 * each; `columns` is SQL this module writes, never caller text.
 */
export const newestEntryPerRun = (
  runIds: readonly string[],
  columns: SQL,
  options: { readonly progressOnly?: boolean } = {},
): SQL => sql`
  select r.id as run_id, e.*
    from unnest(array[${sql.join(
      runIds.map((id) => sql`${id}`),
      sql`, `,
    )}]::uuid[]) as listed(id)
    join runs r on r.id = listed.id
    cross join lateral (
      select m.seq, m.created_at, ${columns}
        from run_messages m
       where m.run_id = r.id
         and m.created_at >= r.created_at - ${sql.raw(`interval '${RUN_CLOCK_SKEW_ALLOWANCE}'`)}
         ${options.progressOnly === true ? sql`and m.kind = 'progress'` : sql``}
       order by m.seq desc
       limit 1
    ) e`;

const at = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));

/**
 * Each run's newest transcript entry → its activity, in one query. A run with no entry is absent
 * from the map. The `payload` column is read only through the four JSON paths below.
 */
export const latestActivityFor = async (
  database: Database,
  runIds: readonly string[],
): Promise<Map<string, RunActivity>> => {
  const byRun = new Map<string, RunActivity>();
  if (runIds.length === 0) {
    return byRun;
  }
  const block = sql`coalesce(m.payload -> 'block', m.payload -> 'content' -> -1)`;
  const { rows } = await database.execute<{
    run_id: string;
    created_at: Date | string;
    kind: string;
    blob_id: string | null;
    column_tool_name: string | null;
    hook: string | null;
    decision: string | null;
    block_type: string | null;
    block_tool_name: string | null;
  }>(
    newestEntryPerRun(
      runIds,
      sql`m.kind::text as kind, m.blob_id,
          left(m.tool_name, 65) as column_tool_name,
          m.payload ->> 'hook' as hook,
          m.payload ->> 'decision' as decision,
          left(${block} ->> 'type', 32) as block_type,
          left(${block} ->> 'tool_name', 65) as block_tool_name`,
    ),
  );
  for (const row of rows) {
    byRun.set(
      row.run_id,
      activityOfEntry({
        kind: row.kind,
        at: at(row.created_at),
        blobbed: row.blob_id !== null,
        columnToolName: row.column_tool_name,
        hook: row.hook,
        decision: row.decision,
        blockType: row.block_type,
        blockToolName: row.block_tool_name,
      }),
    );
  }
  return byRun;
};

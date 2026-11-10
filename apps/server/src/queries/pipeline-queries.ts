/**
 * The reads behind `GET /api/tasks/:id`, the four `GET /api/runs/:id*` endpoints (WP-15h part 1)
 * and the three list projections part 2 added — `GET /api/org/agents`, `GET /api/org/inbox` and
 * `GET /api/projects/:id/tasks`. They are here rather than in a file of their own because they
 * project the same tables through the same mappers: an agent *is* a run, an inbox entry *is* a
 * question or an approval, and a task page *is* `toTaskRecord` over a keyset. The project and
 * integration projections have their own modules, because they touch neither.
 *
 * These are **projections onto the published DTOs**, not repository methods: every function here
 * returns the exact shape `@platform/contracts` publishes for a route, and the route's zod response
 * schema re-validates it on the way out. That is deliberate — `packages/application`'s
 * `PipelineStore` exists to *run* the pipeline and its `StoredRun`/`StoredTask` are the shapes the
 * sagas need, which are not the shapes technical/08 publishes (no `provider_mode`, no
 * `model_usage`, no `redaction_count`, no stage rows, no questions). Reusing it would mean either
 * widening the write-side port with fields no writer uses, or mapping twice. `apps/server` is a
 * composition root and may name Drizzle directly (see `identity-queries.ts`), so the projections
 * live here until there is a read-model package to move them into.
 *
 * ## A column that is never written is refused, never defaulted
 *
 * Three of the four run reads were written against columns nothing fills, and the honest answer
 * differs per column, so each one is stated rather than smoothed over:
 *
 *  - **`runs.system_prompt` / `runs.user_prompt`** — **written since WP-52** (Q64, migration 0038):
 *    both `runs.insert` call sites store the assembled prompt the run was started with, redacted at
 *    the write. The refusal stayed, and what it says narrowed from a statement about the *build* to
 *    a statement about the *row*: a run created before that migration has no prompt and never will,
 *    because the nonce is drawn per prompt and the pack is a point-in-time read, so `findRunPrompt`
 *    still reports `recorded: false` for it. Answering `{system_prompt: "", user_prompt: ""}` would
 *    render as "this run had no prompt", which is a claim about the agent rather than about the row.
 *  - **`run_context_pack`** — **written since WP-57** (PROGRESS backlog 31, migration 0041): both
 *    `runs.insert` call sites store the planner's record as rows, with the pack's header
 *    (`budget_tokens`, `total_tokens`, `kb_commit`) on the run row. Until then no insert existed
 *    and the table could not have held the record, so `findRunContextPack` had no success branch at
 *    all. The refusal stayed for a run whose header is null — every run created before that
 *    migration — and it carries the row count, so "never recorded" and "rows written outside the
 *    writer" stay distinguishable; an **empty** pack is served as one.
 *  - **`run_messages.blob_id`** — technical/03 says a payload over 1 MB goes to `blobs`; nothing
 *    writes one, so no reader has ever been exercised against a row where `payload` is a stub.
 *    A page containing such a row is refused rather than served from the `payload` column, whose
 *    contents in that case are undefined by the schema rather than known to be complete.
 *
 * ## And a row that cannot be projected is refused by name
 *
 * `RunRecord.stage` and `QuestionRecord.stage` are required in the published DTO and nullable in
 * the database. The run's stage is the join through `runs.task_stage_id`, which WP-15h is also the
 * work package that started writing — so a run stored before it, or a run created outside a stage,
 * has no stage and is reported as {@link UnprojectableRowError} rather than as a 500 whose cause
 * the client never sees.
 */

import {
  CI_GATE_STAGE,
  ciPendingReadSchema,
  NOTIFICATION_DETAIL_MAX,
  PLATFORM_TICKET_PROVIDER,
  TAKE_OVER_BOUNDARY_EVENTS,
  toGateWait,
} from '@platform/application';
import type {
  AgentsResponse,
  ArtifactBodyResponse,
  CiGateEnding,
  ContextPackRecord,
  GateWait,
  HumanTimeKind,
  HumanTimeSummary,
  Id,
  InboxResponse,
  IsoDateTime,
  JsonObject,
  PipelineTemplate,
  PromptsWithheldRecord,
  ProviderSync,
  QuestionRecord,
  QueueWait,
  RunCommandRecord,
  RunLatestProgress,
  RunModelUsageRecord,
  RunRecord,
  RunSavedWork,
  RunStartFailure,
  RunStatus,
  RunStoppedReason,
  TaskCancellation,
  TaskConflict,
  TaskConversationSeen,
  TaskDetailRecord,
  TaskDetailResponse,
  TaskEscalation,
  TaskListItem,
  TaskManualPause,
  TaskRecord,
  TaskStageOutcome,
  TaskStageState,
  TaskState,
  TicketAssignee,
  TranscriptEvent,
} from '@platform/contracts';
import {
  artifactBodyPath,
  ciGateEndingSchema,
  ciManualNotRunSchema,
  ciManualStartedSchema,
  contextPackRecordSchema,
  MAX_INBOX_ESCALATED,
  MAX_RUN_COMMANDS,
  MAX_TASK_CONVERSATION_SEEN,
  MAX_TASK_PAUSE_REASON_CHARS,
  MAX_TASK_STOP_RECORDED_CHARS,
  pausedBudgetFiguresSchema,
  pausedBudgetScopeSchema,
  promptsWithheldSchema,
  providerSyncSchema,
  runSavedWorkSchema,
  runStartFailureSchema,
  runStoppedReasonSchema,
  storedTicketClaimSchema,
  taskConversationSeenSchema,
  taskPipelineDialSchema,
  taskStageOutcomeSchema,
  taskStageStateSchema,
  ticketAssigneeSchema,
  transcriptEventSchema,
} from '@platform/contracts';
import {
  ACTIVE_RUN_STATUSES,
  type CompiledPipeline,
  compilePipeline,
  DEFAULT_TASK_BUDGET_USD,
  estimateAccuracy,
  handBackStages,
  ownerWriteBackReachesTracker,
  type RunImageDigests,
  resumeCommands,
  SHIPPED_TEMPLATES,
} from '@platform/domain';
import { db as dbAdapters, pipeline as pipelineAdapters } from '@platform/infrastructure';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
  notInArray,
  or,
  sql,
  sum,
} from 'drizzle-orm';
import { HttpError } from '../errors.js';
import {
  appliedTicketLifecycle,
  type TicketLifecycleBindingRow,
  ticketLifecycleBindingsQuery,
  ticketLifecycleOfRows,
} from '../ticket-lifecycle.js';
import { approvalViewsFor } from './approval-views.js';
import { APPROVAL_TOUCHED, MACHINE_AUTHORED } from './human-time-predicates.js';
import { perUserBreakdownEnabled, summariseHumanTime } from './human-time-summary.js';
import { latestActivityFor, newestEntryPerRun, seatsFor } from './live-view-queries.js';
import { waitingForRuns, waitingForTasks } from './offer-waiting.js';
import { frozenLimits } from './pipeline-graph.js';
import { queueWaitsFor, type WipLimitsReader } from './queue-wait.js';
import { returnsOf, type SetbackStageRow, stopOf } from './task-setback.js';

const {
  approvals,
  artifacts,
  costEntries,
  events,
  projects,
  questions,
  runContextPack,
  runMessages,
  runCommands,
  runModelUsage,
  runs,
  taskMergeChecks,
  taskProviderSync,
  taskStages,
  tasks,
} = dbAdapters.schema;

export type Database = dbAdapters.Database;

/**
 * A stored row the published DTO cannot describe.
 *
 * 409 rather than 500, and that is a decision with a reason: `toApiError` deliberately strips a
 * 5xx's message, so an operator looking at a broken screen would be told only "quote this request
 * id". The *identity* of a row is not its content — no ticket text, no model output and no
 * credential can be in a table name, a uuid or a column name — so naming them costs nothing a
 * 5xx protects and turns "something failed" into "run <id> has no stage".
 */
export class UnprojectableRowError extends HttpError {
  constructor(what: string, why: string) {
    super(409, 'row_not_projectable', `${what} cannot be returned: ${why}`);
    this.name = 'UnprojectableRowError';
  }
}

/** Postgres `numeric` arrives as a string; the DTOs publish numbers. */
const usd = (value: string | null): number => (value === null ? 0 : Number(value));

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

const isoRequired = (value: Date): string => value.toISOString();

interface RunProjectionRow {
  readonly id: string;
  readonly taskId: string;
  readonly projectId: string;
  readonly stage: string | null;
  readonly role: string;
  readonly mode: string;
  readonly attempt: number;
  readonly sessionId: string | null;
  readonly model: string;
  readonly effort: string;
  readonly providerMode: string;
  readonly promptVersion: string;
  readonly status: string;
  readonly terminalReason: string | null;
  readonly startedAt: Date | null;
  readonly endedAt: Date | null;
  readonly lastOutputAt: Date | null;
  readonly numTurns: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheWrite5mTokens: number;
  readonly cacheWrite1hTokens: number;
  readonly cacheReadTokens: number;
  readonly usdReported: string | null;
  /** Nullable since migration 0035 (WP-47): neither column set is "nobody measured this run". */
  readonly usdEstimated: string | null;
  readonly priceListId: string | null;
  readonly wallMs: number;
  readonly redactionCount: number;
  /** `runs.settings_hash`; null for a run created before WP-91 gave it a writer. */
  readonly settingsHash: string | null;
  /** `runs.exit_detail`; its first writer is a start failure (PROGRESS backlog 453). */
  readonly exitDetail: JsonObject | null;
  /** `runs.saved_work`; its writer is an unsuccessful run's export (PROGRESS backlog 467). */
  readonly savedWork: JsonObject | null;
}

const runColumns = {
  id: runs.id,
  taskId: runs.taskId,
  projectId: runs.projectId,
  stage: taskStages.stage,
  role: runs.role,
  mode: runs.mode,
  attempt: runs.attempt,
  sessionId: runs.sessionId,
  model: runs.model,
  effort: runs.effort,
  providerMode: runs.providerMode,
  promptVersion: runs.promptVersion,
  status: runs.status,
  terminalReason: runs.terminalReason,
  startedAt: runs.startedAt,
  endedAt: runs.endedAt,
  lastOutputAt: runs.lastOutputAt,
  numTurns: runs.numTurns,
  inputTokens: runs.inputTokens,
  outputTokens: runs.outputTokens,
  cacheWrite5mTokens: runs.cacheWrite5mTokens,
  cacheWrite1hTokens: runs.cacheWrite1hTokens,
  cacheReadTokens: runs.cacheReadTokens,
  usdReported: runs.usdReported,
  usdEstimated: runs.usdEstimated,
  priceListId: runs.priceListId,
  wallMs: runs.wallMs,
  redactionCount: runs.redactionCount,
  settingsHash: runs.settingsHash,
  exitDetail: runs.exitDetail,
  savedWork: runs.savedWork,
} as const;

/**
 * `runs.exit_detail` → `RunRecord.start_failure` (PROGRESS backlog 453).
 *
 * `null` is published for a column that is null — a run that started, or one that failed to start
 * before the column had a writer — and for a detail of another `kind`, which is not a start
 * failure. A `not_started` detail this release cannot read is **refused** by name rather than
 * published as `null`, which would say the run started.
 */
export const startFailureOf = (
  row: Pick<RunProjectionRow, 'id' | 'exitDetail'>,
): RunStartFailure | null => {
  if (row.exitDetail === null || row.exitDetail.kind !== 'not_started') {
    return null;
  }
  const parsed = runStartFailureSchema.safeParse(row.exitDetail);
  if (!parsed.success) {
    throw new UnprojectableRowError(
      `run ${row.id}`,
      'its `exit_detail` records a start failure in a shape this release does not read',
    );
  }
  return parsed.data;
};

/**
 * `runs.saved_work` → `RunRecord.saved_work` (PROGRESS backlog 467).
 *
 * `null` for a null column — a run whose unfinished work was not saved, or one that ended before the
 * column had a writer. A value this release cannot read is **refused** by name rather than published
 * as `null`, which would say no work was saved.
 */
export const savedWorkOf = (
  row: Pick<RunProjectionRow, 'id' | 'savedWork'>,
): RunSavedWork | null => {
  if (row.savedWork === null) {
    return null;
  }
  const parsed = runSavedWorkSchema.safeParse(row.savedWork);
  if (!parsed.success) {
    throw new UnprojectableRowError(
      `run ${row.id}`,
      'its `saved_work` records the unfinished work in a shape this release does not read',
    );
  }
  return parsed.data;
};

/**
 * `runs.task_stage_id`'s stage → `RunRecord.stage` (PROGRESS backlog 493).
 *
 * An **ask** run has no stage attempt by design — a question is answered beside the pipeline, not
 * in a stage (WP-31) — and publishes `null`. Every other run must be linked to one: a stage run
 * with no link (stored before WP-15h) is refused by name rather than published as an ask. Until
 * this split, one question put to a task made its page, the run page and the Agents screen fail.
 */
export const runStageOf = (row: Pick<RunProjectionRow, 'id' | 'stage' | 'role'>): string | null => {
  if (row.stage !== null) {
    return row.stage;
  }
  if (row.role === 'ask') {
    return null;
  }
  throw new UnprojectableRowError(
    `run ${row.id}`,
    'it is not linked to a stage attempt (`runs.task_stage_id` is null), and only an ask run has none. Runs stored before WP-15h carry no link',
  );
};

/**
 * `runs` + the joined stage + its per-model usage → `RunRecord`.
 *
 * **`cost.is_estimate` is `usd_reported is null`**, which is BD-011's rule read off the column that
 * holds it: the provider's figure is the truth and the price list is the fallback, so a row with no
 * reported figure is reporting an estimate whatever its value.
 */
const toRunRecord = (
  row: RunProjectionRow,
  modelUsage: readonly RunModelUsageRecord[],
  latestProgress: RunLatestProgress | null,
  stopReason: RunStoppedReason | null,
): RunRecord => {
  const stage = runStageOf(row);
  return {
    id: row.id as Id,
    task_id: row.taskId as Id,
    project_id: row.projectId as Id,
    stage,
    role: row.role as RunRecord['role'],
    mode: row.mode as RunRecord['mode'],
    attempt: row.attempt,
    session_id: row.sessionId,
    model: row.model,
    effort: row.effort as RunRecord['effort'],
    provider_mode: row.providerMode as RunRecord['provider_mode'],
    prompt_version: row.promptVersion,
    status: row.status as RunRecord['status'],
    terminal_reason: row.terminalReason as RunRecord['terminal_reason'],
    started_at: iso(row.startedAt),
    ended_at: iso(row.endedAt),
    last_output_at: iso(row.lastOutputAt),
    num_turns: row.numTurns,
    usage: {
      input_tokens: row.inputTokens,
      output_tokens: row.outputTokens,
      cache_write_5m_tokens: row.cacheWrite5mTokens,
      cache_write_1h_tokens: row.cacheWrite1hTokens,
      cache_read_tokens: row.cacheReadTokens,
    },
    model_usage: [...modelUsage],
    // **Both columns may be null since WP-47** (migration 0035), and that is a third answer rather
    // than a spelling of zero: `usd_reported` is the provider's figure, `usd_estimated` is the
    // platform's own pricing of a `local`-mode run — and neither means *nobody measured this run*:
    // the lease sweep, a cancel ended in place, a stop or a crash that read no `result`, each after the
    // run asked for its CLI (one that never did writes a measured 0 since WP-150). Published
    // as `null` since WP-119 (rule 16); until then the DTO had no spelling for it and read `0`.
    cost:
      row.usdReported === null && row.usdEstimated === null
        ? null
        : {
            usd: usd(row.usdReported ?? row.usdEstimated),
            is_estimate: row.usdReported === null,
            price_list_id: row.priceListId as Id | null,
          },
    wall_ms: row.wallMs,
    redaction_count: row.redactionCount,
    // WP-112, backlog 309: read straight off the column WP-91 writes in the run row's own insert.
    // `null` is published as `null` — the run predates the writer — and never re-derived from the
    // project's settings today, which would answer "what were the settings?" with what they are now.
    settings_hash: row.settingsHash,
    start_failure: startFailureOf(row),
    saved_work: savedWorkOf(row),
    latest_progress: latestProgress,
    // S-25.22 (BACKLOG 1394): the runner's own word for why it stopped the run, read off the
    // transcript row it wrote; `null` when it stopped none.
    stop_reason: stopReason,
  };
};

/**
 * Each run's newest `progress` transcript row → `RunRecord.latest_progress` (PROGRESS backlog 496).
 *
 * One query for the whole list: a `lateral` probe per run (`newestEntryPerRun`, S-23.15) — the
 * primary key `(run_id, seq, created_at)` walked backwards in each partition from the run's own
 * `created_at` on, stopped at the first `progress` row, never a sort of the run's transcript.
 * A run that reported nothing is absent from the map and publishes `null`. A row this release cannot
 * read is refused by name, as `/messages` refuses it, rather than published as "no progress": the
 * runner validated it against the same schema when it wrote it, so a mismatch is a fault to see.
 *
 * The cost is stated: there is no partial index on `kind = 'progress'` (migration 0084 could not
 * name the label it added), so for a run that reported nothing the probe walks that run's rows
 * (BACKLOG 808).
 */
export const latestProgressFor = async (
  database: Database,
  runIds: readonly string[],
): Promise<Map<string, RunLatestProgress>> => {
  const byRun = new Map<string, RunLatestProgress>();
  if (runIds.length === 0) {
    return byRun;
  }
  const { rows } = await database.execute<{
    run_id: string;
    seq: number;
    payload: unknown;
    blob_id: string | null;
  }>(newestEntryPerRun(runIds, sql`m.payload, m.blob_id`, { progressOnly: true }));
  for (const row of rows) {
    byRun.set(
      row.run_id,
      latestProgressOfRow({
        runId: row.run_id,
        seq: row.seq,
        payload: row.payload,
        blobId: row.blob_id,
      }),
    );
  }
  return byRun;
};

/**
 * Each run's newest `run_stopped` transcript row's `data.reason` → `RunRecord.stop_reason`
 * (S-25.22, BACKLOG 1394) — the one fact that tells a list a run ended `error_max_budget_usd`
 * because its cost could not be measured (`cost_unreported`), not because it spent its budget; the
 * run page read the same row out of the whole transcript. One `lateral` probe per run, as
 * {@link latestProgressFor}; a run the platform stopped none of is absent and publishes `null`.
 *
 * **A word outside the runner's vocabulary publishes `null`, deliberately not a refusal** (unlike
 * {@link latestProgressOfRow}): the row's `data` is a JSON object the transcript schema does not
 * close — a remote worker's transcript is stored as it sent it — and this field is read by every
 * list the run is on, the Agents screen included, so one odd row refusing would blank all of them.
 * `null` there reads the terminal reason's own words, which is what every list said before the
 * field existed; nothing is invented. The same for a row whose payload is in `blobs` (a stub).
 */
export const stopReasonsFor = async (
  database: Database,
  runIds: readonly string[],
): Promise<Map<string, RunStoppedReason>> => {
  const byRun = new Map<string, RunStoppedReason>();
  if (runIds.length === 0) {
    return byRun;
  }
  const { rows } = await database.execute<{
    run_id: string;
    reason: unknown;
    blob_id: string | null;
  }>(
    newestEntryPerRun(runIds, sql`m.payload -> 'data' -> 'reason' as reason, m.blob_id`, {
      runStoppedOnly: true,
    }),
  );
  for (const row of rows) {
    const reason = stopReasonOfRow({ reason: row.reason, blobId: row.blob_id });
    if (reason !== null) {
      byRun.set(row.run_id, reason);
    }
  }
  return byRun;
};

/** One stored `run_stopped` row's reason → `RunStoppedReason`, or `null` for a word it is not. */
export const stopReasonOfRow = (row: {
  readonly reason: unknown;
  readonly blobId: string | null;
}): RunStoppedReason | null =>
  row.blobId === null ? (runStoppedReasonSchema.safeParse(row.reason).data ?? null) : null;

/** One stored `progress` row → `RunLatestProgress`, or a refusal by name. Pure, for its unit test. */
export const latestProgressOfRow = (row: {
  readonly runId: string;
  readonly seq: number;
  readonly payload: unknown;
  readonly blobId: string | null;
}): RunLatestProgress => {
  const parsed = row.blobId === null ? transcriptEventSchema.safeParse(row.payload) : null;
  if (parsed === null || !parsed.success || parsed.data.kind !== 'progress') {
    throw new UnprojectableRowError(
      `entry ${row.seq} of run ${row.runId}`,
      'its stored progress line does not match the current TranscriptEvent schema, or its payload is in `blobs`, which no reader resolves',
    );
  }
  return {
    seq: parsed.data.seq,
    at: parsed.data.created_at,
    summary: parsed.data.summary,
    percent_complete: parsed.data.percent_complete ?? null,
  };
};

const modelUsageFor = async (
  database: Database,
  runIds: readonly string[],
): Promise<Map<string, RunModelUsageRecord[]>> => {
  const byRun = new Map<string, RunModelUsageRecord[]>();
  if (runIds.length === 0) {
    return byRun;
  }
  const rows = await database
    .select()
    .from(runModelUsage)
    .where(inArray(runModelUsage.runId, [...runIds]))
    .orderBy(asc(runModelUsage.model));
  for (const row of rows) {
    const list = byRun.get(row.runId) ?? [];
    list.push({
      model: row.model,
      input_tokens: row.inputTokens,
      output_tokens: row.outputTokens,
      cache_write_5m_tokens: row.cacheWrite5m,
      cache_write_1h_tokens: row.cacheWrite1h,
      cache_read_tokens: row.cacheRead,
      // The same rule the run-level cost uses (`usd_reported ?? usd_estimated`), one level down —
      // migration 0017 gave `run_model_usage` the pair. A model with **neither** (one `price_list`
      // has no row for, in `local` mode) is published as `null` — *nobody priced it* — never as 0,
      // which would read as a free model (WP-131, PROGRESS backlog 404, standing rule 16). The
      // read DTO's own schema carries the `null` (`runModelUsageRecordSchema`); the event and the
      // transcript keep a number, because every producer of those has one.
      usd:
        row.usdReported === null && row.usdEstimated === null
          ? null
          : usd(row.usdReported ?? row.usdEstimated),
    });
    byRun.set(row.runId, list);
  }
  return byRun;
};

/** `GET /api/runs/:run_id`. `null` when no such run exists. */
export const findRun = async (database: Database, runId: string): Promise<RunRecord | null> => {
  const rows = await database
    .select(runColumns)
    .from(runs)
    .leftJoin(taskStages, eq(taskStages.id, runs.taskStageId))
    .where(eq(runs.id, runId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  const [usage, progress, stops] = await Promise.all([
    modelUsageFor(database, [row.id]),
    latestProgressFor(database, [row.id]),
    stopReasonsFor(database, [row.id]),
  ]);
  return toRunRecord(
    row,
    usage.get(row.id) ?? [],
    progress.get(row.id) ?? null,
    stops.get(row.id) ?? null,
  );
};

/**
 * `GET /api/runs/:run_id/commands` — the run's steer and take-over commands, newest first, bounded
 * (WP-85, TD-028 decision 9).
 *
 * The state is derived from the two stamps the holder and the ending write (migration 0060) and is
 * never guessed: a row with neither stamp is `pending`, which is exactly what it is. A payload this
 * build cannot read is refused by name ({@link UnprojectableRowError}) rather than published with
 * an empty message — the same reader the holder delivers from, so the screen and the session can
 * never disagree about what a steer said.
 */
export const listRunCommands = async (
  database: Database,
  runId: string,
): Promise<readonly RunCommandRecord[]> => {
  const rows = await database
    .select()
    .from(runCommands)
    .where(eq(runCommands.runId, runId))
    .orderBy(desc(runCommands.createdAt), desc(runCommands.id))
    .limit(MAX_RUN_COMMANDS);
  return rows.map((row): RunCommandRecord => {
    let instruction: ReturnType<typeof pipelineAdapters.decodeRunCommandPayload>;
    try {
      instruction = pipelineAdapters.decodeRunCommandPayload(row.id, row.kind, row.payload);
    } catch {
      throw new UnprojectableRowError(
        `run command ${row.id}`,
        `its ${row.kind} payload is not a shape this build can read`,
      );
    }
    return {
      id: row.id,
      run_id: row.runId,
      kind: instruction.kind,
      state: row.appliedAt !== null ? 'applied' : row.refusedAt !== null ? 'refused' : 'pending',
      message: instruction.kind === 'steer' ? instruction.text : null,
      author_user_id: row.actorUserId,
      created_at: row.createdAt.toISOString(),
      applied_at: row.appliedAt?.toISOString() ?? null,
      refused_at: row.refusedAt?.toISOString() ?? null,
      refused_reason: row.refusedReason,
    };
  });
};

export interface RunMessagePage {
  readonly items: readonly TranscriptEvent[];
  /** The `after` value for the next page, or null when this is the last one. */
  readonly nextSeq: number | null;
}

export interface RunMessagesQuery {
  readonly limit: number;
  /** Exclusive lower bound on `seq`. Absent starts at the first entry, which is `seq: 0`. */
  readonly after?: number;
  /** `false` drops coalesced `stream_block` entries (technical/08's `?partials=0`). */
  readonly partials: boolean;
}

/**
 * One page of `run_messages`, in `seq` order, **including `seq: 0`**.
 *
 * The cursor is exclusive and the first entry of every run is zero (migration 0016), so the
 * absent-cursor case cannot be expressed as `after = 0` — that would skip the first entry of every
 * run, which is the `system`/`init` one. It is expressed as no bound at all.
 *
 * `payload` holds the whole `TranscriptEvent` the runner produced, so the page is the rows parsed
 * back through the same schema rather than reassembled from the indexing columns beside them.
 */
export const listRunMessages = async (
  database: Database,
  runId: string,
  query: RunMessagesQuery,
): Promise<RunMessagePage> => {
  const conditions = [
    eq(runMessages.runId, runId),
    ...(query.after === undefined ? [] : [gt(runMessages.seq, query.after)]),
    ...(query.partials ? [] : [ne(runMessages.kind, 'stream_block')]),
  ];
  const rows = await database
    .select({
      seq: runMessages.seq,
      kind: runMessages.kind,
      payload: runMessages.payload,
      blobId: runMessages.blobId,
    })
    .from(runMessages)
    .where(and(...conditions))
    .orderBy(asc(runMessages.seq))
    .limit(query.limit + 1);

  const page = rows.slice(0, query.limit);
  const items = page.map((row) => {
    if (row.blobId !== null) {
      throw new UnprojectableRowError(
        `entry ${row.seq} of run ${runId}`,
        'its payload is stored in `blobs` (`run_messages.blob_id` is set) and no reader resolves blobs yet; nothing in this repository writes one, so serving the `payload` column instead would serve a stub',
      );
    }
    const parsed = transcriptEventSchema.safeParse(row.payload);
    if (!parsed.success) {
      // The issue *paths* are named and the values are not: a transcript payload is untrusted
      // content (BD-022) and may hold the very text TD-012 redacted around.
      throw new UnprojectableRowError(
        `entry ${row.seq} of run ${runId}`,
        `its stored payload does not match the current TranscriptEvent schema at ${parsed.error.issues
          .map((issue) => issue.path.join('.') || '(root)')
          .join(', ')}`,
      );
    }
    return parsed.data;
  });

  const last = page.at(-1);
  return {
    items,
    nextSeq: rows.length > query.limit && last !== undefined ? last.seq : null,
  };
};

/**
 * `GET /api/artifacts/:artifact_id` — one artifact's body (WP-52, PROGRESS backlog 85).
 *
 * **A row whose `redaction_count` is `null` is refused, not served** (round 2). That spelling means
 * *"written before migration 0038, when nothing redacted an artifact"* — which is backlog 35's
 * measured defect, a run's structured output stored verbatim — and this route is a **new read
 * surface** over it, gated at `artifact.read`, which is `viewer`. Serving such a row would publish
 * a credential to the widest role on the instance, through the endpoint this work package added to
 * close the complaint that artifacts cannot be read. A reader loses nothing they had: there was no
 * route at all. It is the answer `prompt_not_recorded` and `context_pack_not_recorded` already give
 * — refuse by name rather than serve something the platform cannot vouch for — and it is why
 * `redaction_count` is on the DTO as a **non-null** number.
 *
 * `data` is passed through as opaque JSON. Parsing it against `artifactSchema` on the way out would
 * make an older row's missing field a 500 rather than a document — `/context-pack`'s refusal is the
 * other shape of the same rule, and the difference is that *there* the platform would have had to
 * invent a value, while here it has the whole row.
 */
export type ArtifactBody =
  | { readonly found: false }
  /** Stored before migration 0038: no redactor ran over it, so it is refused rather than served. */
  | { readonly found: true; readonly redacted: false; readonly createdAt: string }
  | { readonly found: true; readonly redacted: true; readonly body: ArtifactBodyResponse };

export const findArtifactBody = async (
  database: Database,
  artifactId: string,
): Promise<ArtifactBody> => {
  const rows = await database
    .select({
      id: artifacts.id,
      taskId: artifacts.taskId,
      type: artifacts.type,
      version: artifacts.version,
      schemaVersion: artifacts.schemaVersion,
      producedByRunId: artifacts.producedByRunId,
      redactionCount: artifacts.redactionCount,
      markdown: artifacts.markdown,
      data: artifacts.data,
      createdAt: artifacts.createdAt,
    })
    .from(artifacts)
    .where(eq(artifacts.id, artifactId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    return { found: false };
  }
  if (row.redactionCount === null) {
    return { found: true, redacted: false, createdAt: isoRequired(row.createdAt) };
  }
  return {
    found: true,
    redacted: true,
    body: {
      id: row.id as Id,
      task_id: row.taskId as Id,
      artifact_type: row.type,
      version: row.version,
      schema_version: row.schemaVersion,
      produced_by_run_id: row.producedByRunId as Id | null,
      created_at: isoRequired(row.createdAt),
      redaction_count: row.redactionCount,
      markdown: row.markdown,
      data: row.data,
    },
  };
};

/** The project a given artifact belongs to, for the permission scope. Null when there is no row. */
export const findArtifactProjectId = async (
  database: Database,
  artifactId: string,
): Promise<string | null> => {
  const rows = await database
    .select({ projectId: tasks.projectId })
    .from(artifacts)
    .innerJoin(tasks, eq(tasks.id, artifacts.taskId))
    .where(eq(artifacts.id, artifactId))
    .limit(1);
  return rows[0]?.projectId ?? null;
};

export type RunPrompt =
  | { readonly found: false }
  | { readonly found: true; readonly recorded: false }
  | {
      readonly found: true;
      readonly recorded: true;
      readonly promptVersion: string;
      readonly systemPrompt: string;
      readonly userPrompt: string;
      /** `runs.prompts_withheld` (migration 0073, WP-121), read back through its shape. */
      readonly promptsWithheld: PromptsWithheldRecord | null;
    };

/**
 * `GET /api/runs/:run_id/prompt`, and the three answers it has to be able to give.
 *
 * "The run does not exist" and "the run exists and its prompt was never stored" are different
 * facts and the route answers them with different statuses; collapsing them into one nullable
 * would make a missing feature look like a missing run.
 */
export const findRunPrompt = async (database: Database, runId: string): Promise<RunPrompt> => {
  const rows = await database
    .select({
      promptVersion: runs.promptVersion,
      systemPrompt: runs.systemPrompt,
      userPrompt: runs.userPrompt,
      promptsWithheld: runs.promptsWithheld,
    })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    return { found: false };
  }
  if (row.systemPrompt === null || row.userPrompt === null) {
    return { found: true, recorded: false };
  }
  return {
    found: true,
    recorded: true,
    promptVersion: row.promptVersion,
    systemPrompt: row.systemPrompt,
    userPrompt: row.userPrompt,
    promptsWithheld: promptsWithheldOfRun(row.promptsWithheld),
  };
};

/**
 * `runs.prompts_withheld` as the DTO publishes it (WP-121). A stored document that is not the shape
 * is published as a sentence saying so rather than as `null`: something was withheld, and a reader
 * must not be told nothing was (rule 20). The table's check constraint makes that branch a hand edit.
 */
const promptsWithheldOfRun = (raw: unknown): PromptsWithheldRecord | null => {
  if (raw === null || raw === undefined) return null;
  const parsed = promptsWithheldSchema.safeParse(raw);
  return parsed.success
    ? parsed.data
    : {
        reason:
          'the run recorded that its project prompt files were withheld, in a shape this release does not read',
        integrations: [],
      };
};

export type RunContextPack =
  | { readonly found: false }
  | {
      readonly found: true;
      readonly recorded: false;
      /**
       * How many `run_context_pack` rows the run has. `0` for every run created before migration
       * 0041; a non-zero count with no header is a row somebody wrote outside `RunRepository.insert`,
       * and the count is what makes the two distinguishable (standing rule 18).
       */
      readonly rows: number;
    }
  | { readonly found: true; readonly recorded: true; readonly pack: ContextPackRecord };

/**
 * `GET /api/runs/:run_id/context-pack` — the record the run's planner built (WP-57, PROGRESS
 * backlog 31).
 *
 * **Three answers, and the header decides between them.** `runs.context_budget_tokens` is written
 * by the statement that creates the run, from the same `ContextPackRecord` `run.started` carries
 * (migration 0041), so:
 *
 *  - a **null** budget is *"no pack was recorded for this run"* — every run created before 0041 —
 *    and is refused with the row count rather than projected, because `budget_tokens` and
 *    `total_tokens` would be invented (the first version of this function summed the rows into
 *    `budget_tokens`, and `apps/web/src/features/run-detail.tsx` renders it as a fact);
 *  - a budget with **no rows** is an **empty** pack — a project whose index was never built, or a
 *    vault with nothing to say — and is served as one, with empty tiers;
 *  - a budget with rows is the pack, in the order it was recorded (`ordinal` per tier).
 *
 * **Nothing is defaulted.** `total_tokens` is read, not summed (the assembler does not count a
 * tier-1 entry recorded `validated: false`, and re-deriving that rule here would be a second
 * spelling of it). A row without an `ordinal`, or a tier-1 row without a `reason` or a `score`, can
 * only predate 0041's check, and it is refused by name rather than filled with `'paths'` and `0`.
 * The result is parsed through the published schema, so a row the DTO cannot describe is a
 * {@link UnprojectableRowError} and never a 500.
 */
export const findRunContextPack = async (
  database: Database,
  runId: string,
): Promise<RunContextPack> => {
  const header = await database
    .select({
      budget: runs.contextBudgetTokens,
      total: runs.contextTotalTokens,
      kbCommit: runs.contextKbCommit,
      textSearch: runs.contextTextSearch,
    })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);
  const run = header[0];
  if (run === undefined) {
    return { found: false };
  }
  const rows = await database
    .select({
      tier: runContextPack.tier,
      path: runContextPack.sourcePath,
      reason: runContextPack.reason,
      score: runContextPack.score,
      tokens: runContextPack.tokens,
      validated: runContextPack.validated,
      ordinal: runContextPack.ordinal,
    })
    .from(runContextPack)
    .where(eq(runContextPack.runId, runId))
    .orderBy(asc(runContextPack.tier), asc(runContextPack.ordinal));
  if (run.budget === null || run.total === null) {
    return { found: true, recorded: false, rows: rows.length };
  }
  const tier0: ContextPackRecord['tier0'] = [];
  const tier1: unknown[] = [];
  for (const row of rows) {
    if (row.ordinal === null) {
      throw new UnprojectableRowError(
        `context pack of run ${runId}`,
        `its ${row.tier === 0 ? 'tier-0' : 'tier-1'} row has no ordinal, so it predates migration 0041 and its position in the pack is unknown`,
      );
    }
    if (row.tier === 0) {
      tier0.push({ path: row.path, tokens: row.tokens });
    } else if (row.tier === 1) {
      // `reason`/`score` go through the schema as they are: a null here is refused below by the
      // parse, never replaced.
      tier1.push({
        path: row.path,
        reason: row.reason,
        score: row.score,
        tokens: row.tokens,
        validated: row.validated,
      });
    } else {
      throw new UnprojectableRowError(
        `context pack of run ${runId}`,
        `it has a tier-${row.tier} row, and the published record has tiers 0 and 1 only`,
      );
    }
  }
  const parsed = contextPackRecordSchema.safeParse({
    tier0,
    tier1,
    budget_tokens: run.budget,
    total_tokens: run.total,
    kb_commit: run.kbCommit,
    // WP-44 (migration 0047). A run written before it recorded no text step: the field is absent
    // rather than one of the five outcomes, and the screen says "not recorded".
    ...(run.textSearch === null ? {} : { text_search: run.textSearch }),
  });
  if (!parsed.success) {
    // The issue *paths*, never the values: a path is a vault path somebody committed (BD-022).
    throw new UnprojectableRowError(
      `context pack of run ${runId}`,
      `its stored shape does not match the published record at ${parsed.error.issues
        .map((issue) => issue.path.join('.') || '(root)')
        .join(', ')}`,
    );
  }
  return { found: true, recorded: true, pack: parsed.data };
};

export type RunSettings =
  | { readonly found: false }
  | { readonly found: true; readonly recorded: false }
  | {
      readonly found: true;
      readonly recorded: true;
      readonly settingsHash: string;
      readonly snapshot: JsonObject;
    };

/**
 * `GET /api/runs/:run_id/settings` — the configuration the run was planned with (WP-112, PROGRESS
 * backlog 309), and the three answers it has to be able to give, as {@link findRunPrompt} does.
 *
 * **The hash decides, not the document.** `runs.settings_snapshot` is `not null default '{}'`
 * (migration 0004), so an empty object is what every row WP-91's writer never touched carries; the
 * boundary technical/03 states is `settings_hash is null`. Such a row is reported `recorded: false`
 * and the route refuses it — serving its `{}` would publish "this run was planned with no
 * configuration", which is a claim about the run rather than about the row. A hash with an empty
 * snapshot cannot be written by WP-91's composer (the document always carries `format`), and is
 * served as stored rather than second-guessed.
 */
export const findRunSettings = async (database: Database, runId: string): Promise<RunSettings> => {
  const rows = await database
    .select({ settingsHash: runs.settingsHash, snapshot: runs.settingsSnapshot })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    return { found: false };
  }
  if (row.settingsHash === null) {
    return { found: true, recorded: false };
  }
  return { found: true, recorded: true, settingsHash: row.settingsHash, snapshot: row.snapshot };
};

/** One row of the event log as the task export reads it — the columns, unparsed (WP-112). */
export interface TaskEventRow {
  readonly position: number;
  readonly id: string;
  readonly type: string;
  readonly streamType: string;
  readonly streamId: string;
  readonly streamSeq: number;
  readonly correlationId: string | null;
  readonly causeEventId: string | null;
  readonly actor: JsonObject;
  readonly occurredAt: Date;
  readonly payload: JsonObject;
}

/**
 * The task's events for `GET /api/tasks/:task_id/export` (WP-112, PROGRESS backlog 310): the task's
 * own stream **and** every event correlated to it — a run's, a question's, a workspace's — oldest
 * first by `position`, at most `limit` rows. The caller asks for one more than it publishes, which
 * is how the export knows its cap cut.
 *
 * Two indexes answer it (`events_stream_idx` and the partial `events_correlation_id_idx`, migration
 * 0005), so the read is bounded by the task's own events and not by the log.
 */
export const listTaskEvents = async (
  database: Database,
  taskId: string,
  limit: number,
): Promise<readonly TaskEventRow[]> =>
  database
    .select({
      position: events.position,
      id: events.id,
      type: events.type,
      streamType: events.streamType,
      streamId: events.streamId,
      streamSeq: events.streamSeq,
      correlationId: events.correlationId,
      causeEventId: events.causeEventId,
      actor: events.actor,
      occurredAt: events.occurredAt,
      payload: events.payload,
    })
    .from(events)
    .where(
      or(
        and(eq(events.streamType, 'task'), eq(events.streamId, taskId)),
        eq(events.correlationId, taskId),
      ),
    )
    .orderBy(asc(events.position))
    .limit(limit);

/**
 * The human minutes recorded against a task — product/19 §16, product/09:29 (WP-29).
 *
 * Two reads and a pure fold: the entries joined to `users`, and the project's effective
 * configuration for product/18:32's per-user-breakdown setting. Everything the answer is *made of*
 * is in `./human-time-summary.js`, which is where the arithmetic, the two identity shapes and the
 * `by_user: null` rule are asserted — a database is needed to reach this function and not to reach
 * that one.
 *
 * The sum is done in TypeScript rather than in SQL so that the four `by_kind` buckets, the per-user
 * rows and the total are folded from **one** read of the same rows and cannot disagree.
 */
export const findHumanTime = async (
  database: Database,
  taskId: string,
  projectId: string,
): Promise<HumanTimeSummary> => {
  // The statistics' two predicates, **shared, not copied** (WP-44, PROGRESS backlog 190): a row
  // written for an account since declared a machine is dropped here as it is there, and a review
  // window an approval touched is read with a flag the fold turns into `withheld` rather than into
  // minutes. `h` and `t` are the aliases both fragments are written over.
  const [result, projectRows] = await Promise.all([
    database.execute<{
      kind: HumanTimeKind;
      user_id: string | null;
      user_name: string | null;
      external_author: string | null;
      minutes: string | number | null;
      withheld: boolean;
    }>(sql`
      select h.kind, h.user_id, u.name as user_name, h.external_author, h.minutes,
             ${APPROVAL_TOUCHED} as withheld
        from human_time_entries h
        join tasks t on t.id = h.task_id
        left join users u on u.id = h.user_id
       where h.task_id = ${taskId}
         and not ${MACHINE_AUTHORED}
       order by h.started_at
    `),
    database
      .select({ config: projects.config })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1),
  ]);

  return summariseHumanTime(
    result.rows.map((row) => ({
      kind: row.kind,
      userId: row.user_id,
      userName: row.user_name,
      externalAuthor: row.external_author,
      minutes: row.minutes,
      withheld: row.withheld === true,
    })),
    { perUserBreakdown: perUserBreakdownEnabled(projectRows[0]?.config) },
  );
};

/**
 * The latest conflict warning per task — product/04 S6b's board badge (WP-26's event, WP-41's
 * field; PROGRESS backlog **63**).
 *
 * A projection over the task's own event stream rather than a table: `task.conflict.warned` already
 * carries everything the badge renders — the peer's ticket key, how many paths overlapped and
 * whether the comparison read every file — so a table would be a second copy of a row that exists.
 *
 * `distinct on (stream_id)` with the newest first: a task compared twice shows what the **last**
 * comparison found, because that is the state of the world the reader is looking at. The ordering
 * falls back to `position` so two warnings inside one transaction still have a winner.
 *
 * **Bounded by construction**: it is only ever asked about the tasks of one page, so the `in` list
 * is at most `limit` long and the read uses the stream index rather than scanning a partition.
 */
const conflictsFor = async (
  database: Database,
  taskIds: readonly string[],
): Promise<ReadonlyMap<string, TaskConflict>> => {
  if (taskIds.length === 0) {
    return new Map();
  }
  const rows = await database
    .selectDistinctOn([events.streamId], {
      streamId: events.streamId,
      payload: events.payload,
      occurredAt: events.occurredAt,
    })
    .from(events)
    .where(
      and(
        eq(events.streamType, 'task'),
        eq(events.type, 'task.conflict.warned'),
        inArray(events.streamId, [...taskIds]),
      ),
    )
    .orderBy(events.streamId, desc(events.occurredAt), desc(events.position));

  return new Map(
    rows.map((row) => {
      const payload = row.payload as unknown as {
        other_task_id: string;
        other_ticket_key: string;
        path_count: number;
        truncated: boolean;
      };
      return [
        row.streamId,
        {
          other_task_id: payload.other_task_id as Id,
          other_ticket_key: payload.other_ticket_key,
          path_count: payload.path_count,
          truncated: payload.truncated,
          warned_at: isoRequired(row.occurredAt),
        },
      ];
    }),
  );
};

/**
 * What each of these tasks has spent that was **priced rather than reported** (WP-47, backlog 75).
 *
 * `conflictsFor`'s shape one table across, and bounded the same way: it is only ever asked about
 * the tasks of one page, so the `in` list is at most `limit` long and the read uses
 * `cost_entries_task_idx`. A task with no estimated entry is absent from the map and publishes `0`
 * — which here is a **measurement** (the ledger has rows for this task and none of them is an
 * estimate), not the absence the dropped column could not tell apart from one.
 */
const estimatedSpendFor = async (
  database: Database,
  taskIds: readonly string[],
): Promise<ReadonlyMap<string, number>> => {
  if (taskIds.length === 0) {
    return new Map();
  }
  const rows = await database
    .select({ taskId: costEntries.taskId, usd: sum(costEntries.usd) })
    .from(costEntries)
    .where(and(inArray(costEntries.taskId, [...taskIds]), eq(costEntries.isEstimate, true)))
    .groupBy(costEntries.taskId);
  return new Map(rows.map((row) => [row.taskId, usd(row.usd)]));
};

/**
 * Why each **paused** task is paused — the newest `task.paused` event's `reason` on its stream
 * (WP-131 review round 1), `conflictsFor`'s shape: one read per page, over the page's paused tasks
 * only, through the stream index. A task absent from the map is not paused (or carries no pause
 * event), which `toTaskRecord` publishes as `null`.
 */
const pausedReasonsFor = async (
  database: Database,
  taskIds: readonly string[],
): Promise<ReadonlyMap<string, PausedWhy>> => {
  if (taskIds.length === 0) {
    return new Map();
  }
  const rows = await database
    .selectDistinctOn([events.streamId], { streamId: events.streamId, payload: events.payload })
    .from(events)
    .where(
      and(
        eq(events.streamType, 'task'),
        eq(events.type, 'task.paused'),
        inArray(events.streamId, [...taskIds]),
      ),
    )
    .orderBy(events.streamId, desc(events.occurredAt), desc(events.position));
  const known = new Set(['budget', 'manual', 'taken_over']);
  return new Map(
    rows.flatMap((row) => {
      const payload = row.payload as {
        readonly reason?: unknown;
        readonly budget_scope?: unknown;
        readonly budget_figures?: unknown;
      };
      if (typeof payload.reason !== 'string' || !known.has(payload.reason)) {
        return [];
      }
      // `budget_scope` since WP-131 review round 2; an older pause names no cap and reads `null`.
      const scope = pausedBudgetScopeSchema.safeParse(payload.budget_scope);
      return [
        [
          row.streamId,
          {
            reason: payload.reason as NonNullable<TaskRecord['paused_reason']>,
            scope: payload.reason === 'budget' && scope.success ? scope.data : null,
            // S-28.1 (M28 ruling 1): the pause's arithmetic, `null` for a pause recorded without it
            // (or with a shape this release does not read) — never a figure derived here.
            figures: payload.reason === 'budget' ? figuresOf(payload.budget_figures) : null,
          },
        ] as const,
      ];
    }),
  );
};

/**
 * The page's `task_stages` rows (S-23.9a), oldest first as the task page orders them — the board
 * card's phase strip and its time in stage. A row whose state is outside the published vocabulary
 * is refused by name, as the task page refuses it ({@link stageStateOf}).
 */
const stageRowsFor = async (
  database: Database,
  taskIds: readonly string[],
): Promise<
  ReadonlyMap<
    string,
    {
      readonly stages: TaskListItem['stages'];
      readonly setback: SetbackStageRow[];
      /** The rows as {@link gateWaitOf} reads them (backlog 1300). */
      readonly gate: GateStageRow[];
    }
  >
> => {
  if (taskIds.length === 0) {
    return new Map();
  }
  const rows = await database
    .select({
      taskId: taskStages.taskId,
      stage: taskStages.stage,
      attempt: taskStages.attempt,
      state: taskStages.state,
      enteredAt: taskStages.enteredAt,
      exitedAt: taskStages.exitedAt,
      outcome: taskStages.outcome,
      returnedTo: taskStages.returnedTo,
      signature: taskStages.signature,
      ciEnding: taskStages.ciEnding,
      // Backlog 1300: the CI gate's recorded read, for the card's `gate_wait`.
      ciPendingRead: taskStages.ciPendingRead,
      // S-25.11: a CI return's reason is its jobs' logs, so the page reads a bounded head of it —
      // one character past the stop's cap, which is how `stopOf` knows it was cut.
      returnReason: sql<
        string | null
      >`left(${taskStages.returnReason}, ${MAX_TASK_STOP_RECORDED_CHARS + 1})`,
    })
    .from(taskStages)
    .where(inArray(taskStages.taskId, [...taskIds]))
    .orderBy(asc(taskStages.taskId), asc(taskStages.enteredAt), asc(taskStages.attempt));
  const byTask = new Map<
    string,
    { stages: TaskListItem['stages'][number][]; setback: SetbackStageRow[]; gate: GateStageRow[] }
  >();
  for (const row of rows) {
    const entry = byTask.get(row.taskId) ?? { stages: [], setback: [], gate: [] };
    entry.stages.push({
      stage: row.stage,
      attempt: row.attempt,
      state: stageStateOf(row),
      entered_at: isoRequired(row.enteredAt),
    });
    entry.setback.push(setbackRowOf(row));
    entry.gate.push(row);
    byTask.set(row.taskId, entry);
  }
  return byTask;
};

/** A `task_stages` row as `task-setback.ts` reads it (S-25.11). */
const setbackRowOf = (row: {
  readonly stage: string;
  readonly attempt: number;
  readonly state: string;
  readonly outcome: string | null;
  readonly exitedAt: Date | null;
  readonly returnedTo: string | null;
  readonly returnReason: string | null;
  readonly signature: string | null;
  readonly ciEnding: string | null;
}): SetbackStageRow => ({
  stage: row.stage,
  attempt: row.attempt,
  state: stageStateOf(row),
  outcome: stageOutcomeOf(row.outcome),
  exitedAt: iso(row.exitedAt),
  returnedTo: row.returnedTo,
  returnReason: row.returnReason,
  signature: row.signature,
  ciEnding: ciEndingOf(row),
});

/**
 * `task_stages.ci_ending` in its vocabulary (backlog 1078) — a word the writer's schema does not
 * admit is refused by name, never read as "no ending".
 */
const ciEndingOf = (row: {
  readonly stage: string;
  readonly attempt: number;
  readonly ciEnding: string | null;
}): CiGateEnding | null => {
  if (row.ciEnding === null) {
    return null;
  }
  const parsed = ciGateEndingSchema.safeParse(row.ciEnding);
  if (!parsed.success) {
    throw new UnprojectableRowError(
      `the ${row.stage} attempt ${row.attempt}`,
      `its recorded CI ending (\`task_stages.ci_ending\`) is ${JSON.stringify(row.ciEnding)}, which this build does not know`,
    );
  }
  return parsed.data;
};

/**
 * How many of each page task's questions are `open` and approvals `pending` (S-23.9a) — the same
 * predicates the inbox lists by, so a card's count and the inbox never disagree — and, since
 * S-28.8, which tasks' **newest** plan approval the platform decided itself under the low-risk rule
 * (`approvals.auto_decided`): the card's *Plan went ahead without approval*.
 */
const openAsksFor = async (
  database: Database,
  taskIds: readonly string[],
): Promise<{
  readonly questions: ReadonlyMap<string, number>;
  readonly approvals: ReadonlyMap<string, number>;
  readonly wentAhead: ReadonlySet<string>;
}> => {
  if (taskIds.length === 0) {
    return { questions: new Map(), approvals: new Map(), wentAhead: new Set() };
  }
  const [open, pending, newestPlans] = await Promise.all([
    database
      .select({ taskId: questions.taskId, count: sql<number>`count(*)::int` })
      .from(questions)
      .where(and(inArray(questions.taskId, [...taskIds]), eq(questions.status, 'open')))
      .groupBy(questions.taskId),
    database
      .select({ taskId: approvals.taskId, count: sql<number>`count(*)::int` })
      .from(approvals)
      .where(and(inArray(approvals.taskId, [...taskIds]), eq(approvals.status, 'pending')))
      .groupBy(approvals.taskId),
    database
      .selectDistinctOn([approvals.taskId], {
        taskId: approvals.taskId,
        autoDecided: approvals.autoDecided,
      })
      .from(approvals)
      .where(and(inArray(approvals.taskId, [...taskIds]), eq(approvals.kind, 'plan')))
      .orderBy(approvals.taskId, desc(approvals.requestedAt), desc(approvals.id)),
  ]);
  return {
    questions: new Map(open.map((row) => [row.taskId, Number(row.count)])),
    approvals: new Map(pending.map((row) => [row.taskId, Number(row.count)])),
    wentAhead: new Set(newestPlans.filter((row) => row.autoDecided).map((row) => row.taskId)),
  };
};

/** Why a paused task is paused, and — for a budget pause — which cap (WP-131 review round 2). */
interface PausedWhy {
  readonly reason: NonNullable<TaskRecord['paused_reason']>;
  readonly scope: TaskRecord['paused_budget_scope'];
  /** The pause's arithmetic (S-28.1), when the pause recorded it. */
  readonly figures: TaskRecord['paused_budget_figures'];
}

/** A recorded `budget_figures`, or `null` when absent or not in the published shape. */
const figuresOf = (value: unknown): TaskRecord['paused_budget_figures'] => {
  const parsed = pausedBudgetFiguresSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

/**
 * How many of each task's runs ended with **nobody measuring them** — terminal, both cost columns
 * null (WP-131, PROGRESS backlog 403) — for `TaskRecord.unmeasured_runs`.
 *
 * The predicate is the caps' own (`unmeasuredEndedRunSql` in
 * `packages/infrastructure/src/cost/pending-run-spend.ts`, spelled here over Drizzle's columns), so
 * the page says *"excludes N runs"* about exactly the runs every cap holds. Bounded like
 * {@link estimatedSpendFor}: only the tasks of one page, through `runs (task_id)`. A task absent
 * from the map has none, and `0` there is a count, not an absence.
 */
const unmeasuredRunsFor = async (
  database: Database,
  taskIds: readonly string[],
): Promise<ReadonlyMap<string, number>> => {
  if (taskIds.length === 0) {
    return new Map();
  }
  const rows = await database
    .select({ taskId: runs.taskId, count: sql<number>`count(*)::int` })
    .from(runs)
    .where(
      and(
        inArray(runs.taskId, [...taskIds]),
        notInArray(runs.status, [...ACTIVE_RUN_STATUSES]),
        // Both cost columns null, **or** a figure that is the runner's floor (`figure_is_floor`, a
        // `cost_unreported` stop — WP-131 review round 1): the caps' predicate, both halves.
        or(and(isNull(runs.usdReported), isNull(runs.usdEstimated)), eq(runs.figureIsFloor, true)),
        // WP-150: a run that never asked for its CLI is a measured zero, not unmeasured.
        isNotNull(runs.cliSpawnRequestedAt),
      ),
    )
    .groupBy(runs.taskId);
  return new Map(rows.map((row) => [row.taskId, Number(row.count)]));
};

/**
 * **A task's owner as the DTO publishes it** (S-26.1, TD-031's 2026-11-06 amendment item 3): the
 * owner's display name, and whether the ticket is **held elsewhere** — asked through
 * `taskHeldElsewhereSql`, the predicate the owner command, the claim and the pick share, read live
 * through `user_identities` so a link made since the last tracker read counts here at once.
 *
 * And since S-26.3, **whether a platform assignment writes back** (`owner_writes_back`, item 4):
 * the project's task-management binding sets `lifecycle.assign_owner` — read through the reading
 * the pipeline itself applies (`ticketLifecycleOfRows`, `ticket-lifecycle.ts`), so the page and the
 * duty cannot disagree about the switch — **and** the task's owner has a `person` identity for the
 * ticket's provider, the account the duty would assign. A task that names no provider ticket, and a
 * **shadow** task (whose call is a `would_have` that writes nothing), publish `false`: the
 * confirmation's *"also assigns … in Jira"* would be untrue for either.
 */
interface OwnerView {
  readonly ownerName: string | null;
  readonly heldElsewhere: boolean;
  readonly writesBack: boolean;
  /** The user the stored tracker assignee resolves to, live (`trackerAssigneeUserSql`). */
  readonly assigneeUserId: string | null;
}

const HELD_ELSEWHERE = sql.raw(pipelineAdapters.taskHeldElsewhereSql('t'));
const TRACKER_ASSIGNEE_USER = sql.raw(pipelineAdapters.trackerAssigneeUserSql('t'));

/**
 * **Whether assigning each of `userIds` to one task would reach the tracker** (S-26.3): the
 * domain's `ownerWriteBackReachesTracker` — the predicate the `ticket_owner_assign` duty decides
 * with — over the project's switch, the task's ticket and mode, and each user's `person` identity
 * for the ticket's provider. What the task read's per-caller `take_writes_back` and the owner
 * candidates' `writes_back` answer, so neither can promise a write the duty would not make.
 */
export const ownerWriteBackFor = async (
  database: Database,
  task: { readonly projectId: string; readonly ticketProvider: string; readonly mode: string },
  userIds: readonly string[],
): Promise<ReadonlyMap<string, boolean>> => {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) {
    return new Map();
  }
  const [assigning, { rows }] = await Promise.all([
    projectsAssigningOwners(database, [task.projectId]),
    database.execute<{ user_id: string }>(sql`
      select distinct ui.user_id from user_identities ui
       where ui.provider = ${task.ticketProvider}
         and ui.kind = 'person'
         and ui.user_id in (${sql.join(
           unique.map((userId) => sql`${userId}::uuid`),
           sql`, `,
         )})`),
  ]);
  const identified = new Set(rows.map((row) => row.user_id));
  return new Map(
    unique.map((userId) => [
      userId,
      ownerWriteBackReachesTracker({
        assignOwner: assigning.has(task.projectId),
        providerTicket: task.ticketProvider !== PLATFORM_TICKET_PROVIDER,
        hasPersonIdentity: identified.has(userId),
        shadow: task.mode === 'shadow',
      }),
    ]),
  );
};

/**
 * `writes_back` for the owner candidates (S-26.3): {@link ownerWriteBackFor} over the task the
 * picker names — `null` when that task is not the project's (the route's 404) — or, with no task,
 * over the project's one live task-management binding's provider as a normal task (no binding, or
 * two, writes nothing back: the loader refuses that project's every call).
 */
export const ownerCandidateWriteBack = async (
  database: Database,
  input: { readonly projectId: string; readonly taskId: string | null },
  userIds: readonly string[],
): Promise<ReadonlyMap<string, boolean> | null> => {
  if (input.taskId !== null) {
    const { rows } = await database.execute<{ ticket_provider: string; mode: string }>(sql`
      select t.ticket_provider, t.mode from tasks t
       where t.id = ${input.taskId}::uuid and t.project_id = ${input.projectId}::uuid`);
    const task = rows[0];
    return task === undefined
      ? null
      : ownerWriteBackFor(
          database,
          { projectId: input.projectId, ticketProvider: task.ticket_provider, mode: task.mode },
          userIds,
        );
  }
  const { rows } = await database.execute<TicketLifecycleBindingRow & Record<string, unknown>>(
    ticketLifecycleBindingsQuery(input.projectId),
  );
  const binding = rows.length === 1 ? rows[0] : undefined;
  if (binding === undefined) {
    return new Map(userIds.map((userId) => [userId, false]));
  }
  return ownerWriteBackFor(
    database,
    { projectId: input.projectId, ticketProvider: binding.provider, mode: 'normal' },
    userIds,
  );
};

/** Which of `projectIds` have a task-management binding that sets `lifecycle.assign_owner`. */
const projectsAssigningOwners = async (
  database: Database,
  projectIds: readonly string[],
): Promise<ReadonlySet<string>> => {
  const assigning = new Set<string>();
  for (const projectId of new Set(projectIds)) {
    const { rows } = await database.execute<TicketLifecycleBindingRow & Record<string, unknown>>(
      ticketLifecycleBindingsQuery(projectId),
    );
    if (appliedTicketLifecycle(ticketLifecycleOfRows(rows))?.slots.assign_owner === true) {
      assigning.add(projectId);
    }
  }
  return assigning;
};

const ownerViewsFor = async (
  database: Database,
  taskIds: readonly string[],
): Promise<ReadonlyMap<string, OwnerView>> => {
  if (taskIds.length === 0) {
    return new Map();
  }
  const { rows } = await database.execute<{
    id: string;
    project_id: string;
    ticket_provider: string;
    mode: string;
    owner_name: string | null;
    held_elsewhere: boolean;
    owner_has_identity: boolean;
    assignee_user_id: string | null;
  }>(sql`
    select t.id, t.project_id, t.ticket_provider, t.mode, u.name as owner_name,
           ${HELD_ELSEWHERE} as held_elsewhere,
           ${TRACKER_ASSIGNEE_USER} as assignee_user_id,
           exists (select 1 from user_identities ui
                    where ui.user_id = t.owner_user_id
                      and ui.provider = t.ticket_provider
                      and ui.kind = 'person') as owner_has_identity
      from tasks t
      left join users u on u.id = t.owner_user_id
     where t.id in (${sql.join(
       taskIds.map((taskId) => sql`${taskId}::uuid`),
       sql`, `,
     )})`);
  const assigning = await projectsAssigningOwners(
    database,
    rows.filter((row) => row.owner_has_identity === true).map((row) => row.project_id),
  );
  return new Map(
    rows.map((row) => [
      row.id,
      {
        ownerName: row.owner_name,
        heldElsewhere: row.held_elsewhere === true,
        assigneeUserId: row.assignee_user_id ?? null,
        // The duty's own predicate over the current owner (`ownerWriteBackFor`'s, per row).
        writesBack: ownerWriteBackReachesTracker({
          assignOwner: assigning.has(row.project_id),
          providerTicket: row.ticket_provider !== PLATFORM_TICKET_PROVIDER,
          hasPersonIdentity: row.owner_has_identity === true,
          shadow: row.mode === 'shadow',
        }),
      },
    ]),
  );
};

/**
 * `tracker_assignee` (S-26.8b's follow-up): who the tracker shows, off the stored assignee and the
 * user it resolves to live — `null` for no assignee and for the platform's own (`platform` true),
 * so it never names the platform; `user_id` only for a user who may own the project's tasks.
 */
export const trackerAssigneeOf = (
  assignee: TicketAssignee | null,
  resolvedUserId: string | null,
): TaskRecord['tracker_assignee'] =>
  assignee === null || assignee.platform
    ? null
    : { display_name: assignee.display_name, user_id: (resolvedUserId ?? null) as Id | null };

/**
 * `tracker_assignee` and `unlinked_assignee` off a stored `tasks.ticket_assignee` and the two live
 * predicates of its {@link OwnerView} — the task record's and the Inbox row's one spelling.
 */
const assigneeFieldsOf = (
  taskId: string,
  ticketAssignee: unknown,
  view: Pick<OwnerView, 'heldElsewhere' | 'assigneeUserId'> | undefined,
): Pick<TaskRecord, 'unlinked_assignee' | 'tracker_assignee'> => {
  const assignee = ticketAssigneeSchema.nullable().safeParse(ticketAssignee ?? null);
  if (!assignee.success) {
    throw new UnprojectableRowError(
      `task ${taskId}`,
      'its recorded tracker assignee (`tasks.ticket_assignee`) does not parse',
    );
  }
  return {
    unlinked_assignee:
      view?.heldElsewhere === true && assignee.data !== null
        ? { display_name: assignee.data.display_name }
        : null,
    tracker_assignee: trackerAssigneeOf(assignee.data, view?.assigneeUserId ?? null),
  };
};

/** The ownership fields of the task DTO, off the row and its {@link OwnerView}. */
const ownerFieldsOf = (
  row: typeof tasks.$inferSelect,
  view: OwnerView | undefined,
): Pick<
  TaskRecord,
  'owner' | 'owner_source' | 'unlinked_assignee' | 'owner_writes_back' | 'tracker_assignee'
> => {
  const { unlinked_assignee, tracker_assignee } = assigneeFieldsOf(
    row.id,
    row.ticketAssignee,
    view,
  );
  return {
    owner:
      row.ownerUserId === null
        ? null
        : { user_id: row.ownerUserId as Id, name: view?.ownerName ?? '' },
    owner_source: row.ownerSource ?? null,
    unlinked_assignee,
    // S-26.3: the binding's switch and the owner's account for the provider ({@link OwnerView}).
    owner_writes_back: row.ownerUserId !== null && view?.writesBack === true,
    tracker_assignee,
  };
};

/**
 * The title out of `tasks.ticket_snapshot`, or `null` when there is no snapshot.
 *
 * The column is `jsonb` typed by the writer, so the value is checked rather than trusted: a
 * snapshot whose `title` is not a string publishes `null` — the same answer as no snapshot —
 * instead of failing the whole page's schema.
 */
export const ticketTitleOf = (snapshot: unknown): string | null => {
  if (typeof snapshot !== 'object' || snapshot === null) {
    return null;
  }
  const title = (snapshot as { readonly title?: unknown }).title;
  return typeof title === 'string' ? title : null;
};

const toTaskRecord = (
  row: typeof tasks.$inferSelect,
  conflict: TaskConflict | null,
  estimatedUsd: number,
  unmeasuredRuns: number,
  paused: PausedWhy | undefined,
  owner: OwnerView | undefined,
): Omit<TaskRecord, 'waiting'> => ({
  id: row.id as Id,
  project_id: row.projectId as Id,
  ticket: { provider: row.ticketProvider, key: row.ticketKey, url: row.ticketUrl },
  // WP-95, Q48: the board card's title, read out of the snapshot the platform stored bounded and
  // redacted at the write (WP-15f) — never re-fetched, never derived from a branch name. `null` is
  // "the platform has not read the ticket", which the card says rather than drawing an empty title.
  ticket_title: ticketTitleOf(row.ticketSnapshot),
  template: row.template,
  mode: row.mode,
  state: row.state,
  current_stage: row.currentStage,
  size: row.size,
  branch: row.branch,
  mr_ref: row.mrRef,
  workpad_ref: row.workpadRef,
  iteration_counters: row.iterationCounters,
  risk_classes: row.riskClasses,
  // WP-39: read straight off `tasks.coverage`, which the `coverage` duty wrote already parsed
  // against this very schema. Nothing is computed here — in particular the delta is **not**
  // recomputed from the two percentages, because a projection that derived it would be a second
  // spelling of the subtraction and would disagree with the stored record the day one of them
  // changed (standing rule 41). `null` is published as `null`: "nothing measured" is an answer.
  coverage: row.coverage,
  // WP-38: the same rule one column across. The gate wrote this record already parsed against
  // `taskDependenciesSchema`, so nothing is re-derived here — in particular the decision is **not**
  // recomputed from the packages and the project's policy, because that would be a second reader of
  // a configuration that may have changed since, answering a question about what the gate *did*
  // with what the policy *now says*. `null` is published as `null`: "the gate has not run" is an
  // answer the panel prints differently from "it ran and nothing was added".
  dependencies: row.dependencies,
  // WP-38, product/10:38's other half: who the routing asked for a review from, including the
  // handles it could not resolve — which the `set_reviewers` audit row cannot say, because no call
  // is made when nothing resolved.
  required_reviewers: row.requiredReviewers,
  // WP-46, backlog 95 item 3: the review window's own reading of the merge request's human threads,
  // written by the job that computed the count (`saveReviewThreads`). Read straight off the column:
  // nothing here re-counts, and `null` — the window has not read them — is published as `null`.
  review_threads: row.reviewThreads,
  // WP-41, backlog 63: **not** a column — the latest `task.conflict.warned` off the task's own
  // stream (`conflictsFor`). `null` is "no warning has been appended for this task". Since WP-59
  // (backlog 65) the gate that finds an overlap appends on **both** streams, so a warned pair
  // carries a badge on both cards; `null` still does not mean "clear", only "no gate has compared
  // this task against an overlapping one yet", and the badge's tooltip says so.
  conflict,
  cost_actual_usd: usd(row.costActual),
  // WP-131, backlog 403: the runs `cost_actual_usd` excludes because nobody measured them — a
  // projection over `runs`, never a column, so it cannot drift from the rows the caps hold.
  unmeasured_runs: unmeasuredRuns,
  // WP-131 review round 1: the cap in force — the task's own override, else the default, which is
  // the only value `ProjectSettings.taskBudgetUsd` takes in this build — and why a paused task is.
  budget_cap_usd: row.budgetCapUsd === null ? DEFAULT_TASK_BUDGET_USD : usd(row.budgetCapUsd),
  paused_reason: row.state === 'paused' ? (paused?.reason ?? null) : null,
  paused_budget_scope: row.state === 'paused' ? (paused?.scope ?? null) : null,
  paused_budget_figures: row.state === 'paused' ? (paused?.figures ?? null) : null,
  // WP-47, backlog **75**: **not** a column. `tasks.cost_estimated` was `not null default 0` from
  // migration 0004 and had no writer anywhere in the tree, so every task the product ever served
  // published `$0.00` of estimated spend — "nobody counted" rendered as "nothing was estimated".
  // Migration 0035 drops it and this is a projection over `cost_entries where is_estimate`, the
  // per-row flag the ledger has written since WP-19: one number, one writer, nothing to keep in
  // step. A task with one priced and one reported run therefore publishes the **priced** amount and
  // not the sum, which `cost_estimated_usd`'s own definition says and the column never could.
  cost_estimated_usd: estimatedUsd,
  // The refinement estimate, its provenance, and product/19 §10's accuracy metric — which is
  // **computed from `estimate_usd` and `cost_actual` and from nothing else** (`estimateAccuracy`),
  // so there is no third number to keep in step. `estimate_basis` is null for a task the estimator
  // has not run on; `'unknown'` is the estimator's own refusal and is a different answer (WP-28).
  estimate_usd: row.estimateUsd === null ? null : usd(row.estimateUsd),
  estimate_basis: row.estimateBasis,
  estimate_samples: row.estimateSamples,
  estimate_accuracy: estimateAccuracy(
    row.estimateUsd === null ? null : usd(row.estimateUsd),
    usd(row.costActual),
  ),
  requested_by_user_id: row.requestedByUserId as Id | null,
  requested_by_identity: row.requestedByIdentity,
  created_at: isoRequired(row.createdAt),
  updated_at: isoRequired(row.updatedAt),
  completed_at: iso(row.completedAt),
  // WP-181 ruling (f): the claim and the QA flag, read straight off the two columns WP-177 added
  // (migration 0088). The claim column has one writer, which parses it at the write, so it is parsed
  // here at the read rather than trusted (a row that fails is a fault, never "never claimed").
  ticket_claim: ticketClaimViewOf(row.id, row.ticketClaim),
  qa_stage: row.qaStage,
  // S-26.1 (migration 0104): the owner, who set them, and the assignee who holds the ticket elsewhere.
  ...ownerFieldsOf(row, owner),
});

/**
 * `tasks.ticket_claim` as the task DTO publishes it (WP-170 ruling (d), WP-181 ruling (f)): the
 * record's own `status`, when it was claimed and when it was released — `null` for a task that never
 * claimed. `stale`, the account and the causes are the pipeline's bookkeeping and stay off the wire.
 *
 * A stored claim that fails its schema is refused like its neighbours — `UnprojectableRowError`,
 * naming the task and the failing paths, never the values — rather than a raw `ZodError` (a 500), and
 * never published as `null`, which would say the task never claimed (review round 1).
 */
export const ticketClaimViewOf = (taskId: string, stored: unknown): TaskRecord['ticket_claim'] => {
  if (stored === null || stored === undefined) {
    return null;
  }
  const parsed = storedTicketClaimSchema.safeParse(stored);
  if (!parsed.success) {
    const paths = parsed.error.issues
      .map((issue) => (issue.path.length === 0 ? '(root)' : issue.path.join('.')))
      .join(', ');
    throw new UnprojectableRowError(
      `task ${taskId}`,
      `its recorded ticket claim (\`tasks.ticket_claim\`) does not parse at ${paths}`,
    );
  }
  const claim = parsed.data;
  return { status: claim.status, claimed_at: claim.claimed_at, released_at: claim.released_at };
};

const toQuestionRecord = (row: typeof questions.$inferSelect): QuestionRecord => {
  if (row.stage === null) {
    throw new UnprojectableRowError(
      `question ${row.id}`,
      'it records no stage (`questions.stage` is null) and the API publishes the stage as a required field',
    );
  }
  return {
    id: row.id as Id,
    task_id: row.taskId as Id,
    stage: row.stage,
    run_id: row.runId as Id | null,
    text: row.text,
    options: row.options,
    blocking: row.blocking,
    status: row.status,
    asked_at: isoRequired(row.askedAt),
    deadline_at: iso(row.deadlineAt),
    reminders_sent: row.remindersSent,
    answer: row.answer,
    answered_by_user_id: row.answeredByUserId as Id | null,
    answered_via: row.answeredVia,
    answered_at: iso(row.answeredAt),
  };
};

/**
 * `task_stages.state`, **parsed** with the vocabulary the store writes it in (WP-55, PROGRESS
 * backlog 32) — `taskStageStateSchema` in `@platform/contracts`, the one list the writer, this
 * publisher and migration 0040's check constraint share.
 *
 * Until WP-55 this was a mapping from the store's `entered`/`exited` onto the DTO's six words that
 * answered `pending` for anything it did not recognise, `completed` for a stage the pipeline had
 * returned, and `running` for a gate the task had walked past (its row was never closed). There is
 * nothing to map any more, and an unknown word is an **error**: a projection that defaults cannot
 * fail when a new writer invents a word, and it is the screen that then states something false.
 */
export const stageStateOf = (row: {
  readonly stage: string;
  readonly attempt: number;
  readonly state: string;
}): TaskStageState => {
  const parsed = taskStageStateSchema.safeParse(row.state);
  if (!parsed.success) {
    throw new UnknownStageStateError(row);
  }
  return parsed.data;
};

/**
 * A `task_stages` row whose `state` is outside `taskStageStateSchema` (WP-55). Fail-closed — the
 * task page is not served a guess — but named: the row and the word, not a bare `ZodError`.
 * Unreachable on a migrated database (`task_stages_state_known` refuses the write); it is the
 * projection's answer to a database that is not.
 */
export class UnknownStageStateError extends Error {
  override readonly name = 'UnknownStageStateError';
  constructor(row: { readonly stage: string; readonly attempt: number; readonly state: string }) {
    super(
      `task_stages row ${row.stage}#${String(row.attempt)} has state ${JSON.stringify(row.state)}, which is not one of ${taskStageStateSchema.options.join(', ')}`,
    );
  }
}

/**
 * `task_stages.outcome` in the one vocabulary (WP-73, PROGRESS backlog 213). Every write since
 * WP-73 is parsed by the store; a row written before it may hold a word outside the list (a
 * model's own verdict text among them), and that is published as `unrecognised` — the word the
 * vocabulary keeps for exactly this — rather than served raw or dropped.
 */
const stageOutcomeOf = (outcome: string | null): TaskStageOutcome | null => {
  if (outcome === null) {
    return null;
  }
  const parsed = taskStageOutcomeSchema.safeParse(outcome);
  return parsed.success ? parsed.data : 'unrecognised';
};

/**
 * The session of the run a take-over stopped, once that run has ended (WP-85).
 *
 * Since TD-028 decision 9 the process that records a take-over is, on the shipped topology, never
 * the one holding the run, so `task.taken_over` carries the run's id and no session — the session
 * is in the holder's handle. `runs.session_id` is written when the stopped run ends, so it is read
 * from there: `null` while the run is still winding down (or if it never had a session), which the
 * screen says, and never a guess.
 */
const stoppedRunSession = async (
  database: Database,
  runId: string | null,
): Promise<string | null> => {
  if (runId === null) {
    return null;
  }
  const rows = await database
    .select({ sessionId: runs.sessionId })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);
  const sessionId = rows[0]?.sessionId ?? null;
  return sessionId === null || sessionId === '' ? null : sessionId;
};

/**
 * The take-over in force on a task, or `null` — WP-27, and the one projection here that reads the
 * **event log** rather than a row.
 *
 * It has to: `tasks` records that a task is `paused` and not *why*. The session id of the run a
 * take-over interrupted was on the event while the process recording it held the run; since WP-85
 * the event carries the run's id and the session is read off that run once it has ended
 * ({@link stoppedRunSession}).
 *
 * **Which events decide is `TAKE_OVER_BOUNDARY_EVENTS`, imported rather than restated, and there is
 * no state guard** (WP-44, PROGRESS backlog 164). The workpad asks `TaskRepository.takenOver` the
 * same question over the same list, so the ticket and this page cannot disagree about who holds a
 * task: a hand-back, a resume, a stage entry, a completion or a cancellation withdraws it, and an
 * escalation does not. Until WP-44 this read `task.taken_over`/`task.handed_back` only and published
 * nothing unless the task was `paused`, so a take-over the inactivity timer escalated vanished from
 * the page that carries the hand-back control while the workpad and the brief still named its
 * branch.
 *
 * One thing it refuses to invent: a payload that does not carry a `branch` and a `stage` publishes
 * **nothing** rather than a blank block, because the branch is the whole point of the record.
 */
const findTakenOver = async (
  database: Database,
  task: HandBackTask & { readonly id: string },
): Promise<TaskDetailResponse['taken_over']> => {
  const rows = await database
    .select({
      type: events.type,
      payload: events.payload,
      occurredAt: events.occurredAt,
      actor: events.actor,
    })
    .from(events)
    .where(
      and(
        eq(events.streamType, 'task'),
        eq(events.streamId, task.id),
        inArray(events.type, [...TAKE_OVER_BOUNDARY_EVENTS]),
      ),
    )
    .orderBy(desc(events.streamSeq))
    .limit(1);
  const row = rows[0];
  if (row === undefined || row.type !== 'task.taken_over') {
    return null;
  }
  const branch = row.payload.branch;
  const stage = row.payload.stage;
  if (typeof branch !== 'string' || typeof stage !== 'string') {
    return null;
  }
  // Absent on an event written before WP-73 (backlog 203): published as not recorded, never as
  // "no run", because the two mean different things to the screen.
  const runRecorded = 'run_id' in row.payload;
  const runId = typeof row.payload.run_id === 'string' ? row.payload.run_id : null;
  const sessionId =
    typeof row.payload.session_id === 'string'
      ? row.payload.session_id
      : await stoppedRunSession(database, runId);
  return {
    at: isoRequired(row.occurredAt),
    branch,
    session_id: sessionId,
    stage,
    resume_commands: [...resumeCommands(branch, sessionId)],
    held_by: row.actor.kind === 'user' ? row.actor.user_id : null,
    run_id: runId,
    run_recorded: runRecorded,
    hand_back_stages: handBackStagesOf(task),
  };
};

/**
 * The stages a hand-back may name — the task's compiled pipeline, enabled stages only (WP-44), as
 * far as `handBackTaskCommand` admits them for this task (`handBackStages`, WP-165).
 *
 * The same computation `handBackTaskCommand` refuses against (`compilePipeline` over the task's
 * frozen template, falling back to the shipped one for a row written before snapshots, exactly as
 * the pipeline store loads it), so the picker and the route cannot disagree. A template this build
 * cannot compile answers `[]` — the screen then says the stages cannot be read — rather than a list
 * the route would refuse (standing rule 20's read side: refuse, never invent). A **merged** task
 * answers `[]` as well (Q117 (a)): it is never handed back before the merge, and from a pause it
 * reaches nothing after it.
 */
export const handBackStagesOf = (task: HandBackTask): string[] =>
  handBackStages(
    {
      state: task.state as TaskState,
      currentStage: task.currentStage,
      stageAttempts: task.stageAttempts as Readonly<Record<string, number>>,
    },
    (compiledPipelineOf(task)?.stages ?? [])
      .filter((stage) => stage.enabled)
      .map((stage) => stage.id),
  );

/** What {@link handBackStagesOf} reads: the compiled pipeline's columns and the task's position. */
interface HandBackTask extends CompilableTask {
  readonly state: string;
  readonly currentStage: string | null;
  /** `tasks.stage_attempts`: a task that entered `merged_gate` was merged (`isMergedTask`). */
  readonly stageAttempts: unknown;
}

/** The columns a task's compiled pipeline is made from. */
interface CompilableTask {
  readonly template: string;
  readonly templateSnapshot: unknown;
  /** `tasks.pipeline_dial` (WP-62): a stage the dial disabled is not one a hand-back may name. */
  readonly pipelineDial: unknown;
  /** `tasks.qa_stage` (migration 0088, WP-177): whether the frozen pipeline has the `qa` stage. */
  readonly qaStage: boolean;
}

/**
 * The task's compiled pipeline, as `handBackTaskCommand` and the store compile it, or `null` when
 * this build cannot compile it — which every reader here answers by offering nothing.
 */
const compiledPipelineOf = (task: CompilableTask): CompiledPipeline | null => {
  const snapshot = task.templateSnapshot;
  const template =
    snapshot !== null && typeof snapshot === 'object' && 'stages' in snapshot
      ? (snapshot as PipelineTemplate)
      : SHIPPED_TEMPLATES[task.template];
  if (template === undefined) {
    return null;
  }
  // Parsed as the store parses it, and refused the same way: a document that does not match its
  // schema is a pipeline this build cannot compile, so the picker offers nothing.
  const dial =
    task.pipelineDial === null || task.pipelineDial === undefined
      ? null
      : taskPipelineDialSchema.safeParse(task.pipelineDial);
  if (dial !== null && !dial.success) {
    return null;
  }
  try {
    return compilePipeline(task.template, template, dial === null ? null : dial.data, task.qaStage);
  } catch {
    return null;
  }
};

/**
 * **What a return out of this escalation would carry** (WP-152, PROGRESS backlog 491): the parked
 * gate attempt's stored failure, as a length — the box the return dialog offers. The same three
 * facts the command checks (`keepGateFeedback`): the task is `needs_human`, the stage it is at is a
 * **gate** in its compiled pipeline, and that stage's latest attempt was closed `returned` with a
 * reason. `null` otherwise, and the dialog then offers no box — a request that ticks one anyway is
 * refused `no_gate_feedback`. Never the text: it is provider output, and the count is all the
 * dialog needs.
 */
const gateFeedbackOf = (
  task: CompilableTask & { readonly state: string; readonly currentStage: string | null },
  stageRows: readonly (typeof taskStages.$inferSelect)[],
): TaskDetailResponse['gate_feedback'] => {
  const stage = task.currentStage;
  if (task.state !== 'needs_human' || stage === null) {
    return null;
  }
  if (compiledPipelineOf(task)?.stages.find((entry) => entry.id === stage)?.kind !== 'gate') {
    return null;
  }
  const latest = stageRows
    .filter((row) => row.stage === stage)
    .reduce<(typeof stageRows)[number] | null>(
      (newest, row) => (newest === null || row.attempt > newest.attempt ? row : newest),
      null,
    );
  if (
    latest === null ||
    latest.state !== 'returned' ||
    latest.returnReason === null ||
    latest.returnReason.length === 0
  ) {
    return null;
  }
  return {
    stage,
    attempt: latest.attempt,
    chars: latest.returnReason.length,
    original_chars: latest.returnReasonOriginalChars ?? null,
  };
};

type StageRowSelect = typeof taskStages.$inferSelect;

/**
 * The columns of a `task_stages` row the CI wait reads — what the task read's whole rows and the
 * board's page's narrow ones (`stageRowsFor`, backlog 1300) both carry.
 */
type GateStageRow = Pick<
  StageRowSelect,
  'taskId' | 'stage' | 'attempt' | 'state' | 'outcome' | 'enteredAt' | 'exitedAt' | 'ciPendingRead'
>;

/** The newest `ci_gate` attempt among a task's rows, or `null`. */
const latestCiGateRow = <R extends GateStageRow>(stageRows: readonly R[]): R | null =>
  stageRows
    .filter((row) => row.stage === CI_GATE_STAGE)
    .reduce<R | null>(
      (newest, row) => (newest === null || row.attempt > newest.attempt ? row : newest),
      null,
    );

/**
 * A row's recorded CI read as the DTO's {@link gateWaitSchema} shape, or `null` when it has none. The
 * stored value is parsed with the writer's strict schema and a value that does not match is
 * **refused** by name ({@link UnprojectableRowError}), never served as `null`. `waiting_since` is the
 * attempt's own `entered_at`, which the CI timeout counts from — read off the row, not copied into
 * the value.
 */
const recordedGateWaitOf = (row: GateStageRow): GateWait | null => {
  if (row.ciPendingRead === null || row.ciPendingRead === undefined) {
    return null;
  }
  const parsed = ciPendingReadSchema.safeParse(row.ciPendingRead);
  if (!parsed.success) {
    const paths = parsed.error.issues
      .map((issue) => (issue.path.length === 0 ? '(root)' : issue.path.join('.')))
      .join(', ');
    throw new UnprojectableRowError(
      `task ${row.taskId}`,
      `the CI gate's recorded read (\`task_stages.ci_pending_read\`, attempt ${row.attempt}) does not parse at ${paths}`,
    );
  }
  return toGateWait(parsed.data, isoRequired(row.enteredAt));
};

/**
 * **What the CI gate is waiting on** (backlog 1078): the open `ci_gate` attempt's last pending read,
 * when the task is `active` at `ci_gate` — `null` for any other stage, a closed attempt (a parked,
 * settled or superseded one keeps its read; {@link lastGateWaitOf} serves a parked one), an attempt
 * whose last read found no pipeline, and **a task that is not runnable** (backlog 1301): a pause
 * closes no stage row and the CI job stops checking a paused task, so its open attempt is a wait
 * nothing is performing. The task read, the board's page and the inbox's `ci_held` all answer
 * through this one function.
 */
export const gateWaitOf = (
  task: { readonly state: string; readonly currentStage: string | null },
  stageRows: readonly GateStageRow[],
): TaskDetailResponse['gate_wait'] => {
  if (task.state !== 'active' || task.currentStage !== CI_GATE_STAGE) {
    return null;
  }
  const latest = latestCiGateRow(stageRows);
  return latest === null || latest.state !== 'running' || latest.exitedAt !== null
    ? null
    : recordedGateWaitOf(latest);
};

/**
 * **The parked CI wait's last read** (backlog 1078's review; product/10's *"CI did not finish within
 * 60 minutes: pipeline n was still held at the manual job X"*). Served exactly when:
 *
 *  1. the task is `needs_human` **and** its current stage is `ci_gate` — the state the gate's own
 *     escalation leaves (an escalation parks the task at the stage it was at);
 *  2. the newest `ci_gate` attempt is closed `failed` with outcome `undecided` — the one word every
 *     no-answer ending of the gate writes (its CI timeout, its five checks or backstop, a provider
 *     that did not answer, a Retry on the unchanged held pipeline); a `converged` or `unsupported`
 *     ending, a person's return (`returned`) or a superseded attempt is not a wait that ended;
 *  3. that attempt recorded a read (its last one found a pipeline).
 *
 * `null` otherwise — and always `null` while {@link gateWaitOf} is set, since that one needs the
 * newest attempt open and this one needs it closed.
 */
export const lastGateWaitOf = (
  task: { readonly state: string; readonly currentStage: string | null },
  stageRows: readonly GateStageRow[],
): TaskDetailResponse['gate_wait'] => {
  if (task.state !== 'needs_human' || task.currentStage !== CI_GATE_STAGE) {
    return null;
  }
  const latest = latestCiGateRow(stageRows);
  return latest === null || latest.state !== 'failed' || latest.outcome !== 'undecided'
    ? null
    : recordedGateWaitOf(latest);
};

/**
 * **What the latest CI pass left unstarted** (S-27.2, TD-036 decision 5): the newest `ci_gate`
 * attempt closed `completed` — a pass — and its `task_stages.ci_manual_not_run`, parsed with the
 * writer's strict schema; `null` when that attempt recorded none or no attempt has passed. A stored
 * value that does not parse is **refused** by name ({@link UnprojectableRowError}), never served as
 * `null`, as {@link recordedGateWaitOf} refuses a read. Whatever the task's state: the page's Checks
 * item and its Ready callout both read it.
 */
export const ciManualNotRunOf = (
  stageRows: readonly Pick<
    StageRowSelect,
    'taskId' | 'stage' | 'attempt' | 'state' | 'ciManualNotRun'
  >[],
): TaskDetailResponse['ci_manual_not_run'] => {
  const passed = stageRows
    .filter((row) => row.stage === CI_GATE_STAGE && row.state === 'completed')
    .reduce<(typeof stageRows)[number] | null>(
      (newest, row) => (newest === null || row.attempt > newest.attempt ? row : newest),
      null,
    );
  if (passed === null || passed.ciManualNotRun === null || passed.ciManualNotRun === undefined) {
    return null;
  }
  const parsed = ciManualNotRunSchema.safeParse(passed.ciManualNotRun);
  if (!parsed.success) {
    const paths = parsed.error.issues
      .map((issue) => (issue.path.length === 0 ? '(root)' : issue.path.join('.')))
      .join(', ');
    throw new UnprojectableRowError(
      `task ${passed.taskId}`,
      `what the CI gate's pass left unstarted (\`task_stages.ci_manual_not_run\`, attempt ${passed.attempt}) does not parse at ${paths}`,
    );
  }
  return parsed.data;
};

/**
 * **The manual jobs the platform started on the latest CI attempt** (S-28.7): the newest `ci_gate`
 * attempt, whatever its state, and its `task_stages.ci_manual_started`, parsed with the writer's
 * strict schema; `null` when that attempt recorded none or the task never reached the gate. A stored
 * value that does not parse is **refused** by name, as {@link ciManualNotRunOf} refuses one.
 */
export const ciManualStartedOf = (
  stageRows: readonly Pick<StageRowSelect, 'taskId' | 'stage' | 'attempt' | 'ciManualStarted'>[],
): TaskDetailResponse['ci_manual_started'] => {
  const newest = stageRows
    .filter((row) => row.stage === CI_GATE_STAGE)
    .reduce<(typeof stageRows)[number] | null>(
      (latest, row) => (latest === null || row.attempt > latest.attempt ? row : latest),
      null,
    );
  if (newest === null || newest.ciManualStarted === null || newest.ciManualStarted === undefined) {
    return null;
  }
  const parsed = ciManualStartedSchema.safeParse(newest.ciManualStarted);
  if (!parsed.success) {
    const paths = parsed.error.issues
      .map((issue) => (issue.path.length === 0 ? '(root)' : issue.path.join('.')))
      .join(', ');
    throw new UnprojectableRowError(
      `task ${newest.taskId}`,
      `the manual jobs the platform started (\`task_stages.ci_manual_started\`, attempt ${newest.attempt}) do not parse at ${paths}`,
    );
  }
  return parsed.data;
};

/**
 * What the reads that carry `waiting` (S-26.5) need from the composition: the core's current run
 * and egress digests, which a machine's claim compares with what it holds — `null` when this
 * process has no worker release, and then no machine is counted as able to claim, as none can.
 */
export interface WaitingReadOptions {
  readonly coreDigests?: RunImageDigests | null;
  /**
   * `false` skips the `waiting` statement and answers `waiting: null` — for a reader that never
   * shows or reads it (`get_task_context`, an agent's tool, whose sections name no such field).
   * Absent or `true`: it is read.
   */
  readonly waiting?: boolean;
  /**
   * The project's WIP limits as the scheduler is given them (S-25.16) — `queue_wait` is read with
   * them for a `queued` task. Absent: `queue_wait` is `null` (a reader that does not ask, as an
   * agent's `get_task_context` does not); the routes always pass it.
   */
  readonly wipLimits?: WipLimitsReader;
}

/** `GET /api/tasks/:task_id` — the task with its stages, artifacts, questions, approvals and runs. */
export const findTaskDetail = async (
  database: Database,
  taskId: string,
  options: WaitingReadOptions = {},
): Promise<TaskDetailRecord | null> => {
  const taskRows = await database.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  const task = taskRows[0];
  if (task === undefined) {
    return null;
  }

  const [stageRows, artifactRows, questionRows, approvalRows, runRows] = await Promise.all([
    database
      .select()
      .from(taskStages)
      .where(eq(taskStages.taskId, taskId))
      .orderBy(asc(taskStages.enteredAt), asc(taskStages.attempt)),
    database
      .select({ id: artifacts.id, type: artifacts.type, version: artifacts.version })
      .from(artifacts)
      .where(eq(artifacts.taskId, taskId))
      .orderBy(asc(artifacts.createdAt), asc(artifacts.version)),
    database
      .select()
      .from(questions)
      .where(eq(questions.taskId, taskId))
      .orderBy(asc(questions.askedAt)),
    database
      .select()
      .from(approvals)
      .where(eq(approvals.taskId, taskId))
      .orderBy(asc(approvals.requestedAt)),
    database
      .select(runColumns)
      .from(runs)
      .leftJoin(taskStages, eq(taskStages.id, runs.taskStageId))
      .where(eq(runs.taskId, taskId))
      .orderBy(asc(runs.createdAt)),
  ]);

  const [
    usage,
    progress,
    stops,
    takenOver,
    humanTime,
    conflicts,
    estimated,
    unmeasured,
    pausedReasons,
    owners,
    waiting,
    escalation,
    cancellation,
    queueWaits,
  ] = await Promise.all([
    modelUsageFor(
      database,
      runRows.map((row) => row.id),
    ),
    latestProgressFor(
      database,
      runRows.map((row) => row.id),
    ),
    stopReasonsFor(
      database,
      runRows.map((row) => row.id),
    ),
    findTakenOver(database, task),
    // The project id comes from the task row rather than from the request: the breakdown setting
    // belongs to the project that owns the task, and a caller cannot name a different one.
    findHumanTime(database, taskId, task.projectId),
    conflictsFor(database, [taskId]),
    estimatedSpendFor(database, [taskId]),
    unmeasuredRunsFor(database, [taskId]),
    pausedReasonsFor(database, task.state === 'paused' ? [taskId] : []),
    ownerViewsFor(database, [taskId]),
    // S-26.5: why the current stage's run waits, off the claim's own predicates.
    options.waiting === false
      ? null
      : waitingForTasks(database, [taskId], options.coreDigests ?? null),
    escalationFor(database, task),
    // S-28.14: why a cancelled task was cancelled, and whether the platform did it.
    cancellationFor(database, task),
    // S-25.16: why a queued task waits — the scheduler's admission, its limits and its order.
    options.wipLimits === undefined || task.state !== 'queued'
      ? new Map<string, QueueWait>()
      : queueWaitsFor(database, task.projectId, [task.id], options.wipLimits),
  ]);
  // S-25.20: who paused it by hand, when and why — read only for a `manual` pause.
  const manualPause = await manualPauseFor(
    database,
    task,
    pausedReasons.get(task.id)?.reason ?? null,
  );
  // S-28.2: the words at the current human stage that were not treated as a change request.
  const conversationSeen = await conversationSeenFor(database, task);

  const setbackRows = stageRows.map(setbackRowOf);
  return {
    task: {
      ...toTaskRecord(
        task,
        conflicts.get(task.id) ?? null,
        estimated.get(task.id) ?? 0,
        unmeasured.get(task.id) ?? 0,
        pausedReasons.get(task.id),
        owners.get(task.id),
      ),
      waiting: waiting === null ? null : (waiting.get(task.id) ?? null),
    },
    taken_over: takenOver,
    human_time: humanTime,
    gate_feedback: gateFeedbackOf(task, stageRows),
    gate_wait: gateWaitOf(task, stageRows),
    last_gate_wait: lastGateWaitOf(task, stageRows),
    // S-27.2: the manual jobs the latest CI pass left unstarted.
    ci_manual_not_run: ciManualNotRunOf(stageRows),
    // S-28.7: the manual jobs the platform started (or could not) on the latest CI attempt.
    ci_manual_started: ciManualStartedOf(stageRows),
    // S-28.10: what is out of sync with the provider, if anything — nothing for a finished task.
    provider_sync: [...(await providerSyncFor(database, taskId, task.state))],
    queue_wait: queueWaits.get(task.id) ?? null,
    manual_pause: manualPause,
    conversation_seen: conversationSeen,
    // S-25.11: the returns and the stop, off the same rows.
    returns: returnsOf(setbackRows, compiledPipelineOf(task)),
    stop: stopOf(task, setbackRows),
    escalation,
    cancellation,
    loop_limits: frozenLimits(task.iterationLimits),
    stages: stageRows.map((row) => ({
      stage: row.stage,
      attempt: row.attempt,
      state: stageStateOf(row),
      entered_at: isoRequired(row.enteredAt),
      exited_at: iso(row.exitedAt),
      outcome: stageOutcomeOf(row.outcome),
    })),
    artifacts: artifactRows.map((row) => ({
      id: row.id as Id,
      artifact_type: row.type,
      version: row.version,
      // Where the body is served (WP-52, PROGRESS backlog 85). It was a literal `null` here — and
      // the SPA renders a link only when it is not — so every artifact on every task screen was a
      // row you could see and not open. `artifactBodyPath` is the one spelling of the path, shared
      // with the route that answers it.
      url: artifactBodyPath(row.id),
    })),
    questions: questionRows.map(toQuestionRecord),
    // TD-035: each with what it approves and why — recorded, derived by the one exact chain, or null.
    approvals: await approvalViewsFor(database, approvalRows),
    runs: runRows.map((row) =>
      toRunRecord(
        row,
        usage.get(row.id) ?? [],
        progress.get(row.id) ?? null,
        stops.get(row.id) ?? null,
      ),
    ),
  };
};

/**
 * **What is out of sync with the provider** (S-28.10, TD-029's amendment C): the task's
 * `task_provider_sync` rows, oldest first, each parsed with the published shape — a row that does
 * not parse is refused by name rather than served half-read.
 */
export const providerSyncFor = async (
  database: Database,
  taskId: string,
  state: string,
): Promise<readonly ProviderSync[]> => {
  // A done or cancelled task's ticket and merge request are no longer the platform's to move: a
  // record left from before is history, never a notice (S-28.10 review). A merged task's merge
  // request is merged, so a "still a draft" record about it is history too.
  if (state === 'done' || state === 'cancelled') {
    return [];
  }
  const merged = state === 'merged' || state === 'retro';
  const rows = await database
    .select()
    .from(taskProviderSync)
    .where(eq(taskProviderSync.taskId, taskId))
    .orderBy(asc(taskProviderSync.failedAt), asc(taskProviderSync.subject));
  const synced = rows
    .filter((row) => !(merged && row.subject === 'merge_request_draft'))
    .map((row) => {
      const parsed = providerSyncSchema.safeParse({
        subject: row.subject,
        slot: row.slot,
        target: row.target,
        observed: row.observed,
        available: row.available,
        reason: row.reason,
        reason_code: row.reasonCode,
        failed_at: row.failedAt.toISOString(),
        attempts: row.attempts,
      });
      if (!parsed.success) {
        throw new UnprojectableRowError(
          `task_provider_sync (${taskId}, ${row.subject})`,
          'it does not parse as the published out-of-sync shape',
        );
      }
      return parsed.data;
    });
  return state === 'ready_for_merge'
    ? [...synced, ...(await mergeBlockedFor(database, taskId))]
    : synced;
};

/**
 * **"Ready to merge" tells the truth about the provider** (S-28.13, M28 ruling R3b (3)): the task's
 * `task_merge_checks` row when its last check read "the provider will not merge it now", served as
 * the `merge_request_blocked` subject — `target` `mergeable`, `observed` the provider's own word,
 * `reason_code` the port's reason and `unresolved_threads` the count. Read only at Ready (the
 * caller's), so a row from an earlier Ready entry never speaks for a task that moved on. Every
 * value is held by the table's checks; a row that does not parse is refused by name.
 */
const mergeBlockedFor = async (
  database: Database,
  taskId: string,
): Promise<readonly ProviderSync[]> => {
  const rows = await database
    .select()
    .from(taskMergeChecks)
    .where(and(eq(taskMergeChecks.taskId, taskId), eq(taskMergeChecks.mergeable, false)));
  return rows.map((row) => {
    const parsed = providerSyncSchema.safeParse({
      subject: 'merge_request_blocked',
      slot: null,
      target: 'mergeable',
      observed: row.providerStatus,
      available: null,
      reason: row.providerStatus ?? row.reason ?? 'not mergeable',
      reason_code: row.reason,
      failed_at: (row.checkedAt ?? row.claimedAt).toISOString(),
      attempts: 1,
      unresolved_threads: row.unresolvedThreads,
    });
    if (!parsed.success) {
      throw new UnprojectableRowError(
        `task_merge_checks (${taskId})`,
        'it does not parse as the published out-of-sync shape',
      );
    }
    return parsed.data;
  });
};

/**
 * Why a `needs_human` task waits for a person, in the escalation's own words (BACKLOG 850): its
 * newest `task.escalated` event's `reason` and `blocker_brief`, with the instant. Every production
 * escalation writes a brief that names what stopped the task and the way out — *the ticket is
 * assigned to somebody else…*, *nobody decided the plan approval in time…*, *pipeline n is held at
 * a manual job…* — and until this read the task page published none of it, so every stuck task said
 * only that it needed a person (five on the Autix core on 2026-11-07, none of them explained).
 *
 * The twin of the onboarding wizard's `createDiscoveryEscalationRead` (`../onboarding.ts`): the same
 * event, the same order (newest instant, then position, so a second escalation replaces the first),
 * the same cut at {@link NOTIFICATION_DETAIL_MAX} with the pre-cut length, and `null` for a payload
 * missing either string rather than half a reason. Read only for a `needs_human` task: an escalation
 * the task has since left (a hand-back, a retry) is history, not why it waits.
 */
export const escalationFor = async (
  database: Database,
  task: { readonly id: string; readonly state: string },
): Promise<TaskEscalation | null> => {
  if (task.state !== 'needs_human') {
    return null;
  }
  const rows = await database
    .select({ occurredAt: events.occurredAt, payload: events.payload })
    .from(events)
    .where(
      and(
        eq(events.streamType, 'task'),
        eq(events.streamId, task.id),
        eq(events.type, 'task.escalated'),
      ),
    )
    .orderBy(desc(events.occurredAt), desc(events.position))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : escalationOfRow(row);
};

/**
 * **Why a cancelled task was cancelled** (M28 ruling 4b, S-28.14): its newest `task.cancelled`
 * event's `outcome` and instant, and whether the platform did it (the event's actor is not a
 * person). Read only for a `cancelled` task; the same order and the same cut as
 * {@link escalationFor}, and `null` for a payload with no outcome rather than an invented one.
 */
export const cancellationFor = async (
  database: Database,
  task: { readonly id: string; readonly state: string },
): Promise<TaskCancellation | null> => {
  if (task.state !== 'cancelled') {
    return null;
  }
  const rows = await database
    .select({ occurredAt: events.occurredAt, payload: events.payload, actor: events.actor })
    .from(events)
    .where(
      and(
        eq(events.streamType, 'task'),
        eq(events.streamId, task.id),
        eq(events.type, 'task.cancelled'),
      ),
    )
    .orderBy(desc(events.occurredAt), desc(events.position))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  const outcome = (row.payload as { readonly outcome?: unknown } | null)?.outcome;
  if (typeof outcome !== 'string' || outcome === '') {
    return null;
  }
  const actorKind = (row.actor as { readonly kind?: unknown } | null)?.kind;
  return {
    at: isoRequired(row.occurredAt),
    outcome: outcome.slice(0, NOTIFICATION_DETAIL_MAX),
    outcome_original_chars: outcome.length > NOTIFICATION_DETAIL_MAX ? outcome.length : null,
    automatic: actorKind !== 'user',
  };
};

/**
 * **Who paused a task by hand, when and why** (S-25.20, {@link taskManualPauseSchema}): read only for
 * a task `paused` for the `manual` reason — a budget's or a take-over's pause has its own words.
 *
 * The pause is the one `task.pause` or `run.cancel` row of `human_actions` for the task (a run's
 * *Cancel run* pauses its task) written **within a minute either side** of the task's newest
 * `task.paused` event — the command writes its row just after its transaction committed the event,
 * and the minute absorbs the two clocks (the event's instant is the process's, the row's the
 * database's). Bounded on **both** sides (review of #126): a *Cancel run* on a task already paused
 * writes a `run.cancel` row and no new `task.paused` (`pauseForCancel`), so an unbounded "newest
 * since the event" named the person who cancelled hours later and dropped the pauser's reason. And
 * **exactly one** such row: two inside the window cannot be told apart, and a false *who* is worse
 * than none, so the read then answers `null` (*the record does not say who*). `reason` is the
 * command's own redacted text (`pipeline/commands.ts`'s
 * `auditedReason`), cut here at {@link MAX_TASK_PAUSE_REASON_CHARS}. No row: `null`, never a guess.
 */
/**
 * **Seen, not a change request** (S-28.2, M28 ruling R1): the handled ledger's `seen` rows for the
 * task's current human stage (`qa`, `ready_for_merge`), recorded since its latest entry into that
 * stage, newest first, at most {@link MAX_TASK_CONVERSATION_SEEN}. `[]` at every other stage — a
 * word the window read at an earlier visit was either answered by the run it returned, or belongs
 * to a stage the task has left. The author is stored redacted and bounded; it is rendered as text.
 */
export const conversationSeenFor = async (
  database: Database,
  task: { readonly id: string; readonly currentStage: string | null },
): Promise<TaskConversationSeen[]> => {
  if (task.currentStage !== 'qa' && task.currentStage !== 'ready_for_merge') {
    return [];
  }
  const { rows } = await database.execute<{
    source: string;
    author: string | null;
    written_ms: unknown;
    seen_ms: unknown;
  }>(sql`
    with entry as (
      select max(s.entered_at) as entered_at
        from task_stages s
       where s.task_id = ${task.id}::uuid and s.stage = ${task.currentStage}
    )
    select h.source, h.author,
           (extract(epoch from h.written_at) * 1000)::float8 as written_ms,
           (extract(epoch from h.handled_at) * 1000)::float8 as seen_ms
      from task_conversation_handled h, entry
     where h.task_id = ${task.id}::uuid
       and h.kind = 'seen'
       and entry.entered_at is not null
       and h.handled_at >= entry.entered_at
     order by h.handled_at desc, h.id desc
     limit ${MAX_TASK_CONVERSATION_SEEN}`);
  return rows.flatMap((row): TaskConversationSeen[] => {
    const parsed = taskConversationSeenSchema.safeParse({
      source: row.source,
      author: row.author,
      written_at: row.written_ms === null ? null : new Date(Number(row.written_ms)).toISOString(),
      seen_at: new Date(Number(row.seen_ms)).toISOString(),
    });
    // A row outside the published shape is left out rather than invented into one.
    return parsed.success ? [parsed.data] : [];
  });
};

export const manualPauseFor = async (
  database: Database,
  task: { readonly id: string; readonly state: string },
  pausedReason: string | null,
): Promise<TaskManualPause | null> => {
  if (task.state !== 'paused' || pausedReason !== 'manual') {
    return null;
  }
  const { rows } = await database.execute<{
    action: string;
    user_id: string | null;
    user_name: string | null;
    reason: unknown;
    at_ms: unknown;
  }>(sql`
    with paused as (
      select e.occurred_at
        from events e
       where e.stream_type = 'task'
         and e.stream_id = ${task.id}::uuid
         and e.type = 'task.paused'
       order by e.occurred_at desc, e.position desc
       limit 1
    )
    select h.action, h.user_id::text as user_id, u.name as user_name,
           h.params -> 'reason' as reason,
           (extract(epoch from h.created_at) * 1000)::float8 as at_ms
      from human_actions h
      join paused p
        on h.created_at between p.occurred_at - interval '1 minute'
                            and p.occurred_at + interval '1 minute'
      left join users u on u.id = h.user_id
     where h.task_id = ${task.id}::uuid
       and h.action in ('task.pause', 'run.cancel')
     order by h.created_at desc, h.id desc
     limit 2`);
  // Exactly one row beside the event, or no answer: two cannot be told apart (review of #126).
  const row = rows.length === 1 ? rows[0] : undefined;
  const atMs = row === undefined ? null : Number(row.at_ms);
  if (row === undefined || atMs === null || !Number.isFinite(atMs)) {
    return null;
  }
  const reason = typeof row.reason === 'string' && row.reason.trim() !== '' ? row.reason : null;
  return {
    at: new Date(atMs).toISOString() as IsoDateTime,
    by:
      row.user_id === null
        ? null
        : {
            user_id: row.user_id as Id,
            name: row.user_name === null || row.user_name === '' ? null : row.user_name,
          },
    via: row.action === 'run.cancel' ? 'run_cancel' : 'pause',
    reason: reason === null ? null : reason.slice(0, MAX_TASK_PAUSE_REASON_CHARS),
    reason_cut: reason !== null && reason.length > MAX_TASK_PAUSE_REASON_CHARS,
  };
};

/**
 * One `task.escalated` row as {@link taskEscalationSchema} publishes it — `null` for a payload
 * missing either string rather than half a reason. The one reading {@link escalationFor} and
 * {@link escalationsFor} share, so the task page, the board's page and the Inbox say one reason.
 */
const escalationOfRow = (row: {
  readonly occurredAt: Date;
  readonly payload: unknown;
}): TaskEscalation | null => {
  const payload = (row.payload ?? {}) as {
    readonly reason?: unknown;
    readonly blocker_brief?: unknown;
  };
  if (
    typeof payload.reason !== 'string' ||
    payload.reason === '' ||
    typeof payload.blocker_brief !== 'string' ||
    payload.blocker_brief === ''
  ) {
    return null;
  }
  const brief = payload.blocker_brief;
  return {
    at: isoRequired(row.occurredAt),
    reason: payload.reason,
    brief: brief.slice(0, NOTIFICATION_DETAIL_MAX),
    brief_original_chars: brief.length > NOTIFICATION_DETAIL_MAX ? brief.length : null,
  };
};

/**
 * {@link escalationFor} for many tasks at once (backlog 1360): the newest `task.escalated` of each
 * stream in **one** statement (`distinct on`, the same order — newest instant, then position), read
 * the same way. The caller passes only its `needs_human` tasks, for the reason
 * {@link escalationFor} gives; a task absent from the map has no escalation with both strings.
 */
export const escalationsFor = async (
  database: Database,
  taskIds: readonly string[],
): Promise<ReadonlyMap<string, TaskEscalation>> => {
  if (taskIds.length === 0) {
    return new Map();
  }
  const rows = await database
    .selectDistinctOn([events.streamId], {
      streamId: events.streamId,
      occurredAt: events.occurredAt,
      payload: events.payload,
    })
    .from(events)
    .where(
      and(
        eq(events.streamType, 'task'),
        eq(events.type, 'task.escalated'),
        inArray(events.streamId, [...taskIds]),
      ),
    )
    .orderBy(events.streamId, desc(events.occurredAt), desc(events.position));
  return new Map(
    rows.flatMap((row) => {
      const escalation = escalationOfRow(row);
      return escalation === null ? [] : [[row.streamId, escalation] as const];
    }),
  );
};

/**
 * The run statuses that mean **this run has ended**, whatever the outcome.
 *
 * Its complement is what `GET /api/org/agents` answers with, and the two are asserted to partition
 * `runStatusSchema` exactly (`pipeline-queries.test.ts`): a status added to the enum and to neither
 * set here would otherwise silently pick a side, and the side it would pick is "still running",
 * which is the one that puts a finished run on the agents screen for ever.
 */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  'completed',
  'failed',
  'cancelled',
  'budget_exceeded',
  'timed_out',
  // A stalled run has stopped producing and `runs.terminal_reason` has a value for it; it is an
  // ending the platform reached rather than one the model reported.
  'stalled',
];

/**
 * `GET /api/org/agents` — every run that has not ended, newest first (technical/08 § "Agents").
 *
 * Organisation-wide and unpaginated: the list is bounded by how many runs a deployment can execute
 * at once, which is the dispatcher's concurrency, not by how long it has been running.
 *
 * `project_id`, `task_id`, `role` and `last_output_at` are on the run row already and the DTO
 * repeats them beside it — that is technical/08's shape and it is kept, because the agents screen
 * groups by project without unpacking the record.
 *
 * `seat` and `activity` (S-23.15) are `live-view-queries.ts`'s: who holds the run (`null` while its
 * offer is open — the queue is these runs) and the kind of its newest transcript entry, never the
 * entry's text. One query each for the whole list.
 */
export const listRunningAgents = async (
  database: Database,
  options: WaitingReadOptions = {},
): Promise<AgentsResponse> => {
  const rows = await database
    .select(runColumns)
    .from(runs)
    .leftJoin(taskStages, eq(taskStages.id, runs.taskStageId))
    .where(notInArray(runs.status, [...TERMINAL_RUN_STATUSES]))
    .orderBy(desc(runs.createdAt));
  const ids = rows.map((row) => row.id);
  const [usage, progress, stops, seats, activity, waiting] = await Promise.all([
    modelUsageFor(database, ids),
    latestProgressFor(database, ids),
    stopReasonsFor(database, ids),
    seatsFor(database, ids),
    latestActivityFor(database, ids),
    // S-26.5: why each run's open offer waits — one statement for the whole list.
    waitingForRuns(database, ids, options.coreDigests ?? null),
  ]);
  return {
    items: rows.map((row) => {
      const run = toRunRecord(
        row,
        usage.get(row.id) ?? [],
        progress.get(row.id) ?? null,
        stops.get(row.id) ?? null,
      );
      return {
        run,
        project_id: run.project_id,
        task_id: run.task_id,
        role: run.role,
        last_output_at: run.last_output_at ?? null,
        seat: seats.get(row.id) ?? null,
        activity: activity.get(row.id) ?? null,
        waiting: waiting.get(row.id) ?? null,
      };
    }),
  };
};

/**
 * `GET /api/org/inbox` — the questions and approvals that are still waiting (technical/08 § "Inbox").
 *
 * **"Pending for the caller" is read as "pending", and that is a decision the data model forces.**
 * technical/08 describes the inbox as *"questions + approvals pending for the caller"*, and nothing
 * in `questions` or `approvals` records an assignee: a question is asked of whoever can answer it,
 * and `answered_by_user_id` is written when somebody does. Filtering by a column that does not exist
 * would mean inventing a routing rule here, so the endpoint answers the organisation's open work and
 * the permission check is what scopes it (`task.read`, viewer). Written up in `PROGRESS.md`.
 *
 * Oldest first, both lists: an inbox is a queue, and the item that has waited longest is the one a
 * deadline is about to expire on.
 *
 * **`questions.text` is an artifact-derived column, and WP-52 closed backlog 35 at its write.** The
 * stage executor copies the draft out of the run's `structuredOutput` (`stage-executor.ts`'s
 * `artifactQuestions(data)`), and until WP-52 that document reached `artifacts.data` — and
 * therefore this column — **unredacted**, while the same model message's transcript copy went
 * through TD-012 step 1. The write is redacted now (`artifacts/redaction.ts`, migration 0038), so a
 * credential the platform injected and the model repeated into a question is a placeholder before
 * either row exists. This reader still does not redact, and that is unchanged and deliberate:
 * redaction belongs at the write, and a reader that redacted would give the row and the response
 * two different texts. The residual is the rows written **before** that migration — they are still
 * served as they were stored, because `questions` is append-only and nothing may rewrite them.
 */
export const listInbox = async (database: Database): Promise<InboxResponse> => {
  const [questionRows, approvalRows, ciHeld, escalated] = await Promise.all([
    database
      .select()
      .from(questions)
      .where(eq(questions.status, 'open'))
      .orderBy(asc(questions.askedAt)),
    database
      .select()
      .from(approvals)
      .where(eq(approvals.status, 'pending'))
      .orderBy(asc(approvals.requestedAt)),
    listCiHeld(database),
    listEscalatedTasks(database),
  ]);
  return {
    questions: questionRows.map(toQuestionRecord),
    // The task read's shape (TD-035), so Home and the Inbox name the plan an approval is about.
    approvals: await approvalViewsFor(database, approvalRows),
    ci_held: ciHeld,
    escalated,
  };
};

/**
 * **The tasks escalated to a person** (backlog 1360, S-25.14): the inbox's `escalated`, which Home's
 * *Needs you* and the Inbox read. **One statement, bounded**: the `needs_human` tasks with the
 * columns a row needs and nothing else, each one's newest `task.escalated` (a `lateral` over the
 * stream index, the task read's order — newest instant, then position), and the two owner
 * predicates the task record's `tracker_assignee` and `unlinked_assignee` are projected from
 * (`taskHeldElsewhereSql`, `trackerAssigneeUserSql`, as `ownerViewsFor` asks them). Oldest
 * escalation first — the task's last update for one with none — as the inbox is a queue, and at
 * most `limit` rows ({@link MAX_INBOX_ESCALATED}, the API's page maximum): the oldest waits are
 * the ones served, and the schema refuses a longer list.
 */
export const listEscalatedTasks = async (
  database: Database,
  limit: number = MAX_INBOX_ESCALATED,
): Promise<InboxResponse['escalated']> => {
  const { rows } = await database.execute<{
    id: string;
    project_id: string;
    ticket_provider: string;
    ticket_key: string;
    ticket_url: string;
    ticket_title: unknown;
    current_stage: string | null;
    updated_at: Date | string;
    ticket_assignee: unknown;
    held_elsewhere: boolean;
    assignee_user_id: string | null;
    escalated_at: Date | string | null;
    payload: unknown;
  }>(sql`
    select t.id, t.project_id, t.ticket_provider, t.ticket_key, t.ticket_url,
           t.ticket_snapshot -> 'title' as ticket_title, t.current_stage, t.updated_at,
           t.ticket_assignee,
           ${HELD_ELSEWHERE} as held_elsewhere,
           ${TRACKER_ASSIGNEE_USER} as assignee_user_id,
           e.occurred_at as escalated_at, e.payload
      from tasks t
      left join lateral (
        select ev.occurred_at, ev.payload from events ev
         where ev.stream_type = 'task' and ev.stream_id = t.id and ev.type = 'task.escalated'
         order by ev.occurred_at desc, ev.position desc
         limit 1
      ) e on true
     where t.state = 'needs_human'
     order by coalesce(e.occurred_at, t.updated_at), t.id
     limit ${limit}`);
  return rows.map((row) => {
    const escalation =
      row.escalated_at === null
        ? null
        : escalationOfRow({ occurredAt: new Date(row.escalated_at), payload: row.payload });
    const assignee = assigneeFieldsOf(row.id, row.ticket_assignee, {
      heldElsewhere: row.held_elsewhere === true,
      assigneeUserId: row.assignee_user_id ?? null,
    });
    return {
      task_id: row.id as Id,
      project_id: row.project_id as Id,
      ticket: { provider: row.ticket_provider, key: row.ticket_key, url: row.ticket_url },
      ticket_title: ticketTitleOf({ title: row.ticket_title }),
      current_stage: row.current_stage ?? null,
      reason: escalation?.reason ?? null,
      at: new Date(row.escalated_at ?? row.updated_at).toISOString(),
      ...assignee,
    };
  });
};

/**
 * **The tasks whose CI pipeline is held at a manual job** (backlog 1300): the inbox's `ci_held`,
 * which Home's *Needs you* and the Inbox read — a held job waits for a person, as the task page's
 * `ci_held` says. One statement: every `ci_gate` attempt of the `active` tasks at `ci_gate`, then
 * {@link gateWaitOf} per task (the task read's own projection, so a paused task is never here) and
 * only a wait whose status is `manual`. Oldest wait first, as the inbox is a queue.
 */
const listCiHeld = async (database: Database): Promise<NonNullable<InboxResponse['ci_held']>> => {
  const rows = await database
    .select({
      id: tasks.id,
      projectId: tasks.projectId,
      state: tasks.state,
      currentStage: tasks.currentStage,
      ticketProvider: tasks.ticketProvider,
      ticketKey: tasks.ticketKey,
      ticketUrl: tasks.ticketUrl,
      taskId: taskStages.taskId,
      stage: taskStages.stage,
      attempt: taskStages.attempt,
      stageState: taskStages.state,
      outcome: taskStages.outcome,
      enteredAt: taskStages.enteredAt,
      exitedAt: taskStages.exitedAt,
      ciPendingRead: taskStages.ciPendingRead,
    })
    .from(tasks)
    .innerJoin(taskStages, eq(taskStages.taskId, tasks.id))
    .where(
      and(
        eq(tasks.state, 'active'),
        eq(tasks.currentStage, CI_GATE_STAGE),
        eq(taskStages.stage, CI_GATE_STAGE),
      ),
    )
    .orderBy(asc(tasks.id), asc(taskStages.attempt));
  const byTask = new Map<string, { task: (typeof rows)[number]; stages: GateStageRow[] }>();
  for (const row of rows) {
    const entry = byTask.get(row.id) ?? { task: row, stages: [] };
    entry.stages.push({ ...row, state: row.stageState });
    byTask.set(row.id, entry);
  }
  return [...byTask.values()]
    .flatMap(({ task, stages }) => {
      const wait = gateWaitOf(task, stages);
      return wait === null || wait.status !== 'manual'
        ? []
        : [
            {
              task_id: task.id as Id,
              project_id: task.projectId as Id,
              ticket: { provider: task.ticketProvider, key: task.ticketKey, url: task.ticketUrl },
              gate_wait: wait,
            },
          ];
    })
    .sort((a, b) => Date.parse(a.gate_wait.waiting_since) - Date.parse(b.gate_wait.waiting_since));
};

/**
 * The task states that mean **this task is finished**.
 *
 * `merged` and `retro` are deliberately *not* here: the retrospective stage runs after the merge, so
 * a task in either is still work in flight and still costs money. Asserted to partition
 * `taskStateSchema` exactly, for the reason {@link TERMINAL_RUN_STATUSES} gives.
 */
export const CLOSED_TASK_STATES: readonly TaskState[] = ['done', 'cancelled'];

/**
 * Where a page of `GET /api/projects/:id/tasks` stopped: the keyset of its last row.
 *
 * **`createdAt` is a string, and that is the fix for a row this cursor used to skip.** `timestamptz`
 * has microsecond resolution and node-postgres parses it into a JavaScript `Date`, which has
 * milliseconds — so a cursor built from the parsed value is *earlier* than the row it came from, and
 * the keyset's `created_at = $1` never matches while `created_at < $1` excludes it. The row is
 * dropped, silently, and the short page is indistinguishable from the last page. Measured on the
 * integration tier: three tasks, `limit: 1`, **two** returned.
 *
 * So the cursor carries the database's own rendering — `YYYY-MM-DDTHH:MM:SS.ffffffZ`, six fractional
 * digits — and the comparison casts it back to `timestamptz`. Nothing in between is a `Date`.
 */
export interface TaskCursor {
  readonly createdAt: string;
  readonly id: string;
}

/**
 * `tasks.created_at` rendered to the microsecond, in UTC.
 *
 * `to_char` rather than `::text` so the result is ISO-8601 with a `T` and a `Z` — the shape
 * `z.iso.datetime()` accepts (it admits six fractional digits; verified) and the shape every other
 * timestamp on the wire has. `::text` would render `2026-09-13 00:41:40.123456+00`, which the
 * route's own cursor schema would refuse.
 */
const cursorAt = sql<string>`to_char(${tasks.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export interface ProjectTasksQuery {
  readonly limit: number;
  readonly before?: TaskCursor;
  readonly state?: TaskState;
  readonly template?: string;
  readonly mode?: TaskRecord['mode'];
  readonly stage?: string;
  /**
   * The board's owner filter (S-26.1): the tasks `userId` owns, or the tasks nobody owns. The route
   * resolves `owner=me` to the caller, so a query never names somebody else's id.
   */
  readonly owner?: { readonly kind: 'user'; readonly userId: string } | { readonly kind: 'none' };
}

export interface ProjectTaskPage {
  readonly items: readonly TaskListItem[];
  /** The keyset of the last row, or `null` on the last page. */
  readonly next?: TaskCursor;
}

/**
 * One page of a project's tasks, newest first — or `null` when there is no such project.
 *
 * A **keyset** over `(created_at, id)` rather than an offset, for the reason `routes/kb.ts` gives
 * about the proposal queue: the table is written to while a human reads it, and an offset silently
 * repeats or skips a row when one lands in between. The pair is needed because `tasks.id` is a
 * uuidv7 whose default is generated per row while `created_at` is `now()` — two tasks created inside
 * one transaction share the timestamp exactly.
 *
 * **The existence check is a second query and it is not optional.** "This project has no tasks" and
 * "there is no such project" are different facts and the `where` cannot tell them apart — both are
 * an empty page — so without it this endpoint would answer `200 {items: []}` for a uuid that names
 * nothing while its siblings (`/config`, `/budgets`, `/readiness`) all answer 404 for the same id.
 * One question, one answer: every project-scoped read in this server resolves the project first, and
 * the cost is one indexed primary-key lookup per page.
 */
export const listProjectTasks = async (
  database: Database,
  projectId: string,
  query: ProjectTasksQuery,
  options: WaitingReadOptions = {},
): Promise<ProjectTaskPage | null> => {
  const project = await database
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (project.length === 0) {
    return null;
  }

  const conditions = [
    eq(tasks.projectId, projectId),
    ...(query.state === undefined ? [] : [eq(tasks.state, query.state)]),
    ...(query.template === undefined ? [] : [eq(tasks.template, query.template)]),
    ...(query.mode === undefined ? [] : [eq(tasks.mode, query.mode)]),
    ...(query.stage === undefined ? [] : [eq(tasks.currentStage, query.stage)]),
    ...(query.owner === undefined
      ? []
      : query.owner.kind === 'none'
        ? [isNull(tasks.ownerUserId)]
        : [eq(tasks.ownerUserId, query.owner.userId)]),
    ...(query.before === undefined
      ? []
      : [
          // The cursor goes back to the database as text and is cast there, so the comparison runs
          // at the column's own resolution rather than at a `Date`'s (see {@link TaskCursor}).
          sql`(${tasks.createdAt}, ${tasks.id}) < (${query.before.createdAt}::timestamptz, ${query.before.id}::uuid)`,
        ]),
  ];
  const rows = await database
    .select({ task: tasks, cursorAt })
    .from(tasks)
    .where(and(...conditions))
    .orderBy(desc(tasks.createdAt), desc(tasks.id))
    .limit(query.limit + 1);

  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  // One extra read per page for the board's conflict badge (backlog 63), over the ids of the page
  // and never over the project: a warning for a task the caller is not being shown is not a row
  // this answer has anywhere to put.
  // S-23.9a: the card's glance — its stage rows and what waits on a person — over the same ids.
  // S-26.5: and why each one's run waits; backlog 1300: its CI wait, off the same stage rows.
  const [
    conflicts,
    estimated,
    unmeasured,
    pausedReasons,
    stageRows,
    asks,
    owners,
    waiting,
    escalations,
    queueWaits,
  ] = await Promise.all([
    conflictsFor(
      database,
      page.map((row) => row.task.id),
    ),
    estimatedSpendFor(
      database,
      page.map((row) => row.task.id),
    ),
    unmeasuredRunsFor(
      database,
      page.map((row) => row.task.id),
    ),
    pausedReasonsFor(
      database,
      page.filter((row) => row.task.state === 'paused').map((row) => row.task.id),
    ),
    stageRowsFor(
      database,
      page.map((row) => row.task.id),
    ),
    openAsksFor(
      database,
      page.map((row) => row.task.id),
    ),
    ownerViewsFor(
      database,
      page.map((row) => row.task.id),
    ),
    waitingForTasks(
      database,
      page.map((row) => row.task.id),
      options.coreDigests ?? null,
    ),
    // Backlog 1360: why each `needs_human` task of the page waits, as a key — one statement.
    escalationsFor(
      database,
      page.filter((row) => row.task.state === 'needs_human').map((row) => row.task.id),
    ),
    // S-25.16: why each queued task of the page waits — one read of the project, never per item.
    options.wipLimits === undefined
      ? new Map<string, QueueWait>()
      : queueWaitsFor(
          database,
          projectId,
          page.filter((row) => row.task.state === 'queued').map((row) => row.task.id),
          options.wipLimits,
        ),
  ]);
  return {
    items: page.map((row) => ({
      ...toTaskRecord(
        row.task,
        conflicts.get(row.task.id) ?? null,
        estimated.get(row.task.id) ?? 0,
        unmeasured.get(row.task.id) ?? 0,
        pausedReasons.get(row.task.id),
        owners.get(row.task.id),
      ),
      waiting: waiting.get(row.task.id) ?? null,
      stages: stageRows.get(row.task.id)?.stages ?? [],
      latest_return:
        returnsOf(stageRows.get(row.task.id)?.setback ?? [], compiledPipelineOf(row.task)).at(-1) ??
        null,
      stop: stopOf(row.task, stageRows.get(row.task.id)?.setback ?? []),
      escalation_reason:
        row.task.state === 'needs_human' ? (escalations.get(row.task.id)?.reason ?? null) : null,
      open_questions: asks.questions.get(row.task.id) ?? 0,
      pending_approvals: asks.approvals.get(row.task.id) ?? 0,
      plan_went_ahead: asks.wentAhead.has(row.task.id),
      loop_limits: frozenLimits(row.task.iterationLimits),
      gate_wait: gateWaitOf(row.task, stageRows.get(row.task.id)?.gate ?? []),
      queue_wait: queueWaits.get(row.task.id) ?? null,
    })),
    ...(rows.length > query.limit && last !== undefined
      ? { next: { createdAt: last.cursorAt, id: last.task.id } }
      : {}),
  };
};

/**
 * Where a task stands **now** — the answer every task command gives back (WP-15i).
 *
 * Re-read after the command's transaction rather than returned from the aggregate it wrote, so a
 * replay and a first call answer from the same source, and so the answer is the row's rather than
 * one writer's belief about it. It is two columns on purpose: `taskDetailResponseSchema` is five
 * queries, and a command that answered it would make every button re-read the whole screen.
 */
export const findTaskPosition = async (
  database: Database,
  taskId: string,
): Promise<{ readonly state: TaskState; readonly currentStage: string | null } | null> => {
  const rows = await database
    .select({ state: tasks.state, currentStage: tasks.currentStage })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : { state: row.state, currentStage: row.currentStage };
};

/**
 * A task's ticket key, for a command's refusal (S-25.23, BACKLOG 1390): read only on the refusal
 * path, so an `illegal_transition` can say *AUT-6639 is paused, …* rather than *This task …*.
 * `null` for a task that does not exist.
 */
export const findTaskTicketKey = async (
  database: Database,
  taskId: string,
): Promise<string | null> => {
  const rows = await database
    .select({ ticketKey: tasks.ticketKey })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);
  return rows[0]?.ticketKey ?? null;
};

/** The same for a run command: the run's status and the task it belongs to (WP-15i). */
export const findRunPosition = async (
  database: Database,
  runId: string,
): Promise<{
  readonly status: RunStatus;
  readonly taskId: string;
  readonly taskState: TaskState;
} | null> => {
  const rows = await database
    .select({ status: runs.status, taskId: runs.taskId, taskState: tasks.state })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .where(eq(runs.id, runId))
    .limit(1);
  const row = rows[0];
  return row === undefined
    ? null
    : { status: row.status, taskId: row.taskId, taskState: row.taskState };
};

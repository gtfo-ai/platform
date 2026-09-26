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
import type {
  AgentsResponse,
  ArtifactBodyResponse,
  ContextPackRecord,
  HumanTimeSummary,
  Id,
  InboxResponse,
  ModelUsage,
  QuestionRecord,
  RunRecord,
  RunStatus,
  TaskConflict,
  TaskDetailResponse,
  TaskRecord,
  TaskStageState,
  TaskState,
  TranscriptEvent,
} from '@platform/contracts';
import {
  artifactBodyPath,
  contextPackRecordSchema,
  taskStageStateSchema,
  transcriptEventSchema,
} from '@platform/contracts';
import { estimateAccuracy, resumeCommands } from '@platform/domain';
import { db as dbAdapters } from '@platform/infrastructure';
import { and, asc, desc, eq, gt, inArray, ne, notInArray, sql, sum } from 'drizzle-orm';
import { HttpError } from '../errors.js';
import { perUserBreakdownEnabled, summariseHumanTime } from './human-time-summary.js';

const {
  approvals,
  artifacts,
  costEntries,
  events,
  humanTimeEntries,
  projects,
  questions,
  runContextPack,
  runMessages,
  runModelUsage,
  runs,
  taskStages,
  tasks,
  users,
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
} as const;

/**
 * `runs` + the joined stage + its per-model usage → `RunRecord`.
 *
 * **`cost.is_estimate` is `usd_reported is null`**, which is BD-011's rule read off the column that
 * holds it: the provider's figure is the truth and the price list is the fallback, so a row with no
 * reported figure is reporting an estimate whatever its value.
 */
const toRunRecord = (row: RunProjectionRow, modelUsage: readonly ModelUsage[]): RunRecord => {
  if (row.stage === null) {
    throw new UnprojectableRowError(
      `run ${row.id}`,
      'it is not linked to a stage attempt (`runs.task_stage_id` is null), and the API publishes the stage as a required field. Runs stored before WP-15h carry no link',
    );
  }
  return {
    id: row.id as Id,
    task_id: row.taskId as Id,
    project_id: row.projectId as Id,
    stage: row.stage,
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
    // platform's own pricing of a `local`-mode run — written since WP-47, so a whole provider mode
    // stopped reading as free here — and neither means *nobody measured this run*, which is what
    // the lease sweep leaves behind. The DTO has no spelling for "unknown" (`RunCost.usd` is a
    // required number), so it reads 0 with `is_estimate` set, exactly as the per-model list one
    // level up already does and says.
    cost: {
      usd: usd(row.usdReported ?? row.usdEstimated),
      is_estimate: row.usdReported === null,
      price_list_id: row.priceListId as Id | null,
    },
    wall_ms: row.wallMs,
    redaction_count: row.redactionCount,
  };
};

const modelUsageFor = async (
  database: Database,
  runIds: readonly string[],
): Promise<Map<string, ModelUsage[]>> => {
  const byRun = new Map<string, ModelUsage[]>();
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
      // migration 0017 gave `run_model_usage` the pair. The DTO has no spelling for "unknown", so a
      // model with neither number reads as 0 here while the row keeps both as null.
      usd: usd(row.usdReported ?? row.usdEstimated),
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
  const usage = await modelUsageFor(database, [row.id]);
  return toRunRecord(row, usage.get(row.id) ?? []);
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
  const [rows, projectRows] = await Promise.all([
    database
      .select({
        kind: humanTimeEntries.kind,
        userId: humanTimeEntries.userId,
        userName: users.name,
        externalAuthor: humanTimeEntries.externalAuthor,
        minutes: humanTimeEntries.minutes,
      })
      .from(humanTimeEntries)
      .leftJoin(users, eq(users.id, humanTimeEntries.userId))
      .where(eq(humanTimeEntries.taskId, taskId))
      .orderBy(asc(humanTimeEntries.startedAt)),
    database
      .select({ config: projects.config })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1),
  ]);

  return summariseHumanTime(rows, {
    perUserBreakdown: perUserBreakdownEnabled(projectRows[0]?.config),
  });
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

const toTaskRecord = (
  row: typeof tasks.$inferSelect,
  conflict: TaskConflict | null,
  estimatedUsd: number,
): TaskRecord => ({
  id: row.id as Id,
  project_id: row.projectId as Id,
  ticket: { provider: row.ticketProvider, key: row.ticketKey, url: row.ticketUrl },
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
  // WP-41, backlog 63: **not** a column — the latest `task.conflict.warned` off the task's own
  // stream (`conflictsFor`). `null` is "no warning has been appended for this task", which on a
  // pair of overlapping tasks is also what the one compared *first* sees: the comparison is not
  // symmetric (backlog 65), and the badge's tooltip says so rather than letting a reader infer
  // that the other task is clear.
  conflict,
  cost_actual_usd: usd(row.costActual),
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
});

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
 * The take-over in force on a task, or `null` — WP-27, and the one projection here that reads the
 * **event log** rather than a row.
 *
 * It has to: `tasks` records that a task is `paused` and not *why*, and the session id of the run a
 * take-over interrupted is on no row at all (`runs.session_id` is written when a run *ends*). The
 * log is the authority for both, and reading the newest of this task's `task.taken_over` and
 * `task.handed_back` answers the question in one indexed scan — including the withdrawal, because a
 * hand-back is the later event and therefore the answer.
 *
 * Two things it refuses to invent. A payload that does not carry a `branch` publishes **nothing**
 * rather than a blank one, because the branch is the whole point of the record; and a task that is
 * not `paused` publishes nothing either, because a take-over that is over is not a take-over —
 * `task.cancelled` and `task.completed` are not on the stream this reads, and the state is what
 * covers them.
 */
const findTakenOver = async (
  database: Database,
  taskId: string,
  state: TaskState,
): Promise<TaskDetailResponse['taken_over']> => {
  if (state !== 'paused') {
    return null;
  }
  const rows = await database
    .select({ type: events.type, payload: events.payload, occurredAt: events.occurredAt })
    .from(events)
    .where(
      and(
        eq(events.streamType, 'task'),
        eq(events.streamId, taskId),
        inArray(events.type, ['task.taken_over', 'task.handed_back']),
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
  const sessionId = typeof row.payload.session_id === 'string' ? row.payload.session_id : null;
  return {
    at: isoRequired(row.occurredAt),
    branch,
    session_id: sessionId,
    stage,
    resume_commands: [...resumeCommands(branch, sessionId)],
  };
};

/** `GET /api/tasks/:task_id` — the task with its stages, artifacts, questions, approvals and runs. */
export const findTaskDetail = async (
  database: Database,
  taskId: string,
): Promise<TaskDetailResponse | null> => {
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

  const [usage, takenOver, humanTime, conflicts, estimated] = await Promise.all([
    modelUsageFor(
      database,
      runRows.map((row) => row.id),
    ),
    findTakenOver(database, taskId, task.state),
    // The project id comes from the task row rather than from the request: the breakdown setting
    // belongs to the project that owns the task, and a caller cannot name a different one.
    findHumanTime(database, taskId, task.projectId),
    conflictsFor(database, [taskId]),
    estimatedSpendFor(database, [taskId]),
  ]);

  return {
    task: toTaskRecord(task, conflicts.get(task.id) ?? null, estimated.get(task.id) ?? 0),
    taken_over: takenOver,
    human_time: humanTime,
    stages: stageRows.map((row) => ({
      stage: row.stage,
      attempt: row.attempt,
      state: stageStateOf(row),
      entered_at: isoRequired(row.enteredAt),
      exited_at: iso(row.exitedAt),
      outcome: row.outcome,
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
    approvals: approvalRows.map((row) => ({
      id: row.id as Id,
      task_id: row.taskId as Id,
      kind: row.kind,
      status: row.status,
      requested_at: isoRequired(row.requestedAt),
      deadline_at: iso(row.deadlineAt),
      decided_by_user_id: row.decidedByUserId as Id | null,
      decided_at: iso(row.decidedAt),
      reason: row.reason,
    })),
    runs: runRows.map((row) => toRunRecord(row, usage.get(row.id) ?? [])),
  };
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
 */
export const listRunningAgents = async (database: Database): Promise<AgentsResponse> => {
  const rows = await database
    .select(runColumns)
    .from(runs)
    .leftJoin(taskStages, eq(taskStages.id, runs.taskStageId))
    .where(notInArray(runs.status, [...TERMINAL_RUN_STATUSES]))
    .orderBy(desc(runs.createdAt));
  const usage = await modelUsageFor(
    database,
    rows.map((row) => row.id),
  );
  return {
    items: rows.map((row) => {
      const run = toRunRecord(row, usage.get(row.id) ?? []);
      return {
        run,
        project_id: run.project_id,
        task_id: run.task_id,
        role: run.role,
        last_output_at: run.last_output_at ?? null,
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
  const [questionRows, approvalRows] = await Promise.all([
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
  ]);
  return {
    questions: questionRows.map(toQuestionRecord),
    approvals: approvalRows.map((row) => ({
      id: row.id as Id,
      task_id: row.taskId as Id,
      kind: row.kind,
      status: row.status,
      requested_at: isoRequired(row.requestedAt),
      deadline_at: iso(row.deadlineAt),
      decided_by_user_id: row.decidedByUserId as Id | null,
      decided_at: iso(row.decidedAt),
      reason: row.reason,
    })),
  };
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
}

export interface ProjectTaskPage {
  readonly items: readonly TaskRecord[];
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
  const [conflicts, estimated] = await Promise.all([
    conflictsFor(
      database,
      page.map((row) => row.task.id),
    ),
    estimatedSpendFor(
      database,
      page.map((row) => row.task.id),
    ),
  ]);
  return {
    items: page.map((row) =>
      toTaskRecord(row.task, conflicts.get(row.task.id) ?? null, estimated.get(row.task.id) ?? 0),
    ),
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

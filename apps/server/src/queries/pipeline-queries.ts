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
 *  - **`runs.system_prompt` / `runs.user_prompt`** — `RunRepository.insert` does not carry them and
 *    `StoredRun` has no field for them at all, so **nothing in this repository has ever written a
 *    prompt to a run row**. `findRunPrompt` therefore reports `recorded: false` and the route
 *    refuses by name. Answering `{system_prompt: "", user_prompt: ""}` would render as "this run
 *    had no prompt", which is a claim about the agent rather than about the schema.
 *  - **`run_context_pack`** — no insert exists anywhere in the tree either, *and* the table cannot
 *    express `ContextPackRecord.budget_tokens` (there is no such column) or the non-null `reason`
 *    and `score` the published tier-1 entry requires. So `findRunContextPack` has **no success
 *    branch at all**: filling those three from the rows would be three invented values, and the
 *    first one — `budget_tokens = total_tokens` — is rendered as a fact by
 *    `apps/web/src/features/run-detail.tsx`.
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
  Id,
  InboxResponse,
  ModelUsage,
  QuestionRecord,
  RunRecord,
  RunStatus,
  TaskDetailResponse,
  TaskRecord,
  TaskState,
  TranscriptEvent,
} from '@platform/contracts';
import { transcriptEventSchema } from '@platform/contracts';
import { db as dbAdapters } from '@platform/infrastructure';
import { and, asc, desc, eq, gt, inArray, ne, notInArray, sql } from 'drizzle-orm';
import { HttpError } from '../errors.js';

const {
  approvals,
  artifacts,
  projects,
  questions,
  runContextPack,
  runMessages,
  runModelUsage,
  runs,
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
  readonly usdEstimated: string;
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
      /** How many `run_context_pack` rows the run has; `0` while nothing writes them. */
      readonly rows: number;
    };

/**
 * `GET /api/runs/:run_id/context-pack` — and it has **no success branch**, deliberately.
 *
 * `ContextPackRecord.budget_tokens` has **no column**: `run_context_pack` stores one row per source
 * document (`tier`, `source_path`, `reason`, `score`, `tokens`, `validated`, `kb_commit_sha`) and
 * nothing anywhere holds the budget the pack was assembled against. So the published record cannot
 * be filled from this table *however many rows it has*, and an implementation that summed the rows
 * into `budget_tokens` would ship "budget equals total" as a fact about every run — rendered as
 * such by `apps/web/src/features/run-detail.tsx`, and silently wrong the day a real producer lands.
 * The first version of this function did exactly that, and its own test pinned it.
 *
 * Two nullable columns say the same thing one layer down: `reason` and `score` are `null`able here
 * and **required** in the published tier-1 entry, so a projection would have to invent `'paths'`
 * and `0` for them too. Nothing is invented; the refusal is the answer, and the row count goes with
 * it so an operator can tell "no producer yet" from "a producer exists and the schema gap remains".
 *
 * What it takes to give this endpoint a success branch is therefore a **schema** change and a
 * writer, not a reader: somewhere to put the budget, and `reason`/`score` either filled or made
 * nullable in `@platform/contracts`. Both are recorded as discovered work.
 */
export const findRunContextPack = async (
  database: Database,
  runId: string,
): Promise<RunContextPack> => {
  const exists = await database
    .select({ id: runs.id })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);
  if (exists.length === 0) {
    return { found: false };
  }
  const rows = await database
    .select({ runId: runContextPack.runId })
    .from(runContextPack)
    .where(eq(runContextPack.runId, runId));
  return { found: true, recorded: false, rows: rows.length };
};

const toTaskRecord = (row: typeof tasks.$inferSelect): TaskRecord => ({
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
  cost_actual_usd: usd(row.costActual),
  cost_estimated_usd: usd(row.costEstimated),
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

/** The states `TaskDetailResponse` publishes for a stage row; anything else is reported verbatim. */
const STAGE_STATES = new Set(['pending', 'running', 'completed', 'returned', 'skipped', 'failed']);

/**
 * `task_stages.state` is `text` and "free-form until WP-15 fixes the interpreter's vocabulary"
 * (migration 0004); the interpreter writes `entered` and `exited`, and the DTO publishes neither.
 * The two are mapped rather than passed through, and anything unrecognised becomes `pending` —
 * the reading that claims the least about a row this projection does not understand.
 */
const stageStateOf = (state: string, exitedAt: Date | null): string => {
  if (STAGE_STATES.has(state)) {
    return state;
  }
  if (state === 'entered') {
    return exitedAt === null ? 'running' : 'completed';
  }
  if (state === 'exited') {
    return 'completed';
  }
  return 'pending';
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

  const usage = await modelUsageFor(
    database,
    runRows.map((row) => row.id),
  );

  return {
    task: toTaskRecord(task),
    stages: stageRows.map((row) => ({
      stage: row.stage,
      attempt: row.attempt,
      state: stageStateOf(row.state, row.exitedAt) as TaskDetailResponse['stages'][number]['state'],
      entered_at: isoRequired(row.enteredAt),
      exited_at: iso(row.exitedAt),
      outcome: row.outcome,
    })),
    artifacts: artifactRows.map((row) => ({
      id: row.id as Id,
      artifact_type: row.type,
      version: row.version,
      url: null,
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
 * **`questions.text` is an artifact-derived column, and PROGRESS backlog 35 is open on it.** The
 * stage executor copies the draft out of the run's `structuredOutput` (`stage-executor.ts`'s
 * `artifactQuestions(data)`), and that document reaches `artifacts.data` — and therefore this
 * column — **unredacted**, while the same model message's transcript copy went through TD-012 step
 * 1. So a credential the platform injected into the run's environment and the model repeated into a
 * question would be served here. This reader does not fix it: redaction belongs at the write
 * (TD-012), a reader that redacted would give the row and the response two different texts, and
 * backlog 35 is owned by no work package. Stated here rather than discovered by the next reader.
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
  return {
    items: page.map((row) => toTaskRecord(row.task)),
    ...(rows.length > query.limit && last !== undefined
      ? { next: { createdAt: last.cursorAt, id: last.task.id } }
      : {}),
  };
};

/**
 * The `ClaudeRunner` port — technical/04 § "RunSpec" and § "Streaming and steering".
 *
 * The stage executor (WP-15) builds a {@link RunSpec} and hands it here; an adapter in
 * `packages/infrastructure/src/runner` drives the Claude Agent SDK with it. Everything the run
 * emits comes back as `TranscriptEvent`s on a {@link RunTranscriptSink} and the run ends with a
 * {@link RunOutcome}.
 *
 * Three shapes in this file are boundaries and are therefore zod schemas rather than bare
 * interfaces: `RunSpec` (built from effective config, which is user-editable), the platform tool
 * inputs (written by the model — untrusted, BD-022) and the structured output. Everything else is
 * an interface, because it is a function the composition root supplies.
 *
 * Field names here are camelCase and match technical/04's table verbatim. The snake_case rule in
 * `CLAUDE.md` governs the wire — config YAML, event payloads, artifact data, API DTOs and
 * transcript rows — and a `RunSpec` is none of those: it never leaves the process.
 */
import type {
  Id,
  JsonObject,
  JsonValue,
  ModelUsage,
  RunCost,
  RunMode,
  RunStatus,
  RunTerminalReason,
  TokenUsage,
  TranscriptEvent,
} from '@platform/contracts';
import {
  agentRoleSchema,
  artifactTypeSchema,
  effortSchema,
  idSchema,
  jsonObjectSchema,
  nonEmptyStringSchema,
  pathPatternSchema,
  providerModeSchema,
  runModeSchema,
  stageIdSchema,
  usdSchema,
} from '@platform/contracts';
import * as z from 'zod';

// ── Time ─────────────────────────────────────────────────────────────────────

/** Cancels a timer armed with {@link RunnerClock.setTimer}. Idempotent. */
export type CancelTimer = () => void;

/**
 * The runner's clock.
 *
 * A stall detector, a wall-clock timeout and a question deadline are the three places where this
 * package would otherwise assert something about hardware: CI is a two-core runner, and a test
 * that waits five real minutes to prove a five-minute timeout proves only that the machine was
 * not busy. Every duration in the runner is therefore measured on this port, and the tests advance
 * it by hand.
 *
 * Deliberately milliseconds rather than `@platform/domain`'s ISO-8601 `Clock`: the aggregate
 * speaks the wire format because its output is an event payload, and the runner does arithmetic.
 * `TranscriptEvent.created_at` is derived from `now()` at the one place it is needed.
 */
export interface RunnerClock {
  /** Epoch milliseconds. Only differences are meaningful. */
  now(): number;
  /** Runs `callback` after `delayMs` have passed on this clock. */
  setTimer(delayMs: number, callback: () => void): CancelTimer;
}

// ── RunSpec ──────────────────────────────────────────────────────────────────

/** technical/04: `maxTurns`, `maxBudgetUsd`, `stallTimeoutMs`, `wallClockMs` from effective config. */
export const runLimitsSchema = z.strictObject({
  maxTurns: z.int().positive().max(1000),
  maxBudgetUsd: usdSchema,
  /** No transcript output for this long ⇒ the run is `stalled` (technical/02: default 5 min). */
  stallTimeoutMs: z.int().positive(),
  /** Hard ceiling on the whole run; the process tree is killed (technical/05). */
  wallClockMs: z.int().positive(),
  /** `PostToolUse` truncates tool output to this many characters, head and tail (technical/04). */
  toolOutputMaxChars: z.int().positive(),
  /** How long `canUseTool` waits for a human before it denies (BD-025: unattended default deny). */
  questionTimeoutMs: z.int().positive(),
});

export const runLimitsDefaults = {
  maxTurns: 60,
  maxBudgetUsd: 10,
  stallTimeoutMs: 5 * 60_000,
  wallClockMs: 60 * 60_000,
  toolOutputMaxChars: 10_000,
  questionTimeoutMs: 24 * 60 * 60_000,
} as const satisfies z.infer<typeof runLimitsSchema>;

/** The three-list command policy as it reaches the runner (BD-025); resolved by WP-15. */
export const runCommandPolicySchema = z.strictObject({
  allow: z.array(nonEmptyStringSchema),
  ask: z.array(nonEmptyStringSchema),
  block: z.array(nonEmptyStringSchema),
});

/** One subagent definition (technical/04 `agents`). */
export const runSubagentSchema = z.strictObject({
  description: nonEmptyStringSchema,
  prompt: nonEmptyStringSchema,
  tools: z.array(nonEmptyStringSchema),
});

/** A context-pack document written into the workspace (product/05, technical/04). */
export const runContextDocumentSchema = z.strictObject({
  tier: z.union([z.literal(0), z.literal(1)]),
  path: pathPatternSchema,
  reason: z.string(),
});

/**
 * The nine in-process MCP tools of technical/04. A run is given the subset its role needs: a
 * read-only stage never sees `open_mr`, so a mutating action is impossible rather than merely
 * refused (BD-021).
 */
export const PLATFORM_TOOL_NAMES = [
  'ask_human',
  'notify_human',
  'report_progress',
  'get_task_context',
  'kb_search',
  'add_ticket_comment',
  'open_mr',
  'update_mr_description',
  'create_followup_ticket',
] as const;

export type PlatformToolName = (typeof PLATFORM_TOOL_NAMES)[number];

export const platformToolNameSchema = z.enum(PLATFORM_TOOL_NAMES);

/** Platform tools that change something outside the workspace. */
export const MUTATING_PLATFORM_TOOLS = [
  'add_ticket_comment',
  'open_mr',
  'update_mr_description',
  'create_followup_ticket',
] as const satisfies readonly PlatformToolName[];

export const runSpecSchema = z.strictObject({
  runId: idSchema,
  taskId: idSchema,
  projectId: idSchema,
  /** Null for runs that belong to no pipeline stage — discovery, librarian, ask-the-task. */
  stage: stageIdSchema.nullable(),
  role: agentRoleSchema,
  mode: runModeSchema,
  attempt: z.int().positive(),
  model: nonEmptyStringSchema,
  effort: effortSchema,
  providerMode: providerModeSchema,
  /** Hash of prompt layers 1–3 (technical/04 § "Prompt assembly"). */
  promptVersion: nonEmptyStringSchema,
  /** Layers 1–3, already assembled by `assemblePrompt`; appended to the `claude_code` preset. */
  systemPromptAppend: nonEmptyStringSchema,
  /** Layers 4–6: the task block, the context pack and the output contract. */
  userPrompt: nonEmptyStringSchema,
  /** Absolute path of the task's workspace; the only writable tree (BD-021, TD-021). */
  workspacePath: nonEmptyStringSchema,
  contextPack: z.array(runContextDocumentSchema),
  limits: runLimitsSchema,
  /**
   * The role's tool policy: the **base set** the run may use, mapped onto the SDK's `tools`.
   *
   * Named `tools` and not `allowedTools` because the SDK means something else by that name — an
   * auto-approve list that shadows `canUseTool` — which technical/04's table got wrong and WP-12
   * corrected there (see the note under the RunSpec table). The field kept the wrong name for one
   * work package; it is renamed here so the next reader inherits the correction rather than the
   * confusion. The `runs.allowed_tools` **column** keeps its name: that is technical/03's wire.
   */
  tools: z.array(nonEmptyStringSchema),
  disallowedTools: z.array(nonEmptyStringSchema),
  platformTools: z.array(platformToolNameSchema),
  commandPolicy: runCommandPolicySchema,
  /**
   * Paths a task may not write to unless its plan lists them (BD-024). The plan's exceptions
   * arrive in `plannedProtectedPaths`, so the guard can say "not in the plan" rather than
   * "forbidden".
   */
  protectedPaths: z.array(pathPatternSchema),
  plannedProtectedPaths: z.array(pathPatternSchema),
  agents: z.record(nonEmptyStringSchema, runSubagentSchema),
  /** Opaque per-provider MCP configuration (technical/06); passed to the SDK unread. */
  mcpServers: z.record(nonEmptyStringSchema, jsonObjectSchema),
  skills: z.array(nonEmptyStringSchema),
  /**
   * The artifact this run must produce, or null for a run that produces none (intake
   * classification, ask-the-task). The runner derives **both** the JSON Schema it hands the SDK
   * (`outputFormat: { type: 'json_schema' }`) and the validator it re-checks the answer with from
   * `artifactDataSchemas` in `@platform/contracts`, so "what the model was asked for" and "what the
   * platform accepts" cannot drift apart — technical/04 calls the second check defence in depth,
   * and defence in depth against a *different* schema is not depth.
   */
  artifactType: artifactTypeSchema.nullable(),
  /**
   * The subprocess environment, explicit and never inherited (technical/04; the SDK's `env`
   * REPLACES `process.env` rather than merging with it — verified in `Options.env`).
   */
  env: z.record(nonEmptyStringSchema, z.string()),
  /**
   * Names of `env` entries whose values are secret. The composition root builds the run's
   * injected-secret redactor from these (TD-012 step 1); the runner never copies the values.
   */
  secretEnvNames: z.array(nonEmptyStringSchema),
  /** `pathToClaudeCodeExecutable` in `local` provider mode (BD-004); null uses the bundled binary. */
  claudeCodePath: nonEmptyStringSchema.nullable(),
  /** Session to resume after a platform restart (technical/04 § "Resume and take-over"). */
  resumeSessionId: nonEmptyStringSchema.nullable(),
});

export type RunSpec = z.infer<typeof runSpecSchema>;
export type RunLimits = z.infer<typeof runLimitsSchema>;
export type RunCommandPolicy = z.infer<typeof runCommandPolicySchema>;
export type RunSubagent = z.infer<typeof runSubagentSchema>;
export type RunContextDocument = z.infer<typeof runContextDocumentSchema>;

// ── Outcome ──────────────────────────────────────────────────────────────────

/** The terminal statuses a run may end in (technical/02's Run state machine). */
export type TerminalRunStatus = Extract<
  RunStatus,
  'completed' | 'failed' | 'cancelled' | 'budget_exceeded' | 'timed_out' | 'stalled'
>;

export interface RunOutcome {
  readonly runId: Id;
  readonly status: TerminalRunStatus;
  readonly terminalReason: RunTerminalReason;
  /** The SDK session id, for resume and take-over. Null when the CLI never initialised. */
  readonly sessionId: string | null;
  readonly numTurns: number;
  readonly usage: TokenUsage;
  readonly modelUsage: readonly ModelUsage[];
  readonly cost: RunCost;
  readonly wallMs: number;
  /**
   * `structured_output`, re-validated against `RunSpec.outputSchema` by the platform (defence in
   * depth — technical/04 § "Result handling"). Null when the run produced none or it failed
   * validation, in which case `terminalReason` says so.
   */
  readonly structuredOutput: JsonValue | null;
  /** Redacted, human-readable failure text. Null on success. */
  readonly error: string | null;
  /** Total replacements the redaction path made across the run's transcript (TD-012). */
  readonly redactionCount: number;
}

// ── Collaborators ────────────────────────────────────────────────────────────

/**
 * Where normalised, redacted transcript entries go: `run_messages` plus the `run:<id>` SSE topic
 * (TD-007, technical/08). Appends are sequential — the runner awaits each one — so a sink may
 * assume `seq` arrives in order.
 */
export interface RunTranscriptSink {
  append(event: TranscriptEvent): Promise<void>;
}

/** What `canUseTool` asks a human (technical/04) — the ask-list half of BD-025. */
export interface ToolApprovalRequest {
  readonly runId: Id;
  readonly taskId: Id;
  readonly toolName: string;
  /** The exact command for `Bash`, otherwise a rendered summary of the tool input. */
  readonly detail: string;
  readonly input: JsonObject;
  /** Why the policy escalated: the matched ask pattern, or the SDK's own reason. */
  readonly reason: string;
  /** Milliseconds the runner will wait before it denies unattended (BD-025). */
  readonly timeoutMs: number;
  /** Aborted when the run ends for any other reason. */
  readonly signal: AbortSignal;
}

export interface ToolApprovalDecision {
  readonly decision: 'allow' | 'deny';
  /** Shown to the model on a denial, and recorded in the transcript either way. */
  readonly reason: string;
  /** The Question this decision came from, when a human was asked. */
  readonly questionId: Id | null;
}

export interface ToolApprovalPort {
  /**
   * Opens a blocking Question and waits. An implementation that cannot reach a human — or whose
   * deadline passes — resolves `deny`; it never throws to mean "no".
   */
  requestApproval(request: ToolApprovalRequest): Promise<ToolApprovalDecision>;
}

/** The in-process MCP server's nine tools (technical/04). Inputs are model-written, so untrusted. */
export interface PlatformToolPort {
  /** Blocking question with a blocker brief; returns the human's answer text. */
  askHuman(input: AskHumanInput, context: PlatformToolContext): Promise<string>;
  notifyHuman(input: NotifyHumanInput, context: PlatformToolContext): Promise<void>;
  reportProgress(input: ReportProgressInput, context: PlatformToolContext): Promise<void>;
  getTaskContext(input: GetTaskContextInput, context: PlatformToolContext): Promise<JsonValue>;
  kbSearch(input: KbSearchInput, context: PlatformToolContext): Promise<JsonValue>;
  addTicketComment(input: AddTicketCommentInput, context: PlatformToolContext): Promise<JsonValue>;
  openMergeRequest(input: OpenMrInput, context: PlatformToolContext): Promise<JsonValue>;
  updateMrDescription(
    input: UpdateMrDescriptionInput,
    context: PlatformToolContext,
  ): Promise<JsonValue>;
  createFollowupTicket(
    input: CreateFollowupInput,
    context: PlatformToolContext,
  ): Promise<JsonValue>;
}

export interface PlatformToolContext {
  readonly runId: Id;
  readonly taskId: Id;
  readonly projectId: Id;
  readonly mode: RunMode;
  readonly signal: AbortSignal;
}

// ── Platform tool inputs (BD-022: everything the model writes is untrusted) ───

export const askHumanInputSchema = z.strictObject({
  question: nonEmptyStringSchema,
  /** Why the run cannot continue without an answer — the "blocker brief" of technical/04. */
  blocker_brief: nonEmptyStringSchema,
  options: z.array(nonEmptyStringSchema).optional(),
});

export const notifyHumanInputSchema = z.strictObject({
  message: nonEmptyStringSchema,
  severity: z.enum(['info', 'warning']),
});

export const reportProgressInputSchema = z.strictObject({
  summary: nonEmptyStringSchema,
  percent_complete: z.int().min(0).max(100).optional(),
});

export const getTaskContextInputSchema = z.strictObject({
  include: z.array(z.enum(['ticket', 'artifacts', 'feedback', 'mr', 'ci'])).min(1),
});

export const kbSearchInputSchema = z.strictObject({
  query: nonEmptyStringSchema,
  limit: z.int().min(1).max(50).optional(),
});

export const addTicketCommentInputSchema = z.strictObject({
  body: nonEmptyStringSchema,
});

export const openMrInputSchema = z.strictObject({
  title: nonEmptyStringSchema,
  description: nonEmptyStringSchema,
  source_branch: nonEmptyStringSchema,
  target_branch: nonEmptyStringSchema,
  draft: z.boolean(),
});

export const updateMrDescriptionInputSchema = z.strictObject({
  description: nonEmptyStringSchema,
});

export const createFollowupInputSchema = z.strictObject({
  title: nonEmptyStringSchema,
  description: nonEmptyStringSchema,
  labels: z.array(nonEmptyStringSchema).optional(),
});

export type AskHumanInput = z.infer<typeof askHumanInputSchema>;
export type NotifyHumanInput = z.infer<typeof notifyHumanInputSchema>;
export type ReportProgressInput = z.infer<typeof reportProgressInputSchema>;
export type GetTaskContextInput = z.infer<typeof getTaskContextInputSchema>;
export type KbSearchInput = z.infer<typeof kbSearchInputSchema>;
export type AddTicketCommentInput = z.infer<typeof addTicketCommentInputSchema>;
export type OpenMrInput = z.infer<typeof openMrInputSchema>;
export type UpdateMrDescriptionInput = z.infer<typeof updateMrDescriptionInputSchema>;
export type CreateFollowupInput = z.infer<typeof createFollowupInputSchema>;

// ── Session store (TD-007: a best-effort mirror for cross-host resume) ───────

export interface SessionMirrorKey {
  readonly projectKey: string;
  readonly sessionId: string;
  /** Set for a subagent's own transcript; absent for the main one. */
  readonly subpath?: string;
}

/**
 * The SDK's `sessionStore` mirror. TD-007 is explicit that this is *not* the platform's transcript
 * — `run_messages` is, written by our own stream consumer — and that the mirror exists only so a
 * run can be resumed on another host.
 */
export interface SessionMirrorPort {
  append(key: SessionMirrorKey, entries: readonly JsonObject[]): Promise<void>;
  load(key: SessionMirrorKey): Promise<JsonObject[] | null>;
  listSubkeys?(key: Omit<SessionMirrorKey, 'subpath'>): Promise<string[]>;
}

// ── The port itself ──────────────────────────────────────────────────────────

export interface SteerMessage {
  readonly text: string;
  readonly authorUserId: Id;
  /** Rendered into `UserPromptSubmit` context so the model knows who steered (technical/04). */
  readonly authorLabel: string;
}

/** Why the platform stopped a live run. */
export type RunStopReason = 'cancelled' | 'taken_over';

export interface RunHandle {
  readonly runId: Id;
  /** Resolves once — a run has exactly one outcome, however it ended. */
  readonly outcome: Promise<RunOutcome>;
  /** Pushes a user turn into the live session (technical/04 § "Steering"). */
  steer(message: SteerMessage): Promise<void>;
  /** `interrupt()` then end the run. */
  stop(reason: RunStopReason): Promise<void>;
}

export interface ClaudeRunner {
  /**
   * Starts a run. Returns as soon as the session is being established; everything else is observed
   * through the transcript sink and the returned {@link RunHandle}.
   */
  start(spec: RunSpec): RunHandle;
}

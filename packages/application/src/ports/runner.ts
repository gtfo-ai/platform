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
  RunSavedWork,
  RunStartFailure,
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
  RUN_START_FAILURE_DETAIL_MAX_CHARS,
  RUN_START_FAILURE_MESSAGE_MAX_CHARS,
  RUN_START_FAILURE_OUTPUT_MAX_CHARS,
  runModeSchema,
  runSavedWorkSchema,
  shaSchema,
  stageIdSchema,
  unattendedCommandModeSchema,
  usdSchema,
} from '@platform/contracts';
import * as z from 'zod';
import type { SecretRedactor } from './integrations/audit.js';
import {
  boundOutputTail,
  existingProtectedPathsSchema,
  WorkspaceError,
  type WorkspaceErrorCode,
  type WorkspaceErrorReason,
  type WorkspaceProtocols,
  workspaceErrorReasonSchema,
  workspaceProtocolsSchema,
} from './workspace.js';

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
  readonly now: () => number;
  /** Runs `callback` after `delayMs` have passed on this clock. */
  readonly setTimer: (delayMs: number, callback: () => void) => CancelTimer;
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
  /**
   * What the `PreToolUse(Bash)` hook does with an `ask` (BD-025's 2026-10-06 amendment): `auto`
   * runs it in the sandbox, `deny` refuses it — `unattendedCommandModeOf` over the organisation,
   * the settings and the repository file. Required, so no planner can leave a run to a default.
   */
  unattended: unattendedCommandModeSchema,
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

/**
 * What a run's prompt already carries **whole**, so `get_task_context` need not send it again
 * (PROGRESS backlog 474): on Autix the tool re-sent the ticket and the RefinedSpec the user prompt
 * held — about 22 KB of a run's context, twice.
 *
 * Written by the planner from the same cut the assembler applies (`artifactShownWhole`), never
 * re-derived by the tool. Absent for a run whose prompt the tool knows nothing about (the ask, a
 * test's hand-built spec), and then every value is served as before — the safe direction.
 */
export const promptHoldsSchema = z.strictObject({
  ticket: z.boolean(),
  artifacts: z.array(
    z.strictObject({ artifact_type: artifactTypeSchema, version: z.int().positive() }),
  ),
});

export type PromptHolds = z.infer<typeof promptHoldsSchema>;

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
  /**
   * The **branch** the workspace checks out — technical/05 §2's *"checkout of the task branch for
   * re-entries"*, which had no carrier at all until WP-34 (PROGRESS backlog **71**).
   *
   * A branch name, never a commit (WP-105: a commit is {@link checkoutCommit}). `null` means the
   * repository's default branch, which is what the *first* run of a task gets: the task's branch
   * does not exist on the remote yet, and a provisioner that failed on it would fail every task's
   * first stage.
   *
   * One producer, `pipeline/planner.ts`: an ordinary task checks out its **own branch**
   * (`tasks.branch`), so a returned `implementation` run sees what the previous attempt pushed and
   * a `code_review` stage reviews the tree the merge request is about.
   *
   * **It is honoured since WP-53**, which is the mapping backlog 71 was filed for:
   * `runWorkspaceSpecFor` (`packages/infrastructure/src/launcher/provisioner.ts`) writes it to
   * `WorkspaceSpec.repo.checkoutBranch`, and the Docker provider's clone runs
   * `git checkout "$B" || git checkout -b "$B"` — so a task's first run, whose branch is not on the
   * remote, clones the default branch and creates it rather than failing. Measured end to end
   * against a real daemon by `scripts/launcher-control-plane-check.mjs`.
   */
  checkoutRef: nonEmptyStringSchema.nullable(),
  /**
   * The **commit** the workspace checks out, detached — a **shadow** task's base: the merge base of
   * the human merge request it is compared with (Q82 (a)), because a diff written against today's
   * tree and a human diff written against the tree six months ago measure drift, not similarity.
   *
   * Its own field since WP-105 (WP-98's discovered work). Until then the sha travelled in
   * {@link checkoutRef}, and the clone's `checkout "$B" || checkout -b "$B"` — right for a branch a
   * task's first run creates — turned a commit the mirror does not hold into a new branch *named*
   * after the sha at the default branch's head: the run started on today's tree, which Q82 (a) says
   * must be refused. A field per kind is how the workspace tells *a branch that does not exist yet*
   * (create it) from *a commit that does not exist* (refuse the start by name, `invalid_spec`,
   * terminal — `#clone` in `packages/infrastructure/src/workspace/provider.ts`). At most one of the
   * two is set; the planner is the one producer.
   */
  checkoutCommit: shaSchema.nullable(),
  /**
   * Where this run's **unfinished work** goes if it ends without a result — the product owner's
   * 2026-10-05 decision (BD-025's amendment of that date, PROGRESS backlog 467) — or `null` for a
   * run whose work is not saved.
   *
   * One producer, the planner (`unfinishedWorkBranchFor` in `pipeline/unfinished-work.ts`): a
   * Developer run of an ordinary task at any stage but `conflict_resolution`, whose checkout is an
   * `agentic/*` branch — the same value as {@link checkoutRef}, so the work goes back to the branch
   * the run was given. One reader, the workspace runner, which asks the workspace for the export when
   * the outcome is one `savesUnfinishedWork` names. A field rather than a rule the runner re-derives
   * because the runner must not grow a second opinion about roles, stages and task modes.
   */
  unfinishedWorkBranch: runSavedWorkSchema.shape.branch.nullable(),
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
   * BD-024's protected paths (technical/04's WP-99 amendment). A write that **creates** one is
   * allowed; a write to one that **exists** at the merge base with the default branch (`existingProtectedPaths`) is
   * allowed only when a pattern of `plannedProtectedPaths` matches it.
   */
  protectedPaths: z.array(pathPatternSchema),
  /**
   * The latest ImplementationPlan's `protected_path_changes[].path` — the planner reads them through
   * the CI gate's own `exceptionsOf`, and an absent or unparsable plan gives `[]`.
   */
  plannedProtectedPaths: z.array(pathPatternSchema),
  /**
   * Which protected paths exist at the merge base of the checkout and the default branch. The planner writes `unlisted` (nothing is
   * listed before there is a workspace, and `unlisted` fails closed); the workspace runner
   * substitutes the launcher's listing beside `workspacePath`.
   */
  existingProtectedPaths: existingProtectedPathsSchema,
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
  /** {@link promptHoldsSchema}: what `get_task_context` need not send again. Optional. */
  promptHolds: promptHoldsSchema.optional(),
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
  /**
   * Why the run ended. `completed` with `error_max_budget_usd` is a run that delivered a valid
   * artifact in the turn that crossed its cap (product owner, 2026-10-05, BD-010's amendment,
   * PROGRESS backlog 466). The artifact is kept, and the terminal reason is the record of the
   * overrun. Its `cost` is counted like any other ending's.
   */
  readonly terminalReason: RunTerminalReason;
  /** The SDK session id, for resume and take-over. Null when the CLI never initialised. */
  readonly sessionId: string | null;
  readonly numTurns: number;
  readonly usage: TokenUsage;
  readonly modelUsage: readonly ModelUsage[];
  readonly cost: RunCost;
  /**
   * `true` when **nothing measured** this run's spend (WP-101 review round 1): a stop whose
   * interrupted turn sent no `result` within the interrupt grace — a human's cancel or take-over,
   * and since WP-119 a stall or a wall-clock stop (PROGRESS backlog 334), or a crash that ended
   * the session before its `result` (`failed`/`crash`). `cost` then holds the
   * column's floor and is not a figure — the stage executor and the ask executor write `null` to the
   * run row and to the terminal event's `cost`, and the ledger writes no row (standing rule 16).
   * Absent means the cost was reported — or, since WP-150, that the run never asked for its CLI and
   * its cost is the measured zero (`unspawnedStop`); a non-stop ending before the marker is not an
   * outcome at all but a {@link RunStartError}.
   */
  readonly costUnmeasured?: boolean;
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
  /**
   * What the workspace did with this run's unfinished work (PROGRESS backlog 467), set by the
   * workspace runner after the outcome and before the workspace is freed — absent when no export was
   * attempted (a success, a run with no {@link RunSpec.unfinishedWorkBranch}, an ending that is not
   * saved, a take-over, or a workspace with no changes). The stage executor writes it to
   * `runs.saved_work` and the terminal event, and records the branch on the task.
   */
  readonly savedWork?: RunSavedWork;
}

// ── Collaborators ────────────────────────────────────────────────────────────

/**
 * Where normalised, redacted transcript entries go: `run_messages` plus the `run:<id>` SSE topic
 * (TD-007, technical/08). Appends are sequential — the runner awaits each one — so a sink may
 * assume `seq` arrives in order.
 *
 * **Both destinations are real since WP-15h, and only one of them is this port's business.** The
 * production sink writes the row and then announces its *position* on the broadcast
 * (`RUN_TRANSCRIPT_TOPIC`); `apps/server/src/sse/transcript-bridge.ts` reads the row back and
 * publishes the frame, in whichever process holds the stream. An implementation that only writes
 * the row is complete as far as this interface is concerned — the stream is a consequence of the
 * row, not a second obligation on the caller.
 */
export interface RunTranscriptSink {
  readonly append: (event: TranscriptEvent) => Promise<void>;
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
  readonly requestApproval: (request: ToolApprovalRequest) => Promise<ToolApprovalDecision>;
}

/** The in-process MCP server's nine tools (technical/04). Inputs are model-written, so untrusted. */
export interface PlatformToolPort {
  /** Blocking question with a blocker brief; returns the human's answer text. */
  readonly askHuman: (input: AskHumanInput, context: PlatformToolContext) => Promise<string>;
  readonly notifyHuman: (input: NotifyHumanInput, context: PlatformToolContext) => Promise<void>;
  /**
   * Records one progress line in the run's transcript (PROGRESS backlog 496) and answers the model
   * with a short plain acknowledgement — recorded, shortened, or not recorded and why.
   */
  readonly reportProgress: (
    input: ReportProgressInput,
    context: PlatformToolContext,
  ) => Promise<string>;
  readonly getTaskContext: (
    input: GetTaskContextInput,
    context: PlatformToolContext,
  ) => Promise<JsonValue>;
  readonly kbSearch: (input: KbSearchInput, context: PlatformToolContext) => Promise<JsonValue>;
  readonly addTicketComment: (
    input: AddTicketCommentInput,
    context: PlatformToolContext,
  ) => Promise<JsonValue>;
  readonly openMergeRequest: (
    input: OpenMrInput,
    context: PlatformToolContext,
  ) => Promise<JsonValue>;
  readonly updateMrDescription: (
    input: UpdateMrDescriptionInput,
    context: PlatformToolContext,
  ) => Promise<JsonValue>;
  readonly createFollowupTicket: (
    input: CreateFollowupInput,
    context: PlatformToolContext,
  ) => Promise<JsonValue>;
}

export interface PlatformToolContext {
  readonly runId: Id;
  readonly taskId: Id;
  readonly projectId: Id;
  readonly mode: RunMode;
  readonly signal: AbortSignal;
  /**
   * The run's own TD-012 step-1 redactor — the one its transcript is redacted with (WP-138).
   * `platform-mcp.ts` always supplies it; a tool that sends a model's words to a third party
   * (`open_mr`, `update_mr_description`) **refuses** a call that carries none (standing rule 31).
   */
  readonly redactor?: SecretRedactor;
  /** What the run's prompt already carries whole — `RunSpec.promptHolds` (PROGRESS backlog 474). */
  readonly promptHolds?: PromptHolds;
  /**
   * The run's own progress door (PROGRESS backlog 496): the runner builds it over the transcript
   * door it writes every other entry through, so a progress row gets the run's `seq`, its
   * redactor and its sink — and the per-run rate bound, which only the runner can hold. Absent in a
   * composition with no runner behind it, and `report_progress` then refuses.
   */
  readonly progress?: RunProgressRecorder;
}

/** One progress report as the tool hands it to the runner — already bounded (`boundProgressSummary`). */
export interface RunProgressReport {
  readonly summary: string;
  readonly percentComplete: number | null;
  /** The model's summary was longer than `PROGRESS_SUMMARY_MAX_CHARS` and was cut. */
  readonly truncated: boolean;
}

/**
 * What the runner did with a report: recorded, or not and why. A refusal is not an error — the
 * model is told, in one plain sentence, and carries on.
 */
export type RunProgressReceipt =
  | { readonly recorded: true }
  | { readonly recorded: false; readonly reason: 'too_soon'; readonly retryAfterMs: number }
  | { readonly recorded: false; readonly reason: 'run_limit'; readonly limit: number };

export interface RunProgressRecorder {
  readonly record: (report: RunProgressReport) => Promise<RunProgressReceipt>;
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

/**
 * What `get_task_context` may be asked for. `runs` and `audit` joined at WP-54 (PROGRESS backlog
 * 83): they are the two things an ask is asked about, and the platform holds both. The tool's input
 * names **no task and no project** — the run's own come from `PlatformToolContext`, so a model
 * cannot read another task's record by naming it.
 */
export const TASK_CONTEXT_INCLUDES = [
  'ticket',
  'artifacts',
  'feedback',
  'mr',
  'ci',
  'runs',
  'audit',
] as const;

export const getTaskContextInputSchema = z.strictObject({
  include: z.array(z.enum(TASK_CONTEXT_INCLUDES)).min(1),
  /**
   * Narrows `artifacts` to these types (PROGRESS backlog 474): what the tool tells a model to ask
   * for when one artifact did not fit beside the rest, instead of the `/api/…` URL it used to name.
   */
  artifact_types: z.array(artifactTypeSchema).min(1).optional(),
});

export const kbSearchInputSchema = z.strictObject({
  query: nonEmptyStringSchema,
  limit: z.int().min(1).max(50).optional(),
});

export const addTicketCommentInputSchema = z.strictObject({
  body: nonEmptyStringSchema,
});

/**
 * `open_mr`'s input (WP-138 ruling (b)): the model supplies the **title and the description**.
 * `draft` defaults to `true`. `source_branch` and `target_branch` are still accepted — a model
 * trained on the older shape sends them — and **ignored**: the platform opens from the task's own
 * branch into the project's default branch, and its answer names both.
 */
export const openMrInputSchema = z.strictObject({
  title: nonEmptyStringSchema,
  description: nonEmptyStringSchema,
  draft: z.boolean().optional(),
  source_branch: nonEmptyStringSchema.optional(),
  target_branch: nonEmptyStringSchema.optional(),
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
  readonly append: (key: SessionMirrorKey, entries: readonly JsonObject[]) => Promise<void>;
  readonly load: (key: SessionMirrorKey) => Promise<JsonObject[] | null>;
  readonly listSubkeys?: (key: Omit<SessionMirrorKey, 'subpath'>) => Promise<string[]>;
}

// ── The port itself ──────────────────────────────────────────────────────────

export interface SteerMessage {
  readonly text: string;
  readonly authorUserId: Id;
  /** Rendered into `UserPromptSubmit` context so the model knows who steered (technical/04). */
  readonly authorLabel: string;
}

/**
 * Why the platform stopped a live run.
 *
 * `shutdown` (WP-144) is the process's own stop: the `runner` holding the run was asked to stop
 * (SIGTERM), so it interrupts the session and hands the run back — the run ends `failed` with the
 * terminal reason `shutdown` and the stage entry (or the ask) is re-enqueued, bounded
 * (`MAX_SHUTDOWN_HAND_BACKS`). No person asked for it, which is why it is not `cancelled`.
 */
export type RunStopReason = 'cancelled' | 'taken_over' | 'shutdown';

/**
 * What a take-over asks the run's **workspace** for on the way out (product/19 §19, WP-27).
 *
 * It travels with the stop rather than being asked for afterwards, because after the stop there is
 * nothing left to ask: `createWorkspaceClaudeRunner` releases the workspace in a `finally` on the
 * outcome, and the container is gone by the time any caller learns the run ended. The one call that
 * interrupts the session is therefore also the one that says what to do with the tree it was
 * working in.
 *
 * Nothing here is a credential: the launcher already holds the run's own git token (WP-14's broker)
 * and is the only thing allowed near a daemon (TD-021).
 */
export interface RunTakeOverExport {
  /** BD-025's namespace, always. `agentic/<task>` (product/19 §19). */
  readonly branch: string;
  /** product/19:84's one permitted `wip:` commit — `wip: hand-over to <user>`. */
  readonly commitMessage: string;
  /** Whether the launcher also writes a tarball of the checkout into its `exports` volume. */
  readonly tarball: boolean;
  /** technical/05 §5's fourteen days: when the workspace volume may be purged after all. */
  readonly keepUntil: string;
}

/**
 * Why the platform is ending this run, and what the ending owes.
 *
 * A discriminated union rather than the bare reason it used to be, because the two endings owe
 * different things: a cancel ends the session and gives the workspace back, and a take-over ends the
 * session, commits and pushes what the agent had reached, optionally archives it, and extends the
 * volume's retention (technical/05 §5). Making the payload part of the `taken_over` arm is what
 * stops a caller from asking for a take-over without saying where the work should go.
 */
export type RunStop =
  | { readonly reason: 'cancelled' }
  | { readonly reason: 'shutdown' }
  | { readonly reason: 'taken_over'; readonly workspaceExport: RunTakeOverExport };

export interface RunHandle {
  readonly runId: Id;
  /**
   * The SDK session this run is in, or `null` until the CLI has reported one.
   *
   * A **getter on the handle** and not a field, because the value arrives mid-run: the session id
   * is on the CLI's `init` message, and `runs.session_id` is not written until the run *ends*
   * (`RunRepository.finish`). A take-over interrupts a run that has not ended, so the row cannot
   * answer it and the only holder is the runner — which is why `claude --resume <session>`
   * (product/19 §19) is reachable at all.
   */
  readonly sessionId: string | null;
  /** Resolves once — a run has exactly one outcome, however it ended. */
  readonly outcome: Promise<RunOutcome>;
  /** Pushes a user turn into the live session (technical/04 § "Steering"). */
  readonly steer: (message: SteerMessage) => Promise<void>;
  /** `interrupt()` then end the run; a take-over also says what its workspace owes. */
  readonly stop: (stop: RunStop) => Promise<void>;
}

/**
 * What the process holding a run lends the runner for one start (WP-150, BD-010's 2026-10-06
 * amendment).
 *
 * The run's caller owns the database; the runner owns the moment the CLI is asked for. The one
 * thing the two must agree on is that moment, so the caller hands it in rather than the runner
 * growing a store.
 */
export interface RunStartHooks {
  /**
   * Records, in **its own committed transaction**, that this run's CLI is about to be asked to
   * start — `runs.cli_spawn_requested_at`, a compare-and-set that writes only where the column is
   * null and the run has not ended (`RunRepository.markCliSpawnRequested`).
   *
   * A runner calls it **at most once**, awaits it, and asks for no CLI unless it answered `true`.
   * For the run shim that is between `hello.ok` and the `spawn` frame (TD-025); for a runner with no
   * handshake, before it starts the session. `false` means the run has already ended (a cancel or a
   * sweep won the row); a throw means the write failed. Either way no CLI is started, and the run
   * is a start failure that spent nothing. A run whose marker was never written cannot have sent a
   * model request, which is what lets every cap count it as a **measured zero** rather than hold it
   * (`../cost/pending.ts`).
   */
  readonly beforeCliSpawn: () => Promise<boolean>;
}

export interface ClaudeRunner {
  /**
   * Starts a run. Returns as soon as the session is being established; everything else is observed
   * through the transcript sink and the returned {@link RunHandle}.
   *
   * `hooks` is required (WP-150): a wrapper that dropped it would start CLIs nobody recorded, which
   * every cap would then count as free.
   */
  readonly start: (spec: RunSpec, hooks: RunStartHooks) => RunHandle;
}

/**
 * A run that could not be started — and whether starting it again could work (Q59(a), WP-15g).
 *
 * ## Why the distinction is on the *error* and not in a task state
 *
 * WP-15c gave a throwing `start` an ending: the run it had already created is failed and the task is
 * escalated to `needs_human`, in one transaction, because `escalateTask` already means *a human must
 * act* and a third spelling of "stuck" would be a state no query, template or screen knows (Q59).
 * That is right for a **terminal** failure and wrong for a **transport** one: the runner reaches its
 * workspace over a Unix socket on a shared volume (TD-025 §2), and a launcher restarting, a control
 * directory not yet mounted or a handshake timing out is a condition that is over in seconds — while
 * escalation happens on the *first* failure, so a transport that flaps would park one task per flap
 * and need a human per flap.
 *
 * So the runner says which kind it was, and `stage-executor.ts` decides what to do with it:
 * `retryable` re-enqueues the stage's job a bounded number of times
 * (`MAX_RUN_START_ATTEMPTS`, `RUN_START_RETRY_MS`) and escalates when the budget is spent, so *one
 * flap does not escalate a task and an unbounded retry does not hide a dead launcher*. Anything
 * that is not a `RunStartError` — a programming error, a bad spec, a refusal — is terminal, which
 * is the fail-closed default: a new failure shape escalates to a human rather than spinning.
 *
 * **This error's own message never reaches stored state.** A runner's error may quote a provider,
 * a URL or a credential, so `run.failed.error` carries only the class name, the retry count and the
 * {@link RunStartDiagnosis}; the message goes to the log line beside them. The diagnosis is the part
 * a human can act on (WP-127, PROGRESS backlog 351): the workspace's error kind and its
 * platform-chosen reason code, both closed vocabularies, and a commit only through `shaSchema`.
 * Since backlog 453 the **workspace's** words — the launcher's sentence and the failing helper's
 * output tail — are stored too, beside the diagnosis and never in it: through the run's own
 * redactor, bounded, as untrusted text ({@link runStartFailureOf}).
 */
export class RunStartError extends Error {
  override readonly name = 'RunStartError';
  /** `true` when the same spec could start on a later attempt: a transport fault, not a refusal. */
  readonly retryable: boolean;
  /** What the platform itself knows about the cause, or `null` when it knows nothing it wrote. */
  readonly diagnosis: RunStartDiagnosis | null;

  constructor(
    message: string,
    options: {
      readonly retryable: boolean;
      readonly cause?: unknown;
      readonly diagnosis?: RunStartDiagnosis | null;
    },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.retryable = options.retryable;
    this.diagnosis =
      options.diagnosis ??
      (options.cause instanceof WorkspaceError ? diagnosisOfWorkspaceError(options.cause) : null);
  }
}

/**
 * The platform-written half of a start failure (WP-127): every field a closed vocabulary or a sha.
 * Never a message, never a detail — those can quote a daemon, an image reference or a provider.
 */
export interface RunStartDiagnosis {
  readonly kind: WorkspaceErrorCode;
  readonly reason: WorkspaceErrorReason | null;
  readonly commit: string | null;
  /**
   * The runner's and the shim's protocol versions (WP-151, PROGRESS backlog 500) — for
   * `runlet_protocol_mismatch` (the shim's `fatal` named both) and for the launcher's
   * `runtime_image_protocol_mismatch` / `runtime_image_protocol_missing` (the run image's label, or
   * `null` for none). Integers, so they stand in the platform-written sentence beside the reason
   * rather than in the untrusted `detail`. Absent for every other cause.
   */
  readonly protocols?: WorkspaceProtocols | null;
}

export const diagnosisOfWorkspaceError = (error: WorkspaceError): RunStartDiagnosis => ({
  kind: error.code,
  reason: error.reason,
  commit: error.commit,
  ...(error.protocols === null ? {} : { protocols: error.protocols }),
});

const WORKSPACE_ERROR_KINDS: readonly WorkspaceErrorCode[] = [
  'invalid_spec',
  'engine_unavailable',
  'workspace_failed',
  'not_found',
];

/**
 * The sentence a start failure contributes to the run's error and the task's escalation — **platform
 * text only** (WP-127, PROGRESS backlog 351).
 *
 * The class name, then the diagnosis when there is one: `RunStartError: invalid_spec,
 * checkout_commit_missing, commit 0123abc…`, or `RunStartError: workspace_failed,
 * runlet_protocol_mismatch, runner protocol 3, shim protocol 2` (WP-151). Each field is re-read
 * through its own schema here rather than trusted to have been set by the constructor, because a
 * `RunStartError` is an object any caller can build, and this string is written with no redactor.
 * A field that does not parse is left out, never quoted.
 */
export const describeStartFailure = (error: unknown): string => {
  if (!(error instanceof Error)) {
    return 'unknown error';
  }
  const diagnosis =
    error instanceof RunStartError
      ? error.diagnosis
      : error instanceof WorkspaceError
        ? diagnosisOfWorkspaceError(error)
        : null;
  if (diagnosis === null) {
    return error.name;
  }
  const parts: string[] = [];
  if (WORKSPACE_ERROR_KINDS.includes(diagnosis.kind)) {
    parts.push(diagnosis.kind);
  }
  const reason = workspaceErrorReasonSchema.safeParse(diagnosis.reason).data;
  if (reason !== undefined) {
    parts.push(reason);
  }
  const commit = shaSchema.safeParse(diagnosis.commit).data;
  if (commit !== undefined) {
    parts.push(`commit ${commit}`);
  }
  // WP-151: two integers through their schema, so nothing but digits reaches this sentence.
  const protocols = workspaceProtocolsSchema.safeParse(diagnosis.protocols).data;
  if (protocols !== undefined) {
    parts.push(
      `runner protocol ${protocols.runner}`,
      `shim protocol ${protocols.shim === null ? 'undeclared' : protocols.shim}`,
    );
  }
  return parts.length === 0 ? error.name : `${error.name}: ${parts.join(', ')}`;
};

/**
 * The workspace failure under a start failure, or `null` — the one source of words a
 * {@link RunStartFailure} may carry (backlog 453).
 */
const workspaceErrorOf = (error: unknown): WorkspaceError | null => {
  if (error instanceof WorkspaceError) {
    return error;
  }
  if (error instanceof RunStartError && error.cause instanceof WorkspaceError) {
    return error.cause;
  }
  return null;
};

/**
 * What the run row and `run.failed` record about a run that **never started** (PROGRESS backlog
 * 453): {@link describeStartFailure}'s closed-vocabulary sentence, and the launcher's own words.
 *
 * ## Which words, and why these
 *
 * Only a **workspace** failure contributes any: its message (the launcher's sentence — *"Docker
 * engine request timed out"*, *"helper prep-… exited 1"*) and its `output` (the failing helper's log
 * tail, already redacted by the launcher against the secrets that helper held). A runner that
 * refused the spec, or a process with no launcher, contributes nothing but the diagnosis: their
 * messages were never written to be published. Until backlog 453 a workspace failure contributed
 * nothing either — the class name went to the task and the words went to the runner's log only,
 * which is where the first local test's three failed discovery attempts had to be diagnosed from.
 *
 * ## Why it is safe to store now
 *
 * The old rule was *"the executor holds no redactor"*. It holds one: the run's own TD-012 redactor
 * (`composeSecretRedactors` over the pattern redactor and the run's injected secrets), so the text
 * is redacted **here, over all of what arrived, before** it is cut again — a bound applied first
 * could split a secret and hide it from the redactor. The launcher's own cut came earlier (it
 * redacted against the helper's secrets first) and dropped the partial token it left at the front
 * (`boundOutputTail`), so what reaches this redactor is whole tokens. It is then bounded (the
 * message's head, the output's tail) and every cut, the launcher's included, is announced in
 * `truncated`, never inside the text. It stays untrusted (BD-022): a clone's stderr quotes text
 * the repository controls, and every reader renders it as text.
 */
export const runStartFailureOf = (
  error: unknown,
  input: {
    readonly redactor: SecretRedactor;
    readonly attempt: number;
    readonly retryable: boolean;
  },
): RunStartFailure => {
  const diagnosis = describeStartFailure(error).slice(0, RUN_START_FAILURE_MESSAGE_MAX_CHARS);
  const workspace = workspaceErrorOf(error);
  const base = {
    kind: 'not_started' as const,
    diagnosis: diagnosis === '' ? 'unknown error' : diagnosis,
    attempt: input.attempt,
    retryable: input.retryable,
  };
  if (workspace === null) {
    return { ...base, detail: null, truncated: false };
  }
  const message = input.redactor.redactText(workspace.message.trim()).value;
  const output = workspace.output === null ? '' : input.redactor.redactText(workspace.output).value;
  const head = message.slice(0, RUN_START_FAILURE_MESSAGE_MAX_CHARS);
  // A placeholder can lengthen the text past the launcher's bound, so it is cut again here, after
  // the redactor, with the same rule: the tail, without a partial token at its front.
  const tail = boundOutputTail(output, RUN_START_FAILURE_OUTPUT_MAX_CHARS);
  const detail = [head, tail.text]
    .filter((part) => part !== '')
    .join('\n')
    .slice(0, RUN_START_FAILURE_DETAIL_MAX_CHARS);
  return {
    ...base,
    detail: detail === '' ? null : detail,
    truncated: head.length < message.length || tail.cut || workspace.outputTruncated,
  };
};

/**
 * Is this failure worth another attempt?
 *
 * A predicate rather than an `instanceof` at the call site, because "not a `RunStartError`" must
 * answer **false** — the fail-closed direction — and a call site that wrote the check itself would
 * eventually write it the other way round.
 */
export const isRetryableStartFailure = (error: unknown): boolean =>
  error instanceof RunStartError && error.retryable;

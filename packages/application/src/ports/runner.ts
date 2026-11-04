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
 * transcript rows — and a `RunSpec` was none of those while it never left the process. Since WP-273
 * it does: a remote worker's run package carries it (TD-031 decision 4), camelCase, which is the
 * deviation `@platform/contracts`'s `run-spec.ts` (where the schemas live now) and `worker.ts` state.
 */
import type {
  Id,
  JsonObject,
  JsonValue,
  ModelUsage,
  PlatformToolName,
  PromptHolds,
  RunCommandPolicy,
  RunContextDocument,
  RunCost,
  RunLimits,
  RunMode,
  RunSavedWork,
  RunSpec,
  RunStartFailure,
  RunStatus,
  RunSubagent,
  RunTerminalReason,
  TokenUsage,
  TranscriptEvent,
} from '@platform/contracts';
import {
  artifactTypeSchema,
  MUTATING_PLATFORM_TOOLS,
  nonEmptyStringSchema,
  PLATFORM_TOOL_NAMES,
  platformToolNameSchema,
  promptHoldsSchema,
  RUN_START_FAILURE_DETAIL_MAX_CHARS,
  RUN_START_FAILURE_MESSAGE_MAX_CHARS,
  RUN_START_FAILURE_OUTPUT_MAX_CHARS,
  runCommandPolicySchema,
  runContextDocumentSchema,
  runLimitsDefaults,
  runLimitsSchema,
  runSpecSchema,
  runSubagentSchema,
  shaSchema,
} from '@platform/contracts';
import * as z from 'zod';
import type { SecretRedactor } from './integrations/audit.js';
import {
  boundOutputTail,
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

// The RunSpec schemas moved to `@platform/contracts` (`run-spec.ts`) at WP-273 — TD-031 decision 4
// puts the RunSpec in the run package a remote worker receives — and are re-exported unchanged.
export type {
  PlatformToolName,
  PromptHolds,
  RunCommandPolicy,
  RunContextDocument,
  RunLimits,
  RunSpec,
  RunSubagent,
};
export {
  MUTATING_PLATFORM_TOOLS,
  PLATFORM_TOOL_NAMES,
  platformToolNameSchema,
  promptHoldsSchema,
  runCommandPolicySchema,
  runContextDocumentSchema,
  runLimitsDefaults,
  runLimitsSchema,
  runSpecSchema,
  runSubagentSchema,
};

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
  /**
   * Why a **stop that landed before the CLI spawn marker** went no further (WP-154 (b′), PROGRESS
   * backlog 502) — set by the process holding the run (`unspawnedStop` with
   * `stoppedBeforeCliSpawn`), never by a runner. The stage and ask executors write it to
   * `runs.exit_detail` and the terminal event's `start_failure`; absent for every other ending.
   */
  readonly startFailure?: RunStartFailure;
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

/** The in-process MCP server's ten tools (technical/04). Inputs are model-written, so untrusted. */
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
  /**
   * The run's own task's conversation — the merge request's discussions and the ticket's comments
   * (WP-180, TD-029 decision 11): the entries the prompt's `conversation` blocks carry, read by the
   * same reader (`createConversationReader`, `conversationToolAnswer`), with the raw author, handle
   * and path. A read; the input names no task.
   */
  readonly getConversation: (
    input: GetConversationInput,
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

/**
 * `get_conversation` takes nothing (WP-180): the task is the run's own, from `PlatformToolContext`,
 * so a model cannot read another task's conversation by naming it.
 */
export const getConversationInputSchema = z.strictObject({});

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
export type GetConversationInput = z.infer<typeof getConversationInputSchema>;
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
 * **Why the platform stopped a run** — the closed vocabulary of the `run_stopped` transcript row's
 * `data.reason` (`claude-runner.ts`'s `StopCause`): the runner's own stops beside a holder's
 * {@link RunStopReason}. It is what `settleRun`'s request carries as `stopReason` (WP-275a, TD-031's
 * 2026-11-04 amendment §1), so a claimant's stop register crosses as a closed word and a worker's
 * (WP-281) is validated against {@link runStoppedReasonSchema} at the boundary.
 */
export const RUN_STOPPED_REASONS = [
  'stalled',
  'timed_out',
  'budget_exceeded',
  'cost_unreported',
  'cancelled',
  'taken_over',
  'shutdown',
] as const;
export type RunStoppedReason = (typeof RUN_STOPPED_REASONS)[number];
export const runStoppedReasonSchema = z.enum(RUN_STOPPED_REASONS);

/** A stop register's word as the closed vocabulary, or `null` for none or for a word it lacks. */
export const runStoppedReasonOf = (value: string | null): RunStoppedReason | null =>
  value === null ? null : (runStoppedReasonSchema.safeParse(value).data ?? null);

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
  /**
   * The CLI was **not** asked for after all (WP-163, BD-010's 2026-10-08 amendment): the marker was
   * written — `beforeCliSpawn` answered `true` — and then the run shim's transport ended, the run
   * was stopped or its process was killed before the `spawn` frame left the runner. Called at most
   * once, only after a `beforeCliSpawn` that answered `true`, and never after a frame was sent, so
   * a run told this cannot have reached a model. A runner with no frame to withhold never calls it.
   */
  readonly cliSpawnWithheld: () => void;
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
  return { ...base, ...boundedStartFailureDetail(message, output, workspace.outputTruncated) };
};

/**
 * **A run that never started, as a claimant reports it** — `settleRun`'s `not_started` outcome
 * (WP-275a, TD-031's 2026-11-04 amendment §§1, 3). A distinct type and never a fabricated
 * `RunOutcome`: settle's `record` never sees one.
 *
 * The claimant classifies and quotes; it does **not** redact, bound to the record's caps, or decide
 * whether the stage goes again. The redacted {@link RunStartFailure} is built in settle with the
 * settle's redactor ({@link runStartFailureFromReport}), and `retryable` is
 * `transient && attempt < MAX_RUN_START_ATTEMPTS` with the attempt counted from stored rows.
 */
export interface NotStartedReport {
  readonly kind: 'not_started';
  /** {@link describeStartFailure}'s closed-vocabulary sentence, unchanged. */
  readonly failure: string;
  /**
   * The launcher's own words — its message, a newline, the failing helper's output tail —
   * **unredacted**, bounded by the claimant at {@link NOT_STARTED_REPORT_DETAIL_MAX_CHARS}; `null`
   * when no workspace said anything.
   */
  readonly detail: string | null;
  /**
   * Whether {@link detail} is already a cut — the launcher's tail of a longer output, or the
   * claimant's own bound — so the record can announce it (backlog 453: a cut is announced in
   * `truncated`, never inside the text). A field the amendment's sketch does not list: without it
   * the record would claim a whole output it never had (the deviation is stated in technical/04's
   * TD-031 amendment note on the stored plan).
   */
  readonly detailTruncated: boolean;
  /** {@link isRetryableStartFailure} — the classification only. */
  readonly transient: boolean;
  /** WP-150's marker: the run may have reached its CLI (written, and its frame not withheld). */
  readonly spawnRequested: boolean;
}

/**
 * The claimant's bound on {@link NotStartedReport.detail} — far above the record's own caps, so a
 * cut here is never the one that decides what is stored (settle redacts **before** it cuts, and a
 * bound applied first could split a secret). Only a runaway message reaches it.
 */
export const NOT_STARTED_REPORT_DETAIL_MAX_CHARS = 16_000;

/** What a claimant reports about a start that threw (module docblock of {@link NotStartedReport}). */
export const notStartedReportOf = (
  error: unknown,
  input: { readonly spawnRequested: boolean },
): NotStartedReport => {
  const workspace = workspaceErrorOf(error);
  const words =
    workspace === null
      ? ''
      : [workspace.message.trim(), workspace.output ?? ''].filter((part) => part !== '').join('\n');
  const cut = words.length > NOT_STARTED_REPORT_DETAIL_MAX_CHARS;
  return {
    kind: 'not_started',
    failure: describeStartFailure(error),
    detail: words === '' ? null : words.slice(0, NOT_STARTED_REPORT_DETAIL_MAX_CHARS),
    detailTruncated: cut || (workspace?.outputTruncated ?? false),
    transient: isRetryableStartFailure(error),
    spawnRequested: input.spawnRequested,
  };
};

/**
 * The record of a reported start failure — {@link runStartFailureOf}'s rule over a
 * {@link NotStartedReport} rather than an error object: the report's words split back into the
 * launcher's message (the first line) and its output (the rest), each redacted **whole** by the
 * settle's redactor, then bounded and the cuts announced.
 */
export const runStartFailureFromReport = (
  report: NotStartedReport,
  input: {
    readonly redactor: SecretRedactor;
    readonly attempt: number;
    readonly retryable: boolean;
  },
): RunStartFailure => {
  const diagnosis = report.failure.slice(0, RUN_START_FAILURE_MESSAGE_MAX_CHARS);
  const base = {
    kind: 'not_started' as const,
    diagnosis: diagnosis === '' ? 'unknown error' : diagnosis,
    attempt: input.attempt,
    retryable: input.retryable,
  };
  if (report.detail === null) {
    return { ...base, detail: null, truncated: false };
  }
  const newline = report.detail.indexOf('\n');
  const message = newline < 0 ? report.detail : report.detail.slice(0, newline);
  const rest = newline < 0 ? '' : report.detail.slice(newline + 1);
  return {
    ...base,
    ...boundedStartFailureDetail(
      input.redactor.redactText(message.trim()).value,
      rest === '' ? '' : input.redactor.redactText(rest).value,
      report.detailTruncated,
    ),
  };
};

/** The head of the message and the tail of the output, after the redactor, cuts announced. */
const boundedStartFailureDetail = (
  message: string,
  output: string,
  alreadyCut: boolean,
): { readonly detail: string | null; readonly truncated: boolean } => {
  const head = message.slice(0, RUN_START_FAILURE_MESSAGE_MAX_CHARS);
  // A placeholder can lengthen the text past the launcher's bound, so it is cut again here, after
  // the redactor, with the same rule: the tail, without a partial token at its front.
  const tail = boundOutputTail(output, RUN_START_FAILURE_OUTPUT_MAX_CHARS);
  const detail = [head, tail.text]
    .filter((part) => part !== '')
    .join('\n')
    .slice(0, RUN_START_FAILURE_DETAIL_MAX_CHARS);
  return {
    detail: detail === '' ? null : detail,
    truncated: head.length < message.length || tail.cut || alreadyCut,
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

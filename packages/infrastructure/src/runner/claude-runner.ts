/**
 * The `ClaudeRunner` adapter — technical/04's "Runner service (infrastructure)".
 *
 * ```
 * RunSpec ─► query() streaming input ─► every SDKMessage ─► normalise ─► redact ─► sink
 *              ├─ hooks            (hooks.ts)
 *              ├─ canUseTool       (permission.ts)
 *              ├─ MCP "platform"   (platform-mcp.ts)
 *              └─ sessionStore     (session-mirror.ts)
 *          result ─► structured output re-validated ─► usage/cost ─► RunOutcome
 * ```
 *
 * ## The two timers, and why they are not `setTimeout`
 *
 * A run ends for one of five reasons: the CLI produced a `result`; the stall timer fired; the
 * wall-clock timer fired; the platform refused the `result`'s cost; or a human cancelled. The last
 * four are *the platform stopping the model*, and the timers are armed on the injected
 * {@link RunnerClock}, so both can be reached in a test in microseconds — which is the only way a
 * test of a five-minute stall detector proves anything (WP-06a).
 *
 * The stall timer is re-armed on **transcript output**, not on message arrival. They differ: the
 * SDK emits keep-alives and control traffic that are not the model doing work, and a stall detector
 * that a keep-alive resets is a stall detector that never fires.
 *
 * **An `api_retry` entry is transcribed and is not progress** (WP-127, PROGRESS backlog 346). With
 * no route to the model — the egress sidecar down, the provider unreachable — the CLI retries with a
 * growing delay instead of failing, and each retry is a `system` message. Before WP-127 each one
 * re-armed the stall. Now the stall runs across them, and a run that ends with nothing but retries
 * since its last progress — `stalled` by this timer, or the CLI's own give-up — carries an error that
 * says so in platform text ({@link retriedWithoutModel}): the retry count this runner counted and the
 * HTTP statuses the retries reported, as integers, never the CLI's words. Measured on the pinned CLI
 * with its sidecar stopped (WP-127): ten retries, the delay doubling from 0.6 s to a cap near 35 s,
 * and the CLI's give-up — a synthetic assistant message and an `error_during_execution` result —
 * about three minutes after its first request. The synthetic message (`model: "<synthetic>"`) is the
 * CLI reporting its own failure, so it is neither progress nor a retry.
 *
 * ## The budget check is a post-`result` relabel, not a mid-turn stop
 *
 * Say exactly what it is, because WP-15 will plan around this paragraph. `maxBudgetUsd` is passed
 * to the CLI, which is the only party that can stop a turn while it is running and ends it with
 * `error_max_budget_usd`. The platform's own check reads {@link reportedCostUsd} off the `result`
 * **after the turn is over**: it changes the outcome (`budget_exceeded`) and it stops the session,
 * but it cannot claw back money already spent, and a stage run is one turn so there is no second
 * turn for it to prevent. The mid-turn stop would need a running cost the SDK does not publish; the
 * platform's price table (WP-19) is where that comes from if it is ever wanted.
 *
 * **An artifact delivered in the turn that crossed the cap is kept** (product owner, 2026-10-05,
 * BD-010's amendment, PROGRESS backlog 466). Until then no structured output was accepted from either
 * budget ending, and an architect run lost the plan the CLI had already acknowledged. Both budget
 * endings — the CLI's `error_max_budget_usd` and the relabel above — now read
 * {@link DeliveredArtifact}: the last top-level `StructuredOutput` `tool_use` whose `tool_result` was
 * not an error. When it validates against `spec.artifactType`, the outcome is `completed` with
 * `error_max_budget_usd`, and the cost is unchanged. No other ending reads it.
 *
 * Two things it *does* do, and both matter because "the vendor enforces it" is a claim about a
 * binary the platform ships but does not control — and, from WP-13 on, about a stream produced by
 * `agentic-runlet` rather than by the CLI directly:
 *
 *  1. a `success` result whose cost is over the ceiling the CLI was given becomes `budget_exceeded`;
 *  2. a result with **no usable cost at all** — absent, `null`, a string, `NaN`, `Infinity`,
 *     negative — stops the run as `cost_unreported`. Not `0`: a budget guard that cannot see the
 *     cost has not verified the budget, so the unverified case fails closed and carries its own
 *     name into the transcript and the outcome's `error`.
 *
 * The same reading applies to every other number the `result` line carries: `numTurns` goes through
 * `reportedCount`, so a missing `num_turns` is `0` rather than `undefined` on a `number` field, and
 * a `"7"` off the wire is not a string in `RunOutcome`.
 *
 * ## One turn
 *
 * A stage run is one user turn: the CLI emits exactly one `result` per turn, so the loop ends at
 * the first one. A steer arriving mid-turn is folded into the running turn by the CLI (verified in
 * the `SDKUserMessage` / `interrupt` documentation), so steering does not add a second result.
 *
 * ## Everything written is redacted, on both branches
 *
 * `append` is the single door to the transcript: it redacts, restores the envelope over the
 * redacted copy, validates against `transcriptEventSchema`, and only then reaches the sink. There
 * is no second path, so a failure branch cannot skip it. The one thing redaction may never touch is
 * the envelope (`run_id`, `seq`, `created_at`, `kind`), which is re-applied afterwards rather than
 * trusted to be unmatched by a rule.
 */
import type {
  Options,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKUserMessage,
  SpawnedProcess,
  SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type {
  ClaudeRunner,
  Logger,
  PlatformToolPort,
  RunHandle,
  RunnerClock,
  RunOutcome,
  RunSpec,
  RunStop,
  RunStopReason,
  RunTranscriptSink,
  SecretRedactor,
  SessionMirrorPort,
  SteerMessage,
  TerminalRunStatus,
  ToolApprovalPort,
  WorkspaceCliEnvironment,
} from '@platform/application';
import { runSpecSchema, silentLogger } from '@platform/application';
import type {
  JsonObject,
  JsonValue,
  ModelUsage,
  RunTerminalReason,
  TokenUsage,
  TranscriptEvent,
} from '@platform/contracts';
import { transcriptEventSchema } from '@platform/contracts';
import type { ResolvedCommandPolicy } from '@platform/domain';
import { composeRedactors, patternRedactor } from '../redaction/pattern-redaction.js';
import { createAsyncQueue, deferred } from './async-queue.js';
import { buildHooks, type HookRecord } from './hooks.js';
import { buildQueryOptions } from './options.js';
import { buildCanUseTool } from './permission.js';
import { createPlatformMcpServer } from './platform-mcp.js';
import { toSdkSessionStore } from './session-mirror.js';
import { createStderrLog } from './stderr-log.js';
import { createStreamBlockCoalescer } from './stream-block-coalescer.js';
import { validateStructuredOutput } from './structured-output.js';
import {
  normaliseMessage,
  normaliseModelUsage,
  normaliseUsage,
  reportedCostUsd,
  reportedCount,
  type TranscriptEnvelope,
  terminalReasonOf,
} from './transcript-normaliser.js';

export type QueryFunction = typeof sdkQuery;

/**
 * `Options.spawnClaudeCodeProcess`, optionally with the seam a transport's stderr leaves through
 * (WP-127, PROGRESS backlog 344). `runlet/spawn-adapter.ts`'s `RunletSpawn` is one.
 */
export type ClaudeCodeSpawn = ((options: SpawnOptions) => SpawnedProcess) & {
  readonly setStderrSink?: (sink: ((chunk: string) => void) | null) => void;
};

export interface ClaudeRunnerDependencies {
  readonly sink: RunTranscriptSink;
  readonly approvals: ToolApprovalPort;
  readonly tools: PlatformToolPort;
  readonly clock: RunnerClock;
  readonly logger?: Logger;
  /**
   * TD-012 step 1 for this run: exact match of every secret the platform injected into it.
   *
   * **Required, with no default.** A redactor that defaults to "do nothing" is indistinguishable at
   * the call site from one that works. The runner composes the pattern rules (step 2) *after*
   * whatever this returns, so the composition root supplies only the half it knows — the values
   * behind `RunSpec.secretEnvNames`. The production implementation is WP-07's `exactSecretRedactor`
   * (`packages/application/src/integrations/redaction.ts`); the `SecretRedactor` port it satisfies
   * is declared beside WP-07's audit port in `packages/application/src/ports/integrations/audit.ts`.
   */
  injectedSecretRedactorFor(spec: RunSpec): SecretRedactor;
  readonly sessionMirror?: SessionMirrorPort;
  /**
   * WP-13's run shim goes here; `fakeSpawnClaudeCodeProcess` goes here in tests (TD-025). When it
   * exposes `setStderrSink` (the runlet transport does, WP-127), the runner sets its own redacting
   * sink on it: the SDK reads stderr only from a process it spawned itself.
   */
  readonly spawnClaudeCodeProcess?: ClaudeCodeSpawn;
  /**
   * The launcher's answer for this run's container (WP-118, TD-025's amendment): the proxy,
   * `HOME`, `CLAUDE_CONFIG_DIR`, the image's `PATH` and the git credential helper, composed into the
   * CLI's environment by `cliEnvironment` (`./options.ts`). Absent for a run with no launcher.
   */
  readonly workspaceEnvironment?: WorkspaceCliEnvironment;
  /** Injected only by tests that need to observe the options; defaults to the SDK's `query`. */
  readonly query?: QueryFunction;
}

const ZERO_USAGE: TokenUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_write_5m_tokens: 0,
  cache_write_1h_tokens: 0,
  cache_read_tokens: 0,
};

/** Why the platform stopped the run, when it was the platform that stopped it. */
type StopCause = 'stalled' | 'timed_out' | 'budget_exceeded' | 'cost_unreported' | RunStopReason;

/**
 * The stops whose interrupted turn's `result` is read for its cost — a human's two (WP-101) and,
 * since WP-119 (PROGRESS backlog 334, the M7 ruling), the platform's stall and wall-clock stops.
 *
 * The decision, per cause, because the backlog entry asked for one each:
 *
 *  - `cancelled`, `taken_over` — **read** (WP-101): the session was spending when a human stopped it.
 *  - `timed_out` — **read**. The wall clock is the most expensive run the platform ends (it ran the
 *    whole `wallClockMs`), and the session may be streaming normally when the timer fires, so the
 *    receipt and the interrupted turn's result are as likely as after a human's stop.
 *  - `stalled` — **read**. A stalled stream is the one least likely to answer, so the read usually
 *    costs the whole grace and finds nothing; that is the bounded price, because the grace is the one
 *    the interrupt already had ({@link INTERRUPT_GRACE_MS}) and a stop never waits longer than it did.
 *  - `budget_exceeded`, `cost_unreported` — not here: both are decided **from** a `result`, so the
 *    run already has the only one it will get.
 *
 * What a stop in this set reads nothing for is **unmeasured** — `RunOutcome.costUnmeasured`, `null`
 * cost columns, no ledger row and a `null` cost on the terminal event — never a measured zero
 * (standing rule 16). Whether the real CLI writes the interrupted turn's result after an interrupt on
 * a stalled or a live stream is **not measured** (WP-33's credential); the fake implements the
 * documented order (`fake-spawn.ts` divergence 8).
 */
const READS_INTERRUPTED_RESULT: ReadonlySet<StopCause> = new Set<StopCause>([
  'cancelled',
  'taken_over',
  // WP-144: the runner's own stop reads the interrupted turn's result within the same grace, so a
  // handed-back run carries what it measured; nothing read is `costUnmeasured` (rule 16).
  'shutdown',
  'stalled',
  'timed_out',
]);

const STOP_STATUS: Record<StopCause, TerminalRunStatus> = {
  stalled: 'stalled',
  timed_out: 'timed_out',
  budget_exceeded: 'budget_exceeded',
  cost_unreported: 'budget_exceeded',
  cancelled: 'cancelled',
  taken_over: 'cancelled',
  // WP-144: a hand-back is a failure the platform retries, never a person's cancel.
  shutdown: 'failed',
};

/**
 * `cost_unreported` reports the budget's terminal reason on purpose.
 *
 * `RunTerminalReason` is a closed contract (`@platform/contracts`, and a PostgreSQL enum behind it),
 * and the pipeline branches on "the budget stopped this run". A run whose cost the platform could
 * not read is a run whose budget was never verified, which is the same branch — one retry under a
 * small extra budget, then escalate (BD-010) — and escalating to a human is the right end for a CLI
 * that stopped reporting what it spent. The distinction the enum cannot carry is carried where a
 * human and the transcript can both see it: {@link STOP_MESSAGE} in `RunOutcome.error`, and the
 * `run_stopped` row's `data.reason`.
 *
 * **It publishes a fault as an overspend, so a consumer that treats the two alike is wrong.** The
 * obligation is on the reader, and it is in two places: a spend total (WP-19's ledger) must not
 * count a `cost_unreported` run — its `cost.usd` is the column's floor, not a measurement — and any
 * message to a human about "the budget ran out" (WP-15) must branch on `data.reason` first, because
 * the honest sentence here is "the run stopped because the platform could not tell what it cost".
 */
const STOP_REASON: Record<StopCause, RunTerminalReason> = {
  stalled: 'stalled',
  timed_out: 'timed_out',
  budget_exceeded: 'error_max_budget_usd',
  cost_unreported: 'error_max_budget_usd',
  cancelled: 'cancelled',
  taken_over: 'cancelled',
  shutdown: 'shutdown',
};

const STOP_MESSAGE: Record<StopCause, string> = {
  stalled: 'the platform stopped the run: stalled',
  timed_out: 'the platform stopped the run: timed_out',
  budget_exceeded: 'the platform stopped the run: budget_exceeded',
  cost_unreported:
    'the platform stopped the run: cost_unreported — the result carried no usable ' +
    'total_cost_usd, so the budget could not be verified and the run fails closed.',
  cancelled: 'the platform stopped the run: cancelled',
  taken_over: 'the platform stopped the run: taken_over',
  shutdown:
    'the platform stopped the run: shutdown — the process holding it was asked to stop, and the ' +
    'run is handed back to be started again',
};

/**
 * The error of a run that ended with nothing but `api_retry` entries since its last progress
 * (WP-127, backlog 346): **platform text**, naming the route rather than quoting the CLI, whose
 * words are producer text. The count is this runner's own and the statuses are integers it checked;
 * no status at all means no request was answered, which is a missing route, not a refusal.
 */
export const retriedWithoutModel = (
  ending: 'stalled' | 'gave_up',
  retries: number,
  statuses: readonly number[],
): string => {
  const head =
    ending === 'stalled'
      ? 'the platform stopped the run: stalled — the CLI retried'
      : 'the CLI gave up after retrying';
  const tried = `${head} the model API ${String(retries)} time${retries === 1 ? '' : 's'} (api_retry)`;
  return statuses.length === 0
    ? `${tried} with no response, so the run has no route to the model host: the run's egress ` +
        'sidecar, its network or the provider is unreachable'
    : `${tried} and the model API answered HTTP ${[...statuses].sort((a, b) => a - b).join(', ')}, ` +
        'so the provider failed or refused the requests';
};

/** What an appended entry is to the stall detector (WP-127). */
type Progress = 'progress' | 'retry' | 'neutral';

/**
 * `retry` for an `api_retry`; `neutral` for the CLI's synthetic assistant message — its own report
 * of a failure, `model: "<synthetic>"`, measured as the message before the give-up's `result`;
 * `progress` for everything else.
 */
const progressOf = (message: SDKMessage): Progress => {
  if (message.type === 'system' && message.subtype === 'api_retry') {
    return 'retry';
  }
  if (message.type === 'assistant' && message.message.model === '<synthetic>') {
    return 'neutral';
  }
  return 'progress';
};

/**
 * The tool the CLI gives a run whose `outputFormat` is `json_schema`. The name was read from the
 * pinned 2.1.267 binary (`di="StructuredOutput"`), whose `call` answers *"Structured output provided
 * successfully"* only after the input passed the schema, and answers an error otherwise.
 */
const STRUCTURED_OUTPUT_TOOL = 'StructuredOutput';

/**
 * An artifact the CLI acknowledged: the `input` of a top-level `StructuredOutput` `tool_use` whose
 * `tool_result`, matched by `tool_use_id`, was not an error (backlog 466). It is untrusted model
 * output, exactly as `result.structured_output` is, so it is re-validated before anything keeps it.
 */
interface DeliveredArtifact {
  readonly input: unknown;
}

type Block = Readonly<Record<string, unknown>>;

/** The content blocks of a message off the wire, read defensively: the stream is untrusted. */
const contentBlocks = (content: unknown): readonly Block[] =>
  Array.isArray(content)
    ? content.filter(
        (block): block is Block =>
          typeof block === 'object' && block !== null && !Array.isArray(block),
      )
    : [];

/**
 * Follows the `StructuredOutput` calls through the stream. An offer is the assistant's `tool_use`
 * block. A delivery is the CLI's successful `tool_result` for that offer. A subagent's messages
 * (`parent_tool_use_id` set) are not the run's answer and are ignored.
 */
const createDeliveryTracker = () => {
  const offered = new Map<string, unknown>();
  let delivered: DeliveredArtifact | null = null;
  return {
    accept: (message: SDKMessage): void => {
      if (message.type === 'assistant' && message.parent_tool_use_id === null) {
        for (const block of contentBlocks(message.message.content)) {
          if (
            block['type'] === 'tool_use' &&
            block['name'] === STRUCTURED_OUTPUT_TOOL &&
            typeof block['id'] === 'string'
          ) {
            offered.set(block['id'], block['input']);
          }
        }
        return;
      }
      if (message.type === 'user' && message.parent_tool_use_id === null) {
        for (const block of contentBlocks(message.message.content)) {
          const id = block['tool_use_id'];
          if (block['type'] !== 'tool_result' || typeof id !== 'string' || !offered.has(id)) {
            continue;
          }
          const input = offered.get(id);
          offered.delete(id);
          // The Messages API reads an absent `is_error` as success. Only the CLI's explicit error
          // (the schema mismatch) refuses.
          if (block['is_error'] !== true) {
            delivered = { input };
          }
        }
      }
    },
    delivered: (): DeliveredArtifact | null => delivered,
  };
};

const resultStatus = (reason: RunTerminalReason): TerminalRunStatus => {
  if (reason === 'success') {
    return 'completed';
  }
  return reason === 'error_max_budget_usd' ? 'budget_exceeded' : 'failed';
};

const commandPolicyOf = (spec: RunSpec): ResolvedCommandPolicy => ({
  allow: spec.commandPolicy.allow,
  ask: spec.commandPolicy.ask,
  block: spec.commandPolicy.block,
});

export const createClaudeRunner = (deps: ClaudeRunnerDependencies): ClaudeRunner => ({
  start: (rawSpec: RunSpec): RunHandle => startRun(deps, rawSpec),
});

const startRun = (deps: ClaudeRunnerDependencies, rawSpec: RunSpec): RunHandle => {
  const spec = runSpecSchema.parse(rawSpec);
  const logger = deps.logger ?? silentLogger;
  const redactor = composeRedactors(deps.injectedSecretRedactorFor(spec), patternRedactor());
  const abortController = new AbortController();
  const inputs = createAsyncQueue<SDKUserMessage>();
  const coalescer = createStreamBlockCoalescer();
  const deliveries = createDeliveryTracker();
  const stopSignal = deferred<StopCause>();
  const startedAt = deps.clock.now();
  // WP-127 (backlog 344): the CLI's stderr, redacted with this run's redactor, at `warn` for a run
  // that ends before its first stream message and at `debug` otherwise — and nowhere else.
  const stderrLog = createStderrLog({ runId: spec.runId, logger, redactor });
  deps.spawnClaudeCodeProcess?.setStderrSink?.(stderrLog.accept);

  let seq = 0;
  let redactionCount = 0;
  let sessionId: string | null = null;
  let result: SDKResultMessage | null = null;
  let stopCause: StopCause | null = null;
  let steerProvenance: string | null = null;
  let cancelStall: (() => void) | null = null;
  /** `api_retry` entries since the last entry that was progress, and their statuses (WP-127). */
  let retriesSinceProgress = 0;
  const retryStatuses = new Set<number>();
  /** The stall's error when it fired across retries only, else `null` (WP-127). */
  let stallDetail: string | null = null;
  /** The give-up's error when the CLI's `result` came after retries only, else `null` (WP-127). */
  let gaveUpDetail: string | null = null;

  const requestStop = (cause: StopCause): void => {
    if (stopCause !== null) {
      return;
    }
    stopCause = cause;
    stopSignal.resolve(cause);
  };

  const nowIso = (): string => new Date(deps.clock.now()).toISOString();

  // ── the single door to the transcript ─────────────────────────────────────

  /**
   * Set when the loop ends (its `finally`): from then on nothing re-arms the stall (WP-132, PROGRESS
   * backlog 405). The entries written after it — the coalescer's flush, the interrupted turn's
   * result, `run_stopped` — go through `append` like any other, and each used to leave a fresh
   * stall timer behind a run that had already ended. Harmless only by luck (the callback is a
   * `requestStop`, a no-op once a cause is set, and the system clock unrefs its timers), so the
   * guard is here rather than in the reasoning.
   */
  let stallDisarmed = false;

  const armStall = (): void => {
    if (stallDisarmed || stopCause !== null) {
      return;
    }
    cancelStall?.();
    cancelStall = deps.clock.setTimer(spec.limits.stallTimeoutMs, () => {
      if (retriesSinceProgress > 0) {
        stallDetail = retriedWithoutModel('stalled', retriesSinceProgress, [...retryStatuses]);
      }
      requestStop('stalled');
    });
  };

  /**
   * An appended entry re-arms the stall **when it is progress** (WP-127): every entry but an
   * `api_retry` — the CLI failing to reach the model rather than the model working — and the CLI's
   * own synthetic report of that failure, which is neither.
   */
  const progressed = (progress: Progress): void => {
    if (progress === 'retry') {
      retriesSinceProgress += 1;
      return;
    }
    if (progress === 'neutral') {
      return;
    }
    retriesSinceProgress = 0;
    retryStatuses.clear();
    armStall();
  };

  const append = async (
    build: (envelope: TranscriptEnvelope) => TranscriptEvent | null,
    progress: Progress = 'progress',
  ) => {
    const envelope: TranscriptEnvelope = {
      run_id: spec.runId,
      seq,
      created_at: nowIso(),
    };
    const built = build(envelope);
    if (built === null) {
      return;
    }
    const redacted = redactor.redactJson(built as unknown as JsonObject);
    // The envelope is re-applied over the redacted copy rather than trusted to have survived it:
    // a rule that ever matched a uuid or a timestamp would otherwise corrupt the row's identity.
    const candidate = {
      ...redacted.value,
      ...envelope,
      kind: built.kind,
      redaction_count: redacted.count,
    };
    const parsed = transcriptEventSchema.safeParse(candidate);
    seq += 1;
    redactionCount += redacted.count;
    if (!parsed.success) {
      // A transcript entry that fails its own schema is a platform bug, and it must be loud —
      // but it may not kill a run. The row is replaced by one that says what happened, with
      // paths and no values (the rejected entry may hold anything the model saw).
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      logger.error(
        { run_id: spec.runId, seq: envelope.seq, kind: built.kind, issues },
        'transcript entry failed validation',
      );
      await deps.sink.append({
        ...envelope,
        kind: 'system',
        redaction_count: 0,
        subtype: 'transcript_normalisation_failed',
        session_id: sessionId,
        model: null,
        data: { entry_kind: built.kind, issues },
      });
      progressed(progress);
      return;
    }
    await deps.sink.append(parsed.data);
    progressed(progress);
  };

  const recordHook = async (record: HookRecord): Promise<void> => {
    await append((envelope) => ({
      ...envelope,
      kind: 'hook',
      redaction_count: 0,
      parent_tool_use_id: record.parentToolUseId ?? null,
      hook: record.hook,
      tool_name: record.toolName ?? null,
      tool_use_id: record.toolUseId ?? null,
      decision: record.decision ?? null,
      reason: record.reason ?? null,
      question_id: record.questionId ?? null,
    }));
  };

  const recordCompaction = async (phase: 'pre' | 'post', trigger: string): Promise<void> => {
    logger.debug({ run_id: spec.runId, trigger }, `compaction ${phase}`);
    await append((envelope) => ({
      ...envelope,
      kind: 'compaction',
      redaction_count: 0,
      parent_tool_use_id: null,
      phase,
      pre_tokens: null,
      post_tokens: null,
    }));
  };

  // ── the SDK options ───────────────────────────────────────────────────────

  const mcpServers: NonNullable<Options['mcpServers']> = {
    ...(spec.mcpServers as NonNullable<Options['mcpServers']>),
    platform: createPlatformMcpServer(
      {
        tools: deps.tools,
        redactor,
        context: {
          runId: spec.runId,
          taskId: spec.taskId,
          projectId: spec.projectId,
          mode: spec.mode,
          signal: abortController.signal,
          // Backlog 474: what the prompt holds whole, so `get_task_context` does not re-send it.
          ...(spec.promptHolds === undefined ? {} : { promptHolds: spec.promptHolds }),
        },
        onCall: (toolName, outcome) => {
          logger.debug({ run_id: spec.runId, tool: toolName, outcome }, 'platform tool called');
        },
      },
      spec.platformTools,
    ),
  };

  const options = buildQueryOptions(spec, {
    abortController,
    hooks: buildHooks({
      spec,
      policy: commandPolicyOf(spec),
      redactor,
      logger,
      recordHook,
      recordCompaction,
      takeSteerProvenance: () => {
        const provenance = steerProvenance;
        steerProvenance = null;
        return provenance;
      },
    }),
    canUseTool: buildCanUseTool({
      spec,
      approvals: deps.approvals,
      clock: deps.clock,
      signal: abortController.signal,
      recordHook,
    }),
    mcpServers,
    sessionStore:
      deps.sessionMirror === undefined ? undefined : toSdkSessionStore(deps.sessionMirror),
    spawnClaudeCodeProcess: deps.spawnClaudeCodeProcess,
    ...(deps.workspaceEnvironment === undefined
      ? {}
      : { workspaceEnvironment: deps.workspaceEnvironment }),
    // stderr from the CLI is untrusted text on its way to a log: redact it (BD-022, TD-012). The
    // SDK calls this only for a process it spawned itself; a transport's frames reach the same
    // sink through `setStderrSink` above.
    stderr: stderrLog.accept,
  });

  // ── message handling ──────────────────────────────────────────────────────

  const handleStreamEvent = async (message: SDKPartialAssistantMessage): Promise<void> => {
    for (const block of coalescer.accept(message, nowIso())) {
      await append((envelope) => ({
        ...envelope,
        kind: 'stream_block',
        redaction_count: 0,
        parent_tool_use_id: block.parent_tool_use_id,
        block_index: block.block_index,
        block: block.block,
        first_delta_at: block.first_delta_at,
        last_delta_at: block.last_delta_at,
      }));
    }
  };

  const handle = async (message: SDKMessage): Promise<void> => {
    stderrLog.streamOpened();
    if (message.type === 'system' && message.subtype === 'init') {
      sessionId = message.session_id;
    }
    if (message.type === 'stream_event') {
      await handleStreamEvent(message);
      return;
    }
    const progress = progressOf(message);
    if (progress === 'retry') {
      const status = (message as { readonly error_status?: unknown }).error_status;
      if (
        typeof status === 'number' &&
        Number.isInteger(status) &&
        status >= 100 &&
        status <= 599
      ) {
        retryStatuses.add(status);
      }
    }
    if (message.type === 'result' && retriesSinceProgress > 0) {
      gaveUpDetail = retriedWithoutModel('gave_up', retriesSinceProgress, [...retryStatuses]);
    }
    await append((envelope) => normaliseMessage(message, envelope), progress);
    deliveries.accept(message);
    if (message.type === 'result') {
      result = message;
      const cost = reportedCostUsd(message.total_cost_usd);
      if (cost === null) {
        // `NaN > ceiling` is `false`, so the comparison below would have waved this through as a
        // completed run with a `NaN` cost. An unreported cost is the *unverified* case, not the
        // free one.
        requestStop('cost_unreported');
      } else if (cost > spec.limits.maxBudgetUsd) {
        // The CLI was given the same ceiling and did not stop; the platform does.
        requestStop('budget_exceeded');
      }
    }
  };

  // ── the loop ──────────────────────────────────────────────────────────────

  const run = async (): Promise<RunOutcome> => {
    let failure: string | null = null;
    const queryFn = deps.query ?? sdkQuery;
    const cancelWallClock = deps.clock.setTimer(spec.limits.wallClockMs, () =>
      requestStop('timed_out'),
    );
    armStall();

    inputs.push({
      type: 'user',
      message: { role: 'user', content: spec.userPrompt },
      parent_tool_use_id: null,
      session_id: '',
    } as SDKUserMessage);

    // `query()` is called inside the try, not before it. It can throw *synchronously* — a spawn
    // that fails, a bad option — and a throw outside the try escapes `startRun` itself, so
    // `ClaudeRunner.start()` would blow up in the caller's face instead of returning a handle whose
    // outcome is `failed(crash)`. Found by the test below rather than reasoned about.
    let session: ReturnType<QueryFunction> | null = null;
    let iterator: AsyncIterator<SDKMessage, void> | null = null;
    let pending: Promise<IteratorResult<SDKMessage, void>> | null = null;

    try {
      session = queryFn({ prompt: inputs.iterable, options });
      iterator = session[Symbol.asyncIterator]();
      for (;;) {
        pending ??= iterator.next();
        pending.catch(() => undefined);
        const step = await Promise.race([
          pending.then((value) => ({ kind: 'message' as const, value })),
          stopSignal.promise.then((cause) => ({ kind: 'stop' as const, cause })),
        ]);
        if (step.kind === 'stop') {
          break;
        }
        pending = null;
        if (step.value.done === true) {
          break;
        }
        await handle(step.value.value);
        if (result !== null) {
          break;
        }
      }
    } catch (error) {
      failure = redactor.redactText(
        error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error',
      ).value;
      logger.error({ run_id: spec.runId, error: failure }, 'the run failed');
    } finally {
      cancelWallClock();
      stallDisarmed = true;
      cancelStall?.();
      for (const block of coalescer.flush()) {
        await append((envelope) => ({
          ...envelope,
          kind: 'stream_block',
          redaction_count: 0,
          parent_tool_use_id: block.parent_tool_use_id,
          block_index: block.block_index,
          block: block.block,
          first_delta_at: block.first_delta_at,
          last_delta_at: block.last_delta_at,
        }));
      }
      if (stopCause !== null && session !== null) {
        // `interrupt()` gives the CLI its chance to end the turn cleanly; the abort is what
        // guarantees the process goes away when it does not answer. Both are bounded: a hung
        // interrupt must not be able to hold a stalled run open for ever.
        //
        // It has to happen **before** `inputs.close()`. Closing the input iterable is how the SDK
        // is told there are no more turns, and it closes the CLI's stdin — after which the
        // interrupt control request has no transport to travel on and its promise never settles.
        // That ordering cost one debugging round and is the reason this comment exists.
        let cancelGrace: () => void = () => {};
        const grace = new Promise<'grace'>((resolve) => {
          cancelGrace = deps.clock.setTimer(INTERRUPT_GRACE_MS, () => resolve('grace'));
        });
        await Promise.race([session.interrupt().catch(() => undefined), grace]);
        if (READS_INTERRUPTED_RESULT.has(stopCause) && result === null && iterator !== null) {
          await readInterruptedResult(iterator, pending, grace);
        }
        // Both waits are over, so the grace's timer has nothing left to release (WP-132, 405).
        cancelGrace();
        abortController.abort();
        await append((envelope) => ({
          ...envelope,
          kind: 'system',
          redaction_count: 0,
          subtype: 'run_stopped',
          session_id: sessionId,
          model: null,
          data: { reason: stopCause },
        }));
      }
      if (stopCause === null && failure !== null) {
        // A crash leaves the iterator in a state nobody can describe: the SDK threw somewhere inside
        // its own transport, `return()` below is fire-and-forget by necessity (see the note), and
        // `inputs.close()` only promises stdin EOF plus the SDK's ~2 s grace. The abort is the one
        // teardown that does not depend on the thing that just failed still working. It is not on
        // the success path, where the SDK's own close is orderly and an abort would only race it.
        abortController.abort();
      }
      inputs.close();
      // Fire and forget, never awaited. An async generator serialises its requests: a `return()`
      // issued while a `next()` is still pending queues *behind* that `next()`, and on a stalled
      // stream the `next()` never settles — so awaiting it turns "the platform stopped a hung run"
      // into "the platform hung too". Verified against the installed SDK: with the transport
      // stalled, `interrupt()` resolves and `iterator.return()` does not.
      void session?.return?.().catch(() => undefined);
      stderrLog.runEnded();
    }

    return outcomeOf(failure);
  };

  /**
   * **The interrupted turn's own result**, read within the same grace the interrupt had (WP-101,
   * widened to the stall and the wall clock at WP-119 — {@link READS_INTERRUPTED_RESULT}).
   *
   * A stop interrupts a session that has been spending, and the only party that knows what it spent
   * is the CLI: the SDK documents that on a clean interrupt the CLI
   * writes its receipt and then **the interrupted turn's result** (`interrupt_receipt_v1`, *"on a
   * clean interrupt this receipt is written before the interrupted turn result"* — the installed
   * 0.3.267 `sdk.d.ts`, `SDKControlInterruptResponse`). Until WP-101 the loop broke on the stop and
   * never read it, so a stopped run's outcome carried a zero and the ledger no row — which was
   * invisible while a cancel ended only the record (the session then ran on to its own `result`,
   * charged late), and is not once the cancel stops the session (TD-028 decision 11).
   *
   * So the messages after the interrupt are handled like any other — the transcript gets them, and
   * a `result` among them sets {@link result}, whose cost the outcome then carries — until that
   * result, the end of the stream, or the grace. Bounded by the **same** timer as the interrupt, so
   * a stop never waits longer than it did. A budget stop is not in the set: it already has its
   * result. Nothing read inside the grace leaves the outcome **unmeasured**, never a zero.
   */
  const readInterruptedResult = async (
    iterator: AsyncIterator<SDKMessage, void>,
    inFlight: Promise<IteratorResult<SDKMessage, void>> | null,
    grace: Promise<'grace'>,
  ): Promise<void> => {
    let next = inFlight;
    try {
      while (result === null) {
        next ??= iterator.next();
        next.catch(() => undefined);
        const step = await Promise.race([next, grace]);
        if (step === 'grace' || step.done === true) {
          return;
        }
        next = null;
        await handle(step.value);
      }
    } catch (error) {
      logger.debug(
        { run_id: spec.runId, error: error instanceof Error ? error.message : 'unknown' },
        'reading the interrupted turn’s result failed; the stopped run carries no measured cost',
      );
    }
  };

  /**
   * The artifact a budget ending keeps (backlog 466). This is the delivered input, re-validated
   * against the run's artifact type with the same validator `structured_output` goes through.
   * It is `null` when the run has no artifact type, delivered nothing, crashed, or delivered
   * something the schema refuses. That last case is logged with paths only, never values.
   */
  const deliveredArtifactOf = (failure: string | null): JsonValue | null => {
    const delivered = deliveries.delivered();
    if (failure !== null || spec.artifactType === null || delivered === null) {
      return null;
    }
    const validated = validateStructuredOutput(spec.artifactType, delivered.input);
    if (!validated.ok) {
      logger.warn(
        { run_id: spec.runId, issues: validated.issues },
        'the artifact delivered in the turn that crossed the budget cap failed validation; not kept',
      );
      return null;
    }
    return validated.data;
  };

  const outcomeOf = (failure: string | null): RunOutcome => {
    const wallMs = Math.max(0, deps.clock.now() - startedAt);
    const finished = result;
    const usage = finished === null ? ZERO_USAGE : normaliseUsage(finished.usage);
    const modelUsage: readonly ModelUsage[] =
      finished === null ? [] : normaliseModelUsage(finished.modelUsage, usage);
    const cost = {
      // `?? 0` only after the run has already been stopped as `cost_unreported`: the zero is the
      // column's floor, never a claim that the run was free (see the docblock). With no result at
      // all the `0` is a floor too, and the outcome says so with `costUnmeasured` — a stop that
      // read nothing, and a crash with no result (WP-119).
      usd: finished === null ? 0 : (reportedCostUsd(finished.total_cost_usd) ?? 0),
      // BD-004: in `local` mode the platform prices the run from its own table (WP-19) and labels
      // it an estimate; the number the SDK reports is still carried, so there is something to
      // reconcile against.
      is_estimate: spec.providerMode === 'local',
      price_list_id: null,
    };

    const keptOverCap = (): RunOutcome | null => {
      const artifact = deliveredArtifactOf(failure);
      return finished === null || artifact === null
        ? null
        : {
            runId: spec.runId,
            // Backlog 462: the CLI acknowledged a valid artifact in the turn that crossed the cap.
            // `completed` keeps the artifact, and `error_max_budget_usd` records the overrun. The
            // cost is the `result`'s figure, which every other ending also carries.
            status: 'completed',
            terminalReason: 'error_max_budget_usd',
            sessionId,
            numTurns: reportedCount(finished.num_turns),
            usage,
            modelUsage,
            cost,
            wallMs,
            structuredOutput: artifact,
            error: null,
            redactionCount,
          };
    };

    if (stopCause === 'budget_exceeded') {
      const kept = keptOverCap();
      if (kept !== null) {
        return kept;
      }
    }

    if (stopCause !== null) {
      return {
        runId: spec.runId,
        // A stop that read no interrupted result measured nothing (WP-101 review round 1; the stall
        // and the wall clock since WP-119): `cost` below is the floor, and this flag says so.
        ...(finished === null && READS_INTERRUPTED_RESULT.has(stopCause)
          ? { costUnmeasured: true }
          : {}),
        status: STOP_STATUS[stopCause],
        terminalReason: STOP_REASON[stopCause],
        sessionId,
        numTurns: reportedCount(finished?.num_turns),
        usage,
        modelUsage,
        cost,
        wallMs,
        structuredOutput: null,
        error: failure ?? (stopCause === 'stalled' ? stallDetail : null) ?? STOP_MESSAGE[stopCause],
        redactionCount,
      };
    }

    if (finished === null) {
      return {
        runId: spec.runId,
        // A crash with no `result` measured nothing (WP-119 pre-review round, standing rule 16).
        // There is no earlier figure to fall back on: a stage run is one turn and the CLI writes
        // exactly one `result` per turn, so a session that never sent one never reported a cost.
        costUnmeasured: true,
        status: 'failed',
        terminalReason: 'crash',
        sessionId,
        numTurns: 0,
        usage,
        modelUsage,
        cost,
        wallMs,
        structuredOutput: null,
        error: failure ?? 'the session ended without a result message',
        redactionCount,
      };
    }

    const reason = terminalReasonOf(finished);
    if (reason === 'error_max_budget_usd') {
      const kept = keptOverCap();
      if (kept !== null) {
        return kept;
      }
    }
    if (reason !== 'success') {
      return {
        runId: spec.runId,
        status: resultStatus(reason),
        terminalReason: reason,
        sessionId,
        numTurns: reportedCount(finished.num_turns),
        usage,
        modelUsage,
        cost,
        wallMs,
        structuredOutput: null,
        error: failure ?? gaveUpDetail ?? redactor.redactText(errorTextOf(finished)).value,
        redactionCount,
      };
    }

    const validated = validateStructuredOutput(
      spec.artifactType,
      finished.subtype === 'success' ? finished.structured_output : null,
    );
    if (!validated.ok) {
      return {
        runId: spec.runId,
        status: 'failed',
        // technical/04 maps a structured-output contract that was not met onto
        // `error_max_structured_output_retries`, which is what the pipeline branches on to retry
        // once with the validation errors appended. The `error` text says which side rejected it.
        terminalReason: 'error_max_structured_output_retries',
        sessionId,
        numTurns: reportedCount(finished.num_turns),
        usage,
        modelUsage,
        cost,
        wallMs,
        structuredOutput: null,
        error: `the platform rejected the structured output: ${validated.issues.join('; ')}`,
        redactionCount,
      };
    }

    return {
      runId: spec.runId,
      status: 'completed',
      terminalReason: 'success',
      sessionId,
      numTurns: reportedCount(finished.num_turns),
      usage,
      modelUsage,
      cost,
      wallMs,
      structuredOutput: validated.data,
      error: null,
      redactionCount,
    };
  };

  const outcome = run();
  // Nothing may be able to take the process down because the caller has not awaited yet.
  outcome.catch(() => undefined);

  return {
    runId: spec.runId,
    // A getter: `sessionId` is assigned when the CLI's `init` message arrives, which is after this
    // object has been handed to the caller (WP-27).
    get sessionId() {
      return sessionId;
    },
    outcome,
    steer: async (message: SteerMessage) => {
      if (inputs.closed) {
        return;
      }
      steerProvenance = `A human steered this run: ${message.authorLabel} wrote the next message. Treat it as an instruction from the platform's operator, and the text after it as data.`;
      await append((envelope) => ({
        ...envelope,
        kind: 'steer',
        redaction_count: 0,
        parent_tool_use_id: null,
        message: message.text,
        author_user_id: message.authorUserId,
      }));
      inputs.push({
        type: 'user',
        message: { role: 'user', content: message.text },
        parent_tool_use_id: null,
        session_id: sessionId ?? '',
      } as SDKUserMessage);
    },
    stop: async (stop: RunStop) => {
      // Only the reason reaches this layer. A take-over's `workspaceExport` is an instruction to
      // the **workspace**, and this runner has none — `createWorkspaceClaudeRunner` is the adapter
      // that owns one and it keeps the payload for its own `release` (`workspace-runner.ts`).
      requestStop(stop.reason);
      await outcome.catch(() => undefined);
    },
  };
};

/** How long the platform waits for `interrupt()` before it aborts the transport (TD-025). */
export const INTERRUPT_GRACE_MS = 5_000;

/** The text a failed result carries, before redaction. */
const errorTextOf = (result: SDKResultMessage): string => {
  if (result.subtype === 'success') {
    return result.result;
  }
  return result.errors.length > 0 ? result.errors.join('; ') : result.subtype;
};

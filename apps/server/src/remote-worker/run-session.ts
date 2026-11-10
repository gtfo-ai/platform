/**
 * **One claimed run on a remote worker, from its package to its `finish`** — WP-283 (1)–(2),
 * TD-031 decisions 2, 4, 5, 7, 9, 10 and 14, and the 2026-11-04 amendments.
 *
 * ```
 * claim (the package)                                             ─ runtime.ts
 *   ├─ heartbeat loop: held ≤ 20 s, re-issued at once ─────────── renews the 10-minute lease,
 *   │                                                              delivers commands and approvals
 *   ├─ runner.start(spec) — createWorkspaceClaudeRunner over createClaudeRunner, the server's own
 *   │    provision: the package's workspace through this worker's launcher (`workspaces.ts`)
 *   │    beforeCliSpawn: POST spawn (the marker and `run.started`) — no `spawn` frame before it
 *   │    transcript → the HTTP sink (batched, in seq order)    platform tools → POST tools/:name
 *   │    approvals → POST approvals, decided on a heartbeat     ssh.sign → POST ssh-sign
 *   ├─ outcome — the workspace is released **inside** it: every export first (amendment §4)
 *   └─ the transcript drained, the applied commands acked, then POST finish (`settleRun` on the core)
 * ```
 *
 * ## The lease, the fence and self-termination (TD-031 §2)
 *
 * Every run-scoped call carries the claim's epoch and the run token. A `409 lease_lost`, a `401`
 * (the worker or its user revoked) or a `410 run_gone` on **any** call means the run is not this
 * worker's any more: the session is stopped, the workspace destroyed, **nothing is exported** and
 * nothing more is pushed — no `finish` (a measured spend is offered once through `late-cost`, which
 * the core accepts only under the same claim). **Self-termination**: a session that has gone
 * `TTL − ½·renew` (585 s for the remote lease) on the monotonic clock since its last **successful**
 * renewal stops the same way and pushes nothing; the core's sweep acts only after
 * `lease_expires_at + APP_LEASE_SKEW_GRACE`. Every transient failure is retried with jitter until
 * then (`retry.ts`).
 *
 * ## The Claude token (TD-031 §4, BD-032 decision 2; WP-283 (2))
 *
 * The package carries no model credential. The worker adds `CLAUDE_CODE_OAUTH_TOKEN` to the run's
 * spec — so it reaches the **CLI's environment** and nothing else: the launcher's create carries the
 * package's `WorkspaceSpec`, which never names it — and names it in `secretEnvNames`, so the
 * runner's own TD-012 step 1 redacts it by exact value in every transcript entry. Beside that, every
 * body this session sends is passed through an exact-value redactor of the token, the run token and
 * the run credential ({@link guardedRunClient}) — the core never knows the token, so this is the only
 * place it can be caught (TD-031 §10a), and `remote-worker.test.ts` captures every outbound body of
 * a whole run and finds it in none.
 *
 * ## Commands (TD-031 §14)
 *
 * The heartbeat's answer is the delivery: a steer is pushed into the live session, a cancel stops
 * it, a take-over stops it with the branch export (**no tarball** — backlog 688). Each is acked on
 * the next beat (`applied`, or `refused` with one of the four existing reasons — a worker-side
 * failure is `delivery_failed`); a new ack re-issues the beat at once rather than waiting out the
 * hold, so a cancel reads applied on the run page before the run's ending closes its siblings
 * `run_ended`. A command whose id was applied already is acked again and not applied twice.
 */
import { randomUUID } from 'node:crypto';
import type {
  ClaudeRunner,
  Logger,
  NotStartedReport,
  PlatformToolContext,
  PlatformToolPort,
  RunHandle,
  RunnerClock,
  RunOutcome,
  RunSpec,
  RunStoppedReason,
  RunTranscriptSink,
  SecretRedactor,
  ToolApprovalDecision,
  ToolApprovalPort,
} from '@platform/application';
import {
  cliSpawnNotRequested,
  composeSecretRedactors,
  createRunStopReasons,
  exactSecretRedactor,
  isStopEnding,
  notStartedReportOf,
  reportProgressTool,
  runStoppedReasonOf,
  stopEndingOf,
  stoppedBeforeCliSpawn,
  unspawnedStepOf,
  unspawnedStop,
} from '@platform/application';
import type {
  Id,
  JsonObject,
  JsonValue,
  RunPackage,
  TranscriptEvent,
  WorkspaceUnavailableCause,
} from '@platform/contracts';
import {
  classifyWorkspaceFailure,
  firstLineOf,
  WORKER_LOCAL_TRANSCRIPT_TAIL,
  WORKER_REMOTE_LEASE_RENEW_MS,
  WORKER_TRANSCRIPT_BATCH_MAX_BYTES,
} from '@platform/contracts';
import { redaction as redactionAdapters, runner as runnerAdapters } from '@platform/infrastructure';
import * as z from 'zod';
import { CoreCallError, isRunLost, type RunScopedClient } from './core-client.js';
import { retrying, selfTerminationMsOf, sleepMs } from './retry.js';

/** A provisioning failure that is the machine's fault (S-28.12): its cause and first line. */
export interface WorkspaceFault {
  readonly cause: WorkspaceUnavailableCause;
  /** The launcher error's first line, through the session's redactor — untrusted text. */
  readonly detail: string | null;
}

/**
 * **Whether a start that threw is this machine's fault** (S-28.12): the CLI was never asked for, a
 * workspace said something, and it is not a refused spec (a task's problem — a commit that does
 * not exist, a protocol the run image does not speak). It is then the machine's when the launcher
 * could not reach its engine (`engine_unavailable`), the words name a cause the classifier knows,
 * or the Docker engine itself refused — never a helper's own failure (a clone of a repository
 * that refuses it is the project's, and another machine would fail it the same way).
 */
export const workspaceFaultOf = (
  report: NotStartedReport,
  spawnAsked: boolean,
  redact: (text: string) => string,
): WorkspaceFault | null => {
  if (spawnAsked || report.detail === null) return null;
  if (/\binvalid_spec\b/.test(report.failure)) return null;
  const cause = classifyWorkspaceFailure(report.detail);
  const machine =
    /\bengine_unavailable\b/.test(report.failure) ||
    cause !== 'unknown' ||
    /^docker engine/i.test(report.detail.trim());
  if (!machine) return null;
  const line = firstLineOf(report.detail);
  return { cause, detail: line === null ? null : firstLineOf(redact(line)) };
};

/** How long the last acks' beat is given before `finish` goes anyway (see `settle`). */
export const FINAL_ACK_WAIT_MS = 3_000;

/** How a session ended, as `/internal/state` and the logs say it. */
export type RunSessionEnding =
  | 'settled'
  | 'already_settled'
  | 'lease_lost'
  | 'run_gone'
  | 'self_terminated'
  | 'finish_failed'
  /** Handed back unspent before its spawn call, the worker paused by a usage limit (WP-285). */
  | 'released';

/** Why a session stopped pushing — once set, nothing more leaves for this run. */
type Loss = 'lease_lost' | 'run_gone' | 'self_terminated';

/** The placeholder names of the worker's own secrets (TD-012's `[REDACTED:integration:<name>]`). */
export const WORKER_SECRET_NAMES = {
  claudeToken: 'claude_code_oauth_token',
  runToken: 'worker_run_token',
  runCredential: 'worker_run_credential',
} as const;

/** The exact values only this worker knows, as one redactor (TD-031 §10a). */
export const workerSecretRedactor = (input: {
  readonly claudeToken: string;
  readonly runToken: string;
  readonly runCredential: string | null;
}): SecretRedactor =>
  exactSecretRedactor([
    { name: WORKER_SECRET_NAMES.claudeToken, value: input.claudeToken },
    { name: WORKER_SECRET_NAMES.runToken, value: input.runToken },
    ...(input.runCredential === null
      ? []
      : [{ name: WORKER_SECRET_NAMES.runCredential, value: input.runCredential }]),
  ]);

/**
 * A JSON value with every string **and every object key** passed through `redactor`.
 *
 * The shared walk (`SecretRedactor.redactJson`) leaves keys alone by design and gives the job to the
 * **emitting site**, which alone knows what a collision costs (`integrations/redaction.ts`'s
 * docblock). This is that site for everything a worker sends: a model may put its own environment in
 * a key of a tool's input as easily as in a value. Two keys that redact to one name keep both, the
 * later one suffixed `#<n>` — a collision here costs nothing but a name the core never reads.
 */
export const redactKeysAndValues = (redactor: SecretRedactor, input: unknown): unknown => {
  if (typeof input === 'string') return redactor.redactText(input).value;
  if (Array.isArray(input)) return input.map((item) => redactKeysAndValues(redactor, item));
  if (input !== null && typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      let name = redactor.redactText(key).value;
      for (let suffix = 2; Object.hasOwn(out, name); suffix += 1) {
        name = `${redactor.redactText(key).value}#${suffix}`;
      }
      out[name] = redactKeysAndValues(redactor, value);
    }
    return out;
  }
  return input;
};

/**
 * Every body the run-scoped client sends, keys and values, through `redactor` first — exact values
 * only, because a pattern rule may match an SSH signature's base64 or a digest and corrupt it.
 */
export const guardedRunClient = (
  client: RunScopedClient,
  redactor: SecretRedactor,
): RunScopedClient => {
  const guard = (body: unknown): unknown => redactKeysAndValues(redactor, body);
  return {
    heartbeat: (body, signal) => client.heartbeat(guard(body), signal),
    transcript: (body) => client.transcript(guard(body)),
    tool: (name, body) => client.tool(name, guard(body)),
    approval: (body) => client.approval(guard(body)),
    sshSign: (body) => client.sshSign(guard(body)),
    spawn: (body) => client.spawn(guard(body)),
    release: (body) => client.release(guard(body)),
    finish: (body) => client.finish(guard(body)),
    lateCost: (body) => client.lateCost(guard(body)),
    cancel: (body, idempotencyKey) => client.cancel(guard(body), idempotencyKey),
  };
};

/** The run's spec as this worker starts it: the package's, plus the Claude token for the CLI only. */
export const workerRunSpecOf = (pkg: RunPackage, claudeToken: string): RunSpec => ({
  ...(pkg.run as RunSpec),
  env: { ...pkg.run.env, CLAUDE_CODE_OAUTH_TOKEN: claudeToken },
  secretEnvNames: ['CLAUDE_CODE_OAUTH_TOKEN'],
});

/** `finish`'s outcome, snake_case — the inverse of the core's `settleOutcomeOfFinish`. */
export const finishOutcomeOf = (outcome: RunOutcome | NotStartedReport): JsonObject => {
  if ('kind' in outcome && outcome.kind === 'not_started') {
    return {
      kind: 'not_started',
      failure: outcome.failure.slice(0, 2_000),
      detail: outcome.detail,
      detail_truncated: outcome.detailTruncated,
      transient: outcome.transient,
      spawn_requested: outcome.spawnRequested,
    };
  }
  const ran = outcome as RunOutcome;
  return {
    kind: 'ran',
    status: ran.status,
    terminal_reason: ran.terminalReason,
    session_id: ran.sessionId,
    num_turns: ran.numTurns,
    usage: ran.usage as unknown as JsonObject,
    model_usage: ran.modelUsage as unknown as JsonValue,
    // Rule 16: a run nothing measured is `null`, never a zero that reads as a free run.
    cost: ran.costUnmeasured === true ? null : (ran.cost as unknown as JsonObject),
    wall_ms: ran.wallMs,
    structured_output: ran.structuredOutput,
    error: ran.error === null ? null : ran.error.slice(0, 16_384),
    redaction_count: ran.redactionCount,
    ...(ran.savedWork === undefined ? {} : { saved_work: ran.savedWork as unknown as JsonObject }),
    ...(ran.startFailure === undefined
      ? {}
      : { start_failure: ran.startFailure as unknown as JsonObject }),
  };
};

/** A command as the heartbeat delivers it, its payload read strictly. */
const steerPayloadSchema = z.object({
  text: z.string().min(1),
  author_user_id: z.uuid(),
  author_label: z.string(),
});
const takeOverPayloadSchema = z.object({
  branch: z.string().min(1),
  commit_message: z.string().min(1),
  tarball: z.boolean(),
  keep_until: z.string().min(1),
});

/** One run's live state, as `/internal/state` and the local page read it. */
export interface RunSessionState {
  readonly runId: string;
  readonly taskId: string;
  readonly projectId: string;
  readonly stage: string | null;
  readonly role: RunPackage['run']['role'];
  readonly attempt: number;
  /** The package's display block (protocol ≥ 2), or `null` from a core that sent none. */
  readonly display: RunPackage['display'] | null;
  readonly epoch: number;
  readonly startedAt: string;
  phase: 'provisioning' | 'running' | 'finishing' | 'ended';
  ending: RunSessionEnding | null;
  /** Monotonic ms of the last successful renewal. */
  lastRenewal: number;
  /**
   * The newest transcript entries **as uploaded** — after the runner's redaction and this worker's
   * exact-value redactor — oldest first, at most {@link WORKER_LOCAL_TRANSCRIPT_TAIL} (WP-292).
   */
  readonly tail: TranscriptEvent[];
  /**
   * Input + output tokens: **so far** while the run is live — the sum of each model turn's usage as
   * the CLI reported it (backlog 772) — and the `result` entry's own total once it arrives, which
   * then stands; `null` until the CLI reported any.
   */
  tokens: number | null;
  /** Whether {@link tokens} is the `result`'s reported total rather than the turns' sum so far. */
  tokensFinal: boolean;
  /** The cost the run's `result` entry reported, USD; `null` until reported (BD-011). */
  costUsd: number | null;
  /** A cancel was asked from the local page and the core accepted it. */
  cancelRequested: boolean;
}

export interface RunSessionOptions {
  readonly pkg: RunPackage;
  /** The core's run-scoped client for this run's id and token (`core-client.ts`). */
  readonly core: RunScopedClient;
  readonly claudeToken: string;
  /**
   * Told when the CLI reports that Claude refused the token (`authentication_failed`, WP-294 (6)):
   * the worker stops claiming and its page returns to *Sign in to Claude*. The run itself ends as
   * any CLI failure does.
   */
  readonly onClaudeRejected?: () => void;
  /** The package's workspace through this worker's launcher (`workspaces.ts`), given the session. */
  readonly provisionerFor: (session: {
    readonly sshSign: (request: {
      readonly keyBlob: Buffer;
      readonly data: Buffer;
      readonly flags: number;
    }) => Promise<Buffer | null>;
    /** `false` once the run is lost: a lost run exports nothing (TD-031 §2). */
    readonly exportsAllowed: () => boolean;
  }) => runnerAdapters.RunWorkspaceProvisioner;
  readonly clock?: RunnerClock;
  readonly monotonic?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly logger: Logger;
  /** How often the self-termination bound is checked between beats. @default 5 000 */
  readonly selfTerminationCheckMs?: number;
  /**
   * Until when this worker's usage limit holds it (WP-285), or `null` — asked **before the spawn
   * call**: a worker that learned of its pause after this run's claim (a sibling run's rejection)
   * hands the run back unspent, `release` with `usage_limited` (TD-031's 2026-11-04 amendment, the
   * decision 11 note), instead of spending a session it cannot finish. Absent is never paused.
   */
  readonly usagePausedUntil?: () => string | null;
  /** The run's session reported a usage limit (`RunOutcome.usageLimit`): the worker pauses (WP-285). */
  readonly onUsageLimit?: (limit: NonNullable<RunOutcome['usageLimit']>) => Promise<void> | void;
  /**
   * S-28.12: the workspace could not be provisioned and it is the machine's fault
   * ({@link workspaceFaultOf}) — the worker stops claiming. Told whether or not the run could be
   * handed back.
   */
  readonly onWorkspaceFault?: (fault: WorkspaceFault) => void;
  /** S-28.12: a workspace was provisioned (the CLI was asked for): the machine can start runs. */
  readonly onWorkspaceProvisioned?: () => void;
}

export interface RunSession {
  readonly state: RunSessionState;
  /** Resolves when the session has ended, however it ended. Never rejects. */
  readonly done: Promise<RunSessionEnding>;
  /** Hands the run back (the worker is stopping): the session ends `shutdown`, then `finish`. */
  shutdown(): void;
  /**
   * A person's cancel from the local page (WP-292): asked of the **core** — the task page's
   * `run.cancel`, as the worker's user — never applied here. The core records a `run_commands` row
   * this session's heartbeat delivers, which stops the run and is acked like any other cancel.
   * Rejects with the core's refusal (a `403` for a user below `run.cancel`).
   */
  requestCancel(input: {
    readonly reason: string | undefined;
    readonly idempotencyKey: string;
  }): Promise<Awaited<ReturnType<RunScopedClient['cancel']>>>;
}

/**
 * **The worker's `PlatformToolPort`** (TD-031 §10b): every tool but `report_progress` is asked of the
 * core's `POST runs/:id/tools/:name`. A call gets a **fresh `tool_use_id`, kept across its own
 * retries** — the MCP layer never sees the SDK's id — so the core performs a mutating tool once per
 * call however often a transient failure makes the worker ask again (`(run_id, tool_use_id)`). The
 * input is redacted, keys and values, before it leaves. `report_progress` is answered by the runner's
 * own progress door (backlog 752): the line is a transcript row of this run, uploaded like any other.
 */
export const createRemoteToolPort = (options: {
  readonly core: RunScopedClient;
  readonly epoch: number;
  readonly redactor: SecretRedactor;
  /** A run-scoped call, retried until it answers or the session gives up. */
  readonly call: <T>(what: string, run: () => Promise<T>) => Promise<T>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly giveUp: () => boolean;
}): PlatformToolPort => {
  const { core, epoch, call, sleep, giveUp } = options;
  const callTool = async (
    name: string,
    input: unknown,
    context: PlatformToolContext,
  ): Promise<JsonValue> => {
    const toolUseId = randomUUID();
    const body = {
      epoch,
      tool_use_id: toolUseId,
      input: redactKeysAndValues(options.redactor, input ?? {}),
    };
    let answer: Awaited<ReturnType<RunScopedClient['tool']>>;
    for (;;) {
      try {
        answer = await call(`tools/${name}`, () => core.tool(name, body));
        break;
      } catch (error) {
        if (
          error instanceof CoreCallError &&
          error.code === 'tool_call_in_flight' &&
          !giveUp() &&
          !context.signal.aborted
        ) {
          await sleep(1_000);
          continue;
        }
        throw error;
      }
    }
    if (answer.is_error) {
      const text =
        typeof answer.result === 'string' ? answer.result : JSON.stringify(answer.result);
      // The MCP layer prefixes "<name> failed: " itself; the core's words already carry it.
      throw new Error(text.startsWith(`${name} failed: `) ? text.slice(name.length + 9) : text);
    }
    return answer.result;
  };
  const asText = (value: JsonValue): string =>
    typeof value === 'string' ? value : JSON.stringify(value);
  return {
    askHuman: async (input, context) => asText(await callTool('ask_human', input, context)),
    notifyHuman: async (input, context) => {
      await callTool('notify_human', input, context);
    },
    reportProgress: async (input, context) => reportProgressTool(input, context),
    getTaskContext: (input, context) => callTool('get_task_context', input, context),
    getConversation: (input, context) => callTool('get_conversation', input, context),
    kbSearch: (input, context) => callTool('kb_search', input, context),
    addTicketComment: (input, context) => callTool('add_ticket_comment', input, context),
    openMergeRequest: (input, context) => callTool('open_mr', input, context),
    updateMrDescription: (input, context) => callTool('update_mr_description', input, context),
    createFollowupTicket: (input, context) => callTool('create_followup_ticket', input, context),
  };
};

export const startRunSession = (options: RunSessionOptions): RunSession => {
  const { pkg, logger } = options;
  const runId = pkg.runId;
  const epoch = pkg.epoch;
  const monotonic = options.monotonic ?? (() => performance.now());
  const sleep = options.sleep ?? sleepMs;
  const clock = options.clock ?? runnerAdapters.systemClock;
  const selfTerminationMs = selfTerminationMsOf(
    pkg.limits.leaseTtlMs,
    WORKER_REMOTE_LEASE_RENEW_MS,
  );
  const exact = workerSecretRedactor({
    claudeToken: options.claudeToken,
    runToken: pkg.runToken,
    runCredential: pkg.credential?.password ?? null,
  });
  // The pattern rules beside them for what this session writes itself (a tool's input, an
  // approval's words) — TD-012 step 2, as the runner composes it for the transcript.
  const local = composeSecretRedactors(exact, redactionAdapters.patternRedactor());
  const core = guardedRunClient(options.core, exact);

  const state: RunSessionState = {
    runId,
    taskId: pkg.run.taskId,
    projectId: pkg.run.projectId,
    stage: pkg.run.stage ?? null,
    role: pkg.run.role,
    attempt: pkg.run.attempt,
    display: pkg.display ?? null,
    tail: [],
    tokens: null,
    tokensFinal: false,
    costUsd: null,
    cancelRequested: false,
    epoch,
    startedAt: new Date(clock.now()).toISOString(),
    phase: 'provisioning',
    ending: null,
    // The claim's answer is the first renewal the core made for this run.
    lastRenewal: monotonic(),
  };
  let loss: Loss | null = null;
  let handle: RunHandle | null = null;
  let heartbeatStop = false;
  const selfTerminated = (): boolean => monotonic() - state.lastRenewal >= selfTerminationMs;
  const giveUp = (): boolean => loss !== null || selfTerminated();

  const lose = (why: Loss, error?: unknown): void => {
    if (loss !== null) return;
    loss = why;
    logger.warn(
      { run_id: runId, lease_epoch: epoch, loss: why, err: error },
      why === 'self_terminated'
        ? 'this worker has not renewed the run’s lease for TTL − ½·renew: it stops the session and pushes nothing more (TD-031 §2)'
        : 'the run is not this worker’s any more: the session is stopped and its workspace destroyed, nothing exported (TD-031 §2)',
    );
    handle?.stop({ reason: 'cancelled' }).catch(() => undefined);
    wakeBeat();
  };

  /** A run-scoped call, retried until it answers or the session gives up; a loss is recorded. */
  const call = async <T>(what: string, run: () => Promise<T>): Promise<T> => {
    try {
      return await retrying(run, {
        giveUp,
        sleep,
        onRetry: (error, attempt, wait) =>
          logger.warn(
            { run_id: runId, call: what, attempt, wait_ms: wait, err: error },
            'a call to the core failed and is retried',
          ),
      });
    } catch (error) {
      if (isRunLost(error)) {
        lose((error as CoreCallError).kind === 'run_gone' ? 'run_gone' : 'lease_lost', error);
      } else if (selfTerminated()) {
        lose('self_terminated', error);
      }
      throw error;
    }
  };

  // ── the transcript: batched, serial, in seq order ─────────────────────────
  const queued: { readonly seq: number; readonly event: JsonObject }[] = [];
  /** The core answered `transcript_full` (backlog 754): nothing more is queued for it. */
  let transcriptFull = false;
  let flushing: Promise<void> | null = null;
  const flush = (): Promise<void> => {
    flushing ??= (async () => {
      while (queued.length > 0 && loss === null) {
        const batch: (typeof queued)[number][] = [];
        let bytes = 64;
        while (queued.length > 0 && batch.length < 1_000) {
          const next = queued[0] as (typeof queued)[number];
          const size = Buffer.byteLength(JSON.stringify(next), 'utf8') + 1;
          if (batch.length > 0 && bytes + size > WORKER_TRANSCRIPT_BATCH_MAX_BYTES - 1_024) break;
          batch.push(next);
          bytes += size;
          queued.shift();
        }
        try {
          await call('transcript', () => core.transcript({ epoch, entries: batch }));
        } catch (error) {
          if (error instanceof CoreCallError && error.code === 'transcript_full') {
            // Backlog 754: the core stores no more of this run, so the run ends here — stopped as
            // a cancel, settled through `finish` like any other — rather than running on unseen.
            transcriptFull = true;
            queued.length = 0;
            logger.error(
              { run_id: runId, err: error },
              'the core holds no more transcript entries for this run (transcript_full); the run is stopped',
            );
            handle?.stop({ reason: 'cancelled' }).catch(() => undefined);
            break;
          }
          logger.error(
            { run_id: runId, err: error, entries: batch.length },
            'transcript entries could not be uploaded; they are dropped',
          );
        }
      }
      if (loss !== null) queued.length = 0;
    })().finally(() => {
      flushing = null;
    });
    return flushing;
  };
  /**
   * The local page's tail (WP-292): the entry exactly as it is uploaded — the guarded client
   * redacts keys and values by the same exact values on the way out — and the run's reported
   * tokens and cost from its `result` entry, never an estimate (BD-011).
   */
  const keepForPage = (event: TranscriptEvent): void => {
    const uploaded = redactKeysAndValues(exact, event) as TranscriptEvent;
    state.tail.push(uploaded);
    if (state.tail.length > WORKER_LOCAL_TRANSCRIPT_TAIL) {
      state.tail.splice(0, state.tail.length - WORKER_LOCAL_TRANSCRIPT_TAIL);
    }
    if (event.kind === 'result') {
      state.tokens = event.usage.input_tokens + event.usage.output_tokens;
      state.tokensFinal = true;
      // A figure the producer reported, never one somebody priced (`is_estimate`).
      state.costUsd = event.cost.is_estimate ? null : event.cost.usd;
    }
  };
  /** Each model turn's input + output tokens by message id: one turn repeats on every block. */
  const turns = new Map<string, number>();
  const countTurn = (turn: {
    readonly messageId: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
  }): void => {
    if (state.tokensFinal) return;
    turns.set(turn.messageId, turn.inputTokens + turn.outputTokens);
    let sum = 0;
    for (const tokens of turns.values()) sum += tokens;
    state.tokens = sum;
  };
  const uploader: RunTranscriptSink = {
    append: async (event: TranscriptEvent) => {
      if (loss !== null) return;
      keepForPage(event);
      if (transcriptFull) return;
      queued.push({ seq: event.seq, event: event as unknown as JsonObject });
      void flush();
    },
  };
  const drainTranscript = async (): Promise<void> => {
    while (queued.length > 0 || flushing !== null) {
      await (flushing ?? flush());
    }
  };
  const stopReasons = createRunStopReasons();
  const sink = stopReasons.observe(uploader);

  // ── platform tools through the core (TD-031 §10b) ─────────────────────────
  const tools = createRemoteToolPort({ core, epoch, redactor: local, call, sleep, giveUp });

  // ── approvals: opened on the core, decided on a heartbeat ─────────────────
  const waiting = new Map<string, (decision: ToolApprovalDecision) => void>();
  const approvals: ToolApprovalPort = {
    requestApproval: async (request) => {
      const deny = (reason: string): ToolApprovalDecision => ({
        decision: 'deny',
        reason,
        questionId: null,
      });
      let approvalId: string;
      try {
        approvalId = (
          await call('approvals', () =>
            core.approval({
              epoch,
              tool_use_id: randomUUID(),
              tool_name: request.toolName.slice(0, 256),
              detail: local.redactText(request.detail).value.slice(0, 16_384),
              input: redactKeysAndValues(local, request.input) as JsonObject,
              reason: local.redactText(request.reason).value.slice(0, 4_096),
            }),
          )
        ).approval_id;
      } catch (error) {
        logger.warn({ run_id: runId, err: error }, 'an approval could not be opened; it is denied');
        return deny('the platform could not be asked for an approval, so the call was denied');
      }
      return new Promise<ToolApprovalDecision>((resolve) => {
        const timer = setTimeout(() => {
          waiting.delete(approvalId);
          resolve(deny('nobody decided in time, so the call was denied (BD-025)'));
        }, request.timeoutMs);
        (timer as { unref?: () => void }).unref?.();
        const onAbort = (): void => {
          clearTimeout(timer);
          waiting.delete(approvalId);
          resolve(deny('the run ended before the approval was decided'));
        };
        request.signal.addEventListener('abort', onAbort, { once: true });
        waiting.set(approvalId, (decision) => {
          clearTimeout(timer);
          request.signal.removeEventListener('abort', onAbort);
          waiting.delete(approvalId);
          resolve(decision);
        });
      });
    },
  };

  // ── the heartbeat: renewal, commands, approvals ───────────────────────────
  const acks: JsonObject[] = [];
  const applied = new Set<string>();
  let beatAbort: AbortController | null = null;
  let beatWake: (() => void) | null = null;
  function wakeBeat(): void {
    beatAbort?.abort();
    beatWake?.();
  }
  const ack = (commandId: string, outcome: JsonObject): void => {
    acks.push({ command_id: commandId, ...outcome });
    wakeBeat();
  };
  const applyCommand = async (command: {
    readonly id: string;
    readonly kind: 'steer' | 'take_over' | 'cancel';
    readonly payload: JsonObject;
  }): Promise<void> => {
    if (applied.has(command.id)) {
      // Delivered again because our ack was lost: acked again, applied once.
      ack(command.id, { outcome: 'applied' });
      return;
    }
    const live = handle;
    if (live === null) {
      // Not started yet: left unacked, so the next beat delivers it again.
      return;
    }
    applied.add(command.id);
    try {
      if (command.kind === 'steer') {
        const steer = steerPayloadSchema.safeParse(command.payload);
        if (!steer.success) {
          ack(command.id, { outcome: 'refused', refused_reason: 'undecodable' });
          return;
        }
        await live.steer({
          text: steer.data.text,
          authorUserId: steer.data.author_user_id as Id,
          authorLabel: steer.data.author_label,
        });
      } else if (command.kind === 'cancel') {
        void live
          .stop({ reason: 'cancelled' })
          .catch((error: unknown) =>
            logger.error({ run_id: runId, err: error }, 'the cancelled run could not be stopped'),
          );
      } else {
        const takeOver = takeOverPayloadSchema.safeParse(command.payload);
        if (!takeOver.success) {
          ack(command.id, { outcome: 'refused', refused_reason: 'undecodable' });
          return;
        }
        void live
          .stop({
            reason: 'taken_over',
            workspaceExport: {
              branch: takeOver.data.branch,
              commitMessage: takeOver.data.commit_message,
              // TD-031 §14: the branch, never a tarball, from a remote run (backlog 688).
              tarball: false,
              keepUntil: takeOver.data.keep_until,
            },
          })
          .catch((error: unknown) =>
            logger.error({ run_id: runId, err: error }, 'the taken-over run could not be stopped'),
          );
      }
      ack(command.id, { outcome: 'applied' });
    } catch (error) {
      logger.warn({ run_id: runId, command_id: command.id, err: error }, 'a command failed');
      ack(command.id, { outcome: 'refused', refused_reason: 'delivery_failed' });
    }
  };

  const beat = async (signal: AbortSignal): Promise<void> => {
    const sending = acks.splice(0);
    let answer: Awaited<ReturnType<RunScopedClient['heartbeat']>>;
    try {
      answer = await core.heartbeat({ epoch, acks: sending }, signal);
    } catch (error) {
      // Not sent, or its answer lost: the acks go again on the next beat (the core ignores an id
      // that is no longer pending, so a repeat is harmless).
      acks.unshift(...sending);
      throw error;
    }
    state.lastRenewal = monotonic();
    for (const command of answer.commands) {
      await applyCommand(command);
    }
    for (const decision of answer.approvals) {
      waiting.get(decision.approval_id)?.({
        decision: decision.decision,
        reason: decision.reason,
        questionId: (decision.question_id ?? null) as ToolApprovalDecision['questionId'],
      });
    }
  };

  const heartbeatLoop = (async () => {
    let failures = 0;
    while (!heartbeatStop && loss === null) {
      const abort = new AbortController();
      beatAbort = abort;
      try {
        await beat(abort.signal);
        failures = 0;
      } catch (error) {
        if (heartbeatStop || loss !== null) break;
        // Re-issued on purpose (a new ack to carry): not a failure.
        if (abort.signal.aborted) continue;
        if (isRunLost(error)) {
          lose((error as CoreCallError).kind === 'run_gone' ? 'run_gone' : 'lease_lost', error);
          break;
        }
        if (selfTerminated()) {
          lose('self_terminated', error);
          break;
        }
        failures += 1;
        logger.warn(
          { run_id: runId, failures, err: error },
          'a heartbeat failed; it is retried until self-termination',
        );
        await new Promise<void>((resolve) => {
          beatWake = resolve;
          void sleep(Math.min(15_000, 500 * 2 ** Math.min(failures, 5))).then(resolve);
        });
        beatWake = null;
      } finally {
        beatAbort = null;
      }
    }
  })();

  const watchdog = setInterval(() => {
    if (loss === null && state.phase !== 'ended' && selfTerminated()) {
      lose('self_terminated');
    }
  }, options.selfTerminationCheckMs ?? 5_000);
  (watchdog as { unref?: () => void }).unref?.();

  // ── the run ───────────────────────────────────────────────────────────────
  const spawn = { asked: false, written: false, withheld: false };
  /** WP-285: the claim was handed back unspent — nothing else is pushed for this run. */
  let released = false;
  /**
   * The release a paused worker owes a run it has not spawned: `release usage_limited` with the
   * reset, then nothing. A release the core refuses (`run_started`, `lease_lost`) or that does not
   * arrive is logged and the session ends as the core decided; the claim is the core's either way.
   */
  const releaseForUsageLimit = async (until: string): Promise<boolean> => {
    try {
      await call('release', () =>
        core.release({ epoch, reason: 'usage_limited', resets_at: until }),
      );
      released = true;
      logger.warn(
        { run_id: runId, lease_epoch: epoch, paused_until: until },
        'this worker is paused by a usage limit, so the run it had claimed is handed back unspent before its CLI was asked for (TD-031 decision 6)',
      );
      return true;
    } catch (error) {
      logger.error(
        { run_id: runId, err: error },
        'this worker is paused by a usage limit and could not hand the run back; it is not started, and the core ends it',
      );
      return false;
    }
  };
  /**
   * S-28.12: the machine could not provision the workspace — the run is handed back as
   * `provision_failed` with the cause, which keeps this worker off the offer and lets another
   * machine take it; no start attempt is spent and the task is not escalated. A core that refuses
   * the cause (one built before it: strict schema, `400`) is asked again without it. A release the
   * core refuses otherwise leaves the session to finish the run as not started, as before.
   */
  const releaseForWorkspace = async (fault: WorkspaceFault): Promise<boolean> => {
    const send = (withCause: boolean) =>
      call('release', () =>
        core.release({
          epoch,
          reason: 'provision_failed',
          ...(withCause ? { workspace: { cause: fault.cause, detail: fault.detail } } : {}),
        }),
      );
    try {
      try {
        await send(true);
      } catch (error) {
        if (error instanceof CoreCallError && error.status === 400 && loss === null) {
          await send(false);
        } else {
          throw error;
        }
      }
      released = true;
      logger.warn(
        { run_id: runId, lease_epoch: epoch, cause: fault.cause },
        'this machine could not provision the run’s workspace, so the run is handed back for another machine and this worker stops claiming (S-28.12)',
      );
      return true;
    } catch (error) {
      logger.error(
        { run_id: runId, err: error, cause: fault.cause },
        'this machine could not provision the run’s workspace and could not hand the run back; it is finished as not started',
      );
      return false;
    }
  };
  const spawnView = {
    hooks: {
      beforeCliSpawn: async () => false,
      cliSpawnWithheld: () => undefined,
    },
    mayHaveReachedCli: () => spawn.written && !spawn.withheld,
    withheld: () => spawn.written && spawn.withheld,
    asked: () => spawn.asked,
    run: (): never => {
      throw new Error('a remote worker holds no run aggregate');
    },
  };
  const runner: ClaudeRunner = runnerAdapters.createWorkspaceClaudeRunner({
    provisioner: options.provisionerFor({
      sshSign: async (request) => {
        if (loss !== null) return null;
        try {
          const answer = await call('ssh-sign', () =>
            core.sshSign({
              epoch,
              key_blob: request.keyBlob.toString('base64'),
              data: request.data.toString('base64'),
              flags: request.flags,
            }),
          );
          return answer.signature === null ? null : Buffer.from(answer.signature, 'base64');
        } catch (error) {
          logger.warn({ run_id: runId, err: error }, 'the core did not sign for this run');
          return null;
        }
      },
      exportsAllowed: () => loss === null,
    }),
    logger,
    build: ({ spawn: spawnProcess, cliEnvironment }) =>
      runnerAdapters.createClaudeRunner({
        sink,
        approvals,
        tools,
        clock,
        logger,
        injectedSecretRedactorFor: () => exact,
        onTurnUsage: countTurn,
        onAssistantError: (error) => {
          if (error === 'authentication_failed') options.onClaudeRejected?.();
        },
        spawnClaudeCodeProcess: spawnProcess,
        ...(cliEnvironment === undefined ? {} : { workspaceEnvironment: cliEnvironment }),
      }),
  });

  const settle = async (
    outcome: RunOutcome | NotStartedReport,
    stopReason: RunStoppedReason | null,
  ): Promise<RunSessionEnding> => {
    state.phase = 'finishing';
    await drainTranscript();
    if (loss !== null) {
      if (loss !== 'self_terminated' && !('kind' in outcome) && outcome.costUnmeasured !== true) {
        // A run ended under us by another writer: what it measured, once, if the core still takes it.
        await core
          .lateCost({
            epoch,
            session_id: outcome.sessionId,
            num_turns: outcome.numTurns,
            wall_ms: outcome.wallMs,
            cost: outcome.cost as unknown as JsonObject,
            usage: outcome.usage as unknown as JsonObject,
            model_usage: outcome.modelUsage as unknown as JsonValue,
          })
          .catch(() => undefined);
      }
      return loss;
    }
    // The heartbeat stops renewing here: after `finish` the run is terminal and a beat in flight
    // would read `lease_lost` for a run that ended as it should.
    heartbeatStop = true;
    wakeBeat();
    // Acks of applied stops reach the core before the ending closes the rest `run_ended`. The core
    // stamps acks before it holds a beat, so this one is not waited out (it would be held 20 s
    // with nothing pending): a few seconds, then `finish` either way.
    if (acks.length > 0) {
      await core
        .heartbeat({ epoch, acks: acks.splice(0) }, AbortSignal.timeout(FINAL_ACK_WAIT_MS))
        .catch(() => undefined);
    }
    try {
      const answer = await call('finish', () =>
        core.finish({ epoch, stop_reason: stopReason, outcome: finishOutcomeOf(outcome) }),
      );
      return answer.outcome;
    } catch (error) {
      if (loss !== null) return loss;
      logger.error(
        { run_id: runId, err: error },
        'the run’s finish could not be delivered; the lease sweep ends its row',
      );
      return 'finish_failed';
    }
  };

  const done = (async (): Promise<RunSessionEnding> => {
    const spec = workerRunSpecOf(pkg, options.claudeToken);
    let ending: RunSessionEnding = 'finish_failed';
    try {
      let outcome: RunOutcome;
      try {
        handle = runner.start(spec, {
          beforeCliSpawn: async () => {
            if (spawn.asked) return false;
            spawn.asked = true;
            if (loss !== null) return false;
            const pausedUntil = options.usagePausedUntil?.() ?? null;
            if (pausedUntil !== null && Date.parse(pausedUntil) > clock.now()) {
              await releaseForUsageLimit(pausedUntil);
              return false;
            }
            options.onWorkspaceProvisioned?.();
            try {
              await call('spawn', () => core.spawn({ epoch }));
              spawn.written = true;
              state.phase = 'running';
              return true;
            } catch (error) {
              if (error instanceof CoreCallError && error.kind === 'refused') return false;
              if (loss !== null) return false;
              throw error;
            }
          },
          cliSpawnWithheld: () => {
            spawn.withheld = true;
          },
        });
        if (loss !== null) handle.stop({ reason: 'cancelled' }).catch(() => undefined);
        outcome = await handle.outcome;
        if (!spawnView.mayHaveReachedCli() && !isStopEnding(outcome)) {
          throw cliSpawnNotRequested(outcome, spawnView);
        }
      } catch (error) {
        if (loss === 'self_terminated') {
          ending = 'self_terminated';
          return ending;
        }
        if (released) {
          ending = 'released';
          return ending;
        }
        const report = notStartedReportOf(error, { spawnRequested: spawnView.mayHaveReachedCli() });
        const fault = workspaceFaultOf(report, spawn.asked, (text) => local.redactText(text).value);
        if (fault !== null && loss === null) {
          const handedBack = await releaseForWorkspace(fault);
          options.onWorkspaceFault?.(fault);
          if (handedBack) {
            ending = 'released';
            return ending;
          }
        }
        logger.error(
          { run_id: runId, err: error, transient: report.transient },
          'this worker could not start the run; it is finished as not started',
        );
        ending = await settle(report, null);
        return ending;
      }
      const stopReason = runStoppedReasonOf(stopReasons.reasonFor(runId));
      stopReasons.forget(runId);
      // WP-285: the worker pauses before the finish, so the re-planned offer is not claimed back.
      if (outcome.usageLimit !== undefined) {
        await Promise.resolve(options.onUsageLimit?.(outcome.usageLimit)).catch(
          (error: unknown) => {
            logger.warn(
              { run_id: runId, err: error },
              'the worker could not record its usage pause',
            );
          },
        );
      }
      if (loss === 'self_terminated') {
        ending = 'self_terminated';
        return ending;
      }
      if (released) {
        ending = 'released';
        return ending;
      }
      if (!spawnView.mayHaveReachedCli()) {
        outcome = unspawnedStop(
          outcome,
          stoppedBeforeCliSpawn({
            ending: stopEndingOf(outcome),
            step: unspawnedStepOf(spawnView),
            attempt: 1,
            retryable: false,
          }),
        );
      }
      ending = await settle(outcome, stopReason);
      return ending;
    } catch (error) {
      logger.error({ run_id: runId, err: error }, 'a run session ended with an unexpected error');
      ending = loss ?? 'finish_failed';
      return ending;
    } finally {
      heartbeatStop = true;
      wakeBeat();
      clearInterval(watchdog);
      await heartbeatLoop.catch(() => undefined);
      state.phase = 'ended';
      state.ending = ending;
      for (const resolve of waiting.values()) {
        resolve({ decision: 'deny', reason: 'the run ended', questionId: null });
      }
      logger.info({ run_id: runId, lease_epoch: epoch, ending: state.ending }, 'run session ended');
    }
  })();

  return {
    state,
    done,
    shutdown: () => {
      handle?.stop({ reason: 'shutdown' }).catch(() => undefined);
    },
    requestCancel: async ({ reason, idempotencyKey }) => {
      const answer = await core.cancel(
        reason === undefined ? {} : { reason: local.redactText(reason).value },
        idempotencyKey,
      );
      state.cancelRequested = true;
      // The recorded stop wakes this run's held heartbeat on the core; waking ours as well means
      // the beat that collects it is not one already parked for its full hold.
      wakeBeat();
      return answer;
    },
  };
};

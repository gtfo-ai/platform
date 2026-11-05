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
import type { Id, JsonObject, JsonValue, RunPackage, TranscriptEvent } from '@platform/contracts';
import {
  WORKER_REMOTE_LEASE_RENEW_MS,
  WORKER_TRANSCRIPT_BATCH_MAX_BYTES,
} from '@platform/contracts';
import { redaction as redactionAdapters, runner as runnerAdapters } from '@platform/infrastructure';
import * as z from 'zod';
import { CoreCallError, isRunLost, type RunScopedClient } from './core-client.js';
import { retrying, selfTerminationMsOf, sleepMs } from './retry.js';

/** How long the last acks' beat is given before `finish` goes anyway (see `settle`). */
export const FINAL_ACK_WAIT_MS = 3_000;

/** How a session ended, as `/internal/state` and the logs say it. */
export type RunSessionEnding =
  | 'settled'
  | 'already_settled'
  | 'lease_lost'
  | 'run_gone'
  | 'self_terminated'
  | 'finish_failed';

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
 * Every body the run-scoped client sends, through `redactor` first — exact values only, because a
 * pattern rule may match an SSH signature's base64 or a digest and corrupt it.
 */
export const guardedRunClient = (
  client: RunScopedClient,
  redactor: SecretRedactor,
): RunScopedClient => {
  const guard = (body: unknown): unknown =>
    typeof body === 'object' && body !== null && !Array.isArray(body)
      ? redactor.redactJson(body as JsonObject).value
      : body;
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

/** One run's live state, as `/internal/state` reads it. */
export interface RunSessionState {
  readonly runId: string;
  readonly taskId: string;
  readonly stage: string | null;
  readonly epoch: number;
  readonly startedAt: string;
  phase: 'provisioning' | 'running' | 'finishing' | 'ended';
  ending: RunSessionEnding | null;
  /** Monotonic ms of the last successful renewal. */
  lastRenewal: number;
}

export interface RunSessionOptions {
  readonly pkg: RunPackage;
  /** The core's run-scoped client for this run's id and token (`core-client.ts`). */
  readonly core: RunScopedClient;
  readonly claudeToken: string;
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
}

export interface RunSession {
  readonly state: RunSessionState;
  /** Resolves when the session has ended, however it ended. Never rejects. */
  readonly done: Promise<RunSessionEnding>;
  /** Hands the run back (the worker is stopping): the session ends `shutdown`, then `finish`. */
  shutdown(): void;
}

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
    stage: pkg.run.stage ?? null,
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
  const uploader: RunTranscriptSink = {
    append: async (event: TranscriptEvent) => {
      if (loss !== null) return;
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
  const callTool = async (
    name: string,
    input: unknown,
    context: PlatformToolContext,
  ): Promise<JsonValue> => {
    // A fresh id per call, kept across this call's retries: the core performs a mutating tool once
    // per `(run_id, tool_use_id)`, so a retried `open_mr` opens one merge request.
    const toolUseId = randomUUID();
    const body = {
      epoch,
      tool_use_id: toolUseId,
      input: local.redactJson((input ?? {}) as JsonObject).value,
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
  const tools: PlatformToolPort = {
    askHuman: async (input, context) => asText(await callTool('ask_human', input, context)),
    notifyHuman: async (input, context) => {
      await callTool('notify_human', input, context);
    },
    // Backlog 752: the progress door is this runner's, so the line is recorded here and reaches the
    // core as a transcript entry like any other — the core's own tool has no door to answer with.
    reportProgress: async (input, context) => reportProgressTool(input, context),
    getTaskContext: (input, context) => callTool('get_task_context', input, context),
    getConversation: (input, context) => callTool('get_conversation', input, context),
    kbSearch: (input, context) => callTool('kb_search', input, context),
    addTicketComment: (input, context) => callTool('add_ticket_comment', input, context),
    openMergeRequest: (input, context) => callTool('open_mr', input, context),
    updateMrDescription: (input, context) => callTool('update_mr_description', input, context),
    createFollowupTicket: (input, context) => callTool('create_followup_ticket', input, context),
  };

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
              input: local.redactJson(request.input).value,
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
        const report = notStartedReportOf(error, { spawnRequested: spawnView.mayHaveReachedCli() });
        logger.error(
          { run_id: runId, err: error, transient: report.transient },
          'this worker could not start the run; it is finished as not started',
        );
        ending = await settle(report, null);
        return ending;
      }
      const stopReason = runStoppedReasonOf(stopReasons.reasonFor(runId));
      stopReasons.forget(runId);
      if (loss === 'self_terminated') {
        ending = 'self_terminated';
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
  };
};

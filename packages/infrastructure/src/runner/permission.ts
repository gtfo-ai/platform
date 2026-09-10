/**
 * `canUseTool` → a platform Question — technical/04:
 *
 * > `canUseTool` answers only for the ask-list: creates a Question with the exact command, waits
 * > (bounded by the run's wall clock and the question timeout), returns allow/deny; **unattended
 * > default deny**.
 *
 * The SDK calls this only when something upstream said `ask`: the `PreToolUse` command policy hook,
 * a permission rule, or the CLI's own safety checks. An `allow` from the hook never reaches here,
 * which is why this module contains no policy of its own — it is the human-in-the-loop half.
 *
 * **Three ways to end, and two of them deny.** The port answers; or the deadline passes; or the run
 * ends underneath the question. The last two are denials, and the denial is produced *here* rather
 * than being left to the port, because "the thing that was supposed to say no never answered" must
 * not be able to look like an approval. A port that hangs for ever cannot hang the run: the timeout
 * is armed on the injected {@link RunnerClock}, so it is a decision the platform makes rather than
 * a hope about the port's own timeouts.
 */
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type {
  RunnerClock,
  RunSpec,
  ToolApprovalDecision,
  ToolApprovalPort,
} from '@platform/application';
import type { JsonObject } from '@platform/contracts';
import type { HookRecord } from './hooks.js';

export interface PermissionRuntime {
  readonly spec: RunSpec;
  readonly approvals: ToolApprovalPort;
  readonly clock: RunnerClock;
  /** Aborted when the run ends for any reason; a pending question resolves `deny`. */
  readonly signal: AbortSignal;
  recordHook(record: HookRecord): Promise<void>;
}

/** What a human is shown. `Bash` gets the exact command; everything else a compact rendering. */
export const approvalDetail = (toolName: string, input: Record<string, unknown>): string => {
  const command = input['command'];
  if (toolName === 'Bash' && typeof command === 'string') {
    return command;
  }
  try {
    return JSON.stringify(input);
  } catch {
    return '[tool input could not be rendered]';
  }
};

const DENIED_BY_TIMEOUT = (timeoutMs: number): ToolApprovalDecision => ({
  decision: 'deny',
  reason:
    `no human answered within ${timeoutMs} ms, so the platform denied the tool call. ` +
    'Unattended runs default to deny (BD-025). Continue without it, or use ask_human to ' +
    'explain what you need and why.',
  questionId: null,
});

const DENIED_BY_RUN_END: ToolApprovalDecision = {
  decision: 'deny',
  reason: 'the run ended while this tool call was waiting for approval.',
  questionId: null,
};

/**
 * Awaits the port, the deadline and the run's end, and takes whichever lands first.
 *
 * `Promise.race` leaves the losers pending; the port's promise gets a `catch` attached so a later
 * rejection cannot surface as an unhandled rejection and take the process down after the run has
 * already moved on.
 */
const raceForDecision = async (
  runtime: PermissionRuntime,
  request: Promise<ToolApprovalDecision>,
  timeoutMs: number,
): Promise<ToolApprovalDecision> => {
  request.catch(() => undefined);
  let cancelTimer: (() => void) | undefined;
  let removeAbort: (() => void) | undefined;
  try {
    return await Promise.race<ToolApprovalDecision>([
      request,
      new Promise<ToolApprovalDecision>((resolve) => {
        cancelTimer = runtime.clock.setTimer(timeoutMs, () =>
          resolve(DENIED_BY_TIMEOUT(timeoutMs)),
        );
      }),
      new Promise<ToolApprovalDecision>((resolve) => {
        if (runtime.signal.aborted) {
          resolve(DENIED_BY_RUN_END);
          return;
        }
        const onAbort = (): void => resolve(DENIED_BY_RUN_END);
        runtime.signal.addEventListener('abort', onAbort, { once: true });
        removeAbort = () => runtime.signal.removeEventListener('abort', onAbort);
      }),
    ]);
  } finally {
    cancelTimer?.();
    removeAbort?.();
  }
};

export const buildCanUseTool = (runtime: PermissionRuntime): CanUseTool => {
  return async (toolName, input, options): Promise<PermissionResult> => {
    const timeoutMs = runtime.spec.limits.questionTimeoutMs;
    const detail = approvalDetail(toolName, input);
    const reason =
      options.decisionReason ?? 'the tool policy escalated this call to a human (BD-025 ask-list).';

    let decision: ToolApprovalDecision;
    try {
      decision = await raceForDecision(
        runtime,
        runtime.approvals.requestApproval({
          runId: runtime.spec.runId,
          taskId: runtime.spec.taskId,
          toolName,
          detail,
          input: input as JsonObject,
          reason,
          timeoutMs,
          signal: runtime.signal,
        }),
        timeoutMs,
      );
    } catch (error) {
      // A port that throws has not approved anything. The message is the platform's own, not the
      // error's: an exception from an integration can carry a response body (WP-07), and this
      // string goes to the model.
      decision = {
        decision: 'deny',
        reason: 'the approval channel failed, so the platform denied the tool call.',
        questionId: null,
      };
      runtime
        .recordHook({
          hook: 'PreToolUse',
          toolName,
          toolUseId: options.toolUseID,
          decision: 'deny',
          reason: `approval channel error: ${error instanceof Error ? error.name : 'unknown'}`,
        })
        .catch(() => undefined);
    }

    await runtime.recordHook({
      hook: 'PreToolUse',
      toolName,
      toolUseId: options.toolUseID,
      decision: decision.decision,
      reason: `canUseTool: ${decision.reason}`,
      questionId: decision.questionId,
    });

    return decision.decision === 'allow'
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: decision.reason };
  };
};

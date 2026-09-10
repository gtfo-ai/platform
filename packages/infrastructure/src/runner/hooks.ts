/**
 * The hook table of technical/04 § "Hooks and policies", registered on the SDK's `hooks` option.
 *
 * | Hook | What it does here |
 * |---|---|
 * | `PreToolUse(Bash)` | asks `@platform/domain`'s three-list command policy and returns its verdict |
 * | `PreToolUse(Edit\|Write\|…)` | path guard: workspace only, protected paths, flagged config, secret-shaped content |
 * | `PostToolUse(*)` | head/tail truncation then redaction of the tool output the model is about to read |
 * | `SubagentStart/Stop` | nests the subagent in the transcript |
 * | `PreCompact` | writes the `compaction` marker; `PostCompact` writes a `hook` entry (see below) |
 * | `Stop` | records, and never returns `continue: true` |
 * | `UserPromptSubmit` | injects who steered (technical/04 § "Streaming and steering") |
 * | `PostModelSwitch` | records the SDK's own model fallback for the cost ledger |
 *
 * **The command policy is not implemented here.** `evaluateCommand` in `@platform/domain` is; it
 * cost WP-02 and WP-02a three review rounds and fifteen closed routes to `allow`, and this hook's
 * whole job is to call it and translate the verdict. A shell matcher in this file would be a second,
 * unattacked policy sitting in front of the attacked one.
 *
 * **Compaction, and where `pre_tokens` really comes from.** technical/04 gives both `PreCompact` and
 * `PostCompact` the job of emitting compaction markers "and record `pre_tokens`". The installed SDK
 * declarations say otherwise: `PreCompactHookInput` carries only `trigger` and
 * `custom_instructions`, and `PostCompactHookInput` only `trigger` and `compact_summary` — neither
 * has a token count. The counts arrive on the `system`/`compact_boundary` **message**
 * (`compact_metadata.pre_tokens` / `post_tokens`). So the split is: `PreCompact` writes
 * `compaction{phase:'pre'}`, the boundary message writes `compaction{phase:'post'}` with the
 * numbers, and `PostCompact` writes a `hook` entry — one marker per phase, no duplicate row, and
 * the token counts come from the only place that has them. technical/04 is amended to say so.
 *
 * **Fail closed.** Every branch that cannot read what it needs to judge returns the *restrictive*
 * answer: a `Bash` call whose `command` is not a string is `ask`, a write with no readable path is
 * `deny`. A hook that cannot see the thing it guards has not found it safe.
 */
import type {
  HookCallbackMatcher,
  HookEvent,
  HookJSONOutput,
  PostToolUseHookInput,
  PreCompactHookInput,
  PreToolUseHookInput,
  SubagentStartHookInput,
  SubagentStopHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import type { Logger, RunSpec, SecretRedactor } from '@platform/application';
import type { HookName, ToolDecision } from '@platform/contracts';
import type { CommandVerdict, ResolvedCommandPolicy } from '@platform/domain';
import { evaluateCommand } from '@platform/domain';
import { guardWriteContent, guardWritePath, writeContentsOf, writeTargetOf } from './path-guard.js';
import { renderToolResponse, truncateHeadTail } from './truncation.js';

/** What the runner records when a hook fires. */
export interface HookRecord {
  readonly hook: HookName;
  readonly toolName?: string | null;
  readonly toolUseId?: string | null;
  readonly decision?: ToolDecision | null;
  readonly reason?: string | null;
  readonly parentToolUseId?: string | null;
  /** Set when an `ask` verdict opened a platform Question (technical/04 `canUseTool`). */
  readonly questionId?: string | null;
}

export interface HookRuntime {
  readonly spec: RunSpec;
  readonly policy: ResolvedCommandPolicy;
  readonly redactor: SecretRedactor;
  readonly logger: Logger;
  recordHook(record: HookRecord): Promise<void>;
  recordCompaction(phase: 'pre' | 'post', trigger: string): Promise<void>;
  /**
   * Provenance for the next prompt, set by `RunHandle.steer` and consumed once. Returning it once
   * is the point: the line belongs to the steer that produced it, and re-injecting it on every
   * later prompt would attribute later turns to a human who did not write them.
   */
  takeSteerProvenance(): string | null;
}

/** The SDK's `PreToolUse` decision vocabulary; `block` is spelled `deny`. */
const toPermissionDecision = (verdict: CommandVerdict): 'allow' | 'deny' | 'ask' =>
  verdict === 'block' ? 'deny' : verdict;

const preToolUseOutput = (decision: 'allow' | 'deny' | 'ask', reason: string): HookJSONOutput => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: decision,
    permissionDecisionReason: reason,
  },
});

/** Tool names whose input names a file the agent is about to write. */
export const WRITE_TOOL_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit';

const commandOf = (input: unknown): string | null => {
  if (typeof input !== 'object' || input === null) {
    return null;
  }
  const command = (input as Record<string, unknown>)['command'];
  return typeof command === 'string' ? command : null;
};

const bashHook =
  (runtime: HookRuntime) =>
  async (input: unknown, toolUseId: string | undefined): Promise<HookJSONOutput> => {
    const hookInput = input as PreToolUseHookInput;
    const command = commandOf(hookInput.tool_input);
    if (command === null) {
      const reason =
        'the platform could not read a command out of this tool call, so it cannot be judged ' +
        'against the command policy (BD-025) and is escalated to a human.';
      await runtime.recordHook({
        hook: 'PreToolUse',
        toolName: hookInput.tool_name,
        toolUseId: toolUseId ?? null,
        decision: 'ask',
        reason,
      });
      return preToolUseOutput('ask', reason);
    }

    const evaluation = evaluateCommand({ command }, runtime.policy);
    const decision = toPermissionDecision(evaluation.verdict);
    const matched =
      evaluation.matched === null ? 'no list matches it' : `matched "${evaluation.matched}"`;
    const uncertainty =
      evaluation.uncertainty.length === 0
        ? ''
        : `; the command scanner could not follow: ${evaluation.uncertainty.join(', ')}`;
    const reason = `command policy: ${evaluation.verdict} (${matched})${uncertainty}`;

    await runtime.recordHook({
      hook: 'PreToolUse',
      toolName: hookInput.tool_name,
      toolUseId: toolUseId ?? null,
      decision,
      reason,
    });
    return preToolUseOutput(decision, reason);
  };

const writeHook =
  (runtime: HookRuntime) =>
  async (input: unknown, toolUseId: string | undefined): Promise<HookJSONOutput> => {
    const hookInput = input as PreToolUseHookInput;
    const record = async (decision: ToolDecision, reason: string): Promise<void> => {
      await runtime.recordHook({
        hook: 'PreToolUse',
        toolName: hookInput.tool_name,
        toolUseId: toolUseId ?? null,
        decision,
        reason,
      });
    };

    const target = writeTargetOf(hookInput.tool_input);
    if (target === null) {
      const reason =
        `the platform could not read a target path out of a ${hookInput.tool_name} call, so the ` +
        'path guard cannot judge it.';
      await record('deny', reason);
      return preToolUseOutput('deny', reason);
    }

    const pathVerdict = guardWritePath(target, {
      workspacePath: runtime.spec.workspacePath,
      protectedPaths: runtime.spec.protectedPaths,
      plannedProtectedPaths: runtime.spec.plannedProtectedPaths,
    });
    if (pathVerdict.decision === 'deny') {
      await record('deny', pathVerdict.reason);
      return preToolUseOutput('deny', pathVerdict.reason);
    }

    for (const content of writeContentsOf(hookInput.tool_input)) {
      const contentVerdict = guardWriteContent(content);
      if (contentVerdict.decision === 'deny') {
        await record('deny', contentVerdict.reason);
        return preToolUseOutput('deny', contentVerdict.reason);
      }
    }

    if (pathVerdict.decision === 'flag') {
      await record('allow', pathVerdict.reason);
      return preToolUseOutput('allow', pathVerdict.reason);
    }
    return preToolUseOutput('allow', '');
  };

/**
 * Truncate, then redact, then hand the result back to the model.
 *
 * A transcript entry is written only when the hook actually changed something. A `hook` row per
 * tool call would roughly double a transcript whose rows are already the platform's largest table
 * (technical/03), and "the hook ran and did nothing" is not audit material — "the hook truncated
 * 400 kB of test output" and "the hook removed a credential from what the model was about to read"
 * both are.
 */
const postToolUseHook =
  (runtime: HookRuntime) =>
  async (input: unknown, toolUseId: string | undefined): Promise<HookJSONOutput> => {
    const hookInput = input as PostToolUseHookInput;
    const rendered = renderToolResponse(hookInput.tool_response);
    const truncated = truncateHeadTail(rendered, runtime.spec.limits.toolOutputMaxChars);
    const redacted = runtime.redactor.redactText(truncated.text);
    if (!truncated.truncated && redacted.count === 0) {
      return {};
    }
    const parts: string[] = [];
    if (truncated.truncated) {
      parts.push(
        `truncated ${truncated.originalLength} characters to ${runtime.spec.limits.toolOutputMaxChars}`,
      );
    }
    if (redacted.count > 0) {
      parts.push(`redacted ${redacted.count} secret-shaped value(s) (TD-012)`);
    }
    await runtime.recordHook({
      hook: 'PostToolUse',
      toolName: hookInput.tool_name,
      toolUseId: toolUseId ?? null,
      decision: null,
      reason: parts.join('; '),
    });
    return {
      hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: redacted.value },
    };
  };

const subagentHook =
  (runtime: HookRuntime, hook: 'SubagentStart' | 'SubagentStop') =>
  async (input: unknown): Promise<HookJSONOutput> => {
    const hookInput = input as SubagentStartHookInput | SubagentStopHookInput;
    await runtime.recordHook({
      hook,
      reason: `subagent ${hookInput.agent_type}`,
      parentToolUseId: hookInput.agent_id,
    });
    return {};
  };

export const buildHooks = (
  runtime: HookRuntime,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> => ({
  PreToolUse: [
    { matcher: 'Bash', hooks: [bashHook(runtime)] },
    { matcher: WRITE_TOOL_MATCHER, hooks: [writeHook(runtime)] },
  ],
  PostToolUse: [{ hooks: [postToolUseHook(runtime)] }],
  SubagentStart: [{ hooks: [subagentHook(runtime, 'SubagentStart')] }],
  SubagentStop: [{ hooks: [subagentHook(runtime, 'SubagentStop')] }],
  PreCompact: [
    {
      hooks: [
        async (input): Promise<HookJSONOutput> => {
          await runtime.recordCompaction('pre', (input as PreCompactHookInput).trigger);
          return {};
        },
      ],
    },
  ],
  PostCompact: [
    {
      hooks: [
        async (input): Promise<HookJSONOutput> => {
          const trigger = (input as { trigger?: unknown }).trigger;
          await runtime.recordHook({
            hook: 'PostCompact',
            reason: `compaction finished (${typeof trigger === 'string' ? trigger : 'unknown'})`,
          });
          return {};
        },
      ],
    },
  ],
  Stop: [
    {
      hooks: [
        async (): Promise<HookJSONOutput> => {
          await runtime.recordHook({ hook: 'Stop', reason: 'the session reached a stop point' });
          // Never `{ continue: true }`: technical/04 puts bounded loops in the pipeline, not in
          // the session, and a Stop hook that resumes the agent is an unbounded loop with no
          // counter and no budget attached to it.
          return {};
        },
      ],
    },
  ],
  UserPromptSubmit: [
    {
      hooks: [
        async (): Promise<HookJSONOutput> => {
          const provenance = runtime.takeSteerProvenance();
          if (provenance === null) {
            return {};
          }
          await runtime.recordHook({ hook: 'UserPromptSubmit', reason: provenance });
          return {
            hookSpecificOutput: {
              hookEventName: 'UserPromptSubmit',
              additionalContext: provenance,
            },
          };
        },
      ],
    },
  ],
  PostModelSwitch: [
    {
      hooks: [
        async (input): Promise<HookJSONOutput> => {
          const switched = input as { from_model?: unknown; to_model?: unknown };
          await runtime.recordHook({
            hook: 'PostModelSwitch',
            reason: `model switched from ${String(switched.from_model)} to ${String(switched.to_model)}`,
          });
          return {};
        },
      ],
    },
  ],
});

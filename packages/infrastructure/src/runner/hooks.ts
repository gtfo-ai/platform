/**
 * The hook table of technical/04 § "Hooks and policies", registered on the SDK's `hooks` option.
 *
 * | Hook | What it does here |
 * |---|---|
 * | `PreToolUse(Bash)` | `decideUnattendedCommand` in `@platform/domain`: the three lists, then the unattended mode (`auto`/`deny`) and the git boundary — `allow` or `deny`, never `ask` |
 * | `PreToolUse(Edit\|Write\|…)` | path guard: workspace only, protected paths, flagged config, secret-shaped content |
 * | `PostToolUse(*)` | head/tail truncation of `Bash` and MCP output, redaction of every tool's, in the tool's own output shape |
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
 * answer: a `Bash` call whose `command` is not a string is `deny`, a write with no readable path is
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
import type { HookName, JsonObject, ToolDecision } from '@platform/contracts';
import type { ResolvedCommandPolicy } from '@platform/domain';
import { decideUnattendedCommand } from '@platform/domain';
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

/**
 * **An unattended run's command decision** (BD-025's 2026-10-06 amendment). The hook answers
 * `allow` or `deny` and never `ask`: an `ask` reached `canUseTool`, which has nobody to ask in an
 * unattended run and denied every one with a reason the model misread as *"no network"* (the first
 * local test's discovery run wrote that into its knowledge pages). `decideUnattendedCommand` in
 * `@platform/domain` decides — under the run's `commandPolicy.unattended`, `auto` runs an `ask` in
 * the sandbox and `deny` refuses it — and every decision, an `ask` run under `auto` included, leaves
 * a `hook` row whose reason says which rule decided, so the audit shows exactly what ran under it.
 *
 * A `PreToolUse` `allow` is final for the CLI: it does not reach `canUseTool` (measured against CLI
 * 2.1.267 through the SDK with a stub Messages API, 2026-10-06 — `echo hi > out.txt`, `cd / && ls`
 * and `rm -rf /tmp/…` answered `allow` ran with no `canUseTool` call, while an `ask` reached it),
 * and a `deny`'s reason is the text the model reads, verbatim.
 */
const bashHook =
  (runtime: HookRuntime) =>
  async (input: unknown, toolUseId: string | undefined): Promise<HookJSONOutput> => {
    const hookInput = input as PreToolUseHookInput;
    const command = commandOf(hookInput.tool_input);
    if (command === null) {
      const reason =
        'command policy: refused (unattended run) — the platform could not read a command out of this tool ' +
        'call, so it cannot be judged against the command policy (BD-025) and is refused. Send ' +
        'the command as the `command` string of the Bash tool.';
      await runtime.recordHook({
        hook: 'PreToolUse',
        toolName: hookInput.tool_name,
        toolUseId: toolUseId ?? null,
        decision: 'deny',
        reason,
      });
      return preToolUseOutput('deny', reason);
    }

    const decision = decideUnattendedCommand(
      { command },
      runtime.policy,
      runtime.spec.commandPolicy.unattended,
    );
    await runtime.recordHook({
      hook: 'PreToolUse',
      toolName: hookInput.tool_name,
      toolUseId: toolUseId ?? null,
      decision: decision.decision,
      reason: decision.reason,
    });
    return preToolUseOutput(decision.decision, decision.reason);
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
      existingProtectedPaths: runtime.spec.existingProtectedPaths,
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

/** The tool-name prefix the CLI gives the in-process `platform` MCP server's tools. */
export const PLATFORM_TOOL_PREFIX = 'mcp__platform__';

/**
 * The ceiling on a **platform** tool's answer the model reads — above every cap the tools apply
 * themselves (`get_task_context`'s is 160 000 characters, `TASK_CONTEXT_MAX_CHARS` in
 * `apps/server`), so this cut is a backstop rather than a second, blind one.
 *
 * `toolOutputMaxChars` (10 000) exists for what a *command* prints — test logs, a `cat` of a large
 * file — whose size nobody chose. A platform tool's answer is platform text the platform already
 * bounded, and cutting it head-and-tail removed the middle of the architect's own task context —
 * the refined spec (22 082 characters cut to 10 000, first local test, 2026-10-05). Redaction
 * applies to it exactly as before.
 */
export const PLATFORM_TOOL_OUTPUT_MAX_CHARS = 200_000;

/** Every tool of the platform's own MCP server, as the CLI names it. */
export const PLATFORM_TOOL_MATCHER = `${PLATFORM_TOOL_PREFIX}.*`;

/**
 * **The platform's own tools are approved by the platform** (first local test, 2026-10-05).
 *
 * The run passes nothing as pre-approved (divergence 3 in `options.ts`), and the CLI treats an MCP
 * tool as one it must ask about. With no hook answering for them, every `mcp__platform__*` call
 * went to `canUseTool`, which has no human to ask in an unattended run and denies — so
 * `get_task_context`, `kb_search`, `report_progress` and `open_mr` were refused in every run
 * (AUT-6820's refinement: three denials in its first minute, then a refinement written without
 * them). These tools are not commands the policy reads: the role's grant is
 * `PLATFORM_TOOLS_BY_ROLE`, the server registers exactly `spec.platformTools`, and each tool's
 * effect goes through `IntegrationActionExecutor`. So this hook allows a name the spec grants and
 * denies, with a reason, anything else under the prefix.
 */
const platformToolHook =
  (runtime: HookRuntime) =>
  async (input: unknown, toolUseId: string | undefined): Promise<HookJSONOutput> => {
    const hookInput = input as PreToolUseHookInput;
    const name = hookInput.tool_name.startsWith(PLATFORM_TOOL_PREFIX)
      ? hookInput.tool_name.slice(PLATFORM_TOOL_PREFIX.length)
      : null;
    if (name !== null && (runtime.spec.platformTools as readonly string[]).includes(name)) {
      return preToolUseOutput('allow', `platform tool granted to this run: ${name}`);
    }
    const reason = `${hookInput.tool_name} is not a platform tool this run was granted`;
    await runtime.recordHook({
      hook: 'PreToolUse',
      toolName: hookInput.tool_name,
      toolUseId: toolUseId ?? null,
      decision: 'deny',
      reason,
    });
    return preToolUseOutput('deny', reason);
  };

/** The prefix the CLI gives every MCP tool, the platform's own and a provider's alike. */
export const MCP_TOOL_PREFIX = 'mcp__';

/** What the hook did to one tool output: the replacement, and what the transcript says about it. */
interface RewrittenOutput {
  readonly output: unknown;
  readonly truncated: { readonly from: number; readonly to: number } | null;
  readonly redactions: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Redacts every string in a tool's own output object and keeps its shape: keys and every
 * non-string value untouched, so the replacement still parses as the tool's output.
 */
const redactShaped = (
  runtime: HookRuntime,
  response: Record<string, unknown>,
): { readonly value: Record<string, unknown>; readonly count: number } => {
  const redacted = runtime.redactor.redactJson(response as JsonObject);
  return { value: redacted.value as Record<string, unknown>, count: redacted.count };
};

/**
 * An MCP tool's output (the platform's `mcp__platform__*` or a provider's): rendered to text,
 * capped and redacted, and returned as a **string**, which the CLI accepts for an MCP tool (measured,
 * below). A platform tool's cap is {@link PLATFORM_TOOL_OUTPUT_MAX_CHARS} (backlog 464).
 */
const rewriteMcpOutput = (
  runtime: HookRuntime,
  name: string,
  response: unknown,
): RewrittenOutput => {
  const cap = name.startsWith(PLATFORM_TOOL_PREFIX)
    ? Math.max(runtime.spec.limits.toolOutputMaxChars, PLATFORM_TOOL_OUTPUT_MAX_CHARS)
    : runtime.spec.limits.toolOutputMaxChars;
  const truncated = truncateHeadTail(renderToolResponse(response), cap);
  const redacted = runtime.redactor.redactText(truncated.text);
  return {
    output: redacted.value,
    truncated: truncated.truncated ? { from: truncated.originalLength, to: cap } : null,
    redactions: redacted.count,
  };
};

/**
 * `Bash`'s output — `{stdout, stderr, interrupted, …}` in CLI 2.1.267 — with `stdout` and `stderr`
 * cut head-and-tail so that together they fit the cap (stderr gets at most half when both are
 * long, and whatever stdout leaves when it is short), then every string redacted, the object's
 * shape kept. A string `tool_response` (an older CLI, or a fake) is capped and redacted as text.
 */
const rewriteBashOutput = (runtime: HookRuntime, response: unknown): RewrittenOutput => {
  const cap = runtime.spec.limits.toolOutputMaxChars;
  if (
    !isRecord(response) ||
    typeof response['stdout'] !== 'string' ||
    typeof response['stderr'] !== 'string'
  ) {
    const truncated = truncateHeadTail(renderToolResponse(response), cap);
    const redacted = runtime.redactor.redactText(truncated.text);
    return {
      output: redacted.value,
      truncated: truncated.truncated ? { from: truncated.originalLength, to: cap } : null,
      redactions: redacted.count,
    };
  }
  const stdout = response['stdout'];
  const stderr = response['stderr'];
  const stderrCap = Math.min(stderr.length, Math.max(Math.floor(cap / 2), cap - stdout.length));
  const cutOut = truncateHeadTail(stdout, cap - stderrCap);
  const cutErr = truncateHeadTail(stderr, Math.max(stderrCap, 0));
  const cut = cutOut.truncated || cutErr.truncated;
  const redacted = redactShaped(runtime, { ...response, stdout: cutOut.text, stderr: cutErr.text });
  return {
    output: redacted.value,
    truncated: cut ? { from: stdout.length + stderr.length, to: cap } : null,
    redactions: redacted.count,
  };
};

/**
 * Every other tool — `Read`, `Edit`, `Write`, `Glob`, `Grep`, `NotebookEdit`, … — is **redacted and
 * never capped**: its output is a file the model chose to read (with `offset`/`limit` for a range),
 * a listing, or an edit's own record, and the CLI bounds those itself.
 */
const rewriteBuiltInOutput = (runtime: HookRuntime, response: unknown): RewrittenOutput => {
  if (typeof response === 'string') {
    const redacted = runtime.redactor.redactText(response);
    return { output: redacted.value, truncated: null, redactions: redacted.count };
  }
  if (!isRecord(response)) {
    return { output: response, truncated: null, redactions: 0 };
  }
  const redacted = redactShaped(runtime, response);
  return { output: redacted.value, truncated: null, redactions: redacted.count };
};

/**
 * Cap where a cap means something, redact everywhere, and hand the result back to the model.
 *
 * **Which tools are capped** (first local test, 2026-10-06): `Bash` and MCP tools only. The cap
 * (`toolOutputMaxChars`) exists for what a command prints, whose size nobody chose. Applied to every
 * tool, it serialised an `Edit`'s whole response — `originalFile` included — and logged 37 false
 * *truncated* rows in one run, and a `Read` logged *"45863 to 10000"* while the model read the whole
 * file. **Redaction does not depend on the cap**: every tool's output is redacted, capped or not.
 *
 * **Why the model read the whole file — measured, not assumed** (CLI 2.1.267 / SDK 0.3.267, the SDK
 * driven against a stub Messages API that recorded the `tool_result` the CLI sent back, 2026-10-06):
 * the CLI validates `updatedToolOutput` against the **tool's own output schema** and, when it does
 * not parse, logs *"PostToolUse hook returned updatedToolOutput that does not match <tool>'s output
 * shape; using original output"* and sends the original. A **string** for `Bash` (whose output is
 * `{stdout, stderr, interrupted, …}`) or for `Read` (`{type, file: {…}}`) was ignored — the model
 * received `ORIGINAL-STDOUT` and the original file — while a same-shaped object (`stdout` replaced,
 * `file.content` replaced) was honoured, and a string for an MCP tool was honoured. So until this
 * change **neither the cap nor the redaction of this hook reached the model for any built-in tool,
 * `Bash` included**; the transcript was redacted regardless, at write (TD-012). Since this change a
 * built-in tool's replacement is always its own output object with strings replaced.
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
    const name = hookInput.tool_name;
    const rewritten = name.startsWith(MCP_TOOL_PREFIX)
      ? rewriteMcpOutput(runtime, name, hookInput.tool_response)
      : name === 'Bash'
        ? rewriteBashOutput(runtime, hookInput.tool_response)
        : rewriteBuiltInOutput(runtime, hookInput.tool_response);
    if (rewritten.truncated === null && rewritten.redactions === 0) {
      return {};
    }
    const parts: string[] = [];
    if (rewritten.truncated !== null) {
      parts.push(`truncated ${rewritten.truncated.from} characters to ${rewritten.truncated.to}`);
    }
    if (rewritten.redactions > 0) {
      parts.push(`redacted ${rewritten.redactions} secret-shaped value(s) (TD-012)`);
    }
    await runtime.recordHook({
      hook: 'PostToolUse',
      toolName: name,
      toolUseId: toolUseId ?? null,
      decision: null,
      reason: parts.join('; '),
    });
    return {
      hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: rewritten.output },
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
    { matcher: PLATFORM_TOOL_MATCHER, hooks: [platformToolHook(runtime)] },
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

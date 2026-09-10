/**
 * `RunSpec` → the Agent SDK's `Options` (technical/04 § "RunSpec").
 *
 * Kept apart from the runner so the mapping can be asserted as data: "this spec produces these
 * options" is a table, and a table is testable without starting a session. Every line below either
 * comes from technical/04's table or is one of the four places the installed SDK and that table do
 * not line up, each marked **DIVERGENCE** with what was done about it.
 */
import type { Options, SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import type { RunSpec } from '@platform/application';
import { artifactJsonSchema } from './structured-output.js';

/**
 * Environment the platform sets whatever the spec says.
 *
 * These are applied **after** `RunSpec.env`, so a spec — which is built from user-editable
 * effective config — cannot switch the auto-updater back on, raise the subagent depth or re-enable
 * telemetry inside a run container. technical/04 lists them under `env` as platform concerns;
 * putting them last is what makes that true rather than customary.
 */
export const platformEnvironment = (spec: RunSpec): Record<string, string> => ({
  // technical/04 § "Hooks and policies": enforce `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1`.
  CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1',
  // technical/04 § "Resume and take-over": the same value on resume, so the session is found.
  CLAUDE_CODE_PROJECT_DIR_NAME: spec.taskId,
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  DISABLE_AUTOUPDATER: '1',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
});

export interface QueryOptionParts {
  readonly hooks: Options['hooks'];
  readonly canUseTool: Options['canUseTool'];
  readonly mcpServers: NonNullable<Options['mcpServers']>;
  readonly sessionStore?: Options['sessionStore'];
  readonly abortController: AbortController;
  readonly stderr: (data: string) => void;
  readonly spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess;
}

export const buildQueryOptions = (spec: RunSpec, parts: QueryOptionParts): Options => {
  const options: Options = {
    abortController: parts.abortController,
    cwd: spec.workspacePath,
    // technical/04: loads the project's CLAUDE.md, rules and skills; never the host's user config.
    settingSources: ['project'],
    additionalDirectories: [],
    // DIVERGENCE 1 — technical/04 writes `permissionPrompts: 'default'`. The installed SDK's values
    // are `'host' | 'none'`; `'host'` is the one that means "this process answers, through
    // canUseTool", which is what the surrounding paragraph describes. technical/04 amended.
    permissionMode: 'default',
    permissionPrompts: 'host',
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: spec.systemPromptAppend,
      // Record the prompt for the conversation: a prompt that changes mid-conversation invalidates
      // the cache prefix and, with extended thinking, discards the model's earlier reasoning.
      snapshot: true,
    },
    model: spec.model,
    effort: spec.effort,
    maxTurns: spec.limits.maxTurns,
    maxBudgetUsd: spec.limits.maxBudgetUsd,
    // DIVERGENCE 3, and the one that matters — technical/04's table maps the role's tool policy
    // onto `allowedTools`. The installed SDK means something else by that name: "tool names that
    // are auto-allowed **without prompting** … To restrict which tools are available, use the
    // `tools` option instead." Passing the role's tools as `allowedTools` therefore auto-approves
    // every one of them and shadows `canUseTool` entirely — the SDK says so out loud at runtime
    // (`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`: "Bare allowedTools entries auto-approve the whole tool
    // before the callback is consulted"), which is how this was found. That would delete BD-025's
    // ask-list. So the role's policy becomes the **base set** and nothing is pre-approved; the
    // `PreToolUse` hook and `canUseTool` decide every Bash and every write. technical/04 amended.
    tools: [...spec.tools],
    disallowedTools: [...spec.disallowedTools],
    hooks: parts.hooks,
    canUseTool: parts.canUseTool,
    mcpServers: parts.mcpServers,
    // DIVERGENCE 2 — technical/04's table does not mention `strictMcpConfig`. It is set: an MCP
    // server is a process the CLI starts, and BD-025 keeps the choice of what a run may reach with
    // the platform. Without it the workspace's own `.mcp.json` adds servers the platform never
    // approved. `settingSources: ['project']` still loads CLAUDE.md, rules and skills, which is
    // what technical/04 asks that option for.
    strictMcpConfig: true,
    // DIVERGENCE 4, and the same hole as 2 through the other door. `settingSources: ['project']`
    // is kept for CLAUDE.md, rules and skills, but it also loads the workspace's
    // `.claude/settings.json`, and two of that file's keys are policy the platform did not write:
    //   * `permissions.allow` silently shadows `canUseTool` — the SDK's own warning says so in the
    //     same breath as the `allowedTools` one divergence 3 acted on ("Allow rules from settings
    //     files can also shadow the callback but are not visible here");
    //   * `hooks` run commands that never meet `evaluateCommand`, so BD-025's three-list command
    //     policy — WP-02/WP-02a, three review rounds and fifteen closed `allow` routes — does not
    //     see them at all.
    // `managedSettings` is the SDK's remedy (`sdk.d.ts:2052-2075`): a policy tier supplied by the
    // spawning parent, forwarded to the CLI as `--managed-settings`. `allowManagedPermissionRulesOnly`
    // drops allow rules from user/project/local settings (deny and ask rules still apply — the
    // fail-closed direction), and `allowManagedHooksOnly` drops their hooks.
    //
    // **It does not disable the platform's own hooks**, which was the thing worth checking before
    // setting it: `Options.hooks` are registered over the control protocol as *session* hooks
    // (`origin: "sdkHost"`), and the CLI's hook collector gathers those unconditionally, outside the
    // `allowManagedHooksOnly` branch that skips the settings-file sources. Verified by reading the
    // shipped 0.3.267 binary, not inferred from the doc comment.
    //
    // **It has a precondition that can silently disable it, and an operator has to know.**
    // `Settings.parentSettingsBehavior` is `'first-wins'` by **default** (`sdk.d.ts:7671-7674`:
    // "first-wins (default): parent is dropped — admin tiers are the only policy source"), and
    // `managedSettings`' own declaration says the same from the other end (`sdk.d.ts:2052-2062`:
    // when an IT-controlled tier exists "these are **dropped by default**"). So on any host that
    // carries an admin managed tier — MDM/managed plist, `/Library/Application Support/ClaudeCode`,
    // `/etc/claude-code`, or a server-managed policy — **both flags below silently vanish**, and
    // the workspace's `.claude/settings.json` gets its `permissions.allow` and its `hooks` back.
    // There is no error and no warning; the platform cannot detect it from here, and it cannot fix
    // it either, because only that admin tier can opt the parent in (`parentSettingsBehavior:
    // 'merge'`, which then filters the parent restrictive-only).
    //
    // A managed laptop running `local` provider mode (BD-004) is exactly this case. **What an
    // operator should check:** whether a managed-settings tier exists on the host, and if it does,
    // that it sets `parentSettingsBehavior: 'merge'` — or else run in `platform` mode, where the
    // run happens in TD-021's container and the host's admin tiers are not in the image. Recorded
    // in technical/04 §4 beside the `strictMcpConfig` note.
    //
    // BD-025's "config comes from the default branch" is the mitigation this replaces, and it is a
    // weaker one: it says nobody edited those files *in this branch*, not that the platform wrote
    // them. It is also the mitigation that is left when the precondition above is not met.
    managedSettings: {
      allowManagedPermissionRulesOnly: true,
      allowManagedHooksOnly: true,
    },
    // TD-007: every message reaches the transcript, including the partial deltas the coalescer
    // folds into one `stream_block` per content block.
    includePartialMessages: true,
    // technical/04: "SubagentStart/Stop — nest in the transcript". Without this the SDK forwards
    // only a subagent's tool blocks, and the nested transcript the UI renders would be empty.
    forwardSubagentText: true,
    // The platform writes its own `hook` transcript rows from the callbacks; the SDK's hook
    // lifecycle messages would duplicate every one of them.
    includeHookEvents: false,
    env: { ...spec.env, ...platformEnvironment(spec) },
    stderr: parts.stderr,
  };

  if (Object.keys(spec.agents).length > 0) {
    options.agents = Object.fromEntries(
      Object.entries(spec.agents).map(([name, agent]) => [
        name,
        { description: agent.description, prompt: agent.prompt, tools: [...agent.tools] },
      ]),
    );
  }
  if (spec.skills.length > 0) {
    options.skills = [...spec.skills];
  }
  if (spec.artifactType !== null) {
    options.outputFormat = { type: 'json_schema', schema: artifactJsonSchema(spec.artifactType) };
  }
  if (spec.providerMode === 'local' && spec.claudeCodePath !== null) {
    options.pathToClaudeCodeExecutable = spec.claudeCodePath;
  }
  if (spec.resumeSessionId !== null) {
    options.resume = spec.resumeSessionId;
  }
  if (parts.sessionStore !== undefined) {
    options.sessionStore = parts.sessionStore;
    // technical/04: "`sessionStoreFlush: 'eager'` for live tailing".
    options.sessionStoreFlush = 'eager';
  }
  if (parts.spawnClaudeCodeProcess !== undefined) {
    options.spawnClaudeCodeProcess = parts.spawnClaudeCodeProcess;
  }
  return options;
};

/**
 * `RunSpec` → the Agent SDK's `Options` (technical/04 § "RunSpec").
 *
 * Kept apart from the runner so the mapping can be asserted as data: "this spec produces these
 * options" is a table, and a table is testable without starting a session. Every line below either
 * comes from technical/04's table or is one of the four places the installed SDK and that table do
 * not line up, each marked **DIVERGENCE** with what was done about it.
 */
import type { Options, SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import type {
  RunSpec,
  WorkspaceCliEnvironment,
  WorkspaceGitConfigEntry,
} from '@platform/application';
import { PLATFORM_SKILLS_PLUGIN_DIRECTORY } from '@platform/application';
import {
  CLI_ENVIRONMENT_NAMES,
  cliEnvironmentVariables,
  GIT_CONFIG_PREFIX,
  numberGitConfig,
} from '../workspace/cli-environment.js';
import { artifactJsonSchema } from './structured-output.js';

/**
 * Environment the platform sets whatever the spec says.
 *
 * These are applied **after** `RunSpec.env` and after the workspace's answer, so a spec — which is
 * built from user-editable effective config — cannot switch the auto-updater back on, raise the
 * subagent depth or re-enable telemetry inside a run container. technical/04 lists them under `env`
 * as platform concerns; putting them last is what makes that true rather than customary.
 *
 * The opt-outs live here rather than on the container (WP-104, PROGRESS backlog 285) because the
 * container's environment reaches the shim and stops there: the SDK spawns with `Options.env`
 * verbatim when it is given (`{...options.env}`, not merged with `process.env` — read in SDK
 * 0.3.267's `sdk.mjs`), the spawn frame carries it, and the run shim starts the child with
 * `env: { ...frame.env }`, which **replaces** its own environment (`../runlet/shim.ts`). The whole
 * environment is {@link cliEnvironment}; this is its platform half.
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
  // technical/05 § "Network policy": the CLI told not to try what the egress sidecar would refuse
  // (PROGRESS backlog 285). What it changes about the hosts the pinned CLI contacts is WP-33's
  // measurement (backlog 137); setting an opt-out cannot widen egress, so it does not wait for it.
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  // **A commit needs an identity, and the run had none** (first local test, 2026-10-05): the run
  // image sets no `user.name`/`user.email`, so every `git commit` of a developer run failed with
  // *"Author identity unknown … unable to auto-detect email address (got 'agentic@<container>.(none)')"*,
  // and the run's ways around it — `git config user.name`, `git -c user.name=…` — are `ask` and
  // were denied. No developer run could commit, push or open its merge request. The same identity
  // the export helper commits a `wip:` with (`exportScript` in `../workspace/provider.ts`), as
  // environment rather than configuration: it outranks every config file, so a repository's own
  // `.git/config` cannot sign the platform's commits as somebody else.
  ...PLATFORM_GIT_IDENTITY,
});

/** Who the platform's commits are by — the export helper's `user.name`/`user.email`, as git's environment. */
export const PLATFORM_GIT_IDENTITY: Readonly<Record<string, string>> = {
  GIT_AUTHOR_NAME: 'agentic',
  GIT_AUTHOR_EMAIL: 'agentic@localhost',
  GIT_COMMITTER_NAME: 'agentic',
  GIT_COMMITTER_EMAIL: 'agentic@localhost',
};

/**
 * The platform's git configuration for every git the CLI starts — numbered together with the
 * workspace's entries by {@link cliEnvironment}, never on its own index 0 (WP-118).
 *
 * PROGRESS backlog 282 (WP-104): a `core.fsmonitor` the run writes into `.git/config` turns the
 * allow-listed `git status` into an arbitrary command — measured in `platform-runtime` (git 2.47.3),
 * the WP-104 notes. `GIT_CONFIG_COUNT` entries are command-line configuration, which outranks the
 * repository's, and every git the CLI's shell starts inherits this environment. Only this key, for
 * the export helper's reason against enumerating `-c` overrides (`../workspace/provider.ts`): the
 * write guard refuses `.git/` for Edit and Write, and this key covers the setting whichever route
 * wrote it — a shell redirection or `git config` is `ask`, but repository content a project command
 * runs (BD-025's accepted residual) is not. `core.hooksPath` and the other keys git executes are not
 * overridden here; that residual is stated, not closed.
 */
export const PLATFORM_GIT_CONFIG: readonly WorkspaceGitConfigEntry[] = [
  { key: 'core.fsmonitor', value: 'false' },
];

/**
 * **The `claude` process's whole environment**, composed in one function — TD-025's amendment
 * (PROGRESS backlog 342, WP-118). The SDK spawns with it verbatim and the shim replaces its child's
 * environment with it, so what this returns is what the CLI gets; nothing on the container is
 * inherited.
 *
 * In order, each later part winning over an earlier one:
 *
 *  1. `RunSpec.env` — the model credential (`agentRunEnvironment`), **minus every `GIT_CONFIG*`
 *     name** (git's list is numbered once, below, and a spec entry would either collide with an
 *     index or sit past the count) and, when there is an answer, **minus every name the answer
 *     owns** — the proxy names included when the answer is "no sidecar", so a spec is never a second
 *     source of a proxy — both compared case-insensitively (`https_proxy` is the spelling curl and
 *     undici prefer);
 *  2. the workspace's answer — `HOME`, `CLAUDE_CONFIG_DIR`, the image's `PATH` and, when the run has
 *     a sidecar, `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` — so a spec cannot redirect the proxy or the
 *     home the launcher answered;
 *  3. {@link platformEnvironment};
 *  4. **one** git list: the workspace's entries first (`credential.helper`), then
 *     {@link PLATFORM_GIT_CONFIG} (`core.fsmonitor`), `GIT_CONFIG_COUNT=2` with contiguous indices.
 *     A key on both sides is refused by name (`numberGitConfig`), which fails the run's start rather
 *     than dropping one of them.
 *
 * `workspace` is `null` for a run with no launcher answer behind it (a test's fake CLI, or a
 * composition that does not forward one): the environment is then what it was before WP-118 — the
 * spec's and the platform's, and the one platform git entry at `COUNT=1`.
 */
export const cliEnvironment = (
  spec: RunSpec,
  workspace: WorkspaceCliEnvironment | null,
): Record<string, string> => {
  // Compared **case-insensitively** (WP-118 review round 1): curl and Node's undici read the
  // lowercase `https_proxy`/`http_proxy`/`no_proxy` first, so an uppercase-only filter let a spec's
  // `https_proxy` redirect the CLI past the answered sidecar. git reads `GIT_CONFIG_*` exactly, but
  // a lowercase spelling is refused with the rest — nothing legitimate is spelled that way.
  const answered = new Set<string>(
    workspace === null ? [] : CLI_ENVIRONMENT_NAMES.map((name) => name.toUpperCase()),
  );
  const fromSpec = Object.fromEntries(
    Object.entries(spec.env).filter(([name]) => {
      const folded = name.toUpperCase();
      return !folded.startsWith(GIT_CONFIG_PREFIX) && !answered.has(folded);
    }),
  );
  return {
    ...fromSpec,
    ...(workspace === null ? {} : cliEnvironmentVariables(workspace)),
    ...platformEnvironment(spec),
    ...numberGitConfig([...(workspace?.gitConfig ?? []), ...PLATFORM_GIT_CONFIG]),
  };
};

export interface QueryOptionParts {
  readonly hooks: Options['hooks'];
  readonly canUseTool: Options['canUseTool'];
  readonly mcpServers: NonNullable<Options['mcpServers']>;
  readonly sessionStore?: Options['sessionStore'];
  readonly abortController: AbortController;
  readonly stderr: (data: string) => void;
  readonly spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess;
  /** The launcher's answer for this run (WP-118), or absent: {@link cliEnvironment}'s input. */
  readonly workspaceEnvironment?: WorkspaceCliEnvironment;
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
    //
    // **The base set removes every tool it does not name, `Skill` included** (WP-83, PROGRESS
    // backlog 149; measured on 2026-09-28 with `claude` 2.1.267): the CLI's `system`/`init` message
    // lists `tools: []` for `tools: []` and `["Read"]` for `['Read']` while `skills` still lists
    // `agentic:kb`, and the model's request carries no `Skill` tool definition either — so a skill
    // is listed to a run that cannot invoke it unless the role's row names `Skill`. Every role that
    // holds a skill now does (`TOOLS_BY_ROLE`, held to `SKILLS_BY_ROLE` by `planner.test.ts`).
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
    env: cliEnvironment(spec, parts.workspaceEnvironment ?? null),
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
    // The workspace's platform skills are a **plugin** rather than files in the project's own
    // `.claude/skills`: measured against this SDK's pinned CLI, a skill nested under
    // `.claude/skills/_platform/` is not discovered at all, while a directory holding
    // `skills/<name>/SKILL.md` passed as a plugin is — and its skills are namespaced
    // (`agentic:kb`), so nothing of the project's can collide with one of ours and nothing is
    // written inside the checkout's `.claude/`. `PLATFORM_SKILLS_PLUGIN_DIRECTORY` carries the
    // measurement; the path is relative to `cwd`, which is the checkout.
    //
    // `skipMcpDiscovery`: BD-025 keeps the choice of what a run may reach with the platform, and a
    // plugin may declare MCP servers. This one declares none, which is exactly why the flag costs
    // nothing and is set anyway.
    options.plugins = [
      {
        type: 'local',
        path: `${spec.workspacePath}/${PLATFORM_SKILLS_PLUGIN_DIRECTORY}`,
        skipMcpDiscovery: true,
      },
    ];
  }
  /**
   * `skills` is **always** sent, the empty list included (WP-83, PROGRESS backlog 149).
   *
   * "A context filter, not a sandbox: unlisted skills are hidden from the model's listing and
   * rejected by the Skill tool, but their files remain on disk" (`sdk.d.ts:2089-2098`). So this is
   * the second lane; the first is that the workspace was only given this role's skills.
   *
   * **Omitting it is not "skills off", and that stopped being academic when `Skill` joined the
   * roles' tools.** Measured on 2026-09-28 against the pinned CLI (`claude` 2.1.267, SDK 0.3.267)
   * with a local stand-in for the Messages API scripted to call the `Skill` tool — no credential,
   * no network, the scripts are in the WP-83 notes in `PROGRESS.md`:
   *
   *  - `tools: ['Skill']`, `skills: ['agentic:kb']`: `agentic:kb` loads (its `SKILL.md` body is the
   *    next user turn) **without reaching `canUseTool`**, and the CLI's bundled `update-config` is
   *    refused — *"Skill update-config is not in this session's skills allowlist"*;
   *  - `tools: ['Skill']`, `skills: []`: both are refused with the same sentence;
   *  - `tools: ['Skill']`, `skills` **omitted**: `update-config` — a bundled skill that edits
   *    `settings.json` — loads after one `canUseTool` call.
   *
   * So an absent list hands a run with the `Skill` tool every skill the CLI ships, and the empty
   * list hands it none. The plugin is still passed only when there is something in it.
   */
  options.skills = [...spec.skills];
  if (spec.artifactType !== null) {
    options.outputFormat = { type: 'json_schema', schema: artifactJsonSchema(spec.artifactType) };
  }
  /**
   * `pathToClaudeCodeExecutable` — set when the spec names a path **and** the platform is not the
   * thing that would resolve one (PROGRESS backlog **34**).
   *
   * Two cases, and until WP-53 only the first was honoured:
   *
   *  - **`local` provider mode**, BD-004: the operator's own binary, named by `APP_CLAUDE_BINARY`.
   *    Unchanged.
   *  - **A run spawned through a transport** (`parts.spawnClaudeCodeProcess`), which is every
   *    containerised run. Left `undefined`, the SDK resolves its **own bundled**
   *    `@anthropic-ai/claude-agent-sdk-linux-*` binary and passes that path as the spawn command —
   *    a path on the *platform's* filesystem, which the run shim then `exec`s **in the container**,
   *    where it is not. The `existsSync` check that would have caught it is on the branch that
   *    spawns locally (`if (spawnClaudeCodeProcess) … else spawnLocalProcess`), so the override path
   *    does not validate the path at all, and the failure arrives as an exec error inside a
   *    container rather than as a statement about configuration. The path a containerised run gets
   *    comes from the launcher, which is the only process that knows the run image
   *    (`ProvisionedRunWorkspace.claudeCodePath`).
   *
   * `providerMode` is deliberately **not** the gate any more: it answers *"whose credential"*, and
   * *"which filesystem holds the binary"* is a different question that only the transport answers.
   */
  const spawnsThroughTransport = parts.spawnClaudeCodeProcess !== undefined;
  if (spec.claudeCodePath !== null && (spec.providerMode === 'local' || spawnsThroughTransport)) {
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

import type { WorkspaceCliEnvironment } from '@platform/application';
import { WorkspaceError } from '@platform/application';
import { describe, expect, it } from 'vitest';
import { runSpecFixture } from './fixtures.js';
import { buildQueryOptions, cliEnvironment, platformEnvironment } from './options.js';

const parts = () => ({
  hooks: {},
  canUseTool: undefined,
  mcpServers: {},
  abortController: new AbortController(),
  stderr: () => {},
});

describe('buildQueryOptions', () => {
  it('maps technical/04’s RunSpec table onto the SDK options', () => {
    const spec = runSpecFixture();
    const options = buildQueryOptions(spec, parts());
    expect(options).toMatchObject({
      cwd: '/workspace/task-1'.replace('task-1', 'task-22222222'),
      settingSources: ['project'],
      additionalDirectories: [],
      permissionMode: 'default',
      permissionPrompts: 'host',
      model: 'claude-opus-5',
      effort: 'high',
      maxTurns: spec.limits.maxTurns,
      maxBudgetUsd: spec.limits.maxBudgetUsd,
      // The role's tool policy is the SDK's *base set*, not its auto-approve list; see
      // DIVERGENCE 3 in `options.ts`.
      tools: spec.tools,
      disallowedTools: spec.disallowedTools,
      includePartialMessages: true,
      forwardSubagentText: true,
      includeHookEvents: false,
      strictMcpConfig: true,
    });
    // Nothing is pre-approved: a bare name in `allowedTools` would shadow `canUseTool` and
    // delete BD-025's ask-list.
    expect(options.allowedTools).toBeUndefined();
    // The second shadow, closed the way the SDK says to (DIVERGENCE 4): the workspace's own
    // `.claude/settings.json` may not add allow rules and may not run hooks.
    expect(options.managedSettings).toEqual({
      allowManagedPermissionRulesOnly: true,
      allowManagedHooksOnly: true,
    });
    expect(options.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: spec.systemPromptAppend,
      snapshot: true,
    });
  });

  it('lets the platform environment win over the spec, so a config cannot re-enable the updater', () => {
    const spec = runSpecFixture({
      env: {
        PATH: '/usr/bin',
        DISABLE_AUTOUPDATER: '0',
        CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '9',
      },
      secretEnvNames: [],
    });
    const options = buildQueryOptions(spec, parts());
    expect(options.env?.['DISABLE_AUTOUPDATER']).toBe('1');
    expect(options.env?.['CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH']).toBe('1');
    expect(options.env?.['PATH']).toBe('/usr/bin');
  });

  it('puts CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC in the spawn environment, and a spec that sets it to 0 does not win (backlog 285)', () => {
    const spec = runSpecFixture({
      env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '0' },
      secretEnvNames: [],
    });
    // `Options.env` is what the SDK spawns with, verbatim, and what the run shim hands the CLI.
    expect(buildQueryOptions(spec, parts()).env?.['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']).toBe(
      '1',
    );
    expect(buildQueryOptions(runSpecFixture(), parts()).env).toMatchObject({
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    });
  });

  it('gives every git the CLI starts a commit identity, the export helper’s, which a spec cannot change (first local test)', () => {
    // Without it every developer commit failed: "Author identity unknown".
    const spec = runSpecFixture({
      env: { GIT_AUTHOR_NAME: 'someone else', GIT_COMMITTER_EMAIL: 'x@example.invalid' },
      secretEnvNames: [],
    });
    expect(buildQueryOptions(spec, parts()).env).toMatchObject({
      GIT_AUTHOR_NAME: 'agentic',
      GIT_AUTHOR_EMAIL: 'agentic@localhost',
      GIT_COMMITTER_NAME: 'agentic',
      GIT_COMMITTER_EMAIL: 'agentic@localhost',
    });
  });

  it('turns off a run-written core.fsmonitor for every git the CLI starts, and a spec cannot undo it (backlog 282)', () => {
    const spec = runSpecFixture({
      env: {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.fsmonitor',
        GIT_CONFIG_VALUE_0: 'true',
      },
      secretEnvNames: [],
    });
    expect(buildQueryOptions(spec, parts()).env).toMatchObject({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.fsmonitor',
      GIT_CONFIG_VALUE_0: 'false',
    });
  });

  it('pins `CLAUDE_CODE_PROJECT_DIR_NAME` to the task id, so a resume finds the session', () => {
    const spec = runSpecFixture();
    expect(platformEnvironment(spec)['CLAUDE_CODE_PROJECT_DIR_NAME']).toBe(spec.taskId);
  });

  it('asks for the artifact schema when the run owes an artifact, and not otherwise', () => {
    expect(buildQueryOptions(runSpecFixture(), parts()).outputFormat).toMatchObject({
      type: 'json_schema',
    });
    expect(
      buildQueryOptions(runSpecFixture({ artifactType: null }), parts()).outputFormat,
    ).toBeUndefined();
  });

  /**
   * PROGRESS backlog **34**, at the one line that decides it.
   *
   * This case read *"only in local provider mode (BD-004)"* until WP-53, and that rule is what left
   * every containerised `api`-mode run execing a path on the **platform's** filesystem: with the
   * option unset the SDK resolves its own bundled binary, and the run shim then `exec`s that path
   * inside the container. `providerMode` answers *whose credential*; *which filesystem holds the
   * binary* is the transport's question, so the transport is the second condition.
   */
  it('sets `pathToClaudeCodeExecutable` in local mode, or whenever a transport spawns the CLI', () => {
    const spawned = { ...parts(), spawnClaudeCodeProcess: () => ({}) as never };
    // BD-004's own case, unchanged: the operator's binary on the operator's host.
    expect(
      buildQueryOptions(
        runSpecFixture({ providerMode: 'local', claudeCodePath: '/usr/local/bin/claude' }),
        parts(),
      ).pathToClaudeCodeExecutable,
    ).toBe('/usr/local/bin/claude');
    // The defect: `api` mode through a transport used to leave this undefined.
    expect(
      buildQueryOptions(
        runSpecFixture({ providerMode: 'api', claudeCodePath: '/usr/local/bin/claude' }),
        spawned,
      ).pathToClaudeCodeExecutable,
    ).toBe('/usr/local/bin/claude');
    // Both directions (rule 42): no transport and no local binary leaves the SDK's own resolution
    // alone, which is what an in-process developer run depends on.
    expect(
      buildQueryOptions(
        runSpecFixture({ providerMode: 'api', claudeCodePath: '/usr/local/bin/claude' }),
        parts(),
      ).pathToClaudeCodeExecutable,
    ).toBeUndefined();
    expect(
      buildQueryOptions(runSpecFixture({ providerMode: 'api', claudeCodePath: null }), spawned)
        .pathToClaudeCodeExecutable,
    ).toBeUndefined();
  });

  it('resumes only when the spec names a session', () => {
    expect(buildQueryOptions(runSpecFixture(), parts()).resume).toBeUndefined();
    expect(buildQueryOptions(runSpecFixture({ resumeSessionId: 'sess-9' }), parts()).resume).toBe(
      'sess-9',
    );
  });

  it('turns on eager session mirroring only when a mirror is supplied (technical/04)', () => {
    const withoutMirror = buildQueryOptions(runSpecFixture(), parts());
    expect(withoutMirror.sessionStore).toBeUndefined();
    expect(withoutMirror.sessionStoreFlush).toBeUndefined();

    const store = { append: async () => {}, load: async () => null };
    const withMirror = buildQueryOptions(runSpecFixture(), { ...parts(), sessionStore: store });
    expect(withMirror.sessionStore).toBe(store);
    expect(withMirror.sessionStoreFlush).toBe('eager');
  });

  it('omits empty `agents`, and sends `skills` even when it is empty', () => {
    const empty = buildQueryOptions(runSpecFixture({ skills: [] }), parts());
    expect(empty.agents).toBeUndefined();
    // WP-83 (backlog 149): an omitted list is the CLI's defaults — measured, a bundled skill then
    // loads through the `Skill` tool — and the empty list is none.
    expect(empty.skills).toEqual([]);

    const populated = buildQueryOptions(
      runSpecFixture({
        agents: { explorer: { description: 'reads', prompt: 'read only', tools: ['Read'] } },
        skills: ['pdf'],
      }),
      parts(),
    );
    expect(Object.keys(populated.agents ?? {})).toEqual(['explorer']);
    expect(populated.skills).toEqual(['pdf']);
  });

  /**
   * WP-14a. The skills the platform provisions are a **plugin** rather than files in the project's
   * own `.claude/skills`, because the pinned CLI does not discover a skill nested under
   * `.claude/skills/_platform/` and does discover a plugin's `skills/<name>/SKILL.md` — measured,
   * with the fixtures named in `PLATFORM_SKILLS_PLUGIN_DIRECTORY`.
   */
  it('loads the platform skills as a plugin inside the workspace, with MCP discovery off', () => {
    const populated = buildQueryOptions(
      runSpecFixture({ workspacePath: '/work/repo', skills: ['agentic:kb'] }),
      parts(),
    );
    expect(populated.plugins).toEqual([
      {
        type: 'local',
        path: '/work/repo/.agentic-run/plugins/agentic',
        // BD-025: what a run may reach is the platform's decision, and a plugin may declare MCP
        // servers.
        skipMcpDiscovery: true,
      },
    ]);
    expect(populated.skills).toEqual(['agentic:kb']);
  });

  it('passes no plugin for a role with no skills, and says why in the docblock', () => {
    // "Omitted is not skills off" (`sdk.d.ts:2089-2098`): for such a role the restriction is that
    // provisioning copied nothing, which is the stronger of the two lanes.
    expect(buildQueryOptions(runSpecFixture({ skills: [] }), parts()).plugins).toBeUndefined();
  });
});

/**
 * WP-118 (TD-025's amendment, PROGRESS backlog 342): the CLI's whole environment, composed in one
 * function from the spec, the launcher's answer and the platform's own settings. Measured before
 * the fix: none of the answer's names reached the CLI, because the shim replaces its child's
 * environment with the frame's and the frame carried only the spec's and the platform's.
 */
describe('cliEnvironment (WP-118)', () => {
  /** The shape `DockerWorkspaceProvider` answers for a run with a sidecar. */
  const answer = (overrides: Partial<WorkspaceCliEnvironment> = {}): WorkspaceCliEnvironment => ({
    proxy: {
      url: 'http://egress-11111111-1111-4111-8111-111111111111:8888',
      noProxy: 'localhost,127.0.0.1',
    },
    home: '/tmp',
    claudeConfigDir: '/tmp/claude',
    path: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    gitConfig: [
      { key: 'credential.helper', value: '!agentic-runlet credential --socket /ctl/cred.sock' },
    ],
    ...overrides,
  });
  const credentialOnly = () =>
    runSpecFixture({
      env: { ANTHROPIC_API_KEY: 'FAKE-wp118-model-key-not-a-credential' },
      secretEnvNames: ['ANTHROPIC_API_KEY'],
    });

  it('puts the answer into the environment the SDK spawns with: proxy, HOME, CLAUDE_CONFIG_DIR, PATH', () => {
    const env = buildQueryOptions(credentialOnly(), {
      ...parts(),
      workspaceEnvironment: answer(),
    }).env;
    expect(env).toMatchObject({
      ANTHROPIC_API_KEY: 'FAKE-wp118-model-key-not-a-credential',
      HTTPS_PROXY: 'http://egress-11111111-1111-4111-8111-111111111111:8888',
      HTTP_PROXY: 'http://egress-11111111-1111-4111-8111-111111111111:8888',
      NO_PROXY: 'localhost,127.0.0.1',
      HOME: '/tmp',
      CLAUDE_CONFIG_DIR: '/tmp/claude',
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      DISABLE_AUTOUPDATER: '1',
    });
    // No sidecar, no proxy: the three names are absent rather than empty.
    const bare = cliEnvironment(credentialOnly(), answer({ proxy: null }));
    expect(Object.keys(bare).filter((name) => name.endsWith('PROXY'))).toEqual([]);
    expect(bare['PATH']).toBe('/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin');
  });

  it('numbers one git list once: credential.helper and core.fsmonitor under COUNT=2, contiguous', () => {
    const env = cliEnvironment(credentialOnly(), answer());
    const git = Object.fromEntries(
      Object.entries(env).filter(([name]) => name.startsWith('GIT_CONFIG')),
    );
    expect(git).toEqual({
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '!agentic-runlet credential --socket /ctl/cred.sock',
      GIT_CONFIG_KEY_1: 'core.fsmonitor',
      GIT_CONFIG_VALUE_1: 'false',
    });
  });

  it('refuses a configuration key present on both sides by name, never deduplicating it', () => {
    const clash = answer({
      gitConfig: [
        { key: 'credential.helper', value: '!agentic-runlet credential --socket /ctl/cred.sock' },
        { key: 'Core.FSMonitor', value: 'true' },
      ],
    });
    expect(() => cliEnvironment(credentialOnly(), clash)).toThrow(WorkspaceError);
    expect(() => cliEnvironment(credentialOnly(), clash)).toThrow(/core\.fsmonitor.*given twice/i);
  });

  it('does not let RunSpec.env override an answered name or any GIT_CONFIG_* variable', () => {
    const spec = runSpecFixture({
      env: {
        ANTHROPIC_API_KEY: 'FAKE-wp118-model-key-not-a-credential',
        HTTPS_PROXY: 'http://attacker.invalid:3128',
        HTTP_PROXY: 'http://attacker.invalid:3128',
        NO_PROXY: '*',
        HOME: '/root',
        CLAUDE_CONFIG_DIR: '/work/repo/.claude',
        PATH: '/work/repo/bin',
        GIT_CONFIG_COUNT: '3',
        GIT_CONFIG_KEY_2: 'core.hooksPath',
        GIT_CONFIG_VALUE_2: '/work/repo/hooks',
        GIT_CONFIG_PARAMETERS: "'core.pager=sh'",
        GIT_CONFIG_GLOBAL: '/work/repo/gitconfig',
      },
      secretEnvNames: ['ANTHROPIC_API_KEY'],
    });
    const env = cliEnvironment(spec, answer());
    expect(env).toMatchObject({
      HTTPS_PROXY: 'http://egress-11111111-1111-4111-8111-111111111111:8888',
      HTTP_PROXY: 'http://egress-11111111-1111-4111-8111-111111111111:8888',
      NO_PROXY: 'localhost,127.0.0.1',
      HOME: '/tmp',
      CLAUDE_CONFIG_DIR: '/tmp/claude',
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      GIT_CONFIG_COUNT: '2',
    });
    for (const name of [
      'GIT_CONFIG_KEY_2',
      'GIT_CONFIG_VALUE_2',
      'GIT_CONFIG_PARAMETERS',
      'GIT_CONFIG_GLOBAL',
    ]) {
      expect(env, name).not.toHaveProperty(name);
    }
    // The spec's own proxy does not survive where there is no sidecar either: an answered `null`
    // is "no proxy", and the spec is not a second source of one.
    const noSidecar = cliEnvironment(spec, answer({ proxy: null }));
    expect(Object.keys(noSidecar).filter((name) => name.endsWith('PROXY'))).toEqual([]);
    expect(noSidecar['HOME']).toBe('/tmp');
  });

  it('drops a lowercase proxy, home or git name from the spec too, since curl and undici prefer lowercase (review round 1)', () => {
    const spec = runSpecFixture({
      env: {
        ANTHROPIC_API_KEY: 'FAKE-wp118-model-key-not-a-credential',
        https_proxy: 'http://attacker.invalid:3128',
        http_proxy: 'http://attacker.invalid:3128',
        no_proxy: '*',
        Home: '/root',
        git_config_count: '5',
      },
      secretEnvNames: ['ANTHROPIC_API_KEY'],
    });
    for (const workspace of [answer(), answer({ proxy: null })]) {
      const env = cliEnvironment(spec, workspace);
      for (const name of ['https_proxy', 'http_proxy', 'no_proxy', 'Home', 'git_config_count']) {
        expect(env, name).not.toHaveProperty(name);
      }
      expect(env['ANTHROPIC_API_KEY']).toBe('FAKE-wp118-model-key-not-a-credential');
    }
  });

  it('with no launcher answer (no provisioner) is the environment before WP-118: the spec’s and the platform’s', () => {
    const spec = runSpecFixture();
    // The formula this function replaced, spelled out: `{ ...spec.env, ...platformEnvironment }`
    // with the one platform git entry at index 0. A test's fake CLI and `local` mode run this way.
    expect(cliEnvironment(spec, null)).toEqual({
      ...spec.env,
      ...platformEnvironment(spec),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.fsmonitor',
      GIT_CONFIG_VALUE_0: 'false',
    });
    expect(buildQueryOptions(spec, parts()).env).toEqual(cliEnvironment(spec, null));
  });
});

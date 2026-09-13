import { describe, expect, it } from 'vitest';
import { runSpecFixture } from './fixtures.js';
import { buildQueryOptions, platformEnvironment } from './options.js';

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

  it('sets `pathToClaudeCodeExecutable` only in local provider mode (BD-004)', () => {
    expect(
      buildQueryOptions(
        runSpecFixture({ providerMode: 'local', claudeCodePath: '/usr/local/bin/claude' }),
        parts(),
      ).pathToClaudeCodeExecutable,
    ).toBe('/usr/local/bin/claude');
    expect(
      buildQueryOptions(
        runSpecFixture({ providerMode: 'api', claudeCodePath: '/usr/local/bin/claude' }),
        parts(),
      ).pathToClaudeCodeExecutable,
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

  it('omits `agents` and `skills` rather than sending empty ones', () => {
    const empty = buildQueryOptions(runSpecFixture(), parts());
    expect(empty.agents).toBeUndefined();
    expect(empty.skills).toBeUndefined();

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

/**
 * The hook table. Each guard is checked twice: that it fires, and — in the "mutation" block at the
 * bottom — that the *named* assertion protecting it fails when the guard is removed. A guard whose
 * test passes with the guard reverted is decoration.
 */
import type {
  HookCallbackMatcher,
  HookEvent,
  HookJSONOutput,
  PreToolUseHookSpecificOutput,
  SyncHookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';
import { silentLogger } from '@platform/application';
import { DEFAULT_COMMAND_POLICY } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { composeRedactors, patternRedactor } from '../redaction/pattern-redaction.js';
import {
  FIXTURE_INJECTED_SECRET,
  injectedSecretRedactorFixture,
  runSpecFixture,
} from './fixtures.js';
import {
  buildHooks,
  type HookRecord,
  type HookRuntime,
  PLATFORM_TOOL_OUTPUT_MAX_CHARS,
} from './hooks.js';

interface Harness {
  readonly hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  readonly records: HookRecord[];
  readonly compactions: { phase: string; trigger: string }[];
  fire(
    event: HookEvent,
    input: Record<string, unknown>,
    toolUseId?: string,
  ): Promise<HookJSONOutput>;
}

const harness = (
  overrides: Partial<HookRuntime> = {},
  spec = runSpecFixture(),
  steer: string | null = null,
): Harness => {
  const records: HookRecord[] = [];
  const compactions: { phase: string; trigger: string }[] = [];
  let provenance = steer;
  const runtime: HookRuntime = {
    spec,
    policy: DEFAULT_COMMAND_POLICY,
    redactor: composeRedactors(injectedSecretRedactorFixture(), patternRedactor()),
    logger: silentLogger,
    recordHook: async (record) => {
      records.push(record);
    },
    recordCompaction: async (phase, trigger) => {
      compactions.push({ phase, trigger });
    },
    takeSteerProvenance: () => {
      const value = provenance;
      provenance = null;
      return value;
    },
    ...overrides,
  };
  const hooks = buildHooks(runtime);
  return {
    hooks,
    records,
    compactions,
    fire: async (event, input, toolUseId) => {
      const matchers = hooks[event] ?? [];
      const toolName = input['tool_name'];
      const matcher = matchers.find(
        (candidate) =>
          candidate.matcher === undefined ||
          (typeof toolName === 'string' && new RegExp(`^(?:${candidate.matcher})$`).test(toolName)),
      );
      if (matcher === undefined) {
        throw new Error(`no matcher for ${event} / ${String(toolName)}`);
      }
      const callback = matcher.hooks[0];
      if (callback === undefined) {
        throw new Error(`no callback for ${event}`);
      }
      return callback({ ...input, hook_event_name: event } as never, toolUseId, {
        signal: new AbortController().signal,
      });
    },
  };
};

const decisionOf = (output: HookJSONOutput): string | undefined =>
  ((output as SyncHookJSONOutput).hookSpecificOutput as PreToolUseHookSpecificOutput | undefined)
    ?.permissionDecision;

const reasonOf = (output: HookJSONOutput): string | undefined =>
  ((output as SyncHookJSONOutput).hookSpecificOutput as PreToolUseHookSpecificOutput | undefined)
    ?.permissionDecisionReason;

const updatedOf = (output: HookJSONOutput): unknown =>
  ((output as SyncHookJSONOutput).hookSpecificOutput as { updatedToolOutput?: unknown } | undefined)
    ?.updatedToolOutput;

describe('PreToolUse(Bash) — the command policy hook', () => {
  it('allows an allow-listed command and says which pattern decided', async () => {
    const test = harness();
    const output = await test.fire('PreToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
    });
    expect(decisionOf(output)).toBe('allow');
    expect(test.records[0]?.reason).toContain('command policy: allow');
  });

  it('denies a blocked command, which is how `block` reaches the SDK', async () => {
    const test = harness();
    const output = await test.fire('PreToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'sudo reboot' },
    });
    expect(decisionOf(output)).toBe('deny');
    expect(test.records[0]?.decision).toBe('deny');
  });

  it('runs an unmatched command under `auto`, and records that it ran under that rule (BD-025, 2026-10-06)', async () => {
    const test = harness();
    const output = await test.fire(
      'PreToolUse',
      { tool_name: 'Bash', tool_input: { command: 'terraform plan' } },
      'toolu_1',
    );
    // `allow`, never `ask`: an `ask` would reach `canUseTool`, which has nobody to ask.
    expect(decisionOf(output)).toBe('allow');
    expect(test.records).toEqual([
      expect.objectContaining({
        hook: 'PreToolUse',
        toolName: 'Bash',
        toolUseId: 'toolu_1',
        decision: 'allow',
        reason: 'unattended: ask allowed in the sandbox (no list matches it)',
      }),
    ]);
  });

  it('runs an ask-list match under `auto`, naming the entry it matched', async () => {
    const test = harness();
    const output = await test.fire('PreToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'composer require monolog/monolog' },
    });
    expect(decisionOf(output)).toBe('allow');
    expect(test.records[0]?.reason).toBe(
      'unattended: ask allowed in the sandbox (matched "composer require *")',
    );
  });

  it('refuses the same command under `deny`, saying which fragment and what to do instead', async () => {
    const spec = runSpecFixture({
      commandPolicy: { ...runSpecFixture().commandPolicy, unattended: 'deny' },
    });
    const test = harness({}, spec);
    const output = await test.fire('PreToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'ls && composer require monolog/monolog' },
    });
    expect(decisionOf(output)).toBe('deny');
    const reason = reasonOf(output);
    expect(reason).toContain('the fragment `composer require monolog/monolog`');
    expect(reason).toContain('matched "composer require *"');
    expect(reason).toContain('`deny` mode');
    expect(reason).toContain('not a network or sandbox failure');
    expect(reason).toContain('Read tool (with offset/limit');
    expect(test.records[0]).toMatchObject({ decision: 'deny', reason });
  });

  it('refuses a push that is not `origin agentic/…` under `auto`, and says how to push', async () => {
    const test = harness();
    const output = await test.fire('PreToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'git push https://gitlab.example.test/other/repo.git agentic/x' },
    });
    expect(decisionOf(output)).toBe('deny');
    expect(reasonOf(output)).toContain('`git push origin agentic/<key>`');
    expect(test.records[0]?.decision).toBe('deny');
  });

  it('refuses when it cannot read a command at all, rather than allowing', async () => {
    const test = harness();
    const output = await test.fire('PreToolUse', { tool_name: 'Bash', tool_input: { cmd: 7 } });
    expect(decisionOf(output)).toBe('deny');
    expect(test.records[0]?.reason).toContain('could not read a command');
  });

  it('refuses a line the scanner cannot follow, under `auto` too (rule 5)', async () => {
    const test = harness();
    const output = await test.fire('PreToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'echo "unterminated' },
    });
    expect(decisionOf(output)).toBe('deny');
    expect(test.records[0]?.reason).toContain('cannot follow');
  });

  it('never answers `ask`, whatever the command and the mode', async () => {
    for (const unattended of ['auto', 'deny'] as const) {
      const spec = runSpecFixture({
        commandPolicy: { ...runSpecFixture().commandPolicy, unattended },
      });
      const test = harness({}, spec);
      for (const command of ['terraform plan', 'npm install x', 'sudo id', 'echo $((1))', 'ls']) {
        const output = await test.fire('PreToolUse', {
          tool_name: 'Bash',
          tool_input: { command },
        });
        expect(['allow', 'deny']).toContain(decisionOf(output));
      }
    }
  });

  it('uses the run’s own policy, not the shipped default', async () => {
    const spec = runSpecFixture({
      commandPolicy: { allow: [], ask: [], block: ['git status'], unattended: 'auto' },
    });
    const test = harness({ policy: spec.commandPolicy }, spec);
    expect(
      decisionOf(
        await test.fire('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'git status' } }),
      ),
    ).toBe('deny');
  });
});

describe('PreToolUse(Edit|Write) — the path guard', () => {
  it('allows a write inside the workspace', async () => {
    const test = harness();
    const output = await test.fire('PreToolUse', {
      tool_name: 'Write',
      tool_input: { file_path: 'src/index.ts', content: 'export const a = 1;' },
    });
    expect(decisionOf(output)).toBe('allow');
  });

  it('denies a write outside the workspace', async () => {
    const test = harness();
    const output = await test.fire('PreToolUse', {
      tool_name: 'Write',
      tool_input: { file_path: '/etc/cron.d/agent', content: 'x' },
    });
    expect(decisionOf(output)).toBe('deny');
    expect(test.records[0]?.reason).toContain('outside the task workspace');
  });

  it('denies a protected path the plan does not list', async () => {
    const test = harness();
    const output = await test.fire('PreToolUse', {
      tool_name: 'Edit',
      tool_input: { file_path: 'infra/main.tf', new_string: 'resource {}' },
    });
    expect(decisionOf(output)).toBe('deny');
    // The fixture's listing is `unlisted`, so the target counts as existing (WP-99, fail closed).
    expect(test.records[0]?.reason).toContain(
      "this task's Implementation Plan declares no protected_path_changes",
    );
    expect(test.records[0]?.reason).toContain(
      'could not list which files exist at the merge base with the default branch',
    );
  });

  /**
   * WP-99: the hook hands the guard the spec's listing and the plan's patterns, so a new protected
   * file is allowed, an existing one is denied, and a declared one is allowed — through the hook.
   */
  it('reads the spec’s listing and plan: a new protected file lands, an existing one needs the plan', async () => {
    const spec = runSpecFixture({
      existingProtectedPaths: { state: 'listed', paths: ['infra/main.tf'], opaque: [] },
    });
    const fresh = harness({}, spec);
    const created = await fresh.fire('PreToolUse', {
      tool_name: 'Write',
      tool_input: { file_path: 'infra/new.tf', content: 'resource {}' },
    });
    expect(decisionOf(created)).toBe('allow');
    // A plain allow records nothing (the hook's rule), which is what makes the next row the deny's.
    expect(fresh.records).toEqual([]);
    const existing = await fresh.fire('PreToolUse', {
      tool_name: 'Edit',
      tool_input: { file_path: 'infra/main.tf', new_string: 'resource {}' },
    });
    expect(decisionOf(existing)).toBe('deny');
    expect(fresh.records[0]?.reason).toContain(
      'it exists at the merge base with the default branch',
    );

    const declared = harness({}, { ...spec, plannedProtectedPaths: ['infra/main.tf'] });
    const planned = await declared.fire('PreToolUse', {
      tool_name: 'Edit',
      tool_input: { file_path: 'infra/main.tf', new_string: 'resource {}' },
    });
    expect(decisionOf(planned)).toBe('allow');
  });

  it('denies secret-shaped content even at an allowed path', async () => {
    const test = harness();
    const output = await test.fire('PreToolUse', {
      tool_name: 'Write',
      tool_input: {
        file_path: 'src/config.ts',
        content: 'const t = "ghp_FAKE000000000000000000000000000000000";',
      },
    });
    expect(decisionOf(output)).toBe('deny');
    expect(test.records[0]?.reason).toContain('looks like it contains a credential');
  });

  it('sees content nested in an edits array', async () => {
    const test = harness();
    const output = await test.fire('PreToolUse', {
      tool_name: 'MultiEdit',
      tool_input: {
        file_path: 'src/config.ts',
        edits: [{ old_string: 'a', new_string: 'glpat-FAKE000000000000000' }],
      },
    });
    expect(decisionOf(output)).toBe('deny');
  });

  it('flags a write to agent configuration without blocking it', async () => {
    const test = harness();
    const output = await test.fire('PreToolUse', {
      tool_name: 'Write',
      tool_input: { file_path: 'CLAUDE.md', content: '# rules' },
    });
    expect(decisionOf(output)).toBe('allow');
    expect(test.records[0]?.reason).toContain('flagged for Code review');
  });

  it('denies a write tool whose path it cannot read', async () => {
    const test = harness();
    const output = await test.fire('PreToolUse', { tool_name: 'Write', tool_input: { body: 'x' } });
    expect(decisionOf(output)).toBe('deny');
  });
});

describe('PreToolUse(mcp__platform__*) — the platform’s own tools (first local test)', () => {
  it('allows a platform tool the run was granted, so the CLI never asks about it', async () => {
    // Without this, every granted platform tool went to `canUseTool` and an unattended run denied it.
    const test = harness();
    for (const name of ['get_task_context', 'kb_search', 'report_progress', 'ask_human']) {
      const output = await test.fire(
        'PreToolUse',
        { tool_name: `mcp__platform__${name}`, tool_input: {} },
        `tool-${name}`,
      );
      expect(decisionOf(output), name).toBe('allow');
    }
    expect(test.records).toEqual([]);
  });

  it('denies a platform tool the run was not granted, and records why', async () => {
    const test = harness();
    const output = await test.fire(
      'PreToolUse',
      { tool_name: 'mcp__platform__open_mr', tool_input: { title: 'x' } },
      'tool-1',
    );
    expect(decisionOf(output)).toBe('deny');
    expect(test.records).toEqual([
      expect.objectContaining({
        toolName: 'mcp__platform__open_mr',
        decision: 'deny',
        reason: 'mcp__platform__open_mr is not a platform tool this run was granted',
      }),
    ]);
  });

  it('does not reach another server’s tools', () => {
    const matcher = new RegExp(`^(?:${String(harness().hooks.PreToolUse?.[2]?.matcher)})$`);
    expect(matcher.test('mcp__platform__kb_search')).toBe(true);
    expect(matcher.test('mcp__evil__kb_search')).toBe(false);
    expect(matcher.test('mcp__platformx__kb_search')).toBe(false);
  });
});

describe('PostToolUse — truncation and redaction of what the model reads', () => {
  it('rewrites the model’s copy when the output is over the cap', async () => {
    const spec = runSpecFixture({
      limits: { ...runSpecFixture().limits, toolOutputMaxChars: 200 },
    });
    const test = harness({ spec }, spec);
    const output = await test.fire('PostToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'pnpm test' },
      tool_response: 'x'.repeat(5_000),
    });
    const updated = (
      (output as SyncHookJSONOutput).hookSpecificOutput as { updatedToolOutput?: string }
    ).updatedToolOutput;
    expect(updated).toBeDefined();
    expect(updated?.length).toBe(200);
    expect(test.records[0]?.reason).toContain('truncated 5000 characters to 200');
  });

  it('leaves a platform tool’s answer whole past the command cap, and still cuts it at its own ceiling (backlog 464)', async () => {
    const spec = runSpecFixture({
      limits: { ...runSpecFixture().limits, toolOutputMaxChars: 200 },
    });
    const test = harness({ spec }, spec);
    const whole = await test.fire('PostToolUse', {
      tool_name: 'mcp__platform__get_task_context',
      tool_input: {},
      tool_response: 'x'.repeat(22_082),
    });
    // Nothing changed, so no rewrite and no transcript row: the model reads the answer as sent.
    expect(whole).toEqual({});
    expect(test.records).toEqual([]);
    const huge = await test.fire('PostToolUse', {
      tool_name: 'mcp__platform__get_task_context',
      tool_input: {},
      tool_response: 'x'.repeat(PLATFORM_TOOL_OUTPUT_MAX_CHARS + 1),
    });
    const updated = (
      (huge as SyncHookJSONOutput).hookSpecificOutput as { updatedToolOutput?: string }
    ).updatedToolOutput;
    expect(updated?.length).toBe(PLATFORM_TOOL_OUTPUT_MAX_CHARS);
  });

  it('removes a credential a tool printed before the model ever sees it', async () => {
    const test = harness();
    const output = await test.fire('PostToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'env' },
      tool_response: `GITLAB_TOKEN=${FIXTURE_INJECTED_SECRET}`,
    });
    const updated = (
      (output as SyncHookJSONOutput).hookSpecificOutput as { updatedToolOutput?: string }
    ).updatedToolOutput;
    expect(updated).not.toContain(FIXTURE_INJECTED_SECRET);
    expect(updated).toContain('[REDACTED:integration:gitlab_token]');
    expect(test.records[0]?.reason).toContain('redacted 1 secret-shaped value(s)');
  });

  it('cuts a Bash output in its own shape — stdout and stderr together under the cap, every other key kept', async () => {
    const spec = runSpecFixture({
      limits: { ...runSpecFixture().limits, toolOutputMaxChars: 400 },
    });
    const test = harness({ spec }, spec);
    const response = {
      stdout: 'o'.repeat(5_000),
      stderr: 'e'.repeat(5_000),
      interrupted: false,
      isImage: false,
      noOutputExpected: false,
    };
    const output = await test.fire('PostToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'pnpm test' },
      tool_response: response,
    });
    // An object, never a string: CLI 2.1.267 ignores a replacement that does not parse as the
    // tool's output (measured 2026-10-06), so a string would leave the model the whole output.
    const updated = updatedOf(output) as typeof response;
    expect(Object.keys(updated).sort()).toEqual(Object.keys(response).sort());
    expect(updated.interrupted).toBe(false);
    expect(updated.stdout.length + updated.stderr.length).toBeLessThanOrEqual(400);
    expect(updated.stdout).toContain('characters truncated by the platform');
    expect(updated.stderr).toContain('characters truncated by the platform');
    expect(test.records[0]?.reason).toBe('truncated 10000 characters to 400');
  });

  it('gives stderr what a short stdout leaves, and cuts nothing that fits', async () => {
    const spec = runSpecFixture({
      limits: { ...runSpecFixture().limits, toolOutputMaxChars: 400 },
    });
    const test = harness({ spec }, spec);
    const fits = await test.fire('PostToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'make' },
      tool_response: { stdout: 'ok', stderr: 'w'.repeat(390), interrupted: false },
    });
    expect(fits).toEqual({});
    expect(test.records).toEqual([]);
  });

  it('redacts a credential a command printed, in the output’s own shape', async () => {
    const test = harness();
    const output = await test.fire('PostToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'env' },
      tool_response: {
        stdout: `GITLAB_TOKEN=${FIXTURE_INJECTED_SECRET}`,
        stderr: '',
        interrupted: false,
      },
    });
    const updated = updatedOf(output) as { stdout: string; stderr: string; interrupted: boolean };
    expect(updated).toEqual({
      stdout: 'GITLAB_TOKEN=[REDACTED:integration:gitlab_token]',
      stderr: '',
      interrupted: false,
    });
    expect(test.records[0]?.reason).toBe('redacted 1 secret-shaped value(s) (TD-012)');
  });

  it.each([
    [
      'Read',
      {
        type: 'text',
        file: {
          filePath: '/w/big.php',
          content: 'x'.repeat(45_863),
          numLines: 1,
          startLine: 1,
          totalLines: 1,
        },
      },
    ],
    [
      'Edit',
      {
        filePath: '/w/a.ts',
        oldString: 'a',
        newString: 'b',
        originalFile: 'y'.repeat(80_000),
        structuredPatch: [],
        userModified: false,
        replaceAll: false,
      },
    ],
    [
      'Write',
      { type: 'create', filePath: '/w/n.ts', content: 'z'.repeat(30_000), structuredPatch: [] },
    ],
    [
      'Glob',
      {
        filenames: Array.from({ length: 3_000 }, (_, i) => `src/file-${i}.ts`),
        numFiles: 3_000,
        truncated: false,
        durationMs: 4,
      },
    ],
    [
      'Grep',
      { mode: 'content', numFiles: 1, filenames: [], content: 'g'.repeat(20_000), numLines: 1 },
    ],
  ])(
    'never caps %s, and writes no row for it (first local test: 37 false rows on Edits)',
    async (tool, response) => {
      const test = harness();
      const output = await test.fire('PostToolUse', {
        tool_name: tool,
        tool_input: {},
        tool_response: response,
      });
      expect(output).toEqual({});
      expect(test.records).toEqual([]);
    },
  );

  it('still redacts a Read, in the Read’s own shape — the redaction does not depend on the cap', async () => {
    const test = harness();
    const response = {
      type: 'text',
      file: {
        filePath: '/w/.env',
        content: `TOKEN=${FIXTURE_INJECTED_SECRET}\n${'x'.repeat(45_000)}`,
        numLines: 2,
        startLine: 1,
        totalLines: 2,
      },
    };
    const output = await test.fire('PostToolUse', {
      tool_name: 'Read',
      tool_input: { file_path: '/w/.env' },
      tool_response: response,
    });
    const updated = updatedOf(output) as typeof response;
    expect(updated.type).toBe('text');
    expect(updated.file.numLines).toBe(2);
    expect(updated.file.content).not.toContain(FIXTURE_INJECTED_SECRET);
    expect(updated.file.content.length).toBeGreaterThan(45_000);
    expect(test.records[0]?.reason).toBe('redacted 1 secret-shaped value(s) (TD-012)');
  });

  it('caps another server’s MCP tool at the command cap, as text', async () => {
    const spec = runSpecFixture({
      limits: { ...runSpecFixture().limits, toolOutputMaxChars: 200 },
    });
    const test = harness({ spec }, spec);
    const output = await test.fire('PostToolUse', {
      tool_name: 'mcp__sentry__get_issue',
      tool_input: {},
      tool_response: [{ type: 'text', text: 's'.repeat(5_000) }],
    });
    expect(typeof updatedOf(output)).toBe('string');
    expect((updatedOf(output) as string).length).toBe(200);
  });

  it('writes no transcript row when it changed nothing', async () => {
    const test = harness();
    const output = await test.fire('PostToolUse', {
      tool_name: 'Read',
      tool_input: { file_path: 'README.md' },
      tool_response: 'a short and blameless file',
    });
    expect(output).toEqual({});
    expect(test.records).toHaveLength(0);
  });
});

describe('the rest of the table', () => {
  it('records a subagent starting and stopping, nested by its agent id', async () => {
    const test = harness();
    await test.fire('SubagentStart', { agent_id: 'agent-1', agent_type: 'explorer' });
    await test.fire('SubagentStop', { agent_id: 'agent-1', agent_type: 'explorer' });
    expect(test.records.map((record) => record.hook)).toEqual(['SubagentStart', 'SubagentStop']);
    expect(test.records[0]?.parentToolUseId).toBe('agent-1');
  });

  it('writes the `pre` compaction marker from PreCompact and a hook row from PostCompact', async () => {
    const test = harness();
    await test.fire('PreCompact', { trigger: 'auto', custom_instructions: null });
    await test.fire('PostCompact', { trigger: 'auto', compact_summary: 'summary' });
    expect(test.compactions).toEqual([{ phase: 'pre', trigger: 'auto' }]);
    expect(test.records.map((record) => record.hook)).toEqual(['PostCompact']);
  });

  it('never asks the session to continue on Stop', async () => {
    const test = harness();
    const output = await test.fire('Stop', { stop_hook_active: false });
    expect((output as SyncHookJSONOutput).continue).toBeUndefined();
    expect(test.records[0]?.hook).toBe('Stop');
  });

  it('injects steer provenance once, and not on the prompts after it', async () => {
    const test = harness(
      {},
      runSpecFixture(),
      'A human steered this run: Jan wrote the next message.',
    );
    const first = await test.fire('UserPromptSubmit', { prompt: 'do the other thing' });
    expect(
      ((first as SyncHookJSONOutput).hookSpecificOutput as { additionalContext?: string })
        .additionalContext,
    ).toContain('A human steered this run');
    const second = await test.fire('UserPromptSubmit', { prompt: 'and again' });
    expect(second).toEqual({});
  });

  it('records the SDK’s own model fallback for the cost ledger', async () => {
    const test = harness();
    await test.fire('PostModelSwitch', {
      from_model: 'claude-opus-5',
      to_model: 'claude-sonnet-5',
    });
    expect(test.records[0]?.reason).toContain('claude-opus-5 to claude-sonnet-5');
  });
});

describe('registration', () => {
  it('registers a separate matcher for Bash, the write tools and the platform tools', () => {
    const test = harness();
    expect(test.hooks.PreToolUse?.map((matcher) => matcher.matcher)).toEqual([
      'Bash',
      'Edit|Write|MultiEdit|NotebookEdit',
      'mcp__platform__.*',
    ]);
  });

  it('registers every hook technical/04 names', () => {
    const test = harness();
    expect(Object.keys(test.hooks).sort()).toEqual([
      'PostCompact',
      'PostModelSwitch',
      'PostToolUse',
      'PreCompact',
      'PreToolUse',
      'Stop',
      'SubagentStart',
      'SubagentStop',
      'UserPromptSubmit',
    ]);
  });
});

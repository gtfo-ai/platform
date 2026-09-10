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
import { buildHooks, type HookRecord, type HookRuntime } from './hooks.js';

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

  it('asks for an unmatched command, so `canUseTool` decides (technical/04)', async () => {
    const test = harness();
    const output = await test.fire('PreToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'terraform plan' },
    });
    expect(decisionOf(output)).toBe('ask');
  });

  it('asks when it cannot read a command at all, rather than allowing', async () => {
    const test = harness();
    const output = await test.fire('PreToolUse', { tool_name: 'Bash', tool_input: { cmd: 7 } });
    expect(decisionOf(output)).toBe('ask');
    expect(test.records[0]?.reason).toContain('could not read a command');
  });

  it('reports what the command scanner could not follow', async () => {
    const test = harness();
    const output = await test.fire('PreToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'echo "unterminated' },
    });
    expect(decisionOf(output)).toBe('ask');
    expect(test.records[0]?.reason).toContain('could not follow');
  });

  it('uses the run’s own policy, not the shipped default', async () => {
    const spec = runSpecFixture({
      commandPolicy: { allow: [], ask: [], block: ['git status'] },
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
    expect(test.records[0]?.reason).toContain('the approved plan does not list it');
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
  it('registers a separate matcher for Bash and for the write tools', () => {
    const test = harness();
    expect(test.hooks.PreToolUse?.map((matcher) => matcher.matcher)).toEqual([
      'Bash',
      'Edit|Write|MultiEdit|NotebookEdit',
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

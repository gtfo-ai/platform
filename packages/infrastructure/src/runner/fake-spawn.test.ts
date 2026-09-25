/**
 * The fake CLI's own contract, including the three strictnesses its divergence register claims.
 * A register entry that names a test must name a test that exists — these are those tests.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { fakeCliScriptSchema, fakeSpawnClaudeCodeProcess } from './fake-spawn.js';

const INIT = {
  step: 'emit' as const,
  message: {
    type: 'system',
    subtype: 'init',
    apiKeySource: 'ANTHROPIC_API_KEY',
    claude_code_version: 'fake',
    cwd: '/w',
    tools: [],
    mcp_servers: [],
    model: 'claude-opus-5',
    permissionMode: 'default',
    slash_commands: [],
    output_style: 'default',
    skills: [],
    plugins: [],
    uuid: '00000001-0000-4000-8000-000000000000',
    session_id: 's',
  },
};

const drive = async (
  script: Parameters<typeof fakeSpawnClaudeCodeProcess>[0],
  options: { hooks?: boolean } = {},
): Promise<{ cli: ReturnType<typeof fakeSpawnClaudeCodeProcess>; types: string[] }> => {
  const cli = fakeSpawnClaudeCodeProcess(script);
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: 'user',
      message: { role: 'user', content: 'go' },
      parent_tool_use_id: null,
      session_id: '',
    } as SDKUserMessage;
    await new Promise<never>(() => {});
  }
  const session = query({
    prompt: prompt(),
    options: {
      spawnClaudeCodeProcess: cli.spawn,
      ...(options.hooks === false
        ? {}
        : { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [async () => ({})] }] } }),
    },
  });
  const types: string[] = [];
  try {
    for await (const message of session) {
      types.push(message.type);
      if (message.type === 'result') {
        break;
      }
    }
  } catch {
    // The transport ending is one of the outcomes under test.
  }
  return { cli, types };
};

describe('the script format', () => {
  it('rejects an unknown step rather than skipping it', () => {
    expect(() => fakeCliScriptSchema.parse([{ step: 'teleport' }])).toThrow();
  });

  it('rejects an unknown key on a known step', () => {
    expect(() =>
      fakeCliScriptSchema.parse([{ step: 'emit', message: {}, whenever: true }]),
    ).toThrow();
  });
});

describe('the protocol', () => {
  it('answers `initialize` and then plays the script', async () => {
    const { cli, types } = await drive([
      INIT,
      { step: 'await_user' },
      { step: 'exit', code: 0, signal: null },
    ]);
    expect(types).toEqual(['system']);
    const first = cli.stdin[0] as { request?: { subtype?: string } };
    expect(first.request?.subtype).toBe('initialize');
    await expect(cli.finished).resolves.toBeUndefined();
  });

  it('records the `SpawnOptions` the SDK handed it', async () => {
    const { cli } = await drive([INIT, { step: 'exit', code: 0, signal: null }]);
    expect(cli.spawnOptions?.args).toContain('--output-format');
    expect(cli.spawnOptions?.command.length).toBeGreaterThan(0);
  });

  it('refuses to be spawned twice for one run', async () => {
    const cli = fakeSpawnClaudeCodeProcess([INIT, { step: 'exit', code: 0, signal: null }]);
    const options = { command: 'x', args: [], env: {}, signal: new AbortController().signal };
    cli.spawn(options);
    expect(() => cli.spawn(options)).toThrow(/spawn was called twice/);
  });

  it('records the signals `kill` was called with', async () => {
    const cli = fakeSpawnClaudeCodeProcess([INIT, { step: 'exit', code: 0, signal: null }]);
    const process_ = cli.spawn({
      command: 'x',
      args: [],
      env: {},
      signal: new AbortController().signal,
    });
    process_.kill('SIGTERM');
    expect(cli.signals).toEqual(['SIGTERM']);
    expect(process_.killed).toBe(true);
  });
});

describe('the strictnesses the divergence register claims', () => {
  /** Divergence 1. */
  it('rejects a stdin frame that arrives before initialize', async () => {
    const cli = fakeSpawnClaudeCodeProcess([INIT, { step: 'exit', code: 0, signal: null }]);
    const process_ = cli.spawn({
      command: 'x',
      args: [],
      env: {},
      signal: new AbortController().signal,
    });
    const errors: Error[] = [];
    process_.on('error', (error) => errors.push(error));
    process_.stdin.write(`${JSON.stringify({ type: 'user', message: {} })}\n`);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(errors.map((error) => error.message)).toEqual([
      'fake claude cli: a "user" frame arrived before initialize',
    ]);
    await expect(cli.finished).rejects.toThrow(/before initialize/);
  });

  /** Divergence 2. */
  it('throws when the script fires a hook the runner did not register', async () => {
    const { cli } = await drive(
      [
        INIT,
        { step: 'await_user' },
        { step: 'hook', event: 'PostToolUse', input: {} },
        { step: 'exit', code: 0, signal: null },
      ],
      { hooks: true },
    );
    await expect(cli.finished).rejects.toThrow(
      /the script fires PostToolUse but the platform registered no callback/,
    );
  });

  /** Divergence 3. */
  it('throws when the script ends without an `exit` or a `stall` step', async () => {
    const { cli } = await drive([INIT, { step: 'await_user' }]);
    await expect(cli.finished).rejects.toThrow(/ended without an `exit` or a `stall` step/);
  });

  it('picks the matcher whose pattern matches the tool, as the CLI does', async () => {
    const cli = fakeSpawnClaudeCodeProcess([
      INIT,
      { step: 'await_user' },
      {
        step: 'hook',
        event: 'PreToolUse',
        tool_name: 'Write',
        input: { tool_name: 'Write', tool_input: { file_path: 'a.ts' } },
      },
      { step: 'exit', code: 0, signal: null },
    ]);
    async function* prompt(): AsyncGenerator<SDKUserMessage> {
      yield {
        type: 'user',
        message: { role: 'user', content: 'go' },
        parent_tool_use_id: null,
        session_id: '',
      } as SDKUserMessage;
      await new Promise<never>(() => {});
    }
    const session = query({
      prompt: prompt(),
      options: {
        spawnClaudeCodeProcess: cli.spawn,
        hooks: {
          PreToolUse: [
            { matcher: 'Bash', hooks: [async () => ({ systemMessage: 'bash-branch' })] },
            { matcher: 'Edit|Write', hooks: [async () => ({ systemMessage: 'write-branch' })] },
          ],
        },
      },
    });
    const iterator = session[Symbol.asyncIterator]();
    await iterator.next();
    await cli.finished;
    // Asserting *which* branch ran, not merely that something answered.
    expect(cli.callbacks[0]?.response).toMatchObject({ systemMessage: 'write-branch' });
  });
});

/**
 * The `bash` step (WP-54, divergence rows 4 and 7): the one step that **acts** on the platform's
 * verdict. What it must do is what the CLI does — run an allowed command, never run a denied one,
 * ask `canUseTool` on `ask` and obey it — and its evidence is on disk, not in a verdict string.
 */
describe('the bash step', () => {
  const playBash = async (
    commands: readonly string[],
    verdictFor: (command: string) => 'allow' | 'deny' | 'ask',
    canUseTool: 'allow' | 'deny' = 'deny',
  ) => {
    const workdir = await mkdtemp(join(tmpdir(), 'fake-cli-bash-'));
    const cli = fakeSpawnClaudeCodeProcess(
      [
        INIT,
        { step: 'await_user' },
        ...commands.map((command, index) => ({
          step: 'bash' as const,
          command,
          tool_use_id: `toolu_${String(index)}`,
        })),
        { step: 'exit', code: 0, signal: null },
      ],
      { workdir },
    );
    async function* prompt(): AsyncGenerator<SDKUserMessage> {
      yield {
        type: 'user',
        message: { role: 'user', content: 'go' },
        parent_tool_use_id: null,
        session_id: '',
      } as SDKUserMessage;
      await new Promise<never>(() => {});
    }
    const session = query({
      prompt: prompt(),
      options: {
        spawnClaudeCodeProcess: cli.spawn,
        canUseTool: async (_tool, input) =>
          canUseTool === 'allow'
            ? { behavior: 'allow', updatedInput: input }
            : { behavior: 'deny', message: 'nobody to ask' },
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [
                async (input) => ({
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse' as const,
                    permissionDecision: verdictFor(
                      String((input as { tool_input: { command: string } }).tool_input.command),
                    ),
                    permissionDecisionReason: 'test',
                  },
                }),
              ],
            },
          ],
          PostToolUse: [{ hooks: [async () => ({})] }],
        },
      },
    });
    const iterator = session[Symbol.asyncIterator]();
    const drain = (async () => {
      for (;;) {
        const next = await iterator.next().catch(() => ({ done: true }));
        if (next.done === true) {
          return;
        }
      }
    })();
    await cli.finished;
    void drain;
    return { cli, workdir };
  };

  it('runs an allowed command, in the workdir, and records its exit status and output', async () => {
    const { cli, workdir } = await playBash(
      ['printf ran > marker.txt && echo hello'],
      () => 'allow',
    );
    expect(await readFile(join(workdir, 'marker.txt'), 'utf8')).toBe('ran');
    expect(cli.executions).toEqual([
      expect.objectContaining({ decision: 'allow', ran: true, exitCode: 0, output: 'hello\n' }),
    ]);
    await rm(workdir, { recursive: true, force: true });
  });

  it('never runs a denied command, and asks canUseTool on `ask` and obeys it', async () => {
    const { cli, workdir } = await playBash(
      ['printf a > denied.txt', 'printf b > asked.txt', 'exit 3'],
      (command) =>
        command.includes('denied') ? 'deny' : command.includes('asked') ? 'ask' : 'allow',
    );
    expect(existsSync(join(workdir, 'denied.txt'))).toBe(false);
    expect(existsSync(join(workdir, 'asked.txt'))).toBe(false);
    expect(cli.executions.map((entry) => [entry.decision, entry.ran, entry.exitCode])).toEqual([
      ['deny', false, null],
      ['deny', false, null],
      // The other direction (rule 42): an allowed command that fails still ran, and says so.
      ['allow', true, 3],
    ]);
    expect(cli.callbacks.filter((entry) => entry.kind === 'can_use_tool')).toHaveLength(1);
    await rm(workdir, { recursive: true, force: true });

    const allowed = await playBash(['printf b > asked.txt'], () => 'ask', 'allow');
    expect(existsSync(join(allowed.workdir, 'asked.txt'))).toBe(true);
    await rm(allowed.workdir, { recursive: true, force: true });
  });

  it('refuses a script with a bash step and no workdir, rather than running in the test’s own', () => {
    expect(() =>
      fakeSpawnClaudeCodeProcess([
        INIT,
        { step: 'bash', command: 'true', tool_use_id: 'toolu_x' },
        { step: 'exit', code: 0, signal: null },
      ]),
    ).toThrow(/needs a workdir/);
  });
});

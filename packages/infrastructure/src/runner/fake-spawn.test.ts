/**
 * The fake CLI's own contract, including the three strictnesses its divergence register claims.
 * A register entry that names a test must name a test that exists — these are those tests.
 */

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

import type { PlatformToolContext, PlatformToolName } from '@platform/application';
import { MUTATING_PLATFORM_TOOLS, PLATFORM_TOOL_NAMES } from '@platform/application';
import { describe, expect, it } from 'vitest';
import { composeRedactors, patternRedactor } from '../redaction/pattern-redaction.js';
import {
  FIXTURE_INJECTED_SECRET,
  FIXTURE_PROJECT_ID,
  FIXTURE_RUN_ID,
  FIXTURE_TASK_ID,
  injectedSecretRedactorFixture,
  recordingTools,
} from './fixtures.js';
import {
  createPlatformMcpServer,
  type PlatformMcpRuntime,
  platformToolDefinitions,
} from './platform-mcp.js';

const context: PlatformToolContext = {
  runId: FIXTURE_RUN_ID,
  taskId: FIXTURE_TASK_ID,
  projectId: FIXTURE_PROJECT_ID,
  mode: 'normal',
  signal: new AbortController().signal,
};

const runtime = (
  overrides: Partial<PlatformMcpRuntime> = {},
): PlatformMcpRuntime & {
  readonly calls: readonly { tool: string; outcome: string }[];
} => {
  const calls: { tool: string; outcome: string }[] = [];
  return {
    calls,
    tools: recordingTools(),
    context,
    redactor: composeRedactors(injectedSecretRedactorFixture(), patternRedactor()),
    onCall: (tool, outcome) => calls.push({ tool, outcome }),
    ...overrides,
  };
};

/** `tool()` returns the definition with its handler; this is how a test calls it. */
const callTool = async (
  definition: { name: string; handler: (args: unknown, extra: unknown) => Promise<unknown> },
  args: unknown,
): Promise<{ text: string; isError: boolean }> => {
  const result = (await definition.handler(args, {})) as {
    content: { text: string }[];
    isError?: boolean;
  };
  return {
    text: result.content.map((item) => item.text).join('\n'),
    isError: result.isError === true,
  };
};

const definitionsFor = (runtimeValue: PlatformMcpRuntime, enabled: readonly PlatformToolName[]) =>
  platformToolDefinitions(runtimeValue, enabled) as unknown as {
    name: string;
    handler: (args: unknown, extra: unknown) => Promise<unknown>;
  }[];

describe('which tools a run gets', () => {
  it('registers exactly the tools the spec lists, in catalogue order', () => {
    const names = definitionsFor(runtime(), ['kb_search', 'ask_human']).map((tool) => tool.name);
    expect(names).toEqual(['ask_human', 'kb_search']);
  });

  it('does not register a mutating tool a read-only stage was not given', () => {
    const names = definitionsFor(runtime(), ['kb_search', 'get_task_context']).map(
      (tool) => tool.name,
    );
    for (const mutating of MUTATING_PLATFORM_TOOLS) {
      expect(names).not.toContain(mutating);
    }
  });

  it('can register the whole catalogue of technical/04', () => {
    const names = definitionsFor(runtime(), PLATFORM_TOOL_NAMES).map((tool) => tool.name);
    expect(names).toEqual([...PLATFORM_TOOL_NAMES]);
  });

  it('builds a server named `platform`', () => {
    const server = createPlatformMcpServer(runtime(), ['kb_search']);
    expect(server.name).toBe('platform');
    expect(server.type).toBe('sdk');
  });
});

describe('handling one call', () => {
  it('calls the port and returns its answer', async () => {
    const tools = recordingTools();
    const context_ = runtime({ tools });
    const [askHuman] = definitionsFor(context_, ['ask_human']);
    const result = await callTool(askHuman!, {
      question: 'which branch?',
      blocker_brief: 'two branches are candidates and the ticket names neither',
    });
    expect(result).toEqual({ text: 'yes, proceed', isError: false });
    expect(tools.calls[0]?.tool).toBe('ask_human');
    expect(context_.calls[0]).toEqual({ tool: 'ask_human', outcome: 'ok' });
  });

  it('rejects an unknown key, because the model writes these arguments (BD-022)', async () => {
    const context_ = runtime();
    const [askHuman] = definitionsFor(context_, ['ask_human']);
    const result = await callTool(askHuman!, {
      question: 'which branch?',
      blocker_brief: 'brief',
      run_this_instead: 'rm -rf /',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('run_this_instead');
    expect(context_.calls[0]?.outcome).toBe('invalid_input');
  });

  it('rejects a missing required field', async () => {
    const [askHuman] = definitionsFor(runtime(), ['ask_human']);
    const result = await callTool(askHuman!, { question: 'which branch?' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('blocker_brief');
  });

  it('redacts the success path', async () => {
    const tools = recordingTools({
      kbSearch: async () => ({ hit: `see ${FIXTURE_INJECTED_SECRET}` }),
    });
    const [kbSearch] = definitionsFor(runtime({ tools }), ['kb_search']);
    const result = await callTool(kbSearch!, { query: 'auth' });
    expect(result.text).not.toContain(FIXTURE_INJECTED_SECRET);
    expect(result.text).toContain('[REDACTED:integration:gitlab_token]');
  });

  it('redacts the failure path too — the branch WP-07’s review found missing', async () => {
    const tools = recordingTools({
      kbSearch: async () => {
        throw new Error(`the index rejected the token ${FIXTURE_INJECTED_SECRET}`);
      },
    });
    const context_ = runtime({ tools });
    const [kbSearch] = definitionsFor(context_, ['kb_search']);
    const result = await callTool(kbSearch!, { query: 'auth' });
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain(FIXTURE_INJECTED_SECRET);
    expect(result.text).toContain('[REDACTED:integration:gitlab_token]');
    expect(context_.calls[0]?.outcome).toBe('error');
  });

  it('survives a thrown non-Error', async () => {
    const tools = recordingTools({
      // biome-ignore lint/suspicious/useAwait: the point is a synchronous throw of a non-Error.
      kbSearch: async () => {
        throw 'a string';
      },
    });
    const [kbSearch] = definitionsFor(runtime({ tools }), ['kb_search']);
    const result = await callTool(kbSearch!, { query: 'auth' });
    expect(result).toEqual({ text: 'kb_search failed: unknown error', isError: true });
  });
});

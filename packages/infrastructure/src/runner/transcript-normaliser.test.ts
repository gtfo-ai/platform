import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { transcriptEventSchema } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import {
  normaliseContentBlock,
  normaliseMessage,
  normaliseModelUsage,
  normaliseUsage,
  reportedCount,
  type TranscriptEnvelope,
  terminalReasonOf,
} from './transcript-normaliser.js';

const envelope: TranscriptEnvelope = {
  run_id: '11111111-1111-4111-8111-111111111111',
  seq: 0,
  created_at: '2026-03-01T09:00:00.000Z',
};

const parse = (message: SDKMessage) => {
  const event = normaliseMessage(message, envelope);
  if (event === null) {
    return null;
  }
  // Everything this module produces has to satisfy the published contract, or the runner's own
  // validation would reject it at runtime.
  return transcriptEventSchema.parse({ ...event, redaction_count: 0 });
};

describe('content blocks', () => {
  it.each([
    [
      { type: 'text', text: 'hello' },
      { type: 'text', text: 'hello' },
    ],
    [
      { type: 'thinking', thinking: 'hmm' },
      { type: 'thinking', thinking: 'hmm' },
    ],
    [
      { type: 'redacted_thinking', data: 'opaque' },
      { type: 'thinking', thinking: '[redacted thinking]' },
    ],
    [
      { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool_use', tool_use_id: 'toolu_1', tool_name: 'Bash', input: { command: 'ls' } },
    ],
    [
      { type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: 'boom' },
      { type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: 'boom' },
    ],
  ])('maps %o', (input, expected) => {
    expect(normaliseContentBlock(input)).toEqual(expected);
  });

  it('renders an unknown block as a marker rather than dropping it', () => {
    expect(normaliseContentBlock({ type: 'image', source: {} })).toEqual({
      type: 'text',
      text: '[unsupported content block: image]',
    });
  });

  it('flattens a tool_result whose content is an array of text blocks', () => {
    expect(
      normaliseContentBlock({
        type: 'tool_result',
        tool_use_id: 't',
        is_error: false,
        content: [
          { type: 'text', text: 'one' },
          { type: 'text', text: 'two' },
        ],
      }),
    ).toEqual({ type: 'tool_result', tool_use_id: 't', is_error: false, content: 'one\ntwo' });
  });
});

describe('usage', () => {
  it('reads the 5m/1h cache split out of `cache_creation`', () => {
    expect(
      normaliseUsage({
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 7,
        cache_creation_input_tokens: 30,
        cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 },
      }),
    ).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      cache_write_5m_tokens: 10,
      cache_write_1h_tokens: 20,
      cache_read_tokens: 7,
    });
  });

  it('attributes an unsplit total to the 5-minute bucket, the SDK default TTL', () => {
    const usage = normaliseUsage({
      input_tokens: 1,
      output_tokens: 1,
      cache_creation: null,
      cache_creation_input_tokens: 40,
      cache_read_input_tokens: 0,
    });
    expect(usage.cache_write_5m_tokens).toBe(40);
    expect(usage.cache_write_1h_tokens).toBe(0);
  });

  it('treats missing and negative counters as zero rather than as NaN', () => {
    expect(normaliseUsage({ input_tokens: -5 })).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_write_5m_tokens: 0,
      cache_write_1h_tokens: 0,
      cache_read_tokens: 0,
    });
  });
});

/**
 * `reportedCount` is asserted here, on its own, because two of its cases **cannot travel**:
 * `JSON.stringify(NaN)` and `JSON.stringify(Infinity)` are both `null`, so a test that drives them
 * through the NDJSON fake is really re-testing `null`. The in-process caller is real — the SDK
 * hands `SDKMessage` objects to `normaliseMessage` and `RunOutcome` is built from the same object —
 * so these are the values a producer that is not the CLI (WP-13's `agentic-runlet`, an in-process
 * fake, a future transport that is not JSON) can put in front of the guard.
 */
describe('reportedCount, the hygiene every CLI-reported count goes through', () => {
  it.each([
    ['absent', undefined, 0],
    ['null', null, 0],
    ['a string', '7', 0],
    ['a numeric-looking string', '0', 0],
    ['NaN', Number.NaN, 0],
    ['Infinity', Number.POSITIVE_INFINITY, 0],
    ['-Infinity', Number.NEGATIVE_INFINITY, 0],
    ['negative', -3, 0],
    ['zero', 0, 0],
    ['fractional', 4.7, 4],
    ['a whole number', 7, 7],
    ['a boolean', true, 0],
    ['an object', { valueOf: () => 7 }, 0],
  ])('reads %s as %s', (_label, value, expected) => {
    expect(reportedCount(value)).toBe(expected);
    expect(Number.isSafeInteger(reportedCount(value))).toBe(true);
  });
});

describe('per-model usage', () => {
  const runUsage = normaliseUsage({
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 5,
    cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 90 },
  });

  it('uses the run-level TTL split verbatim when exactly one model ran', () => {
    const [entry] = normaliseModelUsage(
      {
        'claude-opus-5': {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadInputTokens: 5,
          cacheCreationInputTokens: 100,
          costUSD: 1.5,
        },
      },
      runUsage,
    );
    expect(entry).toEqual({
      model: 'claude-opus-5',
      input_tokens: 100,
      output_tokens: 20,
      cache_write_5m_tokens: 10,
      cache_write_1h_tokens: 90,
      cache_read_tokens: 5,
      usd: 1.5,
    });
  });

  it('falls back to the 5-minute bucket per model when several models ran', () => {
    const entries = normaliseModelUsage(
      {
        'claude-opus-5': { inputTokens: 1, cacheCreationInputTokens: 40, costUSD: 1 },
        'claude-haiku-4-5': { inputTokens: 2, cacheCreationInputTokens: 60, costUSD: 0.1 },
      },
      runUsage,
    );
    expect(entries.map((entry) => entry.cache_write_5m_tokens)).toEqual([40, 60]);
    expect(entries.map((entry) => entry.cache_write_1h_tokens)).toEqual([0, 0]);
  });
});

const resultBase = {
  type: 'result' as const,
  duration_ms: 10,
  duration_api_ms: 8,
  num_turns: 3,
  stop_reason: 'end_turn',
  total_cost_usd: 0.25,
  usage: { input_tokens: 1, output_tokens: 1 },
  modelUsage: {},
  permission_denials: [],
  uuid: 'abcdefab-1111-4111-8111-111111111111',
  session_id: 'sess-1',
};

describe('terminal reasons', () => {
  it('maps a clean success', () => {
    expect(
      terminalReasonOf({
        ...resultBase,
        subtype: 'success',
        is_error: false,
        result: 'done',
      } as unknown as SDKResultMessage),
    ).toBe('success');
  });

  it('reads `is_error` on a success subtype as an execution error, not a success', () => {
    expect(
      terminalReasonOf({
        ...resultBase,
        subtype: 'success',
        is_error: true,
        result: 'the API failed',
      } as unknown as SDKResultMessage),
    ).toBe('error_during_execution');
  });

  it.each(['error_max_turns', 'error_max_budget_usd', 'error_max_structured_output_retries'])(
    'passes %s through',
    (subtype) => {
      expect(
        terminalReasonOf({
          ...resultBase,
          subtype,
          is_error: true,
          errors: [],
        } as unknown as SDKResultMessage),
      ).toBe(subtype);
    },
  );

  it('reports an execution error with denials as `permission_denied`', () => {
    expect(
      terminalReasonOf({
        ...resultBase,
        subtype: 'error_during_execution',
        is_error: true,
        errors: [],
        permission_denials: [{ tool_name: 'Bash', tool_use_id: 't', tool_input: {} }],
      } as unknown as SDKResultMessage),
    ).toBe('permission_denied');
  });
});

describe('messages', () => {
  it('does not store a partial `stream_event` (TD-007)', () => {
    expect(
      normaliseMessage(
        {
          type: 'stream_event',
          event: { type: 'content_block_delta' },
          parent_tool_use_id: null,
          uuid: 'u',
          session_id: 's',
        } as unknown as SDKMessage,
        envelope,
      ),
    ).toBeNull();
  });

  it('maps `system/init` with the session and the model', () => {
    const event = parse({
      type: 'system',
      subtype: 'init',
      apiKeySource: 'ANTHROPIC_API_KEY',
      claude_code_version: '2.1.267',
      cwd: '/workspace/task-1',
      tools: ['Bash'],
      mcp_servers: [{ name: 'platform', status: 'connected' }],
      model: 'claude-opus-5',
      permissionMode: 'default',
      slash_commands: [],
      output_style: 'default',
      skills: [],
      plugins: [],
      uuid: 'abcdefab-1111-4111-8111-111111111111',
      session_id: 'sess-1',
    } as unknown as SDKMessage);
    expect(event).toMatchObject({
      kind: 'system',
      subtype: 'init',
      session_id: 'sess-1',
      model: 'claude-opus-5',
    });
  });

  it('maps `system/compact_boundary` to the `post` compaction marker with its token counts', () => {
    const event = parse({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'auto', pre_tokens: 120_000, post_tokens: 20_000 },
      uuid: 'abcdefab-1111-4111-8111-111111111111',
      session_id: 'sess-1',
    } as unknown as SDKMessage);
    expect(event).toMatchObject({
      kind: 'compaction',
      phase: 'post',
      pre_tokens: 120_000,
      post_tokens: 20_000,
    });
  });

  it('keeps an unrecognised system subtype as a `system` entry with its payload', () => {
    const event = parse({
      type: 'system',
      subtype: 'mirror_error',
      error: 'the session store rejected a batch',
      uuid: 'abcdefab-1111-4111-8111-111111111111',
      session_id: 'sess-1',
    } as unknown as SDKMessage);
    expect(event).toMatchObject({ kind: 'system', subtype: 'mirror_error' });
    expect((event as { data: Record<string, unknown> }).data).toEqual({
      error: 'the session store rejected a batch',
    });
  });

  it('keeps an entirely unknown message type rather than dropping it', () => {
    const event = parse({
      type: 'some_future_message',
      payload: { a: 1 },
    } as unknown as SDKMessage);
    expect(event).toMatchObject({ kind: 'system', subtype: 'some_future_message' });
  });

  it('carries `parent_tool_use_id` so a subagent nests in the transcript', () => {
    const event = parse({
      type: 'assistant',
      message: { model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'sub' }] },
      parent_tool_use_id: 'toolu_parent',
      uuid: 'abcdefab-1111-4111-8111-111111111111',
      session_id: 'sess-1',
    } as unknown as SDKMessage);
    expect(event).toMatchObject({ kind: 'assistant', parent_tool_use_id: 'toolu_parent' });
  });

  /**
   * The SDK declares `total_cost_usd` non-optional and passes it through **unvalidated**, so the
   * producer decides what arrives — and from WP-13 the producer is `agentic-runlet`, not the CLI.
   * Every one of these used to reach `usdSchema` as `NaN` and take the whole `result` row down with
   * it: the row the pipeline reads was replaced by `transcript_normalisation_failed`.
   */
  it.each([
    ['absent', undefined],
    ['null', null],
    ['a string', '0.42'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['negative', -1],
  ])(
    'still writes a `result` row when `total_cost_usd` is %s, with a finite zero cost',
    (_label, value) => {
      const event = parse({
        ...resultBase,
        total_cost_usd: value,
        subtype: 'success',
        is_error: false,
        result: 'done',
        structured_output: {},
      } as unknown as SDKMessage);
      expect(event).toMatchObject({ kind: 'result', cost: { usd: 0, is_estimate: false } });
    },
  );

  it('keeps a per-model `costUSD` of NaN out of the row, which `typeof` alone would admit', () => {
    const event = parse({
      ...resultBase,
      modelUsage: { 'claude-opus-5': { inputTokens: 1, outputTokens: 1, costUSD: Number.NaN } },
      subtype: 'success',
      is_error: false,
      result: 'done',
      structured_output: {},
    } as unknown as SDKMessage);
    expect(event).toMatchObject({ model_usage: [{ model: 'claude-opus-5', usd: 0 }] });
  });

  it('carries the structured output of a successful result and nothing from a failed one', () => {
    const success = parse({
      ...resultBase,
      subtype: 'success',
      is_error: false,
      result: 'done',
      structured_output: { root_cause: 'stale cookie' },
    } as unknown as SDKMessage);
    expect(success).toMatchObject({ structured_output: { root_cause: 'stale cookie' } });

    const failed = parse({
      ...resultBase,
      subtype: 'error_max_turns',
      is_error: true,
      errors: [],
    } as unknown as SDKMessage);
    expect(failed).toMatchObject({ terminal_reason: 'error_max_turns', structured_output: null });
  });
});

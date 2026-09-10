import type { TranscriptEvent } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { normaliseEvents, type ToolBlock, toBlocks } from './blocks.js';

const RUN = '11111111-1111-4111-8111-111111111111';

const envelope = {
  run_id: RUN,
  created_at: '2026-09-10T09:00:00.000Z',
  redaction_count: 0,
} as const;

const assistant = (
  seq: number,
  content: TranscriptEvent extends { content: infer C } ? C : never,
) => ({ ...envelope, kind: 'assistant', seq, model: 'claude-opus-5', content }) as TranscriptEvent;

const toolUse = (seq: number, id: string, name: string, input: Record<string, unknown> = {}) =>
  assistant(seq, [{ type: 'tool_use', tool_use_id: id, tool_name: name, input }] as never);

const toolResult = (seq: number, id: string, content: string, isError = false): TranscriptEvent =>
  ({
    ...envelope,
    kind: 'user',
    seq,
    content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content }],
  }) as TranscriptEvent;

describe('normaliseEvents', () => {
  it('sorts by seq and keeps one entry per seq', () => {
    const events = [
      assistant(3, [{ type: 'text', text: 'c' }] as never),
      assistant(1, [{ type: 'text', text: 'a' }] as never),
      assistant(3, [{ type: 'text', text: 'c again' }] as never),
    ];
    expect(normaliseEvents(events).map((event) => event.seq)).toEqual([1, 3]);
  });
});

describe('toBlocks', () => {
  it('renders assistant text and thinking as separate blocks', () => {
    const blocks = toBlocks([
      assistant(1, [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'answer' },
      ] as never),
    ]);

    expect(blocks.map((block) => block.kind)).toEqual(['thinking', 'text']);
  });

  it('folds a tool result into the tool call it answers', () => {
    const blocks = toBlocks([
      toolUse(1, 'toolu_1', 'Read', { file_path: 'a.ts' }),
      toolResult(2, 'toolu_1', 'file contents'),
    ]);

    expect(blocks).toHaveLength(1);
    const tool = blocks[0] as ToolBlock;
    expect(tool.kind).toBe('tool');
    expect(tool.toolName).toBe('Read');
    expect(tool.result).toEqual({ isError: false, content: 'file contents' });
  });

  it('shows a tool result whose call was never delivered rather than swallowing it', () => {
    const blocks = toBlocks([toolResult(2, 'toolu_missing', 'orphaned output')]);
    expect(blocks).toEqual([{ kind: 'user', id: '2:0', seq: 2, text: 'orphaned output' }]);
  });

  it('nests a subagent’s entries under the tool call that started them', () => {
    const child = {
      ...envelope,
      kind: 'assistant',
      seq: 3,
      parent_tool_use_id: 'toolu_task',
      model: 'claude-opus-5',
      content: [{ type: 'text', text: 'child says hello' }],
    } as TranscriptEvent;

    const blocks = toBlocks([toolUse(1, 'toolu_task', 'Task', { prompt: 'go' }), child]);

    expect(blocks).toHaveLength(1);
    const tool = blocks[0] as ToolBlock;
    expect(tool.children.map((block) => block.kind)).toEqual(['text']);
  });

  it('keeps an entry whose parent has not arrived at the top level', () => {
    const orphan = {
      ...envelope,
      kind: 'assistant',
      seq: 3,
      parent_tool_use_id: 'toolu_unknown',
      model: 'claude-opus-5',
      content: [{ type: 'text', text: 'no parent yet' }],
    } as TranscriptEvent;

    expect(toBlocks([orphan]).map((block) => block.kind)).toEqual(['text']);
  });

  it('marks a coalesced stream block as streaming until its message arrives', () => {
    const partial = {
      ...envelope,
      kind: 'stream_block',
      seq: 1,
      block_index: 0,
      block: { type: 'text', text: 'half a sen' },
      first_delta_at: envelope.created_at,
      last_delta_at: envelope.created_at,
    } as TranscriptEvent;

    const streaming = toBlocks([partial]);
    expect(streaming).toHaveLength(1);
    expect(streaming[0]).toMatchObject({ kind: 'text', text: 'half a sen', streaming: true });

    const settled = toBlocks([
      partial,
      assistant(2, [{ type: 'text', text: 'half a sentence' }] as never),
    ]);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ kind: 'text', text: 'half a sentence', streaming: false });
  });

  it('keeps only the latest partial for a block index', () => {
    const partial = (seq: number, text: string) =>
      ({
        ...envelope,
        kind: 'stream_block',
        seq,
        block_index: 0,
        block: { type: 'text', text },
        first_delta_at: envelope.created_at,
        last_delta_at: envelope.created_at,
      }) as TranscriptEvent;

    const blocks = toBlocks([partial(1, 'ab'), partial(2, 'abcd')]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ text: 'abcd' });
  });

  it('is idempotent over a replayed event', () => {
    const events = [
      toolUse(1, 'toolu_1', 'Bash', { command: 'ls' }),
      toolResult(2, 'toolu_1', 'a b'),
    ];
    expect(toBlocks([...events, ...events])).toEqual(toBlocks(events));
  });

  it('renders hook, steer, compaction, system and result entries', () => {
    const blocks = toBlocks([
      {
        ...envelope,
        kind: 'hook',
        seq: 1,
        hook: 'PreToolUse',
        decision: 'deny',
        reason: 'blocked',
      } as TranscriptEvent,
      {
        ...envelope,
        kind: 'steer',
        seq: 2,
        message: 'try again',
        author_user_id: RUN,
      } as TranscriptEvent,
      {
        ...envelope,
        kind: 'compaction',
        seq: 3,
        phase: 'pre',
        pre_tokens: 100,
        post_tokens: 20,
      } as TranscriptEvent,
      { ...envelope, kind: 'system', seq: 4, subtype: 'init', data: {} } as TranscriptEvent,
      {
        ...envelope,
        kind: 'result',
        seq: 5,
        terminal_reason: 'success',
        num_turns: 2,
        duration_ms: 100,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_write_5m_tokens: 0,
          cache_write_1h_tokens: 0,
          cache_read_tokens: 0,
        },
        model_usage: [],
        cost: { usd: 0.5, is_estimate: true },
      } as TranscriptEvent,
    ]);

    expect(blocks.map((block) => block.kind)).toEqual([
      'hook',
      'steer',
      'compaction',
      'system',
      'result',
    ]);
    expect(blocks[4]).toMatchObject({ costUsd: 0.5, isEstimate: true });
  });

  it('gives every block a distinct key', () => {
    const blocks = toBlocks([
      assistant(1, [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ] as never),
      assistant(2, [{ type: 'text', text: 'c' }] as never),
    ]);
    expect(new Set(blocks.map((block) => block.id)).size).toBe(blocks.length);
  });
});

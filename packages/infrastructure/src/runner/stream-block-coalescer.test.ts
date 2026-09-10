import type { SDKPartialAssistantMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { createStreamBlockCoalescer } from './stream-block-coalescer.js';

const partial = (event: Record<string, unknown>, parent: string | null = null) =>
  ({
    type: 'stream_event',
    event,
    parent_tool_use_id: parent,
    uuid: 'u',
    session_id: 's',
  }) as unknown as SDKPartialAssistantMessage;

const AT_1 = '2026-03-01T09:00:00.000Z';
const AT_2 = '2026-03-01T09:00:01.000Z';
const AT_3 = '2026-03-01T09:00:02.000Z';

describe('coalescing text', () => {
  it('emits one block when the block stops, and nothing before that', () => {
    const coalescer = createStreamBlockCoalescer();
    expect(coalescer.accept(partial({ type: 'message_start', message: {} }), AT_1)).toHaveLength(0);
    expect(
      coalescer.accept(
        partial({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }),
        AT_1,
      ),
    ).toHaveLength(0);
    expect(
      coalescer.accept(
        partial({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'he' },
        }),
        AT_2,
      ),
    ).toHaveLength(0);
    coalescer.accept(
      partial({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'llo' },
      }),
      AT_3,
    );
    const [block] = coalescer.accept(partial({ type: 'content_block_stop', index: 0 }), AT_3);
    expect(block).toEqual({
      block_index: 0,
      block: { type: 'text', text: 'hello' },
      first_delta_at: AT_1,
      last_delta_at: AT_3,
      parent_tool_use_id: null,
    });
  });

  it('keeps the two timestamps a UI needs to replay typing', () => {
    const coalescer = createStreamBlockCoalescer();
    coalescer.accept(
      partial({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
      AT_1,
    );
    coalescer.accept(
      partial({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } }),
      AT_3,
    );
    const [block] = coalescer.accept(partial({ type: 'content_block_stop', index: 0 }), AT_3);
    expect(block?.first_delta_at).toBe(AT_1);
    expect(block?.last_delta_at).toBe(AT_3);
  });
});

describe('coalescing tool use', () => {
  it('reassembles the input from `input_json_delta` fragments', () => {
    const coalescer = createStreamBlockCoalescer();
    coalescer.accept(
      partial({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_9', name: 'Bash', input: {} },
      }),
      AT_1,
    );
    for (const fragment of ['{"comm', 'and":"git ', 'status"}']) {
      coalescer.accept(
        partial({
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: fragment },
        }),
        AT_2,
      );
    }
    const [block] = coalescer.accept(partial({ type: 'content_block_stop', index: 1 }), AT_2);
    expect(block?.block).toEqual({
      type: 'tool_use',
      tool_use_id: 'toolu_9',
      tool_name: 'Bash',
      input: { command: 'git status' },
    });
  });

  it('keeps truncated JSON as text rather than throwing away the block', () => {
    const coalescer = createStreamBlockCoalescer();
    coalescer.accept(
      partial({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 't', name: 'Bash' },
      }),
      AT_1,
    );
    coalescer.accept(
      partial({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"command":"git st' },
      }),
      AT_1,
    );
    const [block] = coalescer.accept(partial({ type: 'content_block_stop', index: 0 }), AT_1);
    expect(block?.block).toMatchObject({
      type: 'tool_use',
      input: { _truncated_json: '{"command":"git st' },
    });
  });
});

describe('blocks that never stop', () => {
  it('flushes on `message_stop`, in block order', () => {
    const coalescer = createStreamBlockCoalescer();
    for (const index of [1, 0]) {
      coalescer.accept(
        partial({ type: 'content_block_start', index, content_block: { type: 'text' } }),
        AT_1,
      );
      coalescer.accept(
        partial({
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text: `block-${index}` },
        }),
        AT_2,
      );
    }
    const blocks = coalescer.accept(partial({ type: 'message_stop' }), AT_3);
    expect(blocks.map((block) => block.block_index)).toEqual([0, 1]);
  });

  it('flushes on demand, so an interrupted run keeps the words the model had written', () => {
    const coalescer = createStreamBlockCoalescer();
    coalescer.accept(
      partial({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
      AT_1,
    );
    coalescer.accept(
      partial({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'half a sen' },
      }),
      AT_2,
    );
    const [block] = coalescer.flush();
    expect(block?.block).toEqual({ type: 'text', text: 'half a sen' });
    expect(coalescer.flush()).toHaveLength(0);
  });

  it('starts a block for a delta whose `content_block_start` was never seen', () => {
    const coalescer = createStreamBlockCoalescer();
    coalescer.accept(
      partial({
        type: 'content_block_delta',
        index: 4,
        delta: { type: 'thinking_delta', thinking: 'orphan' },
      }),
      AT_1,
    );
    const [block] = coalescer.accept(partial({ type: 'content_block_stop', index: 4 }), AT_2);
    expect(block?.block).toEqual({ type: 'thinking', thinking: 'orphan' });
  });

  it('ignores a stop for an index that is not open', () => {
    const coalescer = createStreamBlockCoalescer();
    expect(coalescer.accept(partial({ type: 'content_block_stop', index: 7 }), AT_1)).toHaveLength(
      0,
    );
  });
});

describe('subagent nesting', () => {
  it('carries the parent tool use id onto the block', () => {
    const coalescer = createStreamBlockCoalescer();
    coalescer.accept(
      partial(
        { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        'toolu_parent',
      ),
      AT_1,
    );
    const [block] = coalescer.accept(
      partial({ type: 'content_block_stop', index: 0 }, 'toolu_parent'),
      AT_1,
    );
    expect(block?.parent_tool_use_id).toBe('toolu_parent');
  });
});

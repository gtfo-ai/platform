/**
 * Partial deltas → one `stream_block` row per content block (TD-007).
 *
 * > "one coalesced `stream_block` row per content block with `first_delta_at/last_delta_at` in
 * > payload; partial deltas are never stored individually."
 *
 * `includePartialMessages: true` makes the SDK emit an `SDKPartialAssistantMessage` for every
 * Messages-API streaming event. A thousand-token answer is a thousand of them; storing each would
 * put a row-per-keystroke into a partitioned, append-only table (research/07 measured ~1–2 MB per
 * run *with* coalescing). So the deltas are folded here and only the finished block is written,
 * with the two timestamps a UI needs to replay typing.
 *
 * The coalescer is a state machine over one session's stream and is deliberately forgiving: a
 * `content_block_delta` for an index that never opened starts a block, and a `message_stop` (or the
 * next `message_start`) flushes whatever is still open. Both happen for real — an interrupt lands
 * mid-block, and `SDKAssistantMessage.aborted` exists precisely because a stream can end mid-word —
 * and losing the partial text would lose the only record of what the model was saying when it was
 * stopped.
 */
import type { SDKPartialAssistantMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ContentBlock, IsoDateTime } from '@platform/contracts';
import { normaliseContentBlock } from './transcript-normaliser.js';

export interface CoalescedBlock {
  readonly block_index: number;
  readonly block: ContentBlock;
  readonly first_delta_at: IsoDateTime;
  readonly last_delta_at: IsoDateTime;
  readonly parent_tool_use_id: string | null;
}

interface OpenBlock {
  index: number;
  firstDeltaAt: IsoDateTime;
  lastDeltaAt: IsoDateTime;
  parentToolUseId: string | null;
  /** The `content_block_start` block, which carries the tool id and name for a `tool_use`. */
  seed: Record<string, unknown>;
  text: string;
  thinking: string;
  partialJson: string;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * Rebuilds the finished block.
 *
 * `input_json_delta` fragments are concatenated and parsed once. A stream cut mid-object leaves
 * invalid JSON, and an empty object is stored rather than throwing: the tool call never ran, and a
 * transcript writer that throws on truncated input turns a stopped run into a lost one.
 */
const seal = (open: OpenBlock): ContentBlock => {
  const type = asString(open.seed['type']);
  if (type === 'thinking' || type === 'redacted_thinking') {
    return { type: 'thinking', thinking: open.thinking };
  }
  if (type === 'tool_use' || type === 'server_tool_use' || type === 'mcp_tool_use') {
    let input: unknown = {};
    if (open.partialJson.length > 0) {
      try {
        input = JSON.parse(open.partialJson);
      } catch {
        input = { _truncated_json: open.partialJson };
      }
    }
    return normaliseContentBlock({ ...open.seed, input });
  }
  if (type === '' && open.thinking.length > 0) {
    return { type: 'thinking', thinking: open.thinking };
  }
  return { type: 'text', text: open.text.length > 0 ? open.text : asString(open.seed['text']) };
};

const toBlock = (open: OpenBlock): CoalescedBlock => ({
  block_index: open.index,
  block: seal(open),
  first_delta_at: open.firstDeltaAt,
  last_delta_at: open.lastDeltaAt,
  parent_tool_use_id: open.parentToolUseId,
});

export interface StreamBlockCoalescer {
  /** Folds one partial message in; returns the blocks that finished because of it. */
  accept(message: SDKPartialAssistantMessage, at: IsoDateTime): readonly CoalescedBlock[];
  /** Flushes every still-open block — used when the run ends without a `message_stop`. */
  flush(): readonly CoalescedBlock[];
}

export const createStreamBlockCoalescer = (): StreamBlockCoalescer => {
  const open = new Map<number, OpenBlock>();

  const drain = (): readonly CoalescedBlock[] => {
    const blocks = [...open.values()].sort((a, b) => a.index - b.index).map(toBlock);
    open.clear();
    return blocks;
  };

  const ensure = (
    index: number,
    at: IsoDateTime,
    parentToolUseId: string | null,
    seed: Record<string, unknown>,
  ): OpenBlock => {
    const existing = open.get(index);
    if (existing !== undefined) {
      return existing;
    }
    const created: OpenBlock = {
      index,
      firstDeltaAt: at,
      lastDeltaAt: at,
      parentToolUseId,
      seed,
      text: '',
      thinking: '',
      partialJson: '',
    };
    open.set(index, created);
    return created;
  };

  return {
    flush: drain,
    accept: (message, at) => {
      const event = asRecord(message.event);
      const type = asString(event['type']);
      const index = typeof event['index'] === 'number' ? event['index'] : -1;
      const parent = message.parent_tool_use_id ?? null;

      if (type === 'message_start') {
        return drain();
      }
      if (type === 'content_block_start') {
        ensure(index, at, parent, asRecord(event['content_block']));
        return [];
      }
      if (type === 'content_block_delta') {
        const delta = asRecord(event['delta']);
        const block = ensure(index, at, parent, {});
        block.lastDeltaAt = at;
        const deltaType = asString(delta['type']);
        if (deltaType === 'text_delta') {
          block.text += asString(delta['text']);
        } else if (deltaType === 'thinking_delta') {
          block.thinking += asString(delta['thinking']);
        } else if (deltaType === 'input_json_delta') {
          block.partialJson += asString(delta['partial_json']);
        }
        return [];
      }
      if (type === 'content_block_stop') {
        const block = open.get(index);
        if (block === undefined) {
          return [];
        }
        block.lastDeltaAt = at;
        open.delete(index);
        return [toBlock(block)];
      }
      if (type === 'message_stop') {
        return drain();
      }
      return [];
    },
  };
};

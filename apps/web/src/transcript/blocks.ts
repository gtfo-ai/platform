/**
 * `TranscriptEvent[]` → render blocks (technical/09 § "Transcript model").
 *
 * A pure function, which is the point: the reducer is the part of the run screen with real logic
 * in it, and a pure reducer can be tested against golden event sequences without a DOM, a clock or
 * a network. Nothing here renders; `renderers.tsx` decides what a block looks like.
 *
 * ### Four decisions
 *
 * **Deduplication is by `seq`, and it happens here as well as in the store.** SSE replay is
 * positional (`hub.ts`: "find the buffered frame whose `seq` equals the cursor and send everything
 * after it"), and a reconnect whose cursor the client held from *before* a REST page was fetched
 * will re-deliver rows the page already had. Making the reducer total over a list with repeats
 * means the screen cannot double-render a tool call because two paths delivered it.
 *
 * **A tool result is folded into the tool call it answers**, matched on `tool_use_id`. technical/04
 * emits them as two entries — an `assistant` message with a `tool_use` block, then a `user` message
 * with a `tool_result` block — and showing them as two cards separated by whatever else happened in
 * between is how a transcript becomes unreadable.
 *
 * **Sub-agent entries nest.** Every transcript entry carries `parent_tool_use_id` when it belongs
 * to a subagent's session, so an entry with one goes into the `children` of the tool block that
 * started it. An entry whose parent is not (yet) known stays at the top level rather than being
 * dropped — a missing parent is a gap in what has been delivered, not a reason to hide content.
 *
 * **Streaming blocks are pending until the message that contains them arrives.** `stream_block`
 * carries `block_index` and *nothing that identifies the assistant message it belongs to*, so a
 * client cannot tell a partial of the current message from a partial of the previous one except by
 * order. The rule taken here: pending stream blocks belong to the next `assistant` message, and
 * that message replaces them. Recorded as Q47.
 */
import type { ContentBlock, TranscriptEvent } from '@platform/contracts';

export interface BlockBase {
  readonly id: string;
  readonly seq: number;
}

export interface TextBlock extends BlockBase {
  readonly kind: 'text';
  readonly text: string;
  /** True while this is the block the model is still writing. */
  readonly streaming: boolean;
}

export interface ThinkingBlock extends BlockBase {
  readonly kind: 'thinking';
  readonly text: string;
  readonly streaming: boolean;
}

export interface ToolBlock extends BlockBase {
  readonly kind: 'tool';
  readonly toolUseId: string;
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly result: { readonly isError: boolean; readonly content: string } | null;
  readonly children: readonly TranscriptBlock[];
}

export interface UserBlock extends BlockBase {
  readonly kind: 'user';
  readonly text: string;
}

export interface HookBlock extends BlockBase {
  readonly kind: 'hook';
  readonly hook: string;
  readonly toolName: string | null;
  readonly decision: string | null;
  readonly reason: string | null;
  readonly questionId: string | null;
}

export interface SteerBlock extends BlockBase {
  readonly kind: 'steer';
  readonly message: string;
  readonly authorUserId: string;
}

export interface CompactionBlock extends BlockBase {
  readonly kind: 'compaction';
  readonly phase: 'pre' | 'post';
  readonly preTokens: number | null;
  readonly postTokens: number | null;
}

export interface SystemBlock extends BlockBase {
  readonly kind: 'system';
  readonly subtype: string;
  readonly model: string | null;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface ResultBlock extends BlockBase {
  readonly kind: 'result';
  readonly terminalReason: string;
  readonly numTurns: number;
  readonly durationMs: number;
  readonly costUsd: number;
  readonly isEstimate: boolean;
}

export type TranscriptBlock =
  | TextBlock
  | ThinkingBlock
  | ToolBlock
  | UserBlock
  | HookBlock
  | SteerBlock
  | CompactionBlock
  | SystemBlock
  | ResultBlock;

/** Mutable twin of `ToolBlock`, used while the result and the children are still arriving. */
interface ToolDraft {
  block: {
    kind: 'tool';
    id: string;
    seq: number;
    toolUseId: string;
    toolName: string;
    input: Readonly<Record<string, unknown>>;
    result: { isError: boolean; content: string } | null;
    children: TranscriptBlock[];
  };
}

const nullish = <T>(value: T | null | undefined): T | null => value ?? null;

const contentToBlocks = (
  content: readonly ContentBlock[],
  seq: number,
  streaming: boolean,
): { blocks: TranscriptBlock[]; tools: ToolDraft[] } => {
  const blocks: TranscriptBlock[] = [];
  const tools: ToolDraft[] = [];
  content.forEach((item, index) => {
    const id = `${seq}:${index}`;
    switch (item.type) {
      case 'text':
        blocks.push({ kind: 'text', id, seq, text: item.text, streaming });
        break;
      case 'thinking':
        blocks.push({ kind: 'thinking', id, seq, text: item.thinking, streaming });
        break;
      case 'tool_use': {
        const draft: ToolDraft = {
          block: {
            kind: 'tool',
            id,
            seq,
            toolUseId: item.tool_use_id,
            toolName: item.tool_name,
            input: item.input,
            result: null,
            children: [],
          },
        };
        tools.push(draft);
        blocks.push(draft.block as unknown as ToolBlock);
        break;
      }
      case 'tool_result':
        // Handled by the caller, which knows which tool draft to attach it to.
        break;
    }
  });
  return { blocks, tools };
};

/** Sorted, deduplicated, and total over any list — including one with gaps and repeats. */
export const normaliseEvents = (events: readonly TranscriptEvent[]): TranscriptEvent[] => {
  const bySeq = new Map<number, TranscriptEvent>();
  for (const event of events) {
    // Last write wins: a replayed row and a live frame with the same `seq` are the same row.
    bySeq.set(event.seq, event);
  }
  return [...bySeq.values()].sort((left, right) => left.seq - right.seq);
};

export const toBlocks = (events: readonly TranscriptEvent[]): TranscriptBlock[] => {
  const ordered = normaliseEvents(events);
  const top: TranscriptBlock[] = [];
  const drafts = new Map<string, ToolDraft>();
  /** Coalesced partials waiting for the assistant message that will replace them. */
  let pending = new Map<number, { block: ContentBlock; seq: number }>();

  const sink = (event: TranscriptEvent): TranscriptBlock[] => {
    const parent = event.parent_tool_use_id;
    if (typeof parent === 'string' && parent !== '') {
      const draft = drafts.get(parent);
      if (draft !== undefined) {
        return draft.block.children;
      }
    }
    return top;
  };

  const flushPending = (): void => {
    if (pending.size === 0) {
      return;
    }
    const entries = [...pending.entries()].sort(([left], [right]) => left - right);
    for (const [index, { block, seq }] of entries) {
      const { blocks, tools } = contentToBlocks([block], seq, true);
      for (const tool of tools) {
        drafts.set(tool.block.toolUseId, tool);
      }
      for (const item of blocks) {
        top.push({ ...item, id: `${seq}:stream:${index}` } as TranscriptBlock);
      }
    }
    pending = new Map();
  };

  for (const event of ordered) {
    switch (event.kind) {
      case 'stream_block':
        pending.set(event.block_index, { block: event.block, seq: event.seq });
        break;

      case 'assistant': {
        // The completed message supersedes the partials that produced it.
        pending = new Map();
        const target = sink(event);
        const { blocks, tools } = contentToBlocks(event.content, event.seq, false);
        for (const tool of tools) {
          drafts.set(tool.block.toolUseId, tool);
        }
        target.push(...blocks);
        break;
      }

      case 'user': {
        const target = sink(event);
        event.content.forEach((item, index) => {
          if (item.type === 'tool_result') {
            const draft = drafts.get(item.tool_use_id);
            if (draft !== undefined) {
              draft.block.result = { isError: item.is_error, content: item.content };
              return;
            }
            // A result whose call was never delivered: show it rather than swallow it.
            target.push({
              kind: 'user',
              id: `${event.seq}:${index}`,
              seq: event.seq,
              text: item.content,
            });
            return;
          }
          if (item.type === 'text') {
            target.push({
              kind: 'user',
              id: `${event.seq}:${index}`,
              seq: event.seq,
              text: item.text,
            });
          }
        });
        break;
      }

      case 'hook':
        sink(event).push({
          kind: 'hook',
          id: `${event.seq}`,
          seq: event.seq,
          hook: event.hook,
          toolName: nullish(event.tool_name),
          decision: nullish(event.decision),
          reason: nullish(event.reason),
          questionId: nullish(event.question_id),
        });
        break;

      case 'steer':
        sink(event).push({
          kind: 'steer',
          id: `${event.seq}`,
          seq: event.seq,
          message: event.message,
          authorUserId: event.author_user_id,
        });
        break;

      case 'compaction':
        sink(event).push({
          kind: 'compaction',
          id: `${event.seq}`,
          seq: event.seq,
          phase: event.phase,
          preTokens: nullish(event.pre_tokens),
          postTokens: nullish(event.post_tokens),
        });
        break;

      case 'system':
        sink(event).push({
          kind: 'system',
          id: `${event.seq}`,
          seq: event.seq,
          subtype: event.subtype,
          model: nullish(event.model),
          data: event.data,
        });
        break;

      case 'result':
        sink(event).push({
          kind: 'result',
          id: `${event.seq}`,
          seq: event.seq,
          terminalReason: event.terminal_reason,
          numTurns: event.num_turns,
          durationMs: event.duration_ms,
          costUsd: event.cost.usd,
          isEstimate: event.cost.is_estimate,
        });
        break;
    }
  }

  flushPending();
  return top;
};

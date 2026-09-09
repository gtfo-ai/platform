import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PROPERTY_TEST_TIMEOUT_MS } from './testing/property.js';
import {
  contentBlockSchema,
  type TranscriptEvent,
  type TranscriptKind,
  transcriptEventSchema,
  transcriptKindSchema,
} from './transcript.js';

const uuid = (n: number) => `0199aa11-2b3c-7d4e-8f90-${String(n).padStart(12, '0')}`;
const RUN = uuid(1);
const AT = '2026-09-09T10:15:30Z';

const envelope = {
  run_id: RUN,
  created_at: AT,
  parent_tool_use_id: null,
  redaction_count: 0,
};

const usage = {
  input_tokens: 1200,
  output_tokens: 340,
  cache_write_5m_tokens: 0,
  cache_write_1h_tokens: 0,
  cache_read_tokens: 900,
};

const BY_KIND: Record<TranscriptKind, TranscriptEvent> = {
  system: {
    ...envelope,
    seq: 0,
    kind: 'system',
    subtype: 'init',
    session_id: 'sess_FAKE_0001',
    model: 'claude-opus-5',
    data: { cwd: '/workspace', permission_mode: 'default' },
  },
  assistant: {
    ...envelope,
    seq: 1,
    kind: 'assistant',
    model: 'claude-opus-5',
    content: [
      { type: 'text', text: 'Reading the plan.' },
      {
        type: 'tool_use',
        tool_use_id: 'toolu_1',
        tool_name: 'Read',
        input: { path: 'src/pay.ts' },
      },
    ],
  },
  user: {
    ...envelope,
    seq: 2,
    kind: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'toolu_1', is_error: false, content: 'export const…' },
    ],
  },
  stream_block: {
    ...envelope,
    seq: 3,
    kind: 'stream_block',
    block_index: 0,
    block: { type: 'thinking', thinking: 'The lock is outside the transaction.' },
    first_delta_at: AT,
    last_delta_at: AT,
  },
  hook: {
    ...envelope,
    seq: 4,
    kind: 'hook',
    hook: 'PreToolUse',
    tool_name: 'Bash',
    tool_use_id: 'toolu_2',
    decision: 'ask',
    reason: 'npm install is on the ask list',
    question_id: uuid(2),
  },
  steer: {
    ...envelope,
    seq: 5,
    kind: 'steer',
    message: 'use the existing helper',
    author_user_id: uuid(3),
  },
  compaction: {
    ...envelope,
    seq: 6,
    kind: 'compaction',
    phase: 'pre',
    pre_tokens: 140_000,
    post_tokens: null,
  },
  result: {
    ...envelope,
    seq: 7,
    kind: 'result',
    terminal_reason: 'success',
    num_turns: 24,
    duration_ms: 120_000,
    usage,
    model_usage: [{ ...usage, model: 'claude-opus-5', usd: 1.25 }],
    cost: { usd: 1.25, is_estimate: false, price_list_id: uuid(4) },
    structured_output: { verdict: 'approve', findings: [] },
  },
};

const FIXTURES = Object.values(BY_KIND);

describe('TranscriptEvent', () => {
  it('covers every run_messages kind from technical/03', () => {
    expect(Object.keys(BY_KIND).sort()).toEqual([...transcriptKindSchema.options].sort());
  });

  it.each(FIXTURES.map((event) => [event.kind, event] as const))(
    'round-trips a %s entry unchanged',
    (_kind, event) => {
      expect(transcriptEventSchema.parse(event)).toEqual(event);
    },
  );

  it('rejects an unknown kind', () => {
    expect(transcriptEventSchema.safeParse({ ...BY_KIND.system, kind: 'telepathy' }).success).toBe(
      false,
    );
  });

  it(
    'rejects an unknown key on any entry',
    () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...FIXTURES),
          fc.string({ minLength: 1, maxLength: 12 }),
          (event, key) => {
            fc.pre(!(key in event));
            expect(transcriptEventSchema.safeParse({ ...event, [key]: 1 }).success).toBe(false);
          },
        ),
      );
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );

  it('keeps the sequence monotonic and non-negative', () => {
    expect(transcriptEventSchema.safeParse({ ...BY_KIND.system, seq: -1 }).success).toBe(false);
    expect(transcriptEventSchema.safeParse({ ...BY_KIND.system, seq: 1.5 }).success).toBe(false);
  });

  it('nests a subagent entry under the tool use that spawned it', () => {
    const nested = { ...BY_KIND.assistant, parent_tool_use_id: 'toolu_agent_1' };
    expect(transcriptEventSchema.parse(nested)).toEqual(nested);
  });

  it('requires the redaction count, so a transcript can never claim it was never scanned', () => {
    const withoutCount: Record<string, unknown> = { ...BY_KIND.assistant };
    delete withoutCount.redaction_count;
    expect(transcriptEventSchema.safeParse(withoutCount).success).toBe(false);
  });

  it('accepts only the terminal reasons the runner can produce', () => {
    expect(
      transcriptEventSchema.safeParse({
        ...BY_KIND.result,
        terminal_reason: 'error_max_budget_usd',
      }).success,
    ).toBe(true);
    expect(
      transcriptEventSchema.safeParse({ ...BY_KIND.result, terminal_reason: 'gave_up' }).success,
    ).toBe(false);
  });

  it('models each content block kind', () => {
    expect(contentBlockSchema.parse({ type: 'text', text: '' })).toEqual({
      type: 'text',
      text: '',
    });
    expect(contentBlockSchema.safeParse({ type: 'image', url: 'x' }).success).toBe(false);
    expect(
      contentBlockSchema.safeParse({ type: 'tool_use', tool_use_id: 't', tool_name: 'Bash' })
        .success,
    ).toBe(false);
  });
});

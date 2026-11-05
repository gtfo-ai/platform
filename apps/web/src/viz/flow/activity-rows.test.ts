/**
 * The stage dialog's "Live activity" rows and log lines (S-23.5), from the transcript reducer's own
 * blocks: one row per tool call, per thinking burst and per burst of text, the newest one `current`
 * while the run is live; a log line per tool call with its argument summary, the tail of its output
 * and the model's text — the run's words kept as data, never interpreted.
 */
import type { TranscriptEvent } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { type TranscriptBlock, toBlocks } from '../../transcript/blocks.js';
import {
  ACTIVITY_ROW_LIMIT,
  ARGUMENT_SUMMARY_CHARS,
  activityRows,
  argumentSummary,
  clockTime,
  LOG_LINE_LIMIT,
  logLines,
  OUTPUT_TAIL_LINES,
} from './activity-rows.js';

const envelope = {
  run_id: '11111111-1111-4111-8111-111111111111',
  created_at: '2026-11-05T16:39:00.000Z',
  redaction_count: 0,
} as const;

const assistant = (seq: number, content: unknown[]): TranscriptEvent =>
  ({ ...envelope, kind: 'assistant', seq, model: 'claude-opus-5', content }) as TranscriptEvent;

const result = (seq: number, id: string, content: string, isError = false): TranscriptEvent =>
  ({
    ...envelope,
    kind: 'user',
    seq,
    content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content }],
  }) as TranscriptEvent;

const HOSTILE = '<img src=x onerror=alert(1)> \u001B[31mred\u001B[0m';

const blocks = toBlocks([
  assistant(1, [{ type: 'thinking', thinking: 'plan the change' }]),
  assistant(2, [{ type: 'thinking', thinking: 'still planning' }]),
  assistant(3, [
    { type: 'text', text: 'Reading the retry helper.' },
    { type: 'tool_use', tool_use_id: 'read', tool_name: 'Read', input: { file_path: 'src/a.ts' } },
  ]),
  result(4, 'read', 'export const a = 1;'),
  assistant(5, [
    {
      type: 'tool_use',
      tool_use_id: 'bash',
      tool_name: 'Bash',
      input: { command: `pnpm test ${HOSTILE}` },
    },
  ]),
  result(6, 'bash', Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n'), true),
  assistant(7, [{ type: 'text', text: 'first' }]),
  assistant(8, [{ type: 'text', text: `second\n${HOSTILE}` }]),
  assistant(9, [
    { type: 'tool_use', tool_use_id: 'edit', tool_name: 'Edit', input: { file_path: 'src/a.ts' } },
  ]),
]);

const hook: TranscriptBlock = {
  kind: 'hook',
  id: '10:hook',
  seq: 10,
  at: '2026-11-05T16:42:00.000Z',
  hook: 'PreToolUse',
  toolName: 'Bash',
  decision: 'ask',
  reason: null,
  questionId: null,
};

describe('the "Live activity" rows', () => {
  it('is one row per tool call and per burst, labelled in the vocabulary', () => {
    const rows = activityRows(blocks, { live: false });
    expect(rows.map((row) => [row.label, row.state])).toEqual([
      ['Thinking', 'done'],
      ['Writing', 'done'],
      ['Reading files', 'done'],
      ['Running a command', 'error'],
      ['Writing', 'done'],
      ['Editing code', 'done'],
    ]);
  });

  it('marks the newest row current while the run is live, and never a failed one', () => {
    const live = activityRows(blocks, { live: true });
    expect(live.at(-1)).toMatchObject({ label: 'Editing code', state: 'current' });
    expect(live.filter((row) => row.state === 'current')).toHaveLength(1);
    const failedLast = activityRows(blocks.slice(0, 5), { live: true });
    expect(failedLast.at(-1)).toMatchObject({ label: 'Running a command', state: 'error' });
  });

  it('shows a permission ask as needing you, and passes over what says nothing', () => {
    const steer: TranscriptBlock = {
      kind: 'steer',
      id: '11:steer',
      seq: 11,
      at: hook.at,
      message: 'look at b.ts',
      authorUserId: 'u',
    };
    const rows = activityRows([...blocks, hook, steer], { live: true });
    expect(rows.at(-1)).toMatchObject({
      label: 'Waiting for permission',
      state: 'needs_you',
      activity: 'needs_you',
    });
    expect(rows).toHaveLength(7);
  });

  it('keeps the newest rows only', () => {
    const many = toBlocks(
      Array.from({ length: ACTIVITY_ROW_LIMIT + 5 }, (_, index) =>
        assistant(index + 1, [
          { type: 'tool_use', tool_use_id: `t${index}`, tool_name: 'Grep', input: {} },
        ]),
      ),
    );
    const rows = activityRows(many, { live: false });
    expect(rows).toHaveLength(ACTIVITY_ROW_LIMIT);
    expect(rows[0]?.key).toBe('6:0');
  });

  it('times a row in English clock time', () => {
    expect(clockTime('2026-11-05T16:39:00.000Z')).toMatch(/^\d{1,2}:39\s?[AP]M$/);
    expect(clockTime('not a date')).toBe('');
  });
});

describe('the log', () => {
  const lines = logLines(blocks);

  it('puts each tool call on one line with its argument, and the tail of its output', () => {
    const calls = lines.filter((line) => line.tone === 'command');
    expect(calls.map((line) => `${line.prefix}${line.text}`)).toEqual([
      '› Read src/a.ts',
      `$ pnpm test <img src=x onerror=alert(1)> \u001B[31mred\u001B[0m`,
      '› Edit src/a.ts',
    ]);
    const errors = lines.filter((line) => line.tone === 'error').map((line) => line.text);
    expect(errors).toHaveLength(OUTPUT_TAIL_LINES);
    expect(errors.at(-1)).toBe('line 20');
    expect(errors[0]).toBe(`line ${20 - OUTPUT_TAIL_LINES + 1}`);
  });

  it('keeps the model’s text as lines of data — markup and ANSI included, for the renderer', () => {
    const text = lines.filter((line) => line.tone === 'text').map((line) => line.text);
    expect(text).toEqual(['Reading the retry helper.', 'first', 'second', HOSTILE]);
    expect(lines.find((line) => line.prefix === '… thinking')).toBeDefined();
  });

  it('keeps the newest lines only', () => {
    const many = toBlocks(
      Array.from({ length: LOG_LINE_LIMIT + 3 }, (_, index) =>
        assistant(index + 1, [{ type: 'text', text: `t${index}` }]),
      ),
    );
    const kept = logLines(many);
    expect(kept).toHaveLength(LOG_LINE_LIMIT);
    expect(kept[0]?.text).toBe('t3');
  });
});

describe('argumentSummary', () => {
  it('reads the key that says most, collapses whitespace and cuts a long one', () => {
    expect(argumentSummary({ command: 'ls\n  -la' })).toBe('ls -la');
    expect(argumentSummary({ description: 'x', file_path: 'a.ts' })).toBe('a.ts');
    expect(argumentSummary({ other: 1 })).toBe('{"other":1}');
    expect(argumentSummary({})).toBe('');
    const long = argumentSummary({ command: 'x'.repeat(500) });
    expect(long).toHaveLength(ARGUMENT_SUMMARY_CHARS);
    expect(long.endsWith('…')).toBe(true);
    // An inherited name is not a key the input has.
    expect(
      argumentSummary(Object.create({ command: 'inherited' }) as Record<string, unknown>),
    ).toBe('');
  });
});

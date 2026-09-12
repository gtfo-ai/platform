/**
 * The `run_messages` writer, at the level a database cannot show: **which column gets what**.
 *
 * The row really reaching PostgreSQL is asserted by `test/e2e/pipeline/agent-run.e2e.test.ts`, which
 * reads the rows back out of a real instance. What that tier cannot say is why a column is null — a
 * `subtype` that is null because the entry has none and a `subtype` the mapping forgot look the same
 * in a table — so the mapping is pinned here, on the entry kinds that have something to map.
 */
import type { TranscriptEvent } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { FIXTURE_RUN_ID } from './fixtures.js';
import { createPostgresTranscriptSink, runMessageRowFor } from './postgres-transcript-sink.js';

const AT = '2026-09-12T10:00:00.000Z';

const envelope = { run_id: FIXTURE_RUN_ID, created_at: AT, redaction_count: 0 } as const;

const assistant = (text: string, seq = 0): TranscriptEvent => ({
  ...envelope,
  seq,
  kind: 'assistant',
  model: 'claude-opus-5',
  content: [{ type: 'text', text }],
});

/** A `SqlExecutor` that records what it was asked to run. */
const recordingSql = (rowCount = 1) => {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    query: async <R extends Record<string, unknown>>(text: string, values?: unknown[]) => {
      calls.push({ text, values: values ?? [] });
      return { rows: [] as R[], rowCount };
    },
  };
};

describe('the row a transcript entry becomes', () => {
  it('stores the whole event as the payload, so a reader needs no reassembly', () => {
    const event = assistant('hello');
    const row = runMessageRowFor(event);
    expect(JSON.parse(row.payload)).toEqual(event);
    // And the columns beside it are indexes into that document, not a second copy of the shape.
    expect(row).toMatchObject({
      runId: FIXTURE_RUN_ID,
      seq: 0,
      createdAt: AT,
      kind: 'assistant',
      subtype: null,
      searchText: 'hello',
      redactionCount: 0,
    });
  });

  it('keeps seq zero-based, which is what migration 0016 is about', () => {
    // The producer's first entry is `seq: 0` (`claude-runner.ts` stamps then increments) and
    // `0006_transcripts.sql` constrained `seq >= 1`. Translating here instead would make the stored
    // `seq` and the SSE cursor for the same entry differ by one.
    expect(runMessageRowFor(assistant('first', 0)).seq).toBe(0);
  });

  it('counts bytes rather than characters, because that is what an operator is asking', () => {
    const ascii = runMessageRowFor(assistant('aaaa'));
    const wide = runMessageRowFor(assistant('ああああ'));
    expect(wide.sizeBytes).toBeGreaterThan(ascii.sizeBytes);
    expect(wide.sizeBytes).toBe(Buffer.byteLength(wide.payload, 'utf8'));
  });

  it('copies the redaction count rather than computing one', () => {
    // TD-012 runs in the runner's single `append` door; a second pass here would double-count, and a
    // pass *instead of* the runner's would happen after the event had been broadcast.
    const row = runMessageRowFor({ ...assistant('x'), redaction_count: 3 });
    expect(row.redactionCount).toBe(3);
  });

  it('fills the subtype for a system entry and leaves it null everywhere else', () => {
    const system: TranscriptEvent = {
      ...envelope,
      seq: 1,
      kind: 'system',
      subtype: 'init',
      session_id: 's1',
      model: 'claude-opus-5',
      data: {},
    };
    expect(runMessageRowFor(system).subtype).toBe('init');
    expect(runMessageRowFor(assistant('x')).subtype).toBeNull();
  });

  it('records the tool identity only where the entry has exactly one', () => {
    const hook: TranscriptEvent = {
      ...envelope,
      seq: 2,
      kind: 'hook',
      hook: 'PreToolUse',
      tool_name: 'Bash',
      tool_use_id: 'toolu_01',
      decision: 'allow',
      reason: null,
      question_id: null,
    };
    expect(runMessageRowFor(hook)).toMatchObject({ toolUseId: 'toolu_01', toolName: 'Bash' });

    const block: TranscriptEvent = {
      ...envelope,
      seq: 3,
      kind: 'stream_block',
      block_index: 0,
      block: { type: 'tool_use', tool_use_id: 'toolu_02', tool_name: 'Read', input: {} },
      first_delta_at: AT,
      last_delta_at: AT,
    };
    expect(runMessageRowFor(block)).toMatchObject({ toolUseId: 'toolu_02', toolName: 'Read' });

    // An assistant message may carry several `tool_use` blocks and the column is singular, so it
    // stays null rather than picking one of them — the blocks are in `payload` either way.
    const many: TranscriptEvent = {
      ...envelope,
      seq: 4,
      kind: 'assistant',
      model: 'claude-opus-5',
      content: [
        { type: 'tool_use', tool_use_id: 'a', tool_name: 'Bash', input: {} },
        { type: 'tool_use', tool_use_id: 'b', tool_name: 'Read', input: {} },
      ],
    };
    expect(runMessageRowFor(many)).toMatchObject({ toolUseId: null, toolName: null });
  });

  it('bounds the search text and leaves it null when there is none', () => {
    const long = runMessageRowFor(assistant('x'.repeat(20_000)), { maxSearchTextChars: 100 });
    expect(long.searchText).toHaveLength(100);
    const compaction: TranscriptEvent = {
      ...envelope,
      seq: 5,
      kind: 'compaction',
      phase: 'pre',
      pre_tokens: null,
      post_tokens: null,
    };
    expect(runMessageRowFor(compaction).searchText).toBeNull();
  });
});

describe('the insert', () => {
  it('names every column the row carries, in one statement', async () => {
    const sql = recordingSql();
    await createPostgresTranscriptSink({ sql }).append(assistant('hello'));
    expect(sql.calls).toHaveLength(1);
    const [call] = sql.calls;
    expect(call?.text).toContain('insert into run_messages');
    // Absorbed: the one insert error that is not a fault is the same entry arriving twice, which a
    // resumed session can produce. Everything else propagates and fails the run.
    expect(call?.text).toContain('on conflict do nothing');
    expect(call?.values).toHaveLength(12);
    expect(call?.values[0]).toBe(FIXTURE_RUN_ID);
    expect(call?.values[1]).toBe(0);
  });

  it('does not throw when the entry was already stored', async () => {
    const sql = recordingSql(0);
    await expect(
      createPostgresTranscriptSink({ sql }).append(assistant('hello')),
    ).resolves.toBeUndefined();
  });

  it('lets a real failure out, because a hole in the transcript is not a success', async () => {
    const sink = createPostgresTranscriptSink({
      sql: {
        query: async () => {
          throw new Error('connection terminated');
        },
      },
    });
    await expect(sink.append(assistant('hello'))).rejects.toThrow('connection terminated');
  });
});

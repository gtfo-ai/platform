/**
 * `RunTranscriptSink` on PostgreSQL — the first thing in this repository that ever wrote
 * `run_messages` (WP-15g).
 *
 * ## Read this before trusting anything about the transcript
 *
 * `run_messages` was created by `0006_transcripts.sql` at WP-06. The runner has produced
 * `TranscriptEvent`s since WP-12, the contracts have described the rows since WP-01, the UI has a
 * renderer, and **no production code wrote a row until this file**: every green result about a
 * transcript came from `recordingSink()` or from the e2e's `{ append: async () => {} }`. That is
 * standing rule 82's family, and the first thing writing exposed was that the table's own
 * constraint contradicted the producer — `seq >= 1` against a producer that starts at 0 — which
 * migration `0016` fixes with the reasoning written out. A table nothing writes is a table nobody
 * has checked.
 *
 * ## What one row holds, and why `payload` is the whole event
 *
 * `payload` is the entire `TranscriptEvent`, envelope included, so a reader can parse a row's
 * payload with `transcriptEventSchema` and get back exactly what the runner produced — no
 * reassembly from columns, and no second definition of the shape. The columns beside it
 * (`kind`, `subtype`, `tool_use_id`, `tool_name`, `search_text`) are *indexes into* that document,
 * which is what technical/03 uses them for: a GIN index on the search vector and a partial index on
 * `tool_use_id`.
 *
 * ## Three decisions
 *
 *  1. **Already redacted, and this file adds no redaction.** TD-012 runs in the runner's single
 *     `append` door — exact match of the run's injected secrets, then the pattern rules — and
 *     `redaction_count` arrives on the event. A second pass here would double-count, and a pass
 *     *instead of* the runner's would be applied after the event had already been broadcast.
 *     `redaction_count` is therefore copied, never computed: it is the audit's claim about what the
 *     runner replaced, and the e2e asserts it in both directions (a planted secret absent, a
 *     control string present), because a sink that redacted nothing and a sink that had nothing to
 *     redact look identical from one side.
 *  2. **A duplicate entry is absorbed; any other failure fails the run.** `on conflict do nothing`
 *     covers the one insert error that is not a fault — the same `(run_id, seq)` arriving twice,
 *     which a resumed session can produce — and nothing else is caught. A transcript row that
 *     cannot be written is a hole in the platform's own record of what an agent did, and a run that
 *     carried on regardless would be a run whose audit is quietly incomplete. The runner awaits
 *     `append`, so the throw ends the run through its own failure path.
 *  3. **The SSE half of TD-007 is not here, and that is stated rather than implied.** The port's
 *     docblock says a transcript entry goes to `run_messages` *plus* the `run:<id>` SSE topic.
 *     Nothing bridges that topic to `SseHub` yet, and it cannot be a `NOTIFY` payload: broadcasts
 *     are capped at 7 000 bytes and carry hints, so the receiving instance is expected to read the
 *     rows back (`ports/broadcast.ts`, `sse/hub.ts:169`) — which is what these rows finally make
 *     possible. Publishing a hint nothing consumes would be a collaborator with no consumer
 *     (standing rule 31's shape), so it is left to the work package that adds the reader.
 */
import type { Logger, RunTranscriptSink } from '@platform/application';
import { silentLogger } from '@platform/application';
import type { TranscriptEvent } from '@platform/contracts';
import type { SqlExecutor } from '../events/sql.js';

export interface PostgresTranscriptSinkOptions {
  /** A pool or a client; the insert is a single round trip. */
  readonly sql: SqlExecutor;
  readonly logger?: Logger;
  /**
   * Cap on `search_text`, in characters.
   *
   * The column feeds a `tsvector` that is stored on every row, so it is the one derived value whose
   * size the platform chooses rather than inherits. 8 000 characters is about two screens of model
   * text and well under the 1 MB `tsvector` limit even after tokenisation; the *payload* is bounded
   * upstream instead, by `toolOutputMaxChars` on tool results (10 000 characters head and tail,
   * technical/04) and by the SDK's own message sizes.
   */
  readonly maxSearchTextChars?: number;
}

const DEFAULT_MAX_SEARCH_TEXT_CHARS = 8_000;

/** One `run_messages` row, as this adapter writes it. Exported so the mapping is unit-testable. */
export interface RunMessageRow {
  readonly runId: string;
  readonly seq: number;
  readonly createdAt: string;
  readonly kind: string;
  readonly subtype: string | null;
  readonly parentToolUseId: string | null;
  readonly toolUseId: string | null;
  readonly toolName: string | null;
  readonly payload: string;
  readonly searchText: string | null;
  readonly sizeBytes: number;
  readonly redactionCount: number;
}

/** The text blocks of a content-carrying entry, in order, for the search vector. */
const textOfBlocks = (event: TranscriptEvent): string[] => {
  const blocks =
    'content' in event && Array.isArray(event.content)
      ? event.content
      : 'block' in event
        ? [event.block]
        : [];
  return blocks.flatMap((block) => {
    switch (block.type) {
      case 'text':
        return [block.text];
      case 'thinking':
        return [block.thinking];
      case 'tool_result':
        return [block.content];
      case 'tool_use':
        return [block.tool_name];
      default:
        return [];
    }
  });
};

/**
 * The tool identity of an entry, for technical/03's partial index.
 *
 * Only the kinds that have **one** — a `hook` row is about a single tool call, and a `stream_block`
 * is one content block. An assistant message may carry several `tool_use` blocks and the column is
 * singular, so it stays null there rather than picking one of them arbitrarily; the blocks are in
 * `payload` either way.
 */
const toolIdentityOf = (
  event: TranscriptEvent,
): { toolUseId: string | null; toolName: string | null } => {
  if (event.kind === 'hook') {
    return { toolUseId: event.tool_use_id ?? null, toolName: event.tool_name ?? null };
  }
  if (event.kind === 'stream_block' && event.block.type === 'tool_use') {
    return { toolUseId: event.block.tool_use_id, toolName: event.block.tool_name };
  }
  if (event.kind === 'stream_block' && event.block.type === 'tool_result') {
    return { toolUseId: event.block.tool_use_id, toolName: null };
  }
  return { toolUseId: null, toolName: null };
};

/**
 * `TranscriptEvent` → a `run_messages` row. Pure, so the mapping is asserted without a database.
 *
 * `size_bytes` is the byte length of the stored document rather than a character count: it is what
 * an operator reading the table is asking about (how much of the disk a run's transcript took), and
 * a UTF-8 character count would understate it for exactly the content — non-ASCII model output —
 * where the answer matters.
 */
export const runMessageRowFor = (
  event: TranscriptEvent,
  options: { readonly maxSearchTextChars?: number } = {},
): RunMessageRow => {
  const payload = JSON.stringify(event);
  const limit = options.maxSearchTextChars ?? DEFAULT_MAX_SEARCH_TEXT_CHARS;
  const searchText = textOfBlocks(event).join('\n').slice(0, limit);
  const { toolUseId, toolName } = toolIdentityOf(event);
  return {
    runId: event.run_id,
    seq: event.seq,
    createdAt: event.created_at,
    kind: event.kind,
    subtype: event.kind === 'system' ? event.subtype : null,
    parentToolUseId: event.parent_tool_use_id ?? null,
    toolUseId,
    toolName,
    payload,
    searchText: searchText.length === 0 ? null : searchText,
    sizeBytes: Buffer.byteLength(payload, 'utf8'),
    redactionCount: event.redaction_count,
  };
};

export const createPostgresTranscriptSink = (
  options: PostgresTranscriptSinkOptions,
): RunTranscriptSink => {
  const logger = options.logger ?? silentLogger;
  return {
    append: async (event: TranscriptEvent): Promise<void> => {
      const row = runMessageRowFor(event, {
        ...(options.maxSearchTextChars === undefined
          ? {}
          : { maxSearchTextChars: options.maxSearchTextChars }),
      });
      const { rowCount } = await options.sql.query(
        `insert into run_messages
           (run_id, seq, created_at, kind, subtype, parent_tool_use_id, tool_use_id, tool_name,
            payload, search_text, size_bytes, redaction_count)
         values ($1, $2, $3::timestamptz, $4::transcript_kind, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)
         on conflict do nothing`,
        [
          row.runId,
          row.seq,
          row.createdAt,
          row.kind,
          row.subtype,
          row.parentToolUseId,
          row.toolUseId,
          row.toolName,
          row.payload,
          row.searchText,
          row.sizeBytes,
          row.redactionCount,
        ],
      );
      if (rowCount === 0) {
        // Not an error — see decision 2 — but not silent either: a run that re-appends an entry is
        // either a resume or a bug in the runner's `seq`, and both are worth a line.
        logger.debug(
          { run_id: row.runId, seq: row.seq, kind: row.kind },
          'a transcript entry with this sequence number is already stored; keeping the first',
        );
      }
    },
  };
};

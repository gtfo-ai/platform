/**
 * SDK message → `TranscriptEvent` (technical/04 § "Streaming and steering", TD-007).
 *
 * Everything the CLI emits is normalised here into the closed union `@platform/contracts` defines,
 * appended to `run_messages` and broadcast on the `run:<id>` SSE topic. TD-007 asks for golden
 * fixtures around exactly this function "because SDK message types evolve"; they live in
 * `test/fixtures/claude/`.
 *
 * Two rules govern the mapping.
 *
 * **The union is closed and the SDK's is not.** `SDKMessage` has thirty-odd members and grows every
 * release; `TranscriptEvent` has eight kinds. A message this module does not recognise becomes a
 * `system` entry carrying its payload rather than being dropped — an unrecognised message is still
 * audit material (BD-003), and dropping it would make the transcript quietly lossy at exactly the
 * moment the SDK changed under us.
 *
 * **Content is data.** Model text, tool output and hook reasons are copied, never interpreted
 * (BD-022). Nothing here parses a command, follows a path or evaluates a string; the one place a
 * value is read at all is `tool_use.input`, which is passed through as opaque JSON.
 *
 * Structural narrowing rather than the SDK's own block types is deliberate: the block union is
 * `@anthropic-ai/sdk`'s, it is a transitive peer dependency here, and a normaliser that fails to
 * compile when a block type is added is worse than one that renders it as an unsupported marker.
 */
import type {
  SDKAssistantMessage,
  SDKCompactBoundaryMessage,
  SDKMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  ContentBlock,
  IsoDateTime,
  JsonObject,
  ModelUsage,
  RunTerminalReason,
  TokenUsage,
  TranscriptEvent,
} from '@platform/contracts';

/** The envelope every transcript row carries (technical/03 `run_messages`). */
export interface TranscriptEnvelope {
  readonly run_id: string;
  readonly seq: number;
  readonly created_at: IsoDateTime;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * `tool_result.content` on the wire is a string, or an array of blocks, or a structured object.
 * The transcript stores one string per result because that is what a human reads and what the FTS
 * column indexes (technical/03 `search_text`).
 */
const renderToolResultContent = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        const record = asRecord(item);
        const text = record === null ? null : asString(record['text']);
        return text ?? JSON.stringify(item);
      })
      .join('\n');
  }
  return value === undefined ? '' : JSON.stringify(value);
};

/**
 * One Anthropic content block → the four shapes technical/12 allows.
 *
 * An unknown block type becomes a text marker naming it. Images, documents and server-tool blocks
 * genuinely have no place in a text transcript, and the marker keeps the block *count* honest, so a
 * reader sees that something was there.
 */
export const normaliseContentBlock = (value: unknown): ContentBlock => {
  const block = asRecord(value);
  const type = block === null ? null : asString(block['type']);
  if (block === null || type === null) {
    return { type: 'text', text: '[unreadable content block]' };
  }
  switch (type) {
    case 'text':
      return { type: 'text', text: asString(block['text']) ?? '' };
    case 'thinking':
      return { type: 'thinking', thinking: asString(block['thinking']) ?? '' };
    case 'redacted_thinking':
      return { type: 'thinking', thinking: '[redacted thinking]' };
    case 'tool_use':
    case 'server_tool_use':
    case 'mcp_tool_use':
      return {
        type: 'tool_use',
        tool_use_id: asString(block['id']) ?? 'unknown',
        tool_name: asString(block['name']) ?? 'unknown',
        input: (asRecord(block['input']) ?? {}) as JsonObject,
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: asString(block['tool_use_id']) ?? 'unknown',
        is_error: block['is_error'] === true,
        content: renderToolResultContent(block['content']),
      };
    default:
      return { type: 'text', text: `[unsupported content block: ${type}]` };
  }
};

const normaliseContent = (value: unknown): ContentBlock[] => {
  if (typeof value === 'string') {
    return [{ type: 'text', text: value }];
  }
  return Array.isArray(value) ? value.map(normaliseContentBlock) : [];
};

// ── usage and cost ───────────────────────────────────────────────────────────

/**
 * Every count the CLI reports, read the only way an untrusted producer's numbers may be read:
 * absent, `null`, a string, `NaN`, `Infinity` and a negative are all "no number was reported",
 * which is `0` for a count. `typeof value === 'number'` alone is not the check — `NaN` passes it,
 * and `NaN` compares `false` against every ceiling.
 *
 * It is **exported** because `RunOutcome` carries one of these numbers too. `num_turns` is declared
 * non-optional in the SDK's types and passed through unvalidated, so a `result` line without it
 * used to put `undefined` on a `number` field — and a `"7"` reached `RunOutcome.numTurns` as a
 * string over the JSON wire. Standing rule 16: a guard against an untrusted producer must not read
 * a field that producer can omit, and from WP-13 on the producer is `agentic-runlet`.
 */
export const reportedCount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;

/**
 * The same hygiene for money: absent, `null`, a string, `NaN`, `Infinity` and a negative are all
 * "no number was reported", which is `null` here and never `0`.
 *
 * `typeof value === 'number'` alone is not the check — `NaN` passes it. That is not a hypothetical
 * about a well-behaved CLI: `total_cost_usd` is declared non-optional in the SDK's types and passed
 * through **unvalidated**, and WP-13's `agentic-runlet` is the untrusted producer of this stream.
 * The distinction between `null` and `0` is load-bearing: {@link reportedCostUsd}'s caller in
 * `claude-runner.ts` stops the run on `null`, because a budget guard that cannot see the cost has
 * not verified the budget.
 */
export const reportedCostUsd = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/** The transcript column is `numeric not null`, so an unreported cost is stored as zero. */
const usd = (value: unknown): number => reportedCostUsd(value) ?? 0;

/**
 * `NonNullableUsage` → `TokenUsage`.
 *
 * The 5-minute / 1-hour split lives in `usage.cache_creation`; older producers send only the total
 * in `cache_creation_input_tokens`, and technical/03 has a column for each TTL because they are
 * priced differently (BD-011). When only the total is available it is attributed to the 5-minute
 * bucket — the SDK's own default TTL — which is recorded here because it is a pricing decision made
 * by a missing field rather than by anyone.
 */
export const normaliseUsage = (value: unknown): TokenUsage => {
  const usage = asRecord(value) ?? {};
  const creation = asRecord(usage['cache_creation']);
  const total = reportedCount(usage['cache_creation_input_tokens']);
  const write5m = creation === null ? total : reportedCount(creation['ephemeral_5m_input_tokens']);
  const write1h = creation === null ? 0 : reportedCount(creation['ephemeral_1h_input_tokens']);
  return {
    input_tokens: reportedCount(usage['input_tokens']),
    output_tokens: reportedCount(usage['output_tokens']),
    cache_write_5m_tokens: write5m,
    cache_write_1h_tokens: write1h,
    cache_read_tokens: reportedCount(usage['cache_read_input_tokens']),
  };
};

/**
 * `result.modelUsage` → one `run_model_usage` row per model (technical/03).
 *
 * The SDK's per-model record has a single `cacheCreationInputTokens` with no TTL split, while the
 * run-level `usage` does have one. So: when the run used exactly one model, the run-level split is
 * authoritative and is used verbatim; with several models the per-model total is attributed to the
 * 5-minute bucket, because dividing one split across several models would be an invention. The
 * second branch under-prices 1-hour cache writes in a multi-model run and is left visible here for
 * the cost ledger (WP-19) rather than hidden behind an average.
 */
export const normaliseModelUsage = (
  modelUsage: unknown,
  runUsage: TokenUsage,
): readonly ModelUsage[] => {
  const record = asRecord(modelUsage) ?? {};
  const entries = Object.entries(record);
  const single = entries.length === 1;
  return entries.map(([model, value]) => {
    const usage = asRecord(value) ?? {};
    const creation = reportedCount(usage['cacheCreationInputTokens']);
    return {
      model,
      input_tokens: reportedCount(usage['inputTokens']),
      output_tokens: reportedCount(usage['outputTokens']),
      cache_write_5m_tokens: single ? runUsage.cache_write_5m_tokens : creation,
      cache_write_1h_tokens: single ? runUsage.cache_write_1h_tokens : 0,
      cache_read_tokens: reportedCount(usage['cacheReadInputTokens']),
      // `typeof … === 'number'` would admit `NaN`, which `usdSchema` (`.finite()`) then rejects —
      // and the rejection lands on the whole `result` row, not on this field.
      usd: usd(usage['costUSD']),
    };
  });
};

/**
 * `result.subtype` → `runs.terminal_reason`.
 *
 * The four error subtypes map one to one (verified against `SDKResultError` in the installed
 * declarations). Two platform-side readings sit on top:
 *
 *  - a `success` result with `is_error` set is the CLI reporting an API failure inside a completed
 *    turn, which is `error_during_execution` and not a success;
 *  - an `error_during_execution` that carries permission denials is reported as `permission_denied`,
 *    because that is what a reader needs to see and the SDK has no subtype for it.
 */
export const terminalReasonOf = (result: SDKResultMessage): RunTerminalReason => {
  if (result.subtype === 'success') {
    return result.is_error ? 'error_during_execution' : 'success';
  }
  if (result.subtype === 'error_during_execution' && result.permission_denials.length > 0) {
    return 'permission_denied';
  }
  return result.subtype;
};

// ── message → transcript entry ───────────────────────────────────────────────

const systemEntry = (
  envelope: TranscriptEnvelope,
  subtype: string,
  data: JsonObject,
  extras: { model?: string | null; sessionId?: string | null } = {},
): TranscriptEvent => ({
  ...envelope,
  kind: 'system',
  redaction_count: 0,
  subtype,
  session_id: extras.sessionId ?? null,
  model: extras.model ?? null,
  data,
});

const initEntry = (envelope: TranscriptEnvelope, message: SDKSystemMessage): TranscriptEvent =>
  systemEntry(
    envelope,
    'init',
    {
      cwd: message.cwd,
      tools: message.tools,
      mcp_servers: message.mcp_servers,
      skills: message.skills,
      slash_commands: message.slash_commands,
      permission_mode: message.permissionMode,
      api_key_source: message.apiKeySource,
      claude_code_version: message.claude_code_version,
      output_style: message.output_style,
      agents: message.agents ?? [],
    },
    { model: message.model, sessionId: message.session_id },
  );

const compactionEntry = (
  envelope: TranscriptEnvelope,
  message: SDKCompactBoundaryMessage,
): TranscriptEvent => ({
  ...envelope,
  kind: 'compaction',
  redaction_count: 0,
  parent_tool_use_id: null,
  phase: 'post',
  pre_tokens: reportedCount(message.compact_metadata.pre_tokens),
  post_tokens:
    message.compact_metadata.post_tokens === undefined
      ? null
      : reportedCount(message.compact_metadata.post_tokens),
});

const assistantEntry = (
  envelope: TranscriptEnvelope,
  message: SDKAssistantMessage,
): TranscriptEvent => ({
  ...envelope,
  kind: 'assistant',
  redaction_count: 0,
  parent_tool_use_id: message.parent_tool_use_id,
  model: asString((message.message as { model?: unknown }).model) ?? 'unknown',
  content: normaliseContent((message.message as { content?: unknown }).content),
});

const userEntry = (envelope: TranscriptEnvelope, message: SDKUserMessage): TranscriptEvent => ({
  ...envelope,
  kind: 'user',
  redaction_count: 0,
  parent_tool_use_id: message.parent_tool_use_id,
  content: normaliseContent((message.message as { content?: unknown }).content),
});

const resultEntry = (envelope: TranscriptEnvelope, message: SDKResultMessage): TranscriptEvent => {
  const usage = normaliseUsage(message.usage);
  return {
    ...envelope,
    kind: 'result',
    redaction_count: 0,
    terminal_reason: terminalReasonOf(message),
    num_turns: reportedCount(message.num_turns),
    duration_ms: reportedCount(message.duration_ms),
    usage,
    model_usage: [...normaliseModelUsage(message.modelUsage, usage)],
    // Not `Math.max(0, total_cost_usd)`: `Math.max(0, undefined)` is `NaN`, `usdSchema` refuses it,
    // and the `result` row the pipeline reads is then replaced by a `transcript_normalisation_failed`
    // row — a loud signal on a different row from the one anybody reads. The run still ends: the
    // adapter's own watchdog reads the same field and stops it (`claude-runner.ts`).
    cost: { usd: usd(message.total_cost_usd), is_estimate: false, price_list_id: null },
    structured_output: message.subtype === 'success' ? (message.structured_output ?? null) : null,
  };
};

/**
 * The one entry point. Returns `null` for messages the platform deliberately does not store: the
 * partial `stream_event` frames, which TD-007 forbids storing individually and which
 * `StreamBlockCoalescer` turns into one `stream_block` row per content block instead.
 */
export const normaliseMessage = (
  message: SDKMessage,
  envelope: TranscriptEnvelope,
): TranscriptEvent | null => {
  switch (message.type) {
    case 'assistant':
      return assistantEntry(envelope, message);
    case 'user':
      return userEntry(envelope, message as SDKUserMessage);
    case 'result':
      return resultEntry(envelope, message);
    case 'stream_event':
      return null;
    case 'system':
      if (message.subtype === 'init') {
        return initEntry(envelope, message);
      }
      if (message.subtype === 'compact_boundary') {
        return compactionEntry(envelope, message);
      }
      return systemEntry(envelope, message.subtype, systemPayload(message), {
        sessionId: 'session_id' in message ? message.session_id : null,
      });
    default:
      return systemEntry(envelope, unknownSubtype(message), systemPayload(message));
  }
};

/** Everything but the envelope fields, so an unrecognised message keeps its payload. */
const systemPayload = (message: SDKMessage): JsonObject => {
  const record = asRecord(message) ?? {};
  const { type: _type, uuid: _uuid, session_id: _sessionId, subtype: _subtype, ...rest } = record;
  return rest as JsonObject;
};

const unknownSubtype = (message: SDKMessage): string => {
  const record = asRecord(message) ?? {};
  return asString(record['subtype']) ?? asString(record['type']) ?? 'unknown';
};

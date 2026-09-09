/**
 * `TranscriptEvent` — the normalised, redacted form of everything a run emits.
 *
 * Sources: docs/technical/04-agent-runtime.md § "Streaming and steering" and § "Result handling",
 * docs/technical/03-data-model.md § "Transcripts" (`run_messages`), docs/technical/08 § "SSE
 * contract".
 *
 * The runner maps each Agent SDK message onto exactly one of these and appends it to
 * `run_messages` with a monotonic `seq`; the same value is broadcast on the `run:<id>` SSE topic.
 * One row per completed SDK message, plus one coalesced `stream_block` per content block — partial
 * deltas are never stored individually (technical/03).
 *
 * Everything in here has already passed the redaction path (TD-012) and is untrusted content
 * (BD-022): tool output, model text and hook reasons are rendered, never executed.
 */
import * as z from 'zod';
import {
  idSchema,
  isoDateTimeSchema,
  modelUsageSchema,
  nonEmptyStringSchema,
  runCostSchema,
  runTerminalReasonSchema,
  sequenceSchema,
  tokenCountSchema,
  tokenUsageSchema,
} from './common.js';
import { jsonObjectSchema, jsonValueSchema } from './records.js';

/** `run_messages.kind` (technical/03). */
export const transcriptKindSchema = z.enum([
  'system',
  'assistant',
  'user',
  'result',
  'stream_block',
  'hook',
  'steer',
  'compaction',
]);

/** Hooks the runner installs (technical/04 § "Hooks and policies"). */
export const hookNameSchema = z.enum([
  'PreToolUse',
  'PostToolUse',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'Stop',
  'UserPromptSubmit',
  'PostModelSwitch',
]);

/** Outcome of the three-list command policy and `canUseTool` (BD-025). */
export const toolDecisionSchema = z.enum(['allow', 'ask', 'deny']);

/** A content block inside an assistant message. */
export const contentBlockSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), text: z.string() }),
  z.strictObject({ type: z.literal('thinking'), thinking: z.string() }),
  z.strictObject({
    type: z.literal('tool_use'),
    tool_use_id: nonEmptyStringSchema,
    tool_name: nonEmptyStringSchema,
    input: jsonObjectSchema,
  }),
  z.strictObject({
    type: z.literal('tool_result'),
    tool_use_id: nonEmptyStringSchema,
    is_error: z.boolean(),
    /** Truncated head/tail by the `PostToolUse` hook before it ever reaches here. */
    content: z.string(),
  }),
]);

const transcriptEnvelopeShape = {
  run_id: idSchema,
  seq: sequenceSchema,
  created_at: isoDateTimeSchema,
  /** Set when the entry belongs to a subagent's nested session (technical/04). */
  parent_tool_use_id: nonEmptyStringSchema.nullish(),
  /** Number of values the redaction path replaced in this entry (TD-012). */
  redaction_count: z.int().nonnegative(),
} as const;

const defineTranscript = <TKind extends string, TShape extends z.ZodRawShape>(
  kind: TKind,
  shape: TShape,
) => z.strictObject({ ...transcriptEnvelopeShape, kind: z.literal(kind), ...shape });

/** SDK `system` messages: session init, model switches, warnings. */
export const transcriptSystemEvent = defineTranscript('system', {
  subtype: nonEmptyStringSchema,
  session_id: nonEmptyStringSchema.nullish(),
  model: nonEmptyStringSchema.nullish(),
  data: jsonObjectSchema,
});

export const transcriptAssistantEvent = defineTranscript('assistant', {
  model: nonEmptyStringSchema,
  content: z.array(contentBlockSchema),
});

/** Tool results and user turns injected by the platform. */
export const transcriptUserEvent = defineTranscript('user', {
  content: z.array(contentBlockSchema),
});

/** The SDK `result` message, the run's terminal record (technical/04 § "Result handling"). */
export const transcriptResultEvent = defineTranscript('result', {
  terminal_reason: runTerminalReasonSchema,
  num_turns: z.int().nonnegative(),
  duration_ms: z.int().nonnegative(),
  usage: tokenUsageSchema,
  model_usage: z.array(modelUsageSchema),
  cost: runCostSchema,
  /** The artifact `data`, revalidated against the artifact schema by the platform. */
  structured_output: jsonValueSchema.nullish(),
});

/**
 * One content block coalesced from its partial deltas (≥ 50 ms, TD-014). `first_delta_at` and
 * `last_delta_at` let the UI reconstruct typing without storing every delta.
 */
export const transcriptStreamBlockEvent = defineTranscript('stream_block', {
  block_index: z.int().nonnegative(),
  block: contentBlockSchema,
  first_delta_at: isoDateTimeSchema,
  last_delta_at: isoDateTimeSchema,
});

export const transcriptHookEvent = defineTranscript('hook', {
  hook: hookNameSchema,
  tool_name: nonEmptyStringSchema.nullish(),
  tool_use_id: nonEmptyStringSchema.nullish(),
  decision: toolDecisionSchema.nullish(),
  reason: z.string().nullish(),
  /** Set when an `ask` decision opened a platform Question (technical/04 `canUseTool`). */
  question_id: idSchema.nullish(),
});

export const transcriptSteerEvent = defineTranscript('steer', {
  message: nonEmptyStringSchema,
  author_user_id: idSchema,
});

/** Compaction boundaries are first-class transcript entries (technical/04). */
export const transcriptCompactionEvent = defineTranscript('compaction', {
  phase: z.enum(['pre', 'post']),
  pre_tokens: tokenCountSchema.nullish(),
  post_tokens: tokenCountSchema.nullish(),
});

/** Everything a run emits, discriminated on `kind`. */
export const transcriptEventSchema = z.discriminatedUnion('kind', [
  transcriptSystemEvent,
  transcriptAssistantEvent,
  transcriptUserEvent,
  transcriptResultEvent,
  transcriptStreamBlockEvent,
  transcriptHookEvent,
  transcriptSteerEvent,
  transcriptCompactionEvent,
]);

export type TranscriptEvent = z.infer<typeof transcriptEventSchema>;
export type TranscriptKind = z.infer<typeof transcriptKindSchema>;
export type TranscriptEventOfKind<K extends TranscriptKind> = Extract<TranscriptEvent, { kind: K }>;
export type ContentBlock = z.infer<typeof contentBlockSchema>;
export type HookName = z.infer<typeof hookNameSchema>;
export type ToolDecision = z.infer<typeof toolDecisionSchema>;

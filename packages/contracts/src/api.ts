/**
 * HTTP and SSE DTOs — docs/technical/08-api-and-realtime.md.
 *
 * REST + SSE on one origin; OpenAPI is generated from these route schemas at WP-06, and the SPA
 * client from the OpenAPI document. Every mutating endpoint is a command with an imperative name.
 *
 * Request bodies are strict: an unknown key is a client bug and is reported as one rather than
 * being dropped. Query DTOs are strict too, so a mistyped filter cannot silently widen a result
 * set.
 */
import * as z from 'zod';
import { artifactRefSchema, artifactSchema } from './artifacts.js';
import {
  agentRoleSchema,
  autonomyLevelSchema,
  effortSchema,
  idSchema,
  integrationTypeSchema,
  isoDateTimeSchema,
  nonEmptyStringSchema,
  pathPatternSchema,
  sequenceSchema,
  severitySchema,
  stageIdSchema,
  taskModeSchema,
  taskStateSchema,
  templateIdSchema,
  unitIntervalSchema,
  urlSchema,
  usdSchema,
  userRoleSchema,
} from './common.js';
import { agenticConfigSchema } from './config.js';
import { domainEventSchema, domainEventTypeSchema } from './events.js';
import {
  approvalRecordSchema,
  budgetRecordSchema,
  configSourceSchema,
  contextPackRecordSchema,
  jsonObjectSchema,
  knowledgeProposalRecordSchema,
  projectRecordSchema,
  questionRecordSchema,
  runRecordSchema,
  taskRecordSchema,
} from './records.js';
import { transcriptEventSchema } from './transcript.js';

// ── Envelopes ────────────────────────────────────────────────────────────────

/** Problem shape returned by every non-2xx response. */
export const apiErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/, 'expected a lower_snake_case machine-readable error code'),
    message: nonEmptyStringSchema,
    /** Field-level detail, e.g. the zod issue list of a rejected body. */
    details: z.array(z.strictObject({ path: z.string(), message: z.string() })).optional(),
  }),
});

/** Opaque cursor pagination; `next_cursor` is null on the last page. */
export const paginationQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: nonEmptyStringSchema.optional(),
});

const page = <T extends z.ZodType>(item: T) =>
  z.strictObject({ items: z.array(item), next_cursor: nonEmptyStringSchema.nullable() });

// ── Org, users, integrations ─────────────────────────────────────────────────

export const versionResponseSchema = z.strictObject({
  version: nonEmptyStringSchema,
  commit: nonEmptyStringSchema.nullable(),
  built_at: isoDateTimeSchema.nullable(),
});

export const healthResponseSchema = z.strictObject({
  status: z.enum(['ok', 'degraded', 'down']),
  checks: z.record(z.string(), z.enum(['ok', 'degraded', 'down'])),
});

export const userSummarySchema = z.strictObject({
  id: idSchema,
  email: z.email(),
  name: nonEmptyStringSchema.nullable(),
  role: userRoleSchema,
  status: z.enum(['active', 'invited', 'disabled']),
});

export const inviteUserRequestSchema = z.strictObject({
  email: z.email(),
  role: userRoleSchema,
});

export const integrationSummarySchema = z.strictObject({
  id: idSchema,
  type: integrationTypeSchema,
  provider: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  /** Non-secret configuration only; secret values never leave the server (technical/03). */
  config: jsonObjectSchema,
  health: z.strictObject({
    status: z.enum(['ok', 'degraded', 'down', 'unknown']),
    checked_at: isoDateTimeSchema.nullable(),
    detail: z.string().nullable(),
  }),
});

export const createIntegrationRequestSchema = z.strictObject({
  type: integrationTypeSchema,
  provider: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  config: jsonObjectSchema,
  /** Names of secrets to read from the environment or the secret store — never values. */
  secret_refs: z.array(nonEmptyStringSchema).optional(),
});

export const testIntegrationResponseSchema = z.strictObject({
  ok: z.boolean(),
  checks: z.array(
    z.strictObject({ name: nonEmptyStringSchema, ok: z.boolean(), detail: z.string() }),
  ),
});

// ── Projects and configuration ───────────────────────────────────────────────

/**
 * `GET /api/projects/:id/config` — the effective configuration with per-key provenance
 * (technical/12 § "Effective configuration"). `sources` is keyed by dotted config path.
 */
export const effectiveConfigResponseSchema = z.strictObject({
  config: agenticConfigSchema,
  sources: z.record(z.string(), configSourceSchema),
  hash: nonEmptyStringSchema,
  computed_at: isoDateTimeSchema,
});

export const updateProjectConfigRequestSchema = z.strictObject({
  config: agenticConfigSchema,
  /** Optimistic concurrency: the hash the client last read. */
  base_hash: nonEmptyStringSchema.optional(),
});

export const projectSummarySchema = projectRecordSchema.extend({
  open_tasks: z.int().nonnegative(),
  spent_usd_30d: usdSchema,
});

export const readinessResponseSchema = z.strictObject({
  level: z.int().min(0).max(5),
  evaluated_at: isoDateTimeSchema,
  criteria: z.array(
    z.strictObject({
      id: nonEmptyStringSchema,
      passed: z.boolean(),
      evidence: z.string(),
      unlocks: z.string(),
    }),
  ),
});

// ── Tasks ────────────────────────────────────────────────────────────────────

export const listTasksQuerySchema = paginationQuerySchema.extend({
  state: taskStateSchema.optional(),
  template: templateIdSchema.optional(),
  mode: taskModeSchema.optional(),
  stage: stageIdSchema.optional(),
});

export const createTaskRequestSchema = z.strictObject({
  ticket_key: nonEmptyStringSchema,
  template: templateIdSchema.optional(),
  mode: taskModeSchema.optional(),
});

export const taskDetailResponseSchema = z.strictObject({
  task: taskRecordSchema,
  stages: z.array(
    z.strictObject({
      stage: stageIdSchema,
      attempt: z.int().positive(),
      state: z.enum(['pending', 'running', 'completed', 'returned', 'skipped', 'failed']),
      entered_at: isoDateTimeSchema,
      exited_at: isoDateTimeSchema.nullable(),
      outcome: z.string().nullable(),
    }),
  ),
  artifacts: z.array(artifactRefSchema),
  questions: z.array(questionRecordSchema),
  approvals: z.array(approvalRecordSchema),
  runs: z.array(runRecordSchema),
});

export const pauseTaskRequestSchema = z.strictObject({ reason: z.string().optional() });
export const resumeTaskRequestSchema = z.strictObject({ reason: z.string().optional() });
export const cancelTaskRequestSchema = z.strictObject({ reason: z.string().optional() });
export const retryStageRequestSchema = z.strictObject({
  stage: stageIdSchema,
  reason: z.string().optional(),
});
export const returnToStageRequestSchema = z.strictObject({
  stage: stageIdSchema,
  reason: nonEmptyStringSchema,
});
export const takeOverRequestSchema = z.strictObject({ reason: z.string().optional() });
export const handBackRequestSchema = z.strictObject({
  stage: stageIdSchema,
  summary: nonEmptyStringSchema,
});
export const reworkRequestSchema = z.strictObject({
  stage: stageIdSchema,
  instructions: nonEmptyStringSchema,
});

export const answerQuestionRequestSchema = z.strictObject({
  answer: nonEmptyStringSchema,
  option: nonEmptyStringSchema.optional(),
});

export const decideApprovalRequestSchema = z.strictObject({
  decision: z.enum(['approve', 'reject']),
  reason: z.string().optional(),
});

export const submitFeedbackRequestSchema = z.strictObject({
  scope: z.enum(['task', 'stage', 'artifact', 'project']),
  text: nonEmptyStringSchema,
  rating: z.int().min(1).max(5).optional(),
  stage: stageIdSchema.optional(),
  artifact_id: idSchema.optional(),
});

/** `POST /api/tasks/:id/ask` — ask-the-task (WP-31). */
export const askTaskRequestSchema = z.strictObject({
  question: nonEmptyStringSchema,
});

export const taskExportResponseSchema = z.strictObject({
  task: taskRecordSchema,
  events: z.array(domainEventSchema),
  runs: z.array(runRecordSchema),
  artifacts: z.array(artifactSchema),
});

// ── Runs and transcripts ─────────────────────────────────────────────────────

export const runMessagesQuerySchema = z.strictObject({
  after: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  /** `?partials=0` suppresses coalesced `stream_block` entries (technical/08). */
  partials: z.enum(['0', '1']).optional(),
});

export const runMessagesResponseSchema = z.strictObject({
  items: z.array(transcriptEventSchema),
  next_seq: sequenceSchema.nullable(),
});

export const runPromptResponseSchema = z.strictObject({
  prompt_version: nonEmptyStringSchema,
  system_prompt: z.string(),
  user_prompt: z.string(),
});

export const runContextPackResponseSchema = contextPackRecordSchema;

export const steerRunRequestSchema = z.strictObject({
  message: nonEmptyStringSchema.max(10_000),
});

export const cancelRunRequestSchema = z.strictObject({ reason: z.string().optional() });

export const retryRunRequestSchema = z.strictObject({
  model: nonEmptyStringSchema.optional(),
  effort: effortSchema.optional(),
  budget_usd: usdSchema.optional(),
});

export const agentsResponseSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      run: runRecordSchema,
      project_id: idSchema,
      task_id: idSchema,
      role: agentRoleSchema,
      last_output_at: isoDateTimeSchema.nullable(),
    }),
  ),
});

// ── Inbox, budgets, knowledge ────────────────────────────────────────────────

export const inboxResponseSchema = z.strictObject({
  questions: z.array(questionRecordSchema),
  approvals: z.array(approvalRecordSchema),
});

export const putBudgetRequestSchema = z.strictObject({
  window: z.enum(['day', 'week', 'month', 'total']),
  limit_usd: usdSchema,
  notify_pct: z.array(z.int().min(1).max(100)).optional(),
});

export const budgetsResponseSchema = z.strictObject({ items: z.array(budgetRecordSchema) });

export const kbTreeResponseSchema = z.strictObject({
  commit_sha: nonEmptyStringSchema.nullable(),
  entries: z.array(
    z.strictObject({
      path: pathPatternSchema,
      kind: z.enum(['file', 'directory']),
      tokens: z.int().nonnegative().nullable(),
      updated_at: isoDateTimeSchema.nullable(),
    }),
  ),
});

export const kbDocResponseSchema = z.strictObject({
  path: pathPatternSchema,
  commit_sha: nonEmptyStringSchema.nullable(),
  frontmatter: jsonObjectSchema,
  content: z.string(),
});

export const putKbDocRequestSchema = z.strictObject({
  path: pathPatternSchema,
  content: z.string(),
  message: nonEmptyStringSchema.optional(),
});

export const kbSearchQuerySchema = paginationQuerySchema.extend({
  q: nonEmptyStringSchema,
});

export const kbSearchResponseSchema = page(
  z.strictObject({
    path: pathPatternSchema,
    heading_path: z.string(),
    excerpt: z.string(),
    score: unitIntervalSchema,
  }),
);

export const kbProposalsResponseSchema = page(knowledgeProposalRecordSchema);

export const decideKbProposalRequestSchema = z.strictObject({
  decision: z.enum(['approve', 'reject', 'edit']),
  reason: z.string().optional(),
  /** Present for `edit`: the replacement delta the maintainer accepted. */
  delta: z.string().optional(),
});

export const startShadowRunsRequestSchema = z.strictObject({
  ticket_keys: z.array(nonEmptyStringSchema).min(1).max(50),
  budget_usd: usdSchema,
});

export const setAutonomyRequestSchema = z.strictObject({
  autonomy: autonomyLevelSchema,
  /** An override above what readiness supports must say why (BD-027). */
  override_reason: z.string().optional(),
});

export const reviewOnlySettingsSchema = z.strictObject({
  enabled: z.boolean(),
  severity_floor: severitySchema,
});

// ── Real-time (SSE, TD-014) ──────────────────────────────────────────────────

/** Topic names: `org`, `project:<uuid>`, `task:<uuid>`, `run:<uuid>` (technical/08). */
export const sseTopicSchema = z
  .string()
  .regex(
    /^(org|(project|task|run):[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/,
    'expected "org" or "<project|task|run>:<uuid>"',
  );

/** Control frames the server sends alongside catalogue events (technical/08 § "SSE contract"). */
export const sseControlEventSchema = z.enum(['ping', 'reset', 'shutdown']);

/**
 * One SSE frame's `data`. `id:` on the wire is `<topic>:<seq>`; `event:` is either a catalogue
 * event type, a transcript kind, or a control name.
 */
export const sseFrameSchema = z.discriminatedUnion('frame', [
  z.strictObject({
    frame: z.literal('domain_event'),
    topic: sseTopicSchema,
    seq: sequenceSchema,
    type: domainEventTypeSchema,
    data: domainEventSchema,
  }),
  z.strictObject({
    frame: z.literal('transcript'),
    topic: sseTopicSchema,
    seq: sequenceSchema,
    data: transcriptEventSchema,
  }),
  z.strictObject({
    frame: z.literal('control'),
    topic: sseTopicSchema,
    type: sseControlEventSchema,
    /** `reset` tells the client its `Last-Event-ID` is older than the buffer; refetch. */
    detail: z.string().nullish(),
  }),
]);

export const eventsQuerySchema = z.strictObject({
  topics: z.string().min(1),
  partials: z.enum(['0', '1']).optional(),
});

export const updateSubscriptionsRequestSchema = z.strictObject({
  connection_id: nonEmptyStringSchema,
  add: z.array(sseTopicSchema).optional(),
  remove: z.array(sseTopicSchema).optional(),
});

// ── Webhooks ─────────────────────────────────────────────────────────────────

/** `POST /webhooks/:provider/:integrationId` — the row written to `inbox` (technical/03). */
export const webhookDeliverySchema = z.strictObject({
  provider: nonEmptyStringSchema,
  delivery_id: nonEmptyStringSchema,
  integration_id: idSchema,
  received_at: isoDateTimeSchema,
  headers: z.record(z.string(), z.string()),
  /** Untrusted, unparsed provider payload (BD-022). */
  payload: jsonObjectSchema,
});

export const webhookAcceptedResponseSchema = z.strictObject({
  accepted: z.boolean(),
  delivery_id: nonEmptyStringSchema,
});

export const setupGuideResponseSchema = z.strictObject({
  provider: nonEmptyStringSchema,
  title: nonEmptyStringSchema,
  markdown: nonEmptyStringSchema,
  webhook_url: urlSchema.nullable(),
});

export type ApiError = z.infer<typeof apiErrorSchema>;
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;
export type VersionResponse = z.infer<typeof versionResponseSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type UserSummary = z.infer<typeof userSummarySchema>;
export type IntegrationSummary = z.infer<typeof integrationSummarySchema>;
export type EffectiveConfigResponse = z.infer<typeof effectiveConfigResponseSchema>;
export type ProjectSummary = z.infer<typeof projectSummarySchema>;
export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;
export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>;
export type TaskDetailResponse = z.infer<typeof taskDetailResponseSchema>;
export type AnswerQuestionRequest = z.infer<typeof answerQuestionRequestSchema>;
export type DecideApprovalRequest = z.infer<typeof decideApprovalRequestSchema>;
export type SubmitFeedbackRequest = z.infer<typeof submitFeedbackRequestSchema>;
export type TaskExportResponse = z.infer<typeof taskExportResponseSchema>;
export type RunMessagesQuery = z.infer<typeof runMessagesQuerySchema>;
export type RunMessagesResponse = z.infer<typeof runMessagesResponseSchema>;
export type SteerRunRequest = z.infer<typeof steerRunRequestSchema>;
export type RetryRunRequest = z.infer<typeof retryRunRequestSchema>;
export type InboxResponse = z.infer<typeof inboxResponseSchema>;
export type KbSearchResponse = z.infer<typeof kbSearchResponseSchema>;
export type DecideKbProposalRequest = z.infer<typeof decideKbProposalRequestSchema>;
export type SseTopic = z.infer<typeof sseTopicSchema>;
export type SseFrame = z.infer<typeof sseFrameSchema>;
export type SseControlEvent = z.infer<typeof sseControlEventSchema>;
export type UpdateSubscriptionsRequest = z.infer<typeof updateSubscriptionsRequestSchema>;
export type WebhookDelivery = z.infer<typeof webhookDeliverySchema>;
export type SetupGuideResponse = z.infer<typeof setupGuideResponseSchema>;

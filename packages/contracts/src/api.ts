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
  MAX_PROPOSAL_DELTA_BYTES,
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

/** `GET /api/org/users` — the org's user list. */
export const orgUsersResponseSchema = z.strictObject({ items: z.array(userSummarySchema) });

/**
 * One row of `config_audit` (technical/03): an append-only record of a human configuration
 * change. `diff` is opaque to the API — secret values appear in it as the literal `"changed"`,
 * which is the writer's job, not the reader's.
 */
export const auditEntrySchema = z.strictObject({
  id: idSchema,
  entity_type: nonEmptyStringSchema,
  entity_id: idSchema.nullable(),
  user_id: idSchema.nullable(),
  diff: jsonObjectSchema,
  created_at: isoDateTimeSchema,
});

export const orgAuditQuerySchema = paginationQuerySchema.extend({
  entity_type: nonEmptyStringSchema.optional(),
});

export const orgAuditResponseSchema = page(auditEntrySchema);

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

/**
 * Longest reason a maintainer may attach to a decision.
 *
 * It is stored on an event payload rather than in a page, so it is bounded far below the delta: a
 * sentence, not a document. Unbounded free text on a `jsonb` payload is the shape TD-012's write
 * list is about — and the value is redacted as well (`decide.ts`).
 */
export const MAX_PROPOSAL_DECISION_REASON_CHARS = 2_000;

export const decideKbProposalRequestSchema = z.strictObject({
  decision: z.enum(['approve', 'reject', 'edit']),
  /** Free text from a human; it reaches `knowledge.proposal.rejected` and is redacted on the way. */
  reason: z.string().max(MAX_PROPOSAL_DECISION_REASON_CHARS).optional(),
  /**
   * Present for `edit`: the replacement delta the maintainer accepted.
   *
   * Bounded by the **same** budget the curator applies to a model's page
   * ({@link MAX_PROPOSAL_DELTA_BYTES}): an edit reaches the row, the commit and every later context
   * pack, so a path that skipped the cap would make "a knowledge page is at most 64 KiB" true of one
   * producer and not of the other.
   */
  delta: z.string().max(MAX_PROPOSAL_DELTA_BYTES).optional(),
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
    /**
     * The topic a control frame is about, or null when it is about the whole connection.
     *
     * `reset` is always topic-level — it says "your cursor for *this* topic is older than the
     * buffer, refetch it". `ping` and `shutdown` are connection-level and carry no topic: a
     * multiplexed stream has one socket, and announcing its end once per subscribed topic would
     * say the same thing N times (technical/08 § "SSE contract").
     */
    topic: sseTopicSchema.nullish(),
    type: sseControlEventSchema,
    /** `reset` tells the client its `Last-Event-ID` is older than the buffer; refetch. */
    detail: z.string().nullish(),
  }),
]);

export const eventsQuerySchema = z.strictObject({
  topics: z.string().min(1),
  partials: z.enum(['0', '1']).optional(),
  /**
   * Client-chosen id for this connection, so `POST /events/subscriptions` can address it. Absent
   * means the server invents one and the connection's topic set is fixed for its lifetime — which
   * is all a plain `EventSource` can do anyway.
   */
  connection_id: nonEmptyStringSchema.optional(),
  /**
   * Resume cursors, `<topic>:<seq>` comma-separated — the query-string form of `Last-Event-ID`.
   * The header is the SSE standard and carries the id of the **last frame received**, which on a
   * multiplexed stream is one topic's cursor; a client that tracks all of them sends the full set
   * here, because the browser's `EventSource` cannot set a request header.
   */
  last_event_id: nonEmptyStringSchema.optional(),
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

/**
 * The answer to a delivery. `accepted: false` is still a 2xx (WP-15c).
 *
 * `delivery_id` is **nullable** because a delivery can be authentic and still have none: both
 * shipped providers refuse to key a hook kind they do not handle (a wiki hook, a release hook), and
 * answering a vendor with an error there would eventually have it disable the whole webhook —
 * standing rule 20, fail open on an inbound notification. So the platform says "received, and I
 * performed nothing", which needs a shape in which the identity may be absent.
 */
export const webhookAcceptedResponseSchema = z.strictObject({
  accepted: z.boolean(),
  delivery_id: nonEmptyStringSchema.nullable(),
});

/**
 * `POST /webhooks/:provider/:integrationId` path parameters.
 *
 * camelCase where every payload in the platform is snake_case, and deliberately: these are **URL
 * path segments**, named by technical/08's endpoint table, not keys on a wire document. Renaming
 * them would change the URL an operator has already pasted into GitLab.
 */
export const webhookParamsSchema = z.strictObject({
  /**
   * A **registered provider id**, and bounded here rather than only compared later.
   *
   * `nonEmptyStringSchema` accepted any length, and the segment reaches
   * `integration_actions.payload.error` on a `provider_mismatch` refusal — an unauthenticated
   * caller's own string, bounded only by whatever request line the server accepts. The shape is the
   * registry's own (`packages/integrations/src/registry.ts`'s `PROVIDER_ID`), written out because
   * `contracts` may not import an adapter; every shipped id matches it (`jira-cloud`, `gitlab`,
   * `slack`, `sentry`, `loki`, and the two fakes). A segment that cannot name any provider is a
   * wrong URL, so refusing it costs no delivery — a *slug-shaped* mismatch still reaches the
   * handler and is audited, which is the case worth telling an operator about.
   */
  provider: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9-]*$/, 'expected a registered provider id such as "jira-cloud"'),
  integrationId: idSchema,
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
export type OrgUsersResponse = z.infer<typeof orgUsersResponseSchema>;
export type AuditEntry = z.infer<typeof auditEntrySchema>;
export type OrgAuditQuery = z.infer<typeof orgAuditQuerySchema>;
export type OrgAuditResponse = z.infer<typeof orgAuditResponseSchema>;
export type EventsQuery = z.infer<typeof eventsQuerySchema>;
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
export type KbTreeResponse = z.infer<typeof kbTreeResponseSchema>;
export type KbDocResponse = z.infer<typeof kbDocResponseSchema>;
export type KbProposalsResponse = z.infer<typeof kbProposalsResponseSchema>;
export type KbSearchResponse = z.infer<typeof kbSearchResponseSchema>;
export type DecideKbProposalRequest = z.infer<typeof decideKbProposalRequestSchema>;
export type SseTopic = z.infer<typeof sseTopicSchema>;
export type SseFrame = z.infer<typeof sseFrameSchema>;
export type SseControlEvent = z.infer<typeof sseControlEventSchema>;
export type UpdateSubscriptionsRequest = z.infer<typeof updateSubscriptionsRequestSchema>;
export type WebhookDelivery = z.infer<typeof webhookDeliverySchema>;
export type WebhookParams = z.infer<typeof webhookParamsSchema>;
export type WebhookAcceptedResponse = z.infer<typeof webhookAcceptedResponseSchema>;
export type SetupGuideResponse = z.infer<typeof setupGuideResponseSchema>;

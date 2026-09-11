/**
 * Primitive value objects and enumerations shared by every contract in this package.
 *
 * Sources: docs/technical/02-domain-model-and-events.md (aggregates, state machines),
 * docs/technical/03-data-model.md (persisted column shapes), docs/technical/04-agent-runtime.md
 * (run modes, usage), docs/technical/12-configuration-and-schemas.md.
 *
 * Wire format is snake_case everywhere (YAML config, event payloads, artifact data, API DTOs,
 * transcript rows) because that is what all four source documents use; the exported TypeScript
 * identifiers stay camelCase.
 */
import * as z from 'zod';

// ── Scalars ──────────────────────────────────────────────────────────────────

/** Time-ordered primary key (`uuidv7()` in Postgres, technical/03). Any UUID version parses. */
export const idSchema = z.uuid();

/** `timestamptz` on the wire: RFC 3339 with `Z` or a numeric offset. */
export const isoDateTimeSchema = z.iso.datetime({ offset: true });

/** Calendar date, no time component (`expires`, `last_confirmed` in technical/03). */
export const isoDateSchema = z.iso.date();

/** Stage ids, template ids, chore ids, risk-class names — lower snake_case identifiers. */
export const slugSchema = z.string().regex(/^[a-z][a-z0-9_]*$/, 'expected a lower_snake_case slug');

export const nonEmptyStringSchema = z.string().min(1);

/** A repository-relative path or a glob (`protected_paths`, `risk_classes[].paths`). */
export const pathPatternSchema = z.string().min(1).max(512);

/** BCP-47 subset used for `communication_language` and the artifact envelope's `language`. */
export const languageTagSchema = z
  .string()
  .regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'expected a language tag such as "en" or "cs"');

/** Git object name. */
export const shaSchema = z.string().regex(/^[0-9a-f]{7,64}$/, 'expected a hexadecimal git sha');

export const urlSchema = z.url();

/** Money in USD. Postgres stores `numeric(12,6)`; the wire carries a JSON number. */
export const usdSchema = z.number().nonnegative().finite();

export const tokenCountSchema = z.int().nonnegative();

/** Sequence numbers: `events.stream_seq`, `run_messages.seq`, SSE per-topic ids. Zero-based. */
export const sequenceSchema = z.int().nonnegative();

/** A score in `[0, 1]` (knowledge significance, context-pack relevance). */
export const unitIntervalSchema = z.number().min(0).max(1);

/**
 * Human-readable duration used by `limits.question_timeout` (technical/12 writes
 * `1 working day`). "working" means the org calendar skips weekends and holidays.
 */
export const durationSchema = z
  .string()
  .regex(
    /^\d+ (working )?(minutes?|hours?|days?)$/,
    'expected a duration such as "30 minutes", "2 hours" or "1 working day"',
  );

/** Wall-clock time of day, used by `features.digest.at` and quiet hours. */
export const timeOfDaySchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected a 24-hour HH:MM time');

// ── Enumerations ─────────────────────────────────────────────────────────────

/** Task state machine (technical/02). `returned` carries the target stage in the payload. */
export const taskStateSchema = z.enum([
  'queued',
  'active',
  'returned',
  'waiting_answers',
  'waiting_approval',
  'paused',
  'needs_human',
  'ready_for_merge',
  'merged',
  'retro',
  'done',
  'cancelled',
]);

/** `tasks.mode` (technical/03). Run-level modes are richer — see `runModeSchema`. */
export const taskModeSchema = z.enum(['normal', 'shadow']);

/** Runner modes (technical/04 "Modes"). */
export const runModeSchema = z.enum([
  'normal',
  'shadow',
  'review_only',
  'linter',
  'discovery',
  'retro',
  'librarian',
]);

/** Run state machine (technical/02) — mirrors `runs.status`. */
export const runStatusSchema = z.enum([
  'created',
  'starting',
  'running',
  'completed',
  'failed',
  'cancelled',
  'budget_exceeded',
  'timed_out',
  'stalled',
]);

/**
 * `runs.terminal_reason`. The `error_*` values come from the Agent SDK result message
 * (technical/04 "Result handling"); the rest are platform-side outcomes.
 */
export const runTerminalReasonSchema = z.enum([
  'success',
  'error_max_turns',
  'error_max_budget_usd',
  'error_max_structured_output_retries',
  'error_during_execution',
  'permission_denied',
  'cancelled',
  'stalled',
  'timed_out',
  'crash',
]);

export const questionStatusSchema = z.enum(['open', 'answered', 'expired', 'escalated']);

export const approvalKindSchema = z.enum(['plan', 'budget', 'knowledge', 'rework']);

export const approvalStatusSchema = z.enum(['pending', 'approved', 'rejected', 'expired']);

export const workspaceStatusSchema = z.enum([
  'provisioning',
  'ready',
  'in_use',
  'paused',
  'exported',
  'destroyed',
]);

/** KnowledgeProposal state machine (technical/02). */
export const knowledgeProposalStatusSchema = z.enum([
  'scored',
  'queued',
  'auto_applied',
  'applied',
  'rejected',
  'discarded',
]);

/** Org and project membership roles (technical/08 "Auth and RBAC"). */
export const userRoleSchema = z.enum(['admin', 'maintainer', 'member', 'viewer']);

/** Agent roles shipped as prompts in `packages/prompts/<role>/` (WP-17, technical/12). */
export const agentRoleSchema = z.enum([
  'triager',
  'product_manager',
  'investigator',
  'architect',
  'developer',
  'reviewer',
  'acceptance_tester',
  'facilitator',
  'librarian',
  'discovery',
]);

/** Integration types, one contract suite each (technical/06, technical/10). */
export const integrationTypeSchema = z.enum([
  'task_management',
  'git',
  'communication',
  'logs',
  'errors',
]);

/** `APP_PROVIDER_MODE` (BD-004). */
export const providerModeSchema = z.enum(['api', 'local']);

/** Estimate buckets used by RefinedSpec and the plan (technical/12). */
export const sizeSchema = z.enum(['S', 'M', 'L', 'XL']);

/** Review finding severities (technical/12 ReviewVerdict). */
export const severitySchema = z.enum(['blocker', 'major', 'minor', 'nit']);

/** Autonomy dial (BD-027, technical/12 `policies.autonomy`). */
export const autonomyLevelSchema = z.enum(['observe', 'assist', 'supervised', 'autonomous']);

/** Reasoning effort per stage (BD-013, technical/12 `stages.*.effort`). */
export const effortSchema = z.enum(['low', 'medium', 'high']);

/** Artifact types (technical/02 Artifact aggregate). */
export const artifactTypeSchema = z.enum([
  'RefinedSpec',
  'RootCauseAnalysis',
  'ImplementationPlan',
  'ImplementationNotes',
  'ReviewVerdict',
  'AcceptanceVerdict',
  'RetroReport',
  'ShadowReport',
  'ReadinessReport',
  'DiscoveryDraft',
]);

/** Pipeline templates the platform ships (BD-005). Projects may define more in `pipeline.yml`. */
export const BUILTIN_TEMPLATE_IDS = ['feature', 'bug', 'chore', 'spike'] as const;

/**
 * Template identifier. Deliberately a slug rather than an enum: `pipeline.yml` lets a project
 * define templates beyond the four built-ins (technical/12).
 */
export const templateIdSchema = slugSchema;

/** Stage identifier — also a slug, because `custom_stages` introduces new ids (technical/12). */
export const stageIdSchema = slugSchema;

/** Stages of the shipped templates (technical/12 `pipeline.yml`). */
export const BUILTIN_STAGE_IDS = [
  'intake',
  'refinement',
  'investigation',
  'architecture',
  'implementation',
  'ci_gate',
  'code_review',
  'business_review',
  'rebase_gate',
  'ready_for_merge',
  'merged_gate',
  'retrospective',
  'librarian',
  'done',
] as const;

// ── Identities and actors ────────────────────────────────────────────────────

/**
 * An identity as it arrives from an integration. `verified` is false until the identity has been
 * mapped to a platform user; unmapped identities may be recorded but never trigger actions
 * (BD-022, BD-006).
 */
export const externalIdentitySchema = z.strictObject({
  provider: nonEmptyStringSchema,
  external_id: nonEmptyStringSchema,
  email: z.email().nullish(),
  display_name: z.string().nullish(),
  verified: z.boolean(),
});

/** `events.actor` (technical/03). The three kinds named by technical/02. */
export const actorSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('system'),
    component: nonEmptyStringSchema,
  }),
  z.strictObject({
    kind: z.literal('user'),
    user_id: idSchema,
    identity: externalIdentitySchema.nullish(),
  }),
  z.strictObject({
    kind: z.literal('integration'),
    integration_id: idSchema,
    provider: nonEmptyStringSchema,
    identity: externalIdentitySchema.nullish(),
  }),
]);

// ── Refs ─────────────────────────────────────────────────────────────────────

/** `tasks.ticket_provider/ticket_key/ticket_url` (technical/03). */
export const ticketRefSchema = z.strictObject({
  provider: nonEmptyStringSchema,
  key: nonEmptyStringSchema,
  url: urlSchema,
});

/** `tasks.mr_ref` (technical/03) and the `mr` field of ImplementationNotes (technical/12). */
export const mergeRequestRefSchema = z.strictObject({
  provider: nonEmptyStringSchema.nullish(),
  project_path: nonEmptyStringSchema.nullish(),
  iid: z.int().positive(),
  url: urlSchema,
  branch: nonEmptyStringSchema.nullish(),
  head_sha: shaSchema.nullish(),
});

/** `tasks.workpad_ref` — the single comment the platform keeps updated (BD-023). */
export const workpadRefSchema = z.strictObject({
  provider: nonEmptyStringSchema,
  ticket_key: nonEmptyStringSchema,
  comment_id: nonEmptyStringSchema,
  url: urlSchema.nullish(),
});

// ── Usage and cost ───────────────────────────────────────────────────────────

/** Token usage split by cache kind, as stored on `runs` and `cost_entries` (technical/03). */
export const tokenUsageSchema = z.strictObject({
  input_tokens: tokenCountSchema,
  output_tokens: tokenCountSchema,
  cache_write_5m_tokens: tokenCountSchema,
  cache_write_1h_tokens: tokenCountSchema,
  cache_read_tokens: tokenCountSchema,
});

/** One `run_model_usage` row (technical/03) — usage attributed to a single model. */
export const modelUsageSchema = tokenUsageSchema.extend({
  model: nonEmptyStringSchema,
  usd: usdSchema,
});

/**
 * Cost of a run. `is_estimate` is true in `local` provider mode, where the SDK reports no
 * `total_cost_usd` and the platform prices the usage from the price list (BD-011, technical/03).
 */
export const runCostSchema = z.strictObject({
  usd: usdSchema,
  is_estimate: z.boolean(),
  price_list_id: idSchema.nullish(),
});

// ── Inferred types ───────────────────────────────────────────────────────────

export type Id = z.infer<typeof idSchema>;
export type IsoDateTime = z.infer<typeof isoDateTimeSchema>;
export type IsoDate = z.infer<typeof isoDateSchema>;
export type Slug = z.infer<typeof slugSchema>;
export type TaskState = z.infer<typeof taskStateSchema>;
export type TaskMode = z.infer<typeof taskModeSchema>;
export type RunMode = z.infer<typeof runModeSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;
export type RunTerminalReason = z.infer<typeof runTerminalReasonSchema>;
export type QuestionStatus = z.infer<typeof questionStatusSchema>;
export type ApprovalKind = z.infer<typeof approvalKindSchema>;
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;
export type WorkspaceStatus = z.infer<typeof workspaceStatusSchema>;
export type KnowledgeProposalStatus = z.infer<typeof knowledgeProposalStatusSchema>;
export type UserRole = z.infer<typeof userRoleSchema>;
export type AgentRole = z.infer<typeof agentRoleSchema>;
export type IntegrationType = z.infer<typeof integrationTypeSchema>;
export type ProviderMode = z.infer<typeof providerModeSchema>;
export type Size = z.infer<typeof sizeSchema>;
export type Severity = z.infer<typeof severitySchema>;
export type AutonomyLevel = z.infer<typeof autonomyLevelSchema>;
export type Effort = z.infer<typeof effortSchema>;
export type ArtifactType = z.infer<typeof artifactTypeSchema>;
export type ExternalIdentity = z.infer<typeof externalIdentitySchema>;
export type Actor = z.infer<typeof actorSchema>;
export type TicketRef = z.infer<typeof ticketRefSchema>;
export type MergeRequestRef = z.infer<typeof mergeRequestRefSchema>;
export type WorkpadRef = z.infer<typeof workpadRefSchema>;
export type TokenUsage = z.infer<typeof tokenUsageSchema>;
export type ModelUsage = z.infer<typeof modelUsageSchema>;
export type RunCost = z.infer<typeof runCostSchema>;

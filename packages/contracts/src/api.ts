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
import {
  acceptanceCriterionSchema,
  artifactRefSchema,
  artifactSchema,
  askAnswerCitationSchema,
  kbHealthFindingSchema,
  MAX_BREAKDOWN_CHILDREN,
  shadowReportDataSchema,
} from './artifacts.js';
import {
  agentRoleSchema,
  artifactTypeSchema,
  autonomyLevelSchema,
  effortSchema,
  idSchema,
  integrationTypeSchema,
  isoDateSchema,
  isoDateTimeSchema,
  MAX_PROPOSAL_DELTA_BYTES,
  mergeRequestRefSchema,
  nonEmptyStringSchema,
  pathPatternSchema,
  runStatusSchema,
  sequenceSchema,
  severitySchema,
  sizeSchema,
  slugSchema,
  stageIdSchema,
  taskModeSchema,
  taskStateSchema,
  templateIdSchema,
  unitIntervalSchema,
  urlSchema,
  usdSchema,
  userRoleSchema,
} from './common.js';
import { agenticConfigSchema, MAX_BOOTSTRAP_MERGE_REQUESTS, riskClassSchema } from './config.js';
import { domainEventSchema, domainEventTypeSchema } from './events.js';
import {
  approvalRecordSchema,
  autonomyPoliciesSchema,
  budgetRecordSchema,
  configSourceSchema,
  contextPackRecordSchema,
  humanTimeKindSchema,
  jsonObjectSchema,
  jsonValueSchema,
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

/**
 * `GET /api/integrations` — the account list (WP-15h part 2).
 *
 * No `next_cursor`: an organisation has a handful of integrations and the client does not
 * paginate it. It was composed in `apps/web/src/api/endpoints.ts` until the route existed, which
 * is exactly what **Q45** said to do with it — *"move it into `packages/contracts` when the work
 * package that implements the route lands"* — so the shape is unchanged and now has one home.
 */
export const integrationsResponseSchema = z.strictObject({
  items: z.array(integrationSummarySchema),
});

export const createIntegrationRequestSchema = z.strictObject({
  type: integrationTypeSchema,
  provider: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  config: jsonObjectSchema,
  /**
   * Credential **field** → the name of the environment variable holding its value. Never a value.
   *
   * A record and not a list, which is a change WP-21 made when it served the route: a list says
   * *which* names to read and not which field each one fills, and a provider with two credential
   * fields — GitLab's API token and its webhook secret — cannot be configured from one. The server
   * reads each name from its own environment (or the `_FILE` companion, TD-020) and seals the
   * value into `secrets`, so no credential crosses this API (BD-002).
   *
   * A field the provider does not declare is refused rather than sealed: it would store a value
   * the binding loader will never merge.
   */
  secret_refs: z.record(nonEmptyStringSchema, nonEmptyStringSchema).optional(),
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
  /**
   * `commands.allow` entries this project declares that **no run of any role** is granted — the
   * reader `ignoredAllow` did not have until WP-54 (PROGRESS backlog 49).
   *
   * BD-025 lets a project only narrow what a role's baseline grants, so an entry outside every
   * baseline is dropped rather than widening anything; before WP-54 it was dropped in silence. An
   * entry granted to *some* role is not listed (a read-only role not getting `npm test` is the
   * baseline working); the per-run, per-role answer is the stage planner's log line. Empty when
   * nothing is ignored, and when the project declares no `allow` at all.
   */
  ignored_allow_commands: z.array(nonEmptyStringSchema),
  /**
   * Risk classes **proposed** for this project and not applied — product/18:52, WP-37.
   *
   * product/18 makes risk classes a wizard step rather than a default, so `policies.risk_classes`
   * above is empty until a human accepts: this field is what they are accepting, config-shaped, and
   * the acceptance is `PUT /api/projects/:id/config` with the map copied into `policies`.
   *
   *  - `source: 'discovery'` — a Discovery run read this repository and suggested these
   *    (`projects.proposed_risk_classes`, migration 0026).
   *  - `source: 'platform'` — nobody has proposed anything, so the platform offers product/19 §14's
   *    own table. The two are distinguished because *"the agent looked at your repository"* and
   *    *"here is the standard set"* are different claims, and a screen that conflated them would be
   *    putting words in the agent's mouth.
   *
   * `not_expressible` is the row of product/19 §14 this build cannot propose, **with the reason** —
   * data rather than prose, because the screen renders it and an operator does not read docblocks
   * (standing rule 18: the absent case must not be the quiet one).
   */
  risk_class_proposal: z.strictObject({
    source: z.enum(['discovery', 'platform']),
    classes: z.record(slugSchema, riskClassSchema),
    not_expressible: z.array(
      z.strictObject({
        name: nonEmptyStringSchema,
        paths: z.array(pathPatternSchema),
        reason: nonEmptyStringSchema,
      }),
    ),
  }),
});

/**
 * `PUT /api/projects/:id/config` — the whole document, never a patch (WP-21 serves it).
 *
 * `config` is the **whole** `.agentic/config.yml` through the strict schema: the wizard never
 * hand-builds a document and the server never merges a delta, so an unknown key is refused here
 * rather than stored and ignored (technical/12 § "Unknown keys are errors").
 *
 * `autonomy_level` travels **beside** the document rather than only inside
 * `config.policies.autonomy`, because the column and the document are two stores:
 * `projects.autonomy_level` is what the board badge and `suggestedAutonomyCap` read, and
 * `policies.autonomy` is what a repository may also set. The route materialises the dial through
 * the domain preset (`applyAutonomyPreset`) and **refuses** a document whose `policies.autonomy`
 * disagrees with it, so the two cannot drift apart. Optional, because a caller that is only
 * editing the pipeline limits should not have to restate the dial.
 */
export const updateProjectConfigRequestSchema = z.strictObject({
  config: agenticConfigSchema,
  /** Optimistic concurrency: the hash the client last read. */
  base_hash: nonEmptyStringSchema.optional(),
  autonomy_level: autonomyLevelSchema.optional(),
});

export const projectSummarySchema = projectRecordSchema.extend({
  open_tasks: z.int().nonnegative(),
  spent_usd_30d: usdSchema,
});

/**
 * `GET /api/projects` — every project the caller may read (WP-15h part 2, Q45's second envelope).
 *
 * No `next_cursor`, for the same reason as the integration list: the dashboard renders every
 * project it is given and nothing in the client asks for a second page.
 */
export const projectsResponseSchema = z.strictObject({
  items: z.array(projectSummarySchema),
});

/**
 * `POST /api/projects` — the wizard's step 1 (WP-21, product/06 § "Step 1 — Connect").
 *
 * Only the facts an operator types. `autonomy_level` is **not** here: the dial is step 4 and it is
 * materialised through `applyAutonomyPreset`, so accepting it beside the repository URL would give
 * a project two places to be configured from and one of them would skip the preset.
 */
export const createProjectRequestSchema = z.strictObject({
  key: slugSchema,
  name: nonEmptyStringSchema,
  repo_url: urlSchema,
  /** A branch name, bounded: it is concatenated into git arguments and into an audit row. */
  default_branch: z.string().min(1).max(255).optional(),
  /**
   * Where the vault lives inside the repository, **bounded and relative**.
   *
   * The same `pathPatternSchema` every other repository path on the wire uses, plus the two things
   * a *directory the platform joins to* has to be: not absolute, and with no `..` segment. The
   * value ends up in `projects.knowledge_dir`, which `curateProposals` joins a model-chosen page
   * path onto and which the vault reader walks — the join already refuses a path that would land
   * outside, and refusing the *directory* too is the narrowing direction (BD-025).
   */
  knowledge_dir: pathPatternSchema
    .refine(
      (value) =>
        !value.startsWith('/') &&
        !value.split('/').some((segment) => segment === '..' || segment === '.'),
      'must be a repository-relative directory with no "." or ".." segment',
    )
    .optional(),
});

/**
 * `PUT /api/projects/:id/bindings` — which of the organisation's integrations this project uses.
 *
 * The whole set, not a delta: a binding that disappears from the list is removed, which is what
 * makes the request idempotent and what lets the wizard's step 1 be re-submitted. `config` is the
 * per-project override `ProjectBinding` describes (a narrower pick-up rule, a project path).
 */
export const projectBindingSummarySchema = z.strictObject({
  integration_id: idSchema,
  type: integrationTypeSchema,
  provider: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  config: jsonObjectSchema,
});

export const projectBindingsResponseSchema = z.strictObject({
  items: z.array(projectBindingSummarySchema),
});

export const putProjectBindingsRequestSchema = z.strictObject({
  items: z.array(z.strictObject({ integration_id: idSchema, config: jsonObjectSchema.optional() })),
});

/**
 * `POST /api/projects/:id/discovery` — the wizard's step 2.
 *
 * The answer is the **task** the discovery run belongs to (WP-21: discovery is a stage of a
 * one-off task, `DISCOVERY_TEMPLATE`), so a client follows it with `GET /api/tasks/:id` like any
 * other task rather than needing a shape of its own. `started` is false when the project already
 * had a discovery task — the command is idempotent on the project, and re-running it would spend a
 * second budget for the same answer.
 */
export const startDiscoveryResponseSchema = z.strictObject({
  task_id: idSchema,
  started: z.boolean(),
  detail: z.string(),
});

/**
 * `GET /api/projects/:id/readiness` — the evaluation, since WP-21 wrote the first one.
 *
 * `criteria` is product/17's table: what passed, the evidence and **what it unlocks**. `unlocks` is
 * platform text from `READINESS_CRITERIA` and is never copied out of an artifact, so nothing a
 * model writes can change what a criterion claims to buy. `evidence` **is** untrusted (BD-022) for
 * the eleven criteria the Discovery agent answers: render it, never execute it.
 */
export const readinessResponseSchema = z.strictObject({
  level: z.int().min(0).max(5),
  evaluated_at: isoDateTimeSchema,
  criteria: z.array(
    z.strictObject({
      id: nonEmptyStringSchema,
      passed: z.boolean(),
      evidence: z.string(),
      unlocks: z.string(),
      /** Who answered it — `platform` for R9, R11 and R12, `agent` for the other eleven. */
      detected_by: z.enum(['agent', 'platform']),
    }),
  ),
  /** `readiness_evaluations.source`: which producer wrote this row (`discovery`, `recheck`). */
  source: nonEmptyStringSchema,
  /** product/17: the three cheapest criteria to improve next, in the wizard's order. */
  next_improvements: z.array(
    z.strictObject({
      id: nonEmptyStringSchema,
      title: nonEmptyStringSchema,
      unlocks: z.string(),
    }),
  ),
});

// ── Shadow mode (product/10:20, product/18:24, WP-34) ────────────────────────

/**
 * How many closed tickets one batch may name.
 *
 * product/18's own configuration column is *"pick N recent closed tickets (default 10)"*, and
 * product/19 §21's dogfood Phase A is *"shadow mode on 10 closed tickets each"*. Twenty-five is
 * two and a half of those, which is the bound this platform draws for the same reason every other
 * request bound is drawn: a list whose length somebody else chooses is a request whose cost
 * somebody else chooses. Each entry is a whole delivery pipeline at product/19 §12's *"~$5–15 per
 * ticket"*, so the cap is also a spend an operator can reason about — and the **budget** is what
 * actually stops a batch (`features.shadow_mode.budget_usd`), not this number.
 */
export const MAX_SHADOW_BATCH_TICKETS = 25;

export const startShadowBatchRequestSchema = z.strictObject({
  /**
   * The closed tickets to shadow, by key. product/18:24's parenthesis — *"or on new tickets in
   * parallel with humans"* — is deliberately not expressible: Q82 (c) rules it a later feature,
   * because it needs a shadow task and a live task for the same ticket on the same project, which
   * is two answers to one question.
   */
  ticket_keys: z.array(nonEmptyStringSchema.max(200)).min(1).max(MAX_SHADOW_BATCH_TICKETS),
});

/** Which of Q82 (b)'s two lookups found the human merge request this ticket is compared with. */
export const shadowHumanMrSourceSchema = z.enum(['ticket_link', 'title_scan']);

/**
 * One ticket of a batch, as the Shadow screen reads it.
 *
 * `task_id` is null exactly when `refused_reason` is not — Q82 (a)'s refusal, which is a ticket the
 * platform declined to run rather than one that failed. `similarity` is the report's own
 * `overlap.files_jaccard` and is null while the task is still running, when it produced no diff, or
 * when the ticket has no human merge request to compare against; the three are different facts and
 * `report.notes` says which.
 */
export const shadowBatchTicketSchema = z.strictObject({
  ticket_key: nonEmptyStringSchema,
  task_id: idSchema.nullable(),
  task_state: taskStateSchema.nullable(),
  refused_reason: z.string().nullable(),
  base_sha: nonEmptyStringSchema.nullable(),
  human_mr: mergeRequestRefSchema.nullable(),
  human_mr_source: shadowHumanMrSourceSchema.nullable(),
  /** `tasks.size` — the size band the aggregate's cost-per-size table is keyed by. */
  size: sizeSchema.nullable(),
  cost_usd: usdSchema,
  predicted_cost_usd: usdSchema.nullable(),
  similarity: unitIntervalSchema.nullable(),
  report: shadowReportDataSchema.nullable(),
});

/**
 * product/19 §13's second sentence, as a **projection** over the batch's `shadow_reports` rows:
 * *"predicted cost per ticket by size, similarity distribution, list of 'high similarity + low
 * cost' tickets as the launch candidates"*.
 *
 * Nothing here is stored. A fifth number kept in step with four others is a number that stops being
 * in step, and the rows it is computed from are already the record.
 */
export const shadowBatchAggregateSchema = z.strictObject({
  /** One row per size band that has at least one reported ticket; absent bands are absent. */
  cost_by_size: z.array(
    z.strictObject({
      size: sizeSchema,
      tickets: z.int().positive(),
      median_cost_usd: usdSchema,
      median_predicted_cost_usd: usdSchema.nullable(),
    }),
  ),
  /**
   * The similarity histogram, five fixed buckets of `files_jaccard` — `[0,0.2)`, `[0.2,0.4)`,
   * `[0.4,0.6)`, `[0.6,0.8)`, `[0.8,1]`. Fixed rather than derived so two batches can be compared.
   */
  similarity_distribution: z.array(
    z.strictObject({
      from: unitIntervalSchema,
      to: unitIntervalSchema,
      tickets: z.int().nonnegative(),
    }),
  ),
  /** product/19 §13's *"launch candidates"*: high similarity, low cost, most similar first. */
  launch_candidates: z.array(
    z.strictObject({
      ticket_key: nonEmptyStringSchema,
      task_id: idSchema,
      similarity: unitIntervalSchema,
      cost_usd: usdSchema,
    }),
  ),
  /** How many of the batch's tickets have a report yet; the denominator of everything above. */
  reported: z.int().nonnegative(),
  compared: z.int().nonnegative(),
});

export const shadowBatchSummarySchema = z.strictObject({
  id: idSchema,
  project_id: idSchema,
  created_at: isoDateTimeSchema,
  completed_at: isoDateTimeSchema.nullable(),
  budget_usd: usdSchema.nullable(),
  spent_usd: usdSchema,
  tickets: z.int().nonnegative(),
  refused: z.int().nonnegative(),
});

export const shadowBatchesResponseSchema = z.strictObject({
  items: z.array(shadowBatchSummarySchema),
  /**
   * Whether the project may start a batch at all, and the sentence to show when it may not.
   *
   * The dial's `shadowMode` policy decides (product/19 §11: Observe is the only shipped position
   * where it is true), and `features.shadow_mode.enabled` is BD-028's opt-in. Both are published
   * here so the screen states the reason rather than offering a button that answers 409.
   */
  can_start: z.boolean(),
  blocked_reason: z.string().nullable(),
});

export const shadowBatchResponseSchema = z.strictObject({
  batch: shadowBatchSummarySchema,
  tickets: z.array(shadowBatchTicketSchema),
  aggregate: shadowBatchAggregateSchema,
});

export const startShadowBatchResponseSchema = z.strictObject({
  batch_id: idSchema,
  /** One entry per key the caller named, in the order they were named, refusals included. */
  tickets: z.array(
    z.strictObject({
      ticket_key: nonEmptyStringSchema,
      task_id: idSchema.nullable(),
      refused_reason: z.string().nullable(),
    }),
  ),
  started: z.int().nonnegative(),
  refused: z.int().nonnegative(),
});

// ── History bootstrap (product/06 step 3b, product/18:27, product/19 §18, WP-35) ──

/**
 * What the wizard is shown **before** anything is started — product/06 step 3b's *"Shows an
 * estimated cost before running"*.
 *
 * The arithmetic is the server's and not the screen's: `batches = ceil(N / batch_size)` and
 * `estimated_usd = batches × the per-run cap`, computed by `estimateHistoryBootstrap` in
 * `@platform/domain` and published here for a given N. A screen that multiplied two published
 * numbers itself would be the second spelling of one rule (standing rule 9), and the first
 * disagreement would be about money.
 *
 * `estimated_usd` is an **upper bound** and says so on the screen: it is what the batch may spend
 * at every run's ceiling, not a prediction of what it will. When it exceeds `cap_usd` the batch
 * still starts and **stops** at the cap, which is what `stops_at_cap` tells the operator in advance.
 */
export const historyBootstrapEstimateSchema = z.strictObject({
  merge_requests: z.int().positive(),
  batch_size: z.int().positive(),
  batches: z.int().nonnegative(),
  estimated_usd: usdSchema,
  cap_usd: usdSchema,
  stops_at_cap: z.boolean(),
  /** The window both halves of the sample are read over, in days (product/19's six months). */
  days: z.int().positive(),
});

export const startHistoryBootstrapRequestSchema = z.strictObject({
  /**
   * How many merged merge requests to mine. Absent means the project's configured N, which itself
   * defaults to `DEFAULT_BOOTSTRAP_MERGE_REQUESTS` (200); above
   * {@link MAX_BOOTSTRAP_MERGE_REQUESTS} it is refused here rather than silently clamped, because a
   * caller that asked for 5 000 asked a question this platform will not answer and should be told.
   */
  merge_requests: z.int().min(1).max(MAX_BOOTSTRAP_MERGE_REQUESTS).optional(),
});

/** Why a whole batch could not start. Each value is a named refusal, never a silent no-op. */
export const historyBootstrapBlockerSchema = z.enum([
  'feature_disabled',
  'no_git_binding',
  'already_running',
  'merge_requests_out_of_range',
]);

export const historyBootstrapStatusSchema = z.enum([
  /** The provider reads are in flight; no task exists yet. */
  'collecting',
  /** Every batch has a task; some of them are still running. */
  'mining',
  /** Every task of the batch has recorded its findings. */
  'completed',
  /** The collection found nothing to mine, or could not run. `detail` says which. */
  'empty',
]);

export const historyBootstrapBatchSchema = z.strictObject({
  id: idSchema,
  project_id: idSchema,
  status: historyBootstrapStatusSchema,
  created_at: isoDateTimeSchema,
  completed_at: isoDateTimeSchema.nullable(),
  merge_requests: z.int().nonnegative(),
  /** Platform text: why a batch is `empty`, or what the collection had to leave out. */
  detail: z.string().nullable(),
  cap_usd: usdSchema,
  estimated_usd: usdSchema,
  spent_usd: usdSchema,
  /** One per chunk of ~20 merge requests: the runs this batch is made of. */
  chunks: z.int().nonnegative(),
  chunks_recorded: z.int().nonnegative(),
  /** Proposals written to the queue by this batch, and how many the recorder refused. */
  proposals: z.int().nonnegative(),
  refused_proposals: z.int().nonnegative(),
});

export const historyBootstrapsResponseSchema = z.strictObject({
  items: z.array(historyBootstrapBatchSchema),
  can_start: z.boolean(),
  blocked_reason: z.string().nullable(),
  /** The estimate for the N in the query, or for the project's configured default. */
  estimate: historyBootstrapEstimateSchema,
  max_merge_requests: z.int().positive(),
});

export const startHistoryBootstrapResponseSchema = z.strictObject({
  batch_id: idSchema,
  estimate: historyBootstrapEstimateSchema,
});

// ── Tasks ────────────────────────────────────────────────────────────────────

export const listTasksQuerySchema = paginationQuerySchema.extend({
  state: taskStateSchema.optional(),
  template: templateIdSchema.optional(),
  mode: taskModeSchema.optional(),
  stage: stageIdSchema.optional(),
});

/**
 * `GET /api/projects/:id/tasks` — one page of a project's tasks, newest first (WP-15h part 2).
 *
 * This one **is** paginated, because a project accumulates tasks without bound and the client
 * already sends `limit` and `cursor`. `next_cursor` is opaque: it is the keyset the server issued,
 * and a client that parses it is reading a shape no contract fixes.
 */
export const tasksResponseSchema = page(taskRecordSchema);

export const createTaskRequestSchema = z.strictObject({
  ticket_key: nonEmptyStringSchema,
  template: templateIdSchema.optional(),
  mode: taskModeSchema.optional(),
});

/**
 * A take-over in force on a task — what product/18 means by *"posts the branch and a
 * `claude --resume <session>` command to the ticket **and UI**"* (WP-27).
 *
 * It is published on the task rather than on a command's answer alone because the person who took
 * the task over is not the only person who needs it: the next operator to open the task page has to
 * be able to see where the work went. `tasks` records that a task is `paused` and not **why**, so
 * the projection reads it off the append-only log — the newest of this task's `task.taken_over` and
 * `task.handed_back`, which is also what makes it disappear the moment the task is handed back.
 */
export const takenOverSchema = z.strictObject({
  at: isoDateTimeSchema,
  /** The branch the human's work is on, inside BD-025's `agentic/*` namespace. */
  branch: nonEmptyStringSchema,
  /** The session `claude --resume` continues, or `null` when the interrupted run had none. */
  session_id: nonEmptyStringSchema.nullable(),
  /** The stage the task was taken over at — where a hand-back would resume by default. */
  stage: stageIdSchema,
  /** The same lines the take-over command answered with, composed by the platform, not the client. */
  resume_commands: z.array(nonEmptyStringSchema),
});

/**
 * One line of the per-user breakdown product/18:32 keeps **off by default** (WP-29).
 *
 * Two identity fields rather than one, because on this build most activity has only the second:
 * `user_id` is the platform user a provider account is mapped to through `user_identities` (which
 * has had a writer since WP-31 and is empty until an operator maps an account), and
 * `external_author` is the provider account itself — `"<provider>:<external id>"` — for the review
 * minutes that came from a merge-request comment. A row with both `null` is possible only for a
 * kind the platform attributes to a platform user it then lost; nothing in this build writes one.
 */
export const humanTimeByUserSchema = z.strictObject({
  user_id: idSchema.nullable(),
  /** `users.name`, or `null` when the minutes belong to no mapped platform user. */
  user_name: z.string().nullable(),
  /** The provider account, untrusted text (BD-022) — rendered, never parsed. */
  external_author: z.string().nullable(),
  minutes: z.number().nonnegative(),
});

/**
 * The human minutes recorded against a task — product/19 §16, product/09:29 (WP-29).
 *
 * **`minutes` and the task's `cost_actual_usd` are two numbers and this contract never adds them**
 * (Q73). product/09:29 asks for human minutes *"shown next to token cost as total cost of
 * delivery"*, and the sum needs an hourly rate that no product document, decision record or
 * configuration key supplies; a default rate would be published on every task page as though it had
 * been measured. So both fields travel and the screen prints them side by side.
 *
 * `by_user` is `null` when the project has not set `features.human_time.per_user_breakdown`
 * (product/18:32's *"off by default"*) — a different answer from `[]`, which is "the breakdown is
 * on and nobody has spent a minute yet".
 */
export const humanTimeSummarySchema = z.strictObject({
  total_minutes: z.number().nonnegative(),
  by_kind: z.record(humanTimeKindSchema, z.number().nonnegative()),
  by_user: z.array(humanTimeByUserSchema).nullable(),
  /**
   * How many entries the total is made of — a review window, an answered question, an approval or a
   * steer each count as one.
   *
   * It is here so that `0` minutes can be told apart from *nothing happened*: product/19 §16 measures
   * a review as the wall clock between the first human activity and the last, so a merge request
   * with exactly one comment on it is a **measured** zero-length window, and a task nobody has
   * touched has no entry at all. One number, two very different states (standing rule 16).
   */
  entries: z.int().nonnegative(),
});

export const taskDetailResponseSchema = z.strictObject({
  task: taskRecordSchema,
  /** The take-over in force, or `null` — see {@link takenOverSchema}. */
  taken_over: takenOverSchema.nullable(),
  /** Human minutes derived from events by the WP-29 projector; never summed with the USD. */
  human_time: humanTimeSummarySchema,
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

/**
 * What a task command answers with (WP-15i).
 *
 * technical/08 fixes every command's *request* and leaves its response open, so this is a choice
 * rather than a transcription — and it is the smallest thing a caller cannot get otherwise: where
 * the task is **now**, read back from the row the command wrote, plus whether this particular
 * request is what moved it.
 *
 * `performed: false` is an `Idempotency-Key` replay: a request whose key has already performed this
 * command is answered with the task's current position and **nothing is performed twice**. It is
 * not a stored response — the position is re-read, so a replay and a first call answer the same
 * shape from the same source.
 */
export const taskCommandResponseSchema = z.strictObject({
  task_id: idSchema,
  state: taskStateSchema,
  current_stage: stageIdSchema.nullable(),
  performed: z.boolean(),
});

/** What a run command answers with: the run, and where its task now stands (WP-15i). */
export const runCommandResponseSchema = z.strictObject({
  run_id: idSchema,
  task_id: idSchema,
  status: runStatusSchema,
  task_state: taskStateSchema,
  performed: z.boolean(),
});

/** `POST /api/tasks/:id/feedback` — the feedback the command recorded (WP-15i). */
export const submitFeedbackResponseSchema = z.strictObject({
  feedback_id: idSchema,
  task_id: idSchema,
  performed: z.boolean(),
});

/**
 * How much free text one command body may carry (WP-15i).
 *
 * Every `reason`, `instructions`, `answer` and feedback `text` below was an **unbounded** string
 * until the routes that read them existed, and each of them is persisted: a reason reaches
 * `task_stages.return_reason` and the `task.stage.returned` event, an answer reaches
 * `questions.answer` and from there the next prompt, and a `human_actions` row carries whichever
 * one the command was given. An unbounded string on a boundary is an unbounded row.
 *
 * 8 000 characters, the same number the prompt assembler caps return feedback at
 * (`MAX_FEEDBACK_CHARS`), because that is where most of this text ends up. It is a **refusal**
 * rather than a truncation: the client can show the writer their own text and let them shorten it,
 * where a server that silently halves a sentence changes what it means. `steerRunRequestSchema`'s
 * 10 000 is the precedent for bounding a command's text at all; it keeps its own number because a
 * steer message is a turn in a conversation rather than a stored note.
 */
export const MAX_COMMAND_TEXT_CHARS = 8_000;

const commandTextSchema = z.string().max(MAX_COMMAND_TEXT_CHARS);
const requiredCommandTextSchema = nonEmptyStringSchema.max(MAX_COMMAND_TEXT_CHARS);

export const pauseTaskRequestSchema = z.strictObject({ reason: commandTextSchema.optional() });
export const resumeTaskRequestSchema = z.strictObject({ reason: commandTextSchema.optional() });
export const cancelTaskRequestSchema = z.strictObject({ reason: commandTextSchema.optional() });
export const retryStageRequestSchema = z.strictObject({
  stage: stageIdSchema,
  reason: commandTextSchema.optional(),
});
export const returnToStageRequestSchema = z.strictObject({
  stage: stageIdSchema,
  reason: requiredCommandTextSchema,
});
export const takeOverRequestSchema = z.strictObject({
  reason: commandTextSchema.optional(),
  /**
   * Whether the launcher writes a tarball of the workspace beside the pushed branch (WP-27).
   *
   * product/19 §19 calls it *"transcript JSONL + **optional** tarball"*, and the option is the
   * caller's because the cost is theirs: the archive is the whole checkout minus `.git` and
   * `node_modules`, written to the launcher's `exports` volume and kept for the same fourteen days
   * as the workspace. Default `false` — the branch is where the work is, and an operator who wants
   * the untracked files asks for them.
   */
  tarball: z.boolean().optional(),
});
export const handBackRequestSchema = z.strictObject({
  stage: stageIdSchema,
  summary: requiredCommandTextSchema,
});
export const reworkRequestSchema = z.strictObject({
  stage: stageIdSchema,
  instructions: requiredCommandTextSchema,
});

export const answerQuestionRequestSchema = z.strictObject({
  answer: requiredCommandTextSchema,
  option: nonEmptyStringSchema.optional(),
});

export const decideApprovalRequestSchema = z.strictObject({
  decision: z.enum(['approve', 'reject']),
  reason: commandTextSchema.optional(),
});

export const submitFeedbackRequestSchema = z.strictObject({
  scope: z.enum(['task', 'stage', 'artifact', 'project']),
  text: requiredCommandTextSchema,
  rating: z.int().min(1).max(5).optional(),
  stage: stageIdSchema.optional(),
  artifact_id: idSchema.optional(),
});

/**
 * `POST /api/tasks/:id/take-over` — what a human needs to carry on by hand (WP-27).
 *
 * The command's whole value is in this shape, which is why no button existed for it before: product/10
 * defines take-over as *"pause pipeline, get branch + resume command, export workspace"*, and an
 * operator who is told only that the pipeline stopped has been given the cost and not the thing it
 * bought. Every field is platform-written text or a provider value the platform already stores.
 *
 * `resume_commands` is a **list of shell lines** rather than one string: product/19 §19 names two
 * (`git fetch && git checkout agentic/PROJ-123`, plus `claude --resume` guidance), and a client that
 * has to split a blob on newlines to render them is a client that has to know the format.
 */
/**
 * `POST /api/tasks/:task_id/ask` — ask-the-task (technical/08:17, product/10:57, WP-31).
 *
 * The question is bounded at `MAX_ASK_QUESTION_CHARS` (4 000) rather than at
 * {@link MAX_COMMAND_TEXT_CHARS}, and the smaller number is derived at the constant in
 * `packages/domain/src/ask`: a question is one or two sentences, it is stored, and it reaches a
 * prompt beside a context pack whose own budget it must not crowd out. A **refusal** rather than a
 * truncation, like every other command's text: half a question is a different question.
 */
export const askTaskRequestSchema = z.strictObject({
  question: nonEmptyStringSchema.max(4_000),
});

export const askTaskResponseSchema = z.strictObject({
  ask_id: idSchema,
  task_id: idSchema,
  /** `false` for a replayed `Idempotency-Key` and for a ticket comment already turned into an ask. */
  performed: z.boolean(),
  /** `pending` — the run is enqueued. Nothing here waits for it; the thread reports the answer. */
  status: z.enum(['pending', 'answered', 'refused', 'failed']),
});

/** One entry of the ask thread (`GET /api/tasks/:task_id/asks`). Every string is untrusted. */
export const taskAskSchema = z.strictObject({
  id: idSchema,
  task_id: idSchema,
  source: z.enum(['ui', 'ticket']),
  asked_by_user_id: idSchema,
  question: z.string(),
  run_id: idSchema.nullable(),
  status: z.enum(['pending', 'answered', 'refused', 'failed']),
  answer: z.string().nullable(),
  citations: z.array(askAnswerCitationSchema),
  /**
   * How many citations the model wrote that named another task's or another project's row, and
   * were dropped (product/11:30).
   *
   * Published rather than hidden: a reader who can see that three claims lost their evidence knows
   * to trust the answer less, and an operator who sees it happen often knows the prompt is wrong.
   */
  dropped_citations: z.int().nonnegative(),
  /** The `AskAnswer` artifact this answer was stored as; `null` until the run finishes. */
  answer_artifact_id: idSchema.nullable(),
  refusal_reason: z.string().nullable(),
  mirrored_at: isoDateTimeSchema.nullable(),
  created_at: isoDateTimeSchema,
  answered_at: isoDateTimeSchema.nullable(),
});

export const taskAskListSchema = z.strictObject({ items: z.array(taskAskSchema) });

/**
 * One proposed child ticket in the epic-split queue — `GET /api/tasks/:task_id/breakdown` (WP-40).
 *
 * The queue's shape is `kb_proposals`' rather than `approvals`' and the reason is Q85's: a
 * breakdown is **N independent decisions** and an approval is one, so a PM who wants five of seven
 * children has to have a row per child to say so. `status` is therefore per row, `decided_by_user_id`
 * and `decided_at` are per row, and a **rejection leaves the row** with its reason — the Librarian
 * learns from rejections (product/10:52) and so does whoever reads this queue.
 *
 * **Every string on this row is untrusted** (BD-022) and none of them is the platform's:
 * `title`, `description`, `rationale` and every acceptance criterion are model output over an
 * untrusted epic, and `reason` is a human's free text. Render them as text, never as markup. They
 * are stored **redacted** — TD-012 step 2 at the write, in `pipeline/epic-split.ts` for the
 * model's fields and in `decideBreakdown` for `reason` — so what this endpoint publishes is the
 * redacted copy and a placeholder is what a reader sees where a credential was.
 *
 * `ticket_key` and `ticket_url` are what the `createTicket` call produced, and they stay `null`
 * for an accepted child whose call has not happened yet — which is the honest difference between
 * *"accepted"* and *"created"*.
 */
export const ticketBreakdownItemSchema = z.strictObject({
  id: idSchema,
  task_id: idSchema,
  /** Declaration order of the artifact's `children`, which is the order a PM reads them in. */
  position: z.int().nonnegative(),
  title: z.string(),
  description: z.string(),
  acceptance_criteria: z.array(acceptanceCriterionSchema),
  size: sizeSchema,
  rationale: z.string(),
  status: z.enum(['queued', 'accepted', 'rejected']),
  decided_by_user_id: idSchema.nullable(),
  decided_at: isoDateTimeSchema.nullable(),
  /**
   * **A human's own words about the decision, not the platform's** — untrusted text (BD-022).
   *
   * It is typed into the accept/reject command by whoever decided, bounded there by
   * {@link decideBreakdownRequestSchema}'s `MAX_COMMAND_TEXT_CHARS` and stored redacted (TD-012)
   * by `decideBreakdown`, which is why this field carries no cap and no redaction of its own: a
   * value bounded twice has two untestable guards (standing rule 41). Rendered as text like every
   * other string here.
   */
  reason: z.string().nullable(),
  ticket_key: z.string().nullable(),
  ticket_url: urlSchema.nullable(),
  created_at: isoDateTimeSchema,
});

export const taskBreakdownSchema = z.strictObject({
  items: z.array(ticketBreakdownItemSchema),
});

/**
 * `POST /api/tasks/:task_id/breakdown/decide` — the acceptance product/04:117 asks for.
 *
 * **One request, N rows, one decision.** `item_ids` names the children this decision is about, so
 * accepting five of seven is one call and the other two stay `queued`; an empty list is refused by
 * `min(1)` because a decision about nothing is a request that meant to say something else.
 *
 * `reason` is the human's own words and is bounded like every other command's free text. It is
 * recorded on the rows the decision moved — on an acceptance too, because *"why we are building
 * this"* is worth as much as *"why we are not"*  — and it is **redacted where it is stored**
 * (`decideBreakdown`, TD-012), because a stored copy of untrusted human text is TD-012's business
 * wherever it came from (the answer `returnTaskToStage`'s `reason` already gets).
 */
export const decideBreakdownRequestSchema = z.strictObject({
  decision: z.enum(['accept', 'reject']),
  item_ids: z.array(idSchema).min(1).max(MAX_BREAKDOWN_CHILDREN),
  reason: z.string().max(MAX_COMMAND_TEXT_CHARS).optional(),
});

export const decideBreakdownResponseSchema = z.strictObject({
  task_id: idSchema,
  /** `false` for a replayed `Idempotency-Key`: the decision was made and nothing happened twice. */
  performed: z.boolean(),
  accepted: z.int().nonnegative(),
  rejected: z.int().nonnegative(),
  /** Children still waiting for a human after this decision. */
  remaining: z.int().nonnegative(),
});

/**
 * One `human_actions` row of a task — `GET /api/tasks/:task_id/audit` (WP-31 criterion 10,
 * PROGRESS backlog 52).
 *
 * WP-30 shipped the *project* half on the predicate `params->>'project_id'`, which a task command's
 * row never matches because `human_actions` has no `project_id` column. This is the other half, and
 * it is served from the same projection the ask's prompt is built from.
 *
 * `params` is **client-supplied JSON** — it carries the caller's own `Idempotency-Key` and whatever
 * the command chose to record — so it is untrusted at every reader (BD-022) and the SPA renders it
 * through the untrusted path like everything else.
 */
export const taskAuditEntrySchema = z.strictObject({
  id: idSchema,
  action: nonEmptyStringSchema,
  user_id: idSchema.nullable(),
  params: jsonObjectSchema,
  created_at: isoDateTimeSchema,
});

export const taskAuditPageSchema = z.strictObject({ items: z.array(taskAuditEntrySchema) });

/**
 * `POST /api/org/identities` — mapping a provider account to a platform user (WP-31, PROGRESS
 * backlog **79**).
 *
 * `user_identities` has had a reader since WP-15c and **no writer**, so on every instance the map
 * is empty, every ticket and chat author is unmapped, and every answer, approval or ask that
 * arrives from a provider is dropped as `unmapped_identity`. This is the writer, and it is an
 * **operator** saying so rather than either of the two automatic routes: an OAuth sign-in with the
 * provider (TD-022 ships email and password only) or an email match the platform performed itself,
 * which would let a *guessed* identity answer questions and approve plans (BD-022, Q10).
 *
 * `admin`, because the mapping decides who may act as whom.
 */
export const createIdentityMappingRequestSchema = z.strictObject({
  /** The provider id as the registry knows it (`jira-cloud`, `gitlab`, `slack`). */
  provider: nonEmptyStringSchema.max(64),
  /** The account's id **in the provider**, which is what a normaliser resolves against. */
  external_id: nonEmptyStringSchema.max(256),
  user_id: idSchema,
  /** What the provider calls them, for an operator reading the list. Never used to resolve. */
  display_name: z.string().max(256).optional(),
});

export const identityMappingSchema = z.strictObject({
  provider: nonEmptyStringSchema,
  external_id: nonEmptyStringSchema,
  user_id: idSchema,
  display_name: z.string().nullable(),
  created_at: isoDateTimeSchema,
});

export const identityMappingListSchema = z.strictObject({
  items: z.array(identityMappingSchema),
});

export const takeOverResponseSchema = z.strictObject({
  task_id: idSchema,
  state: taskStateSchema,
  current_stage: stageIdSchema.nullable(),
  performed: z.boolean(),
  /** The branch the work is on, always inside BD-025's `agentic/*` namespace. */
  branch: nonEmptyStringSchema,
  /** The session `claude --resume` continues, or `null` when no run of this task ever had one. */
  session_id: nonEmptyStringSchema.nullable(),
  resume_commands: z.array(nonEmptyStringSchema),
  /**
   * What became of the workspace.
   *
   * `requested` — a live run was interrupted and its workspace is being committed, pushed and (if
   * asked for) archived by the launcher as the run ends. `no_live_run` — this task had no run in
   * flight in this process, so there is no workspace to export and the branch is whatever the last
   * run pushed. The two are different facts and a caller renders them differently (standing rule 18).
   */
  workspace_export: z.enum(['requested', 'no_live_run']),
});

/**
 * `GET /api/artifacts/:artifact_id` — one artifact's body (WP-52, PROGRESS backlog 85).
 *
 * `data` is published as **opaque JSON** rather than through `artifactSchema`'s discriminated
 * union, and that is a refusal rather than laziness: the union is strict, so a row written by an
 * older build — or by a type whose schema has since gained a field — would make this endpoint
 * answer 500 instead of showing a reader the document that exists. The SPA renders every string in
 * it as React text nodes (BD-022, `apps/web/src/ui/untrusted.tsx`); nothing here is markup and
 * nothing here is a link.
 *
 * `redaction_count` is on the wire because it is the only signal TD-012 ran at all, and it is
 * **not nullable**: the `null` spelling means *"written before migration 0038, when nothing
 * redacted an artifact"*, and such a row is refused by the route (409 `artifact_not_redacted`)
 * rather than published — this endpoint is a new read surface over exactly the defect backlog 35
 * measured, gated at `artifact.read`, which is `viewer`.
 *
 * **One exception, named rather than left in the gap between two true sentences.** `ShadowReport`
 * is written by `runShadowReport`, which has no run and therefore no TD-012 step-1 secret set, and
 * passes `noSecretsRedactor()` — so its row carries `redaction_count = 0` with **neither** step
 * applied, and it is served here normally. That is PROGRESS backlog **131**, which owns the write.
 * Exposure is unchanged either way: the same document is already served at `project.read`, which is
 * also `viewer`, by `apps/server/src/routes/shadow.ts`. This clause corrects a sentence, it does not
 * open a hole.
 */
export const artifactBodyResponseSchema = z.strictObject({
  id: idSchema,
  task_id: idSchema,
  artifact_type: artifactTypeSchema,
  version: z.int().positive(),
  schema_version: nonEmptyStringSchema,
  produced_by_run_id: idSchema.nullable(),
  created_at: isoDateTimeSchema,
  redaction_count: z.int().nonnegative(),
  markdown: z.string().nullable(),
  data: jsonValueSchema,
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

export const cancelRunRequestSchema = z.strictObject({ reason: commandTextSchema.optional() });

export const retryRunRequestSchema = z.strictObject({
  /**
   * The model to run the new attempt on, bounded at 128 characters (WP-15i).
   *
   * The platform publishes no list of model ids — `agenticConfigSchema`'s `model` is a free string,
   * because a project may pin a model this build has never heard of — so the override cannot be an
   * enum. The bound is the cost ledger's own: `MAX_LEDGER_MODEL_ID_LENGTH` is 128, and a name past
   * it is refused a price row, so a longer one would produce a run whose spend cannot be ledgered.
   */
  model: nonEmptyStringSchema.max(128).optional(),
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

// `putBudgetRequestSchema` lived here from WP-01 until WP-30, unused, one key different from the
// schema the route it was written for actually takes: it had no nullable `limit_usd`, so it could
// set a cap and never remove one. It is deleted rather than kept beside `putBudgetsRequestSchema`,
// because two schemas for one request is the second thing to keep true and the wrong one is the one
// a later caller picks (standing rule 41 applied to a boundary).

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
 * `GET /api/projects/:id/kb/health` — the most recent health report (technical/07 § 6, WP-15h
 * part 2; the row is `kb_health_reports`, migration 0018).
 *
 * **One report, not a page.** The nightly hygiene pass writes a row per project per night, so the
 * table is a history; what a reader wants is the current state of the vault, and a history is a
 * different endpoint with a different question behind it. `created_at` is what makes staleness
 * visible, and `commit_sha` is the indexed commit the findings were computed against — *not* the
 * repository's head, because the pass reads the index (BD-012).
 *
 * Every `path` and `detail` in `findings` is untrusted text: a finding quotes a page somebody
 * committed (BD-022). It is an observation and never an instruction — nothing in the platform
 * deletes or rewrites a page because a finding names it.
 */
export const kbHealthResponseSchema = z.strictObject({
  id: idSchema,
  project_id: idSchema,
  commit_sha: nonEmptyStringSchema.nullable(),
  documents: z.int().nonnegative(),
  findings: z.array(kbHealthFindingSchema),
  /** Which pass produced it: the nightly hygiene sweep, or a Librarian run's own report. */
  source: z.enum(['hygiene', 'librarian']),
  created_at: isoDateTimeSchema,
});

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

/**
 * `PUT /api/projects/:id/autonomy` — select a dial position, or re-apply the one already selected.
 *
 * One command for both, because they are the same operation: BD-027 materialises a preset **at
 * selection time**, so "re-apply preset" is selecting the level the project already has and getting
 * this release's table for it. A `re_apply` flag would be a second name for one statement.
 *
 * `override_reason` is product/18's *"the maintainer can override, visibly"*: readiness **suggests**
 * a cap and never enforces one, so a level above the suggestion is accepted and the reason is
 * recorded in the audit row — redacted, because it is free text a person typed (TD-012).
 */
export const setAutonomyRequestSchema = z.strictObject({
  autonomy: autonomyLevelSchema,
  /** An override above what readiness supports must say why (BD-027). */
  override_reason: z.string().optional(),
});

/** One policy a project has moved away from its materialised preset — the *Custom* list. */
export const autonomyOverrideSchema = z.strictObject({
  /** The `AutonomyPreset` field name, camelCase because it is an identifier and not wire data. */
  policy: nonEmptyStringSchema,
  preset: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  effective: z.union([z.string(), z.number(), z.boolean(), z.null()]),
});

/**
 * `GET /api/projects/:id/autonomy` — the dial, as it is actually in force (WP-30).
 *
 * Everything a screen needs to render BD-027 honestly, and nothing it would have to derive:
 *
 * - `policies` is what the pipeline reads — the **materialised** preset with the project's own
 *   overrides applied — so a screen never re-derives a policy from `level`.
 * - `is_custom` and `overrides` are computed against the materialised preset, never against the
 *   current release's table (`describePresetOverrides`), so a release that edits a preset does not
 *   relabel every project *Custom*.
 * - `preset_outdated` is the reason the "re-apply preset" control exists: the stored
 *   `preset_version` or the stored values differ from what this release ships.
 * - `materialised` is `false` for a project whose dial has never been applied. It is not "the
 *   defaults"; `policies` is then this release's preset for the level, marked as such, and the
 *   pipeline uses its pre-WP-30 gate (standing rule 16).
 * - `suggested_cap` is readiness's **suggestion**, and `above_suggested_cap` says the chosen level
 *   is above it. Neither is a refusal: product/18 and Q21 are explicit that a maintainer overrides
 *   visibly.
 */
export const autonomyResponseSchema = z.strictObject({
  level: autonomyLevelSchema,
  materialised: z.boolean(),
  preset_version: z.int().positive(),
  current_preset_version: z.int().positive(),
  preset_outdated: z.boolean(),
  applied_at: isoDateTimeSchema.nullable(),
  applied_by: idSchema.nullable(),
  policies: autonomyPoliciesSchema,
  is_custom: z.boolean(),
  overrides: z.array(autonomyOverrideSchema),
  readiness_level: z.int().min(0).max(5),
  suggested_cap: autonomyLevelSchema,
  above_suggested_cap: z.boolean(),
});

/**
 * `PUT /api/projects/:id/budgets` and `PUT /api/org/budgets` — BD-010's caps, upserted by window.
 *
 * The natural key is `(scope, scope_id, window)` — the unique index `budgets` already carries — so a
 * project has at most one budget per window and sending the same window twice replaces it. That is
 * why the write is keyed by **window** and not by id: technical/08 sketches
 * `PUT /api/org/budgets/:id`, which has no creator, and until this work package `insert into budgets`
 * occurred in exactly two test files, so every budget in existence was seeded.
 *
 * `limit_usd: null` **deletes** the budget for that window. It is spelled as a null rather than as a
 * `DELETE` route because the whole surface is one upsert and a cap of zero is not the same thing as
 * no cap: zero would block every run for ever (`budgets_limit_positive` refuses it in SQL anyway).
 */
export const putBudgetsRequestSchema = z.strictObject({
  window: z.enum(['day', 'week', 'month', 'total']),
  limit_usd: usdSchema.nullable(),
  notify_pct: z.array(z.int().min(1).max(100)).max(10).optional(),
});

/**
 * `GET /api/projects/:id/audit` — who changed this project's settings (product/18:5, BD-003).
 *
 * `human_actions` had eighteen writers and no reader but the idempotency guard (PROGRESS backlog
 * 52), while product/18 requires *"every toggle records who changed it (audit)"* to be **visible**.
 * This is the settings page's reader.
 *
 * Two things are deliberate. `params` is **opaque**: it carries client-supplied JSON and a
 * client-chosen `Idempotency-Key`, so it renders through the untrusted path like everything else
 * (BD-022). And the scope is the **project's settings**, which is `params->>'project_id'` — a task
 * command's row names a task and not a project, so it is not here; that half of backlog 52 belongs
 * with whichever row builds the task activity feed, and the endpoint's description says so rather
 * than implying this is the whole audit.
 */
export const projectAuditEntrySchema = z.strictObject({
  id: idSchema,
  action: nonEmptyStringSchema,
  user_id: idSchema.nullable(),
  user_email: z.string().nullable(),
  params: jsonObjectSchema,
  created_at: isoDateTimeSchema,
});

export const projectAuditResponseSchema = z.strictObject({
  items: z.array(projectAuditEntrySchema),
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
export type IntegrationsResponse = z.infer<typeof integrationsResponseSchema>;
export type CreateIntegrationRequest = z.infer<typeof createIntegrationRequestSchema>;
export type TestIntegrationResponse = z.infer<typeof testIntegrationResponseSchema>;
export type EffectiveConfigResponse = z.infer<typeof effectiveConfigResponseSchema>;
export type UpdateProjectConfigRequest = z.infer<typeof updateProjectConfigRequestSchema>;
export type ProjectSummary = z.infer<typeof projectSummarySchema>;
export type ProjectsResponse = z.infer<typeof projectsResponseSchema>;
export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;
export type ProjectBindingSummary = z.infer<typeof projectBindingSummarySchema>;
export type ProjectBindingsResponse = z.infer<typeof projectBindingsResponseSchema>;
export type PutProjectBindingsRequest = z.infer<typeof putProjectBindingsRequestSchema>;
export type StartDiscoveryResponse = z.infer<typeof startDiscoveryResponseSchema>;
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;
export type TasksResponse = z.infer<typeof tasksResponseSchema>;
export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>;
export type TaskDetailResponse = z.infer<typeof taskDetailResponseSchema>;
export type TakenOver = z.infer<typeof takenOverSchema>;
export type HumanTimeSummary = z.infer<typeof humanTimeSummarySchema>;
export type HumanTimeByUser = z.infer<typeof humanTimeByUserSchema>;
export type AnswerQuestionRequest = z.infer<typeof answerQuestionRequestSchema>;
export type DecideApprovalRequest = z.infer<typeof decideApprovalRequestSchema>;
export type SubmitFeedbackRequest = z.infer<typeof submitFeedbackRequestSchema>;
export type TaskCommandResponse = z.infer<typeof taskCommandResponseSchema>;
export type TakeOverRequest = z.infer<typeof takeOverRequestSchema>;
export type TakeOverResponse = z.infer<typeof takeOverResponseSchema>;
export type AskTaskRequest = z.infer<typeof askTaskRequestSchema>;
export type AskTaskResponse = z.infer<typeof askTaskResponseSchema>;
export type TaskAsk = z.infer<typeof taskAskSchema>;
export type TaskAskList = z.infer<typeof taskAskListSchema>;
export type TicketBreakdownItem = z.infer<typeof ticketBreakdownItemSchema>;
export type TaskBreakdown = z.infer<typeof taskBreakdownSchema>;
export type DecideBreakdownRequest = z.infer<typeof decideBreakdownRequestSchema>;
export type DecideBreakdownResponse = z.infer<typeof decideBreakdownResponseSchema>;
export type TaskAuditEntry = z.infer<typeof taskAuditEntrySchema>;
export type TaskAuditPage = z.infer<typeof taskAuditPageSchema>;
export type CreateIdentityMappingRequest = z.infer<typeof createIdentityMappingRequestSchema>;
export type IdentityMapping = z.infer<typeof identityMappingSchema>;
export type HandBackRequest = z.infer<typeof handBackRequestSchema>;
export type RunCommandResponse = z.infer<typeof runCommandResponseSchema>;
export type SubmitFeedbackResponse = z.infer<typeof submitFeedbackResponseSchema>;
export type TaskExportResponse = z.infer<typeof taskExportResponseSchema>;
export type ArtifactBodyResponse = z.infer<typeof artifactBodyResponseSchema>;
export type RunMessagesQuery = z.infer<typeof runMessagesQuerySchema>;
export type RunMessagesResponse = z.infer<typeof runMessagesResponseSchema>;
export type SteerRunRequest = z.infer<typeof steerRunRequestSchema>;
export type RetryRunRequest = z.infer<typeof retryRunRequestSchema>;
export type InboxResponse = z.infer<typeof inboxResponseSchema>;
export type KbTreeResponse = z.infer<typeof kbTreeResponseSchema>;
export type KbDocResponse = z.infer<typeof kbDocResponseSchema>;
export type KbProposalsResponse = z.infer<typeof kbProposalsResponseSchema>;
export type KbHealthResponse = z.infer<typeof kbHealthResponseSchema>;
export type AgentsResponse = z.infer<typeof agentsResponseSchema>;
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
export type BudgetsResponse = z.infer<typeof budgetsResponseSchema>;
export type SetAutonomyRequest = z.infer<typeof setAutonomyRequestSchema>;
export type AutonomyResponse = z.infer<typeof autonomyResponseSchema>;
export type AutonomyOverride = z.infer<typeof autonomyOverrideSchema>;
export type HistoryBootstrapEstimate = z.infer<typeof historyBootstrapEstimateSchema>;
export type HistoryBootstrapBlocker = z.infer<typeof historyBootstrapBlockerSchema>;
export type HistoryBootstrapStatus = z.infer<typeof historyBootstrapStatusSchema>;
export type HistoryBootstrapBatch = z.infer<typeof historyBootstrapBatchSchema>;
export type HistoryBootstrapsResponse = z.infer<typeof historyBootstrapsResponseSchema>;
export type StartHistoryBootstrapRequest = z.infer<typeof startHistoryBootstrapRequestSchema>;
export type StartHistoryBootstrapResponse = z.infer<typeof startHistoryBootstrapResponseSchema>;
export type PutBudgetsRequest = z.infer<typeof putBudgetsRequestSchema>;
export type ProjectAuditEntry = z.infer<typeof projectAuditEntrySchema>;
export type ProjectAuditResponse = z.infer<typeof projectAuditResponseSchema>;
export type StartShadowBatchRequest = z.infer<typeof startShadowBatchRequestSchema>;
export type StartShadowBatchResponse = z.infer<typeof startShadowBatchResponseSchema>;
export type ShadowHumanMrSource = z.infer<typeof shadowHumanMrSourceSchema>;
export type ShadowBatchTicket = z.infer<typeof shadowBatchTicketSchema>;
export type ShadowBatchAggregate = z.infer<typeof shadowBatchAggregateSchema>;
export type ShadowBatchSummary = z.infer<typeof shadowBatchSummarySchema>;
export type ShadowBatchesResponse = z.infer<typeof shadowBatchesResponseSchema>;
export type ShadowBatchResponse = z.infer<typeof shadowBatchResponseSchema>;

// ── Statistics (WP-41, product/16, product/19 §10, technical/08 `GET /api/org/stats?range=…`) ──

/**
 * **Q45's statistics half, answered here.**
 *
 * The question was *"no rollup DTO, no CSV shape … decide whether the statistics DTO belongs in
 * WP-19 (which computes the rollups) or WP-41 (which defines the deep-dive metrics)"*. It belongs
 * here, in `packages/contracts`, and the work package that publishes it is the one that defines
 * what each number **means**: a rollup is a table, and a statistic is a table plus a definition,
 * and the definition is the half a screen has to render (product/10:63 — *"every number shown has
 * a tooltip with its definition"*).
 *
 * So the shape is **a list of metrics rather than an object of numbers**, and every metric carries
 * its own definition, its unit, its samples and — this is the part a record of numbers cannot
 * express — its **absence**. A metric this build cannot compute publishes `value: null` with an
 * {@link statAbsenceSchema} saying why and who owns it; it is structurally impossible to publish
 * *"nobody counted"* as a zero, which is standing rule 16 moved from a convention into a type.
 */
export const statUnitSchema = z.enum(['count', 'ratio', 'usd', 'minutes', 'hours']);

/** The metric vocabulary. Platform-chosen, so it is an enum rather than a record's free key. */
export const statMetricIdSchema = z.enum([
  // ── delivery (product/19 §10) ──
  'tasks_started',
  'tasks_delivered',
  'merge_rate',
  'first_pass_acceptance',
  'clean_first_mr_rate',
  'human_intervention_rate',
  'returns_per_delivered_task',
  'cycle_time_hours',
  'agent_time_hours',
  // ── cost (product/16 § "Operational metrics", BD-011) ──
  'cost_total',
  'cost_per_delivered_task',
  'estimated_spend_share',
  'estimate_accuracy',
  'cache_hit_ratio',
  // ── people (product/19 §16, product/18:32) ──
  'question_response_minutes',
  'reviewer_minutes_per_delivered_task',
  'human_minutes',
  // ── knowledge (product/05) ──
  'kb_proposal_acceptance',
  'kb_usage',
  // ── the adoption features' own metrics (product/18:59-63) ──
  'rebase_conflicts_resolved',
  'rebase_conflicts_escalated',
  'concurrent_task_overlaps',
  'review_findings_accepted',
  'review_findings_dismissed',
  'ticket_lint_comments',
  'tickets_edited_after_lint',
  'shadow_similarity',
  // ── named absent, and named because a screen that omits them silently reads as complete ──
  'clean_first_mr_rate_by_author',
  'readiness_attributed_returns',
  'loc_changed',
  'defect_escape',
  'queue_wait_minutes',
  'total_cost_of_delivery',
]);

/**
 * Why a metric has no value, and who would give it one.
 *
 * `owner` is a work package, a PROGRESS backlog entry, an open question or an endpoint that
 * already serves the number — never empty, because *"not measured"* with no address is what turns
 * into a zero on the next screen somebody builds (standing rule 18).
 */
export const statAbsenceSchema = z.strictObject({
  reason: nonEmptyStringSchema,
  owner: nonEmptyStringSchema,
});

/**
 * One bucket of a metric's series.
 *
 * `start` is a **civil date** in the organisation's timezone, not an instant: the buckets are the
 * calendar the cost rollup and the budget windows already use (`rollupDay`, Q12), and rendering
 * them as instants would invite a client to re-bucket them in the reader's zone and disagree with
 * the totals underneath.
 */
export const statBucketSchema = z.strictObject({
  start: isoDateSchema,
  /** Exclusive, so `[start, end)` tiles the range with no overlapping day. */
  end: isoDateSchema,
  value: z.number().nonnegative().finite().nullable(),
  samples: z.int().nonnegative(),
});

export const statMetricSchema = z.strictObject({
  id: statMetricIdSchema,
  label: nonEmptyStringSchema,
  /** product/10:63's tooltip, published **with** the number so the two cannot drift apart. */
  definition: nonEmptyStringSchema,
  unit: statUnitSchema,
  /**
   * The metric over the whole range, or `null` when it is absent or has no samples.
   *
   * `null` with `absent: null` is *"nothing happened in this range"*; `null` with an absence is
   * *"this build cannot measure it"*. A reader that prints `0` for either is wrong in two
   * different ways, which is why they are two fields.
   */
  value: z.number().nonnegative().finite().nullable(),
  samples: z.int().nonnegative(),
  buckets: z.array(statBucketSchema),
  absent: statAbsenceSchema.nullable(),
  /**
   * What is known to be wrong with this number, in its own words.
   *
   * Reviewer minutes carry three (PROGRESS backlog **88**, **89**, **90**) and they do not cancel:
   * a bot that is not this platform inflates a review window, an approval without a comment is
   * invisible, and the eight-hour day cap is applied per entry by the projector. A figure that
   * published none of them would read as measured rather than as approximate.
   */
  caveats: z.array(nonEmptyStringSchema),
});

/** A stage's share of the returns — product/19 §10's *"returns into stage / stage entries"*. */
export const statStageReturnSchema = z.strictObject({
  stage: stageIdSchema,
  entries: z.int().nonnegative(),
  returns: z.int().nonnegative(),
  rate: z.number().nonnegative().finite().nullable(),
});

export const statRangeSchema = z.enum(['7d', '30d', '90d', '365d']);
export const statBucketSizeSchema = z.enum(['day', 'week', 'month']);

export const orgStatsQuerySchema = z.strictObject({
  range: statRangeSchema.optional(),
  bucket: statBucketSizeSchema.optional(),
  /** Narrows every metric to one project; omitted, the answer is the whole organisation. */
  project_id: idSchema.optional(),
  /** `csv` answers `text/csv` with the same numbers (product/10:24's *"CSV export"*). */
  format: z.enum(['json', 'csv']).optional(),
});

export const orgStatsResponseSchema = z.strictObject({
  range: z.strictObject({
    range: statRangeSchema,
    bucket: statBucketSizeSchema,
    /** Inclusive first civil day of the range. */
    from: isoDateSchema,
    /** Inclusive last civil day — *today* in the organisation's timezone. */
    to: isoDateSchema,
    /**
     * The zone the days were cut in (Q12, BD-010). `substituted` is true when the organisation's
     * setting is not a zone this runtime can do calendar arithmetic in and UTC was used instead —
     * the same fail-open the cost ledger makes, said out loud rather than inferred from a total.
     */
    timezone: nonEmptyStringSchema,
    timezone_substituted: z.boolean(),
  }),
  project_id: idSchema.nullable(),
  metrics: z.array(statMetricSchema),
  returns_by_stage: z.array(statStageReturnSchema),
  generated_at: isoDateTimeSchema,
});

export type StatUnit = z.infer<typeof statUnitSchema>;
export type StatMetricId = z.infer<typeof statMetricIdSchema>;
export type StatAbsence = z.infer<typeof statAbsenceSchema>;
export type StatBucket = z.infer<typeof statBucketSchema>;
export type StatMetric = z.infer<typeof statMetricSchema>;
export type StatStageReturn = z.infer<typeof statStageReturnSchema>;
export type StatRange = z.infer<typeof statRangeSchema>;
export type StatBucketSize = z.infer<typeof statBucketSizeSchema>;
export type OrgStatsQuery = z.infer<typeof orgStatsQuerySchema>;
export type OrgStatsResponse = z.infer<typeof orgStatsResponseSchema>;

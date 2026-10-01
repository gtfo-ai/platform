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
  askAnswerCitationSchema,
  kbHealthReportFindingSchema,
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
  knowledgeProposalStatusSchema,
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
import {
  agenticConfigSchema,
  MAX_BOOTSTRAP_MERGE_REQUESTS,
  organisationSettingsSchema,
  riskClassSchema,
} from './config.js';
import { domainEventSchema, domainEventTypeSchema } from './events.js';
import { taskStageOutcomeSchema, taskStageStateSchema } from './pipeline.js';
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
  sha256HexSchema,
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
  /**
   * Why a check is not `ok`, where the check says (WP-86): `agent_runs: "unserved"` — `stage.execute`
   * holds a job nothing has claimed past the bound — or `"unknown"`. Absent when nothing is said.
   */
  details: z.record(z.string(), z.enum(['unserved', 'unknown'])).optional(),
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
  /**
   * Why the stored `config` would be refused by the provider's own schema, or `null` when it
   * parses (WP-100, PROGRESS backlog 328).
   *
   * A row written before the create parsed its configuration can fail at every binding load and
   * every connection test, and the list is where an operator finds it — so the refusal is part of
   * the read rather than a 500 or a silent row. `paths` are key paths, never values; `message` is
   * platform text that names the paths and the `PATCH /api/integrations/:id` that repairs them.
   * `null` too for a provider this build does not ship, whose schema is unknown here.
   */
  config_refusal: z
    .strictObject({
      code: z.literal('invalid_integration_config'),
      message: nonEmptyStringSchema,
      paths: z.array(nonEmptyStringSchema),
    })
    .nullable(),
});

/**
 * One configuration field of a provider, as the create form renders it (WP-100).
 *
 * Read off the provider's own schema by `packages/integrations/src/catalogue.ts`, never copied into
 * the SPA. Credential fields are **not** here: they are `secret_fields` and are configured as
 * environment-variable names (`secret_refs`, TD-020).
 */
export const integrationProviderConfigFieldSchema = z.strictObject({
  name: nonEmptyStringSchema,
  /** The schema refuses a document without it and supplies no default. */
  required: z.boolean(),
  /** Set on the account only, never on a project's binding (`accountOnlyFields`). */
  account_only: z.boolean(),
});

export const integrationProviderSchema = z.strictObject({
  id: nonEmptyStringSchema,
  type: integrationTypeSchema,
  display_name: nonEmptyStringSchema,
  /** Credential fields, each configured by naming an environment variable in `secret_refs`. */
  secret_fields: z.array(nonEmptyStringSchema),
  /** Every non-credential field the provider's schema declares, in declaration order. */
  config_fields: z.array(integrationProviderConfigFieldSchema),
});

/** `GET /api/integrations/providers` — the providers this build ships (WP-100). */
export const integrationProvidersResponseSchema = z.strictObject({
  items: z.array(integrationProviderSchema),
});

/**
 * `PATCH /api/integrations/:id` — change an integration's non-secret configuration (WP-100).
 *
 * `config` sets keys and `remove` deletes them; a key the request names in neither is kept. Two
 * lists rather than JSON merge-patch's `null`, because `null` is a value several provider fields
 * accept (Jira's `pickup_label: null` turns label pickup off) and a delete spelled as a value could
 * not set it. The merged document is parsed with the provider's schema before it is written.
 */
export const patchIntegrationRequestSchema = z
  .strictObject({
    config: jsonObjectSchema.optional(),
    remove: z.array(nonEmptyStringSchema).optional(),
  })
  .refine((body) => body.config !== undefined || body.remove !== undefined, {
    message: 'send `config`, `remove` or both',
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

/** A key a configuration layer states that the platform does not apply, with the reason. */
export const configNotAppliedSchema = z.strictObject({
  key: nonEmptyStringSchema,
  reason: nonEmptyStringSchema,
});

/**
 * The platform's last reading of a project's own `.agentic/config.yml` on its default branch — the
 * `repo` layer's producer (WP-63, Q94, BD-025 §1).
 *
 *  - `unread` — nothing has read it: no knowledge mirror on this instance, no git binding, or no
 *    read has happened yet. The effective configuration then has no `repo` layer, and says so here.
 *  - `absent` — the default branch has no such file.
 *  - `valid` — it parsed and is merged over the settings, winning wherever it states a key (Q94 (a)).
 *  - `invalid` — it did not. `GET …/config` **refuses** with `409 invalid_repository_config` naming
 *    the key paths rather than answering without the layer, and no run of the project starts; the
 *    reading itself (with `detail`) is what `POST …/config/refresh` answers.
 *
 * `not_applied` names the keys the file stated that the platform does not apply, with the reason —
 * today only `policies.autonomy`, because the dial is moved in the platform (BD-027:14). Never a
 * silent drop.
 */
export const repositoryConfigReadingSchema = z.strictObject({
  path: z.literal('.agentic/config.yml'),
  status: z.enum(['unread', 'absent', 'valid', 'invalid']),
  /** The default-branch commit the reading describes; `null` when `unread`. */
  commit_sha: nonEmptyStringSchema.nullable(),
  read_at: isoDateTimeSchema.nullable(),
  /** The key paths an `invalid` file failed on — redacted, bounded, platform-worded. */
  detail: z.string().nullable(),
  not_applied: z.array(configNotAppliedSchema),
});

/**
 * The project's last configuration export as the platform recorded it (WP-91, PROGRESS backlog
 * 225) — read from the export's own `human_actions` row, so a reload no longer loses the merge
 * request the button opened.
 *
 * **As recorded at that press, not re-read**: whether the merge request is still open is the
 * provider's answer, and this read makes no provider call (a `GET` that called out on every page
 * load would spend the binding's rate limit on a card). The export itself re-validates it against
 * the provider before deciding whether to open another (`status: 'open'`).
 */
export const lastConfigExportSchema = z.strictObject({
  status: z.enum(['exported', 'unchanged', 'open']),
  config_hash: nonEmptyStringSchema,
  branch: nonEmptyStringSchema.nullable(),
  merge_request_url: urlSchema.nullable(),
  exported_at: isoDateTimeSchema,
});

/**
 * `GET /api/projects/:id/config` — the effective configuration with per-key provenance
 * (technical/12 § "Effective configuration"). `sources` is keyed by dotted config path.
 *
 * **Two documents since WP-63, and they answer different questions.** `config` is the **settings
 * layer** — the document `PUT …/config` writes and the screens edit, unchanged in meaning so a
 * round trip through the settings screens never copies a default or a repository value into it.
 * `effective` is what the platform runs on: `default < org < project < repo`, the repository
 * winning wherever it states a key (Q94 (a)), with `sources` naming the layer of every leaf — so a
 * key can answer `repo` now that something produces that layer.
 */
export const effectiveConfigResponseSchema = z.strictObject({
  config: agenticConfigSchema,
  /** The merged configuration, every layer applied; `version` is the file format's. */
  effective: agenticConfigSchema,
  sources: z.record(z.string(), configSourceSchema),
  repository: repositoryConfigReadingSchema,
  hash: nonEmptyStringSchema,
  computed_at: isoDateTimeSchema,
  /**
   * What the **settings layer** states that this build does not apply, with the reason (WP-91) —
   * the settings' twin of `repository.not_applied`.
   *
   * Two kinds. Keys nothing reads (`template_overrides.*.enabled` at either level, whose reader
   * waits on Q99; `custom_stages`; a per-stage prompt key whose value names a file outside
   * `.agentic/prompts/` — the prompt files themselves are read since WP-92), which `PUT …/config`
   * also answers with; and a WIP limit above the organisation's maximum, which is read and
   * **bounded** — the organisation's value is what `effective` shows and admission uses.
   */
  not_applied: z.array(configNotAppliedSchema),
  /** The last configuration export, or `null` when this project was never exported (backlog 225). */
  last_export: lastConfigExportSchema.nullable(),
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
   * **`checklists` is what accepting asks the operator to write** (WP-45, PROGRESS backlog 91). Two
   * of product/19 §14's classes require a *"stricter checklist"*, the platform ships no checklist
   * items (Q83), and the configuration schema refuses a class naming a list the document does not
   * define — so every `checklist:<name>` the proposed classes carry is listed here with the classes
   * that select it, product/19's own words for what it is for, and whether this project's document
   * already defines it. Data rather than prose, because the screen renders it: until WP-45 the
   * `payments` class was offered with one of its two documented requirements, and the other was
   * written only in a docblock (standing rule 18: the absent case must not be the quiet one). The
   * `not_expressible` list this replaced named `public_api`, which is now proposed.
   */
  risk_class_proposal: z.strictObject({
    source: z.enum(['discovery', 'platform']),
    classes: z.record(slugSchema, riskClassSchema),
    checklists: z.array(
      z.strictObject({
        name: slugSchema,
        /** The proposed classes whose `require` names this list, in declaration order. */
        required_by: z.array(slugSchema).min(1),
        /** Platform text: what product/19 §14 says the list is for. Never an item. */
        purpose: nonEmptyStringSchema,
        /** Whether this project's configuration already defines `policies.review_checklists.<name>`. */
        defined: z.boolean(),
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

/**
 * `PUT /api/projects/:id/config`'s answer (WP-91). `not_applied` names every key of the written
 * document this build parses and does not read — the write is accepted, never silently inert
 * (the row's ruling: reported at the settings write as it already is at the repository read).
 */
export const updateProjectConfigResponseSchema = z.strictObject({
  hash: nonEmptyStringSchema,
  autonomy_level: nonEmptyStringSchema,
  not_applied: z.array(configNotAppliedSchema),
});

/**
 * `POST /api/projects/:id/config/export` — propose the settings layer as `.agentic/config.yml` (and
 * the `CLAUDE.md` pointer) in a merge request on an `agentic/*` branch (WP-63, Q94 (b) and (c)).
 *
 * `base_hash` pins the export to the document the operator was looking at: a settings write made
 * since is refused `409 config_conflict` rather than exported unseen.
 */
export const exportProjectConfigRequestSchema = z.strictObject({
  base_hash: nonEmptyStringSchema.optional(),
});

export const exportProjectConfigResponseSchema = z.strictObject({
  /**
   * `exported` opened (or, on a replay, had opened) a merge request; `unchanged` needed none;
   * `open` found the previous export's merge request **still open** at the provider and answers it
   * instead of opening a second (WP-91, backlog 225) — `notes` says whether it carries the
   * configuration being exported now.
   */
  status: z.enum(['exported', 'unchanged', 'open']),
  /** `false` when this `Idempotency-Key` had already performed the export: nothing was sent again. */
  performed: z.boolean(),
  config_hash: nonEmptyStringSchema,
  branch: nonEmptyStringSchema.nullable(),
  commit_sha: nonEmptyStringSchema.nullable(),
  merge_request_url: urlSchema.nullable(),
  paths: z.array(nonEmptyStringSchema),
  /** Platform text: what the export left out and why, and why nothing was needed. */
  notes: z.array(nonEmptyStringSchema),
});

/** `POST /api/projects/:id/config/refresh` — re-read the default branch's file now (WP-63). */
export const refreshProjectConfigResponseSchema = z.strictObject({
  repository: repositoryConfigReadingSchema,
  /**
   * Present when **this** reading stored the configuration and withheld the prompt files, because
   * the credentials of one or more of the project's integrations could not be decrypted (WP-107,
   * PROGRESS backlog 358): names each integration and why. Absent when nothing was withheld, and on
   * an `Idempotency-Key` replay, which reads again nothing.
   */
  prompts_withheld: nonEmptyStringSchema.optional(),
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
 * `GET /api/projects/:id/rediscovery` — whether a maintainer may run discovery again, and what it
 * may cost (WP-94, PROGRESS backlog 230, Q107 (a)).
 *
 * The gate is published on the read so the screen says *why* the button is off rather than offering
 * one that answers 409 — the command answers from the same function. `ceiling_usd` is the
 * `discovery` stage's run budget, the figure the admission guard reserves: **a cap, not a
 * prediction**. `last_discovery.cost_usd` is what the project's most recent discovery task actually
 * cost (`tasks.cost_actual`), the nearest thing to an estimate the platform has measured.
 */
export const rediscoveryGateResponseSchema = z.strictObject({
  can_start: z.boolean(),
  blocker: z
    .strictObject({
      code: z.enum([
        'discovery_unavailable',
        'discovery_not_started',
        'discovery_in_flight',
        'rediscovery_attempts_spent',
      ]),
      detail: z.string(),
      /** The live discovery task, for `discovery_in_flight`; otherwise `null`. */
      task_id: idSchema.nullable(),
    })
    .nullable(),
  ceiling_usd: z.number().nonnegative(),
  last_discovery: z
    .strictObject({
      task_id: idSchema,
      state: taskStateSchema,
      cost_usd: z.number().nonnegative(),
    })
    .nullable(),
});

/**
 * `POST /api/projects/:id/interview` — the wizard's step 3, the business interview (product/06,
 * product/19 §8; WP-64).
 *
 * The eight sections of product/19 §8's question bank, each optional: absent is **skip** (writes
 * nothing), `answered` carries the interviewee's text, `not_applicable` marks the section as not
 * applying to this project (product/06: a section is complete when *"filled or explicitly marked
 * 'not applicable'"*). Every string is untrusted (BD-022): the server redacts, then cuts, and a cut
 * is announced in the page rather than silent.
 */
export const BUSINESS_INTERVIEW_SECTION_IDS = [
  'product',
  'users',
  'business_rules',
  'glossary',
  'direction',
  'quality_bar',
  'review',
  'communication',
] as const;
export const businessInterviewSectionIdSchema = z.enum(BUSINESS_INTERVIEW_SECTION_IDS);

/**
 * Longest answer a section accepts, in characters — refused above it at the door, and the same
 * number is the cut applied **after** redaction (a redaction placeholder can be longer than what it
 * replaced). The page budget it is derived from is `MAX_PROPOSAL_DELTA_BYTES`; the derivation is at
 * `@platform/domain`'s `MAX_INTERVIEW_PAGE_OVERHEAD_BYTES`.
 */
export const MAX_INTERVIEW_ANSWER_CHARS = 12_000;
/** Longest "not applicable" reason. */
export const MAX_INTERVIEW_REASON_CHARS = 1_000;

/**
 * No NUL character: `kb_proposals.delta` is `text` and the event payload is `jsonb`, and PostgreSQL
 * refuses `\0` in both — accepting it here turned a caller's bad byte into a 500 at the insert.
 */
const NO_NUL = (value: string): boolean => !value.includes('\0');
const NUL_MESSAGE = 'must not contain a NUL character (U+0000)';

export const businessInterviewAnswerSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('answered'),
    text: z
      .string()
      .max(MAX_INTERVIEW_ANSWER_CHARS)
      .refine(NO_NUL, NUL_MESSAGE)
      .refine(
        (value) => value.trim().length > 0,
        'an answer must say something; omit the section to skip it',
      ),
  }),
  z.strictObject({
    status: z.literal('not_applicable'),
    reason: z.string().max(MAX_INTERVIEW_REASON_CHARS).refine(NO_NUL, NUL_MESSAGE).optional(),
  }),
]);

export const businessInterviewRequestSchema = z
  .strictObject({
    answers: z.strictObject(
      Object.fromEntries(
        BUSINESS_INTERVIEW_SECTION_IDS.map((id) => [id, businessInterviewAnswerSchema.optional()]),
      ) as Record<
        (typeof BUSINESS_INTERVIEW_SECTION_IDS)[number],
        z.ZodOptional<typeof businessInterviewAnswerSchema>
      >,
    ),
  })
  .refine(
    (request) => Object.values(request.answers).some((answer) => answer !== undefined),
    'the interview needs at least one answered or not-applicable section; every section is skipped',
  );

/** One page the interview proposed — a row of the knowledge proposal queue. */
export const businessInterviewResponseSchema = z.strictObject({
  /** `false` when this `Idempotency-Key` already recorded the interview: nothing was written again. */
  performed: z.boolean(),
  pages: z.array(
    z.strictObject({
      proposal_id: idSchema,
      section: businessInterviewSectionIdSchema,
      /** Repository-relative, as the proposal queue stores it. */
      target_path: nonEmptyStringSchema,
      status: knowledgeProposalStatusSchema,
      /** The platform cut the answer at its cap, and the page says so. */
      truncated: z.boolean(),
    }),
  ),
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
      /**
       * Who answered it — `platform` for R9, R11 and R12, `agent` for the other eleven; on a
       * `recheck` row also `platform` for R8 and an observed R3, which the platform read itself.
       */
      detected_by: z.enum(['agent', 'platform']),
    }),
  ),
  /**
   * `readiness_evaluations.source`: which producer wrote this row — `discovery` (the first run),
   * `rediscovery` (a maintainer's re-evaluation, WP-94) or `recheck` (after a merge).
   */
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
  /**
   * **The mining runs' own claim** of how many merge requests they read, summed over the runs that
   * reported one (WP-66, PROGRESS backlog 102) — the model's number, bounded per run by what that
   * run was shown, and published as the model's: nothing compares it, alerts on it or refuses it.
   * `null` when no run of the batch has reported a claim yet, which is not *read nothing* (`0`).
   */
  merge_requests_read_claimed: z.int().nonnegative().nullable(),
  /**
   * The other half of the pair: the **platform's** count of the merge requests it put in the
   * prompts of exactly the runs summed into `merge_requests_read_claimed` (`0` when that is
   * `null`). Published beside it rather than as a ratio — *"read 37 of 200"* is two facts, a
   * percentage is a derived number one screen would then own (standing rule 9).
   */
  merge_requests_read_of: z.int().nonnegative(),
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
 * the projection reads it off the append-only log.
 *
 * **Which log events decide it is one list, shared with the workpad** (WP-44, PROGRESS backlog 164):
 * the newest of `TAKE_OVER_BOUNDARY_EVENTS` (`packages/application/src/pipeline/store.ts`) being
 * `task.taken_over`, with **no state guard**. So a hand-back, a resume, a stage entry, a completion
 * or a cancellation withdraws it, and an **escalation does not** — a take-over the inactivity timer
 * parked in `needs_human` is still held, and the page that carries the hand-back control keeps
 * saying where the branch is, as the ticket's workpad does. Until WP-44 this read two event types
 * and published nothing unless the task was `paused`, so the two surfaces disagreed on exactly the
 * task whose escalation brief says *"the work is on `<branch>`"*.
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
  /**
   * The user who took the task over, from the `task.taken_over` event's actor (WP-44). `null` for a
   * take-over recorded by something other than a person, which no route produces.
   */
  held_by: idSchema.nullable(),
  /**
   * The run the take-over interrupted, as the `task.taken_over` event recorded it (WP-73, PROGRESS
   * backlog 203): `null` when no run was live, so nothing was exported. Meaningful only when
   * {@link run_recorded} is `true`.
   */
  run_id: idSchema.nullable(),
  /**
   * Whether the event recorded {@link run_id} at all. `false` for a take-over recorded before
   * WP-73, whose screen can only **infer** the run — and says that it is an inference.
   */
  run_recorded: z.boolean(),
  /**
   * Every stage a hand-back may name: the task's **compiled** pipeline, enabled stages only, in
   * pipeline order (WP-44, criterion 2). The same list `POST …/hand-back` checks against —
   * `compilePipeline` over the task's frozen template — so the picker offers nothing the route
   * would refuse with `409 stage_not_in_template`. Empty when the task's template cannot be
   * compiled on this build, which the screen says rather than offering a free-text field.
   */
  hand_back_stages: z.array(stageIdSchema),
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
  /**
   * What the total **leaves out on purpose**, so the page is never silently lower (WP-44, PROGRESS
   * backlog 190): the review windows an `mr.approved` touched, which the statistics withhold for the
   * same reason (backlog 188 — the approval's `user` is an inference until a real GitLab confirms
   * it). Neither `entries` nor any bucket above counts them. The rows of an account declared a
   * **machine** after the fact are not here at all: they are not human time, and the statistics drop
   * them the same way. The two predicates are one module, shared with the statistics read
   * (`apps/server/src/queries/human-time-predicates.ts`).
   */
  withheld: z.strictObject({
    entries: z.int().nonnegative(),
    minutes: z.number().nonnegative(),
  }),
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
      /** `task_stages.state`, parsed rather than mapped (WP-55): see {@link taskStageStateSchema}. */
      state: taskStageStateSchema,
      entered_at: isoDateTimeSchema,
      exited_at: isoDateTimeSchema.nullable(),
      /** `task_stages.outcome` in its one vocabulary (WP-73): see {@link taskStageOutcomeSchema}. */
      outcome: taskStageOutcomeSchema.nullable(),
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

/**
 * `POST /api/runs/:id/steer` — **accepted**, not delivered (WP-85, TD-028 decision 9).
 *
 * The process that answers a steer is, on the shipped topology, never the process holding the run,
 * so the answer is `202` and says only that the command was recorded: `command_id` names the
 * `run_commands` row, and the run screen reads whether it was then **applied** or **refused**
 * (`GET /api/runs/:id/commands`). Never a claim that the model heard it.
 */
export const steerRunResponseSchema = runCommandResponseSchema.extend({
  command_id: idSchema,
});

/**
 * `POST /api/runs/:id/cancel` — which of TD-028 decision 11's two branches it took (WP-101).
 *
 * `command_id` names the `run_commands` row the process holding the session applies as its stop,
 * and the answer is then `202`: the run's `status` is still live and becomes `cancelled` when that
 * process ends it, with the cost the session measured. `null` when no process held the run's lease,
 * and the answer is `200`: the record was ended in place and `status` already reads `cancelled`.
 */
export const cancelRunResponseSchema = runCommandResponseSchema.extend({
  command_id: idSchema.nullable(),
});

/** The three commands that reach a live run through the database (WP-85; `cancel` since WP-101). */
export const runCommandKindSchema = z.enum(['steer', 'take_over', 'cancel']);

/**
 * Why a recorded run command was not applied (WP-85). `run_ended`: the run ended while the command
 * was pending — closed by the run's own ending, so it is never applied late. `register_miss`: the
 * process holding the run's lease found no live session for it. `delivery_failed`: the holder took
 * the command and the live session refused it (the session was closing) — it is not retried.
 * `undecodable`: the stored command is in a shape this build cannot deliver.
 */
export const runCommandRefusalSchema = z.enum([
  'run_ended',
  'register_miss',
  'delivery_failed',
  'undecodable',
]);

/**
 * One `run_commands` row as the run screen reads it (WP-85).
 *
 * `state` is derived from the two stamps and is there so a client does not re-derive it. `message`
 * is the steer's text **as the platform stored it** — redacted once by the command (TD-012) — and
 * `null` for a take-over's or a cancel's stop; it is untrusted text (BD-022) and is rendered as such.
 */
export const runCommandRecordSchema = z.strictObject({
  id: idSchema,
  run_id: idSchema,
  kind: runCommandKindSchema,
  state: z.enum(['pending', 'applied', 'refused']),
  message: z.string().nullable(),
  author_user_id: idSchema.nullable(),
  created_at: isoDateTimeSchema,
  applied_at: isoDateTimeSchema.nullable(),
  refused_at: isoDateTimeSchema.nullable(),
  refused_reason: runCommandRefusalSchema.nullable(),
});

/** `GET /api/runs/:id/commands` — the run's commands, newest first, bounded (WP-85). */
export const runCommandsResponseSchema = z.strictObject({
  items: z.array(runCommandRecordSchema),
});

/** The most run commands one read returns. */
export const MAX_RUN_COMMANDS = 100;

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
  /**
   * Whether **this caller** may accept or reject children — `task.approve_plan` at their effective
   * role in the task's project, decided by the server's own `can()` (WP-44, criterion 3).
   *
   * The screen reads it to leave the control **out** for a member and a viewer rather than drawing a
   * button that answers 403; the SPA's session carries only the organisation role, and a project
   * membership can raise it, so the answer has to come from where the guard is. It is advice about
   * the control, never the permission: the decide route checks the same thing again.
   */
  can_decide: z.boolean(),
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
const identityAccountShape = {
  /** The provider id as the registry knows it (`jira-cloud`, `gitlab`, `slack`). */
  provider: nonEmptyStringSchema.max(64),
  /** The account's id **in the provider**, which is what a normaliser resolves against. */
  external_id: nonEmptyStringSchema.max(256),
  /** What the provider calls them, for an operator reading the list. Never used to resolve. */
  display_name: z.string().max(256).optional(),
} as const;

/**
 * The two statements an operator can make about a provider account (WP-61, PROGRESS backlog 88):
 * it is a **person's** — `user_id` names them — or it is a **machine** — a CI bot, a dependency
 * updater — which maps to nobody on purpose, so none of its merge-request activity is counted as a
 * human reviewing and nothing it writes is acted on.
 *
 * `kind` may be omitted for a person, so every request WP-31's command accepted is still accepted
 * and means what it meant. A machine carries **no** `user_id`: the union is two strict objects, so
 * `{kind: 'machine', user_id: …}` is refused rather than half-honoured. It is declared, never
 * inferred — the platform reads no `[bot]` suffix and no provider bot flag (BD-022, Q10).
 */
export const createIdentityMappingRequestSchema = z.union([
  z.strictObject({
    ...identityAccountShape,
    kind: z.literal('person').optional(),
    user_id: idSchema,
  }),
  z.strictObject({
    ...identityAccountShape,
    kind: z.literal('machine'),
  }),
]);

export const identityKindSchema = z.enum(['person', 'machine']);

export const identityMappingSchema = z.strictObject({
  provider: nonEmptyStringSchema,
  external_id: nonEmptyStringSchema,
  /** `person` — `user_id` is set; `machine` — an operator declared the account a bot (WP-61). */
  kind: identityKindSchema,
  /** The platform user, or `null` exactly when `kind` is `machine`. */
  user_id: idSchema.nullable(),
  display_name: z.string().nullable(),
  created_at: isoDateTimeSchema,
});

export const identityMappingListSchema = z.strictObject({
  items: z.array(identityMappingSchema),
});

/**
 * A provider account the platform refused a delivery for because nobody mapped it — a candidate
 * for `POST /api/org/identities` (WP-44, PROGRESS backlog 198).
 *
 * Read off `inbox.unmapped_identities` (migration 0047), excluding every account already mapped or
 * declared a machine. **A proposal, never a write**: the identities screen offers it to fill the
 * form, and an admin still decides who the account is. `external_id` is the provider's own account
 * id — untrusted text (BD-022), rendered, never parsed.
 */
export const identityCandidateSchema = z.strictObject({
  provider: nonEmptyStringSchema,
  external_id: nonEmptyStringSchema,
  /** How many refused deliveries named this account. */
  deliveries: z.int().positive(),
  last_seen_at: isoDateTimeSchema,
});

export const identityCandidateListSchema = z.strictObject({
  items: z.array(identityCandidateSchema),
});

/**
 * One inbound delivery that produced no event, or was partly refused — `GET
 * /api/integrations/:integration_id/refused-deliveries` (WP-44, PROGRESS backlog 198).
 *
 * `error` is `inbox.error`: the adapter's and the aggregate's reasons, one per line, **redacted at
 * the write** and bounded there (`MAX_INBOX_ERROR_CHARS`). It is provider-derived text (BD-022).
 * `unmapped` is the accounts the delivery was refused for as `unmapped_identity` — `null` for a row
 * written before migration 0047, which recorded no list ("not recorded" is not "none").
 *
 * **Only refusals are served** (WP-73b, PROGRESS backlog 206): a row whose `reasons` include one
 * an operator must act on — `REFUSED_DELIVERY_REASONS` in `@platform/application`'s inbox port is
 * the one list — and never an ordinary ignore. `reasons` are the platform's own codes, `null` for
 * a row written before migration 0055, which recorded none and is served because it cannot be told
 * apart.
 */
export const refusedDeliverySchema = z.strictObject({
  delivery_id: z.string(),
  received_at: isoDateTimeSchema,
  error: z.string(),
  reasons: z.array(nonEmptyStringSchema).nullable(),
  unmapped: z
    .array(z.strictObject({ provider: nonEmptyStringSchema, external_id: nonEmptyStringSchema }))
    .nullable(),
});

export const refusedDeliveriesResponseSchema = z.strictObject({
  /** Newest first, at most {@link MAX_REFUSED_DELIVERIES}. */
  items: z.array(refusedDeliverySchema),
});

/** The most refused deliveries one read returns: a debugging surface, not an archive. */
export const MAX_REFUSED_DELIVERIES = 50;

// ── Dead letters (WP-95, PROGRESS backlog 126) ──────────────────────────────

/** The most dead letters one page of `GET /api/org/dead-letters` returns. */
export const MAX_DEAD_LETTERS_PAGE = 100;

/**
 * Longest `error` a dead letter is published with, **after** redaction. A handler's message can
 * quote a provider or a URL, so it is redacted by the platform's patterns and then bounded — in that
 * order, for the reason `routes/settings.ts`'s `auditedText` states.
 */
export const MAX_DEAD_LETTER_ERROR_CHARS = 2_000;

/**
 * One event whose dispatch spent `APP_DISPATCH_MAX_ATTEMPTS` (WP-49) — a row of `event_dispatch`
 * carrying `dead_lettered_at`, joined to its event in the log.
 *
 * `event_type` and `stream_type` are **strings, not the catalogue's enums**: a schema change under a
 * queued event is one of the ways an event is dead-lettered at all, and a read that refused a type
 * this build no longer knows would hide exactly the row an operator is looking for. `handler` is
 * the handler whose failure spent the bound (`dead_letter_handler`). `error` is the last failure's
 * text, redacted and bounded (`error_truncated` says whether the bound cut it); it is the platform's
 * own handler's words, but they may quote provider text, so it is rendered as text (BD-022).
 *
 * `task` is the task the dead-letter sink escalated — the event's own stream when that is a task,
 * else its `correlation_id` — **when that task exists**; `null` for an event that names none, which
 * is the population with no brief anywhere and the reason this read exists.
 */
export const deadLetterSchema = z.strictObject({
  position: z.int().positive(),
  event_type: nonEmptyStringSchema,
  stream_type: nonEmptyStringSchema,
  stream_id: idSchema,
  occurred_at: isoDateTimeSchema,
  dead_lettered_at: isoDateTimeSchema,
  handler: nonEmptyStringSchema.nullable(),
  attempts: z.int().nonnegative(),
  error: z.string().max(MAX_DEAD_LETTER_ERROR_CHARS).nullable(),
  error_truncated: z.boolean(),
  task: z
    .strictObject({
      id: idSchema,
      ticket_key: nonEmptyStringSchema,
      project_key: nonEmptyStringSchema,
    })
    .nullable(),
});

/**
 * `GET /api/org/dead-letters` — newest position first, paged by an **opaque** cursor.
 *
 * `total` is every dead letter there is (`countDeadLettered`, the gauge's own statement), so a page
 * of fifty is never read as "fifty poisoned events" (standing rule 16).
 */
export const deadLettersResponseSchema = z.strictObject({
  items: z.array(deadLetterSchema),
  total: z.int().nonnegative(),
  next_cursor: nonEmptyStringSchema.nullable(),
});

export const deadLetterParamsSchema = z.strictObject({
  position: z.coerce.number().int().positive(),
});

/**
 * `POST /api/org/dead-letters/:position/requeue` — the answer.
 *
 * `performed: false` is an `Idempotency-Key` replay: the first request under the key re-queued the
 * event and this one performed nothing. `requeued_at` is when the row went back to the queue — the
 * first request's instant on a replay, read from its audit row.
 */
export const requeueDeadLetterResponseSchema = z.strictObject({
  position: z.int().positive(),
  performed: z.boolean(),
  requeued_at: isoDateTimeSchema,
});

// ── Failed jobs (WP-108, PROGRESS backlog 325) ──────────────────────────────

/** The most failed jobs one read of `GET /api/org/failed-jobs` returns. */
export const MAX_FAILED_JOBS_PAGE = 100;

/** Longest `error` a failed job is published with, **after** redaction — the dead letter's bound. */
export const MAX_FAILED_JOB_ERROR_CHARS = MAX_DEAD_LETTER_ERROR_CHARS;

/**
 * Whether a queue's handler ends its own failures or relies on pg-boss's retries — the census in
 * `@platform/application`'s `job-exhaustion.ts` (WP-108).
 */
export const jobExhaustionKindSchema = z.enum(['bounds_itself', 'relies_on_retries']);

/**
 * One job pg-boss moved to `failed` after its last retry (WP-108, backlog 325).
 *
 * `queue` is a **string**, not an enum: a job of a queue this build no longer declares is one way to
 * be listed here, and `exhaustion` is then `null`. `attempts` is the first run plus every retry.
 * `error` is the failure's message, **redacted and then bounded** (`error_truncated` says whether the
 * bound cut it) and rendered as text (BD-022). The job's **payload is never published**: nothing an
 * operator decides here needs it, and it can carry provider text. There is no re-queue: what a lost
 * job left is the recovery pass's or a human's, named by `recovered_by`.
 */
export const failedJobSchema = z.strictObject({
  id: nonEmptyStringSchema,
  queue: nonEmptyStringSchema,
  attempts: z.int().positive(),
  retry_limit: z.int().nonnegative(),
  created_at: isoDateTimeSchema,
  failed_at: isoDateTimeSchema,
  error: z.string().max(MAX_FAILED_JOB_ERROR_CHARS).nullable(),
  error_truncated: z.boolean(),
  exhaustion: z
    .strictObject({
      kind: jobExhaustionKindSchema,
      loss: nonEmptyStringSchema,
      recovered_by: nonEmptyStringSchema.nullable(),
    })
    .nullable(),
});

/**
 * `GET /api/org/failed-jobs` — newest failure first, at most `limit`. `total` is every failed job
 * pg-boss still keeps (its retention, not the platform's), so a page is never read as the whole
 * (standing rule 16).
 */
export const failedJobsResponseSchema = z.strictObject({
  items: z.array(failedJobSchema),
  total: z.int().nonnegative(),
});

export const failedJobsQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(MAX_FAILED_JOBS_PAGE).optional(),
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

/** How many events one task export carries at most (WP-112, PROGRESS backlog 310). */
export const MAX_TASK_EXPORT_EVENTS = 1_000;

/** How many `human_actions` rows one task export carries at most (WP-112). */
export const MAX_TASK_EXPORT_HUMAN_ACTIONS = 1_000;

/**
 * One row of the event log as the export publishes it — **as stored**, not parsed against today's
 * catalogue (WP-112).
 *
 * `events` is append-only (TD-005) and holds every event written under every earlier version of
 * {@link domainEventSchema}: a `task.taken_over` from before WP-73 has no `run_id`, and a strict
 * parse of such a row would refuse the export of every task older than the schema change it
 * predates. So `type` is a string and `payload`/`actor` are opaque JSON, and the envelope's
 * columns are published beside them. `position` is the log's own order.
 *
 * `payload` has passed the platform's pattern redaction (TD-012 step 2) **at this read**, because
 * the log carries no record of what was redacted when the row was written; `events.redaction_count`
 * counts what this read replaced. Every string in it is untrusted (BD-022) — ticket comments,
 * review comments and steer messages are provider and human text.
 */
export const taskExportEventSchema = z.strictObject({
  position: z.int().nonnegative(),
  id: idSchema,
  type: nonEmptyStringSchema,
  stream_type: nonEmptyStringSchema,
  stream_id: idSchema,
  stream_seq: z.int().nonnegative(),
  correlation_id: idSchema.nullable(),
  cause_event_id: idSchema.nullable(),
  actor: jsonObjectSchema,
  occurred_at: isoDateTimeSchema,
  payload: jsonObjectSchema,
});

/**
 * `GET /api/tasks/:task_id/export` — product/09:45's *"Export as JSON per task"* (WP-112, PROGRESS
 * backlog 310), gated at `task.export` and scoped to the task's project.
 *
 * **One document built from the read projections that already exist**, never from a second reading
 * of the tables: everything `GET /api/tasks/:id` publishes (the task, its take-over, its human time,
 * its stage attempts, its artifacts' **metadata**, its questions, its approvals and its run
 * records — each run with its `settings_hash`), the task's `human_actions` rows as
 * `GET /api/tasks/:id/audit` projects them, and the task's events. What it does **not** carry is
 * stated rather than implied:
 *
 *  - **Transcripts** stay on their own download (`GET /api/runs/:id/transcript.jsonl`); a run's
 *    record names its id.
 *  - **Artifact bodies** stay on `GET /api/artifacts/:id`, which refuses a body stored before it
 *    was redacted; each reference carries that path as `url`.
 *  - **Settings snapshots** stay on `GET /api/runs/:id/settings`; the export carries the hash.
 *
 * Two parts grow without bound and are **capped**, with the cap and whether it cut stated:
 * `events` (the task's own stream and every event correlated to it, oldest first, at most
 * {@link MAX_TASK_EXPORT_EVENTS}) and `human_actions` (oldest first, at most
 * {@link MAX_TASK_EXPORT_HUMAN_ACTIONS}). `truncated: true` means rows exist past the cap and are
 * not in this document.
 *
 * **`human_actions` is `null` for a caller who may not read the task's audit** —
 * `GET /api/tasks/:id/audit` is `org.audit.read` (maintainer) while `task.export` is `member`, and
 * an export is not a way around the narrower read. `null` is that statement, never "no actions".
 */
export const taskExportResponseSchema = z.strictObject({
  /** The document's format; bumped when its shape changes, so a reader can tell. */
  format: z.literal(1),
  exported_at: isoDateTimeSchema,
  ...taskDetailResponseSchema.shape,
  human_actions: z
    .strictObject({
      items: z.array(taskAuditEntrySchema),
      limit: z.int().positive(),
      truncated: z.boolean(),
    })
    .nullable(),
  events: z.strictObject({
    items: z.array(taskExportEventSchema),
    limit: z.int().positive(),
    truncated: z.boolean(),
    /** Replacements the pattern redaction made in this document's event payloads, at this read. */
    redaction_count: z.int().nonnegative(),
  }),
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

/**
 * `GET /api/runs/:run_id/settings` — the configuration a run was planned with (WP-112, PROGRESS
 * backlog 309), gated at `transcript.read`: the document carries text an operator typed (checklist
 * items, reviewer handles, status names), which is content rather than metadata.
 *
 * `snapshot` is `runs.settings_snapshot` **as stored** — redacted with the run's own TD-012
 * redactor at the write (WP-91) and opaque here, because its shape is the platform's
 * `format`-versioned document rather than a published record. A document over 256 KiB was stored
 * as the marker `{format, truncated: true, bytes}` and is served as that marker: the hash is then
 * the one record of the full document. A run created before WP-91 has no snapshot and is refused
 * `409 settings_not_recorded`, never served `{}`.
 */
export const runSettingsResponseSchema = z.strictObject({
  settings_hash: sha256HexSchema,
  snapshot: jsonObjectSchema,
});

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
  findings: z.array(kbHealthReportFindingSchema),
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
 * - `organisation_maximum` is the organisation's `autonomy.maximum` (WP-93), or `null` when it
 *   states none, and **that one is a ceiling**: selecting above it is refused. `level_in_force` is
 *   the lower of `level` and it — a project chosen above a maximum lowered later runs at the
 *   maximum from the next read, and `policies` is then that position's preset in this release
 *   (the project never chose it, so it has no materialised copy of it). `level` stays what the
 *   project chose.
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
  organisation_maximum: autonomyLevelSchema.nullable(),
  level_in_force: autonomyLevelSchema,
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
 * `GET /api/org` — the organisation settings document (WP-93, technical/08 § Org).
 *
 * `settings` is `organizations.settings` **parsed** through `organisationSettingsSchema`: a stored
 * document it refuses is a `409 invalid_organisation_config` naming the key paths and the values,
 * never an empty document. `updated_at` is `null` on an instance whose organisation row does not
 * exist yet (it is created with the first project); `settings` is then `{}`.
 */
export const orgSettingsResponseSchema = z.strictObject({
  settings: organisationSettingsSchema,
  updated_at: isoDateTimeSchema.nullable(),
});

/**
 * `PATCH /api/org` — replace sections of the organisation settings document (WP-93).
 *
 * Each top-level key present **replaces** that section; `null` **removes** it; an absent key leaves
 * it as stored. The merged document is validated by `organisationSettingsSchema` before it is
 * written, so a value the readers would refuse is refused at the write. Admin only
 * (`org.settings.write`) and audited in `human_actions`.
 */
/** One section of the document, as the request may name it: replaced, or `null` to remove. */
const replacedSection = <T extends z.ZodType>(section: z.ZodOptional<T>) =>
  section.unwrap().nullable().optional();

export const patchOrgSettingsRequestSchema = z
  .strictObject({
    commands: replacedSection(organisationSettingsSchema.shape.commands),
    autonomy: replacedSection(organisationSettingsSchema.shape.autonomy),
    pipeline: replacedSection(organisationSettingsSchema.shape.pipeline),
    notifications: replacedSection(organisationSettingsSchema.shape.notifications),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'name at least one section to replace or remove',
  });

export const patchOrgSettingsResponseSchema = z.strictObject({
  settings: organisationSettingsSchema,
  /** The top-level sections this request replaced or removed. */
  changed: z.array(z.enum(['commands', 'autonomy', 'pipeline', 'notifications'])),
  performed: z.boolean(),
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
export type IntegrationProviderConfigField = z.infer<typeof integrationProviderConfigFieldSchema>;
export type IntegrationProvider = z.infer<typeof integrationProviderSchema>;
export type IntegrationProvidersResponse = z.infer<typeof integrationProvidersResponseSchema>;
export type PatchIntegrationRequest = z.infer<typeof patchIntegrationRequestSchema>;
export type EffectiveConfigResponse = z.infer<typeof effectiveConfigResponseSchema>;
export type UpdateProjectConfigRequest = z.infer<typeof updateProjectConfigRequestSchema>;
export type RepositoryConfigReading = z.infer<typeof repositoryConfigReadingSchema>;
export type ExportProjectConfigRequest = z.infer<typeof exportProjectConfigRequestSchema>;
export type ExportProjectConfigResponse = z.infer<typeof exportProjectConfigResponseSchema>;
export type UpdateProjectConfigResponse = z.infer<typeof updateProjectConfigResponseSchema>;
export type LastConfigExport = z.infer<typeof lastConfigExportSchema>;
export type ConfigNotApplied = z.infer<typeof configNotAppliedSchema>;
export type RefreshProjectConfigResponse = z.infer<typeof refreshProjectConfigResponseSchema>;
export type ProjectSummary = z.infer<typeof projectSummarySchema>;
export type ProjectsResponse = z.infer<typeof projectsResponseSchema>;
export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;
export type ProjectBindingSummary = z.infer<typeof projectBindingSummarySchema>;
export type ProjectBindingsResponse = z.infer<typeof projectBindingsResponseSchema>;
export type PutProjectBindingsRequest = z.infer<typeof putProjectBindingsRequestSchema>;
export type StartDiscoveryResponse = z.infer<typeof startDiscoveryResponseSchema>;
export type RediscoveryGateResponse = z.infer<typeof rediscoveryGateResponseSchema>;
export type BusinessInterviewRequest = z.infer<typeof businessInterviewRequestSchema>;
export type BusinessInterviewResponse = z.infer<typeof businessInterviewResponseSchema>;
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;
export type TasksResponse = z.infer<typeof tasksResponseSchema>;
export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>;
export type TaskDetailResponse = z.infer<typeof taskDetailResponseSchema>;
export type TakenOver = z.infer<typeof takenOverSchema>;
export type IdentityCandidate = z.infer<typeof identityCandidateSchema>;
export type RefusedDelivery = z.infer<typeof refusedDeliverySchema>;
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
export type CancelRunResponse = z.infer<typeof cancelRunResponseSchema>;
export type SteerRunResponse = z.infer<typeof steerRunResponseSchema>;
export type RunCommandKind = z.infer<typeof runCommandKindSchema>;
export type RunCommandRefusal = z.infer<typeof runCommandRefusalSchema>;
export type RunCommandRecord = z.infer<typeof runCommandRecordSchema>;
export type RunCommandsResponse = z.infer<typeof runCommandsResponseSchema>;
export type SubmitFeedbackResponse = z.infer<typeof submitFeedbackResponseSchema>;
export type TaskExportResponse = z.infer<typeof taskExportResponseSchema>;
export type TaskExportEvent = z.infer<typeof taskExportEventSchema>;
export type RunSettingsResponse = z.infer<typeof runSettingsResponseSchema>;
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
export type DeadLetter = z.infer<typeof deadLetterSchema>;
export type DeadLettersResponse = z.infer<typeof deadLettersResponseSchema>;
export type FailedJob = z.infer<typeof failedJobSchema>;
export type FailedJobsResponse = z.infer<typeof failedJobsResponseSchema>;
export type RequeueDeadLetterResponse = z.infer<typeof requeueDeadLetterResponseSchema>;
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
export type OrgSettingsResponse = z.infer<typeof orgSettingsResponseSchema>;
export type PatchOrgSettingsRequest = z.infer<typeof patchOrgSettingsRequestSchema>;
export type PatchOrgSettingsResponse = z.infer<typeof patchOrgSettingsResponseSchema>;
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
   * Reviewer minutes carry three (PROGRESS backlog **88**, **188**, **89**) and they do not cancel:
   * a bot nobody declared a machine inflates a review window, every window an approval touched is
   * withheld until the real-GitLab check of the approver is taken (an approval without a comment
   * has been visible since WP-60, `mr.approved`), and the eight-hour day cap is applied per review
   * window by the projector. A figure that published none of them would read as measured rather
   * than as approximate. Since WP-61 some caveats also carry counts from the rows (the withheld
   * windows, the defect rate's coverage).
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

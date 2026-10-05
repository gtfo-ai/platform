/**
 * `.agentic/config.yml` — the repository-side, non-secret configuration.
 *
 * Source: docs/technical/12-configuration-and-schemas.md § "`.agentic/config.yml`".
 *
 * Three rules from that document are load-bearing and are enforced here:
 *  1. **Unknown keys are errors.** Every object is strict; validation fails loudly rather than
 *     silently ignoring a typo in a setting an operator believes is active.
 *  2. **Secrets are never accepted from the repo.** No field in this schema takes a credential.
 *  3. **`version` is a major.** The platform refuses unknown majors, so it is a literal.
 *
 * The maps whose keys are user-chosen — `pipeline.template_overrides`, `stages`,
 * `policies.risk_classes`, `status_mapping` — are records with a constrained key schema. There
 * "unknown key" is not a concept: an unexpected *key* is the payload, and an unexpected *value*
 * shape still fails.
 */
import * as z from 'zod';
import {
  autonomyLevelSchema,
  communicationLanguageSchema,
  DEPENDENCY_ECOSYSTEMS,
  dependencyEcosystemSchema,
  dependencyPolicyValueSchema,
  durationSchema,
  effortSchema,
  idSchema,
  MAX_ROUTED_REVIEWERS,
  nonEmptyStringSchema,
  pathPatternSchema,
  SLUG_PATTERN,
  severitySchema,
  sizeSchema,
  slugSchema,
  stageIdSchema,
  templateIdSchema,
  timeOfDaySchema,
  tokenCountSchema,
  unitIntervalSchema,
  urgentNotificationClassSchema,
  usdSchema,
} from './common.js';
import { customStageSchema } from './pipeline.js';

// ── project ──────────────────────────────────────────────────────────────────

/**
 * The ceiling on one run's context-pack budget — **57 500 estimated tokens since WP-83** (it was
 * 200 000 from WP-17 until then).
 *
 * PROGRESS backlog 13: `tokenCountSchema` is `z.int().nonnegative()`, so a project could configure
 * a budget of any size and pay for the pack that filled it on **every stage run**. The bound is at
 * the boundary rather than in the assembler because a configuration that cannot be satisfied should
 * be refused where it is written, not silently clamped where it is spent.
 *
 * ## The arithmetic (WP-83, PROGRESS backlog 173)
 *
 * A budget is denominated in `estimateTokens` (`@platform/domain`, `ceil(utf8Bytes / 4)`), and that
 * estimator is **not an upper bound**: on the Czech text `tokens.test.ts` pins it reads 260 where a
 * real byte-level tokeniser counted 452 — an estimate/real ratio of **0.575**, the worst of the four
 * texts measured (WP-58; the tokeniser is `@anthropic-ai/tokenizer@0.0.4`, a proxy, **not** claimed
 * to be the current models'). The old ceiling was therefore 200 000 / 0.575 ≈ **347 826** real
 * tokens on a Czech vault, past the whole window it was meant to fit.
 *
 *  1. **The window**: 200 000 tokens, the smallest in the current Claude line-up — Haiku 4.5; Opus 5,
 *     Sonnet 5 and Fable 5.1 are 1 M ([models overview](https://platform.claude.com/docs/en/models/overview),
 *     retrieved 2026-09-12). A stage can be routed to any of them.
 *  2. **The pack's share: half of it, 100 000 real tokens.** The pack is layers 4–5 of six; the
 *     same window holds the CLI's system prompt, the role prompt, the ticket snapshot (up to 45 632
 *     characters), each prior artifact (up to 20 000 characters), the return feedback (8 000), and
 *     every turn the run then takes — each tool result stays in context until compaction. The half
 *     is a judgement, not a measurement, and it is stated as one.
 *  3. **In estimated tokens**: 100 000 × 0.575 = **57 500** — the exact figure is 100 000 × 260 / 452
 *     = 57 522, rounded down to the hundred. `tokens.test.ts` recomputes it from the pinned counts
 *     and fails if this constant's worst-case real size passes 100 000.
 *
 * What this does **not** settle: the ratio is a proxy's. The model's own counts (the token-counting
 * API, with a credential) and a script-aware divisor are still owed — `docs/TODO.md`, backlog 173.
 * A pack that fits this ceiling on English prose (≈ 1.25 est/real) is ~46 000 real tokens, so the
 * cost of the lower ceiling falls on English budgets above 57 500, which the shipped default of
 * 12 000 (product/05) is nowhere near.
 *
 * **A stored configuration above it is refused by name, never clamped**: `GET …/config` answers
 * `409 invalid_stored_config` with the key and the value (PROGRESS backlog 58's shape), and a run of
 * such a project is refused at admission — since WP-106 by the settings layer's own schema refusal
 * (`ProjectSettings.configRefusal` in `@platform/application`), which folded WP-83's bespoke
 * `contextBudgetRefusal` — technical/12 has the migration note.
 *
 * `tokenCountSchema` itself is deliberately left unbounded: it also types `runs.input_tokens` and
 * the transcript's compaction counts, which are *reports* of what happened rather than *requests*,
 * and a reported number that exceeds a bound is a number to record, not to reject (rule 20).
 */
const SMALLEST_CONTEXT_WINDOW_TOKENS = 200_000;
/** 260 / 452 = 0.5752 on the pinned Czech text, in thousandths and rounded down. */
const WORST_MEASURED_ESTIMATE_PER_REAL_MILLI = 575;
export const MAX_CONTEXT_BUDGET_TOKENS =
  ((SMALLEST_CONTEXT_WINDOW_TOKENS / 2) * WORST_MEASURED_ESTIMATE_PER_REAL_MILLI) / 1_000;

export const contextBudgetTokensSchema = tokenCountSchema.max(MAX_CONTEXT_BUDGET_TOKENS);

export const projectConfigSchema = z.strictObject({
  knowledge_dir: pathPatternSchema.optional(),
  /**
   * Tokens a run's context pack may spend on tiers 0–1 (product/05: "a project setting, default
   * 12k"; technical/07 step 4). Added to the schema at WP-16, with technical/12's example file
   * amended in the same change — product/05 called it a project setting and technical/12's
   * `.agentic/config.yml` had no key for it.
   *
   * Bounded at {@link MAX_CONTEXT_BUDGET_TOKENS} since WP-17 (PROGRESS backlog 13).
   */
  context_budget_tokens: contextBudgetTokensSchema.optional(),
  /**
   * `auto` follows the ticket's language (BD-016), and is the default.
   *
   * **It has a reader since WP-32** (PROGRESS backlog 60): `assemblePrompt` puts it in layers 1–3
   * as platform text, so a project that sets `cs` gets its questions, summaries and comments in
   * Czech and the change is visible in `promptVersion`. It governs what a **model** writes; the
   * platform's own notification text is English in this build, which is stated in the ledger.
   */
  communication_language: communicationLanguageSchema.optional(),
  commit_convention: z.enum(['conventional', 'none']).optional(),
  default_branch: nonEmptyStringSchema.optional(),
});

// ── pipeline ─────────────────────────────────────────────────────────────────

/** Per-stage overrides a template may carry (technical/12 `template_overrides.*.stages.*`). */
export const stageOverrideSchema = z.strictObject({
  enabled: z.boolean().optional(),
  plan_approval: z.enum(['never', 'above_size', 'always']).optional(),
  size_threshold: sizeSchema.optional(),
});

export const templateOverrideSchema = z.strictObject({
  enabled: z.boolean().optional(),
  stages: z.record(stageIdSchema, stageOverrideSchema).optional(),
});

/** The shortest CI timeout a document may state (WP-136) — GitLab's minimum job timeout. */
export const MIN_CI_TIMEOUT_MINUTES = 10;
/** The longest CI timeout a document may state (WP-136): one day. */
export const MAX_CI_TIMEOUT_MINUTES = 1440;
/** The CI timeout when nothing states one (WP-136) — GitLab's default job timeout. */
export const DEFAULT_CI_TIMEOUT_MINUTES = 60;

/** Bounded loops (BD-008). Every counter has a ceiling; hitting it escalates. */
export const pipelineLimitsSchema = z.strictObject({
  code_review_iterations: z.int().min(0).max(20).optional(),
  business_review_iterations: z.int().min(0).max(20).optional(),
  ci_fix_iterations: z.int().min(0).max(20).optional(),
  human_rounds: z.int().min(0).max(20).optional(),
  /**
   * product/18's *"Rebase gate … Configuration: attempts"* — how many conflict-resolution runs one
   * merge request may spend before the task is escalated (product/04 S6b: *"bounded, default 2
   * attempts"*). WP-26.
   */
  rebase_attempts: z.int().min(0).max(20).optional(),
  /**
   * How many times the default branch may move under a waiting merge request before the task is
   * parked, which is a **different** budget from {@link pipelineLimitsSchema.shape.rebase_attempts}
   * and is bounded higher on purpose: a re-check costs one provider read, an attempt costs a run.
   * The ceiling is 50 rather than the 20 every loop above carries for the same reason.
   */
  rebase_rechecks: z.int().min(0).max(50).optional(),
  /**
   * How long the CI gate waits for a pipeline when the project's git binding receives **no
   * webhooks** (WP-136, the product owner's decision of 2026-10-03): minutes since the gate's
   * current entry, after which the task is parked with a brief naming this key. A binding a webhook
   * reaches is settled by the pipeline's own event and keeps the five-check bound. The bounds are
   * GitLab's job timeout's — its minimum is 10 minutes and its default 60 (research/10's 2026-10-03
   * addendum), so a single-job pipeline the default admits is waited for.
   */
  ci_timeout_minutes: z.int().min(MIN_CI_TIMEOUT_MINUTES).max(MAX_CI_TIMEOUT_MINUTES).optional(),
  question_timeout: durationSchema.optional(),
});

/** The largest `max_parallel_tasks` a document may state. A bound, not a recommendation. */
export const MAX_WIP_PARALLEL_TASKS = 50;
/** The largest `max_tasks_in_pipeline` a document may state. */
export const MAX_WIP_TASKS_IN_PIPELINE = 200;

/**
 * BD-010's two per-project WIP limits — `pipeline.wip` (WP-91, PROGRESS backlog 224).
 *
 * BD-010:8 *"Projects define `max_parallel_tasks` (default 2) and `max_tasks_in_pipeline` (default
 * 5)"* had no key until WP-91. Both are at least **1**: a limit of 0 would queue every task for
 * ever, which is a project switched off rather than a limit, and nothing in the product asks for
 * that switch here. The upper bounds are the schema's, so a typo of `500` is refused rather than
 * read.
 *
 * **Bounded by the organisation's value** (`organizations.settings.pipeline.wip`, same shape): a
 * project may state less and never more — a write above it is refused by name, and an organisation
 * value lowered after the write applies at the next read (`resolveWipLimits` in
 * `@platform/application`). The organisation's `max_parallel_runs` is not here (backlog 127).
 *
 * When both are stated, the pipeline limit may not be below the parallel one: every active task is
 * also in the pipeline, so such a document would state a parallel limit it can never reach.
 */
export const wipLimitsConfigSchema = z
  .strictObject({
    max_parallel_tasks: z.int().min(1).max(MAX_WIP_PARALLEL_TASKS).optional(),
    max_tasks_in_pipeline: z.int().min(1).max(MAX_WIP_TASKS_IN_PIPELINE).optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.max_parallel_tasks !== undefined &&
      value.max_tasks_in_pipeline !== undefined &&
      value.max_tasks_in_pipeline < value.max_parallel_tasks
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['max_tasks_in_pipeline'],
        message: `max_tasks_in_pipeline (${value.max_tasks_in_pipeline}) is below max_parallel_tasks (${value.max_parallel_tasks}); every active task is also in the pipeline`,
      });
    }
  });

export const pipelineConfigSchema = z.strictObject({
  template_overrides: z.record(templateIdSchema, templateOverrideSchema).optional(),
  custom_stages: z.array(customStageSchema).optional(),
  limits: pipelineLimitsSchema.optional(),
  wip: wipLimitsConfigSchema.optional(),
});

// ── stages (agent settings) ──────────────────────────────────────────────────

export const stageAgentSettingsSchema = z.strictObject({
  model: nonEmptyStringSchema.optional(),
  effort: effortSchema.optional(),
  max_turns: z.int().positive().max(1000).optional(),
  budget_usd: usdSchema.optional(),
  prompt: pathPatternSchema.optional(),
  prompt_append: pathPatternSchema.optional(),
});

// ── policies ─────────────────────────────────────────────────────────────────

/** BD-018 thresholds: below `discard_below` the proposal is dropped, above the band it queues. */
export const knowledgeApplyPolicySchema = z.strictObject({
  auto_apply: z.boolean().optional(),
  discard_below: unitIntervalSchema.optional(),
  proposal_above: unitIntervalSchema.optional(),
});

/** A pattern's source without its anchors, so two patterns can be composed into one. */
const unanchored = (pattern: RegExp): string => pattern.source.replace(/^\^|\$$/g, '');

/** `reviewer:@handle`, `reviewer:@group/sub`, `reviewer:person@example.com`. */
export const REVIEWER_REQUIREMENT = /^reviewer:@?[A-Za-z0-9._\-/]+$/;

/**
 * `checklist:<name>` — a key of `policies.review_checklists` (Q83, WP-45).
 *
 * The name half is {@link slugSchema}'s own pattern, built from its source rather than typed out a
 * second time (standing rule 41), because the name must be a key the checklist record can hold.
 */
export const CHECKLIST_REQUIREMENT = new RegExp(`^checklist:${unanchored(SLUG_PATTERN)}$`);

/** The checklist a `checklist:<name>` requirement selects, or `null` for any other requirement. */
export const checklistNameOf = (requirement: string): string | null =>
  CHECKLIST_REQUIREMENT.test(requirement) ? requirement.slice('checklist:'.length) : null;

/**
 * What a risk class requires before the task may proceed — product/19 §14, WP-37, WP-45.
 *
 * **Every value this accepts has a consumer, and the one it refuses is refused by name.** That is
 * the rule this schema was changed to keep (PROGRESS backlog 73 (d)): before WP-37 it accepted two
 * requirements nothing acted on, which is the worst direction for this feature to fail in — a
 * `payments` class that looks gated and is not.
 *
 *  - `plan_approval` — WP-30's `planApprovalGate` (`packages/application/src/pipeline/saga.ts`).
 *  - `reviewer:@handle` — WP-37's reviewer routing (`packages/domain/src/policies/reviewer-routing.ts`
 *    and the `risk_route` outbound duty), which *adds* the handle to whatever CODEOWNERS or the
 *    project's `reviewers` key produced.
 *  - `checklist:<name>` — WP-45 (Q83): the named list under `policies.review_checklists`, which the
 *    stage planner hands the **Reviewer** as a data block when the class matches the paths it can
 *    see (`reviewChecklistsFor` in `packages/domain/src/policies/risk-classes.ts`) and which the
 *    Review Verdict records as `checklists_applied`. A name with no list is refused at the
 *    document, by {@link policiesConfigSchema}'s refinement, with the key path and the value — a
 *    silently ignored requirement on a payments path is what this row exists to prevent.
 *  - `budget_approval` — **refused**, with the reason. WP-28's budget gate is asked exactly once
 *    per task, at the stage that produces the `RefinedSpec` (`spendIsStillAhead`), and a risk class
 *    is computed from paths that do not exist until the Implementation Plan two stages later — so
 *    there is no moment at which this gate could read one. It is refused rather than parsed-and-
 *    ignored; the project's spend gate is the autonomy dial's `budget_approval_threshold_usd`.
 *
 * A refusal carries the offending value, and the read side prints the key path beside it
 * (`describeConfigIssues`, the shape PROGRESS backlog 58's 409 uses).
 *
 * **It is a refinement rather than a union, and that costs the generated schema its `pattern`** —
 * so the pattern is put back through `.meta()`, built from {@link REVIEWER_REQUIREMENT}'s and
 * {@link CHECKLIST_REQUIREMENT}'s own sources rather than typed out a second time (standing rule
 * 41: a value expressed twice is two things that disagree later). A union cannot say *why* a value
 * was refused — zod answers `invalid_union`, and *"this is not a risk requirement"* is exactly the
 * message an operator whose `payments` class silently did nothing needs not to get.
 */
export const riskRequirementSchema = z
  .string()
  .meta({
    description:
      'A risk class requirement: "plan_approval", "reviewer:@handle" or "checklist:<name>" (a key of policies.review_checklists). "budget_approval" is refused by name — see the schema docblock.',
    pattern: `^(plan_approval|${unanchored(REVIEWER_REQUIREMENT)}|${unanchored(CHECKLIST_REQUIREMENT)})$`,
  })
  .superRefine((value, ctx) => {
    if (
      value === 'plan_approval' ||
      REVIEWER_REQUIREMENT.test(value) ||
      CHECKLIST_REQUIREMENT.test(value)
    ) {
      return;
    }
    const detail =
      value === 'budget_approval'
        ? "budget approval cannot be forced by a risk class on this build: the budget gate is asked at refinement and a class is known only from the Implementation Plan. Use the autonomy dial's budget_approval_threshold_usd"
        : value.startsWith('checklist:')
          ? 'a checklist name is a lower_snake_case key of policies.review_checklists'
          : 'expected "plan_approval", "reviewer:@handle" or "checklist:<name>"';
    ctx.addIssue({
      code: 'custom',
      message: `${JSON.stringify(value)} is not a risk requirement this build can act on — ${detail}`,
    });
  });

/** How many items one review checklist may carry — each is a line of the Reviewer's prompt. */
export const MAX_REVIEW_CHECKLIST_ITEMS = 30;
/** How long one item may be: an item is a check, never a document. */
export const MAX_REVIEW_CHECKLIST_ITEM_CHARS = 500;
/** How many named checklists one project may declare. */
export const MAX_REVIEW_CHECKLISTS = 20;

/**
 * One named review checklist — **items, never prose** (Q83's recommendation, WP-45).
 *
 * Project text: it reaches the Reviewer inside a data block (`assemblePrompt`'s
 * `review_checklist` kind), so a hostile item is delimited like every other untrusted string
 * (BD-022) and adding one bumps no `ROLE_PROMPT_VERSIONS`. At least one item, because an empty list
 * would let `checklist:<name>` look like a requirement while adding nothing to the review.
 */
export const reviewChecklistSchema = z
  .array(nonEmptyStringSchema.max(MAX_REVIEW_CHECKLIST_ITEM_CHARS))
  .min(1)
  .max(MAX_REVIEW_CHECKLIST_ITEMS);

export const riskClassSchema = z.strictObject({
  paths: z.array(pathPatternSchema).min(1),
  require: z.array(riskRequirementSchema).min(1),
});

/**
 * One allow-list entry: `<ecosystem>:<package>` — product/18:43's *"allow-listed packages"*
 * (WP-38).
 *
 * The ecosystem is part of the entry rather than a nesting level, because a package name is only
 * unique inside one: `requests` on PyPI and `requests` on npm are different code from different
 * people, and an allow-list that could not tell them apart would let a typo-squat through on the
 * strength of a decision somebody made about another registry.
 *
 * The split is on the **first** colon only, so a name that contains one (a Maven coordinate, if a
 * later build parses that ecosystem) survives. The name half is not pattern-checked here: each
 * ecosystem has its own rules and `packages/domain/src/policies/dependencies.ts` owns them, where
 * the same patterns decide what may be read out of a diff — one spelling, not two (standing rule
 * 41). What is checked here is the part an operator gets wrong: naming an ecosystem this build has
 * never heard of, which would otherwise sit in the file looking like a decision.
 */
export const dependencyAllowEntrySchema = z
  .string()
  .meta({
    description:
      'An allow-listed package as "<ecosystem>:<name>", e.g. "npm:@scope/pkg" or "pypi:requests".',
  })
  .superRefine((value, ctx) => {
    const colon = value.indexOf(':');
    const ecosystem = colon === -1 ? '' : value.slice(0, colon);
    const name = colon === -1 ? '' : value.slice(colon + 1).trim();
    if (colon === -1 || name === '') {
      ctx.addIssue({
        code: 'custom',
        message: `${JSON.stringify(value)} is not an allow-list entry — write "<ecosystem>:<package>", for example "npm:lodash"`,
      });
      return;
    }
    if (!(DEPENDENCY_ECOSYSTEMS as readonly string[]).includes(ecosystem)) {
      ctx.addIssue({
        code: 'custom',
        message: `${JSON.stringify(ecosystem)} is not an ecosystem this build reads a dependency out of a diff for — expected one of ${DEPENDENCY_ECOSYSTEMS.join(', ')}`,
      });
    }
  });

/**
 * The dependency policy — product/18:43's configuration column, *"`allow | ask | block` per
 * ecosystem; allow-listed packages"* (BD-030, product/04:58, WP-38).
 *
 * **Two forms, and the scalar is the shorthand.** `dependency_policy: ask` is what technical/12's
 * example file has said since the key existed and is what a project that wants one answer for
 * everything writes; the object form is the document's own *"per ecosystem"* plus its allow-list.
 * A scalar layer under an object layer merges the way every other key does — an object replaces a
 * scalar, a scalar replaces an object (`effective-config.ts`) — so an organisation's `ask` and a
 * project's `{ecosystems: {npm: block}}` do not silently combine into something neither wrote.
 *
 * A **union** rather than one optional-heavy object, with its own message: zod answers
 * `invalid_union` by default, and *"Invalid input"* is exactly what an operator who typed `aks`
 * must not get (the lesson {@link riskRequirementSchema} was rewritten for at WP-37).
 *
 * The ecosystem keys are {@link dependencyEcosystemSchema} — the four this build can read a
 * dependency addition out of a diff — so a policy for an ecosystem nothing detects is refused at
 * the file rather than stored and never consulted (PROGRESS backlog 58's defect, and the one this
 * whole row exists to close for `dependency_policy` itself).
 */
export const dependencyPolicyConfigSchema = z.union(
  [
    dependencyPolicyValueSchema,
    z.strictObject({
      /** What every ecosystem gets unless `ecosystems` names it. Defaults to `ask` (product/18:43). */
      default: dependencyPolicyValueSchema.optional(),
      ecosystems: z
        .partialRecord(dependencyEcosystemSchema, dependencyPolicyValueSchema)
        .optional(),
      /** Packages that proceed whatever the policy says — product/04:58's *"allow for allow-listed packages"*. */
      allowlist: z.array(dependencyAllowEntrySchema).max(500).optional(),
    }),
  ],
  {
    error: () =>
      'expected "allow", "ask" or "block", or an object with "default", "ecosystems" and "allowlist" — see policies.dependency_policy in technical/12',
  },
);

export const policiesConfigSchema = z
  .strictObject({
    autonomy: autonomyLevelSchema.optional(),
    probation_tasks: z.int().min(0).max(1000).optional(),
    knowledge_apply: knowledgeApplyPolicySchema.optional(),
    dependency_policy: dependencyPolicyConfigSchema.optional(),
    /**
     * Where the coverage number on the Checks panel comes from — product/18:38's one configuration
     * key, *"coverage source"* (WP-39).
     *
     * The feature is *"Test coverage change of the MR shown in Checks **when the project's CI reports
     * coverage**"*, default *"on when available"*, and `'pipeline'` **is** that default: the platform
     * asks the git provider for the pipeline of a commit and reads the one number it reports
     * (`PipelineStatus.coverage_pct`). A project whose pipeline reports none renders *"not reported"*
     * rather than a zero, which is what "when available" means and is the failure mode standing rule
     * 16 exists for — `+0.0` would read to a maintainer as *"the agent added no coverage"*.
     *
     *  - `'pipeline'` — the provider's own per-commit coverage. One provider read for the head
     *    revision and one for the base, bounded by the cache `pipeline/coverage.ts` states.
     *  - `'none'` — off. Nothing is read, nothing is stored, and no provider call is made for it: the
     *    switch a project that pays per API request turns.
     *
     * **There is deliberately no `'artifact'` value, and that is this build's honest limit.** Per-file
     * coverage needs the coverage *artifact* downloaded and parsed — which is what
     * `GitProviderCapabilities.coverageArtifacts` is about, and nothing in this repository downloads
     * one. So *"coverage delta"* here is **one percentage point for the whole change**, never a
     * per-file figure, and accepting a value that promised otherwise would be a key with no reader
     * (PROGRESS backlog 58's defect, which is exactly what this row was written to close for
     * `coverage source` itself).
     */
    coverage_source: z.enum(['pipeline', 'none']).optional(),
    /** product/05 (Q7): what drift detection does when no `business/direction.md` exists. */
    drift_without_direction: z.enum(['disabled', 'label_unknown']).optional(),
    protected_paths: z.array(pathPatternSchema).optional(),
    risk_classes: z.record(slugSchema, riskClassSchema).optional(),
    /**
     * Named review checklists a risk class selects with `checklist:<name>` — product/19 §14's
     * *"stricter checklist"*, as Q83 recommends it (WP-45).
     *
     * **Add-only**: a checklist is given to the Reviewer *beside* its own default focus
     * (product/04:63, in `packages/prompts/roles/reviewer/prompt.md`), never instead of it — the same
     * answer TD-027 gave the command layer. **The platform ships none**: product/18:52 makes risk
     * classes a proposal an operator accepts, and a list a project never wrote would silently change
     * what its reviews say. So *"stricter"* means exactly *"the Reviewer was given these N additional
     * items"*, which is what the Review Verdict records (`checklists_applied`), and never a claim that
     * a stricter standard was met.
     */
    review_checklists: z
      .record(slugSchema, reviewChecklistSchema)
      .refine((lists) => Object.keys(lists).length <= MAX_REVIEW_CHECKLISTS, {
        message: `at most ${MAX_REVIEW_CHECKLISTS} review checklists`,
      })
      .optional(),
    /**
     * The project's default reviewers — step **two** of product/19:138's precedence, *"CODEOWNERS
     * match first, then project `reviewers` config, then the requesting human as fallback"* (WP-37).
     *
     * The document tells an operator to write this and until WP-37 there was no key to write it in:
     * a strict schema refused the middle step of its own precedence (PROGRESS backlog 73).
     *
     * **The values are the git provider's own account identifiers, not display names.** GitLab's
     * merge-request API takes `reviewer_ids` and nothing else, so a handle has to be resolved to an
     * id before it can be assigned; `readCodeowners` produces handles and the platform resolves those
     * through `GitProviderPort.resolveUserId`, but a value written here is used **as it stands** —
     * which is why an operator may write either (a numeric id passes straight through, a handle is
     * resolved like a CODEOWNERS owner). Anything that cannot be resolved is reported by name and
     * assigned to nobody, never silently dropped.
     */
    reviewers: z.array(nonEmptyStringSchema).max(MAX_ROUTED_REVIEWERS).optional(),
  })
  /**
   * **A class naming a checklist the document does not define is refused here** — Q83, WP-45
   * criterion 2.
   *
   * At the document rather than at the reader, because the reader is the Reviewer's prompt and a
   * missing list there would be a requirement silently ignored on a payments path — the one
   * direction this feature must not fail in. The issue carries the key path
   * (`policies.risk_classes.<class>.require.<i>`) and the message the value, which is the pair
   * `describeConfigIssues` prints in PROGRESS backlog 58's `409 invalid_stored_config` and what the
   * `PUT` answers with. Both sides of `PUT/GET …/config` parse through here, so a stored document
   * that loses a list is refused on the read as well.
   *
   * Scoped to **one document**: `projects.config` is the merged configuration (technical/03), and a
   * list defined in a layer the document does not carry is a list this reader would not see.
   */
  .superRefine((policies, ctx) => {
    const defined = policies.review_checklists ?? {};
    for (const [name, declared] of Object.entries(policies.risk_classes ?? {})) {
      declared.require.forEach((requirement, index) => {
        const checklist = checklistNameOf(requirement);
        if (checklist === null || Object.hasOwn(defined, checklist)) {
          return;
        }
        ctx.addIssue({
          code: 'custom',
          path: ['risk_classes', name, 'require', index],
          message: `${JSON.stringify(requirement)} names a review checklist this configuration does not define — add policies.review_checklists.${checklist} (a list of review items), or remove the requirement`,
        });
      });
    }
  });

/**
 * A wall-clock window in the organisation's zone (`TZ`), `[from, to)`, which **may wrap midnight**
 * (`22:00`–`08:00` is a night). One definition for its two homes: a project's
 * `features.digest.quiet_hours` and, since WP-93, the organisation's `notifications.quiet_hours`.
 */
export const quietHoursSchema = z.strictObject({ from: timeOfDaySchema, to: timeOfDaySchema });

// ── commands (BD-025) ────────────────────────────────────────────────────────
/**
 * What an **unattended** run does with a command the three lists answer `ask` (BD-025's 2026-10-06
 * amendment, the product owner's decision from the first local test).
 *
 *  - `auto` (the default): the run is sandboxed — its container, its workspace-only writable mount,
 *    its egress allow-list and its run-scoped credential — so an `ask` runs, and the transcript
 *    records that it ran under this rule. A line the scanner is uncertain about, a hazardous
 *    argument and the git boundary (a push that is not `origin agentic/…`, a remote other than
 *    `origin`, git configuration of a remote, a credential or a hook, the credential helper) are
 *    refused in this mode too.
 *  - `deny`: every `ask` is refused, which is how every run behaved before the amendment.
 *
 * **Only tightens across layers**: the organisation may force `deny`, a project's settings and its
 * repository file may choose `deny`, and an `auto` stated below a `deny` changes nothing
 * (`unattendedCommandModeOf`). An `ask` entry a layer writes is therefore an approval only under
 * `deny`; under `auto` a command a layer wants refused belongs in `block`.
 */
export const UNATTENDED_COMMAND_MODES = ['auto', 'deny'] as const;
export const unattendedCommandModeSchema = z.enum(UNATTENDED_COMMAND_MODES);
export type UnattendedCommandMode = z.infer<typeof unattendedCommandModeSchema>;
export const DEFAULT_UNATTENDED_COMMAND_MODE: UnattendedCommandMode = 'auto';

/**
 * The three-list command policy. A project may only *narrow* what its runs start from — each role's
 * shipped baseline (WP-54, Q69 (ii)). A declared `allow` narrows the baseline's **project
 * commands** only and leaves its read, git and lockfile verbs alone (Q97); entries it adds that the
 * baseline does not grant are ignored by the merge **and reported** (`ignored_allow_commands` on the
 * effective configuration, and a log line per run); `ask` and `block` only grow, and `block` always
 * wins.
 */
export const commandPolicySchema = z.strictObject({
  allow: z.array(nonEmptyStringSchema).optional(),
  ask: z.array(nonEmptyStringSchema).optional(),
  block: z.array(nonEmptyStringSchema).optional(),
  unattended: unattendedCommandModeSchema.optional(),
});

// ── verification (BD-025's 2026-10-05 amendment) ─────────────────────────────

/**
 * Where a project's verification runs — `local` (the default, every build before this key) or `ci`.
 *
 * `ci` is the project saying *"our test suite, static analysis, linters and builds run in our CI
 * pipeline on the merge request; agents do not run them in the workspace"* (PROGRESS backlog 460,
 * the first local test: a 2 CPU / 4 GiB run container OOM-killed a PHP project's static analysis
 * that its own CI already runs on every merge request). It moves the declared project commands, the
 * lockfile installs and the workspace setup script from every role's `allow` to `block`, tells every
 * run that holds `Bash` so in the platform's own voice, and makes discovery answer R1, R2 and R6 from
 * the CI configuration instead of a run. It **only narrows**: nothing is allowed that `local` did
 * not allow. The CI gate runs the same in both modes.
 */
export const VERIFICATION_MODES = ['local', 'ci'] as const;
export const verificationModeSchema = z.enum(VERIFICATION_MODES);
export type VerificationMode = z.infer<typeof verificationModeSchema>;
export const DEFAULT_VERIFICATION_MODE: VerificationMode = 'local';

export const verificationConfigSchema = z.strictObject({
  mode: verificationModeSchema.optional(),
});

// ── features (BD-028) ────────────────────────────────────────────────────────

/**
 * The history bootstrap's three numbers, from product/19 §18 (WP-35).
 *
 * > *"last N merged MRs (default 200, max 1 000) … closed tickets of the last 6 months …
 * > Batches of ~20 MRs per Sonnet 5 run … Budget cap default $20, shown before start."*
 *
 * They live in `contracts` because three rings bound themselves by them — the wire (the request
 * schema and this feature key), the application (the collector) and the SPA (the wizard's input) —
 * and a number with three spellings is a number that drifts (standing rule 41).
 *
 * **The batch size is 20 and the cap is $20, and the second follows from the first**: 200 merge
 * requests at 20 per run is ten runs, and a Sonnet stage's per-run cap in this repository is $2
 * (`DEFAULT_STAGE_RUN_BUDGET_USD`, where `retrospective`, `librarian` and `discovery` all sit), so
 * the document's $20 is exactly what the default N costs at the ceiling. That is the arithmetic the
 * wizard shows before start, and it is why the estimate and the cap can be the same number without
 * either being a guess.
 */
export const DEFAULT_BOOTSTRAP_MERGE_REQUESTS = 200;
export const MAX_BOOTSTRAP_MERGE_REQUESTS = 1_000;
/** product/19 §18's *"last 6 months"*, in days. Also the window `SHADOW_HISTORY_DAYS` reuses. */
export const DEFAULT_BOOTSTRAP_DAYS = 183;
/** Two years. A window nobody can name a use for, bounding a number a repository supplies. */
export const MAX_BOOTSTRAP_DAYS = 730;
/** product/19 §18's *"batches of ~20 MRs per Sonnet 5 run"* — the size of one mining run's sample. */
export const BOOTSTRAP_BATCH_SIZE = 20;
/** product/19 §18's *"budget cap default $20, shown before start"*. */
export const DEFAULT_BOOTSTRAP_BUDGET_USD = 20;

/**
 * product/18:31's five chore types, as one list (WP-36).
 *
 * A named constant rather than an inline `z.enum`, because three readers need the same set — this
 * schema, `MAINTENANCE_CHORES` in the domain (which says what each one can establish on this build,
 * and is held to *this* list by a `satisfies`), and the wizard's card. The order is the document's.
 */
export const MAINTENANCE_CHORE_TYPES = ['deps', 'flaky', 'docs', 'lint', 'kb'] as const;
export const maintenanceChoreSchema = z.enum(MAINTENANCE_CHORE_TYPES);
export type MaintenanceChoreType = z.infer<typeof maintenanceChoreSchema>;

/** product/18:31's *"Wizard: schedule (default weekly)"* — the grain a chore is created once per. */
export const maintenanceScheduleSchema = z.enum(['daily', 'weekly', 'monthly']);
export type MaintenanceSchedule = z.infer<typeof maintenanceScheduleSchema>;
/** product/18's own default, which the scheduler applies when a project named no schedule. */
export const DEFAULT_MAINTENANCE_SCHEDULE: MaintenanceSchedule = 'weekly';

export const featuresConfigSchema = z.strictObject({
  /**
   * The ticket readiness linter — product/18 § "Opt-in features", WP-25.
   *
   * *"A light Refinement pass on new tickets of configured issue types that are **not** labelled for
   * the agent; posts one short comment"*. Three keys, and each one is read:
   *
   *  - `issue_types` are the provider's own type names (`Story`, `Task`, `Bug`), compared
   *    case-insensitively and after trimming because a human types them into a wizard. An
   *    **explicitly empty** list matches nothing, which is the fail-closed reading of "the types I
   *    named" — the same answer `review_only.paths` gives (standing rule 20: this decides whether
   *    the platform writes on somebody's ticket).
   *  - `label` is the label that means *"for the agent"*: a ticket carrying it is **not** linted,
   *    because the pipeline is going to deliver it, and the comment's closing line names the same
   *    label as the offer (product/19 § 17). It is one key rather than two because printing a label
   *    the platform does not act on would be an invitation that does nothing.
   *
   * technical/12's example carries `{enabled, issue_types}`; `label` is added there with this row.
   * product/18 also lists *"comment language"* and *"re-lint on edit off/on"* as wizard settings and
   * **neither is a key here**: nothing in this build reads a per-feature language (the artifact
   * carries `language`), and a re-lint needs a "the ticket changed" signal no normaliser produces —
   * an unread key is the defect PROGRESS backlog 58 is about, so the residuals are recorded in the
   * ledger instead.
   */
  ticket_linter: z
    .strictObject({
      enabled: z.boolean().optional(),
      issue_types: z.array(nonEmptyStringSchema).optional(),
      label: nonEmptyStringSchema.optional(),
    })
    .optional(),
  /**
   * Review-only mode — product/18 § "Opt-in features", WP-24.
   *
   * *"The Reviewer stage on human-authored MRs (**label, path or all MRs**), posting findings as
   * discussion threads and a neutral summary that never blocks merge … Wizard: trigger (label /
   * all MRs / paths), severity floor for posting (default `major`), max findings per MR
   * (default 10)"*. Every one of those five is here, and the shape is the document's rather than
   * this file's earlier guess: `trigger` used to read `label | all | **manual**`, a third value no
   * document names and nothing reads, while `paths` — which product/18 names twice — was missing.
   * technical/12's own example carries no trigger but `label`, so nothing in the docs is
   * contradicted by the swap (standing rule 8).
   *
   * `paths` is meaningful only for `trigger: paths`; it is not made required by the schema because
   * a project that sets the list first and switches the trigger afterwards is writing a valid file
   * at every step. An empty list under `trigger: paths` matches **nothing**, which is the
   * fail-closed reading of "the paths I named" (standing rule 20).
   */
  review_only: z
    .strictObject({
      enabled: z.boolean().optional(),
      trigger: z.enum(['label', 'all', 'paths']).optional(),
      label: nonEmptyStringSchema.optional(),
      paths: z.array(pathPatternSchema).optional(),
      severity_floor: severitySchema.optional(),
      /**
       * product/18's *"max findings per MR (default 10)"*. Bounded above as well as below because
       * it decides how many provider mutations one run makes: a project that typed 10 000 would
       * spend a rate limit on one merge request.
       */
      max_findings: z.int().min(1).max(50).optional(),
    })
    .optional(),
  /**
   * The maintenance pipeline — product/18:31, product/04:120, product/19:126, WP-36.
   *
   * > *"Scheduled chores within a dedicated budget: dependency bumps, flaky-test hunting, docs
   * > drift, lint debt, KB hygiene; each produces a normal `chore` task"* · *"Wizard: schedule
   * > (default weekly), budget, allowed chore types"*.
   *
   * Four keys, one per item that column names, and every one is read since WP-36:
   *
   *  - `enabled` is BD-028's opt-in, **off by default**. Off is the scheduler skipping the project
   *    by name rather than a batch of nothing.
   *  - `schedule` decides the **period** a chore is created once per — the grain, not the hour: the
   *    tick is a daily cron and `chore!<type>-<period>` is what makes a second fire in the same
   *    period create no second task (`@platform/domain`'s `choreTicketKey`).
   *  - `budget_usd` is the *"dedicated budget"*, a **monthly** cap over the chores this scheduler
   *    created, enforced at every run's admission by the stage executor against `cost_entries` —
   *    the mechanism WP-34 built for `features.shadow_mode.budget_usd`, with this feature's own
   *    predicate. Absent is *"no dedicated cap"*, which leaves a chore bounded by the project's
   *    task and budget caps like any other task.
   *  - `chores` is *"allowed chore types"*. **All five parse and three refuse by name** at schedule
   *    time (`MAINTENANCE_CHORES`): this build detects no flaky test (product/04:65), no
   *    documentation drift (`policies.drift_without_direction` has no reader), and it schedules no
   *    lint-debt chore (refused for PROGRESS backlog 49, which WP-54 closed; enabling it is its own
   *    change), so `flaky`, `docs` and `lint` produce a named refusal rather than a task. They are refused **here rather than at
   *    the schema** deliberately: a value that has parsed since the key existed must not start
   *    failing a project's whole `.agentic/config.yml`, which every stage of every task reads.
   *    An **explicitly empty** list means *"no chore type"*, the fail-closed reading of "the types
   *    I named" (the same answer `review_only.paths` gives); an absent list means the types this
   *    build can perform.
   */
  maintenance: z
    .strictObject({
      enabled: z.boolean().optional(),
      schedule: maintenanceScheduleSchema.optional(),
      budget_usd: usdSchema.optional(),
      chores: z.array(maintenanceChoreSchema).optional(),
    })
    .optional(),
  /**
   * The daily digest and its quiet window — product/18:33, WP-32.
   *
   * *"Slack notifications batched into a daily digest outside configured hours; urgent classes
   * (escalation, budget 100%) still immediate … Wizard: channel, quiet hours, urgent classes"*.
   * Three of those four are keys here; the **channel is not**, and that is a decision rather than
   * an omission: a channel is a property of a `communication` binding (`bindings.config.channel`,
   * merged over the account's), so a copy here would be a second place to change it and the two
   * would disagree the first time an operator moved the project to another workspace.
   *
   *  - `at` is read in the **organisation's** zone (`TZ`, Q38's organisation-level calendar), not
   *    in a per-project one: a digest that means 09:00 has to say whose 09:00, and a project-level
   *    zone would be a second zone to keep true.
   *  - `quiet_hours` is a wall-clock window in that same zone and **may wrap midnight**
   *    (`22:00`–`08:00` is a night, not an empty set). `null` is quiet hours off, which is the
   *    shipped default: with no window nothing is ever deferred and the digest posts nothing.
   *  - `urgent` is product/18's third configurable. It defaults to escalation and budget-100 %
   *    (`PLATFORM_DEFAULT_CONFIG`), and an **explicitly empty list means nothing is urgent** —
   *    every notification raised inside the window waits for the digest. That is the fail-quiet
   *    direction on purpose: this key decides how often a bot interrupts a human at night, and the
   *    only thing an empty list can lose is immediacy, never the message (a deferred notification
   *    is delivered by the next digest).
   */
  digest: z
    .strictObject({
      enabled: z.boolean().optional(),
      at: timeOfDaySchema.optional(),
      quiet_hours: quietHoursSchema.nullable().optional(),
      urgent: z.array(urgentNotificationClassSchema).optional(),
    })
    .optional(),
  shadow_mode: z
    .strictObject({
      enabled: z.boolean().optional(),
      budget_usd: usdSchema.optional(),
    })
    .optional(),
  /**
   * The epic-split variant of the spike template — product/04:117, product/18:45 (WP-40).
   *
   * > *"Variant **epic split** (opt-in): the input is an epic and the output is a proposed ticket
   * > breakdown with acceptance criteria for the PM to accept"* · Default: *"off (spike template
   * > option)"*.
   *
   * product/18's Configuration column for this feature is **"—"**, so two of the three keys here
   * are the platform's own answers to questions the feature cannot be built without, and both are
   * defaulted and read:
   *
   *  - `enabled` is the document's own default, **off**. Off means `templateForIssueType` never
   *    returns `epic_split`, so an epic is delivered as a feature exactly as it is today.
   *  - `issue_types` is *which* ticket types the variant claims. It defaults to the one the
   *    document names (`['Epic']`), compared case-insensitively and after trimming because a human
   *    types them into a wizard, and an **explicitly empty** list claims nothing — the fail-closed
   *    reading of "the types I named" that `review_only.paths` and `maintenance.chores` both give.
   *  - `child_issue_type` is what an accepted child is created as in the tracker. It is here rather
   *    than on the artifact because a *model* that chose the issue type could choose one whose
   *    workflow the project has no `status_mapping` for; `'Task'` is the type every tracker in this
   *    build's fixtures ships with.
   *
   * There is deliberately **no auto-accept key**. product/04 says the breakdown is *"for the PM to
   * accept"*, and creating N tickets in somebody's backlog is the largest write this platform makes
   * into another team's tool — a switch that skipped the human would be the one configuration this
   * feature must not have (BD-028's opt-in reasoning, one step further).
   */
  epic_split: z
    .strictObject({
      enabled: z.boolean().optional(),
      issue_types: z.array(nonEmptyStringSchema).optional(),
      child_issue_type: nonEmptyStringSchema.optional(),
    })
    .optional(),
  /**
   * The **spike template itself** — product/04:117, product/18:39 (WP-40, review round 2).
   *
   * > *"**Spike template** Research/analysis tickets: `Intake → Refinement → Architecture (produces
   * > a document instead of a plan) → Human`. Output is a markdown report attached to the ticket and
   * > stored in the KB under `research/`. **No MR.**"* · Default: *"off (spike template option)"*.
   *
   * One key, and it is a **switch rather than a description of the feature**: which ticket types
   * reach the spike template is already the project's `templateByIssueType` map (technical/12), and
   * a second list here would be a second place to change it. `enabled` decides whether **any**
   * mapping to the spike template is honoured at all, so the feature's state can be read off one
   * screen — the argument `features.epic_split.enabled` was given, applied to the template the
   * variant is an option of.
   *
   * **Off is the shipped default and it is load-bearing.** product/04 S0 classifies a ticket as
   * `feature | bug | chore | spike`, and WP-40 shipped `spike: 'spike'` in the default map for that
   * reason — but the spike template ends at a human with **no merge request**, so on a project whose
   * tracker already has a `Spike` issue type that default silently stopped the platform opening MRs
   * for tickets it opens them for today. product/18:39's Default column says *"off"* for this row,
   * and off is what a behaviour change of that size has to be until somebody turns it on.
   *
   * It does **not** gate `features.epic_split`: the variant routes to its own template
   * (`epic_split`), it is opt-in in its own right, and a feature that needed two switches on is a
   * feature nobody can turn on. Each ends differently — one posts a report, the other proposes rows
   * for somebody's backlog — so each is decided on its own.
   */
  spike: z
    .strictObject({
      enabled: z.boolean().optional(),
    })
    .optional(),

  /**
   * The history bootstrap — product/18:27, product/19 §18, product/06's wizard step 3b (WP-35).
   *
   * > *"During onboarding, mines the last N merged MRs and their review comments plus closed
   * > tickets for conventions, pitfalls and recurring reviewer requests … Wizard: N (default 200),
   * > date range, budget cap; results land in the proposal queue"*
   *
   * Four keys, one per item that column names, and every one is read:
   *
   *  - `enabled` is BD-028's opt-in, **off by default** (product/18's own Default column says *"off
   *    (offered in wizard)"*). Off refuses the command by name and the read endpoint publishes the
   *    reason, so the wizard states it instead of offering a button that answers 409.
   *  - `merge_requests` is product/19 §18's *N*, defaulting to {@link DEFAULT_BOOTSTRAP_MERGE_REQUESTS}
   *    and refused past {@link MAX_BOOTSTRAP_MERGE_REQUESTS} **here as well as on the request**: a
   *    caller may name a smaller N per batch, and a repository-supplied 5 000 must be refused at the
   *    same boundary a request's is (standing rule 14 — a bound only one path checks is a bound the
   *    other path does not have).
   *  - `days` is the *"date range"*, defaulting to {@link DEFAULT_BOOTSTRAP_DAYS} — product/19's
   *    *"closed tickets of the last 6 months"*, applied to the merge requests too so that both
   *    halves of one sample describe the same window.
   *  - `budget_usd` is the *"budget cap"*, defaulting to {@link DEFAULT_BOOTSTRAP_BUDGET_USD}. It is
   *    enforced per **batch** rather than per month (the shadow budget's window), because a
   *    bootstrap is a one-off operation an operator starts and is shown a figure for before it runs.
   */
  history_bootstrap: z
    .strictObject({
      enabled: z.boolean().optional(),
      merge_requests: z.int().min(1).max(MAX_BOOTSTRAP_MERGE_REQUESTS).optional(),
      days: z.int().min(1).max(MAX_BOOTSTRAP_DAYS).optional(),
      budget_usd: usdSchema.optional(),
    })
    .optional(),
  /**
   * Human time accounting — product/18:32, product/19 §16, WP-29.
   *
   * product/18's Configuration column for this feature is **one setting** — *"show per-user
   * breakdown off/on (default off)"* — and this object has exactly that key. Two absences are
   * decided rather than overlooked:
   *
   *  - There is **no `enabled`**. The feature's Default column is *"on (derived from events; no
   *    tracking of individuals beyond what tools already record)"*, it makes no provider call and
   *    writes nothing anybody else can see, and BD-028's opt-in rule is about features that act in
   *    somebody else's tools. A switch no document asks for is a key with a reader and no writer.
   *  - There is **no hourly rate**. Q73: adding a USD figure to a minutes figure needs one, no
   *    document supplies one, and a default would be published on every task page as a measurement.
   *    The API carries minutes and dollars as two fields and never sums them; the optional
   *    `human_hour_rate_usd` Q73 sketches belongs to whichever row owns organisation settings,
   *    because it is only worth having together with the multiplication it gates.
   *
   * `per_user_breakdown` decides a **read**, not what is recorded: the entries are written either
   * way, and turning it off means the API answers `by_user: null` rather than a list.
   */
  human_time: z
    .strictObject({
      per_user_breakdown: z.boolean().optional(),
    })
    .optional(),
  /**
   * Ask-the-task — product/18:34, WP-31, Q72.
   *
   * *"A Q&A thread on a task ('why did you choose X?') answered from the task's audit trail and
   * artifacts, in the UI and in the ticket thread … Default: on … Settings: model (default Sonnet
   * 5), per-question budget"*. Four keys, and every one of them has a reader:
   *
   *  - `enabled` defaults to **true** (product/18's own default column). A project that turns it
   *    off refuses the endpoint by name rather than 404 — the feature exists and this project said
   *    no.
   *  - `model` is the document's *"default Sonnet 5"*, which is BD-013's verification model. It is
   *    free text because a model id is the provider's vocabulary, not the platform's.
   *  - `budget_usd` is the **per-question** cap (Q72 (c): 0.50 to start). It is the run's
   *    `limits.maxBudgetUsd` *and* what admission adds to the task's spend before comparing against
   *    the task cap, because a budget checked only against past spend is discovered one run late —
   *    the argument `taskBudgetExhausted` already makes for a stage.
   *  - `mirror_to_ticket` is Q72 (d) and defaults to **false**. product/10:57 asks for the mirror
   *    and product/08:11 lists it as a capability; a bot that answers in somebody else's ticket
   *    tracker is the most visible thing this platform does in another team's tool (A3), and every
   *    other default here is conservative. When it is on, the comment goes out through a
   *    `pipeline.outbound` duty like every other provider call.
   */
  ask: z
    .strictObject({
      enabled: z.boolean().optional(),
      model: nonEmptyStringSchema.optional(),
      budget_usd: usdSchema.optional(),
      mirror_to_ticket: z.boolean().optional(),
    })
    .optional(),
});

// ── status mapping ───────────────────────────────────────────────────────────

/**
 * Task state (or stage) → the ticket status name in the provider's own workflow. Keys are
 * project-chosen because a template may add stages; values are provider strings, so they are
 * free text.
 */
export const statusMappingSchema = z.record(slugSchema, nonEmptyStringSchema);

// ── the file ─────────────────────────────────────────────────────────────────

export const agenticConfigSchema = z.strictObject({
  version: z.literal(1),
  project: projectConfigSchema.optional(),
  pipeline: pipelineConfigSchema.optional(),
  stages: z.record(stageIdSchema, stageAgentSettingsSchema).optional(),
  policies: policiesConfigSchema.optional(),
  commands: commandPolicySchema.optional(),
  verification: verificationConfigSchema.optional(),
  features: featuresConfigSchema.optional(),
  status_mapping: statusMappingSchema.optional(),
});

export type AgenticConfig = z.infer<typeof agenticConfigSchema>;
export type ProjectConfig = z.infer<typeof projectConfigSchema>;
export type PipelineConfig = z.infer<typeof pipelineConfigSchema>;
export type PipelineLimits = z.infer<typeof pipelineLimitsSchema>;
export type WipLimitsConfig = z.infer<typeof wipLimitsConfigSchema>;
export type StageAgentSettings = z.infer<typeof stageAgentSettingsSchema>;
export type PoliciesConfig = z.infer<typeof policiesConfigSchema>;
export type KnowledgeApplyPolicy = z.infer<typeof knowledgeApplyPolicySchema>;
export type RiskClass = z.infer<typeof riskClassSchema>;
export type CommandPolicy = z.infer<typeof commandPolicySchema>;
export type FeaturesConfig = z.infer<typeof featuresConfigSchema>;
export type VerificationConfig = z.infer<typeof verificationConfigSchema>;
export type StatusMapping = z.infer<typeof statusMappingSchema>;

// ── the organisation settings document (WP-93) ───────────────────────────────

/**
 * `organizations.settings` — the organisation's own settings document (WP-93, PROGRESS backlogs
 * 146 (2), 223, 235 and Q103 (c)). `GET/PATCH /api/org` read and write it; it is **not** a layer of
 * `.agentic/config.yml` and a repository can state none of it.
 *
 * Every key is a **maximum** or an organisation-scoped default, and each has one reader:
 *
 *  - `commands` — the command maximum every run's baseline is intersected with before a project
 *    narrows it (BD-025 §2, `intersectWithOrganisationMaximum`). Same shape as a project's list.
 *  - `autonomy.maximum` — the highest dial position a project may select (BD-025 §2, technical/12,
 *    BD-027's WP-62 clarification: it caps the **level**, not the document keys). A project already
 *    above a lowered maximum runs at the maximum from the **next read**; a task's frozen dial
 *    (`tasks.pipeline_dial`) is never moved.
 *  - `pipeline.wip` — the organisation's WIP maximum, the project key's own shape; a project's
 *    `pipeline.wip` may state less, never more (WP-91).
 *  - `notifications.quiet_hours` / `digest_at` — when an organisation-scoped notification (an
 *    organisation budget) may interrupt somebody. Inside the window a non-urgent class
 *    (`budget_threshold`) waits for the organisation's digest at `digest_at` (default `09:00`);
 *    `budget_exhausted` is urgent and is never deferred (product/18:33).
 *  - `notifications.organisation_default` — the id of the **one** communication account that
 *    speaks for the organisation when more than one names a channel of its own (Q103 (c)). A
 *    pointer rather than a boolean on each account, so "exactly one is flagged" is a property of
 *    the shape rather than a rule to check.
 *
 * **Strict and parsed at every read**: a stored document this schema refuses is a named refusal
 * (the key path and the value), never a silent default and never a cast (standing rule 20,
 * PROGRESS backlog 311's organisation half).
 */
export const organisationSettingsSchema = z.strictObject({
  commands: commandPolicySchema.optional(),
  autonomy: z.strictObject({ maximum: autonomyLevelSchema }).optional(),
  pipeline: z.strictObject({ wip: wipLimitsConfigSchema.optional() }).optional(),
  notifications: z
    .strictObject({
      quiet_hours: quietHoursSchema.nullable().optional(),
      digest_at: timeOfDaySchema.optional(),
      organisation_default: idSchema.nullable().optional(),
    })
    .optional(),
});

export type OrganisationSettings = z.infer<typeof organisationSettingsSchema>;
export type QuietHoursConfig = z.infer<typeof quietHoursSchema>;

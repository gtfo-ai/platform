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
  MAX_ROUTED_REVIEWERS,
  nonEmptyStringSchema,
  notificationClassSchema,
  pathPatternSchema,
  severitySchema,
  sizeSchema,
  slugSchema,
  stageIdSchema,
  templateIdSchema,
  timeOfDaySchema,
  tokenCountSchema,
  unitIntervalSchema,
  usdSchema,
} from './common.js';
import { customStageSchema } from './pipeline.js';

// ── project ──────────────────────────────────────────────────────────────────

/**
 * The ceiling on one run's context-pack budget.
 *
 * PROGRESS backlog 13: `tokenCountSchema` is `z.int().nonnegative()`, so a project could configure
 * a budget of any size and pay for the pack that filled it on **every stage run**. The bound is at
 * the boundary rather than in the assembler because a configuration that cannot be satisfied should
 * be refused where it is written, not silently clamped where it is spent.
 *
 * 200 000 is the smallest context window in the current Claude line-up — Haiku 4.5; Opus 5, Sonnet 5
 * and Fable 5.1 are 1 M ([models overview](https://platform.claude.com/docs/en/models/overview),
 * retrieved 2026-09-12). A pack larger than the **whole** window cannot fit whatever model a stage
 * is routed to, and the pack is only layers 4–5 of six. So this refuses the configurations that are
 * impossible rather than the ones that are merely expensive; the budget that a *sensible* operator
 * sets is a different question and product/05's 12 000 default is the platform's answer to it.
 *
 * `tokenCountSchema` itself is deliberately left unbounded: it also types `runs.input_tokens` and
 * the transcript's compaction counts, which are *reports* of what happened rather than *requests*,
 * and a reported number that exceeds a bound is a number to record, not to reject (rule 20).
 */
export const MAX_CONTEXT_BUDGET_TOKENS = 200_000;

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
  question_timeout: durationSchema.optional(),
});

export const pipelineConfigSchema = z.strictObject({
  template_overrides: z.record(templateIdSchema, templateOverrideSchema).optional(),
  custom_stages: z.array(customStageSchema).optional(),
  limits: pipelineLimitsSchema.optional(),
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

/** `reviewer:@handle`, `reviewer:@group/sub`, `reviewer:person@example.com`. */
export const REVIEWER_REQUIREMENT = /^reviewer:@?[A-Za-z0-9._\-/]+$/;

/**
 * What a risk class requires before the task may proceed — product/19 §14, WP-37.
 *
 * **Every value this accepts has a consumer, and the two it refuses are refused by name.** That is
 * the rule this schema was changed to keep (PROGRESS backlog 73 (d)): before WP-37 it accepted two
 * requirements nothing acted on, which is the worst direction for this feature to fail in — a
 * `payments` class that looks gated and is not.
 *
 *  - `plan_approval` — WP-30's `planApprovalGate` (`packages/application/src/pipeline/saga.ts`).
 *  - `reviewer:@handle` — WP-37's reviewer routing (`packages/domain/src/policies/reviewer-routing.ts`
 *    and the `risk_route` outbound duty), which *adds* the handle to whatever CODEOWNERS or the
 *    project's `reviewers` key produced.
 *  - `budget_approval` — **refused**, with the reason. WP-28's budget gate is asked exactly once
 *    per task, at the stage that produces the `RefinedSpec` (`spendIsStillAhead`), and a risk class
 *    is computed from paths that do not exist until the Implementation Plan two stages later — so
 *    there is no moment at which this gate could read one. It is refused rather than parsed-and-
 *    ignored; the project's spend gate is the autonomy dial's `budget_approval_threshold_usd`.
 *  - `checklist:<name>` — **refused**, with the reason. product/19 §14 asks for it twice and
 *    nothing in the product defines what a checklist *is* (Q83, filed with a recommendation): the
 *    only checklist that exists is prose inside the reviewer's own prompt. Accepting the string
 *    without the reviewer-side consumer would recreate exactly the defect the first two bullets
 *    close.
 *
 * A refusal carries the offending value, and the read side prints the key path beside it
 * (`describeConfigIssues`, the shape PROGRESS backlog 58's 409 uses).
 *
 * **It is a refinement rather than a union, and that costs the generated schema its `pattern`** —
 * so the pattern is put back through `.meta()`, built from {@link REVIEWER_REQUIREMENT}'s own source
 * rather than typed out a second time (standing rule 41: a value expressed twice is two things that
 * disagree later). A union cannot say *why* a value was refused — zod answers `invalid_union`, and
 * *"this is not a risk requirement"* is exactly the message an operator whose `payments` class
 * silently did nothing needs not to get.
 */
export const riskRequirementSchema = z
  .string()
  .meta({
    description:
      'A risk class requirement: "plan_approval" or "reviewer:@handle". "budget_approval" and "checklist:<name>" are refused by name — see the schema docblock.',
    pattern: `^(plan_approval|${REVIEWER_REQUIREMENT.source.replace(/^\^|\$$/g, '')})$`,
  })
  .superRefine((value, ctx) => {
    if (value === 'plan_approval' || REVIEWER_REQUIREMENT.test(value)) {
      return;
    }
    const detail =
      value === 'budget_approval'
        ? "budget approval cannot be forced by a risk class on this build: the budget gate is asked at refinement and a class is known only from the Implementation Plan. Use the autonomy dial's budget_approval_threshold_usd"
        : value.startsWith('checklist:')
          ? 'a review checklist is not a thing this build has (docs/OPEN-QUESTIONS.md Q83): no reviewer-side consumer exists, so the requirement would be silently ignored'
          : 'expected "plan_approval" or "reviewer:@handle"';
    ctx.addIssue({
      code: 'custom',
      message: `${JSON.stringify(value)} is not a risk requirement this build can act on — ${detail}`,
    });
  });

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

export const policiesConfigSchema = z.strictObject({
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
});

// ── commands (BD-025) ────────────────────────────────────────────────────────

/**
 * The three-list command policy. A project may only *narrow* the org maximum: entries added to
 * `allow` that the org does not allow are ignored by the merge, and `block` always wins.
 */
export const commandPolicySchema = z.strictObject({
  allow: z.array(nonEmptyStringSchema).optional(),
  ask: z.array(nonEmptyStringSchema).optional(),
  block: z.array(nonEmptyStringSchema).optional(),
});

// ── features (BD-028) ────────────────────────────────────────────────────────

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
  maintenance: z
    .strictObject({
      enabled: z.boolean().optional(),
      schedule: z.enum(['daily', 'weekly', 'monthly']).optional(),
      budget_usd: usdSchema.optional(),
      chores: z.array(z.enum(['deps', 'flaky', 'docs', 'lint', 'kb'])).optional(),
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
      quiet_hours: z
        .strictObject({ from: timeOfDaySchema, to: timeOfDaySchema })
        .nullable()
        .optional(),
      urgent: z.array(notificationClassSchema).optional(),
    })
    .optional(),
  shadow_mode: z
    .strictObject({
      enabled: z.boolean().optional(),
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
  features: featuresConfigSchema.optional(),
  status_mapping: statusMappingSchema.optional(),
});

export type AgenticConfig = z.infer<typeof agenticConfigSchema>;
export type ProjectConfig = z.infer<typeof projectConfigSchema>;
export type PipelineConfig = z.infer<typeof pipelineConfigSchema>;
export type PipelineLimits = z.infer<typeof pipelineLimitsSchema>;
export type StageAgentSettings = z.infer<typeof stageAgentSettingsSchema>;
export type PoliciesConfig = z.infer<typeof policiesConfigSchema>;
export type KnowledgeApplyPolicy = z.infer<typeof knowledgeApplyPolicySchema>;
export type RiskClass = z.infer<typeof riskClassSchema>;
export type CommandPolicy = z.infer<typeof commandPolicySchema>;
export type FeaturesConfig = z.infer<typeof featuresConfigSchema>;
export type StatusMapping = z.infer<typeof statusMappingSchema>;

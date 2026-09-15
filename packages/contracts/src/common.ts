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

/**
 * `project.communication_language` — the language the platform's agents write to humans in.
 *
 * `auto` follows the ticket (BD-016) and is the shipped default. It has a name of its own because
 * it is read by the **prompt assembler** (WP-32, PROGRESS backlog 60), which puts it in the
 * platform's own voice in layers 1–3: a closed set is what makes that safe.
 */
export const communicationLanguageSchema = z.union([z.literal('auto'), languageTagSchema]);

export type CommunicationLanguage = z.infer<typeof communicationLanguageSchema>;

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
 * A test-coverage percentage, `0`–`100`, as a CI pipeline reports it for one commit (WP-39).
 *
 * One spelling for what was four identical literals — the `ci.pipeline.finished` payload,
 * `MergeRequest.coverage_pct`, `PipelineStatus.coverage_pct` and the task's own record — because a
 * bound written out four times is four things that disagree later (standing rule 41).
 *
 * **It is a percentage, and a *difference* of two of them is not.** The delta the Checks panel
 * shows is in percentage *points* (`taskCoverageSchema.delta_pct`), which is why that field is
 * signed and this one is not.
 */
export const coveragePctSchema = z.number().min(0).max(100);

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

/**
 * What a chat notification is **about** (WP-32) — the unit quiet hours and the digest reason over.
 *
 * product/18:33 configures three things: a channel, a quiet window, and *"urgent classes
 * (escalation, budget 100%) still immediate"*. The third needs a name for each kind of message, and
 * this is that closed set: one value per catalogue event the notification band consumes
 * (technical/02 § "Event catalogue", the Slack consumer at priority 210).
 *
 * It is **not** the event type. A class is what an operator chooses to be woken for, so it is the
 * platform's vocabulary rather than the log's — `budget_exhausted` is product/18's "budget 100%"
 * whatever the event that carries it, and two events that mean one thing to a human would share a
 * class. The mapping lives beside the handlers (`@platform/application`'s `notify/`), because a new
 * event that deserves a notification is a pipeline decision and not a configuration change.
 */
export const notificationClassSchema = z.enum([
  /** A ticket was picked up and a task exists (`task.created`). */
  'task_started',
  /** An agent is blocked on a human answer (`task.question.asked`). */
  'question',
  /** A stage sent the task back to an earlier one (`task.stage.returned`). */
  'stage_returned',
  /** The task is parked for a human, with a blocker brief (`task.escalated`). */
  'escalation',
  'task_completed',
  'task_cancelled',
  /** A budget window crossed its warning threshold (`budget.threshold.reached`). */
  'budget_threshold',
  /** A budget window is spent — product/18's "budget 100%" (`budget.exhausted`). */
  'budget_exhausted',
]);

export type NotificationClass = z.infer<typeof notificationClassSchema>;

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
  /**
   * Ask-the-task (WP-31): a run with a task and **no stage**, answering a human's question from
   * the task's own audit trail. Appended rather than slotted in beside `discovery`, because
   * `alter type run_mode add value 'ask'` appends and `test/integration/db/enums.integration.test.ts`
   * compares the database's labels with this list **in order**.
   */
  'ask',
  /**
   * The history bootstrap (WP-35): a run that reads one batch of ~20 merged merge requests, their
   * discussions, the closed tickets of the window and the commit messages, and proposes knowledge.
   *
   * It is a run **mode** rather than only a template id because `runs.mode` is what a screen and
   * the statistics read: PROGRESS backlog 57 recorded four of technical/04's modes falling through
   * to `normal` with live producers, and a bootstrap run that called itself `normal` would have
   * been the fifth. WP-36 **closed** that backlog entry — `RUN_MODE_BY_STAGE` beside
   * `RUN_MODE_BY_TEMPLATE` in the planner, with migration 0031 backfilling the runs written before
   * it — so every value in this list now has a writer that names it. Appended, for `'ask'`'s
   * reason.
   */
  'bootstrap',
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
  /**
   * **Appended at WP-47** (migration 0035): no process renewed the run's lease, so the platform
   * ended the row.
   *
   * It is a name of its own rather than `crash` or `cancelled`, because it is the only thing a
   * missing heartbeat licenses anybody to say. `crash` claims the session died; `cancelled` claims
   * a human stopped it; both are claims about the *model*, and a sweep knows only that nothing is
   * renewing the lease — the session may still be running in a process that lost its database
   * connection. The value is **last** in this list because `alter type … add value` without
   * `before`/`after` appends, and `test/integration/db/enums.integration.test.ts` compares the two
   * orders.
   */
  'lease_expired',
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

/**
 * The proposal vocabulary, defined once (technical/03's `knowledge_proposal_*` enums).
 *
 * Three of these had two spellings until WP-18b — one inside `knowledgeProposalRecordSchema` and
 * one inside the retrospective's draft — and a third was about to be added for the Librarian's own
 * artifact. A vocabulary with three definitions is a vocabulary that drifts on the next value
 * (standing rule 41), and the database has exactly one enum for each.
 */
export const knowledgeProposalSourceSchema = z.enum([
  'task',
  'run',
  'feedback',
  'bootstrap',
  'human',
  /**
   * The history bootstrap (WP-35) — a convention, pitfall or rule **mined from merged merge
   * requests, closed tickets and commit messages**, as opposed to one the Discovery agent *drafted*
   * from the repository's files.
   *
   * It is a value of its own rather than a second use of `bootstrap`, which has exactly one writer
   * (`onboarding/record.ts`, whose comment reads *"this one came from onboarding, not from a
   * retrospective"*). Both arrive during onboarding and a reader of the queue has to be able to
   * tell them apart, because the evidence is different in kind: a `bootstrap` page is a model's
   * reading of a repository it has just seen, and a `history` page cites the merge requests and
   * tickets the claim was observed in — which is the difference between a guess a maintainer must
   * verify and a citation a maintainer can follow.
   *
   * Appended, because `alter type knowledge_proposal_source add value 'history'` appends and
   * `test/integration/db/enums.integration.test.ts` compares the labels with this list **in order**.
   */
  'history',
]);

export const knowledgeProposalKindSchema = z.enum(['business', 'technical', 'process']);

export const knowledgeProposalTypeSchema = z.enum([
  'lesson',
  'pitfall',
  'rule',
  'decision',
  'skill-draft',
  'doc-update',
]);

/**
 * Longest knowledge page the platform stores or commits, in **bytes of UTF-8**.
 *
 * It bounds two producers that used to be bounded differently, which is why it lives here rather
 * than in the domain: a **model's** proposal, capped by the curator (`curateProposals`), and a
 * **maintainer's** `edit`, which reaches the same row, the same commit and every later context pack
 * through `POST …/kb/proposals/:id/edit` and used to be capped by nothing but the HTTP body limit.
 *
 * `decideKbProposalRequestSchema` applies it as a **character** count, which is the cheap outer
 * boundary — a string that passes it is at most this many code units — and
 * `decideKnowledgeProposal` applies it again in **bytes**, which is the unit the curator uses, so
 * the two paths cannot disagree about the same page. For ASCII the two are the same number.
 */
export const MAX_PROPOSAL_DELTA_BYTES = 64 * 1024;

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

/** Agent roles shipped as prompts in `packages/prompts/roles/<role>/prompt.md` (technical/12). */
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
  /**
   * Ask-the-task (WP-31, Q72 (a)) — the role that answers *"why did you choose X?"* from the audit
   * trail. Appended for the reason `runModeSchema`'s `'ask'` is: the enum migration appends and the
   * integration parity test reads the order.
   */
  'ask',
  /**
   * The history bootstrap's miner (WP-35) — product/19 §18's *"batches of ~20 MRs per Sonnet 5 run
   * with a fixed extraction schema"*.
   *
   * A role of its own rather than the Librarian's: the Librarian reconciles a **retrospective** on
   * one delivered task against the vault it is shown, and this one reads somebody else's history —
   * merge requests nobody on this platform opened — and has no retrospective and no task to
   * reconcile. Its prompt, its eval cases and its three least-privilege rows are therefore its own
   * (TD-016, BD-021). Appended for `'ask'`'s reason.
   */
  'historian',
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

/**
 * What a linted ticket is missing — product/19 § 17's *"top 3 missing elements (acceptance
 * criteria, scope boundaries, validation)"*, as a closed set (WP-25).
 *
 * A closed set rather than free text because it is **the platform's own reading of an artifact**,
 * not the model's words: `packages/domain/src/policies/ticket-lint.ts` decides each one from the
 * `RefinedSpec` the lint run produced, and the linter's comment prints the platform's label for it.
 * A model that wrote its own "missing element" would be inventing a metric key.
 */
export const ticketReadinessGapSchema = z.enum([
  'acceptance_criteria',
  'scope_boundaries',
  'validation',
]);

/**
 * The package ecosystems this build can read a dependency **addition** out of a diff (WP-38).
 *
 * product/18:43 asks for the policy *"`allow | ask | block` per ecosystem"* and never says which
 * ecosystems exist, so this enum is the platform's answer and it is deliberately **short**: an
 * ecosystem is in it only when `packages/domain/src/policies/dependencies.ts` has a manifest
 * matcher *and* a parser for its added lines. The table there is `satisfies Record<
 * DependencyEcosystem, …>`, so a value added here without a parser does not compile.
 *
 * What a diff carries for an ecosystem that is **not** in this list is not silently ignored: it is
 * reported as an unread manifest ({@link unreadEcosystemSchema}) with the file that changed, which
 * is standing rule 18 — the absent case must not be the quiet one.
 */
export const dependencyEcosystemSchema = z.enum(['npm', 'pypi', 'go', 'cargo']);

/** Every ecosystem a policy may name, in the order the domain's table declares them. */
export const DEPENDENCY_ECOSYSTEMS = dependencyEcosystemSchema.options;

/**
 * The ecosystems whose manifests this build **recognises and cannot read** (WP-38).
 *
 * A `pom.xml` in a diff is evidence that somebody may have added a dependency, and answering
 * *"nothing was added"* for it would be a gate reporting a fact it did not establish. So the file
 * is named on the record and on the Checks panel with the ecosystem it belongs to, and the gate
 * says plainly that it could not read it (standing rule 18).
 *
 * It does **not** raise a question by itself: the policy gates *detected additions*, and asking a
 * human about every edit to a build file the platform cannot parse is the shape that gets a feature
 * switched off. The residual is stated at `detectDependencyChanges`.
 */
export const unreadEcosystemSchema = z.enum(['maven', 'gradle', 'composer', 'rubygems', 'nuget']);

/**
 * How many reviewers one merge request may be routed to.
 *
 * A **provider-call budget** rather than a product number: each handle that is not already an
 * account id costs one `resolveUserId` read before the assignment can be made (WP-37), so this is
 * the fan-out of one rebase-gate entry. Eight is larger than any CODEOWNERS rule this repository's
 * own parser caps at per rule (64 owners) is likely to produce for one change and small enough that
 * a hostile `CODEOWNERS` cannot turn a gate entry into a hundred provider requests — the file is
 * attacker-controlled in a fork workflow (BD-022).
 */
export const MAX_ROUTED_REVIEWERS = 8;

/** What a project does when a run adds a third-party dependency (product/18:43, BD-030). */
export const dependencyPolicyValueSchema = z.enum(['allow', 'ask', 'block']);

/** Autonomy dial (BD-027, technical/12 `policies.autonomy`). */
export const autonomyLevelSchema = z.enum(['observe', 'assist', 'supervised', 'autonomous']);

/** Reasoning effort per stage (BD-013, technical/12 `stages.*.effort`). */
export const effortSchema = z.enum(['low', 'medium', 'high']);

/**
 * Artifact types (technical/02 Artifact aggregate).
 *
 * `LibrarianProposals` was added at WP-18b and is the one type technical/12's table did not list:
 * that document's own `pipeline.yml` example carries a `librarian` stage with **no** `produces`,
 * and a stage that produces nothing has nowhere to put what it decided — the run's structured
 * output is validated against the artifact schema and then dropped. technical/12 is amended with
 * the type rather than the code being written around the omission (standing rule 8).
 */
export const artifactTypeSchema = z.enum([
  'RefinedSpec',
  'RootCauseAnalysis',
  'ImplementationPlan',
  'ImplementationNotes',
  'ReviewVerdict',
  'AcceptanceVerdict',
  'RetroReport',
  'LibrarianProposals',
  'ShadowReport',
  'ReadinessReport',
  'DiscoveryDraft',
  /**
   * The answer an ask-the-task run returns (WP-31).
   *
   * It is an artifact **type** rather than a free-text reply so that the SDK is given a JSON schema
   * and the platform re-validates the answer against the same one (`structured-output.ts`,
   * technical/04's defence in depth). It is also the one artifact type that is **kept out of a
   * later stage's prompt** — see `PROMPT_EXCLUDED_ARTIFACT_TYPES` in `packages/domain` — because a
   * human's question and a model's answer about the audit trail are not inputs to the delivery.
   */
  'AskAnswer',
  /**
   * The history bootstrap's fixed extraction schema (WP-35) — product/19 §18's five findings:
   * *"recurring reviewer requests → rules candidates; conventions observed ≥ 3 times →
   * `conventions.md` entries; pitfalls (MRs with ≥ 3 review rounds) → lessons; glossary terms;
   * module ownership hints"*.
   *
   * A type of its own rather than `LibrarianProposals`, whose `data` is already proposals **plus a
   * vault health report plus a retrospective summary** — two of which a mining run has nothing to
   * say about. What this type adds is the part that makes a mined claim checkable: every proposal
   * carries `evidence` as **structured links** (a merge request or a ticket the platform itself put
   * in the prompt) rather than as free-text sentences, which is what lets the recorder refuse a
   * citation the batch never contained.
   */
  'HistoryFindings',
  /**
   * The spike template's document — product/04:117's *"Architecture (**produces a document instead
   * of a plan**)"* (WP-40).
   *
   * A type of its own rather than an `ImplementationPlan` with empty lists, and the document is the
   * reason: a plan names files, modules, a test plan and a validation contract, and a research
   * report that filled those in with `[]` would be a plan claiming *"nothing has to change"* — the
   * one sentence a spike is least entitled to. What this type carries instead is what a spike
   * produces: the question, the options weighed, a recommendation, and the open questions the
   * research did not close. The report a human reads is the envelope's `markdown`.
   */
  'ResearchReport',
  /**
   * The epic-split variant's output — product/04:117's *"a proposed ticket breakdown with acceptance
   * criteria for the PM to accept"* (WP-40).
   *
   * Not `ImplementationPlan.split_proposal`, which is `{title, scope}` and carries **no acceptance
   * criteria**: the whole of what a PM is asked to accept here is *"is each of these a ticket a
   * developer could start, and know when they are done?"*, which is the criteria. And not
   * `RefinedSpec`, which is one ticket's specification — a breakdown is N of them, and a schema that
   * could express both would be a schema neither side could rely on.
   */
  'TicketBreakdown',
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

/**
 * Stages of the shipped **ticket** templates (technical/12 `pipeline.yml`).
 *
 * Two shipped stages are deliberately **not** here — `discovery` (WP-21) and `ticket_lint`
 * (WP-25) — and the omission is load-bearing rather than an oversight: `STAGE_EMPHASIS`
 * (`packages/domain/src/knowledge/retrieval.ts`) is asserted key-for-key against this list, so a
 * name added here without an emphasis row fails that test, and both of those stages take the
 * neutral `DEFAULT_EMPHASIS`. The sentence used to read "the shipped templates", which stopped
 * being true when the first template outside the ticket flow shipped.
 */
export const BUILTIN_STAGE_IDS = [
  'intake',
  'refinement',
  'investigation',
  'architecture',
  'implementation',
  'conflict_resolution',
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

// ── The ticket's own words ───────────────────────────────────────────────────

/**
 * One comment of {@link ticketSnapshotSchema}. `author` and `body` are untrusted (BD-022).
 *
 * `author` is a display name and never an address: a snapshot exists to give an agent the thread,
 * not to give it somebody's email. `truncated` is **per comment**, because a thread where one
 * comment was cut and nineteen were not is a different fact from a thread that was shortened.
 *
 * `created_at` is nullable although the port's `ticketCommentSchema` requires one: a snapshot is
 * built out of whatever a provider actually returned, and the alternative to "the platform could
 * not read this timestamp" is inventing one, which reads as a fact.
 */
export const ticketSnapshotCommentSchema = z.strictObject({
  id: z.string(),
  author: z.string(),
  created_at: isoDateTimeSchema.nullable(),
  body: z.string(),
  truncated: z.boolean(),
});

/**
 * `tasks.ticket_snapshot` — the ticket's own words, as the platform read them once (WP-15f).
 *
 * The platform stored `ticket_provider`/`ticket_key`/`ticket_url` and nothing else until this
 * schema existed, so the first agent stage was asked to refine a ticket nobody had opened
 * (PROGRESS backlog 23, Q61). This is that text: **untrusted external data** (BD-022) like
 * `inbox.payload` and `kb_chunks`, stored redacted, bounded at the write, and dying with the task
 * by the row it sits on.
 *
 * Three fields carry the ticket and the rest carry what happened to it, because a snapshot that
 * cannot say what it dropped is a snapshot a reader has to trust:
 *
 *  - `truncated` is true when **anything** was cut — a field, a comment, or a comment that did not
 *    make the newest-N window — and `comment_count` is what the provider returned before the
 *    window, so `comments.length < comment_count` says how many;
 *  - `redaction_count` is what the binding's redactor replaced, counted over the text as it was
 *    **read** rather than as it is stored (the cut happens after), which is the `inbox`
 *    precedent: a redactor that stopped working must be visible rather than silent;
 *  - `ticket_updated_at` is the provider's own `updated_at` for the ticket, which is the only
 *    thing that can tell a later reader the snapshot is behind — the platform has no
 *    `ticket.updated` event (Q61 (b)).
 *
 * An **absent** snapshot (`null` on the row) means the platform has not read the ticket: a failed
 * or not-yet-made fetch is never spelled as a ticket with an empty description (standing rule 18).
 */
export const ticketSnapshotSchema = z.strictObject({
  title: z.string(),
  description: z.string(),
  comments: z.array(ticketSnapshotCommentSchema),
  truncated: z.boolean(),
  comment_count: z.int().nonnegative(),
  redaction_count: z.int().nonnegative(),
  ticket_updated_at: isoDateTimeSchema.nullable(),
});

// ── The merge request under review (WP-24) ──────────────────────────────────

/** One file of {@link mergeRequestSnapshotSchema}. `path` and `diff` are untrusted (BD-022). */
export const mergeRequestFileDiffSchema = z.strictObject({
  /** The file's path after the change; the pre-image path for a deletion. */
  path: z.string(),
  /** The provider's own patch text for this file, already bounded and redacted. */
  diff: z.string(),
  /** True when this file's own patch was cut, which is a different fact from the list being cut. */
  truncated: z.boolean(),
  /** The provider excluded the patch itself (GitLab's `collapsed`/`too_large`). */
  omitted: z.boolean(),
});

/**
 * `tasks.review_subject` — the human merge request a review-only task reviews (WP-24).
 *
 * Review-only mode (product/18, product/04 § "Operating modes that reuse stages") runs the Code
 * review stage alone on a merge request nobody on the platform wrote, so the stage's *input* is the
 * merge request rather than a prior artifact. technical/04's mode table says where it comes from:
 * *"`review_only` | Reviewer role on a human MR: read-only tools, **diff from provider**, findings
 * posted as threads"* — so the platform reads it once, through `IntegrationActionExecutor`, and
 * stores it on the task the way {@link ticketSnapshotSchema} stores a ticket.
 *
 * It is a **separate column from `ticket_snapshot` and not a widening of it**: a ticket snapshot is
 * "the ticket's own words" and a diff is not words a ticket has; folding the patch into
 * `description` would make one field mean two things and would put a 200 kB patch behind a name
 * that promises a paragraph.
 *
 * The same three honesty fields as a ticket snapshot, for the same reasons: `truncated` when
 * anything at all was cut (a field, a file's patch, or a file that did not make the window),
 * `file_count` as the provider reported it before the window so `files.length < file_count` says
 * how many were dropped, and `redaction_count` counted over the text as it was **read**.
 */
export const mergeRequestSnapshotSchema = z.strictObject({
  title: z.string(),
  description: z.string(),
  source_branch: z.string(),
  target_branch: z.string(),
  head_sha: z.string(),
  /** The provider's labels on the merge request, bounded; what a `label` trigger matched on. */
  labels: z.array(z.string()),
  files: z.array(mergeRequestFileDiffSchema),
  truncated: z.boolean(),
  file_count: z.int().nonnegative(),
  redaction_count: z.int().nonnegative(),
});

// ── The mined history (WP-35) ────────────────────────────────────────────────

/**
 * One merged merge request of a history batch, with the review comments it collected.
 *
 * `title`, `author`, every `note` and every `path` are somebody else's words about somebody else's
 * repository (BD-022): bounded and redacted at the write, exactly as a ticket snapshot is, and
 * rendered only inside a data block.
 *
 * `rounds` is the platform's own count of **non-system discussion threads**, which is product/19
 * §18's *"pitfalls (MRs with ≥ 3 review rounds)"* measure. It is carried as a number rather than
 * left for the model to count, because the threshold is the platform's definition and a model
 * counting its own evidence is a model marking its own homework.
 */
export const historyMergeRequestSchema = z.strictObject({
  /** `!12` — the provider's own short reference, and the token a proposal cites as evidence. */
  ref: z.string(),
  url: urlSchema,
  title: z.string(),
  author: z.string(),
  merged_at: isoDateTimeSchema,
  /** Non-system discussion threads, as the provider reported them. */
  rounds: z.int().nonnegative(),
  /** Files and lines, when the provider published them; `null` when it did not. */
  files_changed: z.int().nonnegative().nullable(),
  /** Review comments, oldest first, each `--- author ---` separated in the prompt. */
  notes: z.array(z.string()),
  /** True when a note, the title or the note list itself was cut. */
  truncated: z.boolean(),
});

/** One closed ticket of a history batch — product/19 §18's *"titles, descriptions, resolution comments"*. */
export const historyTicketSchema = z.strictObject({
  key: z.string(),
  url: urlSchema,
  title: z.string(),
  description: z.string(),
  /** The last comments on the ticket, which is where a resolution is written. */
  comments: z.array(z.string()),
  truncated: z.boolean(),
});

/** One commit message of a history batch. The sha is the provider's; the message is untrusted. */
export const historyCommitSchema = z.strictObject({
  sha: z.string(),
  message: z.string(),
  truncated: z.boolean(),
});

/**
 * `tasks.history_sample` — the batch of history one mining run is shown (WP-35).
 *
 * product/19 §18's inputs, for **one** batch of about twenty merge requests: *"last N merged MRs
 * … with discussions and diff stats; closed tickets of the last 6 months (titles, descriptions,
 * resolution comments); commit messages"*. It is the fifth place the platform stores somebody
 * else's words — after `inbox`, `kb_chunks`, `tasks.ticket_snapshot` and `tasks.review_subject` —
 * and it is stored the same way all four are: **bounded and redacted at the write** (TD-012,
 * BD-022), read back only into a data block, and dying with the task row it sits on.
 *
 * It is a column on the task rather than a table of its own for the reason `review_subject` is
 * one: it is the *input to this task's one stage*, written by the same `insert` that creates the
 * task, so it has exactly one writer and no read-modify-write (standing rule 79 does not apply —
 * there is no second writer to race).
 *
 * `evidence_links` is the platform's own list of what this sample contained, and it is what makes
 * product/19 §18's *"every proposal cites MR/ticket links as evidence"* a **checkable** precondition
 * rather than an instruction: the recorder refuses a proposal whose citation is not in it, so a
 * link a model invented cannot reach the queue looking like a link a maintainer can follow.
 */
export const historySampleSchema = z.strictObject({
  merge_requests: z.array(historyMergeRequestSchema),
  tickets: z.array(historyTicketSchema),
  commits: z.array(historyCommitSchema),
  /** Every merge-request and ticket URL in this sample — the set a citation must resolve into. */
  evidence_links: z.array(z.string()),
  /** True when anything at all was cut: an item, a note, or a list that hit its window. */
  truncated: z.boolean(),
  redaction_count: z.int().nonnegative(),
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
export type KnowledgeProposalSource = z.infer<typeof knowledgeProposalSourceSchema>;
export type KnowledgeProposalKind = z.infer<typeof knowledgeProposalKindSchema>;
export type KnowledgeProposalType = z.infer<typeof knowledgeProposalTypeSchema>;
export type UserRole = z.infer<typeof userRoleSchema>;
export type AgentRole = z.infer<typeof agentRoleSchema>;
export type IntegrationType = z.infer<typeof integrationTypeSchema>;
export type ProviderMode = z.infer<typeof providerModeSchema>;
export type Size = z.infer<typeof sizeSchema>;
export type Severity = z.infer<typeof severitySchema>;
export type TicketReadinessGap = z.infer<typeof ticketReadinessGapSchema>;
export type DependencyEcosystem = z.infer<typeof dependencyEcosystemSchema>;
export type UnreadEcosystem = z.infer<typeof unreadEcosystemSchema>;
export type DependencyPolicyValue = z.infer<typeof dependencyPolicyValueSchema>;
export type AutonomyLevel = z.infer<typeof autonomyLevelSchema>;
export type Effort = z.infer<typeof effortSchema>;
export type ArtifactType = z.infer<typeof artifactTypeSchema>;
export type ExternalIdentity = z.infer<typeof externalIdentitySchema>;
export type Actor = z.infer<typeof actorSchema>;
export type TicketRef = z.infer<typeof ticketRefSchema>;
export type MergeRequestRef = z.infer<typeof mergeRequestRefSchema>;
export type WorkpadRef = z.infer<typeof workpadRefSchema>;
export type TicketSnapshotComment = z.infer<typeof ticketSnapshotCommentSchema>;
export type TicketSnapshot = z.infer<typeof ticketSnapshotSchema>;
export type MergeRequestFileDiff = z.infer<typeof mergeRequestFileDiffSchema>;
export type MergeRequestSnapshot = z.infer<typeof mergeRequestSnapshotSchema>;
export type HistoryMergeRequest = z.infer<typeof historyMergeRequestSchema>;
export type HistoryTicket = z.infer<typeof historyTicketSchema>;
export type HistoryCommit = z.infer<typeof historyCommitSchema>;
export type HistorySample = z.infer<typeof historySampleSchema>;
export type TokenUsage = z.infer<typeof tokenUsageSchema>;
export type ModelUsage = z.infer<typeof modelUsageSchema>;
export type RunCost = z.infer<typeof runCostSchema>;

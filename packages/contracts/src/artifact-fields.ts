/**
 * Which fields of an artifact's `data` are **identifiers** and which are **prose** — TD-012's
 * WP-52 amendment §2.
 *
 * TD-012 says *"replace every secret value the platform injected"* before any write, and artifacts
 * have always been on its write list. Over **structured** artifact data that instruction is unsafe
 * as written, and the counter-example is live: `packages/application/src/pipeline/saga.ts`'s
 * `recordMergeRequest` reads the `ImplementationNotes` **row** back and addresses a merge request
 * with `mr.url` and `mr.head_sha`. A `[REDACTED:integration:…]` written into either is a value the
 * platform then queries a provider with. So the split:
 *
 *  - **prose** is redacted, as step (1) has always said;
 *  - an **identifier** that *contains* an injected secret is **refused** — the write fails by name
 *    and the run escalates — never rewritten.
 *
 * That is the answer `idempotencyScopeFor` already gives for an idempotency key, and for the same
 * reason (standing rule 70): redaction is many-to-one, an identity must not be, and a rewritten
 * identifier answers one question with another question's subject.
 *
 * ## The classification rule
 *
 * **An identifier is a field whose value the platform *addresses something with*: a provider
 * resource, a repository or vault path, or an entry in one of the platform's own closed tables.
 * Everything a human or a model merely *reads* is prose — including a model-authored `id` the
 * platform never resolves.**
 *
 * It is drawn there rather than at "anything that names something" because the cost of the two
 * mistakes is not symmetric. Misclassifying prose as an identifier **fails a whole run** when a
 * credential lands in it; misclassifying an identifier as prose produces a value that addresses
 * nothing — a dead link — *except* where the platform hands it to a provider, which is exactly the
 * `mr.head_sha` case this policy exists for. So the identifier class is the set where a wrong
 * answer is a wrong *action*, and everything else is redacted.
 *
 * Worked examples, all live: `mr.url`/`mr.head_sha` are handed to the git provider by
 * `recordMergeRequest`; `files_to_change[].path` is matched against BD-024's protected paths by
 * `planPaths`; `proposals[].target_path` is joined to the project's `knowledge_dir` and committed;
 * `findings[].id`/`.file` are two thirds of `reviewFindingSignature`, which decides whether a
 * re-review repeated itself; `readiness[].id` and `risk_classes[].name` are looked up in
 * `READINESS_CRITERIA` and `PROPOSED_RISK_CLASSES`. Against that: `acceptance_criteria[].id` and
 * `questions[].id` are **prose**, because nothing in this build resolves them — the platform mints
 * its own question ids and the criteria ids are compared by the *model*, between artifacts it was
 * shown.
 *
 * **When a consumer starts addressing something with a field, the field moves.** That is a change
 * this table has to be edited for, and it is the one drift the completeness check below cannot see;
 * it is stated here rather than implied, which is the most an enumeration can do about it.
 *
 * ## Why this table lives in `@platform/contracts`
 *
 * It indexes {@link artifactDataSchemas} field by field, and the one thing that keeps it honest is
 * being edited in the same file-neighbourhood as the schema a new field is added to.
 * `packages/contracts/src/artifact-fields.test.ts` derives every string-valued leaf path of every
 * one of the fifteen schemas from the schema itself — through `z.toJSONSchema`, the same
 * representation the model is given — and compares it with the union of the two lists **in both
 * directions**, per type. So:
 *
 *  - a **type** added to `artifactDataSchemas` with no entry here **fails** (standing rule 7: it
 *    does not quietly default to prose);
 *  - a **field** added to an existing type fails until somebody classifies it;
 *  - a field renamed or removed fails, rather than silently demoting an identifier to prose.
 *
 * ## What is deliberately not declared, and why that is safe
 *
 * **Enum-valued leaves.** `decision`, `severity`, `confidence`, `citations[].kind` and the rest are
 * closed sets: a value outside the enum fails `artifactDataSchemas` re-validation in the runner
 * before anything is stored, so such a field cannot carry a credential at all. The test excludes
 * them from the comparison by reading `enum` off the derived JSON Schema, which means the exclusion
 * is a property of the schema rather than a list maintained here.
 *
 * **Non-string leaves.** Numbers and booleans cannot contain a substring.
 *
 * ## What it cannot do
 *
 * It classifies *fields*, not *values*. A model that writes a merge-request URL into `summary` gets
 * that URL redacted and nothing complains; a model that writes prose into `mr.branch` gets the
 * whole run refused if that prose happens to contain the run's credential. Both are the
 * fail-in-the-cheap-direction choice and neither is detectable from a schema.
 */
import type { artifactDataSchemas } from './artifacts.js';

/**
 * A path to a string-valued leaf of an artifact's `data`.
 *
 * `a.b` descends an object, `a[]` every element of an array. `citations[].detail` is "the `detail`
 * of every citation"; `unanswered[]` is "every element of `unanswered`", which is an array of bare
 * strings and therefore has no trailing key.
 */
export type ArtifactFieldPath = string;

/** What TD-012 does with one field. */
export interface ArtifactFieldPolicy {
  /** Fields the platform reads as a name. A secret found in one refuses the write. */
  readonly identifiers: readonly ArtifactFieldPath[];
  /** Everything else. Redacted, and the replacements counted onto the row. */
  readonly prose: readonly ArtifactFieldPath[];
}

/**
 * The per-type table. Every key of {@link artifactDataSchemas} appears exactly once — the type
 * below is what makes a missing one a compile error, and `artifact-fields.test.ts` is what makes it
 * a test failure for a caller that reaches the table dynamically.
 */
export const ARTIFACT_FIELD_POLICIES = {
  RefinedSpec: {
    // A knowledge citation names a page in the vault and the commit it was read at; the platform
    // resolves both (product/05's "cites the KB page and commit").
    identifiers: ['kb_citations[].commit_sha', 'kb_citations[].path'],
    prose: [
      'acceptance_criteria[].given',
      'acceptance_criteria[].id',
      'acceptance_criteria[].then',
      'acceptance_criteria[].validation.value',
      'acceptance_criteria[].when',
      'assumptions[]',
      'dependencies[]',
      'drift.justification',
      'goal',
      'in_scope[]',
      'kb_citations[].reason',
      'non_functional[]',
      'out_of_scope[]',
      'questions[].id',
      'questions[].options[]',
      'questions[].suggested_answer',
      'questions[].text',
      'user_value',
    ],
  },
  RootCauseAnalysis: {
    // Nothing here addresses anything: an RCA is read, never resolved. An empty list is the honest
    // answer and is not the same as "not classified" — the check below distinguishes them.
    identifiers: [],
    prose: [
      'affected_scope[]',
      'fix_direction',
      'questions[].id',
      'questions[].options[]',
      'questions[].suggested_answer',
      'questions[].text',
      'regression_test_idea',
      'reproduction.evidence[]',
      'reproduction.steps[]',
      'root_cause',
    ],
  },
  ImplementationPlan: {
    // Both are matched against the project's protected paths (BD-024): `planPaths` reads the first
    // to decide whether a protected-path write was declared, and the second is the declaration.
    identifiers: ['files_to_change[].path', 'protected_path_changes[].path'],
    prose: [
      'affected_modules[]',
      'alternatives_considered[].option',
      'alternatives_considered[].why_not',
      'api_changes[]',
      'approach',
      'data_changes[]',
      'decisions_to_record[]',
      'files_to_change[].change',
      'protected_path_changes[].reason',
      'risks[]',
      'rollout_notes',
      'split_proposal[].scope',
      'split_proposal[].title',
      'test_plan[]',
      'validation_contract[].check.value',
      'validation_contract[].criterion_id',
    ],
  },
  ImplementationNotes: {
    // The five that made this a per-field policy rather than a blanket redaction:
    // `recordMergeRequest` copies them onto `tasks` and the git provider is then addressed with
    // them. A `[REDACTED:integration:…]` here is a value the platform queries GitLab with.
    identifiers: ['mr.branch', 'mr.head_sha', 'mr.project_path', 'mr.provider', 'mr.url'],
    prose: [
      'commands_run[].command',
      'commands_run[].summary',
      'deviations_from_plan[].what',
      'deviations_from_plan[].why',
      'followup_tickets[]',
      'known_gaps[]',
      'summary',
      'tests_added[]',
    ],
  },
  ReviewVerdict: {
    // `findings[].id` and `.file` are two thirds of `reviewFindingSignature`, which decides whether
    // a re-review repeated itself and escalates the task (product/04 S5); the confirmed paths are
    // compared with the plan's protected-path declarations.
    identifiers: ['findings[].file', 'findings[].id', 'protected_path_changes_confirmed[]'],
    prose: [
      'findings[].category',
      'findings[].explanation',
      'findings[].suggestion',
      'summary',
      'suspicious_inputs_noted[]',
    ],
  },
  AcceptanceVerdict: {
    // `criteria[].id` refers to a criterion in the RefinedSpec the *model* was shown, and nothing
    // in this build joins the two — so it is read, not resolved.
    identifiers: [],
    prose: ['criteria[].evidence', 'criteria[].id', 'missing[]', 'scope_creep[]', 'ux_notes[]'],
  },
  RetroReport: {
    // A stage id is looked up in the compiled pipeline, a readiness criterion in
    // `READINESS_CRITERIA`, and both paths in the project's vault.
    identifiers: [
      'cost_summary.by_stage[].stage',
      'proposals[].target_path',
      'returns[].existing_item',
      'returns[].readiness_criterion',
      'returns[].stage',
    ],
    prose: [
      'human_corrections[]',
      'proposals[].diff',
      'proposals[].evidence[]',
      'returns[].reason',
      'what_went_well[]',
    ],
  },
  LibrarianProposals: {
    // `target_path` is joined to the project's `knowledge_dir` and committed (BD-025); a health
    // finding names a page the hygiene pass reads.
    identifiers: ['health[].path', 'proposals[].target_path'],
    prose: [
      'health[].detail',
      'proposals[].delta',
      'proposals[].evidence[]',
      'proposals[].reason',
      'summary',
    ],
  },
  ShadowReport: {
    // The merge request the batch addresses, the ticket key it is keyed by, and the finding
    // signature's two fields — the same three classes as everywhere else.
    identifiers: [
      'agent_review_of_human_mr[].file',
      'agent_review_of_human_mr[].id',
      'human_mr.branch',
      'human_mr.head_sha',
      'human_mr.project_path',
      'human_mr.provider',
      'human_mr.url',
      'ticket',
    ],
    prose: [
      'agent_review_of_human_mr[].category',
      'agent_review_of_human_mr[].explanation',
      'agent_review_of_human_mr[].suggestion',
      'notes',
    ],
  },
  ReadinessReport: {
    // `R1`…`R14`, looked up in `READINESS_CRITERIA`; `unlocks` is platform text the model never
    // writes (`evaluateReadiness` drops the model's).
    identifiers: ['criteria[].id'],
    prose: ['criteria[].evidence', 'criteria[].unlocks'],
  },
  DiscoveryDraft: {
    // Two vault paths the curator writes to, a readiness id and a risk-class name the platform
    // looks up in its own tables, and the paths a proposed class would cover.
    identifiers: [
      'documents[].path',
      'linked_documents[].path',
      'readiness[].id',
      'risk_classes[].name',
      'risk_classes[].paths[]',
    ],
    prose: [
      'commands[].command',
      'commands[].evidence',
      'documents[].markdown',
      'documents[].title',
      'linked_documents[].reason',
      'questions[].id',
      'questions[].options[]',
      'questions[].suggested_answer',
      'questions[].text',
      'readiness[].evidence',
      'risk_classes[].evidence',
    ],
  },
  AskAnswer: {
    /*
     * **`run_id` alone, and `reference` deliberately not** — the exception WP-31 argued and WP-52
     * keeps rather than widens.
     *
     * `run_id` is checked against this task's own runs by `scopeCitations` *before* any redaction,
     * and the thread builds a link from it, so it is an address in the strict sense. `reference` is
     * a `human_actions` id — also scoped, so a poisoned one is **dropped** rather than stored — or a
     * vault path that nothing resolves: the worst a redacted one produces is a citation that points
     * nowhere, while refusing it would fail a whole ask over a citation. So `reference` stays prose
     * and keeps passing the redactor, which is what WP-31 round 2 built and what backlog 85's
     * "its citations are not [redacted]" no longer describes.
     */
    identifiers: ['citations[].run_id'],
    prose: ['answer', 'citations[].detail', 'citations[].reference', 'unanswered[]'],
  },
  HistoryFindings: {
    // `evidence[].url`/`.ref` are **prose**: `historyEvidenceSchema` says `url` is "what a
    // maintainer opens", and nothing in the platform fetches it — a redacted one is a dead link in
    // a proposal, which is cheaper than refusing a whole mining batch.
    identifiers: ['proposals[].target_path'],
    prose: [
      'proposals[].delta',
      'proposals[].evidence[].ref',
      'proposals[].evidence[].url',
      'proposals[].reason',
      'summary',
    ],
  },
  ResearchReport: {
    identifiers: ['kb_citations[].commit_sha', 'kb_citations[].path'],
    prose: [
      'findings[].evidence[]',
      'findings[].statement',
      'kb_citations[].reason',
      'open_questions[].id',
      'open_questions[].options[]',
      'open_questions[].suggested_answer',
      'open_questions[].text',
      'options[].cons[]',
      'options[].option',
      'options[].pros[]',
      'question',
      'recommendation',
      'summary',
    ],
  },
  TicketBreakdown: {
    // A proposed child is created through `IntegrationActionExecutor` from `title`, `description`
    // and `acceptance_criteria` — all of which are the *body* of a ticket rather than an address,
    // so a placeholder in one is a redacted ticket and not a mis-addressed call.
    identifiers: [],
    prose: [
      'children[].acceptance_criteria[].given',
      'children[].acceptance_criteria[].id',
      'children[].acceptance_criteria[].then',
      'children[].acceptance_criteria[].validation.value',
      'children[].acceptance_criteria[].when',
      'children[].description',
      'children[].rationale',
      'children[].title',
      'epic_summary',
      'open_questions[].id',
      'open_questions[].options[]',
      'open_questions[].suggested_answer',
      'open_questions[].text',
      'out_of_scope[]',
    ],
  },
} as const satisfies Record<keyof typeof artifactDataSchemas, ArtifactFieldPolicy>;

/** The identifier paths of one artifact type, as a set, for the walker. */
export const artifactIdentifierPaths = (
  artifactType: keyof typeof ARTIFACT_FIELD_POLICIES,
): ReadonlySet<ArtifactFieldPath> => new Set(ARTIFACT_FIELD_POLICIES[artifactType].identifiers);

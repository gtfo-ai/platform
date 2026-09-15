/**
 * Artifact schemas — docs/technical/12-configuration-and-schemas.md § "Artifact schemas".
 *
 * Every stage that runs an agent produces exactly one artifact. The `data` half is what the
 * runner asks the model for (`outputFormat: { type: 'json_schema' }`, technical/04) and what the
 * platform re-validates on the way in; the markdown half is for humans. Verdict fields drive
 * pipeline transitions — the platform never parses the markdown to decide.
 */

import * as z from 'zod';
import {
  artifactTypeSchema,
  idSchema,
  isoDateTimeSchema,
  knowledgeProposalKindSchema,
  knowledgeProposalTypeSchema,
  languageTagSchema,
  mergeRequestRefSchema,
  nonEmptyStringSchema,
  pathPatternSchema,
  severitySchema,
  sizeSchema,
  stageIdSchema,
  unitIntervalSchema,
  urlSchema,
  usdSchema,
} from './common.js';

// ── Building blocks reused across artifact types ─────────────────────────────

/** How an acceptance criterion is checked (technical/12 RefinedSpec / ImplementationPlan). */
export const validationCheckSchema = z.strictObject({
  kind: z.enum(['command', 'test', 'manual']),
  value: nonEmptyStringSchema,
});

export const acceptanceCriterionSchema = z.strictObject({
  id: nonEmptyStringSchema,
  given: nonEmptyStringSchema,
  when: nonEmptyStringSchema,
  // biome-ignore lint/suspicious/noThenProperty: Given/When/Then is the criterion shape technical/12 mandates; this is a zod shape object, never awaited.
  then: nonEmptyStringSchema,
  validation: validationCheckSchema,
});

/**
 * A question an agent wants a human to answer. `blocking` decides whether the pipeline waits
 * (technical/02 Question aggregate).
 */
export const artifactQuestionSchema = z.strictObject({
  id: nonEmptyStringSchema,
  text: nonEmptyStringSchema,
  blocking: z.boolean(),
  options: z.array(nonEmptyStringSchema).nullish(),
  suggested_answer: z.string().nullish(),
});

/** A knowledge-base document the agent used, with the commit it read (product/05). */
export const kbCitationSchema = z.strictObject({
  path: pathPatternSchema,
  commit_sha: z.string().nullish(),
  reason: z.string().nullish(),
});

// ── Per-type `data` payloads ─────────────────────────────────────────────────

export const refinedSpecDataSchema = z.strictObject({
  goal: nonEmptyStringSchema,
  user_value: nonEmptyStringSchema,
  in_scope: z.array(nonEmptyStringSchema),
  out_of_scope: z.array(nonEmptyStringSchema),
  acceptance_criteria: z.array(acceptanceCriterionSchema),
  non_functional: z.array(nonEmptyStringSchema),
  dependencies: z.array(nonEmptyStringSchema),
  size: sizeSchema,
  drift: z.strictObject({
    flag: z.boolean(),
    justification: z.string(),
  }),
  assumptions: z.array(nonEmptyStringSchema),
  questions: z.array(artifactQuestionSchema),
  decision: z.enum(['proceed', 'ask', 'reject']),
  kb_citations: z.array(kbCitationSchema),
});

export const rootCauseAnalysisDataSchema = z.strictObject({
  reproduction: z.strictObject({
    kind: z.enum(['reproduced', 'evidence']),
    steps: z.array(nonEmptyStringSchema),
    evidence: z.array(nonEmptyStringSchema),
  }),
  root_cause: nonEmptyStringSchema,
  confidence: z.enum(['high', 'medium', 'low']),
  affected_scope: z.array(nonEmptyStringSchema),
  fix_direction: nonEmptyStringSchema,
  regression_test_idea: nonEmptyStringSchema,
  questions: z.array(artifactQuestionSchema),
});

export const implementationPlanDataSchema = z.strictObject({
  approach: nonEmptyStringSchema,
  alternatives_considered: z.array(
    z.strictObject({ option: nonEmptyStringSchema, why_not: nonEmptyStringSchema }),
  ),
  affected_modules: z.array(nonEmptyStringSchema),
  files_to_change: z.array(
    z.strictObject({ path: pathPatternSchema, change: nonEmptyStringSchema }),
  ),
  data_changes: z.array(nonEmptyStringSchema),
  api_changes: z.array(nonEmptyStringSchema),
  validation_contract: z.array(
    z.strictObject({ criterion_id: nonEmptyStringSchema, check: validationCheckSchema }),
  ),
  test_plan: z.array(nonEmptyStringSchema),
  rollout_notes: z.string(),
  risks: z.array(nonEmptyStringSchema),
  estimated_size: sizeSchema,
  split_proposal: z
    .array(z.strictObject({ title: nonEmptyStringSchema, scope: nonEmptyStringSchema }))
    .nullish(),
  decisions_to_record: z.array(nonEmptyStringSchema),
  protected_path_changes: z.array(
    z.strictObject({ path: pathPatternSchema, reason: nonEmptyStringSchema }),
  ),
});

export const implementationNotesDataSchema = z.strictObject({
  summary: nonEmptyStringSchema,
  deviations_from_plan: z.array(
    z.strictObject({ what: nonEmptyStringSchema, why: nonEmptyStringSchema }),
  ),
  tests_added: z.array(nonEmptyStringSchema),
  commands_run: z.array(
    z.strictObject({
      command: nonEmptyStringSchema,
      exit_code: z.int(),
      summary: z.string(),
    }),
  ),
  known_gaps: z.array(nonEmptyStringSchema),
  followup_tickets: z.array(nonEmptyStringSchema),
  mr: mergeRequestRefSchema,
});

export const reviewFindingSchema = z.strictObject({
  id: nonEmptyStringSchema,
  severity: severitySchema,
  category: nonEmptyStringSchema,
  file: pathPatternSchema.nullish(),
  line: z.int().positive().nullish(),
  explanation: nonEmptyStringSchema,
  suggestion: z.string().nullish(),
});

export const reviewVerdictDataSchema = z.strictObject({
  verdict: z.enum(['approve', 'request_changes']),
  findings: z.array(reviewFindingSchema),
  summary: nonEmptyStringSchema,
  /** BD-022: the reviewer records prompt-injection-shaped input it noticed, and ignores it. */
  suspicious_inputs_noted: z.array(nonEmptyStringSchema).nullish(),
  protected_path_changes_confirmed: z.array(pathPatternSchema),
});

export const acceptanceVerdictDataSchema = z.strictObject({
  verdict: z.enum(['approve', 'request_changes']),
  criteria: z.array(
    z.strictObject({
      id: nonEmptyStringSchema,
      status: z.enum(['met', 'not_met', 'untestable']),
      evidence: z.string(),
    }),
  ),
  scope_creep: z.array(nonEmptyStringSchema),
  missing: z.array(nonEmptyStringSchema),
  ux_notes: z.array(nonEmptyStringSchema),
});

/** A knowledge-base change the retrospective proposes (BD-018 thresholds decide what happens). */
export const knowledgeProposalDraftSchema = z.strictObject({
  kind: knowledgeProposalKindSchema,
  type: knowledgeProposalTypeSchema,
  target_path: pathPatternSchema,
  diff: nonEmptyStringSchema,
  evidence: z.array(nonEmptyStringSchema),
  significance: unitIntervalSchema,
});

export const retroReportDataSchema = z.strictObject({
  what_went_well: z.array(nonEmptyStringSchema),
  returns: z.array(
    z.strictObject({
      stage: stageIdSchema,
      reason: nonEmptyStringSchema,
      avoidable_by_kb: z.boolean(),
      existing_item: pathPatternSchema.nullish(),
      readiness_criterion: nonEmptyStringSchema.nullish(),
    }),
  ),
  human_corrections: z.array(nonEmptyStringSchema),
  cost_summary: z.strictObject({
    total_usd: usdSchema,
    is_estimate: z.boolean(),
    by_stage: z.array(z.strictObject({ stage: stageIdSchema, usd: usdSchema })),
  }),
  proposals: z.array(knowledgeProposalDraftSchema),
});

/**
 * What the Librarian decided to do with one curated proposal (technical/07 § "Librarian pipeline"
 * step 2, and the four choices the shipped role prompt names).
 *
 * `deprecate` and `no-op` are **not** "nothing happens": product/05 keeps a superseded page and
 * marks it, and a no-op has to say what already covers the proposal or the same one comes back
 * every retrospective. Both therefore carry a `reason` like every other action.
 */
export const librarianActionSchema = z.enum(['add', 'update', 'deprecate', 'no-op']);

/**
 * One knowledge change the Librarian proposes, reconciled against the vault it was shown.
 *
 * Two fields are read by the platform rather than by a human, and both are stated here because a
 * model cannot infer a convention from a schema:
 *
 *  - **`target_path` is relative to the project's knowledge directory** (`lessons/L-2026-09-12.md`),
 *    never repository-relative and never absolute. The platform joins it to `knowledge_dir`, which
 *    is per project and which the model is not told — so a path that is already prefixed, or that
 *    climbs out with `..`, is refused by the curator rather than written (BD-025).
 *  - **`delta` is the page's intended content, not a patch.** technical/07 step 4 describes a
 *    Librarian editing files in a knowledge workspace; this build commits through the git
 *    provider's commits API instead (there is no workspace on the apply path), and applying a
 *    unified diff would need a base file and a patch engine the platform does not ship. The whole
 *    body is what the commit writes, which is also what the proposal queue can show a human.
 */
export const librarianProposalSchema = z.strictObject({
  action: librarianActionSchema,
  kind: knowledgeProposalKindSchema,
  type: knowledgeProposalTypeSchema,
  target_path: pathPatternSchema,
  delta: nonEmptyStringSchema,
  evidence: z.array(nonEmptyStringSchema),
  significance: unitIntervalSchema,
  reason: nonEmptyStringSchema,
});

/**
 * One thing wrong with the vault, as the Librarian saw it (technical/07 § 6's health report, and
 * product/05's "contradictions are flagged for humans, never auto-resolved").
 *
 * It is an observation, never an instruction: nothing in the platform deletes or rewrites a page
 * because a finding names it.
 */
export const kbHealthFindingSchema = z.strictObject({
  kind: z.enum(['expired', 'dangling', 'duplicate', 'contradiction', 'oversized']),
  path: pathPatternSchema,
  detail: nonEmptyStringSchema,
});

export const librarianProposalsDataSchema = z.strictObject({
  proposals: z.array(librarianProposalSchema),
  health: z.array(kbHealthFindingSchema),
  summary: z.string(),
});

/**
 * product/19 §13's per-ticket report — *"agent artifacts (spec, plan, diff stats, tests added),
 * human MR (if any): files touched, size; comparison: file-overlap Jaccard, size ratio, tests added
 * ratio, acceptance criteria the human MR covers vs the agent's; Reviewer findings the human MR
 * would have received (posted nowhere); predicted cost vs shadow cost; reviewer minutes estimate
 * (from MR events); confidence note"* (WP-34).
 *
 * ## What is absent, and why each absence is a refusal rather than an omission
 *
 * Three of the document's fields are answerable on this build and are here — `tests_added_ratio`
 * inside {@link shadowReportDataSchema.shape.overlap}, `shadow_cost` beside `predicted_cost`, and
 * `reviewer_minutes_estimate`. The fourth is **not**, and it is named rather than invented (standing
 * rule 16, and WP-15h's `/context-pack` precedent — summing rows into a budget publishes a fact):
 *
 * > *"acceptance criteria the human MR covers vs the agent's"*
 *
 * The agent's half exists (`AcceptanceVerdict.criteria`, one status per criterion). The **human's**
 * half is a semantic judgement about somebody else's diff against a ticket's acceptance criteria,
 * and nothing on this build makes it: no stage reviews the human merge request against the ticket,
 * no artifact records such a judgement, and deriving it from file overlap would be publishing a
 * similarity number under a coverage heading. A field carrying only the agent's side would read as
 * a comparison when it is a single measurement, so there is no field. The work is a Reviewer run
 * over the human merge request with the ticket's criteria in its prompt, which is a stage this
 * template does not have.
 *
 * ## Two fields that became nullable, and the rule is the same one
 *
 * `agent_diff_stats` and `overlap` were required. Both are now nullish, because both rest on
 * reading a diff that may not exist:
 *
 *  - the **agent's** diff is read from the merge request the Developer stage reported
 *    (`tasks.mr_ref`), which a shadow task has only when the run produced one — a read, so it is
 *    performed in every mode (technical/06: *"a shadow task needs its context"*);
 *  - the **human's** merge request is `null` for a ticket that has none, and Q82's recommendation
 *    is explicit that such a ticket still produces a report with **no overlap block at all** rather
 *    than an overlap of zero, *"which reads as 'the agent built something completely different'"*.
 *
 * So `overlap` is present exactly when both diffs are, and `notes` says which side was missing.
 */
export const shadowReportDataSchema = z.strictObject({
  ticket: nonEmptyStringSchema,
  human_mr: mergeRequestRefSchema.nullish(),
  /** Null when the task recorded no merge request, so the platform has no diff of its own to read. */
  agent_diff_stats: z
    .strictObject({
      files_changed: z.int().nonnegative(),
      insertions: z.int().nonnegative(),
      deletions: z.int().nonnegative(),
    })
    .nullish(),
  /** Present exactly when **both** diffs were read; never a zero standing in for a missing side. */
  overlap: z
    .strictObject({
      files_jaccard: unitIntervalSchema,
      /**
       * The agent's changed lines over the human's, and `null` when the human side has none.
       *
       * The same refusal `tests_added_ratio` makes below, for the same reason and with the same
       * reachable cause: a provider that declined to render a patch (`collapsed`, `too_large`, a
       * null body) publishes the path and no lines, so the denominator is zero for a merge request
       * that plainly changed something. `0` was the first answer here and the Shadow screen printed
       * it as *"size ratio: 0.00"* — the agent's work divided by a denominator nobody has (standing
       * rule 16). `notes` says which side was not rendered.
       */
      size_ratio: z.number().nonnegative().finite().nullish(),
      /**
       * product/19 §13's *"tests added ratio"*: the agent's test-file count over the human's.
       *
       * `null` when the human merge request added **no** test file, because the ratio is then a
       * division by zero and "infinitely better" is not a measurement. The two counts the ratio is
       * taken from are beside it, so a reader is never handed the quotient alone.
       */
      tests_added_ratio: z.number().nonnegative().finite().nullish(),
      agent_test_files: z.int().nonnegative(),
      human_test_files: z.int().nonnegative(),
    })
    .nullish(),
  /**
   * product/19 §13's *"Reviewer findings the human MR would have received (posted nowhere)"*.
   *
   * `null` on this build, and the distinction is the point: `[]` would say *"a reviewer read the
   * human merge request and found nothing"*, which is a claim no run has made. Nothing reviews the
   * **human's** diff during a shadow task — the shadow task's own `code_review` stage reviews what
   * the *agent* wrote — and the feature that does review a human merge request is review-only mode
   * (product/18, WP-24), which is a different task on a different template. Producing this field
   * means giving the shadow batch a Reviewer run over the human merge request; until then the
   * report says *"not looked at"* rather than *"nothing found"* (standing rules 16, 18).
   */
  agent_review_of_human_mr: z.array(reviewFindingSchema).nullish(),
  /** `tasks.estimate_usd` — WP-28's point estimate, or `null` for a task that never got one. */
  predicted_cost: usdSchema.nullish(),
  /** What the shadow run actually spent (`tasks.cost_actual`), so the pair can be compared. */
  shadow_cost: usdSchema,
  /**
   * product/19 §16's review arithmetic applied to the **human** merge request's own notes.
   *
   * `null` when there is no human merge request, or when its discussions carry no non-system note
   * — an empty set of activities is not zero minutes of review, it is no evidence of review.
   */
  reviewer_minutes_estimate: z.number().nonnegative().finite().nullish(),
  /** product/19 §13's *"confidence note"*: platform text saying what this comparison rests on. */
  notes: z.string(),
});

export const readinessReportDataSchema = z.strictObject({
  level: z.int().min(0).max(5),
  criteria: z.array(
    z.strictObject({
      id: nonEmptyStringSchema,
      passed: z.boolean(),
      evidence: z.string(),
      unlocks: z.string(),
    }),
  ),
});

/**
 * How many path patterns one proposed class may carry.
 *
 * Model output reaching a stored row, so it is bounded here rather than at the writer (the same
 * answer every other artifact cap gives). Twelve is twice the longest row of product/19 §14's own
 * table, which is the widest a faithful proposal needs to be.
 */
export const MAX_PROPOSED_CLASS_PATHS = 12;

/**
 * DiscoveryDraft. technical/12 does not list its `data` fields; this shape follows the outputs
 * product/06 § "Step 2 — Technical discovery" names: drafted `technical/*.md` pages with
 * confidence markers, commands marked *verified* only when actually run, documents that are
 * linked rather than copied, and the questions the agent could not answer itself.
 * See docs/OPEN-QUESTIONS.md Q35.
 */
export const discoveryDraftDataSchema = z.strictObject({
  documents: z.array(
    z.strictObject({
      path: pathPatternSchema,
      title: nonEmptyStringSchema,
      markdown: nonEmptyStringSchema,
      confidence: z.enum(['high', 'medium', 'low']),
    }),
  ),
  commands: z.array(
    z.strictObject({
      purpose: z.enum(['setup', 'build', 'test', 'lint', 'format', 'typecheck', 'run']),
      command: nonEmptyStringSchema,
      verified: z.boolean(),
      evidence: z.string().nullish(),
    }),
  ),
  linked_documents: z.array(
    z.strictObject({ path: pathPatternSchema, reason: nonEmptyStringSchema }),
  ),
  questions: z.array(artifactQuestionSchema),
  /**
   * The Discovery agent's readiness assessment — product/17 § "What it measures": *"detected
   * automatically by the Discovery agent at onboarding"* (WP-21).
   *
   * Three fields and not four: the model reports **which** criterion and **whether** it passed,
   * with the evidence it has, and the platform supplies `unlocks` from `READINESS_CRITERIA`. A
   * criterion's value proposition is platform text, so a model cannot rewrite what passing it
   * claims to buy — and the three criteria the platform detects for itself (R9, R11, R12) are
   * **ignored** here even when the model names them, because a git-provider fact is not something
   * to take a model's word for. `evaluateReadiness` states that rule at the place it is applied.
   *
   * Optional, so a draft written before this field existed still parses: an absent assessment is
   * "reported nothing", which fails every agent-detected criterion — the conservative direction,
   * since readiness only ever makes the platform stricter (product/17 § "What it is not").
   */
  readiness: z
    .array(
      z.strictObject({
        /** `R1` … `R14`. An id outside the table is dropped rather than refused (rule 20). */
        id: nonEmptyStringSchema,
        passed: z.boolean(),
        evidence: z.string(),
      }),
    )
    .optional(),
  /**
   * The risk classes this repository's layout suggests — product/18:52, *"Risk classes proposed
   * from the repository structure"* (WP-37).
   *
   * **Three fields and not four, for the reason `readiness` has three**: the model says *which*
   * class and *which paths* it saw, with the evidence it has, and the platform supplies the
   * `require` list from product/19 §14's own table (`PROPOSED_RISK_CLASSES`). What a class *forces*
   * is a platform policy — a model that could write `require` could also write an empty one, and a
   * `payments` class that forces nothing is worse than no class at all.
   *
   * It is a **proposal and never a setting**: `onboarding/record.ts` stores it on the project for
   * the wizard to show, and `policies.risk_classes` changes only when a human accepts it through
   * `PUT /api/projects/:id/config` (product/06: nothing is committed without acceptance).
   *
   * Optional, so a draft written before this field existed still parses — an absent proposal is
   * "the agent proposed nothing", which leaves the platform's own five on the screen.
   */
  risk_classes: z
    .array(
      z.strictObject({
        /** A name from product/19 §14 (`auth`, `payments`, …). One outside the table is dropped. */
        name: nonEmptyStringSchema,
        paths: z.array(pathPatternSchema).min(1).max(MAX_PROPOSED_CLASS_PATHS),
        evidence: z.string(),
      }),
    )
    .optional(),
});

/**
 * `AskAnswer` — what an ask-the-task run returns (WP-31, product/10:57).
 *
 * *"answered from the audit trail and artifacts with links to the exact run and prompt"*, which is
 * what makes `citations` the load-bearing field rather than `answer`: an explanation nobody can
 * check against the record is the thing a transcript already is.
 *
 * Three rules are in the shape rather than in the prompt.
 *
 *  - **A citation names a row, never a URL.** `run_id` and `artifact_type`/`version` resolve
 *    through the read endpoints WP-15h shipped; a model that wrote a link could write any link,
 *    and the platform would be publishing it. `apps/web` renders the citation as a link it builds
 *    itself.
 *  - **A citation is scoped to the task at recording time.** `packages/application/src/ask` drops
 *    one that names another task's or another project's run (product/11:30), counts the drops and
 *    reports them; the schema cannot do it, because a schema does not know whose task this is.
 *  - **`unanswered` is required and may be empty.** A question the record does not answer has to
 *    be sayable, or the model's only way to comply is to invent (standing rule 16).
 */
/**
 * The caps every model-authored string in an `AskAnswer` is held to.
 *
 * Named rather than inline because the **recorder re-applies them** (WP-31 round 2): TD-012 step 2
 * replaces a credential with a `[REDACTED:…]` placeholder, which can be *longer* than the value it
 * replaced — so a `detail` that arrived exactly at its cap comes out of the redactor past it, and
 * the read endpoint that publishes it through this very schema would answer 500 rather than the
 * thread. `packages/application/src/ask/executor.ts` redacts and then cuts to these numbers, and
 * they are these numbers because a second copy is the thing that drifts (standing rule 63).
 */
export const MAX_ASK_CITATION_DETAIL_CHARS = 2_000;
export const MAX_ASK_CITATION_REFERENCE_CHARS = 512;
export const MAX_ASK_UNANSWERED_CHARS = 1_000;

export const askAnswerCitationSchema = z.strictObject({
  kind: z.enum(['run', 'artifact', 'audit', 'knowledge']),
  /** `kind: 'run'` — the run this claim rests on. Checked against the task's own runs. */
  run_id: idSchema.nullish(),
  /** `kind: 'artifact'` — which artifact, and which version of it. */
  artifact_type: artifactTypeSchema.nullish(),
  version: z.int().positive().nullish(),
  /** `kind: 'audit'` — the `human_actions` row's id. `kind: 'knowledge'` — the vault path. */
  reference: z.string().max(MAX_ASK_CITATION_REFERENCE_CHARS).nullish(),
  /** Why this row supports the claim, in the model's own words. Untrusted (BD-022). */
  detail: z.string().max(MAX_ASK_CITATION_DETAIL_CHARS),
});

export const askAnswerDataSchema = z.strictObject({
  /** The answer a human reads. Rendered as text nodes by the SPA, never as markup (BD-022). */
  answer: z.string().max(20_000),
  citations: z.array(askAnswerCitationSchema).max(50),
  /** What the record does not say. Empty is a claim, not an omission. */
  unanswered: z.array(z.string().max(MAX_ASK_UNANSWERED_CHARS)).max(20),
  confidence: z.enum(['high', 'medium', 'low']),
});

/**
 * `HistoryFindings` — product/19 §18's **fixed extraction schema** (WP-35).
 *
 * > *"Batches of ~20 MRs per Sonnet 5 run with a fixed extraction schema: recurring reviewer
 * > requests → rules candidates; conventions observed ≥ 3 times → `conventions.md` entries;
 * > pitfalls (MRs with ≥ 3 review rounds) → lessons; glossary terms; module ownership hints. Every
 * > proposal cites MR/ticket links as evidence."*
 *
 * The document's five findings are {@link historyFindingKindSchema}, and each one carries the two
 * fields that make it *checkable* rather than merely plausible:
 *
 *  - **`evidence` is structured and non-empty.** `.min(1)` is the schema half of product/19's
 *    *"every proposal cites MR/ticket links as evidence"*, and it is a `min` rather than a prompt
 *    sentence because an unevidenced proposal is the one shape that must never reach the queue: a
 *    maintainer reading the queue is reading claims about a repository the platform has just met,
 *    and a claim with nothing to follow is indistinguishable from an invention. The **resolution**
 *    of each link — is this a merge request the platform actually put in the prompt? — is the
 *    recorder's, because a schema cannot know which batch it is validating.
 *  - **`occurrences` is how many of the batch's items the claim was observed in.** product/19's
 *    thresholds are counts (*"observed ≥ 3 times"*, *"≥ 3 review rounds"*), so the model states its
 *    count and the platform applies the threshold. A model applying its own threshold would be the
 *    only judge of whether it had met it.
 */
export const historyFindingKindSchema = z.enum([
  /** A reviewer asked for the same thing repeatedly — product/19's *"rules candidates"*. */
  'rule',
  /** Something the code does consistently — `conventions.md`, at `occurrences >= 3`. */
  'convention',
  /** A merge request that took three or more review rounds — a lesson. */
  'pitfall',
  /** A word this team uses with a meaning of its own. */
  'glossary',
  /** Who reviews what, read off the history rather than off `CODEOWNERS`. */
  'ownership',
]);

/** Where a mined claim was observed. `ref` is `!12` or `ACME-3`; `url` is what a maintainer opens. */
export const historyEvidenceSchema = z.strictObject({
  kind: z.enum(['merge_request', 'ticket']),
  ref: nonEmptyStringSchema,
  url: urlSchema,
});

/** Longest page one mined proposal may carry; the curator's own byte cap applies on top. */
export const MAX_HISTORY_PROPOSAL_DELTA_CHARS = 8_000;
/** How many proposals one mining run may make. Past it they are recorded as refusals, never dropped. */
export const MAX_HISTORY_PROPOSALS_PER_RUN = 12;
/** How many links one proposal may cite. A claim resting on forty merge requests is a summary. */
export const MAX_HISTORY_EVIDENCE_PER_PROPOSAL = 10;

export const historyProposalSchema = z.strictObject({
  finding: historyFindingKindSchema,
  kind: knowledgeProposalKindSchema,
  type: knowledgeProposalTypeSchema,
  /** Vault-relative, like every other proposal: the platform joins `knowledge_dir` (BD-025). */
  target_path: pathPatternSchema,
  /** The page's whole intended content, not a patch — `librarianProposalSchema`'s rule. */
  delta: z.string().min(1).max(MAX_HISTORY_PROPOSAL_DELTA_CHARS),
  evidence: z.array(historyEvidenceSchema).min(1).max(MAX_HISTORY_EVIDENCE_PER_PROPOSAL),
  /** How many of the batch's merge requests or tickets this was observed in. */
  occurrences: z.int().min(1),
  significance: unitIntervalSchema,
  reason: nonEmptyStringSchema,
});

export const historyFindingsDataSchema = z.strictObject({
  proposals: z.array(historyProposalSchema).max(MAX_HISTORY_PROPOSALS_PER_RUN),
  /**
   * How many of the batch's merge requests the run actually read.
   *
   * A model's claim about its own coverage, kept because it is the only signal that a run stopped
   * early with an artifact — and labelled as the model's rather than compared with the platform's
   * count, which the recorder logs beside it.
   */
  merge_requests_read: z.int().nonnegative(),
  /** What the batch looked like, in the model's words. Rendered as text, never as markup. */
  summary: z.string().max(4_000),
});

/** `artifact_type` → the schema for that type's `data`. */
export const artifactDataSchemas = {
  RefinedSpec: refinedSpecDataSchema,
  RootCauseAnalysis: rootCauseAnalysisDataSchema,
  ImplementationPlan: implementationPlanDataSchema,
  ImplementationNotes: implementationNotesDataSchema,
  ReviewVerdict: reviewVerdictDataSchema,
  AcceptanceVerdict: acceptanceVerdictDataSchema,
  RetroReport: retroReportDataSchema,
  LibrarianProposals: librarianProposalsDataSchema,
  ShadowReport: shadowReportDataSchema,
  ReadinessReport: readinessReportDataSchema,
  DiscoveryDraft: discoveryDraftDataSchema,
  AskAnswer: askAnswerDataSchema,
  HistoryFindings: historyFindingsDataSchema,
} as const;

// ── Envelope ─────────────────────────────────────────────────────────────────

/**
 * The envelope every artifact shares (technical/12). `version` is the artifact version on the
 * task — a stage re-run creates a new version and never overwrites (technical/02 invariants).
 */
const artifactEnvelopeShape = {
  version: z.int().positive(),
  task_id: idSchema,
  run_id: idSchema,
  created_at: isoDateTimeSchema,
  language: languageTagSchema,
  markdown: z.string(),
} as const;

const artifactOf = <TType extends keyof typeof artifactDataSchemas, TData extends z.ZodType>(
  artifactType: TType,
  data: TData,
) => z.strictObject({ artifact_type: z.literal(artifactType), ...artifactEnvelopeShape, data });

/**
 * A complete artifact, discriminated on `artifact_type` so that `data` is narrowed to the right
 * shape. Parsing an artifact of an unknown type fails, as does an unknown key at any level.
 */
export const artifactSchema = z.discriminatedUnion('artifact_type', [
  artifactOf('RefinedSpec', refinedSpecDataSchema),
  artifactOf('RootCauseAnalysis', rootCauseAnalysisDataSchema),
  artifactOf('ImplementationPlan', implementationPlanDataSchema),
  artifactOf('ImplementationNotes', implementationNotesDataSchema),
  artifactOf('ReviewVerdict', reviewVerdictDataSchema),
  artifactOf('AcceptanceVerdict', acceptanceVerdictDataSchema),
  artifactOf('RetroReport', retroReportDataSchema),
  artifactOf('LibrarianProposals', librarianProposalsDataSchema),
  artifactOf('ShadowReport', shadowReportDataSchema),
  artifactOf('ReadinessReport', readinessReportDataSchema),
  artifactOf('DiscoveryDraft', discoveryDraftDataSchema),
  artifactOf('AskAnswer', askAnswerDataSchema),
  artifactOf('HistoryFindings', historyFindingsDataSchema),
]);

/** A reference to a stored artifact, used in event payloads and API DTOs. */
export const artifactRefSchema = z.strictObject({
  id: idSchema,
  artifact_type: artifactTypeSchema,
  version: z.int().positive(),
  url: urlSchema.nullish(),
});

export type ValidationCheck = z.infer<typeof validationCheckSchema>;
export type AcceptanceCriterion = z.infer<typeof acceptanceCriterionSchema>;
export type ArtifactQuestion = z.infer<typeof artifactQuestionSchema>;
export type KbCitation = z.infer<typeof kbCitationSchema>;
export type RefinedSpecData = z.infer<typeof refinedSpecDataSchema>;
export type RootCauseAnalysisData = z.infer<typeof rootCauseAnalysisDataSchema>;
export type ImplementationPlanData = z.infer<typeof implementationPlanDataSchema>;
export type ImplementationNotesData = z.infer<typeof implementationNotesDataSchema>;
export type ReviewFinding = z.infer<typeof reviewFindingSchema>;
export type ReviewVerdictData = z.infer<typeof reviewVerdictDataSchema>;
export type AcceptanceVerdictData = z.infer<typeof acceptanceVerdictDataSchema>;
export type KnowledgeProposalDraft = z.infer<typeof knowledgeProposalDraftSchema>;
export type RetroReportData = z.infer<typeof retroReportDataSchema>;
export type LibrarianAction = z.infer<typeof librarianActionSchema>;
export type LibrarianProposal = z.infer<typeof librarianProposalSchema>;
export type KbHealthFinding = z.infer<typeof kbHealthFindingSchema>;
export type LibrarianProposalsData = z.infer<typeof librarianProposalsDataSchema>;
export type ShadowReportData = z.infer<typeof shadowReportDataSchema>;
export type ReadinessReportData = z.infer<typeof readinessReportDataSchema>;
export type DiscoveryDraftData = z.infer<typeof discoveryDraftDataSchema>;
export type AskAnswerData = z.infer<typeof askAnswerDataSchema>;
export type HistoryFindingKind = z.infer<typeof historyFindingKindSchema>;
export type HistoryEvidence = z.infer<typeof historyEvidenceSchema>;
export type HistoryProposal = z.infer<typeof historyProposalSchema>;
export type HistoryFindingsData = z.infer<typeof historyFindingsDataSchema>;
export type AskAnswerCitation = z.infer<typeof askAnswerCitationSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export type ArtifactRef = z.infer<typeof artifactRefSchema>;

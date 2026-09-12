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

export const shadowReportDataSchema = z.strictObject({
  ticket: nonEmptyStringSchema,
  human_mr: mergeRequestRefSchema.nullish(),
  agent_diff_stats: z.strictObject({
    files_changed: z.int().nonnegative(),
    insertions: z.int().nonnegative(),
    deletions: z.int().nonnegative(),
  }),
  overlap: z.strictObject({
    files_jaccard: unitIntervalSchema,
    size_ratio: z.number().nonnegative().finite(),
  }),
  agent_review_of_human_mr: z.array(reviewFindingSchema),
  predicted_cost: usdSchema,
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
export type Artifact = z.infer<typeof artifactSchema>;
export type ArtifactRef = z.infer<typeof artifactRefSchema>;

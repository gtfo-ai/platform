/**
 * The pipeline templates the platform ships — product/04 § "Default stages", § "Bug template",
 * § "Chore template", and technical/12's `.agentic/pipeline.yml` example, which is the wire form
 * of the same graph.
 *
 * "A pipeline is data, not code" (product/04 § "Customisation model"), so these are `PipelineTemplate`
 * values of exactly the shape `.agentic/pipeline.yml` parses into. A project that overrides a
 * template hands the interpreter its own value of the same type; nothing downstream can tell the
 * difference, which is what keeps custom templates a first-class case rather than a branch.
 *
 * ## What is here and what is deliberately not
 *
 *  - **feature, bug, chore** — the three the WP-15 row of the implementation plan names. `spike`
 *    (product/04 § "Spike template") is in `BUILTIN_TEMPLATE_IDS` and is **not** shipped here: it
 *    ends at a human with no MR, so it exercises none of the loop this work package is about, and a
 *    template nothing runs is a template nothing tests.
 *  - **No `librarian` stage.** technical/12's example template carries one after `retrospective`;
 *    the Librarian is WP-18's pipeline (product/05), and a stage whose executor does not exist
 *    would park every task one step short of `done`.
 *  - `intake` and `done` are `system` stages: the interpreter passes straight through them, which
 *    is what makes "the task entered the pipeline" and "the task finished it" observable as
 *    `task.stage.entered` events rather than as a gap in the log.
 *
 * The stage ids are `BUILTIN_STAGE_IDS` from `@platform/contracts`; the roles, models and limits
 * come from product/04 § "Stage defaults" (BD-013).
 */
import type { Effort, PipelineTemplate, Slug, Stage } from '@platform/contracts';
import { pipelineGraphIssues, pipelineTemplateSchema } from '@platform/contracts';
import { PolicyViolationError } from '../errors.js';

/**
 * Per-stage agent defaults — product/04 § "Stage defaults: model, effort, limits (proposed —
 * BD-013)", transcribed. The per-run budget of the same table lives in
 * `../policies/budgets.js` (`DEFAULT_STAGE_RUN_BUDGET_USD`), where the rest of the budget rules
 * are; duplicating it here would give one number two homes.
 *
 * Every value is overridable at global, project and repository level (`stages.<id>` in
 * `.agentic/config.yml`), which is why this is a lookup rather than a field on the stage: the
 * template says *what* runs, the configuration says *how*.
 */
export interface StageAgentDefaults {
  readonly model: string;
  readonly effort: Effort;
  readonly maxTurns: number;
}

export const STAGE_AGENT_DEFAULTS: Readonly<Record<string, StageAgentDefaults>> = {
  intake: { model: 'claude-haiku-4-5', effort: 'low', maxTurns: 3 },
  refinement: { model: 'claude-opus-5', effort: 'medium', maxTurns: 30 },
  investigation: { model: 'claude-opus-5', effort: 'high', maxTurns: 60 },
  architecture: { model: 'claude-opus-5', effort: 'high', maxTurns: 60 },
  implementation: { model: 'claude-opus-5', effort: 'high', maxTurns: 200 },
  code_review: { model: 'claude-opus-5', effort: 'high', maxTurns: 60 },
  business_review: { model: 'claude-sonnet-5', effort: 'medium', maxTurns: 40 },
  retrospective: { model: 'claude-sonnet-5', effort: 'medium', maxTurns: 30 },
  librarian: { model: 'claude-sonnet-5', effort: 'medium', maxTurns: 30 },
} as const;

/** The fallback for a stage the table above does not name (a project's custom agent stage). */
export const FALLBACK_STAGE_AGENT_DEFAULTS: StageAgentDefaults = {
  model: 'claude-sonnet-5',
  effort: 'medium',
  maxTurns: 30,
};

export const stageAgentDefaults = (stage: Slug): StageAgentDefaults =>
  STAGE_AGENT_DEFAULTS[stage] ?? FALLBACK_STAGE_AGENT_DEFAULTS;

/**
 * The tail every template shares: review, the two gates that bracket the human merge, and the
 * retrospective. Written once because "Ready for merge (human) → Merged gate → Retrospective →
 * Done" is the same in all three of product/04's templates, and three copies of it would drift.
 *
 * `ready_for_merge` is where the task sleeps: "While waiting, nothing runs. The task sleeps and is
 * woken only by events (comment, approval, CI result, merge)". Its `on` list is that sentence as
 * data — a comment returns it to `implementation` (batched, BD-007), a merge advances it.
 */
const BUSINESS_REVIEW_STAGE: Stage = {
  id: 'business_review',
  kind: 'agent',
  role: 'acceptance_tester',
  produces: 'AcceptanceVerdict',
  requires: ['ImplementationNotes'],
  approve_to: 'rebase_gate',
  return_to: 'implementation',
};

const mergeTail = (options: { readonly businessReview: boolean }): readonly Stage[] => [
  ...(options.businessReview ? [BUSINESS_REVIEW_STAGE] : []),
  { id: 'rebase_gate', kind: 'gate', pass_to: 'ready_for_merge', fail_to: 'implementation' },
  {
    id: 'ready_for_merge',
    kind: 'human',
    on: [
      { on: 'mr.review.comment', to: 'implementation' },
      { on: 'default_branch.moved', to: 'rebase_gate' },
      { on: 'mr.merged', to: 'merged_gate' },
    ],
  },
  { id: 'merged_gate', kind: 'gate', pass_to: 'retrospective' },
  {
    id: 'retrospective',
    kind: 'agent',
    role: 'facilitator',
    produces: 'RetroReport',
    next: 'done',
  },
  { id: 'done', kind: 'system' },
];

/**
 * product/04's default stage set:
 * `Intake → Refinement → Architecture → Implementation → CI gate → Code review → Business review →
 * Rebase gate → Ready for merge → Merged gate → Retrospective → Done`.
 */
export const FEATURE_TEMPLATE: PipelineTemplate = {
  stages: [
    { id: 'intake', kind: 'system' },
    {
      id: 'refinement',
      kind: 'agent',
      role: 'product_manager',
      produces: 'RefinedSpec',
      requires: [],
    },
    {
      id: 'architecture',
      kind: 'agent',
      role: 'architect',
      produces: 'ImplementationPlan',
      requires: ['RefinedSpec'],
      return_to: 'refinement',
    },
    {
      id: 'implementation',
      kind: 'agent',
      role: 'developer',
      produces: 'ImplementationNotes',
      requires: ['ImplementationPlan'],
      return_to: 'architecture',
    },
    {
      id: 'ci_gate',
      kind: 'gate',
      on: 'ci.pipeline.finished',
      pass_to: 'code_review',
      fail_to: 'implementation',
    },
    {
      id: 'code_review',
      kind: 'agent',
      role: 'reviewer',
      produces: 'ReviewVerdict',
      requires: ['ImplementationNotes'],
      approve_to: 'business_review',
      return_to: 'implementation',
    },
    ...mergeTail({ businessReview: true }),
  ],
};

/**
 * product/04 § "Bug template (differences)": `Intake → Refinement (bug-flavoured) → Investigation →
 * Architecture (fix plan, regression test) → Implementation → …`. Everything from `implementation`
 * on is the feature template's, which is the point of the difference being stated as one stage.
 */
export const BUG_TEMPLATE: PipelineTemplate = {
  stages: [
    { id: 'intake', kind: 'system' },
    {
      id: 'refinement',
      kind: 'agent',
      role: 'product_manager',
      produces: 'RefinedSpec',
      requires: [],
    },
    {
      id: 'investigation',
      kind: 'agent',
      role: 'investigator',
      produces: 'RootCauseAnalysis',
      requires: ['RefinedSpec'],
      return_to: 'refinement',
    },
    {
      id: 'architecture',
      kind: 'agent',
      role: 'architect',
      produces: 'ImplementationPlan',
      requires: ['RootCauseAnalysis'],
      return_to: 'investigation',
    },
    {
      id: 'implementation',
      kind: 'agent',
      role: 'developer',
      produces: 'ImplementationNotes',
      requires: ['ImplementationPlan'],
      return_to: 'architecture',
    },
    {
      id: 'ci_gate',
      kind: 'gate',
      on: 'ci.pipeline.finished',
      pass_to: 'code_review',
      fail_to: 'implementation',
    },
    {
      id: 'code_review',
      kind: 'agent',
      role: 'reviewer',
      produces: 'ReviewVerdict',
      requires: ['ImplementationNotes'],
      approve_to: 'business_review',
      return_to: 'implementation',
    },
    ...mergeTail({ businessReview: true }),
  ],
};

/**
 * product/04 § "Chore template": "Small, mechanical tasks … `Intake → Refinement (light) →
 * Implementation → CI → Code review → Ready → Merged → Retro (light)`. No Architecture, no
 * Business review."
 *
 * With no Architecture stage, `implementation` requires the `RefinedSpec` directly and a code
 * review return has nowhere further back to go than `implementation`, which is what the graph
 * says rather than something the interpreter has to special-case.
 */
export const CHORE_TEMPLATE: PipelineTemplate = {
  stages: [
    { id: 'intake', kind: 'system' },
    {
      id: 'refinement',
      kind: 'agent',
      role: 'product_manager',
      produces: 'RefinedSpec',
      requires: [],
    },
    {
      id: 'implementation',
      kind: 'agent',
      role: 'developer',
      produces: 'ImplementationNotes',
      requires: ['RefinedSpec'],
      return_to: 'refinement',
    },
    {
      id: 'ci_gate',
      kind: 'gate',
      on: 'ci.pipeline.finished',
      pass_to: 'code_review',
      fail_to: 'implementation',
    },
    {
      id: 'code_review',
      kind: 'agent',
      role: 'reviewer',
      produces: 'ReviewVerdict',
      requires: ['ImplementationNotes'],
      approve_to: 'rebase_gate',
      return_to: 'implementation',
    },
    ...mergeTail({ businessReview: false }),
  ],
};

export const SHIPPED_TEMPLATES: Readonly<Record<string, PipelineTemplate>> = {
  feature: FEATURE_TEMPLATE,
  bug: BUG_TEMPLATE,
  chore: CHORE_TEMPLATE,
};

/**
 * Validates a template the way the platform must before it runs a task on it: the *shape*
 * (`pipelineTemplateSchema`, which is where a gate that nothing can resolve is refused) and then
 * the *graph* (`pipelineGraphIssues`).
 *
 * Both halves are needed and neither implies the other — a template can be perfectly shaped and
 * still point at a stage that does not exist — and a project template arrives as parsed YAML, so
 * the shape check is not redundant even when TypeScript is satisfied.
 *
 * @throws {PolicyViolationError} listing every problem found, not just the first.
 */
export const assertValidTemplate = (id: Slug, template: PipelineTemplate): void => {
  const shape = pipelineTemplateSchema.safeParse(template);
  if (!shape.success) {
    const detail = shape.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new PolicyViolationError('pipeline.template', `template "${id}" is malformed: ${detail}`);
  }
  const issues = pipelineGraphIssues(template);
  if (issues.length > 0) {
    const detail = issues.map((issue) => `${issue.stage}: ${issue.detail}`).join('; ');
    throw new PolicyViolationError('pipeline.template', `template "${id}" is invalid: ${detail}`);
  }
};

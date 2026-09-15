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
 *  - **The `librarian` stage** technical/12's example template carries after `retrospective`. It was
 *    cut at WP-15 ("a stage whose executor does not exist would park every task one step short of
 *    `done`") and put back at **WP-18b**, which built the executor's other half: the
 *    `LibrarianProposals` artifact, the curator that turns it into `kb_proposals` rows, and the
 *    apply policy. It runs with the task in `retro`, like the retrospective before it — see
 *    `startLibrarianCuration` — and it has no `return_to`: the merge has already happened, so
 *    nothing it finds can send the task back to work.
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
  /**
   * product/06 § "Step 2 — Technical discovery": *"a Discovery agent (Sonnet 5, read-only, bounded
   * budget) inspects the repository"*. The turn count is the fallback's; the model and the effort
   * are the document's, and the budget is `DEFAULT_STAGE_RUN_BUDGET_USD.discovery`.
   */
  discovery: { model: 'claude-sonnet-5', effort: 'medium', maxTurns: 40 },
  /**
   * The ticket readiness linter (WP-25), and the row is where *"light"* is actually expressed.
   *
   * product/18 calls it *"a light Refinement pass"* and product/19 § 12 publishes its cost
   * implication as **~$0.10 per ticket**; `refinement` is Opus 5 at 30 turns with a $2 run cap
   * (`DEFAULT_STAGE_RUN_BUDGET_USD`). Running the linter under the refinement row would have been
   * twenty times the published figure, so the stage has a row of its own: Sonnet 5 — the model every
   * other cheap stage uses — at `low` effort, and **5 turns**, because a lint reads one ticket and
   * answers once. The one thing it must not do is take the repository apart, which is why its
   * platform-tool list is narrowed as well (`PLATFORM_TOOLS_DENIED_BY_STAGE`).
   */
  ticket_lint: { model: 'claude-sonnet-5', effort: 'low', maxTurns: 5 },
  /**
   * The history bootstrap's mining run (WP-35). product/19 §18 names the model in the
   * specification itself — *"batches of ~20 MRs per **Sonnet 5** run"* — so the model is the
   * document's rather than this table's choice.
   *
   * **Ten turns**, which is fewer than every other agent stage, and the reason is what the run
   * does: everything it reads is already in its prompt (`tasks.history_sample`), so a turn is a
   * thought rather than a tool call. Its tool list has no `Bash` and no writes, so a run that spent
   * forty turns would be spending them re-reading the same text.
   */
  history_mining: { model: 'claude-sonnet-5', effort: 'medium', maxTurns: 10 },
  /**
   * The rebase gate's conflict resolution (WP-26), and the row is where *"short"* is expressed.
   *
   * product/04 S6b asks for *"a short Implementation run"*. The **model** is `implementation`'s,
   * deliberately: a conflict is resolved by understanding two changes to the same lines, and a
   * resolution that silently drops one of them is a defect no later stage looks for. What is short
   * is the *work* — 40 turns against implementation's 200 and a $5 cap against its $15
   * (`DEFAULT_STAGE_RUN_BUDGET_USD.conflict_resolution`), because the job is bounded by the number
   * of conflicted hunks rather than by the ticket's scope, and `medium` effort rather than `high`
   * for the same reason.
   */
  conflict_resolution: { model: 'claude-opus-5', effort: 'medium', maxTurns: 40 },
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

/**
 * product/04 S6b's *"resolve conflicts (bounded, default 2 attempts, by a short Implementation
 * run)"* — WP-26, and the three decisions it embodies.
 *
 * **It is a run, not a provider call.** `GitProviderPort`'s own docblock says *"the port never
 * touches a working copy: clone, branch, commit, rebase and push are the workspace manager's job,
 * with `git` and a credential helper (BD-025)"*, and the half product/04 actually asks for —
 * *resolving* the conflict — is not something a provider's server-side rebase endpoint can do at
 * all: it fails on conflict and hands the branch back. So the gate's failure enters a stage with
 * the developer's role, its workspace and its narrowed command policy.
 *
 * **It is spliced in before `ci_gate`, and the forward path steps over it.** `implementation`
 * carries an explicit `approve_to: 'ci_gate'` for exactly that reason — declaration order is the
 * pipeline, so a stage that must be *reachable only backwards* has to sit behind the stage that
 * skips it. Two things fall out, and both are product/04 S6b's sentence rather than a coincidence:
 * the gate's `fail_to` is a **return**, so it spends a round of the `rebase` loop and the third
 * failure escalates (*"bounded, default 2 attempts"*); and the resolution's own fall-through is
 * `ci_gate`, so the pushed merge commit is **re-checked by the CI gate the platform already has**
 * (*"re-run CI"*) rather than by a local command no run is allowed to execute (PROGRESS backlog
 * 49). Re-entering `ci_gate` re-runs the review tail as well, which is the price of resolving a
 * conflict by changing the code: the diff a human is asked to merge is not the one that was
 * reviewed.
 *
 * **It merges rather than rebases, and that is measured rather than preferred** — see
 * `STAGE_PROMPT_FOCUS.conflict_resolution` and Q76. product/04 S6b says *"rebase (or merge, per
 * project)"*; product/19 §3 blocks `git push --force*` at the organisation maximum and no project
 * may remove it (`DEFAULT_BLOCKED_COMMANDS`), so a rebased branch cannot be published by any run
 * this build starts. The merge can: it fast-forwards the agent's own branch and pushes it with the
 * allow-listed `git push origin agentic/*`.
 */
const CONFLICT_RESOLUTION_STAGE: Stage = {
  id: 'conflict_resolution',
  kind: 'agent',
  role: 'developer',
  produces: 'ImplementationNotes',
  // The notes name the merge request and the branch the run has to bring up to date, and they are
  // produced by `implementation`, which is upstream in all three ticket templates — the plan is
  // not (`chore` has no architecture stage), so requiring it would make one template invalid.
  requires: ['ImplementationNotes'],
};

const mergeTail = (options: { readonly businessReview: boolean }): readonly Stage[] => [
  ...(options.businessReview ? [BUSINESS_REVIEW_STAGE] : []),
  { id: 'rebase_gate', kind: 'gate', pass_to: 'ready_for_merge', fail_to: 'conflict_resolution' },
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
    next: 'librarian',
  },
  {
    id: 'librarian',
    kind: 'agent',
    role: 'librarian',
    produces: 'LibrarianProposals',
    requires: ['RetroReport'],
  },
  { id: 'done', kind: 'system' },
];

/**
 * product/04's default stage set:
 * `Intake → Refinement → Architecture → Implementation → CI gate → Code review → Business review →
 * Rebase gate → Ready for merge → Merged gate → Retrospective → Done`.
 *
 * `conflict_resolution` is declared between `implementation` and `ci_gate` and is **not** in that
 * sentence, which is the point: nothing advances into it, and only `rebase_gate.fail_to` enters it
 * (WP-26 — see {@link CONFLICT_RESOLUTION_STAGE}).
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
      /**
       * Explicit, because `conflict_resolution` sits between this stage and the gate: the forward
       * path steps over it and only `rebase_gate.fail_to` enters it (WP-26).
       *
       * `approve_to` rather than `next`: an agent stage's completion is routed by its **verdict**,
       * and `ImplementationNotes` has no verdict channel, so `stageVerdict` reads it as `approve`.
       * `next` is consulted for a `system` stage only (`interpret`), which is why the `next:
       * 'librarian'` on `retrospective` is decoration that happens to agree with declaration order.
       */
      approve_to: 'ci_gate',
    },
    CONFLICT_RESOLUTION_STAGE,
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
 * on is the feature template's, which is the point of the difference being stated as one stage —
 * including the `conflict_resolution` stage only the rebase gate enters (WP-26).
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
      /**
       * Explicit, because `conflict_resolution` sits between this stage and the gate: the forward
       * path steps over it and only `rebase_gate.fail_to` enters it (WP-26).
       *
       * `approve_to` rather than `next`: an agent stage's completion is routed by its **verdict**,
       * and `ImplementationNotes` has no verdict channel, so `stageVerdict` reads it as `approve`.
       * `next` is consulted for a `system` stage only (`interpret`), which is why the `next:
       * 'librarian'` on `retrospective` is decoration that happens to agree with declaration order.
       */
      approve_to: 'ci_gate',
    },
    CONFLICT_RESOLUTION_STAGE,
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
 * says rather than something the interpreter has to special-case. The rebase gate's
 * `conflict_resolution` stage is the feature template's, unchanged: a chore's merge request meets
 * a moving default branch exactly as any other does.
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
      /** As in the other two templates: the forward path steps over `conflict_resolution`. */
      approve_to: 'ci_gate',
    },
    CONFLICT_RESOLUTION_STAGE,
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

/**
 * product/06 § "Step 2 — Technical discovery", as a pipeline template (WP-21).
 *
 * **Discovery is a stage of a one-off task, not a job with a `RunSpec` of its own**, and the
 * reason is structural rather than stylistic: `runs.task_id` is `not null` (migration 0004) and
 * `RunSpec.taskId` is required, so a discovery run needs a task whatever else is decided. Making
 * it a template means the run is created, budgeted, transcribed, cost-accounted, re-validated and
 * escalated by exactly the code every other run goes through — `createStageRunPlanner` already
 * has a `discovery` row in all three least-privilege tables, and the admission guard, the ledger
 * and the `run:<id>` stream need no second entry point. The precedent is WP-18b's `librarian`
 * stage, which is likewise entered outside the ticket flow's decisions and is still a stage.
 *
 * There is no ticket, so the task the wizard creates carries a **platform-issued** ticket
 * reference rather than a provider's (`startProjectDiscovery` builds it), and the template ends
 * one stage after it starts: discovery produces a draft for a human, and nothing it finds moves
 * any code.
 */
export const DISCOVERY_TEMPLATE: PipelineTemplate = {
  stages: [
    { id: 'intake', kind: 'system' },
    {
      id: 'discovery',
      kind: 'agent',
      role: 'discovery',
      produces: 'DiscoveryDraft',
      requires: [],
    },
    { id: 'done', kind: 'system' },
  ],
};

/**
 * product/04 § "Operating modes that reuse stages": *"**Review-only mode:** the Code review stage
 * alone, on human MRs (product/18)"* — WP-24.
 *
 * **One agent stage, and the same one.** The role, the artifact type, the verdict channel and the
 * prompt are `code_review`'s, because product/04 says *the Code review stage*, not "a reviewing
 * stage": a second stage id would give the Reviewer two prompts, two eval corpora and two sets of
 * stage defaults to keep in step, and a project that tunes `stages.code_review.model` would tune
 * one of them.
 *
 * ## Why both verdicts go forward, and why that is the template's job
 *
 * product/18 says the summary *"never blocks merge"*. The interpreter reads `request_changes` as
 * "return to `return_to`, or escalate when the template names none" — so a review-only template
 * with no `return_to` would park **every** merge request the Reviewer had a finding about in
 * `needs_human`, which is precisely the blocking this mode promises not to do. The template
 * therefore names `done` for both, and the interpreter's rule 2 does the rest: *"a target that sits
 * later, or at the same index, is an advance"*, so `return_to: done` consumes no bounded loop and
 * produces an ordinary advance with the reason `requested changes`.
 *
 * It is expressed in the template rather than as a branch in the interpreter on purpose. "A
 * pipeline is data, not code": the fact that this mode does not block is a property of *this*
 * graph, and a project that wanted a blocking review-only mode would say so by editing it.
 *
 * ## What it deliberately does not contain
 *
 * No `intake` classification, no rebase gate, no `ready_for_merge`, no merged gate and no
 * retrospective: nothing here produces a commit, so there is nothing to rebase, nothing to merge
 * and no delivery to learn from. The task ends when the review has been posted, which is the whole
 * of what product/18 level 0 (*"No agent MRs"*) permits.
 *
 * The merge request itself is **not** a `requires` artifact — no stage of this template produces
 * one, and `pipelineGraphIssues` would refuse it. It reaches the prompt as `tasks.review_subject`,
 * read from the provider before the task is created (`application/pipeline/review-only.ts`).
 */
export const REVIEW_ONLY_TEMPLATE: PipelineTemplate = {
  stages: [
    { id: 'intake', kind: 'system' },
    {
      id: 'code_review',
      kind: 'agent',
      role: 'reviewer',
      produces: 'ReviewVerdict',
      requires: [],
      approve_to: 'done',
      return_to: 'done',
    },
    { id: 'done', kind: 'system' },
  ],
};

/**
 * product/04 § "Operating modes that reuse stages": *"**Ticket readiness linter:** a light
 * Refinement pass on unlabelled tickets that posts one comment (product/18)"* — WP-25.
 *
 * **One agent stage, the Product Manager's, and a stage id of its own.** technical/04's mode table
 * says the linter is the *"Product Manager role, ticket only, no repo, one comment"*, so the role
 * and the artifact are `refinement`'s — a second *role* would mean a second prompt and a second eval
 * corpus for the same job (`REVIEW_ONLY_TEMPLATE` makes that argument for the Reviewer). The **stage
 * id** is not `refinement`, and that is the opposite call from review-only's, taken for two reasons
 * that do not apply there:
 *
 *  - *"light"* lives in the stage defaults, and they are keyed by stage id. `refinement` is Opus 5,
 *    30 turns, a $2 cap; product/19 § 12 prices a lint at ~$0.10 (`STAGE_AGENT_DEFAULTS.ticket_lint`
 *    and `DEFAULT_STAGE_RUN_BUDGET_USD.ticket_lint` carry the derivation);
 *  - `status_mapping` is keyed by stage id too (technical/12's example maps `refinement` to *"In
 *    Refinement"*), and a linter that moved a human's ticket into the agent's workflow column would
 *    be doing the one thing product/18 level 0 promises it does not do.
 *
 * The prompt is the Product Manager's with a narrower instruction rather than a variant file:
 * `STAGE_PROMPT_FOCUS.ticket_lint` (`packages/domain/src/prompt/assembly.ts`) is platform text the
 * assembler renders into the task section, so `ROLE_PROMPT_VERSIONS` and the role's eval cases are
 * untouched while `promptVersion`'s digest still moves when the instruction is edited.
 *
 * **Where the ticket comes from.** The linter's task carries a platform-issued ticket reference
 * (`application/pipeline/ticket-lint.ts`), and the ticket's own words reach the prompt as
 * `tasks.ticket_snapshot` — read once, bounded and redacted by WP-15f's reader, before the task
 * exists. There is no `requires` artifact for the same reason `REVIEW_ONLY_TEMPLATE` has none: no
 * stage of this template produces one.
 *
 * **What it deliberately does not contain**: no classification, no gates, no merge tail. Nothing
 * here produces a commit, and the task ends when the one comment has been posted.
 */
export const TICKET_LINT_TEMPLATE: PipelineTemplate = {
  stages: [
    { id: 'intake', kind: 'system' },
    {
      id: 'ticket_lint',
      kind: 'agent',
      role: 'product_manager',
      produces: 'RefinedSpec',
      requires: [],
      /**
       * **The artifact is read, not obeyed.** A `RefinedSpec` normally decides the transition — an
       * unready ticket yields `decision: 'ask'`, which parks the task on blocking questions, and
       * `reject` escalates it. An unready ticket is precisely what this stage exists to find, so
       * obeying the verdict would park every lint on a question nobody is watching and escalate the
       * worst tickets to a human. `agentStageSchema.advisory` carries the argument; the questions
       * reach their audience as the comment.
       */
      advisory: true,
    },
    { id: 'done', kind: 'system' },
  ],
};

/**
 * The templates that run a **ticket** to a merge request — product/04's three.
 *
 * Separate from {@link SHIPPED_TEMPLATES} because the merge tail is a property of these three and
 * not of every template the platform ships: `discovery` never opens a merge request, so a rule
 * written about "every shipped template" would either be false or would have to be weakened until
 * it stopped saying anything.
 */
export const TICKET_TEMPLATES: Readonly<Record<string, PipelineTemplate>> = {
  feature: FEATURE_TEMPLATE,
  bug: BUG_TEMPLATE,
  chore: CHORE_TEMPLATE,
};

/**
 * The history bootstrap's mining run — product/06 step 3b, product/19 §18 (WP-35).
 *
 * **One batch of ~20 merge requests is one task on this template**, and there is no second entry
 * point: `runs.task_id` is `not null`, so a mining run needs a task whatever else is decided, and
 * reusing the stage path means the admission guard, the cost ledger, the transcript sink, the
 * budget cap, the conflict retry and the `needs_human` escalation all apply unchanged.
 * `DISCOVERY_TEMPLATE` carries the long version of that argument and this is the third row to take
 * it (`REVIEW_ONLY_TEMPLATE` and `TICKET_LINT_TEMPLATE` are the others).
 *
 * **Why N tasks rather than one task with N stages.** A template is data and its stage list is
 * fixed; a batch's size is not — 200 merge requests is ten runs and 40 is two. A template that
 * could express "as many stages as the collection found" would be a template with a loop in it,
 * which is the one thing `interpret` does not have. So the *number of runs* is a property of the
 * collection, expressed as tasks, exactly as a shadow batch is N tasks (`shadow/batch.ts`).
 *
 * **Where the input comes from.** Not from a `requires` artifact — no stage of this template
 * produces one — and not from the repository: the mined history is `tasks.history_sample`, written
 * by the same `insert` that creates the task (`application/src/bootstrap/collect.ts`), bounded and
 * redacted at that write, and rendered into the prompt as a data block. The run reads its evidence
 * out of its own prompt, which is why the fake runner can key a scenario on it (standing rule 82).
 */
export const HISTORY_BOOTSTRAP_TEMPLATE_ID = 'history_bootstrap';

export const HISTORY_BOOTSTRAP_TEMPLATE: PipelineTemplate = {
  stages: [
    { id: 'intake', kind: 'system' },
    {
      id: 'history_mining',
      kind: 'agent',
      role: 'historian',
      produces: 'HistoryFindings',
      requires: [],
    },
    { id: 'done', kind: 'system' },
  ],
};

export const SHIPPED_TEMPLATES: Readonly<Record<string, PipelineTemplate>> = {
  ...TICKET_TEMPLATES,
  discovery: DISCOVERY_TEMPLATE,
  review_only: REVIEW_ONLY_TEMPLATE,
  ticket_lint: TICKET_LINT_TEMPLATE,
  [HISTORY_BOOTSTRAP_TEMPLATE_ID]: HISTORY_BOOTSTRAP_TEMPLATE,
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

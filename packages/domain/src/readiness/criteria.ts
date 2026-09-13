/**
 * Repository readiness — product/17's fourteen criteria and its five levels, as data (WP-21).
 *
 * > "Autonomy is only as safe as the repository's ability to prove work correct. … Readiness makes
 * > that limit explicit, measured and actionable."
 *
 * The table below is product/17 § "What it measures" transcribed, and {@link readinessLevelFor} is
 * § "Levels" transcribed. Both live in the domain ring because they are a *policy*: nothing here
 * reads a repository, calls a provider or touches a clock — an evaluator hands in which criteria
 * passed and gets a level back.
 *
 * ## Who detects a criterion, and why the split is in the type
 *
 * `detectedBy` is the one field product/17's table does not spell out, and it is load-bearing.
 * Eleven criteria are things only something that has *read the repository* can answer, so the
 * Discovery agent reports them and its answer is model output (BD-022). Three are facts the
 * **platform** already holds, and asking the model for them would be trusting model output for a
 * question the platform can answer itself:
 *
 *  - **R9** (protected default branch) is a git-provider API read — the same
 *    `isBranchProtected` the intake check makes before it starts a task;
 *  - **R11** (observability bindings present) is a `bindings` row;
 *  - **R12** (knowledge completeness ≥ 70 %) is the index, through
 *    {@link knowledgeCompleteness}.
 *
 * The consequence is stated rather than implied: a model that claims R9 is **ignored**, because
 * `evaluateReadiness` takes the platform's answer for a platform-detected criterion and never the
 * agent's. And `unlocks` is platform text in every row — it is never copied out of an artifact —
 * so nothing a model writes can change what a criterion claims to buy.
 *
 * ## Three criteria are read for what a run can establish, not for what product/17 says
 *
 * product/17 detects R1 and R6 "executed in the workspace" and R2 "measured". **No run on this
 * platform can execute a project command**: the organisation command maximum is
 * `DEFAULT_COMMAND_POLICY`, it contains no test, lint or setup command, a project may only *narrow*
 * it (`narrowCommandPolicy` drops an `allow` entry the maximum does not grant), and nothing in this
 * build lets an operator widen the maximum. Read literally, R1 — a **level 1** requirement — would
 * be unreachable for every repository and the whole ladder would be decorative. So the three are
 * detected by reading the CI configuration, and each says so at its own `detection` line. Closing
 * the gap is a product decision (widen the maximum, or reword product/17) and is recorded in
 * `PROGRESS.md` under Discovered work rather than taken here.
 *
 * ## A criterion nobody answered is `false`
 *
 * Readiness only ever makes the platform *more* conservative (product/17 § "What it is not": it is
 * not a gate, except level 0 restricting to chore/spike, which a maintainer can override). So an
 * unanswered criterion fails: the cost of a false negative is a suggestion that is stricter than
 * necessary, and the cost of a false positive is autonomy the repository cannot support.
 */
import type { Slug } from '@platform/contracts';

/** Who can answer a criterion — see the module docblock. */
export type ReadinessDetector = 'agent' | 'platform';

export interface ReadinessCriterion {
  /** `R1` … `R14`, product/17's own numbering. */
  readonly id: string;
  /** The criterion as product/17 states it. */
  readonly title: string;
  /** product/17's "How detected" column. */
  readonly detection: string;
  /** product/17's "Unlocks / protects" column. **Platform text, never model output.** */
  readonly unlocks: string;
  readonly detectedBy: ReadinessDetector;
}

/** product/17 § "What it measures", transcribed. Order is the document's. */
export const READINESS_CRITERIA: readonly ReadinessCriterion[] = [
  {
    id: 'R1',
    title: 'Test suite exists and runs green on default branch',
    // product/17 says "executed in the workspace". **No run on this platform can execute a project
    // command**: the org command maximum (`DEFAULT_COMMAND_POLICY`) has none, and a project may
    // only narrow it (`narrowCommandPolicy`), so the criterion is detected by reading the CI
    // configuration instead. The gap is `PROGRESS.md`'s discovered work, not a silent reinterpretation.
    detection: 'test command found in how-to-run.md/CI config, and a CI job that runs it',
    unlocks:
      'Implementation self-check; acceptance evidence; test tamper gate has something to protect',
    detectedBy: 'agent',
  },
  {
    id: 'R2',
    title: 'Tests finish in < 15 minutes',
    // product/17 says "measured". See R1: nothing can run the suite, so this is the documented
    // duration or a CI timeout below the threshold.
    detection: 'a documented duration or a CI timeout below 15 minutes',
    unlocks: 'Fast inner loop; fewer per-run timeouts',
    detectedBy: 'agent',
  },
  {
    id: 'R3',
    title: 'CI runs on merge requests',
    detection: 'pipeline events observed for MRs',
    unlocks: 'Deterministic CI gate; flaky detection',
    detectedBy: 'agent',
  },
  {
    id: 'R4',
    title: 'CI is reliable (< 5% flaky reruns in last 30 days)',
    detection: 'gate statistics',
    unlocks: 'Returns caused by infrastructure are not blamed on the agent',
    detectedBy: 'agent',
  },
  {
    id: 'R5',
    title: 'Lint and formatter enforced in CI',
    detection: 'config + CI job',
    unlocks: 'Reviewer skips style; fewer nit iterations',
    detectedBy: 'agent',
  },
  {
    id: 'R6',
    title: 'One-command dev setup (make setup, devcontainer, compose)',
    // product/17 says "executed in the workspace". See R1.
    detection: 'a documented one-command setup (make setup, a devcontainer, a compose file)',
    unlocks: 'Reproducible workspaces; app can be booted for business review',
    detectedBy: 'agent',
  },
  {
    id: 'R7',
    title: 'Type checking or static analysis in CI (where applicable)',
    detection: 'config',
    unlocks: 'Earlier error detection in Implementation',
    detectedBy: 'agent',
  },
  {
    id: 'R8',
    title: 'CLAUDE.md/AGENTS.md present, ≤ 200 lines, links to the KB index',
    detection: 'file inspection',
    unlocks: 'Context pack quality; lower token cost',
    detectedBy: 'agent',
  },
  {
    id: 'R9',
    title: 'Protected default branch, MR required, bot cannot self-approve',
    detection: 'git provider API',
    unlocks: 'Human merge guarantee (BD-007)',
    detectedBy: 'platform',
  },
  {
    id: 'R10',
    title: 'MR template and commit convention documented',
    detection: 'files/KB',
    unlocks: 'MR hygiene checks are objective',
    detectedBy: 'agent',
  },
  {
    id: 'R11',
    title: 'Observability bindings present (Sentry project, Loki labels)',
    detection: 'integration bindings',
    unlocks: 'Investigation stage has evidence for bugs',
    detectedBy: 'platform',
  },
  {
    id: 'R12',
    title: 'Knowledge completeness ≥ 70%',
    detection: 'KB score',
    unlocks: 'Refinement drift detection, fewer questions',
    detectedBy: 'platform',
  },
  {
    id: 'R13',
    title: 'Secret scanning in CI or pre-commit',
    detection: 'config',
    unlocks: 'Lower risk from agent commits',
    detectedBy: 'agent',
  },
  {
    id: 'R14',
    title: 'Dependency lockfile present and installable offline from allow-listed registries',
    detection: 'workspace build',
    unlocks: 'Deterministic builds inside the network allow-list',
    detectedBy: 'agent',
  },
];

/** Every criterion id, for a caller that wants to enumerate rather than hard-code. */
export const READINESS_CRITERION_IDS: readonly string[] = READINESS_CRITERIA.map(
  (criterion) => criterion.id,
);

export const findReadinessCriterion = (id: string): ReadinessCriterion | undefined =>
  READINESS_CRITERIA.find((criterion) => criterion.id === id);

/**
 * product/17 § "Levels", as the **incremental** requirement of each rung.
 *
 * Level 0 has no entry: it is "did not reach level 1", which is what the document's *"Requires:
 * none of R1, R3"* means read against the rung above it. A level is reached only when every rung
 * below it is, so {@link readinessLevelFor} walks upwards and stops at the first rung that fails —
 * a repository with R1, R3 and all of level 3's criteria but none of level 2's is **level 1**,
 * which is the conservative reading and the one the ladder's prose implies.
 */
export const READINESS_LEVEL_REQUIREMENTS: readonly (readonly string[])[] = [
  /** 1 — Basic */ ['R1', 'R3'],
  /** 2 — Reliable */ ['R2', 'R4', 'R5', 'R9'],
  /** 3 — Agent-ready */ ['R6', 'R8', 'R10', 'R12'],
  /** 4 — Autonomous-capable */ ['R7', 'R11', 'R13', 'R14'],
];

/** The highest readiness level the passing set supports (product/17 § "Levels"). */
export const readinessLevelFor = (passed: ReadonlySet<string>): number => {
  let level = 0;
  for (const requirement of READINESS_LEVEL_REQUIREMENTS) {
    if (!requirement.every((id) => passed.has(id))) {
      return level;
    }
    level += 1;
  }
  return level;
};

/**
 * The cheapest improvements, in the order the wizard shows them (product/17 § "Where it shows up":
 * *"the initial level and the three cheapest criteria to improve next"*).
 *
 * "Cheapest" is read as *nearest*: the failing criteria of the next rung, in the table's order,
 * because those are the ones that actually move the level. Criteria from higher rungs are appended
 * afterwards so the list is still three long on a repository whose next rung is nearly complete.
 */
export const nextReadinessImprovements = (
  passed: ReadonlySet<string>,
  count = 3,
): readonly ReadinessCriterion[] => {
  const missing: ReadinessCriterion[] = [];
  for (const requirement of READINESS_LEVEL_REQUIREMENTS) {
    for (const id of requirement) {
      const criterion = findReadinessCriterion(id);
      if (!passed.has(id) && criterion !== undefined) {
        missing.push(criterion);
      }
    }
  }
  return missing.slice(0, count);
};

// ── Knowledge completeness (R12, and product/06 § "Completeness score") ──────

/**
 * product/06's completeness sections, and the vault path each one lives at.
 *
 * > "business overview, personas, business rules, glossary, direction, quality bar, technical
 * > overview, how-to-run (verified), conventions, review expectations"
 *
 * **Four of the ten paths are named by the documents and six are this work package's mapping**
 * (4 + 6 = 10; the same two numbers appear in Q68's heading and body),
 * which is **Q68** rather than something to infer from the table: product/06 § "Step 2" names
 * `technical/overview.md`, `technical/how-to-run.md` and `technical/conventions.md`, and
 * product/05 § "Drift" names `business/direction.md`. The rest follow product/05's layer table,
 * which puts every business section under `.agentic/knowledge/business/`. Q68 also records the
 * larger half: product/06 says a section may be *"explicitly marked 'not applicable'"* and nothing
 * in this build can mark one, so a project with no personas can never reach 100 %.
 *
 * The paths are **vault-relative** — the knowledge directory is a project setting, so joining it is
 * the caller's job (the same rule `LibrarianProposals.target_path` follows).
 */
export const KNOWLEDGE_COMPLETENESS_SECTIONS: readonly {
  readonly id: Slug;
  readonly path: string;
  readonly unlocks: string;
}[] = [
  { id: 'business_overview', path: 'business/overview.md', unlocks: 'what the product is and why' },
  { id: 'personas', path: 'business/personas.md', unlocks: 'who the change is for' },
  { id: 'business_rules', path: 'business/rules.md', unlocks: 'the invariants a change must keep' },
  { id: 'glossary', path: 'business/glossary.md', unlocks: 'words that mean something here' },
  {
    id: 'direction',
    path: 'business/direction.md',
    unlocks: 'drift detection in Refinement (product/05)',
  },
  { id: 'quality_bar', path: 'business/quality-bar.md', unlocks: 'the definition of done' },
  {
    id: 'review_expectations',
    path: 'business/review-expectations.md',
    unlocks: 'what a reviewer cares about',
  },
  {
    id: 'technical_overview',
    path: 'technical/overview.md',
    unlocks: 'boundaries and ownership, not a file listing',
  },
  { id: 'how_to_run', path: 'technical/how-to-run.md', unlocks: 'build, test and lint commands' },
  {
    id: 'conventions',
    path: 'technical/conventions.md',
    unlocks: 'the conventions a change must follow',
  },
];

/** product/17 R12's threshold, as a fraction of {@link KNOWLEDGE_COMPLETENESS_SECTIONS}. */
export const KNOWLEDGE_COMPLETENESS_THRESHOLD = 0.7;

/**
 * How much of product/06's completeness score the indexed vault covers, in `[0, 1]`.
 *
 * The paths are compared **vault-relative and case-sensitively**, which is what the index stores
 * (`kb_documents.path` is the repository path and the vault-relative one is derived from it). A
 * section is present when a document exists at its path; nothing here reads the document, because
 * "the page exists" is the only claim a path can support and a length threshold would be a quality
 * judgement product/17 § "What it is not" refuses to make.
 */
export const knowledgeCompleteness = (vaultRelativePaths: Iterable<string>): number => {
  const present = new Set(vaultRelativePaths);
  const filled = KNOWLEDGE_COMPLETENESS_SECTIONS.filter((section) =>
    present.has(section.path),
  ).length;
  return filled / KNOWLEDGE_COMPLETENESS_SECTIONS.length;
};

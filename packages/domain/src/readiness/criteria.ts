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
 * ## R1, R2 and R6 are detected by running the project's commands, as product/17 words them
 *
 * product/17 detects R1 and R6 "executed in the workspace" and R2 "measured". From WP-21 to WP-54
 * no run could execute a project command at all — the shipped command baseline named none and a
 * project may only narrow it — so the three were read off the CI configuration and each said so at
 * its own `detection` line. WP-54 implemented Q69 (ii): the discovery role runs on the
 * `verification` baseline, which carries the project's declared commands (`PROJECT_COMMAND_ALLOW`)
 * and the lockfile installs they need, so the three are detected the way product/17 words them.
 *
 * **A project that verifies on CI is the exception** (`verification.mode: ci`, BD-025's 2026-10-05
 * amendment): its discovery run may not run the suite, the installs or the setup script, so the
 * three are read from the CI configuration and the documentation — `detectionOnCi` on each row says
 * how, and the readiness record prefixes the model's evidence with that platform sentence.
 *
 * **One residual, stated at R6**: a devcontainer or a compose file cannot be *executed* by a run —
 * `docker *` is blocked for every stage (product/19 §3) and the run container has no daemon — so for
 * those two forms of R6 the detection is still a read, and the line says so.
 *
 * ## A criterion nobody answered is `false`
 *
 * Readiness only ever makes the platform *more* conservative (product/17 § "What it is not": it is
 * not a gate, except level 0 restricting to chore/spike, which a maintainer can override). So an
 * unanswered criterion fails: the cost of a false negative is a suggestion that is stricter than
 * necessary, and the cost of a false positive is autonomy the repository cannot support.
 *
 * ## A criterion the workspace could not run is *not checked* (BD-026's 2026-10-06 amendment)
 *
 * The rule above assumed a criterion fails for a reason about the repository. R1, R2 and R6 — the
 * ones discovery answers by **running** a command ({@link ReadinessCriterion.runInWorkspace}) — can
 * also fail for a reason about the **platform**: the run image has no interpreter for the project's
 * language, or the command policy refused the command or its install. Autix, a PHP project whose CI
 * runs its suite on every merge request, was recorded at level 0 for exactly that (first local test,
 * 2026-10-05). So those three, in a project that verifies locally ({@link mayBeNotChecked}), may be
 * recorded *not checked*: **not a pass and not a fail** — the ladder lets it through its rung
 * ({@link readinessLevelFor}), the improvements list leaves it out ({@link nextReadinessImprovements}),
 * and the evaluation suggests `verification.mode: ci` when there is a CI configuration to read
 * ({@link verificationModeSuggestion}). Every rung also holds a criterion that is read, never run, so
 * no level rests on unchecked criteria alone — asserted in `criteria.test.ts`.
 */
import type { Slug, VerificationMode } from '@platform/contracts';
import { type ReadinessNotice, VERIFICATION_MODE_SUGGESTION_CODE } from './ci-rules.js';

/** Who can answer a criterion — see the module docblock. */
export type ReadinessDetector = 'agent' | 'platform';

/**
 * How the **re-check after a merge** answers a criterion (WP-64, PROGRESS backlog 46) — the split
 * product/17 implies with *"re-checked after every merged task (cheap: mostly file and CI-event
 * inspection)"*, stated per row so nobody re-derives it.
 *
 *  - `platform` — the same answer discovery takes: R9 from the git provider, R11 from the bindings,
 *    R12 from the index. Re-asked on every re-check.
 *  - `tree` — a **file inspection at the merged commit**, through the platform's own mirror and no
 *    checkout (`RepositoryFileSource`, the widened vault read). Decided in both directions: the
 *    file answers pass *and* fail, because a file read is complete evidence for the criterion.
 *  - `tree_pass` — a file inspection at the merged commit through the same reader, **pass-only**
 *    (WP-94, PROGRESS backlog 231): R10 and R13 are read from exact named paths, and a file found
 *    there is the criterion's evidence while a miss is not evidence of absence (a template under
 *    another name, a scanner in a workflow file the reader does not name), so a miss carries the
 *    previous answer. The paths are `READINESS_TREE_PATHS` in `./recheck.ts`.
 *  - `ci_events` — the provider's pipeline events the platform already stored. **Pass-only**: an
 *    observed event is the criterion's own wording (*"pipeline events observed for MRs"*), while the
 *    absence of one in the window is not evidence of absence (a project with no merge request in the
 *    window has observed nothing), so a miss carries the previous answer rather than failing it.
 *  - `carried` — needs a run or a judgement no file names. Carried unchanged from the previous
 *    evaluation, **with evidence that says so**, because a discovery run per merged task is exactly
 *    what product/17's *"cheap"* refuses.
 *
 * So the honest count is **seven of fourteen** re-answered after a merge (R3, R10 and R13
 * pass-only, R8, R9, R11, R12) and seven carried (R1, R2, R4, R5, R6, R7, R14) — product/17's
 * *"mostly"* is still not true of this build. The seven carried ones are answered again only by a
 * discovery run, which a maintainer can start again since WP-94 (`onboarding/rediscovery.ts`, Q107
 * (a)); R4 stays carried until the platform keeps a flaky-rerun statistic.
 */
export type ReadinessRecheckSource = 'platform' | 'tree' | 'tree_pass' | 'ci_events' | 'carried';

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
  /** How the re-check after a merge answers it — see {@link ReadinessRecheckSource}. */
  readonly recheck: ReadinessRecheckSource;
  /** Platform text: why the re-check answers it that way. Quoted in a carried row's evidence. */
  readonly recheckReason: string;
  /**
   * How the criterion is detected when the project verifies on CI (`verification.mode: ci`, BD-025's
   * 2026-10-05 amendment) — present exactly for the criteria product/17 detects by **running** a
   * command (R1, R2, R6), which a CI-verified project's discovery run may not do. Platform text: it
   * is what the readiness record's evidence is prefixed with, so a reader is told the criterion was
   * read rather than run whatever the model wrote.
   */
  readonly detectionOnCi?: string;
  /**
   * `true` for the criteria discovery answers by **running** a command in the workspace — R1, R2 and
   * R6, product/17's *"executed in the workspace"* and *"measured"*. Exactly those may be recorded
   * *not checked* when the workspace could not run the command ({@link mayBeNotChecked}).
   */
  readonly runInWorkspace?: true;
}

/** product/17 § "What it measures", transcribed. Order is the document's. */
export const READINESS_CRITERIA: readonly ReadinessCriterion[] = [
  {
    id: 'R1',
    title: 'Test suite exists and runs green on default branch',
    // product/17's wording, restored at WP-54 (Q69 (ii)): discovery's `verification` baseline runs
    // the project's declared test command. It read the CI configuration from WP-21 to WP-54.
    detection: 'test command found in how-to-run.md/CI config and executed in the workspace',
    unlocks:
      'Implementation self-check; acceptance evidence; test tamper gate has something to protect',
    detectedBy: 'agent',
    recheck: 'carried',
    recheckReason: 'it needs the test command run in a workspace',
    detectionOnCi:
      'read, not run (verification.mode: ci): a CI job that runs the test suite on merge requests or the default branch',
    runInWorkspace: true,
  },
  {
    id: 'R2',
    title: 'Tests finish in < 15 minutes',
    // product/17 says "measured": the duration of the test command the discovery run executed for
    // R1 (WP-54). A documented duration or a CI timeout was the stand-in until then.
    detection: 'measured: the duration of the test command executed for R1',
    unlocks: 'Fast inner loop; fewer per-run timeouts',
    detectedBy: 'agent',
    recheck: 'carried',
    recheckReason: 'it needs the test command run and timed in a workspace',
    detectionOnCi:
      'read, not measured (verification.mode: ci): a job timeout or a documented duration under 15 minutes',
    runInWorkspace: true,
  },
  {
    id: 'R3',
    title: 'CI runs on merge requests',
    detection: 'pipeline events observed for MRs',
    unlocks: 'Deterministic CI gate; flaky detection',
    detectedBy: 'agent',
    recheck: 'ci_events',
    recheckReason:
      'a pipeline event the platform stored for a merge request is what the criterion names as its evidence',
  },
  {
    id: 'R4',
    title: 'CI is reliable (< 5% flaky reruns in last 30 days)',
    detection: 'gate statistics',
    unlocks: 'Returns caused by infrastructure are not blamed on the agent',
    detectedBy: 'agent',
    recheck: 'carried',
    recheckReason: 'the platform keeps no flaky-rerun statistic yet',
  },
  {
    id: 'R5',
    title: 'Lint and formatter enforced in CI',
    detection: 'config + CI job',
    unlocks: 'Reviewer skips style; fewer nit iterations',
    detectedBy: 'agent',
    recheck: 'carried',
    recheckReason: 'it needs a judgement about which CI job enforces which tool',
  },
  {
    id: 'R6',
    title: 'One-command dev setup (make setup, devcontainer, compose)',
    // product/17 says "executed in the workspace", and since WP-54 a `make` target or a package
    // script is; since WP-64 the platform's own documented `.agentic/workspace/setup` is too
    // (`WORKSPACE_SETUP_ALLOW`, PROGRESS backlog 144). A devcontainer or compose file is **read**:
    // `docker *` is blocked for every stage and a run has no daemon (the module docblock's residual).
    detection:
      'a one-command setup executed in the workspace (make setup, a package script, ./.agentic/workspace/setup); a devcontainer or compose file is read, since a run has no Docker',
    unlocks: 'Reproducible workspaces; app can be booted for business review',
    detectedBy: 'agent',
    recheck: 'carried',
    recheckReason: 'it needs the setup command run in a workspace',
    detectionOnCi:
      'read, not run (verification.mode: ci): one documented setup command, devcontainer or compose file',
    runInWorkspace: true,
  },
  {
    id: 'R7',
    title: 'Type checking or static analysis in CI (where applicable)',
    detection: 'config',
    unlocks: 'Earlier error detection in Implementation',
    detectedBy: 'agent',
    recheck: 'carried',
    recheckReason: 'it needs a judgement about the CI configuration',
  },
  {
    id: 'R8',
    title: 'CLAUDE.md/AGENTS.md present, ≤ 200 lines, links to the KB index',
    detection: 'file inspection',
    unlocks: 'Context pack quality; lower token cost',
    detectedBy: 'agent',
    recheck: 'tree',
    recheckReason: 'CLAUDE.md and AGENTS.md are read at the merged commit',
  },
  {
    id: 'R9',
    title: 'Protected default branch, MR required, bot cannot self-approve',
    detection: 'git provider API',
    unlocks: 'Human merge guarantee (BD-007)',
    detectedBy: 'platform',
    recheck: 'platform',
    recheckReason: 'the git provider is asked again',
  },
  {
    id: 'R10',
    title: 'MR template and commit convention documented',
    detection: 'files/KB',
    unlocks: 'MR hygiene checks are objective',
    detectedBy: 'agent',
    // WP-94 (backlog 231): a template and a commitlint configuration at named paths pass it; a
    // convention documented in prose is invisible to a path, so a miss carries.
    recheck: 'tree_pass',
    recheckReason:
      'no merge request template and commitlint configuration were both found at the paths the platform reads, and a convention documented elsewhere is not visible to a file read',
  },
  {
    id: 'R11',
    title: 'Observability bindings present (Sentry project, Loki labels)',
    detection: 'integration bindings',
    unlocks: 'Investigation stage has evidence for bugs',
    detectedBy: 'platform',
    recheck: 'platform',
    recheckReason: 'the bindings are read again',
  },
  {
    id: 'R12',
    title: 'Knowledge completeness ≥ 70%',
    detection: 'KB score',
    unlocks: 'Refinement drift detection, fewer questions',
    detectedBy: 'platform',
    recheck: 'platform',
    recheckReason: 'the index of the merged commit is scored again',
  },
  {
    id: 'R13',
    title: 'Secret scanning in CI or pre-commit',
    detection: 'config',
    unlocks: 'Lower risk from agent commits',
    detectedBy: 'agent',
    // WP-94 (backlog 231): a hook or CI file naming a scanner passes it; a scanner in a file the
    // platform does not read (a GitHub Actions workflow) is invisible, so a miss carries.
    recheck: 'tree_pass',
    recheckReason:
      'no hook or CI file the platform reads names a secret scanner, and a scanner configured elsewhere is not visible to a file read',
  },
  {
    id: 'R14',
    title: 'Dependency lockfile present and installable offline from allow-listed registries',
    detection: 'workspace build',
    unlocks: 'Deterministic builds inside the network allow-list',
    detectedBy: 'agent',
    recheck: 'carried',
    recheckReason: 'it needs the lockfile install run in a workspace',
  },
];

/** Every criterion id, for a caller that wants to enumerate rather than hard-code. */
export const READINESS_CRITERION_IDS: readonly string[] = READINESS_CRITERIA.map(
  (criterion) => criterion.id,
);

export const findReadinessCriterion = (id: string): ReadinessCriterion | undefined =>
  READINESS_CRITERIA.find((criterion) => criterion.id === id);

/**
 * Whether a criterion may be recorded *not checked* in a run planned with `mode` — BD-026's
 * 2026-10-06 amendment. Only a criterion answered by running a command, and only when the project
 * verifies locally: under `verification.mode: ci` R1, R2 and R6 are **read** from the CI
 * configuration (`detectionOnCi`), and a criterion that is read can always be answered.
 */
export const mayBeNotChecked = (
  criterion: ReadinessCriterion,
  mode: VerificationMode = 'local',
): boolean => criterion.runInWorkspace === true && mode !== 'ci';

/** The empty set, for a caller with no not-checked criteria. */
const NONE: ReadonlySet<string> = new Set();

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

/**
 * The highest readiness level the passing set supports (product/17 § "Levels").
 *
 * A criterion in `notChecked` does not block its rung (BD-026's 2026-10-06 amendment): a rung is
 * reached when each of its criteria passed **or** was not checked. It is still not a pass — the
 * caller shows it as not checked and {@link nextReadinessImprovements} leaves it out.
 */
export const readinessLevelFor = (
  passed: ReadonlySet<string>,
  notChecked: ReadonlySet<string> = NONE,
): number => {
  let level = 0;
  for (const requirement of READINESS_LEVEL_REQUIREMENTS) {
    if (!requirement.every((id) => passed.has(id) || notChecked.has(id))) {
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
 *
 * A criterion in `notChecked` is **not** an improvement: what stopped it is the run workspace, not
 * the repository, and the evaluation's `verification_mode_ci_suggested` note names the fix.
 */
export const nextReadinessImprovements = (
  passed: ReadonlySet<string>,
  count = 3,
  notChecked: ReadonlySet<string> = NONE,
): readonly ReadinessCriterion[] => {
  const missing: ReadinessCriterion[] = [];
  for (const requirement of READINESS_LEVEL_REQUIREMENTS) {
    for (const id of requirement) {
      const criterion = findReadinessCriterion(id);
      if (!passed.has(id) && !notChecked.has(id) && criterion !== undefined) {
        missing.push(criterion);
      }
    }
  }
  return missing.slice(0, count);
};

/**
 * The `verification_mode_ci_suggested` note (BD-026's 2026-10-06 amendment, product/17): some
 * criteria were not checked because the run workspace could not run them, and the project has a CI
 * configuration — R3 passed, or the platform read its CI file — from which `verification.mode: ci`
 * would have discovery read them instead. `null` when nothing was not checked or there is no CI to
 * read. Platform text only: the ids are `READINESS_CRITERIA`'s own.
 */
export const verificationModeSuggestion = (input: {
  readonly notChecked: readonly string[];
  readonly ciConfigured: boolean;
}): ReadinessNotice | null => {
  const ids = READINESS_CRITERION_IDS.filter((id) => input.notChecked.includes(id));
  if (ids.length === 0 || !input.ciConfigured) return null;
  const list =
    ids.length === 1 ? ids[0] : `${ids.slice(0, -1).join(', ')} and ${ids[ids.length - 1]}`;
  return {
    code: VERIFICATION_MODE_SUGGESTION_CODE,
    severity: 'note',
    message: `${list} could not be checked: the run workspace could not run ${ids.length === 1 ? 'it' : 'them'} (each criterion's evidence says why), so ${ids.length === 1 ? 'it neither passes nor holds' : 'they neither pass nor hold'} the level down. This project has a CI configuration: with verification.mode: ci, discovery reads ${ids.length === 1 ? 'it' : 'them'} from the CI configuration instead of running ${ids.length === 1 ? 'it' : 'them'}. Set it in the project settings, then re-evaluate readiness.`,
  };
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

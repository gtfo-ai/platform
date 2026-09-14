/**
 * product/19 §14 / BD-030 — *"MRs labelled with risk classes from touched paths (auth, payments,
 * migrations, infra) that can force plan approval, a named reviewer or a stricter review
 * checklist"*.
 *
 * `policies.risk_classes` has been in the configuration schema since WP-01 and nothing read it; this
 * was its first reader (WP-30), for the one requirement the pipeline had a gate for —
 * `plan_approval`, through `planApprovalGate`.
 *
 * **Since WP-37 every requirement `riskRequirementSchema` accepts has a consumer, and the ones that
 * do not are refused rather than parsed** (PROGRESS backlog 73 (d)). The sentence that stood here
 * — *"`reviewer:@handle` and `checklist:<name>` are parsed by `riskRequirementSchema` and have no
 * consumer"* — was **wrong about the second half when it was written**: `checklist:<name>` was not
 * parsed, it was refused by a strict union that had no branch for it, so product/19 §14's two
 * checklist rows could not be written in a configuration file at all. Both halves are now closed
 * from the other end: `reviewer:@handle` is read by {@link reviewersRequiredByClasses} and assigned
 * by the `risk_route` duty, and `checklist:` (with `budget_approval`) is refused **by name**, with
 * the reason, at the schema. See `riskRequirementSchema`'s docblock for which consumer each one has.
 *
 * ## Which paths, and the residual that comes with them
 *
 * The paths are **whatever the caller has**, and the two callers have different ones on purpose.
 *
 * The **plan-approval gate** reads the Implementation Plan's `files_to_change[].path` — the first
 * moment the platform knows what a task will touch, and the moment plan approval is decided, so the
 * class is available exactly when it is needed. A plan is written by a model, so a model that
 * **omits** a path escapes the class and the task is *not* gated — never the reverse, because
 * classes only ever add approvals.
 *
 * The **`risk_route` duty** reads the merge request's own changed files at the rebase gate, which is
 * the authoritative source product/19 §14 names, and writes the result to `tasks.risk_classes`
 * (WP-37). That closes the residual this docblock used to leave open — *"a path the implementation
 * touches and the plan did not name"* — for the **label** and for **reviewer routing**, and not for
 * the plan approval, which has already been decided by then. So the two readings disagree exactly
 * when a model under-declared its plan, and the task page shows the honest one.
 *
 * Nothing here is case-folded, for {@link pathMatchesPattern}'s stated reason: a missed match costs
 * an approval that is not asked for, never a write that should not happen.
 */
import type { RiskClass } from '@platform/contracts';
import { pathMatchesPattern } from './path-patterns.js';

/** Which of a project's declared risk classes the given paths fall into, in declaration order. */
export const riskClassesForPaths = (
  classes: Readonly<Record<string, RiskClass>> | undefined,
  paths: readonly string[],
): readonly string[] => {
  if (classes === undefined) {
    return [];
  }
  return Object.entries(classes)
    .filter(([, declared]) =>
      declared.paths.some((pattern) => paths.some((path) => pathMatchesPattern(pattern, path))),
    )
    .map(([name]) => name);
};

/**
 * The subset of {@link riskClassesForPaths} whose `require` list asks for a plan approval.
 *
 * Separate from the match itself because a class can match and require something else entirely —
 * a named reviewer — and a function that returned *"the classes that matched"* would read as if
 * every match were a gate.
 */
export const riskClassesRequiringPlanApproval = (
  classes: Readonly<Record<string, RiskClass>> | undefined,
  paths: readonly string[],
): readonly string[] =>
  riskClassesForPaths(classes, paths).filter((name) =>
    (classes?.[name]?.require ?? []).includes('plan_approval'),
  );

/**
 * The handles the matched classes require — product/19 §14's *"risk classes add required reviewers
 * rather than replace"* (WP-37).
 *
 * Takes **class names** rather than paths, because its caller has already matched them and stored
 * them on the task: computing the match twice would let the label and the routing disagree.
 * `reviewer:@security` yields `@security`; the prefix is stripped and nothing else is — resolving a
 * handle to a provider account is I/O and belongs to the duty (`reviewer-routing.ts` says why).
 */
export const reviewersRequiredByClasses = (
  classes: Readonly<Record<string, RiskClass>> | undefined,
  names: readonly string[],
): readonly string[] => {
  const handles: string[] = [];
  for (const name of names) {
    for (const requirement of classes?.[name]?.require ?? []) {
      if (!requirement.startsWith('reviewer:')) {
        continue;
      }
      const handle = requirement.slice('reviewer:'.length);
      if (handle !== '' && !handles.includes(handle)) {
        handles.push(handle);
      }
    }
  }
  return handles;
};

/**
 * product/19 §14's table, as a **proposal an operator accepts** — never as a shipped default
 * (WP-37, criterion 1).
 *
 * product/18:52 makes this a wizard step: *"Risk classes proposed from the repository structure"*.
 * So `PLATFORM_DEFAULT_CONFIG.policies` still has **no `risk_classes` key** and a project's classes
 * stay empty until somebody accepts through `PUT /api/projects/:id/config`, which records the
 * `human_actions` row. Putting these in the defaults instead would gate every existing project's
 * migrations on the next deploy, with nobody having chosen it — the one direction this feature must
 * not fail in. `effective-config.test.ts` asserts the absence; `record.ts` and the settings screen
 * are the acceptance path.
 *
 * The paths are the document's own, transcribed. The `require` lists are the document's *"default
 * policy"* column, minus what this build refuses:
 *
 *  - **auth** — *"plan approval + named reviewer group `security` if defined"*. Both, and *"if
 *    defined"* is honoured by the routing rather than by the proposal: a `@security` that resolves
 *    to no provider account is reported by name and assigned to nobody.
 *  - **payments** — *"plan approval + stricter checklist"*: the plan approval only. The checklist
 *    half is {@link RISK_CLASS_REQUIREMENTS_AWAITING_CHECKLIST}.
 *  - **data**, **infra**, **agent-config** — as written. `infra`'s *"reviewer from CODEOWNERS"* is
 *    what the routing does for every class, so it adds no `reviewer:` entry of its own;
 *    `agent-config`'s *"flagged in review (BD-025)"* is the label itself, which is now a stored
 *    column and a rendered field.
 */
export const PROPOSED_RISK_CLASSES: Readonly<Record<string, RiskClass>> = {
  auth: {
    paths: ['**/auth/**', '**/login/**', '**/session*/**', '**/token*/**', '**/oauth/**'],
    require: ['plan_approval', 'reviewer:@security'],
  },
  payments: {
    paths: ['**/payment*/**', '**/billing/**', '**/invoice*/**', '**/checkout/**'],
    require: ['plan_approval'],
  },
  data: { paths: ['**/migrations/**', '**/schema*', '**/*.sql'], require: ['plan_approval'] },
  infra: {
    paths: [
      'Dockerfile*',
      '**/helm/**',
      '**/terraform/**',
      '.gitlab-ci.yml',
      '.github/**',
      '**/k8s/**',
    ],
    require: ['plan_approval'],
  },
  agent_config: {
    paths: ['.agentic/**', '.claude/**', 'CLAUDE.md', 'AGENTS.md', '.mcp.json'],
    require: ['plan_approval'],
  },
};

/**
 * The row of product/19 §14 this build cannot propose, and the exact reason — data rather than
 * prose, because the screen renders it and a sentence in a docblock is not something an operator
 * reads (standing rule 18: the absent case must not be the quiet one).
 *
 * `public-api` is the one class whose *only* documented requirement is *"stricter checklist
 * (compatibility)"*, and `riskRequirementSchema` refuses `checklist:<name>` until Q83 is answered —
 * so proposing it would mean either inventing a requirement the document does not ask for or
 * writing a class that requires nothing. Its paths are kept here so that answering Q83 is an edit
 * of one table rather than a re-transcription.
 */
export const RISK_CLASS_REQUIREMENTS_AWAITING_CHECKLIST: readonly {
  readonly name: string;
  readonly paths: readonly string[];
  readonly reason: string;
}[] = [
  {
    name: 'public_api',
    paths: ['**/api/**', '**/openapi*', '**/graphql/**'],
    reason:
      'product/19 §14 asks for a "stricter checklist (compatibility)" and nothing in the product defines what a review checklist is (Q83), so this class would have no requirement this build can act on',
  },
];

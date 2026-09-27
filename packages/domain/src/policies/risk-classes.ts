/**
 * product/19 §14 / BD-030 — *"MRs labelled with risk classes from touched paths (auth, payments,
 * migrations, infra) that can force plan approval, a named reviewer or a stricter review
 * checklist"*.
 *
 * `policies.risk_classes` has been in the configuration schema since WP-01 and nothing read it; this
 * was its first reader (WP-30), for the one requirement the pipeline had a gate for —
 * `plan_approval`, through `planApprovalGate`.
 *
 * **Since WP-37 every requirement `riskRequirementSchema` accepts has a consumer, and the one that
 * does not is refused rather than parsed** (PROGRESS backlog 73 (d)). The sentence that stood here
 * — *"`reviewer:@handle` and `checklist:<name>` are parsed by `riskRequirementSchema` and have no
 * consumer"* — was **wrong about the second half when it was written**: `checklist:<name>` was not
 * parsed, it was refused by a strict union that had no branch for it. `reviewer:@handle` is read by
 * {@link reviewersRequiredByClasses} and assigned by the `risk_route` duty; since **WP-45** (Q83)
 * `checklist:<name>` is accepted when the document defines the list, read by
 * {@link reviewChecklistsFor} and handed to the Reviewer as a data block; `budget_approval` is still
 * refused **by name**, with the reason, at the schema. See `riskRequirementSchema`'s docblock for
 * which consumer each one has.
 *
 * ## Which paths, and the residual that comes with them
 *
 * The paths are **whatever the caller has**, and the two callers have different ones on purpose.
 *
 * The **Reviewer's checklists** (WP-45) read what the review can see: the merge request's own
 * files for a review of a human merge request (`tasks.review_subject`), and otherwise the
 * Implementation Plan's paths, the task's own merge request's changed files (read by the
 * `stage.execute` job before the run since WP-73, PROGRESS backlog 218) and whatever
 * `tasks.risk_classes` already holds — the rebase gate runs *after* code review, so on a first
 * review that column is empty. Only a review whose merge-request read failed is left with the plan
 * alone and the plan-approval gate's residual below. The planner states which source it used.
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
import { checklistNameOf } from '@platform/contracts';
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

/** One checklist the Reviewer is given, and the classes that selected it. */
export interface AppliedReviewChecklist {
  /** The key under `policies.review_checklists` — project-chosen, a slug. */
  readonly name: string;
  /** The project's items, verbatim. Project text: it reaches a prompt only inside a data block. */
  readonly items: readonly string[];
  /** The matched classes whose `require` named it, in declaration order. */
  readonly requiredBy: readonly string[];
}

/**
 * The checklists the matched classes select — product/19 §14's *"stricter checklist"*, as Q83
 * recommends it (WP-45).
 *
 * Takes **class names** for {@link reviewersRequiredByClasses}'s reason. Each list is returned
 * once, however many classes select it, with every selecting class in `requiredBy` — so
 * *"stricter"* is observable as *"the Reviewer was given these N items because of these
 * classes"*, which is what the Review Verdict records.
 *
 * `missing` is a `checklist:<name>` whose list the configuration does not define. The schema
 * refuses that document at the write and at the read (`policiesConfigSchema`), so on a document
 * that went through either it is empty; it is **returned rather than dropped** because the
 * pipeline reads `projects.config` by cast, and a requirement that vanished without a word is the
 * failure this row exists to prevent.
 */
export const reviewChecklistsFor = (
  classes: Readonly<Record<string, RiskClass>> | undefined,
  checklists: Readonly<Record<string, readonly string[]>> | undefined,
  names: readonly string[],
): { readonly applied: readonly AppliedReviewChecklist[]; readonly missing: readonly string[] } => {
  const applied = new Map<string, { items: readonly string[]; requiredBy: string[] }>();
  const missing: string[] = [];
  for (const name of names) {
    for (const requirement of classes?.[name]?.require ?? []) {
      const checklist = checklistNameOf(requirement);
      if (checklist === null) {
        continue;
      }
      const items = Object.hasOwn(checklists ?? {}, checklist)
        ? (checklists as Readonly<Record<string, readonly string[]>>)[checklist]
        : undefined;
      if (items === undefined || items.length === 0) {
        if (!missing.includes(checklist)) {
          missing.push(checklist);
        }
        continue;
      }
      const entry = applied.get(checklist) ?? { items, requiredBy: [] };
      if (!entry.requiredBy.includes(name)) {
        entry.requiredBy.push(name);
      }
      applied.set(checklist, entry);
    }
  }
  return {
    applied: [...applied.entries()].map(([name, entry]) => ({
      name,
      items: [...entry.items],
      requiredBy: [...entry.requiredBy],
    })),
    missing,
  };
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
 * policy"* column, **all six rows and every requirement in them** since WP-45:
 *
 *  - **auth** — *"plan approval + named reviewer group `security` if defined"*. Both, and *"if
 *    defined"* is honoured by the routing rather than by the proposal: a `@security` that resolves
 *    to no provider account is reported by name and assigned to nobody.
 *  - **payments** — *"plan approval + stricter checklist"*: both, the second as
 *    `checklist:payments`. Until WP-45 it was the plan approval only, and the dropped half was
 *    written in this docblock and nowhere an operator reads (PROGRESS backlog 91).
 *  - **data**, **infra**, **agent-config** — as written. `infra`'s *"reviewer from CODEOWNERS"* is
 *    what the routing does for every class, so it adds no `reviewer:` entry of its own;
 *    `agent-config`'s *"flagged in review (BD-025)"* is the label itself, which is now a stored
 *    column and a rendered field.
 *  - **public-api** — *"stricter checklist (compatibility)"*, as `checklist:public_api`. It was not
 *    proposed at all before WP-45, because its only requirement could not be written.
 *
 * **The two checklists are named and not filled.** The platform ships no checklist items (Q83's
 * recommendation: a list a project never saw would silently change what its reviews say), so a
 * `checklist:` requirement here is a list the operator writes when they accept — which is why the
 * proposal publishes {@link PROPOSED_REVIEW_CHECKLISTS} beside the classes, and why accepting a
 * class whose list is not written is refused at the configuration document rather than accepted
 * and ignored.
 */
export const PROPOSED_RISK_CLASSES: Readonly<Record<string, RiskClass>> = {
  auth: {
    paths: ['**/auth/**', '**/login/**', '**/session*/**', '**/token*/**', '**/oauth/**'],
    require: ['plan_approval', 'reviewer:@security'],
  },
  payments: {
    paths: ['**/payment*/**', '**/billing/**', '**/invoice*/**', '**/checkout/**'],
    require: ['plan_approval', 'checklist:payments'],
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
  public_api: {
    paths: ['**/api/**', '**/openapi*', '**/graphql/**'],
    require: ['checklist:public_api'],
  },
};

/**
 * The checklists {@link PROPOSED_RISK_CLASSES} select, each with **what product/19 §14 says it is
 * for** — and no items (WP-45).
 *
 * The purpose is the document's own words, quoted, because it is the only thing the platform
 * knows about these lists: *"stricter"* for payments and *"(compatibility)"* for the public API.
 * The items are the operator's to write (Q83: the platform ships no default checklist), and the
 * proposal publishes this table so the screen can ask for them by name rather than offering a class
 * whose acceptance the configuration schema would refuse.
 */
export const PROPOSED_REVIEW_CHECKLISTS: Readonly<Record<string, { readonly purpose: string }>> = {
  payments: {
    purpose:
      'product/19 §14 asks for a "stricter checklist" on payments; the platform ships no items (Q83), so the list is yours to write',
  },
  public_api: {
    purpose:
      'product/19 §14 asks for a "stricter checklist (compatibility)" on the public API; the platform ships no items (Q83), so the list is yours to write',
  },
};

/**
 * What a repository's `.agentic/config.yml` may change — WP-63 review round 1, the orchestrator's
 * interim ruling: **the repository file may tighten, never loosen, what an agent or a reviewer is
 * held to.**
 *
 * The reason is who can write each layer. The settings layer needs `project.settings.write`
 * (admin); the file needs only merge rights on the git host — and it is read against the same
 * strict schema. So every key the file can state is graded here, once, and the grade is what is
 * applied:
 *
 *  - **tighten-only** — merged so the result is never weaker than the settings (or the platform
 *    default when the settings are silent): `policies.protected_paths` and `policies.reviewers` are
 *    **unions**, `policies.risk_classes` adds classes and adds paths and requirements to a class the
 *    settings define, `policies.review_checklists` adds items, and `commands` narrow again after the
 *    settings (`runCommandPolicy`'s layers). Whatever the file tried to remove is **reported**.
 *  - **not applied** — dropped and **reported** in the reading's `not_applied`: the dial and every
 *    key that overrides one of its policies (`AUTONOMY_POLICY_OVERRIDE_KEYS`, Q78 — a test holds the
 *    two lists together), the other policies whose loosening turns a check off (the dependency
 *    policy, the coverage source, drift handling), per-template stage and plan-approval overrides,
 *    the per-stage prompt files (no reader on this build), every `features` switch (each turns on
 *    agent work, sets a spending cap or publishes a per-person read — all `project.settings.write`
 *    decisions), and `project.default_branch` (the branch configuration is trusted from is
 *    `projects.default_branch`, never a key in a file on it — BD-025 §1).
 *  - **operational** — the project's own, applied as written, because none of them widens what an
 *    agent may *do*: the stage `model`, `effort`, `max_turns` and `budget_usd` (every run is still
 *    admitted against the task cap — `taskBudgetExhausted`, which a stage budget above it parks
 *    rather than spends — and the organisation and project budgets, `BudgetGuard`; neither is a
 *    file key), the iteration limits other than the dial's two (a return is still a return a
 *    reviewer made, and every round is budgeted), the knowledge directory and the context budget
 *    (what a prompt carries is data blocks either way), the language and commit convention, and
 *    `status_mapping` (ticket status names).
 */

import {
  MAX_REVIEW_CHECKLIST_ITEMS,
  MAX_REVIEW_CHECKLISTS,
  MAX_ROUTED_REVIEWERS,
} from '@platform/contracts';
import type { ConfigValues } from '@platform/domain';
import { AUTONOMY_POLICY_OVERRIDE_KEYS, PLATFORM_DEFAULT_CONFIG } from '@platform/domain';
import type { RepositoryConfigNotApplied } from './repository-config.js';

export type RepositoryKeyGrade = 'tighten_only' | 'not_applied' | 'operational';

/**
 * Every key the file can state, graded. `*` stands for a stage id. `repository-grades.test.ts`
 * holds this table to the schema in both directions, so a key added to `agenticConfigSchema`
 * without a grade fails the build rather than reaching the repository layer ungraded.
 */
export const REPOSITORY_KEY_GRADES: Readonly<Record<string, RepositoryKeyGrade>> = {
  'project.knowledge_dir': 'operational',
  'project.context_budget_tokens': 'operational',
  'project.communication_language': 'operational',
  'project.commit_convention': 'operational',
  'project.default_branch': 'not_applied',
  'pipeline.template_overrides': 'not_applied',
  'pipeline.custom_stages': 'not_applied',
  'pipeline.limits.code_review_iterations': 'operational',
  'pipeline.limits.business_review_iterations': 'operational',
  'pipeline.limits.ci_fix_iterations': 'operational',
  'pipeline.limits.human_rounds': 'not_applied',
  'pipeline.limits.rebase_attempts': 'operational',
  'pipeline.limits.rebase_rechecks': 'operational',
  'pipeline.limits.question_timeout': 'not_applied',
  'stages.*.model': 'operational',
  'stages.*.effort': 'operational',
  'stages.*.max_turns': 'operational',
  'stages.*.budget_usd': 'operational',
  'stages.*.prompt': 'not_applied',
  'stages.*.prompt_append': 'not_applied',
  'policies.autonomy': 'not_applied',
  'policies.probation_tasks': 'not_applied',
  'policies.knowledge_apply': 'not_applied',
  'policies.dependency_policy': 'not_applied',
  'policies.coverage_source': 'not_applied',
  'policies.drift_without_direction': 'not_applied',
  'policies.protected_paths': 'tighten_only',
  'policies.risk_classes': 'tighten_only',
  'policies.review_checklists': 'tighten_only',
  'policies.reviewers': 'tighten_only',
  commands: 'tighten_only',
  features: 'not_applied',
  status_mapping: 'operational',
};

/** Why each not-applied key is not applied. Platform text, published in `not_applied`. */
const NOT_APPLIED_REASONS: Readonly<Record<string, string>> = {
  'policies.autonomy':
    'the autonomy dial is moved in the platform (PUT /api/projects/:project_id/autonomy): a position is materialised when a human selects it (BD-027:14), so a repository file cannot move it',
  'project.default_branch':
    'the branch configuration is trusted from is the project’s default branch as the platform records it (BD-025 §1), never a key in a file on that branch',
  features:
    'every feature switch turns on agent work, sets a spending cap or publishes a per-person read, which is a settings decision (project.settings.write); set it on the project settings page',
  'pipeline.template_overrides':
    'per-template stage and plan-approval overrides can take a check away; they are a settings decision',
  'pipeline.custom_stages': 'custom stages are not read on this build',
  'stages.*.prompt': 'per-stage prompt files are not read on this build',
  'stages.*.prompt_append': 'per-stage prompt files are not read on this build',
};

/** Why `policies.autonomy` in a repository file is not applied. */
export const REPOSITORY_AUTONOMY_NOT_APPLIED = NOT_APPLIED_REASONS['policies.autonomy'] as string;

const AUTONOMY_OVERRIDE_REASON =
  'it overrides a policy of the autonomy dial (Q78), which a repository file may not loosen; set it on the project settings page';
const LOOSENING_REASON =
  'a repository file may tighten what an agent or a reviewer is held to, never loosen it; set it on the project settings page';

/** The dotted paths of the dial's override keys, from the one table that names them. */
export const AUTONOMY_OVERRIDE_PATHS: readonly string[] = [
  ...new Set(Object.values(AUTONOMY_POLICY_OVERRIDE_KEYS)),
];

const reasonFor = (path: string): string =>
  NOT_APPLIED_REASONS[path] ??
  (AUTONOMY_OVERRIDE_PATHS.includes(path) ? AUTONOMY_OVERRIDE_REASON : LOOSENING_REASON);

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Removes one dotted path (with `*` for any key) from a copy; answers the concrete paths removed. */
const removePath = (target: Json, segments: readonly string[], prefix: string): string[] => {
  const [head, ...rest] = segments;
  if (head === undefined) return [];
  const keys = head === '*' ? Object.keys(target) : [head];
  const removed: string[] = [];
  for (const key of keys) {
    if (!Object.hasOwn(target, key)) continue;
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (rest.length === 0) {
      delete target[key];
      removed.push(path);
      continue;
    }
    const child = target[key];
    if (isObject(child)) {
      const copy = { ...child };
      removed.push(...removePath(copy, rest, path));
      target[key] = copy;
      if (Object.keys(copy).length === 0) delete target[key];
    }
  }
  return removed;
};

/**
 * The file minus every **not applied** key, and the report of what was dropped — independent of
 * the settings, so it is applied when the file is read and again when a stored reading is read back.
 */
export const withoutNotAppliedKeys = (
  values: ConfigValues,
): {
  readonly values: ConfigValues;
  readonly notApplied: readonly RepositoryConfigNotApplied[];
} => {
  const copy: Json = JSON.parse(JSON.stringify(values)) as Json;
  const notApplied: RepositoryConfigNotApplied[] = [];
  const graded = Object.entries(REPOSITORY_KEY_GRADES)
    .filter(([, grade]) => grade === 'not_applied')
    .map(([path]) => path);
  for (const path of [...new Set([...graded, ...AUTONOMY_OVERRIDE_PATHS])]) {
    for (const removed of removePath(copy, path.split('.'), '')) {
      notApplied.push({ key: removed, reason: reasonFor(path) });
    }
  }
  return { values: copy as ConfigValues, notApplied };
};

const unique = (values: readonly string[]): string[] => [...new Set(values)];

const droppedNote = (key: string, kept: readonly string[]): RepositoryConfigNotApplied => ({
  key,
  reason: `${LOOSENING_REASON}; still in force: ${kept
    .slice(0, 8)
    .map((entry) => JSON.stringify(entry))
    .join(', ')}${kept.length > 8 ? ` and ${kept.length - 8} more` : ''}`,
});

/**
 * The file's **tighten-only** keys merged against the settings, so the deep merge that follows can
 * only ever add. Whatever the file left out that the settings (or the platform default) hold is
 * kept and reported, never silently kept either.
 */
export const tightenRepositoryLayer = (
  project: ConfigValues,
  repo: ConfigValues,
): {
  readonly values: ConfigValues;
  readonly notApplied: readonly RepositoryConfigNotApplied[];
} => {
  const notApplied: RepositoryConfigNotApplied[] = [];
  const policies = repo.policies;
  if (policies === undefined) {
    return { values: repo, notApplied };
  }
  const settings = project.policies ?? {};
  const next: NonNullable<ConfigValues['policies']> = { ...policies };

  if (policies.protected_paths !== undefined) {
    const base =
      settings.protected_paths ?? PLATFORM_DEFAULT_CONFIG.policies?.protected_paths ?? [];
    const kept = base.filter((path) => !policies.protected_paths?.includes(path));
    next.protected_paths = unique([...base, ...policies.protected_paths]);
    if (kept.length > 0) notApplied.push(droppedNote('policies.protected_paths', kept));
  }

  if (policies.reviewers !== undefined) {
    const base = settings.reviewers ?? [];
    const kept = base.filter((reviewer) => !policies.reviewers?.includes(reviewer));
    // The schema bounds the list; the settings' reviewers come first, so a full list loses the
    // file's additions rather than a reviewer an admin chose — and says so.
    const merged = unique([...base, ...policies.reviewers]);
    next.reviewers = merged.slice(0, MAX_ROUTED_REVIEWERS);
    if (kept.length > 0) notApplied.push(droppedNote('policies.reviewers', kept));
    if (merged.length > MAX_ROUTED_REVIEWERS) {
      notApplied.push({
        key: 'policies.reviewers',
        reason: `the list is bounded at ${MAX_ROUTED_REVIEWERS}; the settings' reviewers were kept first and the file's extra ones dropped`,
      });
    }
  }

  if (policies.risk_classes !== undefined) {
    const classes = { ...policies.risk_classes };
    for (const [name, declared] of Object.entries(policies.risk_classes)) {
      const defined = settings.risk_classes?.[name];
      if (defined === undefined) continue;
      const keptPaths = defined.paths.filter((path) => !declared.paths.includes(path));
      const keptRequire = defined.require.filter((entry) => !declared.require.includes(entry));
      classes[name] = {
        paths: unique([...defined.paths, ...declared.paths]),
        require: unique([...defined.require, ...declared.require]) as typeof declared.require,
      };
      if (keptPaths.length + keptRequire.length > 0) {
        notApplied.push(
          droppedNote(`policies.risk_classes.${name}`, [...keptPaths, ...keptRequire]),
        );
      }
    }
    next.risk_classes = classes;
  }

  if (policies.review_checklists !== undefined) {
    const lists: Record<string, string[]> = {};
    // The schema bounds both the lists and their items; the settings' come first, so a bound can
    // only ever cost the file an addition, and it says so.
    let room = MAX_REVIEW_CHECKLISTS - Object.keys(settings.review_checklists ?? {}).length;
    for (const [name, items] of Object.entries(policies.review_checklists)) {
      const defined = settings.review_checklists?.[name];
      if (defined === undefined) {
        if (room <= 0) {
          notApplied.push({
            key: `policies.review_checklists.${name}`,
            reason: `at most ${MAX_REVIEW_CHECKLISTS} checklists; the settings' lists were kept first`,
          });
          continue;
        }
        room -= 1;
        lists[name] = [...items];
        continue;
      }
      const kept = defined.filter((item) => !items.includes(item));
      const merged = unique([...defined, ...items]);
      lists[name] = merged.slice(0, MAX_REVIEW_CHECKLIST_ITEMS);
      if (kept.length > 0) notApplied.push(droppedNote(`policies.review_checklists.${name}`, kept));
      if (merged.length > MAX_REVIEW_CHECKLIST_ITEMS) {
        notApplied.push({
          key: `policies.review_checklists.${name}`,
          reason: `at most ${MAX_REVIEW_CHECKLIST_ITEMS} items; the settings' items were kept first`,
        });
      }
    }
    next.review_checklists = lists;
  }

  return { values: { ...repo, policies: next }, notApplied };
};

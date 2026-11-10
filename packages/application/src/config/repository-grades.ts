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
 *    settings define, `policies.review_checklists` adds items, `commands` narrow again after the
 *    settings (`runCommandPolicy`'s layers), `pipeline.wip` may lower a WIP limit and never
 *    raise it (WP-91), `verification.mode` may move a project to `ci` and never back to `local`
 *    (BD-025's 2026-10-05 amendment: `ci` only removes commands, which the file's own
 *    `commands.block` could already do), and `pipeline.ci.required_manual_jobs` (S-27.2, the
 *    coordinator's ruling on #114) may only require **more**: `all` is applied, a list of names is
 *    a union with the settings' list (or with the settings' `[]`), and `[]` is never applied — the
 *    file is written by the agent whose merge request the CI gate judges, so a file that says `[]`
 *    would let that agent pass its own untested change; `[]` comes only from the project settings.
 *    Over a silent setting (the default, which waits on every unstarted manual test job) a list is
 *    not applied either, because a list replaces that rule rather than adding to it; and
 *    `pipeline.ci.manual_jobs` (S-28.7, the M28 ruling) may only add `wait` — `run` (the platform
 *    starts the job, with the project's permissions) and `ignore` (the job stops being a check) come
 *    only from the project settings, and a settings `run` is not turned into `wait` by the file.
 *    Whatever the file tried to remove or raise is **reported**. `policies.plan_approval_risk` (S-28.8,
 *    the M28 ruling) may only ask more: the file may switch the low-risk rule off but never on, lower
 *    `max_risk` and `max_size`, raise `min_confidence`, and add to `always_ask`
 *    (`tightenPlanApprovalRisk`).
 *  - **not applied** — dropped and **reported** in the reading's `not_applied`: the dial and every
 *    key that overrides one of its policies (`AUTONOMY_POLICY_OVERRIDE_KEYS`, Q78 — a test holds the
 *    two lists together), the other policies whose loosening turns a check off (the dependency
 *    policy, the coverage source, drift handling), per-template stage and plan-approval overrides,
 *    custom stages (no reader on this build), every `features` switch (each turns on
 *    agent work, sets a spending cap or publishes a per-person read — all `project.settings.write`
 *    decisions), `project.default_branch` (the branch configuration is trusted from is
 *    `projects.default_branch`, never a key in a file on it — BD-025 §1), and `human_returns`
 *    (WP-170; since M28 ruling R1 no reader at all — a comment never returns a task, so the
 *    acknowledgement vocabulary it added to is gone).
 *  - **operational** — the project's own, applied as written, because none of them widens what an
 *    agent may *do*: the stage `model`, `effort`, `max_turns` and `budget_usd` (every run is still
 *    admitted against the task cap — `taskBudgetExhausted`, which a stage budget above it parks
 *    rather than spends — and the organisation and project budgets, `BudgetGuard`; neither is a
 *    file key), the iteration limits other than the dial's two (a return is still a return a
 *    reviewer made, and every round is budgeted), the knowledge directory and the context budget
 *    (what a prompt carries is data blocks either way), the language and commit convention,
 *    `status_mapping` (ticket status names), and the per-stage prompt files `stages.*.prompt` and
 *    `prompt_append` (WP-92): a project prompt reaches the model inside a data block, adds to the
 *    role prompt and never replaces it, and grants no tool, command or path — and the file it names
 *    is repository content that merge rights could already write under `.agentic/prompts/` anyway.
 *    A value that names a file outside that directory is dropped and reported
 *    (`projectPromptValueNotApplied`), so it cannot shadow a settings value that resolves.
 */

import {
  MAX_REQUIRED_MANUAL_JOBS,
  MAX_REVIEW_CHECKLIST_ITEMS,
  MAX_REVIEW_CHECKLISTS,
  MAX_ROUTED_REVIEWERS,
} from '@platform/contracts';
import type { ConfigValues } from '@platform/domain';
import {
  AUTONOMY_POLICY_OVERRIDE_KEYS,
  PLATFORM_DEFAULT_CONFIG,
  tightenPlanApprovalRisk,
} from '@platform/domain';
import { projectPromptValueNotApplied } from './project-prompts.js';
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
  'pipeline.limits.ci_timeout_minutes': 'operational',
  'pipeline.limits.question_timeout': 'not_applied',
  'pipeline.wip': 'tighten_only',
  'pipeline.ci': 'tighten_only',
  'stages.*.model': 'operational',
  'stages.*.effort': 'operational',
  'stages.*.max_turns': 'operational',
  'stages.*.budget_usd': 'operational',
  'stages.*.prompt': 'operational',
  'stages.*.prompt_append': 'operational',
  'policies.autonomy': 'not_applied',
  'policies.probation_tasks': 'not_applied',
  'policies.knowledge_apply': 'not_applied',
  'policies.dependency_policy': 'not_applied',
  'policies.coverage_source': 'not_applied',
  'policies.drift_without_direction': 'not_applied',
  'policies.protected_paths': 'tighten_only',
  'policies.plan_approval_risk': 'tighten_only',
  'policies.risk_classes': 'tighten_only',
  'policies.review_checklists': 'tighten_only',
  'policies.reviewers': 'tighten_only',
  commands: 'tighten_only',
  verification: 'tighten_only',
  features: 'not_applied',
  status_mapping: 'operational',
  human_returns: 'not_applied',
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
  human_returns:
    'it is no longer read: since M28 a ticket comment or a merge-request note that cannot be resolved never returns a task, so there is no acknowledgement vocabulary to add words to; a person sends a task back with an open review thread, a return status or the task page’s button',
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
  // S-27.2 (the coordinator's ruling on #114): `required_manual_jobs: []` is never the file's to
  // say, whatever the settings hold, so it is dropped here — where the refresh logs the key — and
  // reported; `tightenRepositoryLayer` then decides the file's other values against the settings.
  const pipeline = copy.pipeline;
  const ci = isObject(pipeline) ? pipeline.ci : undefined;
  const required = isObject(ci) ? ci.required_manual_jobs : undefined;
  if (Array.isArray(required) && required.length === 0) {
    removePath(copy, ['pipeline', 'ci', 'required_manual_jobs'], '');
    notApplied.push({ key: REQUIRED_MANUAL_JOBS_KEY, reason: REQUIRED_NONE_REASON });
  }
  // S-28.7 (the M28 ruling): `manual_jobs` `run` and `ignore` come only from the project settings —
  // playing a job runs CI with the project's permissions, and ignoring one drops a check — so the
  // file keeps its `wait` entries and every other entry is dropped here and reported by name.
  const modes = isObject(ci) ? ci.manual_jobs : undefined;
  if (isObject(modes)) {
    for (const [name, mode] of Object.entries(modes)) {
      if (mode === 'wait') continue;
      delete modes[name];
      notApplied.push({
        key: `${MANUAL_JOBS_KEY}.${name}`,
        reason: mode === 'run' ? MANUAL_RUN_REASON : MANUAL_IGNORE_REASON,
      });
    }
    if (Object.keys(modes).length === 0) {
      removePath(copy, ['pipeline', 'ci', 'manual_jobs'], '');
    }
  }
  // WP-92: a prompt key whose value names no file the platform reads is dropped, not merged — so
  // it cannot shadow a settings value that does — and reported with the reason.
  for (const item of projectPromptValueNotApplied(copy as ConfigValues)) {
    removePath(copy, item.key.split('.'), '');
    notApplied.push(item);
  }
  return { values: copy as ConfigValues, notApplied };
};

const unique = (values: readonly string[]): string[] => [...new Set(values)];

const REQUIRED_MANUAL_JOBS_KEY = 'pipeline.ci.required_manual_jobs';
const MANUAL_JOBS_KEY = 'pipeline.ci.manual_jobs';

/** Why a file's `manual_jobs` `run` is not applied (S-28.7). Platform text. */
const MANUAL_RUN_REASON =
  'only the project settings may tell the platform to start a manual job: starting one runs CI with the project’s permissions, and the repository file is written by the agent whose change the CI gate judges; a repository file may only add wait; set run on the project settings page';
/** Why a file's `manual_jobs` `ignore` is not applied (S-28.7). Platform text. */
const MANUAL_IGNORE_REASON = `${LOOSENING_REASON}; ignore takes a manual job out of the CI gate's checks, and a repository file may only add wait`;

/** Why a file's `required_manual_jobs: []` is not applied (S-27.2). Platform text. */
const REQUIRED_NONE_REASON = `${LOOSENING_REASON}; \`[]\` lets the CI gate pass a pipeline whose manual test jobs nobody started, and the repository file is written by the agent whose merge request the gate judges — only the project settings may say it`;

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
  const wip = tightenWip(project, repo, notApplied);
  const withWipOnly: ConfigValues =
    wip === undefined ? repo : { ...repo, pipeline: { ...repo.pipeline, wip } };
  const withWip = tightenManualJobModes(
    project,
    tightenManualJobs(
      project,
      tightenUnattended(project, tightenVerification(project, withWipOnly, notApplied), notApplied),
      notApplied,
    ),
    notApplied,
  );
  const policies = repo.policies;
  if (policies === undefined) {
    return { values: withWip, notApplied };
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

  if (policies.plan_approval_risk !== undefined) {
    // S-28.8: merged against the settings' rule so the deep merge that follows can only ask more.
    const { value, loosened } = tightenPlanApprovalRisk(
      settings.plan_approval_risk,
      policies.plan_approval_risk,
    );
    next.plan_approval_risk = value;
    for (const key of loosened) {
      notApplied.push({
        key: `policies.plan_approval_risk.${key}`,
        reason: `${LOOSENING_REASON}; a repository file may make the low-risk rule ask more, never let more plans go ahead without a person — the project settings' value is still in force`,
      });
    }
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

  return { values: { ...withWip, policies: next }, notApplied };
};

/**
 * `pipeline.ci.required_manual_jobs` from the file, **only ever requiring more** (S-27.2, the
 * coordinator's ruling on #114). The order the policy reads is `[]` < the default (absent: every
 * unstarted manual test job) < `all`, with a list beside them, and the file may only move up it:
 *
 *  - `all` is applied as written — it requires every manual job;
 *  - `[]` never reaches here (`withoutNotAppliedKeys` dropped and reported it);
 *  - a list over the settings' `[]` or the settings' list is applied as the **union**, so no name
 *    the project settings require is ever removed, and the names the file left out are reported;
 *  - a list over the settings' `all`, or over silent settings — whose default waits on every manual
 *    test job, a rule a list would *replace* rather than add to — is not applied and is reported.
 */
const tightenManualJobs = (
  project: ConfigValues,
  repo: ConfigValues,
  notApplied: RepositoryConfigNotApplied[],
): ConfigValues => {
  const declared = repo.pipeline?.ci?.required_manual_jobs;
  if (declared === undefined || declared === 'all') return repo;
  const settings = project.pipeline?.ci?.required_manual_jobs;
  const withValue = (value: readonly string[] | undefined): ConfigValues => {
    const { required_manual_jobs: _dropped, ...rest } = repo.pipeline?.ci ?? {};
    return {
      ...repo,
      pipeline: {
        ...repo.pipeline,
        ci: value === undefined ? rest : { ...rest, required_manual_jobs: [...value] },
      },
    };
  };
  if (settings === 'all' || settings === undefined) {
    notApplied.push({
      key: REQUIRED_MANUAL_JOBS_KEY,
      reason:
        settings === 'all'
          ? `${LOOSENING_REASON}; the project settings require every manual job (all), which is still in force`
          : `${LOOSENING_REASON}; a list of names replaces the default rule, which waits on every unstarted manual test job — the default is still in force; state all, or set the list on the project settings page`,
    });
    return withValue(undefined);
  }
  const kept = settings.filter((name) => !declared.includes(name));
  if (kept.length > 0) notApplied.push(droppedNote(REQUIRED_MANUAL_JOBS_KEY, kept));
  const merged = unique([...settings, ...declared]);
  if (merged.length > MAX_REQUIRED_MANUAL_JOBS) {
    notApplied.push({
      key: REQUIRED_MANUAL_JOBS_KEY,
      reason: `at most ${MAX_REQUIRED_MANUAL_JOBS} names; the settings' names were kept first and the file's extra ones dropped`,
    });
  }
  return withValue(merged.slice(0, MAX_REQUIRED_MANUAL_JOBS));
};

/**
 * `pipeline.ci.manual_jobs` from the file against the settings (S-28.7). The file holds only `wait`
 * entries by now (`withoutNotAppliedKeys`); a project setting for the same name wins where it is
 * `run` — the platform still starts the job and still requires it, which `wait` would only take
 * away — and is reported; over the settings' `ignore` the file's `wait` applies, because it adds a
 * check. And a name the settings set `run` or `ignore` is never added to `required_manual_jobs` by
 * the file (which would state the same name twice with two meanings): dropped and reported.
 */
const tightenManualJobModes = (
  project: ConfigValues,
  repo: ConfigValues,
  notApplied: RepositoryConfigNotApplied[],
): ConfigValues => {
  const settings: Readonly<Record<string, string>> = project.pipeline?.ci?.manual_jobs ?? {};
  const chosen = (name: string): string | undefined =>
    Object.hasOwn(settings, name) ? settings[name] : undefined;
  const ci = repo.pipeline?.ci;
  if (ci === undefined) return repo;
  let next = { ...ci };
  if (ci.manual_jobs !== undefined) {
    const kept: Record<string, 'run' | 'wait' | 'ignore'> = {};
    for (const [name, mode] of Object.entries(ci.manual_jobs)) {
      if (chosen(name) === 'run') {
        notApplied.push({
          key: `${MANUAL_JOBS_KEY}.${name}`,
          reason: `${LOOSENING_REASON}; the project settings start this job (run), which is still in force`,
        });
        continue;
      }
      kept[name] = mode;
    }
    const { manual_jobs: _dropped, ...rest } = next;
    next = Object.keys(kept).length === 0 ? rest : { ...rest, manual_jobs: kept };
  }
  const required = next.required_manual_jobs;
  if (Array.isArray(required)) {
    const clashing = required.filter((name) => {
      const mode = chosen(name);
      return mode === 'run' || mode === 'ignore';
    });
    if (clashing.length > 0) {
      for (const name of clashing) {
        notApplied.push({
          key: REQUIRED_MANUAL_JOBS_KEY,
          reason: `${JSON.stringify(name)} is set to ${chosen(name)} in the project settings (pipeline.ci.manual_jobs), which is still in force`,
        });
      }
      next = { ...next, required_manual_jobs: required.filter((name) => !clashing.includes(name)) };
    }
  }
  return { ...repo, pipeline: { ...repo.pipeline, ci: next } };
};

type WipKey = 'max_parallel_tasks' | 'max_tasks_in_pipeline';

/**
 * `pipeline.wip` from the file, **never above** the settings' value or, where the settings are
 * silent, BD-010's default (WP-91): a lower limit keeps review load humane and costs only
 * throughput, so the file may lower it; raising it lets merge rights buy concurrency — spend and
 * review load — that `project.settings.write` did not grant (Q101's tighten-only shape). A value the
 * file raised is kept at the settings' and reported.
 */
const tightenWip = (
  project: ConfigValues,
  repo: ConfigValues,
  notApplied: RepositoryConfigNotApplied[],
): NonNullable<NonNullable<ConfigValues['pipeline']>['wip']> | undefined => {
  const declared = repo.pipeline?.wip;
  if (declared === undefined) return undefined;
  const settings = project.pipeline?.wip ?? {};
  const defaults = PLATFORM_DEFAULT_CONFIG.pipeline?.wip ?? {};
  const next = { ...declared };
  for (const key of [
    'max_parallel_tasks',
    'max_tasks_in_pipeline',
  ] as const satisfies readonly WipKey[]) {
    const stated = declared[key];
    const base = settings[key] ?? defaults[key];
    if (stated === undefined || base === undefined || stated <= base) continue;
    next[key] = base;
    notApplied.push({
      key: `pipeline.wip.${key}`,
      reason: `${LOOSENING_REASON}; a repository file may lower a WIP limit, never raise it — ${base} is still in force`,
    });
  }
  return next;
};

/**
 * `commands.unattended` from the file, **never back to `auto`** once the settings chose `deny`
 * (BD-025's 2026-10-06 amendment). The command narrowing already ignores it (`deny` from any layer
 * wins, `unattendedCommandModeOf`); this is the half that **says so** in `not_applied`, as the
 * verification mode does, rather than leaving the file's `auto` looking applied.
 */
const tightenUnattended = (
  project: ConfigValues,
  repo: ConfigValues,
  notApplied: RepositoryConfigNotApplied[],
): ConfigValues => {
  if (repo.commands?.unattended !== 'auto' || project.commands?.unattended !== 'deny') return repo;
  const { unattended: _dropped, ...commands } = repo.commands;
  notApplied.push({
    key: 'commands.unattended',
    reason: `${LOOSENING_REASON}; a repository file may refuse unattended asks (deny), never run them over a deny — deny is still in force`,
  });
  return { ...repo, commands };
};

/**
 * `verification.mode` from the file, **never back to `local`** once the settings chose `ci` (BD-025's
 * 2026-10-05 amendment). `ci` takes the project's commands away from every run — the file's own
 * `commands.block` could already do that — so a file may choose it; `local` hands them back, which
 * is a loosening merge rights did not buy. A `local` the file stated over a `ci` setting is dropped
 * and reported; a `local` over a silent setting is the default restated and changes nothing.
 */
const tightenVerification = (
  project: ConfigValues,
  repo: ConfigValues,
  notApplied: RepositoryConfigNotApplied[],
): ConfigValues => {
  if (repo.verification?.mode !== 'local' || project.verification?.mode !== 'ci') return repo;
  const { verification: _dropped, ...rest } = repo;
  notApplied.push({
    key: 'verification.mode',
    reason: `${LOOSENING_REASON}; a repository file may move verification to CI, never back to local runs — ci is still in force`,
  });
  return rest;
};

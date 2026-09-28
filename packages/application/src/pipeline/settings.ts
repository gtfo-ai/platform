/**
 * The per-project settings the pipeline reads, behind a port.
 *
 * technical/12: `effective = merge(defaults, org, project, repo)`, "computed at task start and
 * frozen into `Run.settings_snapshot`". Computing that merge needs the org row, the project row
 * and `.agentic/config.yml` read from the default branch — three sources this ring must not reach
 * for. So it arrives as a port, and the composition root decides where each layer comes from.
 *
 * `defaultProjectSettings` is what an instance with no project configuration behaves like, and it
 * is what the tests drive: the shipped templates, BD-010's WIP limits and product/09's task cap.
 */

import type {
  CommandPolicy,
  Id,
  MaterialisedAutonomy,
  PipelineTemplate,
  TaskPipelineDial,
} from '@platform/contracts';
import type {
  AutonomyPreset,
  ConfigValues,
  EffectiveConfig,
  EpicSplitSettings,
  IterationLimits,
  WipLimits,
} from '@platform/domain';
import {
  DEFAULT_CHILD_ISSUE_TYPE,
  DEFAULT_EPIC_SPLIT_ISSUE_TYPES,
  DEFAULT_TASK_BUDGET_USD,
  DEFAULT_WIP_LIMITS,
  EPIC_SPLIT_TEMPLATE_ID,
  effectiveAutonomyPreset,
  epicSplitClaims,
  PLATFORM_DEFAULT_CONFIG,
  pipelineDialOf,
  resolveIterationLimits,
  SHIPPED_TEMPLATES,
  SPIKE_TEMPLATE_ID,
} from '@platform/domain';
import { assertOutsideTransaction } from '../events/open-transaction.js';
import type { Transaction } from '../ports/transaction.js';

export interface ProjectSettings {
  readonly projectId: Id;
  /** The merged `.agentic/config.yml` values (`EffectiveConfig.values`). */
  readonly config: ConfigValues;
  /** Templates by id: the shipped three, plus anything `.agentic/pipeline.yml` defines. */
  readonly templates: Readonly<Record<string, PipelineTemplate>>;
  readonly wip: WipLimits;
  /** product/09: "a total cap (default $50, per template)" at task scope. */
  readonly taskBudgetUsd: number;
  /** Where a task's workspace lives; WP-14's `WorkspaceProvider` supplies the real one. */
  readonly workspaceRoot: string;
  /** Ticket type (lower-cased) → template id, for intake's classification by rule. */
  readonly templateByIssueType: Readonly<Record<string, string>>;
  /**
   * The project's **materialised** autonomy dial (BD-027:14, `projects.autonomy_policies`), or
   * `null` when it has never been materialised.
   *
   * It is a field of its own rather than a key of {@link ProjectSettings.config} because it is not
   * part of `.agentic/config.yml`: a repository may propose `policies.autonomy`, but what the dial
   * *meant* on the day it was chosen is the platform's record and a repository must not be able to
   * rewrite it.
   *
   * **`null` is not "the default preset".** Migration 0021 backfilled every existing row and all
   * three writers supply a document, so on a real instance the only way to see `null` is a row a
   * test harness inserted. Readers must therefore treat it as *"this project's dial has never been
   * applied"* and say so (standing rule 16), never substitute `AUTONOMY_PRESETS[level]` — which is
   * exactly the re-derivation BD-027:14 forbids. `planApprovalGate` keeps its pre-WP-30 behaviour
   * for such a project and names that branch.
   */
  readonly autonomy: MaterialisedAutonomy | null;
  /**
   * The organisation's `commands` — the maximum every run's baseline is intersected with before
   * the project narrows it (BD-025 §2, PROGRESS backlog 146, WP-63). Absent is *"the organisation
   * states no list"*, which leaves the baseline as shipped.
   */
  readonly organisationCommands?: CommandPolicy;
  /**
   * The repository file's `commands` (WP-63): not merged into {@link ProjectSettings.config}, but
   * applied as a **second** narrowing after the settings' — so the file may tighten the command
   * policy and never loosen it (review round 1's ruling). Absent when the file states none.
   */
  readonly repositoryCommands?: CommandPolicy;
  /**
   * What the platform last read of the repository's own `.agentic/config.yml` on the default
   * branch (WP-63, BD-025 §1). {@link ProjectSettings.config} already has the file merged over the
   * settings when it was `valid`; this field is what a run is **refused** on when it was `invalid`
   * ({@link repositoryConfigRefusal}). Absent means the composition did not read one — every test
   * harness, and a process whose settings port has no repository layer.
   */
  readonly repository?: RepositoryConfigState;
}

/**
 * The repository layer's state as a run sees it — a projection of
 * `packages/application/src/config/repository-config.ts`'s stored snapshot.
 *
 *  - `unread` — nothing has read the file yet (no mirror, no git binding, or no read has happened);
 *  - `absent` — the default branch has no `.agentic/config.yml`, which is a legitimate project;
 *  - `valid` — the file parsed, and it is merged into `config`;
 *  - `invalid` — it did not, and `detail` names the key paths (standing rule 20).
 */
export interface RepositoryConfigState {
  readonly status: 'unread' | 'absent' | 'valid' | 'invalid';
  readonly commitSha: string | null;
  /** Redacted and bounded where it was stored; `null` unless `invalid`. */
  readonly detail: string | null;
}

/**
 * Why a run of this project may not start, or `null` — WP-63 criterion 4's run half.
 *
 * **An invalid repository file refuses the run; it does not run on the last good configuration.**
 * Both were on the table and the refusal is the one that cannot lie: the file on the default branch
 * *is* the project's statement of its configuration (Q94 (a)), so a run on an older reading would
 * execute under rules the repository no longer states — including a `block` entry somebody has just
 * added in the same edit that broke the file. The cost is that one bad merge stops the project's
 * runs until it is fixed, and the refusal says where. Everything that is not a run (a gate, a
 * notification) reads the settings without the repository layer; this is the one place that asks.
 */
export const repositoryConfigRefusal = (settings: ProjectSettings): string | null => {
  const repository = settings.repository;
  if (repository?.status !== 'invalid') {
    return null;
  }
  return (
    `the repository's .agentic/config.yml on the default branch${repository.commitSha === null ? '' : ` (commit ${repository.commitSha})`} ` +
    `does not parse: ${repository.detail ?? 'no detail was recorded'}. No run starts on this project until it is fixed — ` +
    'correct the file on the default branch, or export the settings over it (POST /api/projects/:project_id/config/export), then re-read it'
  );
};

/**
 * The policies actually in force for a project, or `null` when its dial was never materialised.
 *
 * The materialised preset with the project's own overrides on top — BD-027 keeps every policy
 * overridable, and `.agentic/config.yml` is where an override is written
 * (`AUTONOMY_POLICY_OVERRIDE_KEYS` says which keys can carry one, Q78).
 */
export const autonomyPresetFor = (settings: ProjectSettings): AutonomyPreset | null =>
  settings.autonomy === null ? null : effectiveAutonomyPreset(settings.autonomy, settings.config);

/**
 * The dial's two **pipeline** policies, as a task freezes them at start (WP-62, backlog 72 (b)).
 *
 * `businessReview` and `stopAfterStage` are read here, off the project's materialised preset, and
 * copied onto the task (`StoredTask.pipelineDial`); `compilePipeline` reads the copy. `null` when
 * the dial was never materialised — the stated *"never applied"* branch (BD-027:14), which compiles
 * the template as it was before WP-62 — never the supervised preset.
 */
export const pipelineDialFor = (settings: ProjectSettings): TaskPipelineDial | null => {
  const preset = autonomyPresetFor(settings);
  return settings.autonomy === null || preset === null
    ? null
    : pipelineDialOf(settings.autonomy, preset);
};

/**
 * The iteration ceilings a new task is created with — `pipeline.limits` where the document sets
 * them, and the dial's `humanMrRounds` where it is silent on `human_rounds` (WP-62, backlog 72 (a)).
 *
 * The preset already carries the document's `human_rounds` when there is one
 * (`autonomyOverridesFromConfig`), so the two cannot disagree: the document is the override and the
 * materialised preset is the default under it. A project whose dial was never materialised gets
 * BD-008's three, as before.
 */
export const iterationLimitsFor = (settings: ProjectSettings): IterationLimits =>
  resolveIterationLimits(
    settings.config.pipeline?.limits,
    autonomyPresetFor(settings)?.humanMrRounds,
  );

/**
 * Where the pipeline reads a project's settings — and **on which connection** (WP-73, PROGRESS
 * backlogs 19 and 221).
 *
 * A caller that holds a transaction passes it, and the read runs on that connection: an event
 * handler's `context.scope.tx`, which `EventBus` holds open for the whole handler body. A caller that
 * holds none passes nothing, and the adapter borrows a connection of its own — which is correct
 * only **outside** a transaction, so both shipped implementations call
 * {@link assertSettingsReadOutsideTransaction} on that branch. Before WP-73 four handlers
 * (`planApprovalGate`, `budgetApprovalGate`, the scheduler, the status mapping) asked without a
 * transaction from inside one, so a dispatch that `POOL_RESERVATIONS` counts as holding two
 * connections briefly borrowed a third; that borrow now fails a test instead of being a sentence.
 */
/**
 * **The project's effective protected paths** (BD-024 §2, technical/12 `policies.protected_paths`)
 * — the merged configuration's list, or the platform default when nothing set one.
 *
 * One expression for its two readers (standing rule 41): the planner hands it to the workspace's
 * path guard (write time), and the CI gate's tamper check compares a merge request's changed paths
 * with it (WP-81, `tamper.ts`). Two copies of the fallback would agree until somebody changed one.
 */
export const effectiveProtectedPaths = (settings: ProjectSettings): readonly string[] =>
  settings.config.policies?.protected_paths ??
  PLATFORM_DEFAULT_CONFIG.policies?.protected_paths ??
  [];

export interface ProjectSettingsPort {
  forProject(projectId: Id, tx?: Transaction): Promise<ProjectSettings>;
}

/**
 * The recurrence guard of {@link ProjectSettingsPort}: a settings read with no transaction handed
 * to it may not be made while one is open on the call path, because it would borrow a second pooled
 * connection inside the first. The fix is always the same — pass the scope's `tx`.
 *
 * @throws {TransactionOpenError} when a transaction is open on this call path.
 */
export const assertSettingsReadOutsideTransaction = (): void => {
  assertOutsideTransaction(
    'settings.forProject without the caller’s transaction',
    'Reading settings on a connection borrowed from the pool here would hold a second pooled ' +
      'connection inside the first, which the pool floor does not count: pass the scope’s `tx` ' +
      '(PROGRESS backlogs 19 and 221).',
  );
};

/**
 * product/04 S0: intake "classifies it (`feature | bug | chore | spike`) using the ticket type
 * mapping first". These are the type names Jira and GitLab ship with; a project overrides the map
 * in its settings.
 */
export const DEFAULT_TEMPLATE_BY_ISSUE_TYPE: Readonly<Record<string, string>> = {
  bug: 'bug',
  defect: 'bug',
  incident: 'bug',
  chore: 'chore',
  task: 'chore',
  'sub-task': 'chore',
  subtask: 'chore',
  story: 'feature',
  feature: 'feature',
  /**
   * **Still `feature`, and that is WP-40's decision rather than an omission** (criterion 2).
   *
   * product/04:117's epic-split variant is *"opt-in"* and product/18:45's default is *"off (spike
   * template option)"*, so an epic on a project that has not turned it on must run exactly the
   * pipeline it runs today. The variant is an override applied on top of this map by
   * {@link templateForIssueType}; the map is what a project edits, and a shipped default changed
   * here would have moved every existing project's epics at once.
   */
  epic: 'feature',
  improvement: 'feature',
  /**
   * product/04 S0 classifies a ticket as `feature | bug | chore | **spike**`, and until WP-40 this
   * map could not produce the fourth: `spike` was in `BUILTIN_TEMPLATE_IDS` and in no mapping, so a
   * ticket whose type a team had literally called *Spike* ran the **feature** pipeline and opened a
   * merge request for a research question. It is the document's own word, so it is mapped to the
   * document's own template.
   *
   * **The entry alone routes nothing** (review round 2). A spike ends at a human with no merge
   * request, so this line on its own stopped an existing project's `Spike` tickets producing the MR
   * they produce today — a behaviour change outside product/18:39's *"off (spike template
   * option)"*. `features.spike.enabled` is that opt-in and {@link templateForIssueType} asks it
   * before it answers `spike`, from **wherever** the mapping came: the switch is one place, so the
   * feature's state can be read off one screen.
   */
  spike: 'spike',
};

export const DEFAULT_TEMPLATE_ID = 'feature';

export const defaultProjectSettings = (
  projectId: Id,
  overrides: Partial<Omit<ProjectSettings, 'projectId'>> = {},
): ProjectSettings => ({
  projectId,
  config: {},
  templates: SHIPPED_TEMPLATES,
  wip: DEFAULT_WIP_LIMITS,
  taskBudgetUsd: DEFAULT_TASK_BUDGET_USD,
  workspaceRoot: '/workspaces',
  templateByIssueType: DEFAULT_TEMPLATE_BY_ISSUE_TYPE,
  // Not a preset: "no project configuration" is not "the supervised dial was chosen". See the field.
  autonomy: null,
  ...overrides,
});

/** A settings port over one already-merged configuration; the composition root's simplest case. */
export const staticProjectSettings = (
  settings: (projectId: Id) => ProjectSettings,
): ProjectSettingsPort => ({
  forProject: async (projectId, tx) => {
    // The double holds the production adapter's rule, so a handler that asks without its
    // transaction fails the unit tier rather than only borrowing a connection in production.
    if (tx === undefined) {
      assertSettingsReadOutsideTransaction();
    }
    return settings(projectId);
  },
});

/** The project's `features.epic_split`, with every default filled in (WP-40). */
export const resolveEpicSplitSettings = (settings: ProjectSettings): EpicSplitSettings => {
  const configured = settings.config.features?.epic_split;
  return {
    enabled: configured?.enabled ?? false,
    issueTypes: configured?.issue_types ?? DEFAULT_EPIC_SPLIT_ISSUE_TYPES,
    childIssueType: configured?.child_issue_type ?? DEFAULT_CHILD_ISSUE_TYPE,
  };
};

/**
 * Is the **spike template** itself turned on for this project (product/18:39, WP-40 round 2)?
 *
 * `false` for a project that has configured nothing, which is what makes `spike: 'spike'` in
 * {@link DEFAULT_TEMPLATE_BY_ISSUE_TYPE} inert until somebody asks for it. It gates the template
 * rather than the map entry, so a project that maps `research → spike` in its own configuration
 * needs the same switch and there is still exactly one place the feature is on or off.
 */
export const spikeTemplateEnabled = (settings: ProjectSettings): boolean =>
  settings.config.features?.spike?.enabled ?? false;

/**
 * Why this ticket did **not** reach the spike template although something mapped it there.
 *
 * `null` when there is nothing to say — the map named another template, or the switch is on. It
 * exists for standing rule 18's reason: *"nothing happened"* is the normal outcome here, and an
 * operator whose `Spike` tickets keep opening merge requests has to be able to read why from the
 * log rather than from this file. The intake duty is the one caller.
 */
export const spikeRefusal = (
  settings: ProjectSettings,
  issueType: string | null,
): string | null => {
  const mapped =
    issueType === null ? undefined : settings.templateByIssueType[issueType.trim().toLowerCase()];
  return mapped === SPIKE_TEMPLATE_ID && !spikeTemplateEnabled(settings)
    ? 'the spike template is off for this project (features.spike.enabled), so the ticket runs the default pipeline'
    : null;
};

/**
 * What the caller knows about *this* ticket that the configuration cannot say (WP-40).
 *
 * Both fields default to the conservative answer, so a caller that has not thought about the
 * epic-split variant never routes a ticket to it — which is the fail-closed direction for a feature
 * whose ending is a write into somebody else's backlog (standing rule 20).
 */
export interface TemplateRouting {
  /**
   * Whether this project's task-management binding reports `createTicket`.
   *
   * WP-40 criterion 6: a binding that cannot create tickets is refused **by name** here rather than
   * producing a breakdown nobody can accept — a queue of seven proposals whose acceptance would
   * throw `IntegrationUnsupportedError` is worse than a feature ticket, because a human has already
   * spent a decision on it by then.
   */
  readonly canCreateTickets?: boolean;
  /**
   * Whether this is a **shadow** task.
   *
   * A shadow task routes to the ordinary template even for an epic the variant claims, and that is
   * a decision rather than a consequence: shadow mode exists to compare what the agent would have
   * produced with what a human did (product/19 §13), and there is no human breakdown to compare a
   * proposed one against. The executor's shadow guard would refuse the `createTicket` call anyway
   * (`mutate`), so this is the *second* of two refusals rather than the only one.
   */
  readonly shadow?: boolean;
}

export type EpicSplitRouting =
  | { readonly kind: 'routed' }
  | { readonly kind: 'not_claimed' }
  | { readonly kind: 'refused'; readonly reason: string };

/**
 * Does this ticket reach the epic-split variant, and if not, why not?
 *
 * Separate from {@link templateForIssueType} because the caller has to be able to **log the
 * reason**: "nothing happened" is the normal outcome for almost every ticket, and an operator who
 * turned the feature on still has to be able to read why their epic went down the feature pipeline
 * (standing rule 18). `templateForIssueType` calls this rather than repeating the rule, so the two
 * cannot disagree (standing rule 41).
 */
export const epicSplitRouting = (
  settings: ProjectSettings,
  issueType: string | null,
  routing: TemplateRouting = {},
): EpicSplitRouting => {
  if (!epicSplitClaims(resolveEpicSplitSettings(settings), issueType)) {
    return { kind: 'not_claimed' };
  }
  if (!(EPIC_SPLIT_TEMPLATE_ID in settings.templates)) {
    return { kind: 'refused', reason: 'this project has no epic_split template' };
  }
  if (routing.shadow === true) {
    return { kind: 'refused', reason: 'a shadow task never proposes a ticket breakdown' };
  }
  if (routing.canCreateTickets !== true) {
    return {
      kind: 'refused',
      reason:
        'the project’s task-management binding cannot create tickets, so an accepted breakdown could not be filed',
    };
  }
  return { kind: 'routed' };
};

/**
 * The template a ticket maps onto (product/04 S0). Unknown types fall to `feature`, which is the
 * fullest pipeline — the safe direction, since a chore run on the feature template only costs a
 * plan, while a feature run on the chore template skips architecture and business review.
 *
 * **The epic-split variant is decided here and `DEFAULT_TEMPLATE_BY_ISSUE_TYPE` still maps `epic`
 * to `feature`** (WP-40, criterion 2). Editing the map would have been the other option and is the
 * wrong one twice over: the map is the *project's* to override (technical/12), so changing a
 * shipped default would silently change what an existing project's epics run on, and the variant's
 * own switch is `features.epic_split.enabled` — a feature that could be turned on from two places
 * is a feature whose state nobody can read off one screen. So the map is untouched, the variant is
 * an override on top of it, and a project with the feature off behaves exactly as it does today.
 *
 * **The plain spike template is gated too, and from one place** (review round 2). It ends at a
 * human with no merge request, so answering `spike` for a project that has not asked for it stops
 * MRs a team is getting today — outside product/18:39's *"off (spike template option)"*. The gate
 * is on the **answer** rather than on the map entry: a project that maps its own type to `spike`
 * meets the same switch, so `features.spike.enabled` is the whole state of the feature.
 */
export const templateForIssueType = (
  settings: ProjectSettings,
  issueType: string | null,
  routing: TemplateRouting = {},
): string => {
  if (epicSplitRouting(settings, issueType, routing).kind === 'routed') {
    return EPIC_SPLIT_TEMPLATE_ID;
  }
  const mapped =
    issueType === null ? undefined : settings.templateByIssueType[issueType.trim().toLowerCase()];
  const candidate = mapped ?? DEFAULT_TEMPLATE_ID;
  if (candidate === SPIKE_TEMPLATE_ID && !spikeTemplateEnabled(settings)) {
    return DEFAULT_TEMPLATE_ID;
  }
  return candidate in settings.templates ? candidate : DEFAULT_TEMPLATE_ID;
};

/** `EffectiveConfig` narrowed to what this port carries, for a composition root that has one. */
export const projectSettingsFrom = (
  projectId: Id,
  effective: EffectiveConfig,
  overrides: Partial<Omit<ProjectSettings, 'projectId' | 'config'>> = {},
): ProjectSettings => defaultProjectSettings(projectId, { ...overrides, config: effective.values });

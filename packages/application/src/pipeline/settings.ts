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

import type { Id, PipelineTemplate } from '@platform/contracts';
import type { ConfigValues, EffectiveConfig, WipLimits } from '@platform/domain';
import { DEFAULT_TASK_BUDGET_USD, DEFAULT_WIP_LIMITS, SHIPPED_TEMPLATES } from '@platform/domain';

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
}

export interface ProjectSettingsPort {
  forProject(projectId: Id): Promise<ProjectSettings>;
}

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
  epic: 'feature',
  improvement: 'feature',
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
  ...overrides,
});

/** A settings port over one already-merged configuration; the composition root's simplest case. */
export const staticProjectSettings = (
  settings: (projectId: Id) => ProjectSettings,
): ProjectSettingsPort => ({
  forProject: async (projectId) => settings(projectId),
});

/**
 * The template a ticket maps onto (product/04 S0). Unknown types fall to `feature`, which is the
 * fullest pipeline — the safe direction, since a chore run on the feature template only costs a
 * plan, while a feature run on the chore template skips architecture and business review.
 */
export const templateForIssueType = (
  settings: ProjectSettings,
  issueType: string | null,
): string => {
  const mapped =
    issueType === null ? undefined : settings.templateByIssueType[issueType.trim().toLowerCase()];
  const candidate = mapped ?? DEFAULT_TEMPLATE_ID;
  return candidate in settings.templates ? candidate : DEFAULT_TEMPLATE_ID;
};

/** `EffectiveConfig` narrowed to what this port carries, for a composition root that has one. */
export const projectSettingsFrom = (
  projectId: Id,
  effective: EffectiveConfig,
  overrides: Partial<Omit<ProjectSettings, 'projectId' | 'config'>> = {},
): ProjectSettings => defaultProjectSettings(projectId, { ...overrides, config: effective.values });

/**
 * `basicStageRunPlanner` — the `RunSpec` the pipeline hands the runner, assembled from what exists
 * today.
 *
 * **This is a placeholder for two other work packages, and says so where it matters.** technical/04
 * assembles a prompt from six layers: the shipped role prompt (WP-17), the project's overrides
 * (WP-17), the task block, the context pack (WP-16) and the output contract. WP-16 and WP-17 have
 * not landed, so layers 1–3 here are a short, literal description of the role's job and the context
 * pack is empty. What *is* real is everything that decides what a run may **do** — the tool set,
 * the command policy, the protected paths, the budget and the turn limit — because those are
 * security and spend decisions that the pipeline owns rather than the prompt author (BD-021,
 * BD-024, BD-025, BD-013).
 *
 * `promptVersion` is therefore honest about what it hashes: `basic@1` plus the role, so a run
 * recorded today cannot be mistaken for one produced by WP-17's assembled prompt.
 */
import type { AgentRole, ArtifactType, Id } from '@platform/contracts';
import {
  DEFAULT_COMMAND_POLICY,
  narrowCommandPolicy,
  PLATFORM_DEFAULT_CONFIG,
  resolveRunCapUsd,
  stageAgentDefaults,
} from '@platform/domain';
import type { PlatformToolName, RunLimits, RunSpec } from '../ports/runner.js';
import { runLimitsDefaults } from '../ports/runner.js';
import type { ProjectSettings } from './settings.js';
import type { StageRunPlanner, StageRunRequest } from './stage-executor.js';
import type { StoredArtifact } from './store.js';

/**
 * Which platform tools a role may call (technical/04: "a run is given the subset its role needs:
 * a read-only stage never sees `open_mr`, so a mutating action is impossible rather than merely
 * refused"). This is BD-021's least privilege expressed as a table.
 */
export const PLATFORM_TOOLS_BY_ROLE: Readonly<Record<AgentRole, readonly PlatformToolName[]>> = {
  triager: ['report_progress', 'get_task_context'],
  product_manager: ['ask_human', 'report_progress', 'get_task_context', 'kb_search'],
  investigator: ['ask_human', 'report_progress', 'get_task_context', 'kb_search'],
  architect: ['ask_human', 'report_progress', 'get_task_context', 'kb_search'],
  developer: [
    'ask_human',
    'notify_human',
    'report_progress',
    'get_task_context',
    'kb_search',
    'add_ticket_comment',
    'open_mr',
    'update_mr_description',
    'create_followup_ticket',
  ],
  reviewer: ['report_progress', 'get_task_context', 'kb_search'],
  acceptance_tester: ['report_progress', 'get_task_context', 'kb_search'],
  facilitator: ['report_progress', 'get_task_context', 'kb_search'],
  librarian: ['report_progress', 'get_task_context', 'kb_search'],
  discovery: ['report_progress', 'kb_search'],
};

/** SDK tools per role: only the developer writes to the workspace or runs a command (BD-021). */
export const TOOLS_BY_ROLE: Readonly<Record<AgentRole, readonly string[]>> = {
  triager: [],
  product_manager: ['Read', 'Glob', 'Grep'],
  investigator: ['Read', 'Glob', 'Grep'],
  architect: ['Read', 'Glob', 'Grep'],
  developer: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'],
  reviewer: ['Read', 'Glob', 'Grep'],
  acceptance_tester: ['Read', 'Glob', 'Grep', 'Bash'],
  facilitator: ['Read', 'Glob', 'Grep'],
  librarian: ['Read', 'Glob', 'Grep', 'Edit', 'Write'],
  discovery: ['Read', 'Glob', 'Grep'],
};

/** One line per role: what this stage is for. Layers 1–3 of technical/04, until WP-17. */
const ROLE_BRIEF: Readonly<Record<AgentRole, string>> = {
  triager: 'Classify the ticket. Do not read the codebase deeply.',
  product_manager:
    'Rewrite the ticket into a Refined Specification: goal, scope, acceptance criteria with runnable validation, and open questions. Ask rather than guess.',
  investigator:
    'Find the root cause of the reported defect and record the evidence for it. Say how confident you are; ask for more evidence rather than guessing.',
  architect:
    'Produce an implementation plan: approach, affected modules, data and API changes, the validation contract for each acceptance criterion, risks. Never write code.',
  developer:
    'Implement the plan in the workspace, write the tests it names, run the project checks, and open a draft merge request. Never widen the scope; file a follow-up ticket instead.',
  reviewer:
    'Review the diff against the plan and the specification. Report findings with severity and file:line, then approve or request changes.',
  acceptance_tester:
    'Verify each acceptance criterion against the diff with evidence. Report what is met, what is not, and anything out of scope.',
  facilitator:
    'Write the retrospective: what caused returns, what a human had to correct, and the knowledge updates that would have prevented them.',
  librarian: 'Merge the proposed knowledge updates into the knowledge base and keep it tidy.',
  discovery: 'Explore the repository and draft the project knowledge base.',
};

const artifactContract = (type: ArtifactType | null): string =>
  type === null
    ? 'This stage produces no artifact.'
    : `Produce a ${type} as structured output; it is validated against the platform's schema and is what the pipeline transitions on.`;

const summarise = (artifacts: readonly StoredArtifact[]): string =>
  artifacts.length === 0
    ? 'No earlier artifacts.'
    : artifacts
        .map((artifact) => `- ${artifact.type} v${artifact.version} (id ${artifact.id})`)
        .join('\n');

export interface BasicPlannerOptions {
  /** Absolute path of the task's workspace; WP-14's `WorkspaceProvider` supplies the real one. */
  readonly workspacePath: (taskId: Id) => string;
  /** `api` or `local` (BD-004); the composition root knows which one the instance runs. */
  readonly providerMode?: 'api' | 'local';
  /** Environment handed to the CLI. Never inherited (technical/04). */
  readonly env?: Readonly<Record<string, string>>;
  /** Names in `env` whose values are secret, for the injected-secret redactor (TD-012). */
  readonly secretEnvNames?: readonly string[];
  readonly claudeCodePath?: string | null;
}

const limitsFor = (settings: ProjectSettings, stage: string, role: AgentRole): RunLimits => {
  const defaults = stageAgentDefaults(stage);
  const configured = settings.config.stages?.[stage];
  return {
    ...runLimitsDefaults,
    maxTurns: configured?.max_turns ?? defaults.maxTurns,
    maxBudgetUsd: resolveRunCapUsd(stage, configured?.budget_usd) ?? runLimitsDefaults.maxBudgetUsd,
    // A reviewer that only reads needs no shell, so its wall clock can be the default; the
    // developer's is the one that ever gets near it, and it is the stage the operator tunes.
    wallClockMs:
      role === 'developer' ? runLimitsDefaults.wallClockMs : runLimitsDefaults.wallClockMs,
  };
};

export const basicStageRunPlanner = (options: BasicPlannerOptions): StageRunPlanner => ({
  plan: async (request: StageRunRequest): Promise<RunSpec> => {
    const { stage, task, settings } = request;
    const role = stage.role ?? 'developer';
    const defaults = stageAgentDefaults(stage.id);
    const configured = settings.config.stages?.[stage.id];
    const policy = narrowCommandPolicy(DEFAULT_COMMAND_POLICY, settings.config.commands);
    const protectedPaths =
      settings.config.policies?.protected_paths ??
      PLATFORM_DEFAULT_CONFIG.policies?.protected_paths ??
      [];

    return {
      runId: request.runId,
      taskId: task.task.id,
      projectId: task.task.projectId,
      stage: stage.id,
      role,
      mode: task.task.mode === 'shadow' ? 'shadow' : 'normal',
      attempt: request.attempt,
      model: configured?.model ?? defaults.model,
      effort: configured?.effort ?? defaults.effort,
      providerMode: options.providerMode ?? 'api',
      promptVersion: `basic@1+${role}`,
      systemPromptAppend: `${ROLE_BRIEF[role]}\n\n${artifactContract(stage.produces)}`,
      userPrompt: [
        `# Ticket ${task.task.ticket.key}`,
        task.task.ticket.url,
        '',
        '## Stage',
        `${stage.id} (attempt ${request.attempt})`,
        '',
        '## Artifacts so far',
        summarise(request.artifacts),
        ...(request.returnFeedback === null
          ? []
          : ['', '## Why this stage is running again', request.returnFeedback]),
      ].join('\n'),
      workspacePath: options.workspacePath(task.task.id),
      contextPack: [],
      limits: limitsFor(settings, stage.id, role),
      tools: [...(TOOLS_BY_ROLE[role] ?? [])],
      disallowedTools: [],
      platformTools: [...(PLATFORM_TOOLS_BY_ROLE[role] ?? [])],
      commandPolicy: {
        allow: [...policy.policy.allow],
        ask: [...policy.policy.ask],
        block: [...policy.policy.block],
      },
      protectedPaths: [...protectedPaths],
      // BD-024: the plan's exceptions. WP-17 fills these from the ImplementationPlan's
      // `protected_path_changes`; until then a protected path is never planned, which is the
      // fail-closed direction.
      plannedProtectedPaths: [],
      agents: {},
      mcpServers: {},
      skills: [],
      artifactType: stage.produces,
      env: { ...(options.env ?? {}) },
      secretEnvNames: [...(options.secretEnvNames ?? [])],
      claudeCodePath: options.claudeCodePath ?? null,
      resumeSessionId: null,
    };
  },
});

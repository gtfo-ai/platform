/**
 * The `RunSpec` an ask-the-task run is started with (WP-31).
 *
 * It is a sibling of `createStageRunPlanner` rather than a branch inside it, and the reason is the
 * shape of the two inputs: a stage plan is built from a `PipelineStage` — its role, its artifact,
 * its budget, its focus — and an ask has **no stage at all**. Threading a nullable stage through
 * that function would have put `stage === null` in a dozen places whose whole subject is the stage.
 *
 * What it does *not* duplicate is the part that decides privilege: the four least-privilege tables
 * (`PLATFORM_TOOLS_BY_ROLE`, `TOOLS_BY_ROLE`, `SKILLS_BY_ROLE`, `COMMAND_BASELINE_BY_ROLE`) and
 * `commandBaselineFor` are imported from the stage planner, so the ask role's privileges are
 * declared in the same place as every other role's and `planner.test.ts`'s enumeration covers them.
 *
 * ## What the ask is shown
 *
 * product/10:57: *"answered from the audit trail and artifacts with links to the exact run and
 * prompt"*. So the prompt carries four data blocks beyond the pack: the ticket (through the same
 * `ticketSnapshot` the stage prompt uses), the task's artifacts, its **runs**, and its
 * **`human_actions`** — the last two as one `record` block each, rendered from the projections
 * `AskStore` answers. Every byte of all four is untrusted (`human_actions.params` carries a
 * client-chosen `Idempotency-Key`), so all four are inside blocks with this prompt's nonce.
 */
import type { AgentRole, ContextPackRecord, Id, IsoDate, IsoDateTime } from '@platform/contracts';
import {
  ASK_ROLE,
  ASK_RUN_MODE,
  assemblePrompt,
  DEFAULT_ASK_BUDGET_USD,
  DEFAULT_ASK_MODEL,
  DEFAULT_CONTEXT_BUDGET_TOKENS,
  isPromptExcludedArtifact,
  narrowCommandPolicy,
  type PromptContextPack,
  type SkillDefinition,
  skillSetVersionOf,
} from '@platform/domain';
import type { ContextPackAssembler } from '../knowledge/context-pack.js';
import {
  commandBaselineFor,
  platformToolsFor,
  SKILLS_BY_ROLE,
  type StageRunPlannerOptions,
  TOOLS_BY_ROLE,
} from '../pipeline/planner.js';
import type { ProjectSettings } from '../pipeline/settings.js';
import type { StoredArtifact, StoredTask } from '../pipeline/store.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { RunContextDocument, RunSpec } from '../ports/runner.js';
import { runLimitsDefaults } from '../ports/runner.js';
import { qualifiedPlatformSkill } from '../ports/workspace.js';
import { askFeature } from './settings.js';
import type { AskAuditLine, AskRunLine, StoredAsk } from './store.js';

/**
 * The pseudo-stage the ask's command policy and context pack are keyed by.
 *
 * It is **not** written to `runs.task_stage_id` — that column stays null, which is the whole point
 * of criterion 1 — and it never reaches the prompt, whose task block says *"this run belongs to no
 * pipeline stage"*. It exists because two functions this module reuses are keyed by a stage string:
 * `commandBaselineFor` (which asks `COMMAND_ALLOW_BY_STAGE` for extra allow patterns, of which the
 * ask has none) and the retrieval assembler's `stage` field, which the knowledge base's `trigger:`
 * front-matter matches against. Naming it `ask` means a project *can* write a KB rule that fires on
 * an ask, which is the behaviour a project would expect from that front-matter.
 */
export const ASK_PSEUDO_STAGE = 'ask';

/** How many of the task's runs and audit rows the prompt carries. */
export const ASK_RECORD_RUN_LIMIT = 50;
export const ASK_RECORD_AUDIT_LIMIT = 100;

export interface AskRunRequest {
  readonly runId: Id;
  readonly ask: StoredAsk;
  readonly task: StoredTask;
  readonly settings: ProjectSettings;
  readonly artifacts: readonly StoredArtifact[];
  readonly runs: readonly AskRunLine[];
  readonly audit: readonly AskAuditLine[];
  /** Who asked, as the platform knows them — a display name, never an email address. */
  readonly askedByLabel: string;
}

export interface AskRunPlan {
  readonly spec: RunSpec;
  /** `run.started.context_pack` — the same audit record a stage run carries (technical/12). */
  readonly contextPack: ContextPackRecord;
}

/** A port for the same reason `StageRunPlanner` is one: it performs I/O (the retrieval reads). */
export interface AskRunPlanner {
  plan(request: AskRunRequest): Promise<AskRunPlan>;
}

const emptyRecord = (budgetTokens: number): ContextPackRecord => ({
  tier0: [],
  tier1: [],
  budget_tokens: budgetTokens,
  total_tokens: 0,
  kb_commit: null,
});

/**
 * The run list, as one block body.
 *
 * Platform labels around provider- and model-chosen values, inside a data block — the division
 * `ticketBlock` already makes. The **count** goes in the marker, because "this is all of them" is a
 * claim about the platform's own behaviour and technical/07 requires such a claim to be unforgeable.
 */
const runsBody = (runs: readonly AskRunLine[]): string =>
  runs.length === 0
    ? '(this task has no runs)'
    : runs
        .map((run) =>
          [
            `run ${run.runId}`,
            `  stage: ${run.stage ?? '(none)'}`,
            `  role: ${run.role}`,
            `  mode: ${run.mode}`,
            `  attempt: ${run.attempt}`,
            `  model: ${run.model}`,
            `  status: ${run.status}${run.terminalReason === null ? '' : ` (${run.terminalReason})`}`,
            `  cost_usd: ${run.costUsd}`,
            `  created_at: ${run.createdAt}`,
          ].join('\n'),
        )
        .join('\n');

const auditBody = (audit: readonly AskAuditLine[]): string =>
  audit.length === 0
    ? '(no human action has been recorded on this task)'
    : audit
        .map((entry) =>
          [
            `action ${entry.id}`,
            `  what: ${entry.action}`,
            `  by_user_id: ${entry.userId ?? '(unknown)'}`,
            `  at: ${entry.createdAt}`,
            `  params: ${JSON.stringify(entry.params)}`,
          ].join('\n'),
        )
        .join('\n');

export interface AskRunPlannerOptions
  extends Pick<
    StageRunPlannerOptions,
    | 'workspacePath'
    | 'prompts'
    | 'skills'
    | 'nonce'
    | 'contextPacks'
    | 'providerMode'
    | 'env'
    | 'secretEnvNames'
    | 'claudeCodePath'
    | 'clock'
  > {
  readonly contextPacks: ContextPackAssembler;
  readonly clock: { now(): IsoDateTime };
  readonly logger?: Logger;
}

export const createAskRunPlanner = (options: AskRunPlannerOptions): AskRunPlanner => {
  const logger = options.logger ?? silentLogger;
  const role: AgentRole = ASK_ROLE;

  return {
    plan: async (request: AskRunRequest): Promise<AskRunPlan> => {
      const { ask, task, settings } = request;
      const feature = askFeature(settings);
      const budgetTokens =
        settings.config.project?.context_budget_tokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS;

      const result = await options.contextPacks.assemble({
        projectId: task.task.projectId,
        stage: ASK_PSEUDO_STAGE,
        // The **question** is the query, not the ticket: an ask is retrieved for what it asks
        // about. It is untrusted text reaching a keyword extractor, which is the same exposure
        // `taskTextOf` already has and which `extractQueryTerms` bounds.
        taskText: ask.question,
        touchedPaths: [],
        repoPaths: [],
        today: options.clock.now().slice(0, 10) as IsoDate,
        knowledgeDir: settings.config.project?.knowledge_dir ?? '.agentic/knowledge',
        budgetTokens,
      });
      const pack: PromptContextPack =
        result.status === 'not_indexed'
          ? { status: 'not_indexed', documents: [], budgetTokens, totalTokens: 0 }
          : {
              status: 'ok',
              documents: result.pack.documents.map((document) => ({
                tier: document.tier,
                path: document.path,
                workspacePath: document.workspacePath,
                reason: document.reason,
                tokens: document.tokens,
                text: document.text,
              })),
              budgetTokens: result.pack.record.budget_tokens,
              totalTokens: result.pack.record.total_tokens,
            };
      const runContextPack: readonly RunContextDocument[] =
        result.status === 'not_indexed' ? [] : result.pack.runContextPack;

      const skills = (SKILLS_BY_ROLE[role] ?? []).map(
        (name) => options.skills[name] as SkillDefinition,
      );

      const prompt = assemblePrompt({
        nonce: options.nonce,
        role: options.prompts[role],
        pack,
        task: {
          // The whole of criterion 1 in one field: an ask belongs to no stage.
          stage: null,
          attempt: 1,
          ticket: task.task.ticket,
          ticketSnapshot: task.ticketSnapshot,
          reviewSubject: task.reviewSubject ?? null,
          artifacts: request.artifacts
            .filter((artifact) => !isPromptExcludedArtifact(artifact.type))
            .map((artifact) => ({
              type: artifact.type,
              version: artifact.version,
              json: JSON.stringify(artifact.data),
            })),
          returnFeedback: null,
          record: [
            { kind: 'runs' as const, count: request.runs.length, body: runsBody(request.runs) },
            {
              kind: 'human_actions' as const,
              count: request.audit.length,
              body: auditBody(request.audit),
            },
          ],
        },
        artifactType: 'AskAnswer',
        focus: null,
        language: 'auto',
        ask: { question: ask.question, askedBy: request.askedByLabel },
      });

      const policy = narrowCommandPolicy(
        commandBaselineFor(role, ASK_PSEUDO_STAGE),
        settings.config.commands,
      );

      logger.debug(
        {
          ask_id: ask.id,
          run_id: request.runId,
          task_id: task.task.id,
          documents: pack.documents.length,
        },
        'planned an ask run',
      );

      const spec: RunSpec = {
        runId: request.runId,
        taskId: task.task.id,
        projectId: task.task.projectId,
        stage: null,
        role,
        mode: ASK_RUN_MODE,
        attempt: 1,
        model: feature.model,
        // BD-013's verification tier is a `medium`-effort job: an ask reads a record and explains
        // it, which is not the reasoning-heavy work `high` exists for, and the cap is 0.50 USD.
        effort: 'medium',
        providerMode: options.providerMode ?? 'api',
        promptVersion: `${prompt.promptVersion}+${skillSetVersionOf(skills)}`,
        systemPromptAppend: prompt.systemPrompt,
        userPrompt: prompt.userPrompt,
        workspacePath: options.workspacePath(task.task.id),
        contextPack: [...runContextPack],
        limits: {
          ...runLimitsDefaults,
          // One question, one answer. A turn limit is what stops an ask that has decided to keep
          // searching the knowledge base from spending its whole cap on retrieval.
          maxTurns: 12,
          maxBudgetUsd: feature.budgetUsd,
        },
        tools: [...(TOOLS_BY_ROLE[role] ?? [])],
        disallowedTools: [],
        platformTools: [...platformToolsFor(role, ASK_PSEUDO_STAGE)],
        commandPolicy: {
          allow: [...policy.policy.allow],
          ask: [...policy.policy.ask],
          block: [...policy.policy.block],
        },
        protectedPaths: [],
        plannedProtectedPaths: [],
        agents: {},
        mcpServers: {},
        skills: skills.map((skill) => qualifiedPlatformSkill(skill.name)),
        artifactType: 'AskAnswer',
        env: { ...(options.env ?? {}) },
        secretEnvNames: [...(options.secretEnvNames ?? [])],
        claudeCodePath: options.claudeCodePath ?? null,
        resumeSessionId: null,
      };

      return {
        spec,
        contextPack:
          result.status === 'not_indexed' ? emptyRecord(budgetTokens) : result.pack.record,
      };
    },
  };
};

export { DEFAULT_ASK_BUDGET_USD, DEFAULT_ASK_MODEL };

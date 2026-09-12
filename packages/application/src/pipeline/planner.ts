/**
 * `createStageRunPlanner` — the `RunSpec` and the `ContextPackRecord` the pipeline hands the runner.
 *
 * This is technical/04 § "Prompt assembly" wired end to end, and until WP-17 it was not: the
 * planner shipped a one-line role brief, `contextPack: []`, and a `promptVersion` of `basic@1` that
 * said so. Three things arrive here now, and the order they arrive in is the whole of PROGRESS
 * backlog 12:
 *
 *  1. **The delimiter first.** `assemblePrompt` (`@platform/domain`) frames every piece of untrusted
 *     text in a nonce-bearing data block *before* anything non-empty is passed. A pack wired first
 *     and delimited later opens the window for the length of a work package, which is exactly what
 *     backlog 12 asked not to happen.
 *  2. **A real context pack**, from the `ContextPackAssembler` WP-16 built. Required, not optional:
 *     a collaborator a composition root may omit is one production omits (standing rule 31), and
 *     "nothing composes it" is the defect this work package exists to close.
 *  3. **The shipped role prompts**, handed in by the composition root. `@platform/prompts` is
 *     outside this ring's import allowance, which is what lets a project override a prompt without
 *     the planner knowing.
 *
 * What was already real stays real and is not re-derived here: the tool set, the command policy,
 * the protected paths, the budget and the turn limit are security and spend decisions the pipeline
 * owns rather than the prompt author (BD-021, BD-024, BD-025, BD-013).
 *
 * ## The pack's I/O happens outside a transaction, and that is a constraint on the caller
 *
 * `plan()` performs four to six database reads. The stage executor calls it **between** its two
 * transactions (`stage-executor.ts` § "the shape is transaction / plan / transaction"), so the
 * connection it borrows *replaces* the worker's rather than nesting inside it — the same argument
 * `POOL_RESERVATIONS.pipeline` makes for the other job workers, and the reason this is not a second
 * instance of PROGRESS backlog 19.
 */
import type {
  AgentRole,
  ArtifactType,
  ContextPackRecord,
  Id,
  IsoDate,
  IsoDateTime,
} from '@platform/contracts';
import {
  assemblePrompt,
  DEFAULT_COMMAND_POLICY,
  DEFAULT_CONTEXT_BUDGET_TOKENS,
  narrowCommandPolicy,
  PLATFORM_DEFAULT_CONFIG,
  type PromptContextPack,
  type PromptNonceSource,
  type RolePromptDefinition,
  resolveRunCapUsd,
  stageAgentDefaults,
} from '@platform/domain';
import type { ContextPackAssembler, ContextPackDocument } from '../knowledge/context-pack.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { PlatformToolName, RunContextDocument, RunLimits, RunSpec } from '../ports/runner.js';
import { runLimitsDefaults } from '../ports/runner.js';
import type { ProjectSettings } from './settings.js';
import type { StageRunPlan, StageRunPlanner, StageRunRequest } from './stage-executor.js';
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

/**
 * How much of the task's own text the retrieval query is built from.
 *
 * `extractQueryTerms` already bounds the *query* at `MAX_QUERY_TERMS`; this bounds the **scan**. A
 * task whose artifacts run to megabytes would otherwise be lower-cased and split in full to produce
 * two dozen terms taken from its first paragraph.
 */
export const MAX_TASK_TEXT_CHARS = 20_000;

export interface StageRunPlannerOptions {
  /** Absolute path of the task's workspace; WP-14's `WorkspaceProvider` supplies the real one. */
  readonly workspacePath: (taskId: Id) => string;
  /**
   * The shipped role prompts (`@platform/prompts`). Required: a planner with no prompts is the
   * placeholder this work package replaced.
   *
   * A project's own `prompts/<stage>.md` override is **still not read**, and the reason is no
   * longer "there is no default-branch read": WP-18a built one and WP-18b commits to it. What is
   * missing is that the vault source answers the four *indexed* path classes and a prompt override
   * is not one of them, so serving it means widening what the adapter returns or reading twice —
   * both decisions with consequences (a template a project declared and the platform could not read
   * parks every task one stage short of `done`). It is in the ledger's discovered work, unowned.
   */
  readonly prompts: Readonly<Record<AgentRole, RolePromptDefinition>>;
  /**
   * Where the data-block nonce comes from. **Required, never defaulted** — a default would make the
   * marker predictable, which is the one property the delimiter contract rests on (standing rule
   * 31: an optional security dependency is an absent one).
   */
  readonly nonce: PromptNonceSource;
  /** WP-16's assembler. Required; see the module docblock. */
  readonly contextPacks: ContextPackAssembler;
  /**
   * Every tracked path at HEAD, for technical/07 step 3's validate-on-read.
   *
   * Absent in this build and **said so out loud** rather than defaulted to `[]` in silence: there
   * is no checkout at plan time (the pipeline does not compose `WorkspaceProvider` yet), so a
   * knowledge document carrying a `paths:` glob is recorded `validated: false` and never admitted.
   * That is visible in `run_context_pack` and logged once per run here.
   *
   * **Still absent after WP-18a, and the reason changed.** That work package gave the platform a
   * default-branch read that needs no checkout — `VaultSource.read` over a bare mirror, whose
   * `repoPaths` *is* the tracked set at the commit — so what is missing is no longer a tree but a
   * caller: the planner would have to read the vault a second time, per run, to get it. Filed as
   * discovered work rather than wired here.
   */
  readonly headPaths?: (projectId: Id) => Promise<readonly string[]>;
  /** `api` or `local` (BD-004); the composition root knows which one the instance runs. */
  readonly providerMode?: 'api' | 'local';
  /** Environment handed to the CLI. Never inherited (technical/04). */
  readonly env?: Readonly<Record<string, string>>;
  /** Names in `env` whose values are secret, for the injected-secret redactor (TD-012). */
  readonly secretEnvNames?: readonly string[];
  readonly claudeCodePath?: string | null;
  /**
   * The ring reads no clock of its own (technical/01). Required rather than defaulted to
   * `Date.now`: expiry demotion in the pack depends on today's date, and a default clock is a
   * collaborator the tests cannot move.
   */
  readonly clock: { now(): IsoDateTime };
  readonly logger?: Logger;
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

/** The latest version of each artifact type, oldest type first — what a stage is shown. */
const latestArtifacts = (artifacts: readonly StoredArtifact[]): readonly StoredArtifact[] => {
  const latest = new Map<ArtifactType, StoredArtifact>();
  for (const artifact of artifacts) {
    const current = latest.get(artifact.type);
    if (current === undefined || artifact.version > current.version)
      latest.set(artifact.type, artifact);
  }
  return [...latest.values()];
};

/**
 * The text technical/07 step 2 builds its keywords from: "task text (ticket + spec)".
 *
 * Untrusted, every word of it — which is why it goes to `extractQueryTerms` and never into a
 * prompt's platform voice. A degenerate result (no keyword at all) is a fact the pack reports
 * rather than an error, and PROGRESS backlog 15 / **Q58** is the open question about what a *junk*
 * query costs: nothing rejects one, and with this planner the first junk query that costs anything
 * has arrived. The remedy needs a corpus-derived signal and a corpus that can falsify it
 * (backlog 16); it is deliberately not invented here.
 *
 * ## The title comes first, and that is the whole of WP-15f's half of this function
 *
 * Until WP-15f the first line was the ticket **key** and there was nothing else at the first agent
 * stage, so `extractQueryTerms('ACME-1')` returned `["acme"]` — one term, against technical/07:11's
 * *"task text (ticket + spec)"*. The title and the description now lead, because
 * `extractQueryTerms` keeps first-seen terms when `MAX_QUERY_TERMS` truncates and its own docblock
 * says why: *"the terms kept are the ones nearest the start of the ticket, which is where a title
 * sits"*. The comments are **not** here: they are the largest and least-signal part of a snapshot,
 * and a thread that has drifted onto something else would take the query with it.
 *
 * **The residual, measured rather than implied** (PROGRESS backlog 12): a term is split at
 * anything that is not a letter, a number or an underscore, so an invisible character inside a word
 * splits it — `extractQueryTerms('sess​ions rollback')` is `["sess", "ions", "rollback"]`. A
 * title carrying a zero-width character is therefore still retrievable by its *other* words and not
 * by that one. Nothing here edits the text to fix it; an indexer that silently rewrote a document's
 * words would be a knowledge base nobody could trust (`data-block.ts` gives the same answer).
 */
export const taskTextOf = (request: StageRunRequest): string =>
  [
    request.task.ticketSnapshot?.title ?? '',
    request.task.ticketSnapshot?.description ?? '',
    request.task.task.ticket.key,
    ...latestArtifacts(request.artifacts).map((artifact) => JSON.stringify(artifact.data)),
    request.returnFeedback ?? '',
  ]
    .join('\n')
    .slice(0, MAX_TASK_TEXT_CHARS);

const emptyRecord = (budgetTokens: number): ContextPackRecord => ({
  tier0: [],
  tier1: [],
  budget_tokens: budgetTokens,
  total_tokens: 0,
  kb_commit: null,
});

interface ResolvedPack {
  readonly record: ContextPackRecord;
  readonly prompt: PromptContextPack;
  readonly runContextPack: readonly RunContextDocument[];
}

const promptDocument = (document: ContextPackDocument) => ({
  tier: document.tier,
  path: document.path,
  workspacePath: document.workspacePath,
  reason: document.reason,
  tokens: document.tokens,
  text: document.text,
});

export const createStageRunPlanner = (options: StageRunPlannerOptions): StageRunPlanner => {
  const logger = options.logger ?? silentLogger;

  const resolvePack = async (
    request: StageRunRequest,
    stageId: string,
    budgetTokens: number,
  ): Promise<ResolvedPack> => {
    const repoPaths = await (options.headPaths?.(request.task.task.projectId) ??
      Promise.resolve([]));
    if (options.headPaths === undefined) {
      logger.debug(
        { project_id: request.task.task.projectId, run_id: request.runId },
        'no HEAD path listing for this run: a knowledge document scoped by `paths:` is recorded validated=false and not admitted',
      );
    }
    const result = await options.contextPacks.assemble({
      projectId: request.task.task.projectId,
      stage: stageId,
      taskText: taskTextOf(request),
      touchedPaths: [],
      repoPaths,
      today: options.clock.now().slice(0, 10) as IsoDate,
      knowledgeDir: request.settings.config.project?.knowledge_dir ?? '.agentic/knowledge',
      budgetTokens,
    });
    if (result.status === 'not_indexed') {
      return {
        record: emptyRecord(budgetTokens),
        prompt: { status: 'not_indexed', documents: [], budgetTokens, totalTokens: 0 },
        runContextPack: [],
      };
    }
    const { pack } = result;
    return {
      record: pack.record,
      prompt: {
        status: 'ok',
        documents: pack.documents.map(promptDocument),
        budgetTokens: pack.record.budget_tokens,
        totalTokens: pack.record.total_tokens,
      },
      runContextPack: pack.runContextPack,
    };
  };

  return {
    plan: async (request: StageRunRequest): Promise<StageRunPlan> => {
      const { stage, task, settings } = request;
      const role = stage.role ?? 'developer';
      const defaults = stageAgentDefaults(stage.id);
      const configured = settings.config.stages?.[stage.id];
      const policy = narrowCommandPolicy(DEFAULT_COMMAND_POLICY, settings.config.commands);
      const protectedPaths =
        settings.config.policies?.protected_paths ??
        PLATFORM_DEFAULT_CONFIG.policies?.protected_paths ??
        [];
      const budgetTokens =
        settings.config.project?.context_budget_tokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS;

      const pack = await resolvePack(request, stage.id, budgetTokens);
      const prompt = assemblePrompt({
        nonce: options.nonce,
        role: options.prompts[role],
        pack: pack.prompt,
        task: {
          stage: stage.id,
          attempt: request.attempt,
          ticket: task.task.ticket,
          // WP-15f: the ticket's own words, or `null` when the platform has not read it. The row
          // is the only source — nothing here fetches, because a provider call in the run's
          // critical path is what Q61 (1) rejected.
          ticketSnapshot: task.ticketSnapshot,
          artifacts: latestArtifacts(request.artifacts).map((artifact) => ({
            type: artifact.type,
            version: artifact.version,
            json: JSON.stringify(artifact.data),
          })),
          returnFeedback: request.returnFeedback,
        },
        artifactType: stage.produces,
      });

      const spec: RunSpec = {
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
        promptVersion: prompt.promptVersion,
        systemPromptAppend: prompt.systemPrompt,
        userPrompt: prompt.userPrompt,
        workspacePath: options.workspacePath(task.task.id),
        contextPack: [...pack.runContextPack],
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
        // BD-024: the plan's exceptions. The ImplementationPlan's `protected_path_changes` fills
        // these once the plan carries them; until then a protected path is never planned, which is
        // the fail-closed direction.
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
      return { spec, contextPack: pack.record };
    },
  };
};

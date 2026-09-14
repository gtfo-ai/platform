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
  CommunicationLanguage,
  ContextPackRecord,
  Id,
  IsoDate,
  IsoDateTime,
} from '@platform/contracts';
import { communicationLanguageSchema } from '@platform/contracts';
import {
  assemblePrompt,
  CONFLICT_RESOLUTION_EXTRA_ALLOW,
  DEFAULT_COMMAND_POLICY,
  DEFAULT_CONTEXT_BUDGET_TOKENS,
  DEFAULT_READ_ONLY_ALLOW,
  isPromptExcludedArtifact,
  narrowCommandPolicy,
  PLATFORM_DEFAULT_CONFIG,
  type PromptContextPack,
  type PromptNonceSource,
  type ResolvedCommandPolicy,
  type RolePromptDefinition,
  resolveRunCapUsd,
  type SkillDefinition,
  STAGE_PROMPT_FOCUS,
  skillSetVersionOf,
  stageAgentDefaults,
} from '@platform/domain';
import type { ContextPackAssembler, ContextPackDocument } from '../knowledge/context-pack.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { PlatformToolName, RunContextDocument, RunLimits, RunSpec } from '../ports/runner.js';
import { runLimitsDefaults } from '../ports/runner.js';
import { qualifiedPlatformSkill } from '../ports/workspace.js';
import { CONFLICT_RESOLUTION_STAGE } from './rebase.js';
import { REVIEW_ONLY_TEMPLATE_ID } from './review-only.js';
import type { ProjectSettings } from './settings.js';
import type { StageRunPlan, StageRunPlanner, StageRunRequest } from './stage-executor.js';
import type { StoredArtifact, StoredTask } from './store.js';
import { TICKET_LINT_STAGE, TICKET_LINT_TEMPLATE_ID } from './ticket-lint.js';

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
  /**
   * Ask-the-task (WP-31, Q72 (b)): *"read-only over **platform** data, not the repository"*.
   *
   * `get_task_context` and `kb_search`, and **not** `ask_human` — an ask is already a conversation
   * with a human, and a run that asked a question back would park the *task* in `waiting_answers`
   * on a question about an explanation nobody is blocked on. `report_progress` is absent for the
   * simpler reason that this build refuses it by name and an ask is over in one turn.
   */
  ask: ['get_task_context', 'kb_search'],
};

/**
 * Platform tools a **stage** takes away from the role that runs it (WP-25).
 *
 * The three least-privilege tables above are keyed by role, which is right for nearly everything —
 * a role's tools are its job description. A stage that runs a role for a *narrower* job is the one
 * case they cannot express, and the ticket readiness linter is one: the Product Manager may
 * `ask_human` because a refinement stage has a task somebody is watching, and a lint has **no
 * watcher and no ticket of its own**. On this build `task.question.asked` is consumed and its
 * consumer posts a comment on the task's ticket (TD-005 priority 110), so a lint run that asked a
 * question would try to write a *second* comment — against product/18's *"posts one short
 * comment"* — and would park the lint task on a question nobody can answer.
 *
 * It removes rather than adds, which is the only direction a stage may move a role's privileges: the
 * result is always a subset of {@link PLATFORM_TOOLS_BY_ROLE}, so a stage cannot hand a role a tool
 * BD-021 did not give it.
 */
export const PLATFORM_TOOLS_DENIED_BY_STAGE: Readonly<Record<string, readonly PlatformToolName[]>> =
  {
    [TICKET_LINT_STAGE]: ['ask_human'],
    /**
     * The rebase gate's conflict resolution (WP-26) runs the **developer** role on a task whose
     * merge request already exists, so `open_mr` is a tool with nothing to do and one thing to get
     * wrong: a second merge request from the same branch would be the row `findByMergeRequest`
     * answers with, which is how `mr.merged` advances a task and how a human comment opens BD-007's
     * batch window. `update_mr_description` stays — the description is where the run says what it
     * merged.
     */
    [CONFLICT_RESOLUTION_STAGE]: ['open_mr'],
  };

/**
 * Command patterns a **stage** adds to the `allow` list of the role that runs it (TD-027, the
 * ruling on Q77) — BD-025 §2's *"defaults ship **per stage**"*, which the code had only per role.
 *
 * It **adds**, which inverts the direction of {@link PLATFORM_TOOLS_DENIED_BY_STAGE} above, and
 * three rules bound the inversion. It may only add to `allow` — never an `ask` entry, never a
 * `block` removal — and it holds *patterns* rather than a replacement list, so the direction is
 * structural rather than a convention. Every entry must be a literal spelling **product/19 §3 lists
 * for that stage**: a stage layer is where a documented default is put, not where one is invented
 * (the allow-side twin of `DECLINED_BLOCK_VARIANTS`' standing rule). And it is applied *before*
 * `narrowCommandPolicy`, so a project's own `commands.allow` still drops what it does not list and
 * reports it in `ignoredAllow`.
 *
 * The only entry is the rebase gate's conflict resolution (WP-26, BD-030), whose four merge
 * spellings and their argument are {@link CONFLICT_RESOLUTION_EXTRA_ALLOW}.
 */
export const COMMAND_ALLOW_BY_STAGE: Readonly<Record<string, readonly string[]>> = {
  [CONFLICT_RESOLUTION_STAGE]: CONFLICT_RESOLUTION_EXTRA_ALLOW,
};

/**
 * Which **command baseline** a role's run starts from, before the project narrows it (BD-025).
 *
 * A third least-privilege table beside {@link TOOLS_BY_ROLE} and {@link PLATFORM_TOOLS_BY_ROLE},
 * added at WP-21's review round 2, and a **table rather than a derived rule** on purpose. The
 * obvious derivation — "a role with no `Write`/`Edit` gets the read-only list" — would also narrow
 * the **acceptance tester**, whose product/13 row is "tests/app cmds" and which installs to boot the
 * app; silently changing another role's policy inside a review round is not a narrowing anybody
 * decided. So the roles are listed, and `planner.test.ts` enumerates them.
 */
export const COMMAND_BASELINE_BY_ROLE: Readonly<Record<AgentRole, 'read_only' | 'implementation'>> =
  {
    triager: 'implementation',
    product_manager: 'implementation',
    investigator: 'implementation',
    architect: 'implementation',
    developer: 'implementation',
    reviewer: 'implementation',
    acceptance_tester: 'implementation',
    facilitator: 'implementation',
    librarian: 'implementation',
    // The one role that reads a repository nobody has reviewed yet, at first contact.
    discovery: 'read_only',
    /**
     * The ask has **no shell at all** (`TOOLS_BY_ROLE.ask` is empty), so this entry decides nothing
     * that can happen — and it is `read_only` rather than `implementation` because a table whose
     * unreachable entry is the permissive one is a table that becomes wrong the day somebody adds
     * `Bash` to the row above (standing rule 20's direction, applied to a default).
     */
    ask: 'read_only',
  };

/**
 * SDK tools per role: only the developer writes to the workspace, and two roles run a command
 * (BD-021).
 *
 * **`discovery` has `Bash`, on the read-only command baseline** (WP-21, narrowed at its review
 * round 2). {@link COMMAND_BASELINE_BY_ROLE} gives it `DEFAULT_READ_ONLY_ALLOW` — `ls`, `cat`,
 * `grep`, `rg`, `find` and `git log|diff|show|blame|status` — so the shell reads a repository and
 * writes nothing. Round 1 left it on the implementation baseline, which also allows
 * `git add|commit|fetch|rebase`, `git push origin agentic/*`, `npm ci` and `pip install -r *`; the
 * push was stopped only by a read-only run minting no git credential, which is a second mechanism
 * doing a first mechanism's job. What it gains over `Read`/`Glob`/`Grep` is the git history — the
 * commit convention R10 is about, and the activity a newcomer reads first.
 *
 * **What no run of any role can do on this build, stated because product/17 assumes otherwise.**
 * Run the project's test, lint or setup command. The **org maximum** is `DEFAULT_COMMAND_POLICY`
 * and a project may only *narrow* it (`narrowCommandPolicy`: an `allow` entry the maximum does not
 * grant is dropped and reported in `ignoredAllow`), the maximum contains no test command —
 * `npm test` is technical/12's *example* `.agentic/config.yml`, not a platform default — and
 * nothing in this build lets an operator widen the maximum. product/17 detects R1 and R6 "executed
 * in the workspace" and R2 "measured"; none of the three is possible. `READINESS_CRITERIA` says at
 * each of them what a run can establish instead, and the gap between that reading and product/17's
 * wording is `PROGRESS.md`'s discovered work rather than a sentence smoothed over here.
 *
 * **product/13's least-privilege table had no Discovery row** when this was written — the role is
 * described in § "Discovery agent (onboarding, Step 2)" and was missing from § "Tools per role".
 * The orchestrator owns that amendment; the row is `Read`/`Glob`/`Grep` plus a **read-only** shell,
 * no write, no push, no observability, no KB write, no `ask_human`.
 */
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
  // `Bash` under BD-025's command policy — see the docblock. It writes nothing: no `Edit`, no
  // `Write`, and `PLATFORM_TOOLS_BY_ROLE.discovery` carries no mutating platform tool.
  discovery: ['Read', 'Glob', 'Grep', 'Bash'],
  /**
   * **Empty, and that is the point** (WP-31, Q72 (b)). An ask explains the platform's own record;
   * it never inspects the code. No `Read`, because there is no checkout to read — an ask run is
   * given no workspace, which is also why it costs a fraction of a stage. Everything it may do is
   * in `PLATFORM_TOOLS_BY_ROLE.ask`.
   */
  ask: [],
};

/**
 * Which platform skills a role's workspace is provisioned with — WP-14a, and the third table of
 * BD-021's least privilege beside {@link PLATFORM_TOOLS_BY_ROLE} and {@link TOOLS_BY_ROLE}.
 *
 * **This table is the restriction, not the SDK option.** `Options.skills` is "a context filter, not
 * a sandbox: unlisted skills are hidden from the model's listing and rejected by the Skill tool,
 * but their files remain on disk and are reachable via Read/Bash"
 * (`@anthropic-ai/claude-agent-sdk@0.3.267`, `sdk.d.ts:2089-2098`). So what a role may use is
 * decided by what provisioning **copies** — `WorkspaceSpec.skills` — and the option is the second
 * lane, not the first.
 *
 * Two rules were applied, and both are visible in the rows:
 *
 *  1. **A skill never describes a mutation the role cannot make.** `gitlab-mr`,
 *     `file-followup-ticket`, `mr-description` and `verify-work` carry the writing half of the
 *     work, so they go to the developer — the only role with `open_mr`,
 *     `update_mr_description`, `create_followup_ticket` and a git write credential.
 *  2. **A skill goes to a role that has the tool it is about.** `kb` follows `kb_search`,
 *     `ask-human` follows `ask_human`, `retro` follows the facilitator's stage.
 *
 * Every one of the ten appears in at least one row, which
 * `test/contract/prompts/platform-skills.contract.test.ts` asserts: a skill provisioned for nobody
 * is ten files nobody reads, which is the defect PROGRESS backlog entry 24 exists to have avoided.
 *
 * **The rows follow product/13, and three mismatches with the *shipped* tables follow from that.**
 * Recorded here in full rather than smoothed over, because a docblock that named one of them would
 * read as if the other two did not exist (PROGRESS backlog **39** owns the reconciliation):
 *
 *  - **No `Bash` for the investigator or the product manager.** product/13 gives the Investigator
 *    "read-only cmds" and observability and the Product Manager Shell "–"; {@link TOOLS_BY_ROLE}
 *    gives *neither* a `Bash` tool. So `loki-logs`, `sentry-issue` and `jira-ticket` name commands
 *    those two roles cannot currently run at all.
 *  - **Neither holds `add_ticket_comment` or `create_followup_ticket`**, which `jira-ticket` names
 *    as the way to write back. The skill says "you do not [write], and here is the tool that would"
 *    — true for them, but the tool is not in their list.
 *  - The skills are handed out by **role**, not by the project's bindings, so a project with no
 *    Loki integration still gets `loki-logs` in its investigator runs.
 *
 * They are left standing rather than papered over because the fix belongs to whichever table is
 * wrong — and product/13 is the spec, so it is probably {@link TOOLS_BY_ROLE}. What is *not* left
 * to judgement is the pair of rules above: `test/contract/prompts/platform-skills.contract.test.ts`
 * enforces them for the five skills whose platform tool is unambiguous.
 */
export const SKILLS_BY_ROLE: Readonly<Record<AgentRole, readonly string[]>> = {
  triager: [],
  product_manager: ['ask-human', 'jira-ticket', 'kb'],
  investigator: ['ask-human', 'jira-ticket', 'kb', 'loki-logs', 'sentry-issue'],
  architect: ['ask-human', 'kb'],
  developer: [
    'ask-human',
    'file-followup-ticket',
    'gitlab-mr',
    'jira-ticket',
    'kb',
    'loki-logs',
    'mr-description',
    'sentry-issue',
    'verify-work',
  ],
  reviewer: ['kb'],
  acceptance_tester: ['kb'],
  facilitator: ['kb', 'retro'],
  librarian: ['kb'],
  discovery: ['kb'],
  /**
   * `kb`, because the ask holds `kb_search` and rule 2 of this table says a skill goes to a role
   * that has the tool it is about. Nothing else: every other skill describes work in a repository,
   * and an ask has no workspace for one to be copied into.
   */
  ask: ['kb'],
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
   * The shipped platform skills (`@platform/prompts`), by name.
   *
   * Required, and validated at construction against every name {@link SKILLS_BY_ROLE} uses: a
   * planner built without them would plan runs whose `promptVersion` claims a skill set the
   * workspace was never given (standing rules 18/31/55 — an absent skills directory is a refusal at
   * composition, never an empty list that looks like "no skills"). The catalogue is read for its
   * *digest* here; the bytes reach the workspace through `WorkspaceProvider.create`.
   */
  readonly skills: Readonly<Record<string, SkillDefinition>>;
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

/**
 * The platform tools this run may call: the role's list minus anything the stage takes away.
 *
 * A subtraction, never a union — see {@link PLATFORM_TOOLS_DENIED_BY_STAGE}. A stage that is not in
 * that table gets the role's list unchanged, which is every stage but one.
 */
export const platformToolsFor = (role: AgentRole, stage: string): readonly PlatformToolName[] => {
  const denied = PLATFORM_TOOLS_DENIED_BY_STAGE[stage] ?? [];
  return (PLATFORM_TOOLS_BY_ROLE[role] ?? []).filter((tool) => !denied.includes(tool));
};

/**
 * The organisation maximum this run starts from: the role's baseline plus what its stage adds.
 *
 * `read_only` keeps the shipped `ask` and `block` lists and replaces only `allow`: an entry that
 * moves out of `allow` becomes unmatched, falls to the `ask` fallback and is **denied** unattended,
 * which is the direction a narrowing has to fail in.
 *
 * The `stage` argument is required rather than optional (TD-027): a caller that forgot it would
 * silently plan a run on the role baseline, and a conflict-resolution run planned that way spends
 * its attempt on a denied merge. `ask` and `block` come through byte-identical — the layer appends
 * to `allow` and touches nothing else.
 */
export const commandBaselineFor = (role: AgentRole, stage: string): ResolvedCommandPolicy => {
  const base: ResolvedCommandPolicy =
    COMMAND_BASELINE_BY_ROLE[role] === 'read_only'
      ? { ...DEFAULT_COMMAND_POLICY, allow: DEFAULT_READ_ONLY_ALLOW }
      : DEFAULT_COMMAND_POLICY;
  const extra = COMMAND_ALLOW_BY_STAGE[stage];
  return extra === undefined ? base : { ...base, allow: [...base.allow, ...extra] };
};

/**
 * The language the project's agents write to humans in — `project.communication_language`.
 *
 * The **effective** configuration, so a project that never chose gets the platform default
 * (`auto`, BD-016: follow the ticket). It is parsed rather than cast, because this string reaches
 * the platform's own voice in layers 1–3 of the prompt and `ConfigValues` is typed from a schema
 * the *repository* wrote: a value that somehow failed the schema falls back to `auto` rather than
 * being quoted into an instruction.
 */
const languageOf = (settings: ProjectSettings): CommunicationLanguage => {
  const parsed = communicationLanguageSchema.safeParse(
    settings.config.project?.communication_language,
  );
  return parsed.success ? parsed.data : 'auto';
};

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

/**
 * The latest version of each artifact type, oldest type first — what a stage is shown.
 *
 * `AskAnswer` is filtered out here (WP-31): the reason is a property of the artifact type and is
 * written at `PROMPT_EXCLUDED_ARTIFACT_TYPES` in `@platform/domain`, beside the type itself, so this
 * is one call rather than a rule to remember. It filters **before** picking the latest, so an
 * excluded type cannot displace anything; the exclusion is asserted in both directions in
 * `planner.test.ts`.
 */
const latestArtifacts = (artifacts: readonly StoredArtifact[]): readonly StoredArtifact[] => {
  const latest = new Map<ArtifactType, StoredArtifact>();
  for (const artifact of artifacts.filter((entry) => !isPromptExcludedArtifact(entry.type))) {
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

/**
 * `runs.mode` by **template** — the producer of a run, mapped to what the run was *for*.
 *
 * A table rather than a chain of comparisons because the column's meaning is a list and a list
 * drifts when it is spelled as code (PROGRESS backlog **57**: four of technical/04's seven modes
 * fell through to `normal`, three of them with live producers, and a discovery run's own screen said
 * `normal` to a human). `RUN_MODE_BY_TEMPLATE_STAGE_MODES` below is the test's half of the same
 * question.
 *
 * **What this row closed and what it did not.** WP-25 owes `linter` (backlog 57 records the
 * obligation on this row), and `review_only` was WP-24's. `retro`, `librarian` and `discovery` are
 * still unmapped: the first two are **stages** of the ticket templates rather than templates of
 * their own, so mapping them needs a second lookup keyed by stage — a change with its own
 * consequence for every run of every finished task — and `discovery` is WP-21's template. Backlog 57
 * recommends taking those three together, and doing them here would be this work package deciding
 * what another one's column means.
 */
export const RUN_MODE_BY_TEMPLATE: Readonly<Record<string, RunSpec['mode']>> = {
  [REVIEW_ONLY_TEMPLATE_ID]: 'review_only',
  [TICKET_LINT_TEMPLATE_ID]: 'linter',
};

/**
 * What this run's workspace checks out — PROGRESS backlog **71**, Q82 (a) (WP-34).
 *
 * Two producers and one default, in order:
 *
 *  1. a **shadow** task uses the merge base the batch resolved for its ticket
 *     (`StageRunRequest.checkoutBase`), because the whole point of the comparison is that both
 *     diffs are taken against the same tree;
 *  2. every other task uses **its own branch** (`tasks.branch`), which is technical/05 §2's
 *     *"checkout of the task branch for re-entries"* and product/19 §19's *"the platform
 *     re-provisions a workspace from the branch"*;
 *  3. `null` — the default branch — for a task that has no branch yet, which is every task before
 *     its Developer stage has pushed one.
 *
 * The shadow case wins over the branch case and cannot collide with it: a shadow task never opens a
 * merge request, so `tasks.branch` stays `null` for one.
 */
const checkoutRefOf = (request: StageRunRequest): string | null =>
  request.checkoutBase ?? request.task.branch ?? null;

/**
 * `runs.mode` — technical/04's mode table, which is about the **run** and not about the task.
 *
 * `shadow` comes from `tasks.mode`, which is the shadow switch `IntegrationActionExecutor` reads and
 * which deliberately stays two-valued; everything else comes from the **template**, because that is
 * where "this run is the Code review stage alone, on a human merge request" and "this run is a lint
 * of one ticket" are expressed.
 */
const runModeFor = (task: StoredTask): RunSpec['mode'] => {
  if (task.task.mode === 'shadow') {
    return 'shadow';
  }
  return RUN_MODE_BY_TEMPLATE[task.task.template] ?? 'normal';
};

export const createStageRunPlanner = (options: StageRunPlannerOptions): StageRunPlanner => {
  const logger = options.logger ?? silentLogger;
  // At construction, not at the first run of the role that needs it: a skill the catalogue is
  // missing is missing for the deployment.
  const unknownSkills = [...new Set(Object.values(SKILLS_BY_ROLE).flat())]
    .filter((name) => options.skills[name] === undefined)
    .sort();
  if (unknownSkills.length > 0) {
    throw new Error(
      `the platform skill catalogue is missing ${unknownSkills.join(', ')}; SKILLS_BY_ROLE names skills this deployment does not ship`,
    );
  }

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
      // Role baseline, then the stage's extra `allow` patterns, then the project's narrowing — in
      // that order, so a project still narrows what the stage added (TD-027).
      const policy = narrowCommandPolicy(
        commandBaselineFor(role, stage.id),
        settings.config.commands,
      );
      const protectedPaths =
        settings.config.policies?.protected_paths ??
        PLATFORM_DEFAULT_CONFIG.policies?.protected_paths ??
        [];
      const budgetTokens =
        settings.config.project?.context_budget_tokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS;

      // Resolved rather than named: the digest below is over the bytes, so the same list must
      // produce the same entries the workspace is given. `createStageRunPlanner` already refused a
      // catalogue that cannot answer every name in the table.
      const skills = (SKILLS_BY_ROLE[role] ?? []).map(
        (name) => options.skills[name] as SkillDefinition,
      );

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
          // WP-24: the merge request a review-only task reviews, or `null` for every other task.
          // The row is the only source here too — nothing in the run's critical path fetches.
          reviewSubject: task.reviewSubject ?? null,
          artifacts: latestArtifacts(request.artifacts).map((artifact) => ({
            type: artifact.type,
            version: artifact.version,
            json: JSON.stringify(artifact.data),
          })),
          returnFeedback: request.returnFeedback,
          // A stage is not shown the audit trail (WP-31): the record blocks are the ask's, and a
          // stage that carried them would be paying context for the platform talking to itself.
          record: [],
        },
        artifactType: stage.produces,
        // The stage's narrower instruction, when it has one: platform text, typed as a closed set
        // so nothing else can reach the platform's own voice (`STAGE_PROMPT_FOCUS`).
        focus: STAGE_PROMPT_FOCUS[stage.id as keyof typeof STAGE_PROMPT_FOCUS] ?? null,
        /**
         * The language the project's humans read (WP-32, PROGRESS backlog **60**).
         *
         * `project.communication_language` has had a schema and a default since WP-01 and **no
         * reader anywhere**, so every word an agent wrote to a human was in whatever language the
         * model guessed — on a Czech team's ticket, English. This is the reader, and it is the
         * *effective* configuration rather than the repository document, so the platform default
         * (`auto`) applies to a project that never chose.
         */
        language: languageOf(settings),
        // A stage run is never an ask (WP-31). Required-and-nullable in the assembler, so this line
        // is the planner saying so rather than a key it forgot.
        ask: null,
      });

      const spec: RunSpec = {
        runId: request.runId,
        taskId: task.task.id,
        projectId: task.task.projectId,
        stage: stage.id,
        role,
        mode: runModeFor(task),
        attempt: request.attempt,
        // The human's override for this attempt first (WP-15i), then the project's stage
        // configuration, then the template's default. One attempt only: the override rides the
        // `stage.execute` payload and is never written to the project.
        model: request.overrides?.model ?? configured?.model ?? defaults.model,
        effort: request.overrides?.effort ?? configured?.effort ?? defaults.effort,
        providerMode: options.providerMode ?? 'api',
        // Two lanes, joined: the assembled prompt's version (technical/04's "hash of layers 1-3")
        // and a digest of the skill files this run's workspace was provisioned with, so an edit to
        // a `SKILL.md` that forgot to bump its declared version is visible in the audit.
        promptVersion: `${prompt.promptVersion}+${skillSetVersionOf(skills)}`,
        systemPromptAppend: prompt.systemPrompt,
        userPrompt: prompt.userPrompt,
        workspacePath: options.workspacePath(task.task.id),
        checkoutRef: checkoutRefOf(request),
        contextPack: [...pack.runContextPack],
        limits: limitsFor(settings, stage.id, role),
        tools: [...(TOOLS_BY_ROLE[role] ?? [])],
        disallowedTools: [],
        platformTools: [...platformToolsFor(role, stage.id)],
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
        // `agentic:<name>`: the plugin-qualified spelling the SDK's filter takes, and the one the
        // CLI lists once the plugin is discovered. The *restriction* is the provisioning copy
        // (`WorkspaceSpec.skills`); this is the second lane.
        skills: skills.map((skill) => qualifiedPlatformSkill(skill.name)),
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

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
 *     outside this ring's import allowance. A project's own prompt files never replace them: since
 *     WP-92 they arrive through the settings port and ride beside them as data blocks.
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
  CommandPolicy,
  CommunicationLanguage,
  ContextPackRecord,
  Id,
  IsoDate,
  IsoDateTime,
  RiskClass,
  Slug,
  VerificationMode,
} from '@platform/contracts';
import { communicationLanguageSchema } from '@platform/contracts';
import {
  type AppliedReviewChecklist,
  artifactJsonForPrompt,
  artifactShownWhole,
  assemblePrompt,
  boundReviewChecklists,
  CONFLICT_RESOLUTION_EXTRA_ALLOW,
  DEFAULT_COMMAND_POLICY,
  DEFAULT_CONTEXT_BUDGET_TOKENS,
  DEFAULT_IMPLEMENTATION_ALLOW,
  DEFAULT_READ_ONLY_ALLOW,
  DEFAULT_VERIFICATION_ALLOW,
  DISCOVERY_TEMPLATE_ID,
  ENVIRONMENT_PROMPT,
  type EnvironmentPrompt,
  HISTORY_BOOTSTRAP_TEMPLATE_ID,
  InvariantViolationError,
  isPromptExcludedArtifact,
  type PromptArtifact,
  type PromptContextPack,
  type PromptConversation,
  type PromptNonceSource,
  type PromptPreviousAttempt,
  type ResolvedCommandPolicy,
  type RolePromptDefinition,
  resolveRunCapUsd,
  reviewChecklistsFor,
  riskClassesForPaths,
  runCommandPolicy,
  type SkillDefinition,
  STAGE_PROMPT_FOCUS,
  skillSetVersionOf,
  stageAgentDefaults,
  taskBranchName,
  VERIFICATION_PROMPT,
  type VerificationPrompt,
  verificationModeOf,
  withVerificationMode,
} from '@platform/domain';
import { projectPromptsForStage } from '../config/project-prompts.js';
import { TransactionOpenError } from '../events/open-transaction.js';
import type { ContextPackAssembler, ContextPackDocument } from '../knowledge/context-pack.js';
import { NOT_SEARCHED } from '../knowledge/text-search-record.js';
import type { CiConfigLocation } from '../ports/integrations/git-provider.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type {
  PlatformToolName,
  PromptHolds,
  RunContextDocument,
  RunLimits,
  RunSpec,
} from '../ports/runner.js';
import { runLimitsDefaults } from '../ports/runner.js';
import { qualifiedPlatformSkill, unlistedProtectedPaths } from '../ports/workspace.js';
import {
  ConversationReadError,
  type ConversationReader,
  type ConversationReadSource,
} from './conversation-read.js';

import { CONFLICT_RESOLUTION_STAGE } from './rebase.js';
import { REVIEW_ONLY_TEMPLATE_ID } from './review-only.js';
import type { ProjectSettings } from './settings.js';
import { effectiveProtectedPaths, withCiConfigPath } from './settings.js';
import type { StageRunPlan, StageRunPlanner, StageRunRequest } from './stage-executor.js';
import type { StoredArtifact, StoredTask } from './store.js';
import { exceptionsOf } from './tamper.js';
import { TICKET_LINT_STAGE, TICKET_LINT_TEMPLATE_ID } from './ticket-lint.js';
import { unfinishedWorkBranchFor } from './unfinished-work.js';

/** {@link StageRunRequest.attachedFeedback} in the assembler's shape, `null` when none (WP-152). */
const attachedFeedbackFor = (
  request: StageRunRequest,
): { readonly text: string; readonly originalChars: number | null } | null => {
  const attached = request.attachedFeedback ?? null;
  return attached === null
    ? null
    : { text: attached.reason, originalChars: attached.originalChars };
};

/**
 * Which platform tools a role may call (technical/04: "a run is given the subset its role needs:
 * a read-only stage never sees `open_mr`, so a mutating action is impossible rather than merely
 * refused"). This is BD-021's least privilege expressed as a table.
 *
 * **`get_conversation` is in every row** (WP-180, TD-029 decision 11, BD-031 ruling 6: every agent
 * at every stage reads the conversation). It is a read of the run's own task, so it widens no role's
 * reach; {@link PLATFORM_TOOLS_DENIED_BY_STAGE} denies it nowhere. Production serves it since
 * WP-181 (`IMPLEMENTED_PLATFORM_TOOLS`), so every production run is given it.
 */
export const PLATFORM_TOOLS_BY_ROLE: Readonly<Record<AgentRole, readonly PlatformToolName[]>> = {
  triager: ['report_progress', 'get_task_context', 'get_conversation'],
  product_manager: [
    'ask_human',
    'report_progress',
    'get_task_context',
    'get_conversation',
    'kb_search',
  ],
  investigator: [
    'ask_human',
    'report_progress',
    'get_task_context',
    'get_conversation',
    'kb_search',
  ],
  architect: ['ask_human', 'report_progress', 'get_task_context', 'get_conversation', 'kb_search'],
  developer: [
    'ask_human',
    'notify_human',
    'report_progress',
    'get_task_context',
    'get_conversation',
    'kb_search',
    'add_ticket_comment',
    'open_mr',
    'update_mr_description',
    'create_followup_ticket',
  ],
  reviewer: ['report_progress', 'get_task_context', 'get_conversation', 'kb_search'],
  acceptance_tester: ['report_progress', 'get_task_context', 'get_conversation', 'kb_search'],
  facilitator: ['report_progress', 'get_task_context', 'get_conversation', 'kb_search'],
  librarian: ['report_progress', 'get_task_context', 'get_conversation', 'kb_search'],
  discovery: ['report_progress', 'kb_search', 'get_conversation'],
  /**
   * Ask-the-task (WP-31, Q72 (b)): *"read-only over **platform** data, not the repository"*.
   *
   * `get_task_context`, `get_conversation` (WP-180) and `kb_search`, and **not** `ask_human` — an ask is already a conversation
   * with a human, and a run that asked a question back would park the *task* in `waiting_answers`
   * on a question about an explanation nobody is blocked on. `report_progress` is absent because an
   * ask is over in one turn and the person asking is reading the answer as it streams.
   */
  ask: ['get_task_context', 'get_conversation', 'kb_search'],
  /**
   * The history bootstrap's miner (WP-35): `kb_search` and `report_progress`, and since WP-180
   * `get_conversation`, which every role is given (it answers nothing for a bootstrap ticket, whose
   * task has no merge request and no provider ticket).
   *
   * `kb_search` is what keeps it from proposing a page the vault already has — the dedupe
   * technical/07 step 2 asks for, made cheap at the source rather than left to the curator's index
   * comparison. **No `get_task_context`**: the "task" is a platform-issued bootstrap ticket with no
   * ticket behind it, so the tool would answer questions about a fiction. No `ask_human`, for
   * `discovery`'s reason — the run has no watcher and its output is a queue a human reads anyway.
   */
  historian: ['report_progress', 'kb_search', 'get_conversation'],
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
 * `narrowCommandPolicy` — which since Q97 (WP-54 review round 1) narrows only the project-command
 * class, so a project's `commands.allow` no longer drops a stage's addition; `block` removes one.
 *
 * The only entry is the rebase gate's conflict resolution (WP-26, BD-030), whose four merge
 * spellings and their argument are {@link CONFLICT_RESOLUTION_EXTRA_ALLOW}.
 */
export const COMMAND_ALLOW_BY_STAGE: Readonly<Record<string, readonly string[]>> = {
  [CONFLICT_RESOLUTION_STAGE]: CONFLICT_RESOLUTION_EXTRA_ALLOW,
};

/**
 * The three shipped command baselines a role's run can start from (BD-025 §2, Q69 (ii), WP-54).
 *
 * A baseline is the **per-role default below the organisation maximum** that BD-025 §2's *"Defaults
 * ship per stage; the organisation sets the maximum; projects can only narrow it"* describes, and
 * a project's `commands.allow` narrows it (`narrowCommandPolicy`). Each is product/19 §3's list for
 * the kind of stage the role runs:
 *
 *  - `read_only` — the read-only stages' exploration verbs (`DEFAULT_READ_ONLY_ALLOW`);
 *  - `verification` — the same, plus the project's declared commands and the lockfile installs they
 *    need (`DEFAULT_VERIFICATION_ALLOW`): product/19 §3's *"the project's test/lint commands (review
 *    stages only)"* and product/13's *"tests only"* / *"tests/app cmds"*;
 *  - `implementation` — `DEFAULT_IMPLEMENTATION_ALLOW`, which since WP-54 carries the project's
 *    declared commands as well (`PROJECT_COMMAND_ALLOW`).
 *
 * `ask` and `block` are the shipped lists in all three: a baseline chooses what is **allowed**, and
 * an entry that is not allowed falls to `ask`, which an unattended run denies.
 */
export type CommandBaseline = 'read_only' | 'verification' | 'implementation';

const BASELINE_ALLOW: Readonly<Record<CommandBaseline, readonly string[]>> = {
  read_only: DEFAULT_READ_ONLY_ALLOW,
  verification: DEFAULT_VERIFICATION_ALLOW,
  implementation: DEFAULT_IMPLEMENTATION_ALLOW,
};

/**
 * Which **command baseline** a role's run starts from, before the project narrows it (BD-025).
 *
 * A third least-privilege table beside {@link TOOLS_BY_ROLE} and {@link PLATFORM_TOOLS_BY_ROLE},
 * added at WP-21's review round 2 and made **per role** by WP-54 (Q69 (ii)): before it the table
 * chose between two lists, neither of which named a single project command, so no run of any role
 * could execute one (PROGRESS backlog 49). It is a **table rather than a derived rule** on purpose —
 * "a role with no `Write` gets the read-only list" would give the acceptance tester, whose product/13
 * row is "tests/app cmds", no test command at all — and `planner.test.ts` enumerates it against
 * product/13's Shell column for every member of the role schema.
 *
 * **An entry for a role with no `Bash` decides nothing that can happen**, so every such entry is
 * `read_only`: a table whose unreachable entry is the permissive one becomes wrong the day somebody
 * adds `Bash` to that role's row (standing rule 20's direction, applied to a default).
 */
export const COMMAND_BASELINE_BY_ROLE: Readonly<Record<AgentRole, CommandBaseline>> = {
  // No SDK tool at all.
  triager: 'read_only',
  // product/13: Shell "–"; no `Bash`.
  product_manager: 'read_only',
  // product/13: "read-only cmds" — `Bash` since WP-54 (PROGRESS backlog 39, docs win).
  investigator: 'read_only',
  // product/13: "read-only cmds" — `Bash` since WP-54, for the same reason.
  architect: 'read_only',
  // product/13: "✔ (allow-listed)".
  developer: 'implementation',
  // product/13: "tests only" — `Bash` since WP-54.
  reviewer: 'verification',
  // product/13: "tests/app cmds". Narrowed from `implementation` at WP-54: the role has no git
  // write in product/13 (Git push "–"), and `implementation` let it `git add|commit|rebase` and
  // push to `agentic/*` — stopped only by a read-only run minting no git credential.
  acceptance_tester: 'verification',
  // product/13: Retrospective Shell "–"; no `Bash`.
  facilitator: 'read_only',
  // product/13: Shell "–"; `Edit`/`Write` inside the knowledge directory, no `Bash`.
  librarian: 'read_only',
  /**
   * `verification` since WP-54, so product/17's R1, R2 and R6 are detected the way product/17 and
   * product/19 §5 word them — *"discovery finds a test command and runs it in the workspace"* —
   * rather than by reading CI configuration. It was `read_only` because nothing else could run a
   * project command either; the role still has no `Write`, no `Edit`, no mutating platform tool and
   * no git credential (`runIsReadOnly`), so what the shell produces cannot be kept.
   */
  discovery: 'verification',
  // No shell at all (`TOOLS_BY_ROLE.ask` is empty).
  ask: 'read_only',
  // No shell at all (`TOOLS_BY_ROLE.historian` is empty).
  historian: 'read_only',
};

/**
 * Command patterns a **platform skill** brings with it — the read verbs its own recipes use
 * (WP-54, PROGRESS backlog 39).
 *
 * product/13 gives the investigator and the developer *observability*, and `SKILLS_BY_ROLE` hands
 * them `loki-logs` and `sentry-issue`, whose whole content is `logcli` and `sentry-cli` recipes. No
 * baseline names either binary, so until this table a role holding the skill and `Bash` still had
 * every recipe denied. The grant follows the **skill**, which follows the **binding** (a project
 * with no Loki binding provisions no `loki-logs`, {@link PROVIDER_SKILLS}), so a project that has no
 * Loki grants no `logcli` either.
 *
 * Every entry is a **read** that a recipe in the skill's own `SKILL.md` spells, and the contract
 * test `test/contract/prompts/platform-skills.contract.test.ts` runs every recipe line of every
 * shell skill through the policy of every role that holds it. It adds to `allow` only, before the
 * project narrows, like {@link COMMAND_ALLOW_BY_STAGE}. What bounds these binaries beyond the name
 * is the run's egress allow-list, which names the model host and the git host and nothing else
 * (`packages/infrastructure/src/workspace/spec.ts`), and a credential no run is given.
 */
export const COMMAND_ALLOW_BY_SKILL: Readonly<Record<string, readonly string[]>> = {
  'loki-logs': ['logcli query *'],
  'sentry-issue': [
    'sentry-cli issues list *',
    'sentry-cli events list *',
    'sentry-cli issues --help',
  ],
  'jira-ticket': ['acli jira workitem view *', 'jira issue view *', 'jira issue list *'],
  'gitlab-mr': [
    'glab mr view *',
    'glab mr diff *',
    'glab mr note list *',
    'glab ci status',
    'glab ci trace *',
  ],
};

/**
 * The platform skills that describe a **provider** — provisioned only when the project has a
 * binding whose provider's `AgentTooling.skill` names it (WP-54, PROGRESS backlog 40).
 *
 * Before WP-54 a skill was provisioned by role alone, so an investigator run of a project with no
 * Loki binding was handed `loki-logs` — recipes for a system the project does not have — and
 * `AgentTooling.skill` was read by nothing but a contract test. The set is written here rather
 * than read off the registry because this ring cannot import the registrations; the contract test
 * holds it equal, in both directions, to the union of the shipped providers' `AgentTooling.skill`.
 */
export const PROVIDER_SKILLS: readonly string[] = [
  'gitlab-mr',
  'jira-ticket',
  'loki-logs',
  'sentry-issue',
];

/**
 * The skills a run of `role` is provisioned with, given the provider skills its project's bindings
 * name: the role's row, minus every provider skill no binding names.
 *
 * A subtraction from {@link SKILLS_BY_ROLE}, never a union — a binding cannot hand a role a skill
 * the role's row does not list.
 */
export const skillsFor = (role: AgentRole, boundSkills: readonly string[]): readonly string[] =>
  (SKILLS_BY_ROLE[role] ?? []).filter(
    (name) => !PROVIDER_SKILLS.includes(name) || boundSkills.includes(name),
  );

/**
 * SDK tools per role: only the developer writes to the workspace, and six roles run a command
 * (BD-021).
 *
 * **`Bash` follows product/13's Shell column, for every role** (WP-54, PROGRESS backlog 39: the
 * docs win). The investigator and the architect ("read-only cmds") and the reviewer ("tests only")
 * had no `Bash` until WP-54 while product/13 gave them one; `planner.test.ts` now enumerates every
 * member of the role schema against a transcription of that column, so the two tables cannot
 * disagree again without a test failing. What each shell may run is the role's command baseline —
 * {@link COMMAND_BASELINE_BY_ROLE} — narrowed by the project, and what it can keep is decided here:
 * only the developer and the librarian have `Edit`/`Write`, and a run with neither mints no git
 * credential (`runIsReadOnly`).
 *
 * **`Skill` is in every row whose {@link SKILLS_BY_ROLE} row is not empty, and in no other** (WP-83,
 * PROGRESS backlog 149). The SDK's `tools` option is the run's *base set*, and it removes every
 * built-in it does not name — measured against the pinned CLI (`claude` 2.1.267): the `system`/
 * `init` message lists `tools: []` for an empty row while `skills` still lists `agentic:kb`, so
 * until this change every platform skill was listed to runs that could not invoke one, and the ask
 * and the history miner, which hold no file tool, could not even read theirs. `Skill` reads only
 * the plugin directory the provisioning wrote, so it does not give the ask or the miner a checkout
 * (`TOOLS_THAT_NEED_NO_CHECKOUT` in `@platform/infrastructure`). It is not an escalation: the CLI
 * refuses a skill the run's `skills` list does not name, and the runner always sends that list,
 * empty included (`options.ts` has the three measured cases). The triager holds no skill and so no
 * `Skill`; `planner.test.ts` holds the two tables together.
 *
 * **`discovery` has `Bash` on the `verification` baseline** (WP-21, widened at WP-54): the read
 * verbs — `ls`, `cat`, `grep`, `rg`, `find`, `git log|diff|show|blame|status` — plus the project's
 * declared commands and the lockfile installs, so product/17's R1, R2 and R6 are detected by running
 * the project's own commands, as product/17 words them. It writes nothing it can keep: no `Edit`,
 * no `Write`, no mutating platform tool, no git credential.
 *
 * **product/13's least-privilege table had no Discovery row** when WP-21 wrote the role; the
 * orchestrator added one naming the read-only list, and WP-54's widening needs that row amended
 * (named in the WP-54 notes in `PROGRESS.md`).
 */
export const TOOLS_BY_ROLE: Readonly<Record<AgentRole, readonly string[]>> = {
  triager: [],
  product_manager: ['Read', 'Glob', 'Grep', 'Skill'],
  investigator: ['Read', 'Glob', 'Grep', 'Bash', 'Skill'],
  architect: ['Read', 'Glob', 'Grep', 'Bash', 'Skill'],
  developer: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'Skill'],
  reviewer: ['Read', 'Glob', 'Grep', 'Bash', 'Skill'],
  acceptance_tester: ['Read', 'Glob', 'Grep', 'Bash', 'Skill'],
  facilitator: ['Read', 'Glob', 'Grep', 'Skill'],
  librarian: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Skill'],
  // `Bash` under BD-025's command policy — see the docblock. It keeps nothing: no `Edit`, no
  // `Write`, and `PLATFORM_TOOLS_BY_ROLE.discovery` carries no mutating platform tool.
  discovery: ['Read', 'Glob', 'Grep', 'Bash', 'Skill'],
  /**
   * **No file tool and no shell, and that is the point** (WP-31, Q72 (b)). An ask explains the
   * platform's own record; it never inspects the code. Everything it may do is in
   * `PLATFORM_TOOLS_BY_ROLE.ask`, plus `Skill` for its one skill (`kb`, WP-83 — see above).
   *
   * **An ask run is given a container and no checkout** (WP-74, PROGRESS backlog **82**). Because
   * this row holds no file tool and no shell, `buildWorkspaceSpec` gives the run `repo: null`
   * (`runNeedsCheckout`, `packages/infrastructure/src/workspace/spec.ts`): no mirror update, no
   * clone, no `repo-cache` mount, no git host on its egress list and no git credential asked for.
   * It **keeps** the container, the network, the volume, the egress sidecar and the control socket,
   * because the CLI runs inside that container and a run has no other transport — running it in
   * the platform's own process is ruled out by TD-021's decision body, not only by its WP-15g
   * amendment. The predicate reads the **tools**, so the day this row gains `Read` the ask gets
   * its checkout back without a line changing here.
   *
   * So product/18's *"cheaper than reading transcripts"* is **partly** true: an ask no longer pays
   * a mirror fetch and a clone, and it still pays a network, a volume, a sidecar and three helper
   * containers (`prep-`, `skills-`, `egresscfg-`). What one provision costs in seconds has not been
   * measured. This docblock said *"an ask run is given no workspace"* until WP-53, which was false;
   * WP-53's correction said the opposite, which WP-74 made conditional.
   */
  ask: ['Skill'],
  /**
   * **No file tool, like the ask's, and for a sharper reason** (WP-35); `Skill` only, for `kb`
   * (WP-83). Everything a mining run reads is
   * already in its prompt — `tasks.history_sample` is the batch the platform collected, bounded and
   * redacted at the write — so a `Read` would only let it wander into a checkout whose contents
   * have nothing to do with merge requests merged six months ago. What it must not do is *widen its
   * own evidence*: a proposal is accepted only when every citation resolves into the sample
   * (`curateHistoryFindings`), so a tool that could find a fourth source would produce citations the
   * platform then refuses.
   */
  historian: ['Skill'],
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
 * Three rules were applied, and all three are visible in the rows:
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
 *  3. **A skill whose recipes are shell commands goes only to a role holding `Bash`** (WP-54,
 *     PROGRESS backlog 39) — and the recipes it names are allowed by that role's policy
 *     ({@link COMMAND_ALLOW_BY_SKILL}). `jira-ticket`, `gitlab-mr`, `loki-logs`, `sentry-issue` and
 *     `verify-work` are those skills; the contract test reads which ones they are off the files'
 *     own `bash` fences rather than off this sentence.
 *
 * **Two things decide a run's skills, not one** (WP-54, PROGRESS backlog 40): this row, and the
 * project's bindings — a {@link PROVIDER_SKILLS provider skill} is provisioned only when a binding's
 * `AgentTooling.skill` names it ({@link skillsFor}). The row is the ceiling; a binding never adds.
 *
 * **What WP-54 changed in the rows, and why.** The product manager lost `jira-ticket`: product/13
 * gives it no shell, and the skill is `acli`/`jira` recipes. The investigator kept `loki-logs`,
 * `sentry-issue` and `jira-ticket` and gained the `Bash` they need. What is still true and stated:
 * neither the investigator nor the product manager holds `add_ticket_comment` or
 * `create_followup_ticket`, which `jira-ticket` names as the way to write back — the skill says so
 * itself (*"when your tool list has them; most stages do not"*).
 */
export const SKILLS_BY_ROLE: Readonly<Record<AgentRole, readonly string[]>> = {
  triager: [],
  product_manager: ['ask-human', 'kb'],
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
   * that has the tool it is about. Nothing else: every other skill describes work in a repository.
   *
   * **It reaches the run although the ask has no checkout** (WP-74, PROGRESS backlog **82**). A
   * skill is written under the run's working directory
   * (`/work/repo/.agentic-run/plugins/agentic/skills/<name>/SKILL.md`), and a run with no checkout
   * still has a container, a workspace volume and that directory — `#prepare` makes it empty
   * rather than the clone making it full — so the `skills-<run-id>` helper still runs and
   * `agentic:kb` is still there. The old wording, *"an ask has no workspace for one to be copied
   * into"*, was false twice over and was corrected at WP-53; the coupling it hid — removing the
   * ask's *workspace* would have removed its only documented tool — is why WP-74 withheld the
   * checkout and never the container.
   */
  ask: ['kb'],
  /** `kb`, because the miner holds `kb_search` and rule 2 of this table says the skill follows the tool. */
  historian: ['kb'],
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
   * The platform tools this **build** performs (PROGRESS backlog 476) — the composition root's
   * answer, because the implementations are its (`IMPLEMENTED_PLATFORM_TOOLS` in `apps/server`).
   *
   * A run is registered with the role's tools **intersected** with these, so a tool that would
   * refuse by name is absent from the run rather than offered and refused: on Autix every stage was
   * offered `report_progress` and `ask_human`, called them, and read a paragraph of internal jargon
   * back. Absent means every tool in the role's row, which is what the harness and the unit tests
   * compose (their tool ports answer every name). A skill that exists to drive a hidden tool is
   * withheld with it ({@link SKILL_REQUIRES_PLATFORM_TOOL}).
   */
  readonly availablePlatformTools?: readonly PlatformToolName[];
  /**
   * The shipped role prompts (`@platform/prompts`). Required: a planner with no prompts is the
   * placeholder this work package replaced.
   *
   * A project's own prompt files (`stages.<id>.prompt`, `prompt_append`, `.agentic/prompts/<stage>.md`)
   * **never replace** these (WP-92): they arrive through `ProjectSettings.repositoryPrompts` and reach
   * the model as `project_prompt` data blocks beside the role prompt (`projectPromptsForStage`).
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
   * The {@link PROVIDER_SKILLS provider skills} this project's bindings name — every binding's
   * provider, looked up in the registry, and its `AgentTooling.skill` (WP-54, PROGRESS backlog 40).
   *
   * **Required**: an absent collaborator here would either provision every provider skill (the
   * defect) or none (a silent narrowing nobody decided), and standing rule 31 says a collaborator a
   * composition root may omit is one production omits. Read between the executor's two
   * transactions like the pack's queries.
   */
  readonly boundSkills: (projectId: Id) => Promise<readonly string[]>;
  /**
   * Where the data-block nonce comes from. **Required, never defaulted** — a default would make the
   * marker predictable, which is the one property the delimiter contract rests on (standing rule
   * 31: an optional security dependency is an absent one).
   */
  readonly nonce: PromptNonceSource;
  /** WP-16's assembler. Required; see the module docblock. */
  readonly contextPacks: ContextPackAssembler;
  /**
   * The paths at the **indexed** commit that technical/07 step 3's validate-on-read resolves
   * `paths:` globs against — a full listing, or anything that answers as one does.
   *
   * **Required since WP-58** (PROGRESS backlog 170), and its production source is the index
   * itself: from the tracked set the vault read produced at the commit it indexed (WP-18a), the
   * index write keeps one **witness** per vault glob (`pathWitnesses`, backlog 175) in
   * `kb_index_state.path_witnesses` (migration 0042), and `apps/server` composes this as
   * `KnowledgeStore.readPathWitnesses`. Validation over the witnesses equals validation over the
   * listing (a property in `globs.test.ts`); the row is bounded by the vault's globs, not the
   * repository, and a run pays one small row read rather than a second vault listing. It describes
   * the commit the pack's documents came from, which a fresh listing of the head would not.
   *
   * `null` is "no listing stored" — a project indexed before 0042 and not rebuilt since — and is
   * **not** read as `[]`: the pack is then built with no listing, every `paths:`-scoped page is
   * recorded `validated: false` exactly as before this work package, and the planner says so at
   * `debug`, once per run. Until WP-58 that was the state of **every** run, because nothing
   * supplied this collaborator: the record has been visible in `run_context_pack` since WP-57.
   */
  readonly headPaths: (projectId: Id) => Promise<readonly string[] | null>;
  /**
   * **Where the project's provider says its CI configuration lives** (WP-147, backlog 442) — the
   * git binding's `repositorySettings().ciConfig` (GitLab's `ci_config_path`), or `null` for a
   * project with no git binding.
   *
   * The write-time path guard (BD-024 §2) protects the effective `protected_paths` **plus** this
   * path when it is a repository path the list does not name ({@link withCiConfigPath}, the CI
   * gate's own expression): GoParking's `deploy/.gitlab-ci.yml` is the file GitLab runs, and the
   * default list names only `.gitlab-ci.yml`. It is a platform default the project cannot narrow
   * away — added after the project's list replaced the default one. An `external` location (another
   * project's file, a URL) and an `unknown` one add nothing, and the planner says so in its log;
   * the CI gate's tamper check is then the only check.
   *
   * **Required** (standing rule 31): an absent collaborator would be a guard that silently protects
   * less. A provider refusal **throws** (the production reader's `CiConfigLocationUnavailableError`,
   * WP-147 review round 1) and the plan fails with it, so the `stage.execute` job is retried rather
   * than a run started without the path. Read between the executor's two transactions, like the
   * pack's queries.
   */
  readonly ciConfigLocation: (projectId: Id, taskId: Id) => Promise<CiConfigLocation | null>;
  /**
   * **The conversation** — the merge request's discussions and the ticket's comments, redacted and
   * bounded (WP-180, TD-029 decision 11; `createConversationReader`), which every agent stage's
   * prompt carries as `conversation` data blocks. `null` is a task with neither source: no block.
   *
   * **Required** (standing rule 31): an absent reader would be every run silently without the
   * conversation. Read between the executor's two transactions, like the pack's queries. A read
   * that **fails** is not the plan's failure (ruling (b), rule 20): the run proceeds without the
   * block, and the planner logs a named `warn`. `TransactionOpenError` is rethrown, because that is
   * a moved call rather than a provider being down.
   */
  readonly readConversation: ConversationReader;
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
export const platformToolsFor = (
  role: AgentRole,
  stage: string,
  available?: readonly PlatformToolName[],
): readonly PlatformToolName[] => {
  const denied = PLATFORM_TOOLS_DENIED_BY_STAGE[stage] ?? [];
  return (PLATFORM_TOOLS_BY_ROLE[role] ?? []).filter(
    (tool) => !denied.includes(tool) && (available === undefined || available.includes(tool)),
  );
};

/**
 * The skills whose whole job is one platform tool — withheld from a run that is not given the tool
 * (PROGRESS backlog 476), for the reason `SKILLS_BY_ROLE`'s rule 2 gives: a skill goes to a role
 * that has the tool it is about. `test/contract/prompts/platform-skills.contract.test.ts` holds the
 * role table to the same pairs.
 */
export const SKILL_REQUIRES_PLATFORM_TOOL: Readonly<Record<string, PlatformToolName>> = {
  'ask-human': 'ask_human',
  kb: 'kb_search',
  'gitlab-mr': 'open_mr',
  'mr-description': 'update_mr_description',
  'file-followup-ticket': 'create_followup_ticket',
};

/** {@link skillsFor}, minus every skill whose tool this run is not given. */
export const skillsForTools = (
  names: readonly string[],
  tools: readonly PlatformToolName[],
): readonly string[] =>
  names.filter((name) => {
    const tool = SKILL_REQUIRES_PLATFORM_TOOL[name];
    return tool === undefined || tools.includes(tool);
  });

/**
 * Which artifact a role's stage exists to carry out — its **primary input**, cut at
 * `MAX_PRIMARY_ARTIFACT_CHARS` rather than `MAX_ARTIFACT_CHARS` (PROGRESS backlog 474). The
 * Developer executes the plan, so a cut there is a cut in the work order; the Architect designs
 * from the specification or the root-cause analysis. Every other artifact keeps the ordinary cap.
 */
export const PRIMARY_ARTIFACT_BY_ROLE: Readonly<
  Partial<Record<AgentRole, readonly ArtifactType[]>>
> = {
  developer: ['ImplementationPlan'],
  architect: ['RefinedSpec', 'RootCauseAnalysis'],
};

/**
 * The platform's statement of what the run's shell can execute (`ENVIRONMENT_PROMPT`, PROGRESS
 * backlog 475), by the project's verification mode — `null` for a role with no `Bash`, for
 * {@link verificationPromptFor}'s reason: a role that runs nothing would read it as noise.
 */
export const environmentPromptFor = (
  role: AgentRole,
  mode: VerificationMode,
): EnvironmentPrompt | null =>
  (TOOLS_BY_ROLE[role] ?? []).includes('Bash') ? ENVIRONMENT_PROMPT[mode] : null;

/** The SDK tools that let a run read the repository checkout it was given. */
const CHECKOUT_TOOLS: readonly string[] = ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write'];

/**
 * The maximum this run starts from, before the project narrows it: the role's baseline, plus what
 * its stage adds, plus what the skills it is provisioned with add.
 *
 * Every baseline keeps the shipped `ask` and `block` lists and chooses only `allow`: an entry that
 * is not allowed is unmatched, falls to the `ask` fallback and is **denied** unattended, which is
 * the direction a narrowing has to fail in.
 *
 * `stage` and `skills` are required rather than optional (TD-027): a caller that forgot the stage
 * would silently plan a conflict-resolution run on the role baseline and spend its attempt on a
 * denied merge, and one that forgot the skills would plan an investigator whose `logcli` recipes
 * are all denied. Both layers append to `allow` and touch nothing else, so `ask` and `block` come
 * through byte-identical.
 */
export const commandBaselineFor = (
  role: AgentRole,
  stage: string,
  skills: readonly string[],
): ResolvedCommandPolicy => {
  const extra = [
    ...(COMMAND_ALLOW_BY_STAGE[stage] ?? []),
    ...skills.flatMap((name) => COMMAND_ALLOW_BY_SKILL[name] ?? []),
  ];
  const allow = BASELINE_ALLOW[COMMAND_BASELINE_BY_ROLE[role] ?? 'read_only'];
  return { ...DEFAULT_COMMAND_POLICY, allow: [...new Set([...allow, ...extra])] };
};

/**
 * The platform's verification instruction for a run of `role` in a project whose verification mode
 * is `mode` (BD-025's 2026-10-05 amendment) — `null` for a `local` project, and for a role whose
 * tool set has no `Bash`: a role with no shell cannot run a suite, and a sentence telling it not to
 * is noise in its prompt. Discovery gets its own instruction, because its brief is the one that
 * measures readiness by running (product/17 R1, R2, R6).
 */
export const verificationPromptFor = (
  role: AgentRole,
  mode: VerificationMode,
): VerificationPrompt | null => {
  if (mode === 'local' || !(TOOLS_BY_ROLE[role] ?? []).includes('Bash')) {
    return null;
  }
  return role === 'discovery' ? VERIFICATION_PROMPT.discovery : VERIFICATION_PROMPT.ci;
};

/**
 * The widest policy any run of this build can start from: the implementation baseline plus every
 * stage's and every skill's additions, under the project's verification mode. What a project's
 * `allow` entry is judged against when the question is "will **any** run be granted this?"
 * ({@link ignoredProjectAllow}).
 */
const widestShippedPolicy = (verification: VerificationMode): ResolvedCommandPolicy =>
  withVerificationMode(
    {
      ...DEFAULT_COMMAND_POLICY,
      allow: [
        ...new Set([
          ...BASELINE_ALLOW.implementation,
          ...Object.values(COMMAND_ALLOW_BY_STAGE).flat(),
          ...Object.values(COMMAND_ALLOW_BY_SKILL).flat(),
        ]),
      ],
    },
    verification,
  );

/**
 * The project's declared `allow` entries that **no** run of **any** role would be granted — the
 * effective-configuration DTO's `ignored_allow_commands` (WP-54, PROGRESS backlog 49).
 *
 * A project that writes `commands.allow: ["curl https://example.test"]` has asked for something the
 * platform will drop for every run, and until WP-54 the drop was silent: `ignoredAllow` had no
 * reader outside its own unit tests. An entry granted to *some* role is not listed here — the
 * investigator not getting `npm test` is the read-only baseline working, not a declaration being
 * ignored — and the per-run answer, which is role-specific, is the planner's log line.
 */
export const ignoredProjectAllow = (
  commands: CommandPolicy | undefined,
  /**
   * The organisation's `commands` (backlog 146, WP-63): an entry the organisation maximum does not
   * grant is ignored for every role, so it is judged against the widest policy **after** the
   * intersection — the same order a run's policy is built in.
   */
  organisation?: CommandPolicy,
  /** The repository file's lists, which narrow again after the settings' (WP-63). */
  repository?: CommandPolicy,
  /**
   * The project's effective verification mode: under `ci` every project command is blocked for
   * every role, so a declared `npm test` is granted to none and is listed (BD-025's 2026-10-05
   * amendment).
   */
  verification: VerificationMode = 'local',
): readonly string[] =>
  runCommandPolicy(widestShippedPolicy(verification), organisation, commands, repository)
    .ignoredAllow;

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
 * The latest version of each artifact type, oldest type first — what a stage is shown, before
 * {@link artifactsShownTo} takes out the verdicts a returned stage was not sent back for (WP-83).
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
 * The artifact types a stage **returns** a task by: `stageVerdict` maps `request_changes` only for
 * these two (`verdicts.ts`), so they are the only artifacts that can be the cause of a return.
 */
const VERDICT_ARTIFACT_TYPES: readonly ArtifactType[] = ['ReviewVerdict', 'AcceptanceVerdict'];

/**
 * **What a stage is shown of the task's artifacts** — {@link latestArtifacts}, except that a stage
 * the task was **returned** to is shown only the verdict that caused the return (WP-83, the ruling
 * on PROGRESS backlog 159's stale-artifact half).
 *
 * `latestArtifacts` picks by type and version, not by the return that caused this attempt, so
 * before this a review return followed by a CI return served the third implementation run the
 * review's `request_changes` findings — which the second run was sent to fix — beside a feedback
 * block about a failing pipeline, with nothing to say which of the two it was there for. Now:
 *
 *  - **a return some verdict caused** (`returnCause`: the returning attempt's own
 *    `ReviewVerdict`/`AcceptanceVerdict`, read by link in `lastReturnReason`) keeps exactly that
 *    version, whose findings the `return_feedback` block already carries (WP-55) — the artifact
 *    block adds what the block does not: each finding's `suggestion`;
 *  - **a return no verdict caused** — a gate's, a human's, the review window's threads — keeps no
 *    verdict at all: the `return_feedback` block is the cause, and an earlier verdict was answered
 *    by an earlier attempt;
 *  - **a first or forward entry** (no `returnFeedback`) is unchanged: a re-review still sees the
 *    verdict it wrote last time, which is not a return and not this ruling's question.
 *
 * Every other artifact type (the spec, the plan, the notes) is untouched: they describe the work,
 * not a complaint about it. It filters **before** anything reads the list, so the prompt, the
 * retrieval query and the touched paths all see the same set.
 */
export const artifactsShownTo = (request: StageRunRequest): readonly StoredArtifact[] => {
  const latest = latestArtifacts(request.artifacts);
  if (request.returnFeedback === null) {
    return latest;
  }
  const cause = request.returnCause ?? null;
  return latest.filter(
    (artifact) =>
      !VERDICT_ARTIFACT_TYPES.includes(artifact.type) ||
      (cause !== null && artifact.type === cause.type && artifact.version === cause.version),
  );
};

/**
 * The text technical/07 step 2 builds its keywords from: "task text (ticket + spec)".
 *
 * Untrusted, every word of it — which is why it goes to `extractQueryTerms` and never into a
 * prompt's platform voice. A degenerate result (no keyword at all) is a fact the pack reports
 * rather than an error. What a *junk* query costs was PROGRESS backlog 15 / **Q58**; since WP-58 the
 * store drops a keyword significantly more than half the project's documents contain (`term-statistics.ts` in
 * `@platform/domain`) — which narrows that class and, measured on the fixture vault's negative
 * corpus, does not close it (`PROGRESS.md`, WP-58).
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
 * **Invisible characters inside a word** (PROGRESS backlog 12, closed by WP-58): a term is split
 * at anything that is not a letter, a number or an underscore, so a zero-width character used to cut
 * a title's word in two — measured, `sess` + `U+200B` + `ions rollback` extracted to
 * `["sess", "ions", "rollback"]`. `extractQueryTerms` now deletes `U+200B`, `U+FEFF`, `U+2060` and
 * `U+00AD` before it splits, and the indexer deletes the same four, so both halves of the match see
 * the word a human sees; the count is reported rather than absorbed (`queryKeywords`). The text
 * this function returns is not edited — the deletion happens where the text becomes terms.
 */
export const taskTextOf = (request: StageRunRequest): string =>
  [
    request.task.ticketSnapshot?.title ?? '',
    request.task.ticketSnapshot?.description ?? '',
    request.task.task.ticket.key,
    ...artifactsShownTo(request).map((artifact) => JSON.stringify(artifact.data)),
    request.returnFeedback ?? '',
    // WP-152: the gate's failure a person attached was the return feedback before it was kept apart.
    request.attachedFeedback?.reason ?? '',
  ]
    .join('\n')
    .slice(0, MAX_TASK_TEXT_CHARS);

/** Where a run's touched paths came from — logged per run, so "none" is said rather than implied. */
export type TouchedPathsSource =
  | 'implementation_plan'
  | 'review_verdict'
  | 'both'
  | 'review_subject'
  | 'none';

/** More paths than this in one plan is a plan that names a tree, not a change; the rest are cut. */
export const MAX_TOUCHED_PATHS = 200;

/**
 * The paths a run is known to touch — technical/07 step 1's *"touched paths (from plan/diff when
 * available)"* (WP-58, PROGRESS backlog 170).
 *
 * Two producers, both artifacts the task already carries, read from what the stage is shown
 * ({@link artifactsShownTo} — the latest version of each, and on a return only the verdict that
 * caused it, WP-83):
 *
 *  - **`ImplementationPlan`** — `files_to_change[].path` and `protected_path_changes[].path`: what
 *    the Architect said the change touches. Every stage from `implementation` on has one.
 *  - **`ReviewVerdict`** — `findings[].file`: what a reviewer pointed at, which is the "diff" half
 *    for a stage the task was **returned** to.
 *
 * **A review of a merge request the platform read** (`tasks.review_subject` — review-only mode, and
 * the shadow comparison's review of a human merge request) reads **that merge request's files**
 * instead, `files[].path` — already a structured field, so nothing is parsed out of a diff (WP-73,
 * PROGRESS backlog 174). It is the precedence {@link reviewChecklistsOf} uses, for the same reason:
 * the run reviews that change, not the plan. The paths are provider text, compared only with
 * `paths:` globs like the model output below; a list the provider window cut (`files.length <
 * file_count`) under-reports rather than guesses.
 *
 * **Stages with none, named rather than defaulted:** `intake`, `refinement`, `investigation`,
 * `architecture` on its first run, `ticket_lint`, `discovery` and the history bootstrap, so their
 * path match is empty and the source is logged as `none`.
 *
 * The artifact data is **model output** (already redacted at the write). It is only ever compared
 * with a document's `paths:` globs by `matchingRepoPaths`, which reads it as a string and nothing
 * else, so nothing here can be steered by it beyond which page scores 1.0.
 */
export const touchedPathsOf = (
  request: StageRunRequest,
): { readonly paths: readonly string[]; readonly source: TouchedPathsSource } => {
  const subject = request.task.reviewSubject ?? null;
  if (subject !== null) {
    const fromSubject = subject.files.map((file) => file.path).filter((path) => path !== '');
    return {
      paths: [...new Set(fromSubject)].slice(0, MAX_TOUCHED_PATHS),
      source: fromSubject.length > 0 ? 'review_subject' : 'none',
    };
  }
  const latest = artifactsShownTo(request);
  const fromPlan: string[] = [];
  const fromReview: string[] = [];
  for (const artifact of latest) {
    const data = artifact.data as Record<string, unknown> | null;
    if (data === null || typeof data !== 'object') continue;
    if (artifact.type === 'ImplementationPlan') {
      for (const key of ['files_to_change', 'protected_path_changes']) {
        const entries = data[key];
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
          const path = (entry as { path?: unknown } | null)?.path;
          if (typeof path === 'string' && path !== '') fromPlan.push(path);
        }
      }
    }
    if (artifact.type === 'ReviewVerdict' && Array.isArray(data.findings)) {
      for (const finding of data.findings) {
        const file = (finding as { file?: unknown } | null)?.file;
        if (typeof file === 'string' && file !== '') fromReview.push(file);
      }
    }
  }
  const source: TouchedPathsSource =
    fromPlan.length > 0 && fromReview.length > 0
      ? 'both'
      : fromPlan.length > 0
        ? 'implementation_plan'
        : fromReview.length > 0
          ? 'review_verdict'
          : 'none';
  return { paths: [...new Set([...fromPlan, ...fromReview])].slice(0, MAX_TOUCHED_PATHS), source };
};

/** Where a Reviewer run's risk classes were read from — logged per run, so "none" is said. */
export type ReviewClassSource =
  | 'review_subject'
  | 'implementation_plan'
  | 'merge_request'
  | 'implementation_plan_and_merge_request'
  | 'none';

/**
 * The review checklists a **Reviewer** run is given — Q83, WP-45 criterion 3.
 *
 * Which classes a review matched, from the paths it can see:
 *
 *  - a review of a merge request the platform read (`tasks.review_subject` — review-only mode, and
 *    the shadow comparison's review of a human merge request): **that merge request's files**,
 *    which is the authoritative source product/19 §14 names;
 *  - every other review: the Implementation Plan's paths ({@link touchedPathsOf}), **the task's
 *    own merge request's changed files** when the `stage.execute` job read them
 *    (`mergeRequestPaths`, WP-73, PROGRESS backlog 218), **plus** the classes `tasks.risk_classes`
 *    already holds. The rebase gate that writes that column runs after code review, so on a first
 *    review it is empty; before WP-73 the plan was then the only source, and a path the plan did
 *    not name escaped the checklist exactly where it matters most. The merge request's files close
 *    that for every review whose read succeeded; a read that failed (or a task with no merge
 *    request) falls back to the plan and the log names the source. A review after a return from
 *    the gate sees the gate's reading too.
 *
 * `missing` is a list a class names and the configuration does not define; the schema refuses such
 * a document, so this is empty unless `projects.config` was written around it, and the planner
 * logs it rather than dropping it.
 */
export const reviewChecklistsOf = (
  request: StageRunRequest,
): {
  readonly applied: readonly AppliedReviewChecklist[];
  readonly missing: readonly string[];
  readonly classes: readonly string[];
  readonly source: ReviewClassSource;
} => {
  const policies = request.settings.config.policies;
  const classes = policies?.risk_classes as Readonly<Record<string, RiskClass>> | undefined;
  const subject = request.task.reviewSubject ?? null;
  const planPaths = subject === null ? touchedPathsOf(request) : null;
  const fromPlan =
    planPaths?.source === 'implementation_plan' || planPaths?.source === 'both'
      ? planPaths.paths
      : [];
  const fromMergeRequest = subject === null ? (request.mergeRequestPaths ?? []) : [];
  const paths =
    subject !== null ? subject.files.map((file) => file.path) : [...fromPlan, ...fromMergeRequest];
  const matched = new Set(riskClassesForPaths(classes, paths));
  for (const name of request.task.riskClasses ?? []) {
    if (classes !== undefined && Object.hasOwn(classes, name)) {
      matched.add(name);
    }
  }
  // Declaration order, whichever reading produced the name.
  const names = Object.keys(classes ?? {}).filter((name) => matched.has(name));
  const { applied, missing } = reviewChecklistsFor(
    classes,
    policies?.review_checklists as Readonly<Record<string, readonly string[]>> | undefined,
    names,
  );
  return {
    applied,
    missing,
    classes: names,
    source:
      subject !== null
        ? 'review_subject'
        : fromMergeRequest.length > 0
          ? fromPlan.length > 0
            ? 'implementation_plan_and_merge_request'
            : 'merge_request'
          : fromPlan.length > 0
            ? 'implementation_plan'
            : 'none',
  };
};

const emptyRecord = (budgetTokens: number): ContextPackRecord => ({
  tier0: [],
  tier1: [],
  budget_tokens: budgetTokens,
  total_tokens: 0,
  kb_commit: null,
  // The project has no index, so no text search ran — the first of the five outcomes (WP-44).
  text_search: NOT_SEARCHED,
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
 * **Backlog 57 is closed at WP-36**, which took the three values the earlier rows left: `review_only`
 * was WP-24's, `linter` WP-25's, `bootstrap` WP-35's, and `discovery` is one more line here.
 * `retro` and `librarian` are **stages** rather than templates and are {@link RUN_MODE_BY_STAGE}
 * below.
 */
export const RUN_MODE_BY_TEMPLATE: Readonly<Record<string, RunSpec['mode']>> = {
  [REVIEW_ONLY_TEMPLATE_ID]: 'review_only',
  [TICKET_LINT_TEMPLATE_ID]: 'linter',
  // WP-35. `runs.mode` is what the run screen and the statistics read, and a mining run that called
  // itself `normal` would be backlog 57's fifth instance in the work package that had the choice.
  [HISTORY_BOOTSTRAP_TEMPLATE_ID]: 'bootstrap',
  // WP-36, backlog 57's `discovery`: WP-21's template, whose one agent stage is the whole task.
  [DISCOVERY_TEMPLATE_ID]: 'discovery',
};

/**
 * `runs.mode` by **stage** — the two upkeep runs every finished ticket produces (WP-36, backlog 57).
 *
 * `retrospective` and `librarian` are stages of all three *ticket* templates rather than templates
 * of their own, so a template-keyed table cannot reach them: six of the walk's rows recorded
 * `normal` until this one existed, which made *"what did delivery cost and what did upkeep cost"* —
 * product/16's own question, and the one a maintenance pipeline makes somebody ask — unanswerable
 * from the column that exists to answer it.
 *
 * **Which key wins when both match: the template.** A template that is in
 * {@link RUN_MODE_BY_TEMPLATE} exists for exactly one purpose and has one agent stage, so its value
 * is a statement about the whole task; this table is about stages the *ticket* templates share. If
 * the stage won instead, a one-off template that happened to reuse a shared stage id would silently
 * take that stage's mode — the shape of the defect backlog 57 records, one layer in. (It is the
 * opposite call from `status_mapping`'s, where the stage wins because *there* the stage id is the
 * more specific statement about a ticket's board column; the two questions are different and the
 * reasons are written at both.)
 */
export const RUN_MODE_BY_STAGE: Readonly<Record<string, RunSpec['mode']>> = {
  retrospective: 'retro',
  librarian: 'librarian',
};

/**
 * What this run's workspace checks out — PROGRESS backlog **71**, Q82 (a) (WP-34).
 *
 * Two producers and one default, in order:
 *
 *  1. a **shadow** task uses the merge base the batch resolved for its ticket
 *     (`StageRunRequest.checkoutBase`) as a **commit** (`checkoutCommit`), because the whole point
 *     of the comparison is that both diffs are taken against the same tree;
 *  2. every other task uses **its own branch** (`tasks.branch`) as a **branch** (`checkoutRef`),
 *     which is technical/05 §2's *"checkout of the task branch for re-entries"* and product/19
 *     §19's *"the platform re-provisions a workspace from the branch"*;
 *  3. neither — the default branch — for a task that has no branch yet, which is every task before
 *     its Developer stage has pushed one.
 *
 * **Which field says which kind** (WP-105, WP-98's discovered work): until WP-105 both travelled in
 * `checkoutRef`, and the clone could not tell a branch a first run creates from a commit the mirror
 * does not hold — so a missing shadow base became a branch named after the sha at the default
 * branch's head. The commit now has a field of its own, and the clone refuses it by name when it is
 * absent (Q82 (a): refused, never substituted).
 *
 * The shadow case wins over the branch case and cannot collide with it: a shadow task never opens a
 * merge request, so `tasks.branch` stays `null` for one.
 */
export const checkoutOf = (
  request: Pick<StageRunRequest, 'checkoutBase'> & {
    readonly task: Pick<StageRunRequest['task'], 'branch'> & {
      readonly mr?: { readonly branch?: string | null } | null;
      readonly task?: { readonly mode: string; readonly ticket: { readonly key: string } };
    };
  },
  role: AgentRole | null = null,
): Pick<RunSpec, 'checkoutRef' | 'checkoutCommit'> => {
  if (request.checkoutBase !== null && request.checkoutBase !== undefined) {
    return { checkoutRef: null, checkoutCommit: request.checkoutBase };
  }
  const own = request.task.branch ?? request.task.mr?.branch ?? null;
  if (own !== null || role !== 'developer' || request.task.task?.mode !== 'normal') {
    return { checkoutRef: own, checkoutCommit: null };
  }
  /**
   * **A writing Developer run is on its task's branch from its first turn** (WP-138 review round
   * 1). `tasks.branch` was filled only once a merge request was recorded (WP-145's re-key now also pins it), so the first Developer run
   * used to check out the default branch — and the developer's command policy has no `git
   * checkout`/`switch`/`branch`, while its push allow-list is `git push origin agentic/*`: the push
   * failed, or became a question, and `open_mr` then had nothing to open. The clone helper creates
   * a branch the mirror does not hold from the default branch (`git checkout -b`), so the run starts
   * on `agentic/<key>` — the branch `open_mr` opens from. A key with no character a branch may
   * carry has no such branch (`taskBranchName` refuses), and the run stays on the default branch.
   */
  try {
    return {
      checkoutRef: taskBranchName(request.task.task.ticket.key),
      checkoutCommit: null,
    };
  } catch (error) {
    if (!(error instanceof InvariantViolationError)) {
      throw error;
    }
    return { checkoutRef: null, checkoutCommit: null };
  }
};

/**
 * The previous attempt the prompt tells this run about (PROGRESS backlog 467), or `null`.
 *
 * Said only when it is true of **this** workspace: the latest ended run of the stage saved its work,
 * the push succeeded, and the branch it pushed is the branch this run checks out. A push that failed
 * left nothing on the remote, and a run on another branch (a rework moved the task) would be told
 * about work it cannot see — so both are silent, and the run starts as any attempt does.
 */
export const previousAttemptFor = (
  request: Pick<StageRunRequest, 'previousAttempt'>,
  checkoutRef: string | null,
): PromptPreviousAttempt | null => {
  const previous = request.previousAttempt ?? null;
  if (
    previous === null ||
    !previous.savedWork.pushed ||
    checkoutRef === null ||
    previous.savedWork.branch !== checkoutRef
  ) {
    return null;
  }
  return { terminalReason: previous.terminalReason, numTurns: previous.numTurns };
};

/**
 * How the stage's latest ended run ended (PROGRESS backlog 476), for the prompt's stage line — or
 * `null` when the stage has none. Every value is the platform's own record in a closed vocabulary.
 */
export const previousRunFor = (
  request: Pick<StageRunRequest, 'previousRun'>,
): { status: string; terminalReason: string | null; numTurns: number } | null => {
  const previous = request.previousRun ?? null;
  return previous === null
    ? null
    : {
        status: previous.status,
        terminalReason: previous.terminalReason,
        numTurns: previous.numTurns,
      };
};

/** Whether a role's run is given the repository: any tool that reads or writes a checkout. */
const runHasCheckout = (role: AgentRole): boolean =>
  (TOOLS_BY_ROLE[role] ?? []).some((tool) => CHECKOUT_TOOLS.includes(tool));

/**
 * What the prompt carries whole (PROGRESS backlog 474): the ticket when the platform read it — the
 * ticket block is the stored snapshot, uncut — and every artifact the assembler did not cut.
 */
export const promptHoldsOf = (
  task: StoredTask,
  artifacts: readonly PromptArtifact[],
): PromptHolds => ({
  ticket: task.ticketSnapshot !== null,
  artifacts: artifacts
    .filter((artifact) => artifactShownWhole(artifact))
    .map((artifact) => ({ artifact_type: artifact.type, version: artifact.version })),
});

/**
 * `runs.mode` — technical/04's mode table, which is about the **run** and not about the task.
 *
 * Three questions in one order, and the order is the rule. `shadow` comes from `tasks.mode`, which
 * is the shadow switch `IntegrationActionExecutor` reads and which deliberately stays two-valued;
 * then the **template**, because that is where "this run is the Code review stage alone, on a human
 * merge request" and "this run is a lint of one ticket" are expressed; then the **stage**, for the
 * two upkeep runs every ticket template shares. The template beats the stage for the reason written
 * at {@link RUN_MODE_BY_STAGE}.
 *
 * The column means *what this run was for*, never *what it was allowed to do* — the permissions are
 * the three least-privilege tables above, and nothing branches on this value.
 */
const runModeFor = (task: StoredTask, stage: Slug): RunSpec['mode'] => {
  if (task.task.mode === 'shadow') {
    return 'shadow';
  }
  return RUN_MODE_BY_TEMPLATE[task.task.template] ?? RUN_MODE_BY_STAGE[stage] ?? 'normal';
};

/** The warning's words for each failed conversation read (WP-180 review round 1). */
const CONVERSATION_SOURCE_LABEL: Readonly<Record<ConversationReadSource | 'unknown', string>> = {
  bindings: "the project's bindings for the conversation",
  mr: "the merge request's discussions",
  ticket: "the ticket's comments",
  unknown: 'the conversation',
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
    const listing = await options.headPaths(request.task.task.projectId);
    if (listing === null) {
      logger.debug(
        { project_id: request.task.task.projectId, run_id: request.runId },
        'no path listing stored for the indexed commit: a knowledge document scoped by `paths:` is recorded validated=false and not admitted',
      );
    }
    const touched = touchedPathsOf(request);
    logger.debug(
      {
        project_id: request.task.task.projectId,
        run_id: request.runId,
        stage: stageId,
        touched_paths: touched.paths.length,
        touched_paths_source: touched.source,
      },
      'context pack path match inputs',
    );
    const result = await options.contextPacks.assemble({
      projectId: request.task.task.projectId,
      stage: stageId,
      taskText: taskTextOf(request),
      // technical/07 step 1's *"touched paths (from plan/diff when available)"* — WP-58, backlog
      // 170. `touchedPathsOf` names its source, and `none` for every stage that runs before a plan
      // exists; see its docblock for the list.
      touchedPaths: touched.paths,
      repoPaths: listing ?? [],
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

  /**
   * The conversation for this run (WP-180), or `null` — for a task with no merge request and no
   * provider ticket, and for a read that failed, which is logged and never fails the plan (ruling
   * (b)). Nothing is stored: the prompt that carries it is (`runs.user_prompt`, ruling (d)).
   */
  const readConversation = async (request: StageRunRequest): Promise<PromptConversation | null> => {
    const { task } = request;
    try {
      return await options.readConversation({
        projectId: task.task.projectId,
        taskId: task.task.id,
        ticket: task.task.ticket,
        mr: task.mr,
      });
    } catch (error) {
      if (error instanceof TransactionOpenError) throw error;
      const source = error instanceof ConversationReadError ? error.source : 'unknown';
      logger.warn(
        {
          project_id: task.task.projectId,
          task_id: task.task.id,
          run_id: request.runId,
          stage: request.stage.id,
          source,
          error:
            error instanceof ConversationReadError
              ? error.causeName
              : error instanceof Error
                ? error.name
                : 'unknown',
          reason: error instanceof Error ? error.message : String(error),
        },
        `${CONVERSATION_SOURCE_LABEL[source]} could not be read; the run proceeds without its conversation blocks`,
      );
      return null;
    }
  };

  return {
    plan: async (request: StageRunRequest): Promise<StageRunPlan> => {
      const { stage, task, settings } = request;
      const role = stage.role ?? 'developer';
      const defaults = stageAgentDefaults(stage.id);
      const configured = settings.config.stages?.[stage.id];
      // Which skills this run is provisioned with: the role's row, minus every provider skill the
      // project's bindings do not name (WP-54). Read first, because the skills also bring their
      // own command patterns.
      // Backlog 476: the tools this build performs, so none is offered only to be refused — and a
      // skill about a tool the run is not given is withheld with it.
      const platformTools = platformToolsFor(role, stage.id, options.availablePlatformTools);
      const skillNames = skillsForTools(
        skillsFor(role, await options.boundSkills(task.task.projectId)),
        platformTools,
      );
      // Role baseline, then the stage's and the skills' extra `allow` patterns, then the
      // organisation maximum over all of it (backlog 146), then the project's narrowing — in that
      // order, so a project still narrows what the layers added (TD-027) and can never re-grant
      // what the organisation took away. The settings' lists narrow first and the repository
      // file's narrow again (WP-63): the file may tighten, never loosen.
      // BD-025's 2026-10-05 amendment: a project that verifies on CI has its declared commands, the
      // lockfile installs and the setup script moved to `block` on the baseline itself, so every
      // layer below judges its entries against a policy that already refuses them.
      const verification = verificationModeOf(settings.config);
      const policy = runCommandPolicy(
        withVerificationMode(commandBaselineFor(role, stage.id, skillNames), verification),
        settings.organisationCommands,
        settings.config.commands,
        settings.repositoryCommands,
      );
      if (policy.removedByOrganisation.length > 0) {
        logger.info(
          {
            project_id: task.task.projectId,
            run_id: request.runId,
            role,
            stage: stage.id,
            removed_by_organisation: policy.removedByOrganisation,
          },
          "the organisation's command maximum removed entries from this run's baseline (BD-025 §2)",
        );
      }
      if (policy.ignoredAllow.length > 0) {
        // The reader `ignoredAllow` never had (PROGRESS backlog 49): a declaration the platform
        // drops is reported, per run, with the role whose baseline did not grant it.
        logger.warn(
          {
            project_id: task.task.projectId,
            task_id: task.task.id,
            run_id: request.runId,
            role,
            stage: stage.id,
            ignored_allow: policy.ignoredAllow,
          },
          "the project's commands.allow names entries this run's role baseline does not grant; they were dropped, never widened (BD-025)",
        );
      }
      // WP-147 (backlog 442): the provider's CI path joins the list after the project's own list
      // replaced the default, so no project setting removes it.
      const ciLocation = await options.ciConfigLocation(task.task.projectId, task.task.id);
      if (ciLocation !== null && ciLocation.kind !== 'repository') {
        logger.info(
          {
            project_id: task.task.projectId,
            task_id: task.task.id,
            run_id: request.runId,
            ci_config: ciLocation.kind,
          },
          ciLocation.kind === 'external'
            ? "the project's CI configuration lives outside this repository, so the write-time path guard adds no CI path (BD-024)"
            : "the provider did not say where the project's CI configuration lives, so the write-time path guard adds no CI path; the CI gate's tamper check still asks (BD-024)",
        );
      }
      const protectedPaths = withCiConfigPath(effectiveProtectedPaths(settings), ciLocation);
      const budgetTokens =
        settings.config.project?.context_budget_tokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS;

      // Resolved rather than named: the digest below is over the bytes, so the same list must
      // produce the same entries the workspace is given. `createStageRunPlanner` already refused a
      // catalogue that cannot answer every name in the table.
      const skills = skillNames.map((name) => options.skills[name] as SkillDefinition);

      const pack = await resolvePack(request, stage.id, budgetTokens);
      const conversation = await readConversation(request);
      // WP-45: only a Reviewer is given the project's checklists — a checklist is a review item,
      // and `ReviewVerdict.checklists_applied` is the one artifact that records it.
      const review = role === 'reviewer' ? reviewChecklistsOf(request) : null;
      if (review !== null) {
        logger.info(
          {
            project_id: task.task.projectId,
            task_id: task.task.id,
            run_id: request.runId,
            stage: stage.id,
            risk_class_source: review.source,
            risk_classes: review.classes,
            checklists: review.applied.map((entry) => entry.name),
          },
          'review checklists for this run',
        );
        if (review.missing.length > 0) {
          logger.warn(
            {
              project_id: task.task.projectId,
              task_id: task.task.id,
              run_id: request.runId,
              missing: review.missing,
            },
            "a matched risk class names a review checklist this project's configuration does not define; the reviewer was not given it (the configuration schema refuses such a document — re-save it)",
          );
        }
      }
      // WP-92: the project's own prompt files for this stage, as data blocks. A file the
      // configuration names and the platform could not read is still a block (with its status and
      // no body) and a warning here: the run proceeds without it (`project-prompts.ts` has why).
      const projectPrompts = projectPromptsForStage(
        stage.id,
        settings.config,
        settings.repositoryPrompts ?? null,
      );
      const unreadPrompts = projectPrompts.filter((entry) => entry.status !== 'read');
      if (unreadPrompts.length > 0) {
        logger.warn(
          {
            project_id: task.task.projectId,
            task_id: task.task.id,
            run_id: request.runId,
            stage: stage.id,
            project_prompts: unreadPrompts.map((entry) => ({
              key: entry.key,
              status: entry.status,
              path: entry.path,
            })),
          },
          "a project prompt file this stage's configuration names could not be read; the run proceeds without it and its prompt says so",
        );
      }
      const checklistsInPrompt = (review?.applied ?? []).map((entry) => ({
        name: entry.name,
        items: entry.items,
        requiredBy: entry.requiredBy,
      }));
      const checkout = checkoutOf(request, role);
      const mode = runModeFor(task, stage.id);
      const previousAttempt = previousAttemptFor(request, checkout.checkoutRef);
      const limits = limitsFor(settings, stage.id, role);
      // Backlog 474: in the order a stage reads them, and the stage's own input under its own cap.
      const primary = PRIMARY_ARTIFACT_BY_ROLE[role] ?? [];
      const promptArtifacts: readonly PromptArtifact[] = artifactsShownTo(request).map(
        (artifact) => ({
          type: artifact.type,
          version: artifact.version,
          json: artifactJsonForPrompt(artifact.type, artifact.data),
          primary: primary.includes(artifact.type),
        }),
      );
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
          // WP-35: the mined history a bootstrap run reads, or `null` for every other task. Read
          // off the row for the same reason as the two above — the collection happened in a job,
          // outside every transaction, before this task existed.
          historySample: task.historySample ?? null,
          artifacts: promptArtifacts,
          returnFeedback: request.returnFeedback,
          // WP-81: a cut the CI gate made to a failing job's log, announced in the marker.
          returnFeedbackOriginalChars: request.returnFeedbackOriginalChars ?? null,
          // WP-152: the gate's last failure a person attached — a second block, `source="gate"`.
          attachedFeedback: attachedFeedbackFor(request),
          // A stage is not shown the audit trail (WP-31): the record blocks are the ask's, and a
          // stage that carried them would be paying context for the platform talking to itself.
          record: [],
          // WP-45: project text, so it rides in data blocks and bumps no role-prompt version.
          reviewChecklists: checklistsInPrompt,
          // WP-89: the bug pre-fetch's excerpts, read by the `stage.execute` job outside every
          // transaction before this plan — `[]` for every run it did not read for, so a project with
          // neither observability binding plans the prompt it always did.
          observability: request.observability ?? [],
          // Backlog 467: the previous attempt's saved work is on the branch this run checks out.
          previousAttempt,
          // Backlog 476: how the stage's last run ended, so "attempt 2" says why it exists.
          previousRun: previousRunFor(request),
          // WP-180: the merge request's notes and the ticket's comments, or no block at all.
          conversation,
        },
        artifactType: stage.produces,
        // The stage's narrower instruction, when it has one: platform text, typed as a closed set
        // so nothing else can reach the platform's own voice (`STAGE_PROMPT_FOCUS`).
        focus: STAGE_PROMPT_FOCUS[stage.id as keyof typeof STAGE_PROMPT_FOCUS] ?? null,
        // The platform's CI instruction for a project that verifies on CI, to a role with a shell.
        verification: verificationPromptFor(role, verification),
        // Backlog 475: what the shell can run, to every role that has one.
        environment: environmentPromptFor(role, verification),
        // Backlogs 473 and 476: the caps the CLI enforces, the tools the run is registered with
        // and what it was given — the user prompt's first section.
        run: {
          maxTurns: limits.maxTurns,
          maxBudgetUsd: limits.maxBudgetUsd,
          platformTools: platformTools,
          repository: runHasCheckout(role),
        },
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
        projectPrompts,
      });

      const spec: RunSpec = {
        runId: request.runId,
        taskId: task.task.id,
        projectId: task.task.projectId,
        stage: stage.id,
        role,
        mode,
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
        ...checkout,
        // Backlog 467: where this run's unfinished work goes if it ends without a result.
        unfinishedWorkBranch: unfinishedWorkBranchFor({
          role,
          stage: stage.id,
          mode,
          checkoutRef: checkout.checkoutRef,
        }),
        contextPack: [...pack.runContextPack],
        limits,
        tools: [...(TOOLS_BY_ROLE[role] ?? [])],
        disallowedTools: [],
        platformTools: [...platformTools],
        commandPolicy: {
          allow: [...policy.policy.allow],
          ask: [...policy.policy.ask],
          block: [...policy.policy.block],
          unattended: policy.unattended,
        },
        protectedPaths: [...protectedPaths],
        // BD-024 §2 (WP-99): the latest ImplementationPlan's `protected_path_changes[].path`, read
        // by the CI gate's own reader so the guard and the gate cannot read two plans. No plan, or a
        // latest plan that does not parse, declares nothing — the stricter direction.
        plannedProtectedPaths: [...exceptionsOf(request.artifacts).declared],
        // Nothing is listed before there is a workspace; the workspace runner substitutes the
        // launcher's listing, and until it does every protected path counts as existing.
        existingProtectedPaths: unlistedProtectedPaths(
          'the workspace has not been provisioned yet, so nothing is listed',
        ),
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
        // Backlog 474: what `get_task_context` need not send again, from the assembler's own cut.
        promptHolds: promptHoldsOf(task, promptArtifacts),
      };
      return {
        spec,
        contextPack: pack.record,
        ...(review === null
          ? {}
          : {
              // What the prompt carried, from the assembler's own bound (review round 1): a list
              // the bound cut is recorded with the items actually delivered, never the declared.
              reviewChecklists: boundReviewChecklists(checklistsInPrompt).map((entry) => ({
                name: entry.name,
                item_count: entry.items.length,
                required_by: [...entry.requiredBy],
                truncated: entry.truncated,
              })),
            }),
      };
    },
  };
};

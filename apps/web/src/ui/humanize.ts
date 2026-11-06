/**
 * Human words for machine states (TD-033 decision 6, research/19 § 3 item 7).
 *
 * Every vocabulary the screens print is a `Record` over the contract's own enum, so a value added to
 * `@platform/contracts` fails `typecheck` here until it has a word — the same mechanism as
 * `STATUS_LOOK` in `./status.tsx`. The imports are **types only**: this module has no runtime
 * dependency, so the worker's local page (TD-031's 120 kB entry) can import it as freely as the SPA.
 *
 * Stage ids are the one open vocabulary: a project's `.agentic/pipeline.yml` may declare a stage of
 * its own (`security_scan`), so `stageLabel` names every stage the platform ships and title-cases
 * any other slug rather than printing it raw. The words are sentence case, as GitHub's are.
 */
import type {
  AgentRole,
  ApprovalKind,
  ApprovalStatus,
  ArtifactType,
  AutonomyLevel,
  BUILTIN_STAGE_IDS,
  BudgetScope,
  BudgetWindow,
  BuiltinGateStageId,
  EffectiveConfigResponse,
  IntegrationSummary,
  IntegrationType,
  KnowledgeProposalKind,
  KnowledgeProposalSource,
  KnowledgeProposalStatus,
  KnowledgeProposalType,
  OrgUsersResponse,
  ProjectExecutionWaiting,
  ProjectExecutionWorker,
  ProjectSummary,
  QuestionStatus,
  RunStatus,
  RunTerminalReason,
  TaskStageState,
  TaskState,
  UserRole,
  WorkerClaimBlocker,
  WorkerSummary,
} from '@platform/contracts';

/** The ticket flow's stages plus the four the one-off templates add (discovery, lint, history, spike). */
export type ShippedStageId =
  | (typeof BUILTIN_STAGE_IDS)[number]
  | 'discovery'
  | 'ticket_lint'
  | 'history_mining'
  | 'human_review';

export const TASK_STATE_LABEL: Readonly<Record<TaskState, string>> = {
  queued: 'Queued',
  active: 'Active',
  returned: 'Sent back',
  waiting_answers: 'Waiting for answers',
  waiting_approval: 'Waiting for approval',
  paused: 'Paused',
  needs_human: 'Needs you',
  ready_for_merge: 'Ready to merge',
  merged: 'Merged',
  retro: 'Retrospective',
  done: 'Done',
  cancelled: 'Cancelled',
};

export const STAGE_LABEL: Readonly<Record<ShippedStageId, string>> = {
  intake: 'Intake',
  refinement: 'Refinement',
  investigation: 'Investigation',
  architecture: 'Architecture',
  implementation: 'Implementation',
  conflict_resolution: 'Conflict resolution',
  ci_gate: 'CI',
  code_review: 'Code review',
  business_review: 'Business review',
  rebase_gate: 'Up-to-date check',
  qa: 'QA',
  ready_for_merge: 'Ready to merge',
  merged_gate: 'Merge check',
  retrospective: 'Retrospective',
  librarian: 'Librarian',
  done: 'Done',
  discovery: 'Discovery',
  ticket_lint: 'Ticket check',
  history_mining: 'History mining',
  human_review: 'Human review',
};

/** The gates the platform evaluates itself — the same words as their stages. */
export const GATE_LABEL: Readonly<Record<BuiltinGateStageId, string>> = {
  ci_gate: STAGE_LABEL.ci_gate,
  rebase_gate: STAGE_LABEL.rebase_gate,
  merged_gate: STAGE_LABEL.merged_gate,
};

export const ROLE_LABEL: Readonly<Record<AgentRole, string>> = {
  triager: 'Triager',
  product_manager: 'Product manager',
  investigator: 'Investigator',
  architect: 'Architect',
  developer: 'Developer',
  reviewer: 'Reviewer',
  acceptance_tester: 'Acceptance tester',
  facilitator: 'Facilitator',
  librarian: 'Librarian',
  discovery: 'Discovery',
  ask: 'Ask',
  historian: 'Historian',
};

export const RUN_STATUS_LABEL: Readonly<Record<RunStatus, string>> = {
  created: 'Created',
  starting: 'Starting',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  budget_exceeded: 'Over budget',
  timed_out: 'Timed out',
  stalled: 'Stalled',
};

export const TERMINAL_REASON_LABEL: Readonly<Record<RunTerminalReason, string>> = {
  success: 'Succeeded',
  error_max_turns: 'Ran out of turns',
  error_max_budget_usd: 'Hit its budget',
  error_max_structured_output_retries: 'Could not produce a valid result',
  error_during_execution: 'Failed while running',
  permission_denied: 'Permission denied',
  cancelled: 'Cancelled',
  stalled: 'Stalled',
  timed_out: 'Timed out',
  crash: 'Crashed',
  lease_expired: 'Lost its worker',
  shutdown: 'Handed back on shutdown',
  rate_limited: 'Hit a usage limit',
};

/**
 * Why a run ended, in words — the run page's *Ended because* and the transcript's end row (S-23.22).
 * The transcript carries the reason as a plain string, so a value this build has no word for is
 * title-cased rather than printed raw.
 */
export const terminalReasonLabel = (reason: string): string =>
  Object.hasOwn(TERMINAL_REASON_LABEL, reason)
    ? TERMINAL_REASON_LABEL[reason as RunTerminalReason]
    : titleCase(reason);

/** The repository settings file's state, as a sentence's subject says it. */
export const REPOSITORY_STATUS_LABEL: Readonly<
  Record<EffectiveConfigResponse['repository']['status'], string>
> = {
  valid: 'read and valid',
  invalid: 'does not parse',
  absent: 'not present',
  unread: 'not read yet',
};

/** `task_stages.state`: one attempt at a stage. */
export const STAGE_STATE_LABEL: Readonly<Record<TaskStageState, string>> = {
  pending: 'Pending',
  running: 'Running',
  completed: 'Completed',
  returned: 'Sent back',
  skipped: 'Skipped',
  failed: 'Failed',
};

export const ARTIFACT_TYPE_LABEL: Readonly<Record<ArtifactType, string>> = {
  RefinedSpec: 'Refined spec',
  RootCauseAnalysis: 'Root-cause analysis',
  ImplementationPlan: 'Implementation plan',
  ImplementationNotes: 'Implementation notes',
  ReviewVerdict: 'Review verdict',
  AcceptanceVerdict: 'Acceptance verdict',
  RetroReport: 'Retrospective report',
  LibrarianProposals: 'Knowledge proposals',
  ShadowReport: 'Trial report',
  ReadinessReport: 'Readiness report',
  DiscoveryDraft: 'Discovery draft',
  AskAnswer: 'Answer',
  HistoryFindings: 'History findings',
  ResearchReport: 'Research report',
  TicketBreakdown: 'Ticket breakdown',
};

export const APPROVAL_KIND_LABEL: Readonly<Record<ApprovalKind, string>> = {
  plan: 'Plan approval',
  budget: 'Budget approval',
  knowledge: 'Knowledge approval',
  rework: 'Rework approval',
};

export const APPROVAL_STATUS_LABEL: Readonly<Record<ApprovalStatus, string>> = {
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
  expired: 'Expired',
};

export const QUESTION_STATUS_LABEL: Readonly<Record<QuestionStatus, string>> = {
  open: 'Open',
  answered: 'Answered',
  expired: 'Expired',
  escalated: 'Handed to a person',
};

/** `foo_bar-baz` → `Foo Bar Baz`: a project's own stage slug, never printed raw. */
export const titleCase = (slug: string): string =>
  slug
    .split(/[_-]+/)
    .filter((word) => word.length > 0)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(' ');

/** A stage's human name: the shipped word, or the slug title-cased for a project's own stage. */
export const stageLabel = (id: string): string =>
  Object.hasOwn(STAGE_LABEL, id) ? STAGE_LABEL[id as ShippedStageId] : titleCase(id);

/**
 * The events a sentence can name — a human stage's `on:` transition, the event that closed an
 * attempt — as a clause: "the merge request was merged" (S-23.22). The type is an open vocabulary
 * (a project template may name any event), so one this table does not hold is said as its words,
 * `ticket.updated` → "ticket updated", never as the dotted name.
 */
const EVENT_PHRASE: Readonly<Record<string, string>> = {
  'mr.merged': 'the merge request was merged',
  'mr.closed': 'the merge request was closed',
  'mr.opened': 'the merge request was opened',
  'mr.review.comment': 'a reviewer commented on the merge request',
  'ticket.status.changed': 'the ticket’s status changed',
  'ticket.updated': 'the ticket was updated',
  'default_branch.moved': 'the default branch moved',
  'ci.pipeline.finished': 'the CI pipeline finished',
  'task.stage.returned': 'the task was sent back',
  'task.completed': 'the task completed',
  'task.cancelled': 'the task was cancelled',
};

export const eventPhrase = (type: string): string =>
  Object.hasOwn(EVENT_PHRASE, type)
    ? (EVENT_PHRASE[type] as string)
    : type.replace(/[._]+/g, ' ').trim();

/** "Implementation · Developer", or the role alone for a run with no stage (an ask). */
export const runSubject = (run: { readonly stage: string | null; readonly role: AgentRole }) =>
  run.stage === null ? ROLE_LABEL[run.role] : `${stageLabel(run.stage)} · ${ROLE_LABEL[run.role]}`;

/**
 * The fourteen readiness criteria (`R1` … `R14`), each as a short human name for the wizard's
 * readiness panel — the id itself moves behind *Details*. The ids are the domain's
 * `READINESS_CRITERION_IDS`; the readiness record carries them as plain strings, so the map is held
 * equal to the domain's list by `humanize.test.ts` rather than by the type, and an id this build
 * does not know is shown as itself (`readinessCriterionLabel`) rather than dropped.
 */
export const READINESS_CRITERION_LABEL: Readonly<Record<string, string>> = {
  R1: 'Tests run green',
  R2: 'Tests are fast',
  R3: 'CI runs on merge requests',
  R4: 'CI is reliable',
  R5: 'Lint and formatting in CI',
  R6: 'One-command setup',
  R7: 'Type checks in CI',
  R8: 'Instructions for agents',
  R9: 'Protected default branch',
  R10: 'Merge request template and commit convention',
  R11: 'Logs and errors connected',
  R12: 'Knowledge base mostly complete',
  R13: 'Secret scanning',
  R14: 'Installable lockfile',
};

/** A readiness criterion's human name, or its id when this build has no word for it. */
export const readinessCriterionLabel = (id: string): string =>
  Object.hasOwn(READINESS_CRITERION_LABEL, id) ? (READINESS_CRITERION_LABEL[id] ?? id) : id;

/**
 * The bounded return loops (`tasks.iteration_counters`' keys, the graph edges' `loop`), as the flow
 * canvas's loop pill says them (S-23.5): the rounds a stage may send the task back for, in the
 * plural, because the pill counts them (S-25.5, research/21 § 4). A loop the platform does not ship
 * is title-cased, never printed raw; `humanize.test.ts` holds the table to the domain's
 * `ITERATION_LOOPS`.
 */
export const LOOP_LABEL: Readonly<Record<string, string>> = {
  code_review: 'Review rounds',
  business_review: 'Acceptance rounds',
  ci_fix: 'CI fixes',
  human_rounds: 'Human review rounds',
  refinement_questions: 'Question rounds',
  architecture_revisions: 'Plan revisions',
  rebase: 'Conflict fixes',
  rebase_rechecks: 'Up-to-date re-checks',
  dependency_policy: 'Dependency checks',
};

/** What a loop is, one hover away (product/10's 2026-11-06 *Plain words* rule). */
export const LOOP_DEFINITION =
  'How many times this step may send the task back before a person is asked to decide.';

export const loopLabel = (slug: string): string =>
  Object.hasOwn(LOOP_LABEL, slug) ? (LOOP_LABEL[slug] as string) : titleCase(slug);

/**
 * What one round of each loop is called on the board's loop badge (S-25.4, product/10's Board
 * amendment: *"Review round 2 of 3"*, never *"Review 2/3"*). A noun in the singular, because the
 * badge counts one round at a time; `humanize.test.ts` holds it to the same domain list as
 * {@link LOOP_LABEL}.
 */
export const LOOP_ROUND_LABEL: Readonly<Record<string, string>> = {
  code_review: 'Review',
  business_review: 'Acceptance',
  ci_fix: 'CI fix',
  human_rounds: 'Human review',
  refinement_questions: 'Question',
  architecture_revisions: 'Plan revision',
  rebase: 'Conflict fix',
  rebase_rechecks: 'Up-to-date re-check',
  dependency_policy: 'Dependency check',
};

/** *Review round 2 of 3*, or *Review round 2* when the loop's limit is not known. */
export const loopRoundLabel = (slug: string, count: number, limit?: number): string => {
  const noun = Object.hasOwn(LOOP_ROUND_LABEL, slug)
    ? (LOOP_ROUND_LABEL[slug] as string)
    : titleCase(slug);
  return `${noun} round ${count}${limit === undefined ? '' : ` of ${limit}`}`;
};

/** 1 → "1st", 2 → "2nd", 11 → "11th", 23 → "23rd". */
export const ordinal = (value: number): string => {
  const tens = value % 100;
  const suffix =
    tens >= 11 && tens <= 13
      ? 'th'
      : value % 10 === 1
        ? 'st'
        : value % 10 === 2
          ? 'nd'
          : value % 10 === 3
            ? 'rd'
            : 'th';
  return `${value}${suffix}`;
};

// ── Integrations and workers (S-23.11a) ──────────────────────────────────────

/** What each kind of integration is, in the words of the person adding one. */
export const INTEGRATION_TYPE_LABEL: Readonly<Record<IntegrationType, string>> = {
  task_management: 'Ticket tracker',
  git: 'Git host',
  communication: 'Chat',
  logs: 'Logs',
  errors: 'Error tracker',
};

/** One line per kind: what connecting it does — the add-integration wizard's provider cards. */
export const INTEGRATION_TYPE_PURPOSE: Readonly<Record<IntegrationType, string>> = {
  task_management: 'Where tickets come from: the pipeline picks them up and moves their status.',
  git: 'Where the code lives: agents push branches and open merge requests there.',
  communication: 'Where questions, approvals and the daily digest are posted.',
  logs: 'Log search the agents may read while they investigate a bug.',
  errors: 'Error reports the agents may read while they investigate a bug.',
};

export type IntegrationHealth = IntegrationSummary['health']['status'];

/**
 * `integrations.health.status` — the last *Test connection*'s verdict, and only that: since S-25.3 an
 * integration's health is `current_health` (read from its traffic), and this is one dated fact on
 * its page. So the words are a test's — *Passed*, *Failed* — never *Healthy*, which a month-old
 * probe once claimed on the row. `unknown` is a connection nobody has tested.
 */
export const INTEGRATION_HEALTH_LABEL: Readonly<Record<IntegrationHealth, string>> = {
  ok: 'Passed',
  degraded: 'Passed with warnings',
  down: 'Failed',
  unknown: 'Never tested',
};

/**
 * The integrations list's groups, in the order product/08's 2026-11-06 amendment gives them: what
 * an integration does for a project (S-25.3). Every type appears exactly once (`humanize.test.ts`).
 */
export const INTEGRATION_ROLE_GROUPS: readonly {
  readonly type: IntegrationType;
  readonly label: string;
}[] = [
  { type: 'task_management', label: 'Tickets' },
  { type: 'git', label: 'Code & merge requests' },
  { type: 'communication', label: 'Chat' },
  { type: 'errors', label: 'Errors' },
  { type: 'logs', label: 'Logs' },
];

export type IntegrationCurrentHealthStatus = IntegrationSummary['current_health']['status'];

/**
 * `current_health.status` — what the platform knows about an integration **now**, from its traffic
 * (S-25.3). Never *Healthy* on a stale probe: that is *Not checked recently*.
 */
export const INTEGRATION_CURRENT_HEALTH_LABEL: Readonly<
  Record<IntegrationCurrentHealthStatus, string>
> = {
  working: 'Working',
  degraded: 'Some calls failing',
  failing: 'Failing',
  not_checked_recently: 'Not checked recently',
  never_checked: 'Never checked',
};

/** Words the field names use that are spelled as initialisms in a sentence. */
const INITIALISMS: Readonly<Record<string, string>> = {
  api: 'API',
  id: 'ID',
  ssh: 'SSH',
  url: 'URL',
  urls: 'URLs',
};

/** A trailing unit becomes a parenthesis: `request_timeout_ms` → "Request timeout (ms)". */
const UNITS: Readonly<Record<string, string>> = {
  ms: 'ms',
  seconds: 'seconds',
  bytes: 'bytes',
};

/** Names whose words alone would read wrong. */
const FIELD_LABEL_OVERRIDES: Readonly<Record<string, string>> = {
  poll_enabled: 'Poll for changes',
};

/**
 * A provider field's human label — `site_url` → "Site URL", `api_token` → "API token",
 * `poll_interval_seconds` → "Poll interval (seconds)". The field names are the providers' own schema
 * keys (an open set, read off the server's catalogue), so this is a rule rather than a table: the
 * words in sentence case, initialisms spelled as such, a trailing unit in parentheses. The key itself
 * is still shown beside the label, in its hint, because it is what the operator guide and the
 * server's refusals name.
 */
export const configFieldLabel = (name: string): string => {
  const override = FIELD_LABEL_OVERRIDES[name];
  if (override !== undefined) {
    return override;
  }
  const words = name.split(/[_-]+/).filter((word) => word.length > 0);
  const last = words.at(-1);
  const unit = words.length > 1 && last !== undefined ? UNITS[last] : undefined;
  const body = (unit === undefined ? words : words.slice(0, -1)).map(
    (word) => INITIALISMS[word.toLowerCase()] ?? word.toLowerCase(),
  );
  const first = body[0];
  if (first === undefined) {
    return name;
  }
  const sentence = [`${first.charAt(0).toUpperCase()}${first.slice(1)}`, ...body.slice(1)].join(
    ' ',
  );
  return unit === undefined ? sentence : `${sentence} (${unit})`;
};

/** A choice field's value as a word: `deploy_key` → "Deploy key"; a number stays a number. */
export const choiceLabel = (value: string | number): string =>
  typeof value === 'number' ? String(value) : configFieldLabel(value);

export type WorkerPauseReason = NonNullable<WorkerSummary['paused_reason']>;

export const WORKER_PAUSE_REASON_LABEL: Readonly<Record<WorkerPauseReason, string>> = {
  usage_limited: 'Hit a usage limit',
};

/** A claim blocker in a person's words: a short `word` for a row, and the `fix` beside it. */
export interface ClaimBlockerWords {
  readonly word: string;
  readonly fix: string;
}

/**
 * What an outdated worker's owner does: nothing. Its updater checks when it starts and every minute
 * after, drains the worker and brings it up to date by itself. Re-running the installer is a repair
 * that never changes images, and a hand-edited compose file skips the updater's verification, so
 * neither is advice (S-23.27).
 */
export const UPDATER_FIX =
  'Its updater is bringing it up to date. Nothing to do; this usually takes a minute or two.';

/**
 * **Why a worker takes no work**, in one set of words for the Workers screen, a project's execution
 * panel and the worker's own local page (TD-031's 2026-11-05 blocker-vocabulary amendment, S-22.19).
 * Each sentence names *the worker* or *it*, so it reads the same on the platform and on the machine.
 */
export const WORKER_CLAIM_BLOCKER_WORDS: Readonly<Record<WorkerClaimBlocker, ClaimBlockerWords>> = {
  not_set_up: {
    word: 'Not set up yet',
    fix: 'Finish the steps on the worker’s page: choose this platform, sign in to Claude and approve the machine.',
  },
  revoked: {
    word: 'Removed from the platform',
    fix: 'To use this computer again, approve it again from the worker’s page.',
  },
  owner_disabled: {
    word: 'Its owner’s account is disabled',
    fix: 'An administrator re-enables the owner’s account in Settings, under Users; the worker then takes work again.',
  },
  offline: {
    word: 'Not connected to the platform',
    fix: 'Start the worker on that computer (“docker compose up -d” in its folder) and check that it reaches the platform.',
  },
  protocol_outdated: {
    word: 'Needs an update',
    fix: `It speaks an older version than this platform accepts. ${UPDATER_FIX}`,
  },
  platform_images_unresolved: {
    word: 'The platform can’t name its run images',
    fix: 'An administrator makes the platform’s images public in their registry, or pins the worker image versions in the platform’s configuration (the operator guide names the setting); until then no worker can take work.',
  },
  claude_rejected: {
    word: 'Claude refused its sign-in',
    fix: 'Sign in to Claude again on the worker’s page.',
  },
  paused: {
    word: 'Paused by its owner',
    fix: 'Resume it on the worker’s page.',
  },
  draining: {
    word: 'Draining: finishing its runs, taking nothing new',
    fix: 'Resume it on the worker’s page, or restart the worker.',
  },
  usage_limited: {
    word: 'Paused: Claude usage limit',
    fix: 'It resumes by itself when the limit resets.',
  },
  launcher_unreachable: {
    word: 'Its launcher isn’t answering',
    fix: 'The worker checks again before each claim. On that computer, “docker compose ps” must show the launcher running; “docker compose up -d” starts it.',
  },
  images_missing: {
    word: 'It has no run images',
    fix: 'Its launcher isn’t answering, or the images are still downloading. On that computer, run “docker compose up -d” and let the download finish.',
  },
  images_outdated: {
    word: 'It has an older build than this platform',
    fix: UPDATER_FIX,
  },
  no_eligible_project: {
    word: 'No project gives it work',
    fix: 'An administrator lets workers run a project’s stages in the project’s settings, under Execution; the worker’s page chooses which of those it takes by itself.',
  },
  pick_only: {
    word: 'Takes only runs its owner picks',
    fix: 'Its owner chooses on the worker’s page which projects it takes by itself; a run picked there still starts.',
  },
};

/** The two blockers an update clears: an older protocol, an older build. */
const OUTDATED_BLOCKERS: readonly WorkerClaimBlocker[] = ['protocol_outdated', 'images_outdated'];

/**
 * **The worker is updating itself** (S-23.27): it is draining *and* outdated. The updater drains a
 * worker before it replaces it, so the drain is the update in progress, not a second fault — a
 * screen says *Updating now…* as an in-progress state rather than two failures.
 */
export const isUpdating = (blockers: readonly WorkerClaimBlocker[]): boolean =>
  blockers.includes('draining') && blockers.some((blocker) => OUTDATED_BLOCKERS.includes(blocker));

/** One blocker of a worker's list, read with the rest of that list. */
export interface ClaimBlockerLine extends ClaimBlockerWords {
  readonly blocker: WorkerClaimBlocker;
  /** Part of an update in progress ({@link isUpdating}): said as in progress, never as failed. */
  readonly updating: boolean;
}

/** The headline of an updating worker: what a row, a step or a line says first. */
export const UPDATING_WORDS: ClaimBlockerWords = { word: 'Updating now…', fix: UPDATER_FIX };

/** The drain's line while it is the update: what the drain does, not how to undo it. */
const UPDATE_DRAIN_WORDS: ClaimBlockerWords = {
  word: 'Updating now…',
  fix: 'It finishes the runs it holds and takes nothing new until the update is done.',
};

/**
 * Every blocker of a worker with its words, in the list's order — the drain of an updating worker
 * reads *Updating now…* and the outdated line keeps its own word, both marked `updating`.
 */
export const claimBlockerLines = (
  blockers: readonly WorkerClaimBlocker[],
): readonly ClaimBlockerLine[] => {
  const updating = isUpdating(blockers);
  return blockers.map((blocker) => {
    const part = updating && (blocker === 'draining' || OUTDATED_BLOCKERS.includes(blocker));
    const words =
      part && blocker === 'draining' ? UPDATE_DRAIN_WORDS : WORKER_CLAIM_BLOCKER_WORDS[blocker];
    return { blocker, word: words.word, fix: words.fix, updating: part };
  });
};

/**
 * What a worker's one-line state names: its first blocker — or, when that blocker is part of an
 * update in progress, {@link UPDATING_WORDS}. A more fundamental blocker (not connected, removed)
 * still comes first. `undefined` when nothing blocks it.
 */
export const leadingClaimBlocker = (
  blockers: readonly WorkerClaimBlocker[],
): ClaimBlockerLine | undefined => {
  const first = claimBlockerLines(blockers)[0];
  return first === undefined || !first.updating ? first : { ...first, ...UPDATING_WORDS };
};

/**
 * A row word as the middle of a sentence (S-23.24): "Not connected to the platform" → "not
 * connected to the platform", with a name kept as it is ("Claude refused its sign-in").
 */
export const wordInSentence = (word: string): string =>
  word === '' || /^Claude\b/.test(word) ? word : `${word.charAt(0).toLowerCase()}${word.slice(1)}`;

/** Why a project keeps one worker off its runs (S-22.19's `project_reason`). */
export type ProjectWorkerReason = NonNullable<ProjectExecutionWorker['project_reason']>;

/**
 * A project's reason for keeping a worker off its runs, beside the worker's own blockers — the
 * Execution panel's *Who would take this project's work* (S-23.24). Same shape as
 * {@link WORKER_CLAIM_BLOCKER_WORDS}: a short `word` for the line and a `fix`.
 */
export const PROJECT_WORKER_REASON_WORDS: Readonly<Record<ProjectWorkerReason, ClaimBlockerWords>> =
  {
    server_only: {
      word: 'The project runs on the platform server only',
      fix: 'An administrator lets workers run it here, under Who runs this project’s agents.',
    },
    credential_refused: {
      word: 'Its git connection’s token may not go to a developer’s computer',
      fix: 'An administrator allows it on the project’s git connection.',
    },
    role: {
      word: 'Its owner may not run this project’s work',
      fix: 'An administrator gives its owner a role in the organisation that runs agent work.',
    },
    scope_excludes: {
      word: 'It doesn’t take this project by itself: its owner’s choice',
      fix: 'Its owner changes what it takes by itself on the worker’s page; a run picked there still starts.',
    },
  };

/** Why a waiting run may not go to a worker now (S-22.19's `waiting.closed_to_workers`). */
export type WaitingClosedReason = keyof ProjectExecutionWaiting['closed_to_workers'];

/** The end of "N waiting runs can't go to workers: …", per reason (S-23.24). */
export const WAITING_CLOSED_REASON_WORDS: Readonly<Record<WaitingClosedReason, string>> = {
  credential_refused: 'the git connection’s token may not go to a developer’s computer',
  server_only:
    'they were offered to the platform server only (pausing and resuming a task offers its run again)',
  server_first: 'the platform server goes first, and its head start has not ended yet',
};

// ── Settings, knowledge, budgets and the audit log (S-23.11b) ────────────────

/** A project's state (`projects.status`), beside its name in the header and the list (S-25.5). */
export const PROJECT_STATUS_LABEL: Readonly<Record<ProjectSummary['status'], string>> = {
  active: 'Active',
  paused: 'Paused',
  archived: 'Archived',
};

/** A person's role in the organisation (`users.role`). */
export const USER_ROLE_LABEL: Readonly<Record<UserRole, string>> = {
  admin: 'Administrator',
  maintainer: 'Maintainer',
  member: 'Member',
  viewer: 'Viewer',
};

export type UserStatus = OrgUsersResponse['items'][number]['status'];

export const USER_STATUS_LABEL: Readonly<Record<UserStatus, string>> = {
  active: 'Active',
  invited: 'Invited',
  disabled: 'Disabled',
};

/** The autonomy dial's positions, as the dial itself names them. */
export const AUTONOMY_LEVEL_LABEL: Readonly<Record<AutonomyLevel, string>> = {
  observe: 'Observe',
  assist: 'Assist',
  supervised: 'Supervised',
  autonomous: 'Autonomous',
};

/** A budget's window, as the sentence "spent … per month" reads it. */
export const BUDGET_WINDOW_LABEL: Readonly<Record<BudgetWindow, string>> = {
  day: 'Per day',
  week: 'Per week',
  month: 'Per month',
  total: 'In total',
};

export const BUDGET_SCOPE_LABEL: Readonly<Record<BudgetScope, string>> = {
  org: 'Organisation',
  project: 'Project',
  task: 'Task',
  run: 'Run',
};

export const KNOWLEDGE_PROPOSAL_TYPE_LABEL: Readonly<Record<KnowledgeProposalType, string>> = {
  lesson: 'Lesson',
  pitfall: 'Pitfall',
  rule: 'Rule',
  decision: 'Decision',
  'skill-draft': 'Skill draft',
  'doc-update': 'Document update',
};

export const KNOWLEDGE_PROPOSAL_KIND_LABEL: Readonly<Record<KnowledgeProposalKind, string>> = {
  business: 'Business',
  technical: 'Technical',
  process: 'Process',
};

export const KNOWLEDGE_PROPOSAL_STATUS_LABEL: Readonly<Record<KnowledgeProposalStatus, string>> = {
  scored: 'Waiting for review',
  queued: 'Waiting for review',
  auto_applied: 'Applied automatically',
  applied: 'Applied',
  apply_failed: 'Apply failed',
  rejected: 'Rejected',
  discarded: 'Discarded',
};

/**
 * Where a proposal came from, in a maintainer's words — `knowledge_proposal_source` (WP-35). A page
 * mined from merged history cites merge requests somebody can follow; a page the Discovery agent
 * drafted is a model's reading of a repository it had just met, and the queue says which.
 */
export const KNOWLEDGE_PROPOSAL_SOURCE_LABEL: Readonly<Record<KnowledgeProposalSource, string>> = {
  task: 'from a task',
  run: 'from a run',
  feedback: 'from feedback',
  bootstrap: 'drafted at project setup',
  human: 'written by a person',
  history: 'mined from merged history',
};

/**
 * The entity types the audit log's filter offers, with what a change to one is called.
 *
 * `config_audit.entity_type` is free text on the wire (`nonEmptyStringSchema`), so this is the
 * **known** set rather than an exhaustive record: the platform's configurable entities. A row whose
 * type is not here is still listed, with its type title-cased (`auditEntityLabel`), never dropped.
 */
export const AUDIT_ENTITY_LABEL: Readonly<Record<string, string>> = {
  organization: 'the organisation settings',
  project: 'a project’s settings',
  integration: 'an integration',
  binding: 'a project’s connections',
  budget: 'a budget',
  user: 'a person’s account',
};

/** The filter menu's word for an entity type ("Project"), and the row's ("a project’s settings"). */
export const AUDIT_ENTITY_FILTER_LABEL: Readonly<Record<string, string>> = {
  organization: 'Organisation',
  project: 'Project',
  integration: 'Integration',
  binding: 'Connections',
  budget: 'Budget',
  user: 'Person',
};

export const auditEntityLabel = (type: string): string =>
  Object.hasOwn(AUDIT_ENTITY_LABEL, type) ? (AUDIT_ENTITY_LABEL[type] as string) : titleCase(type);

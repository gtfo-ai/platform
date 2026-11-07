/**
 * Human words for machine states (TD-033 decision 6, research/19 § 3 item 7).
 *
 * Every vocabulary the screens print is a `Record` over the contract's own enum, so a value added to
 * `@platform/contracts` fails `typecheck` here until it has a word — the same mechanism as
 * `STATUS_LOOK` in `./status.tsx`. Its only runtime imports are its own `./words/*` modules, which
 * hold the maps the worker's local page shows: that page (TD-031's 120 kB entry) imports those
 * modules and **never this one**, so the SPA's other words stay out of its bundle (BACKLOG 1455,
 * `worker/import-graph.test.ts`). Every name is still exported from here, unchanged.
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
  TaskCiFailure,
  TaskStageState,
  TaskState,
  UserRole,
  WorkerClaimBlocker,
  WorkerSummary,
} from '@platform/contracts';
import { ROLE_LABEL } from './words/roles.js';
import { STAGE_LABEL, stageLabel, titleCase } from './words/stages.js';
import { TERMINAL_REASON_LABEL } from './words/terminal-reasons.js';
import {
  type ClaimBlockerWords,
  UPDATER_FIX,
  WORKER_CLAIM_BLOCKER_WORDS,
} from './words/worker-blockers.js';

// The word maps the worker's local page shows live in the `./words` modules (BACKLOG 1455) and
// are re-exported here unchanged, so every screen keeps importing them from this module.
export {
  type ClaimPolicyOptionWords,
  MACHINE_TAKES_WORDS,
  PICK_WORDS,
  projectListWords,
} from './words/claim-policy.js';
export { ROLE_LABEL } from './words/roles.js';
export { type ShippedStageId, STAGE_LABEL, stageLabel, titleCase } from './words/stages.js';
export { TERMINAL_REASON_LABEL } from './words/terminal-reasons.js';
export {
  type ClaimBlockerWords,
  UPDATER_FIX,
  WORKER_CLAIM_BLOCKER_WORDS,
} from './words/worker-blockers.js';

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

/** The gates the platform evaluates itself — the same words as their stages. */
export const GATE_LABEL: Readonly<Record<BuiltinGateStageId, string>> = {
  ci_gate: STAGE_LABEL.ci_gate,
  rebase_gate: STAGE_LABEL.rebase_gate,
  merged_gate: STAGE_LABEL.merged_gate,
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

/**
 * How a CI pipeline that sent a task back ended (S-25.11): `task_stages.signature`'s status, as the
 * task page's return and stop sentences open — "CI failed on the merge request".
 */
export const CI_FAILURE_LABEL: Readonly<Record<TaskCiFailure['status'], string>> = {
  failed: 'CI failed',
  canceled: 'CI was cancelled',
  skipped: 'CI was skipped',
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

// ── A task's owner (S-26.8b, the M26 UX spec §§ 2–3) ─────────────────────────

/**
 * A tracker's name as a person says it, for *Assigned in Jira to …* and *also assigns DEMO-1 in
 * Jira*. The ticket's `provider` is the binding's provider id (`jira-cloud`), or a fixture's
 * shorter spelling; one this build does not name is *the tracker*, never the raw id.
 */
const TRACKER_NAME: Readonly<Record<string, string>> = {
  'jira-cloud': 'Jira',
  jira: 'Jira',
  gitlab: 'GitLab',
  github: 'GitHub',
  linear: 'Linear',
};

export const trackerName = (provider: string): string => TRACKER_NAME[provider] ?? 'the tracker';

/** The board's owner filter (`?owner=`): *Everyone* is the absence of one. */
export type BoardOwnerFilter = 'all' | 'me' | 'none';

/**
 * **The owner's words** (the M26 UX spec § 2, S-26.8b's keys). The person-facing word is
 * *machine*, never *claim*, *offer* or *seat* (§ 4). A name is passed in already sanitised by the
 * caller where it lands in an attribute or a dialog title; where it is rendered as a node, the
 * caller renders the parts around an `UntrustedText` (`assigned_in_tracker_unlinked`).
 */
export const OWNER_WORDS = {
  'owner.unassigned': 'Unassigned',
  /** "Assigned in Jira to *Jan Novák* (not linked to a platform account)", around the name. */
  'owner.assigned_in_tracker_unlinked': {
    before: (tracker: string): string => `Assigned in ${tracker} to `,
    /** The tracker sent no display name. */
    nameless: 'someone',
    after: ' (not linked to a platform account)',
  },
  'owner.took': 'Assigned to you. Your machine picks it up at the next stage.',
  'owner.assigned': (name: string): string =>
    `Assigned to ${name}. Their machine picks it up at the next stage.`,
  /** The title of a refused owner change, wherever it is shown. */
  'owner.refused': 'The owner was not changed.',
  /**
   * After *Unassign*. Unassigning **never** writes to the tracker (TD-031's amendment item 4), so
   * the words never claim a tracker change; where the project writes assignments back
   * (`owner_writes_back`), they say the ticket keeps its assignee there.
   */
  'owner.unassigned_done': (trackerKeeps: string | null): string =>
    trackerKeeps === null
      ? 'Unassigned. A machine that takes unassigned tasks picks it up at the next stage.'
      : `Unassigned. The ticket stays assigned in ${trackerKeeps}. A machine that takes unassigned tasks picks it up at the next stage.`,
  /** The header's line: "Owner: Vojtěch". */
  'owner.label': (name: string): string => `Owner: ${name}`,
  /** The owner is the reader. */
  'owner.you': ' (you)',
  /** An owner whose account has no name. */
  'owner.nameless': 'a person with no name',
  /**
   * *Take it* on a task somebody else owns (§ 2): the confirmation names them. Its sentence is
   * built in parts, because a tracker assignee it replaces is provider text the caller renders
   * through `UntrustedText`: *Their machine stops getting it*, then — when the project writes the
   * assignment back — *, and this also assigns DEMO-1 in Jira*, then *, replacing Jan Novák* when
   * the tracker shows somebody the platform cannot link, then the full stop.
   */
  'owner.take_from': {
    title: (ticketKey: string, owner: string): string => `Take ${ticketKey} from ${owner}?`,
    stops: 'Their machine stops getting it',
    also: (ticketKey: string, tracker: string): string =>
      `, and this also assigns ${ticketKey} in ${tracker}`,
    replacing: ', replacing ',
    end: '.',
    confirm: (owner: string): string => `Take it from ${owner}`,
    keep: 'Cancel',
  },
  /**
   * *Take it* on a task nobody owns that the tracker assigns to a person the platform cannot link,
   * when the project writes the assignment back (S-26.3): taking it reassigns the ticket there.
   * "Take DEMO-2? This also assigns DEMO-2 in Jira to you, replacing *Jan Novák*."
   */
  'owner.take_held': {
    title: (ticketKey: string): string => `Take ${ticketKey}?`,
    before: (ticketKey: string, tracker: string): string =>
      `This also assigns ${ticketKey} in ${tracker} to you, replacing `,
    /** The tracker sent no display name. */
    nameless: 'its current assignee there',
    end: '.',
    confirm: (tracker: string): string => `Take it and assign in ${tracker}`,
  },
  'owner.action.take': 'Take it',
  'owner.action.assign': 'Assign…',
  'owner.action.unassign': 'Unassign',
  'owner.action.link': 'Link account…',
  /**
   * The person picker (§ 2's *Assign…*). Its other words — what choosing a person does, the empty
   * list, the read — are `features/owner-assign-words.ts`, which only the SPA's lazy owner dialogs
   * import, so the picker's words stay out of the initial graph.
   */
  'owner.picker': {
    title: (ticketKey: string): string => `Assign ${ticketKey}`,
    description: 'Their machine picks it up at the next stage.',
    label: 'Person',
    confirm: 'Assign',
    current: ' (owner now)',
  },
  /** The board's segmented control (§ 3), and what an empty filtered board says. */
  'owner.filter': {
    label: 'Whose tasks',
    all: 'Everyone',
    me: 'Mine',
    none: 'Unassigned',
    empty_me: 'No task here is assigned to you.',
    empty_none: 'Every task here has an owner.',
  },
  /** The card's avatar: its accessible name and its tooltip. */
  'owner.card': (name: string): string => `Owner: ${name}`,
} as const;

/**
 * **What a machine takes, on the Workers screen** (S-26.8a, the M26 UX spec § 1): the words the
 * screen adds around the shared card (`MACHINE_TAKES_WORDS`) — the muted line for the runs its
 * policy leaves for others, and the refusals the card's own words do not cover. *Machine*, never
 * *claim*, *offer* or *seat*.
 */
export const WORKERS_POLICY_WORDS = {
  /** `policy_skipped_offers` above zero: "Skipped 3 runs this machine doesn’t take". */
  skipped: (count: number, formatted: string): string =>
    count === 1
      ? `Skipped ${formatted} run this machine doesn’t take`
      : `Skipped ${formatted} runs this machine doesn’t take`,
  /** `422 claim_scope_empty`: an empty project list (*Only what I pick* is the option for none). */
  refusedEmpty:
    'Choose at least one project, or all of them. To take nothing by itself, choose Only what I pick.',
  /** A refusal none of the card's words name: the platform's sentence, never the server's text. */
  refusedOther: 'What this machine takes was not changed. Try again.',
  /** Until the project names are known: the row says nothing it would have to take back. */
  loading: 'Loading what this machine takes…',
  /** A stored project that no longer exists, on somebody else's machine (the card says *you left*). */
  removedProject: 'a removed project',
} as const;

/**
 * **Assign the owner in the tracker** (S-26.8a, product/06's M26 amendment): the ticket lifecycle's
 * third switch, the write-back S-26.3 performs. `help` takes the tracker binding's `provider` id and
 * names the tracker as {@link trackerName} does — *the tracker* for one this build does not name.
 */
export const ASSIGN_OWNER_WORDS = {
  label: 'Assign the owner in the tracker',
  help: (provider: string): string => {
    const name = Object.hasOwn(TRACKER_NAME, provider) ? TRACKER_NAME[provider] : undefined;
    return name === undefined
      ? 'When someone takes or is assigned a task here, also assign the ticket to them in the tracker. Only people who linked their tracker account are assigned there.'
      : `When someone takes or is assigned a task here, also assign the ticket to them in ${name}. Only people who linked their ${name} account are assigned there.`;
  },
} as const;

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

/**
 * What an approval's Inbox row says where a question's says when it is due — *requested 3 h ago ·
 * waits for a maintainer* (BD-006's 2026-11-07 amendment, S-27.1): an approval never expires, so it
 * has no due time to show, and only a maintainer decides one (BD-006, Q10).
 */
export const APPROVAL_WAIT_WORDS = 'waits for a maintainer';

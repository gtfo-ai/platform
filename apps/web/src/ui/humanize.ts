/**
 * Human words for machine states (TD-033 decision 6, research/19 § 3 item 7).
 *
 * Every vocabulary the screens print is a `Record` over the contract's own enum, so a value added to
 * `@platform/contracts` fails `typecheck` here until it has a word — the same mechanism as
 * `STATUS_LOOK` in `./status.tsx`. Its only runtime imports are its own `./words/*` modules, which
 * hold the maps the worker's local page shows: that page (TD-031's 120 kB entry) imports those
 * modules and **never this one**, so the SPA's other words stay out of its bundle (BACKLOG 1455,
 * `worker/import-graph.test.ts`). Those names are still exported from here, unchanged.
 *
 * **What only a lazy screen shows is not here** (S-25.13): the SPA's first paint — the shell, the
 * project frame, Home — imports this module, so every map in it is in TD-013's initial graph,
 * whichever screen uses it. The readiness criteria, the return loops, an integration's words, a
 * project's execution reasons and the words of Settings, knowledge, budgets and the audit log are
 * `./words/readiness-criteria.ts`, `./words/loops.ts`, `./words/integrations.ts`,
 * `./words/project-execution.ts` and `./words/settings.ts` — and, since S-27.1, S-26.8 and S-27.2, `./words/approvals.ts`, `./words/owners.ts`, `./words/workers-policy.ts` and `./words/ci-manual-jobs.ts` — imported by their screens — and **not
 * re-exported** from here, because a re-export would put them back in the initial graph.
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
  BuiltinGateStageId,
  EffectiveConfigResponse,
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
export {
  DID_NOT_START,
  type EndedRun,
  runEndedShort,
  TERMINAL_REASON_LABEL,
  TERMINAL_REASON_MEANING,
  TERMINAL_REASON_SHORT,
} from './words/terminal-reasons.js';
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

// ── Integrations and workers (S-23.11a) ──────────────────────────────────────

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

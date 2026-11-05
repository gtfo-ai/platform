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
  BUILTIN_STAGE_IDS,
  BuiltinGateStageId,
  QuestionStatus,
  RunStatus,
  RunTerminalReason,
  TaskStageState,
  TaskState,
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
  rebase_gate: 'Rebase check',
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
  ShadowReport: 'Shadow report',
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
  escalated: 'Escalated',
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

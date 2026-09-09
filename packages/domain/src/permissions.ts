/**
 * RBAC — `can(role, action, subject?)`.
 *
 * TD-022 fixes the shape: four roles with numeric levels (viewer 10 < member 20 < maintainer 30 <
 * admin 40) and "a pure `can(actor, action, resource)` with an exhaustive test". technical/08
 * names the capability map's home (`packages/domain/permissions`) and seven of its entries;
 * product/11 describes the roles in prose:
 *
 *   viewer      sees boards and artifacts
 *   member      sees transcripts and answers questions
 *   maintainer  approves plans, knowledge proposals, budgets and pipeline settings
 *   admin       manages integrations and users
 *
 * Two rules make the map safe to extend:
 *  1. **The requirement map is exhaustive by type.** `PERMISSION_REQUIREMENTS` is a
 *     `Record<PermissionAction, UserRole>`, so adding an action without deciding its minimum role
 *     does not compile.
 *  2. **Roles are levels, not sets.** A higher role can do everything a lower one can; there are
 *     no "admin cannot do X" carve-outs, which is what makes an exhaustive role×action table
 *     readable.
 *
 * `subject` narrows further, never wider: it can only turn a `true` into a `false`. It carries
 * the resource's *state*, because most of the real rules are "you may decide a pending approval"
 * rather than "you may decide approvals".
 */
import type {
  ApprovalKind,
  ApprovalStatus,
  QuestionStatus,
  RunStatus,
  TaskState,
  UserRole,
} from '@platform/contracts';
import { PermissionDeniedError } from './errors.js';

/** Role levels (TD-022). Comparable, so `can` is a `>=` on integers. */
export const ROLE_LEVELS = {
  viewer: 10,
  member: 20,
  maintainer: 30,
  admin: 40,
} as const satisfies Record<UserRole, number>;

/** Roles from lowest to highest privilege. */
export const USER_ROLES = [
  'viewer',
  'member',
  'maintainer',
  'admin',
] as const satisfies readonly UserRole[];

/**
 * Every action the platform authorises. Grouped by the API area of technical/08 that raises it.
 * Adding an entry here forces a decision in `PERMISSION_REQUIREMENTS` (type) and in the
 * exhaustive test (which restates the whole table by hand).
 */
export const PERMISSION_ACTIONS = [
  // Organisation
  'org.read',
  'org.settings.write',
  'org.users.manage',
  'org.audit.read',
  // Integrations (credentials are org-level; admin manages them — product/11)
  'integration.read',
  'integration.write',
  // Projects
  'project.read',
  'project.create',
  'project.settings.write',
  'project.pipeline.write',
  'project.autonomy.write',
  'project.members.manage',
  'project.config.export',
  // Budgets
  'budget.read',
  'budget.write',
  // Tasks
  'task.read',
  'task.create',
  'task.pause',
  'task.resume',
  'task.cancel',
  'task.retry_stage',
  'task.return_to_stage',
  'task.rework',
  'task.take_over',
  'task.hand_back',
  'task.answer_question',
  'task.approve_plan',
  'task.approve_budget',
  'task.feedback.create',
  'task.ask',
  'task.export',
  // Artifacts and transcripts
  'artifact.read',
  'transcript.read',
  // Runs
  'run.read',
  'run.steer',
  'run.cancel',
  'run.retry',
  // Knowledge base
  'kb.read',
  'kb.write',
  'kb.proposal.decide',
  'kb.bootstrap',
  // Operating modes
  'shadow.run',
  'discovery.run',
] as const;

export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

/**
 * The minimum role for each action.
 *
 * The seven entries technical/08 spells out are reproduced exactly:
 * `task.answer_question: member`, `task.approve_plan: maintainer`, `run.steer: member`,
 * `kb.proposal.decide: maintainer`, `project.settings.write: admin`, `budget.write: maintainer`,
 * `transcript.read: member`.
 */
export const PERMISSION_REQUIREMENTS = {
  'org.read': 'viewer',
  'org.settings.write': 'admin',
  'org.users.manage': 'admin',
  'org.audit.read': 'maintainer',

  'integration.read': 'maintainer',
  'integration.write': 'admin',

  'project.read': 'viewer',
  'project.create': 'admin',
  'project.settings.write': 'admin',
  'project.pipeline.write': 'maintainer',
  'project.autonomy.write': 'maintainer',
  'project.members.manage': 'admin',
  'project.config.export': 'maintainer',

  'budget.read': 'viewer',
  'budget.write': 'maintainer',

  'task.read': 'viewer',
  'task.create': 'member',
  'task.pause': 'member',
  'task.resume': 'member',
  'task.cancel': 'maintainer',
  'task.retry_stage': 'member',
  // `return_to_stage` and `rework` both send the task backwards and burn an iteration (BD-008),
  // so they carry the same gate: leaving the cheaper one at `member` would make the maintainer
  // gate on `rework` bypassable. Retrying the *current* stage costs a run, not a loop, so it
  // stays with `member`.
  'task.return_to_stage': 'maintainer',
  'task.rework': 'maintainer',
  'task.take_over': 'member',
  'task.hand_back': 'member',
  'task.answer_question': 'member',
  'task.approve_plan': 'maintainer',
  'task.approve_budget': 'maintainer',
  'task.feedback.create': 'member',
  'task.ask': 'member',
  'task.export': 'member',

  'artifact.read': 'viewer',
  'transcript.read': 'member',

  'run.read': 'viewer',
  'run.steer': 'member',
  'run.cancel': 'member',
  'run.retry': 'member',

  'kb.read': 'viewer',
  'kb.write': 'maintainer',
  'kb.proposal.decide': 'maintainer',
  'kb.bootstrap': 'maintainer',

  'shadow.run': 'maintainer',
  'discovery.run': 'maintainer',
} as const satisfies Record<PermissionAction, UserRole>;

/**
 * The resource a permission check is about, with the part of its state that changes the answer.
 * Passing a subject of the wrong kind for an action is ignored — the role check still applies —
 * so a caller can hand over whatever it has.
 */
export type PermissionSubject =
  | { readonly kind: 'question'; readonly status: QuestionStatus }
  | { readonly kind: 'approval'; readonly status: ApprovalStatus }
  | { readonly kind: 'run'; readonly status: RunStatus }
  | { readonly kind: 'task'; readonly state: TaskState };

/** Task states from which no further human action is possible. */
const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set<TaskState>(['done', 'cancelled']);

/** Task states a `task.resume` can act on (technical/02's task state machine). */
const RESUMABLE_TASK_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  'paused',
  'waiting_answers',
  'waiting_approval',
  'needs_human',
]);

/** Run statuses that have not reached a terminal outcome yet. */
const LIVE_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'created',
  'starting',
  'running',
]);

/**
 * State rules layered on top of the role check. Returns `false` only when the subject makes the
 * action impossible whatever the role — "first answer wins" (technical/02) is a state rule, not a
 * privilege one.
 */
const subjectAllows = (action: PermissionAction, subject: PermissionSubject): boolean => {
  switch (subject.kind) {
    case 'question':
      // Only an open question can be answered; the first answer wins (technical/02).
      return action === 'task.answer_question' ? subject.status === 'open' : true;
    case 'approval':
      return action === 'task.approve_plan' ||
        action === 'task.approve_budget' ||
        action === 'kb.proposal.decide' ||
        action === 'task.rework'
        ? subject.status === 'pending'
        : true;
    case 'run':
      if (action === 'run.steer') {
        // Steering pushes a user turn into a live session (product/18).
        return subject.status === 'running';
      }
      if (action === 'run.cancel') {
        return LIVE_RUN_STATUSES.has(subject.status);
      }
      if (action === 'run.retry') {
        return !LIVE_RUN_STATUSES.has(subject.status);
      }
      return true;
    case 'task':
      if (action === 'task.resume') {
        return RESUMABLE_TASK_STATES.has(subject.state);
      }
      if (
        action === 'task.pause' ||
        action === 'task.cancel' ||
        action === 'task.rework' ||
        action === 'task.take_over' ||
        action === 'task.retry_stage' ||
        action === 'task.return_to_stage' ||
        action === 'task.hand_back'
      ) {
        return !TERMINAL_TASK_STATES.has(subject.state);
      }
      return true;
  }
};

/**
 * The authorisation predicate. Pure, total, and the single place a role is compared to an action.
 *
 * @param role the caller's effective role for the resource's project (org role otherwise)
 * @param action what they are trying to do
 * @param subject the resource's state, where it changes the answer
 */
export const can = (
  role: UserRole,
  action: PermissionAction,
  subject?: PermissionSubject,
): boolean => {
  const required = PERMISSION_REQUIREMENTS[action];
  if (ROLE_LEVELS[role] < ROLE_LEVELS[required]) {
    return false;
  }
  return subject === undefined ? true : subjectAllows(action, subject);
};

/** `can`, as a guard. Throws `PermissionDeniedError` so aggregates never branch on booleans. */
export const assertCan = (
  role: UserRole,
  action: PermissionAction,
  subject?: PermissionSubject,
): void => {
  if (!can(role, action, subject)) {
    throw new PermissionDeniedError(action, role);
  }
};

/** Which permission decides an approval of this kind (technical/02's Approval aggregate). */
export const APPROVAL_ACTIONS = {
  plan: 'task.approve_plan',
  budget: 'task.approve_budget',
  knowledge: 'kb.proposal.decide',
  rework: 'task.rework',
} as const satisfies Record<ApprovalKind, PermissionAction>;

/**
 * BD-022 / BD-006 (Q10): an external identity that has not been mapped to a platform user can be
 * recorded but can never trigger an action. Roles are only meaningful for mapped users, so this
 * check sits beside `can` rather than inside it.
 */
export const isActionableIdentity = (identity: { readonly verified: boolean }): boolean =>
  identity.verified;

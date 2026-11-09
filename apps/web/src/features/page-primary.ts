/**
 * **The task page's one amber primary** (S-25.15, product/10's *one primary per screen*: the
 * screen's main job; *decide with the evidence on screen*). One function answers it, and the page
 * asks it once (`./task-detail.tsx`' `TaskTop`) and hands the answer to the header and to the
 * callout — so the header's button and the callout's next step can no longer disagree.
 *
 * They did on AUT-6655: a task stopped because CI never finished said "…Start or finish it there,
 * then retry the stage" in the callout, beside a plain *Retry stage…*, while the header's amber
 * button was *Resume*. Every structured stop (`detail.stop`: the rounds used up, the same failure
 * again, a check that got no answer — `./setback.ts`' `stopWords` and `./gate-wait.tsx`'
 * `CiWaitStop`) names *retry the stage* as its next step, so for one of them the callout's
 * *Retry stage…* is the primary and *Resume* moves to the `···` menu.
 *
 * **What the two commands do from `needs_human`** (`packages/application/src/pipeline/commands.ts`):
 * both re-enter the stage the task stopped at as a new attempt and spend no round. *Resume* goes
 * back into a pending approval's wait first when there is one, and resumes a merged task stopped at
 * the merge check into its retrospective; *Retry stage…* names the stage (it must be the current
 * one), stops a run of it still in flight, takes an idempotency key and answers which attempt it
 * entered. So for a stop the callout words as "retry the stage" the outcome is the same — the
 * primary is the button the sentence names.
 *
 * The order, the first that applies: the take-over to hand back, the agent's question, an approval
 * the reader may decide, the task's own cap, a manual CI job only a person can start, then the
 * stop's own way out — for a ticket somebody else holds, *Take it* while nobody owns the task and
 * the reader may take it (S-25.14), *Give it back to the agent* once an owner is set and the reader
 * may resume (S-25.15 part B: the claim keeps the ticket for that owner, TD-031 item 5), nothing
 * otherwise — *Retry stage…* for a structured stop with no approval pending — and a
 * resume last. A stop beside a pending approval keeps the rule before S-25.15 (review of #118):
 * *Review plan* for a reader who may decide it, else *Resume*, which re-enters that approval's wait
 * rather than running the stage past it, else none.
 *
 * **A legacy expired approval is a retry stop too** (S-25.20, AUT-6639 on Autix): before S-27.1 an
 * approval nobody decided in time expired, and the task escalated with the reason *the approval
 * expired* and a brief that says "retry the stage" — with no structured `stop`, so the page drew
 * *Resume* amber beside a callout whose way out is *Retry stage…*. {@link legacyApprovalExpired}
 * reads that escalation, and the page treats it as the structured stops are treated.
 */
import type { TaskDetailResponse, TaskState } from '@platform/contracts';
import { gateWaitHeld, gateWaitJobUrl, openGateWait } from './gate-wait.js';
import type { OwnerAction } from './task-owner.js';
import { heldElsewhereStop } from './ticket-held-words.js';

/**
 * The page's one primary action. The header draws `hand_back` … `start_job` and `resume`; `take`,
 * `give_back` (the held-elsewhere box's *Give it back to the agent*, a resume) and `retry_stage`
 * are the callout's own buttons, drawn amber there — and the header's *Resume* is then a menu item.
 */
export type TaskPrimaryAction =
  | 'hand_back'
  | 'answer'
  | 'approve'
  | 'raise_budget'
  | 'start_job'
  | 'take'
  | 'give_back'
  | 'retry_stage'
  | 'resume'
  | null;

/** The facts the answer is read from — {@link taskPagePrimary} derives them from the task read. */
export interface PrimaryFacts {
  readonly state: TaskState;
  /** The take-over in force has a stage it can be handed back to. */
  readonly canHandBack: boolean;
  readonly openQuestions: number;
  readonly pendingApprovals: number;
  /** The task's own cap paused it and the caller may raise it. */
  readonly canRaise?: boolean;
  /**
   * Whether the caller may decide an approval and resume the task (S-23.23, the read's
   * `can_decide_approval` and `can_resume`). Left out, they are not consulted — the page always
   * passes them; a caller who may not is never offered the action as the page's primary.
   */
  readonly canDecide?: boolean;
  readonly canResume?: boolean;
  /** The CI check waits on a held manual job whose page (or pipeline's) the page can link. */
  readonly ciHeldLink?: boolean;
  /**
   * The task stopped because its ticket is somebody else's (S-25.14, `heldElsewhereStop`): a
   * resume before anybody owns it would stop it again, so the primary is the callout's *Take it*
   * while nobody does, its *Give it back to the agent* once somebody does (S-25.15 part B, the
   * claim keeps the ticket for them), or none.
   */
  readonly heldElsewhere?: boolean;
  /** Nobody owns the task and the reader may take it (the owner control's `take` offer). */
  readonly canTake?: boolean;
  /** Somebody owns the task (`task.owner`): with `heldElsewhere`, the box offers the hand-back. */
  readonly owned?: boolean;
  /**
   * The task waits for a person after a structured stop whose next step is "retry the stage", and
   * the callout draws *Retry stage…* (the task has a stage to address and was not merged).
   */
  readonly stopRetry?: boolean;
}

export const taskPrimaryAction = (input: PrimaryFacts): TaskPrimaryAction => {
  if (input.canHandBack) {
    return 'hand_back';
  }
  if (input.openQuestions > 0) {
    return 'answer';
  }
  if (input.pendingApprovals > 0 && input.canDecide !== false) {
    return 'approve';
  }
  if (input.canRaise === true) {
    return 'raise_budget';
  }
  if (input.ciHeldLink === true) {
    return 'start_job';
  }
  const resumable =
    input.canResume !== false && (input.state === 'paused' || input.state === 'needs_human');
  if (input.heldElsewhere === true) {
    return input.canTake === true ? 'take' : input.owned === true && resumable ? 'give_back' : null;
  }
  // `retry-stage` and `resume` are the same role on the server (`task.retry_stage` and
  // `task.resume` are both a member's) and both admit `needs_human`; the read carries the second.
  // Review of #118: never over a pending approval (one the reader may not decide reaches here) —
  // Resume goes back into that approval's wait first, and a retry does not, so Resume stays.
  if (
    input.stopRetry === true &&
    input.state === 'needs_human' &&
    input.pendingApprovals === 0 &&
    resumable
  ) {
    return 'retry_stage';
  }
  return resumable ? 'resume' : null;
};

/**
 * The escalation reasons an expired approval was written with: the saga's sentence, which every
 * build before S-27.1 wrote (`packages/application/src/pipeline/saga.ts`, *the approval expired*),
 * and the stage outcome's key, which the rows' short form words (`./escalation-short.ts`).
 */
const APPROVAL_EXPIRED_REASONS: ReadonlySet<string> = new Set([
  'the approval expired',
  'approval.expired',
]);

/** The task waits for a person because an approval expired undecided (a pre-S-27.1 stop). */
export const legacyApprovalExpired = (detail: TaskDetailResponse): boolean =>
  detail.task.state === 'needs_human' &&
  detail.escalation !== null &&
  APPROVAL_EXPIRED_REASONS.has(detail.escalation.reason);

/** The page's own facts {@link taskPrimaryAction} needs beyond the task read. */
export interface PrimaryContext {
  /** What the owner control offers this reader (`useOwnerControl`'s `offers`). */
  readonly ownerOffers: readonly OwnerAction[];
  /** How many stages the stage commands can address; none draws no *Retry stage…*. */
  readonly stageOptions: number;
  /** The task entered `merged_gate`: its way out is the retrospective, through *Resume*. */
  readonly merged: boolean;
}

/** The one primary of this task page, from the task read and the page's own context. */
export const taskPagePrimary = (
  detail: TaskDetailResponse,
  context: PrimaryContext,
): TaskPrimaryAction => {
  const { task } = detail;
  const gateWait = openGateWait(detail);
  return taskPrimaryAction({
    state: task.state,
    canHandBack: detail.taken_over !== null && detail.taken_over.hand_back_stages.length > 0,
    openQuestions: detail.questions.filter((question) => question.status === 'open').length,
    pendingApprovals: detail.approvals.filter((approval) => approval.status === 'pending').length,
    // WP-131 review round 2: only a task **its own cap** paused, for a caller the route admits.
    canRaise:
      detail.can_raise_budget &&
      task.state === 'paused' &&
      task.paused_reason === 'budget' &&
      task.paused_budget_scope === 'task',
    canDecide: detail.can_decide_approval,
    canResume: detail.can_resume,
    ciHeldLink: gateWait !== null && gateWaitHeld(gateWait) && gateWaitJobUrl(gateWait) !== null,
    heldElsewhere: heldElsewhereStop(detail),
    canTake: (task.owner ?? null) === null && context.ownerOffers.includes('take'),
    owned: (task.owner ?? null) !== null,
    stopRetry:
      (detail.stop !== null || legacyApprovalExpired(detail)) &&
      context.stageOptions > 0 &&
      !context.merged,
  });
};

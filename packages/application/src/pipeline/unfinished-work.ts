/**
 * **Save the work, and let the retry continue from it** — the product owner's decision of
 * 2026-10-05 (BD-025's amendment of that date, PROGRESS backlog 467).
 *
 * ## What happened
 *
 * On the first local test a Developer run on a real ticket ended `error_max_turns` after 201 turns
 * and 26 minutes, having edited some forty files and written four new ones. Nothing was committed
 * or pushed, the workspace was freed on the way out, and the retry provisioned a fresh checkout of
 * the default branch — so the work was lost and the next attempt paid for the same exploration again.
 *
 * ## What this module decides, and what it does not
 *
 * Three pure answers, each with one caller, so the rule lives in one place:
 *
 *  - **whose** work is saved — {@link unfinishedWorkBranchFor}, asked by the planner, which writes
 *    the answer onto `RunSpec.unfinishedWorkBranch`;
 *  - **which endings** save it — {@link savesUnfinishedWork}, asked by the workspace runner in the
 *    process that holds the workspace, the only moment the tree still exists;
 *  - **what the commit says** — {@link unfinishedWorkCommitMessage}, product/19 §7's second
 *    permitted `wip:` commit beside the take-over's `wip: hand-over to <user>`.
 *
 * The export itself is the take-over's, unchanged in every guard: the launcher's export helper
 * (`exportScript` in `packages/infrastructure/src/workspace/provider.ts`) stops the run container,
 * refuses a `.git` that is not the directory the platform cloned, a nested repository or an
 * unreadable tree by name, reads no git configuration the run wrote, runs no hook, and pushes with
 * the run's **own** minted credential — never the platform's. What this decision adds to it is one
 * flag, `onlyIfChanged`: the helper commits and pushes only when the tree has uncommitted changes,
 * untracked files or commits the project's mirror does not hold, so an attempt that changed nothing
 * pushes nothing. The content the run wrote passed the write-time path guard (protected paths and
 * secret-shaped content) when it was written, exactly as a take-over's does; the commit message is
 * platform text over a closed vocabulary.
 */
import type {
  AgentRole,
  RunMode,
  RunSavedWork,
  RunStatus,
  RunTerminalReason,
} from '@platform/contracts';
import { runSavedWorkSchema } from '@platform/contracts';
import { CONFLICT_RESOLUTION_STAGE } from './rebase.js';

/**
 * The endings whose unfinished work is saved: every way a run can **stop working without a
 * result** while its workspace still holds what it did.
 *
 * | reason | why it is saved |
 * |---|---|
 * | `error_max_turns` | the run was working and ran out of turns — the case that prompted the decision |
 * | `error_max_budget_usd` | out of budget with no artifact kept (a kept artifact is `completed`, backlog 466) |
 * | `error_max_structured_output_retries` | the work is done or nearly; the artifact was refused |
 * | `timed_out` | the wall clock stopped it |
 * | `stalled` | it produced nothing for too long; what it had is still in the tree |
 * | `crash` | the session died after the workspace existed |
 * | `error_during_execution` | the CLI's own error ending; a crash by another name |
 *
 * **Not saved**, each deliberately: `success` (the run delivered); `cancelled` (a person stopped
 * it — a cancel is "throw this away", and the take-over is the command for "keep it"); a take-over
 * (exported by its own request, with its own message); `shutdown` (the runner process is stopping and
 * hands the stage back to start again by itself — an export would lengthen a SIGTERM, recorded as
 * discovered work in backlog 467); `permission_denied` (the run ended on a policy refusal, which a
 * person reads before its tree goes anywhere); `lease_expired` (written by the sweep about a run no
 * process holds — there is no workspace left to ask).
 */
export const SAVED_UNFINISHED_WORK_REASONS: ReadonlySet<RunTerminalReason> = new Set([
  'error_max_turns',
  'error_max_budget_usd',
  'error_max_structured_output_retries',
  'error_during_execution',
  'timed_out',
  'stalled',
  'crash',
]);

/**
 * Does this ending save its unfinished work?
 *
 * The status is read as well as the reason because the two are not one-to-one: `completed` with
 * `error_max_budget_usd` is a run that **kept** its artifact (BD-010's 2026-10-05 amendment), and a
 * take-over ends `cancelled` with whatever reason its interrupted turn reported.
 */
export const savesUnfinishedWork = (outcome: {
  readonly status: RunStatus;
  readonly terminalReason: RunTerminalReason;
}): boolean =>
  outcome.status !== 'completed' &&
  outcome.status !== 'cancelled' &&
  SAVED_UNFINISHED_WORK_REASONS.has(outcome.terminalReason);

/**
 * The branch a run's unfinished work goes to, or `null` when its work is not saved.
 *
 * **The Developer, at every stage but `conflict_resolution`.** The Developer is the one role whose
 * work is a change to the tree; every other role's product is an artifact, which a failed run did not
 * deliver and a commit would not hold. `conflict_resolution` is excluded although it is a Developer
 * stage: its run works on a branch that already carries an open merge request, mid-merge, and a
 * `wip:` commit of a half-resolved merge would put conflict markers on the merge request under
 * review — while the work it loses is one `git merge` the next attempt repeats cheaply.
 *
 * **Only an ordinary task**: a shadow task never pushes (its comparison is the point), and a
 * review-only task has no Developer stage. **Only an `agentic/*` checkout**: the export pushes inside
 * BD-025's namespace and nowhere else, and the run's minted credential is scoped to it — a task
 * whose recorded branch is outside it saves nothing rather than pushing somewhere new.
 */
export const unfinishedWorkBranchFor = (input: {
  readonly role: AgentRole;
  readonly stage: string | null;
  readonly mode: RunMode;
  readonly checkoutRef: string | null;
}): string | null => {
  if (
    input.role !== 'developer' ||
    input.stage === null ||
    input.stage === CONFLICT_RESOLUTION_STAGE ||
    input.mode !== 'normal' ||
    input.checkoutRef === null
  ) {
    return null;
  }
  return runSavedWorkSchema.shape.branch.safeParse(input.checkoutRef).success
    ? input.checkoutRef
    : null;
};

/**
 * product/19 §7's second permitted `wip:` commit (BD-025's 2026-10-05 amendment):
 * `wip: unfinished attempt <n> of <stage> (<terminal reason>)`.
 *
 * Every part is platform text: the attempt is an integer, the stage a slug the template names and
 * the reason `runTerminalReasonSchema`'s closed vocabulary — so the message needs no redaction and
 * carries nothing a ticket or a model wrote.
 */
export const unfinishedWorkCommitMessage = (input: {
  readonly attempt: number;
  readonly stage: string;
  readonly terminalReason: RunTerminalReason;
}): string =>
  `wip: unfinished attempt ${String(input.attempt)} of ${input.stage} (${input.terminalReason})`;

/** What the workspace runner asks the workspace for, when it asks for anything. */
export interface UnfinishedWorkExport {
  readonly branch: string;
  readonly commitMessage: string;
}

/**
 * The export one run owes on its way out, or `null`: the spec says whose work is saved and the
 * outcome says whether this ending saves it.
 */
export const unfinishedWorkExportFor = (
  spec: {
    readonly unfinishedWorkBranch: string | null;
    readonly stage: string | null;
    readonly attempt: number;
  },
  outcome: { readonly status: RunStatus; readonly terminalReason: RunTerminalReason },
): UnfinishedWorkExport | null => {
  if (spec.unfinishedWorkBranch === null || spec.stage === null || !savesUnfinishedWork(outcome)) {
    return null;
  }
  return {
    branch: spec.unfinishedWorkBranch,
    commitMessage: unfinishedWorkCommitMessage({
      attempt: spec.attempt,
      stage: spec.stage,
      terminalReason: outcome.terminalReason,
    }),
  };
};

/**
 * The sentence the escalation's blocker brief and the run's record add about the saved work —
 * platform text around the branch (held to BD-025's namespace by its schema) and a short sha.
 */
export const savedWorkSentence = (saved: RunSavedWork): string =>
  saved.pushed
    ? `Its unfinished work was saved: the platform committed it as a \`wip:\` commit` +
      `${saved.commit_sha === null ? '' : ` (${saved.commit_sha.slice(0, 12)})`} and pushed it to ` +
      `${saved.branch}, so a retry of this stage continues from that branch rather than from the ` +
      'default branch.'
    : `The platform tried to save its unfinished work to ${saved.branch} and the push did not ` +
      "succeed, so that work is only in the run's workspace volume until the volume's retention " +
      'ends; a retry starts from the branch as the remote has it.';

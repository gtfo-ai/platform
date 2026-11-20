/**
 * **A task that passes QA enters Ready with the head the gates judged** (S-28.18, BACKLOG 1608,
 * TD-038 Amendment B).
 *
 * ## What was wrong
 *
 * On a task with the `qa` stage (BD-031, WP-174/178) the order is `… rebase_gate → qa →
 * ready_for_merge`. `tasks.ready_head_sha` is written by the Ready entry's own transaction
 * (`transitions.ts`), and only a passing rebase-gate settlement supplied a head — but that
 * settlement enters **`qa`**, not Ready. QA's pass (`passQa` in `jobs.ts`, the human-return window
 * reading that the ticket left the `qa` status) then entered Ready with **no** head, so the column
 * was `null` and the platform merge's fresh check (`platformMergeWait`) waited forever, worded as
 * "the branch moved since the reviewed commit" although nobody had pushed. Measured on Autix
 * (2026-11-20): every task that entered Ready from `qa` (4 of 4) had no head; every platform merge
 * that succeeded had entered Ready from `rebase_gate`.
 *
 * ## The rule, and why it is ready-head.ts's rule
 *
 * Ready only for a head the gates judged (WP-79/WP-105, `ready-head.ts`). On a pipeline that runs
 * `ci_gate`, the rebase gate enters `qa` **only** for the head CI passed — `rebaseAgainstCi`
 * (`gates.ts`) answers `agree` exactly when the rebase head equals `tasks.ci_head_sha`, and every
 * other answer re-enters `ci_gate` — and nothing writes `ci_head_sha` while the task waits at `qa`
 * (its writers are the CI gate's settlement, which runs only at `ci_gate`, and the platform
 * merge's rebase acceptance, which runs only at Ready). So **`ci_head_sha` is the head the gates
 * judged before QA**, and QA's pass carries it into Ready as the head that entry records. Nothing
 * new is persisted: the shape is the brief's option (a) with `ci_head_sha` reused, rather than a
 * Ready entry through the `ready_head_check` duty, because that duty re-enters `rebase_gate`
 * (WP-105), whose pass leads back into `qa` — a person would test the same commit again.
 *
 * **A head that moved during QA is still not merged unjudged**: the platform merge's fresh check
 * compares the merge request's live head with `ready_head_sha` (and that with `ci_head_sha`), so a
 * push during QA is `head_moved` — the true sentence, now — and a person merges or sends the task
 * back to review, as ready-head.ts's answer for any moved head at Ready.
 *
 * A pipeline that runs **no** `ci_gate` (no shipped template; a custom one) carries **nothing**:
 * its rebase gate's head is not persisted anywhere QA's pass could read it, so the Ready entry
 * records `null` and the platform merge waits `head_not_recorded` — a person merges. That is the
 * fail-closed direction and it is stated rather than closed (BACKLOG 1609).
 *
 * ## Tasks already waiting (the recovery)
 *
 * A task that entered Ready from `qa` before this shipped holds `null`. On a pipeline with `qa`
 * enabled every Ready entry is QA's pass (the rebase gate passes to `qa`; the `ready_head_check`
 * duty re-enters `rebase_gate`; the platform merge's rebase acceptance writes a head), so the same
 * rule answers it: {@link adoptQaPassHead} records `ci_head_sha` once, from the `ready_merge_check`
 * duty, and the recovery pass's `ready_merge_check` row finds such a task due
 * (`readyMergeCheckDue`: at Ready, `qa_stage`, no `ready_head_sha`, a `ci_head_sha`). The write is
 * conditional on the column still being `null`, so it happens once; afterwards the task is due
 * only on the row's existing terms.
 *
 * ## The residual, stated
 *
 * A person who **hands back** into `qa` (a take-over) skips the rebase gate's entry into `qa`; QA's
 * pass then carries the last head CI passed. The platform merge still merges only that head and
 * only with the provider's "mergeable" and an approving review, so a push during the take-over is
 * `head_moved`; what is not re-read is the rebase gate's confirmation of protected paths CI excused
 * (WP-102) for an unpushed take-over that skipped the review stages. Recorded as BACKLOG 1609.
 */
import type { Id } from '@platform/contracts';
import {
  type CompiledPipeline,
  compilePipeline,
  QA_STAGE_ID,
  READY_FOR_MERGE_STAGE,
  stageOf,
} from '@platform/domain';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { CI_GATE_STAGE } from './gates.js';
import type { PipelineStore, StoredTask } from './store.js';

/** Is `id` an enabled stage of `kind` in this pipeline? */
const runs = (pipeline: CompiledPipeline, id: string, kind: 'gate' | 'human'): boolean => {
  const stage = stageOf(pipeline, id);
  return stage?.enabled === true && stage.kind === kind;
};

/**
 * **The head QA's pass records at Ready**: `ci_head_sha` on a pipeline that runs `ci_gate` (the
 * head the rebase gate agreed with on its way into `qa`), else `null`. Pure; `qa-pass-head.test.ts`
 * holds both branches.
 */
export const qaPassHead = (
  pipeline: CompiledPipeline,
  task: Pick<StoredTask, 'ciHeadSha'>,
): string | null => (runs(pipeline, CI_GATE_STAGE, 'gate') ? task.ciHeadSha : null);

/**
 * May the recovery record {@link qaPassHead} for this task? At `ready_for_merge` with no recorded
 * head, on a pipeline whose `qa` stage is enabled (so its Ready entry was QA's pass), with a head to
 * record. Pure.
 */
export const qaPassHeadToAdopt = (stored: StoredTask): string | null => {
  if (
    stored.task.state !== 'ready_for_merge' ||
    stored.task.currentStage !== READY_FOR_MERGE_STAGE ||
    stored.readyHeadSha !== null ||
    !stored.qaStage
  ) {
    return null;
  }
  const pipeline = compilePipeline(
    stored.task.template,
    stored.template,
    stored.pipelineDial,
    stored.qaStage,
  );
  return runs(pipeline, QA_STAGE_ID, 'human') ? qaPassHead(pipeline, stored) : null;
};

/**
 * The recovery's write (S-28.18): records {@link qaPassHeadToAdopt}'s head as `ready_head_sha`, in a
 * transaction that re-reads the task, so it writes once and only while the column is still `null`.
 * Answers the head it recorded, or `null` when it wrote nothing.
 */
export const adoptQaPassHead = async (
  options: {
    readonly unitOfWork: UnitOfWork;
    readonly store: Pick<PipelineStore, 'tasks'>;
    readonly logger?: Logger;
  },
  taskId: Id,
): Promise<string | null> => {
  const adopted = await options.unitOfWork.transaction(async (scope) => {
    const current = await options.store.tasks.load(scope.tx, taskId);
    const head = current === null ? null : qaPassHeadToAdopt(current);
    if (head === null) {
      return null;
    }
    await options.store.tasks.saveReadyHead(scope.tx, taskId, head);
    return head;
  });
  if (adopted !== null) {
    (options.logger ?? silentLogger).info(
      { task_id: taskId, ready_head: adopted },
      'a task that passed QA before S-28.18 had no reviewed head recorded; the head CI passed and the rebase gate agreed with is recorded now',
    );
  }
  return adopted;
};

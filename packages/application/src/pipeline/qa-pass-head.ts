/**
 * **A task that passes QA enters Ready with the head the gates judged** (S-28.18, BACKLOG 1616,
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
 * fail-closed direction and it is stated rather than closed (BACKLOG 1623).
 *
 * ## Tasks already waiting (the recovery)
 *
 * A task that entered Ready from `qa` before this shipped holds `null`. On a pipeline with `qa`
 * enabled every Ready entry is QA's pass (the rebase gate passes to `qa`; the `ready_head_check`
 * duty re-enters `rebase_gate`; the platform merge's rebase acceptance writes a head), so the same
 * rule answers it: {@link adoptQaPassHead} records `ci_head_sha` once, from the `ready_merge_check`
 * duty, and the recovery pass's `ready_merge_check` row finds such a task due
 * (`readyMergeCheckDue`: at Ready, `qa_stage`, no `ready_head_sha`, a `ci_head_sha`, no path CI
 * excused — the same columns {@link qaPassHeadToAdopt} reads, so the row never re-reads a task the
 * recovery refuses). The write is conditional in its own statement (`saveReadyHead`'s
 * `onlyIfUnset`), so it happens once and never over a recorded head; afterwards the task is due
 * only on the row's existing terms.
 *
 * ## The protected paths CI excused (WP-102)
 *
 * The rebase gate's settlement is the one reader of the review's confirmation of the paths CI
 * excused provisionally, and a person's **hand-back into `qa`** (after a take-over) skips that
 * settlement. So both writers ask it again inside their own transaction ({@link judgedQaPassHead},
 * `confirmExcusedPaths`): a path the latest review did not confirm means **no head is recorded**,
 * the platform merge waits `head_not_recorded`, and a person decides — protected-path changes
 * nobody confirmed are never merged by the platform.
 *
 * ## The residual, stated
 *
 * A person who **hands back** into `qa` skips the rebase gate's entry into `qa`; QA's pass then
 * carries the last head CI passed. The protected-path confirmation is asked again (above), and the
 * platform merge still merges only that head, only with the provider's "mergeable" and an approving
 * review, so a push during the take-over is `head_moved`. What is not re-read is the rebase gate's
 * own mergeability judgement against the target branch (the provider's "mergeable" stands in) and
 * its conflict warning. Recorded as BACKLOG 1623.
 */
import type { Id } from '@platform/contracts';
import {
  type CompiledPipeline,
  compilePipeline,
  READY_FOR_MERGE_STAGE,
  stageOf,
} from '@platform/domain';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { Transaction } from '../ports/transaction.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { CI_GATE_STAGE } from './gates.js';
import type { PipelineStore, StoredTask } from './store.js';
import { confirmExcusedPaths } from './tamper-confirmation.js';

/** Is `id` an enabled stage of `kind` in this pipeline? */
const runs = (pipeline: CompiledPipeline, id: string, kind: 'gate'): boolean => {
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
 * **The head QA's pass may record, asked inside the transaction that records it.** {@link
 * qaPassHead}, unless the paths CI excused provisionally are not confirmed by the latest review
 * (WP-102, `confirmExcusedPaths`): the rebase gate's settlement is that confirmation's reader, and a
 * person's hand-back into `qa` skips it — so a head over unconfirmed protected paths is not
 * recorded, the platform merge waits `head_not_recorded`, and a person decides.
 */
export const judgedQaPassHead = async (
  store: Pick<PipelineStore, 'artifacts'>,
  tx: Transaction,
  pipeline: CompiledPipeline,
  stored: StoredTask,
): Promise<string | null> => {
  const head = qaPassHead(pipeline, stored);
  if (head === null) {
    return null;
  }
  const confirmation = await confirmExcusedPaths(store, tx, stored);
  return confirmation?.kind === 'unconfirmed' ? null : head;
};

/**
 * May the recovery record a head for this task? At `ready_for_merge` with no recorded head, with
 * `qa_stage` (its Ready entry was QA's pass) and a head CI passed (so the frozen template runs
 * `ci_gate`: nothing else writes that column). Pure, and **the same columns the recovery row reads**
 * (`readyMergeCheckDue`'s S-28.18 clause), so a task the row finds is a task this accepts. The row
 * also asks for no excused paths, which makes {@link judgedQaPassHead}'s confirmation vacuous for
 * it — so it never re-reads a task the recovery refuses; a task woken otherwise (`mr_ready`, a
 * resolution signal) has the confirmation asked.
 */
export const qaPassHeadToAdopt = (stored: StoredTask): string | null =>
  stored.task.state === 'ready_for_merge' &&
  stored.task.currentStage === READY_FOR_MERGE_STAGE &&
  stored.readyHeadSha === null &&
  stored.qaStage
    ? stored.ciHeadSha
    : null;

/**
 * The recovery's write (S-28.18): records the head as `ready_head_sha` in a transaction that
 * re-reads the task, through a statement conditional on the column still being `null`
 * (`saveReadyHead`'s `onlyIfUnset`), so it writes once and never over a head an entry recorded.
 * Answers the head it recorded, or `null` when it wrote nothing.
 */
export const adoptQaPassHead = async (
  options: {
    readonly unitOfWork: UnitOfWork;
    readonly store: Pick<PipelineStore, 'tasks' | 'artifacts'>;
    readonly logger?: Logger;
  },
  taskId: Id,
): Promise<string | null> => {
  const adopted = await options.unitOfWork.transaction(async (scope) => {
    const current = await options.store.tasks.load(scope.tx, taskId);
    if (current === null || qaPassHeadToAdopt(current) === null) {
      return null;
    }
    const pipeline = compilePipeline(
      current.task.template,
      current.template,
      current.pipelineDial,
      current.qaStage,
    );
    const head = await judgedQaPassHead(options.store, scope.tx, pipeline, current);
    if (head === null) {
      return null;
    }
    const wrote = await options.store.tasks.saveReadyHead(scope.tx, taskId, head, {
      onlyIfUnset: true,
    });
    return wrote ? head : null;
  });
  if (adopted !== null) {
    (options.logger ?? silentLogger).info(
      { task_id: taskId, ready_head: adopted },
      'a task that passed QA before S-28.18 had no reviewed head recorded; the head CI passed and the rebase gate agreed with is recorded now',
    );
  }
  return adopted;
};

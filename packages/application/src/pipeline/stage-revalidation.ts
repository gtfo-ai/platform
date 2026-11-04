/**
 * The executor's re-validation, in a module of its own since WP-275 so that both the job
 * (`stage-executor.ts`, at admission and again after the plan) and `settleRun` (`settle.ts`, at a
 * shutdown hand-back) ask the same four questions without one module importing the other's values.
 */
import type { AgentRole } from '@platform/contracts';
import type { PipelineStage } from '@platform/domain';
import { compilePipeline, isRunnableTaskState, stageOf } from '@platform/domain';
import type { StageExecutionJob } from './stage-executor.js';
import type { StoredTask } from './store.js';

/**
 * The four questions TD-004 makes the executor re-ask every time a job fires: does the task exist,
 * has it stopped, is this attempt current, and is this stage an agent stage?
 *
 * Factored out because **it is asked twice** since WP-17 — once to admit the job and once after the
 * context pack has been assembled, which happens outside any transaction. Two copies of a
 * re-validation is one copy that drifts (standing rule 41's shape).
 */
export const revalidate = (
  stored: StoredTask | null,
  job: StageExecutionJob,
):
  | { readonly kind: 'skipped'; readonly reason: string; readonly supersededBy?: number }
  | {
      readonly kind: 'ok';
      readonly stored: StoredTask;
      readonly stage: PipelineStage;
      readonly role: AgentRole;
    } => {
  if (stored === null) return { kind: 'skipped', reason: 'the task no longer exists' };
  const { task } = stored;
  // Not `state === 'active'`: the retrospective runs in the `retro` state. What disqualifies a
  // run is the task having stopped — paused, parked for a human, waiting, or finished.
  if (!isRunnableTaskState(task.state) || task.currentStage !== job.stage) {
    return {
      kind: 'skipped',
      reason: `the task is "${task.state}" at "${task.currentStage ?? 'no stage'}", not running at "${job.stage}"`,
    };
  }
  if ((task.stageAttempts[job.stage] ?? 0) !== job.attempt) {
    const current = task.stageAttempts[job.stage] ?? 0;
    return {
      kind: 'skipped',
      reason: `attempt ${job.attempt} of "${job.stage}" has been superseded by attempt ${current}`,
      // Only forward: a job for a *later* attempt than the task's is not a wake-up anybody owes.
      ...(current > job.attempt ? { supersededBy: current } : {}),
    };
  }
  const stage = stageOf(
    compilePipeline(task.template, stored.template, stored.pipelineDial, stored.qaStage),
    job.stage,
  );
  if (stage === null || stage.kind !== 'agent' || stage.role === null) {
    return {
      kind: 'skipped',
      reason: `"${job.stage}" is not an agent stage of template "${task.template}"`,
    };
  }
  return { kind: 'ok', stored, stage, role: stage.role };
};

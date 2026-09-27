/**
 * The paths a pipeline task's own merge request changes, read before a **Reviewer** run — WP-73,
 * PROGRESS backlog 218, route (a).
 *
 * `reviewChecklistsOf` matched a first pipeline review's risk classes on the Implementation Plan's
 * paths alone, because `tasks.risk_classes` is written by the rebase gate, after `code_review`. So
 * a path the plan did not name escaped the checklist exactly when it mattered most — the model
 * under-declared a `payments` path, plan approval did not fire, and the stricter review was not
 * given either. This is the `stage.execute` job reading the changed files first, the shape WP-15f's
 * ticket snapshot already has: **outside every transaction**, between the job's load and the
 * executor, through the same coalesced read the rebase gate's duties share (`diff-coalescer.ts`),
 * so a review at the revision the Developer stage pushed costs no second provider call within the
 * window. Route (b) — firing `risk_route` on `code_review` entry — was not taken: the outbound job
 * and `stage.execute` are separate queue jobs, so the planner would race the column.
 *
 * **It never fails the stage.** A read that throws, a project with no git binding and a task with
 * no merge request all answer `undefined`, and the planner then matches on the plan and logs that
 * source — the review runs with fewer classes rather than not at all (standing rule 20: the missing
 * read is named, in the log and the source, not substituted).
 *
 * The paths are provider text, **redacted** with the git binding's redactor before anything
 * compares them, and they are only ever compared with `paths:`-style globs; the class names the
 * match yields are the project's configuration.
 */
import type { PipelineStage } from '@platform/domain';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import { coalescedMergeRequestDiff, MAX_CONFLICT_FILES } from './diff-coalescer.js';

import { integrationsForProject, noRunScopedSecrets } from './integrations.js';
import type { PipelineSagaOptions } from './saga.js';
import type { StoredTask } from './store.js';

export const reviewedMergeRequestPaths = async (
  options: Pick<PipelineSagaOptions, 'integrations' | 'clock' | 'logger'>,
  stored: StoredTask,
  stage: PipelineStage,
): Promise<readonly string[] | undefined> => {
  if (
    stage.kind !== 'agent' ||
    stage.role !== 'reviewer' ||
    stored.mr === null ||
    (stored.reviewSubject ?? null) !== null
  ) {
    return undefined;
  }
  const logger: Logger = options.logger ?? silentLogger;
  const context = { projectId: stored.task.projectId, taskId: stored.task.id };
  try {
    const integrations = await integrationsForProject(
      options.integrations,
      stored.task.projectId,
      noRunScopedSecrets(),
    );
    const files = await coalescedMergeRequestDiff(
      { port: options.integrations, integrations, now: options.clock.now() },
      stored.mr,
      MAX_CONFLICT_FILES,
      context,
    );
    if (files === null) {
      return undefined;
    }
    const redactor = integrations.git?.redactor ?? null;
    return files
      .map((file) => file.new_path)
      .filter((path) => path !== '')
      .map((path) => (redactor === null ? path : redactor.redactText(path).value));
  } catch (error) {
    logger.warn(
      { task_id: stored.task.id, stage: stage.id, err: error },
      'the merge request’s changed files could not be read before the review; its checklists are matched on the plan alone',
    );
    return undefined;
  }
};

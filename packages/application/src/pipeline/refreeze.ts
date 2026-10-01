/**
 * Re-taking the frozen values of a task created under a `configRefusal` — WP-106, migration 0066,
 * PROGRESS backlogs 311 and 354.
 */
import {
  iterationLimitsFor,
  type ProjectSettings,
  pipelineDialFor,
  templateForIssueType,
} from './settings.js';
import type { StoredTask } from './store.js';

/**
 * What a refusal adds for a task whose frozen values were taken under a `configRefusal` (WP-106,
 * migration 0066): no run is admitted until the document parses, and the first one that is takes
 * the limits and the dial again — the reader of the brief learns both, so "fix it and resume" is
 * known to be safe.
 */
export const REFREEZE_PENDING_SENTENCE =
  'This task was created while the configuration could not be read, so it holds the platform’s ' +
  'default iteration limits and autonomy dial (and, if intake routed it, the default pipeline); no ' +
  'run of it starts until the configuration parses, and it then takes them again from the ' +
  'corrected configuration — the pipeline only while it is still at intake';

/**
 * The task with its frozen values taken again from readable settings, or the same object when it
 * was not created under a `configRefusal` (WP-106).
 *
 *  - **The limits**, from the parsed document.
 *  - **The dial**, only where one was frozen: `null` is the creating site's statement that no dial
 *    applies (discovery, a review-only task), or a project whose dial was never materialised, and
 *    neither is a value the refusal chose.
 *  - **The template** (review round 2), for a task intake created: intake chose it with the refused
 *    document's `features.spike` and `features.epic_split` read as off, so a Spike ticket became a
 *    `feature` task and an epic one task. It is routed again exactly as intake would have routed
 *    it on the parsed document, from the inputs intake kept (`refreezeRouting`: the issue type and
 *    whether the tracker binding could create tickets) — but **only while the task is still at
 *    `intake`**, every shipped template's first stage, because a task that has entered another
 *    stage cannot change pipelines under itself. At any later stage the template stays and only the
 *    limits and dial are taken again (the stage executor's admission backstop; the
 *    stage-completion handler at `intake` is where a marked task meets this first).
 */
export const refrozen = (stored: StoredTask, settings: ProjectSettings): StoredTask => {
  if (stored.settingsRefreezePending !== true) {
    return stored;
  }
  const routing = stored.refreezeRouting ?? null;
  const reroute = routing !== null && stored.task.currentStage === INTAKE_STAGE;
  const templateId = reroute
    ? templateForIssueType(settings, routing.issueType, {
        canCreateTickets: routing.canCreateTickets,
        shadow: stored.task.mode === 'shadow',
      })
    : stored.task.template;
  const template = settings.templates[templateId] ?? stored.template;
  return {
    ...stored,
    task: {
      ...stored.task,
      limits: iterationLimitsFor(settings),
      template: settings.templates[templateId] === undefined ? stored.task.template : templateId,
    },
    template,
    pipelineDial: stored.pipelineDial === null ? null : pipelineDialFor(settings),
    settingsRefreezePending: false,
    refreezeRouting: null,
  };
};

/** The first stage of every shipped template — where a template may still be routed again. */
const INTAKE_STAGE = 'intake';

/** {@link refrozen}'s answer, as `TaskRepository.refreezeSettings` takes it. */
export const refrozenColumns = (stored: StoredTask) => ({
  limits: stored.task.limits,
  pipelineDial: stored.pipelineDial,
  templateId: stored.task.template,
  template: stored.template,
});

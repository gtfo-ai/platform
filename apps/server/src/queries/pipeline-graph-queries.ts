/**
 * The two reads behind `GET /api/tasks/:task_id/pipeline` and `GET /api/projects/:project_id/pipeline`
 * (S-23.15) — `pipeline-graph.ts`'s pure graph over the rows and the settings that decide it.
 *
 * **A task's graph is its frozen pipeline**: `tasks.template_snapshot` (the shipped template of that
 * name for a row written before snapshots), its frozen dial, `qa_stage` and `iteration_limits` —
 * never the project's settings today, which would answer "what did this task run?" with what a
 * task started now would run. Only an agent stage the task has **not** run yet takes the
 * project's configured model and effort, because there is no run to read them off.
 *
 * **A project's graphs are what a task started now would freeze**: `settings.templates` compiled
 * with the dial and `qa_stage` the creating site would freeze (`pipelineDialFor`, the binding's
 * `qa` slot) for the templates intake routes tickets onto, and with neither for the one-off
 * templates whose creating sites freeze none (discovery, review-only, the linter, the history
 * bootstrap). Without `?template=` the answer lists the **enabled** templates: the three ticket
 * templates and discovery always, each opt-in template only while its feature is on
 * (`features.spike`, `.epic_split`, `.review_only`, `.ticket_linter`, `.history_bootstrap`), and a
 * template a project defined itself always. With `?template=` it answers that one whatever its
 * switch, because a maintainer deciding whether to turn a feature on is asking what it would run.
 *
 * Both refuse rather than invent: an unknown template is a 404, a template or a frozen column this
 * release cannot compile is a 409, and a project whose stored settings do not parse is a 409 —
 * drawing the platform defaults that stand in for them would be drawing a pipeline no run uses.
 */
import {
  configuredStageAgent,
  historyBootstrapSettings,
  iterationLimitsFor,
  type ProjectSettings,
  type ProjectSettingsPort,
  pipelineDialFor,
  resolveEpicSplitSettings,
  resolveReviewOnlySettings,
  resolveTicketLintSettings,
  spikeTemplateEnabled,
} from '@platform/application';
import type { Id, PipelineGraph } from '@platform/contracts';
import {
  DISCOVERY_TEMPLATE_ID,
  EPIC_SPLIT_TEMPLATE_ID,
  HISTORY_BOOTSTRAP_TEMPLATE_ID,
  SHIPPED_TEMPLATES,
  SPIKE_TEMPLATE_ID,
  TICKET_TEMPLATES,
} from '@platform/domain';
import { db as dbAdapters } from '@platform/infrastructure';
import { asc, desc, eq } from 'drizzle-orm';
import {
  compileProjectTemplate,
  compileTaskPipeline,
  type GraphRefusal,
  pipelineGraphOf,
  type StageAgent,
} from './pipeline-graph.js';

const { projects, runs, taskStages, tasks } = dbAdapters.schema;

type Database = dbAdapters.Database;

export type TaskGraphResult =
  | { readonly kind: 'graph'; readonly graph: PipelineGraph }
  | { readonly kind: 'not_found' }
  | GraphRefusal;

export type ProjectGraphsResult =
  | { readonly kind: 'graphs'; readonly items: readonly PipelineGraph[] }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'config_refused' }
  | GraphRefusal;

/**
 * Whether a shipped template is **on** for the project — the switch its creating site asks. A
 * template absent from this table (one the project defined) is on.
 */
const TEMPLATE_SWITCHES: Readonly<Record<string, (settings: ProjectSettings) => boolean>> = {
  ...Object.fromEntries(Object.keys(TICKET_TEMPLATES).map((id) => [id, () => true])),
  [DISCOVERY_TEMPLATE_ID]: () => true,
  [SPIKE_TEMPLATE_ID]: spikeTemplateEnabled,
  [EPIC_SPLIT_TEMPLATE_ID]: (settings) => resolveEpicSplitSettings(settings).enabled,
  review_only: (settings) => resolveReviewOnlySettings(settings).enabled,
  ticket_lint: (settings) => resolveTicketLintSettings(settings).enabled,
  [HISTORY_BOOTSTRAP_TEMPLATE_ID]: (settings) => historyBootstrapSettings(settings).enabled,
};

/**
 * The templates whose creating site freezes no dial and no `qa_stage` (`pipelineDial: null`,
 * `qaStage: false` at `onboarding/discovery.ts`, `review-only.ts`, `ticket-lint.ts`,
 * `bootstrap/collect.ts`). Every other template is reached through intake (`saga.ts`), which
 * freezes both.
 */
const ONE_OFF_TEMPLATES: ReadonlySet<string> = new Set([
  DISCOVERY_TEMPLATE_ID,
  'review_only',
  'ticket_lint',
  HISTORY_BOOTSTRAP_TEMPLATE_ID,
]);

/** The enabled templates of a project, in the shipped order and then the project's own. */
export const enabledTemplateIds = (settings: ProjectSettings): string[] =>
  Object.keys(settings.templates).filter((id) => TEMPLATE_SWITCHES[id]?.(settings) ?? true);

/** One of a project's templates as a task started now would compile it. */
export const projectTemplateGraph = (
  settings: ProjectSettings,
  id: string,
): { readonly kind: 'graph'; readonly graph: PipelineGraph } | GraphRefusal => {
  const template = settings.templates[id];
  if (template === undefined) {
    return { kind: 'unknown_template', template: id };
  }
  const oneOff = ONE_OFF_TEMPLATES.has(id);
  const compiled = compileProjectTemplate(
    id,
    template,
    oneOff ? null : pipelineDialFor(settings),
    oneOff ? false : settings.ticketLifecycle?.slots.qa !== undefined,
  );
  if (compiled.kind !== 'compiled') {
    return compiled;
  }
  return {
    kind: 'graph',
    graph: pipelineGraphOf(compiled.pipeline, {
      limits: iterationLimitsFor(settings),
      agentOf: (stage) => configuredStageAgent(settings, stage),
    }),
  };
};

export interface PipelineGraphReaders {
  readonly taskGraph: (taskId: string) => Promise<TaskGraphResult>;
  readonly projectGraphs: (
    projectId: string,
    template: string | null,
  ) => Promise<ProjectGraphsResult>;
}

export const databasePipelineGraphReaders = (
  database: Database,
  projectSettings: ProjectSettingsPort,
): PipelineGraphReaders => ({
  taskGraph: async (taskId) => {
    const rows = await database
      .select({
        projectId: tasks.projectId,
        template: tasks.template,
        templateSnapshot: tasks.templateSnapshot,
        pipelineDial: tasks.pipelineDial,
        qaStage: tasks.qaStage,
        iterationLimits: tasks.iterationLimits,
      })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1);
    const task = rows[0];
    if (task === undefined) {
      return { kind: 'not_found' };
    }
    const compiled = compileTaskPipeline(task, SHIPPED_TEMPLATES);
    if (compiled.kind !== 'compiled') {
      return compiled;
    }
    // The latest run of each stage: what the task actually ran that stage with.
    const ran = await database
      .selectDistinctOn([taskStages.stage], {
        stage: taskStages.stage,
        model: runs.model,
        effort: runs.effort,
      })
      .from(runs)
      .innerJoin(taskStages, eq(taskStages.id, runs.taskStageId))
      .where(eq(runs.taskId, taskId))
      .orderBy(asc(taskStages.stage), desc(runs.createdAt), desc(runs.id));
    const byStage = new Map<string, StageAgent>(
      ran.map((row) => [row.stage, { model: row.model, effort: row.effort }]),
    );
    const notRun = compiled.pipeline.stages.some(
      (stage) => stage.kind === 'agent' && !byStage.has(stage.id),
    );
    const settings = notRun ? await projectSettings.forProject(task.projectId as Id) : null;
    return {
      kind: 'graph',
      graph: pipelineGraphOf(compiled.pipeline, {
        limits: compiled.limits,
        // `settings` is read exactly when some agent stage has no run, so it is non-null whenever
        // the fallback is reached.
        agentOf: (stage) =>
          byStage.get(stage) ?? configuredStageAgent(settings as ProjectSettings, stage),
      }),
    };
  },

  projectGraphs: async (projectId, template) => {
    const exists = await database
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (exists[0] === undefined) {
      return { kind: 'not_found' };
    }
    const settings = await projectSettings.forProject(projectId as Id);
    if (settings.configRefusal !== undefined) {
      return { kind: 'config_refused' };
    }
    const items: PipelineGraph[] = [];
    for (const id of template === null ? enabledTemplateIds(settings) : [template]) {
      const graph = projectTemplateGraph(settings, id);
      if (graph.kind !== 'graph') {
        return graph;
      }
      items.push(graph.graph);
    }
    return { kind: 'graphs', items };
  },
});

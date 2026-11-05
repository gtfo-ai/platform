/**
 * The compiled stage graph (S-23.15, TD-033 decision 8 (a)) — what the flow canvas draws for a
 * project's templates and for one task.
 *
 * ## The edges are the interpreter's answers, not a second reading of the template
 *
 * {@link pipelineGraphOf} does not walk `approve_to`/`return_to`/`pass_to`/`fail_to`/`on` itself.
 * It asks `interpret` — the function that moves every real task — the question each edge stands
 * for (*this agent stage approved*, *this gate failed*, *this event arrived at this human stage*)
 * and draws the decision: `enter` is an edge to that stage, `return` is an edge carrying the loop
 * it spends, and `complete`, `wait` and `escalate` draw nothing. So disabled stages are walked over
 * exactly as a task walks over them, a return with no bounded loop is absent because a task would
 * escalate there, and a dial's `stop_after_stage` removes the forward edge it halts — the graph is
 * the pipeline the interpreter runs, and there is no second rule set to drift from it.
 *
 * Only **enabled** stages have outgoing edges (a disabled stage is never entered); every stage is
 * a node, with `enabled` saying which. An **advisory** agent stage has no `return` edge, because
 * its completion always advances (`agentStageSchema.advisory`).
 *
 * ## The settings applied
 *
 * `loop_limit` is the ceiling from the limits handed in — a task's **frozen** `iteration_limits`,
 * or the project's `iterationLimitsFor` for a template — and `model`/`effort` come from
 * {@link GraphSettings.agentOf}: for a task, the model and effort of the latest run of that stage
 * when one exists (what it actually ran with), else the project's configured value
 * (`configuredStageAgent`), which is what a run started now would use.
 */
import type {
  DomainEventType,
  PipelineGraph,
  PipelineGraphEdge,
  PipelineGraphNode,
  PipelineTemplate,
  TaskPipelineDial,
} from '@platform/contracts';
import { taskPipelineDialSchema } from '@platform/contracts';
import {
  type CompiledPipeline,
  compilePipeline,
  type IterationLimits,
  interpret,
  type PipelineDecision,
  type PipelineSignal,
  type PipelineStage,
  resolveIterationLimits,
} from '@platform/domain';

/** The model and effort an agent stage runs (or ran) with. */
export interface StageAgent {
  readonly model: string;
  readonly effort: 'low' | 'medium' | 'high';
}

export interface GraphSettings {
  readonly limits: IterationLimits;
  readonly agentOf: (stage: string) => StageAgent;
}

type EdgeKind = PipelineGraphEdge['kind'];

/** The questions an enabled stage's outgoing edges answer, one signal each. */
const questionsFor = (
  stage: PipelineStage,
): readonly { kind: EdgeKind; onEvent: DomainEventType | null; signal: PipelineSignal }[] => {
  switch (stage.kind) {
    case 'system':
      return [
        {
          kind: 'next',
          onEvent: null,
          signal: { kind: 'stage_completed', stage: stage.id, verdict: null },
        },
      ];
    case 'agent':
      return [
        {
          kind: 'approve',
          onEvent: null,
          signal: { kind: 'stage_completed', stage: stage.id, verdict: 'approve' },
        },
        ...(stage.advisory
          ? []
          : [
              {
                kind: 'return' as const,
                onEvent: null,
                signal: {
                  kind: 'stage_completed' as const,
                  stage: stage.id,
                  verdict: 'request_changes',
                },
              },
            ]),
      ];
    case 'gate':
      return [
        {
          kind: 'pass',
          onEvent: null,
          signal: { kind: 'gate_settled', stage: stage.id, passed: true, detail: 'graph' },
        },
        {
          kind: 'fail',
          onEvent: null,
          signal: { kind: 'gate_settled', stage: stage.id, passed: false, detail: 'graph' },
        },
      ];
    case 'human':
      return stage.on
        .filter((transition) => transition.to !== null)
        .map((transition) => ({
          kind: 'on' as const,
          onEvent: transition.on,
          signal: {
            kind: 'event' as const,
            stage: stage.id,
            event: transition.on,
            detail: 'graph',
          },
        }));
  }
};

const edgeOf = (
  from: string,
  kind: EdgeKind,
  onEvent: DomainEventType | null,
  decision: PipelineDecision,
): PipelineGraphEdge | null => {
  switch (decision.kind) {
    case 'enter':
      return { from, to: decision.stage, kind, on_event: onEvent, loop: null };
    case 'return':
      return { from, to: decision.to, kind, on_event: onEvent, loop: decision.loop };
    default:
      return null;
  }
};

/** A compiled pipeline → the published graph. Pure; the unit tier runs it over every template. */
export const pipelineGraphOf = (
  compiled: CompiledPipeline,
  settings: GraphSettings,
): PipelineGraph => {
  const edges: PipelineGraphEdge[] = [];
  for (const stage of compiled.stages) {
    if (!stage.enabled) {
      continue;
    }
    for (const question of questionsFor(stage)) {
      const edge = edgeOf(
        stage.id,
        question.kind,
        question.onEvent,
        interpret(compiled, question.signal),
      );
      if (edge !== null) {
        edges.push(edge);
      }
    }
  }
  const nodes = compiled.stages.map((stage): PipelineGraphNode => {
    const loop = edges.find((edge) => edge.from === stage.id && edge.loop !== null)?.loop ?? null;
    const agent = stage.kind === 'agent' ? settings.agentOf(stage.id) : null;
    return {
      id: stage.id,
      kind: stage.kind,
      role: stage.role,
      enabled: stage.enabled,
      advisory: stage.advisory,
      model: agent?.model ?? null,
      effort: agent?.effort ?? null,
      loop,
      loop_limit: loop === null ? null : settings.limits[loop as keyof IterationLimits],
    };
  });
  return { template: compiled.templateId, nodes, edges };
};

/** Why a task's or a template's graph cannot be drawn. */
export type GraphRefusal =
  | { readonly kind: 'unknown_template'; readonly template: string }
  | { readonly kind: 'not_compilable'; readonly template: string; readonly why: string };

/** The columns a task's graph is compiled from (`tasks`). */
export interface TaskGraphColumns {
  readonly template: string;
  readonly templateSnapshot: unknown;
  readonly pipelineDial: unknown;
  readonly qaStage: boolean;
  readonly iterationLimits: unknown;
}

/**
 * The task's frozen pipeline, compiled as the pipeline store compiles it: the snapshot, else the
 * shipped template of that name for a row written before snapshots; the frozen dial (refused when
 * it does not parse, as the store refuses it) and `qa_stage`; the frozen limits over the defaults.
 */
export const compileTaskPipeline = (
  task: TaskGraphColumns,
  shipped: Readonly<Record<string, PipelineTemplate>>,
):
  | {
      readonly kind: 'compiled';
      readonly pipeline: CompiledPipeline;
      readonly limits: IterationLimits;
    }
  | GraphRefusal => {
  const snapshot = task.templateSnapshot;
  const template =
    snapshot !== null && typeof snapshot === 'object' && 'stages' in snapshot
      ? (snapshot as PipelineTemplate)
      : shipped[task.template];
  if (template === undefined) {
    return { kind: 'unknown_template', template: task.template };
  }
  // Parsed as the store parses it, and refused the same way (`pipeline-queries.ts`'s reading).
  const dial =
    task.pipelineDial === null || task.pipelineDial === undefined
      ? null
      : taskPipelineDialSchema.safeParse(task.pipelineDial);
  if (dial !== null && !dial.success) {
    return {
      kind: 'not_compilable',
      template: task.template,
      why: 'its frozen pipeline_dial does not match the schema this release reads',
    };
  }
  const limits = frozenLimits(task.iterationLimits);
  if (limits === null) {
    return {
      kind: 'not_compilable',
      template: task.template,
      why: 'its frozen iteration_limits are not a map of non-negative whole numbers',
    };
  }
  try {
    return {
      kind: 'compiled',
      pipeline: compilePipeline(
        task.template,
        template,
        dial === null ? null : dial.data,
        task.qaStage,
      ),
      limits,
    };
  } catch (error) {
    return { kind: 'not_compilable', template: task.template, why: compileError(error) };
  }
};

/** `tasks.iteration_limits` over the defaults, as the store reads it; `null` for a malformed one. */
export const frozenLimits = (stored: unknown): IterationLimits | null => {
  const defaults = resolveIterationLimits();
  if (stored === null || stored === undefined) {
    return defaults;
  }
  if (typeof stored !== 'object' || Array.isArray(stored)) {
    return null;
  }
  const merged: Record<string, number> = { ...defaults };
  for (const [key, value] of Object.entries(stored)) {
    if (!Object.hasOwn(defaults, key)) {
      continue;
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      return null;
    }
    merged[key] = value;
  }
  return merged as IterationLimits;
};

/**
 * The validator's message names the template's own stage ids (project data, not model output);
 * it is cut so a long list of issues cannot become a long response.
 */
const compileError = (error: unknown): string =>
  (error instanceof Error ? error.message : 'the template does not validate').slice(0, 300);

/**
 * Compiles one of a project's templates with the facts a task started now would freeze — the one
 * `compilePipeline` site that is not handed a task's frozen copy, because there is no task: it is
 * the project's template preview, and `compile-sites.test.ts` names it as such.
 */
export const compileProjectTemplate = (
  id: string,
  template: PipelineTemplate,
  dial: TaskPipelineDial | null,
  qaStage: boolean,
): { readonly kind: 'compiled'; readonly pipeline: CompiledPipeline } | GraphRefusal => {
  try {
    return { kind: 'compiled', pipeline: compilePipeline(id, template, dial, qaStage) };
  } catch (error) {
    return { kind: 'not_compilable', template: id, why: compileError(error) };
  }
};

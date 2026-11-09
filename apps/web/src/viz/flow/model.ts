/**
 * What the flow canvas draws (TD-033 decision 8 (a)): a compiled stage graph, as a template or as
 * one task's progress through it. Pure — no React, no `@xyflow/react` — so the canvas, the list
 * fallback and the stage dialog read one model, and the unit tier holds it without a DOM.
 *
 * ## Two modes, one shape
 *
 * - **Template** (the Pipeline tab): every node of `GET /api/projects/:id/pipeline`'s graph, with
 *   no state but *disabled*; a loop pill says the ceiling ("Review ≤3").
 * - **Task** (the task page): the task's frozen graph (`GET /api/tasks/:id/pipeline`) with each
 *   stage's state read the way `PhaseTrack` reads it (`phaseStagesFor`, so the strip on a board
 *   card and the card on the canvas never disagree), the stage's latest attempt and run, and on the
 *   current stage the activity (`activityOf`) — "● Working · Now: Reading files". A loop pill says
 *   what the task has spent ("Review · used 1 of 3", off `tasks.iteration_counters`).
 *
 * Every string this module produces is platform text. The run's own words — the transcript — are
 * the dialog's (`activity-rows.ts`), and they stay untrusted there.
 */
import type {
  AgentRole,
  ArtifactType,
  PipelineGraph,
  PipelineGraphEdge,
  RunRecord,
  TaskDetailResponse,
} from '@platform/contracts';
import { latestRunOf } from '../../features/stage-timeline.js';
import { type ActivityResult, activityOf, type LatestEntry } from '../../ui/activity.js';
import { stageLabel } from '../../ui/humanize.js';
import { type PhaseState, phaseStagesFor } from '../../ui/phase-track.js';
import { loopLabel } from '../../ui/words/loops.js';

/** A stage's state on the canvas: `PhaseTrack`'s six, plus a stage the pipeline walks over. */
export type FlowState = PhaseState | 'disabled';

export const FLOW_STATES: readonly FlowState[] = [
  'done',
  'current',
  'upcoming',
  'returned',
  'failed',
  'skipped',
  'disabled',
];

export type StageKind = PipelineGraph['nodes'][number]['kind'];

export interface FlowNode {
  readonly id: string;
  readonly label: string;
  readonly kind: StageKind;
  readonly role: AgentRole | null;
  readonly enabled: boolean;
  readonly advisory: boolean;
  readonly model: string | null;
  readonly effort: 'low' | 'medium' | 'high' | null;
  readonly produces: ArtifactType | null;
  /** `null` for a template's stage that is enabled: a template has no progress. */
  readonly state: FlowState | null;
  /** The stage's latest attempt number, or `null` when the task never entered it. */
  readonly attempt: number | null;
  /** The latest run of the latest attempt (task mode), or `null`. */
  readonly run: RunRecord | null;
  /** How long the latest attempt took, for a stage that is done. */
  readonly durationMs: number | null;
  /** On the current stage only: what its agent is doing (`activityOf`). */
  readonly activity: ActivityResult | null;
}

export interface FlowEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly kind: PipelineGraphEdge['kind'];
  /** The event a human stage's `on` edge waits for (`mr.merged`), else `null`. */
  readonly onEvent: string | null;
  readonly loop: string | null;
  readonly loopLimit: number | null;
  /** How many rounds of `loop` the task has spent (task mode); `null` for a template. */
  readonly loopUsed: number | null;
  /** The loop pill's words, or `null` for an edge that spends no loop. */
  readonly pill: string | null;
  /** An edge into the current stage while its run is live: drawn animated. */
  readonly live: boolean;
  /** Both ends were entered by the task. */
  readonly traversed: boolean;
}

export interface FlowGraph {
  readonly mode: 'template' | 'task';
  readonly template: string;
  readonly nodes: readonly FlowNode[];
  readonly edges: readonly FlowEdge[];
}

const LIVE: readonly RunRecord['status'][] = ['created', 'starting', 'running'];

const edgeId = (edge: PipelineGraphEdge, index: number): string =>
  `${edge.from}->${edge.to}:${edge.kind}:${edge.on_event ?? ''}:${index}`;

/** "Review rounds: up to 3" for a template; "Review rounds: 1 of 3 used" for a task (S-25.5). */
export const loopPill = (
  loop: string | null,
  limit: number | null,
  used: number | null,
): string | null => {
  if (loop === null) {
    return null;
  }
  const label = loopLabel(loop);
  if (used === null) {
    return limit === null ? label : `${label}: up to ${limit}`;
  }
  return limit === null ? `${label}: ${used} used` : `${label}: ${used} of ${limit} used`;
};

const baseNode = (node: PipelineGraph['nodes'][number]) => ({
  id: node.id,
  label: stageLabel(node.id),
  kind: node.kind,
  role: node.role,
  enabled: node.enabled,
  advisory: node.advisory,
  model: node.model,
  effort: node.effort,
  produces: node.produces,
});

/** A project's template: no progress, only what is configured. */
export const templateFlow = (graph: PipelineGraph): FlowGraph => ({
  mode: 'template',
  template: graph.template,
  nodes: graph.nodes.map(
    (node): FlowNode => ({
      ...baseNode(node),
      state: node.enabled ? null : 'disabled',
      attempt: null,
      run: null,
      durationMs: null,
      activity: null,
    }),
  ),
  edges: graph.edges.map(
    (edge, index): FlowEdge => ({
      id: edgeId(edge, index),
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      onEvent: edge.on_event,
      loop: edge.loop,
      loopLimit: edge.loop_limit,
      loopUsed: null,
      pill: loopPill(edge.loop, edge.loop_limit, null),
      live: false,
      traversed: false,
    }),
  ),
});

export interface TaskFlowInput {
  readonly graph: PipelineGraph;
  readonly detail: Pick<TaskDetailResponse, 'task' | 'stages' | 'runs' | 'questions' | 'approvals'>;
  /** What the live run last did — the transcript's newest entry, or the agents read's. */
  readonly latest: LatestEntry | null;
  /** The live run's seat is known to be late (the agents read cannot say so today: `false`). */
  readonly leaseLate?: boolean;
  /** Epoch milliseconds. */
  readonly now: number;
}

const durationOf = (row: TaskDetailResponse['stages'][number] | undefined): number | null => {
  if (row === undefined || row.exited_at === null) {
    return null;
  }
  const ms = Date.parse(row.exited_at) - Date.parse(row.entered_at);
  return Number.isNaN(ms) || ms < 0 ? null : ms;
};

/** One task's progress through its frozen graph. */
export const taskFlow = (input: TaskFlowInput): FlowGraph => {
  const { graph, detail, now } = input;
  const { task, stages, runs } = detail;
  const phases = phaseStagesFor(graph.nodes, stages, task.current_stage ?? null);
  const phaseOf = new Map(phases.map((phase) => [phase.id, phase.state]));
  const latestRow = new Map<string, TaskDetailResponse['stages'][number]>();
  for (const row of stages) {
    const previous = latestRow.get(row.stage);
    if (previous === undefined || row.attempt >= previous.attempt) {
      latestRow.set(row.stage, row);
    }
  }
  const openAsks =
    detail.questions.filter((question) => question.status === 'open').length +
    detail.approvals.filter((approval) => approval.status === 'pending').length;

  const nodes = graph.nodes.map((node): FlowNode => {
    const row = latestRow.get(node.id);
    const phase = phaseOf.get(node.id) ?? 'upcoming';
    // A stage the pipeline walks over, that the task never entered, is disabled rather than
    // "skipped" or "upcoming": nothing will ever run it on this task.
    const state: FlowState = !node.enabled && row === undefined ? 'disabled' : phase;
    const run =
      row === undefined
        ? null
        : (latestRunOf(runs, row) ??
          runs.reduce<RunRecord | null>(
            (last, item) => (item.stage === node.id ? item : last),
            null,
          ));
    const activity =
      state === 'current' || (state === 'failed' && node.id === task.current_stage)
        ? activityOf({
            run:
              run === null
                ? null
                : {
                    status: run.status,
                    terminal_reason: run.terminal_reason ?? null,
                    started_at: run.started_at ?? null,
                    start_failure: run.start_failure,
                    stop_reason: run.stop_reason,
                  },
            latest: run !== null && LIVE.includes(run.status) ? input.latest : null,
            role: node.role,
            task_state: task.state,
            // BACKLOG 814: the asks and the task's state belong to the current stage's run only.
            open_asks: openAsks,
            lease_late: input.leaseLate ?? false,
            now,
          })
        : null;
    return {
      ...baseNode(node),
      state,
      attempt: row?.attempt ?? null,
      run,
      durationMs: state === 'done' ? durationOf(row) : null,
      activity,
    };
  });

  const entered = new Set(stages.map((row) => row.stage));
  const current = nodes.find((node) => node.state === 'current') ?? null;
  const live =
    current?.run !== null && current?.run !== undefined && LIVE.includes(current.run.status);
  const counters = task.iteration_counters;
  // The way in that the task took: the forward edges into the live stage from a stage it entered —
  // or, when it entered none of their sources (a frozen row the read did not keep), all of them,
  // because the stage is running either way and the canvas should say where from.
  const waysIn =
    live && current !== null
      ? graph.edges.filter((edge) => edge.to === current.id && edge.loop === null)
      : [];
  const takenIn = waysIn.filter((edge) => entered.has(edge.from));
  const liveEdges = new Set(takenIn.length > 0 ? takenIn : waysIn);

  return {
    mode: 'task',
    template: graph.template,
    nodes,
    edges: graph.edges.map((edge, index): FlowEdge => {
      const used =
        edge.loop === null
          ? null
          : Object.hasOwn(counters, edge.loop)
            ? (counters[edge.loop] ?? 0)
            : 0;
      return {
        id: edgeId(edge, index),
        from: edge.from,
        to: edge.to,
        kind: edge.kind,
        onEvent: edge.on_event,
        loop: edge.loop,
        loopLimit: edge.loop_limit,
        loopUsed: used,
        pill: loopPill(edge.loop, edge.loop_limit, used),
        live: liveEdges.has(edge),
        traversed: entered.has(edge.from) && entered.has(edge.to),
      };
    }),
  };
};

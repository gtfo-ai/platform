/**
 * The compiled stage graph (S-23.15) over **every shipped template**, plus the project-level
 * choices (which templates are enabled, which facts each compiles with) and the task-level
 * refusals. The edges are `interpret`'s answers, so these tests pin both the counts and the loop
 * names, and hold every edge to the interpreter's own `returnLoopFor` and to the enabled nodes.
 */
import { defaultProjectSettings, type ProjectSettings } from '@platform/application';
import type { Id, PipelineGraph, PipelineTemplate } from '@platform/contracts';
import { pipelineGraphSchema } from '@platform/contracts';
import {
  compilePipeline,
  resolveIterationLimits,
  returnLoopFor,
  SHIPPED_TEMPLATES,
} from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { compileTaskPipeline, frozenLimits, pipelineGraphOf } from './pipeline-graph.js';
import {
  enabledTemplateIds,
  projectTemplateGraph,
  taskStageAgent,
} from './pipeline-graph-queries.js';

const PROJECT = '00000000-0000-4000-8000-000000002315' as Id;

const graphOf = (
  id: string,
  qaStage = false,
  dial: Parameters<typeof compilePipeline>[2] = null,
): PipelineGraph =>
  pipelineGraphOf(compilePipeline(id, SHIPPED_TEMPLATES[id] as PipelineTemplate, dial, qaStage), {
    limits: resolveIterationLimits(),
    agentOf: (stage) => ({ model: `model-of-${stage}`, effort: 'medium' }),
  });

const spelled = (graph: PipelineGraph): string[] =>
  graph.edges.map(
    (edge) =>
      `${edge.from} ${edge.kind}${edge.on_event === null ? '' : `(${edge.on_event})`} → ${edge.to}${edge.loop === null ? '' : ` [${edge.loop}]`}`,
  );

/** Node count, edge count and the return loops, per shipped template, without and with `qa`. */
const EXPECTED: Readonly<
  Record<string, { nodes: number; edges: readonly [number, number]; loops: readonly string[] }>
> = {
  feature: {
    nodes: 15,
    edges: [21, 25],
    loops: [
      'architecture_revisions',
      'business_review',
      'ci_fix',
      'code_review',
      'human_rounds',
      'rebase',
      'rebase_rechecks',
    ],
  },
  bug: {
    nodes: 16,
    edges: [23, 27],
    loops: [
      'architecture_revisions',
      'business_review',
      'ci_fix',
      'code_review',
      'human_rounds',
      'rebase',
      'rebase_rechecks',
    ],
  },
  chore: {
    nodes: 13,
    edges: [17, 21],
    loops: [
      'architecture_revisions',
      'ci_fix',
      'code_review',
      'human_rounds',
      'rebase',
      'rebase_rechecks',
    ],
  },
  discovery: { nodes: 3, edges: [2, 2], loops: [] },
  review_only: { nodes: 3, edges: [3, 3], loops: [] },
  ticket_lint: { nodes: 3, edges: [2, 2], loops: [] },
  history_bootstrap: { nodes: 3, edges: [2, 2], loops: [] },
  spike: { nodes: 5, edges: [4, 4], loops: ['architecture_revisions'] },
  epic_split: { nodes: 5, edges: [5, 5], loops: ['architecture_revisions'] },
};

describe('the compiled stage graph of every shipped template', () => {
  it('covers exactly the shipped templates', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(Object.keys(SHIPPED_TEMPLATES).sort());
  });

  for (const id of Object.keys(SHIPPED_TEMPLATES)) {
    for (const qa of [false, true]) {
      it(`${id}${qa ? ' with qa' : ''}: counts, loops, and every edge the interpreter's`, () => {
        const graph = graphOf(id, qa);
        const expected = EXPECTED[id];
        expect(pipelineGraphSchema.parse(graph)).toEqual(graph);
        expect(graph.template).toBe(id);
        expect(graph.nodes).toHaveLength(expected?.nodes ?? -1);
        expect(graph.edges).toHaveLength(expected?.edges[qa ? 1 : 0] ?? -1);
        expect(
          [
            ...new Set(graph.edges.flatMap((edge) => (edge.loop === null ? [] : [edge.loop]))),
          ].sort(),
        ).toEqual(expected?.loops);
        const ids = graph.nodes.map((node) => node.id);
        const enabled = new Set(graph.nodes.filter((node) => node.enabled).map((node) => node.id));
        for (const edge of graph.edges) {
          // Out of an enabled stage and into one: a task never enters a disabled stage.
          expect(enabled.has(edge.from)).toBe(true);
          expect(enabled.has(edge.to)).toBe(true);
          // A loop exactly on a backwards edge, and the interpreter's loop for that edge.
          const backwards = ids.indexOf(edge.to) < ids.indexOf(edge.from);
          expect(edge.loop).toBe(backwards ? returnLoopFor(edge.from, edge.to) : null);
          expect(edge.on_event === null).toBe(edge.kind !== 'on');
        }
        for (const edge of graph.edges) {
          // A ceiling exactly where there is a loop, and it is that loop's.
          expect(edge.loop_limit).toBe(
            edge.loop === null
              ? null
              : resolveIterationLimits()[
                  edge.loop as keyof ReturnType<typeof resolveIterationLimits>
                ],
          );
        }
        for (const node of graph.nodes) {
          // Only an agent stage has a model and an effort.
          expect(node.model === null).toBe(node.kind !== 'agent');
          expect(node.effort === null).toBe(node.kind !== 'agent');
        }
      });
    }
  }

  it('draws the feature pipeline as the interpreter runs it', () => {
    expect(spelled(graphOf('feature'))).toEqual([
      'intake next → refinement',
      'refinement approve → architecture',
      'architecture approve → implementation',
      'architecture return → refinement [architecture_revisions]',
      'implementation approve → ci_gate',
      'implementation return → architecture [architecture_revisions]',
      'conflict_resolution approve → ci_gate',
      'ci_gate pass → code_review',
      'ci_gate fail → implementation [ci_fix]',
      'code_review approve → business_review',
      'code_review return → implementation [code_review]',
      'business_review approve → rebase_gate',
      'business_review return → implementation [business_review]',
      'rebase_gate pass → ready_for_merge',
      'rebase_gate fail → conflict_resolution [rebase]',
      'ready_for_merge on(mr.review.comment) → implementation [human_rounds]',
      'ready_for_merge on(default_branch.moved) → rebase_gate [rebase_rechecks]',
      'ready_for_merge on(mr.merged) → merged_gate',
      'merged_gate pass → retrospective',
      'retrospective approve → librarian',
      'librarian approve → done',
    ]);
    const nodes = graphOf('feature').nodes;
    expect(nodes.find((node) => node.id === 'ci_gate')).toEqual({
      id: 'ci_gate',
      kind: 'gate',
      role: null,
      enabled: true,
      advisory: false,
      model: null,
      effort: null,
    });
    expect(nodes.find((node) => node.id === 'implementation')).toMatchObject({
      kind: 'agent',
      role: 'developer',
      model: 'model-of-implementation',
      effort: 'medium',
    });
    // The ready stage leaves backwards by two loops, each on its own edge with its own ceiling.
    expect(
      graphOf('feature')
        .edges.filter((edge) => edge.from === 'ready_for_merge' && edge.loop !== null)
        .map((edge) => [edge.to, edge.loop, edge.loop_limit]),
    ).toEqual([
      ['implementation', 'human_rounds', 3],
      ['rebase_gate', 'rebase_rechecks', 10],
    ]);
    // `qa` is a node either way; with the task's `qa_stage` false it is disabled and has no edges.
    expect(nodes.find((node) => node.id === 'qa')).toMatchObject({ kind: 'human', enabled: false });
  });

  it('honours qa_stage: the rebase gate passes into qa, and qa returns like ready_for_merge', () => {
    const edges = spelled(graphOf('feature', true));
    expect(edges).toContain('rebase_gate pass → qa');
    expect(edges).not.toContain('rebase_gate pass → ready_for_merge');
    expect(edges).toContain('qa on(mr.review.comment) → implementation [human_rounds]');
    expect(edges).toContain('qa on(default_branch.moved) → rebase_gate [rebase_rechecks]');
  });

  it('applies a dial: business review switched off, and a scoping stop removing the edge it halts', () => {
    const off = graphOf('feature', false, {
      level: 'assist',
      preset_version: 1,
      business_review: false,
      stop_after_stage: 'architecture',
    });
    expect(off.nodes.find((node) => node.id === 'business_review')?.enabled).toBe(false);
    const edges = spelled(off);
    expect(edges).toContain('code_review approve → rebase_gate');
    expect(edges.some((edge) => edge.startsWith('business_review'))).toBe(false);
    // The task parks after architecture: the forward edge is not one the interpreter takes.
    expect(edges.some((edge) => edge.startsWith('architecture approve'))).toBe(false);
    expect(edges).toContain('architecture return → refinement [architecture_revisions]');
  });

  it('draws no return out of an advisory stage', () => {
    const lint = graphOf('ticket_lint');
    expect(lint.nodes.find((node) => node.id === 'ticket_lint')?.advisory).toBe(true);
    expect(
      lint.edges.filter((edge) => edge.from === 'ticket_lint').map((edge) => edge.kind),
    ).toEqual(['approve']);
  });

  it('applies the limits it is handed to the edges', () => {
    const graph = pipelineGraphOf(
      compilePipeline('feature', SHIPPED_TEMPLATES.feature as PipelineTemplate, null, false),
      {
        limits: { ...resolveIterationLimits(), ci_fix: 7 },
        agentOf: () => ({ model: 'm', effort: 'low' }),
      },
    );
    expect(
      graph.edges.find((edge) => edge.from === 'ci_gate' && edge.kind === 'fail'),
    ).toMatchObject({ loop: 'ci_fix', loop_limit: 7 });
  });
});

describe("a task's frozen pipeline", () => {
  const task = {
    template: 'feature',
    templateSnapshot: SHIPPED_TEMPLATES.chore,
    pipelineDial: null,
    qaStage: false,
    iterationLimits: { code_review: 5 },
  };

  it('compiles the snapshot, not the template of that name, with the frozen limits', () => {
    const compiled = compileTaskPipeline(task, SHIPPED_TEMPLATES);
    expect(compiled.kind).toBe('compiled');
    if (compiled.kind !== 'compiled') return;
    // The chore snapshot has no architecture stage although the task's template is `feature`.
    expect(compiled.pipeline.stages.map((stage) => stage.id)).not.toContain('architecture');
    expect(compiled.limits.code_review).toBe(5);
    expect(compiled.limits.ci_fix).toBe(3);
  });

  it('falls back to the shipped template for a row with no snapshot, and refuses an unknown one', () => {
    const fallback = compileTaskPipeline({ ...task, templateSnapshot: null }, SHIPPED_TEMPLATES);
    expect(fallback.kind === 'compiled' && fallback.pipeline.byId.has('architecture')).toBe(true);
    expect(
      compileTaskPipeline(
        { ...task, template: 'nightly', templateSnapshot: null },
        SHIPPED_TEMPLATES,
      ),
    ).toEqual({ kind: 'unknown_template', template: 'nightly' });
  });

  it('refuses a dial, limits or a snapshot this release cannot read rather than drawing a guess', () => {
    expect(
      compileTaskPipeline({ ...task, pipelineDial: { level: 'x' } }, SHIPPED_TEMPLATES).kind,
    ).toBe('not_compilable');
    expect(
      compileTaskPipeline({ ...task, iterationLimits: { ci_fix: -1 } }, SHIPPED_TEMPLATES).kind,
    ).toBe('not_compilable');
    expect(
      compileTaskPipeline(
        {
          ...task,
          templateSnapshot: { stages: [{ id: 'intake', kind: 'system', next: 'nowhere' }] },
        },
        SHIPPED_TEMPLATES,
      ).kind,
    ).toBe('not_compilable');
  });

  it("states a stage's model off its latest run, else the configured one — and none under a refused config", () => {
    const ran = new Map([
      ['implementation', { model: 'claude-haiku-4-5', effort: 'low' as const }],
    ]);
    const readable = defaultProjectSettings(PROJECT, {
      config: { stages: { code_review: { model: 'claude-sonnet-5', effort: 'high' } } },
    });
    const ok = taskStageAgent(ran, readable);
    expect(ok('implementation')).toEqual({ model: 'claude-haiku-4-5', effort: 'low' });
    expect(ok('code_review')).toEqual({ model: 'claude-sonnet-5', effort: 'high' });
    // Stored settings that do not parse: the stage that ran keeps its run's figures, and one
    // that did not is null — never the defaults standing in for the refused document.
    const refused = taskStageAgent(ran, { ...readable, configRefusal: 'stages: not a map' });
    expect(refused('implementation')).toEqual({ model: 'claude-haiku-4-5', effort: 'low' });
    expect(refused('code_review')).toBeNull();
    const graph = pipelineGraphOf(
      compilePipeline('feature', SHIPPED_TEMPLATES.feature as PipelineTemplate, null, false),
      { limits: resolveIterationLimits(), agentOf: refused },
    );
    expect(graph.nodes.find((node) => node.id === 'code_review')).toMatchObject({
      model: null,
      effort: null,
    });
    expect(pipelineGraphSchema.parse(graph)).toEqual(graph);
  });

  it('reads frozen limits over the defaults and refuses a malformed value', () => {
    expect(frozenLimits({})).toEqual(resolveIterationLimits());
    expect(frozenLimits(null)).toEqual(resolveIterationLimits());
    expect(frozenLimits({ ci_fix: 1, unknown_loop: 9 })?.ci_fix).toBe(1);
    expect(frozenLimits({ ci_fix: 1.5 })).toBeNull();
    expect(frozenLimits({ ci_fix: '3' })).toBeNull();
    expect(frozenLimits([1])).toBeNull();
  });
});

describe("a project's templates", () => {
  const settings = (config: ProjectSettings['config'] = {}): ProjectSettings =>
    defaultProjectSettings(PROJECT, { config });

  it('lists the ticket templates and discovery, and an opt-in template only while it is on', () => {
    expect(enabledTemplateIds(settings())).toEqual(['feature', 'bug', 'chore', 'discovery']);
    expect(
      enabledTemplateIds(
        settings({
          features: {
            spike: { enabled: true },
            review_only: { enabled: true },
            ticket_linter: { enabled: true },
            epic_split: { enabled: true },
          },
        }),
      ),
    ).toEqual([
      'feature',
      'bug',
      'chore',
      'discovery',
      'review_only',
      'ticket_lint',
      'spike',
      'epic_split',
    ]);
  });

  it("compiles a ticket template with the binding's qa slot, and a one-off template without it", () => {
    const withQa: ProjectSettings = {
      ...settings(),
      ticketLifecycle: { pickUpFrom: null, slots: { qa: 'QA' } },
    };
    const feature = projectTemplateGraph(withQa, 'feature');
    expect(feature.kind === 'graph' && spelled(feature.graph)).toContain('rebase_gate pass → qa');
    const discovery = projectTemplateGraph(withQa, 'discovery');
    expect(discovery.kind).toBe('graph');
    expect(projectTemplateGraph(withQa, 'nightly')).toEqual({
      kind: 'unknown_template',
      template: 'nightly',
    });
  });

  it("applies the project's configured model and limits", () => {
    const configured = projectTemplateGraph(
      settings({
        stages: { implementation: { model: 'claude-sonnet-5', effort: 'low' } },
        pipeline: { limits: { ci_fix_iterations: 6 } },
      }),
      'feature',
    );
    expect(configured.kind).toBe('graph');
    if (configured.kind !== 'graph') return;
    expect(configured.graph.nodes.find((node) => node.id === 'implementation')).toMatchObject({
      model: 'claude-sonnet-5',
      effort: 'low',
    });
    expect(
      configured.graph.edges.find((edge) => edge.from === 'ci_gate' && edge.kind === 'fail')
        ?.loop_limit,
    ).toBe(6);
    // A stage nobody configured keeps the template's default.
    expect(configured.graph.nodes.find((node) => node.id === 'code_review')?.model).toBe(
      'claude-opus-5',
    );
  });
});

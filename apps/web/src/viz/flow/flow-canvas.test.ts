/**
 * The canvas's own decisions (S-23.5 review), without a browser: which loop pills are drawn, what
 * React Flow is handed, and how the first view is fitted. The drawing itself is the browser tier's
 * (`test/web-e2e/csp.spec.ts`).
 */
import { describe, expect, it } from 'vitest';
import { firstViewOf, pillShown, toReactFlow } from './flow-canvas.js';
import { FEATURE_GRAPH } from './graph.test-fixture.js';
import { layoutFlow } from './layout.js';
import { type FlowEdge, templateFlow } from './model.js';

const template = templateFlow(FEATURE_GRAPH);
const loopEdge = template.edges.find((edge) => edge.loop === 'code_review') as FlowEdge;

describe('loop pills', () => {
  it('are always drawn on a template', () => {
    expect(pillShown('template', loopEdge, new Set())).toBe(true);
  });

  it('are drawn on a task once spent, or while the edge is pointed at or beside a focused card', () => {
    const unspent = { ...loopEdge, loopUsed: 0 };
    expect(pillShown('task', unspent, new Set())).toBe(false);
    expect(pillShown('task', { ...loopEdge, loopUsed: 1 }, new Set())).toBe(true);
    expect(pillShown('task', unspent, new Set([loopEdge.id]))).toBe(true);
  });

  it('reach React Flow as the edge’s data, with the bottom spacer beside the nodes', () => {
    const task = {
      ...template,
      mode: 'task' as const,
      edges: template.edges.map((edge) => ({ ...edge, loopUsed: edge.loop === 'ci_fix' ? 2 : 0 })),
    };
    const layout = layoutFlow(task.nodes, task.edges);
    const { nodes, edges } = toReactFlow(task, layout, () => undefined);
    const shown = edges.filter((edge) => edge.data?.showPill).map((edge) => edge.data?.edge.loop);
    expect(shown).toEqual(['ci_fix']);
    expect(nodes.at(-1)).toMatchObject({ type: 'spacer', position: { y: layout.bottom } });
    const revealed = toReactFlow(task, layout, () => undefined, new Set([loopEdge.id])).edges;
    expect(revealed.filter((edge) => edge.data?.showPill)).toHaveLength(2);
  });
});

describe('the first view', () => {
  it('fits a whole template at zoom ≥ 0.45, and a task around its current stage at ≥ 0.75', () => {
    expect(firstViewOf(null)).toEqual({ padding: 0.1, minZoom: 0.45, maxZoom: 1 });
    expect(firstViewOf(['a', 'b'])).toEqual({
      nodes: [{ id: 'a' }, { id: 'b' }],
      padding: 0.15,
      minZoom: 0.75,
      maxZoom: 1,
    });
  });
});

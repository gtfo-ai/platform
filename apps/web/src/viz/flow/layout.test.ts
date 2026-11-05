/**
 * The flow canvas's layout (S-23.5): the main path is one row left → right, everything else sits
 * above it, returns curve below, deeper the further they reach — over a feature-shaped graph and
 * over the hostile cases (a cycle with no loop, an edge to a stage that is not a node).
 */
import { describe, expect, it } from 'vitest';
import { FEATURE_GRAPH } from './graph.test-fixture.js';
import {
  CARD_SIZE,
  COLUMN_WIDTH,
  focusOf,
  type LayoutEdgeInput,
  layoutFlow,
  RETURN_BASE,
  RETURN_STEP,
  ROW_HEIGHT,
} from './layout.js';
import { templateFlow } from './model.js';

const graph = templateFlow(FEATURE_GRAPH);
const layout = layoutFlow(graph.nodes, graph.edges);
const placed = (id: string) => {
  const node = layout.nodes.find((item) => item.id === id);
  if (node === undefined) {
    throw new Error(`no node ${id}`);
  }
  return node;
};
const route = (from: string, to: string) =>
  layout.edges.find((item) => item.id.startsWith(`${from}->${to}:`));

describe('the main path (rule 1)', () => {
  it('ranks the way a task goes when everything passes, left to right, on one row', () => {
    expect(layout.mainPath).toEqual([
      'intake',
      'refinement',
      'architecture',
      'implementation',
      'ci_gate',
      'code_review',
      'rebase_gate',
      'ready_for_merge',
      'done',
    ]);
    layout.mainPath.forEach((id, index) => {
      expect(placed(id).column).toBe(index);
      expect(placed(id).lane).toBe(0);
    });
  });

  it('centres cards of different sizes in their column and on the row, gates smaller', () => {
    const gate = placed('ci_gate');
    const agent = placed('implementation');
    expect(gate.width).toBeLessThan(agent.width);
    expect(gate.height).toBeLessThan(agent.height);
    expect(gate.x + gate.width / 2).toBe(gate.column * COLUMN_WIDTH + COLUMN_WIDTH / 2);
    expect(agent.y + agent.height / 2).toBe(ROW_HEIGHT / 2);
    expect(gate.y + gate.height / 2).toBe(ROW_HEIGHT / 2);
    expect(placed('ready_for_merge').width).toBe(CARD_SIZE.human.width);
  });
});

describe('everything else (rule 2)', () => {
  it('puts a stage entered only by a failure above the row, after the stage it hangs off', () => {
    const conflict = placed('conflict_resolution');
    expect(conflict.lane).toBe(-1);
    expect(conflict.column).toBe(placed('rebase_gate').column + 0.5);
  });

  it('puts a disabled stage above the row after the stage declared before it', () => {
    const qa = placed('qa');
    expect(qa.column).toBe(placed('rebase_gate').column + 0.5);
    // Both hang off the rebase gate: the second is stacked rather than drawn over the first.
    expect(qa.lane).toBe(-2);
  });
});

describe('the edges (rule 3)', () => {
  it('draws the row forward right to left side, and every loop as a curve below', () => {
    expect(route('implementation', 'ci_gate')?.route).toBe('forward');
    expect(route('ci_gate', 'implementation')?.route).toBe('return_below');
    expect(route('code_review', 'implementation')?.route).toBe('return_below');
    expect(route('rebase_gate', 'conflict_resolution')?.route).toBe('up');
    expect(route('conflict_resolution', 'ci_gate')?.route).toBe('down');
  });

  it('sends a longer return deeper, so nested loops do not cross', () => {
    const short = route('ci_gate', 'implementation')?.depth ?? 0;
    const long = route('code_review', 'implementation')?.depth ?? 0;
    expect(short).toBe(RETURN_BASE + RETURN_STEP);
    expect(long).toBe(RETURN_BASE + 2 * RETURN_STEP);
    expect(layout.bottom).toBeGreaterThan(ROW_HEIGHT);
  });

  it('reads a backwards edge with no loop as a return too, and survives an unknown stage', () => {
    const nodes = [
      { id: 'a', kind: 'agent' as const, enabled: true },
      { id: 'b', kind: 'agent' as const, enabled: true },
    ];
    const edges: LayoutEdgeInput[] = [
      { id: 'a->b', from: 'a', to: 'b', kind: 'approve', loop: null },
      { id: 'b->a', from: 'b', to: 'a', kind: 'approve', loop: null },
      { id: 'b->ghost', from: 'b', to: 'ghost', kind: 'next', loop: null },
    ];
    const result = layoutFlow(nodes, edges);
    expect(result.mainPath).toEqual(['a', 'b']);
    expect(result.edges.map((edge) => edge.route)).toEqual(['forward', 'return_below', 'forward']);
  });

  it('starts at the first enabled stage, and lays out an empty graph as nothing', () => {
    const result = layoutFlow(
      [
        { id: 'off', kind: 'agent', enabled: false },
        { id: 'on', kind: 'system', enabled: true },
      ],
      [],
    );
    expect(result.mainPath).toEqual(['on']);
    expect(result.nodes.find((node) => node.id === 'off')?.lane).toBe(-1);
    expect(layoutFlow([], []).nodes).toEqual([]);
  });
});

describe('the first view (focusOf)', () => {
  const path = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  it('frames five cards around the current stage, clamped to the row', () => {
    expect(focusOf(path, 'e')).toEqual(['c', 'd', 'e', 'f', 'g']);
    expect(focusOf(path, 'a')).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(focusOf(path, 'h')).toEqual(['d', 'e', 'f', 'g', 'h']);
  });

  it('frames the start of a template, and a stage off the row alone', () => {
    expect(focusOf(path, null)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(focusOf(path, 'conflict')).toEqual(['conflict']);
    expect(focusOf(['a', 'b'], null)).toEqual(['a', 'b']);
  });
});

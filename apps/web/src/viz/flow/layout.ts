/**
 * Where each stage card sits (TD-033 decision 8 (a), research/19 § 11: "no layout library: our
 * graphs are 5–15 nodes, laid out by rank, with return edges drawn as curves below").
 *
 * Pure and deterministic, so the canvas and its tests agree on every coordinate.
 *
 * ## The rules
 *
 * 1. **The main path is one row, left → right.** It starts at the first enabled stage in declaration
 *    order and follows, from each stage, its first forward edge by kind — `next`, `approve`, `pass`,
 *    `on`, then `fail` — to a stage declared later. That is the way a task goes when everything
 *    passes, which is what a person reads first.
 * 2. **Everything else sits above the row**, half a column after the stage it hangs off: a stage
 *    reached only by a failure or a return (`conflict_resolution`, entered from the rebase gate),
 *    and a stage the pipeline walks over (disabled), placed after the stage declared before it. Two
 *    such cards that would overlap are stacked.
 * 3. **An edge is a return** when it spends a loop or points back along the row; a return between
 *    two cards of the row is drawn **below** it, deeper the further it reaches, so nested loops do
 *    not cross. Every other edge leaves a card's right side for the next card's left.
 * 4. **Gates and system steps are smaller cards** than agent stages; a human stage is between.
 */
import type { StageKind } from './model.js';

export interface Size {
  readonly width: number;
  readonly height: number;
}

export const CARD_SIZE: Readonly<Record<StageKind, Size>> = {
  agent: { width: 232, height: 128 },
  human: { width: 208, height: 112 },
  gate: { width: 176, height: 92 },
  system: { width: 152, height: 76 },
};

/** One column: the widest card plus the gap a connector needs. */
export const COLUMN_WIDTH = CARD_SIZE.agent.width + 56;
/** One row: the tallest card plus room for a pill. */
export const ROW_HEIGHT = CARD_SIZE.agent.height + 72;
/** How far below the row the shallowest return curve dips; each column of reach adds `RETURN_STEP`. */
export const RETURN_BASE = 56;
export const RETURN_STEP = 22;

export interface LayoutNodeInput {
  readonly id: string;
  readonly kind: StageKind;
  readonly enabled: boolean;
}

export interface LayoutEdgeInput {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly kind: string;
  readonly loop: string | null;
}

export type EdgeRoute =
  /** right side → left side, along the row or between two cards above it */
  | 'forward'
  /** both on the row, going back: a curve below it */
  | 'return_below'
  /** from the row up to a card above it, or back down */
  | 'up'
  | 'down';

export interface PlacedNode {
  readonly id: string;
  /** Column, fractional for a card above the row (rule 2). */
  readonly column: number;
  /** 0 is the main row; −1, −2 … the rows above it. */
  readonly lane: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PlacedEdge {
  readonly id: string;
  readonly route: EdgeRoute;
  /** For `return_below`: how far below the row's cards the curve's control points sit. */
  readonly depth: number;
}

export interface FlowLayout {
  readonly nodes: readonly PlacedNode[];
  readonly edges: readonly PlacedEdge[];
  /** The main path, in order (rule 1). */
  readonly mainPath: readonly string[];
  /** The lowest point a return curve reaches, so the viewport can be fitted around it. */
  readonly bottom: number;
}

const KIND_PREFERENCE = ['next', 'approve', 'pass', 'on', 'fail'];

const preference = (kind: string): number => {
  const index = KIND_PREFERENCE.indexOf(kind);
  return index === -1 ? KIND_PREFERENCE.length : index;
};

export const layoutFlow = (
  nodes: readonly LayoutNodeInput[],
  edges: readonly LayoutEdgeInput[],
): FlowLayout => {
  const order = new Map(nodes.map((node, index) => [node.id, index]));
  const known = (id: string): boolean => order.has(id);
  const isForward = (edge: LayoutEdgeInput): boolean =>
    edge.loop === null &&
    known(edge.from) &&
    known(edge.to) &&
    (order.get(edge.from) as number) < (order.get(edge.to) as number);

  // Rule 1: the main path.
  const mainPath: string[] = [];
  const start = nodes.find((node) => node.enabled) ?? nodes[0];
  if (start !== undefined) {
    let at: string | null = start.id;
    const seen = new Set<string>();
    while (at !== null && !seen.has(at)) {
      seen.add(at);
      mainPath.push(at);
      const from: string = at;
      const next = edges
        .filter((edge) => edge.from === from && isForward(edge) && !seen.has(edge.to))
        .sort(
          (left, right) =>
            preference(left.kind) - preference(right.kind) ||
            (order.get(left.to) as number) - (order.get(right.to) as number),
        )[0];
      at = next?.to ?? null;
    }
  }
  const column = new Map(mainPath.map((id, index) => [id, index]));

  // Rule 2: everything else, above the row.
  const lanes = new Map<string, number>();
  const occupied: { column: number; lane: number }[] = [];
  for (const node of nodes) {
    if (column.has(node.id)) {
      lanes.set(node.id, 0);
      continue;
    }
    const anchors = edges
      .filter((edge) => edge.to === node.id && column.has(edge.from))
      .map((edge) => column.get(edge.from) as number);
    let at: number;
    if (anchors.length > 0) {
      at = Math.min(...anchors) + 0.5;
    } else {
      // The stage declared before it that has a place; else the first column.
      const index = order.get(node.id) as number;
      const before = nodes
        .slice(0, index)
        .reverse()
        .find((candidate) => column.has(candidate.id));
      at = before === undefined ? -0.5 : (column.get(before.id) as number) + 0.5;
    }
    let lane = -1;
    while (occupied.some((cell) => cell.lane === lane && Math.abs(cell.column - at) < 1)) {
      lane -= 1;
    }
    occupied.push({ column: at, lane });
    column.set(node.id, at);
    lanes.set(node.id, lane);
  }

  const placed = nodes.map((node): PlacedNode => {
    const size = CARD_SIZE[node.kind];
    const col = column.get(node.id) as number;
    const lane = lanes.get(node.id) as number;
    return {
      id: node.id,
      column: col,
      lane,
      // Centred in its column and on its row, so cards of different sizes share one axis.
      x: col * COLUMN_WIDTH + (COLUMN_WIDTH - size.width) / 2,
      y: lane * ROW_HEIGHT + (ROW_HEIGHT - size.height) / 2,
      width: size.width,
      height: size.height,
    };
  });
  const at = new Map(placed.map((node) => [node.id, node]));

  // Rule 3: routes.
  let bottom = ROW_HEIGHT;
  const routed = edges.map((edge): PlacedEdge => {
    const from = at.get(edge.from);
    const to = at.get(edge.to);
    if (from === undefined || to === undefined) {
      return { id: edge.id, route: 'forward', depth: 0 };
    }
    if (from.lane === 0 && to.lane === 0) {
      if (edge.loop === null && to.column > from.column) {
        return { id: edge.id, route: 'forward', depth: 0 };
      }
      const reach = Math.abs(from.column - to.column);
      const depth = RETURN_BASE + RETURN_STEP * Math.min(reach, 8);
      bottom = Math.max(bottom, (ROW_HEIGHT + CARD_SIZE.agent.height) / 2 + depth);
      return { id: edge.id, route: 'return_below', depth };
    }
    if (to.lane < from.lane) {
      return { id: edge.id, route: 'up', depth: 0 };
    }
    if (to.lane > from.lane) {
      return { id: edge.id, route: 'down', depth: 0 };
    }
    return { id: edge.id, route: 'forward', depth: 0 };
  });

  return { nodes: placed, edges: routed, mainPath, bottom };
};

/** How many cards of the row the first view frames: readable, rather than the whole graph tiny. */
export const FOCUS_SPAN = 5;

/**
 * The stages the canvas frames when it opens: around the current stage (two before it, two after)
 * on a task, the start of the row on a template; a current stage off the row is framed alone. A
 * 15-stage pipeline fitted whole is unreadable at a page's width, and the canvas's fit button still
 * shows all of it.
 */
export const focusOf = (mainPath: readonly string[], current: string | null): readonly string[] => {
  if (current !== null && !mainPath.includes(current)) {
    return [current];
  }
  const at = current === null ? 0 : mainPath.indexOf(current);
  const start = Math.max(0, Math.min(at - 2, mainPath.length - FOCUS_SPAN));
  return mainPath.slice(start, start + FOCUS_SPAN);
};

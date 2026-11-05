/**
 * The canvas itself — the one module that imports `@xyflow/react` (TD-033 decision 8 (a)), and
 * therefore a **lazy chunk**: `flow-view.tsx` loads it with `import()`, so the library, its
 * stylesheet and `flow.css` are fetched only when a canvas is shown, never with the initial graph
 * (`pnpm bundle:check` fails if the library's code reaches it).
 *
 * React Flow is used **read-only**: nothing drags, connects, selects or deletes. A card is a real
 * `<button>` (`StageCard`), so the wrapper's own focus and keyboard handling are switched off
 * (`nodesFocusable`, `edgesFocusable`, `disableKeyboardA11y`) — one tab stop per stage, not two.
 * Pan by dragging, zoom by the controls or a pinch; the wheel scrolls the page rather than zooming
 * the canvas, because a canvas in the middle of a page that eats the wheel traps the reader. No
 * minimap: a graph of 5–15 stages fits the view.
 *
 * Positions come from `layout.ts`, never from React Flow: each node is handed its size, so the
 * first paint is already laid out. The first view frames five cards of the row — around the
 * current stage on a task, the start on a template (`focusOf`) — at a readable zoom; the fit button
 * shows the whole graph. Every return curve is a custom edge (`FlowEdgePath`) that dips below the
 * row and carries its loop pill; a spacer node at the deepest curve's bottom keeps that fit from
 * cutting the curves off (React Flow fits nodes, not edges).
 *
 * Under the production CSP: React Flow positions through React's `style` prop (CSSOM), which
 * `style-src` does not govern, and injects no `<style>` element — `csp.spec.ts` opens this canvas in
 * the built bundle and fails on a single violation.
 */
import '@xyflow/react/dist/style.css';
import './flow.css';
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
} from '@xyflow/react';
import { type ReactElement, useMemo } from 'react';
import { cx } from '../../ui/cx.js';
import { type EdgeRoute, type FlowLayout, focusOf, layoutFlow } from './layout.js';
import type { FlowEdge, FlowGraph, FlowNode } from './model.js';
import { StageCard } from './stage-card.js';

type StageNodeData = { readonly node: FlowNode; readonly onOpen: (id: string) => void };
type StageNodeType = Node<StageNodeData, 'stage'>;
type SpacerNodeType = Node<Record<string, never>, 'spacer'>;
type FlowEdgeData = {
  readonly edge: FlowEdge;
  readonly route: EdgeRoute;
  readonly depth: number;
};
type FlowEdgeType = Edge<FlowEdgeData, 'flow'>;

/** The handles a card offers; invisible (`flow.css`), never connectable. */
const HANDLES = [
  { id: 'in', type: 'target', position: Position.Left },
  { id: 'out', type: 'source', position: Position.Right },
  { id: 'top-in', type: 'target', position: Position.Top },
  { id: 'top-out', type: 'source', position: Position.Top },
  { id: 'bottom-in', type: 'target', position: Position.Bottom },
  { id: 'bottom-out', type: 'source', position: Position.Bottom },
] as const;

const StageNode = ({ data }: NodeProps<StageNodeType>): ReactElement => (
  <>
    {HANDLES.map((handle) => (
      <Handle
        key={handle.id}
        id={handle.id}
        type={handle.type}
        position={handle.position}
        isConnectable={false}
      />
    ))}
    <StageCard node={data.node} onOpen={data.onOpen} />
  </>
);

const SpacerNode = (): ReactElement => <span aria-hidden="true" />;

/** The handles an edge leaves and enters by, per route. */
const HANDLES_OF: Readonly<Record<EdgeRoute, { source: string; target: string }>> = {
  forward: { source: 'out', target: 'in' },
  return_below: { source: 'bottom-out', target: 'bottom-in' },
  up: { source: 'top-out', target: 'bottom-in' },
  down: { source: 'bottom-out', target: 'top-in' },
};

/**
 * Every edge: a bezier between two handles, or — for a return between two cards of the row — a
 * curve below it, `depth` deep, with the loop pill at its lowest point.
 */
const FlowEdgePath = ({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  data,
}: EdgeProps<FlowEdgeType>): ReactElement => {
  let path: string;
  let labelX: number;
  let labelY: number;
  if (data?.route === 'return_below') {
    const depth = data.depth;
    path = `M ${sourceX},${sourceY} C ${sourceX},${sourceY + depth} ${targetX},${targetY + depth} ${targetX},${targetY}`;
    labelX = (sourceX + targetX) / 2;
    // A cubic whose two control points sit `depth` below both ends is lowest at t = ½, ¾ of the way.
    labelY = (sourceY + targetY) / 2 + depth * 0.75;
  } else {
    [path, labelX, labelY] = getBezierPath({
      sourceX,
      sourceY,
      targetX,
      targetY,
      sourcePosition,
      targetPosition,
    });
  }
  const pill = data?.edge.pill ?? null;
  return (
    <>
      <BaseEdge id={id} path={path} {...(markerEnd === undefined ? {} : { markerEnd })} />
      {pill === null ? null : (
        <EdgeLabelRenderer>
          <span
            data-loop-pill={data?.edge.loop ?? ''}
            className="pointer-events-none absolute rounded-full border border-line bg-canvas px-2 py-px text-[11px] font-medium whitespace-nowrap text-fg-muted"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {pill}
          </span>
        </EdgeLabelRenderer>
      )}
    </>
  );
};

const NODE_TYPES = { stage: StageNode, spacer: SpacerNode };
const EDGE_TYPES = { flow: FlowEdgePath };

/** The graph and its layout → React Flow's nodes and edges. Exported for the unit tier. */
export const toReactFlow = (
  graph: FlowGraph,
  layout: FlowLayout,
  onOpen: (id: string) => void,
): { nodes: (StageNodeType | SpacerNodeType)[]; edges: FlowEdgeType[] } => {
  const placed = new Map(layout.nodes.map((node) => [node.id, node]));
  const nodes: (StageNodeType | SpacerNodeType)[] = graph.nodes.map((node) => {
    const at = placed.get(node.id);
    return {
      id: node.id,
      type: 'stage',
      position: { x: at?.x ?? 0, y: at?.y ?? 0 },
      width: at?.width ?? 0,
      height: at?.height ?? 0,
      data: { node, onOpen },
      draggable: false,
      selectable: false,
      connectable: false,
      focusable: false,
    };
  });
  nodes.push({
    id: '__flow-bottom__',
    type: 'spacer',
    position: { x: 0, y: layout.bottom },
    width: 1,
    height: 1,
    data: {},
    draggable: false,
    selectable: false,
    connectable: false,
    focusable: false,
  });
  const routes = new Map(layout.edges.map((edge) => [edge.id, edge]));
  const edges = graph.edges.map((edge): FlowEdgeType => {
    const placedEdge = routes.get(edge.id);
    const route = placedEdge?.route ?? 'forward';
    return {
      id: edge.id,
      source: edge.from,
      target: edge.to,
      type: 'flow',
      sourceHandle: HANDLES_OF[route].source,
      targetHandle: HANDLES_OF[route].target,
      animated: edge.live,
      selectable: false,
      focusable: false,
      className: cx(
        'flow-edge',
        edge.traversed ? 'flow-edge--traversed' : null,
        edge.loop === null ? null : 'flow-edge--loop',
        edge.live ? 'flow-edge--live' : null,
      ),
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 14,
        height: 14,
        color: edge.live ? 'var(--running-fg)' : 'var(--border-input)',
      },
      data: { edge, route, depth: placedEdge?.depth ?? 0 },
    };
  });
  return { nodes, edges };
};

export const FlowCanvas = ({
  graph,
  onOpen,
  label,
}: {
  readonly graph: FlowGraph;
  readonly onOpen: (id: string) => void;
  /** The canvas region's accessible name, e.g. "Feature pipeline". */
  readonly label: string;
}): ReactElement => {
  const layout = useMemo(() => layoutFlow(graph.nodes, graph.edges), [graph]);
  const { nodes, edges } = useMemo(
    () => toReactFlow(graph, layout, onOpen),
    [graph, layout, onOpen],
  );
  const current =
    graph.nodes.find(
      (node) => node.state === 'current' || (node.state === 'failed' && node.activity !== null),
    )?.id ?? null;
  // Computed once per graph shape: a live frame re-renders the canvas, and a fit that moved with
  // every frame would yank the view from under a reader who had panned away.
  const focusKey = focusOf(layout.mainPath, current).join(',');
  const fitViewOptions = useMemo(
    () => ({
      nodes: focusKey.split(',').map((id) => ({ id })),
      padding: 0.15,
      minZoom: 0.55,
      maxZoom: 1,
    }),
    [focusKey],
  );
  return (
    <section
      aria-label={label}
      data-flow-canvas={graph.mode}
      className="agentic-flow h-full w-full"
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        // A node that is neither selectable nor draggable gets `pointer-events: none` unless the
        // canvas listens for its clicks — then the pane under it would take the card's press.
        onNodeClick={(_event, clicked) => {
          if (clicked.type === 'stage') {
            onOpen(clicked.id);
          }
        }}
        fitView
        fitViewOptions={fitViewOptions}
        minZoom={0.3}
        maxZoom={1.75}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        disableKeyboardA11y
        zoomOnScroll={false}
        zoomOnDoubleClick={false}
        panOnScroll={false}
        preventScrolling={false}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1.4} />
        <Controls showInteractive={false} position="bottom-right" />
      </ReactFlow>
    </section>
  );
};

export default FlowCanvas;

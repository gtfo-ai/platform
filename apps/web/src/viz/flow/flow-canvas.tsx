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
 * first paint is already laid out. A task's first view frames the current stage with two cards
 * either side (`focusOf`) at zoom ≥ 0.75; a template's frames the start of its row at zoom ≥ 0.5
 * (`firstViewOf`), and the reader pans along it; the *Fit all* control shows every stage. Every
 * return curve is a custom edge (`FlowEdgePath`) that dips below the row and carries its loop pill
 * (on a task, only once spent, or while pointed at or beside a focused card — `pillShown`); a
 * spacer node at the deepest curve's bottom keeps a fit of
 * the whole graph from cutting the curves off (React Flow fits nodes, not edges).
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
import { type ReactElement, useMemo, useState } from 'react';
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
  readonly showPill: boolean;
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
  const pill = data?.showPill === true ? data.edge.pill : null;
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
/**
 * Whether an edge's loop pill is drawn: always on a template (the ceilings are what it is read
 * for); on a task only for a loop the task has spent, or while the reader points at the edge or
 * focuses a card it touches — six unspent pills converging on one stage are a pile of text nobody
 * can read, and the list beside the canvas says every one of them in words.
 */
export const pillShown = (
  mode: FlowGraph['mode'],
  edge: FlowEdge,
  revealed: ReadonlySet<string>,
): boolean => mode === 'template' || (edge.loopUsed ?? 0) > 0 || revealed.has(edge.id);

export const toReactFlow = (
  graph: FlowGraph,
  layout: FlowLayout,
  onOpen: (id: string) => void,
  revealed: ReadonlySet<string> = new Set(),
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
      data: {
        edge,
        route,
        depth: placedEdge?.depth ?? 0,
        showPill: edge.pill !== null && pillShown(graph.mode, edge, revealed),
      },
    };
  });
  return { nodes, edges };
};

/**
 * The canvas's own floor: how far out *Fit all* may zoom to show **every** stage. The shipped
 * feature template is thirteen stages on its row — about 3 750 px of cards — so at a 1 190 px page
 * the whole row fits near 0.26: the shape of the pipeline, with the names too small to read.
 */
export const TEMPLATE_FIT_MIN_ZOOM = 0.2;

/**
 * A template's first view is **not** that fit (S-23.13a, the owner's reading: at 0.26 no stage name
 * is legible). It frames the first {@link TEMPLATE_FIRST_VIEW_SPAN} stages of the row and never
 * zooms out past {@link TEMPLATE_FIRST_VIEW_MIN_ZOOM}, so the names read at a glance; the reader
 * pans along the row, and *Fit all* still shows the whole shape. Six stages are about 1 730 px of
 * cards: 0.63 at a 1 190 px page, 0.5 at about 950 px — the narrowest page that draws the canvas
 * clamps at the floor rather than shrinking the names. A two-row "snake" was weighed again and not
 * taken: its cross-row returns no longer read as returns, and on the taller canvas a row of six
 * gives the same legibility with the layout everyone already reads left to right.
 */
export const TEMPLATE_FIRST_VIEW_MIN_ZOOM = 0.5;
export const TEMPLATE_FIRST_VIEW_SPAN = 6;

/**
 * The first view's fit. A template is read from its start — its first stages, padding 0.08, never
 * below 0.5. A task is read around where it is — the current stage with two either side (`focus`),
 * never below 0.75, so the cards stay legible at a page's width.
 */
export const firstViewOf = (mode: FlowGraph['mode'], focus: readonly string[]) => ({
  // No stage to frame (a graph with no row) fits whatever there is.
  ...(focus.length === 0 ? {} : { nodes: focus.map((id) => ({ id })) }),
  ...(mode === 'template'
    ? { padding: 0.08, minZoom: TEMPLATE_FIRST_VIEW_MIN_ZOOM, maxZoom: 1 }
    : { padding: 0.15, minZoom: 0.75, maxZoom: 1 }),
});

/** The stages a first view frames: a task's around its current stage, a template's from its start. */
export const firstViewFocus = (
  mode: FlowGraph['mode'],
  mainPath: readonly string[],
  current: string | null,
): readonly string[] =>
  mode === 'template' ? mainPath.slice(0, TEMPLATE_FIRST_VIEW_SPAN) : focusOf(mainPath, current);

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
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null);
  const [focusedCard, setFocusedCard] = useState<string | null>(null);
  const revealed = useMemo(
    () =>
      new Set(
        graph.edges
          .filter(
            (edge) =>
              edge.id === hoveredEdge || edge.from === focusedCard || edge.to === focusedCard,
          )
          .map((edge) => edge.id),
      ),
    [graph, hoveredEdge, focusedCard],
  );
  const { nodes, edges } = useMemo(
    () => toReactFlow(graph, layout, onOpen, revealed),
    [graph, layout, onOpen, revealed],
  );
  const current =
    graph.nodes.find(
      (node) => node.state === 'current' || (node.state === 'failed' && node.activity !== null),
    )?.id ?? null;
  // Computed once per graph shape: a live frame re-renders the canvas, and a fit that moved with
  // every frame would yank the view from under a reader who had panned away.
  const focusKey = firstViewFocus(graph.mode, layout.mainPath, current).join(',');
  const fitViewOptions = useMemo(
    () => firstViewOf(graph.mode, focusKey === '' ? [] : focusKey.split(',')),
    [graph.mode, focusKey],
  );
  return (
    <section
      aria-label={label}
      data-flow-canvas={graph.mode}
      className="agentic-flow h-full w-full"
      // A focused card reveals the loop pills of the edges it touches (`pillShown`).
      onFocus={(event) => {
        const card = (event.target as Element).closest('[data-stage-card]');
        setFocusedCard(card?.getAttribute('data-stage-card') ?? null);
      }}
      onBlur={() => {
        setFocusedCard(null);
      }}
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
        // An edge that is neither selectable nor clicked gets `pointer-events: none`; listening for
        // its click (which does nothing) is what lets a hover reveal its pill.
        onEdgeClick={() => undefined}
        onEdgeMouseEnter={(_event, edge) => {
          setHoveredEdge(edge.id);
        }}
        onEdgeMouseLeave={() => {
          setHoveredEdge(null);
        }}
        fitView
        fitViewOptions={fitViewOptions}
        ariaLabelConfig={{ 'controls.fitView.ariaLabel': 'Fit all' }}
        minZoom={TEMPLATE_FIT_MIN_ZOOM}
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

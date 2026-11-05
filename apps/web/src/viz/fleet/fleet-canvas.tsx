/**
 * The fleet map (TD-033 decision 8 (b)) — the second module that imports `@xyflow/react`, and so a
 * **lazy chunk** of its own: the Agents page loads it with `import()` when the Map view is shown.
 * Same canvas as the pipeline's (`viz/flow/flow-canvas.tsx`): a dotted ground, dashed connectors,
 * read-only, one tab stop per card, the wheel left to the page, `flow.css`'s tokens and its
 * reduced-motion rule (the live dashes stand still).
 *
 * Three columns (`layout.ts`): the organisation, a node per seat — the platform server and each
 * worker machine, with its owner, its slots ("2 of 3 slots busy") and a pause — and each seat's run
 * cards, then its free slots; under the seats the **queue** of runs no seat holds yet, and **Needs
 * you**, what waits for a person, each a link to its task. A connector into a run is dashed and
 * animated while the agent works, solid amber while it waits for a person, quiet otherwise. A run
 * card opens the run's dialog.
 *
 * Every string a person, a tracker or an agent wrote (ticket keys and titles, a worker's and an
 * owner's names, a question) is rendered as a sanitised React text node (BD-022).
 */
import '@xyflow/react/dist/style.css';
import '../flow/flow.css';
import './fleet.css';
import { BellFillIcon } from '@primer/octicons-react/BellFillIcon';
import { ClockIcon } from '@primer/octicons-react/ClockIcon';
import { MoonIcon } from '@primer/octicons-react/MoonIcon';
import { ServerIcon } from '@primer/octicons-react/ServerIcon';
import { Link } from '@tanstack/react-router';
import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
} from '@xyflow/react';
import { type ReactElement, useMemo } from 'react';
import { Avatar } from '../../ui/avatar.js';
import { Bot } from '../../ui/bot/bot.js';
import type { BotPose } from '../../ui/bot/poses.js';
import { cx, FOCUS_RING } from '../../ui/cx.js';
import { sanitiseUntrusted } from '../../ui/untrusted-text.js';
import { layoutFleet, type MapEdgeTone, type MapLayout, type MapNode } from './layout.js';
import { type Fleet, type FleetNeed, type FleetSeat, seatTitle, slotsWords } from './model.js';
import { FleetRunCard } from './run-card.js';

/**
 * What a run in the queue waits for: any seat; or — on a platform where nothing on the server runs
 * agent work — a worker, when there is none (S-23.20), or **nobody**, when there are workers and
 * none of them can take work by itself (S-23.24: the Agents page says why, above the views).
 */
export type QueueWait = 'seat' | 'worker' | 'nobody';

/** The queue node's line for `waiting` runs (exported for the unit tier). */
export const queueWords = (waitingFor: QueueWait, waiting: number): string => {
  switch (waitingFor) {
    case 'worker':
      return waiting === 0
        ? 'Waiting for a worker — add one to run agent work.'
        : `${waiting} waiting for a worker — add one to run them.`;
    case 'nobody':
      return waiting === 0
        ? 'No worker can take work now.'
        : `${waiting} waiting, and no worker can take them now.`;
    case 'seat':
      return waiting === 0
        ? 'No run is waiting for a seat.'
        : `${waiting} waiting for a seat — the server or a worker picks each up.`;
  }
};

interface MapData extends Record<string, unknown> {
  readonly node: MapNode;
  readonly fleet: Fleet;
  readonly now: number;
  readonly onOpen: (runId: string) => void;
  readonly waitingFor: QueueWait;
}
type MapFlowNode = Node<MapData, MapNode['kind']>;
type MapFlowEdge = Edge<Record<string, never>>;

const Handles = (): ReactElement => (
  <>
    <Handle type="target" position={Position.Left} isConnectable={false} />
    <Handle type="source" position={Position.Right} isConnectable={false} />
  </>
);

/** The organisation's mascot: busy when anyone works, a hand up when a person is needed. */
export const orgPose = (fleet: Fleet): BotPose =>
  fleet.counts.needsYou > 0
    ? 'raise_hand'
    : fleet.counts.working > 0
      ? 'typing'
      : fleet.counts.stuck > 0
        ? 'confused'
        : 'sleeping';

const OrgNode = ({ data }: NodeProps<MapFlowNode>): ReactElement => {
  const { counts } = data.fleet;
  return (
    <div
      data-fleet-node="org"
      className="flex h-full w-full items-center gap-2 rounded-xl border border-line bg-subtle px-3"
    >
      <Bot pose={orgPose(data.fleet)} scale={2} />
      <div className="flex min-w-0 flex-col gap-0.5 text-xs text-fg-muted">
        <span className="text-sm font-semibold text-fg">Organisation</span>
        <span>{`${counts.working} working`}</span>
        <span className={counts.needsYou > 0 ? 'font-medium text-running' : undefined}>
          {`${counts.needsYou} ${counts.needsYou === 1 ? 'needs' : 'need'} you`}
        </span>
        <span>{`${counts.waiting} waiting`}</span>
      </div>
      <Handles />
    </div>
  );
};

/** The seat's badge: paused until when, or revoked. */
export const seatBadge = (seat: FleetSeat): string | null =>
  seat.state === 'revoked' ? 'Revoked' : seat.state === 'paused' ? 'Paused' : null;

const SeatNode = ({ data }: NodeProps<MapFlowNode>): ReactElement => {
  const seat = data.node.seat as FleetSeat;
  const badge = seatBadge(seat);
  const title = seatTitle(seat);
  return (
    <div
      data-fleet-node="seat"
      data-seat={seat.id}
      className={cx(
        'flex h-full w-full flex-col justify-center gap-1.5 rounded-xl border bg-subtle px-3',
        seat.runs.length > 0 ? 'border-line-input' : 'border-line',
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        {seat.kind === 'server' ? (
          <span
            aria-hidden="true"
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-fg-muted"
          >
            <ServerIcon size={16} />
          </span>
        ) : (
          <Avatar name={title} size={32} decorative />
        )}
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-semibold text-fg">{title}</span>
          <span className="truncate text-xs text-fg-muted">
            {seat.kind === 'server'
              ? 'Runs agents on the platform’s own server'
              : seat.owner === null
                ? 'Worker'
                : `Worker · ${sanitiseUntrusted(seat.owner)}`}
          </span>
        </span>
      </span>
      <span className="flex flex-wrap items-center gap-1.5 text-xs text-fg-muted">
        <span data-fleet-slots="" className="tabular-nums">
          {slotsWords(seat)}
        </span>
        {seat.free !== null && seat.state === 'active' && seat.free > 0 ? (
          <span>{`· ${seat.free} free`}</span>
        ) : null}
        {badge === null ? null : (
          <span
            className={cx(
              'rounded-full border px-1.5 text-[11px] font-medium',
              seat.state === 'revoked'
                ? 'border-danger/40 bg-danger-bg text-danger'
                : 'border-line bg-default text-fg-muted',
            )}
          >
            {badge}
          </span>
        )}
      </span>
      <Handles />
    </div>
  );
};

const seatOf = (fleet: Fleet, id: string | null): FleetSeat | null =>
  id === null ? null : (fleet.seats.find((seat) => seat.id === id) ?? null);

const RunNode = ({ data }: NodeProps<MapFlowNode>): ReactElement => {
  const run = data.node.run;
  return (
    <>
      <Handles />
      {run === undefined ? null : (
        <FleetRunCard
          run={run}
          seat={seatOf(data.fleet, run.seatId)}
          now={data.now}
          onOpen={data.onOpen}
        />
      )}
    </>
  );
};

const SlotNode = (): ReactElement => (
  <div
    data-fleet-node="slot"
    className="flex h-full w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-line text-xs text-fg-subtle"
  >
    <Handles />
    <span aria-hidden="true" className="inline-flex">
      <MoonIcon size={16} />
    </span>
    <span>Free slot</span>
  </div>
);

const QueueNode = ({ data }: NodeProps<MapFlowNode>): ReactElement => {
  const waiting = data.fleet.queue.length;
  return (
    <div
      data-fleet-node="queue"
      className="flex h-full w-full flex-col justify-center gap-1 rounded-xl border border-dashed border-line-input bg-subtle px-3"
    >
      <Handles />
      <span className="flex items-center gap-2 text-sm font-semibold text-fg">
        <span aria-hidden="true" className="inline-flex text-fg-muted">
          <ClockIcon size={16} />
        </span>
        Queue
      </span>
      <span className="text-xs text-fg-muted">{queueWords(data.waitingFor, waiting)}</span>
    </div>
  );
};

const needLine = (need: FleetNeed): string =>
  [
    need.ticketKey === null ? null : sanitiseUntrusted(need.ticketKey),
    need.untrusted ? sanitiseUntrusted(need.text) : need.text,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');

const NeedsNode = ({ data }: NodeProps<MapFlowNode>): ReactElement => {
  const needs = data.fleet.needs;
  const shown = needs.slice(0, 4);
  return (
    <div
      data-fleet-node="needs"
      className="flex h-full w-full flex-col gap-1.5 rounded-xl border border-running bg-running-bg/40 px-3 py-2.5"
    >
      <Handles />
      <span className="flex items-center gap-2 text-sm font-semibold text-running">
        <span aria-hidden="true" className="inline-flex">
          <BellFillIcon size={16} />
        </span>
        {`Needs you (${needs.length})`}
      </span>
      <ul className="flex flex-col gap-1 text-xs">
        {shown.map((need) => (
          <li key={need.id} className="min-w-0">
            <Link
              to="/tasks/$taskId"
              params={{ taskId: need.taskId }}
              className={cx(
                'nodrag nopan block truncate rounded-sm text-fg hover:underline',
                FOCUS_RING,
              )}
            >
              {needLine(need)}
            </Link>
          </li>
        ))}
      </ul>
      {needs.length > shown.length ? (
        <span className="text-xs text-fg-muted">{`${needs.length - shown.length} more in the inbox`}</span>
      ) : null}
    </div>
  );
};

const NODE_TYPES = {
  org: OrgNode,
  seat: SeatNode,
  run: RunNode,
  slot: SlotNode,
  queue: QueueNode,
  needs: NeedsNode,
};

const EDGE_COLOUR: Readonly<Record<MapEdgeTone, string>> = {
  working: 'var(--running-fg)',
  needs_you: 'var(--running-fg)',
  quiet: 'var(--border-input)',
  ended: 'var(--fg-subtle)',
};

/** The layout as React Flow's nodes and edges. Exported for the unit tier. */
export const toFleetFlow = (
  layout: MapLayout,
  fleet: Fleet,
  now: number,
  onOpen: (runId: string) => void,
  waitingFor: QueueWait = 'seat',
): { nodes: MapFlowNode[]; edges: MapFlowEdge[] } => ({
  nodes: layout.nodes.map((node) => ({
    id: node.id,
    type: node.kind,
    position: { x: node.x, y: node.y },
    width: node.width,
    height: node.height,
    data: { node, fleet, now, onOpen, waitingFor },
    draggable: false,
    selectable: false,
    connectable: false,
    focusable: false,
  })),
  edges: layout.edges.map((edge) => ({
    id: edge.id,
    source: edge.from,
    target: edge.to,
    animated: edge.tone === 'working',
    selectable: false,
    focusable: false,
    className: `fleet-edge fleet-edge--${edge.tone}`,
    markerEnd: {
      type: MarkerType.ArrowClosed,
      width: 14,
      height: 14,
      color: EDGE_COLOUR[edge.tone],
    },
  })),
});

export const FleetCanvas = ({
  fleet,
  now,
  onOpen,
  waitingFor = 'seat',
}: {
  readonly fleet: Fleet;
  readonly now: number;
  readonly onOpen: (runId: string) => void;
  readonly waitingFor?: QueueWait;
}): ReactElement => {
  const layout = useMemo(() => layoutFleet(fleet), [fleet]);
  const { nodes, edges } = useMemo(
    () => toFleetFlow(layout, fleet, now, onOpen, waitingFor),
    [layout, fleet, now, onOpen, waitingFor],
  );
  return (
    <section
      aria-label="Fleet map"
      data-fleet-canvas=""
      className="agentic-flow agentic-fleet h-full w-full"
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        // A node that is neither selectable nor draggable gets `pointer-events: none` unless the
        // canvas listens for its clicks — then a run card's button and a needs link would be dead.
        onNodeClick={() => undefined}
        fitView
        fitViewOptions={{ padding: 0.08, minZoom: 0.3, maxZoom: 1 }}
        ariaLabelConfig={{ 'controls.fitView.ariaLabel': 'Fit all' }}
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

export default FleetCanvas;

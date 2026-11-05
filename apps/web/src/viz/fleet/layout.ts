/**
 * Where the fleet map's nodes go (TD-033 decision 8 (b)). Pure, no layout library — the map is three
 * columns, as the owner's reference draws a person/machine column feeding agent cards:
 *
 *   organisation  →  one node per seat  →  that seat's run cards, left to right (then its free slots)
 *                 →  the queue          →  the runs waiting for a seat
 *   needs you     (under the organisation: what waits for a person, listed in the node)
 *
 * Each seat is a row as tall as a run card; the organisation sits level with the middle of the
 * rows, and *Needs you* under it, so the map stays as short as its seats and fits a screen.
 * A free slot is drawn as a dashed placeholder, at most {@link MAP_FREE_SLOTS_SHOWN} per seat — the
 * seat node says the whole number in words. Every node carries its size, so the first paint is laid
 * out and React Flow measures nothing.
 */
import type { Fleet, FleetRun, FleetSeat } from './model.js';

export const MAP_ORG = { width: 280, height: 132 } as const;
export const MAP_SEAT = { width: 248, height: 128 } as const;
export const MAP_CARD = { width: 296, height: 188 } as const;
export const MAP_SLOT = { width: 160, height: 96 } as const;
export const MAP_QUEUE = { width: 248, height: 108 } as const;
export const MAP_GAP_X = 72;
export const MAP_CARD_GAP = 24;
export const MAP_ROW_GAP = 28;
/** Free slots drawn per seat; the seat node says how many there are. */
export const MAP_FREE_SLOTS_SHOWN = 2;
/** Needs-you items listed in its node; the node says how many more. */
export const MAP_NEEDS_SHOWN = 4;

const NEEDS_ROW = 30;

export type MapNodeKind = 'org' | 'seat' | 'run' | 'slot' | 'queue' | 'needs';

export interface MapNode {
  readonly id: string;
  readonly kind: MapNodeKind;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly seat?: FleetSeat;
  readonly run?: FleetRun;
}

export type MapEdgeTone = 'working' | 'needs_you' | 'quiet' | 'ended';

export interface MapEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly tone: MapEdgeTone;
}

export interface MapLayout {
  readonly nodes: readonly MapNode[];
  readonly edges: readonly MapEdge[];
}

export const needsNodeHeight = (count: number): number =>
  64 + Math.min(count, MAP_NEEDS_SHOWN) * NEEDS_ROW + (count > MAP_NEEDS_SHOWN ? 22 : 0);

/** The tone of the connector into a run: live work animates, a person's turn is amber. */
export const edgeToneOf = (run: FleetRun): MapEdgeTone => {
  if (run.ended) {
    return 'ended';
  }
  switch (run.activity.activity) {
    case 'needs_you':
      return 'needs_you';
    case 'working':
    case 'thinking':
      return 'working';
    default:
      return 'quiet';
  }
};

/** The tone of a whole seat's connector: any run's need wins over any run's work. */
const seatTone = (runs: readonly FleetRun[]): MapEdgeTone => {
  const tones = runs.map(edgeToneOf);
  return tones.includes('needs_you')
    ? 'needs_you'
    : tones.includes('working')
      ? 'working'
      : 'quiet';
};

export const layoutFleet = (fleet: Fleet): MapLayout => {
  const nodes: MapNode[] = [];
  const edges: MapEdge[] = [];
  const seatX = MAP_ORG.width + MAP_GAP_X;
  const cardX = seatX + MAP_SEAT.width + MAP_GAP_X;
  const rowHeight = MAP_CARD.height;
  let y = 0;

  const placeRow = (
    owner: MapNode,
    runs: readonly FleetRun[],
    free: number,
    rowY: number,
  ): void => {
    let x = cardX;
    for (const run of runs) {
      const id = `run:${run.id}`;
      nodes.push({ id, kind: 'run', x, y: rowY, ...MAP_CARD, run });
      edges.push({ id: `${owner.id}->${id}`, from: owner.id, to: id, tone: edgeToneOf(run) });
      x += MAP_CARD.width + MAP_CARD_GAP;
    }
    for (let slot = 0; slot < free; slot += 1) {
      const id = `slot:${owner.id}:${slot}`;
      nodes.push({
        id,
        kind: 'slot',
        x,
        y: rowY + (rowHeight - MAP_SLOT.height) / 2,
        ...MAP_SLOT,
        ...(owner.seat === undefined ? {} : { seat: owner.seat }),
      });
      x += MAP_SLOT.width + MAP_CARD_GAP;
    }
  };

  for (const seat of fleet.seats) {
    const node: MapNode = {
      id: `seat:${seat.id}`,
      kind: 'seat',
      x: seatX,
      y: y + (rowHeight - MAP_SEAT.height) / 2,
      ...MAP_SEAT,
      seat,
    };
    nodes.push(node);
    const runs = [...seat.runs, ...seat.endings];
    edges.push({ id: `org->${node.id}`, from: 'org', to: node.id, tone: seatTone(seat.runs) });
    const free =
      seat.state === 'active' && seat.free !== null ? Math.min(seat.free, MAP_FREE_SLOTS_SHOWN) : 0;
    placeRow(node, runs, free, y);
    y += rowHeight + MAP_ROW_GAP;
  }

  const queue: MapNode = {
    id: 'queue',
    kind: 'queue',
    x: seatX,
    y: y + (rowHeight - MAP_QUEUE.height) / 2,
    ...MAP_QUEUE,
  };
  nodes.push(queue);
  edges.push({ id: 'org->queue', from: 'org', to: 'queue', tone: 'quiet' });
  placeRow(queue, fleet.queue, 0, y);
  y += rowHeight + MAP_ROW_GAP;

  const rowsBottom = Math.max(0, y - MAP_ROW_GAP);
  const needsHeight = fleet.needs.length > 0 ? needsNodeHeight(fleet.needs.length) : 0;
  const stack = MAP_ORG.height + (needsHeight > 0 ? MAP_ROW_GAP + needsHeight : 0);
  const orgY = Math.max(0, (rowsBottom - stack) / 2);
  nodes.unshift({ id: 'org', kind: 'org', x: 0, y: orgY, ...MAP_ORG });
  if (needsHeight > 0) {
    nodes.push({
      id: 'needs',
      kind: 'needs',
      x: 0,
      y: orgY + MAP_ORG.height + MAP_ROW_GAP,
      width: MAP_ORG.width,
      height: needsHeight,
    });
  }
  return { nodes, edges };
};

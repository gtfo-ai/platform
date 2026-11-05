/**
 * The fleet map's layout (S-23.6) and what React Flow is handed — without a browser; the drawing is
 * the browser tier's (`test/web-e2e/csp.spec.ts`).
 */
import { describe, expect, it } from 'vitest';
import {
  agentItem,
  approval,
  EMPTY_INBOX,
  NOW,
  question,
  uuid,
  worker,
  workerSeat,
} from './fleet.test-fixture.js';
import { toFleetFlow } from './fleet-canvas.js';
import { edgeToneOf, layoutFleet, MAP_CARD, MAP_FREE_SLOTS_SHOWN, MAP_ORG } from './layout.js';
import { fleetOf } from './model.js';

const fleet = fleetOf({
  agents: [
    agentItem(1),
    agentItem(2, { seat: workerSeat(30) }),
    agentItem(3, {
      seat: workerSeat(30),
      activity: { kind: 'waiting_permission', tool_name: 'Bash', at: '2026-11-05T16:44:00.000Z' },
    }),
    agentItem(4, { seat: null, run: { status: 'created', started_at: null } }),
  ],
  workers: [worker(30, { concurrency: 8 }), worker(31, { concurrency: 1 })],
  inbox: { questions: [question(70, uuid(9), 'q')], approvals: [approval(71, uuid(9))] },
  now: NOW,
});

describe('layoutFleet', () => {
  const layout = layoutFleet(fleet);
  const node = (id: string) => layout.nodes.find((candidate) => candidate.id === id);

  it('draws the organisation, a node per seat, the queue and needs-you, and every run once', () => {
    expect(layout.nodes.filter((n) => n.kind === 'seat').map((n) => n.id)).toEqual([
      'seat:server',
      `seat:worker:${uuid(30)}`,
      `seat:worker:${uuid(31)}`,
    ]);
    expect(layout.nodes.filter((n) => n.kind === 'run').map((n) => n.run?.id)).toEqual([
      uuid(1),
      uuid(2),
      uuid(3),
      uuid(4),
    ]);
    expect(node('org')).toBeDefined();
    expect(node('queue')).toBeDefined();
    expect(node('needs')?.y).toBeGreaterThan((node('org')?.y ?? 0) + MAP_ORG.height - 1);
  });

  it('draws at most two free slots per seat, after its runs, and none for the server', () => {
    const slots = (seat: string) =>
      layout.nodes.filter((n) => n.kind === 'slot' && n.id.startsWith(`slot:seat:${seat}:`));
    expect(slots(`worker:${uuid(30)}`)).toHaveLength(MAP_FREE_SLOTS_SHOWN);
    expect(slots(`worker:${uuid(31)}`)).toHaveLength(1);
    expect(slots('server')).toHaveLength(0);
    const lastRun = node(`run:${uuid(3)}`);
    expect(slots(`worker:${uuid(30)}`)[0]?.x).toBeGreaterThanOrEqual(
      (lastRun?.x ?? 0) + MAP_CARD.width,
    );
  });

  it('never overlaps two nodes', () => {
    const boxes = layout.nodes;
    for (const [index, a] of boxes.entries()) {
      for (const b of boxes.slice(index + 1)) {
        const apart =
          a.x + a.width <= b.x ||
          b.x + b.width <= a.x ||
          a.y + a.height <= b.y ||
          b.y + b.height <= a.y;
        expect(apart, `${a.id} overlaps ${b.id}`).toBe(true);
      }
    }
  });

  it('tones each connector by what the run is doing: work animates, a person’s turn is amber', () => {
    const tone = (to: string) => layout.edges.find((edge) => edge.to === to)?.tone;
    expect(tone(`run:${uuid(1)}`)).toBe('working');
    expect(tone(`run:${uuid(3)}`)).toBe('needs_you');
    expect(tone(`run:${uuid(4)}`)).toBe('quiet');
    // A seat holding a run that needs a person is amber all the way from the organisation.
    expect(tone(`seat:worker:${uuid(30)}`)).toBe('needs_you');
    expect(tone('seat:server')).toBe('working');
    const ended = fleet.runs[0];
    expect(ended === undefined ? null : edgeToneOf({ ...ended, ended: true })).toBe('ended');
  });

  it('reaches React Flow sized, read-only and with the working edges animated', () => {
    const { nodes, edges } = toFleetFlow(layout, fleet, NOW, () => undefined);
    expect(nodes.every((n) => n.width !== undefined && n.draggable === false)).toBe(true);
    expect(edges.filter((edge) => edge.animated).map((edge) => edge.target)).toEqual([
      'seat:server',
      `run:${uuid(1)}`,
      `run:${uuid(2)}`,
    ]);
    expect(edges.find((edge) => edge.target === `run:${uuid(3)}`)?.className).toContain(
      'fleet-edge--needs_you',
    );
  });

  it('has no needs-you node when nothing needs a person', () => {
    const quiet = layoutFleet(fleetOf({ agents: [], workers: [], inbox: EMPTY_INBOX, now: NOW }));
    expect(quiet.nodes.map((n) => n.kind)).toEqual(['org', 'seat', 'queue']);
  });
});

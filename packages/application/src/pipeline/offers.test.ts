/**
 * The offer and the claim's record (WP-274, WP-276): `offerRun` writes the run's offer `open` and
 * announces it at commit — **without** claiming it, since the job ends at the offer — and
 * `recordClaim` turns a claim the repository granted into `run.claimed` and the fence every later
 * write carries.
 */

import type { Id, IsoDateTime } from '@platform/contracts';
import { createRun, recordRunCreated, sequentialIds } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import type { BroadcastMessage } from '../ports/broadcast.js';
import { offerRun, RUN_OFFERS_TOPIC, recordClaim, serverLeaseOwner } from './offers.js';
import type { RunOfferRepository } from './store.js';

const NOW = '2026-11-04T09:00:00.000Z' as IsoDateTime;
const tx = { adapter: 'memory' } as never;

const context = () => ({
  ids: sequentialIds(0x2740),
  actor: { kind: 'system' as const, component: 'test' },
  clock: { now: () => NOW },
});

/** The run as transaction 1b writes it: recorded, `created` (WP-275b). */
const created = () =>
  recordRunCreated(
    createRun({
      id: '00000000-0000-4000-8000-000000002741' as Id,
      taskId: '00000000-0000-4000-8000-000000002742' as Id,
      projectId: '00000000-0000-4000-8000-000000002743' as Id,
      stage: 'implementation',
      role: 'developer',
      mode: 'normal',
      attempt: 2,
      model: 'claude-opus-5',
      effort: 'high',
      promptVersion: 'implementation@1',
    }),
    context(),
  ).aggregate;

const recording = () => {
  const inserted: unknown[] = [];
  const claims: unknown[] = [];
  const published: BroadcastMessage[] = [];
  const offers = {
    insert: async (_tx, offer) => {
      inserted.push(offer);
    },
    claim: async (_tx, claim) => {
      claims.push(claim);
      return null;
    },
  } as Pick<RunOfferRepository, 'insert' | 'claim'> as RunOfferRepository;
  const scope = {
    tx,
    broadcast: {
      publish: async (message: BroadcastMessage) => {
        published.push(message);
      },
    },
  };
  return { offers, inserted, claims, published, scope };
};

describe('offerRun', () => {
  it('writes the offer open, announces it on run_offers, records run.offered — and claims nothing', async () => {
    const { offers, inserted, claims, published, scope } = recording();
    const run = created();
    const decision = await offerRun(
      offers,
      scope,
      { run, kind: 'stage', offerId: '00000000-0000-4000-8000-000000002744' as Id, now: NOW },
      context(),
    );
    expect(inserted).toEqual([
      {
        id: '00000000-0000-4000-8000-000000002744',
        runId: run.id,
        taskId: run.taskId,
        projectId: run.projectId,
        stage: 'implementation',
        attempt: 2,
        kind: 'stage',
        offeredAt: NOW,
      },
    ]);
    expect(claims).toEqual([]);
    expect(published).toEqual([
      { topic: RUN_OFFERS_TOPIC, payload: { run_id: run.id, kind: 'stage' } },
    ]);
    expect(decision.events.map((event) => event.type)).toEqual(['run.offered']);
    expect(decision.aggregate.status).toBe('created');
  });
});

describe('recordClaim', () => {
  it('records run.claimed as the server, moves the run to starting, and answers the fence', () => {
    const owner = serverLeaseOwner('host:0000cafe');
    const run = created();
    const recorded = recordClaim(
      run,
      {
        offerId: '00000000-0000-4000-8000-000000002744' as Id,
        runId: run.id,
        taskId: run.taskId,
        kind: 'stage',
        epoch: 3,
        owner,
      },
      context(),
    );
    expect(owner).toBe('server:host:0000cafe');
    expect(recorded.fence).toEqual({ epoch: 3, owner });
    expect(recorded.run.status).toBe('starting');
    expect(recorded.events.map((event) => event.type)).toEqual(['run.claimed']);
    expect(recorded.events[0]?.payload).toMatchObject({ claimant_kind: 'server', lease_epoch: 3 });
  });
});

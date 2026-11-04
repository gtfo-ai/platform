/**
 * The in-job claimant (WP-274 criterion 1): `offerAndClaimInJob` writes the run's offer and takes it
 * through the one claim in the same transaction, and a claim that takes nothing there is a broken
 * invariant, thrown by name — never a run executed without a claim.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import { createRun, sequentialIds, startRun } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { OfferNotClaimedError, offerAndClaimInJob, serverLeaseOwner } from './offers.js';
import type { RunOfferRepository } from './store.js';

const NOW = '2026-11-04T09:00:00.000Z' as IsoDateTime;
const tx = { adapter: 'memory' } as never;

const context = () => ({
  ids: sequentialIds(0x2740),
  actor: { kind: 'system' as const, component: 'test' },
  clock: { now: () => NOW },
});

const starting = () =>
  startRun(
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

const recording = (answer: 'claims' | 'takes nothing') => {
  const inserted: unknown[] = [];
  const claims: unknown[] = [];
  const offers: RunOfferRepository = {
    insert: async (_tx, offer) => {
      inserted.push(offer);
    },
    claim: async (_tx, claim) => {
      claims.push(claim);
      return answer === 'takes nothing'
        ? null
        : {
            offerId: '00000000-0000-4000-8000-000000002744' as Id,
            runId: claim.eligibility.runId,
            taskId: '00000000-0000-4000-8000-000000002742' as Id,
            epoch: 1,
            owner: claim.owner,
          };
    },
    load: async () => null,
  };
  return { offers, inserted, claims };
};

describe('offerAndClaimInJob', () => {
  it('writes the offer open and claims exactly that run’s offer as the server, under its owner', async () => {
    const { offers, inserted, claims } = recording('claims');
    const run = starting();
    const owner = serverLeaseOwner('host:0000cafe');
    const result = await offerAndClaimInJob(
      offers,
      tx,
      {
        run,
        kind: 'stage',
        offerId: '00000000-0000-4000-8000-000000002744' as Id,
        owner,
        expiresAt: NOW,
        now: NOW,
      },
      context(),
    );
    expect(owner).toBe('server:host:0000cafe');
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
    expect(claims).toEqual([
      { eligibility: { runId: run.id }, claimantKind: 'server', owner, expiresAt: NOW, now: NOW },
    ]);
    expect(result.fence).toEqual({ epoch: 1, owner });
    expect(result.events.map((event) => event.type)).toEqual(['run.offered', 'run.claimed']);
  });

  it('throws OfferNotClaimedError when the claim takes nothing in the offer’s own transaction', async () => {
    const { offers } = recording('takes nothing');
    await expect(
      offerAndClaimInJob(
        offers,
        tx,
        {
          run: starting(),
          kind: 'ask',
          offerId: '00000000-0000-4000-8000-000000002744' as Id,
          owner: null,
          expiresAt: null,
          now: NOW,
        },
        context(),
      ),
    ).rejects.toBeInstanceOf(OfferNotClaimedError);
  });
});

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
import type { ExecutionRoutingRepository, RunOfferRepository } from './store.js';

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

const ASKER = '00000000-0000-4000-8000-0000000027a1' as Id;
const at = (seconds: number): IsoDateTime =>
  new Date(Date.parse(NOW) + seconds * 1000).toISOString() as IsoDateTime;

/** WP-278's reads, answered as a test sets them. */
const routingReads = (
  answers: {
    readonly settings?: Awaited<ReturnType<ExecutionRoutingRepository['settings']>>;
    readonly online?: boolean;
    readonly serverClaimant?: boolean;
  } = {},
) => {
  const asked: unknown[] = [];
  const execution: ExecutionRoutingRepository = {
    settings: async () => answers.settings ?? null,
    assigneeOnline: async (_tx, input) => {
      asked.push(input);
      return answers.online ?? false;
    },
    serverClaimantRunning: async () => answers.serverClaimant ?? true,
    renewServerClaimant: async () => {},
    releaseServerClaimant: async () => {},
  };
  return { execution, asked };
};

const recording = (answers: Parameters<typeof routingReads>[0] = {}) => {
  const { execution, asked } = routingReads(answers);
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
  return { offers, execution, asked, inserted, claims, published, scope };
};

describe('offerRun', () => {
  it('writes the offer open, announces it on run_offers, records run.offered — and claims nothing', async () => {
    const { offers, execution, inserted, claims, published, scope } = recording();
    const run = created();
    const decision = await offerRun(
      { offers, execution },
      scope,
      {
        run,
        kind: 'stage',
        offerId: '00000000-0000-4000-8000-000000002744' as Id,
        now: NOW,
        assigneeUserId: null,
      },
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
        // WP-278: no stored settings is TD-031 §8's defaults — hybrid, the server preferred.
        routing: {
          assigneeUserId: null,
          assigneeUntil: null,
          serverFrom: NOW,
          workersFrom: at(15),
          expiresAt: at(86_400),
        },
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

describe('offerRun — routing (WP-278, TD-031 decision 8)', () => {
  const offer = async (
    answers: Parameters<typeof recording>[0],
    input: { readonly kind: 'stage' | 'ask'; readonly assigneeUserId: Id | null },
  ) => {
    const recorded = recording(answers);
    await offerRun(
      { offers: recorded.offers, execution: recorded.execution },
      recorded.scope,
      {
        run: created(),
        kind: input.kind,
        offerId: '00000000-0000-4000-8000-000000002745' as Id,
        now: NOW,
        assigneeUserId: input.assigneeUserId,
      },
      context(),
    );
    return { ...recorded, routing: (recorded.inserted[0] as { routing: unknown }).routing };
  };

  it('an ask whose asker has a worker online gives the asker the head start (§13)', async () => {
    const { routing, asked } = await offer(
      { online: true },
      { kind: 'ask', assigneeUserId: ASKER },
    );
    expect(asked).toEqual([
      { projectId: '00000000-0000-4000-8000-000000002743', userId: ASKER, now: NOW },
    ]);
    expect(routing).toEqual({
      assigneeUserId: ASKER,
      assigneeUntil: at(120),
      serverFrom: at(120),
      workersFrom: at(135),
      expiresAt: at(86_400),
    });
  });

  it('an asker with no worker online gives nobody a head start', async () => {
    const { routing } = await offer({ online: false }, { kind: 'ask', assigneeUserId: ASKER });
    expect(routing).toMatchObject({ assigneeUserId: null, assigneeUntil: null, serverFrom: NOW });
  });

  it('a project’s stored settings decide, and server_only never asks whether the assignee is online', async () => {
    const { routing, asked } = await offer(
      {
        online: true,
        settings: {
          mode: 'server_only',
          prefer: 'workers',
          fallbackAfterSeconds: null,
          assigneeWindowSeconds: 120,
          offerTimeoutSeconds: 600,
        },
      },
      { kind: 'ask', assigneeUserId: ASKER },
    );
    expect(asked).toEqual([]);
    expect(routing).toEqual({
      assigneeUserId: null,
      assigneeUntil: null,
      serverFrom: NOW,
      workersFrom: null,
      expiresAt: at(600),
    });
  });

  it('with no server claimant on the instance, a hybrid project opens to workers at once', async () => {
    const { routing } = await offer(
      { serverClaimant: false },
      { kind: 'stage', assigneeUserId: null },
    );
    expect(routing).toMatchObject({ serverFrom: NOW, workersFrom: NOW });
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

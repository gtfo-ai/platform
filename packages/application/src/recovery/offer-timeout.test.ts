/**
 * The offer-timeout recovery row (WP-278 criterion 4, TD-031 decisions 1 and 8): an open offer past
 * its `expires_at` is withdrawn (`run.offer.withdrawn`, run `cancelled`) and its task escalated
 * with the brief *no claimant took this run* — through the stranded pass's table — while an offer a
 * claim took first, or one not yet expired, is left alone.
 */
import type { DomainEvent, Id } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { askTaskCommand } from '../ask/commands.js';
import { exactSecretRedactor } from '../integrations/redaction.js';
import { claimRunOffer } from '../pipeline/offers.js';
import { createPipelineHarness, type PipelineHarness } from '../testing/pipeline-harness.js';
import {
  OFFER_TIMEOUT_REASON,
  type OfferTimeoutRecoverySite,
  recoverExpiredOffers,
} from './offer-timeout.js';
import { runStrandedRecovery } from './stranded.js';

const PROJECT = '00000000-0000-4000-8000-000000002781' as Id;
const TIMEOUT_SECONDS = 3_600;
const ASKER = '00000000-0000-4000-8000-000000002782' as Id;

const ticketMatched = (key: string, seq: number): DomainEvent =>
  domainEventSchemasByType['ticket.matched'].parse({
    id: `00000000-0000-4000-9000-0000000027${String(seq).padStart(2, '0')}`,
    stream_type: 'project',
    stream_id: PROJECT,
    stream_seq: seq,
    correlation_id: null,
    cause_event_id: null,
    actor: { kind: 'integration', integration_id: PROJECT, provider: 'fake-jira' },
    occurred_at: '2026-06-01T09:00:00.000Z',
    type: 'ticket.matched',
    payload: {
      project_id: PROJECT,
      ticket: { provider: 'fake-jira', key, url: `https://jira.example.test/browse/${key}` },
      rule: 'label:agentic',
      priority: null,
      issue_type: 'Story',
      epic: null,
      links: [],
    },
  }) as DomainEvent;

/** A `workers_only` project on a core with no worker: the job offers, and nobody ever claims. */
const unclaimed = async (): Promise<PipelineHarness> => {
  const harness = createPipelineHarness({ projectId: PROJECT, runsAgents: false });
  harness.store.setExecutionSettings(PROJECT, {
    mode: 'workers_only',
    prefer: 'server',
    fallbackAfterSeconds: null,
    assigneeWindowSeconds: 120,
    offerTimeoutSeconds: TIMEOUT_SECONDS,
  });
  await harness.publish([ticketMatched('ACME-1', 1)]);
  expect(harness.store.offerRows().map((row) => row.state)).toEqual(['open']);
  return harness;
};

const site = (harness: PipelineHarness): OfferTimeoutRecoverySite => ({
  store: harness.store.offers,
  withdraw: async (offer, reason) => harness.runtime.withdrawOffer(offer, reason),
});

const pass = (harness: PipelineHarness) =>
  recoverExpiredOffers({ unitOfWork: harness.memory }, site(harness), {
    now: harness.clock.now(),
    limit: 50,
  });

describe('the offer-timeout recovery row (WP-278)', () => {
  it('writes expires_at = offered_at + offer_timeout on the offer', async () => {
    const harness = await unclaimed();
    const [offer] = harness.store.offerRows();
    expect(Date.parse(offer?.routing.expiresAt ?? '') - Date.parse(offer?.offeredAt ?? '')).toBe(
      TIMEOUT_SECONDS * 1000,
    );
  });

  it('leaves an offer alone until it expires', async () => {
    const harness = await unclaimed();
    harness.clock.advance(TIMEOUT_SECONDS * 1000 - 1);
    expect(await pass(harness)).toEqual({ found: 0, ended: 0 });
    expect(harness.store.offerRows()[0]?.state).toBe('open');
  });

  it('withdraws an expired offer, cancels its run and escalates the task with the brief', async () => {
    const harness = await unclaimed();
    const [offer] = harness.store.offerRows();
    harness.clock.advance(TIMEOUT_SECONDS * 1000);
    expect(await pass(harness)).toEqual({ found: 1, ended: 1 });

    const [after] = harness.store.offerRows();
    expect(after?.state).toBe('withdrawn');
    expect(after?.withdrawnReason).toBe(OFFER_TIMEOUT_REASON);
    const run = await harness.store.runs.load({} as never, offer?.runId as Id);
    expect(run?.status).toBe('cancelled');
    const task = await harness.store.tasks.load({} as never, offer?.taskId as Id);
    expect(task?.task.state).toBe('needs_human');

    const withdrawal = harness.events().find((event) => event.type === 'run.offer.withdrawn');
    expect(withdrawal?.payload).toMatchObject({ run_id: offer?.runId, reason: 'offer_timeout' });
    const escalation = harness.events().find((event) => event.type === 'task.escalated');
    expect((escalation?.payload as { blocker_brief?: string } | undefined)?.blocker_brief).toMatch(
      /no claimant took this run: it was offered at/,
    );
    // An ending, not a retry: the next pass finds nothing.
    expect(await pass(harness)).toEqual({ found: 0, ended: 0 });
  });

  it('withdraws nothing a claim took first — the conditional update is the decision', async () => {
    const harness = await unclaimed();
    const [offer] = harness.store.offerRows();
    harness.clock.advance(TIMEOUT_SECONDS * 1000);
    const expired = await harness.store.offers.expiredOpen({} as never, {
      now: harness.clock.now(),
      limit: 10,
    });
    expect(expired.map((row) => row.runId)).toEqual([offer?.runId]);
    // A worker claim (WP-281's) between the read and the withdrawal, as a remote claim would race it.
    await claimRunOffer(harness.store.offers, {} as never, {
      eligibility: { runId: offer?.runId as Id },
      claimantKind: 'worker',
      owner: 'worker:race',
      expiresAt: harness.clock.now(),
      now: harness.clock.now(),
    });
    const withdrawn = await site(harness).withdraw(expired[0] as (typeof expired)[number], {
      withdrawnReason: OFFER_TIMEOUT_REASON,
      brief: 'no claimant took this run',
    });
    expect(withdrawn).toBe(false);
    expect(harness.store.offerRows()[0]?.state).toBe('claimed');
    // And the pass counts it as found, not ended: its read came before the claim.
    const raced = await recoverExpiredOffers(
      { unitOfWork: harness.memory },
      { ...site(harness), store: { expiredOpen: async () => expired } },
      { now: harness.clock.now(), limit: 50 },
    );
    expect(raced).toEqual({ found: 1, ended: 0 });
    expect(harness.events().filter((event) => event.type === 'task.escalated')).toEqual([]);
  });

  it('refuses an ask whose offer expired, failed, with the brief — the ask’s own ending (§13)', async () => {
    const harness = await unclaimed();
    const [stage] = harness.store.offerRows();
    const asked = await askTaskCommand(
      {
        unitOfWork: harness.memory,
        jobs: harness.jobs,
        asks: harness.asks,
        redactor: exactSecretRedactor([]),
      },
      {
        id: harness.ids.next(),
        taskId: stage?.taskId as Id,
        projectId: PROJECT,
        source: 'ui',
        askedByUserId: ASKER,
        askedByIdentity: null,
        ticketCommentId: null,
        question: 'What does the refinement say about rate limits?',
        createdAt: harness.clock.now(),
      },
    );
    expect(asked.status).toBe('recorded');
    await harness.drain();
    const askOffer = harness.store.offerRows().find((row) => row.kind === 'ask');
    expect(askOffer?.state).toBe('open');

    harness.clock.advance(TIMEOUT_SECONDS * 1000);
    expect(await pass(harness)).toEqual({ found: 2, ended: 2 });

    const [ask] = harness.asks.all();
    expect(ask?.status).toBe('failed');
    expect(ask?.refusalReason).toMatch(/^no claimant took this run: it was offered at/);
    expect(harness.store.offerRows().find((row) => row.kind === 'ask')).toMatchObject({
      state: 'withdrawn',
      withdrawnReason: OFFER_TIMEOUT_REASON,
    });
    const run = await harness.store.runs.load({} as never, askOffer?.runId as Id);
    expect(run?.status).toBe('cancelled');
  });

  it('is a row of the stranded pass, reported as run_offer_timeout', async () => {
    const harness = await unclaimed();
    harness.clock.advance(TIMEOUT_SECONDS * 1000);
    const none = async () => [];
    const report = await runStrandedRecovery({
      store: {
        strandedBootstraps: none,
        markBootstrapAttempt: async () => {},
        endBootstrap: async () => {},
        strandedAsks: none,
        markAskAttempt: async () => {},
        endAsk: async () => {},
        strandedHistoryRecords: none,
        markHistoryRecordAttempt: async () => {},
        endHistoryRecord: async () => {},
        strandedCurations: none,
        markCurationAttempt: async () => {},
        endCuration: async () => {},
        asksWithEndedRun: none,
      },
      unitOfWork: harness.memory,
      jobs: harness.jobs,
      clock: harness.clock,
      graceMs: 60_000,
      offers: site(harness),
    });
    expect(report).toContainEqual({ site: 'run_offer_timeout', found: 1, reEnqueued: 0, ended: 1 });
  });
});

/**
 * **Why a run waits — the decision, and keys only** (S-26.5 criteria 1 and 4).
 *
 * `waitingReasonOf` is the only place the read's facts become a reason, so it is enumerated here
 * over **every** combination of the facts: each answer is `null` exactly when a claimant takes the
 * offer now, otherwise one of the contract's six keys; `user`, `last_seen_at` and `assignee_name`
 * are set only for the reasons that are about them; and nothing the read answers is a sentence —
 * the server sends keys, and the web app words them (`humanize`'s `waiting.*`). The SQL that
 * produces the facts is held to the claim by the PostgreSQL parity test
 * (`test/integration/pipeline/offer-waiting.integration.test.ts`).
 */
import { OFFER_WAITING_REASONS, offerWaitingSchema } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { type OfferWaitingFacts, offerWaitingOf, waitingReasonOf } from './offer-waiting.js';

const ALICE = { userId: '00000000-0000-4000-8000-000000002650', name: 'Alice' };
const SEEN = '2026-11-07T07:00:00.000Z';

const facts = (over: Partial<OfferWaitingFacts> = {}): OfferWaitingFacts => ({
  serverTakes: false,
  workerTakes: false,
  person: null,
  heldElsewhere: false,
  assigneeName: null,
  takers: 0,
  pickOnly: false,
  takerReady: false,
  takerPaused: false,
  takersLastSeenAt: null,
  ...over,
});

/** Every combination of the facts the decision reads. */
const everyCombination = (): OfferWaitingFacts[] => {
  const bools = [false, true];
  const all: OfferWaitingFacts[] = [];
  for (const serverTakes of bools)
    for (const workerTakes of bools)
      for (const person of [null, ALICE])
        for (const heldElsewhere of bools)
          for (const takers of [0, 2])
            for (const pickOnly of bools)
              for (const takerReady of bools)
                for (const takerPaused of bools)
                  all.push(
                    facts({
                      serverTakes,
                      workerTakes,
                      person,
                      heldElsewhere,
                      assigneeName: heldElsewhere ? 'Jan Novák' : null,
                      takers,
                      pickOnly,
                      takerReady,
                      takerPaused,
                      takersLastSeenAt: takers > 0 ? SEEN : null,
                    }),
                  );
  return all;
};

describe('the reason, from the facts (S-26.5 criterion 1)', () => {
  it('is null exactly when the server or a machine takes the offer now', () => {
    for (const input of everyCombination()) {
      expect(waitingReasonOf(input) === null).toBe(input.serverTakes || input.workerTakes);
    }
  });

  it('names the owner’s machines: none, only picking, offline, paused — and the residual', () => {
    expect(waitingReasonOf(facts({ person: ALICE }))).toBe('owner_no_worker');
    expect(waitingReasonOf(facts({ person: ALICE, pickOnly: true }))).toBe('owner_pick_only');
    expect(waitingReasonOf(facts({ person: ALICE, takers: 1 }))).toBe('owner_worker_offline');
    expect(waitingReasonOf(facts({ person: ALICE, takers: 1, takerPaused: true }))).toBe(
      'owner_worker_paused',
    );
    // A machine that takes it is connected and running, and the claim still refuses it.
    expect(waitingReasonOf(facts({ person: ALICE, takers: 1, takerReady: true }))).toBe(
      'owner_no_worker',
    );
    // A machine that takes it outranks one that only picks.
    expect(waitingReasonOf(facts({ person: ALICE, takers: 1, pickOnly: true }))).toBe(
      'owner_worker_offline',
    );
  });

  it('with nobody owning it: held elsewhere is assignee_not_linked, anything else no_taker', () => {
    expect(waitingReasonOf(facts())).toBe('no_taker');
    expect(waitingReasonOf(facts({ heldElsewhere: true }))).toBe('assignee_not_linked');
    // An owner is the reason's subject whatever the tracker says.
    expect(waitingReasonOf(facts({ person: ALICE, heldElsewhere: true }))).toBe('owner_no_worker');
  });
});

describe('keys only (S-26.5 criterion 4)', () => {
  it('answers one of the contract’s keys, and each detail only for the reason about it', () => {
    const reached = new Set<string | null>();
    for (const input of everyCombination()) {
      const waiting = offerWaitingOf(input);
      expect(offerWaitingSchema.parse(waiting)).toEqual(waiting);
      reached.add(waiting.reason);
      if (waiting.reason !== null) {
        expect(OFFER_WAITING_REASONS).toContain(waiting.reason);
      }
      expect(waiting.user === null).toBe(!(waiting.reason ?? '').startsWith('owner_'));
      expect(waiting.last_seen_at !== null).toBe(waiting.reason === 'owner_worker_offline');
      expect(waiting.assignee_name !== null).toBe(waiting.reason === 'assignee_not_linked');
    }
    expect([...reached].sort()).toEqual([...OFFER_WAITING_REASONS, null].sort());
  });

  it('is a key, never a sentence: the schema refuses words where a reason goes', () => {
    for (const reason of OFFER_WAITING_REASONS) {
      expect(reason).toMatch(/^[a-z_]+$/);
    }
    expect(
      offerWaitingSchema.safeParse({
        reason: "Waiting for Vojtěch's machine. It's offline.",
        user: null,
        last_seen_at: null,
        assignee_name: null,
      }).success,
    ).toBe(false);
    expect(
      offerWaitingSchema.safeParse({
        reason: 'no_taker',
        user: null,
        last_seen_at: null,
        assignee_name: null,
        message: 'no machine takes unassigned tasks',
      }).success,
    ).toBe(false);
  });
});

/**
 * **Why a run waits — the decision, the mapping, and keys only** (S-26.5 criteria 1 and 4).
 *
 * `reasonOfBlockers` is the one place a machine's claim blockers (the Workers screen's own,
 * `coreClaimBlockersOf`) become a reason, and it is pinned here blocker by blocker; the person's
 * reason and the DTO are enumerated over machine combinations: `null` exactly when a claimant takes
 * the offer now, otherwise one of the contract's seven keys; `user`, `last_seen_at`,
 * `assignee_name` and `blockers` only for the reasons they are about; and nothing the read answers
 * is a sentence. The SQL that produces the facts is held to the claim by the PostgreSQL parity
 * test (`test/integration/pipeline/offer-waiting.integration.test.ts`).
 */
import {
  OFFER_WAITING_REASONS,
  offerWaitingSchema,
  WORKER_CLAIM_BLOCKERS,
  type WorkerClaimBlocker,
} from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import {
  CANNOT_TAKE_BLOCKERS,
  machineWaitingOf,
  type OfferWaitingFacts,
  offerWaitingOf,
  reasonOfBlockers,
  type WaitingMachineFacts,
  waitingReasonOf,
} from './offer-waiting.js';

const ALICE = { userId: '00000000-0000-4000-8000-000000002650', name: 'Alice' };
const SEEN = '2026-11-07T07:00:00.000Z';
const LATER = '2026-11-07T08:00:00.000Z';
const CORE = { run: `sha256:${'c'.repeat(64)}`, egress: `sha256:${'d'.repeat(64)}` };

/** A machine that would take the run: here, its policy admits it, connected, holding the images. */
const machine = (over: Partial<WaitingMachineFacts> = {}): WaitingMachineFacts => ({
  here: true,
  policyTakes: true,
  ownerMayAct: true,
  online: true,
  protocolVersion: 4,
  hold: null,
  usagePaused: false,
  heldDigests: [CORE.run, CORE.egress],
  lastSeenAt: SEEN,
  ...over,
});

const facts = (over: Partial<OfferWaitingFacts> = {}): OfferWaitingFacts => ({
  serverTakes: false,
  workerTakes: false,
  person: null,
  heldElsewhere: false,
  assigneeName: null,
  machines: [],
  coreDigests: CORE,
  ...over,
});

describe('a machine’s blockers → its reason (the mapping, pinned)', () => {
  const MAPPING: Readonly<Record<WorkerClaimBlocker, string>> = {
    // Local-only: the core's half never produces them; alone they leave a refused machine.
    not_set_up: 'owner_worker_cannot_take',
    claude_rejected: 'owner_worker_cannot_take',
    launcher_unreachable: 'owner_worker_cannot_take',
    revoked: 'owner_no_worker',
    owner_disabled: 'owner_no_worker',
    no_eligible_project: 'owner_no_worker',
    offline: 'owner_worker_offline',
    paused: 'owner_worker_paused',
    pick_only: 'owner_pick_only',
    protocol_outdated: 'owner_worker_cannot_take',
    platform_images_unresolved: 'owner_worker_cannot_take',
    draining: 'owner_worker_cannot_take',
    usage_limited: 'owner_worker_cannot_take',
    images_missing: 'owner_worker_cannot_take',
    images_outdated: 'owner_worker_cannot_take',
    // S-28.12: a core-known blocker since the hand-back records it.
    workspace_unavailable: 'owner_worker_cannot_take',
  };

  it.each(WORKER_CLAIM_BLOCKERS)('%s alone', (blocker) => {
    const waiting = reasonOfBlockers([blocker]);
    expect(waiting.reason).toBe(MAPPING[blocker]);
    // Only the seven core-known blockers that are not a reason of their own are carried.
    expect(waiting.blockers).toEqual(CANNOT_TAKE_BLOCKERS.has(blocker) ? [blocker] : []);
  });

  it('carries exactly the seven, and never a local-only blocker', () => {
    expect([...CANNOT_TAKE_BLOCKERS].sort()).toEqual(
      [
        'workspace_unavailable',
        'images_outdated',
        'images_missing',
        'protocol_outdated',
        'draining',
        'usage_limited',
        'platform_images_unresolved',
      ].sort(),
    );
    expect(reasonOfBlockers(['not_set_up', 'images_outdated'])).toEqual({
      reason: 'owner_worker_cannot_take',
      blockers: ['images_outdated'],
    });
  });

  it('decides by the vocabulary’s order, the account and the policy first', () => {
    expect(reasonOfBlockers(['owner_disabled', 'offline']).reason).toBe('owner_no_worker');
    expect(reasonOfBlockers(['offline', 'pick_only']).reason).toBe('owner_pick_only');
    expect(reasonOfBlockers(['offline', 'images_outdated']).reason).toBe('owner_worker_offline');
    expect(reasonOfBlockers(['paused', 'images_outdated']).reason).toBe('owner_worker_paused');
    expect(reasonOfBlockers(['protocol_outdated', 'paused'])).toEqual({
      reason: 'owner_worker_cannot_take',
      blockers: ['protocol_outdated'],
    });
    expect(reasonOfBlockers(['images_outdated', 'usage_limited'])).toEqual({
      reason: 'owner_worker_cannot_take',
      blockers: ['usage_limited', 'images_outdated'],
    });
    // A machine the claim refused with no blocker of its own: the offer's or the project's reason.
    expect(reasonOfBlockers([])).toEqual({ reason: 'owner_worker_cannot_take', blockers: [] });
  });

  it('derives the blockers with the Workers screen’s own function', () => {
    expect(machineWaitingOf(machine({ heldDigests: ['sha256:old'] }), CORE)).toEqual({
      reason: 'owner_worker_cannot_take',
      blockers: ['images_outdated'],
    });
    expect(machineWaitingOf(machine({ heldDigests: [] }), CORE).blockers).toEqual([
      'images_missing',
    ]);
    expect(machineWaitingOf(machine(), null).blockers).toEqual(['platform_images_unresolved']);
    expect(machineWaitingOf(machine({ hold: 'draining' }), CORE).blockers).toEqual(['draining']);
    expect(machineWaitingOf(machine({ usagePaused: true }), CORE).blockers).toEqual([
      'usage_limited',
    ]);
    expect(machineWaitingOf(machine({ protocolVersion: 1 }), CORE).blockers).toEqual([
      'protocol_outdated',
    ]);
    expect(machineWaitingOf(machine({ hold: 'paused' }), CORE).reason).toBe('owner_worker_paused');
    expect(machineWaitingOf(machine({ online: false }), CORE).reason).toBe('owner_worker_offline');
    expect(machineWaitingOf(machine({ policyTakes: false }), CORE).reason).toBe('owner_pick_only');
    // Review of #105: a disabled owner's machine is no machine.
    expect(machineWaitingOf(machine({ ownerMayAct: false }), CORE).reason).toBe('owner_no_worker');
    expect(machineWaitingOf(machine({ here: false }), CORE).reason).toBe('owner_no_worker');
  });
});

describe('the person’s reason, from their machines (S-26.5 criterion 1)', () => {
  const owned = (machines: WaitingMachineFacts[]) => facts({ person: ALICE, machines });

  it('is null exactly when the server or a machine takes the offer now', () => {
    for (const serverTakes of [false, true]) {
      for (const workerTakes of [false, true]) {
        for (const person of [null, ALICE]) {
          const input = facts({ serverTakes, workerTakes, person, machines: [machine()] });
          expect(waitingReasonOf(input) === null).toBe(serverTakes || workerTakes);
        }
      }
    }
  });

  it('takes the machine nearest to taking the run, with the offline ones’ newest contact', () => {
    expect(waitingReasonOf(owned([]))).toBe('owner_no_worker');
    expect(waitingReasonOf(owned([machine({ policyTakes: false })]))).toBe('owner_pick_only');
    const offline = offerWaitingOf(
      owned([
        machine({ online: false, lastSeenAt: SEEN }),
        machine({ online: false, lastSeenAt: LATER }),
        machine({ policyTakes: false }),
      ]),
    );
    expect(offline).toMatchObject({ reason: 'owner_worker_offline', last_seen_at: LATER });
    expect(waitingReasonOf(owned([machine({ online: false }), machine({ hold: 'paused' })]))).toBe(
      'owner_worker_paused',
    );
    expect(
      offerWaitingOf(
        owned([
          machine({ hold: 'paused' }),
          machine({ heldDigests: ['sha256:old'] }),
          machine({ heldDigests: [] }),
        ]),
      ),
    ).toMatchObject({
      reason: 'owner_worker_cannot_take',
      blockers: ['images_missing', 'images_outdated'],
    });
  });

  it('with nobody owning it: held elsewhere is assignee_not_linked, anything else no_taker', () => {
    expect(waitingReasonOf(facts())).toBe('no_taker');
    expect(waitingReasonOf(facts({ heldElsewhere: true }))).toBe('assignee_not_linked');
    // An owner is the reason's subject whatever the tracker says.
    expect(waitingReasonOf(facts({ person: ALICE, heldElsewhere: true }))).toBe('owner_no_worker');
  });
});

describe('keys only (S-26.5 criterion 4)', () => {
  const VARIANTS: WaitingMachineFacts[] = [
    machine(),
    machine({ online: false }),
    machine({ hold: 'paused' }),
    machine({ hold: 'draining' }),
    machine({ heldDigests: ['sha256:old'] }),
    machine({ policyTakes: false }),
    machine({ here: false }),
    machine({ ownerMayAct: false }),
  ];

  it('answers one of the contract’s keys, and each detail only for the reason about it', () => {
    const reached = new Set<string | null>();
    const inputs: OfferWaitingFacts[] = [];
    for (const serverTakes of [false, true])
      for (const heldElsewhere of [false, true])
        for (const person of [null, ALICE])
          for (const first of [undefined, ...VARIANTS])
            for (const second of [undefined, ...VARIANTS])
              inputs.push(
                facts({
                  serverTakes,
                  person,
                  heldElsewhere,
                  assigneeName: heldElsewhere ? 'Jan Novák' : null,
                  machines: [first, second].filter(
                    (entry): entry is WaitingMachineFacts => entry !== undefined,
                  ),
                }),
              );
    for (const input of inputs) {
      const waiting = offerWaitingOf(input);
      expect(offerWaitingSchema.parse(waiting)).toEqual(waiting);
      reached.add(waiting.reason);
      expect(waiting.user === null).toBe(!(waiting.reason ?? '').startsWith('owner_'));
      expect(waiting.last_seen_at !== null).toBe(waiting.reason === 'owner_worker_offline');
      expect(waiting.assignee_name !== null).toBe(waiting.reason === 'assignee_not_linked');
      if (waiting.reason !== 'owner_worker_cannot_take') {
        expect(waiting.blockers).toEqual([]);
      }
      for (const blocker of waiting.blockers) {
        expect(CANNOT_TAKE_BLOCKERS.has(blocker)).toBe(true);
      }
    }
    expect([...reached].sort()).toEqual([...OFFER_WAITING_REASONS, null].sort());
  });

  it('is a key, never a sentence: the schema refuses words where a reason goes', () => {
    for (const reason of OFFER_WAITING_REASONS) {
      expect(reason).toMatch(/^[a-z_]+$/);
    }
    const base = { user: null, last_seen_at: null, assignee_name: null, blockers: [] };
    expect(
      offerWaitingSchema.safeParse({ ...base, reason: "Waiting for Vojtěch's machine." }).success,
    ).toBe(false);
    expect(
      offerWaitingSchema.safeParse({ ...base, reason: 'no_taker', message: 'no machine' }).success,
    ).toBe(false);
    expect(
      offerWaitingSchema.safeParse({
        ...base,
        reason: 'owner_worker_cannot_take',
        blockers: ['its images are old'],
      }).success,
    ).toBe(false);
  });
});

describe('a machine that cannot start runs (S-28.12)', () => {
  it('waits for the owner’s machine, naming the blocker and the recorded cause', () => {
    expect(
      offerWaitingOf(
        facts({
          person: ALICE,
          machines: [
            machine({ workspaceUnavailable: true, workspaceCause: 'docker_networks_exhausted' }),
          ],
        }),
      ),
    ).toEqual({
      reason: 'owner_worker_cannot_take',
      user: { user_id: ALICE.userId, name: 'Alice' },
      last_seen_at: null,
      assignee_name: null,
      blockers: ['workspace_unavailable'],
      workspace_cause: 'docker_networks_exhausted',
    });
  });

  it('says no cause for any other blocker', () => {
    expect(
      offerWaitingOf(facts({ person: ALICE, machines: [machine({ usagePaused: true })] })),
    ).not.toHaveProperty('workspace_cause');
  });
});

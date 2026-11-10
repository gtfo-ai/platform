/**
 * Why a worker takes no work (S-22.19): each side's half of the one vocabulary, a case per blocker
 * from both sides of its predicate, and the property that every answer is in the vocabulary's order.
 */
import { WORKER_CLAIM_BLOCKERS, workerClaimBlockersSchema } from '@platform/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PROPERTY_TEST_TIMEOUT_MS } from '../testing/property.js';
import {
  type CoreWorkerClaimFacts,
  coreClaimBlockersOf,
  type LocalWorkerClaimFacts,
  localClaimBlockersOf,
} from './claim-blockers.js';

const RUN = `sha256:${'a'.repeat(64)}`;
const EGRESS = `sha256:${'b'.repeat(64)}`;
const OLD = `sha256:${'0'.repeat(64)}`;

const ready: CoreWorkerClaimFacts = {
  revoked: false,
  ownerMayAct: true,
  online: true,
  protocolVersion: 3,
  hold: null,
  usagePaused: false,
  heldDigests: [RUN, EGRESS],
  coreDigests: { run: RUN, egress: EGRESS },
  eligibleProjects: 1,
  pickOnly: false,
};

describe('the core’s half', () => {
  it('says nothing for a worker that can claim', () => {
    expect(coreClaimBlockersOf(ready)).toEqual([]);
  });

  it.each([
    [{ online: false }, ['offline']],
    [{ protocolVersion: 1 }, ['protocol_outdated']],
    [{ hold: 'paused' as const }, ['paused']],
    [{ hold: 'draining' as const }, ['draining']],
    [{ usagePaused: true }, ['usage_limited']],
    [{ heldDigests: [] }, ['images_missing']],
    [{ heldDigests: [RUN, OLD] }, ['images_outdated']],
    [{ heldDigests: [OLD, EGRESS] }, ['images_outdated']],
    [{ eligibleProjects: 0 }, ['no_eligible_project']],
    [{ ownerMayAct: false }, ['owner_disabled']],
    [{ pickOnly: true }, ['pick_only']],
    [{ coreDigests: null }, ['platform_images_unresolved']],
  ] as const)('names %j', (change, expected) => {
    expect(coreClaimBlockersOf({ ...ready, ...change })).toEqual(expected);
  });

  it('names a core that cannot name its images — every claim is 503 then — and compares nothing with it', () => {
    // The review of PR #54: no digests is a refusal of every claim, never "can claim".
    expect(coreClaimBlockersOf({ ...ready, heldDigests: [OLD], coreDigests: null })).toEqual([
      'platform_images_unresolved',
    ]);
    // An empty list is missing whatever the core can name.
    expect(coreClaimBlockersOf({ ...ready, heldDigests: [], coreDigests: null })).toEqual([
      'platform_images_unresolved',
      'images_missing',
    ]);
    expect(coreClaimBlockersOf({ ...ready, eligibleProjects: null })).toEqual([]);
    // No protocol yet is not an old one.
    expect(coreClaimBlockersOf({ ...ready, protocolVersion: null })).toEqual([]);
  });

  it('answers a revoked worker with revoked alone', () => {
    expect(
      coreClaimBlockersOf({
        ...ready,
        revoked: true,
        online: false,
        heldDigests: [],
        hold: 'paused',
      }),
    ).toEqual(['revoked']);
  });

  it('lists every blocker it finds, most fundamental first', () => {
    expect(
      coreClaimBlockersOf({
        ...ready,
        online: false,
        hold: 'draining',
        heldDigests: [OLD],
        eligibleProjects: 0,
      }),
    ).toEqual(['offline', 'draining', 'images_outdated', 'no_eligible_project']);
  });
});

const connected: LocalWorkerClaimFacts = {
  connection: 'connected',
  claudeRejected: false,
  manuallyPaused: false,
  draining: false,
  usagePaused: false,
  launcherAnswered: true,
  heldDigests: [RUN, EGRESS],
  coreDigests: { run: RUN, egress: EGRESS },
};

describe('the worker’s half', () => {
  it('says nothing for a connected worker holding the core’s images', () => {
    expect(localClaimBlockersOf(connected)).toEqual([]);
  });

  it.each([
    [{ connection: 'needs_platform' }, ['not_set_up']],
    [{ connection: 'needs_claude' }, ['not_set_up']],
    [{ connection: 'logging_in' }, ['not_set_up']],
    [{ connection: 'core_unreachable' }, ['offline']],
    [{ connection: 'upgrade_required' }, ['protocol_outdated']],
    [{ claudeRejected: true }, ['claude_rejected']],
    [{ manuallyPaused: true }, ['paused']],
    // A drain is a hold too; it is named as the drain, not twice.
    [{ manuallyPaused: true, draining: true }, ['draining']],
    [{ usagePaused: true }, ['usage_limited']],
    [{ launcherAnswered: false, heldDigests: [] }, ['launcher_unreachable']],
    [{ heldDigests: [] }, ['images_missing']],
    [{ heldDigests: [OLD, EGRESS] }, ['images_outdated']],
    // S-28.12: a workspace failure, beside — never instead of — what the launcher says.
    [{ workspaceUnavailable: true }, ['workspace_unavailable']],
    [{ workspaceUnavailable: true, heldDigests: [] }, ['workspace_unavailable', 'images_missing']],
    [
      { workspaceUnavailable: true, launcherAnswered: false, heldDigests: [] },
      ['launcher_unreachable', 'workspace_unavailable'],
    ],
  ] as const)('names %j', (change, expected) => {
    expect(localClaimBlockersOf({ ...connected, ...change })).toEqual(expected);
  });

  it('says nothing about images before its launcher was asked, or against no handshake', () => {
    expect(localClaimBlockersOf({ ...connected, launcherAnswered: null, heldDigests: [] })).toEqual(
      [],
    );
    expect(localClaimBlockersOf({ ...connected, heldDigests: [OLD], coreDigests: null })).toEqual(
      [],
    );
  });

  it('answers a revoked worker with revoked alone', () => {
    expect(
      localClaimBlockersOf({ ...connected, connection: 'revoked', launcherAnswered: false }),
    ).toEqual(['revoked']);
  });
});

describe('both halves', () => {
  it(
    'answer a list the contract accepts: distinct, in the vocabulary’s order',
    () => {
      const digest = fc.constantFrom(RUN, EGRESS, OLD);
      fc.assert(
        fc.property(
          fc.record({
            revoked: fc.boolean(),
            ownerMayAct: fc.boolean(),
            online: fc.boolean(),
            protocolVersion: fc.option(fc.integer({ min: 1, max: 9 })),
            hold: fc.constantFrom(null, 'paused' as const, 'draining' as const),
            usagePaused: fc.boolean(),
            heldDigests: fc.array(digest, { maxLength: 3 }),
            coreDigests: fc.option(fc.constant({ run: RUN, egress: EGRESS })),
            eligibleProjects: fc.option(fc.nat(3)),
            pickOnly: fc.boolean(),
          }),
          fc.record({
            connection: fc.constantFrom(
              'needs_platform',
              'needs_claude',
              'logging_in',
              'handshaking',
              'connected',
              'revoked',
              'upgrade_required',
              'core_unreachable',
              'stopped',
            ),
            claudeRejected: fc.boolean(),
            manuallyPaused: fc.boolean(),
            draining: fc.boolean(),
            usagePaused: fc.boolean(),
            launcherAnswered: fc.option(fc.boolean()),
            heldDigests: fc.array(digest, { maxLength: 3 }),
            coreDigests: fc.option(fc.constant({ run: RUN, egress: EGRESS })),
          }),
          (core, local) => {
            for (const answer of [coreClaimBlockersOf(core), localClaimBlockersOf(local)]) {
              expect(workerClaimBlockersSchema.safeParse(answer).success).toBe(true);
              for (const blocker of answer) expect(WORKER_CLAIM_BLOCKERS).toContain(blocker);
            }
          },
        ),
      );
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );
});

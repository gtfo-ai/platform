/**
 * Every DTO of WP-280's surface, both halves (WP-280 (6)): the device flow's machine half in
 * `worker.ts` and the people's half in `workers.ts`. One accepted example per schema — the shape the
 * routes answer, pinned against `apps/server/src/routes/workers.test.ts` — and the refusals that
 * matter: strictness (an unknown key is an error), the credential's and the user code's spellings,
 * the approval's required name and confirmation flag, and RFC 8628's four poll errors and no fifth.
 */
import { describe, expect, it } from 'vitest';
import {
  workerCredentialSchema,
  workerDeviceRequestSchema,
  workerDeviceResponseSchema,
  workerDeviceTokenErrorSchema,
  workerDeviceTokenRequestSchema,
  workerDeviceTokenResponseSchema,
  workerUserCodeSchema,
} from './worker.js';
import {
  revokeWorkerResponseSchema,
  workerDeviceDecisionRequestSchema,
  workerDeviceDecisionResponseSchema,
  workerDeviceLookupParamsSchema,
  workerDeviceLookupResponseSchema,
  workerParamsSchema,
  workerSummarySchema,
  workersResponseSchema,
} from './workers.js';

const ID = '00000000-0000-4000-8000-0000000002a0';
const AT = '2026-11-04T12:00:00.000Z';
/** 43 base64url characters, obviously fake. */
const FAKE43 = `FAKE${'x'.repeat(39)}`;
const CREDENTIAL = `wkr_${'a'.repeat(26)}_${FAKE43}`;

const summary = {
  id: ID,
  name: 'alice-laptop',
  user: { id: ID, email: 'alice@example.test', name: null },
  created_at: AT,
  last_seen_at: null,
  protocol_version: null,
  image_digests: [`sha256:${'b'.repeat(64)}`],
  state: 'active',
  revoked_at: null,
  paused_until: null,
  paused_reason: null,
  concurrency: 1,
};

describe('the device flow’s machine half (TD-031 §10c)', () => {
  it('takes an empty object to start, and nothing else', () => {
    expect(workerDeviceRequestSchema.safeParse({}).success).toBe(true);
    expect(workerDeviceRequestSchema.safeParse({ name: 'x' }).success).toBe(false);
  });

  it('answers RFC 8628 §3.2’s five fields', () => {
    const body = {
      device_code: FAKE43,
      user_code: 'BCDF-GHJK',
      verification_uri: 'https://agentic.example.test/workers/approve',
      interval: 5,
      expires_in: 600,
    };
    expect(workerDeviceResponseSchema.safeParse(body).success).toBe(true);
    expect(workerDeviceResponseSchema.safeParse({ ...body, extra: 1 }).success).toBe(false);
    expect(workerDeviceResponseSchema.safeParse({ ...body, user_code: 'BCDFGHJK' }).success).toBe(
      false,
    );
  });

  it('holds the user code to XXXX-XXXX over the twenty consonants', () => {
    expect(workerUserCodeSchema.safeParse('BCDF-GHJK').success).toBe(true);
    for (const refused of ['bcdf-ghjk', 'ABCD-GHJK', 'BCDF-GHJ1', 'BCD-FGHJK']) {
      expect(workerUserCodeSchema.safeParse(refused).success, refused).toBe(false);
    }
  });

  it('polls with the device code and answers the credential once, or one of four errors', () => {
    expect(workerDeviceTokenRequestSchema.safeParse({ device_code: FAKE43 }).success).toBe(true);
    expect(workerDeviceTokenRequestSchema.safeParse({ device_code: 'short' }).success).toBe(false);
    expect(
      workerDeviceTokenResponseSchema.safeParse({ worker_id: ID, credential: CREDENTIAL }).success,
    ).toBe(true);
    expect(
      workerDeviceTokenResponseSchema.safeParse({ worker_id: ID, credential: `wkr_${FAKE43}` })
        .success,
    ).toBe(false);
    for (const error of ['authorization_pending', 'slow_down', 'access_denied', 'expired_token']) {
      expect(workerDeviceTokenErrorSchema.safeParse({ error }).success, error).toBe(true);
    }
    expect(workerDeviceTokenErrorSchema.safeParse({ error: 'invalid_grant' }).success).toBe(false);
  });

  it('spells the credential wkr_<26 base32>_<43 base64url>', () => {
    expect(workerCredentialSchema.safeParse(CREDENTIAL).success).toBe(true);
    expect(workerCredentialSchema.safeParse(CREDENTIAL.toUpperCase()).success).toBe(false);
    expect(workerCredentialSchema.safeParse(`${CREDENTIAL}x`).success).toBe(false);
  });
});

describe('the people’s half', () => {
  it('reads a pending code by what was typed, and answers what the machine sent', () => {
    expect(workerDeviceLookupParamsSchema.safeParse({ user_code: 'bcdf ghjk' }).success).toBe(true);
    expect(workerDeviceLookupParamsSchema.safeParse({ user_code: 'x'.repeat(33) }).success).toBe(
      false,
    );
    const body = {
      user_code: 'BCDF-GHJK',
      requested_ip: '198.51.100.7',
      user_agent: null,
      requested_at: AT,
      expires_at: AT,
      age_seconds: 0,
      needs_confirmation: false,
    };
    expect(workerDeviceLookupResponseSchema.safeParse(body).success).toBe(true);
    expect(workerDeviceLookupResponseSchema.safeParse({ ...body, age_seconds: -1 }).success).toBe(
      false,
    );
  });

  it('approves with a name and the confirmation flag, and denies with neither', () => {
    const approve = {
      decision: 'approve',
      user_code: 'BCDF-GHJK',
      name: 'alice-laptop',
      confirm_stale: false,
    };
    expect(workerDeviceDecisionRequestSchema.safeParse(approve).success).toBe(true);
    const { name: _name, ...nameless } = approve;
    expect(workerDeviceDecisionRequestSchema.safeParse(nameless).success).toBe(false);
    const { confirm_stale: _flag, ...flagless } = approve;
    expect(workerDeviceDecisionRequestSchema.safeParse(flagless).success).toBe(false);
    expect(
      workerDeviceDecisionRequestSchema.safeParse({ ...approve, name: ' padded ' }).success,
    ).toBe(false);
    expect(
      workerDeviceDecisionRequestSchema.safeParse({ decision: 'deny', user_code: 'BCDF-GHJK' })
        .success,
    ).toBe(true);
    expect(
      workerDeviceDecisionRequestSchema.safeParse({
        decision: 'deny',
        user_code: 'BCDF-GHJK',
        name: 'x',
      }).success,
    ).toBe(false);
    expect(
      workerDeviceDecisionResponseSchema.safeParse({ decision: 'deny', decided_at: AT }).success,
    ).toBe(true);
  });

  it('lists workers with their scope, and refuses a tag where a digest belongs', () => {
    expect(workerSummarySchema.safeParse(summary).success).toBe(true);
    expect(
      workerSummarySchema.safeParse({ ...summary, image_digests: ['platform:latest'] }).success,
    ).toBe(false);
    expect(workerSummarySchema.safeParse({ ...summary, state: 'paused' }).success).toBe(false);
    expect(workersResponseSchema.safeParse({ items: [summary], scope: 'own' }).success).toBe(true);
    expect(workersResponseSchema.safeParse({ items: [], scope: 'everyone' }).success).toBe(false);
  });

  it('revokes by id and answers what it did', () => {
    expect(workerParamsSchema.safeParse({ id: ID }).success).toBe(true);
    expect(workerParamsSchema.safeParse({ id: 'x' }).success).toBe(false);
    expect(
      revokeWorkerResponseSchema.safeParse({
        worker_id: ID,
        performed: true,
        revoked_at: AT,
        expired_runs: 2,
      }).success,
    ).toBe(true);
  });
});

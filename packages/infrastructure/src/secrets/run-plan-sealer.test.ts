/**
 * The run plan's seal (WP-275a): the envelope round-trips a plan for its own run, and refuses a
 * plan opened for another run, under another key, or tampered with — each as
 * `RunPlanUnreadableError`, never a value.
 */
import { RunPlanUnreadableError } from '@platform/application';
import type { Id } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { deriveSecretKey, sealSecret } from './envelope.js';
import { createEnvelopeRunPlanSealer, runPlanIdentity } from './run-plan-sealer.js';

const KEY = deriveSecretKey('FAKE-app-secret-key-for-run-plans-0123456789');
const OTHER_KEY = deriveSecretKey('FAKE-another-app-secret-key-run-plans-987654');
const RUN = '00000000-0000-4000-8000-000000002751' as Id;
const OTHER_RUN = '00000000-0000-4000-8000-000000002752' as Id;
const PLAN = '{"userPrompt":"ticket text with FAKE-planted-token-ABCDEFGHIJKLMNOP"}';

describe('the envelope run-plan sealer', () => {
  it('opens a plan for the run it was sealed for, byte-identical, and stores no plaintext', () => {
    const sealer = createEnvelopeRunPlanSealer(KEY);
    const sealed = sealer.seal(RUN, PLAN);
    expect(sealed.keyId).toBe(KEY.keyId);
    expect(Buffer.from(sealed.sealed).toString('utf8')).not.toContain('FAKE-planted-token');
    expect(sealer.open(RUN, sealed.sealed, sealed.keyId)).toBe(PLAN);
  });

  it('refuses a plan opened for another run', () => {
    const sealer = createEnvelopeRunPlanSealer(KEY);
    const sealed = sealer.seal(RUN, PLAN);
    expect(() => sealer.open(OTHER_RUN, sealed.sealed, sealed.keyId)).toThrow(
      RunPlanUnreadableError,
    );
  });

  it('refuses a plan sealed under another APP_SECRET_KEY, by its key id and by its tag', () => {
    const sealed = createEnvelopeRunPlanSealer(OTHER_KEY).seal(RUN, PLAN);
    const sealer = createEnvelopeRunPlanSealer(KEY);
    expect(() => sealer.open(RUN, sealed.sealed, sealed.keyId)).toThrow(/another APP_SECRET_KEY/);
    // A row that claims this process's key id but was sealed under another: the tag refuses it.
    expect(() => sealer.open(RUN, sealed.sealed, KEY.keyId)).toThrow(RunPlanUnreadableError);
  });

  it('refuses a tampered body, and a `secrets` envelope moved onto the run', () => {
    const sealer = createEnvelopeRunPlanSealer(KEY);
    const sealed = sealer.seal(RUN, PLAN);
    const tampered = Uint8Array.from(sealed.sealed);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0x01;
    expect(() => sealer.open(RUN, tampered, sealed.keyId)).toThrow(RunPlanUnreadableError);
    // The same key and the bare run id — a `secrets` row's identity shape — is not this table's.
    const fromSecrets = new Uint8Array(sealSecret(KEY, PLAN, RUN));
    expect(() => sealer.open(RUN, fromSecrets, KEY.keyId)).toThrow(RunPlanUnreadableError);
    expect(runPlanIdentity(RUN)).toBe(`run_plan:${RUN}`);
  });
});

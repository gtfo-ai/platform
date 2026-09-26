/**
 * `createRunScopedSecrets` — TD-028's WP-76 amendment decision 8: a redactor built **before** the
 * run's git credential existed still replaces it once the credential is registered.
 */
import { describe, expect, it } from 'vitest';
import { composeSecretRedactors } from '../integrations/redaction.js';
import { createRunScopedSecrets, runGitCredentialSecretName } from './run-redaction.js';

const RUN = '00000000-0000-4000-8000-00000000d001';
const OTHER_RUN = '00000000-0000-4000-8000-00000000d002';
const TOKEN = 'fake_run_credential_abcdef012345';

const clockAt = (start: number) => {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
};

describe('createRunScopedSecrets (WP-76)', () => {
  it('redacts a value registered after the redactor was composed', () => {
    const secrets = createRunScopedSecrets(clockAt(Date.parse('2026-06-01T00:00:00Z')));
    const composed = composeSecretRedactors(secrets.redactor);
    expect(composed.redactText(`push with ${TOKEN}`).count).toBe(0);

    secrets.add(RUN, TOKEN, '2026-06-03T00:00:00.000Z');

    const after = composed.redactText(`push with ${TOKEN}`);
    expect(after.count).toBe(1);
    expect(after.value).not.toContain(TOKEN);
    expect(after.value).toContain(runGitCredentialSecretName(RUN));
    expect(composed.redactJson({ artifact: { quoted: TOKEN } }).value).toEqual({
      artifact: { quoted: `[REDACTED:integration:${runGitCredentialSecretName(RUN)}]` },
    });
  });

  it('keeps two runs’ credentials apart and answers each run its own', () => {
    const secrets = createRunScopedSecrets(clockAt(Date.parse('2026-06-01T00:00:00Z')));
    secrets.add(RUN, TOKEN, '2026-06-03T00:00:00.000Z');
    secrets.add(OTHER_RUN, `${TOKEN}-other`, '2026-06-03T00:00:00.000Z');

    expect(secrets.secretsFor(RUN)).toEqual([
      { name: runGitCredentialSecretName(RUN), value: TOKEN },
    ]);
    expect(secrets.size).toBe(2);
  });

  it('holds a value past its revocation and drops it only after the provider’s expiry', () => {
    const clock = clockAt(Date.parse('2026-06-01T00:00:00Z'));
    const secrets = createRunScopedSecrets(clock);
    secrets.add(RUN, TOKEN, '2026-06-02T00:00:00.000Z');

    clock.advance(23 * 60 * 60 * 1_000);
    expect(secrets.redactor.redactText(TOKEN).count).toBe(1);
    clock.advance(2 * 60 * 60 * 1_000);
    expect(secrets.redactor.redactText(TOKEN).count).toBe(0);
    expect(secrets.size).toBe(0);
  });

  it('refuses a value too short to redact rather than holding nothing for it', () => {
    const secrets = createRunScopedSecrets(clockAt(0));
    expect(() => secrets.add(RUN, 'short', '2026-06-02T00:00:00.000Z')).toThrow(TypeError);
  });
});

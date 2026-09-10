/**
 * Exact-match redaction of injected secrets — TD-012 step 1.
 *
 * Every fixture value here is obviously fake. The test that matters most is the last one: a
 * redactor built from an empty secret set must still be a redactor, because the composition root
 * is allowed to say "this binding injected nothing" and nothing else may look like that by
 * accident.
 */
import { describe, expect, it } from 'vitest';
import {
  bindingSecretRedactor,
  composeSecretRedactors,
  exactSecretRedactor,
  MIN_SECRET_LENGTH,
  noSecretsRedactor,
} from './redaction.js';

const TOKEN = 'fake-gitlab-token-abcdefgh';
const LONGER = `${TOKEN}-with-suffix`;

describe('exactSecretRedactor', () => {
  it('replaces a secret in a string with a named placeholder', () => {
    const redactor = exactSecretRedactor([{ name: 'gitlab', value: TOKEN }]);
    const result = redactor.redactText(`git clone https://oauth2:${TOKEN}@git.example.test`);
    expect(result.value).toBe(
      'git clone https://oauth2:[REDACTED:integration:gitlab]@git.example.test',
    );
    expect(result.count).toBe(1);
  });

  it('counts every occurrence', () => {
    const redactor = exactSecretRedactor([{ name: 'gitlab', value: TOKEN }]);
    const result = redactor.redactText(`${TOKEN} and again ${TOKEN}`);
    expect(result.count).toBe(2);
    expect(result.value).not.toContain(TOKEN);
  });

  it('walks nested JSON, arrays included', () => {
    const redactor = exactSecretRedactor([{ name: 'jira', value: TOKEN }]);
    const result = redactor.redactJson({
      headers: { authorization: `Bearer ${TOKEN}` },
      retries: [{ note: `used ${TOKEN}` }, { note: 'clean' }],
      count: 2,
      nothing: null,
    });
    expect(JSON.stringify(result.value)).not.toContain(TOKEN);
    expect(result.count).toBe(2);
    expect(result.value.count).toBe(2);
    expect(result.value.nothing).toBeNull();
  });

  it('replaces the longer secret first, leaving no fragment behind', () => {
    const redactor = exactSecretRedactor([
      { name: 'short', value: TOKEN },
      { name: 'long', value: LONGER },
    ]);
    const result = redactor.redactText(`token=${LONGER}`);
    expect(result.value).toBe('token=[REDACTED:integration:long]');
    expect(result.value).not.toContain(TOKEN);
  });

  it('refuses a secret too short to be one', () => {
    expect(() => exactSecretRedactor([{ name: 'oops', value: 'abc' }])).toThrow(
      new RegExp(`${MIN_SECRET_LENGTH} characters`),
    );
    expect(() => exactSecretRedactor([{ name: '', value: TOKEN }])).toThrow(/needs a name/);
  });

  it('is a working redactor even with no secrets to remove', () => {
    const redactor = noSecretsRedactor();
    const result = redactor.redactJson({ body: 'nothing secret here' });
    expect(result).toEqual({ value: { body: 'nothing secret here' }, count: 0 });
  });
});

describe('composeSecretRedactors (rule 31: the adapter keeps its own guarantee)', () => {
  const BINDING = 'fake-binding-token-0123456789';

  it('applies every redactor and sums the counts', () => {
    const redactor = composeSecretRedactors(
      exactSecretRedactor([{ name: 'injected', value: TOKEN }]),
      exactSecretRedactor([{ name: 'binding', value: BINDING }]),
    );
    const result = redactor.redactText(`a=${TOKEN} b=${BINDING} c=${TOKEN}`);
    expect(result.value).toBe(
      'a=[REDACTED:integration:injected] b=[REDACTED:integration:binding] c=[REDACTED:integration:injected]',
    );
    expect(result.count).toBe(3);
  });

  it('still removes the binding’s own secret when the caller hands it a no-op redactor', () => {
    const redactor = composeSecretRedactors(
      noSecretsRedactor(),
      exactSecretRedactor([{ name: 'binding', value: BINDING }]),
    );
    const result = redactor.redactJson({ line: `authorization=Bearer ${BINDING}` });
    expect(JSON.stringify(result.value)).not.toContain(BINDING);
    expect(result.count).toBe(1);
  });
});

describe('bindingSecretRedactor', () => {
  it('redacts every value long enough to be a secret', () => {
    const redactor = bindingSecretRedactor([
      { name: 'loki_bearer_token', value: TOKEN },
      { name: 'loki_password', value: LONGER },
    ]);
    expect(redactor.redactText(`${TOKEN}/${LONGER}`).count).toBe(2);
  });

  it('skips an absent or too-short value instead of refusing to build', () => {
    const redactor = bindingSecretRedactor([
      null,
      undefined,
      { name: 'loki_password', value: 'abc' },
      { name: '', value: TOKEN },
    ]);
    expect(redactor.redactText(`abc ${TOKEN}`)).toEqual({ value: `abc ${TOKEN}`, count: 0 });
  });
});

/**
 * Exact-match redaction of injected secrets — TD-012 step 1.
 *
 * Every fixture value here is obviously fake. The test that matters most is the last one: a
 * redactor built from an empty secret set must still be a redactor, because the composition root
 * is allowed to say "this binding injected nothing" and nothing else may look like that by
 * accident.
 */
import { describe, expect, it } from 'vitest';
import { exactSecretRedactor, MIN_SECRET_LENGTH, noSecretsRedactor } from './redaction.js';

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

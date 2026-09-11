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

  /**
   * The property the executor's idempotency key used to depend on, now enforced where it is
   * decidable (rules 18, 44, 68).
   *
   * Both halves, because a boundary asserted from one side is half a test (rule 42): the duplicate
   * must be refused **and** two distinctly-named secrets must still both come through. Without the
   * second assertion a redactor that refused every set would pass the first.
   */
  it('refuses two secrets that share a placeholder name', () => {
    expect(() =>
      exactSecretRedactor([
        { name: 'jira', value: TOKEN },
        { name: 'jira', value: LONGER },
      ]),
    ).toThrow(/both named "jira"/);
  });

  it('refuses a duplicate name even when the two values are identical', () => {
    // Deliberate: the constructor refuses the *name*, not the collision it happens to cause, so
    // there is one rule to state and one to mutate. A set listing one secret twice is a
    // configuration defect whichever values it carries.
    expect(() =>
      exactSecretRedactor([
        { name: 'jira', value: TOKEN },
        { name: 'jira', value: TOKEN },
      ]),
    ).toThrow(/both named "jira"/);
  });

  it('keeps two distinctly named secrets apart, placeholder and count', () => {
    const redactor = exactSecretRedactor([
      { name: 'jira_api_token', value: TOKEN },
      { name: 'jira_webhook_secret', value: LONGER },
    ]);
    const result = redactor.redactText(`a=${TOKEN} b=${LONGER}`);

    expect(result.value).toBe(
      'a=[REDACTED:integration:jira_api_token] b=[REDACTED:integration:jira_webhook_secret]',
    );
    expect(result.count).toBe(2);
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

  /**
   * The limit of the refusal above, asserted rather than implied (rule 12).
   *
   * `composeSecretRedactors` is the shape production actually builds —
   * `composeSecretRedactors(options.redactor, bindingSecretRedactor([…]))` in all five adapters —
   * and it cannot see either redactor's secret set, because `SecretRedactor` is two methods and no
   * inventory. So the uniqueness `exactSecretRedactor` enforces stops at its own set, and a reader
   * who saw only the refusal would assume it reaches further. It does not; this is what that
   * looks like.
   *
   * What the gap costs is bounded, and the bound is why it is documented rather than closed: a
   * shared name is a fidelity loss in a row or a log, never an identity loss, because the one
   * place a redacted string was used as a key — the executor's idempotency scope — now refuses a
   * key that needs redacting instead of comparing placeholders.
   */
  it('cannot tell two composed redactors apart when they share a name', () => {
    const redactor = composeSecretRedactors(
      exactSecretRedactor([{ name: 'shared', value: TOKEN }]),
      exactSecretRedactor([{ name: 'shared', value: BINDING }]),
    );

    expect(redactor.redactText(`k=${TOKEN}`).value).toBe('k=[REDACTED:integration:shared]');
    expect(redactor.redactText(`k=${BINDING}`).value).toBe('k=[REDACTED:integration:shared]');
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

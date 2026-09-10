/**
 * TD-012 step 2.
 *
 * Every secret in this file is obviously fake and is asserted to be so by the last block: a
 * redaction test whose corpus contains a real credential is the worst possible place for one, since
 * the file exists to be read by everyone who ever touches the redactor.
 */
import { describe, expect, it } from 'vitest';
import {
  composeRedactors,
  detectSecrets,
  GITLEAKS_DERIVED_RULES,
  patternRedactor,
  redactionPlaceholder,
} from './pattern-redaction.js';

const FAKE = {
  anthropic: 'sk-ant-api03-FAKE-000000000000000000000000',
  openai: 'sk-proj-FAKE00000000000000000000000',
  github: 'ghp_FAKE000000000000000000000000000000000',
  gitlab: 'glpat-FAKE000000000000000',
  slack: 'xoxb-000000000000-FAKE',
  slackHook: 'https://hooks.slack.com/services/T00000000B00000000FAKEFAKEFAKE',
  atlassian: 'ATATT3xFfGF0FAKE000000000000000000',
  sentry: 'sntrys_00000000000000000000000000000000000FAKE',
  aws: 'AKIAIOSFODNN7EXAMPLE',
  google: 'AIzaSyD-000000000000000000000000000FAKE',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.FAKEFAKEFAKEsignatureFAKE',
  pem: '-----BEGIN RSA PRIVATE KEY-----\nFAKE-KEY-MATERIAL-0000\n-----END RSA PRIVATE KEY-----',
} as const;

describe('the placeholder', () => {
  it('is the `[REDACTED sha256:<6>]` form TD-012 specifies, and is stable per value', () => {
    expect(redactionPlaceholder('hunter2')).toMatch(/^\[REDACTED sha256:[0-9a-f]{6}]$/);
    expect(redactionPlaceholder('hunter2')).toBe(redactionPlaceholder('hunter2'));
    expect(redactionPlaceholder('hunter2')).not.toBe(redactionPlaceholder('hunter3'));
  });

  it('never contains the value it replaces', () => {
    expect(redactionPlaceholder(FAKE.gitlab)).not.toContain(FAKE.gitlab);
  });
});

describe('the rule set', () => {
  const redactor = patternRedactor();

  it.each(Object.entries(FAKE))('redacts a %s-shaped value', (_name, secret) => {
    const outcome = redactor.redactText(`the value is ${secret} and then some prose`);
    expect(outcome.value).not.toContain(secret);
    expect(outcome.count).toBeGreaterThan(0);
    expect(outcome.value).toContain('and then some prose');
  });

  it('names the rule that fired, so `redaction_log.rule_id` means something', () => {
    expect(detectSecrets(FAKE.aws).map((hit) => hit.ruleId)).toEqual(['aws-access-key-id']);
    expect(detectSecrets(FAKE.pem).map((hit) => hit.ruleId)).toEqual(['private-key']);
  });

  it('replaces the password of a connection string and not its username', () => {
    // The bug this pins: replacing a capture group by string search inside the match rewrites the
    // first occurrence of that text, which for `user:user@host` is the username.
    const outcome = redactor.redactText('postgres://hunter2:hunter2@db.example.invalid:5432/app');
    expect(outcome.value).toBe(
      `postgres://hunter2:${redactionPlaceholder('hunter2')}@db.example.invalid:5432/app`,
    );
    expect(outcome.count).toBe(1);
  });

  it('redacts only the value of a generic assignment, keeping the field name legible', () => {
    const outcome = redactor.redactText('api_key = "ABCDEFGHIJKLMNOPQRSTUVWX"');
    expect(outcome.value).toContain('api_key = "');
    expect(outcome.value).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWX');
  });

  it('leaves ordinary prose, short values and git object names alone', () => {
    const prose =
      'password: hunter2\nthe commit is 8852b9e2c1d4a0b6f3e7 and the file is src/index.ts';
    const outcome = redactor.redactText(prose);
    expect(outcome.count).toBe(0);
    expect(outcome.value).toBe(prose);
  });

  it('is idempotent: no rule matches the placeholder another rule left behind', () => {
    const once = redactor.redactText(`token=${FAKE.github} and ${FAKE.jwt}`);
    const twice = redactor.redactText(once.value);
    expect(twice.count).toBe(0);
    expect(twice.value).toBe(once.value);
  });

  it('finds every occurrence on a second call, so no rule keeps `lastIndex` between inputs', () => {
    const first = redactor.redactText(FAKE.gitlab);
    const second = redactor.redactText(FAKE.gitlab);
    expect(second.count).toBe(first.count);
    expect(second.value).toBe(first.value);
    // Two occurrences in one string are both replaced.
    const both = redactor.redactText(`${FAKE.gitlab} and ${FAKE.gitlab}`);
    expect(both.count).toBe(2);
    expect(both.value).not.toContain(FAKE.gitlab);
  });

  it('walks a JSON document and leaves the keys alone', () => {
    const outcome = redactor.redactJson({
      note: `use ${FAKE.github}`,
      nested: { list: [FAKE.gitlab, 'fine'], depth: { token: FAKE.slack } },
      count: 3,
      nothing: null,
    });
    const rendered = JSON.stringify(outcome.value);
    for (const secret of [FAKE.github, FAKE.gitlab, FAKE.slack]) {
      expect(rendered).not.toContain(secret);
    }
    expect(outcome.count).toBe(3);
    expect(Object.keys(outcome.value)).toEqual(['note', 'nested', 'count', 'nothing']);
  });
});

describe('composition (TD-012 order: injected secrets, then patterns)', () => {
  const injected = {
    redactText: (text: string) => {
      const parts = text.split('INJECTED-SECRET');
      return { value: parts.join('[REDACTED:integration:gitlab]'), count: parts.length - 1 };
    },
    redactJson: (value: Record<string, unknown>) => ({ value, count: 0 }),
  };

  it('applies both and sums the counts', () => {
    const composed = composeRedactors(injected, patternRedactor());
    const outcome = composed.redactText(`INJECTED-SECRET and ${FAKE.github}`);
    expect(outcome.value).toContain('[REDACTED:integration:gitlab]');
    expect(outcome.value).not.toContain(FAKE.github);
    expect(outcome.count).toBe(2);
  });

  it('names the integration for an injected value rather than anonymising it', () => {
    // The point of the order: reversed, the pattern rules would swallow the token into an
    // anonymous `[REDACTED sha256:…]` and the audit would lose which integration leaked.
    const composed = composeRedactors(injected, patternRedactor());
    expect(composed.redactText('INJECTED-SECRET').value).toBe('[REDACTED:integration:gitlab]');
  });
});

describe('the corpus itself', () => {
  it('contains no value that could be a real credential', () => {
    for (const [name, secret] of Object.entries(FAKE)) {
      expect(/FAKE|EXAMPLE/i.test(secret), `${name} must be obviously fake (BD-002)`).toBe(true);
    }
  });

  it('gives every rule a distinct id, so `redaction_log` rows are attributable', () => {
    const ids = GITLEAKS_DERIVED_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

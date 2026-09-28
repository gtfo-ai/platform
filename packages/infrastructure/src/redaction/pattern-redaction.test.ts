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
  currentPatternRules,
  detectSecrets,
  GITLEAKS_DERIVED_RULES,
  installedMintedCredentialShapeRules,
  installMintedCredentialShapes,
  MINTED_CREDENTIAL_SHAPE_RULE_ID,
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

/**
 * PROGRESS backlog 154, **decision (a)** (WP-72): a run's minted git credential is redacted by
 * exact match only in the process that minted it, and on the shipped topology the process that
 * stores most of what could quote it — every webhook delivery, half the outbound duties — is not
 * that process. So step 2 is the defence there — the gitleaks rules, and since WP-80 the shape rule
 * compiled from what the minting process recorded (backlog 259) — and this block pins what each
 * covers, with no run-scoped registry anywhere in sight.
 *
 * Shapes, from GitLab's own pages (retrieved 2026-09-27): a project access token carries the
 * personal-access-token prefix, `glpat-` by default, and an administrator may change that prefix
 * (<https://docs.gitlab.com/administration/settings/account_and_limit_settings/>); the routable
 * format is `glpat-<base64-payload>.<version>.<length+crc32>`
 * (<https://handbook.gitlab.com/handbook/engineering/architecture/design-documents/cells/routable_tokens/>).
 */
describe('a run credential redacted in a process that never minted it (backlog 154 (a))', () => {
  const redactor = patternRedactor();

  it('redacts a GitLab project access token of the documented default shape', () => {
    const minted = 'glpat-FAKE0minted0run0token00';
    const outcome = redactor.redactText(
      `git push https://agentic:${minted}@git.example.test/a.git`,
    );
    expect(outcome.value).not.toContain(minted);
    expect(outcome.value).not.toContain('FAKE0minted0run0token00');
    expect(outcome.count).toBe(1);
    expect(detectSecrets(minted).map((hit) => hit.ruleId)).toEqual(['gitlab-token']);
  });

  it('redacts the secret part of a routable token, leaving only its version and checksum', () => {
    const payload = 'FAKE0routable0payload0000000000';
    const outcome = redactor.redactText(`token glpat-${payload}.01.0a1b2c3d in the log`);
    expect(outcome.value).not.toContain(payload);
    // What survives is `.01.0a1b2c3d` — the base-36 version and the payload length + CRC32, which
    // GitLab's design places after the entropy. Stated rather than hidden: it is not the secret.
    expect(outcome.value).toContain('.01.0a1b2c3d in the log');
  });

  /**
   * WP-80 (TD-012's M5 amendment) inverted the residual WP-72 pinned here as *"does not redact a
   * token minted under an administrator-chosen prefix — the trigger for (b)"*: the gitleaks set
   * alone still misses it — asserted, because that is why the shape rule exists — and the process's
   * shape rules, installed from `minted_credential_shapes`, catch it.
   */
  it('redacts a token minted under an administrator-chosen prefix once its shape is installed (backlog 259)', () => {
    const minted = 'acmepat-FAKE0custom0prefix0token';
    expect(patternRedactor(GITLEAKS_DERIVED_RULES).redactText(minted).value).toBe(minted);
    try {
      installMintedCredentialShapes([
        { prefix: 'acmepat-', charset: 'token_dotted', length: minted.length },
      ]);
      const outcome = redactor.redactText(`pushed with https://agentic:${minted}@git.example.test`);
      expect(outcome.value).not.toContain(minted);
      expect(outcome.value).toContain(redactionPlaceholder(minted));
      expect(outcome.count).toBe(1);
    } finally {
      installMintedCredentialShapes([]);
    }
  });
});

describe('the minted-credential shape rules (WP-80, TD-012’s M5 amendment)', () => {
  const minted = 'acmepat-FAKE0shape0rule0value00';
  const shape = { prefix: 'acmepat-', charset: 'token', length: minted.length } as const;

  it('are read at call time, so a redactor built before the install applies them', () => {
    const early = patternRedactor();
    try {
      expect(early.redactText(minted).value).toBe(minted);
      expect(installMintedCredentialShapes([shape])).toEqual({ installed: 1, refused: 0 });
      expect(early.redactText(minted).value).toBe(redactionPlaceholder(minted));
      expect(early.redactJson({ comment: `quoted ${minted}` }).count).toBe(1);
    } finally {
      installMintedCredentialShapes([]);
    }
    expect(early.redactText(minted).value).toBe(minted);
  });

  it('run first, so the hit is recorded under the shape rule and not the generic one', () => {
    try {
      installMintedCredentialShapes([shape]);
      expect(detectSecrets(`token = ${minted}`, currentPatternRules())).toEqual([
        { ruleId: MINTED_CREDENTIAL_SHAPE_RULE_ID, value: minted },
      ]);
    } finally {
      installMintedCredentialShapes([]);
    }
  });

  it('match exactly the recorded length of the class after the literal prefix', () => {
    try {
      installMintedCredentialShapes([shape]);
      const redactor = patternRedactor();
      // One character short of the shape is another string, left alone.
      expect(redactor.redactText(minted.slice(0, -1)).value).toBe(minted.slice(0, -1));
      // A prefix character is literal: `acmepatX…` is not the prefix.
      const other = `acmepatX${minted.slice('acmepat-'.length)}`;
      expect(redactor.redactText(other).value).toBe(other);
    } finally {
      installMintedCredentialShapes([]);
    }
  });

  it('deduplicate, skip a shape the compiler refuses, and replace the set wholesale', () => {
    try {
      expect(
        installMintedCredentialShapes([
          shape,
          shape,
          { prefix: 'x', charset: 'alnum', length: 20 },
        ] as never),
      ).toEqual({ installed: 1, refused: 1 });
      expect(installedMintedCredentialShapeRules()).toHaveLength(1);
      installMintedCredentialShapes([]);
      expect(installedMintedCredentialShapeRules()).toEqual([]);
      expect(currentPatternRules()).toBe(GITLEAKS_DERIVED_RULES);
    } finally {
      installMintedCredentialShapes([]);
    }
  });

  it('leave an explicit rule list alone', () => {
    try {
      installMintedCredentialShapes([shape]);
      expect(patternRedactor(GITLEAKS_DERIVED_RULES).redactText(minted).value).toBe(minted);
    } finally {
      installMintedCredentialShapes([]);
    }
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

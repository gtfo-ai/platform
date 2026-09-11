/**
 * Slack request signing, one negative at a time — **each paired with an authentic control**.
 *
 * A green negative is the cheapest lie a security test tells: `verify` returning `false` proves
 * nothing when the harness could not have produced a `true` in the first place (standing rule 4).
 * So every case below asserts the tampered delivery is refused *and*, in the same test, that the
 * untampered one from the same builder is accepted. Break the verifier open — return `true`
 * unconditionally — and the negatives fail; break the *harness* — sign with the wrong key, forget
 * a header — and the controls fail. Neither failure can hide behind the other.
 */
import { createHmac } from 'node:crypto';
import {
  exactSecretRedactor,
  noSecretsRedactor,
  type WebhookDelivery,
} from '@platform/application';
import { fixedClock } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import {
  constantTimeEquals,
  SLACK_SIGNATURE_HEADER,
  SLACK_TIMESTAMP_HEADER,
  signSlackRequest,
  slackDeliveryKey,
  usableSigningSecret,
  verifySlackDelivery,
} from './signature.js';

/** Obviously fake, and not a credential: it exists so a test can tamper and watch `verify` refuse. */
const SECRET = 'fake-slack-signing-secret-do-not-use';
const NOW = '2026-06-01T09:00:00.000Z';
const NOW_SECONDS = Math.floor(Date.parse(NOW) / 1000);
const clock = () => fixedClock(NOW);
const secrets = { signingSecret: SECRET, toleranceSeconds: 300 };

const BODY = JSON.stringify({ type: 'event_callback', event_id: 'Ev0FAKE0001' });

const delivery = (
  overrides: {
    body?: string;
    timestamp?: string;
    signature?: string;
    dropSignature?: boolean;
    dropTimestamp?: boolean;
  } = {},
): WebhookDelivery => {
  const body = overrides.body ?? BODY;
  const timestamp = overrides.timestamp ?? String(NOW_SECONDS);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (overrides.dropTimestamp !== true) {
    headers[SLACK_TIMESTAMP_HEADER] = timestamp;
  }
  if (overrides.dropSignature !== true) {
    headers[SLACK_SIGNATURE_HEADER] =
      overrides.signature ?? signSlackRequest(SECRET, timestamp, body);
  }
  return { headers, body };
};

const authentic = (): WebhookDelivery => delivery();

describe('signSlackRequest', () => {
  it('signs the documented basestring `v0:timestamp:body` and prefixes `v0=`', () => {
    // The scheme, restated independently of the implementation: if `signSlackRequest` changed the
    // separator or the version, this fails rather than agreeing with itself. Slack's own example
    // basestring is `'v0:' + timestamp + ':' + request_body` with a form-encoded body; the
    // timestamp below is the one the page prints, the body is an obviously fake one of the same
    // shape (BD-002 — the documented body is a high-entropy string the secret scanner objects to,
    // and nothing about this assertion needs its exact bytes).
    const body = 'channel=C0FAKECHAN1&text=hello';
    const signature = signSlackRequest(SECRET, '1531420618', body);
    expect(signature.startsWith('v0=')).toBe(true);
    expect(signature).toBe(
      `v0=${createHmac('sha256', SECRET).update(`v0:1531420618:${body}`, 'utf8').digest('hex')}`,
    );
  });
});

describe('verifySlackDelivery', () => {
  it('accepts an authentic delivery', () => {
    expect(verifySlackDelivery(authentic(), secrets, clock())).toBe(true);
  });

  it('refuses a tampered body, and accepts the untampered control', () => {
    const original = authentic();
    expect(verifySlackDelivery(original, secrets, clock()), 'control: authentic').toBe(true);
    expect(
      verifySlackDelivery({ headers: original.headers, body: '{"type":"evil"}' }, secrets, clock()),
      'a body that is not the one that was signed',
    ).toBe(false);
  });

  it('refuses a same-length wrong signature, and accepts the control', () => {
    const original = authentic();
    const provided = original.headers[SLACK_SIGNATURE_HEADER] as string;
    // Same length, same prefix, one hex digit different: nothing but the comparison can catch it.
    const last = provided.at(-1) === '0' ? '1' : '0';
    const tampered = `${provided.slice(0, -1)}${last}`;
    expect(tampered.length, 'the forgery is the same length').toBe(provided.length);
    expect(verifySlackDelivery(original, secrets, clock()), 'control: authentic').toBe(true);
    expect(verifySlackDelivery(delivery({ signature: tampered }), secrets, clock())).toBe(false);
  });

  it('refuses a missing signature header, and accepts the control', () => {
    expect(verifySlackDelivery(authentic(), secrets, clock()), 'control: authentic').toBe(true);
    expect(verifySlackDelivery(delivery({ dropSignature: true }), secrets, clock())).toBe(false);
  });

  it('refuses a missing timestamp header, and accepts the control', () => {
    expect(verifySlackDelivery(authentic(), secrets, clock()), 'control: authentic').toBe(true);
    expect(verifySlackDelivery(delivery({ dropTimestamp: true }), secrets, clock())).toBe(false);
  });

  it('refuses a replayed old timestamp, and accepts one inside the window', () => {
    const stale = String(NOW_SECONDS - 301);
    const fresh = String(NOW_SECONDS - 299);
    expect(
      verifySlackDelivery(
        delivery({ timestamp: fresh, signature: signSlackRequest(SECRET, fresh, BODY) }),
        secrets,
        clock(),
      ),
      'control: 299 seconds old is inside the five-minute window',
    ).toBe(true);
    expect(
      verifySlackDelivery(
        delivery({ timestamp: stale, signature: signSlackRequest(SECRET, stale, BODY) }),
        secrets,
        clock(),
      ),
      'a correctly signed delivery from outside the window is a replay',
    ).toBe(false);
  });

  it('refuses a timestamp too far in the future, and accepts one inside the window', () => {
    const ahead = String(NOW_SECONDS + 301);
    const near = String(NOW_SECONDS + 299);
    expect(
      verifySlackDelivery(
        delivery({ timestamp: near, signature: signSlackRequest(SECRET, near, BODY) }),
        secrets,
        clock(),
      ),
      'control: a small forward skew is tolerated',
    ).toBe(true);
    expect(
      verifySlackDelivery(
        delivery({ timestamp: ahead, signature: signSlackRequest(SECRET, ahead, BODY) }),
        secrets,
        clock(),
      ),
    ).toBe(false);
  });

  it('refuses a non-integer timestamp, and accepts the control', () => {
    expect(verifySlackDelivery(authentic(), secrets, clock()), 'control: authentic').toBe(true);
    for (const timestamp of ['not-a-number', '', '1e9', '1780000000.5']) {
      expect(
        verifySlackDelivery(
          delivery({ timestamp, signature: signSlackRequest(SECRET, timestamp, BODY) }),
          secrets,
          clock(),
        ),
        `timestamp ${JSON.stringify(timestamp)}`,
      ).toBe(false);
    }
  });

  it('refuses a wrong version prefix even when the digest matches, and accepts `v0=`', () => {
    // A *behaviour* test, not a test of the `startsWith` line: that line is unreachable defence in
    // depth (see `signature.ts`), because the whole-string comparison already refuses anything
    // without the `v0=` prefix. Deleting it leaves this test green, which is the honest reading.

    const original = authentic();
    const digest = (original.headers[SLACK_SIGNATURE_HEADER] as string).slice('v0='.length);
    expect(verifySlackDelivery(original, secrets, clock()), 'control: v0= is accepted').toBe(true);
    expect(
      verifySlackDelivery(delivery({ signature: `v1=${digest}` }), secrets, clock()),
      'a scheme this module has never read must not be accepted on the strength of the digest',
    ).toBe(false);
    expect(verifySlackDelivery(delivery({ signature: digest }), secrets, clock())).toBe(false);
  });

  it('refuses a delivery signed with a different secret, and accepts the control', () => {
    const timestamp = String(NOW_SECONDS);
    expect(verifySlackDelivery(authentic(), secrets, clock()), 'control: authentic').toBe(true);
    expect(
      verifySlackDelivery(
        delivery({ signature: signSlackRequest('another-fake-secret', timestamp, BODY) }),
        secrets,
        clock(),
      ),
    ).toBe(false);
  });

  describe('an empty credential is not a credential (standing rule 18)', () => {
    // WP-08 shipped a verifier that accepted `HMAC-SHA256('', body)` because an unset secret
    // became an empty string. Each case below signs *with the empty key* — the signature any
    // attacker can compute — and asserts it is refused, beside the control that a configured
    // binding accepts a real one.
    for (const [name, configured] of [
      ['absent', null],
      ['empty', ''],
      ['whitespace', '   '],
    ] as const) {
      it(`refuses everything when the signing secret is ${name}`, () => {
        const empty = { signingSecret: configured, toleranceSeconds: 300 };
        const timestamp = String(NOW_SECONDS);
        const forged = delivery({ signature: signSlackRequest(configured ?? '', timestamp, BODY) });

        expect(
          verifySlackDelivery(authentic(), secrets, clock()),
          'control: a configured binding accepts an authentic delivery',
        ).toBe(true);
        expect(
          verifySlackDelivery(forged, empty, clock()),
          'a signature computed with the unset secret must not verify',
        ).toBe(false);
        expect(
          verifySlackDelivery(authentic(), empty, clock()),
          'and neither must a genuinely authentic one: an unconfigured binding verifies nothing',
        ).toBe(false);
      });
    }

    it('reports an unusable secret as unusable', () => {
      expect(usableSigningSecret(SECRET)).toBe(SECRET);
      expect(usableSigningSecret('')).toBeNull();
      expect(usableSigningSecret('  \t ')).toBeNull();
      expect(usableSigningSecret(null)).toBeNull();
      expect(usableSigningSecret(undefined)).toBeNull();
    });
  });
});

describe('constantTimeEquals', () => {
  it('is true only for identical strings', () => {
    expect(constantTimeEquals('v0=abc', 'v0=abc')).toBe(true);
    expect(constantTimeEquals('v0=abc', 'v0=abd')).toBe(false);
    expect(constantTimeEquals('v0=abc', 'v0=ab')).toBe(false);
    expect(constantTimeEquals('', '')).toBe(true);
  });
});

describe('slackDeliveryKey', () => {
  it('keys an Events API delivery on its event_id, which survives a redelivery', () => {
    const body = JSON.stringify({ type: 'event_callback', event_id: 'Ev0FAKE0001' });
    const first = slackDeliveryKey({ headers: {}, body }, noSecretsRedactor());
    const redelivered = slackDeliveryKey(
      { headers: { 'x-slack-retry-num': '2' }, body },
      noSecretsRedactor(),
    );
    expect(first).toBe('slack:event:Ev0FAKE0001');
    expect(redelivered, 'a retry of the same event keys the same').toBe(first);
  });

  it('keys an interaction on the click, not on the delivery', () => {
    const click = (actionTs: string): string =>
      slackDeliveryKey(
        {
          headers: {},
          body: JSON.stringify({
            type: 'block_actions',
            team: { id: 'T0FAKETEAM' },
            user: { id: 'U0FAKEDEV1' },
            actions: [{ action_id: 'agentic_answer', action_ts: actionTs }],
          }),
        },
        noSecretsRedactor(),
      );
    expect(click('1780000000.000100')).toBe(
      'slack:action:T0FAKETEAM:U0FAKEDEV1:agentic_answer:1780000000.000100',
    );
    expect(click('1780000000.000100'), 'the same click keys the same').toBe(
      click('1780000000.000100'),
    );
    expect(click('1780000009.000100'), 'a second click is a second decision').not.toBe(
      click('1780000000.000100'),
    );
  });

  it('refuses a delivery with nothing to key on', () => {
    expect(() => slackDeliveryKey({ headers: {}, body: 'not json' }, noSecretsRedactor())).toThrow(
      /not JSON/,
    );
    expect(() =>
      slackDeliveryKey({ headers: {}, body: '{"type":"event_callback"}' }, noSecretsRedactor()),
    ).toThrow(/nothing to key on/);
    expect(() =>
      slackDeliveryKey({ headers: {}, body: '{"type":"url_verification"}' }, noSecretsRedactor()),
    ).toThrow(/nothing to key on/);
  });

  /**
   * **The key is stored, so a secret in it outlives a log line.** Every part Slack keys on comes
   * out of the delivery body, which is untrusted provider text (BD-022); the platform writes the
   * key as `inbox.delivery_id` (technical/03) and compares it on every later delivery. Before this
   * parameter existed the function took no redactor at all while the same object literal's
   * `normalise` did — the third instance of the defect the previous commit closed for Jira and
   * GitLab (rule 49).
   *
   * The refusal **cuts** to 32 characters, and a cut applied to unredacted text leaves a fragment
   * no exact-match redactor can find again, which is why redaction precedes the `slice`.
   */
  describe('is redacted, because a delivery body is provider text nothing else on this path redacts', () => {
    const PLANTED = 'FAKE-PLANTED-slack-signing-secret-0123456789';
    const PLACEHOLDER = '[REDACTED:integration:planted]';
    const planted = (): ReturnType<typeof exactSecretRedactor> =>
      exactSecretRedactor([{ name: 'planted', value: PLANTED }]);

    it('redacts the event key it returns, which the platform stores and compares', () => {
      expect(
        slackDeliveryKey(
          {
            headers: {},
            body: JSON.stringify({ type: 'event_callback', event_id: `Ev-${PLANTED}` }),
          },
          planted(),
        ),
      ).toBe(`slack:event:Ev-${PLACEHOLDER}`);
    });

    it('redacts the interaction key, whose five parts all come out of the body', () => {
      expect(
        slackDeliveryKey(
          {
            headers: {},
            body: JSON.stringify({
              type: 'block_actions',
              team: { id: `T-${PLANTED}` },
              user: { id: `U-${PLANTED}` },
              actions: [{ action_id: `a-${PLANTED}`, action_ts: `1780000000.${PLANTED}` }],
            }),
          },
          planted(),
        ),
      ).toBe(
        `slack:action:T-${PLACEHOLDER}:U-${PLACEHOLDER}:a-${PLACEHOLDER}:1780000000.${PLACEHOLDER}`,
      );
    });

    it('redacts before the 32-character cut, so the refusal carries no fragment', () => {
      let caught: unknown;
      try {
        slackDeliveryKey({ headers: {}, body: JSON.stringify({ type: PLANTED }) }, planted());
      } catch (error) {
        caught = error;
      }
      expect((caught as Error).message).not.toContain(PLANTED.slice(0, 12));
      expect((caught as Error).message).toContain(PLACEHOLDER.slice(0, 12));
    });
  });
});

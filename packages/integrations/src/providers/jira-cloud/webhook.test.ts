/**
 * The signature arithmetic and the delivery key, pinned to what Atlassian publishes.
 *
 * The first test is the whole reason this file exists: Atlassian's webhooks page prints a **test
 * vector** — secret, payload, method and the resulting `X-Hub-Signature` — so this is the one part
 * of the provider that can be checked against Atlassian's own arithmetic rather than against our
 * reading of a sentence. Everything else here is a negative case, and every negative is paired
 * with the positive that proves the harness can produce an acceptable delivery.
 */
import {
  exactSecretRedactor,
  IntegrationError,
  noSecretsRedactor,
  type WebhookDelivery,
} from '@platform/application';
import { fixedClock } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import {
  jiraDeliveryKey,
  signWebhookBody,
  verifyJiraDelivery,
  type WebhookVerifierOptions,
} from './webhook.js';

/** https://developer.atlassian.com/cloud/jira/platform/webhooks/ § "Testing the webhook payload validation" (retrieved 2026-09-10). */
const DOCUMENTED_SECRET = "It's a Secret to Everybody";
const DOCUMENTED_PAYLOAD = 'Hello World!';
const DOCUMENTED_SIGNATURE =
  'sha256=a4771c39fbe90f317c7824e83ddef3caae9cb3d976c214ace1f2937e133263c9';

const SECRET = 'FAKE-jira-webhook-secret-0123456789';
const NOW = '2026-09-02T12:05:00.000Z' as const;
const clock = fixedClock(NOW, 0);
const SENT_AT = Date.parse('2026-09-02T12:00:00.000Z');

const deliveryOf = (payload: Record<string, unknown>, secret = SECRET): WebhookDelivery => {
  const body = JSON.stringify(payload);
  return {
    headers: {
      'x-atlassian-webhook-identifier': '00000000-0000-4000-8000-00000000d001',
      'x-hub-signature': signWebhookBody(secret, body),
    },
    body,
  };
};

const fresh = (): WebhookDelivery =>
  deliveryOf({ timestamp: SENT_AT, webhookEvent: 'jira:issue_updated' });

describe('signWebhookBody', () => {
  it('reproduces Atlassian’s published test vector', () => {
    expect(signWebhookBody(DOCUMENTED_SECRET, DOCUMENTED_PAYLOAD)).toBe(DOCUMENTED_SIGNATURE);
  });

  it('signs the bytes, so a re-serialised body is a different document', () => {
    const canonical = '{"a":1,"b":2}';
    const reordered = '{"b":2,"a":1}';
    expect(signWebhookBody(SECRET, canonical)).not.toBe(signWebhookBody(SECRET, reordered));
  });

  it('handles a payload with non-ASCII characters as UTF-8', () => {
    // "ensure that you handle the payload as UTF-8. Webhook payloads can contain Unicode
    // characters." A latin-1 read of the same bytes would produce a different digest.
    const body = JSON.stringify({ summary: 'Totály špatné součty — 30 €' });
    expect(signWebhookBody(SECRET, body)).toBe(
      signWebhookBody(SECRET, Buffer.from(body, 'utf8').toString('utf8')),
    );
  });
});

describe('verifyJiraDelivery', () => {
  const verify = (delivery: WebhookDelivery, maxAgeMs?: number): boolean =>
    verifyJiraDelivery(
      { secret: SECRET, clock, ...(maxAgeMs === undefined ? {} : { maxAgeMs }) },
      delivery,
    );

  it('accepts a delivery signed with the secret', () => {
    expect(verify(fresh())).toBe(true);
  });

  it('rejects every way a signature can be wrong', () => {
    const authentic = fresh();
    expect(verify(authentic), 'control').toBe(true);

    const signature = authentic.headers['x-hub-signature'] as string;
    const cases: readonly [string, WebhookDelivery][] = [
      ['no header', { headers: {}, body: authentic.body }],
      ['empty header', { headers: { 'x-hub-signature': '' }, body: authentic.body }],
      [
        'no method prefix',
        { headers: { 'x-hub-signature': signature.slice('sha256='.length) }, body: authentic.body },
      ],
      [
        'another method',
        {
          headers: { 'x-hub-signature': `sha512=${signature.slice('sha256='.length)}` },
          body: authentic.body,
        },
      ],
      [
        'right length, wrong digest',
        {
          headers: {
            'x-hub-signature': `${signature.slice(0, -1)}${signature.endsWith('0') ? '1' : '0'}`,
          },
          body: authentic.body,
        },
      ],
      [
        'a digest of the wrong length',
        // `timingSafeEqual` throws on differing lengths, so the length is compared first — this is
        // the input that would make an unguarded comparison throw instead of returning false.
        { headers: { 'x-hub-signature': 'sha256=deadbeef' }, body: authentic.body },
      ],
      ['tampered body', { headers: authentic.headers, body: `${authentic.body} ` }],
      ['another secret', deliveryOf({ timestamp: SENT_AT }, 'FAKE-another-secret-01234567')],
    ];
    for (const [name, delivery] of cases) {
      expect(verify(delivery), name).toBe(false);
    }
  });

  it('rejects a correctly signed delivery that is older than the window', () => {
    const old = deliveryOf({ timestamp: SENT_AT - 25 * 60 * 60 * 1000 });
    expect(verify(old)).toBe(false);
    // The same body, inside a window wide enough for it, is accepted — so the rejection is the
    // age and not the signature.
    expect(verify(old, 26 * 60 * 60 * 1000)).toBe(true);
  });

  it('rejects a delivery dated in the future beyond one minute of skew', () => {
    expect(verify(deliveryOf({ timestamp: SENT_AT + 30 * 1000 })), 'inside the allowance').toBe(
      true,
    );
    expect(verify(deliveryOf({ timestamp: SENT_AT + 10 * 60 * 1000 }))).toBe(false);
  });

  it('rejects a delivery the attacker signed himself, when the binding holds no secret', () => {
    // WP-08 review round 1: `secret: ''` verified anything, because `HMAC-SHA256('', body)` is a
    // digest the sender can compute as easily as we can. The forgery below is exactly what the
    // reviewer sent. `capabilities().webhooks` is not in this test on purpose — the guard being
    // asserted is this function's own (standing rules 3 and 9).
    const forged = deliveryOf({ timestamp: SENT_AT, webhookEvent: 'jira:issue_updated' }, '');
    for (const secret of ['', null] as const) {
      expect(
        verifyJiraDelivery({ secret, clock }, forged),
        `a binding with ${secret === null ? 'no' : 'an empty'} secret rejects the forgery`,
      ).toBe(false);
      expect(
        verifyJiraDelivery({ secret, clock }, fresh()),
        'and rejects a delivery signed with the real secret too — it can verify nothing',
      ).toBe(false);
    }
    // Control (standing rule 4): the same envelope, signed with a real secret and read by a
    // binding that holds it, is accepted — so the rejections above are the missing secret and not
    // a harness that cannot produce an acceptable delivery at all.
    expect(verify(fresh()), 'control: this harness can produce an acceptable delivery').toBe(true);
  });

  it('rejects a delivery when the secret field is absent, not merely null', () => {
    // WP-08 review round 2. `secret === null` did not catch an **absent** field, so
    // `secret.length` threw a `TypeError` out of the one function that answers "is this
    // authentic?" — neither a refusal nor a typed error. Standing rule 14: the type said
    // `string | null`, and a type is not a boundary; standing rule 18: a missing credential is no
    // more a credential than an empty one. Driven the way a JavaScript caller reaches it, with the
    // key genuinely not present.
    const absent = { clock } as unknown as WebhookVerifierOptions;
    expect('secret' in absent, 'the key really is absent, not undefined-valued').toBe(false);
    expect(
      () => verifyJiraDelivery(absent, fresh()),
      'refuses rather than throwing a TypeError out of the verifier',
    ).not.toThrow();
    expect(
      verifyJiraDelivery(absent, fresh()),
      'a delivery signed with the real secret is still refused: this binding can verify nothing',
    ).toBe(false);
    expect(
      verifyJiraDelivery(absent, deliveryOf({ timestamp: SENT_AT }, '')),
      'and so is the forgery signed with the empty key',
    ).toBe(false);
    expect(
      verifyJiraDelivery({ secret: undefined, clock }, fresh()),
      'an explicit undefined takes the same path',
    ).toBe(false);
    // Control (standing rule 4): the same deliveries verify when the secret is there, so the
    // refusals above are the missing secret and not a harness that cannot verify anything.
    expect(verify(fresh()), 'control: this harness can produce an acceptable delivery').toBe(true);
  });

  it('rejects a body with no timestamp, or a body that is not JSON at all', () => {
    expect(verify(deliveryOf({ webhookEvent: 'jira:issue_updated' }))).toBe(false);
    const body = 'not json';
    expect(
      verify({ headers: { 'x-hub-signature': signWebhookBody(SECRET, body) }, body }),
      'signature matches, envelope does not',
    ).toBe(false);
  });
});

describe('jiraDeliveryKey', () => {
  it('is the identifier header, prefixed by the provider', () => {
    expect(jiraDeliveryKey(fresh(), noSecretsRedactor())).toBe(
      'jira-cloud:00000000-0000-4000-8000-00000000d001',
    );
  });

  it('is stable for the same delivery and different for another', () => {
    const first = fresh();
    const second: WebhookDelivery = {
      headers: { ...first.headers, 'x-atlassian-webhook-identifier': 'other' },
      body: first.body,
    };
    expect(jiraDeliveryKey(first, noSecretsRedactor())).toBe(
      jiraDeliveryKey(first, noSecretsRedactor()),
    );
    expect(jiraDeliveryKey(first, noSecretsRedactor())).not.toBe(
      jiraDeliveryKey(second, noSecretsRedactor()),
    );
  });

  /**
   * The key is a **header value** copied verbatim into a string the platform stores. Nothing else
   * in this adapter emits a header, and until review round 2 nothing redacted one.
   */
  it('redacts the identifier header, which is provider text like any other', () => {
    const PLANTED = 'FAKE-planted-binding-credential-0123456789';
    expect(
      jiraDeliveryKey(
        { headers: { 'x-atlassian-webhook-identifier': `d-${PLANTED}` }, body: '{}' },
        exactSecretRedactor([{ name: 'planted', value: PLANTED }]),
      ),
    ).toBe('jira-cloud:d-[REDACTED:integration:planted]');
  });

  it('throws invalid_request when there is nothing to key on', () => {
    let caught: unknown;
    try {
      jiraDeliveryKey({ headers: {}, body: '{}' }, noSecretsRedactor());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IntegrationError);
    expect((caught as IntegrationError).code).toBe('invalid_request');
  });
});

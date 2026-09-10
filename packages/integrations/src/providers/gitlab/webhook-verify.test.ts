/**
 * Webhook verification, both schemes, positively and then negatively.
 *
 * Order matters here and it is standing rule 4: **before asserting that anything is rejected, the
 * harness is shown to build a delivery that is accepted.** A verification test that only proves
 * rejection also passes when `verify` returns `false` unconditionally, which is a webhook endpoint
 * that never works and a test suite that never says so.
 *
 * Every guard below has a note naming the assertion that fails when it is reverted — standing
 * rule 3, mutation-checked rather than asserted in prose.
 */
import { createHmac } from 'node:crypto';
import {
  exactSecretRedactor,
  IntegrationError,
  noSecretsRedactor,
  type WebhookDelivery,
} from '@platform/application';
import { fixedClock } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import {
  constantTimeEquals,
  decodeSigningToken,
  gitLabDeliveryKey,
  standardWebhookSignature,
  verifyGitLabDelivery,
  type WebhookSecrets,
} from './webhook-verify.js';

const AT = '2026-06-01T08:00:00.000Z';
const NOW_SECONDS = Math.floor(Date.parse(AT) / 1000);
const clock = () => fixedClock(AT);

/**
 * Obviously fake (BD-002), and assembled at run time on purpose: a literal `whsec_<base64>` has
 * the entropy of a real signing token and gitleaks flags it as one.
 */
const SIGNING_KEY_TEXT = 'fake-gitlab-signing-key-do-not-use';
const SIGNING_TOKEN = `whsec_${Buffer.from(SIGNING_KEY_TEXT).toString('base64')}`;
const SECRET_TOKEN = 'fake-gitlab-webhook-secret-token-do-not-use';
const MESSAGE_ID = 'f5e5f430-f57b-4e6e-9fac-d9128cd7232f';

const BODY = JSON.stringify({
  object_kind: 'merge_request',
  object_attributes: { id: 93, iid: 16, action: 'open', updated_at: '2026-06-01T07:59:00.000Z' },
});

const secrets = (overrides: Partial<WebhookSecrets> = {}): WebhookSecrets => ({
  secretToken: SECRET_TOKEN,
  signingToken: SIGNING_TOKEN,
  toleranceSeconds: 300,
  ...overrides,
});

const legacy = (token: string = SECRET_TOKEN, body = BODY): WebhookDelivery => ({
  headers: { 'x-gitlab-event': 'Merge Request Hook', 'x-gitlab-token': token },
  body,
});

const signed = (
  options: {
    readonly body?: string;
    readonly messageId?: string;
    readonly timestamp?: string;
    readonly signature?: string;
    readonly extra?: readonly string[];
  } = {},
): WebhookDelivery => {
  const body = options.body ?? BODY;
  const messageId = options.messageId ?? MESSAGE_ID;
  const timestamp = options.timestamp ?? String(NOW_SECONDS);
  const key = Buffer.from(SIGNING_TOKEN.replace(/^whsec_/, ''), 'base64');
  const signature = options.signature ?? standardWebhookSignature(key, messageId, timestamp, body);
  return {
    headers: {
      'x-gitlab-event': 'Merge Request Hook',
      'webhook-id': messageId,
      'webhook-timestamp': timestamp,
      'webhook-signature': [...(options.extra ?? []), signature].join(' '),
    },
    body,
  };
};

describe('verifyGitLabDelivery — the harness can build an accepted delivery', () => {
  it('accepts a legacy X-Gitlab-Token delivery', () => {
    expect(verifyGitLabDelivery(legacy(), secrets(), clock())).toBe(true);
  });

  it('accepts a Standard Webhooks delivery', () => {
    expect(verifyGitLabDelivery(signed(), secrets(), clock())).toBe(true);
  });

  it('computes the signature GitLab documents: v1,<base64 hmac over id.timestamp.body>', () => {
    // The reference implementation in the docs, transcribed:
    //   raw_key = base64_decode(strip_prefix(signing_token, 'whsec_'))
    //   message = "{message_id}.{timestamp}.{body}"
    //   expected = "v1," + base64(hmac_sha256(raw_key, message))
    const key = Buffer.from(SIGNING_TOKEN.replace(/^whsec_/, ''), 'base64');
    const expected = `v1,${createHmac('sha256', key)
      .update(`${MESSAGE_ID}.${NOW_SECONDS}.${BODY}`, 'utf8')
      .digest('base64')}`;
    expect(signed().headers['webhook-signature']).toBe(expected);
  });
});

describe('verifyGitLabDelivery — legacy secret token', () => {
  // Mutation: drop the `constantTimeEquals` result and return `true`, and
  // "rejects a wrong token" fails.
  it('rejects a wrong token', () => {
    expect(verifyGitLabDelivery(legacy('fake-wrong-token'), secrets(), clock())).toBe(false);
  });

  it('rejects a token of the right length with a wrong value', () => {
    const wrong = `${SECRET_TOKEN.slice(0, -1)}X`;
    expect(wrong.length, 'the tampered token is the same length').toBe(SECRET_TOKEN.length);
    expect(verifyGitLabDelivery(legacy(wrong), secrets(), clock())).toBe(false);
  });

  it('rejects a delivery with no token header at all', () => {
    expect(verifyGitLabDelivery({ headers: {}, body: BODY }, secrets(), clock())).toBe(false);
  });

  // Mutation: return `true` when no secret is configured, and this fails. It is the difference
  // between "nothing is configured, so reject" and an endpoint that looks like it works.
  it('rejects everything when no secret token is configured', () => {
    expect(
      verifyGitLabDelivery(legacy(), secrets({ secretToken: null, signingToken: null }), clock()),
    ).toBe(false);
    expect(
      verifyGitLabDelivery(legacy(''), secrets({ secretToken: '', signingToken: null }), clock()),
    ).toBe(false);
  });

  it('does not care that the body changed — the legacy scheme cannot tell', () => {
    // Recorded rather than asserted as a defect: the plain token "provides weaker security
    // guarantees than a signing token", which is GitLab's own wording and the reason the signed
    // scheme wins whenever it is present.
    expect(verifyGitLabDelivery(legacy(SECRET_TOKEN, `${BODY} `), secrets(), clock())).toBe(true);
  });
});

describe('verifyGitLabDelivery — Standard Webhooks', () => {
  // Mutation: sign over `body` alone instead of `{id}.{timestamp}.{body}`, and "rejects a
  // tampered body" fails.
  it('rejects a tampered body', () => {
    const delivery = signed();
    expect(
      verifyGitLabDelivery(
        { headers: delivery.headers, body: `${delivery.body} ` },
        secrets(),
        clock(),
      ),
    ).toBe(false);
  });

  it('rejects a tampered signature of exactly the right length', () => {
    const valid = signed().headers['webhook-signature'] as string;
    const tampered = `${valid.slice(0, -2)}${valid.endsWith('A=') ? 'B=' : 'A='}`;
    expect(tampered.length, 'the tampered signature is the same length').toBe(valid.length);
    expect(verifyGitLabDelivery(signed({ signature: tampered }), secrets(), clock())).toBe(false);
  });

  it('rejects a delivery with no webhook-id', () => {
    const delivery = signed();
    const { 'webhook-id': _dropped, ...headers } = delivery.headers;
    expect(verifyGitLabDelivery({ headers, body: delivery.body }, secrets(), clock())).toBe(false);
  });

  it('rejects a delivery with no webhook-timestamp', () => {
    const delivery = signed();
    const { 'webhook-timestamp': _dropped, ...headers } = delivery.headers;
    expect(verifyGitLabDelivery({ headers, body: delivery.body }, secrets(), clock())).toBe(false);
  });

  // Mutation: delete the tolerance comparison, and both replay tests fail. GitLab: "To prevent
  // replay attacks, validate that the timestamp in webhook-timestamp is recent."
  it('rejects a replayed delivery whose timestamp is older than the tolerance', () => {
    const old = String(NOW_SECONDS - 301);
    const replayed = signed({ timestamp: old });
    expect(
      verifyGitLabDelivery(replayed, secrets(), clock()),
      'a correctly signed delivery from 301 seconds ago is still a replay',
    ).toBe(false);
    // …and it is a replay only because of the age: the same delivery inside the window verifies.
    expect(
      verifyGitLabDelivery(signed({ timestamp: String(NOW_SECONDS - 299) }), secrets(), clock()),
    ).toBe(true);
  });

  it('rejects a delivery timestamped in the future beyond the tolerance', () => {
    expect(
      verifyGitLabDelivery(signed({ timestamp: String(NOW_SECONDS + 301) }), secrets(), clock()),
    ).toBe(false);
  });

  it('rejects a non-integer timestamp', () => {
    expect(verifyGitLabDelivery(signed({ timestamp: 'soon' }), secrets(), clock())).toBe(false);
    expect(verifyGitLabDelivery(signed({ timestamp: '1.5' }), secrets(), clock())).toBe(false);
  });

  /**
   * The downgrade test, and the reason `verify` branches on the header rather than trying both.
   *
   * GitLab documents the migration as "verify the signature when `webhook-signature` is present
   * and fall back to the secret token otherwise". If a signed delivery fell back to the plain
   * token, an attacker who has seen one `X-Gitlab-Token` header could forge any body on an
   * instance that has already moved to signing.
   *
   * Mutation: make `verify` try the legacy scheme when the signed one fails, and this fails.
   */
  it('never falls back to the plain token when a signature is present', () => {
    const delivery = signed({ signature: 'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' });
    const withValidPlainToken: WebhookDelivery = {
      headers: { ...delivery.headers, 'x-gitlab-token': SECRET_TOKEN },
      body: delivery.body,
    };
    expect(verifyGitLabDelivery(withValidPlainToken, secrets(), clock())).toBe(false);
  });

  it('rejects a signed delivery when no signing token is configured', () => {
    expect(verifyGitLabDelivery(signed(), secrets({ signingToken: null }), clock())).toBe(false);
  });

  it('rejects a signing token that is not whsec_<base64>', () => {
    expect(
      verifyGitLabDelivery(signed(), secrets({ signingToken: 'whsec_not base64!' }), clock()),
    ).toBe(false);
    expect(verifyGitLabDelivery(signed(), secrets({ signingToken: 'whsec_' }), clock())).toBe(
      false,
    );
  });

  // "The header might contain multiple space-separated signatures. GitLab currently sends one,
  // but this might change in the future."
  it('accepts when any entry in a multi-signature header matches', () => {
    expect(
      verifyGitLabDelivery(
        signed({ extra: ['v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='] }),
        secrets(),
        clock(),
      ),
    ).toBe(true);
  });

  it('rejects when none of several signatures matches', () => {
    const delivery = signed();
    expect(
      verifyGitLabDelivery(
        {
          headers: {
            ...delivery.headers,
            'webhook-signature': 'v1,AAAA= v1,BBBB=',
          },
          body: delivery.body,
        },
        secrets(),
        clock(),
      ),
    ).toBe(false);
  });

  it('rejects an empty signature header', () => {
    const delivery = signed();
    expect(
      verifyGitLabDelivery(
        { headers: { ...delivery.headers, 'webhook-signature': '' }, body: delivery.body },
        secrets(),
        clock(),
      ),
    ).toBe(false);
  });
});

describe('constantTimeEquals', () => {
  it('is true only for identical strings', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true);
    expect(constantTimeEquals('abc', 'abd')).toBe(false);
  });

  it('answers false for differing lengths instead of throwing', () => {
    // `timingSafeEqual` throws on differing lengths; the length check has to come first.
    expect(constantTimeEquals('abc', 'abcd')).toBe(false);
    expect(constantTimeEquals('', 'a')).toBe(false);
  });
});

describe('decodeSigningToken', () => {
  it('strips whsec_ and base64-decodes the remainder', () => {
    expect(decodeSigningToken(SIGNING_TOKEN)?.toString('utf8')).toBe(SIGNING_KEY_TEXT);
  });

  it('accepts a bare base64 key without the prefix', () => {
    expect(decodeSigningToken('ZmFrZQ==')?.toString('utf8')).toBe('fake');
  });

  it('refuses anything that is not base64', () => {
    expect(decodeSigningToken('whsec_***')).toBeNull();
    expect(decodeSigningToken('whsec_')).toBeNull();
  });
});

describe('gitLabDeliveryKey', () => {
  const key = (body: unknown): string =>
    gitLabDeliveryKey({ headers: {}, body: JSON.stringify(body) }, noSecretsRedactor());

  it('keys a merge request on its id and updated_at, so a redelivery dedups', () => {
    const body = {
      object_kind: 'merge_request',
      object_attributes: { id: 93, updated_at: '2026-06-01T07:59:00.000Z' },
    };
    expect(key(body)).toBe('gitlab:merge_request:93:2026-06-01T07:59:00.000Z');
    expect(key(body), 'the same change keys the same twice').toBe(key(body));
  });

  it('keys a different change differently', () => {
    expect(
      key({
        object_kind: 'merge_request',
        object_attributes: { id: 93, updated_at: '2026-06-01T08:05:00.000Z' },
      }),
    ).not.toBe(
      key({
        object_kind: 'merge_request',
        object_attributes: { id: 93, updated_at: '2026-06-01T07:59:00.000Z' },
      }),
    );
  });

  it('keys a pipeline on its status too, so running and success do not collapse', () => {
    const running = key({
      object_kind: 'pipeline',
      object_attributes: { id: 900, status: 'running', created_at: '2026-06-01 07:10:00 UTC' },
    });
    const finished = key({
      object_kind: 'pipeline',
      object_attributes: {
        id: 900,
        status: 'success',
        created_at: '2026-06-01 07:10:00 UTC',
        finished_at: '2026-06-01 07:12:00 UTC',
      },
    });
    expect(running).not.toBe(finished);
  });

  it('keys a push on its ref and new head', () => {
    expect(key({ object_kind: 'push', ref: 'refs/heads/main', after: 'abc1234' })).toBe(
      'gitlab:push:refs/heads/main:abc1234',
    );
  });

  it('refuses a delivery with nothing to key on', () => {
    expect(() => key({ object_kind: 'wiki_page' })).toThrow(IntegrationError);
    expect(() => key({ object_kind: 'merge_request', object_attributes: { id: 93 } })).toThrow(
      IntegrationError,
    );
    expect(() => gitLabDeliveryKey({ headers: {}, body: 'not json' }, noSecretsRedactor())).toThrow(
      IntegrationError,
    );
  });

  it('reports invalid_request, which is the code the port names', () => {
    try {
      key({ object_kind: 'wiki_page' });
      expect.unreachable('an unkeyable delivery must throw');
    } catch (error) {
      expect((error as IntegrationError).code).toBe('invalid_request');
    }
  });

  /**
   * The key and the refusal are both provider text, and the refusal **cuts** — 32 characters of
   * `object_kind`, which is where a fragment of a credential would survive a redactor that ran
   * afterwards. A delivery is not a response, so nothing else on this path redacts anything.
   */
  describe('is redacted, because a delivery is provider text nothing else redacts', () => {
    const PLANTED = 'FAKE-planted-binding-credential-0123456789';
    const PLACEHOLDER = '[REDACTED:integration:planted]';
    const planted = exactSecretRedactor([{ name: 'planted', value: PLANTED }]);

    it('redacts the key it returns, which the platform stores and compares', () => {
      expect(
        gitLabDeliveryKey(
          {
            headers: {},
            body: JSON.stringify({
              object_kind: 'merge_request',
              object_attributes: { id: 93, updated_at: `2026-06-01T07:59:00.000Z-${PLANTED}` },
            }),
          },
          planted,
        ),
      ).toBe(`gitlab:merge_request:93:2026-06-01T07:59:00.000Z-${PLACEHOLDER}`);
    });

    it('redacts before the 32-character cut, so the refusal carries no fragment', () => {
      let caught: unknown;
      try {
        gitLabDeliveryKey(
          { headers: {}, body: JSON.stringify({ object_kind: `wiki_${PLANTED}` }) },
          planted,
        );
      } catch (error) {
        caught = error;
      }
      expect((caught as Error).message).not.toContain(PLANTED.slice(0, 12));
      expect((caught as Error).message).toContain(PLACEHOLDER.slice(0, 12));
    });
  });
});

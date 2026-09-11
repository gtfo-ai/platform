/**
 * Slack request signing, verified in-house (TD-024: "Webhook signatures verified in-house with
 * `timingSafeEqual`").
 *
 * Transcribed from <https://docs.slack.dev/authentication/verifying-requests-from-slack>
 * (retrieved 2026-09-10). The quotes matter, so they are here rather than paraphrased:
 *
 * > Concatenate the version, the timestamp, and the body … `'v0:' + timestamp + ':' + request_body`
 *
 * > With the help of HMAC SHA256 … hash the above basestring, using the Slack signing secret as
 * > the key.
 *
 * > `X-Slack-Signature` … `X-Slack-Request-Timestamp` … header names are meant to be
 * > case-insensitive, so the letter case should not be assumed.
 *
 * > `if absolute_value(time.time() - timestamp) > 60 * 5: # The request timestamp is more than
 * > five minutes from local time. # It could be a replay attack, so let's ignore it.`
 *
 * > For best practice, use an hmac `compare` function instead of directly comparing the signatures
 * > for equality.
 *
 * ## Why this exists at all when the binding runs in Socket Mode
 *
 * Because the HTTP path exists whether or not an operator uses it. A Slack app has an
 * interactivity request URL and an events request URL that can be enabled at any time from the
 * app configuration screen, and the platform exposes `/webhooks/slack/<integrationId>` for every
 * provider (technical/06 § "Inbound: webhooks and polling"). A binding whose verification is
 * "we are on a socket, so it must be us" is one configuration change away from accepting anything
 * posted to that URL. Socket Mode envelopes take the *same* door: `socket.ts` wraps each one into
 * a delivery signed with this binding's own secret, so there is exactly one place that decides
 * whether an inbound payload may be acted on.
 *
 * ## Three refusals that are guards rather than validation
 *
 *  1. **An absent, empty or whitespace signing secret refuses every delivery** (standing rule 18).
 *     WP-08 shipped a verifier that accepted `HMAC-SHA256('', body)` — a signature any attacker
 *     can compute — because an unset secret became an empty string. Here an unusable secret is
 *     `false` for everything, including a delivery signed with that same empty key.
 *  2. **A wrong version prefix refuses** — and the explicit check for it is *deliberately
 *     unreachable defence in depth*, which is worth stating rather than implying (standing rule
 *     22). The comparison below is over the **whole** string, and the expected string always
 *     begins `v0=`, so a `v1=` signature with a matching digest is already refused by it; deleting
 *     the prefix check changes no test, and WP-10's mutation run proves exactly that. It stays
 *     because the version is a protocol fact rather than a coincidence of string concatenation:
 *     if the comparison were ever narrowed to the digest, this line is what would keep the
 *     refusal. What it must not do is *read* as the thing that makes the refusal true today.
 *  3. **The clock is injected.** Replay detection needs "now", and a wall-clock assertion is a
 *     hardware assertion, not a correctness one (standing rule 2).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { IntegrationError, type SecretRedactor, type WebhookDelivery } from '@platform/application';
import type { Clock } from '@platform/domain';
import { SLACK_PROVIDER_ID } from './http.js';

export const SLACK_SIGNATURE_HEADER = 'x-slack-signature';
export const SLACK_TIMESTAMP_HEADER = 'x-slack-request-timestamp';
export const SLACK_RETRY_NUM_HEADER = 'x-slack-retry-num';
/** The only signature version this module implements. */
export const SLACK_SIGNATURE_VERSION = 'v0';

export interface SlackSignatureSecrets {
  /** The app's signing secret, or `null` when the operator configured none. */
  readonly signingSecret: string | null;
  readonly toleranceSeconds: number;
}

/**
 * Constant-time equality for two ASCII strings.
 *
 * `timingSafeEqual` throws on differing lengths, so the length is compared first. That is not a
 * leak: the length of a hex HMAC-SHA256 is a constant of the algorithm.
 */
export const constantTimeEquals = (left: string, right: string): boolean => {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * A signing secret this binding can actually verify with, or `null`.
 *
 * Whitespace counts as absent: `SLACK_SIGNING_SECRET=" "` in a `.env` is a missing configuration
 * value, not a key, and treating it as one produces a verifier that accepts whatever an attacker
 * signs with a space.
 */
export const usableSigningSecret = (value: string | null | undefined): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : value;
};

/** `v0=<hex HMAC-SHA256 over "v0:{timestamp}:{body}">`. */
export const signSlackRequest = (secret: string, timestamp: string, body: string): string =>
  `${SLACK_SIGNATURE_VERSION}=${createHmac('sha256', secret)
    .update(`${SLACK_SIGNATURE_VERSION}:${timestamp}:${body}`, 'utf8')
    .digest('hex')}`;

/** A bad signature is `false`, never an exception (the port's wording). */
export const verifySlackDelivery = (
  delivery: WebhookDelivery,
  secrets: SlackSignatureSecrets,
  clock: Clock,
): boolean => {
  const secret = usableSigningSecret(secrets.signingSecret);
  if (secret === null) {
    // Standing rule 18: an endpoint that answers "authentic" because nothing was configured is
    // worse than one that rejects everything, because it looks like it is working.
    return false;
  }
  const provided = delivery.headers[SLACK_SIGNATURE_HEADER];
  const timestamp = delivery.headers[SLACK_TIMESTAMP_HEADER];
  if (provided === undefined || provided === '' || timestamp === undefined) {
    return false;
  }
  // Deliberately unreachable: the comparison at the end of this function is over the whole
  // string, and `signSlackRequest` always produces a `v0=` prefix, so nothing without one can
  // match it. Kept as defence in depth against a future narrowing of that comparison, and
  // labelled so it is not mistaken for the guard that is doing the work (standing rule 22).
  if (!provided.startsWith(`${SLACK_SIGNATURE_VERSION}=`)) {
    return false;
  }
  const sentAt = Number(timestamp);
  if (!Number.isInteger(sentAt)) {
    return false;
  }
  const nowSeconds = Math.floor(Date.parse(clock.now()) / 1000);
  if (Math.abs(nowSeconds - sentAt) > secrets.toleranceSeconds) {
    return false;
  }
  return constantTimeEquals(signSlackRequest(secret, timestamp, delivery.body), provided);
};

/** Builds the headers Slack would send for a body. Used by Socket Mode and by the fixtures. */
export const slackSignatureHeaders = (input: {
  readonly secret: string;
  readonly timestampSeconds: number;
  readonly body: string;
}): Record<string, string> => ({
  'content-type': 'application/json',
  [SLACK_TIMESTAMP_HEADER]: String(input.timestampSeconds),
  [SLACK_SIGNATURE_HEADER]: signSlackRequest(
    input.secret,
    String(input.timestampSeconds),
    input.body,
  ),
});

/**
 * The dedup key of a delivery.
 *
 * technical/06 wants a key that identifies the **change**, not the delivery, because webhooks and
 * any second path must dedup against each other. Slack gives two different answers:
 *
 *  - an Events API delivery carries `event_id` (`Ev123ABC456`), which is stable across Slack's own
 *    retries of the same event and different for a different one — exactly the property Jira's
 *    `X-Atlassian-Webhook-Identifier` has;
 *  - an interactivity payload has no event id at all. `action_ts` is the instant the human
 *    clicked, so `<team>:<user>:<action_id>:<action_ts>` identifies the click. A redelivery of the
 *    same click repeats it; a second click is a different instant, and a second click *is* a
 *    second decision the platform may want to see.
 *
 * A Socket Mode `envelope_id` is deliberately not used: it identifies the delivery, so two
 * envelopes of one event would key differently and both would be processed.
 *
 * ## Both things it produces are provider text, and one of them is *stored*
 *
 * Every part of the key above is copied out of the delivery body — `event_id`, `team.id`,
 * `user.id`, `action_id`, `action_ts` — and the body is untrusted provider text (BD-022) that the
 * platform stores as `inbox.delivery_id` (technical/03; half of that table's primary key) and
 * compares on every later delivery. A secret reaching
 * persistent state is worse than one reaching a log line, and the object literal this function is
 * wired into (`provider.ts`) hands `normalise` a redactor for exactly that reason while this
 * function had none: `{"type":"event_callback","event_id":"Ev-<the binding's signing secret>"}`
 * produced `slack:event:Ev-<the secret>`, executed rather than argued.
 *
 * That was the **third** instance of one defect — Jira's `X-Atlassian-Webhook-Identifier` and
 * GitLab's `object_kind` were the first two, closed one commit earlier — which is standing rule 49
 * (when you fix something, grep for its siblings) and why `delivery-key-redaction.test.ts` now
 * derives the set of providers that owe this from the registrations rather than from memory.
 *
 * The redactor is **required rather than optional** for the reason standing rule 31 names: an
 * optional security dependency is an absent one. And it runs **before** the refusal's 32-character
 * cut, because a cut applied to unredacted text leaves a fragment no exact-match redactor can ever
 * find again — a delivery whose `type` is `<the signing secret>` is the case that proves it.
 *
 * @throws {IntegrationError} `invalid_request` when the delivery carries nothing to key on.
 */
export const slackDeliveryKey = (delivery: WebhookDelivery, redactor: SecretRedactor): string => {
  let body: unknown;
  try {
    body = JSON.parse(delivery.body) as unknown;
  } catch {
    throw new IntegrationError(
      'invalid_request',
      SLACK_PROVIDER_ID,
      'delivery body is not JSON, so it has no dedup key',
      { action: 'delivery_key' },
    );
  }
  const record = (body ?? {}) as Record<string, unknown>;
  const text = (value: unknown): string | null =>
    typeof value === 'string' && value !== '' ? value : null;

  const key = (() => {
    if (record.type === 'event_callback') {
      const eventId = text(record.event_id);
      return eventId === null ? null : `event:${eventId}`;
    }
    if (record.type === 'block_actions') {
      const user = (record.user ?? {}) as Record<string, unknown>;
      const team = (record.team ?? {}) as Record<string, unknown>;
      const actions = Array.isArray(record.actions) ? record.actions : [];
      const first = (actions[0] ?? {}) as Record<string, unknown>;
      const at = text(first.action_ts);
      const who = text(user.id);
      if (at === null || who === null) {
        return null;
      }
      return `action:${text(team.id) ?? 'unknown'}:${who}:${text(first.action_id) ?? 'unknown'}:${at}`;
    }
    return null;
  })();

  if (key === null) {
    // Redact, *then* cut: the other order leaves the leading bytes of a credential in the message.
    const named = JSON.stringify(redactor.redactText(String(record.type)).value.slice(0, 32));
    throw new IntegrationError(
      'invalid_request',
      SLACK_PROVIDER_ID,
      `delivery of type ${named} carries nothing to key on`,
      { action: 'delivery_key' },
    );
  }
  return redactor.redactText(`${SLACK_PROVIDER_ID}:${key}`).value;
};

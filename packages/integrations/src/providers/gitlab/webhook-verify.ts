/**
 * Webhook authenticity: GitLab's two schemes, both verified in-house (TD-024).
 *
 * Transcribed from <https://docs.gitlab.com/user/project/integrations/webhooks/> (retrieved
 * 2026-09-10). The quotes matter, so they are here rather than paraphrased:
 *
 * **Legacy secret token.**
 * > This token is sent as plain text in the `X-Gitlab-Token` HTTP header and provides weaker
 * > security guarantees than a signing token.
 *
 * **Standard Webhooks** (`webhook-id` / `webhook-timestamp` introduced in GitLab 19.0; the
 * `webhook-signature` header in 19.0 behind `webhook_signing_token`, generally available in 19.1):
 * > Each signature has the format `v1,{base64_signature}`. The header might contain multiple
 * > space-separated signatures. … The signature is computed over the string
 * > `{message_id}.{timestamp}.{body}` … Decode the signing token: strip the `whsec_` prefix, then
 * > base64-decode the remainder. … Check whether the computed signature matches any entry in the
 * > signature list. **Use a constant-time comparison to prevent timing attacks.** … To prevent
 * > replay attacks, validate that the timestamp in `webhook-timestamp` is recent before processing
 * > the payload.
 *
 * **Which scheme wins** is not a choice this adapter gets to make; GitLab documents the migration:
 * > Update your receiver to verify the signature when `webhook-signature` is present and fall back
 * > to the secret token otherwise.
 *
 * That is the version story in one line: an instance older than 19.0 sends only `X-Gitlab-Token`,
 * a 19.x instance may send both while an operator migrates, and a signed delivery is never
 * accepted on the strength of the weaker header.
 *
 * Two things this module refuses to do:
 *  - **accept an unconfigured delivery.** With neither token configured, `verify` is `false`. An
 *    endpoint that answers "authentic" because nothing was configured is worse than one that
 *    rejects everything, because it looks like it is working.
 *  - **read the wall clock.** Replay detection needs "now", and a hardware assertion is not a
 *    correctness one (standing rule 2), so the clock is injected.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { IntegrationError, type WebhookDelivery } from '@platform/application';
import type { Clock } from '@platform/domain';
import { GITLAB_PROVIDER_ID } from './http.js';

export const GITLAB_TOKEN_HEADER = 'x-gitlab-token';
export const GITLAB_EVENT_HEADER = 'x-gitlab-event';
export const WEBHOOK_ID_HEADER = 'webhook-id';
export const WEBHOOK_TIMESTAMP_HEADER = 'webhook-timestamp';
export const WEBHOOK_SIGNATURE_HEADER = 'webhook-signature';

export interface WebhookSecrets {
  /** `X-Gitlab-Token` value, or `null` when the operator configured none. */
  readonly secretToken: string | null;
  /** `whsec_<base64>` signing token, or `null`. */
  readonly signingToken: string | null;
  readonly toleranceSeconds: number;
}

/**
 * Constant-time equality for two ASCII strings.
 *
 * `timingSafeEqual` throws on differing lengths, so the length is compared first. That is not a
 * leak: the length of a base64 HMAC-SHA256 is a constant of the algorithm, and the length of a
 * configured token is not a secret an attacker can act on the way its bytes are.
 */
export const constantTimeEquals = (left: string, right: string): boolean => {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
};

/** `whsec_<base64>` → raw key bytes, or `null` when the token is not in that form. */
export const decodeSigningToken = (token: string): Buffer | null => {
  const encoded = token.startsWith('whsec_') ? token.slice('whsec_'.length) : token;
  if (encoded === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    return null;
  }
  const key = Buffer.from(encoded, 'base64');
  return key.length === 0 ? null : key;
};

/** `v1,<base64 HMAC-SHA256 over "{id}.{timestamp}.{body}">`. */
export const standardWebhookSignature = (
  key: Buffer,
  messageId: string,
  timestamp: string,
  body: string,
): string =>
  `v1,${createHmac('sha256', key).update(`${messageId}.${timestamp}.${body}`, 'utf8').digest('base64')}`;

const verifyStandardWebhook = (
  delivery: WebhookDelivery,
  secrets: WebhookSecrets,
  clock: Clock,
): boolean => {
  if (secrets.signingToken === null) {
    // A signed delivery arrived and nothing can check it. Falling back to the plain token here
    // would let an attacker downgrade the scheme by replaying a captured `X-Gitlab-Token`.
    return false;
  }
  const key = decodeSigningToken(secrets.signingToken);
  if (key === null) {
    return false;
  }
  const messageId = delivery.headers[WEBHOOK_ID_HEADER];
  const timestamp = delivery.headers[WEBHOOK_TIMESTAMP_HEADER];
  const provided = delivery.headers[WEBHOOK_SIGNATURE_HEADER];
  if (
    messageId === undefined ||
    messageId === '' ||
    timestamp === undefined ||
    provided === undefined
  ) {
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

  const expected = standardWebhookSignature(key, messageId, timestamp, delivery.body);
  let matched = false;
  for (const candidate of provided.split(' ')) {
    if (candidate === '') {
      continue;
    }
    // No early exit: every candidate is compared so the work does not depend on where the match is.
    matched = constantTimeEquals(expected, candidate) || matched;
  }
  return matched;
};

const verifySecretToken = (delivery: WebhookDelivery, secrets: WebhookSecrets): boolean => {
  if (secrets.secretToken === null || secrets.secretToken === '') {
    return false;
  }
  const provided = delivery.headers[GITLAB_TOKEN_HEADER];
  if (provided === undefined) {
    return false;
  }
  return constantTimeEquals(secrets.secretToken, provided);
};

/** A bad signature is `false`, never an exception (the port's wording). */
export const verifyGitLabDelivery = (
  delivery: WebhookDelivery,
  secrets: WebhookSecrets,
  clock: Clock,
): boolean =>
  delivery.headers[WEBHOOK_SIGNATURE_HEADER] === undefined
    ? verifySecretToken(delivery, secrets)
    : verifyStandardWebhook(delivery, secrets, clock);

/**
 * The dedup key of a delivery.
 *
 * technical/06 fixes the shape — "GitLab event + object id + `updated_at`" — and the reason is in
 * the same paragraph: webhooks and the polling fallback must dedup *against each other*, and a
 * per-delivery id (`webhook-id`, `X-Gitlab-Event-UUID`, `Idempotency-Key`) cannot do that. It
 * identifies the delivery; this identifies the *change*.
 *
 * The "revision" half is per event kind, because the payloads do not share a field:
 *  - `merge_request` and `note` carry `object_attributes.updated_at`;
 *  - `pipeline` carries a status and a `finished_at`/`created_at` — a pipeline hook fires on every
 *    status change, so the status has to be part of the key or "running" and "success" collapse;
 *  - `push` has no object id at all, so the new head and the ref are the change.
 *
 * @throws {IntegrationError} `invalid_request` when the delivery carries nothing to key on.
 */
export const gitLabDeliveryKey = (delivery: WebhookDelivery): string => {
  let body: unknown;
  try {
    body = JSON.parse(delivery.body) as unknown;
  } catch {
    throw new IntegrationError(
      'invalid_request',
      GITLAB_PROVIDER_ID,
      'delivery body is not JSON, so it has no dedup key',
      { action: 'delivery_key' },
    );
  }
  const record = (body ?? {}) as Record<string, unknown>;
  const kind = typeof record.object_kind === 'string' ? record.object_kind : null;
  const attributes = (record.object_attributes ?? {}) as Record<string, unknown>;

  const part = (value: unknown): string | null =>
    typeof value === 'string' && value !== ''
      ? value
      : typeof value === 'number'
        ? String(value)
        : null;

  const key = (() => {
    switch (kind) {
      case 'merge_request':
      case 'note': {
        const id = part(attributes.id);
        const revision = part(attributes.updated_at);
        return id === null || revision === null ? null : `${kind}:${id}:${revision}`;
      }
      case 'pipeline': {
        const id = part(attributes.id);
        const status = part(attributes.status);
        const revision = part(attributes.finished_at) ?? part(attributes.created_at);
        return id === null || status === null
          ? null
          : `pipeline:${id}:${status}:${revision ?? 'unfinished'}`;
      }
      case 'push': {
        const after = part(record.after);
        const ref = part(record.ref);
        return after === null || ref === null ? null : `push:${ref}:${after}`;
      }
      default:
        return null;
    }
  })();

  if (key === null) {
    throw new IntegrationError(
      'invalid_request',
      GITLAB_PROVIDER_ID,
      `delivery of kind ${JSON.stringify(String(kind).slice(0, 32))} carries nothing to key on`,
      { action: 'delivery_key' },
    );
  }
  return `${GITLAB_PROVIDER_ID}:${key}`;
};

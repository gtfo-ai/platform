/**
 * The machinery the five provider fakes share: a signed webhook envelope, scripted failures, a
 * call log and a deterministic clock.
 *
 * technical/10 makes fakes first-class code, and these five are load-bearing beyond WP-07: WP-12's
 * runner tests, WP-15's pipeline e2e and every provider work package's unit tier run against them.
 * That is exactly why the shared rule is **a fake may be stricter than the real adapter, never
 * kinder** — a fake that admits what Jira rejects, or succeeds where GitLab rate-limits, launders
 * a bug into a pass. Each fake carries its own divergence register beside its definition.
 *
 * ## The fake webhook envelope
 *
 * A fake provider is still a provider: it has a signature scheme, a delivery id and an event name,
 * because those are what the inbound half of every type port is *about*. The envelope here is
 * modelled on the real ones in TD-024 (a shared secret, an HMAC over the raw body, a per-delivery
 * id header) so that a contract suite written against it exercises the same three questions —
 * "is it authentic", "have I seen it", "what does it mean" — that a real webhook does.
 *
 * The secret is an obviously fake constant. It is *not* a credential: it exists so that a test can
 * tamper with a body and see `verify` reject it.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { IntegrationError, type IntegrationRef, type WebhookDelivery } from '@platform/application';
import { type Clock, fixedClock, type IdSource, sequentialIds } from '@platform/domain';

/** Obviously fake, and the only secret any fake accepts. Never a real credential. */
export const FAKE_WEBHOOK_SECRET = 'fake-webhook-secret-do-not-use-in-production';

export const FAKE_DELIVERY_HEADER = 'x-fake-delivery';
export const FAKE_EVENT_HEADER = 'x-fake-event';
export const FAKE_SIGNATURE_HEADER = 'x-fake-signature';

export const signFakeBody = (secret: string, body: string): string =>
  createHmac('sha256', secret).update(body, 'utf8').digest('hex');

/** Builds a signed delivery, exactly as a provider would send it. */
export const buildFakeDelivery = (input: {
  readonly secret: string;
  readonly event: string;
  readonly deliveryId: string;
  readonly payload: unknown;
}): WebhookDelivery => {
  const body = JSON.stringify(input.payload);
  return {
    headers: {
      'content-type': 'application/json',
      [FAKE_DELIVERY_HEADER]: input.deliveryId,
      [FAKE_EVENT_HEADER]: input.event,
      [FAKE_SIGNATURE_HEADER]: signFakeBody(input.secret, body),
    },
    body,
  };
};

/**
 * Constant-time verification, like the real ones (TD-024).
 *
 * `timingSafeEqual` throws on differing lengths, so the length check comes first — and it is not a
 * timing leak, because the length of a hex HMAC is public.
 *
 * **An empty secret is not a secret** (standing rule 18, added at WP-10). Without the first guard
 * a fake built with `webhookSecret: ''` verifies `HMAC-SHA256('', body)` — the signature any
 * attacker can compute — which is precisely the WP-08 defect the rule is named for, reproduced in
 * the instrument every later work package trusts. The shared communication contract suite drives
 * it: "refuses every delivery when the binding has no verification credential".
 */
export const verifyFakeDelivery = (secret: string, delivery: WebhookDelivery): boolean => {
  if (secret.trim() === '') {
    return false;
  }
  const provided = delivery.headers[FAKE_SIGNATURE_HEADER];
  if (provided === undefined) {
    return false;
  }
  const expected = signFakeBody(secret, delivery.body);
  if (provided.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8'));
};

/** The dedup key of a delivery: its id header, as Jira's `X-Atlassian-Webhook-Identifier` is. */
export const fakeDeliveryKey = (provider: string, delivery: WebhookDelivery): string => {
  const id = delivery.headers[FAKE_DELIVERY_HEADER];
  if (id === undefined || id.length === 0) {
    throw new IntegrationError('invalid_request', provider, 'delivery carries no id header', {
      action: 'delivery_key',
    });
  }
  return `${provider}:${id}`;
};

// ── Scripted failures ────────────────────────────────────────────────────────

/**
 * Lets a test make the next call of one action fail.
 *
 * This is the *kinder* direction — a real provider fails when it fails — and it is deliberate:
 * without it, no unit-tier test could reach the executor's 429, backoff or audit-failure branches
 * at all, and an unreachable branch is an untested one. Scripting is opt-in and empty by default.
 */
export interface FailureScript {
  /** The next call to `action` throws `error`. Queued: two calls script two failures. */
  failNext(action: string, error: Error): void;
  /** The next `times` calls to `action` throw `error`. */
  failNextTimes(action: string, error: Error, times: number): void;
  /** Consumed by the fake at the start of each method. */
  take(action: string): Error | null;
  /** Failures scripted but never consumed — a test that armed the wrong action sees them here. */
  unconsumed(): readonly string[];
  reset(): void;
}

export const createFailureScript = (): FailureScript => {
  const queued = new Map<string, Error[]>();
  return {
    failNext: (action, error) => {
      const list = queued.get(action) ?? [];
      list.push(error);
      queued.set(action, list);
    },
    failNextTimes: (action, error, times) => {
      if (!Number.isInteger(times) || times < 1) {
        throw new TypeError(`failNextTimes expects a positive integer, got ${times}`);
      }
      const list = queued.get(action) ?? [];
      for (let index = 0; index < times; index += 1) {
        list.push(error);
      }
      queued.set(action, list);
    },
    take: (action) => {
      const list = queued.get(action);
      if (list === undefined || list.length === 0) {
        return null;
      }
      return list.shift() ?? null;
    },
    unconsumed: () =>
      [...queued.entries()].flatMap(([action, list]) => list.map(() => action)).sort(),
    reset: () => queued.clear(),
  };
};

// ── Call log ─────────────────────────────────────────────────────────────────

export interface FakeCall {
  readonly action: string;
  readonly at: string;
}

/**
 * Everything a fake shares: identity, a clock, ids, scripted failures and the call log.
 *
 * The clock is `fixedClock` stepping one second per read, so two entities created in a row have
 * different, *predictable* timestamps. No fake ever reads the wall clock.
 */
export interface FakeCore {
  readonly ref: IntegrationRef;
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly script: FailureScript;
  readonly calls: readonly FakeCall[];
  readonly webhookSecret: string;
  /** Records the call and throws whatever the test scripted for it. */
  enter(action: string): void;
  resetCalls(): void;
}

export interface FakeCoreOptions {
  readonly ref: IntegrationRef;
  readonly clockStart?: string;
  readonly clockStepMs?: number;
  readonly idStart?: number;
  readonly webhookSecret?: string;
}

/** A Monday morning, so a fake timestamp lands on a working day (WP-05's calendar). */
export const FAKE_EPOCH = '2026-06-01T08:00:00.000Z';

export const createFakeCore = (options: FakeCoreOptions): FakeCore => {
  const calls: FakeCall[] = [];
  const script = createFailureScript();
  const clock = fixedClock(
    (options.clockStart ?? FAKE_EPOCH) as `${string}T${string}`,
    options.clockStepMs ?? 1000,
  );
  const ids = sequentialIds(options.idStart ?? 0x2000);

  return {
    ref: options.ref,
    clock,
    ids,
    script,
    calls,
    webhookSecret: options.webhookSecret ?? FAKE_WEBHOOK_SECRET,
    enter: (action) => {
      calls.push({ action, at: clock.now() });
      const failure = script.take(action);
      if (failure !== null) {
        throw failure;
      }
    },
    resetCalls: () => {
      calls.length = 0;
    },
  };
};

/** Deep clone through JSON, so a caller can never mutate a fake's state by keeping a reference. */
export const snapshot = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export const notFound = (provider: string, action: string, what: string): IntegrationError =>
  new IntegrationError('not_found', provider, `${what} does not exist`, { action });

export const invalidRequest = (
  provider: string,
  action: string,
  detail: string,
): IntegrationError => new IntegrationError('invalid_request', provider, detail, { action });

/**
 * The provider refuses because of state it already holds — GitLab's 409 for a second open merge
 * request on one source branch, Jira's 409 for a concurrent edit.
 *
 * Separate from {@link invalidRequest} because the caller acts differently: `invalid_request` means
 * "you asked wrongly, fix the call"; `conflict` means "the world already contains what you asked
 * for, go and read it". A fake that answered `invalid_request` here would teach the shared contract
 * suite the wrong code and make the real adapter mis-map its 409 to match (found at WP-07 review).
 */
export const conflict = (provider: string, action: string, detail: string): IntegrationError =>
  new IntegrationError('conflict', provider, detail, { action });

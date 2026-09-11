/**
 * **Every provider's dedup key, built through its real registration with the caller disarmed, with
 * the binding's own credential planted in the delivery** — standing rules 30, 31, 35 and 49
 * (technical/10 unit tier).
 *
 * ## Why this file exists
 *
 * `InboundNormaliser.deliveryKey` is a string the platform *stores*: technical/06 § "Inbound:
 * webhooks and polling" has the per-provider HTTP endpoint compute it and dedup on it, and
 * technical/03 gives it the column — `inbox(provider, delivery_id, …)`, whose primary key it is
 * half of. (The endpoint itself is a later WP: nothing writes `inbox` today, which is why this
 * file exercises the key through the registrations rather than through a route.) Every byte of it
 * comes out of an untrusted delivery (BD-022) — a header value on Jira, `object_attributes` on
 * GitLab, `event_id` or the five parts of a click on Slack — so a credential that appears in one
 * reaches persistent state, which is strictly worse than one reaching a log line.
 *
 * It is **not** the only such string, and this docblock used to say it was. The executor stores an
 * idempotency record whose key and value are provider text too, and it stored them unredacted for
 * as long as this sentence claimed otherwise — the fourth instance of the class, closed in
 * `packages/application/src/integrations/action-executor.ts`. Standing rule 63: an exclusivity
 * claim is a statement about every *other* file, so it cannot be maintained from inside one. The
 * scope of this file is exactly what its own `PROVIDER_DIRECTORIES` reads off the disk: the dedup
 * key of every adapter under `providers/`.
 *
 * It was closed there **differently**, and the difference is decided rather than accidental: the
 * executor's idempotency key is now *refused* when redaction would change it, while the dedup key
 * this file checks is *redacted*. Rule 20 — a refused mutation costs one action, a refused
 * delivery drops a notification. `InboundNormaliser.deliveryKey` and `idempotencyScopeFor` carry
 * the trade; what this file asserts is only that the redaction happened.
 *
 * The same defect was found and closed **three times across two commits**:
 *
 *  - `jiraDeliveryKey` copied `x-atlassian-webhook-identifier` into the key with no redactor;
 *  - `gitLabDeliveryKey` did the same with `object_kind` and its 32-character refusal;
 *  - `slackDeliveryKey` took no redactor **at all** while the same object literal's `normalise`
 *    did — found by a reviewer running the grep the first fix should have carried (rule 49).
 *
 * Three instances of one defect is not three defects; it is a class with no check. Rule 30: when a
 * defect is mechanically detectable, add the check rather than the note.
 *
 * ## The instrument, and why each part is load-bearing
 *
 *  1. **The scope is read off the disk, not remembered.** `PROVIDER_DIRECTORIES` is every directory
 *     under `providers/`, the same derivation `fixture-provenance.contract.test.ts` uses over
 *     `test/fixtures/http/`, so a fourth provider fails this file the moment its directory exists.
 *     A hand-written list is what let Slack sit outside `emitted-secrets.test.ts` — that file walks
 *     Jira and GitLab and says so, and Slack's delivery key is exactly what it could not see
 *     (rule 7).
 *  2. **Through the real registration's `create`.** That is the only production path, and standing
 *     rule 35 is that making a dependency *required* proves it is supplied where the object is
 *     built, never that it is used where the value is read: Slack's `create` compiled clean through
 *     the whole of WP-11 while this key redacted nothing.
 *  3. **The caller's redactor is `noSecretsRedactor()`** — disarmed on purpose, so anything redacted
 *     below can only have been redacted by the adapter's own `bindingSecretRedactor`. With a working
 *     caller redactor in place every assertion here would pass whichever layer fired, and neither
 *     would be proved (rule 9).
 *  4. **The planted value is the binding's own webhook credential**, in the obviously-fake
 *     `FAKE-PLANTED-*` shape the repository requires (BD-002) and long enough to clear
 *     `MIN_SECRET_LENGTH`, which `bindingSecretRedactor` silently skips below.
 *  5. **Both directions of "does this provider owe a key?" are asserted.** A port with an `inbound`
 *     half must come with a planted delivery, and a port without one must not — so a provider cannot
 *     be excused by leaving its case half-written, and an observability provider that grows a webhook
 *     turns this file red rather than silently joining the untested set.
 *
 * ## What it does not cover, stated rather than implied
 *
 *  - **The refusal path.** Two of the three delivery-key functions quote provider text into an
 *    `IntegrationError` and **cut** it to 32 characters, where redaction must precede the cut or a
 *    fragment survives that no exact-match redactor can find again. That case is per-provider and
 *    lives in each provider's own test (`gitlab/webhook-verify.test.ts`, `slack/signature.test.ts`);
 *    Jira's refusal quotes only a constant header name and needs none.
 *  - **Everything else a provider emits.** That is `emitted-secrets.test.ts`, whose own scope is
 *    Jira and GitLab only (Discovered work in `PROGRESS.md`).
 *  - **A secret the platform never told the adapter about.** `SecretRedactor` is TD-012 step 1,
 *    exact match over injected values.
 *  - **The fakes.** `fakeDeliveryKey` takes no redactor because the fakes take no `redactor` at all;
 *    that is a rule-1 question about the instrument, not about this class, and it is filed as
 *    Discovered work rather than answered here.
 */
import { readdirSync } from 'node:fs';
import {
  createIntegrationActionExecutor,
  createMemoryAuditLog,
  createVirtualTimer,
  noSecretsRedactor,
  type WebhookDelivery,
} from '@platform/application';
import { fixedClock } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { gitlabProviderRegistration } from './gitlab/index.js';
import { createJiraCloudRegistration } from './jira-cloud/registration.js';
import { lokiProviderRegistration } from './loki/index.js';
import { sentryProviderRegistration } from './sentry/index.js';
import { slackProviderRegistration } from './slack/index.js';

const NOW = '2026-06-01T10:30:00.000Z' as const;
const clock = fixedClock(NOW);
const INTEGRATION_ID = '00000000-0000-4000-8000-0000000000b1';

/** The marker `redactText` writes. A key carrying it was redacted by *something*. */
const MARKER = '[REDACTED:integration:';

/**
 * The provider directories, asked of the filesystem rather than listed here — a guard with a
 * hand-maintained scope drifts (rule 7).
 */
const PROVIDER_DIRECTORIES: readonly string[] = readdirSync(new URL('.', import.meta.url), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

interface DeliveryKeyCase {
  /** The binding credential planted in the delivery below, and nowhere else. */
  readonly planted: string;
  /**
   * The port, built through the registration with the caller's redactor disarmed.
   *
   * Typed `object` on purpose. The five registrations return five *different* port types, and
   * `InboundNormaliser<TType>` is invariant in its event union, so a common supertype naming
   * `inbound` does not typecheck. More to the point, a type-level union would let TypeScript decide
   * which providers have an inbound half — and the question this file asks is what the built
   * **object** has, which is the thing a new provider can get wrong.
   */
  readonly port: () => object;
  /**
   * A delivery this provider can key, whose keyed fields are made of planted text — or `null` for a
   * provider whose port has no inbound half at all. Asserted against the built port either way.
   */
  readonly delivery: WebhookDelivery | null;
}

const GITLAB_TOKEN = 'glpat-FAKE-PLANTED-binding-token-0123456789';
const GITLAB_WEBHOOK_SECRET = 'FAKE-PLANTED-gitlab-webhook-secret-token-01';
const JIRA_TOKEN = 'FAKE-PLANTED-jira-api-token-0123456789';
const JIRA_WEBHOOK_SECRET = 'FAKE-PLANTED-jira-webhook-secret-0123456789';
const LOKI_TOKEN = 'FAKE-PLANTED-loki-bearer-token-0123456789';
const SENTRY_TOKEN = 'FAKE-PLANTED-sentry-auth-token-0123456789';
const SLACK_SIGNING_SECRET = 'FAKE-PLANTED-slack-signing-secret-0123456789';

const jiraRegistration = createJiraCloudRegistration({
  executor: createIntegrationActionExecutor({
    auditLog: createMemoryAuditLog(),
    // Disarmed too: nothing below may be discharged by the ring outside the adapter — and the
    // executor does not cover this value anyway, since `deliveryKey` is not an action.
    redactor: noSecretsRedactor(),
    timer: createVirtualTimer({ autoAdvance: true }),
    clock,
    rateLimits: () => ({ capacity: 100, refillPerSecond: 100, maxConcurrent: 8 }),
  }),
  clock,
  actionContext: () => ({ mode: 'normal', projectId: null, taskId: null }),
});

/**
 * The one member this file calls, spelled without the generic that makes the whole normaliser
 * invariant — `deliveryKey` is `(delivery) => string` on every provider.
 */
interface DeliveryKeyed {
  deliveryKey(delivery: WebhookDelivery): string;
}

/** Asked of the built object rather than of its type, which is the whole point (rule 7). */
const inboundOf = (port: object): DeliveryKeyed | null =>
  'inbound' in port ? (port as { inbound: DeliveryKeyed }).inbound : null;

/**
 * One case per provider directory. **The keys of this record are checked against the disk**, so it
 * is not a list of providers — it is a list of recipes, and a missing recipe is a failure rather
 * than a silent exclusion (rule 7's corollary: no allow-list).
 */
const CASES: Readonly<Record<string, DeliveryKeyCase>> = {
  gitlab: {
    planted: GITLAB_WEBHOOK_SECRET,
    port: () =>
      gitlabProviderRegistration.create({
        integrationId: INTEGRATION_ID,
        config: { base_url: 'https://gitlab.example.test', project: 'acme/api' },
        secrets: { token: GITLAB_TOKEN, webhook_secret_token: GITLAB_WEBHOOK_SECRET },
        redactor: noSecretsRedactor(),
      }),
    // Planted in the "revision" half of the key technical/06 prescribes for a merge request.
    delivery: {
      headers: {},
      body: JSON.stringify({
        object_kind: 'merge_request',
        object_attributes: {
          id: 93,
          updated_at: `2026-06-01T07:59:00.000Z-${GITLAB_WEBHOOK_SECRET}`,
        },
      }),
    },
  },
  'jira-cloud': {
    planted: JIRA_WEBHOOK_SECRET,
    port: () =>
      jiraRegistration.create({
        integrationId: INTEGRATION_ID,
        config: { site_url: 'https://acme.atlassian.net', user_email: 'bot@example.test' },
        secrets: { api_token: JIRA_TOKEN, webhook_secret: JIRA_WEBHOOK_SECRET },
        redactor: noSecretsRedactor(),
      }),
    delivery: {
      headers: { 'x-atlassian-webhook-identifier': `d-${JIRA_WEBHOOK_SECRET}` },
      body: '{}',
    },
  },
  loki: {
    planted: LOKI_TOKEN,
    port: () =>
      lokiProviderRegistration.create({
        integrationId: INTEGRATION_ID,
        config: { base_url: 'https://loki.example.test:3100' },
        secrets: { bearer_token: LOKI_TOKEN },
        redactor: noSecretsRedactor(),
      }),
    // `ObservabilityLogsPort` has no inbound half; the first assertion below holds it to that.
    delivery: null,
  },
  sentry: {
    planted: SENTRY_TOKEN,
    port: () =>
      sentryProviderRegistration.create({
        integrationId: INTEGRATION_ID,
        config: { base_url: 'https://sentry.example.test', organization: 'acme-example' },
        secrets: { auth_token: SENTRY_TOKEN },
        redactor: noSecretsRedactor(),
      }),
    // Sentry publishes an inbound `Sentry-Hook-Resource` webhook and this adapter does not
    // implement it (`sentry/provider.ts`); the day it does, the assertion below fails.
    delivery: null,
  },
  slack: {
    planted: SLACK_SIGNING_SECRET,
    port: () =>
      slackProviderRegistration.create({
        integrationId: INTEGRATION_ID,
        config: { channel: 'C0FAKECHAN1' },
        secrets: {
          bot_token: 'xoxb-FAKE-PLANTED-bot-token-0123456789',
          app_token: 'xapp-FAKE-PLANTED-app-token-0123456789',
          signing_secret: SLACK_SIGNING_SECRET,
        },
        redactor: noSecretsRedactor(),
      }),
    delivery: {
      headers: {},
      body: JSON.stringify({ type: 'event_callback', event_id: `Ev-${SLACK_SIGNING_SECRET}` }),
    },
  },
};

describe('every provider’s stored dedup key', () => {
  it('has a case here for every provider directory on disk', () => {
    // Derived versus written down: a new provider fails this line before it can fail the next one.
    expect(Object.keys(CASES).sort()).toEqual([...PROVIDER_DIRECTORIES]);
  });

  describe.each(PROVIDER_DIRECTORIES)('%s', (provider) => {
    /**
     * The case, read **inside** each test rather than at collection time.
     *
     * `const testCase = CASES[provider] as DeliveryKeyCase` here used to be the first statement of
     * this block, and the cast made a missing case `undefined`: the very scenario this file exists
     * for — a new provider directory with no case — crashed *collection* with
     * `TypeError: Cannot read properties of undefined (reading 'delivery')` and reported
     * `Tests no tests`. A new provider therefore disabled all twelve assertions in the file
     * instead of failing one of them (standing rules 3, 62 and 68: a `FAIL` naming a file is not a
     * `FAIL` naming a test). Reading it in the test body turns that back into a named failure.
     */
    const caseFor = (): DeliveryKeyCase => {
      const testCase = CASES[provider];
      if (testCase === undefined) {
        expect.fail(
          `${provider}: a provider directory with no case in CASES — add one (a delivery whose ` +
            'keyed fields carry the binding credential, or `delivery: null` if it has no webhook)',
        );
      }
      return testCase;
    };

    it('has a case in this file', () => {
      // The per-provider half of the headline assertion above: that one names the whole set, this
      // one names the provider, and neither can be reached by a crash any more.
      caseFor();
    });

    it('agrees with its port about whether it has an inbound half', () => {
      const testCase = caseFor();
      const inbound = inboundOf(testCase.port());
      // Both directions (rule 9): a webhook provider owes a planted delivery, and a provider
      // without a webhook must not claim one.
      expect(
        inbound !== null,
        inbound === null
          ? `${provider}: the port has no inbound half, so its case must plant no delivery`
          : `${provider}: the port has an inbound half, so its case owes a planted delivery`,
      ).toBe(testCase.delivery !== null);
    });

    /**
     * Whether the two assertions below apply is a property of the *case*, so it is the one thing
     * still read at collection time — defensively (`?.`), because a directory with no case has no
     * delivery to reason about and must reach the named failures above rather than a crash here.
     * A provider with no inbound half reports them as skipped, which is what they are.
     */
    const hasDelivery = CASES[provider]?.delivery != null;

    it.skipIf(!hasDelivery)('is fed a delivery that really carries the binding credential', () => {
      const testCase = caseFor();
      const delivery = testCase.delivery as WebhookDelivery;
      // The harness canary (rules 4 and 42): a green redaction assertion below proves nothing if
      // the plant never reached the input — a renamed field or a mis-shaped body would emit a key
      // with no secret in it and pass.
      expect(`${delivery.body} ${JSON.stringify(delivery.headers)}`).toContain(testCase.planted);
    });

    it.skipIf(!hasDelivery)(
      'redacts the binding credential out of the key the platform stores',
      () => {
        const testCase = caseFor();
        const delivery = testCase.delivery as WebhookDelivery;
        const inbound = inboundOf(testCase.port());
        const key = (inbound as DeliveryKeyed).deliveryKey(delivery);

        expect(key, `${provider}: the key must not carry the binding credential`).not.toContain(
          testCase.planted,
        );
        // A **fragment**, because the failure mode of this class is a cap or a cut applied before
        // redaction, which leaves the leading bytes and nothing else would see them.
        expect(key, `${provider}: nor a fragment of it`).not.toContain(
          testCase.planted.slice(0, 24),
        );
        expect(
          key,
          `${provider}: and the redaction must be the adapter's own — the caller was disarmed`,
        ).toContain(MARKER);
      },
    );
  });
});

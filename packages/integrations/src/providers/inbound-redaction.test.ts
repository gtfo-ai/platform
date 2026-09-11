/**
 * **Every provider's delivery, through the real ingress, with the binding's own credential planted
 * in it** — WP-15c's acceptance criterion *"a binding credential planted in the delivery body
 * reaches neither `events.payload` nor the inbox row"*, parameterised over the set the platform is
 * parameterised over (standing rule 68).
 *
 * ## Why it is here and not beside the ingress
 *
 * `packages/application/src/integrations/inbound.test.ts` drives the ingress against a normaliser
 * double, so what it proves about redaction is what the *ingress* does: the headers, the payload
 * and the ignore detail it stores on the row. The other half — that a **normalised event payload**
 * is clean — is a property of each provider adapter, which redacts the whole delivery before any
 * branch of its normaliser reads it. Asserting that against a double would assert the double.
 *
 * So this file composes the two halves the way production does and plants one credential in a field
 * that reaches each:
 *
 *  - the caller's redactor passed to `registration.create` is **disarmed** (`noSecretsRedactor()`),
 *    exactly as in `delivery-key-redaction.test.ts`, so anything clean in an *event* can only have
 *    been cleaned by the adapter's own `bindingSecretRedactor`;
 *  - `ResolvedInboundIntegration.redactor` is a **real** `bindingSecretRedactor` over the same
 *    credentials, which is what `createInboundIntegrationLoader` builds — so the *row* assertions
 *    are about the ingress.
 *
 * Both are needed and neither discharges the other: delete the adapter's redaction and the events
 * fail; delete the ingress's and the row fails.
 *
 * ## The scope is read off the disk
 *
 * `PROVIDER_DIRECTORIES` is every directory under `providers/`, the derivation
 * `delivery-key-redaction.test.ts` and `fixture-provenance.contract.test.ts` both use, so a fourth
 * provider fails this file the moment its directory exists (standing rule 7). A provider whose port
 * has no inbound half declares `delivery: null` and is held to that in both directions.
 *
 * ## What it does not cover
 *
 *  - **A secret the platform never told the adapter about.** TD-012 step 1 is exact match over
 *    injected values; a neighbouring binding's credential in a delivery body is not redacted by
 *    either half, and the pattern rules (step 2, which the loader composes in production and this
 *    file does not) are the only thing that would see it.
 *  - **That the signature check is right.** That is each provider's own `webhook*.test.ts` and the
 *    integration tier; here every delivery is signed correctly on purpose, because an unverified
 *    one never reaches the code this file is about.
 */
import { readdirSync } from 'node:fs';
import {
  bindingSecretRedactor,
  createIntegrationActionExecutor,
  createMemoryAuditLog,
  createVirtualTimer,
  createWebhookIngress,
  type InboundAuditLog,
  type InboundDeliveryRecord,
  type InboundNormaliser,
  type InboxDelivery,
  type InboxStore,
  noSecretsRedactor,
  type ResolvedInboundIntegration,
  type Transaction,
  type TransactionScope,
  type UnitOfWork,
  type WebhookDelivery,
} from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import { fixedClock } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { gitlabProviderRegistration } from './gitlab/index.js';
import { signWebhookBody } from './jira-cloud/index.js';
import { createJiraCloudRegistration } from './jira-cloud/registration.js';
import { lokiProviderRegistration } from './loki/index.js';
import { sentryProviderRegistration } from './sentry/index.js';
import { slackProviderRegistration } from './slack/index.js';
import { signSlackRequest } from './slack/signature.js';

const NOW = '2026-06-01T10:30:00.000Z' as IsoDateTime;
const clock = fixedClock(NOW);
const INTEGRATION = '00000000-0000-4000-8000-0000000000b1' as Id;
const PROJECT = '00000000-0000-4000-8000-0000000000b2' as Id;

/** The marker either redactor writes. Text carrying it was redacted by *something*. */
const MARKER = '[REDACTED:integration:';

const PROVIDER_DIRECTORIES: readonly string[] = readdirSync(new URL('.', import.meta.url), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

// ── Credentials, all obviously fake and all long enough to clear MIN_SECRET_LENGTH ──

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
    redactor: noSecretsRedactor(),
    timer: createVirtualTimer({ autoAdvance: true }),
    clock,
    rateLimits: () => ({ capacity: 100, refillPerSecond: 100, maxConcurrent: 8 }),
  }),
  clock,
  actionContext: () => ({ mode: 'normal', projectId: null, taskId: null }),
});

const jiraUser = () => ({
  accountId: '557058:00000000-0000-4000-8000-00000000d0c1',
  displayName: 'Dana',
});

const adf = (text: string) => ({
  type: 'doc',
  version: 1,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

const jiraIssue = () => ({
  id: '10001',
  key: 'ACME-1',
  fields: {
    summary: 'Fix the totals',
    description: adf('nothing planted here'),
    issuetype: { name: 'Bug' },
    status: { name: 'In Progress' },
    priority: { name: 'High' },
    labels: ['agentic'],
    updated: '2026-06-01T09:00:00.000+0000',
    issuelinks: [],
  },
});

const jiraBody = JSON.stringify({
  timestamp: Date.parse(NOW),
  webhookEvent: 'comment_created',
  user: jiraUser(),
  issue: jiraIssue(),
  comment: {
    id: '20001',
    author: jiraUser(),
    // The plant that has to survive into `events.payload`: `ticket.comment.added` carries `text`.
    body: adf(`please rotate ${JIRA_WEBHOOK_SECRET}`),
  },
});

const gitlabBody = JSON.stringify({
  object_kind: 'merge_request',
  project: { id: 77, path_with_namespace: 'acme/api', default_branch: 'main' },
  user: { id: 4242, name: 'Dana', username: 'dana' },
  object_attributes: {
    id: 155016007,
    iid: 7,
    title: 'Draft: sum the invoice footer',
    description: 'opened by the developer stage',
    state: 'opened',
    action: 'open',
    // `mr.opened`'s payload carries the ref, not the prose: the branch name is the field that
    // reaches `events.payload`.
    source_branch: `agentic/${GITLAB_WEBHOOK_SECRET}`,
    target_branch: 'main',
    url: 'https://gitlab.example.test/acme/api/-/merge_requests/7',
    updated_at: '2026-06-01T09:00:00.000Z',
    last_commit: { id: 'a'.repeat(40) },
  },
  labels: [],
});

/**
 * Slack's replay window is checked against the **real** clock: `slackProviderRegistration` is a
 * constant and takes none, so a fixed `NOW` three months in the past is a replay and is refused
 * before the code under test is reached. The rest of the file is time-free.
 */
const SLACK_TIMESTAMP = String(Math.floor(Date.now() / 1000));
const slackBody = JSON.stringify({
  type: 'block_actions',
  team: { id: 'T0FAKETEAM' },
  user: { id: 'U0FAKEUSER', team_id: 'T0FAKETEAM' },
  // Nothing this adapter posted, so the delivery is `unsupported_event` — and the detail quotes the
  // `action_id`, **cut to a brief**, which is the branch where redaction has to precede the cut.
  actions: [
    {
      action_id: `noop-${SLACK_SIGNING_SECRET}`,
      block_id: 'someone-elses-block',
      action_ts: '1780000000.000100',
    },
  ],
});

interface InboundCase {
  /** The credential planted in the delivery below, and nowhere else. */
  readonly planted: string;
  readonly secrets: Readonly<Record<string, string>>;
  readonly port: (redactor: ReturnType<typeof noSecretsRedactor>) => object;
  /** A signed delivery, or `null` for a provider whose port has no inbound half. */
  readonly delivery: WebhookDelivery | null;
  /**
   * How many catalogue events this delivery produces.
   *
   * Written down per case rather than inferred, because "no secret in zero events" is a vacuous
   * pass (standing rule 24): the number is what says which branch ran.
   */
  readonly events?: number;
  /** True when the delivery is expected to produce an `ignored` reason on the row. */
  readonly ignored?: boolean;
}

const CASES: Readonly<Record<string, InboundCase>> = {
  gitlab: {
    planted: GITLAB_WEBHOOK_SECRET,
    secrets: { token: GITLAB_TOKEN, webhook_secret_token: GITLAB_WEBHOOK_SECRET },
    port: (redactor) =>
      gitlabProviderRegistration.create({
        integrationId: INTEGRATION,
        config: { base_url: 'https://gitlab.example.test', project: 'acme/api' },
        secrets: { token: GITLAB_TOKEN, webhook_secret_token: GITLAB_WEBHOOK_SECRET },
        redactor,
      }),
    // GitLab's **legacy** scheme, which is the one that sends the binding's own secret back in a
    // header in plain text — the finding migration 0014 exists for.
    delivery: { headers: { 'x-gitlab-token': GITLAB_WEBHOOK_SECRET }, body: gitlabBody },
    events: 1,
  },
  'jira-cloud': {
    planted: JIRA_WEBHOOK_SECRET,
    secrets: { api_token: JIRA_TOKEN, webhook_secret: JIRA_WEBHOOK_SECRET },
    port: (redactor) =>
      jiraRegistration.create({
        integrationId: INTEGRATION,
        config: { site_url: 'https://acme.atlassian.net', user_email: 'bot@example.test' },
        secrets: { api_token: JIRA_TOKEN, webhook_secret: JIRA_WEBHOOK_SECRET },
        redactor,
      }),
    delivery: {
      headers: {
        'x-atlassian-webhook-identifier': 'd-0001',
        'x-hub-signature': signWebhookBody(JIRA_WEBHOOK_SECRET, jiraBody),
      },
      body: jiraBody,
    },
    events: 1,
  },
  loki: {
    planted: LOKI_TOKEN,
    secrets: { bearer_token: LOKI_TOKEN },
    port: (redactor) =>
      lokiProviderRegistration.create({
        integrationId: INTEGRATION,
        config: { base_url: 'https://loki.example.test:3100' },
        secrets: { bearer_token: LOKI_TOKEN },
        redactor,
      }),
    delivery: null,
  },
  sentry: {
    planted: SENTRY_TOKEN,
    secrets: { auth_token: SENTRY_TOKEN },
    port: (redactor) =>
      sentryProviderRegistration.create({
        integrationId: INTEGRATION,
        config: { base_url: 'https://sentry.example.test', organization: 'acme-example' },
        secrets: { auth_token: SENTRY_TOKEN },
        redactor,
      }),
    delivery: null,
  },
  slack: {
    planted: SLACK_SIGNING_SECRET,
    secrets: {
      bot_token: 'xoxb-FAKE-PLANTED-bot-token-0123456789',
      app_token: 'xapp-FAKE-PLANTED-app-token-0123456789',
      signing_secret: SLACK_SIGNING_SECRET,
    },
    port: (redactor) =>
      slackProviderRegistration.create({
        integrationId: INTEGRATION,
        config: { channel: 'C0FAKECHAN1' },
        secrets: {
          bot_token: 'xoxb-FAKE-PLANTED-bot-token-0123456789',
          app_token: 'xapp-FAKE-PLANTED-app-token-0123456789',
          signing_secret: SLACK_SIGNING_SECRET,
        },
        redactor,
      }),
    delivery: {
      headers: {
        'x-slack-request-timestamp': SLACK_TIMESTAMP,
        'x-slack-signature': signSlackRequest(SLACK_SIGNING_SECRET, SLACK_TIMESTAMP, slackBody),
      },
      body: slackBody,
    },
    // Slack's interaction carries nobody's button but its own sender's, so the delivery is
    // `unsupported_event` — which is the branch whose `detail` quotes the planted `action_id` on
    // its way to `inbox.error`, and therefore the one worth driving here.
    events: 0,
    ignored: true,
  },
};

/** Asked of the built object, not of its type: what a new provider gets wrong is the object. */
const inboundOf = (port: object): InboundNormaliser | null =>
  'inbound' in port ? ((port as { inbound: InboundNormaliser }).inbound ?? null) : null;

interface Delivered {
  readonly row: InboxDelivery;
  readonly events: readonly { type: string; payload: unknown }[];
  readonly audit: readonly InboundDeliveryRecord[];
}

const deliverThrough = async (testCase: InboundCase): Promise<Delivered> => {
  const port = testCase.port(noSecretsRedactor());
  const inbound = inboundOf(port);
  if (inbound === null) {
    throw new Error('this case has no inbound half');
  }
  const rows = new Map<string, InboxDelivery>();
  const events: { type: string; payload: unknown }[] = [];
  const audit: InboundDeliveryRecord[] = [];

  const inbox: InboxStore = {
    record: async (_tx: Transaction, delivery: InboxDelivery) => {
      const key = `${delivery.provider} ${delivery.deliveryId}`;
      if (rows.has(key)) {
        return false;
      }
      rows.set(key, delivery);
      return true;
    },
    find: async (provider, deliveryId) => rows.get(`${provider} ${deliveryId}`) ?? null,
  };
  const auditLog: InboundAuditLog = {
    record: async (entry) => {
      audit.push(entry);
    },
  };
  const unitOfWork: UnitOfWork = {
    transaction: async (fn) =>
      fn({
        tx: { adapter: 'memory' } as Transaction,
        events: {
          append: async (appended: readonly { type: string; payload: unknown }[]) => {
            events.push(...appended);
            return [];
          },
        },
      } as unknown as TransactionScope),
  };

  const resolved: ResolvedInboundIntegration = {
    ref: { integrationId: INTEGRATION, provider: 'under-test', type: 'task_management' },
    inbound,
    bindings: [{ bindingId: INTEGRATION, projectId: PROJECT, inbound }],
    // What `createInboundIntegrationLoader` composes from the account's own resolved credentials.
    redactor: bindingSecretRedactor(
      Object.entries(testCase.secrets).map(([field, value]) => ({
        name: `under-test:${INTEGRATION}:${field}`,
        value,
      })),
    ),
  };

  let nextId = 0;
  const ingress = createWebhookIngress({
    loader: { forIntegration: async () => resolved },
    inbox,
    audit: auditLog,
    identities: { forProvider: async () => new Map() },
    unitOfWork,
    eventStore: { nextStreamSequence: async () => 1 },
    ids: {
      next: () => {
        nextId += 1;
        return `00000000-0000-4000-9000-${String(nextId).padStart(12, '0')}` as Id;
      },
    },
    clock: { now: () => NOW },
    timer: { now: () => 0 },
  });

  const outcome = await ingress.deliver({
    provider: 'under-test',
    integrationId: INTEGRATION,
    delivery: testCase.delivery as WebhookDelivery,
  });
  if (outcome.kind !== 'accepted') {
    throw new Error(
      `the delivery was not accepted (${outcome.kind}${
        outcome.kind === 'refused' ? `: ${outcome.reason} — ${outcome.detail}` : ''
      }); the redaction assertions below would be vacuous`,
    );
  }
  const [row] = [...rows.values()];
  if (row === undefined) {
    throw new Error('no inbox row was written');
  }
  return { row, events, audit };
};

describe('every provider’s delivery through the webhook ingress', () => {
  it('has a case here for every provider directory on disk', () => {
    expect(Object.keys(CASES).sort()).toEqual([...PROVIDER_DIRECTORIES]);
  });

  describe.each(PROVIDER_DIRECTORIES)('%s', (provider) => {
    const caseFor = (): InboundCase => {
      const testCase = CASES[provider];
      if (testCase === undefined) {
        expect.fail(
          `${provider}: a provider directory with no case in CASES — add one (a signed delivery ` +
            'whose fields carry the binding credential, or `delivery: null` if it has no webhook)',
        );
      }
      return testCase;
    };

    it('has a case in this file', () => {
      caseFor();
    });

    it('agrees with its port about whether it has an inbound half', () => {
      const testCase = caseFor();
      const inbound = inboundOf(testCase.port(noSecretsRedactor()));
      expect(
        inbound !== null,
        inbound === null
          ? `${provider}: the port has no inbound half, so its case must plant no delivery`
          : `${provider}: the port has an inbound half, so its case owes a signed delivery`,
      ).toBe(testCase.delivery !== null);
    });

    const hasDelivery = CASES[provider]?.delivery != null;

    it.skipIf(!hasDelivery)('is fed a delivery that really carries the credential', () => {
      const testCase = caseFor();
      const delivery = testCase.delivery as WebhookDelivery;
      // The harness canary (rules 4 and 42): everything below is vacuous if the plant never
      // reached the input.
      expect(`${delivery.body} ${JSON.stringify(delivery.headers)}`).toContain(testCase.planted);
    });

    it.skipIf(!hasDelivery)('produces the events its case says it does', async () => {
      const testCase = caseFor();
      const delivered = await deliverThrough(testCase);
      // Which branch ran (standing rule 10): "no secret in zero events" would pass on a delivery
      // the normaliser silently dropped.
      expect(delivered.events).toHaveLength(testCase.events ?? 0);
      expect(delivered.row.error === null).toBe(testCase.ignored !== true);
    });

    it.skipIf(!hasDelivery)(
      'writes no part of the credential into the inbox row the platform stores',
      async () => {
        const testCase = caseFor();
        const delivered = await deliverThrough(testCase);
        const stored = JSON.stringify({
          headers: delivered.row.headers,
          payload: delivered.row.payload,
          error: delivered.row.error,
          delivery_id: delivered.row.deliveryId,
        });

        expect(stored, `${provider}: the row must not carry the binding credential`).not.toContain(
          testCase.planted,
        );
        // A **fragment**, because the failure mode of this class is a cap applied before redaction.
        expect(stored, `${provider}: nor a fragment of it`).not.toContain(
          testCase.planted.slice(0, 24),
        );
        expect(stored, `${provider}: and something really redacted`).toContain(MARKER);
        expect(
          delivered.row.redactionCount,
          `${provider}: the count is the row's only signal that the redactor ran`,
        ).toBeGreaterThanOrEqual(1);
        expect(delivered.row.verified, 'the verdict is stored, not recomputed').toBe(true);
      },
    );

    it.skipIf(!hasDelivery)(
      'writes no part of the credential into events.payload, with the caller’s redactor disarmed',
      async () => {
        const testCase = caseFor();
        const delivered = await deliverThrough(testCase);
        const appended = JSON.stringify(delivered.events);

        expect(appended, `${provider}: an event payload is append-only (BD-003)`).not.toContain(
          testCase.planted,
        );
        expect(appended, `${provider}: nor a fragment of it`).not.toContain(
          testCase.planted.slice(0, 24),
        );
      },
    );

    it.skipIf(!hasDelivery)('writes no part of the credential into the audit row', async () => {
      const testCase = caseFor();
      const delivered = await deliverThrough(testCase);
      expect(JSON.stringify(delivered.audit)).not.toContain(testCase.planted);
      expect(JSON.stringify(delivered.audit)).not.toContain(testCase.planted.slice(0, 24));
    });
  });
});

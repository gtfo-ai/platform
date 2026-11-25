/**
 * An Atlassian **service account** binding (`cloud_id`): every REST call goes to the API gateway,
 * `https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3/`, with `Basic base64(email:token)`;
 * every link a person opens stays on `site_url`; the executor judges the gateway's host; and the
 * credential is still redacted. Built through the real registration, as production builds it.
 *
 * A binding with no `cloud_id` is asserted beside each case, so a change that moved every binding
 * to the gateway — or none — fails here by name. The whole shared TaskManagement contract also runs
 * through the gateway in `test/contract/integrations/jira-cloud.contract.test.ts`.
 */
import {
  createIntegrationActionExecutor,
  createIntegrationEgressPolicy,
  createVirtualTimer,
  IntegrationEgressRefusedError,
  type IntegrationRef,
  noSecretsRedactor,
  type TaskManagementPort,
} from '@platform/application';
import { fixedClock } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { basicAuthHeader } from './client.js';
import { jiraApiBaseUrl, jiraCloudConfigSchema, jiraDerivedEgressUrls } from './config.js';
import { createJiraCloudRegistration } from './registration.js';

const INTEGRATION_ID = '00000000-0000-4000-8000-0000000000e1';
const SITE = 'https://acme-example.atlassian.net';
const CLOUD_ID = '0000fa4e-0000-4000-8000-00000000c10d';
const GATEWAY_ROOT = `https://api.atlassian.com/ex/jira/${CLOUD_ID}/rest/api/3/`;
const SERVICE_EMAIL = 'agentic-bot-fake@serviceaccount.atlassian.com';
const TOKEN = 'FAKE-jira-scoped-token-0123456789';
const clock = fixedClock('2026-11-25T10:30:00.000Z');

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
}

const build = (
  config: Record<string, unknown>,
  respond: (sent: Sent) => Response,
): { port: TaskManagementPort & { ref: IntegrationRef }; sent: Sent[] } => {
  const sent: Sent[] = [];
  const registration = createJiraCloudRegistration({
    clock,
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input as string, init);
      const entry = {
        url: request.url,
        method: request.method,
        authorization: request.headers.get('authorization'),
      };
      sent.push(entry);
      return respond(entry);
    },
  });
  const port = registration.create({
    integrationId: INTEGRATION_ID,
    config: { site_url: SITE, user_email: SERVICE_EMAIL, ...config },
    secrets: { api_token: TOKEN },
    redactor: noSecretsRedactor(),
  }) as TaskManagementPort & { ref: IntegrationRef };
  return { port, sent };
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const myself = () => json(200, { accountId: '712020:fake-service-account', displayName: 'Bot' });

describe('cloud_id in the binding’s schema', () => {
  it('is optional and null by default, so every existing binding parses unchanged', () => {
    const parsed = jiraCloudConfigSchema.parse({
      site_url: SITE,
      user_email: 'agentic-bot@example.test',
      api_token: TOKEN,
    });
    expect(parsed.cloud_id).toBeNull();
  });

  it.each([
    CLOUD_ID,
    '1a11d016-8984-4c3e-b9ab-142dd06acb1b',
    '1A11D016-8984-4C3E-B9AB-142DD06ACB1B',
  ])('accepts the UUID %s', (cloudId) => {
    expect(
      jiraCloudConfigSchema.safeParse({
        site_url: SITE,
        user_email: SERVICE_EMAIL,
        api_token: TOKEN,
        cloud_id: cloudId,
      }).success,
    ).toBe(true);
  });

  /** Every value would be interpolated into the path the credential is sent to. */
  it.each([
    '',
    '../../../wiki',
    `${CLOUD_ID}/../x`,
    `${CLOUD_ID}?x=1`,
    `${CLOUD_ID}#x`,
    `{${CLOUD_ID}}`,
    ` ${CLOUD_ID}`,
    `${CLOUD_ID}\n`,
    '0000fa4e00004000800000000000c10d',
    '0000fa4e-0000-4000-8000-00000000c10g',
    `${CLOUD_ID}-0`,
    'acme-example.atlassian.net',
  ])('refuses %j', (cloudId) => {
    const parsed = jiraCloudConfigSchema.safeParse({
      site_url: SITE,
      user_email: SERVICE_EMAIL,
      api_token: TOKEN,
      cloud_id: cloudId,
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(['cloud_id']);
  });
});

describe('jiraApiBaseUrl', () => {
  it('is the site’s REST root without a cloud_id, trailing slashes folded', () => {
    expect(jiraApiBaseUrl({ site_url: SITE, cloud_id: null })).toBe(`${SITE}/rest/api/3/`);
    expect(jiraApiBaseUrl({ site_url: `${SITE}//`, cloud_id: null })).toBe(`${SITE}/rest/api/3/`);
  });

  it('is the gateway’s REST root for a cloud_id, lower-cased', () => {
    expect(jiraApiBaseUrl({ site_url: SITE, cloud_id: CLOUD_ID.toUpperCase() })).toBe(GATEWAY_ROOT);
  });
});

describe('jiraDerivedEgressUrls (the write-time host check’s input)', () => {
  it('names the gateway for any non-empty cloud_id, validated or not', () => {
    expect(jiraDerivedEgressUrls({ cloud_id: CLOUD_ID })).toEqual(['https://api.atlassian.com/']);
    expect(jiraDerivedEgressUrls({ cloud_id: 'not-a-uuid' })).toEqual([
      'https://api.atlassian.com/',
    ]);
  });

  it.each([{}, { cloud_id: null }, { cloud_id: '' }, { cloud_id: '  ' }, { cloud_id: 7 }])(
    'names nothing for %j',
    (config) => {
      expect(jiraDerivedEgressUrls(config)).toEqual([]);
    },
  );
});

describe('a service-account binding through the real registration', () => {
  it('publishes api.atlassian.com as its host; a site binding publishes the site', () => {
    expect(build({ cloud_id: CLOUD_ID }, myself).port.ref.host).toBe('api.atlassian.com');
    expect(build({}, myself).port.ref.host).toBe('acme-example.atlassian.net');
  });

  it('sends test connection to the gateway with Basic auth of the service account', async () => {
    const { port, sent } = build({ cloud_id: CLOUD_ID }, myself);

    const probe = await port.testConnection();

    expect(probe.ok).toBe(true);
    expect(sent).toEqual([
      {
        url: `${GATEWAY_ROOT}myself`,
        method: 'GET',
        authorization: basicAuthHeader(SERVICE_EMAIL, TOKEN),
      },
    ]);
  });

  it('sends a site binding’s test connection to the site, as before', async () => {
    const { port, sent } = build({}, myself);

    await port.testConnection();

    expect(sent.map((entry) => entry.url)).toEqual([`${SITE}/rest/api/3/myself`]);
  });

  it('writes through the gateway and links the ticket on the site', async () => {
    const { port, sent } = build({ cloud_id: CLOUD_ID }, () =>
      json(201, { id: '10001', key: 'ACME-7', self: `${GATEWAY_ROOT}issue/10001` }),
    );

    const created = await port.createTicket({
      project_key: 'ACME',
      issue_type: 'Task',
      title: 'A split-off ticket',
      description: '',
      labels: [],
    });

    expect(sent.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
      `POST ${GATEWAY_ROOT}issue`,
    ]);
    // Never the gateway's `self`, never the gateway host: a person opens the site.
    expect(created.url).toBe(`${SITE}/browse/ACME-7`);
  });

  it('redacts the token and the Basic header a gateway error quotes back', async () => {
    const header = basicAuthHeader(SERVICE_EMAIL, TOKEN);
    const { port } = build({ cloud_id: CLOUD_ID }, () =>
      json(401, { errorMessages: [`token ${TOKEN} refused; header ${header}`] }),
    );

    const probe = await port.testConnection();

    expect(probe.ok).toBe(false);
    expect(probe.detail).toContain('HTTP 401');
    expect(probe.detail).not.toContain(TOKEN);
    expect(probe.detail).not.toContain(header.replace(/^Basic /, ''));
    expect(probe.detail).toContain('[REDACTED:integration:jira_api_token]');
  });
});

/**
 * The call-time half of the egress allow-list: a deployment that declared the site but not the
 * gateway refuses every call, naming the host to add and the setting — and sends nothing.
 */
describe('the executor judges the gateway’s host', () => {
  const executorFor = (hosts: readonly string[]) =>
    createIntegrationActionExecutor({
      egress: createIntegrationEgressPolicy(hosts),
      auditLog: { record: async () => {} } as never,
      redactor: noSecretsRedactor(),
      timer: createVirtualTimer({ autoAdvance: true }),
      clock,
    });

  const probe = async (hosts: readonly string[], config: Record<string, unknown>) => {
    const { port, sent } = build(config, myself);
    const outcome = await executorFor(hosts)
      .execute({
        integration: port.ref,
        action: 'test_connection',
        mutating: false,
        payload: {},
        perform: () => port.testConnection(),
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    return { outcome, sent };
  };

  it('refuses a service-account binding while api.atlassian.com is undeclared', async () => {
    const { outcome, sent } = await probe(['acme-example.atlassian.net'], { cloud_id: CLOUD_ID });

    expect(outcome).toBeInstanceOf(IntegrationEgressRefusedError);
    expect((outcome as Error).message).toContain('"api.atlassian.com"');
    expect((outcome as Error).message).toContain('APP_INTEGRATION_HOSTS');
    expect(sent).toEqual([]);
  });

  it('performs it once api.atlassian.com is declared', async () => {
    const { outcome, sent } = await probe(['api.atlassian.com'], { cloud_id: CLOUD_ID });

    expect(outcome).toBeNull();
    expect(sent.map((entry) => entry.url)).toEqual([`${GATEWAY_ROOT}myself`]);
  });

  it('still judges a site binding by its site alone', async () => {
    expect((await probe(['acme-example.atlassian.net'], {})).outcome).toBeNull();
    expect((await probe(['api.atlassian.com'], {})).outcome).toBeInstanceOf(
      IntegrationEgressRefusedError,
    );
  });
});

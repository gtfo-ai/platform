/**
 * Which accounts hold a connection, and that opening one goes through the executor (WP-43).
 *
 * Built over the **real** Slack registration, so "selected" and "cannot hold one" are the
 * provider's own answers rather than a double's. The executor is a recording double that still
 * performs the call, so the assertion is on both halves: the action was asked of the executor,
 * and the provider's answer came back through it.
 */
import type {
  BindingRepository,
  IntegrationAccount,
  IntegrationActionExecutor,
  SecretStore,
} from '@platform/application';
import { createVirtualTimer, noSecretsRedactor } from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { createSlackRegistration } from '../providers/slack/index.js';
import { createIntegrationRegistry } from '../registry.js';
import { createHeldConnectionDirectory } from './held-connections.js';

const SLACK = '00000000-0000-4000-8000-0000000000a1' as Id;
const WEBHOOKS = '00000000-0000-4000-8000-0000000000a2' as Id;
const NO_SECRET = '00000000-0000-4000-8000-0000000000a3' as Id;
const BROKEN = '00000000-0000-4000-8000-0000000000a4' as Id;
const GITLAB = '00000000-0000-4000-8000-0000000000a5' as Id;

const SECRETS: Record<string, Record<string, string>> = {
  full: {
    bot_token: 'xoxb-FAKE-bot-token-DO-NOT-USE',
    app_token: 'xapp-FAKE-app-token-DO-NOT-USE',
    signing_secret: 'fake-slack-signing-secret-do-not-use',
  },
  unsigned: {
    bot_token: 'xoxb-FAKE-bot-token-DO-NOT-USE',
    app_token: 'xapp-FAKE-app-token-DO-NOT-USE',
  },
};

const account = (
  integrationId: Id,
  config: Record<string, unknown>,
  secrets: string,
  provider = 'slack',
): IntegrationAccount => ({
  integrationId,
  type: provider === 'slack' ? 'communication' : 'git',
  provider,
  name: `${provider} ${integrationId.slice(-2)}`,
  config: config as never,
  secretIds: [secrets as Id],
  bindings: [],
});

const ACCOUNTS: Record<string, IntegrationAccount> = {
  [SLACK]: account(SLACK, { channel: 'C0FAKE' }, 'full'),
  [WEBHOOKS]: account(WEBHOOKS, { channel: 'C0FAKE', socket_mode: false }, 'full'),
  [NO_SECRET]: account(NO_SECRET, { channel: 'C0FAKE' }, 'unsigned'),
  [BROKEN]: account(BROKEN, { channel: 'C0FAKE' }, 'undecryptable'),
  [GITLAB]: account(GITLAB, {}, 'full', 'gitlab'),
};

const harness = () => {
  const opened: string[] = [];
  const executed: { action: string; host: string | null; mutating: boolean }[] = [];
  const registry = createIntegrationRegistry([
    createSlackRegistration({
      clock: { now: () => '2026-09-26T10:00:00.000Z' as IsoDateTime },
      timer: createVirtualTimer({ autoAdvance: true }),
      fetch: async () =>
        new Response(JSON.stringify({ ok: true, url: 'wss://wss-fake.slack.com/link/?ticket=x' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      connect: (url) => {
        opened.push(url);
        return { send: () => {}, close: () => {} };
      },
    }),
  ]);
  const repository: BindingRepository = {
    forProject: async () => [],
    forIntegration: async (id) => ACCOUNTS[id] ?? null,
  };
  const secrets: SecretStore = {
    resolve: async (ids: readonly Id[]) => {
      if (ids.includes('undecryptable' as Id)) {
        throw new Error('the envelope does not decrypt');
      }
      return SECRETS[ids[0] as string] ?? {};
    },
  } as SecretStore;
  const executor: IntegrationActionExecutor = {
    execute: async (request) => {
      executed.push({
        action: request.action,
        host: request.integration.host,
        mutating: request.mutating,
      });
      const result = await request.perform({ attempt: 1 } as never);
      return { status: 'ok', result, attempts: 1, durationMs: 0 };
    },
  };
  const directory = createHeldConnectionDirectory({
    repository,
    secrets,
    registry,
    platformRedactor: noSecretsRedactor(),
    executor,
    integrationIds: async () => [SLACK, WEBHOOKS, NO_SECRET, BROKEN, GITLAB],
  });
  return { directory, opened, executed };
};

describe('the held-connection directory', () => {
  it('lists the accounts that select Socket Mode — its default — and no other', async () => {
    const { directory } = harness();
    const listed = await directory.list();
    // `socket_mode: false` is the HTTP transport and is not held; GitLab has no held transport.
    expect(listed.map((entry) => [entry.integrationId, entry.kind])).toEqual([
      [SLACK, 'selected'],
      [NO_SECRET, 'selected'],
      [BROKEN, 'broken'],
    ]);
  });

  it('opens a connection through the executor, as a read against the binding’s own host', async () => {
    const { directory, opened, executed } = harness();
    const [slack] = await directory.list();
    if (slack?.kind !== 'selected') {
      throw new Error('expected the Slack account to be selected');
    }
    const connection = slack.open(async () => {});
    await connection.start();

    expect(executed).toEqual([{ action: 'open_socket', host: 'slack.com', mutating: false }]);
    expect(opened).toEqual(['wss://wss-fake.slack.com/link/?ticket=x']);
    await connection.stop();
  });

  it('refuses to build a connection for an account with no signing secret, by name', async () => {
    const { directory } = harness();
    const listed = await directory.list();
    const unsigned = listed.find((entry) => entry.integrationId === NO_SECRET);
    if (unsigned?.kind !== 'selected') {
      throw new Error('expected the unsigned account to be selected');
    }
    expect(() => unsigned.open(async () => {})).toThrow(/signing secret/);
  });

  it('names an account whose credentials cannot be read instead of skipping it', async () => {
    const { directory } = harness();
    const broken = (await directory.list()).find((entry) => entry.integrationId === BROKEN);
    expect(broken).toMatchObject({
      kind: 'broken',
      name: 'slack a4',
      detail: 'its credentials cannot be read: the envelope does not decrypt',
    });
  });
});

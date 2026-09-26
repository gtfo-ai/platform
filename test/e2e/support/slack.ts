/**
 * The far side of Slack for the e2e tier (WP-43) — a Web API and a Socket Mode connection, both
 * injected, so a button press is driven end to end **without a Slack workspace**.
 *
 * Only the two network edges are doubles: the instance runs the real Slack registration, the real
 * adapter, the real `socket.ts`, the real binding loader and executor, and the real ingress. The
 * doubles are written to be no kinder than Slack (standing rule 1):
 *
 *  - the Web API answers only the methods this build calls, in Slack's `200 {ok}` envelope, and an
 *    unscripted method is `{ok: false, error: 'unknown_method'}` rather than a quiet success;
 *  - the socket delivers nothing until the test sends `hello`, as Slack does; an ack is recorded
 *    only when the adapter actually `send`s one; and `close` fires the connection's own `close`
 *    event afterwards, as Node's `WebSocket` does — which is the behaviour that found WP-43's
 *    double-reconnect defect in `socket.ts`.
 *
 * Every value is obviously fake (BD-002).
 */
import type { WebhookDelivery } from '@platform/application';
import type { SlackFetch, SocketConnect, SocketHandlers } from '@platform/integrations';
import { slackSignatureHeaders } from '@platform/integrations';

export const SLACK_E2E_HOST = 'slack.example.test';
export const SLACK_E2E_CHANNEL = 'C0FAKECHAN1';
export const SLACK_E2E_TEAM = 'T0FAKETEAM1';
export const SLACK_E2E_SECRETS = {
  bot_token: 'xoxb-FAKE-e2e-bot-token-DO-NOT-USE',
  app_token: 'xapp-FAKE-e2e-app-token-DO-NOT-USE',
  signing_secret: 'fake-e2e-slack-signing-secret-do-not-use',
} as const;
/** The account config the seeded `integrations` row carries (no secrets: those are sealed). */
export const SLACK_E2E_CONFIG = {
  base_url: `https://${SLACK_E2E_HOST}/api`,
  channel: SLACK_E2E_CHANNEL,
  team_id: SLACK_E2E_TEAM,
  // No network, so no request timer either.
  request_timeout_ms: 0,
} as const;
const WSS_URL = 'wss://wss-fake.slack.example.test/link/?ticket=e2e';

export interface PostedMessage {
  readonly channel: string;
  readonly threadTs: string | null;
  readonly text: string;
  readonly blocks: unknown;
  readonly ts: string;
}

export interface FakeConnection {
  readonly handlers: SocketHandlers;
  readonly sent: string[];
  closed: boolean;
}

export interface FakeSlack {
  readonly fetch: SlackFetch;
  readonly connect: SocketConnect;
  readonly posted: PostedMessage[];
  readonly connections: FakeConnection[];
  /** How many times the adapter asked for a `wss://` URL (`apps.connections.open`). */
  opens(): number;
  /** The connection currently open, or `null`. */
  live(): FakeConnection | null;
  /** Sends an envelope over the live connection, as Slack would. */
  send(envelope: unknown): void;
  /** The acks the adapter sent, as envelope ids. */
  acked(): string[];
}

let tsCounter = 0;
const nextTs = (): string => {
  tsCounter += 1;
  return `1780000${String(100 + tsCounter).padStart(3, '0')}.000${String(tsCounter).padStart(3, '0')}`;
};

export const createFakeSlack = (): FakeSlack => {
  const posted: PostedMessage[] = [];
  const connections: FakeConnection[] = [];
  let opens = 0;

  const answer = (body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });

  const fetch: SlackFetch = async (url, init) => {
    const method = new URL(url).pathname.replace(/^\/api\//, '');
    const body = (init.body === undefined ? {} : parseBody(init.body, init.headers)) as Record<
      string,
      unknown
    >;
    switch (method) {
      case 'apps.connections.open':
        opens += 1;
        return answer({ ok: true, url: WSS_URL });
      case 'auth.test':
        return answer({
          ok: true,
          url: `https://${SLACK_E2E_HOST}/`,
          team: 'fake',
          user: 'agentic',
          team_id: SLACK_E2E_TEAM,
          user_id: 'U0FAKEBOT01',
          bot_id: 'B0FAKEBOT01',
        });
      case 'chat.postMessage': {
        const ts = nextTs();
        const channel = String(body.channel ?? '');
        posted.push({
          channel,
          threadTs: typeof body.thread_ts === 'string' ? body.thread_ts : null,
          text: String(body.text ?? ''),
          blocks: body.blocks,
          ts,
        });
        return answer({ ok: true, channel, ts, message: { text: body.text, ts } });
      }
      default:
        return answer({ ok: false, error: 'unknown_method' });
    }
  };

  const connect: SocketConnect = (_url, handlers) => {
    const connection: FakeConnection = { handlers, sent: [], closed: false };
    connections.push(connection);
    queueMicrotask(() => handlers.onOpen());
    return {
      send: (data) => {
        connection.sent.push(data);
      },
      close: async () => {
        if (connection.closed) {
          return;
        }
        connection.closed = true;
        await Promise.resolve();
        // A real socket announces its own close, after the request (see the module docblock).
        handlers.onClose('closed');
      },
    };
  };

  const live = (): FakeConnection | null =>
    [...connections].reverse().find((connection) => !connection.closed) ?? null;

  return {
    fetch,
    connect,
    posted,
    connections,
    opens: () => opens,
    live,
    send: (envelope) => {
      const connection = live();
      if (connection === null) {
        throw new Error('no Slack socket is open');
      }
      connection.handlers.onMessage(JSON.stringify(envelope));
    },
    acked: () =>
      connections.flatMap((connection) =>
        connection.sent.map((frame) => (JSON.parse(frame) as { envelope_id: string }).envelope_id),
      ),
  };
};

const parseBody = (raw: string, headers: Record<string, string>): unknown => {
  const type = Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1];
  if (type?.includes('application/json') === true) {
    return JSON.parse(raw) as unknown;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of new URLSearchParams(raw)) {
    out[key] = key === 'blocks' ? (JSON.parse(value) as unknown) : value;
  }
  return out;
};

/** The approval button Slack echoes back when it is pressed: the posted block, unchanged. */
export interface PostedButton {
  readonly blockId: string;
  readonly actionId: string;
  readonly value: string;
  readonly messageTs: string;
  readonly threadTs: string | null;
}

/** Finds the Approve (or Request changes) button on an approval the adapter posted. */
export const findApprovalButton = (
  posted: readonly PostedMessage[],
  decision: 'approved' | 'rejected',
): PostedButton | null => {
  for (const message of posted) {
    const blocks = (Array.isArray(message.blocks) ? message.blocks : []) as {
      type?: string;
      block_id?: string;
      elements?: { action_id?: string; value?: string }[];
    }[];
    for (const block of blocks) {
      if (block.type !== 'actions' || !String(block.block_id).startsWith('agentic:approval:')) {
        continue;
      }
      const wanted = decision === 'approved' ? 'agentic_approve' : 'agentic_reject';
      const element = (block.elements ?? []).find((candidate) => candidate.action_id === wanted);
      if (element?.value !== undefined) {
        return {
          blockId: String(block.block_id),
          actionId: wanted,
          value: element.value,
          messageTs: message.ts,
          threadTs: message.threadTs,
        };
      }
    }
  }
  return null;
};

let actionCounter = 0;

/** Slack's `block_actions` payload for a press of `button` by `userId`. */
export const blockActionsFor = (button: PostedButton, userId: string) => {
  actionCounter += 1;
  return {
    type: 'block_actions',
    team: { id: SLACK_E2E_TEAM, domain: 'agentic-fake' },
    user: { id: userId, username: 'someone', team_id: SLACK_E2E_TEAM },
    api_app_id: 'A0FAKEAPP01',
    container: {
      type: 'message',
      message_ts: button.messageTs,
      ...(button.threadTs === null ? {} : { thread_ts: button.threadTs }),
      channel_id: SLACK_E2E_CHANNEL,
      is_ephemeral: false,
    },
    channel: { id: SLACK_E2E_CHANNEL, name: 'agentic' },
    actions: [
      {
        action_id: button.actionId,
        block_id: button.blockId,
        text: { type: 'plain_text', text: 'Approve' },
        value: button.value,
        type: 'button',
        action_ts: `1780009${String(actionCounter).padStart(3, '0')}.000001`,
      },
    ],
  };
};

/** The same payload as an HTTP delivery, signed as Slack signs one. */
export const signedHttpDelivery = (payload: unknown): WebhookDelivery => {
  const body = JSON.stringify(payload);
  return {
    headers: {
      'content-type': 'application/json',
      ...slackSignatureHeaders({
        secret: SLACK_E2E_SECRETS.signing_secret,
        timestampSeconds: Math.floor(Date.now() / 1000),
        body,
      }),
    },
    body,
  };
};

/** The same payload as a Socket Mode `interactive` envelope. */
export const interactiveEnvelope = (envelopeId: string, payload: unknown) => ({
  envelope_id: envelopeId,
  type: 'interactive',
  accepts_response_payload: false,
  payload,
});

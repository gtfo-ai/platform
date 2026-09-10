/**
 * The Slack payloads the contract runs deliver, and the obviously fake credentials they are signed
 * with.
 *
 * These are **not** in `test/fixtures/http/slack/` on purpose, and `SOURCES.md` says why: a signed
 * delivery has to be signed over the exact bytes the harness sends, so a literal signature in a
 * file would be a signature over a body nobody could reproduce. The payload *shapes* are still
 * transcribed from Slack's published pages, cited at each builder:
 *
 *  - the `block_actions` payload:
 *    <https://docs.slack.dev/reference/interaction-payloads/block_actions-payload>
 *  - the Events API envelope and the `message` event:
 *    <https://docs.slack.dev/reference/events/message>
 *  - the Socket Mode envelope: <https://docs.slack.dev/apis/events-api/using-socket-mode>
 *
 * All retrieved 2026-09-10.
 */
import type { WebhookDelivery } from '@platform/application';
import {
  ANSWER_ACTION_ID,
  APPROVE_ACTION_ID,
  approvalBlockId,
  questionBlockId,
  REJECT_ACTION_ID,
  slackSignatureHeaders,
} from '@platform/integrations';

/** Obviously fake, shaped like nothing Slack issues (BD-002). */
export const FAKE_BOT_TOKEN = 'xoxb-FAKE-bot-token-DO-NOT-USE';
export const FAKE_APP_TOKEN = 'xapp-FAKE-app-token-DO-NOT-USE';
export const FAKE_SIGNING_SECRET = 'fake-slack-signing-secret-do-not-use';

export const SLACK_HOST = 'https://slack.example.test/api';
export const TEAM_ID = 'T0FAKETEAM1';
export const CHANNEL = 'C0FAKECHAN1';
export const MISSING_CHANNEL = 'C0FAKEMISS1';
/** A channel whose recorded answer is `invalid_blocks`, for the mapping test. */
export const INVALID_BLOCKS_CHANNEL = 'C0FAKEBLOCK';

export const THREAD_TS = '1780000000.000100';
export const QUESTION_TS = '1780000001.000200';
export const PLAIN_MESSAGE_TS = '1780000003.000400';
export const MISSING_MESSAGE_TS = '1799999999.999999';

export const MAPPED_USER = 'U0FAKEDEV01';
export const MAPPED_EMAIL = 'dev@example.test';
export const STRANGER_USER = 'U0FAKESTRA1';
export const BOT_USER = 'U0FAKEBOT01';
export const DEACTIVATED_USER = 'U0FAKEGONE1';
export const NO_SCOPE_EMAIL = 'no-scope@example.test';

export const CLOCK_AT = '2026-06-01T09:00:00.000Z';
const CLOCK_SECONDS = Math.floor(Date.parse(CLOCK_AT) / 1000);

/** A delivery signed exactly as Slack signs one, at the harness's fixed clock. */
export const signedDelivery = (payload: unknown, secret = FAKE_SIGNING_SECRET): WebhookDelivery => {
  const body = JSON.stringify(payload);
  return {
    headers: slackSignatureHeaders({ secret, timestampSeconds: CLOCK_SECONDS, body }),
    body,
  };
};

/**
 * A button click on a question, as Slack's printed `block_actions` example is shaped.
 *
 * `action_ts` varies with the author so two clicks are two decisions rather than one redelivery —
 * which is what `deliveryKey` keys on.
 */
export const answerClickBody = (authorId: string, questionId: string, option: string) => ({
  type: 'block_actions',
  team: { id: TEAM_ID, domain: 'agentic-fake' },
  user: { id: authorId, username: 'dev.one', team_id: TEAM_ID },
  api_app_id: 'A0FAKEAPP01',
  container: {
    type: 'message',
    message_ts: QUESTION_TS,
    thread_ts: THREAD_TS,
    channel_id: CHANNEL,
    is_ephemeral: false,
  },
  trigger_id: '0000000000.0000000000.fake0000000000000000000000000000',
  channel: { id: CHANNEL, name: 'agentic' },
  message: { bot_id: 'B0FAKEBOT01', type: 'message', ts: QUESTION_TS, thread_ts: THREAD_TS },
  response_url: 'https://hooks.slack.example.test/actions/A0FAKEAPP01/000/fake',
  actions: [
    {
      action_id: ANSWER_ACTION_ID,
      block_id: questionBlockId(questionId),
      text: { type: 'plain_text', text: option, emoji: true },
      value: JSON.stringify({ q: questionId, o: option }),
      type: 'button',
      action_ts: `17800000${authorId === STRANGER_USER ? '11' : '10'}.000700`,
    },
  ],
});

export const approvalClickBody = (
  authorId: string,
  approvalId: string,
  decision: 'approved' | 'rejected',
) => ({
  type: 'block_actions',
  team: { id: TEAM_ID, domain: 'agentic-fake' },
  user: { id: authorId, username: 'dev.one', team_id: TEAM_ID },
  api_app_id: 'A0FAKEAPP01',
  container: {
    type: 'message',
    message_ts: '1780000002.000300',
    thread_ts: THREAD_TS,
    channel_id: CHANNEL,
    is_ephemeral: false,
  },
  channel: { id: CHANNEL, name: 'agentic' },
  actions: [
    {
      action_id: decision === 'approved' ? APPROVE_ACTION_ID : REJECT_ACTION_ID,
      block_id: approvalBlockId(approvalId),
      text: { type: 'plain_text', text: decision === 'approved' ? 'Approve' : 'Request changes' },
      value: JSON.stringify({ a: approvalId, d: decision }),
      type: 'button',
      action_ts: '1780000012.000800',
    },
  ],
});

/** A reply in the task thread — the Events API envelope around a `message` event. */
export const threadReplyBody = (authorId: string, text: string) => ({
  token: 'not-read-by-this-adapter',
  team_id: TEAM_ID,
  api_app_id: 'A0FAKEAPP01',
  event: {
    type: 'message',
    channel: CHANNEL,
    user: authorId,
    text,
    ts: '1780000013.000900',
    thread_ts: THREAD_TS,
    channel_type: 'channel',
    event_ts: '1780000013.000900',
  },
  type: 'event_callback',
  authorizations: [
    { team_id: TEAM_ID, user_id: BOT_USER, is_bot: true, is_enterprise_install: false },
  ],
  event_id: `Ev0FAKE${authorId === STRANGER_USER ? '0002' : '0001'}`,
  event_time: 1_780_000_013,
});

/**
 * An event type this adapter does not handle, delivered authentically.
 *
 * Slack ships new event types continuously; `reaction_added` is one this app is not subscribed to
 * and would never see in production, which makes it exactly the right shape for "something arrived
 * that we do not understand" (standing rule 20).
 */
export const unknownEventBody = () => ({
  team_id: TEAM_ID,
  api_app_id: 'A0FAKEAPP01',
  event: {
    type: 'reaction_added',
    user: MAPPED_USER,
    reaction: 'thumbsup',
    item: { type: 'message', channel: CHANNEL, ts: THREAD_TS },
    event_ts: '1780000014.001000',
  },
  type: 'event_callback',
  event_id: 'Ev0FAKE0003',
  event_time: 1_780_000_014,
});

/** A Socket Mode envelope carrying one of the payloads above. */
export const socketEnvelope = (envelopeId: string, type: string, payload: unknown) => ({
  envelope_id: envelopeId,
  type,
  payload,
  accepts_response_payload: false,
});

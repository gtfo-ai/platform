/**
 * One Slack adapter wired to the recorded fixtures, shared by the contract runner and the executor
 * composition test.
 *
 * It lives beside the suites rather than inside a test file so that importing it does not register
 * somebody else's `describe` blocks.
 */
import type { IntegrationTimer } from '@platform/application';
import { fixedClock, sequentialIds } from '@platform/domain';
import {
  createSlackProvider,
  questionBlocks,
  type SlackProvider,
  type SocketConnect,
  slackConfigSchema,
} from '@platform/integrations';
import type { CommunicationContractContext } from './communication-contract-suite.js';
import {
  answerClickBody,
  approvalClickBody,
  CHANNEL,
  CLOCK_AT,
  FAKE_APP_TOKEN,
  FAKE_BOT_TOKEN,
  FAKE_SIGNING_SECRET,
  MAPPED_EMAIL,
  MAPPED_USER,
  MISSING_CHANNEL,
  SLACK_HOST,
  STRANGER_USER,
  signedDelivery,
  TEAM_ID,
  THREAD_TS,
  threadReplyBody,
  unknownEventBody,
} from './slack-fixtures.js';
import {
  createSlackReplay,
  loadSlackFixture,
  type SlackReplay,
  slackFixtureNames,
} from './slack-replay.js';

export const SLACK_INTEGRATION_ID = '00000000-0000-4000-8000-0000000000aa';
export const SLACK_PROJECT_ID = '00000000-0000-4000-8000-0000000000ba';
export const SLACK_TASK_ID = '00000000-0000-4000-8000-0000000000ca';
export const SLACK_QUESTION_ID = '00000000-0000-4000-8000-0000000000da';
export const SLACK_APPROVAL_ID = '00000000-0000-4000-8000-0000000000ea';

export interface SlackReplayContext extends CommunicationContractContext {
  readonly replay: SlackReplay;
  /**
   * The same adapter under Slack's own port. `CommunicationContractContext.port` is the type port,
   * which is the point of the shared suite; the extras BD-017 lets a provider add — the thread
   * directory and the Socket Mode connection — are only visible through this one.
   */
  readonly slack: SlackProvider;
}

export const slackReplayContext = (
  overrides: {
    readonly socketMode?: boolean;
    /** Socket Mode: injected so a test drives envelopes without a network. */
    readonly connect?: SocketConnect;
    readonly timer?: IntegrationTimer;
  } = {},
): SlackReplayContext => {
  // Every fixture file on disk, not a list somebody has to remember to extend (rule 7).
  const replay = createSlackReplay(slackFixtureNames().flatMap((name) => loadSlackFixture(name)));
  const config = slackConfigSchema.parse({
    base_url: SLACK_HOST,
    channel: CHANNEL,
    team_id: TEAM_ID,
    socket_mode: overrides.socketMode ?? true,
    // No network, so no timeout timer either: a wall-clock timer in a replay run is a hardware
    // dependency with nothing to guard.
    request_timeout_ms: 0,
  });
  const port = createSlackProvider({
    integrationId: SLACK_INTEGRATION_ID,
    config,
    secrets: {
      bot_token: FAKE_BOT_TOKEN,
      app_token: FAKE_APP_TOKEN,
      signing_secret: FAKE_SIGNING_SECRET,
    },
    fetchImpl: replay.fetchImpl,
    clock: fixedClock(CLOCK_AT),
    ids: sequentialIds(1),
    ...(overrides.connect === undefined ? {} : { connect: overrides.connect }),
    ...(overrides.timer === undefined ? {} : { timer: overrides.timer }),
  });

  /**
   * The same adapter with **no** signing secret: the binding an operator creates when they forget
   * the credential. Standing rule 18 — it must verify nothing at all.
   */
  const unverifiablePort = createSlackProvider({
    integrationId: SLACK_INTEGRATION_ID,
    config,
    secrets: { bot_token: FAKE_BOT_TOKEN },
    fetchImpl: replay.fetchImpl,
    clock: fixedClock(CLOCK_AT),
    ids: sequentialIds(1),
  });

  /**
   * An inbound delivery arrives for a thread the platform opened earlier, in another process, on
   * another day. The suite's inbound cases do not open one, so the emit helpers put the adapter in
   * the state a running deployment would be in — rather than the `create` doing it, which would
   * let "opens one thread per task" pass without ever reaching the provider.
   */
  const rememberThread = (): void => {
    port.threads.rememberThread(SLACK_TASK_ID, { channel: CHANNEL, threadTs: THREAD_TS });
  };

  return {
    replay,
    port,
    slack: port,
    unverifiablePort,
    channel: CHANNEL,
    missingChannel: MISSING_CHANNEL,
    taskId: SLACK_TASK_ID,
    questionId: SLACK_QUESTION_ID,
    approvalId: SLACK_APPROVAL_ID,
    mappedAuthor: { providerUserId: MAPPED_USER, email: MAPPED_EMAIL },
    unmappedAuthorId: STRANGER_USER,
    // Real Block Kit: the fake accepts `[{type:'actions'}]`, Slack answers `invalid_blocks` for it
    // and this adapter refuses it before the request leaves the process.
    providerBlocks: questionBlocks({
      questionId: SLACK_QUESTION_ID,
      markdown: 'Which currency should totals use?',
      options: ['EUR', 'CZK'],
    }),
    providerCalls: () => replay.requests.length,
    emitAnswer: (authorId, text) => {
      rememberThread();
      return signedDelivery(answerClickBody(authorId, SLACK_QUESTION_ID, text));
    },
    emitApproval: (authorId, decision) => {
      rememberThread();
      return signedDelivery(approvalClickBody(authorId, SLACK_APPROVAL_ID, decision));
    },
    emitFeedback: (authorId, text) => {
      rememberThread();
      return signedDelivery(threadReplyBody(authorId, text));
    },
    emitUnknownEvent: () => {
      rememberThread();
      return signedDelivery(unknownEventBody());
    },
    signedWithNoCredential: () =>
      signedDelivery(answerClickBody(MAPPED_USER, SLACK_QUESTION_ID, 'EUR'), ''),
    projectId: SLACK_PROJECT_ID,
    integrationId: SLACK_INTEGRATION_ID,
    cleanup: async () => {},
  };
};

/**
 * The Communication contract suite against the **real Slack adapter**, in replay
 * (WP-10 acceptance: "contract suite; manifest file").
 *
 * Two lines of `communication-contract-suite.ts` changed for this runner, and both *added* an
 * obligation every communication provider now carries (standing rule 23); not one assertion was
 * relaxed. That is the BD-017 claim being tested as much as the adapter is: adding a provider is a
 * module, a registration, a setup guide and a runner.
 *
 * Every response comes from `test/fixtures/http/slack/*.json`, each interaction carrying the
 * documentation URL it was transcribed from and whether that shape is a printed example, a body
 * assembled from an error table, or composed. The adapter's `fetch` is injected, so nothing here
 * opens a socket, sleeps or reads a wall clock.
 */
import {
  createVirtualTimer,
  type IntegrationError,
  type WebhookDelivery,
} from '@platform/application';
import type { SocketHandlers } from '@platform/integrations';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { runCommunicationContract } from '../support/integrations/communication-contract-suite.js';
import { expectIntegrationError } from '../support/integrations/shared.js';
import {
  answerClickBody,
  BOT_USER,
  CHANNEL,
  DEACTIVATED_USER,
  INVALID_BLOCKS_CHANNEL,
  MAPPED_EMAIL,
  MAPPED_USER,
  MISSING_MESSAGE_TS,
  NO_SCOPE_EMAIL,
  PLAIN_MESSAGE_TS,
  STRANGER_USER,
  socketEnvelope,
  THREAD_TS,
} from '../support/integrations/slack-fixtures.js';
import { slackReplayContext } from '../support/integrations/slack-harness.js';
import {
  closeFixtureAssertionWindow,
  loadSlackFixture,
  type SlackInteraction,
  slackFixtureNames,
  unassertedFixtureServes,
  unusedFixtures,
} from '../support/integrations/slack-replay.js';

runCommunicationContract({
  name: 'slack (replay against recorded fixtures)',
  create: async () => slackReplayContext(),
});

/**
 * The corpus is held to the suite, not just the suite to the corpus (WP-09 review rounds 1 and 2).
 *
 * `unusedFixtures()` proves every recorded interaction was *reached*; `unassertedFixtureServes()`
 * proves an assertion followed each serve inside the same test, because a check that counts
 * execution is not a check that counts assertion (standing rule 24). Neither is sufficient alone.
 */
afterEach(() => {
  closeFixtureAssertionWindow();
});

afterAll(() => {
  expect(
    unusedFixtures(),
    'every recorded interaction must be exercised: write the test, or delete the fixture',
  ).toEqual([]);
  expect(
    unassertedFixtureServes(),
    'every fixture a test fetched must be followed by an assertion in that test: a call is not a check',
  ).toEqual([]);
});

/**
 * Standing rule 17 applied to this corpus, which nothing else applies it to.
 *
 * `SlackInteraction.source` is required *by the type*, and `loadSlackFixture` casts the parsed JSON
 * rather than validating it — so until this test existed a fixture could lose its `source` block,
 * or name `https://example.invalid`, and every test in this file would still pass. The shared
 * provenance suite checks the same corpus from the other side; this one is here because the *type*
 * is the thing that looks like a guarantee and is not one.
 */
it('every recorded interaction names a vendor page, a retrieval date and a kind', () => {
  const complaints = slackFixtureNames().flatMap((name) =>
    loadSlackFixture(name).flatMap((interaction, index) => {
      const where = `${name}.json #${index} (${interaction.method} ${interaction.path})`;
      // Cast to the partial shape on purpose: the point is that the file on disk may not have it.
      const source = interaction.source as Partial<SlackInteraction['source']> | undefined;
      if (source === undefined) {
        return [`${where}: no source block`];
      }
      const problems: string[] = [];
      if (!/^https:\/\/docs\.slack\.dev\//.test(source.url ?? '')) {
        problems.push(`url ${String(source.url)} is not a page on the vendor's documentation`);
      }
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(source.retrieved ?? '') ||
        Number.isNaN(Date.parse(source.retrieved ?? ''))
      ) {
        problems.push(`retrieved ${String(source.retrieved)} is not a date`);
      }
      if (
        source.kind !== 'documented' &&
        source.kind !== 'documented-adapted' &&
        source.kind !== 'composed'
      ) {
        problems.push(`kind ${String(source.kind)} is not one this corpus uses`);
      }
      if (source.kind !== 'documented' && (source.note ?? '').trim() === '') {
        problems.push(`kind ${String(source.kind)} with no note`);
      }
      return problems.map((problem) => `${where}: ${problem}`);
    }),
  );
  expect(
    complaints,
    'a provenance label is a claim about the corpus, and an unasserted claim drifts (rule 17)',
  ).toEqual([]);
});

/**
 * The harness's own guard (standing rule 4: a positive assertion fails loudly on a broken harness).
 *
 * If the replay transport answered an unmatched request with an empty body instead of throwing,
 * every assertion in this file would pass against an adapter that never ran.
 */
it('fails loudly for a request no fixture matches', async () => {
  const context = slackReplayContext();
  const error = await context.port
    // The corpus records a one-item digest; a two-item one is a body nothing answers.
    .postDigest(CHANNEL, [
      { task_id: null, title: 'TASK-1', url: null, state: 'ready_for_merge', detail: null },
      { task_id: null, title: 'TASK-2', url: null, state: 'blocked', detail: null },
    ])
    .catch((caught: unknown) => caught);

  // The adapter treats it as any other transport failure, which is the honest reading: from
  // inside, a transport that threw is a transport that threw. The loudness is on the `cause`, and
  // asserting it there is what proves the harness cannot answer an unmatched request quietly.
  expect((error as IntegrationError).code).toBe('unavailable');
  expect(String(((error as IntegrationError).cause as Error).message)).toMatch(
    /no fixture for POST \/chat\.postMessage/,
  );
});

/**
 * Untrusted ticket text must not become a Slack broadcast (BD-022), driven through the **adapter**.
 *
 * Review round 1 found that `mrkdwn.ts` escaped `<` and `>` and then the markdown-link rule put
 * them straight back around an attacker-controlled target, so
 * `[urgent](!channel)` left this process as `<!channel|urgent>`. Slack's parser "detect[s] all
 * sub-strings matching `<(.*?)>`" and formats content starting with `@U`/`@W` as a user mention,
 * `!subteam` as a group mention and `!` as a special mention — so a ticket description could
 * `@channel` a workspace, fake a mention of a named person and ping a subteam.
 *
 * These cases are here rather than only in `mrkdwn.test.ts` because the unit test that was
 * supposed to cover this asserted a *pre-escaped literal* and would have passed either way
 * (standing rule 3). What matters is the bytes that leave the process, so every case below reads
 * the recorded request body: the fallback `text` **and** the `mrkdwn` section, which are two
 * separate renderings of the same markdown and both carried the payload.
 */
describe('a ticket cannot mention a workspace through the adapter', () => {
  /** A `chat.postMessage` answer for a body the corpus does not record. */
  const anyPost = (): SlackInteraction => ({
    method: 'POST',
    path: '/chat.postMessage',
    match: { channel: CHANNEL },
    status: 200,
    body: { ok: true, channel: CHANNEL, ts: THREAD_TS },
    source: {
      url: 'https://docs.slack.dev/reference/methods/chat.postMessage',
      retrieved: '2026-09-10',
      kind: 'documented-adapted',
      note: "The page's example success response reduced to the three members the adapter reads; scripted, not part of the corpus, because these bodies are adversarial rather than documented.",
    },
  });

  /** Posts `markdown` as a task thread and returns what actually went on the wire. */
  const post = async (markdown: string): Promise<{ text: string; blocks: string }> => {
    const context = slackReplayContext();
    context.replay.script(anyPost());
    await context.port.postTaskThread({
      channel: CHANNEL,
      taskId: context.taskId,
      body: { markdown },
    });
    const sent = context.replay.requests.at(-1)?.body as {
      text: string;
      blocks: unknown;
    };
    return { text: sent.text, blocks: JSON.stringify(sent.blocks) };
  };

  it('leaves a channel, user and subteam mention inert in both renderings', async () => {
    const fromATicket =
      'Ticket says: [urgent](!channel) cc [boss](@U0FAKEBOSS) [devs](!subteam^S0FAKE)';
    const { text, blocks } = await post(fromATicket);

    // The exact strings Slack's parser acts on. Asserted one by one so a failure names which.
    for (const fired of ['<!channel', '<@U0FAKEBOSS', '<!subteam^S0FAKE']) {
      expect(text, `the fallback text must not carry ${fired}`).not.toContain(fired);
      expect(blocks, `the mrkdwn section must not carry ${fired}`).not.toContain(fired);
    }
    // Stronger and mutation-proof: the converter emitted no angle bracket at all, so there is no
    // `<(.*?)>` substring for Slack to detect. The markdown source is what a human sees instead.
    expect(text).toBe(fromATicket);
    expect(text).not.toContain('<');
    expect(text).not.toContain('>');
    expect(blocks).toContain('[urgent](!channel)');
  });

  it('refuses a scheme-relative target, a javascript: URL and a nested link', async () => {
    for (const [markdown, expected] of [
      ['see [here](//evil.example.test/x)', 'see [here](//evil.example.test/x)'],
      ['see [here](javascript:alert)', 'see [here](javascript:alert)'],
      // The regex stops the target at the first `)`, so the trailing one is plain text.
      ['see [a]([b](c))', 'see [a]([b](c))'],
      // No scheme at all, and no label either: the empty-label branch is allow-listed too.
      ['see [](!here)', 'see [](!here)'],
    ] as const) {
      const { text } = await post(markdown);
      expect(text, markdown).toBe(expected);
      expect(text, `${markdown} must produce no bracketed substring`).not.toMatch(/<.*?>/s);
    }
  });

  it('still links the schemes it allows, whatever case they are written in', async () => {
    // RFC 3986 §3.1: scheme names are case-insensitive, so refusing `HTTPS:` would break a
    // legitimate link. The content still starts with a scheme, which is what makes it a URL link
    // and not a mention.
    const upper = await post('see [the MR](HTTPS://git.example.test/mr/1)');
    expect(upper.text).toBe('see <HTTPS://git.example.test/mr/1|the MR>');
    const mail = await post('write to [us](mailto:team@example.test)');
    expect(mail.text).toBe('write to <mailto:team@example.test|us>');
  });

  it('cannot be broken out of by a `>` or a `|` inside an allowed URL', async () => {
    // `>` was escaped before the link rule ran, so it cannot close the substring early: Slack's
    // non-greedy `<(.*?)>` stops at the bracket the converter wrote.
    const angle = await post('see [x](https://ok.example.test/?a=><!channel>)');
    expect(angle.text).toBe('see <https://ok.example.test/?a=&gt;&lt;!channel&gt;|x>');
    expect(angle.text.match(/</g)).toHaveLength(1);
    expect(angle.text.match(/>/g)).toHaveLength(1);

    // `|` is Slack's own label separator, so a target containing one moves the label boundary.
    // That is a display artefact and not an escape: the content still starts with `https:`, so it
    // is parsed as a URL link and can never be a mention.
    const pipe = await post('see [x](https://ok.example.test/a|b)');
    expect(pipe.text).toBe('see <https://ok.example.test/a|b|x>');
    expect(pipe.text.startsWith('see <https://')).toBe(true);
  });
});

describe('slack adapter, beyond the shared suite', () => {
  it('sends the thread parent as a root message and the question into its thread', async () => {
    const context = slackReplayContext();
    const thread = await context.port.postTaskThread({
      channel: CHANNEL,
      taskId: context.taskId,
      body: { markdown: 'Picked up **TASK-1**' },
    });
    await context.port.postMessage(thread, { markdown: 'Ready for merge' });

    const posts = context.replay.requests.filter((request) => request.path === '/chat.postMessage');
    expect(posts).toHaveLength(2);
    expect(posts[0]?.body.thread_ts, 'a task thread has no parent').toBeUndefined();
    expect(posts[1]?.body.thread_ts, 'a reply names the parent').toBe(THREAD_TS);
    expect(posts[1]?.body.reply_broadcast, 'and does not also land in the channel').toBe(false);
    // The markdown was converted, not passed through: `**TASK-1**` renders as four asterisks.
    expect(posts[0]?.body.text).toBe('Picked up *TASK-1*');
    expect(posts[0]?.headers.authorization).toMatch(/^Bearer xoxb-FAKE/);
  });

  it('renders Block Kit the platform never wrote', async () => {
    const context = slackReplayContext();
    const thread = await context.port.postTaskThread({
      channel: CHANNEL,
      taskId: context.taskId,
      body: { markdown: 'Picked up **TASK-1**' },
    });
    await context.port.postApproval(
      thread,
      {
        id: context.approvalId,
        task_id: context.taskId,
        kind: 'plan',
        status: 'pending',
        requested_at: '2026-06-01T09:05:00.000Z',
        deadline_at: null,
        decided_by_user_id: null,
        decided_at: null,
        reason: null,
      },
      { markdown: 'Approve the plan?' },
    );

    const posted = context.replay.requests.at(-1)?.body as { blocks: { type: string }[] };
    expect(posted.blocks.map((block) => block.type)).toEqual(['section', 'actions', 'context']);
    expect(JSON.stringify(posted.blocks)).toContain(`agentic:approval:${context.approvalId}`);
  });

  it('refuses Block Kit Slack would refuse, before the request leaves the process', async () => {
    const context = slackReplayContext();
    const before = context.replay.requests.length;
    await expectIntegrationError(
      () =>
        context.port.postTaskThread({
          channel: CHANNEL,
          taskId: context.taskId,
          body: { markdown: 'x', blocks: [{ type: 'actions', elements: [] }] },
        }),
      'invalid_request',
    );
    expect(context.replay.requests.length, 'the validation is local: nothing was sent').toBe(
      before,
    );
  });

  it("maps Slack's own invalid_blocks answer when it gets one anyway", async () => {
    // The guard above makes this unreachable through the adapter's own rendering, so the mapping
    // is exercised against a channel whose recorded answer is that slug — an inner layer given a
    // seam rather than left to look tested (standing rule 22).
    const context = slackReplayContext();
    await expectIntegrationError(
      () =>
        context.port.postTaskThread({
          channel: INVALID_BLOCKS_CHANNEL,
          taskId: context.taskId,
          body: { markdown: 'this channel always answers invalid_blocks' },
        }),
      'invalid_request',
    );
  });

  it('reports a missing message as not_found when editing', async () => {
    const context = slackReplayContext();
    await expectIntegrationError(
      () =>
        context.port.updateMessage(
          {
            provider: 'slack',
            channel: CHANNEL,
            message_id: MISSING_MESSAGE_TS,
            thread_id: null,
            url: null,
          },
          { markdown: 'Merged' },
        ),
      'not_found',
    );
  });

  it('edits a message in place and keeps its identity', async () => {
    const context = slackReplayContext();
    const updated = await context.port.updateMessage(
      {
        provider: 'slack',
        channel: CHANNEL,
        message_id: PLAIN_MESSAGE_TS,
        thread_id: THREAD_TS,
        url: null,
      },
      { markdown: 'Merged' },
    );
    expect(updated.message_id).toBe(PLAIN_MESSAGE_TS);
    expect(context.replay.requests.at(-1)?.body).toMatchObject({
      channel: CHANNEL,
      ts: PLAIN_MESSAGE_TS,
      text: 'Merged',
    });
  });

  describe('identity mapping is a security boundary', () => {
    it('resolves a Slack account by id and by email', async () => {
      const context = slackReplayContext();
      const byId = await context.port.resolveIdentity({ providerUserId: MAPPED_USER });
      expect(byId).toMatchObject({
        provider: 'slack',
        external_id: MAPPED_USER,
        email: MAPPED_EMAIL,
        verified: true,
      });
      const byEmail = await context.port.resolveIdentity({ email: MAPPED_EMAIL });
      expect(byEmail?.external_id).toBe(MAPPED_USER);
    });

    it('refuses a bot and a deactivated account rather than mapping them', async () => {
      const context = slackReplayContext();
      // Control: the same call for a human account returns an identity (asserted above), so a null
      // here is a refusal rather than a lookup that never happened.
      expect(await context.port.resolveIdentity({ providerUserId: BOT_USER })).toBeNull();
      expect(await context.port.resolveIdentity({ providerUserId: DEACTIVATED_USER })).toBeNull();
    });

    it('returns null for an account that does not exist', async () => {
      const context = slackReplayContext();
      expect(await context.port.resolveIdentity({ providerUserId: STRANGER_USER })).toBeNull();
    });

    it('reports a missing scope as forbidden, not as "no such user"', async () => {
      // A binding that cannot look up an email cannot map identities at all; reporting it as "no
      // such user" would make every unmapped answer look like a stranger's.
      const context = slackReplayContext();
      await expectIntegrationError(
        () => context.port.resolveIdentity({ email: NO_SCOPE_EMAIL }),
        'forbidden',
      );
    });

    it('asks for nothing when the query is empty', async () => {
      const context = slackReplayContext();
      const before = context.replay.requests.length;
      expect(await context.port.resolveIdentity({})).toBeNull();
      expect(context.replay.requests.length).toBe(before);
    });
  });

  describe('socket mode', () => {
    it('opens the connection with the app-level token and delivers a verified envelope', async () => {
      const opened: string[] = [];
      let received: SocketHandlers | null = null;
      const context = slackReplayContext({
        timer: createVirtualTimer({ autoAdvance: true }),
        connect: (url, handlers) => {
          opened.push(url);
          received = handlers;
          return { send: () => {}, close: () => {} };
        },
      });

      const delivered: WebhookDelivery[] = [];
      const socket = context.slack.socket({
        onDelivery: async (delivery) => {
          delivered.push(delivery);
        },
        maxReconnects: 0,
      });
      await socket.start();

      expect(opened, 'the wss URL came from the recorded apps.connections.open').toEqual([
        'wss://wss-fake.slack.com/link/?ticket=0000-fake&app_id=A0FAKEAPP01',
      ]);
      const open = context.replay.requests.at(-1);
      expect(open?.path).toBe('/apps.connections.open');
      expect(
        open?.headers.authorization,
        'the app-level token opens the socket; the bot token never does',
      ).toBe('Bearer xapp-FAKE-app-token-DO-NOT-USE');

      (received as unknown as SocketHandlers).onMessage(
        JSON.stringify(
          socketEnvelope(
            'env-1',
            'interactive',
            answerClickBody(MAPPED_USER, context.questionId, 'EUR'),
          ),
        ),
      );
      await socket.settled();

      expect(delivered).toHaveLength(1);
      expect(
        context.port.inbound.verify(delivered[0] as WebhookDelivery),
        'a socket delivery goes through the same door as an HTTP one',
      ).toBe(true);
      expect(socket.acked).toEqual(['env-1']);
      await socket.stop();
    });

    it('refuses to open a socket for a binding configured for webhooks', () => {
      const context = slackReplayContext({
        socketMode: false,
        timer: createVirtualTimer(),
        connect: () => ({ send: () => {}, close: () => {} }),
      });
      expect(() => context.slack.socket({ onDelivery: async () => {} })).toThrow(/socket_mode/);
    });
  });
});

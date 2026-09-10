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
  type QuestionPost,
  type ThreadRef,
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
  FAKE_APP_TOKEN,
  FAKE_BOT_TOKEN,
  FAKE_SIGNING_SECRET,
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
import {
  SLACK_PLANTED_SECRET,
  SLACK_QUESTION_ID,
  SLACK_TASK_ID,
  slackPlantedRedactor,
  slackReplayContext,
} from '../support/integrations/slack-harness.js';
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

/**
 * **Slack in replay: every string it emits comes through the redactor** (standing rule 31).
 *
 * WP-11 made `ProviderCreateInput.redactor` required and Slack landed in parallel knowing nothing
 * about it. The merge produced four typecheck errors, all of them in *test* call sites, because a
 * required field is checked where the object is **constructed** and not where it is used: adding
 * `redactor:` to four literals would have made `verify` green with Slack redacting nothing.
 *
 * So the deliverable is not the types, it is this file. The method is Sentry's: plant one obviously
 * fake secret in **every** string the provider can emit, assert each field individually — "no
 * secret anywhere" also passes for an adapter that emits nothing (standing rule 10) — and then
 * assert the secret appears nowhere in the serialised result.
 *
 * The failure branch has its own cases throughout, because WP-07's review found redaction present
 * on a success path and missing on the failure path three times in one file.
 */
describe('Slack in replay: every string it emits comes through the redactor', () => {
  const secret = SLACK_PLANTED_SECRET;
  const placeholder = '[REDACTED:integration:slack]';
  /**
   * A channel of this test's own.
   *
   * The replay serves the **most specific** matching interaction, so a scripted answer keyed on
   * the recorded channel alone would lose to a recorded one that also matches the text — and the
   * assertions below would then be made against the corpus rather than against what this test set
   * up. A channel no fixture names removes the ambiguity.
   */
  const SCRIPT_CHANNEL = 'C0FAKESCRP1';

  const thread = (): ThreadRef => ({
    provider: 'slack',
    channel: SCRIPT_CHANNEL,
    thread_id: THREAD_TS,
    url: null,
  });

  /** A `chat.postMessage` answer for a body the corpus does not record. */
  const posted = (body: unknown): SlackInteraction => ({
    method: 'POST',
    path: '/chat.postMessage',
    match: { channel: SCRIPT_CHANNEL },
    status: 200,
    body,
    source: {
      url: 'https://docs.slack.dev/reference/methods/chat.postMessage',
      retrieved: '2026-09-10',
      kind: 'documented-adapted',
      note: "The page's example response, edited to carry the planted secret; scripted inside the test rather than recorded, because a corpus of documented shapes is not the place for adversarial ones.",
    },
  });

  const okPost = (): SlackInteraction =>
    posted({ ok: true, channel: SCRIPT_CHANNEL, ts: THREAD_TS, message: { text: 'posted' } });

  const question = (options: readonly string[]): QuestionPost => ({
    id: SLACK_QUESTION_ID,
    task_id: SLACK_TASK_ID,
    stage: 'refinement',
    run_id: null,
    text: 'Which currency should totals use?',
    options: [...options],
    blocking: true,
    status: 'open',
    asked_at: '2026-06-01T09:00:00.000Z',
    deadline_at: null,
    reminders_sent: 0,
    answer: null,
    answered_by_user_id: null,
    answered_via: null,
    answered_at: null,
  });

  it('sends no injected secret to Slack, in the fallback text or in any block', async () => {
    const context = slackReplayContext({ redactor: slackPlantedRedactor() });
    context.replay.script(okPost());
    await context.port.postQuestion(
      thread(),
      // The options are a second document: they become button labels and button values.
      question([`EUR ${secret}`, 'CZK']),
      { markdown: `Which currency? token=${secret}` },
    );

    const sent = context.replay.requests.at(-1)?.body as {
      text: string;
      blocks: {
        text?: { text: string };
        elements?: { text?: { text: string }; value?: string }[];
      }[];
    };
    // Field by field: the notification text, the section, the button label, the button value.
    expect(sent.text, 'the fallback a phone shows').toBe(`Which currency? token=${placeholder}`);
    expect(sent.blocks[0]?.text?.text, 'the section a human reads').toBe(
      `Which currency? token=${placeholder}`,
    );
    const button = sent.blocks[1]?.elements?.[0];
    expect(button?.text?.text, 'the button label').toBe(`EUR ${placeholder}`);
    expect(button?.value, 'the button value, which comes back as the answer').toBe(
      JSON.stringify({ q: SLACK_QUESTION_ID, o: `EUR ${placeholder}` }),
    );
    expect(JSON.stringify(sent), 'and nothing else on the wire carries it either').not.toContain(
      secret,
    );
    expect(context.redactions).toContainEqual({ action: 'post_question', count: 2 });
  });

  /**
   * The ordering half, pointed at an outbound path.
   *
   * `questionBlocks` caps a section at 3,000 characters, so a secret straddling that boundary is
   * cut in two — and a redactor applied *after* the cap matches whole values, never prefixes, so
   * the leading bytes of a token would reach the channel and nothing downstream could recover
   * them. Redaction runs before the rendering, so the cut can only ever land inside a placeholder.
   */
  it('redacts before it renders, so a secret straddling a Block Kit limit leaves no fragment', async () => {
    const context = slackReplayContext({ redactor: slackPlantedRedactor() });
    context.replay.script(okPost());
    // 2,990 + 36 characters: `truncate` keeps 2,999 of them, so the cut falls nine characters into
    // the secret. `secret.slice(0, 9)` is exactly the fragment the wrong order leaves behind.
    await context.port.postMessage(thread(), { markdown: `${'x'.repeat(2990)}${secret}` });

    const sent = context.replay.requests.at(-1)?.body as {
      text: string;
      blocks: { text?: { text: string } }[];
    };
    const fragment = secret.slice(0, 9);
    const section = sent.blocks[0]?.text?.text ?? '';
    expect(section, 'the section carries no fragment of the secret').not.toContain(fragment);
    expect(section, 'because the cut landed inside the placeholder').toBe(
      `${'x'.repeat(2990)}[REDACTED…`,
    );
    // The fallback's own limit is 4,000, so the same text is not cut there — and the whole
    // placeholder is what a phone shows.
    expect(sent.text).toBe(`${'x'.repeat(2990)}${placeholder}`);
    expect(sent.text).not.toContain(fragment);
  });

  it('emits no unredacted string from a posted message, field by field', async () => {
    const context = slackReplayContext({ redactor: slackPlantedRedactor() });
    context.replay.script(
      posted({
        ok: true,
        channel: `C0FAKE-${secret}`,
        ts: THREAD_TS,
        message: { text: `posted ${secret}`, ts: THREAD_TS },
      }),
    );
    const opened = await context.port.postTaskThread({
      channel: SCRIPT_CHANNEL,
      taskId: SLACK_TASK_ID,
      body: { markdown: 'Picked up **TASK-1**' },
    });

    // Every field `threadRefSchema` publishes, and where each comes from.
    expect(opened.provider).toBe('slack');
    expect(opened.channel, 'Slack chose the channel it answered with').toBe(
      `C0FAKE-${placeholder}`,
    );
    expect(opened.thread_id, 'the ts is bound by slackTsSchema; see the case below').toBe(
      THREAD_TS,
    );
    expect(opened.url, 'divergence 2: no permalink without a second call').toBeNull();
    expect(JSON.stringify(opened)).not.toContain(secret);

    // The directory that remembers the thread holds the redacted channel too, so a later reply is
    // addressed with what was emitted rather than with a second, raw copy.
    expect(context.slack.threads.threadForTask(SLACK_TASK_ID)?.channel).toBe(
      `C0FAKE-${placeholder}`,
    );
  });

  it('refuses a message id that carries a secret rather than emitting one', async () => {
    // `slackTsSchema` is `^\d{10}\.\d{6}$`, and redaction runs *before* the schema, so a `ts`
    // carrying a secret arrives as a placeholder and fails the parse. Fail closed: an
    // `invalid_response` naming the field, not a thread id with a credential in it.
    const context = slackReplayContext({ redactor: slackPlantedRedactor() });
    context.replay.script(posted({ ok: true, channel: SCRIPT_CHANNEL, ts: `17800000.${secret}` }));
    const error = (await context.port
      .postTaskThread({ channel: SCRIPT_CHANNEL, taskId: SLACK_TASK_ID, body: { markdown: 'x' } })
      .catch((caught: unknown) => caught)) as IntegrationError;
    expect(error.code).toBe('invalid_response');
    expect(String(error.message)).not.toContain(secret);
  });

  it('emits no unredacted string from an identity lookup, field by field', async () => {
    const context = slackReplayContext({ redactor: slackPlantedRedactor() });
    context.replay.script({
      method: 'POST',
      path: '/users.info',
      match: { user: MAPPED_USER },
      status: 200,
      body: {
        ok: true,
        user: {
          id: `U0FAKE-${secret}`,
          team_id: 'T0FAKETEAM1',
          name: `name-${secret}`,
          real_name: `real-${secret}`,
          profile: {
            email: `${secret}@example.test`,
            display_name: `display-${secret}`,
            real_name: `real-${secret}`,
          },
        },
      },
      source: {
        url: 'https://docs.slack.dev/reference/methods/users.info',
        retrieved: '2026-09-10',
        kind: 'documented-adapted',
        note: "The page's example user object with the planted secret in every string; scripted inside the test rather than recorded.",
      },
    });
    const identity = await context.port.resolveIdentity({ providerUserId: MAPPED_USER });

    expect(identity?.provider).toBe('slack');
    expect(identity?.external_id).toBe(`U0FAKE-${placeholder}`);
    expect(identity?.email).toBe(`${placeholder}@example.test`);
    expect(identity?.display_name).toBe(`display-${placeholder}`);
    expect(identity?.verified, 'Slack answered the lookup').toBe(true);
    expect(JSON.stringify(identity)).not.toContain(secret);
  });

  it('emits no unredacted string in the health probe detail', async () => {
    const context = slackReplayContext({ redactor: slackPlantedRedactor() });
    context.replay.script({
      method: 'POST',
      path: '/auth.test',
      status: 200,
      body: {
        ok: true,
        url: 'https://fake-workspace.slack.com/',
        team: `acme ${secret}`,
        user: 'agentic',
        team_id: 'T0FAKETEAM1',
        user_id: 'U0FAKEBOT01',
        bot_id: `B0FAKE-${secret}`,
      },
      source: {
        url: 'https://docs.slack.dev/reference/methods/auth.test',
        retrieved: '2026-09-10',
        kind: 'documented-adapted',
        note: "The page's example response with the planted secret in the team name and the bot id; scripted inside the test rather than recorded.",
      },
    });
    const probe = await context.port.testConnection();

    expect(probe.ok).toBe(true);
    expect(probe.detail).toBe(`Slack workspace acme ${placeholder} as bot B0FAKE-${placeholder}`);
    expect(JSON.stringify(probe)).not.toContain(secret);
  });

  it('emits no unredacted string from a digest, on the wire or in what it returns', async () => {
    const context = slackReplayContext({ redactor: slackPlantedRedactor() });
    context.replay.script(posted({ ok: true, channel: `C0FAKE-${secret}`, ts: THREAD_TS }));
    const ref = await context.port.postDigest(SCRIPT_CHANNEL, [
      {
        task_id: SLACK_TASK_ID,
        title: `TASK-1 ${secret}`,
        url: `https://tickets.example.test/${secret}`,
        state: `blocked ${secret}`,
        detail: `waiting on ${secret}`,
      },
    ]);

    const sent = context.replay.requests.at(-1)?.body as { text: string; blocks: unknown };
    const blocks = JSON.stringify(sent.blocks);
    // Every field of a digest line is untrusted text from a ticket or a merge request.
    expect(blocks).toContain(`TASK-1 ${placeholder}`);
    expect(blocks).toContain(`https://tickets.example.test/${placeholder}`);
    expect(blocks).toContain(`blocked ${placeholder}`);
    expect(blocks).toContain(`waiting on ${placeholder}`);
    expect(JSON.stringify(sent), 'nothing the digest sends carries it').not.toContain(secret);
    expect(ref.channel, 'nor what it returns').toBe(`C0FAKE-${placeholder}`);
    expect(JSON.stringify(ref)).not.toContain(secret);
  });

  /**
   * The failure branch. Slack answers `200 {ok: false, error: "…"}` for most failures, and the
   * adapter quotes that slug into an `IntegrationError` whose message becomes a log line and an
   * `integration_actions` row.
   */
  it('emits no unredacted string when the call fails', async () => {
    const context = slackReplayContext({ redactor: slackPlantedRedactor() });
    context.replay.script(posted({ ok: false, error: `boom_${secret}` }));
    const error = (await context.port
      .postMessage(thread(), { markdown: `posting ${secret}` })
      .catch((caught: unknown) => caught)) as IntegrationError;

    expect(error.code, 'an unclassified slug is invalid_request and not retryable').toBe(
      'invalid_request',
    );
    expect(error.message).toContain(placeholder);
    expect(error.message, 'the failure branch reads the same redacted document').not.toContain(
      secret,
    );
    expect(
      JSON.stringify({ message: error.message, action: error.action, code: error.code }),
    ).not.toContain(secret);
  });

  /**
   * Inbound: the direction that writes to a table nobody can rewrite (BD-003).
   *
   * A thread reply becomes `feedback.received` and its text goes to `events.payload` — the first
   * row on TD-012's list of writes that must be redacted first.
   */
  it('emits no unredacted string from a delivery it normalises', async () => {
    const context = slackReplayContext({ redactor: slackPlantedRedactor() });
    const delivery = context.emitFeedback(MAPPED_USER, `is my token ${secret} right?`);
    const result = await context.port.inbound.normalise(delivery, {
      projectId: context.projectId,
      integrationId: context.integrationId,
      resolveUser: () => null,
    });

    const { feedback } = (result.events[0] as { payload: { feedback: { text: string } } }).payload;
    expect(feedback.text).toBe(`is my token ${placeholder} right?`);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

/**
 * The other half of rule 31, and the reason `composeSecretRedactors` exists.
 *
 * A composition root may legitimately pass `noSecretsRedactor()` — "this binding injected nothing"
 * — and the adapter still knows three credentials nobody else has to remember to tell it. Each
 * case below plants **one** of them on a path that credential can actually take, so a mutation
 * that drops the wrapping fails by name rather than by a bulk "no secret anywhere".
 */
describe("the binding composes its own three credentials on top of the caller's redactor", () => {
  it("redacts the bot token when the caller's redactor knows nothing about it", async () => {
    // A Slack error body "echoes the request" (`http.ts`), and the request was authenticated with
    // this token; an operator pasting it into the channel is the other route to the same string.
    const context = slackReplayContext();
    context.replay.script({
      method: 'POST',
      path: '/auth.test',
      status: 200,
      body: {
        ok: true,
        url: 'https://fake-workspace.slack.com/',
        team: `acme ${FAKE_BOT_TOKEN}`,
        team_id: 'T0FAKETEAM1',
        user_id: 'U0FAKEBOT01',
        bot_id: 'B0FAKEBOT01',
      },
      source: {
        url: 'https://docs.slack.dev/reference/methods/auth.test',
        retrieved: '2026-09-10',
        kind: 'documented-adapted',
        note: "The page's example response with the binding's own bot token in the team name; scripted inside the test rather than recorded.",
      },
    });
    const probe = await context.port.testConnection();
    expect(probe.detail).toBe(
      'Slack workspace acme [REDACTED:integration:slack_bot_token] as bot B0FAKEBOT01',
    );
    expect(probe.detail).not.toContain(FAKE_BOT_TOKEN);
  });

  it("redacts the app-level token when the caller's redactor knows nothing about it", async () => {
    // `apps.connections.open` answers a `wss://` URL that this adapter hands to the connector; a
    // ticket that echoed the app token would put it in the string that opens the socket.
    const opened: string[] = [];
    const context = slackReplayContext({
      timer: createVirtualTimer({ autoAdvance: true }),
      connect: (url) => {
        opened.push(url);
        return { send: () => {}, close: () => {} };
      },
    });
    context.replay.script({
      method: 'POST',
      path: '/apps.connections.open',
      status: 200,
      body: { ok: true, url: `wss://wss-fake.slack.com/link/?ticket=${FAKE_APP_TOKEN}` },
      source: {
        url: 'https://docs.slack.dev/reference/methods/apps.connections.open',
        retrieved: '2026-09-10',
        kind: 'documented-adapted',
        note: "The page's example response with the binding's own app-level token in the ticket; scripted inside the test rather than recorded.",
      },
    });
    const socket = context.slack.socket({ onDelivery: async () => {}, maxReconnects: 0 });
    await socket.start();

    expect(opened).toEqual([
      'wss://wss-fake.slack.com/link/?ticket=[REDACTED:integration:slack_app_token]',
    ]);
    await socket.stop();
  });

  it("redacts the signing secret when the caller's redactor knows nothing about it", async () => {
    // The credential an operator is most likely to paste into the channel while setting the app
    // up — and a thread reply is written to `events.payload`, which is append-only (BD-003).
    const context = slackReplayContext();
    const delivery = context.emitFeedback(MAPPED_USER, `is ${FAKE_SIGNING_SECRET} the right one?`);
    const result = await context.port.inbound.normalise(delivery, {
      projectId: context.projectId,
      integrationId: context.integrationId,
      resolveUser: () => null,
    });

    const { feedback } = (result.events[0] as { payload: { feedback: { text: string } } }).payload;
    expect(feedback.text).toBe('is [REDACTED:integration:slack_signing_secret] the right one?');
    expect(JSON.stringify(result)).not.toContain(FAKE_SIGNING_SECRET);
  });
});

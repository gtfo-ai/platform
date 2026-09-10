/**
 * Slack deliveries → catalogue events, with the identity rule asserted from both sides.
 *
 * Every "the answer was refused" case here is paired with the same delivery from a *mapped* author
 * producing exactly one event, because "no event was produced" also passes against a harness that
 * delivered nothing (standing rule 4).
 */
import {
  type ExternalIdentity,
  exactSecretRedactor,
  type InboundContext,
  noSecretsRedactor,
} from '@platform/application';
import { fixedClock, sequentialIds } from '@platform/domain';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ANSWER_ACTION_ID,
  APPROVE_ACTION_ID,
  approvalBlockId,
  questionBlockId,
  REJECT_ACTION_ID,
} from './blocks.js';
import { normaliseSlackDelivery, type SlackInboundDeps } from './inbound.js';
import { createMemoryThreadDirectory } from './threads.js';

const PROJECT_ID = '00000000-0000-4000-8000-0000000000b7';
const INTEGRATION_ID = '00000000-0000-4000-8000-0000000000a7';
const TASK_ID = '00000000-0000-4000-8000-0000000000c7';
const QUESTION_ID = '00000000-0000-4000-8000-0000000000d7';
const APPROVAL_ID = '00000000-0000-4000-8000-0000000000e7';
const USER_ID = '00000000-0000-4000-8000-0000000000f7';

const CHANNEL = 'C0FAKECHAN1';
const THREAD_TS = '1780000000.000100';
const MAPPED = 'U0FAKEDEV01';
const STRANGER = 'U0FAKESTRA1';
const BOT_USER = 'U0FAKEBOT01';
const TEAM = 'T0FAKETEAM1';

let deps: SlackInboundDeps;

beforeEach(() => {
  const threads = createMemoryThreadDirectory();
  threads.rememberThread(TASK_ID, { channel: CHANNEL, threadTs: THREAD_TS });
  deps = {
    threads,
    teamId: TEAM,
    botUserId: BOT_USER,
    ids: sequentialIds(1),
    clock: fixedClock('2026-06-01T09:00:00.000Z'),
    maxBodyBytes: 262_144,
    // Required, never defaulted (standing rule 31): a case that does not care still says which
    // redactor it means. The cases that do care replace it.
    redactor: noSecretsRedactor(),
  };
});

const context = (mapped: boolean): InboundContext => ({
  projectId: PROJECT_ID,
  integrationId: INTEGRATION_ID,
  resolveUser: (identity: ExternalIdentity) =>
    mapped && identity.external_id === MAPPED ? USER_ID : null,
});

const deliver = (payload: unknown) =>
  normaliseSlackDelivery({ headers: {}, body: JSON.stringify(payload) }, context(true), deps);

const deliverAs = (payload: unknown, mapped: boolean) =>
  normaliseSlackDelivery({ headers: {}, body: JSON.stringify(payload) }, context(mapped), deps);

const answerClick = (author: string, option = 'EUR') => ({
  type: 'block_actions',
  team: { id: TEAM, domain: 'example' },
  user: { id: author, username: 'dev', team_id: TEAM },
  api_app_id: 'A0FAKEAPP01',
  container: {
    type: 'message',
    message_ts: '1780000001.000200',
    thread_ts: THREAD_TS,
    channel_id: CHANNEL,
  },
  channel: { id: CHANNEL, name: 'agentic' },
  message: { ts: '1780000001.000200', thread_ts: THREAD_TS, text: 'Which currency?' },
  actions: [
    {
      action_id: ANSWER_ACTION_ID,
      block_id: questionBlockId(QUESTION_ID),
      value: JSON.stringify({ q: QUESTION_ID, o: option }),
      type: 'button',
      action_ts: '1780000002.000300',
      text: { type: 'plain_text', text: option },
    },
  ],
});

const approvalClick = (author: string, approve: boolean) => ({
  type: 'block_actions',
  team: { id: TEAM },
  user: { id: author, team_id: TEAM },
  container: {
    type: 'message',
    message_ts: '1780000003.000400',
    thread_ts: THREAD_TS,
    channel_id: CHANNEL,
  },
  channel: { id: CHANNEL },
  actions: [
    {
      action_id: approve ? APPROVE_ACTION_ID : REJECT_ACTION_ID,
      block_id: approvalBlockId(APPROVAL_ID),
      value: JSON.stringify({ a: APPROVAL_ID, d: approve ? 'approved' : 'rejected' }),
      type: 'button',
      action_ts: '1780000004.000500',
    },
  ],
});

const threadReply = (author: string, text: string, overrides: Record<string, unknown> = {}) => ({
  type: 'event_callback',
  team_id: TEAM,
  api_app_id: 'A0FAKEAPP01',
  event_id: 'Ev0FAKE0001',
  event_time: 1_780_000_005,
  event: {
    type: 'message',
    channel: CHANNEL,
    user: author,
    text,
    ts: '1780000005.000600',
    thread_ts: THREAD_TS,
    channel_type: 'channel',
    ...overrides,
  },
});

describe('button answers (BD-006, Q10)', () => {
  it('turns a mapped user click into exactly one task.question.answered', async () => {
    const result = await deliver(answerClick(MAPPED));
    expect(result.ignored).toEqual([]);
    expect(result.events).toHaveLength(1);
    const [event] = result.events;
    expect(event?.type).toBe('task.question.answered');
    expect(event?.payload).toMatchObject({
      task_id: TASK_ID,
      question_id: QUESTION_ID,
      answer: 'EUR',
      answered_by_user_id: USER_ID,
      channel: 'slack',
    });
    expect(event?.actor).toEqual({
      kind: 'user',
      user_id: USER_ID,
      identity: {
        provider: 'slack',
        external_id: MAPPED,
        email: null,
        display_name: null,
        verified: true,
      },
    });
  });

  it('refuses an unmapped user, and the mapped control still produces the event', async () => {
    const mapped = await deliver(answerClick(MAPPED));
    expect(mapped.events, 'control: a mapped user is answered').toHaveLength(1);

    const stranger = await deliver(answerClick(STRANGER));
    expect(stranger.events).toEqual([]);
    expect(stranger.ignored).toHaveLength(1);
    expect(stranger.ignored[0]?.reason).toBe('unmapped_identity');
  });

  it('refuses every click when nothing is mapped, control included', async () => {
    // The other direction of the same guard: `resolveUser` returning null for everybody.
    const nobody = await deliverAs(answerClick(MAPPED), false);
    expect(nobody.ignored[0]?.reason).toBe('unmapped_identity');
  });

  it('identifies the author by the Slack user id and nothing forgeable', async () => {
    const seen: ExternalIdentity[] = [];
    await normaliseSlackDelivery(
      { headers: {}, body: JSON.stringify(answerClick(MAPPED)) },
      {
        projectId: PROJECT_ID,
        integrationId: INTEGRATION_ID,
        resolveUser: (identity) => {
          seen.push(identity);
          return USER_ID;
        },
      },
      deps,
    );
    expect(seen).toHaveLength(1);
    // No email and no display name: a payload's text fields are typed by whoever sent them.
    expect(seen[0]).toEqual({
      provider: 'slack',
      external_id: MAPPED,
      email: null,
      display_name: null,
      verified: false,
    });
  });

  it('ignores a button this adapter did not post', async () => {
    const foreign = answerClick(MAPPED);
    const result = await deliver({
      ...foreign,
      actions: [{ ...foreign.actions[0], block_id: 'someone-elses-block' }],
    });
    expect(result.events).toEqual([]);
    expect(result.ignored[0]?.reason).toBe('unsupported_event');
  });

  it('ignores a value it did not write', async () => {
    const forged = answerClick(MAPPED);
    const result = await deliver({
      ...forged,
      actions: [{ ...forged.actions[0], value: JSON.stringify({ q: QUESTION_ID, o: '' }) }],
    });
    expect(result.events).toEqual([]);
    expect(result.ignored[0]?.reason).toBe('malformed_payload');
  });

  it('ignores a value naming a different question than the block it sat in', async () => {
    const forged = answerClick(MAPPED);
    const result = await deliver({
      ...forged,
      actions: [
        {
          ...forged.actions[0],
          value: JSON.stringify({ q: '00000000-0000-4000-8000-0000000000ff', o: 'EUR' }),
        },
      ],
    });
    expect(result.ignored[0]?.reason).toBe('malformed_payload');
  });

  it('ignores a click on a thread this binding never opened', async () => {
    const elsewhere = answerClick(MAPPED);
    const result = await deliver({
      ...elsewhere,
      channel: { id: 'C0FAKEOTHER' },
      container: { ...elsewhere.container, channel_id: 'C0FAKEOTHER' },
    });
    expect(result.events).toEqual([]);
    expect(result.ignored[0]?.reason).toBe('unsupported_event');
  });

  it('ignores an interaction from another workspace', async () => {
    const result = await deliver({ ...answerClick(MAPPED), team: { id: 'T0FAKEOTHER' } });
    expect(result.ignored[0]?.reason).toBe('not_for_this_project');
  });
});

/**
 * The workspace guard, from both sides (WP-10 review round 1 note).
 *
 * `config.team_id` is `nullish` and absent means "any workspace"; when it *is* configured, a
 * payload that simply omits the field must not pass. Standing rule 16: a guard against an
 * untrusted producer must not read a field that producer can omit, because a missing team is not
 * a matching team.
 */
describe('the workspace guard when the team is absent', () => {
  const withoutTeam = <T extends Record<string, unknown>>(payload: T, ...keys: string[]) => {
    const copy: Record<string, unknown> = { ...payload };
    for (const key of keys) {
      delete copy[key];
    }
    return copy;
  };

  it('refuses an interaction carrying no team at all', async () => {
    const click = answerClick(MAPPED);
    const result = await deliver({
      ...withoutTeam(click, 'team'),
      user: { id: MAPPED, username: 'dev' },
    });
    expect(result.events, 'a decision from an unnamed workspace is not a decision').toEqual([]);
    expect(result.ignored[0]?.reason).toBe('not_for_this_project');
  });

  it('refuses a message event carrying no team_id', async () => {
    const result = await deliver(withoutTeam(threadReply(MAPPED, 'the answer'), 'team_id'));
    expect(result.events).toEqual([]);
    expect(result.ignored[0]?.reason).toBe('not_for_this_project');
  });

  it('admits both when the binding names no workspace, which means any', async () => {
    // The control (standing rule 4): the same two payloads with `teamId: null` produce events, so
    // the refusals above are the guard firing rather than a delivery that never arrived.
    deps = { ...deps, teamId: null };
    const click = await deliver({
      ...withoutTeam(answerClick(MAPPED), 'team'),
      user: { id: MAPPED, username: 'dev' },
    });
    expect(click.events.map((event) => event.type)).toEqual(['task.question.answered']);
    const reply = await deliver(withoutTeam(threadReply(MAPPED, 'the answer'), 'team_id'));
    expect(reply.events.map((event) => event.type)).toEqual(['feedback.received']);
  });

  it('still admits an interaction whose team is only on the user', async () => {
    // Slack puts the workspace on `team` for a `block_actions` payload; `user.team_id` is the
    // fallback the normaliser already read, and dropping it would refuse a legitimate click.
    const result = await deliver(withoutTeam(answerClick(MAPPED), 'team'));
    expect(result.events.map((event) => event.type)).toEqual(['task.question.answered']);
  });
});

describe('approval decisions', () => {
  it('turns Approve and Request changes into task.approval.decided', async () => {
    const approved = await deliver(approvalClick(MAPPED, true));
    expect(approved.events[0]?.type).toBe('task.approval.decided');
    expect(approved.events[0]?.payload).toMatchObject({
      approval_id: APPROVAL_ID,
      decision: 'approved',
      decided_by_user_id: USER_ID,
    });

    const rejected = await deliver(approvalClick(MAPPED, false));
    expect(rejected.events[0]?.payload).toMatchObject({ decision: 'rejected' });
  });

  it('refuses an approval from an unmapped user, control included', async () => {
    expect((await deliver(approvalClick(MAPPED, true))).events, 'control').toHaveLength(1);
    const stranger = await deliver(approvalClick(STRANGER, true));
    expect(stranger.events).toEqual([]);
    expect(stranger.ignored[0]?.reason).toBe('unmapped_identity');
  });

  it('refuses a payload whose button and value disagree', async () => {
    const tampered = approvalClick(MAPPED, true);
    const result = await deliver({
      ...tampered,
      actions: [
        { ...tampered.actions[0], value: JSON.stringify({ a: APPROVAL_ID, d: 'rejected' }) },
      ],
    });
    expect(result.events).toEqual([]);
    expect(result.ignored[0]?.reason).toBe('malformed_payload');
  });
});

describe('threaded replies', () => {
  it('answers the open question when one was posted in the thread', async () => {
    deps.threads.rememberQuestion({ channel: CHANNEL, threadTs: THREAD_TS }, QUESTION_ID);
    const result = await deliver(threadReply(MAPPED, 'use EUR everywhere'));
    expect(result.ignored).toEqual([]);
    expect(result.events[0]?.type).toBe('task.question.answered');
    expect(result.events[0]?.payload).toMatchObject({
      question_id: QUESTION_ID,
      answer: 'use EUR everywhere',
      answered_by_user_id: USER_ID,
    });
  });

  it('refuses an unmapped reply to an open question, control included', async () => {
    deps.threads.rememberQuestion({ channel: CHANNEL, threadTs: THREAD_TS }, QUESTION_ID);
    expect((await deliver(threadReply(MAPPED, 'EUR'))).events, 'control').toHaveLength(1);
    const stranger = await deliver(threadReply(STRANGER, 'CZK'));
    expect(stranger.events).toEqual([]);
    expect(stranger.ignored[0]?.reason).toBe('unmapped_identity');
  });

  it('records a reply with no open question as feedback, unmapped author and all', async () => {
    const result = await deliver(threadReply(STRANGER, 'the MR description was unclear'));
    expect(result.ignored).toEqual([]);
    const [event] = result.events;
    expect(event?.type).toBe('feedback.received');
    const { feedback } = (event as NonNullable<typeof event>).payload as {
      feedback: Record<string, unknown>;
    };
    expect(feedback).toMatchObject({
      task_id: TASK_ID,
      author_user_id: null,
      scope: 'task',
      text: 'the MR description was unclear',
      source_channel: 'slack',
    });
    expect((feedback.author_identity as ExternalIdentity).verified).toBe(false);
    expect(event?.actor).toMatchObject({ kind: 'integration', provider: 'slack' });
  });

  it('never reads its own writing', async () => {
    for (const [name, payload] of [
      ['bot_id', threadReply(BOT_USER, 'hi', { bot_id: 'B0FAKEBOT1', user: undefined })],
      ['the bot user id', threadReply(BOT_USER, 'hi')],
      ['an app id', threadReply(MAPPED, 'hi', { app_id: 'A0FAKEAPP01' })],
      ['an edit', threadReply(MAPPED, 'hi', { subtype: 'message_changed' })],
    ] as const) {
      const result = await deliver(payload);
      expect(result.events, `${name} must not produce an event`).toEqual([]);
      expect(result.ignored[0]?.reason).toBe('unsupported_event');
    }
  });

  it('ignores a top-level channel message and a reply in an unknown thread', async () => {
    const topLevel = await deliver(threadReply(MAPPED, 'hello', { thread_ts: undefined }));
    expect(topLevel.ignored[0]?.reason).toBe('unsupported_event');
    const unknown = await deliver(threadReply(MAPPED, 'hello', { thread_ts: '1799999999.999999' }));
    expect(unknown.ignored[0]?.reason).toBe('unsupported_event');
  });

  it('ignores a thread parent that is its own reply', async () => {
    const parent = await deliver(
      threadReply(MAPPED, 'hello', { ts: THREAD_TS, thread_ts: THREAD_TS }),
    );
    expect(parent.ignored[0]?.reason).toBe('unsupported_event');
  });

  it('ignores an empty message and one from another workspace', async () => {
    expect((await deliver(threadReply(MAPPED, '   '))).ignored[0]?.reason).toBe(
      'malformed_payload',
    );
    const other = await normaliseSlackDelivery(
      {
        headers: {},
        body: JSON.stringify({ ...threadReply(MAPPED, 'x'), team_id: 'T0FAKEOTHER' }),
      },
      context(true),
      deps,
    );
    expect(other.ignored[0]?.reason).toBe('not_for_this_project');
  });
});

describe('fail open on an inbound notification (standing rule 20)', () => {
  it('ignores every shape it does not understand instead of throwing', async () => {
    const shapes: [string, unknown][] = [
      ['url_verification', { type: 'url_verification', challenge: 'abc' }],
      ['a view submission', { type: 'view_submission', view: {} }],
      ['a slash command', { type: 'shortcut', callback_id: 'x' }],
      [
        'an event type Slack ships next',
        { ...threadReply(MAPPED, 'x'), event: { type: 'huddle_started' } },
      ],
      ['no type at all', { hello: 'world' }],
      ['an array', []],
      ['null', null],
    ];
    for (const [name, payload] of shapes) {
      const result = await deliver(payload);
      expect(result.events, name).toEqual([]);
      expect(result.ignored.length, name).toBe(1);
      expect(['unsupported_event', 'malformed_payload'], name).toContain(result.ignored[0]?.reason);
    }
  });

  it('ignores a body that is not JSON, and one that is too large', async () => {
    const notJson = await normaliseSlackDelivery(
      { headers: {}, body: 'not json at all' },
      context(true),
      deps,
    );
    expect(notJson.ignored[0]?.reason).toBe('malformed_payload');

    const huge = await normaliseSlackDelivery(
      { headers: {}, body: JSON.stringify({ type: 'event_callback', pad: 'x'.repeat(300_000) }) },
      context(true),
      deps,
    );
    expect(huge.ignored[0]?.reason).toBe('malformed_payload');
    expect(huge.ignored[0]?.detail).toContain('bytes');
  });

  it('bounds the provider text it puts in a reason', async () => {
    const result = await deliver({ type: 'x'.repeat(500) });
    expect(result.ignored[0]?.detail.length).toBeLessThan(120);
  });
});

/**
 * TD-012 in the direction that writes to an append-only table.
 *
 * A thread reply becomes `feedback.received` and a click becomes `task.question.answered`; both
 * payloads are written to `events.payload`, which cannot be rewritten afterwards (BD-003). The
 * realistic source is an operator pasting a credential into the channel while setting the app up.
 *
 * The `ignored.detail` case is the failure branch, and it is here for the reason WP-07's review
 * gave: redaction present on the success path and missing on the failure path was found three
 * times in one file.
 */
describe('a delivery is redacted before any branch reads it (standing rule 31)', () => {
  const PLANTED = 'FAKE-injected-secret-value-0123456789';
  const PLACEHOLDER = '[REDACTED:integration:planted]';

  beforeEach(() => {
    deps = { ...deps, redactor: exactSecretRedactor([{ name: 'planted', value: PLANTED }]) };
  });

  it('redacts the text of a feedback reply', async () => {
    const result = await deliver(threadReply(MAPPED, `is my token ${PLANTED} right?`));
    const { feedback } = (result.events[0] as { payload: { feedback: { text: string } } }).payload;
    expect(feedback.text).toBe(`is my token ${PLACEHOLDER} right?`);
    expect(JSON.stringify(result), 'and nowhere else on the delivery either').not.toContain(
      PLANTED,
    );
  });

  it('redacts an answer, whether it arrives as a button value or as a reply', async () => {
    deps.threads.rememberQuestion({ channel: CHANNEL, threadTs: THREAD_TS }, QUESTION_ID);
    const clicked = await deliver(answerClick(MAPPED, `option ${PLANTED}`));
    const clickedAnswer = clicked.events[0]?.payload as { answer: string } | undefined;
    expect(clickedAnswer?.answer).toBe(`option ${PLACEHOLDER}`);
    const replied = await deliver(threadReply(MAPPED, `use ${PLANTED}`));
    const repliedAnswer = replied.events[0]?.payload as { answer: string } | undefined;
    expect(repliedAnswer?.answer).toBe(`use ${PLACEHOLDER}`);
    expect(JSON.stringify([clicked, replied])).not.toContain(PLANTED);
  });

  it('redacts the provider text it quotes into an ignored reason (the failure branch)', async () => {
    const result = await deliver({ type: `unknown-${PLANTED}` });
    expect(result.events).toEqual([]);
    expect(result.ignored[0]?.detail).toContain(PLACEHOLDER);
    expect(result.ignored[0]?.detail).not.toContain(PLANTED);
  });

  it('reports the count and never the text', async () => {
    const reported: { action: string; count: number }[] = [];
    deps = {
      ...deps,
      onRedaction: (event) => {
        reported.push({ ...event });
      },
    };
    await deliver(threadReply(MAPPED, `${PLANTED} and ${PLANTED}`));
    expect(reported).toEqual([{ action: 'normalise_delivery', count: 2 }]);
    await deliver(threadReply(MAPPED, 'nothing to see'));
    expect(reported, 'a count of 0 is not an event').toHaveLength(1);
  });
});

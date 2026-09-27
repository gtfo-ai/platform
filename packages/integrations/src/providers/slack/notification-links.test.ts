/**
 * **A model-written link reaches Slack without its label** (WP-65, PROGRESS backlog 215) — driven
 * from the text a model produces to the bytes the Slack adapter sends.
 *
 * The path is five pieces in three packages, and each was already right on its own: a reviewer
 * model's summary becomes the first line of a return reason (`verdictReturnReason`, WP-55), that
 * first line becomes a notification's detail (`decideNotification`, WP-46), the detail is rendered
 * into the message (`notificationDraft` → `notificationBody`), and the adapter converts markdown to
 * `mrkdwn` (`toMrkdwn`) — which turns `[Approve](https://attacker.example)` into
 * `<https://attacker.example|Approve>`, a link labelled *Approve* under the platform's bot identity.
 * Mentions were already inert; the label was not. This file runs the whole chain, because the
 * defect lived **between** the pieces and no single one of their tests could see it.
 */
import {
  decideNotification,
  noSecretsRedactor,
  notificationBody,
  notificationDraft,
  verdictReturnReason,
} from '@platform/application';
import type { DomainEvent, JsonObject } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { fixedClock, sequentialIds } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import type { SlackFetch } from './http.js';
import { createSlackRegistration } from './index.js';

const INTEGRATION_ID = '00000000-0000-4000-8000-0000000000a6';
const PROJECT = '00000000-0000-4000-8000-0000000000b6';
const TASK = '00000000-0000-4000-8000-0000000000c6';
const TICKET_URL = 'https://tickets.example.test/browse/ACME-1';

/** What a steered reviewer model might write — a labelled link and a broadcast. */
const HOSTILE = '[Approve](https://attacker.example/merge) <!channel>';

/** A Slack that answers every `chat.postMessage` and keeps the request bodies it was sent. */
const recordingSlack = (): { readonly fetch: SlackFetch; readonly sent: string[] } => {
  const sent: string[] = [];
  const fetch: SlackFetch = async (url, init) => {
    sent.push(init.body ?? '');
    const ok = url.endsWith('chat.postMessage')
      ? { ok: true, channel: 'C0FAKECHAN1', ts: '1700000000.000100' }
      : { ok: true };
    return new Response(JSON.stringify(ok), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch, sent };
};

const slackPort = (fetch: SlackFetch) =>
  createSlackRegistration({
    clock: fixedClock('2026-06-01T09:00:00.000Z'),
    fetch,
    ids: sequentialIds(1),
  }).create({
    integrationId: INTEGRATION_ID,
    config: { channel: 'C0FAKECHAN1', team_id: 'T0FAKETEAM1' },
    secrets: {
      bot_token: 'xoxb-FAKE-bot-token-DO-NOT-USE',
      app_token: 'xapp-FAKE-app-token-DO-NOT-USE',
      signing_secret: 'fake-slack-signing-secret-do-not-use',
    },
    redactor: noSecretsRedactor(),
  });

const event = (type: 'task.stage.returned' | 'task.escalated', payload: JsonObject): DomainEvent =>
  domainEventSchemasByType[type].parse({
    id: '00000000-0000-4000-9000-00000000cc06',
    stream_type: 'task',
    stream_id: TASK,
    stream_seq: 2,
    correlation_id: null,
    cause_event_id: null,
    actor: { kind: 'system', component: 'pipeline' },
    occurred_at: '2026-06-01T09:00:00.000Z',
    type,
    payload: { project_id: PROJECT, task_id: TASK, ...payload },
  }) as DomainEvent;

/** The chain: event → decided detail → draft → body → the Slack adapter's request. */
const posted = async (domainEvent: DomainEvent): Promise<string> => {
  const decided = decideNotification(domainEvent);
  expect(decided, 'the band notifies about this event').not.toBeNull();
  const draft = notificationDraft({
    notificationClass: decided?.notificationClass ?? 'escalation',
    subject: { name: 'ACME-1', url: TICKET_URL },
    detail: decided?.detail ?? null,
  });
  const slack = recordingSlack();
  await slackPort(slack.fetch).postMessage(
    { provider: 'slack', channel: 'C0FAKECHAN1', thread_id: '1700000000.000001', url: null },
    notificationBody(draft),
  );
  const body = slack.sent.at(-1);
  expect(body, 'the adapter sent a request').toBeDefined();
  return body as string;
};

/** Every string the Slack request carries, blocks included, as one searchable text. */
const everyString = (body: string): string => JSON.stringify(JSON.parse(body));

describe('a model-written link in a notification, down to the Slack request', () => {
  it('posts a reviewer model’s labelled link as the bare URL, and its broadcast inert', async () => {
    const reason = verdictReturnReason('ReviewVerdict', {
      verdict: 'changes_requested',
      summary: HOSTILE,
      findings: [{ severity: 'major', file: 'src/a.ts', line: 3, explanation: 'x' }],
    });
    expect(reason?.split('\n')[0]).toBe(`[summary] ${HOSTILE}`);
    const sent = everyString(
      await posted(
        event('task.stage.returned', {
          from_stage: 'review',
          to_stage: 'implementation',
          reason: reason ?? '',
          iteration: 1,
        }),
      ),
    );

    expect(sent, 'no Slack link with the model’s label').not.toContain('|Approve>');
    expect(sent).not.toContain('[Approve]');
    expect(sent, 'the target is still shown, as itself').toContain(
      'https://attacker.example/merge',
    );
    expect(sent, 'the broadcast is displayed, not fired').not.toContain('<!channel>');
    expect(sent).toContain('&lt;!channel&gt;');
  });

  it('does the same for a blocker brief', async () => {
    const sent = everyString(
      await posted(
        event('task.escalated', {
          reason: 'the review loop is spent',
          blocker_brief: `Needs a human. ${HOSTILE}`,
        }),
      ),
    );
    expect(sent).not.toContain('|Approve>');
    expect(sent).toContain('https://attacker.example/merge');
    expect(sent).not.toContain('<!channel>');
  });

  it('keeps the platform’s own link — the ticket URL — as a link', async () => {
    const sent = everyString(
      await posted(
        event('task.escalated', { reason: 'r', blocker_brief: 'Nothing hostile here.' }),
      ),
    );
    expect(sent).toContain(TICKET_URL);
  });
});

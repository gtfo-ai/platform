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
  approvalRequestBody,
  decideNotification,
  noSecretsRedactor,
  notificationBody,
  notificationDraft,
  planSummaryOf,
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

/**
 * **Two harmless items, one link** (review of PR #82, BD-022). Each untrusted item was unlabelled
 * on its own, but Slack's link pattern lets a label span the `, ` and the newline the platform
 * joins items with, so `["[Approve safely", "](https://evil.example/approve)"]` reached the channel
 * as `<https://evil.example/approve|Approve safely, >` beside the real Approve button. Every case
 * here is driven down to the request the adapter sends, and asserts the model's label is a link
 * label **nowhere** in it — the `text` fallback and every block.
 */
describe('a link built across the items the platform joins, down to the Slack request', () => {
  const EVIL = 'https://evil.example/approve';
  /** A Slack link to the attacker's host that carries a label: `<https://evil.example…|…>`. */
  const LABELLED_EVIL = /<https:\/\/evil\.example[^>|]*\|/;
  const THREAD = {
    provider: 'slack',
    channel: 'C0FAKECHAN1',
    thread_id: '1700000000.000001',
    url: null,
  } as const;
  const APPROVAL = {
    id: '00000000-0000-4000-8000-0000000000d6',
    task_id: TASK,
    kind: 'plan',
    status: 'pending',
    requested_at: '2026-06-01T09:00:00.000Z',
    deadline_at: null,
    decided_by_user_id: null,
    decided_at: null,
    reason: null,
    subject_artifact_id: '00000000-0000-4000-8000-0000000000f6',
    review_url: `https://agentic.example.test/tasks/${TASK}`,
  } as const;
  const PLAN = {
    approach: 'Sum the lines.',
    alternatives_considered: [],
    affected_modules: ['invoices'],
    files_to_change: [{ path: 'src/totals.ts', change: 'add the sum' }],
    data_changes: [],
    api_changes: [],
    validation_contract: [],
    test_plan: [],
    rollout_notes: 'none',
    risks: [],
    estimated_size: 'M',
    decisions_to_record: [],
    protected_path_changes: [],
  };

  const postedApproval = async (plan: Record<string, unknown>, classes: string[]) => {
    const summary = planSummaryOf(1, plan as never);
    expect(summary, 'the fixture reads as a plan').not.toBeNull();
    const body = approvalRequestBody({
      draft: notificationDraft({
        notificationClass: 'approval',
        subject: { name: 'ACME-1', url: TICKET_URL },
        detail: null,
      }),
      kind: 'plan',
      plan: summary === null ? null : { kind: 'shown', artifactId: APPROVAL.id, summary },
      reasons: [{ code: 'risk_class', classes }],
      reviewUrl: APPROVAL.review_url,
    });
    const slack = recordingSlack();
    await slackPort(slack.fetch).postApproval(THREAD, APPROVAL, body);
    return everyString(slack.sent.at(-1) ?? '{}');
  };

  it('two file paths that make one link when joined with a comma', async () => {
    const sent = await postedApproval(
      {
        ...PLAN,
        files_to_change: [
          { path: '[Approve safely', change: 'x' },
          { path: '](https://evil.example/approve)', change: 'x' },
        ],
      },
      ['payments'],
    );
    expect(sent).not.toMatch(LABELLED_EVIL);
    expect(sent).not.toContain('|Approve safely');
    expect(sent, 'the target is still shown, as itself').toContain(EVIL);
  });

  it('a risk split across two lines', async () => {
    const sent = await postedApproval(
      {
        ...PLAN,
        risks: ['Low risk, [Approve now', '](https://evil.example/approve) nothing else'],
      },
      ['payments'],
    );
    expect(sent).not.toMatch(LABELLED_EVIL);
    expect(sent).not.toContain('|Approve now');
  });

  it('two risk class names joined into one reason', async () => {
    const sent = await postedApproval(PLAN, ['[Approve safely', '](https://evil.example/approve)']);
    expect(sent).not.toMatch(LABELLED_EVIL);
    expect(sent).not.toContain('|Approve safely');
  });

  it('a ticket key and a detail, or a detail and a ticket URL, in a plain notification', async () => {
    for (const draft of [
      notificationDraft({
        notificationClass: 'escalation',
        subject: { name: '[Approve safely', url: TICKET_URL },
        detail: '](https://evil.example/approve) the loop is spent',
      }),
      notificationDraft({
        notificationClass: 'escalation',
        subject: {
          name: 'ACME-1',
          url: 'https://tickets.example.test/x](https://evil.example/approve)',
        },
        detail: 'Read [the brief',
      }),
    ]) {
      const slack = recordingSlack();
      await slackPort(slack.fetch).postMessage(THREAD, notificationBody(draft));
      const sent = everyString(slack.sent.at(-1) ?? '{}');
      expect(sent).not.toMatch(LABELLED_EVIL);
      expect(sent).not.toContain('|Approve safely');
      expect(sent).not.toContain('|the brief');
    }
  });

  it('is calibrated: the same items through a per-item pass alone do build the link', () => {
    // The defect as it was: each item unlabelled, then joined — Slack's pattern still matches.
    const joined = ['[Approve safely', '](https://evil.example/approve)'].join(', ');
    expect(/\[([^\]]*)\]\(([^\s)]+)\)/.test(joined)).toBe(true);
  });
});

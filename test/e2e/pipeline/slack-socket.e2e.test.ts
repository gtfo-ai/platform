/**
 * **WP-43: a button pressed in Slack moves the approval — over Socket Mode, which is what the
 * shipped manifest selects, and over HTTP, through the same door.**
 *
 * Until this row no process opened the socket, so every click and every thread reply reached
 * nothing (PROGRESS backlog 78), and approvals were not posted at all because a button would have
 * been dead. Everything here is production code except the two network edges of Slack
 * (`../support/slack.ts`): the instance composes the real Slack registration, opens the socket
 * through `IntegrationActionExecutor` in the process that serves `/webhooks/*`, posts the approval
 * with its buttons from the notification band, takes the click through the real `socket.ts`, the
 * real ingress, the real signature check and `inbox`, and decides it in the **Approval aggregate**
 * — `can()` against the decider's role — rather than appending provider text.
 *
 * ## One assertion, two transports (criterion 2)
 *
 * `it.each(TRANSPORTS)` runs **one** body: the click is built from the button the adapter actually
 * posted, and only the last step — `press` — differs between an HTTP `POST` signed as Slack signs
 * one and a Socket Mode `interactive` envelope. Both reach `WebhookIngress.deliver`; the outcome
 * is read back from the rows (standing rule 79), in both directions (rule 42): a stranger's click
 * and a member's click leave the approval pending, a maintainer's decides it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  CHAT_INTEGRATION_ID,
  inboundEvent,
  type PipelineE2E,
  startPipeline,
} from '../support/pipeline.js';
import { featureScenarios, TICKETS } from '../support/scenarios.js';
import {
  blockActionsFor,
  createFakeSlack,
  type FakeSlack,
  findApprovalButton,
  interactiveEnvelope,
  type PostedButton,
  signedHttpDelivery,
} from '../support/slack.js';

const TRANSPORTS = ['http', 'socket'] as const;
type Transport = (typeof TRANSPORTS)[number];

const STRANGER = 'U0FAKESTRANGE';
const DECIDER = 'U0FAKEDECIDER';

/** Every plan of the feature template waits for a human, so the task stops at the gate. */
const PLAN_ALWAYS = {
  pipeline: {
    template_overrides: { feature: { stages: { architecture: { plan_approval: 'always' } } } },
  },
};

let harness: PipelineE2E | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

interface ApprovalRow extends Record<string, unknown> {
  id: string;
  status: string;
  decided_by_user_id: string | null;
}

const approval = async (pipeline: PipelineE2E): Promise<ApprovalRow> => {
  const [row] = await pipeline.query<ApprovalRow>(
    'select id, status, decided_by_user_id from approvals order by requested_at limit 1',
  );
  if (row === undefined) {
    throw new Error('no approval was requested');
  }
  return row;
};

const inboxErrors = async (pipeline: PipelineE2E): Promise<string[]> =>
  (
    await pipeline.query<{ error: string | null }>(
      "select error from inbox where provider = 'slack' order by received_at",
    )
  ).map((row) => row.error ?? '');

/** Starts an instance whose chat binding is Slack in Socket Mode, and waits for the socket. */
const startSlack = async (label: string): Promise<{ pipeline: PipelineE2E; slack: FakeSlack }> => {
  const slack = createFakeSlack();
  const pipeline = await startPipeline({
    scenarios: featureScenarios,
    label,
    tickets: TICKETS,
    config: PLAN_ALWAYS,
    slack,
  });
  harness = pipeline;
  // The account was seeded after the instance started; the supervisor would find it at its next
  // re-list (a minute) — the labelled seam asks now instead of sleeping.
  await pipeline.instance.runtime.heldConnections?.relist();
  await pipeline.waitFor('the Socket Mode connection', async () => slack.live() !== null);
  slack.send({ type: 'hello', num_connections: 1 });
  await pipeline.waitFor(
    'the held connection to be open',
    async () =>
      pipeline.instance.runtime.heldConnections
        ?.status()
        .some(
          (status) => status.integrationId === CHAT_INTEGRATION_ID && status.state === 'open',
        ) ?? false,
  );
  return { pipeline, slack };
};

/** Drives ACME-1 to the plan gate and returns the Approve button the adapter posted. */
const toTheGate = async (pipeline: PipelineE2E, slack: FakeSlack): Promise<PostedButton> => {
  await pipeline.publish([
    inboundEvent('ticket.matched', {
      project_id: pipeline.projectId,
      ticket: {
        provider: 'fake-task-management',
        key: 'ACME-1',
        url: 'https://tickets.example.test/browse/ACME-1',
      },
      rule: 'label:agentic',
      priority: 'High',
      issue_type: 'Story',
      epic: null,
      links: [],
    }),
  ]);
  await pipeline.settle('waiting_approval', (task) => task.state === 'waiting_approval');
  let button: PostedButton | null = null;
  await pipeline.waitFor('the approval to be posted with its buttons', async () => {
    button = findApprovalButton(slack.posted, 'approved');
    return button !== null;
  });
  return button as unknown as PostedButton;
};

/** The one step that differs between the transports. */
const press = async (
  transport: Transport,
  pipeline: PipelineE2E,
  slack: FakeSlack,
  payload: unknown,
  envelopeId: string,
): Promise<void> => {
  if (transport === 'http') {
    const response = await pipeline.deliverChat(signedHttpDelivery(payload));
    expect(response.status).toBe(202);
    return;
  }
  slack.send(interactiveEnvelope(envelopeId, payload));
  // Acknowledged only once the ingress has recorded it — an unacked envelope is Slack's to resend.
  await pipeline.waitFor(`envelope ${envelopeId} to be acknowledged`, async () =>
    slack.acked().includes(envelopeId),
  );
};

describe('an approval button pressed in Slack', () => {
  it.each(TRANSPORTS)(
    'over %s: is refused for a stranger and a member, and decides the approval for a maintainer',
    async (transport) => {
      const { pipeline, slack } = await startSlack(`slack-${transport}`);
      const button = await toTheGate(pipeline, slack);

      // Criterion 6: the buttons name the approval **and** the task, so a click resolves on the
      // adapter the loader builds per delivery, which remembers nothing (Q55).
      const pending = await approval(pipeline);
      expect(button.blockId).toBe(`agentic:approval:${pending.id}`);
      expect(JSON.parse(button.value)).toMatchObject({ a: pending.id, d: 'approved' });

      // 1 — an unmapped account: recorded, acted on by nobody (BD-022, Q10).
      await press(transport, pipeline, slack, blockActionsFor(button, STRANGER), 'env-stranger');
      await pipeline.waitFor('the stranger’s delivery', async () =>
        (await inboxErrors(pipeline)).some((error) => error.includes('unmapped_identity')),
      );
      expect((await approval(pipeline)).status).toBe('pending');

      // 2 — mapped to a **member**, who may not approve a plan: the aggregate refuses (BD-006).
      await pipeline.query(
        `insert into user_identities (provider, external_id, user_id, display_name)
         values ('slack', $1, $2, 'decider')`,
        [DECIDER, pipeline.userId],
      );
      await press(transport, pipeline, slack, blockActionsFor(button, DECIDER), 'env-member');
      await pipeline.waitFor('the member’s delivery', async () =>
        (await inboxErrors(pipeline)).some((error) =>
          error.includes('decision_refused: not_permitted'),
        ),
      );
      expect((await approval(pipeline)).status).toBe('pending');
      expect((await pipeline.task()).state).toBe('waiting_approval');

      // 3 — the same person, now a maintainer: the approval is decided by them, and the task moves.
      await pipeline.query("update users set role = 'maintainer' where id = $1", [pipeline.userId]);
      await press(transport, pipeline, slack, blockActionsFor(button, DECIDER), 'env-maintainer');
      await pipeline.waitFor(
        'the approval to be decided',
        async () => (await approval(pipeline)).status === 'approved',
      );
      expect((await approval(pipeline)).decided_by_user_id).toBe(pipeline.userId);
      const moved = await pipeline.settle(
        'the task to leave the gate',
        (task) => task.state !== 'waiting_approval',
      );
      expect(moved.current_stage).not.toBe('architecture');

      // The decision is the aggregate's, on the approval's own stream — never the project's.
      const decided = await pipeline.query<{
        stream_type: string;
        stream_id: string;
        actor: unknown;
      }>("select stream_type, stream_id, actor from events where type = 'task.approval.decided'");
      expect(decided).toHaveLength(1);
      expect(decided[0]).toMatchObject({
        stream_type: 'approval',
        stream_id: pending.id,
        actor: { kind: 'user', user_id: pipeline.userId },
      });
    },
    240_000,
  );
});

describe('the Socket Mode connection', () => {
  it('opens through the executor, deduplicates across transports, and closes at shutdown', async () => {
    const { pipeline, slack } = await startSlack('slack-lifecycle');

    // Every outbound Slack call on the binding's behalf goes through the executor — the socket's
    // own `apps.connections.open` included, audited as a read against the binding.
    const opened = await pipeline.query<{ action: string; status: string }>(
      `select action, status from integration_actions
        where integration_id = $1 and action = 'open_socket'`,
      [CHAT_INTEGRATION_ID],
    );
    expect(opened).toEqual([{ action: 'open_socket', status: 'ok' }]);

    const button = await toTheGate(pipeline, slack);
    await pipeline.query(
      `insert into user_identities (provider, external_id, user_id, display_name)
       values ('slack', $1, $2, 'decider')`,
      [DECIDER, pipeline.userId],
    );
    await pipeline.query("update users set role = 'maintainer' where id = $1", [pipeline.userId]);

    // Two replicas hold two connections and Slack may resend an envelope to the other one: the
    // backstop is `inbox (provider, delivery_id)`, keyed by the payload rather than the connection.
    // Here the same click arrives once over the socket and once over HTTP.
    const click = blockActionsFor(button, DECIDER);
    slack.send(interactiveEnvelope('env-1', click));
    await pipeline.waitFor('the click to be acknowledged', async () =>
      slack.acked().includes('env-1'),
    );
    const again = await pipeline.deliverChat(signedHttpDelivery(click));
    expect(again.status).toBe(202);
    expect(again.body).toMatchObject({ accepted: true });
    const slackRows = (await pipeline.inbox()).filter((row) => row.provider === 'slack');
    expect(slackRows).toHaveLength(1);
    expect(slackRows[0]?.verified).toBe(true);
    expect(
      (await pipeline.events()).filter((event) => event.type === 'task.approval.decided'),
    ).toHaveLength(1);

    // Criterion 1, the other end: shutdown closes the socket and nothing reopens it.
    const opensBefore = slack.opens();
    await pipeline.stop();
    harness = undefined;
    expect(slack.connections.every((connection) => connection.closed)).toBe(true);
    expect(slack.opens()).toBe(opensBefore);
  }, 240_000);
});

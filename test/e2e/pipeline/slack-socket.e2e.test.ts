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
import { decisionAuditShape, expectedApprovalAudit } from '../support/decision-audit.js';
import {
  CHAT_INTEGRATION_ID,
  inboundEvent,
  type PipelineE2E,
  type SeededWorld,
  type StartPipelineOptions,
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
  SLACK_E2E_CHANNEL,
  signedHttpDelivery,
  threadReplyFor,
} from '../support/slack.js';

const TRANSPORTS = ['http', 'socket'] as const;
type Transport = (typeof TRANSPORTS)[number];

const STRANGER = 'U0FAKESTRANGE';
const DECIDER = 'U0FAKEDECIDER';
const ANSWERER = 'U0FAKEANSWERR';

/** Every plan of the feature template waits for a human, so the task stops at the gate. */
const PLAN_ALWAYS = {
  version: 1,
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
const startSlack = async (
  label: string,
  options: Partial<Pick<StartPipelineOptions, 'scenarios' | 'config'>> = {},
): Promise<{ pipeline: PipelineE2E; slack: FakeSlack }> => {
  const slack = createFakeSlack();
  const pipeline = await startPipeline({
    scenarios: options.scenarios ?? featureScenarios,
    label,
    tickets: TICKETS,
    config: 'config' in options ? options.config : PLAN_ALWAYS,
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

      // WP-88 (backlog 199): the accepted click left the `human_actions` row the task page's
      // decision leaves — the same shape, against the same helper as the route's e2e case — plus
      // the door; the refused clicks above left none.
      const audit = await pipeline.query<{
        action: string;
        user_id: string | null;
        task_id: string | null;
        params: Record<string, unknown>;
      }>('select action, user_id, task_id, params from human_actions order by created_at');
      expect(audit).toHaveLength(1);
      expect(decisionAuditShape(audit[0] as NonNullable<(typeof audit)[number]>)).toEqual(
        expectedApprovalAudit({
          taskId: (await pipeline.task()).id,
          approvalId: pending.id,
          userId: pipeline.userId,
          channel: 'slack',
        }),
      );
      expect(audit[0]?.params).toMatchObject({
        provider: 'slack',
        integration_id: CHAT_INTEGRATION_ID,
      });
      expect(typeof audit[0]?.params.delivery_id).toBe('string');

      // WP-65's edit, now reachable on this double: the settled approval's buttons are gone.
      await pipeline.waitFor('the approval message to be edited', async () =>
        slack.updated.some((update) => update.ts === button.messageTs),
      );

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

    // WP-88 (backlog 195): a reply typed in the task's thread reaches the task, through the thread
    // row the production notify duty wrote when it opened the thread — resolved by an adapter the
    // loader built for this delivery alone. No question is open, so it is feedback.
    const threadTs = button.threadTs as string;
    expect(threadTs, 'the approval was posted into the task thread').toBeTruthy();
    const threads = await pipeline.query<{ channel: string; thread_id: string }>(
      'select channel, thread_id from chat_threads',
    );
    expect(threads).toEqual([{ channel: SLACK_E2E_CHANNEL, thread_id: threadTs }]);
    const replied = await pipeline.deliverChat(
      signedHttpDelivery(threadReplyFor(threadTs, DECIDER, 'the plan reads well')),
    );
    expect(replied.status).toBe(202);
    await pipeline.waitFor('the reply to be recorded as feedback', async () =>
      (await pipeline.events()).some((event) => event.type === 'feedback.received'),
    );
    const feedback = (await pipeline.events()).find((event) => event.type === 'feedback.received');
    expect(feedback?.payload).toMatchObject({ task_id: (await pipeline.task()).id });

    // Criterion 1, the other end: shutdown closes the socket and nothing reopens it.
    const opensBefore = slack.opens();
    await pipeline.stop();
    harness = undefined;
    expect(slack.connections.every((connection) => connection.closed)).toBe(true);
    expect(slack.opens()).toBe(opensBefore);
  }, 240_000);
});

/** The question refinement asks: blocking, and with no options, so a typed reply is the answer. */
const QUESTION_TEXT = 'Which currency should the footer total be shown in?';
const ANSWER_TEXT = 'EUR on every invoice, please';

/** `featureScenarios` with a refinement that parks the task on one blocking question. */
const askingScenarios = (world: SeededWorld) => {
  const base = featureScenarios(world);
  return {
    ...base,
    refinement: {
      structuredOutput: {
        ...(base.refinement.structuredOutput as Record<string, unknown>),
        decision: 'ask',
        questions: [{ id: 'q1', text: QUESTION_TEXT, blocking: true }],
      },
    },
  };
};

describe('a question answered by a reply in its Slack thread (WP-116, backlog 300)', () => {
  /**
   * WP-88's answer path, one tier up from `slack-thread-reply.integration.test.ts`: there the
   * question's `notifications` row is written by the test through the production store; here the
   * **notify duty** posts the question with `postQuestion` and records its address, so the join the
   * directory reads — the duty's `message_ref.thread_id` against the duty's `chat_threads` row,
   * `class = 'question'` — is the one production writes, and the reply comes through the HTTP door.
   */
  it('posts the blocking question into the task thread, takes a typed reply over HTTP as its answer, and edits the message', async () => {
    const { pipeline, slack } = await startSlack('slack-question', {
      scenarios: askingScenarios,
      config: undefined,
    });
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
    const parked = await pipeline.settle(
      'waiting_answers',
      (task) => task.state === 'waiting_answers',
    );
    const [question] = await pipeline.query<{ id: string; status: string; blocking: boolean }>(
      'select id, status, blocking from questions where task_id = $1',
      [parked.id],
    );
    expect(question).toMatchObject({ status: 'open', blocking: true });
    const questionId = question?.id as string;

    // ── the question is posted into the task's thread ─────────────────────────
    // The wait binds `markDelivered`, the **last** row the notify duty writes for this post: the
    // row exists from the plan with `message_ref` null, and the address is written only after
    // `postQuestion` returned (rule 87). So the fake's record below is what that row implies.
    type Ref = { channel: string; message_id: string; thread_id: string | null };
    let ref: Ref | null = null;
    await pipeline.waitFor('the question’s message address to be recorded', async () => {
      const [row] = await pipeline.query<{ message_ref: Ref | null }>(
        `select message_ref from notifications
          where class = 'question' and question_id = $1 and message_ref is not null`,
        [questionId],
      );
      ref = row?.message_ref ?? null;
      return ref !== null;
    });
    const address = ref as unknown as Ref;
    const posted = slack.posted.find(
      (message) => message.channel === address.channel && message.ts === address.message_id,
    );
    expect(posted, 'the recorded address names a message the adapter posted').toBeDefined();
    expect(posted?.text).toContain(QUESTION_TEXT);
    // Into the task's thread — the one the duty recorded in `chat_threads` — and not as a new root.
    const threads = await pipeline.query<{ channel: string; thread_id: string; task_id: string }>(
      'select channel, thread_id, task_id from chat_threads',
    );
    expect(threads).toEqual([
      { channel: SLACK_E2E_CHANNEL, thread_id: address.thread_id, task_id: parked.id },
    ]);
    expect(posted?.threadTs).toBe(address.thread_id);
    // Posted through `postQuestion`: the reply-to-answer line is the question's own Block Kit.
    expect(JSON.stringify(posted?.blocks)).toContain('Reply in this thread to answer');
    const posts = await pipeline.query<{ action: string; status: string }>(
      `select action, status from integration_actions
        where integration_id = $1 and action = 'post_question'`,
      [CHAT_INTEGRATION_ID],
    );
    expect(posts).toEqual([{ action: 'post_question', status: 'ok' }]);

    // ── a mapped person replies in that thread, over HTTP ────────────────────
    await pipeline.query(
      `insert into user_identities (provider, external_id, user_id, display_name)
       values ('slack', $1, $2, 'answerer')`,
      [ANSWERER, pipeline.userId],
    );
    const editsOf = async () =>
      pipeline.query<{ status: string }>(
        `select status from integration_actions
          where integration_id = $1 and action = 'update_message'`,
        [CHAT_INTEGRATION_ID],
      );
    // Both waits below would be satisfied by the state before the reply if this did not hold.
    expect(await editsOf()).toEqual([]);
    expect(slack.updated).toEqual([]);
    const replied = await pipeline.deliverChat(
      signedHttpDelivery(threadReplyFor(address.thread_id as string, ANSWERER, ANSWER_TEXT)),
    );
    expect(replied.status).toBe(202);

    // The answer, the event and the audit row are written in **one** transaction — the delivery's
    // (WP-88's applier) — so a wait on the question's status binds all three; it was `open` above.
    await pipeline.waitFor('the question to be answered', async () => {
      const [row] = await pipeline.query<{ status: string }>(
        'select status from questions where id = $1',
        [questionId],
      );
      return row?.status === 'answered';
    });
    const [answered] = await pipeline.query<{
      answer: string | null;
      answered_by_user_id: string | null;
      answered_via: string | null;
    }>('select answer, answered_by_user_id, answered_via from questions where id = $1', [
      questionId,
    ]);
    expect(answered).toEqual({
      answer: ANSWER_TEXT,
      answered_by_user_id: pipeline.userId,
      answered_via: 'slack',
    });
    const events = (await pipeline.events()).filter(
      (event) => event.type === 'task.question.answered',
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      task_id: parked.id,
      question_id: questionId,
      answer: ANSWER_TEXT,
      answered_by_user_id: pipeline.userId,
      channel: 'slack',
    });
    // An answer, not feedback: the reply was addressed to the open question.
    expect((await pipeline.events()).some((event) => event.type === 'feedback.received')).toBe(
      false,
    );

    // One `human_actions` row, in the route's vocabulary, with the door named and none of the words.
    const audit = await pipeline.query<{
      action: string;
      user_id: string | null;
      task_id: string | null;
      params: Record<string, unknown>;
    }>('select action, user_id, task_id, params from human_actions order by created_at');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'task.question.answer',
      user_id: pipeline.userId,
      task_id: parked.id,
      params: {
        task_id: parked.id,
        question_id: questionId,
        channel: 'slack',
        provider: 'slack',
        integration_id: CHAT_INTEGRATION_ID,
      },
    });
    expect(typeof audit[0]?.params.delivery_id).toBe('string');
    expect(JSON.stringify(audit)).not.toContain(ANSWER_TEXT);

    // ── the question's message is edited ─────────────────────────────────────
    // The wait binds the executor's `update_message` row, written after the provider answered
    // (rule 87), and there was none before the reply; the fake's record is what that row implies.
    await pipeline.waitFor('the question’s message to be edited', async () =>
      (await editsOf()).some((row) => row.status === 'ok'),
    );
    const edits = slack.updated.filter(
      (update) => update.channel === address.channel && update.ts === address.message_id,
    );
    expect(edits).toHaveLength(1);
    // Settled, and it never repeats the answer (WP-88 criterion 2).
    expect(edits[0]?.text).not.toContain(ANSWER_TEXT);
  }, 240_000);
});

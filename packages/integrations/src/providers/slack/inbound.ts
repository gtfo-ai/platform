/**
 * Slack deliveries → catalogue events (technical/02, BD-022, Q10).
 *
 * ## The identity rule is the whole point of this file
 *
 * An answer or an approval that arrives from chat is a *human decision* (BD-006), and it may only
 * become `task.question.answered` or `task.approval.decided` when its author maps to a platform
 * user. Three things follow, and each is a positive assertion in the contract suite rather than a
 * comment here:
 *
 *  1. **The identity is the Slack user id, never anything in the text.** `user.id` is set by Slack
 *     and arrives inside a payload this module has already had verified; a display name, a
 *     username and an email *in a message body* are all things a workspace member can type.
 *     `resolveUser` is given `{provider: 'slack', external_id: 'U…'}` and nothing forgeable.
 *  2. **An unmapped author is refused, never defaulted.** `ignored: unmapped_identity`, recorded
 *     for the audit, acted on by nobody.
 *  3. **Feedback is different on purpose.** It is data, not a decision, so it is recorded with the
 *     unmapped identity and a null user id (technical/06 § Communication).
 *
 * ## Fail open on an inbound notification (standing rule 20)
 *
 * Slack adds event types and Block Kit elements continuously. Every unknown shape here is
 * `ignored` with a reason — never thrown — because a normaliser that throws turns a vendor's new
 * feature into a permanently failing job. The direction reverses for an outbound mutation, which
 * is `http.ts`'s unknown-slug rule.
 *
 * ## What is deliberately not an event
 *
 * A message that is not in a thread this binding opened produces nothing. The alternative —
 * "every message in the channel is feedback" — turns a chat channel into an unbounded write path
 * into the platform's database, and the port's `feedback.received` is about a task.
 *
 * Sources, retrieved 2026-09-10:
 * <https://docs.slack.dev/reference/events/message>,
 * <https://docs.slack.dev/reference/interaction-payloads/block_actions-payload>.
 */
import type {
  CommunicationInboundEvent,
  ExternalIdentity,
  IgnoredDelivery,
  InboundContext,
  NormalisedDelivery,
  NormalisedEvent,
  WebhookDelivery,
} from '@platform/application';
import type { Actor, Id } from '@platform/contracts';
import type { Clock, IdSource } from '@platform/domain';
import * as z from 'zod';
import {
  ANSWER_ACTION_ID,
  APPROVE_ACTION_ID,
  parseApprovalBlockId,
  parseQuestionBlockId,
  REJECT_ACTION_ID,
} from './blocks.js';
import { SLACK_PROVIDER_ID } from './http.js';
import {
  type BlockActions,
  blockActionsSchema,
  type EventCallback,
  eventCallbackSchema,
} from './schemas.js';
import type { SlackThreadDirectory } from './threads.js';

/** `answerChannelSchema` in `@platform/contracts` has a value for this provider. */
const ANSWER_CHANNEL = 'slack' as const;

export interface SlackInboundDeps {
  readonly threads: SlackThreadDirectory;
  /** The workspace this binding serves, or `null` for "any". */
  readonly teamId: string | null;
  /** The bot's own user id, so the adapter never answers its own question. */
  readonly botUserId: string | null;
  readonly ids: IdSource;
  readonly clock: Clock;
  readonly maxBodyBytes: number;
}

const ignored = (
  reason: IgnoredDelivery['reason'],
  detail: string,
): NormalisedDelivery<CommunicationInboundEvent> => ({ events: [], ignored: [{ reason, detail }] });

/** Provider text in an `ignored.detail` is bounded: it is written to the inbox row (BD-022). */
const brief = (value: unknown, limit = 64): string => JSON.stringify(String(value).slice(0, limit));

/**
 * Whether a delivery belongs to the workspace this binding was configured for.
 *
 * `config.team_id` is `nullish`, and absent means "any workspace" — a binding that never names one
 * has nothing to compare against, and the safety of *that* configuration rests entirely on
 * `InboundContext.resolveUser` being scoped to the binding's own identity mappings, since
 * `ExternalIdentity` carries no workspace of its own.
 *
 * When the operator *has* named one, a payload that carries **no** team is refused rather than
 * admitted (standing rule 16: a guard against an untrusted producer must not read a field that
 * producer can omit). The earlier `team !== null &&` made a missing field indistinguishable from a
 * matching one, which is the fail-open direction. Slack sends `team` on `block_actions` and
 * `team_id` on every `event_callback`; an org-wide install that legitimately omits it configures
 * no `team_id` and relies on identity mapping, as above.
 */
const isForThisWorkspace = (team: string | null, configured: string | null): boolean =>
  configured === null || (team !== null && team === configured);

const identityFor = (userId: string, mapped: boolean): ExternalIdentity => ({
  provider: SLACK_PROVIDER_ID,
  external_id: userId,
  // Never taken from the payload: a profile email is not in a message body, and an email that is
  // in one was typed by whoever sent it.
  email: null,
  display_name: null,
  verified: mapped,
});

const actorFor = (context: InboundContext, identity: ExternalIdentity, userId: Id | null): Actor =>
  userId === null
    ? { kind: 'integration', integration_id: context.integrationId, provider: SLACK_PROVIDER_ID }
    : { kind: 'user', user_id: userId, identity };

/**
 * The value this adapter puts on an answer button, read back.
 *
 * It is our own JSON, echoed by Slack — and it is still parsed rather than trusted: it arrives in
 * a payload, and everything in a payload is untrusted data (BD-022). A value that is not ours
 * makes the click an unrecognised button rather than an answer.
 */
const answerValueSchema = z.object({ q: z.uuid(), o: z.string().min(1).max(2000) });
const approvalValueSchema = z.object({
  a: z.uuid(),
  d: z.enum(['approved', 'rejected']),
});

interface RecognisedAction {
  readonly kind: 'question' | 'approval';
  readonly id: string;
  readonly actionId: string;
  readonly value: string | null;
}

/** The first action in the payload that this adapter posted. Everything else is somebody's. */
const recogniseAction = (payload: BlockActions): RecognisedAction | null => {
  for (const action of payload.actions) {
    const actionId = action.action_id ?? '';
    const questionId = parseQuestionBlockId(action.block_id);
    if (questionId !== null && actionId === ANSWER_ACTION_ID) {
      return { kind: 'question', id: questionId, actionId, value: action.value ?? null };
    }
    const approvalId = parseApprovalBlockId(action.block_id);
    if (approvalId !== null && (actionId === APPROVE_ACTION_ID || actionId === REJECT_ACTION_ID)) {
      return { kind: 'approval', id: approvalId, actionId, value: action.value ?? null };
    }
  }
  return null;
};

const normaliseBlockActions = (
  payload: BlockActions,
  context: InboundContext,
  deps: SlackInboundDeps,
): NormalisedDelivery<CommunicationInboundEvent> => {
  const team = payload.team?.id ?? payload.user.team_id ?? null;
  if (!isForThisWorkspace(team, deps.teamId)) {
    return ignored('not_for_this_project', `interaction from workspace ${brief(team ?? 'none')}`);
  }
  const recognised = recogniseAction(payload);
  if (recognised === null) {
    // A workspace member can put their own buttons on their own message. Those are not decisions.
    return ignored(
      'unsupported_event',
      `no agentic action in ${brief(payload.actions.map((action) => action.action_id).join(','))}`,
    );
  }

  const identity = identityFor(payload.user.id, false);
  const userId = context.resolveUser(identity);
  if (userId === null) {
    // Q10 / BD-022: an unmapped chat user cannot answer or approve.
    return ignored(
      'unmapped_identity',
      `${brief(payload.user.id)} is not mapped to a platform user`,
    );
  }
  const author = identityFor(payload.user.id, true);

  if (recognised.kind === 'question') {
    const parsed = answerValueSchema.safeParse(safeJson(recognised.value));
    if (!parsed.success || parsed.data.q !== recognised.id) {
      return ignored('malformed_payload', 'answer button carries no value this adapter wrote');
    }
    const taskId = taskForPayload(payload, deps);
    if (taskId === null) {
      return ignored('unsupported_event', 'answer for a thread this binding did not open');
    }
    const event: NormalisedEvent<'task.question.answered'> = {
      type: 'task.question.answered',
      payload: {
        project_id: context.projectId,
        task_id: taskId,
        question_id: recognised.id,
        answer: parsed.data.o,
        answered_by_user_id: userId,
        channel: ANSWER_CHANNEL,
      },
      actor: actorFor(context, author, userId),
    };
    return { events: [event], ignored: [] };
  }

  const parsed = approvalValueSchema.safeParse(safeJson(recognised.value));
  if (!parsed.success || parsed.data.a !== recognised.id) {
    return ignored('malformed_payload', 'approval button carries no value this adapter wrote');
  }
  // The decision is taken from the `action_id`, and the button's own value must agree. They are
  // written together and can only disagree if somebody rebuilt the message: refuse rather than
  // pick one.
  const fromAction = recognised.actionId === APPROVE_ACTION_ID ? 'approved' : 'rejected';
  if (parsed.data.d !== fromAction) {
    return ignored('malformed_payload', 'approval button and its value disagree');
  }
  const taskId = taskForPayload(payload, deps);
  if (taskId === null) {
    return ignored('unsupported_event', 'approval for a thread this binding did not open');
  }
  const event: NormalisedEvent<'task.approval.decided'> = {
    type: 'task.approval.decided',
    payload: {
      project_id: context.projectId,
      task_id: taskId,
      approval_id: recognised.id,
      decision: fromAction,
      decided_by_user_id: userId,
      reason: null,
    },
    actor: actorFor(context, author, userId),
  };
  return { events: [event], ignored: [] };
};

const safeJson = (value: string | null): unknown => {
  if (value === null) {
    return null;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
};

/**
 * The task a clicked message belongs to.
 *
 * The container names the message that carried the button; a question is posted *into* a task
 * thread, so `thread_ts` is the thread and `message_ts` is the question. Both are tried because
 * the payload's container shape differs between a root message and a threaded one.
 */
const taskForPayload = (payload: BlockActions, deps: SlackInboundDeps): Id | null => {
  const channel = payload.channel?.id ?? payload.container?.channel_id ?? null;
  if (channel === null) {
    return null;
  }
  const candidates = [
    payload.container?.thread_ts,
    payload.message?.thread_ts,
    payload.container?.message_ts,
    payload.message?.ts,
  ];
  for (const threadTs of candidates) {
    if (typeof threadTs !== 'string' || threadTs === '') {
      continue;
    }
    const taskId = deps.threads.taskForThread({ channel, threadTs });
    if (taskId !== null) {
      return taskId;
    }
  }
  return null;
};

const normaliseMessageEvent = (
  delivery: EventCallback,
  context: InboundContext,
  deps: SlackInboundDeps,
): NormalisedDelivery<CommunicationInboundEvent> => {
  const event = delivery.event;
  if (!isForThisWorkspace(delivery.team_id ?? null, deps.teamId)) {
    return ignored(
      'not_for_this_project',
      `message from workspace ${brief(delivery.team_id ?? 'none')}`,
    );
  }
  // The adapter never reads its own writing: a bot message, an edit, a deletion, a join notice.
  if (event.bot_id != null || event.app_id != null) {
    return ignored('unsupported_event', 'message posted by an application');
  }
  if (event.subtype != null) {
    return ignored('unsupported_event', `message subtype ${brief(event.subtype)}`);
  }
  const user = event.user ?? null;
  if (user === null || user === '') {
    return ignored('malformed_payload', 'message event carries no user');
  }
  if (deps.botUserId !== null && user === deps.botUserId) {
    return ignored('unsupported_event', 'message posted by this integration');
  }
  const channel = event.channel ?? null;
  const threadTs = event.thread_ts ?? null;
  if (channel === null || threadTs === null || threadTs === event.ts) {
    // Not a threaded reply: a top-level channel message is not addressed to a task.
    return ignored('unsupported_event', 'message is not a reply in a task thread');
  }
  const handle = { channel, threadTs };
  const taskId = deps.threads.taskForThread(handle);
  if (taskId === null) {
    return ignored('unsupported_event', 'reply in a thread this binding did not open');
  }
  const text = event.text ?? '';
  if (text.trim() === '') {
    return ignored('malformed_payload', 'message event carries no text');
  }

  const identity = identityFor(user, false);
  const userId = context.resolveUser(identity);
  const questionId = deps.threads.latestQuestion(handle);

  if (questionId !== null) {
    if (userId === null) {
      return ignored('unmapped_identity', `${brief(user)} is not mapped to a platform user`);
    }
    const answered: NormalisedEvent<'task.question.answered'> = {
      type: 'task.question.answered',
      payload: {
        project_id: context.projectId,
        task_id: taskId,
        question_id: questionId,
        answer: text,
        answered_by_user_id: userId,
        channel: ANSWER_CHANNEL,
      },
      actor: actorFor(context, identityFor(user, true), userId),
    };
    return { events: [answered], ignored: [] };
  }

  // No open question: this is feedback, which is data rather than a decision, so an unmapped
  // author is *recorded* with a null user id instead of dropped.
  const author = identityFor(user, userId !== null);
  const feedback: NormalisedEvent<'feedback.received'> = {
    type: 'feedback.received',
    payload: {
      project_id: context.projectId,
      task_id: taskId,
      feedback: {
        id: deps.ids.next(),
        project_id: context.projectId,
        task_id: taskId,
        author_user_id: userId,
        author_identity: author,
        scope: 'task',
        text,
        rating: null,
        source_channel: ANSWER_CHANNEL,
        created_at: deps.clock.now(),
      },
    },
    actor: actorFor(context, author, userId),
  };
  return { events: [feedback], ignored: [] };
};

/** One verified delivery, normalised. Never throws for a shape it does not recognise. */
export const normaliseSlackDelivery = (
  delivery: WebhookDelivery,
  context: InboundContext,
  deps: SlackInboundDeps,
): NormalisedDelivery<CommunicationInboundEvent> => {
  if (Buffer.byteLength(delivery.body, 'utf8') > deps.maxBodyBytes) {
    return ignored('malformed_payload', `delivery exceeds ${deps.maxBodyBytes} bytes`);
  }
  let body: unknown;
  try {
    body = JSON.parse(delivery.body) as unknown;
  } catch {
    return ignored('malformed_payload', 'delivery body is not JSON');
  }
  const type = (body as { type?: unknown } | null)?.type;

  if (type === 'block_actions') {
    const parsed = blockActionsSchema.safeParse(body);
    return parsed.success
      ? normaliseBlockActions(parsed.data, context, deps)
      : ignored('malformed_payload', parsed.error.issues[0]?.message ?? 'block_actions');
  }
  if (type === 'event_callback') {
    const parsed = eventCallbackSchema.safeParse(body);
    if (!parsed.success) {
      return ignored('malformed_payload', parsed.error.issues[0]?.message ?? 'event_callback');
    }
    if (parsed.data.event.type !== 'message') {
      return ignored('unsupported_event', `event type ${brief(parsed.data.event.type)}`);
    }
    return normaliseMessageEvent(parsed.data, context, deps);
  }
  // `url_verification`, `view_submission`, a shortcut, a slash command, and everything Slack ships
  // next. Ignored with a reason — never thrown (standing rule 20).
  return ignored('unsupported_event', `delivery type ${brief(type)}`);
};

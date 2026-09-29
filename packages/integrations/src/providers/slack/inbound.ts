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
 * ## Which task a thread belongs to is the platform's rows, not this adapter's memory (WP-88)
 *
 * A threaded reply carries a channel and a `thread_ts`, nothing else. Until WP-88 this module read
 * the adapter's own `SlackThreadDirectory` to turn that into a task, and the binding loader builds a
 * fresh adapter for every delivery (Q55) — so the directory was always empty here, and a reply
 * reached nothing (PROGRESS backlog 195). The durable map is `InboundContext.resolveThread`: the
 * `chat_threads` row the notify duty wrote when it opened the thread, and the open questions whose
 * messages it posted into it — a reply answers one only when exactly one is open (review round 1). What it answers is a pointer the Question aggregate re-checks.
 * A click resolves its task from the button's own value first (`t`, as an approval's has since
 * WP-43) and from the thread second, and when both answer they must agree.
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
  InboundThreadMatch,
  NormalisedDelivery,
  NormalisedEvent,
  SecretRedactor,
  WebhookDelivery,
} from '@platform/application';
import type { Actor, Id, JsonObject } from '@platform/contracts';
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

/** `answerChannelSchema` in `@platform/contracts` has a value for this provider. */
const ANSWER_CHANNEL = 'slack' as const;

export interface SlackInboundDeps {
  /** The workspace this binding serves, or `null` for "any". */
  readonly teamId: string | null;
  /** The bot's own user id, so the adapter never answers its own question. */
  readonly botUserId: string | null;
  readonly ids: IdSource;
  readonly clock: Clock;
  readonly maxBodyBytes: number;
  /**
   * TD-012, **required** (standing rule 31), and this direction is the one that writes to an
   * append-only table.
   *
   * A thread reply becomes `feedback.received` and a click becomes `task.question.answered`, both
   * of which carry provider text straight into `events.payload` — the first row on TD-012's list of
   * writes that must be redacted first. The classic case is an operator pasting `xoxb-…` into the
   * channel while setting the app up: the platform would keep a live credential in a table it
   * cannot rewrite (BD-003).
   */
  readonly redactor: SecretRedactor;
  /** Where a redaction count is reported. The redacted text is never reported (TD-012). */
  readonly onRedaction?: (event: { readonly action: string; readonly count: number }) => void;
}

const ignored = (
  reason: IgnoredDelivery['reason'],
  detail: string,
  identity?: IgnoredDelivery['identity'],
): NormalisedDelivery<CommunicationInboundEvent> => ({
  events: [],
  ignored: [{ reason, detail, ...(identity === undefined ? {} : { identity }) }],
});

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
const answerValueSchema = z.object({
  q: z.uuid(),
  o: z.string().min(1).max(2000),
  /**
   * The task, beside the question since WP-88 (`blocks.ts`'s `answerButtonValue`) — the approval
   * button's `t`. Optional only so a value without it is read through the thread; no production
   * instance posted one, because `postQuestion` had no caller before WP-88.
   */
  t: z.uuid().optional(),
});
const approvalValueSchema = z.object({
  a: z.uuid(),
  d: z.enum(['approved', 'rejected']),
  /**
   * The task, written beside the approval since WP-43 (`blocks.ts`'s `approvalButtonValue`).
   *
   * Optional only so a button posted before it existed is read the old way, through the thread
   * directory — and no production instance posted one: WP-32 withheld approval buttons because no
   * click could arrive.
   */
  t: z.uuid().optional(),
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

/**
 * The task a click is about: the button's own `t` first, the thread's row second, and a refusal
 * when both answer and disagree — a disagreement means somebody rebuilt the message, and picking
 * one would be picking an attacker's half.
 */
const taskForClick = async (
  payload: BlockActions,
  fromButton: string | null,
  context: InboundContext,
  kind: 'answer' | 'approval',
): Promise<{ readonly taskId: Id } | NormalisedDelivery<CommunicationInboundEvent>> => {
  const fromThread = (await threadForPayload(payload, context))?.taskId ?? null;
  if (fromThread !== null && fromButton !== null && fromThread !== fromButton) {
    return ignored('malformed_payload', `${kind} button and its thread name different tasks`);
  }
  const taskId = fromButton ?? fromThread;
  if (taskId === null) {
    return ignored('unsupported_event', `${kind} for a thread this binding did not open`);
  }
  return { taskId: taskId as Id };
};

const normaliseBlockActions = async (
  payload: BlockActions,
  context: InboundContext,
  deps: SlackInboundDeps,
): Promise<NormalisedDelivery<CommunicationInboundEvent>> => {
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
      // Which account, structurally, so the identities screen can offer it (WP-44, backlog 198).
      { provider: SLACK_PROVIDER_ID, external_id: payload.user.id },
    );
  }
  const author = identityFor(payload.user.id, true);

  if (recognised.kind === 'question') {
    const parsed = answerValueSchema.safeParse(safeJson(recognised.value));
    if (!parsed.success || parsed.data.q !== recognised.id) {
      return ignored('malformed_payload', 'answer button carries no value this adapter wrote');
    }
    const task = await taskForClick(payload, parsed.data.t ?? null, context, 'answer');
    if (!('taskId' in task)) {
      return task;
    }
    const event: NormalisedEvent<'task.question.answered'> = {
      type: 'task.question.answered',
      payload: {
        project_id: context.projectId,
        task_id: task.taskId,
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
  // The task, from the button first and the thread's row second (WP-43, WP-88).
  const task = await taskForClick(payload, parsed.data.t ?? null, context, 'approval');
  if (!('taskId' in task)) {
    return task;
  }
  const taskId = task.taskId;
  const event: NormalisedEvent<'task.approval.decided'> = {
    type: 'task.approval.decided',
    payload: {
      project_id: context.projectId,
      task_id: taskId as Id,
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
 * The thread a clicked message belongs to, through the platform's rows (WP-88).
 *
 * The container names the message that carried the button; a question is posted *into* a task
 * thread, so `thread_ts` is the thread and `message_ts` is the question. Both are tried because
 * the payload's container shape differs between a root message and a threaded one. Distinct
 * candidates only, and at most four lookups: every one is a read the caller pays for.
 */
const threadForPayload = async (
  payload: BlockActions,
  context: InboundContext,
): Promise<InboundThreadMatch | null> => {
  const channel = payload.channel?.id ?? payload.container?.channel_id ?? null;
  if (channel === null) {
    return null;
  }
  const candidates = new Set(
    [
      payload.container?.thread_ts,
      payload.message?.thread_ts,
      payload.container?.message_ts,
      payload.message?.ts,
    ].filter((value): value is string => typeof value === 'string' && value !== ''),
  );
  for (const threadId of candidates) {
    const match = await context.resolveThread({ channel, threadId });
    if (match !== null) {
      return match;
    }
  }
  return null;
};

const normaliseMessageEvent = async (
  delivery: EventCallback,
  context: InboundContext,
  deps: SlackInboundDeps,
): Promise<NormalisedDelivery<CommunicationInboundEvent>> => {
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
  const text = event.text ?? '';
  if (text.trim() === '') {
    return ignored('malformed_payload', 'message event carries no text');
  }
  // The durable map (WP-88): the thread's task, and the open questions posted into it.
  const thread = await context.resolveThread({ channel, threadId: threadTs });
  if (thread === null) {
    return ignored('unsupported_event', 'reply in a thread this binding did not open');
  }
  const taskId = thread.taskId;
  /**
   * **Several open questions make a reply ambiguous** (WP-88 review round 1). A stage opens one
   * blocking question per artifact draft, and a reply names none of them; recording it as the
   * answer to one would put a person's name under an answer they may have meant for another. So it
   * answers nothing and is not feedback either — the words were addressed to a question — and the
   * refusal is on the inbox row. Nobody is told in the channel; each question's buttons and the
   * task page still answer it.
   */
  if (thread.openQuestions > 1) {
    return ignored(
      'unsupported_event',
      `reply in a thread with ${thread.openQuestions} open questions names none of them; answer with a question's buttons or on the task page`,
    );
  }

  const identity = identityFor(user, false);
  const userId = context.resolveUser(identity);
  const questionId = thread.questionId;

  if (questionId !== null) {
    /**
     * **A reply to an open question is an answer, and an answer is a human decision** (BD-006,
     * Q10). From an unmapped account it is recorded on the delivery's `inbox` row — the reason and
     * the account, which the identities screen offers for mapping — and changes nothing: the
     * question stays open and no feedback is recorded either, because the words were addressed to
     * the question. From a mapped one it goes to the Question aggregate, which asks the person's
     * role and refuses a second answer (`inbound-decisions.ts`); the text is the redacted delivery
     * (above) and is bounded there, as the task page's answer is.
     */
    if (userId === null) {
      return ignored('unmapped_identity', `${brief(user)} is not mapped to a platform user`, {
        provider: SLACK_PROVIDER_ID,
        external_id: user,
      });
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
export const normaliseSlackDelivery = async (
  delivery: WebhookDelivery,
  context: InboundContext,
  deps: SlackInboundDeps,
): Promise<NormalisedDelivery<CommunicationInboundEvent>> => {
  if (Buffer.byteLength(delivery.body, 'utf8') > deps.maxBodyBytes) {
    return ignored('malformed_payload', `delivery exceeds ${deps.maxBodyBytes} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(delivery.body) as unknown;
  } catch {
    return ignored('malformed_payload', 'delivery body is not JSON');
  }
  /**
   * One pass over the whole delivery, above every branch — the inbound twin of the transport's
   * choke point, and for the same reason: every string below (an answer, a feedback body, the
   * bounded provider text in an `ignored.detail`) is derived from this document, so there is no
   * unredacted copy left for a later reader to pick up by mistake.
   *
   * It runs on the parsed document rather than on `delivery.body`, so a secret Slack escaped in the
   * JSON is still matched; the byte cap above is deliberately on the raw bytes, because that cap is
   * about how much this process is willing to parse.
   */
  const redacted = deps.redactor.redactJson({ body: parsed } as unknown as JsonObject);
  if (redacted.count > 0) {
    deps.onRedaction?.({ action: 'normalise_delivery', count: redacted.count });
  }
  const body = (redacted.value as { body: unknown }).body;
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

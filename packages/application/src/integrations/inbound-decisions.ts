/**
 * A human decision that arrives from a provider is a **command on an aggregate**, never a raw
 * append (WP-43).
 *
 * Until this module the webhook ingress appended whatever a normaliser produced straight onto the
 * project stream. For a notification that is right — a ticket moved, a comment was written, and
 * the event *is* the fact. For `task.approval.decided` and `task.question.answered` it is not: the
 * catalogue's producer of those two is the **Approval** and the **Question** aggregate
 * (technical/02), and the aggregate is where BD-006's rule lives — `decideApproval` asks `can()`
 * whether the decider's role may decide *this kind* of approval, and refuses a second decision.
 * A raw append skipped both: the saga's `approvalHandler` moved the task, the `approvals` row stayed
 * `pending` (so the deadline sweep would later "expire" an approval a human had decided), and a
 * mapped **viewer** could approve a plan from a chat button that the SPA would refuse them.
 *
 * Nothing produced either event from a provider before this row — Slack's normaliser is the only
 * one that does, and no Socket Mode connection was ever opened — so there was no behaviour to
 * preserve, only a door that would have opened the wrong way the day a button could be pressed.
 *
 * ## What it decides, and what it records instead of throwing
 *
 * It runs **inside the delivery's transaction**, so the aggregate's row, its event and the `inbox`
 * row commit together or not at all. Every refusal is a *value*, not an exception, because the
 * direction here is inbound (standing rule 20): a click on a stale button, an approval somebody
 * already decided in the SPA, a decider whose role does not reach — each is recorded on the inbox
 * row with a reason and performs nothing. What *does* throw is what the ingress cannot answer
 * (a database fault), and then the sender redelivers.
 *
 * The subject is re-derived from **the platform's own rows**: the approval or question the payload
 * names must exist, must belong to the task the payload names, and that task must belong to the
 * project whose binding normalised the delivery. A payload is provider text and could name any id
 * (BD-022); the aggregate's own `taskId` is the answer, and a disagreement is a refusal rather than
 * a choice between the two.
 *
 * ## An accepted decision leaves the `human_actions` row the task page's decision leaves (WP-88)
 *
 * Backlog 199: until WP-88 a chat approval was attributed through the aggregate's event and the
 * `inbox` row and nowhere else, while the same decision through
 * `POST /api/tasks/:task_id/approvals/:approval_id/decide` left a `human_actions` row — so the task's
 * audit panel, which pages `human_actions` only, could not say who approved a plan in Slack. The
 * ruling (technical/13, WP-88) is that the chat decision writes its row **in the delivery's
 * transaction**, and that the audit panel keeps one reader. So {@link InboundDecisionApplier.apply}
 * writes one row for an **applied** decision — the mapped user, the task the aggregate names, the
 * route's own `action` spelling and the route's own `params` keys, plus the door: `channel`,
 * `provider`, `integration_id` and `delivery_id` — and **none** for a refused one, exactly the
 * route's rule (*"A refused command writes no `human_actions` row"*, `routes/commands.ts`). No free
 * text is in it: an approval from chat carries no reason, and an answer's words are the question's
 * own column, as they are for the route.
 */
import type { Actor, DomainEvent, Id, JsonObject, UserRole } from '@platform/contracts';
import { answerChannelSchema, MAX_COMMAND_TEXT_CHARS } from '@platform/contracts';
import {
  answerQuestion,
  type CommandContext,
  decideApproval,
  IllegalTransitionError,
  PermissionDeniedError,
} from '@platform/domain';
import type { PipelineStore } from '../pipeline/store.js';
import type { Transaction } from '../ports/transaction.js';

/** The two catalogue events whose producer is an aggregate, never a provider (technical/02). */
export const INBOUND_DECISION_TYPES = ['task.question.answered', 'task.approval.decided'] as const;

export type InboundDecisionType = (typeof INBOUND_DECISION_TYPES)[number];

export const isInboundDecisionType = (type: string): type is InboundDecisionType =>
  (INBOUND_DECISION_TYPES as readonly string[]).includes(type);

/** A normalised draft of one of the two types. The payload is the normaliser's, still untrusted. */
export interface InboundDecisionDraft {
  readonly type: InboundDecisionType;
  readonly payload: unknown;
  readonly actor: Actor;
}

/** Why a decision performed nothing. Recorded on the inbox row, never thrown. */
export type InboundDecisionRefusal =
  /** The approval or question the payload names does not exist. */
  | 'unknown_subject'
  /** It exists, and belongs to another task or another project than the delivery claims. */
  | 'subject_mismatch'
  /** The decider is not an active platform user any more. */
  | 'unknown_decider'
  /** The decider's role does not carry the permission this kind of decision needs (BD-006). */
  | 'not_permitted'
  /** Somebody decided first — the SPA, another channel, or the deadline (first answer wins). */
  | 'already_decided'
  /** The payload is not the shape the catalogue gives the event. */
  | 'malformed_decision';

export type InboundDecisionOutcome =
  | { readonly kind: 'applied'; readonly events: readonly DomainEvent[] }
  | {
      readonly kind: 'refused';
      readonly reason: InboundDecisionRefusal;
      readonly detail: string;
    };

/** Which door a decision came through — what its `human_actions` row names (WP-88). */
export interface InboundDecisionDelivery {
  readonly provider: string;
  readonly integrationId: Id;
  /** `inbox.delivery_id`, already redacted by the adapter that built it. */
  readonly deliveryId: string;
}

export interface InboundDecisionApplier {
  apply(
    tx: Transaction,
    input: {
      readonly projectId: Id;
      readonly draft: InboundDecisionDraft;
      readonly delivery: InboundDecisionDelivery;
    },
  ): Promise<InboundDecisionOutcome>;
}

/** One `human_actions` row, written in the caller's transaction (WP-88, backlog 199). */
export interface InboundHumanActionEntry {
  readonly userId: Id;
  readonly taskId: Id;
  readonly action: string;
  readonly params: JsonObject;
}

/**
 * The `human_actions` writer the applier uses. Append-only, like the table; in the delivery's
 * transaction, so the row commits with the aggregate's decision and the `inbox` row or not at all.
 */
export interface InboundHumanActionLog {
  record(tx: Transaction, entry: InboundHumanActionEntry): Promise<void>;
}

/**
 * The `action` each decision is recorded under — **the route's own spelling**
 * (`apps/server/src/routes/commands.ts`), so the audit panel reads one vocabulary whichever door a
 * person used.
 */
export const INBOUND_DECISION_ACTIONS = {
  'task.approval.decided': 'task.approval.decide',
  'task.question.answered': 'task.question.answer',
} as const satisfies Record<InboundDecisionType, string>;

/**
 * The role a decider holds **for this project** — the higher of the organisation role and a
 * project membership, exactly as the HTTP guard computes it (`apps/server/src/auth/rbac.ts`) — or
 * `null` for a user who is gone or not active.
 */
export interface InboundDeciderRoles {
  roleIn(
    tx: Transaction,
    input: { readonly userId: Id; readonly projectId: Id },
  ): Promise<UserRole | null>;
}

export interface InboundDecisionApplierOptions {
  readonly store: Pick<PipelineStore, 'approvals' | 'questions' | 'tasks'>;
  readonly roles: InboundDeciderRoles;
  /** WP-88: the audit row an accepted decision leaves. Required (rule 31). */
  readonly actions: InboundHumanActionLog;
  /** The command context, with the delivery's own actor substituted by this module. */
  readonly context: (correlationId: Id) => CommandContext;
}

const refused = (reason: InboundDecisionRefusal, detail: string): InboundDecisionOutcome => ({
  kind: 'refused',
  reason,
  detail,
});

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

/** Only the fields this module reads, parsed rather than cast: the payload is a normaliser's. */
const fieldsOf = (payload: unknown): Record<string, unknown> =>
  typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};

const refusalOf = (error: unknown): InboundDecisionOutcome | null => {
  if (error instanceof PermissionDeniedError) {
    return refused('not_permitted', error.message);
  }
  if (error instanceof IllegalTransitionError) {
    return refused('already_decided', error.message);
  }
  return null;
};

export const createInboundDecisionApplier = (
  options: InboundDecisionApplierOptions,
): InboundDecisionApplier => {
  /** The task the aggregate names must be in the project whose binding normalised the delivery. */
  const taskIsInProject = async (tx: Transaction, taskId: Id, projectId: Id): Promise<boolean> => {
    const stored = await options.store.tasks.load(tx, taskId);
    return stored !== null && stored.task.projectId === projectId;
  };

  const contextFor = (taskId: Id, actor: Actor): CommandContext => ({
    ...options.context(taskId),
    // The person who pressed the button, as the normaliser resolved them — never the pipeline.
    actor,
  });

  /**
   * The row an applied decision leaves: the route's `params` keys, then the door (module note).
   * `channel` is the answer vocabulary's (`questions.answered_via`) for an answer, and the
   * provider for an approval, which has no such column — both are `slack` for the one provider
   * that produces either today.
   */
  const audit = async (
    tx: Transaction,
    input: {
      readonly type: InboundDecisionType;
      readonly userId: Id;
      readonly taskId: Id;
      readonly params: JsonObject;
      readonly channel: string;
      readonly delivery: InboundDecisionDelivery;
    },
  ): Promise<void> => {
    await options.actions.record(tx, {
      userId: input.userId,
      taskId: input.taskId,
      action: INBOUND_DECISION_ACTIONS[input.type],
      params: {
        task_id: input.taskId,
        ...input.params,
        channel: input.channel,
        provider: input.delivery.provider,
        integration_id: input.delivery.integrationId,
        delivery_id: input.delivery.deliveryId,
      },
    });
  };

  const approve = async (
    tx: Transaction,
    projectId: Id,
    draft: InboundDecisionDraft,
    userId: Id,
    delivery: InboundDecisionDelivery,
  ): Promise<InboundDecisionOutcome> => {
    const payload = fieldsOf(draft.payload);
    const approvalId = text(payload.approval_id) as Id | null;
    const decision = payload.decision;
    if (approvalId === null || (decision !== 'approved' && decision !== 'rejected')) {
      return refused('malformed_decision', 'an approval decision needs an id and approve/reject');
    }
    const stored = await options.store.approvals.load(tx, approvalId);
    if (stored === null) {
      return refused('unknown_subject', `approval ${approvalId} does not exist`);
    }
    const { approval } = stored;
    if (
      approval.taskId !== text(payload.task_id) ||
      approval.projectId !== projectId ||
      !(await taskIsInProject(tx, approval.taskId, projectId))
    ) {
      return refused('subject_mismatch', `approval ${approvalId} is not this delivery's to decide`);
    }
    const role = await options.roles.roleIn(tx, { userId, projectId });
    if (role === null) {
      return refused('unknown_decider', `user ${userId} is not an active platform user`);
    }
    try {
      const reason = text(payload.reason);
      const decided = decideApproval(
        approval,
        { decision, userId, role, ...(reason === null ? {} : { reason }) },
        contextFor(approval.taskId, draft.actor),
      );
      await options.store.approvals.save(tx, { ...stored, approval: decided.aggregate });
      await audit(tx, {
        type: draft.type,
        userId,
        taskId: approval.taskId,
        // The route's spelling of the decision (`decideApprovalRequestSchema`), not the event's.
        params: {
          approval_id: approvalId,
          decision: decision === 'approved' ? 'approve' : 'reject',
        },
        channel: delivery.provider,
        delivery,
      });
      return { kind: 'applied', events: decided.events };
    } catch (error) {
      const refusal = refusalOf(error);
      if (refusal === null) {
        throw error;
      }
      return refusal;
    }
  };

  const answer = async (
    tx: Transaction,
    projectId: Id,
    draft: InboundDecisionDraft,
    userId: Id,
    delivery: InboundDecisionDelivery,
  ): Promise<InboundDecisionOutcome> => {
    const payload = fieldsOf(draft.payload);
    const questionId = text(payload.question_id) as Id | null;
    const answerText = text(payload.answer);
    const channel = answerChannelSchema.safeParse(payload.channel);
    if (questionId === null || answerText === null || !channel.success) {
      return refused('malformed_decision', 'an answer needs a question id, a text and a channel');
    }
    /**
     * **Bounded like the task page's answer** (WP-88). A chat reply is untrusted text a person
     * typed (BD-022), and the route refuses one past `MAX_COMMAND_TEXT_CHARS` at its contract. It
     * is refused here too rather than cut: a truncated answer is a different answer, recorded as
     * the person's. The refusal is on the delivery's `inbox` row, and the question stays open.
     */
    if (answerText.length > MAX_COMMAND_TEXT_CHARS) {
      return refused(
        'malformed_decision',
        `an answer is at most ${MAX_COMMAND_TEXT_CHARS} characters, as on the task page; this one is ${answerText.length}`,
      );
    }
    const question = await options.store.questions.load(tx, questionId);
    if (question === null) {
      return refused('unknown_subject', `question ${questionId} does not exist`);
    }
    if (
      question.taskId !== text(payload.task_id) ||
      question.projectId !== projectId ||
      !(await taskIsInProject(tx, question.taskId, projectId))
    ) {
      return refused('subject_mismatch', `question ${questionId} is not this delivery's to answer`);
    }
    const role = await options.roles.roleIn(tx, { userId, projectId });
    if (role === null) {
      return refused('unknown_decider', `user ${userId} is not an active platform user`);
    }
    try {
      const answered = answerQuestion(
        question,
        {
          // Already redacted by the adapter's composed redactor (the binding's own credentials
          // plus TD-012's pattern rules) before the normaliser read a byte of it.
          answer: answerText,
          userId,
          role,
          channel: channel.data,
        },
        contextFor(question.taskId, draft.actor),
      );
      await options.store.questions.save(tx, answered.aggregate);
      await audit(tx, {
        type: draft.type,
        userId,
        taskId: question.taskId,
        params: { question_id: questionId },
        channel: channel.data,
        delivery,
      });
      return { kind: 'applied', events: answered.events };
    } catch (error) {
      const refusal = refusalOf(error);
      if (refusal === null) {
        throw error;
      }
      return refusal;
    }
  };

  return {
    apply: async (tx, { projectId, draft, delivery }) => {
      // The decider is the normaliser's `resolveUser` answer, carried on the actor: a normaliser
      // that could not map the author produced no decision at all (`unmapped_identity`).
      if (draft.actor.kind !== 'user') {
        return refused('unknown_decider', 'a decision from a provider needs a mapped person');
      }
      const userId = draft.actor.user_id as Id;
      return draft.type === 'task.approval.decided'
        ? approve(tx, projectId, draft, userId, delivery)
        : answer(tx, projectId, draft, userId, delivery);
    },
  };
};

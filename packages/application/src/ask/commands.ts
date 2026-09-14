/**
 * Recording an ask, from the two doors it can arrive through (WP-31).
 *
 * `POST /api/tasks/:task_id/ask` is one; a ticket comment carrying `@agentic ask` is the other, and
 * it is `ticket.comment.added`'s **first consumer** — that type has been declared `unconsumed` with
 * this work package's name on it since WP-15c gave the inbound door a producer.
 *
 * Both doors converge on {@link recordAsk}, which is transaction-bound so the ticket handler can
 * call it inside its own transaction and the HTTP command can open one. What neither of them does
 * is run anything: the ask is a row and a wake-up, and the run happens in the `task.ask` job, for
 * the reason every other run does — a run takes a minute and an HTTP request must not hold a
 * connection for it (CLAUDE.md's *transaction / no transaction / transaction*).
 *
 * ## What is refused, and where
 *
 * The **question** is bounded and redacted here, at the write, because this is where the store is
 * the consumer (Q54's rule, the same one `ticket-snapshot.ts` applies) — and since WP-31 round 2 so
 * is the asker's provider **label**, which is the other untrusted string this row stores
 * ({@link askIdentityForStorage}). The **identity** is refused in `classifyTicketComment` for the
 * ticket door and is the session's for the HTTP door. The **budget** is not asked here at all: it
 * is asked at admission, in the job, and **again** after the prompt has been built, because a cap
 * that was checked when the question was typed would be a different number by the time the run
 * started (`executor.ts`'s `admissionVerdict`).
 */
import type { Id, IsoDateTime, JsonObject } from '@platform/contracts';
import {
  ASK_TRIGGERS,
  classifyTicketComment,
  MAX_ASK_IDENTITY_LABEL_CHARS,
  MAX_ASK_QUESTION_CHARS,
  type NotAnAskReason,
} from '@platform/domain';
import type { EventHandler, HandlerContext } from '../events/handler.js';
import type { InboundIdentityDirectory } from '../integrations/inbound.js';
import type { PipelineStore } from '../pipeline/store.js';
import type { SecretRedactor } from '../ports/integrations/audit.js';
import type { Jobs } from '../ports/jobs.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { Transaction } from '../ports/transaction.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import type { AskExecuteData } from './executor.js';
import type { AskSource, AskStore } from './store.js';

/**
 * The provider account a `ticket` ask came from, as the caller hands it over.
 *
 * A **shape** rather than the `JsonObject` the column holds, because the column's value is built
 * here: `display_name` is provider text and is bounded and redacted on its way in, and a caller
 * that could hand over a finished object could hand over one that was neither (standing rule 7's
 * shape — put the guard at the write, not at the call site).
 */
export interface AskIdentityInput {
  /** The provider id as the registry knows it. A platform literal from the binding. */
  readonly provider: string;
  /** The account's id **in the provider** — the key the identity map was just resolved through. */
  readonly externalId: string;
  /** What the provider calls them. Unbounded untrusted text (`ExternalIdentity.display_name`). */
  readonly displayName: string | null;
}

export interface RecordAskInput {
  readonly id: Id;
  readonly taskId: Id;
  readonly projectId: Id;
  readonly source: AskSource;
  readonly askedByUserId: Id;
  readonly askedByIdentity: AskIdentityInput | null;
  readonly ticketCommentId: string | null;
  /** The human's words, verbatim and unbounded. Untrusted (BD-022). */
  readonly question: string;
  readonly createdAt: IsoDateTime;
}

export interface RecordAskDeps {
  readonly asks: AskStore;
  readonly redactor: SecretRedactor;
}

export type RecordAskResult =
  | { readonly status: 'recorded'; readonly askId: Id }
  /** The same ticket comment has already produced an ask; nothing was written. */
  | { readonly status: 'duplicate' };

/**
 * The question, as it is stored: redacted first, then cut.
 *
 * The order is WP-30's measurement rather than a preference — truncating first can publish
 * `glpat-FAKE`, a prefix no redaction rule matches, while redacting first publishes the
 * `[REDACTED …]` placeholder and then cuts that. Exported so a test can assert the order on the
 * straddling case without going through a store.
 */
export const askQuestionForStorage = (
  question: string,
  redactor: SecretRedactor,
): { readonly text: string; readonly redactionCount: number } => {
  const redacted = redactor.redactText(question);
  return { text: redacted.value.slice(0, MAX_ASK_QUESTION_CHARS), redactionCount: redacted.count };
};

/**
 * The asker's provider account, as it is stored: the label redacted first, then cut.
 *
 * Two lines from the question that is both, and it was neither until WP-31 round 2.
 * `display_name` arrives from a webhook with **no bound at all** (`ExternalIdentity.display_name`
 * is `z.string().nullish()`), is written to `task_asks.asked_by_identity`, and is read back by the
 * thread and by the prompt's `asked_by` label — so it gets the same treatment `question` gets, in
 * the same order and for the same measured reason (WP-30: cutting first can publish a prefix no
 * rule matches).
 *
 * The other two fields are deliberately untouched, so their absence is a decision. `provider` is a
 * platform literal — the binding's own id, from a closed set the registry knows. `externalId` is a
 * **key**: the handler has just resolved it through `user_identities` to get a platform user, and
 * redacting a key trades a leak for a collision (standing rule 70) — it would store an account id
 * that resolves to nobody, on a row whose purpose is to say which account asked.
 */
export const askIdentityForStorage = (
  identity: AskIdentityInput,
  redactor: SecretRedactor,
): { readonly value: JsonObject; readonly redactionCount: number } => {
  const label = identity.displayName === null ? null : redactor.redactText(identity.displayName);
  return {
    value: {
      provider: identity.provider,
      external_id: identity.externalId,
      display_name: label === null ? null : label.value.slice(0, MAX_ASK_IDENTITY_LABEL_CHARS),
    },
    redactionCount: label?.count ?? 0,
  };
};

export const recordAsk = async (
  tx: Transaction,
  deps: RecordAskDeps,
  input: RecordAskInput,
): Promise<RecordAskResult> => {
  const stored = askQuestionForStorage(input.question, deps.redactor);
  const identity =
    input.askedByIdentity === null
      ? null
      : askIdentityForStorage(input.askedByIdentity, deps.redactor);
  const outcome = await deps.asks.insert(tx, {
    id: input.id,
    taskId: input.taskId,
    projectId: input.projectId,
    source: input.source,
    askedByUserId: input.askedByUserId,
    askedByIdentity: identity?.value ?? null,
    ticketCommentId: input.ticketCommentId,
    question: stored.text,
    // Summed over both untrusted strings this row stores, for the reason the answer's count is
    // summed over four: a count that named one field would read as "nothing else needed it".
    redactionCount: stored.redactionCount + (identity?.redactionCount ?? 0),
    createdAt: input.createdAt,
  });
  return outcome === 'duplicate'
    ? { status: 'duplicate' }
    : { status: 'recorded', askId: input.id };
};

export const enqueueAsk = async (jobs: Jobs, data: AskExecuteData): Promise<void> => {
  await jobs.enqueue<AskExecuteData>({
    queue: JOB_QUEUES.taskAsk,
    data,
    // `stately` per ask, so a redelivered wake-up for the same question collapses rather than
    // starting a second paid run. The key is the **ask**, not the task: two people asking two
    // questions about one task are two runs, and serialising them would make the second wait for
    // the first for no reason a human would recognise.
    singletonKey: `ask:${data.ask_id}`,
  });
};

export interface AskCommandDeps extends RecordAskDeps {
  readonly unitOfWork: UnitOfWork;
  readonly jobs: Jobs;
  readonly logger?: Logger;
}

/**
 * The HTTP door: record the question, then wake the job.
 *
 * The enqueue is **after** the commit for the reason `HandlerContext.afterCommit` exists —
 * `Jobs.enqueue` does not join the transaction, so an enqueue written inside it is durable even
 * when the write rolls back. A crash between the two loses the wake-up and leaves a `pending` ask,
 * which `task_asks_pending_idx` exists to find; that recovery is filed rather than built, and the
 * residual is the same one `onboarding/discovery.ts` states for a discovery task.
 */
export const askTaskCommand = async (
  deps: AskCommandDeps,
  input: RecordAskInput,
): Promise<RecordAskResult> => {
  const result = await deps.unitOfWork.transaction((scope) => recordAsk(scope.tx, deps, input));
  if (result.status === 'recorded') {
    await enqueueAsk(deps.jobs, {
      ask_id: result.askId,
      task_id: input.taskId,
      project_id: input.projectId,
    });
  }
  return result;
};

export interface AskHandlerOptions {
  readonly asks: AskStore;
  readonly store: PipelineStore;
  /**
   * `user_identities`, the same map the inbound normaliser decided `verified` from.
   *
   * The handler has to read it a second time because `ExternalIdentity` carries **`verified` and
   * not the platform user id** — the normaliser answers "does this account map to somebody" and
   * throws the answer away. Re-resolving here rather than widening a shipped event payload is the
   * cheaper of the two, and it is the same read: `forProvider` is a primary-key prefix scan whose
   * row count is the number of accounts an operator has mapped.
   *
   * PROGRESS backlog **79**: the table's **writer** is `POST /api/org/identities` (this work
   * package), because the two automatic routes are refused on purpose — an OAuth sign-in with the
   * provider, which TD-022 does not ship, and an email match the platform performed itself, which
   * would let a *guessed* identity spend a budget and, through the other consumers of the same
   * table, answer questions and approve plans (BD-022, Q10).
   */
  readonly identities: InboundIdentityDirectory;
  readonly redactor: SecretRedactor;
  readonly jobs: Jobs;
  readonly ids: { next(): Id };
  readonly clock: { now(): IsoDateTime };
  readonly logger?: Logger;
}

/** Why a `ticket.comment.added` produced no ask — the classifier's reasons plus this handler's. */
export type TicketAskOutcome =
  | NotAnAskReason
  /** The comment names a ticket this platform has no task for. */
  | 'no_task'
  /** The same comment has already produced an ask (a redelivered webhook). */
  | 'duplicate';

/**
 * `ticket.comment.added` → at most one ask (WP-31, criterion 5).
 *
 * Registered in TD-005's **core** band beside the rest of the pipeline's own decisions, at a
 * priority after intake: the handler needs the task to exist, and a comment on a ticket the platform
 * picked up in the same delivery would otherwise race it. A comment for which there is no task is
 * not an error — most tickets in a project are not the platform's.
 *
 * Every branch produces a **named** outcome and the log line carries it, which is what makes
 * criterion 5's *"classified in both directions"* assertable: a test drives a plain remark, the
 * platform's own workpad comment, an unverified author and a real ask, and reads four different
 * reasons rather than one absence.
 */
export const askHandlers = (options: AskHandlerOptions): readonly EventHandler[] => {
  const logger = options.logger ?? silentLogger;
  return [
    {
      name: 'ask.ticket.comment',
      // Core band, after `pipeline.intake` (10) and the task's own transitions, before the
      // integrations band writes anything back to the provider.
      priority: 60,
      eventTypes: ['ticket.comment.added'],
      handle: async (context: HandlerContext): Promise<void> => {
        const payload = context.event.event.payload as {
          project_id: string;
          ticket: { provider: string; key: string; url: string };
          comment_id: string;
          author: {
            external_id: string;
            provider: string;
            display_name?: string | null;
            verified: boolean;
          };
          text: string;
        };
        const done = (outcome: TicketAskOutcome): void => {
          logger.debug(
            {
              project_id: payload.project_id,
              ticket_key: payload.ticket.key,
              comment_id: payload.comment_id,
              outcome,
            },
            'a ticket comment was classified for ask-the-task',
          );
        };

        const verdict = classifyTicketComment({
          text: payload.text,
          authorVerified: payload.author.verified === true,
        });
        if (verdict.kind === 'not_an_ask') {
          done(verdict.reason);
          return;
        }
        const askedByUserId = (await options.identities.forProvider(payload.author.provider)).get(
          payload.author.external_id,
        );
        if (askedByUserId === undefined) {
          // `verified` said this account maps to somebody and the map says otherwise — a mapping
          // deleted between the delivery and this handler. Fail closed, with the same reason the
          // classifier uses, so the two cases read as one fact to whoever is looking.
          done('unverified_identity');
          return;
        }
        const task = await options.store.tasks.findByTicket(context.scope.tx, {
          projectId: payload.project_id as Id,
          provider: payload.ticket.provider,
          ticketKey: payload.ticket.key,
          // An ask is about the real task. A shadow run of the same ticket is a different task and
          // is not what somebody commenting on the ticket is asking about.
          mode: 'normal',
        });
        if (task === null) {
          done('no_task');
          return;
        }
        const askId = options.ids.next();
        const recorded = await recordAsk(
          context.scope.tx,
          { asks: options.asks, redactor: options.redactor },
          {
            id: askId,
            taskId: task.task.id,
            projectId: task.task.projectId,
            source: 'ticket',
            askedByUserId,
            askedByIdentity: {
              provider: payload.author.provider,
              externalId: payload.author.external_id,
              displayName: payload.author.display_name ?? null,
            },
            ticketCommentId: payload.comment_id,
            question: verdict.question,
            createdAt: options.clock.now(),
          },
        );
        if (recorded.status === 'duplicate') {
          done('duplicate');
          return;
        }
        context.afterCommit(async () => {
          await enqueueAsk(options.jobs, {
            ask_id: recorded.askId,
            task_id: task.task.id,
            project_id: task.task.projectId,
          });
        });
        logger.info(
          {
            project_id: payload.project_id,
            task_id: task.task.id,
            ask_id: recorded.askId,
            trigger: ASK_TRIGGERS[0],
          },
          'a ticket comment asked the task a question',
        );
      },
    },
  ];
};

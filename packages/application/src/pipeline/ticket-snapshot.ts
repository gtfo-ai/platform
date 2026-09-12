/**
 * The ticket's own words — read once, bounded, redacted, and stored on the task (WP-15f).
 *
 * ## What was wrong
 *
 * `tasks` held `ticket_provider`/`ticket_key`/`ticket_url` and nothing else, `ticketRefSchema` is
 * `{provider, key, url}`, and `ticket.matched` carries no title, so the two things built to consume
 * the ticket's *content* were handed its *identity*: the prompt's task block was three lines, and
 * the retrieval query at the first agent stage was the ticket key alone
 * (`extractQueryTerms('ACME-1')` → `["acme"]`). `TaskManagementPort.readTicket` already returned
 * everything that was missing and had **no production caller**. PROGRESS backlog 23 is the
 * evidence; **Q61** is the product decision this implements.
 *
 * ## Where the fetch happens, and why it is not a fourth `pipeline.outbound` duty
 *
 * Q61 (3) proposes a fourth duty beside `intake_check`/`workpad`/`status`. Measured against the
 * acceptance criterion — *"the assembled prompt at the **first** agent stage contains the ticket's
 * title and description"* — a fourth duty **cannot hold it**, and the reason is an ordering read
 * off the code rather than a race anyone has to reproduce:
 *
 * 1. `runIntakeCheck` creates the task and appends `task.created` / `task.stage.entered` in one
 *    transaction, then calls `enqueueStage` **immediately** (`saga.ts`, the line after the commit);
 * 2. a fourth duty could only be woken by a handler of one of those events, which runs when the
 *    outbox *sweeps* them — after that commit, therefore after or beside the `enqueueStage`;
 * 3. the duty would then have to resolve the project's bindings (a `bindings` read, a `secrets`
 *    read and an envelope decryption) and complete a provider round trip before the stage worker
 *    reaches `planner.plan`.
 *
 * Nothing orders those, so the criterion would be held by luck. So the fetch happens at the two
 * places that *are* ordered with respect to the prompt, and the property Q61's clause exists to buy
 * — outside every transaction, through `IntegrationActionExecutor` — is kept by both:
 *
 *  - **`intake_check`**, which is a `pipeline.outbound` duty, in its "call" phase beside the
 *    branch-protection read. The snapshot is part of the `insert` that creates the task, so the row
 *    exists with it and there is no write to lose (see below);
 *  - **the `stage.execute` job**, before an agent stage runs, when the task has no snapshot yet —
 *    {@link ensureTicketSnapshot}. That is the self-healing half: a task whose intake fetch failed,
 *    a task started before this migration, or a project whose task-management binding was added
 *    afterwards all get the ticket's words at the next stage.
 *
 * `assertOutsideTransaction` refuses both mechanically if a later change moves either inside a
 * transaction, which is WP-15d's guard and not a promise made here.
 *
 * ## The lost-update trap, and how it is avoided rather than survived
 *
 * A job writing a task row beside the stage executor is PROGRESS backlog entry **18** — `save` is a
 * whole-row write, and WP-15d measured a task finishing with `cost_actual` 2.40 where 2.80 was
 * owed. Two things keep this out of that class:
 *
 *  - intake writes the snapshot in the `insert` that **creates** the row, so no other writer exists
 *    yet;
 *  - the backfill uses {@link TaskRepository.saveTicketSnapshot}, one `update … set
 *    ticket_snapshot = …, ticket_snapshot_at = …`, exactly as `saveWorkpad` does.
 *
 * There is **no new `tasks.save` call site**. `save`'s own column list does not include
 * `ticket_snapshot`, so the twenty existing `save` sites cannot overwrite it either.
 *
 * ## Freshness — what Q61 (b) asks for, and what this build can hold
 *
 * Q61 (b) asks for a re-read *"when the snapshot predates the task's last provider signal"*. **That
 * quantity does not exist in this build.** The only provider signals about a ticket are
 * `ticket.comment.added` and `ticket.status.changed`; both are declared `unconsumed`
 * (`events/consumption.ts`), both carry a **nullish** `task_id`, and both are appended to the
 * *project* stream (`integrations/inbound.ts`), so nothing on a task row or in a task-scoped query
 * can answer "when was this task last told something by the provider". Producing it means either a
 * new consumer for those two types — WP-24's and WP-31's work, and exactly the "two-provider change
 * by implication" that Q61 (b) refuses for `ticket.updated` — or an unbounded scan of the project
 * stream with no port to do it through.
 *
 * So the implementable half ships and the rest is stated: the re-read at stage start happens when
 * the snapshot is **absent**, and a description a human edits after intake is invisible until the
 * task's next task-management binding change. Closing it needs the `ticket.updated` normalisation
 * Q61 (b) rules out of this work package.
 */
import type { Id, IsoDateTime, TicketSnapshot, TicketSnapshotComment } from '@platform/contracts';
import { ticketSnapshotSchema } from '@platform/contracts';
import { TransactionOpenError } from '../events/open-transaction.js';
import type { SecretRedactor } from '../ports/integrations/audit.js';
import type {
  Ticket,
  TicketComment,
  TicketRefInput,
} from '../ports/integrations/task-management.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import type { PipelineIntegrations, PipelineIntegrationsPort } from './integrations.js';
import { integrationsForProject, noRunScopedSecrets, ticketReads } from './integrations.js';
import type { PipelineStore, StoredTask } from './store.js';

/**
 * ## The byte budget, and where the numbers came from
 *
 * Q54 measured one unbounded `readTicket` at **53 284 565 bytes** across 8 unbounded paths, and its
 * answer was *bound at the consumer, not in the adapter*. Here the consumer is the **store**, so
 * the cut happens at the write and is declared on the row (`truncated`, `comment_count`).
 *
 * Q61 proposed 1 KiB / 64 KiB / 20 × 4 KiB and said explicitly that the numbers were a proposal.
 * These are derived instead, from three figures already in the repository:
 *
 * | figure | value | where it comes from |
 * |---|---|---|
 * | the knowledge pack's budget | 12 000 tokens | `DEFAULT_CONTEXT_BUDGET_TOKENS` |
 * | the estimator | 4 UTF-8 bytes per token, and ~2.5 *characters* per token for real prose | `BYTES_PER_TOKEN`, and the vendor datum its docblock cites |
 * | the cap the same prompt already applies to one prior artifact | 20 000 characters | `MAX_ARTIFACT_CHARS` |
 *
 * The reasoning is one sentence: **the ticket is one document in the task block, so it is bounded
 * like one** — the description gets exactly `MAX_ARTIFACT_CHARS`, and the whole comment thread gets
 * one more description's worth, so a thread can never outweigh the ticket it hangs off. Characters
 * rather than bytes because the two neighbouring caps in the same prompt are in characters, and
 * because a byte cut can split a surrogate pair.
 *
 * What that buys, worst case, with every cap at its limit:
 *
 * - text: `512 + 20 000 + 20 × (128 + 128 + 1 000)` = **45 632 characters**
 *   ({@link TICKET_SNAPSHOT_MAX_TEXT_CHARS}, pinned by a test that feeds a hostile ticket through);
 * - storage: at most 4 UTF-8 bytes per character, so **182 528 bytes ≈ 178 KiB** before JSON
 *   escaping — a **292×** reduction on Q54's measured figure;
 * - prompt: for ASCII, `estimateTokens` reads 45 632 bytes as **11 408** tokens. That is **additive to**
 *   the 12 000-token pack budget rather than inside it — the ticket block and the knowledge documents are
 *   separate regions of one user prompt — so the statement is *the ticket can equal the knowledge base* — the ticket may equal the knowledge base, never dwarf
 *   it. (Astral text costs four bytes a character and is estimated at four times that; the bound
 *   that matters for a context window is the character one, which is why the caps are in
 *   characters.)
 *
 * Every cap is a cut with a marker, never a refusal: a ticket nobody can shorten must still start a
 * task (standing rule 20).
 */
export const MAX_TICKET_TITLE_CHARS = 512;
/** {@link MAX_TICKET_TITLE_CHARS} and friends: see the budget table above. */
export const MAX_TICKET_DESCRIPTION_CHARS = 20_000;
export const MAX_TICKET_COMMENTS = 20;
export const MAX_TICKET_COMMENT_CHARS = 1_000;
/** A display name and a provider-chosen comment id are still provider text, so both are bounded. */
export const MAX_TICKET_AUTHOR_CHARS = 128;
export const MAX_TICKET_COMMENT_ID_CHARS = 128;

/** The sum of every text cap above — the figure the hostile-ticket test pins. */
export const TICKET_SNAPSHOT_MAX_TEXT_CHARS =
  MAX_TICKET_TITLE_CHARS +
  MAX_TICKET_DESCRIPTION_CHARS +
  MAX_TICKET_COMMENTS *
    (MAX_TICKET_COMMENT_ID_CHARS + MAX_TICKET_AUTHOR_CHARS + MAX_TICKET_COMMENT_CHARS);

interface Cut {
  readonly text: string;
  readonly truncated: boolean;
}

const cut = (text: string, max: number): Cut =>
  text.length <= max ? { text, truncated: false } : { text: text.slice(0, max), truncated: true };

/** Accumulates the redactor's count across every field of one snapshot. */
interface Redacting {
  count: number;
}

/**
 * Redact **then** cut, in that order and never the other way round.
 *
 * An exact-match redactor cannot find a secret a cap has already halved — the same argument
 * `inbound.ts` makes at its refusal path. The cost is one pass over whatever the provider sent
 * (which the adapter has already parsed into memory), and the residual is that a cut may land
 * inside a *placeholder*, which is harmless: half of `[REDACTED:integration:jira]` is not a
 * credential.
 *
 * `count` is therefore over the text as it was **read**, not as it is stored. That is the direction
 * that keeps the signal: a snapshot whose secret was cut off still says a secret was there.
 */
const clean = (raw: string, max: number, redactor: SecretRedactor, tally: Redacting): Cut => {
  const redacted = redactor.redactText(raw);
  tally.count += redacted.count;
  return cut(redacted.value, max);
};

/** A timestamp the platform can read back, or `null` — never an invented one. */
const isoOrNull = (value: string | null | undefined): IsoDateTime | null => {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : (new Date(parsed).toISOString() as IsoDateTime);
};

/** Sorts newest first, treating an unreadable timestamp as oldest so it is dropped first. */
const byNewest = (left: TicketComment, right: TicketComment): number =>
  (Date.parse(right.created_at) || 0) - (Date.parse(left.created_at) || 0);

/**
 * The newest {@link MAX_TICKET_COMMENTS} comments a **human** wrote, oldest first.
 *
 * Decision (a) of Q61, taken as proposed: comments are **in**. Excluding them makes the
 * investigator stage read a ticket everyone else has already answered, and a bug ticket's decisive
 * detail is usually in the thread.
 *
 * The platform's own comments are skipped. `marker_id` is non-null exactly when the platform wrote
 * the comment (the port says so, and it is how BD-023's workpad is found again), so feeding them
 * back would show an agent the stage checklist the platform rendered *about this task* as if a
 * human had written it. A provider that never populates `marker_id` skips nothing, which is the
 * harmless direction.
 *
 * Oldest first at the end, because a thread reads forwards; the *selection* is newest-first
 * because a 500-comment ticket's decisive detail is at the bottom.
 */
const commentsOf = (
  ticket: Ticket,
  redactor: SecretRedactor,
  tally: Redacting,
): { readonly comments: readonly TicketSnapshotComment[]; readonly total: number } => {
  const human = ticket.comments.filter(
    (comment) => comment.marker_id === null || comment.marker_id === undefined,
  );
  const newest = [...human].sort(byNewest).slice(0, MAX_TICKET_COMMENTS);
  const comments = [...newest].reverse().map((comment): TicketSnapshotComment => {
    const body = clean(comment.body, MAX_TICKET_COMMENT_CHARS, redactor, tally);
    return {
      id: clean(comment.id, MAX_TICKET_COMMENT_ID_CHARS, redactor, tally).text,
      author: clean(comment.author.display_name ?? '', MAX_TICKET_AUTHOR_CHARS, redactor, tally)
        .text,
      created_at: isoOrNull(comment.created_at),
      body: body.text,
      truncated: body.truncated,
    };
  });
  return { comments, total: human.length };
};

/**
 * A `Ticket` as the task row stores it: bounded, redacted, and honest about what it dropped.
 *
 * Pure, so the bounds are unit-testable without a provider, and total: there is no input for which
 * this throws. The closing `parse` is the one place the builder is held to the published shape —
 * every field above is already normalised into something the schema accepts, so it cannot fire for
 * a provider's data, only for a drift in this function.
 */
export const boundTicketSnapshot = (ticket: Ticket, redactor: SecretRedactor): TicketSnapshot => {
  const tally: Redacting = { count: 0 };
  const title = clean(ticket.title, MAX_TICKET_TITLE_CHARS, redactor, tally);
  const description = clean(ticket.description, MAX_TICKET_DESCRIPTION_CHARS, redactor, tally);
  const { comments, total } = commentsOf(ticket, redactor, tally);
  return ticketSnapshotSchema.parse({
    title: title.text,
    description: description.text,
    comments: [...comments],
    truncated:
      title.truncated ||
      description.truncated ||
      total > comments.length ||
      comments.some((comment) => comment.truncated),
    comment_count: total,
    redaction_count: tally.count,
    ticket_updated_at: isoOrNull(ticket.updated_at),
  } satisfies TicketSnapshot);
};

/** What a fetch needs: the bindings, and a clock for `ticket_snapshot_at`. */
export interface TicketSnapshotOptions {
  readonly integrations: PipelineIntegrationsPort;
  readonly clock: { now(): string };
  readonly logger?: Logger;
}

export interface TicketSnapshotRequest {
  readonly projectId: Id;
  /** `null` at intake: the task does not exist yet, and `integration_actions.task_id` allows it. */
  readonly taskId: Id | null;
  readonly ticket: TicketRefInput;
}

/**
 * Reads the ticket through the executor and bounds it, or answers `null`.
 *
 * `null` for every reason a ticket's text can be unavailable — no task-management binding, a
 * provider that refuses, a network failure, **and a binding that will not load** (a provider this
 * build does not register, a config that fails its schema, a credential that will not decrypt:
 * `BindingLoadError`). The last one is worth naming rather than leaving to "every reason", because
 * it is an *operator* error degrading every prompt behind a `warn` where `runIntakeCheck`'s own
 * `integrationsForProject` call fails the job loudly for the same cause. That asymmetry is rule 20
 * applied per call rather than per binding — the branch check decides whether a task may *start*
 * (fail closed), this decides how good its prompt is (fail open) — and the loud half is not lost,
 * because the same misconfiguration stops the task at intake anyway. It **logs** rather than
 * throwing, because this is
 * a read that makes a prompt better and never a mutation that must not be lost: a Jira outage that
 * stopped tasks from starting would be a worse product than one that starts them without the
 * thread (standing rule 20). The absent snapshot is spelled `null` on the row and the next stage
 * tries again, so the failure is recoverable rather than permanent (standing rule 18).
 */
export const readTicketSnapshot = async (
  options: TicketSnapshotOptions,
  request: TicketSnapshotRequest,
  integrations?: PipelineIntegrations,
): Promise<TicketSnapshot | null> => {
  const logger = options.logger ?? silentLogger;
  try {
    // Outside a run: nothing on this path holds a minted credential (Q55).
    const resolved =
      integrations ??
      (await integrationsForProject(options.integrations, request.projectId, noRunScopedSecrets()));
    if (resolved.taskManagement === null) {
      return null;
    }
    const ticket = await ticketReads(resolved).ticket(request.ticket, {
      projectId: request.projectId,
      taskId: request.taskId,
    });
    if (ticket === null) {
      return null;
    }
    return boundTicketSnapshot(ticket, resolved.taskManagement.redactor);
  } catch (error) {
    /**
     * **`TransactionOpenError` is not a provider failure and is rethrown** (review round 1).
     *
     * One `catch` was doing two jobs and could not tell "Jira is down" from "a later change moved
     * this call inside a transaction". Measured, before this line existed:
     * `withOpenTransaction(() => readTicketSnapshot(…))` answered `{threw: false, value: null}` —
     * so WP-15d's guard was **disarmed on both call sites** (intake's `read()` is inside this
     * `try` too), and a moved call would have held a pooled connection across a provider round trip
     * *and* silently dropped the ticket text. `open-transaction.ts` says why there is no soft
     * landing for it: "the *only* correct response is to move the call: there is no retry, no
     * fallback and no configuration that makes it right."
     *
     * Everything else still fails open, which is the half that must stay (standing rule 20).
     */
    if (error instanceof TransactionOpenError) {
      throw error;
    }
    logger.warn(
      {
        project_id: request.projectId,
        task_id: request.taskId,
        ticket_key: request.ticket.key,
        err: error,
      },
      'the ticket could not be read; this task runs without the ticket text until a later stage reads it',
    );
    return null;
  }
};

export interface EnsureTicketSnapshotOptions extends TicketSnapshotOptions {
  readonly store: PipelineStore;
  readonly unitOfWork: UnitOfWork;
}

/**
 * The stage-start half: read the ticket if the task has none, and remember it narrowly.
 *
 * Called from the `stage.execute` job before an **agent** stage runs, which is the only consumer —
 * a gate builds no prompt. It is a no-op for a task that already has a snapshot, so the normal path
 * costs one already-loaded field and no provider call.
 *
 * Three properties worth stating because a reviewer should be able to check them:
 *
 *  - it runs **between** the job's transactions, never inside one, so it holds no pooled connection
 *    while the provider answers (`assertOutsideTransaction` refuses if that changes, and
 *    `readTicketSnapshot` rethrows that refusal rather than absorbing it);
 *  - the task is **handed in**, not re-loaded: the `stage.execute` job has just read the row to
 *    resolve the stage, so the ordinary path — a task that already has its snapshot — costs one
 *    field and **no transaction at all**;
 *  - it writes with `saveTicketSnapshot` — two columns — because this transaction runs beside the
 *    stage executor's own, which is PROGRESS backlog 18's interleaving exactly;
 *  - it re-loads inside the write transaction and skips if somebody else got there first, so two
 *    concurrent attempts cost one extra provider read and never a conflicting write.
 */
export const ensureTicketSnapshot = async (
  options: EnsureTicketSnapshotOptions,
  stored: StoredTask,
): Promise<void> => {
  const taskId = stored.task.id;
  if (stored.ticketSnapshot !== null) {
    return;
  }
  const snapshot = await readTicketSnapshot(options, {
    projectId: stored.task.projectId,
    taskId: stored.task.id,
    ticket: stored.task.ticket,
  });
  if (snapshot === null) {
    return;
  }
  await options.unitOfWork.transaction(async (scope) => {
    const current = await options.store.tasks.load(scope.tx, taskId);
    if (current === null || current.ticketSnapshot !== null) {
      return;
    }
    await options.store.tasks.saveTicketSnapshot(
      scope.tx,
      taskId,
      snapshot,
      options.clock.now() as IsoDateTime,
    );
  });
};

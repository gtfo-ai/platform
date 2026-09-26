/**
 * Ask-the-task, the part with no I/O — product/10:57, product/18:34, Q72 (WP-31).
 *
 * An **ask** is a human question about a task that the platform answers *from its own record*:
 * *"A thread on the task page (and mirrored in the ticket thread) where anyone with access can ask
 * 'why did you choose X?'; answered from the audit trail and artifacts with links to the exact run
 * and prompt"*. Q72 decided the four things no document said, and each was chosen so that the ask
 * **inherits** a mechanism rather than adding one:
 *
 *  - it is a **run on the existing task with no stage** (`runs.task_stage_id` is nullable and
 *    technical/03:40-42 names ask-the-task as one of the three run kinds that use it), so the
 *    admission guard, the cost ledger, the transcript sink, the budget cap and the escalation are
 *    the ones every run gets;
 *  - its tools are read-only over **platform** data — no file tool, no shell, no git. Since WP-74
 *    that also means **no checkout**: the run gets a container (the CLI has no other transport)
 *    with an empty working directory, never the repository;
 *  - the per-question budget is a low cap charged to the task's own spend;
 *  - the ticket mirror is **off by default**.
 *
 * This module holds the parts of that with no side effects: the caps, the two constants a
 * composition root and a planner must agree on, the rule that keeps an answer out of a later
 * stage's prompt, and the classification of a ticket comment. The run itself, the storage and the
 * outbound comment are `packages/application/src/ask/`.
 */
import type { ArtifactType } from '@platform/contracts';

/** `agent_role` and `run_mode` both gained this value in migration 0024. */
export const ASK_ROLE = 'ask' as const;
export const ASK_RUN_MODE = 'ask' as const;

/**
 * The model an ask runs on — product/18:34's *"default Sonnet 5"*, BD-013's verification model.
 *
 * A default rather than a constant: `features.ask.model` overrides it, because a model id is the
 * provider's vocabulary and a project that has moved on should not need a platform release.
 */
export const DEFAULT_ASK_MODEL = 'claude-sonnet-5';

/**
 * What one question may cost — Q72 (c), *"start at $0.50, revisit with real numbers"*.
 *
 * It is two things at once and deliberately one number: the run's `limits.maxBudgetUsd`, and what
 * admission adds to the task's spend before comparing against the task cap. A cap compared only
 * against *past* spend is a cap discovered one run too late, which is the argument
 * `taskBudgetExhausted` already makes for a stage.
 */
export const DEFAULT_ASK_BUDGET_USD = 0.5;

/**
 * How much of a human's question the platform stores and sends to a model.
 *
 * Derived rather than chosen, from the two things on either side of it. Below: a question is one
 * or two sentences — product/10's example is *"why did you choose X?"* — and the longest useful
 * one is a paragraph, so 4 000 characters is roughly ten paragraphs. Above: the question is
 * rendered into a prompt beside a context pack whose own budget is
 * `DEFAULT_CONTEXT_BUDGET_TOKENS` (30 000 tokens ≈ 120 000 characters); at 4 000 it is about 3 %
 * of the pack, so a question can never crowd out the record it is asking about. It is also the
 * fourth place the platform stores untrusted external text, after `inbox`, `kb_chunks` and
 * `tasks.ticket_snapshot`, and the smallest of the four — which is right for the one a stranger
 * can post into a ticket thread.
 */
export const MAX_ASK_QUESTION_CHARS = 4_000;

/**
 * How much of the model's answer the platform stores.
 *
 * `askAnswerDataSchema.answer` is capped at 20 000 by the contract the run is validated against, so
 * this is the same number rather than a second one: a bound here that was *lower* would truncate an
 * answer the platform had already accepted and paid for, and one that was higher would be a claim
 * the schema does not support.
 */
export const MAX_ASK_ANSWER_CHARS = 20_000;

/**
 * How much of a provider's label for the asker the platform stores.
 *
 * `ExternalIdentity.display_name` is `z.string().nullish()` with **no bound** — it is whatever a
 * ticket tracker put in the webhook — and it is written to `task_asks.asked_by_identity`, which is
 * read back by the thread and by the prompt's `asked_by` attribute. 256 is not a new number: it is
 * the bound `createIdentityMappingRequestSchema.display_name` already puts on the same label when
 * an *operator* types it (`POST /api/org/identities`), and a name a person answers to is far
 * shorter than that. Bounded **after** redacting, for the reason `askQuestionForStorage` states.
 */
export const MAX_ASK_IDENTITY_LABEL_CHARS = 256;

/**
 * Artifact types a later stage's prompt never carries.
 *
 * `AskAnswer` is the only member, and it is here rather than as a branch in the planner because it
 * is a statement about the artifact type, not about the caller. Two reasons, both about the
 * delivery pipeline rather than about the ask:
 *
 *  - an ask's answer is a model's prose *about the audit trail*, which is not an input to writing
 *    code — a Refinement or an Implementation run that read it would be spending context on the
 *    platform talking to itself;
 *  - a human's question is untrusted text (BD-022) that the ask agent may legitimately quote into
 *    its answer, so carrying the answer forward would route a stranger's ticket comment into every
 *    later stage's prompt through a second door.
 *
 * It does **not** hide the answer from a human: `GET /api/tasks/:task_id/asks` serves the thread and
 * the artifact is a row like any other.
 */
export const PROMPT_EXCLUDED_ARTIFACT_TYPES: readonly ArtifactType[] = ['AskAnswer'];

export const isPromptExcludedArtifact = (type: ArtifactType): boolean =>
  PROMPT_EXCLUDED_ARTIFACT_TYPES.includes(type);

/**
 * The trigger a ticket comment carries to be an ask — **Q81**, filed with this recommendation and
 * implemented.
 *
 * The platform already answers to `@agentic` in a ticket or merge-request thread: product/07:42's
 * `@agentic remember: <text>` and product/04:84's `@agentic hold` / `@agentic rework`. Nothing said
 * what an *ask* looks like there, so it is the same prefix with the verb this feature is named
 * after, plus the one product/10:57 actually writes down (*"why did you choose X?"*) as a synonym.
 *
 * The match is deliberately narrow: the trigger must open the comment (after whitespace), and a
 * comment that merely mentions `@agentic` somewhere in a paragraph is **not** an ask. A wider rule
 * would turn every mention of the bot into a paid run, which is the direction rule 20 refuses for
 * something that spends money on somebody else's ticket.
 */
export const ASK_TRIGGERS = ['@agentic ask', '@agentic why'] as const;

/**
 * Markers the platform writes into its own ticket comments.
 *
 * A comment the platform posted comes back through the provider's webhook exactly like a human's,
 * and answering our own workpad would be a loop that spends a budget per render. Two mechanisms
 * stop it and both are wanted: the author of a platform comment is the integration's bot account,
 * which maps to no platform user and is therefore **unverified**; and the body carries one of these
 * markers. The marker check is here because it is the one that still holds on the day somebody
 * gives the bot account a `user_identities` row.
 */
export const PLATFORM_COMMENT_MARKERS = ['agentic:task:', 'agentic:ask:'] as const;

/** How a ticket comment reached the classifier, and what the platform did with it. */
export type TicketCommentVerdict =
  /** It is an ask, and this is the question with the trigger removed. */
  | { readonly kind: 'ask'; readonly question: string }
  /** It is not an ask. `reason` is a platform literal, safe to log and to count. */
  | { readonly kind: 'not_an_ask'; readonly reason: NotAnAskReason };

export type NotAnAskReason =
  /** No `@agentic ask` / `@agentic why` at the start of the comment — an ordinary remark. */
  | 'no_trigger'
  /** The platform's own comment: the body carries a marker this platform writes. */
  | 'platform_comment'
  /** The trigger with nothing after it. */
  | 'empty_question'
  /**
   * The author maps to no platform user (technical/02:161, BD-022, Q10).
   *
   * On a build where `user_identities` has no rows this is **every** ticket comment, and the change
   * that says so is the mapping endpoint beside this one (`POST /api/org/identities`): until an
   * operator maps the account, the fail-closed answer is that a stranger with a ticket-tracker
   * login cannot spend a project's budget. An account an operator declared a **machine** (WP-61,
   * migration 0045) lands here too: it maps to nobody on purpose, and the inbound directory skips it.
   */
  | 'unverified_identity';

const startsWithTrigger = (text: string): string | null => {
  const trimmed = text.trimStart();
  const lowered = trimmed.toLowerCase();
  for (const trigger of ASK_TRIGGERS) {
    if (lowered.startsWith(trigger)) {
      return trimmed.slice(trigger.length);
    }
  }
  return null;
};

export interface TicketCommentInput {
  /** The comment's body, verbatim. Untrusted (BD-022). */
  readonly text: string;
  /** `ExternalIdentity.verified` — whether the author maps to a platform user. */
  readonly authorVerified: boolean;
}

/**
 * Is this ticket comment an ask?
 *
 * Answers in **both** directions by construction (standing rule 42): every input produces exactly
 * one verdict, and a `not_an_ask` verdict names which of the four rules refused it, so a test can
 * assert the refusal rather than only the absence of an ask.
 *
 * The order matters and is the fail-closed one: the platform's own comment and an unverified author
 * are checked **before** the trigger, so a log of refusals cannot be read as "somebody tried to
 * ask" when the truth is that the platform was talking to itself.
 */
export const classifyTicketComment = (input: TicketCommentInput): TicketCommentVerdict => {
  if (PLATFORM_COMMENT_MARKERS.some((marker) => input.text.includes(marker))) {
    return { kind: 'not_an_ask', reason: 'platform_comment' };
  }
  const rest = startsWithTrigger(input.text);
  if (rest === null) {
    return { kind: 'not_an_ask', reason: 'no_trigger' };
  }
  if (!input.authorVerified) {
    return { kind: 'not_an_ask', reason: 'unverified_identity' };
  }
  const question = rest.trim();
  if (question === '') {
    return { kind: 'not_an_ask', reason: 'empty_question' };
  }
  return { kind: 'ask', question };
};

/** The marker an ask's mirrored comment is keyed on, so a retry edits rather than posts again. */
export const askCommentMarker = (askId: string): string => `agentic:ask:${askId}`;

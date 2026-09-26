/**
 * The **TaskManagement** type port — technical/06 § "TaskManagement", product/08 § "Task
 * management".
 *
 * Jira Cloud is the first provider (WP-08); Jira Data Center, Linear and GitHub Issues are the
 * second ones this contract is designed for. Everything a ticket carries is untrusted text
 * (BD-022): the platform renders and stores it, and prompts present it as data.
 *
 * Two shapes here are load-bearing beyond their fields.
 *
 *  - `upsertWorkpad` is BD-023: **one** comment per ticket that the platform keeps rewriting,
 *    found again by its marker id rather than by a stored comment id, so a lost id or a second
 *    replica cannot produce two workpads.
 *  - `transition` reports whether it changed anything. technical/06 wrote `-> void`, which cannot
 *    express product/08's "transition only if not already in status"; the executor's idempotency
 *    rule needs the answer, and so does the health panel.
 */
import {
  isoDateTimeSchema,
  nonEmptyStringSchema,
  ticketRefSchema,
  urlSchema,
  workpadRefSchema,
} from '@platform/contracts';
import * as z from 'zod';
import { externalIdentitySchema, type InboundNormaliser, type IntegrationPort } from './common.js';

// ── Data ─────────────────────────────────────────────────────────────────────

/** A link between tickets: `blocks`, `is_blocked_by`, `relates_to`, `duplicates`. */
export const ticketLinkSchema = z.strictObject({
  kind: nonEmptyStringSchema,
  key: nonEmptyStringSchema,
  url: urlSchema.nullish(),
  /** The linked ticket's status name, when the provider returns it. */
  state: nonEmptyStringSchema.nullish(),
});

/**
 * One comment. `body` is untrusted markdown (BD-022).
 *
 * `marker_id` is the platform's own hidden marker when the platform wrote the comment — the
 * workpad's marker (BD-023) or a question's. Providers find it in the comment body; the field
 * exists so callers never have to parse the body themselves.
 */
export const ticketCommentSchema = z.strictObject({
  id: nonEmptyStringSchema,
  author: externalIdentitySchema,
  body: z.string(),
  created_at: isoDateTimeSchema,
  updated_at: isoDateTimeSchema.nullish(),
  marker_id: nonEmptyStringSchema.nullish(),
  url: urlSchema.nullish(),
});

/** The parent epic, when the provider has epics and the ticket is in one. */
export const ticketEpicSchema = z.strictObject({
  key: nonEmptyStringSchema,
  title: z.string(),
  description: z.string(),
});

export const ticketSiblingSchema = z.strictObject({
  key: nonEmptyStringSchema,
  title: z.string(),
  state: nonEmptyStringSchema,
});

/**
 * A ticket as the platform reads it (technical/06's `Ticket`).
 *
 * `status` is the provider's own status *name*, not a platform state: the status mapping in
 * `.agentic/config.yml` (technical/12) translates in one direction only, and an unmapped status
 * leaves the ticket alone.
 */
export const ticketSchema = z.strictObject({
  ref: ticketRefSchema,
  /** Provider issue type (`Bug`, `Story`, `Task`) — mapped to a template by project config. */
  issue_type: nonEmptyStringSchema,
  title: z.string(),
  /** Untrusted markdown (BD-022). */
  description: z.string(),
  status: nonEmptyStringSchema,
  priority: nonEmptyStringSchema.nullish(),
  labels: z.array(nonEmptyStringSchema),
  comments: z.array(ticketCommentSchema),
  links: z.array(ticketLinkSchema),
  epic: ticketEpicSchema.nullish(),
  siblings: z.array(ticketSiblingSchema),
  /** Text extracted from attachments, already truncated by the provider. Untrusted. */
  attachments_text: z.array(z.string()),
  assignee: externalIdentitySchema.nullish(),
  reporter: externalIdentitySchema.nullish(),
  updated_at: isoDateTimeSchema,
});

/** Where a comment ended up. Extends the workpad ref so a workpad is just a marked comment. */
export const commentRefSchema = workpadRefSchema.extend({
  marker_id: nonEmptyStringSchema.nullish(),
});

/** The pick-up rules of product/08: label, mapped status, epic membership, or a provider query. */
export const ticketMatchRuleSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('label'), label: nonEmptyStringSchema }),
  z.strictObject({ kind: z.literal('status'), status: nonEmptyStringSchema }),
  z.strictObject({ kind: z.literal('epic'), epic_key: nonEmptyStringSchema }),
  z.strictObject({ kind: z.literal('query'), query: nonEmptyStringSchema }),
]);

/** Just enough of a match to build `ticket.matched` (technical/02) without a second read. */
export const ticketMatchSchema = z.strictObject({
  ref: ticketRefSchema,
  issue_type: nonEmptyStringSchema,
  priority: nonEmptyStringSchema.nullish(),
  epic: nonEmptyStringSchema.nullish(),
  links: z.array(ticketLinkSchema),
  updated_at: isoDateTimeSchema,
});

/** What `transition` did. `changed: false` means the ticket was already in the target status. */
export const transitionResultSchema = z.strictObject({
  changed: z.boolean(),
  from: nonEmptyStringSchema,
  to: nonEmptyStringSchema,
});

/**
 * A ticket the platform creates — product/08:9's *"create follow-up tickets"*.
 *
 * **Two callers, not three** (corrected at WP-36, standing rule 83): the scope-creep valve
 * (product/04's S3 — *"improvements discovered outside the scope are never implemented; the agent
 * files a separate ticket"*) and the epic split (WP-40). This docblock used to name a *"maintenance
 * chore"* as a third, and that is **wrong against the product documents**: product/19:126's feature
 * card says the maintenance pipeline's external touch is **merge requests**, and product/18:31 says
 * a chore *"produces a normal `chore` task"* — which the scheduler creates directly, on a
 * platform-issued reference that every ticket read and every ticket write refuses by name. A
 * maintenance chore files no ticket on anybody's board.
 *
 * **One of the two is built** (WP-40): the epic split calls it through
 * `ticketWrites.createChildTicket`, from the `breakdown_create` outbound duty, once per child a
 * human accepted and never on a run's own verdict. The scope-creep valve is still unbuilt, so this
 * method had no caller at all from WP-08 until that row.
 */
export const ticketDraftSchema = z.strictObject({
  project_key: nonEmptyStringSchema,
  issue_type: nonEmptyStringSchema,
  title: nonEmptyStringSchema,
  description: z.string(),
  labels: z.array(nonEmptyStringSchema),
  parent_key: nonEmptyStringSchema.nullish(),
  priority: nonEmptyStringSchema.nullish(),
});

export type TicketLink = z.infer<typeof ticketLinkSchema>;
export type TicketComment = z.infer<typeof ticketCommentSchema>;
export type Ticket = z.infer<typeof ticketSchema>;
export type CommentRef = z.infer<typeof commentRefSchema>;
export type TicketMatchRule = z.infer<typeof ticketMatchRuleSchema>;
export type TicketMatch = z.infer<typeof ticketMatchSchema>;
export type TransitionResult = z.infer<typeof transitionResultSchema>;
export type TicketDraft = z.infer<typeof ticketDraftSchema>;

// ── Capabilities ─────────────────────────────────────────────────────────────

/**
 * The optional half of the contract (technical/06 `capabilities()`).
 *
 * A caller checks the flag before asking; a provider that is asked anyway throws
 * `IntegrationUnsupportedError` rather than pretending. That pair is what the contract suite
 * asserts, so an unimplemented method can never look like a working one.
 */
export interface TaskManagementCapabilities {
  /** Inbound webhooks, as opposed to the polling fallback only. */
  readonly webhooks: boolean;
  readonly epics: boolean;
  readonly links: boolean;
  readonly customFields: boolean;
  /** Rich-text conversion (ADF on Jira Cloud, wiki markup on Data Center). */
  readonly adf: boolean;
  /** `createTicket` — the scope-creep valve needs it; a read-only binding does not have it. */
  readonly createTicket: boolean;
  /** Attachment text extraction. */
  readonly attachments: boolean;
}

/** Catalogue events a task-management delivery can produce (technical/02). */
export type TaskManagementInboundEvent =
  | 'ticket.matched'
  /** WP-25: a ticket the binding reads was created, whether or not it is for the agent. */
  | 'ticket.created'
  /**
   * WP-60: a ticket the binding reads changed — emitted **beside** whatever else the delivery
   * produces (`ticket.matched`, `ticket.status.changed`), never instead of it. An obligation of
   * every task-management provider: the shared contract suite asserts it.
   */
  | 'ticket.updated'
  | 'ticket.comment.added'
  | 'ticket.status.changed';

// ── The port ─────────────────────────────────────────────────────────────────

export interface TaskManagementPort extends IntegrationPort<TaskManagementCapabilities> {
  readTicket(ref: TicketRefInput): Promise<Ticket>;

  /** Polling fallback (product/08: every 60 s when no public URL). `since` narrows the window. */
  matchTickets(
    rule: TicketMatchRule,
    options?: { readonly since?: string | null; readonly limit?: number },
  ): Promise<readonly TicketMatch[]>;

  /**
   * Moves the ticket to a status **by name**, resolving the provider's transition at runtime.
   *
   * Idempotent by contract: already being in `targetStatusName` is `{changed: false}`, not an
   * error. A target that exists nowhere in the workflow is an `invalid_request` failure — loudly,
   * because a silently ignored transition looks like a working status mapping (product/08).
   */
  transition(
    ref: TicketRefInput,
    targetStatusName: string,
    fields?: Readonly<Record<string, unknown>>,
  ): Promise<TransitionResult>;

  /** BD-023: creates the marked comment on first call, edits it in place afterwards. */
  upsertWorkpad(ref: TicketRefInput, markerId: string, markdown: string): Promise<CommentRef>;

  /** A new comment every time — questions and linter output must notify (product/08). */
  addComment(
    ref: TicketRefInput,
    markdown: string,
    options?: { readonly markerId?: string | null },
  ): Promise<CommentRef>;

  setLabels(
    ref: TicketRefInput,
    add: readonly string[],
    remove: readonly string[],
  ): Promise<readonly string[]>;

  linkMergeRequest(ref: TicketRefInput, mrUrl: string): Promise<void>;

  createTicket(draft: TicketDraft): Promise<TicketRefInput>;

  /** Maps a provider user or an email onto a verified identity, or `null` when unknown. */
  resolveIdentity(query: {
    readonly providerUserId?: string;
    readonly email?: string;
  }): Promise<ExternalIdentityValue | null>;

  readonly inbound: InboundNormaliser<TaskManagementInboundEvent>;
}

/** `ticketRefSchema` in `@platform/contracts` — named here so the port reads as one document. */
export type TicketRefInput = z.infer<typeof ticketRefSchema>;
type ExternalIdentityValue = z.infer<typeof externalIdentitySchema>;

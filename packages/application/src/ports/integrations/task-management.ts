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
  ticketIdSchema,
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
  /**
   * How many comments the ticket has **in all**, as the provider counts them, when it says — WP-83,
   * PROGRESS backlog 290. `comments` may be a page (Jira's is the newest fifty,
   * `READ_TICKET_COMMENT_PAGE`), so `comments.length` is not the thread's size, and a consumer that
   * treated it as one would present a partial thread as a whole one. Never less than
   * `comments.length`. **Absent or `null` means the provider did not say — which a consumer reads
   * as "possibly more", never "no more"** (standing rule 16; `boundTicketSnapshot` sets
   * `truncated`). An adapter that *knows* it returned the whole thread — it asked for a page and got
   * fewer than it asked for — answers `comments.length` rather than `null` (WP-83 review round 2).
   * Both shipped task-management adapters answer a number whenever they can (the fake with its whole
   * thread, Jira with the page's `total`), which the shared contract suite asserts.
   */
  comment_total: z.int().nonnegative().nullish(),
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

/**
 * The most ticket keys one `keys` rule names (WP-110) — one provider page at Jira's 100
 * (`MATCH_PAGE_MAX` in the Jira adapter), so the read a `keys` rule costs is one request.
 */
export const MAX_TICKET_MATCH_KEYS = 100;

/**
 * The pick-up rules of product/08 — label, mapped status, epic membership, or a provider query —
 * and one rule that is **not** a pick-up rule: `keys`, the tickets named, whatever their state
 * (WP-110, PROGRESS backlog 298). The ticket poller asks it for the tickets of a binding's **live
 * tasks**, because a status rule stops matching a ticket the moment the platform's own status
 * mapping moves it on, and its edits would otherwise reach a running task only by webhook. No
 * configuration produces a `keys` rule: a binding's `pollPlan()` answers a pick-up rule.
 */
export const ticketMatchRuleSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('label'), label: nonEmptyStringSchema }),
  z.strictObject({ kind: z.literal('status'), status: nonEmptyStringSchema }),
  z.strictObject({ kind: z.literal('epic'), epic_key: nonEmptyStringSchema }),
  z.strictObject({ kind: z.literal('query'), query: nonEmptyStringSchema }),
  z
    .strictObject({
      kind: z.literal('keys'),
      keys: z.array(nonEmptyStringSchema).max(MAX_TICKET_MATCH_KEYS),
      /**
       * The provider's stable ids of tickets to read **by id** (WP-145, PROGRESS backlog 437): a
       * live task that recorded its issue's id is asked by it, because a moved issue answers under
       * its new key and whether a search resolves the old one is not measured. A task with no id is
       * asked by `keys`. Together at most {@link MAX_TICKET_MATCH_KEYS}, and at least one.
       */
      ids: z.array(ticketIdSchema).max(MAX_TICKET_MATCH_KEYS).optional(),
    })
    .refine(
      (rule) =>
        rule.keys.length + (rule.ids?.length ?? 0) >= 1 &&
        rule.keys.length + (rule.ids?.length ?? 0) <= MAX_TICKET_MATCH_KEYS,
      { message: `a keys rule names 1 to ${MAX_TICKET_MATCH_KEYS} tickets, by key or by id` },
    ),
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

/** The shortest poll interval a binding may declare — a floor on the provider traffic one binding costs. */
export const MIN_TICKET_POLL_INTERVAL_SECONDS = 30;
/** The longest: a day. A binding that polls less often than that is a binding that does not poll. */
export const MAX_TICKET_POLL_INTERVAL_SECONDS = 86_400;
/** product/08's *"every 60 s when no public URL"*, and the interval a binding that says nothing gets. */
export const DEFAULT_TICKET_POLL_INTERVAL_SECONDS = 60;

/**
 * The keys a task-management binding's configuration switches polling with (WP-87).
 *
 * **Platform names, not a provider's**, for one reader that cannot build an adapter: the poll sweep
 * (`pipeline/ticket-poll.ts`) lists the bindings to poll with one query over `bindings.config`
 * merged over `integrations.config`, rather than decrypting every binding's credentials once a
 * minute to ask it. `communicationChannels` is the precedent for a platform reader of a provider's
 * config, and the difference is stated: that one is declared per registration, this one is a
 * convention, because the value the sweep reads is a switch and not a provider-shaped field. A
 * provider whose schema does not declare {@link TICKET_POLL_CONFIG_KEYS.enabled} can never be switched
 * on (its strict schema refuses the key), which is the closed direction. The adapter's
 * {@link TaskManagementPort.pollPlan} stays the authority — the sweep's query only chooses whom to
 * ask.
 */
export const TICKET_POLL_CONFIG_KEYS = {
  enabled: 'poll_enabled',
  intervalSeconds: 'poll_interval_seconds',
} as const;

/**
 * What a binding that polls polls for (WP-87, technical/06 § "Inbound: webhooks and polling").
 *
 * `rule` is the binding's **pick-up rule** — the same one its webhook announces a match with — so a
 * polled match and a webhook match mean one thing. `interval_seconds` is the binding's own.
 */
export const ticketPollPlanSchema = z.strictObject({
  rule: ticketMatchRuleSchema,
  interval_seconds: z
    .int()
    .min(MIN_TICKET_POLL_INTERVAL_SECONDS)
    .max(MAX_TICKET_POLL_INTERVAL_SECONDS),
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
export type TicketPollPlan = z.infer<typeof ticketPollPlanSchema>;
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

/**
 * {@link TaskManagementPort.ticketScope}'s answer. `scope` is the binding's own declared list
 * (configuration an operator wrote, never ticket content), so a refusal may name it.
 */
export type TicketScopeVerdict =
  | { readonly kind: 'unscoped' }
  | { readonly kind: 'in_scope' }
  | { readonly kind: 'out_of_scope'; readonly scope: readonly string[] };

// ── The port ─────────────────────────────────────────────────────────────────

export interface TaskManagementPort extends IntegrationPort<TaskManagementCapabilities> {
  readonly readTicket: (ref: TicketRefInput) => Promise<Ticket>;

  /**
   * The tickets a rule matches — the ticket poller's read (WP-87) and the history bootstrap's.
   * `since` narrows the window to tickets updated at or after it; a provider whose window is coarser
   * than the instant (Jira's JQL is minute-grained) **widens** it, never narrows it.
   *
   * **Ordered by `updated_at`, oldest first** — an obligation of every provider since WP-87, because
   * the poller advances its cursor to the newest `updated_at` a page returned, and a page cut by
   * `limit` from any other order would move the cursor past tickets it never read.
   */
  readonly matchTickets: (
    rule: TicketMatchRule,
    options?: {
      readonly since?: string | null;
      readonly limit?: number;
      /**
       * For a `keys` rule: the asked-for keys the provider **refused** as not existing — a deleted
       * ticket, or one moved out of the account's reach — which the read then left out so it could
       * answer the others (WP-134, PROGRESS backlog 375). Called at most once per call, with keys
       * from the caller's own list only, and never for a key that merely had no change in the
       * window. A provider whose search does not refuse an unknown key (the fake) never calls it.
       * `ids` is the same for the rule's `ids` (WP-145): the asked-for ids the provider refused.
       */
      readonly onUnreadableKeys?: (keys: readonly string[], ids: readonly string[]) => void;
    },
  ) => Promise<readonly TicketMatch[]>;

  /**
   * Whether this binding polls, and for what (WP-87) — `null` when it does not.
   *
   * Off unless the binding's configuration switches it on ({@link TICKET_POLL_CONFIG_KEYS}), and
   * `null` too when it is switched on with no pick-up rule to poll for: a poll that could match
   * nothing is a poll that costs a provider read a minute for no answer. Pure — it reads the
   * configuration the adapter was built with and calls nobody.
   */
  readonly pollPlan: () => TicketPollPlan | null;

  /**
   * Whether a ticket is inside this binding's **declared scope** (WP-122 pre-review round) — the
   * filter a provider applies to what it delivers, as distinct from the pick-up rule: Jira's
   * `project_keys`, which its webhook applies to every delivery. Pure: it reads the configuration
   * the adapter was built with and calls nobody. A provider with no scope concept, or a binding that
   * declares none, answers `unscoped` — never a refusal.
   *
   * Asked with the key **as the provider answered it** (`Ticket.ref.key` after `readTicket`), never
   * the key a person typed, so the comparison is the one the webhook makes on a delivered key.
   */
  readonly ticketScope: (ticketKey: string) => TicketScopeVerdict;

  /**
   * Moves the ticket to a status **by name**, resolving the provider's transition at runtime.
   *
   * Idempotent by contract: already being in `targetStatusName` is `{changed: false}`, not an
   * error. A target that exists nowhere in the workflow is an `invalid_request` failure — loudly,
   * because a silently ignored transition looks like a working status mapping (product/08).
   */
  readonly transition: (
    ref: TicketRefInput,
    targetStatusName: string,
    fields?: Readonly<Record<string, unknown>>,
  ) => Promise<TransitionResult>;

  /** BD-023: creates the marked comment on first call, edits it in place afterwards. */
  readonly upsertWorkpad: (
    ref: TicketRefInput,
    markerId: string,
    markdown: string,
  ) => Promise<CommentRef>;

  /** A new comment every time — questions and linter output must notify (product/08). */
  readonly addComment: (
    ref: TicketRefInput,
    markdown: string,
    options?: { readonly markerId?: string | null },
  ) => Promise<CommentRef>;

  readonly setLabels: (
    ref: TicketRefInput,
    add: readonly string[],
    remove: readonly string[],
  ) => Promise<readonly string[]>;

  readonly linkMergeRequest: (ref: TicketRefInput, mrUrl: string) => Promise<void>;

  readonly createTicket: (draft: TicketDraft) => Promise<TicketRefInput>;

  /** Maps a provider user or an email onto a verified identity, or `null` when unknown. */
  readonly resolveIdentity: (query: {
    readonly providerUserId?: string;
    readonly email?: string;
  }) => Promise<ExternalIdentityValue | null>;

  readonly inbound: InboundNormaliser<TaskManagementInboundEvent>;
}

/** `ticketRefSchema` in `@platform/contracts` — named here so the port reads as one document. */
export type TicketRefInput = z.infer<typeof ticketRefSchema>;
type ExternalIdentityValue = z.infer<typeof externalIdentitySchema>;

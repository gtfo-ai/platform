/**
 * `FakeTaskManagement` — the in-memory provider behind the TaskManagement contract suite and the
 * pipeline tests (technical/06, technical/10). It is a test double and nothing else: shadow mode
 * is a guard inside `IntegrationActionExecutor`, not an adapter swap.
 *
 * It is a *provider*, not a stub: it has a workflow of status names, a comment list with the
 * platform's markers in it, issue links, an epic with siblings, an identity directory and a signed
 * webhook envelope. Everything the port promises is implemented here, so a work package that
 * cannot express its scenario against this fake has found a hole in the port rather than in the
 * fake.
 *
 * ## Known divergences from a real task manager
 *
 * The rule: **a fake may be stricter than the real adapter, never kinder** — every later work
 * package's unit tier trusts this file. Each entry says which direction it goes, because a reader
 * who takes "stricter" on faith will not re-check.
 *
 *  1. **Stricter — every document is validated against the port's schema on the way out.** The
 *     fake parses its own state with `ticketSchema` before returning it, so a malformed seed fails
 *     at the first read instead of somewhere downstream. A real adapter validates the provider's
 *     *response*; the effect is the same and the fake's is earlier.
 *  2. **Stricter — an unknown target status is `invalid_request`, never a silent no-op.**
 *     product/08 requires transitions to "fail loudly if none"; a provider that quietly ignores an
 *     unmapped status would pass a kinder fake and leave tickets stuck in the wrong column.
 *  3. **Stricter — `matchTickets` accepts only three query forms** (`label = "x"`,
 *     `status = "x"`, `epic = "x"`). Real JQL is a language; the fake refuses what it cannot mean
 *     rather than returning everything, so a typo in a project's pick-up query cannot look like an
 *     empty backlog.
 *  4. **Kinder, deliberately — there is no quota.** Jira Cloud throttles on cost; this fake never
 *     does unless a test scripts it (`script.failNext('add_comment', new
 *     IntegrationRateLimitedError(…))`). Rate limiting is the `IntegrationActionExecutor`'s job,
 *     not a provider's. The test that drives that path through *this fake* is
 *     `test/contract/integrations/action-executor.contract.test.ts` ("retries the provider's 429
 *     after its Retry-After"); it exists, and this entry names it because a register that
 *     justifies a kindness by pointing at a test elsewhere must name a test that exists (WP-07
 *     review round 1 found all five entries pointing at nothing).
 *  5. **Kinder — markdown is stored verbatim.** `capabilities().adf` is false by default: there is
 *     no markdown→ADF conversion here, so a table or a code fence that Jira's converter mangles
 *     round-trips perfectly. WP-08 owns the conversion and its golden tests; do not conclude from
 *     a green test here that a comment renders.
 *  6. **Different — ids are sequential and keys are `FAKE-<n>`.** Deterministic ids make golden
 *     fixtures possible; real ids are opaque and not monotonic, so code that *sorts* by comment id
 *     would pass here and be wrong in production.
 *  7. **Different — writes are immediately visible to reads.** Jira's search index lags by
 *     seconds, which is why the polling fallback overlaps its window. A test asserting that a
 *     freshly labelled ticket appears in `matchTickets` at once is asserting something the real
 *     provider does not promise.
 */
import {
  type CommentRef,
  type ExternalIdentity,
  type HealthProbe,
  type InboundContext,
  type InboundNormaliser,
  type IntegrationRef,
  IntegrationUnsupportedError,
  type NormalisedDelivery,
  type NormalisedEvent,
  type TaskManagementCapabilities,
  type TaskManagementInboundEvent,
  type TaskManagementPort,
  type Ticket,
  type TicketDraft,
  type TicketLink,
  type TicketMatch,
  type TicketMatchRule,
  type TicketRefInput,
  type TransitionResult,
  ticketSchema,
  type WebhookDelivery,
} from '@platform/application';
import type { Id } from '@platform/contracts';
import * as z from 'zod';
import {
  buildFakeDelivery,
  createFakeCore,
  type FakeCore,
  fakeDeliveryKey,
  invalidRequest,
  notFound,
  snapshot,
  verifyFakeDelivery,
} from '../support/fake-support.js';

const PROVIDER = 'fake-task-management';
const ACTION = 'task_management';

/** The workflow a seeded fake uses when the caller does not name one. */
export const DEFAULT_FAKE_STATUSES = [
  'Backlog',
  'Ready for agent',
  'In Refinement',
  'Waiting for input',
  'In Progress',
  'In Review',
  'Done',
] as const;

export interface FakeTicketSeed {
  readonly key: string;
  readonly title: string;
  readonly description?: string;
  readonly issueType?: string;
  readonly status?: string;
  readonly priority?: string | null;
  readonly labels?: readonly string[];
  readonly epic?: { readonly key: string; readonly title: string; readonly description: string };
  readonly siblings?: readonly { key: string; title: string; state: string }[];
  readonly links?: readonly TicketLink[];
  readonly attachmentsText?: readonly string[];
}

export interface FakeIdentitySeed {
  readonly providerUserId: string;
  readonly email?: string;
  readonly displayName?: string;
}

export interface FakeTaskManagementOptions {
  readonly integrationId: Id;
  readonly baseUrl?: string;
  readonly statuses?: readonly string[];
  readonly tickets?: readonly FakeTicketSeed[];
  readonly identities?: readonly FakeIdentitySeed[];
  readonly capabilities?: Partial<TaskManagementCapabilities>;
  readonly webhookSecret?: string;
}

interface StoredComment {
  id: string;
  author: ExternalIdentity;
  body: string;
  created_at: string;
  updated_at: string | null;
  marker_id: string | null;
  url: string;
}

interface StoredTicket {
  key: string;
  url: string;
  issue_type: string;
  title: string;
  description: string;
  status: string;
  priority: string | null;
  labels: string[];
  comments: StoredComment[];
  links: TicketLink[];
  epic: { key: string; title: string; description: string } | null;
  siblings: { key: string; title: string; state: string }[];
  attachments_text: string[];
  updated_at: string;
}

/** The webhook bodies this fake sends. Strict: an unknown key is a malformed delivery. */
const commentAddedBody = z.strictObject({
  event: z.literal('comment.added'),
  ticket_key: z.string().min(1),
  comment_id: z.string().min(1),
  author_id: z.string().min(1),
  text: z.string(),
});

const statusChangedBody = z.strictObject({
  event: z.literal('status.changed'),
  ticket_key: z.string().min(1),
  from: z.string(),
  to: z.string(),
});

const ticketMatchedBody = z.strictObject({
  event: z.literal('ticket.matched'),
  ticket_key: z.string().min(1),
  rule: z.string().min(1),
});

const deliveryBody = z.discriminatedUnion('event', [
  commentAddedBody,
  statusChangedBody,
  ticketMatchedBody,
]);

export interface FakeTaskManagement extends TaskManagementPort {
  /** Test controls: scripted failures, the call log, the webhook secret. */
  readonly core: FakeCore;
  /** Seeds another ticket after construction. */
  seedTicket(seed: FakeTicketSeed): TicketRefInput;
  /** The raw stored ticket, for assertions the port deliberately does not expose. */
  peek(key: string): StoredTicket | undefined;
  emitCommentAdded(input: {
    readonly ticketKey: string;
    readonly authorId: string;
    readonly text: string;
    readonly deliveryId?: string;
  }): WebhookDelivery;
  emitStatusChanged(input: {
    readonly ticketKey: string;
    readonly from: string;
    readonly to: string;
    readonly deliveryId?: string;
  }): WebhookDelivery;
  emitTicketMatched(input: {
    readonly ticketKey: string;
    readonly rule: string;
    readonly deliveryId?: string;
  }): WebhookDelivery;
}

export const createFakeTaskManagement = (
  options: FakeTaskManagementOptions,
): FakeTaskManagement => {
  const ref: IntegrationRef = {
    integrationId: options.integrationId,
    provider: PROVIDER,
    type: 'task_management',
  };
  const core = createFakeCore({ ref, webhookSecret: options.webhookSecret });
  const baseUrl = options.baseUrl ?? 'https://tickets.example.test';
  const statuses = [...(options.statuses ?? DEFAULT_FAKE_STATUSES)];
  const capabilities: TaskManagementCapabilities = {
    webhooks: true,
    epics: true,
    links: true,
    customFields: false,
    adf: false,
    createTicket: true,
    attachments: true,
    ...options.capabilities,
  };

  const tickets = new Map<string, StoredTicket>();
  const identities = new Map<string, ExternalIdentity>();
  let commentCounter = 0;
  let createdCounter = 0;

  const identityOf = (providerUserId: string): ExternalIdentity =>
    identities.get(providerUserId) ?? {
      provider: PROVIDER,
      external_id: providerUserId,
      email: null,
      display_name: null,
      verified: false,
    };

  const ticketUrl = (key: string): string => `${baseUrl}/browse/${key}`;

  const seedTicket = (seed: FakeTicketSeed): TicketRefInput => {
    const status = seed.status ?? statuses[0] ?? 'Backlog';
    if (!statuses.includes(status)) {
      throw new TypeError(`seed status "${status}" is not in this fake's workflow`);
    }
    tickets.set(seed.key, {
      key: seed.key,
      url: ticketUrl(seed.key),
      issue_type: seed.issueType ?? 'Task',
      title: seed.title,
      description: seed.description ?? '',
      status,
      priority: seed.priority ?? null,
      labels: [...(seed.labels ?? [])],
      comments: [],
      links: [...(seed.links ?? [])],
      epic: seed.epic ? { ...seed.epic } : null,
      siblings: [...(seed.siblings ?? [])].map((sibling) => ({ ...sibling })),
      attachments_text: [...(seed.attachmentsText ?? [])],
      updated_at: core.clock.now(),
    });
    return { provider: PROVIDER, key: seed.key, url: ticketUrl(seed.key) };
  };

  for (const identity of options.identities ?? []) {
    identities.set(identity.providerUserId, {
      provider: PROVIDER,
      external_id: identity.providerUserId,
      email: identity.email ?? null,
      display_name: identity.displayName ?? null,
      verified: true,
    });
  }
  for (const seed of options.tickets ?? []) {
    seedTicket(seed);
  }

  const requireTicket = (action: string, key: string): StoredTicket => {
    const ticket = tickets.get(key);
    if (ticket === undefined) {
      throw notFound(PROVIDER, action, `ticket ${key}`);
    }
    return ticket;
  };

  const toTicket = (stored: StoredTicket): Ticket =>
    // Divergence 1: the fake validates its own output.
    ticketSchema.parse({
      ref: { provider: PROVIDER, key: stored.key, url: stored.url },
      issue_type: stored.issue_type,
      title: stored.title,
      description: stored.description,
      status: stored.status,
      priority: stored.priority,
      labels: [...stored.labels],
      comments: stored.comments.map((comment) => snapshot(comment)),
      links: snapshot(stored.links),
      epic: stored.epic === null ? null : snapshot(stored.epic),
      siblings: snapshot(stored.siblings),
      attachments_text: [...stored.attachments_text],
      assignee: null,
      reporter: null,
      updated_at: stored.updated_at,
    });

  const toMatch = (stored: StoredTicket): TicketMatch => ({
    ref: { provider: PROVIDER, key: stored.key, url: stored.url },
    issue_type: stored.issue_type,
    priority: stored.priority,
    epic: stored.epic?.key ?? null,
    links: snapshot(stored.links),
    updated_at: stored.updated_at,
  });

  const commentRefOf = (ticket: StoredTicket, comment: StoredComment): CommentRef => ({
    provider: PROVIDER,
    ticket_key: ticket.key,
    comment_id: comment.id,
    url: comment.url,
    marker_id: comment.marker_id,
  });

  const addComment = (
    ticket: StoredTicket,
    body: string,
    markerId: string | null,
  ): StoredComment => {
    commentCounter += 1;
    const comment: StoredComment = {
      id: `c-${commentCounter}`,
      author: {
        provider: PROVIDER,
        external_id: 'agentic-bot',
        email: null,
        display_name: 'Agentic Bot',
        verified: true,
      },
      body,
      created_at: core.clock.now(),
      updated_at: null,
      marker_id: markerId,
      url: `${ticket.url}#comment-${commentCounter}`,
    };
    ticket.comments.push(comment);
    ticket.updated_at = comment.created_at;
    return comment;
  };

  /** Divergence 3: three query forms, and nothing else. */
  const parseQuery = (query: string): TicketMatchRule => {
    const match = /^(label|status|epic)\s*=\s*"([^"]+)"$/.exec(query.trim());
    if (match === null) {
      throw invalidRequest(
        PROVIDER,
        'match_tickets',
        `query "${query}" is not one of: label = "…", status = "…", epic = "…"`,
      );
    }
    const field = match[1] ?? '';
    const value = match[2] ?? '';
    if (field === 'label') {
      return { kind: 'label', label: value };
    }
    if (field === 'status') {
      return { kind: 'status', status: value };
    }
    return { kind: 'epic', epic_key: value };
  };

  const matches = (ticket: StoredTicket, rule: TicketMatchRule): boolean => {
    switch (rule.kind) {
      case 'label':
        return ticket.labels.includes(rule.label);
      case 'status':
        return ticket.status === rule.status;
      case 'epic':
        return ticket.epic?.key === rule.epic_key;
      case 'query':
        return matches(ticket, parseQuery(rule.query));
    }
  };

  const inbound: InboundNormaliser<TaskManagementInboundEvent> = {
    verify: (delivery) => verifyFakeDelivery(core.webhookSecret, delivery),
    deliveryKey: (delivery) => fakeDeliveryKey(PROVIDER, delivery),
    normalise: async (
      delivery: WebhookDelivery,
      context: InboundContext,
    ): Promise<NormalisedDelivery<TaskManagementInboundEvent>> => {
      const parsed = deliveryBody.safeParse(JSON.parse(delivery.body) as unknown);
      if (!parsed.success) {
        return {
          events: [],
          ignored: [{ reason: 'malformed_payload', detail: parsed.error.issues[0]?.message ?? '' }],
        };
      }
      const body = parsed.data;
      const ticket = tickets.get(body.ticket_key);
      if (ticket === undefined) {
        return {
          events: [],
          ignored: [
            { reason: 'not_for_this_project', detail: `unknown ticket ${body.ticket_key}` },
          ],
        };
      }
      const ticketRef = { provider: PROVIDER, key: ticket.key, url: ticket.url };
      const actor = {
        kind: 'integration',
        integration_id: context.integrationId,
        provider: PROVIDER,
      } as const;

      if (body.event === 'comment.added') {
        const identity = identityOf(body.author_id);
        // BD-022: `verified` means "maps to a platform user", so it is the resolver's answer.
        const author: ExternalIdentity = {
          ...identity,
          verified: context.resolveUser(identity) !== null,
        };
        const event: NormalisedEvent<'ticket.comment.added'> = {
          type: 'ticket.comment.added',
          payload: {
            project_id: context.projectId,
            task_id: null,
            ticket: ticketRef,
            comment_id: body.comment_id,
            author,
            text: body.text,
          },
          actor: { ...actor, identity: author },
        };
        return { events: [event], ignored: [] };
      }

      if (body.event === 'status.changed') {
        const event: NormalisedEvent<'ticket.status.changed'> = {
          type: 'ticket.status.changed',
          payload: {
            project_id: context.projectId,
            task_id: null,
            ticket: ticketRef,
            from: body.from,
            to: body.to,
          },
          actor,
        };
        return { events: [event], ignored: [] };
      }

      const event: NormalisedEvent<'ticket.matched'> = {
        type: 'ticket.matched',
        payload: {
          project_id: context.projectId,
          ticket: ticketRef,
          rule: body.rule,
          priority: ticket.priority,
          issue_type: ticket.issue_type,
          epic: ticket.epic?.key ?? null,
          links: ticket.links.map((link) => ({
            kind: link.kind,
            key: link.key,
            url: link.url ?? null,
          })),
        },
        actor,
      };
      return { events: [event], ignored: [] };
    },
  };

  let deliveryCounter = 0;
  const nextDeliveryId = (): string => {
    deliveryCounter += 1;
    return `d-${deliveryCounter}`;
  };

  return {
    core,
    ref,
    capabilities: () => ({ ...capabilities }),
    testConnection: async (): Promise<HealthProbe> => {
      core.enter('test_connection');
      return {
        ok: true,
        checked_at: core.clock.now(),
        detail: `${tickets.size} tickets seeded`,
        token_expires_at: null,
      };
    },

    readTicket: async (ticketRef) => {
      core.enter('read_ticket');
      return toTicket(requireTicket('read_ticket', ticketRef.key));
    },

    matchTickets: async (rule, matchOptions) => {
      core.enter('match_tickets');
      const limit = matchOptions?.limit ?? 50;
      const since = matchOptions?.since ?? null;
      return [...tickets.values()]
        .filter((ticket) => matches(ticket, rule))
        .filter((ticket) => since === null || Date.parse(ticket.updated_at) >= Date.parse(since))
        .slice(0, limit)
        .map(toMatch);
    },

    transition: async (ticketRef, targetStatusName): Promise<TransitionResult> => {
      core.enter('transition');
      const ticket = requireTicket('transition', ticketRef.key);
      if (!statuses.includes(targetStatusName)) {
        // Divergence 2: loud, never a silent no-op (product/08).
        throw invalidRequest(
          PROVIDER,
          'transition',
          `no transition to "${targetStatusName}" exists in this workflow`,
        );
      }
      if (ticket.status === targetStatusName) {
        return { changed: false, from: ticket.status, to: targetStatusName };
      }
      const from = ticket.status;
      ticket.status = targetStatusName;
      ticket.updated_at = core.clock.now();
      return { changed: true, from, to: targetStatusName };
    },

    upsertWorkpad: async (ticketRef, markerId, markdown) => {
      core.enter('upsert_workpad');
      const ticket = requireTicket('upsert_workpad', ticketRef.key);
      const existing = ticket.comments.find((comment) => comment.marker_id === markerId);
      if (existing !== undefined) {
        existing.body = markdown;
        existing.updated_at = core.clock.now();
        ticket.updated_at = existing.updated_at;
        return commentRefOf(ticket, existing);
      }
      return commentRefOf(ticket, addComment(ticket, markdown, markerId));
    },

    addComment: async (ticketRef, markdown, commentOptions) => {
      core.enter('add_comment');
      const ticket = requireTicket('add_comment', ticketRef.key);
      return commentRefOf(ticket, addComment(ticket, markdown, commentOptions?.markerId ?? null));
    },

    setLabels: async (ticketRef, add, remove) => {
      core.enter('set_labels');
      const ticket = requireTicket('set_labels', ticketRef.key);
      const next = new Set(ticket.labels);
      for (const label of add) {
        next.add(label);
      }
      for (const label of remove) {
        next.delete(label);
      }
      ticket.labels = [...next];
      ticket.updated_at = core.clock.now();
      return [...ticket.labels];
    },

    linkMergeRequest: async (ticketRef, mrUrl) => {
      core.enter('link_merge_request');
      const ticket = requireTicket('link_merge_request', ticketRef.key);
      if (ticket.links.some((link) => link.kind === 'merge_request' && link.key === mrUrl)) {
        return;
      }
      ticket.links.push({ kind: 'merge_request', key: mrUrl, url: mrUrl, state: null });
      ticket.updated_at = core.clock.now();
    },

    createTicket: async (draft: TicketDraft) => {
      core.enter('create_ticket');
      if (!capabilities.createTicket) {
        throw new IntegrationUnsupportedError(PROVIDER, 'creating tickets');
      }
      createdCounter += 1;
      const key = `${draft.project_key}-${1000 + createdCounter}`;
      return seedTicket({
        key,
        title: draft.title,
        description: draft.description,
        issueType: draft.issue_type,
        labels: draft.labels,
        priority: draft.priority ?? null,
      });
    },

    resolveIdentity: async (query) => {
      core.enter('resolve_identity');
      if (query.providerUserId !== undefined) {
        return identities.get(query.providerUserId) ?? null;
      }
      if (query.email !== undefined) {
        return [...identities.values()].find((identity) => identity.email === query.email) ?? null;
      }
      return null;
    },

    inbound,

    seedTicket,
    peek: (key) => tickets.get(key),

    emitCommentAdded: (input) => {
      const ticket = requireTicket(ACTION, input.ticketKey);
      const identity = identityOf(input.authorId);
      commentCounter += 1;
      const comment: StoredComment = {
        id: `c-${commentCounter}`,
        author: identity,
        body: input.text,
        created_at: core.clock.now(),
        updated_at: null,
        marker_id: null,
        url: `${ticket.url}#comment-${commentCounter}`,
      };
      ticket.comments.push(comment);
      ticket.updated_at = comment.created_at;
      return buildFakeDelivery({
        secret: core.webhookSecret,
        event: 'comment.added',
        deliveryId: input.deliveryId ?? nextDeliveryId(),
        payload: {
          event: 'comment.added',
          ticket_key: ticket.key,
          comment_id: comment.id,
          author_id: input.authorId,
          text: input.text,
        },
      });
    },

    emitStatusChanged: (input) => {
      const ticket = requireTicket(ACTION, input.ticketKey);
      ticket.status = input.to;
      ticket.updated_at = core.clock.now();
      return buildFakeDelivery({
        secret: core.webhookSecret,
        event: 'status.changed',
        deliveryId: input.deliveryId ?? nextDeliveryId(),
        payload: {
          event: 'status.changed',
          ticket_key: ticket.key,
          from: input.from,
          to: input.to,
        },
      });
    },

    emitTicketMatched: (input) => {
      requireTicket(ACTION, input.ticketKey);
      return buildFakeDelivery({
        secret: core.webhookSecret,
        event: 'ticket.matched',
        deliveryId: input.deliveryId ?? nextDeliveryId(),
        payload: { event: 'ticket.matched', ticket_key: input.ticketKey, rule: input.rule },
      });
    },
  };
};

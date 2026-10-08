/**
 * The **TaskManagement** contract suite (technical/10: "`describe.each(providers)` … against the
 * in-memory fake (PR) and each real adapter in nock replay mode").
 *
 * One suite, many providers. WP-07 runs it against `FakeTaskManagement`; WP-08 runs the *same*
 * assertions against Jira Cloud with recorded fixtures, and a second provider (Jira DC, Linear,
 * GitHub Issues) runs it unchanged. Everything a later work package may rely on — a workpad that
 * is edited rather than duplicated, a transition that is idempotent, a webhook that rejects a
 * tampered body — is asserted here, so no provider can quietly be kinder than the contract.
 *
 * The suite asks the harness for a **fresh context per test**: several cases mutate the ticket
 * (labels, status, comments), and a suite whose cases depend on each other's order is a suite that
 * cannot be read.
 */
import type {
  ExternalIdentity,
  IgnoredDelivery,
  InboundContext,
  LifecycleMember,
  TaskManagementPort,
  TicketRefInput,
  WebhookDelivery,
} from '@platform/application';
import {
  assignResultSchema,
  commentPageSchema,
  externalIdentitySchema,
  LIFECYCLE_MEMBER_CAPABILITY,
  lifecycleStatusSchema,
  normaliseStatusCategory,
  ticketPollPlanSchema,
  ticketSchema,
  ticketTransitionSchema,
  unassignResultSchema,
} from '@platform/application';
import type { Id, TicketStatusCategory } from '@platform/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { expectCatalogueEvent, expectIntegrationError } from './shared.js';

export interface TaskManagementContractContext {
  readonly port: TaskManagementPort;
  /** A ticket that exists and carries `pickupLabel`. */
  readonly ticket: TicketRefInput;
  /** A key no ticket has. */
  readonly missingTicketKey: string;
  /** The status the seeded ticket is in, and a legal target to move it to. */
  readonly statuses: { readonly initial: string; readonly target: string };
  /** A status name the provider's workflow does not contain. */
  readonly unknownStatus: string;
  readonly pickupLabel: string;
  /** A provider user id that maps to a platform user, and its email. */
  readonly knownAuthor: { readonly providerUserId: string; readonly email: string };
  /** Produces a signed delivery for a comment by `knownAuthor`. */
  emitComment(text: string): WebhookDelivery;
  /** Produces a second, different delivery — for the dedup-key assertion. */
  emitStatusChange(to: string): WebhookDelivery;
  /**
   * Produces the delivery a provider sends when a ticket is **created** (WP-25).
   *
   * An obligation of the contract rather than of one adapter (standing rule 23): the ticket
   * readiness linter's door is `ticket.created`, and a provider that does not produce it is a
   * provider the feature silently does nothing for. The harness supplies the delivery because only
   * it knows what its provider sends; what the suite asserts is that it normalises into the
   * catalogue event with the ticket and its type.
   */
  emitTicketCreated(): WebhookDelivery;
  /**
   * Produces the delivery a provider sends when a human **edits** the ticket's text, and the field
   * name that delivery states changed (WP-60, PROGRESS backlog 59).
   *
   * An obligation of the contract for `ticket.created`'s reason (standing rule 23): the snapshot
   * freshness rule (Q61 (b)) is keyed on `ticket.updated`, and a provider that does not produce it
   * is a provider whose tasks run on the words the ticket had at intake, silently.
   */
  emitTicketUpdated(): WebhookDelivery;
  /** The field name {@link emitTicketUpdated}'s delivery states changed, in the provider's spelling. */
  readonly updatedField: string;
  /**
   * A delivery this provider cannot act on, and the reason it reports for it.
   *
   * Both halves are the harness's because both are provider-shaped. `{"event":"comment.added"}` is
   * a *malformed payload* to the fake's envelope, while Jira would receive the same bytes as a
   * well-formed webhook for an event its normaliser does not handle (`unsupported_event`). The
   * contract is "reported as ignored, never thrown, and never silently dropped"; which of the four
   * reasons applies is the provider's to state, and stating it keeps the assertion exact (BD-017).
   */
  readonly unhandled: {
    delivery(): WebhookDelivery;
    readonly reason: IgnoredDelivery['reason'];
  };
  /**
   * The same provider built with polling **switched on** in its binding configuration, and the
   * interval that configuration states (WP-87). An obligation of the contract (standing rule 23):
   * the ticket poller asks `pollPlan()` and trusts `matchTickets`' order, so a provider that answered
   * a plan for a binding that never asked, or returned matches newest-first, would start tickets
   * nobody labelled or move the poller's cursor past tickets it never read.
   */
  readonly polling: { readonly port: TaskManagementPort; readonly intervalSeconds: number };
  /**
   * The ticket lifecycle's half (WP-171), **required** when the provider declares any of the four
   * lifecycle flags and unread otherwise — a provider that declares none is held to the refusal
   * branch alone. The context's `ticket` starts **unassigned**.
   */
  readonly lifecycle?: TaskManagementLifecycleContext;
  readonly projectId: Id;
  readonly integrationId: Id;
  cleanup(): Promise<void>;
}

export interface TaskManagementLifecycleContext {
  /**
   * Status names the tracker has and the category each must normalise to — at least one, and the
   * harness's own invented names (BD-031: no real tracker's names in a test). What keeps an adapter
   * from answering every status `unknown`.
   */
  readonly expectedCategories: Readonly<Record<string, TicketStatusCategory>>;
  /**
   * Somebody other than the binding's own account takes the context's ticket in the tracker, out of
   * band; answers that person's provider id.
   */
  assignElsewhere(): Promise<string>;
}

export interface TaskManagementContractHarness {
  readonly name: string;
  create(): Promise<TaskManagementContractContext>;
}

const WORKPAD_MARKER = 'agentic:workpad';

// ── The ticket lifecycle (WP-171) ───────────────────────────────────────────
//
// Exported as plain async checks, not only as `it` blocks, so the canary in the runner can call one
// against a port that is wrong in a known way and assert that it **rejects** — a permanent proof
// that the clause can fail, rather than a one-off edit somebody once made and reverted.

/** The one call per member the refusal branch makes, with arguments any provider accepts. */
const callMember = (
  context: TaskManagementContractContext,
  member: LifecycleMember,
): Promise<unknown> => {
  const { port, ticket } = context;
  switch (member) {
    case 'listStatuses':
      return port.listStatuses();
    case 'listTransitions':
      return port.listTransitions(ticket);
    case 'selfIdentity':
      return port.selfIdentity();
    case 'assignToSelf':
      return port.assignToSelf(ticket);
    case 'unassign':
      return port.unassign(ticket);
    case 'listComments':
      return port.listComments(ticket, { limit: 10 });
  }
};

/** Whether the provider declares `member` (`LIFECYCLE_MEMBER_CAPABILITY`). */
const declares = (port: TaskManagementPort, member: LifecycleMember): boolean =>
  port.capabilities()[LIFECYCLE_MEMBER_CAPABILITY[member]];

/**
 * BD-017's *refuse by name, never silently*: a member the provider does not declare throws
 * `unsupported_capability` whose `action` and message name the member — never an empty answer.
 */
export const expectRefusedByName = async (
  context: TaskManagementContractContext,
  member: LifecycleMember,
): Promise<void> => {
  const error = await expectIntegrationError(
    () => callMember(context, member),
    'unsupported_capability',
  );
  expect(error.action, 'the refusal names the member').toBe(member);
  expect(error.message, 'the refusal names the member').toContain(member);
};

const lifecycleOf = (context: TaskManagementContractContext): TaskManagementLifecycleContext => {
  expect(
    context.lifecycle,
    'a provider that declares a lifecycle flag supplies the lifecycle context',
  ).toBeDefined();
  return context.lifecycle as TaskManagementLifecycleContext;
};

const sameName = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

/** `listStatuses`: the tracker's statuses, once each, with the port's own normalised categories. */
export const checkListStatuses = async (context: TaskManagementContractContext): Promise<void> => {
  const statuses = (await context.port.listStatuses()).map((status) =>
    lifecycleStatusSchema.parse(status),
  );
  expect(
    statuses.length,
    'a tracker with statuses answers them, never an empty list',
  ).toBeGreaterThan(0);
  for (const status of statuses) {
    // The category is the port's function of the raw key, so no adapter keeps a table of its own.
    expect(
      { category: status.category, raw_category: status.raw_category },
      `status ${status.name}`,
    ).toEqual(normaliseStatusCategory(status.raw_category));
  }
  const names = statuses.map((status) => status.name.toLowerCase());
  expect(new Set(names).size, 'the union over issue types names each status once').toBe(
    names.length,
  );
  for (const name of [context.statuses.initial, context.statuses.target]) {
    expect(
      statuses.some((status) => sameName(status.name, name)),
      `the workflow's status ${name} is listed`,
    ).toBe(true);
  }
  const expected = Object.entries(lifecycleOf(context).expectedCategories);
  expect(expected.length, 'the harness names at least one category to expect').toBeGreaterThan(0);
  for (const [name, category] of expected) {
    expect(
      statuses.find((status) => sameName(status.name, name))?.category,
      `the category of ${name}`,
    ).toBe(category);
  }
};

/** `listTransitions`: the moves the ticket can take, each naming its target status and category. */
export const checkListTransitions = async (
  context: TaskManagementContractContext,
): Promise<void> => {
  const transitions = (await context.port.listTransitions(context.ticket)).map((transition) =>
    ticketTransitionSchema.parse(transition),
  );
  expect(
    transitions.some((transition) => sameName(transition.to.name, context.statuses.target)),
    'the legal target is reachable, named by its status',
  ).toBe(true);
};

/** `selfIdentity` + `assignToSelf` + `unassign`: the claim lands on the binding's own account and is released. */
export const checkClaimAndRelease = async (
  context: TaskManagementContractContext,
): Promise<void> => {
  const { port, ticket } = context;
  const self = externalIdentitySchema.parse(await port.selfIdentity());

  const first = assignResultSchema.parse(await port.assignToSelf(ticket));
  expect(first.changed, 'an unassigned ticket is claimed').toBe(true);
  expect(first.assignee.external_id).toBe(self.external_id);
  expect((await port.readTicket(ticket)).assignee?.external_id, 'the ticket shows the claim').toBe(
    self.external_id,
  );
  expect(assignResultSchema.parse(await port.assignToSelf(ticket)).changed, 'idempotent').toBe(
    false,
  );

  expect(unassignResultSchema.parse(await port.unassign(ticket)).changed).toBe(true);
  expect((await port.readTicket(ticket)).assignee ?? null, 'released').toBeNull();
  expect(unassignResultSchema.parse(await port.unassign(ticket)).changed, 'idempotent').toBe(false);
};

/** `unassign` never touches somebody else's assignment. */
export const checkUnassignLeavesOthers = async (
  context: TaskManagementContractContext,
): Promise<void> => {
  const other = await lifecycleOf(context).assignElsewhere();
  const self = await context.port.selfIdentity();
  expect(other, 'the harness assigns somebody other than the binding').not.toBe(self.external_id);
  expect(unassignResultSchema.parse(await context.port.unassign(context.ticket))).toEqual({
    changed: false,
  });
  expect((await context.port.readTicket(context.ticket)).assignee?.external_id).toBe(other);
};

/** `listComments`: only comments created after `since`, newest first, bounded by `limit`. */
export const checkListComments = async (context: TaskManagementContractContext): Promise<void> => {
  const { port, ticket } = context;
  const horizon = await port.addComment(ticket, 'before the horizon');
  const horizonAt = (await port.readTicket(ticket)).comments.find(
    (comment) => comment.id === horizon.comment_id,
  )?.created_at;
  expect(horizonAt, 'the comment written through the port is read back').toBeDefined();
  const older = await port.addComment(ticket, 'after the horizon, first');
  const newer = await port.addComment(ticket, 'after the horizon, second');

  const window = commentPageSchema.parse(
    await port.listComments(ticket, { since: horizonAt as string, limit: 10 }),
  );
  expect(
    window.comments.map((comment) => comment.id),
    'only the newer comments, newest first',
  ).toEqual([newer.comment_id, older.comment_id]);
  if (window.total !== null) {
    expect(window.total).toBeGreaterThanOrEqual(window.comments.length);
  }

  const page = commentPageSchema.parse(
    await port.listComments(ticket, { since: horizonAt as string, limit: 1 }),
  );
  expect(
    page.comments.map((comment) => comment.id),
    'a limit cuts the oldest',
  ).toEqual([newer.comment_id]);
  if (page.total !== null) {
    expect(page.total, 'a total never undercounts the window').toBeGreaterThanOrEqual(2);
  }

  const whole = commentPageSchema.parse(await port.listComments(ticket, { limit: 100 }));
  expect(whole.comments.map((comment) => comment.id)).toContain(horizon.comment_id);
  const instants = whole.comments.map((comment) => Date.parse(comment.created_at));
  expect(instants, 'the whole thread is newest first too').toEqual(
    instants.toSorted((left, right) => right - left),
  );
};

/**
 * Runs `check` when the provider declares `member`, and the refusal branch when it does not — so
 * every clause is asserted one way or the other, never skipped (BD-017).
 */
const eitherBranch = async (
  context: TaskManagementContractContext,
  members: readonly LifecycleMember[],
  check: (context: TaskManagementContractContext) => Promise<void>,
): Promise<void> => {
  const declared = members.filter((member) => declares(context.port, member));
  if (declared.length === members.length) {
    await check(context);
    return;
  }
  // A clause spanning several members needs all of them; each undeclared one must refuse by name.
  for (const member of members.filter((candidate) => !declared.includes(candidate))) {
    await expectRefusedByName(context, member);
  }
};

export const runTaskManagementContract = (harness: TaskManagementContractHarness): void => {
  describe(`TaskManagement contract — ${harness.name}`, () => {
    let context: TaskManagementContractContext;
    let port: TaskManagementPort;

    beforeEach(async () => {
      context = await harness.create();
      port = context.port;
      return async () => {
        await context.cleanup();
      };
    });

    const inboundContext = (
      resolve: (identity: ExternalIdentity) => Id | null = () => null,
    ): InboundContext => ({
      projectId: context.projectId,
      integrationId: context.integrationId,
      defaultBranch: 'main',
      resolveUser: resolve,
      resolveThread: async () => null,
    });

    describe('capabilities and health', () => {
      it('declares every capability flag as a boolean', () => {
        const capabilities = port.capabilities();
        for (const [name, value] of Object.entries(capabilities)) {
          expect(typeof value, `capability ${name}`).toBe('boolean');
        }
        expect(Object.keys(capabilities)).toEqual(
          expect.arrayContaining([
            'webhooks',
            'epics',
            'links',
            'customFields',
            'adf',
            'createTicket',
            'attachments',
            'lifecycleStatuses',
            'transitionsRead',
            'assign',
            'commentsRead',
          ]),
        );
      });

      it('answers a read-only probe', async () => {
        const probe = await port.testConnection();
        expect(probe.ok).toBe(true);
        expect(Date.parse(probe.checked_at)).not.toBeNaN();
      });
    });

    describe('reading', () => {
      it('returns a ticket that matches the port schema', async () => {
        const ticket = await port.readTicket(context.ticket);
        // Parsing here (not only in the fake) is what holds a real adapter to the shape.
        const parsed = ticketSchema.parse(ticket);
        expect(parsed.ref.key).toBe(context.ticket.key);
        expect(parsed.status).toBe(context.statuses.initial);
        expect(parsed.labels).toContain(context.pickupLabel);
      });

      /**
       * WP-83, PROGRESS backlog 290 (rule 23: a port obligation lands in the shared suite). A port
       * may answer a page of comments, so it reports the thread's size — never below what it
       * returned — and every shipped adapter says it, so a consumer can tell a page from a thread.
       * The count moves with a comment written through the port, which a constant would not.
       */
      it('reports the thread’s comment total, never below the comments it returned', async () => {
        const before = await port.readTicket(context.ticket);
        expect(typeof before.comment_total).toBe('number');
        expect(before.comment_total ?? -1).toBeGreaterThanOrEqual(before.comments.length);
        await port.addComment(context.ticket, 'a comment the total must count');
        const after = await port.readTicket(context.ticket);
        expect(after.comment_total).toBe((before.comment_total ?? 0) + 1);
      });

      it('fails with not_found for a ticket that does not exist', async () => {
        await expectIntegrationError(
          () =>
            port.readTicket({
              provider: context.ticket.provider,
              key: context.missingTicketKey,
              url: context.ticket.url,
            }),
          'not_found',
        );
      });

      it('finds the ticket by its pick-up label', async () => {
        const matches = await port.matchTickets({ kind: 'label', label: context.pickupLabel });
        expect(matches.map((match) => match.ref.key)).toContain(context.ticket.key);
      });
    });

    describe('the declared scope (WP-122)', () => {
      it('admits the binding’s own ticket, and never refuses with an empty scope', () => {
        // The ticket this binding delivers is inside whatever it declares; a provider with no scope
        // concept answers `unscoped`. An `out_of_scope` verdict names a non-empty list, because the
        // manual start's refusal quotes it and an empty one would refuse with nothing to name.
        expect(['in_scope', 'unscoped']).toContain(port.ticketScope(context.ticket.key).kind);
        const other = port.ticketScope('ZZZQ-1');
        if (other.kind === 'out_of_scope') {
          expect(other.scope.length).toBeGreaterThan(0);
        }
      });
    });

    describe('polling (WP-87)', () => {
      it('polls nothing for a binding that did not switch polling on', () => {
        // Off is the default: a plan here would have the poller read a provider nobody asked it to.
        expect(port.pollPlan()).toBeNull();
      });

      it('polls for its pick-up rule at the binding’s own interval, oldest match first', async () => {
        const plan = context.polling.port.pollPlan();
        expect(plan).not.toBeNull();
        const parsed = ticketPollPlanSchema.parse(plan);
        expect(parsed.interval_seconds).toBe(context.polling.intervalSeconds);

        // The plan's rule is the rule a webhook matches with: it finds the pick-up ticket.
        const matches = await context.polling.port.matchTickets(parsed.rule);
        expect(matches.map((match) => match.ref.key)).toContain(context.ticket.key);
        const instants = matches.map((match) => Date.parse(match.updated_at));
        expect(instants, 'matchTickets answers oldest first').toEqual(
          instants.toSorted((left, right) => left - right),
        );
      });

      /**
       * WP-110 (backlog 298): the poller re-reads its live tasks' tickets with a `keys` rule, which
       * ignores the pick-up rule — a status rule stops matching a ticket the platform moved on. An
       * obligation of every provider (rule 23): one that answered tickets it was not named, or
       * missed the one it was, would record edits to the wrong ticket or none.
       */
      it('finds exactly the tickets a keys rule names (WP-110)', async () => {
        const matches = await port.matchTickets({ kind: 'keys', keys: [context.ticket.key] });
        expect(matches.map((match) => match.ref.key)).toEqual([context.ticket.key]);
      });

      /**
       * WP-110 review round 1: a live task's ticket that has since been deleted. Jira refuses the
       * whole search (400, documented for Data Center, inferred for Cloud); the port's answer is the
       * tickets that do exist — one deleted ticket must not hide every other live task's edits.
       */
      it('answers the existing tickets when a keys rule also names one that does not exist (WP-110)', async () => {
        const matches = await port.matchTickets({
          kind: 'keys',
          keys: [context.missingTicketKey, context.ticket.key],
        });
        expect(matches.map((match) => match.ref.key)).toEqual([context.ticket.key]);
        expect(await port.matchTickets({ kind: 'keys', keys: [context.missingTicketKey] })).toEqual(
          [],
        );
      });
    });

    describe('transition (idempotent by contract)', () => {
      it('moves the ticket once and reports the second call as unchanged', async () => {
        const first = await port.transition(context.ticket, context.statuses.target);
        expect(first).toEqual({
          changed: true,
          from: context.statuses.initial,
          to: context.statuses.target,
        });
        expect((await port.readTicket(context.ticket)).status).toBe(context.statuses.target);

        const second = await port.transition(context.ticket, context.statuses.target);
        expect(second.changed).toBe(false);
        expect((await port.readTicket(context.ticket)).status).toBe(context.statuses.target);
      });

      it('fails loudly for a status the workflow does not have', async () => {
        await expectIntegrationError(
          () => port.transition(context.ticket, context.unknownStatus),
          'invalid_request',
        );
      });
    });

    describe('workpad and comments (BD-023)', () => {
      it('edits one comment in place instead of posting a second workpad', async () => {
        const before = (await port.readTicket(context.ticket)).comments.length;
        const first = await port.upsertWorkpad(context.ticket, WORKPAD_MARKER, '# Workpad v1');
        const second = await port.upsertWorkpad(context.ticket, WORKPAD_MARKER, '# Workpad v2');

        expect(second.comment_id).toBe(first.comment_id);
        const after = await port.readTicket(context.ticket);
        expect(after.comments.length).toBe(before + 1);
        const workpad = after.comments.find((comment) => comment.id === first.comment_id);
        expect(workpad?.body).toBe('# Workpad v2');
        expect(workpad?.marker_id).toBe(WORKPAD_MARKER);
      });

      it('adds a new comment every time, so a question notifies', async () => {
        const before = (await port.readTicket(context.ticket)).comments.length;
        const first = await port.addComment(context.ticket, 'Question 1');
        const second = await port.addComment(context.ticket, 'Question 2');
        expect(second.comment_id).not.toBe(first.comment_id);
        expect((await port.readTicket(context.ticket)).comments.length).toBe(before + 2);
      });
    });

    describe('labels and links', () => {
      it('adds and removes labels', async () => {
        const labels = await port.setLabels(
          context.ticket,
          ['agentic:refinement'],
          [context.pickupLabel],
        );
        expect(labels).toContain('agentic:refinement');
        expect(labels).not.toContain(context.pickupLabel);
        const ticket = await port.readTicket(context.ticket);
        expect(ticket.labels).toContain('agentic:refinement');
      });

      it('links a merge request and does not duplicate the link', async () => {
        const url = 'https://git.example.test/acme/api/-/merge_requests/7';
        await port.linkMergeRequest(context.ticket, url);
        await port.linkMergeRequest(context.ticket, url);
        const ticket = await port.readTicket(context.ticket);
        const linked = ticket.links.filter((link) => link.key === url || link.url === url);
        expect(linked.length).toBe(1);
      });
    });

    describe('identity', () => {
      it('resolves a known author by email and reports an unknown one as null', async () => {
        const identity = await port.resolveIdentity({ email: context.knownAuthor.email });
        expect(identity?.external_id).toBe(context.knownAuthor.providerUserId);
        expect(await port.resolveIdentity({ email: 'nobody@example.test' })).toBeNull();
      });
    });

    describe('inbound (BD-022)', () => {
      it('accepts an authentic delivery and rejects a tampered one', () => {
        const delivery = context.emitComment('hello');
        expect(port.inbound.verify(delivery)).toBe(true);

        const tampered: WebhookDelivery = {
          headers: delivery.headers,
          body: `${delivery.body.slice(0, -1)}, "injected": true}`,
        };
        expect(port.inbound.verify(tampered)).toBe(false);

        const unsigned: WebhookDelivery = { headers: {}, body: delivery.body };
        expect(port.inbound.verify(unsigned)).toBe(false);
      });

      it('gives each delivery a stable, distinct dedup key', () => {
        const first = context.emitComment('one');
        const second = context.emitStatusChange(context.statuses.target);
        expect(port.inbound.deliveryKey(first)).toBe(port.inbound.deliveryKey(first));
        expect(port.inbound.deliveryKey(first)).not.toBe(port.inbound.deliveryKey(second));
      });

      /**
       * WP-25's door. The *type* is what the linter's filter selects on, so a provider that
       * normalised a creation without it would make `features.ticket_linter.issue_types` decide
       * nothing — which is the shape of a filter that silently matches nothing.
       */
      it('normalises a created ticket into ticket.created, carrying its issue type', async () => {
        const result = await port.inbound.normalise(context.emitTicketCreated(), inboundContext());
        expect(result.ignored).toEqual([]);
        const created = result.events.find((event) => event.type === 'ticket.created');
        expect(created, 'no ticket.created event was produced').toBeDefined();
        const payload = created?.payload as {
          project_id: Id;
          ticket: TicketRefInput;
          issue_type: string | null;
        };
        expect(payload.project_id).toBe(context.projectId);
        expect(payload.ticket.key).toBe(context.ticket.key);
        expect(typeof payload.issue_type).toBe('string');
      });

      /**
       * WP-60's obligation. The ticket and the provider's own instant are what the consumer needs
       * (it finds the live tasks by the ticket and marks their snapshots stale); the changed field
       * is what the delivery already held, and a provider that dropped it would publish an edit
       * with no content.
       */
      it('normalises an edited ticket into ticket.updated, with its instant and the field', async () => {
        const result = await port.inbound.normalise(context.emitTicketUpdated(), inboundContext());
        expect(result.ignored).toEqual([]);
        const updated = result.events.filter((event) => event.type === 'ticket.updated');
        expect(updated, 'exactly one ticket.updated per delivery').toHaveLength(1);
        const { payload } = expectCatalogueEvent(
          updated[0] as NonNullable<(typeof updated)[0]>,
          'ticket.updated',
        );
        expect(payload.project_id).toBe(context.projectId);
        expect((payload.ticket as TicketRefInput).key).toBe(context.ticket.key);
        expect(Number.isNaN(Date.parse(payload.updated_at as string))).toBe(false);
        expect(payload.changed_fields).toContain(context.updatedField);
      });

      /**
       * *Beside*, not instead of (WP-60 criterion 1): a status change is an edit too, and its
       * `ticket.status.changed` must survive the new event rather than be replaced by it.
       */
      it('reports a status change as ticket.status.changed and ticket.updated beside it', async () => {
        const result = await port.inbound.normalise(
          context.emitStatusChange(context.statuses.target),
          inboundContext(),
        );
        expect(result.ignored).toEqual([]);
        const types = result.events.map((event) => event.type);
        expect(types).toContain('ticket.status.changed');
        expect(types).toContain('ticket.updated');
      });

      it('normalises a comment into a catalogue event with a verified author', async () => {
        const userId = '00000000-0000-4000-8000-00000000f001';
        const delivery = context.emitComment('please rebase');
        const result = await port.inbound.normalise(
          delivery,
          inboundContext(() => userId),
        );

        expect(result.ignored).toEqual([]);
        expect(result.events.length).toBe(1);
        const [event] = result.events;
        const { payload } = expectCatalogueEvent(
          event as NonNullable<typeof event>,
          'ticket.comment.added',
        );
        expect(payload.project_id).toBe(context.projectId);
        expect(payload.text).toBe('please rebase');
        expect((payload.author as ExternalIdentity).verified).toBe(true);
      });

      it('still records a comment from an unmapped author, marked unverified', async () => {
        const delivery = context.emitComment('drive-by comment');
        const result = await port.inbound.normalise(
          delivery,
          inboundContext(() => null),
        );

        expect(result.events.length).toBe(1);
        const [event] = result.events;
        const { payload } = expectCatalogueEvent(
          event as NonNullable<typeof event>,
          'ticket.comment.added',
        );
        expect((payload.author as ExternalIdentity).verified).toBe(false);
      });

      it('reports a delivery it cannot act on as ignored instead of throwing', async () => {
        const result = await port.inbound.normalise(context.unhandled.delivery(), inboundContext());
        expect(result.events, 'an unusable delivery produces no event').toEqual([]);
        expect(result.ignored.length, 'and says exactly once why').toBe(1);
        expect(result.ignored[0]?.reason, 'with the reason this provider reports').toBe(
          context.unhandled.reason,
        );
        expect(
          result.ignored[0]?.detail.length,
          'and a detail, because a silent drop is undebuggable',
        ).toBeGreaterThan(0);
      });
    });

    /**
     * WP-171 (TD-029 decision 2, technical/06's M10-head amendment): each clause runs its behaviour
     * when the provider declares the member and the refusal branch when it does not, so neither an
     * unimplemented member nor a silent empty answer can pass.
     */
    describe('the ticket lifecycle (WP-171)', () => {
      it('refuses by name every lifecycle member its flags do not declare', async () => {
        for (const member of Object.keys(LIFECYCLE_MEMBER_CAPABILITY) as LifecycleMember[]) {
          if (!declares(port, member)) {
            await expectRefusedByName(context, member);
          }
        }
      });

      it('lists the tracker’s statuses with normalised categories', async () => {
        await eitherBranch(context, ['listStatuses'], checkListStatuses);
      });

      it('lists the ticket’s transitions by their target status', async () => {
        await eitherBranch(context, ['listTransitions'], checkListTransitions);
      });

      it('claims the ticket as selfIdentity, shown by readTicket, and releases it', async () => {
        await eitherBranch(
          context,
          ['selfIdentity', 'assignToSelf', 'unassign'],
          checkClaimAndRelease,
        );
      });

      it('leaves another person’s assignment untouched on unassign (changed: false)', async () => {
        await eitherBranch(context, ['selfIdentity', 'unassign'], checkUnassignLeavesOthers);
      });

      it('lists only the comments newer than `since`, newest first', async () => {
        await eitherBranch(context, ['listComments'], checkListComments);
      });
    });

    describe('creating tickets', () => {
      it('creates a follow-up ticket, or refuses when it cannot', async () => {
        const draft = {
          project_key: 'FAKE',
          issue_type: 'Task',
          title: 'Follow-up: extract the parser',
          description: 'Split out of the original ticket by the scope-creep valve.',
          labels: ['agentic:followup'],
          parent_key: null,
          priority: null,
        };
        if (!port.capabilities().createTicket) {
          // Not a skip: a provider that cannot do it must say so, not fail obscurely later.
          await expectIntegrationError(() => port.createTicket(draft), 'unsupported_capability');
          return;
        }
        const ref = await port.createTicket(draft);
        const created = await port.readTicket(ref);
        expect(created.title).toBe('Follow-up: extract the parser');
        expect(created.labels).toContain('agentic:followup');
      });
    });
  });
};

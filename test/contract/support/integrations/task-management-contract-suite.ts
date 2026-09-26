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
  TaskManagementPort,
  TicketRefInput,
  WebhookDelivery,
} from '@platform/application';
import { ticketSchema } from '@platform/application';
import type { Id } from '@platform/contracts';
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
  readonly projectId: Id;
  readonly integrationId: Id;
  cleanup(): Promise<void>;
}

export interface TaskManagementContractHarness {
  readonly name: string;
  create(): Promise<TaskManagementContractContext>;
}

const WORKPAD_MARKER = 'agentic:workpad';

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
      resolveUser: resolve,
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

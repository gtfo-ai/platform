/**
 * Webhook golden tests for the Jira Cloud provider (WP-08 acceptance: "contract suite green in
 * replay mode; webhook golden tests").
 *
 * Two halves, and the order is deliberate.
 *
 *  1. **Verification**, negatives included: a tampered body, a tampered signature of the right
 *     length, a missing header, an unsupported method, and a replayed old delivery. Every one of
 *     them is paired with the *authentic* delivery in the same test, because a verifier that
 *     rejects everything — a broken harness, a wrong secret, a normaliser that never ran — passes
 *     a suite of negatives alone (standing rule 4).
 *  2. **Normalisation**, golden: each recorded delivery in `test/fixtures/http/jira-cloud/` is
 *     asserted down to its payload, and each unhandled one is asserted to say *why* it produced
 *     nothing.
 */
import type { ExternalIdentity, InboundContext, WebhookDelivery } from '@platform/application';
import { IntegrationError } from '@platform/application';
import { MAX_TICKET_UPDATED_FIELD_CHARS, MAX_TICKET_UPDATED_FIELDS } from '@platform/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createJiraBinding,
  JIRA_INTEGRATION_ID,
  JIRA_PROJECT_ID,
  type JiraBinding,
} from '../support/integrations/jira-cloud-harness.js';
import { JIRA_REPLAY_SECRET } from '../support/integrations/jira-cloud-replay.js';
import { expectCatalogueEvent } from '../support/integrations/shared.js';

const MAPPED_USER = '00000000-0000-4000-8000-00000000f108';
const DEV_ACCOUNT_ID = '557058:00000000-0000-4000-8000-00000000d0c1';
const PM_ACCOUNT_ID = '557058:00000000-0000-4000-8000-00000000d0c2';
/** The `timestamp` every webhook fixture carries; the harness clock stands five minutes later. */
const FIXTURE_TIMESTAMP = 1_788_350_400_000;

describe('jira-cloud webhooks', () => {
  let binding: JiraBinding;

  beforeEach(() => {
    binding = createJiraBinding();
  });

  const inboundContext = (
    resolve: (identity: ExternalIdentity) => string | null = () => null,
  ): InboundContext => ({
    projectId: JIRA_PROJECT_ID,
    integrationId: JIRA_INTEGRATION_ID,
    resolveUser: resolve,
  });

  describe('verification (X-Hub-Signature, WebSub)', () => {
    it('accepts a delivery signed with the binding’s secret', () => {
      expect(
        binding.port.inbound.verify(binding.replay.delivery('webhook-comment-created.json')),
      ).toBe(true);
    });

    it('rejects a body edited after signing', () => {
      const authentic = binding.replay.delivery('webhook-comment-created.json');
      expect(binding.port.inbound.verify(authentic), 'control: authentic first').toBe(true);

      const tampered = {
        headers: authentic.headers,
        body: `${authentic.body.slice(0, -1)}, "injected": true}`,
      };
      expect(binding.port.inbound.verify(tampered)).toBe(false);
    });

    it('rejects a signature of the right length with the wrong digest', () => {
      const authentic = binding.replay.delivery('webhook-comment-created.json');
      const signature = authentic.headers['x-hub-signature'] as string;
      // One hex digit flipped: same `sha256=` prefix, same 64 hex characters, different value —
      // the case a length check alone would wave through.
      const flipped = `${signature.slice(0, -1)}${signature.endsWith('a') ? 'b' : 'a'}`;
      expect(flipped.length).toBe(signature.length);
      expect(
        binding.port.inbound.verify({
          headers: { ...authentic.headers, 'x-hub-signature': flipped },
          body: authentic.body,
        }),
      ).toBe(false);
    });

    it('rejects a missing header, an empty one and an unsupported method', () => {
      const authentic = binding.replay.delivery('webhook-comment-created.json');
      const digest = (authentic.headers['x-hub-signature'] as string).split('=')[1] as string;
      const withHeader = (value?: string): WebhookDelivery => ({
        headers: value === undefined ? {} : { 'x-hub-signature': value },
        body: authentic.body,
      });

      expect(binding.port.inbound.verify(authentic), 'control: authentic first').toBe(true);
      expect(binding.port.inbound.verify(withHeader()), 'no header').toBe(false);
      expect(binding.port.inbound.verify(withHeader('')), 'empty header').toBe(false);
      // Atlassian warns "Jira might start using another method for the HMAC in the future"; an
      // unknown method fails closed rather than being verified as sha256 anyway.
      expect(binding.port.inbound.verify(withHeader(`sha1=${digest}`)), 'wrong method').toBe(false);
      expect(binding.port.inbound.verify(withHeader(digest)), 'no method at all').toBe(false);
    });

    it('rejects a delivery signed with another secret', () => {
      const foreign = binding.replay.delivery('webhook-comment-created.json', {
        secret: 'FAKE-some-other-webhook-secret-9876',
      });
      expect(binding.port.inbound.verify(foreign)).toBe(false);
      expect(
        binding.port.inbound.verify(binding.replay.delivery('webhook-comment-created.json')),
        'control: the harness can still make an acceptable one',
      ).toBe(true);
    });

    it('rejects a replay of yesterday’s captured delivery, and accepts today’s', () => {
      const fresh = binding.replay.delivery('webhook-comment-created.json', {
        timestamp: FIXTURE_TIMESTAMP,
      });
      expect(binding.port.inbound.verify(fresh), 'control: within the window').toBe(true);

      // Correctly signed — the attacker captured it — but 25 hours old.
      const replayed = binding.replay.delivery('webhook-comment-created.json', {
        timestamp: FIXTURE_TIMESTAMP - 25 * 60 * 60 * 1000,
      });
      expect(binding.port.inbound.verify(replayed)).toBe(false);

      // Still inside Jira's documented retry envelope (five attempts, 5–15 minutes apart, then one
      // attempt per webhook until a delivery succeeds), so a legitimate retry is not thrown away.
      const retried = binding.replay.delivery('webhook-comment-created.json', {
        timestamp: FIXTURE_TIMESTAMP - 45 * 60 * 1000,
      });
      expect(binding.port.inbound.verify(retried)).toBe(true);
    });

    it('rejects a delivery dated in the future beyond the skew allowance', () => {
      const skewed = binding.replay.delivery('webhook-comment-created.json', {
        timestamp: FIXTURE_TIMESTAMP + 10 * 60 * 1000,
      });
      expect(binding.port.inbound.verify(skewed)).toBe(false);
    });

    it('rejects a delivery with no timestamp to bound', () => {
      const undated = binding.replay.delivery('webhook-comment-created.json', {
        patch: (body) => {
          delete body.timestamp;
        },
      });
      expect(binding.port.inbound.verify(undated)).toBe(false);
    });

    it('uses the secret it was configured with, whatever that secret is', () => {
      // The digest arithmetic itself is pinned to Atlassian's published test vector in
      // `packages/integrations/src/providers/jira-cloud/webhook.test.ts`; what this asserts is
      // that the *binding's* secret is the one this path signs with.
      const documented = createJiraBinding({
        config: { webhook_secret: "It's a Secret to Everybody" },
      });
      const signedForThem = binding.replay.delivery('webhook-comment-created.json', {
        secret: "It's a Secret to Everybody",
      });
      expect(documented.port.inbound.verify(signedForThem)).toBe(true);
      expect(
        binding.port.inbound.verify(signedForThem),
        'and the other binding, with another secret, rejects it',
      ).toBe(false);
    });
  });

  describe('dedup key', () => {
    it('is the identifier header, which Jira keeps stable across retries', () => {
      const delivery = binding.replay.delivery('webhook-comment-created.json', {
        deliveryId: '00000000-0000-4000-8000-0000000000ab',
      });
      expect(binding.port.inbound.deliveryKey(delivery)).toBe(
        'jira-cloud:00000000-0000-4000-8000-0000000000ab',
      );
    });

    it('fails loudly when a delivery carries nothing to key on', () => {
      expect(() => binding.port.inbound.deliveryKey({ headers: {}, body: '{}' })).toThrow(
        IntegrationError,
      );
    });
  });

  describe('normalisation (golden)', () => {
    it('comment_created becomes ticket.comment.added with the comment as markdown', async () => {
      const result = await binding.port.inbound.normalise(
        binding.replay.delivery('webhook-comment-created.json'),
        inboundContext(() => MAPPED_USER),
      );

      expect(result.ignored).toEqual([]);
      expect(result.events.length).toBe(1);
      const { payload } = expectCatalogueEvent(
        result.events[0] as NonNullable<(typeof result.events)[0]>,
        'ticket.comment.added',
      );
      expect(payload).toEqual({
        project_id: JIRA_PROJECT_ID,
        task_id: null,
        ticket: {
          provider: 'jira-cloud',
          key: 'ACME-1',
          url: 'https://acme-example.atlassian.net/browse/ACME-1',
        },
        comment_id: '10105',
        author: {
          provider: 'jira-cloud',
          external_id: DEV_ACCOUNT_ID,
          // The documented webhook user shape carries no email at all.
          email: null,
          display_name: 'Dev One',
          verified: true,
        },
        text: 'please rebase',
      });
    });

    it('marks an author the platform cannot map as unverified, and still records the comment', async () => {
      const result = await binding.port.inbound.normalise(
        binding.replay.delivery('webhook-comment-created.json'),
        inboundContext(() => null),
      );
      const { payload } = expectCatalogueEvent(
        result.events[0] as NonNullable<(typeof result.events)[0]>,
        'ticket.comment.added',
      );
      expect((payload.author as ExternalIdentity).verified).toBe(false);
    });

    it('a status change becomes ticket.status.changed with both status names', async () => {
      const result = await binding.port.inbound.normalise(
        binding.replay.delivery('webhook-issue-updated-status.json'),
        inboundContext(),
      );
      expect(result.ignored).toEqual([]);
      const event = result.events[0] as NonNullable<(typeof result.events)[0]>;
      const { payload } = expectCatalogueEvent(event, 'ticket.status.changed');
      expect(payload.from).toBe('Ready for agent');
      expect(payload.to).toBe('In Progress');
      expect(event.actor).toEqual({
        kind: 'integration',
        integration_id: JIRA_INTEGRATION_ID,
        provider: 'jira-cloud',
        identity: {
          provider: 'jira-cloud',
          external_id: PM_ACCOUNT_ID,
          email: null,
          display_name: 'PM Two',
          verified: false,
        },
      });
    });

    it('the pick-up label being added becomes ticket.matched, naming the rule', async () => {
      const result = await binding.port.inbound.normalise(
        binding.replay.delivery('webhook-issue-updated-labels.json'),
        inboundContext(),
      );
      expect(result.ignored).toEqual([]);
      const { payload } = expectCatalogueEvent(
        result.events[0] as NonNullable<(typeof result.events)[0]>,
        'ticket.matched',
      );
      expect(payload).toEqual({
        project_id: JIRA_PROJECT_ID,
        ticket: {
          provider: 'jira-cloud',
          key: 'ACME-1',
          url: 'https://acme-example.atlassian.net/browse/ACME-1',
        },
        rule: 'label = "agentic"',
        priority: 'High',
        issue_type: 'Bug',
        epic: 'ACME-100',
        links: [
          {
            kind: 'is_blocked_by',
            key: 'ACME-3',
            url: 'https://acme-example.atlassian.net/browse/ACME-3',
          },
        ],
      });
    });

    it('a label change that does not add the pick-up label is not a match', async () => {
      const result = await binding.port.inbound.normalise(
        binding.replay.delivery('webhook-issue-updated-labels.json', {
          patch: (body) => {
            // Jira states a label change as space-separated lists; here the pick-up label is in
            // both, so nothing was added.
            const changelog = body.changelog as { items: unknown[] };
            changelog.items[0] = {
              field: 'labels',
              fieldtype: 'jira',
              fromString: 'billing agentic',
              toString: 'billing agentic urgent',
            };
          },
        }),
        inboundContext(),
      );
      // Not a match — the label was already there — and still an edit (WP-60): the delivery is
      // `ticket.updated` alone, naming the field, where it used to be `unsupported_event`.
      expect(
        result.events.map((event) => event.type),
        'the label was already there',
      ).toEqual(['ticket.updated']);
      expect(result.ignored).toEqual([]);
      expect(
        (result.events[0]?.payload as { changed_fields: string[] } | undefined)?.changed_fields,
      ).toEqual(['labels']);
    });

    /**
     * WP-60 (PROGRESS backlog 59): until then this case was *"an edit the pipeline does not act on
     * is ignored with a reason, not dropped"*, asserting `unsupported_event` naming `summary` — the
     * branch an edited description died on. Atlassian's own example is the golden input.
     */
    it('an edit becomes ticket.updated with the ticket, the provider’s instant and the field', async () => {
      const result = await binding.port.inbound.normalise(
        binding.replay.delivery('webhook-issue-updated-summary.json'),
        inboundContext(),
      );
      expect(result.ignored).toEqual([]);
      expect(result.events).toHaveLength(1);
      const event = result.events[0] as NonNullable<(typeof result.events)[0]>;
      const { payload } = expectCatalogueEvent(event, 'ticket.updated');
      expect(payload).toEqual({
        project_id: JIRA_PROJECT_ID,
        ticket: {
          provider: 'jira-cloud',
          key: 'ACME-1',
          url: 'https://acme-example.atlassian.net/browse/ACME-1',
        },
        // The fixture's `issue.fields.updated`, `2026-09-01T10:15:00.000+0000`, as ISO — the
        // provider's own instant, not the envelope's `timestamp` and not the platform's clock.
        updated_at: '2026-09-01T10:15:00.000Z',
        changed_fields: ['summary'],
        truncated: false,
      });
      // The editor, as `ticket.status.changed` names its actor: provider identity, never verified here.
      expect(event.actor).toEqual(
        expect.objectContaining({
          kind: 'integration',
          identity: expect.objectContaining({ external_id: PM_ACCOUNT_ID, verified: false }),
        }),
      );
    });

    /**
     * PROGRESS backlog 185, folded into WP-60's review: `changelogItemSchema` has a key named
     * `toString`, and an item that omitted its own was read as `Object.prototype.toString` — the
     * whole delivery was `malformed_payload`, its pick-up and its status change dropped, and Jira's
     * retry deduplicated away (measured: *"changelog.items.0.toString: Invalid input: expected
     * string, received function"*). Atlassian's documented label-add, with a second changelog item
     * that carries **no** `toString`, `fromString`, `from` or `to` at all.
     */
    it('reads a changelog item without its own toString as absent, and keeps the delivery', async () => {
      const result = await binding.port.inbound.normalise(
        binding.replay.delivery('webhook-issue-updated-labels.json', {
          patch: (body) => {
            (body.changelog as { items: unknown[] }).items.push({
              field: 'Rank',
              fieldtype: 'jira',
            });
          },
        }),
        inboundContext(),
      );
      expect(result.ignored).toEqual([]);
      expect(result.events.map((event) => event.type)).toEqual([
        'ticket.matched',
        'ticket.updated',
      ]);
      expect(
        (result.events[1]?.payload as { changed_fields: string[] } | undefined)?.changed_fields,
      ).toEqual(['labels', 'Rank']);
    });

    it('reads a status item without its own toString as an empty target, not a function', async () => {
      // The reader's half of backlog 185: zod's output object is ordinary, so `item.toString` on a
      // parsed item with no such key was the inherited function again.
      const result = await binding.port.inbound.normalise(
        binding.replay.delivery('webhook-issue-updated-status.json', {
          patch: (body) => {
            const item = (body.changelog as { items: object[] }).items[0] ?? {};
            Reflect.deleteProperty(item, 'toString');
          },
        }),
        inboundContext(),
      );
      expect(result.ignored).toEqual([]);
      const status = result.events.find((event) => event.type === 'ticket.status.changed');
      expect((status?.payload as { to: unknown } | undefined)?.to).toBe('');
    });

    it('bounds and de-duplicates the changed field names, and says when it cut them', async () => {
      const result = await binding.port.inbound.normalise(
        binding.replay.delivery('webhook-issue-updated-summary.json', {
          patch: (body) => {
            const long = 'x'.repeat(MAX_TICKET_UPDATED_FIELD_CHARS + 5);
            // Every item carries its own `toString`, as Atlassian's example does; an item without
            // one is the case above (backlog 185).
            const item = (field?: string) => ({
              ...(field === undefined ? {} : { field }),
              fieldtype: 'jira',
              fromString: null,
              toString: null,
            });
            (body.changelog as { items: unknown[] }).items = [
              item('summary'),
              item('summary'),
              item('   '),
              item(),
              item(long),
              ...Array.from({ length: MAX_TICKET_UPDATED_FIELDS + 3 }, (_, index) =>
                item(`customfield_${index}`),
              ),
            ];
          },
        }),
        inboundContext(),
      );
      expect(result.ignored).toEqual([]);
      const { payload } = expectCatalogueEvent(
        result.events[0] as NonNullable<(typeof result.events)[0]>,
        'ticket.updated',
      );
      const fields = payload.changed_fields as string[];
      expect(fields).toHaveLength(MAX_TICKET_UPDATED_FIELDS);
      expect(fields[0]).toBe('summary');
      expect(fields[1]).toBe('x'.repeat(MAX_TICKET_UPDATED_FIELD_CHARS));
      expect(new Set(fields).size).toBe(fields.length);
      expect(payload.truncated).toBe(true);
    });

    it('an event type this provider does not handle is ignored by name', async () => {
      const result = await binding.port.inbound.normalise(
        binding.replay.delivery('webhook-worklog-created.json'),
        inboundContext(),
      );
      expect(result.events).toEqual([]);
      expect(result.ignored).toEqual([
        { reason: 'unsupported_event', detail: 'worklog_created is not handled by this provider' },
      ]);
    });

    it('an issue from another project is ignored as not_for_this_project', async () => {
      const result = await binding.port.inbound.normalise(
        binding.replay.delivery('webhook-comment-created.json', {
          patch: (body) => {
            (body.issue as { key: string }).key = 'OTHER-9';
          },
        }),
        inboundContext(),
      );
      expect(result.events).toEqual([]);
      expect(result.ignored[0]?.reason).toBe('not_for_this_project');
    });

    it('a body that is not a Jira delivery is malformed, never an exception', async () => {
      const notJson = await binding.port.inbound.normalise(
        { headers: {}, body: '{' },
        inboundContext(),
      );
      expect(notJson.ignored[0]?.reason).toBe('malformed_payload');

      const noIssue = await binding.port.inbound.normalise(
        binding.replay.delivery('webhook-comment-created.json', {
          patch: (body) => {
            delete body.issue;
          },
        }),
        inboundContext(),
      );
      expect(noIssue.ignored[0]?.reason).toBe('malformed_payload');
      expect(noIssue.ignored[0]?.detail).toContain('comment_created');
    });

    it('a delivery signed with the wrong secret still normalises — verification is the endpoint’s job', async () => {
      // The port splits the three questions on purpose: `verify` answers "is it authentic",
      // `normalise` answers "what does it mean". The HTTP endpoint (WP-15) is what refuses to call
      // the second without the first, and this test states that boundary rather than assuming it.
      const foreign = binding.replay.delivery('webhook-comment-created.json', {
        secret: 'FAKE-some-other-webhook-secret-9876',
      });
      expect(binding.port.inbound.verify(foreign)).toBe(false);
      const result = await binding.port.inbound.normalise(foreign, inboundContext());
      expect(result.events.length).toBe(1);
    });
  });

  describe('pick-up rules', () => {
    it('announces a match when the ticket moves into the pick-up status', async () => {
      const byStatus = createJiraBinding({
        config: { pickup_status: 'In Progress', pickup_label: null },
      });
      const result = await byStatus.port.inbound.normalise(
        byStatus.replay.delivery('webhook-issue-updated-status.json'),
        inboundContext(),
      );
      const types = result.events.map((event) => event.type).sort();
      expect(types, 'the move is a match, a status change and an edit (WP-60)').toEqual([
        'ticket.matched',
        'ticket.status.changed',
        'ticket.updated',
      ]);
      const matched = result.events.find((event) => event.type === 'ticket.matched');
      expect((matched?.payload as { rule?: string } | undefined)?.rule).toBe(
        'status = "In Progress"',
      );
    });

    it('does not announce a match for a move to any other status', async () => {
      const byStatus = createJiraBinding({
        config: { pickup_status: 'In Review', pickup_label: null },
      });
      const result = await byStatus.port.inbound.normalise(
        byStatus.replay.delivery('webhook-issue-updated-status.json'),
        inboundContext(),
      );
      expect(result.events.map((event) => event.type)).toEqual([
        'ticket.status.changed',
        'ticket.updated',
      ]);
    });

    it('announces nothing when the binding has no pick-up rule at all', async () => {
      const none = createJiraBinding({ config: { pickup_label: null, pickup_status: null } });
      const result = await none.port.inbound.normalise(
        none.replay.delivery('webhook-issue-updated-labels.json'),
        inboundContext(),
      );
      // No match without a rule; the edit itself is still reported (WP-60).
      expect(result.events.map((event) => event.type)).toEqual(['ticket.updated']);
      expect(result.ignored).toEqual([]);
    });

    it('treats a ticket created with the label as a match, without a changelog', async () => {
      const result = await binding.port.inbound.normalise(
        binding.replay.delivery('webhook-issue-updated-labels.json', {
          patch: (body) => {
            body.webhookEvent = 'jira:issue_created';
            delete body.changelog;
          },
        }),
        inboundContext(),
      );
      // **Both**, and that is WP-25's shape: creation is a fact of its own, and the pick-up label
      // is a second one. The linter reads `ticket.created` and skips the ticket precisely because
      // it carries the label — a decision it takes from the ticket rather than from this pair.
      expect(result.events.map((event) => event.type)).toEqual([
        'ticket.matched',
        'ticket.created',
      ]);
    });

    it('reports a created ticket that matches nothing as ticket.created alone (WP-25)', async () => {
      const result = await binding.port.inbound.normalise(
        binding.replay.delivery('webhook-issue-updated-labels.json', {
          patch: (body) => {
            body.webhookEvent = 'jira:issue_created';
            delete body.changelog;
            const issue = body.issue as { fields: { labels: string[] } };
            issue.fields.labels = ['billing'];
          },
        }),
        inboundContext(),
      );
      expect(result.ignored).toEqual([]);
      const { payload } = expectCatalogueEvent(
        result.events[0] as NonNullable<(typeof result.events)[0]>,
        'ticket.created',
      );
      expect(result.events).toHaveLength(1);
      expect(payload).toEqual({
        project_id: JIRA_PROJECT_ID,
        ticket: {
          provider: 'jira-cloud',
          key: 'ACME-1',
          url: 'https://acme-example.atlassian.net/browse/ACME-1',
        },
        issue_type: 'Bug',
      });
    });

    it('is not a creation when the same issue is merely edited (WP-25)', async () => {
      const result = await binding.port.inbound.normalise(
        binding.replay.delivery('webhook-issue-updated-summary.json'),
        inboundContext(),
      );
      // The other direction of the pair above (standing rule 42): an edit produces neither
      // `ticket.created` nor `ticket.matched`, so a ticket is never linted twice because somebody
      // fixed a typo — it produces `ticket.updated` and nothing else (WP-60).
      expect(result.events.map((event) => event.type)).toEqual(['ticket.updated']);
    });
  });

  describe('malformed deliveries', () => {
    it('names the field that failed the envelope schema', async () => {
      const result = await binding.port.inbound.normalise(
        {
          headers: {},
          body: JSON.stringify({ timestamp: 'soon', webhookEvent: 'comment_created' }),
        },
        inboundContext(),
      );
      expect(result.ignored[0]?.reason).toBe('malformed_payload');
      expect(result.ignored[0]?.detail).toContain('timestamp');
    });

    it('reports a comment event with no comment rather than inventing one', async () => {
      const result = await binding.port.inbound.normalise(
        binding.replay.delivery('webhook-comment-created.json', {
          patch: (body) => {
            delete body.comment;
          },
        }),
        inboundContext(),
      );
      expect(result.ignored).toEqual([
        { reason: 'malformed_payload', detail: 'comment_created carried no comment' },
      ]);
    });

    it('falls back to the acting user when the comment carries no author', async () => {
      const result = await binding.port.inbound.normalise(
        binding.replay.delivery('webhook-comment-created.json', {
          patch: (body) => {
            delete (body.comment as Record<string, unknown>).author;
          },
        }),
        inboundContext(),
      );
      const payload = result.events[0]?.payload as { author: ExternalIdentity };
      expect(payload.author.external_id, 'the envelope’s user acted').toBe(DEV_ACCOUNT_ID);
    });

    it('records an unattributable comment rather than dropping it', async () => {
      const result = await binding.port.inbound.normalise(
        binding.replay.delivery('webhook-comment-created.json', {
          patch: (body) => {
            delete (body.comment as Record<string, unknown>).author;
            delete body.user;
          },
        }),
        inboundContext(),
      );
      const payload = result.events[0]?.payload as { author: ExternalIdentity };
      expect(payload.author.external_id).toBe('unknown');
      expect(payload.author.verified).toBe(false);
    });
  });

  describe('the secret the harness signs with', () => {
    it('is obviously fake, and the binding’s own', () => {
      expect(JIRA_REPLAY_SECRET).toContain('FAKE');
    });
  });
});

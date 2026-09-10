/**
 * The TaskManagement contract against the **Jira Cloud** adapter in fixture-replay mode, plus the
 * assertions that are Jira's own (technical/10 contract tier, WP-08).
 *
 * The first half runs `runTaskManagementContract` — the same file WP-07 runs against the in-memory
 * fake, unchanged. That is the whole point of BD-017: a provider is added by writing a runner, not
 * by editing the contract.
 *
 * The second half asserts the four things the shared suite cannot express, because they are about
 * *how* the adapter reaches Jira rather than about what the port returns:
 *
 *  1. every mutating port method reaches `IntegrationActionExecutor` as a `MutatingActionRequest`
 *     — proven by running it in shadow mode and asserting no write request left the adapter
 *     (`ReadActionRequest` § "`mutating: false` is a claim the executor cannot check");
 *  2. a documented `429` with `Retry-After` is retried after exactly that delay, on an injected
 *     timer;
 *  3. no error that escapes the adapter carries the API token, over any of the routes pino
 *     serialises;
 *  4. `testConnection` redacts its `detail` before returning it — the obligation `HealthProbe`
 *     states.
 */
import { IntegrationError, noSecretsRedactor } from '@platform/application';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createJiraBinding,
  JIRA_INTEGRATION_ID,
  JIRA_PICKUP_LABEL,
  JIRA_PROJECT_ID,
  JIRA_TICKET,
  type JiraBinding,
} from '../support/integrations/jira-cloud-harness.js';
import { createJiraReplay, JIRA_REPLAY_TOKEN } from '../support/integrations/jira-cloud-replay.js';
import {
  runTaskManagementContract,
  type TaskManagementContractContext,
} from '../support/integrations/task-management-contract-suite.js';

const DEV_ACCOUNT_ID = '557058:00000000-0000-4000-8000-00000000d0c1';

/**
 * The same replayed site, except that `GET /myself` answers without an `accountId`.
 *
 * Jira's own user schema makes `accountId` optional, so this is a shape the provider can produce
 * and the adapter must survive; the double is not weakened for anything else.
 */
const withoutSelfAccountId = (): typeof globalThis.fetch => {
  const replay = createJiraReplay();
  return async (input, init) => {
    const response = await replay.fetch(input, init);
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!url.pathname.endsWith('/myself')) {
      return response;
    }
    const body = (await response.json()) as Record<string, unknown>;
    delete body.accountId;
    return new Response(JSON.stringify(body), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
  };
};

runTaskManagementContract({
  name: 'jira-cloud (recorded fixtures)',
  create: async (): Promise<TaskManagementContractContext> => {
    const binding = createJiraBinding();
    let deliveries = 0;
    const nextDeliveryId = (): string => {
      deliveries += 1;
      return `00000000-0000-4000-8000-0000000d00${deliveries}`;
    };

    return {
      port: binding.port,
      ticket: JIRA_TICKET,
      missingTicketKey: 'ACME-404',
      statuses: { initial: 'Ready for agent', target: 'In Progress' },
      unknownStatus: 'Shipped To Mars',
      pickupLabel: JIRA_PICKUP_LABEL,
      knownAuthor: { providerUserId: DEV_ACCOUNT_ID, email: 'dev@example.test' },
      emitComment: (text) =>
        binding.replay.delivery('webhook-comment-created.json', {
          deliveryId: nextDeliveryId(),
          patch: (body) => {
            (body.comment as { body: unknown }).body = {
              type: 'doc',
              version: 1,
              content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
            };
          },
        }),
      emitStatusChange: (to) =>
        binding.replay.delivery('webhook-issue-updated-status.json', {
          deliveryId: nextDeliveryId(),
          patch: (body) => {
            const changelog = body.changelog as { items: { toString: string }[] };
            (changelog.items[0] as { toString: string }).toString = to;
          },
        }),
      unhandled: {
        // Well-formed, correctly signed, and about an event this provider does not act on — which
        // is a different answer from the fake's `malformed_payload`, and the reason the suite asks
        // the harness for both the delivery and the reason.
        delivery: () =>
          binding.replay.delivery('webhook-issue-updated-summary.json', {
            deliveryId: nextDeliveryId(),
          }),
        reason: 'unsupported_event',
      },
      projectId: JIRA_PROJECT_ID,
      integrationId: JIRA_INTEGRATION_ID,
      cleanup: async () => {},
    };
  },
});

describe('jira-cloud — reaching the provider', () => {
  let binding: JiraBinding;

  beforeEach(() => {
    binding = createJiraBinding();
  });

  describe('shadow mode reaches the executor as a mutating action', () => {
    /**
     * Each case is one mutating port method, with the write it makes in `normal` mode. The
     * positive control runs first on purpose: proving the harness *can* make the request is what
     * stops "no request was made" from passing against a broken double (standing rule 4).
     */
    const cases: readonly {
      name: string;
      action: string;
      run: (binding: JiraBinding) => Promise<unknown>;
    }[] = [
      {
        name: 'transition',
        action: 'transition',
        run: (bound) => bound.port.transition(JIRA_TICKET, 'In Progress'),
      },
      {
        name: 'upsertWorkpad',
        action: 'upsert_workpad',
        run: (bound) => bound.port.upsertWorkpad(JIRA_TICKET, 'agentic:workpad', '# Workpad'),
      },
      {
        name: 'addComment',
        action: 'add_comment',
        run: (bound) => bound.port.addComment(JIRA_TICKET, 'A question for a human'),
      },
      {
        name: 'setLabels',
        action: 'set_labels',
        run: (bound) => bound.port.setLabels(JIRA_TICKET, ['agentic:refinement'], []),
      },
      {
        name: 'linkMergeRequest',
        action: 'link_merge_request',
        run: (bound) =>
          bound.port.linkMergeRequest(
            JIRA_TICKET,
            'https://git.example.test/acme/api/-/merge_requests/7',
          ),
      },
      {
        name: 'createTicket',
        action: 'create_ticket',
        run: (bound) =>
          bound.port.createTicket({
            project_key: 'ACME',
            issue_type: 'Task',
            title: 'Follow-up',
            description: 'Split out by the scope-creep valve.',
            labels: ['agentic:followup'],
            parent_key: null,
            priority: null,
          }),
      },
    ];

    for (const testCase of cases) {
      it(`${testCase.name} writes in normal mode and writes nothing in shadow mode`, async () => {
        const normal = createJiraBinding({ mode: 'normal' });
        await testCase.run(normal);
        const performed = normal.replay.requests.filter((request) => request.method !== 'GET');
        expect(performed.length, `${testCase.name} must make a write request in normal mode`).toBe(
          1,
        );
        expect(
          normal.audit.entriesFor(testCase.action).map((entry) => entry.status),
          `${testCase.name} records one ok row`,
        ).toEqual(['ok']);

        const shadow = createJiraBinding({ mode: 'shadow' });
        await testCase.run(shadow);
        expect(
          shadow.replay.requests.filter((request) => request.method !== 'GET'),
          `${testCase.name} must send no write request in shadow mode`,
        ).toEqual([]);
        expect(
          shadow.audit.entriesFor(testCase.action).map((entry) => entry.status),
          `${testCase.name} records one would_have row`,
        ).toEqual(['would_have']);
      });
    }

    it('still fails loudly on an unknown target status in shadow mode', async () => {
      binding.mode = 'shadow';
      // The resolution happens before the shadow guard, so a broken status mapping is visible in
      // a shadow run — which is the only run a new project makes before it is trusted.
      await expect(binding.port.transition(JIRA_TICKET, 'Shipped To Mars')).rejects.toBeInstanceOf(
        IntegrationError,
      );
    });
  });

  describe('every error carrying provider text leaves through the executor', () => {
    it('refuses an unknown target status from inside the resolving action', async () => {
      // Round 1 threw this *after* `resolve_transition` had returned — provider text past the one
      // `catch` TD-012 relies on, and `docs/TODO.md` said the adapter had no such path. The audit
      // row is the proof that it does not now: only the executor writes one.
      await expect(binding.port.transition(JIRA_TICKET, 'Shipped To Mars')).rejects.toMatchObject({
        code: 'invalid_request',
      });
      const rows = binding.audit.entriesFor('resolve_transition');
      expect(
        rows.map((entry) => entry.status),
        'the executor recorded the failure it scrubbed',
      ).toEqual(['failed']);
      expect(rows[0]?.error, 'and the refusal is what failed').toContain(
        'has no transition to "Shipped To Mars"',
      );
      expect(binding.audit.entriesFor('transition'), 'no write was ever decided on').toEqual([]);
    });

    it('records a resolution that succeeds as an ok row, so the failure above is not the only path', async () => {
      // Control (standing rule 4): the same action against a status the workflow does offer.
      await binding.port.transition(JIRA_TICKET, 'In Progress');
      expect(binding.audit.entriesFor('resolve_transition').map((entry) => entry.status)).toEqual([
        'ok',
      ]);
    });
  });

  describe('rate limits', () => {
    it('retries after the documented Retry-After and asks the timer for exactly that delay', async () => {
      binding.replay.script('error-rate-limited.json');
      const ticket = await binding.port.readTicket(JIRA_TICKET);

      expect(ticket.ref.key, 'the retry succeeded').toBe('ACME-1');
      // `Retry-After: 2` in the fixture, from the documented rate-limiting page.
      expect(binding.timer.sleeps, 'the executor slept for the provider’s own delay').toEqual([
        2000,
      ]);
      const [entry] = binding.audit.entriesFor('read_ticket');
      expect(entry?.status).toBe('ok');
      expect(entry?.attempts, 'the row records both attempts').toBe(2);
    });

    it('gives up with a typed error when the provider keeps refusing', async () => {
      binding.replay.script('error-rate-limited.json');
      binding.replay.script('error-rate-limited.json');
      binding.replay.script('error-rate-limited.json');

      await expect(binding.port.readTicket(JIRA_TICKET)).rejects.toMatchObject({
        code: 'rate_limited',
        retryable: true,
      });
      expect(binding.timer.sleeps).toEqual([2000, 2000]);
      expect(binding.audit.entriesFor('read_ticket').map((entry) => entry.status)).toEqual([
        'failed',
      ]);
    });
  });

  describe('credentials never leave the adapter', () => {
    /** Everything `pino-std-serializers` reaches: own enumerable keys, `cause`, `errors[]`. */
    const serialisedLikePino = (error: unknown): string => {
      const seen = new Set<object>();
      const parts: string[] = [];
      const walk = (value: unknown): void => {
        if (value === null || typeof value !== 'object' || seen.has(value)) {
          return;
        }
        seen.add(value);
        const candidate = value as Record<string, unknown> & { message?: unknown; stack?: unknown };
        for (const key of ['message', 'stack']) {
          if (typeof candidate[key] === 'string') {
            parts.push(candidate[key] as string);
          }
        }
        walk((candidate as { cause?: unknown }).cause);
        for (const key in candidate) {
          const member: unknown = candidate[key];
          if (typeof member === 'string') {
            parts.push(member);
          } else if (member instanceof Headers) {
            parts.push(
              [...member.entries()].map(([name, header]) => `${name}: ${header}`).join('\n'),
            );
          } else if (member instanceof Request) {
            parts.push(member.url);
            parts.push(
              [...member.headers.entries()]
                .map(([name, header]) => `${name}: ${header}`)
                .join('\n'),
            );
          } else {
            walk(member);
          }
        }
      };
      walk(error);
      return parts.join('\n');
    };

    it('drops the transport error that carries the Authorization header', async () => {
      // ky wraps a failed `fetch` in a `NetworkError` whose own `request` property is a `Request`
      // — headers included. Verified against ky 2.1.0: `Object.keys(error)` is `['name','request']`.
      const hostile = createJiraBinding({
        fetch: async () => {
          const error: Error & { config?: unknown } = new TypeError('fetch failed');
          error.config = { headers: { Authorization: `Basic ${JIRA_REPLAY_TOKEN}` } };
          throw error;
        },
      });

      let caught: unknown;
      try {
        await hostile.port.readTicket(JIRA_TICKET);
      } catch (error) {
        caught = error;
      }

      expect(caught, 'the read failed').toBeInstanceOf(IntegrationError);
      expect(Object.keys(caught as object), 'no request object rides along').not.toContain(
        'request',
      );
      expect((caught as { cause?: unknown }).cause, 'no provider error is chained').toBeUndefined();
      expect(serialisedLikePino(caught)).not.toContain(JIRA_REPLAY_TOKEN);
    });

    it('scrubs a token the provider quotes back in an error body', async () => {
      // Not a fixture: no Atlassian document shows an error quoting a credential. It is the case
      // `HealthProbe.detail` exists for — "a failing probe is exactly where an HTTP client quotes
      // the request it made" — so it is asserted rather than assumed away.
      const echoing = createJiraBinding({
        fetch: async () =>
          new Response(
            JSON.stringify({
              errorMessages: [`Basic auth failed for token ${JIRA_REPLAY_TOKEN}`],
              errors: {},
            }),
            { status: 401, headers: { 'content-type': 'application/json' } },
          ),
      });

      let caught: unknown;
      try {
        await echoing.port.readTicket(JIRA_TICKET);
      } catch (error) {
        caught = error;
      }
      expect((caught as IntegrationError).code).toBe('unauthorised');
      expect(
        serialisedLikePino(caught),
        'the executor scrubbed the provider text on the way out',
      ).not.toContain(JIRA_REPLAY_TOKEN);
      expect((caught as Error).message).toContain('[REDACTED:integration:jira_api_token]');

      const [entry] = echoing.audit.entriesFor('read_ticket');
      expect(entry?.error).toContain('[REDACTED:integration:jira_api_token]');
      expect(entry?.redactionCount).toBeGreaterThan(0);
    });

    it('redacts the health probe detail instead of rendering it', async () => {
      const echoing = createJiraBinding({
        // The executor's redactor is told **nothing**, so the placeholder below can only have been
        // written by the adapter's own redactor — the one it builds from its binding's secrets.
        // With both in place the assertion would pass whichever fired, which is not a proof of
        // either (standing rule 9); `docs/TODO.md` records that the root is not yet obliged to
        // hand the executor a binding's secrets at all.
        executorRedactor: noSecretsRedactor(),
        fetch: async () =>
          new Response(
            JSON.stringify({ errorMessages: [`token ${JIRA_REPLAY_TOKEN} is not valid`] }),
            { status: 401, headers: { 'content-type': 'application/json' } },
          ),
      });

      const probe = await echoing.port.testConnection();
      expect(probe.ok).toBe(false);
      expect(probe.detail).toContain('[REDACTED:integration:jira_api_token]');
      expect(probe.detail).not.toContain(JIRA_REPLAY_TOKEN);
      expect(probe.token_expires_at, 'unknown, which is not the same as "never"').toBeNull();
    });
  });

  describe('request budget', () => {
    it('spends five requests on a ticket in an epic and one on a poll', async () => {
      await binding.port.readTicket(JIRA_TICKET);
      expect(binding.replay.requests.map((request) => `${request.method} ${request.path}`)).toEqual(
        [
          'GET issue/ACME-1',
          'GET issue/ACME-1/comment',
          'GET issue/ACME-1/remotelink',
          'GET issue/ACME-100',
          'GET search/jql',
        ],
      );

      binding.replay.resetRequests();
      await binding.port.matchTickets({ kind: 'label', label: JIRA_PICKUP_LABEL });
      expect(binding.replay.requests.map((request) => request.path)).toEqual(['search/jql']);
    });

    it('turns a polling window into a relative JQL bound', async () => {
      await binding.port.matchTickets(
        { kind: 'label', label: JIRA_PICKUP_LABEL },
        { since: '2026-09-02T11:50:00.000Z' },
      );
      expect(binding.replay.requests[0]?.query.jql).toBe(
        'labels = "agentic" AND updated >= "-15m" ORDER BY updated ASC',
      );
    });

    it('applies the window: a ticket older than it is not returned', async () => {
      const replay = createJiraReplay();
      const found = await createJiraBinding().port.matchTickets(
        { kind: 'label', label: JIRA_PICKUP_LABEL },
        { since: '2026-09-02T12:00:00.000Z' },
      );
      expect(replay.peekIssue('ACME-1'), 'the ticket exists and carries the label').toBeDefined();
      expect(found, 'but it was last updated on 1 September').toEqual([]);
    });
  });

  describe('idempotency that lives in the provider, not in a store', () => {
    it('does not post a second marked comment, and makes no request to decide that', async () => {
      const first = await binding.port.addComment(JIRA_TICKET, 'Which currency?', {
        markerId: 'agentic:question:1',
      });
      binding.replay.resetRequests();

      const second = await binding.port.addComment(JIRA_TICKET, 'Which currency?', {
        markerId: 'agentic:question:1',
      });
      expect(second.comment_id, 'the same comment, found by its marker').toBe(first.comment_id);
      expect(
        binding.replay.requests.filter((request) => request.method !== 'GET'),
        'and nothing was posted',
      ).toEqual([]);
      expect(binding.replay.commentCount('ACME-1')).toBe(2);
    });

    it('will not adopt a marked comment somebody else wrote', async () => {
      // The marker is visible text: a human can type it. Adopting it would make the platform edit
      // a person's comment.
      const impostor = await binding.port.addComment(JIRA_TICKET, 'not the workpad');
      const before = binding.replay.commentCount('ACME-1');
      binding.replay.reattributeComment('ACME-1', impostor.comment_id, 'agentic:workpad');

      const workpad = await binding.port.upsertWorkpad(JIRA_TICKET, 'agentic:workpad', '# Mine');
      expect(workpad.comment_id, 'a new comment, not the impostor').not.toBe(impostor.comment_id);
      expect(binding.replay.commentCount('ACME-1')).toBe(before + 1);
    });

    it('will not adopt a comment whose marker came out of the caller’s markdown', async () => {
      // WP-08 review round 1's spoof. This comment is written by the **bot**, so the author check
      // passes; the marker is text an agent copied out of ticket text an attacker wrote (BD-022),
      // which is why "the bot wrote it" is not "the platform wrote it".
      const spoof = 'The reporter says:\n\n`[agentic:marker:agentic:workpad]`';
      const posted = await binding.port.addComment(JIRA_TICKET, spoof);
      const before = binding.replay.commentCount('ACME-1');

      const workpad = await binding.port.upsertWorkpad(JIRA_TICKET, 'agentic:workpad', '# Mine');

      expect(workpad.comment_id, 'a new comment, not the spoofed one').not.toBe(posted.comment_id);
      expect(binding.replay.commentCount('ACME-1'), 'nothing was adopted').toBe(before + 1);
      const ticket = await binding.port.readTicket(JIRA_TICKET);
      const survivor = ticket.comments.find((comment) => comment.id === posted.comment_id);
      expect(survivor?.body, 'and the spoofed comment was not overwritten').toBe(
        'The reporter says:\n\n`[quoted:agentic:marker:agentic:workpad]`',
      );
    });

    it('refuses to look for its own comment when Jira will not say who it is', async () => {
      // `accountId` is optional in every user shape Jira publishes (standing rule 16). Answering
      // `null` would leave the author check comparing against nothing; this fails loudly instead,
      // from inside the executor, so the refusal is audited.
      const anonymous = createJiraBinding({ fetch: withoutSelfAccountId() });
      await expect(
        anonymous.port.upsertWorkpad(JIRA_TICKET, 'agentic:workpad', '# Mine'),
      ).rejects.toMatchObject({ code: 'invalid_response' });
      expect(
        anonymous.audit.entriesFor('read_workpad').map((entry) => entry.status),
        'the failure is on the record',
      ).toEqual(['failed']);
      // Control: the same call against a site that answers `GET /myself` in full succeeds, so the
      // refusal is the missing account id and not a broken double (standing rule 4).
      await expect(
        binding.port.upsertWorkpad(JIRA_TICKET, 'agentic:workpad', '# Mine'),
      ).resolves.toMatchObject({ marker_id: 'agentic:workpad' });
    });

    it('sends no request when the labels are already what was asked for', async () => {
      const labels = await binding.port.setLabels(JIRA_TICKET, ['agentic'], ['nothing-here']);
      expect(labels).toEqual(['agentic']);
      expect(
        binding.replay.requests.filter((request) => request.method !== 'GET'),
        'the set was already right',
      ).toEqual([]);
      expect(
        binding.audit.entriesFor('set_labels'),
        'and no mutating row claims otherwise',
      ).toEqual([]);
    });

    it('does not transition a ticket that is already in the target status', async () => {
      await binding.port.transition(JIRA_TICKET, 'In Progress');
      binding.replay.resetRequests();
      const again = await binding.port.transition(JIRA_TICKET, 'In Progress');
      expect(again).toEqual({ changed: false, from: 'In Progress', to: 'In Progress' });
      expect(binding.replay.requests.filter((request) => request.method === 'POST')).toEqual([]);
    });
  });

  describe('the rest of the port against the fixtures', () => {
    it('resolves an identity by account id, and reports an unknown one as null', async () => {
      const found = await binding.port.resolveIdentity({
        providerUserId: '557058:00000000-0000-4000-8000-00000000d0c1',
      });
      expect(found?.display_name).toBe('Dev One');
      expect(found?.verified, 'Jira cannot say whether this is a platform user').toBe(false);
      expect(await binding.port.resolveIdentity({ providerUserId: 'nobody' })).toBeNull();
      expect(await binding.port.resolveIdentity({}), 'nothing to look up').toBeNull();
    });

    it('prefers an exact email match on a site that exposes addresses', async () => {
      const exposing = createJiraBinding({
        fetch: async () =>
          new Response(
            JSON.stringify([
              { accountId: 'other', displayName: 'Devon Two', emailAddress: 'devon@example.test' },
              { accountId: 'wanted', displayName: 'Dev One', emailAddress: 'DEV@example.test' },
            ]),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      });
      const identity = await exposing.port.resolveIdentity({ email: 'dev@example.test' });
      expect(identity?.external_id, 'matched on the address, not on the first row').toBe('wanted');
    });

    it('refuses to guess between two prefix matches with no address', async () => {
      const ambiguous = createJiraBinding({
        fetch: async () =>
          new Response(JSON.stringify([{ accountId: 'one' }, { accountId: 'two' }]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      });
      expect(await ambiguous.port.resolveIdentity({ email: 'dev@example.test' })).toBeNull();
    });

    it('propagates a lookup failure that is not "no such account"', async () => {
      const broken = createJiraBinding({
        fetch: async () =>
          new Response(JSON.stringify({ errorMessages: ['boom'] }), {
            status: 403,
            headers: { 'content-type': 'application/json' },
          }),
      });
      await expect(
        broken.port.resolveIdentity({ providerUserId: 'someone' }),
      ).rejects.toMatchObject({ code: 'forbidden' });
    });

    it('reports the account it authenticated as', async () => {
      const probe = await binding.port.testConnection();
      expect(probe.ok).toBe(true);
      expect(probe.detail).toBe('authenticated as Agentic Platform');
      expect(Date.parse(probe.checked_at)).not.toBeNaN();
    });

    it('polls by status, by epic and by raw query', async () => {
      const byStatus = await binding.port.matchTickets({ kind: 'status', status: 'Done' });
      expect(byStatus.map((match) => match.ref.key)).toEqual(['ACME-2']);

      const byEpic = await binding.port.matchTickets({ kind: 'epic', epic_key: 'ACME-100' });
      expect(byEpic.map((match) => match.ref.key).sort()).toEqual(['ACME-1', 'ACME-2']);

      const byQuery = await binding.port.matchTickets({
        kind: 'query',
        query: 'labels = "agentic"',
      });
      expect(byQuery[0]?.epic, 'a match carries enough to build ticket.matched').toBe('ACME-100');
      expect(byQuery[0]?.issue_type).toBe('Bug');
      expect(byQuery[0]?.priority).toBe('High');
    });

    it('creates a ticket under a parent with a priority', async () => {
      const ref = await binding.port.createTicket({
        project_key: 'ACME',
        issue_type: 'Task',
        title: 'Extract the rounding helper',
        description: '**Split** out of ACME-1.',
        labels: ['agentic:followup'],
        parent_key: 'ACME-100',
        priority: 'Low',
      });
      const created = binding.replay.peekIssue(ref.key) as { fields: Record<string, unknown> };
      expect((created.fields.parent as { key: string }).key).toBe('ACME-100');
      expect(created.fields.priority).toEqual({ name: 'Low' });
      expect(created.fields.description, 'the description went as ADF').toMatchObject({
        type: 'doc',
        version: 1,
      });

      const readBack = await binding.port.readTicket(ref);
      expect(readBack.description).toBe('**Split** out of ACME-1.');
    });

    it('creates a ticket with no description at all rather than an empty document', async () => {
      const ref = await binding.port.createTicket({
        project_key: 'ACME',
        issue_type: 'Task',
        title: 'No body',
        description: '   ',
        labels: [],
        parent_key: null,
        priority: null,
      });
      const created = binding.replay.peekIssue(ref.key) as { fields: Record<string, unknown> };
      expect(created.fields.description).toBeNull();
    });

    it('returns a shadow comment reference that cannot be mistaken for a real one', async () => {
      binding.mode = 'shadow';
      const workpad = await binding.port.upsertWorkpad(JIRA_TICKET, 'agentic:workpad', '# Workpad');
      expect(workpad.comment_id).toBe('shadow');
      expect(workpad.url).toBeNull();

      const created = await binding.port.createTicket({
        project_key: 'ACME',
        issue_type: 'Task',
        title: 'Follow-up',
        description: 'x',
        labels: [],
        parent_key: null,
        priority: null,
      });
      expect(created.key).toBe('ACME-SHADOW');
    });

    it('reports a response that does not match the documented shape as invalid_response', async () => {
      const wrong = createJiraBinding({
        fetch: async () =>
          new Response(JSON.stringify({ key: 'ACME-1', fields: { updated: 'yesterday' } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      });
      await expect(wrong.port.readTicket(JIRA_TICKET)).rejects.toMatchObject({
        code: 'invalid_response',
      });
    });
  });

  describe('unsupported capability', () => {
    it('refuses transition fields rather than forwarding what it cannot validate', async () => {
      expect(binding.port.capabilities().customFields).toBe(false);
      await expect(
        binding.port.transition(JIRA_TICKET, 'In Progress', { resolution: { name: 'Fixed' } }),
      ).rejects.toMatchObject({ code: 'unsupported_capability' });
      expect(binding.replay.requests, 'and sends nothing at all').toEqual([]);
    });

    it('declares webhooks exactly when it can verify one, and no secret means neither', () => {
      // The declaration and the behaviour are two statements of one fact — does this binding hold
      // a webhook secret — so they are asserted together. Round 1 had them disagree: `webhooks`
      // was false and honest, while `verify` accepted anything signed with the empty key.
      const unsigned = createJiraBinding({ config: { webhook_secret: null } });
      const delivery = binding.replay.delivery('webhook-comment-created.json');
      expect(binding.port.capabilities().webhooks, 'a binding with a secret').toBe(true);
      expect(binding.port.inbound.verify(delivery), 'verifies its own deliveries').toBe(true);
      expect(unsigned.port.capabilities().webhooks, 'a binding without one').toBe(false);
      expect(unsigned.port.inbound.verify(delivery), 'verifies nothing').toBe(false);

      // The delivery the reviewer forged in round 1: signed with the empty key, which is what a
      // secretless binding would otherwise have been hashing with.
      const forged = binding.replay.delivery('webhook-comment-created.json', { secret: '' });
      expect(
        unsigned.port.inbound.verify(forged),
        'a signature the sender computed himself is not authenticity',
      ).toBe(false);
      expect(
        binding.port.inbound.verify(forged),
        'and a binding that does hold a secret rejects it too',
      ).toBe(false);
    });
  });
});

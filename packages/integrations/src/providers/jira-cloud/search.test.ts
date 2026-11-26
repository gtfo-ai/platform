/**
 * The *Start a ticket* typeahead on Jira Cloud: `buildTicketSearchJql` (pure) and `searchTickets`
 * through the real registration and client, so what reaches Jira is the request asserted — one
 * `search/jql`, the JQL the builder wrote, `fields=summary,status`, `maxResults` = the limit, the
 * client's `Accept-Language: en`, and the API gateway for a `cloud_id` binding.
 *
 * The response bodies are composed from the `search/jql` shape the other fixtures carry
 * (`search-jql.json`), with this repository's invented keys and summaries; the JQL forms were
 * measured against a Jira Cloud site on 2026-11-26 (`test/fixtures/http/jira-cloud/SOURCES.md`).
 */
import {
  IntegrationError,
  noSecretsRedactor,
  parseTicketSearchQuery,
  type TaskManagementPort,
  type TicketSearchQuery,
} from '@platform/application';
import { fixedClock } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { buildTicketSearchJql, KEY_PREFIX_EXTRA_DIGITS } from './index.js';
import { createJiraCloudRegistration } from './registration.js';

const INTEGRATION_ID = '00000000-0000-4000-8000-0000000000e2';
const SITE = 'https://acme-example.atlassian.net';
const CLOUD_ID = '0000fa4e-0000-4000-8000-00000000c10e';
const TOKEN = 'FAKE-jira-scoped-token-0123456789';

interface Sent {
  readonly url: URL;
  readonly acceptLanguage: string | null;
}

const issue = (key: string, summary: string, status: string, categoryKey: string | null) => ({
  id: String(10_000 + Number(key.split('-')[1])),
  key,
  self: `${SITE}/rest/api/3/issue/${key}`,
  fields: {
    summary,
    status: {
      id: '1',
      name: status,
      ...(categoryKey === null ? {} : { statusCategory: { key: categoryKey } }),
    },
  },
});

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const build = (
  config: Record<string, unknown>,
  respond: (sent: Sent) => Response,
): { port: TaskManagementPort; sent: Sent[] } => {
  const sent: Sent[] = [];
  const registration = createJiraCloudRegistration({
    clock: fixedClock('2026-11-26T10:00:00.000Z'),
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input as string, init);
      const entry = {
        url: new URL(request.url),
        acceptLanguage: request.headers.get('accept-language'),
      };
      sent.push(entry);
      return respond(entry);
    },
  });
  const port = registration.create({
    integrationId: INTEGRATION_ID,
    config: { site_url: SITE, user_email: 'agentic-bot@example.test', ...config },
    secrets: { api_token: TOKEN },
    redactor: noSecretsRedactor(),
  }) as TaskManagementPort;
  return { port, sent };
};

const keyQuery = (project: string, number: string): TicketSearchQuery => ({
  kind: 'key',
  project,
  number,
});

describe('buildTicketSearchJql', () => {
  it('asks a key prefix as the exact key and three bounded ranges, ascending', () => {
    expect(buildTicketSearchJql(keyQuery('ACME', '12'), ['ACME'])).toBe(
      'project = "ACME" AND (key = "ACME-12" OR (key >= "ACME-120" AND key <= "ACME-129") OR (key >= "ACME-1200" AND key <= "ACME-1299") OR (key >= "ACME-12000" AND key <= "ACME-12999")) ORDER BY key ASC',
    );
    expect(KEY_PREFIX_EXTRA_DIGITS).toBe(3);
  });

  it('asks only the exact key for a number with a leading zero, and the project for "ACME-"', () => {
    expect(buildTicketSearchJql(keyQuery('ACME', '07'), [])).toBe(
      'project = "ACME" AND (key = "ACME-07") ORDER BY key ASC',
    );
    expect(buildTicketSearchJql(keyQuery('ACME', ''), ['ACME'])).toBe(
      'project = "ACME" ORDER BY created DESC',
    );
  });

  it('asks nothing for a key outside a declared scope, and asks an unscoped binding anyway', () => {
    expect(buildTicketSearchJql(keyQuery('OTHER', '1'), ['ACME', 'OPS'])).toBeNull();
    expect(buildTicketSearchJql(keyQuery('OTHER', '1'), [])).toContain('project = "OTHER"');
  });

  it('asks words as prefix terms of the summary, newest first, inside the declared scope', () => {
    expect(
      buildTicketSearchJql({ kind: 'words', words: ['invoice', 'pdf'] }, ['ACME', 'OPS']),
    ).toBe(
      'project in ("ACME", "OPS") AND summary ~ "invoice*" AND summary ~ "pdf*" ORDER BY updated DESC',
    );
    expect(buildTicketSearchJql({ kind: 'words', words: ['invoice'] }, [])).toBe(
      'summary ~ "invoice*" ORDER BY updated DESC',
    );
  });

  it('never lets a hostile query close a literal or add a clause (the parse is what is asked)', () => {
    for (const hostile of [
      '") OR project != "ACME',
      'pdf" OR assignee = currentUser() OR summary ~ "',
      'x\\" OR 1=1',
      'AND OR NOT',
      '*',
    ]) {
      const parsed = parseTicketSearchQuery(hostile);
      const jql = parsed === null ? null : buildTicketSearchJql(parsed, ['ACME']);
      if (jql === null) {
        continue;
      }
      // Exactly the scope clause, one `summary ~ "<word>*"` per word, and the order — nothing else.
      expect(jql, hostile).toMatch(
        /^project in \("ACME"\) AND summary ~ "[\p{Ll}\p{Lo}\p{M}\p{N}]+\*"(?: AND summary ~ "[\p{Ll}\p{Lo}\p{M}\p{N}]+\*")* ORDER BY updated DESC$/u,
      );
      expect(jql, hostile).not.toMatch(/currentUser|!=|1=1|\\/);
    }
    // Operators survive only as lower-case search words, never as Lucene operators.
    expect(buildTicketSearchJql({ kind: 'words', words: ['and', 'or', 'not'] }, [])).toBe(
      'summary ~ "and*" AND summary ~ "or*" AND summary ~ "not*" ORDER BY updated DESC',
    );
  });
});

describe('searchTickets on Jira Cloud', () => {
  it('makes one search/jql request with the built JQL, summary,status and the limit', async () => {
    const { port, sent } = build({ project_keys: ['ACME'] }, () =>
      json(200, {
        issues: [
          issue('ACME-120', 'Invoice totals', 'To pick up', 'new'),
          issue('ACME-12', 'Invoice PDF layout', 'In review', 'indeterminate'),
        ],
        isLast: true,
      }),
    );
    const hits = await port.searchTickets('acme-12', { limit: 5 });
    expect(sent).toHaveLength(1);
    const request = sent[0] as Sent;
    expect(request.url.origin + request.url.pathname).toBe(`${SITE}/rest/api/3/search/jql`);
    expect(request?.url.searchParams.get('jql')).toBe(
      buildTicketSearchJql(keyQuery('ACME', '12'), ['ACME']),
    );
    expect(request?.url.searchParams.get('fields')).toBe('summary,status');
    expect(request?.url.searchParams.get('maxResults')).toBe('5');
    expect(request?.url.searchParams.has('nextPageToken')).toBe(false);
    expect(request?.acceptLanguage).toBe('en');
    // The exact key first, then Jira's order.
    expect(hits.map((hit) => hit.ref.key)).toEqual(['ACME-12', 'ACME-120']);
    expect(hits[0]).toEqual({
      ref: {
        provider: 'jira-cloud',
        key: 'ACME-12',
        url: `${SITE}/browse/ACME-12`,
        id: '10012',
      },
      title: 'Invoice PDF layout',
      status: 'In review',
      status_category: 'in_progress',
    });
  });

  it('goes through the API gateway for a cloud_id binding, links still on the site', async () => {
    const { port, sent } = build({ cloud_id: CLOUD_ID }, () =>
      json(200, { issues: [issue('ACME-7', 'Billing export', 'To pick up', null)], isLast: true }),
    );
    const hits = await port.searchTickets('billing', { limit: 10 });
    expect(sent[0]?.url.origin + (sent[0]?.url.pathname ?? '')).toBe(
      `https://api.atlassian.com/ex/jira/${CLOUD_ID}/rest/api/3/search/jql`,
    );
    expect(sent[0]?.acceptLanguage).toBe('en');
    expect(hits[0]?.ref.url).toBe(`${SITE}/browse/ACME-7`);
    expect(hits[0]?.status_category).toBeNull();
  });

  it('asks nothing for a query with nothing searchable or a key outside project_keys', async () => {
    const { port, sent } = build({ project_keys: ['ACME'] }, () => json(200, { issues: [] }));
    expect(await port.searchTickets('"*"', { limit: 10 })).toEqual([]);
    expect(await port.searchTickets('OTHER-12', { limit: 10 })).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it('drops a ticket outside project_keys Jira answered anyway, and holds the limit', async () => {
    const { port } = build({ project_keys: ['ACME'] }, () =>
      json(200, {
        issues: [
          issue('OPS-1', 'Invoice runbook', 'To pick up', 'new'),
          issue('ACME-1', 'Invoice one', 'To pick up', 'new'),
          issue('ACME-2', 'Invoice two', 'To pick up', 'new'),
        ],
      }),
    );
    const hits = await port.searchTickets('invoice', { limit: 1 });
    expect(hits.map((hit) => hit.ref.key)).toEqual(['ACME-1']);
  });

  it('answers a 400 (an unanswerable query) as no tickets and throws on a 500', async () => {
    const refused = build({}, () =>
      json(400, { errorMessages: ["The value 'NOPE' does not exist for the field 'project'."] }),
    );
    expect(await refused.port.searchTickets('NOPE-1', { limit: 10 })).toEqual([]);
    const broken = build({}, () => json(500, { errorMessages: ['boom'] }));
    await expect(broken.port.searchTickets('NOPE-1', { limit: 10 })).rejects.toBeInstanceOf(
      IntegrationError,
    );
  });

  it('cuts a long summary, names a missing status Unknown, and refuses a limit past the bound', async () => {
    const { port } = build({}, () =>
      json(200, {
        issues: [{ key: 'ACME-3', fields: { summary: 'x'.repeat(400), status: { name: '' } } }],
      }),
    );
    const [hit] = await port.searchTickets('ACME-3', { limit: 10 });
    expect(hit?.title).toHaveLength(300);
    expect(hit?.status).toBe('Unknown');
    await expect(port.searchTickets('ACME-3', { limit: 11 })).rejects.toThrow();
  });
});

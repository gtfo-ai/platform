/**
 * **What the tracker and the git provider emit with no byte bound at all — measured, not quoted**
 * (Q54; standing rules 37 and 39; technical/10 unit tier).
 *
 * ## Why this file exists
 *
 * `emitted-bounds.test.ts` fails on any string past the largest **named cap** in a binding's
 * configuration, and it deliberately excludes these two adapters because neither has such a cap
 * over the text it emits: adding them would pass vacuously against GitLab's 1 MiB job-log tail,
 * which bounds nothing being measured. That exclusion was recorded in Q54 with two measurements
 * quoted in prose — and standing rule 39 exists because a quoted measurement drifts: WP-11a's
 * headline figure was taken at doubled caps, and this question's own `readTicket` figure was
 * attached to the claim that `MAX_COMMENTS = 100` was "the shipped cap". **It is not a cap.** It is
 * `maxResults`, a *request* parameter; nothing in the adapter refuses a page that comes back
 * larger, which is what the first assertion below demonstrates by returning two hundred comments
 * to a request that asked for a hundred.
 *
 * So the numbers live here, produced by the shipped code from the shipped defaults, and Q54 cites
 * this file rather than restating them. When a cap lands (WP-16 owns the recommendation), these
 * assertions are what will fail.
 *
 * ## What it does not claim
 *
 *  - **Not a bound.** Nothing here asserts a limit, because there is none to assert; it pins what
 *    one call can hand over so the size of the gap cannot quietly change.
 *  - **Not a leak.** Every string below is redacted — `emitted-secrets.test.ts` is that property.
 *    A redacted string can still be 27 MB, which is the whole point of keeping the two files apart.
 *  - **Not the vendor's limits.** Jira and GitLab impose their own page sizes; this measures what
 *    the *adapter* does with what it is handed, which is the only half the platform controls.
 */
import {
  createIntegrationActionExecutor,
  createMemoryAuditLog,
  createVirtualTimer,
  noSecretsRedactor,
} from '@platform/application';
import { fixedClock } from '@platform/domain';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { gitlabProviderRegistration } from './gitlab/index.js';
import { createJiraCloudRegistration } from './jira-cloud/registration.js';

const NOW = '2026-06-01T10:30:00.000Z' as const;
const encoder = new TextEncoder();
const bytesOf = (text: string): number => encoder.encode(text).length;

/**
 * 128 KiB in every string the provider controls — far past every cap either adapter names, and the
 * same size Q54's original measurement used so the two are comparable.
 */
const HOSTILE = 'H'.repeat(128 * 1024);

/** Every string in an emitted value with the path it sits at, keys included. */
const walk = (value: unknown, path = '$'): { path: string; text: string }[] => {
  if (typeof value === 'string') {
    return [{ path, text: value }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => walk(item, `${path}[${index}]`));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => walk(item, `${path}.${key}`));
  }
  return [];
};

/** The paths carrying hostile-sized text, with array indices collapsed so the list is readable. */
const unboundedPaths = (value: unknown): string[] =>
  [
    ...new Set(
      walk(value)
        .filter((entry) => entry.text.includes(HOSTILE))
        .map((entry) => entry.path.replace(/\[\d+\]/g, '[]')),
    ),
  ].sort();

type Script = Record<string, { status?: number; body?: unknown }>;

const stubFetch = (script: Script, seen: string[]): void => {
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    const path = url.pathname.replace('/api/v4', '').replace('/rest/api/3', '');
    seen.push(`${request.method} ${path}${url.search}`);
    const scripted = script[`${request.method} ${path}`];
    return new Response(JSON.stringify(scripted?.body ?? { message: 'not scripted' }), {
      status: scripted?.status ?? 404,
      headers: { 'content-type': 'application/json' },
    });
  });
};

afterAll(() => {
  vi.unstubAllGlobals();
});

// ── Jira: one readTicket ─────────────────────────────────────────────────────

const SITE = 'https://acme-example.atlassian.net';
const KEY = 'ACME-1';

/** Twice what the adapter asks for, which is the point: `maxResults` is a request, not a cap. */
const COMMENTS_RETURNED = 200;

const adf = (text: string) => ({
  type: 'doc',
  version: 1,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

describe('one readTicket, with the provider hostile in every string it controls', () => {
  let ticket: unknown;
  const seen: string[] = [];

  beforeAll(async () => {
    stubFetch(
      {
        [`GET /issue/${KEY}`]: {
          status: 200,
          body: {
            id: '10001',
            key: KEY,
            fields: {
              summary: HOSTILE,
              description: adf(HOSTILE),
              issuetype: { name: HOSTILE },
              status: { name: HOSTILE },
              priority: { name: HOSTILE },
              labels: [HOSTILE],
              updated: '2026-06-01T09:00:00.000+0000',
              issuelinks: [],
            },
          },
        },
        [`GET /issue/${KEY}/comment`]: {
          status: 200,
          body: {
            comments: Array.from({ length: COMMENTS_RETURNED }, (_unused, index) => ({
              id: String(20_000 + index),
              author: {
                accountId: '557058:00000000-0000-4000-8000-00000000d0c1',
                displayName: HOSTILE,
              },
              body: adf(HOSTILE),
              created: '2026-06-01T09:10:00.000+0000',
              updated: '2026-06-01T09:10:00.000+0000',
            })),
            total: COMMENTS_RETURNED,
          },
        },
        [`GET /issue/${KEY}/remotelink`]: { status: 200, body: [] },
      },
      seen,
    );
    const clock = fixedClock(NOW, 0);
    const port = createJiraCloudRegistration({
      executor: createIntegrationActionExecutor({
        auditLog: createMemoryAuditLog(),
        redactor: noSecretsRedactor(),
        timer: createVirtualTimer({ autoAdvance: true }),
        clock,
        rateLimits: () => ({ capacity: 100, refillPerSecond: 100, maxConcurrent: 8 }),
      }),
      clock,
      actionContext: () => ({ mode: 'normal', projectId: null, taskId: null }),
    }).create({
      integrationId: '00000000-0000-4000-8000-0000000000a8',
      config: { site_url: SITE, user_email: 'agentic-bot@example.test', project_keys: ['ACME'] },
      secrets: { api_token: 'FAKE-jira-api-token-0123456789' },
      redactor: noSecretsRedactor(),
    });
    ticket = await port.readTicket({
      provider: 'jira-cloud',
      key: KEY,
      url: `${SITE}/browse/${KEY}`,
    });
  });

  /**
   * The correction Q54 needed. `MAX_COMMENTS` is spelled `maxResults` on the wire — Atlassian's
   * word for "how many I would like" — and the adapter maps whatever comes back. A provider (or a
   * proxy, or a future default) that answers with more is not refused, not truncated and not
   * marked.
   */
  it('asks for a hundred comments and emits every one of the two hundred it is given', () => {
    expect(
      seen.some((call) => call.includes('maxResults=100')),
      'the request does carry the number, so this is a cap that is asked for and not enforced',
    ).toBe(true);
    expect((ticket as { comments: readonly unknown[] }).comments).toHaveLength(COMMENTS_RETURNED);
  });

  it('emits eight unbounded paths, and this is the size of one ticket', () => {
    expect(unboundedPaths(ticket)).toEqual([
      '$.comments[].author.display_name',
      '$.comments[].body',
      '$.description',
      '$.issue_type',
      '$.labels[]',
      '$.priority',
      '$.status',
      '$.title',
    ]);
    // Produced, not quoted (standing rule 39): Q54 cites this assertion rather than carrying a
    // number of its own. It is the size of *this* document — two hundred comments of 128 KiB —
    // and it moves when the fixture moves, which is the property a quoted figure lacked.
    expect(bytesOf(JSON.stringify(ticket) ?? '')).toBe(53_284_565);
  });
});

// ── GitLab: one getMergeRequest ──────────────────────────────────────────────

const HOST = 'https://gitlab.example.test';
const PROJECT = 'acme/api';
const P = 'acme%2Fapi';
const SHA = '1111111111111111111111111111111111111111';

describe('one getMergeRequest, with the provider hostile in every string it controls', () => {
  let mergeRequest: unknown;

  beforeAll(async () => {
    stubFetch(
      {
        [`GET /projects/${P}/merge_requests/7`]: {
          status: 200,
          body: {
            id: 155016007,
            iid: 7,
            project_id: 1,
            title: HOSTILE,
            description: HOSTILE,
            state: 'opened',
            draft: false,
            source_branch: HOSTILE,
            target_branch: HOSTILE,
            sha: SHA,
            merge_status: 'can_be_merged',
            detailed_merge_status: 'mergeable',
            has_conflicts: false,
            labels: [HOSTILE],
            author: { id: 4242, username: 'bot', name: HOSTILE, web_url: `${HOST}/u/bot` },
            reviewers: [],
            merged_at: null,
            web_url: `${HOST}/acme/api/-/merge_requests/7#${HOSTILE}`,
            diff_refs: { base_sha: SHA, head_sha: SHA, start_sha: SHA },
          },
        },
      },
      [],
    );
    const port = gitlabProviderRegistration.create({
      integrationId: '00000000-0000-4000-8000-0000000000a9',
      config: { base_url: HOST, project: PROJECT, request_timeout_ms: 0 },
      secrets: { token: 'glpat-FAKE-binding-token-0123456789' },
      redactor: noSecretsRedactor(),
    });
    mergeRequest = await port.getMergeRequest({
      provider: 'gitlab',
      project_path: PROJECT,
      iid: 7,
      url: `${HOST}/acme/api/-/merge_requests/7`,
    });
  });

  it('emits nine unbounded paths, and this is the size of one merge request', () => {
    expect(unboundedPaths(mergeRequest)).toEqual([
      '$.author.display_name',
      '$.description',
      '$.labels[]',
      '$.ref.branch',
      '$.ref.url',
      '$.source_branch',
      '$.target_branch',
      '$.title',
      '$.web_url',
    ]);
    // Produced, not quoted. Q54 carried 1,180,271 and a reviewer re-measuring it got 1,179,811
    // over the same nine paths; this fixture gives 1,180,284. Three numbers for one claim is what
    // a figure nobody can re-run looks like, so the figure now comes from here.
    expect(bytesOf(JSON.stringify(mergeRequest) ?? '')).toBe(1_180_284);
  });
});

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
 * attached to the claim that `MAX_COMMENTS = 100` was "the shipped cap". **It was not a cap.** It
 * was `maxResults`, a *request* parameter, and nothing in the adapter refused a page that came back
 * larger. Since WP-83 the page is decided and enforced (`READ_TICKET_COMMENT_PAGE`, the newest
 * fifty), which the first assertion below demonstrates by returning two hundred comments and
 * receiving fifty — a bound on how **many**, while every comment's text stays unbounded here.
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
  allowAnyIntegrationHost,
  createIntegrationActionExecutor,
  createMemoryAuditLog,
  createVirtualTimer,
  noSecretsRedactor,
} from '@platform/application';
import { fixedClock } from '@platform/domain';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { gitlabProviderRegistration } from './gitlab/index.js';
import { READ_TICKET_COMMENT_PAGE } from './jira-cloud/index.js';
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

/** Four times what the adapter asks for since WP-83, which is the point: the page is cut to size. */
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
        // Declared open on purpose (WP-51): this file is not about the egress allow-list, and an
        // omitted policy is not a thing `IntegrationActionExecutorOptions` permits.
        egress: allowAnyIntegrationHost(),
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
   * The correction Q54 needed, and since WP-83 the answer to it. Until then `maxResults=100` was a
   * request the adapter did not enforce: this case scripted two hundred comments and all two
   * hundred were emitted. Now the page is decided — the newest `READ_TICKET_COMMENT_PAGE` (50),
   * asked for with `orderBy=-created` — and a larger answer is cut to it.
   */
  it('asks for the newest fifty comments and emits fifty of the two hundred it is given', () => {
    expect(READ_TICKET_COMMENT_PAGE).toBe(50);
    expect(
      seen.some(
        (call) =>
          call.includes('/comment?') &&
          call.includes('maxResults=50') &&
          call.includes('orderBy=-created'),
      ),
      'the request asks for the newest page of the decided size',
    ).toBe(true);
    const emitted = (ticket as { comments: readonly { id: string }[] }).comments;
    expect(emitted).toHaveLength(READ_TICKET_COMMENT_PAGE);
    // The provider answered newest first (ids 20000, 20001, … stand for newest → older here); the
    // first fifty are kept and emitted oldest first.
    expect(emitted[0]?.id).toBe(String(20_000 + READ_TICKET_COMMENT_PAGE - 1));
    expect(emitted.at(-1)?.id).toBe('20000');
    // …and says the page was not the thread (backlog 290): Jira's `total`, not the page's length.
    expect((ticket as { comment_total: number }).comment_total).toBe(COMMENTS_RETURNED);
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
    //
    // **It moved at WP-83, from 53 284 565, and the cause is re-derived rather than assumed** (rule
    // 81): the comment page is cut from 200 to `READ_TICKET_COMMENT_PAGE` (50), and the 150 comments
    // dropped account for exactly 39 373 350 bytes — 262 489 each, which is the two 128 KiB strings
    // a comment carries here (body and display name, 262 144) plus 345 bytes of its own frame. The
    // paths above did not move: each comment's text is still the consumer's to bound. Review round
    // 1 then added `comment_total` (backlog 290): `,"comment_total":200` is exactly 20 bytes, which
    // is the whole move from 13 911 215. WP-134 (backlog 418) added the issue's stable id to the
    // ticket's reference: `,"id":"10001"` is exactly 13 bytes, the whole move from 13 911 235, and
    // it is no new unbounded path — the adapter carries only 1–20 decimal digits there.
    expect(bytesOf(JSON.stringify(ticket) ?? '')).toBe(13_911_248);
  });
});

/**
 * WP-83 review round 2: the comment page's `total` is provider data, and one hostile number must not
 * fail the whole read (standing rule 20). A `total` past `Number.MAX_SAFE_INTEGER` — which the port's
 * `z.int()` refuses — degrades to "no usable total": a full page then answers `null` ("possibly
 * more", which the snapshot declares as a cut) and a short page answers its own length.
 */
describe('a comment page whose total is hostile or missing', () => {
  const readWith = async (returned: number, total: unknown) => {
    stubFetch(
      {
        [`GET /issue/${KEY}`]: {
          status: 200,
          body: {
            id: '10001',
            key: KEY,
            fields: {
              summary: 'a ticket',
              description: adf('text'),
              issuetype: { name: 'Bug' },
              status: { name: 'To Do' },
              priority: { name: 'High' },
              labels: [],
              updated: '2026-06-01T09:00:00.000+0000',
              issuelinks: [],
            },
          },
        },
        [`GET /issue/${KEY}/comment`]: {
          status: 200,
          body: {
            comments: Array.from({ length: returned }, (_unused, index) => ({
              id: String(30_000 + index),
              author: {
                accountId: '557058:00000000-0000-4000-8000-00000000d0c2',
                displayName: 'Dana',
              },
              body: adf(`comment ${index}`),
              created: '2026-06-01T09:10:00.000+0000',
            })),
            ...(total === undefined ? {} : { total }),
          },
        },
        [`GET /issue/${KEY}/remotelink`]: { status: 200, body: [] },
      },
      [],
    );
    const clock = fixedClock(NOW, 0);
    const port = createJiraCloudRegistration({
      executor: createIntegrationActionExecutor({
        egress: allowAnyIntegrationHost(),
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
    return port.readTicket({ provider: 'jira-cloud', key: KEY, url: `${SITE}/browse/${KEY}` });
  };

  it('reads the ticket and answers "possibly more" for a full page with a total past 2^53', async () => {
    const ticket = await readWith(READ_TICKET_COMMENT_PAGE, 2 ** 60);
    expect(ticket.comments).toHaveLength(READ_TICKET_COMMENT_PAGE);
    expect(ticket.comment_total).toBeNull();
  });

  it('answers null for a full page with no total, and the length for a short one', async () => {
    expect((await readWith(READ_TICKET_COMMENT_PAGE, undefined)).comment_total).toBeNull();
    expect((await readWith(7, undefined)).comment_total).toBe(7);
    expect((await readWith(7, -3)).comment_total).toBe(7);
    expect((await readWith(READ_TICKET_COMMENT_PAGE, 'many')).comment_total).toBeNull();
    // A usable total is the answer, floored at what was mapped.
    expect((await readWith(7, 2)).comment_total).toBe(7);
    expect((await readWith(7, 90)).comment_total).toBe(90);
  });

  it('answers "possibly more" for a full page whose total is the page’s own length (backlog 377)', async () => {
    // The swagger calls `total` "The number of items returned": a full page with `total` 50 cannot
    // say the thread is fifty long, so it must not stop the snapshot declaring `truncated` (290).
    expect(
      (await readWith(READ_TICKET_COMMENT_PAGE, READ_TICKET_COMMENT_PAGE)).comment_total,
    ).toBeNull();
    expect((await readWith(READ_TICKET_COMMENT_PAGE, 3)).comment_total).toBeNull();
    expect(
      (await readWith(READ_TICKET_COMMENT_PAGE, READ_TICKET_COMMENT_PAGE + 1)).comment_total,
    ).toBe(READ_TICKET_COMMENT_PAGE + 1);
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
    // over the same nine paths; this fixture gave 1,180,284. Three numbers for one claim is what
    // a figure nobody can re-run looks like, so the figure comes from here.
    //
    // **It moved by exactly 54 at WP-34, and the cause is re-derived rather than assumed** (rule
    // 81): `MergeRequest` gained `base_sha`, and `,"base_sha":"<40 hex>"` is 13 + 40 + 1 = 54
    // bytes. The **list of unbounded paths above did not move**, which is the assertion that
    // matters here — the new field is a `shaSchema`, so it is bounded by construction and a
    // hostile provider cannot grow it.
    expect(bytesOf(JSON.stringify(mergeRequest) ?? '')).toBe(1_180_338);
  });
});

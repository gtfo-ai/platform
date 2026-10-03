/**
 * The Jira Cloud **replay double**: a `fetch` that answers the adapter with documented response
 * documents, and keeps enough state to be read back (technical/10 contract tier — "each real
 * adapter in nock replay mode with scrubbed recorded fixtures").
 *
 * WP-08 had no Jira site, so this is not a recording of a conversation. It is two different things
 * and the difference matters (see `test/fixtures/http/jira-cloud/SOURCES.md`):
 *
 *  - **the documents are evidence** — every body it serves comes from a fixture whose `source`
 *    block names the Atlassian page or OpenAPI operation it was taken from;
 *  - **the sequencing is a model** — which document answers which request, and what a mutation
 *    does to the next read, is this file's invention, because the contract suite transitions a
 *    ticket and then reads it back.
 *
 * ## Divergence register (a double may be stricter than Jira, never kinder)
 *
 *  1. **Stricter — an unrouted request throws.** A path or method this file does not know fails
 *     the test by name (`jira replay: no route for …`) instead of returning 404, so a typo in a
 *     path is never mistaken for "Jira says it is not there".
 *  2. **Stricter — the JQL is parsed, not ignored.** Only the three clause forms the adapter
 *     builds are accepted, plus the `updated >= "-Nm"` window and `AND key != "…"`; anything else
 *     throws. A relative window really is applied against the injected clock, so a wrong window is
 *     a wrong result rather than an unnoticed one.
 *  3. **Stricter — a transition to the status the issue is already in is not offered**, which is
 *     what a Jira workflow does, so the adapter's "already there" branch cannot be reached by
 *     accident through the transition list.
 *  4. **Kinder — no quota, unless a test scripts one.** `script(status, fixture)` queues the next
 *     response; `jira-cloud.contract.test.ts` uses it to drive the executor's 429 path with the
 *     documented `Retry-After` fixture.
 *  5. **Kinder — writes are visible to the next read immediately.** Jira's search index lags by
 *     seconds, which is why the polling fallback overlaps its window (`matchTickets({since})`).
 *  6. **Different — ids are allocated sequentially** (`10101`, `10102`, …) where Jira's are opaque.
 *  7. **Different — the site has three accounts and one project.** `GET /user/search` answers from
 *     that directory, and — as Atlassian's own example response does — returns no `emailAddress`,
 *     which is the GDPR default for a Cloud site.
 *  8. **Stricter — a comment page holds at most {@link REPLAY_COMMENT_PAGE_CAP} comments** (WP-111),
 *     whatever `maxResults` asked, and its `total` is the thread's size. So the marker search's
 *     paging by `startAt` is exercised across short pages on every thread longer than the cap.
 *  9. **Different — the wording of a search's refusal of an unknown key is chosen by the test**
 *     (WP-134, backlog 375): Atlassian's documented sentence by default (`inferred` for Cloud), the
 *     other JQL wording, or an **opaque** message that names no key — Cloud's wording is not
 *     measured, so the adapter is driven through all three. The refusal is whole, as documented.
 * 10. **Stricter — a moved issue answers its old key on `GET issue/{key}` only** (WP-134, backlog
 *     418), as Atlassian's redirect does (`moveIssue`); a JQL `key in (…)` naming the old key is
 *     refused as unknown, which Jira may not do.
 */
import { readFileSync } from 'node:fs';
import type { WebhookDelivery } from '@platform/application';
import { signWebhookBody } from '@platform/integrations';

const FIXTURE_DIR = new URL('../../../fixtures/http/jira-cloud/', import.meta.url);

interface FixtureFile {
  readonly source: Record<string, unknown>;
  readonly response?: {
    readonly status: number;
    readonly headers?: Record<string, string>;
    readonly body?: unknown;
  };
  readonly delivery?: {
    readonly headers: Record<string, string>;
    readonly body: Record<string, unknown>;
  };
}

export const loadJiraFixture = (name: string): FixtureFile =>
  JSON.parse(readFileSync(new URL(name, FIXTURE_DIR), 'utf8')) as FixtureFile;

const bodyOf = (name: string): Record<string, unknown> => {
  const fixture = loadJiraFixture(name);
  if (fixture.response === undefined) {
    throw new Error(`jira replay: fixture ${name} has no response`);
  }
  return structuredClone(fixture.response.body) as Record<string, unknown>;
};

export const JIRA_REPLAY_SITE = 'https://acme-example.atlassian.net';
export const JIRA_REPLAY_SECRET = 'FAKE-jira-webhook-secret-0123456789';
export const JIRA_REPLAY_TOKEN = 'FAKE-jira-api-token-0123456789';
export const JIRA_REPLAY_EMAIL = 'agentic-bot@example.test';
/** Five minutes after every webhook fixture's `timestamp`, so a delivery is fresh but not future. */
export const JIRA_REPLAY_NOW = '2026-09-02T12:05:00.000Z';

export interface RecordedRequest {
  readonly method: string;
  /** Path below `/rest/api/3/`. */
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface JiraReplay {
  readonly fetch: typeof globalThis.fetch;
  readonly requests: readonly RecordedRequest[];
  /** Queues one scripted response ahead of the router — a 429, a 500, a 404. */
  script(fixtureName: string): void;
  /** The issue as the double holds it, for assertions the port does not expose. */
  peekIssue(key: string): Record<string, unknown> | undefined;
  commentCount(key: string): number;
  /** The thread's comment ids, oldest first — where a comment sits is a position in this list. */
  commentIds(key: string): readonly string[];
  /**
   * Appends `count` comments a **human** wrote (the directory's first account, no marker), oldest
   * first after whatever the thread holds — the long thread backlog 288 is about (WP-111). The body
   * is the seeded fixture comment's; only the id, the author and the instant differ.
   */
  appendHumanComments(key: string, count: number): void;
  /**
   * Makes a comment look as though a **human** wrote it and typed the platform's marker.
   *
   * The marker is visible text (`adf.ts`), so this is a thing a person can do in the Jira UI; it
   * exists so the adapter's "was this written by my own account" guard can be driven from outside.
   */
  reattributeComment(key: string, commentId: string, markerId: string): void;
  /**
   * Moves an issue to another project (WP-134, divergence 10): the issue keeps its `id`, answers
   * under `to`, and `GET issue/{from}` answers it under `to` — Atlassian's redirect of a moved key.
   */
  moveIssue(from: string, to: string): void;
  /** How a search refuses a key it does not hold (divergence 9). */
  refuseUnknownKeysWith(wording: 'documented' | 'value' | 'opaque'): void;
  resetRequests(): void;
  /** A signed delivery built from a webhook fixture, with the harness's own secret. */
  delivery(fixtureName: string, overrides?: DeliveryOverrides): WebhookDelivery;
}

export interface DeliveryOverrides {
  readonly deliveryId?: string;
  readonly timestamp?: number;
  readonly patch?: (body: Record<string, unknown>) => void;
  readonly secret?: string;
  readonly signature?: string;
}

interface StoredComment {
  self: string;
  id: string;
  author: unknown;
  updateAuthor: unknown;
  body: unknown;
  created: string;
  updated: string;
}

interface StoredRemoteLink {
  id: number;
  globalId: string;
  relationship?: string;
  object: { url: string; title?: string };
}

const clone = <T>(value: T): T => structuredClone(value);

/**
 * `labels = "agentic"` / `status = "In Review"` / `parent = "ACME-100"`, then the extras.
 *
 * The leading parenthesis is the `kind: 'query'` form, which the adapter wraps so that a raw JQL
 * fragment cannot merge with the window clause it appends.
 */
/**
 * The replay's page size for `search/jql` (WP-87 review round 2): smaller than anything the adapter
 * asks for, so paging through `nextPageToken` is exercised on every search longer than it. Allowed by
 * the swagger's own words (*"API may return fewer items per page"*); the real figure is not measured.
 */
export const REPLAY_SEARCH_PAGE_CAP = 20;

/**
 * The replay's largest comment page (WP-111, divergence 8): smaller than the marker search's
 * hundred, so a thread of more than fifty comments is read across short pages that are **not** the
 * last — the case a search that stepped by what it asked for, rather than by what came back, would
 * get wrong. The swagger publishes no maximum for this endpoint and describes the response's
 * `maxResults` as *"the maximum number of items that could be returned"*; the real figure is not
 * measured. Fifty is also `readTicket`'s own page, so its request is answered in full.
 */
export const REPLAY_COMMENT_PAGE_CAP = 50;

const JQL_CLAUSE = /^\(?(labels|status|parent) = "((?:[^"\\]|\\.)*)"/;
/** WP-110: the live tasks' read, `key in ("ACME-1", "ACME-2")` — every key a JQL string literal. */
const JQL_KEYS = /^key in \(((?:"(?:[^"\\]|\\.)*"(?:, )?)+)\)/;
const JQL_KEY_LITERAL = /"((?:[^"\\]|\\.)*)"/g;
const JQL_KEY_EXCLUSION = /AND key != "([^"]+)"/;
const JQL_WINDOW = /AND updated >= "-(\d+)m"/;

export const createJiraReplay = (options: { readonly now?: string } = {}): JiraReplay => {
  const nowMs = Date.parse(options.now ?? JIRA_REPLAY_NOW);
  const issues = new Map<string, Record<string, unknown>>();
  const comments = new Map<string, StoredComment[]>();
  const remoteLinks = new Map<string, StoredRemoteLink[]>();
  const requests: RecordedRequest[] = [];
  const scripted: string[] = [];
  /** Old key → current key, for a moved issue (divergence 10). */
  const moved = new Map<string, string>();
  let unknownKeyWording: 'documented' | 'value' | 'opaque' = 'documented';
  let nextId = 10_600;

  const transitionsFixture = bodyOf('transitions-acme-1.json') as {
    transitions: { id: string; to?: { name?: string } }[];
  };
  const myself = bodyOf('myself.json') as { accountId: string; displayName: string };
  const bot = { ...myself };
  const directory = (bodyOf('user-search.json') as unknown as Record<string, unknown>[]).map(
    (user) => ({ ...user }),
  );
  // The directory the double answers `user/search` from. Emails are held here and deliberately
  // **not** returned, exactly as Atlassian's documented example response omits them.
  const emails = new Map<string, string>([
    [(directory[0] as { accountId: string }).accountId, 'dev@example.test'],
  ]);

  const seed = (): void => {
    issues.set('ACME-1', bodyOf('issue-acme-1.json'));
    issues.set('ACME-100', bodyOf('issue-acme-100-epic.json'));
    issues.set('ACME-2', {
      id: '10002',
      key: 'ACME-2',
      self: `${JIRA_REPLAY_SITE}/rest/api/3/issue/10002`,
      fields: {
        summary: 'Invoice PDF layout',
        issuetype: { id: '10004', name: 'Task' },
        status: { id: '10009', name: 'Done' },
        labels: [],
        created: '2026-08-25T09:00:00.000+0000',
        updated: '2026-08-28T09:00:00.000+0000',
        parent: { key: 'ACME-100', fields: { summary: 'Billing' } },
      },
    });
    const seeded = bodyOf('comments-acme-1.json') as { comments: StoredComment[] };
    comments.set('ACME-1', seeded.comments);
    remoteLinks.set('ACME-1', []);
  };
  seed();

  const fieldsOf = (key: string): Record<string, unknown> =>
    (issues.get(key) as { fields: Record<string, unknown> }).fields;

  const statusName = (key: string): string =>
    (fieldsOf(key).status as { name?: string } | undefined)?.name ?? '';

  const jsonResponse = (
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): Response =>
    new Response(body === null || body === undefined ? '' : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });

  const notFound = (): Response => jsonResponse(404, bodyOf('error-not-found.json'));

  const namedKeysOf = (jql: string): string[] => {
    const keysClause = JQL_KEYS.exec(jql);
    return keysClause === null
      ? []
      : [...(keysClause[1] ?? '').matchAll(JQL_KEY_LITERAL)].map((literal) =>
          (literal[1] ?? '').replace(/\\"/g, '"').replace(/\\\\/g, '\\'),
        );
  };

  const searchIssues = (jql: string): Record<string, unknown>[] => {
    const keysClause = JQL_KEYS.exec(jql);
    const named =
      keysClause === null
        ? null
        : new Set(
            [...(keysClause[1] ?? '').matchAll(JQL_KEY_LITERAL)].map((literal) =>
              (literal[1] ?? '').replace(/\\"/g, '"').replace(/\\\\/g, '\\'),
            ),
          );
    const clause = (JQL_CLAUSE.exec(jql) ?? ['', 'labels', '']) as RegExpExecArray;
    const field = clause[1] as 'labels' | 'status' | 'parent';
    const value = (clause[2] ?? '').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    const excluded = JQL_KEY_EXCLUSION.exec(jql)?.[1] ?? null;
    const windowMinutes = Number(JQL_WINDOW.exec(jql)?.[1] ?? '0');
    const cutoff = windowMinutes === 0 ? null : nowMs - windowMinutes * 60_000;

    // `ORDER BY updated ASC` — the only order the adapter asks for — honoured, stably by insertion.
    const updatedOf = (issue: Record<string, unknown>): number =>
      Date.parse(String((issue.fields as Record<string, unknown>).updated ?? ''));
    return [...issues.values()]
      .toSorted((left, right) => updatedOf(left) - updatedOf(right))
      .filter((issue) => {
        const key = issue.key as string;
        const fields = issue.fields as Record<string, unknown>;
        if (key === excluded) {
          return false;
        }
        if (cutoff !== null && Date.parse(String(fields.updated ?? '')) < cutoff) {
          return false;
        }
        if (named !== null) {
          return named.has(key);
        }
        if (field === 'labels') {
          return ((fields.labels as string[] | undefined) ?? []).includes(value);
        }
        if (field === 'status') {
          return (fields.status as { name?: string } | undefined)?.name === value;
        }
        return (fields.parent as { key?: string } | undefined)?.key === value;
      });
  };

  /**
   * Divergence 1, as a response rather than as a `throw`.
   *
   * The client deliberately drops a thrown transport error (it carries the `Authorization`
   * header), so a `throw` here would reach the test as "did not complete" with the reason lost.
   * A 5xx carrying the reason in the documented `ErrorCollection` shape keeps the message and
   * still fails the test by name.
   */
  const harnessError = (detail: string): Response =>
    jsonResponse(501, { errorMessages: [detail], errors: {} });

  const route = (request: RecordedRequest): Response => {
    const { method, path, query } = request;
    const segments = path.split('/');

    if (method === 'GET' && path === 'myself') {
      return jsonResponse(200, myself);
    }
    if (method === 'GET' && path === 'user') {
      const account = directory.find((user) => user.accountId === query.accountId);
      return account === undefined ? notFound() : jsonResponse(200, account);
    }
    if (method === 'GET' && path === 'user/search') {
      const wanted = (query.query ?? '').toLowerCase();
      const found = directory.filter(
        (user) => emails.get(user.accountId as string)?.toLowerCase() === wanted,
      );
      return jsonResponse(200, found);
    }
    if (method === 'GET' && path === 'search/jql') {
      const jql = query.jql ?? '';
      if (!JQL_CLAUSE.test(jql) && !JQL_KEYS.test(jql)) {
        return harnessError(`jira replay: unsupported JQL "${jql}"`);
      }
      // WP-110 review round 1: a `key in (…)` naming a key that does not exist is refused whole,
      // as Atlassian documents for search (`error-issue-key-does-not-exist.json`, `inferred`).
      const absent = namedKeysOf(jql).filter((key) => !issues.has(key));
      if (absent.length > 0) {
        const refusal = loadJiraFixture('error-issue-key-does-not-exist.json').response;
        const body = refusal?.body as { errorMessages?: string[] } | undefined;
        const template = body?.errorMessages?.[0] ?? '';
        const messages =
          unknownKeyWording === 'opaque'
            ? ['Error in the JQL Query: the query could not be completed.']
            : absent.map((key) =>
                unknownKeyWording === 'value'
                  ? `The value '${key}' does not exist for the field 'key'.`
                  : template.replace("'ACME-404'", `'${key}'`),
              );
        return jsonResponse(refusal?.status ?? 400, { errorMessages: messages, errors: {} });
      }
      const found = searchIssues(jql);
      const limit = Number(query.maxResults ?? '50');
      // `nextPageToken` (WP-87 review round 2): the documented token vocabulary, absent on the last
      // page. The token is an opaque offset here; what Jira puts in it is not documented and the
      // adapter treats it as opaque. A page is also capped at `REPLAY_SEARCH_PAGE_CAP`, below what
      // the adapter asks for, because the swagger says a page may be shorter than `maxResults`.
      const offset = query.nextPageToken === undefined ? 0 : Number(query.nextPageToken);
      const size = Math.min(limit, REPLAY_SEARCH_PAGE_CAP);
      const page = found.slice(offset, offset + size);
      const more = offset + size < found.length;
      return jsonResponse(200, {
        isLast: !more,
        issues: page.map(clone),
        ...(more ? { nextPageToken: String(offset + size) } : {}),
      });
    }
    if (method === 'POST' && path === 'issue') {
      const fields = (request.body as { fields: Record<string, unknown> }).fields;
      nextId += 1;
      const key = `${(fields.project as { key: string }).key}-${nextId}`;
      issues.set(key, {
        id: String(nextId),
        key,
        self: `${JIRA_REPLAY_SITE}/rest/api/3/issue/${nextId}`,
        fields: {
          summary: fields.summary,
          description: fields.description ?? null,
          issuetype: { id: '10004', name: (fields.issuetype as { name: string }).name },
          status: { id: '10001', name: 'Ready for agent' },
          priority: fields.priority ?? null,
          labels: fields.labels ?? [],
          created: '2026-09-02T12:05:00.000+0000',
          updated: '2026-09-02T12:05:00.000+0000',
          ...(fields.parent === undefined ? {} : { parent: fields.parent }),
        },
      });
      comments.set(key, []);
      remoteLinks.set(key, []);
      return jsonResponse(201, { ...bodyOf('issue-created.json'), id: String(nextId), key });
    }

    if (segments[0] === 'issue' && segments[1] !== undefined) {
      const asked = decodeURIComponent(segments[1]);
      const key = moved.get(asked) ?? asked;
      if (!issues.has(key)) {
        return notFound();
      }
      const tail = segments.slice(2).join('/');

      if (method === 'GET' && tail === '') {
        return jsonResponse(200, clone(issues.get(key)));
      }
      if (method === 'PUT' && tail === '') {
        const update = (
          request.body as { update?: { labels?: { add?: string; remove?: string }[] } }
        ).update;
        const labels = new Set((fieldsOf(key).labels as string[] | undefined) ?? []);
        for (const operation of update?.labels ?? []) {
          if (operation.add !== undefined) {
            labels.add(operation.add);
          }
          if (operation.remove !== undefined) {
            labels.delete(operation.remove);
          }
        }
        fieldsOf(key).labels = [...labels];
        return new Response(null, { status: 204 });
      }
      if (method === 'GET' && tail === 'comment') {
        // Jira's documented page (`swagger-v3.v3.json`, retrieved 2026-09-28): `orderBy` is
        // `created`, `+created` or `-created`, and `maxResults` (default 100) is the page size.
        // Honoured, not ignored (standing rule 1): `readTicket` asks for the newest page since
        // WP-83, and a replay that answered the oldest one in ascending order would hand the
        // adapter's re-ordering the opposite of what Jira sends. Stored in creation order.
        //
        // `startAt` (default 0, the page offset) is honoured too since WP-111, and the page is
        // **capped** at {@link REPLAY_COMMENT_PAGE_CAP} whatever was asked — divergence 8.
        const stored = comments.get(key) ?? [];
        const maxResults = Math.min(Number(query.maxResults ?? '100'), REPLAY_COMMENT_PAGE_CAP);
        const startAt = Number(query.startAt ?? '0');
        const ordered = query.orderBy === '-created' ? [...stored].reverse() : stored;
        return jsonResponse(200, {
          comments: ordered.slice(startAt, startAt + maxResults).map(clone),
          startAt,
          maxResults,
          total: stored.length,
        });
      }
      if (method === 'POST' && tail === 'comment') {
        nextId += 1;
        const created: StoredComment = {
          ...(bodyOf('comment-created.json') as unknown as StoredComment),
          self: `${JIRA_REPLAY_SITE}/rest/api/3/issue/${key}/comment/${nextId}`,
          id: String(nextId),
          author: bot,
          updateAuthor: bot,
          body: (request.body as { body: unknown }).body,
        };
        comments.set(key, [...(comments.get(key) ?? []), created]);
        return jsonResponse(201, clone(created));
      }
      if (method === 'PUT' && segments[2] === 'comment' && segments[3] !== undefined) {
        const commentId = decodeURIComponent(segments[3]);
        const stored = comments.get(key) ?? [];
        const existing = stored.find((comment) => comment.id === commentId);
        if (existing === undefined) {
          return notFound();
        }
        existing.body = (request.body as { body: unknown }).body;
        existing.updated = '2026-09-02T12:06:00.000+0000';
        return jsonResponse(200, clone(existing));
      }
      if (method === 'GET' && tail === 'transitions') {
        const current = statusName(key);
        // Divergence 3: a workflow does not offer a transition into the status you are in.
        return jsonResponse(200, {
          transitions: transitionsFixture.transitions.filter(
            (transition) => transition.to?.name !== current,
          ),
        });
      }
      if (method === 'POST' && tail === 'transitions') {
        const id = (request.body as { transition: { id: string } }).transition.id;
        const transition = transitionsFixture.transitions.find((entry) => entry.id === id);
        if (transition === undefined || transition.to?.name === undefined) {
          return jsonResponse(400, { errorMessages: ['Transition is not valid for this issue.'] });
        }
        fieldsOf(key).status = { id: '0', name: transition.to.name };
        fieldsOf(key).updated = '2026-09-02T12:07:00.000+0000';
        return new Response(null, { status: 204 });
      }
      if (method === 'GET' && tail === 'remotelink') {
        return jsonResponse(200, clone(remoteLinks.get(key) ?? []));
      }
      if (method === 'POST' && tail === 'remotelink') {
        const link = request.body as StoredRemoteLink;
        const stored = remoteLinks.get(key) ?? [];
        const existing = stored.findIndex((entry) => entry.globalId === link.globalId);
        nextId += 1;
        const saved = { ...link, id: nextId };
        // Atlassian: a matching `globalId` updates rather than creates.
        remoteLinks.set(
          key,
          existing === -1
            ? [...stored, saved]
            : stored.map((entry, index) => (index === existing ? saved : entry)),
        );
        return jsonResponse(existing === -1 ? 201 : 200, {
          ...bodyOf('remote-link-created.json'),
          id: nextId,
        });
      }
    }

    return harnessError(`jira replay: no route for ${method} ${path}`);
  };

  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input as string, init);
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/rest\/api\/3\//, '');
    const query: Record<string, string> = {};
    for (const [name, value] of url.searchParams) {
      query[name] = value;
    }
    const text = request.method === 'GET' ? '' : await request.text();
    const recorded: RecordedRequest = {
      method: request.method,
      path,
      query,
      body: text.length === 0 ? undefined : JSON.parse(text),
    };
    requests.push(recorded);

    const next = scripted.shift();
    if (next !== undefined) {
      const fixture = loadJiraFixture(next);
      const response = fixture.response;
      if (response === undefined) {
        throw new Error(`jira replay: scripted fixture ${next} has no response`);
      }
      return jsonResponse(response.status, response.body, response.headers ?? {});
    }
    return route(recorded);
  };

  return {
    fetch: fetchImpl,
    requests,
    script: (fixtureName) => scripted.push(fixtureName),
    peekIssue: (key) => issues.get(key),
    commentCount: (key) => (comments.get(key) ?? []).length,
    commentIds: (key) => (comments.get(key) ?? []).map((comment) => comment.id),
    appendHumanComments: (key, count) => {
      const template = (bodyOf('comments-acme-1.json') as { comments: StoredComment[] })
        .comments[0] as StoredComment;
      const thread = comments.get(key) ?? [];
      for (let index = 0; index < count; index += 1) {
        nextId += 1;
        thread.push({
          ...clone(template),
          self: `${JIRA_REPLAY_SITE}/rest/api/3/issue/${key}/comment/${nextId}`,
          id: String(nextId),
          author: directory[0],
          updateAuthor: directory[0],
        });
      }
      comments.set(key, thread);
    },
    reattributeComment: (key, commentId, markerId) => {
      const comment = (comments.get(key) ?? []).find((entry) => entry.id === commentId);
      if (comment === undefined) {
        throw new Error(`jira replay: no comment ${commentId} on ${key}`);
      }
      comment.author = directory[0];
      comment.updateAuthor = directory[0];
      comment.body = {
        version: 1,
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'not the workpad' }] },
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: `[agentic:marker:${markerId}]`, marks: [{ type: 'code' }] },
            ],
          },
        ],
      };
    },
    moveIssue: (from, to) => {
      const issue = issues.get(from);
      if (issue === undefined) {
        throw new Error(`jira replay: no issue ${from} to move`);
      }
      issues.delete(from);
      issues.set(to, { ...issue, key: to });
      comments.set(to, comments.get(from) ?? []);
      comments.delete(from);
      remoteLinks.set(to, remoteLinks.get(from) ?? []);
      remoteLinks.delete(from);
      for (const [old, current] of moved) {
        if (current === from) {
          moved.set(old, to);
        }
      }
      moved.set(from, to);
    },
    refuseUnknownKeysWith: (wording) => {
      unknownKeyWording = wording;
    },
    resetRequests: () => {
      requests.length = 0;
    },
    delivery: (fixtureName, overrides = {}) => {
      const fixture = loadJiraFixture(fixtureName);
      if (fixture.delivery === undefined) {
        throw new Error(`jira replay: fixture ${fixtureName} carries no delivery`);
      }
      const body = structuredClone(fixture.delivery.body);
      if (overrides.timestamp !== undefined) {
        body.timestamp = overrides.timestamp;
      }
      overrides.patch?.(body);
      const serialised = JSON.stringify(body);
      const signature =
        overrides.signature ?? signWebhookBody(overrides.secret ?? JIRA_REPLAY_SECRET, serialised);
      return {
        headers: {
          ...fixture.delivery.headers,
          ...(overrides.deliveryId === undefined
            ? {}
            : { 'x-atlassian-webhook-identifier': overrides.deliveryId }),
          'x-hub-signature': signature,
        },
        body: serialised,
      };
    },
  };
};

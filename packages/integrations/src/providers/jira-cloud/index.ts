/**
 * **Jira Cloud** — the first `TaskManagement` provider (WP-08, technical/06, BD-017).
 *
 * Nothing in the pipeline, the UI or the knowledge base knows this file exists: they hold a
 * `TaskManagementPort`, and this is one. What follows is the part of that contract that is
 * specific to Jira and could not be learned from the port alone.
 *
 * ## Every outbound call goes through `IntegrationActionExecutor`
 *
 * Not "most": every one, reads included. The executor owns shadow mode, idempotency, the
 * per-binding rate limit, the audit row (BD-003) and — the reason a *read* goes through it too —
 * the single `catch` that scrubs an escaping error (TD-012). `docs/TODO.md` records that an
 * adapter throwing *outside* the executor is uncovered, and round 1 of this work package's review
 * found one here: `transition` decided "no such transition" after its resolving action had
 * returned and threw the provider's own status names past the scrub. The decision now happens
 * inside `perform`, and the assertion that keeps it there is an audit row — only the executor
 * writes one, so a refusal that is *recorded* is a refusal that went through it. The throws left
 * outside carry no provider text at all: a missing delivery header, the caller's own marker id,
 * and the constant message of an `IntegrationUnsupportedError`.
 *
 * One executor action is one **port call**, not one HTTP request: `readTicket` spends a single
 * `read_ticket` action on three requests (issue, comments, remote links), five when the ticket is
 * in an epic (parent, siblings). That keeps the audit readable — a row is something the platform
 * decided to do — and it makes the rate limiter count port calls, which is why
 * `JIRA_CLOUD_RATE_LIMIT_POLICY` below is deliberately far under Jira's own budget.
 *
 * A port method that *resolves* something before mutating spends two actions, and that is on
 * purpose: `transition` records a `resolve_transition` read and then, only if a move is actually
 * needed, a `transition` write. A shadow task performs the first and stops at the second — which
 * is what shadow mode means — and an unknown target status still fails loudly in shadow mode,
 * because the resolution happens before the guard.
 *
 * ## Where the task's mode comes from
 *
 * `MutatingActionRequest.mode` is required and must never be defaulted (a shadow guard that
 * guesses "not guarded" fails open). The port's methods have no mode parameter, so this adapter is
 * constructed with an `actionContext` function that answers "on whose behalf is this call being
 * made" — the task's `mode`, and its ids for the audit row. WP-15 supplies it when it resolves a
 * binding for a task; `fixedActionContext` is the answer for a caller that has no task (a poll, a
 * health probe) and is deliberately explicit rather than implied.
 *
 * ## Idempotency lives in the provider, not in a store
 *
 * technical/06's list — "marker ids for comments, only transition if not already there" — is
 * implemented against Jira itself: the workpad is found by its marker (BD-023), a marked comment
 * is not posted twice, a transition to the current status is `{changed:false}`, a label set that
 * would change nothing sends no request, and a merge-request link is a `globalId` remote link,
 * which Atlassian documents as create-*or-update*. None of them uses `IdempotencyPlan`, on
 * purpose: two mechanisms that can each discharge the same obligation need an arbiter (standing
 * rule 9), and the provider-side one is the one that survives a restart, a redeploy and an empty
 * idempotency store.
 *
 * ## The workpad marker is checked against the author
 *
 * The marker is visible text in the comment body (see `adf.ts`), so a human can type one. A
 * candidate comment is therefore accepted as the workpad only when its author is the account this
 * binding authenticates as (`GET /rest/api/3/myself`, fetched once and remembered). Without that
 * check, a quoted marker would make the platform edit somebody else's comment — and if Jira will
 * not say which account that is, `requireSelfAccountId` refuses rather than comparing against
 * `null`.
 *
 * The author check is necessary and **not sufficient**, which round 1 of this work package's
 * review proved by posting a marker through `addComment`: the comment is then authored by the bot,
 * so the check passes, but the text came from an agent that reads attacker-controlled ticket
 * descriptions (BD-022) — "the bot wrote it" is not "the platform wrote it". `adf.ts` therefore
 * defuses any marker in caller-supplied markdown before appending the platform's own.
 */
import {
  bindingSecretRedactor,
  type CommentRef,
  composeSecretRedactors,
  type ExternalIdentity,
  egressHostOf,
  type HealthProbe,
  type IntegrationActionExecutor,
  IntegrationError,
  type IntegrationRef,
  IntegrationUnsupportedError,
  parseProviderData,
  type RateLimitPolicy,
  type SecretRedactor,
  type TaskManagementCapabilities,
  type TaskManagementPort,
  type Ticket,
  type TicketDraft,
  type TicketMatch,
  type TicketMatchRule,
  type TicketPollPlan,
  type TicketRefInput,
  type TransitionResult,
  ticketSchema,
} from '@platform/application';
import type { Id, JsonObject, TaskMode } from '@platform/contracts';
import type { Clock } from '@platform/domain';
import * as z from 'zod';
import { adfMarkerId, adfToMarkdown, markdownToAdfDocument } from './adf.js';
import {
  basicAuthHeader,
  createJiraClient,
  type JiraClient,
  type JiraClientOptions,
} from './client.js';
import { type JiraCloudConfig, jiraCloudConfigSchema } from './config.js';
import {
  commentUrl,
  identityOfUser,
  issueUrl,
  type JiraComment,
  type JiraTransition,
  jiraCommentPageSchema,
  jiraCommentSchema,
  jiraCreatedIssueSchema,
  jiraIssueWithUpdatedSchema,
  jiraRemoteLinkSchema,
  jiraSearchResultSchema,
  jiraTransitionsSchema,
  jiraUserSchema,
  PROVIDER_ID,
  toTicket,
  toTicketMatch,
} from './mapping.js';
import { createJiraInboundNormaliser, type JiraPickupRule } from './webhook.js';

export * from './adf.js';
export * from './client.js';
export * from './config.js';
export * from './mapping.js';
export * from './webhook.js';

/**
 * Deliberately far below Jira's documented budget.
 *
 * Jira Cloud throttles on *cost* (`.../platform/rate-limiting/`, retrieved 2026-09-10): a points
 * quota per hour plus per-second burst limits, with `429` and `Retry-After` when either is spent.
 * Nobody has measured this platform's cost profile against a real site, and one action here is up
 * to five requests, so the budget is set where a mistake costs latency rather than a quota cut.
 * A binding that knows better passes its own policy through the executor's `rateLimits` resolver.
 */
export const JIRA_CLOUD_RATE_LIMIT_POLICY: RateLimitPolicy = {
  capacity: 5,
  refillPerSecond: 2,
  maxConcurrent: 3,
};

const remoteLinksSchema = z.array(jiraRemoteLinkSchema);
const usersSchema = z.array(jiraUserSchema);

const FIELDS_FOR_TICKET =
  'summary,description,issuetype,status,priority,labels,updated,created,assignee,reporter,parent,issuelinks';
const FIELDS_FOR_MATCH = 'issuetype,status,priority,labels,updated,parent,issuelinks';

/**
 * The most issues one `search/jql` request asks for. Atlassian's swagger (`swagger-v3.v3.json`,
 * `GET /rest/api/3/search/jql`, retrieved 2026-09-29): `maxResults` defaults to 50, and *"To manage
 * page size, API may return fewer items per page where a large number of fields or properties are
 * requested"*; `nextPageToken` *"is **not included** in the response for the last page"*. So a
 * hundred is asked for and whatever arrives is paged past with the token.
 */
const MATCH_PAGE_MAX = 100;
/**
 * How many comments one page of the **marker search** asks for, oldest first — `maxResults`, a
 * page-size *request* (the swagger's default for this endpoint is 100 and it publishes no maximum;
 * the response's own `maxResults` is *"the maximum number of items that could be returned"*, so a
 * site may answer fewer). The search emits nothing (it looks for this binding's own marked comment
 * and returns a reference), so a larger page than asked is iterated rather than cut: cutting it
 * could hide the workpad and make `upsertWorkpad` post a second one. The next page starts where
 * the comments **actually returned** end, never at `startAt + MARKER_SEARCH_PAGE`, so a site that
 * caps the page lower skips nothing.
 */
const MARKER_SEARCH_PAGE = 100;

/**
 * **The marker search's page bound: twenty-one pages** — WP-111, PROGRESS backlog 288.
 *
 * Until WP-111 the search read one page, the oldest hundred, on the assumption that *"the workpad
 * is written early in a ticket's life"*. That is an assumption about the ticket, not a bound: on a
 * ticket that already had a hundred comments when the workpad was first written, the search never
 * found it again, `upsertWorkpad` posted a new workpad on every stage transition and a retried
 * marked question was posted twice. The search now pages by `startAt` until it finds the marker or
 * reads an **empty page**, and **at most this many pages**.
 *
 * **Only an empty page ends it** (WP-111 review round 1, backlog 377). The swagger describes
 * `PageOfComments.total` as *"The number of items returned"*, which read literally is the page's own
 * length; stopping at `startAt + returned >= total` then ends every search after its first page and
 * brings 288 back (reproduced by the reviewer). So `total` is never a reason to stop — it is only a
 * reason to **refuse**: a page that comes back empty while a usable `total` claims more comments
 * than were read fails by name. The cost is one extra `GET` per search, the empty page.
 *
 * **The arithmetic.** The final empty page counts against the bound, so the bound is twenty pages
 * of comments plus that one: a thread of at most 20 × {@link MARKER_SEARCH_PAGE} = 2 000 comments
 * is read to its end on a site that answers full pages (20 × 50 = 1 000 on one that answers fifty).
 *
 * **At the bound it fails** ({@link JiraMarkerSearchBoundError}): answering `null` there is the
 * answer that *posts* (standing rule 20 — fail closed on a mutation). A ticket past the bound
 * therefore gets no workpad update and no marked comment, loudly, rather than a duplicate per stage
 * transition.
 */
export const MARKER_SEARCH_MAX_PAGES = 21;

/**
 * The marker search could not establish that the marked comment is absent — it read
 * {@link MARKER_SEARCH_MAX_PAGES} pages without reaching an empty page, or an empty page came back
 * while the thread's `total` claimed more comments than were read. `conflict` because the ticket's own state (its thread) is what prevents the
 * write, and it is **not retryable**: the next attempt reads the same thread.
 */
export class JiraMarkerSearchBoundError extends IntegrationError {
  constructor(action: string, detail: string) {
    super(
      'conflict',
      PROVIDER_ID,
      `the marker search ${detail}; refusing to answer "not found", which would post a second comment`,
      { action },
    );
  }
}

/**
 * The page's `total`, when it is a usable count — the thread's size as Jira states it. Anything
 * else (absent, negative, fractional, past `Number.MAX_SAFE_INTEGER`, not a number) is "no usable
 * total". The search never stops on `total` either way (only an empty page ends it); a usable one is
 * only compared at that empty page, to refuse a thread that claims more than was read.
 */
const usableTotal = (total: unknown): number | null =>
  typeof total === 'number' && Number.isSafeInteger(total) && total >= 0 ? total : null;

/**
 * **The comment page one `readTicket` emits: the newest fifty, and never more** — WP-83, Q54's third
 * sub-decision (*"whether the comment page should be paginated to a decided number rather than
 * asked for one and handed another"*).
 *
 * Until WP-83 `readTicket` asked for `maxResults=100` in `orderBy=created` order — the **oldest**
 * hundred — and mapped whatever came back: `unbounded-emission.test.ts` scripted two hundred and
 * all two hundred were emitted. Two defects, and both are closed here:
 *
 *  - **the page is decided and enforced**: the request asks for this many and the answer is cut to
 *    it, so a provider, a proxy or a future default that answers with more hands over no more;
 *  - **it is the newest page** (`orderBy=-created`, documented in Atlassian's OpenAPI description of
 *    `GET /rest/api/3/issue/{issueIdOrKey}/comment` — `enum: ["created", "-created", "+created"]`,
 *    https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json, retrieved 2026-09-28),
 *    re-ordered oldest first before it is mapped, because a thread reads forwards. The one consumer,
 *    the task's ticket snapshot, keeps the newest `MAX_TICKET_COMMENTS` (20) comments **a human
 *    wrote** — and on a ticket with more than a hundred comments the old order handed it the newest
 *    twenty of the *oldest* hundred.
 *
 * **Why fifty**: twenty human comments, plus room for thirty of the platform's own among the newest
 * (the workpad, lint and notification comments carry a marker and the snapshot skips them) before
 * a human comment falls off the page. A ticket busier than that loses its older human comments from
 * the snapshot — and says so: the page's `total` rides out as `Ticket.comment_total`, and the
 * snapshot sets `truncated` when the page was not the whole thread (backlog 290, closed at WP-83
 * review round 1). The text of each comment is
 * the consumer's to bound (the snapshot's 1 000 characters, Q54's *"bound at the consumer"*); this
 * bounds how **many** there are, which only the adapter can.
 */
export const READ_TICKET_COMMENT_PAGE = 50;

/**
 * The thread's size for `Ticket.comment_total`, from the page's `total` — WP-83 review round 2.
 *
 * - **A usable `total`** (a non-negative safe integer) is the answer, floored at what was mapped:
 *   a provider that under-counts must not make a page look whole — **except** for a full page
 *   whose `total` does not exceed it, which is `null` (backlog 377: `total` may be the page's own
 *   length, so it cannot say the page was the thread).
 * - **No usable `total`, and the page came back short of what was asked** — the provider returned
 *   fewer than `READ_TICKET_COMMENT_PAGE` — means the page *is* the thread, so its length is known
 *   and is the answer.
 * - **No usable `total` and a full page** is `null`: the platform does not know whether there were
 *   more, and `null` is the port's "possibly more", which the snapshot declares as `truncated`.
 *
 * A hostile `total` — negative, fractional, or past `Number.MAX_SAFE_INTEGER`, which would fail the
 * port's `z.int()` and with it the **whole** `readTicket` — degrades to "no usable total" instead of
 * failing the read (standing rule 20: this is a read of somebody else's data, and one bad count is
 * not a reason to withhold the ticket's title, description and comments from the task). Nothing is
 * lost by degrading, because the full-page rule still declares the cut.
 */
export const commentTotalOf = (total: unknown, returned: number): number | null => {
  const shown = Math.min(returned, READ_TICKET_COMMENT_PAGE);
  if (typeof total === 'number' && Number.isSafeInteger(total) && total >= 0) {
    // A **full** page whose `total` does not exceed it cannot tell "the thread is exactly this
    // long" from "`total` is the page's own length" — which is what the swagger's words say it is
    // (*"The number of items returned"*, backlog 377). So it is "possibly more", never a count; it
    // over-declares only a thread of exactly one page (WP-111 review round 1).
    if (returned >= READ_TICKET_COMMENT_PAGE && total <= shown) {
      return null;
    }
    return Math.max(total, shown);
  }
  return returned < READ_TICKET_COMMENT_PAGE ? shown : null;
};

/** On whose behalf a call is made. `mode` is `tasks.mode` (technical/03) and is never defaulted. */
export interface JiraActionContext {
  readonly mode: TaskMode;
  readonly projectId?: Id | null;
  readonly taskId?: Id | null;
}

/** For a caller with no task: a poll, a health probe, the setup wizard. */
export const fixedActionContext = (mode: TaskMode): (() => JiraActionContext) => {
  return () => ({ mode, projectId: null, taskId: null });
};

export interface JiraCloudOptions {
  readonly integrationId: Id;
  readonly config: JiraCloudConfig;
  readonly executor: IntegrationActionExecutor;
  /** See the module docblock: the task this call belongs to, read at every call. */
  readonly actionContext: () => JiraActionContext;
  readonly clock: Clock;
  /** Injected by the fixture-replay contract runner; the default is the global `fetch`. */
  readonly fetch?: JiraClientOptions['fetch'];
  /**
   * TD-012, **required** (standing rule 31, earned at WP-11).
   *
   * This adapter already builds a redactor from its own credentials, which is the half a caller
   * cannot forget; this is the half a caller knows and the adapter cannot — a run-scoped token, a
   * neighbouring binding's secret. `ProviderCreateInput.redactor` is where it comes from in
   * production, and the two are composed rather than chosen between.
   */
  readonly redactor: SecretRedactor;
}

const jsonPayload = (fields: JsonObject): JsonObject => fields;

export const createJiraCloudTaskManagement = (options: JiraCloudOptions): TaskManagementPort => {
  const config = jiraCloudConfigSchema.parse(options.config);
  const ref: IntegrationRef = {
    integrationId: options.integrationId,
    provider: PROVIDER_ID,
    type: 'task_management',
    /**
     * The host every call from this binding goes to, off the validated config (WP-51, backlog 48).
     *
     * `egressHostOf` rather than a hand-rolled parse: the executor's allow-list compares the value
     * it finds here against what an operator declared, and two spellings of "the host" would be two
     * chances to disagree.
     */
    host: egressHostOf(config.site_url),
  };
  const siteUrl = config.site_url.replace(/\/+$/, '');

  /**
   * What the caller injected, plus **this binding's own credentials**.
   *
   * Built from the binding's own secrets, which is the path `docs/TODO.md` asks the first provider
   * work package to take rather than inventing a second one: a redactor assembled beside a binding
   * instead of from it is a redactor that does not know the token it is meant to hide. It is
   * composed with `options.redactor` rather than chosen against it, because the two halves know
   * different things — the caller knows a run-scoped or a neighbouring binding's secret, and only
   * the adapter knows its own (standing rule 31).
   *
   * Three values, and each for a path that exists:
   *
   *  - **`api_token`** is what an operator pastes into a ticket comment while debugging, and what
   *    a Jira error body can echo.
   *  - **the `Authorization` header** — `Basic base64(email:api_token)` — because the base64 of a
   *    credential *is* the credential and the token is **not a substring of it**, so redacting the
   *    token alone would not touch it. `client.ts` used to publish this value as
   *    `authorizationHeader` "so a redactor can be built from it"; nothing read it, and this is
   *    that sentence discharged.
   *  - **`webhook_secret`**, because it arrives *inbound* — it is the HMAC key an operator is most
   *    likely to paste into a ticket while setting the webhook up — and an inbound delivery becomes
   *    `events.payload`, which is append-only (BD-003) and cannot be fixed afterwards.
   *
   * `bindingSecretRedactor` rather than `exactSecretRedactor`: it skips a value below
   * `MIN_SECRET_LENGTH` instead of throwing, so a binding whose token is a four-character stub
   * still answers queries rather than failing at construction with a message about redaction.
   */
  const redactor: SecretRedactor = composeSecretRedactors(
    options.redactor,
    bindingSecretRedactor([
      { name: 'jira_api_token', value: config.api_token },
      {
        name: 'jira_basic_auth',
        value: basicAuthHeader(config.user_email, config.api_token).replace(/^Basic /, ''),
      },
      config.webhook_secret === null || config.webhook_secret === undefined
        ? null
        : { name: 'jira_webhook_secret', value: config.webhook_secret },
    ]),
  );

  const client: JiraClient = createJiraClient({
    siteUrl,
    email: config.user_email,
    apiToken: config.api_token,
    timeoutMs: config.request_timeout_ms,
    now: () => Date.parse(options.clock.now()),
    // The choke point: every document crossing the transport, in both directions, is redacted
    // once before anything reads it (`client.ts`, "Where redaction happens").
    redactor,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });

  const capabilities: TaskManagementCapabilities = {
    webhooks: typeof config.webhook_secret === 'string' && config.webhook_secret.length > 0,
    epics: true,
    links: true,
    // No custom field is read into a `Ticket` and none can be written; `transition` refuses a
    // `fields` argument rather than forwarding one it cannot validate against the screen.
    customFields: false,
    adf: true,
    createTicket: true,
    // Nothing downloads an attachment or extracts its text: `attachments_text` is always empty.
    attachments: false,
  };

  const context = (): JiraActionContext => options.actionContext();

  const read = async <T>(
    action: string,
    payload: JsonObject,
    perform: () => Promise<T>,
    describeResult?: (result: T) => JsonObject | null,
  ): Promise<T> => {
    const { mode, projectId, taskId } = context();
    const outcome = await options.executor.execute<T>({
      integration: ref,
      action,
      mutating: false,
      mode,
      projectId: projectId ?? null,
      taskId: taskId ?? null,
      payload,
      perform,
      ...(describeResult === undefined ? {} : { describeResult }),
    });
    return outcome.result;
  };

  const mutate = async <T>(
    action: string,
    payload: JsonObject,
    perform: () => Promise<T>,
    shadowResult: () => T,
    describeResult: (result: T) => JsonObject | null,
  ): Promise<T> => {
    const { mode, projectId, taskId } = context();
    const outcome = await options.executor.execute<T>({
      integration: ref,
      action,
      mutating: true,
      mode,
      projectId: projectId ?? null,
      taskId: taskId ?? null,
      payload,
      perform,
      shadowResult,
      describeResult,
    });
    return outcome.result;
  };

  // ── Provider reads used by several methods ─────────────────────────────────

  const parse = <TSchema extends z.ZodType>(schema: TSchema, value: unknown, action: string) =>
    parseProviderData(schema, value, { provider: PROVIDER_ID, action });

  const fetchIssue = async (key: string, fields: string, action: string) =>
    parse(
      jiraIssueWithUpdatedSchema,
      await client.send({
        method: 'GET',
        path: `issue/${encodeURIComponent(key)}`,
        query: { fields },
        action,
      }),
      action,
    );

  const fetchCommentPage = async (
    key: string,
    action: string,
    page: {
      readonly size: number;
      readonly orderBy: 'created' | '-created';
      /** The page offset; omitted for the first page, so `readTicket`'s request is unchanged. */
      readonly startAt?: number;
    },
  ) =>
    parse(
      jiraCommentPageSchema,
      await client.send({
        method: 'GET',
        path: `issue/${encodeURIComponent(key)}/comment`,
        query: {
          ...(page.startAt === undefined || page.startAt === 0 ? {} : { startAt: page.startAt }),
          maxResults: page.size,
          orderBy: page.orderBy,
        },
        action,
      }),
      action,
    );

  /**
   * {@link READ_TICKET_COMMENT_PAGE}: the newest page, cut to its size, oldest first — and the
   * thread's `total`, so the port can say the page was not the whole thread (WP-83, backlog 290).
   */
  const fetchNewestComments = async (key: string, action: string) => {
    const page = await fetchCommentPage(key, action, {
      size: READ_TICKET_COMMENT_PAGE,
      orderBy: '-created',
    });
    const comments = [...page.comments].slice(0, READ_TICKET_COMMENT_PAGE).reverse();
    return { comments, total: commentTotalOf(page.total, page.comments.length) };
  };

  const fetchRemoteLinks = async (key: string, action: string) =>
    parse(
      remoteLinksSchema,
      await client.send({
        method: 'GET',
        path: `issue/${encodeURIComponent(key)}/remotelink`,
        action,
      }),
      action,
    );

  /** The account this binding authenticates as. One request per adapter, then remembered. */
  let selfAccountId: string | null = null;
  const fetchSelf = async (action: string) => {
    const myself = parse(
      jiraUserSchema,
      await client.send({ method: 'GET', path: 'myself', action }),
      action,
    );
    selfAccountId = myself.accountId ?? null;
    return myself;
  };
  /**
   * The account id, or a loud failure — never `null` (standing rule 16).
   *
   * `accountId` is optional in every user shape Jira publishes, so a response without one is a
   * state an untrusted producer can put this adapter in. Answering `null` would make the author
   * check compare against nothing, and the check is the only thing standing between a marker a
   * human typed and the platform editing that person's comment. This throws instead, from inside
   * the executor's `perform`, so the failure is audited and scrubbed like any other.
   */
  const requireSelfAccountId = async (action: string): Promise<string> => {
    if (selfAccountId === null) {
      await fetchSelf(action);
    }
    if (selfAccountId === null) {
      throw new IntegrationError(
        'invalid_response',
        PROVIDER_ID,
        'GET /myself carried no accountId, so this binding cannot tell its own comments from anyone else’s',
        { action },
      );
    }
    return selfAccountId;
  };

  /**
   * The comment carrying `markerId` **and written by this binding's own account** (see docblock),
   * searched oldest first, page by page, until a page comes back **empty** — and at most
   * {@link MARKER_SEARCH_MAX_PAGES} pages, the empty one included, past which it **fails** rather
   * than answering `null` (WP-111, backlog 288). `null` is returned only after an empty page whose
   * offset is not short of a usable `total`; `total` alone never ends the search (backlog 377).
   *
   * **Residual, stated:** offsets are positions in a list that can move under the search. A comment
   * written meanwhile is appended at the end and moves nothing; a comment **deleted** from a page
   * already read shifts every later one back by one, so the comment at the next page's first offset
   * is skipped once. A retry reads the thread again.
   */
  const findMarkedComment = async (
    key: string,
    markerId: string,
    action: string,
  ): Promise<JiraComment | null> => {
    const accountIdRead = requireSelfAccountId(action);
    let startAt = 0;
    for (let pages = 0; pages < MARKER_SEARCH_MAX_PAGES; pages += 1) {
      const [page, accountId] = await Promise.all([
        fetchCommentPage(key, action, { size: MARKER_SEARCH_PAGE, orderBy: 'created', startAt }),
        accountIdRead,
      ]);
      for (const comment of page.comments) {
        const marked = markerId === markerIdOfComment(comment);
        if (marked && comment.author?.accountId === accountId) {
          return comment;
        }
      }
      if (page.comments.length === 0) {
        const total = usableTotal(page.total);
        if (total !== null && startAt < total) {
          throw new JiraMarkerSearchBoundError(
            action,
            `read an empty page at offset ${startAt} of a thread Jira counts as ${total} comments`,
          );
        }
        return null;
      }
      startAt += page.comments.length;
    }
    throw new JiraMarkerSearchBoundError(
      action,
      `read ${MARKER_SEARCH_MAX_PAGES} pages (the bound, MARKER_SEARCH_MAX_PAGES) and ${startAt} comments without reaching an empty page`,
    );
  };

  const commentRefOf = (
    key: string,
    comment: JiraComment,
    markerId: string | null,
  ): CommentRef => ({
    provider: PROVIDER_ID,
    ticket_key: key,
    comment_id: comment.id,
    url: commentUrl(siteUrl, key, comment.id),
    marker_id: markerId,
  });

  // ── The port ───────────────────────────────────────────────────────────────

  const readTicket = async (ticketRef: TicketRefInput): Promise<Ticket> => {
    const key = ticketRef.key;
    return read('read_ticket', jsonPayload({ ticket_key: key }), async () => {
      const action = 'read_ticket';
      const issue = await fetchIssue(key, FIELDS_FOR_TICKET, action);
      const [commentPage, remoteLinks] = await Promise.all([
        fetchNewestComments(key, action),
        fetchRemoteLinks(key, action),
      ]);
      const parentKey = issue.fields.parent?.key ?? null;
      const epic =
        parentKey === null
          ? null
          : await (async () => {
              const parent = await fetchIssue(parentKey, 'summary,description', action);
              return {
                key: parentKey,
                title: parent.fields.summary ?? '',
                description: adfDescription(parent.fields.description),
              };
            })();
      const siblings = parentKey === null ? [] : await fetchSiblings(parentKey, key, action);
      const mapped = toTicket({
        issue,
        siteUrl,
        comments: commentPage.comments,
        commentTotal: commentPage.total,
        remoteLinks,
        epic,
        siblings,
      });
      // The mapping is ours, but every value in it came from Jira: a timestamp Jira invented or a
      // field it dropped fails here, at the ring boundary, rather than three layers up (BD-022).
      return parse(ticketSchema, mapped, action);
    });
  };

  const fetchSiblings = async (
    parentKey: string,
    selfKey: string,
    action: string,
  ): Promise<readonly { key: string; title: string; state: string }[]> => {
    const result = parse(
      jiraSearchResultSchema,
      await client.send({
        method: 'GET',
        path: 'search/jql',
        query: {
          jql: `parent = ${jqlLiteral(parentKey)} AND key != ${jqlLiteral(selfKey)} ORDER BY created ASC`,
          fields: 'summary,status',
          maxResults: 50,
        },
        action,
      }),
      action,
    );
    return result.issues.map((issue) => ({
      key: issue.key,
      title: issue.fields.summary ?? '',
      state: issue.fields.status?.name ?? 'Unknown',
    }));
  };

  /** One search, following `nextPageToken` up to `limit` (WP-87 review round 2). */
  const searchUpTo = async (jql: string, limit: number): Promise<TicketMatch[]> => {
    const action = 'match_tickets';
    /**
     * Up to `limit` matches, **following `nextPageToken`** (WP-87 review round 2): the poller widens
     * a page to reach past a bulk edit (`TICKET_POLL_MAX_LIMIT`), and Jira may return fewer issues
     * per page than `maxResults` asks for ({@link MATCH_PAGE_MAX}), so one request is not "up to
     * `limit`". Each request asks for at most
     * {@link MATCH_PAGE_MAX}; the loop ends at `limit`, at `isLast`, at a page with no token, or at
     * an empty page — never on a token alone, so a provider that kept answering one cannot spin it.
     */
    const found: TicketMatch[] = [];
    let pageToken: string | null = null;
    for (;;) {
      const result: z.infer<typeof jiraSearchResultSchema> = parse(
        jiraSearchResultSchema,
        await client.send({
          method: 'GET',
          path: 'search/jql',
          query: {
            jql,
            fields: FIELDS_FOR_MATCH,
            maxResults: Math.min(limit - found.length, MATCH_PAGE_MAX),
            ...(pageToken === null ? {} : { nextPageToken: pageToken }),
          },
          action,
        }),
        action,
      );
      found.push(...result.issues.map((issue) => toTicketMatch(issue, siteUrl)));
      const next: string | null = result.nextPageToken ?? null;
      if (
        found.length >= limit ||
        result.isLast === true ||
        next === null ||
        result.issues.length === 0
      ) {
        return found.slice(0, limit);
      }
      pageToken = next;
    }
  };

  const matchTickets = async (
    rule: TicketMatchRule,
    matchOptions?: { readonly since?: string | null; readonly limit?: number },
  ): Promise<readonly TicketMatch[]> => {
    const limit = matchOptions?.limit ?? 50;
    const since = matchOptions?.since ?? null;
    const jql = buildJql(rule, since, options.clock.now());
    return read('match_tickets', jsonPayload({ jql, limit }), async () => {
      let current = rule;
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await searchUpTo(buildJql(current, since, options.clock.now()), limit);
        } catch (error) {
          // WP-110 review round 1: a `keys` rule naming a ticket that no longer exists. Atlassian
          // documents that search *"responds HTTP 400 'Bad Request' if the JQL query makes explicit
          // reference to inexistent entities, like a specific Issue Key"*, with the message *"An
          // issue with key 'KANBAN-123456789' does not exist for field 'key'."*
          // (https://support.atlassian.com/jira/kb/how-to-handle-http-400-bad-request-errors-on-jira-search-rest-api-endpoint/,
          // retrieved 2026-10-01 — a Data Center `/rest/api/2/search` article; that Cloud's
          // `search/jql` answers the same is **inferred**, stated in the fixture). One deleted ticket
          // of a live task would otherwise fail every live read of the binding: the keys the error
          // names are dropped and the search asked again, at most {@link MISSING_KEY_RETRIES} times
          // (the error text is cut at 300 characters, so one error names a handful of keys).
          if (current.kind !== 'keys' || attempt >= MISSING_KEY_RETRIES) {
            throw error;
          }
          const missing = missingIssueKeysIn(error, current.keys);
          if (missing.length === 0) {
            throw error;
          }
          const remaining = current.keys.filter((key) => !missing.includes(key));
          if (remaining.length === 0) {
            return [];
          }
          current = { kind: 'keys', keys: remaining };
        }
      }
    });
  };

  const transition = async (
    ticketRef: TicketRefInput,
    targetStatusName: string,
    fields?: Readonly<Record<string, unknown>>,
  ): Promise<TransitionResult> => {
    if (fields !== undefined && Object.keys(fields).length > 0) {
      // `capabilities().customFields` is false. Forwarding fields this adapter cannot validate
      // against the transition screen turns a caller's mistake into an opaque Jira 400.
      throw new IntegrationUnsupportedError(PROVIDER_ID, 'fields on a transition');
    }
    const key = ticketRef.key;
    /**
     * The whole resolution — including the refusal — happens **inside** the executor's `perform`.
     *
     * The refusal quotes the provider's own status names back to the caller, and TD-012 requires
     * every error carrying provider text to leave the integration layer through the executor's
     * single scrubbing `catch`. Deciding it out here and throwing after the action returned would
     * go around that choke point, which is precisely what WP-08 review round 1 found. `target`
     * being `null` therefore means one thing only — the ticket is already in the target status —
     * because the other way of having no transition is the throw.
     */
    const resolved = await read(
      'resolve_transition',
      jsonPayload({ ticket_key: key, target_status: targetStatusName }),
      async (): Promise<{ readonly from: string; readonly target: JiraTransition | null }> => {
        const action = 'resolve_transition';
        const issue = await fetchIssue(key, 'status', action);
        const listed = parse(
          jiraTransitionsSchema,
          await client.send({
            method: 'GET',
            path: `issue/${encodeURIComponent(key)}/transitions`,
            action,
          }),
          action,
        );
        const from = issue.fields.status?.name ?? 'Unknown';
        if (equalsStatus(from, targetStatusName)) {
          // product/08: "transition only if not already there".
          return { from, target: null };
        }
        const found = resolveTransition(listed.transitions, targetStatusName);
        if (found === null) {
          throw new IntegrationError(
            'invalid_request',
            PROVIDER_ID,
            `${key} has no transition to "${targetStatusName}"; available from "${from}": ` +
              `${describeTargets(listed.transitions)}`,
            { action },
          );
        }
        return { from, target: found };
      },
      (result) => ({ from: result.from, transition_id: result.target?.id ?? null }),
    );

    const target = resolved.target;
    if (target === null) {
      // Already there. No mutating action is recorded, because none was decided on.
      return { changed: false, from: resolved.from, to: targetStatusName };
    }

    return mutate<TransitionResult>(
      'transition',
      jsonPayload({
        ticket_key: key,
        from: resolved.from,
        to: targetStatusName,
        transition_id: target.id,
      }),
      async () => {
        await client.send({
          method: 'POST',
          path: `issue/${encodeURIComponent(key)}/transitions`,
          body: { transition: { id: target.id } },
          action: 'transition',
        });
        return { changed: true, from: resolved.from, to: targetStatusName };
      },
      // Shadow mode changed nothing, and says so. What it *would* have done is the audit row.
      () => ({ changed: false, from: resolved.from, to: targetStatusName }),
      (result) => ({ changed: result.changed, from: result.from, to: result.to }),
    );
  };

  const upsertWorkpad = async (
    ticketRef: TicketRefInput,
    markerId: string,
    markdown: string,
  ): Promise<CommentRef> => {
    const key = ticketRef.key;
    const existing = await read(
      'read_workpad',
      jsonPayload({ ticket_key: key, marker_id: markerId }),
      () => findMarkedComment(key, markerId, 'read_workpad'),
      (comment) => ({ found: comment !== null, comment_id: comment?.id ?? null }),
    );
    const document = markdownToAdfDocument(markdown, { markerId });

    return mutate<CommentRef>(
      'upsert_workpad',
      jsonPayload({ ticket_key: key, marker_id: markerId, comment_id: existing?.id ?? null }),
      async () => {
        const action = 'upsert_workpad';
        const path =
          existing === null
            ? `issue/${encodeURIComponent(key)}/comment`
            : `issue/${encodeURIComponent(key)}/comment/${encodeURIComponent(existing.id)}`;
        const saved = parse(
          jiraCommentSchema,
          await client.send({
            method: existing === null ? 'POST' : 'PUT',
            path,
            body: { body: document },
            action,
          }),
          action,
        );
        return commentRefOf(key, saved, markerId);
      },
      () => ({
        provider: PROVIDER_ID,
        ticket_key: key,
        comment_id: existing?.id ?? 'shadow',
        url: null,
        marker_id: markerId,
      }),
      (result) => ({ comment_id: result.comment_id, edited: existing !== null }),
    );
  };

  const addComment = async (
    ticketRef: TicketRefInput,
    markdown: string,
    commentOptions?: { readonly markerId?: string | null },
  ): Promise<CommentRef> => {
    const key = ticketRef.key;
    const markerId = commentOptions?.markerId ?? null;
    if (markerId !== null) {
      // A marked comment is a question or a linter report: posting it twice notifies twice.
      const existing = await read(
        'read_marked_comment',
        jsonPayload({ ticket_key: key, marker_id: markerId }),
        () => findMarkedComment(key, markerId, 'read_marked_comment'),
        (comment) => ({ found: comment !== null }),
      );
      if (existing !== null) {
        return commentRefOf(key, existing, markerId);
      }
    }
    const document = markdownToAdfDocument(markdown, { markerId });

    return mutate<CommentRef>(
      'add_comment',
      jsonPayload({ ticket_key: key, marker_id: markerId }),
      async () => {
        const action = 'add_comment';
        const saved = parse(
          jiraCommentSchema,
          await client.send({
            method: 'POST',
            path: `issue/${encodeURIComponent(key)}/comment`,
            body: { body: document },
            action,
          }),
          action,
        );
        return commentRefOf(key, saved, markerId);
      },
      () => ({
        provider: PROVIDER_ID,
        ticket_key: key,
        comment_id: 'shadow',
        url: null,
        marker_id: markerId,
      }),
      (result) => ({ comment_id: result.comment_id }),
    );
  };

  const setLabels = async (
    ticketRef: TicketRefInput,
    add: readonly string[],
    remove: readonly string[],
  ): Promise<readonly string[]> => {
    const key = ticketRef.key;
    const current = await read(
      'read_labels',
      jsonPayload({ ticket_key: key }),
      async () => (await fetchIssue(key, 'labels', 'read_labels')).fields.labels ?? [],
      (labels) => ({ label_count: labels.length }),
    );
    const next = new Set(current);
    for (const label of add) {
      next.add(label);
    }
    for (const label of remove) {
      next.delete(label);
    }
    const wanted = [...next];
    if (sameLabels(current, wanted)) {
      // Nothing to do, so nothing is sent — and no mutating row claims otherwise.
      return wanted;
    }

    return mutate<readonly string[]>(
      'set_labels',
      jsonPayload({ ticket_key: key, add: [...add], remove: [...remove] }),
      async () => {
        const action = 'set_labels';
        await client.send({
          method: 'PUT',
          path: `issue/${encodeURIComponent(key)}`,
          body: {
            update: {
              labels: [
                ...add.filter((label) => !current.includes(label)).map((label) => ({ add: label })),
                ...remove
                  .filter((label) => current.includes(label))
                  .map((label) => ({ remove: label })),
              ],
            },
          },
          action,
        });
        // The edit returns 204 with no body, so the result is read back rather than assumed.
        return (await fetchIssue(key, 'labels', action)).fields.labels ?? [];
      },
      () => wanted,
      (labels) => ({ labels: [...labels] }),
    );
  };

  const linkMergeRequest = async (ticketRef: TicketRefInput, mrUrl: string): Promise<void> => {
    const key = ticketRef.key;
    // Atlassian: "If a `globalId` is provided and a remote issue link with that global ID is found
    // it is updated … Otherwise, the remote issue link is created." That is the whole idempotency.
    const globalId = `agentic-merge-request=${mrUrl}`;
    await mutate<void>(
      'link_merge_request',
      jsonPayload({ ticket_key: key, mr_url: mrUrl }),
      async () => {
        await client.send({
          method: 'POST',
          path: `issue/${encodeURIComponent(key)}/remotelink`,
          body: {
            globalId,
            relationship: 'merge request',
            object: { url: mrUrl, title: mrUrl },
          },
          action: 'link_merge_request',
        });
      },
      () => undefined,
      () => ({ global_id: globalId }),
    );
  };

  const createTicket = async (draft: TicketDraft): Promise<TicketRefInput> =>
    mutate<TicketRefInput>(
      'create_ticket',
      jsonPayload({
        project_key: draft.project_key,
        issue_type: draft.issue_type,
        title: draft.title,
      }),
      async () => {
        const action = 'create_ticket';
        const created = parse(
          jiraCreatedIssueSchema,
          await client.send({
            method: 'POST',
            path: 'issue',
            body: {
              fields: {
                project: { key: draft.project_key },
                issuetype: { name: draft.issue_type },
                summary: draft.title,
                ...(draft.description.trim().length === 0
                  ? {}
                  : { description: markdownToAdfDocument(draft.description) }),
                labels: [...draft.labels],
                ...(draft.parent_key === null || draft.parent_key === undefined
                  ? {}
                  : { parent: { key: draft.parent_key } }),
                ...(draft.priority === null || draft.priority === undefined
                  ? {}
                  : { priority: { name: draft.priority } }),
              },
            },
            action,
          }),
          action,
        );
        return { provider: PROVIDER_ID, key: created.key, url: issueUrl(siteUrl, created.key) };
      },
      () => ({
        provider: PROVIDER_ID,
        // Obviously not a real key: a shadow task must not be able to pretend it filed a ticket.
        key: `${draft.project_key}-SHADOW`,
        url: issueUrl(siteUrl, `${draft.project_key}-SHADOW`),
      }),
      (created) => ({ key: created.key }),
    );

  const resolveIdentity = async (query: {
    readonly providerUserId?: string;
    readonly email?: string;
  }): Promise<ExternalIdentity | null> => {
    if (query.providerUserId !== undefined) {
      return read(
        'resolve_identity',
        jsonPayload({ account_id: query.providerUserId }),
        async () => {
          const action = 'resolve_identity';
          try {
            const user = parse(
              jiraUserSchema,
              await client.send({
                method: 'GET',
                path: 'user',
                query: { accountId: query.providerUserId },
                action,
              }),
              action,
            );
            return identityOfUser(user);
          } catch (error) {
            if (error instanceof IntegrationError && error.code === 'not_found') {
              return null;
            }
            throw error;
          }
        },
      );
    }
    if (query.email === undefined) {
      return null;
    }
    const email = query.email;
    return read('resolve_identity', jsonPayload({ email_query: true }), async () => {
      const action = 'resolve_identity';
      const users = parse(
        usersSchema,
        await client.send({ method: 'GET', path: 'user/search', query: { query: email }, action }),
        action,
      );
      const exact = users.find((user) => user.emailAddress?.toLowerCase() === email.toLowerCase());
      if (exact !== undefined) {
        return identityOfUser(exact);
      }
      // A site that hides email addresses (the GDPR default, and what Atlassian's own example
      // response shows) returns matches with no `emailAddress` at all. One match for a full
      // address is that account; two would be a prefix match on a display name, and guessing
      // between them is how the platform would attribute an answer to the wrong human (BD-022).
      return users.length === 1 ? identityOfUser(users[0] as z.infer<typeof jiraUserSchema>) : null;
    });
  };

  const testConnection = async (): Promise<HealthProbe> => {
    const checkedAt = options.clock.now();
    try {
      const myself = await read('test_connection', jsonPayload({}), () =>
        fetchSelf('test_connection'),
      );
      return {
        ok: true,
        detail: safeDetail(
          redactor,
          `authenticated as ${myself.displayName ?? myself.accountId ?? 'an unnamed account'}`,
        ),
        checked_at: checkedAt,
        // `GET /myself` reports no token expiry, and `null` means "unknown", not "never expires".
        token_expires_at: null,
      };
    } catch (error) {
      // A probe reports; it does not throw. The message is provider text on its way to a settings
      // screen and to `integrations.health`, so it goes through this binding's redactor first —
      // the obligation `HealthProbe.detail` states, discharged here (TD-012).
      return {
        ok: false,
        detail: safeDetail(redactor, error instanceof Error ? error.message : String(error)),
        checked_at: checkedAt,
        token_expires_at: null,
      };
    }
  };

  const pickup: JiraPickupRule = pickupRuleOf(config);

  /**
   * The poller's plan (WP-87): the webhook's own pick-up rule, so a polled match and a webhook match
   * mean one thing, at the binding's interval. `null` when polling is off — the default — or when it
   * is on with no pick-up rule, because a poll for nothing is a read a minute for no answer.
   */
  const pollPlan = (): TicketPollPlan | null => {
    if (!config.poll_enabled || pickup.kind === 'none') {
      return null;
    }
    return {
      rule:
        pickup.kind === 'label'
          ? { kind: 'label', label: pickup.label }
          : { kind: 'status', status: pickup.status },
      interval_seconds: config.poll_interval_seconds,
    };
  };

  const inbound = createJiraInboundNormaliser({
    siteUrl,
    projectKeys: config.project_keys,
    pickup,
    // The inbound half. A delivery is not a response, so it never crosses `client.ts`: without
    // this line a comment carrying this binding's own webhook secret would be written to
    // `events.payload` verbatim (BD-003: append-only, so it cannot be fixed later).
    redactor,
    // A binding with no webhook secret cannot verify anything, and `verifyJiraDelivery` says so
    // by rejecting every delivery when the secret is absent — not by hashing with an empty key,
    // which is a key the sender owns as well (see `webhook.ts`, "No secret means reject").
    secret: config.webhook_secret ?? null,
    clock: options.clock,
    maxAgeMs: config.webhook_max_age_ms,
  });

  return {
    ref,
    capabilities: () => ({ ...capabilities }),
    testConnection,
    readTicket,
    matchTickets,
    pollPlan,
    transition,
    upsertWorkpad,
    addComment,
    setLabels,
    linkMergeRequest,
    createTicket,
    resolveIdentity,
    // One guard, not two (standing rule 9). Round 1 wrapped `verify` in `capabilities.webhooks &&`
    // while the verifier itself accepted anything signed with the empty key: deleting the wrapper
    // killed no test, because the wrapper was the only thing working. Both facts are derived from
    // the same one — does this binding hold a webhook secret — so the authority is
    // `verifyJiraDelivery`, and `capabilities().webhooks` is the *declaration* of what it will do.
    // The contract test pins them together: secret ⇒ webhooks true and an authentic delivery
    // verifies; no secret ⇒ webhooks false and nothing verifies, forgeries included.
    inbound,
  };
};

// ── Pure helpers, exported for their own tests ───────────────────────────────

/**
 * How many times a `keys` search drops the keys Jira said do not exist and asks again (WP-110 review
 * round 1). Each refusal names at most a handful of keys (the error text is cut at 300 characters),
 * so three retries reach past roughly a dozen deleted tickets in one read; past that the read fails
 * and the poller fails it open, as before.
 */
export const MISSING_KEY_RETRIES = 3;

/**
 * The keys of `asked` that a `400` names as missing — *"An issue with key 'X' does not exist for
 * field 'key'."* — and nothing else: a key the error mentions that was not asked for is ignored, so
 * provider text can only ever narrow the platform's own list.
 */
export const missingIssueKeysIn = (error: unknown, asked: readonly string[]): string[] => {
  if (!(error instanceof IntegrationError) || error.code !== 'invalid_request') {
    return [];
  }
  const named = new Set(
    [...error.message.matchAll(/An issue with key '([^']+)' does not exist/g)].map(
      (match) => match[1] ?? '',
    ),
  );
  return asked.filter((key) => named.has(key));
};

/** A single-quoted-free JQL string literal: `"` and `\` are escaped, per JQL's own rules. */
export const jqlLiteral = (value: string): string =>
  `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * The JQL for one pick-up rule, with the polling window as a **relative** bound.
 *
 * `updated >= "-15m"` rather than an absolute literal, and that is not a style choice: Atlassian
 * documents absolute JQL dates as being read "relative to your configured time zone" (JQL fields
 * reference, retrieved 2026-09-10), so an absolute `since` would silently shift by the site's
 * offset and skip tickets. The relative form has no zone. Minutes are rounded **up**, so the
 * window always covers the requested instant, and never fall below one minute.
 */
export const buildJql = (rule: TicketMatchRule, since: string | null, now: string): string => {
  const clause = (() => {
    switch (rule.kind) {
      case 'label':
        return `labels = ${jqlLiteral(rule.label)}`;
      case 'status':
        return `status = ${jqlLiteral(rule.status)}`;
      case 'epic':
        // `parent` "works for both team-managed and company-managed spaces" (JQL fields reference).
        return `parent = ${jqlLiteral(rule.epic_key)}`;
      case 'query':
        return `(${rule.query})`;
      case 'keys':
        // WP-110 (backlog 298): the live tasks' tickets, whatever the pick-up rule says. Each key
        // is a JQL string literal, so a key is never JQL (`key in (…)`, the JQL fields reference).
        return `key in (${rule.keys.map(jqlLiteral).join(', ')})`;
    }
  })();
  if (since === null) {
    return `${clause} ORDER BY updated ASC`;
  }
  const elapsedMs = Date.parse(now) - Date.parse(since);
  const minutes = Number.isFinite(elapsedMs) ? Math.max(1, Math.ceil(elapsedMs / 60_000)) : 1;
  return `${clause} AND updated >= "-${minutes}m" ORDER BY updated ASC`;
};

/** The rule a webhook announces a match with. See `jiraCloudConfigSchema` for why status wins. */
export const pickupRuleOf = (config: {
  readonly pickup_label?: string | null;
  readonly pickup_status?: string | null;
}): JiraPickupRule => {
  if (typeof config.pickup_status === 'string' && config.pickup_status.length > 0) {
    return { kind: 'status', status: config.pickup_status };
  }
  if (typeof config.pickup_label === 'string' && config.pickup_label.length > 0) {
    return { kind: 'label', label: config.pickup_label };
  }
  return { kind: 'none' };
};

/** Status names are compared case-insensitively; Jira treats them as display names. */
export const equalsStatus = (left: string, right: string): boolean =>
  left.trim().toLowerCase() === right.trim().toLowerCase();

/**
 * The transition that lands on `targetStatusName`, resolved at runtime.
 *
 * Transition ids are per project and per workflow, so nothing may be hard-coded; and the match is
 * on `to.name` — the **status** — not on the transition's own name, because a status mapping
 * (product/19 §6) names statuses and a workflow is free to call the transition anything
 * ("Close Issue" leading to "In Progress" is Atlassian's own example). A transition Jira reports
 * as unavailable is not offered.
 *
 * `isAvailable !== false` reads an **absent** flag as available, which is the third place in this
 * adapter where a missing value widens rather than narrows. It is deliberate and checked against
 * the source rather than assumed (OpenAPI document re-read at review round 2, `info.version`
 * `1001.0.0-SNAPSHOT-a6463b4310f8edea4a3e…`): `IssueTransition` has no `required` list at all, and
 * the published `getTransitions` example carries one transition with `isAvailable: true` and one
 * that omits the member entirely. Reading the omission as unavailable would refuse transitions
 * that work; reading it as available costs, at worst, a `400` from Jira — loud, audited, and not
 * a silent success.
 */
export const resolveTransition = (
  transitions: readonly JiraTransition[],
  targetStatusName: string,
): JiraTransition | null =>
  transitions.find(
    (transition) =>
      transition.isAvailable !== false &&
      typeof transition.to?.name === 'string' &&
      equalsStatus(transition.to.name, targetStatusName),
  ) ?? null;

export const describeTargets = (transitions: readonly JiraTransition[]): string => {
  const names = transitions
    .filter((transition) => transition.isAvailable !== false)
    .map((transition) => transition.to?.name)
    .filter((name): name is string => typeof name === 'string');
  return names.length === 0 ? '(none)' : names.map((name) => `"${name}"`).join(', ');
};

const sameLabels = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((label) => right.includes(label));

/** The marker lives in the comment body, which `adf.ts` knows how to read. */
const markerIdOfComment = (comment: JiraComment): string | null => adfMarkerId(comment.body);

const safeDetail = (secretRedactor: SecretRedactor, text: string): string => {
  const redacted = secretRedactor.redactText(text);
  return redacted.value.length > 300 ? `${redacted.value.slice(0, 300)}…` : redacted.value;
};

const adfDescription = (value: unknown): string => adfToMarkdown(value);

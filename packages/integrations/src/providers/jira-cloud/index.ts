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
  type CommentRef,
  type ExternalIdentity,
  exactSecretRedactor,
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
  type TicketRefInput,
  type TransitionResult,
  ticketSchema,
} from '@platform/application';
import type { Id, JsonObject, TaskMode } from '@platform/contracts';
import type { Clock } from '@platform/domain';
import * as z from 'zod';
import { adfMarkerId, adfToMarkdown, markdownToAdfDocument } from './adf.js';
import { createJiraClient, type JiraClient, type JiraClientOptions } from './client.js';
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
const MAX_COMMENTS = 100;

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
}

const jsonPayload = (fields: JsonObject): JsonObject => fields;

export const createJiraCloudTaskManagement = (options: JiraCloudOptions): TaskManagementPort => {
  const config = jiraCloudConfigSchema.parse(options.config);
  const ref: IntegrationRef = {
    integrationId: options.integrationId,
    provider: PROVIDER_ID,
    type: 'task_management',
  };
  const siteUrl = config.site_url.replace(/\/+$/, '');
  const client: JiraClient = createJiraClient({
    siteUrl,
    email: config.user_email,
    apiToken: config.api_token,
    timeoutMs: config.request_timeout_ms,
    now: () => Date.parse(options.clock.now()),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });

  /**
   * The redactor for text this adapter renders itself (the health probe).
   *
   * Built **from the binding's own secrets**, which is the path `docs/TODO.md` asks the first
   * provider work package to take rather than inventing a second one: a redactor assembled beside
   * a binding instead of from it is a redactor that does not know the token it is meant to hide.
   */
  const redactor: SecretRedactor = exactSecretRedactor([
    { name: 'jira_api_token', value: config.api_token },
    ...(config.webhook_secret === null || config.webhook_secret === undefined
      ? []
      : [{ name: 'jira_webhook_secret', value: config.webhook_secret }]),
  ]);

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

  const fetchComments = async (key: string, action: string): Promise<readonly JiraComment[]> =>
    parse(
      jiraCommentPageSchema,
      await client.send({
        method: 'GET',
        path: `issue/${encodeURIComponent(key)}/comment`,
        query: { maxResults: MAX_COMMENTS, orderBy: 'created' },
        action,
      }),
      action,
    ).comments;

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

  /** The comment carrying `markerId` **and written by this binding's own account** (see docblock). */
  const findMarkedComment = async (
    key: string,
    markerId: string,
    action: string,
  ): Promise<JiraComment | null> => {
    const [comments, accountId] = await Promise.all([
      fetchComments(key, action),
      requireSelfAccountId(action),
    ]);
    for (const comment of comments) {
      const marked = markerId === markerIdOfComment(comment);
      if (marked && comment.author?.accountId === accountId) {
        return comment;
      }
    }
    return null;
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
      const [comments, remoteLinks] = await Promise.all([
        fetchComments(key, action),
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
      const mapped = toTicket({ issue, siteUrl, comments, remoteLinks, epic, siblings });
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

  const matchTickets = async (
    rule: TicketMatchRule,
    matchOptions?: { readonly since?: string | null; readonly limit?: number },
  ): Promise<readonly TicketMatch[]> => {
    const limit = matchOptions?.limit ?? 50;
    const jql = buildJql(rule, matchOptions?.since ?? null, options.clock.now());
    return read('match_tickets', jsonPayload({ jql, limit }), async () => {
      const action = 'match_tickets';
      const result = parse(
        jiraSearchResultSchema,
        await client.send({
          method: 'GET',
          path: 'search/jql',
          query: { jql, fields: FIELDS_FOR_MATCH, maxResults: limit },
          action,
        }),
        action,
      );
      return result.issues.map((issue) => toTicketMatch(issue, siteUrl));
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

  const inbound = createJiraInboundNormaliser({
    siteUrl,
    projectKeys: config.project_keys,
    pickup,
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

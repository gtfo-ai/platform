/**
 * The Sentry adapter — `ObservabilityErrorsPort` for sentry.io and self-hosted instances (WP-11).
 *
 * ## What it is not
 *
 * It is **not** a place where retries, backoff or shadow mode live. `IntegrationActionExecutor`
 * owns those, and every outbound call in the product path goes through it (technical/06 §
 * "Outbound: actions"). `test/contract/integrations/sentry-executor.contract.test.ts` proves the
 * composition: `resolve` in shadow mode issues **zero** HTTP requests, and a recorded `429` with
 * `Retry-After` is waited out on the executor's injected timer.
 *
 * It is also not an inbound normaliser. The port's own docblock says why: product/08 lists
 * `error.issue.created` as optional and technical/02's catalogue has no such event, so a
 * normaliser would have nothing legal to emit.
 *
 * ## Divergences from real Sentry, stated rather than implied
 *
 * The fake's register has a dual for a real adapter: *the adapter must not be kinder than the
 * provider*. The fake at `packages/integrations/src/errors/fake.ts` lists two kindnesses — "no
 * quota and no retention window" — and both are real behaviours that live here.
 *
 *  1. **Retention is real: `getLatestEvent` returns `null` on a documented 404.** Sentry drops
 *     events after the plan's retention window while keeping the issue, so a live issue can have
 *     no latest event. The fake returns `null` only when nothing was seeded; this adapter reaches
 *     the same `null` from `GET …/events/latest/` answering `404`, and the contract runner drives
 *     it from a recorded 404 rather than from an empty seed.
 *  2. **Quota is real: a `429` becomes `IntegrationRateLimitedError`.** Sentry publishes
 *     `Retry-After` and `X-Sentry-Rate-Limit-Reset`; `http.ts` reads both, and the executor waits
 *     on its injected timer. No test here reaches a real quota — that is stated, not implied.
 *  3. **`comment` and `linkMergeRequest` are `false`, and refuse.** Sentry's published API
 *     reference (<https://docs.sentry.io/api/events/>, retrieved 2026-09-10) documents 21
 *     endpoints for Events & Issues and **none of them is a comment or a note**; the only comment
 *     surface Sentry publishes is the *inbound* `Sentry-Hook-Resource: comment` webhook. Nothing
 *     that would carry the platform's "fixed by !7" note is documented, so this adapter declares
 *     it cannot, rather than posting to an endpoint no vendor page names. Filed as Q43 with the
 *     recommendation implemented here; `resolve(inRelease)` is the documented way to tell Sentry a
 *     fix shipped.
 *  4. **`resolve` re-reads instead of trusting the `PUT` body.** The "Update an Issue" page
 *     documents the request parameters and a `200`, and publishes **no response example**. An
 *     adapter that mapped the unknown body would be guessing a shape; this one issues the `PUT`
 *     and then re-reads the issue it just changed, which is also what makes a second `resolve`
 *     idempotent without a special case.
 *  5. **`searchIssues({since})` filters on the client.** The documented project-issues endpoint
 *     publishes `statsPeriod`, `query`, `limit`, `cursor`, `sort` and `shortIdLookup` — no
 *     absolute time window, and `statsPeriod` selects the *stats* block rather than filtering. So
 *     `since` is applied to the mapped issues by `last_seen`. The cost is honest and bounded: the
 *     window narrows a page that Sentry already limited, so a `since` that excludes everything on
 *     the first page returns nothing rather than paging further.
 *  6. **A `limit` above `max_issues` is refused, not clamped.** Sentry itself refuses a limit over
 *     100 with a `400`, and a silently clamped answer to "show me the 500 newest issues" reads
 *     exactly like a complete one — the same defect the logs port's caps exist to prevent.
 *  7. **Every string that leaves this adapter is capped and redacted.** A stack trace is the most
 *     injection-prone text in the platform (the port says so) and the most likely place for a
 *     credential the application logged. Frames, breadcrumbs, tags and bytes are capped with a
 *     visible marker, and TD-012's redactor runs over every string before the cap, so a
 *     placeholder can never be cut in half. What this **cannot** do is remove a secret the
 *     platform never injected: `exactSecretRedactor` matches values it was handed, and it is not a
 *     pattern scanner (TD-012 steps 2 and 3 are WP-12's).
 *  8. **Untrusted text is data, never instruction.** Nothing here interprets a stack frame, a
 *     breadcrumb or a tag; the strings are carried to the port and the prompts present them
 *     delimited (BD-022). `searchIssues.query` is passed through verbatim and is never built from
 *     ticket text by this module.
 */
import {
  type AgentTooling,
  bindingSecretRedactor,
  composeSecretRedactors,
  type ErrorEvent,
  errorEventSchema,
  type HealthProbe,
  IntegrationError,
  type IntegrationRef,
  IntegrationUnsupportedError,
  type Issue,
  issueSchema,
  type ObservabilityErrorsCapabilities,
  type ObservabilityErrorsPort,
  parseProviderData,
  type SecretRedactor,
} from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import type { Clock } from '@platform/domain';
import { createSentryClient, type SentryClient } from './client.js';
import type { SentryConfig } from './config.js';
import { createSentryHttp, isUsableToken, SENTRY_PROVIDER_ID, type SentryFetch } from './http.js';
import {
  boundedIdentifier,
  capText,
  mapBreadcrumbs,
  mapCorrelationIds,
  mapIssueLevel,
  mapIssueStatus,
  mapTags,
  renderStackTrace,
  toIsoDateTime,
  type UnmappedSink,
} from './mapping.js';
import {
  type SentryBreadcrumb,
  type SentryEvent,
  type SentryExceptionValue,
  type SentryIssue,
  sentryBreadcrumbEntrySchema,
  sentryExceptionEntrySchema,
} from './schemas.js';

export interface SentryProviderOptions {
  readonly integrationId: Id;
  readonly config: SentryConfig;
  /** `{auth_token}` from the secret store. */
  readonly secrets: Readonly<Record<string, string>>;
  /** Injected so replay needs no HTTP interception; production passes `globalThis.fetch`. */
  readonly fetchImpl?: SentryFetch;
  /** Injected: `X-Sentry-Rate-Limit-Reset` is absolute, and a wall clock is a hardware assertion. */
  readonly clock: Clock;
  /**
   * TD-012, **required and never defaulted** (standing rule 31).
   *
   * It is applied in exactly one place — `http.ts`, over the parsed response document — so "every
   * provider string that leaves this ring" is a property of the construction rather than a list
   * this docblock has to keep in step with the mapper. Round 1 kept such a list, and it was already
   * wrong: `environment` read the unredacted `tags`, and `release` and `assigned_to` were not on it
   * at all. The adapter composes what it is handed with a redactor over its own auth token, so a
   * caller passing `noSecretsRedactor()` cannot disarm the one secret it is certain about.
   */
  readonly redactor: SecretRedactor;
  /** Where a redaction count is reported. Optional so a unit test can assert on it. */
  readonly onRedaction?: (event: { readonly action: string; readonly count: number }) => void;
  /** Where a vendor value this adapter does not know is reported (standing rule 20). */
  readonly onUnmapped?: UnmappedSink;
}

export type SentryProvider = ObservabilityErrorsPort;

/**
 * What an agent may be handed inside a run: **nothing**, and the reason is documentation rather
 * than caution (technical/06 § "Agent tooling exposure", BD-025).
 *
 * Sentry publishes three agent-facing surfaces and none of them has an environment contract this
 * platform can honour:
 *
 *  - the hosted MCP server at `https://mcp.sentry.dev/mcp` states "All connections use OAuth. The
 *    first connection will trigger an authentication flow" (retrieved 2026-09-10). A run container
 *    has no browser and `McpServerSpec` has no field for a value — by design, so that a provider
 *    wanting to ship a token has to change the type. Declaring it would be a promise the runner
 *    cannot keep;
 *  - the classic `sentry-cli` documents its environment (`SENTRY_AUTH_TOKEN`, `SENTRY_ORG`,
 *    `SENTRY_PROJECT`, `SENTRY_URL`) but **no issue commands at all**: its documented sections are
 *    releases, debug files, send-event, code mappings, logs, snapshots and crons
 *    (<https://docs.sentry.io/cli/>, retrieved 2026-09-10);
 *  - the new interactive CLI is announced on that same page and its documentation lives off the
 *    vendor's documentation site; nobody here has run it.
 *
 * WP-08 answered the same question the same way for Jira, and the instruction is explicit: if a
 * CLI's environment contract cannot be verified, declare nothing rather than guess. So the spec
 * mounts no CLI, no MCP server and no skill, and declares **no environment variable** — which the
 * shared contract suite now asserts positively: a spec that mounts nothing must expose no secret.
 * What the agent gets instead is the pre-fetched event, bounded and redacted, which is what Q16
 * ("Sentry/Loki in MVP: agent tooling + bug pre-fetch only") is really buying.
 */
export const SENTRY_AGENT_TOOLING: AgentTooling = {
  cli: null,
  mcp: null,
  skill: null,
  env: { variables: [] },
};

const CAPABILITIES: ObservabilityErrorsCapabilities = {
  search: true,
  comments: false,
  resolve: true,
  resolveInRelease: true,
  linkMergeRequest: false,
  mcp: false,
};

export const createSentryProvider = (options: SentryProviderOptions): SentryProvider => {
  const { config } = options;
  const token = options.secrets.auth_token ?? config.auth_token ?? null;
  const ref: IntegrationRef = {
    integrationId: options.integrationId,
    provider: SENTRY_PROVIDER_ID,
    type: 'errors',
  };
  /**
   * What the caller injected, plus this binding's own auth token (divergence 7, standing rule 31).
   *
   * The token is read from `secrets` or, if an operator put it there, from `config`; the redactor
   * is built from the **effective** value, because a redactor that does not know the credential the
   * adapter is actually sending is a redactor with a hole exactly where the audit log looks.
   */
  const redactor = composeSecretRedactors(
    options.redactor,
    bindingSecretRedactor([token === null ? null : { name: 'sentry_auth_token', value: token }]),
  );

  const client: SentryClient = createSentryClient({
    organization: config.organization,
    http: createSentryHttp({
      baseUrl: config.base_url,
      token,
      fetchImpl: options.fetchImpl ?? ((url, init) => globalThis.fetch(url, init)),
      timeoutMs: config.request_timeout_ms,
      clock: options.clock,
      // The choke point: every response body is redacted once, before a schema or a cap sees it.
      redactor,
      ...(options.onRedaction === undefined ? {} : { onRedaction: options.onRedaction }),
    }),
  });

  /**
   * The health probe's `detail`, redacted and then **bounded** — in that order.
   *
   * Redaction first, because everything this adapter renders itself quotes an `IntegrationError`
   * message and a probe is where an HTTP client quotes the request it made. Then the cap, because
   * redaction is the one transformation here that makes text *longer*: every occurrence of an
   * 8-byte secret becomes a 30-plus-byte `[REDACTED:integration:…]` placeholder, so a bound taken
   * before it is not a bound on what is emitted.
   *
   * The cap is not defence in depth. `healthProbeSchema.detail` is `z.string().nullish()` on its
   * way to `integrations.health` and a settings screen, and the failure path renders
   * `GET /organizations/<organization>/ answered 500` out of the binding's own `organization` —
   * which `slugSchema` constrains in shape and **not in length**. Found by enumerating the members
   * of `HealthProbe` rather than the call sites that cap things (standing rule 37); measured, and
   * asserted by `providers/emitted-bounds.test.ts` on both branches.
   */
  const redactDetail = (action: string, text: string): string => {
    const outcome = redactor.redactText(text);
    if (outcome.count > 0) {
      options.onRedaction?.({ action, count: outcome.count });
    }
    return capText(outcome.value, config.max_message_bytes, 'max_message_bytes');
  };

  /**
   * The issue's URL: Sentry's own `permalink`, or one built from the **already bounded** id.
   *
   * It takes the bounded id as an argument rather than bounding `issue.id` itself, which it did
   * until WP-11a review round 1. Two call sites bounding the same field is one guard too many in
   * the sense standing rule 22 names: deleting either left the other, so neither could be
   * mutation-checked, and `providers/emitted-bounds.test.ts` could not tell which one refused.
   * There is now exactly one `identifier(issue.id, …)` in this file, and a test that dies when it
   * goes.
   */
  const issueUrl = (issue: SentryIssue, boundedId: string): string =>
    issue.permalink ??
    `${config.base_url}/organizations/${config.organization}/issues/${boundedId}/`;

  /** A short provider string, bounded. Redaction already happened in `http.ts` (divergence 7). */
  const field = (value: string): string =>
    capText(value, config.max_field_bytes, 'max_field_bytes');

  /** An id, a slug or a URL: refused past the cap rather than truncated into a plausible one. */
  const identifier = (value: string, name: string, action: string): string =>
    boundedIdentifier(value, config.max_field_bytes, name, {
      provider: SENTRY_PROVIDER_ID,
      action,
    });

  /**
   * **Every field this adapter emits for an issue, and where each one comes from.**
   *
   * `issue` is the document `http.ts` already redacted, so the proof for the redaction half is
   * structural rather than a list of `redact.apply` calls that must all be remembered: there is no
   * other copy in scope. The cap half is per field — and the table is **executable**: a table in a
   * docblock is what three WP-11 rounds audited while `category` and `level` went out raw
   * (standing rule 37), so `providers/emitted-bounds.test.ts` drives every method of both adapters
   * from a hostile document, walks the answers, fails on any string past the largest named cap and
   * fails on any key that is not in its inventory.
   *
   * The `identifier` rows — four here, two more in `mapEvent` — are the half a walk cannot reach:
   * their bound is a **refusal**, so a hostile value never becomes an emitted string for the walk
   * to measure. Until WP-11a review round 1, deleting `identifier()` from `ref.short_id`,
   * `ref.url`, `project`, `event_id` or `issue_id` left all 758 tests green, and only `issue.id`
   * was covered anywhere (`test/contract/integrations/sentry.contract.test.ts`). Each of the six
   * now has a hostile document of its own asserting the `invalid_response` **and the field it
   * names**, one byte past the cap, with the same document at exactly the cap going through.
   *
   * | field | source | bound |
   * |---|---|---|
   * | `ref.provider` | constant | — |
   * | `ref.id` | `issue.id` | identifier, `max_field_bytes` |
   * | `ref.short_id` | `issue.shortId` | identifier, `max_field_bytes` |
   * | `ref.url` | `issue.permalink` or built from `issue.id` | identifier, `max_field_bytes` |
   * | `project` | `issue.project.slug` | identifier, `max_field_bytes` |
   * | `title` | `issue.title` | `max_message_bytes` + marker |
   * | `culprit` | `issue.culprit` | `max_message_bytes` + marker |
   * | `level` | `issue.level` | enum (`mapIssueLevel`) |
   * | `status` | `issue.status` | enum (`mapIssueStatus`) |
   * | `first_seen`, `last_seen` | `issue.firstSeen`/`lastSeen` | ISO-8601 or the clock |
   * | `count`, `user_count` | numbers | `issueSchema` |
   * | `assigned_to` | `issue.assignedTo.{name,email,id}` | `max_field_bytes` + marker |
   */
  const mapIssue = (issue: SentryIssue, action: string): Issue => {
    const now = options.clock.now();
    const assignedTo =
      issue.assignedTo?.name ?? issue.assignedTo?.email ?? issue.assignedTo?.id ?? null;
    const id = identifier(issue.id, 'issue.id', action);
    const mapped = {
      ref: {
        provider: SENTRY_PROVIDER_ID,
        id,
        short_id:
          issue.shortId === null || issue.shortId === undefined
            ? null
            : identifier(issue.shortId, 'issue.shortId', action),
        url: identifier(issueUrl(issue, id), 'issue.permalink', action),
      },
      project: identifier(issue.project?.slug ?? '', 'issue.project.slug', action),
      title: capText(issue.title ?? '', config.max_message_bytes, 'max_message_bytes'),
      culprit: capText(issue.culprit ?? '', config.max_message_bytes, 'max_message_bytes'),
      level: mapIssueLevel(issue.level, options.onUnmapped),
      status: mapIssueStatus(issue.status, options.onUnmapped),
      first_seen: toIsoDateTime(issue.firstSeen, now),
      last_seen: toIsoDateTime(issue.lastSeen, now),
      count: issue.count ?? 0,
      user_count: issue.userCount ?? null,
      assigned_to: assignedTo === null ? null : field(assignedTo),
    };
    // Parsed rather than cast: an issue with no project slug, or a permalink that is not a URL, is
    // an `invalid_response` at the boundary instead of an `undefined` three layers up (BD-022).
    return parseProviderData(issueSchema, mapped, { provider: SENTRY_PROVIDER_ID, action });
  };

  /**
   * `entries[]` is heterogeneous — `exception`, `breadcrumbs`, `request`, `message` — and this
   * adapter reads two kinds. An entry whose `data` does not match its schema is **skipped**, not
   * thrown on: reading an event is being told something (standing rule 20), and a shape Sentry
   * changes later must not turn every bug pre-fetch into a permanently failing job. The skip is
   * visible, because the port's `stack_trace` is then empty rather than wrong.
   */
  const exceptionValues = (event: SentryEvent): readonly SentryExceptionValue[] => {
    const entry = (event.entries ?? []).find((candidate) => candidate.type === 'exception');
    if (entry === undefined) {
      return [];
    }
    const parsed = sentryExceptionEntrySchema.safeParse(entry.data);
    return parsed.success ? (parsed.data.values ?? []) : [];
  };

  const breadcrumbValues = (event: SentryEvent): readonly SentryBreadcrumb[] => {
    const entry = (event.entries ?? []).find((candidate) => candidate.type === 'breadcrumbs');
    if (entry === undefined) {
      return [];
    }
    const parsed = sentryBreadcrumbEntrySchema.safeParse(entry.data);
    return parsed.success ? (parsed.data.values ?? []) : [];
  };

  /**
   * **Every field this adapter emits for an event, and where each one comes from.**
   *
   * There is exactly one `event` in scope and it is the redacted document (`http.ts`), which is the
   * structural answer to the review's second blocker: round 1 built `redactedTags` *and* kept the
   * raw `tags` beside it, and `environment` read the raw one — `"prod-FAKE-injected-secret-value"`
   * where `tags.environment` was `[REDACTED…]`. A pair is what makes that mistake possible, so
   * there is no longer a pair.
   *
   * | field | source | bound |
   * |---|---|---|
   * | `event_id` | `event.eventID` or `event.id` | identifier, `max_field_bytes` |
   * | `issue_id` | `event.groupID` or the requested id | identifier, `max_field_bytes` |
   * | `timestamp` | `event.dateCreated`/`dateReceived` | ISO-8601 or the clock |
   * | `stack_trace` | `entries[type=exception]` | `max_stack_frames`, `max_stack_trace_bytes` |
   * | `message` | `event.message` or `event.title` | `max_message_bytes` + marker |
   * | `breadcrumbs[].timestamp` | `crumb.timestamp` | ISO-8601 or the event's timestamp |
   * | `breadcrumbs[].message` | `crumb.message` | `max_breadcrumb_bytes` + marker |
   * | `breadcrumbs[].category`, `.level` | `crumb.category`/`.level` | `max_field_bytes` + marker |
   * | `breadcrumbs` (count) | `entries[type=breadcrumbs]` | `max_breadcrumbs` + a marker crumb |
   * | `tags` | `event.tags[]` | `max_tags`, `max_field_bytes` per name and value |
   * | `release` | `event.release.version` | `max_field_bytes` + marker |
   * | `environment` | `tags.environment` (the **capped** record above) | `max_field_bytes` |
   * | `correlation_ids` | `contexts.trace` + `CORRELATION_TAGS` | `max_field_bytes` per value |
   */
  const mapEvent = (event: SentryEvent, issueId: string): ErrorEvent => {
    const action = 'get_latest_event';
    const now = options.clock.now();
    const timestamp = toIsoDateTime(event.dateCreated ?? event.dateReceived, now);

    const rendered = renderStackTrace(exceptionValues(event), config.max_stack_frames);
    const tags = mapTags(event.tags ?? [], {
      maxTags: config.max_tags,
      maxBytes: config.max_field_bytes,
    });
    const release = event.release?.version ?? null;
    const environment = tags.environment ?? null;

    const mapped = {
      event_id: identifier(event.eventID ?? event.id ?? '', 'event.eventID', action),
      issue_id: identifier(event.groupID ?? issueId, 'event.groupID', action),
      timestamp,
      // Every cap below cuts text the redactor has already been over, which is what stops a cut
      // from splitting a `[REDACTED:…]` placeholder or leaving a fragment of a secret behind.
      stack_trace: capText(rendered.text, config.max_stack_trace_bytes, 'max_stack_trace_bytes'),
      message: capText(
        event.message ?? event.title ?? '',
        config.max_message_bytes,
        'max_message_bytes',
      ),
      breadcrumbs: mapBreadcrumbs(breadcrumbValues(event), {
        maxBreadcrumbs: config.max_breadcrumbs,
        maxBreadcrumbBytes: config.max_breadcrumb_bytes,
        // WP-11a: a crumb's `category` and `level` are provider text too, and were emitted raw.
        maxFieldBytes: config.max_field_bytes,
        fallbackTimestamp: timestamp,
      }),
      tags,
      release: release === null ? null : field(release),
      // `environment` is read out of the `tags` record above, which `mapTags` has already capped,
      // so this call is a **no-op** on that path — not, as round 1's annotation claimed, an
      // unreachable branch (standing rule 32: "I checked and it is benign" needs the same evidence
      // as a fix, and that claim was false). It was reachable and the two calls **disagreed**: the
      // same event carried `tags.environment` reporting "976 more bytes" and `environment`
      // reporting "58 more bytes", because a cap that appended its marker outside its own budget
      // re-cut its own marker on the second pass. `capText` now emits at most `maxBytes` and is
      // therefore idempotent, so this call is provably harmless rather than argued to be, and the
      // bound stays written down for the day `environment` is read from somewhere else.
      environment: environment === null ? null : field(environment),
      correlation_ids: mapCorrelationIds(event, tags, config.max_field_bytes),
    };
    return parseProviderData(errorEventSchema, mapped, {
      provider: SENTRY_PROVIDER_ID,
      action,
    });
  };

  const port: ObservabilityErrorsPort = {
    ref,
    capabilities: () => ({ ...CAPABILITIES }),

    testConnection: async (): Promise<HealthProbe> => {
      const checkedAt: IsoDateTime = options.clock.now();
      if (!isUsableToken(token)) {
        // Rule 18: an absent, empty or whitespace token is a refusal, and the probe says so
        // rather than reporting an anonymous request's 401 as if the token had expired.
        return {
          ok: false,
          checked_at: checkedAt,
          detail: 'no auth token is configured for this binding',
          token_expires_at: null,
        };
      }
      try {
        const organization = await client.getOrganization();
        return {
          ok: true,
          checked_at: checkedAt,
          // Redacted like every other provider string: a probe is where an HTTP client quotes the
          // request it made, credential included (`healthProbeSchema.detail`). Round 1 called
          // `report()` before `apply()` here, so the probe's own count was reported one call early.
          //
          // **And capped.** Found by the round-2 audit of "does anything else route around the
          // caps": `healthProbeSchema.detail` is `z.string().nullish()`, an organization name is
          // provider text, and this was the one success-path string in either adapter that no cap
          // bounded — on its way to `integrations.health` and a settings screen. Every error path
          // here builds its message out of the method, the path and the status, which are the
          // platform's own.
          detail: redactDetail(
            'test_connection',
            `Sentry organization ${field(organization.name ?? organization.slug)}`,
          ),
          // Sentry publishes no expiry on an auth token, so "unknown" is `null`, not "never".
          token_expires_at: null,
        };
      } catch (error) {
        const detail = redactDetail(
          'test_connection',
          error instanceof IntegrationError ? error.message : 'the probe failed',
        );
        return { ok: false, checked_at: checkedAt, detail, token_expires_at: null };
      }
    },

    getIssue: async (issueRef) => mapIssue(await client.getIssue(issueRef.id), 'get_issue'),

    getLatestEvent: async (issueRef): Promise<ErrorEvent | null> => {
      const event = await client.getLatestEvent(issueRef.id);
      return event === null ? null : mapEvent(event, issueRef.id);
    },

    searchIssues: async (request) => {
      const limit = request.limit ?? config.max_issues;
      if (!Number.isInteger(limit) || limit < 1) {
        throw new IntegrationError(
          'invalid_request',
          SENTRY_PROVIDER_ID,
          'limit must be a positive integer',
          { action: 'search_issues' },
        );
      }
      if (limit > config.max_issues) {
        throw new IntegrationError(
          'invalid_request',
          SENTRY_PROVIDER_ID,
          `limit ${limit} exceeds the ${config.max_issues} issue cap`,
          { action: 'search_issues' },
        );
      }
      const issues = await client.listProjectIssues({
        project: request.project,
        query: request.query,
        limit,
      });
      const mapped = issues.map((issue) => mapIssue(issue, 'search_issues'));
      const since = request.since ?? null;
      if (since === null) {
        return mapped;
      }
      const sinceMs = Date.parse(since);
      if (Number.isNaN(sinceMs)) {
        throw new IntegrationError(
          'invalid_request',
          SENTRY_PROVIDER_ID,
          'since must be an ISO-8601 instant',
          { action: 'search_issues' },
        );
      }
      return mapped.filter((issue) => Date.parse(issue.last_seen) >= sinceMs);
    },

    linkMergeRequest: async () => {
      throw new IntegrationUnsupportedError(SENTRY_PROVIDER_ID, 'merge request links');
    },

    comment: async () => {
      throw new IntegrationUnsupportedError(SENTRY_PROVIDER_ID, 'issue comments');
    },

    resolve: async (issueRef, resolveOptions) => {
      const inRelease = resolveOptions?.inRelease ?? null;
      await client.updateIssue(issueRef.id, {
        status: 'resolved',
        ...(inRelease === null ? {} : { statusDetails: { inRelease } }),
      });
      // Divergence 4: the documented `PUT` publishes no response body, so the state comes from a
      // read of the resource that was just changed rather than from a shape nobody documents.
      return mapIssue(await client.getIssue(issueRef.id), 'resolve');
    },

    agentTooling: () => SENTRY_AGENT_TOOLING,
  };

  return port;
};

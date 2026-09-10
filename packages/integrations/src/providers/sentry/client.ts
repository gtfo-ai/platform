/**
 * The five Sentry endpoints the `ObservabilityErrors` port needs, each parsed with
 * `parseProviderData` at the ring edge (BD-022).
 *
 * "Five" is the whole point of TD-024's "small typed clients … covering only the endpoints the
 * type contracts need": Sentry's Web API has hundreds, and every one this file does not name is
 * one nobody has to keep in step with a vendor release.
 *
 * Paths carry Sentry's **trailing slash**; its API 301-redirects a path without one, and a redirect
 * that `fetch` follows silently would make the replay transport's key not match the request that
 * was actually served.
 *
 * Sources, all retrieved 2026-09-10:
 *  - <https://docs.sentry.io/api/organizations/retrieve-an-organization/>
 *  - <https://docs.sentry.io/api/events/retrieve-an-issue/>
 *  - <https://docs.sentry.io/api/events/retrieve-an-issue-event/> (`event_id` may be `latest`)
 *  - <https://docs.sentry.io/api/events/list-a-projects-issues/>
 *  - <https://docs.sentry.io/api/events/update-an-issue/>
 */
import { parseProviderData } from '@platform/application';
import type { SentryHttp } from './http.js';
import { SENTRY_PROVIDER_ID } from './http.js';
import {
  type SentryEvent,
  type SentryIssue,
  sentryEventSchema,
  sentryIssueListSchema,
  sentryIssueSchema,
  sentryOrganizationSchema,
} from './schemas.js';

const context = (action: string) => ({ provider: SENTRY_PROVIDER_ID, action });

export interface SentryClient {
  getOrganization(): Promise<{ readonly slug: string; readonly name: string | null }>;
  getIssue(issueId: string): Promise<SentryIssue>;
  /** `null` when Sentry answers 404 — the issue exists but its events are past retention. */
  getLatestEvent(issueId: string): Promise<SentryEvent | null>;
  listProjectIssues(request: {
    readonly project: string;
    readonly query: string;
    readonly limit: number;
  }): Promise<readonly SentryIssue[]>;
  updateIssue(issueId: string, body: Readonly<Record<string, unknown>>): Promise<void>;
}

export interface SentryClientOptions {
  readonly http: SentryHttp;
  readonly organization: string;
}

/** Sentry's own path segments are already slugs; `encodeURIComponent` keeps a hostile one inert. */
const segment = (value: string): string => encodeURIComponent(value);

export const createSentryClient = (options: SentryClientOptions): SentryClient => {
  const org = segment(options.organization);

  return {
    getOrganization: async () => {
      const response = await options.http.request({
        method: 'GET',
        path: `/organizations/${org}/`,
        action: 'test_connection',
      });
      const parsed = parseProviderData(
        sentryOrganizationSchema,
        response?.body,
        context('test_connection'),
      );
      return { slug: parsed.slug, name: parsed.name ?? null };
    },

    getIssue: async (issueId) => {
      const response = await options.http.request({
        method: 'GET',
        path: `/organizations/${org}/issues/${segment(issueId)}/`,
        action: 'get_issue',
      });
      return parseProviderData(sentryIssueSchema, response?.body, context('get_issue'));
    },

    getLatestEvent: async (issueId) => {
      const response = await options.http.request({
        method: 'GET',
        path: `/organizations/${org}/issues/${segment(issueId)}/events/latest/`,
        action: 'get_latest_event',
        notFoundIsNull: true,
      });
      if (response === null) {
        return null;
      }
      return parseProviderData(sentryEventSchema, response.body, context('get_latest_event'));
    },

    listProjectIssues: async (request) => {
      const response = await options.http.request({
        method: 'GET',
        path: `/projects/${org}/${segment(request.project)}/issues/`,
        // `query` is always sent, even empty: omitting it makes Sentry apply its own documented
        // default of `is:unresolved`, and a caller that asked for "everything" would silently get
        // "everything unresolved". `statsPeriod=""` is the documented way to switch off the
        // timeline block, which this adapter never reads.
        query: { query: request.query, limit: request.limit, statsPeriod: '' },
        action: 'search_issues',
      });
      return parseProviderData(sentryIssueListSchema, response?.body, context('search_issues'));
    },

    updateIssue: async (issueId, body) => {
      await options.http.request({
        method: 'PUT',
        path: `/organizations/${org}/issues/${segment(issueId)}/`,
        json: body,
        action: 'resolve',
      });
    },
  };
};

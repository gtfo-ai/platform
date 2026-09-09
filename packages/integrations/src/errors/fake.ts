/**
 * `FakeObservabilityErrors` — the in-memory error tracker behind the ObservabilityErrors contract
 * suite and the bug template's Investigation pre-fetch (technical/06, product/08).
 *
 * The port's whole reason to exist is one flow: a bug ticket links a Sentry issue, the platform
 * fetches its latest event into the context pack, and on merge it comments on (and optionally
 * resolves) the issue. This fake implements exactly that flow plus search, and it deliberately
 * seeds an event whose stack trace contains instruction-shaped text, so the untrusted-data rule
 * (BD-022) is exercised by whatever consumes it rather than assumed.
 *
 * ## Known divergences from a real error tracker
 *
 * The rule: **a fake may be stricter than the real adapter, never kinder.**
 *
 *  1. **Stricter — `resolve` on an unknown issue is `not_found`.** Sentry answers 404 too; the
 *     point is that the fake does not silently succeed, which would let a "resolve on merge"
 *     handler pass while pointing at the wrong id.
 *  2. **Stricter — `searchIssues` understands three forms and refuses the rest** (`is:<status>`,
 *     `release:<name>`, or a plain substring of the title). Sentry's search is a language; a fake
 *     that returned everything for an unparsed query would make a broken saved search look like a
 *     healthy project.
 *  3. **Kinder, deliberately — no quota and no retention window.** A real tracker drops events
 *     after 30–90 days, so `getLatestEvent` can legitimately return `null` for a live issue; here
 *     it is `null` only when nothing was seeded. Handlers must still cope with `null`.
 *  4. **Kinder — no rate limits unless scripted.** Same reason as the other fakes: the executor
 *     owns rate limiting. The test that scripts a 429 here and drives it through the executor is
 *     `test/contract/integrations/action-executor.contract.test.ts` ("errors — comment").
 *  5. **Different — issue ids are `issue-<n>` and event ids are `event-<n>`**, where Sentry's are
 *     opaque and its short ids encode the project.
 */
import {
  type AgentTooling,
  type ErrorEvent,
  errorEventSchema,
  type HealthProbe,
  type IntegrationRef,
  IntegrationUnsupportedError,
  type Issue,
  issueSchema,
  type ObservabilityErrorsCapabilities,
  type ObservabilityErrorsPort,
} from '@platform/application';
import type { Id } from '@platform/contracts';
import {
  createFakeCore,
  type FakeCore,
  invalidRequest,
  notFound,
  snapshot,
} from '../support/fake-support.js';

const PROVIDER = 'fake-errors';

export interface FakeIssueSeed {
  readonly id?: string;
  readonly project: string;
  readonly title: string;
  readonly culprit?: string;
  readonly level?: Issue['level'];
  readonly status?: Issue['status'];
  readonly count?: number;
  readonly release?: string | null;
  /** The latest event. Omit for an issue whose events fell out of the retention window. */
  readonly latestEvent?: {
    readonly stackTrace: string;
    readonly message?: string;
    readonly breadcrumbs?: readonly { message: string; category?: string }[];
    readonly tags?: Readonly<Record<string, string>>;
    readonly correlationIds?: Readonly<Record<string, string>>;
  };
}

export interface FakeErrorsOptions {
  readonly integrationId: Id;
  readonly baseUrl?: string;
  readonly issues?: readonly FakeIssueSeed[];
  readonly capabilities?: Partial<ObservabilityErrorsCapabilities>;
}

interface StoredIssue {
  id: string;
  short_id: string;
  project: string;
  title: string;
  culprit: string;
  level: Issue['level'];
  status: Issue['status'];
  first_seen: string;
  last_seen: string;
  count: number;
  release: string | null;
  linked_mrs: string[];
  comments: { id: string; text: string }[];
  resolved_in_release: string | null;
  event: ErrorEvent | null;
}

export interface FakeObservabilityErrors extends ObservabilityErrorsPort {
  readonly core: FakeCore;
  seedIssue(seed: FakeIssueSeed): Issue;
  /** Raw stored issue, for assertions the port does not expose (links, comments). */
  peek(id: string): StoredIssue | undefined;
}

export const createFakeObservabilityErrors = (
  options: FakeErrorsOptions,
): FakeObservabilityErrors => {
  const ref: IntegrationRef = {
    integrationId: options.integrationId,
    provider: PROVIDER,
    type: 'errors',
  };
  const core = createFakeCore({ ref });
  const baseUrl = options.baseUrl ?? 'https://errors.example.test';
  const capabilities: ObservabilityErrorsCapabilities = {
    search: true,
    comments: true,
    resolve: true,
    resolveInRelease: true,
    linkMergeRequest: true,
    mcp: true,
    ...options.capabilities,
  };

  const issues = new Map<string, StoredIssue>();
  let issueCounter = 0;
  let eventCounter = 0;
  let commentCounter = 0;

  const seedIssue = (seed: FakeIssueSeed): Issue => {
    issueCounter += 1;
    const id = seed.id ?? `issue-${issueCounter}`;
    const at = core.clock.now();
    let event: ErrorEvent | null = null;
    if (seed.latestEvent !== undefined) {
      eventCounter += 1;
      event = errorEventSchema.parse({
        event_id: `event-${eventCounter}`,
        issue_id: id,
        timestamp: at,
        stack_trace: seed.latestEvent.stackTrace,
        message: seed.latestEvent.message ?? seed.title,
        breadcrumbs: (seed.latestEvent.breadcrumbs ?? []).map((crumb) => ({
          timestamp: at,
          category: crumb.category ?? null,
          level: 'info',
          message: crumb.message,
        })),
        tags: { ...(seed.latestEvent.tags ?? {}) },
        release: seed.release ?? null,
        environment: 'production',
        correlation_ids: { ...(seed.latestEvent.correlationIds ?? {}) },
      });
    }
    const stored: StoredIssue = {
      id,
      short_id: `FAKE-${issueCounter}`,
      project: seed.project,
      title: seed.title,
      culprit: seed.culprit ?? 'unknown',
      level: seed.level ?? 'error',
      status: seed.status ?? 'unresolved',
      first_seen: at,
      last_seen: at,
      count: seed.count ?? 1,
      release: seed.release ?? null,
      linked_mrs: [],
      comments: [],
      resolved_in_release: null,
      event,
    };
    issues.set(id, stored);
    return toIssue(stored);
  };

  const toIssue = (stored: StoredIssue): Issue =>
    issueSchema.parse({
      ref: {
        provider: PROVIDER,
        id: stored.id,
        short_id: stored.short_id,
        url: `${baseUrl}/issues/${stored.id}`,
      },
      project: stored.project,
      title: stored.title,
      culprit: stored.culprit,
      level: stored.level,
      status: stored.status,
      first_seen: stored.first_seen,
      last_seen: stored.last_seen,
      count: stored.count,
      user_count: null,
      assigned_to: null,
    });

  const requireIssue = (action: string, id: string): StoredIssue => {
    const issue = issues.get(id);
    if (issue === undefined) {
      throw notFound(PROVIDER, action, `issue ${id}`);
    }
    return issue;
  };

  for (const seed of options.issues ?? []) {
    seedIssue(seed);
  }

  const agentTooling = (): AgentTooling => ({
    cli: null,
    mcp: capabilities.mcp
      ? {
          name: 'fake-errors-mcp',
          transport: 'http',
          command: null,
          args: null,
          url: `${baseUrl}/mcp`,
          header_names: ['Authorization'],
          env: {
            variables: [
              {
                name: 'SENTRY_AUTH_TOKEN',
                secret: true,
                description: 'Read-only token the runner injects for the MCP server',
              },
            ],
          },
        }
      : null,
    skill: { id: 'errors-recipes', path: 'skills/errors' },
    env: {
      variables: [
        {
          name: 'SENTRY_AUTH_TOKEN',
          secret: true,
          description: 'Read-only token; never printed, never persisted (BD-025)',
        },
      ],
    },
  });

  return {
    core,
    ref,
    capabilities: () => ({ ...capabilities }),
    testConnection: async (): Promise<HealthProbe> => {
      core.enter('test_connection');
      return {
        ok: true,
        checked_at: core.clock.now(),
        detail: `${issues.size} issues seeded`,
        token_expires_at: null,
      };
    },

    getIssue: async (issueRef) => {
      core.enter('get_issue');
      return toIssue(requireIssue('get_issue', issueRef.id));
    },

    getLatestEvent: async (issueRef) => {
      core.enter('get_latest_event');
      const issue = requireIssue('get_latest_event', issueRef.id);
      return issue.event === null ? null : snapshot(issue.event);
    },

    searchIssues: async (request) => {
      core.enter('search_issues');
      if (!capabilities.search) {
        throw new IntegrationUnsupportedError(PROVIDER, 'issue search');
      }
      const query = request.query.trim();
      const limit = request.limit ?? 25;
      const inProject = [...issues.values()].filter((issue) => issue.project === request.project);
      const since = request.since ?? null;
      const recent = inProject.filter(
        (issue) => since === null || Date.parse(issue.last_seen) >= Date.parse(since),
      );

      if (query.length === 0) {
        return recent.slice(0, limit).map(toIssue);
      }
      const status = /^is:(\w+)$/.exec(query);
      if (status !== null) {
        const wanted = status[1];
        if (wanted !== 'unresolved' && wanted !== 'resolved' && wanted !== 'ignored') {
          throw invalidRequest(PROVIDER, 'search_issues', `unknown status "${wanted}"`);
        }
        return recent
          .filter((issue) => issue.status === wanted)
          .slice(0, limit)
          .map(toIssue);
      }
      const release = /^release:(\S+)$/.exec(query);
      if (release !== null) {
        return recent
          .filter((issue) => issue.release === release[1])
          .slice(0, limit)
          .map(toIssue);
      }
      if (query.includes(':')) {
        // Divergence 2: an unparsed query is a loud error, never "everything".
        throw invalidRequest(
          PROVIDER,
          'search_issues',
          `query "${query}" is not one of: is:<status>, release:<name>, or a title substring`,
        );
      }
      return recent
        .filter((issue) => issue.title.toLowerCase().includes(query.toLowerCase()))
        .slice(0, limit)
        .map(toIssue);
    },

    linkMergeRequest: async (issueRef, mrUrl) => {
      core.enter('link_merge_request');
      if (!capabilities.linkMergeRequest) {
        throw new IntegrationUnsupportedError(PROVIDER, 'merge request links');
      }
      const issue = requireIssue('link_merge_request', issueRef.id);
      if (!issue.linked_mrs.includes(mrUrl)) {
        issue.linked_mrs.push(mrUrl);
      }
    },

    comment: async (issueRef, text) => {
      core.enter('comment');
      if (!capabilities.comments) {
        throw new IntegrationUnsupportedError(PROVIDER, 'issue comments');
      }
      const issue = requireIssue('comment', issueRef.id);
      commentCounter += 1;
      const comment = { id: `note-${commentCounter}`, text };
      issue.comments.push(comment);
      return { id: comment.id };
    },

    resolve: async (issueRef, resolveOptions) => {
      core.enter('resolve');
      if (!capabilities.resolve) {
        throw new IntegrationUnsupportedError(PROVIDER, 'resolving issues');
      }
      const issue = requireIssue('resolve', issueRef.id);
      const inRelease = resolveOptions?.inRelease ?? null;
      if (inRelease !== null && !capabilities.resolveInRelease) {
        throw new IntegrationUnsupportedError(PROVIDER, 'resolve in next release');
      }
      issue.status = 'resolved';
      issue.resolved_in_release = inRelease;
      return toIssue(issue);
    },

    agentTooling,

    seedIssue,
    peek: (id) => issues.get(id),
  };
};

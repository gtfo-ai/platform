/**
 * One Sentry adapter wired to the recorded fixtures, shared by the contract runner and the
 * executor composition test.
 *
 * It lives beside the suites rather than inside a test file so that importing it does not register
 * somebody else's `describe` blocks.
 *
 * Like the Loki harness, it builds the port the way production does —
 * `createSentryRegistration(deps).create(binding)` — so the redactor the assertions rely on is the
 * one the registration actually passes (standing rule 31).
 *
 * The one piece of behaviour here rather than in the transport is the **variant flip**: Sentry's
 * `resolve` issues a `PUT` and then re-reads the issue, and the re-read must see the resolved
 * document. So the harness wraps the replay's `fetch` and activates the `resolved` variant when a
 * `PUT` goes out. That is a model of Sentry, not a recording of it, and it lives in the harness —
 * where a reader looking for "what did the test make up" will find it — rather than in the corpus.
 */
import { exactSecretRedactor, noSecretsRedactor, type SecretRedactor } from '@platform/application';
import { fixedClock } from '@platform/domain';
import { createSentryRegistration, type UnmappedValue } from '@platform/integrations';
import {
  createHttpReplay,
  type HttpReplay,
  loadAllReplayFixtures,
  type ReplayInteraction,
} from './http-replay.js';
import type { ObservabilityErrorsContractContext } from './observability-contract-suites.js';

export const SENTRY_FIXTURES = new URL('../../../fixtures/http/sentry/', import.meta.url);
export const SENTRY_INTEGRATION_ID = '00000000-0000-4000-8000-0000000000a6';
export const SENTRY_PROJECT_ID = '00000000-0000-4000-8000-0000000000b6';
export const SENTRY_TASK_ID = '00000000-0000-4000-8000-0000000000c6';

export const SENTRY_HOST = 'https://sentry.example.test';
export const SENTRY_ORG = 'acme-example';
export const SENTRY_PROJECT = 'api';
export const SENTRY_ISSUE_ID = '4242';
/** The issue whose events have aged out of the retention window — a documented 404. */
export const SENTRY_ISSUE_WITHOUT_EVENTS_ID = '4243';
export const SENTRY_MISSING_ISSUE_ID = '9999';
/** Obviously fake: the binding's auth token, shaped like nothing Sentry issues (BD-002). */
export const SENTRY_FAKE_TOKEN = 'FAKE-sentry-auth-token-DO-NOT-USE';
/** Every fixture timestamp sits inside this instant's day, and it is what `retry-after` is read against. */
export const SENTRY_CLOCK_AT = '2026-06-01T10:30:00.000Z';

export interface SentryReplayContext extends ObservabilityErrorsContractContext {
  readonly replay: HttpReplay;
  readonly redactions: { action: string; count: number }[];
  readonly unmapped: UnmappedValue[];
}

export interface SentryHarnessOverrides {
  /** Omit or blank it to drive the rule-18 refusal. */
  readonly token?: string | null;
  readonly organization?: string;
  readonly redactor?: SecretRedactor;
  readonly maxIssues?: number;
  readonly maxStackFrames?: number;
  readonly maxStackTraceBytes?: number;
  readonly maxBreadcrumbs?: number;
  readonly maxTags?: number;
  readonly maxFieldBytes?: number;
  /** Interactions the test wrote itself, queued before the first request. */
  readonly script?: readonly ReplayInteraction[];
}

/** The obviously fake secret the redaction assertions plant in provider text. */
export const SENTRY_PLANTED_SECRET = 'FAKE-injected-secret-value-0123456789';

export const sentryReplayContext = (
  overrides: SentryHarnessOverrides = {},
): SentryReplayContext => {
  const replay = createHttpReplay({
    provider: 'sentry',
    apiBase: '/api/0',
    interactions: loadAllReplayFixtures(SENTRY_FIXTURES),
  });
  if ((overrides.script ?? []).length > 0) {
    // The whole array at once: `script` clears a key before it queues, so two scripted responses
    // for one key must arrive together or the second would erase the first.
    replay.script(overrides.script as readonly ReplayInteraction[]);
  }
  const redactions: { action: string; count: number }[] = [];
  const unmapped: UnmappedValue[] = [];

  const registration = createSentryRegistration({
    clock: fixedClock(SENTRY_CLOCK_AT),
    fetch: async (url, init) => {
      const response = await replay.fetchImpl(url, init);
      if (init.method === 'PUT' && response.ok) {
        // The write is visible to the next read, exactly as Jira's replay double models it.
        replay.activate('resolved');
      }
      return response;
    },
    onRedaction: (event) => {
      redactions.push({ ...event });
    },
    onUnmapped: (value) => {
      unmapped.push({ ...value });
    },
  });
  const port = registration.create({
    integrationId: SENTRY_INTEGRATION_ID,
    // Unparsed on purpose: `create` runs `sentryConfigSchema.parse`.
    config: {
      base_url: SENTRY_HOST,
      organization: overrides.organization ?? SENTRY_ORG,
      // No network, so no timeout timer either: a wall-clock timer in a replay run is a hardware
      // dependency with nothing to guard.
      request_timeout_ms: 0,
      ...(overrides.maxIssues === undefined ? {} : { max_issues: overrides.maxIssues }),
      ...(overrides.maxStackFrames === undefined
        ? {}
        : { max_stack_frames: overrides.maxStackFrames }),
      ...(overrides.maxStackTraceBytes === undefined
        ? {}
        : { max_stack_trace_bytes: overrides.maxStackTraceBytes }),
      ...(overrides.maxBreadcrumbs === undefined
        ? {}
        : { max_breadcrumbs: overrides.maxBreadcrumbs }),
      ...(overrides.maxTags === undefined ? {} : { max_tags: overrides.maxTags }),
      ...(overrides.maxFieldBytes === undefined
        ? {}
        : { max_field_bytes: overrides.maxFieldBytes }),
    },
    secrets: overrides.token === null ? {} : { auth_token: overrides.token ?? SENTRY_FAKE_TOKEN },
    // Required, never defaulted (standing rule 31): see the Loki harness for why the no-op is
    // written out rather than omitted.
    redactor: overrides.redactor ?? noSecretsRedactor(),
  });

  return {
    replay,
    redactions,
    unmapped,
    port,
    project: SENTRY_PROJECT,
    issueId: SENTRY_ISSUE_ID,
    issueWithoutEventsId: SENTRY_ISSUE_WITHOUT_EVENTS_ID,
    missingIssueId: SENTRY_MISSING_ISSUE_ID,
    titleFragment: 'totals',
    cleanup: async () => {},
  };
};

/** A redactor over the one obviously fake secret the redaction tests plant (TD-012 step 1). */
export const sentryPlantedRedactor = (): SecretRedactor =>
  exactSecretRedactor([{ name: 'sentry', value: SENTRY_PLANTED_SECRET }]);

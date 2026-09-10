/**
 * The Sentry provider's registration (BD-017: "A new provider is one module plus registration").
 *
 * Nothing in the pipeline, the UI or the knowledge base changes because this file exists; a
 * composition root registers it and the `errors` type has an implementation beside the fake.
 */
import type { RateLimitPolicy } from '@platform/application';
import type { Clock } from '@platform/domain';
import type { ProviderRegistration } from '../../registry.js';
import { sentryConfigSchema, sentrySecretFields } from './config.js';
import { SENTRY_PROVIDER_ID, type SentryFetch } from './http.js';
import {
  createSentryProvider,
  SENTRY_AGENT_TOOLING,
  type SentryProviderOptions,
} from './provider.js';

/**
 * Sentry's rate-limit budget, passed at registration rather than left on the executor's default.
 *
 * <https://docs.sentry.io/api/ratelimits/> (retrieved 2026-09-10) documents the *mechanism* —
 * "limit is applied to each unique combination of caller and endpoint", a requests-per-second
 * limit and a concurrency limit, `X-Sentry-Rate-Limit-*` headers on every response, and a `429`
 * with `Retry-After` — but publishes **no number**. So these values are a deliberate choice rather
 * than a transcription, and they are chosen small: the platform makes a handful of Sentry calls per
 * bug task, the cost of being slower than allowed is latency, and the cost of being faster is a
 * `429` storm shared with every other client of the same token.
 */
export const sentryRateLimitPolicy: RateLimitPolicy = {
  capacity: 10,
  refillPerSecond: 4,
  maxConcurrent: 2,
};

/**
 * What the composition root supplies once, when it registers the provider (see the Loki
 * registration for why the split is where it is: binding data arrives per `create`, platform
 * services are captured here, and the contract suites therefore drive `create` itself).
 */
export interface SentryRegistrationDeps {
  readonly clock: Clock;
  /** Defaults to `globalThis.fetch`; the contract suites pass a replay transport. */
  readonly fetch?: SentryFetch;
  /** Where a redaction count is reported. The redacted text is never reported (TD-012). */
  readonly onRedaction?: SentryProviderOptions['onRedaction'];
  /** Where a vendor value this adapter does not know is reported (standing rule 20). */
  readonly onUnmapped?: SentryProviderOptions['onUnmapped'];
}

export const createSentryRegistration = (
  deps: SentryRegistrationDeps,
): ProviderRegistration<'errors'> => ({
  id: SENTRY_PROVIDER_ID,
  type: 'errors',
  displayName: 'Sentry (sentry.io and self-hosted)',
  configSchema: sentryConfigSchema,
  secretFields: [...sentrySecretFields],
  setupGuidePath: 'packages/integrations/src/providers/sentry/setup-guide.md',
  // Nothing is mounted into a run: see `SENTRY_AGENT_TOOLING`'s docblock for the three surfaces
  // Sentry publishes and why none of them has an environment contract the runner can keep.
  agentTooling: SENTRY_AGENT_TOOLING,
  create: (input) =>
    createSentryProvider({
      integrationId: input.integrationId,
      config: sentryConfigSchema.parse(input.config),
      secrets: input.secrets,
      // Standing rule 31: required in the type, and supplied by the path that runs in production.
      redactor: input.redactor,
      clock: deps.clock,
      ...(deps.fetch === undefined ? {} : { fetchImpl: deps.fetch }),
      ...(deps.onRedaction === undefined ? {} : { onRedaction: deps.onRedaction }),
      ...(deps.onUnmapped === undefined ? {} : { onUnmapped: deps.onUnmapped }),
    }),
});

/** The system-clock registration a composition root uses when it has nothing to inject. */
export const sentryProviderRegistration: ProviderRegistration<'errors'> = createSentryRegistration({
  clock: { now: () => new Date().toISOString() as `${string}T${string}` },
});

export {
  type SentryConfig,
  type SentryConfigInput,
  sentryConfigSchema,
  sentrySecretFields,
} from './config.js';
export {
  isUsableToken,
  parseSentryRetryAfterMs,
  SENTRY_API_BASE,
  SENTRY_PROVIDER_ID,
  type SentryFetch,
} from './http.js';
export {
  boundedIdentifier,
  CORRELATION_TAGS,
  capText,
  formatFrame,
  mapBreadcrumbs,
  mapCorrelationIds,
  mapIssueLevel,
  mapIssueStatus,
  mapTags,
  renderStackTrace,
  truncateUtf8,
  type UnmappedValue,
} from './mapping.js';
export {
  createSentryProvider,
  SENTRY_AGENT_TOOLING,
  type SentryProvider,
  type SentryProviderOptions,
} from './provider.js';

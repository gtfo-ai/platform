/**
 * The Loki provider's registration (BD-017: "A new provider is one module plus registration").
 *
 * Nothing in the pipeline, the UI or the knowledge base changes because this file exists; a
 * composition root registers it and the `logs` type has an implementation beside the fake.
 */
import type { RateLimitPolicy } from '@platform/application';
import type { Clock } from '@platform/domain';
import type { ProviderRegistration } from '../../registry.js';
import { lokiConfigSchema, lokiSecretFields } from './config.js';
import type { LokiFetch } from './http.js';
import { LOKI_PROVIDER_ID } from './logql.js';
import { createLokiProvider, LOKI_AGENT_TOOLING, type LokiProviderOptions } from './provider.js';

/**
 * Loki's rate-limit budget, passed at registration rather than left on the executor's default.
 *
 * Loki publishes per-tenant query limits as *operator* configuration (`limits_config`), not as a
 * number a client can read, so these values are a deliberate choice rather than a transcription.
 * They are small on purpose: a log range query is the most expensive read the platform makes, a
 * self-hosted Loki is usually shared with dashboards and alerting, and the cost of being slower
 * than allowed is latency where the cost of being faster is a `429` that everyone else feels too.
 */
export const lokiRateLimitPolicy: RateLimitPolicy = {
  capacity: 6,
  refillPerSecond: 2,
  maxConcurrent: 2,
};

/**
 * What the composition root supplies once, when it registers the provider.
 *
 * The split follows Jira's registration (WP-08): `ProviderCreateInput` carries what belongs to a
 * *binding* — its configuration, its secrets and its redactor — while the clock, the transport and
 * the observability sink are **platform services** captured here. That is also what lets the
 * contract suites drive the production path: the harness registers with a replay `fetch` and then
 * calls `create()`, so the code under test is the code that runs in production rather than a
 * neighbouring constructor call (standing rule 31: "the composition root that builds it in
 * production must be the thing the tests drive").
 */
export interface LokiRegistrationDeps {
  /** ISO-8601 now. `labels`/`series` take no window, so "now" is a value, not a hardware reading. */
  readonly clock: Clock;
  /** Defaults to `globalThis.fetch`; the contract suites pass a replay transport. */
  readonly fetch?: LokiFetch;
  /** Where a redaction count is reported. The redacted text is never reported (TD-012). */
  readonly onRedaction?: LokiProviderOptions['onRedaction'];
}

export const createLokiRegistration = (
  deps: LokiRegistrationDeps,
): ProviderRegistration<'logs'> => ({
  id: LOKI_PROVIDER_ID,
  type: 'logs',
  displayName: 'Grafana Loki',
  configSchema: lokiConfigSchema,
  secretFields: [...lokiSecretFields],
  setupGuidePath: 'packages/integrations/src/providers/loki/setup-guide.md',
  agentTooling: LOKI_AGENT_TOOLING,
  create: (input) =>
    createLokiProvider({
      integrationId: input.integrationId,
      config: lokiConfigSchema.parse(input.config),
      secrets: input.secrets,
      // Standing rule 31, and the whole point of the field being required: the production path
      // hands the adapter a redactor rather than leaving it to a default that does nothing.
      redactor: input.redactor,
      clock: deps.clock,
      ...(deps.fetch === undefined ? {} : { fetchImpl: deps.fetch }),
      ...(deps.onRedaction === undefined ? {} : { onRedaction: deps.onRedaction }),
    }),
});

/** The system-clock registration a composition root uses when it has nothing to inject. */
export const lokiProviderRegistration: ProviderRegistration<'logs'> = createLokiRegistration({
  clock: { now: () => new Date().toISOString() as `${string}T${string}` },
});

export {
  type LokiConfig,
  type LokiConfigInput,
  lokiAuthModeSchema,
  lokiConfigSchema,
  lokiSecretFields,
} from './config.js';
export {
  LOKI_API_BASE,
  type LokiAuth,
  type LokiFetch,
  lokiAuthHeaders,
  parseRetryAfterMs as parseLokiRetryAfterMs,
} from './http.js';
export {
  buildRangeQuery,
  escapeLogQLString,
  LOKI_PROVIDER_ID,
  parseStreamSelector,
  type StreamMatcher,
} from './logql.js';
export {
  createLokiProvider,
  LOKI_AGENT_TOOLING,
  LOKI_TRUNCATION_LABEL,
  type LokiProvider,
  type LokiProviderOptions,
  millisecondsToNanoseconds,
  nanosecondsToIso,
} from './provider.js';

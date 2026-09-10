/**
 * One Loki adapter wired to the recorded fixtures, shared by the contract runner and the executor
 * composition test.
 *
 * It lives beside the suites rather than inside a test file so that importing it does not register
 * somebody else's `describe` blocks.
 *
 * Loki needs no state model: every call this port makes is a **read**, so no recorded response
 * depends on an earlier request. That asymmetry with the Sentry harness is the honest one — the
 * variant machinery in `http-replay.ts` exists for Sentry's write-then-read and is simply unused
 * here for anything but the rate-limit case a test activates deliberately.
 *
 * **It builds the port the way production does** — `createLokiRegistration(deps).create(binding)` —
 * rather than calling the adapter's constructor next to it. That is standing rule 31's second half:
 * round 1's harness passed a `redactor` the registration had no field for, so every redaction
 * assertion here passed while the only production path redacted nothing. A harness that drives a
 * different constructor than production is a harness that can be green about the wrong function.
 */
import { exactSecretRedactor, noSecretsRedactor, type SecretRedactor } from '@platform/application';
import { fixedClock } from '@platform/domain';
import { createLokiRegistration, lokiConfigSchema } from '@platform/integrations';
import {
  createHttpReplay,
  type HttpReplay,
  loadAllReplayFixtures,
  type ReplayInteraction,
} from './http-replay.js';
import type { ObservabilityLogsContractContext } from './observability-contract-suites.js';

export const LOKI_FIXTURES = new URL('../../../fixtures/http/loki/', import.meta.url);
export const LOKI_INTEGRATION_ID = '00000000-0000-4000-8000-0000000000a7';
export const LOKI_PROJECT_ID = '00000000-0000-4000-8000-0000000000b7';
export const LOKI_TASK_ID = '00000000-0000-4000-8000-0000000000c7';

export const LOKI_HOST = 'https://loki.example.test:3100';
export const LOKI_TENANT = 'acme-example';
/** Obviously fake: the binding's bearer token, shaped like nothing anyone issues (BD-002). */
export const LOKI_FAKE_TOKEN = 'FAKE-loki-bearer-token-DO-NOT-USE';
/**
 * The harness clock. Every `labels`/`series` fixture key is `now - 6h … now` in nanoseconds, so
 * this instant is load-bearing: an injected clock is the only way a recorded key can be stable
 * (standing rule 2).
 */
export const LOKI_CLOCK_AT = '2026-06-01T10:30:00.000Z';
export const LOKI_WINDOW = {
  from: '2026-06-01T09:00:00.000Z',
  to: '2026-06-01T10:00:00.000Z',
} as const;
export const LOKI_SELECTOR = '{app="api", env="production"}';
export const LOKI_EMPTY_SELECTOR = '{app="nothing"}';
export const LOKI_LINE_FILTER = 'trace-abc';

/** The obviously fake secret the redaction assertions plant in a log line. */
export const LOKI_PLANTED_SECRET = 'FAKE-injected-secret-value-0123456789';

/**
 * The label-name cap this harness runs on, read out of the schema rather than restated.
 *
 * The contract suite sends exactly one byte past it, so the number must be the one the binding is
 * really configured with: a harness that hard-codes 1024 while the schema default moved would send
 * a value a too-wide guard also refuses, and the negative case would go quiet (standing rule 43).
 * Parsing a minimal config is the cheapest way to ask the schema for its own default without
 * pre-parsing the harness's config, which `create` is meant to validate itself.
 */
const LOKI_DEFAULT_MAX_LABEL_BYTES = lokiConfigSchema.parse({
  base_url: LOKI_HOST,
}).max_label_bytes;

export interface LokiReplayContext extends ObservabilityLogsContractContext {
  readonly replay: HttpReplay;
  readonly redactions: { action: string; count: number }[];
}

export interface LokiHarnessOverrides {
  readonly authMode?: 'none' | 'bearer' | 'basic';
  /** `null` removes the secret entirely, which is the rule-18 case. */
  readonly token?: string | null;
  readonly tenantId?: string | null;
  readonly redactor?: SecretRedactor;
  readonly maxLines?: number;
  readonly maxRangeMs?: number;
  readonly maxLineBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxLabelBytes?: number;
  readonly maxLabels?: number;
  readonly maxLabelValues?: number;
  readonly maxSeries?: number;
  readonly script?: readonly ReplayInteraction[];
}

export const lokiReplayContext = (overrides: LokiHarnessOverrides = {}): LokiReplayContext => {
  const replay = createHttpReplay({
    provider: 'loki',
    apiBase: '/loki/api/v1',
    interactions: loadAllReplayFixtures(LOKI_FIXTURES),
  });
  if ((overrides.script ?? []).length > 0) {
    // The whole array at once: `script` clears a key before it queues, so two scripted responses
    // for one key must arrive together or the second would erase the first.
    replay.script(overrides.script as readonly ReplayInteraction[]);
  }
  const redactions: { action: string; count: number }[] = [];

  const registration = createLokiRegistration({
    clock: fixedClock(LOKI_CLOCK_AT),
    fetch: replay.fetchImpl,
    onRedaction: (event) => {
      redactions.push({ ...event });
    },
  });
  const port = registration.create({
    integrationId: LOKI_INTEGRATION_ID,
    // Unparsed on purpose: `create` runs `lokiConfigSchema.parse`, so the harness exercises the
    // registration's own validation rather than pre-digesting the binding for it.
    config: {
      base_url: LOKI_HOST,
      auth_mode: overrides.authMode ?? 'bearer',
      tenant_id: overrides.tenantId === undefined ? LOKI_TENANT : overrides.tenantId,
      request_timeout_ms: 0,
      ...(overrides.maxLines === undefined ? {} : { max_lines: overrides.maxLines }),
      ...(overrides.maxRangeMs === undefined ? {} : { max_range_ms: overrides.maxRangeMs }),
      ...(overrides.maxLineBytes === undefined ? {} : { max_line_bytes: overrides.maxLineBytes }),
      ...(overrides.maxLabelBytes === undefined
        ? {}
        : { max_label_bytes: overrides.maxLabelBytes }),
      ...(overrides.maxLabels === undefined ? {} : { max_labels: overrides.maxLabels }),
      ...(overrides.maxLabelValues === undefined
        ? {}
        : { max_label_values: overrides.maxLabelValues }),
      ...(overrides.maxTotalBytes === undefined
        ? {}
        : { max_total_bytes: overrides.maxTotalBytes }),
      ...(overrides.maxSeries === undefined ? {} : { max_series: overrides.maxSeries }),
    },
    secrets: overrides.token === null ? {} : { bearer_token: overrides.token ?? LOKI_FAKE_TOKEN },
    // Required, never defaulted (standing rule 31). A test that wants to prove the *binding's* own
    // credential is covered passes the no-op deliberately, which is a statement rather than an
    // omission — and the adapter's composed redactor still removes the token.
    redactor: overrides.redactor ?? noSecretsRedactor(),
  });

  return {
    replay,
    redactions,
    port,
    selector: LOKI_SELECTOR,
    emptySelector: LOKI_EMPTY_SELECTOR,
    window: { from: LOKI_WINDOW.from, to: LOKI_WINDOW.to },
    label: { name: 'app', value: 'api' },
    maxLabelNameBytes: overrides.maxLabelBytes ?? LOKI_DEFAULT_MAX_LABEL_BYTES,
    lineFilter: LOKI_LINE_FILTER,
    cleanup: async () => {},
  };
};

export const lokiPlantedRedactor = (): SecretRedactor =>
  exactSecretRedactor([{ name: 'loki', value: LOKI_PLANTED_SECRET }]);

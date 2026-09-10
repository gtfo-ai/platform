/**
 * The Loki binding's configuration (technical/06 § "Provider module layout", TD-020).
 *
 * Two things here are not boilerplate.
 *
 * **`auth_mode` is explicit, and that is standing rule 18 applied to a product that really can be
 * unauthenticated.** A single-binary Loki behind a private network legitimately accepts anonymous
 * queries, so "no token configured" cannot mean "refuse" *and* cannot mean "send it anyway" — the
 * second is the rule-18 defect (an empty value silently producing a permissive result). The
 * operator therefore states which mode this binding is in. With `bearer` or `basic`, an absent,
 * empty or whitespace-only credential is a refusal issued **before** any request; with `none`, the
 * adapter sends no `Authorization` header and the setup guide says what that means. The difference
 * between the two is a deliberate line in a config file, which is exactly where it belongs.
 *
 * **The caps are the port's contract, not a preference.** `capabilities()` publishes `maxRangeMs`
 * and `maxLines`, and the port promises that exceeding either is `invalid_request` rather than a
 * silently truncated answer — "because a truncated answer looks like a complete one to an agent
 * reasoning about whether an error still happens". The two byte caps below are the same idea for
 * the axis the port does not name: a single log line can be a 50 MB base64 blob, and a thousand
 * ordinary lines can still be tens of megabytes.
 *
 * Sources, retrieved 2026-09-10:
 *  - <https://grafana.com/docs/loki/latest/reference/loki-http-api/> — the `/loki/api/v1` paths,
 *    the `start`/`end`/`limit`/`direction` parameters and their defaults ("`limit` … defaults to
 *    100", "`start` … defaults to 1 hour ago", labels "defaults to 6 hours ago"), and
 *    "set the `X-Scope-OrgID` header to identify the tenant you want to query".
 *  - <https://grafana.com/docs/loki/latest/query/logcli/getting-started/> — `LOKI_ADDR`,
 *    `LOKI_BEARER_TOKEN`, `LOKI_USERNAME`, `LOKI_PASSWORD`, `LOKI_ORG_ID`.
 */
import * as z from 'zod';

export const lokiAuthModeSchema = z.enum(['none', 'bearer', 'basic']);

export const lokiConfigSchema = z.strictObject({
  /**
   * The Loki root, e.g. `https://loki.example.test:3100`. The adapter appends `/loki/api/v1`; a
   * base URL that already carries it is rejected, because the doubled path answers 404 in a way
   * that reads like an empty result.
   */
  base_url: z
    .url()
    .refine((value) => !/\/loki\/api\/v\d+\/?$/.test(value), {
      message: 'give the Loki root (https://loki.example.test:3100), not the /loki/api/v1 path',
    })
    .refine((value) => !value.endsWith('/'), { message: 'must not end with a slash' }),
  /**
   * How this binding authenticates. `none` is a real deployment (a single-binary Loki on a private
   * network) and must therefore be **chosen**, never inferred from a missing secret.
   */
  auth_mode: lokiAuthModeSchema.default('bearer'),
  /** Secret. `Authorization: Bearer …`, when `auth_mode` is `bearer`. */
  bearer_token: z.string().nullish(),
  /** Username for HTTP basic auth, when `auth_mode` is `basic`. Not a secret on its own. */
  username: z.string().nullish(),
  /** Secret. Password for HTTP basic auth, when `auth_mode` is `basic`. */
  password: z.string().nullish(),
  /** `X-Scope-OrgID`. Required by a multi-tenant Loki, absent on a single-tenant one. */
  tenant_id: z.string().nullish(),
  /** Per-request timeout in milliseconds; 0 disables it (the replay harness has no network). */
  request_timeout_ms: z.int().nonnegative().max(600_000).default(30_000),

  // ── Caps (product/08, BD-022) ──────────────────────────────────────────────

  /** Widest window a single query may cover. Published as `capabilities().maxRangeMs`. */
  max_range_ms: z
    .int()
    .positive()
    .max(30 * 24 * 60 * 60 * 1000)
    .default(24 * 60 * 60 * 1000),
  /** Highest line limit a single query may ask for. Published as `capabilities().maxLines`. */
  max_lines: z.int().positive().max(5000).default(1000),
  /** Bytes kept of a single log line. A 50 MB line is one line and one denial of service. */
  max_line_bytes: z.int().positive().max(1_048_576).default(8_192),
  /**
   * Bytes kept across the whole result, after the per-line cap.
   *
   * It counts **what the adapter emits**, which is the line *and* the label set copied onto it —
   * the review's third blocker: counting `line` alone let a 2 MB label value across 20 lines
   * produce a 42,002,998-byte `LogQueryResult` reporting `truncated: false`.
   */
  max_total_bytes: z.int().positive().max(16_777_216).default(1_048_576),
  /**
   * Bytes kept of one label **name** and of one label **value**, wherever a label is emitted:
   * `queryRange` copies the stream's label set onto every line, and `labels`/`series` publish the
   * values themselves. Loki's own label values are short by convention; convention is not a bound.
   */
  max_label_bytes: z.int().positive().max(65_536).default(1_024),
  /**
   * Labels kept per stream, in the order Loki sent them.
   *
   * With `max_label_bytes` this is what makes one line's contribution bounded — and therefore what
   * makes `max_total_bytes` a bound rather than a target, because the first line is always kept.
   */
  max_labels: z.int().positive().max(1000).default(64),
  /** Values returned by `labels()`. A label with a million values is one request. */
  max_label_values: z.int().positive().max(100_000).default(1000),
  /**
   * Label sets returned by `series()`, in the order Loki sent them.
   *
   * The method the other caps did not reach (review round 2): the per-label caps bound one label
   * and nothing bounded the *list*, so 10 000 series of 5 kB of labels answered with 11,068,891
   * bytes and no marker. `series` is also bounded by `max_total_bytes`, which is what makes the
   * answer bounded rather than merely counted — `max_series × max_labels × 2 × max_label_bytes`
   * is 65 MB at these defaults.
   */
  max_series: z.int().positive().max(10_000).default(500),
  /** Characters accepted in a `filter`, which the adapter embeds as a literal LogQL substring. */
  max_filter_length: z.int().positive().max(4096).default(256),
  /**
   * How far back `labels` and `series` look when the caller names no window. Loki's own default is
   * six hours; the port's `labels()` takes no time arguments, so the window is configuration
   * rather than a guess made at the call site.
   */
  label_lookback_ms: z
    .int()
    .positive()
    .max(30 * 24 * 60 * 60 * 1000)
    .default(6 * 60 * 60 * 1000),
});

export type LokiConfig = z.output<typeof lokiConfigSchema>;
export type LokiConfigInput = z.input<typeof lokiConfigSchema>;

/** Config fields whose values live in the secret store, never in `integrations.config`. */
export const lokiSecretFields = ['bearer_token', 'password'] as const;

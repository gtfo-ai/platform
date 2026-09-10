/**
 * The vocabulary every integration type port shares — technical/06 § "Type contracts (ports in
 * the application ring)".
 *
 * BD-017 groups providers into five **types**; the pipeline, the UI and the knowledge base depend
 * only on the type ports declared here, never on a provider. Adding GitHub is a module in
 * `packages/integrations` plus a registration, and nothing in this ring changes.
 *
 * Two rules decide the shape of everything below.
 *
 *  1. **Everything a provider returns is untrusted data (BD-022).** A provider adapter parses its
 *     HTTP response with zod *before* the value reaches this ring, so a field that is missing, of
 *     the wrong type, or an unexpected extra is a loud `IntegrationResponseError` at the boundary
 *     rather than an `undefined` three layers up. `parseProviderData` is that boundary; it never
 *     puts the offending value in the error message, because a response body can contain a token.
 *  2. **Case follows purpose.** Data shapes that are validated with zod are *wire* — they end up
 *     in `integration_actions.payload`, in an event payload or in an artifact — so their keys are
 *     snake_case like every other payload in the platform (CLAUDE.md, technical/02, /03, /12).
 *     Interfaces that never cross a wire — the ports themselves, capability flags, call options —
 *     keep camelCase members, which is also how technical/06 writes them.
 *
 * Nothing here imports a provider library, an HTTP client or `node:crypto`: this is the ring that
 * only names the contract (technical/01).
 */
import {
  type Actor,
  type DomainEventType,
  type EventPayload,
  type ExternalIdentity,
  externalIdentitySchema,
  type Id,
  type IntegrationType,
  isoDateTimeSchema,
  nonEmptyStringSchema,
  urlSchema,
} from '@platform/contracts';
import * as z from 'zod';

// ── Identifying a binding ────────────────────────────────────────────────────

/**
 * Which configured integration an action or a delivery belongs to.
 *
 * `integrationId` is the `integrations.id` row (technical/03) — *not* the provider name. Two Jira
 * sites are two integrations of one provider, with separate credentials, separate health and, by
 * default, separate rate-limit budgets (see `RateLimiterOptions`).
 */
export interface IntegrationRef {
  readonly integrationId: Id;
  /** Registered provider id: `jira-cloud`, `gitlab`, `slack`, `sentry`, `loki`. */
  readonly provider: string;
  readonly type: IntegrationType;
}

// ── Typed failures ───────────────────────────────────────────────────────────

/**
 * Why a provider call failed, in terms the platform can act on.
 *
 * The codes are deliberately about *what the caller should do* rather than about HTTP: an adapter
 * maps 401/403 onto `unauthorised`/`forbidden`, 404 onto `not_found`, 409 onto `conflict`, 429
 * onto `rate_limited`, 5xx and network errors onto `unavailable`, and a response that fails its
 * schema onto `invalid_response`.
 */
export type IntegrationErrorCode =
  | 'unauthorised'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'invalid_request'
  | 'rate_limited'
  | 'unavailable'
  | 'invalid_response'
  | 'unsupported_capability';

/** Codes the `IntegrationActionExecutor` may retry. Everything else is the caller's mistake. */
const RETRYABLE_CODES: ReadonlySet<IntegrationErrorCode> = new Set(['rate_limited', 'unavailable']);

export class IntegrationError extends Error {
  readonly code: IntegrationErrorCode;
  readonly provider: string;
  /** The port method that failed (`read_ticket`, `open_merge_request`, …), when known. */
  readonly action: string | null;
  /** True when a later attempt could plausibly succeed without any other change. */
  readonly retryable: boolean;

  constructor(
    code: IntegrationErrorCode,
    provider: string,
    message: string,
    options: { readonly action?: string | null; readonly cause?: unknown } = {},
  ) {
    super(`${provider}: ${message}`, { cause: options.cause });
    this.code = code;
    this.provider = provider;
    this.action = options.action ?? null;
    this.retryable = RETRYABLE_CODES.has(code);
    this.name = new.target.name;
  }
}

/**
 * The provider asked us to slow down (429, or a provider-specific quota response).
 *
 * `retryAfterMs` is the provider's own `Retry-After` when it sent one and `null` when it did not;
 * the executor falls back to its exponential backoff in that case. It is milliseconds rather than
 * the header's seconds so that no caller has to remember which unit it is holding.
 */
export class IntegrationRateLimitedError extends IntegrationError {
  readonly retryAfterMs: number | null;

  constructor(
    provider: string,
    message: string,
    options: {
      readonly retryAfterMs?: number | null;
      readonly action?: string | null;
      readonly cause?: unknown;
    } = {},
  ) {
    super('rate_limited', provider, message, options);
    const retryAfterMs = options.retryAfterMs ?? null;
    if (retryAfterMs !== null && (!Number.isFinite(retryAfterMs) || retryAfterMs < 0)) {
      throw new TypeError(`retryAfterMs must be a non-negative number of milliseconds`);
    }
    this.retryAfterMs = retryAfterMs;
  }
}

/** A response did not match its schema. Carries the zod issue paths, never the value. */
export class IntegrationResponseError extends IntegrationError {
  readonly issues: readonly string[];

  constructor(
    provider: string,
    action: string,
    issues: readonly string[],
    options: { readonly cause?: unknown } = {},
  ) {
    super('invalid_response', provider, `${action} returned data that failed validation`, {
      action,
      cause: options.cause,
    });
    this.issues = issues;
  }
}

/** The capability flags say this provider cannot do it, so the caller must not ask. */
export class IntegrationUnsupportedError extends IntegrationError {
  constructor(provider: string, capability: string) {
    super('unsupported_capability', provider, `does not support ${capability}`, {
      action: capability,
    });
  }
}

/**
 * Parses a provider response at the ring boundary (BD-022).
 *
 * @throws {IntegrationResponseError} with the failing paths — `data.fields.0.id`, `issue.title` —
 * and never the offending value, which may be or contain a credential.
 */
export const parseProviderData = <TSchema extends z.ZodType>(
  schema: TSchema,
  value: unknown,
  context: { readonly provider: string; readonly action: string },
): z.infer<TSchema> => {
  const result = schema.safeParse(value);
  if (result.success) {
    return result.data as z.infer<TSchema>;
  }
  const issues = result.error.issues.map(
    (issue) => `${issue.path.length === 0 ? '<root>' : issue.path.join('.')}: ${issue.message}`,
  );
  throw new IntegrationResponseError(context.provider, context.action, issues, {
    cause: result.error,
  });
};

// ── Health ───────────────────────────────────────────────────────────────────

/**
 * Result of *Test connection* (product/08): a read-only capability probe, never a mutation.
 *
 * `token_expires_at` is filled in only when the provider exposes it; the UI warns on it
 * (product/08 "token expiry warnings"), so `null` means "unknown", not "never expires".
 */
export const healthProbeSchema = z.strictObject({
  ok: z.boolean(),
  checked_at: isoDateTimeSchema,
  /**
   * One line, safe to render — **already redacted by the provider that produced it**.
   *
   * "Must not put a credential in it" was a comment, and a comment is not a guard: this is
   * provider text (BD-022) on its way to a settings screen and to `integrations.health` in the
   * database, and a failing probe is exactly where an HTTP client quotes the request it made,
   * credential included. So the obligation is on every `testConnection`: build a `SecretRedactor`
   * from the binding's own secrets (TD-012) and run this string through it before returning,
   * exactly as `IntegrationActionExecutor` does for an action.
   *
   * Discharged for the first provider at WP-08 —
   * `packages/integrations/src/providers/jira-cloud/index.ts` builds `exactSecretRedactor` from
   * its config and asserts the placeholder in
   * `test/contract/integrations/jira-cloud.contract.test.ts` ("redacts the health probe detail
   * instead of rendering it"). WP-09…WP-11 owe the same, and a provider that returns a raw
   * message is a review finding rather than a type error.
   */
  detail: z.string().nullish(),
  token_expires_at: isoDateTimeSchema.nullish(),
});
export type HealthProbe = z.infer<typeof healthProbeSchema>;

// ── Agent tooling ────────────────────────────────────────────────────────────

/**
 * One environment variable the runner injects for a run (technical/06 § "Agent tooling exposure").
 *
 * There is deliberately **no value field**: a tooling spec declares *names*, and the run-scoped
 * credential is resolved by the runner from the secret store (BD-002, BD-025). A provider that
 * wanted to ship a token here would have to change this type, which is exactly the review that
 * should happen. The names are the tool-native ones (`GITLAB_TOKEN`, `LOKI_ADDR`) per TD-020.
 */
export const envVariableSpecSchema = z.strictObject({
  name: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'expected an UPPER_SNAKE_CASE variable name'),
  /** True when the value comes from the secret store and must never be logged or persisted. */
  secret: z.boolean(),
  description: nonEmptyStringSchema,
});

export const envSpecSchema = z.strictObject({
  variables: z.array(envVariableSpecSchema),
});

/** A CLI mounted on the agent's PATH (`glab`, `acli`, `logcli`). */
export const cliSpecSchema = z.strictObject({
  command: nonEmptyStringSchema,
  version: nonEmptyStringSchema.nullish(),
  env: envSpecSchema,
});

/** An MCP server the stage's tool policy may mount (`sentry-mcp`). */
export const mcpServerSpecSchema = z.strictObject({
  name: nonEmptyStringSchema,
  transport: z.enum(['stdio', 'http']),
  command: nonEmptyStringSchema.nullish(),
  args: z.array(z.string()).nullish(),
  url: urlSchema.nullish(),
  /** Header **names** only, for the same reason `EnvVariableSpec` has no value. */
  header_names: z.array(nonEmptyStringSchema).nullish(),
  env: envSpecSchema,
});

/** A skill directory of recipes shipped with the provider. */
export const skillRefSchema = z.strictObject({
  id: nonEmptyStringSchema,
  path: nonEmptyStringSchema,
});

export const agentToolingSchema = z.strictObject({
  cli: cliSpecSchema.nullish(),
  mcp: mcpServerSpecSchema.nullish(),
  skill: skillRefSchema.nullish(),
  env: envSpecSchema,
});

export type EnvVariableSpec = z.infer<typeof envVariableSpecSchema>;
export type EnvSpec = z.infer<typeof envSpecSchema>;
export type CliSpec = z.infer<typeof cliSpecSchema>;
export type McpServerSpec = z.infer<typeof mcpServerSpecSchema>;
export type SkillRef = z.infer<typeof skillRefSchema>;
export type AgentTooling = z.infer<typeof agentToolingSchema>;

// ── Inbound: webhooks and polling ────────────────────────────────────────────

/**
 * A webhook delivery exactly as it arrived.
 *
 * `body` is the **raw** string, not a parsed object: every signature scheme in TD-024 (GitLab's
 * token, Standard Webhooks, Jira's `X-Hub-Signature`, Sentry's `Sentry-Hook-Signature`, Slack's
 * signing secret) is computed over the bytes, so re-serialising a parsed object would verify a
 * different document than the one that was signed. Header names are lower-cased by the transport.
 */
export interface WebhookDelivery {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * What the normaliser needs from the platform to turn a delivery into catalogue events.
 *
 * `resolveUser` is the BD-022 half: an event that carries a human decision (an answer, an
 * approval) may only be emitted for an identity that maps to a platform user. Unmapped authors are
 * reported as `ignored` with reason `unmapped_identity` — recorded, never acted on (Q10).
 */
export interface InboundContext {
  readonly projectId: Id;
  readonly integrationId: Id;
  /** Platform user for a verified provider identity, or `null` when the identity is unmapped. */
  readonly resolveUser: (identity: ExternalIdentity) => Id | null;
}

/**
 * One catalogue event a delivery produced, with the actor for its envelope (technical/02: the
 * actor lives in the envelope, not in the payload).
 *
 * The normaliser stops here rather than building a `DomainEvent`: the envelope needs an id, a
 * stream and a `stream_seq`, all of which belong to the append that the application ring performs
 * inside its transaction (TD-005).
 */
export type NormalisedEvent<TType extends DomainEventType = DomainEventType> =
  TType extends DomainEventType
    ? {
        readonly type: TType;
        readonly payload: EventPayload<TType>;
        readonly actor: Actor;
      }
    : never;

/** Why a delivery produced no event. Recorded for the inbox audit (technical/03 `inbox.error`). */
export interface IgnoredDelivery {
  readonly reason:
    | 'unsupported_event'
    | 'unmapped_identity'
    | 'not_for_this_project'
    | 'malformed_payload';
  /**
   * Why, in one line — provider text, and therefore untrusted (BD-022).
   *
   * **Half redacted, and the half that is not is named** (TD-012, `docs/TODO.md`). Every adapter
   * that has an inbound half — Slack at WP-10, Jira and GitLab in WP-11's follow-up — now runs the
   * parsed delivery through its **own** composed redactor before any branch reads it, so this
   * `detail`, and every payload built beside it, is free of *that binding's* credentials.
   *
   * What remains is the platform's: an adapter can only redact what it holds, so a run-scoped
   * token or a neighbouring binding's secret is still unredacted here, and nothing yet records the
   * count on the inbox row. The endpoint that writes `inbox.error` — and **WP-15**, which appends
   * the normalised events — therefore still puts a `SecretRedactor` in front of the write and
   * records its count, exactly as `buildEntry` does.
   *
   * One ordering rule is worth carrying to whoever writes that: **redact before you cut**. A
   * `detail` is bounded provider text, and an exact-match redactor cannot find a secret that a cap
   * has already cut in half.
   */
  readonly detail: string;
}

/**
 * The result of normalising one delivery.
 *
 * Both halves are always present, and that is the point: a normaliser that silently drops an event
 * it does not understand makes a missing pipeline transition undebuggable. A test can then assert
 * positively on either side — "exactly one `ticket.comment.added`", "exactly one
 * `unmapped_identity`" — instead of asserting the absence of something, which also passes when the
 * harness never reached the code at all.
 */
export interface NormalisedDelivery<TType extends DomainEventType = DomainEventType> {
  readonly events: readonly NormalisedEvent<TType>[];
  readonly ignored: readonly IgnoredDelivery[];
}

/**
 * The inbound half of a provider (technical/06 § "Inbound: webhooks and polling").
 *
 * The HTTP endpoint verifies, stores the raw payload, computes the dedup key and enqueues the
 * normalisation — so `verify` and `deliveryKey` are synchronous and cheap, while `normalise` may
 * do provider I/O (a Jira webhook carries a partial issue; the adapter fetches the rest).
 */
export interface InboundNormaliser<TType extends DomainEventType = DomainEventType> {
  /** Constant-time signature/token check. A bad signature is `false`, never an exception. */
  verify(delivery: WebhookDelivery): boolean;

  /**
   * The idempotency key of this delivery — Jira's `X-Atlassian-Webhook-Identifier`, GitLab's
   * event + object id + `updated_at`, Sentry's hook id. Stable across redeliveries of the *same*
   * change and different for a different one; that is what makes webhooks and the polling
   * fallback safe to run together.
   *
   * @throws {IntegrationError} `invalid_request` when the delivery carries nothing to key on.
   */
  deliveryKey(delivery: WebhookDelivery): string;

  normalise(delivery: WebhookDelivery, context: InboundContext): Promise<NormalisedDelivery<TType>>;
}

// ── The base every type port extends ─────────────────────────────────────────

/**
 * What all five type ports have in common: which binding they are, what they can do, and a
 * read-only probe for the health panel and the setup wizard (product/08 § "Health and setup").
 */
export interface IntegrationPort<TCapabilities> {
  readonly ref: IntegrationRef;
  capabilities(): TCapabilities;
  /** Read-only probe. Never mutates, so it is safe to run from the settings UI on demand. */
  testConnection(): Promise<HealthProbe>;
}

export type { ExternalIdentity };
/** Re-exported so a port module describing an author or an assignee needs one import. */
export { externalIdentitySchema };

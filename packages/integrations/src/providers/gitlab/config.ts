/**
 * The GitLab binding's configuration (technical/06 § "Provider module layout", TD-020).
 *
 * One schema serves gitlab.com and a self-managed instance: the only structural difference is
 * `base_url`, and every behavioural difference is a *capability*, declared here by the operator
 * rather than guessed by the adapter. That is deliberate — `capabilities()` is synchronous, so it
 * cannot go and ask `/version` before answering, and a capability the adapter guessed wrong fails
 * at the worst moment (a credential mint during a workspace provision).
 *
 * Secret fields carry no value here. The registry resolves them from the secret store and hands
 * them to `create` in `ProviderCreateInput.secrets`, keyed by these field names (BD-002).
 */
import * as z from 'zod';

/** Roles GitLab accepts for a project access token (protected_branches.md § "Valid access levels",
 * project_access_tokens.md § "Create a project access token"). */
export const gitlabAccessLevelSchema = z.union([
  z.literal(10),
  z.literal(15),
  z.literal(20),
  z.literal(25),
  z.literal(30),
  z.literal(40),
  z.literal(50),
]);

export const gitlabConfigSchema = z.strictObject({
  /**
   * `https://gitlab.com` or the self-managed instance root. The adapter appends `/api/v4`; a
   * base URL that already carries it is rejected, because `…/api/v4/api/v4/projects` 404s in a way
   * that reads like a missing project.
   */
  base_url: z
    .url()
    .refine((value) => !/\/api\/v\d+\/?$/.test(value), {
      message: 'give the instance root (https://gitlab.example.test), not the /api/v4 path',
    })
    .refine((value) => !value.endsWith('/'), { message: 'must not end with a slash' }),
  /**
   * The project this binding serves, as `namespace/project` (GitLab's `path_with_namespace`).
   * `null` means "any project", and then an inbound delivery is never rejected as
   * `not_for_this_project`.
   */
  project: z
    .string()
    .regex(/^[^/\s]+(\/[^/\s]+)+$/, 'expected a namespace/project path')
    .nullish(),
  /** Secret. The API token (`PRIVATE-TOKEN`). Value comes from the secret store. */
  token: z.string().nullish(),
  /** Secret. Legacy webhook scheme: the plain `X-Gitlab-Token` header value. */
  webhook_secret_token: z.string().nullish(),
  /**
   * Secret. Standard Webhooks signing token, `whsec_<base64>` (GitLab 19.0+). When both this and
   * `webhook_secret_token` are set the signed scheme wins whenever the delivery carries a
   * `webhook-signature` header, which is GitLab's own documented migration path.
   */
  webhook_signing_token: z.string().nullish(),
  /**
   * How far a Standard Webhooks `webhook-timestamp` may be from now before the delivery is treated
   * as a replay. GitLab says only "validate that the timestamp is recent"; five minutes is the
   * Standard Webhooks reference tolerance.
   */
  webhook_tolerance_seconds: z.int().positive().max(3600).default(300),
  /**
   * Whether this binding may mint project access tokens. **Off by default**: on GitLab.com a
   * project access token needs Premium or Ultimate, and the endpoint requires a *personal* access
   * token to authenticate. With it off, `capabilities().credentialMinting` is false and the port
   * refuses to mint rather than failing inside a workspace provision.
   */
  mint_credentials: z.boolean().default(false),
  /** Role given to a minted read credential. 20 = Reporter, the lowest role that may pull code. */
  read_access_level: gitlabAccessLevelSchema.default(20),
  /** Role given to a minted push credential. 30 = Developer. */
  push_access_level: gitlabAccessLevelSchema.default(30),
  /** Per-request timeout in milliseconds; 0 disables it (the replay harness has no network). */
  request_timeout_ms: z.int().nonnegative().max(600_000).default(30_000),
  /** Pages a bounded pager will follow before it stops and reports what it has. */
  max_pages: z.int().positive().max(100).default(10),
  /** Largest CODEOWNERS file the adapter will read, in bytes (BD-022: attacker-controlled). */
  max_codeowners_bytes: z.int().positive().max(4_194_304).default(262_144),
});

export type GitLabConfig = z.output<typeof gitlabConfigSchema>;
export type GitLabConfigInput = z.input<typeof gitlabConfigSchema>;

/** Config fields whose values live in the secret store, never in `integrations.config`. */
export const gitlabSecretFields = [
  'token',
  'webhook_secret_token',
  'webhook_signing_token',
] as const;

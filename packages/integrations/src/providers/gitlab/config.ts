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
import {
  DEFAULT_TICKET_POLL_INTERVAL_SECONDS,
  MAX_TICKET_POLL_INTERVAL_SECONDS,
  MIN_TICKET_POLL_INTERVAL_SECONDS,
  MINTED_CREDENTIAL_PREFIX_PATTERN,
} from '@platform/application';
import { httpUrlSchema } from '@platform/contracts';
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
   *
   * `httpUrlSchema` rather than `z.url()` since WP-51: a bare `z.url()` accepted
   * `javascript:`, `data:`, `vbscript:` and `file:` (Q49), and this value is handed to the
   * client this binding's credential is built into. The **host** is the other half and is not a
   * schema's to know: it is checked against `APP_INTEGRATION_HOSTS` when the row is written and
   * again when the call is made (`createIntegrationEgressPolicy`).
   */
  base_url: httpUrlSchema
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
   * refuses to mint rather than failing inside a workspace provision — and a run gets a credential
   * only from `run_credential: static` below (WP-137).
   */
  mint_credentials: z.boolean().default(false),
  /**
   * Where a run's git credential comes from (TD-028 decision 13, WP-137 — the founder's answer to
   * Q98 (b)). `minted` (the default) is a project access token per run, which needs
   * `mint_credentials: true` and, on GitLab.com, Premium or Ultimate. `static` hands every run of
   * the one bound project the dedicated **`run_token`** below instead — for GitLab.com Free, which
   * cannot mint. **Weaker isolation, stated** (decision 13 item 5): it is not run-lifetime, cannot
   * be revoked per run, and reaches read-only stages with its push scope. One source per
   * integration: `static` with `mint_credentials: true` is refused, and a static integration may be
   * bound by one project only.
   */
  run_credential: z.enum(['minted', 'static', 'deploy_key']).default('minted'),
  /**
   * **Whose** personal access token `run_token` is, with `run_credential: static` (TD-028 decision
   * 13a, WP-141 — the founder's *"let the admin decide"*, 2026-10-04). The operator chooses, and
   * each choice has its own probe and its own stated loss:
   *
   *  - `dedicated_user` (the default; decision 13 unchanged) — a dedicated user who is a member of
   *    only the bound project, with the Developer role and no more. The probe reads that user's role
   *    with the API token and refuses a Maintainer or Owner. Costs a seat on gitlab.com.
   *  - `operator` — the operator's **own** token, created with **only** `read_repository` and
   *    `write_repository`. Any role is accepted; instead the probe proves the token cannot call the
   *    API (one `GET /user` with it must answer `403`), and the bound project's default branch must
   *    be protected with push **No one** and force push off — checked at the probe and again before
   *    every run that gets the token. No seat; **the loss is reach**: the token reads every
   *    repository its owner can, and pushes to every unprotected branch of them.
   *
   * A third choice, a project SSH deploy key, is decision 13b (WP-146): another `run_credential`
   * value (`deploy_key`), not an owner.
   */
  run_token_owner: z.enum(['dedicated_user', 'operator']).default('dedicated_user'),
  /**
   * Secret. The static run credential, scopes `read_repository` and `write_repository` only: the
   * **personal access token of a dedicated user** who is a member of only the bound project with the
   * Developer role, or — with `run_token_owner: operator` — the operator's own. Never the API
   * `token` (refused when equal), never used for a platform API call — the adapter is built without
   * it, and its one use against the API is `operator`'s scope proof — and never given to a shadow
   * task.
   */
  run_token: z.string().nullish(),
  /**
   * Secret. With `run_credential: deploy_key` (TD-028 decision 13b, WP-146): the project deploy key's
   * **unencrypted OpenSSH Ed25519** private key (`ssh-keygen -t ed25519 -N ""`), the deploy key
   * enabled on the bound project with **write access**. It never enters a run container: the runner
   * holds it and answers the sign requests the run shim relays from `/ctl/ssh-agent.sock`. Refused at
   * the write when it has a passphrase, is another type, or is not `run_ssh_public_key`'s; and
   * mutually exclusive with `run_token`. GitLab.com only (`altssh.gitlab.com:443`): a self-managed
   * instance is refused by name, because the egress sidecar admits no SSH port.
   */
  run_ssh_private_key: z.string().nullish(),
  /** The deploy key's public `ssh-ed25519 AAAA…` line — what the probe looks for among the project's deploy keys. */
  run_ssh_public_key: z.string().max(1_024).nullish(),
  /** The run token's GitLab username: what git sends beside `run_token`, and what the probe checks. */
  run_token_username: z
    .string()
    .regex(/^[A-Za-z0-9_.-]{1,255}$/, 'expected a GitLab username')
    .nullish(),
  /**
   * The run token's expiry as a date (`YYYY-MM-DD`), **required** with `static` and at most 90 days
   * ahead when written. The platform does not ask GitLab for it, and refuses a run once it passes.
   */
  run_token_expires_at: z.iso.date().nullish(),
  /**
   * The prefix of every token this instance issues — GitLab's documented default `glpat-`, which an
   * administrator can change and project access tokens inherit
   * (<https://docs.gitlab.com/administration/settings/account_and_limit_settings/>, retrieved
   * 2026-09-28). **Declared rather than guessed** (WP-80, TD-012's M5 amendment): a minted run
   * credential is redacted in every process that did not mint it by a shape whose prefix is this
   * value, and a minted token that does not start with it is revoked and refused rather than used,
   * because no process but its minter could redact it. The alphabet is the platform's shape
   * alphabet (`MINTED_CREDENTIAL_PREFIX_PATTERN`), which the operator's prefix must fit.
   */
  token_prefix: z.string().regex(MINTED_CREDENTIAL_PREFIX_PATTERN).default('glpat-'),
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
  /**
   * Whether this binding **polls** its merge requests (WP-110, technical/06 § "Inbound: webhooks
   * and polling") — off by default, and the switch an operator whose instance GitLab cannot reach
   * turns on instead of the webhook, or beside it as a safety net: a merge seen by both is one
   * `mr.merged`. The key names are the platform's (`TICKET_POLL_CONFIG_KEYS`), because the poll
   * sweep reads them without building this adapter. A binding with no `project` cannot poll.
   */
  poll_enabled: z.boolean().default(false),
  /** Seconds between two polls of this binding; product/08's 60 by default. */
  poll_interval_seconds: z
    .int()
    .min(MIN_TICKET_POLL_INTERVAL_SECONDS)
    .max(MAX_TICKET_POLL_INTERVAL_SECONDS)
    .default(DEFAULT_TICKET_POLL_INTERVAL_SECONDS),
});

export type GitLabConfig = z.output<typeof gitlabConfigSchema>;
export type GitLabConfigInput = z.input<typeof gitlabConfigSchema>;

/** Config fields whose values live in the secret store, never in `integrations.config`. */
export const gitlabSecretFields = [
  'token',
  'webhook_secret_token',
  'webhook_signing_token',
  'run_token',
  'run_ssh_private_key',
] as const;

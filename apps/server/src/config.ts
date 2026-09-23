/**
 * The server's configuration, parsed with zod at boot (TD-023: "single `config.ts` parsed with
 * zod 4 at boot (fail fast)").
 *
 * Three rules the shape follows:
 *
 * 1. **Fail fast, and never partially.** `loadServerConfig` either returns a whole, validated
 *    configuration or throws one error naming every offending variable. Nothing downstream reads
 *    `process.env`, so there is no way to end up half-configured — a process that starts is a
 *    process whose configuration parsed.
 * 2. **Secrets take a `_FILE` variant** (Docker secrets convention, TD-020), resolved first, and
 *    `APP_SECRET_KEY` has no default in any environment. A development default would be a real
 *    secret in the repository the day someone shipped with it.
 * 3. **The database, dispatcher and jobs halves are the loaders `packages/infrastructure` already
 *    owns**, so `.env.example` has one description per variable and this file adds only what the
 *    HTTP process itself needs.
 */
import process from 'node:process';
import { CONNECTIONS_PER_DISPATCH } from '@platform/application';
import { providerModeSchema } from '@platform/contracts';
import { db, eventing, jobs } from '@platform/infrastructure';
import * as z from 'zod';
import { ROLES, roleCapabilities } from './role.js';

export type EnvLike = Readonly<Record<string, string | undefined>>;

/** Field name -> the environment variable it comes from, so an error names what to fix. */
const SOURCE_VARIABLE: Record<string, string> = {
  role: 'ROLE',
  port: 'PORT',
  host: 'HOST',
  baseUrl: 'APP_BASE_URL',
  secretKey: 'APP_SECRET_KEY',
  logLevel: 'LOG_LEVEL',
  logFormat: 'LOG_FORMAT',
  timezone: 'TZ',
  allowSignUp: 'APP_ALLOW_SIGNUP',
  bootstrapAdminEmail: 'APP_BOOTSTRAP_ADMIN_EMAIL',
  bootstrapAdminName: 'APP_BOOTSTRAP_ADMIN_NAME',
  bootstrapAdminPassword: 'APP_BOOTSTRAP_ADMIN_PASSWORD',
  sessionTtlDays: 'APP_SESSION_TTL_DAYS',
  metricsUsername: 'APP_METRICS_USERNAME',
  metricsPassword: 'APP_METRICS_PASSWORD',
  sseBufferSize: 'APP_SSE_BUFFER_SIZE',
  sseMaxQueuedFrames: 'APP_SSE_MAX_QUEUED_FRAMES',
  sseMaxTopics: 'APP_SSE_MAX_TOPICS',
  sseMaxBufferedTopics: 'APP_SSE_MAX_BUFFERED_TOPICS',
  ssePingIntervalMs: 'APP_SSE_PING_INTERVAL_MS',
  sseRetryMs: 'APP_SSE_RETRY_MS',
  sseMaxConnections: 'APP_SSE_MAX_CONNECTIONS',
  sseShutdownDrainMs: 'APP_SSE_SHUTDOWN_DRAIN_MS',
  shutdownTimeoutMs: 'APP_SHUTDOWN_TIMEOUT_MS',
  bodyLimitBytes: 'APP_HTTP_BODY_LIMIT_BYTES',
  trustProxy: 'APP_TRUST_PROXY',
  providerMode: 'APP_PROVIDER_MODE',
  knowledgeMirrorRoot: 'APP_KNOWLEDGE_MIRROR_ROOT',
  webRoot: 'APP_WEB_ROOT',
  integrationSecretEnv: 'APP_INTEGRATION_SECRET_ENV',
  integrationHosts: 'APP_INTEGRATION_HOSTS',
  dependencyRegistryHosts: 'APP_DEPENDENCY_REGISTRY_HOSTS',
  modelApiKey: 'ANTHROPIC_API_KEY',
  modelOauthToken: 'CLAUDE_CODE_OAUTH_TOKEN',
  claudeBinary: 'APP_CLAUDE_BINARY',
  launcherUrl: 'APP_LAUNCHER_URL',
  launcherToken: 'APP_LAUNCHER_TOKEN',
  workspaceControlRoot: 'APP_WORKSPACE_CONTROL_ROOT',
  modelEgressHosts: 'APP_MODEL_EGRESS_HOSTS',
};

/**
 * Argon2id, at the OWASP parameters TD-022 names. They are configuration rather than constants
 * because the right cost depends on the host, and a self-hoster on small hardware who cannot
 * afford 19 MiB per login needs a knob that is not a fork.
 */
export const argon2ConfigSchema = z.strictObject({
  memoryCostKib: z.int().min(8_192).max(1_048_576),
  timeCost: z.int().min(2).max(16),
  parallelism: z.int().min(1).max(16),
});

export type Argon2Config = z.infer<typeof argon2ConfigSchema>;

const serverConfigFields = z.strictObject({
  /** Which workloads this process runs (technical/01: one image, `ROLE` splits it). */
  role: z.enum(ROLES),
  port: z.int().min(0).max(65_535),
  host: z.string().min(1),
  /**
   * Absolute origin the instance is reached on.
   *
   * It decides three things that all break quietly if it is wrong: the session cookie's `Secure`
   * attribute and `__Host-` prefix, the one trusted origin the CSRF check accepts, and the `servers`
   * entry of the generated OpenAPI document. `z.url()` alone accepts `localhost:8080` — it reads
   * `localhost:` as a scheme — so the protocol is checked explicitly.
   */
  baseUrl: z
    .url()
    .refine(
      (value) => ['http:', 'https:'].includes(new URL(value).protocol),
      'must be an absolute http:// or https:// URL, e.g. https://agentic.example.com',
    ),
  /** Session signing and secret encryption at rest (TD-023). No default, ever. */
  secretKey: z
    .string()
    .min(
      32,
      'must be at least 32 characters (generate one with `openssl rand -base64 48`); there is no default',
    ),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']),
  logFormat: z.enum(['json', 'pretty']),
  /** IANA zone; the cron schedules and the working calendar are read in it, never in the host's. */
  timezone: z.string().min(1),

  /** Open registration. Off by default: a self-hosted instance on the internet is not a sign-up page. */
  allowSignUp: z.boolean(),
  /** When set and no user exists yet, this account is created as `admin` at boot. */
  bootstrapAdminEmail: z.email().nullable(),
  bootstrapAdminName: z.string().min(1),
  bootstrapAdminPassword: z.string().min(12).nullable(),
  sessionTtlDays: z.int().min(1).max(365),

  /** Optional basic auth on `/metrics` (TD-023). Both halves or neither. */
  metricsUsername: z.string().nullable(),
  metricsPassword: z.string().nullable(),

  /** Frames kept per SSE topic for replay after a reconnect (TD-014's ring buffer). */
  sseBufferSize: z.int().min(1).max(10_000),
  /**
   * How far one stream's write queue may grow past the depth it opened at before that client is
   * treated as a stalled reader and dropped. Separate from the buffer size on purpose, and
   * measured as growth rather than depth — see `sse/hub.ts`.
   */
  sseMaxQueuedFrames: z.int().min(1).max(100_000),
  /** Topics one stream may carry; it bounds the largest replay a reconnect can ask for. */
  sseMaxTopics: z.int().min(1).max(1_000),
  /** Topics whose replay buffer is retained, least-recently-published evicted first. */
  sseMaxBufferedTopics: z.int().min(1).max(1_000_000),
  /** `: ping` comment interval; technical/08 says 20 s. */
  ssePingIntervalMs: z.int().min(1_000).max(600_000),
  /** The `retry:` field sent to the client; technical/08 says 1000 ms. */
  sseRetryMs: z.int().min(100).max(600_000),
  /** Hard cap on concurrent streams, so a client loop cannot exhaust the process's sockets. */
  sseMaxConnections: z.int().min(1).max(100_000),
  /** How long shutdown waits for one stream's queue to reach the socket before abandoning it. */
  sseShutdownDrainMs: z.int().min(10).max(600_000),

  shutdownTimeoutMs: z.int().min(100).max(600_000),
  bodyLimitBytes: z
    .int()
    .min(1_024)
    .max(64 * 1_024 * 1_024),
  /** Behind a reverse proxy (technical/01's optional caddy), so `X-Forwarded-*` is honoured. */
  trustProxy: z.boolean(),

  /**
   * How often the intake reconciliation looks for a ticket the platform matched and never started,
   * and — the same number — how old such a match must be before it is re-emitted (WP-15c, PROGRESS
   * backlog 20).
   *
   * One knob rather than two, because the sentence it expresses is one: *a ticket that has had a
   * full interval to produce a task row and has not*. A match younger than that still has its own
   * `intake_check` job in flight, and re-emitting it would race the intake it is waiting for.
   *
   * The floor is not cosmetic: every pass is a query over `events` joined against `tasks`, so a
   * sub-second interval would cost more than the loss it recovers. `0` switches the pass off, for
   * an operator who would rather see a stuck ticket than an automatic re-emission, and
   * `composePipeline` logs which of the two it did — "switched off" and "never composed" must not
   * be spelled the same way (standing rule 18).
   */
  intakeReconcileIntervalMs: z.union([z.literal(0), z.int().min(1_000).max(3_600_000)]),

  /**
   * BD-004: `api` talks to Anthropic, `local` runs the operator's own `claude` binary.
   *
   * It reaches a run through `RunSpec.providerMode`, which decides one thing in the adapter
   * (`runner/options.ts`): `pathToClaudeCodeExecutable` is only honoured in `local` mode, so an
   * operator who set `APP_CLAUDE_BINARY` in `api` mode gets the bundled binary and no warning. Read
   * here so a composition root does not have to guess.
   */
  providerMode: providerModeSchema,
  /**
   * `ANTHROPIC_API_KEY` — the model credential. Optional *here*, and refused as empty.
   *
   * Optional because most processes run no agent: `ROLE=api` serves HTTP, and until a launcher is
   * configured no process composes a runner at all (Q52). It is required by the thing that actually
   * needs it — `composeAgentRunner` refuses to compose a runner in `api` mode without one and logs
   * which piece is missing, the same shape every other absent collaborator gets — rather than by this
   * schema, because a config-level requirement would stop an API container that was never going to
   * run a model.
   *
   * TD-021 phase 1 puts it in the run's own environment ("in env, documented") and phase 2 injects it
   * at the egress proxy so it is never in the container at all. It is therefore a `RunSpec.env` entry
   * whose name is in `secretEnvNames`, which is what builds TD-012 step 1's redactor for the run: the
   * exact value is replaced in **every** transcript entry, error and stored artifact the run produces.
   * `null` is legitimate — `local` mode, or a process that runs no agent — and is the one case that
   * must not be spelled the same way as empty (standing rule 18): an empty string here would produce
   * a redactor over `''`, which `exactSecretRedactor` refuses at `MIN_SECRET_LENGTH`, and a CLI with
   * an empty key would fail with an authentication error nobody can trace to configuration.
   */
  modelApiKey: z
    .string()
    .min(8, 'must be a real API key; an empty value is not a credential (standing rule 18)')
    .nullable(),
  /**
   * `CLAUDE_CODE_OAUTH_TOKEN` — BD-004 `local` mode's model credential (PROGRESS backlog **128**).
   *
   * Until WP-53 **no server source read this name at all** while `compose.local.yml` claimed
   * *"`loadServerConfig` requires [it]"* and made compose refuse to resolve without one. Two things
   * were wrong at once: the refusal did not exist, and `agentRunEnvironment` answered `local` with
   * an **empty** environment — so an operator who did everything the file asked started a run
   * container with no credential of any kind.
   *
   * Measured at WP-53 against `platform-runtime:dev` (`claude` 2.1.267), which is what decided that
   * this is one line rather than a credential-helper change: with nothing set the CLI answers *"Not
   * logged in · Please run /login"*; with this name set to a bogus value it answers *"Failed to
   * authenticate. API Error: 401 OAuth access token is invalid"* — a different message from the
   * bogus-`ANTHROPIC_API_KEY` case (*"401 API key is invalid"*). So the pinned CLI reads it from the
   * process environment, and `agentRunEnvironment` puts it in the run's `env` with its name in
   * `secretEnvNames`, which is what builds TD-012 step 1's redactor for the run.
   *
   * Optional here and refused *empty* for the same reason `modelApiKey` is: `api` mode does not use
   * it, most processes run no agent, and an empty string would produce a redactor over `''`.
   */
  modelOauthToken: z
    .string()
    .min(8, 'must be a real token; an empty value is not a credential (standing rule 18)')
    .nullable(),
  /** `pathToClaudeCodeExecutable` in `local` mode (BD-004); null uses the bundled binary. */
  claudeBinary: z.string().min(1).nullable(),

  /**
   * `APP_LAUNCHER_URL` — TD-028's control plane, and **the one setting that decides whether this
   * process runs agents at all**.
   *
   * `http://launcher:7780` on the shipped compose topology. Absent is the shipped default for the
   * `app` service and means *this container takes no `stage.execute` job* (TD-028 decision 5): it
   * still runs the API, the dispatcher, the outbound calls, the knowledge index and the digests.
   * The container that carries it is the `runner` service, which is the same image with the `ctl`
   * volume mounted.
   */
  launcherUrl: z.string().min(1).nullable(),
  /**
   * `APP_LAUNCHER_TOKEN` — the shared secret in front of a surface that creates containers.
   *
   * Refused below 32 characters rather than merely non-empty: TD-028 decision 3 puts this check
   * *beside* the network isolation precisely because a compose file is a deployment property, and a
   * two-character token would make the code property worthless. The launcher refuses the same
   * length on its own side (`MIN_LAUNCHER_TOKEN_LENGTH`), so the two halves of the instance fail
   * the same way rather than one starting and the other refusing every request.
   */
  launcherToken: z
    .string()
    .min(32, 'must be at least 32 characters: it guards a surface that creates containers')
    .nullable(),
  /**
   * `APP_WORKSPACE_CONTROL_ROOT` — where **this** process mounts TD-025 §2's `ctl` volume.
   *
   * Read here as well as by the launcher because the two mount the same volume and the socket path
   * the launcher answers with is computed from *its* root. A mismatch is a compose mistake whose
   * only symptom would otherwise be `ECONNREFUSED` thirty seconds into a run;
   * `assertControlSocketUnderRoot` turns it into a named refusal before the run starts.
   */
  workspaceControlRoot: z.string().min(1),
  /**
   * `APP_MODEL_EGRESS_HOSTS` — the hosts a run container may reach besides its git host.
   *
   * technical/05 § "Network policy" lists four sources for the allow-list and two of them do not
   * exist in this build (no discovery-derived registries, no per-stage observability hosts). This
   * is the first: the model provider, or a proxy in front of it. It is configuration rather than a
   * constant because an instance behind an egress proxy names a different host, and because
   * `local` mode needs it **too** — WP-53 measured that the pinned CLI authenticates against the
   * same API with `CLAUDE_CODE_OAUTH_TOKEN`, which is not what `buildWorkspaceSpec`'s docblock
   * assumed when it wrote *"or none, in `local` provider mode"*.
   *
   * Empty is legal and **fails closed**: the run reaches only its git host and the CLI's first
   * request is refused by the egress sidecar.
   */
  modelEgressHosts: z.array(z.string().min(1)).readonly(),

  /**
   * `APP_KNOWLEDGE_MIRROR_ROOT` — where the knowledge indexer keeps one bare mirror per project,
   * cloned and fetched by this process with `git` (TD-026).
   *
   * **`null` has no default and must never acquire one.** Not the working directory, not a temp
   * directory, not `./knowledge`: a path that appears by default is a mirror an operator did not
   * ask for, on a filesystem that may not survive a restart, and an index built from it looks
   * exactly like one built from the volume they meant to mount. Unset therefore composes a vault
   * source that **refuses by name** (`knowledge.ts`), which is TD-026 decision 5 and standing rules
   * 18, 31 and 55.
   *
   * Absolute because it is resolved against nothing: the adapter refuses a relative path rather
   * than joining it to whatever the process' cwd happens to be.
   */
  knowledgeMirrorRoot: z
    .string()
    .min(1)
    .refine(
      (value) => value.startsWith('/'),
      'must be an absolute path, e.g. /var/lib/app/knowledge: it names a data volume, not a place relative to the working directory',
    )
    .nullable(),

  /**
   * `APP_WEB_ROOT` — the directory holding the built SPA, or `null` for the one baked into the
   * image (WP-15j).
   *
   * Unlike `APP_KNOWLEDGE_MIRROR_ROOT` this one **does** have a default, and the difference is the
   * kind of thing the two name. A mirror root is a *data volume* an operator has to choose, and a
   * path that appears by default is a mirror they did not ask for. A web root is a *part of the
   * image*: `docker/app.Dockerfile` copies the Vite output to `/app/apps/web/dist`, so the default
   * is not a guess about the host but a fact about the artefact, expressed once as
   * `BUNDLED_WEB_ROOT` and held to the Dockerfile by a test. The variable exists for the operator
   * who serves a patched bundle from a mounted volume.
   *
   * Absolute for the reason the mirror root is: it is resolved against nothing, and joining it to
   * whatever the process's working directory happens to be would serve a different directory
   * depending on how the container was started. An absent bundle is logged by name and the API is
   * unaffected (`web/fallback.ts`).
   */
  webRoot: z
    .string()
    .min(1)
    .refine(
      (value) => value.startsWith('/'),
      'must be an absolute path, e.g. /app/apps/web/dist: it names a directory in the image or on a mounted volume, not a place relative to the working directory',
    )
    .nullable(),

  /**
   * The environment-variable names `POST /api/integrations` may read a credential out of.
   *
   * **An operator-declared allow-list, empty by default, and that is the whole security property.**
   * The command takes `secret_refs` as *field → variable name* so that no credential crosses the
   * API — but the name is chosen by an `integration.write` caller, so without this list the caller
   * could name `APP_SECRET_KEY`, `DATABASE_URL` or `ANTHROPIC_API_KEY` and have the platform seal
   * its own secret into a row a provider adapter is then handed. Combined with a caller-chosen
   * provider `base_url`, that is two API calls to send the envelope key to a host the caller picked.
   *
   * An **allow-list** rather than a deny-list of the platform's own names, which is standing rule
   * 55's lesson one ring out: a deny-list is a claim about every name the platform will ever use,
   * and it is wrong the first time a variable is added. Empty means *nothing is readable* and the
   * command refuses by name, telling the operator which variable to declare — fail closed, the
   * direction `APP_KNOWLEDGE_MIRROR_ROOT` also fails in.
   *
   * TD-020's `_FILE` convention is honoured on the declared name: declaring `GITLAB_TOKEN` also
   * permits `GITLAB_TOKEN_FILE`. Declaring the companion directly does not work, so
   * `APP_SECRET_KEY_FILE` is unreadable unless an operator declares `APP_SECRET_KEY`, which is a
   * thing they would have to type on purpose.
   */
  integrationSecretEnv: z.array(z.string().min(1)).readonly(),

  /**
   * The hosts a provider binding may name — `APP_INTEGRATION_HOSTS` (WP-51, PROGRESS backlog 48).
   *
   * **Operator-declared, empty by default, exact, and enforced twice.** Until WP-51 a binding's
   * host was whatever an `integration.write` caller typed into `config.base_url`, and the value was
   * handed to the client that binding's credential is built into — so an administrator who may name
   * a host and a credential *field*, and who by design never sees the credential's *value*, could
   * have the platform deliver it to a host they read. The audit could not tell the difference: a
   * token sent to an attacker's host is recorded exactly like a successful provider call.
   *
   * Empty (the default) means **no provider call leaves this process** and `POST /api/integrations`
   * refuses every host by name, which is the direction {@link integrationSecretEnv} and
   * {@link dependencyRegistryHosts} already fail in — three operator-declared lists on this process,
   * all closed until somebody declares something. `*` as the only entry declares it **open**, which
   * is rule 18's other permitted answer and is a thing an operator types on purpose.
   *
   * A malformed entry is dropped by {@link hostListFromEnv} rather than refused, for the reason
   * stated there — except `*`, which is a legal entry here and not a host.
   */
  integrationHosts: z.array(z.string().min(1)).readonly(),

  /**
   * The package-registry hosts the dependency gate may ask for a licence — `APP_DEPENDENCY_REGISTRY_HOSTS`
   * (WP-38, Q84, PROGRESS backlog 48).
   *
   * **Operator-declared, empty by default, and exact.** product/04:58 wants the dependency question
   * to carry *"license and maintenance status"* and the only honest way to get one is to ask a
   * registry; when this was written backlog 48 recorded that the process had no outbound allow-list
   * of any kind, so the answer took the shape {@link integrationSecretEnv} uses: nothing is called
   * unless an operator names it, and naming it is a thing they do on purpose. WP-51 closed backlog
   * 48 with {@link integrationHosts}, so there are now **two** egress lists on this process and the
   * separation is deliberate: this one governs a call with **no binding and no credential**, that
   * one a call made with an organisation's token. Empty (the default) means every package
   * is reported as *"licence not checked"* on the Checks panel — a stated non-answer rather than a
   * blank — and **no request leaves this process**.
   *
   * The two hosts this build knows what to ask are `registry.npmjs.org` and `pypi.org`
   * (`packages/infrastructure/src/dependencies/registry-metadata.ts`). A host that is not one of
   * them is simply never matched: it is not refused here, because a refusal would make a typo fatal
   * to start-up for a feature that is off by default, and the composition logs the set it was given.
   */
  dependencyRegistryHosts: z.array(z.string().min(1)).readonly(),

  argon2: argon2ConfigSchema,
  database: db.databaseConfigSchema,
  dispatch: eventing.dispatchConfigSchema,
  jobs: jobs.jobsConfigSchema,
});

/**
 * The SSE drain is one *step inside* the graceful shutdown, not a budget beside it.
 *
 * `preClose` waits up to `APP_SSE_SHUTDOWN_DRAIN_MS` for the slowest stream, and everything behind
 * it — the dispatcher's own drain, pg-boss, the pool — has to finish inside what is left of
 * `APP_SHUTDOWN_TIMEOUT_MS`. Both fields accept up to 600 000 independently, so they could be set
 * equal (or the drain set longer) and the outer bound would stop being a bound at all: the SSE
 * step alone would consume it and the process would be killed by whatever supervises it, mid-step,
 * with the jobs half never drained. That is exactly the failure bounding the drain was added to
 * prevent, one level up.
 */
export const serverConfigSchema = serverConfigFields.refine(
  (config) => config.sseShutdownDrainMs < config.shutdownTimeoutMs,
  {
    message:
      'must be less than APP_SHUTDOWN_TIMEOUT_MS: the SSE drain is one step inside the graceful shutdown, and the steps behind it (dispatch drain, jobs, the pool) need what is left of that budget',
    path: ['sseShutdownDrainMs'],
  },
);

export type ServerConfig = z.infer<typeof serverConfigSchema>;

export const SERVER_CONFIG_DEFAULTS = {
  role: 'all',
  port: 8080,
  host: '0.0.0.0',
  baseUrl: 'http://localhost:8080',
  logLevel: 'info',
  logFormat: 'json',
  timezone: 'UTC',
  allowSignUp: false,
  bootstrapAdminName: 'Administrator',
  sessionTtlDays: 7,
  sseBufferSize: 256,
  sseMaxQueuedFrames: 512,
  sseMaxTopics: 64,
  sseMaxBufferedTopics: 1_024,
  ssePingIntervalMs: 20_000,
  sseRetryMs: 1_000,
  sseMaxConnections: 1_000,
  sseShutdownDrainMs: 5_000,
  shutdownTimeoutMs: 30_000,
  bodyLimitBytes: 1_048_576,
  trustProxy: false,
  providerMode: 'api',
  // TD-025 §2's layout, and the path `compose.yml` mounts the `ctl` volume at in both containers.
  workspaceControlRoot: '/run/agentic/ctl',
  // The Anthropic API, which is what both provider modes authenticate against (measured, WP-53).
  modelEgressHosts: ['api.anthropic.com'],
  intakeReconcileIntervalMs: 60_000,
  argon2: { memoryCostKib: 19_456, timeCost: 2, parallelism: 1 },
} as const;

/**
 * The connections this process needs beyond the dispatcher's own floor.
 *
 * `createEventing` refuses a pool smaller than `2 × APP_DISPATCH_MAX_CONCURRENCY + 1`, and says in
 * its own message that this is "the floor for the dispatcher alone". It is: pg-boss runs its
 * workers, its supervision passes and the partition-maintenance cron **on the same pool**, and the
 * HTTP layer serves every request query from it too. A pool sized at exactly the dispatcher's
 * floor therefore starts, passes that check, and then stalls the first time a request and a sweep
 * want a connection at the same time — with `APP_DB_CONNECTION_TIMEOUT_MS` turning it into request
 * failures rather than a hang, which is better but still an outage.
 *
 * So the composition root adds its own floor on top, per workload it actually starts.
 *
 * **The whole sum, at the shipped defaults** (`ROLE=all`, `APP_DISPATCH_MAX_CONCURRENCY=1`), so
 * that nobody has to reassemble it from six docblocks:
 * `2 × 1 + 1` dispatch `+ 2` pg-boss `+ 7` pipeline workers `+ 4` knowledge workers
 * `+ 1` onboarding worker `+ 1` bootstrap worker `+ 2` HTTP `+ 1` maintenance = **21**, against
 * `.env.example`'s `APP_DB_POOL_MAX=22`. The *shape* is **`2N + 19`** since WP-36 registered
 * `maintenance.schedule` beside them, and the changes behind it are
 * worth keeping apart. WP-15b's arithmetic was `3N + 8` — a third connection per
 * dispatch, because the audit row opened a transaction inside the handler's; WP-15d removed that
 * nesting, so the term that scales with concurrency shrank from 3 to 2 and the shape became
 * `2N + 9`, which agreed with the old one at N=1 (both 11). WP-15c then added a **fourth** flat
 * job worker (`pipeline.intake.reconcile`), making it `2N + 10`, and WP-18a added the knowledge
 * index worker: `2N + 11` — 13 at N=1. WP-18b added the Librarian's three
 * (`knowledge.proposals`, `knowledge.apply`, `knowledge.hygiene`): `2N + 14` — 16 at N=1. WP-21
 * added `onboarding.discovery`: `2N + 15` — 17 at N=1. WP-32 added the digest tick
 * (`notify.digest`): `2N + 16` — 18 at N=1. WP-31 added `task.ask`: `2N + 17` — 19 at N=1. WP-35
 * added `bootstrap.history`: `2N + 18` — 20 at N=1, **and this paragraph was not updated with it**,
 * which is why the sum above read 19 while the floor was 20 (backlog 22's site 1, stale a third
 * time). WP-36 added the maintenance schedule (`maintenance.schedule`):
 * **`2N + 19`** — **21 at N=1**, and **27 at N=4** where `3N + 8` would have been 20. The shape crossing over at high concurrency is the honest consequence of flat
 * workers: they do not scale with dispatch, and they are real.
 *
 * **This paragraph is PROGRESS backlog 22's site 1, and it has now gone stale twice** — at WP-32
 * and at WP-31, both times with all three numbers wrong at once, in the paragraph written to stop
 * exactly that. The transferable half is recorded there: the sweep has to be driven from
 * {@link POOL_RESERVATIONS}, not from the diff, because half the sites are in files the change
 * already opened and the ones that get missed are in the *same file* as the ones that get fixed.
 * `config.test.ts` asserts the sum symbolically, so the numbers here are prose and only prose.
 */
export const POOL_RESERVATIONS = {
  /** pg-boss's workers, supervision and cron. */
  jobs: 2,
  /** Concurrent HTTP request queries — a floor, not a capacity plan. */
  http: 2,
  /** Readiness checks and partition maintenance, which must not queue behind request traffic. */
  maintenance: 1,
  /**
   * The pipeline's job workers — **one connection each** (WP-15b, recounted at WP-15d).
   *
   * `pipeline/runtime.ts` states the arithmetic: each worker holds one connection during each of
   * its transactions, and the composition root runs one of each at concurrency 1 —
   * `stage.execute`, `mr.comment.debounce`, `pipeline.outbound` (WP-15d), `notify.digest`
   * (WP-32, the digest tick, `exclusive` so one instance of it runs at a time) and `task.ask`
   * (WP-31, one ask-the-task question answered, `stately` per ask). It is counted here because
   * every `worker` role composes the pipeline.
   *
   * **Seven since WP-36**, and **two** of them are composed by `apps/server/src/pipeline.ts`
   * rather than by `createPipelineRuntime`, because each is a schedule the *process* owns rather
   * than a step of a ticket's journey (`registerPartitionMaintenance`'s shape):
   * `pipeline.intake.reconcile`, the pass that re-emits a matched ticket whose intake enqueue was
   * lost (PROGRESS backlog 20), and `maintenance.schedule`, the daily pass that creates
   * product/18:31's chore tasks (WP-36). Both are counted **unconditionally**, including when
   * `APP_INTAKE_RECONCILE_INTERVAL_MS=0` starts no reconciler at all: a reservation that shrank
   * with a setting would be a floor an operator could lower by accident.
   *
   * It is a **flat** term and not a per-dispatch one because every one of them makes its provider
   * calls *outside* a transaction of its own: the gate evaluator runs after its load transaction
   * has closed, the review window reads discussions after its own has, and the outbound queue
   * exists precisely to be the place where a provider call is not inside anything. An audit write
   * started from any of them therefore *replaces* the worker's connection rather than nesting
   * inside it.
   */
  pipeline: 7,
  /**
   * The knowledge workers — **one connection each, four of them** (WP-18a, recounted at WP-18b).
   *
   * `knowledge.index` is singleton per project and runs one at a time in this process
   * (`createKnowledgeIndexRuntime`). It holds a connection for its write transaction — the whole
   * replacement of a project's `kb_documents`, `kb_chunks` and `kb_links` — and for nothing else:
   * the part that takes time is the `git` fetch and the tree read, which happen **before** the
   * transaction opens, so no connection is held across a clone.
   *
   * **WP-18b added three more**, all at concurrency 1 and all composed by the same
   * `apps/server/src/knowledge.ts`: `knowledge.proposals` (curate one Librarian artifact),
   * `knowledge.apply` (the knowledge commit and its merge request) and `knowledge.hygiene` (the
   * nightly pass). Each holds one connection for its own write transaction, and the apply job's two
   * provider calls happen **outside** it — `integrations.forProject` and the executor both refuse to
   * run inside a transaction — so each is a flat term rather than a per-dispatch one, exactly like
   * the pipeline's four.
   *
   * Counted under `worker`, and unconditionally: the index job is registered even when
   * `APP_KNOWLEDGE_MIRROR_ROOT` is unset, because the refusal it then reports is the thing that
   * names the missing variable, and the librarian queues are started by every process that composes
   * a pipeline. A reservation that shrank with a setting would be a floor an operator could lower by
   * accident.
   */
  knowledge: 4,
  /**
   * The onboarding worker — **one connection**, at concurrency 1 (WP-21).
   *
   * `onboarding.discovery` records what a discovery run found: the readiness evaluation and the
   * drafted pages, in one write transaction. Everything before that transaction is a read — the
   * project row, the artifact, the index, and the git-provider call R9 needs — and both
   * `integrations.forProject` and the executor refuse to run inside a transaction, so the term is
   * flat like the pipeline's four and the knowledge base's four rather than per dispatch.
   *
   * Counted under `worker` and unconditionally, for the reason the other two are: a reservation
   * that shrank with a setting would be a floor an operator could lower by accident.
   */
  onboarding: 1,
  /**
   * The history bootstrap's worker — **one connection** (WP-35).
   *
   * One queue, `bootstrap.history`, carrying both halves of the job: the collection, which holds a
   * connection for the single transaction that creates the batch's tasks, and the recorder, which
   * holds one for the transaction that writes a run's proposals. They are one worker because they
   * cannot contend — every recording is caused by a run the collection started — so the term is one
   * rather than two (`JOB_QUEUES.historyBootstrap` carries the argument).
   *
   * Flat rather than per dispatch, for the reason the other four are: every provider read the
   * collection makes happens **outside** a transaction (`integrationsForProject` and the executor
   * both refuse to run inside one), so a read replaces the worker's connection rather than nesting
   * inside it.
   *
   * Counted under `worker` and unconditionally, for the reason the other three are: a reservation
   * that shrank with a setting would be a floor an operator could lower by accident.
   */
  bootstrap: 1,
  /**
   * The audit write a **dispatch** nests inside the handler's transaction — **zero since WP-15d**,
   * and this constant is the receipt.
   *
   * `CONNECTIONS_PER_DISPATCH` is 2: the dispatcher's own transaction plus the handler's. WP-15b
   * had to add a third, because `createPostgresIntegrationAuditLog` opens a transaction of its own
   * (`postgres-unit-of-work.ts` takes a second `pool.connect()`) and three handlers called a
   * provider from inside `context.scope.tx` — the intake branch check, the workpad and the status
   * mapping. That was the accommodation of a defect rather than a property of the design, and the
   * note here said so: *when it is fixed, this term goes to 0 rather than being quietly absorbed.*
   *
   * WP-15d fixed it. The three sites enqueue a `pipeline.outbound` job from
   * `HandlerContext.afterCommit` and the job makes the call, so **no handler's transaction contains
   * a provider call or an audit write**, and the per-dispatch term is back to
   * `CONNECTIONS_PER_DISPATCH`. While this reads 1, the shape is back: it is not a knob.
   *
   * **What is still true and is not counted here.** A handler may borrow a connection *transiently*
   * inside its transaction — `ProjectSettingsPort.forProject` is a `projects` query, and the status
   * mapping makes one. That is a read of the local database, not a connection held across a third
   * party's latency: it contends for a connection, it cannot stall on one, because every other
   * borrower in this process releases without waiting on a dispatch. The reservations above are
   * what cover it. Filed as discovered work; the honest fix is for the settings port to take the
   * caller's transaction.
   */
  auditPerDispatch: 0,
} as const;

/** The smallest `APP_DB_POOL_MAX` that can serve this configuration's workloads. */
export const requiredPoolConnections = (config: ServerConfig): number => {
  const capabilities = roleCapabilities(config.role);
  // `CONNECTIONS_PER_DISPATCH` rather than a literal 2: `createEventing` enforces its own floor
  // from that constant, and two readings of one number drift apart (standing rule 41).
  const perDispatch = CONNECTIONS_PER_DISPATCH + POOL_RESERVATIONS.auditPerDispatch;
  const dispatcher = capabilities.worker ? perDispatch * config.dispatch.maxConcurrency + 1 : 0;
  const jobsReserve = capabilities.worker ? POOL_RESERVATIONS.jobs : 0;
  const pipelineReserve = capabilities.worker ? POOL_RESERVATIONS.pipeline : 0;
  const knowledgeReserve = capabilities.worker ? POOL_RESERVATIONS.knowledge : 0;
  const onboardingReserve = capabilities.worker ? POOL_RESERVATIONS.onboarding : 0;
  const bootstrapReserve = capabilities.worker ? POOL_RESERVATIONS.bootstrap : 0;
  const httpReserve = capabilities.api ? POOL_RESERVATIONS.http : 0;
  return (
    dispatcher +
    jobsReserve +
    pipelineReserve +
    knowledgeReserve +
    onboardingReserve +
    bootstrapReserve +
    httpReserve +
    POOL_RESERVATIONS.maintenance
  );
};

/** Thrown at boot rather than deadlocking later; see `requiredPoolConnections`. */
export class UndersizedPoolError extends Error {
  readonly poolMax: number;
  readonly required: number;

  constructor(poolMax: number, required: number, role: string) {
    super(
      // The two counts are **interpolated**, not spelled: this message is PROGRESS backlog 22's
      // site 3 — the one that entry has twice called "genuinely derivable" — and at WP-31 it
      // crossed from un-derived to **false**, saying "five" beside a `POOL_RESERVATIONS.pipeline`
      // of 6, in the one sentence an operator reads at the moment the program refuses to start.
      `APP_DB_POOL_MAX is ${poolMax}, but ROLE=${role} needs at least ${required} connections: every in-flight dispatch holds two at once (its own transaction and the handler's), the sweep needs one to read with, and pg-boss, the pipeline's ${POOL_RESERVATIONS.pipeline} job workers, the knowledge base's ${POOL_RESERVATIONS.knowledge}, the onboarding worker, the partition-maintenance cron and every HTTP request query share the same pool. Raise APP_DB_POOL_MAX to ${required} or more, or lower APP_DISPATCH_MAX_CONCURRENCY.`,
    );
    this.name = 'UndersizedPoolError';
    this.poolMax = poolMax;
    this.required = required;
  }
}

/** Reads `NAME`, preferring the contents of the file named by `NAME_FILE`. */
const readSecret = (name: string, env: EnvLike): string | undefined =>
  db.readEnvWithFile(name, env);

/** Leaves anything unparseable in place so the schema reports it against the right variable. */
const numberFromEnv = (raw: string | undefined, fallback: number): unknown => {
  const value = raw?.trim();
  if (value === undefined || value === '') {
    return fallback;
  }
  return /^\d+$/.test(value) ? Number.parseInt(value, 10) : value;
};

/**
 * `z.stringbool()` semantics (TD-023) with an explicit fallback: `true/1/yes/on` and
 * `false/0/no/off`, case-insensitive. Anything else stays a string so the schema rejects it by
 * name rather than being read as `false` — a typo in a security flag must not read as "off".
 */
const booleanFromEnv = (raw: string | undefined, fallback: boolean): unknown => {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === '') {
    return fallback;
  }
  if (['true', '1', 'yes', 'on'].includes(value)) {
    return true;
  }
  if (['false', '0', 'no', 'off'].includes(value)) {
    return false;
  }
  return value;
};

const nullableString = (raw: string | undefined): string | null => {
  const value = raw?.trim();
  return value === undefined || value === '' ? null : value;
};

/**
 * A comma-separated list of environment-variable names, de-duplicated and in the order declared.
 *
 * Unparseable entries are **dropped rather than accepted**: this list is an allow-list, so the
 * failure direction that matters is admitting a name nobody meant. An entry that is not a plausible
 * variable name (`A-Z a-z 0-9 _`) cannot be one, and keeping it would only make the refusal message
 * quote something the operator never typed.
 */
const nameListFromEnv = (raw: string | undefined): readonly string[] => [
  ...new Set(
    (raw ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry)),
  ),
];

/**
 * A comma-separated list of hosts, lower-cased, de-duplicated and in the order declared.
 *
 * The same shape {@link nameListFromEnv} has and the same failure direction: an entry that is not a
 * plausible host (letters, digits, dots, hyphens — no scheme, no path, no port) is **dropped**,
 * because this is an allow-list and admitting `https://registry.npmjs.org/` as a host name would
 * make the comparison against the platform's own host silently never match, which reads as *"the
 * registry is down"* rather than as *"you typed a URL"*.
 */
const hostListFromEnv = (
  raw: string | undefined,
  /**
   * Whether `*` is a legal entry — `APP_INTEGRATION_HOSTS` only (WP-51).
   *
   * It is a parameter rather than a blanket allowance because the two lists mean different things
   * by it: an open provider allow-list is a posture an operator may deliberately choose (rule 18's
   * "explicitly declared open"), while an open *package-registry* list would be an instruction to
   * fetch metadata from anywhere, which nothing in the product wants and which
   * `APP_DEPENDENCY_REGISTRY_HOSTS` has no code path for — it matches two known hosts.
   */
  options: { readonly allowWildcard?: boolean } = {},
): readonly string[] => [
  ...new Set(
    (raw ?? '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(
        (entry) =>
          (options.allowWildcard === true && entry === '*') ||
          /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(entry),
      ),
  ),
];

export const loadServerConfig = (env: EnvLike = process.env): ServerConfig => {
  const problems: string[] = [];
  const collect = <T>(load: () => T): T | undefined => {
    try {
      return load();
    } catch (error) {
      problems.push((error as Error).message);
      return undefined;
    }
  };

  // The three sub-configurations throw their own one-line errors; collecting them means an
  // operator with two mistakes learns about both, instead of fixing one and restarting to find
  // the next.
  const database = collect(() => db.loadDatabaseConfig(env));
  const dispatch = collect(() => eventing.loadDispatchConfig(env));
  const jobsConfig = collect(() => jobs.loadJobsConfig(env));

  const result = serverConfigSchema.safeParse({
    role: env.ROLE?.trim() || SERVER_CONFIG_DEFAULTS.role,
    port: numberFromEnv(env.PORT, SERVER_CONFIG_DEFAULTS.port),
    host: env.HOST?.trim() || SERVER_CONFIG_DEFAULTS.host,
    baseUrl: env.APP_BASE_URL?.trim() || SERVER_CONFIG_DEFAULTS.baseUrl,
    secretKey: readSecret('APP_SECRET_KEY', env) ?? '',
    logLevel: env.LOG_LEVEL?.trim() || SERVER_CONFIG_DEFAULTS.logLevel,
    logFormat: env.LOG_FORMAT?.trim() || SERVER_CONFIG_DEFAULTS.logFormat,
    timezone: env.TZ?.trim() || SERVER_CONFIG_DEFAULTS.timezone,

    allowSignUp: booleanFromEnv(env.APP_ALLOW_SIGNUP, SERVER_CONFIG_DEFAULTS.allowSignUp),
    bootstrapAdminEmail: nullableString(env.APP_BOOTSTRAP_ADMIN_EMAIL),
    bootstrapAdminName:
      env.APP_BOOTSTRAP_ADMIN_NAME?.trim() || SERVER_CONFIG_DEFAULTS.bootstrapAdminName,
    bootstrapAdminPassword: nullableString(readSecret('APP_BOOTSTRAP_ADMIN_PASSWORD', env)),
    sessionTtlDays: numberFromEnv(env.APP_SESSION_TTL_DAYS, SERVER_CONFIG_DEFAULTS.sessionTtlDays),

    metricsUsername: nullableString(env.APP_METRICS_USERNAME),
    metricsPassword: nullableString(readSecret('APP_METRICS_PASSWORD', env)),

    sseBufferSize: numberFromEnv(env.APP_SSE_BUFFER_SIZE, SERVER_CONFIG_DEFAULTS.sseBufferSize),
    sseMaxQueuedFrames: numberFromEnv(
      env.APP_SSE_MAX_QUEUED_FRAMES,
      SERVER_CONFIG_DEFAULTS.sseMaxQueuedFrames,
    ),
    sseMaxTopics: numberFromEnv(env.APP_SSE_MAX_TOPICS, SERVER_CONFIG_DEFAULTS.sseMaxTopics),
    sseMaxBufferedTopics: numberFromEnv(
      env.APP_SSE_MAX_BUFFERED_TOPICS,
      SERVER_CONFIG_DEFAULTS.sseMaxBufferedTopics,
    ),
    ssePingIntervalMs: numberFromEnv(
      env.APP_SSE_PING_INTERVAL_MS,
      SERVER_CONFIG_DEFAULTS.ssePingIntervalMs,
    ),
    sseRetryMs: numberFromEnv(env.APP_SSE_RETRY_MS, SERVER_CONFIG_DEFAULTS.sseRetryMs),
    sseMaxConnections: numberFromEnv(
      env.APP_SSE_MAX_CONNECTIONS,
      SERVER_CONFIG_DEFAULTS.sseMaxConnections,
    ),
    sseShutdownDrainMs: numberFromEnv(
      env.APP_SSE_SHUTDOWN_DRAIN_MS,
      SERVER_CONFIG_DEFAULTS.sseShutdownDrainMs,
    ),

    shutdownTimeoutMs: numberFromEnv(
      env.APP_SHUTDOWN_TIMEOUT_MS,
      SERVER_CONFIG_DEFAULTS.shutdownTimeoutMs,
    ),
    bodyLimitBytes: numberFromEnv(
      env.APP_HTTP_BODY_LIMIT_BYTES,
      SERVER_CONFIG_DEFAULTS.bodyLimitBytes,
    ),
    trustProxy: booleanFromEnv(env.APP_TRUST_PROXY, SERVER_CONFIG_DEFAULTS.trustProxy),
    providerMode: env.APP_PROVIDER_MODE?.trim() || SERVER_CONFIG_DEFAULTS.providerMode,
    modelApiKey: nullableString(readSecret('ANTHROPIC_API_KEY', env)),
    modelOauthToken: nullableString(readSecret('CLAUDE_CODE_OAUTH_TOKEN', env)),
    claudeBinary: nullableString(env.APP_CLAUDE_BINARY),
    launcherUrl: nullableString(env.APP_LAUNCHER_URL),
    launcherToken: nullableString(readSecret('APP_LAUNCHER_TOKEN', env)),
    workspaceControlRoot:
      env.APP_WORKSPACE_CONTROL_ROOT?.trim() || SERVER_CONFIG_DEFAULTS.workspaceControlRoot,
    modelEgressHosts:
      env.APP_MODEL_EGRESS_HOSTS === undefined
        ? SERVER_CONFIG_DEFAULTS.modelEgressHosts
        : hostListFromEnv(env.APP_MODEL_EGRESS_HOSTS),
    knowledgeMirrorRoot: nullableString(env.APP_KNOWLEDGE_MIRROR_ROOT),
    webRoot: nullableString(env.APP_WEB_ROOT),
    integrationSecretEnv: nameListFromEnv(env.APP_INTEGRATION_SECRET_ENV),
    integrationHosts: hostListFromEnv(env.APP_INTEGRATION_HOSTS, { allowWildcard: true }),
    dependencyRegistryHosts: hostListFromEnv(env.APP_DEPENDENCY_REGISTRY_HOSTS),
    intakeReconcileIntervalMs: numberFromEnv(
      env.APP_INTAKE_RECONCILE_INTERVAL_MS,
      SERVER_CONFIG_DEFAULTS.intakeReconcileIntervalMs,
    ),

    argon2: {
      memoryCostKib: numberFromEnv(
        env.APP_ARGON2_MEMORY_KIB,
        SERVER_CONFIG_DEFAULTS.argon2.memoryCostKib,
      ),
      timeCost: numberFromEnv(env.APP_ARGON2_TIME_COST, SERVER_CONFIG_DEFAULTS.argon2.timeCost),
      parallelism: numberFromEnv(
        env.APP_ARGON2_PARALLELISM,
        SERVER_CONFIG_DEFAULTS.argon2.parallelism,
      ),
    },

    // Placeholders when a sub-loader failed: the schema would report them as missing and bury the
    // real message, so they are filled in and the collected problem is reported instead.
    database: database ?? PLACEHOLDER.database,
    dispatch: dispatch ?? PLACEHOLDER.dispatch,
    jobs: jobsConfig ?? PLACEHOLDER.jobs,
  });

  if (!result.success) {
    for (const issue of result.error.issues) {
      const field = String(issue.path[0] ?? '');
      problems.push(
        SOURCE_VARIABLE[field] === undefined
          ? `${issue.path.join('.')} ${issue.message}`
          : `${SOURCE_VARIABLE[field]} ${issue.message}`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(`invalid server configuration: ${problems.join('; ')}`, {
      cause: result.success ? undefined : result.error,
    });
  }

  const config = result.data as ServerConfig;

  // Both halves of the metrics credential or neither: a username with no password is an
  // authentication check that always fails, and a password with no username is one that is never
  // applied — the second silently exposes the endpoint the operator meant to close.
  if ((config.metricsUsername === null) !== (config.metricsPassword === null)) {
    throw new Error(
      'invalid server configuration: APP_METRICS_USERNAME and APP_METRICS_PASSWORD must be set together (or both left unset to serve /metrics without authentication)',
    );
  }

  if (config.bootstrapAdminEmail !== null && config.bootstrapAdminPassword === null) {
    throw new Error(
      'invalid server configuration: APP_BOOTSTRAP_ADMIN_EMAIL is set but APP_BOOTSTRAP_ADMIN_PASSWORD (or _FILE) is not; the bootstrap administrator needs a password',
    );
  }

  const required = requiredPoolConnections(config);
  if (config.database.poolMax < required) {
    throw new UndersizedPoolError(config.database.poolMax, required, config.role);
  }

  return config;
};

/**
 * Values used only to keep the schema from reporting a missing sub-object when its own loader has
 * already produced a better error. They are never returned: `loadServerConfig` throws first.
 */
const PLACEHOLDER = {
  database: {
    url: 'postgres://placeholder',
    appRole: '',
    poolMax: 1,
    connectionTimeoutMs: 1_000,
    partitionMonthsAhead: 0,
    transcriptRetentionDays: null,
  },
  dispatch: eventing.DISPATCH_CONFIG_DEFAULTS,
  jobs: jobs.JOBS_CONFIG_DEFAULTS,
} as const;

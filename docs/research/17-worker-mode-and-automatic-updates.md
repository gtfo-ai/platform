# Research 17 — worker mode and automatic updates: the facts TD-031 and TD-032 rest on

Gathered by the architect's research agents, session 21, retrieved **2026-11-04**. Every line carries its
source. Quotes were extracted through a fetch tool and are to be re-checked verbatim by the row that
first relies on them (docs/TODO.md § Verification). Nothing here was run against Docker or a model.

## 1. The Agent SDK's usage-limit signal (for TD-031 decision 11)

- `SDKRateLimitEvent` is part of the `SDKMessage` union: `type: "rate_limit_event"`, `rate_limit_info:
  { status: "allowed" | "allowed_warning" | "rejected"; resetsAt?: number; utilization?: number;
  errorCode?: "credits_required"; … }`, "Emitted when the session encounters a rate limit."
  — https://code.claude.com/docs/en/agent-sdk/typescript.md
- **Not documented:** the unit of `resetsAt`; whether a five-hour or weekly subscription rejection uses
  `status: "rejected"`; any `rateLimitType` field. `[unverified]` — TODO V-WM1.
- `errorCode: "credits_required"`: "the rejection is from a claude.ai subscription whose included usage
  is exhausted, and the session cannot continue until the user buys usage credits." — same page.
- `SDKAssistantMessage.error` may be `'rate_limit'` ("a 429 against your quota"); the result message
  carries `api_error_status`, and no `terminal_reason` value names a usage limit; no reset time is on the
  result. — https://code.claude.com/docs/en/agent-sdk/agent-loop.md, typescript.md
- "Claude Code fails at once when a standard-speed request gets a `429` that reports a spend limit or
  exhausted usage credits." — https://code.claude.com/docs/en/errors.md (which also documents the CLI's
  text *"You've hit your session limit · resets 3:45pm"*; whether that text reaches SDK output is not
  documented).
- **Asking before a run:** `/usage` sent as a prompt yields a `usage_report` (experimental), **but** "A
  `claude setup-token` token passed as `CLAUDE_CODE_OAUTH_TOKEN` doesn't qualify by default, because it
  carries only the `user:inference` scope." — typescript.md (SDKUsageReport). **Consequence:** a worker
  cannot ask its remaining usage; it learns the limit from a rejection and remembers the reset.

## 2. `claude setup-token`

- "generate a one-year OAuth token with `claude setup-token`"; scope `user:inference`; "requires a Pro,
  Max, Ultra, Team, or Enterprise plan"; documented for "CI pipelines, scripts, or other environments
  where interactive browser login isn't available". — https://code.claude.com/docs/en/authentication.md
- Bare mode does not read `CLAUDE_CODE_OAUTH_TOKEN` (already in research/04; repeated on the same page).

## 3. Anthropic's terms — the open question Q123

- "Developers building products or services that interact with Claude's capabilities, including those
  using the Agent SDK, should use API key authentication … Anthropic does not permit third-party
  developers to offer Claude.ai login into their own applications, or to route requests through Free,
  Pro, Max, or Ultra plan credentials on behalf of their users." —
  https://code.claude.com/docs/en/legal-and-compliance.md (Authentication and credential use)
- "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login
  or rate limits for their products, including agents built on the Claude Agent SDK." —
  https://code.claude.com/docs/en/agent-sdk/overview.md
- Consumer Terms §3 item 7 prohibits access "through automated or non-human means, whether through a
  bot, script, or otherwise" except "via an Anthropic API Key or where we otherwise explicitly permit
  it". — https://www.anthropic.com/legal/consumer-terms
- **Not documented:** whether an organisation's self-hosted platform may run agents for its own staff on
  each staff member's own subscription token. The legal page routes such questions to
  https://www.anthropic.com/contact-sales. **Reading (architect, not legal advice):** the text is at best
  ambiguous for Pro/Max and points towards API keys for "products or services"; Team/Enterprise seats
  sit under commercial terms not read here.

## 4. docker-socket-proxy (TD-032 § the updater's Docker access)

- Sections and defaults: `EVENTS`, `PING`, `VERSION` on; `POST`, `AUTH`, `SECRETS` off ("Maximum
  caution"); `CONTAINERS`, `IMAGES`, `INFO`, `NETWORKS`, `VOLUMES`, `ALLOW_START/STOP/RESTARTS`, … off. —
  https://raw.githubusercontent.com/Tecnativa/docker-socket-proxy/master/README.md
- **No filtering by label or compose project**: every rule is a path regex plus a flag
  (`haproxy.cfg`, e.g. `http-request allow if { path,url_dec -m reg -i ^(/v[\d\.]+)?/containers } { env(CONTAINERS) -m bool }`).
  With `CONTAINERS=1 POST=1` any container create body is admitted.
- Latest release **v0.5.0 (2026-07-27)**; `compose.yml` pins **0.3.0** (2024-09-09). Apache-2.0, not archived.

## 5. Docker Compose as the updater's tool

- Compose v5.7.0 (2026-11-02) calls containers (list/inspect/create/start/stop/remove/rename/wait/logs/
  attach), networks, volumes, images (inspect/pull), events, and `Info` (`isSwarmEnabled`,
  `pkg/compose/compose.go:466`). Proxy flags needed: `CONTAINERS NETWORKS VOLUMES IMAGES INFO POST` plus
  the defaults. — docker/compose source at v5.7.0 (grep, `pkg/compose`). Running Compose through the proxy
  is **not documented** anywhere official; `[unverified]` — TODO V-WM2 (a Docker check measures it).
- `docker compose up --wait` "Wait for services to be running|healthy"; `--wait-timeout` "Maximum
  duration in seconds". — https://docs.docker.com/reference/cli/docker/compose/up/
- **Recreate order** `CreateContainer(tmpName) → StopContainer → RemoveContainer → RenameContainer`
  (`reconcile.go:1616`): a container running `compose up` on **its own** service stops itself at step 2
  and leaves the successor under a temporary name. Hence TD-032's one-shot *apply* container outside the
  services it replaces.
- Watchtower's self-update renames itself and starts a successor (`internal/actions/update.go`);
  containrrr/watchtower is **archived** (announced 2025-12-17). No established compose-aware updater with
  rollback was found (nicholas-fedor/watchtower fork: no rollback; ouroboros: unmaintained; diun:
  notify only; docker-rollout: health-gated deploy, no rollback). — GitHub API, 2026-11-04.
- Binaries (linux/amd64): docker CLI 29.9.3 ≈ 44.3 MB (static tarball
  https://download.docker.com/linux/static/stable/x86_64/docker-29.9.3.tgz); compose plugin v5.7.0
  ≈ 34.1 MB (GitHub release asset). Both Apache-2.0.

## 6. Tag → digest without pulling

- OCI distribution spec: `HEAD /v2/<name>/manifests/<reference>` "MUST contain the digest … in the header
  `Docker-Content-Digest`" (older registries may not). —
  https://github.com/opencontainers/distribution-spec/blob/main/spec.md
- GHCR anonymous flow, measured live: `401` with `www-authenticate: Bearer realm="https://ghcr.io/token"…`;
  `GET https://ghcr.io/token?scope=repository:<name>:pull` → token; `HEAD` with the token and the OCI index
  `Accept` → `200` + `docker-content-digest` (the index digest a multi-arch pin uses).

## 7. RFC 8628 (device authorization grant), the shape TD-031 decision 10 borrows

- Device authorization request → `device_code`, `user_code`, `verification_uri`, `expires_in`,
  `interval`; the client polls the token endpoint and receives `authorization_pending`, `slow_down`,
  `access_denied` or `expired_token`. — https://www.rfc-editor.org/rfc/rfc8628 §3.2, §3.5. The platform
  borrows the shape, not OAuth: no client registration, no scopes, the token is a platform worker
  credential (TD-022's auth, BD-004 untouched).

## 8. A CDN proxy in front of the core (Autix deployment input)

- Cloudflare's proxied HTTP idle/response timeout is about 100 s (owner's statement; the 524 error
  documentation describes the 100-second limit — https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/).
  `[unverified]` beyond that page — TODO V-WM3. TD-031 keeps every held request ≤ 25 s.

## 9. Fastify's `trustProxy` (for the widened `APP_TRUST_PROXY`, TD-031 decision 10c)

- Fastify's server option `trustProxy` accepts `true`/`false`, a string of comma-separated addresses or
  CIDR ranges, an array of them, a hop count, or a function. — https://fastify.dev/docs/latest/Reference/Server/#trustproxy
  (architect's reading, session 21, not fetched in this pass: `[unverified]`, re-read by WP-280 before it
  widens the variable; TODO V-WM7).

## 10. Publishing a container port to loopback only (TD-031's worker-UI amendment)

- A port published without a host address is published **on all host addresses**, IPv4 and IPv6;
  `-p 127.0.0.1:8080:80` (or `[::1]`) means *"only the Docker host can access the published container
  port"*. Caveat on the same page: **before Docker Engine 28.0.0**, hosts on the same L2 segment could
  reach ports published to localhost. — https://docs.docker.com/engine/network/port-publishing/
  (fetched 2026-11-04, architect, session 22).
- Consequence used by the amendment: the process inside the container must listen on the container's
  own interface (a listener on the container's `127.0.0.1` is unreachable through any publish), so the
  loopback restriction lives in the compose publish line, and the token is what holds on an engine
  older than 28.0.0.
- DNS rebinding: a page on an attacker's name that re-resolves to `127.0.0.1` reaches a loopback port
  with **its own name in the `Host` header**, so an exact `Host` allow-list refuses it.
  `[unverified]` here (general web-security knowledge, no page fetched in this pass; TODO V-WM9).

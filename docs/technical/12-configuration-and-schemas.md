# 12 — Configuration and schemas

> Round 2 design. Sources: product/12, product/04, product/13, product/18, BD-014, BD-020, BD-025. Concrete schema files (JSON Schema / zod) are produced by the implementer from this document; this is the contract.

## Environment variables (12-factor)

Neutral names, no product prefix for standard variables; `APP_` for product-specific ones (BD-014: rename-friendly). All have documented defaults in `.env.example`; only secrets have none.

**`.env.example` is the instance's configuration surface, and since WP-50 that is true of a compose instance too.** `compose.yml` gives the `app` and `migrate` services `env_file: .env`, so a name declared here reaches the process; before that the service carried a hand-written eighteen-name `environment:` map and twenty of the names the server reads never arrived, which made TD-020's `_FILE` convention unusable and left `APP_INTEGRATION_SECRET_ENV` — the allow-list `POST /api/integrations` reads — permanently empty on a stock instance. Two consequences are part of the contract: the three build-metadata names (`APP_VERSION`, `APP_COMMIT`, `APP_BUILT_AT`) are **commented out** in `.env.example`, because the image bakes them as `ENV` and an empty value in `.env` would override it; and a missing `APP_SECRET_KEY` is refused by `loadServerConfig` rather than by compose's interpolation, which is what allows an instance to be configured with `APP_SECRET_KEY_FILE` alone.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP port (API + UI + SSE) |
| `DATABASE_URL` | `postgres://app:app@db:5432/app` | Postgres |
| `LOG_LEVEL` | `info` | pino/structured logging level |
| `LOG_FORMAT` | `json` | `json | pretty` |
| `TZ` | `UTC` | organisation default timezone seed |
| `APP_BASE_URL` | `http://localhost:8080` | absolute links in tickets/Slack |
| `APP_SECRET_KEY` | — (secret) | session signing, encryption of integration secrets at rest |
| `APP_PROVIDER_MODE` | `api` | `api | local` (BD-004) |
| `ANTHROPIC_API_KEY` | — (secret, `api` mode) | passed only to the runner process |
| `CLAUDE_CODE_OAUTH_TOKEN` | — (secret, `local` mode) | **read by the server since WP-53** (PROGRESS backlog 128; it had no reader at all before). Both modes run the same pinned `claude` in the run container, so the mode chooses only which credential the run's environment carries; `agentRunEnvironment` puts it there with its name in `secretEnvNames`, so TD-012 step 1's redactor covers it. A `local`-mode process without it composes **no agent runner** and names the missing credential |
| `APP_LAUNCHER_URL` | unset | TD-028's control plane — the launcher's address on the internal network. **With `APP_LAUNCHER_TOKEN` it is what makes a worker run agent stages**, and the `stage.execute`/`task.ask` queues are subscribed only when both are set (decision 5); with neither, those jobs queue rather than fail. Exactly one of the two set is a startup refusal naming the other. `http(s)` only, no credentials in the URL |
| `APP_LAUNCHER_TOKEN` | — (secret) | at least 32 characters, compared in constant time on every control-plane request **in addition to** the network isolation. Unset *on the launcher* exposes no control plane at all rather than an unauthenticated one |
| `APP_LAUNCHER_PORT` | `7780` | the launcher's listener. Never published to the host |
| `APP_LAUNCHER_HOST` | `0.0.0.0` | the launcher's bind address; the network is the isolation |
| `APP_MODEL_EGRESS_HOSTS` | `api.anthropic.com` | hosts a run container may reach besides its git host. Needed in **both** provider modes (WP-53 measured the CLI authenticating against the same API either way). Empty fails closed |
| `APP_RUN_REGISTRY_HOSTS` | unset (**closed**) | comma-separated package-registry hosts a **run container** may reach (WP-82, PROGRESS backlog 140). Joined to a run's egress list **only** when the run may install from a lockfile — it holds `Bash` and its effective `allow` still carries a `LOCKFILE_INSTALL_ALLOW` entry, which the `verification` and `implementation` baselines do — and **never** for a `read_only` run. Exact host names, lowercased; a URL, a port or `*` is a **start-up refusal** naming the entry (WP-82 review round 1), never a silent drop that would leave the list closed. **Not settable through the API** or by a project. Unset keeps a run from installing anything: the sidecar refuses the request (403). Every process in the container can reach a declared host, so a private mirror is the narrower declaration. Separate from `APP_DEPENDENCY_REGISTRY_HOSTS` (what the server may ask for a licence) |
| `APP_WORKSPACE_RUNTIME_CLI_PATH` | `/usr/local/bin/claude` | where the `claude` binary is **inside the run image** (PROGRESS backlog 34). The launcher verifies it against the image with `test -x` before the first run and refuses by name |
| `APP_CLAUDE_BINARY` | bundled | path to a `claude` binary in `local` mode |
| `APP_WEB_ROOT` | the image's own `/app/apps/web/dist` | **absolute** directory the API process serves the built SPA from, at `/` and on the same origin as `/api` and `/events` (technical/09, WP-15j). Unlike `APP_KNOWLEDGE_MIRROR_ROOT` it *has* a default, because it names a part of the image rather than a data volume an operator has to choose — `docker/app.Dockerfile` writes it and `apps/server/src/web/bundle.ts` states it once. Set it to serve a patched bundle from a mounted volume. A directory that is not there is named in a warning at start-up and changes nothing else: the API, `/healthz` and `/readyz` are unaffected and every client path answers the JSON 404 an unmatched path answers. Only a role that serves the API serves it |
| `APP_KNOWLEDGE_MIRROR_ROOT` | unset | **absolute** path where the platform keeps its own bare mirror per project, which the knowledge indexer reads with git plumbing (TD-026). **Unset composes no `VaultSource`** and the index job refuses by name; it never defaults to a path, and a relative one is refused. The directory must exist and be writable by the process — it is never created. Two further requirements the operator supplies rather than the platform: **`git` on the process' `PATH`** (probed at composition; when it is missing the index job refuses naming `git`, like the variable), and a **git binding on the project**, whose existing credential the fetch authenticates with through a credential helper — never in the URL, and never anonymously. `projects.repo_url` must be an `https://`, `http://` or `file://` URL: git's scp-style `git@host:acme/api.git` is **refused** (the form carries no scheme, and it names an SSH remote whose key this platform does not hold), so a project written that way indexes to a permanent `vault_unavailable` naming the scheme — other parts of the platform do accept that spelling, and this is the one place it is not enough. Distinct from the launcher's `APP_WORKSPACE_CACHE_VOLUME`, which only the launcher can advance |
| `APP_KNOWLEDGE_MIRROR_MAX_BYTES` | unset | a positive integer: the ceiling on the knowledge mirrors' total **bytes** under `APP_KNOWLEDGE_MIRROR_ROOT` (WP-65, Q63). **Unset is no ceiling**, the default on purpose — removing a mirror costs its project a full re-clone on its next index run. When set, after each index run the mirror **used least recently** is removed until the total is under it: by last use (a read stamps the mirror before it runs git and again once prepared), never by age, never the mirror just read and never one used within the last hour. Anything that is not a positive integer refuses to start, naming the variable. Choose it from the storage gauge — `platform_storage_bytes{component="knowledge_mirrors"}` and `knowledge_mirror_bytes{project_id}` on `/metrics` |
| `APP_JOBS_SCHEMA` | `pgboss` (**fixed**) | the schema pg-boss lives in. **The value is fixed since WP-106** (PROGRESS backlog 296, option (b)): `migrate` installs pg-boss, declares every job queue and grants the app role in `pgboss` and reads no variable for another schema, so every process that reads this one — each server role at start, and `migrate` itself — **refuses to start** on any other value, naming the variable and `migrate`. Unset or `pgboss` starts. Before WP-106 the server read it and nothing `migrate` runs did; an operator who changed it would, by a reading of pg-boss's code that was never run, have met pg-boss's own *"pg-boss is not installed"* at start |
| `APP_INTEGRATION_HOSTS` | unset (**closed**) | comma-separated hosts a provider binding may name (WP-51, PROGRESS backlog 48). **Not settable through the API** — a list a caller can extend is not a list. Enforced twice: `POST /api/integrations` (and, since WP-100, `PATCH /api/integrations/:id` and a binding's overlay) refuses an undeclared host with `403 integration_host_not_permitted` naming the host and this variable, and `IntegrationActionExecutor` refuses the *call*, so a row written before the list existed cannot slip past. Matching is exact and case-insensitive on the host alone: no port, no path, no subdomain wildcard, punycode as written. Unset or empty means **no provider call leaves the process**, which is rule 18's fail-closed answer; a single `*` declares the list open. It checks names, never the addresses they resolve to |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | `1` | set on runner processes (research/04) |
| `DISABLE_AUTOUPDATER` | `1` | runner processes `[verify name in research/05]` |

Secrets may also be provided as files via `*_FILE` variants (Docker secrets convention).

**Removed at WP-73, because nothing read them** (PROGRESS backlog 127; each was in `.env.example` and in
this table, and a documented name that does nothing is one an operator acts on). Where each behaviour
lives instead:

- `APP_WORKSPACE_ROOT` — a run's workspace is the launcher's, configured by its own `APP_WORKSPACE_*`
  variables (`apps/launcher/src/config.ts`). The name also *broke* a launcher handed the file, whose
  strict schema refuses an unknown `APP_WORKSPACE_*` name.
- `APP_TRANSCRIPT_STORE` — transcripts are stored in the database (`run_messages`, technical/03) and
  nowhere else; this build has no file or object-store backend.
- `APP_RUNNER_MAX_PARALLEL` — the organisation's parallel-run limit is `DEFAULT_WIP_LIMITS`
  (`packages/domain/src/policies/wip.ts`), which nothing on this build lets an operator change. The
  two **per-project** limits are `pipeline.wip` in the configuration below (WP-91).
- `APP_WEBHOOK_PUBLIC_URL` — the webhook URL an integration's setup guide publishes is built from
  **`APP_BASE_URL`** (`<APP_BASE_URL>/webhooks/<provider>/<integration_id>`, the operator guide's
  § The webhook URL). A task-management binding with no webhook starts tickets only if it **polls**
  (`poll_enabled` in its configuration, WP-87, PROGRESS backlog 187); the poller's sweep interval is
  `APP_TICKET_POLL_SWEEP_INTERVAL_MS`.
- `APP_DISABLE_TELEMETRY` — this build sends nothing anywhere, so there is nothing to disable.
- `APP_FEATURE_*` (five flags) — **decided at WP-73: deleted rather than built.** The file said the
  instance value was a ceiling on what a project may enable; no code enforced it, and a project's own
  `features` block in `.agentic/config.yml` (below) is the only switch anything reads. An
  instance-wide ceiling would be a product decision (how the two values combine per flag, and how a
  refused project request is surfaced), not a line in a file.

`test/e2e/compose/compose-config.e2e.test.ts` holds the file to the server's reads in both
directions, so a name added back without a reader fails there.

## The organisation settings document (`organizations.settings`, `GET/PATCH /api/org`)

Listed first because every other layer is held to it: it is the `org` layer of the effective configuration below, and
each of its keys is a **maximum** a project and a repository may state less than, or an organisation-scoped default
(WP-93, PROGRESS backlogs 146 (2), 223, 235 and Q103 (c)). It is **not** part of `.agentic/config.yml`, and no
repository can state any of it. `GET /api/org` reads it (`org.read`); `PATCH /api/org` writes it — admin only
(`org.settings.write`), one `human_actions` row per accepted request (`org.settings.write`, with the sections changed
and each one before and after, redacted), `Idempotency-Key` optional and honoured. The JSON Schema is
`schemas/organisation-settings.schema.json`, generated from `organisationSettingsSchema`.

```yaml
commands:                     # the command maximum (BD-025 §2) — same shape as a project's list
  allow: ["git status", "pnpm test"]
  block: ["curl *"]
autonomy:
  maximum: supervised         # observe | assist | supervised | autonomous — the highest dial position
pipeline:
  wip:                        # the WIP maximum (WP-91) — a project's pipeline.wip may state less
    max_parallel_tasks: 2
    max_tasks_in_pipeline: 5
notifications:
  quiet_hours: { from: "22:00", to: "07:00" }   # the organisation's zone (TZ); may wrap midnight
  digest_at: "09:00"                           # when the organisation's digest posts (default 09:00)
  organisation_default: <integration id>        # the chat account that speaks for the organisation (Q103 (c))
```

- **Strict, and parsed at every read.** An unknown key is an error, and a stored document the schema refuses is a
  named refusal carrying the key paths and the values (redacted, bounded): `409 invalid_organisation_config` on every
  route that reads it, and a refusal of every run and settings read that needs it — never an empty document, never a
  cast (standing rule 20). `PATCH` validates the merged document with the same schema, so a value the readers would
  refuse is refused at the write; a write that leaves a broken section in place is refused too, and replacing or
  removing that section repairs it.
- **`PATCH` replaces sections.** Each top-level key present replaces the stored section, `null` removes it, an absent
  one is kept; the write is a read-modify-write under the row's lock, so two administrators replacing different
  sections both land.
- **A lowered maximum applies at the next read, and moves nothing that is frozen** (the WP-93 ruling, stated rather
  than decided per case). The next run's command policy is intersected with the new list; the next settings read caps
  a project's dial at the new autonomy maximum (`capMaterialisedAutonomy`: the capped position's preset from this
  release's table, because the project never chose it); the next admission counts against the new WIP bound. A task's
  frozen dial (`tasks.pipeline_dial`, migration 0049) is not moved, and no project's stored choice is rewritten, so
  raising the maximum again restores it. `PUT …/autonomy` above the maximum is `409 autonomy_above_organisation`;
  `GET …/autonomy` publishes `organisation_maximum` and `level_in_force` beside the chosen `level`.
- **Quiet hours** defer a non-urgent organisation notification (`budget_threshold`) into the organisation's digest at
  `digest_at`; `budget_exhausted` is urgent (product/18:33) and posts at once. The organisation digest exists only
  while quiet hours are stated. With no window, everything posts at once, as before WP-93.
- **`organisation_default`** must name a communication account (`409 organisation_default_not_communication`). With
  two or more accounts that each name a channel of their own, the flagged one speaks for the organisation and the others
  are not built; Q103's refusal applies only when none is flagged. A flag that points at an account which no longer
  exists, or at one whose own config names no channel, refuses the notification by name. It is a pointer in this
  document rather than a boolean on each account, so "exactly one is flagged" is a property of the shape.

## `.agentic/config.yml` (repository, non-secret, highest precedence for non-secret keys)

```yaml
version: 1                      # schema version; the platform refuses unknown majors
project:
  knowledge_dir: .agentic/knowledge
  context_budget_tokens: 12000   # tiers 0-1 of a run's context pack (product/05, technical/07)
  communication_language: auto   # auto | en | cs | ...
  commit_convention: conventional
  default_branch: main
pipeline:
  template_overrides:            # per template; only plan_approval / size_threshold are read (below)
    feature:
      stages:
        architecture: { plan_approval: above_size, size_threshold: L }
    bug:
      stages: { architecture: { plan_approval: always } }
  custom_stages: []              # parses; not read on this build (below)
  limits:
    code_review_iterations: 3
    business_review_iterations: 2
    ci_fix_iterations: 3
    human_rounds: 3
    rebase_attempts: 2           # conflict-resolution runs per MR (product/04 S6b)
    rebase_rechecks: 10          # gate re-checks: the default branch moving (WP-26), and the rebase gate re-entering ci_gate for a head CI never passed (WP-79)
    question_timeout: 1 working day
  wip:                           # BD-010's per-project WIP limits (WP-91); each 1..50 / 1..200
    max_parallel_tasks: 2        # tasks moving through stages at once
    max_tasks_in_pipeline: 5     # tasks in the pipeline at all, waiting ones included (never below the line above)
stages:                          # per-stage agent settings
  refinement: { model: claude-opus-5, effort: medium, max_turns: 30, budget_usd: 2 }
  architecture: { model: claude-opus-5, effort: high, budget_usd: 5 }
  implementation: { model: claude-opus-5, effort: high, max_turns: 200, budget_usd: 15,
                    prompt: prompts/implementation.md, prompt_append: prompts/implementation.append.md }  # data blocks that add to the role prompt, never replace it (below)
  code_review: { model: claude-opus-5, effort: high }
policies:
  autonomy: supervised           # observe | assist | supervised | autonomous — overridden only by
                                 # probation_tasks, knowledge_apply.auto_apply and pipeline.limits'
                                 # human_rounds / question_timeout (Q78, WP-62)
  probation_tasks: 5
  knowledge_apply: { auto_apply: false, discard_below: 0.2, proposal_above: 0.6 }
  dependency_policy:             # or the shorthand `dependency_policy: ask`, which means the same
    default: ask                 # allow | ask | block
    ecosystems: { npm: block }   # per ecosystem; keys: npm | pypi | go | cargo (what a diff is read for)
    allowlist: ["npm:@scope/pkg"]  # "<ecosystem>:<name>" — proceeds whatever the policy says
  drift_without_direction: disabled
  protected_paths: ["tests/**", ".gitlab-ci.yml", ".agentic/**", ".claude/**", "CLAUDE.md"]
  risk_classes:
    auth: { paths: ["**/auth/**", "**/session/**"], require: [plan_approval, reviewer:@security] }
    migrations: { paths: ["**/migrations/**"], require: [plan_approval] }
    payments: { paths: ["**/payment*/**"], require: [plan_approval, "checklist:payments"] }
  review_checklists:             # named review items a class selects with checklist:<name> (Q83, WP-45); add-only, none shipped
    payments: ["Amounts are integer minor units, never floats", "Every charge path is idempotent on a caller-supplied key"]
commands:                        # BD-025 three-list policy: `allow` narrows the role baseline's project commands only (Q97); ask/block only grow
  allow: ["npm test", "npm run lint", "make test", "pytest *"]
  ask: ["npm install *", "pip install *"]
  block: ["rm -rf /", "git push --force*", "docker *"]
features:
  ticket_linter: { enabled: false, issue_types: [Story, Task, Bug], label: agentic }   # WP-25
  review_only: { enabled: false, trigger: label, label: agentic-review, paths: [], severity_floor: major, max_findings: 10 }
  maintenance: { enabled: false, schedule: "weekly", budget_usd: 20, chores: [deps, flaky, docs] }
  digest: { enabled: true, at: "09:00", quiet_hours: null, urgent: [escalation, budget_exhausted] }   # WP-32
  shadow_mode: { enabled: false }   # M3; added in WP-01 from product/18-19
status_mapping:                  # task state -> ticket status name (provider-specific names)
  refinement: "In Refinement"
  waiting_answers: "Waiting for input"
  implementation: "In Progress"
  ready_for_merge: "In Review"
  done: "Done"
```

**Path patterns** (`protected_paths`, `risk_classes.*.paths`, `features.review_only.paths`, a plan's `protected_path_changes` and a review's confirmations) share one syntax, compiled by `pathPatternToRegExp` in `packages/domain/src/policies/path-patterns.ts`: `*` and `?` stay inside one path segment; `**` crosses separators; **`**/` matches zero or more directories** (amended at WP-81 — until then it demanded at least one, so `**/*.test.*` missed a root-level `totals.test.ts`, and `src/**/*.ts` missed `src/index.ts`); and a pattern naming a directory (`infra`, `infra/`, `infra/**`) covers it and everything under it. The workspace's path guard folds case and Unicode on both sides before matching; the CI gate's tamper check and the review-only filter compare bytes.

Secrets are never accepted from the repo. Unknown keys are errors (fail loudly, BD: product/12 validation). The UI shows the effective value per key with its source.

**How the platform reads this file** (WP-63, Q94; before it, nothing did — PROGRESS backlog 44). The file is read from the project's **default branch** only (BD-025 §1), through the platform's own bare mirror (TD-026; `createGitRepositoryFileSource`, which reads three named paths outside the indexed vault — this file, `CLAUDE.md` and `AGENTS.md` — plus, since WP-92, the direct `<name>.md` children of `.agentic/prompts/`, and refuses any other), pinned to the commit of every knowledge index run and on demand by `POST /api/projects/:project_id/config/refresh`. It is untrusted input: bounded at 64 KiB before it is read, parsed as YAML 1.2 (core schema, alias ceiling, duplicate keys refused, no `<<` merge keys) and held to the strict schema above. The last reading is `project_repository_config` (migration 0050) — `absent`, `valid` or `invalid` — and a reading that cannot reach the repository changes nothing. A **`valid`** file is the `repo` layer below. An **`invalid`** one is a named refusal carrying the key paths it failed on: `GET /api/projects/:project_id/config` answers `409 invalid_repository_config`, and **no run of the project starts** (the stage is escalated to `needs_human`, an ask is refused) until a later reading parses — the platform does not run on the settings alone or on an older reading, because the file on the default branch *is* the project's statement of its rules. **The file may tighten, never loosen, what an agent or a reviewer is held to** (WP-63 review round 1, the orchestrator's interim ruling pending a founder question): the settings need `project.settings.write` (admin) while the file needs only merge rights, so every key it can state is graded (`REPOSITORY_KEY_GRADES`, `packages/application/src/config/repository-grades.ts`, held to the schema by a test) and anything it did not get is listed in the reading's `not_applied`, never dropped in silence:

| Grade | Keys | Why |
|---|---|---|
| **tighten-only** | `policies.protected_paths`, `policies.reviewers` (unions with the settings, or the platform default when the settings are silent); `policies.risk_classes` (adds classes; adds paths and requirements to a class the settings define, never removes one); `policies.review_checklists` (adds items); `commands` (narrow again after the settings: `ask`/`block` grow, `allow` shrinks); `pipeline.wip` (may lower a limit below the settings' — or BD-010's default — never raise it, WP-91) | the result is never weaker than the settings; a higher WIP limit buys concurrency — spend and review load — that merge rights did not grant |
| **not applied** | `policies.autonomy` and every key `AUTONOMY_POLICY_OVERRIDE_KEYS` names (`policies.probation_tasks`, `policies.knowledge_apply`, `pipeline.limits.human_rounds`, `pipeline.limits.question_timeout`); `policies.dependency_policy`, `policies.coverage_source`, `policies.drift_without_direction`; `pipeline.template_overrides`, `pipeline.custom_stages`; all of `features`; `project.default_branch`; a `stages.*.prompt`/`prompt_append` whose value names a file outside `.agentic/prompts/` | each can switch a check off, move the dial (BD-027:14), turn on agent work, set a spending cap or a per-person read — settings decisions; custom stages have no reader, and a prompt path outside the directory names nothing the platform reads (it is dropped, so it cannot shadow a settings value); the trusted branch is `projects.default_branch`, never a key in a file on it (BD-025 §1) |
| **operational** | `stages.*.model`, `effort`, `max_turns`, `budget_usd`; `pipeline.limits.code_review_iterations`, `business_review_iterations`, `ci_fix_iterations`, `rebase_attempts`, `rebase_rechecks`; `project.knowledge_dir`, `context_budget_tokens`, `communication_language`, `commit_convention`; `status_mapping`; `stages.*.prompt`, `stages.*.prompt_append` naming a file under `.agentic/prompts/` (WP-92) | none widens what an agent may *do*: every run is admitted against the task cap (`taskBudgetExhausted` — a stage budget above it parks the task rather than spending; the cap is not a file key) and the organisation and project budgets (`BudgetGuard`); an extra iteration is still a return a reviewer made and still budgeted; a prompt carries knowledge as data blocks whichever directory it comes from (and the directory is held to the API's rule — relative, no `.`/`..` — or the file is refused); `status_mapping` can map an early stage to a tracker's "Done", which misleads the people reading the ticket and changes no authority — no gate, check or permission reads a ticket status; a project prompt is a data block that adds to the role prompt and grants no tool, command or path, and merge rights could already write the file it names |

A stored reading is re-validated against the current schema and grades when it is read, not only when the file is re-read; a pinned re-read whose commit is **older** than the recorded one is not recorded (a late `default_branch.moved` cannot undo a newer reading); a `__proto__` key and any explicit YAML tag are refused by path. The file is written by the platform only as a **merge request** (`POST /api/projects/:project_id/config/export`, an `agentic/config/*` branch — never a direct commit, Q94 (b)).

**Keys that parse and are not read on this build** (PROGRESS backlogs 220 and 226). The schema accepts them, so a
write that carries one is accepted and changes nothing — and **since WP-91 it says so**: `PUT …/config` answers
with `not_applied`, naming every such key with the reason, and `GET …/config` lists the same keys in its own
`not_applied` for as long as the stored document carries them. This is the settings' twin of the repository
reading's `not_applied` (the row's ruling: reported at the settings write as it already is at the repository
read; `settingsNotApplied`, `packages/application/src/config/settings-grades.ts`). The readers are unscheduled work:

- **`pipeline.template_overrides`**: of a stage entry, only **`plan_approval`** and **`size_threshold`** are read —
  by the plan-approval gate, from the **settings** layer (the repository file's `template_overrides` is *not applied*,
  per the grading table below). **`enabled`** — on a stage or on a template — switches nothing and is reported
  `not_applied`: a stage a project turns off still runs, and a template-level `enabled` has no specified meaning
  yet. Its reader waits on **Q99**.
- **`pipeline.custom_stages`**: no reader, and declined for 0.1 (M5: a custom stage has no loop counter, Q56). A
  project's `.agentic/pipeline.yml` is not read either (next section).
- **`stages.<id>.prompt`** and **`stages.<id>.prompt_append`** **are read since WP-92** (next paragraph); what
  is still reported is a value naming a file outside `.agentic/prompts/`.

**Per-stage prompt files: a project prompt is a data block, never platform text (WP-92, PROGRESS backlog 226's
prompt half).** A stage's own instructions come from `stages.<id>.prompt` and `stages.<id>.prompt_append` —
each `prompts/<name>.md` (relative to `.agentic/`) or `.agentic/prompts/<name>.md` — and, where a key is
silent, from the convention files `.agentic/prompts/<stage>.md` and `.agentic/prompts/<stage>.append.md`
(product/13). Either key may come from the settings or from this file (both are *operational*, above). The file
each names reaches the run **inside a `project_prompt` data block labelled as the project's**, in the user
prompt, and **adds to the role prompt and never replaces it** — `prompt` included, whatever its product/13 name
suggests (technical/04 § "Prompt assembly" has the assembly rule and the `prompt_version` lane). The files are
read from the **default branch** with this file, in the same pass and at the same commit: the repository
reader lists one named directory, `.agentic/prompts/`, and reads its direct `<name>.md` children — at most 64,
each at most 16 KiB (a larger one is recorded `oversized` and never read) — redacted with TD-012 step 1 over
the decrypted credentials of the project's bindings and then step 2's pattern rules (WP-107; until then
step 2 only) and stored beside the reading (`project_repository_config.prompts`, migration 0063). A settings
edit that names another file in the directory applies at the next run; a new or changed **file** applies at
the next reading, like this file itself. A file a key names that the platform cannot read — absent, a
symlink, oversized, outside the directory, or no reading yet — does **not** refuse the run: the run proceeds
without it, its block carries the reason as `status` with an empty body, and the planner logs it.

**Migration note — `project.context_budget_tokens` above 57 500 (WP-83, PROGRESS backlog 173).** The ceiling
on a run's context-pack budget fell from **200 000** to **57 500** estimated tokens: half the smallest
current context window (200 000) at the worst estimate/real ratio measured on this build's estimator
(0.575, Czech prose against a proxy tokeniser), so a pack at the ceiling cannot pass half the window on
a Czech vault. The arithmetic is at `MAX_CONTEXT_BUDGET_TOKENS` in `packages/contracts/src/config.ts`.
A value above it that an earlier release accepted is **refused by name, never clamped**, wherever it is
stored: in the **settings** layer, `GET /api/projects/:project_id/config` answers `409
invalid_stored_config` naming `project.context_budget_tokens` and the value, and a run (or an ask) of
the project is refused at admission with the same key and the value — the stage escalated to
`needs_human` with the outcome `settings_config_invalid` since WP-106, which folded WP-83's bespoke
refusal (`context_budget_above_ceiling`, the outcome a row written before it still carries) into the
settings layer's schema refusal below; in a stored **repository** reading,
the read re-validates it into `invalid` and the repository refusal above names the key. **To migrate**:
write a value at or under 57 500 with `PUT /api/projects/:project_id/config` (or in
`.agentic/config.yml` on the default branch and refresh the reading). The shipped default, 12 000, is
unaffected.

The example above is transcribed key for key into a fixture and parsed by
`packages/contracts/src/config.test.ts` › "parses the example from technical/12 unchanged", so a key
this page documents and the schema refuses fails the build rather than an operator's file.

## `.agentic/pipeline.yml` (optional full template definition)

> **Not read on this build** (PROGRESS backlog 226). A project runs the shipped templates
> (`packages/domain/src/pipeline/templates.ts`); this section is the specification a reader will be built to.

```yaml
version: 1
templates:
  feature:
    stages:
      - id: intake        ; kind: system
      - id: refinement    ; kind: agent  ; role: product_manager ; produces: RefinedSpec ; requires: []
      - id: architecture  ; kind: agent  ; role: architect       ; produces: ImplementationPlan ; requires: [RefinedSpec]
      - id: implementation; kind: agent  ; role: developer       ; produces: ImplementationNotes ; requires: [ImplementationPlan] ; approve_to: ci_gate
      - id: conflict_resolution; kind: agent ; role: developer   ; produces: ImplementationNotes ; requires: [ImplementationNotes]
      - id: ci_gate       ; kind: gate   ; on: ci.pipeline.finished ; pass_to: code_review ; fail_to: implementation
      - id: code_review   ; kind: agent  ; role: reviewer        ; produces: ReviewVerdict ; approve_to: business_review ; return_to: implementation
      - id: business_review; kind: agent ; role: acceptance_tester ; produces: AcceptanceVerdict ; approve_to: rebase_gate ; return_to: implementation
      - id: rebase_gate   ; kind: gate   ; pass_to: ready_for_merge ; fail_to: conflict_resolution
      - id: ready_for_merge; kind: human ; on: [mr.review.comment -> implementation, default_branch.moved -> rebase_gate, mr.merged -> merged_gate]
      - id: merged_gate   ; kind: gate   ; pass_to: retrospective
      - id: retrospective ; kind: agent  ; role: facilitator     ; produces: RetroReport
      - id: librarian     ; kind: agent  ; role: librarian ; produces: LibrarianProposals ; requires: [RetroReport]
      - id: done          ; kind: system
    custom:
      - id: security_scan ; kind: gate ; after: ci_gate ; command: "trivy fs ." ; fail_to: implementation
      - id: docs_update   ; kind: agent ; after: business_review ; role: developer ; prompt: prompts/docs-update.md
```
(`;`-separated inline form shown for brevity; real files use nested YAML.) The platform validates: every `requires` artifact is produced upstream; every transition target exists; no unbounded cycles without an iteration limit.

**`conflict_resolution` is declared between `implementation` and `ci_gate` and is reached only backwards** (WP-26, product/04 S6b). Declaration order is the pipeline, so `implementation` names `approve_to: ci_gate` explicitly and the forward path steps over the stage; the only way in is `rebase_gate.fail_to`, which — being a transition to an *earlier* stage — is a **return** and therefore spends a round of the `rebase` loop (`limits.rebase_attempts`, default 2). The resolution's own fall-through is `ci_gate`, which is how *"re-run CI"* is expressed without a branch in the interpreter.

## Artifact schemas (structured JSON, validated on stage completion)

All artifacts share an envelope: `{ artifact_type, version, task_id, run_id, created_at, language, markdown, data }`. `data` per type:

- **RefinedSpec**: `goal, user_value, in_scope[], out_of_scope[], acceptance_criteria[{id, given, when, then, validation: {kind: command|test|manual, value}}], non_functional[], dependencies[], size: S|M|L|XL, drift: {flag, justification}, assumptions[], questions[{id, text, blocking, options?, suggested_answer?}], decision: proceed|ask|reject, kb_citations[]`.
- **RootCauseAnalysis**: `reproduction: {kind: reproduced|evidence, steps[], evidence[]}, root_cause, confidence: high|medium|low, affected_scope[], fix_direction, regression_test_idea, questions[]`.
- **ImplementationPlan**: `approach, alternatives_considered[{option, why_not}], affected_modules[], files_to_change[{path, change}], data_changes[], api_changes[], validation_contract[{criterion_id, check: {kind, value}}], test_plan[], rollout_notes, risks[], estimated_size, split_proposal?, decisions_to_record[], protected_path_changes[{path, reason}]`.
- **ImplementationNotes**: `summary, deviations_from_plan[{what, why}], tests_added[], commands_run[{command, exit_code, summary}], known_gaps[], followup_tickets[], mr: {url, iid, head_sha}`.
- **ReviewVerdict** *(amended at WP-45)*: `verdict: approve|request_changes, findings[{id, severity: blocker|major|minor|nit, category, file, line, explanation, suggestion}], summary, suspicious_inputs_noted?, protected_path_changes_confirmed[], checklists_applied?[{name, item_count, required_by[], truncated}], criteria?[{id, status: met|not_met|untestable, evidence}]`. `checklists_applied` is **the platform's record, not the model's** — the stage executor overwrites whatever the model wrote with the `policies.review_checklists` lists the planner put in the prompt — `item_count` is the items the prompt actually carried after its bound (`MAX_CHECKLIST_TOTAL_CHARS`, cut at whole items and announced in the block's marker), `truncated` whether it cut this list (`[]` = given none; absent/`null` = not recorded, which is every verdict before WP-45). `criteria` is asked for only when the Reviewer is given a RefinedSpec **and** a human's merge request — the shadow report's review of the human MR.
- **AcceptanceVerdict**: `verdict, criteria[{id, status: met|not_met|untestable, evidence}], scope_creep[], missing[], ux_notes[]`.
- **RetroReport**: `what_went_well[], returns[{stage, reason, avoidable_by_kb, existing_item?, readiness_criterion?}], human_corrections[], cost_summary, proposals[{kind: business|technical|process, type: lesson|pitfall|rule|decision|skill-draft|doc-update, target_path, diff, evidence[], significance}]`.
- **LibrarianProposals** *(added at WP-18b; the `librarian` stage above carried no `produces`, so what a Librarian run decided was validated and then dropped)*: `proposals[{action: add|update|deprecate|no-op, kind, type, target_path, delta, evidence[], significance, reason}], health[{kind: expired|dangling|duplicate|contradiction|oversized, path, detail}], summary`. Two fields are read by the platform rather than by a human: `target_path` is **relative to the project's knowledge directory** (the platform joins it, and refuses anything that would land outside — BD-025), and `delta` is the page's **whole intended content**, not a patch (technical/07 says why).
- **ShadowReport** *(amended at WP-34, which gave it its first writer, and at WP-45)*: `ticket, human_mr?, agent_diff_stats?, overlap?: {files_jaccard, size_ratio?, tests_added_ratio?, agent_test_files, human_test_files}, agent_review_of_human_mr?, criteria_comparison?: {yardstick: agent_refined_spec, judged_by: {agent: acceptance_tester, human: reviewer}, criteria[{id, agent, human}]}, predicted_cost?, shadow_cost, reviewer_minutes_estimate?, notes`. Every `?` is a field the platform **refuses rather than invents** (standing rule 16): `agent_diff_stats` and `overlap` need a diff that may not exist, `agent_review_of_human_mr` is the findings of the Reviewer run over the **human** merge request (WP-45; a `shadow`-mode task, so they are posted nowhere) and `null` when no review ended with a verdict (`[]` would claim a reviewer looked), `criteria_comparison` is published **two sides or not at all** and is measured against the **agent's own** RefinedSpec criteria — the only structured list the platform holds — which the field and `notes` both say, and the two **ratios are `null` when their denominator is zero** — a human merge request whose patches the provider declined to render publishes paths and no lines, so a `size_ratio` of `0` would read as *“the agent changed nothing”*. `notes` says which side was missing.
- **ReadinessReport**: `level, criteria[{id, passed, evidence, unlocks}]`.

Verdict fields drive transitions; the platform never parses markdown to decide.

## Context pack record (stored per run)

`{ tier0: [{path, tokens}], tier1: [{path, reason: paths|trigger|artifact, score, tokens, validated: true|dropped}], budget_tokens, total_tokens, kb_commit }`.

## Prompt versioning

`prompts/<role>.md` shipped with the platform, hashed; a project override or append is hashed with it; `Run.prompt_version = sha256(platform_prompt + override + append)` plus a human-readable label (`refinement@1.3+project`).

> **As built (WP-92):** a project's prompt files **never replace** the role prompt and are not hashed with it: they
> are `project_prompt` data blocks in the user prompt (technical/04 § "Prompt assembly"), so `prompt_version` is
> `p2+<role>@<version>+<digest of the assembled system prompt>+project@<digest of the delivered project prompt
> blocks, or none>+skills@<digest, or none>` — a changed project file moves the `project@` lane and nothing else.


## Effective configuration

`effective = merge(defaults, org, project, repo)` with per-key provenance, **read per stage** rather than per task: the settings port reads the stored settings and the last valid repository reading each time a stage is planned, and the reading is refreshed after each knowledge index run and on `POST …/config/refresh` — so a task that starts before the first index run after a merge runs on the previous reading, and a later stage of the same task can see a newer one. **What each run planned with is frozen into `Run.settings_snapshot`** (WP-91, PROGRESS backlog 227): at run creation, in the run row's own transaction, both run-creation paths (a stage and an ask) write the effective configuration the run was planned from — defaults under the settings with the repository file merged in, the command lists narrowed layer by layer, the WIP limits admission uses, and beside the document the materialised autonomy dial, the task budget cap, the template ids and which repository reading (`status`, `commit_sha`) was merged — redacted through the run's own TD-012 redactor and bounded at 256 KiB (a larger document is stored as a stated `truncated` marker, never cut), with `runs.settings_hash` the `sha256` hex of its canonical JSON (keys sorted, `undefined` dropped, no whitespace) over the stored, redacted document. Two runs planned with one configuration carry one hash; a stage-to-stage change within a task shows as two (`packages/application/src/pipeline/settings-snapshot.ts`). The snapshot records the lag rather than removing it: the reading is still refreshed per index run, not per stage. A run created before WP-91 reads `settings_hash is null` beside the column's `'{}'` default. The organisation's command list caps what project and repo may grant (BD-025's WP-54 and WP-63 amendments — a baseline intersected with it before either narrows). **The organisation's autonomy maximum caps the dial at the next read** (WP-93; the settings port caps the materialised dial, and a task keeps the dial it froze at start — the snapshot records `autonomy_maximum` beside the capped dial), and the repo layer may **tighten, never loosen** what an agent or reviewer is held to: protected paths are a union, the autonomy-override keys and `policies.autonomy` are not applied from it (WP-63, Q101).

**What production composes (WP-63).** `org` is `organizations.settings.commands` — the organisation's command maximum — and, since WP-91, `organizations.settings.pipeline.wip`, the organisation's WIP maximum, which bounds a project's `pipeline.wip` (a `PUT …/config` above it is `409 wip_above_organisation`; a maximum lowered after the write applies at the next read, where `effective` shows the organisation's value with source `org` and `not_applied` names the key). Since WP-93 both — and the autonomy maximum — are written through `PATCH /api/org` (the organisation settings document, above); the whole document is parsed at every read, and one that does not parse is refused, not read as absent. `project` is `projects.config`, what the settings screens and `PUT …/config` write. `repo` is the last `valid` reading of the file above. **The repository wins** wherever it states an operational key (Q94 (a), bounded by the grading above); the settings answer where it is silent; defaults answer the rest; and `GET …/config` publishes the merge as `effective` with the layer of every leaf in `sources` — so a key can answer `repo` — beside `config`, which stays the settings layer the screens round-trip. The pipeline's settings port merges `project` and `repo` **without** the defaults, because several readers treat a key's presence as an override of the materialised autonomy dial (Q78).

**The settings layer is parsed at every read, never cast (WP-106, PROGRESS backlogs 311 and 354).** `projects.config` is held to the strict schema above by every reader. The pipeline's settings port, the Librarian's read and `GET …/config` call one function (`projectSettingsLayerFrom`, `packages/application/src/pipeline/settings.ts`), and `{}` is read as `version: 1`, the schema's minimum. When a stored document does not parse (and in the settings port, also when the organisation document does not parse):
- `GET …/config` answers `409 invalid_stored_config`.
- The settings port does **not** throw. The unreadable layer contributes nothing, and the port answers `configRefusal`, which carries the key paths, the stored values (redacted by the platform's patterns, each clause bounded at 120 characters, at most ten quoted) and `PUT /api/projects/:project_id/config` (`PATCH /api/org` for the organisation document).
- **Every run (or ask) of the project is refused at admission by that name**: the stage is escalated to `needs_human` with the outcome `settings_config_invalid`, and the ask is refused. Admission is not the only guard, because several steps between runs decide on the settings too.
- **Every step that decides a task's next transition or policy from the settings parks the task by name instead** (`packages/application/src/pipeline/config-refusal.ts`). Those steps are stage completion (the plan and budget approval gates and the next stage), the CI gate (`unsupported`), the dependency gate and its deferred decision, risk routing, and the epic split's filing. The review-only and readiness-lint postings refuse the same way; a review-only task that is already `done` is left as it is, its findings unposted. The question-deadline backfill skips the row, and the coverage read skips. Without this, the plan-approval gate read the defaults and let a task reach Ready without the approval its project asks for (measured at WP-106's review). `config-refusal-readers.test.ts` holds every settings read in the application ring to *guarded or declared with a reason*.
- **The WIP limits are the schema's floor** (1 and 1) rather than BD-010's defaults, so a refused document admits no more tasks than any valid one could.
- **A task created meanwhile is marked** (`tasks.settings_refreeze_pending` and, for intake, `tasks.refreeze_routing`, migration 0066). It froze the defaults' iteration limits, its dial and, at intake, its **template**: the spike and epic-split switches read as off, so a Spike ticket became a `feature` task and an epic one task. Its refusal says so. The first step decided on the parsed document takes all three again (`refrozen`, `refreezeSettings`): at `intake`, the ticket is routed again exactly as intake would have routed it, from the issue type and binding capability intake kept. The stage executor's admission is the backstop for the limits and the dial. So no task ever runs on the defaults it was created with.
- The remaining readers act on the defaults **on purpose**, and each is declared in that census with its reason. Intake still makes the ticket a task, which its first decided step parks by name. Notifications are still sent, the status mapping writes nothing, and features whose switch is a key of the document read as off.
- The Librarian's curation records a `refused` report instead of curating.

Before WP-106 both run-path reads cast the column, so a value `GET …/config` refused reached admission, the planner and the run's settings snapshot. The census measured then is in backlog 311.

**Commands narrow layer by layer.** A run's policy is its role baseline (plus its stage's and skills' additions, TD-027), **intersected with the organisation maximum for every verb** (`intersectWithOrganisationMaximum`, PROGRESS backlog 146 — an organisation that leaves `git push …` out of its `allow` removes it from every run, and no later layer brings it back), then narrowed by the settings' lists and then again by the file's under Q97's rule (`runCommandPolicy`'s layers). The file can therefore tighten what the settings allow and never re-grant what they removed; an entry it tries to re-grant is listed in `ignored_allow_commands`.

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
| `CLAUDE_CODE_OAUTH_TOKEN` | — (secret, `local` mode, optional) | operator-supplied |
| `APP_CLAUDE_BINARY` | bundled | path to a `claude` binary in `local` mode |
| `APP_WORKSPACE_ROOT` | `/var/lib/app/workspaces` | runner volume |
| `APP_WEB_ROOT` | the image's own `/app/apps/web/dist` | **absolute** directory the API process serves the built SPA from, at `/` and on the same origin as `/api` and `/events` (technical/09, WP-15j). Unlike `APP_KNOWLEDGE_MIRROR_ROOT` it *has* a default, because it names a part of the image rather than a data volume an operator has to choose — `docker/app.Dockerfile` writes it and `apps/server/src/web/bundle.ts` states it once. Set it to serve a patched bundle from a mounted volume. A directory that is not there is named in a warning at start-up and changes nothing else: the API, `/healthz` and `/readyz` are unaffected and every client path answers the JSON 404 an unmatched path answers. Only a role that serves the API serves it |
| `APP_KNOWLEDGE_MIRROR_ROOT` | unset | **absolute** path where the platform keeps its own bare mirror per project, which the knowledge indexer reads with git plumbing (TD-026). **Unset composes no `VaultSource`** and the index job refuses by name; it never defaults to a path, and a relative one is refused. The directory must exist and be writable by the process — it is never created. Two further requirements the operator supplies rather than the platform: **`git` on the process' `PATH`** (probed at composition; when it is missing the index job refuses naming `git`, like the variable), and a **git binding on the project**, whose existing credential the fetch authenticates with through a credential helper — never in the URL, and never anonymously. `projects.repo_url` must be an `https://`, `http://` or `file://` URL: git's scp-style `git@host:acme/api.git` is **refused** (the form carries no scheme, and it names an SSH remote whose key this platform does not hold), so a project written that way indexes to a permanent `vault_unavailable` naming the scheme — other parts of the platform do accept that spelling, and this is the one place it is not enough. Distinct from the launcher's `APP_WORKSPACE_CACHE_VOLUME`, which only the launcher can advance |
| `APP_TRANSCRIPT_STORE` | `db` | `db | fs:<path> | s3:<bucket>` (03) |
| `APP_RUNNER_MAX_PARALLEL` | `4` | org `max_parallel_runs` seed |
| `APP_WEBHOOK_PUBLIC_URL` | unset | if set, webhooks are advertised in setup guides; else polling |
| `APP_DISABLE_TELEMETRY` | `true` | no phone-home by default |
| `APP_INTEGRATION_HOSTS` | unset (**closed**) | comma-separated hosts a provider binding may name (WP-51, PROGRESS backlog 48). **Not settable through the API** — a list a caller can extend is not a list. Enforced twice: `POST /api/integrations` refuses an undeclared host with `403 integration_host_not_permitted` naming the host and this variable, and `IntegrationActionExecutor` refuses the *call*, so a row written before the list existed cannot slip past. Matching is exact and case-insensitive on the host alone: no port, no path, no subdomain wildcard, punycode as written. Unset or empty means **no provider call leaves the process**, which is rule 18's fail-closed answer; a single `*` declares the list open. It checks names, never the addresses they resolve to |
| `APP_FEATURE_*` | — | feature flags for staged rollout |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | `1` | set on runner processes (research/04) |
| `DISABLE_AUTOUPDATER` | `1` | runner processes `[verify name in research/05]` |

Secrets may also be provided as files via `*_FILE` variants (Docker secrets convention).

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
  template_overrides:            # per template
    feature:
      stages:
        business_review: { enabled: true }
        architecture: { plan_approval: above_size, size_threshold: L }
    chore:
      stages: { architecture: { enabled: false } }
  custom_stages: []              # or reference pipeline.yml
  limits:
    code_review_iterations: 3
    business_review_iterations: 2
    ci_fix_iterations: 3
    human_rounds: 3
    rebase_attempts: 2           # conflict-resolution runs per MR (product/04 S6b)
    rebase_rechecks: 10          # gate re-checks driven by the default branch moving (WP-26)
    question_timeout: 1 working day
stages:                          # per-stage agent settings
  refinement: { model: claude-opus-5, effort: medium, max_turns: 30, budget_usd: 2 }
  architecture: { model: claude-opus-5, effort: high, budget_usd: 5 }
  implementation: { model: claude-opus-5, effort: high, max_turns: 200, budget_usd: 15,
                    prompt: prompts/implementation.md, prompt_append: prompts/implementation.append.md }
  code_review: { model: claude-opus-5, effort: high }
policies:
  autonomy: supervised           # observe | assist | supervised | autonomous (+ overrides below)
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
commands:                        # BD-025 three-list policy (project may only narrow the org maximum)
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

Secrets are never accepted from the repo. Unknown keys are errors (fail loudly, BD: product/12 validation). The UI shows the effective value per key with its source.

The example above is transcribed key for key into a fixture and parsed by
`packages/contracts/src/config.test.ts` › "parses the example from technical/12 unchanged", so a key
this page documents and the schema refuses fails the build rather than an operator's file.

## `.agentic/pipeline.yml` (optional full template definition)

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
- **ReviewVerdict**: `verdict: approve|request_changes, findings[{id, severity: blocker|major|minor|nit, category, file, line, explanation, suggestion}], summary, suspicious_inputs_noted?, protected_path_changes_confirmed[]`.
- **AcceptanceVerdict**: `verdict, criteria[{id, status: met|not_met|untestable, evidence}], scope_creep[], missing[], ux_notes[]`.
- **RetroReport**: `what_went_well[], returns[{stage, reason, avoidable_by_kb, existing_item?, readiness_criterion?}], human_corrections[], cost_summary, proposals[{kind: business|technical|process, type: lesson|pitfall|rule|decision|skill-draft|doc-update, target_path, diff, evidence[], significance}]`.
- **LibrarianProposals** *(added at WP-18b; the `librarian` stage above carried no `produces`, so what a Librarian run decided was validated and then dropped)*: `proposals[{action: add|update|deprecate|no-op, kind, type, target_path, delta, evidence[], significance, reason}], health[{kind: expired|dangling|duplicate|contradiction|oversized, path, detail}], summary`. Two fields are read by the platform rather than by a human: `target_path` is **relative to the project's knowledge directory** (the platform joins it, and refuses anything that would land outside — BD-025), and `delta` is the page's **whole intended content**, not a patch (technical/07 says why).
- **ShadowReport** *(amended at WP-34, which gave it its first writer)*: `ticket, human_mr?, agent_diff_stats?, overlap?: {files_jaccard, size_ratio?, tests_added_ratio?, agent_test_files, human_test_files}, agent_review_of_human_mr?, predicted_cost?, shadow_cost, reviewer_minutes_estimate?, notes`. Every `?` is a field the platform **refuses rather than invents** (standing rule 16): `agent_diff_stats` and `overlap` need a diff that may not exist, `agent_review_of_human_mr` is `null` because nothing on this build reviews somebody else's diff (`[]` would claim a reviewer looked), and the two **ratios are `null` when their denominator is zero** — a human merge request whose patches the provider declined to render publishes paths and no lines, so a `size_ratio` of `0` would read as *“the agent changed nothing”*. `notes` says which side was missing.
- **ReadinessReport**: `level, criteria[{id, passed, evidence, unlocks}]`.

Verdict fields drive transitions; the platform never parses markdown to decide.

## Context pack record (stored per run)

`{ tier0: [{path, tokens}], tier1: [{path, reason: paths|trigger|artifact, score, tokens, validated: true|dropped}], budget_tokens, total_tokens, kb_commit }`.

## Prompt versioning

`prompts/<role>.md` shipped with the platform, hashed; a project override or append is hashed with it; `Run.prompt_version = sha256(platform_prompt + override + append)` plus a human-readable label (`refinement@1.3+project`).

## Effective configuration

`effective = merge(defaults, org, project, repo)` with per-key provenance; computed at task start and frozen into `Run.settings_snapshot`. Org maximum for autonomy and command policy caps what project/repo may set (BD-025, BD-027).

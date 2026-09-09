# 12 — Configuration and schemas

> Round 2 design. Sources: product/12, product/04, product/13, product/18, BD-014, BD-020, BD-025. Concrete schema files (JSON Schema / zod) are produced by the implementer from this document; this is the contract.

## Environment variables (12-factor)

Neutral names, no product prefix for standard variables; `APP_` for product-specific ones (BD-014: rename-friendly). All have documented defaults in `.env.example`; only secrets have none.

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
| `APP_TRANSCRIPT_STORE` | `db` | `db | fs:<path> | s3:<bucket>` (03) |
| `APP_RUNNER_MAX_PARALLEL` | `4` | org `max_parallel_runs` seed |
| `APP_WEBHOOK_PUBLIC_URL` | unset | if set, webhooks are advertised in setup guides; else polling |
| `APP_DISABLE_TELEMETRY` | `true` | no phone-home by default |
| `APP_FEATURE_*` | — | feature flags for staged rollout |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | `1` | set on runner processes (research/04) |
| `DISABLE_AUTOUPDATER` | `1` | runner processes `[verify name in research/05]` |

Secrets may also be provided as files via `*_FILE` variants (Docker secrets convention).

## `.agentic/config.yml` (repository, non-secret, highest precedence for non-secret keys)

```yaml
version: 1                      # schema version; the platform refuses unknown majors
project:
  knowledge_dir: .agentic/knowledge
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
  dependency_policy: ask         # allow | ask | block
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
  ticket_linter: { enabled: false, issue_types: [Story, Task, Bug] }
  review_only: { enabled: false, trigger: label, label: agentic-review, severity_floor: major }
  maintenance: { enabled: false, schedule: "weekly", budget_usd: 20, chores: [deps, flaky, docs] }
  digest: { enabled: true, at: "09:00", quiet_hours: null }
  shadow_mode: { enabled: false }   # M3; added in WP-01 from product/18-19
status_mapping:                  # task state -> ticket status name (provider-specific names)
  refinement: "In Refinement"
  waiting_answers: "Waiting for input"
  implementation: "In Progress"
  ready_for_merge: "In Review"
  done: "Done"
```

Secrets are never accepted from the repo. Unknown keys are errors (fail loudly, BD: product/12 validation). The UI shows the effective value per key with its source.

## `.agentic/pipeline.yml` (optional full template definition)

```yaml
version: 1
templates:
  feature:
    stages:
      - id: intake        ; kind: system
      - id: refinement    ; kind: agent  ; role: product_manager ; produces: RefinedSpec ; requires: []
      - id: architecture  ; kind: agent  ; role: architect       ; produces: ImplementationPlan ; requires: [RefinedSpec]
      - id: implementation; kind: agent  ; role: developer       ; produces: ImplementationNotes ; requires: [ImplementationPlan]
      - id: ci_gate       ; kind: gate   ; on: ci.pipeline.finished ; pass_to: code_review ; fail_to: implementation
      - id: code_review   ; kind: agent  ; role: reviewer        ; produces: ReviewVerdict ; approve_to: business_review ; return_to: implementation
      - id: business_review; kind: agent ; role: acceptance_tester ; produces: AcceptanceVerdict ; approve_to: rebase_gate ; return_to: implementation
      - id: rebase_gate   ; kind: gate   ; pass_to: ready_for_merge
      - id: ready_for_merge; kind: human ; on: [mr.review.comment -> implementation, mr.merged -> merged_gate]
      - id: merged_gate   ; kind: gate   ; pass_to: retrospective
      - id: retrospective ; kind: agent  ; role: facilitator     ; produces: RetroReport
      - id: librarian     ; kind: agent  ; role: librarian
      - id: done          ; kind: system
    custom:
      - id: security_scan ; kind: gate ; after: ci_gate ; command: "trivy fs ." ; fail_to: implementation
      - id: docs_update   ; kind: agent ; after: business_review ; role: developer ; prompt: prompts/docs-update.md
```
(`;`-separated inline form shown for brevity; real files use nested YAML.) The platform validates: every `requires` artifact is produced upstream; every transition target exists; no unbounded cycles without an iteration limit.

## Artifact schemas (structured JSON, validated on stage completion)

All artifacts share an envelope: `{ artifact_type, version, task_id, run_id, created_at, language, markdown, data }`. `data` per type:

- **RefinedSpec**: `goal, user_value, in_scope[], out_of_scope[], acceptance_criteria[{id, given, when, then, validation: {kind: command|test|manual, value}}], non_functional[], dependencies[], size: S|M|L|XL, drift: {flag, justification}, assumptions[], questions[{id, text, blocking, options?, suggested_answer?}], decision: proceed|ask|reject, kb_citations[]`.
- **RootCauseAnalysis**: `reproduction: {kind: reproduced|evidence, steps[], evidence[]}, root_cause, confidence: high|medium|low, affected_scope[], fix_direction, regression_test_idea, questions[]`.
- **ImplementationPlan**: `approach, alternatives_considered[{option, why_not}], affected_modules[], files_to_change[{path, change}], data_changes[], api_changes[], validation_contract[{criterion_id, check: {kind, value}}], test_plan[], rollout_notes, risks[], estimated_size, split_proposal?, decisions_to_record[], protected_path_changes[{path, reason}]`.
- **ImplementationNotes**: `summary, deviations_from_plan[{what, why}], tests_added[], commands_run[{command, exit_code, summary}], known_gaps[], followup_tickets[], mr: {url, iid, head_sha}`.
- **ReviewVerdict**: `verdict: approve|request_changes, findings[{id, severity: blocker|major|minor|nit, category, file, line, explanation, suggestion}], summary, suspicious_inputs_noted?, protected_path_changes_confirmed[]`.
- **AcceptanceVerdict**: `verdict, criteria[{id, status: met|not_met|untestable, evidence}], scope_creep[], missing[], ux_notes[]`.
- **RetroReport**: `what_went_well[], returns[{stage, reason, avoidable_by_kb, existing_item?, readiness_criterion?}], human_corrections[], cost_summary, proposals[{kind: business|technical|process, type: lesson|pitfall|rule|decision|skill-draft|doc-update, target_path, diff, evidence[], significance}]`.
- **ShadowReport**: `ticket, human_mr?, agent_diff_stats, overlap: {files_jaccard, size_ratio}, agent_review_of_human_mr[], predicted_cost, notes`.
- **ReadinessReport**: `level, criteria[{id, passed, evidence, unlocks}]`.

Verdict fields drive transitions; the platform never parses markdown to decide.

## Context pack record (stored per run)

`{ tier0: [{path, tokens}], tier1: [{path, reason: paths|trigger|artifact, score, tokens, validated: true|dropped}], budget_tokens, total_tokens, kb_commit }`.

## Prompt versioning

`prompts/<role>.md` shipped with the platform, hashed; a project override or append is hashed with it; `Run.prompt_version = sha256(platform_prompt + override + append)` plus a human-readable label (`refinement@1.3+project`).

## Effective configuration

`effective = merge(defaults, org, project, repo)` with per-key provenance; computed at task start and frozen into `Run.settings_snapshot`. Org maximum for autonomy and command policy caps what project/repo may set (BD-025, BD-027).

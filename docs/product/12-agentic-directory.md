# 12 — The `.agentic` directory (repository-side configuration and knowledge)

Decision: [BD-012 knowledge lives in the repository](../decisions/business/BD-012-knowledge-in-repo.md), [BD-014 rename-friendly naming](../decisions/business/BD-014-rename-friendly-naming.md).

Every project is a git repository. The repository carries everything the platform needs that is (a) not secret and (b) benefits from versioning and code review: configuration overrides, prompts, rules, skills and the knowledge base. The directory name is configurable (default `.agentic`) so renaming the product does not force a migration.

```
.agentic/
├── config.yml            # project-level overrides (non-secret): pipeline template, models, effort, limits, policies, status mapping
├── pipeline.yml          # optional full pipeline definition (stages, transitions, custom stages)
├── prompts/              # optional prompt overrides or appendices per stage/role
│   ├── refinement.md     # replaces the default prompt body
│   └── implementation.append.md   # appended to the default prompt
├── rules/                # always-on rules injected into every agent (short, imperative, one topic per file)
│   ├── 001-architecture-boundaries.md
│   └── 002-testing.md
├── skills/               # project skills for platform agents (same SKILL.md format as Claude Code skills)
│   └── run-integration-tests/SKILL.md
└── knowledge/            # the knowledge base vault (see 05); path configurable via `knowledge_dir`
    ├── index.md          # curated entry point: what this project is, where to look, in ~1–2k tokens
    ├── business/         # product overview, personas, glossary, business rules, roadmap/direction, non-goals
    ├── technical/        # architecture overview, module map, conventions, how-to-run/test, environments, integrations
    ├── decisions/        # ADRs: business (BD) and technical (TD) decisions made in *the project* (not in Agentic)
    ├── lessons/          # lessons learned from retrospectives, one per file, dated, with provenance
    ├── research/         # spike outputs
    └── tasks/            # optional: short per-task summaries (episodic memory) if the project opts in to keep them in git
```

## Precedence

`platform defaults` < `organisation settings (UI)` < `project settings (UI)` < `.agentic/config.yml` for non-secret settings. Secrets are never in the repo and never overridable from the repo. The UI shows the effective value and its source.

Why repo wins: engineers change conventions in MRs; the config that governs the agents that touch their code should be reviewed the same way. The UI is for people who do not want to edit YAML; it can offer "export to repo".

## Relationship to `CLAUDE.md`, `.claude/` and `AGENTS.md`

- The project's existing `CLAUDE.md`, `.claude/rules/*.md`, `.claude/skills/*` and `.claude/settings.json` are **loaded as-is** by the platform's agents (they run real Claude Code with `settingSources: ["project"]`, which loads `CLAUDE.md`, `.claude/rules`, skills and hooks from the checkout and nothing from the host user — verified, research/04) — the platform is a good citizen of what the team already maintains for humans.
- `.agentic/` contains only what is specific to autonomous operation. Rule of thumb: *if a human developer using Claude Code locally benefits, it goes to `.claude/`; if only the pipeline needs it, it goes to `.agentic/`.*
- The knowledge base index is referenced from `CLAUDE.md` by the onboarding step (a one-line pointer), so humans running Claude Code locally benefit from the same knowledge. `(proposed)`
- If the repository has an `AGENTS.md`, the platform reads it as additional context (AGENTS.md is stewarded by the Linux Foundation's Agentic AI Foundation and used by > 60k projects — verified, research/02).

## Validation

The platform validates `.agentic/` on every task start (schema + pipeline consistency) and refuses to run with an invalid file, posting the error to the ticket and the UI rather than guessing. A CLI/`--check` mode for CI is a Round 2 TODO.

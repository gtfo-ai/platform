# Contributing

Thanks for looking. This project is built in public (BD-002): everything about how it works lives in [`docs/`](docs/README.md), and the docs are the spec — if code and docs disagree, change the docs first.

## Prerequisites

- Node **24** (`.nvmrc`; anything `>=24` works locally)
- pnpm **12.3.4** — `corepack enable && corepack install`
- Docker (only for the integration and e2e tiers)

```bash
pnpm install         # also installs the git hooks
pnpm run -s verify   # lint + typecheck + unit + contract
```

`pnpm install` runs `lefthook install`, which wires up:

| Hook | What runs |
|---|---|
| `pre-commit` | gitleaks on the staged diff, Biome on staged files |
| `commit-msg` | commitlint (conventional commits) |
| `pre-push` | `pnpm conflict:check` (merge debris in any tracked file), then `pnpm test` (unit + contract) |

gitleaks comes from the `@b12k/gitleaks` devDependency — no global install needed. If it is missing, the hook falls back to the official image via Docker. If neither is available the scan **did not run**, so the hook fails closed and tells you how to fix it; `GITLEAKS_SKIP=1 git commit …` is the deliberate, loud opt-out and is ignored in CI. **Never** use `--no-verify` or `GITLEAKS_SKIP` to get past an actual secret finding.

## Verification contract

Each target prints exactly one final line, `PASS: <target>` or `FAIL: <target>`, and exits non-zero on failure:

```bash
pnpm run -s verify              # lint + typecheck + unit + contract
pnpm run -s verify:integration  # Testcontainers / PGlite suites
pnpm run -s verify:e2e          # fake-Claude application e2e
pnpm run -s verify:ui           # web app suites
pnpm run -s verify:commits      # DCO + commitlint over a commit range
```

## Commits

**Conventional commits**, enforced by commitlint locally and in CI:

```
feat(domain): add run state machine
fix(server): drain SSE connections on shutdown
docs: record TD-026
```

**Every commit must be signed off (DCO).** By signing off you certify the [Developer Certificate of Origin](https://developercertificate.org/):

```bash
git commit -s -m "feat(domain): add run state machine"
```

The `commitlint` and `dco` jobs check **every commit in the pushed range** — on a push to `main` as much as on a pull request — and fail when a message is not a conventional commit, or when a commit carries no `Signed-off-by` trailer whose e-mail is the commit author's. Merge commits are exempt from the sign-off (the commits they bring in are in the same range and are checked individually).

Run the same two checks locally with `pnpm run -s verify:commits`; it takes `--from <rev> [--to <rev>]` and otherwise uses `@{upstream}..HEAD`. Fix an existing branch with `git rebase --signoff <base>`.

## Pull requests

- Small and focused. Tests are part of the change, not a follow-up (see [`docs/technical/10-testing-strategy.md`](docs/technical/10-testing-strategy.md)): unit and property tests for domain code, contract tests for every integration port, golden fixtures for SDK streams, fake-Claude e2e for pipeline changes.
- `pnpm run -s verify` must be green before you open the PR; CI runs the same targets plus the integration, e2e, ui, secret-scan, commitlint and DCO jobs.
- Coverage thresholds hold: 80 % overall, 90 % lines / 85 % branches / 90 % functions in `packages/domain`.
- Update `.env.example` with every new environment variable and `CLAUDE.md` when a command or convention changes.

## Never

- Commit a secret, token, or customer data — in code, docs, tests, fixtures or CI logs (BD-002). Fixtures use obviously fake values (`xoxb-FAKE-…`).
- Rewrite pushed history or force-push `main`.
- Add a dependency without checking its licence against the allow-list (TD-017).

## Security

Report vulnerabilities privately — see [SECURITY.md](SECURITY.md). Do not open a public issue.

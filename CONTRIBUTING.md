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

## Branch protection

`main` is protected by a ruleset, and the required status checks are exactly the jobs
[`ci.yml`](.github/workflows/ci.yml) runs. A ruleset lives in the repository's settings and cannot
be read from a checkout, so this is the list an administrator applies — and
`scripts/release.test.ts` fails when it and the workflow's job names disagree in either direction,
because a required check naming a job that does not exist blocks every pull request forever and a
job missing from the list gates nothing:

- `lint`
- `typecheck`
- `bundle budget`
- `unit + contract`
- `ui`
- `web e2e (playwright)`
- `integration`
- `e2e-fake-claude`
- `secret scan`
- `commitlint`
- `dco`

[`image.yml`](.github/workflows/image.yml) builds and size-checks every image on a pull request and
is deliberately **not** required: it builds five images on two architectures, its failure is
visible on the PR, and requiring it would put that on the critical path of every documentation
change. [`release.yml`](.github/workflows/release.yml) starts on no event but a manual dispatch
(TD-019's amendment retired its release-please job) and has nothing to require.

## Releasing

**Every push to `main` is the release** ([TD-019](docs/decisions/technical/TD-019-release-engineering.md)'s
amendment of 2026-09-16, the product owner's continuous-deployment decision). A maintainer's part is
the review and the merge; there is nothing else to do:

1. A push to `main` is built by [`image.yml`](.github/workflows/image.yml) on `amd64` and `arm64` and
   published to GHCR as `sha-<7>`, `edge` **and `latest`**. `latest` means the newest push to `main`.
2. There is no release pull request and no version bump to merge. `release.yml`'s release-please job
   is **retired**: it is `workflow_dispatch` only, so no push starts it. It stayed red on every
   commit and could not have been otherwise — a PR opened with `GITHUB_TOKEN` is refused
   (*"GitHub Actions is not permitted to create or approve pull requests"*, measured at run
   `34966305421`) until an administrator changes a repository setting, and the alternative needs a
   credential this repository does not carry ([Q90](docs/OPEN-QUESTIONS.md)).
3. **Conventional commits and the DCO are still enforced**, by lefthook and by `ci.yml`. The history
   is what a semantic version will be computed from when **WP-71** reintroduces one — a version
   derived from the commits on each push and applied by *retagging* the sha manifests, never a second
   build. Until then the eleven manifests stay at `0.0.0` and the tag branch of `image.yml`
   (`X.Y.Z`, `X.Y`, `X`, `latest`) is kept and unused.

`pnpm changelog` regenerates `CHANGELOG.md` from those commits, with release-please 17.6.0's own
section table. It is a document this repository renders, not one a workflow writes.

## Pull requests

- Small and focused. Tests are part of the change, not a follow-up (see [`docs/technical/10-testing-strategy.md`](docs/technical/10-testing-strategy.md)): unit and property tests for domain code, contract tests for every integration port, golden fixtures for SDK streams, fake-Claude e2e for pipeline changes.
- `pnpm run -s verify` must be green before you open the PR; CI runs the same targets plus the integration, e2e, ui, secret-scan, commitlint and DCO jobs.
- Coverage thresholds hold: 80 % overall, 90 % lines / 85 % branches / 90 % functions in `packages/domain`.
- Update `.env.example` with every new environment variable and `CLAUDE.md` when a command or convention changes.

## Never

- Commit a secret, token, or customer data — in code, docs, tests, fixtures or CI logs (BD-002). Fixtures use obviously fake values (`xoxb-FAKE-…`).
- Rewrite pushed history or force-push `main`.
- Add a dependency without checking its licence against the allow-list (TD-017). A new dependency also
  changes [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md): run `pnpm run -s notices` and commit the
  result, or `pnpm run -s verify` fails on `notices:check`. A package whose `license` field is not an
  SPDX expression is **refused by name** until somebody reads its terms and records what they read in
  `scripts/notices.mjs` — that refusal is the licence check, made mechanical.

## Security

Report vulnerabilities privately — see [SECURITY.md](SECURITY.md). Do not open a public issue.

## Conduct

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md) (Contributor Covenant 2.1).
Reports go privately to the maintainers in [`.github/CODEOWNERS`](.github/CODEOWNERS).

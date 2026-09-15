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
change. [`release.yml`](.github/workflows/release.yml) runs only on `main` and has nothing to
require.

## Releasing

Releases are [release-please](https://github.com/googleapis/release-please)'s (TD-019), and this is
the whole of a maintainer's part in one:

1. Every push to `main` grooms a **release pull request** — the version bump across all eleven
   manifests, the changelog entry, and `.release-please-manifest.json`. Nothing is released by
   pushing.
2. **A human merges that pull request.** That is what creates the `vX.Y.Z` tag and the GitHub
   release; `release.yml` then appends the upgrade facts to the release notes (whether a migration
   is required, derived from `packages/infrastructure/src/db/migrations/`) and sees the images for
   that tag built — by watching the run the tag push started, or by dispatching `image.yml` on the
   tag when the tag could not start one (see § *What an administrator sets up once*). Either way the
   tag publishes `X.Y.Z`, `X.Y`, `X`, `sha-<7>` and — until Q89 is decided — `latest`, and the release run stays open until that build
   has a verdict.
3. The version is **one product version**: nothing here is published to npm (every manifest is
   `private: true`), so the eleven `package.json` files move together and a per-package version
   would be eleven chances to disagree about one number.

### What an administrator sets up once

A pull request opened with the workflow's default `GITHUB_TOKEN` **starts no workflow run** — that is
GitHub's rule, not a setting — so the release PR would get no `lint`, no `unit + contract` and no
`dco` verdict, while the required checks above make it unmergeable. `release.yml` therefore takes a
token this repository does not ship with:

1. Create a **fine-grained PAT** (`contents: write`, `pull requests: write`, `issues: write` on this
   repository) or install a **GitHub App** and mint an installation token, and add it as the
   repository secret **`RELEASE_PLEASE_TOKEN`**. The value lives in the secret and nowhere else —
   never in a file here (BD-002). `release.yml` falls back to `GITHUB_TOKEN` when it is unset.
   Adding it also changes *how the release's images get built*, and the workflow knows which path it
   is on: a tag created by that identity is an ordinary push, so `image.yml`'s `push: tags` trigger
   starts the build by itself and `release.yml` **watches that run and dispatches nothing** (a second
   dispatch would queue a duplicate build of five images behind the first). Without the token the tag
   starts nothing and the release **dispatches** `image.yml` on it. Both paths end in the same
   `gh run watch --exit-status`, so a failed image build is a failed release run.
2. In the same change, set `signoff` in `release-please-config.json` to the identity that token's
   commits are authored as — a PAT commits as its user, an App as `<app-name>[bot]`. The `dco` job
   requires a commit's `Signed-off-by` e-mail to equal its author's, and the value checked in today
   is `github-actions[bot]`, which is right only for the fallback.

**Measured on the fallback at the workflow's first run** (`34966305421`, at `2788e9c`): release-please failed with *"GitHub Actions is not permitted to create or approve pull requests"* and opened nothing. The repository setting *Settings → Actions → General → Workflow permissions → Allow GitHub Actions to create and approve pull requests* is **off by default**, and the fallback needs it on; the token path does not. Until an administrator does one of the two, the `release` workflow fails on every push to `main` with that line — loudly, and creating nothing.

**With the setting on and without the token, nothing breaks silently, it just stops**: the release PR is opened and is
correct, but it has no checks, so merging it needs a human to close and reopen it (which does start a
run — the event is then the human's), or a merge queue to evaluate it on `merge_group`, or an
administrator to bypass. The `dco` verdict on the release commit is then only visible on the
`push: main` run *after* the merge. Recorded as **Q90** in [`docs/OPEN-QUESTIONS.md`](docs/OPEN-QUESTIONS.md).

`pnpm changelog` regenerates `CHANGELOG.md` from the conventional commits the gates above already
enforce. Until the first release lands it is the *preview* of what release-please will write — the
same commits, grouped by release-please 17.6.0's own section table — and the release PR is where
that preview is replaced by the real entry.

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

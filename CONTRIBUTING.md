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
| `pre-push` | `pnpm conflict:check` (merge debris in any tracked, or untracked and not ignored, file), then `pnpm test` (unit + contract + process) |

gitleaks comes from the `@b12k/gitleaks` devDependency — no global install needed. In a linked worktree with no `node_modules` of its own it uses the main worktree's pinned binary; failing both, it falls back to the official image via Docker. If none is available the scan **did not run**, so the hook fails closed and tells you how to fix it; `GITLEAKS_SKIP=1 git commit …` is the deliberate, loud opt-out and is ignored in CI. A scan that exits 0 without proving it read your change — `scanned ~0 bytes` over a staged diff that adds lines, or git failing inside the container — is a **failure** with its own banner, not a pass (`scripts/gitleaks.mjs` has the history). **Never** use `--no-verify` or `GITLEAKS_SKIP` to get past an actual secret finding.

A linked worktree (`git worktree add`, the arrangement `docs/technical/14-orchestration-protocol.md` describes) needs its own `pnpm install` before it can commit: Biome in `pre-commit` and commitlint in `commit-msg` run from the worktree's `./node_modules/.bin`, and without it the commit is refused (`exit status 127`) — closed, not open.

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
change. It is also the workflow that cuts versions (below), and nothing about that runs on a pull
request.

## Repository settings

Three things live in the repository's settings rather than in a file, so a checkout can neither
apply nor read them; this is the list an administrator applies, and `scripts/release.test.ts` holds
what the files can say about each.

1. **The ruleset on `main`**, with the required checks listed under *Branch protection* above.
2. **CodeQL default setup** (TD-017): *Settings → Code security → Code scanning → CodeQL analysis →
   Set up → Default*. It is a setting, not a workflow — default setup writes no file — so there is
   no `codeql.yml` in `.github/workflows/`, and there must not be one pretending otherwise. Until it
   is switched on this repository has **no SAST at all**: `ci.yml`'s `secret scan` job (gitleaks)
   and the `zizmor` step of `lint` are the whole of its security scanning.
3. **The versioning switch**: the repository variable `RELEASE_VERSIONING` = `enabled`
   (*Settings → Secrets and variables → Actions → Variables*, or
   `gh variable set RELEASE_VERSIONING --body enabled`). It is **unset**, and while it is, no push
   creates a tag or a release (below). It is the one human decision before the first version
   ([Q96](docs/OPEN-QUESTIONS.md)): set it when the owner decides that `0.1.0` is real — Q96's
   recommendation is not before WP-33's model credential exists, since until then the release notes
   must say the prompts have never been run against a model. Removing the variable stops versioning
   again; it deletes nothing that was already published.

## Releasing

**Every push to `main` is the release** ([TD-019](docs/decisions/technical/TD-019-release-engineering.md)'s
amendment of 2026-09-16, the product owner's continuous-deployment decision, and WP-71). A
maintainer's part is the review and the merge; there is nothing else to do:

1. A push to `main` is built by [`image.yml`](.github/workflows/image.yml) on `amd64` and `arm64` and
   published to GHCR as `sha-<7>`, `edge` **and `latest`**. `latest` means the newest push to `main`.
2. **Once `RELEASE_VERSIONING` is `enabled`** (above), the same run also cuts a **version**: the
   `version` job computes `X.Y.Z` from the conventional commits since the last `vX.Y.Z` tag
   (`node scripts/version.mjs` — `feat` is minor, `fix`/`perf`/`revert` patch, a breaking change
   major, and minor before 1.0; `docs`, `chore`, `test`, `ci`, `refactor`, `build` and `style` cut
   nothing; the first version is `0.1.0`), the image reports it at `GET /api/version`, and the
   `release` job copies the manifest lists this run built to `X.Y.Z`, `X.Y` and `X` — a retag, never
   a second build — and creates the `vX.Y.Z` tag and the GitHub Release. The release body is
   `pnpm changelog --release-notes`: the upgrade note, product/14's exit criteria, the commits and
   the images' digests. Nothing is committed back: there is no release pull request, no version bump
   and no bot commit, and the eleven manifests stay at `0.0.0` — the tag is the version.
3. `release.yml` and release-please’s two configuration files are **deleted** (WP-71). The
   release-please job had been retired to a manual dispatch by TD-019's amendment; keeping it beside
   the retag would have kept a second route to a version tag, one that rebuilt the images.
4. **Conventional commits and the DCO are still enforced**, by lefthook and by `ci.yml`, because the
   history is what the version is computed from.

`CHANGELOG.md` is a short hand-written pointer to the GitHub Releases page and lists **no versions**
(Q105, PROGRESS backlog 257): under continuous deployment a list kept in the file would be stale after
nearly every push. `pnpm changelog` **prints** the preview of the next version from the same commits
and release-please 17.6.0's section table, and writes nothing. It **refuses** — exit 1 — when a
release tag exists and the version it would render is not ahead of it; to preview the next release,
`pnpm changelog --version "$(node scripts/version.mjs)"`.

## Pull requests

- Small and focused. Tests are part of the change, not a follow-up (see [`docs/technical/10-testing-strategy.md`](docs/technical/10-testing-strategy.md)): unit and property tests for domain code, contract tests for every integration port, golden fixtures for SDK streams, fake-Claude e2e for pipeline changes.
- `pnpm run -s verify` must be green before you open the PR; CI runs the same targets plus the integration, e2e, ui, secret-scan, commitlint and DCO jobs, and its `lint` job adds three linters `verify` cannot run without a container runtime — **actionlint** and **zizmor** over `.github/workflows/`, **hadolint** over `docker/*.Dockerfile` (waivers in `.hadolint.yaml` or at the line, each with its reason). Changing a workflow or a Dockerfile? Run them the way the job does, with the image digests from `.github/workflows/ci.yml`:
  `docker run --rm -v "$PWD:/repo:ro" -w /repo rhysd/actionlint@sha256:…` · `docker run --rm -v "$PWD:/repo:ro" -w /repo ghcr.io/zizmorcore/zizmor@sha256:… --offline .` · `docker run --rm -v "$PWD:/repo:ro" -w /repo hadolint/hadolint@sha256:… hadolint docker/*.Dockerfile`.
- Coverage thresholds hold **per ring** (`COVERAGE_RINGS` in `vitest.config.ts`; there is no overall threshold since WP-70): 80 % on every metric, 90 % lines / 85 % branches / 90 % functions / 90 % statements in `packages/domain`, and a named, lower floor for the rings that carry debt — `apps/server`, `packages/infrastructure`, and one metric each of `packages/prompts` and `apps/launcher`. A file in a new directory must fall in exactly one ring (`scripts/coverage-budget.test.ts`), and a new coverage exclusion is an entry in `COVERAGE_EXCLUDED_FILES` and in that test.
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

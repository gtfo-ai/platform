# TD-019 — Release: release-please + conventional commits, forward-only migrations via a one-shot service, `.agentic` schema versioning

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** research/09, technical/11, BD-018

## Decision
release-please v5 maintains a release PR (human merges) and tags `vX.Y.Z`; commitlint enforced; image tags `X.Y.Z`, `X.Y`, `X`, `sha-<7>`, `edge`, never `latest` in docs; migrations forward-only, executed by the `migrate` Compose service under an advisory lock; app refuses to start if the DB schema is newer; `.agentic` files carry `version`, JSON Schemas published and served; N-1 upcast in memory with a migration proposal instead of rewriting the user's repository.

> **Amendment (session 6, 2026-09-16, the product owner's decision): continuous deployment — every
> push to `main` is the release, `latest` is the newest one, and the release PR is retired.**
>
> The decision line above chose a batched release: release-please opens a pull request, a human
> merges it, the merge tags `vX.Y.Z`, the tag starts the version-tagged image build. WP-42 built it
> and proved it on a dry run, and it never cut a release: the `GITHUB_TOKEN` path is refused on every
> push (*GitHub Actions is not permitted to create or approve pull requests*) until an administrator
> changes a repository setting, and the token path needs a credential this repository does not carry
> (Q90). Meanwhile every push to `main` was already reviewed, verified by six targets and published
> by `image.yml` as `sha-<7>` and `edge` on both architectures — a deployable artefact per commit.
>
> The owner's answer (Q96): *"every commit is followed, and `:latest` is important as well … at this
> point we just need to build the Docker image after a commit and nothing else; if that is `main`,
> add `:latest` as well."* So, as of this amendment: **(1)** `image.yml` publishes every push to
> `main` as `sha-<7>`, `edge` **and `latest`** — `latest` means the newest push to `main`, which
> supersedes both the "never `latest`" clause above and Q89's recommendation to stop publishing it;
> **(2)** `release.yml`'s release-please job no longer runs on push — it is retired (kept only as a
> manual dispatch if a batched version is ever wanted again, or deleted), so no push to `main` is
> red on a setting nobody intends to change; **(3)** semantic versions, the changelog in a release
> body and the version image tags are **deferred to WP-71**, whose acceptance criteria are rewritten
> from this amendment and Q96's mechanics (a version computed from the conventional commits on
> each push and applied by retagging the sha manifests, never a second build; one human switch
> before the first version) — nothing about versioning changes until that row; **(4)** the ten
> workspace manifests stay at `0.0.0` until then, `commitlint` stays enforced (the history is still
> what a version will be computed from), and migrations, the schema guard and the `.agentic`
> versioning are untouched. The operator guide's upgrade section reads "pull `latest`, or pin a
> `sha-<7>` tag"; `CONTRIBUTING.md`'s administrator paragraph about the pull-request permission and
> `RELEASE_PLEASE_TOKEN` is withdrawn with the job, and `scripts/release.test.ts` is re-pinned to
> the workflows that remain. Recorded here before the workflow changes, because docs win over code.

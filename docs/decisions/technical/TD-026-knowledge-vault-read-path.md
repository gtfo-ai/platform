# TD-026 — The knowledge vault is read from a platform-side bare mirror with git plumbing; never a working tree, never the launcher's cache volume

- **Status:** accepted
- **Date:** 2026-09-12
- **Relates to:** technical/07, technical/05, TD-021, TD-025, TD-010, TD-020, BD-012, BD-021, BD-025, BD-022, PROGRESS backlog 26, WP-18

## Context

WP-16 shipped `KnowledgeIndexer`, the `VaultSource`/`VaultSnapshot` port and one adapter,
`createFilesystemVaultSource`, whose option is documented as the absolute path of the checkout
(`packages/infrastructure/src/knowledge/filesystem-vault.ts:47-48`). The adapter walks that path with
`node:fs/promises` and has **no production caller** — grep finds the definition and its own test.
WP-18 has to register the indexer as the pg-boss job technical/07 specifies: singleton per project,
triggered at task start and after every merge.

**The platform process has no checkout to give it.** TD-021 puts a run's tree on `ws-<run>` at `/work`
inside the run container and the project's bare mirror on the `repo-cache` volume, mounted read-only at
`/cache` in the run container. The launcher does not mount either into its own filesystem: it runs git
in helper containers as root, with the cache volume mounted into the helper
(`packages/infrastructure/src/workspace/provider.ts:389-443`). And TD-021's WP-15g amendment states that
no process which composes the pipeline or serves `/webhooks/*` may construct a Docker client, held by
`apps/launcher/src/docker-access.test.ts` as a census over `git ls-files`.

PROGRESS backlog 26 named three shapes — a server-side clone, a read through `GitProviderPort` with no
checkout, or mounting `repo-cache` read-only into the platform container — and asked for a measurement:
can a **bare** mirror answer `VaultSnapshot.repoPaths` and read the four indexed path classes with no
working tree. It can; the commands and their output are in `docs/research/13-bare-mirror-vault-read.md`.

## Decision

1. **WP-18 builds a second `VaultSource` adapter over a bare git repository** —
   `createGitVaultSource`, beside the filesystem one in `packages/infrastructure/src/knowledge/`. It
   reads with plumbing only: `git rev-parse` for the commit, `git ls-tree -r -z` for the tree, and one
   `git cat-file --batch` process for the document bodies. **It never creates a working tree**, and the
   application ring's port is **unchanged** — no new port, no new method, no change to `VaultSnapshot`.
2. **The bare repository it reads is the platform's own per-project mirror**, on a data volume the
   platform container owns, rooted at a new `APP_KNOWLEDGE_MIRROR_ROOT` (TD-020 naming). Its directory
   name is `mirrorCacheKeyFor(projectId)` — the **same** function the workspace spec uses
   (`packages/infrastructure/src/workspace/spec.ts:179`), so the two mirrors cannot be named two ways,
   and the name stays rename-friendly (BD-014).
3. **The adapter refreshes before it reads.** First use is `git clone --mirror`; afterwards
   `git remote update --prune`, skipped when the requested commit is already present. The credential is
   the project's **existing** git binding credential, decrypted by WP-15a's `SecretStore` and binding
   loader, and it is supplied as a credential-helper environment, **never in the URL** — the reasoning
   is already written at `packages/infrastructure/src/workspace/provider.ts:445-449` and is not repeated
   here. The adapter is therefore built **per call** by the loader shape WP-15a established, because the
   credential and its redactor are per project (Q55).
4. **A fetch that fails is `unavailable`, never a read of the stale copy.** The indexer leaves the
   existing index in place on `unavailable`; reporting `unchanged` from a mirror that failed to advance
   is the silent failure the port's whole design exists to prevent.
5. **`APP_KNOWLEDGE_MIRROR_ROOT` absent means no `VaultSource` is composed**, and the index job refuses
   by name, saying which variable is missing — the shape `startRuntime` already uses for
   `unavailableClaudeRunner`. It must **never** default to a path, never fall back to the server's own
   working directory, and never write an empty index (rule 31: an optional dependency is an absent one;
   rule 18: an unset value must not produce the permissive result).
6. **It must never read the launcher's `repo-cache` volume**, and this is the shape backlog 26 called
   cheapest. See the Alternatives section: it is refused for freshness and ownership, not for secrecy.
7. **It must never construct a Docker client and never run a helper container** (TD-021's WP-15g
   amendment). `git` runs as a child process of the platform process itself, which is why the mirror has
   to be on a filesystem that process can write.
8. **It must never read the task branch.** The ref is the project's default branch, taken from the git
   binding. When `VaultReadRequest.commitSha` is set, the adapter verifies with
   `git merge-base --is-ancestor <sha> <default-branch-ref>` and answers `unavailable` when it is not —
   BD-025 reads agent configuration from the default branch precisely because an MR must not change the
   rules that govern its own review, and a commit sha reaching the job from a provider event is
   untrusted input (BD-022).
9. **Tree entries that are not regular blobs are listed and never read.** Mode `120000` (symlink) and
   mode `160000` (gitlink) appear in `repoPaths` and produce no document. Measured: `git cat-file -p` on
   a symlink entry returns the link target as the blob's content, so an adapter that read it would index
   a document whose body is a path — and the filesystem adapter skips symlinks already, through
   `entry.isFile()`, so reading them here would make the two adapters disagree about the same repository.
10. **`contentHash` is the git blob sha** from `ls-tree`. The port asks only for a digest that changes
    when the content does. A project whose index was built by the other adapter re-indexes once; that is
    a rebuild, and it is visible in the report.
11. **gc stays enabled on the platform's mirror.** The launcher sets `gc.auto 0` because live workspaces
    alternate to its objects; nothing alternates to this one, and a cache that never gcs is a disk leak.
12. **This decision does not answer the code map.** `ctags` needs files, so TD-010's extractor
    (`SymbolExtractionRequest.rootPath` is an absolute path of a checkout to scan) is the same gap with a
    different answer: when `CodeMapper` gets its production composition it extracts `git archive <sha>`
    from **this** mirror into a scratch directory — no second clone and no network — and **must drop any
    symlink whose target escapes the extraction root**, which is what technical/05 §6 already requires of
    the export tarball. Measured: `git archive` recreates a symlink pointing at `/etc/passwd` verbatim.

## Rationale

**The bare mirror answers everything the snapshot needs, and it answers `repoPaths` better than a walk
does.** `git ls-tree -r --name-only` is the set of paths *tracked at the commit*, which is what
technical/07 step 3 says validate-on-read checks against; the filesystem walk is the set of paths *on
disk*, and `filesystem-vault.ts` states that residual itself. Measured on a mirror of this repository:
962 paths in 19 ms.

**Mounting the launcher's `repo-cache` fails on freshness, and fails hardest at the two moments that
matter.** That mirror is updated by `updateMirror`, which runs a helper **container**, so the platform
process cannot advance it — and TD-021's amendment is exactly the rule that stops the platform process
from gaining the ability. technical/05 §1 refreshes it *before each run*. So: after a merge, the index
job would read a mirror that does not yet contain the merge commit, find the same tree, and report
`unchanged` — a stale knowledge base that looks exactly like a current one. And on a project's **first**
task the mirror does not exist at all until the first run's `create`, which happens after the intake
stage's context pack was already assembled, so the first task of every project would run with an empty
knowledge base and nothing saying why. The secondary costs backlog 26 names are real but were not
decisive: the ownership dance is (the mirror is written by a root helper into a volume whose root is
`root:root`, and chowning it broke the next update — measured at WP-14 and recorded at
`packages/infrastructure/src/workspace/provider.ts:420-425`), so a platform process reading it would
need `safe.directory` for an exact path it does not own. One objection it is **not** refused for: the
mirror holds no credential, because the launcher's helper passes the token through a credential helper
rather than in the remote URL.

**Reading through `GitProviderPort` is the largest change of the three and the slowest at run time.**
The port has no file read and no tree listing today — `readCodeowners(project, ref)` is the only
file-shaped read on it — so this shape means two new port methods, a GitLab adapter, a fake, a contract
suite, and every call through `IntegrationActionExecutor` with its audit row and rate limit. A single
`repoPaths` answer is a full recursive tree listing, paginated, per index run, per project, at task start
and after every merge.

**One more copy per project is the price, and it is the cheapest of the three.** BD-012 already says the
platform's indexes are derived and rebuildable; a bare mirror is one more derived cache, deletable at any
time, and it needs no credential the platform does not already hold and no network host it does not
already reach.

## Alternatives considered

- **Mount `repo-cache` read-only into the platform container** (backlog 26's (c)). Refused — see above.
  It is also a Compose-era arrangement by construction: a named volume is host-local, so it would couple
  the indexer role to the launcher's host, which the control volume already does for the runner but
  which there is no reason to extend.
- **Read the default branch through `GitProviderPort`** (backlog 26's (b)). Refused on surface and cost.
  It remains the right answer for a future provider that exposes an archive endpoint and for a
  deployment with no local disk, and the port is where that would go.
- **A launcher-side `readVault` call** — the launcher already owns a mirror and a Docker client, so it
  could run one helper container and return a snapshot. Blocked: it needs the out-of-process transport
  that Q52 leaves deliberately unbuilt, and it widens the smallest, most privileged component in the
  system. If that transport ever lands, it supersedes decision 2 and **nothing else changes**, because
  the adapter reads a path.
- **A blobless partial clone** (`git clone --mirror --filter=blob:none`), which would make the platform's
  copy trees and commits only and fetch document blobs lazily. Attractive, and deferred: it requires
  `uploadpack.allowFilter` on the server [unverified], and it turns each document read into a network
  call that can fail inside a read. Listed in `docs/TODO.md` under Verification.

## Consequences

- WP-18 gains two deployment dependencies it must state rather than assume: a writable data volume for
  the platform container, and `git` in the platform image. Both are WP-22's to place in the image and
  the compose file; WP-18 owns the env var, the refusal when it is absent, and the tests.
- Disk grows by one bare mirror per project on the platform volume, in addition to the launcher's. The
  operator-facing half — budget, gauge, purge policy — is `docs/OPEN-QUESTIONS.md` Q63.
- The `KnowledgeIndexer` job becomes able to fail for a **network** reason. It already distinguishes
  `vault_unavailable` from an empty vault, so the shape exists; what WP-18 adds is that the reason string
  says which of clone, fetch, ancestry or read refused.
- At Kubernetes the mirror becomes a persistent claim on the indexer pod and the adapter is unchanged.
- The code map's production composition inherits decision 12 rather than re-deciding it.

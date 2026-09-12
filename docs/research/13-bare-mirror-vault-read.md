# 13 — Can a bare mirror serve the knowledge vault read? (measurement for TD-026 / WP-18)

> Asked by PROGRESS backlog entry 26 — *needs measurement*: whether a bare mirror alone can answer
> `VaultSnapshot.repoPaths` and read the four indexed path classes with **no working tree**.
> Run by the architect with plain `git` on throwaway clones, under standing rule 66 (no test target, no
> Docker, no `pnpm`). `git version 2.50.1 (Apple Git-155)`, macOS 25.6.0, 2026-09-12.
> Source for the plumbing semantics: <https://git-scm.com/docs/git-ls-tree>,
> <https://git-scm.com/docs/git-cat-file>, <https://git-scm.com/docs/git-archive>,
> <https://git-scm.com/docs/git-merge-base>.

## Answer

**Yes, for the vault. No, for the code map.** Every field of `VaultSnapshot` — `commitSha`,
`documents[]` with their content and a content-keyed digest, and `repoPaths` — is answerable from a bare
repository with three plumbing commands and no checkout. `ctags` is not: it reads files, so TD-010's
extractor needs an extraction step (`git archive`), which the same mirror provides.

## What was run

### Scale, on a mirror of this repository

```
git clone --quiet --mirror /Users/janmikes/www/agentic-platform m1.git
git -C m1.git rev-parse --is-bare-repository          # -> true
git -C m1.git rev-parse refs/heads/main               # -> c6f38ca3664626103c27af442abe4611351fa74b
git -C m1.git ls-tree -r -z --name-only refs/heads/main | tr '\0' '\n' | sed '/^$/d' | wc -l
                                                      # -> 962
time git -C m1.git ls-tree -r --name-only refs/heads/main > /dev/null
                                                      # -> 0.019s total
```

`repoPaths` for a 962-path repository is one command and 19 ms. Note this is the set of paths **tracked
at the commit**, which is what technical/07 step 3 wants; `createFilesystemVaultSource` answers with the
set of paths **on disk**, and its own docblock states the difference.

### The four indexed path classes, from a synthetic vault

A throwaway repository containing `CLAUDE.md`, `AGENTS.md`, `.agentic/knowledge/index.md`,
`.agentic/knowledge/lessons/L-1.md`, `.agentic/rules/r1.md`, one unrelated source file, a symlink
`.agentic/knowledge/evil.md -> /etc/passwd`, and a gitlink at `vendor/sub`; then `git clone --mirror`.

```
git -C synth.git ls-tree -r refs/heads/main
120000 blob 3594e94c04db171e2767224db355f514b13715c5	.agentic/knowledge/evil.md
100644 blob 9015a7a32ca0681be64471d3ac2f8c1f24c1040d	.agentic/knowledge/index.md
100644 blob 737614174b936b8d0fb49ad637e7b4fa9cadc8e9	.agentic/knowledge/lessons/L-1.md
100644 blob 9e133ff9baabbdac5267b1e84ef786c7b67f6c46	.agentic/rules/r1.md
100644 blob 02ba7f414afc1218cb0cd350cdc97f7794d07797	AGENTS.md
100644 blob 2b55a0ec1bf4186b417c37eb1c84f4ffd2355fa7	CLAUDE.md
100644 blob 85de9cf93344b897ee6b677d44c645d747f82b0c	src.ts
160000 commit 0000000000000000000000000000000000000001	vendor/sub
```

Three things this settles for the adapter:

- The **blob sha is in the listing**, so `VaultDocumentSource.contentHash` needs no second pass and no
  hashing of our own.
- **Mode `120000` is a blob.** `git cat-file -p refs/heads/main:.agentic/knowledge/evil.md` printed
  `/etc/passwd` — the link target, with no trailing newline — and **not** the contents of `/etc/passwd`.
  So a bare read cannot be walked out of the repository, which the filesystem walk also cannot be
  (`entry.isFile()` is false for a symlink). But an adapter that read mode `120000` would index a
  document whose body is a path while the filesystem adapter indexes nothing, and the two would disagree
  about the same repository. Skip it, and keep the path in `repoPaths`.
- **Mode `160000` has no blob at all** and must be listed without being read.

### Bodies, one process, exact sizes, and a stated miss

```
printf 'refs/heads/main:CLAUDE.md\nrefs/heads/main:AGENTS.md\nrefs/heads/main:.agentic/rules/r1.md\nrefs/heads/main:.agentic/knowledge/nope.md\n' \
  | git -C synth.git cat-file --batch
2b55a0ec1bf4186b417c37eb1c84f4ffd2355fa7 blob 9
root doc

02ba7f414afc1218cb0cd350cdc97f7794d07797 blob 11
agents doc

9e133ff9baabbdac5267b1e84ef786c7b67f6c46 blob 23
---
id: R-1
---
# Rule

refs/heads/main:.agentic/knowledge/nope.md missing
```

One long-lived process reads every document; the header carries a byte length, so the reader frames on
bytes rather than on a delimiter; and an absent path is answered `missing` rather than as an empty file.
The requests travel on **stdin**, so no path is ever concatenated into a command line.

### The ancestry guard (decision 8 of TD-026)

```
git -C synth.git merge-base --is-ancestor <parent-of-main> refs/heads/main   # exit 0
git -C synth.git merge-base --is-ancestor <head-of-side-branch> refs/heads/main
                                                                            # non-zero -> refuse
git -C synth.git cat-file -e 0000000000000000000000000000000000000001^{commit}
# fatal: Not a valid object name 0000000000000000000000000000000000000001^{commit}
```

A commit sha that arrived from a provider event can therefore be checked twice before anything is
indexed: present in the mirror at all, and reachable from the default branch.

### A read-only mirror still reads

```
chmod -R a-w synth.git
git -C synth.git ls-tree -r --name-only refs/heads/main   # OK
git -C synth.git cat-file -p refs/heads/main:CLAUDE.md    # OK
git -C synth.git rev-parse refs/heads/main                # OK
```

None of the three reads needs to write. This is what would have made backlog 26's shape (c) *mechanically*
possible; TD-026 refuses it for freshness rather than for mechanics.

### `git archive` for the code map, and the symlink it recreates

```
git -C synth.git archive --format=tar refs/heads/main | tar -x -C ex
ls -l ex/.agentic/knowledge/evil.md
lrwxr-xr-x  1 ...  ex/.agentic/knowledge/evil.md -> /etc/passwd
```

A bare mirror can produce a working tree on demand for the one consumer that needs files — and the
extraction **recreates the escaping symlink verbatim**. Anything that extracts must drop it, which is
exactly what technical/05 §6 already requires of the export tarball.

## What this did not measure

- **`safe.directory`**: a repository owned by another uid was not tested (it needs a second uid).
  Irrelevant to TD-026, which has the platform process create its own mirror, and stated so that nobody
  reads its absence as a clearance for shape (c).
- **`--filter=blob:none` against a real GitLab**: whether `uploadpack.allowFilter` is on for GitLab.com
  and for self-managed instances is `[unverified]` and is in `docs/TODO.md`.
- **Fetch cost and wall time against a remote**: everything above is local-transport.
- **Concurrency**: two fetches into one mirror at the same time. TD-026 makes the job singleton per
  project, which is the same reason the launcher serialises its own mirror work in `#mirrorLocks`.

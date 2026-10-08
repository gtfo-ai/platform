/**
 * The names an operating system writes into any directory a user opens, shared by the two guards
 * in this repository that walk the filesystem and have to answer *"is this a file somebody meant
 * to write?"*.
 *
 * **Why it is one list in one place.** `check-ignored.mjs` and the fixture-provenance contract
 * suite were each asking that question and giving different answers: the provenance walk skipped
 * `.DS_Store` and `Thumbs.db` by name, while `check-ignored.mjs` reported them as hidden *source*
 * — which turned `main` red after a merge, because macOS had left `.DS_Store` in `.claude/`,
 * `apps/` and `docs/` during a session's filesystem work. Two guards, one question, two answers.
 *
 * **Why a name list and not a derivation, which is the interesting part.** The obvious improvement
 * is to stop naming files and derive source-ness instead — treat a file as source when the
 * repository already tracks its extension, the trick `check-ignored.mjs` uses for root-level
 * files. Measured before adopting (standing rule 27), that is the wrong trade: this repository
 * tracks exactly three extension-less files (`LICENSE`, `NOTICE`, `test/fixtures/runlet/
 * fake-claude-cli`) and **no `Dockerfile` at all** yet, so the first Dockerfile WP-22 adds would
 * be invisible to the derivation — silently, and silence is the failure mode this guard exists to
 * prevent. A name list trades a *loud* false positive for nothing; a derivation trades it for a
 * *quiet* false negative of exactly the class that motivated the guard (`data/` once hid
 * `apps/server/src/data/` while every local check stayed green).
 *
 * So: this list only ever *removes* failures for files git would not track anyway, and everything
 * else — every name not written here — still fails loudly. Adding to it is a deliberate act and
 * should stay that way. It is no longer the walk's only exemption: since WP-162 the local tools'
 * own files are skipped too, by root-anchored path rather than by name ({@link LOCAL_TOOL_PATHS}).
 */
export const OS_ARTEFACT_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

/**
 * The files the **local tools** write into this checkout — Claude Code's harness today — named by
 * their path from the repository root (WP-162 (f), PROGRESS backlog 532).
 *
 * **Why they are here.** `check-ignored.mjs` walks every top-level directory git tracks anything
 * in, and `.claude/` qualifies (`.claude/agents/*.md`, `.claude/skills/`). The harness writes its
 * session lock `.claude/scheduled_tasks.lock` there and an unanchored `**\/.claude/scheduled_tasks.lock`
 * into `.git/info/exclude`, and `git check-ignore` reads that file as well as `.gitignore` — so
 * every local `verify` while a wake-up was armed read `FAIL`, for a file nobody meant to commit.
 * `.claude/settings.local.json` is the same class from the repository's own `.gitignore`, which
 * ignores it on purpose.
 *
 * **Why root-anchored, and why only the walk.** Each entry is one path from the root, never a name:
 * a `scheduled_tasks.lock` anywhere else is still reported, because that would be a file of this
 * repository's own that something hides. `check-ignored.mjs` consults the set only for what its walk
 * of **untracked** files finds, so a tracked path is checked whatever its name. A directory entry
 * ends in `/` and covers what is under it.
 *
 * **Rejected: reporting only what a committed `.gitignore` matches.** It would silence every
 * private exclude (`.git/info/exclude`, the user's `core.excludesFile`), which is the class the guard
 * exists for. So this is a list, and it follows the harness: a new harness file turns local
 * `verify` red until it is added here, which is the loud direction.
 */
export const LOCAL_TOOL_PATHS = new Set([
  '.claude/scheduled_tasks.lock',
  '.claude/scheduled_tasks.json',
  '.claude/settings.local.json',
  '.claude/routines/.state/',
  '.claude/checkpoints/',
  '.claude/mailbox/',
]);

/** Is `path` (repository-relative, `/`-separated) one of {@link LOCAL_TOOL_PATHS} or under one? */
export const isLocalToolPath = (path) =>
  LOCAL_TOOL_PATHS.has(path) ||
  [...LOCAL_TOOL_PATHS].some((entry) => entry.endsWith('/') && path.startsWith(entry));

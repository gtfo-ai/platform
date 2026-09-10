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
 * should stay that way.
 */
export const OS_ARTEFACT_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

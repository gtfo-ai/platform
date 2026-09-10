/**
 * Which directories under this repository belong to a **different** checkout.
 *
 * This exists because it happened, in the same shape twice. `.claude/worktrees/agent-<id>/` is a
 * linked git worktree — a whole separate checkout of this repository, which the agent harness
 * creates and `.gitignore` correctly hides. WP-06a found `check-ignored.mjs` walking into those and
 * reporting another checkout's files as this one's; the same directories were then found reaching
 * the **test runner**, because `vitest.config.ts` gave the `integration` and `e2e-fake-claude`
 * projects an `include` glob opening with a bare `**` — "any `.integration.test.ts` anywhere", "any
 * `.e2e.test.ts` anywhere" — and *anywhere* starts at the repository root and descends into every
 * directory the exclusions do not stop it at.
 *
 * Measured here, with **one** agent worktree nested in the checkout: `integration` collected **24**
 * files of which **12** were the other checkout's, and `e2e-fake-claude` **4** of which **2** were —
 * exactly half of each tier belonging to somebody else. The report that prompted the fix measured
 * the same thing on `main` with **three** worktrees present and got 48 files of which 36 were
 * foreign and 9 of which 7 were, which is 3x12 and 3x2 plus one agent's in-progress file; that run
 * *failed*, on a half-written test belonging to a different agent. A false failure is the safer
 * direction, but a green run had stopped being a statement about this checkout, and CI could not
 * see any of it, because a clean checkout has no nested worktrees.
 *
 * ## The rule, and why it is this one
 *
 * A directory that contains a `.git` entry is where git says one repository ends and another
 * begins. It is git's rule, not a name this file maintains, which is what makes it survive the
 * harness moving its worktrees: `.claude/worktrees/**` in the config would be a hand-maintained
 * constant, correct until the day the layout changes and silently wrong afterwards — standing rule
 * 7's exact shape. `check-ignored.mjs` settled on this rule at WP-06a and `isSeparateCheckout`
 * there is the same predicate; the two are deliberately spelled the same way.
 *
 * Both shapes occur and both are handled. A **linked worktree** has `.git` as a *file* holding a
 * `gitdir:` pointer; a **nested clone or submodule** has it as a *directory*. `existsSync` does not
 * distinguish them, which is the point — the property is "there is a `.git` here".
 *
 * ## Why not ask git
 *
 * `git worktree list --porcelain` is the obvious alternative and it answers a narrower question:
 * *which linked worktrees does this repository administer*. It does not see a nested clone, a
 * submodule, a vendored checkout of an unrelated project, or a worktree belonging to some **other**
 * repository that happens to sit inside this tree — all of which are equally not this checkout's
 * files, and the last of which is what `nested-checkouts.test.ts` builds, precisely because a
 * `git worktree list` implementation would collect it. It also needs git on the PATH and a
 * repository to be present: run from an exported tarball it returns nothing and the guard silently
 * does nothing, which is the failure direction that gets noticed last. The filesystem walk needs
 * neither.
 *
 * What the walk gives up is exact and small, and it is the same thing `check-ignored.mjs` gives up:
 * a file of *this* checkout that lives inside a nested checkout's directory is not collected. Git
 * will not track it there either, so it is not a file this repository could commit or CI could run.
 */
import { type Dirent, existsSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Not walked, and not candidates. These are names of dependency and build output: a walk that
 * descends into `node_modules` visits hundreds of thousands of directories on every `vitest`
 * invocation, and every vitest project already excludes them. `.git` is here because the walk must
 * not descend into the repository's own administrative directory, whose contents are not source.
 *
 * The list matches `SKIP_DIRECTORIES` in `scripts/check-ignored.mjs`. A directory *called* `dist`
 * that holds a nested checkout is the only thing it can hide, and that is not a thing that happens
 * by accident.
 */
export const SKIP_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.git',
]);

/** True when `directory` holds a `.git` entry of either shape — file or directory. */
export const isSeparateCheckout = (directory: string): boolean =>
  existsSync(join(directory, '.git'));

/**
 * Every nested checkout under `root`, as paths relative to it with `/` separators, sorted.
 *
 * The walk stops at each one rather than descending, so a worktree that itself contains worktrees
 * contributes a single entry. `root` is never a candidate: this repository's own `.git` is exactly
 * what makes it this checkout.
 *
 * Symbolic links are not followed. `Dirent.isDirectory()` is false for a symlink, so a link to a
 * directory is skipped entirely — which also makes the walk incapable of looping.
 *
 * It runs once per vitest process, from `vitest.config.ts`. Cost on this repository with
 * `SKIP_DIRECTORIES` pruned: 3-5 ms. No test asserts that — a wall-clock assertion is a hardware
 * assertion (standing rule 2) — but the figure is why a walk was affordable at config load.
 */
export const findNestedCheckouts = (root: string): readonly string[] => {
  const found: string[] = [];

  const walk = (directory: string): void => {
    let entries: readonly Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      // A directory that cannot be read cannot be walked. It is not this guard's job to fail the
      // whole test run over a permission bit; anything unreadable is also not collectable.
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRECTORIES.has(entry.name)) continue;
      const child = join(directory, entry.name);
      if (isSeparateCheckout(child)) {
        found.push(child);
        continue;
      }
      walk(child);
    }
  };

  walk(root);

  return found.map((path) => relative(root, path).split(sep).join('/')).sort();
};

/**
 * Characters picomatch (via tinyglobby, which is what vitest resolves `include`/`exclude` with)
 * reads as syntax rather than as themselves. A directory named `apps (old)` or `test[1]` would
 * otherwise produce a pattern that matches something else, or nothing.
 */
const GLOB_SYNTAX = /[\\*?[\]{}()!+@|^$]/g;

/** `path` as a literal glob segment: every character picomatch reads as syntax is escaped. */
export const escapeGlob = (path: string): string => path.replace(GLOB_SYNTAX, '\\$&');

/**
 * Exclusion patterns covering every nested checkout under `root`, ready to be spread into a vitest
 * project's `exclude`.
 *
 * **One pattern per checkout, not two.** The first version emitted the bare directory beside the
 * `dir/**` form, and that bare pattern turned out to do the work on its own: vitest prunes a
 * directory named literally, so the escaping below could be deleted and every test stayed green —
 * a value bounded twice, with two guards neither of which can be mutation-checked (standing rule
 * 41). Measured with a full nested worktree present, the second pattern bought nothing anyway:
 * `vitest list --filesOnly` runs in 0.22-0.23 s with it and 0.23 s without. So the escaped
 * `dir/**` is the single source, and deleting `escapeGlob` from it now collects the foreign files
 * of a checkout whose directory name carries glob syntax.
 */
export const nestedCheckoutExcludes = (root: string): readonly string[] =>
  findNestedCheckouts(root).map((path) => `${escapeGlob(path)}/**`);

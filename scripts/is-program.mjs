/**
 * "Am I the program?" for a script that is also imported — WP-73b, PROGRESS backlog 258.
 *
 * `changelog.mjs`, `notices.mjs` and `version.mjs` export their halves for tests and run only when
 * they are the process's entry point. They decided that by comparing their own resolved URL with
 * `path.resolve(process.argv[1])`, and the two disagree through a symlink: Node resolves the main
 * module's symlinks for `import.meta.url` (unless `--preserve-symlinks-main`), `path.resolve` does
 * not. So a script run through a symlinked path — macOS's temporary directory is one — did nothing
 * and exited 0, and `notices:check` is a `verify:static` step. Both sides are now real paths.
 *
 * `import.meta.main` would say the same thing, but it arrived in a Node 24 minor and
 * `engines` admits every 24 release, so it is not relied on.
 *
 * Plain JavaScript for the reason the scripts that import it are: no TypeScript resolver is loaded.
 */
import { realpathSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** Whether `moduleUrl` (the caller's `import.meta.url`) is the file Node was asked to run. */
export const isProgram = (moduleUrl) => {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(entry);
  } catch {
    // An entry that does not exist on disk (`node -e`, a REPL) is not this file.
    return false;
  }
};

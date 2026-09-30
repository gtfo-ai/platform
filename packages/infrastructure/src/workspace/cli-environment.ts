/**
 * The run container's facts as environment variables — **one rendering for both consumers**
 * (TD-025's amendment, PROGRESS backlog 342, WP-118).
 *
 * The shim starts the `claude` process with the spawn frame's environment alone (`env` replaces,
 * never merges — `../runlet/shim.ts`), so the proxy, `HOME`, `CLAUDE_CONFIG_DIR`, the image's `PATH`
 * and the git credential helper had to reach the CLI some other way than the container. The
 * launcher answers them as a {@link WorkspaceCliEnvironment}; this module is how that answer becomes
 * variables, and it is used by **both** sides:
 *
 *  - `DockerWorkspaceProvider` writes the run container's environment through it, so a `docker exec`
 *    sees exactly what the CLI sees;
 *  - the runner composes the CLI's whole environment through it (`../runner/options.ts`,
 *    `cliEnvironment`), adding its own git entries to the **one** list numbered here.
 *
 * Measured on the pre-fix tree (the WP-118 notes in `PROGRESS.md`): none of these names reached the
 * CLI, a `#!/usr/bin/env node` executable could not start at all (exit 127, no `PATH`), and the real
 * CLI retried its first model request until the wall clock stopped it, never reaching the sidecar.
 */
import type { WorkspaceCliEnvironment, WorkspaceGitConfigEntry } from '@platform/application';
import { WorkspaceError } from '@platform/application';

/** The variable names {@link cliEnvironmentVariables} writes, git's aside. */
export const CLI_ENVIRONMENT_NAMES = [
  'HOME',
  'CLAUDE_CONFIG_DIR',
  'PATH',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
] as const;

/** Every name that starts a git command-line configuration variable (`GIT_CONFIG_COUNT`, …). */
export const GIT_CONFIG_PREFIX = 'GIT_CONFIG';

/** `HOME`, `CLAUDE_CONFIG_DIR`, `PATH` and — when the run has a sidecar — the three proxy names. */
export const cliEnvironmentVariables = (
  environment: WorkspaceCliEnvironment,
): Record<string, string> => ({
  HOME: environment.home,
  CLAUDE_CONFIG_DIR: environment.claudeConfigDir,
  PATH: environment.path,
  ...(environment.proxy === null
    ? {}
    : {
        HTTP_PROXY: environment.proxy.url,
        HTTPS_PROXY: environment.proxy.url,
        NO_PROXY: environment.proxy.noProxy,
      }),
});

/**
 * One git configuration list, numbered once: `GIT_CONFIG_COUNT` is its length and `KEY_n`/`VALUE_n`
 * are contiguous from 0, in the order given.
 *
 * **A key given twice is refused by name**, never deduplicated. Before WP-118 the container wrote
 * `credential.helper` at index 0 and the runner wrote `core.fsmonitor` at index 0 as well; a merge
 * of the two would have kept whichever came last and dropped the other without a word.
 */
export const numberGitConfig = (
  entries: readonly WorkspaceGitConfigEntry[],
): Record<string, string> => {
  const seen = new Set<string>();
  const variables: Record<string, string> = { GIT_CONFIG_COUNT: String(entries.length) };
  entries.forEach((entry, index) => {
    // git compares configuration keys case-insensitively in their section and name.
    const folded = entry.key.toLowerCase();
    if (seen.has(folded)) {
      throw new WorkspaceError(
        'invalid_spec',
        `the git configuration key ${entry.key} is given twice; one list is numbered once and a duplicate is refused, not dropped (WP-118)`,
        { detail: entry.key },
      );
    }
    seen.add(folded);
    variables[`GIT_CONFIG_KEY_${index}`] = entry.key;
    variables[`GIT_CONFIG_VALUE_${index}`] = entry.value;
  });
  return variables;
};

/**
 * GitLab's `ci_config_path` → the port's {@link CiConfigLocation} (WP-139).
 *
 * GitLab's own reading, from <https://docs.gitlab.com/ci/pipelines/settings/> § "Specify a custom
 * CI/CD configuration file" (read 2026-10-04): a path relative to the repository root
 * (`my/path/.gitlab-ci.yml`), a file in **another project** (`.gitlab-ci.yml@namespace/another-project`,
 * optionally `…:refname`), or a **remote URL** (`http://example.com/generate/ci/config.yml`); with
 * nothing set, *"GitLab expects to find the CI/CD configuration file (.gitlab-ci.yml) in the
 * project's root directory"*.
 *
 * Four answers, and the order decides them:
 *  1. **absent** (`undefined`) → `unknown`: the project entity omits the key for a token that may not
 *     read the code (`schemas.ts`), and assuming the default there would read a project with a
 *     custom path as a project with no CI — the defect this row exists to close;
 *  2. `null` or empty → the default `.gitlab-ci.yml`;
 *  3. an `@` anywhere, or a URL scheme → `external`, counted as present (the row's ruling (b));
 *  4. otherwise a repository path — refused to `unknown` when it is not one this platform will hand
 *     its mirror (absolute, a `.`/`..` segment, a control character, longer than GitLab's 255).
 *
 * The text is provider text (BD-022): it is bounded here and never reaches a shell.
 */
import type { CiConfigLocation } from '@platform/application';

export const GITLAB_DEFAULT_CI_CONFIG_PATH = '.gitlab-ci.yml';

/** GitLab's column limit for `ci_config_path`; a longer answer is not one GitLab wrote. */
const MAX_CI_CONFIG_PATH_CHARS = 255;

// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to refuse control characters.
const CONTROL = /[\u0000-\u001f\u007f]/;
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

const quoted = (value: string): string => JSON.stringify(value.slice(0, 80));

export const ciConfigLocationOf = (raw: string | null | undefined): CiConfigLocation => {
  if (raw === undefined) {
    return {
      kind: 'unknown',
      reason:
        'GitLab did not report ci_config_path for this project (it omits it for a token that may not read the code)',
    };
  }
  const value = (raw ?? '').trim();
  if (value === '') {
    return { kind: 'repository', path: GITLAB_DEFAULT_CI_CONFIG_PATH };
  }
  if (value.length > MAX_CI_CONFIG_PATH_CHARS || CONTROL.test(value)) {
    return {
      kind: 'unknown',
      reason: `GitLab reported a ci_config_path this platform will not read (${quoted(value)})`,
    };
  }
  if (value.includes('@') || URL_SCHEME.test(value)) {
    return { kind: 'external', location: value };
  }
  const segments = value.split('/');
  if (
    value.startsWith('/') ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    return {
      kind: 'unknown',
      reason: `GitLab reported a ci_config_path that is not a repository-relative file (${quoted(value)})`,
    };
  }
  return { kind: 'repository', path: value };
};

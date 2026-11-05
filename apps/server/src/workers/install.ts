/**
 * **The worker's one-command install** — S-22.20, TD-031's 2026-11-05 install-scripts amendment.
 *
 * `install.sh` (POSIX sh: macOS and Linux) and `install.ps1` (Windows PowerShell 5.1 and 7) live
 * beside this module in `install/` and ship in the `platform` image with the server's sources, so a
 * core serves the scripts of the build it runs. {@link renderInstallScript} makes exactly **one**
 * substitution: every {@link INSTALL_CORE_URL_PLACEHOLDER} becomes the core's own URL
 * (`APP_BASE_URL`). That URL lands inside single quotes in both languages, so it is refused
 * ({@link InstallScriptError}, `503 install_script_unavailable`) unless it is a plain `http(s)` URL
 * of {@link SAFE_CORE_URL}'s characters: no credential, query, fragment, quote or space. No secret
 * is in either file.
 *
 * What a script does with the bundle (never move a worker's images on a re-run, never write the
 * updater's `.env`, always install a bundle that has its updater) is stated in each file's header
 * and held by `install-script.test.ts`, which runs `install.sh` against a stub `docker` and `curl`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const INSTALL_CORE_URL_PLACEHOLDER = '@@AGENTIC_CORE_URL@@';

export const INSTALL_SCRIPT_NAMES = ['install.sh', 'install.ps1'] as const;
export type InstallScriptName = (typeof INSTALL_SCRIPT_NAMES)[number];

/** Every character the rendered URL may have; nothing in it is special inside single quotes. */
export const SAFE_CORE_URL = /^https?:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:\/[A-Za-z0-9._~-]+)*$/;

export class InstallScriptError extends Error {
  override readonly name = 'InstallScriptError';
}

/** The URL the scripts name: the core's `APP_BASE_URL`, origin and path, no trailing slash. */
export const installCoreUrlOf = (baseUrl: string): string => {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new InstallScriptError(`APP_BASE_URL is not a URL, so no install script names it`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new InstallScriptError(
      'APP_BASE_URL is not an http(s) URL, so no install script names it',
    );
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new InstallScriptError(
      'APP_BASE_URL carries a credential, a query or a fragment, so no install script names it',
    );
  }
  const core = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  if (!SAFE_CORE_URL.test(core)) {
    throw new InstallScriptError(
      'APP_BASE_URL has a character an install script cannot quote safely, so none is served',
    );
  }
  return core;
};

/** The script's template text, from beside this module. */
export const readInstallScriptTemplate = (name: InstallScriptName): string =>
  readFileSync(fileURLToPath(new URL(`./install/${name}`, import.meta.url)), 'utf8');

/** The template with every placeholder replaced by the core's URL (refused when there is none). */
export const renderInstallScript = (template: string, baseUrl: string): string => {
  if (!template.includes(INSTALL_CORE_URL_PLACEHOLDER)) {
    throw new InstallScriptError(
      `the install script template names no ${INSTALL_CORE_URL_PLACEHOLDER}`,
    );
  }
  return template.replaceAll(INSTALL_CORE_URL_PLACEHOLDER, installCoreUrlOf(baseUrl));
};

/** Both scripts rendered once for a core, or the reason each cannot be served. */
export const renderInstallScripts = (
  baseUrl: string,
  read: (name: InstallScriptName) => string = readInstallScriptTemplate,
): Readonly<Record<InstallScriptName, { readonly text: string } | { readonly error: string }>> => {
  const render = (name: InstallScriptName) => {
    try {
      return { text: renderInstallScript(read(name), baseUrl) };
    } catch (error) {
      if (error instanceof InstallScriptError) return { error: error.message };
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return { error: `this core's image carries no ${name}` };
      }
      throw error;
    }
  };
  return { 'install.sh': render('install.sh'), 'install.ps1': render('install.ps1') };
};

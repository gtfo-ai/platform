/**
 * **The worker's one-command install** — S-22.20, TD-031's 2026-11-05 install-scripts amendment;
 * S-29.2, its 2026-11-24 amendment (decision 9 items 1–3).
 *
 * `install.sh` (POSIX sh: macOS and Linux) and `install.ps1` (Windows PowerShell 5.1 and 7) live
 * beside this module in `install/` and ship in the `platform` image with the server's sources, so a
 * core serves the scripts of the build it runs. {@link renderInstallScript} makes exactly **two**
 * substitutions:
 *
 *  - every {@link INSTALL_CORE_URL_PLACEHOLDER} becomes the core's own URL (`APP_BASE_URL`). That
 *    URL lands inside single quotes in both languages, so it is refused ({@link InstallScriptError},
 *    `503 install_script_unavailable`) unless it is a plain `http(s)` URL of {@link SAFE_CORE_URL}'s
 *    characters: no credential, query, fragment, quote or space;
 *  - every {@link INSTALL_SLUG_PLACEHOLDER} becomes the platform's **slug** (decision 9 item 3) —
 *    the name a second worker on one machine takes when no `--name` is given. Only the slug, never
 *    the display name: {@link installSlugOf} lets through a value of `INSTANCE_SLUG_PATTERN` that
 *    is not `dev` (which `pnpm worker:dev` holds), else the core's host's slug, else `''` — a script
 *    rendered with none asks for `--name` for a second worker. The scripts are rendered **per
 *    request** (`routes/worker/protocol.ts`), so a renamed organisation reaches the next download.
 *    Residual, stated: the slug of the organisation's name is public, as `APP_BASE_URL` is.
 *
 * No secret is in either file.
 *
 * What a script does with the bundle (never move a worker's images on a re-run, never write inside
 * the updater's block of `.env` — only a person's shell-given defaulted settings outside it, BACKLOG
 * 1055, and a named install's own names, S-29.2 — always install a bundle that has its updater) is
 * stated in each file's header and held by `install-script.test.ts`, which runs `install.sh` against a
 * stub `docker` and `curl`, and by `scripts/worker-install-check.mjs` (a Docker check, backlog 1021),
 * which pipes the script a real core serves into `sh` on a real daemon: install, a re-run that
 * recreates nothing, a second core's worker beside the first, and `--uninstall --purge`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { INSTANCE_SLUG_PATTERN, instanceSlug, platformNameOf, slugOfHost } from '@platform/domain';

export const INSTALL_CORE_URL_PLACEHOLDER = '@@AGENTIC_CORE_URL@@';
export const INSTALL_SLUG_PLACEHOLDER = '@@AGENTIC_INSTANCE_SLUG@@';

export const INSTALL_SCRIPT_NAMES = ['install.sh', 'install.ps1'] as const;
export type InstallScriptName = (typeof INSTALL_SCRIPT_NAMES)[number];

/** Every character the rendered URL may have; nothing in it is special inside single quotes. */
export const SAFE_CORE_URL = /^https?:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:\/[A-Za-z0-9._~-]+)*$/;

/** The one name a worker may not take: `pnpm worker:dev` runs as `agentic-worker-dev`. */
export const RESERVED_WORKER_NAMES: readonly string[] = ['dev'];

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

const usableSlug = (slug: string): boolean =>
  INSTANCE_SLUG_PATTERN.test(slug) && !RESERVED_WORKER_NAMES.includes(slug);

/**
 * The slug a script is rendered with: `slug` when it matches `INSTANCE_SLUG_PATTERN` and is not a
 * reserved name, else the slug of the core's host, else `''` (decision 9 item 3: never anything a
 * shell would have to quote).
 */
export const installSlugOf = (slug: string, baseUrl: string): string => {
  if (usableSlug(slug)) return slug;
  let host = '';
  try {
    host = new URL(baseUrl).host;
  } catch {
    return '';
  }
  const fallback = slugOfHost(host);
  return usableSlug(fallback) ? fallback : '';
};

/**
 * The platform's slug for a script: the organisation's name's, else the host's (S-29.1's function).
 * The seeded placeholder name is no name (`platformNameOf`), so it renders the host's.
 */
export const installSlugForOrganisation = (name: string | null, baseUrl: string): string => {
  let host = '';
  try {
    host = new URL(baseUrl).host;
  } catch {
    // An unparseable base URL renders no script at all (installCoreUrlOf); no host, no fallback.
  }
  return installSlugOf(instanceSlug({ name: platformNameOf(name), host }), baseUrl);
};

/** The script's template text, from beside this module. */
export const readInstallScriptTemplate = (name: InstallScriptName): string =>
  readFileSync(fileURLToPath(new URL(`./install/${name}`, import.meta.url)), 'utf8');

/**
 * The template with every placeholder replaced: the core's URL (refused when there is none) and
 * the platform's slug (`slug`, checked by {@link installSlugOf}; the host's when omitted).
 */
export const renderInstallScript = (template: string, baseUrl: string, slug = ''): string => {
  if (!template.includes(INSTALL_CORE_URL_PLACEHOLDER)) {
    throw new InstallScriptError(
      `the install script template names no ${INSTALL_CORE_URL_PLACEHOLDER}`,
    );
  }
  if (!template.includes(INSTALL_SLUG_PLACEHOLDER)) {
    throw new InstallScriptError(
      `the install script template names no ${INSTALL_SLUG_PLACEHOLDER}`,
    );
  }
  return template
    .replaceAll(INSTALL_CORE_URL_PLACEHOLDER, installCoreUrlOf(baseUrl))
    .replaceAll(INSTALL_SLUG_PLACEHOLDER, installSlugOf(slug, baseUrl));
};

export type RenderedInstallScripts = Readonly<
  Record<InstallScriptName, { readonly text: string } | { readonly error: string }>
>;

/** Both templates, read once for a core: each its text, or the reason it cannot be served. */
export const readInstallScriptTemplates = (
  read: (name: InstallScriptName) => string = readInstallScriptTemplate,
): RenderedInstallScripts => {
  const load = (name: InstallScriptName) => {
    try {
      return { text: read(name) };
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return { error: `this core's image carries no ${name}` };
      }
      throw error;
    }
  };
  return { 'install.sh': load('install.sh'), 'install.ps1': load('install.ps1') };
};

/** Both scripts rendered for a core and its platform's slug, or the reason each cannot be served. */
export const renderInstallScripts = (
  baseUrl: string,
  slug = '',
  templates: RenderedInstallScripts = readInstallScriptTemplates(),
): RenderedInstallScripts => {
  const render = (name: InstallScriptName) => {
    const template = templates[name];
    if ('error' in template) return template;
    try {
      return { text: renderInstallScript(template.text, baseUrl, slug) };
    } catch (error) {
      if (error instanceof InstallScriptError) return { error: error.message };
      throw error;
    }
  };
  return { 'install.sh': render('install.sh'), 'install.ps1': render('install.ps1') };
};

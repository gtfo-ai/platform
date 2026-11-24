/**
 * **The worker's one-command install** — S-22.20, TD-031's 2026-11-05 install-scripts amendment.
 *
 * `install.sh` (POSIX sh: macOS and Linux) and `install.ps1` (Windows PowerShell 5.1 and 7) live
 * beside this module in `install/` and ship in the `platform` image with the server's sources, so a
 * core serves the scripts of the build it runs. {@link renderInstallScript} makes exactly **two**
 * substitutions: every {@link INSTALL_CORE_URL_PLACEHOLDER} becomes the core's own URL
 * (`APP_BASE_URL`), and every {@link INSTALL_PLATFORM_SLUG_PLACEHOLDER} the platform's slug
 * ({@link installPlatformSlug}, S-29.2, TD-031's 2026-11-24 amendment decision 9 item 3) — the name
 * a second worker's folder and compose project take when the person gives no `--name`. The URL lands
 * inside single quotes in both languages, so it is refused ({@link InstallScriptError},
 * `503 install_script_unavailable`) unless it is a plain `http(s)` URL of {@link SAFE_CORE_URL}'s
 * characters: no credential, query, fragment, quote or space. The slug is only ever `''` or
 * `^[a-z0-9][a-z0-9-]{0,23}$` (never the display name, which no shell quoting is asked to hold), so
 * it needs no quoting rule. No secret is in either file; the slug of the organisation's name is
 * public, as the base URL already is.
 *
 * The scripts are rendered **per request** (the templates are read once), so a renamed organisation
 * reaches the next download.
 *
 * What a script does with the bundle (never move a worker's images on a re-run, never write inside
 * the updater's block of `.env` — only a person's shell-given defaulted settings outside it, BACKLOG
 * 1055 — always install a bundle that has its updater) is stated in each file's header
 * and held by `install-script.test.ts`, which runs `install.sh` against a stub `docker` and `curl`,
 * and by `scripts/worker-install-check.mjs` (a Docker check, backlog 1021), which pipes the script a
 * real core serves into `sh` on a real daemon: install, a re-run that recreates nothing, and
 * `--uninstall --purge`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { INSTANCE_SLUG_PATTERN, instanceSlug, slugOfHost } from '@platform/domain';

export const INSTALL_CORE_URL_PLACEHOLDER = '@@AGENTIC_CORE_URL@@';
/** S-29.2: the platform's slug, `''` when there is none an install may take. */
export const INSTALL_PLATFORM_SLUG_PLACEHOLDER = '@@AGENTIC_PLATFORM_SLUG@@';

/**
 * The slugs no install takes: `pnpm worker:dev` owns `agentic-worker-dev` (decision 9 item 1,
 * BACKLOG 1641). Both scripts refuse the same list for `--name`/`-Name`.
 */
export const RESERVED_INSTALL_NAMES: readonly string[] = ['dev'];

/** Whether a name may be an install's (`--name`, or the rendered slug). */
export const isInstallName = (name: string): boolean =>
  INSTANCE_SLUG_PATTERN.test(name) && !RESERVED_INSTALL_NAMES.includes(name);

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

/**
 * The slug the scripts are rendered with (decision 9 item 3): the organisation's name's, else the
 * core's host's (`agentic.fontai.org` → `fontai`), else `''` — each refused when it is not an install
 * name, so an organisation called *Dev* (whose slug is `dev`) renders as its host's (BACKLOG 1641).
 * `baseUrl` is `APP_BASE_URL`; one that does not parse gives the name's slug or nothing.
 */
export const installPlatformSlug = (input: {
  readonly name: string | null;
  readonly baseUrl: string;
}): string => {
  let host = '';
  try {
    host = new URL(input.baseUrl).host;
  } catch {
    host = '';
  }
  const named = instanceSlug({ name: input.name, host: '' });
  if (isInstallName(named)) return named;
  const hosted = slugOfHost(host);
  return isInstallName(hosted) ? hosted : '';
};

/** The script's template text, from beside this module. */
export const readInstallScriptTemplate = (name: InstallScriptName): string =>
  readFileSync(fileURLToPath(new URL(`./install/${name}`, import.meta.url)), 'utf8');

/**
 * The template with every placeholder replaced: the core's URL (refused when there is none) and the
 * platform's slug (`''` unless it is an install name — the caller's value is checked again here).
 */
export const renderInstallScript = (
  template: string,
  baseUrl: string,
  platformSlug = '',
): string => {
  for (const placeholder of [INSTALL_CORE_URL_PLACEHOLDER, INSTALL_PLATFORM_SLUG_PLACEHOLDER]) {
    if (!template.includes(placeholder)) {
      throw new InstallScriptError(`the install script template names no ${placeholder}`);
    }
  }
  const slug = isInstallName(platformSlug) ? platformSlug : '';
  return template
    .replaceAll(INSTALL_CORE_URL_PLACEHOLDER, installCoreUrlOf(baseUrl))
    .replaceAll(INSTALL_PLATFORM_SLUG_PLACEHOLDER, slug);
};

export type RenderedInstallScript = { readonly text: string } | { readonly error: string };

/**
 * A renderer of both scripts for one core: the templates are read **once** (the build's), and each
 * call renders them with the platform's name as it is now, so a rename reaches the next download.
 */
export const installScriptRenderer = (
  baseUrl: string,
  read: (name: InstallScriptName) => string = readInstallScriptTemplate,
): ((name: InstallScriptName, organisationName: string | null) => RenderedInstallScript) => {
  const templates = new Map<InstallScriptName, RenderedInstallScript>();
  for (const name of INSTALL_SCRIPT_NAMES) {
    try {
      const text = read(name);
      // Refused now (a missing placeholder, an unquotable URL) rather than at every request.
      renderInstallScript(text, baseUrl);
      templates.set(name, { text });
    } catch (error) {
      if (error instanceof InstallScriptError) {
        templates.set(name, { error: error.message });
      } else if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        templates.set(name, { error: `this core's image carries no ${name}` });
      } else {
        throw error;
      }
    }
  }
  return (name, organisationName) => {
    const template = templates.get(name) ?? { error: `no install script is named ${name}` };
    if ('error' in template) return template;
    return {
      text: renderInstallScript(
        template.text,
        baseUrl,
        installPlatformSlug({ name: organisationName, baseUrl }),
      ),
    };
  };
};

/** Both scripts rendered for a core and a platform name, or the reason each cannot be served. */
export const renderInstallScripts = (
  baseUrl: string,
  read: (name: InstallScriptName) => string = readInstallScriptTemplate,
  organisationName: string | null = null,
): Readonly<Record<InstallScriptName, RenderedInstallScript>> => {
  const render = installScriptRenderer(baseUrl, read);
  return {
    'install.sh': render('install.sh', organisationName),
    'install.ps1': render('install.ps1', organisationName),
  };
};

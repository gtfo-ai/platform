/**
 * The worker's one-command install (S-22.20): what the core renders, and what `install.sh` does
 * with a stub `docker`, `curl`, `uname` and browser opener on `PATH` — run under every POSIX shell
 * this machine has (`/bin/sh`, and `dash` where it exists: CI's Ubuntu `sh` is dash).
 *
 * The owner's requirement is **autoupdate always**: a bundle the installer starts runs its
 * `updater` with the shipped trust defaults, and a re-run never moves the images a worker runs,
 * never writes inside the env file's block the updater manages and never touches a volume. Each of
 * those is a test below — and so is what it does write there (BACKLOG 1055): the defaulted settings
 * given on the shell, outside the block, so an update keeps them; and what it refuses (BACKLOG
 * 1056): a second worker that would share another's control volume, run network or cache. And
 * (S-29.2) several workers on one machine, one per core: the platform's slug the core renders, a
 * named second install beside the first (its folder, project, names and first free page port in
 * its `.env`), the resolution of a re-run and `--uninstall --name` — the stub `docker` keeps one
 * state folder per compose project for it. `install.ps1` gets the same structural checks here; it runs on a Windows runner
 * (`.github/workflows/worker-install.yml`), because no tier of this repository has PowerShell.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MANAGED_BLOCK_BEGIN, MANAGED_BLOCK_END, managedBlock } from '../updater/env-file.js';
import { APPLY_LABEL } from '../updater/updater.js';
import { renderWorkerCompose, WORKER_IMAGE_VARIABLE } from './compose.js';
import {
  INSTALL_CORE_URL_PLACEHOLDER,
  INSTALL_SCRIPT_NAMES,
  INSTALL_SLUG_PLACEHOLDER,
  InstallScriptError,
  installCoreUrlOf,
  installSlugForOrganisation,
  installSlugOf,
  readInstallScriptTemplate,
  renderInstallScript,
  renderInstallScripts,
} from './install.js';

const CORE = 'https://core.example.test';
/** The platform's slug the core renders into both scripts (S-29.2): a second worker's name. */
const SLUG = 'acme';
const REPOSITORY = 'ghcr.io/acme';
/** One build's four images (each set's digests its own: a release rebuilds all four). */
const digests = (hex: string) => ({
  platform: `sha256:${hex.repeat(63)}0`,
  platform_launcher: `sha256:${hex.repeat(63)}1`,
  platform_runtime: `sha256:${hex.repeat(63)}2`,
  platform_egress: `sha256:${hex.repeat(63)}3`,
});
const referencesOf = (hex: string) => ({
  platform: `${REPOSITORY}/platform@${digests(hex).platform}`,
  platform_launcher: `${REPOSITORY}/platform-launcher@${digests(hex).platform_launcher}`,
  platform_runtime: `${REPOSITORY}/platform-runtime@${digests(hex).platform_runtime}`,
  platform_egress: `${REPOSITORY}/platform-egress@${digests(hex).platform_egress}`,
});

const TEMPLATE = readFileSync(
  fileURLToPath(new URL('../../../../compose.worker.yml', import.meta.url)),
  'utf8',
);
/** What `GET compose.yml` answers for a core running build `hex`. */
const servedBundle = (hex: string): string =>
  renderWorkerCompose(TEMPLATE, { digests: digests(hex), repository: REPOSITORY, coreUrl: CORE });

const SH = renderInstallScript(readInstallScriptTemplate('install.sh'), CORE, SLUG);
const PS1 = renderInstallScript(readInstallScriptTemplate('install.ps1'), CORE, SLUG);

/** One top-level service's block of a compose file. */
const serviceOf = (file: string, name: string): string => {
  const start = file.indexOf(`\n  ${name}:\n`);
  if (start < 0) return '';
  const rest = file.slice(start + 1);
  const end = rest.slice(1).search(/\n {2}[a-z][a-z-]*:\n/);
  return end < 0 ? rest : rest.slice(0, end + 1);
};

/** Requirement 2: the updater is present, under no profile, trusting the shipped build by default. */
const expectSelfUpdating = (file: string): void => {
  const updater = serviceOf(file, 'updater');
  expect(updater).toContain('ROLE: updater');
  expect(file).not.toMatch(/^\s*profiles:/m);
  expect(updater).toContain(
    'APP_TRUSTED_IMAGE_REPOSITORY: ${APP_TRUSTED_IMAGE_REPOSITORY:-ghcr.io/gtfo-ai/platform}',
  );
  expect(updater).toContain(
    'APP_TRUSTED_BUILDER: ${APP_TRUSTED_BUILDER:-gtfo-ai/platform/.github/workflows/image.yml@refs/heads/main}',
  );
  expect(updater).toMatch(/restart: unless-stopped/);
  expect(serviceOf(file, 'updater-docker-proxy')).toContain('/var/run/docker.sock');
};

describe('the install scripts the core renders', () => {
  it('fill in the core’s URL everywhere and name no other host than Docker’s docs and this machine', () => {
    for (const [name, text] of [
      ['install.sh', SH],
      ['install.ps1', PS1],
    ] as const) {
      expect(text, name).not.toContain(INSTALL_CORE_URL_PLACEHOLDER);
      expect(text, name).toContain(`'${CORE}'`);
      expect(text, name).toContain(`${CORE}/api/worker/v1/${name}`);
      const urls = [...text.matchAll(/https?:\/\/[^\s'"()<>`?*]+/g)].map((match) => match[0]);
      expect(urls.length, name).toBeGreaterThan(3);
      const foreign = urls.filter(
        (url) =>
          !url.startsWith(`${CORE}/`) &&
          url !== CORE &&
          !url.startsWith('https://docs.docker.com/') &&
          !url.startsWith('http://127.0.0.1:'),
      );
      expect(foreign, name).toEqual([]);
    }
    // A second core renders its own URL, and only its own.
    const other = renderInstallScripts('https://agentic.example.org/sub/');
    expect('text' in other['install.sh'] && other['install.sh'].text).toContain(
      "CORE_URL='https://agentic.example.org/sub'",
    );
    expect('text' in other['install.ps1'] && other['install.ps1'].text.includes(CORE)).toBe(false);
  });

  it.each([
    ['a credential', 'https://user:pass@core.example.test'],
    ['a query', 'https://core.example.test/?next=1'],
    ['a fragment', 'https://core.example.test/#x'],
    ['a quote in the path', "https://core.example.test/a'b"],
    ['a space in the path', 'https://core.example.test/a b'],
    ['another scheme', 'javascript:alert(1)'],
    ['no URL at all', 'not a url'],
  ])('refuses an APP_BASE_URL with %s rather than quote it into a script', (_what, baseUrl) => {
    expect(() => installCoreUrlOf(baseUrl)).toThrow(InstallScriptError);
    const rendered = renderInstallScripts(baseUrl);
    for (const name of INSTALL_SCRIPT_NAMES) expect('error' in rendered[name], name).toBe(true);
  });

  it('accepts a plain URL from both sides of the rule: a port, a path, a trailing slash', () => {
    expect(installCoreUrlOf('https://core.example.test')).toBe(CORE);
    expect(installCoreUrlOf('https://core.example.test/')).toBe(CORE);
    expect(installCoreUrlOf('http://localhost:8080/agentic/')).toBe(
      'http://localhost:8080/agentic',
    );
    expect(() => renderInstallScript('no placeholder here', CORE)).toThrow(InstallScriptError);
  });

  it('render the platform’s slug into both scripts, only ever one of the pattern (S-29.2)', () => {
    expect(SH).toContain(`CORE_SLUG='${SLUG}'\n`);
    expect(PS1).toContain(`$CoreSlug = '${SLUG}'\n`);
    for (const text of [SH, PS1]) expect(text).not.toContain(INSTALL_SLUG_PLACEHOLDER);
    // A template that names no slug placeholder is refused, as one that names no URL.
    expect(() =>
      renderInstallScript(`CORE_URL='${INSTALL_CORE_URL_PLACEHOLDER}'`, CORE, SLUG),
    ).toThrow(InstallScriptError);
    // A slug outside the pattern (or `dev`, pnpm worker:dev's) renders as the host's ...
    for (const hostile of [
      "x'; rm -rf ~; '",
      '$(id)',
      'Acme',
      '-acme',
      'a'.repeat(25),
      'acme_corp',
      'dev',
      '',
    ]) {
      expect(installSlugOf(hostile, 'https://agentic.fontai.org'), hostile).toBe('fontai');
      const rendered = renderInstallScript(
        readInstallScriptTemplate('install.sh'),
        'https://agentic.fontai.org',
        hostile,
      );
      expect(rendered, hostile).toContain("CORE_SLUG='fontai'\n");
    }
    expect(installSlugOf('a'.repeat(24), CORE)).toBe('a'.repeat(24));
    // ... and as nothing when the host has none either (the script then asks for --name).
    expect(installSlugOf('dev', 'http://agentic:8080')).toBe('');
    expect(installSlugOf('dev', 'https://dev.example.test')).toBe('');
    expect(
      renderInstallScript(readInstallScriptTemplate('install.ps1'), 'http://agentic'),
    ).toContain("$CoreSlug = ''\n");
  });

  it('name the platform by its organisation, else its host — S-29.1’s slug (S-29.2)', () => {
    expect(installSlugForOrganisation('Autix s.r.o.', 'https://agentic.autix.eu')).toBe(
      'autix-s-r-o',
    );
    expect(installSlugForOrganisation('FontAI', 'https://agentic.autix.eu')).toBe('fontai');
    expect(installSlugForOrganisation(null, 'https://agentic.fontai.org')).toBe('fontai');
    expect(installSlugForOrganisation('株式会社', 'https://agentic.fontai.org')).toBe('fontai');
    // A platform named Dev would name its second worker agentic-worker-dev: the host's instead.
    expect(installSlugForOrganisation('Dev', 'https://agentic.fontai.org')).toBe('fontai');
    const scripts = renderInstallScripts(
      'https://agentic.fontai.org',
      installSlugForOrganisation('Default organisation', 'https://agentic.fontai.org'),
    );
    expect('text' in scripts['install.sh'] && scripts['install.sh'].text).toContain(
      "CORE_SLUG='default-organisation'\n",
    );
  });

  it('agree with the updater on its managed block, its image variables and its apply label', () => {
    for (const text of [SH, PS1]) {
      expect(MANAGED_BLOCK_BEGIN.startsWith('# >>> agentic-platform updater')).toBe(true);
      expect(text).toContain("'# >>> agentic-platform updater'");
      expect(MANAGED_BLOCK_END.startsWith('# <<< agentic-platform updater')).toBe(true);
      expect(text).toContain("'# <<< agentic-platform updater'");
      for (const variable of Object.values(WORKER_IMAGE_VARIABLE)) expect(text).toContain(variable);
      expect(text).toContain(APPLY_LABEL);
    }
  });

  it('are ASCII, so Windows PowerShell 5.1 reads the file it was given as written', () => {
    for (const text of [SH, PS1]) expect(/[^\t\n\r -~]/.test(text)).toBe(false);
  });

  it('install.ps1: Stop on errors, Start-Process for the page, no exit inside irm | iex, nothing PowerShell 7 only', () => {
    expect(PS1).toContain("$ErrorActionPreference = 'Stop'");
    expect(PS1).toContain('Start-Process $page');
    expect(PS1).toContain('-UseBasicParsing');
    // `exit` would close the window of a person who ran `irm | iex`; only a file run exits.
    const code = PS1.slice(PS1.indexOf('#>'))
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'));
    const exitLine =
      '} @args | Select-Object -Last 1 | ForEach-Object { if ($PSCommandPath) { exit $_ } }';
    expect(code.filter((line) => /\bexit\b/.test(line))).toEqual([exitLine]);
    // No parameter or variable of the script's own, which `iex` would leave in the caller's session.
    expect(PS1.slice(0, PS1.indexOf('& {'))).not.toMatch(/^\s*(param\(|\$)/m);
    // Operators PowerShell 5.1 does not parse.
    expect(PS1).not.toMatch(/\?\?|\?\.|&&|\|\|/);
  });
});

describe('the bundle the core serves, and the one the installer writes, update themselves', () => {
  it('serves a bundle with the updater on, at the shipped trust defaults', () => {
    expectSelfUpdating(servedBundle('a'));
  });
});

// ── The settings the installers save into .env (BACKLOG 1055) ───────────────────────────────────

/** Every variable a bundle text declares with a non-empty default, whole-line comments aside. */
const defaultedVariables = (text: string): string[] => {
  const names = new Set<string>();
  for (const line of text.split('\n')) {
    if (/^\s*#/.test(line)) continue;
    for (const match of line.matchAll(/\$\{([A-Z][A-Z0-9_]*):-[^}]/g))
      names.add(match[1] as string);
  }
  return [...names].sort();
};

/**
 * What the installers save from a served bundle today. The scripts derive it at run time (every
 * defaulted variable of the bundle they downloaded, but `NOT_SAVED` and a secret-looking name), so
 * this list is the decision record: a variable the template gains with a default fails the census
 * below until somebody decides whether a value given on the shell is kept across updates.
 */
const SAVED_SETTINGS = [
  'APP_UPDATE_CHECK_SECONDS',
  'APP_UPDATE_POLL_SECONDS',
  'APP_WORKER_CACHE_VOLUME',
  'APP_WORKER_CONCURRENCY',
  'APP_WORKER_CONTROL_VOLUME',
  'APP_WORKER_RUN_NETWORK',
  'APP_WORKER_UI',
  'APP_WORKER_UI_AUTH',
  'APP_WORKER_UI_PORT',
  'APP_WORKER_USAGE_PAUSE_DEFAULT',
  'APP_WORKSPACE_MIRROR_MEMORY_MB',
  'LOG_LEVEL',
];
const SECRET_WORDS = [
  'TOKEN',
  'SECRET',
  'PASSWORD',
  'PASSWD',
  'KEY',
  'DSN',
  'CREDENTIAL',
  'PRIVATE',
];
const looksSecret = (name: string): boolean => SECRET_WORDS.some((word) => name.includes(word));

describe('the settings the installers save into .env', () => {
  it('are every variable the served template declares with a default but NOT_SAVED, held both ways', () => {
    const declared = defaultedVariables(servedBundle('a'));
    const notSaved = (/^NOT_SAVED='([^']*)'$/m.exec(SH)?.[1] ?? '').split(' ');
    const notSavedPs1 = [
      ...(/\$NotSaved = @\(([^)]*)\)/.exec(PS1)?.[1] ?? '').matchAll(/'([A-Z0-9_]+)'/g),
    ].map((match) => match[1]);
    expect(notSaved.length).toBeGreaterThan(5);
    expect(notSavedPs1).toEqual(notSaved);
    // No stale exclusion: each names a variable the template declares with a default.
    for (const name of notSaved) expect(declared, name).toContain(name);
    // The images and the trust are never a saved setting.
    for (const variable of Object.values(WORKER_IMAGE_VARIABLE))
      expect(notSaved).toContain(variable);
    expect(notSaved).toEqual(
      expect.arrayContaining(['APP_TRUSTED_IMAGE_REPOSITORY', 'APP_TRUSTED_BUILDER']),
    );
    expect(declared.filter((name) => !notSaved.includes(name) && !looksSecret(name))).toEqual(
      SAVED_SETTINGS,
    );
    // The two scripts refuse the same secret-looking names.
    expect(SH).toContain(SECRET_WORDS.map((word) => `*${word}*`).join(' | '));
    expect(PS1).toContain(`'${SECRET_WORDS.join('|')}'`);
  });
});

// ── install.sh against stubs ─────────────────────────────────────────────────────────────────────

const DOCKER_STUB = String.raw`#!/bin/sh
# A stub docker for install-script.test.ts: records each call and answers from $STUB_STATE — the
# project agentic-worker's state in $STUB_STATE itself, any other project's in
# $STUB_STATE/projects/<name> (S-29.2: several workers on one machine).
printf 'docker %s\n' "$*" >> "$STUB_LOG"
pstate() {
  if [ "$1" = agentic-worker ]; then printf '%s\n' "$STUB_STATE"; else
    mkdir -p "$STUB_STATE/projects/$1"
    printf '%s\n' "$STUB_STATE/projects/$1"
  fi
}
projects() {
  printf 'agentic-worker\n'
  [ -d "$STUB_STATE/projects" ] && ls "$STUB_STATE/projects"
}
project=$(printf '%s\n' "$*" | sed -n 's/.*--project-name \([a-z0-9_-]*\).*/\1/p')
[ -n "$project" ] || project=$(printf '%s\n' "$*" | sed -n 's/.*com\.docker\.compose\.project=\([a-z0-9_-]*\).*/\1/p')
state=''
[ -z "$project" ] || state=$(pstate "$project")
case "$1" in
  info)
    [ "${'${STUB_DOCKER_INFO:-ok}'}" = ok ] || exit 1
    exit 0
    ;;
  ps)
    case "$*" in
      *org.platform.update-apply=*) printf '%s' "${'${STUB_APPLYING:-}'}"; exit 0 ;;
      *com.docker.compose.project.working_dir*)
        [ -f "$state/up" ] && cat "$state/wd"
        [ "$project" = agentic-worker ] && [ -n "${'${STUB_FOREIGN:-}'}" ] && printf '%s\n' "$STUB_FOREIGN"
        exit 0
        ;;
      *com.docker.compose.service=*)
        service=$(printf '%s\n' "$*" | sed -n 's/.*com\.docker\.compose\.service=\([a-z-]*\).*/\1/p')
        if [ -z "$project" ]; then
          # Every project's container of the service (the installers' look for updaters' mounts).
          for p in $(projects); do
            [ -f "$(pstate "$p")/up" ] && printf 'svc:%s:%s\n' "$p" "$service"
          done
          exit 0
        fi
        [ -f "$state/up" ] || exit 0
        case "$*" in *--quiet*) printf 'svc:%s:%s\n' "$project" "$service"; exit 0 ;; esac
        if [ -f "$state/state-$service" ]; then cat "$state/state-$service"; else printf 'running|Up 3 seconds\n'; fi
        exit 0
        ;;
      *--quiet*)
        if [ -n "$project" ]; then
          [ -f "$state/up" ] && printf 'c0ffee\n'
          exit 0
        fi
        # Every container (a new named install's port scan): each project's worker while it is up,
        # and a stopped one binding $STUB_BOUND_PORTS.
        for p in $(projects); do
          [ -f "$(pstate "$p")/up" ] && printf 'svc:%s:remote-worker\n' "$p"
        done
        [ -n "${'${STUB_BOUND_PORTS:-}'}" ] && printf 'stopped\n'
        exit 0
        ;;
    esac
    ;;
  inspect)
    # docker inspect --format <template> <id>...: an updater's mount, or a container's port bindings.
    format=$3
    shift 3
    for id in "$@"; do
      case "$id" in
        svc:*)
          st=$(pstate "$(printf '%s' "$id" | cut -d: -f2)")
          case "$format" in
            *Mounts*)
              case "$id" in *:updater) [ -f "$st/mount" ] && printf '/var/lib/platform/host-bundle|%s\n\n' "$(cat "$st/mount")" ;; esac
              ;;
            *PortBindings*) [ -f "$st/published-port" ] && printf '%s \n' "$(cat "$st/published-port")" ;;
          esac
          ;;
        stopped) case "$format" in *PortBindings*) printf '%s \n' "$STUB_BOUND_PORTS" ;; esac ;;
      esac
    done
    exit 0
    ;;
  compose)
    [ "$2" = version ] && { printf 'Docker Compose version v5.7.0\n'; exit 0; }
    case "$*" in
      *' up '* | *' up')
        pwd > "$state/wd"
        pwd > "$state/mount"
        : > "$state/up"
        # The page's host port: what a created container publishes (this env, else .env, else the
        # default); --no-recreate leaves a container that exists as it is.
        case "$*" in *--no-recreate*) [ -f "$state/published-port" ] || recreate=1 ;; *) recreate=1 ;; esac
        if [ -n "$recreate" ]; then
          published="$APP_WORKER_UI_PORT"
          [ -n "$published" ] || published=$([ -f .env ] && sed -n 's/^APP_WORKER_UI_PORT=//p' .env | tail -n 1)
          [ -n "$published" ] || published=7357
          printf '%s\n' "$published" > "$state/published-port"
        fi
        # The folder's .env as Compose read it at this up (nothing: no file).
        if [ -f .env ]; then cp .env "$state/env-at-up"; else rm -f "$state/env-at-up"; fi
        env | grep -E '^(PLATFORM_|APP_TRUSTED_|APP_CORE_URL|COMPOSE_|CLAUDE_CODE_OAUTH_TOKEN)' | sort > "$state/up-env"
        exit "${'${STUB_UP_EXIT:-0}'}"
        ;;
      *' start'*) : > "$state/up"; : > "$state/started"; exit 0 ;;
      *' down'*) rm -f "$state/up" "$state/mount"; exit 0 ;;
    esac
    ;;
  port)
    # docker port <container> 7357/tcp: the published page port while the project is up.
    st=$(pstate "$(printf '%s' "$2" | cut -d: -f2)")
    [ -f "$st/up" ] && [ -f "$st/published-port" ] || exit 1
    printf '127.0.0.1:%s\n' "$(cat "$st/published-port")"
    exit 0
    ;;
  volume | network)
    # {{json .Labels}} of a volume or network: $STUB_STATE/labels-<volume|network>-<name>, else none.
    if [ "$2" = inspect ] && [ "$3" = --format ]; then
      [ -f "$STUB_STATE/labels-$1-$5" ] || exit 1
      cat "$STUB_STATE/labels-$1-$5"
      exit 0
    fi
    [ "$1" = volume ] || exit 64
    # The launcher's repository cache: present unless STUB_NO_CACHE is set; removal is recorded.
    [ "$2" = inspect ] && { [ -z "${'${STUB_NO_CACHE:-}'}" ]; exit $?; }
    exit 0
    ;;
esac
echo "stub docker: unexpected: $*" >&2
exit 64
`;

const CURL_STUB = String.raw`#!/bin/sh
# A stub curl: the core's compose.yml from $STUB_BUNDLE, the local page from $STUB_PAGE (on a port
# an up project publishes, or one $STUB_LISTENING names), and the page's state from $STUB_PAGE_STATE (unset: the page answers it
# with an HTTP error; 'down': nothing answers) or, once 'docker compose start' ran, from
# $STUB_PAGE_STATE_AFTER_START (nothing before).
printf 'curl %s\n' "$*" >> "$STUB_LOG"
out=''
url=''
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift 2 ;;
    -*) case "$1" in --proto | --max-time) shift ;; esac; shift ;;
    *) url=$1; shift ;;
  esac
done
case "$url" in
  */api/worker/v1/compose.yml)
    [ -n "${'${STUB_BUNDLE_FAIL:-}'}" ] && exit 22
    cp "$STUB_BUNDLE" "$out"
    ;;
  http://127.0.0.1:*/api/local/state)
    if [ -n "${'${STUB_PAGE_STATE_AFTER_START:-}'}" ]; then
      [ -f "$STUB_STATE/started" ] || exit 7
      printf '%s' "$STUB_PAGE_STATE_AFTER_START"
      exit 0
    fi
    [ "${'${STUB_PAGE_STATE:-}'}" = down ] && exit 7
    [ -n "${'${STUB_PAGE_STATE:-}'}" ] || exit 22
    printf '%s' "$STUB_PAGE_STATE"
    ;;
  http://127.0.0.1:*)
    [ "${'${STUB_PAGE:-up}'}" = up ] || exit 7
    # Only a port an up project's worker publishes answers, or one $STUB_LISTENING names (anything
    # else on this machine listening there).
    port=$(printf '%s' "$url" | sed 's|^http://127.0.0.1:\([0-9]*\).*|\1|')
    case " ${'${STUB_LISTENING:-}'} " in *" $port "*) exit 0 ;; esac
    for st in "$STUB_STATE" "$STUB_STATE"/projects/*; do
      [ -f "$st/up" ] && [ -f "$st/published-port" ] && [ "$(cat "$st/published-port")" = "$port" ] && exit 0
    done
    exit 7
    ;;
  *) exit 6 ;;
esac
`;

const LOGGING_STUB = (name: string): string =>
  `#!/bin/sh\nprintf '${name} %s\\n' "$*" >> "$STUB_LOG"\n`;

/** Each distinct POSIX shell here (on Ubuntu `/bin/sh` is dash, so it runs once). */
const SHELLS = [
  ...new Set(['/bin/sh', '/bin/dash'].filter(existsSync).map((shell) => realpathSync(shell))),
];
/**
 * A run spawns ~40 short processes (the stubs, `sed`, `grep`): 0.2–0.4 s each measured on a
 * laptop, 1.5 s for the slowest test (four runs). 30 s leaves room for a loaded CI runner.
 */
const STUB_RUN_TIMEOUT_MS = 30_000;

interface Stage {
  readonly root: string;
  readonly home: string;
  readonly dir: string;
  readonly state: string;
  readonly log: string;
  readonly bundle: string;
  readonly bin: string;
  /** The `PATH` a run gets. */
  readonly path: string;
}

/** What `install.sh` and the stubs run besides the stubs (shell builtins aside). */
const SYSTEM_TOOLS = [
  'cat',
  'cmp',
  'cp',
  'env',
  'grep',
  'head',
  'ls',
  'mkdir',
  'mv',
  'rm',
  'rmdir',
  'sed',
  'sleep',
  'sort',
  'tail',
  'tr',
];

const stage = (options: { readonly docker?: boolean } = {}): Stage => {
  const root = mkdtempSync(path.join(tmpdir(), 'worker-install-'));
  const home = path.join(root, 'home');
  const state = path.join(root, 'state');
  const bin = path.join(root, 'bin');
  for (const directory of [home, state, bin]) mkdirSync(directory);
  const write = (name: string, text: string) => {
    writeFileSync(path.join(bin, name), text);
    chmodSync(path.join(bin, name), 0o755);
  };
  if (options.docker !== false) write('docker', DOCKER_STUB);
  // With no docker stub, a machine's own `docker` (CI's Ubuntu runner has one in /usr/bin) must not
  // be found either: the run gets the system tools it needs through symlinks, and nothing else.
  let searchPath = `${bin}:/usr/bin:/bin`;
  if (options.docker === false) {
    const system = path.join(root, 'system');
    mkdirSync(system);
    for (const tool of SYSTEM_TOOLS) {
      const found = ['/usr/bin', '/bin'].map((dir) => path.join(dir, tool)).find(existsSync);
      if (found !== undefined) symlinkSync(found, path.join(system, tool));
    }
    searchPath = `${bin}:${system}`;
  }
  write('curl', CURL_STUB);
  write('open', LOGGING_STUB('open'));
  write('xdg-open', LOGGING_STUB('xdg-open'));
  write('uname', '#!/bin/sh\nprintf "%s\\n" "${STUB_UNAME:-Linux}"\n');
  const bundle = path.join(root, 'served.yml');
  writeFileSync(bundle, servedBundle('a'));
  const log = path.join(root, 'calls.log');
  writeFileSync(log, '');
  writeFileSync(path.join(root, 'install.sh'), SH);
  return {
    root,
    home,
    dir: path.join(home, 'agentic-worker'),
    state,
    log,
    bundle,
    bin,
    path: searchPath,
  };
};

const run = (
  shell: string,
  s: Stage,
  args: readonly string[] = [],
  env: Readonly<Record<string, string>> = {},
) => {
  const result = spawnSync(shell, [path.join(s.root, 'install.sh'), ...args], {
    cwd: s.root,
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      PATH: s.path,
      HOME: s.home,
      STUB_LOG: s.log,
      STUB_STATE: s.state,
      STUB_BUNDLE: s.bundle,
      AGENTIC_INSTALL_WAIT_SECONDS: '0',
      ...env,
    },
  });
  const calls = readFileSync(s.log, 'utf8').split('\n').filter(Boolean);
  return {
    status: result.status,
    out: `${result.stdout}${result.stderr}`,
    calls,
    composeCalls: calls.filter((call) => call.startsWith('docker compose --project-name')),
  };
};

const read = (file: string): string | null =>
  existsSync(file) ? readFileSync(file, 'utf8') : null;
/**
 * What the worker's page answers at `/api/local/state`, cut to the keys the installer may read (the
 * real answer is `workerLocalStateSchema`'s, in that key order): `logLine` lands in the log tail.
 */
const pageState = (connection: string, logLine = 'started'): string =>
  `{"worker_id":null,"worker_name":"dev \\"laptop\\"","connection":"${connection}","protocol":3,"logs":["${logLine}"]}`;

/** An env file the updater has written: a person's line, then its managed block. */
const updaterEnvFile = (hex: string): string =>
  `CLAUDE_CODE_OAUTH_TOKEN_FILE_HINT=kept\n\n${managedBlock(referencesOf(hex))}\n`;

describe.each(SHELLS)(
  'install.sh under %s',
  (shell) => {
    it('installs: downloads the core’s bundle verbatim, marks the folder, starts it with its updater and opens the page', () => {
      const s = stage();
      // Hostile values in the person's shell, each of which would move or switch off the updater.
      const r = run(shell, s, [], {
        STUB_UNAME: 'Darwin',
        PLATFORM_IMAGE: 'ghcr.io/evil/platform:latest',
        PLATFORM_RUNTIME_IMAGE: 'ghcr.io/evil/runtime:latest',
        APP_TRUSTED_IMAGE_REPOSITORY: 'ghcr.io/evil/platform',
        APP_TRUSTED_BUILDER: '',
        COMPOSE_PROFILES: 'none',
        COMPOSE_PROJECT_NAME: 'someone-else',
      });
      expect(r.out).toContain('The worker is running.');
      expect(r.status).toBe(0);
      const written = read(path.join(s.dir, 'compose.yaml'));
      expect(written).toBe(servedBundle('a'));
      expectSelfUpdating(written as string);
      expect(read(path.join(s.dir, '.agentic-worker-install'))).toContain(`core=${CORE}\n`);
      // No setting was given on the shell, so there is no env file: its block is the updater's.
      expect(existsSync(path.join(s.dir, '.env'))).toBe(false);
      expect(r.composeCalls).toEqual(['docker compose --project-name agentic-worker up -d']);
      expect(read(path.join(s.state, 'wd'))?.trim()).toBe(s.dir);
      // None of the hostile values reached Compose (requirement 1).
      expect(read(path.join(s.state, 'up-env'))).toBe('');
      expect(r.calls).toContain(
        'curl -fsSL --proto =https --max-time 120 -o ' +
          `${s.dir}/.compose.yaml.download ${CORE}/api/worker/v1/compose.yml`,
      );
      expect(r.calls).toContain('open http://127.0.0.1:7357');
      expect(r.out).toContain('you never run this again to update');
      // The first worker on a machine is today's (S-29.2 (4)): no port probed, no name, no .env.
      expect(r.calls.filter((call) => call.startsWith('curl -s -o /dev/null'))).toEqual([]);
      expect(r.calls.some((call) => call.includes('PortBindings'))).toBe(false);
      expect(r.out).not.toContain('Its name:');
    });

    it('opens the page on Linux only with a display, and never with --no-open', () => {
      const headless = stage();
      expect(run(shell, headless).calls.some((call) => call.startsWith('xdg-open'))).toBe(false);
      const desktop = stage();
      const shown = run(shell, desktop, [], { DISPLAY: ':0' });
      expect(shown.status).toBe(0);
      expect(shown.calls).toContain('xdg-open http://127.0.0.1:7357');
      const quiet = stage();
      const r = run(shell, quiet, ['--no-open'], { STUB_UNAME: 'Darwin' });
      expect(r.status).toBe(0);
      expect(r.calls.some((call) => call.startsWith('open'))).toBe(false);
      expect(r.out).toContain('http://127.0.0.1:7357 (open it in a browser)');
    });

    it('re-runs as a repair: same build, so it adds what is missing (a removed updater too) and recreates nothing', () => {
      const s = stage();
      expect(run(shell, s).status).toBe(0);
      writeFileSync(path.join(s.dir, '.env'), updaterEnvFile('a'));
      const r = run(shell, s);
      expect(r.status).toBe(0);
      // `up --no-recreate`, not `start`: a `start` cannot bring back a container someone removed.
      expect(r.composeCalls).toEqual([
        'docker compose --project-name agentic-worker up -d',
        'docker compose --project-name agentic-worker up -d --no-recreate',
      ]);
      expect(read(path.join(s.dir, '.env'))).toBe(updaterEnvFile('a'));
    });

    it('saves the defaulted settings given on the shell into .env before the first up, and a re-run keeps them', () => {
      const s = stage();
      const r = run(shell, s, ['--no-open'], {
        APP_WORKER_CONCURRENCY: '3',
        APP_WORKER_CONTROL_VOLUME: 'agentic-worker-2-ctl',
        APP_WORKER_UI_PORT: '7400',
        LOG_LEVEL: 'debug',
        // Never saved: a token and a DSN (no default: the updater carries them), a name the bundle
        // does not declare, the images, the trust and the folder the updater answers itself.
        CLAUDE_CODE_OAUTH_TOKEN: 'fake-oauth-token-for-tests',
        SENTRY_DSN: 'https://fake@sentry.example.test/1',
        APP_WORKER_NOT_DECLARED: 'x',
        PLATFORM_IMAGE: 'ghcr.io/evil/platform:latest',
        APP_WORKSPACE_GIT_IMAGE: 'ghcr.io/evil/git:latest',
        APP_TRUSTED_IMAGE_REPOSITORY: 'ghcr.io/evil/platform',
        APP_WORKER_BUNDLE_DIR: '/elsewhere',
      });
      expect(r.status).toBe(0);
      const saved = [
        'APP_WORKER_CONCURRENCY=3',
        'APP_WORKER_CONTROL_VOLUME=agentic-worker-2-ctl',
        'APP_WORKER_UI_PORT=7400',
        'LOG_LEVEL=debug',
      ];
      const envFile = path.join(s.dir, '.env');
      const text = read(envFile) as string;
      expect(text.endsWith('\n')).toBe(true);
      expect(text.split('\n').filter(Boolean).sort()).toEqual(saved);
      // Private, and already there when Compose first read the folder.
      expect(statSync(envFile).mode & 0o777).toBe(0o600);
      expect(read(path.join(s.state, 'env-at-up'))).toBe(text);
      expect(r.out).toContain(
        `Saved in ${s.dir}/.env, so its updates keep them: ${saved.map((line) => line.split('=')[0]).join(' ')}`,
      );
      expect(r.out).toContain('http://127.0.0.1:7400');
      // A re-run without them keeps them; one with a new value replaces the line where it stands.
      expect(run(shell, s, ['--no-open']).status).toBe(0);
      expect(read(envFile)).toBe(text);
      const again = run(shell, s, ['--no-open'], { LOG_LEVEL: 'warn' });
      expect(again.status).toBe(0);
      expect(read(envFile)).toBe(text.replace('LOG_LEVEL=debug\n', 'LOG_LEVEL=warn\n'));
      expect(again.out).toContain('so its updates keep them: LOG_LEVEL');
    });

    it('waits on the port the running worker publishes, not a setting a re-run saved for its next update', () => {
      const s = stage();
      expect(run(shell, s, ['--no-open']).status).toBe(0);
      // A same-build re-run with a new port saves it and recreates nothing: the page stays on 7357.
      const r = run(shell, s, ['--no-open'], { APP_WORKER_UI_PORT: '7400' });
      expect(r.status).toBe(0);
      expect(r.composeCalls.at(-1)).toBe(
        'docker compose --project-name agentic-worker up -d --no-recreate',
      );
      expect(read(path.join(s.dir, '.env'))).toBe('APP_WORKER_UI_PORT=7400\n');
      expect(r.out).toContain('a worker already running takes a changed one at its next update');
      expect(r.out).toContain('http://127.0.0.1:7357 (open it in a browser)');
      // And every later run too: the setting is in .env, the container still publishes 7357.
      const later = run(shell, s, ['--no-open']);
      expect(later.status).toBe(0);
      expect(later.out).toContain('http://127.0.0.1:7357 (open it in a browser)');
    });

    it('reads a setting .env exports or quotes', () => {
      const s = stage();
      expect(run(shell, s).status).toBe(0);
      writeFileSync(
        path.join(s.dir, '.env'),
        `export APP_WORKER_CONTROL_VOLUME="mine-ctl"\nAPP_WORKER_CACHE_VOLUME='mine-cache'\n`,
      );
      writeFileSync(
        path.join(s.state, 'labels-volume-mine-ctl'),
        '{"com.docker.compose.project":"by-hand"}\n',
      );
      const r = run(shell, s);
      expect(r.status).toBe(3);
      expect(r.out).toContain('the compose project by-hand already uses the volume mine-ctl');
      rmSync(path.join(s.state, 'labels-volume-mine-ctl'));
      expect(run(shell, s, ['--uninstall', '--purge']).calls).toContain(
        'docker volume rm mine-cache',
      );
    });

    it('writes around the updater’s managed block, never inside it, replacing an earlier line of the same name', () => {
      const s = stage();
      expect(run(shell, s).status).toBe(0);
      const block = managedBlock(referencesOf('a'));
      const envFile = path.join(s.dir, '.env');
      writeFileSync(
        envFile,
        `export LOG_LEVEL=info\n# mine\nAPP_WORKER_CONCURRENCY=1\n\n${block}\nAPP_WORKER_CONCURRENCY=2\n`,
      );
      const r = run(shell, s, [], {
        LOG_LEVEL: 'debug',
        APP_WORKER_CONCURRENCY: '4',
        APP_WORKER_UI_AUTH: 'token',
      });
      expect(r.status).toBe(0);
      expect(read(envFile)).toBe(
        `LOG_LEVEL=debug\n# mine\nAPP_WORKER_CONCURRENCY=4\n\n${block}\nAPP_WORKER_UI_AUTH=token\n`,
      );
      expect(r.composeCalls.at(-1)).toBe(
        'docker compose --project-name agentic-worker up -d --no-recreate',
      );
    });

    it('never writes a secret-looking name, even one the bundle declares with a default, nor a value a plain line cannot hold', () => {
      const s = stage();
      const concurrency = '      APP_WORKER_CONCURRENCY: ${APP_WORKER_CONCURRENCY:-1}\n';
      const bundle = servedBundle('a').replace(
        concurrency,
        `${concurrency}      APP_WORKER_FAKE_TOKEN: \${APP_WORKER_FAKE_TOKEN:-none}\n`,
      );
      expect(bundle).toContain('${APP_WORKER_FAKE_TOKEN:-none}');
      writeFileSync(s.bundle, bundle);
      const r = run(shell, s, [], {
        APP_WORKER_FAKE_TOKEN: 'fake-value-for-tests',
        LOG_LEVEL: 'de bug',
        APP_WORKER_CONCURRENCY: '2',
      });
      expect(r.status).toBe(0);
      expect(read(path.join(s.dir, '.env'))).toBe('APP_WORKER_CONCURRENCY=2\n');
      expect(r.out).toContain('did not save LOG_LEVEL');
      expect(r.out).not.toContain('fake-value-for-tests');
    });

    it.each([
      [
        'volume',
        'agentic-worker-ctl',
        '{"com.docker.compose.project":"agentic-worker-dev","com.docker.compose.volume":"ctl"}',
        'APP_WORKER_CONTROL_VOLUME',
        'the compose project agentic-worker-dev already uses the volume agentic-worker-ctl',
      ],
      [
        'network',
        'agentic-worker-run-egress',
        '{"com.docker.compose.network":"run-egress","com.docker.compose.project":"by-hand"}',
        'APP_WORKER_RUN_NETWORK',
        'the compose project by-hand already uses the network agentic-worker-run-egress',
      ],
      [
        'volume',
        'agentic-worker-repo-cache',
        '{"com.agentic.instance":"by-hand-ctl","com.agentic.role":"shared"}',
        'APP_WORKER_CACHE_VOLUME',
        'the worker whose control volume is by-hand-ctl already uses the repository cache agentic-worker-repo-cache',
      ],
    ])(
      'refuses a second worker that would share another’s %s %s, before anything is created, naming the variable',
      (kind, name, labels, variable, said) => {
        const s = stage();
        writeFileSync(path.join(s.state, `labels-${kind}-${name}`), `${labels}\n`);
        const r = run(shell, s);
        expect(r.status).toBe(3);
        expect(r.out).toContain(said);
        expect(r.out).toContain(`set ${variable} to a name of its own`);
        expect(r.composeCalls).toEqual([]);
        expect(existsSync(s.dir)).toBe(false);
        // Set to a name of its own on the shell, it installs — and the name is kept in .env.
        const ok = run(shell, s, [], { [variable]: 'agentic-worker-2-own' });
        expect(ok.status).toBe(0);
        expect(read(path.join(s.dir, '.env'))).toBe(`${variable}=agentic-worker-2-own\n`);
      },
    );

    it('does not count its own objects as another worker’s', () => {
      const s = stage();
      writeFileSync(
        path.join(s.state, 'labels-volume-agentic-worker-ctl'),
        '{"com.docker.compose.project":"agentic-worker","com.docker.compose.volume":"ctl"}\n',
      );
      writeFileSync(
        path.join(s.state, 'labels-network-agentic-worker-run-egress'),
        '{"com.docker.compose.project":"agentic-worker"}\n',
      );
      writeFileSync(
        path.join(s.state, 'labels-volume-agentic-worker-repo-cache'),
        '{"com.agentic.instance":"agentic-worker-ctl","com.agentic.role":"shared"}\n',
      );
      writeFileSync(path.join(s.state, 'labels-volume-unlabelled'), 'null\n');
      const r = run(shell, s, [], { APP_WORKER_CACHE_VOLUME: 'unlabelled' });
      expect(r.status).toBe(0);
      expect(r.out).not.toContain('another worker');
      // A cache volume made by its own launcher under the default name is ours too.
      const t = stage();
      writeFileSync(
        path.join(t.state, 'labels-volume-agentic-worker-repo-cache'),
        '{"com.agentic.instance":"agentic-worker-ctl"}\n',
      );
      expect(run(shell, t).status).toBe(0);
    });

    it.each([
      ['the updater has moved it ahead of what the core serves', 'b', 'a'],
      ['the core serves a build the updater has not applied yet', 'a', 'b'],
    ])(
      'never moves a worker’s images when %s: the env file, the bundle and the images stay, and it restarts',
      (_case, running, served) => {
        const s = stage();
        expect(run(shell, s).status).toBe(0);
        writeFileSync(path.join(s.dir, '.env'), updaterEnvFile(running));
        const bundleBefore = read(path.join(s.dir, 'compose.yaml'));
        writeFileSync(s.bundle, servedBundle(served));
        const r = run(shell, s);
        expect(r.status).toBe(0);
        expect(r.out).toContain('this installer never changes the images a worker runs');
        expect(r.composeCalls.at(-1)).toBe('docker compose --project-name agentic-worker start');
        expect(r.composeCalls.filter((call) => call.endsWith(' up -d'))).toHaveLength(1);
        expect(read(path.join(s.dir, '.env'))).toBe(updaterEnvFile(running));
        expect(read(path.join(s.dir, 'compose.yaml'))).toBe(bundleBefore);
        expect(existsSync(path.join(s.dir, '.compose.yaml.download'))).toBe(false);
      },
    );

    it.each(['needs_claude', 'logging_in', 'needs_platform'])(
      'installs the served build over a worker that is not set up yet (its page reads %s): nothing of it is lost',
      (connection) => {
        const s = stage();
        expect(run(shell, s).status).toBe(0);
        writeFileSync(s.bundle, servedBundle('b'));
        const r = run(shell, s, [], { STUB_PAGE_STATE: pageState(connection) });
        expect(r.status).toBe(0);
        expect(r.out).toContain('is not set up yet, so updating it loses nothing');
        expect(r.composeCalls).toEqual([
          'docker compose --project-name agentic-worker up -d',
          'docker compose --project-name agentic-worker up -d',
        ]);
        expect(read(path.join(s.dir, 'compose.yaml'))).toBe(servedBundle('b'));
        expect(existsSync(path.join(s.dir, '.compose.yaml.download'))).toBe(false);
        // Still no env file: no setting was given on the shell, and the block is the updater's.
        expect(existsSync(path.join(s.dir, '.env'))).toBe(false);
        expect(r.calls).toContain('curl -fsS --max-time 3 http://127.0.0.1:7357/api/local/state');
        // Nothing of the page's answer is printed.
        expect(r.out).not.toContain('worker_name');
      },
    );

    it.each([
      ['an approved worker (connected)', pageState('connected'), false],
      ['an approved worker the core cannot reach', pageState('core_unreachable'), false],
      ['a page that refuses the read (APP_WORKER_UI_AUTH=token)', undefined, false],
      ['a page that does not answer, even after the start', 'down', false],
      [
        'a page whose log tail quotes a needs_claude line',
        pageState('connected', '\\"connection\\":\\"needs_claude\\"'),
        false,
      ],
      ['a worker the updater has already moved (a managed block)', pageState('needs_claude'), true],
    ])(
      'keeps today’s path for %s: the images stay and it only starts what is stopped, once',
      (_case, state, block) => {
        const s = stage();
        expect(run(shell, s).status).toBe(0);
        if (block) writeFileSync(path.join(s.dir, '.env'), updaterEnvFile('a'));
        const bundleBefore = read(path.join(s.dir, 'compose.yaml'));
        writeFileSync(s.bundle, servedBundle('b'));
        const r = run(shell, s, [], state === undefined ? {} : { STUB_PAGE_STATE: state });
        expect(r.status).toBe(0);
        expect(r.out).toContain('this installer never changes the images a worker runs');
        expect(r.out).not.toContain('not set up yet');
        expect(r.composeCalls.slice(1)).toEqual([
          'docker compose --project-name agentic-worker start',
        ]);
        expect(read(path.join(s.dir, 'compose.yaml'))).toBe(bundleBefore);
        expect(existsSync(path.join(s.dir, '.compose.yaml.download'))).toBe(false);
      },
    );

    it('starts a stopped worker whose page answered nothing, reads the page again, and installs the served build when it is not set up yet', () => {
      const s = stage();
      expect(run(shell, s).status).toBe(0);
      writeFileSync(s.bundle, servedBundle('b'));
      const r = run(shell, s, [], { STUB_PAGE_STATE_AFTER_START: pageState('needs_claude') });
      expect(r.status).toBe(0);
      expect(r.composeCalls).toEqual([
        'docker compose --project-name agentic-worker up -d',
        'docker compose --project-name agentic-worker start',
        'docker compose --project-name agentic-worker up -d',
      ]);
      expect(r.out).toContain('is not set up yet, so updating it loses nothing');
      expect(r.out).not.toContain('this installer never changes the images a worker runs');
      expect(read(path.join(s.dir, 'compose.yaml'))).toBe(servedBundle('b'));
      // The same, approved: started once, and its images stay.
      const approved = stage();
      expect(run(shell, approved).status).toBe(0);
      const before = read(path.join(approved.dir, 'compose.yaml'));
      writeFileSync(approved.bundle, servedBundle('b'));
      const kept = run(shell, approved, [], {
        STUB_PAGE_STATE_AFTER_START: pageState('connected'),
      });
      expect(kept.status).toBe(0);
      expect(kept.composeCalls.slice(1)).toEqual([
        'docker compose --project-name agentic-worker start',
      ]);
      expect(kept.out).toContain('this installer never changes the images a worker runs');
      expect(read(path.join(approved.dir, 'compose.yaml'))).toBe(before);
      expect(existsSync(path.join(approved.dir, '.compose.yaml.download'))).toBe(false);
    });

    it('refuses when nothing of the worker is in Docker and its folder pins another build than the core serves', () => {
      const s = stage();
      expect(run(shell, s).status).toBe(0);
      rmUp(s);
      writeFileSync(path.join(s.dir, '.env'), updaterEnvFile('b'));
      const r = run(shell, s);
      expect(r.status).toBe(3);
      expect(r.out).toContain('would bypass the updater');
      expect(r.composeCalls).toEqual(['docker compose --project-name agentic-worker up -d']);
      expect(read(path.join(s.dir, '.env'))).toBe(updaterEnvFile('b'));
      expect(read(path.join(s.dir, 'compose.yaml'))).toBe(servedBundle('a'));
    });

    it('brings a removed worker back as it was when the core still serves its build', () => {
      const s = stage();
      expect(run(shell, s).status).toBe(0);
      rmUp(s);
      const r = run(shell, s);
      expect(r.status).toBe(0);
      expect(r.composeCalls.at(-1)).toBe('docker compose --project-name agentic-worker up -d');
    });

    it('refuses a folder it did not make, and writes nothing into it', () => {
      const s = stage();
      mkdirSync(s.dir, { recursive: true });
      writeFileSync(path.join(s.dir, 'notes.txt'), 'mine');
      const r = run(shell, s, ['--dir', s.dir]);
      expect(r.status).toBe(3);
      expect(r.out).toContain('was not made by this installer');
      expect(existsSync(path.join(s.dir, 'compose.yaml'))).toBe(false);
      expect(r.composeCalls).toEqual([]);
      // Not asked for that folder, it leaves it alone and installs beside it, named (S-29.2).
      const beside = run(shell, s, ['--no-open']);
      expect(beside.status).toBe(0);
      expect(beside.composeCalls).toEqual([
        `docker compose --project-name agentic-worker-${SLUG} up -d`,
      ]);
      expect(readFileSync(path.join(s.dir, 'notes.txt'), 'utf8')).toBe('mine');
      expect(existsSync(path.join(s.dir, 'compose.yaml'))).toBe(false);
      // An empty folder is adopted.
      const empty = stage();
      mkdirSync(empty.dir, { recursive: true });
      expect(run(shell, empty).status).toBe(0);
    });

    it('refuses to take over a bundle named agentic-worker that runs from another folder, and an update being applied', () => {
      const s = stage();
      const r = run(shell, s, [], { STUB_FOREIGN: '/Users/someone/www/agentic-platform' });
      expect(r.status).toBe(3);
      expect(r.out).toContain('already runs from /Users/someone/www/agentic-platform');
      expect(r.composeCalls).toEqual([]);
      const busy = stage();
      const applying = run(shell, busy, [], { STUB_APPLYING: 'abc123\n' });
      expect(applying.status).toBe(3);
      expect(applying.out).toContain('applying an update right now');
      expect(applying.composeCalls).toEqual([]);
    });

    it('accepts its own install after an update: the label names the updater’s mount, the mark says it is ours, the folder holds the new build (S-22.21)', () => {
      const s = stage();
      expect(run(shell, s).status).toBe(0);
      // What the updater leaves (TD-032's 2026-11-05 decision-4 amendment): Compose's label names its
      // mount path, and the folder holds the build it applied — its compose file and the .env block.
      writeFileSync(path.join(s.state, 'wd'), '/var/lib/platform/host-bundle\n');
      writeFileSync(path.join(s.dir, 'compose.yaml'), servedBundle('b'));
      writeFileSync(path.join(s.dir, '.env'), updaterEnvFile('b'));
      writeFileSync(s.bundle, servedBundle('b'));
      const r = run(shell, s);
      expect(r.out).not.toContain('will not take it over');
      expect(r.status).toBe(0);
      expect(r.composeCalls.at(-1)).toBe(
        'docker compose --project-name agentic-worker up -d --no-recreate',
      );
      expect(read(path.join(s.dir, '.env'))).toBe(updaterEnvFile('b'));
      // And a folder without the mark, meeting that same project, takes no part of it (S-29.2):
      // this core's worker is a new one beside it, named after its platform, in --dir when given.
      const other = stage();
      writeFileSync(path.join(other.state, 'up'), '');
      writeFileSync(path.join(other.state, 'wd'), '/var/lib/platform/host-bundle\n');
      const mine = path.join(other.home, 'mine');
      const beside = run(shell, other, ['--dir', mine]);
      expect(beside.status).toBe(0);
      expect(beside.composeCalls).toEqual([
        `docker compose --project-name agentic-worker-${SLUG} up -d`,
      ]);
      expect(read(path.join(mine, '.env'))).toContain(
        `COMPOSE_PROJECT_NAME=agentic-worker-${SLUG}\n`,
      );
      expect(existsSync(other.dir)).toBe(false);
      // A re-run with no --dir finds it by the folder its updater mounts.
      const again = run(shell, other);
      expect(again.status).toBe(0);
      expect(again.composeCalls.at(-1)).toBe(
        `docker compose --project-name agentic-worker-${SLUG} up -d --no-recreate`,
      );
    });

    it('refuses a bundle with no updater, or one under a profile, and installs nothing', () => {
      const noUpdater = stage();
      const without = servedBundle('a').replace('\n  updater:\n', '\n  not-the-updater:\n');
      writeFileSync(noUpdater.bundle, without);
      const r = run(shell, noUpdater);
      expect(r.status).toBe(1);
      expect(r.out).toContain('has no updater service');
      expect(existsSync(path.join(noUpdater.dir, 'compose.yaml'))).toBe(false);
      expect(r.composeCalls).toEqual([]);
      const profiled = stage();
      writeFileSync(
        profiled.bundle,
        servedBundle('a').replace('\n  updater:\n', '\n  updater:\n    profiles: [self-update]\n'),
      );
      const p = run(shell, profiled);
      expect(p.status).toBe(1);
      expect(p.out).toContain('compose profiles');
      expect(p.composeCalls).toEqual([]);
    });

    it.each([
      ['exited|Exited (1) 2 seconds ago', 'updater: exited'],
      ['running|Up 2 seconds (health: starting)', 'updater: starting'],
      ['running|Up 2 minutes (unhealthy)', 'updater: unhealthy'],
    ])('waits for the updater and fails naming it when it is %s', (status, named) => {
      const s = stage();
      writeFileSync(path.join(s.state, 'state-updater'), `${status}\n`);
      const r = run(shell, s);
      expect(r.status).toBe(1);
      expect(r.out).toContain(named);
      expect(r.out).toContain('worker: ready');
    });

    it('counts a healthy updater as ready, and fails naming the page when it does not answer', () => {
      const s = stage();
      writeFileSync(path.join(s.state, 'state-updater'), 'running|Up 1 minute (healthy)\n');
      expect(run(shell, s).status).toBe(0);
      const down = stage();
      const r = run(shell, down, [], { STUB_PAGE: 'down' });
      expect(r.status).toBe(1);
      expect(r.out).toContain('page http://127.0.0.1:7357: waiting');
    });

    it.each([
      ['Darwin', 'https://docs.docker.com/desktop/setup/install/mac-install/'],
      ['Linux', 'https://docs.docker.com/engine/install/'],
    ])('says exactly what to install when Docker is missing (%s)', (os, link) => {
      const s = stage({ docker: false });
      const r = run(shell, s, [], { STUB_UNAME: os });
      expect(r.status).toBe(1);
      expect(r.out).toContain(link);
      expect(existsSync(s.dir)).toBe(false);
    });

    it('says to start Docker when its daemon does not answer', () => {
      const s = stage();
      const r = run(shell, s, [], { STUB_UNAME: 'Darwin', STUB_DOCKER_INFO: 'down' });
      expect(r.status).toBe(1);
      expect(r.out).toContain('Start Docker Desktop');
      expect(existsSync(s.dir)).toBe(false);
    });

    it('names the core’s answer when the bundle cannot be downloaded', () => {
      const s = stage();
      const r = run(shell, s, [], { STUB_BUNDLE_FAIL: '1' });
      expect(r.status).toBe(1);
      expect(r.out).toContain(
        `could not download the worker bundle from ${CORE}/api/worker/v1/compose.yml`,
      );
      expect(r.composeCalls).toEqual([]);
    });

    it('takes --dir and --core, and refuses a core it was not installed from', () => {
      const s = stage();
      const other = path.join(s.home, 'elsewhere');
      const r = run(shell, s, ['--dir', other, '--core', 'https://second.example.test/']);
      expect(r.status).toBe(0);
      expect(read(path.join(other, '.agentic-worker-install'))).toContain(
        'core=https://second.example.test\n',
      );
      expect(r.calls).toContain(
        `curl -fsSL --proto =https --max-time 120 -o ${other}/.compose.yaml.download https://second.example.test/api/worker/v1/compose.yml`,
      );
      const moved = run(shell, s, [`--dir=${other}`]);
      expect(moved.status).toBe(3);
      expect(moved.out).toContain('was installed from https://second.example.test');
      // An https core is fetched over https only; an http one (a core on this machine) may be http.
      const local = stage();
      const plain = run(shell, local, ['--core', 'http://localhost:8080']);
      expect(plain.status).toBe(0);
      expect(plain.calls).toContain(
        `curl -fsSL --proto =https,http --max-time 120 -o ${local.dir}/.compose.yaml.download http://localhost:8080/api/worker/v1/compose.yml`,
      );
    });

    it.each([
      [
        ['--core', "https://core.example.test/'; rm -rf ~"],
        'a character this installer does not accept',
      ],
      [['--core', 'ftp://core.example.test'], 'must start with https://'],
      [['--purge'], '--purge goes with --uninstall'],
      [['--frobnicate'], 'unknown option'],
    ])('refuses %j as a usage error', (args, message) => {
      const s = stage();
      const r = run(shell, s, args);
      expect(r.status).toBe(2);
      expect(r.out).toContain(message);
      expect(r.calls).toEqual([]);
    });

    it('refuses to run unrendered, naming --core', () => {
      const s = stage();
      writeFileSync(path.join(s.root, 'install.sh'), readInstallScriptTemplate('install.sh'));
      const r = run(shell, s);
      expect(r.status).toBe(2);
      expect(r.out).toContain('not served by a core');
    });

    it('uninstalls: containers only by default, volumes and its own files with --purge', () => {
      const s = stage();
      expect(run(shell, s).status).toBe(0);
      writeFileSync(path.join(s.dir, '.env'), updaterEnvFile('a'));
      const kept = run(shell, s, ['--uninstall']);
      expect(kept.status).toBe(0);
      expect(kept.composeCalls.at(-1)).toBe(
        'docker compose --project-name agentic-worker down --remove-orphans',
      );
      expect(read(path.join(s.dir, '.env'))).toBe(updaterEnvFile('a'));
      // The advice agrees with the refusal a moved core gets: start it with Compose, as it was.
      expect(kept.out).toContain(`cd '${s.dir}' && docker compose up -d`);
      // No volume is touched (an install's label reads, `docker volume inspect --format …`, aside).
      expect(
        kept.calls.some((call) => call.startsWith('docker volume') && !call.includes('--format')),
      ).toBe(false);
      const purged = run(shell, s, ['--uninstall', '--purge']);
      expect(purged.status).toBe(0);
      expect(purged.composeCalls.at(-1)).toBe(
        'docker compose --project-name agentic-worker down --volumes --remove-orphans',
      );
      // The launcher's repository cache (cloned source) goes too; Compose does not own it.
      // (An install's label reads, `docker volume inspect --format …`, aside.)
      const volumeCalls = purged.calls.filter(
        (call) => call.startsWith('docker volume') && !call.includes('--format'),
      );
      expect(volumeCalls).toEqual([
        'docker volume inspect agentic-worker-repo-cache',
        'docker volume rm agentic-worker-repo-cache',
      ]);
      expect(purged.out).toContain('its repository cache');
      expect(existsSync(s.dir)).toBe(false);
      // A folder it did not make is never removed.
      const foreign = stage();
      mkdirSync(foreign.dir, { recursive: true });
      writeFileSync(path.join(foreign.dir, 'compose.yaml'), 'services: {}\n');
      const refused = run(shell, foreign, ['--uninstall', '--purge']);
      expect(refused.status).toBe(3);
      expect(read(path.join(foreign.dir, 'compose.yaml'))).toBe('services: {}\n');
    });

    // ── S-29.2: several workers on one machine, one per core (TD-031 2026-11-24, decision 9) ──

    it('puts a second core’s worker beside the first: ~/agentic-worker-<slug>, its own project, names and first free port in .env, the first untouched (S-29.2 (2), (4))', () => {
      const s = stage();
      expect(run(shell, s, ['--core', OTHER_CORE, '--no-open']).status).toBe(0);
      const first = folderBytes(s.dir);
      expect(Object.keys(first)).toEqual(['.agentic-worker-install', 'compose.yaml']);
      // 7357 the first worker publishes, 7358 a stopped container binds, 7359 something listens on.
      const before = run(shell, s, ['--help']);
      const r = run(shell, s, ['--no-open'], { STUB_BOUND_PORTS: '7358', STUB_LISTENING: '7359' });
      expect(r.status).toBe(0);
      const project = `agentic-worker-${SLUG}`;
      const second = path.join(s.home, project);
      expect(r.out).toContain(`named after its platform: ${SLUG}, in ${second}`);
      expect(since(before, r).composeCalls).toEqual([
        `docker compose --project-name ${project} up -d`,
      ]);
      const env = [
        `COMPOSE_PROJECT_NAME=${project}`,
        `APP_WORKER_CONTROL_VOLUME=${project}-ctl`,
        `APP_WORKER_CACHE_VOLUME=${project}-repo-cache`,
        `APP_WORKER_RUN_NETWORK=${project}-run-egress`,
        'APP_WORKER_UI_PORT=7360',
        '',
      ].join('\n');
      // A platform's name is never written as the label: a rename still reaches the page.
      expect(read(path.join(second, '.env'))).toBe(env);
      expect(statSync(path.join(second, '.env')).mode & 0o777).toBe(0o600);
      expect(read(path.join(projectState(s, project), 'env-at-up'))).toBe(env);
      expect(read(path.join(projectState(s, project), 'wd'))?.trim()).toBe(second);
      expect(read(path.join(second, '.agentic-worker-install'))).toContain(`core=${CORE}\n`);
      expect(r.out).toContain('http://127.0.0.1:7360 (open it in a browser)');
      expect(r.out).toContain(`Its name:   compose project ${project}`);
      expect(folderBytes(s.dir)).toEqual(first);
      // A re-run of each repairs its own and recreates nothing (S-29.2 (3)).
      const mine = run(shell, s, ['--no-open']);
      expect(mine.status).toBe(0);
      expect(since(r, mine).composeCalls).toEqual([
        `docker compose --project-name ${project} up -d --no-recreate`,
      ]);
      expect(mine.out).toContain('http://127.0.0.1:7360');
      expect(read(path.join(second, '.env'))).toBe(env);
      const theirs = run(shell, s, ['--core', OTHER_CORE, '--no-open']);
      expect(theirs.status).toBe(0);
      expect(since(mine, theirs).composeCalls).toEqual([
        'docker compose --project-name agentic-worker up -d --no-recreate',
      ]);
      expect(theirs.out).toContain('http://127.0.0.1:7357');
      expect(folderBytes(s.dir)).toEqual(first);
    });

    it('--name makes a new worker of that name, its label written too; dev and a name outside the pattern are refused with a sentence (S-29.2 (2))', () => {
      const s = stage();
      const r = run(shell, s, ['--name', 'laptop', '--no-open'], {
        APP_WORKER_RUN_NETWORK: 'mine-egress',
      });
      expect(r.status).toBe(0);
      const folder = path.join(s.home, 'agentic-worker-laptop');
      expect(r.composeCalls).toEqual(['docker compose --project-name agentic-worker-laptop up -d']);
      // The shell's own value wins over the installer's name, and is kept like every setting.
      expect(read(path.join(folder, '.env'))).toBe(
        [
          'COMPOSE_PROJECT_NAME=agentic-worker-laptop',
          'APP_WORKER_CONTROL_VOLUME=agentic-worker-laptop-ctl',
          'APP_WORKER_CACHE_VOLUME=agentic-worker-laptop-repo-cache',
          'APP_WORKER_UI_PORT=7357',
          'APP_WORKER_LABEL=laptop',
          'APP_WORKER_RUN_NETWORK=mine-egress',
          '',
        ].join('\n'),
      );
      expect(existsSync(s.dir)).toBe(false);
      for (const [args, said] of [
        [['--name', 'dev'], '--name dev is refused: pnpm worker:dev uses the project'],
        [['--name', 'Laptop'], '--name must be 1 to 24 characters'],
        [['--name=-x'], '--name must be 1 to 24 characters'],
        [['--name', 'a'.repeat(25)], '--name must be 1 to 24 characters'],
        [['--name', 'a_b'], '--name must be 1 to 24 characters'],
        [['--name', "x'y"], '--name must be 1 to 24 characters'],
        [['--name'], '--name needs a name'],
      ] as const) {
        const t = stage();
        const refused = run(shell, t, args);
        expect(refused.status, args.join(' ')).toBe(2);
        expect(refused.out, args.join(' ')).toContain(said);
        expect(refused.calls, args.join(' ')).toEqual([]);
      }
    });

    it('finds this core’s worker in the decision’s order and repairs the first, naming a second; --name on it writes only the label (S-29.2 (3))', () => {
      const s = stage();
      expect(run(shell, s, ['--no-open']).status).toBe(0);
      // A second folder marked with this core (by hand: the installer makes one per core).
      const copy = path.join(s.home, 'agentic-worker-copy');
      mkdirSync(copy);
      writeFileSync(
        path.join(copy, '.agentic-worker-install'),
        read(path.join(s.dir, '.agentic-worker-install')) as string,
      );
      const before = run(shell, s, ['--help']);
      const r = run(shell, s, ['--name', 'desk', '--no-open']);
      expect(r.status).toBe(0);
      expect(r.out).toContain(`this core has another worker on this machine too, in ${copy}`);
      expect(r.out).toContain('--name sets only the label its page shows');
      expect(since(before, r).composeCalls).toEqual([
        'docker compose --project-name agentic-worker up -d --no-recreate',
      ]);
      // Never renamed: its folder and project stay; the label waits for its next update.
      expect(read(path.join(s.dir, '.env'))).toBe('APP_WORKER_LABEL=desk\n');
      expect(r.out).toContain('a worker already running takes a changed one at its next update');
      expect(existsSync(path.join(s.home, 'agentic-worker-desk'))).toBe(false);
      expect(readFileSync(path.join(copy, '.agentic-worker-install'), 'utf8')).toContain(CORE);
      expect(existsSync(path.join(copy, 'compose.yaml'))).toBe(false);
    });

    it('refuses a name another core’s worker or a project of this machine holds, naming --name (S-29.2 (3))', () => {
      const s = stage();
      expect(run(shell, s, ['--core', OTHER_CORE, '--no-open']).status).toBe(0);
      // A third core whose platform has the same slug got there first (two unrenamed cores).
      const third = 'https://third.example.test';
      expect(run(shell, s, ['--core', third, '--name', SLUG, '--no-open']).status).toBe(0);
      const taken = path.join(s.home, `agentic-worker-${SLUG}`);
      const before = run(shell, s, ['--help']);
      const r = run(shell, s, ['--no-open']);
      expect(r.status).toBe(3);
      expect(r.out).toContain(
        `the name ${SLUG} is taken on this machine: ${taken} holds the worker of ${third}`,
      );
      expect(r.out).toContain('--name <another name>');
      expect(since(before, r).composeCalls).toEqual([]);
      expect(read(path.join(taken, '.agentic-worker-install'))).toContain(`core=${third}\n`);
      // With a name of its own, it installs.
      const named = run(shell, s, ['--name', 'mine', '--no-open']);
      expect(named.status).toBe(0);
      expect(since(r, named).composeCalls).toEqual([
        'docker compose --project-name agentic-worker-mine up -d',
      ]);
      // A compose project of the name already on this machine (made by hand) is refused as well.
      const t = stage();
      writeFileSync(path.join(projectState(t, 'agentic-worker-hand'), 'up'), '');
      const hand = run(shell, t, ['--name', 'hand']);
      expect(hand.status).toBe(3);
      expect(hand.out).toContain('the compose project agentic-worker-hand already exists');
      expect(hand.composeCalls).toEqual([]);
      expect(existsSync(path.join(t.home, 'agentic-worker-hand'))).toBe(false);
    });

    it('asks for --name for a second worker when the core rendered no slug (S-29.2 (1))', () => {
      const s = stage();
      writeFileSync(
        path.join(s.root, 'install.sh'),
        readInstallScriptTemplate('install.sh').replaceAll(INSTALL_CORE_URL_PLACEHOLDER, CORE),
      );
      expect(run(shell, s, ['--core', OTHER_CORE, '--no-open']).status).toBe(0);
      const r = run(shell, s, ['--no-open']);
      expect(r.status).toBe(3);
      expect(r.out).toContain('Run it again with --name');
      expect(existsSync(path.join(s.home, 'agentic-worker-'))).toBe(false);
    });

    it('--uninstall --name removes that install only; another core’s is not its to remove (S-29.2 (5))', () => {
      const s = stage();
      expect(run(shell, s, ['--core', OTHER_CORE, '--no-open']).status).toBe(0);
      expect(run(shell, s, ['--no-open']).status).toBe(0);
      const project = `agentic-worker-${SLUG}`;
      const second = path.join(s.home, project);
      const first = folderBytes(s.dir);
      const before = run(shell, s, ['--help']);
      const removed = run(shell, s, ['--uninstall', '--purge', '--name', SLUG]);
      expect(removed.status).toBe(0);
      const calls = since(before, removed);
      expect(calls.composeCalls).toEqual([
        `docker compose --project-name ${project} down --volumes --remove-orphans`,
      ]);
      // Its own cache volume (from its .env), never the first worker's.
      expect(
        calls.calls.filter(
          (call) => call.startsWith('docker volume') && !call.includes('--format'),
        ),
      ).toEqual([
        `docker volume inspect ${project}-repo-cache`,
        `docker volume rm ${project}-repo-cache`,
      ]);
      expect(existsSync(second)).toBe(false);
      expect(folderBytes(s.dir)).toEqual(first);
      expect(existsSync(path.join(s.state, 'up'))).toBe(true);
      // This core has no worker left here, and the first is another core's.
      const none = run(shell, s, ['--uninstall']);
      expect(none.status).toBe(3);
      expect(none.out).toContain(`no worker of ${CORE} is installed on this machine`);
      const theirs = run(shell, s, ['--uninstall', '--dir', s.dir]);
      expect(theirs.status).toBe(3);
      expect(theirs.out).toContain(`holds the worker of ${OTHER_CORE}`);
      const unknown = run(shell, s, ['--uninstall', '--name', 'nobody']);
      expect(unknown.status).toBe(3);
      expect(unknown.out).toContain('nothing to remove');
      expect(since(removed, unknown).composeCalls).toEqual([]);
      // Its own core's script removes the first, by the same resolution.
      const own = run(shell, s, ['--uninstall', '--core', OTHER_CORE]);
      expect(own.status).toBe(0);
      expect(since(unknown, own).composeCalls).toEqual([
        'docker compose --project-name agentic-worker down --remove-orphans',
      ]);
    });
  },
  STUB_RUN_TIMEOUT_MS,
);

/** A second core, whose worker a test installs first (S-29.2). */
const OTHER_CORE = 'https://other.example.test';

/** The stub's state folder of a project other than agentic-worker (made when missing). */
const projectState = (s: Stage, project: string): string => {
  const folder = path.join(s.state, 'projects', project);
  mkdirSync(folder, { recursive: true });
  return folder;
};

/** Every file of a folder and its bytes, to show a run left it as it was. */
const folderBytes = (folder: string): Record<string, string> =>
  Object.fromEntries(
    readdirSync(folder)
      .sort()
      .map((name) => [name, readFileSync(path.join(folder, name), 'utf8')]),
  );

/** The calls a run made after another (the stub's log is the stage's, kept across runs). */
const since = (
  earlier: { readonly calls: readonly string[] },
  later: { readonly calls: readonly string[] },
) => {
  const calls = later.calls.slice(earlier.calls.length);
  return {
    calls,
    composeCalls: calls.filter((call) => call.startsWith('docker compose --project-name')),
  };
};

/** The stub's "nothing of the project is in Docker" (a person's `docker compose down`). */
const rmUp = (s: Stage): void => {
  rmSync(path.join(s.state, 'up'), { force: true });
};

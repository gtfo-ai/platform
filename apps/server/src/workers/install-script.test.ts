/**
 * The worker's one-command install (S-22.20): what the core renders, and what `install.sh` does
 * with a stub `docker`, `curl`, `uname` and browser opener on `PATH` — run under every POSIX shell
 * this machine has (`/bin/sh`, and `dash` where it exists: CI's Ubuntu `sh` is dash).
 *
 * The owner's requirement is **autoupdate always**: a bundle the installer starts runs its
 * `updater` with the shipped trust defaults, and a re-run never moves the images a worker runs,
 * never rewrites the env file the updater manages and never touches a volume. Each of those is a
 * test below. `install.ps1` gets the same structural checks here; it runs on a Windows runner
 * (`.github/workflows/worker-install.yml`), because no tier of this repository has PowerShell.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
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
  InstallScriptError,
  installCoreUrlOf,
  readInstallScriptTemplate,
  renderInstallScript,
  renderInstallScripts,
} from './install.js';

const CORE = 'https://core.example.test';
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

const SH = renderInstallScript(readInstallScriptTemplate('install.sh'), CORE);
const PS1 = renderInstallScript(readInstallScriptTemplate('install.ps1'), CORE);

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

// ── install.sh against stubs ─────────────────────────────────────────────────────────────────────

const DOCKER_STUB = String.raw`#!/bin/sh
# A stub docker for install-script.test.ts: records each call and answers from $STUB_STATE.
printf 'docker %s\n' "$*" >> "$STUB_LOG"
case "$1" in
  info)
    [ "${'${STUB_DOCKER_INFO:-ok}'}" = ok ] || exit 1
    exit 0
    ;;
  ps)
    case "$*" in
      *org.platform.update-apply=*) printf '%s' "${'${STUB_APPLYING:-}'}"; exit 0 ;;
      *com.docker.compose.project.working_dir*)
        [ -f "$STUB_STATE/up" ] && cat "$STUB_STATE/wd"
        [ -n "${'${STUB_FOREIGN:-}'}" ] && printf '%s\n' "$STUB_FOREIGN"
        exit 0
        ;;
      *com.docker.compose.service=*)
        service=$(printf '%s\n' "$*" | sed -n 's/.*com\.docker\.compose\.service=\([a-z-]*\).*/\1/p')
        [ -f "$STUB_STATE/up" ] || exit 0
        if [ -f "$STUB_STATE/state-$service" ]; then cat "$STUB_STATE/state-$service"; else printf 'running|Up 3 seconds\n'; fi
        exit 0
        ;;
      *--quiet*)
        [ -f "$STUB_STATE/up" ] && printf 'c0ffee\n'
        exit 0
        ;;
    esac
    ;;
  compose)
    [ "$2" = version ] && { printf 'Docker Compose version v5.7.0\n'; exit 0; }
    case "$*" in
      *' up '* | *' up')
        pwd > "$STUB_STATE/wd"
        : > "$STUB_STATE/up"
        env | grep -E '^(PLATFORM_|APP_TRUSTED_|APP_CORE_URL|COMPOSE_|CLAUDE_CODE_OAUTH_TOKEN)' | sort > "$STUB_STATE/up-env"
        exit "${'${STUB_UP_EXIT:-0}'}"
        ;;
      *' start'*) : > "$STUB_STATE/up"; exit 0 ;;
      *' down'*) rm -f "$STUB_STATE/up"; exit 0 ;;
    esac
    ;;
  volume)
    # The launcher's repository cache: present unless STUB_NO_CACHE is set; removal is recorded.
    [ "$2" = inspect ] && { [ -z "${'${STUB_NO_CACHE:-}'}" ]; exit $?; }
    exit 0
    ;;
esac
echo "stub docker: unexpected: $*" >&2
exit 64
`;

const CURL_STUB = String.raw`#!/bin/sh
# A stub curl: the core's compose.yml from $STUB_BUNDLE, the local page from $STUB_PAGE, and the
# page's state from $STUB_PAGE_STATE (unset: the page answers it with an error).
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
    [ -n "${'${STUB_PAGE_STATE:-}'}" ] || exit 22
    printf '%s' "$STUB_PAGE_STATE"
    ;;
  http://127.0.0.1:*) [ "${'${STUB_PAGE:-up}'}" = up ] || exit 7 ;;
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
      // The installer never writes the env file: it is the updater's.
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
        // Still no env file: the installer never writes the updater's.
        expect(existsSync(path.join(s.dir, '.env'))).toBe(false);
        expect(r.calls).toContain('curl -fsS --max-time 3 http://127.0.0.1:7357/api/local/state');
        // Nothing of the page's answer is printed.
        expect(r.out).not.toContain('worker_name');
      },
    );

    it.each([
      ['an approved worker (connected)', pageState('connected'), false],
      ['an approved worker the core cannot reach', pageState('core_unreachable'), false],
      ['a page that cannot be read (APP_WORKER_UI_AUTH=token, or down)', undefined, false],
      [
        'a page whose log tail quotes a needs_claude line',
        pageState('connected', '\\"connection\\":\\"needs_claude\\"'),
        false,
      ],
      ['a worker the updater has already moved (a managed block)', pageState('needs_claude'), true],
    ])(
      'keeps today’s path for %s: the images stay and it only starts what is stopped',
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
        expect(r.composeCalls.at(-1)).toBe('docker compose --project-name agentic-worker start');
        expect(read(path.join(s.dir, 'compose.yaml'))).toBe(bundleBefore);
      },
    );

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
      const r = run(shell, s);
      expect(r.status).toBe(3);
      expect(r.out).toContain('was not made by this installer');
      expect(existsSync(path.join(s.dir, 'compose.yaml'))).toBe(false);
      expect(r.composeCalls).toEqual([]);
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
      // And an unmarked folder meeting that same project refuses: it is someone else's.
      const other = stage();
      writeFileSync(path.join(other.state, 'up'), '');
      writeFileSync(path.join(other.state, 'wd'), '/var/lib/platform/host-bundle\n');
      const refused = run(shell, other);
      expect(refused.status).toBe(3);
      expect(refused.out).toContain("is not this installer's");
      expect(refused.composeCalls).toEqual([]);
      expect(existsSync(path.join(other.dir, 'compose.yaml'))).toBe(false);
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
      expect(kept.calls.some((call) => call.startsWith('docker volume'))).toBe(false);
      const purged = run(shell, s, ['--uninstall', '--purge']);
      expect(purged.status).toBe(0);
      expect(purged.composeCalls.at(-1)).toBe(
        'docker compose --project-name agentic-worker down --volumes --remove-orphans',
      );
      // The launcher's repository cache (cloned source) goes too; Compose does not own it.
      expect(purged.calls.filter((call) => call.startsWith('docker volume'))).toEqual([
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
  },
  STUB_RUN_TIMEOUT_MS,
);

/** The stub's "nothing of the project is in Docker" (a person's `docker compose down`). */
const rmUp = (s: Stage): void => {
  rmSync(path.join(s.state, 'up'), { force: true });
};

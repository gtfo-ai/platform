import { describe, expect, it } from 'vitest';
import { LauncherConfigError, parseDockerHost, readLauncherConfig } from './config.js';

describe('DOCKER_HOST', () => {
  /**
   * The defect this replaces, in the direction that matters: `parseDockerHost(undefined)` used to
   * answer `/var/run/docker.sock`, so *absence of configuration granted the unfiltered daemon*
   * TD-021 deploys a proxy to remove (standing rules 55 and 18). Both spellings of absent are
   * asserted, because a blank variable is what a compose file with an unset interpolation produces.
   */
  it('is required, with no default: absent and blank are startup errors, not the host socket', () => {
    expect(() => parseDockerHost(undefined)).toThrow(LauncherConfigError);
    expect(() => parseDockerHost('   ')).toThrow(LauncherConfigError);
    expect(() => parseDockerHost(undefined)).toThrow(/no default/);
    // The whole launcher, not only the parser: a build with nothing set does not start.
    expect(() => readLauncherConfig({})).toThrow(LauncherConfigError);
  });

  it('parses a unix socket and a TCP endpoint, which is what the socket proxy is', () => {
    expect(parseDockerHost('unix:///run/docker.sock')).toEqual({
      socketPath: '/run/docker.sock',
    });
    expect(parseDockerHost('tcp://docker-socket-proxy:2375')).toEqual({
      host: 'docker-socket-proxy',
      port: 2375,
    });
  });

  /**
   * Refused rather than downgraded. TD-021's whole claim is that exactly one component reaches the
   * daemon; "the launcher quietly talked to a different daemon than the operator meant" has no
   * symptom until a container appears somewhere unexpected.
   */
  it.each([
    ['an ssh endpoint', 'ssh://user@host'],
    ['a bare host', 'docker-socket-proxy:2375'],
    ['an https endpoint', 'https://docker-socket-proxy:2376'],
    ['a unix url with no path', 'unix://'],
    ['a unix url with a relative path', 'unix://docker.sock'],
    ['a TCP url with no port', 'tcp://docker-socket-proxy'],
    ['a TCP url with a nonsense port', 'tcp://proxy:not-a-port'],
    ['a TCP url with an out-of-range port', 'tcp://proxy:70000'],
  ])('refuses %s', (_label, value) => {
    expect(() => parseDockerHost(value)).toThrow(LauncherConfigError);
  });
});

describe('launcher configuration', () => {
  /** The one variable with no default; everything else below is defaulted. */
  const DAEMON = { DOCKER_HOST: 'tcp://docker-socket-proxy:2375' };

  it('has a working default for everything but the daemon', () => {
    const config = readLauncherConfig(DAEMON);
    expect(config).toMatchObject({
      controlVolume: 'agentic-ctl',
      controlRoot: '/run/agentic/ctl',
      cacheVolume: 'agentic-repo-cache',
      helperNetwork: 'bridge',
      egressNetwork: 'bridge',
      retentionSweepMs: 3_600_000,
    });
    // The one that matters: with no `APP_WORKSPACE_RUNTIME_SOURCE_DIR`, no run container gets a
    // bind mount at all (`hardening.ts` § "The one hole, named").
    expect(config.images.runtimeSourceDir).toBeNull();
  });

  it('ignores the rest of the environment rather than refusing it', () => {
    // `process.env` carries the world; a strict schema over all of it would refuse to start on any
    // machine. Strictness applies to the names this service owns.
    expect(() =>
      readLauncherConfig({ ...DAEMON, PATH: '/usr/bin', SOMETHING_ELSE: 'x' }),
    ).not.toThrow();
  });

  it('refuses a misspelt variable of its own', () => {
    // A launcher that silently used `platform-runtime:latest` because
    // `APP_WORKSPACE_RUNTME_IMAGE` was misspelt would start every run on the wrong image.
    expect(() => readLauncherConfig({ ...DAEMON, APP_WORKSPACE_RUNTME_IMAGE: 'x' })).toThrow();
  });

  it('reads the image substitute as null when it is empty', () => {
    expect(
      readLauncherConfig({ ...DAEMON, APP_WORKSPACE_RUNTIME_SOURCE_DIR: '' }).images
        .runtimeSourceDir,
    ).toBeNull();
    expect(
      readLauncherConfig({ ...DAEMON, APP_WORKSPACE_RUNTIME_SOURCE_DIR: '/srv/repo' }).images
        .runtimeSourceDir,
    ).toBe('/srv/repo');
  });

  it('refuses a sweep interval that is not a positive integer', () => {
    expect(() =>
      readLauncherConfig({ ...DAEMON, APP_WORKSPACE_RETENTION_SWEEP_MS: '0' }),
    ).toThrow();
    expect(() =>
      readLauncherConfig({ ...DAEMON, APP_WORKSPACE_RETENTION_SWEEP_MS: '-1' }),
    ).toThrow();
    expect(
      readLauncherConfig({ ...DAEMON, APP_WORKSPACE_RETENTION_SWEEP_MS: '60000' }).retentionSweepMs,
    ).toBe(60_000);
  });
});

describe('the control plane (TD-028)', () => {
  const base = { DOCKER_HOST: 'tcp://docker-socket-proxy:2375' };

  /**
   * **Absent is `null`, and `null` is closed** (standing rules 18 and 55).
   *
   * The failure direction a default would have here is the worst one this repository knows: a
   * control plane that creates containers, listening because somebody forgot a variable. So an
   * unset `APP_LAUNCHER_TOKEN` is *no surface at all* rather than an unauthenticated one, and
   * `startLauncher` says so in the start-up log.
   */
  it('exposes no control plane when no token is set', () => {
    expect(readLauncherConfig(base).controlPlane).toBeNull();
  });

  it('refuses a token too short to be one, rather than guarding a container factory with it', () => {
    expect(() => readLauncherConfig({ ...base, APP_LAUNCHER_TOKEN: 'short' })).toThrow(
      /at least 32 characters/,
    );
  });

  it('listens on every interface by default, because the network is the isolation', () => {
    // TD-028 decision 2: an `internal: true` compose network with no published port that only the
    // runner joins. Binding the loopback would make the surface unreachable from its only caller.
    expect(
      readLauncherConfig({ ...base, APP_LAUNCHER_TOKEN: 'a'.repeat(32) }).controlPlane,
    ).toEqual({ token: 'a'.repeat(32), host: '0.0.0.0', port: 7780 });
  });

  it('honours TD-020’s `_FILE` variant for the token', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const pathMod = await import('node:path');
    const dir = await mkdtemp(pathMod.join(tmpdir(), 'agentic-launcher-token-'));
    const file = pathMod.join(dir, 'token');
    // A trailing newline is what `echo > secret` writes and what a Docker secret usually carries.
    await writeFile(file, `${'b'.repeat(32)}\n`, 'utf8');
    expect(readLauncherConfig({ ...base, APP_LAUNCHER_TOKEN_FILE: file }).controlPlane?.token).toBe(
      'b'.repeat(32),
    );
  });
});

describe('the run image’s CLI path (PROGRESS backlog 34)', () => {
  it('defaults to where `docker/runtime.Dockerfile` installs it', () => {
    expect(readLauncherConfig({ DOCKER_HOST: 'tcp://proxy:2375' }).images.runtimeCliPath).toBe(
      '/usr/local/bin/claude',
    );
  });

  it('is configurable, for an image an operator built themselves', () => {
    expect(
      readLauncherConfig({
        DOCKER_HOST: 'tcp://proxy:2375',
        APP_WORKSPACE_RUNTIME_CLI_PATH: '/opt/claude/claude',
      }).images.runtimeCliPath,
    ).toBe('/opt/claude/claude');
  });
});

describe('a blank value is absent, not present-and-empty (WP-53)', () => {
  /**
   * The defect `scripts/compose-stock-check.mjs` caught on its first extended run, and the reason
   * that check exists: the launcher container was **restarting for ever** on a stock instance.
   *
   * `.env.example` ships `APP_LAUNCHER_TOKEN=` with no value and `compose.yml` interpolates it as
   * `${APP_LAUNCHER_TOKEN:-}`, so the variable arrives as `''`. Every name in `launcherEnvSchema` is
   * `.min(1).optional()`, and `''` fails `.min(1)` — so a **strict** schema turned "the operator did
   * not set it" into a parse error, `buildLauncher` threw, the process exited 1, and
   * `restart: unless-stopped` did the rest. No tier without a daemon could see it.
   */
  it('does not refuse a stock instance whose launcher variables are empty', () => {
    const config = readLauncherConfig({
      DOCKER_HOST: 'tcp://docker-socket-proxy:2375',
      APP_LAUNCHER_TOKEN: '',
      APP_LAUNCHER_TOKEN_FILE: '',
      APP_LAUNCHER_PORT: '7780',
    });
    // Absence means *no control plane* — the fail-closed answer decided in `LauncherConfig` — and
    // that decision has to be reached rather than pre-empted by the parser.
    expect(config.controlPlane).toBeNull();
  });

  it('still refuses a blank DOCKER_HOST, which is the one absence that must not default', () => {
    // The other direction (rule 42): treating blank as absent must not turn standing rule 55's
    // refusal into a default. `parseDockerHost(undefined)` throws exactly as `('   ')` did.
    expect(() => readLauncherConfig({ DOCKER_HOST: '   ', APP_LAUNCHER_TOKEN: '' })).toThrow(
      LauncherConfigError,
    );
  });

  it('falls back to the defaults for the other blank names rather than failing the parse', () => {
    const config = readLauncherConfig({
      DOCKER_HOST: 'tcp://proxy:2375',
      APP_WORKSPACE_RUNTIME_IMAGE: '',
      APP_WORKSPACE_CONTROL_ROOT: '',
      APP_LAUNCHER_HOST: '',
    });
    expect(config.images.runtime).toBe('platform-runtime:latest');
    expect(config.controlRoot).toBe('/run/agentic/ctl');
  });
});

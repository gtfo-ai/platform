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

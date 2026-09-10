import { describe, expect, it } from 'vitest';
import { LauncherConfigError, parseDockerHost, readLauncherConfig } from './config.js';

describe('DOCKER_HOST', () => {
  it('defaults to the local socket', () => {
    expect(parseDockerHost(undefined)).toEqual({ socketPath: '/var/run/docker.sock' });
    expect(parseDockerHost('   ')).toEqual({ socketPath: '/var/run/docker.sock' });
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
  it('has a working default for everything but the daemon', () => {
    const config = readLauncherConfig({});
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
    expect(() => readLauncherConfig({ PATH: '/usr/bin', SOMETHING_ELSE: 'x' })).not.toThrow();
  });

  it('refuses a misspelt variable of its own', () => {
    // A launcher that silently used `platform-runtime:latest` because
    // `APP_WORKSPACE_RUNTME_IMAGE` was misspelt would start every run on the wrong image.
    expect(() => readLauncherConfig({ APP_WORKSPACE_RUNTME_IMAGE: 'x' })).toThrow();
  });

  it('reads the image substitute as null when it is empty', () => {
    expect(
      readLauncherConfig({ APP_WORKSPACE_RUNTIME_SOURCE_DIR: '' }).images.runtimeSourceDir,
    ).toBeNull();
    expect(
      readLauncherConfig({ APP_WORKSPACE_RUNTIME_SOURCE_DIR: '/srv/repo' }).images.runtimeSourceDir,
    ).toBe('/srv/repo');
  });

  it('refuses a sweep interval that is not a positive integer', () => {
    expect(() => readLauncherConfig({ APP_WORKSPACE_RETENTION_SWEEP_MS: '0' })).toThrow();
    expect(() => readLauncherConfig({ APP_WORKSPACE_RETENTION_SWEEP_MS: '-1' })).toThrow();
    expect(readLauncherConfig({ APP_WORKSPACE_RETENTION_SWEEP_MS: '60000' }).retentionSweepMs).toBe(
      60_000,
    );
  });
});

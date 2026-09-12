import type { LogFields, Logger } from '@platform/application';
import { runner, type workspace } from '@platform/infrastructure';
import { afterEach, describe, expect, it } from 'vitest';
import { buildLauncher, type LauncherRuntime, launcherClock } from './runtime.js';

const credentials: workspace.RunCredentialSource = {
  async mint() {
    return {
      username: 'x',
      value: 'y'.repeat(32),
      expiresAt: '2026-09-11T00:00:00.000Z',
      revokeId: null,
    };
  },
  async revoke() {},
};

const recordingLogger = (): { logger: Logger; lines: { fields: LogFields; message: string }[] } => {
  const lines: { fields: LogFields; message: string }[] = [];
  const push = (fields: LogFields, message: string) => lines.push({ fields, message });
  return { logger: { debug: push, info: push, warn: push, error: push }, lines };
};

/**
 * `DOCKER_HOST` has no default since WP-15g — an absent one is a startup error, because it used to
 * answer `/var/run/docker.sock` and that is the unfiltered daemon TD-021 deploys a proxy to remove
 * (standing rules 55 and 18). Every case below therefore sets it; the refusal itself is
 * `apps/launcher/src/config.test.ts` › "is required, with no default: absent and blank are startup
 * errors, not the host socket", and the last case here proves this composition root inherits it.
 */
const DAEMON = { DOCKER_HOST: 'tcp://docker-socket-proxy:2375' };

let runtime: LauncherRuntime | null = null;

afterEach(() => {
  runtime?.stop();
  runtime = null;
});

describe('buildLauncher', () => {
  it('builds a launcher from the environment and arms the retention sweep', () => {
    const { logger } = recordingLogger();
    runtime = buildLauncher({ env: DAEMON, credentials, uid: 1000, logger });
    expect(runtime.config.controlRoot).toBe('/run/agentic/ctl');
    expect(runtime.provider).toBeDefined();
    // `stop()` is what a graceful shutdown calls; calling it twice must be safe.
    runtime.stop();
    runtime.stop();
  });

  /**
   * Q51, at the only moment it can be caught cheaply. The shim creates its control socket `0600`
   * as uid 1000; a launcher on another uid produces runs whose control connection is refused with
   * `EACCES` three minutes in, which reads like a fault in the frame protocol.
   */
  it('refuses to start on any uid but 1000, naming both numbers', () => {
    expect(() =>
      buildLauncher({ env: DAEMON, credentials, uid: 0, logger: recordingLogger().logger }),
    ).toThrow(/must run as uid 1000.*this process is uid 0/s);
  });

  it('warns loudly when run containers mount the repository instead of an image', () => {
    const { logger, lines } = recordingLogger();
    runtime = buildLauncher({
      env: { ...DAEMON, APP_WORKSPACE_RUNTIME_SOURCE_DIR: '/srv/repo' },
      credentials,
      uid: 1000,
      logger,
    });
    // The hole `hardening.ts` names. It is not a production configuration and the log says so, so
    // an operator who set it by copying a CI compose file finds out at startup.
    expect(lines.map((line) => line.message).join('\n')).toContain('development configuration');
  });

  it('says nothing about a bind mount when there is none', () => {
    const { logger, lines } = recordingLogger();
    runtime = buildLauncher({ env: DAEMON, credentials, uid: 1000, logger });
    expect(lines.map((line) => line.message).join('\n')).not.toContain('development configuration');
  });

  /**
   * The timer that keeps the container alive (WP-22).
   *
   * `runner.systemClock` unrefs every timer it arms, which is right for `apps/server` and fatal
   * here: the launcher has no server, no socket and no queue worker, so the retention sweep is the
   * only handle it owns. Measured in the composed container — `launcher started`, exit 0, and
   * `restart: unless-stopped` looping it about once a second, with no error anywhere and a sweep
   * that never ran.
   *
   * **The first version of this case asserted nothing about `launcherClock`**: it read `hasRef()`
   * off a plain `setTimeout` it had created itself, and never looked at the handle the clock
   * returned — so it passed with `.unref()` restored, which is standing rule 3 in a test whose
   * docblock claimed "both directions". A timer's ref state is only observable through the handle,
   * and a `RunnerClock` returns a cancel function rather than the handle, so the only way to read
   * it is to intercept the call. Both clocks are measured the same way, in one place.
   */
  const armAndCapture = (clock: typeof launcherClock): NodeJS.Timeout => {
    let handle: NodeJS.Timeout | null = null;
    const original = globalThis.setTimeout;
    // @ts-expect-error — capturing the handle the clock creates is the only way to read its ref.
    globalThis.setTimeout = (...args: Parameters<typeof setTimeout>) => {
      handle = original(...args);
      return handle;
    };
    let cancel: () => void;
    try {
      cancel = clock.setTimer(60_000, () => undefined);
    } finally {
      globalThis.setTimeout = original;
    }
    cancel();
    if (handle === null) {
      throw new Error('the clock did not call setTimeout, so there is no handle to read');
    }
    return handle;
  };

  it('arms its sweep with a timer that holds the event loop, unlike the runner clock', () => {
    // The handle the *clock* made, not one this test made: with `.unref()` back in `launcherClock`
    // this line fails, which is the whole point of the case.
    expect(armAndCapture(launcherClock).hasRef()).toBe(true);
    // The one it is not: `systemClock` unrefs, and a launcher composed on it exits as soon as
    // `main()` returns. Reading both through the same helper is what makes the contrast evidence
    // rather than two unrelated assertions.
    expect(armAndCapture(runner.systemClock).hasRef()).toBe(false);
  });

  it('refuses a DOCKER_HOST it does not understand rather than falling back', () => {
    expect(() =>
      buildLauncher({
        env: { DOCKER_HOST: 'ssh://build-host' },
        credentials,
        uid: 1000,
        logger: recordingLogger().logger,
      }),
    ).toThrow(/unix:\/\/\/path or tcp:\/\/host:port/);
  });

  it('refuses an absent DOCKER_HOST here too, where the engine is actually built', () => {
    // The parser's refusal reaches the composition root: nothing between them re-introduces a
    // default, which is the half a unit test of `parseDockerHost` alone cannot state.
    expect(() =>
      buildLauncher({ env: {}, credentials, uid: 1000, logger: recordingLogger().logger }),
    ).toThrow(/DOCKER_HOST is required/);
  });
});

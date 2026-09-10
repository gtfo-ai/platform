import type { LogFields, Logger } from '@platform/application';
import type { workspace } from '@platform/infrastructure';
import { afterEach, describe, expect, it } from 'vitest';
import { buildLauncher, type LauncherRuntime } from './runtime.js';

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

let runtime: LauncherRuntime | null = null;

afterEach(() => {
  runtime?.stop();
  runtime = null;
});

describe('buildLauncher', () => {
  it('builds a launcher from the environment and arms the retention sweep', () => {
    const { logger } = recordingLogger();
    runtime = buildLauncher({ env: {}, credentials, uid: 1000, logger });
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
      buildLauncher({ env: {}, credentials, uid: 0, logger: recordingLogger().logger }),
    ).toThrow(/must run as uid 1000.*this process is uid 0/s);
  });

  it('warns loudly when run containers mount the repository instead of an image', () => {
    const { logger, lines } = recordingLogger();
    runtime = buildLauncher({
      env: { APP_WORKSPACE_RUNTIME_SOURCE_DIR: '/srv/repo' },
      credentials,
      uid: 1000,
      logger,
    });
    // The hole `hardening.ts` names. It is not a production configuration and the log says so, so
    // an operator who set it by copying a CI compose file finds out at startup.
    expect(lines.map((line) => line.message).join('\n')).toContain(
      'platform-runtime image does not exist yet',
    );
  });

  it('says nothing about a bind mount when there is none', () => {
    const { logger, lines } = recordingLogger();
    runtime = buildLauncher({ env: {}, credentials, uid: 1000, logger });
    expect(lines.map((line) => line.message).join('\n')).not.toContain('platform-runtime image');
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
});

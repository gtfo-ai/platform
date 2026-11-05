/**
 * The process entrypoint. `docker run platform` and `pnpm dev` both land here.
 *
 * Its only job is the bit `runtime.ts` cannot do for itself: turn a signal into a graceful stop
 * (TD-002's `close-with-grace`), and turn a start-up failure into a non-zero exit with one
 * readable line rather than an unhandled rejection.
 *
 * `close-with-grace` gives the whole shutdown a deadline. If the drain has not finished by then the
 * process exits anyway — a container that will not die is worse for an operator than one that
 * dropped its last few connections, and every drop is recoverable (an SSE client reconnects with
 * its cursor, an undispatched event stays in `event_dispatch`).
 */
import process from 'node:process';
import closeWithGrace from 'close-with-grace';
import { REMOTE_WORKER_ROLE } from './remote-worker/config.js';
import { startRemoteWorker } from './remote-worker/runtime.js';
import { startRuntime } from './runtime.js';
import {
  runApplyProcess,
  startUpdaterProcess,
  UPDATE_APPLY_ROLE,
  UPDATER_ROLE,
} from './updater/main.js';

/**
 * `ROLE=remote-worker` (WP-283) is not one of the core's roles: it composes no database, no secret
 * key and nothing of the pipeline, so it never reaches `loadServerConfig`, which requires both.
 */
const mainRemoteWorker = async (): Promise<void> => {
  const worker = await startRemoteWorker();
  closeWithGrace({ delay: 60_000 }, async ({ err, signal }: { err?: Error; signal?: string }) => {
    if (err !== undefined) {
      worker.logger.error({ err }, 'uncaught error, shutting down');
    } else {
      worker.logger.info({ signal }, 'signal received, handing every run back and stopping');
    }
    await worker.stop();
  });
  const address = await worker.listen();
  worker.logger.info({ address, role: REMOTE_WORKER_ROLE }, 'listening');
};

/**
 * `ROLE=updater` (WP-287): the worker's updater, which follows the core's digests. No database, no
 * secret key, no listener: a signal stops its loop, and an apply it started finishes on its own.
 */
const mainUpdater = (): void => {
  const { logger, updater } = startUpdaterProcess();
  closeWithGrace({ delay: 10_000 }, async ({ err, signal }: { err?: Error; signal?: string }) => {
    if (err !== undefined) logger.error({ err }, 'uncaught error, stopping');
    else logger.info({ signal }, 'signal received, stopping');
    updater.stop();
  });
};

const main = async (): Promise<void> => {
  const role = process.env.ROLE?.trim();
  if (role === REMOTE_WORKER_ROLE) {
    await mainRemoteWorker();
    return;
  }
  if (role === UPDATER_ROLE) {
    mainUpdater();
    return;
  }
  // `ROLE=update-apply` (WP-287): one update, then exit — the updater started it from the new image.
  if (role === UPDATE_APPLY_ROLE) {
    process.exitCode = await runApplyProcess();
    return;
  }
  const runtime = await startRuntime();

  closeWithGrace(
    { delay: runtime.config.shutdownTimeoutMs },
    async ({ err, signal }: { err?: Error; signal?: string }) => {
      if (err !== undefined) {
        runtime.logger.error({ err }, 'uncaught error, shutting down');
      } else {
        runtime.logger.info({ signal }, 'signal received, shutting down');
      }
      await runtime.stop();
    },
  );

  const address = await runtime.listen();
  runtime.logger.info({ address, role: runtime.config.role }, 'listening');
};

try {
  await main();
} catch (error) {
  // Nothing structured is available yet — the logger may be what failed — so this is the one place
  // in the server that writes to a stream directly. It is a fatal start-up error, not a log line.
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

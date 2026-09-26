#!/usr/bin/env node
/**
 * `platform-launcher` — the process entrypoint (TD-021, `docker/launcher.Dockerfile`).
 *
 * **Not** a `ROLE` of the product image: `apps/server/src/role.ts` has `all | api | worker |
 * runner | indexer` and never had a `launcher`, and TD-021's WP-15g amendment says why the
 * separation has to be a *container* rather than a role — `ROLE=all` is the shipped default, so a
 * role would put the Docker socket beside the platform's only unauthenticated endpoint.
 *
 * A composition root and nothing else: environment in, signals mapped, `process.exit` out. Every
 * decision it could get wrong is in `runtime.ts`, where the unit tier can reach it — which is why
 * this file is excluded from coverage the way `apps/runlet/src/index.ts` and
 * `apps/server/src/migrate.ts` are.
 *
 * It mints nothing, and that is the design rather than a gap (TD-028's WP-76 amendment, closing
 * PROGRESS backlog 133). Minting a run-scoped git token is `GitProviderPort.mintCredential`, a
 * mutation keyed by a binding, and this process holds no integration binding, no secret key and no
 * database connection to read one with (TD-021). So the **runner** mints through
 * `IntegrationActionExecutor` and carries the value on the create request; this process holds it in
 * its `RunCredentialBroker` for the mirror fetch and the take-over export push, and forgets it at
 * the end of the run. Until WP-76 it composed a credential source that refused by name, citing Q52,
 * and every writing run failed at `startRun`.
 */
import process from 'node:process';
import { startLauncher } from './runtime.js';

const main = async (): Promise<void> => {
  const runtime = await startLauncher({
    env: process.env,
    uid: process.getuid?.() ?? -1,
  });
  runtime.logger.info(
    {
      control_root: runtime.config.controlRoot,
      runtime_image: runtime.config.images.runtime,
      claude_code_path: runtime.config.images.runtimeCliPath,
      control_plane_port: runtime.controlPlane?.port ?? null,
    },
    'launcher started',
  );
  /**
   * SIGTERM **awaits** the close, which is the whole of standing rule 51 in this file.
   *
   * Until WP-53 there was nothing to await: the only handle was a timer, so `process.exit(0)` owed
   * nothing. There is a listener now, and `process.exit()` abandons a socket mid-response — a
   * `create` that had already started a container would be answered by a closed connection, which
   * the runner reads as `engine_unavailable` and retries, leaving the first container behind.
   * `stopping` guards a second signal from re-entering while the first close is in flight.
   */
  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    runtime.logger.info({ signal }, 'launcher stopping');
    void runtime
      .close()
      .catch((error: unknown) => {
        runtime.logger.warn({ err: error }, 'the launcher did not shut down cleanly');
      })
      .finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
};

await main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ level: 50, msg: 'launcher failed to start', error: String(error) })}\n`,
  );
  process.exit(1);
});

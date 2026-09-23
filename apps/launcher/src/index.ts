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
 * It has no credential source, and says so rather than inventing one: minting a run-scoped git token
 * is `GitProviderPort.mintCredential`, which the **server** composes through
 * `IntegrationActionExecutor` (shadow mode, idempotency, audit), and this process holds no
 * integration binding, no secret key and no database connection to read one with. So a launcher
 * started on its own refuses to mint rather than pretending a run is credentialled, and a run that
 * needs a git write credential fails at `startRun` with that refusal by name.
 *
 * **That is a real gap and WP-53 states it rather than closing it** (TD-028 answered the transport,
 * not the credential): a read-only stage runs end to end here, and a writing stage cannot push. The
 * shapes available are a `RunCredentialSource` that calls **back** to the platform over the control
 * plane, or a credential minted by the platform and carried on the create request; both put a git
 * token somewhere it is not today, which is a decision above this file. It is reported as discovered
 * work rather than chosen here.
 */
import process from 'node:process';
import { WorkspaceError } from '@platform/application';
import type { workspace } from '@platform/infrastructure';
import { startLauncher } from './runtime.js';

/**
 * The credential source of a launcher with no git provider wired to it.
 *
 * It refuses; it does not return an empty credential. Standing rule 18 — an empty credential is not
 * a credential, and a `''` here would produce a workspace whose pushes fail with an authentication
 * error nobody can trace back to configuration.
 */
const unwiredCredentials: workspace.RunCredentialSource = {
  async mint() {
    throw new WorkspaceError(
      'invalid_spec',
      'this launcher has no git provider wired to it, so it cannot mint a run credential (Q52)',
    );
  },
  async revoke() {
    // Nothing was minted, so nothing is revoked. Not an error: `endRun` revokes unconditionally.
  },
};

const main = async (): Promise<void> => {
  const runtime = await startLauncher({
    env: process.env,
    credentials: unwiredCredentials,
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

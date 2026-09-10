#!/usr/bin/env node
/**
 * `platform-launcher` — the process entrypoint (TD-021, `ROLE=launcher`).
 *
 * A composition root and nothing else: environment in, signals mapped, `process.exit` out. Every
 * decision it could get wrong is in `runtime.ts`, where the unit tier can reach it — which is why
 * this file is excluded from coverage the way `apps/runlet/src/index.ts` and
 * `apps/server/src/migrate.ts` are.
 *
 * It has no credential source yet, and says so rather than inventing one: minting a run-scoped git
 * token is `GitProviderPort.mintCredential`, which the server composes through
 * `IntegrationActionExecutor` (shadow mode, idempotency, audit). Wiring the two processes together
 * is the transport question filed as **Q52**; until it is answered, a launcher started on its own
 * refuses to mint rather than pretending a run is credentialled.
 */
import process from 'node:process';
import { WorkspaceError } from '@platform/application';
import type { workspace } from '@platform/infrastructure';
import { buildLauncher } from './runtime.js';

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
  const runtime = buildLauncher({
    env: process.env,
    credentials: unwiredCredentials,
    uid: process.getuid?.() ?? -1,
  });
  runtime.logger.info(
    { control_root: runtime.config.controlRoot, runtime_image: runtime.config.images.runtime },
    'launcher started',
  );
  const stop = (signal: string): void => {
    runtime.logger.info({ signal }, 'launcher stopping');
    runtime.stop();
    process.exit(0);
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

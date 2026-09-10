#!/usr/bin/env node
/**
 * `agentic-runlet` — the entrypoint of the run container (TD-025 §1).
 *
 * A composition root and nothing else: it reads the environment, builds the shim from
 * `@platform/infrastructure`'s `runlet` module and maps the process' own signals onto it. Every
 * decision it could get wrong lives in that module, where the unit tier can reach it; what is left
 * here is `process.exit` and argv, which is why this file is excluded from coverage the way
 * `apps/server/src/migrate.ts` is — and why the contract tier runs *this file* as a real process
 * (`packages/infrastructure/src/runlet/conformance.contract.test.ts`), so the wiring below is
 * exercised end to end even though no coverage is collected from a subprocess.
 *
 * Two modes:
 *
 *   `agentic-runlet` (or `serve`)  listen on the control and credential sockets, own one child.
 *   `agentic-runlet credential get`  the workspace's git credential helper (technical/05).
 *
 * WP-22 packages this: TD-025 wants a single file with no runtime dependencies in the
 * `platform-runtime` image, so the entry is bundled (zod and the frame codec travel with it) rather
 * than shipped beside a `node_modules`. Nothing in this file assumes either arrangement.
 */
import process from 'node:process';
import { runlet, runner } from '@platform/infrastructure';

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
};

const credentialMode = async (argv: readonly string[]): Promise<void> => {
  const socketPath = process.env['RUNLET_CREDENTIAL_SOCKET'];
  if (socketPath === undefined || socketPath.length === 0) {
    // No socket, no credential. Silence is what git reads as "this helper has nothing".
    return;
  }
  const output = await runlet.runCredentialHelper({
    argv,
    stdin: argv[0] === 'get' ? await readStdin() : '',
    socketPath,
  });
  if (output.length > 0) {
    process.stdout.write(output);
  }
};

/** How long a shut-down shim may take to drain before it is exited anyway. */
const FORCE_EXIT_MS = 10_000;

const serveMode = async (): Promise<void> => {
  let forceExit: NodeJS.Timeout | null = null;
  const config = runlet.readRunletConfig(process.env);
  const logger = runlet.createRunletLogger({ level: config.logLevel });
  const shim = runlet.createRunletShim({
    controlSocketPath: config.controlSocketPath,
    credentialSocketPath: config.credentialSocketPath,
    token: config.token,
    clock: runner.systemClock,
    logger,
    childUid: config.childUid,
    childGid: config.childGid,
    ...(config.killGraceMs === undefined ? {} : { killGraceMs: config.killGraceMs }),
    ...(config.handshakeTimeoutMs === undefined
      ? {}
      : { handshakeTimeoutMs: config.handshakeTimeoutMs }),
    ...(config.credentialTimeoutMs === undefined
      ? {}
      : { credentialTimeoutMs: config.credentialTimeoutMs }),
    ...(config.maxCredentialRequests === undefined
      ? {}
      : { maxCredentialRequests: config.maxCredentialRequests }),
    onShutdown: (reason) => {
      logger.info({ reason }, 'agentic-runlet exiting');
      // The container is done when the shim is: TD-025 §1 — "an orphaned agent never keeps
      // running". Exit code 0 for every reason, because the *run's* outcome travelled to the
      // runner as an `exit` frame; this code is only the container's.
      //
      // **Not** `process.exit(0)` here, and the difference is the end of the run.
      // `process.exit` discards whatever Node still holds in a socket's **userland** write queue,
      // and `control.close()` above has only just called `end()`/`destroySoon()` on a socket that
      // may still owe the runner bytes.
      //
      // The condition that makes the queue non-empty is narrower than it first looks, and is worth
      // stating because it is what a reproduction needs. Backpressure normally keeps the queue
      // empty at shutdown: when the socket fills, the shim pauses the child's stdout, so the child
      // cannot finish, so the run cannot end while the queue is full — which is why a merely *slow*
      // runner loses nothing however slowly it reads. The queue is non-empty at shutdown only when
      // the **child ends while the socket is backed up**, which `exit` permits because it does not
      // wait for a pipe: a runner-sent `signal`, a crash, or a child exiting while another stdio
      // stream is still backed up. Then the `exit` frame — the run's outcome, and the tail carrying
      // the `result` line the budget watchdog reads — is written into a socket nobody is draining,
      // and `process.exit(0)` throws it away: measured against this entrypoint, the runner receives
      // **0 of 64** tail bytes and **no `exit` frame at all**, three runs out of three, where the
      // code below delivers 64 of 64 and the frame. That measurement is
      // `conformance.contract.test.ts`'s "delivers the tail and the exit frame to a runner that
      // stopped reading before the run ended", which fails on exactly this line being restored.
      //
      // So: let the loop drain. Every handle the shim owns has been closed by this point, so an
      // empty loop exits by itself with code 0. The timer is the backstop for a handle that never
      // closes, and it is `unref`ed so it cannot be the reason the process stays alive.
      forceExit = setTimeout(() => process.exit(0), FORCE_EXIT_MS);
      forceExit.unref?.();
    },
  });
  await shim.start();

  // `tini` is PID 1 in the image (technical/05 `init: true`); these are the signals it forwards
  // when the launcher stops the container. Closing the shim kills the child on the way out.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      logger.info({ signal }, 'agentic-runlet received a signal');
      // A stop is not a drain: the launcher is taking the container away, so this one does exit.
      if (forceExit !== null) {
        clearTimeout(forceExit);
      }
      void shim.close().then(() => process.exit(0));
    });
  }
};

const main = async (): Promise<void> => {
  const [mode = 'serve', ...rest] = process.argv.slice(2);
  if (mode === 'credential') {
    await credentialMode(rest);
    return;
  }
  if (mode !== 'serve') {
    process.stderr.write(`agentic-runlet: unknown mode "${mode}"\n`);
    process.exit(2);
  }
  await serveMode();
};

await main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ level: 50, name: 'agentic-runlet', msg: (error as Error).message })}\n`,
  );
  process.exit(1);
});

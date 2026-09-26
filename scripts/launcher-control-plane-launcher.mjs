#!/usr/bin/env node
/**
 * The **launcher half** of `launcher-control-plane-check.mjs`, inside its own container.
 *
 * It is `apps/launcher`'s own composition root — `startLauncher`, which is what `apps/launcher/src/
 * index.ts` calls — so this process holds the Docker client TD-021 allows exactly one component to
 * hold, exposes TD-028's control plane, and nothing else. The *runner* is a second container that
 * talks to it over HTTP and reads the run's Unix socket off the shared `ctl` volume, which is the
 * shipped topology rather than a convenience: `runlet-launcher-inner.mjs` composes both halves in
 * one process (Q52's in-process mode, still valid), and that arrangement cannot show that the two
 * planes are actually separate.
 *
 * It prints one line — the port it is listening on — and then stays up until it is killed.
 */
import process from 'node:process';
import './ts-source-resolver.mjs';

const required = (name) => {
  const value = process.env[name];
  if (!value) {
    process.stderr.write(`${name} is required\n`);
    process.exit(2);
  }
  return value;
};

const { startLauncher } = await import(
  new URL('../apps/launcher/src/runtime.ts', import.meta.url).href
);

const logger = {
  debug: () => undefined,
  info: (fields, message) => process.stderr.write(`launcher info: ${message}\n`),
  warn: (fields, message) =>
    process.stderr.write(`launcher warn: ${message} ${JSON.stringify(fields)}\n`),
  error: (fields, message) =>
    process.stderr.write(`launcher error: ${message} ${JSON.stringify(fields)}\n`),
};

const runtime = await startLauncher({
  env: {
    DOCKER_HOST: required('DOCKER_HOST'),
    APP_WORKSPACE_CONTROL_VOLUME: required('CHECK_CONTROL_VOLUME'),
    APP_WORKSPACE_CONTROL_ROOT: '/run/agentic/ctl',
    APP_WORKSPACE_CACHE_VOLUME: required('CHECK_CACHE_VOLUME'),
    APP_WORKSPACE_RUNTIME_IMAGE: required('CHECK_RUNTIME_IMAGE'),
    APP_WORKSPACE_EGRESS_IMAGE: required('CHECK_EGRESS_IMAGE'),
    APP_WORKSPACE_GIT_IMAGE: required('CHECK_GIT_IMAGE'),
    // The stand-in for a production run image: the fake CLI lives in the checkout, and this is what
    // mounts the checkout read-only into every run container. The image is still the **real**
    // `platform-runtime`; what this adds is a path the fake CLI can be executed from.
    APP_WORKSPACE_RUNTIME_SOURCE_DIR: required('CHECK_REPO_ROOT'),
    APP_WORKSPACE_HELPER_NETWORK: required('CHECK_NETWORK'),
    APP_WORKSPACE_EGRESS_NETWORK: required('CHECK_NETWORK'),
    APP_WORKSPACE_EXPORT_DIR: '/tmp/exports',
    APP_WORKSPACE_RETENTION_SWEEP_MS: '3600000',
    // TD-028's control plane, on every interface of this container's own network.
    APP_LAUNCHER_TOKEN: required('CHECK_LAUNCHER_TOKEN'),
    APP_LAUNCHER_HOST: '0.0.0.0',
    APP_LAUNCHER_PORT: required('CHECK_LAUNCHER_PORT'),
    // The path the run image really carries; the runner asserts it came from here.
    APP_WORKSPACE_RUNTIME_CLI_PATH: process.env['CHECK_CLI_PATH'] ?? '/usr/local/bin/claude',
  },
  /** Q51: the uid the *run container* runs as. This container runs as root so it can reach `0600`. */
  uid: 1000,
  logger,
});

process.stdout.write(`${JSON.stringify({ listening: runtime.controlPlane?.port ?? null })}\n`);

const stop = () => {
  void runtime.close().finally(() => process.exit(0));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

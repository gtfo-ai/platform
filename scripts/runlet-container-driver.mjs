#!/usr/bin/env node
/**
 * The platform half of the containerised run-shim check — see `runlet-container-check.mjs`.
 *
 * It runs inside a second container that mounts the whole `ctl` volume, exactly as TD-025 §2
 * describes the runner ("the **runner** process has the whole `ctl` volume mounted at
 * `/run/agentic/ctl` from its start … and connects to `/run/agentic/ctl/<run-id>/ctl.sock`"), and
 * drives a real SDK `query()` through the shim in the other container.
 *
 * It prints one JSON line so the parent script can assert on it, and exits non-zero on failure.
 * This is a verification tool, not part of `verify`: it needs a Docker daemon and two images.
 */
import './ts-source-resolver.mjs';

// A bare specifier resolves from the *importing file's* directory, and the SDK is a dependency of
// `packages/infrastructure`, not of the repository root — so it is imported by the path pnpm laid
// down for that package rather than by name. The same reason `pnpm dev` exists: nothing here is
// built, so the resolver has to be told where the tree is.
const sdk = new URL(
  '../packages/infrastructure/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs',
  import.meta.url,
);
const { query } = await import(sdk.href);
const { createRunletSpawn } = await import(
  new URL('../packages/infrastructure/src/runlet/index.ts', import.meta.url).href
);
const { systemClock } = await import(
  new URL('../packages/infrastructure/src/runner/clock.ts', import.meta.url).href
);

const socketPath = process.env['RUNLET_SOCKET'];
const token = process.env['RUNLET_TOKEN'];
const cli = process.env['RUNLET_FAKE_CLI'];
if (!socketPath || !token || !cli) {
  process.stderr.write('RUNLET_SOCKET, RUNLET_TOKEN and RUNLET_FAKE_CLI are required\n');
  process.exit(2);
}

// `RUNLET_SCENARIO` drives the CLI directly instead of through `query()`: the kill-on-disconnect
// check needs a child that ignores SIGTERM and a runner that is still holding the socket when it is
// killed, which is not a shape a completed `query()` can produce.
const scenario = process.env['RUNLET_SCENARIO'];
if (scenario) {
  const spawn = createRunletSpawn({ socketPath, token, clock: systemClock });
  const child = spawn({
    command: cli,
    args: ['--scenario', scenario, '--pid-file', '/tmp/child.pid'],
    cwd: '/repo',
    env: { PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin' },
    signal: new AbortController().signal,
  });
  child.on('error', () => {});
  child.stdout.on('data', () => {});
  child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user' } })}\n`);
  process.stdout.write(`${JSON.stringify({ ok: true, scenario })}\n`);
  // Hold the control connection open until this container is killed from outside.
  setInterval(() => {}, 1_000);
} else {
  await drive();
}

async function drive() {
  const stderrLines = [];
  const messages = [];
  try {
    for await (const message of query({
      prompt: 'summarise the bug',
      options: {
        spawnClaudeCodeProcess: createRunletSpawn({
          socketPath,
          token,
          clock: systemClock,
          onStderr: (chunk) => stderrLines.push(chunk),
        }),
        pathToClaudeCodeExecutable: cli,
        cwd: '/repo',
        env: { PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin' },
      },
    })) {
      messages.push(message);
    }
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: String(error) })}\n`);
    process.exit(1);
  }

  const result = messages.find((message) => message.type === 'result');
  process.stdout.write(
    `${JSON.stringify({
      ok: result?.subtype === 'success',
      types: messages.map((message) => message.type),
      result: result?.result ?? null,
      total_cost_usd: result?.total_cost_usd ?? null,
      stderr: stderrLines.join(''),
    })}\n`,
  );
  process.exit(result?.subtype === 'success' ? 0 : 1);
}

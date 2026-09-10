/**
 * Conformance for `agentic-runlet`: the **real shim, as a separate process**.
 *
 * WP-13's acceptance criterion is "SDK `query()` completes end-to-end through the shim … disconnect
 * kills the child within the grace period", and the four named conformance cases are *fake CLI,
 * disconnect, signals, large stdout*. Every one of them runs here against
 * `apps/runlet/src/index.ts` started with `node`, talking over a real Unix socket to a real child —
 * because the alternative fake is `packages/infrastructure/src/runner/fake-spawn.ts`, whose own
 * divergence register lists "no backpressure" as a **kinder** divergence and whose review closed
 * with *"WP-13 must not run its large stdout conformance test against this fake"*. A fake with no
 * backpressure cannot exhibit the behaviour a large-stdout test is about; asserting it there would
 * be asserting nothing (standing rule 4).
 *
 * What is *not* here, and why: the same run inside a **hardened container**. That needs the
 * `platform-runtime` image (WP-22) and the launcher that creates the control volume and the
 * network (WP-14). What could be measured without them was measured and is written up in
 * `docs/research/12-run-shim-verification.md`, including the `volume-subpath` and embedded-DNS
 * checks this work package owes, with the Docker version they were run on.
 *
 * Timing discipline: no assertion in this file bounds a duration from above. `waitForFile` and
 * `waitForProcessGone` are lower bounds on something structural — a file appears, a pid stops
 * existing — and the grace period *itself* is proved on an injected clock in
 * `packages/infrastructure/src/runlet/shim.test.ts`, where the clock can be moved by hand.
 */
import { type ChildProcess, spawn as spawnProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { systemClock } from '../runner/clock.js';
import { createAllowListCredentialResponder, createRunletSpawn } from './spawn-adapter.js';
import {
  connectProbe,
  createControlVolume,
  nodeScript,
  processIsAlive,
  type RunletProbe,
  waitForProcessGone,
} from './testing.js';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const SHIM_ENTRY = `${REPO}apps/runlet/src/index.ts`;
const RESOLVER = `${REPO}scripts/ts-source-resolver.mjs`;
/**
 * No file extension, on purpose. The SDK decides how to launch what
 * `pathToClaudeCodeExecutable` names by looking at its suffix — `sdk.mjs`'s own predicate is
 * `![".js",".mjs",".tsx",".ts",".jsx"].some((n) => e.endsWith(n))` — and for a script it spawns
 * *node* with the script as an argument, which arrives at the shim as a **relative** `command` and
 * is refused. A real `claude` in the runtime image is an extension-less native binary, so this
 * fixture is the faithful shape as well as the one that works.
 */
const FAKE_CLI = `${REPO}test/fixtures/runlet/fake-claude-cli`;
const TOKEN = 'run-token-conformance-000000000000';

const started: ChildProcess[] = [];
const volumes: { cleanup(): Promise<void> }[] = [];

afterEach(async () => {
  for (const child of started.splice(0)) {
    child.kill('SIGKILL');
  }
  for (const volume of volumes.splice(0)) {
    await volume.cleanup();
  }
});

const waitForFile = async (file: string, timeoutMs = 30_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await stat(file).catch(() => null)) !== null) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`${file} never appeared`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/** The same shape as {@link waitForFile}: a lower bound on something structural, never an upper one. */
const waitFor = async (what: string, ready: () => boolean, timeoutMs = 30_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (ready()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`${what} never happened`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/** Bytes carried by the `stdout`/`stderr` frames a probe has received so far. */
const payloadOf = (probe: RunletProbe, type: 'stdout' | 'stderr'): Buffer =>
  Buffer.concat(
    probe.received
      .filter((decoded) => decoded.frame.type === type)
      .map((decoded) => decoded.payload ?? Buffer.alloc(0)),
  );

interface ShimProcess {
  readonly controlSocketPath: string;
  readonly credentialSocketPath: string;
  readonly dir: string;
  readonly stderr: () => string;
  readonly exited: Promise<number | null>;
}

/** Starts `apps/runlet/src/index.ts` the way the image's entrypoint will. */
const startShimProcess = async (env: Record<string, string> = {}): Promise<ShimProcess> => {
  const volume = await createControlVolume();
  volumes.push(volume);
  const tokenFile = `${volume.dir}/token`;
  await writeFile(tokenFile, `${TOKEN}\n`, 'utf8');

  const child = spawnProcess(process.execPath, ['--import', RESOLVER, SHIM_ENTRY], {
    env: {
      PATH: process.env['PATH'] ?? '/usr/bin',
      RUNLET_CONTROL_SOCKET: volume.controlSocketPath,
      RUNLET_CREDENTIAL_SOCKET: volume.credentialSocketPath,
      RUNLET_TOKEN_FILE: tokenFile,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  started.push(child);
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
  });
  await waitForFile(volume.controlSocketPath);
  return {
    controlSocketPath: volume.controlSocketPath,
    credentialSocketPath: volume.credentialSocketPath,
    dir: volume.dir,
    stderr: () => stderr,
    exited,
  };
};

const spawnOptions = (args: readonly string[]): SpawnOptions => ({
  command: FAKE_CLI,
  args: [...args],
  cwd: REPO,
  env: { PATH: process.env['PATH'] ?? '/usr/bin' },
  signal: new AbortController().signal,
});

describe('agentic-runlet conformance, against the real shim process', () => {
  it('an SDK query() completes end to end through the shim', async () => {
    const shim = await startShimProcess();
    const messages: { type: string }[] = [];
    const stderrLines: string[] = [];

    for await (const message of query({
      prompt: 'summarise the bug',
      options: {
        // The seam TD-025 §2 is about, wired to the production transport rather than to
        // WP-12's in-process fake.
        spawnClaudeCodeProcess: createRunletSpawn({
          socketPath: shim.controlSocketPath,
          token: TOKEN,
          clock: systemClock,
          onStderr: (chunk) => stderrLines.push(chunk),
        }),
        pathToClaudeCodeExecutable: FAKE_CLI,
        cwd: REPO,
        env: { PATH: process.env['PATH'] ?? '/usr/bin' },
      },
    })) {
      messages.push(message as { type: string });
    }

    expect(messages.map((message) => message.type)).toContain('result');
    const result = messages.find((message) => message.type === 'result') as unknown as {
      subtype: string;
      result: string;
      total_cost_usd: number;
    };
    expect(result.subtype).toBe('success');
    expect(result.result).toBe('the shim carried this');
    // The SDK parsed it, which means the NDJSON crossed the frame protocol byte for byte.
    expect(result.total_cost_usd).toBe(0.01);
    expect(await shim.exited).toBe(0);
  }, 60_000);

  it('carries 16 MiB of CLI stdout without loss (the case the fake cannot exercise)', async () => {
    const shim = await startShimProcess();
    const spawn = createRunletSpawn({
      socketPath: shim.controlSocketPath,
      token: TOKEN,
      clock: systemClock,
    });
    const child = spawn(spawnOptions(['--scenario', 'big-stdout', '--megabytes', '16']));
    // The SDK's own reader is a line reader; here the bytes are counted instead, because the
    // subject is the transport rather than the protocol on top of it.
    //
    // Read to the stream's **`end`**, not to the process' `exit`. The adapter pushes EOF and emits
    // `exit` in the same breath — which is Node's own `ChildProcess` contract, where `exit` fires
    // before the stdio pipes have drained and `close` is the one that waits — so whatever is still
    // in the `Readable`'s buffer at that instant has not reached this listener yet. Collecting up
    // to `exit` lost the last 64 KiB block (16,711,680 of 16,777,216 bytes) in two of ten
    // full-suite runs: a flaky test, and a flaky test that would have read as a transport dropping
    // bytes.
    const collected = new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      child.stdout.on('end', () => resolve(Buffer.concat(chunks)));
    });
    child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user' } })}\n`);
    // Closing stdin is what ends the CLI, exactly as the SDK's graceful path does; without it
    // the fake would sit on its stdin listener for ever and the test would time out rather than
    // fail.
    child.stdin.end();
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));

    const received = await collected;
    const fillerStart = received.indexOf('\n') + 1;
    const filler = received.subarray(fillerStart, fillerStart + 16 * 1024 * 1024);
    expect(filler).toHaveLength(16 * 1024 * 1024);
    expect(createHash('sha256').update(filler).digest('hex')).toBe(
      createHash('sha256')
        .update(Buffer.alloc(16 * 1024 * 1024, 97))
        .digest('hex'),
    );
    // …and the `result` line that follows the filler still arrives, so nothing was dropped in
    // the middle either.
    expect(received.subarray(fillerStart + filler.length).toString('utf8')).toContain(
      '"type":"result"',
    );
  }, 60_000);

  /**
   * The entrypoint's `onShutdown` must not `process.exit(0)` — and this is the condition under
   * which that matters, stated because a review could not reproduce the defect without it.
   *
   * `process.exit` discards whatever Node still holds in a socket's **userland** write queue.
   * Backpressure normally keeps that queue empty at shutdown, which is why a merely *slow* runner
   * loses nothing however slowly it reads: when the socket fills, the shim pauses the child's
   * stdout, so the child cannot finish, so the run cannot end while the queue is full. The queue is
   * only non-empty at shutdown when **the child ends while the socket is backed up** — and it can,
   * because `exit` does not wait for a pipe: a runner-sent `signal`, a crash, or (as here) a child
   * that exits while a *different* stdio stream is still backed up. `reportExit` then writes the
   * `exit` frame into a socket nobody is draining and the shim shuts down behind it.
   *
   * The construction: the bulk goes to **stderr** (which saturates the control socket), the 64-byte
   * tail to **stdout** — a different pipe, so the tail is not queued behind the bulk inside the
   * child — and the tail is written only after a `stdin` round trip that happens once the runner has
   * already stopped reading. Measured against this file on macOS 26.6.2 / Node 25.1.0, three runs each:
   * shipped delivers **64 of 64** tail bytes and one `exit` frame, `process.exit(0)` delivers
   * **0 of 64** and **no `exit` frame at all** — a runner that is never told the run ended.
   */
  it('delivers the tail and the exit frame to a runner that stopped reading before the run ended', async () => {
    const TAIL = `TAIL${'-'.repeat(59)}\n`;
    expect(TAIL).toHaveLength(64);
    const BULK_BYTES = 16 * 1024 * 1024;
    const shim = await startShimProcess();
    const runner = await connectProbe(shim.controlSocketPath);
    runner.send({ type: 'hello', protocol: 1, token: TOKEN });
    await runner.next('hello.ok');
    runner.send({
      type: 'spawn',
      ...nodeScript(
        `process.stderr.write(Buffer.alloc(${BULK_BYTES}, 98));` +
          `process.stdin.once('data', () => {` +
          `process.stdout.write(${JSON.stringify(TAIL)});` +
          `setTimeout(() => process.exit(7), 100); });`,
      ),
      cwd: REPO,
      env: { PATH: process.env['PATH'] ?? '/usr/bin' },
    });
    await runner.next('spawn.ok');

    // Stop reading once the bulk is unmistakably flowing. From here the shim writes until the
    // socket refuses, pauses the child's stderr, and the queue it is holding is what
    // `process.exit(0)` would throw away.
    await waitFor('the bulk started arriving', () => payloadOf(runner, 'stderr').length >= 1 << 20);
    runner.pause();
    await new Promise((resolve) => setTimeout(resolve, 500));
    runner.send({ type: 'stdin' }, Buffer.from('go\n', 'utf8'));
    // Waiting for the line the shim logs on its way out — rather than for a duration — keeps both
    // of its timers out of this test: neither the 2 s stdio flush window nor the entrypoint's 10 s
    // backstop decides anything here. (The child's `exit` is what ends the run: Node flushes a
    // child's stdio when it exits, resuming the stream the shim had paused, so `close` arrives
    // long before the flush window. Measured: `readableFlowing === false` at `exit`, and `close`
    // 128 KiB of further reads later.)
    await waitFor('the shim shut down', () => shim.stderr().includes('agentic-runlet exiting'));

    const beforeReading = payloadOf(runner, 'stdout').length;
    runner.resume();
    const exit = await runner.next('exit');

    // Nothing arrived while the runner was away, so the tail counted below is the queue draining
    // and not a frame that beat the pause (standing rule 10: assert which branch ran).
    expect(beforeReading).toBe(0);
    expect(payloadOf(runner, 'stdout').toString('utf8')).toBe(TAIL);
    // The run's outcome, which is the whole reason the tail matters: the runner learns the child
    // exited 7 rather than watching a socket go quiet.
    expect(exit).toEqual({ type: 'exit', code: 7, signal: null });
    // …and the socket really was saturated when the run ended, rather than the whole conversation
    // having fitted in the kernel's buffer — in which case `process.exit(0)` would lose nothing and
    // this test would prove nothing (standing rule 4). `exit` is the last frame the shim writes, so
    // by now the count is final: **at least half of the bulk never crossed the socket**, which is
    // two orders of magnitude more than any kernel socket buffer holds. The runner's stall is the
    // only thing that explains it.
    expect(payloadOf(runner, 'stderr').length).toBeLessThan(BULK_BYTES / 2);
    expect(await shim.exited).toBe(0);
  }, 60_000);

  it('relays a signal to the CLI and forwards its stderr', async () => {
    const shim = await startShimProcess();
    const stderrChunks: string[] = [];
    const spawn = createRunletSpawn({
      socketPath: shim.controlSocketPath,
      token: TOKEN,
      clock: systemClock,
      onStderr: (chunk) => stderrChunks.push(chunk),
    });
    const child = spawn(spawnOptions(['--scenario', 'signal-report']));
    const lines: string[] = [];
    child.stdout.on('data', (chunk: Buffer) => lines.push(chunk.toString('utf8')));
    child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user' } })}\n`);

    const sawSignal = new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (lines.join('').includes('"signal":"SIGUSR1"')) {
          clearInterval(check);
          resolve();
        }
      }, 20);
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(child.kill('SIGUSR1')).toBe(true);
    await sawSignal;

    child.kill('SIGKILL');
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
      child.once('exit', (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
    });
    expect(code).toBeNull();
    expect(signal).toBe('SIGKILL');
    expect(await shim.exited).toBe(0);
  }, 60_000);

  it('kills a child that ignores SIGTERM when the control connection drops', async () => {
    const shim = await startShimProcess({ RUNLET_KILL_GRACE_MS: '250' });
    const pidFile = `${shim.dir}/child.pid`;
    // A raw connection rather than the adapter, because the event under test is the socket
    // *disappearing* — a runner that crashed, a platform that was restarted. Going through
    // `SpawnedProcess.kill()` would send a `signal` frame instead, which is the polite path and
    // proves nothing about the impolite one.
    const runner = await connectProbe(shim.controlSocketPath);
    runner.send({ type: 'hello', protocol: 1, token: TOKEN });
    await runner.next('hello.ok');
    runner.send({
      type: 'spawn',
      command: FAKE_CLI,
      args: ['--scenario', 'ignore-term', '--pid-file', pidFile],
      cwd: REPO,
      env: { PATH: process.env['PATH'] ?? '/usr/bin' },
    });
    await runner.next('spawn.ok');
    await waitForFile(pidFile);
    const pid = Number(await readFile(pidFile, 'utf8'));
    expect(processIsAlive(pid)).toBe(true);

    runner.close();

    // The graceful half ran…
    await waitForFile(`${pidFile}.term`);
    // …and then the child is gone. A process that ignores SIGTERM can only be ended by SIGKILL,
    // and the only thing that sent one is the shim's grace timer. Asserted by asking the
    // operating system, not by watching a call.
    await waitForProcessGone(pid);
    expect(processIsAlive(pid)).toBe(false);
    // And the shim itself is gone, so the container can exit: TD-025 §1's "an orphaned agent
    // never keeps running" covers the shim too.
    expect(await shim.exited).toBe(0);
  }, 60_000);

  it('answers the credential helper mode of the same binary, and refuses what the runner refuses', async () => {
    const shim = await startShimProcess();
    const spawn = createRunletSpawn({
      socketPath: shim.controlSocketPath,
      token: TOKEN,
      clock: systemClock,
      credentials: createAllowListCredentialResponder({
        allowedHosts: ['gitlab.example.com'],
        credential: async () => ({ username: 'agentic', password: 'glpat-FAKE-0000000000000000' }),
      }),
    });
    const child = spawn(spawnOptions(['--scenario', 'signal-report']));
    child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user' } })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const ask = async (input: string): Promise<string> => {
      const helper = spawnProcess(
        process.execPath,
        ['--import', RESOLVER, SHIM_ENTRY, 'credential', 'get'],
        {
          env: {
            PATH: process.env['PATH'] ?? '/usr/bin',
            RUNLET_CREDENTIAL_SOCKET: shim.credentialSocketPath,
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      started.push(helper);
      helper.stdin?.write(input);
      helper.stdin?.end();
      let out = '';
      helper.stdout?.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8');
      });
      await new Promise<void>((resolve) => helper.once('exit', () => resolve()));
      return out;
    };

    expect(await ask('protocol=https\nhost=gitlab.example.com\n\n')).toBe(
      'username=agentic\npassword=glpat-FAKE-0000000000000000\n',
    );
    // A host the run was never given: the helper gets silence, and git therefore fails the fetch
    // rather than receiving somebody else's token.
    expect(await ask('protocol=https\nhost=evil.example.com\n\n')).toBe('');
    // Cleartext has no representation on the wire at all.
    expect(await ask('protocol=http\nhost=gitlab.example.com\n\n')).toBe('');

    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  }, 60_000);
});

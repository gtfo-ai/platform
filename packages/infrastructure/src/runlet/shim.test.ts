/**
 * The shim, against **real** Unix sockets and **real** child processes, on an injected clock.
 *
 * Two deliberate choices, both from the ledger:
 *
 *  - the children are real (`node -e …`), because the acceptance criterion is about process state:
 *    "disconnect kills the child" is proved by asking the operating system whether the pid is gone,
 *    not by asserting that `kill()` was called on a double (standing rule 3);
 *  - the clock is injected, so "within the grace period" is proved by *advancing* it rather than by
 *    waiting. There is no upper bound on a duration anywhere in this file (standing rule 2). The
 *    two places that do wait — `waitForProcessGone`, `waitForFile` — are **lower** bounds on
 *    something structural ("the pid disappears", "the marker exists"), which is the shape the
 *    ci-fix entry argues for.
 */
import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type LogFields, silentLogger } from '@platform/application';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { manualClock } from '../runner/clock.js';
import {
  assertControlDirectoryProtects,
  createRunletShim,
  type RunletShim,
  type RunletShimOptions,
  type RunletShutdownReason,
} from './shim.js';
import {
  type ControlVolume,
  connectProbe,
  createControlVolume,
  nodeScript,
  processIsAlive,
  type RunletProbe,
  waitForProcessGone,
} from './testing.js';

const TOKEN = 'run-token-aaaaaaaaaaaaaaaaaaaaaa';

interface Harness {
  readonly shim: RunletShim;
  readonly clock: ReturnType<typeof manualClock>;
  readonly volume: ControlVolume;
  readonly shutdowns: RunletShutdownReason[];
}

const open: { shim: RunletShim; volume: ControlVolume }[] = [];

const startShim = async (over: Partial<RunletShimOptions> = {}): Promise<Harness> => {
  const volume = await createControlVolume();
  const clock = manualClock(1_000);
  const shutdowns: RunletShutdownReason[] = [];
  const shim = createRunletShim({
    controlSocketPath: volume.controlSocketPath,
    credentialSocketPath: volume.credentialSocketPath,
    token: TOKEN,
    clock,
    onShutdown: (reason) => shutdowns.push(reason),
    ...over,
  });
  await shim.start();
  open.push({ shim, volume });
  return { shim, clock, volume, shutdowns };
};

/**
 * Processes a test deliberately put *outside* the shim's reach (a detached grandchild). Killed
 * here rather than at the end of the test that made one, so an assertion that throws first still
 * cleans up — and `ESRCH` is the only failure swallowed, because a cleanup you cannot see fail is
 * how this session once leaked 48 processes (standing rule 25).
 */
const strays: number[] = [];

afterEach(async () => {
  for (const entry of open.splice(0)) {
    await entry.shim.close();
    await entry.volume.cleanup();
  }
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        throw error;
      }
    }
  }
});

/** Connects and authenticates, the way the runner does. */
const authenticate = async (harness: Harness): Promise<RunletProbe> => {
  const probe = await connectProbe(harness.volume.controlSocketPath);
  probe.send({ type: 'hello', protocol: 1, token: TOKEN });
  await probe.next('hello.ok');
  return probe;
};

const spawnFrame = (script: string, env: Record<string, string> = {}): Record<string, unknown> => ({
  type: 'spawn',
  ...nodeScript(script),
  cwd: process.cwd(),
  env,
});

const waitForFile = async (file: string, timeoutMs = 15_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await stat(file).catch(() => null);
    if (found !== null) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`${file} never appeared`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** Polls until something structural becomes true. A lower bound, never an upper one (rule 2). */
const waitFor = async (
  what: string,
  predicate: () => boolean,
  timeoutMs = 15_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`${what} never became true`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const collect = (probe: RunletProbe, type: 'stdout' | 'stderr'): Buffer =>
  Buffer.concat(
    probe.received
      .filter((decoded) => decoded.frame.type === type)
      .map((decoded) => decoded.payload as Buffer),
  );

const credentialFrames = (probe: RunletProbe) =>
  probe.received.filter((decoded) => decoded.frame.type === 'cred.get');

describe('the run shim: one authenticated connection', () => {
  it('refuses a hello whose token is empty, and still accepts the real one afterwards', async () => {
    const harness = await startShim();
    const attacker = await connectProbe(harness.volume.controlSocketPath);
    // The attempt is made *with* the empty token, not merely asserted about (standing rule 18).
    attacker.send({ type: 'hello', protocol: 1, token: '' });
    const refusal = await attacker.next('fatal');
    expect(refusal).toMatchObject({ type: 'fatal', reason: 'auth_failed' });
    await attacker.closed;

    const runner = await authenticate(harness);
    expect(runner.received.map((decoded) => decoded.frame.type)).toContain('hello.ok');
  });

  it.each([
    ['blank', '   '],
    ['the wrong token', 'run-token-bbbbbbbbbbbbbbbbbbbbbb'],
    ['a prefix of the token', TOKEN.slice(0, -1)],
  ])('refuses a hello carrying %s', async (_name, token) => {
    const harness = await startShim();
    const probe = await connectProbe(harness.volume.controlSocketPath);
    probe.send({ type: 'hello', protocol: 1, token });
    expect(await probe.next('fatal')).toMatchObject({ reason: 'auth_failed' });
  });

  it('refuses to exist at all with an empty token: the shim never listens', async () => {
    const volume = await createControlVolume();
    expect(() =>
      createRunletShim({
        controlSocketPath: volume.controlSocketPath,
        token: '   ',
        clock: manualClock(),
      }),
    ).toThrow(/empty or blank/);
    await volume.cleanup();
  });

  it('refuses a protocol version it does not speak', async () => {
    const harness = await startShim();
    const probe = await connectProbe(harness.volume.controlSocketPath);
    probe.send({ type: 'hello', protocol: 2, token: TOKEN });
    expect(await probe.next('fatal')).toMatchObject({ reason: 'auth_failed' });
  });

  it('refuses any frame that arrives before hello', async () => {
    const harness = await startShim();
    const probe = await connectProbe(harness.volume.controlSocketPath);
    probe.send(spawnFrame('process.exit(0)'));
    expect(await probe.next('fatal')).toMatchObject({ reason: 'auth_failed' });
    expect(harness.shim.childPid).toBeNull();
  });

  it('refuses a second connection unread while one is authenticated', async () => {
    const harness = await startShim();
    const runner = await authenticate(harness);
    const intruder = await connectProbe(harness.volume.controlSocketPath);
    expect(await intruder.next('fatal')).toMatchObject({ reason: 'connection_taken' });
    // The refusal happens before any decoder is attached, so this never even parses.
    intruder.send(spawnFrame('process.exit(0)'));
    await intruder.closed;
    expect(harness.shim.childPid).toBeNull();
    expect(harness.shim.metrics.rejectedConnections).toBe(1);
    expect(runner.received.map((d) => d.frame.type)).not.toContain('fatal');
  });

  it('drops a connection that never says hello, on the injected clock', async () => {
    const harness = await startShim({ handshakeTimeoutMs: 5_000 });
    const probe = await connectProbe(harness.volume.controlSocketPath);
    harness.clock.advance(4_999);
    expect(probe.received).toHaveLength(0);
    harness.clock.advance(2);
    expect(await probe.next('fatal')).toMatchObject({ reason: 'handshake_timeout' });
  });

  it('stops listening once the handshake attempts are exhausted', async () => {
    const harness = await startShim({ maxFailedHandshakes: 2 });
    for (const attempt of [1, 2]) {
      const probe = await connectProbe(harness.volume.controlSocketPath);
      probe.send({ type: 'hello', protocol: 1, token: `wrong-${attempt}-aaaaaaaaaaaaaaaaaaaa` });
      await probe.closed;
    }
    expect(harness.shutdowns).toEqual(['handshake_attempts_exhausted']);
  });
});

describe('the run shim: spawn', () => {
  it('starts the child with exactly the environment the frame carries', async () => {
    process.env['RUNLET_TEST_LEAK'] = 'the-shim-environment';
    const harness = await startShim();
    const probe = await authenticate(harness);
    probe.send(
      spawnFrame('process.stdout.write(JSON.stringify(process.env)); process.exit(0)', {
        ONLY_THIS: 'yes',
      }),
    );
    await probe.next('exit');
    const environment = JSON.parse(collect(probe, 'stdout').toString()) as Record<string, string>;
    expect(environment['ONLY_THIS']).toBe('yes');
    // technical/04: `env` replaces, it never merges. The run token lives in the shim's environment.
    expect(environment['RUNLET_TEST_LEAK']).toBeUndefined();
    delete process.env['RUNLET_TEST_LEAK'];
  });

  it('refuses a second spawn on the same connection', async () => {
    const harness = await startShim();
    const probe = await authenticate(harness);
    probe.send(spawnFrame('setInterval(() => {}, 1000)'));
    await probe.next('spawn.ok');
    const first = harness.shim.childPid;
    probe.send(spawnFrame('setInterval(() => {}, 1000)'));
    expect(await probe.next('fatal')).toMatchObject({ reason: 'unexpected_frame' });
    expect(harness.shim.childPid).toBe(first);
  });

  it('refuses to run the agent CLI as root when no child uid was configured', async () => {
    const harness = await startShim({ currentUid: () => 0 });
    const probe = await authenticate(harness);
    probe.send(spawnFrame('process.exit(0)'));
    expect(await probe.next('fatal')).toMatchObject({ reason: 'spawn_refused' });
    expect(harness.shim.childPid).toBeNull();
  });

  it('spawns as root only when a child uid was configured', async () => {
    // The uid is not applied here (the test process is not root); what is asserted is that the
    // *refusal* is conditioned on the configuration and not on something incidental.
    const started: { uid?: number }[] = [];
    const harness = await startShim({
      currentUid: () => 0,
      childUid: 1000,
      childGid: 1000,
      spawnChild: (_command, _args, spawnOptions) => {
        started.push({ ...(spawnOptions.uid === undefined ? {} : { uid: spawnOptions.uid }) });
        throw new Error('not actually spawning in this test');
      },
    });
    const probe = await authenticate(harness);
    probe.send(spawnFrame('process.exit(0)'));
    await probe.next('fatal');
    expect(started).toEqual([{ uid: 1000 }]);
  });

  it('refuses a relative command: there is no PATH lookup to hijack', async () => {
    const harness = await startShim();
    const probe = await authenticate(harness);
    probe.send({ type: 'spawn', command: 'node', args: [], cwd: '/tmp', env: {} });
    expect(await probe.next('fatal')).toMatchObject({ reason: 'protocol_error' });
    expect(harness.shim.childPid).toBeNull();
  });

  it('reports the exit code the child chose', async () => {
    const harness = await startShim();
    const probe = await authenticate(harness);
    probe.send(spawnFrame('process.exit(7)'));
    expect(await probe.next('exit')).toEqual({ type: 'exit', code: 7, signal: null });
    expect(harness.shutdowns).toEqual(['child_exited']);
  });

  it('reports a killed child as a signal, never as a zero code', async () => {
    const harness = await startShim();
    const probe = await authenticate(harness);
    probe.send(spawnFrame('setInterval(() => {}, 1000)'));
    await probe.next('spawn.ok');
    probe.send({ type: 'signal', name: 'SIGKILL' });
    expect(await probe.next('exit')).toEqual({ type: 'exit', code: null, signal: 'SIGKILL' });
  });

  it('relays a signal from the allow-list to the child', async () => {
    const harness = await startShim();
    const probe = await authenticate(harness);
    probe.send(
      spawnFrame(
        "process.on('SIGUSR1', () => { process.stdout.write('caught\\n'); process.exit(3); }); setInterval(() => {}, 1000); process.stdout.write('ready\\n');",
      ),
    );
    await probe.next('stdout');
    probe.send({ type: 'signal', name: 'SIGUSR1' });
    expect(await probe.next('exit')).toMatchObject({ code: 3 });
    expect(collect(probe, 'stdout').toString()).toContain('caught');
  });

  it('refuses a signal outside the allow-list and leaves the child running', async () => {
    const harness = await startShim();
    const probe = await authenticate(harness);
    probe.send(spawnFrame('setInterval(() => {}, 1000)'));
    await probe.next('spawn.ok');
    const pid = harness.shim.childPid as number;
    probe.send({ type: 'signal', name: 'SIGSTOP' });
    expect(await probe.next('fatal')).toMatchObject({ reason: 'protocol_error' });
    expect(processIsAlive(pid)).toBe(true);
  });
});

describe('the run shim: stdio', () => {
  it('keeps stdout and stderr apart and pipes stdin through', async () => {
    const harness = await startShim();
    const probe = await authenticate(harness);
    probe.send(
      spawnFrame(
        "process.stderr.write('to stderr'); let seen=''; process.stdin.on('data', (d) => { seen += d; }); process.stdin.on('end', () => { process.stdout.write('echo:' + seen); process.exit(0); });",
      ),
    );
    await probe.next('spawn.ok');
    probe.send({ type: 'stdin' }, Buffer.from('a prompt'));
    probe.send({ type: 'stdin.end' });
    await probe.next('exit');
    expect(collect(probe, 'stdout').toString()).toBe('echo:a prompt');
    expect(collect(probe, 'stderr').toString()).toBe('to stderr');
  });

  it('applies backpressure on a large stdout instead of buffering it', async () => {
    const harness = await startShim();
    const probe = await authenticate(harness);
    const megabytes = 16;

    // Canary for the counter this test believes (standing rule 29): a small write must leave it
    // at zero, so "greater than zero" below is a measurement and not a constant.
    probe.send(spawnFrame("process.stdout.write('x'.repeat(1000)); process.exit(0)"));
    await probe.next('exit');
    expect(harness.shim.metrics.stdoutPauses).toBe(0);

    const second = await startShim();
    const reader = await connectProbe(second.volume.controlSocketPath);
    reader.send({ type: 'hello', protocol: 1, token: TOKEN });
    await reader.next('hello.ok');
    reader.pause();
    reader.send(
      spawnFrame(
        `const block = Buffer.alloc(1024 * 1024, 97); for (let i = 0; i < ${megabytes}; i += 1) { process.stdout.write(block); } process.stdout.end();`,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(second.shim.metrics.stdoutPauses).toBeGreaterThan(0);

    reader.resume();
    await reader.next('exit');
    const received = collect(reader, 'stdout');
    expect(received).toHaveLength(megabytes * 1024 * 1024);
    expect(received.every((byte) => byte === 97)).toBe(true);
  });
});

describe('the run shim: kill on disconnect', () => {
  it('SIGTERMs the child, waits the grace period on the clock, then SIGKILLs it', async () => {
    const harness = await startShim({ killGraceMs: 20_000 });
    const probe = await authenticate(harness);
    const marker = path.join(harness.volume.dir, 'termed');
    probe.send(
      spawnFrame(
        "process.on('SIGTERM', () => { require('fs').writeFileSync(process.env.MARKER, 'term'); }); setInterval(() => {}, 1000); process.stdout.write('ready\\n');",
        { MARKER: marker },
      ),
    );
    await probe.next('stdout');
    const pid = harness.shim.childPid as number;

    probe.close();
    // The child ignores SIGTERM, so the marker proves the *graceful* half really ran…
    await waitForFile(marker);
    expect(await readFile(marker, 'utf8')).toBe('term');
    expect(processIsAlive(pid)).toBe(true);

    // …and the shim has sent nothing else yet. This, not `processIsAlive`, is what pins the grace
    // period: process death is asynchronous, so a shim that SIGKILLed immediately would still look
    // alive for a millisecond here — a mutation replacing `killGraceMs` with `0` survived exactly
    // that assertion until this line existed.
    harness.clock.advance(19_999);
    expect(harness.shim.metrics.teardownSignals).toEqual(['SIGTERM']);
    expect(processIsAlive(pid)).toBe(true);

    harness.clock.advance(2);
    expect(harness.shim.metrics.teardownSignals).toEqual(['SIGTERM', 'SIGKILL']);
    // And the recorded SIGKILL was a real one: the only thing that can end a process which ignores
    // SIGTERM is SIGKILL, and the operating system is asked, not a spy.
    await waitForProcessGone(pid);
    expect(harness.shutdowns).toEqual(['control_disconnected']);
  });

  it('does not SIGKILL a child that goes away on SIGTERM', async () => {
    const harness = await startShim({ killGraceMs: 20_000 });
    const probe = await authenticate(harness);
    probe.send(spawnFrame("setInterval(() => {}, 1000); process.stdout.write('ready\\n');"));
    await probe.next('stdout');
    const pid = harness.shim.childPid as number;

    probe.close();
    await waitForProcessGone(pid);
    // The grace timer was cancelled by the child's own exit rather than left armed…
    expect(harness.clock.pending).toBe(0);
    // …and no SIGKILL was ever sent, which is the half `processIsAlive` cannot see.
    expect(harness.shim.metrics.teardownSignals).toEqual(['SIGTERM']);
    expect(harness.shutdowns).toEqual(['control_disconnected']);
  });

  it('never gives the control slot back, so a child cannot take it', async () => {
    const harness = await startShim({ killGraceMs: 1_000 });
    const probe = await authenticate(harness);
    probe.send(spawnFrame('setInterval(() => {}, 1000)'));
    await probe.next('spawn.ok');
    const pid = harness.shim.childPid as number;
    probe.close();
    await waitForProcessGone(pid);

    const later = await connectProbe(harness.volume.controlSocketPath).catch(() => null);
    if (later !== null) {
      later.send({ type: 'hello', protocol: 1, token: TOKEN });
      await later.closed;
      expect(later.received.map((d) => d.frame.type)).not.toContain('hello.ok');
    }
  });
});

describe('the run shim: cred.get is the only surface the workspace can reach', () => {
  const startRun = async (over: Partial<RunletShimOptions> = {}) => {
    const harness = await startShim(over);
    const runner = await authenticate(harness);
    runner.send(spawnFrame('setInterval(() => {}, 1000)'));
    await runner.next('spawn.ok');
    return { harness, runner };
  };

  it('forwards a request and relays the answer to the helper that asked', async () => {
    const { harness, runner } = await startRun();
    const helper = await connectProbe(harness.volume.credentialSocketPath);
    helper.send({
      type: 'cred.get',
      request_id: 'git-1',
      host: 'gitlab.example.com',
      protocol: 'https',
    });

    const asked = (await runner.next('cred.get')) as { request_id: string; host: string };
    expect(asked.host).toBe('gitlab.example.com');
    // The workspace does not get to name the request the runner sees.
    expect(asked.request_id).not.toBe('git-1');

    runner.send({
      type: 'cred.reply',
      request_id: asked.request_id,
      credential: { username: 'agentic', password: 'glpat-FAKE-0000000000000000' },
    });
    const answer = (await helper.next('cred.reply')) as {
      request_id: string;
      credential: { username: string } | null;
    };
    expect(answer.request_id).toBe('git-1');
    expect(answer.credential?.username).toBe('agentic');
  });

  it('refuses a request before a run is spawned, and asks the runner nothing', async () => {
    const harness = await startShim();
    const runner = await authenticate(harness);
    const helper = await connectProbe(harness.volume.credentialSocketPath);
    helper.send({ type: 'cred.get', request_id: 'g', host: 'example.com', protocol: 'https' });
    expect(await helper.next('fatal')).toMatchObject({ reason: 'credential_refused' });
    expect(credentialFrames(runner)).toHaveLength(0);
  });

  /**
   * A child that **outlives its own exit**: it forks a detached grandchild holding fd 1 — the very
   * pipe the shim reads — and then exits 7 when anything arrives on stdin.
   *
   * That is the shape a review used to find the defect this test now pins. `close` is what ends the
   * run, and `close` cannot fire while *something* holds the pipe, so the shim sits in a window
   * where the child is gone and the run is not over: `stdioFlushMs` long at best, unbounded if the
   * grandchild never lets go. `child !== null` — the old guard — is true throughout it.
   *
   * It is run twice because a child can leave in two ways and Node records them in two *different*
   * fields: a child that exits sets `exitCode` and leaves `signalCode` null, a child that is
   * signalled does the opposite. A guard reading one of them is open to the other.
   */
  const OUTLIVES_ITS_OWN_EXIT = `
    const { spawn } = require('child_process');
    const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      detached: true,
      stdio: ['ignore', 1, 'ignore'],
    });
    g.unref();
    require('fs').writeFileSync(process.env.GPID, String(g.pid));
    process.stdout.write('ready\\n');
    process.stdin.on('data', () => process.exit(7));
  `;

  it.each([
    [
      'exits on its own',
      (runner: RunletProbe) => runner.send({ type: 'stdin' }, Buffer.from('go\n')),
      { code: 7, signal: null },
    ],
    [
      'is killed by a signal',
      (runner: RunletProbe) => runner.send({ type: 'signal', name: 'SIGKILL' }),
      { code: null, signal: 'SIGKILL' },
    ],
  ])(
    'refuses a credential once the child %s, while its stdout is still held open',
    async (_how, endTheChild, expectedExit) => {
      const harness = await startShim({ stdioFlushMs: 60_000 });
      const runner = await authenticate(harness);
      const gpidFile = path.join(harness.volume.dir, 'gpid');
      runner.send(spawnFrame(OUTLIVES_ITS_OWN_EXIT, { GPID: gpidFile }));
      await runner.next('stdout');
      const childPid = harness.shim.childPid as number;

      // Baseline first (standing rule 29): while the child runs, *this exact request* is forwarded.
      // Without it, "the runner heard nothing" would also be true of a harness that cannot ask.
      const early = await connectProbe(harness.volume.credentialSocketPath);
      early.send({ type: 'cred.get', request_id: 'g1', host: 'example.com', protocol: 'https' });
      const asked = (await runner.next('cred.get')) as { request_id: string };
      runner.send({ type: 'cred.reply', request_id: asked.request_id, credential: null });
      await early.next('cred.reply');
      expect(credentialFrames(runner)).toHaveLength(1);
      const refusalsBefore = harness.shim.metrics.credentialRefusals;

      await waitForFile(gpidFile);
      const grandchildPid = Number(await readFile(gpidFile, 'utf8'));
      strays.push(grandchildPid);
      endTheChild(runner);
      await waitForProcessGone(childPid);
      // The shim has *seen* the exit — the flush timer is the one thing armed on the injected clock
      // — and has not reported it, because the grandchild still holds stdout. This is the window.
      await waitFor('the shim armed the stdio flush timer', () => harness.clock.pending === 1);
      expect(processIsAlive(grandchildPid)).toBe(true);
      expect(runner.received.filter((d) => d.frame.type === 'exit')).toHaveLength(0);

      const late = await connectProbe(harness.volume.credentialSocketPath);
      late.send({ type: 'cred.get', request_id: 'g2', host: 'example.com', protocol: 'https' });
      // Waiting for *either* outcome, then asserting which one happened. `await late.next('fatal')`
      // would be the obvious line and it is the wrong one: restoring the old guard makes it hang,
      // and a mutant that dies of a timeout has not been killed by an assertion (standing rule 3).
      await waitFor(
        'the shim answered the late request one way or the other',
        () => late.received.length > 0 || credentialFrames(runner).length > 1,
      );
      expect(credentialFrames(runner)).toHaveLength(1);
      expect(late.received.map((decoded) => decoded.frame.type)).toEqual(['fatal']);
      expect(late.received[0]?.frame).toMatchObject({ reason: 'credential_refused' });
      expect(harness.shim.metrics.credentialRefusals).toBe(refusalsBefore + 1);

      // …and the window was real rather than already closed by something else: the exit reaches the
      // runner only when the flush deadline does, which is a move of the clock away.
      harness.clock.advance(60_001);
      expect(await runner.next('exit')).toMatchObject(expectedExit);
    },
  );

  /**
   * The flush window is a bound on **silence**, not on how long the tail takes to arrive.
   *
   * `close` — every byte read and framed — is what ends a run honestly; the window exists only
   * because a detached grandchild can withhold `close` for ever. Armed once at the child's exit, it
   * also cuts off a stream that is still *delivering*: the 16 MiB conformance run lost its last
   * 65,536 bytes (one pipe buffer, taking the `result` line with it) on a loaded machine, twice in
   * ten full-suite runs, and reported the run as ended.
   *
   * The grandchild here writes **after** the clock has been moved almost to the original deadline,
   * so "the deadline moved with the data" is the only way the later assertions can hold.
   */
  const GRANDCHILD_SPEAKS_LATER = `
    const { spawn } = require('child_process');
    const g = spawn(process.execPath, ['-e', "const fs = require('fs'); const go = process.env.GO; const until = Date.now() + 30000; const t = setInterval(() => { if (fs.existsSync(go)) { clearInterval(t); process.stdout.write('from-the-grandchild\\\\n'); setTimeout(() => {}, 30000); } else if (Date.now() > until) { clearInterval(t); } }, 20);"], {
      detached: true,
      stdio: ['ignore', 1, 'ignore'],
      env: { GO: process.env.GO },
    });
    g.unref();
    require('fs').writeFileSync(process.env.GPID, String(g.pid));
    process.stdout.write('ready\\n');
    process.exit(7);
  `;

  it('does not cut off stdio that is still arriving: the flush window bounds silence', async () => {
    const harness = await startShim({ stdioFlushMs: 10_000 });
    const runner = await authenticate(harness);
    const gpidFile = path.join(harness.volume.dir, 'gpid');
    const goFile = path.join(harness.volume.dir, 'go');
    runner.send(spawnFrame(GRANDCHILD_SPEAKS_LATER, { GPID: gpidFile, GO: goFile }));
    await runner.next('stdout');
    const childPid = harness.shim.childPid as number;
    await waitForFile(gpidFile);
    strays.push(Number(await readFile(gpidFile, 'utf8')));
    await waitForProcessGone(childPid);
    await waitFor('the shim armed the stdio flush timer', () => harness.clock.pending === 1);

    /**
     * "No `exit` frame has arrived" is a claim about the *socket*, and `clock.advance` only runs
     * the timer: whatever the shim writes in it is still in flight when the next line executes. A
     * ping/pong round trip is the barrier — frames are delivered in order, so a `pong` back means
     * anything written before it is already in `received`. Without it this assertion passes on a
     * shim that *did* report the exit, which is standing rule 4 exactly: the mutant that arms the
     * window once survived it.
     */
    const settle = async (): Promise<void> => {
      runner.send({ type: 'ping' });
      // A shim that has *already* ended the run closes the socket instead of answering, and that
      // must arrive at the assertion below as "an exit frame was reported", not as a rejected
      // promise about a pong.
      await runner.next('pong').catch(() => undefined);
    };

    // One millisecond short of the deadline armed at the child's exit: nothing has been reported
    // yet, which is true of both the old behaviour and the new one.
    harness.clock.advance(9_999);
    await settle();
    expect(runner.received.filter((d) => d.frame.type === 'exit')).toHaveLength(0);

    // The grandchild speaks. This is the tail of the run's output — the part that was being lost.
    await writeFile(goFile, 'go', 'utf8');
    await waitFor('the line from the grandchild reached the runner', () =>
      collect(runner, 'stdout').includes('from-the-grandchild'),
    );

    // Past the *original* deadline. A window armed once at `exit` would have ended the run here.
    harness.clock.advance(2);
    await settle();
    expect(runner.received.filter((d) => d.frame.type === 'exit')).toHaveLength(0);

    // …and it is still a bound: once the pipe goes quiet for the whole window, the run ends, with
    // the exit status the child chose rather than a socket that goes silent.
    harness.clock.advance(10_000);
    expect(await runner.next('exit')).toMatchObject({ code: 7, signal: null });
  });

  /**
   * The same window, one door further on, found while fixing the credential one.
   *
   * A runner that disappears makes the shim shut down and **exit the container** — that is what
   * `onShutdown` is for and what `research/12` check 6 observes as `exited:0`. The shutdown path
   * waited for the child's `exit` event before finishing, guarded by the same `child === null` that
   * is never true after `spawn`: when the child had *already* exited, that event could never fire
   * again and the shim stayed alive with its servers listening, for ever. An orphaned shim holding
   * a run's control volume is the failure TD-025 §1 is about, reached by the opposite route.
   */
  it('finishes shutting down when the runner drops after the child has already exited', async () => {
    const harness = await startShim({ stdioFlushMs: 60_000 });
    const runner = await authenticate(harness);
    const gpidFile = path.join(harness.volume.dir, 'gpid');
    runner.send(spawnFrame(OUTLIVES_ITS_OWN_EXIT, { GPID: gpidFile }));
    await runner.next('stdout');
    const childPid = harness.shim.childPid as number;
    await waitForFile(gpidFile);
    strays.push(Number(await readFile(gpidFile, 'utf8')));

    runner.send({ type: 'stdin' }, Buffer.from('go\n'));
    await waitForProcessGone(childPid);
    await waitFor('the shim armed the stdio flush timer', () => harness.clock.pending === 1);
    expect(harness.shutdowns).toEqual([]);

    runner.close();
    await waitFor(
      'the shim finished shutting down',
      () => harness.shutdowns.length > 0,
      // Bounded *under* the test timeout so the failure reads "the shim finished shutting down
      // never became true" rather than "test timed out": the mutant must name what it broke
      // (standing rule 3). This is not a performance bound — the shim has nothing left to wait
      // for, so a pass is immediate and the number is only how long a *failure* takes to report.
      2_000,
    );
    expect(harness.shutdowns).toEqual(['control_disconnected']);
    // And it did not try to kill a child that had already gone.
    expect(harness.shim.metrics.teardownSignals).toEqual([]);
  });

  it('refuses cleartext and a malformed host before the runner ever hears about it', async () => {
    const { harness, runner } = await startRun();
    // Baseline first, so "the runner heard nothing" is a change from something rather than a
    // vacuous zero (standing rule 29).
    const good = await connectProbe(harness.volume.credentialSocketPath);
    good.send({ type: 'cred.get', request_id: 'g', host: 'example.com', protocol: 'https' });
    await runner.next('cred.get');
    expect(credentialFrames(runner)).toHaveLength(1);

    for (const bad of [
      { type: 'cred.get', request_id: 'g', host: 'example.com', protocol: 'http' },
      { type: 'cred.get', request_id: 'g', host: 'EXAMPLE.com', protocol: 'https' },
      { type: 'cred.get', request_id: 'g', host: 'example.com:8443', protocol: 'https' },
      { type: 'cred.get', request_id: 'g', host: 'user@example.com', protocol: 'https' },
      { type: 'cred.get', request_id: '../../etc', host: 'example.com', protocol: 'https' },
    ]) {
      const helper = await connectProbe(harness.volume.credentialSocketPath);
      helper.send(bad);
      expect(await helper.next('fatal'), JSON.stringify(bad)).toMatchObject({
        reason: 'protocol_error',
      });
    }
    expect(credentialFrames(runner)).toHaveLength(1);
  });

  it('refuses every other frame on the credential socket, spawn included', async () => {
    const { harness } = await startRun();
    const helper = await connectProbe(harness.volume.credentialSocketPath);
    helper.send(spawnFrame('process.exit(0)'));
    expect(await helper.next('fatal')).toMatchObject({ reason: 'unexpected_frame' });

    const second = await connectProbe(harness.volume.credentialSocketPath);
    second.send({ type: 'signal', name: 'SIGKILL' });
    expect(await second.next('fatal')).toMatchObject({ reason: 'unexpected_frame' });
  });

  it('caps how many credentials one run may ask for', async () => {
    const { harness, runner } = await startRun({ maxCredentialRequests: 2 });
    for (const index of [1, 2]) {
      const helper = await connectProbe(harness.volume.credentialSocketPath);
      helper.send({
        type: 'cred.get',
        request_id: `g${index}`,
        host: 'example.com',
        protocol: 'https',
      });
      const asked = (await runner.next('cred.get')) as { request_id: string };
      runner.send({ type: 'cred.reply', request_id: asked.request_id, credential: null });
      await helper.next('cred.reply');
    }
    const third = await connectProbe(harness.volume.credentialSocketPath);
    third.send({ type: 'cred.get', request_id: 'g3', host: 'example.com', protocol: 'https' });
    expect(await third.next('fatal')).toMatchObject({ reason: 'credential_refused' });
    expect(credentialFrames(runner)).toHaveLength(2);
    expect(harness.shim.metrics.credentialRefusals).toBe(1);
  });

  /**
   * The *concurrency* cap, which the shim's docblock and Q50 both claim and nothing asserted:
   * deleting either half left 113 of 113 runlet tests green (standing rule 3). There are two
   * halves, refusing at two different moments, and each test below names which one answered by
   * reading the `message` on the refusal — an assertion satisfied by both halves would not say
   * which branch ran (standing rule 10).
   */
  it('caps how many credential requests may be in flight at once', async () => {
    const { harness, runner } = await startRun({ maxConcurrentCredentials: 2 });
    // One connection, two questions, neither answered — so the *connection* cap is not what
    // refuses the third one.
    const helper = await connectProbe(harness.volume.credentialSocketPath);
    helper.send({ type: 'cred.get', request_id: 'g1', host: 'a.example', protocol: 'https' });
    await runner.next('cred.get');
    helper.send({ type: 'cred.get', request_id: 'g2', host: 'b.example', protocol: 'https' });
    await runner.next('cred.get');
    expect(credentialFrames(runner)).toHaveLength(2);

    const third = await connectProbe(harness.volume.credentialSocketPath);
    third.send({ type: 'cred.get', request_id: 'g3', host: 'c.example', protocol: 'https' });
    // Either outcome, then assert which: `await third.next('fatal')` would hang when the cap is
    // gone, and a mutant killed by a timeout is not killed by an assertion (standing rule 3).
    await waitFor(
      'the shim answered the third question one way or the other',
      () => third.received.length > 0 || credentialFrames(runner).length > 2,
    );
    expect(credentialFrames(runner)).toHaveLength(2);
    expect(third.received[0]?.frame).toMatchObject({
      type: 'fatal',
      reason: 'credential_refused',
      message: 'too many credential requests in flight',
    });
  });

  it('caps how many helpers may hold the credential socket at once', async () => {
    const { harness, runner } = await startRun({ maxConcurrentCredentials: 1 });
    const helper = await connectProbe(harness.volume.credentialSocketPath);
    helper.send({ type: 'cred.get', request_id: 'g1', host: 'a.example', protocol: 'https' });
    const asked = (await runner.next('cred.get')) as { request_id: string };
    runner.send({ type: 'cred.reply', request_id: asked.request_id, credential: null });
    await helper.next('cred.reply');
    expect(credentialFrames(runner)).toHaveLength(1);

    // Nothing is in flight now, so this refusal is the *connection* cap and not the other one:
    // the second helper is turned away before a decoder is ever attached to its socket.
    const second = await connectProbe(harness.volume.credentialSocketPath);
    second.send({ type: 'cred.get', request_id: 'g2', host: 'b.example', protocol: 'https' });
    await waitFor(
      'the shim answered the second helper one way or the other',
      () => second.received.length > 0 || credentialFrames(runner).length > 1,
    );
    expect(credentialFrames(runner)).toHaveLength(1);
    expect(second.received[0]?.frame).toMatchObject({
      type: 'fatal',
      reason: 'credential_refused',
      message: 'too many credential connections',
    });
    expect(harness.shim.metrics.credentialRefusals).toBe(1);
  });

  it('tells the helper "no credential" when the runner never answers', async () => {
    const { harness, runner } = await startRun({ credentialTimeoutMs: 10_000 });
    const helper = await connectProbe(harness.volume.credentialSocketPath);
    helper.send({ type: 'cred.get', request_id: 'g', host: 'example.com', protocol: 'https' });
    const asked = (await runner.next('cred.get')) as { request_id: string };

    harness.clock.advance(10_001);
    expect(await helper.next('cred.reply')).toEqual({
      type: 'cred.reply',
      request_id: 'g',
      credential: null,
    });

    // And the late answer is dropped rather than delivered to whoever holds that id next.
    runner.send({
      type: 'cred.reply',
      request_id: asked.request_id,
      credential: { username: 'x', password: 'late' },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(harness.shim.metrics.staleCredentialReplies).toBe(1);
    const delivered = helper.received.filter((d) => d.frame.type === 'cred.reply');
    expect(delivered).toHaveLength(1);
  });

  it('never delivers one helper the credential another asked for', async () => {
    const { harness, runner } = await startRun();
    const first = await connectProbe(harness.volume.credentialSocketPath);
    const second = await connectProbe(harness.volume.credentialSocketPath);
    first.send({ type: 'cred.get', request_id: 'same-id', host: 'a.example', protocol: 'https' });
    const askedFirst = (await runner.next('cred.get')) as { request_id: string; host: string };
    second.send({ type: 'cred.get', request_id: 'same-id', host: 'b.example', protocol: 'https' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const asks = credentialFrames(runner).map((d) => d.frame) as {
      request_id: string;
      host: string;
    }[];
    expect(asks).toHaveLength(2);
    expect(asks[0]?.request_id).not.toBe(asks[1]?.request_id);

    runner.send({
      type: 'cred.reply',
      request_id: askedFirst.request_id,
      credential: { username: 'u', password: 'for-a-example' },
    });
    await first.next('cred.reply');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(second.received.filter((d) => d.frame.type === 'cred.reply')).toHaveLength(0);
  });

  it('closes the credential socket when the run ends', async () => {
    const harness = await startShim();
    const runner = await authenticate(harness);
    runner.send(spawnFrame('process.exit(0)'));
    await runner.next('exit');
    await expect(connectProbe(harness.volume.credentialSocketPath)).rejects.toThrow();
  });
});

/**
 * The fallback for a filesystem that will not `chmod` a socket (WP-22).
 *
 * The branch exists because Docker Desktop's virtiofs answers `EINVAL` to `chmod` on a Unix socket
 * — measured; the module docblock has the numbers — which made the shim refuse to start on the one
 * arrangement a developer runs the real images in. The property the `0600` buys is "nothing but
 * this uid can open it", and a `0700` directory owned by this process denies the same set, so the
 * fallback checks the property rather than the call.
 *
 * Asserted in both directions, because a fallback that accepted anything and a fallback that is
 * never reached look identical from the passing side (standing rule 42): the same failure with a
 * directory that does **not** protect the socket is still refused, and the message names what it
 * found.
 */
describe('the run shim: the socket mode a filesystem refuses to set', () => {
  const cause = Object.assign(new Error("EINVAL: invalid argument, chmod '/ctl/ctl.sock'"), {
    code: 'EINVAL',
  });

  it('accepts a 0700 directory owned by this process as the protection instead', async () => {
    const volume = await createControlVolume();
    try {
      const warnings: { fields: LogFields; message: string }[] = [];
      await chmod(volume.dir, 0o700);
      await expect(
        assertControlDirectoryProtects(volume.controlSocketPath, cause, {
          debug: () => undefined,
          info: () => undefined,
          warn: (fields, message) => warnings.push({ fields, message }),
          error: () => undefined,
        }),
      ).resolves.toBeUndefined();
      // The residual is logged rather than swallowed: an operator reading the run's log learns which
      // guarantee is carried by the directory instead of by the socket.
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.message).toContain('0700 owner-only directory');
      expect(warnings[0]?.fields['directory_mode']).toBe('700');
    } finally {
      await volume.cleanup();
    }
  });

  it.each([
    ['a group-readable directory', 0o750],
    ['a world-traversable directory', 0o755],
    ['a directory anyone may write into', 0o777],
  ])('still refuses when the directory does not protect it either: %s', async (_name, mode) => {
    const volume = await createControlVolume();
    try {
      await chmod(volume.dir, mode);
      await expect(
        assertControlDirectoryProtects(volume.controlSocketPath, cause, silentLogger),
      ).rejects.toThrow(/does not protect it either: mode 7[0-7][0-7]/);
    } finally {
      await volume.cleanup();
    }
  });

  /**
   * The directory is owned by **this** process, not merely `0700` (standing rule 42).
   *
   * A `0700` directory owned by somebody else denies this process, so the socket inside it is not
   * reachable by the runner either — and the mode alone cannot tell the two apart. Every other case
   * here varies the mode, which would leave the owner half of the condition asserted by nothing.
   */
  it('refuses a 0700 directory owned by another uid, and names both numbers', async () => {
    const volume = await createControlVolume();
    const owner = process.getuid?.() ?? -1;
    const spy = vi.spyOn(process, 'getuid').mockReturnValue(owner + 1);
    try {
      await chmod(volume.dir, 0o700);
      await expect(
        assertControlDirectoryProtects(volume.controlSocketPath, cause, silentLogger),
      ).rejects.toThrow(new RegExp(`owner ${owner}, this process ${owner + 1}`));
    } finally {
      spy.mockRestore();
      await volume.cleanup();
    }
  });

  /**
   * A `chmod` that failed for a reason the directory says nothing about still refuses.
   *
   * The first version of this fallback caught *every* error, which would have turned `EPERM` — this
   * process does not own the socket it just created — into a warning and a start. The fallback is
   * for a filesystem that cannot represent the mode, and nothing else.
   */
  it.each([
    ['EPERM', 'the socket belongs to somebody else'],
    ['ENOENT', 'the socket is gone'],
    ['EIO', 'the filesystem failed'],
  ])('re-throws a %s rather than treating it as an unsupported operation', async (code) => {
    const volume = await createControlVolume();
    try {
      // The directory *does* protect it, so only the error code decides the outcome.
      await chmod(volume.dir, 0o700);
      await expect(
        assertControlDirectoryProtects(
          volume.controlSocketPath,
          Object.assign(new Error(`${code}: something else`), { code }),
          silentLogger,
        ),
      ).rejects.toThrow(new RegExp(`^${code}: something else$`));
    } finally {
      await volume.cleanup();
    }
  });

  it('names the chmod failure it started from, so the log is not two mysteries', async () => {
    const volume = await createControlVolume();
    try {
      await chmod(volume.dir, 0o755);
      await expect(
        assertControlDirectoryProtects(volume.controlSocketPath, cause, silentLogger),
      ).rejects.toThrow(/EINVAL: invalid argument/);
    } finally {
      await volume.cleanup();
    }
  });
});

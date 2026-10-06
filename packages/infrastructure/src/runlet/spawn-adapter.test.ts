/**
 * The runner-side `SpawnedProcess`, against the **real shim** over a real Unix socket, and against
 * a raw server for the frames a well-behaved shim cannot produce.
 *
 * The split matters. `fake-spawn.ts` (WP-12) is the transport the SDK's own tests run on, and its
 * divergence register calls "no backpressure" a *kinder* divergence; WP-12's review closed with
 * "WP-13 must not run its large-stdout conformance test against this fake". So every test in this
 * file that is about bytes, exit status or credentials runs against `createRunletShim` with a real
 * child process, and the raw server appears only where the *runner's* guards are the subject.
 */

import { createHash } from 'node:crypto';
import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { manualClock } from '../runner/clock.js';
import { createRunletShim, type RunletShim } from './shim.js';
import {
  createAllowListCredentialResponder,
  createRunletSpawn,
  type RunletCredential,
  type RunletPreSpawnStep,
  type RunletSpawnOptions,
} from './spawn-adapter.js';
import {
  type ControlVolume,
  connectProbe,
  createControlVolume,
  createRawServer,
  nodeScript,
  type RawServer,
} from './testing.js';

const TOKEN = 'run-token-cccccccccccccccccccccc';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

const spawnOptionsFor = (script: string, over: Partial<SpawnOptions> = {}): SpawnOptions => ({
  ...nodeScript(script),
  cwd: process.cwd(),
  env: { PATH: process.env['PATH'] ?? '/usr/bin' },
  signal: new AbortController().signal,
  ...over,
});

interface Harness {
  readonly volume: ControlVolume;
  readonly shim: RunletShim;
  readonly clock: ReturnType<typeof manualClock>;
  readonly spawn: ReturnType<typeof createRunletSpawn>;
  readonly stderr: string[];
}

const withShim = async (over: Partial<RunletSpawnOptions> = {}): Promise<Harness> => {
  const volume = await createControlVolume();
  const clock = manualClock(1_000);
  const shim = createRunletShim({
    controlSocketPath: volume.controlSocketPath,
    credentialSocketPath: volume.credentialSocketPath,
    token: TOKEN,
    clock,
  });
  await shim.start();
  const stderr: string[] = [];
  const spawn = createRunletSpawn({
    socketPath: volume.controlSocketPath,
    token: TOKEN,
    clock,
    onStderr: (chunk) => stderr.push(chunk),
    ...over,
  });
  cleanups.push(async () => {
    await shim.close();
    await volume.cleanup();
  });
  return { volume, shim, clock, spawn, stderr };
};

const withRawShim = async (over: Partial<RunletSpawnOptions> = {}) => {
  const volume = await createControlVolume();
  const server: RawServer = await createRawServer(volume.controlSocketPath);
  const clock = manualClock(1_000);
  const spawn = createRunletSpawn({
    socketPath: volume.controlSocketPath,
    token: TOKEN,
    clock,
    ...over,
  });
  cleanups.push(async () => {
    await server.close();
    await volume.cleanup();
  });
  return { volume, server, clock, spawn };
};

const readAll = (stream: NodeJS.ReadableStream): Promise<Buffer> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });

const exitOf = (child: {
  once: (
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ) => void;
}): Promise<[number | null, NodeJS.Signals | null]> =>
  new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve([code, signal]));
  });

describe('the runner-side SpawnedProcess', () => {
  it('runs a child end to end: stdin in, stdout out, exit status back', async () => {
    const harness = await withShim();
    const child = harness.spawn(
      spawnOptionsFor(
        "let seen=''; process.stdin.on('data', (d) => { seen += d; }); process.stdin.on('end', () => { process.stdout.write('echo:' + seen); process.stderr.write('a warning'); process.exit(5); });",
      ),
    );
    const stdout = readAll(child.stdout);
    child.stdin.write('hello');
    child.stdin.end();
    const [code, signal] = await exitOf(child);
    expect([code, signal]).toEqual([5, null]);
    expect((await stdout).toString()).toBe('echo:hello');
    expect(harness.stderr.join('')).toBe('a warning');
    expect(child.exitCode).toBe(5);
  });

  it('sends stderr to the sink set on the spawn, which replaces the option (WP-127)', async () => {
    const harness = await withShim();
    const set: string[] = [];
    harness.spawn.setStderrSink((chunk) => set.push(chunk));
    const child = harness.spawn(
      spawnOptionsFor("process.stderr.write('to the sink'); process.exit(3);"),
    );
    child.stdin.end();
    expect(await exitOf(child)).toEqual([3, null]);
    expect(set.join('')).toBe('to the sink');
    expect(harness.stderr).toEqual([]);

    // A shim serves one child, so the `null` case is a second run's.
    const second = await withShim();
    second.spawn.setStderrSink(null);
    const dropped = second.spawn(
      spawnOptionsFor("process.stderr.write('nowhere'); process.exit(0);"),
    );
    dropped.stdin.end();
    expect(await exitOf(dropped)).toEqual([0, null]);
    expect(second.stderr).toEqual([]);
  });

  it('carries 16 MiB of stdout through unchanged, against the real shim', async () => {
    // The one test WP-12's review named explicitly: `fake-spawn` has no backpressure, so this
    // cannot run there. Here the bytes cross a real socket, a real pipe and a real pause/drain
    // cycle, and the hash is the whole assertion.
    const harness = await withShim();
    const megabytes = 16;
    const child = harness.spawn(
      spawnOptionsFor(
        // No `process.exit` after the writes: it discards whatever stdout has buffered, which
        // truncates the stream inside the *child* and would look exactly like a transport that
        // dropped bytes. The process ends by itself once the pipe has drained.
        `const block = Buffer.alloc(1024 * 1024, 97); for (let i = 0; i < ${megabytes}; i += 1) { process.stdout.write(block); } process.stdout.end();`,
      ),
    );
    const received = await readAll(child.stdout);
    expect(received).toHaveLength(megabytes * 1024 * 1024);
    expect(createHash('sha256').update(received).digest('hex')).toBe(
      createHash('sha256')
        .update(Buffer.alloc(megabytes * 1024 * 1024, 97))
        .digest('hex'),
    );
    expect(harness.shim.metrics.stdoutPauses).toBeGreaterThan(0);
  }, 30_000);

  it('relays kill() as a signal frame and refuses one outside the allow-list', async () => {
    const harness = await withShim();
    const child = harness.spawn(spawnOptionsFor('setInterval(() => {}, 1000)'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(child.kill('SIGSTOP' as NodeJS.Signals)).toBe(false);
    expect(child.kill('SIGTERM')).toBe(true);
    const [code, signal] = await exitOf(child);
    expect(code).toBeNull();
    expect(signal).toBe('SIGTERM');
    expect(child.killed).toBe(true);
  });

  it('maps the SDK teardown signal onto SIGTERM (technical/04)', async () => {
    const harness = await withShim();
    const teardown = new AbortController();
    const child = harness.spawn(
      spawnOptionsFor('setInterval(() => {}, 1000)', { signal: teardown.signal }),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    teardown.abort();
    const [, signal] = await exitOf(child);
    expect(signal).toBe('SIGTERM');
  });

  describe('the producer on the other end is untrusted', () => {
    it('reports a transport that died without an exit frame as null, never 0', async () => {
      const { server, spawn } = await withRawShim();
      const child = spawn(spawnOptionsFor('process.exit(0)'));
      const peer = await server.peer();
      await peer.next('hello');
      const errors: Error[] = [];
      child.on('error', (error) => errors.push(error));
      const exited = exitOf(child);
      peer.close();
      const [code, signal] = await exited;
      // Standing rule 16: the field the producer failed to send is not zero.
      expect(code).toBeNull();
      expect(signal).toBeNull();
      expect(child.exitCode).toBeNull();
      expect(errors.map((error) => error.message)).toContain(
        'the run shim closed the control connection',
      );
    });

    it('refuses an exit frame that carries no code', async () => {
      const { server, spawn } = await withRawShim();
      const child = spawn(spawnOptionsFor('process.exit(0)'));
      const peer = await server.peer();
      await peer.next('hello');
      peer.send({ type: 'hello.ok', protocol: 2 });
      const errors: Error[] = [];
      child.on('error', (error) => errors.push(error));
      const exited = exitOf(child);
      peer.send({ type: 'exit', signal: null });
      const [code] = await exited;
      expect(code).toBeNull();
      expect(errors[0]?.message).toMatch(/did not validate at: code/);
    });

    it.each([
      ['spawn', { type: 'spawn', command: '/bin/ls', args: [], cwd: '/', env: {} }],
      ['stdin.end', { type: 'stdin.end' }],
      ['signal', { type: 'signal', name: 'SIGKILL' }],
      ['cred.reply', { type: 'cred.reply', request_id: 'x', credential: null }],
      ['hello', { type: 'hello', protocol: 2, token: TOKEN }],
    ])(
      'refuses a %s frame arriving at the runner, which only the runner sends',
      async (_name, frame) => {
        const { server, spawn } = await withRawShim();
        const child = spawn(spawnOptionsFor('process.exit(0)'));
        const peer = await server.peer();
        await peer.next('hello');
        peer.send({ type: 'hello.ok', protocol: 2 });
        const errors: Error[] = [];
        child.on('error', (error) => errors.push(error));
        const exited = exitOf(child);
        peer.send(frame);
        await exited;
        expect(errors[0]?.message).toMatch(/only the runner sends|did not validate/);
      },
    );

    it('refuses a shim that speaks a protocol it does not know', async () => {
      const { server, spawn } = await withRawShim();
      const child = spawn(spawnOptionsFor('process.exit(0)'));
      const peer = await server.peer();
      await peer.next('hello');
      const errors: Error[] = [];
      child.on('error', (error) => errors.push(error));
      const exited = exitOf(child);
      peer.send({ type: 'hello.ok', protocol: 99 });
      await exited;
      expect(errors[0]?.message).toContain('the shim speaks protocol 99');
    });

    it('reports the shim refusing the connection', async () => {
      const { server, spawn } = await withRawShim();
      const child = spawn(spawnOptionsFor('process.exit(0)'));
      const peer = await server.peer();
      await peer.next('hello');
      const errors: Error[] = [];
      child.on('error', (error) => errors.push(error));
      const exited = exitOf(child);
      peer.send({ type: 'fatal', reason: 'auth_failed', message: 'no' });
      await exited;
      expect(errors[0]?.message).toContain('auth_failed');
    });

    it('fails the handshake on the injected clock rather than hanging', async () => {
      const { server, spawn, clock } = await withRawShim({ connectTimeoutMs: 5_000 });
      const child = spawn(spawnOptionsFor('process.exit(0)'));
      const peer = await server.peer();
      await peer.next('hello');
      const errors: Error[] = [];
      child.on('error', (error) => errors.push(error));
      clock.advance(4_999);
      expect(errors).toHaveLength(0);
      const exited = exitOf(child);
      clock.advance(2);
      await exited;
      expect(errors[0]?.message).toContain('did not answer the handshake');
    });

    it('reports a socket that is not there at all', async () => {
      const volume = await createControlVolume();
      cleanups.push(() => volume.cleanup());
      const spawn = createRunletSpawn({
        socketPath: volume.controlSocketPath,
        token: TOKEN,
        clock: manualClock(),
      });
      const child = spawn(spawnOptionsFor('process.exit(0)'));
      const errors: Error[] = [];
      child.on('error', (error) => errors.push(error));
      const [code] = await exitOf(child);
      expect(code).toBeNull();
      expect(errors[0]?.message).toMatch(/ENOENT/);
    });
  });

  /**
   * WP-150 (BD-010's 2026-10-06 amendment): the runner's gate between `hello.ok` and the `spawn`
   * frame — where the CLI spawn marker is committed. Against the raw server, because the question
   * is which frames reached the wire and when, which the real shim cannot answer.
   */
  describe('the spawn gate (WP-150)', () => {
    const gateOf = (beforeSpawn: () => Promise<void>) => {
      const steps: RunletPreSpawnStep[] = [];
      return {
        gate: { beforeSpawn, failedBeforeSpawn: (step: RunletPreSpawnStep) => steps.push(step) },
        steps,
      };
    };

    it('sends the spawn frame only after the gate answered, and keeps stdin queued behind it', async () => {
      const { server, spawn } = await withRawShim();
      let open: () => void = () => {};
      const asked = new Promise<void>((resolve) => {
        open = resolve;
      });
      let calls = 0;
      const { gate, steps } = gateOf(async () => {
        calls += 1;
        await asked;
      });
      spawn.setSpawnGate(gate);
      const child = spawn(spawnOptionsFor('process.exit(0)'));
      const peer = await server.peer();
      await peer.next('hello');
      peer.send({ type: 'hello.ok', protocol: 2 });
      child.stdin.write('the first prompt');
      // The gate is deciding: nothing but the hello has reached the shim.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(calls).toBe(1);
      expect(peer.received.map((decoded) => decoded.frame.type)).toEqual(['hello']);
      open();
      await peer.next('spawn');
      await peer.next('stdin');
      expect(peer.received.map((decoded) => decoded.frame.type)).toEqual([
        'hello',
        'spawn',
        'stdin',
      ]);
      expect(steps).toEqual([]);
      child.on('error', () => {});
      peer.close();
      await exitOf(child);
    });

    it('sends no spawn frame when the gate refuses, and names the step (criterion 5)', async () => {
      const { server, spawn } = await withRawShim();
      const { gate, steps } = gateOf(async () => {
        throw new Error('the platform refused to record the CLI spawn');
      });
      spawn.setSpawnGate(gate);
      const child = spawn(spawnOptionsFor('process.exit(0)'));
      const errors: Error[] = [];
      child.on('error', (error) => errors.push(error));
      const peer = await server.peer();
      await peer.next('hello');
      const exited = exitOf(child);
      peer.send({ type: 'hello.ok', protocol: 2 });
      const [code] = await exited;
      expect(code).toBeNull();
      expect(errors.map((error) => error.message)).toEqual([
        'the platform refused to record the CLI spawn',
      ]);
      expect(steps).toEqual(['spawn_refused']);
      await peer.closed;
      expect(peer.received.map((decoded) => decoded.frame.type)).not.toContain('spawn');
    });

    it.each([
      [
        'a fatal frame',
        'handshake_refused',
        (peer: Awaited<ReturnType<RawServer['peer']>>) =>
          peer.send({ type: 'fatal', reason: 'auth_failed', message: 'no' }),
      ],
      [
        'a hello.ok for another protocol',
        'handshake_refused',
        (peer: Awaited<ReturnType<RawServer['peer']>>) =>
          peer.send({ type: 'hello.ok', protocol: 99 }),
      ],
      [
        'a closed connection',
        'connection_lost',
        (peer: Awaited<ReturnType<RawServer['peer']>>) => peer.close(),
      ],
    ] as const)(
      'names %s before the spawn as %s, and never asks the gate',
      async (_name, step, act) => {
        const { server, spawn } = await withRawShim();
        let calls = 0;
        const { gate, steps } = gateOf(async () => {
          calls += 1;
        });
        spawn.setSpawnGate(gate);
        const child = spawn(spawnOptionsFor('process.exit(0)'));
        child.on('error', () => {});
        const peer = await server.peer();
        await peer.next('hello');
        const exited = exitOf(child);
        act(peer);
        await exited;
        expect(steps).toEqual([step]);
        expect(calls).toBe(0);
      },
    );

    it('names a handshake that timed out, and never asks the gate', async () => {
      const { server, spawn, clock } = await withRawShim({ connectTimeoutMs: 5_000 });
      let calls = 0;
      const { gate, steps } = gateOf(async () => {
        calls += 1;
      });
      spawn.setSpawnGate(gate);
      const child = spawn(spawnOptionsFor('process.exit(0)'));
      child.on('error', () => {});
      const peer = await server.peer();
      await peer.next('hello');
      const exited = exitOf(child);
      clock.advance(5_001);
      await exited;
      expect(steps).toEqual(['handshake_timeout']);
      expect(calls).toBe(0);
    });

    it('starts nothing when the process is killed while the gate is deciding (round 1)', async () => {
      const { server, spawn } = await withRawShim();
      let open: () => void = () => {};
      const { gate, steps } = gateOf(
        () =>
          new Promise<void>((resolve) => {
            open = resolve;
          }),
      );
      spawn.setSpawnGate(gate);
      const child = spawn(spawnOptionsFor('process.exit(0)'));
      child.on('error', () => {});
      const peer = await server.peer();
      await peer.next('hello');
      peer.send({ type: 'hello.ok', protocol: 2 });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const exited = exitOf(child);
      expect(child.kill('SIGTERM')).toBe(true);
      const [code, signal] = await exited;
      open();
      await peer.closed;
      expect(code).toBeNull();
      expect(signal).toBe('SIGTERM');
      expect(child.killed).toBe(true);
      expect(steps).toEqual([]);
      expect(peer.received.map((decoded) => decoded.frame.type)).toEqual(['hello']);
    });

    it('starts nothing when the SDK aborts while the gate is deciding', async () => {
      const { server, spawn } = await withRawShim();
      let open: () => void = () => {};
      const { gate, steps } = gateOf(
        () =>
          new Promise<void>((resolve) => {
            open = resolve;
          }),
      );
      spawn.setSpawnGate(gate);
      const abort = new AbortController();
      const child = spawn(spawnOptionsFor('process.exit(0)', { signal: abort.signal }));
      child.on('error', () => {});
      const peer = await server.peer();
      await peer.next('hello');
      peer.send({ type: 'hello.ok', protocol: 2 });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const exited = exitOf(child);
      abort.abort();
      const [code] = await exited;
      open();
      await peer.closed;
      expect(code).toBeNull();
      expect(steps).toEqual([]);
      // Neither the spawn nor a signal for a child that does not exist.
      expect(peer.received.map((decoded) => decoded.frame.type)).toEqual(['hello']);
    });
  });

  describe('the spawn frame is validated on the way out', () => {
    it('drops undefined environment values the SDK may pass', async () => {
      const harness = await withShim();
      const child = harness.spawn(
        spawnOptionsFor('process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))', {
          env: { KEEP: 'yes', DROP: undefined },
        }),
      );
      const stdout = await readAll(child.stdout);
      const names = JSON.parse(stdout.toString()) as string[];
      expect(names).toContain('KEEP');
      expect(names).not.toContain('DROP');
      // macOS' own `__CF_USER_TEXT_ENCODING` is added by the platform below `execve`, not by us;
      // asserting an exact set here would be asserting the operating system.
      expect(names.filter((name) => !name.startsWith('__'))).toEqual(['KEEP']);
    });

    it('refuses an environment name that could smuggle a second variable', async () => {
      const harness = await withShim();
      const child = harness.spawn(
        spawnOptionsFor('process.exit(0)', { env: { 'A=B': 'c', PATH: '/usr/bin' } }),
      );
      const errors: Error[] = [];
      child.on('error', (error) => errors.push(error));
      const [code] = await exitOf(child);
      expect(code).toBeNull();
      expect(harness.shim.childPid).toBeNull();
      expect(errors).toHaveLength(1);
    });

    it('never puts the bad frame on the wire — the refusal is this side of the socket', async () => {
      // Standing rule 22: against the real shim the test above passes either way, because the
      // shim's own decoder refuses the frame — the outer layer hides the inner one. A raw server
      // accepts anything, so it can answer the question the real shim cannot: *was it sent at
      // all?* Removing `runletFrameSchema.parse` from the adapter survived the test above and dies
      // here.
      const { server, spawn } = await withRawShim();
      const child = spawn(
        spawnOptionsFor('process.exit(0)', { env: { 'A=B': 'c', PATH: '/usr/bin' } }),
      );
      child.on('error', () => {});
      const peer = await server.peer();
      await peer.next('hello');
      peer.send({ type: 'hello.ok', protocol: 2 });
      await exitOf(child);
      expect(peer.received.map((decoded) => decoded.frame.type)).not.toContain('spawn');
    });
  });

  describe('credentials are decided on the platform side', () => {
    const helperAsk = async (harness: Harness, host: string) => {
      const helper = await connectProbe(harness.volume.credentialSocketPath);
      helper.send({
        type: 'cred.get',
        request_id: 'git-1',
        host,
        path: 'acme/api',
        protocol: 'https',
      });
      return helper;
    };

    const runUntilAsked = async (harness: Harness) => {
      const child = harness.spawn(spawnOptionsFor('setInterval(() => {}, 1000)'));
      await new Promise((resolve) => setTimeout(resolve, 150));
      return child;
    };

    /**
     * The allow-list matches a host **exactly**, and these are the cases that say so.
     *
     * `evil.example.com` alone did not: every plausible implementation refuses it, including a
     * broken one. A review mutated the check to `host.endsWith(allowed)`, watched it survive all
     * 134 runlet tests, and had the mutant hand back `SECRET-for-evil.gitlab.example.com`. The
     * three that follow it below are the distinguishing negatives — `evil-gitlab.example.com` is
     * refused only by something that is not a suffix match, `gitlab.example.com.evil.test` only by
     * something that is not a prefix match, and `a.gitlab.example.com.b.test` only by something
     * that is not a substring match. *An allow-list needs a negative case that only exact matching
     * refuses.*
     */
    const REFUSED = [
      ['an unrelated host', 'evil.example.com'],
      ['a host the allowed one is a suffix of', 'evil-gitlab.example.com'],
      ['a host the allowed one is a prefix of', 'gitlab.example.com.evil.test'],
      ['a host that contains the allowed one', 'a.gitlab.example.com.b.test'],
    ] as const;

    it('answers a host on the allow-list and refuses every host that is merely like it', async () => {
      const mint = vi.fn(
        async (host: string): Promise<RunletCredential> => ({
          username: 'agentic',
          password: `token-for-${host}`,
        }),
      );
      const harness = await withShim({
        credentials: createAllowListCredentialResponder({
          allowedHosts: ['gitlab.example.com'],
          credential: mint,
        }),
      });
      await runUntilAsked(harness);

      const allowed = await helperAsk(harness, 'gitlab.example.com');
      expect(await allowed.next('cred.reply')).toMatchObject({
        credential: { username: 'agentic', password: 'token-for-gitlab.example.com' },
      });
      // One helper invocation is one connection; git's is a short-lived process, and leaving five
      // of them open here would hit the shim's *connection* cap rather than the allow-list.
      allowed.close();

      for (const [what, host] of REFUSED) {
        const refused = await helperAsk(harness, host);
        expect(await refused.next('cred.reply'), `${what}: ${host}`).toMatchObject({
          credential: null,
        });
        refused.close();
      }
      // And no refusal reached the broker: the one call is the one host that was on the list.
      expect(mint).toHaveBeenCalledTimes(1);
      // …and the repository path the helper sent reached it through the shim and this adapter
      // unchanged (backlog 481): the decision on it is the platform side's, so it must arrive.
      expect(mint).toHaveBeenCalledWith('gitlab.example.com', 'acme/api');
    });

    it('matches exactly, without a socket in the way', async () => {
      // The same claim asserted directly on the responder. The test above proves it end to end;
      // this one names the function, so a later refactor that moves the decision cannot lose it.
      const responder = createAllowListCredentialResponder({
        allowedHosts: ['GitLab.Example.com'],
        credential: async (host) => ({ username: 'agentic', password: `token-for-${host}` }),
      });
      // The configured spelling is folded to lowercase, because that is the only spelling the wire
      // can carry (`runletHostSchema` refuses an uppercase host outright).
      expect(await responder({ host: 'gitlab.example.com', path: null })).toEqual({
        username: 'agentic',
        password: 'token-for-gitlab.example.com',
      });
      for (const [, host] of REFUSED) {
        expect(await responder({ host, path: null }), host).toBeNull();
      }
      expect(await responder({ host: 'gitlab.example.co', path: null })).toBeNull();
      expect(await responder({ host: 'gitlab.example.comm', path: null })).toBeNull();
      /**
       * Two negatives only an *exact* match refuses, and they can only be asked here.
       *
       * Every case above is refused by a responder that normalises its input as well as by one
       * that does not, so none of them distinguishes a **case-folding** responder —
       * `allowed.has(host.toLowerCase())` — from the shipped one. These two do: the first is
       * accepted by any responder that folds case, the second by any that treats the DNS root
       * form as the same name. They are asserted against the function rather than over the socket
       * because the wire cannot express either (`runletHostSchema` refuses an uppercase label and
       * an empty one, and `packages/contracts/src/runlet.test.ts` is where that is asserted). That
       * outer guard is *why* folding here would be defence in depth rather than policy — but it is
       * also why nothing would notice if this layer started folding, so it is pinned here
       * (standing rules 22 and 43).
       */
      expect(await responder({ host: 'GITLAB.EXAMPLE.COM', path: null })).toBeNull();
      expect(await responder({ host: 'gitlab.example.com.', path: null })).toBeNull();
    });

    it('is an allow-list, so an empty one allows nothing', async () => {
      const responder = createAllowListCredentialResponder({
        allowedHosts: [],
        credential: async () => ({ username: 'agentic', password: 'never' }),
      });
      expect(await responder({ host: 'gitlab.example.com', path: null })).toBeNull();
    });

    it('answers null when the broker throws, rather than failing the run open', async () => {
      const harness = await withShim({
        credentials: createAllowListCredentialResponder({
          allowedHosts: ['gitlab.example.com'],
          credential: () => Promise.reject(new Error('the broker is down')),
        }),
      });
      await runUntilAsked(harness);
      const helper = await helperAsk(harness, 'gitlab.example.com');
      expect(await helper.next('cred.reply')).toMatchObject({ credential: null });
    });

    it('answers null when no responder was wired at all', async () => {
      const harness = await withShim();
      await runUntilAsked(harness);
      const helper = await helperAsk(harness, 'gitlab.example.com');
      expect(await helper.next('cred.reply')).toMatchObject({ credential: null });
    });

    it('answers null when the responder itself throws', async () => {
      const harness = await withShim({
        credentials: () => {
          throw new Error('responder exploded');
        },
      });
      await runUntilAsked(harness);
      const helper = await helperAsk(harness, 'gitlab.example.com');
      expect(await helper.next('cred.reply')).toMatchObject({ credential: null });
    });
  });
});

/**
 * WP-118 (TD-012, PROGRESS backlog 342): the spawn frame now carries the container's facts beside
 * the model credential, so what the two ends of the transport **log** about a spawn is held here —
 * the command, the working directory, the pid and nothing of `env`. The frame itself is written to
 * no transcript and no log; this is the assertion that says so for both of its ends.
 */
describe('the spawn’s environment reaches no log line (WP-118)', () => {
  it('logs no env value on either end of a spawn', async () => {
    const lines: string[] = [];
    const recording = {
      debug: (fields: object, message: string) =>
        lines.push(`${message} ${JSON.stringify(fields)}`),
      info: (fields: object, message: string) => lines.push(`${message} ${JSON.stringify(fields)}`),
      warn: (fields: object, message: string) => lines.push(`${message} ${JSON.stringify(fields)}`),
      error: (fields: object, message: string) =>
        lines.push(`${message} ${JSON.stringify(fields)}`),
    };
    const env = {
      PATH: process.env['PATH'] ?? '/usr/bin',
      ANTHROPIC_API_KEY: 'FAKE-wp118-model-key-not-a-credential',
      HTTPS_PROXY: 'http://egress-wp118-sentinel:8888',
      HOME: '/tmp/wp118-sentinel-home',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '!wp118-sentinel-helper credential',
    };
    const volume = await createControlVolume();
    const clock = manualClock(1_000);
    const shim = createRunletShim({
      controlSocketPath: volume.controlSocketPath,
      credentialSocketPath: volume.credentialSocketPath,
      token: TOKEN,
      clock,
      logger: recording,
    });
    await shim.start();
    cleanups.push(async () => {
      await shim.close();
      await volume.cleanup();
    });
    const spawn = createRunletSpawn({
      socketPath: volume.controlSocketPath,
      token: TOKEN,
      clock,
      logger: recording,
    });
    const ran = spawn(spawnOptionsFor('process.exit(3)', { env }));
    expect((await exitOf(ran))[0]).toBe(3);
    // The shim did log the spawn — the line that would carry an environment if anything did.
    expect(lines.some((line) => line.startsWith('runlet spawned'))).toBe(true);
    // The distinctive values: `PATH`, `1` and `credential.helper` are words a log line may carry
    // for its own reasons, so they prove nothing either way.
    const sentinels = [env.ANTHROPIC_API_KEY, env.HTTPS_PROXY, env.HOME, env.GIT_CONFIG_VALUE_0];
    for (const value of sentinels) {
      for (const line of lines) {
        expect(line, `a log line carries the env value ${value}`).not.toContain(value);
      }
    }
  });
});

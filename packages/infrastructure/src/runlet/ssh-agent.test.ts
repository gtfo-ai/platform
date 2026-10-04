/**
 * The run shim's ssh-agent socket (WP-146, TD-028 decision 13b item 2) — the codec on its own, and
 * then the whole path with **OpenSSH's own clients** on the other end: `ssh-add -L` lists the run's
 * key; a user-authentication request is signed through the agent (the shim relays to the runner,
 * which holds the key) and verifies; `ssh-keygen -Y sign` is **refused** (review round 1: the oracle
 * signs logins, never an `SSHSIG` over data). Every other agent request is refused, `ssh-add` of a
 * key included. A real `sshd` accepting the signature is `scripts/deploy-key-check.mjs`'s.
 */
import { execFile } from 'node:child_process';
import { createPublicKey, verify } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeployKeySigner } from '../launcher/deploy-key-signer.js';
import { manualClock } from '../runner/clock.js';
import { createRunletShim } from './shim.js';
import { createRunletSpawn } from './spawn-adapter.js';
import {
  AGENT_FAILURE,
  AgentProtocolError,
  encodeAgentMessage,
  parseAgentRequest,
  publicKeyBlobOf,
  SSH_AGENTC_REQUEST_IDENTITIES,
  SSH_AGENTC_SIGN_REQUEST,
  splitAgentMessages,
} from './ssh-agent.js';
import { createControlVolume, nodeScript } from './testing.js';

const run = promisify(execFile);
const TOKEN = 'run-token-ssssssssssssssssssssss';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

const sshString = (value: Buffer): Buffer => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.length, 0);
  return Buffer.concat([length, value]);
};

describe('the ssh-agent codec (draft-miller-ssh-agent)', () => {
  it('reads the two requests a git client sends, and names every other type for refusal', () => {
    expect(parseAgentRequest(Buffer.from([SSH_AGENTC_REQUEST_IDENTITIES]))).toEqual({
      kind: 'identities',
    });
    const flags = Buffer.alloc(4);
    flags.writeUInt32BE(2, 0);
    const sign = parseAgentRequest(
      Buffer.concat([
        Buffer.from([SSH_AGENTC_SIGN_REQUEST]),
        sshString(Buffer.from('blob')),
        sshString(Buffer.from('data')),
        flags,
      ]),
    );
    expect(sign).toMatchObject({ kind: 'sign', flags: 2 });
    // 17 add, 18 remove, 19 remove all, 22 lock, 23 unlock, 25 add constrained, 27 extension.
    for (const type of [17, 18, 19, 22, 23, 25, 27]) {
      expect(parseAgentRequest(Buffer.from([type, 0, 0]))).toEqual({ kind: 'refused', type });
    }
  });

  it('closes on a message it cannot read: truncated, trailing bytes, empty, or oversized', () => {
    expect(() => parseAgentRequest(Buffer.alloc(0))).toThrow(AgentProtocolError);
    expect(() => parseAgentRequest(Buffer.from([SSH_AGENTC_REQUEST_IDENTITIES, 1]))).toThrow(
      AgentProtocolError,
    );
    expect(() =>
      parseAgentRequest(
        Buffer.concat([Buffer.from([SSH_AGENTC_SIGN_REQUEST]), Buffer.from([0, 0, 0, 9])]),
      ),
    ).toThrow(/truncated/);
    expect(() =>
      parseAgentRequest(
        Buffer.concat([
          Buffer.from([SSH_AGENTC_SIGN_REQUEST]),
          sshString(Buffer.from('b')),
          sshString(Buffer.from('d')),
          Buffer.alloc(5),
        ]),
      ),
    ).toThrow(/flags/);
    const huge = Buffer.alloc(4);
    huge.writeUInt32BE(1_000_000, 0);
    expect(() => splitAgentMessages(huge)).toThrow(/1000000 bytes/);
    const two = Buffer.concat([
      encodeAgentMessage(SSH_AGENTC_REQUEST_IDENTITIES),
      encodeAgentMessage(SSH_AGENTC_REQUEST_IDENTITIES).subarray(0, 3),
    ]);
    const split = splitAgentMessages(two);
    expect(split.messages).toHaveLength(1);
    expect(split.rest).toHaveLength(3);
  });

  it('reads the key blob of an Ed25519 line and nothing else', () => {
    expect(
      publicKeyBlobOf(
        'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAfuCHKVTjquxvt6CM6tdG4SLp1Btn/nOeHHE5UOzRdf c',
      ),
    ).toHaveLength(51);
    expect(publicKeyBlobOf('ssh-rsa AAAAB3NzaC1yc2E')).toBeNull();
    expect(publicKeyBlobOf('ssh-ed25519 AAAA')).toBeNull();
  });
});

interface AgentHarness {
  readonly agentSocket: string;
  readonly keyDir: string;
  readonly signer: ReturnType<typeof createDeployKeySigner>;
}

/** A shim with an agent socket, a runner holding a fresh ssh-keygen key, and a running child. */
const withAgent = async (
  options: {
    readonly maxSignRequests?: number;
    readonly maxConcurrentCredentials?: number;
    /** Replaces the runner's signer: a test that needs a request to stay in flight. */
    readonly hold?: boolean;
  } = {},
): Promise<AgentHarness & { readonly shim: ReturnType<typeof createRunletShim> }> => {
  const keyDir = await mkdtemp(path.join(tmpdir(), 'wp146k-'));
  const keyFile = path.join(keyDir, 'k');
  await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'fake', '-f', keyFile]);
  const privateKey = await readFile(keyFile, 'utf8');
  const publicKey = (await readFile(`${keyFile}.pub`, 'utf8')).trim();
  // Only the public half stays on disk, so `ssh-keygen -Y sign` must reach the agent to sign.
  await rm(keyFile);

  const volume = await createControlVolume();
  const agentSocket = path.join(volume.dir, 'a.sock');
  const clock = manualClock(1_000);
  const shim = createRunletShim({
    controlSocketPath: volume.controlSocketPath,
    credentialSocketPath: volume.credentialSocketPath,
    sshAgentSocketPath: agentSocket,
    sshPublicKey: publicKey.split(' ').slice(0, 2).join(' '),
    ...(options.maxSignRequests === undefined ? {} : { maxSignRequests: options.maxSignRequests }),
    ...(options.maxConcurrentCredentials === undefined
      ? {}
      : { maxConcurrentCredentials: options.maxConcurrentCredentials }),
    token: TOKEN,
    clock,
  });
  await shim.start();
  const signer = createDeployKeySigner({ privateKey, publicKey });
  const spawn = createRunletSpawn({
    socketPath: volume.controlSocketPath,
    token: TOKEN,
    clock,
    sshSigner: (request) =>
      options.hold === true ? new Promise<Buffer | null>(() => undefined) : signer.sign(request),
  });
  const child = spawn({
    ...nodeScript('setTimeout(() => {}, 60_000)'),
    cwd: process.cwd(),
    env: { PATH: process.env['PATH'] ?? '/usr/bin' },
    signal: new AbortController().signal,
  });
  await new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const poll = (): void => {
      if (shim.childPid !== null) resolve();
      else if (Date.now() - started > 10_000) reject(new Error('the child never started'));
      else setTimeout(poll, 20);
    };
    poll();
  });
  cleanups.push(async () => {
    child.kill('SIGKILL');
    await shim.close();
    await volume.cleanup();
    await rm(keyDir, { recursive: true, force: true });
  });
  return { agentSocket, keyDir, signer, shim };
};

/** One raw sign request on its own connection; resolves with the agent's first reply. */
const signOnce = async (socketPath: string, blob: Buffer, data: Buffer): Promise<Buffer> => {
  const { connect } = await import('node:net');
  const socket = connect(socketPath);
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      socket.once('data', resolve);
      socket.once('error', reject);
      socket.write(
        encodeAgentMessage(
          SSH_AGENTC_SIGN_REQUEST,
          Buffer.concat([sshString(blob), sshString(data), Buffer.alloc(4)]),
        ),
      );
    });
  } finally {
    socket.destroy();
  }
};

const userauthOf = (blob: Buffer): Buffer =>
  Buffer.concat([
    sshString(Buffer.alloc(32, 9)),
    Buffer.from([50]),
    sshString(Buffer.from('git')),
    sshString(Buffer.from('ssh-connection')),
    sshString(Buffer.from('publickey')),
    Buffer.from([1]),
    sshString(Buffer.from('ssh-ed25519')),
    sshString(blob),
  ]);

const blobOf = async (keyDir: string): Promise<Buffer> =>
  Buffer.from(
    (await readFile(path.join(keyDir, 'k.pub'), 'utf8')).trim().split(' ')[1] ?? '',
    'base64',
  );

const sshEnv = (socket: string): NodeJS.ProcessEnv => ({
  PATH: process.env['PATH'] ?? '/usr/bin',
  SSH_AUTH_SOCK: socket,
});

describe('the shim’s agent socket, driven by OpenSSH’s own clients (WP-146)', () => {
  it('lists the run’s one key, and refuses ssh-keygen -Y sign: an SSHSIG over a file is not a login (review round 1)', async () => {
    const harness = await withAgent();
    const listed = await run('ssh-add', ['-L'], { env: sshEnv(harness.agentSocket) });
    const publicLine = (await readFile(path.join(harness.keyDir, 'k.pub'), 'utf8')).trim();
    expect(listed.stdout.trim().split(' ').slice(0, 2)).toEqual(publicLine.split(' ').slice(0, 2));

    const message = path.join(harness.keyDir, 'message');
    await writeFile(message, 'agentic/WP-146 push\n');
    await expect(
      run(
        'ssh-keygen',
        ['-Y', 'sign', '-f', path.join(harness.keyDir, 'k.pub'), '-n', 'git', message],
        {
          env: sshEnv(harness.agentSocket),
        },
      ),
    ).rejects.toBeDefined();
    expect(harness.signer.signatures).toBe(0);
    expect(harness.signer.refusals).toBe(1);
  });

  it('signs an SSH user-authentication request for git through the runner, verifiable with the key', async () => {
    const harness = await withAgent();
    const publicLine = (await readFile(path.join(harness.keyDir, 'k.pub'), 'utf8')).trim();
    const blob = Buffer.from(publicLine.split(' ')[1] ?? '', 'base64');
    const userauth = Buffer.concat([
      sshString(Buffer.alloc(32, 9)),
      Buffer.from([50]),
      sshString(Buffer.from('git')),
      sshString(Buffer.from('ssh-connection')),
      sshString(Buffer.from('publickey')),
      Buffer.from([1]),
      sshString(Buffer.from('ssh-ed25519')),
      sshString(blob),
    ]);
    const { connect } = await import('node:net');
    const socket = connect(harness.agentSocket);
    const reply = await new Promise<Buffer>((resolve, reject) => {
      socket.once('data', resolve);
      socket.once('error', reject);
      socket.write(
        encodeAgentMessage(
          SSH_AGENTC_SIGN_REQUEST,
          Buffer.concat([sshString(blob), sshString(userauth), Buffer.alloc(4)]),
        ),
      );
    });
    socket.destroy();
    expect(reply[4]).toBe(14);
    const signature = reply.subarray(reply.length - 64);
    const key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: blob.subarray(19).toString('base64url') },
      format: 'jwk',
    });
    expect(verify(null, userauth, key, signature)).toBe(true);
    expect(harness.signer.signatures).toBe(1);
  });

  it('refuses ssh-add of another key: the agent adds, removes and locks nothing', async () => {
    const harness = await withAgent();
    const other = path.join(harness.keyDir, 'other');
    await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'other', '-f', other]);
    await expect(
      run('ssh-add', [other], { env: sshEnv(harness.agentSocket) }),
    ).rejects.toMatchObject({ code: 1 });
    await expect(
      run('ssh-add', ['-D'], { env: sshEnv(harness.agentSocket) }),
    ).rejects.toBeDefined();
    const listed = await run('ssh-add', ['-L'], { env: sshEnv(harness.agentSocket) });
    expect(listed.stdout.trim().split('\n')).toHaveLength(1);
    expect(harness.signer.signatures).toBe(0);
  });

  it('answers FAILURE when the runner refuses: another key blob is never signed', async () => {
    const harness = await withAgent();
    const { connect } = await import('node:net');
    const socket = connect(harness.agentSocket);
    const reply = await new Promise<Buffer>((resolve, reject) => {
      socket.once('data', resolve);
      socket.once('error', reject);
      const blob = Buffer.concat([
        sshString(Buffer.from('ssh-ed25519')),
        sshString(Buffer.alloc(32, 7)),
      ]);
      socket.write(
        encodeAgentMessage(
          SSH_AGENTC_SIGN_REQUEST,
          Buffer.concat([sshString(blob), sshString(Buffer.from('data')), Buffer.alloc(4)]),
        ),
      );
    });
    socket.destroy();
    expect(reply.equals(AGENT_FAILURE)).toBe(true);
    expect(harness.signer.signatures).toBe(0);
    expect(harness.signer.refusals).toBe(1);
  });
});

describe('the shim’s agent socket limits (WP-146, review round 1)', () => {
  it('relays at most maxSignRequests per run, then answers FAILURE without asking the runner', async () => {
    const harness = await withAgent({ maxSignRequests: 1 });
    const blob = await blobOf(harness.keyDir);
    expect((await signOnce(harness.agentSocket, blob, userauthOf(blob)))[4]).toBe(14);
    expect(
      (await signOnce(harness.agentSocket, blob, userauthOf(blob))).equals(AGENT_FAILURE),
    ).toBe(true);
    expect(harness.shim.metrics.signRequests).toBe(1);
    expect(harness.shim.metrics.agentRefusals).toBe(1);
    expect(harness.signer.signatures).toBe(1);
  });

  it('answers FAILURE past the in-flight cap while earlier requests wait on the runner', async () => {
    const harness = await withAgent({ maxConcurrentCredentials: 2, hold: true });
    const blob = await blobOf(harness.keyDir);
    const { connect } = await import('node:net');
    const held = [connect(harness.agentSocket)];
    held[0]?.write(
      encodeAgentMessage(
        SSH_AGENTC_SIGN_REQUEST,
        Buffer.concat([sshString(blob), sshString(userauthOf(blob)), Buffer.alloc(4)]),
      ),
    );
    held[0]?.write(
      encodeAgentMessage(
        SSH_AGENTC_SIGN_REQUEST,
        Buffer.concat([sshString(blob), sshString(userauthOf(blob)), Buffer.alloc(4)]),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(
      (await signOnce(harness.agentSocket, blob, userauthOf(blob))).equals(AGENT_FAILURE),
    ).toBe(true);
    expect(harness.shim.metrics.signRequests).toBe(2);
    expect(harness.shim.metrics.agentRefusals).toBe(1);
    for (const socket of held) socket.destroy();
  });
});

describe('the shim’s agent socket configuration (WP-146)', () => {
  it('refuses an agent socket with no Ed25519 key to list, at construction', () => {
    for (const sshPublicKey of [null, 'ssh-rsa AAAAB3NzaC1yc2E', '']) {
      expect(() =>
        createRunletShim({
          controlSocketPath: '/tmp/never-c.sock',
          sshAgentSocketPath: '/tmp/never-a.sock',
          sshPublicKey,
          token: TOKEN,
          clock: manualClock(1_000),
        }),
      ).toThrow(/without an ssh-ed25519 public key/);
    }
  });
});

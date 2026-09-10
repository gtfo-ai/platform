/**
 * Test support for the run shim: a temp control volume, and a **raw** client for the sockets.
 *
 * The raw client is the point. Every refusal in `shim.ts` is a refusal of something a well-behaved
 * peer would never send, so a probe built on the production encoder could not express the input
 * under test — it would be a test of the encoder. {@link RunletProbe.sendRaw} therefore writes the
 * bytes directly: an unknown frame type, a header that is not JSON, a declared length that lies, a
 * `hello` carrying an empty token. That is what standing rule 14 asks for at a wire boundary —
 * probe it the way a JavaScript caller (or an attacker) reaches it, not through the type.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RunletFrame, RunletFrameType } from '@platform/contracts';
import { createFrameDecoder, type DecodedFrame } from './framing.js';

export interface ControlVolume {
  readonly dir: string;
  readonly controlSocketPath: string;
  readonly credentialSocketPath: string;
  cleanup(): Promise<void>;
}

/** A per-run directory, the way TD-025's `ctl` volume gives each run its own sub-directory. */
export const createControlVolume = async (): Promise<ControlVolume> => {
  // macOS `/var/folders/...` paths are long and a Unix socket path is capped at ~104 bytes, so the
  // directory name is kept short deliberately.
  const dir = await mkdtemp(path.join(tmpdir(), 'rl-'));
  return {
    dir,
    controlSocketPath: path.join(dir, 'c.sock'),
    credentialSocketPath: path.join(dir, 'g.sock'),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
};

/** Encodes a frame without validating it — the whole point of a probe. */
export const encodeRawFrame = (header: unknown, payload?: Buffer): Buffer => {
  const head = Buffer.from(JSON.stringify(header), 'utf8');
  const body = payload ?? Buffer.alloc(0);
  const prefix = Buffer.allocUnsafe(8);
  prefix.writeUInt32BE(head.length, 0);
  prefix.writeUInt32BE(body.length, 4);
  return Buffer.concat([prefix, head, body]);
};

/** Encodes a frame whose declared lengths deliberately disagree with the bytes that follow. */
export const encodeLyingFrame = (options: {
  readonly headerLength: number;
  readonly payloadLength: number;
  readonly bytes: Buffer;
}): Buffer => {
  const prefix = Buffer.allocUnsafe(8);
  prefix.writeUInt32BE(options.headerLength, 0);
  prefix.writeUInt32BE(options.payloadLength, 4);
  return Buffer.concat([prefix, options.bytes]);
};

export interface RunletProbe {
  /** Writes arbitrary bytes. Nothing validates them. */
  sendRaw(bytes: Buffer): void;
  /** Writes one frame-shaped object; the object may be invalid. */
  send(header: unknown, payload?: Buffer): void;
  /** Every frame received so far, in order. */
  readonly received: readonly DecodedFrame[];
  /**
   * Resolves with the next frame of `type` **that a previous `next` has not already returned**,
   * or rejects when the socket closes first. The cursor matters: a probe that kept answering with
   * the first `cred.get` would let a test reply twice to one request and never notice.
   */
  next(type: RunletFrameType): Promise<RunletFrame>;
  /** Resolves when the peer closes the socket. */
  readonly closed: Promise<void>;
  /** Stops reading, so the peer's socket buffer fills. This is how backpressure is provoked. */
  pause(): void;
  resume(): void;
  close(): void;
}

/** Wraps either end of an already-open socket. */
export const probeOverSocket = (socket: Socket): RunletProbe => {
  const decoder = createFrameDecoder();
  const received: DecodedFrame[] = [];
  const consumed = new Map<RunletFrameType, number>();
  const waiting: { type: RunletFrameType; resolve: (frame: RunletFrame) => void }[] = [];
  let closed = false;
  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const take = (type: RunletFrameType): RunletFrame | null => {
    const already = consumed.get(type) ?? 0;
    const match = received.filter((decoded) => decoded.frame.type === type)[already];
    if (match === undefined) {
      return null;
    }
    consumed.set(type, already + 1);
    return match.frame;
  };

  socket.on('data', (chunk: Buffer) => {
    for (const decoded of decoder.push(chunk)) {
      received.push(decoded);
      const index = waiting.findIndex((entry) => entry.type === decoded.frame.type);
      if (index >= 0) {
        const [entry] = waiting.splice(index, 1);
        const taken = take(decoded.frame.type);
        if (taken !== null) {
          entry?.resolve(taken);
        }
      }
    }
  });
  socket.on('error', () => {});
  socket.on('close', () => {
    closed = true;
    resolveClosed();
  });

  return {
    received,
    closed: closedPromise,
    sendRaw: (bytes) => {
      socket.write(bytes);
    },
    send: (header, payload) => {
      socket.write(encodeRawFrame(header, payload));
    },
    next: (type) =>
      new Promise<RunletFrame>((resolve, reject) => {
        const already = take(type);
        if (already !== null) {
          resolve(already);
          return;
        }
        if (closed) {
          reject(new Error(`the socket closed before a ${type} frame arrived`));
          return;
        }
        waiting.push({ type, resolve });
        void closedPromise.then(() =>
          reject(new Error(`the socket closed before a ${type} frame arrived`)),
        );
      }),
    pause: () => {
      socket.pause();
    },
    resume: () => {
      socket.resume();
    },
    close: () => {
      socket.destroy();
    },
  };
};

export const connectProbe = async (socketPath: string): Promise<RunletProbe> => {
  const socket: Socket = connect(socketPath);
  const probe = probeOverSocket(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  return probe;
};

export interface RawServer {
  /** Every connection, in order, as a probe-like handle over the *server* side of the socket. */
  readonly peers: readonly RunletProbe[];
  /** Resolves once a peer has connected. */
  peer(index?: number): Promise<RunletProbe>;
  close(): Promise<void>;
}

/**
 * A server that speaks the wire but obeys no state machine — the shim's opposite number for
 * testing the *runner*.
 *
 * The runner's guards are guards against a shim that misbehaves, and a well-behaved shim cannot
 * express the inputs they refuse: an `exit` with no code, a `spawn` arriving in the wrong
 * direction, a `stdout` frame with a lying length. Only a raw server can send those.
 */
export const createRawServer = async (socketPath: string): Promise<RawServer> => {
  const { createServer } = await import('node:net');
  const peers: RunletProbe[] = [];
  const waiting: ((probe: RunletProbe) => void)[] = [];
  const server = createServer((socket) => {
    const probe = probeOverSocket(socket);
    peers.push(probe);
    waiting.shift()?.(probe);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    peers,
    peer: (index = 0) =>
      peers[index] !== undefined
        ? Promise.resolve(peers[index] as RunletProbe)
        : new Promise<RunletProbe>((resolve) => waiting.push(resolve)),
    close: () =>
      new Promise<void>((resolve) => {
        for (const peer of peers) {
          peer.close();
        }
        server.close(() => resolve());
      }),
  };
};

/**
 * A child the shim can start: `node -e <source>`.
 *
 * `process.execPath` is absolute, which is what the `spawn` frame requires — the shim never uses a
 * `PATH` lookup, so a workspace that plants a `claude` on `PATH` changes nothing.
 */
export const nodeScript = (source: string): { command: string; args: string[] } => ({
  command: process.execPath,
  args: ['-e', source],
});

/** Polls a pid until the operating system says it is gone. Structural, with no upper bound. */
export const waitForProcessGone = async (pid: number, timeoutMs = 15_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`process ${pid} was still alive after ${timeoutMs} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** True while the operating system still knows the pid. */
export const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

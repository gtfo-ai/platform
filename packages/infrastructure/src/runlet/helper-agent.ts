/**
 * **A worker's helper agent socket** — TD-031's 2026-11-04 amendment (backlog 693), WP-283.
 *
 * On a remote worker the launcher's mirror and export helpers hold no deploy key (the `relayed`
 * carriage): they run `ssh -o IdentityAgent=<socket>` against a socket the `remote-worker` process
 * serves on the `ctl` volume, **beside** the run's control directory (never inside it — the run
 * container mounts that one). This module is that socket's server, and it is the run shim's agent
 * code path rather than a second implementation: the same codec (`./ssh-agent.ts` —
 * `splitAgentMessages`, `parseAgentRequest`, `encodeIdentitiesAnswer`, `encodeSignResponse`,
 * `AGENT_FAILURE`), the same two requests answered and everything else refused `FAILURE`, and the
 * same rule that the server holds **no key**: `sign` is handed to {@link HelperAgentOptions.sign},
 * which the worker answers by forwarding to the core's `POST runs/:id/ssh-sign` under the run token
 * and epoch. Whether a signature is made — the epoch, the cap, the user-authentication check — is the
 * core's decision (WP-146's oracle, WP-282's counter).
 *
 * It lives for one run, **in a directory of its own** (backlog 708: a helper mounts the socket's
 * whole directory, so a shared one would let one run's helper reach another's): {@link
 * serveHelperAgent} binds the socket and `close` removes both.
 *
 * **Its ownership is what WP-279 measured** (backlog 705): `<uid>:0`, the socket `0660` in a `0750`
 * directory — the export helper runs as uid 1000 (the worker's own) and the mirror helper as root
 * **with no capabilities** (no `DAC_OVERRIDE`), so root reaches it through group 0 and nobody else
 * does. A process that may not give a file to group 0 (`EPERM`: it is not in that group —
 * `compose.worker.yml` adds the `remote-worker` to it) falls back to the same bits for *other*
 * (`0751`/`0666`) and says so through {@link HelperAgentOptions.onRefusal}: root-without-capabilities
 * reaches it either way, and only the helper that mounts this one directory can see it at all.
 */
import { chmod, chown, mkdir, rm } from 'node:fs/promises';
import { connect, createServer, type Server, type Socket } from 'node:net';
import path from 'node:path';
import { parseHelperAgentSocket } from '@platform/contracts';
import {
  AGENT_FAILURE,
  encodeIdentitiesAnswer,
  encodeSignResponse,
  parseAgentRequest,
  publicKeyBlobOf,
  splitAgentMessages,
} from './ssh-agent.js';

/** At most this many connections at once — a mirror fetch and an export are one each. */
export const MAX_HELPER_AGENT_CONNECTIONS = 8;

export interface HelperAgentOptions {
  /** The `ctl` volume's root as this process mounts it (`APP_WORKSPACE_CONTROL_ROOT`). */
  readonly controlRoot: string;
  /** `<directory>/<name>.sock`, relative to the control root (`helperAgentSocketSchema`). */
  readonly socket: string;
  /** The run's public key line (`ssh-ed25519 AAAA…`), the one identity listed. */
  readonly publicKey: string;
  /** The signature, or `null` refused. Never throws to mean "no": a throw is answered `FAILURE`. */
  readonly sign: (request: {
    readonly keyBlob: Buffer;
    readonly data: Buffer;
    readonly flags: number;
  }) => Promise<Buffer | null>;
  readonly onRefusal?: (why: string) => void;
}

export interface HelperAgent {
  /** The socket's absolute path on this process' filesystem. */
  readonly path: string;
  /** How many sign requests were answered with a signature / refused. */
  readonly signatures: () => number;
  readonly refusals: () => number;
  close(): Promise<void>;
}

/**
 * What `ssh` does with an agent, reduced to what a test (and the fake workspace provider) needs:
 * list the identities, then ask the first one to sign `data`. Answers the key blob and the signature,
 * or `null` for a `FAILURE`. One connection, closed after.
 */
export const signThroughAgent = async (input: {
  readonly socketPath: string;
  /** What to sign — or a function of the listed key, as an SSH user-authentication blob embeds it. */
  readonly data: Buffer | ((keyBlob: Buffer) => Buffer);
  readonly timeoutMs?: number;
}): Promise<{ readonly keyBlob: Buffer; readonly signature: Buffer } | null> => {
  return new Promise((resolve, reject) => {
    const socket = connect(input.socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('the agent did not answer in time'));
    }, input.timeoutMs ?? 30_000);
    let buffered: Buffer = Buffer.alloc(0);
    let keyBlob: Buffer | null = null;
    const finish = (value: { keyBlob: Buffer; signature: Buffer } | null): void => {
      clearTimeout(timer);
      socket.end();
      resolve(value);
    };
    const readString = (body: Buffer, at: number): [Buffer, number] => {
      const length = body.readUInt32BE(at);
      return [body.subarray(at + 4, at + 4 + length), at + 4 + length];
    };
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4 && buffered.length >= 4 + buffered.readUInt32BE(0)) {
        const length = buffered.readUInt32BE(0);
        const message = buffered.subarray(4, 4 + length);
        buffered = buffered.subarray(4 + length);
        const type = message[0];
        if (type === 12 && keyBlob === null) {
          if (message.readUInt32BE(1) < 1) return finish(null);
          [keyBlob] = readString(message, 5);
          const blob = keyBlob;
          const data = typeof input.data === 'function' ? input.data(blob) : input.data;
          const u32 = (value: number): Buffer => {
            const out = Buffer.alloc(4);
            out.writeUInt32BE(value, 0);
            return out;
          };
          const body = Buffer.concat([
            Buffer.from([13]),
            u32(blob.length),
            blob,
            u32(data.length),
            data,
            u32(0),
          ]);
          socket.write(Buffer.concat([u32(body.length), body]));
        } else if (type === 14 && keyBlob !== null) {
          const [signature] = readString(message, 1);
          return finish({ keyBlob, signature: Buffer.from(signature) });
        } else {
          return finish(null);
        }
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on('connect', () => {
      socket.write(Buffer.from([0, 0, 0, 1, 11]));
    });
  });
};

export const serveHelperAgent = async (options: HelperAgentOptions): Promise<HelperAgent> => {
  const parts = parseHelperAgentSocket(options.socket);
  if (parts === null) {
    throw new Error(`not a helper agent socket path: ${options.socket}`);
  }
  const keyBlob = publicKeyBlobOf(options.publicKey);
  if (keyBlob === null) {
    throw new Error('the helper agent needs the run’s ssh-ed25519 public key to list');
  }
  const directory = path.join(options.controlRoot, parts.directory);
  const socketPath = path.join(directory, parts.file);
  await mkdir(directory, { recursive: true, mode: 0o750 });
  await rm(socketPath, { force: true });
  let signatures = 0;
  let refusals = 0;
  const sockets = new Set<Socket>();
  const refuse = (socket: Socket, why: string): void => {
    refusals += 1;
    options.onRefusal?.(why);
    if (!socket.destroyed) socket.write(AGENT_FAILURE);
  };
  const server: Server = createServer((socket) => {
    if (sockets.size >= MAX_HELPER_AGENT_CONNECTIONS) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    let buffered: Buffer = Buffer.alloc(0);
    // One request at a time per connection, in order: ssh waits for each answer anyway.
    let tail: Promise<void> = Promise.resolve();
    socket.on('data', (chunk: Buffer) => {
      let messages: readonly Buffer[];
      try {
        const split = splitAgentMessages(Buffer.concat([buffered, chunk]));
        buffered = Buffer.from(split.rest);
        messages = split.messages;
      } catch (error) {
        refusals += 1;
        options.onRefusal?.((error as Error).message);
        socket.destroy();
        return;
      }
      for (const message of messages) {
        tail = tail.then(async () => {
          let request: ReturnType<typeof parseAgentRequest>;
          try {
            request = parseAgentRequest(message);
          } catch (error) {
            refusals += 1;
            options.onRefusal?.((error as Error).message);
            socket.destroy();
            return;
          }
          if (request.kind === 'refused') {
            refuse(socket, `message type ${request.type} is not one of the two this agent answers`);
            return;
          }
          if (request.kind === 'identities') {
            if (!socket.destroyed) {
              socket.write(encodeIdentitiesAnswer(keyBlob, 'agentic deploy key (relayed)'));
            }
            return;
          }
          let signature: Buffer | null;
          try {
            signature = await options.sign({
              keyBlob: request.keyBlob,
              data: request.data,
              flags: request.flags,
            });
          } catch (error) {
            refuse(socket, `the core could not be asked: ${(error as Error).message}`);
            return;
          }
          if (signature === null) {
            refuse(socket, 'the core refused the signature');
            return;
          }
          signatures += 1;
          if (!socket.destroyed) socket.write(encodeSignResponse(signature));
        });
      }
    });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  try {
    await chown(directory, -1, 0);
    await chown(socketPath, -1, 0);
    await chmod(directory, 0o750);
    await chmod(socketPath, 0o660);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    options.onRefusal?.(
      'this process may not give the helper socket to group 0, so it is open to other instead (backlog 705)',
    );
    await chmod(directory, 0o751);
    await chmod(socketPath, 0o666);
  }
  return {
    path: socketPath,
    signatures: () => signatures,
    refusals: () => refusals,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
};

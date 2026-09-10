/**
 * The runner side of TD-025: a `SpawnedProcess` backed by the run shim's control socket.
 *
 * `Options.spawnClaudeCodeProcess` is the SDK's documented seam "to run Claude Code in VMs,
 * containers, or remote environments". WP-12 implemented the *test* one
 * (`runner/fake-spawn.ts`); this is the production one. The SDK still owns the NDJSON protocol on
 * the streams — we own the transport, and to the SDK the result is indistinguishable from a local
 * `ChildProcess`: `stdin` is a `Writable`, `stdout` is a `Readable`, `kill()` takes a signal,
 * `exitCode` is a number or `null`, and `exit`/`error` fire once.
 *
 * ## The producer on the other end is untrusted (BD-022)
 *
 * The shim is a binary the platform ships and does not control, and the bytes it forwards were
 * written by the model's tools. Everything crossing this seam is therefore data:
 *
 *  - every frame is validated by the shared schema before it is looked at, and then again against
 *    this side's **accept-list**: a `spawn`, a `stdin` or a `cred.reply` arriving *here* is a
 *    protocol error, because those are frames only the runner sends;
 *  - an `exit` without a code does not parse, and a transport that dies without an `exit` frame at
 *    all reports `exitCode: null` with an `error` — never `0` (standing rule 16). WP-12's budget
 *    watchdog reads `total_cost_usd` off a `result` line that arrives through *this* stream, and
 *    the review that found it fail open named this adapter as the producer;
 *  - `spawn.ok.pid` is namespace-local and is used for logging only. `kill()` sends a `signal`
 *    frame; it never touches a pid.
 *
 * ## Credentials
 *
 * `cred.get` arrives from the workspace, relayed by the shim. The decision is made **here**, on the
 * platform side of the volume: {@link RunletCredentialResponder} answers, and the default one is an
 * allow-list. Everything it does not recognise is answered `credential: null` — a refusal is a
 * normal answer on this wire, so a refused host is indistinguishable from an unconfigured one.
 */

import { EventEmitter } from 'node:events';
import { connect, type Socket } from 'node:net';
import { Readable, Writable } from 'node:stream';
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { type Logger, type RunnerClock, silentLogger } from '@platform/application';
import type { RunletFrame, RunletSignal } from '@platform/contracts';
import { RUNLET_PROTOCOL_VERSION, runletFrameSchema } from '@platform/contracts';
import { createFrameConnection, type FrameConnection } from './connection.js';
import { RunletProtocolError } from './framing.js';

/** What the runner is willing to hand a workspace that asks. Never logged, never persisted. */
export interface RunletCredential {
  readonly username: string;
  readonly password: string;
}

/** Answers a `cred.get`. `null` means "no credential for that host" — the fail-closed answer. */
export type RunletCredentialResponder = (request: {
  readonly host: string;
}) => Promise<RunletCredential | null>;

/** Frames a runner may receive. Anything else is a protocol error even though it parses. */
const RUNNER_ACCEPTS: readonly RunletFrame['type'][] = [
  'hello.ok',
  'spawn.ok',
  'stdout',
  'stderr',
  'exit',
  'cred.get',
  'pong',
  'fatal',
];

export interface RunletSpawnOptions {
  /** `/run/agentic/ctl/<run-id>/ctl.sock` in TD-025's layout. */
  readonly socketPath: string;
  /** The run token the launcher gave both sides. Empty or blank is refused by the shim. */
  readonly token: string;
  readonly clock: RunnerClock;
  readonly logger?: Logger;
  /** Where `stderr` frames go. The runner passes the SDK's `stderr` callback, which redacts. */
  readonly onStderr?: (chunk: string) => void;
  readonly credentials?: RunletCredentialResponder;
  /** How long the handshake may take before the transport reports an error. */
  readonly connectTimeoutMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

/**
 * An allow-list responder.
 *
 * Standing rule 31 in the other direction: the *host list* is required, and an empty one is a
 * responder that answers `null` to everything rather than one that answers everything.
 */
export const createAllowListCredentialResponder = (options: {
  readonly allowedHosts: readonly string[];
  readonly credential: (host: string) => Promise<RunletCredential | null>;
  readonly logger?: Logger;
}): RunletCredentialResponder => {
  const logger = options.logger ?? silentLogger;
  const allowed = new Set(options.allowedHosts.map((host) => host.toLowerCase()));
  return async ({ host }) => {
    if (!allowed.has(host)) {
      logger.warn({ host }, 'runlet refused a credential for a host outside the run allow-list');
      return null;
    }
    try {
      return await options.credential(host);
    } catch (error) {
      // A broker that failed is not a broker that said yes.
      logger.error({ host, err: error }, 'runlet credential lookup failed');
      return null;
    }
  };
};

interface TransportState {
  connection: FrameConnection | null;
  exited: boolean;
}

export const createRunletSpawn = (
  options: RunletSpawnOptions,
): ((spawnOptions: SpawnOptions) => SpawnedProcess) => {
  const logger = options.logger ?? silentLogger;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

  return (spawnOptions: SpawnOptions): SpawnedProcess => {
    const events = new EventEmitter();
    const state: TransportState = { connection: null, exited: false };
    let exitCode: number | null = null;
    let signalCode: NodeJS.Signals | null = null;
    let killed = false;
    let handshaken = false;
    /** stdin the SDK wrote before the socket was up. Bounded by the SDK's own prompt size. */
    const queued: { chunk: Buffer | null }[] = [];

    const fail = (error: Error): void => {
      if (state.exited) {
        return;
      }
      logger.error({ err: error }, 'runlet transport failed');
      events.emit('error', error);
      // Fail closed: a transport that died without an `exit` frame has *no* exit status. Reporting
      // `0` here is the defect standing rule 16 names, one layer below where WP-12 found it.
      finish(null, null);
    };

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (state.exited) {
        return;
      }
      state.exited = true;
      exitCode = code;
      signalCode = signal;
      stdout.push(null);
      cancelConnectTimeout?.();
      state.connection?.close();
      events.emit('exit', code, signal);
    };

    const stdout = new Readable({
      read: () => {
        state.connection?.resume();
      },
    });

    /**
     * The gate is the *handshake*, not the socket.
     *
     * The SDK writes its first prompt as soon as `query()` runs, which is well before `hello.ok`
     * comes back — and a socket that is merely `connect`ing already buffers writes, so sending on
     * it would put a `stdin` frame ahead of `hello` on the wire and the shim would refuse the
     * connection for talking before it authenticated. Found exactly that way.
     */
    const stdin = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        const connection = state.connection;
        if (connection === null || !handshaken) {
          queued.push({ chunk });
          callback();
          return;
        }
        connection.send({ type: 'stdin' }, chunk);
        callback();
      },
      final: (callback) => {
        const connection = state.connection;
        if (connection === null || !handshaken) {
          queued.push({ chunk: null });
        } else {
          connection.send({ type: 'stdin.end' });
        }
        callback();
      },
    });

    const flushQueued = (connection: FrameConnection): void => {
      for (const entry of queued) {
        if (entry.chunk === null) {
          connection.send({ type: 'stdin.end' });
        } else {
          connection.send({ type: 'stdin' }, entry.chunk);
        }
      }
      queued.length = 0;
    };

    const answerCredential = (requestId: string, host: string): void => {
      const responder = options.credentials;
      const reply = (credential: RunletCredential | null): void => {
        state.connection?.send({ type: 'cred.reply', request_id: requestId, credential });
      };
      if (responder === undefined) {
        logger.warn({ host }, 'runlet has no credential responder; refusing');
        reply(null);
        return;
      }
      // `Promise.resolve().then(…)` rather than `responder(…)`: a responder that throws
      // *synchronously* would otherwise take the whole control connection down with it, turning a
      // broken credential broker into a failed run.
      Promise.resolve()
        .then(() => responder({ host }))
        .then(reply)
        .catch((error: unknown) => {
          logger.error({ host, err: error }, 'runlet credential responder threw');
          reply(null);
        });
    };

    const onFrame = (frame: RunletFrame, payload: Buffer | null): void => {
      if (!RUNNER_ACCEPTS.includes(frame.type)) {
        throw new RunletProtocolError(
          `a ${frame.type} frame arrived at the runner, which only the runner sends`,
          'unexpected_frame',
        );
      }
      switch (frame.type) {
        case 'hello.ok': {
          if (frame.protocol !== RUNLET_PROTOCOL_VERSION) {
            throw new RunletProtocolError(
              `the shim speaks protocol ${frame.protocol}`,
              'protocol_error',
            );
          }
          handshaken = true;
          cancelConnectTimeout?.();
          const connection = state.connection;
          if (connection === null) {
            return;
          }
          // The `spawn` frame is re-validated here rather than trusted: `env` comes from the SDK
          // and an env name carrying `=` would otherwise reach `execve` inside the container.
          const spawnFrame = runletFrameSchema.parse({
            type: 'spawn',
            command: spawnOptions.command,
            args: [...spawnOptions.args],
            cwd: spawnOptions.cwd ?? '/',
            env: Object.fromEntries(
              Object.entries(spawnOptions.env).filter(
                (entry): entry is [string, string] => entry[1] !== undefined,
              ),
            ),
          });
          connection.send(spawnFrame);
          flushQueued(connection);
          return;
        }
        case 'spawn.ok':
          // Namespace-local; for the log line and nothing else.
          logger.info({ container_pid: frame.pid }, 'runlet child started');
          return;
        case 'stdout': {
          if (!stdout.push(payload)) {
            state.connection?.pause();
          }
          return;
        }
        case 'stderr':
          options.onStderr?.((payload as Buffer).toString('utf8'));
          return;
        case 'exit':
          finish(frame.code, frame.signal as NodeJS.Signals | null);
          return;
        case 'cred.get':
          answerCredential(frame.request_id, frame.host);
          return;
        case 'pong':
          return;
        case 'fatal':
          // The shim's own words, and they are attacker-influenced text on their way to a log:
          // carried as data on an Error, never interpolated into a decision.
          throw new RunletProtocolError(
            `the shim refused the connection: ${frame.reason}`,
            frame.reason,
          );
        default:
          return;
      }
    };

    let cancelConnectTimeout: (() => void) | null = null;
    let socket: Socket;
    try {
      socket = connect(options.socketPath);
    } catch (error) {
      queueMicrotask(() => fail(error instanceof Error ? error : new Error(String(error))));
      return spawnedProcess();
    }

    cancelConnectTimeout = options.clock.setTimer(connectTimeoutMs, () => {
      if (!handshaken) {
        fail(
          new RunletProtocolError('the run shim did not answer the handshake', 'protocol_error'),
        );
      }
    });

    socket.on('connect', () => {
      state.connection?.send({
        type: 'hello',
        protocol: RUNLET_PROTOCOL_VERSION,
        token: options.token,
      });
    });

    state.connection = createFrameConnection(socket, {
      onFrame: (decoded) => onFrame(decoded.frame, decoded.payload),
      onError: (error) => fail(error),
      onClose: () => {
        if (!state.exited) {
          fail(new RunletProtocolError('the run shim closed the control connection'));
        }
      },
      onDrain: () => {},
    });

    function spawnedProcess(): SpawnedProcess {
      const process_: SpawnedProcess = {
        stdin,
        stdout,
        get killed() {
          return killed;
        },
        get exitCode() {
          return exitCode;
        },
        get signalCode() {
          return signalCode;
        },
        kill: (signal: NodeJS.Signals) => {
          killed = true;
          const parsed = runletFrameSchema.safeParse({ type: 'signal', name: signal });
          if (!parsed.success) {
            logger.warn({ signal }, 'runlet will not relay this signal');
            return false;
          }
          return state.connection?.send(parsed.data) ?? false;
        },
        on: (event: 'exit' | 'error', listener: (...args: never[]) => void) => {
          events.on(event, listener as (...args: unknown[]) => void);
        },
        once: (event: 'exit' | 'error', listener: (...args: never[]) => void) => {
          events.once(event, listener as (...args: unknown[]) => void);
        },
        off: (event: 'exit' | 'error', listener: (...args: never[]) => void) => {
          events.off(event, listener as (...args: unknown[]) => void);
        },
      } as SpawnedProcess;
      return process_;
    }

    // technical/04: "the SDK teardown signal maps to `signal{SIGTERM}` and then container stop".
    // The container half is the launcher's (WP-14); this is the half that lives on the socket.
    spawnOptions.signal.addEventListener(
      'abort',
      () => {
        if (!state.exited) {
          const signal: RunletSignal = 'SIGTERM';
          state.connection?.send({ type: 'signal', name: signal });
        }
      },
      { once: true },
    );

    // An `error` with no listener throws out of the emitter; the SDK attaches one, but a caller
    // that does not must not crash the process on a transport failure.
    events.on('error', () => {});

    return spawnedProcess();
  };
};

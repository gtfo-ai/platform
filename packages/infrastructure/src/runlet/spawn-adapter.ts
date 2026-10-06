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

/**
 * Answers a `cred.get`. `null` means "no credential for that host and repository" — the
 * fail-closed answer. `path` is git's own (backlog 481): `null` when git sent none, which the
 * production responder (`RunCredentialBroker.answer`, through the provisioner) refuses.
 */
export type RunletCredentialResponder = (request: {
  readonly host: string;
  readonly path: string | null;
}) => Promise<RunletCredential | null>;

/** Signs for a deploy-key run. `null` is a refusal: another key, the budget spent, a run that ended. */
export type RunletSshSigner = (request: {
  readonly keyBlob: Buffer;
  readonly data: Buffer;
  readonly flags: number;
}) => Promise<Buffer | null>;

/** Frames a runner may receive. Anything else is a protocol error even though it parses. */
const RUNNER_ACCEPTS: readonly RunletFrame['type'][] = [
  'hello.ok',
  'spawn.ok',
  'stdout',
  'stderr',
  'exit',
  'cred.get',
  'ssh.sign',
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
  /**
   * Where `stderr` frames go **until** {@link RunletSpawn.setStderrSink} replaces it. A test or a
   * diagnostic script passes one here; production does not, because the spawn is built in the
   * provisioner before the runner — and its per-run redactor — exists. The runner sets its sink on
   * the returned spawn instead (WP-127, PROGRESS backlog 344).
   */
  readonly onStderr?: RunletStderrSink;
  readonly credentials?: RunletCredentialResponder;
  /**
   * Answers an `ssh.sign` relayed from a deploy-key run's agent socket (WP-146, TD-028 decision 13b):
   * the SSH signature blob, or `null`. Absent, every sign request is refused — the run has no key.
   */
  readonly sshSigner?: RunletSshSigner;
  /** How long the handshake may take before the transport reports an error. */
  readonly connectTimeoutMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

/** Receives the CLI's stderr, one frame's payload at a time, as UTF-8. */
export type RunletStderrSink = (chunk: string) => void;

/**
 * How far a transport got when it ended **before the `spawn` frame was sent** (WP-150) — the step
 * a run that never asked for its CLI reached, so the runner can name it in the start failure.
 *
 *  - `connection_lost`: the socket could not be opened, or closed or failed before the spawn;
 *  - `handshake_timeout`: no `hello.ok` within the connect timeout;
 *  - `handshake_refused`: the shim's `fatal` frame, or a `hello.ok` for another protocol;
 *  - `spawn_refused`: the gate's `beforeSpawn` refused, so no `spawn` was sent.
 */
export type RunletPreSpawnStep =
  | 'connection_lost'
  | 'handshake_timeout'
  | 'handshake_refused'
  | 'spawn_refused';

/**
 * The runner's say over the one frame that starts a CLI (WP-150, BD-010's 2026-10-06 amendment).
 *
 * The adapter stays free of the database: the runner composes `beforeSpawn` over the run's
 * `RunStartHooks.beforeCliSpawn`, which commits the CLI spawn marker. It is awaited **after**
 * `hello.ok` — so the shim has accepted the connection — and **before** the `spawn` frame; a
 * rejection sends no `spawn` and fails the transport. stdin the SDK writes meanwhile stays queued
 * until the `spawn` frame is on the wire.
 */
export interface RunletSpawnGate {
  readonly beforeSpawn: () => Promise<void>;
  /** Told once, when the transport ends before a `spawn` frame was sent, with the step it reached. */
  readonly failedBeforeSpawn: (step: RunletPreSpawnStep) => void;
}

/**
 * The spawn, and the seam its stderr leaves through (WP-127, PROGRESS backlog 344).
 *
 * The SDK attaches its own `stderr` callback only to a process it spawns itself (0.3.267's
 * `sdk.mjs`: `stderr.on("data", …)` and the exit error's stderr tail are on the local-spawn path),
 * and the `SpawnedProcess` interface has no stderr stream, so a frame the shim forwards reaches
 * whatever is set here and nothing else. The runner sets it with its per-run redactor
 * (`claude-runner.ts`, `createStderrLog`); until it does, frames go to the `onStderr` option, and
 * with neither they are dropped — the state every containerised run was in before WP-127.
 */
export type RunletSpawn = ((spawnOptions: SpawnOptions) => SpawnedProcess) & {
  /** Replaces the stderr sink for every process this spawn starts from now on; `null` drops. */
  readonly setStderrSink: (sink: RunletStderrSink | null) => void;
  /**
   * Sets the gate every process this spawn starts from now on passes before its `spawn` frame
   * (WP-150); `null` removes it, and with none the frame is sent at `hello.ok` as before.
   */
  readonly setSpawnGate: (gate: RunletSpawnGate | null) => void;
};

/**
 * An allow-list responder.
 *
 * Standing rule 31 in the other direction: the *host list* is required, and an empty one is a
 * responder that answers `null` to everything rather than one that answers everything.
 *
 * It gates the **host** only and hands the repository `path` to `credential`, whose question it
 * then is. Production does not compose this: the provisioner answers through
 * `RunCredentialBroker.answer`, which decides the host and the path (backlog 481).
 */
export const createAllowListCredentialResponder = (options: {
  readonly allowedHosts: readonly string[];
  readonly credential: (host: string, path: string | null) => Promise<RunletCredential | null>;
  readonly logger?: Logger;
}): RunletCredentialResponder => {
  const logger = options.logger ?? silentLogger;
  const allowed = new Set(options.allowedHosts.map((host) => host.toLowerCase()));
  return async ({ host, path }) => {
    if (!allowed.has(host)) {
      logger.warn({ host }, 'runlet refused a credential for a host outside the run allow-list');
      return null;
    }
    try {
      return await options.credential(host, path);
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

export const createRunletSpawn = (options: RunletSpawnOptions): RunletSpawn => {
  const logger = options.logger ?? silentLogger;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  let stderrSink: RunletStderrSink | null = options.onStderr ?? null;
  let spawnGate: RunletSpawnGate | null = null;

  const spawn = (spawnOptions: SpawnOptions): SpawnedProcess => {
    const events = new EventEmitter();
    const state: TransportState = { connection: null, exited: false };
    let exitCode: number | null = null;
    let signalCode: NodeJS.Signals | null = null;
    let killed = false;
    let handshaken = false;
    /** The `spawn` frame is on the wire: stdin flows and a failure is the CLI's, not the start's. */
    let spawnSent = false;
    /** The gate this process was started under — read once, so a later `setSpawnGate` cannot swap it. */
    const gate = spawnGate;
    /** Set where the failure is known to be one of {@link RunletPreSpawnStep}'s named steps. */
    let preSpawnStep: RunletPreSpawnStep | null = null;
    /** stdin the SDK wrote before the `spawn` frame. Bounded by the SDK's own prompt size. */
    const queued: { chunk: Buffer | null }[] = [];

    const fail = (error: Error): void => {
      if (state.exited) {
        return;
      }
      if (!spawnSent) {
        gate?.failedBeforeSpawn(preSpawnStep ?? 'connection_lost');
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
        if (connection === null || !spawnSent) {
          queued.push({ chunk });
          callback();
          return;
        }
        connection.send({ type: 'stdin' }, chunk);
        callback();
      },
      final: (callback) => {
        const connection = state.connection;
        if (connection === null || !spawnSent) {
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

    const answerCredential = (requestId: string, host: string, path: string | null): void => {
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
        .then(() => responder({ host, path }))
        .then(reply)
        .catch((error: unknown) => {
          logger.error({ host, err: error }, 'runlet credential responder threw');
          reply(null);
        });
    };

    const answerSign = (frame: Extract<RunletFrame, { type: 'ssh.sign' }>): void => {
      const reply = (signature: Buffer | null): void => {
        state.connection?.send({
          type: 'ssh.sign.reply',
          request_id: frame.request_id,
          signature: signature === null ? null : signature.toString('base64'),
        });
      };
      const signer = options.sshSigner;
      if (signer === undefined) {
        logger.warn({}, 'runlet has no ssh signer; refusing a sign request');
        reply(null);
        return;
      }
      // As `answerCredential`: a signer that throws is a refusal, never a dropped connection. The
      // data and the signature are never logged (decision 13b: counted, not logged with content).
      Promise.resolve()
        .then(() =>
          signer({
            keyBlob: Buffer.from(frame.key_blob, 'base64'),
            data: Buffer.from(frame.data, 'base64'),
            flags: frame.flags,
          }),
        )
        .then(reply)
        .catch((error: unknown) => {
          logger.error({ err: error }, 'runlet ssh signer threw');
          reply(null);
        });
    };

    /**
     * The gate, then the frame (WP-150). The gate's own failure is `spawn_refused`; a transport
     * that ended while the gate was deciding, or a stop that arrived meanwhile, sends nothing.
     */
    const sendSpawn = async (spawnFrame: RunletFrame): Promise<void> => {
      if (gate !== null) {
        try {
          await gate.beforeSpawn();
        } catch (error) {
          preSpawnStep = 'spawn_refused';
          fail(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }
      const connection = state.connection;
      // `killed`: a `kill()` while the gate decided is a process its caller already gave up on, and
      // a `spawn` now would start a CLI nobody waits for (review round 1).
      if (state.exited || spawnOptions.signal.aborted || killed || connection === null) {
        return;
      }
      connection.send(spawnFrame);
      spawnSent = true;
      flushQueued(connection);
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
            preSpawnStep = 'handshake_refused';
            throw new RunletProtocolError(
              `the shim speaks protocol ${frame.protocol}`,
              'protocol_error',
            );
          }
          handshaken = true;
          cancelConnectTimeout?.();
          if (state.connection === null) {
            return;
          }
          // The `spawn` frame is re-validated here rather than trusted: `env` comes from the SDK
          // and an env name carrying `=` would otherwise reach `execve` inside the container. It is
          // built **before** the gate, so a frame this side refuses records no marker (WP-150).
          const parsed = runletFrameSchema.safeParse({
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
          if (!parsed.success) {
            preSpawnStep = 'spawn_refused';
            throw parsed.error;
          }
          void sendSpawn(parsed.data);
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
          stderrSink?.((payload as Buffer).toString('utf8'));
          return;
        case 'exit':
          finish(frame.code, frame.signal as NodeJS.Signals | null);
          return;
        case 'cred.get':
          answerCredential(frame.request_id, frame.host, frame.path);
          return;
        case 'ssh.sign':
          answerSign(frame);
          return;
        case 'pong':
          return;
        case 'fatal':
          if (!handshaken) {
            preSpawnStep = 'handshake_refused';
          }
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
        preSpawnStep = 'handshake_timeout';
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
          if (!spawnSent) {
            // No child yet (WP-150): nothing to signal, and `sendSpawn` reads `killed` after its
            // gate, so none will be started. The process ends here, as the abort's does.
            finish(null, signal);
            return true;
          }
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
        if (state.exited) {
          return;
        }
        if (!spawnSent) {
          // No child to signal (WP-150): the teardown is the transport's own, and no `spawn` frame
          // follows — `sendSpawn` reads the aborted signal after its gate.
          finish(null, null);
          return;
        }
        const signal: RunletSignal = 'SIGTERM';
        state.connection?.send({ type: 'signal', name: signal });
      },
      { once: true },
    );

    // An `error` with no listener throws out of the emitter; the SDK attaches one, but a caller
    // that does not must not crash the process on a transport failure.
    events.on('error', () => {});

    return spawnedProcess();
  };
  return Object.assign(spawn, {
    setStderrSink: (sink: RunletStderrSink | null): void => {
      stderrSink = sink;
    },
    setSpawnGate: (next: RunletSpawnGate | null): void => {
      spawnGate = next;
    },
  });
};

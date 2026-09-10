/**
 * The workspace side of `cred.get`: a git credential helper that asks the shim (TD-025 §3).
 *
 * technical/05 § "Credentials and identity": *"the workspace's credential helper requests it
 * through the run shim (`cred.get`) over the control socket only while the run is active"*. Git
 * invokes a helper as `<helper> get`, writes `key=value` lines and a blank line to its stdin, and
 * reads `username=` / `password=` back. Everything else it can ask for — `store`, `erase` — is a
 * no-op here: the platform mints and revokes the token (BD-025), and a workspace that could *store*
 * a credential would have somewhere to leave one behind after the run.
 *
 * Two refusals happen before a byte reaches the socket, and both are cheaper to make here than to
 * explain later:
 *
 *  - **anything but `https`**. A helper invoked for `http://` returns nothing. `cred.get` has no
 *    representation for cleartext, so this is belt and braces rather than the only guard.
 *  - **a host with a port, userinfo, path or uppercase**. The host is lowercased (so one host has
 *    one spelling on the runner's allow-list) and then must satisfy the wire's own host rule; the
 *    port is refused rather than stripped, because dropping `:8443` would ask for — and possibly
 *    receive — the credential of a *different* endpoint.
 *
 * Git's protocol is text on stdin from a process the agent can also run directly. It is parsed as
 * data: unknown keys are ignored, a key is never turned into a decision, and the answer only ever
 * contains the two lines git expects.
 */
import { connect } from 'node:net';
import type { RunnerClock } from '@platform/application';
import { runletHostSchema } from '@platform/contracts';
import { systemClock } from '../runner/clock.js';
import { createFrameConnection } from './connection.js';
import { RunletProtocolError } from './framing.js';

export interface CredentialAnswer {
  readonly username: string;
  readonly password: string;
}

/** Parses git's `key=value` block. Later keys win, which is what git itself does. */
export const parseCredentialRequest = (input: string): Record<string, string> => {
  const fields: Record<string, string> = {};
  for (const line of input.split('\n')) {
    if (line.length === 0) {
      continue;
    }
    const at = line.indexOf('=');
    if (at <= 0) {
      continue;
    }
    fields[line.slice(0, at)] = line.slice(at + 1).replace(/\r$/, '');
  }
  return fields;
};

/** The host git asked about, normalised, or `null` when this helper must not answer. */
export const credentialHost = (fields: Record<string, string>): string | null => {
  if (fields['protocol'] !== 'https') {
    return null;
  }
  const host = (fields['host'] ?? '').toLowerCase();
  return runletHostSchema.safeParse(host).success ? host : null;
};

export interface CredentialRequestOptions {
  readonly socketPath: string;
  readonly host: string;
  /** How long to wait for an answer. Measured on {@link CredentialRequestOptions.clock}. */
  readonly timeoutMs?: number;
  /** Injected so the timeout is a property of the code and not of the machine (rule 2). */
  readonly clock?: RunnerClock;
}

/** One request/response on the credential socket. Resolves `null` for every refusal. */
export const requestCredential = async (
  options: CredentialRequestOptions,
): Promise<CredentialAnswer | null> => {
  const host = options.host.toLowerCase();
  if (!runletHostSchema.safeParse(host).success) {
    return null;
  }
  return await new Promise<CredentialAnswer | null>((resolve) => {
    const socket = connect(options.socketPath);
    let settled = false;
    const clock = options.clock ?? systemClock;
    const cancelTimeout = clock.setTimer(options.timeoutMs ?? 30_000, () => settle(null));

    const settle = (answer: CredentialAnswer | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      cancelTimeout();
      connection.close();
      resolve(answer);
    };

    const connection = createFrameConnection(socket, {
      onFrame: ({ frame }) => {
        if (frame.type === 'cred.reply') {
          settle(frame.credential);
          return;
        }
        if (frame.type === 'fatal') {
          settle(null);
          return;
        }
        throw new RunletProtocolError(`the shim answered a ${frame.type} frame`);
      },
      onError: () => settle(null),
      onClose: () => settle(null),
    });

    socket.on('connect', () => {
      connection.send({ type: 'cred.get', request_id: 'git-1', host, protocol: 'https' });
    });
  });
};

export interface CredentialHelperIo {
  readonly argv: readonly string[];
  readonly stdin: string;
  readonly socketPath: string;
  readonly timeoutMs?: number;
  readonly clock?: RunnerClock;
}

/** The whole helper as a pure-ish function: git's input in, git's output out. */
export const runCredentialHelper = async (io: CredentialHelperIo): Promise<string> => {
  const operation = io.argv[0];
  if (operation !== 'get') {
    // `store` and `erase` are answered with silence, which git reads as "handled, nothing to say".
    return '';
  }
  const host = credentialHost(parseCredentialRequest(io.stdin));
  if (host === null) {
    return '';
  }
  const answer = await requestCredential({
    socketPath: io.socketPath,
    host,
    ...(io.timeoutMs === undefined ? {} : { timeoutMs: io.timeoutMs }),
    ...(io.clock === undefined ? {} : { clock: io.clock }),
  });
  if (answer === null) {
    return '';
  }
  // Only the two lines git expects, and no `quit=1`: a run that cannot get a token should fail the
  // git command, not silence every other helper the operator may have configured.
  return `username=${answer.username}\npassword=${answer.password}\n`;
};

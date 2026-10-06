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
 * The **repository path** is forwarded, not judged (backlog 481): git sends `path=` because the
 * workspace sets `credential.useHttpPath`, already percent-decoded and with its dot segments and
 * slashes resolved, and this helper passes it verbatim — or `null` when git sent none or one the
 * wire refuses ({@link credentialPath}). Whether it is the project's repository is the runner's
 * question, asked where the agent cannot read the answer key.
 *
 * Git's protocol is text on stdin from a process the agent can also run directly. It is parsed as
 * data: unknown keys are ignored, a key is never turned into a decision, and the answer only ever
 * contains the two lines git expects.
 */
import { connect } from 'node:net';
import type { RunnerClock } from '@platform/application';
import { runletCredentialPathSchema, runletHostSchema } from '@platform/contracts';
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

/**
 * The repository path git asked about, verbatim, or `null` — absent, empty, over the wire's bound
 * or carrying a control character. `null` is still asked (and refused by the runner, which logs
 * it), never answered here: the refusal belongs where the run's repository is known.
 */
export const credentialPath = (fields: Record<string, string>): string | null => {
  const path = fields['path'];
  return path !== undefined && runletCredentialPathSchema.safeParse(path).success ? path : null;
};

export interface CredentialRequestOptions {
  readonly socketPath: string;
  readonly host: string;
  /** git's `path` field (backlog 481), or `null` when it sent none. */
  readonly path: string | null;
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
  // A path the wire would refuse is sent as `null` rather than failing the frame: the runner then
  // refuses it by name, where a dropped connection would say nothing.
  const path =
    options.path !== null && runletCredentialPathSchema.safeParse(options.path).success
      ? options.path
      : null;
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
      connection.send({ type: 'cred.get', request_id: 'git-1', host, path, protocol: 'https' });
    });
  });
};

/**
 * `agentic-runlet credential [--socket <path>] <operation>` — the helper's arguments, as git hands
 * them over: the configured command (`credential.helper=!agentic-runlet credential --socket
 * /ctl/cred.sock`) with git's operation (`get`, `store`, `erase`) appended.
 *
 * **The socket travels as an argument, not through the environment** (WP-118 review round 1). The
 * helper runs under the `claude` process's git, whose environment is the spawn frame's and — by
 * design — carries no `RUNLET_*` name (TD-025's amendment), so a helper that looked for
 * `RUNLET_CREDENTIAL_SOCKET` found nothing and answered silence: a Developer's allowed `git push`
 * then failed with no diagnosis. The path is a path, not a secret, and the launcher writes it into
 * the helper command from the same function that writes the container's environment.
 *
 * `socketPath` is `null` when no `--socket` was given (or it had no value): the caller refuses
 * loudly rather than answering nothing.
 */
export const parseCredentialHelperArgs = (
  argv: readonly string[],
): { readonly socketPath: string | null; readonly operation: string | null } => {
  let socketPath: string | null = null;
  let operation: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (arg === '--socket') {
      const value = argv[index + 1];
      socketPath = value !== undefined && value.startsWith('/') ? value : null;
      index += 1;
      continue;
    }
    if (arg.startsWith('--socket=')) {
      const value = arg.slice('--socket='.length);
      socketPath = value.startsWith('/') ? value : null;
      continue;
    }
    // git appends exactly one operation; anything after it is not ours to read.
    operation ??= arg;
  }
  return { socketPath, operation };
};

/** What the helper prints on stderr, and exits non-zero with, when it was given no socket. */
export const NO_CREDENTIAL_SOCKET_MESSAGE =
  'agentic-runlet credential: no --socket <path> was given, so this helper cannot ask the run shim for a credential (the workspace configures it as `credential.helper=!agentic-runlet credential --socket /ctl/cred.sock`)';

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
  const fields = parseCredentialRequest(io.stdin);
  const host = credentialHost(fields);
  if (host === null) {
    return '';
  }
  const answer = await requestCredential({
    socketPath: io.socketPath,
    host,
    path: credentialPath(fields),
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

/**
 * The run shim's **ssh-agent socket** — TD-028 decision 13b item 2 (WP-146).
 *
 * A deploy-key run's git uses `ssh -o IdentityAgent=/ctl/ssh-agent.sock`, and this module is what
 * answers on that socket. It speaks the ssh-agent protocol (draft-miller-ssh-agent,
 * <https://datatracker.ietf.org/doc/html/draft-miller-ssh-agent>, retrieved 2026-10-04) — a `uint32`
 * length, a message type byte, the body — and exactly **two** of its requests, the two a git client
 * needs:
 *
 *  - `SSH_AGENTC_REQUEST_IDENTITIES` (11) → `SSH_AGENT_IDENTITIES_ANSWER` (12) with the run's one
 *    public key, which the launcher put in the shim's environment (it is not a secret);
 *  - `SSH_AGENTC_SIGN_REQUEST` (13) → `SSH_AGENT_SIGN_RESPONSE` (14), the signature coming from the
 *    **runner**, which holds the key: the request is relayed as an `ssh.sign` frame over the control
 *    channel and the answer arrives as `ssh.sign.reply`.
 *
 * **Every other request is answered `SSH_AGENT_FAILURE` (5)** — adding, removing or locking keys,
 * listing by another type, OpenSSH's extensions (`session-bind@openssh.com` included, which `ssh`
 * treats as optional) — and a message the parser cannot read closes the connection. The shim holds
 * no key and no allow-list: whether a signature is made is the runner's decision, on the platform
 * side of the volume (as for `cred.get`).
 *
 * What a compromised child can do with it, stated (decision 13b items 2 and 8): ask for signatures
 * of data of its choosing with the run's key, bounded per run, while the child runs — a signing
 * oracle for the run's lifetime, with the reach of the deploy key, and nothing once the run ends.
 */

/** Message numbers (draft-miller-ssh-agent § 6.1). */
export const SSH_AGENT_FAILURE = 5;
export const SSH_AGENTC_REQUEST_IDENTITIES = 11;
export const SSH_AGENT_IDENTITIES_ANSWER = 12;
export const SSH_AGENTC_SIGN_REQUEST = 13;
export const SSH_AGENT_SIGN_RESPONSE = 14;

/** The largest message the shim reads. A sign request of a user-authentication blob is < 1 KiB. */
export const MAX_AGENT_MESSAGE_BYTES = 16_384;

/** What a client sent, as far as the shim acts on it. */
export type AgentRequest =
  | { readonly kind: 'identities' }
  | {
      readonly kind: 'sign';
      readonly keyBlob: Buffer;
      readonly data: Buffer;
      readonly flags: number;
    }
  | { readonly kind: 'refused'; readonly type: number };

const uint32 = (value: number): Buffer => {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value >>> 0, 0);
  return out;
};

const sshString = (value: Buffer): Buffer => Buffer.concat([uint32(value.length), value]);

/** One message: `uint32 length`, `byte type`, the body. */
export const encodeAgentMessage = (type: number, body: Buffer = Buffer.alloc(0)): Buffer =>
  Buffer.concat([uint32(body.length + 1), Buffer.from([type]), body]);

/** `SSH_AGENT_IDENTITIES_ANSWER` with one key: `uint32 1`, `string blob`, `string comment`. */
export const encodeIdentitiesAnswer = (keyBlob: Buffer, comment: string): Buffer =>
  encodeAgentMessage(
    SSH_AGENT_IDENTITIES_ANSWER,
    Buffer.concat([uint32(1), sshString(keyBlob), sshString(Buffer.from(comment, 'utf8'))]),
  );

/** `SSH_AGENT_SIGN_RESPONSE`: `string signature`. */
export const encodeSignResponse = (signature: Buffer): Buffer =>
  encodeAgentMessage(SSH_AGENT_SIGN_RESPONSE, sshString(signature));

export const AGENT_FAILURE = encodeAgentMessage(SSH_AGENT_FAILURE);

/** Thrown for a message the shim will not read; the connection is closed. */
export class AgentProtocolError extends Error {
  override readonly name = 'AgentProtocolError';
}

/** Reads one message body (after the length) into a request. */
export const parseAgentRequest = (message: Buffer): AgentRequest => {
  if (message.length === 0) {
    throw new AgentProtocolError('an empty agent message');
  }
  const type = message[0] as number;
  if (type === SSH_AGENTC_REQUEST_IDENTITIES) {
    if (message.length !== 1) {
      throw new AgentProtocolError('REQUEST_IDENTITIES carries no body');
    }
    return { kind: 'identities' };
  }
  if (type !== SSH_AGENTC_SIGN_REQUEST) {
    return { kind: 'refused', type };
  }
  let at = 1;
  const readString = (): Buffer => {
    if (message.length - at < 4) throw new AgentProtocolError('a truncated sign request');
    const length = message.readUInt32BE(at);
    at += 4;
    if (length > message.length - at) throw new AgentProtocolError('a truncated sign request');
    const value = message.subarray(at, at + length);
    at += length;
    return value;
  };
  const keyBlob = readString();
  const data = readString();
  if (message.length - at !== 4) {
    throw new AgentProtocolError('a sign request whose flags are missing or followed by bytes');
  }
  const flags = message.readUInt32BE(at);
  if (keyBlob.length === 0 || data.length === 0) {
    throw new AgentProtocolError('a sign request with an empty key or no data');
  }
  return { kind: 'sign', keyBlob: Buffer.from(keyBlob), data: Buffer.from(data), flags };
};

/**
 * Splits a byte stream into agent messages. Returns the complete messages and the remainder; throws
 * for a length above {@link MAX_AGENT_MESSAGE_BYTES} (or zero), before buffering it.
 */
export const splitAgentMessages = (
  buffered: Buffer,
): { readonly messages: readonly Buffer[]; readonly rest: Buffer } => {
  const messages: Buffer[] = [];
  let at = 0;
  while (buffered.length - at >= 4) {
    const length = buffered.readUInt32BE(at);
    if (length === 0 || length > MAX_AGENT_MESSAGE_BYTES) {
      throw new AgentProtocolError(`an agent message of ${length} bytes`);
    }
    if (buffered.length - at - 4 < length) break;
    messages.push(buffered.subarray(at + 4, at + 4 + length));
    at += 4 + length;
  }
  return { messages, rest: buffered.subarray(at) };
};

/** The key blob of an `ssh-ed25519 AAAA…` line, or `null`. The shim reads its own environment with it. */
export const publicKeyBlobOf = (line: string): Buffer | null => {
  const parts = line.trim().split(/\s+/);
  if (
    parts.length < 2 ||
    parts[0] !== 'ssh-ed25519' ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(parts[1] ?? '')
  ) {
    return null;
  }
  const blob = Buffer.from(parts[1] as string, 'base64');
  // `string "ssh-ed25519"` (4 + 11) and `string key` (4 + 32).
  if (
    blob.length !== 51 ||
    blob.readUInt32BE(0) !== 11 ||
    blob.subarray(4, 15).toString('latin1') !== 'ssh-ed25519'
  ) {
    return null;
  }
  return blob;
};

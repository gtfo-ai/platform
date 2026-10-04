/**
 * The runner's half of a deploy-key run (TD-028 decision 13b item 2, WP-146): it holds the private
 * key for the run's lifetime and answers the sign requests the run shim relays from
 * `/ctl/ssh-agent.sock`. The key never crosses into the run container; what the container holds is
 * a **signing oracle** for the run's lifetime, and nothing after it.
 *
 * It signs **only for its own key** — a request naming another key blob is refused — **only an SSH
 * user-authentication request for user `git`** ({@link isGitUserauthRequest}, review round 1: an
 * `SSHSIG` over arbitrary data is refused), only data of a bounded size, at most {@link MAX_DEPLOY_KEY_SIGNATURES} times per run. Each signature is
 * counted (decision 13b: *"counted on the run, not logged with content"*); the count is read by the
 * provisioner's release log line, never the data or the signature.
 */
import {
  deployKeyPairFault,
  parseOpenSshEd25519PrivateKey,
  signSshEd25519,
  sshEd25519PublicKeyBlob,
} from '@platform/application';

/**
 * How many signatures one run may ask for. A fetch or a push is one SSH connection and one
 * signature; a run that fetches and pushes a few dozen times stays far below this.
 */
export const MAX_DEPLOY_KEY_SIGNATURES = 128;

/** The largest data an SSH user-authentication signature covers here (RFC 4252 § 7 is ~200 bytes). */
export const MAX_SIGNED_DATA_BYTES = 8_192;

const SSH_MSG_USERAUTH_REQUEST = 50;
/** OpenSSH's host-bound variant (PROTOCOL § 3.6), used when the server advertises it. */
const HOSTBOUND_METHOD = 'publickey-hostbound-v00@openssh.com';

/**
 * Whether `data` is an SSH **user-authentication** request for user `git` with this key (RFC 4252
 * § 7, review round 1): `string session id`, `byte 50`, `string "git"`, `string "ssh-connection"`,
 * `string "publickey"` (or OpenSSH's host-bound method, which appends `string server host key`),
 * `bool TRUE`, `string "ssh-ed25519"`, `string <our key blob>` — and nothing after. Anything else —
 * an `SSHSIG` (`ssh-keygen -Y sign`, git commit signing), a request for another user or key, raw
 * data — is refused, so the oracle signs only what a credential helper's token could do: log in.
 */
export const isGitUserauthRequest = (data: Buffer, keyBlob: Buffer): boolean => {
  let at = 0;
  const string = (): Buffer | null => {
    if (data.length - at < 4) return null;
    const length = data.readUInt32BE(at);
    if (length > data.length - at - 4) return null;
    const value = data.subarray(at + 4, at + 4 + length);
    at += 4 + length;
    return value;
  };
  const text = (expected: string): boolean => string()?.toString('latin1') === expected;
  const session = string();
  if (session === null || session.length === 0 || session.length > 64) return false;
  if (data[at] !== SSH_MSG_USERAUTH_REQUEST) return false;
  at += 1;
  if (!text('git') || !text('ssh-connection')) return false;
  const method = string()?.toString('latin1');
  if (method !== 'publickey' && method !== HOSTBOUND_METHOD) return false;
  if (data[at] !== 1) return false;
  at += 1;
  if (!text('ssh-ed25519')) return false;
  const key = string();
  if (key === null || !key.equals(keyBlob)) return false;
  if (method === HOSTBOUND_METHOD) {
    const hostKey = string();
    if (hostKey === null || hostKey.length === 0) return false;
  }
  return at === data.length;
};

export interface DeployKeySignRequest {
  readonly keyBlob: Buffer;
  readonly data: Buffer;
  readonly flags: number;
}

export interface DeployKeySigner {
  /** The SSH signature blob, or `null` — another key, too much data, or the run's budget spent. */
  sign(request: DeployKeySignRequest): Promise<Buffer | null>;
  /** Signatures made for this run so far. */
  readonly signatures: number;
  /** Requests refused so far. */
  readonly refusals: number;
}

/** Builds the signer, or throws naming the fault (never the key) when the key pair is unusable. */
export const createDeployKeySigner = (input: {
  readonly privateKey: string;
  readonly publicKey: string;
  readonly maxSignatures?: number;
}): DeployKeySigner => {
  const fault = deployKeyPairFault(input.privateKey, input.publicKey);
  const reading = parseOpenSshEd25519PrivateKey(input.privateKey);
  if (fault !== null || !reading.ok) {
    throw new Error(fault ?? 'the deploy key does not parse');
  }
  const key = reading.material;
  const blob = sshEd25519PublicKeyBlob(key.publicKey);
  const max = input.maxSignatures ?? MAX_DEPLOY_KEY_SIGNATURES;
  let signatures = 0;
  let refusals = 0;
  return {
    get signatures() {
      return signatures;
    },
    get refusals() {
      return refusals;
    },
    sign: async ({ keyBlob, data }) => {
      if (
        !keyBlob.equals(blob) ||
        data.length === 0 ||
        data.length > MAX_SIGNED_DATA_BYTES ||
        !isGitUserauthRequest(data, blob)
      ) {
        refusals += 1;
        return null;
      }
      if (signatures >= max) {
        refusals += 1;
        return null;
      }
      signatures += 1;
      // Ed25519 has no hash choice, so the agent's `SSH_AGENT_RSA_SHA2_*` flags do not apply.
      return signSshEd25519(key, data);
    },
  };
};

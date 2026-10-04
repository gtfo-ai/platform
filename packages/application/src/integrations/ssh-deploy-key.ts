/**
 * A project **SSH deploy key** as a run credential — the key half (TD-028 decision 13b, WP-146).
 *
 * The operator seals an **unencrypted OpenSSH Ed25519** private key on the git integration and
 * declares its public key beside it. This module is everything the platform does with the key's
 * bytes, and it is deliberately small:
 *
 *  - **read** the operator's text — the `openssh-key-v1` container (OpenSSH's `PROTOCOL.key`,
 *    <https://github.com/openssh/openssh-portable/blob/master/PROTOCOL.key>, retrieved 2026-10-04),
 *    refusing **by name** a passphrase (a cipher other than `none`), any key type other than
 *    `ssh-ed25519`, a PEM of another kind, more than one key, and a container whose two check
 *    integers differ (the decrypt check PROTOCOL.key defines — on an unencrypted key it catches a
 *    corrupted paste);
 *  - **derive** the public key from the private seed and compare it with both the copy the
 *    container carries and the operator's declared public key (decision 13b item 1: *"a public key
 *    that is not the private key's (checked at the write by deriving it)"*);
 *  - **sign** with Ed25519 (RFC 8032, through `node:crypto`), producing the SSH signature blob an
 *    ssh-agent `SIGN_RESPONSE` carries (RFC 8709 § 6: `string "ssh-ed25519"`, `string signature`).
 *
 * Why Ed25519 only: the signer below implements one algorithm, and Ed25519 has no hash or padding
 * choice (an agent's `SSH_AGENT_RSA_SHA2_*` flags do not apply), so there is nothing for a client to
 * negotiate down. Anything else is refused at the write rather than half-supported at the run.
 *
 * **Never** logged, never stored outside the sealed secret, never in a run container: the runner
 * holds the parsed key for a run's lifetime and answers sign requests the run shim relays.
 */
import { createPrivateKey, createPublicKey, type KeyObject, sign } from 'node:crypto';

/** The key type this build signs with, in SSH's own spelling (RFC 8709 § 4). */
export const SSH_ED25519 = 'ssh-ed25519';

const OPENSSH_MAGIC = /* @__PURE__ */ Buffer.from('openssh-key-v1\0', 'latin1');
const PEM_BEGIN = '-----BEGIN OPENSSH PRIVATE KEY-----';
const PEM_END = '-----END OPENSSH PRIVATE KEY-----';
/** A deploy key is a few hundred bytes; anything this long is not one, and is not parsed. */
const MAX_PRIVATE_KEY_TEXT = 16_384;

/** A parsed key. `seed` is the secret; `publicKey` is 32 bytes. */
export interface SshEd25519PrivateKey {
  readonly seed: Buffer;
  readonly publicKey: Buffer;
}

export type SshPrivateKeyReading =
  | { readonly ok: true; readonly material: SshEd25519PrivateKey }
  | { readonly ok: false; readonly reason: string };

/** A bounded reader over SSH's wire encoding (RFC 4251 § 5): `uint32` and `string`. */
class SshReader {
  #at = 0;
  readonly buffer: Buffer;
  constructor(buffer: Buffer) {
    this.buffer = buffer;
  }
  get remaining(): number {
    return this.buffer.length - this.#at;
  }
  uint32(): number | null {
    if (this.remaining < 4) return null;
    const value = this.buffer.readUInt32BE(this.#at);
    this.#at += 4;
    return value;
  }
  string(): Buffer | null {
    const length = this.uint32();
    if (length === null || length > this.remaining) return null;
    const value = this.buffer.subarray(this.#at, this.#at + length);
    this.#at += length;
    return value;
  }
  rest(): Buffer {
    const value = this.buffer.subarray(this.#at);
    this.#at = this.buffer.length;
    return value;
  }
}

/** `string` in SSH's wire encoding: a big-endian `uint32` length, then the bytes. */
export const sshString = (value: Buffer | string): Buffer => {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([length, bytes]);
};

/** The public key blob an agent lists and a server checks: `string "ssh-ed25519"`, `string key`. */
export const sshEd25519PublicKeyBlob = (publicKey: Buffer): Buffer =>
  Buffer.concat([sshString(SSH_ED25519), sshString(publicKey)]);

/** The `authorized_keys` line of a public key, with no comment: `ssh-ed25519 AAAA…`. */
export const sshEd25519PublicKeyLine = (publicKey: Buffer): string =>
  `${SSH_ED25519} ${sshEd25519PublicKeyBlob(publicKey).toString('base64')}`;

/**
 * The 32-byte key of a declared public key line (`ssh-ed25519 AAAA… [comment]`), or `null` when it
 * is not an Ed25519 public key. The blob's own type must agree with the line's.
 */
export const parseSshEd25519PublicKey = (line: string): Buffer | null => {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 2 || parts[0] !== SSH_ED25519) return null;
  const encoded = parts[1] as string;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  const reader = new SshReader(Buffer.from(encoded, 'base64'));
  const type = reader.string();
  const key = reader.string();
  if (type === null || key === null || type.toString('latin1') !== SSH_ED25519) return null;
  if (key.length !== 32 || reader.remaining !== 0) return null;
  return Buffer.from(key);
};

/**
 * The base64 body of an OpenSSH private key, its line breaks removed — what the redactors and the
 * merge request's added-lines search look for (decision 13b item 7). `null` when the text has no
 * OpenSSH armour.
 */
export const openSshPrivateKeyBody = (text: string): string | null => {
  const begin = text.indexOf(PEM_BEGIN);
  const end = text.indexOf(PEM_END);
  if (begin === -1 || end === -1 || end < begin) return null;
  return text.slice(begin + PEM_BEGIN.length, end).replace(/\s+/g, '');
};

const refuse = (reason: string): SshPrivateKeyReading => ({ ok: false, reason });

/**
 * The DER prefix of an Ed25519 PKCS #8 `PrivateKeyInfo` holding a 32-byte seed (RFC 8410 § 7:
 * <https://www.rfc-editor.org/rfc/rfc8410#section-7>) — how `node:crypto` takes a raw seed. Measured:
 * a JWK carrying `d` without `x` is refused by Node 24 (*"The "key.x" property must be of type
 * string"*), so the public half cannot be derived through JWK.
 */
const ED25519_PKCS8_PREFIX = /* @__PURE__ */ Buffer.from('302e020100300506032b657004220420', 'hex');

/** The Ed25519 private key object of a seed. The public half is derived from the seed alone. */
export const ed25519KeyObject = (key: Pick<SshEd25519PrivateKey, 'seed'>): KeyObject =>
  createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, key.seed]),
    format: 'der',
    type: 'pkcs8',
  });

/** The public key `node:crypto` derives from a seed — never the copy a container carries. */
const derivedPublicKey = (seed: Buffer): Buffer => {
  const spki = createPublicKey(ed25519KeyObject({ seed })).export({ format: 'der', type: 'spki' });
  // An Ed25519 SubjectPublicKeyInfo is a 12-byte header and the 32-byte key (RFC 8410 § 4).
  return Buffer.from(spki.subarray(spki.length - 32));
};

/**
 * Reads an operator's private key text. Refusals name the fault and never quote the key.
 */
export const parseOpenSshEd25519PrivateKey = (text: string): SshPrivateKeyReading => {
  if (text.length > MAX_PRIVATE_KEY_TEXT) {
    return refuse('it is longer than any Ed25519 deploy key, so it is not one');
  }
  if (/-----BEGIN (?:RSA|DSA|EC|ENCRYPTED)? ?PRIVATE KEY-----/.test(text)) {
    return refuse(
      'it is a PEM private key, not an OpenSSH Ed25519 one; create one with `ssh-keygen -t ed25519 -N ""`',
    );
  }
  const body = openSshPrivateKeyBody(text);
  if (body === null || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) {
    return refuse(
      'it is not an OpenSSH private key (no `-----BEGIN OPENSSH PRIVATE KEY-----` armour around base64)',
    );
  }
  const bytes = Buffer.from(body, 'base64');
  if (!bytes.subarray(0, OPENSSH_MAGIC.length).equals(OPENSSH_MAGIC)) {
    return refuse('it is not an `openssh-key-v1` container');
  }
  const reader = new SshReader(bytes.subarray(OPENSSH_MAGIC.length));
  const cipher = reader.string();
  const kdf = reader.string();
  const kdfOptions = reader.string();
  const count = reader.uint32();
  if (cipher === null || kdf === null || kdfOptions === null || count === null) {
    return refuse('its container is truncated');
  }
  if (cipher.toString('latin1') !== 'none' || kdf.toString('latin1') !== 'none') {
    return refuse(
      'it is protected by a passphrase; the runner signs with it unattended, so it must be unencrypted (`ssh-keygen -t ed25519 -N ""`)',
    );
  }
  if (count !== 1) {
    return refuse(`it holds ${count} keys; a deploy key is one`);
  }
  const publicBlob = reader.string();
  const privateSection = reader.string();
  if (publicBlob === null || privateSection === null) {
    return refuse('its container is truncated');
  }
  const outerType = new SshReader(publicBlob).string()?.toString('latin1') ?? '';
  if (outerType !== SSH_ED25519) {
    return refuse(
      `it is a ${outerType === '' ? 'key of no readable type' : `\`${outerType.slice(0, 32)}\` key`}; this build signs with Ed25519 only (\`ssh-keygen -t ed25519\`)`,
    );
  }
  const inner = new SshReader(privateSection);
  const check1 = inner.uint32();
  const check2 = inner.uint32();
  const type = inner.string();
  const publicKey = inner.string();
  const secret = inner.string();
  if (
    check1 === null ||
    check2 === null ||
    type === null ||
    publicKey === null ||
    secret === null
  ) {
    return refuse('its private section is truncated');
  }
  if (check1 !== check2) {
    return refuse('its two check integers differ, so the private section is corrupt');
  }
  if (type.toString('latin1') !== SSH_ED25519 || publicKey.length !== 32 || secret.length !== 64) {
    return refuse('its private section is not an Ed25519 key');
  }
  const seed = Buffer.from(secret.subarray(0, 32));
  const embedded = Buffer.from(secret.subarray(32));
  const derived = derivedPublicKey(seed);
  if (!derived.equals(publicKey) || !derived.equals(embedded)) {
    return refuse('its public half is not the one its private seed derives, so it is corrupt');
  }
  if (!sshEd25519PublicKeyBlob(derived).equals(publicBlob)) {
    return refuse('its listed public key is not the one its private seed derives');
  }
  return { ok: true, material: { seed, publicKey: derived } };
};

/**
 * Why `privateKeyText` cannot be used with `publicKeyLine`, or `null` — the write's check and the
 * load's (decision 13b item 1). The refusal names the fault, never a value.
 */
export const deployKeyPairFault = (
  privateKeyText: string,
  publicKeyLine: string,
): string | null => {
  const reading = parseOpenSshEd25519PrivateKey(privateKeyText);
  if (!reading.ok) {
    return `the private key is refused: ${reading.reason}`;
  }
  const declared = parseSshEd25519PublicKey(publicKeyLine);
  if (declared === null) {
    return 'the declared public key is not an `ssh-ed25519 AAAA…` line';
  }
  if (!declared.equals(reading.material.publicKey)) {
    return 'the declared public key is not the private key’s (derived from its seed); paste the matching `.pub` line';
  }
  return null;
};

/**
 * An Ed25519 signature of `data` as an SSH signature blob (RFC 8709 § 6): `string "ssh-ed25519"`,
 * `string signature` — what an ssh-agent `SIGN_RESPONSE` carries.
 */
export const signSshEd25519 = (key: SshEd25519PrivateKey, data: Buffer): Buffer =>
  Buffer.concat([sshString(SSH_ED25519), sshString(sign(null, data, ed25519KeyObject(key)))]);

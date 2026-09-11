/**
 * Envelope encryption for the `secrets` table (technical/03: "encrypted with `APP_SECRET_KEY`
 * (envelope); never joined into API responses", BD-002).
 *
 * One row holds one credential — the config **field** it belongs to and its value — sealed under a
 * data key that is itself sealed under a key derived from `APP_SECRET_KEY`. The indirection is what
 * "envelope" buys: rotating the platform key rewraps 32 bytes per row instead of re-encrypting
 * every credential, and a row records which key it was sealed under (`secrets.key_id`) so a
 * half-finished rotation is a readable state rather than a corrupt one.
 *
 * ## The wire layout, written down because the bytes outlive this file
 *
 * ```
 *  0        version        1 byte   (currently 1; anything else is refused, never guessed)
 *  1        wrap iv       12 bytes
 * 13        wrap tag      16 bytes
 * 29        wrapped dek   32 bytes  AES-256-GCM(kek, dek), aad = version byte
 * 61        body iv       12 bytes
 * 73        body tag      16 bytes
 * 89        body          n bytes   AES-256-GCM(dek, utf8 json), aad = wrapped dek
 * ```
 *
 * The body's AAD is the wrapped data key, which binds a body to the exact key material it was
 * sealed with: splicing the body of one row onto the header of another fails authentication
 * instead of decrypting to someone else's credential.
 *
 * ## What this deliberately does not do
 *
 * It does not read `process.env`. The key arrives as a value from `apps/server`'s validated
 * configuration, so a process that starts has one and no module here can fall back to a
 * development default — a development default for a key is a real key in every deployment that
 * forgot to set one (`apps/server/src/config.ts` makes the same point about `APP_SECRET_KEY`).
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/** Sealed-format version. A row that carries anything else is refused. */
export const SECRET_ENVELOPE_VERSION = 1;

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES + KEY_BYTES + IV_BYTES + TAG_BYTES;

/**
 * HKDF's `info`, and the whole of what separates this key from any other use of `APP_SECRET_KEY`.
 *
 * Better Auth hashes sessions with the same variable; deriving with a distinct label is what stops
 * one use's key from being the other's.
 */
const KDF_INFO = 'agentic:secrets:envelope:v1';
const KDF_SALT = 'agentic:secrets:envelope:salt:v1';

export class SecretEnvelopeError extends Error {
  override readonly name = 'SecretEnvelopeError';
}

/**
 * The key-encryption key, plus the id a row records so a rotation is legible.
 *
 * `keyId` is a **fingerprint of the derived key**, not of `APP_SECRET_KEY`: it changes when the
 * platform key changes, which is the property an operator needs, and it discloses nothing about
 * the key that a 128-bit truncated digest of 32 random-looking bytes does not.
 */
export interface SecretKey {
  readonly keyId: string;
  readonly kek: Buffer;
}

/** Shortest platform key this will derive from; `apps/server`'s config enforces the same floor. */
export const MIN_SECRET_KEY_LENGTH = 32;

export const deriveSecretKey = (appSecretKey: string): SecretKey => {
  if (appSecretKey.length < MIN_SECRET_KEY_LENGTH) {
    throw new SecretEnvelopeError(
      `APP_SECRET_KEY must be at least ${MIN_SECRET_KEY_LENGTH} characters to derive a secret key`,
    );
  }
  const kek = Buffer.from(hkdfSync('sha256', appSecretKey, KDF_SALT, KDF_INFO, KEY_BYTES));
  const fingerprint = createHash('sha256').update(kek).digest('hex').slice(0, 16);
  return { keyId: `v${SECRET_ENVELOPE_VERSION}:${fingerprint}`, kek };
};

export const sealSecret = (key: SecretKey, plaintext: string): Buffer => {
  const dek = randomBytes(KEY_BYTES);
  const version = Buffer.of(SECRET_ENVELOPE_VERSION);

  const wrapIv = randomBytes(IV_BYTES);
  const wrap = createCipheriv('aes-256-gcm', key.kek, wrapIv);
  wrap.setAAD(version);
  const wrappedDek = Buffer.concat([wrap.update(dek), wrap.final()]);
  const wrapTag = wrap.getAuthTag();

  const bodyIv = randomBytes(IV_BYTES);
  const body = createCipheriv('aes-256-gcm', dek, bodyIv);
  body.setAAD(wrappedDek);
  const sealed = Buffer.concat([body.update(plaintext, 'utf8'), body.final()]);
  const bodyTag = body.getAuthTag();

  dek.fill(0);
  return Buffer.concat([version, wrapIv, wrapTag, wrappedDek, bodyIv, bodyTag, sealed]);
};

/**
 * @throws {SecretEnvelopeError} for a truncated row, an unknown version, or a failed tag — the
 * three are distinguished in the message and none of them names a byte of the value.
 */
export const openSecret = (key: SecretKey, ciphertext: Buffer): string => {
  if (ciphertext.length < HEADER_BYTES) {
    throw new SecretEnvelopeError(
      `sealed secret is ${ciphertext.length} bytes; the header alone is ${HEADER_BYTES}`,
    );
  }
  const version = ciphertext.readUInt8(0);
  if (version !== SECRET_ENVELOPE_VERSION) {
    throw new SecretEnvelopeError(
      `sealed secret has format version ${version}; this build reads ${SECRET_ENVELOPE_VERSION}`,
    );
  }
  let offset = 1;
  const take = (bytes: number): Buffer => {
    const slice = ciphertext.subarray(offset, offset + bytes);
    offset += bytes;
    return slice;
  };
  const wrapIv = take(IV_BYTES);
  const wrapTag = take(TAG_BYTES);
  const wrappedDek = take(KEY_BYTES);
  const bodyIv = take(IV_BYTES);
  const bodyTag = take(TAG_BYTES);
  const sealed = ciphertext.subarray(offset);

  let dek: Buffer;
  try {
    const unwrap = createDecipheriv('aes-256-gcm', key.kek, wrapIv);
    unwrap.setAAD(Buffer.of(version));
    unwrap.setAuthTag(wrapTag);
    dek = Buffer.concat([unwrap.update(wrappedDek), unwrap.final()]);
  } catch (cause) {
    throw new SecretEnvelopeError(
      'the data key does not authenticate under this APP_SECRET_KEY; check secrets.key_id',
      { cause },
    );
  }

  try {
    const open = createDecipheriv('aes-256-gcm', dek, bodyIv);
    open.setAAD(wrappedDek);
    open.setAuthTag(bodyTag);
    return Buffer.concat([open.update(sealed), open.final()]).toString('utf8');
  } catch (cause) {
    throw new SecretEnvelopeError('the sealed secret does not authenticate', { cause });
  } finally {
    dek.fill(0);
  }
};

/**
 * Is this row sealed under the key this process holds?
 *
 * Compared in constant time, which costs nothing and keeps a key fingerprint from being probed one
 * character at a time by whatever ends up calling this from an HTTP handler.
 */
export const isSealedUnder = (key: SecretKey, keyId: string): boolean => {
  const left = Buffer.from(key.keyId, 'utf8');
  const right = Buffer.from(keyId, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
};

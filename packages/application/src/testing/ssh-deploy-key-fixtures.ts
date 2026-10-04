/**
 * Deploy-key fixtures for tests (WP-146): the RFC 8032 vector and an `openssh-key-v1` writer, so
 * every refusal can be driven field by field and no private key is ever committed as text — the
 * fixtures are **built** from the RFC's published (and therefore public, obviously fake) seed.
 *
 * Every top-level call is annotated `@__PURE__`: this module is on `@platform/application`'s barrel,
 * which the run shim's bundle imports, and an unannotated call there kept the fixture — and the key
 * reader — in `agentic-runlet.mjs` (measured at WP-146: the RFC seed was in the bundle).
 */
import { SSH_ED25519, sshEd25519PublicKeyLine, sshString } from '../integrations/ssh-deploy-key.js';

/**
 * RFC 8032 § 7.1, "TEST 1" (<https://www.rfc-editor.org/rfc/rfc8032#section-7.1>, retrieved
 * 2026-10-04): the secret key, its public key, the empty message and its signature. A fixed vector
 * with its source — the brief's alternative to `ssh-keygen -Y verify`, which
 * `packages/infrastructure/src/runlet/ssh-agent.test.ts` runs as well.
 */
export const RFC8032_TEST1 = {
  seed: /* @__PURE__ */ Buffer.from(
    '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
    'hex',
  ),
  publicKey: /* @__PURE__ */ Buffer.from(
    'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
    'hex',
  ),
  message: /* @__PURE__ */ Buffer.alloc(0),
  signature: /* @__PURE__ */ Buffer.from(
    'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
    'hex',
  ),
};

/**
 * An `openssh-key-v1` container written the way `ssh-keygen` writes one (PROTOCOL.key), so the
 * refusals can be driven one field at a time. Test-only: production never writes a key.
 */
export const encodeOpenSshKey = (input: {
  readonly seed: Buffer;
  readonly publicKey: Buffer;
  readonly cipher?: string;
  readonly type?: string;
  readonly count?: number;
  readonly checks?: readonly [number, number];
  readonly embeddedPublic?: Buffer;
}): string => {
  const type = input.type ?? SSH_ED25519;
  const publicBlob = Buffer.concat([sshString(type), sshString(input.publicKey)]);
  const uint32 = (value: number): Buffer => {
    const out = Buffer.alloc(4);
    out.writeUInt32BE(value, 0);
    return out;
  };
  const [c1, c2] = input.checks ?? [0x01020304, 0x01020304];
  let privateSection = Buffer.concat([
    uint32(c1),
    uint32(c2),
    sshString(type),
    sshString(input.publicKey),
    sshString(Buffer.concat([input.seed, input.embeddedPublic ?? input.publicKey])),
    sshString('fake-deploy-key@example.test'),
  ]);
  const padding: number[] = [];
  for (let i = 1; (privateSection.length + padding.length) % 8 !== 0; i += 1) padding.push(i);
  privateSection = Buffer.concat([privateSection, Buffer.from(padding)]);
  const cipher = input.cipher ?? 'none';
  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'latin1'),
    sshString(cipher),
    sshString(cipher === 'none' ? 'none' : 'bcrypt'),
    sshString(cipher === 'none' ? Buffer.alloc(0) : Buffer.alloc(24, 7)),
    uint32(input.count ?? 1),
    sshString(publicBlob),
    sshString(privateSection),
  ]).toString('base64');
  const lines = body.match(/.{1,70}/g) ?? [];
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`;
};

/** The RFC vector as an operator would paste it: the private key text and its `.pub` line. */
export const FAKE_DEPLOY_KEY: { readonly privateKey: string; readonly publicKey: string } = {
  // Getters, not values: an initializer that reads `RFC8032_TEST1` is a property read the bundler
  // must keep, which kept this fixture in the run shim's bundle (see the module docblock).
  get privateKey(): string {
    return encodeOpenSshKey({ seed: RFC8032_TEST1.seed, publicKey: RFC8032_TEST1.publicKey });
  },
  get publicKey(): string {
    return `${sshEd25519PublicKeyLine(RFC8032_TEST1.publicKey)} fake-deploy-key@example.test`;
  },
};

/**
 * The runner's deploy-key signer (WP-146, TD-028 decision 13b item 2; review round 1): it signs an
 * SSH user-authentication request for `git` with its own key and nothing else, within a per-run
 * budget and a size cap.
 */
import { createPublicKey, verify } from 'node:crypto';
import {
  FAKE_DEPLOY_KEY,
  RFC8032_TEST1,
  sshEd25519PublicKeyBlob,
  sshString,
} from '@platform/application';
import { describe, expect, it } from 'vitest';
import {
  createDeployKeySigner,
  isGitUserauthRequest,
  MAX_SIGNED_DATA_BYTES,
} from './deploy-key-signer.js';

const BLOB = sshEd25519PublicKeyBlob(RFC8032_TEST1.publicKey);

const userauth = (over: { user?: string; method?: string; key?: Buffer; tail?: Buffer[] } = {}) =>
  Buffer.concat([
    sshString(Buffer.alloc(32, 9)),
    Buffer.from([50]),
    sshString(over.user ?? 'git'),
    sshString('ssh-connection'),
    sshString(over.method ?? 'publickey'),
    Buffer.from([1]),
    sshString('ssh-ed25519'),
    sshString(over.key ?? BLOB),
    ...(over.tail ?? []),
  ]);

const signer = (maxSignatures?: number) =>
  createDeployKeySigner({
    privateKey: FAKE_DEPLOY_KEY.privateKey,
    publicKey: FAKE_DEPLOY_KEY.publicKey,
    ...(maxSignatures === undefined ? {} : { maxSignatures }),
  });

describe('the deploy-key signer (WP-146)', () => {
  it('signs a user-authentication request for git with its key, verifiably', async () => {
    const signing = signer();
    const data = userauth();
    const blob = await signing.sign({ keyBlob: BLOB, data, flags: 0 });
    expect(blob).not.toBeNull();
    const signature = (blob as Buffer).subarray((blob as Buffer).length - 64);
    const key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: RFC8032_TEST1.publicKey.toString('base64url') },
      format: 'jwk',
    });
    expect(verify(null, data, key, signature)).toBe(true);
    // OpenSSH's host-bound method carries the server's host key after ours.
    const hostbound = userauth({
      method: 'publickey-hostbound-v00@openssh.com',
      tail: [sshString(Buffer.from('host-key-blob'))],
    });
    expect(await signing.sign({ keyBlob: BLOB, data: hostbound, flags: 0 })).not.toBeNull();
    expect(signing.signatures).toBe(2);
  });

  it.each([
    [
      'an SSHSIG (ssh-keygen -Y sign, git commit signing)',
      Buffer.concat([
        Buffer.from('SSHSIG'),
        sshString('git'),
        sshString(''),
        sshString('sha512'),
        sshString(Buffer.alloc(64)),
      ]),
    ],
    ['another user', userauth({ user: 'root' })],
    ['another method', userauth({ method: 'hostbased' })],
    ['another key in the request', userauth({ key: Buffer.alloc(51, 1) })],
    ['trailing bytes', userauth({ tail: [Buffer.from([0])] })],
    ['raw data', Buffer.from('agentic/WP-146 push')],
  ])('refuses %s, signing nothing', async (_, data) => {
    const signing = signer();
    expect(isGitUserauthRequest(data, BLOB)).toBe(false);
    expect(await signing.sign({ keyBlob: BLOB, data, flags: 0 })).toBeNull();
    expect(signing.signatures).toBe(0);
    expect(signing.refusals).toBe(1);
  });

  it('refuses another key blob, data past the cap, and every request past the run’s budget', async () => {
    const signing = signer(2);
    expect(
      await signing.sign({ keyBlob: Buffer.alloc(51, 1), data: userauth(), flags: 0 }),
    ).toBeNull();
    const oversized = userauth({ tail: [Buffer.alloc(MAX_SIGNED_DATA_BYTES)] });
    expect(await signing.sign({ keyBlob: BLOB, data: oversized, flags: 0 })).toBeNull();
    expect(await signing.sign({ keyBlob: BLOB, data: userauth(), flags: 0 })).not.toBeNull();
    expect(await signing.sign({ keyBlob: BLOB, data: userauth(), flags: 0 })).not.toBeNull();
    expect(await signing.sign({ keyBlob: BLOB, data: userauth(), flags: 0 })).toBeNull();
    expect(signing.signatures).toBe(2);
    expect(signing.refusals).toBe(3);
  });
});

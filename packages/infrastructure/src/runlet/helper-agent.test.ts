/**
 * **A worker's helper agent socket** (WP-283, TD-031's 2026-11-04 amendment, backlog 693): the
 * worker serves it, a helper's `ssh` lists one identity and asks for one signature, and the
 * signature is the **core's** — here the real oracle (`createDeployKeySigner`), so a blob it refuses
 * comes back `FAILURE` and one it admits verifies against the deploy key's public half.
 *
 * And the fake workspace provider's `relayedSigning` (WP-283): a mirror update and an export handed
 * a relayed access each sign **once** through the socket, and a refused signature fails them the way
 * a helper's `git` fails.
 */
import { createPublicKey, verify } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FAKE_DEPLOY_KEY } from '@platform/application';
import { afterAll, describe, expect, it } from 'vitest';
import { createDeployKeySigner } from '../launcher/deploy-key-signer.js';
import { FakeWorkspaceProvider, syntheticUserauthBlob } from '../workspace/fake.js';
import { serveHelperAgent, signThroughAgent } from './helper-agent.js';
import { publicKeyBlobOf } from './ssh-agent.js';

const root = mkdtempSync(path.join(tmpdir(), 'helper-agent-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const KEY_LINE = FAKE_DEPLOY_KEY.publicKey.split(' ').slice(0, 2).join(' ');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Verifies an SSH `ssh-ed25519` signature blob over `data` with the fixture key. */
const verifies = (data: Buffer, signatureBlob: Buffer): boolean => {
  const signature = signatureBlob.subarray(4 + 11 + 4);
  const keyBlob = publicKeyBlobOf(KEY_LINE) as Buffer;
  const raw = keyBlob.subarray(4 + 11 + 4);
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
  return verify(null, data, key, signature);
};

describe('serveHelperAgent (WP-283)', () => {
  it('lists the run’s key and signs a user-authentication blob through the core’s oracle', async () => {
    const signer = createDeployKeySigner(FAKE_DEPLOY_KEY);
    const asked: number[] = [];
    const agent = await serveHelperAgent({
      controlRoot: root,
      socket: 'helper-one/agent.sock',
      publicKey: FAKE_DEPLOY_KEY.publicKey,
      sign: async (request) => {
        asked.push(request.data.length);
        return signer.sign(request);
      },
    });
    try {
      // Backlog 705: group 0 where this process may give it (`0660`), else other (`0666`) — the
      // mirror helper is root with no capabilities and reaches it through one or the other.
      const mode = statSync(agent.path).mode & 0o777;
      expect([0o660, 0o666]).toContain(mode);
      expect(mode & 0o006 ? statSync(agent.path).gid !== 0 : statSync(agent.path).gid === 0).toBe(
        true,
      );
      let signed: Buffer = Buffer.alloc(0);
      const answer = await signThroughAgent({
        socketPath: agent.path,
        data: (keyBlob) => {
          signed = syntheticUserauthBlob(keyBlob, Buffer.alloc(32, 7));
          return signed;
        },
      });
      expect(answer).not.toBeNull();
      expect(answer?.keyBlob.equals(publicKeyBlobOf(KEY_LINE) as Buffer)).toBe(true);
      expect(verifies(signed, answer?.signature as Buffer)).toBe(true);
      expect(agent.signatures()).toBe(1);
      expect(asked).toHaveLength(1);
    } finally {
      await agent.close();
    }
  });

  it('answers FAILURE when the core refuses — a blob that is not a user authentication', async () => {
    const signer = createDeployKeySigner(FAKE_DEPLOY_KEY);
    const agent = await serveHelperAgent({
      controlRoot: root,
      socket: 'helper-two/agent.sock',
      publicKey: FAKE_DEPLOY_KEY.publicKey,
      sign: async (request) => signer.sign(request),
    });
    try {
      const answer = await signThroughAgent({
        socketPath: agent.path,
        data: Buffer.from('not an SSH user-authentication request'),
      });
      expect(answer).toBeNull();
      expect(agent.signatures()).toBe(0);
      expect(agent.refusals()).toBe(1);
    } finally {
      await agent.close();
    }
  });

  it('refuses a socket path inside a run’s own control directory', async () => {
    await expect(
      serveHelperAgent({
        controlRoot: root,
        socket: '00000000-0000-4000-8000-000000000001/agent.sock',
        publicKey: FAKE_DEPLOY_KEY.publicKey,
        sign: async () => null,
      }),
    ).rejects.toThrow(/not a helper agent socket path/);
  });
});

describe('the fake provider’s relayed signing (WP-283)', () => {
  const ssh = {
    publicKey: KEY_LINE,
    httpsPrefix: 'https://gitlab.com/',
    sshPrefix: 'ssh://git@altssh.gitlab.com:443/',
    connectHost: 'altssh.gitlab.com',
    connectPort: 443,
    hostKeyAlias: 'gitlab.com',
    knownHosts: ['gitlab.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFAKE'],
  };
  const repo = {
    url: 'https://gitlab.com/acme/autix.git',
    defaultBranch: 'main',
    checkoutBranch: null,
    checkoutCommit: null,
    cacheKey: 'acme-autix',
    ssh,
  };

  it('signs once per mirror update through the relayed socket, and fails the update on a refusal', async () => {
    const signer = createDeployKeySigner(FAKE_DEPLOY_KEY);
    let refuse = false;
    const agent = await serveHelperAgent({
      controlRoot: root,
      socket: 'helper-three/agent.sock',
      publicKey: FAKE_DEPLOY_KEY.publicKey,
      sign: async (request) => (refuse ? null : signer.sign(request)),
    });
    const provider = new FakeWorkspaceProvider({ relayedSigning: { controlRoot: root } });
    try {
      const access = { kind: 'relayed_ssh' as const, ssh, agentSocket: 'helper-three/agent.sock' };
      await provider.updateMirror({ projectId: 'p', repo, credential: access });
      expect(provider.relayedSignatures).toHaveLength(1);
      const [first] = provider.relayedSignatures;
      expect(first?.kind).toBe('mirror');
      expect(verifies(first?.data as Buffer, first?.signature as Buffer)).toBe(true);
      refuse = true;
      await expect(
        provider.updateMirror({ projectId: 'p', repo, credential: access }),
      ).rejects.toThrow(/refused by the relayed agent/);
      expect(provider.relayedSignatures).toHaveLength(1);
    } finally {
      await agent.close();
    }
  });

  it('never connects without relayedSigning (divergence 9 as it was)', async () => {
    const provider = new FakeWorkspaceProvider({});
    await provider.updateMirror({
      projectId: 'p',
      repo,
      credential: { kind: 'relayed_ssh', ssh, agentSocket: 'helper-none/agent.sock' },
    });
    expect(provider.relayedSignatures).toHaveLength(0);
  });
});

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeOpenSshKey, RFC8032_TEST1 } from '../testing/ssh-deploy-key-fixtures.js';
import {
  deployKeyPairFault,
  openSshPrivateKeyBody,
  parseOpenSshEd25519PrivateKey,
  parseSshEd25519PublicKey,
  signSshEd25519,
  sshEd25519PublicKeyLine,
  sshString,
} from './ssh-deploy-key.js';

const vectorKey = encodeOpenSshKey({
  seed: RFC8032_TEST1.seed,
  publicKey: RFC8032_TEST1.publicKey,
});
const vectorPublicLine = `${sshEd25519PublicKeyLine(RFC8032_TEST1.publicKey)} fake@example.test`;

describe('an SSH deploy key (WP-146, TD-028 decision 13b)', () => {
  it('signs RFC 8032 § 7.1 TEST 1 to its published signature, as an SSH signature blob', () => {
    const reading = parseOpenSshEd25519PrivateKey(vectorKey);
    if (!reading.ok) throw new Error(reading.reason);
    expect(reading.material.publicKey.equals(RFC8032_TEST1.publicKey)).toBe(true);
    const blob = signSshEd25519(reading.material, RFC8032_TEST1.message);
    expect(
      blob.equals(Buffer.concat([sshString('ssh-ed25519'), sshString(RFC8032_TEST1.signature)])),
    ).toBe(true);
  });

  it('reads a key ssh-keygen wrote and derives the public key ssh-keygen wrote beside it', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wp146-'));
    try {
      const file = path.join(dir, 'k');
      execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'fake', '-f', file]);
      const privateText = readFileSync(file, 'utf8');
      const publicLine = readFileSync(`${file}.pub`, 'utf8');
      expect(deployKeyPairFault(privateText, publicLine)).toBeNull();
      const reading = parseOpenSshEd25519PrivateKey(privateText);
      if (!reading.ok) throw new Error(reading.reason);
      expect(sshEd25519PublicKeyLine(reading.material.publicKey)).toBe(
        publicLine.trim().split(' ').slice(0, 2).join(' '),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a passphrase, another key type, a PEM key, two keys and a corrupt section, by name', () => {
    const base = { seed: RFC8032_TEST1.seed, publicKey: RFC8032_TEST1.publicKey };
    const reason = (text: string): string => {
      const reading = parseOpenSshEd25519PrivateKey(text);
      return reading.ok ? 'accepted' : reading.reason;
    };
    expect(reason(encodeOpenSshKey({ ...base, cipher: 'aes256-ctr' }))).toMatch(/passphrase/);
    expect(reason(encodeOpenSshKey({ ...base, type: 'ssh-rsa' }))).toMatch(
      /`ssh-rsa` key.*Ed25519 only/,
    );
    expect(reason('-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----')).toMatch(
      /PEM private key/,
    );
    expect(reason(encodeOpenSshKey({ ...base, count: 2 }))).toMatch(/holds 2 keys/);
    expect(reason(encodeOpenSshKey({ ...base, checks: [1, 2] }))).toMatch(/check integers differ/);
    expect(reason(encodeOpenSshKey({ ...base, embeddedPublic: Buffer.alloc(32, 9) }))).toMatch(
      /not the one its private seed derives/,
    );
    expect(reason('not a key')).toMatch(/not an OpenSSH private key/);
  });

  it('refuses a declared public key that is not the private key’s, and one that is not Ed25519', () => {
    expect(deployKeyPairFault(vectorKey, vectorPublicLine)).toBeNull();
    const other = sshEd25519PublicKeyLine(Buffer.alloc(32, 1));
    expect(deployKeyPairFault(vectorKey, other)).toMatch(/not the private key’s/);
    expect(deployKeyPairFault(vectorKey, 'ssh-rsa AAAAB3NzaC1yc2E')).toMatch(/not an `ssh-ed25519/);
    expect(parseSshEd25519PublicKey('ssh-ed25519 !!!')).toBeNull();
  });

  it('never quotes the key in a refusal', () => {
    const encrypted = encodeOpenSshKey({
      seed: RFC8032_TEST1.seed,
      publicKey: RFC8032_TEST1.publicKey,
      cipher: 'aes256-ctr',
    });
    const fault = deployKeyPairFault(encrypted, vectorPublicLine) ?? '';
    const body = openSshPrivateKeyBody(encrypted) ?? '';
    expect(fault).not.toContain(body.slice(0, 24));
    expect(fault).not.toContain(RFC8032_TEST1.seed.toString('hex').slice(0, 16));
  });

  it('finds the base64 body without line breaks', () => {
    const body = openSshPrivateKeyBody(vectorKey);
    expect(body).not.toBeNull();
    expect(body).not.toMatch(/\s/);
    expect(vectorKey.replace(/\s/g, '')).toContain(body as string);
  });
});

/**
 * The workspace side of `cred.get` — the helper the agent's own `git` invokes.
 *
 * Its input is written by a process the agent controls, so every case below is "what happens when
 * the caller is not the caller we imagined" (BD-022). The round-trip tests run against the **real**
 * shim, because the refusals that matter are the shim's and a stub would be free to be kinder.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { manualClock } from '../runner/clock.js';
import {
  credentialHost,
  parseCredentialRequest,
  requestCredential,
  runCredentialHelper,
} from './credential-helper.js';
import { createRunletShim, type RunletShim } from './shim.js';
import {
  type ControlVolume,
  connectProbe,
  createControlVolume,
  nodeScript,
  type RunletProbe,
} from './testing.js';

const TOKEN = 'run-token-eeeeeeeeeeeeeeeeeeeeee';

const open: { shim: RunletShim; volume: ControlVolume }[] = [];
afterEach(async () => {
  for (const entry of open.splice(0)) {
    await entry.shim.close();
    await entry.volume.cleanup();
  }
});

const startRun = async (): Promise<{ volume: ControlVolume; runner: RunletProbe }> => {
  const volume = await createControlVolume();
  const shim = createRunletShim({
    controlSocketPath: volume.controlSocketPath,
    credentialSocketPath: volume.credentialSocketPath,
    token: TOKEN,
    clock: manualClock(1_000),
  });
  await shim.start();
  open.push({ shim, volume });
  const runner = await connectProbe(volume.controlSocketPath);
  runner.send({ type: 'hello', protocol: 1, token: TOKEN });
  await runner.next('hello.ok');
  runner.send({
    type: 'spawn',
    ...nodeScript('setInterval(() => {}, 1000)'),
    cwd: process.cwd(),
    env: {},
  });
  await runner.next('spawn.ok');
  return { volume, runner };
};

describe('parsing what git writes', () => {
  it('reads the key=value block and ignores everything else', () => {
    expect(
      parseCredentialRequest('protocol=https\nhost=gitlab.example.com\npath=a/b.git\n\n'),
    ).toEqual({ protocol: 'https', host: 'gitlab.example.com', path: 'a/b.git' });
  });

  it('survives a line with no separator, an empty key and a stray carriage return', () => {
    expect(parseCredentialRequest('garbage\n=value\nhost=a.example\r\n')).toEqual({
      host: 'a.example',
    });
  });

  it('takes the last value, as git itself does', () => {
    expect(parseCredentialRequest('host=first.example\nhost=second.example')['host']).toBe(
      'second.example',
    );
  });
});

describe('which requests this helper will answer at all', () => {
  it('lowercases the host so one host has one spelling on the allow-list', () => {
    expect(credentialHost({ protocol: 'https', host: 'GitLab.Example.COM' })).toBe(
      'gitlab.example.com',
    );
  });

  it.each([
    ['cleartext', { protocol: 'http', host: 'example.com' }],
    ['no protocol at all', { host: 'example.com' }],
    ['ssh', { protocol: 'ssh', host: 'example.com' }],
    ['a host with a port', { protocol: 'https', host: 'example.com:8443' }],
    ['a host with userinfo', { protocol: 'https', host: 'user@example.com' }],
    ['no host', { protocol: 'https' }],
    ['a wildcard', { protocol: 'https', host: '*.example.com' }],
  ])('refuses %s', (_name, fields) => {
    expect(credentialHost(fields as Record<string, string>)).toBeNull();
  });
});

describe('the helper end to end, against the real shim', () => {
  it('prints the two lines git expects when the runner answers', async () => {
    const { volume, runner } = await startRun();
    const answer = runCredentialHelper({
      argv: ['get'],
      stdin: 'protocol=https\nhost=GitLab.Example.com\n\n',
      socketPath: volume.credentialSocketPath,
    });
    const asked = (await runner.next('cred.get')) as { request_id: string; host: string };
    expect(asked.host).toBe('gitlab.example.com');
    runner.send({
      type: 'cred.reply',
      request_id: asked.request_id,
      credential: { username: 'agentic', password: 'glpat-FAKE-0000000000000000' },
    });
    expect(await answer).toBe('username=agentic\npassword=glpat-FAKE-0000000000000000\n');
  });

  it('prints nothing when the runner refuses', async () => {
    const { volume, runner } = await startRun();
    const answer = runCredentialHelper({
      argv: ['get'],
      stdin: 'protocol=https\nhost=evil.example\n',
      socketPath: volume.credentialSocketPath,
    });
    const asked = (await runner.next('cred.get')) as { request_id: string };
    runner.send({ type: 'cred.reply', request_id: asked.request_id, credential: null });
    expect(await answer).toBe('');
  });

  it('asks nothing at all for store, erase or a cleartext get', async () => {
    const { volume, runner } = await startRun();
    expect(
      await runCredentialHelper({
        argv: ['store'],
        stdin: 'protocol=https\nhost=gitlab.example.com\npassword=leaked\n',
        socketPath: volume.credentialSocketPath,
      }),
    ).toBe('');
    expect(
      await runCredentialHelper({
        argv: ['erase'],
        stdin: 'protocol=https\nhost=gitlab.example.com\n',
        socketPath: volume.credentialSocketPath,
      }),
    ).toBe('');
    expect(
      await runCredentialHelper({
        argv: ['get'],
        stdin: 'protocol=http\nhost=gitlab.example.com\n',
        socketPath: volume.credentialSocketPath,
      }),
    ).toBe('');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runner.received.filter((decoded) => decoded.frame.type === 'cred.get')).toHaveLength(0);
  });

  it('answers nothing when the socket is not there', async () => {
    expect(
      await requestCredential({ socketPath: '/nowhere/cred.sock', host: 'example.com' }),
    ).toBeNull();
  });

  it('gives up on the injected clock rather than leaving git hanging', async () => {
    const { volume } = await startRun();
    const clock = manualClock(1_000);
    const answer = requestCredential({
      socketPath: volume.credentialSocketPath,
      host: 'example.com',
      timeoutMs: 5_000,
      clock,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    clock.advance(5_001);
    expect(await answer).toBeNull();
  });

  it('refuses a host the wire could not carry before opening a socket', async () => {
    expect(
      await requestCredential({ socketPath: '/nowhere/cred.sock', host: 'not a host' }),
    ).toBeNull();
  });
});

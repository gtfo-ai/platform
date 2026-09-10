import { describe, expect, it } from 'vitest';
import { readRunletConfig } from './config.js';
import { RunletTokenError } from './token.js';

const TOKEN = 'run-token-dddddddddddddddddddddd';
const base = { RUNLET_CONTROL_SOCKET: '/ctl/ctl.sock', RUNLET_TOKEN: TOKEN };

describe('the run shim configuration', () => {
  it('reads the sockets, the token and the defaults', () => {
    const config = readRunletConfig({ ...base, RUNLET_CREDENTIAL_SOCKET: '/ctl/cred.sock' });
    expect(config).toMatchObject({
      controlSocketPath: '/ctl/ctl.sock',
      credentialSocketPath: '/ctl/cred.sock',
      token: TOKEN,
      childUid: null,
      logLevel: 'info',
    });
  });

  it('has no credential socket unless one is configured', () => {
    expect(readRunletConfig(base).credentialSocketPath).toBeNull();
  });

  it('prefers the _FILE variant and trims the trailing newline (TD-020)', () => {
    const config = readRunletConfig(
      { ...base, RUNLET_TOKEN: 'ignored-000000000000000000', RUNLET_TOKEN_FILE: '/ctl/token' },
      (path) => {
        expect(path).toBe('/ctl/token');
        return `${TOKEN}\n`;
      },
    );
    expect(config.token).toBe(TOKEN);
  });

  it.each([
    ['no token at all', {}],
    ['an empty token', { RUNLET_TOKEN: '' }],
    ['a blank token', { RUNLET_TOKEN: '    ' }],
    ['a token file holding only a newline', { RUNLET_TOKEN_FILE: '/ctl/token' }],
  ])('refuses to start with %s', (_name, over) => {
    expect(() =>
      readRunletConfig({ RUNLET_CONTROL_SOCKET: '/ctl/ctl.sock', ...over }, () => '\n'),
    ).toThrow(RunletTokenError);
  });

  it('refuses a control socket that is not set', () => {
    expect(() => readRunletConfig({ RUNLET_TOKEN: TOKEN })).toThrow();
  });

  it('reads the numeric knobs and refuses nonsense rather than defaulting', () => {
    expect(
      readRunletConfig({ ...base, RUNLET_KILL_GRACE_MS: '5000', RUNLET_CHILD_UID: '1000' }),
    ).toMatchObject({ killGraceMs: 5000, childUid: 1000 });
    expect(() => readRunletConfig({ ...base, RUNLET_KILL_GRACE_MS: 'soon' })).toThrow();
    expect(() => readRunletConfig({ ...base, RUNLET_KILL_GRACE_MS: '0' })).toThrow();
    expect(() => readRunletConfig({ ...base, RUNLET_CHILD_UID: '-1' })).toThrow();
    expect(() => readRunletConfig({ ...base, RUNLET_LOG_LEVEL: 'chatty' })).toThrow();
  });
});
